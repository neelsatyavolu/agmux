import { beforeEach, describe, expect, it } from "vitest";
import { useTaskViewStore } from "../taskViewStore";
import type { Task } from "../../lib/types";
import { clearLocalStorage } from "./setup";

const INITIAL = {
  tasks: {},
  selectedTaskId: null,
  activeAgentTabId: {},
  reviewSidebarOpen: false,
  reviewSidebarWidth: 280,
  fileTreeOpen: false,
  gitState: {},
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    project_id: "proj-1",
    name: "Task 1",
    branch_name: "feature/x",
    base_branch: "master",
    worktree_path: "/tmp/wt1",
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...(overrides as Partial<Task>),
  } as Task;
}

describe("taskViewStore (pure state actions)", () => {
  beforeEach(() => {
    clearLocalStorage();
    useTaskViewStore.setState(INITIAL, false);
  });

  it("getTaskById finds tasks across projects", () => {
    useTaskViewStore.getState().addTaskToStore(makeTask({ id: "a", project_id: "p1" }));
    useTaskViewStore.getState().addTaskToStore(makeTask({ id: "b", project_id: "p2" }));
    expect(useTaskViewStore.getState().getTaskById("b")?.id).toBe("b");
    expect(useTaskViewStore.getState().getTaskById("missing")).toBeUndefined();
  });

  it("selectTask sets selectedTaskId", () => {
    useTaskViewStore.getState().selectTask("task-1");
    expect(useTaskViewStore.getState().selectedTaskId).toBe("task-1");
  });

  it("clearSelection nulls selectedTaskId", () => {
    useTaskViewStore.getState().selectTask("task-1");
    useTaskViewStore.getState().clearSelection();
    expect(useTaskViewStore.getState().selectedTaskId).toBeNull();
  });

  it("setActiveAgent stores per-task thread id", () => {
    useTaskViewStore.getState().setActiveAgent("task-1", "thread-1");
    expect(useTaskViewStore.getState().activeAgentTabId["task-1"]).toBe("thread-1");
  });

  it("toggleReviewSidebar flips the open flag", () => {
    expect(useTaskViewStore.getState().reviewSidebarOpen).toBe(false);
    useTaskViewStore.getState().toggleReviewSidebar();
    expect(useTaskViewStore.getState().reviewSidebarOpen).toBe(true);
    useTaskViewStore.getState().toggleReviewSidebar();
    expect(useTaskViewStore.getState().reviewSidebarOpen).toBe(false);
  });

  it("setReviewSidebarWidth stores the width", () => {
    useTaskViewStore.getState().setReviewSidebarWidth(400);
    expect(useTaskViewStore.getState().reviewSidebarWidth).toBe(400);
  });

  it("toggleFileTree flips the file-tree flag", () => {
    useTaskViewStore.getState().toggleFileTree();
    expect(useTaskViewStore.getState().fileTreeOpen).toBe(true);
  });

  it("refreshGitState skips set when worktree state is unchanged", async () => {
    const { vi } = await import("vitest");
    const taskCommands = await import("../../lib/taskCommands");
    const task = makeTask({ id: "task-1", project_id: "p1" });
    useTaskViewStore.getState().addTaskToStore(task);

    const files = [
      { path: "src/a.ts", added: 1, removed: 0, status: "M" },
    ];
    const aheadBehind = { ahead: 0, behind: 0, has_upstream: true };
    vi.spyOn(taskCommands, "getWorktreeChanges").mockResolvedValue(files as never);
    vi.spyOn(taskCommands, "getWorktreeAheadBehind").mockResolvedValue(aheadBehind as never);

    await useTaskViewStore.getState().refreshGitState("task-1");
    const first = useTaskViewStore.getState().gitState["task-1"];
    expect(first).toBeDefined();

    await useTaskViewStore.getState().refreshGitState("task-1");
    const second = useTaskViewStore.getState().gitState["task-1"];
    // Same object reference → no React subscribers re-render from identity churn.
    expect(second).toBe(first);
  });

  it("addTaskToStore prepends to its project's task list", () => {
    useTaskViewStore.getState().addTaskToStore(makeTask({ id: "a", project_id: "p1" }));
    useTaskViewStore.getState().addTaskToStore(makeTask({ id: "b", project_id: "p1" }));
    const list = useTaskViewStore.getState().tasks["p1"]!;
    expect(list.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("updateTaskInStore replaces the matching task immutably", () => {
    useTaskViewStore.getState().addTaskToStore(makeTask({ id: "a", project_id: "p1", name: "old" }));
    useTaskViewStore.getState().updateTaskInStore(makeTask({ id: "a", project_id: "p1", name: "new" }));
    const t = useTaskViewStore.getState().getTaskById("a");
    expect(t?.name).toBe("new");
  });

  it("removeTaskFromStore drops the task and its agent tab and clears selection if matching", () => {
    useTaskViewStore.getState().addTaskToStore(makeTask({ id: "a", project_id: "p1" }));
    useTaskViewStore.getState().setActiveAgent("a", "thread-x");
    useTaskViewStore.getState().selectTask("a");
    useTaskViewStore.getState().removeTaskFromStore("a", "p1");
    const s = useTaskViewStore.getState();
    expect(s.tasks["p1"]).toEqual([]);
    expect(s.activeAgentTabId["a"]).toBeUndefined();
    expect(s.selectedTaskId).toBeNull();
  });

  it("removeTaskFromStore preserves selection if it doesn't match", () => {
    useTaskViewStore.getState().addTaskToStore(makeTask({ id: "a", project_id: "p1" }));
    useTaskViewStore.getState().addTaskToStore(makeTask({ id: "b", project_id: "p1" }));
    useTaskViewStore.getState().selectTask("b");
    useTaskViewStore.getState().removeTaskFromStore("a", "p1");
    expect(useTaskViewStore.getState().selectedTaskId).toBe("b");
  });

  it("fetchTasks does not clear a selection owned by another project", async () => {
    const { vi } = await import("vitest");
    const taskCommands = await import("../../lib/taskCommands");
    useTaskViewStore.setState({ selectedTaskId: "keep", tasks: {} }, false);
    vi.spyOn(taskCommands, "getTasks").mockResolvedValueOnce([]);
    await useTaskViewStore.getState().fetchTasks("p1");
    expect(useTaskViewStore.getState().selectedTaskId).toBe("keep");
    expect(useTaskViewStore.getState().tasks.p1).toEqual([]);
  });

  it("discoverWorktrees matches custom root + branch-first layout (M15)", async () => {
    const { vi } = await import("vitest");
    const taskCommands = await import("../../lib/taskCommands");
    const settingsStore = await import("../settingsStore");

    // Absolute root — avoid spying on ESM `homeDir` (not configurable in vitest).
    settingsStore.useSettingsStore.getState().updateSettings({
      worktreeRoot: "/Users/test/custom-wts",
      worktreeBranchFirst: true,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(taskCommands, "listWorktrees").mockResolvedValue([
      {
        path: "/Users/test/custom-wts/feature-x/my-app",
        head: "abc",
        branch: "refs/heads/feature-x",
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        // repo-first layout — should not match when branch-first is on
        path: "/Users/test/custom-wts/my-app/feature-y",
        head: "def",
        branch: "refs/heads/feature-y",
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: "/tmp/repo",
        head: "ghi",
        branch: "refs/heads/main",
        bare: false,
        locked: false,
        prunable: false,
      },
    ] as never);

    await useTaskViewStore
      .getState()
      .discoverWorktrees("proj-1", "My App", "/tmp/repo");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(
      /Orphan xanom worktree at \/Users\/test\/custom-wts\/feature-x\/my-app/,
    );
    warn.mockRestore();
  });
});
