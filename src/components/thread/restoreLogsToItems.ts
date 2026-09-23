import type { SdkChatLogEntry } from "../../lib/commands";
import type {
  ClaudeChatItem,
  ClaudeChatItemAssistantThinking,
  ClaudeChatItemResultInfo,
  ClaudeChatItemToolUse,
} from "../../lib/types";

/**
 * Convert agent_log rows into renderable ClaudeChatItem[].
 * When a stored tool_result is followed by another tool_use, insert a hidden
 * ResultInfo boundary so reopened MLX chats preserve per-round tool grouping.
 */
export function restoreLogsToItems(logs: SdkChatLogEntry[]): ClaudeChatItem[] {
  const toolUseById = new Map<string, ClaudeChatItemToolUse>();
  const restored: ClaudeChatItem[] = [];
  let sawToolResultSinceBoundary = false;

  for (const log of logs) {
    if (log.direction === "Input") {
      sawToolResultSinceBoundary = false;
      restored.push({
        itemType: "UserMessage",
        content: log.content,
        timestamp: log.timestamp,
        uuid: `history-${log.id}`,
      });
    } else if (log.log_type === "tool_use") {
      if (sawToolResultSinceBoundary) {
        const boundary: ClaudeChatItemResultInfo = {
          itemType: "ResultInfo",
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          total_cost_usd: 0,
          num_turns: 0,
          session_id: log.thread_id,
          timestamp: log.timestamp,
          uuid: `history-boundary-${log.id}`,
        };
        restored.push(boundary);
        sawToolResultSinceBoundary = false;
      }
      try {
        const data = JSON.parse(log.content);
        const item: ClaudeChatItemToolUse = {
          itemType: "ToolUse",
          id: data.toolUseId ?? log.id,
          parentToolUseId: data.parentToolUseId ?? null,
          name: data.name ?? "unknown",
          input: data.input ?? {},
          timestamp: log.timestamp,
          uuid: `history-${log.id}`,
        };
        toolUseById.set(item.id, item);
        restored.push(item);
      } catch {
        // Malformed JSON — skip
      }
    } else if (log.log_type === "tool_result") {
      sawToolResultSinceBoundary = true;
      try {
        const data = JSON.parse(log.content);
        const toolUseId = data.toolUseId as string | undefined;
        if (toolUseId) {
          const parent = toolUseById.get(toolUseId);
          if (parent) {
            parent.result = {
              content:
                typeof data.content === "string"
                  ? data.content
                  : JSON.stringify(data.content ?? ""),
              isError: !!data.isError,
            };
          }
        }
      } catch {
        // Malformed JSON — skip
      }
    } else if (log.log_type === "thinking") {
      sawToolResultSinceBoundary = false;
      restored.push({
        itemType: "AssistantThinking",
        thinking: log.content,
        timestamp: log.timestamp,
        uuid: `history-${log.id}`,
      } as ClaudeChatItemAssistantThinking);
    } else {
      sawToolResultSinceBoundary = false;
      restored.push({
        itemType: "AssistantText",
        text: log.content,
        timestamp: log.timestamp,
        uuid: `history-${log.id}`,
      });
    }
  }

  const childIds = new Set<string>();
  for (const item of restored) {
    if (item.itemType === "ToolUse" && item.parentToolUseId) {
      const parent = toolUseById.get(item.parentToolUseId);
      if (parent) {
        const existing = parent.childTools ?? [];
        if (!existing.some((child) => child.toolId === item.id)) {
          parent.childTools = [
            ...existing,
            {
              name: item.name,
              toolId: item.id,
              input: item.input,
              result: item.result,
              pending: false,
            },
          ];
        }
        childIds.add(item.id);
      }
    }
  }

  return childIds.size > 0
    ? restored.filter((item) => !(item.itemType === "ToolUse" && childIds.has(item.id)))
    : restored;
}
