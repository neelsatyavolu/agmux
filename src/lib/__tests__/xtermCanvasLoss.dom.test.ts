/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const events: string[] = [];
let nextAddonId = 0;

vi.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: class {
    id = ++nextAddonId;
    constructor() {
      events.push(`new ${this.id}`);
    }
    activate() {}
    dispose() {
      events.push(`dispose ${this.id}`);
    }
  },
}));

import { attachCanvas, createXterm } from "../xterm-loader";
import {
  CANVAS_LOSS_CHECK_MS,
  _resetCanvasLossRecoveryForTests,
} from "../canvasLossRecovery";
import { _resetAppVisibilityForTests } from "../appVisibility";

// Canvases made before a GPU restart read back empty; later ones work.
let gpuGeneration = 0;

beforeEach(() => {
  vi.useFakeTimers();
  events.length = 0;
  nextAddonId = 0;
  gpuGeneration = 0;
  _resetAppVisibilityForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function fakeGetContext() {
      const born = gpuGeneration;
      return {
        fillStyle: "",
        fillRect: () => {},
        getImageData: () => ({
          data: new Uint8ClampedArray([0, 0, 0, born === gpuGeneration ? 255 : 0]),
        }),
      } as unknown as CanvasRenderingContext2D;
    } as unknown as HTMLCanvasElement["getContext"],
  );
});

afterEach(() => {
  _resetCanvasLossRecoveryForTests();
  _resetAppVisibilityForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeAttached() {
  const bundle = createXterm({ fontFamily: "monospace", fontSize: 12, isLight: false });
  attachCanvas(bundle);
  return bundle;
}

describe("terminal canvas loss", () => {
  it("rebuilds every terminal's canvas renderer after a GPU restart", () => {
    const a = makeAttached();
    const b = makeAttached();
    const refreshA = vi.spyOn(a.term, "refresh");
    const refreshB = vi.spyOn(b.term, "refresh");
    const [oldA, oldB] = [a.canvas, b.canvas];
    events.length = 0;

    gpuGeneration += 1;
    vi.advanceTimersByTime(CANVAS_LOSS_CHECK_MS);

    // Both old renderers go before any new one, so xterm's shared glyph atlas
    // is dropped instead of handed back to the new renderer.
    expect(events).toEqual(["dispose 1", "dispose 2", "new 3", "new 4"]);
    expect(a.canvas).not.toBe(oldA);
    expect(b.canvas).not.toBe(oldB);
    expect(refreshA).toHaveBeenCalled();
    expect(refreshB).toHaveBeenCalled();
    a.dispose();
    b.dispose();
  });

  it("stops rebuilding a terminal once it is disposed", () => {
    const a = makeAttached();
    const b = makeAttached();
    b.dispose();
    events.length = 0;

    gpuGeneration += 1;
    vi.advanceTimersByTime(CANVAS_LOSS_CHECK_MS);

    expect(events).toEqual(["dispose 1", "new 3"]);
    a.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("registers a terminal once even when its canvas is re-attached", () => {
    const a = makeAttached();
    attachCanvas(a);
    events.length = 0;

    gpuGeneration += 1;
    vi.advanceTimersByTime(CANVAS_LOSS_CHECK_MS);

    expect(events.filter((e) => e.startsWith("new"))).toHaveLength(1);
    a.dispose();
  });
});
