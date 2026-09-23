/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import {
  createXterm,
  IDLE_CURSOR_BLINK_MS,
} from "../xterm-loader";
import {
  installAppVisibilitySync,
  _resetAppVisibilityForTests,
} from "../appVisibility";

function makeTerm() {
  return createXterm({
    fontFamily: "monospace",
    fontSize: 12,
    isLight: false,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetAppVisibilityForTests();
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => false,
  });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  installAppVisibilitySync();
});

afterEach(() => {
  vi.useRealTimers();
  _resetAppVisibilityForTests();
  vi.restoreAllMocks();
});

describe("createXterm power saving", () => {
  it.each([true, false])("restores bottom following after hidden viewport drift (following=%s)", async (following) => {
    vi.useRealTimers();
    const bundle = makeTerm();
    try {
      await new Promise<void>((resolve) => bundle.term.write("line\r\n".repeat(60), resolve));
      const core = (bundle.term as unknown as {
        _core: { _bufferService: { scrollLines: (amount: number) => void } };
      })._core;
      if (!following) core._bufferService.scrollLines(-10);
      const beforeHide = bundle.term.buffer.active.viewportY;
      // Public scrolling normally routes through the DOM viewport. This parser
      // test has no renderer, so forward it to the real buffer service.
      vi.spyOn(bundle.term, "scrollToBottom").mockImplementation(() => {
        const buffer = bundle.term.buffer.active;
        core._bufferService.scrollLines(buffer.baseY - buffer.viewportY);
      });
      bundle.setRenderingPaused(true);
      bundle.setRenderingPaused(true); // repeated pause must not replace intent
      if (following) core._bufferService.scrollLines(-4);
      bundle.setRenderingPaused(false);
      await new Promise<void>((resolve) => bundle.term.write("new output\r\n", resolve));
      expect(bundle.term.buffer.active.viewportY).toBe(
        following ? bundle.term.buffer.active.baseY : beforeHide,
      );
    } finally {
      bundle.dispose();
    }
  });

  it("starts with cursor blink on while focused and visible", () => {
    const bundle = makeTerm();
    expect(bundle.term.options.cursorBlink).toBe(true);
    bundle.dispose();
  });

  it("turns cursor blink off on window blur without pausing writes", () => {
    const bundle = makeTerm();
    window.dispatchEvent(new Event("blur"));
    expect(bundle.term.options.cursorBlink).toBe(false);
    bundle.writeBatched("hello");
    bundle.flushBatched();
    window.dispatchEvent(new Event("focus"));
    expect(bundle.term.options.cursorBlink).toBe(true);
    bundle.dispose();
  });

  it("pauses rendering when the document is hidden", () => {
    const bundle = makeTerm();
    const write = vi.spyOn(bundle.term, "write");
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(bundle.term.options.cursorBlink).toBe(false);
    bundle.writeBatched("x");
    vi.advanceTimersByTime(32);
    expect(write).not.toHaveBeenCalled();
    bundle.dispose();
  });

  it("turns cursor blink off after idle and back on after a write", () => {
    const bundle = makeTerm();
    expect(bundle.term.options.cursorBlink).toBe(true);
    vi.advanceTimersByTime(IDLE_CURSOR_BLINK_MS);
    expect(bundle.term.options.cursorBlink).toBe(false);
    bundle.writeBatched("a");
    expect(bundle.term.options.cursorBlink).toBe(true);
    bundle.dispose();
  });

  it("setRenderingPaused(true) disables blink and (false) restores it", () => {
    const bundle = makeTerm();
    bundle.setRenderingPaused(true);
    expect(bundle.term.options.cursorBlink).toBe(false);
    bundle.setRenderingPaused(false);
    expect(bundle.term.options.cursorBlink).toBe(true);
    bundle.dispose();
  });
});

describe("terminal text contrast", () => {
  it.each([false, true])("corrects explicit ANSI, indexed and truecolor foregrounds (light=%s)", (isLight) => {
    const bundle = createXterm({ fontFamily: "monospace", fontSize: 12, isLight });
    expect(bundle.term.options.minimumContrastRatio).toBe(4.5);
    bundle.dispose();
  });
});
