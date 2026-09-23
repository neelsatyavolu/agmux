import test from "node:test";
import assert from "node:assert/strict";

import { extractToolEventsFromBlocks } from "./subagent-tool-events.mjs";

test("emits nested tool events with parent tool association", () => {
  const seenToolIds = new Set();
  const pendingToolIds = new Map();
  const activeAgentToolIds = new Set();

  const events = extractToolEventsFromBlocks({
    blocks: [
      {
        type: "tool_use",
        id: "toolu_child",
        name: "Read",
        input: { file_path: "/tmp/demo.txt" },
      },
      {
        type: "tool_result",
        tool_use_id: "toolu_child",
        content: "hello",
        is_error: false,
      },
    ],
    parentToolUseId: "toolu_parent",
    seenToolIds,
    pendingToolIds,
    activeAgentToolIds,
  });

  assert.deepEqual(events, [
    {
      event: "tool.started",
      toolUseId: "toolu_child",
      parentToolUseId: "toolu_parent",
      name: "Read",
      input: { file_path: "/tmp/demo.txt" },
    },
    {
      event: "tool.completed",
      toolUseId: "toolu_child",
      parentToolUseId: "toolu_parent",
      content: "hello",
      isError: false,
    },
  ]);
  assert.equal(pendingToolIds.size, 0);
});

test("deduplicates repeated tool_use blocks while preserving completion", () => {
  const seenToolIds = new Set(["toolu_repeat"]);
  const pendingToolIds = new Map([["toolu_repeat", "Read"]]);
  const activeAgentToolIds = new Set();

  const events = extractToolEventsFromBlocks({
    blocks: [
      {
        type: "tool_use",
        id: "toolu_repeat",
        name: "Read",
        input: { file_path: "/tmp/demo.txt" },
      },
      {
        type: "tool_result",
        tool_use_id: "toolu_repeat",
        content: [{ type: "text", text: "done" }],
        is_error: false,
      },
    ],
    parentToolUseId: "toolu_parent",
    seenToolIds,
    pendingToolIds,
    activeAgentToolIds,
  });

  assert.deepEqual(events, [
    {
      event: "tool.completed",
      toolUseId: "toolu_repeat",
      parentToolUseId: "toolu_parent",
      content: "done",
      isError: false,
    },
  ]);
});
