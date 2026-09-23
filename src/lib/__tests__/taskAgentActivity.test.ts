import { describe, it, expect } from "vitest";
import { isThreadMidTurn, countMidTurnThreads, isThreadAwaitingInput } from "../taskAgentActivity";

describe("taskAgentActivity", () => {
  it("recognizes input requests under app and mapped native Claude IDs", () => {
    const sources = { pendingApprovalsBySession: { native: {}, codex: {} }, claudeSessionMap: { claude: ["native"] } };
    expect(isThreadAwaitingInput("claude", sources)).toBe(true);
    expect(isThreadAwaitingInput("codex", sources)).toBe(true);
    expect(isThreadAwaitingInput("other", sources)).toBe(false);
  });
  it("isThreadMidTurn is true for claude processing", () => {
    expect(
      isThreadMidTurn("a", {
        claudeProcessingById: { a: true },
        codexProcessingById: {},
      }),
    ).toBe(true);
  });

  it("isThreadMidTurn is true for codex processing", () => {
    expect(
      isThreadMidTurn("b", {
        claudeProcessingById: {},
        codexProcessingById: { b: true },
      }),
    ).toBe(true);
  });

  it("isThreadMidTurn is false when neither map is set", () => {
    expect(
      isThreadMidTurn("c", {
        claudeProcessingById: { c: false },
        codexProcessingById: {},
      }),
    ).toBe(false);
  });

  it("countMidTurnThreads counts only active ids", () => {
    const sources = {
      claudeProcessingById: { a: true, b: false },
      codexProcessingById: { c: true },
    };
    expect(countMidTurnThreads(["a", "b", "c", "d"], sources)).toBe(2);
  });
});
