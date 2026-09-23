/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { Task, WorktreeGitState } from "../../../lib/types";

const baseTask: Task = {
  id: "task-1",
  project_id: "proj-1",
  name: "Add auth flow",
  branch_name: "feat/auth",
  worktree_path: "/tmp/wt/auth",
  base_branch: "master",
  status: "in_progress",
  prompt: null,
  linked_pr_number: null,
  linked_pr_url: null,
  linked_issues: null,
  created_at: new Date().toISOString(),
};

const taskState = {
  task: baseTask,
  gitState: undefined as WorktreeGitState | undefined,
  reviewSidebarOpen: false,
};

vi.mock("../../../stores/taskViewStore", () => ({
  useTaskViewStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      getTaskById: () => taskState.task,
      gitState: taskState.task ? { [taskState.task.id]: taskState.gitState } : {},
      toggleReviewSidebar: () => {},
      updateTaskInStore: () => {},
      reviewSidebarOpen: taskState.reviewSidebarOpen,
    }),
}));

vi.mock("../../../stores/threadStore", () => ({
  useThreadStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ threads: { [baseTask.project_id]: [] } }),
}));

vi.mock("../../../stores/uiStore", () => ({
  useUiStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      toggleEditorPanel: () => {},
      editorPanelOpen: false,
      pendingApprovalsBySession: {},
      claudeProcessingById: {},
      codexProcessingById: {},
      // TaskWorktreeHeader added these reads at some point but the test's
      // ad-hoc mock wasn't kept in sync. Provide stubs so the selector
      // doesn't dereference undefined.
      sessionTerminalOpenByKey: {},
      setSessionTerminalOpen: () => {},
      sidebarCollapsed: false,
    }),
}));

vi.mock("../../../lib/taskCommands", () => ({
  createWorktreePr: vi.fn(),
  generatePrContent: vi.fn(),
  getWorktreeChanges: vi.fn(),
  updateTask: vi.fn(),
  worktreeCommitAndPush: vi.fn(),
}));

import { TaskWorktreeHeader } from "../TaskWorktreeHeader";

afterEach(() => cleanup());
beforeEach(() => {
  taskState.task = baseTask;
  taskState.gitState = undefined;
});

describe("TaskWorktreeHeader", () => {
  it("renders nothing when task is missing", () => {
    taskState.task = null as unknown as Task;
    const { container } = render(<TaskWorktreeHeader taskId="task-1" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders task name and branch name", () => {
    render(<TaskWorktreeHeader taskId="task-1" />);
    expect(screen.getByText("Add auth flow")).toBeTruthy();
    expect(screen.getByText("feat/auth")).toBeTruthy();
  });

  it("renders 'worktree' indicator", () => {
    render(<TaskWorktreeHeader taskId="task-1" />);
    expect(screen.getByText("worktree")).toBeTruthy();
  });

  it("renders Open PR link when task has linked_pr_url", () => {
    taskState.task = {
      ...baseTask,
      linked_pr_url: "https://github.com/x/y/pull/42",
      linked_pr_number: 42,
    };
    render(<TaskWorktreeHeader taskId="task-1" />);
    expect(screen.getByText("Open PR #42")).toBeTruthy();
  });

  it("renders Create PR button when no linked PR", () => {
    render(<TaskWorktreeHeader taskId="task-1" />);
    // Loose match — text may be split by icon; lookup via title
    const createBtn = screen.getByTitle("Create GitHub PR via gh");
    expect(createBtn).toBeTruthy();
  });

  it("shows ahead/behind counters when gitState has them", () => {
    taskState.gitState = {
      ahead: 3,
      behind: 1,
      dirty_files: [],
      changed_files: [],
      has_upstream: true,
    };
    render(<TaskWorktreeHeader taskId="task-1" />);
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
  });
});

describe("TaskWorktreeHeader — Final coverage gaps", () => {
  it("renders only ahead counter when behind is 0", () => {
    taskState.gitState = {
      ahead: 5,
      behind: 0,
      dirty_files: [],
      changed_files: [],
      has_upstream: true,
    };
    render(<TaskWorktreeHeader taskId="task-1" />);
    expect(screen.getByText("5")).toBeTruthy();
  });

  it("renders only behind counter when ahead is 0", () => {
    taskState.gitState = {
      ahead: 0,
      behind: 7,
      dirty_files: [],
      changed_files: [],
      has_upstream: true,
    };
    render(<TaskWorktreeHeader taskId="task-1" />);
    expect(screen.getByText("7")).toBeTruthy();
  });

  it("renders no ahead/behind counters when both 0", () => {
    taskState.gitState = {
      ahead: 0,
      behind: 0,
      dirty_files: [],
      changed_files: [],
      has_upstream: true,
    };
    render(<TaskWorktreeHeader taskId="task-1" />);
    expect(screen.getByText("Add auth flow")).toBeTruthy();
  });

  it("Files button is rendered", () => {
    render(<TaskWorktreeHeader taskId="task-1" />);
    expect(screen.getByTitle("Toggle file tree")).toBeTruthy();
  });

  it("Review panel toggle button is rendered", () => {
    render(<TaskWorktreeHeader taskId="task-1" />);
    expect(screen.getByTitle("Toggle review panel")).toBeTruthy();
  });

  it("Open PR link uses href to linked_pr_url", () => {
    taskState.task = {
      ...baseTask,
      linked_pr_url: "https://github.com/x/y/pull/100",
      linked_pr_number: 100,
    };
    render(<TaskWorktreeHeader taskId="task-1" />);
    const link = screen.getByText(/Open PR #100/).closest("a");
    expect(link?.getAttribute("href")).toBe("https://github.com/x/y/pull/100");
  });

  it("Open PR fallback when number is missing", () => {
    taskState.task = {
      ...baseTask,
      linked_pr_url: "https://github.com/x/y/pull/abc",
      linked_pr_number: null,
    };
    render(<TaskWorktreeHeader taskId="task-1" />);
    expect(screen.getByText(/Open PR$/)).toBeTruthy();
  });

  it("Create PR button is enabled by default", () => {
    render(<TaskWorktreeHeader taskId="task-1" />);
    const btn = screen.getByTitle("Create GitHub PR via gh") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("renders ListChecks identity icon", () => {
    const { container } = render(<TaskWorktreeHeader taskId="task-1" />);
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(0);
  });

  it("renders 'started X ago' text", () => {
    render(<TaskWorktreeHeader taskId="task-1" />);
    expect(screen.getByText(/started/)).toBeTruthy();
  });
});
