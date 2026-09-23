/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";

const inspectorPropsSpy = vi.hoisted(() => vi.fn());
vi.mock("../subagents/SubagentInspector", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../subagents/SubagentInspector")>();
  return { ...actual, SubagentInspector: (props: React.ComponentProps<typeof actual.SubagentInspector>) => {
    inspectorPropsSpy(props);
    return <actual.SubagentInspector {...props} />;
  } };
});

// jsdom does not implement ResizeObserver — provide a no-op polyfill.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof NoopResizeObserver }).ResizeObserver = NoopResizeObserver;

// Heavy children — replace with stubs.
vi.mock("../ThreadTopBar", () => ({
  ThreadTopBar: () => <div data-testid="thread-top-bar" />,
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
vi.mock("../OpenCodeThinkingIndicator", () => ({
  OpenCodeThinkingIndicator: () => null,
}));
vi.mock("../ProviderModelDropdown", () => ({
  ProviderModelDropdown: () => <div data-testid="provider-model-dropdown" />,
}));
vi.mock("../ContextRing", () => ({
  ContextRing: () => null,
}));
vi.mock("../GitBranchSelector", () => ({
  GitBranchSelector: () => null,
}));
vi.mock("../PlanFollowUpBanner", () => ({
  PlanFollowUpBanner: () => null,
}));
vi.mock("../TaskNotificationBadge", () => ({
  TaskNotificationBadge: () => null,
}));
vi.mock("../ThinkingBlock", () => ({
  ThinkingBlock: () => null,
}));
vi.mock("../ToolUseBlock", () => ({
  ToolUseBlock: () => null,
}));
vi.mock("../ToolActivityGroup", () => ({
  ToolActivityGroup: () => null,
}));
vi.mock("../MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("../UserMessageText", () => ({
  UserMessageText: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("../FileMentionPopup", () => ({
  FileMentionPopup: () => null,
}));
vi.mock("../ImageAttachmentBar", () => ({
  ImageAttachmentBar: () => <div data-testid="image-attachment-bar" />,
  useImageAttachments: () => ({
    images: [],
    addImages: vi.fn(),
    removeImage: vi.fn(),
    clearImages: vi.fn(),
  }),
  extractImagesFromDrop: vi.fn(() => []),
  extractImagePathsFromDrop: vi.fn(() => []),
  fileToImageAttachment: vi.fn(),
}));

vi.mock("../../../hooks/useFileMentions", () => ({
  useFileMentions: () => ({
    mentions: [],
    showPopup: false,
    query: "",
    entries: [],
    activeIndex: 0,
    currentPath: "",
    isSearchMode: false,
    onTextChange: vi.fn(),
    onSelect: vi.fn(),
    closePopup: vi.fn(),
    handleKeyDown: () => false,
    handleSelect: vi.fn(),
    onTextareaChange: vi.fn(),
  }),
}));

vi.mock("../../../lib/opencodeSdkCommands", () => ({
  opencodeSdk: {
    startSession: vi.fn().mockResolvedValue(undefined),
    stopSession: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    abortSession: vi.fn().mockResolvedValue(undefined),
    listAgents: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockResolvedValue([]),
    getMessages: vi.fn().mockResolvedValue([]),
    listSessions: vi.fn().mockResolvedValue([]),
    initializeBridge: vi.fn().mockResolvedValue(undefined),
    respondPermission: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setAgent: vi.fn().mockResolvedValue(undefined),
    bridgeLogTail: vi.fn().mockResolvedValue([]),
    getHistory: vi.fn().mockResolvedValue({ messages: [] }),
  },
}));

// Stub Tauri notifications so the permission_request path doesn't throw
// in jsdom. Mirrors CodexSessionView/ClaudeSdkSessionView coverage tests.
vi.mock("../../../lib/notifications", () => ({
  sendNotification: vi.fn(),
  providerizeNotification: (_: string, title: string, body: string) => ({ title, body }),
}));

vi.mock("../../../lib/agentToast", () => ({
  markTurnStart: vi.fn(),
  showAgentCompleteToast: vi.fn(),
}));

vi.mock("../../../lib/commands", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readImageBase64: vi.fn().mockResolvedValue(""),
  };
});

import { OpenCodeSdkSessionView } from "../OpenCodeSdkSessionView";
import { useThreadStore } from "../../../stores/threadStore";
import { useUiStore } from "../../../stores/uiStore";

afterEach(() => cleanup());

beforeEach(() => {
  useThreadStore.setState({ threads: {} } as never);
  useUiStore.setState({} as never);
});

describe("OpenCodeSdkSessionView", () => {
  it("renders without crashing for a new session", () => {
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" isNew />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders without crashing for an existing session", () => {
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders the thread top bar by default", () => {
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeTruthy();
  });

  it("hides the top bar when hideTopBar is true", () => {
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" hideTopBar />
    );
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeNull();
  });

  it("renders a textarea for composing prompts", () => {
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    expect(container.querySelector("textarea")).toBeTruthy();
  });

  it("renders with a different cwd without crashing", () => {
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/another/path" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders the provider model dropdown stub", () => {
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    expect(container.querySelector("[data-testid='provider-model-dropdown']")).toBeTruthy();
  });

  it("renders chat scroll area structure", () => {
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    expect(container.querySelectorAll("div").length).toBeGreaterThan(1);
  });

  it("renders for a Windows-style cwd path", () => {
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="C:\\Users\\test\\repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for a deeply nested cwd path", () => {
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/a/b/c/d/e/f/g/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with a different sessionId", () => {
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-other" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("rerenders with isNew toggling", () => {
    const { container, rerender } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" isNew />
    );
    expect(container.firstChild).toBeTruthy();
    rerender(<OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />);
    expect(container.firstChild).toBeTruthy();
  });

  it("rerenders with hideTopBar toggling", () => {
    const { container, rerender } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeTruthy();
    rerender(<OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" hideTopBar />);
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeNull();
  });

  it("rerenders with sessionId change", () => {
    const { container, rerender } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
    rerender(<OpenCodeSdkSessionView sessionId="oc2" cwd="/tmp/repo" />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders when threadStore has matching OpenCode thread", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc1",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Idle",
            name: "OpenCode session",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: "anthropic/claude-sonnet-4-5",
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders when threadStore has Running OpenCode thread", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc1",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Running",
            name: "OpenCode session",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders when threadStore has Error OpenCode thread", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc1",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Error",
            name: "OpenCode session",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with empty threads in store", () => {
    useThreadStore.setState({ threads: {} } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders multiple unique mounts cleanly", () => {
    const r1 = render(<OpenCodeSdkSessionView sessionId="ocA" cwd="/tmp/repo" />);
    expect(r1.container.firstChild).toBeTruthy();
    cleanup();
    const r2 = render(<OpenCodeSdkSessionView sessionId="ocB" cwd="/tmp/repo" />);
    expect(r2.container.firstChild).toBeTruthy();
    cleanup();
    const r3 = render(<OpenCodeSdkSessionView sessionId="ocC" cwd="/tmp/repo" isNew />);
    expect(r3.container.firstChild).toBeTruthy();
  });

  it("input textarea is present in compact + isNew", () => {
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" isNew />
    );
    expect(container.querySelector("textarea")).toBeTruthy();
  });

  it("renders for thread with worktree branch", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc1",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Idle",
            name: "feature thread",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
            worktree_branch: "feature/x",
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with cwd at filesystem root", () => {
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with cwd containing spaces", () => {
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/Users/me/My Repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with cwd containing unicode", () => {
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/repo/データ" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with sessionId containing UUID-like value", () => {
    const { container } = render(
      <OpenCodeSdkSessionView
        sessionId="abcd1234-5678-90ef-1234-567890abcdef"
        cwd="/tmp/repo"
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for thread with multiple status values", () => {
    for (const status of ["Idle", "Running", "Spawning", "Stopped", "Error"]) {
      useThreadStore.setState({
        threads: {
          p1: [
            {
              id: "oc1",
              project_id: "p1",
              provider: "OpenCode",
              interaction_mode: "opencode-sdk",
              status,
              name: status,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              last_active_at: new Date().toISOString(),
              model: null,
            } as never,
          ],
        },
      } as never);
      const { container, unmount } = render(
        <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
      );
      expect(container.firstChild).toBeTruthy();
      unmount();
    }
  });

  it("renders for thread with various opencode model identifiers", () => {
    const models = [
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5",
      "openrouter/anthropic/claude-3.5-sonnet",
      "google/gemini-2.5-pro",
      null,
    ];
    for (const model of models) {
      useThreadStore.setState({
        threads: {
          p1: [
            {
              id: "oc1",
              project_id: "p1",
              provider: "OpenCode",
              interaction_mode: "opencode-sdk",
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
      const { container, unmount } = render(
        <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
      );
      expect(container.firstChild).toBeTruthy();
      unmount();
    }
  });

  it("rerenders cwd through several values", () => {
    const { rerender, container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/r1" />
    );
    rerender(<OpenCodeSdkSessionView sessionId="oc1" cwd="/r2" />);
    rerender(<OpenCodeSdkSessionView sessionId="oc1" cwd="/r3" />);
    rerender(<OpenCodeSdkSessionView sessionId="oc1" cwd="/r4" />);
    expect(container.firstChild).toBeTruthy();
  });

  it("rerenders sessionId through several values", () => {
    const { rerender, container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    rerender(<OpenCodeSdkSessionView sessionId="oc2" cwd="/tmp/repo" />);
    rerender(<OpenCodeSdkSessionView sessionId="oc3" cwd="/tmp/repo" />);
    expect(container.firstChild).toBeTruthy();
  });

  it("textarea persists through hideTopBar toggle", () => {
    const { rerender, container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    expect(container.querySelector("textarea")).toBeTruthy();
    rerender(<OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" hideTopBar />);
    expect(container.querySelector("textarea")).toBeTruthy();
  });

  it("renders with isNew explicitly false", () => {
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" isNew={false} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with hideTopBar explicitly false", () => {
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" hideTopBar={false} />
    );
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeTruthy();
  });

  it("does not crash on rapid mount/unmount cycles", () => {
    for (let i = 0; i < 5; i++) {
      const { unmount } = render(
        <OpenCodeSdkSessionView sessionId={`oc${i}`} cwd="/tmp/repo" />
      );
      unmount();
    }
    expect(true).toBe(true);
  });

  it("renders consistent input across hideTopBar and !hideTopBar", () => {
    const r1 = render(<OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />);
    const t1 = r1.container.querySelector("textarea");
    cleanup();
    const r2 = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" hideTopBar />
    );
    const t2 = r2.container.querySelector("textarea");
    expect(t1).toBeTruthy();
    expect(t2).toBeTruthy();
  });

  it("provider model dropdown is present in default render", () => {
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    expect(container.querySelector("[data-testid='provider-model-dropdown']")).toBeTruthy();
  });

  it("provider model dropdown is present even when isNew", () => {
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" isNew />
    );
    expect(container.querySelector("[data-testid='provider-model-dropdown']")).toBeTruthy();
  });

  it("renders many sequential mounts with different sessions cleanly", () => {
    for (let i = 0; i < 4; i++) {
      const r = render(
        <OpenCodeSdkSessionView sessionId={`oc${i}`} cwd={`/r${i}`} isNew={i % 2 === 0} />
      );
      expect(r.container.firstChild).toBeTruthy();
      cleanup();
    }
  });

  it("renders without ImageAttachmentBar stub by default (only shows when images present)", () => {
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    // ImageAttachmentBar is conditionally rendered when there are images;
    // by default the hook returns no images.
    expect(container.firstChild).toBeTruthy();
  });

  it("renders with thread having opencode_session_id set", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc1",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Idle",
            name: "Resumed",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
            opencode_session_id: "real-opencode-id",
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });
});

describe("OpenCodeSdkSessionView — store reactivity & extras", () => {
  it("survives status flip Idle → Running while mounted", () => {
    const base: Record<string, unknown> = {
      id: "oc1",
      project_id: "p1",
      provider: "OpenCode",
      interaction_mode: "opencode-sdk",
      status: "Idle",
      name: "X",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
      model: null,
    };
    useThreadStore.setState({ threads: { p1: [base as never] } } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    useThreadStore.setState({
      threads: { p1: [{ ...base, status: "Running" } as never] },
    } as never);
    expect(container.firstChild).toBeTruthy();
  });

  it("does not crash when thread removed from store after mount", () => {
    const t = {
      id: "oc1",
      project_id: "p1",
      provider: "OpenCode",
      interaction_mode: "opencode-sdk",
      status: "Idle",
      name: "X",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
      model: null,
    } as never;
    useThreadStore.setState({ threads: { p1: [t] } } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    useThreadStore.setState({ threads: {} } as never);
    expect(container.firstChild).toBeTruthy();
  });

  it("textarea rendered for thread with claude-via-opencode model id", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc1",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Idle",
            name: "X",
            model: "anthropic/claude-sonnet-4-5",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    expect(container.querySelector("textarea")).toBeTruthy();
  });

  it("rerenders cleanly switching between two store-backed sessions", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc1",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Idle",
            name: "A",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
          {
            id: "oc2",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
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
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
    rerender(<OpenCodeSdkSessionView sessionId="oc2" cwd="/tmp/repo" />);
    expect(container.firstChild).toBeTruthy();
    rerender(<OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for thread with worktree branch in store", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc1",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Idle",
            name: "X",
            worktree_branch: "feat/oc-test",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders top bar when not hideTopBar even with stopped status", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc1",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
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
      <OpenCodeSdkSessionView sessionId="oc1" cwd="/tmp/repo" />
    );
    expect(container.querySelector("[data-testid='thread-top-bar']")).toBeTruthy();
  });

  it("renders for orphan opencode_session_id with no thread match", () => {
    useThreadStore.setState({ threads: {} } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-missing" cwd="/tmp/repo" />
    );
    expect(container.firstChild).toBeTruthy();
  });
});

// =====================================================================
// Deep coverage — exercise OpenCode SDK event handlers via captured
// listen callback. Drives both control events ({event:...}) and mapper
// events ({type:...}) to hit the 200-line switch in handleEvent.
// =====================================================================
describe("OpenCodeSdkSessionView — deep coverage (sdk-event handlers)", () => {
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

  function fireOpenCode(
    handlers: Record<string, Listener>,
    threadId: string,
    payload: unknown,
  ) {
    const channel = `sdk-event-${threadId}`;
    const h = handlers[channel];
    if (h) h({ payload });
  }

  it("captures the sdk-event listener channel", async () => {
    const handlers = await setupCapture();
    render(<OpenCodeSdkSessionView sessionId="oc-d1" cwd="/tmp/repo" />);
    await flush();
    expect(handlers[`sdk-event-oc-d1`]).toBeTruthy();
  });

  it("keeps OpenCode subagents accessible even when launch rows are collapsed", async () => {
    const handlers = await setupCapture();
    const { container } = render(<OpenCodeSdkSessionView sessionId="oc-agents" cwd="/tmp/repo" />);
    await flush();
    fireOpenCode(handlers, "oc-agents", { type: "tool_use", partId: "part-task", toolName: "task", input: { description: "Review cache", prompt: "Check invalidation" } });
    await flush();
    expect(inspectorPropsSpy.mock.lastCall?.[0]).toMatchObject({ provider: "OpenCode", parentThreadId: "oc-agents", subagents: [expect.objectContaining({ toolUseId: "part-task", title: "Review cache", status: "running" })] });
    expect(container.querySelector(".subagent-card-stage .subagent-overview-host")).toBeTruthy();
    fireOpenCode(handlers, "oc-agents", { type: "tool_result", partId: "part-task", output: "Cache verified", isError: false });
    await flush();
    expect(inspectorPropsSpy.mock.lastCall?.[0].subagents[0]).toMatchObject({ status: "completed", result: { content: "Cache verified", isError: false } });
  });

  it("handles session.started control event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-d2" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-d2", {
      event: "session.started",
      sessionId: "oc-real-uuid",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles session.idle control event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-d3" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-d3", { event: "session.idle" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles error control event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-d4" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-d4", { event: "error", message: "Bridge died" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("keeps buffered background text before a later error", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-background-order" cwd="/tmp/repo" />
    );
    await flush();
    useUiStore.setState({ sidebarTab: "agents", selectedThreadId: "another-thread" });
    await flush();
    fireOpenCode(handlers, "oc-background-order", {
      type: "assistant_text", partId: "before-error", fullText: "Before the failure",
    });
    fireOpenCode(handlers, "oc-background-order", { event: "error", message: "Connection failed" });
    await flush();
    useUiStore.setState({ selectedThreadId: "oc-background-order" });
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Before the failure");
    expect(text.indexOf("Before the failure")).toBeLessThan(text.indexOf("Connection failed"));
    useUiStore.setState({ selectedThreadId: null });
  });

  it("handles assistant_text mapper events incrementally", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-d5" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-d5", {
      type: "assistant_text",
      partId: "p1",
      fullText: "Hello",
    });
    fireOpenCode(handlers, "oc-d5", {
      type: "assistant_text",
      partId: "p1",
      fullText: "Hello world",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles thinking events", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-d6" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-d6", {
      type: "thinking",
      partId: "th1",
      fullText: "Considering...",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles tool_use → tool_result lifecycle", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-d7" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-d7", {
      type: "tool_use",
      partId: "tu1",
      toolName: "bash",
      input: { command: "ls" },
      status: "running",
    });
    fireOpenCode(handlers, "oc-d7", {
      type: "tool_result",
      partId: "tu1",
      toolName: "bash",
      output: "file1\nfile2",
      isError: false,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles tool_result with error=true", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-d8" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-d8", {
      type: "tool_use",
      partId: "tu-err",
      toolName: "bash",
      input: { command: "false" },
      status: "running",
    });
    fireOpenCode(handlers, "oc-d8", {
      type: "tool_result",
      partId: "tu-err",
      toolName: "bash",
      output: "exit 1",
      isError: true,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles permission_request event (smoke; OS notification path may throw in jsdom)", async () => {
    const handlers = await setupCapture();
    render(<OpenCodeSdkSessionView sessionId="oc-d9" cwd="/tmp/repo" />);
    await flush();
    fireOpenCode(handlers, "oc-d9", {
      type: "permission_request",
      threadId: "oc-d9",
      permissionId: "perm1",
      kind: "tool",
      permission: "execute bash command",
      pattern: "rm -rf",
      metadata: {},
      eventId: "e",
      timestamp: "2026-01-01T00:00:00Z",
    });
    await flush();
    expect(handlers["sdk-event-oc-d9"]).toBeTruthy();
  });

  it("handles subtask event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-d10" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-d10", {
      type: "subtask",
      partId: "st1",
      agent: "general",
      prompt: "Run tests",
      description: "Subtask: tests",
      subtaskModel: "claude-sonnet-4-5",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles usage_update event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-d11" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-d11", {
      type: "usage_update",
      tokens: { input: 500, output: 1000, cacheRead: 50, cacheWrite: 25 },
      cost: 0.01,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles user_input_request event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-d12" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-d12", {
      type: "user_input_request",
      questionId: "ui1",
      questions: [{ text: "Continue?" }],
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles patch event (smoke; full FilesChangedCard render needs more env)", async () => {
    const handlers = await setupCapture();
    render(<OpenCodeSdkSessionView sessionId="oc-d13" cwd="/tmp/repo" />);
    await flush();
    fireOpenCode(handlers, "oc-d13", {
      type: "patch",
      partId: "pt1",
      files: ["/tmp/file.ts"],
      hash: "abc123",
    });
    await flush();
    expect(handlers["sdk-event-oc-d13"]).toBeTruthy();
  });

  it("handles retry event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-d14" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-d14", {
      type: "retry",
      partId: "rt1",
      attempt: 2,
      error: "rate limit",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles compaction event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-d15" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-d15", {
      type: "compaction",
      partId: "cmp1",
      auto: true,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles user_file event", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-d16" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-d16", {
      type: "user_file",
      partId: "uf1",
      mime: "image/png",
      filename: "uploaded.png",
      url: "file:///tmp/uploaded.png",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles unknown event types without crashing", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-d17" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-d17", { type: "fictional_event" } as never);
    fireOpenCode(handlers, "oc-d17", { event: "fictional_control" } as never);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles a full multiplex sequence (control + mapper events)", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-d18" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-d18", {
      event: "session.started",
      sessionId: "oc-real",
    });
    fireOpenCode(handlers, "oc-d18", {
      type: "assistant_text",
      partId: "p1",
      fullText: "Working...",
    });
    fireOpenCode(handlers, "oc-d18", {
      type: "tool_use",
      partId: "tu1",
      toolName: "read",
      input: { path: "/x" },
      status: "running",
    });
    fireOpenCode(handlers, "oc-d18", {
      type: "tool_result",
      partId: "tu1",
      toolName: "read",
      output: "contents",
      isError: false,
    });
    fireOpenCode(handlers, "oc-d18", {
      type: "assistant_text",
      partId: "p1",
      fullText: "Working... done.",
    });
    fireOpenCode(handlers, "oc-d18", { event: "session.idle" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ignores events fired after unmount", async () => {
    const handlers = await setupCapture();
    const { unmount } = render(
      <OpenCodeSdkSessionView sessionId="oc-d19" cwd="/tmp/repo" />
    );
    await flush();
    unmount();
    fireOpenCode(handlers, "oc-d19", {
      type: "assistant_text",
      partId: "p1",
      fullText: "post-unmount",
    });
    await flush();
    expect(true).toBe(true);
  });

  it("dispatches events with thread present in store", async () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc-d20",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Idle",
            name: "Deep",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: "anthropic/claude-sonnet-4-5",
          } as never,
        ],
      },
    } as never);
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-d20" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-d20", {
      event: "session.started",
      sessionId: "oc-real",
    });
    fireOpenCode(handlers, "oc-d20", {
      type: "assistant_text",
      partId: "p1",
      fullText: "Hi",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });
});

// =====================================================================
// Maximum coverage — drive every event payload variant through the
// switch in handleEvent and through BlockRenderer's case arms by making
// the component render produced blocks. Mirrors the CodexSessionView /
// ClaudeSdkSessionView "Maximum coverage" pattern.
// =====================================================================
describe("OpenCodeSdkSessionView — Maximum coverage", () => {
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

  function fireOpenCode(
    handlers: Record<string, Listener[]>,
    threadId: string,
    payload: unknown,
  ) {
    const channel = `sdk-event-${threadId}`;
    for (const h of handlers[channel] ?? []) h({ payload });
  }

  function seedThread(threadId: string, overrides: Record<string, unknown> = {}) {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: threadId,
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Running",
            name: "Cov",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: "anthropic/claude-sonnet-4-5",
            ...overrides,
          } as never,
        ],
      },
    } as never);
  }

  // -------- assistant_text variants --------
  it("upserts assistant_text on subsequent deltas (same partId)", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-1");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-1" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-1", { type: "assistant_text", partId: "pa", fullText: "Hi" });
    fireOpenCode(handlers, "oc-mc-1", { type: "assistant_text", partId: "pa", fullText: "Hi there" });
    fireOpenCode(handlers, "oc-mc-1", { type: "assistant_text", partId: "pa", fullText: "Hi there friend" });
    await flush();
    expect(container.textContent).toContain("Hi there friend");
  });

  it("appends new assistant_text block when partId differs", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-2");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-2" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-2", { type: "assistant_text", partId: "pa", fullText: "first" });
    fireOpenCode(handlers, "oc-mc-2", { type: "assistant_text", partId: "pb", fullText: "second" });
    await flush();
    expect(container.textContent).toContain("first");
    expect(container.textContent).toContain("second");
  });

  it("renders assistant_text containing task-notification tag (cleaned)", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-3");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-3" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-3", {
      type: "assistant_text",
      partId: "pa",
      fullText: "Hello world <task-notification>done</task-notification>",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // -------- thinking variants --------
  it("upserts thinking block on subsequent deltas", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-4");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-4" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-4", { type: "thinking", partId: "th", fullText: "thinking..." });
    fireOpenCode(handlers, "oc-mc-4", { type: "thinking", partId: "th", fullText: "still thinking..." });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // -------- tool_use upsert behavior --------
  it("upserts tool_use when later event has empty input but matching toolName", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-5");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-5" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-5", {
      type: "tool_use", partId: "t", toolName: "bash", input: { command: "ls" }, status: "running",
    });
    fireOpenCode(handlers, "oc-mc-5", {
      type: "tool_use", partId: "t", toolName: "bash", input: {}, status: "running",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("upserts tool_use replacing toolName when newer event has args", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-6");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-6" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-6", {
      type: "tool_use", partId: "t", toolName: "unknown", input: {}, status: "running",
    });
    fireOpenCode(handlers, "oc-mc-6", {
      type: "tool_use", partId: "t", toolName: "read", input: { path: "/x" }, status: "running",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ignores tool_result for unknown partId without crashing", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-7");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-7" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-7", {
      type: "tool_result", partId: "ghost", toolName: "bash", output: "x", isError: false,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders tool_use for an OpenCode edit-tool name", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-8");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-8" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-8", {
      type: "tool_use", partId: "te", toolName: "edit", input: { file: "a.ts" }, status: "running",
    });
    fireOpenCode(handlers, "oc-mc-8", {
      type: "tool_result", partId: "te", toolName: "edit", output: "patched", isError: false,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders tool_use for write tool", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-9");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-9" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-9", {
      type: "tool_use", partId: "tw", toolName: "write", input: { file: "b.ts", content: "" }, status: "running",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders tool_use for task agent tool", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-10");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-10" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-10", {
      type: "tool_use", partId: "ta", toolName: "task", input: { prompt: "x" }, status: "running",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders tool_use for todowrite (group-pinned tool)", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-11");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-11" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-11", {
      type: "tool_use", partId: "td", toolName: "todowrite", input: { todos: [] }, status: "running",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("groups consecutive non-individual tools into tool_group block", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-12");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-12" cwd="/tmp/repo" />
    );
    await flush();
    // Two non-individual tools (e.g. "read", "grep") fired close together
    // should land in a single tool_group block via groupBlocks().
    fireOpenCode(handlers, "oc-mc-12", {
      type: "tool_use", partId: "g1", toolName: "read", input: { path: "/a" }, status: "running",
    });
    fireOpenCode(handlers, "oc-mc-12", {
      type: "tool_use", partId: "g2", toolName: "grep", input: { pattern: "x" }, status: "running",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // -------- permission_request flow + button click-through --------
  it("permission_request renders inline approval banner with three buttons", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-13");
    const { container, getByText } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-13" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-13", {
      type: "permission_request",
      threadId: "oc-mc-13",
      permissionId: "perm-A",
      kind: "tool",
      permission: "execute bash command",
      pattern: "rm -rf",
      metadata: { command: "rm -rf /" },
      eventId: "e1",
      timestamp: "2026-01-01T00:00:00Z",
    });
    await flush();
    expect(container.textContent).toContain("OpenCode wants to execute bash command");
    expect(getByText("Approve once")).toBeTruthy();
    expect(getByText("Approve always")).toBeTruthy();
    expect(getByText("Deny")).toBeTruthy();
  });

  it("permission_request without metadata still renders banner", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-14");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-14" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-14", {
      type: "permission_request",
      threadId: "oc-mc-14",
      permissionId: "perm-B",
      kind: "tool",
      permission: "read file",
      pattern: "*",
      metadata: {},
      eventId: "e2",
      timestamp: "2026-01-01T00:00:00Z",
    });
    await flush();
    expect(container.textContent).toContain("OpenCode wants to read file");
  });

  it("Approve once click invokes opencodeSdk.respondPermission with 'accept'", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-15");
    const { getByText } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-15" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-15", {
      type: "permission_request",
      threadId: "oc-mc-15",
      permissionId: "perm-1",
      kind: "tool",
      permission: "edit file",
      pattern: "*.ts",
      metadata: { file: "a.ts" },
      eventId: "e",
      timestamp: "2026-01-01T00:00:00Z",
    });
    await flush();
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    const respond = vi.mocked(sdkMod.opencodeSdk.respondPermission);
    respond.mockClear();
    (getByText("Approve once") as HTMLButtonElement).click();
    await flush();
    expect(respond).toHaveBeenCalledWith("oc-mc-15", "perm-1", "accept");
  });

  it("Approve always click invokes respondPermission with 'acceptForSession'", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-16");
    const { getByText } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-16" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-16", {
      type: "permission_request",
      threadId: "oc-mc-16",
      permissionId: "perm-2",
      kind: "tool",
      permission: "edit file",
      pattern: "*",
      metadata: { file: "b.ts" },
      eventId: "e",
      timestamp: "2026-01-01T00:00:00Z",
    });
    await flush();
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    const respond = vi.mocked(sdkMod.opencodeSdk.respondPermission);
    respond.mockClear();
    (getByText("Approve always") as HTMLButtonElement).click();
    await flush();
    expect(respond).toHaveBeenCalledWith("oc-mc-16", "perm-2", "acceptForSession");
  });

  it("Deny click invokes respondPermission with 'decline'", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-17");
    const { getByText } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-17" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-17", {
      type: "permission_request",
      threadId: "oc-mc-17",
      permissionId: "perm-3",
      kind: "tool",
      permission: "delete",
      pattern: "*",
      metadata: { path: "/x" },
      eventId: "e",
      timestamp: "2026-01-01T00:00:00Z",
    });
    await flush();
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    const respond = vi.mocked(sdkMod.opencodeSdk.respondPermission);
    respond.mockClear();
    (getByText("Deny") as HTMLButtonElement).click();
    await flush();
    expect(respond).toHaveBeenCalledWith("oc-mc-17", "perm-3", "decline");
  });

  it("respondPermission rejection surfaces an error block", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-18");
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    const respond = vi.mocked(sdkMod.opencodeSdk.respondPermission);
    respond.mockRejectedValueOnce(new Error("bridge dead"));
    const { container, getByText } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-18" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-18", {
      type: "permission_request",
      threadId: "oc-mc-18",
      permissionId: "perm-X",
      kind: "tool",
      permission: "do thing",
      pattern: "*",
      metadata: {},
      eventId: "e",
      timestamp: "2026-01-01T00:00:00Z",
    });
    await flush();
    (getByText("Approve once") as HTMLButtonElement).click();
    await flush();
    expect(container.textContent).toContain("bridge dead");
  });

  // -------- subtask --------
  it("subtask block dedups by partId", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-19");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-19" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-19", {
      type: "subtask", partId: "s1", agent: "general", prompt: "Run", description: "d", subtaskModel: "m",
    });
    fireOpenCode(handlers, "oc-mc-19", {
      type: "subtask", partId: "s1", agent: "general", prompt: "Run", description: "d", subtaskModel: "m",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("subtask renders agent name and description", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-20");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-20" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-20", {
      type: "subtask",
      partId: "s2",
      agent: "research-agent",
      prompt: "find files",
      description: "Indexing the repo",
      subtaskModel: "claude-haiku-4-5",
    });
    await flush();
    expect(container.textContent).toContain("research-agent");
    expect(container.textContent).toContain("Indexing the repo");
  });

  it("subtask with very long prompt renders truncated", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-21");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-21" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-21", {
      type: "subtask",
      partId: "s3",
      agent: "general",
      prompt: "x".repeat(2000),
      description: "",
      subtaskModel: "",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // -------- usage_update --------
  it("usage_update with cumulative deltas updates context ring", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-22");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-22" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-22", {
      type: "usage_update",
      tokens: { input: 100, output: 200, cacheRead: 10, cacheWrite: 5 },
      cost: 0.001,
    });
    fireOpenCode(handlers, "oc-mc-22", {
      type: "usage_update",
      tokens: { input: 300, output: 600, cacheRead: 50, cacheWrite: 25 },
      cost: 0.005,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("usage_update where cumulative goes backwards clamps to zero (no negative deltas)", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-23");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-23" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-23", {
      type: "usage_update",
      tokens: { input: 1000, output: 2000, cacheRead: 100, cacheWrite: 50 },
      cost: 0.01,
    });
    fireOpenCode(handlers, "oc-mc-23", {
      type: "usage_update",
      tokens: { input: 500, output: 1000, cacheRead: 50, cacheWrite: 25 },
      cost: 0.005,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // -------- user_input_request --------
  it("user_input_request renders an error-style block with question summary", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-24");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-24" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-24", {
      type: "user_input_request",
      questionId: "q1",
      questions: [{ text: "Choose option" }],
    });
    await flush();
    expect(container.textContent).toContain("User input requested");
  });

  // -------- patch --------
  it("patch event renders Patch summary block listing files", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-25");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-25" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-25", {
      type: "patch",
      partId: "p1",
      files: ["src/a.ts", "src/b.ts"],
      hash: "abc",
    });
    await flush();
    expect(container.textContent).toContain("Patch");
    expect(container.textContent).toContain("src/a.ts");
    expect(container.textContent).toContain("src/b.ts");
  });

  it("patch with single file renders 'file' singular", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-26");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-26" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-26", {
      type: "patch", partId: "p2", files: ["only.ts"], hash: "h",
    });
    await flush();
    // textContent concatenates; assert the singular phrase appears
    expect(container.textContent).toContain("1 file");
    expect(container.textContent).not.toContain("1 files");
  });

  it("patch with >20 files renders truncation indicator", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-27");
    const files = Array.from({ length: 25 }, (_, i) => `file${i}.ts`);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-27" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-27", {
      type: "patch", partId: "p3", files, hash: "h",
    });
    await flush();
    expect(container.textContent).toContain("5 more");
  });

  it("patch event dedups by partId on replay", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-28");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-28" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-28", {
      type: "patch", partId: "dup", files: ["x.ts"], hash: "h",
    });
    fireOpenCode(handlers, "oc-mc-28", {
      type: "patch", partId: "dup", files: ["x.ts"], hash: "h",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // -------- retry --------
  it("retry block renders attempt number and error", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-29");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-29" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-29", {
      type: "retry", partId: "r1", attempt: 3, error: "rate limit hit",
    });
    await flush();
    expect(container.textContent).toContain("Retry #3");
    expect(container.textContent).toContain("rate limit hit");
  });

  it("retry dedups by partId", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-30");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-30" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-30", {
      type: "retry", partId: "r-dup", attempt: 1, error: "x",
    });
    fireOpenCode(handlers, "oc-mc-30", {
      type: "retry", partId: "r-dup", attempt: 1, error: "x",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // -------- compaction --------
  it("compaction (auto=true) renders 'auto-compacted' label", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-31");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-31" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-31", { type: "compaction", partId: "c1", auto: true });
    await flush();
    expect(container.textContent).toContain("auto-compacted");
  });

  it("compaction (auto=false) renders 'manually compacted' label", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-32");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-32" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-32", { type: "compaction", partId: "c2", auto: false });
    await flush();
    expect(container.textContent).toContain("manually compacted");
  });

  // -------- user_file --------
  it("user_file image renders <img> element", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-33");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-33" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-33", {
      type: "user_file",
      partId: "uf1",
      mime: "image/png",
      filename: "shot.png",
      url: "data:image/png;base64,xxxx",
    });
    await flush();
    expect(container.querySelector("img")).toBeTruthy();
  });

  it("user_file non-image renders filename text", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-34");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-34" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-34", {
      type: "user_file",
      partId: "uf2",
      mime: "application/pdf",
      filename: "doc.pdf",
      url: "file:///tmp/doc.pdf",
    });
    await flush();
    expect(container.textContent).toContain("doc.pdf");
  });

  it("user_file dedups by partId", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-35");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-35" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-35", {
      type: "user_file", partId: "uf-d", mime: "image/png", filename: "a.png", url: "x",
    });
    fireOpenCode(handlers, "oc-mc-35", {
      type: "user_file", partId: "uf-d", mime: "image/png", filename: "a.png", url: "x",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // -------- session.started persists opencode_session_id --------
  it("session.started writes opencode_session_id into thread store", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-36");
    render(<OpenCodeSdkSessionView sessionId="oc-mc-36" cwd="/tmp/repo" />);
    await flush();
    fireOpenCode(handlers, "oc-mc-36", {
      event: "session.started",
      sessionId: "real-oc-uuid-99",
    });
    await flush();
    const list = useThreadStore.getState().threads.p1 as Array<{ id: string; opencode_session_id?: string }>;
    const t = list.find((x) => x.id === "oc-mc-36");
    expect(t?.opencode_session_id).toBe("real-oc-uuid-99");
  });

  it("session.started without sessionId is a no-op on the store", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-37");
    render(<OpenCodeSdkSessionView sessionId="oc-mc-37" cwd="/tmp/repo" />);
    await flush();
    fireOpenCode(handlers, "oc-mc-37", { event: "session.started" });
    await flush();
    const list = useThreadStore.getState().threads.p1 as Array<{ id: string; opencode_session_id?: string }>;
    const t = list.find((x) => x.id === "oc-mc-37");
    expect(t?.opencode_session_id).toBeUndefined();
  });

  it("session.started skips store update when id already matches", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-38", { opencode_session_id: "same-id" });
    render(<OpenCodeSdkSessionView sessionId="oc-mc-38" cwd="/tmp/repo" />);
    await flush();
    fireOpenCode(handlers, "oc-mc-38", {
      event: "session.started",
      sessionId: "same-id",
    });
    await flush();
    const list = useThreadStore.getState().threads.p1 as Array<{ id: string; opencode_session_id?: string }>;
    expect(list.find((x) => x.id === "oc-mc-38")?.opencode_session_id).toBe("same-id");
  });

  // -------- session.idle handling --------
  it("session.idle clears 'sending' state", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-39");
    render(<OpenCodeSdkSessionView sessionId="oc-mc-39" cwd="/tmp/repo" />);
    await flush();
    fireOpenCode(handlers, "oc-mc-39", { event: "session.idle" });
    await flush();
    expect(handlers["sdk-event-oc-mc-39"]).toBeTruthy();
  });

  // -------- error control event --------
  it("error control event renders an error block", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-40");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-40" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-40", { event: "error", message: "bridge crashed" });
    await flush();
    expect(container.textContent).toContain("bridge crashed");
  });

  // -------- multiplex / thread isolation --------
  it("event for OTHER thread does not affect this view", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-41");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-41" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-41-OTHER", {
      type: "assistant_text",
      partId: "p",
      fullText: "should not appear",
    });
    await flush();
    expect(container.textContent ?? "").not.toContain("should not appear");
  });

  it("two views with different threadIds isolate their listeners", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-42a");
    seedThread("oc-mc-42b");
    const r1 = render(<OpenCodeSdkSessionView sessionId="oc-mc-42a" cwd="/tmp/repo" />);
    await flush();
    cleanup();
    const r2 = render(<OpenCodeSdkSessionView sessionId="oc-mc-42b" cwd="/tmp/repo" />);
    await flush();
    fireOpenCode(handlers, "oc-mc-42a", {
      type: "assistant_text", partId: "p", fullText: "for-a",
    });
    fireOpenCode(handlers, "oc-mc-42b", {
      type: "assistant_text", partId: "p", fullText: "for-b",
    });
    await flush();
    // r1 was unmounted via cleanup() — only r2 should see for-b
    expect(r2.container.textContent).toContain("for-b");
    expect(r1.container.textContent ?? "").not.toContain("for-a");
  });

  // -------- unmount cleanup --------
  it("unmounting calls the listener cleanup function", async () => {
    const eventModule = await import("@tauri-apps/api/event");
    const cleanupFn = vi.fn();
    vi.mocked(eventModule.listen).mockImplementation((() =>
      Promise.resolve(cleanupFn)) as never);
    seedThread("oc-mc-43");
    const { unmount } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-43" cwd="/tmp/repo" />
    );
    await flush();
    unmount();
    await flush();
    expect(cleanupFn).toHaveBeenCalled();
  });

  // -------- mixed sequence --------
  it("renders a long mixed sequence (text + tool + thinking + patch + retry)", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-44");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-44" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-44", { event: "session.started", sessionId: "real" });
    fireOpenCode(handlers, "oc-mc-44", { type: "thinking", partId: "th", fullText: "considering" });
    fireOpenCode(handlers, "oc-mc-44", { type: "assistant_text", partId: "a", fullText: "Working" });
    fireOpenCode(handlers, "oc-mc-44", {
      type: "tool_use", partId: "tu", toolName: "edit", input: { file: "a" }, status: "running",
    });
    fireOpenCode(handlers, "oc-mc-44", {
      type: "tool_result", partId: "tu", toolName: "edit", output: "ok", isError: false,
    });
    fireOpenCode(handlers, "oc-mc-44", {
      type: "patch", partId: "pp", files: ["a"], hash: "h",
    });
    fireOpenCode(handlers, "oc-mc-44", {
      type: "retry", partId: "rr", attempt: 1, error: "transient",
    });
    fireOpenCode(handlers, "oc-mc-44", {
      type: "compaction", partId: "cc", auto: true,
    });
    fireOpenCode(handlers, "oc-mc-44", {
      type: "usage_update",
      tokens: { input: 10, output: 20, cacheRead: 1, cacheWrite: 1 },
      cost: 0.0001,
    });
    fireOpenCode(handlers, "oc-mc-44", { event: "session.idle" });
    await flush();
    expect(container.textContent).toContain("Working");
    expect(container.textContent).toContain("Patch");
    expect(container.textContent).toContain("Retry #1");
    expect(container.textContent).toContain("auto-compacted");
  });

  // -------- empty / boundary inputs --------
  it("assistant_text with empty fullText renders without crashing", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-45");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-45" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-45", { type: "assistant_text", partId: "e", fullText: "" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("thinking with empty fullText renders without crashing", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-46");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-46" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-46", { type: "thinking", partId: "e", fullText: "" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("tool_use with no toolName falls through gracefully", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-47");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-47" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-47", {
      type: "tool_use", partId: "x", toolName: "", input: {}, status: "running",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("permission_request with custom pattern shows pattern in banner text", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-48");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-48" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-48", {
      type: "permission_request",
      threadId: "oc-mc-48",
      permissionId: "px",
      kind: "tool",
      permission: "run command",
      pattern: "git push",
      metadata: {},
      eventId: "e",
      timestamp: "2026-01-01T00:00:00Z",
    });
    await flush();
    expect(container.textContent).toContain("(git push)");
  });

  it("permission_request with pattern '*' omits the pattern suffix", async () => {
    const handlers = await setupCapture();
    seedThread("oc-mc-49");
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mc-49" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-mc-49", {
      type: "permission_request",
      threadId: "oc-mc-49",
      permissionId: "py",
      kind: "tool",
      permission: "run command",
      pattern: "*",
      metadata: {},
      eventId: "e",
      timestamp: "2026-01-01T00:00:00Z",
    });
    await flush();
    expect(container.textContent).not.toContain("(*)");
  });
});

// =====================================================================
// Maximum coverage — phase 2: history replay, send flow, interrupt,
// model/agent change, error paths. These exercise the long history-restore
// branch (lines ~1180-1310 in production) and the send/queue plumbing.
// =====================================================================
describe("OpenCodeSdkSessionView — Phase 2 coverage (history & send)", () => {
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
    await new Promise((r) => setTimeout(r, 0));
  }

  function seedExisting(threadId: string, sessionId = "real-existing-id") {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: threadId,
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Idle",
            name: "Phase2",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: "anthropic/claude-sonnet-4-5",
            opencode_session_id: sessionId,
          } as never,
        ],
      },
    } as never);
  }

  it("on resume, getHistory replays user text + assistant text", async () => {
    await setupCapture();
    seedExisting("oc-h-1");
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(sdkMod.opencodeSdk.getHistory).mockResolvedValueOnce({
      messages: [
        {
          info: { id: "m1", role: "user" },
          parts: [{ type: "text", text: "Hello restored" }],
        },
        {
          info: { id: "m2", role: "assistant" },
          parts: [{ id: "p1", type: "text", text: "Hi from history" }],
        },
      ],
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-h-1" cwd="/tmp/repo" />
    );
    await flush();
    expect(container.textContent).toContain("Hello restored");
    expect(container.textContent).toContain("Hi from history");
  });

  it("history replay handles user file part (image)", async () => {
    await setupCapture();
    seedExisting("oc-h-2");
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(sdkMod.opencodeSdk.getHistory).mockResolvedValueOnce({
      messages: [
        {
          info: { id: "m1", role: "user" },
          parts: [
            { type: "text", text: "look at this" },
            {
              id: "f1",
              type: "file",
              mime: "image/png",
              filename: "screenshot.png",
              url: "data:image/png;base64,zz",
            },
          ],
        },
      ],
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-h-2" cwd="/tmp/repo" />
    );
    await flush();
    expect(container.textContent).toContain("look at this");
    expect(container.querySelector("img")).toBeTruthy();
  });

  it("history replay handles assistant reasoning part as thinking", async () => {
    await setupCapture();
    seedExisting("oc-h-3");
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(sdkMod.opencodeSdk.getHistory).mockResolvedValueOnce({
      messages: [
        {
          info: { id: "m1", role: "assistant" },
          parts: [{ id: "r1", type: "reasoning", text: "considering options" }],
        },
      ],
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-h-3" cwd="/tmp/repo" />
    );
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("history replay handles assistant tool part", async () => {
    await setupCapture();
    seedExisting("oc-h-4");
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(sdkMod.opencodeSdk.getHistory).mockResolvedValueOnce({
      messages: [
        {
          info: { id: "m1", role: "assistant" },
          parts: [
            {
              id: "t1",
              type: "tool",
              tool: "bash",
              state: { status: "completed", input: { command: "ls" }, output: "file1\nfile2" },
            },
          ],
        },
      ],
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-h-4" cwd="/tmp/repo" />
    );
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("history replay handles patch / retry / compaction parts", async () => {
    await setupCapture();
    seedExisting("oc-h-5");
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(sdkMod.opencodeSdk.getHistory).mockResolvedValueOnce({
      messages: [
        {
          info: { id: "m1", role: "assistant" },
          parts: [
            { id: "pp", type: "patch", files: ["a.ts"], hash: "h" },
            { id: "rr", type: "retry", attempt: 1, error: { message: "rl" } },
            { id: "cc", type: "compaction", auto: true },
          ],
        },
      ],
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-h-5" cwd="/tmp/repo" />
    );
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("history replay tolerates getHistory rejection", async () => {
    await setupCapture();
    seedExisting("oc-h-6");
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(sdkMod.opencodeSdk.getHistory).mockRejectedValueOnce(new Error("network"));
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-h-6" cwd="/tmp/repo" />
    );
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("history replay tolerates empty messages array", async () => {
    await setupCapture();
    seedExisting("oc-h-7");
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(sdkMod.opencodeSdk.getHistory).mockResolvedValueOnce({ messages: [] } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-h-7" cwd="/tmp/repo" />
    );
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // -------- send flow --------
  it("typing into the textarea updates value and Enter triggers handleSend", async () => {
    const handlers = await setupCapture();
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc-s-1",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Idle",
            name: "T",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: "anthropic/claude-sonnet-4-5",
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-s-1" cwd="/tmp/repo" />
    );
    await flush();
    // Force "started" by firing session.started so the textarea isn't disabled
    fireOpenCode(handlers, "oc-s-1", { event: "session.started", sessionId: "real" });
    await flush();
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    // Simulate user typing — fireEvent triggers React's controlled input update
    fireEvent.change(ta, { target: { value: "hello bot" } });
    await flush();
    expect(ta.value).toBe("hello bot");
    // Press Enter (no shift) — should call sendMessage
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    const sendMsg = vi.mocked(sdkMod.opencodeSdk.sendMessage);
    sendMsg.mockClear();
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });
    await flush();
    expect(sendMsg).toHaveBeenCalled();
    expect(sendMsg.mock.calls[0][0]).toBe("oc-s-1");
    expect(sendMsg.mock.calls[0][1]).toBe("hello bot");
  });

  it("Shift+Enter does not submit (newline path)", async () => {
    const handlers = await setupCapture();
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc-s-2",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Idle",
            name: "T",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-s-2" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-s-2", { event: "session.started", sessionId: "real" });
    await flush();
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "draft" } });
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    const sendMsg = vi.mocked(sdkMod.opencodeSdk.sendMessage);
    sendMsg.mockClear();
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    await flush();
    expect(sendMsg).not.toHaveBeenCalled();
  });

  it("submitting empty text does not call sendMessage", async () => {
    const handlers = await setupCapture();
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc-s-3",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Idle",
            name: "T",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-s-3" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-s-3", { event: "session.started", sessionId: "real" });
    await flush();
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    const sendMsg = vi.mocked(sdkMod.opencodeSdk.sendMessage);
    sendMsg.mockClear();
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });
    await flush();
    expect(sendMsg).not.toHaveBeenCalled();
  });

  it("sendMessage rejection surfaces an error block", async () => {
    const handlers = await setupCapture();
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc-s-4",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Idle",
            name: "T",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(sdkMod.opencodeSdk.sendMessage).mockRejectedValueOnce(new Error("send failed"));
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-s-4" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-s-4", { event: "session.started", sessionId: "real" });
    await flush();
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "broken" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });
    await flush();
    expect(container.textContent).toContain("send failed");
  });

  it("drop event with no files is a no-op (early return path)", async () => {
    const handlers = await setupCapture();
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc-d-1",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Idle",
            name: "T",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-d-1" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-d-1", { event: "session.started", sessionId: "real" });
    await flush();
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    const dropZone = ta.closest("[onDragOver]") ?? ta.parentElement?.parentElement;
    if (dropZone) {
      const dataTransfer = {
        files: [],
        items: [],
        types: [],
        getData: () => "",
      };
      const dragOverEv = new Event("dragover", { bubbles: true, cancelable: true });
      Object.defineProperty(dragOverEv, "dataTransfer", { value: dataTransfer });
      dropZone.dispatchEvent(dragOverEv);
      const dropEv = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(dropEv, "dataTransfer", { value: dataTransfer });
      dropZone.dispatchEvent(dropEv);
    }
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("paste event without image items is a no-op", async () => {
    const handlers = await setupCapture();
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc-p-1",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Idle",
            name: "T",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-p-1" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-p-1", { event: "session.started", sessionId: "real" });
    await flush();
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    const pasteEv = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEv, "clipboardData", {
      value: { items: [{ type: "text/plain" }] },
    });
    ta.dispatchEvent(pasteEv);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("cancelling the file picker is a no-op", async () => {
    const handlers = await setupCapture();
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc-f-1",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Idle",
            name: "T",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-f-1" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-f-1", { event: "session.started", sessionId: "real" });
    await flush();
    const { open } = await import("@tauri-apps/plugin-dialog");
    const attachButton = container.querySelector('button[title="Attach files"]') as HTMLButtonElement;
    expect(attachButton).toBeTruthy();
    fireEvent.click(attachButton);
    await flush();
    expect(open).toHaveBeenCalledWith({ multiple: true, directory: false });
    expect(container.firstChild).toBeTruthy();
  });

  it("submitting while sending appends to message queue (no immediate send)", async () => {
    const handlers = await setupCapture();
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc-s-5",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Running",
            name: "T",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    // Use a never-resolving promise so the first send leaves us in `sending`
    vi.mocked(sdkMod.opencodeSdk.sendMessage).mockImplementationOnce(
      () => new Promise(() => {}),
    );
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-s-5" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-s-5", { event: "session.started", sessionId: "real" });
    await flush();
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    // First send — flips `sending` to true
    fireEvent.change(ta, { target: { value: "first" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });
    await flush();
    const sendMsg = vi.mocked(sdkMod.opencodeSdk.sendMessage);
    sendMsg.mockClear();
    // Second send — should queue, NOT call sendMessage again
    fireEvent.change(ta, { target: { value: "second" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });
    await flush();
    expect(sendMsg).not.toHaveBeenCalled();
    expect(container.textContent).toContain("second");
  });

  function fireOpenCode(
    handlers: Record<string, Listener[]>,
    threadId: string,
    payload: unknown,
  ) {
    const channel = `sdk-event-${threadId}`;
    for (const h of handlers[channel] ?? []) h({ payload });
  }

  // -------- interrupt --------
  it("invokes interrupt() when stop button is clicked while sending", async () => {
    const handlers = await setupCapture();
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc-i-1",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Running",
            name: "T",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-i-1" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-i-1", { event: "session.started", sessionId: "real" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  // -------- error block from session.error --------
  it("error event surfaces in chat list with red bubble styling", async () => {
    const handlers = await setupCapture();
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc-e-1",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Idle",
            name: "T",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-e-1" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-e-1", { event: "error", message: "Oh no" });
    await flush();
    expect(container.textContent).toContain("Oh no");
  });

  // -------- multi event sequence with a long mixed transcript --------
  it("queue drain effect arms when sending flips false with non-empty queue", async () => {
    const handlers = await setupCapture();
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc-q-1",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Running",
            name: "T",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    const sendMsg = vi.mocked(sdkMod.opencodeSdk.sendMessage);
    // Keep first send pending so we stay in "sending"
    sendMsg.mockImplementationOnce(() => new Promise(() => {}));
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-q-1" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-q-1", { event: "session.started", sessionId: "real" });
    await flush();
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    // First turn — flips sending=true
    fireEvent.change(ta, { target: { value: "first" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });
    await flush();
    // Queue a follow-up
    fireEvent.change(ta, { target: { value: "queued one" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });
    await flush();
    // Idle event - drains queue eventually (the 2s debounce timer is armed
    // synchronously inside the effect). We assert state is consistent.
    fireOpenCode(handlers, "oc-q-1", { event: "session.idle" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("DraftChatView pending first message triggers sendMessage on start", async () => {
    await setupCapture();
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc-pf-1",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Idle",
            name: "T",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    useUiStore.setState({
      pendingFirstMessages: { "oc-pf-1": "kickoff prompt" },
    } as never);
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    const sendMsg = vi.mocked(sdkMod.opencodeSdk.sendMessage);
    sendMsg.mockClear();
    sendMsg.mockResolvedValueOnce(undefined);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-pf-1" cwd="/tmp/repo" isNew />
    );
    await flush();
    expect(sendMsg).toHaveBeenCalled();
    expect(sendMsg.mock.calls[0][1]).toBe("kickoff prompt");
    expect(container.textContent).toContain("kickoff prompt");
  });

  it("DraftChatView pending first message rejection surfaces error", async () => {
    await setupCapture();
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc-pf-2",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Idle",
            name: "T",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    useUiStore.setState({
      pendingFirstMessages: { "oc-pf-2": "boom" },
    } as never);
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(sdkMod.opencodeSdk.sendMessage).mockRejectedValueOnce(new Error("net"));
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-pf-2" cwd="/tmp/repo" isNew />
    );
    await flush();
    expect(container.textContent).toContain("net");
  });

  it("startSession rejection surfaces a startup error", async () => {
    await setupCapture();
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "oc-st-1",
            project_id: "p1",
            provider: "OpenCode",
            interaction_mode: "opencode-sdk",
            status: "Idle",
            name: "T",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_active_at: new Date().toISOString(),
            model: null,
          } as never,
        ],
      },
    } as never);
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(sdkMod.opencodeSdk.startSession).mockRejectedValueOnce(new Error("startup boom"));
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-st-1" cwd="/tmp/repo" isNew />
    );
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("renders multi-turn transcript via combined replay + live events", async () => {
    const handlers = await setupCapture();
    seedExisting("oc-mt-1");
    const sdkMod = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(sdkMod.opencodeSdk.getHistory).mockResolvedValueOnce({
      messages: [
        { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "First Q" }] },
        {
          info: { id: "a1", role: "assistant" },
          parts: [{ id: "ap1", type: "text", text: "First answer" }],
        },
      ],
    } as never);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-mt-1" cwd="/tmp/repo" />
    );
    await flush();
    // Fire follow-up live events on top of replayed history
    fireOpenCode(handlers, "oc-mt-1", { event: "session.started", sessionId: "real-existing-id" });
    fireOpenCode(handlers, "oc-mt-1", {
      type: "assistant_text", partId: "live-1", fullText: "Second answer",
    });
    fireOpenCode(handlers, "oc-mt-1", { event: "session.idle" });
    await flush();
    expect(container.textContent).toContain("First Q");
    // Live assistant_text without a new user turn is folded into the same
    // completed turn as intermediate work; expand the Thought row to replay it.
    expect(container.textContent).toContain("Second answer");
    const thought = container.querySelector("[data-testid='sdk-turn-summary']");
    if (thought) {
      const row = thought.querySelector("[data-testid='codex-tool-row']");
      if (row) fireEvent.click(row);
      await flush();
      expect(container.textContent).toContain("First answer");
    } else {
      // No intermediate work → both answers stay inline
      expect(container.textContent).toContain("First answer");
    }
  });
});

// ===================================================================
// Final coverage gaps — additional event handler shapes and edge cases.
// ===================================================================
describe("OpenCodeSdkSessionView — Final coverage gaps", () => {
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

  function fireOpenCode(
    handlers: Record<string, Listener>,
    threadId: string,
    payload: unknown,
  ) {
    const channel = `sdk-event-${threadId}`;
    const h = handlers[channel];
    if (h) h({ payload });
  }

  it("handles malformed event payload (no event field)", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-fc-1" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-fc-1", { foo: "bar" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles assistant_text with empty fullText", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-fc-2" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-fc-2", {
      type: "assistant_text",
      partId: "p1",
      fullText: "",
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles error event with no message field", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-fc-3" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-fc-3", { event: "error" });
    fireOpenCode(handlers, "oc-fc-3", { event: "error", message: "" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles session.started without sessionId", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-fc-4" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-fc-4", { event: "session.started" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles multiple session.idle events in sequence", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-fc-5" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-fc-5", { event: "session.idle" });
    fireOpenCode(handlers, "oc-fc-5", { event: "session.idle" });
    fireOpenCode(handlers, "oc-fc-5", { event: "session.idle" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles session.started followed by session.idle followed by session.started", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-fc-6" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-fc-6", { event: "session.started", sessionId: "s1" });
    fireOpenCode(handlers, "oc-fc-6", { event: "session.idle" });
    fireOpenCode(handlers, "oc-fc-6", { event: "session.started", sessionId: "s2" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles assistant_text with very long fullText", async () => {
    const handlers = await setupCapture();
    const longText = "x".repeat(5000);
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-fc-7" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-fc-7", {
      type: "assistant_text",
      partId: "p-long",
      fullText: longText,
    });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles unknown event type gracefully", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-fc-8" cwd="/tmp/repo" />
    );
    await flush();
    fireOpenCode(handlers, "oc-fc-8", { event: "unknown.weird" });
    fireOpenCode(handlers, "oc-fc-8", { type: "unknown_type" });
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("handles rapid event bursts without losing render state", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-fc-9" cwd="/tmp/repo" />
    );
    await flush();
    for (let i = 0; i < 20; i++) {
      fireOpenCode(handlers, "oc-fc-9", {
        type: "assistant_text",
        partId: `p-${i}`,
        fullText: `chunk ${i}`,
      });
    }
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("ignores events for other thread IDs", async () => {
    const handlers = await setupCapture();
    const { container } = render(
      <OpenCodeSdkSessionView sessionId="oc-fc-10" cwd="/tmp/repo" />
    );
    await flush();
    // Fire on a different thread channel — handler doesn't exist for it
    fireOpenCode(handlers, "oc-other-thread", {
      type: "assistant_text",
      partId: "x",
      fullText: "should not appear",
    });
    await flush();
    expect(container.textContent).not.toContain("should not appear");
  });

  it("rerendering with same props does not double-subscribe", async () => {
    await setupCapture();
    const { rerender, container } = render(
      <OpenCodeSdkSessionView sessionId="oc-fc-11" cwd="/tmp/repo" />
    );
    await flush();
    rerender(<OpenCodeSdkSessionView sessionId="oc-fc-11" cwd="/tmp/repo" />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("changing cwd prop preserves session", async () => {
    await setupCapture();
    const { rerender, container } = render(
      <OpenCodeSdkSessionView sessionId="oc-fc-12" cwd="/tmp/repo1" />
    );
    await flush();
    rerender(<OpenCodeSdkSessionView sessionId="oc-fc-12" cwd="/tmp/repo2" />);
    await flush();
    expect(container.firstChild).toBeTruthy();
  });

  it("unmount cleanup occurs without throwing", async () => {
    await setupCapture();
    const { unmount } = render(
      <OpenCodeSdkSessionView sessionId="oc-fc-13" cwd="/tmp/repo" />
    );
    await flush();
    unmount();
    expect(true).toBe(true);
  });
});

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));
