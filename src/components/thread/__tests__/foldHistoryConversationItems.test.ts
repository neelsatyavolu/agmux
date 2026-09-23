/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import {
  codexAsyncQuestions,
  conversationItemsFromExec,
  adoptCodexToolItem,
  foldHistoryConversationItems,
  mergeHistoryIntoItems,
} from "../CodexSessionView";

describe("foldHistoryConversationItems", () => {
  it("keeps generic tools", () => {
    const out = foldHistoryConversationItems([
      {
        id: "h1",
        type: "tool",
        content: "Search results ready",
        timestamp: 1,
        toolName: "WebSearch",
        toolInput: { query: "codex app-server" },
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].toolName).toBe("WebSearch");
  });

  it("folds collab spawn/wait/ToolResult like a real session", () => {
    // Real JSONL order: function_call then function_call_output (ToolResult)
    const out = foldHistoryConversationItems([
      {
        id: "h0",
        type: "tool",
        content: "",
        timestamp: 1,
        toolName: "collaboration.spawn_agent",
        toolInput: { task_name: "frontend_perf", message: "audit fe", callId: "call_a" },
      },
      {
        id: "h1",
        type: "tool",
        content: "",
        timestamp: 2,
        toolName: "collaboration.spawn_agent",
        toolInput: { task_name: "backend_perf", message: "audit be", callId: "call_b" },
      },
      {
        id: "h3",
        type: "tool",
        content: "",
        timestamp: 4,
        toolName: "wait_agent",
        toolInput: { timeout_ms: 10000, callId: "call_w1" },
      },
      {
        id: "h4",
        type: "tool",
        content: '{"message":"Wait timed out.","timed_out":true}',
        timestamp: 5,
        toolName: "ToolResult",
        toolInput: { callId: "call_w1" },
      },
      {
        id: "h5",
        type: "tool",
        content: "",
        timestamp: 6,
        toolName: "exec",
        toolInput: { callId: "call_e", input: "tools.exec_command(...)" },
      },
      {
        id: "h6",
        type: "tool",
        content: "failed to spawn code-mode host",
        timestamp: 7,
        toolName: "ToolResult",
        toolInput: { callId: "call_e" },
      },
    ]);
    const tools = out.filter((i) => i.type === "tool");
    // exec + its ToolResult are code-mode internal — dropped so history matches live.
    expect(tools.map((t) => t.toolName)).toEqual([
      "CollabAgent.spawn_agent",
      "CollabAgent.spawn_agent",
    ]);
    expect(tools[0].toolInput?.agentNickname).toBe("frontend_perf");
    expect(tools[1].toolInput?.agentNickname).toBe("backend_perf");
    // Reading history is not evidence that a child finished.
    expect(tools[0].toolInput?.agentLifecycleStatus).not.toBe("completed");
    expect(tools.some((t) => t.toolName === "ToolResult")).toBe(false);
    expect(tools.some((t) => t.toolName === "exec")).toBe(false);
    expect(tools.some((t) => t.toolName?.includes("wait"))).toBe(false);
  });

  it("expands code-mode exec into command and MCP rows", () => {
    const out = foldHistoryConversationItems([
      {
        id: "h-exec",
        type: "tool",
        content: "",
        timestamp: 1,
        toolName: "exec",
        toolInput: {
          callId: "call_build",
          input: 'text(await tools.mcp__docs__search({query:"cache"})); text(await tools.exec_command({cmd:"cat > /tmp/build.py <<\'PY\'\\nprint(1)\\nPY"}));',
        },
      },
      {
        id: "h-out",
        type: "tool",
        content: JSON.stringify([
          { type: "input_text", text: "status" },
          { type: "input_text", text: JSON.stringify({ content: [{ type: "text", text: "Docs" }] }) },
          { type: "input_text", text: JSON.stringify({ output: "Created out.html", exit_code: 0 }) },
        ]),
        timestamp: 2,
        toolName: "ToolResult",
        toolInput: { callId: "call_build" },
      },
    ]);
    expect(out.map((item) => item.type)).toEqual(["mcpTool", "command"]);
    expect(out[0].mcpToolName).toBe("search");
    expect(out[0].mcpResultText).toBe("Docs");
    expect(out[1].commandName).toContain("cat > /tmp/build.py");
    expect(out[1].content).toBe("Created out.html");
    expect(out[0].execGroupId).toBe("call_build");
    expect(out[1].execGroupId).toBe("call_build");
  });

  it("does not duplicate an exec command with the same call identity", () => {
    const out = foldHistoryConversationItems([
      {
        id: "call_dup:0",
        type: "command",
        content: "src/cache.ts",
        timestamp: 1,
        commandName: "rg cache src",
        exitCode: 0,
      },
      {
        id: "h-exec",
        type: "tool",
        content: "",
        timestamp: 2,
        toolName: "exec",
        toolInput: {
          callId: "call_dup",
          input: 'text(await tools.exec_command({cmd:"rg cache src"}));',
        },
      },
      {
        id: "h-out",
        type: "tool",
        content: JSON.stringify([
          { type: "input_text", text: JSON.stringify({ output: "src/cache.ts", exit_code: 0 }) },
        ]),
        timestamp: 3,
        toolName: "ToolResult",
        toolInput: { callId: "call_dup" },
      },
    ]);
    expect(out.filter((item) => item.type === "command")).toHaveLength(1);
  });

  it("marks yielded exec commands complete in history", () => {
    const out = foldHistoryConversationItems([
      {
        id: "h-exec",
        type: "tool",
        content: "",
        timestamp: 1,
        toolName: "exec",
        toolInput: {
          callId: "call_tsc",
          input: 'text(await tools.exec_command({cmd:"npx tsc --noEmit"}));',
        },
      },
      {
        id: "h-out",
        type: "tool",
        content: JSON.stringify([
          { type: "input_text", text: JSON.stringify({ session_id: 12, output: "" }) },
        ]),
        timestamp: 2,
        toolName: "ToolResult",
        toolInput: { callId: "call_tsc" },
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("command");
    expect(out[0].exitCode).toBe(0);
    expect(out[0].commandName).toBe("npx tsc --noEmit");
  });
});

describe("adoptCodexToolItem", () => {
  it("merges completion into the matching command identity", () => {
    const out = adoptCodexToolItem(
      [{ id: "native-tsc", type: "command", content: "", timestamp: 1, commandName: "npx tsc --noEmit" }],
      { id: "native-tsc", type: "command", content: "ok", timestamp: 2, commandName: "npx tsc --noEmit", exitCode: 0 },
    );
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("ok");
    expect(out[0].exitCode).toBe(0);
  });

  it("accepts a server display-name change for the same MCP call", () => {
    const out = adoptCodexToolItem(
      [{
        id: "call_1:0",
        type: "mcpTool",
        content: "",
        timestamp: 1,
        mcpServer: "agmux_memory",
        mcpToolName: "memory_list",
        mcpStatus: "completed",
        execGroupId: "call_1",
      }],
      {
        id: "call_1:0",
        type: "mcpTool",
        content: "",
        timestamp: 2,
        mcpServer: "agmux-memory",
        mcpToolName: "memory_list",
        mcpStatus: "completed",
        mcpDurationMs: 3,
      },
    );
    expect(out).toHaveLength(1);
    expect(out[0].mcpDurationMs).toBe(3);
    expect(out[0].mcpServer).toBe("agmux-memory");
  });
});

describe("mergeHistoryIntoItems", () => {
  it("replaces a saved optimistic prompt but keeps a newer identical submission", () => {
    const pending = { id: "optimistic-user-1", type: "user" as const, content: "Deploy.", timestamp: 100 };
    const history = [{ id: "history-1", type: "user" as const, content: "Deploy.", timestamp: 101, isHistory: true }];
    expect(mergeHistoryIntoItems([pending], history)).toEqual(history);
    const newer = { ...pending, id: "optimistic-user-2", timestamp: 200 };
    expect(mergeHistoryIntoItems([pending, newer], history)).toEqual([...history, newer]);
  });

  it("catches up missed assistant messages even when live has extra tool rows", () => {
    const live = [
      { id: "u1", type: "user" as const, content: "Do the stacked cards.", timestamp: 1 },
      { id: "a1", type: "agent" as const, content: "I’ll implement the stacked cards", timestamp: 2 },
      { id: "cmd", type: "command" as const, content: "log", timestamp: 3, commandName: "" },
      { id: "cmd2", type: "command" as const, content: "log2", timestamp: 4 },
    ];
    const history = [
      { id: "h-u", type: "user" as const, content: "Do the stacked cards.", timestamp: 1, isHistory: true },
      { id: "h-a1", type: "agent" as const, content: "I’ll implement the stacked cards", timestamp: 2, isHistory: true },
      { id: "h-a2", type: "agent" as const, content: "The shared cards are wired up", timestamp: 3, isHistory: true },
      { id: "h-a3", type: "agent" as const, content: "The actual components match", timestamp: 4, isHistory: true },
      { id: "h-a4", type: "agent" as const, content: "The final checks pass", timestamp: 5, isHistory: true },
      { id: "h-a5", type: "agent" as const, content: "Implemented the stacked cards", timestamp: 6, isHistory: true },
    ];
    const out = mergeHistoryIntoItems(live, history);
    expect(out.filter((item) => item.type === "agent")).toHaveLength(5);
    expect(out.some((item) => item.content.includes("Implemented the stacked cards"))).toBe(true);
  });

  it("keeps live state when history is not ahead", () => {
    const live = [
      { id: "u1", type: "user" as const, content: "hi", timestamp: 1 },
      { id: "a1", type: "agent" as const, content: "hello", timestamp: 2 },
    ];
    const history = [
      { id: "h-u", type: "user" as const, content: "hi", timestamp: 1, isHistory: true },
      { id: "h-a", type: "agent" as const, content: "hello", timestamp: 2, isHistory: true },
    ];
    expect(mergeHistoryIntoItems(live, history)).toBe(live);
  });
});
it("hides shell polling in history and expanded exec while preserving async questions", () => {
  const out = foldHistoryConversationItems([
    { id: "poll", type: "tool", timestamp: 1, content: "", toolName: "functions.write_stdin" },
    { id: "result", type: "tool", timestamp: 2, content: "done", toolName: "ToolResult", toolInput: { callId: "poll" } },
    { id: "ask", type: "tool", timestamp: 3, content: "", toolName: "request_user_input_async", toolInput: { questions: [{ title: "Ready?", options: ["Done"] }] } },
  ]);
  expect(out).toHaveLength(1);
  expect(codexAsyncQuestions(out[0])).toEqual([{ id: "0", question: "Ready?", options: [{ label: "Done", description: "" }] }]);
  expect(conversationItemsFromExec({ callId: "exec", timestamp: 1, source: 'text(await tools.write_stdin({session_id: 123}));' })).toEqual([]);
});
