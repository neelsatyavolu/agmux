import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { conversationOnlyCodex, conversationOnlyGrok, createTeamSessions, parseAnswerRequest, registerTeamSessionTools, runTeamAnswer, teamSocketPath } from "./agmux-consult-team.mjs";

test("team tools exist only when the app passes a socket", () => {
  assert.equal(teamSocketPath({}), null);
  assert.equal(teamSocketPath({ AGTERM_TEAM_SOCK: "  " }), null);
  assert.equal(teamSocketPath({ AGTERM_TEAM_SOCK: "/tmp/team.sock" }), "/tmp/team.sock");
});

test("calls go to the app's socket with the methods it serves", async () => {
  const calls = [];
  const request = async (method, params, options) => {
    calls.push({ method, params, socketPath: options.socketPath });
    return method === "team.list" ? { sessions: [{ session_id: "ts-1" }] } : { member: "alice", agent: "claude", answer: "yes" };
  };
  const team = createTeamSessions({ request, socketPath: "/s" });
  assert.deepEqual(await team.list(), [{ session_id: "ts-1" }]);
  await team.ask("ts-1", "why?", "low");
  await team.ask("ts-1", "why?");
  await team.send("ts-1", "moved main");
  assert.deepEqual(calls, [
    { method: "team.list", params: {}, socketPath: "/s" },
    { method: "team.ask", params: { session_id: "ts-1", question: "why?", effort: "low" }, socketPath: "/s" },
    { method: "team.ask", params: { session_id: "ts-1", question: "why?" }, socketPath: "/s" },
    { method: "team.send", params: { session_id: "ts-1", message: "moved main" }, socketPath: "/s" },
  ]);
});

test("the tools report the app's errors instead of throwing", async () => {
  const tools = new Map();
  const server = { registerTool: (name, _def, handler) => tools.set(name, handler) };
  const failing = { list: async () => { throw new Error("Turn on team sessions first"); }, ask: async () => ({}), send: async () => ({}) };
  registerTeamSessionTools(server, failing, { withProgress: (_e, _i, _l, work) => work, progressIntervalMs: 1000 });
  assert.deepEqual([...tools.keys()], ["list_team_sessions", "ask_team_session", "message_team_session"]);
  const listed = await tools.get("list_team_sessions")({});
  assert.equal(listed.isError, true);
  assert.match(listed.content[0].text, /Turn on team sessions/);
});

test("an answer names the teammate and agent but no local path", async () => {
  const tools = new Map();
  const server = { registerTool: (name, _def, handler) => tools.set(name, handler) };
  const team = { list: async () => [], send: async () => ({}), ask: async () => ({ answer: "It's in db.ts", member: "alice", agent: "claude", durationMs: 4200 }) };
  registerTeamSessionTools(server, team, { withProgress: (_e, _i, _l, work) => work, progressIntervalMs: 1000 });
  const result = await tools.get("ask_team_session")({ session_id: "ts-00000000000000000000", question: "where?" }, {});
  assert.equal(result.content[0].text, "It's in db.ts\n\n---\nmember: alice · agent: claude · 4.2s");
});

test("the answer mode checks its request", () => {
  assert.throws(() => parseAnswerRequest("nope"), /JSON/);
  assert.throws(() => parseAnswerRequest(JSON.stringify({ agent: "claude", sessionId: "../a", cwd: "/x", question: "q" })), /sessionId/);
  assert.throws(() => parseAnswerRequest(JSON.stringify({ agent: "claude", sessionId: "a", cwd: "x", question: "q" })), /cwd/);
  assert.throws(() => parseAnswerRequest(JSON.stringify({ agent: "cursor", sessionId: "a", cwd: "/x", question: "q" })), /agent/);
  assert.equal(parseAnswerRequest(JSON.stringify({ agent: "grok", sessionId: "a", cwd: "/x", question: "q" })).target.agent, "grok");
  assert.deepEqual(parseAnswerRequest(JSON.stringify({ agent: "claude", sessionId: "a-1", cwd: "/x", question: "q", effort: "huge" })),
    { target: { agent: "claude", sessionId: "a-1", cwd: "/x" }, question: "q", effort: undefined });
});

test("the answer mode prints only the answer, agent, model and duration", async () => {
  let out = "";
  const stdout = new Writable({ write(chunk, _enc, done) { out += chunk; done(); } });
  const stdin = Readable.from([JSON.stringify({ agent: "claude", sessionId: "abc", cwd: "/repo", question: "q", effort: "low" })]);
  let seen;
  const askSession = async (target, question, effort) => {
    seen = { target, question, effort };
    return { answer: "42", agent: "claude", model: "opus", durationMs: 10, sessionId: "fork-id", cwd: "/repo" };
  };
  await runTeamAnswer({ askSession, stdin, stdout });
  assert.deepEqual(seen, { target: { agent: "claude", sessionId: "abc", cwd: "/repo" }, question: "q", effort: "low" });
  assert.deepEqual(JSON.parse(out), { answer: "42", agent: "claude", model: "opus", durationMs: 10 });
});

test("a teammate's Codex or Grok copy gets no tools, so it answers from the conversation alone", async () => {
  const { codex } = await import("consult-mcp/dist/adapters/codex.js");
  const { grok } = await import("consult-mcp/dist/adapters/grok.js");
  const request = { agent: "codex", question: "q", cwd: "/repo" };
  const c = conversationOnlyCodex(codex).fork("SRC", request, "PROMPT", ["-c", "mcp_servers.x.enabled=false"]);
  for (const feature of ["shell_tool", "unified_exec", "code_mode_host", "view_image"]) {
    assert.equal(c.args[c.args.indexOf(feature) - 1], "--disable", feature);
  }
  assert.ok(c.args.includes('sandbox_mode="read-only"'));
  assert.deepEqual(c.args.slice(-2), ["SRC", "PROMPT"]);
  const g = conversationOnlyGrok(grok).fork("SRC", { ...request, agent: "grok" }, "PROMPT");
  // Only todo_write: an empty --tools would mean every built-in.
  assert.equal(g.args[g.args.indexOf("--tools") + 1], "todo_write");
  assert.ok(g.args.includes("--disable-web-search") && g.args.includes("--no-subagents"));
  assert.ok(g.args.includes("Agent,search_tool,use_tool"));
});
