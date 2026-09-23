import { describe, expect, it } from "vitest";
import {
  densityIsCompact,
  densityIsDense,
  type ComposerDensity,
} from "../useComposerDensity";

describe("useComposerDensity helpers", () => {
  it("densityIsCompact is true for compact and dense", () => {
    const cases: Array<[ComposerDensity, boolean]> = [
      ["full", false],
      ["compact", true],
      ["dense", true],
    ];
    for (const [d, expected] of cases) {
      expect(densityIsCompact(d)).toBe(expected);
    }
  });

  it("densityIsDense is only true for dense", () => {
    expect(densityIsDense("full")).toBe(false);
    expect(densityIsDense("compact")).toBe(false);
    expect(densityIsDense("dense")).toBe(true);
  });
});
