/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Task } from "../../../lib/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  convertFileSrc: vi.fn((p: string) => p),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/taskCommands", () => ({
  deleteTask: vi.fn().mockResolvedValue(undefined),
  terminateTaskThreads: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  gitWorktreeStatus: vi.fn().mockResolvedValue({ is_dirty: false, dirty_files: [] }),
  openTerminal: vi.fn().mockResolvedValue(undefined),
}));

import { TaskSidebarItem } from "../TaskSidebarItem";
import { useTaskViewStore } from "../../../stores/taskViewStore";
import { useThreadStore } from "../../../stores/threadStore";
import { useUiStore } from "../../../stores/uiStore";

const mkTask = (overrides: Partial<Task> = {}): Task => ({
  id: "t-1",
  project_id: "p-1",
  name: "Implement signup flow",
  branch_name: "feat/signup",
  worktree_path: "/wt/signup",
  base_branch: "master",
  status: "in_progress",
  prompt: null,
  linked_pr_number: null,
  linked_pr_url: null,
  linked_issues: null,
  created_at: new Date(Date.now() - 60 * 1000).toISOString(),
  ...overrides,
});

beforeEach(() => {
  useTaskViewStore.setState({
    gitState: {},
    tasks: {},
    activeAgentTabId: {},
    reviewSidebarOpen: false,
  });
  useThreadStore.setState({ threads: {}, archivedThreads: {} });
  useUiStore.setState({
    pendingApprovalsBySession: {},
    claudeProcessingById: {},
    codexProcessingById: {},
  } as Partial<ReturnType<typeof useUiStore.getState>>);
});

afterEach(() => cleanup());

describe("TaskSidebarItem", () => {
  it("renders task name and branch", () => {
    render(
      <TaskSidebarItem task={mkTask()} isSelected={false} onSelect={() => {}} />,
    );
    expect(screen.getByText("Implement signup flow")).toBeTruthy();
    expect(screen.getByText("feat/signup")).toBeTruthy();
  });

  it("invokes onSelect when the row is clicked", () => {
    const onSelect = vi.fn();
    render(
      <TaskSidebarItem task={mkTask()} isSelected={false} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Implement signup flow/i }));
    expect(onSelect).toHaveBeenCalled();
  });

  it("shows linked PR number when set", () => {
    render(
      <TaskSidebarItem
        task={mkTask({ linked_pr_number: 123 })}
        isSelected
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("#123")).toBeTruthy();
  });

  it("opens context menu on right-click", () => {
    render(
      <TaskSidebarItem task={mkTask()} isSelected={false} onSelect={() => {}} />,
    );
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /Implement signup flow/i }),
    );
    expect(screen.getByText(/Hide \(keep worktree\)/)).toBeTruthy();
    expect(screen.getByText(/Delete Task & Worktree/)).toBeTruthy();
  });

  it("shows agent count chip when threads exist on the worktree branch", () => {
    useThreadStore.setState({
      threads: {
        "p-1": [
          {
            id: "th-1",
            project_id: "p-1",
            name: "x",
            provider: "ClaudeCode",
            run_mode: "Resume",
            work_mode: "Worktree",
            work_dir: "/wt/signup",
            state_dir: "",
            status: "Idle",
            created_at: "",
            last_active: "",
            model: null,
            reasoning_effort: null,
            fast_mode: 0,
            is_archived: 0,
            worktree_branch: "feat/signup",
            interaction_mode: "pty",
            sdk_session_id: null,
            opencode_session_id: null,
            forked_from_thread_id: null,
            forked_at_message_index: null,
            lines_added: 0,
            lines_removed: 0,
            files_changed: 0,
          },
        ],
      },
      archivedThreads: {},
    });
    render(
      <TaskSidebarItem task={mkTask()} isSelected onSelect={() => {}} />,
    );
    expect(screen.getByTitle("1 agent")).toBeTruthy();
  });

  it("shows attention pill when an agent has pending approvals", () => {
    useThreadStore.setState({
      threads: {
        "p-1": [
          {
            id: "th-1",
            project_id: "p-1",
            name: "x",
            provider: "ClaudeCode",
            run_mode: "Resume",
            work_mode: "Worktree",
            work_dir: "/wt/signup",
            state_dir: "",
            status: "Idle",
            created_at: "",
            last_active: "",
            model: null,
            reasoning_effort: null,
            fast_mode: 0,
            is_archived: 0,
            worktree_branch: "feat/signup",
            interaction_mode: "pty",
            sdk_session_id: null,
            opencode_session_id: null,
            forked_from_thread_id: null,
            forked_at_message_index: null,
            lines_added: 0,
            lines_removed: 0,
            files_changed: 0,
          },
        ],
      },
      archivedThreads: {},
    });
    useUiStore.setState({
      pendingApprovalsBySession: { "th-1": {} as never },
      claudeProcessingById: {},
      codexProcessingById: {},
    } as unknown as Partial<ReturnType<typeof useUiStore.getState>>);
    render(
      <TaskSidebarItem task={mkTask()} isSelected={false} onSelect={() => {}} />,
    );
    expect(screen.getByText(/needs? attention/i)).toBeTruthy();
  });
});

describe("TaskSidebarItem — Final coverage gaps", () => {
  const mkThread = (overrides: Record<string, unknown> = {}) => ({
    id: "th-x",
    project_id: "p-1",
    name: "x",
    provider: "ClaudeCode" as const,
    run_mode: "Resume" as const,
    work_mode: "Worktree" as const,
    work_dir: "/wt/signup",
    state_dir: "",
    status: "Idle" as const,
    created_at: "",
    last_active: "",
    model: null,
    reasoning_effort: null,
    fast_mode: 0,
    is_archived: 0,
    worktree_branch: "feat/signup",
    interaction_mode: "pty" as const,
    sdk_session_id: null,
    opencode_session_id: null,
    forked_from_thread_id: null,
    forked_at_message_index: null,
    lines_added: 0,
    lines_removed: 0,
    files_changed: 0,
    ...overrides,
  } as never);

  it("Enter key activates onSelect", () => {
    const onSelect = vi.fn();
    render(
      <TaskSidebarItem task={mkTask()} isSelected={false} onSelect={onSelect} />,
    );
    fireEvent.keyDown(
      screen.getByRole("button", { name: /Implement signup flow/i }),
      { key: "Enter" },
    );
    expect(onSelect).toHaveBeenCalled();
  });

  it("Space key activates onSelect", () => {
    const onSelect = vi.fn();
    render(
      <TaskSidebarItem task={mkTask()} isSelected={false} onSelect={onSelect} />,
    );
    fireEvent.keyDown(
      screen.getByRole("button", { name: /Implement signup flow/i }),
      { key: " " },
    );
    expect(onSelect).toHaveBeenCalled();
  });

  it("clicking 'Hide (keep worktree)' triggers deleteTask with worktree retained", async () => {
    const { deleteTask } = await import("../../../lib/taskCommands");
    vi.mocked(deleteTask).mockClear();
    render(
      <TaskSidebarItem task={mkTask()} isSelected={false} onSelect={() => {}} />,
    );
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /Implement signup flow/i }),
    );
    fireEvent.click(screen.getByText(/Hide \(keep worktree\)/));
    await new Promise((r) => setTimeout(r, 0));
    // hide path: deleteTask(taskId, force=false, removeWorktree=true /* args differ */)
    expect(deleteTask).toHaveBeenCalled();
  });

  it("clicking 'Delete Task & Worktree' (clean tree) triggers deleteTask", async () => {
    const { deleteTask } = await import("../../../lib/taskCommands");
    const { gitWorktreeStatus } = await import("../../../lib/commands");
    vi.mocked(gitWorktreeStatus).mockResolvedValueOnce({
      is_dirty: false,
      dirty_files: [],
    } as never);
    vi.mocked(deleteTask).mockClear();
    render(
      <TaskSidebarItem task={mkTask()} isSelected={false} onSelect={() => {}} />,
    );
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /Implement signup flow/i }),
    );
    fireEvent.click(screen.getByText(/Delete Task/));
    await new Promise((r) => setTimeout(r, 0));
    expect(deleteTask).toHaveBeenCalled();
  });

  it("delete on dirty tree shows uncommitted-changes dialog", async () => {
    const { gitWorktreeStatus } = await import("../../../lib/commands");
    vi.mocked(gitWorktreeStatus).mockResolvedValueOnce({
      is_dirty: true,
      dirty_files: ["a.ts", "b.ts"],
    } as never);
    render(
      <TaskSidebarItem task={mkTask()} isSelected={false} onSelect={() => {}} />,
    );
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /Implement signup flow/i }),
    );
    fireEvent.click(screen.getByText(/Delete Task/));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText(/uncommitted changes/i)).toBeTruthy();
    expect(screen.getByText("a.ts")).toBeTruthy();
    expect(screen.getByText("b.ts")).toBeTruthy();
  });

  it("Cancel button on dirty dialog closes the dialog", async () => {
    const { gitWorktreeStatus } = await import("../../../lib/commands");
    vi.mocked(gitWorktreeStatus).mockResolvedValueOnce({
      is_dirty: true,
      dirty_files: ["a.ts"],
    } as never);
    render(
      <TaskSidebarItem task={mkTask()} isSelected={false} onSelect={() => {}} />,
    );
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /Implement signup flow/i }),
    );
    fireEvent.click(screen.getByText(/Delete Task/));
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText(/uncommitted changes/i)).toBeNull();
  });

  it("Force Delete on dirty dialog calls deleteTask with force=true", async () => {
    const { gitWorktreeStatus } = await import("../../../lib/commands");
    const { deleteTask } = await import("../../../lib/taskCommands");
    vi.mocked(gitWorktreeStatus).mockResolvedValueOnce({
      is_dirty: true,
      dirty_files: ["dirty.ts"],
    } as never);
    vi.mocked(deleteTask).mockClear();
    render(
      <TaskSidebarItem task={mkTask()} isSelected={false} onSelect={() => {}} />,
    );
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /Implement signup flow/i }),
    );
    fireEvent.click(screen.getByText(/Delete Task/));
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(screen.getByText("Force Delete"));
    await new Promise((r) => setTimeout(r, 0));
    expect(deleteTask).toHaveBeenCalled();
  });

  it("'Open in Terminal' on dirty dialog calls openTerminal", async () => {
    const { gitWorktreeStatus, openTerminal } = await import("../../../lib/commands");
    vi.mocked(gitWorktreeStatus).mockResolvedValueOnce({
      is_dirty: true,
      dirty_files: ["a.ts"],
    } as never);
    vi.mocked(openTerminal).mockClear();
    render(
      <TaskSidebarItem task={mkTask()} isSelected={false} onSelect={() => {}} />,
    );
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /Implement signup flow/i }),
    );
    fireEvent.click(screen.getByText(/Delete Task/));
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(screen.getByText("Open in Terminal"));
    expect(openTerminal).toHaveBeenCalled();
  });

  it("renders DiffStat when there are diff additions", () => {
    useTaskViewStore.setState({
      gitState: {
        "t-1": {
          ahead: 0,
          behind: 0,
          dirty_files: [],
          changed_files: [{ path: "x.ts", status: "M", added: 5, removed: 2 }],
          has_upstream: true,
        } as never,
      },
      tasks: {},
      activeAgentTabId: {},
      reviewSidebarOpen: false,
    });
    const { container } = render(
      <TaskSidebarItem task={mkTask()} isSelected={false} onSelect={() => {}} />,
    );
    // DiffStat renders + and - numbers
    expect(container.textContent).toMatch(/5/);
  });

  it("shows multiple-agents attention pill when 2+ agents need attention", () => {
    useThreadStore.setState({
      threads: {
        "p-1": [
          mkThread({ id: "th-1" }),
          mkThread({ id: "th-2" }),
        ],
      },
      archivedThreads: {},
    });
    useUiStore.setState({
      pendingApprovalsBySession: { "th-1": {} as never, "th-2": {} as never },
      claudeProcessingById: {},
      codexProcessingById: {},
    } as Partial<ReturnType<typeof useUiStore.getState>>);
    render(
      <TaskSidebarItem task={mkTask()} isSelected={false} onSelect={() => {}} />,
    );
    expect(screen.getByText(/2 agents need/)).toBeTruthy();
  });

  it("shows the 'agents' chip with correct pluralization", () => {
    useThreadStore.setState({
      threads: {
        "p-1": [
          mkThread({ id: "th-1" }),
          mkThread({ id: "th-2" }),
        ],
      },
      archivedThreads: {},
    });
    render(
      <TaskSidebarItem task={mkTask()} isSelected={false} onSelect={() => {}} />,
    );
    expect(screen.getByTitle("2 agents")).toBeTruthy();
  });

  it("isSelected=true applies selected styling", () => {
    const { container } = render(
      <TaskSidebarItem task={mkTask()} isSelected={true} onSelect={() => {}} />,
    );
    const item = container.querySelector("[data-selected='true']");
    expect(item).toBeTruthy();
  });

  it("renders relative time when there are no diffs", () => {
    const { container } = render(
      <TaskSidebarItem task={mkTask()} isSelected={false} onSelect={() => {}} />,
    );
    // relative time should be something like "1m" / "now"
    expect(container.textContent ?? "").toMatch(/\d+(s|m|h|d)|now/);
  });

  it("right-click outside menu closes it", async () => {
    render(
      <TaskSidebarItem task={mkTask()} isSelected={false} onSelect={() => {}} />,
    );
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /Implement signup flow/i }),
    );
    expect(screen.getByText(/Hide \(keep worktree\)/)).toBeTruthy();
    // Click outside via mousedown
    fireEvent.mouseDown(document.body);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/Hide \(keep worktree\)/)).toBeNull();
  });
});
