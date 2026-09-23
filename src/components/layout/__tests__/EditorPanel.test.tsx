/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/commands", () => ({
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  listDirectory: vi.fn().mockResolvedValue([]),
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../editor/CodeEditor", () => ({
  CodeEditor: ({ filePath }: { filePath: string }) => (
    <div data-testid="code-editor">{filePath}</div>
  ),
}));

vi.mock("../../editor/EditorTabs", () => ({
  EditorTabs: () => <div data-testid="editor-tabs" />,
}));

vi.mock("../../editor/FileTree", () => ({
  FileTree: ({ rootPath }: { rootPath: string }) => (
    <div data-testid="file-tree">{rootPath}</div>
  ),
}));

import { EditorPanel } from "../EditorPanel";
import { SessionPanelsContext } from "../../thread/SessionPanelsContext";
import { useUiStore } from "../../../stores/uiStore";
import { useEditorStore } from "../../../stores/editorStore";
import { useThreadStore } from "../../../stores/threadStore";
import { useTaskViewStore } from "../../../stores/taskViewStore";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  useEditorStore.setState({
    openTabs: [],
    activeTabPath: null,
    dirtyFiles: {},
    rawMode: {},
    aiEditedFiles: {},
  });
  useThreadStore.setState({ threads: {} });
  useTaskViewStore.setState({ tasks: {}, selectedTaskId: null });
  useUiStore.setState({
    editorPanelOpen: false,
    fileTreeVisible: true,
    selectedThreadId: null,
    selectedClaudeSessionCwd: null,
    selectedCodexSessionCwd: null,
    draftChat: null,
    appMode: "agent",
  });
});

describe("EditorPanel", () => {
  it("does not mount a second editor inside a task session", () => {
    useUiStore.setState({ editorPanelOpen: true, selectedClaudeSessionCwd: "/repo" });
    const { container } = render(
      <SessionPanelsContext.Provider value={{ gitSidebarOpen: false, terminalOpen: false, onToggleGitSidebar: vi.fn(), onToggleTerminal: vi.fn() }}>
        <EditorPanel />
      </SessionPanelsContext.Provider>,
    );
    expect(container.firstChild).toBeNull();
  });
  it("returns null when editorPanelOpen is false", () => {
    useUiStore.setState({ editorPanelOpen: false });
    const { container } = render(<EditorPanel />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the placeholder when editor is open without a rootPath", async () => {
    useUiStore.setState({
      editorPanelOpen: true,
      selectedThreadId: null,
      selectedClaudeSessionCwd: null,
      selectedCodexSessionCwd: null,
      draftChat: null,
    });
    render(<EditorPanel />);
    await waitFor(() => {
      expect(
        screen.queryByText(/Open a project or session to browse files/i),
      ).toBeTruthy();
    });
  });

  it("renders the FileTree when a session cwd is selected", async () => {
    useUiStore.setState({
      editorPanelOpen: true,
      selectedThreadId: null,
      selectedClaudeSessionCwd: "/repo/cwd",
      selectedCodexSessionCwd: null,
      draftChat: null,
    });
    render(<EditorPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("file-tree").textContent).toBe("/repo/cwd");
    });
  });

  it("renders CodeEditor when there is an activeTabPath", async () => {
    useUiStore.setState({
      editorPanelOpen: true,
      selectedClaudeSessionCwd: "/repo/cwd",
    });
    useEditorStore.setState({
      openTabs: [{ path: "/repo/cwd/foo.ts", name: "foo.ts" } as any],
      activeTabPath: "/repo/cwd/foo.ts",
    });
    render(<EditorPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("code-editor").textContent).toBe(
        "/repo/cwd/foo.ts",
      );
    });
  });

  it("uses Codex session cwd as fallback when Claude cwd is null", async () => {
    useUiStore.setState({
      editorPanelOpen: true,
      selectedThreadId: null,
      selectedClaudeSessionCwd: null,
      selectedCodexSessionCwd: "/codex/path",
      draftChat: null,
    });
    render(<EditorPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("file-tree").textContent).toBe("/codex/path");
    });
  });

  it("renders the EditorTabs when at least one tab is open", async () => {
    useUiStore.setState({
      editorPanelOpen: true,
      selectedClaudeSessionCwd: "/repo",
    });
    useEditorStore.setState({
      openTabs: [{ path: "/repo/a.ts", name: "a.ts" } as any],
      activeTabPath: "/repo/a.ts",
    });
    render(<EditorPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("editor-tabs")).toBeTruthy();
    });
  });

  it("renders only FileTree when there are no open tabs but a cwd is set", async () => {
    useUiStore.setState({
      editorPanelOpen: true,
      selectedClaudeSessionCwd: "/repo",
    });
    useEditorStore.setState({ openTabs: [], activeTabPath: null });
    render(<EditorPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("file-tree")).toBeTruthy();
    });
    expect(screen.queryByTestId("code-editor")).toBeNull();
  });

  it("hides the FileTree when a file is open and fileTreeVisible is false", async () => {
    useUiStore.setState({
      editorPanelOpen: true,
      fileTreeVisible: false,
      selectedClaudeSessionCwd: "/repo",
    });
    useEditorStore.setState({
      openTabs: [{ path: "/repo/notes.md", name: "notes.md" } as any],
      activeTabPath: "/repo/notes.md",
    });
    render(<EditorPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("code-editor").textContent).toBe("/repo/notes.md");
    });
    expect(screen.queryByTestId("file-tree")).toBeNull();
  });

  it("closes the panel when the last file tab closes and the tree is hidden", async () => {
    useUiStore.setState({
      appMode: "cowork",
      editorPanelOpen: true,
      fileTreeVisible: false,
      selectedClaudeSessionCwd: "/repo",
    });
    useEditorStore.setState({
      openTabs: [{ path: "/repo/notes.md", name: "notes.md" } as any],
      activeTabPath: "/repo/notes.md",
    });
    render(<EditorPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("code-editor")).toBeTruthy();
    });
    useEditorStore.setState({ openTabs: [], activeTabPath: null });
    await waitFor(() => {
      expect(useUiStore.getState().editorPanelOpen).toBe(false);
      expect(useUiStore.getState().fileTreeVisible).toBe(true);
    });
  });
});
