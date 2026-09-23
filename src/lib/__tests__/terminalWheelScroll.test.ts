import { describe, it, expect } from "vitest";
import {
  createGrokWheelScroller,
  wheelToGrokScrollKeys,
  shouldUseNativeGrokMouseWheel,
  GROK_WHEEL_PIXELS_PER_PAGE,
} from "../terminalWheelScroll";

describe("shouldUseNativeGrokMouseWheel", () => {
  it("uses native mouse for any non-none tracking mode", () => {
    expect(shouldUseNativeGrokMouseWheel("any")).toBe(true);
    expect(shouldUseNativeGrokMouseWheel("vt200")).toBe(true);
    expect(shouldUseNativeGrokMouseWheel("drag")).toBe(true);
    expect(shouldUseNativeGrokMouseWheel("x10")).toBe(true);
  });

  it("falls back when mouse tracking is off or missing", () => {
    expect(shouldUseNativeGrokMouseWheel("none")).toBe(false);
    expect(shouldUseNativeGrokMouseWheel(undefined)).toBe(false);
    expect(shouldUseNativeGrokMouseWheel(null)).toBe(false);
    expect(shouldUseNativeGrokMouseWheel("")).toBe(false);
  });
});

describe("wheelToGrokScrollKeys (stateless one-shot Page fallback)", () => {
  it("returns null for pure horizontal / zero delta", () => {
    expect(wheelToGrokScrollKeys({ deltaY: 0 })).toBeNull();
  });

  it("maps one page-notch upward to PageUp", () => {
    expect(wheelToGrokScrollKeys({ deltaY: -GROK_WHEEL_PIXELS_PER_PAGE })).toBe(
      "\x1b[5~",
    );
  });

  it("maps one page-notch downward to PageDown", () => {
    expect(wheelToGrokScrollKeys({ deltaY: GROK_WHEEL_PIXELS_PER_PAGE })).toBe(
      "\x1b[6~",
    );
  });

  it("caps multi-page flicks", () => {
    const keys = wheelToGrokScrollKeys({ deltaY: 600 });
    expect(keys).toBe("\x1b[6~".repeat(3));
  });

  it("treats line-mode deltas of 3 lines as one page", () => {
    expect(wheelToGrokScrollKeys({ deltaY: -3, deltaMode: 1 })).toBe("\x1b[5~");
  });

  it("ignores sub-threshold trackpad ticks", () => {
    expect(wheelToGrokScrollKeys({ deltaY: 30 })).toBeNull();
    expect(wheelToGrokScrollKeys({ deltaY: -10 })).toBeNull();
  });
});

describe("createGrokWheelScroller (accumulating Page fallback)", () => {
  it("accumulates small trackpad deltas into one page", () => {
    const scroll = createGrokWheelScroller();
    expect(scroll({ deltaY: 24 })).toBeNull();
    expect(scroll({ deltaY: 24 })).toBeNull();
    expect(scroll({ deltaY: 24 })).toBe("\x1b[6~"); // 72
  });

  it("accumulates upward trackpad deltas into PageUp", () => {
    const scroll = createGrokWheelScroller();
    expect(scroll({ deltaY: -40 })).toBeNull();
    expect(scroll({ deltaY: -32 })).toBe("\x1b[5~");
  });

  it("resets residual on direction change", () => {
    const scroll = createGrokWheelScroller();
    expect(scroll({ deltaY: 50 })).toBeNull(); // residual +50
    // reverse: leftover discarded, accumulate up from -40
    expect(scroll({ deltaY: -40 })).toBeNull();
    expect(scroll({ deltaY: -32 })).toBe("\x1b[5~"); // -40 + -32 = -72
  });

  it("keeps leftover residual after emitting a page", () => {
    const scroll = createGrokWheelScroller();
    // 90 → one page (72), residual 18
    expect(scroll({ deltaY: 90 })).toBe("\x1b[6~");
    expect(scroll({ deltaY: 54 })).toBe("\x1b[6~"); // 18+54 = 72
  });

  it("instances do not share residual", () => {
    const a = createGrokWheelScroller();
    const b = createGrokWheelScroller();
    expect(a({ deltaY: 60 })).toBeNull();
    expect(b({ deltaY: 60 })).toBeNull();
    expect(a({ deltaY: 12 })).toBe("\x1b[6~");
    expect(b({ deltaY: 12 })).toBe("\x1b[6~");
  });
});
