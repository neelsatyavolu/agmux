// Parse Grok's on-disk `chat_history.jsonl` transcript into the shared
// `ClaudeChatItem[]` shape so the SDK chat view can rehydrate a Grok
// conversation after an app restart (the live SDK event stream is gone by
// then). This is Grok's analog of `readClaudeSessionHistory` for Claude.
//
// Grok `chat_history.jsonl` entry types:
//   { type: "system",  content }                        — skip (system prompt)
//   { type: "user",    content, synthetic_reason? }      — real turn iff no
//       synthetic_reason AND the text is wrapped in <user_query>…</user_query>
//   { type: "reasoning", summary: [{type:"summary_text", text}] } — thinking
//   { type: "assistant", content, reasoning?, tool_calls? }
//   { type: "tool_result", tool_call_id, content }       — merged into ToolUse

import type {
  ClaudeChatItem,
  ClaudeChatItemToolUse,
} from "./types";

interface GrokEntry {
  type?: string;
  content?: unknown;
  synthetic_reason?: unknown;
  reasoning?: unknown;
  /** Standalone reasoning lines: [{ type: "summary_text", text }] */
  summary?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  text?: unknown;
}

interface GrokToolCall {
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

/** Concatenate the text of a Grok `content` field (string or text-block array). */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
        ? (b as { text: string }).text
        : ""))
      .join("");
  }
  return "";
}

/**
 * Grok first-turn memory preamble is glued onto the real user text (ACP has no
 * system-prompt slot). Strip it so chat history only shows the user turn.
 * Matches `memory::strip_first_turn_memory_preamble` on the Rust side.
 */
export function stripFirstTurnMemoryPreamble(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const mark = "--- agmux:user ---";
  const idx = t.indexOf(mark);
  if (idx >= 0) return t.slice(idx + mark.length).trimStart();
  // Legacy delimiter used before the explicit mark.
  if (
    t.startsWith("[agmux project memory") ||
    t.includes("agmux project memory — REQUIRED")
  ) {
    const legacy = "\n\n---\n\n";
    const i = t.indexOf(legacy);
    if (i >= 0) return t.slice(i + legacy.length).trimStart();
  }
  return t;
}

/** Pull the real user prompt out of Grok's `<user_query>…</user_query>` wrapper. */
function extractUserQuery(text: string): string | null {
  const match = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  if (!match) return null;
  const q = stripFirstTurnMemoryPreamble(match[1]).trim();
  return q || null;
}

/**
 * Pull thinking text from a Grok reasoning payload.
 * Matches remote `extract_reasoning_summary`:
 *   - standalone `{ type: "reasoning", summary: [{ type: "summary_text", text }] }`
 *   - nested `assistant.reasoning: { text }` / string / summary[]
 */
function extractReasoning(entry: {
  summary?: unknown;
  reasoning?: unknown;
  content?: unknown;
  text?: unknown;
}): string {
  // summary: [{ type: "summary_text"|"text", text }]
  if (Array.isArray(entry.summary)) {
    return entry.summary
      .map((b) => {
        if (!b || typeof b !== "object") return "";
        const block = b as { type?: unknown; text?: unknown };
        const typ = typeof block.type === "string" ? block.type : "";
        if (typ === "summary_text" || typ === "text") {
          return typeof block.text === "string" ? block.text : "";
        }
        return "";
      })
      .join("");
  }
  // Nested object: { text } or { summary: [...] }
  const reasoning = entry.reasoning;
  if (typeof reasoning === "string") return reasoning;
  if (reasoning && typeof reasoning === "object") {
    const r = reasoning as { text?: unknown; summary?: unknown };
    if (typeof r.text === "string" && r.text) return r.text;
    if (Array.isArray(r.summary)) {
      return extractReasoning({ summary: r.summary });
    }
    // Some shapes put the body on content/text inside reasoning
    const nested = extractText((r as { content?: unknown }).content ?? r.text);
    if (nested) return nested;
  }
  // Top-level text / content fallback (standalone reasoning lines)
  if (typeof entry.text === "string" && entry.text) return entry.text;
  return extractText(entry.content);
}

/** Parse a Grok tool call into a Claude-style `(name, input)` pair. */
function parseToolCall(tc: GrokToolCall): { name: string; input: Record<string, unknown> } {
  const rawName =
    (typeof tc.name === "string" && tc.name) ||
    (typeof tc.function?.name === "string" && tc.function.name) ||
    "tool";
  const rawArgs = tc.arguments ?? tc.function?.arguments;
  let input: Record<string, unknown> = {};
  if (typeof rawArgs === "string") {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
    } catch {
      /* malformed arguments — render with empty input */
    }
  } else if (rawArgs && typeof rawArgs === "object") {
    input = rawArgs as Record<string, unknown>;
  }
  // Grok's `use_tool` wraps the real MCP tool as { tool_name, tool_input } —
  // unwrap it so history matches the live event mapper's behavior.
  if (rawName === "use_tool" && typeof input.tool_name === "string") {
    const toolInput = input.tool_input;
    return {
      name: `mcp__${input.tool_name}`,
      input: toolInput && typeof toolInput === "object" ? (toolInput as Record<string, unknown>) : {},
    };
  }
  return { name: rawName, input };
}

/**
 * Parse raw `chat_history.jsonl` lines into renderable chat items. Tool results
 * are merged into their originating `ToolUse` so callers get a flat, ordered
 * list of UserMessage / AssistantThinking / AssistantText / ToolUse items.
 *
 * `failedToolCallIds` (from `updates.jsonl`) marks which tool results errored —
 * `chat_history.jsonl` itself has no per-result error flag.
 */
export function parseGrokChatHistory(
  lines: string[],
  failedToolCallIds: ReadonlySet<string> = new Set(),
): ClaudeChatItem[] {
  const items: ClaudeChatItem[] = [];
  const toolUseByCallId = new Map<string, ClaudeChatItemToolUse>();
  // Synthetic but stable per-line timestamps preserve ordering under any
  // timestamp-based sort (chat_history.jsonl has no per-entry timestamps).
  const baseTime = Date.now() - lines.length;
  const ts = (i: number) => new Date(baseTime + i).toISOString();

  lines.forEach((line, i) => {
    let entry: GrokEntry;
    try {
      entry = JSON.parse(line) as GrokEntry;
    } catch {
      return;
    }
    const timestamp = ts(i);

    switch (entry.type) {
      case "user": {
        if (entry.synthetic_reason != null) return; // injected context, not a turn
        const query = extractUserQuery(extractText(entry.content));
        if (!query) return; // env/context block — not a real user message
        items.push({
          itemType: "UserMessage",
          content: query,
          timestamp,
          uuid: `grok-hist-${i}-user`,
        });
        return;
      }
      case "reasoning": {
        // Standalone thinking line (Grok terminal / chat_history.jsonl):
        // { type: "reasoning", summary: [{ type: "summary_text", text }] }
        const thinking = extractReasoning(entry);
        if (thinking.trim()) {
          items.push({
            itemType: "AssistantThinking",
            thinking,
            timestamp,
            uuid: `grok-hist-${i}-think`,
          });
        }
        return;
      }
      case "assistant": {
        // Nested assistant.reasoning: { text } | string | summary[]
        const thinking = extractReasoning({ reasoning: entry.reasoning });
        if (thinking.trim()) {
          items.push({
            itemType: "AssistantThinking",
            thinking,
            timestamp,
            uuid: `grok-hist-${i}-think`,
          });
        }
        const text = extractText(entry.content);
        if (text.trim()) {
          items.push({
            itemType: "AssistantText",
            text,
            timestamp,
            uuid: `grok-hist-${i}-text`,
          });
        }
        if (Array.isArray(entry.tool_calls)) {
          entry.tool_calls.forEach((raw, j) => {
            const tc = raw as GrokToolCall;
            const id = typeof tc.id === "string" ? tc.id : `grok-hist-${i}-${j}`;
            const { name, input } = parseToolCall(tc);
            const item: ClaudeChatItemToolUse = {
              itemType: "ToolUse",
              id,
              name,
              input,
              timestamp,
              uuid: `grok-hist-tool-${id}`,
            };
            items.push(item);
            toolUseByCallId.set(id, item);
          });
        }
        return;
      }
      case "tool_result": {
        const callId = typeof entry.tool_call_id === "string" ? entry.tool_call_id : null;
        if (!callId) return;
        const parent = toolUseByCallId.get(callId);
        if (parent && !parent.result) {
          parent.result = {
            content: extractText(entry.content),
            isError: failedToolCallIds.has(callId),
          };
        }
        return;
      }
      default:
        return; // "system" and any unknown types are not rendered
    }
  });

  return items;
}
