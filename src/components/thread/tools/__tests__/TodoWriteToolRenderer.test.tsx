/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TodoWriteToolRenderer } from "../TodoWriteToolRenderer";

afterEach(() => cleanup());

function renderTodos(input: Record<string, unknown>) {
  return render(
    <TodoWriteToolRenderer
      input={input}
      result={null}
      isError={false}
      isPending={false}
    />,
  );
}

describe("TodoWriteToolRenderer", () => {
  it("shows 'Empty to-do list' when there are no todos", () => {
    renderTodos({ todos: [] });
    expect(screen.getByText("Empty to-do list")).toBeTruthy();
  });

  it("shows 'Empty to-do list' when todos field is missing", () => {
    renderTodos({});
    expect(screen.getByText("Empty to-do list")).toBeTruthy();
  });

  it("ignores non-array todos field", () => {
    renderTodos({ todos: "not an array" });
    expect(screen.getByText("Empty to-do list")).toBeTruthy();
  });

  it("renders counts as 'completed/total completed'", () => {
    renderTodos({
      todos: [
        { id: "1", content: "a", status: "completed" },
        { id: "2", content: "b", status: "pending" },
        { id: "3", content: "c", status: "completed" },
      ],
    });
    expect(screen.getByText("2/3 completed")).toBeTruthy();
  });

  it("renders a 'done' badge when all todos are completed", () => {
    renderTodos({
      todos: [
        { id: "1", content: "a", status: "completed" },
        { id: "2", content: "b", status: "completed" },
      ],
    });
    expect(screen.getByText("done")).toBeTruthy();
  });

  it("renders an '<N> active' badge when tasks are in progress", () => {
    renderTodos({
      todos: [
        { id: "1", content: "a", status: "in_progress" },
        { id: "2", content: "b", status: "in_progress" },
        { id: "3", content: "c", status: "pending" },
      ],
    });
    expect(screen.getByText("2 active")).toBeTruthy();
  });

  it("renders each todo's content text", () => {
    renderTodos({
      todos: [
        { id: "1", content: "write tests", status: "pending" },
        { id: "2", content: "ship feature", status: "completed" },
      ],
    });
    expect(screen.getByText("write tests")).toBeTruthy();
    expect(screen.getByText("ship feature")).toBeTruthy();
  });

  it("defaults unknown status values to 'pending'", () => {
    renderTodos({
      todos: [{ id: "1", content: "x", status: "frobbed" }],
    });
    // Should show 0 completed (not blow up on the unknown status)
    expect(screen.getByText("0/1 completed")).toBeTruthy();
  });

  it("filters out null/non-object entries without crashing", () => {
    renderTodos({
      todos: [
        null,
        "string",
        { id: "1", content: "real", status: "completed" },
      ],
    });
    expect(screen.getByText("1/1 completed")).toBeTruthy();
    expect(screen.getByText("real")).toBeTruthy();
  });

  it("coerces non-string id and content to strings", () => {
    renderTodos({
      todos: [{ id: 42, content: 7, status: "pending" }],
    });
    expect(screen.getByText("7")).toBeTruthy();
  });
});
