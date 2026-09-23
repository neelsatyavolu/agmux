import { describe, it, expect } from "vitest";
import {
  DID_YOU_KNOW_TIPS,
  pickDidYouKnowTip,
  parseTip,
} from "../didYouKnowTips";

describe("didYouKnowTips", () => {
  it("DID_YOU_KNOW_TIPS contains tips", () => {
    expect(DID_YOU_KNOW_TIPS.length).toBeGreaterThan(0);
    for (const tip of DID_YOU_KNOW_TIPS) {
      expect(typeof tip).toBe("string");
      expect(tip.length).toBeGreaterThan(0);
    }
  });

  it("pickDidYouKnowTip returns one of the bundled tips", () => {
    const picked = pickDidYouKnowTip();
    expect(DID_YOU_KNOW_TIPS).toContain(picked);
  });

  it("parseTip splits text and code segments", () => {
    const segs = parseTip("Press `⌘K` to open palette.");
    expect(segs).toEqual([
      { kind: "text", value: "Press " },
      { kind: "code", value: "⌘K" },
      { kind: "text", value: " to open palette." },
    ]);
  });

  it("parseTip returns a single text segment when no backticks", () => {
    const segs = parseTip("Plain text only");
    expect(segs).toEqual([{ kind: "text", value: "Plain text only" }]);
  });

  it("parseTip skips empty segments between consecutive backticks", () => {
    const segs = parseTip("``code``");
    // Every segment must be non-empty.
    expect(segs.every((s) => s.value !== "")).toBe(true);
    // The visible "code" content must be one of the segments.
    expect(segs.some((s) => s.value === "code")).toBe(true);
  });

  it("parseTip returns empty array for empty string", () => {
    expect(parseTip("")).toEqual([]);
  });
});
