import { shortenPath } from "./tools/types";
import type {
  ClaudeChatItem,
  ClaudeChatItemToolUse,
  TurnFileChange,
} from "../../lib/types";
import { toolDiffStats } from "../../lib/toolDiffStats";
import { isSubagentTool } from "../../lib/subagentConversations";

// File-mutating tools must render as individual inline diffs (never collapsed
// into a ToolGroup) and feed computeTurnChanges. Includes Claude PascalCase,
// Grok snake_case, OpenCode/Cursor lowercase, and MLX variants.
export const EDIT_TOOL_NAMES = new Set([
  "Edit", "edit_file", "mcp__filesystem__edit_file",
  "ApplyPatch", "apply_patch", "apply_patch_freeform",
  "search_replace",
  "edit", "multiedit", "multi_edit", "edit_lines",
  "patch", "applyAgentDiff",
]);
export const WRITE_TOOL_NAMES = new Set(["Write", "write_file", "mcp__filesystem__write_file", "write"]);
export const DELETE_TOOL_NAMES = new Set(["delete"]);
export const AGENT_TOOL_NAMES = new Set(["Agent", "Task"]);
// "todo_write" is Grok's snake_case TodoWrite — it may carry a `merge` flag
// (handled in computeStickyTodos). "todowrite"/"todoread" are OpenCode lowercase.
export const TODO_TOOL_NAMES = new Set([
  "TodoWrite",
  "TodoRead",
  "todo_write",
  "todowrite",
  "todoread",
]);
// claude-agent-sdk ≥0.3.142 emits these task-management tools in place of TodoWrite.
// They are accumulated by task id rather than snapshot-replaced.
export const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskUpdate", "TaskGet", "TaskList"]);

function computeTurnChanges(
  tools: ClaudeChatItemToolUse[],
  workDir?: string | null,
): TurnFileChange[] {
  const fileMap = new Map<string, TurnFileChange>();

  for (const tool of tools) {
    const stats = toolDiffStats(tool.name, tool.input, tool.result);
    if (!stats?.path) continue;

    if (EDIT_TOOL_NAMES.has(tool.name) || DELETE_TOOL_NAMES.has(tool.name)) {
      const existing = fileMap.get(stats.path);
      if (existing) {
        fileMap.set(stats.path, {
          ...existing,
          additions: existing.additions + stats.added,
          deletions: existing.deletions + stats.removed,
        });
      } else {
        fileMap.set(stats.path, {
          filePath: stats.path,
          shortPath: shortenPath(stats.path, workDir),
          action: "edited",
          additions: stats.added,
          deletions: stats.removed,
        });
      }
    } else if (WRITE_TOOL_NAMES.has(tool.name)) {
      fileMap.set(stats.path, {
        filePath: stats.path,
        shortPath: shortenPath(stats.path, workDir),
        action: "created",
        additions: stats.added,
        deletions: stats.removed,
      });
    }
  }

  return Array.from(fileMap.values());
}

/**
 * Group consecutive ToolUse items into ToolGroup items (2+ consecutive),
 * and attach turnChanges to ResultInfo items.
 */
export function groupMessages(
  items: ClaudeChatItem[],
  workDir?: string | null,
): ClaudeChatItem[] {
  const result: ClaudeChatItem[] = [];
  let currentGroup: ClaudeChatItemToolUse[] = [];
  let turnTools: ClaudeChatItemToolUse[] = [];

  function flushGroup() {
    if (currentGroup.length === 0) return;
    if (currentGroup.length === 1) {
      result.push(currentGroup[0]);
    } else {
      result.push({
        itemType: "ToolGroup" as const,
        tools: currentGroup,
        timestamp: currentGroup[0].timestamp,
        uuid: currentGroup[0].uuid,
      });
    }
    currentGroup = [];
  }

  const GROUP_GAP_MS = 3000;

  for (const item of items) {
    if (item.itemType === "ToolUse") {
      const isIndividual =
        EDIT_TOOL_NAMES.has(item.name) ||
        WRITE_TOOL_NAMES.has(item.name) ||
        DELETE_TOOL_NAMES.has(item.name) ||
        isSubagentTool(item.name) ||
        TODO_TOOL_NAMES.has(item.name) ||
        TASK_TOOL_NAMES.has(item.name);

      if (isIndividual) {
        flushGroup();
        result.push(item);
      } else {
        if (currentGroup.length > 0) {
          const prev = currentGroup[currentGroup.length - 1];
          const prevMs = Date.parse(prev.timestamp);
          const curMs = Date.parse(item.timestamp);
          if (Number.isFinite(prevMs) && Number.isFinite(curMs) && curMs - prevMs > GROUP_GAP_MS) {
            flushGroup();
          }
        }
        currentGroup.push(item);
      }

      turnTools.push(item);
    } else {
      flushGroup();

      if (item.itemType === "ResultInfo") {
        const changes = computeTurnChanges(turnTools, workDir);
        result.push(changes.length > 0 ? { ...item, turnChanges: changes } : item);
        turnTools = [];
      } else {
        result.push(item);
      }
    }
  }

  flushGroup();

  for (let i = 1; i < result.length; i++) {
    if (result[i].itemType === "AssistantThinking" && result[i - 1].itemType === "AssistantText") {
      const tmp = result[i - 1];
      result[i - 1] = result[i];
      result[i] = tmp;
    }
  }

  return result;
}
