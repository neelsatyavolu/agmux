/** @vitest-environment jsdom */
import { expect, it } from "vitest";
import { adoptCodexToolItem, conversationItemsFromExec, conversationItemsFromHistory, foldHistoryConversationItems, mergeExecExpansion, type ConversationItem } from "../CodexSessionView";

const command = (id: string, content: string): ConversationItem => ({ id, type: "command", timestamp: 1, commandName: "npm test", content, exitCode: 0 });
const expansion = (callId: string) => conversationItemsFromExec({ callId, timestamp: 2, source: 'text(await tools.exec_command({cmd:"npm test"}));', result: [{ type: "input_text", text: JSON.stringify({ output: callId, exit_code: 0 }) }] });

it("preserves repeated native commands and updates only the matching call", () => {
  const first = command("first", "first result");
  const second = command("second", "second result");
  expect(adoptCodexToolItem([first], second)).toEqual([first, second]);
  expect(adoptCodexToolItem([first, second], { ...second, content: "updated" })).toEqual([first, { ...second, content: "updated" }]);
});

it("preserves distinct MCP calls to the same tool, including repeated arguments", () => {
  const first: ConversationItem = { id: "first", type: "mcpTool", timestamp: 1, content: "", mcpServer: "docs", mcpToolName: "search", mcpArguments: { query: "first" }, mcpStatus: "completed", mcpResultText: "old result" };
  for (const query of ["first", "second"]) {
    const next = { ...first, id: "second", mcpArguments: { query }, mcpStatus: "inProgress" as const };
    expect(adoptCodexToolItem([first], next)).toEqual([first, next]);
  }
});

it("preserves repeated exec calls and replaces replayed expansion in place", () => {
  const first = expansion("first");
  const second = expansion("second");
  const reply: ConversationItem = { id: "reply", type: "agent", content: "Done", timestamp: 3 };
  expect(mergeExecExpansion(first, second)).toEqual([...first, ...second]);
  expect(mergeExecExpansion([...first, reply], first)).toEqual([...first, reply]);
});

it("preserves repeated command results while folding exec history", () => {
  const entries: ConversationItem[] = ["first", "second"].flatMap((callId) => [
    { id: callId, type: "tool", timestamp: 1, content: "", toolName: "exec", toolInput: { callId, input: 'text(await tools.exec_command({cmd:"npm test"}));' } },
    { id: `${callId}-out`, type: "tool", timestamp: 2, toolName: "ToolResult", toolInput: { callId }, content: JSON.stringify([{ type: "input_text", text: JSON.stringify({ output: callId, exit_code: 0 }) }]) },
  ]);
  expect(foldHistoryConversationItems(entries).map((item) => item.content)).toEqual(["first", "second"]);
});

it("keeps an unknown shell exit status instead of synthesizing success", () => {
  const [item] = conversationItemsFromExec({ callId: "yield", timestamp: 1, source: 'text(await tools.exec_command({cmd:"npm test"}));', result: [{ type: "input_text", text: JSON.stringify({ output: "starting", session_id: 12 }) }] });
  expect(item.exitCode).toBeUndefined();
});

it("keeps raw fallback source and output in history", () => {
  const source = 'if (enabled) text(await tools.exec_command({cmd:dynamic()}));';
  const items = conversationItemsFromExec({ callId: "raw", timestamp: 1, isHistory: true, source, result: "Error: unable to finish" });
  expect(items).toMatchObject([{ type: "tool", toolName: "Code execution", toolInput: { input: source }, content: "Error: unable to finish" }]);
});


it("keeps missing exit markers in plain command history incomplete", () => {
  const [item] = conversationItemsFromHistory([{ role: "command", content: "$ npm test\nstarted", timestamp: "2026-09-14T00:00:00Z" }]);
  expect(item).toMatchObject({ type: "command", commandName: "npm test", content: "started", commandResultIncomplete: true });
  expect(item.exitCode).toBeUndefined();
  for (const exitCode of [0, 1]) {
    const [completed] = conversationItemsFromHistory([{ role: "command", content: `$ npm test\nfinished\n[exit: ${exitCode}]`, timestamp: "2026-09-14T00:00:00Z" }]);
    expect(completed).toMatchObject({ content: "finished", exitCode, commandResultIncomplete: false });
  }
});

it("keeps actual user prompts discussing control tags", () => {
  const prompts = [
    "What does <environment_context> mean in this log?",
    "<environment_context>",
    "<environment_context>first</environment_context>\nExplain this\n<environment_context>second</environment_context>",
    "Please explain <turn_aborted> and how to recover.",
    "<environment_context>cwd example</environment_context>\nWhy is this wrong?",
    "```xml\n<turn_aborted>literal documentation example</turn_aborted>\n```",
  ];
  const rows = conversationItemsFromHistory(prompts.map((content) => ({ role: "user", content, timestamp: "2026-09-14T00:00:00Z" })));
  expect(rows.map((row) => row.content)).toEqual(prompts);
});

it("still suppresses genuine standalone control envelopes", () => {
  const rows = conversationItemsFromHistory([
    { role: "user", content: "  <environment_context>\n<cwd>/tmp/project</cwd>\n</environment_context>\n", timestamp: "2026-09-14T00:00:00Z" },
    { role: "user", content: "<turn_aborted>\nThe user interrupted this turn.\n</turn_aborted>", timestamp: "2026-09-14T00:00:00Z" },
    { role: "user", content: "Continue the work", timestamp: "2026-09-14T00:00:00Z" },
  ]);
  expect(rows.map((row) => row.content)).toEqual(["Continue the work"]);
});
