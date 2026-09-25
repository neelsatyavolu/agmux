import { beforeEach, describe, expect, it, vi } from "vitest";
import { installLocalStorage } from "./_localStorage";
import {
  addPinnedSession,
  loadPinnedSessions,
  removePinnedSession,
  transferPinnedSessions,
} from "../pinnedSessions";

beforeEach(() => {
  installLocalStorage();
});

describe("pinnedSessions", () => {
  it("loads an empty set when nothing is stored", () => {
    expect(loadPinnedSessions("p1").size).toBe(0);
  });

  it("adds and persists a session id", () => {
    addPinnedSession("p1", "s1");
    expect(loadPinnedSessions("p1").has("s1")).toBe(true);
  });

  it("isolates sessions across projects", () => {
    addPinnedSession("p1", "x");
    addPinnedSession("p2", "y");
    expect(loadPinnedSessions("p1")).toEqual(new Set(["x"]));
    expect(loadPinnedSessions("p2")).toEqual(new Set(["y"]));
  });

  it("removes a session id and persists", () => {
    addPinnedSession("p1", "a");
    addPinnedSession("p1", "b");
    removePinnedSession("p1", "a");
    expect(loadPinnedSessions("p1")).toEqual(new Set(["b"]));
  });

  it("removePinnedSession is a no-op when id not present", () => {
    addPinnedSession("p1", "a");
    expect(() => removePinnedSession("p1", "nope")).not.toThrow();
    expect(loadPinnedSessions("p1")).toEqual(new Set(["a"]));
  });

  it("addPinnedSession is idempotent", () => {
    addPinnedSession("p1", "dup");
    addPinnedSession("p1", "dup");
    expect(loadPinnedSessions("p1").size).toBe(1);
  });

  it("transferPinnedSessions merges into dest and clears source", () => {
    addPinnedSession("from", "a");
    addPinnedSession("from", "b");
    addPinnedSession("to", "b");
    addPinnedSession("to", "c");
    transferPinnedSessions("from", "to");
    expect(loadPinnedSessions("from").size).toBe(0);
    expect(loadPinnedSessions("to")).toEqual(new Set(["a", "b", "c"]));
  });

  it("keeps pins for this app run when localStorage is full", () => {
    const quota = () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
    addPinnedSession("p1", "saved");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(quota);
    try {
      expect(() => addPinnedSession("p1", "pinned")).not.toThrow();
      expect(loadPinnedSessions("p1")).toEqual(new Set(["saved", "pinned"]));
      expect(() => removePinnedSession("p1", "saved")).not.toThrow();
      expect(() => transferPinnedSessions("p1", "p2")).not.toThrow();
      expect(loadPinnedSessions("p1").size).toBe(0);
      expect(loadPinnedSessions("p2")).toEqual(new Set(["pinned"]));
      expect(warn).toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
      warn.mockRestore();
    }
  });

  it("returns an empty set when stored payload is corrupt", () => {
    localStorage.setItem("xanom:pinned-sessions:p1", "{not json");
    expect(loadPinnedSessions("p1").size).toBe(0);
  });
});
