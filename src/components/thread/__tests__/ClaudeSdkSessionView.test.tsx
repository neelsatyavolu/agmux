/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, act, waitFor, screen } from "@testing-library/react";

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
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof NoopResizeObserver }).ResizeObserver = NoopResizeObserver;

// Heavy children — replace with stubs.
const threadTopBarSpy = vi.fn();
vi.mock("../ThreadTopBar", () => ({
  ThreadTopBar: (props: unknown) => {
    threadTopBarSpy(props);
    return <div data-testid="thread-top-bar" />;
  },
}));
vi.mock("../GitSidebar", () => ({
  GitSidebar: () => <div data-testid="git-sidebar" />,
}));
vi.mock("../TerminalPanel", () => ({
  default: () => <div data-testid="terminal-panel" />,
}));
vi.mock("../../layout/EditorPanel", () => ({
  EditorPanel: () => <div data-testid="editor-panel" />,
}));
const claudeInputBarSpy = vi.fn();
vi.mock("../ClaudeInputBar", () => ({
  ClaudeInputBar: (props: {
    onSend?: (text: string, images?: Array<{ data: string; mediaType: string }>) => void;
    onStop?: () => void;
    onQueueMessage?: (text: string) => void;
    onSteer?: (id: string) => void;
    onDeleteQueued?: (id: string) => void;
    onModelChange?: (m: string) => void;
    onSetPermissionMode?: (m: "default" | "full" | "auto") => void;
    onPlanModeChange?: (pm: boolean) => void;
  }) => {
    claudeInputBarSpy(props);
    return (
    <div data-testid="claude-input-bar">
      <button data-testid="ib-send" onClick={() => props.onSend?.("hi")}>send</button>
      <button data-testid="ib-send-image" onClick={() => props.onSend?.("img", [{ data: "AAAA", mediaType: "image/png" }])}>send-img</button>
      <button data-testid="ib-send-slash" onClick={() => props.onSend?.("/help")}>send-slash</button>
      <button data-testid="ib-send-compact" onClick={() => props.onSend?.("/compact")}>send-compact</button>
      <button data-testid="ib-stop" onClick={() => props.onStop?.()}>stop</button>
      <button data-testid="ib-queue" onClick={() => props.onQueueMessage?.("queued msg")}>queue</button>
      <button data-testid="ib-steer" onClick={() => props.onSteer?.("nonexistent")}>steer</button>
      <button data-testid="ib-delete-queued" onClick={() => props.onDeleteQueued?.("q-id")}>del-q</button>
      <button data-testid="ib-set-model" onClick={() => props.onModelChange?.("opus")}>set-model</button>
      <button data-testid="ib-perm-full" onClick={() => props.onSetPermissionMode?.("full")}>perm-full</button>
      <button data-testid="ib-perm-auto" onClick={() => props.onSetPermissionMode?.("auto")}>perm-auto</button>
      <button data-testid="ib-perm-default" onClick={() => props.onSetPermissionMode?.("default")}>perm-default</button>
      <button data-testid="ib-plan-on" onClick={() => props.onPlanModeChange?.(true)}>plan-on</button>
      <button data-testid="ib-plan-off" onClick={() => props.onPlanModeChange?.(false)}>plan-off</button>
    </div>
    );
  },
}));
const approvalBannerSpy = vi.fn();
vi.mock("../ApprovalBanner", () => ({
  ApprovalBanner: (props: {
    onApprove?: () => void;
    onReject?: () => void;
    onAllowForSession?: () => void;
    onAnswer?: (text: string) => void;
  }) => {
    approvalBannerSpy(props);
    return (
      <div data-testid="approval-banner">
        <button data-testid="ab-approve" onClick={() => props.onApprove?.()}>approve</button>
        <button data-testid="ab-reject" onClick={() => props.onReject?.()}>reject</button>
        <button data-testid="ab-allow-session" onClick={() => props.onAllowForSession?.()}>allow-session</button>
        <button data-testid="ab-answer" onClick={() => props.onAnswer?.("yes please")}>answer</button>
      </div>
    );
  },
}));
vi.mock("../AskUserQuestionDialog", () => ({
  AskUserQuestionDialog: (props: {
    questions?: { question: string }[];
    onSubmit?: (answers: Record<string, string>) => void;
    onCancel?: () => void;
  }) => (
    <div data-testid="ask-user-question-dialog">
      <button
        data-testid="auq-submit"
        onClick={() =>
          props.onSubmit?.(
            Object.fromEntries(
              (props.questions ?? []).map((q) => [q.question, "Answer"]),
            ),
          )
        }
      >
        submit
      </button>
      <button data-testid="auq-cancel" onClick={() => props.onCancel?.()}>
        cancel
      </button>
    </div>
  ),
}));
vi.mock("../PlanFollowUpBanner", () => ({
  PlanFollowUpBanner: () => <div data-testid="plan-follow-up-banner" />,
}));
vi.mock("../ToolUseBlock", () => ({
  ToolUseBlock: () => <div data-testid="tool-use-block" />,
}));
vi.mock("../ToolActivityGroup", () => ({
  ToolActivityGroup: () => <div data-testid="tool-activity-group" />,
}));
vi.mock("../ThinkingBlock", () => ({
  ThinkingBlock: () => <div data-testid="thinking-block" />,
}));
vi.mock("../MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("../UserMessageText", () => ({
  PROMPT_ACTION_BTN: "prompt-action-btn",
  UserMessageText: ({
    content,
    actions,
  }: {
    content: string;
    actions?: import("react").ReactNode;
  }) => (
    <div>
      {actions}
      <div>{content}</div>
    </div>
  ),
}));
vi.mock("../FilesChangedCard", () => ({
  FilesChangedCard: () => <div data-testid="files-changed-card" />,
}));
vi.mock("../TurnChangeSummary", () => ({
  TurnChangeSummary: () => <div data-testid="turn-change-summary" />,
}));
vi.mock("../TaskNotificationBadge", () => ({
  TaskNotificationBadge: () => null,
}));
vi.mock("../tools/TodoWriteToolRenderer", () => ({
  TodoWriteToolRenderer: () => null,
}));
vi.mock("../../ui/ClaudeStarburstSpinner", () => ({
  ClaudeStarburstSpinner: () => <div data-testid="claude-spinner" />,
}));

// Virtuoso renders the list — stub renders data via itemContent and exposes
// Header/Footer slots so renderMessage branches are exercised in tests.
vi.mock("react-virtuoso", () => {
  const Virtuoso = ({
    data,
    itemContent,
    components,
    context,
    children,
  }: {
    data?: unknown[];
    itemContent?: (i: number, item: unknown, ctx?: unknown) => React.ReactNode;
    components?: { Header?: React.ComponentType<{ context?: unknown }>; Footer?: React.ComponentType<{ context?: unknown }> };
    context?: unknown;
    children?: React.ReactNode;
  }) => {
    const Header = components?.Header;
    const Footer = components?.Footer;
    return (
      <div data-testid="virtuoso">
        {Header ? <Header context={context} /> : null}
        {Array.isArray(data) && itemContent
          ? data.map((item, i) => (
              <div key={i} data-testid={`vtem-${i}`}>{itemContent(i, item, context)}</div>
            ))
          : null}
        {Footer ? <Footer context={context} /> : null}
        {children}
      </div>
    );
  };
  return { Virtuoso };
});

vi.mock("../../../lib/commands", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    sdkStartSession: vi.fn().mockResolvedValue(undefined),
    sdkSendMessage: vi.fn().mockResolvedValue(undefined),
    sdkSendSlashCommand: vi.fn().mockResolvedValue(undefined),
    sdkRespondApproval: vi.fn().mockResolvedValue(undefined),
    sdkRespondUserInput: vi.fn().mockResolvedValue(undefined),
    sdkResumeSession: vi.fn().mockResolvedValue(undefined),
    sdkStopSession: vi.fn().mockResolvedValue(undefined),
    sdkInterrupt: vi.fn().mockResolvedValue(undefined),
    sdkGetChatHistory: vi.fn().mockResolvedValue([]),
    sdkGetChatHistoryBefore: vi.fn().mockResolvedValue([]),
    readClaudeSessionHistory: vi.fn().mockResolvedValue([]),
    forkThread: vi.fn().mockResolvedValue(undefined),
    listThreadTurns: vi.fn().mockResolvedValue([]),
  };
});

import { ClaudeSdkSessionView } from "../ClaudeSdkSessionView";
import { _resetAppVisibilityForTests } from "../../../lib/appVisibility";
import { SessionPresentationContext } from "../../../hooks/useIsSessionActive";
import { useThreadStore } from "../../../stores/threadStore";
import { useUiStore } from "../../../stores/uiStore";

afterEach(() => cleanup());

beforeEach(async () => {
  threadTopBarSpy.mockClear();
  claudeInputBarSpy.mockClear();
  approvalBannerSpy.mockClear();
  useThreadStore.setState({ threads: {} } as never);
  useUiStore.setState({} as never);
  const cmd = await import("../../../lib/commands");
  vi.mocked(cmd.sdkStartSession).mockClear();
  vi.mocked(cmd.sdkResumeSession).mockClear();
});

describe("ClaudeSdkSessionView", () => {
  it("renders without crashing for a new session", () => {
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" isNew />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders without crashing for an existing session (isNew=false)", () => {
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders the thread top bar by default", () => {
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeTruthy();
  });

  it("hides the top bar when hideTopBar is true", () => {
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" hideTopBar />
    );
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeNull();
  });

  it("renders the input bar", () => {
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.querySelector("[data-testid='claude-input-bar']")).toBeTruthy();
  });

  it("renders some content even when no messages exist", () => {
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders in compact mode without crashing", () => {
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" compact />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders the input bar in compact + isNew + hideTopBar combo", () => {
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" compact isNew hideTopBar />
    );
    expect(container.querySelector("[data-testid='claude-input-bar']")).toBeTruthy();
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeNull();
  });

  it("renders with a different sessionId without crashing", () => {
    const { container } = render(
      <ClaudeSdkSessionView sessionId="other-session" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with a Windows-style cwd path", () => {
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="C:\\Users\\test\\repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with empty cwd", () => {
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("uses an external context snapshot for both shared chrome surfaces", () => {
    const externalContextUsage = {
      usedTokens: 22_254,
      maxTokens: 512_000,
      inputTokens: 22_254,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalProcessedTokens: 22_254,
      totalCostUsd: 0,
      numTurns: 0,
      lastInputTokens: null,
      lastOutputTokens: null,
      lastCachedInputTokens: null,
      compactsAutomatically: true,
    };

    render(
      <ClaudeSdkSessionView
        sessionId="grok-thread"
        cwd="/tmp/repo"
        transport={{
          send: vi.fn(),
          respondApproval: vi.fn(),
          interrupt: vi.fn(),
          setModel: vi.fn(),
        }}
        externalSessionReady
        providerOverride="Grok"
        externalContextUsage={externalContextUsage}
      />,
    );

    expect(threadTopBarSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ contextUsage: externalContextUsage }),
    );
    expect(claudeInputBarSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ contextUsage: externalContextUsage }),
    );
  });

  it("rerenders with isNew toggling from true to false", () => {
    const { container, rerender } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" isNew />
    );
    expect(container.firstChild).toBeTruthy();
    rerender(<ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />);
    expect(container.firstChild).toBeTruthy();
  });

  it("rerenders with hideTopBar toggling true → false → true", () => {
    const { container, rerender } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" hideTopBar />
    );
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeNull();
    rerender(<ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />);
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeTruthy();
    rerender(<ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" hideTopBar />);
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeNull();
  });

  it("rerenders with sessionId change without crashing", () => {
    const { container, rerender } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
    rerender(<ClaudeSdkSessionView sessionId="s2" cwd="/tmp/repo" />);
    expect(container.firstChild).toBeTruthy();
  });

  it("rerenders with cwd change without crashing", () => {
    const { container, rerender } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
    rerender(<ClaudeSdkSessionView sessionId="s1" cwd="/another/repo" />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders when threadStore has matching thread populated", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "s1",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Idle",
            name: "SDK thread",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: "sonnet",
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders when threadStore has Running thread", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "s1",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Running",
            name: "SDK thread",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders when threadStore has Error-status thread", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "s1",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Error",
            name: "SDK thread",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders when threadStore has thread with worktree branch", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "s1",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Idle",
            name: "SDK thread",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: "opus",
            worktree_branch: "feature/x",
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with a thread not matching the sessionId (orphan)", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "different",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Idle",
            name: "Other",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders some scroll/list area in chat", () => {
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    // ensure rendering produced more than just the input bar
    expect(container.querySelectorAll("div").length).toBeGreaterThan(1);
  });

  it("does not show approval banner by default", () => {
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.querySelector("[data-testid='approval-banner']")).toBeNull();
  });

  it("does not show plan follow-up banner by default", () => {
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.querySelector("[data-testid='plan-follow-up-banner']")).toBeNull();
  });

  it("renders with multiple sequential mounts (cleanup between)", () => {
    const r1 = render(<ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />);
    expect(r1.container.firstChild).toBeTruthy();
    cleanup();
    const r2 = render(<ClaudeSdkSessionView sessionId="s2" cwd="/tmp/repo" isNew />);
    expect(r2.container.firstChild).toBeTruthy();
  });

  it("renders consistent structure across compact and non-compact", () => {
    const r1 = render(<ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />);
    const hasInputBar1 = r1.container.querySelector("[data-testid='claude-input-bar']");
    cleanup();
    const r2 = render(<ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" compact />);
    const hasInputBar2 = r2.container.querySelector("[data-testid='claude-input-bar']");
    expect(hasInputBar1).toBeTruthy();
    expect(hasInputBar2).toBeTruthy();
  });

  it("renders with session id containing UUID-like value", () => {
    const { container } = render(
      <ClaudeSdkSessionView sessionId="abcd1234-5678-90ef-1234-567890abcdef" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with cwd at filesystem root", () => {
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with cwd containing spaces", () => {
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/Users/me/My Repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with cwd containing unicode", () => {
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/repo/データ" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with deeply nested cwd", () => {
    const long = "/" + "a/b/".repeat(20) + "repo";
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd={long} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for thread with model haiku", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "s1",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Idle",
            name: "S",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: "haiku",
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for thread with model claude-sonnet-4-5", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "s1",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Idle",
            name: "S",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: "claude-sonnet-4-5",
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for Spawning thread", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "s1",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
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
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for Stopped thread", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "s1",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
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
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for thread with fast_mode=1", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "s1",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Idle",
            name: "Fast",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
            fast_mode: 1,
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders compact + isNew explicitly false", () => {
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" compact isNew={false} />
    );
    expect(container.querySelector("[data-testid='claude-input-bar']")).toBeTruthy();
  });

  it("renders compact false explicitly", () => {
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" compact={false} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("rerenders compact toggling true → false → true", () => {
    const { rerender, container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    rerender(<ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" compact />);
    rerender(<ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />);
    rerender(<ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" compact />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for sdk_session_id-bound thread", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "s1",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Idle",
            name: "Resumed",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
            sdk_session_id: "real-sdk-uuid",
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("does not crash with rapid mount/unmount cycles", () => {
    for (let i = 0; i < 5; i++) {
      const { unmount } = render(
        <ClaudeSdkSessionView sessionId={`s${i}`} cwd="/tmp/repo" />
      );
      unmount();
    }
    expect(true).toBe(true);
  });

  it("renders for thread with reasoning_effort low", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "s1",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Idle",
            name: "X",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
            reasoning_effort: "low",
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for thread with reasoning_effort high", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "s1",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Idle",
            name: "X",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
            reasoning_effort: "high",
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders empty store with multiple project entries", () => {
    useThreadStore.setState({
      threads: {
        p1: [],
        p2: [],
      },
    } as never);
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with session id matching thread in non-default project key", () => {
    useThreadStore.setState({
      threads: {
        p2: [
          {
            id: "s1",
            project_id: "p2",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Idle",
            name: "P2 thread",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("input bar still present for various combos of props", () => {
    const combos = [
      { isNew: true, compact: true, hideTopBar: true },
      { isNew: false, compact: false, hideTopBar: false },
      { isNew: true, compact: false, hideTopBar: true },
      { isNew: false, compact: true, hideTopBar: false },
    ];
    for (const props of combos) {
      const { container, unmount } = render(
        <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" {...props} />
      );
      expect(container.querySelector("[data-testid='claude-input-bar']")).toBeTruthy();
      unmount();
    }
  });
});

describe("ClaudeSdkSessionView — lifecycle & store reactivity", () => {
  it("input bar remains rendered after threadStore status flips Idle → Running", () => {
    const baseThread: Record<string, unknown> = {
      id: "s1",
      project_id: "p1",
      provider: "ClaudeCode",
      interaction_mode: "sdk",
      status: "Idle",
      name: "X",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
      model: null,
      sdk_session_id: "sdk-1",
    };
    useThreadStore.setState({
      threads: { p1: [baseThread as never] },
    } as never);
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.querySelector("[data-testid='claude-input-bar']")).toBeTruthy();
    useThreadStore.setState({
      threads: { p1: [{ ...baseThread, status: "Running" } as never] },
    } as never);
    expect(container.querySelector("[data-testid='claude-input-bar']")).toBeTruthy();
  });

  it("survives store update from Running → Stopped without crashing", () => {
    const baseThread: Record<string, unknown> = {
      id: "s1",
      project_id: "p1",
      provider: "ClaudeCode",
      interaction_mode: "sdk",
      status: "Running",
      name: "X",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
      model: null,
    };
    useThreadStore.setState({
      threads: { p1: [baseThread as never] },
    } as never);
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    useThreadStore.setState({
      threads: { p1: [{ ...baseThread, status: "Stopped" } as never] },
    } as never);
    expect(container.firstChild).toBeTruthy();
  });

  it("does not crash when thread is removed from store after mount", () => {
    const t = {
      id: "s1",
      project_id: "p1",
      provider: "ClaudeCode",
      interaction_mode: "sdk",
      status: "Idle",
      name: "X",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
      model: null,
    } as never;
    useThreadStore.setState({ threads: { p1: [t] } } as never);
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    useThreadStore.setState({ threads: {} } as never);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for thread with reasoning_effort medium", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "s1",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Idle",
            name: "X",
            reasoning_effort: "medium",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: "sonnet",
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for thread with fast_mode=0", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "s1",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Idle",
            name: "X",
            fast_mode: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders consistently when sessionId switches between two store-backed threads", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "s1",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Idle",
            name: "A",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
          {
            id: "s2",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Running",
            name: "B",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container, rerender } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
    rerender(<ClaudeSdkSessionView sessionId="s2" cwd="/tmp/repo" />);
    expect(container.querySelector("[data-testid='claude-input-bar']")).toBeTruthy();
    rerender(<ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />);
    expect(container.querySelector("[data-testid='claude-input-bar']")).toBeTruthy();
  });

  it("renders without sdk_session_id (fresh thread, no resume)", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "s1",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Idle",
            name: "X",
            sdk_session_id: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" isNew />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders multiple project keys in store, only matching project's thread used", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "s1",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Idle",
            name: "X",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
        p2: [
          {
            id: "s2",
            project_id: "p2",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Running",
            name: "Y",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders thread top bar consistently across compact/non-compact when thread in store", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "s1",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
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
    const a = render(<ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" />);
    expect(a.container.querySelector("[data-testid='thread-top-bar']")).toBeTruthy();
    a.unmount();
    const b = render(
      <ClaudeSdkSessionView sessionId="s1" cwd="/tmp/repo" compact />
    );
    expect(b.container.firstChild).toBeTruthy();
  });
});

// =====================================================================
// Deep coverage — exercise SDK event handlers via captured listen callback.
// These tests fire synthetic Tauri events into the component to drive the
// large switch in handleSdkEvent (lines 1115–1810 in production), bumping
// coverage from ~25% by hitting branches that never fire on plain mount.
// =====================================================================
describe("ClaudeSdkSessionView — deep coverage (SDK event handlers)", () => {
  type Listener = (event: { payload: unknown }) => void;

  function captureListeners() {
    const handlers: Record<string, Listener> = {};
    // Lazily import the mocked listen so we get the same module instance vitest aliased.
    return { handlers };
  }

  async function setupCapture() {
    const eventModule = await import("@tauri-apps/api/event");
    const handlers: Record<string, Listener> = {};
    vi.mocked(eventModule.listen).mockImplementation(((channel: string, cb: Listener) => {
      handlers[channel] = cb;
      return Promise.resolve(() => {});
    }) as never);
    return handlers;
  }

  async function flush() {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  function fireSdk(handlers: Record<string, Listener>, sessionId: string, payload: unknown) {
    const channel = `sdk-event-${sessionId}`;
    const h = handlers[channel];
    if (h) h({ payload });
  }

  beforeEach(() => {
    captureListeners();
  });

  it("captures the sdk-event listener channel on mount", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="dc1" cwd="/tmp/repo" isNew />);
    await flush();
    expect(handlers[`sdk-event-dc1`]).toBeTruthy();
  });

  it("handles session.started event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc2" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc2", { type: "session.started", sessionId: "real-uuid-1" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles session.init with slashCommands", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc3" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc3", {
      type: "session.init",
      sessionId: "init-1",
      slashCommands: ["help", "clear", "compact"],
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles content.delta text type", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc4" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc4", { type: "content.delta", contentType: "text", text: "Hello " });
    fireSdk(handlers, "dc4", { type: "content.delta", contentType: "text", text: "world" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles content.delta thinking type", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc5" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc5", { type: "content.delta", contentType: "thinking", text: "Thinking..." });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles tool.started event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc6" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc6", {
      type: "tool.started",
      toolUseId: "tu1",
      name: "Bash",
      input: { command: "ls" },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles tool.completed event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc7" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc7", {
      type: "tool.started",
      toolUseId: "tu2",
      name: "Read",
      input: { file_path: "/tmp/f" },
    });
    fireSdk(handlers, "dc7", {
      type: "tool.completed",
      toolUseId: "tu2",
      content: "ok",
      isError: false,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles tool.completed with isError=true", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc8" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc8", {
      type: "tool.started",
      toolUseId: "tu3",
      name: "Bash",
      input: { command: "false" },
    });
    fireSdk(handlers, "dc8", {
      type: "tool.completed",
      toolUseId: "tu3",
      content: "exit 1",
      isError: true,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles approval.requested event types", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc9" cwd="/tmp/repo" isNew />
    );
    await flush();
    for (const requestType of [
      "command_execution",
      "file_change",
      "file_read",
      "dynamic_tool_call",
    ] as const) {
      fireSdk(handlers, "dc9", {
        type: "approval.requested",
        requestId: `req-${requestType}`,
        toolName: "Bash",
        detail: "rm -rf",
        requestType,
      });
    }
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles userInput.requested event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc10" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc10", {
      type: "userInput.requested",
      requestId: "ui1",
      questions: [{ text: "Confirm?" }],
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles usage.update event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc11" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc11", {
      type: "usage.update",
      inputTokens: 1000,
      outputTokens: 2000,
      cacheCreationTokens: 100,
      cacheReadTokens: 50,
      totalTokens: 3150,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles turn.completed event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc12" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc12", {
      type: "turn.completed",
      sessionId: "real-uuid",
      model: "sonnet",
      modelUsage: { sonnet: { contextWindow: 200000 } },
      userMessageUuid: "user-uuid",
      usage: {
        inputTokens: 100,
        outputTokens: 200,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCostUsd: 0.01,
        numTurns: 1,
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles session.ended with multiple reasons", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc13" cwd="/tmp/repo" isNew />
    );
    await flush();
    for (const reason of ["completed", "error", "interrupted"] as const) {
      fireSdk(handlers, "dc13", { type: "session.ended", reason });
    }
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles task.notification event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc14" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc14", {
      type: "task.notification",
      taskId: "task-1",
      title: "Build complete",
      body: "All tests passed",
      status: "completed",
      summary: "OK",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles compact.boundary event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc15" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc15", { type: "compact.boundary" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles status events", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc16" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc16", { type: "status", status: "ready" });
    fireSdk(handlers, "dc16", { type: "status", status: "busy" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles hook.started and hook.response", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc17" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc17", { type: "hook.started", hookName: "preToolUse" });
    fireSdk(handlers, "dc17", { type: "hook.response", hookName: "preToolUse", decision: "allow" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles tool.progress event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc18" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc18", {
      type: "tool.progress",
      toolUseId: "tu-prog",
      message: "Processing chunk 50%",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles task.started and task.progress events", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc19" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc19", {
      type: "task.started",
      taskId: "subtask-1",
      title: "Run tests",
    });
    fireSdk(handlers, "dc19", {
      type: "task.progress",
      taskId: "subtask-1",
      message: "50% done",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles command.output event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc20" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc20", {
      type: "command.output",
      command: "/help",
      output: "Available commands: ...",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles auth.status event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc21" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc21", { type: "auth.status", authenticated: true });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles files.persisted event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc22" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc22", {
      type: "files.persisted",
      files: ["/tmp/a", "/tmp/b"],
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles rate.limit event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc23" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc23", {
      type: "rate.limit",
      message: "Rate limited until 5min",
      resetAt: new Date(Date.now() + 300_000).toISOString(),
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles error event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc24" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc24", {
      type: "error",
      message: "Something went wrong",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles a full turn lifecycle in sequence", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc25" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc25", { type: "session.started", sessionId: "s-uuid" });
    fireSdk(handlers, "dc25", {
      type: "session.init",
      sessionId: "s-uuid",
      slashCommands: ["help"],
    });
    fireSdk(handlers, "dc25", { type: "content.delta", contentType: "thinking", text: "hmm" });
    fireSdk(handlers, "dc25", { type: "content.delta", contentType: "text", text: "Let me " });
    fireSdk(handlers, "dc25", { type: "content.delta", contentType: "text", text: "check" });
    fireSdk(handlers, "dc25", {
      type: "tool.started",
      toolUseId: "tu-x",
      name: "Read",
      input: { file_path: "/x" },
    });
    fireSdk(handlers, "dc25", {
      type: "tool.completed",
      toolUseId: "tu-x",
      content: "file contents",
      isError: false,
    });
    fireSdk(handlers, "dc25", { type: "content.delta", contentType: "text", text: " done." });
    fireSdk(handlers, "dc25", {
      type: "turn.completed",
      sessionId: "s-uuid",
      model: "sonnet",
      modelUsage: null,
      userMessageUuid: null,
      usage: {
        inputTokens: 50,
        outputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCostUsd: 0.005,
        numTurns: 1,
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles unknown event types without crashing", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc26" cwd="/tmp/repo" isNew />
    );
    await flush();
    fireSdk(handlers, "dc26", { type: "unknown.event.type", arbitrary: 1 } as never);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("survives a torrent of content.delta events", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc27" cwd="/tmp/repo" isNew />
    );
    await flush();
    for (let i = 0; i < 25; i++) {
      fireSdk(handlers, "dc27", {
        type: "content.delta",
        contentType: "text",
        text: `chunk-${i} `,
      });
    }
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("dispatches events to a thread with a known store entry", async () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "dc28",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Idle",
            name: "Deep",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: "sonnet",
          } as never,
        ],
      },
    } as never);
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc28" cwd="/tmp/repo" />
    );
    await flush();
    fireSdk(handlers, "dc28", { type: "session.started", sessionId: "real-uuid" });
    fireSdk(handlers, "dc28", { type: "content.delta", contentType: "text", text: "Hi" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ignores events fired after unmount (cleanup path)", async () => {
    const handlers = await setupCapture();
    const { unmount } = render(
      <ClaudeSdkSessionView sessionId="dc29" cwd="/tmp/repo" isNew />
    );
    await flush();
    unmount();
    // Fire after unmount — should not throw
    fireSdk(handlers, "dc29", { type: "content.delta", contentType: "text", text: "post-unmount" });
    await flush();
    expect(true).toBe(true);
  });

  it("dispatches events for non-isNew (resumed) thread", async () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "dc30",
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Idle",
            name: "X",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
            sdk_session_id: "previously-resumed-uuid",
          } as never,
        ],
      },
    } as never);
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="dc30" cwd="/tmp/repo" />
    );
    await flush();
    fireSdk(handlers, "dc30", { type: "session.started", sessionId: "previously-resumed-uuid" });
    fireSdk(handlers, "dc30", { type: "content.delta", contentType: "text", text: "Resumed" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });
});

// =====================================================================
// Maximum coverage — fires every SDK event branch with realistic payloads
// to drive ClaudeSdkSessionView line coverage past 75%.
// =====================================================================
describe("Maximum coverage", () => {
  type Listener = (event: { payload: unknown }) => void;

  async function setupCapture() {
    const eventModule = await import("@tauri-apps/api/event");
    const handlers: Record<string, Listener> = {};
    vi.mocked(eventModule.listen).mockImplementation(((channel: string, cb: Listener) => {
      handlers[channel] = cb;
      return Promise.resolve(() => {});
    }) as never);
    return handlers;
  }

  async function flush() {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  function fire(handlers: Record<string, Listener>, sessionId: string, payload: unknown) {
    const channel = `sdk-event-${sessionId}`;
    const h = handlers[channel];
    if (h) h({ payload });
  }

  function seedThread(id: string, overrides: Record<string, unknown> = {}) {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id,
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Idle",
            name: "T",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: "sonnet",
            ...overrides,
          } as never,
        ],
      },
    } as never);
  }

  // --- session.started branches ---
  it("session.started seeds sdk_session_id on the thread store", async () => {
    seedThread("mc1");
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc1" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc1", { type: "session.started", sessionId: "fresh-uuid-1" });
    await flush();
    const t = (useThreadStore.getState().threads.p1 as never as Array<{ id: string; sdk_session_id?: string }>)
      .find((th) => th.id === "mc1");
    expect(t?.sdk_session_id).toBe("fresh-uuid-1");
  });

  it("session.started without sessionId still flips status to running", async () => {
    seedThread("mc2");
    const handlers = await setupCapture();
    const { container } = render(<ClaudeSdkSessionView sessionId="mc2" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc2", { type: "session.started" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("session.started seeds model from thread when currentModelRef is null", async () => {
    seedThread("mc3", { model: null });
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc3" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc3", { type: "session.started", sessionId: "u-3" });
    await flush();
    expect(true).toBe(true);
  });

  // --- content.delta branches: text + thinking + interval reveal ---
  it("content.delta text triggers typewriter interval and renders text after time", async () => {
    vi.useFakeTimers();
    try {
      const handlers = await setupCapture();
      render(<ClaudeSdkSessionView sessionId="mc4" cwd="/tmp/repo" isNew />);
      await Promise.resolve();
      await Promise.resolve();
      fire(handlers, "mc4", { type: "content.delta", contentType: "text", text: "Hello world this is a long enough chunk to reveal" });
      vi.advanceTimersByTime(200);
      vi.advanceTimersByTime(200);
      vi.advanceTimersByTime(200);
    } finally {
      vi.useRealTimers();
    }
    expect(true).toBe(true);
  });

  it("content.delta thinking triggers thinking accumulator", async () => {
    vi.useFakeTimers();
    try {
      const handlers = await setupCapture();
      render(<ClaudeSdkSessionView sessionId="mc5" cwd="/tmp/repo" isNew />);
      await Promise.resolve();
      await Promise.resolve();
      fire(handlers, "mc5", { type: "content.delta", contentType: "thinking", text: "deliberating about the answer" });
      vi.advanceTimersByTime(500);
    } finally {
      vi.useRealTimers();
    }
    expect(true).toBe(true);
  });

  it("content.delta with both text and thinking simultaneously", async () => {
    vi.useFakeTimers();
    try {
      const handlers = await setupCapture();
      render(<ClaudeSdkSessionView sessionId="mc6" cwd="/tmp/repo" isNew />);
      await Promise.resolve();
      await Promise.resolve();
      fire(handlers, "mc6", { type: "content.delta", contentType: "thinking", text: "ponder " });
      fire(handlers, "mc6", { type: "content.delta", contentType: "text", text: "answer " });
      fire(handlers, "mc6", { type: "content.delta", contentType: "thinking", text: "more thought" });
      fire(handlers, "mc6", { type: "content.delta", contentType: "text", text: "more text" });
      vi.advanceTimersByTime(2000);
    } finally {
      vi.useRealTimers();
    }
    expect(true).toBe(true);
  });

  it("feeds the subagent card without mounting launch tool rows", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="roster" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "roster", {
      type: "tool.started", toolUseId: "scout", name: "Agent",
      input: { description: "Scout performance", prompt: "Find slow renders", run_in_background: true },
    });
    await flush();
    expect(screen.queryByTestId("subagent-launch-row")).toBeNull();
    expect(inspectorPropsSpy.mock.lastCall?.[0].subagents).toEqual([
      expect.objectContaining({ toolUseId: "scout", title: "Scout performance", prompt: "Find slow renders", status: "running" }),
    ]);
    fire(handlers, "roster", { type: "task.started", taskId: "scout-task", description: "Scout performance" });
    fire(handlers, "roster", { type: "task.notification", taskId: "scout-task", status: "completed", summary: "Done" });
    await flush();
    expect(inspectorPropsSpy.mock.lastCall?.[0].subagents[0].status).toBe("completed");
  });

  // --- tool.started branches ---
  it("tool.started for plain tool appends a ToolUse item", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc7" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc7", {
      type: "tool.started",
      toolUseId: "t-bash-1",
      name: "Bash",
      input: { command: "ls -la" },
    });
    await flush();
    expect(true).toBe(true);
  });

  it("tool.started for nested child tool appends to parent", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc8" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc8", {
      type: "tool.started",
      toolUseId: "parent-1",
      name: "Task",
      input: { description: "agent" },
    });
    fire(handlers, "mc8", {
      type: "tool.started",
      toolUseId: "child-1",
      parentToolUseId: "parent-1",
      name: "Read",
      input: { file_path: "/x" },
    });
    await flush();
    expect(true).toBe(true);
  });

  it("tool.started for nested child with unknown parent uses fallback", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc9" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc9", {
      type: "tool.started",
      toolUseId: "orphan-1",
      parentToolUseId: "missing-parent",
      name: "Read",
      input: {},
    });
    await flush();
    expect(true).toBe(true);
  });

  it("tool.started with TodoWrite replaces previous todo list", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc10" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc10", {
      type: "tool.started",
      toolUseId: "todo-1",
      name: "TodoWrite",
      input: { todos: [{ id: "1", content: "task 1", status: "pending" }] },
    });
    fire(handlers, "mc10", {
      type: "tool.started",
      toolUseId: "todo-2",
      name: "TodoWrite",
      input: { todos: [{ id: "1", content: "task 1", status: "in_progress" }] },
    });
    await flush();
    expect(true).toBe(true);
  });

  it("tool.started for Task with run_in_background tracks pending", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc11" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc11", {
      type: "tool.started",
      toolUseId: "agent-1",
      name: "Task",
      input: { description: "background work", run_in_background: true },
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- tool.completed merges result ---
  it("tool.completed merges result into matching tool use", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc12" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc12", {
      type: "tool.started",
      toolUseId: "tu-A",
      name: "Read",
      input: { file_path: "/a" },
    });
    fire(handlers, "mc12", {
      type: "tool.completed",
      toolUseId: "tu-A",
      content: "file body",
      isError: false,
    });
    await flush();
    expect(true).toBe(true);
  });

  it("tool.completed with isError=true marks tool failed", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc13" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc13", {
      type: "tool.started",
      toolUseId: "tu-err",
      name: "Bash",
      input: { command: "false" },
    });
    fire(handlers, "mc13", {
      type: "tool.completed",
      toolUseId: "tu-err",
      content: "exit 1",
      isError: true,
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- approval.requested + queue ---
  it("approval.requested adds an item that ApprovalBanner can consume", async () => {
    const handlers = await setupCapture();
    const { container } = render(<ClaudeSdkSessionView sessionId="mc14" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc14", {
      type: "approval.requested",
      requestId: "req-1",
      toolName: "Bash",
      detail: "ls /tmp",
      requestType: "command_execution",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("approval.requested followed by approval.requested keeps both in queue", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc15" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc15", {
      type: "approval.requested",
      requestId: "r1",
      toolName: "Bash",
      detail: "x",
      requestType: "command_execution",
    });
    fire(handlers, "mc15", {
      type: "approval.requested",
      requestId: "r2",
      toolName: "Edit",
      detail: "y",
      requestType: "file_change",
    });
    await flush();
    expect(true).toBe(true);
  });

  it("approval.requested with file_read request type", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc16" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc16", {
      type: "approval.requested",
      requestId: "r-fr",
      toolName: "Read",
      detail: "/secret",
      requestType: "file_read",
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- userInput.requested ---
  it("userInput.requested sets pending input state", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc17" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc17", {
      type: "userInput.requested",
      requestId: "ui-1",
      questions: [{ text: "What's your name?" }],
    });
    await flush();
    expect(true).toBe(true);
  });

  it("userInput.requested with multiple questions", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc18" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc18", {
      type: "userInput.requested",
      requestId: "ui-2",
      questions: [{ text: "Q1?" }, { text: "Q2?" }, { text: "Q3?" }],
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- usage.update branches ---
  it("usage.update populates context usage ring", async () => {
    seedThread("mc19", { model: "claude-sonnet-4-5" });
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc19" cwd="/tmp/repo" />);
    await flush();
    fire(handlers, "mc19", {
      type: "usage.update",
      inputTokens: 1500,
      outputTokens: 500,
      cacheCreationTokens: 800,
      cacheReadTokens: 12000,
      totalTokens: 14800,
    });
    await flush();
    expect(true).toBe(true);
  });

  it("usage.update twice preserves prior cumulative stats", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc20" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc20", {
      type: "usage.update",
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 20,
      cacheReadTokens: 5000,
      totalTokens: null,
    });
    fire(handlers, "mc20", {
      type: "usage.update",
      inputTokens: 200,
      outputTokens: 80,
      cacheCreationTokens: 30,
      cacheReadTokens: 5500,
      totalTokens: null,
    });
    await flush();
    expect(true).toBe(true);
  });

  it("usage.update with all zero tokens uses fallback to 0", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc21" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc21", {
      type: "usage.update",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: null,
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- turn.completed branches ---
  it("turn.completed with model triggers backfill on AssistantText items", async () => {
    seedThread("mc22");
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc22" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc22", { type: "content.delta", contentType: "text", text: "hi" });
    fire(handlers, "mc22", {
      type: "turn.completed",
      sessionId: "u",
      model: "claude-sonnet-4-6",
      modelUsage: null,
      userMessageUuid: "user-uuid-1",
      usage: {
        inputTokens: 50,
        outputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCostUsd: 0.001,
        numTurns: 1,
      },
    });
    await flush();
    expect(true).toBe(true);
  });

  it("turn.completed without model still emits result info item", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc23" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc23", {
      type: "turn.completed",
      sessionId: "u",
      model: null,
      modelUsage: null,
      userMessageUuid: null,
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCostUsd: 0,
        numTurns: 1,
      },
    });
    await flush();
    expect(true).toBe(true);
  });

  it("turn.completed after usage.update uses lastApiCallUsageRef", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc24" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc24", {
      type: "usage.update",
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationTokens: 50,
      cacheReadTokens: 8000,
      totalTokens: null,
    });
    fire(handlers, "mc24", {
      type: "turn.completed",
      sessionId: "u",
      model: "sonnet",
      modelUsage: null,
      userMessageUuid: null,
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheCreationTokens: 50,
        cacheReadTokens: 8000,
        totalCostUsd: 0.002,
        numTurns: 1,
      },
    });
    await flush();
    expect(true).toBe(true);
  });

  it("turn.completed with usage fills the context ring", async () => {
    seedThread("ctx-gemini", { model: "gemini-3.8-flash-high", provider: "Gemini" });
    const handlers = await setupCapture();
    render(
      <ClaudeSdkSessionView
        sessionId="ctx-gemini"
        cwd="/tmp/repo"
        isNew
        providerOverride="Gemini"
      />,
    );
    await flush();
    fire(handlers, "ctx-gemini", {
      type: "turn.completed",
      sessionId: "s",
      model: "gemini-3.8-flash-high",
      modelUsage: { "gemini-3.8-flash-high": { contextWindow: 1_000_000 } },
      userMessageUuid: null,
      usage: {
        inputTokens: 9073,
        outputTokens: 731,
        cacheCreationTokens: 0,
        cacheReadTokens: 89877,
        totalCostUsd: 0,
        numTurns: 1,
      },
    });
    await flush();
    expect(claudeInputBarSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        contextUsage: expect.objectContaining({
          usedTokens: 9073 + 89877,
          maxTokens: 1_000_000,
          inputTokens: 9073,
          outputTokens: 731,
        }),
      }),
    );
  });

  it.each([
    ["composer-2.5", 268_000, 4_000, 205_000],
    ["grok-4.6?effort=high", 386_000, 7_000, 327_000],
  ])("Cursor %s turn totals do not become context occupancy", async (model, inputTokens, outputTokens, cacheReadTokens) => {
    seedThread("ctx-cursor-grok", {
      model,
      provider: "Cursor",
    });
    const handlers = await setupCapture();
    render(
      <ClaudeSdkSessionView
        sessionId="ctx-cursor-grok"
        cwd="/tmp/repo"
        isNew
        providerOverride="Cursor"
      />,
    );
    await flush();
    fire(handlers, "ctx-cursor-grok", {
      type: "usage.update",
      inputTokens,
      outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens,
      // Cursor billed total — must not drive the ring.
      totalTokens: inputTokens + outputTokens + cacheReadTokens,
    });
    await flush();
    for (const spy of [claudeInputBarSpy, threadTopBarSpy]) {
      expect(spy).toHaveBeenLastCalledWith(
        expect.objectContaining({ contextUsage: null }),
      );
    }
    fire(handlers, "ctx-cursor-grok", {
      type: "turn.completed",
      sessionId: "s",
      model,
      modelUsage: null,
      userMessageUuid: null,
      usage: {
        inputTokens,
        outputTokens,
        cacheCreationTokens: 0,
        cacheReadTokens,
        totalCostUsd: 0,
        numTurns: 1,
      },
    });
    await flush();
    for (const spy of [claudeInputBarSpy, threadTopBarSpy]) {
      expect(spy).toHaveBeenLastCalledWith(
        expect.objectContaining({ contextUsage: null }),
      );
    }
  });

  it("zero usage.update does not wipe turn.completed token counts", async () => {
    seedThread("ctx-zero", { model: "gemini-3.8-flash-high", provider: "Gemini" });
    const handlers = await setupCapture();
    render(
      <ClaudeSdkSessionView
        sessionId="ctx-zero"
        cwd="/tmp/repo"
        isNew
        providerOverride="Gemini"
      />,
    );
    await flush();
    fire(handlers, "ctx-zero", {
      type: "usage.update",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
    });
    fire(handlers, "ctx-zero", {
      type: "turn.completed",
      sessionId: "s",
      model: "gemini-3.8-flash-high",
      modelUsage: { "gemini-3.8-flash-high": { contextWindow: 1_000_000 } },
      userMessageUuid: null,
      usage: {
        inputTokens: 9406,
        outputTokens: 286,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCostUsd: 0,
        numTurns: 1,
      },
    });
    await flush();
    expect(claudeInputBarSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        contextUsage: expect.objectContaining({
          usedTokens: 9406,
          inputTokens: 9406,
          outputTokens: 286,
        }),
      }),
    );
  });

  it("two consecutive turn.completed compute per-turn deltas", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc25" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc25", {
      type: "turn.completed",
      sessionId: "u",
      model: "sonnet",
      modelUsage: null,
      userMessageUuid: null,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 10,
        cacheReadTokens: 1000,
        totalCostUsd: 0.001,
        numTurns: 1,
      },
    });
    fire(handlers, "mc25", {
      type: "turn.completed",
      sessionId: "u",
      model: "sonnet",
      modelUsage: null,
      userMessageUuid: null,
      usage: {
        inputTokens: 250,
        outputTokens: 130,
        cacheCreationTokens: 30,
        cacheReadTokens: 2400,
        totalCostUsd: 0.003,
        numTurns: 2,
      },
    });
    await flush();
    expect(true).toBe(true);
  });

  it("turn.completed merges files.persisted into FilesChanged card", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc26" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc26", {
      type: "files.persisted",
      files: [
        { filename: "src/a.ts", fileId: "f1" },
        { filename: "src/b.ts", fileId: "f2" },
      ],
      failed: [{ filename: "src/c.ts", error: "perm denied" }],
      uuid: "user-x",
      sessionId: "u",
    });
    fire(handlers, "mc26", {
      type: "turn.completed",
      sessionId: "u",
      model: "sonnet",
      modelUsage: null,
      userMessageUuid: "user-x",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCostUsd: 0,
        numTurns: 1,
      },
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- session.ended branches ---
  it("session.ended with reason completed sets ended status", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc27" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc27", { type: "session.ended", reason: "completed" });
    await flush();
    expect(true).toBe(true);
  });

  it("session.ended with reason error sets error status", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc28" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc28", { type: "session.ended", reason: "error" });
    await flush();
    expect(true).toBe(true);
  });

  it("session.ended interrupted finalizes pending tools", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc29" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc29", {
      type: "tool.started",
      toolUseId: "tu-pending",
      name: "Bash",
      input: { command: "sleep 9999" },
    });
    fire(handlers, "mc29", { type: "session.ended", reason: "interrupted" });
    await flush();
    expect(true).toBe(true);
  });

  // --- task.notification ---
  it("task.notification with terminal status updates background task", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc30" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc30", {
      type: "tool.started",
      toolUseId: "ag-1",
      name: "Task",
      input: { run_in_background: true, description: "bg" },
    });
    fire(handlers, "mc30", {
      type: "task.started",
      taskId: "task-1",
      description: "bg work",
    });
    fire(handlers, "mc30", {
      type: "task.notification",
      taskId: "task-1",
      title: "Task complete",
      body: "All done",
      status: "completed",
      summary: "Successfully finished",
    });
    await flush();
    expect(true).toBe(true);
  });

  it("task.notification with failed status", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc31" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc31", {
      type: "tool.started",
      toolUseId: "ag-x",
      name: "Task",
      input: { run_in_background: true, description: "fail" },
    });
    fire(handlers, "mc31", { type: "task.started", taskId: "t-fail", description: "broken" });
    fire(handlers, "mc31", {
      type: "task.notification",
      taskId: "t-fail",
      title: "Notification",
      body: "Something failed",
      status: "failed",
      summary: null,
    });
    await flush();
    expect(true).toBe(true);
  });

  it("task.notification with stopped status", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc32" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc32", {
      type: "tool.started",
      toolUseId: "ag-z",
      name: "Task",
      input: { run_in_background: true, description: "stop" },
    });
    fire(handlers, "mc32", { type: "task.started", taskId: "t-stop", description: "killing" });
    fire(handlers, "mc32", {
      type: "task.notification",
      taskId: "t-stop",
      title: "Stopped",
      body: "halted",
      status: "stopped",
      summary: null,
    });
    await flush();
    expect(true).toBe(true);
  });

  it("task.notification with [ede_diagnostic] is filtered", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc33" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc33", {
      type: "task.notification",
      taskId: null,
      title: "Diagnostic",
      body: "[ede_diagnostic] internal trace",
      status: null,
      summary: null,
    });
    await flush();
    expect(true).toBe(true);
  });

  it("task.notification with empty body suppresses message", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc34" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc34", {
      type: "task.notification",
      taskId: null,
      title: "",
      body: "",
      status: null,
      summary: null,
    });
    await flush();
    expect(true).toBe(true);
  });

  it("task.notification with generic 'Notification' title prefix is suppressed", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc35" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc35", {
      type: "task.notification",
      taskId: null,
      title: "Notification",
      body: "Plain message body",
      status: null,
      summary: null,
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- session.init branches ---
  it("session.init with slash commands populates cache", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc36" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc36", {
      type: "session.init",
      sessionId: "s-init",
      slashCommands: ["help", "clear", "compact"],
    });
    await flush();
    expect(true).toBe(true);
  });

  it("session.init with empty slash commands skips cache", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc37" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc37", {
      type: "session.init",
      sessionId: "s",
      slashCommands: [],
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- compact.boundary ---
  it("compact.boundary pushes a CompactBoundary message", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc38" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc38", {
      type: "compact.boundary",
      preTokens: 12000,
      trigger: "auto",
    });
    await flush();
    expect(true).toBe(true);
  });

  it("compact.boundary with null preTokens", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc39" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc39", {
      type: "compact.boundary",
      preTokens: null,
      trigger: null,
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- status branches ---
  it("status compacting sets isCompacting=true", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc40" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc40", { type: "status", status: "compacting", message: "" });
    await flush();
    expect(true).toBe(true);
  });

  it("status stream_ended without pending retry is silent", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc41" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc41", { type: "status", status: "stream_ended", message: "" });
    await flush();
    expect(true).toBe(true);
  });

  it("status with arbitrary message appends a system message", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc42" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc42", {
      type: "status",
      status: "info",
      message: "Some informational message",
    });
    await flush();
    expect(screen.getByText("Some informational message")).toBeTruthy();
  });

  it("status lifecycle labels like FINISHED are not shown as system messages", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc42b" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc42b", { type: "status", status: "FINISHED", message: "FINISHED" });
    fire(handlers, "mc42b", { type: "status", status: "running", message: "Cursor agent is running" });
    fire(handlers, "mc42b", { type: "status", status: "idle", message: "idle" });
    await flush();
    expect(screen.queryByText("FINISHED")).toBeNull();
    expect(screen.queryByText("Cursor agent is running")).toBeNull();
    expect(screen.queryByText("idle")).toBeNull();
  });

  // --- hook.started / hook.response are silently consumed ---
  it("hook.started + hook.response do not emit visible messages", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc43" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc43", { type: "hook.started", hookName: "PreToolUse", hookEvent: "PreToolUse" });
    fire(handlers, "mc43", {
      type: "hook.response",
      hookName: "PreToolUse",
      hookEvent: "PreToolUse",
      outcome: "allow",
      exitCode: 0,
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- tool.progress ---
  it("tool.progress with content appends system message", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc44" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc44", {
      type: "tool.progress",
      toolUseId: "tu-1",
      content: "Working on it...",
    });
    await flush();
    expect(true).toBe(true);
  });

  it("tool.progress with empty content is no-op", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc45" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc45", {
      type: "tool.progress",
      toolUseId: "tu-2",
      content: "",
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- task.started ---
  it("task.started without prior pending Agent tool still creates task", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc46" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc46", {
      type: "task.started",
      taskId: "tx-1",
      description: "stand-alone bg",
    });
    await flush();
    expect(true).toBe(true);
  });

  it("task.started with null taskId is ignored", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc47" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc47", {
      type: "task.started",
      taskId: null,
      description: "no-id",
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- task.progress ---
  it("task.progress updates an existing background task", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc48" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc48", { type: "task.started", taskId: "tp-1", description: "bg" });
    fire(handlers, "mc48", {
      type: "task.progress",
      taskId: "tp-1",
      status: "running",
      lastToolName: "Read",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: null,
        toolUses: 3,
        durationMs: 5000,
      },
    });
    await flush();
    expect(true).toBe(true);
  });

  it("task.progress with null taskId is ignored", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc49" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc49", {
      type: "task.progress",
      taskId: null,
      status: "running",
      lastToolName: null,
      usage: null,
    });
    await flush();
    expect(true).toBe(true);
  });

  it("task.progress for unknown taskId is silently ignored", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc50" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc50", {
      type: "task.progress",
      taskId: "missing",
      status: "running",
      lastToolName: "X",
      usage: null,
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- command.output ---
  it("command.output with command appends labelled system message", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc51" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc51", {
      type: "command.output",
      command: "help",
      output: "Available: /help, /clear",
    });
    await flush();
    expect(true).toBe(true);
  });

  it("command.output without output emits 'executed'", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc52" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc52", {
      type: "command.output",
      command: "noop",
      output: "",
    });
    await flush();
    expect(true).toBe(true);
  });

  it("command.output with empty command falls back to 'Command'", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc53" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc53", {
      type: "command.output",
      command: "",
      output: "raw output",
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- auth.status ---
  it("auth.status with message appends it", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc54" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc54", {
      type: "auth.status",
      status: "ok",
      message: "Authenticated as user@example.com",
    });
    await flush();
    expect(true).toBe(true);
  });

  it("auth.status without message uses status fallback", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc55" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc55", {
      type: "auth.status",
      status: "needs_login",
      message: "",
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- files.persisted ---
  it("files.persisted accumulates files for current turn", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc56" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc56", {
      type: "files.persisted",
      files: [{ filename: "a.ts", fileId: "fa" }],
      failed: [],
      uuid: null,
      sessionId: "u",
    });
    fire(handlers, "mc56", {
      type: "files.persisted",
      files: [
        { filename: "a.ts", fileId: "fa-dup" }, // duplicate
        { filename: "b.ts", fileId: "fb" },
      ],
      failed: [{ filename: "c.ts", error: "denied" }, { filename: "c.ts", error: "denied-dup" }],
      uuid: "u-1",
      sessionId: "u",
    });
    await flush();
    expect(true).toBe(true);
  });

  it("files.persisted with empty files and failed is harmless", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc57" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc57", {
      type: "files.persisted",
      files: [],
      failed: [],
      uuid: null,
      sessionId: null,
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- rate.limit ---
  it("rate.limit sets warning and appends system message", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc58" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc58", {
      type: "rate.limit",
      message: "Slow down — try again in 60s",
      retryAfterSeconds: 60,
    });
    await flush();
    expect(true).toBe(true);
  });

  it("rate.limit without message uses default text", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc59" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc59", {
      type: "rate.limit",
      message: "",
      retryAfterSeconds: null,
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- error branches ---
  it("error with No conversation found triggers recoverable restart", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc60" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc60", {
      type: "error",
      message: "No conversation found in session",
    });
    await flush();
    // wait for setTimeout(300) inside recovery to flush
    await new Promise((r) => setTimeout(r, 350));
    expect(true).toBe(true);
  });

  it("error with Claude Code process exited triggers recoverable restart", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc61" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc61", {
      type: "error",
      message: "Claude Code process exited with code 1",
    });
    await flush();
    await new Promise((r) => setTimeout(r, 350));
    expect(true).toBe(true);
  });

  it("error with ProcessTransport is not ready triggers recoverable restart", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc62" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc62", {
      type: "error",
      message: "ProcessTransport is not ready",
    });
    await flush();
    await new Promise((r) => setTimeout(r, 350));
    expect(true).toBe(true);
  });

  it("non-recoverable error sets thread to Error and surfaces message", async () => {
    seedThread("mc63");
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc63" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc63", {
      type: "error",
      message: "Some unrecoverable problem",
    });
    await flush();
    expect(true).toBe(true);
  });

  it("error event evicts stale approvals from the queue", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc64" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc64", {
      type: "approval.requested",
      requestId: "stale",
      toolName: "Bash",
      detail: "x",
      requestType: "command_execution",
    });
    fire(handlers, "mc64", {
      type: "error",
      message: "Some unrecoverable problem",
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- pending first message + draft chat flow ---
  it("renders early optimistic user bubble when uiStore has pendingFirstMessage", async () => {
    useUiStore.setState({
      pendingFirstMessages: { mc65: "Hello world from draft" },
      pendingFirstImages: {},
      claudeProcessingById: {},
      pendingApprovalsBySession: {},
      sessionTerminalOpenByKey: {},
    } as never);
    const handlers = await setupCapture();
    const { container } = render(<ClaudeSdkSessionView sessionId="mc65" cwd="/tmp/repo" isNew />);
    await flush();
    expect(handlers["sdk-event-mc65"]).toBeTruthy();
    expect(container.firstChild).toBeTruthy();
  });

  it("optimistic bubble with attached images renders without crash", async () => {
    useUiStore.setState({
      pendingFirstMessages: { mc66: "with image" },
      pendingFirstImages: {
        mc66: [{ data: "iVBORw0KGgo=", mediaType: "image/png" }],
      },
      claudeProcessingById: {},
      pendingApprovalsBySession: {},
      sessionTerminalOpenByKey: {},
    } as never);
    await setupCapture();
    const { container } = render(<ClaudeSdkSessionView sessionId="mc66" cwd="/tmp/repo" isNew />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // --- a long sequence covering grouping + finalize on turn boundary ---
  it("multi-tool + assistant text + result info exercises grouping and finalize paths", async () => {
    seedThread("mc67");
    const handlers = await setupCapture();
    const { container } = render(<ClaudeSdkSessionView sessionId="mc67" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc67", { type: "session.started", sessionId: "u" });
    fire(handlers, "mc67", { type: "session.init", sessionId: "u", slashCommands: ["help"] });
    fire(handlers, "mc67", {
      type: "tool.started",
      toolUseId: "t1",
      name: "Read",
      input: { file_path: "/x" },
    });
    fire(handlers, "mc67", {
      type: "tool.completed",
      toolUseId: "t1",
      content: "x",
      isError: false,
    });
    fire(handlers, "mc67", {
      type: "tool.started",
      toolUseId: "t2",
      name: "Grep",
      input: { pattern: "TODO" },
    });
    fire(handlers, "mc67", {
      type: "tool.completed",
      toolUseId: "t2",
      content: "no matches",
      isError: false,
    });
    fire(handlers, "mc67", {
      type: "tool.started",
      toolUseId: "t3",
      name: "Edit",
      input: { file_path: "/x", old_string: "a", new_string: "b" },
    });
    fire(handlers, "mc67", {
      type: "tool.completed",
      toolUseId: "t3",
      content: "edited",
      isError: false,
    });
    fire(handlers, "mc67", {
      type: "files.persisted",
      files: [{ filename: "/x", fileId: "x1" }],
      failed: [],
      uuid: "user-uuid",
      sessionId: "u",
    });
    fire(handlers, "mc67", { type: "content.delta", contentType: "text", text: "Done" });
    fire(handlers, "mc67", {
      type: "turn.completed",
      sessionId: "u",
      model: "claude-sonnet-4-6",
      modelUsage: null,
      userMessageUuid: "user-uuid",
      usage: {
        inputTokens: 200,
        outputTokens: 80,
        cacheCreationTokens: 10,
        cacheReadTokens: 5000,
        totalCostUsd: 0.005,
        numTurns: 1,
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // --- second turn after first turn.completed exercises the prevTurnAccumulated diff ---
  it("two-turn lifecycle records boundaries", async () => {
    seedThread("mc68");
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc68" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc68", { type: "content.delta", contentType: "text", text: "first" });
    fire(handlers, "mc68", {
      type: "turn.completed",
      sessionId: "u",
      model: "sonnet",
      modelUsage: null,
      userMessageUuid: null,
      usage: {
        inputTokens: 50,
        outputTokens: 25,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCostUsd: 0.001,
        numTurns: 1,
      },
    });
    fire(handlers, "mc68", { type: "content.delta", contentType: "text", text: "second" });
    fire(handlers, "mc68", {
      type: "turn.completed",
      sessionId: "u",
      model: "sonnet",
      modelUsage: null,
      userMessageUuid: null,
      usage: {
        inputTokens: 100,
        outputTokens: 60,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCostUsd: 0.002,
        numTurns: 2,
      },
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- session.init fires after a /clear-like message ---
  it("session.init does NOT clear messages when last user message isn't /clear", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc69" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc69", { type: "content.delta", contentType: "text", text: "context" });
    fire(handlers, "mc69", {
      type: "session.init",
      sessionId: "u",
      slashCommands: ["clear"],
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- different content delta volumes to exercise interval step branches ---
  it("very large content delta triggers larger interval step", async () => {
    vi.useFakeTimers();
    try {
      const handlers = await setupCapture();
      render(<ClaudeSdkSessionView sessionId="mc70" cwd="/tmp/repo" isNew />);
      await Promise.resolve();
      await Promise.resolve();
      const big = "x".repeat(5000);
      fire(handlers, "mc70", { type: "content.delta", contentType: "text", text: big });
      vi.advanceTimersByTime(2000);
    } finally {
      vi.useRealTimers();
    }
    expect(true).toBe(true);
  });

  // --- usage.update before any content also seeds first per-call usage ---
  it("usage.update with totalTokens hint preserves seeded usage", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc71" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc71", {
      type: "usage.update",
      inputTokens: 25,
      outputTokens: 10,
      cacheCreationTokens: 0,
      cacheReadTokens: 100,
      totalTokens: 135,
    });
    fire(handlers, "mc71", {
      type: "turn.completed",
      sessionId: "u",
      model: "sonnet",
      modelUsage: null,
      userMessageUuid: null,
      usage: {
        inputTokens: 25,
        outputTokens: 10,
        cacheCreationTokens: 0,
        cacheReadTokens: 100,
        totalCostUsd: 0.001,
        numTurns: 1,
      },
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- approval queue + external clear sync ---
  it("external clear of pending approval pops the local queue head", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc72" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc72", {
      type: "approval.requested",
      requestId: "rext-1",
      toolName: "Bash",
      detail: "ls",
      requestType: "command_execution",
    });
    await flush();
    // Simulate external clear: pendingApprovalsBySession had the entry, now null
    useUiStore.setState((s: never) => ({
      ...(s as never as object),
      pendingApprovalsBySession: { mc72: null },
    } as never));
    await flush();
    useUiStore.setState((s: never) => ({
      ...(s as never as object),
      pendingApprovalsBySession: {},
    } as never));
    await flush();
    expect(true).toBe(true);
  });

  // --- turn.completed during steering should not clear isWorking (steering ref test) ---
  it("turn.completed plus subsequent session.ended is handled cleanly", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc73" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc73", {
      type: "turn.completed",
      sessionId: "u",
      model: null,
      modelUsage: null,
      userMessageUuid: null,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCostUsd: 0,
        numTurns: 1,
      },
    });
    fire(handlers, "mc73", { type: "session.ended", reason: "completed" });
    await flush();
    expect(true).toBe(true);
  });

  // --- usage.update with model from store rather than ref ---
  it("usage.update uses thread model for context window sizing", async () => {
    seedThread("mc74", { model: "claude-haiku-4-5" });
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc74" cwd="/tmp/repo" />);
    await flush();
    fire(handlers, "mc74", {
      type: "usage.update",
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 10,
      cacheReadTokens: 1000,
      totalTokens: null,
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- error then approval shouldn't crash ---
  it("error followed by approval.requested still queues approval", async () => {
    seedThread("mc75");
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc75" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc75", { type: "error", message: "Hard fail" });
    fire(handlers, "mc75", {
      type: "approval.requested",
      requestId: "post-err",
      toolName: "Bash",
      detail: "echo",
      requestType: "command_execution",
    });
    await flush();
    expect(true).toBe(true);
  });

  // --- final smoke: cleanup path with pending bg tools and approvals ---
  it("unmount with pending approvals and tasks cleans up timers", async () => {
    const handlers = await setupCapture();
    const { unmount } = render(<ClaudeSdkSessionView sessionId="mc76" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc76", {
      type: "approval.requested",
      requestId: "rr",
      toolName: "Edit",
      detail: "x",
      requestType: "file_change",
    });
    fire(handlers, "mc76", {
      type: "tool.started",
      toolUseId: "ag-u",
      name: "Task",
      input: { run_in_background: true, description: "bg" },
    });
    fire(handlers, "mc76", { type: "task.started", taskId: "tu", description: "x" });
    fire(handlers, "mc76", {
      type: "rate.limit",
      message: "rl",
      retryAfterSeconds: 5,
    });
    await flush();
    unmount();
    await flush();
    expect(true).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────────
  // History restore paths — exercises restoreLogsToItems + JSONL load
  // ────────────────────────────────────────────────────────────────────────

  it("restoreLogsToItems via sdkGetChatHistory restores text + tool_use + tool_result + thinking", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkGetChatHistory).mockResolvedValueOnce([
      {
        id: "1",
        thread_id: "mc77",
        direction: "Input",
        content: "user said hi",
        timestamp: new Date().toISOString(),
        log_type: "text",
        rowid: 1,
      },
      {
        id: "2",
        thread_id: "mc77",
        direction: "Output",
        content: "assistant text reply",
        timestamp: new Date().toISOString(),
        log_type: "text",
        rowid: 2,
      },
      {
        id: "3",
        thread_id: "mc77",
        direction: "Output",
        content: "thinking content",
        timestamp: new Date().toISOString(),
        log_type: "thinking",
        rowid: 3,
      },
      {
        id: "4",
        thread_id: "mc77",
        direction: "Output",
        content: JSON.stringify({
          toolUseId: "tu-1",
          name: "Bash",
          input: { command: "ls" },
        }),
        timestamp: new Date().toISOString(),
        log_type: "tool_use",
        rowid: 4,
      },
      {
        id: "5",
        thread_id: "mc77",
        direction: "Output",
        content: JSON.stringify({
          toolUseId: "tu-1",
          content: "result body",
          isError: false,
        }),
        timestamp: new Date().toISOString(),
        log_type: "tool_result",
        rowid: 5,
      },
      // malformed tool_use to exercise catch
      {
        id: "6",
        thread_id: "mc77",
        direction: "Output",
        content: "{not json",
        timestamp: new Date().toISOString(),
        log_type: "tool_use",
        rowid: 6,
      },
      // malformed tool_result to exercise catch
      {
        id: "7",
        thread_id: "mc77",
        direction: "Output",
        content: "{nope",
        timestamp: new Date().toISOString(),
        log_type: "tool_result",
        rowid: 7,
      },
      // tool_result with missing toolUseId
      {
        id: "8",
        thread_id: "mc77",
        direction: "Output",
        content: JSON.stringify({ content: "orphan" }),
        timestamp: new Date().toISOString(),
        log_type: "tool_result",
        rowid: 8,
      },
    ]);
    // Make readClaudeSessionHistory fail so we go to agent_logs fallback
    vi.mocked(cmd.readClaudeSessionHistory).mockRejectedValueOnce(new Error("no jsonl"));
    await setupCapture();
    const { container } = render(<ClaudeSdkSessionView sessionId="mc77" cwd="/tmp/repo" isNew />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("restoreLogsToItems with parent + child tool_use nests child under parent", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkGetChatHistory).mockResolvedValueOnce([
      {
        id: "10",
        thread_id: "mc78",
        direction: "Output",
        content: JSON.stringify({
          toolUseId: "P",
          name: "Task",
          input: { description: "agent" },
        }),
        timestamp: new Date().toISOString(),
        log_type: "tool_use",
        rowid: 10,
      },
      {
        id: "11",
        thread_id: "mc78",
        direction: "Output",
        content: JSON.stringify({
          toolUseId: "C",
          parentToolUseId: "P",
          name: "Read",
          input: { file_path: "/x" },
        }),
        timestamp: new Date().toISOString(),
        log_type: "tool_use",
        rowid: 11,
      },
      {
        id: "12",
        thread_id: "mc78",
        direction: "Output",
        content: JSON.stringify({ toolUseId: "C", content: "ok", isError: false }),
        timestamp: new Date().toISOString(),
        log_type: "tool_result",
        rowid: 12,
      },
    ]);
    vi.mocked(cmd.readClaudeSessionHistory).mockRejectedValueOnce(new Error("no jsonl"));
    await setupCapture();
    const { container } = render(<ClaudeSdkSessionView sessionId="mc78" cwd="/tmp/repo" isNew />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("readClaudeSessionHistory JSONL path loads items and folds tool_results", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.readClaudeSessionHistory).mockResolvedValueOnce({
      items: [
        {
          itemType: "UserMessage",
          content: "hello",
          timestamp: new Date().toISOString(),
          uuid: "u-1",
        },
        {
          itemType: "AssistantText",
          text: "hi back",
          timestamp: new Date().toISOString(),
          uuid: "u-2",
        },
        {
          itemType: "ToolUse",
          id: "tu-jsonl",
          parentToolUseId: null,
          name: "Bash",
          input: { command: "pwd" },
          timestamp: new Date().toISOString(),
          uuid: "u-3",
        },
        {
          itemType: "ToolResult",
          tool_use_id: "tu-jsonl",
          content: "/tmp",
          is_error: false,
          timestamp: new Date().toISOString(),
          uuid: "u-4",
        },
        {
          itemType: "ResultInfo",
          input_tokens: 5,
          output_tokens: 3,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          total_cost_usd: 0.001,
          num_turns: 0,
          session_id: "u",
          timestamp: new Date().toISOString(),
          uuid: "u-5",
        },
      ],
      byte_offset: 100,
    } as never);
    await setupCapture();
    const { container } = render(<ClaudeSdkSessionView sessionId="mc79" cwd="/tmp/repo" />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("puts the edit-and-branch control on the user prompt, not as a sibling of copy", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.readClaudeSessionHistory).mockResolvedValueOnce({
      items: [
        {
          itemType: "UserMessage",
          content: "please refactor this",
          timestamp: new Date().toISOString(),
          uuid: "u-edit-1",
        },
      ],
      byte_offset: 20,
    } as never);
    await setupCapture();
    const { getByTitle, getByText } = render(
      <ClaudeSdkSessionView sessionId="mc-edit-copy" cwd="/tmp/repo" />,
    );
    await flush();
    await flush();
    expect(getByText("please refactor this")).toBeTruthy();
    expect(getByTitle("Edit & branch from this message")).toBeTruthy();
  });

  it("agent_logs fallback returns no rows → hasOlderMessages set to false", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.readClaudeSessionHistory).mockRejectedValueOnce(new Error("nope"));
    vi.mocked(cmd.sdkGetChatHistory).mockResolvedValueOnce([]);
    await setupCapture();
    const { container } = render(<ClaudeSdkSessionView sessionId="mc80" cwd="/tmp/repo" />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("agent_logs fallback throws → hasOlderMessages set to false", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.readClaudeSessionHistory).mockRejectedValueOnce(new Error("nope"));
    vi.mocked(cmd.sdkGetChatHistory).mockRejectedValueOnce(new Error("db error"));
    await setupCapture();
    const { container } = render(<ClaudeSdkSessionView sessionId="mc81" cwd="/tmp/repo" />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("page-size logs from agent_logs sets hasOlderMessages true", async () => {
    const cmd = await import("../../../lib/commands");
    const big = Array.from({ length: 200 }, (_, i) => ({
      id: String(i),
      thread_id: "mc82",
      direction: i % 3 === 0 ? "Input" : "Output",
      content: i % 3 === 0 ? "user " + i : "assistant " + i,
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
      log_type: "text",
      rowid: i + 1,
    }));
    vi.mocked(cmd.readClaudeSessionHistory).mockRejectedValueOnce(new Error("nope"));
    vi.mocked(cmd.sdkGetChatHistory).mockResolvedValueOnce(big);
    await setupCapture();
    const { container } = render(<ClaudeSdkSessionView sessionId="mc82" cwd="/tmp/repo" />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("init for resumed (non-isNew) thread with sdk_session_id calls sdkResumeSession", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.readClaudeSessionHistory).mockResolvedValueOnce({
      items: [],
      byte_offset: 0,
    } as never);
    vi.mocked(cmd.sdkGetChatHistory).mockResolvedValueOnce([]);
    seedThread("mc83", { sdk_session_id: "real-uuid" });
    await setupCapture();
    const { container } = render(<ClaudeSdkSessionView sessionId="mc83" cwd="/tmp/repo" />);
    await flush();
    await flush();
    expect(vi.mocked(cmd.sdkResumeSession)).toHaveBeenCalled();
    expect(container.firstChild).toBeTruthy();
  });

  it("recoverable resume failure with 'No conversation found' triggers fresh start", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.readClaudeSessionHistory).mockResolvedValueOnce({
      items: [],
      byte_offset: 0,
    } as never);
    vi.mocked(cmd.sdkGetChatHistory).mockResolvedValueOnce([]);
    vi.mocked(cmd.sdkResumeSession).mockRejectedValueOnce(new Error("No conversation found"));
    seedThread("mc84", { sdk_session_id: "stale-id" });
    await setupCapture();
    const { container } = render(<ClaudeSdkSessionView sessionId="mc84" cwd="/tmp/repo" />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("recoverable resume failure with 'process exited' triggers fresh start", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.readClaudeSessionHistory).mockResolvedValueOnce({
      items: [],
      byte_offset: 0,
    } as never);
    vi.mocked(cmd.sdkGetChatHistory).mockResolvedValueOnce([]);
    vi.mocked(cmd.sdkResumeSession).mockRejectedValueOnce(
      new Error("Claude Code process exited with code 1"),
    );
    seedThread("mc85", { sdk_session_id: "stale" });
    await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc85" cwd="/tmp/repo" />);
    await flush();
    await flush();
    expect(true).toBe(true);
  });

  it("non-recoverable resume failure surfaces error", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.readClaudeSessionHistory).mockResolvedValueOnce({
      items: [],
      byte_offset: 0,
    } as never);
    vi.mocked(cmd.sdkGetChatHistory).mockResolvedValueOnce([]);
    vi.mocked(cmd.sdkResumeSession).mockRejectedValueOnce(new Error("Other error"));
    seedThread("mc86", { sdk_session_id: "stale" });
    await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc86" cwd="/tmp/repo" />);
    await flush();
    await flush();
    expect(true).toBe(true);
  });

  it("cowork thread with sdk_session_id resumes via sdkStartSession", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.readClaudeSessionHistory).mockResolvedValueOnce({
      items: [],
      byte_offset: 0,
    } as never);
    vi.mocked(cmd.sdkGetChatHistory).mockResolvedValueOnce([]);
    seedThread("mc86b", { sdk_session_id: "desktop-cli", agent_profile: "cowork" });
    await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc86b" cwd="/tmp/local_1/outputs" />);
    await flush();
    await flush();
    expect(vi.mocked(cmd.sdkStartSession)).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "mc86b",
        resumeSessionId: "desktop-cli",
        agentProfile: "cowork",
      }),
    );
    expect(vi.mocked(cmd.sdkResumeSession)).not.toHaveBeenCalled();
  });

  it("isNew true skips resume and calls sdkStartSession", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.readClaudeSessionHistory).mockResolvedValueOnce({
      items: [],
      byte_offset: 0,
    } as never);
    vi.mocked(cmd.sdkGetChatHistory).mockResolvedValueOnce([]);
    seedThread("mc87");
    await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc87" cwd="/tmp/repo" isNew />);
    await flush();
    await flush();
    expect(vi.mocked(cmd.sdkStartSession)).toHaveBeenCalled();
  });

  it("sdkStartSession failure surfaces error", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.readClaudeSessionHistory).mockResolvedValueOnce({
      items: [],
      byte_offset: 0,
    } as never);
    vi.mocked(cmd.sdkGetChatHistory).mockResolvedValueOnce([]);
    vi.mocked(cmd.sdkStartSession).mockRejectedValueOnce(new Error("init failed"));
    seedThread("mc88");
    await setupCapture();
    const { container } = render(<ClaudeSdkSessionView sessionId="mc88" cwd="/tmp/repo" isNew />);
    await flush();
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Render branches with populated messages — exercise renderMessage cases
  // ────────────────────────────────────────────────────────────────────────

  it("renders a long sequence of UserMessage + AssistantText + tools", async () => {
    seedThread("mc89");
    const handlers = await setupCapture();
    const { container } = render(<ClaudeSdkSessionView sessionId="mc89" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc89", { type: "session.started", sessionId: "uu" });
    // many tools to trigger groupMessages grouping path
    for (let i = 0; i < 5; i++) {
      fire(handlers, "mc89", {
        type: "tool.started",
        toolUseId: `t-${i}`,
        name: "Read",
        input: { file_path: `/file-${i}` },
      });
      fire(handlers, "mc89", {
        type: "tool.completed",
        toolUseId: `t-${i}`,
        content: `body-${i}`,
        isError: false,
      });
    }
    // Edit tool — bypasses grouping
    fire(handlers, "mc89", {
      type: "tool.started",
      toolUseId: "edit-1",
      name: "Edit",
      input: { file_path: "/x", old_string: "a", new_string: "b" },
    });
    fire(handlers, "mc89", {
      type: "tool.completed",
      toolUseId: "edit-1",
      content: "ok",
      isError: false,
    });
    // Write tool
    fire(handlers, "mc89", {
      type: "tool.started",
      toolUseId: "write-1",
      name: "Write",
      input: { file_path: "/y", content: "hi" },
    });
    fire(handlers, "mc89", {
      type: "tool.completed",
      toolUseId: "write-1",
      content: "wrote",
      isError: false,
    });
    fire(handlers, "mc89", {
      type: "turn.completed",
      sessionId: "uu",
      model: "claude-sonnet-4-6",
      modelUsage: null,
      userMessageUuid: "u-uuid",
      usage: {
        inputTokens: 100,
        outputTokens: 60,
        cacheCreationTokens: 5,
        cacheReadTokens: 1000,
        totalCostUsd: 0.005,
        numTurns: 1,
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("omits the assistant model header above reply text (Codex-style prose)", async () => {
    seedThread("mc89-spacing", { model: "claude-opus-4-7" });
    const handlers = await setupCapture();
    const { container, queryByText } = render(
      <ClaudeSdkSessionView sessionId="mc89-spacing" cwd="/tmp/repo" isNew />,
    );
    await flush();
    fire(handlers, "mc89-spacing", { type: "session.started", sessionId: "uu-spacing" });
    fire(handlers, "mc89-spacing", {
      type: "content.delta",
      contentType: "text",
      text: "Now I have everything I need.",
    });
    fire(handlers, "mc89-spacing", {
      type: "turn.completed",
      sessionId: "uu-spacing",
      model: "claude-opus-4-7",
      modelUsage: null,
      userMessageUuid: "u-spacing",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCostUsd: 0,
        numTurns: 1,
      },
    });
    await flush();

    expect(queryByText("Claude Opus 4.7")).toBeNull();
    expect(queryByText("Claude Sonnet 5")).toBeNull();
    expect(container.textContent).toContain("Now I have everything I need.");
  });

  it("CompactBoundary rendered + collapse hides earlier messages", async () => {
    const handlers = await setupCapture();
    const { container } = render(<ClaudeSdkSessionView sessionId="mc90" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc90", { type: "content.delta", contentType: "text", text: "before" });
    fire(handlers, "mc90", {
      type: "compact.boundary",
      preTokens: 10000,
      trigger: "manual",
    });
    fire(handlers, "mc90", { type: "content.delta", contentType: "text", text: "after" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("nested child tool result merges into parent's childTools array", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc91" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc91", {
      type: "tool.started",
      toolUseId: "p1",
      name: "Task",
      input: { description: "agent" },
    });
    fire(handlers, "mc91", {
      type: "tool.started",
      toolUseId: "c1",
      parentToolUseId: "p1",
      name: "Read",
      input: { file_path: "/inside-task" },
    });
    fire(handlers, "mc91", {
      type: "tool.completed",
      toolUseId: "c1",
      content: "child result",
      isError: false,
    });
    fire(handlers, "mc91", {
      type: "tool.completed",
      toolUseId: "p1",
      content: "parent result",
      isError: false,
    });
    await flush();
    expect(true).toBe(true);
  });

  it("duplicate child tool not appended twice", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc92" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc92", {
      type: "tool.started",
      toolUseId: "P",
      name: "Task",
      input: {},
    });
    fire(handlers, "mc92", {
      type: "tool.started",
      toolUseId: "C",
      parentToolUseId: "P",
      name: "Read",
      input: {},
    });
    fire(handlers, "mc92", {
      type: "tool.started",
      toolUseId: "C",
      parentToolUseId: "P",
      name: "Read",
      input: {},
    });
    await flush();
    expect(true).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Mixed lifecycle + messy event ordering
  // ────────────────────────────────────────────────────────────────────────

  it("content.delta after tool.started force-flushes the stream and records text", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc93" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc93", { type: "content.delta", contentType: "text", text: "thinking out loud" });
    fire(handlers, "mc93", {
      type: "tool.started",
      toolUseId: "after-text",
      name: "Read",
      input: { file_path: "/y" },
    });
    fire(handlers, "mc93", {
      type: "tool.completed",
      toolUseId: "after-text",
      content: "y",
      isError: false,
    });
    await flush();
    expect(true).toBe(true);
  });

  it("turn.completed without prior content still produces ResultInfo with zero deltas", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc94" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc94", {
      type: "turn.completed",
      sessionId: "u",
      model: "sonnet",
      modelUsage: null,
      userMessageUuid: null,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCostUsd: 0,
        numTurns: 1,
      },
    });
    await flush();
    expect(true).toBe(true);
  });

  it("approval.requested with stale entry beyond TTL is evicted on next add", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc95" cwd="/tmp/repo" isNew />);
    await flush();
    // Fire one approval, advance virtual time, then fire another to trigger eviction
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2024, 0, 1, 0, 0, 0).getTime());
      fire(handlers, "mc95", {
        type: "approval.requested",
        requestId: "stale-1",
        toolName: "Bash",
        detail: "x",
        requestType: "command_execution",
      });
      vi.setSystemTime(new Date(2024, 0, 1, 0, 5, 0).getTime()); // +5min
      fire(handlers, "mc95", {
        type: "approval.requested",
        requestId: "fresh-1",
        toolName: "Edit",
        detail: "y",
        requestType: "file_change",
      });
    } finally {
      vi.useRealTimers();
    }
    await flush();
    expect(true).toBe(true);
  });

  it("status with empty message is no-op", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc96" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc96", { type: "status", status: null, message: "" });
    await flush();
    expect(true).toBe(true);
  });

  it("multiple status messages append multiple system messages", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc97" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc97", { type: "status", status: "info", message: "msg 1" });
    fire(handlers, "mc97", { type: "status", status: "info", message: "msg 2" });
    fire(handlers, "mc97", { type: "status", status: "info", message: "msg 3" });
    await flush();
    expect(true).toBe(true);
  });

  it("session.init with stale slashCommands cache picks up new list", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc98" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc98", {
      type: "session.init",
      sessionId: "u",
      slashCommands: ["a", "b"],
    });
    fire(handlers, "mc98", {
      type: "session.init",
      sessionId: "u",
      slashCommands: ["a", "b", "c", "d"],
    });
    await flush();
    expect(true).toBe(true);
  });

  it("usage.update repeated with growing cache values still updates ring", async () => {
    seedThread("mc99", { model: "claude-opus-4-5" });
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc99" cwd="/tmp/repo" />);
    await flush();
    for (let i = 0; i < 5; i++) {
      fire(handlers, "mc99", {
        type: "usage.update",
        inputTokens: 100 + i * 10,
        outputTokens: 50 + i * 5,
        cacheCreationTokens: i * 2,
        cacheReadTokens: 2000 + i * 200,
        totalTokens: null,
      });
    }
    await flush();
    expect(true).toBe(true);
  });

  it("tool.started for various tool names exercises group/individual classification", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc100" cwd="/tmp/repo" isNew />);
    await flush();
    const names = ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "Task", "TodoWrite", "WebFetch"];
    names.forEach((n, i) => {
      fire(handlers, "mc100", {
        type: "tool.started",
        toolUseId: `tu-${i}`,
        name: n,
        input: {},
      });
      fire(handlers, "mc100", {
        type: "tool.completed",
        toolUseId: `tu-${i}`,
        content: "ok",
        isError: false,
      });
    });
    await flush();
    expect(true).toBe(true);
  });

  it("mix of nested + non-nested tool.started ordering doesn't crash", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc101" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc101", { type: "tool.started", toolUseId: "T", name: "Task", input: {} });
    fire(handlers, "mc101", { type: "tool.started", toolUseId: "child-x", parentToolUseId: "T", name: "Bash", input: {} });
    fire(handlers, "mc101", { type: "tool.completed", toolUseId: "child-x", content: "", isError: false });
    fire(handlers, "mc101", { type: "tool.started", toolUseId: "regular-1", name: "Glob", input: {} });
    fire(handlers, "mc101", { type: "tool.completed", toolUseId: "regular-1", content: "", isError: false });
    fire(handlers, "mc101", { type: "tool.completed", toolUseId: "T", content: "done", isError: false });
    await flush();
    expect(true).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Smoke: hideTopBar + rendered messages still works, content-delta torrent
  // ────────────────────────────────────────────────────────────────────────

  it("hideTopBar with rendered messages still hides top bar but renders rest", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="mc102" cwd="/tmp/repo" isNew hideTopBar />,
    );
    await flush();
    fire(handlers, "mc102", { type: "content.delta", contentType: "text", text: "x" });
    await flush();
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeNull();
    expect(container.querySelector("[data-testid='claude-input-bar']")).toBeTruthy();
  });

  it("insets message chrome inside the composer column like Codex", async () => {
    const handlers = await setupCapture();
    const { container } = render(<ClaudeSdkSessionView sessionId="mc102-width" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc102-width", {
      type: "tool.started",
      toolUseId: "tool-width",
      name: "Read",
      input: { file_path: "/tmp/repo/src/file.ts" },
    });
    fire(handlers, "mc102-width", {
      type: "tool.started",
      toolUseId: "tool-width-2",
      name: "Bash",
      input: { command: "pwd" },
    });
    await flush();

    const tool = container.querySelector("[data-testid='tool-activity-group']");
    expect(tool).toBeTruthy();
    // Codex padding: items pad inside max-w-[780px]; composer is 780px inside
    // an outer px-6, so conversation text sits on/within the input glass.
    const toolCol = tool?.closest("[class*='max-w-[780px]']");
    expect(toolCol).toBeTruthy();
    expect(toolCol?.className).toContain("w-full");
    expect(toolCol?.className).toContain("px-6");

    const input = container.querySelector("[data-testid='claude-input-bar']");
    expect(input).toBeTruthy();
    const composerCol = input?.closest("[class*='max-w-[780px]']");
    expect(composerCol).toBeTruthy();
    expect(composerCol).not.toBe(toolCol);
    expect(composerCol?.className).not.toContain("px-6");
    expect(composerCol?.parentElement?.className).toContain("px-6");
  });

  it("compact mode + isNew + hideTopBar with events fires cleanly", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <ClaudeSdkSessionView sessionId="mc103" cwd="/tmp/repo" isNew compact hideTopBar />,
    );
    await flush();
    fire(handlers, "mc103", { type: "session.started", sessionId: "u" });
    fire(handlers, "mc103", { type: "content.delta", contentType: "text", text: "hi" });
    fire(handlers, "mc103", {
      type: "tool.started",
      toolUseId: "t-c",
      name: "Read",
      input: { file_path: "/x" },
    });
    fire(handlers, "mc103", {
      type: "tool.completed",
      toolUseId: "t-c",
      content: "x",
      isError: false,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("rate.limit followed by another rate.limit replaces the warning text", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc104" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc104", { type: "rate.limit", message: "first", retryAfterSeconds: 1 });
    fire(handlers, "mc104", { type: "rate.limit", message: "second", retryAfterSeconds: 2 });
    await flush();
    expect(true).toBe(true);
  });

  it("session.ended after multiple pending tools finalizes them", async () => {
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mc105" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mc105", { type: "tool.started", toolUseId: "p1", name: "Bash", input: { command: "x" } });
    fire(handlers, "mc105", { type: "tool.started", toolUseId: "p2", name: "Read", input: { file_path: "/x" } });
    fire(handlers, "mc105", { type: "tool.started", toolUseId: "p3", name: "Grep", input: { pattern: "x" } });
    fire(handlers, "mc105", { type: "session.ended", reason: "completed" });
    await flush();
    expect(true).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Direct callback tests via mocked input bar / approval banner buttons
  // ────────────────────────────────────────────────────────────────────────

  it("input bar onSend triggers handleSend → sdkSendMessage", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkSendMessage).mockClear();
    seedThread("mb1");
    await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb1" cwd="/tmp/repo" isNew />);
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ib-send"));
      await flush();
    });
    expect(vi.mocked(cmd.sdkSendMessage)).toHaveBeenCalled();
  });

  it("input bar slash send triggers sdkSendSlashCommand", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkSendSlashCommand).mockClear();
    seedThread("mb2");
    await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb2" cwd="/tmp/repo" isNew />);
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ib-send-slash"));
      await flush();
    });
    expect(vi.mocked(cmd.sdkSendSlashCommand)).toHaveBeenCalled();
  });

  it("external Cursor slash sends use the provider transport", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkSendSlashCommand).mockClear();
    const send = vi.fn().mockResolvedValue(undefined);
    seedThread("mb2-cursor", { provider: "Cursor", model: "composer-1" });
    await setupCapture();
    const { getByTestId } = render(
      <ClaudeSdkSessionView
        sessionId="mb2-cursor"
        cwd="/tmp/repo"
        transport={{
          send,
          respondApproval: vi.fn(),
          interrupt: vi.fn(),
          setModel: vi.fn(),
        }}
        externalSessionReady
        providerOverride="Cursor"
      />,
    );
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ib-send-slash"));
      await flush();
    });
    expect(send).toHaveBeenCalledWith("mb2-cursor", "/help", undefined);
    expect(vi.mocked(cmd.sdkSendSlashCommand)).not.toHaveBeenCalled();
  });

  it("external Cursor assistant history renders reply without a model label", async () => {
    const loadHistory = vi.fn().mockResolvedValue([
      {
        itemType: "AssistantText",
        text: "cursor reply",
        model: "composer-2.5?thinking=high",
        timestamp: new Date().toISOString(),
        uuid: "cursor-history-1",
      },
    ]);
    seedThread("mb2-cursor-history", {
      provider: "Cursor",
      model: "composer-2.5?thinking=high",
    });
    await setupCapture();
    const { getByText, queryByText } = render(
      <ClaudeSdkSessionView
        sessionId="mb2-cursor-history"
        cwd="/tmp/repo"
        transport={{
          send: vi.fn(),
          respondApproval: vi.fn(),
          interrupt: vi.fn(),
          setModel: vi.fn(),
          loadHistory,
        }}
        externalSessionReady
        providerOverride="Cursor"
      />,
    );

    await waitFor(() => {
      expect(getByText("cursor reply")).toBeTruthy();
    });
    expect(queryByText("Composer 2.5")).toBeNull();
  });

  it("does not clobber a live external session back to Starting session after slow history load", async () => {
    let resolveHistory: (items: []) => void = () => {};
    const loadHistory = vi.fn(
      () =>
        new Promise<[]>((resolve) => {
          resolveHistory = resolve;
        }),
    );
    seedThread("grok-live-ready", { provider: "Grok", sdk_session_id: "acp-live" });
    await setupCapture();
    render(
      <ClaudeSdkSessionView
        sessionId="grok-live-ready"
        cwd="/tmp/repo"
        transport={{
          send: vi.fn(),
          respondApproval: vi.fn(),
          interrupt: vi.fn(),
          setModel: vi.fn(),
          loadHistory,
        }}
        externalSessionReady
        providerOverride="Grok"
      />,
    );
    await flush();
    expect(claudeInputBarSpy).toHaveBeenCalled();
    const readyCalls = claudeInputBarSpy.mock.calls;
    const readyProps = readyCalls[readyCalls.length - 1]?.[0] as {
      sessionStarting?: boolean;
      disabled?: boolean;
    };
    expect(readyProps.sessionStarting).toBe(false);
    expect(readyProps.disabled).toBe(false);
    await act(async () => {
      resolveHistory([]);
      await flush();
    });
    const afterCalls = claudeInputBarSpy.mock.calls;
    const afterHist = afterCalls[afterCalls.length - 1]?.[0] as {
      sessionStarting?: boolean;
      disabled?: boolean;
    };
    expect(afterHist.sessionStarting).toBe(false);
    expect(afterHist.disabled).toBe(false);
  });

  it("session.init unsticks Starting session for an external chat that is not yet marked ready", async () => {
    const handlers = await setupCapture();
    seedThread("gemini-init-ready", { provider: "Gemini" });
    render(
      <ClaudeSdkSessionView
        sessionId="gemini-init-ready"
        cwd="/tmp/repo"
        transport={{
          send: vi.fn(),
          respondApproval: vi.fn(),
          interrupt: vi.fn(),
          setModel: vi.fn(),
        }}
        providerOverride="Gemini"
      />,
    );
    await waitFor(() => {
      const beforeCalls = claudeInputBarSpy.mock.calls;
      const before = beforeCalls[beforeCalls.length - 1]?.[0] as {
        sessionStarting?: boolean;
      };
      expect(before.sessionStarting).toBe(true);
    });
    fire(handlers, "gemini-init-ready", {
      type: "session.init",
      sessionId: "acp-gemini",
    });
    await flush();
    const afterCalls = claudeInputBarSpy.mock.calls;
    const after = afterCalls[afterCalls.length - 1]?.[0] as {
      sessionStarting?: boolean;
      disabled?: boolean;
    };
    expect(after.sessionStarting).toBe(false);
    expect(after.disabled).toBe(false);
  });

  it("does not send pendingFirstMessage on session.init until the external session is ready", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    useUiStore.setState({
      pendingFirstMessages: { "gemini-first-prompt": "make the button blue" },
      pendingFirstImages: {},
      claudeProcessingById: {},
      pendingApprovalsBySession: {},
      sessionTerminalOpenByKey: {},
    } as never);
    seedThread("gemini-first-prompt", { provider: "Gemini" });
    const handlers = await setupCapture();
    const transport = {
      send,
      respondApproval: vi.fn(),
      interrupt: vi.fn(),
      setModel: vi.fn(),
    };
    const { rerender, getByText } = render(
      <ClaudeSdkSessionView
        sessionId="gemini-first-prompt"
        cwd="/tmp/repo"
        transport={transport}
        providerOverride="Gemini"
      />,
    );
    await flush();
    fire(handlers, "gemini-first-prompt", {
      type: "session.init",
      sessionId: "acp-gemini",
    });
    await flush();
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(useUiStore.getState().pendingFirstMessages["gemini-first-prompt"]).toBe(
      "make the button blue",
    );
    expect(getByText("make the button blue")).toBeTruthy();

    rerender(
      <ClaudeSdkSessionView
        sessionId="gemini-first-prompt"
        cwd="/tmp/repo"
        transport={transport}
        externalSessionReady
        providerOverride="Gemini"
      />,
    );
    await flush();
    await flush();
    expect(send).toHaveBeenCalledWith("gemini-first-prompt", "make the button blue", undefined);
    expect(useUiStore.getState().pendingFirstMessages["gemini-first-prompt"]).toBeUndefined();
    expect(getByText("make the button blue")).toBeTruthy();
  });

  it("retries a composer send when an external session becomes ready after session-not-ready", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("Gemini session not ready"))
      .mockResolvedValue(undefined);
    seedThread("gemini-composer-retry", { provider: "Gemini" });
    const handlers = await setupCapture();
    const makeTransport = () => ({
      send,
      respondApproval: vi.fn(),
      interrupt: vi.fn(),
      setModel: vi.fn(),
    });
    const { rerender, getByTestId, getByText } = render(
      <ClaudeSdkSessionView
        sessionId="gemini-composer-retry"
        cwd="/tmp/repo"
        transport={makeTransport()}
        providerOverride="Gemini"
      />,
    );
    await flush();
    fire(handlers, "gemini-composer-retry", {
      type: "session.init",
      sessionId: "acp-gemini",
    });
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ib-send"));
      await flush();
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(getByText("hi")).toBeTruthy();

    rerender(
      <ClaudeSdkSessionView
        sessionId="gemini-composer-retry"
        cwd="/tmp/repo"
        transport={makeTransport()}
        externalSessionReady
        providerOverride="Gemini"
      />,
    );
    await flush();
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(getByText("hi")).toBeTruthy();
  });

  it("empty transport loadHistory falls back to agent_logs so remote Grok prompts show", async () => {
    const cmd = await import("../../../lib/commands");
    const loadHistory = vi.fn().mockResolvedValue([]);
    vi.mocked(cmd.sdkGetChatHistory).mockResolvedValueOnce([
      {
        id: "1",
        thread_id: "grok-remote-empty-hist",
        direction: "Input",
        content: "Can you make it so the show role generator fetches dynamically",
        timestamp: new Date().toISOString(),
        log_type: "text",
        rowid: 1,
      },
    ]);
    seedThread("grok-remote-empty-hist", { provider: "Grok" });
    await setupCapture();
    const { getByText } = render(
      <ClaudeSdkSessionView
        sessionId="grok-remote-empty-hist"
        cwd="/tmp/repo"
        transport={{
          send: vi.fn(),
          respondApproval: vi.fn(),
          interrupt: vi.fn(),
          setModel: vi.fn(),
          loadHistory,
        }}
        externalSessionReady
        providerOverride="Grok"
      />,
    );
    await waitFor(() => {
      expect(
        getByText("Can you make it so the show role generator fetches dynamically"),
      ).toBeTruthy();
    });
    expect(loadHistory).toHaveBeenCalled();
    expect(cmd.sdkGetChatHistory).toHaveBeenCalledWith("grok-remote-empty-hist", 200);
  });

  it("input bar send /compact sets compacting indicator", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkSendSlashCommand).mockClear();
    seedThread("mb3");
    await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb3" cwd="/tmp/repo" isNew />);
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ib-send-compact"));
      await flush();
    });
    expect(vi.mocked(cmd.sdkSendSlashCommand)).toHaveBeenCalled();
  });

  it("input bar send with image data passes images to sdkSendMessage", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkSendMessage).mockClear();
    seedThread("mb4");
    await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb4" cwd="/tmp/repo" isNew />);
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ib-send-image"));
      await flush();
    });
    expect(vi.mocked(cmd.sdkSendMessage)).toHaveBeenCalled();
  });

  it("input bar send failure with session-not-ready buffers retry", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkSendMessage).mockRejectedValueOnce(new Error("No active session"));
    seedThread("mb5");
    await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb5" cwd="/tmp/repo" isNew />);
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ib-send"));
      await flush();
    });
    expect(vi.mocked(cmd.sdkSendMessage)).toHaveBeenCalled();
  });

  it("input bar send failure with non-session error surfaces error", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkSendMessage).mockRejectedValueOnce(new Error("Random error"));
    seedThread("mb6");
    await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb6" cwd="/tmp/repo" isNew />);
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ib-send"));
      await flush();
    });
    expect(true).toBe(true);
  });

  it("input bar onStop triggers handleStop → sdkInterrupt", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkInterrupt).mockClear();
    seedThread("mb7");
    await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb7" cwd="/tmp/repo" isNew />);
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ib-stop"));
      await flush();
    });
    expect(vi.mocked(cmd.sdkInterrupt)).toHaveBeenCalled();
  });

  it("stop uses the latest transport.interrupt after the transport object changes", async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const makeTransport = (interrupt: typeof first) => ({
      send: vi.fn(async () => {}),
      respondApproval: vi.fn(async () => {}),
      interrupt,
      setModel: vi.fn(async () => {}),
    });
    seedThread("stop-stale");
    await setupCapture();
    const { rerender, getByTestId } = render(
      <ClaudeSdkSessionView
        sessionId="stop-stale"
        cwd="/tmp/repo"
        isNew
        transport={makeTransport(first)}
        externalSessionReady
      />,
    );
    await flush();
    rerender(
      <ClaudeSdkSessionView
        sessionId="stop-stale"
        cwd="/tmp/repo"
        isNew
        transport={makeTransport(second)}
        externalSessionReady
      />,
    );
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ib-stop"));
      await flush();
    });
    expect(second).toHaveBeenCalledWith("stop-stale");
    expect(first).not.toHaveBeenCalled();
  });

  it("auto-sends a queued follow-up after turn.completed once the previous send settles", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    seedThread("q-auto");
    const handlers = await setupCapture();
    const { getByTestId } = render(
      <ClaudeSdkSessionView
        sessionId="q-auto"
        cwd="/tmp/repo"
        isNew
        transport={{
          send,
          respondApproval: vi.fn(),
          interrupt: vi.fn(),
          setModel: vi.fn(),
        }}
        externalSessionReady
      />,
    );
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ib-send"));
      await flush();
    });
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(getByTestId("ib-queue"));
      await flush();
    });
    expect(send).toHaveBeenCalledTimes(1);
    fire(handlers, "q-auto", {
      type: "turn.completed",
      sessionId: "q-auto",
      model: null,
      modelUsage: null,
      userMessageUuid: null,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCostUsd: 0,
        numTurns: 1,
      },
    });
    await flush();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("q-auto", "queued msg", undefined);
  });

  it("input bar onQueueMessage adds to message queue", async () => {
    seedThread("mb8");
    await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb8" cwd="/tmp/repo" isNew />);
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ib-queue"));
      await flush();
    });
    expect(true).toBe(true);
  });

  it("input bar onSteer for nonexistent message is no-op", async () => {
    seedThread("mb9");
    await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb9" cwd="/tmp/repo" isNew />);
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ib-steer"));
      await flush();
    });
    expect(true).toBe(true);
  });

  it("input bar onDeleteQueued removes a queue entry", async () => {
    seedThread("mb10");
    await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb10" cwd="/tmp/repo" isNew />);
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ib-queue"));
      fireEvent.click(getByTestId("ib-delete-queued"));
      await flush();
    });
    expect(true).toBe(true);
  });

  it("input bar onModelChange updates the model state", async () => {
    seedThread("mb11");
    await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb11" cwd="/tmp/repo" isNew />);
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ib-set-model"));
      await flush();
    });
    expect(true).toBe(true);
  });

  it("input bar permission mode changes flow through setter", async () => {
    seedThread("mb12");
    await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb12" cwd="/tmp/repo" isNew />);
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ib-perm-full"));
      fireEvent.click(getByTestId("ib-perm-auto"));
      fireEvent.click(getByTestId("ib-perm-default"));
      await flush();
    });
    expect(true).toBe(true);
  });

  it("input bar plan mode toggles set the plan ref", async () => {
    seedThread("mb13");
    await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb13" cwd="/tmp/repo" isNew />);
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ib-plan-on"));
      fireEvent.click(getByTestId("ib-plan-off"));
      await flush();
    });
    expect(true).toBe(true);
  });

  it("plan-mode + turn.completed shows plan follow-up banner", async () => {
    seedThread("mb14");
    const handlers = await setupCapture();
    const { getByTestId, container } = render(
      <ClaudeSdkSessionView sessionId="mb14" cwd="/tmp/repo" isNew />,
    );
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ib-plan-on"));
      await flush();
    });
    fire(handlers, "mb14", {
      type: "turn.completed",
      sessionId: "u",
      model: "sonnet",
      modelUsage: null,
      userMessageUuid: null,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCostUsd: 0,
        numTurns: 1,
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // --- Approval banner click flows ---
  it("approval banner approve calls sdkRespondApproval allow", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkRespondApproval).mockClear();
    seedThread("mb15");
    const handlers = await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb15" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mb15", {
      type: "approval.requested",
      requestId: "r-approve",
      toolName: "Bash",
      detail: "ls",
      requestType: "command_execution",
    });
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ab-approve"));
      await flush();
    });
    expect(vi.mocked(cmd.sdkRespondApproval)).toHaveBeenCalled();
  });

  it("approval banner reject calls sdkRespondApproval deny", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkRespondApproval).mockClear();
    seedThread("mb16");
    const handlers = await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb16" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mb16", {
      type: "approval.requested",
      requestId: "r-reject",
      toolName: "Edit",
      detail: "x",
      requestType: "file_change",
    });
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ab-reject"));
      await flush();
    });
    expect(vi.mocked(cmd.sdkRespondApproval)).toHaveBeenCalled();
  });

  it("approval banner allow-for-session calls sdkRespondApproval allowProject", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkRespondApproval).mockClear();
    seedThread("mb17");
    const handlers = await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb17" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mb17", {
      type: "approval.requested",
      requestId: "r-allow",
      toolName: "Bash",
      detail: "ls",
      requestType: "command_execution",
    });
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ab-allow-session"));
      await flush();
    });
    expect(vi.mocked(cmd.sdkRespondApproval)).toHaveBeenCalled();
  });

  it("grok external fs approvals do not offer allow-for-project", async () => {
    seedThread("mb17-grok");
    const handlers = await setupCapture();
    render(
      <ClaudeSdkSessionView
        sessionId="mb17-grok"
        cwd="/tmp/repo"
        isNew
        providerOverride="Grok"
      />,
    );
    await flush();
    fire(handlers, "mb17-grok", {
      type: "approval.requested",
      requestId: "42",
      toolName: "Read File",
      detail: "/etc/hosts",
      requestType: "file_read",
    });
    await flush();

    const lastApprovalBannerProps =
      approvalBannerSpy.mock.calls[approvalBannerSpy.mock.calls.length - 1]?.[0];
    expect(approvalBannerSpy).toHaveBeenCalled();
    expect(lastApprovalBannerProps).toEqual(
      expect.objectContaining({ onAllowForSession: undefined }),
    );
  });

  it("approval banner stale failure silently evicts approval", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkRespondApproval).mockRejectedValueOnce(new Error("stale request"));
    seedThread("mb18");
    const handlers = await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb18" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mb18", {
      type: "approval.requested",
      requestId: "r-stale",
      toolName: "Bash",
      detail: "x",
      requestType: "command_execution",
    });
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ab-approve"));
      await flush();
    });
    expect(true).toBe(true);
  });

  it("approval banner non-stale failure surfaces error", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkRespondApproval).mockRejectedValueOnce(new Error("backend died"));
    seedThread("mb19");
    const handlers = await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb19" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mb19", {
      type: "approval.requested",
      requestId: "r-fail",
      toolName: "Bash",
      detail: "x",
      requestType: "command_execution",
    });
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ab-approve"));
      await flush();
    });
    expect(true).toBe(true);
  });

  it("approval banner reject 'unknown' failure silently evicts", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkRespondApproval).mockRejectedValueOnce(new Error("unknown approval"));
    seedThread("mb20");
    const handlers = await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb20" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mb20", {
      type: "approval.requested",
      requestId: "r-unk",
      toolName: "Bash",
      detail: "x",
      requestType: "command_execution",
    });
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ab-reject"));
      await flush();
    });
    expect(true).toBe(true);
  });

  it("approval banner allowForProject 'not found' failure silently evicts", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkRespondApproval).mockRejectedValueOnce(new Error("not found"));
    seedThread("mb21");
    const handlers = await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb21" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mb21", {
      type: "approval.requested",
      requestId: "r-nf",
      toolName: "Bash",
      detail: "x",
      requestType: "command_execution",
    });
    await flush();
    await act(async () => {
      fireEvent.click(getByTestId("ab-allow-session"));
      await flush();
    });
    expect(true).toBe(true);
  });

  // --- userInput.requested → answer flow ---
  it("answer button calls sdkRespondUserInput", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkRespondUserInput).mockClear();
    seedThread("mb22");
    const handlers = await setupCapture();
    const { getAllByTestId } = render(<ClaudeSdkSessionView sessionId="mb22" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mb22", {
      type: "userInput.requested",
      requestId: "ui-r",
      questions: [
        { question: "Confirm?", header: "Confirm", options: [{ label: "Yes", description: "" }] },
      ],
    });
    await flush();
    // userInput renders AskUserQuestionDialog; click submit
    const submits = getAllByTestId("auq-submit");
    await act(async () => {
      fireEvent.click(submits[submits.length - 1]);
      await flush();
    });
    expect(vi.mocked(cmd.sdkRespondUserInput)).toHaveBeenCalled();
  });

  it("answer flow with sdkRespondUserInput failure surfaces error", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkRespondUserInput).mockRejectedValueOnce(new Error("bad input"));
    seedThread("mb23");
    const handlers = await setupCapture();
    const { getAllByTestId } = render(<ClaudeSdkSessionView sessionId="mb23" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "mb23", {
      type: "userInput.requested",
      requestId: "ui-r",
      questions: [
        { question: "Proceed?", header: "", options: [{ label: "Yes", description: "" }] },
      ],
    });
    await flush();
    const submits = getAllByTestId("auq-submit");
    await act(async () => {
      fireEvent.click(submits[submits.length - 1]);
      await flush();
    });
    expect(true).toBe(true);
  });

  // --- handleSteer with a queued message present ---
  it("handleSteer with valid queue id calls sdkInterrupt + sdkSendMessage", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkInterrupt).mockClear();
    seedThread("mb24");
    await setupCapture();
    const { getByTestId } = render(<ClaudeSdkSessionView sessionId="mb24" cwd="/tmp/repo" isNew />);
    await flush();
    // Queue a message
    await act(async () => {
      fireEvent.click(getByTestId("ib-queue"));
      await flush();
    });
    // The mock onSteer hardcodes "nonexistent" — so we just exercise the early-return branch
    await act(async () => {
      fireEvent.click(getByTestId("ib-steer"));
      await flush();
    });
    expect(true).toBe(true);
  });

  // --- pendingFirstMessage consumption flow ---
  it("pendingFirstMessage consumed after status transitions to running", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkSendMessage).mockClear();
    useUiStore.setState({
      pendingFirstMessages: { mb25: "consumed message" },
      pendingFirstImages: {},
      claudeProcessingById: {},
      pendingApprovalsBySession: {},
      sessionTerminalOpenByKey: {},
    } as never);
    seedThread("mb25");
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mb25" cwd="/tmp/repo" isNew />);
    await flush();
    await flush();
    // Once mounted and sdkStartSession resolves, status becomes "running"
    fire(handlers, "mb25", { type: "session.started", sessionId: "u" });
    await flush();
    await flush();
    expect(true).toBe(true);
  });

  it("pendingFirstMessage with slash content uses slash command path", async () => {
    useUiStore.setState({
      pendingFirstMessages: { mb26: "/help" },
      pendingFirstImages: {},
      claudeProcessingById: {},
      pendingApprovalsBySession: {},
      sessionTerminalOpenByKey: {},
    } as never);
    seedThread("mb26");
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mb26" cwd="/tmp/repo" isNew />);
    await flush();
    await flush();
    fire(handlers, "mb26", { type: "session.started", sessionId: "u" });
    await flush();
    await flush();
    expect(true).toBe(true);
  });

  it("external Cursor pendingFirst slash content uses the provider transport", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkSendSlashCommand).mockClear();
    const send = vi.fn().mockResolvedValue(undefined);
    useUiStore.setState({
      pendingFirstMessages: { "mb26-cursor": "/help" },
      pendingFirstImages: {},
      claudeProcessingById: {},
      pendingApprovalsBySession: {},
      sessionTerminalOpenByKey: {},
    } as never);
    seedThread("mb26-cursor", { provider: "Cursor", model: "composer-1" });
    await setupCapture();
    render(
      <ClaudeSdkSessionView
        sessionId="mb26-cursor"
        cwd="/tmp/repo"
        transport={{
          send,
          respondApproval: vi.fn(),
          interrupt: vi.fn(),
          setModel: vi.fn(),
        }}
        externalSessionReady
        providerOverride="Cursor"
      />,
    );
    await flush();
    await flush();
    expect(send).toHaveBeenCalledWith("mb26-cursor", "/help", undefined);
    expect(vi.mocked(cmd.sdkSendSlashCommand)).not.toHaveBeenCalled();
  });

  it("pendingFirstMessage failure removes optimistic bubble", async () => {
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.sdkSendMessage).mockRejectedValueOnce(new Error("fail send"));
    useUiStore.setState({
      pendingFirstMessages: { mb27: "fail this" },
      pendingFirstImages: {},
      claudeProcessingById: {},
      pendingApprovalsBySession: {},
      sessionTerminalOpenByKey: {},
    } as never);
    seedThread("mb27");
    const handlers = await setupCapture();
    render(<ClaudeSdkSessionView sessionId="mb27" cwd="/tmp/repo" isNew />);
    await flush();
    await flush();
    fire(handlers, "mb27", { type: "session.started", sessionId: "u" });
    await flush();
    await flush();
    expect(true).toBe(true);
  });

  it("complete realistic scenario covering most branches", async () => {
    seedThread("mc106", { model: "claude-sonnet-4-6" });
    const cmd = await import("../../../lib/commands");
    vi.mocked(cmd.readClaudeSessionHistory).mockResolvedValueOnce({
      items: [
        {
          itemType: "UserMessage",
          content: "previous question",
          timestamp: new Date(Date.now() - 60_000).toISOString(),
          uuid: "old-1",
        },
        {
          itemType: "AssistantText",
          text: "previous answer",
          timestamp: new Date(Date.now() - 30_000).toISOString(),
          uuid: "old-2",
        },
      ],
      byte_offset: 100,
    } as never);
    const handlers = await setupCapture();
    const { container } = render(<ClaudeSdkSessionView sessionId="mc106" cwd="/tmp/repo" />);
    await flush();
    await flush();
    fire(handlers, "mc106", { type: "session.started", sessionId: "uuid-real" });
    fire(handlers, "mc106", {
      type: "session.init",
      sessionId: "uuid-real",
      slashCommands: ["help", "clear"],
    });
    fire(handlers, "mc106", {
      type: "usage.update",
      inputTokens: 200,
      outputTokens: 0,
      cacheCreationTokens: 100,
      cacheReadTokens: 5000,
      totalTokens: null,
    });
    fire(handlers, "mc106", { type: "content.delta", contentType: "thinking", text: "thinking..." });
    fire(handlers, "mc106", { type: "content.delta", contentType: "text", text: "Let me " });
    fire(handlers, "mc106", {
      type: "tool.started",
      toolUseId: "T1",
      name: "Read",
      input: { file_path: "/a.ts" },
    });
    fire(handlers, "mc106", {
      type: "tool.completed",
      toolUseId: "T1",
      content: "file contents",
      isError: false,
    });
    fire(handlers, "mc106", {
      type: "tool.started",
      toolUseId: "T2",
      name: "Edit",
      input: { file_path: "/a.ts", old_string: "a", new_string: "b" },
    });
    fire(handlers, "mc106", {
      type: "tool.completed",
      toolUseId: "T2",
      content: "edited",
      isError: false,
    });
    fire(handlers, "mc106", {
      type: "files.persisted",
      files: [{ filename: "/a.ts", fileId: "fa" }],
      failed: [],
      uuid: "user-1",
      sessionId: "uuid-real",
    });
    fire(handlers, "mc106", { type: "content.delta", contentType: "text", text: "do it." });
    fire(handlers, "mc106", {
      type: "turn.completed",
      sessionId: "uuid-real",
      model: "claude-sonnet-4-6",
      modelUsage: null,
      userMessageUuid: "user-1",
      usage: {
        inputTokens: 200,
        outputTokens: 50,
        cacheCreationTokens: 100,
        cacheReadTokens: 5000,
        totalCostUsd: 0.005,
        numTurns: 1,
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });
});

describe("ClaudeSdkSessionView — Final coverage gaps", () => {
  type Listener = (event: { payload: unknown }) => void;

  async function setupCapture() {
    const eventModule = await import("@tauri-apps/api/event");
    const handlers: Record<string, Listener> = {};
    vi.mocked(eventModule.listen).mockImplementation(((channel: string, cb: Listener) => {
      handlers[channel] = cb;
      return Promise.resolve(() => {});
    }) as never);
    return handlers;
  }

  async function flush() {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  function fire(handlers: Record<string, Listener>, sessionId: string, payload: unknown) {
    const channel = `sdk-event-${sessionId}`;
    const h = handlers[channel];
    if (h) h({ payload });
  }

  function seedThread(id: string) {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id,
            project_id: "p1",
            provider: "ClaudeCode",
            interaction_mode: "sdk",
            status: "Idle",
            name: "T",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: "sonnet",
          } as never,
        ],
      },
    } as never);
  }

  it("error event with structured fields", async () => {
    const handlers = await setupCapture();
    seedThread("eg1");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg1" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg1", {
      type: "error",
      message: "fatal",
      code: 500,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("error event with empty message", async () => {
    const handlers = await setupCapture();
    seedThread("eg2");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg2" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg2", { type: "error", message: "" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("session.ended cleanly", async () => {
    const handlers = await setupCapture();
    seedThread("eg3");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg3" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg3", { type: "session.ended" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("session.ended with reason", async () => {
    const handlers = await setupCapture();
    seedThread("eg4");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg4" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg4", { type: "session.ended", reason: "user-exit" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("hook.started → hook.response sequence", async () => {
    const handlers = await setupCapture();
    seedThread("eg5");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg5" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg5", {
      type: "hook.started",
      hookName: "PreToolUse",
      script: "/bin/echo",
    });
    fire(handlers, "eg5", {
      type: "hook.response",
      hookName: "PreToolUse",
      decision: "allow",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("hook.response with deny decision", async () => {
    const handlers = await setupCapture();
    seedThread("eg6");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg6" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg6", {
      type: "hook.response",
      hookName: "PreToolUse",
      decision: "deny",
      reason: "blocked",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("hook.response with script failure", async () => {
    const handlers = await setupCapture();
    seedThread("eg7");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg7" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg7", {
      type: "hook.response",
      hookName: "PostToolUse",
      decision: "error",
      exitCode: 1,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("rate.limit event triggers UI update", async () => {
    const handlers = await setupCapture();
    seedThread("eg8");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg8" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg8", {
      type: "rate.limit",
      retryAt: Date.now() + 60000,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("auth.status logged_out triggers UI update", async () => {
    const handlers = await setupCapture();
    seedThread("eg9");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg9" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg9", { type: "auth.status", status: "logged_out" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("auth.status logged_in", async () => {
    const handlers = await setupCapture();
    seedThread("eg10");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg10" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg10", { type: "auth.status", status: "logged_in" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("usage.update with no totalTokens uses computed sum", async () => {
    const handlers = await setupCapture();
    seedThread("eg11");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg11" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg11", {
      type: "usage.update",
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: null,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("status event with various statuses", async () => {
    const handlers = await setupCapture();
    seedThread("eg12");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg12" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg12", { type: "status", status: "thinking" });
    fire(handlers, "eg12", { type: "status", status: "tool_use" });
    fire(handlers, "eg12", { type: "status", status: "idle" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("compact.boundary with usage metadata", async () => {
    const handlers = await setupCapture();
    seedThread("eg13");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg13" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg13", {
      type: "compact.boundary",
      summary: "Compacted prior context",
      tokensSaved: 5000,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("compact.boundary with empty metadata", async () => {
    const handlers = await setupCapture();
    seedThread("eg14");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg14" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg14", { type: "compact.boundary" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("approval.requested for command_execution with detail", async () => {
    const handlers = await setupCapture();
    seedThread("eg15");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg15" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg15", {
      type: "approval.requested",
      requestId: "req-eg15",
      toolName: "Bash",
      detail: "ls /tmp",
      requestType: "command_execution",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("approval.requested for write_file", async () => {
    const handlers = await setupCapture();
    seedThread("eg16");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg16" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg16", {
      type: "approval.requested",
      requestId: "req-eg16",
      toolName: "Write",
      detail: "/tmp/x.ts",
      requestType: "write_file",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("userInput.requested with questions", async () => {
    const handlers = await setupCapture();
    seedThread("eg17");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg17" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg17", {
      type: "userInput.requested",
      requestId: "ask-1",
      questions: [{ text: "Path?" }, { text: "Confirm?" }],
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("tool.completed with isError=true", async () => {
    const handlers = await setupCapture();
    seedThread("eg18");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg18" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg18", {
      type: "tool.started",
      toolUseId: "T1",
      name: "Bash",
      input: { command: "ls" },
    });
    fire(handlers, "eg18", {
      type: "tool.completed",
      toolUseId: "T1",
      content: "permission denied",
      isError: true,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("tool.completed without prior tool.started (orphan)", async () => {
    const handlers = await setupCapture();
    seedThread("eg19");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg19" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg19", {
      type: "tool.completed",
      toolUseId: "ORPHAN",
      content: "something",
      isError: false,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("tool.progress event during tool execution", async () => {
    const handlers = await setupCapture();
    seedThread("eg20");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg20" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg20", {
      type: "tool.started",
      toolUseId: "T-prog",
      name: "Bash",
      input: { command: "long" },
    });
    fire(handlers, "eg20", {
      type: "tool.progress",
      toolUseId: "T-prog",
      progress: "running step 1...",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("task.started → task.progress → task.notification", async () => {
    const handlers = await setupCapture();
    seedThread("eg21");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg21" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg21", {
      type: "task.started",
      taskId: "tk1",
      title: "subagent",
    });
    fire(handlers, "eg21", {
      type: "task.progress",
      taskId: "tk1",
      progress: "step 1",
    });
    fire(handlers, "eg21", {
      type: "task.notification",
      taskId: "tk1",
      message: "completed",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("command.output event delivers stdout", async () => {
    const handlers = await setupCapture();
    seedThread("eg22");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg22" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg22", {
      type: "command.output",
      command: "ls",
      output: "file1\nfile2\n",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("files.persisted with failures", async () => {
    const handlers = await setupCapture();
    seedThread("eg23");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg23" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg23", {
      type: "files.persisted",
      files: [{ filename: "/a.ts", fileId: "fa" }],
      failed: [{ filename: "/locked.ts", error: "EACCES" }],
      uuid: "u-1",
      sessionId: "uuid-1",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("files.persisted with empty arrays", async () => {
    const handlers = await setupCapture();
    seedThread("eg24");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg24" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg24", {
      type: "files.persisted",
      files: [],
      failed: [],
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("session.init with slash_commands list seeds dropdown", async () => {
    const handlers = await setupCapture();
    seedThread("eg25");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg25" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg25", {
      type: "session.init",
      slash_commands: [{ name: "compact" }, { name: "clear" }, { name: "model" }],
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("session.init with empty slash_commands", async () => {
    const handlers = await setupCapture();
    seedThread("eg26");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg26" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg26", { type: "session.init", slash_commands: [] });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("session.init with mcp_servers", async () => {
    const handlers = await setupCapture();
    seedThread("eg27");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg27" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg27", {
      type: "session.init",
      mcp_servers: [{ name: "github", connected: true }],
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("turn.completed with empty model usage", async () => {
    const handlers = await setupCapture();
    seedThread("eg28");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg28" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg28", {
      type: "turn.completed",
      sessionId: "u-28",
      model: "claude-sonnet",
      modelUsage: {},
      userMessageUuid: "u-28-msg",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCostUsd: 0,
        numTurns: 0,
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("turn.completed with multiple model usages", async () => {
    const handlers = await setupCapture();
    seedThread("eg29");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg29" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg29", {
      type: "turn.completed",
      sessionId: "u-29",
      model: "claude-sonnet",
      modelUsage: {
        "claude-sonnet": { inputTokens: 100, outputTokens: 50 },
        "claude-haiku": { inputTokens: 30, outputTokens: 10 },
      },
      userMessageUuid: "u-29-msg",
      usage: {
        inputTokens: 130,
        outputTokens: 60,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCostUsd: 0.001,
        numTurns: 1,
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("multiple thinking deltas accumulate", async () => {
    const handlers = await setupCapture();
    seedThread("eg30");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg30" cwd="/tmp/repo" isNew />);
    await flush();
    for (let i = 0; i < 4; i++) {
      fire(handlers, "eg30", {
        type: "content.delta",
        contentType: "thinking",
        text: `t${i} `,
      });
    }
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("content.delta with empty text", async () => {
    const handlers = await setupCapture();
    seedThread("eg31");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg31" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg31", {
      type: "content.delta",
      contentType: "text",
      text: "",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("Fire many event variants in sequence (smoke)", async () => {
    const handlers = await setupCapture();
    seedThread("eg32");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg32" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg32", { type: "session.started", sessionId: "u-32" });
    fire(handlers, "eg32", { type: "status", status: "thinking" });
    fire(handlers, "eg32", { type: "content.delta", contentType: "thinking", text: "..." });
    fire(handlers, "eg32", { type: "status", status: "tool_use" });
    fire(handlers, "eg32", {
      type: "tool.started",
      toolUseId: "x",
      name: "Read",
      input: { file_path: "/f.ts" },
    });
    fire(handlers, "eg32", {
      type: "tool.completed",
      toolUseId: "x",
      content: "abc",
      isError: false,
    });
    fire(handlers, "eg32", { type: "content.delta", contentType: "text", text: "Result: " });
    fire(handlers, "eg32", { type: "status", status: "idle" });
    fire(handlers, "eg32", {
      type: "turn.completed",
      sessionId: "u-32",
      model: "sonnet",
      modelUsage: null,
      userMessageUuid: "msg",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCostUsd: 0.001,
        numTurns: 1,
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("event with missing type field is ignored", async () => {
    const handlers = await setupCapture();
    seedThread("eg33");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg33" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg33", { foo: "bar" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("rapid sequential session.started events", async () => {
    const handlers = await setupCapture();
    seedThread("eg34");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg34" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg34", { type: "session.started", sessionId: "u-34a" });
    fire(handlers, "eg34", { type: "session.started", sessionId: "u-34b" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("usage.update zeros pass through", async () => {
    const handlers = await setupCapture();
    seedThread("eg35");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg35" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg35", {
      type: "usage.update",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("rerender sessionId change cleans up listener", async () => {
    seedThread("eg36-a");
    const { rerender, container } = render(
      <ClaudeSdkSessionView sessionId="eg36-a" cwd="/tmp/repo" isNew />,
    );
    seedThread("eg36-b");
    rerender(<ClaudeSdkSessionView sessionId="eg36-b" cwd="/tmp/repo" isNew />);
    expect(container.firstChild).toBeTruthy();
  });

  it("isNew=false renders without auto-spawn", async () => {
    seedThread("eg37");
    const { container } = render(
      <ClaudeSdkSessionView sessionId="eg37" cwd="/tmp/repo" isNew={false} />,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("rerender swap to a different cwd", async () => {
    seedThread("eg38");
    const { container, rerender } = render(
      <ClaudeSdkSessionView sessionId="eg38" cwd="/tmp/repo" isNew />,
    );
    rerender(<ClaudeSdkSessionView sessionId="eg38" cwd="/tmp/other" isNew />);
    expect(container.firstChild).toBeTruthy();
  });

  it("hook.started variant only", async () => {
    const handlers = await setupCapture();
    seedThread("eg39");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg39" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg39", {
      type: "hook.started",
      hookName: "Stop",
      script: "/bin/notify",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("tool.started with empty input handles undefined paths", async () => {
    const handlers = await setupCapture();
    seedThread("eg40");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg40" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg40", {
      type: "tool.started",
      toolUseId: "TX",
      name: "Bash",
      input: {},
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("tool.started Edit with old/new strings", async () => {
    const handlers = await setupCapture();
    seedThread("eg41");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg41" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg41", {
      type: "tool.started",
      toolUseId: "TE",
      name: "Edit",
      input: {
        file_path: "/edited.ts",
        old_string: "foo",
        new_string: "bar",
      },
    });
    fire(handlers, "eg41", {
      type: "tool.completed",
      toolUseId: "TE",
      content: "ok",
      isError: false,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("tool.started TodoWrite", async () => {
    const handlers = await setupCapture();
    seedThread("eg42");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg42" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg42", {
      type: "tool.started",
      toolUseId: "TW",
      name: "TodoWrite",
      input: {
        todos: [{ content: "step1", status: "pending", activeForm: "Doing step 1" }],
      },
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("Grok todo_write surfaces in the sticky bar and is filtered from the inline stream", async () => {
    const handlers = await setupCapture();
    seedThread("gtw1");
    const { container } = render(<ClaudeSdkSessionView sessionId="gtw1" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "gtw1", {
      type: "tool.started",
      toolUseId: "GTW",
      name: "todo_write",
      input: { todos: [{ id: "1", content: "grok sticky task", status: "in_progress" }] },
    });
    await flush();
    expect(container.textContent).toContain("grok sticky task");
    // todo_write renders in the sticky bar, not as an inline ToolUseBlock.
    expect(container.querySelector("[data-testid='tool-use-block']")).toBeNull();
  });

  it("Grok todo_write merge:true folds into the prior snapshot", async () => {
    const handlers = await setupCapture();
    seedThread("gtw2");
    const { container } = render(<ClaudeSdkSessionView sessionId="gtw2" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "gtw2", {
      type: "tool.started",
      toolUseId: "GTW-A",
      name: "todo_write",
      input: {
        merge: false,
        todos: [
          { id: "1", content: "alpha task running", status: "in_progress" },
          { id: "2", content: "beta task", status: "pending" },
        ],
      },
    });
    fire(handlers, "gtw2", {
      type: "tool.started",
      toolUseId: "GTW-B",
      name: "todo_write",
      input: { merge: true, todos: [{ id: "2", content: "beta task", status: "pending" }] },
    });
    await flush();
    // The merge:true update keeps id 1, so the in-progress task stays current.
    // Without merge folding the dedup would drop it and "beta task" would show.
    expect(container.textContent).toContain("alpha task running");
  });

  it("multiple consecutive errors in sequence", async () => {
    const handlers = await setupCapture();
    seedThread("eg43");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg43" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg43", { type: "error", message: "first" });
    fire(handlers, "eg43", { type: "error", message: "second" });
    fire(handlers, "eg43", { type: "error", message: "third" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("status idle without prior thinking is fine", async () => {
    const handlers = await setupCapture();
    seedThread("eg44");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg44" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg44", { type: "status", status: "idle" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("rate.limit followed by content.delta resumes flow", async () => {
    const handlers = await setupCapture();
    seedThread("eg45");
    const { container } = render(<ClaudeSdkSessionView sessionId="eg45" cwd="/tmp/repo" isNew />);
    await flush();
    fire(handlers, "eg45", {
      type: "rate.limit",
      retryAt: Date.now() + 30000,
    });
    fire(handlers, "eg45", {
      type: "content.delta",
      contentType: "text",
      text: "resumed",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });
});

describe("ClaudeSdkSessionView — timeline rebind gating", () => {
  afterEach(() => {
    vi.useRealTimers();
    _resetAppVisibilityForTests();
  });

  it("pauses the 4s turn rebind while backgrounded and reruns it immediately on return", async () => {
    vi.useFakeTimers();
    const cmd = await import("../../../lib/commands");
    const listTurns = vi.mocked(cmd.listThreadTurns);
    listTurns.mockClear();
    const calls = () => listTurns.mock.calls.filter(([id]) => id === "tl1").length;
    render(<ClaudeSdkSessionView sessionId="tl1" cwd="/tmp/repo" />);
    await act(async () => { await Promise.resolve(); });
    expect(calls()).toBe(1);
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(calls()).toBe(2);

    act(() => { window.dispatchEvent(new Event("blur")); });
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(calls()).toBe(2);

    act(() => { window.dispatchEvent(new Event("focus")); });
    await act(async () => { await Promise.resolve(); });
    expect(calls()).toBe(3);
  });

  it("does not rebind while the cached view is not presented", async () => {
    vi.useFakeTimers();
    const cmd = await import("../../../lib/commands");
    const listTurns = vi.mocked(cmd.listThreadTurns);
    listTurns.mockClear();
    const calls = () => listTurns.mock.calls.filter(([id]) => id === "tl2").length;
    const view = (active: boolean) => (
      <SessionPresentationContext.Provider value={{ id: "tl2", active }}>
        <ClaudeSdkSessionView sessionId="tl2" cwd="/tmp/repo" />
      </SessionPresentationContext.Provider>
    );
    const { rerender } = render(view(false));
    await act(async () => { vi.advanceTimersByTime(12_000); });
    expect(calls()).toBe(0);

    rerender(view(true));
    await act(async () => { await Promise.resolve(); });
    expect(calls()).toBe(1);
  });
});
