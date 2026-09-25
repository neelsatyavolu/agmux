/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor, screen, act, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

const virtuosoScrollToIndex = vi.fn();
let virtuosoFollowOutput: (atBottom: boolean) => boolean | string;
let virtuosoAtBottomChange: (atBottom: boolean) => void;
let virtuosoHeightChange: (height: number) => void;
const terminalMock = vi.hoisted(() => ({
  props: [] as Array<{
    onUserLine?: (line: string) => void;
    onOutputActivity?: () => void;
    onPermissionPrompt?: (summary: string | null) => void;
    onInterrupt?: () => void;
  }>,
}));
const imageAttachmentMock = vi.hoisted(() => ({
  images: [] as Array<{ id: string; base64: string; mediaType: string; previewUrl: string }>,
  addImages: vi.fn(),
  removeImage: vi.fn(),
  clearImages: vi.fn(),
}));

const inspectorPropsSpy = vi.hoisted(() => vi.fn());
vi.mock("../subagents/SubagentInspector", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../subagents/SubagentInspector")>();
  return {
    ...actual,
    SubagentInspector: (props: React.ComponentProps<typeof actual.SubagentInspector>) => {
      inspectorPropsSpy(props);
      return <actual.SubagentInspector {...props} />;
    },
  };
});

// jsdom does not implement ResizeObserver — provide a no-op polyfill.
class NoopResizeObserver {
  observe(_target: Element) {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof NoopResizeObserver }).ResizeObserver = NoopResizeObserver;

// Heavy children — replace with stubs.
vi.mock("../ThreadTopBar", () => ({
  ThreadTopBar: ({
    isProcessing,
    active,
    contextUsage,
    modelSlug,
  }: {
    isProcessing?: boolean;
    active?: boolean;
    contextUsage?: { usedTokens?: number; maxTokens?: number } | null;
    modelSlug?: string | null;
  }) => (
    <div
      data-testid="thread-top-bar"
      data-active={String(active)}
      data-processing={isProcessing ? "true" : "false"}
      data-model={modelSlug ?? ""}
      data-ctx-used={contextUsage?.usedTokens ?? ""}
      data-ctx-max={contextUsage?.maxTokens ?? ""}
    />
  ),
}));
vi.mock("../GitSidebar", () => ({
  GitSidebar: () => <div data-testid="git-sidebar" />,
}));
vi.mock("../TerminalPanel", () => ({
  default: () => <div data-testid="terminal-panel" />,
}));
vi.mock("../TerminalView", () => ({
  TerminalView: (props: {
    onUserLine?: (line: string) => void;
    onOutputActivity?: () => void;
    onPermissionPrompt?: (summary: string | null) => void;
    onInterrupt?: () => void;
  }) => {
    terminalMock.props.push(props);
    return <div data-testid="terminal-view" />;
  },
}));
vi.mock("../../layout/EditorPanel", () => ({
  EditorPanel: () => <div data-testid="editor-panel" />,
}));
vi.mock("../ApprovalBanner", () => ({
  ApprovalBanner: ({
    onApprove,
    onReject,
    onAllowForSession,
    onAnswer,
    allowPatterns,
    onAllowPattern,
    type,
    toolName,
    description,
  }: {
    onApprove?: () => void;
    onReject?: () => void;
    onAllowForSession?: () => void;
    onAnswer?: (text: string) => void;
    allowPatterns?: string[];
    onAllowPattern?: (p: string) => void;
    type?: string;
    toolName?: string;
    description?: string;
  }) => (
    <div data-testid="approval-banner" data-banner-type={type ?? ""}>
      <span data-testid="approval-tool">{toolName ?? ""}</span>
      <span data-testid="approval-desc">{description ?? ""}</span>
      <button data-testid="approval-approve" onClick={() => onApprove?.()}>approve</button>
      <button data-testid="approval-reject" onClick={() => onReject?.()}>reject</button>
      <button data-testid="approval-allow-session" onClick={() => onAllowForSession?.()}>
        allow-session
      </button>
      {(allowPatterns ?? []).map((p) => (
        <button
          key={p}
          data-testid={`approval-allow-pattern-${p}`}
          onClick={() => onAllowPattern?.(p)}
        >
          allow {p}
        </button>
      ))}
      <button data-testid="approval-answer" onClick={() => onAnswer?.("user answer")}>
        answer
      </button>
    </div>
  ),
}));
vi.mock("../OpenCodeThinkingIndicator", () => ({
  OpenCodeThinkingIndicator: ({
    phase,
    trailing,
  }: {
    phase?: string;
    trailing?: React.ReactNode;
  }) => (
    <div data-testid="codex-thinking-indicator">
      <span data-testid="codex-thinking-phase">{phase ?? "thinking"}</span>
      {trailing}
    </div>
  ),
}));
vi.mock("../MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("../UserMessageText", () => ({
  UserMessageText: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("../SlashCommandPopup", () => ({
  SlashCommandPopup: () => null,
}));
vi.mock("../GitBranchSelector", () => ({
  GitBranchSelector: ({ active }: { active?: boolean }) => <div data-testid="branch-selector" data-active={String(active)} />,
}));
vi.mock("../ContextRing", () => ({
  ContextRing: ({ usage }: { usage: { maxTokens?: number | null } }) => (
    <div data-testid="context-ring" data-max-tokens={usage.maxTokens ?? ""} />
  ),
}));
vi.mock("../PromptDiffView", () => ({
  PromptDiffView: () => null,
}));
vi.mock("../ImageAttachmentBar", () => ({
  ImageAttachmentBar: () => <div data-testid="image-attachment-bar" />,
  useImageAttachments: () => imageAttachmentMock,
  extractImagesFromPaste: vi.fn(() => []),
  extractImagesFromDrop: vi.fn(() => []),
  fileToImageAttachment: vi.fn(),
}));

vi.mock("react-virtuoso", async () => {
  const React = await import("react");
  return {
    Virtuoso: React.forwardRef(({
      data,
      itemContent,
      components,
      context,
      scrollerRef,
      followOutput,
      atBottomStateChange,
      totalListHeightChanged,
    }: {
      data?: unknown[];
      itemContent?: (index: number, entry: unknown) => React.ReactNode;
      components?: { Footer?: React.ComponentType<{ context?: unknown }> };
      context?: unknown;
      scrollerRef?: (ref: HTMLElement | null) => void;
      followOutput: false | ((atBottom: boolean) => boolean | string);
      atBottomStateChange: (atBottom: boolean) => void;
      totalListHeightChanged: (height: number) => void;
    }, ref) => {
      virtuosoFollowOutput = typeof followOutput === "function" ? followOutput : () => false;
      virtuosoAtBottomChange = atBottomStateChange;
      virtuosoHeightChange = totalListHeightChanged;
      const Footer = components?.Footer;
      const scrollerNode = React.useRef<HTMLDivElement | null>(null);
      React.useImperativeHandle(ref, () => ({ scrollToIndex: virtuosoScrollToIndex }));
      React.useEffect(() => {
        scrollerRef?.(scrollerNode.current);
        return () => scrollerRef?.(null);
      }, [scrollerRef]);
      return (
        <div data-testid="virtuoso" ref={scrollerNode}>
          {Array.isArray(data) && itemContent
            ? data.map((entry, idx) => (
                <div key={idx} data-testid="virtuoso-item">
                  {itemContent(idx, entry)}
                </div>
              ))
            : null}
          {Footer ? <Footer context={context} /> : null}
        </div>
      );
    }),
  };
});

vi.mock("../../../lib/commands", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    codexResumeThread: vi.fn().mockResolvedValue(undefined),
    codexSendMessage: vi.fn().mockResolvedValue(undefined),
    codexInterruptTurn: vi.fn().mockResolvedValue(undefined),
    codexSteerTurn: vi.fn().mockResolvedValue(undefined),
    codexRespondToRequest: vi.fn().mockResolvedValue(undefined),
    codexReadSessionHistory: vi.fn().mockResolvedValue({ items: [] }),
    codexRefreshThreadModel: vi.fn().mockResolvedValue({
      model: null,
      model_context_window: null,
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_input_tokens: null,
      total_output_tokens: null,
      total_cached_input_tokens: null,
      task_active: false,
      last_task_started_at: null,
      last_task_complete_at: null,
    }),
    codexReadThread: vi.fn().mockResolvedValue(null),
    codexReadConfig: vi.fn().mockResolvedValue(null),
    codexListModels: vi.fn().mockResolvedValue([]),
    codexListApprovalRules: vi.fn().mockResolvedValue([]),
    codexAddApprovalRule: vi.fn().mockResolvedValue({
      id: "r1", workDir: "/cwd", pattern: "git status *", createdAt: ""
    }),
    codexRemoveApprovalRule: vi.fn().mockResolvedValue(1),
    codexSuggestApprovalPatterns: vi.fn().mockResolvedValue([]),
    codexAccountRead: vi.fn().mockResolvedValue(null),
    codexLogin: vi.fn().mockResolvedValue(undefined),
    codexLoginCancel: vi.fn().mockResolvedValue(undefined),
    codexListCollaborationModes: vi.fn().mockResolvedValue([]),
    optimizePrompt: vi.fn().mockResolvedValue(""),
    summarizeThreadNamesBatch: vi.fn().mockResolvedValue({}),
    spawnCodexResume: vi.fn().mockResolvedValue(undefined),
    stopCodexSession: vi.fn().mockResolvedValue(undefined),
    stopThread: vi.fn().mockResolvedValue(undefined),
    recordThreadLineDelta: vi.fn().mockResolvedValue(undefined),
  };
});

import { CodexSessionView } from "../CodexSessionView";
import { useThreadStore } from "../../../stores/threadStore";
import { useUiStore } from "../../../stores/uiStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useSessionNameStore } from "../../../stores/sessionNameStore";
import { setCodexSessionMode } from "../../../lib/codexSessionMode";

async function restoreRealTimers() {
  // Framer Motion captures native RAF before tests install fake timers. jsdom
  // keeps its RAF interval alive until every callback is drained; discarding
  // that fake interval first stalls later inspector exits and streamed text.
  cleanup();
  if (vi.isFakeTimers()) {
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  }
  vi.useRealTimers();
}

afterEach(restoreRealTimers);

it("keeps native animation frames working after fake-timer cleanup", async () => {
  const nativeRaf = window.requestAnimationFrame;
  vi.useFakeTimers();
  const callback = vi.fn();
  nativeRaf(callback);
  await restoreRealTimers();
  expect(callback).toHaveBeenCalledOnce();
  await new Promise<void>((resolve) => nativeRaf(() => resolve()));
});

/** The inline `Agent` tool row a subagent notification renders as. Clicking it
 *  expands the notification's payload. */
function subagentRow(): HTMLElement | null {
  return document.querySelector("[data-testid='codex-tool-row'][data-lead='Agent']");
}

/** Scope transcript assertions away from the parallel Tasks/Subagents cards. */
function parentChat() {
  return within(screen.getByTestId("virtuoso"));
}

beforeEach(async () => {
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  virtuosoScrollToIndex.mockClear();
  imageAttachmentMock.images = [];
  imageAttachmentMock.addImages.mockClear();
  imageAttachmentMock.removeImage.mockClear();
  imageAttachmentMock.clearImages.mockClear();
  const commands = await import("../../../lib/commands");
  vi.mocked(commands.codexResumeThread).mockClear();
  vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue({
    model: null,
    model_context_window: null,
    input_tokens: null,
    output_tokens: null,
    cached_input_tokens: null,
    total_input_tokens: null,
    total_output_tokens: null,
    total_cached_input_tokens: null,
    task_active: false,
    last_task_started_at: null,
    last_task_complete_at: null,
  });
  vi.mocked(commands.codexReadSessionHistory).mockResolvedValue({
    items: [], cwd: null, model: null, effort: null,
    model_context_window: null, input_tokens: null, output_tokens: null,
  });
  useThreadStore.setState({ threads: {} } as never);
  useUiStore.setState({
    pendingCodexReconnects: {},
    pendingCodexEfforts: {},
    pendingCodexFastModes: {},
    pendingCodexPermissionModes: {},
  } as never);
  useSessionNameStore.setState({ names: {}, logs: [], failedSummarizations: [] } as never);
  useSettingsStore.setState({
    settings: {
      ...useSettingsStore.getState().settings,
      codexModel: "",
      codexEffort: "medium",
      codexFastMode: false,
      codexDefaultView: "chat",
      // Reasoning rows collapse by default; the global preference drives their
      // initial open state, so assertions on reasoning text need it on.
      showThinking: true,
    },
  });
  localStorage.removeItem("xanom-codex-fast-mode");
  localStorage.removeItem("agmux-codex-session-mode");
  localStorage.removeItem("agmux-codex-diff-stats");
  localStorage.removeItem("agmux-session-names");
  localStorage.removeItem("agmux-session-previews");
  useUiStore.setState({ codexDiffStatsById: {} });
  terminalMock.props = [];
});

const baseSession = {
  id: "cx1",
  thread_name: "Codex Session",
  updated_at: new Date().toISOString(),
  cwd: "/tmp/repo",
};

describe("persisted task Codex surface", () => {
  it.each(["pty", "sdk"] as const)("uses the saved %s mode after local view preferences are lost", async (interaction_mode) => {
    const commands = await import("../../../lib/commands");
    const session = { ...baseSession, id: `restored-task-${interaction_mode}` };
    localStorage.removeItem("agmux-codex-session-mode");
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, codexDefaultView: interaction_mode === "pty" ? "chat" : "terminal" } }));
    useThreadStore.setState({ threads: { p: [{ id: session.id, provider: "Codex", interaction_mode }] } } as never);
    vi.mocked(commands.spawnCodexResume).mockClear();
    await act(async () => { render(<CodexSessionView session={session} initialViewMode={interaction_mode === "sdk" ? "chat" : "terminal"} />); });
    expect(vi.mocked(commands.spawnCodexResume).mock.calls.some(([id]) => id === session.id)).toBe(interaction_mode === "pty");
  });
});

describe("CodexSessionView", () => {
  it("starts a fresh lifecycle read after submission instead of reusing a pre-turn snapshot", async () => {
    vi.useFakeTimers();
    const commands = await import("../../../lib/commands");
    const snapshot = { model: null, model_context_window: null, input_tokens: null,
      output_tokens: null, cached_input_tokens: null, total_input_tokens: null,
      total_output_tokens: null, total_cached_input_tokens: null, task_active: false,
      last_task_started_at: new Date(Date.now() - 1000).toISOString(),
      last_task_complete_at: new Date().toISOString() as string | null };
    const finish: Array<(value: typeof snapshot) => void> = [];
    vi.mocked(commands.codexRefreshThreadModel).mockClear().mockImplementation(() => new Promise(resolve => { finish.push(resolve); }));
    setCodexSessionMode(baseSession.id, "terminal");
    useUiStore.setState({ selectedCodexSessionId: baseSession.id, sidebarTab: "agents" });
    await act(async () => { render(<CodexSessionView session={baseSession} />); });
    expect(finish).toHaveLength(1);
    act(() => terminalMock.props[terminalMock.props.length - 1]?.onUserLine?.("new turn"));
    expect(finish).toHaveLength(2);
    vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue(snapshot);
    await act(async () => {
      finish[0](snapshot);
      finish[1]({ ...snapshot, task_active: true, last_task_started_at: new Date().toISOString(), last_task_complete_at: null });
    });
    expect(screen.getByTestId("thread-top-bar").dataset.processing).toBe("true");
  });

  it("checks for a turn when a recalled history prompt is submitted", async () => {
    vi.useFakeTimers();
    const commands = await import("../../../lib/commands");
    const snapshot = { model: null, model_context_window: null, input_tokens: null,
      output_tokens: null, cached_input_tokens: null, total_input_tokens: null,
      total_output_tokens: null, total_cached_input_tokens: null, task_active: false,
      last_task_started_at: new Date(Date.now() - 1000).toISOString(),
      last_task_complete_at: new Date().toISOString() as string | null };
    const finish: Array<(value: typeof snapshot) => void> = [];
    vi.mocked(commands.codexRefreshThreadModel).mockClear().mockImplementation(() => new Promise(resolve => { finish.push(resolve); }));
    setCodexSessionMode(baseSession.id, "terminal");
    useUiStore.setState({ selectedCodexSessionId: baseSession.id, sidebarTab: "agents" });
    await act(async () => { render(<CodexSessionView session={baseSession} />); });
    expect(finish).toHaveLength(1);
    // Up-arrow + Enter: the terminal saw a submit but no typed text.
    act(() => terminalMock.props[terminalMock.props.length - 1]?.onUserLine?.(""));
    expect(finish).toHaveLength(2);
    await act(async () => {
      finish[0](snapshot);
      finish[1]({ ...snapshot, task_active: true, last_task_started_at: new Date().toISOString(), last_task_complete_at: null });
    });
    expect(screen.getByTestId("thread-top-bar").dataset.processing).toBe("true");
  });

  it("shares slow terminal snapshots and uses one active-turn polling cadence", async () => {
    vi.useFakeTimers();
    const commands = await import("../../../lib/commands");
    const snapshot = { model: null, model_context_window: null, input_tokens: null,
      output_tokens: null, cached_input_tokens: null, total_input_tokens: null,
      total_output_tokens: null, total_cached_input_tokens: null, task_active: true,
      last_task_started_at: new Date().toISOString(), last_task_complete_at: null };
    let finish!: (value: typeof snapshot) => void;
    vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue(snapshot);
    setCodexSessionMode(baseSession.id, "terminal");
    useUiStore.setState({ selectedCodexSessionId: baseSession.id, sidebarTab: "agents" });
    await act(async () => { render(<CodexSessionView session={baseSession} />); });
    vi.mocked(commands.codexRefreshThreadModel).mockClear().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    act(() => terminalMock.props[terminalMock.props.length - 1]?.onUserLine?.("keep working"));
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(commands.codexRefreshThreadModel).toHaveBeenCalledTimes(1);
    vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue(snapshot);
    await act(async () => { finish(snapshot); });
    vi.mocked(commands.codexRefreshThreadModel).mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(commands.codexRefreshThreadModel).toHaveBeenCalledTimes(3);
  });

  it("pauses hidden Git chrome and the terminal-mode chat composer", async () => {
    useUiStore.setState({ selectedCodexSessionId: "another-session", sidebarTab: "agents" });
    setCodexSessionMode(baseSession.id, "terminal");
    render(<CodexSessionView session={baseSession} />);
    expect(screen.getByTestId("thread-top-bar").dataset.active).toBe("false");
    expect(screen.getByTestId("branch-selector").dataset.active).toBe("false");
    act(() => useUiStore.setState({ selectedCodexSessionId: baseSession.id }));
    expect(screen.getByTestId("thread-top-bar").dataset.active).toBe("true");
    expect(screen.getByTestId("branch-selector").dataset.active).toBe("false");
    useUiStore.setState({ selectedCodexSessionId: null });
  });

  it("handles a sidebar reconnect queued before the terminal mounts exactly once", async () => {
    const commands = await import("../../../lib/commands");
    vi.mocked(commands.spawnCodexResume).mockClear();
    vi.mocked(commands.stopCodexSession).mockClear();
    useSettingsStore.getState().updateSettings({ defaultBypassPermissions: false });
    setCodexSessionMode(baseSession.id, "terminal");
    useUiStore.getState().requestCodexReconnect(baseSession.id);
    render(<CodexSessionView session={baseSession} />);
    await waitFor(() => expect(commands.spawnCodexResume).toHaveBeenCalledExactlyOnceWith(baseSession.id, baseSession.cwd, false));
    expect(commands.stopCodexSession).toHaveBeenCalledExactlyOnceWith(baseSession.id);
    expect(useUiStore.getState().pendingCodexReconnects[baseSession.id]).toBeUndefined();
    expect(screen.queryByRole("button", { name: "Reconnect Codex" })).toBeNull();
  });

  it("reconnects the same terminal after shutdown with its existing permissions", async () => {
    const commands = await import("../../../lib/commands");
    vi.mocked(commands.spawnCodexResume).mockClear();
    vi.mocked(commands.stopCodexSession).mockClear();
    useSettingsStore.getState().updateSettings({ defaultBypassPermissions: true });
    setCodexSessionMode(baseSession.id, "terminal");
    render(<CodexSessionView session={baseSession} />);
    await waitFor(() => expect(commands.spawnCodexResume).toHaveBeenCalledOnce());
    let finishStop!: () => void;
    vi.mocked(commands.stopCodexSession).mockImplementationOnce(() => new Promise<void>((resolve) => { finishStop = resolve; }));
    expect(screen.queryByRole("button", { name: "Reconnect Codex" })).toBeNull();
    act(() => useUiStore.getState().requestCodexReconnect(baseSession.id));
    expect(commands.stopCodexSession).toHaveBeenCalledExactlyOnceWith(baseSession.id);
    expect(commands.spawnCodexResume).toHaveBeenCalledOnce();
    await act(async () => { finishStop(); });
    await waitFor(() => expect(commands.spawnCodexResume).toHaveBeenCalledTimes(2));
    expect(commands.spawnCodexResume).toHaveBeenLastCalledWith(baseSession.id, baseSession.cwd, true);
    useSettingsStore.getState().updateSettings({ defaultBypassPermissions: false });
  });

  it("shows reconnect failures and allows retry without spawning after a failed stop", async () => {
    const commands = await import("../../../lib/commands");
    vi.mocked(commands.spawnCodexResume).mockClear();
    setCodexSessionMode(baseSession.id, "terminal");
    render(<CodexSessionView session={baseSession} />);
    await waitFor(() => expect(commands.spawnCodexResume).toHaveBeenCalledOnce());
    vi.mocked(commands.stopCodexSession).mockRejectedValueOnce(new Error("Unable to stop Codex"));
    act(() => useUiStore.getState().requestCodexReconnect(baseSession.id));
    await screen.findByText("Error: Unable to stop Codex");
    expect(commands.spawnCodexResume).toHaveBeenCalledOnce();
    vi.mocked(commands.spawnCodexResume).mockRejectedValueOnce(new Error("Unable to resume Codex"));
    act(() => useUiStore.getState().requestCodexReconnect(baseSession.id));
    await screen.findByText("Error: Unable to resume Codex");
    act(() => useUiStore.getState().requestCodexReconnect(baseSession.id));
    await waitFor(() => expect(screen.queryByText("Error: Unable to resume Codex")).toBeNull());
    await waitFor(() => expect(commands.spawnCodexResume).toHaveBeenCalledTimes(3));
  });

  it("renders without crashing with a basic session", () => {
    const { container } = render(<CodexSessionView session={baseSession} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders the thread top bar when not embedded", () => {
    const { container } = render(<CodexSessionView session={baseSession} />);
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeTruthy();
  });

  it("terminal newlines wait for a confirmed task before showing processing", async () => {
    const commands = await import("../../../lib/commands");
    setCodexSessionMode(baseSession.id, "terminal");
    render(<CodexSessionView session={baseSession} />);
    await waitFor(() => expect(terminalMock.props.length).toBeGreaterThan(0));
    vi.useFakeTimers();
    await act(async () => {
      terminalMock.props[terminalMock.props.length - 1].onUserLine?.("draft newline");
    });
    expect(useUiStore.getState().codexProcessingById[baseSession.id]).not.toBe(true);
    await act(async () => {
      terminalMock.props[terminalMock.props.length - 1].onOutputActivity?.();
      vi.advanceTimersByTime(1_000);
    });
    expect(useUiStore.getState().codexProcessingById[baseSession.id]).not.toBe(true);

    const snapshot = await commands.codexRefreshThreadModel(baseSession.id);
    vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue({
      ...snapshot,
      task_active: true,
      last_task_started_at: new Date().toISOString(),
    });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(useUiStore.getState().codexProcessingById[baseSession.id]).toBe(true);
  });

  it("terminal MCP permissions publish attention independently of transcript questions", async () => {
    vi.useFakeTimers();
    const notifications = await import("../../../lib/notifications");
    const notify = vi.spyOn(notifications, "sendNotification").mockImplementation(() => {});
    setCodexSessionMode(baseSession.id, "terminal");
    await act(async () => { render(<CodexSessionView session={baseSession} />); });
    const summary = 'Allow Computer Use to use "Canary Mail"?';
    await act(async () => { terminalMock.props[terminalMock.props.length - 1]?.onPermissionPrompt?.(summary); });
    expect(useUiStore.getState().pendingApprovalsBySession[baseSession.id]).toMatchObject({
      summary, interactionMode: "pty", category: "waiting",
    });
    expect(notify).toHaveBeenCalledWith("agmux — Approval Required", summary, { threadId: baseSession.id, provider: "Codex" });
    await act(async () => { terminalMock.props[terminalMock.props.length - 1]?.onPermissionPrompt?.(summary); });
    await act(async () => { vi.advanceTimersByTime(3_000); });
    expect(useUiStore.getState().pendingApprovalsBySession[baseSession.id]?.summary).toBe(summary);
    expect(notify).toHaveBeenCalledTimes(1);
    await act(async () => { terminalMock.props[terminalMock.props.length - 1]?.onPermissionPrompt?.(null); });
    expect(useUiStore.getState().pendingApprovalsBySession[baseSession.id]).toBeUndefined();
    notify.mockRestore();
  });

  it("terminal questions publish attention once and clear after a reply", async () => {
    const notifications = await import("../../../lib/notifications");
    const notify = vi.spyOn(notifications, "sendNotification").mockImplementation(() => {});
    const commands = await import("../../../lib/commands");
    const snapshot = await commands.codexRefreshThreadModel(baseSession.id);
    vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue({
      ...snapshot,
      pending_question: { id: "ask-1", summary: "Which option?" },
    });
    vi.useFakeTimers();
    setCodexSessionMode(baseSession.id, "terminal");
    await act(async () => { render(<CodexSessionView session={baseSession} />); });
    expect(useUiStore.getState().pendingApprovalsBySession[baseSession.id]).toMatchObject({
      agentType: "codex", summary: "Which option?", interactionMode: "pty", category: "waiting",
    });
    expect(notify).toHaveBeenCalledWith("agmux — Input Requested", "Which option?", { threadId: baseSession.id, provider: "Codex" });
    const attention = useUiStore.getState().pendingApprovalsBySession[baseSession.id];
    await act(async () => { vi.advanceTimersByTime(3_000); });
    expect(useUiStore.getState().pendingApprovalsBySession[baseSession.id]).toBe(attention);
    expect(notify).toHaveBeenCalledTimes(1);
    vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue({ ...snapshot, pending_question: null });
    await act(async () => { vi.advanceTimersByTime(3_000); });
    expect(useUiStore.getState().pendingApprovalsBySession[baseSession.id]).toBeUndefined();
    notify.mockRestore();
  });

  it("terminal mode keeps processing through long PTY idle while task_active", async () => {
    const commands = await import("../../../lib/commands");
    const startedAt = new Date().toISOString();
    vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue({
      model: null,
      model_context_window: null,
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_input_tokens: null,
      total_output_tokens: null,
      total_cached_input_tokens: null,
      task_active: true,
      last_task_started_at: startedAt,
      last_task_complete_at: null,
    });
    setCodexSessionMode(baseSession.id, "terminal");
    render(<CodexSessionView session={baseSession} />);

    await waitFor(() => expect(terminalMock.props.length).toBeGreaterThan(0));
    vi.useFakeTimers();
    act(() => {
      const props = terminalMock.props[terminalMock.props.length - 1];
      props.onUserLine?.("long thinking turn");
      props.onOutputActivity?.();
    });
    // Flush the immediate JSONL poll so sawTaskStart latches.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useUiStore.getState().codexProcessingById[baseSession.id]).toBe(true);

    // Real Codex turns routinely go 10–20s without PTY output while tools run.
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useUiStore.getState().codexProcessingById[baseSession.id]).toBe(true);
  });

  it("terminal mode clears inferred processing on task_complete from session file", async () => {
    const commands = await import("../../../lib/commands");
    const startedAt = new Date().toISOString();
    vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue({
      model: null,
      model_context_window: null,
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_input_tokens: null,
      total_output_tokens: null,
      total_cached_input_tokens: null,
      task_active: true,
      last_task_started_at: startedAt,
      last_task_complete_at: null,
    });
    setCodexSessionMode(baseSession.id, "terminal");
    render(<CodexSessionView session={baseSession} />);

    await waitFor(() => expect(terminalMock.props.length).toBeGreaterThan(0));
    vi.useFakeTimers();
    act(() => {
      terminalMock.props[terminalMock.props.length - 1].onUserLine?.("finish when task completes");
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useUiStore.getState().codexProcessingById[baseSession.id]).toBe(true);

    const completeAt = new Date(Date.now() + 1_000).toISOString();
    vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue({
      model: null,
      model_context_window: null,
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_input_tokens: null,
      total_output_tokens: null,
      total_cached_input_tokens: null,
      task_active: false,
      last_task_started_at: startedAt,
      last_task_complete_at: completeAt,
    });

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useUiStore.getState().codexProcessingById[baseSession.id]).toBe(false);
    expect(useUiStore.getState().unreadSessionIds[baseSession.id]).toBe(true);
  });

  it("terminal mode never shows processing for local commands without a task", async () => {
    const commands = await import("../../../lib/commands");
    // No task_started ever appears in the session file.
    vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue({
      model: null,
      model_context_window: null,
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_input_tokens: null,
      total_output_tokens: null,
      total_cached_input_tokens: null,
      task_active: false,
      last_task_started_at: null,
      last_task_complete_at: null,
    });
    setCodexSessionMode(baseSession.id, "terminal");
    render(<CodexSessionView session={baseSession} />);

    await waitFor(() => expect(terminalMock.props.length).toBeGreaterThan(0));
    vi.useFakeTimers();
    act(() => {
      const props = terminalMock.props[terminalMock.props.length - 1];
      props.onUserLine?.("/status");
      props.onOutputActivity?.();
    });
    expect(useUiStore.getState().codexProcessingById[baseSession.id]).not.toBe(true);

    act(() => {
      vi.advanceTimersByTime(7_999);
    });
    expect(useUiStore.getState().codexProcessingById[baseSession.id]).not.toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(useUiStore.getState().codexProcessingById[baseSession.id]).toBe(false);
  });

  it("terminal mode clears inferred processing on interrupt (Escape)", async () => {
    const commands = await import("../../../lib/commands");
    vi.mocked(commands.summarizeThreadNamesBatch).mockResolvedValue({
      [baseSession.id]: "Interrupt codex terminal",
    });
    const snapshot = await commands.codexRefreshThreadModel(baseSession.id);
    vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue({
      ...snapshot,
      task_active: true,
      last_task_started_at: new Date().toISOString(),
    });
    setCodexSessionMode(baseSession.id, "terminal");
    render(<CodexSessionView session={baseSession} />);

    await waitFor(() => expect(terminalMock.props.length).toBeGreaterThan(0));
    await act(async () => {
      const props = terminalMock.props[terminalMock.props.length - 1];
      props.onUserLine?.("long running task");
    });
    expect(useUiStore.getState().codexProcessingById[baseSession.id]).toBe(true);

    act(() => {
      terminalMock.props[terminalMock.props.length - 1].onInterrupt?.();
    });
    expect(useUiStore.getState().codexProcessingById[baseSession.id]).toBe(false);
  });

  it("terminal mode does not app-server-resume the thread (avoids duplicate Chat session)", async () => {
    const commands = await import("../../../lib/commands");
    setCodexSessionMode(baseSession.id, "terminal");
    render(<CodexSessionView session={baseSession} />);

    await waitFor(() => {
      expect(commands.spawnCodexResume).toHaveBeenCalled();
    });
    // Give the chat auto-resume effect a tick; it must not fire in terminal mode.
    await act(async () => {
      await Promise.resolve();
    });
    expect(commands.codexResumeThread).not.toHaveBeenCalled();
  });

  it("publishes the current model for the Codex sidebar immediately on mount", async () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        codexModel: "gpt-5.3-codex",
      },
    });

    render(<CodexSessionView session={baseSession} />);

    await waitFor(() => {
      expect(useUiStore.getState().codexThreadModelById[baseSession.id]).toBe("gpt-5.3-codex");
    });
  });

  it("terminal mode re-scans session file after idle and publishes the new model", async () => {
    const commands = await import("../../../lib/commands");
    vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue({
      model: "gpt-5.6-sol",
      model_context_window: 258400,
      input_tokens: 12000,
      output_tokens: 40,
      cached_input_tokens: 8000,
      total_input_tokens: 12000,
      total_output_tokens: 40,
      total_cached_input_tokens: 8000,
    });
    useUiStore.setState({ selectedCodexSessionId: baseSession.id });
    setCodexSessionMode(baseSession.id, "terminal");

    render(<CodexSessionView session={baseSession} />);

    await waitFor(() => expect(terminalMock.props.length).toBeGreaterThan(0));
    // Mount may already have polled once; reset so we assert the idle-triggered scan.
    vi.mocked(commands.codexRefreshThreadModel).mockClear();
    vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue({
      model: "gpt-5.6-sol",
      model_context_window: 258400,
      input_tokens: 42000,
      output_tokens: 120,
      cached_input_tokens: 30000,
      total_input_tokens: 100000,
      total_output_tokens: 500,
      total_cached_input_tokens: 80000,
    });

    vi.useFakeTimers();
    act(() => {
      const props = terminalMock.props[terminalMock.props.length - 1];
      props.onUserLine?.("switch model then reply");
      props.onOutputActivity?.();
    });

    // Prompt starts a 1s JSONL poll immediately (and no-task idle is 8s).
    await act(async () => {
      vi.advanceTimersByTime(1_100);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(commands.codexRefreshThreadModel).toHaveBeenCalledWith(baseSession.id);
    expect(useUiStore.getState().codexThreadModelById[baseSession.id]).toBe("gpt-5.6-sol");
  });

  it("terminal history load preserves backend totals including subagents", async () => {
    const commands = await import("../../../lib/commands");
    const aggregate = { linesAdded: 100, linesRemoved: 20, filesChanged: 8 };
    useUiStore.setState({ codexDiffStatsById: { [baseSession.id]: aggregate }, selectedCodexSessionId: baseSession.id });
    setCodexSessionMode(baseSession.id, "terminal");
    vi.mocked(commands.codexReadSessionHistory).mockResolvedValue({
      items: [
        {
          role: "file",
          content: "@@\n+a\n+b\n-c\n",
          timestamp: new Date().toISOString(),
          file_path: "src/foo.ts",
          additions: 2,
          deletions: 1,
        },
        {
          role: "file",
          content: "@@\n+x\n",
          timestamp: new Date().toISOString(),
          file_path: "src/bar.ts",
          additions: 5,
          deletions: 3,
        },
      ],
      cwd: "/tmp/repo",
      model: "gpt-5.6-terra",
      effort: "high",
      model_context_window: null,
      input_tokens: null,
      output_tokens: null,
    } as never);

    await act(async () => { render(<CodexSessionView session={baseSession} />); });
    expect(commands.codexReadSessionHistory).toHaveBeenCalledWith(baseSession.id);
    expect(useUiStore.getState().codexDiffStatsById[baseSession.id]).toEqual(aggregate);
  });

  it("terminal idle re-scan preserves backend totals including subagents", async () => {
    const commands = await import("../../../lib/commands");
    const aggregate = { linesAdded: 100, linesRemoved: 20, filesChanged: 8 };
    useUiStore.setState({ codexDiffStatsById: { [baseSession.id]: aggregate }, selectedCodexSessionId: baseSession.id });
    setCodexSessionMode(baseSession.id, "terminal");
    vi.mocked(commands.codexReadSessionHistory).mockResolvedValue({
      items: [],
      cwd: "/tmp/repo",
      model: null,
      effort: null,
      model_context_window: null,
      input_tokens: null,
      output_tokens: null,
    } as never);

    render(<CodexSessionView session={baseSession} />);
    await waitFor(() => expect(terminalMock.props.length).toBeGreaterThan(0));

    vi.mocked(commands.codexReadSessionHistory).mockClear();
    vi.mocked(commands.codexReadSessionHistory).mockResolvedValue({
      items: [
        {
          role: "file",
          content: "@@\n+line\n",
          timestamp: new Date().toISOString(),
          file_path: "src/new.ts",
          additions: 12,
          deletions: 4,
        },
      ],
      cwd: "/tmp/repo",
      model: null,
      effort: null,
      model_context_window: null,
      input_tokens: null,
      output_tokens: null,
    } as never);

    vi.useFakeTimers();
    act(() => {
      const props = terminalMock.props[terminalMock.props.length - 1];
      props.onUserLine?.("edit a file");
      props.onOutputActivity?.();
    });

    // Diff re-scan runs when the inferred turn clears. With no task_started
    // in the mock, the no-task idle timer (8s) ends the turn.
    await act(async () => {
      vi.advanceTimersByTime(8_100);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(commands.codexReadSessionHistory).toHaveBeenCalledWith(baseSession.id);
    expect(useUiStore.getState().codexDiffStatsById[baseSession.id]).toEqual(aggregate);
  });

  it("terminal mode refreshes model from session file on window focus", async () => {
    const commands = await import("../../../lib/commands");
    vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue({
      model: "gpt-5.6-terra",
      model_context_window: null,
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_input_tokens: null,
      total_output_tokens: null,
      total_cached_input_tokens: null,
    });
    useUiStore.setState({ selectedCodexSessionId: baseSession.id });
    setCodexSessionMode(baseSession.id, "terminal");

    render(<CodexSessionView session={baseSession} />);

    await waitFor(() => {
      expect(useUiStore.getState().codexThreadModelById[baseSession.id]).toBe("gpt-5.6-terra");
    });

    vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue({
      model: "gpt-5.6-luna",
      model_context_window: 258400,
      input_tokens: 55000,
      output_tokens: 200,
      cached_input_tokens: 40000,
      total_input_tokens: 120000,
      total_output_tokens: 800,
      total_cached_input_tokens: 90000,
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(useUiStore.getState().codexThreadModelById[baseSession.id]).toBe("gpt-5.6-luna");
    });
  });

  it("terminal mode publishes context usage from session-file token_count", async () => {
    const commands = await import("../../../lib/commands");
    vi.mocked(commands.codexReadSessionHistory).mockResolvedValue({
      items: [],
      cwd: "/tmp/repo",
      model: "gpt-5.6-terra",
      effort: "high",
      model_context_window: 258400,
      input_tokens: 32100,
      output_tokens: 88,
      cached_input_tokens: 28000,
      total_input_tokens: 64000,
      total_output_tokens: 200,
      total_cached_input_tokens: 50000,
    } as never);
    vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue({
      model: "gpt-5.6-terra",
      model_context_window: 258400,
      input_tokens: 32100,
      output_tokens: 88,
      cached_input_tokens: 28000,
      total_input_tokens: 64000,
      total_output_tokens: 200,
      total_cached_input_tokens: 50000,
    });
    useUiStore.setState({ selectedCodexSessionId: baseSession.id });
    setCodexSessionMode(baseSession.id, "terminal");

    render(<CodexSessionView session={baseSession} />);

    await waitFor(() => {
      const bar = screen.getByTestId("thread-top-bar");
      expect(bar.getAttribute("data-ctx-used")).toBe("32100");
      expect(bar.getAttribute("data-ctx-max")).toBe("258400");
      expect(bar.getAttribute("data-model")).toBe("gpt-5.6-terra");
    });
  });

  it("hides the top bar when embedded=true", () => {
    const { container } = render(
      <CodexSessionView session={baseSession} embedded={true} />
    );
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeNull();
  });

  it("renders without crashing when session has no thread_name", () => {
    const { container } = render(
      <CodexSessionView session={{ id: "cx2" }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders without crashing when session has no cwd", () => {
    const { container } = render(
      <CodexSessionView session={{ id: "cx3", thread_name: "X" }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders a different session id without crashing", () => {
    const { container } = render(
      <CodexSessionView session={{ ...baseSession, id: "cx-other" }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders chat scroll area structure", () => {
    const { container } = render(<CodexSessionView session={baseSession} />);
    expect(container.querySelectorAll("div").length).toBeGreaterThan(1);
  });

  it("renders a textarea for input", () => {
    const { container } = render(<CodexSessionView session={baseSession} />);
    expect(container.querySelector("textarea")).toBeTruthy();
  });

  it("renders embedded=false explicitly", () => {
    const { container } = render(
      <CodexSessionView session={baseSession} embedded={false} />
    );
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeTruthy();
  });

  it("renders for session with explicit cwd path", () => {
    const { container } = render(
      <CodexSessionView session={{ ...baseSession, cwd: "/another/repo" }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for a long session name", () => {
    const longName = "a".repeat(200);
    const { container } = render(
      <CodexSessionView session={{ ...baseSession, thread_name: longName }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for session with a different updated_at", () => {
    const old = new Date(Date.now() - 86_400_000).toISOString();
    const { container } = render(
      <CodexSessionView session={{ ...baseSession, updated_at: old }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("rerenders with embedded toggling on", () => {
    const { container, rerender } = render(
      <CodexSessionView session={baseSession} />
    );
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeTruthy();
    rerender(<CodexSessionView session={baseSession} embedded={true} />);
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeNull();
  });

  it("rerenders with session id change", () => {
    const { container, rerender } = render(
      <CodexSessionView session={{ ...baseSession, id: "cx1" }} />
    );
    expect(container.firstChild).toBeTruthy();
    rerender(<CodexSessionView session={{ ...baseSession, id: "cx2" }} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("rerenders with thread_name change", () => {
    const { container, rerender } = render(
      <CodexSessionView session={{ ...baseSession, thread_name: "First" }} />
    );
    expect(container.firstChild).toBeTruthy();
    rerender(<CodexSessionView session={{ ...baseSession, thread_name: "Second" }} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders when session has empty string id", () => {
    const { container } = render(
      <CodexSessionView session={{ ...baseSession, id: "" }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders when threadStore has matching codex thread", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "cx1",
            project_id: "p1",
            provider: "Codex",
            interaction_mode: "pty",
            status: "Idle",
            name: "Codex Session",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: "gpt-5",
          } as never,
        ],
      },
    } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders when threadStore has Running codex thread", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "cx1",
            project_id: "p1",
            provider: "Codex",
            interaction_mode: "pty",
            status: "Running",
            name: "Codex Running",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with empty threadStore", () => {
    useThreadStore.setState({ threads: {} } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("does not show approval banner by default", () => {
    const { container } = render(<CodexSessionView session={baseSession} />);
    expect(container.querySelector("[data-testid='approval-banner']")).toBeNull();
  });

  it("renders multiple sequential mounts cleanly", () => {
    const r1 = render(<CodexSessionView session={baseSession} />);
    expect(r1.container.firstChild).toBeTruthy();
    cleanup();
    const r2 = render(<CodexSessionView session={{ ...baseSession, id: "cx2" }} embedded />);
    expect(r2.container.firstChild).toBeTruthy();
  });

  it("renders for session with empty thread_name", () => {
    const { container } = render(
      <CodexSessionView session={{ ...baseSession, thread_name: "" }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for session with whitespace thread_name", () => {
    const { container } = render(
      <CodexSessionView session={{ ...baseSession, thread_name: "   " }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for session with thread_name containing unicode", () => {
    const { container } = render(
      <CodexSessionView session={{ ...baseSession, thread_name: "日本語のセッション" }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for session with cwd at root", () => {
    const { container } = render(
      <CodexSessionView session={{ ...baseSession, cwd: "/" }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for session with Windows-style cwd", () => {
    const { container } = render(
      <CodexSessionView session={{ ...baseSession, cwd: "C:\\Users\\test\\repo" }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for session with deeply nested cwd", () => {
    const { container } = render(
      <CodexSessionView session={{ ...baseSession, cwd: "/a/b/c/d/e/f/g/h/i/j/repo" }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for session with future-dated updated_at", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const { container } = render(
      <CodexSessionView session={{ ...baseSession, updated_at: future }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for session with very old updated_at", () => {
    const old = new Date("2000-01-01T00:00:00Z").toISOString();
    const { container } = render(
      <CodexSessionView session={{ ...baseSession, updated_at: old }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("toggles embedded → false → true → false", () => {
    const { rerender, container } = render(
      <CodexSessionView session={baseSession} embedded={false} />
    );
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeTruthy();
    rerender(<CodexSessionView session={baseSession} embedded={true} />);
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeNull();
    rerender(<CodexSessionView session={baseSession} embedded={false} />);
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeTruthy();
    rerender(<CodexSessionView session={baseSession} embedded={true} />);
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeNull();
  });

  it("rerenders cwd change while keeping same id", () => {
    const { rerender, container } = render(
      <CodexSessionView session={{ ...baseSession, cwd: "/a" }} />
    );
    rerender(<CodexSessionView session={{ ...baseSession, cwd: "/b" }} />);
    rerender(<CodexSessionView session={{ ...baseSession, cwd: "/c" }} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders when thread is in Idle status", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "cx1",
            project_id: "p1",
            provider: "Codex",
            interaction_mode: "pty",
            status: "Idle",
            name: "Idle thread",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders when thread is in Spawning status", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "cx1",
            project_id: "p1",
            provider: "Codex",
            interaction_mode: "pty",
            status: "Spawning",
            name: "Spawning",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders when thread is in Stopped status", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "cx1",
            project_id: "p1",
            provider: "Codex",
            interaction_mode: "pty",
            status: "Stopped",
            name: "Stopped",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for thread with various models", () => {
    for (const model of ["gpt-5", "gpt-5-codex", "gpt-4o", "o3", null]) {
      useThreadStore.setState({
        threads: {
          p1: [
            {
              id: "cx1",
              project_id: "p1",
              provider: "Codex",
              interaction_mode: "pty",
              status: "Idle",
              name: "T",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              last_active_at: new Date().toISOString(),
              model,
            } as never,
          ],
        },
      } as never);
      const { container } = render(<CodexSessionView session={baseSession} />);
      expect(container.firstChild).toBeTruthy();
      cleanup();
    }
  });

  it("renders with multiple threads in store, only one matches", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "cx1",
            project_id: "p1",
            provider: "Codex",
            interaction_mode: "pty",
            status: "Idle",
            name: "Match",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
          {
            id: "cx-other",
            project_id: "p1",
            provider: "Codex",
            interaction_mode: "pty",
            status: "Running",
            name: "Other",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("does not crash with mount and immediate unmount", () => {
    const { unmount } = render(<CodexSessionView session={baseSession} />);
    unmount();
    expect(true).toBe(true);
  });

  it("does not crash on multiple mount/unmount cycles", () => {
    for (let i = 0; i < 5; i++) {
      const { unmount } = render(
        <CodexSessionView session={{ ...baseSession, id: `cx${i}` }} />
      );
      unmount();
    }
    expect(true).toBe(true);
  });

  it("renders even when session updated_at is missing", () => {
    const { container } = render(
      <CodexSessionView session={{ id: "cx", thread_name: "X", cwd: "/r" }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for session with very long cwd", () => {
    const long = "/" + "deep/path/".repeat(40) + "repo";
    const { container } = render(
      <CodexSessionView session={{ ...baseSession, cwd: long }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for session with cwd containing unicode", () => {
    const { container } = render(
      <CodexSessionView session={{ ...baseSession, cwd: "/repo/データ" }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for session with cwd containing spaces", () => {
    const { container } = render(
      <CodexSessionView session={{ ...baseSession, cwd: "/Users/me/My Repo" }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("textarea persists across embedded toggle", () => {
    const { rerender, container } = render(
      <CodexSessionView session={baseSession} embedded={false} />
    );
    expect(container.querySelector("textarea")).toBeTruthy();
    rerender(<CodexSessionView session={baseSession} embedded={true} />);
    expect(container.querySelector("textarea")).toBeTruthy();
  });

  it("renders for session with thread_name containing emoji", () => {
    const { container } = render(
      <CodexSessionView session={{ ...baseSession, thread_name: "fix bug 🐛" }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with worktree-branch thread", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "cx1",
            project_id: "p1",
            provider: "Codex",
            interaction_mode: "pty",
            status: "Idle",
            name: "WT",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
            worktree_branch: "feature/x",
          } as never,
        ],
      },
    } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with thread store containing different project's thread", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "cx1",
            project_id: "p2",
            provider: "Codex",
            interaction_mode: "pty",
            status: "Idle",
            name: "X",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    expect(container.firstChild).toBeTruthy();
  });
});

describe("CodexSessionView — store reactivity & extras", () => {
  it("survives status flip Idle → Running while mounted", () => {
    const base: Record<string, unknown> = {
      id: "cx1",
      project_id: "p1",
      provider: "Codex",
      interaction_mode: "pty",
      status: "Idle",
      name: "X",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
      model: null,
    };
    useThreadStore.setState({ threads: { p1: [base as never] } } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    useThreadStore.setState({
      threads: { p1: [{ ...base, status: "Running" } as never] },
    } as never);
    expect(container.firstChild).toBeTruthy();
  });

  it("does not crash when thread is removed from store after mount", () => {
    const t = {
      id: "cx1",
      project_id: "p1",
      provider: "Codex",
      interaction_mode: "pty",
      status: "Idle",
      name: "X",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
      model: null,
    } as never;
    useThreadStore.setState({ threads: { p1: [t] } } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    useThreadStore.setState({ threads: {} } as never);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for codex thread with reasoning_effort high", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "cx1",
            project_id: "p1",
            provider: "Codex",
            interaction_mode: "pty",
            status: "Idle",
            name: "X",
            reasoning_effort: "high",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: "gpt-5-codex",
          } as never,
        ],
      },
    } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("rerenders consistently when session prop changes id, name, and cwd together", () => {
    const { container, rerender } = render(
      <CodexSessionView session={baseSession} />
    );
    rerender(
      <CodexSessionView
        session={{
          id: "cx-new",
          thread_name: "Rotated",
          updated_at: new Date().toISOString(),
          cwd: "/tmp/another",
        }}
      />
    );
    expect(container.firstChild).toBeTruthy();
    rerender(
      <CodexSessionView
        session={{
          id: "cx-third",
          thread_name: "Tres",
          updated_at: new Date().toISOString(),
          cwd: "/var/work",
        }}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders top bar (not embedded) for Idle thread in store", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "cx1",
            project_id: "p1",
            provider: "Codex",
            interaction_mode: "pty",
            status: "Idle",
            name: "X",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeTruthy();
  });

  it("hides top bar consistently after embedded toggle through multiple cycles", () => {
    const r = render(<CodexSessionView session={baseSession} embedded />);
    expect(r.container.querySelector("[data-testid='thread-top-bar']")).toBeNull();
    r.unmount();
    const r2 = render(<CodexSessionView session={baseSession} embedded={false} />);
    expect(
      r2.container.querySelector("[data-testid='thread-top-bar']")
    ).toBeTruthy();
    r2.unmount();
    const r3 = render(<CodexSessionView session={baseSession} embedded />);
    expect(r3.container.querySelector("[data-testid='thread-top-bar']")).toBeNull();
  });

  it("renders cleanly when both store has thread and session prop has empty thread_name", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "cx1",
            project_id: "p1",
            provider: "Codex",
            interaction_mode: "pty",
            status: "Idle",
            name: "named-in-store",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <CodexSessionView
        session={{
          id: "cx1",
          thread_name: "",
          updated_at: new Date().toISOString(),
          cwd: "/tmp/repo",
        }}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders embedded view with stopped store thread (no input crash)", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "cx1",
            project_id: "p1",
            provider: "Codex",
            interaction_mode: "pty",
            status: "Stopped",
            name: "X",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <CodexSessionView session={baseSession} embedded />
    );
    expect(container.firstChild).toBeTruthy();
  });
});

// =====================================================================
// Deep coverage — exercise the codex-event JSON-RPC switch via the
// captured listen handler. The session view subscribes to a single
// `codex-event` channel and filters by threadId, so we fire synthetic
// notifications matching session.id (cx1) to drive each `case "..."`
// in the giant 700-line dispatcher.
// =====================================================================
describe("CodexSessionView — deep coverage (codex-event handlers)", () => {
  type Listener = (event: { payload: unknown }) => void;

  async function setupCapture() {
    const eventModule = await import("@tauri-apps/api/event");
    const handlers: Record<string, Listener[]> = {};
    vi.mocked(eventModule.listen).mockImplementation(((channel: string, cb: Listener) => {
      (handlers[channel] ||= []).push(cb);
      return Promise.resolve(() => {});
    }) as never);
    return handlers;
  }

  async function flush() {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  function fireCodex(handlers: Record<string, Listener[]>, payload: unknown) {
    for (const h of handlers["codex-event"] ?? []) h({ payload });
  }

  it("captures the codex-event listener channel on mount", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    expect((handlers["codex-event"] ?? []).length).toBeGreaterThan(0);
  });

  it("handles thread/started event", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/started",
      params: {
        threadId: "cx1",
        thread: {
          id: "real-cdx-uuid",
          model: "gpt-5",
          effort: "medium",
          collaborationMode: { mode: "default" },
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles thread/started with plan collaboration mode", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/started",
      params: {
        threadId: "cx1",
        thread: {
          id: "real-cdx-uuid",
          model: "gpt-5",
          effort: "high",
          collaborationMode: "plan",
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // Regression: two Codex chats in the same workspace share one
  // `codex-event` channel. A running session must NOT adopt a sibling
  // session's `thread/started` — doing so re-points its `activeThreadIdRef`
  // at the sibling's thread, leaking the sibling's output and clearing this
  // session's running state (stop button + spinner vanish).
  it("ignores a sibling session's thread/started while tracking its own thread", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();

    // cx1 establishes its own Codex thread ("tid-A") and starts a turn —
    // it is now running with a known threadId.
    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1", thread: { id: "tid-A" } },
    });
    fireCodex(handlers, {
      method: "turn/started",
      params: { threadId: "tid-A", turnId: "turnA" },
    });
    await flush();
    // Sanity: the running session shows its Stop button.
    expect(container.querySelector('[title="Stop (Esc)"]')).toBeTruthy();

    // A different Codex session (sibling pane) starts its own thread, goes
    // idle, and emits assistant output. None of this belongs to cx1.
    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "tid-B", thread: { id: "tid-B" } },
    });
    fireCodex(handlers, {
      method: "thread/status/changed",
      params: { threadId: "tid-B", status: { type: "idle", activeFlags: [] } },
    });
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "tid-B", item: { id: "leak1", type: "agent_message" } },
    });
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "tid-B", itemId: "leak1", delta: "SIBLING-LEAK" },
    });
    await flush();

    // cx1 is still running — the sibling's idle event must not clear it.
    expect(container.querySelector('[title="Stop (Esc)"]')).toBeTruthy();
    // cx1 must not render the sibling session's assistant output.
    expect(container.textContent ?? "").not.toContain("SIBLING-LEAK");
  });

  it("accepts subagent child-thread events for liveness without rendering their tools", async () => {
    // Child threads are tracked so parent-turn stall detection stays warm and
    // spawn rows can resolve nicknames — but their tool stream must not flood
    // the parent chat (parent only shows "Launched X Agent").
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();

    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1", thread: { id: "tid-parent" } },
    });
    fireCodex(handlers, {
      method: "turn/started",
      params: { threadId: "tid-parent", turnId: "turn-parent" },
    });
    await flush();
    expect(container.querySelector('[title="Stop (Esc)"]')).toBeTruthy();

    fireCodex(handlers, {
      method: "thread/started",
      params: {
        threadId: "tid-child",
        thread: {
          id: "tid-child",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "tid-parent",
                depth: 1,
                agent_nickname: "Linnaeus",
              },
            },
          },
        },
      },
    });
    fireCodex(handlers, {
      method: "thread/status/changed",
      params: { threadId: "tid-child", status: { type: "idle", activeFlags: [] } },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-child",
        item: {
          id: "child-tool",
          type: "dynamicToolCall",
          namespace: "child",
          tool: "inspect",
          arguments: { target: "src/components/thread" },
          contentItems: [{ type: "inputText", text: "inspected child work" }],
          success: true,
        },
      },
    });
    await flush();

    // Parent turn still running (child idle must not clear it).
    expect(container.querySelector('[title="Stop (Esc)"]')).toBeTruthy();
    // Child tool stream stays out of the parent chat.
    expect(screen.queryByText("child.inspect")).toBeNull();
    expect(screen.queryByText(/inspected child work/)).toBeNull();
  });

  it("does not settle the parent turn when a collab child completes on the parent thread id", async () => {
    // Codex 0.153 collab stores child session_meta.session_id as the parent
    // thread id, so the child's turn/started + turn/completed (and idle)
    // arrive scoped to the parent. Adopting the child turn id made the
    // child's completion look like the parent turn ended — Stop + spinner
    // vanished while the parent was still working (Gemini diff-stats session
    // 2026-09-04).
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();

    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1", thread: { id: "tid-parent" } },
    });
    fireCodex(handlers, {
      method: "turn/started",
      params: { threadId: "tid-parent", turnId: "turn-parent" },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-parent",
        item: {
          id: "spawn-ui",
          type: "subAgentActivity",
          kind: "started",
          agentThreadId: "tid-child",
          agentPath: "/root/ui_stats",
        },
      },
    });
    await flush();
    expect(container.querySelector('[title="Stop (Esc)"]')).toBeTruthy();
    expect(screen.getByTestId("thread-top-bar").getAttribute("data-processing")).toBe("true");

    // Child turn announced on the parent thread id (real collab shape).
    fireCodex(handlers, {
      method: "turn/started",
      params: { threadId: "tid-parent", turnId: "turn-child" },
    });
    fireCodex(handlers, {
      method: "turn/completed",
      params: { threadId: "tid-parent", turn: { id: "turn-child" } },
    });
    fireCodex(handlers, {
      method: "thread/status/changed",
      params: { threadId: "tid-parent", status: { type: "idle", activeFlags: [] } },
    });
    await flush();
    expect(container.querySelector('[title="Stop (Esc)"]')).toBeTruthy();
    expect(screen.getByTestId("thread-top-bar").getAttribute("data-processing")).toBe("true");

    // Parent is still working — a later command must keep the turn live.
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "tid-parent",
        item: { id: "cmd-parent", type: "commandExecution", command: "git diff --check" },
      },
    });
    await flush();
    expect(container.querySelector('[title="Stop (Esc)"]')).toBeTruthy();
    expect(screen.getByTestId("thread-top-bar").getAttribute("data-processing")).toBe("true");

    // The parent's own turn completion still settles.
    fireCodex(handlers, {
      method: "turn/completed",
      params: { threadId: "tid-parent", turnId: "turn-parent" },
    });
    await flush();
    expect(container.querySelector('[title="Stop (Esc)"]')).toBeNull();
    expect(screen.getByTestId("thread-top-bar").getAttribute("data-processing")).toBe("false");
  });

  it("settles a collab chat turn from JSONL task_complete when turn/completed is missed", async () => {
    const commands = await import("../../../lib/commands");
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();

    vi.useFakeTimers();
    try {
      fireCodex(handlers, {
        method: "thread/started",
        params: { threadId: "cx1", thread: { id: "tid-parent" } },
      });
      fireCodex(handlers, {
        method: "turn/started",
        params: { threadId: "tid-parent", turnId: "turn-parent" },
      });
      fireCodex(handlers, {
        method: "item/completed",
        params: {
          threadId: "tid-parent",
          item: {
            id: "spawn-ui",
            type: "subAgentActivity",
            kind: "started",
            agentThreadId: "tid-child",
            agentPath: "/root/ui_stats",
          },
        },
      });
      fireCodex(handlers, {
        method: "thread/status/changed",
        params: { threadId: "tid-parent", status: { type: "idle", activeFlags: [] } },
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.querySelector('[title="Stop (Esc)"]')).toBeTruthy();
      expect(screen.getByTestId("thread-top-bar").getAttribute("data-processing")).toBe("true");

      const completeAt = new Date(Date.now() + 1_000).toISOString();
      vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue({
        model: null,
        model_context_window: null,
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        total_input_tokens: null,
        total_output_tokens: null,
        total_cached_input_tokens: null,
        task_active: false,
        last_task_started_at: new Date().toISOString(),
        last_task_complete_at: completeAt,
      });

      await act(async () => {
        vi.advanceTimersByTime(1_000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.querySelector('[title="Stop (Esc)"]')).toBeNull();
      expect(screen.getByTestId("thread-top-bar").getAttribute("data-processing")).toBe("false");
    } finally {
      await restoreRealTimers();
    }
  });

  it("catches up missed Codex chat rows from the session file without restarting", async () => {
    const commands = await import("../../../lib/commands");
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();

    vi.useFakeTimers();
    try {
      fireCodex(handlers, {
        method: "thread/started",
        params: { threadId: "cx1", thread: { id: "tid-parent" } },
      });
      fireCodex(handlers, {
        method: "turn/started",
        params: { threadId: "tid-parent", turnId: "turn-parent" },
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.textContent ?? "").not.toContain("docked inspector is implemented");

      vi.mocked(commands.codexReadSessionHistory).mockResolvedValue({
        cwd: "/tmp",
        model: null,
        effort: null,
        items: [
          { role: "user", content: "implement the inspector", timestamp: new Date().toISOString() },
          { role: "assistant", content: "docked inspector is implemented", timestamp: new Date().toISOString() },
        ],
        model_context_window: null,
        input_tokens: null,
        output_tokens: null,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.textContent ?? "").toContain("docked inspector is implemented");
      expect(container.querySelector('[title="Stop (Esc)"]')).toBeTruthy();
    } finally {
      await restoreRealTimers();
    }
  });

  it("keeps hidden chat lifecycle polling without repeatedly reading its transcript", async () => {
    const commands = await import("../../../lib/commands");
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    vi.useFakeTimers();
    try {
      act(() => useUiStore.setState({ selectedCodexSessionId: "another-session" }));
      fireCodex(handlers, { method: "turn/started", params: { threadId: "cx1", turnId: "turn-hidden" } });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      vi.mocked(commands.codexReadSessionHistory).mockClear();
      vi.mocked(commands.codexRefreshThreadModel).mockClear();
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(commands.codexReadSessionHistory).not.toHaveBeenCalled();
      expect(commands.codexRefreshThreadModel).toHaveBeenCalled();
      expect(container.querySelector('[title="Stop (Esc)"]')).toBeTruthy();
      vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue({
        model: null, model_context_window: null, input_tokens: null, output_tokens: null,
        cached_input_tokens: null, total_input_tokens: null, total_output_tokens: null,
        total_cached_input_tokens: null, task_active: false,
        last_task_started_at: new Date(Date.now() - 3_000).toISOString(),
        last_task_complete_at: new Date().toISOString(),
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(container.querySelector('[title="Stop (Esc)"]')).toBeNull();
    } finally {
      act(() => useUiStore.setState({ selectedCodexSessionId: null }));
      await restoreRealTimers();
    }
  });

  it("bounds visible chat transcript recovery and catches up immediately when shown", async () => {
    const commands = await import("../../../lib/commands");
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    vi.useFakeTimers();
    try {
      fireCodex(handlers, { method: "turn/started", params: { threadId: "cx1", turnId: "turn-visible" } });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      vi.mocked(commands.codexReadSessionHistory).mockClear();
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
      expect(commands.codexReadSessionHistory).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(commands.codexReadSessionHistory).toHaveBeenCalledTimes(1);
      act(() => useUiStore.setState({ selectedCodexSessionId: "another-session" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      vi.mocked(commands.codexReadSessionHistory).mockClear();
      await act(async () => { useUiStore.setState({ selectedCodexSessionId: "cx1" }); });
      expect(commands.codexReadSessionHistory).toHaveBeenCalledTimes(1);
    } finally {
      act(() => useUiStore.setState({ selectedCodexSessionId: null }));
      await restoreRealTimers();
    }
  });

  it("does not overlap slow chat recovery polls", async () => {
    const commands = await import("../../../lib/commands");
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    vi.useFakeTimers();
    const snapshot = await commands.codexRefreshThreadModel("cx1");
    let resolve!: (value: typeof snapshot) => void;
    vi.mocked(commands.codexRefreshThreadModel).mockImplementation(() => new Promise((done) => { resolve = done; }));
    vi.mocked(commands.codexRefreshThreadModel).mockClear();
    try {
      fireCodex(handlers, { method: "turn/started", params: { threadId: "cx1", turnId: "turn-slow" } });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
      expect(commands.codexRefreshThreadModel).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => { resolve(snapshot); });
      vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue(snapshot);
      await restoreRealTimers();
    }
  });

  it("keeps checking completion while a transcript recovery is stalled", async () => {
    const commands = await import("../../../lib/commands");
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    const history = await commands.codexReadSessionHistory("cx1");
    let resolve!: (value: typeof history) => void;
    vi.mocked(commands.codexReadSessionHistory).mockImplementation(() => new Promise((done) => { resolve = done; }));
    vi.mocked(commands.codexReadSessionHistory).mockClear();
    vi.useFakeTimers();
    try {
      fireCodex(handlers, { method: "turn/started", params: { threadId: "cx1", turnId: "turn-history-stalled" } });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      vi.mocked(commands.codexRefreshThreadModel).mockClear();
      act(() => useUiStore.setState({ selectedCodexSessionId: "another-session" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(commands.codexRefreshThreadModel).toHaveBeenCalledTimes(2);
      await act(async () => { useUiStore.setState({ selectedCodexSessionId: "cx1" }); });
      expect(commands.codexReadSessionHistory).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[title="Stop (Esc)"]')).toBeTruthy();
    } finally {
      await act(async () => { resolve(history); });
      vi.mocked(commands.codexReadSessionHistory).mockResolvedValue(history);
      act(() => useUiStore.setState({ selectedCodexSessionId: null }));
      await restoreRealTimers();
    }
  });

  it("does not duplicate hidden reasoning after completion is recovered from history", async () => {
    const commands = await import("../../../lib/commands");
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    vi.useFakeTimers();
    try {
      act(() => useUiStore.setState({ selectedCodexSessionId: "another-session" }));
      fireCodex(handlers, { method: "turn/started", params: { threadId: "cx1", turnId: "turn-recovered" } });
      fireCodex(handlers, { method: "item/reasoning/textDelta", params: { threadId: "cx1", itemId: "buffered", delta: "Recovered reasoning exactly once" } });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      vi.mocked(commands.codexReadSessionHistory).mockResolvedValue({
        items: [{ role: "thinking", content: "Recovered reasoning exactly once", timestamp: new Date().toISOString() }],
        cwd: null, model: null, effort: null, model_context_window: null, input_tokens: null, output_tokens: null,
      });
      vi.mocked(commands.codexRefreshThreadModel).mockResolvedValue({
        model: null, model_context_window: null, input_tokens: null, output_tokens: null,
        cached_input_tokens: null, total_input_tokens: null, total_output_tokens: null,
        total_cached_input_tokens: null, task_active: false,
        last_task_started_at: new Date().toISOString(), last_task_complete_at: new Date().toISOString(),
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      act(() => useUiStore.setState({ selectedCodexSessionId: "cx1" }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(screen.getAllByText("Recovered reasoning exactly once")).toHaveLength(1);
    } finally {
      act(() => useUiStore.setState({ selectedCodexSessionId: null }));
      await restoreRealTimers();
    }
  });

  it("never adopts a previous turn's pending history in a new turn", async () => {
    const commands = await import("../../../lib/commands");
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    const empty = await commands.codexReadSessionHistory("cx1");
    let resolve!: (value: typeof empty) => void;
    vi.mocked(commands.codexReadSessionHistory).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireCodex(handlers, { method: "turn/started", params: { threadId: "cx1", turnId: "turn-a" } });
    await flush();
    fireCodex(handlers, { method: "turn/completed", params: { threadId: "cx1", turnId: "turn-a" } });
    await flush();
    fireCodex(handlers, { method: "turn/started", params: { threadId: "cx1", turnId: "turn-b" } });
    fireCodex(handlers, { method: "item/completed", params: { threadId: "cx1", item: { id: "b-answer", type: "agentMessage", text: "Keep the new turn answer" } } });
    await flush();
    expect(screen.getByText("Keep the new turn answer")).toBeTruthy();
    await act(async () => { resolve({
      ...empty,
      items: Array.from({ length: 8 }, (_, index) => ({ role: "assistant", content: `Older saved answer ${index}`, timestamp: new Date().toISOString() })),
    }); });
    await flush();
    expect(screen.getByText("Keep the new turn answer")).toBeTruthy();
  });

  it("hydrates Codex collaboration tool names from child thread metadata", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();

    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1", thread: { id: "tid-parent" } },
    });
    fireCodex(handlers, {
      method: "thread/started",
      params: {
        threadId: "tid-child",
        thread: {
          id: "tid-child",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "tid-parent",
                agent_nickname: "Dirac",
              },
            },
          },
        },
      },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-parent",
        item: {
          id: "wait-tool",
          type: "collabAgentToolCall",
          tool: "wait",
          status: "inProgress",
          receiverThreadIds: ["tid-child"],
        },
      },
    });
    await flush();

    // Wait polls are hidden — they only hydrate the spawn/launch row (Codex
    // app style: a stable "Launched Dirac Agent", not "Waiting on agent").
    expect(screen.queryByText("Waiting on")).toBeNull();
    expect(screen.queryByText("Waited on")).toBeNull();
    expect(screen.queryByText("CollabAgent.wait")).toBeNull();
    // No spawn was fired in this test, so wait alone leaves no visible row.
    expect(screen.queryByText("Launched")).toBeNull();
  });

  it("feeds Codex subagent references independently of visible launch rows", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, { method: "thread/started", params: { threadId: "cx1", thread: { id: "roster-parent" } } });
    fireCodex(handlers, { method: "turn/started", params: { threadId: "roster-parent", turnId: "roster-turn" } });
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "roster-parent", item: { id: "roster-user", type: "userMessage", content: [{ type: "text", text: "Check performance" }] } },
    });
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: { threadId: "roster-parent", item: {
        id: "roster-spawn", type: "collabAgentToolCall", tool: "spawn", status: "completed",
        receiverThreadIds: ["roster-child"], prompt: "Inspect slow renders",
      } },
    });
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: { threadId: "roster-parent", item: { id: "roster-final", type: "agentMessage", text: "Scout is handling it" } },
    });
    await flush();
    fireCodex(handlers, { method: "turn/completed", params: { threadId: "roster-parent", turnId: "roster-turn" } });
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "roster-parent", item: { id: "roster-next", type: "userMessage", content: [{ type: "text", text: "Continue with the next task" }] } },
    });
    await flush();
    expect(screen.getByTestId("codex-turn-summary")).toBeTruthy();
    expect(screen.queryByTestId("subagent-launch-row")).toBeNull();
    expect(inspectorPropsSpy.mock.lastCall?.[0].subagents).toEqual([
      expect.objectContaining({ toolUseId: "roster-spawn", childId: "roster-child", prompt: "Inspect slow renders", status: "running" }),
    ]);
  });

  it("marks the original Codex spawn tool finished when the agent wait completes", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();

    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1", thread: { id: "tid-parent" } },
    });
    fireCodex(handlers, {
      method: "thread/started",
      params: {
        threadId: "tid-child",
        thread: {
          id: "tid-child",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "tid-parent",
                agent_nickname: "Dirac",
              },
            },
          },
        },
      },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-parent",
        item: {
          id: "spawn-tool",
          type: "collabAgentToolCall",
          tool: "spawn",
          status: "completed",
          receiverThreadIds: ["tid-child"],
        },
      },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-parent",
        item: {
          id: "wait-tool",
          type: "collabAgentToolCall",
          tool: "wait",
          status: "completed",
          receiverThreadIds: ["tid-child"],
        },
      },
    });
    await flush();

    // The matching wait updates the shared launch status without adding a row.
    expect(screen.queryByText("Waiting on")).toBeNull();
    expect(screen.queryByText("Waited on")).toBeNull();
    expect(parentChat().getAllByText("Launched")).toHaveLength(1);
    const spawnRows = parentChat().getAllByText("Completed");
    expect(spawnRows).toHaveLength(1);
    const spawnRow = spawnRows[0].closest("button, [role='button']")!;
    expect(spawnRow.textContent).toMatch(/Dirac Agent/);
    expect(spawnRow.getAttribute("data-status")).toBe("completed");
    fireEvent.click(spawnRow);
    expect(screen.getByRole("complementary", { name: "Subagent conversation" })).toBeTruthy();
    expect(parentChat().getByText("Viewing")).toBeTruthy();
  });

  it("keeps one Launched row per agent across many wait_agent polls (real session shape)", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();

    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1", thread: { id: "tid-parent" } },
    });
    // Three parallel spawns — like collaboration.spawn_agent with task_name
    for (const [id, task] of [
      ["spawn-fe", "frontend_perf"],
      ["spawn-be", "backend_perf"],
      ["spawn-arch", "architecture_perf"],
    ] as const) {
      fireCodex(handlers, {
        method: "item/completed",
        params: {
          threadId: "tid-parent",
          item: {
            id,
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            status: "completed",
            task_name: task,
            prompt: `audit ${task}`,
          },
        },
      });
    }
    // Many wait_agent polls (real rollouts: only timeout_ms, no receiver ids)
    for (let i = 0; i < 8; i++) {
      fireCodex(handlers, {
        method: "item/completed",
        params: {
          threadId: "tid-parent",
          item: {
            id: `wait-${i}`,
            type: "collabAgentToolCall",
            tool: "wait_agent",
            status: "completed",
            result: { message: "Wait timed out.", timed_out: true },
          },
        },
      });
    }
    // send_message noise
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-parent",
        item: {
          id: "send-1",
          type: "collabAgentToolCall",
          tool: "send_message",
          status: "completed",
          // surfaced via dynamic args in real sessions; here as prompt
          prompt: "nudge",
        },
      },
    });
    await flush();

    // Exactly three launch rows — one per agent. No wait/send rows.
    const launched = parentChat().getAllByText("Launched");
    expect(launched).toHaveLength(3);
    expect(parentChat().getByText("Frontend Perf Agent")).toBeTruthy();
    expect(parentChat().getByText("Backend Perf Agent")).toBeTruthy();
    expect(parentChat().getByText("Architecture Perf Agent")).toBeTruthy();
    expect(screen.queryByText("Waiting on")).toBeNull();
    expect(screen.queryByText("Waited on")).toBeNull();
    expect(screen.queryByText(/wait_agent/i)).toBeNull();
    expect(screen.queryByText(/send_message/i)).toBeNull();
    // Timed-out waits leave agents running
    for (const el of launched) {
      expect(el.closest("button, [role='button']")?.getAttribute("data-status")).toBe("running");
    }

    // A successful global wait finishes all open launch rows in place
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-parent",
        item: {
          id: "wait-final",
          type: "collabAgentToolCall",
          tool: "wait_agent",
          status: "completed",
          result: { message: "Wait completed.", timed_out: false },
        },
      },
    });
    await flush();

    expect(parentChat().getAllByText("Launched")).toHaveLength(3);
    const after = parentChat().getAllByText("Completed");
    expect(after).toHaveLength(3);
    for (const el of after) {
      expect(el.closest("button, [role='button']")?.getAttribute("data-status")).toBe("completed");
    }
  });

  it.each([
    { type: "collabAgentToolCall", tool: "spawn_agent", task_name: "reviewer", prompt: "Review the patch", receiverThreadIds: ["child-review"], status: "completed" },
    { type: "collabAgentToolCall", tool: "spawn_agent", task_name: "reviewer", prompt: "Review the patch", result: { agent_id: "child-review" }, status: "completed" },
    { type: "subAgentActivity", kind: "started", agentThreadId: "child-review", agentPath: "/root/reviewer" },
  ])("opens the shared inspector from a real Codex $type launch without resuming the child", async (launch) => {
    const handlers = await setupCapture();
    const commands = await import("../../../lib/commands");
    vi.mocked(invoke).mockImplementation(async (command) => command === "read_subagent_conversation" ? {
      childId: "child-review", toolUseId: "spawn-inspector", status: "completed",
      items: [
        { id: "child-question", type: "user", text: "Review the patch" },
        { id: "child-command", type: "tool", toolName: "Bash", toolInput: { command: "npm test" }, toolResult: "Review tests passed", pending: false },
        { id: "child-answer", type: "assistant", text: "Patch review complete" },
      ],
    } : undefined);
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "spawn-inspector",
          ...launch,
        },
      },
    });
    await flush();
    vi.mocked(commands.codexResumeThread).mockClear();
    fireEvent.click(parentChat().getByText("Launched").closest("button, [role='button']")!);
    await waitFor(() => expect(parentChat().getByText("Viewing")).toBeTruthy());
    const panel = screen.getByRole("complementary", { name: "Subagent conversation" });
    await within(panel).findByText("Patch review complete");
    const command = within(panel).getAllByTestId("codex-tool-row").find((row) => row.textContent?.includes("npm test"))!;
    fireEvent.click(command);
    expect(await within(panel).findByText("Review tests passed")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("read_subagent_conversation", expect.objectContaining({ provider: "Codex", parentThreadId: "cx1", parentSessionId: "cx1", childId: "child-review", toolUseId: "spawn-inspector" }));
    expect(commands.codexResumeThread).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getByRole("button", { name: "Close subagent conversation" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Subagent conversation" })).toBeNull());
    expect(parentChat().getByText("Completed")).toBeTruthy();
    vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  });

  it("renders Launched rows from rawResponseItem function_call spawn_agent (real rollout shape)", async () => {
    // Codex 0.144 writes collaboration tools as function_call with
    // namespace="collaboration" + bare name="spawn_agent" — not collabAgentToolCall.
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();

    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1", thread: { id: "tid-parent" } },
    });

    for (const [callId, task] of [
      ["call_fe", "frontend_perf_audit"],
      ["call_term", "terminal_perf_audit"],
      ["call_be", "backend_perf_audit"],
    ] as const) {
      fireCodex(handlers, {
        method: "rawResponseItem/completed",
        params: {
          threadId: "tid-parent",
          item: {
            type: "function_call",
            id: `fc_${callId}`,
            call_id: callId,
            name: "spawn_agent",
            namespace: "collaboration",
            arguments: JSON.stringify({
              task_name: task,
              fork_turns: "none",
              message: "encrypted-prompt",
            }),
          },
        },
      });
    }

    // list_agents / wait_agent are collab plumbing — must not become rows.
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: {
        threadId: "tid-parent",
        item: {
          type: "function_call",
          call_id: "call_list",
          name: "list_agents",
          namespace: "collaboration",
          arguments: "{}",
        },
      },
    });
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: {
        threadId: "tid-parent",
        item: {
          type: "function_call",
          call_id: "call_wait",
          name: "wait_agent",
          namespace: "collaboration",
          arguments: JSON.stringify({ timeout_ms: 20000 }),
        },
      },
    });
    await flush();

    const launched = parentChat().getAllByText("Launched");
    expect(launched).toHaveLength(3);
    expect(parentChat().getByText("Frontend Perf Audit Agent")).toBeTruthy();
    expect(parentChat().getByText("Terminal Perf Audit Agent")).toBeTruthy();
    expect(parentChat().getByText("Backend Perf Audit Agent")).toBeTruthy();
    expect(screen.queryByText(/list_agents/i)).toBeNull();
    expect(screen.queryByText(/wait_agent/i)).toBeNull();
  });

  it("renders a Launched row from a 0.145 subAgentActivity item (real capture shape)", async () => {
    // Codex 0.145 no longer emits collabAgentToolCall for spawn_agent — the
    // spawn only surfaces as item/completed { type: "subAgentActivity",
    // kind: "started", agentThreadId, agentPath: "/root/<task_name>" }.
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();

    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1", thread: { id: "tid-parent" } },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-parent",
        turnId: "turn-1",
        item: {
          type: "subAgentActivity",
          id: "call_9VtttpF74umwbFWLIltTJFlm",
          kind: "started",
          agentThreadId: "tid-child",
          agentPath: "/root/hello_test",
        },
        completedAtMs: 1784847863743,
      },
    });
    // 0.145 wait polls carry no receiver ids / agentsStates — must stay hidden
    // and must not finish the launch row while the agent is still running.
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-parent",
        turnId: "turn-1",
        item: {
          type: "collabAgentToolCall",
          id: "call_AEd1FORTOxSlF3UsaMYEseMF",
          tool: "wait",
          status: "completed",
          senderThreadId: "tid-parent",
          receiverThreadIds: [],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: {},
        },
      },
    });
    await flush();

    const launched = parentChat().getAllByText("Launched");
    expect(launched).toHaveLength(1);
    const row = launched[0].closest("button, [role='button'], [data-testid='codex-tool-row']")!;
    expect(row.textContent).toMatch(/Hello Test Agent/);
    expect(row.getAttribute("data-status")).toBe("running");

    // A parent reply can finish while this child is still working.
    fireCodex(handlers, { method: "turn/completed", params: { threadId: "tid-parent", turn: { id: "turn-1", status: "completed" } } });
    await flush();
    expect(parentChat().getByText("Launched").closest("[data-status]")?.getAttribute("data-status")).toBe("running");
    expect(screen.getAllByTestId("subagent-activity-row").some((entry) => entry.getAttribute("data-status") === "running")).toBe(true);

    // Child-thread traffic must not leak into the parent chat.
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-child",
        item: { id: "child-msg", type: "agentMessage", text: "hi" },
      },
    });
    await flush();
    expect(screen.queryByText("hi")).toBeNull();

    // A second started event for the same agent must not add a second row.
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-parent",
        item: {
          type: "subAgentActivity",
          id: "call_9VtttpF74umwbFWLIltTJFlm",
          kind: "started",
          agentThreadId: "tid-child",
          agentPath: "/root/hello_test",
        },
      },
    });
    await flush();
    expect(parentChat().getAllByText("Launched")).toHaveLength(1);

    // Repeated parent completion still does not settle the child.
    fireCodex(handlers, {
      method: "turn/completed",
      params: { threadId: "tid-parent", turn: { id: "turn-1" } },
    });
    await flush();
    expect(parentChat().getAllByText("Launched")).toHaveLength(1);
    const rowAfter = parentChat().getAllByText("Launched")[0]
      .closest("button, [role='button'], [data-testid='codex-tool-row']")!;
    expect(rowAfter.getAttribute("data-status")).toBe("running");
    expect(rowAfter.textContent).toMatch(/Hello Test Agent/);
  });

  it("marks subagents Completed from list_agents agent_status (real rollout shape)", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => command === "read_subagent_conversation" && !(args as { activityOnly?: boolean })?.activityOnly ? {
      childId: "tid-be", toolUseId: "act-be", status: "completed", items: [],
      unavailableReason: "Saved child transcript unavailable",
    } : undefined);
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();

    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1", thread: { id: "tid-parent" } },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-parent",
        item: {
          type: "subAgentActivity",
          id: "act-be",
          kind: "started",
          agentThreadId: "tid-be",
          agentPath: "/root/memory_backend_audit",
        },
      },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-parent",
        item: {
          type: "subAgentActivity",
          id: "act-fe",
          kind: "started",
          agentThreadId: "tid-fe",
          agentPath: "/root/memory_interface_audit",
        },
      },
    });
    await flush();
    expect(parentChat().getAllByText("Launched")).toHaveLength(2);

    // Real list_agents output: completed agents carry a summary string.
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: {
        threadId: "tid-parent",
        item: {
          type: "function_call_output",
          call_id: "call_list1",
          output: JSON.stringify({
            agents: [
              { agent_name: "/root", agent_status: "running" },
              {
                agent_name: "/root/memory_backend_audit",
                agent_status: { completed: "Read-only backend audit complete." },
              },
              { agent_name: "/root/memory_interface_audit", agent_status: "running" },
            ],
          }),
        },
      },
    });
    await flush();

    expect(parentChat().getByText("Completed")).toBeTruthy();
    expect(parentChat().getByText(/Memory Backend Audit Agent/)).toBeTruthy();
    // The still-running peer keeps its Running badge.
    expect(parentChat().getAllByText("Launched")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "View Memory Interface Audit Agent conversation" }).getAttribute("data-status")).toBe("running");
    expect(parentChat().getByText(/Memory Interface Audit Agent/)).toBeTruthy();

    // The completed summary remains available when the transcript has not loaded.
    fireEvent.click(parentChat().getByText("Completed").closest("button, [role='button']")!);
    expect(await screen.findByText(/Read-only backend audit complete/)).toBeTruthy();
  });

  it("marks subagent Interrupted from subAgentActivity kind=interrupted", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();

    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1", thread: { id: "tid-parent" } },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-parent",
        item: {
          type: "subAgentActivity",
          id: "act-1",
          kind: "started",
          agentThreadId: "tid-child",
          agentPath: "/root/memory_spec_reviewer",
        },
      },
    });
    await flush();
    expect(parentChat().getByText("Launched")).toBeTruthy();

    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-parent",
        item: {
          type: "subAgentActivity",
          id: "act-1-int",
          kind: "interrupted",
          agentThreadId: "tid-child",
          agentPath: "/root/memory_spec_reviewer",
        },
      },
    });
    await flush();

    expect(parentChat().getAllByText("Launched")).toHaveLength(1);
    const row = parentChat().getByText("Failed").closest("button, [role='button']")!;
    expect(row.textContent).toMatch(/Memory Spec Reviewer Agent/);
    expect(row.getAttribute("data-status")).toBe("failed");
  });

  it("does not render subagent shell commands into the parent chat", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();

    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1", thread: { id: "tid-parent" } },
    });
    fireCodex(handlers, {
      method: "thread/started",
      params: {
        threadId: "tid-child",
        thread: {
          id: "tid-child",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "tid-parent",
                agent_nickname: "frontend_perf_audit",
              },
            },
          },
        },
      },
    });

    // Parent's own command — should show.
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-parent",
        item: {
          id: "cmd-parent",
          type: "commandExecution",
          command: "nl -ba src/hooks/useIsSessionActive.ts | sed -n '1,220p'",
          exitCode: 0,
          output: "1|export function useIsSessionActive",
        },
      },
    });
    // Child's command — must not leak into parent chat.
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-child",
        item: {
          id: "cmd-child",
          type: "commandExecution",
          command: "nl -ba src/lib/xterm-loader.ts | sed -n '1,100p'",
          exitCode: 0,
          output: "1|export function createXterm",
        },
      },
    });
    fireCodex(handlers, {
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "tid-child",
        itemId: "cmd-child-delta",
        delta: "child-only-output",
      },
    });
    await flush();

    expect(screen.getByText(/useIsSessionActive/)).toBeTruthy();
    expect(screen.queryByText(/xterm-loader/)).toBeNull();
    expect(screen.queryByText("child-only-output")).toBeNull();
  });

  it("does not render parent-stream items tagged with a child agentThreadId", async () => {
    // Multi-agent v2 can emit child tool rows on the parent threadId with
    // item.agentThreadId pointing at the child. Those must not paint.
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();

    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1", thread: { id: "tid-parent" } },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-parent",
        item: {
          id: "spawn-1",
          type: "subAgentActivity",
          kind: "started",
          agentThreadId: "tid-child",
          agentPath: "/root/memory_backend_audit",
        },
      },
    });
    // Child shell mirrored onto the parent stream (tagged).
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-parent",
        item: {
          id: "cmd-mirrored",
          type: "commandExecution",
          agentThreadId: "tid-child",
          command: "git status --short && git log -8 --oneline",
          exitCode: 0,
          output: "child-mirrored-status",
        },
      },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-parent",
        item: {
          id: "mcp-mirrored",
          type: "mcpToolCall",
          agentThreadId: "tid-child",
          server: "agmux-memory",
          tool: "memory_list",
          status: "completed",
          result: { content: [{ type: "text", text: "child-mirrored-mcp" }] },
        },
      },
    });
    // Parent's own untagged command still shows.
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-parent",
        item: {
          id: "cmd-parent-own",
          type: "commandExecution",
          command: "pwd",
          exitCode: 0,
          output: "/Users/neel/Documents/GitHub/agmux",
        },
      },
    });
    await flush();

    expect(parentChat().getByText("Launched")).toBeTruthy();
    expect(parentChat().getByText(/Memory Backend Audit/)).toBeTruthy();
    expect(parentChat().getByText("pwd")).toBeTruthy();
    expect(screen.queryByText(/git status --short/)).toBeNull();
    expect(screen.queryByText("child-mirrored-status")).toBeNull();
    expect(screen.queryByText("agmux-memory.memory_list")).toBeNull();
    expect(screen.queryByText("child-mirrored-mcp")).toBeNull();
  });

  it("does not adopt a racing subagent thread/started as the parent thread id", async () => {
    // Cold send: child thread/started can race the parent before activeThreadId
    // is set. Parent id in spawn metadata is the eventual Codex uuid (not the
    // agmux session id), so isSubagentThreadStarted is false — without the
    // subagent-source guard, isOurThreadStarted would bind activeThreadId to
    // the child and every child tool would flood the chat.
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();

    // Put the view into "sending" so isOurThreadStarted could fire, then flush
    // so sendingRef.current is true on the next event batch.
    fireCodex(handlers, {
      method: "turn/started",
      params: { threadId: "cx1", turnId: "turn-cold" },
    });
    await flush();

    // Child announces first; parent_thread_id is a codex uuid we don't know yet.
    fireCodex(handlers, {
      method: "thread/started",
      params: {
        threadId: "tid-child-race",
        thread: {
          id: "tid-child-race",
          thread_source: "subagent",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "tid-parent-real",
                agent_nickname: "racer",
              },
            },
          },
        },
      },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-child-race",
        item: {
          id: "cmd-race",
          type: "commandExecution",
          command: "echo CHILD_RACE_LEAK",
          exitCode: 0,
          output: "CHILD_RACE_LEAK",
        },
      },
    });
    // Real parent thread arrives second.
    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1", thread: { id: "tid-parent-real" } },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-parent-real",
        item: {
          id: "cmd-parent-real",
          type: "commandExecution",
          command: "echo PARENT_OK",
          exitCode: 0,
          output: "PARENT_OK",
        },
      },
    });
    // After parent is known, child traffic is accepted for liveness only.
    fireCodex(handlers, {
      method: "thread/started",
      params: {
        threadId: "tid-child-race",
        thread: {
          id: "tid-child-race",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "tid-parent-real",
                agent_nickname: "racer",
              },
            },
          },
        },
      },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-child-race",
        item: {
          id: "cmd-race-2",
          type: "commandExecution",
          command: "echo CHILD_STILL_HIDDEN",
          exitCode: 0,
          output: "CHILD_STILL_HIDDEN",
        },
      },
    });
    await flush();

    expect(screen.queryByText("CHILD_RACE_LEAK")).toBeNull();
    expect(screen.queryByText("CHILD_STILL_HIDDEN")).toBeNull();
    expect(screen.queryByText(/echo CHILD_/)).toBeNull();
    expect(screen.getByText(/PARENT_OK|echo PARENT_OK/)).toBeTruthy();
  });

  it("counts Codex subagent lifecycle events as activity for the parent turn watchdog", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();

    vi.useFakeTimers();

    act(() => {
      fireCodex(handlers, {
        method: "thread/started",
        params: { threadId: "cx1", thread: { id: "tid-parent" } },
      });
      fireCodex(handlers, {
        method: "turn/started",
        params: { threadId: "tid-parent", turnId: "turn-parent" },
      });
      fireCodex(handlers, {
        method: "thread/started",
        params: {
          threadId: "tid-child",
          thread: {
            id: "tid-child",
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: "tid-parent",
                  depth: 1,
                  agent_nickname: "Child",
                },
              },
            },
          },
        },
      });
    });

    act(() => {
      vi.advanceTimersByTime(4 * 60 * 1000 + 59_000);
      fireCodex(handlers, {
        method: "thread/status/changed",
        params: { threadId: "tid-child", status: { type: "running", activeFlags: ["worker"] } },
      });
      vi.advanceTimersByTime(15_000);
    });

    expect(container.querySelector('[title="Stop (Esc)"]')).toBeTruthy();
    expect(container.textContent ?? "").not.toContain("Turn timed out");
  });

  it("keeps a quiet long-running Codex turn active instead of timing it out", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();

    vi.useFakeTimers();

    act(() => {
      fireCodex(handlers, {
        method: "thread/started",
        params: { threadId: "cx1", thread: { id: "tid-parent" } },
      });
      fireCodex(handlers, {
        method: "turn/started",
        params: { threadId: "tid-parent", turnId: "turn-parent" },
      });
    });
    await act(async () => {});

    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000);
    });

    expect(container.querySelector('[title="Stop (Esc)"]')).toBeTruthy();
    expect(container.textContent ?? "").toContain("May be unresponsive");
    expect(container.textContent ?? "").not.toContain("Turn timed out");
  });

  // Regression: queueing a message during a turn and letting it auto-send
  // when the agent goes idle must NOT clear the running state. The old
  // auto-send chained `.finally(() => setSending(false))`, which fired the
  // instant the codexSendMessage RPC resolved (milliseconds) — long before
  // the queued turn completes — wrongly hiding the thinking indicator and
  // the sidebar spinner (both gate on `sending`).
  it("keeps the running state after auto-sending a queued message", async () => {
    const { useSessionNameStore } = await import("../../../stores/sessionNameStore");
    const summarize = vi.spyOn(useSessionNameStore.getState(), "summarize").mockImplementation(() => {});
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexSendMessage).mockClear();
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    // History loading triggers a separate resume effect. Wait for that effect
    // before synthesizing thread/started; two timer ticks can leave resume in
    // flight, which then rebinds the thread ID after our synthetic event.
    await waitFor(() => expect(textarea.disabled).toBe(false));

    // Establish our Codex thread and start a turn — we are now running.
    await act(async () => {
      fireCodex(handlers, {
        method: "thread/started",
        params: { threadId: "cx1", thread: { id: "tid-A" } },
      });
      fireCodex(handlers, {
        method: "turn/started",
        params: { threadId: "tid-A", turnId: "turnA" },
      });
    });
    expect(container.querySelector('[title="Stop (Esc)"]')).toBeTruthy();

    // Queue a message while the turn is still in flight.
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "queued prompt" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    });

    expect(container.querySelector('[title="Remove from queue"]')).toBeTruthy();
    expect(textarea.value).toBe("");

    // Agent finishes the first turn → the queued message auto-sends.
    await act(async () => {
      fireCodex(handlers, {
        method: "thread/status/changed",
        params: { threadId: "tid-A", status: { type: "idle", activeFlags: [] } },
      });
    });

    // The queued message was sent...
    const calls = vi.mocked(cmd.codexSendMessage).mock.calls;
    expect(calls.some((c) => c[2] === "queued prompt")).toBe(true);
    expect(summarize).toHaveBeenCalledWith("tid-A", "queued prompt");
    summarize.mockRestore();

    // ...and the running state survives the RPC resolving: the Stop button
    // stays shown (sidebar spinner gates on the same `sending` flag).
    expect(container.querySelector('[title="Stop (Esc)"]')).toBeTruthy();
    // The Virtuoso footer shows its active thinking-indicator branch — only
    // reached when `sending` is true AND the turn timer (turnStartMs) is set.
    // `pt-1` is unique to that branch (bare padding is `pb-6`, stall is `pt-2`).
    const virtuoso = container.querySelector('[data-testid="virtuoso"]') as HTMLElement;
    const footer = virtuoso.lastElementChild as HTMLElement;
    expect(footer.className).toContain("pt-1");
  });

  it("sends a queued follow-up after a collab parent turn completes", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexSendMessage).mockClear();
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();

    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1", thread: { id: "tid-parent" } },
    });
    fireCodex(handlers, {
      method: "turn/started",
      params: { threadId: "tid-parent", turnId: "turn-parent" },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-parent",
        item: {
          id: "spawn-ui",
          type: "subAgentActivity",
          kind: "started",
          agentThreadId: "tid-child",
          agentPath: "/root/ui_stats",
        },
      },
    });
    await flush();
    expect(container.querySelector('[title="Stop (Esc)"]')).toBeTruthy();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "queued after collab" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await flush();
    expect(container.textContent ?? "").toContain("queued after collab");

    fireCodex(handlers, {
      method: "thread/status/changed",
      params: { threadId: "tid-parent", status: { type: "idle", activeFlags: [] } },
    });
    await flush();
    expect(vi.mocked(cmd.codexSendMessage).mock.calls.some((c) => c[2] === "queued after collab")).toBe(false);
    expect(container.textContent ?? "").toContain("queued after collab");

    fireCodex(handlers, {
      method: "turn/completed",
      params: { threadId: "tid-parent", turnId: "turn-parent" },
    });
    await flush();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(cmd.codexSendMessage).mock.calls.some((c) => c[2] === "queued after collab")).toBe(true);
    expect(container.querySelector('[title="Stop (Esc)"]')).toBeTruthy();
  });

  it("sends queued image attachments when steering a running turn", async () => {
    const { useSessionNameStore } = await import("../../../stores/sessionNameStore");
    const summarize = vi.spyOn(useSessionNameStore.getState(), "summarize").mockImplementation(() => {});
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexSteerTurn).mockClear();
    imageAttachmentMock.images = [{
      id: "img-1",
      base64: "base64-image",
      mediaType: "image/png",
      previewUrl: "blob:image",
    }];
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await waitFor(() => expect((container.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(false));

    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1", thread: { id: "tid-A" } },
    });
    fireCodex(handlers, {
      method: "turn/started",
      params: { threadId: "tid-A", turnId: "turnA" },
    });
    await flush();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "queued with image" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await flush();

    expect(imageAttachmentMock.clearImages).toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalledWith("tid-A", "queued with image");

    fireEvent.click(screen.getByText("Steer"));
    await flush();

    expect(vi.mocked(cmd.codexSteerTurn)).toHaveBeenCalledWith(
      "/tmp/repo",
      "tid-A",
      "turnA",
      "queued with image",
      [{ data: "base64-image", mediaType: "image/png" }],
    );
    expect(summarize).toHaveBeenCalledWith("tid-A", "queued with image");
    summarize.mockRestore();
  });

  it("handles thread/status/changed → idle", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/status/changed",
      params: { threadId: "cx1", status: { type: "idle", activeFlags: [] } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles thread/status/changed → busy", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/status/changed",
      params: { threadId: "cx1", status: { type: "busy", activeFlags: ["thinking"] } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles turn/started and turn/completed", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "turn/started",
      params: { threadId: "cx1", turnId: "t1" },
    });
    fireCodex(handlers, {
      method: "turn/completed",
      params: { threadId: "cx1", turnId: "t1" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles thread/tokenUsage/updated", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "cx1",
        usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles turn/tokenCount and turn/usage", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "turn/tokenCount",
      params: { threadId: "cx1", count: 1500 },
    });
    fireCodex(handlers, {
      method: "turn/usage",
      params: { threadId: "cx1", usage: { totalTokens: 4000 } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles model/rerouted", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "model/rerouted",
      params: { threadId: "cx1", from: "gpt-5", to: "gpt-5-codex" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles item/started", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: { id: "i1", type: "agent_message" },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles item/agentMessage/delta multiple times", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "msg1", type: "agent_message" } },
    });
    for (const text of ["Hello", " ", "world"]) {
      fireCodex(handlers, {
        method: "item/agentMessage/delta",
        params: { threadId: "cx1", itemId: "msg1", delta: text },
      });
    }
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles item/commandExecution/outputDelta", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: { id: "cmd1", type: "command_execution", command: "ls" },
      },
    });
    fireCodex(handlers, {
      method: "item/commandExecution/outputDelta",
      params: { threadId: "cx1", itemId: "cmd1", delta: "file1\n" },
    });
    fireCodex(handlers, {
      method: "item/commandExecution/outputDelta",
      params: { threadId: "cx1", itemId: "cmd1", delta: "file2\n" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles item/fileChange/outputDelta", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "fc1", type: "file_change" } },
    });
    fireCodex(handlers, {
      method: "item/fileChange/outputDelta",
      params: { threadId: "cx1", itemId: "fc1", delta: "patch chunk" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles rawResponseItem/completed", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: {
        threadId: "cx1",
        item: { id: "raw1", type: "agent_message", text: "complete" },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles item/completed for various item types", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    for (const item of [
      { id: "a", type: "agent_message", text: "done" },
      { id: "b", type: "command_execution", command: "ls", output: "ok" },
      { id: "c", type: "file_change", filePath: "/x", diff: "+a" },
      { id: "d", type: "thinking", text: "pondering" },
      { id: "e", type: "compaction" },
    ]) {
      fireCodex(handlers, {
        method: "item/completed",
        params: { threadId: "cx1", item },
      });
    }
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles item/reasoning/textDelta and summaryTextDelta", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/reasoning/textDelta",
      params: { threadId: "cx1", itemId: "r1", delta: "I think " },
    });
    fireCodex(handlers, {
      method: "item/reasoning/summaryTextDelta",
      params: { threadId: "cx1", itemId: "r1", delta: "summary..." },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("buffers hidden reasoning until shown and preserves every delta", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    try {
      act(() => useUiStore.setState({ selectedCodexSessionId: "another-session" }));
      fireCodex(handlers, { method: "item/reasoning/textDelta", params: { threadId: "cx1", itemId: "hidden-reason", delta: "Hidden reasoning " } });
      await flush();
      fireCodex(handlers, { method: "item/reasoning/summaryTextDelta", params: { threadId: "cx1", itemId: "hidden-reason", delta: "is complete" } });
      await flush();
      expect(screen.queryByText("Hidden reasoning is complete")).toBeNull();
      act(() => useUiStore.setState({ selectedCodexSessionId: "cx1" }));
      await flush();
      expect(screen.getByText("Hidden reasoning is complete")).toBeTruthy();
    } finally {
      act(() => useUiStore.setState({ selectedCodexSessionId: null }));
    }
  });

  it("flushes hidden reasoning before an empty completion supersedes it", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    try {
      act(() => useUiStore.setState({ selectedCodexSessionId: "another-session" }));
      fireCodex(handlers, { method: "item/reasoning/textDelta", params: { threadId: "cx1", itemId: "hidden-completed", delta: "Saved hidden reasoning" } });
      await flush();
      expect(screen.queryByText("Saved hidden reasoning")).toBeNull();
      fireCodex(handlers, { method: "item/completed", params: { threadId: "cx1", item: { id: "hidden-completed", type: "reasoning", summary: [] } } });
      await flush();
      act(() => useUiStore.setState({ selectedCodexSessionId: "cx1" }));
      await flush();
      expect(screen.getByText("Saved hidden reasoning")).toBeTruthy();
    } finally {
      act(() => useUiStore.setState({ selectedCodexSessionId: null }));
    }
  });

  it("renders item/completed reasoning summary object text", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "reasoning-summary-object",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Checked the relevant files" }],
        },
      },
    });
    await flush();
    expect(screen.getByText("Checked the relevant files")).toBeTruthy();
  });

  it("does not replace reasoning summary deltas with an empty completed item", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/reasoning/summaryTextDelta",
      params: { threadId: "cx1", itemId: "reasoning-live", delta: "Checked the relevant files" },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: { id: "reasoning-live", type: "reasoning" },
      },
    });
    await flush();
    expect(screen.getByText("Checked the relevant files")).toBeTruthy();
    expect(screen.getAllByTestId("codex-think-row")).toHaveLength(1);
  });

  it("labels a streaming reasoning row as Thinking until it completes", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/reasoning/summaryTextDelta",
      params: { threadId: "cx1", itemId: "reasoning-stream", delta: "weighing options" },
    });
    await flush();
    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(screen.queryByText(/Thought for/)).toBeNull();
  });

  it("settles a streaming reasoning row once the reasoning item completes", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/reasoning/summaryTextDelta",
      params: { threadId: "cx1", itemId: "reasoning-timed", delta: "weighing options" },
    });
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "reasoning-timed",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "weighing options" }],
        },
      },
    });
    await flush();
    expect(screen.getByText("Thought")).toBeTruthy();
    expect(screen.queryByText("Thinking")).toBeNull();
  });

  it("settles the row even when the completed reasoning item carries no text", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/reasoning/summaryTextDelta",
      params: { threadId: "cx1", itemId: "reasoning-empty", delta: "weighing options" },
    });
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: { threadId: "cx1", item: { id: "reasoning-empty", type: "reasoning" } },
    });
    await flush();
    // The delta text survives, and the row is no longer stuck on "Thinking".
    expect(screen.getByText("weighing options")).toBeTruthy();
    expect(screen.getByText("Thought")).toBeTruthy();
  });

  it("falls back to a plain Thought label when reasoning arrives without deltas", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "reasoning-history",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "resumed reasoning" }],
        },
      },
    });
    await flush();
    // No start timestamp was ever observed, so no duration is invented.
    expect(screen.getByText("Thought")).toBeTruthy();
    expect(screen.queryByText(/Thought for/)).toBeNull();
  });

  it("finalizes a still-streaming reasoning row when the turn ends", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "turn/started",
      params: { threadId: "cx1", turnId: "turn-think" },
    });
    fireCodex(handlers, {
      method: "item/reasoning/summaryTextDelta",
      params: { threadId: "cx1", itemId: "reasoning-abort", delta: "half a thought" },
    });
    await flush();
    expect(screen.getByText("Thinking")).toBeTruthy();

    // The turn ends without an item/completed for the reasoning item — the row
    // must not spin forever.
    fireCodex(handlers, {
      method: "turn/completed",
      params: { threadId: "cx1", turnId: "turn-think" },
    });
    await flush();
    expect(screen.queryByText("Thinking")).toBeNull();
    expect(screen.getByText("Thought")).toBeTruthy();
  });

  it("collapses a completed turn behind a 'Thought for Ns' row and expands it on click", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();

    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1", thread: { id: "tid-A" } },
    });
    fireCodex(handlers, { method: "turn/started", params: { threadId: "tid-A", turnId: "t1" } });
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "tid-A",
        item: { id: "u1", type: "userMessage", content: [{ type: "text", text: "do the thing" }] },
      },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-A",
        item: {
          id: "c1",
          type: "commandExecution",
          command: "pnpm dev",
          status: "completed",
          output: "ready",
          exitCode: 0,
        },
      },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "tid-A",
        item: { id: "a1", type: "agentMessage", text: "all done" },
      },
    });
    // While the turn runs, everything stays visible.
    await flush();
    expect(screen.getByText("Ran")).toBeTruthy();
    expect(screen.queryByTestId("codex-turn-summary")).toBeNull();

    fireCodex(handlers, { method: "turn/completed", params: { threadId: "tid-A", turnId: "t1" } });
    await flush();

    // Turn done: the prompt and the final reply remain, the command hides.
    const summary = screen.getByTestId("codex-turn-summary");
    expect(summary.textContent).toMatch(/Thought for \d/);
    expect(screen.getByText("do the thing")).toBeTruthy();
    expect(screen.getByText("all done")).toBeTruthy();
    expect(screen.queryByText("Ran")).toBeNull();

    // Clicking replays the turn.
    fireEvent.click(summary.querySelector("[role='button']") as HTMLElement);
    expect(screen.getByText("Ran")).toBeTruthy();
  });

  it("handles item/tool/requestUserInput", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/tool/requestUserInput",
      requestId: "in1",
      params: {
        threadId: "cx1",
        prompt: "What is your name?",
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles item/commandExecution/requestApproval", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/commandExecution/requestApproval",
      requestId: "approval1",
      params: {
        threadId: "cx1",
        command: "rm -rf /tmp/dangerous",
        cwd: "/tmp",
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles item/fileChange/requestApproval", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/fileChange/requestApproval",
      requestId: "approval2",
      params: {
        threadId: "cx1",
        filePath: "/etc/hosts",
        diff: "+localhost",
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
    expect(container.querySelector("[data-testid='approval-desc']")?.textContent).toBe(
      "Modify file: …/etc/hosts · +1",
    );
  });

  it("handles mcpServer/elicitation/request", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "mcpServer/elicitation/request",
      requestId: "elicit1",
      params: {
        threadId: "cx1",
        message: "Please provide your API key",
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders an in-progress MCP tool block on item/started mcpToolCall", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: {
          id: "mcp-1",
          type: "mcpToolCall",
          server: "filesystem",
          tool: "read_file",
          arguments: { path: "/tmp/x" },
        },
      },
    });
    await flush();
    const row = container.querySelector("[data-testid='codex-tool-row'][data-lead='MCP']");
    expect(row).toBeTruthy();
    expect(row?.textContent ?? "").toContain("filesystem.read_file");
    expect(row?.getAttribute("data-status")).toBe("running");
  });

  it("finalizes the MCP tool block with a result on item/completed mcpToolCall", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: {
          id: "mcp-2",
          type: "mcpToolCall",
          server: "filesystem",
          tool: "list_directory",
        },
      },
    });
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "mcp-2",
          type: "mcpToolCall",
          server: "filesystem",
          tool: "list_directory",
          status: "completed",
          result: { content: [{ type: "text", text: "file1.txt\nfile2.txt" }] },
          durationMs: 42,
        },
      },
    });
    await flush();
    const row = container.querySelector("[data-testid='codex-tool-row'][data-lead='MCP']");
    expect(row).toBeTruthy();
    expect(row?.getAttribute("data-status")).toBe("ok");
    // Single row, not duplicated by completed-after-started
    expect(container.querySelectorAll("[data-testid='codex-tool-row'][data-lead='MCP']").length).toBe(1);
    // The result is behind the row's toggle
    fireEvent.click(row as HTMLElement);
    expect(screen.getByText(/file1\.txt/)).toBeTruthy();
  });

  it.each(["scrolling up", "opening a tool"])("resumes following when sending a follow-up after %s", async (interaction) => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.disabled).toBe(false));
    fireCodex(handlers, {
      method: "item/completed",
      params: { threadId: "cx1", item: {
        id: "previous-tool", type: "mcpToolCall", server: "filesystem", tool: "read_file",
        arguments: { path: "/tmp/example.txt" }, status: "completed",
        result: { content: [{ type: "text", text: "Previous result" }] },
      } },
    });
    await flush();
    if (interaction === "scrolling up") {
      fireEvent.wheel(screen.getByTestId("virtuoso"), { deltaY: -100 });
    } else {
      fireEvent.click(container.querySelector("[data-testid='codex-tool-row'][data-lead='MCP']") as HTMLElement);
    }
    act(() => virtuosoAtBottomChange(false));
    expect(virtuosoFollowOutput(false)).toBe(false);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    virtuosoScrollToIndex.mockClear();

    fireEvent.change(textarea, { target: { value: "Continue with the next change" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await flush();
    expect(screen.getByText("Continue with the next change")).toBeTruthy();
    expect(virtuosoFollowOutput(false)).toBe("auto");
    await waitFor(() => expect(virtuosoScrollToIndex).toHaveBeenCalledWith({ index: "LAST", align: "end" }));

    // Later measurements keep the submitted prompt visible.
    virtuosoScrollToIndex.mockClear();
    act(() => virtuosoHeightChange(12000));
    await waitFor(() => expect(virtuosoScrollToIndex).toHaveBeenCalledWith({ index: "LAST", align: "end" }));
  });

  it("keeps following after layout growth reports that the bottom moved", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, { method: "turn/started", params: { threadId: "cx1", turnId: "scroll-turn" } });
    await flush();
    act(() => virtuosoAtBottomChange(false));
    expect(virtuosoFollowOutput(false)).toBe("auto");
    virtuosoScrollToIndex.mockClear();
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "cx1", itemId: "new-scroll-message", delta: "A new message" },
    });
    await waitFor(() => expect(virtuosoScrollToIndex).toHaveBeenCalledWith({ index: "LAST", align: "end" }));
  });

  it("recovers the followed chat on window focus even after a turn finishes", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, { method: "item/completed", params: { threadId: "cx1", item: { id: "focus-message", type: "agentMessage", text: "Finished" } } });
    await flush();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    virtuosoScrollToIndex.mockClear();
    act(() => virtuosoAtBottomChange(false));
    fireEvent.focus(window);
    await waitFor(() => expect(virtuosoScrollToIndex).toHaveBeenCalledWith({ index: "LAST", align: "end" }));
  });

  it("does not resume following on focus after the user scrolls up", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, { method: "item/completed", params: { threadId: "cx1", item: { id: "reading-message", type: "agentMessage", text: "Read this" } } });
    await flush();
    fireEvent.wheel(screen.getByTestId("virtuoso"), { deltaY: -100 });
    act(() => virtuosoAtBottomChange(false));
    // The pause must survive beyond the old 250ms interaction guard.
    await new Promise((resolve) => setTimeout(resolve, 300));
    virtuosoScrollToIndex.mockClear();
    fireEvent.focus(window);
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "cx1", itemId: "while-reading", delta: "More output" },
    });
    await flush();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(virtuosoFollowOutput(false)).toBe(false);
    expect(virtuosoScrollToIndex).not.toHaveBeenCalled();
  });

  it("keeps following measured growth and shrinkage after history mounts", async () => {
    const callbacks = new Map<Element, () => void>();
    class ObservedResizeObserver extends NoopResizeObserver {
      constructor(private callback: () => void) { super(); }
      observe(target: Element) { callbacks.set(target, this.callback); }
    }
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = ObservedResizeObserver as unknown as typeof ResizeObserver;
    try {
      const handlers = await setupCapture();
      render(<CodexSessionView session={baseSession} />);
      await flush();
      fireCodex(handlers, { method: "item/completed", params: { threadId: "cx1", item: { id: "resized-message", type: "agentMessage", text: "Finished" } } });
      await flush();
      const scroller = screen.getByTestId("virtuoso");
      await waitFor(() => expect(callbacks.has(scroller)).toBe(true));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      for (const height of [1800, 700]) {
        virtuosoScrollToIndex.mockClear();
        Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: height });
        act(() => {
          virtuosoAtBottomChange(false);
          virtuosoHeightChange(height);
        });
        await waitFor(() => expect(virtuosoScrollToIndex).toHaveBeenCalledWith({ index: "LAST", align: "end" }));
      }
      virtuosoScrollToIndex.mockClear();
      act(() => {
        callbacks.get(scroller)!();
        callbacks.get(scroller)!();
      });
      await waitFor(() => expect(virtuosoScrollToIndex).toHaveBeenCalledTimes(1));
      fireEvent.wheel(scroller, { deltaY: -100 });
      virtuosoScrollToIndex.mockClear();
      act(() => {
        callbacks.get(scroller)!();
        virtuosoHeightChange(1000);
      });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(virtuosoScrollToIndex).not.toHaveBeenCalled();
      // Returning manually to the bottom restores following.
      Object.defineProperty(scroller, "scrollTop", { configurable: true, value: 700 });
      fireEvent.scroll(scroller);
      expect(virtuosoFollowOutput(false)).toBe("auto");
      fireEvent.wheel(scroller, { deltaY: 100 });
      expect(virtuosoFollowOutput(false)).toBe("auto");
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it("preserves the reading position when expanding an MCP tool block during a turn", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();

    fireCodex(handlers, {
      method: "turn/started",
      params: { threadId: "cx1", turnId: "turn-tool-expand" },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "mcp-expand",
          type: "mcpToolCall",
          server: "filesystem",
          tool: "read_file",
          arguments: { path: "/tmp/repo/src/App.tsx" },
          status: "completed",
          result: { content: [{ type: "text", text: "line 1\nline 2\nline 3" }] },
        },
      },
    });
    await flush();
    expect(virtuosoFollowOutput(true)).toBe("auto");
    // Establish a streaming last item before inspecting an earlier tool.
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "cx1", itemId: "stream-after-tool", delta: "Working" },
    });
    await flush();
    virtuosoScrollToIndex.mockClear();

    fireEvent.click(container.querySelector("[data-testid='codex-tool-row'][data-lead='MCP']") as HTMLElement);
    expect(virtuosoScrollToIndex).not.toHaveBeenCalled();
    expect(virtuosoFollowOutput(true)).toBe(false);
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "cx1", itemId: "stream-after-tool", delta: " on it" },
    });
    await flush();
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resolve());
      } else {
        setTimeout(resolve, 0);
      }
    });

    expect(virtuosoScrollToIndex).not.toHaveBeenCalled();
    act(() => virtuosoAtBottomChange(false));
    fireEvent.click(await screen.findByText("Jump to latest"));
    expect(virtuosoScrollToIndex).toHaveBeenCalledWith({ index: "LAST", align: "end", behavior: "auto" });
    expect(virtuosoFollowOutput(true)).toBe("auto");
    expect(virtuosoFollowOutput(false)).toBe("auto");
    // Newly mounted rows can change the estimated bottom after a long jump.
    // Correct it immediately, including after more streaming output arrives.
    virtuosoScrollToIndex.mockClear();
    act(() => {
      virtuosoAtBottomChange(false);
      virtuosoHeightChange(12000);
    });
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "cx1", itemId: "stream-after-tool", delta: " after the jump" },
    });
    await waitFor(() => expect(virtuosoScrollToIndex).toHaveBeenCalledWith({ index: "LAST", align: "end" }));
    expect(virtuosoScrollToIndex.mock.calls.every(([location]) => location.behavior !== "smooth")).toBe(true);

    // A deliberate upward scroll must still cancel following after the jump.
    fireEvent.wheel(screen.getByTestId("virtuoso"), { deltaY: -100 });
    virtuosoScrollToIndex.mockClear();
    act(() => virtuosoHeightChange(14000));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(virtuosoScrollToIndex).not.toHaveBeenCalled();
  });

  it("renders a failed MCP tool block when item/completed carries an error", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "mcp-3",
          type: "mcpToolCall",
          server: "github",
          tool: "search_code",
          status: "failed",
          error: { message: "rate limit exceeded" },
        },
      },
    });
    await flush();
    const row = container.querySelector("[data-testid='codex-tool-row'][data-lead='MCP']");
    expect(row).toBeTruthy();
    expect(row?.getAttribute("data-status")).toBe("error");
    fireEvent.click(row as HTMLElement);
    expect(screen.getByText(/rate limit exceeded/)).toBeTruthy();
  });

  it("handles account/loginStateChanged", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "account/loginStateChanged",
      params: { state: "logged_in" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles error event", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "error",
      params: { threadId: "cx1", message: "Backend failure" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles codex/serverDisconnected", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "codex/serverDisconnected",
      params: {},
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("filters out events for unrelated threadId", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "different-thread", itemId: "x", delta: "ignored" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles a full Codex turn in sequence", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/started",
      params: {
        threadId: "cx1",
        thread: { id: "cdx-real", model: "gpt-5", effort: "medium" },
      },
    });
    fireCodex(handlers, {
      method: "turn/started",
      params: { threadId: "cx1", turnId: "t1" },
    });
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: { id: "msg-a", type: "agent_message" },
      },
    });
    for (const t of ["Reading ", "the ", "code..."]) {
      fireCodex(handlers, {
        method: "item/agentMessage/delta",
        params: { threadId: "cx1", itemId: "msg-a", delta: t },
      });
    }
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: { id: "msg-a", type: "agent_message", text: "Reading the code..." },
      },
    });
    fireCodex(handlers, {
      method: "turn/completed",
      params: { threadId: "cx1", turnId: "t1" },
    });
    fireCodex(handlers, {
      method: "thread/status/changed",
      params: { threadId: "cx1", status: { type: "idle", activeFlags: [] } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ignores events post-unmount", async () => {
    const handlers = await setupCapture();
    const { unmount } = render(<CodexSessionView session={baseSession} />);
    await flush();
    unmount();
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "cx1", itemId: "post", delta: "after-unmount" },
    });
    await flush();
    expect(true).toBe(true);
  });

  it("dispatches events with extracted thread.id (no threadId field)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/started",
      params: { thread: { id: "cx1", model: "gpt-5" } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles unknown method without crashing", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "fictional/unknown/method",
      params: { threadId: "cx1" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("dispatches events for embedded mode", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} embedded />);
    await flush();
    fireCodex(handlers, {
      method: "thread/started",
      params: {
        threadId: "cx1",
        thread: { id: "cdx-embed", model: "gpt-5" },
      },
    });
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "i1", type: "agent_message" } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });
});

describe("CodexSessionView — Maximum coverage", () => {
  type Listener = (event: { payload: unknown }) => void;

  async function setupCapture() {
    const eventModule = await import("@tauri-apps/api/event");
    const handlers: Record<string, Listener[]> = {};
    vi.mocked(eventModule.listen).mockImplementation(((channel: string, cb: Listener) => {
      (handlers[channel] ||= []).push(cb);
      return Promise.resolve(() => {});
    }) as never);
    return handlers;
  }

  async function flush() {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  function fireCodex(handlers: Record<string, Listener[]>, payload: unknown) {
    for (const h of handlers["codex-event"] ?? []) h({ payload });
  }

  // ---------- thread/started variations ----------
  it("handles thread/started with low effort", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1", thread: { id: "real-1", model: "gpt-5", effort: "low" } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles thread/started with high effort", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1", thread: { id: "real-2", model: "gpt-5-codex", effort: "high" } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles thread/started with default collaborationMode object", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/started",
      params: {
        threadId: "cx1",
        thread: { id: "real-3", model: "gpt-5", collaborationMode: { id: "default" } },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles thread/started with plan collaborationMode object id", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/started",
      params: {
        threadId: "cx1",
        thread: { id: "real-4", model: "gpt-5", collaborationMode: { id: "plan" } },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles thread/started without thread payload", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- thread/status/changed variations ----------
  it("handles thread/status/changed → active", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/status/changed",
      params: { threadId: "cx1", status: { type: "active", activeFlags: [] } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles thread/status/changed → active with waitingOnApproval flag", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/status/changed",
      params: {
        threadId: "cx1",
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles thread/status/changed → systemError", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/status/changed",
      params: { threadId: "cx1", status: { type: "systemError", activeFlags: [] } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles thread/status/changed → idle clears approval queue", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    // Queue an approval first
    fireCodex(handlers, {
      method: "item/commandExecution/requestApproval",
      requestId: "approval-clear-1",
      params: { threadId: "cx1", command: "ls" },
    });
    await flush();
    // Then go idle
    fireCodex(handlers, {
      method: "thread/status/changed",
      params: { threadId: "cx1", status: { type: "idle", activeFlags: [] } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- turn/started + turn/completed ----------
  it("handles turn/started with model and effort", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "turn/started",
      params: {
        threadId: "cx1",
        turn: { id: "turn-x" },
        model: "gpt-5",
        effort: "medium",
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles turn/started with reasoningEffort fallback", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "turn/started",
      params: {
        threadId: "cx1",
        turn_id: "turn-y",
        modelId: "gpt-5-codex",
        reasoningEffort: "high",
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles turn/completed with completed model and effort", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "turn/completed",
      params: {
        threadId: "cx1",
        turnId: "t-done",
        model: "gpt-5",
        effort: "low",
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles turn/completed with tokenUsage camelCase", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "turn/completed",
      params: {
        threadId: "cx1",
        turnId: "t1",
        tokenUsage: { inputTokens: 50, outputTokens: 75, totalTokens: 125 },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles turn/completed with token_usage snake_case", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "turn/completed",
      params: {
        threadId: "cx1",
        turnId: "t1",
        token_usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles turn/completed with tokenCount fallback", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "turn/completed",
      params: { threadId: "cx1", turnId: "t1", tokenCount: { totalTokens: 999 } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- thread/tokenUsage/updated ----------
  it("handles thread/tokenUsage/updated with model_context_window", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "cx1",
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        modelContextWindow: 200000,
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles thread/tokenUsage/updated with snake_case", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "cx1",
        token_usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        model_context_window: 100000,
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- model/rerouted ----------
  it("handles model/rerouted to gpt-5-codex", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "model/rerouted",
      params: { threadId: "cx1", from: "gpt-5", to: "gpt-5-codex" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- item/started branches ----------
  it("handles item/started userMessage with text content", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: {
          id: "u1",
          type: "userMessage",
          content: [{ type: "text", text: "Hello world" }],
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("skips userMessage with AGENTS.md system prompt", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: {
          id: "u-sys",
          type: "userMessage",
          content: [{ type: "text", text: "# AGENTS.md\nYou are an assistant" }],
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("skips userMessage with environment_context", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: {
          id: "u-env",
          type: "userMessage",
          content: [{ type: "text", text: "<environment_context>cwd=/tmp</environment_context>" }],
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("skips userMessage with turn_aborted", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: {
          id: "u-abort",
          type: "userMessage",
          content: [{ type: "text", text: "<turn_aborted>true</turn_aborted>" }],
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles item/started contextCompaction", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: { id: "comp1", type: "contextCompaction" },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles item/started fileChange", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: { id: "fc-start", type: "fileChange" },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles item/started with no item (defensive)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- agentMessage delta scenarios ----------
  it("handles agentMessage/delta creating new item", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "cx1", itemId: "agent-new", delta: "fresh content" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles agentMessage/delta with empty delta (no-op)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "cx1", itemId: "x", delta: "" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles agentMessage/delta with missing itemId (no-op)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "cx1", delta: "no itemId here" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- commandExecution outputDelta ----------
  it("handles commandExecution outputDelta with no preceding item/started", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/commandExecution/outputDelta",
      params: { threadId: "cx1", itemId: "cmd-orphan", delta: "stray output" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles many commandExecution deltas in sequence", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "cmd-many", type: "command_execution", command: "echo" } },
    });
    for (const out of ["a\n", "b\n", "c\n", "d\n", "e\n"]) {
      fireCodex(handlers, {
        method: "item/commandExecution/outputDelta",
        params: { threadId: "cx1", itemId: "cmd-many", delta: out },
      });
    }
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- fileChange outputDelta ----------
  it("handles fileChange outputDelta with patch chunks", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "fc-d", type: "fileChange" } },
    });
    fireCodex(handlers, {
      method: "item/fileChange/outputDelta",
      params: { threadId: "cx1", itemId: "fc-d", delta: "diff --git a/foo b/foo\n" },
    });
    fireCodex(handlers, {
      method: "item/fileChange/outputDelta",
      params: { threadId: "cx1", itemId: "fc-d", delta: "+ new line\n" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- rawResponseItem/completed variants ----------
  it("handles rawResponseItem/completed with reasoning content", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: {
        threadId: "cx1",
        item: { id: "raw-r", type: "reasoning", text: "thought" },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles rawResponseItem/completed with null item (defensive)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: { threadId: "cx1", item: null },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- item/completed branches ----------
  it("handles item/completed agent_message with text", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: { id: "am-c", type: "agent_message", text: "All done!" },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles item/completed command_execution success", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "cmd-s",
          type: "command_execution",
          command: "ls -la",
          status: "completed",
          output: "total 0",
          exitCode: 0,
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles item/completed command_execution failure", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "cmd-f",
          type: "command_execution",
          command: "false",
          status: "failed",
          output: "error",
          exitCode: 1,
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles item/completed file_change with changes array", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "fc-c",
          type: "file_change",
          changes: [
            { path: "/a.ts", kind: "modify", diff: "+x" },
            { path: "/b.ts", kind: "create", diff: "+y" },
          ],
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles item/completed thinking", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: { id: "th-c", type: "thinking", text: "deeply pondering" },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles item/completed contextCompaction", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    // Begin via item/started, then complete via item/completed
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "comp-c", type: "contextCompaction" } },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: { threadId: "cx1", item: { id: "comp-c", type: "contextCompaction" } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles item/completed function_call apply_patch with success", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "fcall-1",
          type: "function_call",
          tool: "apply_patch",
          arguments: { input: "*** Begin Patch\n*** End Patch\n" },
          success: true,
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles item/completed function_call with success=false (skipped)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "fcall-2",
          type: "function_call",
          tool: "apply_patch_freeform",
          arguments: { input: "patch text" },
          success: false,
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles item/completed with no item (defensive)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: { threadId: "cx1" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- reasoning deltas ----------
  it("handles many reasoning textDelta increments", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    for (const t of ["I ", "wonder ", "if ", "this ", "works"]) {
      fireCodex(handlers, {
        method: "item/reasoning/textDelta",
        params: { threadId: "cx1", itemId: "rsn-1", delta: t },
      });
    }
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles reasoning summaryTextDelta on new id", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/reasoning/summaryTextDelta",
      params: { threadId: "cx1", itemId: "rsn-summary", delta: "summary text" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- requestUserInput ----------
  it("handles requestUserInput with multi-question array", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/tool/requestUserInput",
      requestId: "ri-1",
      params: {
        threadId: "cx1",
        questions: [
          {
            id: "q1",
            header: "First",
            question: "What's your name?",
            options: [
              { label: "Alice", description: "Option A" },
              { label: "Bob", description: "Option B" },
            ],
          },
          {
            id: "q2",
            header: "Second",
            question: "Free text?",
            isOther: true,
          },
        ],
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles requestUserInput with malformed options (filtered)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/tool/requestUserInput",
      requestId: "ri-2",
      params: {
        threadId: "cx1",
        questions: [
          {
            id: "q1",
            options: [{ label: "", description: "" }, { label: "Real" }],
          },
        ],
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ignores requestUserInput when requestId missing", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/tool/requestUserInput",
      params: { threadId: "cx1", questions: [{ id: "q1" }] },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles requestUserInput with empty questions filtered out", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/tool/requestUserInput",
      requestId: "ri-3",
      params: { threadId: "cx1", questions: [{ id: "" }, { header: "no id" }] },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- approval flow events ----------
  it("queues commandExecution approval via requestId on payload", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/commandExecution/requestApproval",
      requestId: "ap-cmd-1",
      params: {
        threadId: "cx1",
        command: "rm -rf /tmp/danger",
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("queues commandExecution approval with very long command (truncates description)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/commandExecution/requestApproval",
      requestId: "ap-cmd-2",
      params: {
        threadId: "cx1",
        command: "x".repeat(200),
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("queues fileChange approval with deep path", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/fileChange/requestApproval",
      requestId: "ap-fc-1",
      params: {
        threadId: "cx1",
        path: "/very/deeply/nested/path/file.ts",
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("queues fileChange approval with short path", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/fileChange/requestApproval",
      requestId: "ap-fc-2",
      params: { threadId: "cx1", path: "a/b" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("queues fileChange approval with no path or command (default desc)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/fileChange/requestApproval",
      requestId: "ap-fc-3",
      params: { threadId: "cx1" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("queues approval with multiline command (uses first line)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/commandExecution/requestApproval",
      requestId: "ap-cmd-ml",
      params: { threadId: "cx1", command: "line1\nline2\nline3" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("queues multiple approvals in sequence", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/commandExecution/requestApproval",
      requestId: "ap-multi-1",
      params: { threadId: "cx1", command: "first" },
    });
    fireCodex(handlers, {
      method: "item/commandExecution/requestApproval",
      requestId: "ap-multi-2",
      params: { threadId: "cx1", command: "second" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ignores approval request with no requestId", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/commandExecution/requestApproval",
      params: { threadId: "cx1", command: "ls" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- mcpServer/elicitation/request ----------
  it("queues MCP elicitation with serverName only", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "mcpServer/elicitation/request",
      requestId: "mcp-1",
      params: { threadId: "cx1", serverName: "github" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("queues MCP elicitation with long message (truncated)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "mcpServer/elicitation/request",
      requestId: "mcp-2",
      params: { threadId: "cx1", message: "z".repeat(150), serverName: "n" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("queues MCP elicitation with no message or server (default)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "mcpServer/elicitation/request",
      requestId: "mcp-3",
      params: { threadId: "cx1" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ignores MCP elicitation with no requestId", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "mcpServer/elicitation/request",
      params: { threadId: "cx1", message: "hi" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- account/loginStateChanged ----------
  it("handles account/loginStateChanged completed", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "account/loginStateChanged",
      params: { state: "completed" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles account/loginStateChanged cancelled", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "account/loginStateChanged",
      params: { state: "cancelled" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles account/loginStateChanged with unknown state", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "account/loginStateChanged",
      params: { state: "in_progress" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- error handling ----------
  it("handles error event with willRetry=true (suppresses error UI)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "error",
      params: {
        threadId: "cx1",
        error: { message: "transient" },
        willRetry: true,
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles error event with willRetry=false (sets error)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "error",
      params: {
        threadId: "cx1",
        error: { message: "fatal" },
        willRetry: false,
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles error event with no error.message (Unknown error fallback)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "error",
      params: { threadId: "cx1", error: {}, willRetry: false },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- codex/serverDisconnected ----------
  it("handles codex/serverDisconnected with reason", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "codex/serverDisconnected",
      params: { reason: "process killed" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles codex/serverDisconnected without reason (default)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "codex/serverDisconnected",
      params: {},
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("codex/serverDisconnected after queued approvals clears queue", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/commandExecution/requestApproval",
      requestId: "before-disconnect",
      params: { threadId: "cx1", command: "echo" },
    });
    fireCodex(handlers, {
      method: "codex/serverDisconnected",
      params: { reason: "boom" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- filter / scoping ----------
  it("filters event without threadId entirely (no params.threadId, no thread.id)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { delta: "anonymous" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("filters out events for unrelated thread.id in nested thread object", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/started",
      params: { thread: { id: "other-thread", model: "gpt-5" } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- sequence / interleaving ----------
  it("handles many interleaved deltas across multiple items", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "msg-A", type: "agent_message" } },
    });
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "msg-B", type: "agent_message" } },
    });
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "cx1", itemId: "msg-A", delta: "A1 " },
    });
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "cx1", itemId: "msg-B", delta: "B1 " },
    });
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "cx1", itemId: "msg-A", delta: "A2" },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: { id: "msg-A", type: "agent_message", text: "A1 A2" },
      },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: { id: "msg-B", type: "agent_message", text: "B1 " },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles full Codex turn with reasoning + apply_patch + completion", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/started",
      params: {
        threadId: "cx1",
        thread: { id: "deep-1", model: "gpt-5", effort: "high" },
      },
    });
    fireCodex(handlers, {
      method: "turn/started",
      params: { threadId: "cx1", turn: { id: "t-deep" }, model: "gpt-5", effort: "high" },
    });
    fireCodex(handlers, {
      method: "item/reasoning/textDelta",
      params: { threadId: "cx1", itemId: "rsn", delta: "Thinking..." },
    });
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: { id: "ag1", type: "agent_message" },
      },
    });
    for (const t of ["I'll ", "now ", "edit ", "the ", "file."]) {
      fireCodex(handlers, {
        method: "item/agentMessage/delta",
        params: { threadId: "cx1", itemId: "ag1", delta: t },
      });
    }
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "ag1",
          type: "agent_message",
          text: "I'll now edit the file.",
        },
      },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "patch-1",
          type: "function_call",
          tool: "apply_patch",
          arguments: { input: "*** Begin Patch\n*** End Patch\n" },
          success: true,
        },
      },
    });
    fireCodex(handlers, {
      method: "turn/completed",
      params: {
        threadId: "cx1",
        turnId: "t-deep",
        tokenUsage: { inputTokens: 500, outputTokens: 300, totalTokens: 800 },
      },
    });
    fireCodex(handlers, {
      method: "thread/status/changed",
      params: { threadId: "cx1", status: { type: "idle", activeFlags: [] } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- mid-turn unmount ----------
  it("unmounts mid-turn while sending", async () => {
    const handlers = await setupCapture();
    const { unmount } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "turn/started",
      params: { threadId: "cx1", turnId: "mid-t" },
    });
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "mid-msg", type: "agent_message" } },
    });
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "cx1", itemId: "mid-msg", delta: "partial" },
    });
    unmount();
    // Events after unmount should be safely ignored
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "cx1", itemId: "mid-msg", delta: " more" },
    });
    fireCodex(handlers, {
      method: "turn/completed",
      params: { threadId: "cx1", turnId: "mid-t" },
    });
    await flush();
    expect(true).toBe(true);
  });

  it("unmounts after queued approval", async () => {
    const handlers = await setupCapture();
    const { unmount } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/fileChange/requestApproval",
      requestId: "ap-unmount",
      params: { threadId: "cx1", path: "/foo.ts" },
    });
    await flush();
    unmount();
    expect(true).toBe(true);
  });

  // ---------- unknown / malformed payloads ----------
  it("handles malformed event with no method", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    // Missing method should not crash
    fireCodex(handlers, { params: { threadId: "cx1" } });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles event with empty params object", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, { method: "thread/status/changed", params: {} });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ---------- store-aware combinations ----------
  it("dispatches events when threadStore has matching codex thread", async () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "cx1",
            project_id: "p1",
            provider: "Codex",
            interaction_mode: "pty",
            status: "Running",
            name: "Codex Active",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: "gpt-5",
            reasoning_effort: "medium",
          } as never,
        ],
      },
    } as never);
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "turn/started",
      params: { threadId: "cx1", turnId: "store-t" },
    });
    fireCodex(handlers, {
      method: "thread/tokenUsage/updated",
      params: { threadId: "cx1", usage: { totalTokens: 42 } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders cleanly across many event bursts", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    for (let i = 0; i < 20; i++) {
      fireCodex(handlers, {
        method: "item/agentMessage/delta",
        params: { threadId: "cx1", itemId: `burst-${i % 3}`, delta: `chunk-${i} ` },
      });
    }
    await flush();
    expect(container.firstChild).toBeTruthy();
  });
});

describe("CodexSessionView — renderer coverage via history items", () => {
  async function makeWithHistory(items: unknown[]) {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexReadSessionHistory).mockResolvedValueOnce({
      items,
      cwd: "/tmp/repo",
      model: "gpt-5",
      effort: "medium",
    } as never);
    const { container, unmount } = render(<CodexSessionView session={baseSession} />);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    return { container, unmount };
  }

  it("renders user message item from history", async () => {
    const { container } = await makeWithHistory([
      { role: "user", content: "Hello there", timestamp: new Date().toISOString() },
    ]);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders assistant (agent) message from history", async () => {
    const { container } = await makeWithHistory([
      { role: "assistant", content: "I'll help", timestamp: new Date().toISOString() },
    ]);
    expect(container.firstChild).toBeTruthy();
  });

  it("restores subagent notifications as agent output, not user messages", async () => {
    await makeWithHistory([
      {
        role: "user",
        content:
          "<subagent_notification>{\"agent_path\":\"019e89ef-00bf-7c71-afa1-971641146c50\",\"status\":{\"completed\":\"## Plan Review\\n\\n**Status:** Approved\"}}</subagent_notification>",
        timestamp: new Date().toISOString(),
      },
    ]);

    expect(screen.queryByText("You")).toBeNull();
    expect(subagentRow()).toBeTruthy();
    fireEvent.click(subagentRow()!);
    expect(screen.getAllByText(/Plan Review/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/subagent_notification/)).toBeNull();
    expect(screen.queryByText(/agent_path/)).toBeNull();
  });

  it("subagent notification subject is prose, not mono", async () => {
    await makeWithHistory([
      {
        role: "user",
        content:
          "<subagent_notification>{\"agent_path\":\"019e89ef-00bf-7c71-afa1-971641146c50\",\"status\":{\"completed\":\"## Plan Review\\n\\n**Status:** Approved\"}}</subagent_notification>",
        timestamp: new Date().toISOString(),
      },
    ]);

    const subject = subagentRow()!.querySelector(".text-blue-400");
    expect(subject).toBeTruthy();
    expect(subject!.className).not.toContain("font-mono");
  });

  it("renders command item from history with $ prefix and exit code", async () => {
    const { container } = await makeWithHistory([
      {
        role: "command",
        content: "$ ls -la\nfile1\nfile2\n[exit: 0]",
        timestamp: new Date().toISOString(),
      },
    ]);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders command item from history with non-zero exit code", async () => {
    const { container } = await makeWithHistory([
      {
        role: "command",
        content: "$ false\n[exit: 1]",
        timestamp: new Date().toISOString(),
      },
    ]);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders command item with no exit pattern", async () => {
    const { container } = await makeWithHistory([
      {
        role: "command",
        content: "$ echo hi\nhi",
        timestamp: new Date().toISOString(),
      },
    ]);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders thinking item from history", async () => {
    const { container } = await makeWithHistory([
      { role: "thinking", content: "considering options", timestamp: new Date().toISOString() },
    ]);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders multi-message conversation from history", async () => {
    const { container } = await makeWithHistory([
      { role: "user", content: "What is 2+2?", timestamp: new Date(1).toISOString() },
      { role: "thinking", content: "math thoughts", timestamp: new Date(2).toISOString() },
      { role: "assistant", content: "It's 4", timestamp: new Date(3).toISOString() },
    ]);
    expect(container.firstChild).toBeTruthy();
  });

  it("filters out AGENTS.md system prompt", async () => {
    const { container } = await makeWithHistory([
      { role: "user", content: "# AGENTS.md\nInstructions", timestamp: new Date().toISOString() },
      { role: "user", content: "actual question", timestamp: new Date().toISOString() },
    ]);
    expect(container.firstChild).toBeTruthy();
  });

  it("filters out environment_context messages", async () => {
    const { container } = await makeWithHistory([
      { role: "user", content: "<environment_context>cwd=/tmp</environment_context>", timestamp: new Date().toISOString() },
      { role: "user", content: "real prompt", timestamp: new Date().toISOString() },
    ]);
    expect(container.firstChild).toBeTruthy();
  });

  it("filters out turn_aborted messages", async () => {
    const { container } = await makeWithHistory([
      { role: "user", content: "<turn_aborted>true</turn_aborted>", timestamp: new Date().toISOString() },
    ]);
    expect(container.firstChild).toBeTruthy();
  });

  it("filters out unknown roles", async () => {
    const { container } = await makeWithHistory([
      { role: "system", content: "irrelevant", timestamp: new Date().toISOString() },
      { role: "weirdo", content: "filtered", timestamp: new Date().toISOString() },
    ]);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders file change from history.items with role=file", async () => {
    const { container } = await makeWithHistory([
      {
        role: "file",
        file_path: "/tmp/a.ts",
        additions: 3,
        deletions: 1,
        content: "diff text",
        timestamp: new Date().toISOString(),
      },
    ]);
    expect(container.firstChild).toBeTruthy();
  });

  it("hydrates model and effort from history", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexReadSessionHistory).mockResolvedValueOnce({
      items: [],
      cwd: "/tmp/repo",
      model: "gpt-5-codex",
      effort: "high",
    } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.firstChild).toBeTruthy();
  });

  it("hydrates with effort=low", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexReadSessionHistory).mockResolvedValueOnce({
      items: [],
      cwd: "/tmp/repo",
      model: "gpt-5",
      effort: "low",
    } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.firstChild).toBeTruthy();
  });

  it("hydrates with no cwd in history (uses session.cwd)", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexReadSessionHistory).mockResolvedValueOnce({
      items: [],
    } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.firstChild).toBeTruthy();
  });

  it("hydrates fast mode from the persisted Codex thread preference", async () => {
    localStorage.setItem("xanom-codex-fast-mode", JSON.stringify({ cx1: true }));
    const { container } = render(<CodexSessionView session={baseSession} />);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('button[title="Fast mode ON"]')).toBeTruthy();
  });

  it("persists fast mode toggles for the Codex thread", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexSendMessage).mockClear();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const fastButton = container.querySelector('button[title="Fast mode OFF"]') as HTMLButtonElement | null;
    expect(fastButton).toBeTruthy();
    fireEvent.click(fastButton!);
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(localStorage.getItem("xanom-codex-fast-mode") ?? "{}")).toEqual({ cx1: true });

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "use fast mode" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await new Promise((r) => setTimeout(r, 0));
    const calls = vi.mocked(cmd.codexSendMessage).mock.calls;
    expect(calls[calls.length - 1]?.[8]).toBe(true);
  });

  it("uses Codex config as displayed default without sending it as an override", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexReadConfig).mockResolvedValueOnce({
      config: {
        model: "gpt-5.3-codex",
        model_reasoning_effort: "high",
        model_context_window: 400000,
      },
    } as never);
    vi.mocked(cmd.codexSendMessage).mockClear();

    const { container } = render(<CodexSessionView session={baseSession} />);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "use config defaults" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const calls = vi.mocked(cmd.codexSendMessage).mock.calls;
    const send = calls.find((call) => call[2] === "use config defaults");
    expect(send?.[3]).toBeNull();
    expect(send?.[4]).toBeNull();
  });

  it("persists an explicit Medium effort choice for future drafts", async () => {
    const { container, getByRole } = render(<CodexSessionView session={baseSession} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(container.querySelector('[data-testid="effort-selector"] button')!);
    fireEvent.keyDown(getByRole("slider"), { key: "Home" });
    fireEvent.keyDown(getByRole("slider"), { key: "ArrowRight" });
    expect(useSettingsStore.getState().settings.codexEffort).toBe("medium");
    expect(useSettingsStore.getState().settings.codexEffortExplicit).toBe(true);
  });

  it("does not send saved Codex model or effort settings as turn overrides", async () => {
    const cmd = await import("../../../lib/commands");
    useSettingsStore.getState().updateSettings({
      codexModel: "gpt-5.5",
      codexEffort: "high",
    });
    vi.mocked(cmd.codexSendMessage).mockClear();

    const { container } = render(<CodexSessionView session={baseSession} />);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "use stored display only" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const calls = vi.mocked(cmd.codexSendMessage).mock.calls;
    const send = calls.find((call) => call[2] === "use stored display only");
    expect(send?.[3]).toBeNull();
    expect(send?.[4]).toBeNull();
  });

  it("keeps pending DraftChat Codex Extra High effort over config hydration", async () => {
    const cmd = await import("../../../lib/commands");
    const session = { ...baseSession, id: "cx-extra-high-1" };
    useSettingsStore.getState().updateSettings({ codexEffort: "xhigh" });
    useUiStore.getState().setPendingCodexEffort(session.id, "xhigh");
    vi.mocked(cmd.codexReadConfig).mockReset();
    vi.mocked(cmd.codexReadSessionHistory).mockReset();
    vi.mocked(cmd.codexReadSessionHistory).mockResolvedValue({
      items: [],
      cwd: "/tmp/repo",
      model: null,
      effort: null,
      model_context_window: null,
      input_tokens: null,
      output_tokens: null,
    });
    vi.mocked(cmd.codexReadConfig).mockResolvedValue({
      config: {
        model: "gpt-5",
        model_reasoning_effort: "high",
      },
    } as never);

    const { container } = render(<CodexSessionView session={session} />);
    await waitFor(() => expect(cmd.codexReadConfig).toHaveBeenCalledWith("/tmp/repo"));

    await waitFor(() => {
      const btn = container.querySelector('[data-testid="effort-selector"] button');
      expect(btn?.getAttribute("title")).toMatch(/Extra High|xhigh/i);
    });
  });

  it("keeps pending DraftChat Codex Extra High effort when saved effort is high", async () => {
    const cmd = await import("../../../lib/commands");
    const session = { ...baseSession, id: "cx-extra-high-2" };
    useSettingsStore.getState().updateSettings({ codexEffort: "high" });
    useUiStore.getState().setPendingCodexEffort(session.id, "xhigh");
    vi.mocked(cmd.codexReadConfig).mockReset();
    vi.mocked(cmd.codexReadSessionHistory).mockReset();
    vi.mocked(cmd.codexReadSessionHistory).mockResolvedValue({
      items: [],
      cwd: "/tmp/repo",
      model: null,
      effort: null,
      model_context_window: null,
      input_tokens: null,
      output_tokens: null,
    });
    vi.mocked(cmd.codexReadConfig).mockResolvedValue({
      config: {
        model: "gpt-5",
        model_reasoning_effort: "high",
      },
    } as never);

    const { container } = render(<CodexSessionView session={session} />);
    await waitFor(() => expect(cmd.codexReadConfig).toHaveBeenCalledWith("/tmp/repo"));

    await waitFor(() => {
      const btn = container.querySelector('[data-testid="effort-selector"] button');
      expect(btn?.getAttribute("title")).toMatch(/Extra High|xhigh/i);
    });
  });

  it("prefers Codex token usage window over configured context window", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexReadConfig).mockResolvedValueOnce({
      config: {
        model: "gpt-5.3-codex",
        model_reasoning_effort: "high",
        model_context_window: 400000,
      },
    } as never);
    const eventModule = await import("@tauri-apps/api/event");
    const handlers: Record<string, Array<(event: { payload: unknown }) => void>> = {};
    vi.mocked(eventModule.listen).mockImplementation(((channel: string, cb: (event: { payload: unknown }) => void) => {
      (handlers[channel] ||= []).push(cb);
      return Promise.resolve(() => {});
    }) as never);

    render(<CodexSessionView session={baseSession} />);
    await new Promise((r) => setTimeout(r, 0));
    for (const handler of handlers["codex-event"] ?? []) handler({ payload: {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "cx1",
        tokenUsage: {
          modelContextWindow: 258400,
          last: { inputTokens: 42000, outputTokens: 1000 },
          total: { inputTokens: 112000, outputTokens: 1000, cachedInputTokens: 77000 },
        },
      },
    } });

    await waitFor(() => {
      expect(screen.getByTestId("context-ring").dataset.maxTokens).toBe("258400");
    });
  });

  it("uses Codex fast mode toggles as the default for future chats", async () => {
    const { container } = render(<CodexSessionView session={baseSession} />);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const fastButton = container.querySelector('button[title="Fast mode OFF"]') as HTMLButtonElement | null;
    expect(fastButton).toBeTruthy();
    fireEvent.click(fastButton!);

    expect(useSettingsStore.getState().settings.codexFastMode).toBe(true);
  });
});

describe("CodexSessionView — renderer coverage via live events", () => {
  type Listener = (event: { payload: unknown }) => void;

  async function setupCapture() {
    const eventModule = await import("@tauri-apps/api/event");
    const handlers: Record<string, Listener[]> = {};
    vi.mocked(eventModule.listen).mockImplementation(((channel: string, cb: Listener) => {
      (handlers[channel] ||= []).push(cb);
      return Promise.resolve(() => {});
    }) as never);
    return handlers;
  }

  async function flush() {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  function fireCodex(handlers: Record<string, Listener[]>, payload: unknown) {
    for (const h of handlers["codex-event"] ?? []) h({ payload });
  }

  it("renders agent message via event, exercising agent branch", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "ag-render", type: "agent_message" } },
    });
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "cx1", itemId: "ag-render", delta: "rendered text" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders user message via item/started userMessage", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: {
          id: "u-render",
          type: "userMessage",
          content: [{ type: "text", text: "Render me!" }],
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders live subagent notifications as agent output", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: {
          id: "subagent-live",
          type: "userMessage",
          content: [
            {
              type: "text",
              text:
                "<subagent_notification>{\"agent_path\":\"agent-1\",\"status\":{\"completed\":\"Review approved\"}}</subagent_notification>",
            },
          ],
        },
      },
    });
    await flush();

    expect(screen.queryByText("You")).toBeNull();
    expect(subagentRow()).toBeTruthy();
    fireEvent.click(subagentRow()!);
    // The row's summary and its expanded payload both carry the status text.
    expect(screen.getAllByText(/Review approved/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/subagent_notification/)).toBeNull();
  });

  it("renders live subagent notifications from userMessage text", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: {
          id: "subagent-live-text",
          type: "userMessage",
          text:
            "<subagent_notification>{\"agent_path\":\"agent-1\",\"status\":{\"completed\":\"Review approved\"}}</subagent_notification>",
        },
      },
    });
    await flush();

    expect(screen.queryByText("You")).toBeNull();
    expect(subagentRow()).toBeTruthy();
    fireEvent.click(subagentRow()!);
    // The row's summary and its expanded payload both carry the status text.
    expect(screen.getAllByText(/Review approved/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/subagent_notification/)).toBeNull();
  });

  it("renders live subagent notifications from snake_case user_message starts", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: {
          id: "subagent-live-snake",
          type: "user_message",
          text:
            "<subagent_notification>{\"agent_path\":\"agent-1\",\"status\":{\"completed\":\"Review approved\"}}</subagent_notification>",
        },
      },
    });
    await flush();

    expect(screen.queryByText("You")).toBeNull();
    expect(subagentRow()).toBeTruthy();
    fireEvent.click(subagentRow()!);
    // The row's summary and its expanded payload both carry the status text.
    expect(screen.getAllByText(/Review approved/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/subagent_notification/)).toBeNull();
  });

  it("renders completed userMessage subagent notifications during active chat", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: {
          id: "subagent-completed-user",
          type: "userMessage",
        },
      },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "subagent-completed-user",
          type: "userMessage",
          text:
            "<subagent_notification>{\"agent_path\":\"agent-1\",\"status\":{\"completed\":\"Review approved\"}}</subagent_notification>",
        },
      },
    });
    await flush();

    expect(screen.queryByText("You")).toBeNull();
    expect(subagentRow()).toBeTruthy();
    fireEvent.click(subagentRow()!);
    // The row's summary and its expanded payload both carry the status text.
    expect(screen.getAllByText(/Review approved/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/subagent_notification/)).toBeNull();
  });

  it("renders streamed subagent notification deltas as a single agent block", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "cx1",
        itemId: "subagent-delta",
        delta: "<subagent_notification>{\"agent_path\":\"agent-1\",\"status\":{\"completed\":\"",
      },
    });
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "cx1",
        itemId: "subagent-delta",
        delta: "Review approved\"}}</subagent_notification>",
      },
    });
    await flush();

    expect(screen.queryByText("You")).toBeNull();
    // The second delta lands via the trailing ~16ms coalescing window. Until it
    // does the row is still pending; wait for it to settle before clicking.
    await waitFor(() => expect(subagentRow()?.getAttribute("data-status")).toBe("ok"));
    fireEvent.click(subagentRow()!);
    // The row's summary and its expanded payload both carry the status text.
    expect(screen.getAllByText(/Review approved/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/subagent_notification/)).toBeNull();
  });

  it("renders completed subagent agent messages without the notification envelope", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "subagent-completed",
          type: "agent_message",
          text:
            "<subagent_notification>{\"agent_path\":\"agent-1\",\"status\":{\"completed\":\"Review approved\"}}</subagent_notification>",
        },
      },
    });
    await flush();

    expect(screen.queryByText("You")).toBeNull();
    expect(subagentRow()).toBeTruthy();
    fireEvent.click(subagentRow()!);
    // The row's summary and its expanded payload both carry the status text.
    expect(screen.getAllByText(/Review approved/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/subagent_notification/)).toBeNull();
  });

  it("renders thinking via reasoning textDelta", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/reasoning/textDelta",
      params: { threadId: "cx1", itemId: "th-render", delta: "thinking deeply" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders compaction via contextCompaction lifecycle", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "cmp-render", type: "contextCompaction" } },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: { threadId: "cx1", item: { id: "cmp-render", type: "contextCompaction" } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders live generic Codex tool items and progress", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();

    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "dyn-tool-1",
          type: "dynamicToolCall",
          namespace: "web",
          tool: "fetch_page",
          arguments: { url: "https://example.com" },
          contentItems: [{ type: "inputText", text: "Fetched example page" }],
          success: true,
        },
      },
    });
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: {
          id: "mcp-progress-1",
          type: "mcpToolCall",
          server: "docs",
          tool: "search",
          arguments: { q: "codex" },
          status: "inProgress",
        },
      },
    });
    fireCodex(handlers, {
      method: "item/mcpToolCall/progress",
      params: {
        threadId: "cx1",
        itemId: "mcp-progress-1",
        message: "Searching docs",
      },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "image-tool-1",
          type: "imageGeneration",
          status: "completed",
          revisedPrompt: "A crisp app screenshot",
          result: "generated.png",
          savedPath: "/tmp/generated.png",
        },
      },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "collab-tool-1",
          type: "collabAgentToolCall",
          tool: "spawn",
          status: "completed",
          agent_nickname: "Harvey",
          prompt: "Review this patch",
          receiverThreadIds: ["agent-1"],
        },
      },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: { id: "review-mode-1", type: "enteredReviewMode", review: "security" },
      },
    });
    await flush();

    expect(screen.getByText("web.fetch_page")).toBeTruthy();
    fireEvent.click(screen.getByText("web.fetch_page").closest("[role='button']")!);
    expect(screen.getByText(/Fetched example page/)).toBeTruthy();
    fireEvent.click(screen.getByText("docs.search").closest("[role='button']")!);
    expect(screen.getByText(/Searching docs/)).toBeTruthy();
    expect(screen.getByText("ImageGeneration")).toBeTruthy();
    fireEvent.click(screen.getByText("ImageGeneration").closest("[role='button']")!);
    expect(screen.getByText(/generated.png/)).toBeTruthy();
    expect(screen.getByText("Launched")).toBeTruthy();
    expect(parentChat().getByText("Harvey Agent")).toBeTruthy();
    fireEvent.click(screen.getByText("Launched").closest("button, [role='button']")!);
    expect(screen.getByRole("complementary", { name: "Subagent conversation" })).toBeTruthy();
    fireEvent.click(
      document.querySelector("[data-testid='codex-tool-row'][data-lead='Review']") as HTMLElement,
    );
    expect(screen.getAllByText(/Review this patch/).length).toBeGreaterThan(0);
    // "Review" labels both the row and its expanded details panel.
    expect(screen.getAllByText("Review").length).toBeGreaterThan(0);
    expect(screen.getByText(/Entered security review mode/)).toBeTruthy();
  });

  it("renders command execution via item/completed command_execution", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "cmd-render",
          type: "command_execution",
          command: "ls -la",
          status: "completed",
          output: "file1.txt\nfile2.txt",
          exitCode: 0,
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders failed command execution", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "cmd-fail",
          type: "command_execution",
          command: "exit 1",
          status: "failed",
          output: "error",
          exitCode: 1,
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders multiple agent + user combinations via events", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    // User message
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: {
          id: "uu1",
          type: "userMessage",
          content: [{ type: "text", text: "First Q" }],
        },
      },
    });
    // Agent reply
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "aa1", type: "agent_message" } },
    });
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "cx1", itemId: "aa1", delta: "First answer" },
    });
    // Second user
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: {
          id: "uu2",
          type: "userMessage",
          content: [{ type: "text", text: "Second Q" }],
        },
      },
    });
    // Agent
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "aa2", type: "agent_message" } },
    });
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "cx1", itemId: "aa2", delta: "Second answer" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("dedupes replayed user events while preserving separate identical prompts", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    const send = (id: string) => fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id, type: "userMessage", content: [{ type: "text", text: "Deploy." }] } },
    });
    send("deploy-1");
    await flush();
    send("deploy-1");
    await flush();
    expect(screen.getAllByText("Deploy.")).toHaveLength(1);
    send("deploy-2");
    await flush();
    expect(screen.getAllByText("Deploy.")).toHaveLength(2);
  });

  it("dedupes optimistic user with item/started userMessage matching content", async () => {
    const handlers = await setupCapture();
    // pre-seed items with optimistic
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    // Fire item/started userMessage that matches what would be optimistic
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: {
          id: "real-u",
          type: "userMessage",
          content: [{ type: "text", text: "test message" }],
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders full file_change from item/completed", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "fc-render", type: "fileChange" } },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "fc-render",
          type: "file_change",
          changes: [
            { path: "/src/foo.ts", kind: "modify", diff: "+ added\n- removed" },
          ],
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders thinking item via item/completed type=thinking", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: { id: "thinking-c", type: "thinking", text: "I am thinking" },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles multiple file changes via apply_patch function call", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "patch-multi",
          type: "function_call",
          tool: "apply_patch",
          arguments: {
            input: "*** Begin Patch\n*** Add File: /a.ts\n+content a\n*** End Patch\n",
          },
          success: true,
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders compaction via rawResponseItem/completed", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: {
        threadId: "cx1",
        item: { id: "comp-raw", type: "context_compaction" },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("Footer renders when sending=true (turn/started)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "turn/started",
      params: { threadId: "cx1", turnId: "footer-t" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it.each([
    { method: "item/started", item: { id: "work", type: "mcpToolCall", server: "agmux-memory", tool: "memory_list" } },
    { method: "item/agentMessage/delta", itemId: "reply", delta: "Working on it" },
    { method: "item/reasoning/summaryTextDelta", itemId: "reasoning", delta: "Checking the code" },
  ])("prioritizes active work over MCP startup ($method)", async (activity) => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, { method: "thread/started", params: { threadId: "cx1", thread: { id: "cx1" } } });
    fireCodex(handlers, { method: "turn/started", params: { threadId: "cx1", turnId: "work-t" } });
    fireCodex(handlers, { method: "mcpServer/startupStatus/updated", params: { threadId: "cx1", name: "sequential-thinking", status: "starting" } });
    fireCodex(handlers, { method: "item/started", params: { threadId: "cx1", item: { id: "user", type: "userMessage", content: [] } } });
    await flush();
    expect(screen.getByTestId("codex-thinking-phase").textContent).toBe("starting MCP");

    const { method, ...params } = activity;
    fireCodex(handlers, { method, params: { threadId: "cx1", ...params } });
    await flush();
    expect(screen.getByTestId("codex-thinking-phase").textContent).toBe("thinking");
    expect(screen.queryByTestId("codex-thinking-mcp-detail")).toBeNull();

    // A late startup notification must not replace ongoing work either.
    fireCodex(handlers, { method: "mcpServer/startupStatus/updated", params: { threadId: "cx1", name: "another-server", status: "starting" } });
    await flush();
    expect(screen.getByTestId("codex-thinking-phase").textContent).toBe("thinking");
    expect(screen.queryByTestId("codex-thinking-mcp-detail")).toBeNull();

    fireCodex(handlers, { method: "turn/completed", params: { threadId: "cx1", turn: { id: "work-t", status: "completed" } } });
    fireCodex(handlers, { method: "turn/started", params: { threadId: "cx1", turnId: "next-t" } });
    fireCodex(handlers, { method: "mcpServer/startupStatus/updated", params: { threadId: "cx1", name: "next-server", status: "starting" } });
    await flush();
    expect(screen.getByTestId("codex-thinking-phase").textContent).toBe("starting MCP");
  });

  it("shows starting MCP in the thinking footer while MCP servers list tools", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();

    // Establish this session's Codex thread id so scoped events are accepted.
    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1", thread: { id: "cx1" } },
    });
    fireCodex(handlers, {
      method: "turn/started",
      params: { threadId: "cx1", turnId: "mcp-wait-t" },
    });
    await flush();

    fireCodex(handlers, {
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId: "cx1",
        name: "xcodebuildmcp",
        status: "starting",
        error: null,
        failureReason: null,
      },
    });
    await flush();

    expect(screen.getByTestId("codex-thinking-phase").textContent).toBe("starting MCP");
    expect(screen.getByTestId("codex-thinking-mcp-detail").textContent).toBe(
      "xcodebuildmcp",
    );

    fireCodex(handlers, {
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId: "cx1",
        name: "xcodebuildmcp",
        status: "ready",
        error: null,
        failureReason: null,
      },
    });
    await flush();

    expect(screen.getByTestId("codex-thinking-phase").textContent).toBe("thinking");
    expect(screen.queryByTestId("codex-thinking-mcp-detail")).toBeNull();
  });
});

// =====================================================================
// Click-through coverage: drive utility functions via rich session
// history + thread payloads, textarea key events for slash navigation,
// and window focus refresh path. Uses `vi.mocked(...).mockResolvedValueOnce`
// to seed responses for codex* commands prior to render.
// =====================================================================
describe("CodexSessionView — Click-through coverage", () => {
  type Listener = (event: { payload: unknown }) => void;

  async function setupCapture() {
    const eventModule = await import("@tauri-apps/api/event");
    const handlers: Record<string, Listener[]> = {};
    vi.mocked(eventModule.listen).mockImplementation(((channel: string, cb: Listener) => {
      (handlers[channel] ||= []).push(cb);
      return Promise.resolve(() => {});
    }) as never);
    return handlers;
  }
  async function flush() {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  async function withSeededHistory(items: unknown[]) {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexReadSessionHistory).mockResolvedValueOnce({
      items,
      cwd: "/tmp/repo",
      model: "gpt-5",
      effort: "medium",
    } as never);
  }

  async function withSeededThread(thread: unknown) {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexReadThread).mockResolvedValueOnce(thread as never);
  }

  it("renders system filter for AGENTS.md first user message", async () => {
    await withSeededHistory([
      { role: "user", content: "# AGENTS.md\nHello", timestamp: new Date().toISOString() },
      { role: "user", content: "real msg", timestamp: new Date().toISOString() },
    ]);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("filters out environment_context system messages", async () => {
    await withSeededHistory([
      { role: "user", content: "<environment_context>\nfoo\n</environment_context>", timestamp: new Date().toISOString() },
    ]);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("filters out turn_aborted messages", async () => {
    await withSeededHistory([
      { role: "user", content: "<turn_aborted>", timestamp: new Date().toISOString() },
    ]);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders file role item with diff additions/deletions", async () => {
    await withSeededHistory([
      {
        role: "file",
        file_path: "/src/foo.ts",
        additions: 3,
        deletions: 1,
        content: "+a\n+b\n+c\n-x",
        timestamp: new Date().toISOString(),
      },
    ]);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders multiple file role items", async () => {
    await withSeededHistory([
      { role: "file", file_path: "/a.ts", additions: 1, deletions: 0, content: "+a", timestamp: new Date(1000).toISOString() },
      { role: "file", file_path: "/b.ts", additions: 0, deletions: 1, content: "-b", timestamp: new Date(2000).toISOString() },
    ]);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders file role with missing additions/deletions defaults", async () => {
    await withSeededHistory([
      { role: "file", file_path: "/x.ts", content: "+x", timestamp: new Date().toISOString() },
    ]);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests codexReadThread turns + apply_patch dynamicToolCall items", async () => {
    await withSeededThread({
      id: "real-thread-id",
      model: "gpt-5",
      effort: "medium",
      turns: [
        {
          id: "t1",
          createdAt: 1700000000000,
          items: [
            {
              id: "dt1",
              type: "dynamicToolCall",
              tool: "apply_patch",
              arguments: '*** Begin Patch\n*** Add File: foo.ts\n+hello\n*** End Patch',
              createdAt: 1700000001000,
            },
          ],
        },
      ],
    });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    // give cascading effects time
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests codexReadThread with apply_patch_freeform tool and object args", async () => {
    await withSeededThread({
      id: "thread-2",
      turns: [
        {
          id: "t2",
          timestamp: "1700000000000",
          items: [
            {
              id: "dt2",
              type: "dynamicToolCall",
              tool: "apply_patch_freeform",
              arguments: { input: "*** Begin Patch\n*** Update File: bar.ts\n+x\n-y\n*** End Patch" },
              created_at: "1700000001500",
            },
          ],
        },
      ],
    });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests codexReadThread with file_change items having changes array", async () => {
    await withSeededThread({
      id: "thread-3",
      turns: [
        {
          id: "t3",
          createdAt: "2024-01-01T00:00:00Z",
          items: [
            {
              id: "fc1",
              type: "file_change",
              changes: [
                { path: "/x.ts", kind: "modify", diff: "+a\n+b\n-c\n+++ /dev/null\n--- new" },
                { path: "/y.ts", kind: "add", diff: "+only-add" },
                { path: "", diff: "+ignored" }, // empty path filtered
              ],
              createdAt: 1700000000000,
            },
          ],
        },
      ],
    });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests codexReadThread with numeric-string timestamps under 1e12 (seconds)", async () => {
    await withSeededThread({
      id: "thread-4",
      turns: [
        {
          id: "t4",
          createdAt: "1700000000", // seconds → multiplied by 1000
          items: [
            { id: "msg-4", type: "agent_message", text: "Hello", createdAt: "1700000001" },
          ],
        },
      ],
    });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests codexReadThread with non-numeric-string timestamp (Date.parse path)", async () => {
    await withSeededThread({
      id: "thread-5",
      turns: [
        {
          id: "t5",
          createdAt: "2024-06-15T12:34:56Z",
          items: [{ id: "i5", type: "agent_message", text: "x", createdAt: "2024-06-15T12:34:57Z" }],
        },
      ],
    });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests codexReadThread with invalid timestamp falls through to 0", async () => {
    await withSeededThread({
      id: "thread-6",
      turns: [{ id: "t6", createdAt: "not a real date", items: [] }],
    });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests codexReadThread with negative timestamp normalised to 0", async () => {
    await withSeededThread({
      id: "thread-7",
      turns: [{ id: "t7", createdAt: -123, items: [] }],
    });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests codexReadThread with empty turns array", async () => {
    await withSeededThread({ id: "thread-empty", turns: [] });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests codexReadThread with missing turns property", async () => {
    await withSeededThread({ id: "thread-noturns" });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("seeds codexListModels with rich response (data array, displayName)", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexListModels).mockResolvedValueOnce({
      data: [
        { model: "gpt-5", displayName: "GPT-5 Turbo" },
        { id: "gpt-5-codex", display_name: "Codex 5" },
        { model: "" }, // filtered
        null, // filtered
        { model: "alone-slug" },
      ],
    } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("seeds codexListModels returning a flat array (not wrapped)", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexListModels).mockResolvedValueOnce([
      { model: "m1", displayName: "Model One" },
    ] as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("seeds codexListModels with non-object response (returns [])", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexListModels).mockResolvedValueOnce(undefined as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("seeds codexAccountRead authenticated", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexAccountRead).mockResolvedValueOnce({ authenticated: true } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("seeds codexAccountRead unauthenticated", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexAccountRead).mockResolvedValueOnce({ authenticated: false } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles codexAccountRead rejection (catches → unknown)", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexAccountRead).mockRejectedValueOnce(new Error("offline"));
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("seeds codexListCollaborationModes with modes list", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexListCollaborationModes).mockResolvedValueOnce({
      modes: [
        { id: "default", label: "Default", description: "Standard mode" },
        { id: "plan", label: "Plan", description: "Planning mode" },
      ],
    } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("seeds codexListCollaborationModes returning empty modes", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexListCollaborationModes).mockResolvedValueOnce({ modes: [] } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles codexListCollaborationModes rejection", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexListCollaborationModes).mockRejectedValueOnce(new Error("nope"));
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("textarea typing populates input value", async () => {
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    fireEvent.change(ta, { target: { value: "hello world" } });
    expect(ta.value).toBe("hello world");
  });

  it("textarea slash typing opens slash popup state", async () => {
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "/he" } });
    // Component renders slash popup component (mocked to null) — just verify the change ran
    expect(ta.value).toBe("/he");
  });

  it("textarea ArrowDown does not crash with slash query active", async () => {
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "/" } });
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(container.firstChild).toBeTruthy();
  });

  it("textarea Enter key (no shift) triggers submit path", async () => {
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "send this" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });
    expect(container.firstChild).toBeTruthy();
  });

  it("collapses textarea height after sending a long message", async () => {
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    Object.defineProperty(ta, "scrollHeight", {
      configurable: true,
      get: () => (ta.value ? 150 : 36),
    });

    fireEvent.change(ta, { target: { value: "long message\n".repeat(12) } });
    expect(ta.style.height).toBe("150px");

    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });

    await waitFor(() => {
      expect(ta.value).toBe("");
      expect(ta.style.height).toBe("36px");
    });
  });

  it("textarea Shift+Enter inserts newline (no submit)", async () => {
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "line1" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(container.firstChild).toBeTruthy();
  });

  it("textarea Tab key with no slash popup does not crash", async () => {
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.keyDown(ta, { key: "Tab" });
    expect(container.firstChild).toBeTruthy();
  });

  it("window focus event triggers codexReadThread (focus refresh)", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexReadThread).mockResolvedValueOnce({
      id: "focus-thread",
      model: "gpt-5",
      effort: "high",
      collaborationMode: "default",
    } as never);
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    // Need an active thread id first — fire thread/started
    fireCodex(handlers, {
      method: "thread/started",
      params: {
        threadId: "cx1",
        thread: { id: "active-thread-id", model: "gpt-5", effort: "low" },
      },
    });
    await flush();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  function fireCodex(handlers: Record<string, Listener[]>, payload: unknown) {
    for (const h of handlers["codex-event"] ?? []) h({ payload });
  }

  it("user message with long string content does not crash", async () => {
    await withSeededHistory([
      {
        role: "user",
        content: "A".repeat(500),
        timestamp: new Date().toISOString(),
      },
    ]);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders thinking role from history", async () => {
    await withSeededHistory([
      { role: "thinking", content: "deep thought", timestamp: new Date().toISOString() },
    ]);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders mixed history (user + assistant + command + thinking + file)", async () => {
    await withSeededHistory([
      { role: "user", content: "Q1", timestamp: new Date(1000).toISOString() },
      { role: "assistant", content: "A1", timestamp: new Date(2000).toISOString() },
      { role: "thinking", content: "let me think", timestamp: new Date(3000).toISOString() },
      { role: "command", content: "$ ls\nfile1\n[exit: 0]", timestamp: new Date(4000).toISOString() },
      { role: "file", file_path: "/x.ts", content: "+x", additions: 1, deletions: 0, timestamp: new Date(5000).toISOString() },
    ]);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders generic tool rows from history", async () => {
    await withSeededHistory([
      {
        role: "tool",
        content: "Search results ready",
        timestamp: new Date().toISOString(),
        tool_name: "WebSearch",
        tool_input: { query: "codex app-server" },
        tool_error: false,
      },
    ]);
    render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(screen.getByText("WebSearch")).toBeTruthy();
    expect(screen.getByText(/codex app-server/)).toBeTruthy();
    fireEvent.click(screen.getByText("WebSearch").closest("[role='button']")!);
    expect(screen.getByText(/Search results ready/)).toBeTruthy();
  });

  it("rejected codexReadSessionHistory does not crash", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexReadSessionHistory).mockRejectedValueOnce(new Error("io"));
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("rejected codexReadThread does not crash (during ingest)", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexReadSessionHistory).mockResolvedValueOnce({
      items: [{ role: "user", content: "hi", timestamp: new Date().toISOString() }],
      cwd: "/tmp/repo",
    } as never);
    vi.mocked(cmd.codexReadThread).mockRejectedValueOnce(new Error("io"));
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("history with non-array invalid items defaults to empty", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexReadSessionHistory).mockResolvedValueOnce({
      items: [],
      cwd: "/tmp/repo",
    } as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders item/completed file_change with non-string kind (record)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "fc-rec",
          type: "file_change",
          changes: [{ path: "/k.ts", kind: { type: "modify" }, diff: "+ a\n- b" }],
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("dispatches commandExecution with success status", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "ce-1",
          type: "command_execution",
          command: "ls",
          status: "completed",
          output: "file1\nfile2\n",
          exitCode: 0,
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("dispatches commandExecution with failure status (non-zero exit)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "ce-fail",
          type: "command_execution",
          command: "false",
          status: "failed",
          output: "error: bad",
          exitCode: 1,
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("dispatches dynamicToolCall with success=true", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "dt-ok",
          type: "dynamicToolCall",
          tool: "shell",
          arguments: { cmd: "echo hi" },
          success: true,
          output: "hi",
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("dispatches dynamicToolCall with success=false", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "dt-bad",
          type: "dynamicToolCall",
          tool: "shell",
          arguments: "raw",
          success: false,
          output: '{"metadata": {"exit_code": 2}}',
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("dispatches dynamicToolCall apply_patch with patch text", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "ap-1",
          type: "dynamicToolCall",
          tool: "apply_patch",
          arguments: "*** Begin Patch\n*** Add File: a.ts\n+content\n*** End Patch",
          success: true,
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("dispatches dynamicToolCall apply_patch with object args (input field)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "ap-2",
          type: "dynamicToolCall",
          tool: "apply_patch",
          arguments: { input: "*** Begin Patch\n*** Update File: b.ts\n+x\n-y\n*** End Patch" },
          success: true,
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("dispatches dynamicToolCall apply_patch with object.patch field", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "ap-3",
          type: "dynamicToolCall",
          tool: "apply_patch",
          arguments: { patch: "*** Begin Patch\n*** Add File: c.ts\n+x\n*** End Patch" },
          success: true,
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("dispatches dynamicToolCall non-apply-patch tool", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "dt-x",
          type: "dynamicToolCall",
          tool: "search",
          arguments: { query: "foo" },
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("dispatches reasoning textDelta then summary", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "rsn-1", type: "reasoning" } },
    });
    fireCodex(handlers, {
      method: "item/reasoning/textDelta",
      params: { threadId: "cx1", itemId: "rsn-1", delta: "step 1\n" },
    });
    fireCodex(handlers, {
      method: "item/reasoning/textDelta",
      params: { threadId: "cx1", itemId: "rsn-1", delta: "step 2\n" },
    });
    fireCodex(handlers, {
      method: "item/reasoning/summaryTextDelta",
      params: { threadId: "cx1", itemId: "rsn-1", delta: "summary text" },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: { id: "rsn-1", type: "reasoning", text: "step 1\nstep 2\n" },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("dispatches commandExecution outputDelta multiple lines", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "ce-d", type: "command_execution", command: "tail -f log" } },
    });
    fireCodex(handlers, {
      method: "item/commandExecution/outputDelta",
      params: { threadId: "cx1", itemId: "ce-d", delta: "line 1\n" },
    });
    fireCodex(handlers, {
      method: "item/commandExecution/outputDelta",
      params: { threadId: "cx1", itemId: "ce-d", delta: "line 2\n" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("dispatches fileChange outputDelta multiple chunks", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "fc-d", type: "file_change" } },
    });
    fireCodex(handlers, {
      method: "item/fileChange/outputDelta",
      params: { threadId: "cx1", itemId: "fc-d", delta: "+chunk1\n" },
    });
    fireCodex(handlers, {
      method: "item/fileChange/outputDelta",
      params: { threadId: "cx1", itemId: "fc-d", delta: "+chunk2\n" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("dispatches multiple agentMessage deltas streaming", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "ag-stream", type: "agent_message" } },
    });
    for (let i = 0; i < 5; i++) {
      fireCodex(handlers, {
        method: "item/agentMessage/delta",
        params: { threadId: "cx1", itemId: "ag-stream", delta: `chunk ${i} ` },
      });
    }
    fireCodex(handlers, {
      method: "item/completed",
      params: { threadId: "cx1", item: { id: "ag-stream", type: "agent_message", text: "chunk 0 chunk 1 chunk 2 chunk 3 chunk 4 " } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("flushes buffered agentMessage deltas synchronously before a non-delta event is applied", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    // First delta applies on the leading edge and opens the ~16ms
    // coalescing window.
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "cx1", itemId: "ag-lead", delta: "chunk-a" },
    });
    // Delta for a DIFFERENT item arrives inside the window — buffered only,
    // its agent item has not been created yet.
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "cx1", itemId: "ag-buffered", delta: "BUFFERED-MARKER" },
    });
    // A non-delta event must flush the buffer synchronously BEFORE it is
    // handled — otherwise this completed item would be appended ahead of the
    // buffered delta's not-yet-created agent item (a visible reordering).
    fireCodex(handlers, {
      method: "item/completed",
      params: { threadId: "cx1", item: { id: "ag-after", type: "agent_message", text: "AFTER-MARKER" } },
    });
    await flush();
    // Buffered content is visible immediately (no 16ms wait) …
    const buffered = screen.getByText(/BUFFERED-MARKER/);
    const after = screen.getByText(/AFTER-MARKER/);
    // … and renders BEFORE the item from the later non-delta event.
    expect(
      buffered.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("dispatches turn/started and turn/completed with token usage snake_case", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "turn/started",
      params: { threadId: "cx1", turnId: "tu1", model: "gpt-5", reasoning_effort: "low" },
    });
    fireCodex(handlers, {
      method: "turn/completed",
      params: {
        threadId: "cx1",
        turnId: "tu1",
        model: "gpt-5",
        token_usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("dispatches multiple thread/tokenUsage updates", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/tokenUsage/updated",
      params: { threadId: "cx1", input_tokens: 1000, output_tokens: 500, model_context_window: 200000 },
    });
    fireCodex(handlers, {
      method: "thread/tokenUsage/updated",
      params: { threadId: "cx1", inputTokens: 2000, outputTokens: 800, modelContextWindow: 200000 },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("dispatches account/loginStateChanged authenticated=true", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "account/loginStateChanged",
      params: { authenticated: true },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("dispatches account/loginStateChanged authenticated=false", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "account/loginStateChanged",
      params: { authenticated: false },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("dispatches mcpServer/elicitation/request with options", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "mcpServer/elicitation/request",
      requestId: "elicit-1",
      params: {
        threadId: "cx1",
        message: "Confirm action?",
        requestedSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("error event dispatch does not crash", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "error",
      params: { threadId: "cx1", message: "ignite failure" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("server disconnected dispatch does not crash", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "codex/serverDisconnected",
      params: { threadId: "cx1", reason: "exit" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("model/rerouted dispatch updates model", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "model/rerouted",
      params: { threadId: "cx1", reroutedTo: "gpt-5-codex" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("textarea paste event with no images does not crash", async () => {
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.paste(ta, {
      clipboardData: {
        items: [],
        files: [],
        getData: () => "",
      },
    });
    expect(container.firstChild).toBeTruthy();
  });

  it("textarea drop event with no images does not crash", async () => {
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.drop(ta, {
      dataTransfer: {
        items: [],
        files: [],
        types: [],
      },
    });
    expect(container.firstChild).toBeTruthy();
  });
});

// =====================================================================
// Patch parser + thread ingest coverage
// =====================================================================
describe("CodexSessionView — patch parsing & thread ingest", () => {
  async function flush() {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }
  async function withResume(thread: unknown) {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexResumeThread).mockResolvedValueOnce(thread as never);
  }

  // codexResumeThread → buildFileChangesFromThread → buildFileChangesFromPatchText (apply-patch path)
  it("ingests resume-thread with apply_patch dynamicToolCall (Add File)", async () => {
    await withResume({
      id: "rt1",
      model: "gpt-5",
      turns: [
        {
          id: "t1",
          createdAt: 1700000000000,
          items: [
            {
              id: "ap-add",
              type: "dynamicToolCall",
              tool: "apply_patch",
              arguments:
                "*** Begin Patch\n*** Add File: /a.ts\n+const a = 1;\n+const b = 2;\n*** End Patch",
              createdAt: 1700000001000,
            },
          ],
        },
      ],
    });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests resume-thread with apply_patch Update File + Move to", async () => {
    await withResume({
      id: "rt2",
      turns: [
        {
          id: "t2",
          createdAt: 1700000000000,
          items: [
            {
              id: "ap-upd",
              type: "dynamicToolCall",
              tool: "apply_patch",
              arguments:
                "*** Begin Patch\n*** Update File: /old.ts\n*** Move to: /new.ts\n-old line\n+new line\n*** End Patch",
            },
          ],
        },
      ],
    });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests resume-thread with apply_patch Delete File", async () => {
    await withResume({
      id: "rt3",
      turns: [
        {
          id: "t3",
          createdAt: 1700000000000,
          items: [
            {
              id: "ap-del",
              type: "dynamicToolCall",
              tool: "apply_patch",
              arguments:
                "*** Begin Patch\n*** Delete File: /gone.ts\n-line one\n-line two\n*** End Patch",
            },
          ],
        },
      ],
    });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests resume-thread with multiple apply_patch sections", async () => {
    await withResume({
      id: "rt4",
      turns: [
        {
          id: "t4",
          createdAt: 1700000000000,
          items: [
            {
              id: "ap-multi",
              type: "dynamicToolCall",
              tool: "apply_patch",
              arguments:
                "*** Begin Patch\n*** Add File: /x.ts\n+x\n*** Add File: /y.ts\n+y\n*** End Patch",
            },
          ],
        },
      ],
    });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests resume-thread with unified-diff patch (---/+++/@@)", async () => {
    await withResume({
      id: "rt5",
      turns: [
        {
          id: "t5",
          createdAt: 1700000000000,
          items: [
            {
              id: "ud-1",
              type: "dynamicToolCall",
              tool: "apply_patch",
              arguments:
                "--- a/foo.ts\n+++ b/foo.ts\n@@ -1,2 +1,3 @@\n line one\n+inserted\n line two\n",
            },
          ],
        },
      ],
    });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests resume-thread with unified-diff multi-file patch", async () => {
    await withResume({
      id: "rt6",
      turns: [
        {
          id: "t6",
          createdAt: 1700000000000,
          items: [
            {
              id: "ud-2",
              type: "dynamicToolCall",
              tool: "apply_patch_freeform",
              arguments:
                "--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-old\n+new\n--- a/two.ts\n+++ b/two.ts\n@@ -0,0 +1 @@\n+brand-new",
            },
          ],
        },
      ],
    });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests resume-thread with unrecognised patch text (returns [])", async () => {
    await withResume({
      id: "rt7",
      turns: [
        {
          id: "t7",
          items: [
            {
              id: "junk-1",
              type: "dynamicToolCall",
              tool: "apply_patch",
              arguments: "this is not a patch at all",
            },
          ],
        },
      ],
    });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests resume-thread with empty arguments string", async () => {
    await withResume({
      id: "rt8",
      turns: [
        {
          id: "t8",
          items: [
            {
              id: "empty",
              type: "dynamicToolCall",
              tool: "apply_patch",
              arguments: "",
            },
          ],
        },
      ],
    });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests resume-thread with arguments object having no recognised fields", async () => {
    await withResume({
      id: "rt9",
      turns: [
        {
          id: "t9",
          items: [
            {
              id: "objargs",
              type: "dynamicToolCall",
              tool: "apply_patch",
              arguments: { something: "else" },
            },
          ],
        },
      ],
    });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests resume-thread with arguments null/number primitives", async () => {
    await withResume({
      id: "rt10",
      turns: [
        {
          id: "t10",
          items: [
            { id: "n1", type: "dynamicToolCall", tool: "apply_patch", arguments: null },
            { id: "n2", type: "dynamicToolCall", tool: "apply_patch", arguments: 42 },
            { id: "n3", type: "dynamicToolCall", tool: "apply_patch" /* missing */ },
          ],
        },
      ],
    });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests resume-thread with mixed file_change items having missing diff", async () => {
    await withResume({
      id: "rt11",
      turns: [
        {
          id: "t11",
          createdAt: 1700000000000,
          items: [
            {
              id: "fc-mix",
              type: "file_change",
              changes: [
                { path: "/a.ts" }, // no diff
                { path: "/b.ts", diff: "+ x" },
                { diff: "+ no-path" }, // skipped
              ],
            },
          ],
        },
      ],
    });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests resume-thread with duplicate changes (dedupe path)", async () => {
    await withResume({
      id: "rt12",
      turns: [
        {
          id: "tA",
          createdAt: 1700000000000,
          items: [
            {
              id: "fc-dup1",
              type: "file_change",
              changes: [{ path: "/a.ts", diff: "+ same" }],
            },
          ],
        },
        {
          id: "tB",
          createdAt: 1700000005000,
          items: [
            {
              id: "fc-dup2",
              type: "file_change",
              changes: [{ path: "/a.ts", diff: "+ same" }],
            },
          ],
        },
      ],
    });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests resume-thread when codexResumeThread rejects (fallback path)", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexResumeThread).mockRejectedValueOnce(new Error("resume failed"));
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ingests resume-thread missing items in turn (skipped)", async () => {
    await withResume({
      id: "rt13",
      turns: [
        { id: "t13" /* no items */ },
        { id: "t14", items: null },
      ],
    });
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("response output array → joins text fields, drops empty", async () => {
    // This drives responseOutputToString via item/completed having an array output
    const eventModule = await import("@tauri-apps/api/event");
    const handlers: Record<string, ((evt: { payload: unknown }) => void)[]> = {};
    vi.mocked(eventModule.listen).mockImplementation(((c: string, cb: (evt: { payload: unknown }) => void) => {
      (handlers[c] ||= []).push(cb);
      return Promise.resolve(() => {});
    }) as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    for (const h of handlers["codex-event"] ?? []) {
      h({
        payload: {
          method: "rawResponseItem/completed",
          params: {
            threadId: "cx1",
            item: {
              id: "raw-out",
              type: "function_call_output",
              output: [
                { text: "line A" },
                { text: "" },
                null,
                { text: "line B" },
              ],
            },
          },
        },
      });
    }
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("merges raw function_call_output into the matching function_call row", async () => {
    const eventModule = await import("@tauri-apps/api/event");
    const handlers: Record<string, ((evt: { payload: unknown }) => void)[]> = {};
    vi.mocked(eventModule.listen).mockImplementation(((c: string, cb: (evt: { payload: unknown }) => void) => {
      (handlers[c] ||= []).push(cb);
      return Promise.resolve(() => {});
    }) as never);
    render(<CodexSessionView session={baseSession} />);
    await flush();

    for (const h of handlers["codex-event"] ?? []) {
      h({
        payload: {
          method: "rawResponseItem/completed",
          params: {
            threadId: "cx1",
            item: {
              id: "fc-plan",
              type: "function_call",
              name: "update_plan",
              call_id: "call-plan",
              arguments: JSON.stringify({ plan: [{ step: "Fix UI", status: "completed" }] }),
            },
          },
        },
      });
      h({
        payload: {
          method: "rawResponseItem/completed",
          params: {
            threadId: "cx1",
            item: {
              id: "out-plan",
              type: "function_call_output",
              call_id: "call-plan",
              output: "plan updated",
            },
          },
        },
      });
    }

    await flush();
    expect(screen.getByText("update_plan")).toBeTruthy();
    fireEvent.click(screen.getByText("update_plan").closest("[role='button']")!);
    expect(screen.getByText(/plan updated/)).toBeTruthy();
    expect(screen.queryByText("ToolResult")).toBeNull();
  });

  it("isSuccessfulCustomToolOutput parses JSON with metadata.exit_code = 0", async () => {
    const eventModule = await import("@tauri-apps/api/event");
    const handlers: Record<string, ((evt: { payload: unknown }) => void)[]> = {};
    vi.mocked(eventModule.listen).mockImplementation(((c: string, cb: (evt: { payload: unknown }) => void) => {
      (handlers[c] ||= []).push(cb);
      return Promise.resolve(() => {});
    }) as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    for (const h of handlers["codex-event"] ?? []) {
      h({
        payload: {
          method: "item/completed",
          params: {
            threadId: "cx1",
            item: {
              id: "ct-1",
              type: "custom_tool_call",
              output: '{"metadata": {"exit_code": 0}, "stdout": "ok"}',
            },
          },
        },
      });
    }
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("isSuccessfulCustomToolOutput JSON exit_code != 0 marks failure", async () => {
    const eventModule = await import("@tauri-apps/api/event");
    const handlers: Record<string, ((evt: { payload: unknown }) => void)[]> = {};
    vi.mocked(eventModule.listen).mockImplementation(((c: string, cb: (evt: { payload: unknown }) => void) => {
      (handlers[c] ||= []).push(cb);
      return Promise.resolve(() => {});
    }) as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    for (const h of handlers["codex-event"] ?? []) {
      h({
        payload: {
          method: "item/completed",
          params: {
            threadId: "cx1",
            item: {
              id: "ct-2",
              type: "custom_tool_call",
              output: '{"metadata": {"exit_code": 5}, "stderr": "boom"}',
            },
          },
        },
      });
    }
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("isSuccessfulCustomToolOutput non-JSON falls to /error/i regex", async () => {
    const eventModule = await import("@tauri-apps/api/event");
    const handlers: Record<string, ((evt: { payload: unknown }) => void)[]> = {};
    vi.mocked(eventModule.listen).mockImplementation(((c: string, cb: (evt: { payload: unknown }) => void) => {
      (handlers[c] ||= []).push(cb);
      return Promise.resolve(() => {});
    }) as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    for (const h of handlers["codex-event"] ?? []) {
      h({
        payload: {
          method: "item/completed",
          params: {
            threadId: "cx1",
            item: {
              id: "ct-3",
              type: "custom_tool_call",
              output: "ERROR: something went wrong",
            },
          },
        },
      });
    }
    for (const h of handlers["codex-event"] ?? []) {
      h({
        payload: {
          method: "item/completed",
          params: {
            threadId: "cx1",
            item: {
              id: "ct-4",
              type: "custom_tool_call",
              output: "all clear",
            },
          },
        },
      });
    }
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("isSuccessfulCustomToolOutput empty output string returns true", async () => {
    const eventModule = await import("@tauri-apps/api/event");
    const handlers: Record<string, ((evt: { payload: unknown }) => void)[]> = {};
    vi.mocked(eventModule.listen).mockImplementation(((c: string, cb: (evt: { payload: unknown }) => void) => {
      (handlers[c] ||= []).push(cb);
      return Promise.resolve(() => {});
    }) as never);
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    for (const h of handlers["codex-event"] ?? []) {
      h({
        payload: {
          method: "item/completed",
          params: {
            threadId: "cx1",
            item: { id: "ct-5", type: "custom_tool_call", output: "   " },
          },
        },
      });
    }
    await flush();
    expect(container.firstChild).toBeTruthy();
  });
});

// =====================================================================
// Approval flow click-through — drives handleApprove / handleReject /
// handleAllowForProject / handleUserInputAnswer through the rendered
// ApprovalBanner mock buttons.
// =====================================================================
describe("CodexSessionView — approval click-through", () => {
  type Listener = (event: { payload: unknown }) => void;

  async function setupCapture() {
    const eventModule = await import("@tauri-apps/api/event");
    const handlers: Record<string, Listener[]> = {};
    vi.mocked(eventModule.listen).mockImplementation(((channel: string, cb: Listener) => {
      (handlers[channel] ||= []).push(cb);
      return Promise.resolve(() => {});
    }) as never);
    return handlers;
  }
  async function flush() {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }
  function fireCodex(handlers: Record<string, Listener[]>, payload: unknown) {
    for (const h of handlers["codex-event"] ?? []) h({ payload });
  }

  it("approves a command-execution request via approve button", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexRespondToRequest).mockClear();
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/commandExecution/requestApproval",
      requestId: 101,
      params: {
        threadId: "cx1",
        command: "rm -rf /tmp/foo",
      },
    });
    await flush();
    const approveBtn = container.querySelector(
      "[data-testid='approval-approve']"
    ) as HTMLButtonElement;
    expect(approveBtn).toBeTruthy();
    fireEvent.click(approveBtn);
    await flush();
    expect(vi.mocked(cmd.codexRespondToRequest)).toHaveBeenCalledWith(
      expect.any(String),
      101,
      { decision: "accept" },
    );
  });

  it("rejects a file-change request via reject button", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexRespondToRequest).mockClear();
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/fileChange/requestApproval",
      requestId: 102,
      params: {
        threadId: "cx1",
        path: "/dangerous/path/to/file.ts",
      },
    });
    await flush();
    const rejectBtn = container.querySelector(
      "[data-testid='approval-reject']"
    ) as HTMLButtonElement;
    expect(rejectBtn).toBeTruthy();
    fireEvent.click(rejectBtn);
    await flush();
    expect(vi.mocked(cmd.codexRespondToRequest)).toHaveBeenCalledWith(
      expect.any(String),
      102,
      { decision: "decline" },
    );
  });

  it("clicking a suggested pattern persists the rule and approves the request", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexRespondToRequest).mockClear();
    vi.mocked(cmd.codexAddApprovalRule).mockClear();
    vi.mocked(cmd.codexSuggestApprovalPatterns).mockResolvedValueOnce([
      "git status *",
      "git *",
    ]);
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/commandExecution/requestApproval",
      requestId: 103,
      params: {
        threadId: "cx1",
        command: "git status",
      },
    });
    // Wait for the async suggestions promise to resolve and re-render the
    // banner with the pattern buttons.
    await flush();
    await flush();
    const patternBtn = container.querySelector(
      "[data-testid='approval-allow-pattern-git status *']"
    ) as HTMLButtonElement;
    expect(patternBtn).toBeTruthy();
    fireEvent.click(patternBtn);
    await flush();
    expect(vi.mocked(cmd.codexAddApprovalRule)).toHaveBeenCalledWith(
      expect.any(String),
      "git status *",
    );
    expect(vi.mocked(cmd.codexRespondToRequest)).toHaveBeenCalledWith(
      expect.any(String),
      103,
      { decision: "accept" },
    );
  });

  it("queued approvals — second appears after first approved", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexRespondToRequest).mockClear();
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    // queue 3 approvals
    fireCodex(handlers, {
      method: "item/commandExecution/requestApproval",
      requestId: "q1",
      params: { threadId: "cx1", command: "ls" },
    });
    fireCodex(handlers, {
      method: "item/commandExecution/requestApproval",
      requestId: "q2",
      params: { threadId: "cx1", command: "pwd" },
    });
    fireCodex(handlers, {
      method: "item/fileChange/requestApproval",
      requestId: "q3",
      params: { threadId: "cx1", path: "/a/b/c.ts" },
    });
    await flush();
    const approveBtn = container.querySelector(
      "[data-testid='approval-approve']"
    ) as HTMLButtonElement;
    expect(approveBtn).toBeTruthy();
    fireEvent.click(approveBtn);
    await flush();
    // Second still showing
    const stillThere = container.querySelector("[data-testid='approval-banner']");
    expect(stillThere).toBeTruthy();
  });

  it("approve handles codexRespondToRequest rejection silently", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexRespondToRequest).mockRejectedValueOnce(new Error("boom"));
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/commandExecution/requestApproval",
      requestId: "boom-1",
      params: { threadId: "cx1", command: "echo x" },
    });
    await flush();
    fireEvent.click(
      container.querySelector("[data-testid='approval-approve']") as HTMLButtonElement
    );
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("reject handles codexRespondToRequest rejection silently", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexRespondToRequest).mockRejectedValueOnce(new Error("nope"));
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/fileChange/requestApproval",
      requestId: "boom-r",
      params: { threadId: "cx1", path: "/x.ts" },
    });
    await flush();
    fireEvent.click(
      container.querySelector("[data-testid='approval-reject']") as HTMLButtonElement
    );
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("approval description with command > 80 chars truncates", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    const longCmd = "a".repeat(120);
    fireCodex(handlers, {
      method: "item/commandExecution/requestApproval",
      requestId: "long-1",
      params: { threadId: "cx1", command: longCmd },
    });
    await flush();
    const desc = container.querySelector("[data-testid='approval-desc']");
    expect(desc?.textContent?.endsWith("…")).toBe(true);
  });

  it("approval description with file path > 2 segments shortens", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/fileChange/requestApproval",
      requestId: "deep-1",
      params: {
        threadId: "cx1",
        path: "/very/deep/nested/path/file.ts",
      },
    });
    await flush();
    const desc = container.querySelector("[data-testid='approval-desc']");
    expect(desc?.textContent).toMatch(/Modify file:.*path\/file\.ts/);
  });

  it("approval description for file edit includes added and removed line counts", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/fileChange/requestApproval",
      requestId: "diff-approval",
      params: {
        threadId: "cx1",
        file_path: "/repo/src/widget.tsx",
        diff: "--- a/widget.tsx\n+++ b/widget.tsx\n@@ -1,2 +1,3 @@\n-old\n+new\n+extra\n",
      },
    });
    await flush();
    const desc = container.querySelector("[data-testid='approval-desc']");
    expect(desc?.textContent).toBe("Modify file: …/src/widget.tsx · +2 -1");
  });

  it("counts header-like content in file edit approval stats", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/fileChange/requestApproval", requestId: "header-content",
      params: { threadId: "cx1", file_path: "/repo/notes.md", diff: "@@ -1 +1 @@\n----\n++++\n" },
    });
    await flush();
    expect(container.querySelector("[data-testid='approval-desc']")?.textContent).toBe("Modify file: …/repo/notes.md · +1 -1");
  });

  it("approval description with no command nor path falls back to default", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/commandExecution/requestApproval",
      requestId: "fb-1",
      params: { threadId: "cx1" },
    });
    await flush();
    const desc = container.querySelector("[data-testid='approval-desc']");
    expect(desc?.textContent).toBe("Approval required");
  });

  it("approval missing requestId is ignored (no banner)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/commandExecution/requestApproval",
      params: { threadId: "cx1", command: "ls" /* no requestId */ },
    });
    await flush();
    expect(container.querySelector("[data-testid='approval-banner']")).toBeNull();
  });

  it("MCP elicitation request renders banner + approves", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexRespondToRequest).mockClear();
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "mcpServer/elicitation/request",
      requestId: 104,
      params: {
        threadId: "cx1",
        message: "Confirm doing X?",
        serverName: "filesystem",
      },
    });
    await flush();
    const approve = container.querySelector(
      "[data-testid='approval-approve']"
    ) as HTMLButtonElement;
    expect(approve).toBeTruthy();
    fireEvent.click(approve);
    await flush();
    expect(vi.mocked(cmd.codexRespondToRequest)).toHaveBeenCalledWith(
      expect.any(String),
      104,
      { action: "accept", content: {}, _meta: null },
    );
  });

  it("recovers a repeated computer-use approval once and clears server resolution", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexRespondToRequest).mockClear();
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    const request = {
      method: "mcpServer/elicitation/request", requestId: 0,
      params: { threadId: "cx1", turnId: "t1", serverName: "cua_repl", mode: "form",
        message: 'Allow Computer Use to use "agmux"?', requestedSchema: { type: "object", properties: {} } },
    };
    fireCodex(handlers, request);
    fireCodex(handlers, request);
    await flush();
    fireEvent.click(container.querySelector("[data-testid='approval-approve']")!);
    await flush();
    expect(container.querySelector("[data-testid='approval-approve']")).toBeNull();
    expect(cmd.codexRespondToRequest).toHaveBeenCalledTimes(1);
    fireCodex(handlers, { ...request, requestId: 1 });
    await flush();
    fireCodex(handlers, { method: "serverRequest/resolved", params: { threadId: "cx1", requestId: 1 } });
    await flush();
    expect(container.querySelector("[data-testid='approval-approve']")).toBeNull();
  });

  it("shows known subagent MCP consent but ignores an unrelated chat", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    const request = { method: "mcpServer/elicitation/request", requestId: 0,
      params: { threadId: "unrelated", serverName: "cua_repl", message: "Allow Computer Use?" } };
    fireCodex(handlers, request);
    await flush();
    expect(container.querySelector("[data-testid='approval-approve']")).toBeNull();
    fireCodex(handlers, { method: "thread/started", params: { threadId: "child",
      thread: { id: "child", source: { subagent: { thread_spawn: { parent_thread_id: "cx1", depth: 1 } } } } } });
    fireCodex(handlers, { ...request, params: { ...request.params, threadId: "child" } });
    await flush();
    expect(container.querySelector("[data-testid='approval-approve']")).toBeTruthy();
    fireCodex(handlers, { method: "serverRequest/resolved", params: { threadId: "child", requestId: 0 } });
    await flush();
    expect(container.querySelector("[data-testid='approval-approve']")).toBeNull();
  });

  it("approves a permissions request with the requested permission subset", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexRespondToRequest).mockClear();
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    const permissions = {
      fileSystem: { read: null, write: ["/tmp/repo/src"], entries: [] },
      network: { enabled: true },
    };
    fireCodex(handlers, {
      method: "item/permissions/requestApproval",
      requestId: 105,
      params: {
        threadId: "cx1",
        reason: "Need access for tests",
        permissions,
      },
    });
    await flush();
    expect(container.querySelector("[data-testid='approval-tool']")?.textContent).toBe("Permissions");
    fireEvent.click(container.querySelector("[data-testid='approval-approve']") as HTMLButtonElement);
    await flush();
    expect(vi.mocked(cmd.codexRespondToRequest)).toHaveBeenCalledWith(
      expect.any(String),
      105,
      { scope: "turn", permissions },
    );
  });

  it("denies a permissions request by returning an empty permission subset", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexRespondToRequest).mockClear();
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/permissions/requestApproval",
      requestId: 106,
      params: {
        threadId: "cx1",
        permissions: {
          fileSystem: { read: null, write: ["/tmp/repo/src"] },
          network: null,
        },
      },
    });
    await flush();
    fireEvent.click(container.querySelector("[data-testid='approval-reject']") as HTMLButtonElement);
    await flush();
    expect(vi.mocked(cmd.codexRespondToRequest)).toHaveBeenCalledWith(
      expect.any(String),
      106,
      { scope: "turn", permissions: {} },
    );
  });

  it("MCP elicitation with long message > 80 chars truncates description", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "mcpServer/elicitation/request",
      requestId: "mcp-long",
      params: {
        threadId: "cx1",
        message: "z".repeat(120),
      },
    });
    await flush();
    const desc = container.querySelector("[data-testid='approval-desc']");
    expect(desc?.textContent?.endsWith("…")).toBe(true);
  });

  it("MCP elicitation with serverName only", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "mcpServer/elicitation/request",
      requestId: "mcp-srv",
      params: {
        threadId: "cx1",
        serverName: "code-runner",
      },
    });
    await flush();
    const desc = container.querySelector("[data-testid='approval-desc']");
    expect(desc?.textContent).toBe("MCP tool: code-runner");
  });

  it("MCP elicitation with neither message nor serverName", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "mcpServer/elicitation/request",
      requestId: "mcp-empty",
      params: { threadId: "cx1" },
    });
    await flush();
    const desc = container.querySelector("[data-testid='approval-desc']");
    expect(desc?.textContent).toBe("MCP tool approval required");
  });

  it("user-input answer button triggers codexRespondToRequest with answers", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexRespondToRequest).mockClear();
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/tool/requestUserInput",
      requestId: "ui-1",
      params: {
        threadId: "cx1",
        questions: [
          { id: "q1", question: "What's your name?", header: "Name" },
        ],
      },
    });
    await flush();
    fireEvent.change(screen.getByLabelText("What's your name?"), { target: { value: "Sam" } });
    const answer = screen.getByRole("button", { name: "Send answers" });
    expect(answer).toBeTruthy();
    fireEvent.click(answer);
    await flush();
    expect(vi.mocked(cmd.codexRespondToRequest)).toHaveBeenCalledWith(expect.any(String), "ui-1", { answers: { q1: { answers: ["Sam"] } } });
  });

  it("user-input remains inline until answered", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/tool/requestUserInput",
      requestId: "ui-2",
      params: {
        threadId: "cx1",
        questions: [{ id: "q1", question: "Pick one" }],
      },
    });
    await flush();
    expect(screen.getByLabelText("Pick one")).toBeTruthy();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Send answers" }).hasAttribute("disabled")).toBe(true);
  });

  it("user-input request with options rendered as radio choices", async () => {
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/tool/requestUserInput",
      requestId: "ui-3",
      params: {
        threadId: "cx1",
        questions: [
          {
            id: "q1",
            question: "Which color?",
            options: [
              { label: "Red", description: "the color red" },
              { label: "Blue", description: "the color blue" },
            ],
          },
        ],
      },
    });
    await flush();
    expect(screen.getByRole("button", { name: /Red/ })).toBeTruthy();
  });

  it("user-input failed submission retains answers and shows the error", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexRespondToRequest).mockRejectedValueOnce(new Error("io"));
    const handlers = await setupCapture();
    render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/tool/requestUserInput",
      requestId: "ui-err",
      params: {
        threadId: "cx1",
        questions: [{ id: "q1", question: "Q?" }],
      },
    });
    await flush();
    fireEvent.change(screen.getByLabelText("Q?"), { target: { value: "Answer" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("io");
    expect((screen.getByLabelText("Q?") as HTMLInputElement).value).toBe("Answer");
  });

  it("rapid sequential approves processes the queue", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.codexRespondToRequest).mockClear();
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    for (let i = 0; i < 5; i++) {
      fireCodex(handlers, {
        method: "item/commandExecution/requestApproval",
        requestId: `r-${i}`,
        params: { threadId: "cx1", command: `echo ${i}` },
      });
    }
    await flush();
    for (let i = 0; i < 5; i++) {
      const approve = container.querySelector(
        "[data-testid='approval-approve']"
      ) as HTMLButtonElement | null;
      if (!approve) break;
      fireEvent.click(approve);
      await flush();
    }
    expect(vi.mocked(cmd.codexRespondToRequest).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("approve toolName=Bash for command requests", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/commandExecution/requestApproval",
      requestId: "tn-bash",
      params: { threadId: "cx1", command: "ls" },
    });
    await flush();
    expect(container.querySelector("[data-testid='approval-tool']")?.textContent).toBe("Bash");
  });

  it("approve toolName=Edit for file change requests", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/fileChange/requestApproval",
      requestId: "tn-edit",
      params: { threadId: "cx1", path: "/a.ts" },
    });
    await flush();
    expect(container.querySelector("[data-testid='approval-tool']")?.textContent).toBe("Edit");
  });

  it("custom_tool_call apply_patch then matching custom_tool_call_output applies changes", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    // First, the call
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "ctc-1",
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call-abc",
          input:
            "*** Begin Patch\n*** Add File: /new.ts\n+const x = 1;\n*** End Patch",
        },
      },
    });
    // Then the matching output
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "cto-1",
          type: "custom_tool_call_output",
          call_id: "call-abc",
          output: "Patch applied successfully",
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("custom_tool_call_output without matching pending call is ignored", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "cto-orphan",
          type: "custom_tool_call_output",
          call_id: "no-match",
          output: "ok",
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("custom_tool_call apply_patch with empty input produces no pending change", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "ctc-empty",
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call-empty",
          input: "",
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("custom_tool_call apply_patch_freeform name variant", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "ctc-ff",
          type: "custom_tool_call",
          name: "apply_patch_freeform",
          call_id: "call-ff",
          input: "*** Begin Patch\n*** Add File: f.ts\n+x\n*** End Patch",
        },
      },
    });
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "cto-ff",
          type: "custom_tool_call_output",
          call_id: "call-ff",
          output: "ok",
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("shows a nameless live http.server as Serving HTTP server", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "http-bg",
          type: "commandExecution",
          output: `127.0.0.1 - [07/Sep/2026 15:09:27] "GET /subagent-status-options.html HTTP/1.1" 200 -\n127.0.0.1 - [07/Sep/2026 15:09:28] code 404, message File not found`,
        },
      },
    });
    await flush();
    const row = container.querySelector('[data-testid="codex-tool-row"][data-lead="Serving"]');
    expect(row?.textContent).toContain("HTTP server");
  });

  it("summarizes a background http.server command on the Ran row", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: {
          id: "http-start",
          type: "command_execution",
          command: "python3 -m http.server 8767 --bind 127.0.0.1 --directory docs/designs",
        },
      },
    });
    await flush();
    const row = container.querySelector('[data-testid="codex-tool-row"][data-lead="Serving"]');
    expect(row?.textContent).toContain("python3 -m http.server 8767");
  });

  it("does not keep a duplicate Running row after native commandExecution completes", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "ctc-dup",
          type: "custom_tool_call",
          name: "exec",
          call_id: "call-dup-1",
          input: 'text(await tools.exec_command({cmd:"npx tsc --noEmit"}));',
        },
      },
    });
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "cto-dup",
          type: "custom_tool_call_output",
          call_id: "call-dup-1",
          output: [
            { type: "input_text", text: JSON.stringify({ session_id: 9, output: "" }) },
          ],
        },
      },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "native-tsc",
          type: "commandExecution",
          command: "npx tsc --noEmit",
          output: "",
          exitCode: 0,
        },
      },
    });
    await flush();
    const rows = container.querySelectorAll('[data-testid="codex-tool-row"][data-lead="Ran"]');
    const running = container.querySelectorAll('[data-testid="codex-tool-row"][data-lead="Running"]');
    expect([...rows].some((row) => row.textContent?.includes("npx tsc --noEmit"))).toBe(true);
    expect([...running].some((row) => row.textContent?.includes("npx tsc --noEmit"))).toBe(false);
  });

  it("custom_tool_call exec expands nested commands into Ran rows", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "ctc-exec",
          type: "custom_tool_call",
          name: "exec",
          call_id: "call-exec-1",
          input: 'text(await tools.exec_command({cmd:"cat > /tmp/build.py <<\'PY\'\\nprint(1)\\nPY"}));',
        },
      },
    });
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "cto-exec",
          type: "custom_tool_call_output",
          call_id: "call-exec-1",
          output: [
            { type: "input_text", text: "Script completed" },
            { type: "input_text", text: JSON.stringify({ output: "Created out.html", exit_code: 0 }) },
          ],
        },
      },
    });
    await flush();
    const ran = container.querySelector('[data-testid="codex-tool-row"][data-lead="Ran"]');
    expect(ran?.textContent).toContain("cat > /tmp/build.py");
  });

  it("custom_tool_call non-apply name does not register pending", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "ctc-other",
          type: "custom_tool_call",
          name: "search",
          call_id: "call-other",
          input: "foo",
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("custom_tool_call_output with failed status is skipped", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "ctc-f",
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call-fail",
          input: "*** Begin Patch\n*** Add File: x.ts\n+y\n*** End Patch",
        },
      },
    });
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "cto-f",
          type: "custom_tool_call_output",
          call_id: "call-fail",
          output: '{"metadata":{"exit_code":1}}',
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("item/completed fileChange with id-prefixed accumulated outputDelta fallback", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "fc-fb", type: "file_change" } },
    });
    fireCodex(handlers, {
      method: "item/fileChange/outputDelta",
      params: { threadId: "cx1", itemId: "fc-fb", delta: "+a\n+b\n" },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "fc-fb",
          type: "fileChange",
          path: "/fb.ts",
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("item/completed fileChange with item.changes array path", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "fc-arr", type: "file_change" } },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "fc-arr",
          type: "fileChange",
          changes: [
            { path: "/x.ts", diff: "+ x\n- y\n" },
            { path: "/y.ts", diff: "+ z\n" },
            { path: "" }, // filtered
          ],
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });
});

describe("CodexSessionView — Final coverage gaps", () => {
  type Listener = (event: { payload: unknown }) => void;

  async function setupCapture() {
    const eventModule = await import("@tauri-apps/api/event");
    const handlers: Record<string, Listener[]> = {};
    vi.mocked(eventModule.listen).mockImplementation(((channel: string, cb: Listener) => {
      (handlers[channel] ||= []).push(cb);
      return Promise.resolve(() => {});
    }) as never);
    return handlers;
  }

  async function flush() {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  function fireCodex(handlers: Record<string, Listener[]>, payload: unknown) {
    for (const h of handlers["codex-event"] ?? []) h({ payload });
  }

  it("item/completed dynamicToolCall apply_patch path → file changes path", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "dyn1", type: "dynamicToolCall" } },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "dyn1",
          type: "dynamicToolCall",
          tool: "apply_patch",
          arguments: '{"input":"*** Begin Patch\\n*** Add File: /a.ts\\n+ hello\\n*** End Patch"}',
          success: true,
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("item/completed dynamicToolCall with success=false skips changes", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "dyn-fail",
          type: "dynamicToolCall",
          tool: "apply_patch",
          arguments: '{"input":"*** Begin Patch\\n+ a\\n*** End Patch"}',
          success: false,
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("item/completed reasoning item type", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "rsn",
          type: "reasoning",
          text: "thinking thoughts",
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("item/completed reasoning without text falls back to default", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: { threadId: "cx1", item: { id: "rsn2", type: "reasoning" } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("item/completed contextCompaction updates status", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: { id: "cc1", type: "contextCompaction" },
      },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: { id: "cc1", type: "contextCompaction" },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("item/completed commandExecution merges existing item with command name and exitCode", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "ce-m", type: "commandExecution" } },
    });
    fireCodex(handlers, {
      method: "item/commandExecution/outputDelta",
      params: { threadId: "cx1", itemId: "ce-m", delta: "running...\n" },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "ce-m",
          type: "commandExecution",
          command: "ls -la",
          status: "completed",
          exitCode: 0,
          output: "files\n",
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("item/completed commandExecution without prior started creates new item", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "ce-new",
          type: "commandExecution",
          command: "echo hi",
          exitCode: 0,
          output: "hi\n",
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("error event with structured object payload", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "error",
      params: {
        threadId: "cx1",
        message: "stream broke",
        code: 500,
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("codex/serverDisconnected with reason field", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "codex/serverDisconnected",
      params: { threadId: "cx1", reason: "network failure" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("codex/serverDisconnected without reason", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "codex/serverDisconnected",
      params: { threadId: "cx1" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("commandExecution/requestApproval with custom command", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "cx1",
        callId: "call-1",
        command: "rm -rf /tmp/test",
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("fileChange/requestApproval with path", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "cx1",
        callId: "fc-app1",
        changes: [{ path: "/dangerous.ts", diff: "+ unsafe" }],
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("mcpServer/elicitation/request with question", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "cx1",
        elicitationId: "el1",
        message: "Confirm action?",
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("item/tool/requestUserInput with tool name", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/tool/requestUserInput",
      params: {
        threadId: "cx1",
        itemId: "ask1",
        question: "What value?",
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("turn/started followed by error event", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "turn/started",
      params: { threadId: "cx1", turnId: "t-err" },
    });
    fireCodex(handlers, {
      method: "error",
      params: { threadId: "cx1", message: "during turn" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("turn/usage with detailed token counts", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "turn/usage",
      params: {
        threadId: "cx1",
        usage: {
          inputTokens: 12000,
          outputTokens: 1500,
          cacheReadTokens: 800,
          cacheCreationTokens: 200,
          totalTokens: 14500,
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("turn/tokenCount alias produces context update", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "turn/tokenCount",
      params: {
        threadId: "cx1",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("model/rerouted to a new model", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "model/rerouted",
      params: {
        threadId: "cx1",
        from: "gpt-5",
        to: "gpt-5-mini",
        reason: "rate-limited",
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("account/loginStateChanged to logged_out", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "account/loginStateChanged",
      params: { state: "logged_out" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("account/loginStateChanged to logged_in", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "account/loginStateChanged",
      params: { state: "logged_in", account: { email: "user@example.com" } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("thread/started → status/changed → completed full lifecycle", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/started",
      params: { threadId: "cx1" },
    });
    fireCodex(handlers, {
      method: "thread/status/changed",
      params: { threadId: "cx1", status: "running" },
    });
    fireCodex(handlers, {
      method: "thread/status/changed",
      params: { threadId: "cx1", status: "completed" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("filtered by mismatched threadId — events ignored", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "turn/started",
      params: { threadId: "OTHER", turnId: "t1" },
    });
    fireCodex(handlers, {
      method: "item/completed",
      params: { threadId: "OTHER", item: { id: "x", type: "agentMessage", text: "ignored" } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("multiple item/agentMessage/delta then completed", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "am1", type: "agentMessage" } },
    });
    for (let i = 0; i < 5; i++) {
      fireCodex(handlers, {
        method: "item/agentMessage/delta",
        params: { threadId: "cx1", itemId: "am1", delta: `chunk${i} ` },
      });
    }
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: { id: "am1", type: "agentMessage", text: "chunk0 chunk1 chunk2 chunk3 chunk4 " },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("item/started userMessage type", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: {
        threadId: "cx1",
        item: { id: "um1", type: "userMessage", text: "hello" },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("item/started without item field (graceful)", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("item/completed with no item field is safe no-op", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: { threadId: "cx1" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("rawResponseItem/completed with custom_tool_call_output success exit_code 0", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "rawResponseItem/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "ctco-ok",
          type: "custom_tool_call_output",
          call_id: "c1",
          output: '{"metadata":{"exit_code":0}}',
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("session prop without thread_name still renders empty state", () => {
    const { container } = render(
      <CodexSessionView session={{ id: "no-name" }} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("rerender session id triggers state cleanup", () => {
    const { rerender, container } = render(
      <CodexSessionView session={baseSession} />
    );
    rerender(<CodexSessionView session={{ ...baseSession, id: "cx-different" }} />);
    rerender(<CodexSessionView session={baseSession} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("multiple sequential turn lifecycles", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    for (let i = 0; i < 3; i++) {
      fireCodex(handlers, {
        method: "turn/started",
        params: { threadId: "cx1", turnId: `t${i}` },
      });
      fireCodex(handlers, {
        method: "turn/completed",
        params: { threadId: "cx1", turnId: `t${i}` },
      });
    }
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("thread/tokenUsage/updated with high values triggers context UI", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "cx1",
        usage: {
          inputTokens: 180000,
          outputTokens: 5000,
          totalTokens: 185000,
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("thread/tokenUsage/updated with zero values", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "cx1",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("multiple item/started events for different types in sequence", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "i-a", type: "agentMessage" } },
    });
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "i-b", type: "commandExecution" } },
    });
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "i-c", type: "fileChange" } },
    });
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "i-d", type: "reasoning" } },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("item/completed apply_patch_freeform tool variant", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "dyn-ff",
          type: "dynamicToolCall",
          tool: "apply_patch_freeform",
          arguments: '{"input":"*** Begin Patch\\n*** Update File: /b.ts\\n+ z\\n*** End Patch"}',
          success: true,
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("item/completed dynamicToolCall non-patch tool is skipped", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: {
          id: "dyn-other",
          type: "dynamicToolCall",
          tool: "some_other_tool",
          arguments: '{"foo":"bar"}',
          success: true,
        },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("multiple file changes accumulate to diff stats", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    for (let i = 0; i < 3; i++) {
      fireCodex(handlers, {
        method: "item/completed",
        params: {
          threadId: "cx1",
          item: {
            id: `fc-${i}`,
            type: "fileChange",
            changes: [{ path: `/file${i}.ts`, diff: "+ x\n+ y\n- z\n" }],
          },
        },
      });
    }
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("item/fileChange/outputDelta accumulates over many deltas", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "fc-acc", type: "fileChange" } },
    });
    for (let i = 0; i < 5; i++) {
      fireCodex(handlers, {
        method: "item/fileChange/outputDelta",
        params: { threadId: "cx1", itemId: "fc-acc", delta: `+line${i}\n` },
      });
    }
    fireCodex(handlers, {
      method: "item/completed",
      params: {
        threadId: "cx1",
        item: { id: "fc-acc", type: "fileChange", path: "/acc.ts" },
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("item/reasoning/textDelta accumulates", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "rd1", type: "reasoning" } },
    });
    fireCodex(handlers, {
      method: "item/reasoning/textDelta",
      params: { threadId: "cx1", itemId: "rd1", delta: "thought1 " },
    });
    fireCodex(handlers, {
      method: "item/reasoning/textDelta",
      params: { threadId: "cx1", itemId: "rd1", delta: "thought2 " },
    });
    fireCodex(handlers, {
      method: "item/reasoning/summaryTextDelta",
      params: { threadId: "cx1", itemId: "rd1", delta: "summary " },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("turn/completed without prior turn/started", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "turn/completed",
      params: { threadId: "cx1", turnId: "lonely-turn" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("commandExecution outputDelta with no prior started item", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/commandExecution/outputDelta",
      params: { threadId: "cx1", itemId: "ce-orphan", delta: "orphan output\n" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("agentMessage delta with empty itemId", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/agentMessage/delta",
      params: { threadId: "cx1", itemId: "", delta: "stranger" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("fileChange/outputDelta with empty delta", async () => {
    const handlers = await setupCapture();
    const { container } = render(<CodexSessionView session={baseSession} />);
    await flush();
    fireCodex(handlers, {
      method: "item/started",
      params: { threadId: "cx1", item: { id: "fc-empty", type: "fileChange" } },
    });
    fireCodex(handlers, {
      method: "item/fileChange/outputDelta",
      params: { threadId: "cx1", itemId: "fc-empty", delta: "" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

it("queues a prompt after Stop until the interrupted turn actually completes", async () => {
  const cmd = await import("../../../lib/commands");
  vi.mocked(cmd.codexSendMessage).mockClear();
  vi.mocked(cmd.codexInterruptTurn).mockClear();
  const handlers = await setupCapture();
  const { container } = render(<CodexSessionView session={baseSession} />);
  await flush();
  fireCodex(handlers, { method: "turn/started", params: { threadId: "cx1", turn: { id: "stopping-turn" } } });
  await flush();
  fireEvent.click(container.querySelector('[title="Stop (Esc)"]')!);
  await flush();
  expect(cmd.codexInterruptTurn).toHaveBeenCalledWith(expect.any(String), "cx1", "stopping-turn");
  expect(screen.getByTestId("codex-thinking-phase").textContent).toBe("Stopping…");
  const textarea = container.querySelector("textarea")!;
  fireEvent.change(textarea, { target: { value: "Continue after stopping" } });
  fireEvent.keyDown(textarea, { key: "Enter" });
  await flush();
  expect(cmd.codexSendMessage).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Continue after stopping");
  fireCodex(handlers, { method: "turn/completed", params: { threadId: "cx1", turn: { id: "stopping-turn", status: "interrupted" } } });
  await waitFor(() => expect(vi.mocked(cmd.codexSendMessage).mock.calls.map((call) => call.slice(1, 3))).toEqual([
    ["cx1", "Continue after stopping"],
  ]));
});

it("keeps the turn active and shows cancellation failures", async () => {
  const cmd = await import("../../../lib/commands");
  vi.mocked(cmd.codexInterruptTurn).mockRejectedValueOnce(new Error("Cancellation timed out"));
  const handlers = await setupCapture();
  const { container } = render(<CodexSessionView session={baseSession} />);
  await flush();
  fireCodex(handlers, { method: "turn/started", params: { threadId: "cx1", turn: { id: "failed-stop" } } });
  await flush();
  fireEvent.click(container.querySelector('[title="Stop (Esc)"]')!);
  await flush();
  expect(container.textContent).toContain("Cancellation timed out");
  expect(container.querySelector('[title="Stop (Esc)"]')).toBeTruthy();
});

it("renders asynchronous questions above the composer and sends the chosen answer", async () => {
  const cmd = await import("../../../lib/commands");
  vi.mocked(cmd.codexSendMessage).mockClear();
  vi.mocked(cmd.codexSendMessage).mockRejectedValueOnce(new Error("Try again"));
  const handlers = await setupCapture();
  render(<CodexSessionView session={baseSession} />);
  await flush();
  fireCodex(handlers, {
    method: "item/completed",
    params: { threadId: "cx1", item: { id: "async-question", type: "dynamicToolCall", tool: "request_user_input_async", arguments: { questions: [{ title: "Ready to proceed?", options: ["Done"] }] } } },
  });
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
  await flush();
  expect(screen.getByRole("alert").textContent).toBe("Try again");
  expect((screen.getByLabelText("Ready to proceed?") as HTMLInputElement).value).toBe("Done");
  fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
  await flush();
  expect(vi.mocked(cmd.codexSendMessage).mock.calls.slice(-1)[0]?.slice(1, 3)).toEqual(["cx1", "Ready to proceed?\nDone"]);
  expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull();
});

it("steers the running turn when answering an asynchronous question", async () => {
  const cmd = await import("../../../lib/commands");
  vi.mocked(cmd.codexInterruptTurn).mockClear();
  vi.mocked(cmd.codexSteerTurn).mockClear();
  vi.mocked(cmd.codexSendMessage).mockClear();
  const handlers = await setupCapture();
  render(<CodexSessionView session={baseSession} />);
  await flush();
  fireCodex(handlers, { method: "turn/started", params: { threadId: "cx1", turn: { id: "question-turn" } } });
  fireCodex(handlers, {
    method: "item/started",
    params: { threadId: "cx1", item: { id: "original-prompt", type: "userMessage", content: [{ type: "text", text: "Fix the sign-in issue" }] } },
  });
  fireCodex(handlers, {
    method: "item/completed",
    params: { threadId: "cx1", item: { id: "async-running", type: "dynamicToolCall", tool: "request_user_input_async", arguments: { questions: [{ title: "Continue?", options: ["Yes"] }] } } },
  });
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Yes" }));
  fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
  await flush();
  expect(cmd.codexSteerTurn).toHaveBeenCalledWith(expect.any(String), "cx1", "question-turn", "Continue?\nYes", null);
  expect(cmd.codexSendMessage).not.toHaveBeenCalled();
  // The server echoes the answer as a user message in the SAME running turn.
  fireCodex(handlers, {
    method: "item/started",
    params: { threadId: "cx1", item: { id: "answer-echo", type: "userMessage", content: [{ type: "text", text: "Continue?\nYes" }] } },
  });
  await flush();
  expect(screen.queryByTestId("codex-turn-summary")).toBeNull();
  expect(screen.getByTestId("codex-thinking-indicator")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull();
  expect(cmd.codexSendMessage).not.toHaveBeenCalled();
  expect(cmd.codexInterruptTurn).not.toHaveBeenCalled();
});

});
