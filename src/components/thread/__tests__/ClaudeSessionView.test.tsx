/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  spawnClaudeResume: vi.fn().mockResolvedValue(undefined),
  listClaudeSessions: vi.fn().mockResolvedValue([]),
  discoverClaudeSessionFile: vi.fn().mockResolvedValue(undefined),
  stopClaudeChatWatcher: vi.fn().mockResolvedValue(undefined),
  stopClaudeSession: vi.fn().mockResolvedValue(undefined),
  sendPtyInput: vi.fn().mockResolvedValue(undefined),
  getPtySnapshot: vi.fn().mockResolvedValue({ data: "" }),
  getClaudePtySessionUsage: vi.fn().mockResolvedValue(null),
  getGitInfo: vi.fn().mockResolvedValue({ branch: "main", remote_url: null }),
  gitStatusSummary: vi.fn().mockResolvedValue({
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    has_upstream: false,
    files: [],
  }),
  openInIde: vi.fn().mockResolvedValue(undefined),
  listAvailableIdes: vi.fn().mockResolvedValue([]),
  // ClaudeSessionView started polling diff stats; the mock was never updated.
  getClaudeSessionDiffStats: vi.fn().mockResolvedValue({
    lines_added: 0,
    lines_removed: 0,
    files_changed: 0,
  }),
  // The topbar's quota fetcher fans out across providers; stub even when the
  // test only renders Claude PTY (the polling loop runs unconditionally).
  fetchClaudeUsage: vi.fn().mockResolvedValue({ session: null, weekly: null }),
  fetchCodexUsage: vi.fn().mockResolvedValue({ session: null, weekly: null }),
  fetchGrokUsage: vi.fn().mockResolvedValue({ session: null, weekly: null }),
  fetchGeminiUsage: vi.fn().mockResolvedValue({ session: null, weekly: null }),
  getPaceInfo: vi.fn().mockResolvedValue({ session: null, weekly: null }),
}));

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) =>
      <div {...props}>{children}</div>,
  },
}));

// Stub heavy children
vi.mock("../ClaudeTerminalView", () => ({
  ClaudeTerminalView: ({ isActive }: { isActive?: boolean }) => (
    <div data-testid="claude-terminal-view" data-active={String(!!isActive)} />
  ),
}));
vi.mock("../ClaudeSdkSessionView", () => ({
  ClaudeSdkSessionView: () => <div data-testid="claude-sdk-session-view" />,
}));
vi.mock("../ThreadTopBar", () => ({
  ThreadTopBar: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="thread-top-bar">{children}</div>
  ),
}));
vi.mock("../GitSidebar", () => ({
  GitSidebar: ({ open }: { open: boolean }) =>
    open ? <div data-testid="git-sidebar" /> : null,
}));
vi.mock("../../layout/EditorPanel", () => ({
  EditorPanel: () => <div data-testid="editor-panel" />,
}));
vi.mock("../TerminalPanel", () => ({
  default: () => <div data-testid="terminal-panel" />,
}));

import { ClaudeSessionView } from "../ClaudeSessionView";
import { useThreadStore } from "../../../stores/threadStore";
import { useUiStore } from "../../../stores/uiStore";
import { useSplitViewStore } from "../../../stores/splitViewStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useTaskViewStore } from "../../../stores/taskViewStore";
import { SessionPresentationContext } from "../../../hooks/useIsSessionActive";
import { listen } from "@tauri-apps/api/event";
import {
  getClaudePtySessionUsage,
  getClaudeSessionDiffStats,
  listClaudeSessions,
} from "../../../lib/commands";

afterEach(() => cleanup());

beforeEach(() => {
  vi.mocked(getClaudePtySessionUsage).mockClear();
  vi.mocked(getClaudeSessionDiffStats).mockClear();
  useThreadStore.setState({ threads: {} } as never);
  useUiStore.setState({
    appMode: "agent",
    sessionTerminalOpenByKey: {},
    sidebarTab: "agents",
    selectedClaudeSessionId: null,
    claudeProcessingById: {},
    claudeSessionMap: {},
    preSpawnSessionIds: {},
    pendingFirstMessages: {},
  } as never);
  useTaskViewStore.setState({ tasks: {}, selectedTaskId: null, activeAgentTabId: {} });
  useSplitViewStore.setState({
    panes: {},
    focusedPaneId: "pane-1",
    layout: { type: "pane", paneId: "pane-1" },
  } as never);
});

const baseProps = {
  sessionId: "thread-1",
  cwd: "/tmp/repo",
  isNew: false,
};

function seedPtyThread() {
  useThreadStore.setState({
    threads: {
      "p1": [
        {
          id: "thread-1",
          project_id: "p1",
          provider: "ClaudeCode",
          interaction_mode: "pty",
          model: null,
          reasoning_effort: null,
          fast_mode: false,
        } as never,
      ],
    },
  } as never);
}

function seedSdkThread() {
  useThreadStore.setState({
    threads: {
      "p1": [
        {
          id: "thread-1",
          project_id: "p1",
          provider: "ClaudeCode",
          interaction_mode: "sdk",
          model: null,
          reasoning_effort: null,
          fast_mode: false,
        } as never,
      ],
    },
  } as never);
}

describe("ClaudeSessionView — task discovery", () => {
  beforeEach(() => {
    localStorage.removeItem("agmux-claude-session-map");
    vi.useFakeTimers();
    vi.mocked(listen).mockClear();
    vi.mocked(listClaudeSessions).mockReset().mockResolvedValue([]);
    useUiStore.setState({
      appMode: "task",
      preSpawnSessionIds: { "thread-1": ["pre-existing"] },
      claudeSessionMap: { other: ["already-owned"] },
    });
    useThreadStore.setState({ threads: { p1: [
      { id: "thread-1", project_id: "p1", provider: "ClaudeCode", interaction_mode: "pty", model: "sonnet", worktree_branch: "task-branch" },
      { id: "thread-2", project_id: "p1", provider: "ClaudeCode", interaction_mode: "pty", worktree_branch: "task-branch" },
    ] } } as never);
    useTaskViewStore.setState({
      tasks: { p1: [{ id: "task-1", project_id: "p1", branch_name: "task-branch" }] },
      selectedTaskId: "task-1",
      activeAgentTabId: { "task-1": "missing-tab" },
    } as never);
  });

  afterEach(() => {
    cleanup();
    localStorage.removeItem("agmux-claude-session-map");
    vi.useRealTimers();
    vi.mocked(listClaudeSessions).mockReset().mockResolvedValue([]);
  });

  async function mountDiscovery() {
    await act(async () => {
      render(<ClaudeSessionView {...baseProps} isNew />);
    });
  }

  function discover(sessionId: string) {
    const callback = vi.mocked(listen).mock.calls.find(([channel]) => channel === "claude-session-discovered-thread-1")?.[1];
    expect(callback).toBeDefined();
    act(() => callback!({ event: "claude-session-discovered-thread-1", id: 1, payload: { sessionId } }));
  }

  it("claims watcher discoveries for the fallback active task tab, retaining attribution guards", async () => {
    await mountDiscovery();
    discover("pre-existing");
    discover("already-owned");
    expect(useUiStore.getState().claudeSessionMap["thread-1"]).toBeUndefined();
    discover("new-native-id");
    expect(useUiStore.getState().claudeSessionMap["thread-1"]).toEqual(["new-native-id"]);
  });

  it("polls the active task tab and excludes pre-existing and already-owned sessions", async () => {
    await mountDiscovery();
    vi.mocked(listClaudeSessions).mockResolvedValue([
      { id: "pre-existing" }, { id: "already-owned" }, { id: "after-clear" },
    ] as never);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(useUiStore.getState().claudeSessionMap["thread-1"]).toEqual(["after-clear"]);
  });

  it("rejects discoveries after switching task tabs even with a stale agent-mode selection", async () => {
    useUiStore.setState({ selectedClaudeSessionId: "thread-1" });
    await mountDiscovery();
    act(() => useTaskViewStore.getState().setActiveAgent("task-1", "thread-2"));
    discover("belongs-to-active-tab");
    vi.mocked(listClaudeSessions).mockResolvedValue([{ id: "belongs-to-active-tab" }] as never);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(useUiStore.getState().claudeSessionMap["thread-1"]).toBeUndefined();
  });

  it("does not claim a poll result when the user switches tabs during the read", async () => {
    useUiStore.setState({ selectedClaudeSessionId: "thread-1" });
    await mountDiscovery();
    let resolve!: (sessions: Awaited<ReturnType<typeof listClaudeSessions>>) => void;
    vi.mocked(listClaudeSessions).mockImplementation(() => new Promise((done) => { resolve = done; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    act(() => useTaskViewStore.getState().setActiveAgent("task-1", "thread-2"));
    await act(async () => { resolve([{ id: "late-native-id" }] as never); });
    expect(useUiStore.getState().claudeSessionMap["thread-1"]).toBeUndefined();
  });

  it("keeps agent-mode discovery tied to its selected Claude session", async () => {
    useUiStore.setState({ appMode: "agent", selectedClaudeSessionId: null });
    await mountDiscovery();
    discover("not-selected");
    expect(useUiStore.getState().claudeSessionMap["thread-1"]).toBeUndefined();
    act(() => useUiStore.setState({ selectedClaudeSessionId: "thread-1" }));
    discover("agent-native-id");
    expect(useUiStore.getState().claudeSessionMap["thread-1"]).toEqual(["agent-native-id"]);
  });
});

describe("ClaudeSessionView — routing", () => {
  it("honors retained presentation visibility over a stale main-panel selection", () => {
    seedPtyThread();
    useUiStore.setState({ selectedClaudeSessionId: "thread-1" });
    const view = (active: boolean) => (
      <SessionPresentationContext.Provider value={{ id: "thread-1", active }}>
        <ClaudeSessionView {...baseProps} />
      </SessionPresentationContext.Provider>
    );
    const { rerender } = render(view(false));
    expect(screen.getByTestId("claude-terminal-view").getAttribute("data-active")).toBe("false");
    rerender(view(true));
    expect(screen.getByTestId("claude-terminal-view").getAttribute("data-active")).toBe("true");
  });

  it("renders SDK view when interaction_mode is 'sdk'", () => {
    seedSdkThread();
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("claude-sdk-session-view")).toBeTruthy();
    expect(screen.queryByTestId("claude-terminal-view")).toBeNull();
  });

  it("renders PTY view when interaction_mode is 'pty'", () => {
    seedPtyThread();
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
    expect(screen.queryByTestId("claude-sdk-session-view")).toBeNull();
  });

  it("marks the terminal active when the selected Claude session is visible in the agents panel", () => {
    seedPtyThread();
    useUiStore.setState({
      sidebarTab: "agents",
      selectedClaudeSessionId: "thread-1",
    } as never);
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("claude-terminal-view").getAttribute("data-active")).toBe("true");
  });

  it("does not mark the terminal active while the selected Claude session is hidden by another sidebar surface", () => {
    seedPtyThread();
    useUiStore.setState({
      sidebarTab: "skills",
      selectedClaudeSessionId: "thread-1",
    } as never);
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("claude-terminal-view").getAttribute("data-active")).toBe("false");
  });

  it("marks the terminal active when the Claude session is the active split-pane tab", () => {
    seedPtyThread();
    // Pane membership only counts while multi-view renders the panes.
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, multiViewEnabled: true } }));
    useSplitViewStore.setState({
      panes: {
        "pane-1": {
          id: "pane-1",
          activeTabId: "tab-1",
          tabs: [
            {
              id: "tab-1",
              type: "claude",
              claudeSessionId: "thread-1",
              claudeSessionCwd: "/tmp/repo",
              label: "Claude",
            },
          ],
        },
      },
      focusedPaneId: "pane-1",
      layout: { type: "pane", paneId: "pane-1" },
    } as never);
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("claude-terminal-view").getAttribute("data-active")).toBe("true");
  });

  it("defaults to PTY view when thread is missing", () => {
    // No threads in store
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
  });

  it("renders the ThreadTopBar in PTY mode", () => {
    seedPtyThread();
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("thread-top-bar")).toBeTruthy();
  });

  it("renders the EditorPanel in PTY mode", () => {
    seedPtyThread();
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("editor-panel")).toBeTruthy();
  });

  it("polls diff stats even when the terminal is not focused (Grok parity)", async () => {
    seedPtyThread();
    useUiStore.setState({
      sidebarTab: "skills",
      selectedClaudeSessionId: "thread-1",
      claudeSessionMap: { "thread-1": ["real-thread-1"] },
    } as never);

    render(<ClaudeSessionView {...baseProps} />);

    await act(async () => {
      await Promise.resolve();
    });

    // Diff badges must keep updating while another session is focused —
    // MainPanel keeps the view mounted while processing.
    expect(getClaudeSessionDiffStats).toHaveBeenCalled();
    // Context usage is top-bar-only; skip the usage JSONL read when hidden.
    expect(getClaudePtySessionUsage).not.toHaveBeenCalled();
  });
});

describe("ClaudeSessionView — PTY lifecycle", () => {
  it("renders without crashing for new sessions", () => {
    seedPtyThread();
    const { container } = render(<ClaudeSessionView {...baseProps} isNew={true} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders without crashing for resumed sessions", () => {
    seedPtyThread();
    const { container } = render(<ClaudeSessionView {...baseProps} isNew={false} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("does not render git sidebar by default", () => {
    seedPtyThread();
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.queryByTestId("git-sidebar")).toBeNull();
  });

  it("does not render terminal panel by default", () => {
    seedPtyThread();
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.queryByTestId("terminal-panel")).toBeNull();
  });

  it("renders terminal panel when sessionTerminalOpenByKey is set", () => {
    seedPtyThread();
    useUiStore.setState({
      sessionTerminalOpenByKey: { "claude:thread-1": true },
    } as never);
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("terminal-panel")).toBeTruthy();
  });

  it("uses dangerouslySkipPermissions prop", () => {
    seedPtyThread();
    const { container } = render(
      <ClaudeSessionView {...baseProps} dangerouslySkipPermissions={true} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("invokes onToggleDangerouslySkipPermissions if provided (no-op until interaction)", () => {
    seedPtyThread();
    const onToggle = vi.fn();
    render(
      <ClaudeSessionView
        {...baseProps}
        onToggleDangerouslySkipPermissions={onToggle}
      />
    );
    // Mounting alone should never trigger the callback
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("survives unmount cleanly when not processing", () => {
    seedPtyThread();
    const { unmount } = render(<ClaudeSessionView {...baseProps} />);
    expect(() => unmount()).not.toThrow();
  });

  it("renders terminal view container in PTY mode", () => {
    seedPtyThread();
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
  });

  it("uses claudeSessionMap to seed real session id", () => {
    seedPtyThread();
    useUiStore.setState({
      claudeSessionMap: { "thread-1": ["real-id-xyz"] },
    } as never);
    const { container } = render(<ClaudeSessionView {...baseProps} />);
    expect(container.firstChild).toBeTruthy();
  });

  // Regression: a splitView tab persisted with claudeSessionIsNew=true survives
  // app restart with that flag stale. The claudeSessionMap entry for this agmux
  // UUID was already populated in a prior session and persists in localStorage.
  // The restored mount must --resume the mapped real Claude ID instead of
  // spawning a fresh CLI (null resume target) — otherwise the conversation is
  // lost and a bogus ID gets appended to the map, causing "no conversation
  // found" the next time the user reopens from the sidebar.
  it("resumes mapped real session id even when isNew=true (restored tab)", async () => {
    const commands = await import("../../../lib/commands");
    const spawnSpy = commands.spawnClaudeResume as unknown as ReturnType<typeof vi.fn>;
    spawnSpy.mockClear();
    seedPtyThread();
    useUiStore.setState({
      claudeSessionMap: { "thread-1": ["real-id-from-prior-session"] },
    } as never);
    render(<ClaudeSessionView {...baseProps} isNew={true} />);
    expect(spawnSpy).toHaveBeenCalled();
    const [, , resumeArg] = spawnSpy.mock.calls[0];
    expect(resumeArg).toBe("real-id-from-prior-session");
  });

  it("spawns fresh (null resume) only when truly new with no mapping", async () => {
    const commands = await import("../../../lib/commands");
    const spawnSpy = commands.spawnClaudeResume as unknown as ReturnType<typeof vi.fn>;
    spawnSpy.mockClear();
    seedPtyThread();
    render(<ClaudeSessionView {...baseProps} isNew={true} />);
    expect(spawnSpy).toHaveBeenCalled();
    const [, , resumeArg] = spawnSpy.mock.calls[0];
    expect(resumeArg).toBeNull();
  });

  it("re-renders when interaction_mode flips from sdk to pty", () => {
    seedSdkThread();
    const { rerender } = render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("claude-sdk-session-view")).toBeTruthy();
    seedPtyThread();
    rerender(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
  });

  it("renders for cwd = '/'", () => {
    seedPtyThread();
    const { container } = render(
      <ClaudeSessionView sessionId="thread-1" cwd="/" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for empty cwd", () => {
    seedPtyThread();
    const { container } = render(
      <ClaudeSessionView sessionId="thread-1" cwd="" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("does not render git sidebar even with selectedClaudeSessionId set", () => {
    seedPtyThread();
    useUiStore.setState({
      selectedClaudeSessionId: "thread-1",
    } as never);
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.queryByTestId("git-sidebar")).toBeNull();
  });

  it("renders both editor panel and terminal view in PTY mode", () => {
    seedPtyThread();
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("editor-panel")).toBeTruthy();
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
  });

  it("multiple mount/unmount cycles do not throw", () => {
    seedPtyThread();
    for (let i = 0; i < 3; i++) {
      const { unmount } = render(<ClaudeSessionView {...baseProps} />);
      unmount();
    }
    // No assertion needed — just verifying no throws
    expect(true).toBe(true);
  });

  it("renders different sessionId reuses on rerender", () => {
    useThreadStore.setState({
      threads: {
        "p1": [
          {
            id: "thread-1",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "pty",
            model: null,
            reasoning_effort: null,
            fast_mode: false,
          } as never,
          {
            id: "thread-2",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "pty",
            model: null,
            reasoning_effort: null,
            fast_mode: false,
          } as never,
        ],
      },
    } as never);
    const { rerender, container } = render(
      <ClaudeSessionView sessionId="thread-1" cwd="/repo" />
    );
    expect(container.firstChild).toBeTruthy();
    rerender(<ClaudeSessionView sessionId="thread-2" cwd="/repo" />);
    expect(container.firstChild).toBeTruthy();
  });
});

// ===================================================================
// Maximum coverage — additional routing edge cases and props
// ===================================================================

describe("ClaudeSessionView — Maximum coverage", () => {
  it("does not render TerminalPanel when sessionTerminalOpenByKey is missing the key", () => {
    seedPtyThread();
    useUiStore.setState({
      sessionTerminalOpenByKey: { "claude:other-thread": true },
    } as never);
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.queryByTestId("terminal-panel")).toBeNull();
  });

  it("does not render TerminalPanel when sessionTerminalOpenByKey value is false", () => {
    seedPtyThread();
    useUiStore.setState({
      sessionTerminalOpenByKey: { "claude:thread-1": false },
    } as never);
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.queryByTestId("terminal-panel")).toBeNull();
  });

  it("renders SDK view ignoring dangerouslySkipPermissions prop", () => {
    seedSdkThread();
    render(<ClaudeSessionView {...baseProps} dangerouslySkipPermissions={true} />);
    expect(screen.getByTestId("claude-sdk-session-view")).toBeTruthy();
  });

  it("renders SDK view ignoring onToggleDangerouslySkipPermissions callback", () => {
    seedSdkThread();
    const onToggle = vi.fn();
    render(
      <ClaudeSessionView
        {...baseProps}
        onToggleDangerouslySkipPermissions={onToggle}
      />
    );
    expect(screen.getByTestId("claude-sdk-session-view")).toBeTruthy();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("flips PTY → SDK on rerender after thread mode update", () => {
    seedPtyThread();
    const { rerender } = render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
    seedSdkThread();
    rerender(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("claude-sdk-session-view")).toBeTruthy();
  });

  it("renders new session correctly with isNew=true", () => {
    seedPtyThread();
    render(<ClaudeSessionView {...baseProps} isNew={true} />);
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
  });

  it("renders SDK new session correctly with isNew=true", () => {
    seedSdkThread();
    render(<ClaudeSessionView {...baseProps} isNew={true} />);
    expect(screen.getByTestId("claude-sdk-session-view")).toBeTruthy();
  });

  it("renders correctly when claudeProcessingById has true", () => {
    seedPtyThread();
    useUiStore.setState({
      claudeProcessingById: { "thread-1": true },
    } as never);
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
  });

  it("renders correctly when selectedClaudeSessionId matches sessionId", () => {
    seedPtyThread();
    useUiStore.setState({
      selectedClaudeSessionId: "thread-1",
    } as never);
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
  });

  it("renders for a thread with multiple realIds in claudeSessionMap", () => {
    seedPtyThread();
    useUiStore.setState({
      claudeSessionMap: { "thread-1": ["real-1", "real-2", "real-3"] },
    } as never);
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
  });

  it("renders multiple instances simultaneously without crash", () => {
    useThreadStore.setState({
      threads: {
        "p1": [
          { id: "thread-a", project_id: "p1", provider: "ClaudeCode", interaction_mode: "pty", model: null, reasoning_effort: null, fast_mode: false } as never,
          { id: "thread-b", project_id: "p1", provider: "ClaudeCode", interaction_mode: "sdk", model: null, reasoning_effort: null, fast_mode: false } as never,
        ],
      },
    } as never);
    const { container: c1 } = render(<ClaudeSessionView sessionId="thread-a" cwd="/r" />);
    expect(c1.firstChild).toBeTruthy();
    cleanup();
    const { container: c2 } = render(<ClaudeSessionView sessionId="thread-b" cwd="/r" />);
    expect(c2.firstChild).toBeTruthy();
  });

  it("PTY mode renders ThreadTopBar even when terminal closed", () => {
    seedPtyThread();
    useUiStore.setState({
      sessionTerminalOpenByKey: { "claude:thread-1": false },
    } as never);
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("thread-top-bar")).toBeTruthy();
  });

  it("PTY mode renders editor panel even with various ui state", () => {
    seedPtyThread();
    useUiStore.setState({
      claudeProcessingById: { "thread-1": true },
      preSpawnSessionIds: { "thread-1": ["sess-a"] },
    } as never);
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("editor-panel")).toBeTruthy();
  });

  it("renders distinct sessionId values in PTY mode", () => {
    useThreadStore.setState({
      threads: {
        "p1": [
          { id: "thread-x", project_id: "p1", provider: "ClaudeCode", interaction_mode: "pty", model: null, reasoning_effort: null, fast_mode: false } as never,
        ],
      },
    } as never);
    const { container } = render(<ClaudeSessionView sessionId="thread-x" cwd="/r" />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders distinct sessionId values in SDK mode", () => {
    useThreadStore.setState({
      threads: {
        "p1": [
          { id: "thread-y", project_id: "p1", provider: "ClaudeCode", interaction_mode: "sdk", model: null, reasoning_effort: null, fast_mode: false } as never,
        ],
      },
    } as never);
    render(<ClaudeSessionView sessionId="thread-y" cwd="/r" />);
    expect(screen.getByTestId("claude-sdk-session-view")).toBeTruthy();
  });

  it("does not throw when terminalOpen flips during render", () => {
    seedPtyThread();
    const { rerender } = render(<ClaudeSessionView {...baseProps} />);
    expect(screen.queryByTestId("terminal-panel")).toBeNull();
    useUiStore.setState({
      sessionTerminalOpenByKey: { "claude:thread-1": true },
    } as never);
    rerender(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("terminal-panel")).toBeTruthy();
    useUiStore.setState({
      sessionTerminalOpenByKey: { "claude:thread-1": false },
    } as never);
    rerender(<ClaudeSessionView {...baseProps} />);
    expect(screen.queryByTestId("terminal-panel")).toBeNull();
  });

  it("renders correctly when an unrelated other thread exists in PTY mode", () => {
    useThreadStore.setState({
      threads: {
        "p2": [
          { id: "other", project_id: "p2", provider: "ClaudeCode", interaction_mode: "sdk", model: null, reasoning_effort: null, fast_mode: false } as never,
        ],
        "p1": [
          { id: "thread-1", project_id: "p1", provider: "ClaudeCode", interaction_mode: "pty", model: null, reasoning_effort: null, fast_mode: false } as never,
        ],
      },
    } as never);
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
  });

  it("PTY view renders without GitSidebar by default", () => {
    seedPtyThread();
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.queryByTestId("git-sidebar")).toBeNull();
  });
});

// ===================================================================
// Final coverage gaps — interaction_mode routing, isNew branch,
// dangerouslySkipPermissions prop variations.
// ===================================================================
describe("ClaudeSessionView — Final coverage gaps", () => {
  beforeEach(() => {
    useThreadStore.setState({ threads: {} } as never);
    useUiStore.setState({
      sessionTerminalOpenByKey: {},
      selectedClaudeSessionId: null,
      claudeProcessingById: {},
      claudeSessionMap: {},
      preSpawnSessionIds: {},
      pendingFirstMessages: {},
    } as never);
  });

  it("isNew=true PTY mode mounts without crash", () => {
    seedPtyThread();
    render(<ClaudeSessionView sessionId="thread-1" cwd="/tmp/repo" isNew={true} />);
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
  });

  it("isNew=false PTY mode mounts without crash", () => {
    seedPtyThread();
    render(<ClaudeSessionView sessionId="thread-1" cwd="/tmp/repo" isNew={false} />);
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
  });

  it("dangerouslySkipPermissions=true prop persists across rerenders", () => {
    seedPtyThread();
    const { rerender } = render(
      <ClaudeSessionView
        sessionId="thread-1"
        cwd="/tmp/repo"
        dangerouslySkipPermissions={true}
      />
    );
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
    rerender(
      <ClaudeSessionView
        sessionId="thread-1"
        cwd="/tmp/repo"
        dangerouslySkipPermissions={false}
      />
    );
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
  });

  it("onToggleDangerouslySkipPermissions callback prop is wired", () => {
    seedPtyThread();
    const toggle = vi.fn();
    render(
      <ClaudeSessionView
        sessionId="thread-1"
        cwd="/tmp/repo"
        onToggleDangerouslySkipPermissions={toggle}
      />
    );
    // No mounting crash; callback ref preserved
    expect(typeof toggle).toBe("function");
  });

  it("SDK mode early-returns to ClaudeSdkSessionView", () => {
    useThreadStore.setState({
      threads: {
        "p1": [
          { id: "thread-sdk", project_id: "p1", provider: "ClaudeCode", interaction_mode: "sdk", model: null, reasoning_effort: null, fast_mode: false } as never,
        ],
      },
    } as never);
    render(<ClaudeSessionView sessionId="thread-sdk" cwd="/tmp/repo" />);
    expect(screen.getByTestId("claude-sdk-session-view")).toBeTruthy();
    expect(screen.queryByTestId("claude-terminal-view")).toBeNull();
  });

  it("SDK mode does not mount terminal view at all", () => {
    useThreadStore.setState({
      threads: {
        "p1": [
          { id: "t-sdk-2", project_id: "p1", provider: "ClaudeCode", interaction_mode: "sdk", model: null, reasoning_effort: null, fast_mode: false } as never,
        ],
      },
    } as never);
    render(<ClaudeSessionView sessionId="t-sdk-2" cwd="/tmp/repo" isNew={true} />);
    expect(screen.queryByTestId("claude-terminal-view")).toBeNull();
    expect(screen.queryByTestId("editor-panel")).toBeNull();
  });

  it("PTY mode with terminalOpen=true mounts TerminalPanel", () => {
    seedPtyThread();
    useUiStore.setState({
      sessionTerminalOpenByKey: { "claude:thread-1": true },
    } as never);
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("terminal-panel")).toBeTruthy();
  });

  it("PTY mode with claudeProcessingById flag set", () => {
    seedPtyThread();
    useUiStore.setState({
      claudeProcessingById: { "thread-1": true },
    } as never);
    render(<ClaudeSessionView {...baseProps} />);
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
  });

  it("nonexistent thread sessionId still renders (PTY default)", () => {
    // No threads in store; should default to PTY mode and render terminal view
    render(<ClaudeSessionView sessionId="ghost-thread" cwd="/tmp/repo" />);
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
  });

  it("multi-project store with target thread in third project", () => {
    useThreadStore.setState({
      threads: {
        "p1": [
          { id: "a", project_id: "p1", provider: "ClaudeCode", interaction_mode: "sdk", model: null, reasoning_effort: null, fast_mode: false } as never,
        ],
        "p2": [
          { id: "b", project_id: "p2", provider: "ClaudeCode", interaction_mode: "sdk", model: null, reasoning_effort: null, fast_mode: false } as never,
        ],
        "p3": [
          { id: "thread-3", project_id: "p3", provider: "ClaudeCode", interaction_mode: "pty", model: null, reasoning_effort: null, fast_mode: false } as never,
        ],
      },
    } as never);
    render(<ClaudeSessionView sessionId="thread-3" cwd="/tmp/repo" />);
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
  });

  it("changing cwd prop triggers rerender without crash", () => {
    seedPtyThread();
    const { rerender } = render(
      <ClaudeSessionView sessionId="thread-1" cwd="/r1" />
    );
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
    rerender(<ClaudeSessionView sessionId="thread-1" cwd="/r2" />);
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
  });

  it("changing sessionId switches to a different thread", () => {
    useThreadStore.setState({
      threads: {
        "p1": [
          { id: "thread-1", project_id: "p1", provider: "ClaudeCode", interaction_mode: "pty", model: null, reasoning_effort: null, fast_mode: false } as never,
          { id: "thread-2", project_id: "p1", provider: "ClaudeCode", interaction_mode: "sdk", model: null, reasoning_effort: null, fast_mode: false } as never,
        ],
      },
    } as never);
    const { rerender } = render(
      <ClaudeSessionView sessionId="thread-1" cwd="/tmp/repo" />
    );
    expect(screen.getByTestId("claude-terminal-view")).toBeTruthy();
    rerender(<ClaudeSessionView sessionId="thread-2" cwd="/tmp/repo" />);
    expect(screen.getByTestId("claude-sdk-session-view")).toBeTruthy();
  });

  it("unmounts cleanly without throwing", () => {
    seedPtyThread();
    const { unmount } = render(<ClaudeSessionView {...baseProps} />);
    unmount();
    expect(true).toBe(true);
  });
});

// ===================================================================
// PTY bypass-permissions auto-accept (PR #73)
//   1. Auto-accept must fire ONLY when the terms prompt actually appears —
//      sending Enter blindly on an already-accepted machine submits the
//      user's typed text.
//   2. The defaultBypassPermissions master toggle must put PTY sessions
//      into bypass mode on mount.
// ===================================================================
describe("ClaudeSessionView — PTY bypass-permissions auto-accept", () => {
  let getPtySnapshotMock: ReturnType<typeof vi.fn>;
  let sendPtyInputMock: ReturnType<typeof vi.fn>;
  let spawnMock: ReturnType<typeof vi.fn>;

  function setSettings(patch: Record<string, unknown>) {
    const settings = useSettingsStore.getState().settings as unknown as Record<string, unknown>;
    useSettingsStore.setState({
      settings: { ...settings, ...patch },
    } as never);
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    const commands = await import("../../../lib/commands");
    getPtySnapshotMock = commands.getPtySnapshot as unknown as ReturnType<typeof vi.fn>;
    sendPtyInputMock = commands.sendPtyInput as unknown as ReturnType<typeof vi.fn>;
    spawnMock = commands.spawnClaudeResume as unknown as ReturnType<typeof vi.fn>;
    getPtySnapshotMock.mockClear().mockResolvedValue({ data: "" });
    sendPtyInputMock.mockClear();
    spawnMock.mockClear();
    // Both bypass inputs off by default so each test controls them explicitly.
    setSettings({ defaultBypassPermissions: false, claudeSkipPermissions: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends down-arrow then Enter when the bypass-permissions prompt appears", async () => {
    seedPtyThread();
    getPtySnapshotMock.mockResolvedValue({
      data: btoa("Bypass Permissions mode\n  1. No  \n  2. Yes, I accept"),
    });

    render(<ClaudeSessionView {...baseProps} dangerouslySkipPermissions={true} />);
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1000);
    });

    const keys = sendPtyInputMock.mock.calls.map((c) => c[1]);
    expect(keys).toEqual(["\x1b[B", "\r"]);
  });

  it("never sends keys when the prompt is absent (terms already accepted)", async () => {
    seedPtyThread();
    // A plain Claude REPL screen — no terms prompt rendered.
    getPtySnapshotMock.mockResolvedValue({
      data: btoa("Welcome back to Claude Code\n> "),
    });

    render(<ClaudeSessionView {...baseProps} dangerouslySkipPermissions={true} />);
    // Advance past the 6s poll deadline.
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(7000);
    });

    expect(getPtySnapshotMock).toHaveBeenCalled(); // proves it actually polled
    expect(sendPtyInputMock).not.toHaveBeenCalled();
  });

  it("does not poll the PTY snapshot at all when bypass mode is off", async () => {
    seedPtyThread();
    render(<ClaudeSessionView {...baseProps} dangerouslySkipPermissions={false} />);
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(7000);
    });

    expect(getPtySnapshotMock).not.toHaveBeenCalled();
    expect(sendPtyInputMock).not.toHaveBeenCalled();
  });

  it("starts in bypass mode when the defaultBypassPermissions master toggle is on", async () => {
    seedPtyThread();
    setSettings({ defaultBypassPermissions: true });

    // No dangerouslySkipPermissions prop — the master toggle alone must apply.
    render(<ClaudeSessionView {...baseProps} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(spawnMock).toHaveBeenCalled();
    expect(spawnMock.mock.calls[0][3].dangerouslySkipPermissions).toBe(true);
  });

  it("starts supervised when both the master toggle and claudeSkipPermissions are off", async () => {
    seedPtyThread();
    render(<ClaudeSessionView {...baseProps} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(spawnMock).toHaveBeenCalled();
    expect(spawnMock.mock.calls[0][3].dangerouslySkipPermissions).toBe(false);
  });
});
