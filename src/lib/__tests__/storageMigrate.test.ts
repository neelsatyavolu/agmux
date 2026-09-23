import { describe, it, expect, beforeEach } from "vitest";
import { migrateLegacyStorageKeys } from "../storageMigrate";

describe("migrateLegacyStorageKeys", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("copies xanom-* keys to agmux-* and removes legacy keys", () => {
    localStorage.setItem("xanom-settings", '{"a":1}');
    localStorage.setItem("xanom-session-names", "{}");
    localStorage.setItem("unrelated", "keep");

    migrateLegacyStorageKeys();

    expect(localStorage.getItem("agmux-settings")).toBe('{"a":1}');
    expect(localStorage.getItem("agmux-session-names")).toBe("{}");
    expect(localStorage.getItem("xanom-settings")).toBeNull();
    expect(localStorage.getItem("xanom-session-names")).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("keep");
    expect(localStorage.getItem("agmux-storage-migrated-v1")).toBe("1");
  });

  it("does not overwrite an existing agmux-* value", () => {
    localStorage.setItem("xanom-settings", "old");
    localStorage.setItem("agmux-settings", "new");

    migrateLegacyStorageKeys();

    expect(localStorage.getItem("agmux-settings")).toBe("new");
    expect(localStorage.getItem("xanom-settings")).toBeNull();
  });

  it("is idempotent", () => {
    localStorage.setItem("xanom-settings", "v");
    migrateLegacyStorageKeys();
    localStorage.setItem("xanom-settings", "should-not-migrate");
    migrateLegacyStorageKeys();
    expect(localStorage.getItem("agmux-settings")).toBe("v");
    expect(localStorage.getItem("xanom-settings")).toBe("should-not-migrate");
  });
});
