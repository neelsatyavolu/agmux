// Derive the chat Tasks panel list from a message stream.
//
// Three input shapes are folded into one ordered TodoBarItem[]:
//   1. Claude / OpenCode TodoWrite — `input.todos` is a full snapshot; each
//      call replaces the previous list.
//   2. Grok todo_write — same `input.todos` shape, but may carry `merge: true`,
//      a partial update folded into the running snapshot by id (Claude/OpenCode
//      never set `merge`, so they always take the snapshot-replace branch).
//   3. claude-agent-sdk ≥0.3.142 TaskCreate / TaskUpdate / TaskList —
//      accumulate-by-id semantics: TaskCreate adds an entry (id comes from the
//      tool result), TaskUpdate mutates fields, TaskList is an authoritative
//      snapshot, status "deleted" removes the entry. Task tools win over
//      TodoWrite when both appear in the same stream.
//
// Rendered by ChatTasksPanel (right-side floating panel) on all chat surfaces.

import type { ClaudeChatItem } from "../../lib/types";
import type { TodoBarItem } from "./ChatTasksPanel";
import { TODO_TOOL_NAMES, TASK_TOOL_NAMES } from "./groupMessages";

const STATUSES = new Set(["pending", "in_progress", "completed"]);

function normalizeStatus(
  s: unknown,
  fallback: TodoBarItem["status"] = "pending",
): TodoBarItem["status"] {
  return typeof s === "string" && STATUSES.has(s) ? (s as TodoBarItem["status"]) : fallback;
}

function tryParseJson<T>(s: string | undefined | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** Parse a `todos` array into ordered TodoBarItems. */
function parseTodoSnapshot(raw: unknown): TodoBarItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is Record<string, unknown> => t != null && typeof t === "object")
    .map((t, idx) => ({
      id: String(t.id ?? idx),
      content: String(t.content ?? ""),
      status: normalizeStatus(t.status),
    }));
}

/** Fold a partial todo update into the running snapshot by id, preserving order. */
function mergeTodos(base: TodoBarItem[], update: TodoBarItem[]): TodoBarItem[] {
  const byId = new Map(base.map((t) => [t.id, t]));
  for (const t of update) byId.set(t.id, t);
  return Array.from(byId.values());
}

export function computeStickyTodos(messages: ClaudeChatItem[]): TodoBarItem[] {
  let todoSnapshot: TodoBarItem[] | null = null;
  const taskMap = new Map<string, TodoBarItem>();
  let hasTaskTool = false;

  for (const item of messages) {
    if (item.itemType !== "ToolUse") continue;
    const input = (item.input ?? {}) as Record<string, unknown>;

    if (TODO_TOOL_NAMES.has(item.name)) {
      if (!Array.isArray(input.todos)) continue;
      const parsed = parseTodoSnapshot(input.todos);
      // Grok's todo_write may set merge:true — fold the partial update into
      // the running snapshot instead of replacing it.
      todoSnapshot =
        input.merge === true && todoSnapshot
          ? mergeTodos(todoSnapshot, parsed)
          : parsed;
      continue;
    }

    if (!TASK_TOOL_NAMES.has(item.name)) continue;
    hasTaskTool = true;

    if (item.name === "TaskCreate") {
      // TaskCreateOutput shape: { task: { id, subject } }
      const parsed = tryParseJson<{ task?: { id?: unknown; subject?: unknown } }>(item.result?.content);
      const taskId = parsed?.task && typeof parsed.task.id === "string" && parsed.task.id
        ? parsed.task.id
        : `pending-${item.id}`;
      taskMap.set(taskId, {
        id: taskId,
        content: String(input.subject ?? input.description ?? ""),
        status: "pending",
      });
    } else if (item.name === "TaskUpdate") {
      const taskId = typeof input.taskId === "string" ? input.taskId : "";
      if (!taskId) continue;
      const statusRaw = typeof input.status === "string" ? input.status : "";
      if (statusRaw === "deleted") {
        taskMap.delete(taskId);
        continue;
      }
      const existing = taskMap.get(taskId) ?? { id: taskId, content: "", status: "pending" as const };
      taskMap.set(taskId, {
        ...existing,
        content: typeof input.subject === "string" ? input.subject : existing.content,
        status: normalizeStatus(statusRaw, existing.status),
      });
    } else if (item.name === "TaskList") {
      // TaskListOutput shape: { tasks: Array<{ id, subject, status, ... }> }
      const parsed = tryParseJson<{ tasks?: unknown }>(item.result?.content);
      if (parsed && Array.isArray(parsed.tasks)) {
        taskMap.clear();
        for (const t of parsed.tasks) {
          if (!t || typeof t !== "object") continue;
          const row = t as Record<string, unknown>;
          const id = typeof row.id === "string" ? row.id : null;
          if (!id) continue;
          taskMap.set(id, {
            id,
            content: typeof row.subject === "string" ? row.subject : "",
            status: normalizeStatus(row.status),
          });
        }
      }
    }
    // TaskGet is read-only and emits no state change.
  }

  return hasTaskTool ? Array.from(taskMap.values()) : (todoSnapshot ?? []);
}
