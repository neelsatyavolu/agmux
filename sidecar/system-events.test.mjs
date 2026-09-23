import test from "node:test";
import assert from "node:assert/strict";

import { systemMessageToEvents } from "./system-events.mjs";

test("maps task notifications to structured SDK events", () => {
  assert.deepEqual(
    systemMessageToEvents({
      type: "system",
      subtype: "task_notification",
      title: "Notification",
      body: "Hmm, that agent got a bit confused. Let me fire another one with a tighter prompt:",
    }),
    [
      {
        event: "task.notification",
        taskId: null,
        title: "Notification",
        body: "Hmm, that agent got a bit confused. Let me fire another one with a tighter prompt:",
        status: null,
        summary: null,
      },
    ],
  );
});

test("maps task notifications with terminal status", () => {
  assert.deepEqual(
    systemMessageToEvents({
      type: "system",
      subtype: "task_notification",
      task_id: "task-abc",
      title: "Task completed",
      body: "Research finished",
      status: "completed",
      summary: "Found 3 relevant articles",
    }),
    [
      {
        event: "task.notification",
        taskId: "task-abc",
        title: "Task completed",
        body: "Research finished",
        status: "completed",
        summary: "Found 3 relevant articles",
      },
    ],
  );
});

test("maps task_progress with usage stats", () => {
  assert.deepEqual(
    systemMessageToEvents({
      type: "system",
      subtype: "task_progress",
      task_id: "task-xyz",
      status: "Working...",
      last_tool_name: "Read",
      usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, total_tokens: 2000, tool_uses: 3, duration_ms: 5000 },
    }),
    [
      {
        event: "task.progress",
        taskId: "task-xyz",
        status: "Working...",
        lastToolName: "Read",
        usage: { inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 200, cacheReadTokens: 300, totalTokens: 2000, toolUses: 3, durationMs: 5000 },
      },
    ],
  );
});

test("maps task_progress with minimal usage (no cache/total fields)", () => {
  assert.deepEqual(
    systemMessageToEvents({
      type: "system",
      subtype: "task_progress",
      task_id: "task-abc",
      status: "Processing...",
      last_tool_name: "Bash",
      usage: { input_tokens: 500, output_tokens: 100, tool_uses: 1, duration_ms: 2000 },
    }),
    [
      {
        event: "task.progress",
        taskId: "task-abc",
        status: "Processing...",
        lastToolName: "Bash",
        usage: { inputTokens: 500, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: null, toolUses: 1, durationMs: 2000 },
      },
    ],
  );
});

test("maps status system messages", () => {
  assert.deepEqual(
    systemMessageToEvents({
      type: "system",
      subtype: "status",
      body: "all good",
    }),
    [
      {
        event: "status",
        status: null,
        message: "all good",
      },
    ],
  );
});

test("ignores unrelated system messages", () => {
  assert.deepEqual(
    systemMessageToEvents({
      type: "system",
      subtype: "unknown_thing",
    }),
    [],
  );
});
