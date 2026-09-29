/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import {
  CANVAS_LOSS_CHECK_MS,
  checkCanvasLoss,
  registerCanvasRenderer,
  _resetCanvasLossRecoveryForTests,
} from "../canvasLossRecovery";
import {
  installAppVisibilitySync,
  _resetAppVisibilityForTests,
} from "../appVisibility";

/**
 * Models what a WebKit GPU-process restart does to 2D canvases (verified in a
 * WKWebView harness on macOS 27 by SIGKILLing the GPU process): every canvas
 * created before the restart loses its pixels, while canvases created after
 * it work. `gpu.up` false = the replacement GPU process isn't serving yet.
 */
const gpu = { generation: 0, up: true };

function installFakeCanvas() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function fakeGetContext(this: HTMLCanvasElement) {
      const born = gpu.generation;
      let painted = false;
      return {
        fillStyle: "",
        fillRect: () => {
          painted = true;
        },
        getImageData: () => {
          const alive = painted && born === gpu.generation && gpu.up;
          return { data: new Uint8ClampedArray([0, 0, 0, alive ? 255 : 0]) };
        },
      } as unknown as CanvasRenderingContext2D;
    } as unknown as HTMLCanvasElement["getContext"],
  );
}

function crashGpu() {
  gpu.generation += 1;
}

function makeRenderer(log: string[], name: string) {
  return {
    detach: vi.fn(() => log.push(`detach ${name}`)),
    attach: vi.fn(() => log.push(`attach ${name}`)),
  };
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  gpu.generation = 0;
  gpu.up = true;
  installFakeCanvas();
  _resetAppVisibilityForTests();
  setHidden(false);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  installAppVisibilitySync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  _resetCanvasLossRecoveryForTests();
  _resetAppVisibilityForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("canvas loss recovery", () => {
  it("does nothing while canvases keep their pixels", () => {
    const log: string[] = [];
    registerCanvasRenderer(makeRenderer(log, "a"));
    vi.advanceTimersByTime(CANVAS_LOSS_CHECK_MS * 3);
    expect(checkCanvasLoss()).toBe(false);
    expect(log).toEqual([]);
  });

  it("detaches every renderer before re-attaching any after a GPU restart", () => {
    // xterm shares one glyph atlas between terminals with the same config.
    // Re-attaching terminal A while B still holds the atlas hands A the same
    // wiped atlas back, so all must let go first.
    const log: string[] = [];
    registerCanvasRenderer(makeRenderer(log, "a"));
    registerCanvasRenderer(makeRenderer(log, "b"));
    crashGpu();
    vi.advanceTimersByTime(CANVAS_LOSS_CHECK_MS);
    expect(log).toEqual(["detach a", "detach b", "attach a", "attach b"]);
  });

  it("rebuilds once per loss, not on every later check", () => {
    const log: string[] = [];
    const r = makeRenderer(log, "a");
    registerCanvasRenderer(r);
    crashGpu();
    vi.advanceTimersByTime(CANVAS_LOSS_CHECK_MS * 5);
    expect(r.attach).toHaveBeenCalledTimes(1);
    crashGpu();
    vi.advanceTimersByTime(CANVAS_LOSS_CHECK_MS);
    expect(r.attach).toHaveBeenCalledTimes(2);
  });

  it("waits until new canvases work before rebuilding", () => {
    const log: string[] = [];
    const r = makeRenderer(log, "a");
    registerCanvasRenderer(r);
    crashGpu();
    gpu.up = false;
    vi.advanceTimersByTime(CANVAS_LOSS_CHECK_MS * 3);
    expect(r.attach).not.toHaveBeenCalled();
    gpu.up = true;
    vi.advanceTimersByTime(CANVAS_LOSS_CHECK_MS);
    expect(r.attach).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CANVAS_LOSS_CHECK_MS * 3);
    expect(r.attach).toHaveBeenCalledTimes(1);
  });

  it("skips checks while hidden and checks as soon as the app is shown", () => {
    const log: string[] = [];
    const r = makeRenderer(log, "a");
    registerCanvasRenderer(r);
    setHidden(true);
    crashGpu();
    vi.advanceTimersByTime(CANVAS_LOSS_CHECK_MS * 3);
    expect(r.attach).not.toHaveBeenCalled();
    setHidden(false);
    expect(r.attach).toHaveBeenCalledTimes(1);
  });

  it("keeps rebuilding the others when one renderer throws", () => {
    const log: string[] = [];
    registerCanvasRenderer({
      detach: () => {
        throw new Error("host gone");
      },
      attach: () => {
        throw new Error("host gone");
      },
    });
    const b = makeRenderer(log, "b");
    registerCanvasRenderer(b);
    crashGpu();
    expect(checkCanvasLoss()).toBe(true);
    expect(b.attach).toHaveBeenCalledTimes(1);
  });

  it("stops checking once the last renderer unregisters", () => {
    const log: string[] = [];
    const r = makeRenderer(log, "a");
    const unregister = registerCanvasRenderer(r);
    unregister();
    crashGpu();
    vi.advanceTimersByTime(CANVAS_LOSS_CHECK_MS * 3);
    expect(r.attach).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
