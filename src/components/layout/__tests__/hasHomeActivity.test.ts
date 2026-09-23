import { describe, expect, it } from "vitest";
import { hasHomeActivity } from "../homeScreenRows";

describe("hasHomeActivity", () => {
  it("is false on a fresh install with nothing tracked", () => {
    expect(hasHomeActivity(0, {})).toBe(false);
  });

  it("is false when thread lists exist but are all empty", () => {
    expect(hasHomeActivity(0, { "p1": [], "p2": [] })).toBe(false);
  });

  it("is true once a project is tracked, even with no threads", () => {
    expect(hasHomeActivity(1, {})).toBe(true);
  });

  it("is true once any thread exists, even with no projects", () => {
    expect(hasHomeActivity(0, { "p1": [{} as never] })).toBe(true);
  });

  it("is true when both are present", () => {
    expect(hasHomeActivity(2, { "p1": [{} as never] })).toBe(true);
  });
});
