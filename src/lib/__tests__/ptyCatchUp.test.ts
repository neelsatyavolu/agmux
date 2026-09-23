/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getPtySnapshot } from "../commands";
import {
  trimLeadingIncompleteVt,
  replaceTerminalFromSnapshot,
} from "../ptyCatchUp";
import { TUI_MOUSE_DECSET } from "../ptyMouse";
import { createXterm, type XtermBundle } from "../xterm-loader";

vi.mock("../commands", () => ({
  getPtySnapshot: vi.fn(),
}));

const getSnap = getPtySnapshot as unknown as ReturnType<typeof vi.fn>;

function b64(bytes: Uint8Array | string): string {
  const u8 =
    typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!);
  return btoa(s);
}

function fakeBundle() {
  const writes: Uint8Array[] = [];
  const bundle = {
    term: { reset: vi.fn() },
    writeBatched: vi.fn((data: Uint8Array) => {
      writes.push(data);
    }),
    flushBatched: vi.fn(),
  };
  return { bundle: bundle as unknown as XtermBundle, writes, mocks: bundle };
}

describe("trimLeadingIncompleteVt", () => {
  it("drops a torn CSI prefix until the next ESC (ring wrap)", () => {
    const torn = ";2;125;207;255;48;2;20;20;20m\x1b[Hok";
    const out = trimLeadingIncompleteVt(new TextEncoder().encode(torn));
    expect(new TextDecoder().decode(out)).toBe("\x1b[Hok");
  });

  it("keeps a snapshot that already starts on ESC", () => {
    const raw = new TextEncoder().encode("\x1b[38;2;125;207;255mhi");
    expect(trimLeadingIncompleteVt(raw)).toEqual(raw);
  });

  it("keeps plain text with no ESC", () => {
    const raw = new TextEncoder().encode("hello");
    expect(trimLeadingIncompleteVt(raw)).toEqual(raw);
  });

  it("returns empty for empty input", () => {
    expect(trimLeadingIncompleteVt(new Uint8Array(0))).toEqual(new Uint8Array(0));
  });
});

describe("replaceTerminalFromSnapshot", () => {
  beforeEach(() => {
    getSnap.mockReset();
  });

  it("appends only unseen bytes without resetting existing scrollback", async () => {
    getSnap.mockResolvedValue({ data: b64("old output\r\nnew output"), end_offset: 22 });
    const { bundle, writes, mocks } = fakeBundle();

    const end = await replaceTerminalFromSnapshot(bundle, "t1", { lastWrittenOffset: 12 });

    expect(end).toBe(22);
    expect(mocks.term.reset).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(new TextDecoder().decode(writes[0])).toBe("new output");
  });

  it("reports only replayed provider bytes to readiness observers", async () => {
    const { bundle } = fakeBundle();
    const onReplay = vi.fn();
    getSnap.mockResolvedValue({ data: b64("oldnew"), end_offset: 6 });
    await replaceTerminalFromSnapshot(bundle, "t1", { lastWrittenOffset: 3, onReplay });
    expect(onReplay).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(onReplay.mock.calls[0][0])).toBe("new");
    onReplay.mockClear();
    getSnap.mockResolvedValue({ data: "", end_offset: 0 });
    await replaceTerminalFromSnapshot(bundle, "t1", { restoreMouse: true, onReplay });
    expect(onReplay).not.toHaveBeenCalled();
  });

  it("does not replay an already consumed snapshot", async () => {
    getSnap.mockResolvedValue({ data: b64("old output"), end_offset: 10 });
    const { bundle, mocks } = fakeBundle();

    expect(await replaceTerminalFromSnapshot(bundle, "t1", { lastWrittenOffset: 10 })).toBe(10);
    expect(mocks.term.reset).not.toHaveBeenCalled();
    expect(mocks.writeBatched).not.toHaveBeenCalled();
  });

  it("keeps continuation bytes intact when catch-up starts inside a VT sequence", async () => {
    getSnap.mockResolvedValue({ data: b64("\x1b[31mred\x1b[0m"), end_offset: 12 });
    const { bundle, writes, mocks } = fakeBundle();

    await replaceTerminalFromSnapshot(bundle, "t1", { lastWrittenOffset: 2 });

    expect(mocks.term.reset).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(writes[0])).toBe("31mred\x1b[0m");
  });

  it("falls back to full recovery when the missing output was evicted", async () => {
    getSnap.mockResolvedValue({ data: b64("\x1b[Htail"), end_offset: 100 });
    const { bundle, writes, mocks } = fakeBundle();

    expect(await replaceTerminalFromSnapshot(bundle, "t1", { lastWrittenOffset: 50 })).toBe(100);
    expect(mocks.term.reset).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(writes[0])).toBe("\x1b[Htail");
  });

  it("preserves real xterm history and the reader's scroll position across catch-up", async () => {
    const bundle = createXterm({ fontFamily: "monospace", fontSize: 12, isLight: false });
    try {
      const history = Array.from({ length: 60 }, (_, i) => `line ${i}\r\n`).join("");
      await new Promise<void>((resolve) => bundle.term.write(history, resolve));
      // No DOM viewport is opened in this parser test. Drive the same buffer
      // service used by viewport scrolling, then verify the starting position.
      const core = (bundle.term as unknown as {
        _core: { _bufferService: { scrollLines: (amount: number) => void } };
      })._core;
      core._bufferService.scrollLines(5 - bundle.term.buffer.active.viewportY);
      expect(bundle.term.buffer.active.viewportY).toBe(5);
      const lastWrittenOffset = new TextEncoder().encode(history).length;
      const tail = "new output\r\n";
      // The ring has evicted old history, but still contains every missing byte.
      getSnap.mockResolvedValue({ data: b64(tail), end_offset: lastWrittenOffset + tail.length });

      await replaceTerminalFromSnapshot(bundle, "t1", { lastWrittenOffset });
      await new Promise<void>((resolve) => bundle.term.write("", resolve));

      expect(bundle.term.buffer.active.getLine(0)?.translateToString(true)).toBe("line 0");
      expect(bundle.term.buffer.active.viewportY).toBe(5);
      expect(bundle.term.buffer.active.getLine(60)?.translateToString(true)).toBe("new output");
    } finally {
      bundle.dispose();
    }
  });

  it("preserves a partial UTF-8 character and full-screen mouse modes in real xterm", async () => {
    const bundle = createXterm({ fontFamily: "monospace", fontSize: 12, isLight: false });
    try {
      const modes = "\x1b[?1049h\x1b[?1000h\x1b[?1006h";
      const utf8 = new TextEncoder().encode("😀done");
      await new Promise<void>((resolve) => bundle.term.write(modes, resolve));
      await new Promise<void>((resolve) => bundle.term.write(utf8.subarray(0, 2), resolve));
      const mouseMode = bundle.term.modes.mouseTrackingMode;
      expect(mouseMode).not.toBe("none");
      getSnap.mockResolvedValue({ data: b64(utf8), end_offset: modes.length + utf8.length });

      await replaceTerminalFromSnapshot(bundle, "t1", {
        lastWrittenOffset: modes.length + 2,
        restoreMouse: true,
      });
      await new Promise<void>((resolve) => bundle.term.write("", resolve));

      expect(bundle.term.buffer.active.type).toBe("alternate");
      expect(bundle.term.modes.mouseTrackingMode).toBe(mouseMode);
      expect(bundle.term.buffer.active.getLine(0)?.translateToString(true)).toBe("😀done");
    } finally {
      bundle.dispose();
    }
  });

  it("resets for a restarted stream whose offset moved backwards", async () => {
    getSnap.mockResolvedValue({ data: b64("new"), end_offset: 3 });
    const { bundle, mocks } = fakeBundle();
    expect(await replaceTerminalFromSnapshot(bundle, "t1", { lastWrittenOffset: 100 })).toBe(3);
    expect(mocks.term.reset).toHaveBeenCalledOnce();
  });

  it("forces full recovery if the paused write queue discarded unseen bytes", async () => {
    const bundle = createXterm({ fontFamily: "monospace", fontSize: 12, isLight: false });
    try {
      bundle.setRenderingPaused(true);
      bundle.writeBatched("x".repeat(1024 * 1024));
      bundle.writeBatched("new");
      const reset = vi.spyOn(bundle.term, "reset");
      const endOffset = 1024 * 1024 + 3;
      getSnap.mockResolvedValue({ data: b64("new"), end_offset: endOffset });

      await replaceTerminalFromSnapshot(bundle, "t1", { lastWrittenOffset: endOffset });

      expect(reset).toHaveBeenCalledOnce();
    } finally {
      bundle.dispose();
    }
  });

  it("resets, flushes, and writes bytes starting at the first ESC", async () => {
    const torn = ";2;125;207;255;48;2;20;20;20m\x1b[?1049hready";
    getSnap.mockResolvedValue({ data: b64(torn), end_offset: 99 });
    const { bundle, writes, mocks } = fakeBundle();

    const end = await replaceTerminalFromSnapshot(bundle, "t1");

    expect(end).toBe(99);
    expect(mocks.flushBatched).toHaveBeenCalled();
    expect(mocks.term.reset).toHaveBeenCalled();
    expect(mocks.writeBatched).toHaveBeenCalled();
    expect(new TextDecoder().decode(writes[0])).toBe("\x1b[?1049hready");
    // Flush after write so the snapshot lands before live PTY chunks.
    expect(mocks.flushBatched.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.term.reset.mock.invocationCallOrder[0],
    );
  });

  it("still returns the watermark when the snapshot is empty", async () => {
    getSnap.mockResolvedValue({ data: "", end_offset: 7 });
    const { bundle, mocks } = fakeBundle();
    const end = await replaceTerminalFromSnapshot(bundle, "t1");
    expect(end).toBe(7);
    expect(mocks.term.reset).toHaveBeenCalled();
    expect(mocks.writeBatched).not.toHaveBeenCalled();
  });

  it("re-asserts SGR mouse tracking after reset when restoreMouse is set", async () => {
    getSnap.mockResolvedValue({ data: b64("\x1b[Hready"), end_offset: 3 });
    const { bundle, writes, mocks } = fakeBundle();

    await replaceTerminalFromSnapshot(bundle, "t1", { restoreMouse: true });

    expect(new TextDecoder().decode(writes[0])).toBe("\x1b[Hready");
    expect(writes[1]).toBe(TUI_MOUSE_DECSET);
    expect(mocks.flushBatched).toHaveBeenCalledTimes(3);
  });

  it("does not re-assert mouse tracking unless asked", async () => {
    getSnap.mockResolvedValue({ data: b64("\x1b[Hready"), end_offset: 3 });
    const { bundle, writes } = fakeBundle();
    await replaceTerminalFromSnapshot(bundle, "t1");
    expect(writes).toHaveLength(1);
  });
});
