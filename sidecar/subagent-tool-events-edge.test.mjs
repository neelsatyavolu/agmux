import test from "node:test";
import assert from "node:assert/strict";

import { extractToolEventsFromBlocks } from "./subagent-tool-events.mjs";

function freshState() {
  return {
    seenToolIds: new Set(),
    pendingToolIds: new Map(),
    activeAgentToolIds: new Set(),
  };
}

test("returns [] for empty block list", () => {
  const state = freshState();
  const events = extractToolEventsFromBlocks({
    blocks: [],
    parentToolUseId: null,
    ...state,
  });
  assert.deepEqual(events, []);
  assert.equal(state.seenToolIds.size, 0);
});

test("ignores blocks with unrecognized type", () => {
  const state = freshState();
  const events = extractToolEventsFromBlocks({
    blocks: [
      { type: "text", text: "hi" },
      { type: "thinking", thinking: "..." },
    ],
    parentToolUseId: null,
    ...state,
  });
  assert.deepEqual(events, []);
});

test("server_tool_use is treated as tool_use", () => {
  const state = freshState();
  const events = extractToolEventsFromBlocks({
    blocks: [
      {
        type: "server_tool_use",
        id: "srv-1",
        server_tool_name: "WebSearch",
        input: { query: "anthropic" },
      },
    ],
    parentToolUseId: null,
    ...state,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "tool.started");
  assert.equal(events[0].name, "WebSearch");
  assert.deepEqual(events[0].input, { query: "anthropic" });
});

test("mcp_tool_use is treated as tool_use and uses block.name", () => {
  const state = freshState();
  const events = extractToolEventsFromBlocks({
    blocks: [
      {
        type: "mcp_tool_use",
        id: "mcp-1",
        name: "linear.search",
        input: {},
      },
    ],
    parentToolUseId: null,
    ...state,
  });
  assert.equal(events[0].name, "linear.search");
});

test("tool_use without name or server_tool_name falls back to 'unknown'", () => {
  const state = freshState();
  const events = extractToolEventsFromBlocks({
    blocks: [{ type: "tool_use", id: "t-1", input: {} }],
    parentToolUseId: null,
    ...state,
  });
  assert.equal(events[0].name, "unknown");
});

test("tool_use without input defaults to empty object", () => {
  const state = freshState();
  const events = extractToolEventsFromBlocks({
    blocks: [{ type: "tool_use", id: "t-2", name: "Read" }],
    parentToolUseId: null,
    ...state,
  });
  assert.deepEqual(events[0].input, {});
});

test("agent/task/dispatch_agent tools register in activeAgentToolIds", () => {
  const state = freshState();
  extractToolEventsFromBlocks({
    blocks: [
      { type: "tool_use", id: "a1", name: "Agent", input: {} },
      { type: "tool_use", id: "a2", name: "Task", input: {} },
      { type: "tool_use", id: "a3", name: "dispatch_agent", input: {} },
      { type: "tool_use", id: "a4", name: "Read", input: {} },
    ],
    parentToolUseId: null,
    ...state,
  });
  assert.ok(state.activeAgentToolIds.has("a1"));
  assert.ok(state.activeAgentToolIds.has("a2"));
  assert.ok(state.activeAgentToolIds.has("a3"));
  assert.ok(!state.activeAgentToolIds.has("a4"));
});

test("agent tool name matching is case-insensitive", () => {
  const state = freshState();
  extractToolEventsFromBlocks({
    blocks: [
      { type: "tool_use", id: "a1", name: "AGENT", input: {} },
      { type: "tool_use", id: "a2", name: "task", input: {} },
    ],
    parentToolUseId: null,
    ...state,
  });
  assert.equal(state.activeAgentToolIds.size, 2);
});

test("tool_result for unknown tool_use_id is silently dropped", () => {
  const state = freshState();
  const events = extractToolEventsFromBlocks({
    blocks: [
      {
        type: "tool_result",
        tool_use_id: "never-emitted",
        content: "noop",
        is_error: false,
      },
    ],
    parentToolUseId: null,
    ...state,
  });
  assert.deepEqual(events, []);
});

test("tool_result with array content joins text parts and JSONifies non-text", () => {
  const state = freshState();
  state.seenToolIds.add("t-x");
  state.pendingToolIds.set("t-x", "Read");
  const [ev] = extractToolEventsFromBlocks({
    blocks: [
      {
        type: "tool_result",
        tool_use_id: "t-x",
        content: [
          { type: "text", text: "line1" },
          { type: "image", data: "abc" },
          { type: "text", text: "line2" },
        ],
        is_error: false,
      },
    ],
    parentToolUseId: null,
    ...state,
  });
  assert.match(ev.content, /^line1\n/);
  assert.match(ev.content, /\nline2$/);
  assert.match(ev.content, /"type":"image"/);
});

test("tool_result with non-string non-array content is JSON-stringified", () => {
  const state = freshState();
  state.seenToolIds.add("t-o");
  state.pendingToolIds.set("t-o", "Read");
  const [ev] = extractToolEventsFromBlocks({
    blocks: [
      {
        type: "tool_result",
        tool_use_id: "t-o",
        content: { foo: "bar" },
      },
    ],
    parentToolUseId: null,
    ...state,
  });
  assert.equal(ev.content, '{"foo":"bar"}');
});

test("tool_result default isError is false when is_error is missing", () => {
  const state = freshState();
  state.seenToolIds.add("t-d");
  state.pendingToolIds.set("t-d", "Read");
  const [ev] = extractToolEventsFromBlocks({
    blocks: [
      { type: "tool_result", tool_use_id: "t-d", content: "ok" },
    ],
    parentToolUseId: null,
    ...state,
  });
  assert.equal(ev.isError, false);
});

test("tool_result with is_error=true preserves the flag", () => {
  const state = freshState();
  state.seenToolIds.add("t-e");
  state.pendingToolIds.set("t-e", "Bash");
  const [ev] = extractToolEventsFromBlocks({
    blocks: [
      {
        type: "tool_result",
        tool_use_id: "t-e",
        content: "boom",
        is_error: true,
      },
    ],
    parentToolUseId: null,
    ...state,
  });
  assert.equal(ev.isError, true);
});

test("completing a tool removes it from pendingToolIds", () => {
  const state = freshState();
  extractToolEventsFromBlocks({
    blocks: [
      { type: "tool_use", id: "p1", name: "Read", input: {} },
      { type: "tool_use", id: "p2", name: "Bash", input: {} },
    ],
    parentToolUseId: null,
    ...state,
  });
  assert.equal(state.pendingToolIds.size, 2);

  extractToolEventsFromBlocks({
    blocks: [{ type: "tool_result", tool_use_id: "p1", content: "ok" }],
    parentToolUseId: null,
    ...state,
  });
  assert.equal(state.pendingToolIds.size, 1);
  assert.ok(state.pendingToolIds.has("p2"));
  assert.ok(!state.pendingToolIds.has("p1"));
});

test("parentToolUseId defaults to null when not provided", () => {
  const state = freshState();
  const [ev] = extractToolEventsFromBlocks({
    blocks: [{ type: "tool_use", id: "n1", name: "Read", input: {} }],
    ...state,
  });
  assert.equal(ev.parentToolUseId, null);
});
