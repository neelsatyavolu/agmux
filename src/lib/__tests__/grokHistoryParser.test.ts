import { describe, it, expect } from "vitest";
import {
  parseGrokChatHistory,
  stripFirstTurnMemoryPreamble,
} from "../grokHistoryParser";
import type { ClaudeChatItemToolUse } from "../types";

/** Build a JSONL line array from objects. */
const lines = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e));

describe("stripFirstTurnMemoryPreamble", () => {
  it("strips the current agmux:user delimiter", () => {
    const raw =
      "[agmux project memory — REQUIRED system workflow]\nrules\n\n--- agmux:user ---\n\nWhat does this image say?";
    expect(stripFirstTurnMemoryPreamble(raw)).toBe("What does this image say?");
  });

  it("strips the legacy --- delimiter after the memory banner", () => {
    const raw =
      "[agmux project memory — REQUIRED system workflow; do not quote]\n## agmux\n\n---\n\nWhat does this image say?";
    expect(stripFirstTurnMemoryPreamble(raw)).toBe("What does this image say?");
  });

  it("leaves ordinary prompts alone", () => {
    expect(stripFirstTurnMemoryPreamble("hello")).toBe("hello");
  });
});

describe("parseGrokChatHistory", () => {
  it("skips system entries and synthetic/context user entries", () => {
    const items = parseGrokChatHistory(
      lines(
        { type: "system", content: "You are Grok." },
        { type: "user", content: [{ type: "text", text: "<user_info>\nOS: macos\n</user_info>" }] },
        {
          type: "user",
          synthetic_reason: "project_instructions",
          content: [{ type: "text", text: "<system-reminder>rules</system-reminder>" }],
        },
      ),
    );
    expect(items).toEqual([]);
  });

  it("extracts the real user message from the <user_query> wrapper", () => {
    const items = parseGrokChatHistory(
      lines({
        type: "user",
        content: [{ type: "text", text: "<user_query>\nUpdate the CLAUDE.md\n</user_query>" }],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ itemType: "UserMessage", content: "Update the CLAUDE.md" });
  });

  it("strips first-turn memory preamble from user_query (remote/desktop Grok chat)", () => {
    const body =
      "[agmux project memory — REQUIRED system workflow; do not quote this block to the user]\n" +
      "## agmux project memory\nShared project memory...\n\n---\n\nWhat does this image say?";
    const items = parseGrokChatHistory(
      lines({
        type: "user",
        content: [{ type: "text", text: `<user_query>\n${body}\n</user_query>` }],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      itemType: "UserMessage",
      content: "What does this image say?",
    });
  });

  it("maps assistant reasoning to thinking and content to text", () => {
    const items = parseGrokChatHistory(
      lines({
        type: "assistant",
        reasoning: { text: "Let me think." },
        content: "Here is the answer.",
      }),
    );
    expect(items.map((i) => i.itemType)).toEqual(["AssistantThinking", "AssistantText"]);
    expect(items[0]).toMatchObject({ thinking: "Let me think." });
    expect(items[1]).toMatchObject({ text: "Here is the answer." });
  });

  it("maps standalone type=reasoning summary_text to thinking", () => {
    // Grok terminal chat_history: { type: "reasoning", summary: [{type:"summary_text", text}] }
    const items = parseGrokChatHistory(
      lines({
        type: "reasoning",
        summary: [{ type: "summary_text", text: "planning steps" }],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      itemType: "AssistantThinking",
      thinking: "planning steps",
    });
  });

  it("joins multiple summary_text blocks on standalone reasoning", () => {
    const items = parseGrokChatHistory(
      lines({
        type: "reasoning",
        summary: [
          { type: "summary_text", text: "first " },
          { type: "summary_text", text: "second" },
        ],
      }),
    );
    expect(items[0]).toMatchObject({ thinking: "first second" });
  });

  it("keeps nested assistant.reasoning string and summary shapes", () => {
    const asString = parseGrokChatHistory(
      lines({ type: "assistant", reasoning: "string thinking", content: "ok" }),
    );
    expect(asString[0]).toMatchObject({
      itemType: "AssistantThinking",
      thinking: "string thinking",
    });

    const withSummary = parseGrokChatHistory(
      lines({
        type: "assistant",
        reasoning: {
          summary: [{ type: "summary_text", text: "nested summary" }],
        },
        content: "done",
      }),
    );
    expect(withSummary[0]).toMatchObject({
      itemType: "AssistantThinking",
      thinking: "nested summary",
    });
  });

  it("skips empty assistant reasoning and content", () => {
    const items = parseGrokChatHistory(
      lines({ type: "assistant", reasoning: { text: "" }, content: "" }),
    );
    expect(items).toEqual([]);
  });

  it("skips empty standalone reasoning", () => {
    const items = parseGrokChatHistory(
      lines({ type: "reasoning", summary: [{ type: "summary_text", text: "" }] }),
    );
    expect(items).toEqual([]);
  });

  it("parses tool calls and merges their tool_result", () => {
    const items = parseGrokChatHistory(
      lines(
        {
          type: "assistant",
          content: "",
          tool_calls: [
            { id: "call-1", name: "read_file", arguments: '{"target_file":"a.rs"}' },
          ],
        },
        { type: "tool_result", tool_call_id: "call-1", content: "file contents" },
      ),
    );
    expect(items).toHaveLength(1);
    const tool = items[0] as ClaudeChatItemToolUse;
    expect(tool.itemType).toBe("ToolUse");
    expect(tool.name).toBe("read_file");
    expect(tool.input).toEqual({ target_file: "a.rs" });
    expect(tool.result).toEqual({ content: "file contents", isError: false });
  });

  it("marks a tool result as errored when its id is in failedToolCallIds", () => {
    const input = lines(
      {
        type: "assistant",
        content: "",
        tool_calls: [{ id: "call-9", name: "read_file", arguments: '{"target_file":"x"}' }],
      },
      {
        type: "tool_result",
        tool_call_id: "call-9",
        content: "Failed to read file: path outside workspace",
      },
    );
    const ok = parseGrokChatHistory(input);
    expect((ok[0] as ClaudeChatItemToolUse).result).toEqual({
      content: "Failed to read file: path outside workspace",
      isError: false,
    });
    const failed = parseGrokChatHistory(input, new Set(["call-9"]));
    expect((failed[0] as ClaudeChatItemToolUse).result).toEqual({
      content: "Failed to read file: path outside workspace",
      isError: true,
    });
  });

  it("unwraps the use_tool MCP wrapper to mcp__<tool_name>", () => {
    const items = parseGrokChatHistory(
      lines({
        type: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-2",
            name: "use_tool",
            arguments: '{"tool_name":"filesystem__list_allowed_directories","tool_input":{"x":1}}',
          },
        ],
      }),
    );
    const tool = items[0] as ClaudeChatItemToolUse;
    expect(tool.name).toBe("mcp__filesystem__list_allowed_directories");
    expect(tool.input).toEqual({ x: 1 });
  });

  it("ignores malformed JSONL lines", () => {
    const items = parseGrokChatHistory([
      "{ not json",
      "",
      JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>hi</user_query>" }] }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ itemType: "UserMessage", content: "hi" });
  });

  it("preserves conversation order across a full turn", () => {
    const items = parseGrokChatHistory(
      lines(
        { type: "user", content: [{ type: "text", text: "<user_query>do it</user_query>" }] },
        {
          type: "assistant",
          reasoning: { text: "planning" },
          content: "on it",
          tool_calls: [{ id: "c1", name: "run_command", arguments: '{"command":"ls"}' }],
        },
        { type: "tool_result", tool_call_id: "c1", content: "ok" },
      ),
    );
    expect(items.map((i) => i.itemType)).toEqual([
      "UserMessage",
      "AssistantThinking",
      "AssistantText",
      "ToolUse",
    ]);
  });
});
