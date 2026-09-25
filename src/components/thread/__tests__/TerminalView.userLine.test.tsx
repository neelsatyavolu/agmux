/** @vitest-environment jsdom */
/**
 * Codex terminal titles come from the line the user types (onUserLine).
 * Cursor/history keys arrive as escape sequences and must not leak into it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const terminalMocks = vi.hoisted(() => ({
  writeBatched: vi.fn(),
  flush: vi.fn(),
  reset: vi.fn(),
  parsed: null as (() => void) | null,
}));

let termOnData: ((data: string) => void) | null = null;

vi.mock("../../ThemeProvider", () => ({
  MONO_FONT_MAP: { "geist-mono": "monospace" },
  useResolvedColorMode: () => false,
}));
vi.mock("../../../stores/settingsStore", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { monoFont: "geist-mono", terminalFontSize: 14 } }),
}));
vi.mock("../../../stores/uiStore", () => ({
  useUiStore: (selector: (state: unknown) => unknown) =>
    selector({ claudeSessionMap: {}, pendingApprovalsBySession: {}, claudeProcessingById: {} }),
}));
vi.mock("../../../hooks/usePtyOutput", () => ({
  usePtyOutput: () => {},
}));
vi.mock("../../../hooks/useIsSessionActive", () => ({ useIsSessionHiddenInPanes: () => false }));
vi.mock("../../../hooks/useNativeFileDrop", () => ({ useNativeFileDrop: () => {} }));
const getPtySnapshot = vi.fn();
vi.mock("../../../lib/commands", () => ({
  sendPtyInput: vi.fn().mockResolvedValue(undefined),
  resizePty: vi.fn().mockResolvedValue(undefined),
  getPtySnapshot: (...args: unknown[]) => getPtySnapshot(...args),
  saveTempImage: vi.fn().mockResolvedValue("/tmp/image.png"),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText: vi.fn().mockResolvedValue("") }));
vi.mock("../../../lib/terminalLinks", () => ({ makeFileLinks: () => [], getCachedHomeDir: () => "/Users/test" }));
vi.mock("../../../lib/xterm-loader", () => {
  const bundle = {
    term: {
      rows: 24, cols: 80, open: vi.fn(), focus: vi.fn(), write: vi.fn(),
      reset: terminalMocks.reset, refresh: vi.fn(),
      onWriteParsed: vi.fn((fn: () => void) => { terminalMocks.parsed = fn; return { dispose: vi.fn() }; }),
      onData: vi.fn((fn: (data: string) => void) => { termOnData = fn; return { dispose: vi.fn() }; }),
      onResize: vi.fn(() => ({ dispose: vi.fn() })),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      attachCustomWheelEventHandler: vi.fn(),
      buffer: { active: { baseY: 0, getLine: () => ({ translateToString: () => "" }) } },
      options: {},
    },
    fit: { fit: vi.fn() }, canvas: null, serialize: {}, search: {},
    writeBatched: terminalMocks.writeBatched, flushBatched: terminalMocks.flush,
    setRenderingPaused: vi.fn(), dispose: vi.fn(),
  };
  return {
    createXterm: vi.fn(() => bundle), attachCanvas: vi.fn(),
    decodeSnapshot: vi.fn((data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0))),
    prepareTerminalFont: vi.fn().mockResolvedValue(undefined), reattachCanvas: vi.fn(),
    lightTheme: vi.fn(() => ({})), darkTheme: vi.fn(() => ({})), FLUSH_TERMINAL_BG_DARK: "#141414",
  };
});

import { TerminalView } from "../TerminalView";

beforeEach(() => {
  vi.useFakeTimers();
  termOnData = null;
  terminalMocks.writeBatched.mockClear();
  terminalMocks.flush.mockClear();
  getPtySnapshot.mockReset().mockResolvedValue({ data: "", end_offset: 0 });
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

describe("Codex terminal typed line", () => {
  async function renderTerminal() {
    const onUserLine = vi.fn();
    render(
      <TerminalView threadId="codex-1" status="Running" provider="Codex" isActive
        onUserLine={onUserLine} />,
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(termOnData).not.toBeNull();
    return onUserLine;
  }

  it("drops arrow-key and word-jump sequences from the reported line", async () => {
    const onUserLine = await renderTerminal();
    act(() => {
      termOnData!("fix lgin");
      termOnData!("\x1b[D\x1b[D\x1b[D");
      termOnData!("o");
      termOnData!("\x1bOC");
      termOnData!("\x1bb");
      termOnData!("\r");
    });
    expect(onUserLine).toHaveBeenCalledWith("fix lgino");
  });

  it("reports a submit of a recalled history prompt with no typed text", async () => {
    const onUserLine = await renderTerminal();
    act(() => {
      termOnData!("\r");
      termOnData!("\x1b[A");
      termOnData!("\r");
    });
    // The bare Enter is not a submission; the recalled prompt is.
    expect(onUserLine.mock.calls).toEqual([[""]]);
  });
});
