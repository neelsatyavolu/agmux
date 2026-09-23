import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CURSOR_MODEL,
  parseCursorModelSlug,
  serializeCursorModelSelection,
  normalizeCursorModel,
  normalizeCursorTokenUsage,
  buildCursorUserMessage,
  mapCursorMessageToEvents,
} from "./cursor-protocol-helpers.mjs";

test("DEFAULT_CURSOR_MODEL is composer-2.5 and blank model input normalizes to it", () => {
  assert.equal(DEFAULT_CURSOR_MODEL, "composer-2.5");
  assert.deepEqual(parseCursorModelSlug(), { id: "composer-2.5" });
  assert.deepEqual(parseCursorModelSlug(null), { id: "composer-2.5" });
  assert.deepEqual(parseCursorModelSlug(""), { id: "composer-2.5" });
  assert.deepEqual(parseCursorModelSlug("   "), { id: "composer-2.5" });
  assert.deepEqual(normalizeCursorModel(null), { id: "composer-2.5" });
  assert.deepEqual(normalizeCursorModel({}), { id: "composer-2.5" });
});

test('parseCursorModelSlug("composer-2.5") returns a ModelSelection id', () => {
  assert.deepEqual(parseCursorModelSlug("composer-2.5"), {
    id: "composer-2.5",
  });
});

test("parseCursorModelSlug parses query params into current Cursor SDK params array", () => {
  assert.deepEqual(
    parseCursorModelSlug("composer-2.5?thinking=high&maxMode=true"),
    {
      id: "composer-2.5",
      params: [
        { id: "thinking", value: "high" },
        { id: "maxMode", value: "true" },
      ],
    },
  );
});

test("serializeCursorModelSelection is deterministic for array and legacy object params", () => {
  assert.equal(
    serializeCursorModelSelection({
      id: "composer-2.5",
      params: [
        { id: "zeta", value: "last" },
        { id: "thinking", value: "high" },
        { id: "empty", value: "" },
        { id: "none", value: null },
      ],
    }),
    "composer-2.5?thinking=high&zeta=last",
  );
  assert.equal(
    serializeCursorModelSelection({
      id: "composer-2.5",
      params: { zeta: "last", thinking: "high", empty: "" },
    }),
    "composer-2.5?thinking=high&zeta=last",
  );
});

test("normalizeCursorModel accepts stored slugs, SDK selections, and legacy object-param selections", () => {
  assert.deepEqual(normalizeCursorModel("composer-2.5?thinking=high"), {
    id: "composer-2.5",
    params: [{ id: "thinking", value: "high" }],
  });
  assert.deepEqual(
    normalizeCursorModel({
      id: "composer-2.5",
      params: [{ id: "thinking", value: "high" }],
    }),
    {
      id: "composer-2.5",
      params: [{ id: "thinking", value: "high" }],
    },
  );
  assert.deepEqual(
    normalizeCursorModel({
      id: "composer-2.5",
      params: { zeta: "last", thinking: "high", empty: "" },
    }),
    {
      id: "composer-2.5",
      params: [
        { id: "thinking", value: "high" },
        { id: "zeta", value: "last" },
      ],
    },
  );
});

test("buildCursorUserMessage maps agmux and Cursor image attachments", () => {
  assert.deepEqual(buildCursorUserMessage("hello"), { text: "hello" });
  assert.deepEqual(
    buildCursorUserMessage("hello", [
      {
        data: "base64-a",
        mediaType: "image/png",
        dimension: { width: 100, height: 80 },
      },
      { data: "base64-b", mimeType: "image/jpeg" },
      {
        url: "https://example.com/image.webp",
        mimeType: "image/webp",
        dimension: { width: 32, height: 32 },
      },
    ]),
    {
      text: "hello",
      images: [
        {
          data: "base64-a",
          mimeType: "image/png",
          dimension: { width: 100, height: 80 },
        },
        { data: "base64-b", mimeType: "image/jpeg" },
        {
          url: "https://example.com/image.webp",
          mimeType: "image/webp",
          dimension: { width: 32, height: 32 },
        },
      ],
    },
  );
});

test("mapCursorMessageToEvents maps assistant text and thinking variants", () => {
  assert.deepEqual(
    mapCursorMessageToEvents({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "hi" },
          { type: "thinking", text: "plan" },
          { type: "thinking", thinking: "fallback" },
        ],
      },
    }),
    [
      { type: "content.delta", contentType: "text", text: "hi" },
      { type: "content.delta", contentType: "thinking", text: "plan" },
      { type: "content.delta", contentType: "thinking", text: "fallback" },
    ],
  );
  assert.deepEqual(mapCursorMessageToEvents({ type: "thinking", text: "top" }), [
    { type: "content.delta", contentType: "thinking", text: "top" },
  ]);
});

test("mapCursorMessageToEvents maps tool_call lifecycle", () => {
  const seenToolStarts = new Set();

  assert.deepEqual(
    mapCursorMessageToEvents(
      {
        type: "tool_call",
        call_id: "call-1",
        name: "grep",
        status: "running",
        args: { pattern: "needle" },
      },
      seenToolStarts,
    ),
    [
      {
        type: "tool.started",
        toolUseId: "call-1",
        name: "grep",
        input: { pattern: "needle" },
      },
    ],
  );
  assert.deepEqual(
    mapCursorMessageToEvents(
      {
        type: "tool_call",
        call_id: "call-1",
        name: "grep",
        status: "completed",
        result: "found it",
      },
      seenToolStarts,
    ),
    [
      {
        type: "tool.completed",
        toolUseId: "call-1",
        name: "grep",
        content: "found it",
        isError: false,
      },
    ],
  );
  assert.deepEqual(
    mapCursorMessageToEvents({
      type: "tool_call",
      call_id: "call-2",
      name: "read",
      status: "error",
      args: { path: "missing.txt" },
      result: "not found",
    }),
    [
      {
        type: "tool.started",
        toolUseId: "call-2",
        name: "read",
        input: { path: "missing.txt", file_path: "missing.txt" },
      },
      {
        type: "tool.completed",
        toolUseId: "call-2",
        name: "read",
        content: "not found",
        isError: true,
      },
    ],
  );
});

test("mapCursorMessageToEvents uses error text for error-only tool_call results", () => {
  assert.deepEqual(
    mapCursorMessageToEvents({
      type: "tool_call",
      call_id: "call-e",
      name: "shell",
      status: "error",
      error: "permission denied",
    }),
    [
      {
        type: "tool.started",
        toolUseId: "call-e",
        name: "shell",
        input: {},
      },
      {
        type: "tool.completed",
        toolUseId: "call-e",
        name: "shell",
        content: "permission denied",
        isError: true,
      },
    ],
  );
});

test("mapCursorMessageToEvents maps status, task, request, and system/init messages", () => {
  assert.deepEqual(
    mapCursorMessageToEvents({
      type: "status",
      status: "RUNNING",
      message: "Working",
    }),
    [{ type: "status", status: "RUNNING", message: "Working" }],
  );
  // Bare lifecycle status codes must not invent a chat-visible message
  // (FINISHED / RUNNING / IDLE would otherwise show as system lines).
  assert.deepEqual(
    mapCursorMessageToEvents({ type: "status", status: "FINISHED" }),
    [{ type: "status", status: "FINISHED", message: "" }],
  );
  assert.deepEqual(
    mapCursorMessageToEvents({ type: "status", status: "RUNNING" }),
    [{ type: "status", status: "RUNNING", message: "" }],
  );
  assert.deepEqual(
    mapCursorMessageToEvents({
      type: "task",
      task_id: "task-1",
      title: "Planning",
      text: "Reading files",
      status: "completed",
      summary: "done",
    }),
    [
      {
        type: "task.notification",
        taskId: "task-1",
        title: "Planning",
        body: "Reading files",
        status: "completed",
        summary: "done",
      },
    ],
  );
  assert.deepEqual(
    mapCursorMessageToEvents({
      type: "request",
      request_id: "req-1",
    }),
    [
      {
        type: "status",
        status: "request",
        message:
          "Cursor is waiting on a request (req-1). Use Chat/Plan and permission mode (Supervised / Auto / Full) to control tool policy.",
        requestId: "req-1",
      },
    ],
  );
  assert.deepEqual(mapCursorMessageToEvents({ type: "system", subtype: "init" }), [
    { type: "session.init", sessionId: null, slashCommands: [] },
  ]);
});

test("duplicate tool starts are suppressed across tool_use blocks and tool_call events", () => {
  const seenToolStarts = new Set();

  assert.deepEqual(
    mapCursorMessageToEvents(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "grep",
              input: { pattern: "needle" },
            },
          ],
        },
      },
      seenToolStarts,
    ),
    [
      {
        type: "tool.started",
        toolUseId: "call-1",
        name: "grep",
        input: { pattern: "needle" },
      },
    ],
  );
  assert.deepEqual(
    mapCursorMessageToEvents(
      {
        type: "tool_call",
        call_id: "call-1",
        name: "grep",
        status: "running",
        args: { pattern: "needle" },
      },
      seenToolStarts,
    ),
    [],
  );
});

test("mapCursorMessageToEvents normalizes Cursor edit oldText/newText and write fileText", () => {
  assert.deepEqual(
    mapCursorMessageToEvents({
      type: "tool_call",
      call_id: "edit-1",
      name: "edit",
      status: "running",
      args: { path: "src/foo.ts", oldText: "a", newText: "b" },
    }),
    [
      {
        type: "tool.started",
        toolUseId: "edit-1",
        name: "edit",
        input: {
          path: "src/foo.ts",
          file_path: "src/foo.ts",
          oldText: "a",
          newText: "b",
          old_string: "a",
          new_string: "b",
        },
      },
    ],
  );
  assert.deepEqual(
    mapCursorMessageToEvents({
      type: "tool_call",
      call_id: "write-1",
      name: "write",
      status: "running",
      args: { path: "src/new.ts", fileText: "hello\nworld" },
    }),
    [
      {
        type: "tool.started",
        toolUseId: "write-1",
        name: "write",
        input: {
          path: "src/new.ts",
          file_path: "src/new.ts",
          fileText: "hello\nworld",
          content: "hello\nworld",
          new_string: "hello\nworld",
        },
      },
    ],
  );
});

test("non-string tool results are stringified conservatively", () => {
  assert.deepEqual(
    mapCursorMessageToEvents({
      type: "tool_call",
      call_id: "call-1",
      name: "read",
      status: "completed",
      result: { ok: true, paths: ["a.txt"] },
    }),
    [
      {
        type: "tool.started",
        toolUseId: "call-1",
        name: "read",
        input: {},
      },
      {
        type: "tool.completed",
        toolUseId: "call-1",
        name: "read",
        content: '{"ok":true,"paths":["a.txt"]}',
        isError: false,
      },
    ],
  );
});

test("normalizeCursorTokenUsage maps cacheWriteTokens and Claude aliases", () => {
  assert.deepEqual(
    normalizeCursorTokenUsage({
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadTokens: 400,
      cacheWriteTokens: 50,
      totalTokens: 1730,
    }),
    {
      inputTokens: 1200,
      outputTokens: 80,
      cacheCreationTokens: 50,
      cacheReadTokens: 400,
      totalTokens: 1730,
      totalCostUsd: 0,
      numTurns: 1,
    },
  );
  assert.deepEqual(
    normalizeCursorTokenUsage({
      input_tokens: 10,
      output_tokens: 2,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4,
      total_cost_usd: 0.01,
      num_turns: 2,
    }),
    {
      inputTokens: 10,
      outputTokens: 2,
      cacheCreationTokens: 3,
      cacheReadTokens: 4,
      totalTokens: null,
      totalCostUsd: 0.01,
      numTurns: 2,
    },
  );
});

test("usage messages emit flat Claude-shaped usage.update for the top-bar ring", () => {
  assert.deepEqual(
    mapCursorMessageToEvents({
      type: "usage",
      agent_id: "a1",
      run_id: "r1",
      usage: {
        inputTokens: 5000,
        outputTokens: 120,
        cacheReadTokens: 2000,
        cacheWriteTokens: 100,
        totalTokens: 7220,
      },
    }),
    [
      {
        type: "usage.update",
        inputTokens: 5000,
        outputTokens: 120,
        cacheCreationTokens: 100,
        cacheReadTokens: 2000,
        totalTokens: 7220,
      },
    ],
  );
  // Empty usage → no event (would zero the ring).
  assert.deepEqual(
    mapCursorMessageToEvents({ type: "usage", usage: { inputTokens: 0, outputTokens: 0 } }),
    [],
  );
});
