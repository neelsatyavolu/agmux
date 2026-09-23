/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

// Mock heavy session-view children to keep this test focused on SplitPane.
vi.mock("../PaneTabBar", () => ({
  PaneTabBar: ({ paneId }: { paneId: string }) => (
    <div data-testid="pane-tab-bar">{paneId}</div>
  ),
}));
vi.mock("../../thread/ThreadView", () => ({
  ThreadView: () => <div data-testid="thread-view" />,
}));
vi.mock("../../thread/ClaudeSessionView", () => ({
  ClaudeSessionView: () => <div data-testid="claude-session-view" />,
}));
vi.mock("../../thread/CodexSessionView", () => ({
  CodexSessionView: () => <div data-testid="codex-session-view" />,
}));
vi.mock("../../thread/AgentTerminalView", () => ({
  AgentTerminalView: () => <div data-testid="agent-terminal-view" />,
}));
vi.mock("../../thread/DraftChatView", () => ({
  DraftChatView: () => <div data-testid="draft-chat-view" />,
}));
vi.mock("../../thread/OpenCodeSdkSessionView", () => ({
  OpenCodeSdkSessionView: () => <div data-testid="opencode-sdk-session-view" />,
}));

import { SplitPane } from "../SplitPane";
import { useSplitViewStore } from "../../../stores/splitViewStore";
import { useUiStore } from "../../../stores/uiStore";

afterEach(() => cleanup());

function setPane(paneId: string, pane: any) {
  useSplitViewStore.setState({
    panes: { [paneId]: pane },
    layout: { type: "pane", paneId },
    focusedPaneId: paneId,
  });
}

describe("SplitPane", () => {
  it("renders the empty state when pane has no tabs", () => {
    const id = "p-empty";
    setPane(id, { id, tabs: [], activeTabId: null });
    const { getByText } = render(<SplitPane paneId={id} />);
    expect(getByText("No tab open")).toBeTruthy();
  });

  it("renders ClaudeSessionView for a 'claude' tab", () => {
    const id = "p-claude";
    setPane(id, {
      id,
      tabs: [
        {
          id: "tab-1",
          type: "claude",
          claudeSessionId: "s1",
          claudeSessionCwd: "/repo",
          label: "Claude",
        },
      ],
      activeTabId: "tab-1",
    });
    const { getByTestId } = render(<SplitPane paneId={id} />);
    expect(getByTestId("claude-session-view")).toBeTruthy();
  });

  it("renders CodexSessionView for a 'codex' tab", () => {
    const id = "p-codex";
    setPane(id, {
      id,
      tabs: [
        {
          id: "tab-1",
          type: "codex",
          codexSessionId: "c1",
          label: "Codex",
        },
      ],
      activeTabId: "tab-1",
    });
    const { getByTestId } = render(<SplitPane paneId={id} />);
    expect(getByTestId("codex-session-view")).toBeTruthy();
  });

  it("renders AgentTerminalView for a 'terminal' tab", () => {
    const id = "p-term";
    setPane(id, {
      id,
      tabs: [
        {
          id: "tab-1",
          type: "terminal",
          terminalSessionId: "t1",
          terminalSessionCwd: "/repo",
          label: "Term",
        },
      ],
      activeTabId: "tab-1",
    });
    const { getByTestId } = render(<SplitPane paneId={id} />);
    expect(getByTestId("agent-terminal-view")).toBeTruthy();
  });

  it("calls setFocusedPane on click when not focused", () => {
    const id = "p-focus";
    setPane(id, { id, tabs: [], activeTabId: null });
    useSplitViewStore.setState({ focusedPaneId: "another-pane" });
    const setFocusedSpy = vi.spyOn(
      useSplitViewStore.getState(),
      "setFocusedPane",
    );
    const { container } = render(<SplitPane paneId={id} />);
    fireEvent.click(container.firstChild as HTMLElement);
    expect(setFocusedSpy).toHaveBeenCalledWith(id);
  });

  it("renders DraftChatView when tab type=draft and draftChat is set", () => {
    const id = "p-draft";
    setPane(id, {
      id,
      tabs: [{ id: "tab-1", type: "draft", label: "Draft" }],
      activeTabId: "tab-1",
    });
    useUiStore.setState({
      draftChat: { repoPath: "/repo", projectId: "p1" } as any,
    });
    const { getByTestId } = render(<SplitPane paneId={id} />);
    expect(getByTestId("draft-chat-view")).toBeTruthy();
  });
});
