import { describe, it, expect } from "vitest";
import { focusSince, formatFocusWindow, resolveFocusWindowHours, FOCUS_WINDOW_HOURS_OPTIONS } from "../focusView";

describe("focusView", () => {
  it("computes the start of the Focus window", () => {
    expect(focusSince(10 * 60 * 60 * 1000, 4)).toBe(6 * 60 * 60 * 1000);
  });

  it("falls back to the default for unsupported saved windows", () => {
    expect(resolveFocusWindowHours(4)).toBe(4);
    expect(resolveFocusWindowHours(Number.NaN)).toBe(24);
    expect(resolveFocusWindowHours(0)).toBe(24);
    expect(resolveFocusWindowHours("12")).toBe(24);
    expect(resolveFocusWindowHours(undefined)).toBe(24);
  });

  it("formats every offered window for the empty state", () => {
    expect(FOCUS_WINDOW_HOURS_OPTIONS.map(formatFocusWindow)).toEqual([
      "hour",
      "4 hours",
      "12 hours",
      "24 hours",
      "3 days",
      "week",
    ]);
  });
});
