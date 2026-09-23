import { beforeEach, describe, expect, it } from "vitest";
import { installLocalStorage } from "./_localStorage";
import {
  addHiddenSession,
  loadHiddenSessions,
  removeHiddenSession,
} from "../hiddenSessions";

beforeEach(() => {
  installLocalStorage();
});

describe("hiddenSessions", () => {
  it("loads an empty set when nothing is stored", () => {
    expect(loadHiddenSessions("p1").size).toBe(0);
  });

  it("adds and persists a session id", () => {
    addHiddenSession("p1", "s1");
    expect(loadHiddenSessions("p1").has("s1")).toBe(true);
  });

  it("supports multiple ids per project", () => {
    addHiddenSession("p1", "a");
    addHiddenSession("p1", "b");
    addHiddenSession("p1", "c");
    const set = loadHiddenSessions("p1");
    expect(set.size).toBe(3);
    expect([...set].sort()).toEqual(["a", "b", "c"]);
  });

  it("isolates sessions across projects", () => {
    addHiddenSession("p1", "x");
    addHiddenSession("p2", "y");
    expect(loadHiddenSessions("p1")).toEqual(new Set(["x"]));
    expect(loadHiddenSessions("p2")).toEqual(new Set(["y"]));
  });

  it("removes a session id", () => {
    addHiddenSession("p1", "a");
    addHiddenSession("p1", "b");
    removeHiddenSession("p1", "a");
    expect(loadHiddenSessions("p1")).toEqual(new Set(["b"]));
  });

  it("removeHiddenSession is a no-op when id not present", () => {
    addHiddenSession("p1", "a");
    expect(() => removeHiddenSession("p1", "nope")).not.toThrow();
    expect(loadHiddenSessions("p1")).toEqual(new Set(["a"]));
  });

  it("addHiddenSession is idempotent", () => {
    addHiddenSession("p1", "dup");
    addHiddenSession("p1", "dup");
    expect(loadHiddenSessions("p1").size).toBe(1);
  });

  it("returns an empty set when stored payload is corrupt", () => {
    localStorage.setItem("xanom:hidden-sessions:p1", "{not json");
    expect(loadHiddenSessions("p1").size).toBe(0);
  });
});
