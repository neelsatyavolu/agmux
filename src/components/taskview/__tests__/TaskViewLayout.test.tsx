/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { Task, Thread } from "../../../lib/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  convertFileSrc: vi.fn((p: string) => p),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

// Replace heavy children with sentinels so we can assert layout composition.
vi.mock("../TaskSidebar", () => ({
  TaskSidebar: () => <div data-testid="task-sidebar" />,
}));
vi.mock("../TaskAgentTabBar", () => ({
  TaskAgentTabBar: ({ taskId }: { taskId: string }) => (
    <div data-testid="task-tabbar" data-id={taskId} />
  ),
}));
vi.mock("../TaskMainPanel", () => ({
  TaskMainPanel: ({ taskId }: { taskId: string }) => (
    <div data-testid="task-main" data-id={taskId} />
  ),
}));
vi.mock("../TaskWorktreeHeader", () => ({
  TaskWorktreeHeader: ({ taskId }: { taskId: string }) => (
    <div data-testid="task-header" data-id={taskId} />
  ),
}));
vi.mock("../../thread/GitSidebar", () => ({
  GitSidebar: ({ workDir }: { workDir: string }) => (
    <div data-testid="git-sidebar" data-wd={workDir} />
  ),
}));
vi.mock("../../layout/EditorPanel", () => ({
  EditorPanel: () => <div data-testid="editor-panel" />,
}));
vi.mock("../../layout/ResizeHandle", () => ({
  ResizeHandle: () => <div data-testid="resize-handle" />,
}));

vi.mock("../../../lib/taskCommands", () => ({
  updateTask: vi.fn().mockResolvedValue({}),
}));

import { TaskViewLayout } from "../TaskViewLayout";
import { useTaskViewStore } from "../../../stores/taskViewStore";
import { useThreadStore } from "../../../stores/threadStore";
import { useProjectStore } from "../../../stores/projectStore";
import { listen } from "@tauri-apps/api/event";

const mkTask = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1",
  project_id: "p-1",
  name: "Task A",
  branch_name: "feat/a",
  worktree_path: "/wt/a",
  base_branch: "master",
  status: "in_progress",
  prompt: null,
  linked_pr_number: null,
  linked_pr_url: null,
  linked_issues: null,
  created_at: "",
  ...overrides,
});

const mkThread = (overrides: Partial<Thread> = {}): Thread => ({
  id: "thread-1",
  project_id: "p-1",
  name: "Thread",
  provider: "ClaudeCode",
  run_mode: "Local",
  work_mode: "DirectRepo",
  work_dir: "/tmp/repo",
  state_dir: "/tmp/state",
  status: "Running",
  created_at: "",
  last_active: "",
  model: null,
  reasoning_effort: null,
  fast_mode: 0,
  is_archived: 0,
  worktree_branch: null,
  interaction_mode: "pty",
  sdk_session_id: null,
  opencode_session_id: null,
  forked_from_thread_id: null,
  forked_at_message_index: null,
  lines_added: 0,
  lines_removed: 0,
  files_changed: 0,
  ...overrides,
});

beforeEach(() => {
  useTaskViewStore.setState({
    tasks: { "p-1": [mkTask()] },
    activeAgentTabId: {},
    reviewSidebarOpen: false,
    gitState: {},
    selectedTaskId: null,
  });
  useThreadStore.setState({ threads: {}, archivedThreads: {} });
  useProjectStore.setState({ projects: [] });
  vi.mocked(listen).mockClear();
});

afterEach(() => cleanup());

describe("TaskViewLayout", () => {
  it("refreshes the affected project when a phone creates an agent", () => {
    const fetchThreads = vi.fn().mockResolvedValue(undefined);
    useThreadStore.setState({ fetchThreads });
    render(<TaskViewLayout />);
    const registration = vi.mocked(listen).mock.calls.find(([event]) => event === "remote-thread-created");
    expect(registration).toBeTruthy();
    registration![1]({ payload: { projectId: "p-remote" } } as never);
    expect(fetchThreads).toHaveBeenCalledWith("p-remote");
  });
  it("renders the sidebar and the no-task placeholder by default", () => {
    render(<TaskViewLayout />);
    expect(screen.getByTestId("task-sidebar")).toBeTruthy();
    expect(screen.getByText("No task selected")).toBeTruthy();
    expect(
      screen.getByText(/Pick a task from the sidebar, or start a new one/i),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /new task/i })).toBeTruthy();
  });

  it("retains the session host but hides task chrome when no task is selected", () => {
    render(<TaskViewLayout />);
    expect(screen.queryByTestId("task-main")).toBeTruthy();
    expect(screen.queryByTestId("task-header")).toBeNull();
  });

  it("does not render the GitSidebar when no task is selected", () => {
    render(<TaskViewLayout />);
    expect(screen.queryByTestId("git-sidebar")).toBeNull();
  });

  it("renders TaskWorktreeHeader, TaskAgentTabBar, and TaskMainPanel when a task is selected", () => {
    useTaskViewStore.setState({
      tasks: { "p-1": [mkTask()] },
      selectedTaskId: "task-1",
      activeAgentTabId: {},
      reviewSidebarOpen: false,
      gitState: {},
    });
    render(<TaskViewLayout />);
    expect(screen.getByTestId("task-header").getAttribute("data-id")).toBe("task-1");
    expect(screen.getByTestId("task-tabbar").getAttribute("data-id")).toBe("task-1");
    expect(screen.getByTestId("task-main").getAttribute("data-id")).toBe("task-1");
  });

  it("mounts the GitSidebar with the selected task's worktree path", () => {
    useTaskViewStore.setState({
      tasks: { "p-1": [mkTask({ worktree_path: "/wt/a" })] },
      selectedTaskId: "task-1",
      activeAgentTabId: {},
      reviewSidebarOpen: false,
      gitState: {},
    });
    render(<TaskViewLayout />);
    expect(screen.getByTestId("git-sidebar").getAttribute("data-wd")).toBe("/wt/a");
  });

  it("always mounts the EditorPanel slide-in", () => {
    render(<TaskViewLayout />);
    expect(screen.getByTestId("editor-panel")).toBeTruthy();
  });

  it("does not subscribe Cursor SDK task threads to PTY exit events", async () => {
    const { waitFor } = await import("@testing-library/react");
    useThreadStore.setState({
      threads: {
        "p-1": [
          mkThread({ id: "pty-thread", provider: "ClaudeCode", interaction_mode: "pty" }),
          mkThread({ id: "cursor-thread", provider: "Cursor", interaction_mode: "cursor-sdk" }),
        ],
      },
    });

    render(<TaskViewLayout />);

    await waitFor(() => {
      expect(listen).toHaveBeenCalledWith("pty-exit-pty-thread", expect.any(Function));
    });
    expect(listen).not.toHaveBeenCalledWith("pty-exit-cursor-thread", expect.any(Function));
  });
});
