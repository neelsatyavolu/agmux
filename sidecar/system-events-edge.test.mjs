import test from "node:test";
import assert from "node:assert/strict";

import { systemMessageToEvents } from "./system-events.mjs";

test("hook lifecycle preserves native identities for concurrent hooks with the same name", () => {
  const event = (subtype, hook_id) => systemMessageToEvents({
    type: "system", subtype, hook_id, hook_name: "check", hook_event: "Stop",
  })[0];
  assert.equal(event("hook_started", "first").hookId, "first");
  assert.equal(event("hook_started", "second").hookId, "second");
  assert.equal(event("hook_response", "first").hookId, "first");
  assert.equal(event("hook_response", "second").hookId, "second");
  for (const invalid of [undefined, null, "", 42]) {
    assert.equal(Object.hasOwn(event("hook_started", invalid), "hookId"), false);
    assert.equal(Object.hasOwn(event("hook_response", invalid), "hookId"), false);
  }
});

// --- Malformed / non-system input ---

test("systemMessageToEvents: returns [] for non-system message types", () => {
  assert.deepEqual(systemMessageToEvents({ type: "assistant" }), []);
  assert.deepEqual(systemMessageToEvents({ type: "user" }), []);
  assert.deepEqual(systemMessageToEvents({}), []);
});

test("systemMessageToEvents: tolerates null/undefined input", () => {
  assert.deepEqual(systemMessageToEvents(null), []);
  assert.deepEqual(systemMessageToEvents(undefined), []);
});

// --- init ---

test("systemMessageToEvents: init with no slash_commands defaults to []", () => {
  const out = systemMessageToEvents({
    type: "system",
    subtype: "init",
    session_id: "sess-1",
  });
  assert.deepEqual(out, [
    { event: "session.init", sessionId: "sess-1", slashCommands: [] },
  ]);
});

test("systemMessageToEvents: init carries slash_commands list", () => {
  const out = systemMessageToEvents({
    type: "system",
    subtype: "init",
    session_id: "sess-2",
    slash_commands: ["/help", "/clear"],
  });
  assert.deepEqual(out, [
    {
      event: "session.init",
      sessionId: "sess-2",
      slashCommands: ["/help", "/clear"],
    },
  ]);
});

test("systemMessageToEvents: init with no session_id uses null", () => {
  const out = systemMessageToEvents({ type: "system", subtype: "init" });
  assert.equal(out[0].sessionId, null);
});

// --- compact_boundary ---

test("systemMessageToEvents: compact_boundary extracts metadata", () => {
  assert.deepEqual(
    systemMessageToEvents({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { pre_tokens: 50000, trigger: "auto" },
    }),
    [{ event: "compact.boundary", preTokens: 50000, trigger: "auto" }],
  );
});

test("systemMessageToEvents: compact_boundary with missing metadata returns nulls", () => {
  assert.deepEqual(
    systemMessageToEvents({ type: "system", subtype: "compact_boundary" }),
    [{ event: "compact.boundary", preTokens: null, trigger: null }],
  );
});

// --- hook events ---

test("systemMessageToEvents: hook_started uses 'unknown' fallback for hook_name", () => {
  const [ev] = systemMessageToEvents({
    type: "system",
    subtype: "hook_started",
  });
  assert.equal(ev.event, "hook.started");
  assert.equal(ev.hookName, "unknown");
  assert.equal(ev.hookEvent, "");
});

test("systemMessageToEvents: hook_response carries outcome and exit_code", () => {
  const [ev] = systemMessageToEvents({
    type: "system",
    subtype: "hook_response",
    hook_name: "PreToolUse",
    hook_event: "tool_use",
    outcome: "block",
    exit_code: 2,
  });
  assert.deepEqual(ev, {
    event: "hook.response",
    hookName: "PreToolUse",
    hookEvent: "tool_use",
    outcome: "block",
    exitCode: 2,
  });
});

// --- task_started ---

test("systemMessageToEvents: task_started prefers task_description over body", () => {
  const [ev] = systemMessageToEvents({
    type: "system",
    subtype: "task_started",
    task_id: "t-1",
    task_description: "Run tests",
    body: "ignored",
  });
  assert.deepEqual(ev, {
    event: "task.started",
    taskId: "t-1",
    description: "Run tests",
  });
});

test("systemMessageToEvents: task_started falls back to body when description missing", () => {
  const [ev] = systemMessageToEvents({
    type: "system",
    subtype: "task_started",
    body: "from body",
  });
  assert.equal(ev.description, "from body");
});

// --- task_progress edge cases ---

test("systemMessageToEvents: task_progress without usage yields null usage", () => {
  const [ev] = systemMessageToEvents({
    type: "system",
    subtype: "task_progress",
    task_id: "t-x",
    status: "going",
  });
  assert.equal(ev.usage, null);
});

// --- status fallback: prefer status_message, then body ---

test("systemMessageToEvents: status prefers status_message over body", () => {
  const [ev] = systemMessageToEvents({
    type: "system",
    subtype: "status",
    status_message: "from status_message",
    body: "from body",
  });
  assert.equal(ev.message, "from status_message");
});

test("systemMessageToEvents: status with no message text yields empty string", () => {
  const [ev] = systemMessageToEvents({ type: "system", subtype: "status" });
  assert.equal(ev.message, "");
});

// --- local_command_output ---

test("systemMessageToEvents: local_command_output uses output then body fallback", () => {
  const [ev] = systemMessageToEvents({
    type: "system",
    subtype: "local_command_output",
    command: "ls",
    output: "hello",
  });
  assert.deepEqual(ev, {
    event: "command.output",
    command: "ls",
    output: "hello",
  });
  const [ev2] = systemMessageToEvents({
    type: "system",
    subtype: "local_command_output",
    command: "ls",
    body: "from body",
  });
  assert.equal(ev2.output, "from body");
});

// --- files_persisted ---

test("systemMessageToEvents: files_persisted maps filename + file_id", () => {
  const [ev] = systemMessageToEvents({
    type: "system",
    subtype: "files_persisted",
    files: [
      { filename: "a.txt", file_id: "id-a" },
      { filename: "b.png", file_id: "id-b" },
    ],
    failed: [{ filename: "c.txt", error: "denied" }],
    uuid: "u-1",
    session_id: "s-1",
  });
  assert.deepEqual(ev, {
    event: "files.persisted",
    files: [
      { filename: "a.txt", fileId: "id-a" },
      { filename: "b.png", fileId: "id-b" },
    ],
    failed: [{ filename: "c.txt", error: "denied" }],
    uuid: "u-1",
    sessionId: "s-1",
  });
});

test("systemMessageToEvents: files_persisted defaults when files/failed missing or non-array", () => {
  const [ev] = systemMessageToEvents({
    type: "system",
    subtype: "files_persisted",
  });
  assert.deepEqual(ev.files, []);
  assert.deepEqual(ev.failed, []);
  assert.equal(ev.uuid, null);
  assert.equal(ev.sessionId, null);

  const [ev2] = systemMessageToEvents({
    type: "system",
    subtype: "files_persisted",
    files: "not-an-array",
    failed: null,
  });
  assert.deepEqual(ev2.files, []);
  assert.deepEqual(ev2.failed, []);
});

test("systemMessageToEvents: files_persisted filters falsy entries", () => {
  const [ev] = systemMessageToEvents({
    type: "system",
    subtype: "files_persisted",
    files: [null, undefined, { filename: "a.txt", file_id: "id-a" }],
    failed: [null, { filename: "b.txt", error: "x" }],
  });
  assert.equal(ev.files.length, 1);
  assert.equal(ev.failed.length, 1);
});

// --- task_notification fallbacks ---

test("systemMessageToEvents: task_notification with empty payload uses defaults", () => {
  const [ev] = systemMessageToEvents({
    type: "system",
    subtype: "task_notification",
  });
  assert.equal(ev.title, "Notification");
  assert.equal(ev.body, "");
  assert.equal(ev.taskId, null);
});
