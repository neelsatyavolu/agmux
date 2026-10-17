import { test } from "node:test";
import assert from "node:assert/strict";
import { callerParams, createAgmuxSessions, toView } from "./agmux-consult-sessions.mjs";

const ROWS = [
  {
    session_id: "11111111-aaaa",
    agent: "claude",
    surface: "terminal",
    title: "Fix login",
    cwd: "/repo",
    status: "working",
    last_active: "2026-10-16T12:00:00Z",
    fork: { agent: "claude", session_id: "native-claude-1", cwd: "/repo" },
  },
  {
    session_id: "22222222-bbbb",
    agent: "cursor",
    surface: "chat",
    title: "Docs",
    status: "idle",
    last_active: "2026-10-16T11:00:00Z",
  },
];

function fakeRequest(calls, result = { sessions: ROWS }) {
  return async (method, params, options) => {
    calls.push({ method, params, options });
    if (method === "sessions.send") return { agent: "cursor", sessionId: params.to, status: "idle" };
    return result;
  };
}

test("callerParams carries the thread id when there is one, the parent pid always", () => {
  assert.deepEqual(callerParams({ AGMUX_THREAD_ID: "t-1", AGMUX_PROJECT_ID: "p-1" }, 42, "/repo"), {
    callerThreadId: "t-1",
    projectId: "p-1",
    callerPid: 42,
    cwd: "/repo",
  });
  assert.deepEqual(callerParams({}, 7, "/x"), { callerPid: 7, cwd: "/x" });
});

test("toView hides fork details behind can_ask", () => {
  const view = toView(ROWS[0]);
  assert.equal(view.can_ask, true);
  assert.equal("fork" in view, false);
  assert.equal(toView(ROWS[1]).can_ask, false);
});

test("list asks the app with the caller's identity", async () => {
  const calls = [];
  const sessions = createAgmuxSessions({ request: fakeRequest(calls), caller: { callerPid: 1, cwd: "/repo" }, askFork: null });
  const list = await sessions.list();
  assert.equal(list.length, 2);
  assert.equal(calls[0].method, "sessions.list");
  assert.deepEqual(calls[0].params, { callerPid: 1, cwd: "/repo" });
});

test("ask forks the provider session, reporting the agmux id as the source", async () => {
  const forks = [];
  const sessions = createAgmuxSessions({
    request: fakeRequest([]),
    caller: {},
    askFork: async (target, question) => {
      forks.push({ target, question });
      return { agent: "claude", answer: "it was the cache", sessionId: "fork-1", durationMs: 5 };
    },
  });
  const result = await sessions.ask("11111111-aaaa", "why?", undefined);
  assert.deepEqual(forks[0].target, { agent: "claude", sessionId: "native-claude-1", cwd: "/repo" });
  assert.equal(result.source, "11111111-aaaa");
  assert.equal(result.cwd, "/repo");
  assert.equal(result.answer, "it was the cache");
});

test("ask explains when a session can't be copied or doesn't exist", async () => {
  const sessions = createAgmuxSessions({ request: fakeRequest([]), caller: {}, askFork: async () => assert.fail("no fork") });
  await assert.rejects(sessions.ask("22222222-bbbb", "q"), /only copy Claude, Codex and Grok sessions.*send_message/);
  await assert.rejects(sessions.ask("missing", "q"), /no session missing in this project/);
});

test("send passes the message to the app with the caller", async () => {
  const calls = [];
  const sessions = createAgmuxSessions({ request: fakeRequest(calls), caller: { callerThreadId: "t-1" }, askFork: null });
  const sent = await sessions.send("22222222-bbbb", "I moved main");
  assert.equal(sent.status, "idle");
  assert.deepEqual(calls[0].params, { callerThreadId: "t-1", to: "22222222-bbbb", text: "I moved main" });
});

test("send turns app errors into advisor errors", async () => {
  const sessions = createAgmuxSessions({
    request: async () => {
      throw new Error("you have sent session x 10 messages in the last hour");
    },
    caller: {},
    askFork: null,
  });
  await assert.rejects(sessions.send("x", "hi"), (err) => err.name === "AdvisorError" && /10 messages/.test(err.message));
});

test("assertNotLive refuses to resume a running session in place", async () => {
  const sessions = createAgmuxSessions({ request: fakeRequest([]), caller: {}, askFork: null });
  await assert.rejects(sessions.assertNotLive("native-claude-1"), /live agmux session; use ask_session/);
  await sessions.assertNotLive("some-old-advisor-session");
});

test("assertNotLive lets calls through when the app is unreachable", async () => {
  const sessions = createAgmuxSessions({
    request: async () => {
      throw new Error("room RPC unavailable");
    },
    caller: {},
    askFork: null,
  });
  await sessions.assertNotLive("anything");
});
