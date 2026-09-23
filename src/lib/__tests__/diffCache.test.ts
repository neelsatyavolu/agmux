import { describe, expect, it } from "vitest";
import { computeDiff, getCachedDiff } from "../diffCache";

describe("computeDiff", () => {
  it("returns all-context for identical strings", () => {
    const out = computeDiff("a\nb\nc", "a\nb\nc");
    expect(out.every((l) => l.type === "context")).toBe(true);
    expect(out.map((l) => l.content)).toEqual(["a", "b", "c"]);
    expect(out[0]).toEqual({ type: "context", content: "a", oldLineNo: 1, newLineNo: 1 });
  });

  it("returns only added lines when old is empty", () => {
    const out = computeDiff("", "x\ny");
    // empty string still splits to [""]
    const added = out.filter((l) => l.type === "added");
    expect(added.map((l) => l.content)).toEqual(["x", "y"]);
    expect(added[0].newLineNo).toBe(1);
    expect(added[0].oldLineNo).toBeNull();
  });

  it("returns only removed lines when new is empty", () => {
    const out = computeDiff("x\ny", "");
    const removed = out.filter((l) => l.type === "removed");
    expect(removed.map((l) => l.content)).toEqual(["x", "y"]);
    expect(removed[0].oldLineNo).toBe(1);
    expect(removed[0].newLineNo).toBeNull();
  });

  it("detects a single-line change as remove + add", () => {
    const out = computeDiff("a\nb\nc", "a\nB\nc");
    const types = out.map((l) => l.type);
    expect(types).toContain("removed");
    expect(types).toContain("added");
    // 'a' and 'c' should remain as context
    const ctx = out.filter((l) => l.type === "context").map((l) => l.content);
    expect(ctx).toContain("a");
    expect(ctx).toContain("c");
  });

  it("preserves line numbering for added lines", () => {
    const out = computeDiff("a\nc", "a\nb\nc");
    const added = out.find((l) => l.type === "added");
    expect(added?.content).toBe("b");
    expect(added?.newLineNo).toBe(2);
    expect(added?.oldLineNo).toBeNull();
  });
});

describe("getCachedDiff", () => {
  it("returns identical results to computeDiff for the same inputs", () => {
    const a = "x\ny\nz";
    const b = "x\nY\nz";
    expect(getCachedDiff(a, b)).toEqual(computeDiff(a, b));
  });

  it("returns the same array reference on a cache hit", () => {
    const a = "cache-hit-test-1\nabc";
    const b = "cache-hit-test-1\nABC";
    const first = getCachedDiff(a, b);
    const second = getCachedDiff(a, b);
    expect(second).toBe(first);
  });

  it("returns distinct results for distinct inputs", () => {
    const r1 = getCachedDiff("p", "q");
    const r2 = getCachedDiff("p", "r");
    expect(r1).not.toBe(r2);
    // both should still be valid diffs
    expect(r1.length).toBeGreaterThan(0);
    expect(r2.length).toBeGreaterThan(0);
  });

  it("evicts entries past the cache limit (LRU-by-insertion)", () => {
    // MAX_CACHE = 100. Push 105 unique entries; the very first should no
    // longer be a cache hit (new array reference returned).
    const firstA = "evict-test-A-0";
    const firstB = "evict-test-B-0";
    const firstResult = getCachedDiff(firstA, firstB);
    for (let i = 1; i < 110; i++) {
      getCachedDiff(`evict-test-A-${i}`, `evict-test-B-${i}`);
    }
    const refetched = getCachedDiff(firstA, firstB);
    expect(refetched).not.toBe(firstResult);
    // But content should still be equivalent
    expect(refetched).toEqual(firstResult);
  });
});
