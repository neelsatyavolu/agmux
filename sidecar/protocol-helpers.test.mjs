import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyTool,
  summarizeToolInput,
  buildResumeOptions,
  ALLOWED_EFFORT,
  isAllowedEffort,
  LARGE_CONTENT_KEYS,
} from "./protocol-helpers.mjs";

// --- classifyTool ---

test("classifyTool: bash and execute_command are command_execution", () => {
  assert.equal(classifyTool("Bash"), "command_execution");
  assert.equal(classifyTool("bash"), "command_execution");
  assert.equal(classifyTool("execute_command"), "command_execution");
  assert.equal(classifyTool("EXECUTE_COMMAND"), "command_execution");
});

test("classifyTool: write/edit family is file_change", () => {
  for (const name of [
    "Edit",
    "Write",
    "ApplyPatch",
    "NotebookEdit",
    "MultiEdit",
    "edit",
  ]) {
    assert.equal(classifyTool(name), "file_change", `expected ${name}`);
  }
});

test("classifyTool: read/glob/grep/view is file_read", () => {
  for (const name of ["Read", "Glob", "Grep", "View", "read"]) {
    assert.equal(classifyTool(name), "file_read", `expected ${name}`);
  }
});

test("classifyTool: unknown tool is dynamic_tool_call", () => {
  assert.equal(classifyTool("WebSearch"), "dynamic_tool_call");
  assert.equal(classifyTool("Task"), "dynamic_tool_call");
  assert.equal(classifyTool(""), "dynamic_tool_call");
});

test("classifyTool: tolerates null/undefined input", () => {
  assert.equal(classifyTool(undefined), "dynamic_tool_call");
  assert.equal(classifyTool(null), "dynamic_tool_call");
});

// --- summarizeToolInput ---

test("summarizeToolInput: returns valid JSON for primitive inputs", () => {
  assert.equal(summarizeToolInput(null), "{}");
  assert.equal(summarizeToolInput(undefined), "{}");
  assert.equal(summarizeToolInput(42), "42");
  assert.equal(summarizeToolInput("hello"), '"hello"');
});

test("summarizeToolInput: short strings are passed through", () => {
  const out = summarizeToolInput({ command: "ls -la" });
  assert.equal(out, JSON.stringify({ command: "ls -la" }));
});

test("summarizeToolInput: large content keys are truncated with preview + length", () => {
  const big = "x".repeat(500);
  const out = JSON.parse(summarizeToolInput({ content: big }));
  assert.match(out.content, /\(500 chars\)/);
  assert.ok(out.content.startsWith("x".repeat(80)));
});

test("summarizeToolInput: newlines in large preview are escaped to \\n", () => {
  const big = "line1\nline2\n" + "y".repeat(200);
  const out = JSON.parse(summarizeToolInput({ new_string: big }));
  // The first 80 chars include the literal newline, which must be escaped
  // so the JSON inside the preview stays human-readable.
  assert.ok(out.new_string.includes("\\n"));
  assert.match(out.new_string, /\(\d+ chars\)/);
});

test("summarizeToolInput: non-content strings over 300 chars get plain truncation", () => {
  const big = "z".repeat(500);
  const parsed = JSON.parse(summarizeToolInput({ description: big }));
  assert.equal(parsed.description.length, 301); // 300 + ellipsis
  assert.ok(parsed.description.endsWith("…"));
});

test("summarizeToolInput: small large-key values are NOT truncated", () => {
  const small = "short content";
  const parsed = JSON.parse(summarizeToolInput({ content: small }));
  assert.equal(parsed.content, small);
});

test("summarizeToolInput: non-string fields are passed through unchanged", () => {
  const parsed = JSON.parse(
    summarizeToolInput({ count: 42, flag: true, items: [1, 2, 3] }),
  );
  assert.equal(parsed.count, 42);
  assert.equal(parsed.flag, true);
  assert.deepEqual(parsed.items, [1, 2, 3]);
});

test("summarizeToolInput: result is always parseable JSON for nested objects", () => {
  const out = summarizeToolInput({
    nested: { deep: { value: "x".repeat(1000) } },
    big_text: "y".repeat(1000),
  });
  // Should not throw — frontend depends on this guarantee.
  const parsed = JSON.parse(out);
  assert.ok(parsed.nested);
  assert.ok(parsed.big_text);
});

// --- buildResumeOptions ---

test("buildResumeOptions: with no prior options returns just resume", () => {
  assert.deepEqual(buildResumeOptions("sess-1", null), { resume: "sess-1" });
  assert.deepEqual(buildResumeOptions("sess-1", undefined), {
    resume: "sess-1",
  });
});

test("buildResumeOptions: strips sessionId from prior options", () => {
  const prior = {
    cwd: "/tmp",
    model: "claude-sonnet-4-5",
    sessionId: "old-session",
    allowedTools: ["Read"],
  };
  const out = buildResumeOptions("new-session", prior);
  assert.equal(out.resume, "new-session");
  assert.equal(out.sessionId, undefined);
  assert.equal(out.cwd, "/tmp");
  assert.equal(out.model, "claude-sonnet-4-5");
  assert.deepEqual(out.allowedTools, ["Read"]);
});

test("buildResumeOptions: does not mutate the input object", () => {
  const prior = { sessionId: "old", model: "m" };
  buildResumeOptions("new", prior);
  assert.equal(prior.sessionId, "old");
  assert.equal(prior.model, "m");
});

test("buildResumeOptions: preserves canUseTool function reference", () => {
  const fn = () => ({ behavior: "allow" });
  const out = buildResumeOptions("s", { canUseTool: fn, sessionId: "x" });
  assert.equal(out.canUseTool, fn);
});

// --- ALLOWED_EFFORT ---

test("ALLOWED_EFFORT: contains exactly the SDK-supported levels", () => {
  assert.deepEqual(
    [...ALLOWED_EFFORT].sort(),
    ["high", "low", "max", "medium", "xhigh"],
  );
});

test("isAllowedEffort: accepts the documented values", () => {
  for (const v of ["low", "medium", "high", "xhigh", "max"]) {
    assert.equal(isAllowedEffort(v), true);
  }
});

test("isAllowedEffort: rejects unknown values", () => {
  assert.equal(isAllowedEffort("ultra"), false);
  assert.equal(isAllowedEffort(""), false);
  assert.equal(isAllowedEffort(undefined), false);
  assert.equal(isAllowedEffort("HIGH"), false);
});

// --- LARGE_CONTENT_KEYS ---

test("LARGE_CONTENT_KEYS: covers known content fields", () => {
  for (const key of [
    "content",
    "new_string",
    "old_string",
    "code",
    "notebook_content",
  ]) {
    assert.ok(LARGE_CONTENT_KEYS.has(key), `missing ${key}`);
  }
});
