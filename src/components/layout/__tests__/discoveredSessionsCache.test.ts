import { describe, it, expect } from "vitest";
import {
  snapshotDiscoveredSessions,
  storeCodexSessions,
  storeClaudeSessions,
  storeKimiSessions,
  pruneDiscoveredSessions,
} from "../discoveredSessionsCache";

describe("discoveredSessionsCache", () => {
  it("exposes a codex/claude/kimi shape", () => {
    const snap = snapshotDiscoveredSessions();
    expect(snap.codex).toBeTypeOf("object");
    expect(snap.claude).toBeTypeOf("object");
    expect(snap.kimi).toBeTypeOf("object");
  });

  it("round-trips stored sessions for each kind", () => {
    storeCodexSessions("proj-codex", [{ id: "c1" } as never]);
    storeClaudeSessions("proj-claude", [{ id: "s1" } as never]);
    storeKimiSessions("proj-droid", [{ id: "d1" } as never]);

    const snap = snapshotDiscoveredSessions();
    expect(snap.codex["proj-codex"]).toHaveLength(1);
    expect(snap.claude["proj-claude"][0].id).toBe("s1");
    expect(snap.kimi["proj-droid"][0].id).toBe("d1");
  });

  it("returns a fresh top-level reference on every snapshot", () => {
    // The lazy `useState` initializer relies on this — a stale shared
    // reference would suppress the rerender when fresh data lands.
    const a = snapshotDiscoveredSessions();
    const b = snapshotDiscoveredSessions();
    expect(a).not.toBe(b);
    expect(a.codex).not.toBe(b.codex);
  });

  it("survives a simulated unmount/remount cycle", () => {
    storeClaudeSessions("proj-remount", [{ id: "keep-me" } as never]);
    // A remount only re-reads the snapshot; the cache itself is module-level.
    const afterRemount = snapshotDiscoveredSessions();
    expect(afterRemount.claude["proj-remount"][0].id).toBe("keep-me");
  });

  it("overwrites a project's entry on re-store", () => {
    storeCodexSessions("proj-overwrite", [{ id: "old" } as never]);
    storeCodexSessions("proj-overwrite", [{ id: "new" } as never]);
    const snap = snapshotDiscoveredSessions();
    expect(snap.codex["proj-overwrite"]).toHaveLength(1);
    expect(snap.codex["proj-overwrite"][0].id).toBe("new");
  });

  it("prunes cache entries for projects no longer present", () => {
    storeClaudeSessions("keep-proj", [{ id: "k1" } as never]);
    storeKimiSessions("keep-proj", [{ id: "dr1" } as never]);
    storeClaudeSessions("drop-proj", [{ id: "d1" } as never]);
    storeCodexSessions("drop-proj", [{ id: "c1" } as never]);

    pruneDiscoveredSessions(["keep-proj"]);

    const snap = snapshotDiscoveredSessions();
    expect(snap.claude["keep-proj"]).toBeDefined();
    expect(snap.kimi["keep-proj"]).toBeDefined();
    expect(snap.claude["drop-proj"]).toBeUndefined();
    expect(snap.codex["drop-proj"]).toBeUndefined();
  });

  it("clears every kind when no project ids are valid", () => {
    storeCodexSessions("gone", [{ id: "x" } as never]);
    pruneDiscoveredSessions([]);
    const snap = snapshotDiscoveredSessions();
    expect(Object.keys(snap.codex)).toHaveLength(0);
    expect(Object.keys(snap.claude)).toHaveLength(0);
    expect(Object.keys(snap.kimi)).toHaveLength(0);
  });
});
