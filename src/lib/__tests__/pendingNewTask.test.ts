/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  setPendingNewTask,
  takePendingNewTask,
  dispatchNewTaskEvent,
} from "../pendingNewTask";

beforeEach(() => {
  // Drain any leftover pending from prior tests.
  takePendingNewTask();
});

afterEach(() => {
  takePendingNewTask();
  vi.restoreAllMocks();
});

describe("pendingNewTask", () => {
  it("stores and clears a project-scoped pending open", () => {
    setPendingNewTask("proj-1");
    expect(takePendingNewTask()).toEqual({ projectId: "proj-1" });
    expect(takePendingNewTask()).toBeNull();
  });

  it("allows null projectId (open picker without preselect)", () => {
    setPendingNewTask(null);
    expect(takePendingNewTask()).toEqual({ projectId: null });
  });

  it("dispatchNewTaskEvent fires xanom-new-task with detail", () => {
    const spy = vi.fn();
    window.addEventListener("agmux-new-task", spy);
    dispatchNewTaskEvent("proj-2");
    expect(spy).toHaveBeenCalledTimes(1);
    const ev = spy.mock.calls[0][0] as CustomEvent<{ projectId: string | null }>;
    expect(ev.detail).toEqual({ projectId: "proj-2" });
    window.removeEventListener("agmux-new-task", spy);
  });
});
