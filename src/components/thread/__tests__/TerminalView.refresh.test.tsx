/** @vitest-environment jsdom */
/**
 * TerminalView SIGWINCH pulses:
 * - Manual top-bar refresh → force rows+cols held pulse (garbled TUI repaint).
 * - Auto open / tab switch → quiet cols-only (no vertical Grok input bounce).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { PtyOutputEvent } from "../../../lib/types";
import { getPtySnapshot } from "../../../lib/commands";

let ptyOnData: (event: PtyOutputEvent) => void;
vi.mock("../../taskview/TaskTerminalPrompt", () => ({
  TaskTerminalPrompt: ({ ready }: { ready: boolean }) => <div data-testid="task-prompt" data-ready={String(ready)} />,
}));

const terminalMocks = vi.hoisted(() => {
  const refresh = vi.fn();
  const fit = vi.fn();
  return {
    refresh,
    fit,
    rows: 24,
    cols: 80,
  };
});

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
  usePtyOutput: (_id: string, onData: (event: PtyOutputEvent) => void) => { ptyOnData = onData; },
}));

vi.mock("../../../hooks/useIsSessionActive", () => ({
  useIsSessionHiddenInPanes: () => false,
}));

vi.mock("../../../hooks/useNativeFileDrop", () => ({
  useNativeFileDrop: () => {},
}));

const resizePty = vi.fn().mockResolvedValue(undefined);

vi.mock("../../../lib/commands", () => ({
  sendPtyInput: vi.fn().mockResolvedValue(undefined),
  resizePty: (...args: unknown[]) => resizePty(...args),
  getPtySnapshot: vi.fn().mockResolvedValue({
    data: btoa("\u001b[?1049hready"),
    end_offset: 12,
  }),
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
      refresh: terminalMocks.refresh,
      onWriteParsed: vi.fn(() => ({ dispose: vi.fn() })),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onResize: vi.fn(() => ({ dispose: vi.fn() })),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      attachCustomWheelEventHandler: vi.fn(),
      buffer: { active: { getLine: vi.fn() } },
      options: {},
    },
    fit: { fit: terminalMocks.fit },
    canvas: null,
    serialize: {},
    search: {},
    writeBatched: vi.fn(),
    flushBatched: vi.fn(),
    setRenderingPaused: vi.fn(),
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
    FLUSH_TERMINAL_BG_DARK: "#141414",
  };
});

import { TerminalView } from "../TerminalView";

beforeEach(() => {
  vi.useFakeTimers();
  terminalMocks.refresh.mockClear();
  terminalMocks.fit.mockClear();
  resizePty.mockClear().mockResolvedValue(undefined);

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

async function mountAndSettle(ui: React.ReactElement) {
  render(ui);
  await act(async () => {
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();
  });
}

describe("TerminalView top-bar refresh", () => {
  it("waits for actual output before handing off a task prompt after idle startup", async () => {
    vi.mocked(getPtySnapshot).mockResolvedValueOnce({ data: "", end_offset: 0 });
    const { rerender } = render(<TerminalView threadId="new-task" status="Idle" provider="Pi" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); await vi.runOnlyPendingTimersAsync(); });
    rerender(<TerminalView threadId="new-task" status="Running" provider="Pi" />);
    expect(screen.getByTestId("task-prompt").getAttribute("data-ready")).toBe("false");
    await act(async () => {
      ptyOnData({ thread_id: "new-task", data: btoa("ready"), start_offset: 0, end_offset: 5 });
      await vi.runOnlyPendingTimersAsync();
    });
    expect(screen.getByTestId("task-prompt").getAttribute("data-ready")).toBe("true");
  });
  it("on claude-terminal-refresh: held rows+cols SIGWINCH pulse", async () => {
    await mountAndSettle(
      <TerminalView
        threadId="grok-thread-1"
        status="Running"
        isActive
        provider="Grok"
        flushPadding
        holdLoadingUntilReady={false}
      />,
    );

    resizePty.mockClear();
    terminalMocks.fit.mockClear();
    terminalMocks.refresh.mockClear();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("claude-terminal-refresh", {
          detail: { threadId: "grok-thread-1" },
        }),
      );
      // Mid hold 80ms + final settle 120ms
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
    });

    expect(terminalMocks.fit).toHaveBeenCalled();
    expect(terminalMocks.refresh).toHaveBeenCalled();
    // Held mid size then restore (both dims change — like a real window resize)
    expect(resizePty).toHaveBeenCalledWith("grok-thread-1", 23, 79);
    expect(resizePty).toHaveBeenCalledWith("grok-thread-1", 24, 80);
  });

  it("ignores claude-terminal-refresh for a different thread", async () => {
    await mountAndSettle(
      <TerminalView threadId="grok-thread-1" status="Running" isActive provider="Grok" />,
    );

    // Drain mount/isActive pulse fully (held mid + settle sleeps) before
    // asserting that a foreign thread id does not trigger another resize.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
    });
    resizePty.mockClear();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("claude-terminal-refresh", {
          detail: { threadId: "other-thread" },
        }),
      );
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
    });

    expect(resizePty).not.toHaveBeenCalled();
  });

  it("retries resize when PTY is not ready yet (post-offload race)", async () => {
    await mountAndSettle(
      <TerminalView
        threadId="grok-thread-1"
        status="Running"
        isActive
        provider="Grok"
        flushPadding
        isResume
        holdLoadingUntilReady={false}
      />,
    );

    resizePty.mockClear();
    let n = 0;
    resizePty.mockImplementation(async () => {
      n += 1;
      if (n <= 2) throw new Error("No active session for thread grok-thread-1");
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("claude-terminal-refresh", {
          detail: { threadId: "grok-thread-1" },
        }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      await Promise.resolve();
    });

    expect(resizePty.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(resizePty).toHaveBeenCalledWith("grok-thread-1", 24, 80);
  });

  it("on isActive true (tab/notif switch): quiet cols-only SIGWINCH (no row bounce)", async () => {
    const { rerender } = render(
      <TerminalView
        threadId="grok-thread-1"
        status="Running"
        isActive={false}
        provider="Grok"
        flushPadding
        holdLoadingUntilReady={false}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await vi.runOnlyPendingTimersAsync();
    });

    resizePty.mockClear();
    terminalMocks.fit.mockClear();
    terminalMocks.refresh.mockClear();

    rerender(
      <TerminalView
        threadId="grok-thread-1"
        status="Running"
        isActive
        provider="Grok"
        flushPadding
        holdLoadingUntilReady={false}
      />,
    );

    await act(async () => {
      // Soft RAF fit (~200ms) + delayed quiet jiggle 220ms + short settle
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
    });

    expect(terminalMocks.fit).toHaveBeenCalled();
    expect(terminalMocks.refresh).toHaveBeenCalled();
    // Quiet: same row count, only cols change — Grok input bar must not jump.
    expect(resizePty).toHaveBeenCalledWith("grok-thread-1", 24, 79);
    expect(resizePty).toHaveBeenCalledWith("grok-thread-1", 24, 80);
    expect(resizePty).not.toHaveBeenCalledWith("grok-thread-1", 23, expect.anything());
  });
});
