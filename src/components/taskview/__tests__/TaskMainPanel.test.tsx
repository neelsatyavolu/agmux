/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import type { Task, Thread } from "../../../lib/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  convertFileSrc: vi.fn((p: string) => p),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
  once: vi.fn().mockResolvedValue(() => {}),
}));

// Provider lifecycle is tested in the shared session suites.
vi.mock("../../thread/ClaudeSessionView", () => ({
  ClaudeSessionView: ({ sessionId, compact }: { sessionId: string; compact: boolean }) => (
    <div data-testid="shared-claude" data-id={sessionId} data-compact={String(compact)} />
  ),
}));
vi.mock("../../thread/ThreadView", () => ({
  ThreadView: ({ thread, compact }: { thread: Thread; compact: boolean }) => (
    <div data-testid="shared-thread" data-id={thread.id} data-mode={thread.interaction_mode} data-compact={String(compact)} />
  ),
}));
vi.mock("../../thread/CodexSessionView", () => ({
  CodexSessionView: ({ compact, embedded, initialViewMode }: { compact: boolean; embedded?: boolean; initialViewMode?: string }) => (
    <div data-testid="codex-session" data-compact={String(compact)} data-embedded={String(!!embedded)} data-mode={initialViewMode} />
  ),
}));
vi.mock("../../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
}));

import { TaskMainPanel } from "../TaskMainPanel";
import { useTaskViewStore } from "../../../stores/taskViewStore";
import { useThreadStore } from "../../../stores/threadStore";
import { useProjectStore } from "../../../stores/projectStore";
import { useUiStore } from "../../../stores/uiStore";

const mkTask = (overrides: Partial<Task> = {}): Task => ({
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
  ...overrides,
});

const mkThread = (overrides: Partial<Thread> = {}): Thread => ({
  id: "thread-1",
  project_id: "proj-1",
  name: "Worker",
  provider: "ClaudeCode",
  run_mode: "Resume",
  work_mode: "Worktree",
  work_dir: "/tmp/wt/auth",
  state_dir: "/tmp/state",
  status: "Running",
  created_at: "",
  last_active: "",
  model: null,
  reasoning_effort: null,
  fast_mode: 0,
  is_archived: 0,
  worktree_branch: "feat/auth",
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
    tasks: { "proj-1": [mkTask()] },
    gitState: {},
    selectedTaskId: "task-1",
    activeAgentTabId: {},
    reviewSidebarOpen: false,
  });
  useThreadStore.setState({ threads: {}, archivedThreads: {} });
  useProjectStore.setState({
    projects: [
      {
        id: "proj-1",
        name: "demo",
        repo_path: "/repo",
        conventions: "",
        created_at: "",
      },
    ],
  });
  useUiStore.setState({
    claudeSessionMap: {},
    preSpawnSessionIds: {},
  } as Partial<ReturnType<typeof useUiStore.getState>>);
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("TaskMainPanel", () => {
  it("waits for a restored task thread before mounting Codex with its saved mode", () => {
    render(<TaskMainPanel taskId="task-1" />);
    expect(screen.queryByTestId("codex-session")).toBeNull();
    act(() => useThreadStore.setState({ threads: { "proj-1": [mkThread({ provider: "Codex", interaction_mode: "sdk" })] } }));
    expect(screen.getByTestId("codex-session").getAttribute("data-mode")).toBe("chat");
  });
  it("keeps a working task mounted across task and mode changes, then evicts it when idle", () => {
    vi.useFakeTimers();
    useTaskViewStore.setState({ tasks: { "proj-1": [mkTask(), mkTask({ id: "task-2", branch_name: "other" })] } });
    useThreadStore.setState({ threads: { "proj-1": [mkThread(), mkThread({ id: "second", worktree_branch: "other" })] } });
    useUiStore.setState({ claudeProcessingById: { "thread-1": true }, pendingApprovalsBySession: {} });
    const { rerender } = render(<TaskMainPanel taskId="task-1" />);
    const first = screen.getByTestId("shared-claude");
    rerender(<TaskMainPanel taskId="task-2" />);
    expect(screen.getAllByTestId("shared-claude")[0]).toBe(first);
    expect(first.parentElement?.getAttribute("aria-hidden")).toBe("true");
    rerender(<TaskMainPanel taskId="task-2" active={false} />);
    act(() => vi.advanceTimersByTime(240_000));
    expect(screen.getByTestId("shared-claude")).toBe(first);
    act(() => useUiStore.setState({ claudeProcessingById: {} }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByTestId("shared-claude")).toBeNull();
  });
  it.each(["ClaudeCode", "Codex", "Droid", "Kimi", "Pi", "OpenCode", "Grok", "Cursor", "Cline", "Gemini", "Hermes"] as const)(
    "uses the current shared session surface for %s", (provider) => {
      useThreadStore.setState({ threads: { "proj-1": [mkThread({ provider })] } });
      render(<TaskMainPanel taskId="task-1" />);
      const kind = provider === "ClaudeCode" ? "shared-claude" : provider === "Codex" ? "codex-session" : "shared-thread";
      expect(screen.getByTestId(kind)).toBeTruthy();
    },
  );
  it("renders empty state when there are no threads on the worktree branch", () => {
    render(<TaskMainPanel taskId="task-1" />);
    expect(screen.getByText("No agents running")).toBeTruthy();
    expect(screen.getByText("Start one from the tab bar above")).toBeTruthy();
  });

  it.each([
    ["OpenCode", "opencode-sdk"], ["Grok", "grok-sdk"],
    ["Cursor", "cursor-sdk"], ["Gemini", "gemini-sdk"],
  ] as const)("preserves %s chat routing and session controls", (provider, interaction_mode) => {
    useThreadStore.setState({ threads: { "proj-1": [mkThread({ provider, interaction_mode })] } });
    render(<TaskMainPanel taskId="task-1" />);
    expect(screen.getByTestId("shared-thread").getAttribute("data-mode")).toBe(interaction_mode);
    expect(screen.getByTestId("shared-thread").getAttribute("data-compact")).toBe("true");
  });

  it("keeps Codex session controls available", () => {
    useThreadStore.setState({ threads: { "proj-1": [mkThread({ provider: "Codex", interaction_mode: "sdk" })] } });
    render(<TaskMainPanel taskId="task-1" />);
    expect(screen.getByTestId("codex-session").getAttribute("data-embedded")).toBe("false");
  });

  it("falls back from a missing tab and hides inactive agents", () => {
    useTaskViewStore.setState({ activeAgentTabId: { "task-1": "gone" } });
    useThreadStore.setState({ threads: { "proj-1": [mkThread(), mkThread({ id: "second" }), mkThread({ id: "archived", is_archived: 1 })] } });
    render(<TaskMainPanel taskId="task-1" />);
    const views = screen.getAllByTestId("shared-claude");
    expect(views).toHaveLength(2);
    expect(views[0].parentElement?.getAttribute("aria-hidden")).toBe("false");
    expect(views[1].parentElement?.getAttribute("aria-hidden")).toBe("true");
  });

  it("filters threads by worktree_branch — ignores other branches", () => {
    useThreadStore.setState({
      threads: {
        "proj-1": [
          mkThread({ id: "match", worktree_branch: "feat/auth" }),
          mkThread({ id: "other", worktree_branch: "feat/other" }),
        ],
      },
      archivedThreads: {},
    });
    render(<TaskMainPanel taskId="task-1" />);
    // The matching thread renders; the other branch is filtered out
    expect(screen.getByTestId("shared-claude").getAttribute("data-id")).toBe(
      "match",
    );
  });

  it("returns empty state when the task does not exist", () => {
    useTaskViewStore.setState({
      tasks: {},
      gitState: {},
      selectedTaskId: "task-1",
      activeAgentTabId: {},
      reviewSidebarOpen: false,
    });
    render(<TaskMainPanel taskId="missing" />);
    expect(screen.getByText("No agents running")).toBeTruthy();
  });
});
