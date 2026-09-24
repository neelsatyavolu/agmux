/** @vitest-environment jsdom */
import { useEffect } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { getPtySnapshot, sendPtyInput } from "../../../lib/commands";
import type { PtyOutputEvent } from "../../../lib/types";
let ptyOnData: (event: PtyOutputEvent) => void;

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

vi.mock("../../../stores/uiStore", () => ({
  useUiStore: (selector: (state: unknown) => unknown) =>
    selector({
      claudeSessionMap: {},
      pendingApprovalsBySession: {},
      claudeProcessingById: {},
    }),
}));

vi.mock("../../../stores/sessionNameStore", () => ({
  useSessionNameStore: {
    getState: () => ({ summarize: vi.fn() }),
  },
}));

vi.mock("../../../hooks/usePtyOutput", () => ({
  usePtyOutput: (_id: string, onData: (event: PtyOutputEvent) => void) => { ptyOnData = onData; },
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
      onData: vi.fn(() => ({ dispose: vi.fn() })),
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

function PassiveMarker() {
  useEffect(() => {
    terminalMocks.events.push("passive");
  });
  return null;
}

function Harness({ isActive }: { isActive: boolean }) {
  return (
    <>
      <PassiveMarker />
      <ClaudeTerminalView threadId="thread-1" projectPath="/tmp/repo" status="Running" isActive={isActive} />
    </>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  terminalMocks.events.length = 0;
  terminalMocks.refresh.mockClear();
  terminalMocks.open.mockClear();
  terminalMocks.focus.mockClear();
  terminalMocks.write.mockClear();
  terminalMocks.fit.mockClear();
  terminalMocks.setRenderingPaused.mockClear();
  terminalMocks.colorMode.isLight = false;
  terminalMocks.colorMode.updates = false;

  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 }),
  });

  global.ResizeObserver = vi.fn(function ResizeObserver() {
    return {
      observe: vi.fn(),
      disconnect: vi.fn(),
    };
  }) as unknown as typeof ResizeObserver;
  global.IntersectionObserver = vi.fn(function IntersectionObserver() {
    return {
      observe: vi.fn(),
      disconnect: vi.fn(),
    };
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

describe("ClaudeTerminalView activation paint timing", () => {
  it("recognizes startup output replayed when a hidden task returns", async () => {
    vi.mocked(getPtySnapshot).mockResolvedValueOnce({ data: "", end_offset: 0 });
    const { rerender } = render(<Harness isActive={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(screen.getByTestId("task-prompt").getAttribute("data-ready")).toBe("false");
    act(() => ptyOnData({ thread_id: "thread-1", data: btoa("ready"), start_offset: 0, end_offset: 5 }));
    vi.mocked(getPtySnapshot).mockResolvedValueOnce({ data: btoa("ready"), end_offset: 5 });
    rerender(<Harness isActive />);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByTestId("task-prompt").getAttribute("data-ready")).toBe("true");
  });
  it("does not submit a task prompt when the silence timeout merely hides the loader", async () => {
    vi.mocked(getPtySnapshot).mockResolvedValueOnce({ data: "", end_offset: 0 });
    render(<Harness isActive />);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(screen.getByTestId("task-prompt").getAttribute("data-ready")).toBe("false");
  });
  it("refreshes the canvas on activation before passive effects can paint a black frame", async () => {
    const { rerender } = render(<Harness isActive={false} />);

    await act(async () => {
      await Promise.resolve();
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await vi.runOnlyPendingTimersAsync();
    });
    expect(terminalMocks.open).toHaveBeenCalled();

    terminalMocks.events.length = 0;
    terminalMocks.refresh.mockClear();

    rerender(<Harness isActive={true} />);

    expect(terminalMocks.refresh).toHaveBeenCalled();
    expect(terminalMocks.events[0]).toBe("refresh");
  });

  it("pauses rendering while the Claude terminal is not active", async () => {
    const { rerender } = render(<Harness isActive={false} />);

    await act(async () => {
      await Promise.resolve();
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await vi.runOnlyPendingTimersAsync();
    });

    expect(terminalMocks.setRenderingPaused).toHaveBeenCalledWith(true);

    terminalMocks.setRenderingPaused.mockClear();
    rerender(<Harness isActive={true} />);

    expect(terminalMocks.setRenderingPaused).toHaveBeenCalledWith(false);
  });
});

describe("ClaudeTerminalView light/dark flips", () => {
  async function mountThenFlipToLight() {
    const { rerender } = render(<Harness isActive />);
    await act(async () => {
      await Promise.resolve();
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await vi.runOnlyPendingTimersAsync();
    });
    expect(terminalMocks.open).toHaveBeenCalled();
    vi.mocked(sendPtyInput).mockClear();
    terminalMocks.colorMode.isLight = true;
    rerender(<Harness isActive />);
  }

  it("tells Claude the new color scheme when it subscribed to updates", async () => {
    terminalMocks.colorMode.updates = true;
    await mountThenFlipToLight();
    expect(sendPtyInput).toHaveBeenCalledWith("thread-1", "report:light");
  });

  it("sends nothing to apps that did not ask for color scheme updates", async () => {
    await mountThenFlipToLight();
    expect(sendPtyInput).not.toHaveBeenCalledWith("thread-1", expect.stringContaining("report:"));
  });
});
