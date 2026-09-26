import { describe, it, expect } from "vitest";
import {
  focusCutoff,
  focusSince,
  formatFocusWindow,
  resolveFocusThreadsVisible,
  resolveFocusWindowMinutes,
  FOCUS_WINDOW_MINUTES_OPTIONS,
} from "../focusView";

describe("focusView", () => {
  it("computes the start of the Focus window", () => {
    expect(focusSince(60 * 60 * 1000, 10)).toBe(50 * 60 * 1000);
  });

  it("offers windows up to 30 minutes", () => {
    expect(Math.max(...FOCUS_WINDOW_MINUTES_OPTIONS)).toBe(30);
  });

  it("falls back to the default for unsupported saved windows", () => {
    expect(resolveFocusWindowMinutes(30)).toBe(30);
    expect(resolveFocusWindowMinutes(Number.NaN)).toBe(10);
    expect(resolveFocusWindowMinutes(0)).toBe(10);
    expect(resolveFocusWindowMinutes(24 * 60)).toBe(10);
    expect(resolveFocusWindowMinutes("15")).toBe(10);
    expect(resolveFocusWindowMinutes(undefined)).toBe(10);
  });

  it("formats every offered window for the empty state", () => {
    expect(FOCUS_WINDOW_MINUTES_OPTIONS.map(formatFocusWindow)).toEqual([
      "5 minutes",
      "10 minutes",
      "15 minutes",
      "20 minutes",
      "30 minutes",
    ]);
  });

  it("shows 7 threads by default and clamps saved counts", () => {
    expect(resolveFocusThreadsVisible(undefined)).toBe(7);
    expect(resolveFocusThreadsVisible(3)).toBe(3);
    expect(resolveFocusThreadsVisible(0)).toBe(1);
    expect(resolveFocusThreadsVisible(500)).toBe(100);
    expect(resolveFocusThreadsVisible("4")).toBe(7);
  });

  describe("focusCutoff", () => {
    it("lets every row through when they all fit", () => {
      expect(focusCutoff([[5, 3], [4]], 3)).toBe(-Infinity);
      expect(focusCutoff([], 7)).toBe(-Infinity);
    });

    it("returns the timestamp of the last row that fits, across projects", () => {
      expect(focusCutoff([[10, 2], [8, 6], [4]], 3)).toBe(6);
      expect(focusCutoff([[1], [9, 7, 3]], 1)).toBe(9);
    });
  });
});
