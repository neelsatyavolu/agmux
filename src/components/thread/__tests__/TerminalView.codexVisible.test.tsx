/** @vitest-environment jsdom */
/**
 * A visible Codex terminal (permission observer attached, held loading until
 * ready) must write live output into xterm and reveal — regression for the
 * black-terminal report after hidden-Codex output skipping was introduced.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { PtyOutputEvent } from "../../../lib/types";

const terminalMocks = vi.hoisted(() => ({
  writeBatched: vi.fn(),
  flush: vi.fn(),
  reset: vi.fn(),
  parsed: null as (() => void) | null,
}));

let ptyOnData: ((event: PtyOutputEvent) => void) | null = null;

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
  usePtyOutput: (_id: string, onData: (event: PtyOutputEvent) => void) => { ptyOnData = onData; },
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
      onData: vi.fn(() => ({ dispose: vi.fn() })),
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
  ptyOnData = null;
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

describe("visible Codex terminal", () => {
  it("writes live output and reveals the terminal", async () => {
    const onPermissionPrompt = vi.fn();
    const { container } = render(
      <TerminalView threadId="codex-1" status="Running" provider="Codex" isActive holdLoadingUntilReady
        loadingLabel="Starting Codex session" onPermissionPrompt={onPermissionPrompt} />,
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await vi.advanceTimersByTimeAsync(300);
    });
    // Codex TUI startup: alt screen + a screenful of ANSI.
    const frame = "\x1b[?1049h" + "\x1b[2J\x1b[H> Welcome to Codex ".padEnd(600, "-");
    await act(async () => {
      ptyOnData!({ thread_id: "codex-1", data: btoa(frame), start_offset: 0, end_offset: frame.length });
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(terminalMocks.writeBatched).toHaveBeenCalled();
    expect(container.textContent).not.toContain("Fitting terminal");
  });
});
