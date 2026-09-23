import { describe, it, expect } from "vitest";
import { computeStickyTodos } from "../stickyTodos";
import type { ClaudeChatItem } from "../../../lib/types";

let seq = 0;
function toolUse(
  name: string,
  input: Record<string, unknown>,
  result?: { content: string; isError: boolean },
): ClaudeChatItem {
  seq += 1;
  return {
    itemType: "ToolUse",
    id: `t${seq}`,
    name,
    input,
    timestamp: new Date(seq).toISOString(),
    uuid: `u${seq}`,
    ...(result ? { result } : {}),
  };
}

function text(t: string): ClaudeChatItem {
  seq += 1;
  return { itemType: "AssistantText", text: t, timestamp: new Date(seq).toISOString(), uuid: `u${seq}` };
}

describe("computeStickyTodos", () => {
  it("returns [] when there are no todo/task tools", () => {
    expect(computeStickyTodos([text("hello"), toolUse("Read", { file_path: "/a" })])).toEqual([]);
  });

  it("Claude TodoWrite — the latest snapshot replaces earlier ones", () => {
    const todos = computeStickyTodos([
      toolUse("TodoWrite", { todos: [{ id: "1", content: "a", status: "pending" }] }),
      toolUse("TodoWrite", {
        todos: [
          { id: "1", content: "a", status: "completed" },
          { id: "2", content: "b", status: "in_progress" },
        ],
      }),
    ]);
    expect(todos).toEqual([
      { id: "1", content: "a", status: "completed" },
      { id: "2", content: "b", status: "in_progress" },
    ]);
  });

  it("Grok todo_write — surfaces in the sticky list (snake_case name)", () => {
    const todos = computeStickyTodos([
      toolUse("todo_write", {
        todos: [{ id: "1", content: "step one", status: "in_progress" }],
      }),
    ]);
    expect(todos).toEqual([{ id: "1", content: "step one", status: "in_progress" }]);
  });

  it("OpenCode todowrite — lowercase name feeds the Tasks panel", () => {
    const todos = computeStickyTodos([
      toolUse("todowrite", {
        todos: [{ id: "1", content: "ship panel", status: "pending" }],
      }),
    ]);
    expect(todos).toEqual([{ id: "1", content: "ship panel", status: "pending" }]);
  });

  it("Grok todo_write merge:true — folds a partial update into the running snapshot by id", () => {
    const todos = computeStickyTodos([
      toolUse("todo_write", {
        merge: false,
        todos: [
          { id: "1", content: "a", status: "pending" },
          { id: "2", content: "b", status: "pending" },
          { id: "3", content: "c", status: "pending" },
        ],
      }),
      toolUse("todo_write", {
        merge: true,
        todos: [{ id: "2", content: "b", status: "completed" }],
      }),
    ]);
    // id 1 and 3 are preserved despite the partial update; order is kept.
    expect(todos).toEqual([
      { id: "1", content: "a", status: "pending" },
      { id: "2", content: "b", status: "completed" },
      { id: "3", content: "c", status: "pending" },
    ]);
  });

  it("Grok todo_write merge:true appends ids not seen before", () => {
    const todos = computeStickyTodos([
      toolUse("todo_write", { merge: false, todos: [{ id: "1", content: "a", status: "pending" }] }),
      toolUse("todo_write", { merge: true, todos: [{ id: "2", content: "b", status: "in_progress" }] }),
    ]);
    expect(todos).toEqual([
      { id: "1", content: "a", status: "pending" },
      { id: "2", content: "b", status: "in_progress" },
    ]);
  });

  it("Grok todo_write merge:true as the first call is treated as a full snapshot", () => {
    const todos = computeStickyTodos([
      toolUse("todo_write", { merge: true, todos: [{ id: "1", content: "a", status: "pending" }] }),
    ]);
    expect(todos).toEqual([{ id: "1", content: "a", status: "pending" }]);
  });

  it("Grok todo_write merge:false after merges performs a full replace", () => {
    const todos = computeStickyTodos([
      toolUse("todo_write", { merge: false, todos: [{ id: "1", content: "a", status: "pending" }] }),
      toolUse("todo_write", { merge: true, todos: [{ id: "1", content: "a", status: "completed" }] }),
      toolUse("todo_write", { merge: false, todos: [{ id: "9", content: "fresh", status: "pending" }] }),
    ]);
    expect(todos).toEqual([{ id: "9", content: "fresh", status: "pending" }]);
  });

  it("normalizes unknown statuses to pending", () => {
    const todos = computeStickyTodos([
      toolUse("todo_write", { todos: [{ id: "1", content: "a", status: "cancelled" }] }),
    ]);
    expect(todos).toEqual([{ id: "1", content: "a", status: "pending" }]);
  });

  it("Task tools still accumulate by id and win over TodoWrite", () => {
    const todos = computeStickyTodos([
      toolUse("TodoWrite", { todos: [{ id: "x", content: "todo", status: "pending" }] }),
      toolUse("TaskCreate", { subject: "design" }, { content: JSON.stringify({ task: { id: "T1" } }), isError: false }),
      toolUse("TaskUpdate", { taskId: "T1", status: "in_progress" }),
    ]);
    expect(todos).toEqual([{ id: "T1", content: "design", status: "in_progress" }]);
  });
});
