/** @vitest-environment jsdom */
/**
 * Denying a permission prompt with Enter ends Claude's turn without a Stop
 * hook; the terminal confirms the denial from the session transcript. After
 * /clear or /resume that must be the thread's current Claude session.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { readClaudeSessionHistory } from "../../../lib/commands";

vi.mock("../../taskview/TaskTerminalPrompt", () => ({
  TaskTerminalPrompt: ({ ready }: { ready: boolean }) => <div data-testid="task-prompt" data-ready={String(ready)} />,
}));

const terminalMocks = vi.hoisted(() => {
  const events: string[] = [];
  const refresh = vi.fn(() => {
    events.push("refresh");
  });
  const open = vi.fn();
  const focus = vi.fn();
  const write = vi.fn();
  const fit = vi.fn();
  const setRenderingPaused = vi.fn();
  const requestResizeRows = 24;
  const requestResizeCols = 80;
  const colorMode = { isLight: false, updates: false };

  return {
    colorMode,
    events,
    refresh,
    open,
    focus,
    write,
    fit,
    setRenderingPaused,
    requestResizeRows,
    requestResizeCols,
  };
});

vi.mock("../../ThemeProvider", () => ({
  MONO_FONT_MAP: { "geist-mono": "monospace" },
  useResolvedColorMode: () => terminalMocks.colorMode.isLight,
}));

vi.mock("../../../stores/settingsStore", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { monoFont: "geist-mono", terminalFontSize: 14 } }),
}));

const ui = vi.hoisted(() => ({
  state: {
    // After /clear the thread maps to its first and its current Claude session.
    claudeSessionMap: { "thread-1": ["old-session", "new-session"] } as Record<string, string[]>,
    pendingApprovalsBySession: { "new-session": { tool: "Bash" } } as Record<string, unknown>,
    claudeProcessingById: { "new-session": true } as Record<string, boolean>,
    transitionSession: vi.fn(),
    setClaudeProcessing: vi.fn(),
    setClaudeToolStatus: vi.fn(),
  },
  onData: null as ((data: string) => void) | null,
}));

vi.mock("../../../stores/uiStore", () => {
  const useUiStore = (selector: (state: unknown) => unknown) => selector(ui.state);
  useUiStore.getState = () => ui.state;
  return { useUiStore };
});

vi.mock("../../../stores/sessionNameStore", () => ({
  useSessionNameStore: {
    getState: () => ({ summarize: vi.fn() }),
  },
}));

vi.mock("../../../hooks/usePtyOutput", () => ({
  usePtyOutput: () => {},
}));

vi.mock("../../../hooks/useIsSessionActive", () => ({
  useIsSessionHiddenInPanes: () => false,
}));

vi.mock("../../../lib/commands", () => ({
  sendPtyInput: vi.fn().mockResolvedValue(undefined),
  sendPtyLine: vi.fn().mockResolvedValue(undefined),
  resizePty: vi.fn().mockResolvedValue(undefined),
  saveTempImage: vi.fn().mockResolvedValue("/tmp/image.png"),
  readClaudeSessionHistory: vi.fn().mockResolvedValue({ items: [] }),
  getPtySnapshot: vi.fn().mockResolvedValue({
    data: btoa("\u001b[?1049hready"),
    end_offset: 12,
  }),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn().mockResolvedValue(""),
}));

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn().mockResolvedValue("/Users/test"),
}));

vi.mock("../ImageAttachmentBar", () => ({
  extractImagesFromPaste: () => [],
  extractImagesFromDrop: () => [],
  extractFilePathsFromDrop: (e: DragEvent | React.DragEvent) => {
    const text = e.dataTransfer?.getData("text/plain") ?? "";
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  },
  fileToImageAttachment: vi.fn(),
}));

vi.mock("../../../lib/terminalLinks", () => ({
  makeFileLinks: () => [],
}));

vi.mock("../../../lib/xterm-loader", () => {
  const bundle = {
    term: {
      rows: terminalMocks.requestResizeRows,
      cols: terminalMocks.requestResizeCols,
      open: terminalMocks.open,
      focus: terminalMocks.focus,
      write: terminalMocks.write,
      refresh: terminalMocks.refresh,
      onData: vi.fn((fn: (data: string) => void) => { ui.onData = fn; return { dispose: vi.fn() }; }),
      onResize: vi.fn(() => ({ dispose: vi.fn() })),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      buffer: {
        active: {
          getLine: vi.fn(),
        },
      },
      options: {},
    },
    fit: { fit: terminalMocks.fit },
    canvas: null,
    serialize: {},
    search: {},
    writeBatched: vi.fn(),
    flushBatched: vi.fn(),
    setRenderingPaused: terminalMocks.setRenderingPaused,
    colorSchemeUpdates: () => terminalMocks.colorMode.updates,
    dispose: vi.fn(),
  };

  return {
    createXterm: vi.fn(() => bundle),
    attachCanvas: vi.fn(),
    decodeSnapshot: vi.fn(() => new Uint8Array([1, 2, 3])),
    prepareTerminalFont: vi.fn().mockResolvedValue(undefined),
    reattachCanvas: vi.fn(),
    lightTheme: vi.fn(() => ({})),
    darkTheme: vi.fn(() => ({})),
    colorSchemeReport: (isLight: boolean) => `report:${isLight ? "light" : "dark"}`,
  };
});

import { ClaudeTerminalView } from "../ClaudeTerminalView";

beforeEach(() => {
  vi.useFakeTimers();
  ui.onData = null;
  ui.state.transitionSession.mockClear();
  vi.mocked(readClaudeSessionHistory).mockReset().mockImplementation(async (sessionId: string) => ({
    items: sessionId === "new-session"
      ? [{
          itemType: "ToolResult",
          is_error: true,
          content: "The user doesn't want to proceed with this tool use.",
          timestamp: new Date(Date.now() + 1000).toISOString(),
        }]
      : [],
  }) as never);
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }),
  });
  global.ResizeObserver = vi.fn(function ResizeObserver() { return { observe: vi.fn(), disconnect: vi.fn() }; }) as unknown as typeof ResizeObserver;
  global.IntersectionObserver = vi.fn(function IntersectionObserver() { return { observe: vi.fn(), disconnect: vi.fn() }; }) as unknown as typeof IntersectionObserver;
  global.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 0)) as unknown as typeof requestAnimationFrame;
  global.cancelAnimationFrame = vi.fn((id: number) => { clearTimeout(id); }) as unknown as typeof cancelAnimationFrame;
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("terminal approval denial", () => {
  it("reads the current Claude session after /clear and clears the approval", async () => {
    render(<ClaudeTerminalView threadId="thread-1" projectPath="/tmp/repo" status="Running" isActive />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(ui.onData).not.toBeNull();

    await act(async () => {
      ui.onData!("\r");
      await vi.advanceTimersByTimeAsync(2100);
    });

    expect(readClaudeSessionHistory).toHaveBeenCalledWith("new-session", "/tmp/repo");
    expect(ui.state.transitionSession).toHaveBeenCalledWith("thread-1", { type: "user_responded" });
  });
});
