import { describe, expect, it } from "vitest";
import { normalizeSubagentTool, subagentFromTool, cleanSubagentPrompt, prepareSubagentConversation, isSubagentProvider } from "../subagentConversations";
import { groupMessages } from "../../components/thread/groupMessages";

describe("subagent tool normalization", () => {
  it.each(["ClaudeCode", "Cursor", "Grok", "OpenCode", "Gemini", "MLX"])("makes the shared viewer available to %s chat", (provider) => {
    expect(isSubagentProvider(provider)).toBe(true);
  });
  it("renders native Codex command arguments with the shared terminal renderer", () => {
    const item = normalizeSubagentTool({ id: "x", type: "tool", text: "", toolName: "exec_command", toolInput: { cmd: "npm test", workdir: "/repo" }, toolResult: "Passed" });
    expect(item.toolName).toBe("Bash");
    expect(item.toolInput?.command).toBe("npm test");
  });
  it("uses a readable name for child messages to other agents", () => {
    expect(normalizeSubagentTool({ id: "send", type: "tool", text: "", toolName: "collaboration.send_message", toolInput: { target: "/root", message: "Found a hot loop" } }).toolName).toBe("Send message");
  });
  it("normalizes Cursor protobuf tool names and shell output", () => {
    const item = normalizeSubagentTool({ id: "x", type: "tool", text: "", toolName: "shellToolCall", toolInput: { command: "npm test" }, toolResult: '{"success":{"stdout":"3 passed","stderr":""}}' });
    expect(item.toolName).toBe("shell");
    expect(item.toolResult).toBe("3 passed");
  });
  it("normalizes Cursor child arguments that bypass the parent bridge adapter", () => {
    const shell = normalizeSubagentTool({ id: "s", type: "tool", text: "", toolName: "shellToolCall", toolInput: { script: "npm test" } });
    expect(shell.toolInput?.command).toBe("npm test");
    const edit = normalizeSubagentTool({ id: "e", type: "tool", text: "", toolName: "editToolCall", toolInput: { targetFile: "a.ts", oldText: "before", newText: "" } });
    expect(edit.toolInput).toMatchObject({ file_path: "a.ts", old_string: "before", new_string: "" });
    const write = normalizeSubagentTool({ id: "w", type: "tool", text: "", toolName: "writeToolCall", toolInput: { filename: "b.ts", fileText: "hello" } });
    expect(write.toolInput).toMatchObject({ file_path: "b.ts", content: "hello" });
  });
  it("normalizes Grok search_replace into shared edit inputs", () => {
    const item = normalizeSubagentTool({ id: "x", type: "tool", text: "", toolName: "search_replace", toolInput: { target_file: "a.ts", old_text: "old", new_text: "new" } });
    expect(item.toolInput).toMatchObject({ file_path: "a.ts", old_string: "old", new_string: "new" });
  });
  it("unwraps Claude text-block results without showing JSON envelopes", () => {
    expect(normalizeSubagentTool({ id: "x", type: "tool", text: "", toolResult: '[{"type":"text","text":"File contents"}]' }).toolResult).toBe("File contents");
  });
  it("renders saved Cursor read failures as readable errors", () => {
    expect(normalizeSubagentTool({ id: "r", type: "tool", text: "", toolName: "readToolCall", isError: true, toolResult: '{"rejected":{"path":"a.ts","reason":"User declined"}}' }).toolResult).toBe("User declined");
  });
  it("does not mark asynchronous spawn acknowledgements completed", () => {
    expect(subagentFromTool("spawn_subagent", "x", {}, { content: '{"subagent_id":"a"}', isError: false }, false)).toMatchObject({ childId: "a", status: "running" });
  });
  it("keeps OpenCode background tasks running after the launch tool returns", () => {
    expect(subagentFromTool("task", "launch", { description: "Scout" }, { content: '<task id="ses_child" state="running">Working in the background</task>', isError: false }, false)).toMatchObject({ childId: "ses_child", status: "running" });
    expect(subagentFromTool("task", "launch", {}, { content: '<task id="ses_child" state="error">Failed</task>', isError: false }, false)).toMatchObject({ status: "failed" });
  });
  it.each(["Agent", "Task", "task", "spawn_subagent"])("keeps %s launches individually clickable outside tool groups", (name) => {
    const tools = ["Read", name, "Read"].map((toolName, index) => ({ itemType: "ToolUse" as const, name: toolName, id: `t${index}`, uuid: `t${index}`, timestamp: "2026-09-07T00:00:00Z", input: {} }));
    expect(groupMessages(tools).some((item) => item.itemType === "ToolUse" && item.name === name && item.id === "t1")).toBe(true);
  });
});


describe("subagent prompt display", () => {
  const setup = "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nPrivate setup rules\n</INSTRUCTIONS>";
  it("hides inherited AGENTS instructions and environment-only messages", () => {
    const items = prepareSubagentConversation([
      { id: "setup", type: "user", text: setup },
      { id: "env", type: "user", text: "<environment_context>workdir=/repo</environment_context>" },
      { id: "task", type: "user", text: "Check package scripts." },
      { id: "answer", type: "assistant", text: "The scripts are valid." },
    ]);
    expect(items.map((item) => item.id)).toEqual(["task", "answer"]);
  });
  it("preserves the assignment following injected setup in the same message", () => {
    expect(cleanSubagentPrompt(setup + "\n<environment_context>cwd=/repo</environment_context>\nCheck package scripts.")).toBe("Check package scripts.");
  });
  it("cleans shared system-reminder and terminal noise from assignments", () => {
    expect(cleanSubagentPrompt("<system-reminder>setup</system-reminder>\nCheck scripts.\n[Request interrupted by user]")).toBe("Check scripts.");
  });
  it("preserves meaningful references to AGENTS.md and quoted context tags", () => {
    const prompt = "Read AGENTS.md and explain this example:\n```xml\n<environment_context>example</environment_context>\n```";
    expect(cleanSubagentPrompt(prompt)).toBe(prompt);
  });
  it("does not change assistant replies or tool output containing instructions", () => {
    const items = [{ id: "answer", type: "assistant" as const, text: setup }, { id: "tool", type: "tool" as const, text: "", toolResult: setup }];
    const prepared = prepareSubagentConversation(items);
    expect(prepared[0]).toEqual(items[0]);
    expect(prepared[1].toolResult).toBe(setup);
  });
});
