/** @vitest-environment jsdom */
/**
 * The typed prompt draft names the session. Text cleared from Claude's
 * input box with Ctrl+C must not become part of that name.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

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
    claudeSessionMap: {} as Record<string, string[]>,
    pendingApprovalsBySession: {} as Record<string, unknown>,
    claudeProcessingById: {} as Record<string, boolean>,
    transitionSession: vi.fn(),
    setClaudeProcessing: vi.fn(),
    setClaudeToolStatus: vi.fn(),
  },
  onData: null as ((data: string) => void) | null,
  summarize: vi.fn(),
}));

vi.mock("../../../stores/uiStore", () => {
  const useUiStore = (selector: (state: unknown) => unknown) => selector(ui.state);
  useUiStore.getState = () => ui.state;
  return { useUiStore };
});

vi.mock("../../../stores/sessionNameStore", () => ({
  useSessionNameStore: {
    getState: () => ({ summarize: ui.summarize }),
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
  ui.summarize.mockClear();
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

describe("Claude terminal prompt draft", () => {
  it("drops text cleared with Ctrl+C before the prompt is sent", async () => {
    render(<ClaudeTerminalView threadId="thread-1" projectPath="/tmp/repo" status="Running" isActive />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(ui.onData).not.toBeNull();

    act(() => {
      ui.onData!("refactor db");
      ui.onData!("\x03");
      ui.onData!("fix login bug");
      ui.onData!("\r");
    });

    expect(ui.summarize).toHaveBeenCalledWith("thread-1", "fix login bug");
  });
});
