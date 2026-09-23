import { describe, it, expect } from "vitest";
import {
  sanitizeBranchName,
  validateBranchName,
  nextAvailableBranchName,
  TASK_NAME_MAX_LENGTH,
} from "../taskUtils";

describe("sanitizeBranchName", () => {
  it("converts spaces to hyphens", () => {
    expect(sanitizeBranchName("auth flow")).toBe("auth-flow");
  });

  it("converts to lowercase", () => {
    expect(sanitizeBranchName("Auth Flow")).toBe("auth-flow");
  });

  it("removes special characters", () => {
    expect(sanitizeBranchName("fix: login bug!")).toBe("fix-login-bug");
  });

  it("collapses multiple hyphens", () => {
    expect(sanitizeBranchName("fix--the---bug")).toBe("fix-the-bug");
  });

  it("trims leading and trailing hyphens", () => {
    expect(sanitizeBranchName("-leading-")).toBe("leading");
  });

  it("truncates to 50 characters", () => {
    const long = "a".repeat(60);
    expect(sanitizeBranchName(long).length).toBe(50);
  });

  it("returns fallback for empty string", () => {
    expect(sanitizeBranchName("")).toBe("task");
  });

  it("returns fallback for all-special-char input", () => {
    expect(sanitizeBranchName("!!!@@@")).toBe("task");
  });

  it("strips trailing hyphen after truncation", () => {
    const name = "a-".repeat(26); // 52 chars, truncated at 50 → ends with "-"
    const result = sanitizeBranchName(name);
    expect(result.endsWith("-")).toBe(false);
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it("handles already valid branch name", () => {
    expect(sanitizeBranchName("feature-auth")).toBe("feature-auth");
  });

  it("handles numeric input", () => {
    expect(sanitizeBranchName("issue 123")).toBe("issue-123");
  });

  it("handles unicode/emoji", () => {
    // "fix 🐛 login" → lowercase → "fix 🐛 login"
    // remove non [a-z0-9\s-] → "fix  login" (emoji removed, two spaces remain)
    // spaces→hyphens → "fix--login"
    // collapse hyphens → "fix-login"
    expect(sanitizeBranchName("fix 🐛 login")).toBe("fix-login");
  });
});

describe("validateBranchName", () => {
  it("accepts simple lowercase names", () => {
    expect(validateBranchName("feature-auth")).toBeNull();
    expect(validateBranchName("fix/login")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(validateBranchName("")).toMatch(/required/i);
  });

  it("rejects whitespace", () => {
    expect(validateBranchName("my branch")).toMatch(/whitespace/);
  });

  it("rejects double dots", () => {
    expect(validateBranchName("foo..bar")).toMatch(/'\.\.'/);
  });

  it("rejects leading dash", () => {
    expect(validateBranchName("-bad")).toMatch(/'-'/);
  });

  it("rejects leading or trailing slash", () => {
    expect(validateBranchName("/bad")).toMatch(/'\/'/);
    expect(validateBranchName("bad/")).toMatch(/'\/'/);
  });

  it("rejects double slash", () => {
    expect(validateBranchName("a//b")).toMatch(/'\/\/'/);
  });

  it("rejects .lock suffix", () => {
    expect(validateBranchName("feat.lock")).toMatch(/lock/);
  });
});

describe("nextAvailableBranchName", () => {
  it("returns desired when not in use", () => {
    expect(nextAvailableBranchName("feat", new Set())).toBe("feat");
  });

  it("appends -2 on first collision", () => {
    expect(nextAvailableBranchName("feat", new Set(["feat"]))).toBe("feat-2");
  });

  it("walks past consecutive collisions", () => {
    expect(
      nextAvailableBranchName("feat", new Set(["feat", "feat-2", "feat-3"])),
    ).toBe("feat-4");
  });

  it("strips existing -N suffix to avoid feat-2-2", () => {
    expect(nextAvailableBranchName("feat-2", new Set(["feat-2"]))).toBe("feat-3");
  });
});

describe("TASK_NAME_MAX_LENGTH", () => {
  it("is a sane positive integer", () => {
    expect(Number.isInteger(TASK_NAME_MAX_LENGTH)).toBe(true);
    expect(TASK_NAME_MAX_LENGTH).toBeGreaterThan(0);
  });
});
