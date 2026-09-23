import { beforeEach, describe, expect, it, vi } from "vitest";
import { installLocalStorage } from "./_localStorage";
import {
  addCreatedClaudeSession,
  loadCreatedClaudeSessions,
  removeCreatedClaudeSession,
} from "../createdSessions";

beforeEach(() => {
  installLocalStorage();
});

describe("createdSessions", () => {
  it("loads an empty set when nothing is stored", () => {
    expect(loadCreatedClaudeSessions("p1").size).toBe(0);
  });

  it("adds, loads, and removes session ids", () => {
    addCreatedClaudeSession("p1", "uuid-1");
    addCreatedClaudeSession("p1", "uuid-2");
    expect(loadCreatedClaudeSessions("p1")).toEqual(new Set(["uuid-1", "uuid-2"]));
    removeCreatedClaudeSession("p1", "uuid-1");
    expect(loadCreatedClaudeSessions("p1")).toEqual(new Set(["uuid-2"]));
  });

  it("isolates state across projects", () => {
    addCreatedClaudeSession("p1", "a");
    addCreatedClaudeSession("p2", "b");
    expect(loadCreatedClaudeSessions("p1")).toEqual(new Set(["a"]));
    expect(loadCreatedClaudeSessions("p2")).toEqual(new Set(["b"]));
  });

  it("addCreatedClaudeSession is idempotent", () => {
    addCreatedClaudeSession("p1", "dup");
    addCreatedClaudeSession("p1", "dup");
    expect(loadCreatedClaudeSessions("p1").size).toBe(1);
  });

  it("removeCreatedClaudeSession is a no-op for missing id", () => {
    addCreatedClaudeSession("p1", "x");
    expect(() => removeCreatedClaudeSession("p1", "missing")).not.toThrow();
    expect(loadCreatedClaudeSessions("p1")).toEqual(new Set(["x"]));
  });

  it("keeps created ids for this app run when localStorage is full", () => {
    const quota = () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(quota);
    try {
      addCreatedClaudeSession("p1", "new-terminal");
      expect(loadCreatedClaudeSessions("p1")).toEqual(new Set(["new-terminal"]));
      expect(warn).toHaveBeenCalled();
      removeCreatedClaudeSession("p1", "new-terminal");
      expect(loadCreatedClaudeSessions("p1").size).toBe(0);
    } finally {
      setItem.mockRestore();
      warn.mockRestore();
    }
  });

  it("returns empty set on corrupt payload", () => {
    localStorage.setItem("agmux-created-claude-sessions:p1", "not-json");
    expect(loadCreatedClaudeSessions("p1").size).toBe(0);
  });
});
