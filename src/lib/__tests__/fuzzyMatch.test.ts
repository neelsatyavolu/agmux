import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "../fuzzyMatch";

describe("fuzzyScore", () => {
  it("returns 1 for an empty query", () => {
    expect(fuzzyScore("", "anything")).toBe(1);
    expect(fuzzyScore("", "")).toBe(1);
  });

  it("returns 0 when the query is longer than the target", () => {
    expect(fuzzyScore("hello world", "hi")).toBe(0);
  });

  it("returns 0 when not all query chars can be matched in order", () => {
    expect(fuzzyScore("xyz", "abcdef")).toBe(0);
    // Right chars, wrong order — second match would require going backwards
    expect(fuzzyScore("ba", "abc")).toBe(0);
  });

  it("is case insensitive", () => {
    expect(fuzzyScore("FOO", "foobar")).toBe(fuzzyScore("foo", "FOOBAR"));
    expect(fuzzyScore("FoO", "fOoBaR")).toBeGreaterThan(0);
  });

  it("scores contiguous matches higher than scattered ones", () => {
    const contiguous = fuzzyScore("abc", "abcxyz");
    const scattered = fuzzyScore("abc", "axbxcx");
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it("gives a bonus for matches right after a path separator", () => {
    const afterSep = fuzzyScore("f", "src/foo.ts");
    const midWord = fuzzyScore("f", "srcfoo.ts");
    expect(afterSep).toBeGreaterThan(midWord);
  });

  it("rewards shorter targets among equal matches", () => {
    const shortHit = fuzzyScore("a", "a");
    const longHit = fuzzyScore("a", "a" + "x".repeat(30));
    expect(shortHit).toBeGreaterThan(longHit);
  });
});

describe("fuzzyFilter", () => {
  it("returns the first `limit` items unchanged when the query is empty", () => {
    const items = ["a", "b", "c", "d"];
    const result = fuzzyFilter("", items, 2);
    expect(result).toEqual([
      { item: "a", score: 1 },
      { item: "b", score: 1 },
    ]);
  });

  it("filters out non-matching items", () => {
    const items = ["foo.ts", "bar.ts", "baz.ts"];
    const result = fuzzyFilter("foo", items);
    expect(result.map((r) => r.item)).toEqual(["foo.ts"]);
  });

  it("sorts results by score descending", () => {
    const items = ["axbxcx", "abcxyz", "xxabcxx"];
    const result = fuzzyFilter("abc", items);
    // "abcxyz" is the strongest contiguous match and should rank first
    expect(result[0].item).toBe("abcxyz");
    // Scores should be non-increasing
    for (let i = 1; i < result.length; i++) {
      expect(result[i].score).toBeLessThanOrEqual(result[i - 1].score);
    }
  });

  it("respects the limit argument", () => {
    const items = Array.from({ length: 100 }, (_, i) => `file${i}.ts`);
    const result = fuzzyFilter("file", items, 5);
    expect(result).toHaveLength(5);
  });

  it("defaults the limit to 50", () => {
    const items = Array.from({ length: 100 }, (_, i) => `file${i}.ts`);
    const result = fuzzyFilter("file", items);
    expect(result).toHaveLength(50);
  });

  it("returns an empty array when nothing matches", () => {
    expect(fuzzyFilter("zzz", ["foo", "bar"])).toEqual([]);
  });
});
