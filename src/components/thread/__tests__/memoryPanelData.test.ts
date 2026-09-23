import { describe, expect, it } from "vitest";
import { sortMemoryEntries } from "../memoryPanelData";
import type { SessionMemoryEntry } from "../../../lib/commands";

function entry(over: Partial<SessionMemoryEntry> & { id: string }): SessionMemoryEntry {
  return {
    kind: "note",
    title: over.id,
    content: "",
    source: "agent",
    authority: "agent",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    archived: false,
    important: false,
    binding: false,
    bindingConfirmedAt: null,
    bindingConfirmedBy: null,
    status: "current",
    supersedes: [],
    ...over,
  } as SessionMemoryEntry;
}

describe("sortMemoryEntries", () => {
  it("pins binding entries above everything else", () => {
    const out = sortMemoryEntries([
      entry({ id: "important", important: true }),
      entry({ id: "pin", kind: "pin" }),
      entry({ id: "binding", binding: true }),
    ]);
    expect(out[0].id).toBe("binding");
  });

  it("ranks binding above important above pin above the rest", () => {
    const out = sortMemoryEntries([
      entry({ id: "plain" }),
      entry({ id: "pin", kind: "pin" }),
      entry({ id: "important", important: true }),
      entry({ id: "binding", binding: true }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["binding", "important", "pin", "plain"]);
  });

  it("breaks ties by most recently updated", () => {
    const out = sortMemoryEntries([
      entry({ id: "older", updatedAt: "2026-01-01T00:00:00Z" }),
      entry({ id: "newer", updatedAt: "2026-06-01T00:00:00Z" }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["newer", "older"]);
  });

  it("falls back to createdAt when updatedAt is missing", () => {
    const out = sortMemoryEntries([
      entry({ id: "older", updatedAt: "", createdAt: "2026-01-01T00:00:00Z" }),
      entry({ id: "newer", updatedAt: "", createdAt: "2026-06-01T00:00:00Z" }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["newer", "older"]);
  });

  it("does not mutate its input", () => {
    const input = [entry({ id: "a" }), entry({ id: "b", binding: true })];
    const copy = [...input];
    sortMemoryEntries(input);
    expect(input).toEqual(copy);
  });
});
