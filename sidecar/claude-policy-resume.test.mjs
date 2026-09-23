import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildResumeOptions, ALLOWED_EFFORT } from "./protocol-helpers.mjs";

// Execute the real request handler without launching a provider process. The
// runtime methods are the I/O seam; query options and request sequencing are real.
const source = readFileSync(new URL("./claude-sdk-bridge.mjs", import.meta.url), "utf8");
const handler = source.slice(source.indexOf("async function handleRequest("), source.indexOf("// --- stdin Reader ---"));
function harness(rejectSetter = false) {
  const calls = { options: [], errors: [], messages: [] };
  const context = {
    runtime: {
      setModel: async () => { if (rejectSetter) throw new Error("model rejected"); },
      applyFlagSettings: async () => { if (rejectSetter) throw new Error("effort rejected"); },
    },
    lastQueryOptions: { model: "model-a", effort: "high", sessionId: "initial", cwd: "/project" },
    lastSessionId: "native-session", streamEnded: false, promptTerminated: false,
    promptResolve: null, ALLOWED_EFFORT,
    log() {}, emit() {}, respond() {},
    respondError: (_id, message) => calls.errors.push(message),
    buildResumeOptions: id => buildResumeOptions(id, context.lastQueryOptions),
    promptGenerator: async function* () {},
    consumeStream: async () => {},
    query: ({ options }) => {
      calls.options.push(options);
      context.promptResolve = message => calls.messages.push(message);
      return {};
    },
  };
  vm.createContext(context);
  vm.runInContext(handler, context);
  const request = (method, params) => context.handleRequest({ id: 1, method, params });
  return { context, calls, request };
}

test("acknowledged model/effort survive stream-end query recreation", async () => {
  const { context, calls, request } = harness();
  await request("setModel", { model: "model-b" });
  await request("setEffort", { effort: "low" });
  context.streamEnded = true;
  await request("sendMessage", { text: "continue" });
  assert.deepEqual(calls.errors, []);
  assert.equal(calls.options.length, 1);
  assert.deepEqual(calls.options[0], { model: "model-b", effort: "low", cwd: "/project", resume: "native-session" });
  assert.equal(calls.messages.length, 1);
});

test("rejected setters never change the options used on resume", async () => {
  const { context, calls, request } = harness(true);
  await request("setModel", { model: "model-b" });
  await request("setEffort", { effort: "low" });
  assert.deepEqual(calls.errors, ["model rejected", "effort rejected"]);
  context.streamEnded = true;
  await request("sendMessage", { text: "continue" });
  assert.equal(calls.options[0].model, "model-a");
  assert.equal(calls.options[0].effort, "high");
});
