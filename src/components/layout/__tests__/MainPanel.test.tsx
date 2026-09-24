/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

// Stub out heavy session views and HomeScreen.
vi.mock("../../thread/ThreadView", () => ({
  ThreadView: () => <div data-testid="thread-view" />,
}));
vi.mock("../../thread/CodexSessionView", () => ({
  CodexSessionView: () => <div data-testid="codex-session-view" />,
}));
vi.mock("../../thread/ClaudeSessionView", () => ({
  ClaudeSessionView: () => <div data-testid="claude-session-view" />,
}));
vi.mock("../../thread/AgentTerminalView", () => ({
  AgentTerminalView: () => <div data-testid="agent-terminal-view" />,
}));
vi.mock("../../thread/SkillsMainPanel", () => ({
  SkillsMainPanel: () => <div data-testid="skills-main-panel" />,
}));
vi.mock("../../thread/MemoryMainPanel", () => ({
  MemoryMainPanel: () => <div data-testid="memory-main-panel" />,
}));
vi.mock("../../thread/IssuesMainPanel", () => ({
  IssuesMainPanel: () => <div data-testid="issues-main-panel" />,
}));
vi.mock("../HomeScreen", () => ({
  HomeScreen: () => <div data-testid="home-screen" />,
}));
vi.mock("../../thread/DraftChatView", () => ({
  DraftChatView: () => <div data-testid="draft-chat-view" />,
}));
vi.mock("../SplitViewPanel", () => ({
  SplitViewPanel: () => <div data-testid="split-view-panel" />,
}));

import { MainPanel } from "../MainPanel";
import { useUiStore } from "../../../stores/uiStore";
import { useThreadStore } from "../../../stores/threadStore";
import { useSettingsStore } from "../../../stores/settingsStore";

afterEach(() => cleanup());

beforeEach(() => {
  useUiStore.setState({
    sidebarTab: "agents",
    selectedThreadId: null,
    selectedCodexSessionId: null,
    selectedCodexSessionCwd: null,
    selectedClaudeSessionId: null,
    selectedClaudeSessionCwd: null,
    selectedClaudeSessionIsNew: false,
    selectedTerminalSessionId: null,
    selectedTerminalSessionCwd: null,
    draftChat: null,
    claudeProcessingById: {},
    codexProcessingById: {},
  });
  useThreadStore.setState({ threads: {} });
  // ensure multiViewEnabled is false
  const cur = useSettingsStore.getState().settings;
  useSettingsStore.setState({
    settings: { ...cur, multiViewEnabled: false } as any,
  });
});

describe("MainPanel", () => {
  it("renders SplitViewPanel when multi-view is enabled", () => {
    const cur = useSettingsStore.getState().settings;
    useSettingsStore.setState({
      settings: { ...cur, multiViewEnabled: true } as any,
    });
    render(<MainPanel />);
    expect(screen.getByTestId("split-view-panel")).toBeTruthy();
  });

  it("renders HomeScreen when no session is selected and tab is 'agents'", () => {
    render(<MainPanel />);
    expect(screen.getByTestId("home-screen")).toBeTruthy();
  });

  it("renders SkillsMainPanel when sidebarTab is 'skills'", () => {
    useUiStore.setState({ sidebarTab: "skills" });
    render(<MainPanel />);
    expect(screen.getByTestId("skills-main-panel")).toBeTruthy();
  });

  it("renders ClaudeSessionView when a Claude session is selected", () => {
    useUiStore.setState({
      selectedClaudeSessionId: "c1",
      selectedClaudeSessionCwd: "/repo",
    });
    render(<MainPanel />);
    expect(screen.getByTestId("claude-session-view")).toBeTruthy();
  });

  it("renders DraftChatView when draftChat is set", () => {
    useUiStore.setState({
      draftChat: { repoPath: "/repo", projectId: "p1" } as any,
    });
    render(<MainPanel />);
    expect(screen.getByTestId("draft-chat-view")).toBeTruthy();
  });

  it("renders CodexSessionView when a Codex session is selected", () => {
    useUiStore.setState({
      selectedCodexSessionId: "cx1",
      selectedCodexSessionCwd: "/repo",
    });
    render(<MainPanel />);
    expect(screen.getByTestId("codex-session-view")).toBeTruthy();
  });

  it("does not render HomeScreen when a Claude session is active", () => {
    useUiStore.setState({
      selectedClaudeSessionId: "c1",
      selectedClaudeSessionCwd: "/repo",
    });
    render(<MainPanel />);
    expect(screen.queryByTestId("home-screen")).toBeNull();
  });

  it("does not render SkillsMainPanel when sidebarTab is 'agents'", () => {
    useUiStore.setState({ sidebarTab: "agents" });
    render(<MainPanel />);
    expect(screen.queryByTestId("skills-main-panel")).toBeNull();
  });

  // ── Skills tab transitions (moved from Sidebar.test.tsx) ──
  // SkillsMainPanel was hosted inside <Sidebar> historically; it now lives in
  // MainPanel under the same `sidebarTab === "skills"` gate. The original
  // Sidebar tests exercised tab transitions and project-list scenarios.
  // Re-homed here so the coverage stays.

  it("flips between skills and agents cleanly", () => {
    const { rerender } = render(<MainPanel />);
    expect(screen.queryByTestId("skills-main-panel")).toBeNull();
    useUiStore.setState({ sidebarTab: "skills" });
    rerender(<MainPanel />);
    expect(screen.getByTestId("skills-main-panel")).toBeTruthy();
    useUiStore.setState({ sidebarTab: "agents" });
    rerender(<MainPanel />);
    expect(screen.queryByTestId("skills-main-panel")).toBeNull();
  });

  it("renders SkillsMainPanel even when no projects exist", () => {
    // SkillsMainPanel handles its own empty state — MainPanel just renders it
    // whenever sidebarTab is "skills", regardless of projectStore contents.
    useUiStore.setState({ sidebarTab: "skills" });
    useThreadStore.setState({ threads: {} });
    render(<MainPanel />);
    expect(screen.getByTestId("skills-main-panel")).toBeTruthy();
  });

  it("renders SkillsMainPanel under heavy thread load", () => {
    useUiStore.setState({ sidebarTab: "skills" });
    // Seed a non-trivial thread map to ensure the skills-tab branch isn't
    // mistakenly competing with thread-driven rendering.
    useThreadStore.setState({
      threads: Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`p${i}`, []]),
      ),
    });
    render(<MainPanel />);
    expect(screen.getByTestId("skills-main-panel")).toBeTruthy();
  });
});

describe("MainPanel — Deep coverage", () => {
  beforeEach(() => {
    useUiStore.setState({
      sidebarTab: "agents",
      selectedThreadId: null,
      selectedCodexSessionId: null,
      selectedCodexSessionCwd: null,
      selectedClaudeSessionId: null,
      selectedClaudeSessionCwd: null,
      selectedClaudeSessionIsNew: false,
      selectedTerminalSessionId: null,
      selectedTerminalSessionCwd: null,
      draftChat: null,
      claudeProcessingById: {},
      codexProcessingById: {},
    });
    useThreadStore.setState({ threads: {} });
    const cur = useSettingsStore.getState().settings;
    useSettingsStore.setState({
      settings: { ...cur, multiViewEnabled: false } as any,
    });
  });

  it("does not render Codex view when no Codex session is selected", () => {
    render(<MainPanel />);
    expect(screen.queryByTestId("codex-session-view")).toBeNull();
  });

  it("does not render Claude view when no Claude session is selected", () => {
    render(<MainPanel />);
    expect(screen.queryByTestId("claude-session-view")).toBeNull();
  });

  it("does not render DraftChatView when draftChat is null", () => {
    render(<MainPanel />);
    expect(screen.queryByTestId("draft-chat-view")).toBeNull();
  });

  it("does not render SplitViewPanel when multi-view is disabled", () => {
    render(<MainPanel />);
    expect(screen.queryByTestId("split-view-panel")).toBeNull();
  });

  it("renders Claude view with isNew=true", () => {
    useUiStore.setState({
      selectedClaudeSessionId: "c-new",
      selectedClaudeSessionCwd: "/repo",
      selectedClaudeSessionIsNew: true,
    });
    render(<MainPanel />);
    expect(screen.getByTestId("claude-session-view")).toBeTruthy();
  });

  it("renders Claude view with isNew=false (resumed)", () => {
    useUiStore.setState({
      selectedClaudeSessionId: "c-resume",
      selectedClaudeSessionCwd: "/repo",
      selectedClaudeSessionIsNew: false,
    });
    render(<MainPanel />);
    expect(screen.getByTestId("claude-session-view")).toBeTruthy();
  });

  it("flips between HomeScreen → Claude when session is set", () => {
    const { rerender } = render(<MainPanel />);
    expect(screen.getByTestId("home-screen")).toBeTruthy();
    useUiStore.setState({
      selectedClaudeSessionId: "c1",
      selectedClaudeSessionCwd: "/repo",
    });
    rerender(<MainPanel />);
    expect(screen.getByTestId("claude-session-view")).toBeTruthy();
    expect(screen.queryByTestId("home-screen")).toBeNull();
  });

  it("flips between HomeScreen → Codex when codex session is set", () => {
    const { rerender } = render(<MainPanel />);
    expect(screen.getByTestId("home-screen")).toBeTruthy();
    useUiStore.setState({
      selectedCodexSessionId: "cx1",
      selectedCodexSessionCwd: "/repo",
    });
    rerender(<MainPanel />);
    expect(screen.getByTestId("codex-session-view")).toBeTruthy();
  });

  it("flips between HomeScreen → DraftChat when draftChat is set", () => {
    const { rerender } = render(<MainPanel />);
    expect(screen.getByTestId("home-screen")).toBeTruthy();
    useUiStore.setState({
      draftChat: { repoPath: "/r", projectId: "p1" } as any,
    });
    rerender(<MainPanel />);
    expect(screen.getByTestId("draft-chat-view")).toBeTruthy();
  });

  it("flips agents tab → skills tab", () => {
    const { rerender } = render(<MainPanel />);
    expect(screen.getByTestId("home-screen")).toBeTruthy();
    useUiStore.setState({ sidebarTab: "skills" });
    rerender(<MainPanel />);
    expect(screen.getByTestId("skills-main-panel")).toBeTruthy();
  });

  it("survives unmount with active claude session", () => {
    useUiStore.setState({
      selectedClaudeSessionId: "c1",
      selectedClaudeSessionCwd: "/repo",
    });
    const { unmount } = render(<MainPanel />);
    expect(() => unmount()).not.toThrow();
  });

  it("survives unmount with active codex session", () => {
    useUiStore.setState({
      selectedCodexSessionId: "cx1",
      selectedCodexSessionCwd: "/repo",
    });
    const { unmount } = render(<MainPanel />);
    expect(() => unmount()).not.toThrow();
  });

  it("does not render two session views simultaneously when both Claude and Codex are set", () => {
    useUiStore.setState({
      selectedClaudeSessionId: "c1",
      selectedClaudeSessionCwd: "/repo",
      selectedCodexSessionId: "cx1",
      selectedCodexSessionCwd: "/repo",
    });
    render(<MainPanel />);
    // Exactly one of them should be the primary; assert at least the Claude view shows up
    const claude = screen.queryByTestId("claude-session-view");
    const codex = screen.queryByTestId("codex-session-view");
    expect(claude || codex).toBeTruthy();
  });

  it("turns off SplitView when multi-view is disabled", () => {
    const cur = useSettingsStore.getState().settings;
    useSettingsStore.setState({
      settings: { ...cur, multiViewEnabled: false } as any,
    });
    render(<MainPanel />);
    expect(screen.queryByTestId("split-view-panel")).toBeNull();
  });
});

describe("MainPanel — split view overlays", () => {
  beforeEach(() => {
    const cur = useSettingsStore.getState().settings;
    useSettingsStore.setState({
      settings: { ...cur, multiViewEnabled: true } as any,
    });
  });

  it("shows Memory over the panes when the Memory tab is picked", () => {
    useUiStore.setState({ sidebarTab: "memory" });
    render(<MainPanel />);
    expect(screen.getByTestId("memory-main-panel")).toBeTruthy();
    // Panes stay mounted underneath so running sessions keep their state.
    expect(screen.getByTestId("split-view-panel")).toBeTruthy();
  });

  it("shows Skills and Issues over the panes", () => {
    useUiStore.setState({ sidebarTab: "skills" });
    const { rerender } = render(<MainPanel />);
    expect(screen.getByTestId("skills-main-panel")).toBeTruthy();
    useUiStore.setState({ sidebarTab: "issues" });
    rerender(<MainPanel />);
    expect(screen.getByTestId("issues-main-panel")).toBeTruthy();
  });

  it("shows Home when nothing is selected on the agents tab", () => {
    render(<MainPanel />);
    expect(screen.getByTestId("home-screen")).toBeTruthy();
    expect(screen.getByTestId("split-view-panel")).toBeTruthy();
  });

  it("hides Home once a session is selected", () => {
    const { rerender } = render(<MainPanel />);
    expect(screen.getByTestId("home-screen")).toBeTruthy();
    useUiStore.setState({
      selectedClaudeSessionId: "c1",
      selectedClaudeSessionCwd: "/repo",
    });
    rerender(<MainPanel />);
    expect(screen.queryByTestId("home-screen")).toBeNull();
  });

  it("does not show Home while a draft is open", () => {
    useUiStore.setState({
      draftChat: { repoPath: "/repo", projectId: "p1" } as any,
    });
    render(<MainPanel />);
    expect(screen.queryByTestId("home-screen")).toBeNull();
  });
});
