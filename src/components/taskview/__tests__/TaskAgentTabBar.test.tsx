/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { Task, Thread } from "../../../lib/types";

// jsdom doesn't ship ResizeObserver — TaskAgentTabBar uses one to track the
// menu/archived trigger rects. A noop stub is enough for tests.
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
  StubResizeObserver as unknown as typeof ResizeObserver;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  convertFileSrc: vi.fn((p: string) => p),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn().mockResolvedValue(false),
}));

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock("../AgentAvatar", () => ({
  AgentAvatar: ({ provider }: { provider: string }) => (
    <span data-testid="avatar" data-provider={provider} />
  ),
}));

vi.mock("../TaskAgentTab", () => ({
  TaskAgentTab: ({
    thread,
    isActive,
    onSelect,
    onClose,
  }: {
    thread: Thread;
    isActive: boolean;
    onSelect: () => void;
    onClose: () => void;
  }) => (
    <div
      data-testid="task-agent-tab"
      data-id={thread.id}
      data-active={isActive}
      onClick={onSelect}
    >
      <span>{thread.name}</span>
      <button aria-label="close" onClick={onClose}>x</button>
    </div>
  ),
}));

vi.mock("../../../lib/taskCommands", () => ({
  createTaskAgent: vi.fn().mockResolvedValue({
    id: "new-thread",
    project_id: "p-1",
    name: "new",
  }),
  terminateThreadProcess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  getClaudeDefaultModel: vi.fn().mockResolvedValue("sonnet"),
  updateThreadSettings: vi.fn().mockResolvedValue(undefined),
  listThreads: vi.fn().mockResolvedValue([]),
  listArchivedThreads: vi.fn().mockResolvedValue([]),
  codexEnsureServer: vi.fn().mockResolvedValue(undefined),
  codexStartThread: vi.fn().mockResolvedValue({ thread: { id: "t_codex" } }),
}));

vi.mock("../../../lib/codexSessionMode", () => ({
  setCodexSessionMode: vi.fn(),
}));

import { TaskAgentTabBar } from "../TaskAgentTabBar";
import { useTaskViewStore } from "../../../stores/taskViewStore";
import { useThreadStore } from "../../../stores/threadStore";
import { useUiStore } from "../../../stores/uiStore";
import { useSettingsStore } from "../../../stores/settingsStore";

vi.mock("../../../lib/mlx", () => ({
  mlxCapability: vi.fn().mockResolvedValue({ available: true }),
  mlxListModels: vi.fn().mockResolvedValue([{ id: "installed", displayName: "Installed" }]),
  mlxGatewayStatus: vi.fn().mockResolvedValue({}),
  localModelSlug: (id: string) => id.startsWith("local/") ? id : `local/${id}`,
  resolveLocalModelId: () => "installed",
}));

const initialSettings = useSettingsStore.getState().settings;

const mkTask = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1",
  project_id: "p-1",
  name: "Add auth flow",
  branch_name: "feat/auth",
  worktree_path: "/wt/auth",
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
  id: "th-1",
  project_id: "p-1",
  name: "Worker",
  provider: "ClaudeCode",
  run_mode: "Resume",
  work_mode: "Worktree",
  work_dir: "/wt/auth",
  state_dir: "",
  status: "Idle",
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
  useSettingsStore.setState({ settings: { ...initialSettings } });
  useTaskViewStore.setState({
    tasks: { "p-1": [mkTask()] },
    activeAgentTabId: {},
    reviewSidebarOpen: false,
    gitState: {},
  });
  useThreadStore.setState({ threads: {}, archivedThreads: {} });
  useUiStore.setState({
    unreadSessionIds: {},
    pendingGrokConfigs: {},
  } as Partial<ReturnType<typeof useUiStore.getState>>);
});

afterEach(() => cleanup());

describe("TaskAgentTabBar", () => {
  it("renders 'Start an agent' placeholder when no threads exist", () => {
    render(<TaskAgentTabBar taskId="task-1" />);
    expect(screen.getByText(/start an agent/i)).toBeTruthy();
  });

  it("renders the + add agent button", () => {
    render(<TaskAgentTabBar taskId="task-1" />);
    expect(screen.getByTitle(/add another agent attempt/i)).toBeTruthy();
  });

  it("renders one tab per thread on the worktree branch", () => {
    useThreadStore.setState({
      threads: {
        "p-1": [
          mkThread({ id: "a", name: "Alpha" }),
          mkThread({ id: "b", name: "Beta" }),
          mkThread({ id: "c", worktree_branch: "feat/other", name: "Other" }),
        ],
      },
      archivedThreads: {},
    });
    render(<TaskAgentTabBar taskId="task-1" />);
    const tabs = screen.getAllByTestId("task-agent-tab");
    expect(tabs).toHaveLength(2);
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.queryByText("Other")).toBeNull();
  });

  it("opens the agent menu when the + button is clicked", () => {
    useThreadStore.setState({
      threads: { "p-1": [mkThread()] },
      archivedThreads: {},
    });
    render(<TaskAgentTabBar taskId="task-1" />);
    fireEvent.click(screen.getByTitle("Add another agent attempt"));
    expect(screen.getByText("New agent in")).toBeTruthy();
    expect(screen.getByText("Claude Chat")).toBeTruthy();
    expect(screen.getByText("Codex Chat")).toBeTruthy();
    expect(screen.getByText("Cursor Chat")).toBeTruthy();
  });

  it("shows Archived button when archived threads exist for this branch", () => {
    useThreadStore.setState({
      threads: { "p-1": [mkThread()] },
      archivedThreads: {
        "p-1": [mkThread({ id: "arch", is_archived: 1 })],
      },
    });
    render(<TaskAgentTabBar taskId="task-1" />);
    expect(screen.getByText("Archived")).toBeTruthy();
  });

  it("renders the chrome shell when task is missing", () => {
    useTaskViewStore.setState({
      tasks: {},
      activeAgentTabId: {},
      reviewSidebarOpen: false,
      gitState: {},
    });
    const { container } = render(<TaskAgentTabBar taskId="missing-task" />);
    expect(container.firstChild).toBeTruthy();
  });
});

describe("TaskAgentTabBar — Final coverage gaps", () => {
  it("clicking 'Start an agent' button does not crash", () => {
    render(<TaskAgentTabBar taskId="task-1" />);
    fireEvent.click(screen.getByText(/start an agent/i));
    // The placeholder button does setMenuOpen(true), but menuRect is null until
    // the "+" trigger button is clicked, so the portaled menu may not appear.
    // Just verify no crash.
    expect(screen.getByText(/start an agent/i)).toBeTruthy();
  });

  it("opens menu and shows all chat options + terminal options", () => {
    render(<TaskAgentTabBar taskId="task-1" />);
    fireEvent.click(screen.getByTitle("Add another agent attempt"));
    expect(screen.getByText("Claude Chat")).toBeTruthy();
    expect(screen.getByText("Codex Chat")).toBeTruthy();
    expect(screen.getByText("OpenCode Chat")).toBeTruthy();
    expect(screen.getByText("Grok Chat")).toBeTruthy();
    expect(screen.getByText("Cursor Chat")).toBeTruthy();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("Droid")).toBeTruthy();
    expect(screen.getByText("Kimi")).toBeTruthy();
    expect(screen.getByText("Cline")).toBeTruthy();
    expect(screen.getByText("Gemini")).toBeTruthy();
    expect(screen.getByText("Hermes")).toBeTruthy();
    // Terminal parity with agent mode
    expect(screen.getAllByText("OpenCode").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Grok").length).toBeGreaterThan(0);
  });

  it("selecting Claude Chat triggers handleAddAgent → createTaskAgent", async () => {
    const { createTaskAgent } = await import("../../../lib/taskCommands");
    vi.mocked(createTaskAgent).mockClear();
    render(<TaskAgentTabBar taskId="task-1" />);
    fireEvent.click(screen.getByTitle("Add another agent attempt"));
    fireEvent.click(screen.getByText("Claude Chat"));
    await new Promise((r) => setTimeout(r, 0));
    expect(createTaskAgent).toHaveBeenCalled();
  });

  it("selecting Kimi (PTY) terminal triggers createTaskAgent", async () => {
    const { createTaskAgent } = await import("../../../lib/taskCommands");
    vi.mocked(createTaskAgent).mockClear();
    render(<TaskAgentTabBar taskId="task-1" />);
    fireEvent.click(screen.getByTitle("Add another agent attempt"));
    fireEvent.click(screen.getByText("Kimi"));
    await new Promise((r) => setTimeout(r, 0));
    expect(createTaskAgent).toHaveBeenCalled();
  });

  it("selecting Cursor Chat creates a cursor-sdk agent with the default Cursor model", async () => {
    const { createTaskAgent } = await import("../../../lib/taskCommands");
    vi.mocked(createTaskAgent).mockClear();
    render(<TaskAgentTabBar taskId="task-1" />);
    fireEvent.click(screen.getByTitle("Add another agent attempt"));
    fireEvent.click(screen.getByText("Cursor Chat"));
    await new Promise((r) => setTimeout(r, 0));
    expect(createTaskAgent).toHaveBeenCalledWith(
      "task-1",
      "Cursor",
      "Cursor Chat #1",
      "composer-2.5",
      "cursor-sdk",
      null,
    );
  });

  it("selecting Grok Chat creates a grok-sdk agent", async () => {
    const { createTaskAgent } = await import("../../../lib/taskCommands");
    vi.mocked(createTaskAgent).mockClear();
    render(<TaskAgentTabBar taskId="task-1" />);
    fireEvent.click(screen.getByTitle("Add another agent attempt"));
    fireEvent.click(screen.getByText("Grok Chat"));
    await new Promise((r) => setTimeout(r, 0));
    expect(createTaskAgent).toHaveBeenCalledWith(
      "task-1",
      "Grok",
      "Grok Chat #1",
      "grok-4.7",
      "grok-sdk",
      null,
    );
    expect(useUiStore.getState().pendingGrokConfigs["new-thread"]).toEqual({
      permissionMode: "default",
      model: "grok-4.7",
      effort: initialSettings.lastUsedEffort,
    });
  });

  it("renders task display label using task.name", () => {
    render(<TaskAgentTabBar taskId="task-1" />);
    fireEvent.click(screen.getByTitle("Add another agent attempt"));
    expect(screen.getByText("Add auth flow")).toBeTruthy();
  });

  it("uses branch_name when task.name is missing", () => {
    useTaskViewStore.setState({
      tasks: {
        "p-1": [mkTask({ id: "task-1", name: "" })],
      },
      activeAgentTabId: {},
      reviewSidebarOpen: false,
      gitState: {},
    });
    render(<TaskAgentTabBar taskId="task-1" />);
    fireEvent.click(screen.getByTitle("Add another agent attempt"));
    expect(screen.getByText("feat/auth")).toBeTruthy();
  });

  it("clicking the archived button toggles archived dropdown", () => {
    useThreadStore.setState({
      threads: { "p-1": [mkThread()] },
      archivedThreads: {
        "p-1": [mkThread({ id: "arch-1", name: "Old Worker", is_archived: 1 })],
      },
    });
    render(<TaskAgentTabBar taskId="task-1" />);
    fireEvent.click(screen.getByText("Archived"));
    expect(screen.getByText("Archived in this worktree")).toBeTruthy();
    expect(screen.getByText("Old Worker")).toBeTruthy();
  });

  it("clicking Restore in archived dropdown invokes unarchiveThread", async () => {
    const unarchive = vi.fn().mockResolvedValue(undefined);
    useThreadStore.setState({
      threads: { "p-1": [mkThread()] },
      archivedThreads: {
        "p-1": [mkThread({ id: "arch-1", name: "Old Worker", is_archived: 1 })],
      },
      unarchiveThread: unarchive,
    } as Partial<ReturnType<typeof useThreadStore.getState>>);
    render(<TaskAgentTabBar taskId="task-1" />);
    fireEvent.click(screen.getByText("Archived"));
    fireEvent.click(screen.getByText("Restore"));
    await new Promise((r) => setTimeout(r, 0));
    expect(unarchive).toHaveBeenCalledWith("p-1", "arch-1");
  });

  it("terminates cursor-sdk agent before archiving its tab", async () => {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const { terminateThreadProcess } = await import("../../../lib/taskCommands");
    const archiveThread = vi.fn().mockResolvedValue(undefined);
    vi.mocked(ask).mockResolvedValueOnce(true);
    vi.mocked(terminateThreadProcess).mockClear();
    useThreadStore.setState({
      threads: {
        "p-1": [
          mkThread({
            id: "cursor-thread",
            name: "Cursor Worker",
            provider: "Cursor",
            interaction_mode: "cursor-sdk",
          }),
        ],
      },
      archivedThreads: {},
      archiveThread,
    } as Partial<ReturnType<typeof useThreadStore.getState>>);

    render(<TaskAgentTabBar taskId="task-1" />);
    fireEvent.click(screen.getByLabelText("close"));
    await new Promise((r) => setTimeout(r, 0));

    expect(terminateThreadProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "cursor-thread",
        interaction_mode: "cursor-sdk",
      }),
    );
    expect(archiveThread).toHaveBeenCalledWith("p-1", "cursor-thread");
  });

  it("terminates grok-sdk agent before archiving its tab", async () => {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const { terminateThreadProcess } = await import("../../../lib/taskCommands");
    const archiveThread = vi.fn().mockResolvedValue(undefined);
    vi.mocked(ask).mockResolvedValueOnce(true);
    vi.mocked(terminateThreadProcess).mockClear();
    useThreadStore.setState({
      threads: {
        "p-1": [
          mkThread({
            id: "grok-thread",
            name: "Grok Worker",
            provider: "Grok",
            interaction_mode: "grok-sdk",
          }),
        ],
      },
      archivedThreads: {},
      archiveThread,
    } as Partial<ReturnType<typeof useThreadStore.getState>>);

    render(<TaskAgentTabBar taskId="task-1" />);
    fireEvent.click(screen.getByLabelText("close"));
    await new Promise((r) => setTimeout(r, 0));

    expect(terminateThreadProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "grok-thread",
        interaction_mode: "grok-sdk",
      }),
    );
    expect(archiveThread).toHaveBeenCalledWith("p-1", "grok-thread");
  });

  it("clicking a tab fires setActiveAgent", () => {
    const setActiveAgent = vi.fn();
    useTaskViewStore.setState({
      tasks: { "p-1": [mkTask()] },
      activeAgentTabId: {},
      reviewSidebarOpen: false,
      gitState: {},
      setActiveAgent,
    } as Partial<ReturnType<typeof useTaskViewStore.getState>>);
    useThreadStore.setState({
      threads: { "p-1": [mkThread({ id: "tab-1", name: "Tab1" })] },
      archivedThreads: {},
    });
    render(<TaskAgentTabBar taskId="task-1" />);
    fireEvent.click(screen.getByText("Tab1"));
    expect(setActiveAgent).toHaveBeenCalled();
  });

  it("clears unread flag for the active tab on mount", async () => {
    useThreadStore.setState({
      threads: { "p-1": [mkThread({ id: "th-active", name: "ActiveTab" })] },
      archivedThreads: {},
    });
    useUiStore.setState({
      unreadSessionIds: { "th-active": true },
    } as Partial<ReturnType<typeof useUiStore.getState>>);
    useTaskViewStore.setState({
      tasks: { "p-1": [mkTask()] },
      activeAgentTabId: { "task-1": "th-active" },
      reviewSidebarOpen: false,
      gitState: {},
    });
    render(<TaskAgentTabBar taskId="task-1" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(useUiStore.getState().unreadSessionIds["th-active"]).toBe(false);
  });

  it("does not crash when no archived threads exist", () => {
    render(<TaskAgentTabBar taskId="task-1" />);
    expect(screen.queryByText("Archived")).toBeNull();
  });

  it("filters tabs by worktree branch", () => {
    useThreadStore.setState({
      threads: {
        "p-1": [
          mkThread({ id: "match", worktree_branch: "feat/auth", name: "Matches" }),
          mkThread({ id: "diff", worktree_branch: "feat/other", name: "OtherBranch" }),
        ],
      },
      archivedThreads: {},
    });
    render(<TaskAgentTabBar taskId="task-1" />);
    expect(screen.getByText("Matches")).toBeTruthy();
    expect(screen.queryByText("OtherBranch")).toBeNull();
  });

  it("dismisses tab bar error when Dismiss is clicked", async () => {
    const { createTaskAgent } = await import("../../../lib/taskCommands");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(createTaskAgent).mockRejectedValueOnce(new Error("boom"));
    render(<TaskAgentTabBar taskId="task-1" />);
    fireEvent.click(screen.getByTitle("Add another agent attempt"));
    fireEvent.click(screen.getByText("Claude Chat"));
    await new Promise((r) => setTimeout(r, 0));
    const dismiss = await screen.findByText("Dismiss");
    fireEvent.click(dismiss);
    expect(screen.queryByText(/Couldn't create agent/)).toBeNull();
    consoleError.mockRestore();
  });
});

describe("TaskAgentTabBar — provider creation parity", () => {
  it.each([
    ["Gemini Chat", "Gemini", "gemini-sdk", "gemini-3.8-flash-high"],
    ["Local Chat", "OpenCode", "opencode-sdk", "local/installed"],
    ["Local", "Pi", "pty", "local/installed"],
    ["Pi", "Pi", "pty", null],
    ["Droid", "Droid", "pty", null],
    ["Cline", "Cline", "pty", null],
    ["Gemini", "Gemini", "pty", null],
    ["Hermes", "Hermes", "pty", null],
  ] as const)("creates %s using its supported route", async (label, provider, mode, model) => {
    const { createTaskAgent } = await import("../../../lib/taskCommands");
    vi.mocked(createTaskAgent).mockClear();
    useSettingsStore.setState({ settings: { ...initialSettings, lastUsedEffort: "high" } });
    render(<TaskAgentTabBar taskId="task-1" />);
    fireEvent.click(screen.getByTitle("Add another agent attempt"));
    fireEvent.click(screen.getByText(label));
    await waitFor(() => expect(createTaskAgent).toHaveBeenCalledWith("task-1", provider, `${label} #1`, model, mode, null));
    if (label === "Local") {
      const { invoke } = await import("@tauri-apps/api/core");
      expect(invoke).toHaveBeenCalledWith("mlx_sync_pi_config");
    }
  });

  it("restores the saved Cursor model and permission on quick-add", async () => {
    const { createTaskAgent } = await import("../../../lib/taskCommands");
    useSettingsStore.setState({ settings: { ...initialSettings, defaultProvider: "Cursor", lastUsedModel: "account-model", sdkPermissionMode: "auto" } });
    render(<TaskAgentTabBar taskId="task-1" />);
    fireEvent.click(screen.getByTitle("Add another agent attempt"));
    fireEvent.click(screen.getByText("Cursor Chat"));
    await waitFor(() => expect(createTaskAgent).toHaveBeenCalledWith("task-1", "Cursor", "Cursor Chat #1", "account-model", "cursor-sdk", null));
    expect(useUiStore.getState().pendingSdkPermissionModes["new-thread"]).toBe("auto");
  });

  it.each([
    ["Codex Chat", "chat", "sdk"],
    ["Codex", "terminal", "pty"],
  ] as const)("persists %s mode and registers in the multi-repo task cwd", async (label, viewMode, mode) => {
    const { codexEnsureServer, codexStartThread } = await import("../../../lib/commands");
    const { setCodexSessionMode } = await import("../../../lib/codexSessionMode");
    const { createTaskAgent } = await import("../../../lib/taskCommands");
    useTaskViewStore.setState({ tasks: { "p-1": [mkTask({ worktree_path: "/tasks/change/repo", multi_repo: 1 })] } });
    render(<TaskAgentTabBar taskId="task-1" />);
    fireEvent.click(screen.getByTitle("Add another agent attempt"));
    fireEvent.click(screen.getByText(label));
    await waitFor(() => expect(createTaskAgent).toHaveBeenCalledWith("task-1", "Codex", `${label} #1`, null, mode, "t_codex"));
    expect(codexEnsureServer).toHaveBeenCalledWith("/tasks/change");
    expect(codexStartThread).toHaveBeenCalledWith("/tasks/change", undefined);
    expect(setCodexSessionMode).toHaveBeenCalledWith("t_codex", viewMode);
  });
});
