/** @vitest-environment jsdom */
/**
 * Hidden Grok terminals skip live PTY events. On show, catch-up must:
 * 1. Replace xterm from the ring snapshot (reset + write)
 * 2. Quiet SIGWINCH AFTER that write, not before — otherwise the snapshot
 *    lands on top of the redraw and the TUI stays garbled until manual refresh.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
vi.mock("../../taskview/TaskTerminalPrompt", () => ({
  TaskTerminalPrompt: ({ ready }: { ready: boolean }) => <div data-testid="task-prompt" data-ready={String(ready)} />,
}));
import type { PtyOutputEvent } from "../../../lib/types";

const terminalMocks = vi.hoisted(() => {
  const refresh = vi.fn();
  const fit = vi.fn();
  const reset = vi.fn();
  const writeBatched = vi.fn();
  return {
    refresh,
    fit,
    reset,
    writeBatched,
    parsed: null as (() => void) | null,
    screen: [] as string[],
    flush: vi.fn(),
    rows: 24,
    cols: 80,
  };
});

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
    selector({
      claudeSessionMap: {},
      pendingApprovalsBySession: {},
      claudeProcessingById: {},
    }),
}));

vi.mock("../../../hooks/usePtyOutput", () => ({
  usePtyOutput: (
    _id: string,
    onData: (event: PtyOutputEvent) => void,
  ) => {
    ptyOnData = onData;
  },
}));

vi.mock("../../../hooks/useIsSessionActive", () => ({
  useIsSessionHiddenInPanes: () => false,
}));

vi.mock("../../../hooks/useNativeFileDrop", () => ({
  useNativeFileDrop: () => {},
}));

const resizePty = vi.fn().mockResolvedValue(undefined);
const getPtySnapshot = vi.fn();

vi.mock("../../../lib/commands", () => ({
  sendPtyInput: vi.fn().mockResolvedValue(undefined),
  resizePty: (...args: unknown[]) => resizePty(...args),
  getPtySnapshot: (...args: unknown[]) => getPtySnapshot(...args),
  saveTempImage: vi.fn().mockResolvedValue("/tmp/image.png"),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn().mockResolvedValue(""),
}));

vi.mock("../../../lib/terminalLinks", () => ({
  makeFileLinks: () => [],
  getCachedHomeDir: () => "/Users/test",
}));

vi.mock("../../../lib/xterm-loader", () => {
  const bundle = {
    term: {
      rows: terminalMocks.rows,
      cols: terminalMocks.cols,
      open: vi.fn(),
      focus: vi.fn(),
      write: vi.fn(),
      reset: terminalMocks.reset,
      refresh: terminalMocks.refresh,
      onWriteParsed: vi.fn((fn: () => void) => { terminalMocks.parsed = fn; return { dispose: vi.fn() }; }),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onResize: vi.fn(() => ({ dispose: vi.fn() })),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      attachCustomWheelEventHandler: vi.fn(),
      buffer: { active: { baseY: 0, getLine: (y: number) => ({ translateToString: () => terminalMocks.screen[y] ?? "" }) } },
      options: {},
    },
    fit: { fit: terminalMocks.fit },
    canvas: null,
    serialize: {},
    search: {},
    writeBatched: terminalMocks.writeBatched,
    flushBatched: terminalMocks.flush,
    setRenderingPaused: vi.fn(),
    dispose: vi.fn(),
  };

  return {
    createXterm: vi.fn(() => bundle),
    attachCanvas: vi.fn(),
    decodeSnapshot: vi.fn((data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0))),
    prepareTerminalFont: vi.fn().mockResolvedValue(undefined),
    reattachCanvas: vi.fn(),
    lightTheme: vi.fn(() => ({})),
    darkTheme: vi.fn(() => ({})),
    FLUSH_TERMINAL_BG_DARK: "#141414",
  };
});

import { TerminalView } from "../TerminalView";

beforeEach(() => {
  vi.useFakeTimers();
  ptyOnData = null;
  terminalMocks.screen = [];
  terminalMocks.flush.mockClear();
  terminalMocks.refresh.mockClear();
  terminalMocks.fit.mockClear();
  terminalMocks.reset.mockClear();
  terminalMocks.writeBatched.mockClear();
  resizePty.mockClear().mockResolvedValue(undefined);
  getPtySnapshot.mockReset();
  getPtySnapshot.mockResolvedValue({
    data: btoa("snap"),
    end_offset: 10,
  });

  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      width: 800,
      height: 600,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });

  global.ResizeObserver = vi.fn(function ResizeObserver() {
    return { observe: vi.fn(), disconnect: vi.fn() };
  }) as unknown as typeof ResizeObserver;
  global.IntersectionObserver = vi.fn(function IntersectionObserver() {
    return { observe: vi.fn(), disconnect: vi.fn() };
  }) as unknown as typeof IntersectionObserver;
  global.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(performance.now()), 0),
  ) as unknown as typeof requestAnimationFrame;
  global.cancelAnimationFrame = vi.fn((id: number) => {
    clearTimeout(id);
  }) as unknown as typeof cancelAnimationFrame;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const grokProps = {
  threadId: "grok-thread-1",
  status: "Running" as const,
  provider: "Grok" as const,
  flushPadding: true,
  holdLoadingUntilReady: false,
};

describe("TerminalView hidden-session catch-up", () => {
  it("recognizes snapshot-only startup output when a hidden task becomes visible", async () => {
    getPtySnapshot.mockResolvedValueOnce({ data: "", end_offset: 0 });
    const { rerender } = render(<TerminalView {...grokProps} isActive={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(screen.getByTestId("task-prompt").getAttribute("data-ready")).toBe("false");
    act(() => ptyOnData!({ thread_id: grokProps.threadId, data: btoa("ready"), start_offset: 0, end_offset: 5 }));
    getPtySnapshot.mockResolvedValue({ data: btoa("ready"), end_offset: 5 });
    rerender(<TerminalView {...grokProps} isActive />);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByTestId("task-prompt").getAttribute("data-ready")).toBe("true");
  });
  it("appends continuous background output without resetting on tab activation", async () => {
    const { rerender } = render(<TerminalView {...grokProps} isActive={false} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await vi.advanceTimersByTimeAsync(1000);
    });
    act(() => {
      ptyOnData!({ thread_id: grokProps.threadId, data: btoa("abc"), start_offset: 10, end_offset: 13 });
    });
    getPtySnapshot.mockResolvedValue({ data: btoa("snapabc"), end_offset: 13 });
    terminalMocks.reset.mockClear();
    terminalMocks.writeBatched.mockClear();

    rerender(<TerminalView {...grokProps} isActive />);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(terminalMocks.reset).not.toHaveBeenCalled();
    expect(terminalMocks.writeBatched).toHaveBeenCalledOnce();
    expect(Array.from(terminalMocks.writeBatched.mock.calls[0][0])).toEqual([97, 98, 99]);
  });

  it("hidden Codex terminals skip plain output but catch up when a permission form appears", async () => {
    const onPermissionPrompt = vi.fn();
    render(<TerminalView {...grokProps} provider="Codex" isActive={false} onPermissionPrompt={onPermissionPrompt} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      // Past the 2s loading-overlay safety reveal, which flushes on its own.
      await vi.advanceTimersByTimeAsync(2500);
    });
    const snapshotsAfterInit = getPtySnapshot.mock.calls.length;
    terminalMocks.writeBatched.mockClear();
    terminalMocks.flush.mockClear();

    // Ordinary output while hidden: no decode into xterm, no snapshot fetch.
    // (flushBatched is not asserted here: the init repaint pulse flushes on
    // its own timers, independent of live output.)
    await act(async () => {
      ptyOnData!({ thread_id: grokProps.threadId, data: btoa("building..."), start_offset: 10, end_offset: 21 });
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(terminalMocks.writeBatched).not.toHaveBeenCalled();
    expect(getPtySnapshot).toHaveBeenCalledTimes(snapshotsAfterInit);

    // A chunk that paints part of the form (split across two chunks) triggers
    // a snapshot catch-up, and the screen scan reports the question.
    terminalMocks.screen = ['Field 1/1', 'Allow Computer Use to use "Canary Mail"?',
      '1. Allow', '2. Allow for this session', '3. Always allow', '4. Cancel',
      'enter to submit | esc to cancel'];
    getPtySnapshot.mockResolvedValue({ data: btoa("snap"), end_offset: 30 });
    await act(async () => {
      ptyOnData!({ thread_id: grokProps.threadId, data: btoa("2. Allow for th"), start_offset: 21, end_offset: 36 });
      ptyOnData!({ thread_id: grokProps.threadId, data: btoa("is session"), start_offset: 36, end_offset: 46 });
      await vi.advanceTimersByTimeAsync(1500);
      terminalMocks.parsed!();
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(getPtySnapshot).toHaveBeenCalledTimes(snapshotsAfterInit + 1);
    expect(terminalMocks.flush).toHaveBeenCalled();
    expect(onPermissionPrompt).toHaveBeenLastCalledWith('Allow Computer Use to use "Canary Mail"?');

    // While the form is up, further output is parsed so its dismissal is seen.
    terminalMocks.writeBatched.mockClear();
    await act(async () => {
      ptyOnData!({ thread_id: grokProps.threadId, data: btoa("Calling"), start_offset: 30, end_offset: 37 });
      terminalMocks.screen = ['Calling Access Canary Mail'];
      terminalMocks.parsed!();
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(terminalMocks.writeBatched).toHaveBeenCalledOnce();
    expect(onPermissionPrompt).toHaveBeenLastCalledWith(null);
  });

  it("quiet-SIGWINCHes after a delayed snapshot replace, not before", async () => {
    getPtySnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          window.setTimeout(
            () => resolve({ data: btoa("snap"), end_offset: 10 }),
            400,
          );
        }),
    );

    const { rerender } = render(
      <TerminalView {...grokProps} isActive={false} />,
    );

    await act(async () => {
      await Promise.resolve();
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await vi.runOnlyPendingTimersAsync();
      // Drain mount quiet-SIGWINCH sleeps so they can't land after mockClear.
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
    });

    expect(ptyOnData).toBeTruthy();
    act(() => {
      ptyOnData!({
        thread_id: "grok-thread-1",
        data: btoa("hidden"),
        start_offset: 0,
        end_offset: 6,
      });
    });

    terminalMocks.reset.mockClear();
    resizePty.mockClear();
    getPtySnapshot.mockReset();
    getPtySnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          window.setTimeout(
            // The ring no longer covers offset 10, so this must reset.
            () => resolve({ data: btoa("snap"), end_offset: 100 }),
            400,
          );
        }),
    );

    rerender(<TerminalView {...grokProps} isActive />);

    await act(async () => {
      // isActive quiet jiggle is at 220ms — snapshot still in flight
      await vi.advanceTimersByTimeAsync(220);
      await Promise.resolve();
    });

    expect(terminalMocks.reset).not.toHaveBeenCalled();
    expect(resizePty.mock.calls, "no SIGWINCH while snapshot is in flight").toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(150);
      await Promise.resolve();
    });

    expect(terminalMocks.reset).toHaveBeenCalled();
    // Quiet: cols-only, after snapshot, so Grok repaints the replaced buffer.
    expect(resizePty).toHaveBeenCalledWith("grok-thread-1", 24, 79);
    expect(resizePty).toHaveBeenCalledWith("grok-thread-1", 24, 80);
    expect(resizePty).not.toHaveBeenCalledWith(
      "grok-thread-1",
      23,
      expect.anything(),
    );
    const resetOrder = terminalMocks.reset.mock.invocationCallOrder[0]!;
    const firstResizeOrder = resizePty.mock.invocationCallOrder[0]!;
    expect(resetOrder).toBeLessThan(firstResizeOrder);
  });
});
