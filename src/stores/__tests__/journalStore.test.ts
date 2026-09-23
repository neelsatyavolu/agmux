import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JournalProposal, ThreadJournalEntry } from "../../lib/types";

// Mock command module before store import. Use vi.hoisted because vi.mock is
// hoisted above all top-level statements.
const mocks = vi.hoisted(() => ({
  getJournalEntries: vi.fn(),
  createJournalEntry: vi.fn(),
  updateJournalEntry: vi.fn(),
  deleteJournalEntry: vi.fn(),
  acceptJournalProposal: vi.fn(),
}));

vi.mock("../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  getJournalEntries: mocks.getJournalEntries,
  createJournalEntry: mocks.createJournalEntry,
  updateJournalEntry: mocks.updateJournalEntry,
  deleteJournalEntry: mocks.deleteJournalEntry,
  acceptJournalProposal: mocks.acceptJournalProposal,
}));

const {
  getJournalEntries,
  createJournalEntry,
  updateJournalEntry,
  deleteJournalEntry,
  acceptJournalProposal,
} = mocks;

import { useJournalStore } from "../journalStore";

const INITIAL = { entries: [], proposals: [], loading: false };

function makeProposal(overrides: Partial<JournalProposal> = {}): JournalProposal {
  return {
    kind: "decision",
    title: "P1",
    content: "body",
    confidence: 0.9,
    ...overrides,
  } as JournalProposal;
}

function makeEntry(overrides: Partial<ThreadJournalEntry> = {}): ThreadJournalEntry {
  return {
    id: "e1",
    thread_id: "t1",
    kind: "decision",
    title: "T",
    content: "C",
    source: "User",
    confidence: null,
    created_by: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    ...overrides,
  } as ThreadJournalEntry;
}

describe("journalStore", () => {
  beforeEach(() => {
    useJournalStore.setState(INITIAL, false);
    getJournalEntries.mockReset();
    createJournalEntry.mockReset();
    updateJournalEntry.mockReset();
    deleteJournalEntry.mockReset();
    acceptJournalProposal.mockReset();
  });

  describe("initial state", () => {
    it("starts with empty entries, proposals, and loading=false", () => {
      const s = useJournalStore.getState();
      expect(s.entries).toEqual([]);
      expect(s.proposals).toEqual([]);
      expect(s.loading).toBe(false);
    });
  });

  describe("addProposal / dismissProposal", () => {
    it("addProposal appends to the list immutably", () => {
      const before = useJournalStore.getState().proposals;
      useJournalStore.getState().addProposal(makeProposal({ title: "p1" }));
      useJournalStore.getState().addProposal(makeProposal({ title: "p2" }));
      const after = useJournalStore.getState().proposals;
      expect(after).toHaveLength(2);
      expect(after).not.toBe(before);
      expect(after.map((p) => p.title)).toEqual(["p1", "p2"]);
    });

    it("dismissProposal removes the proposal at the given index", () => {
      useJournalStore.getState().addProposal(makeProposal({ title: "a" }));
      useJournalStore.getState().addProposal(makeProposal({ title: "b" }));
      useJournalStore.getState().addProposal(makeProposal({ title: "c" }));
      useJournalStore.getState().dismissProposal(1);
      expect(useJournalStore.getState().proposals.map((p) => p.title)).toEqual(["a", "c"]);
    });

    it("dismissProposal with out-of-range index leaves the list unchanged in length", () => {
      useJournalStore.getState().addProposal(makeProposal({ title: "a" }));
      useJournalStore.getState().dismissProposal(99);
      expect(useJournalStore.getState().proposals).toHaveLength(1);
    });

    it("dismissProposal with negative index leaves the list unchanged", () => {
      useJournalStore.getState().addProposal(makeProposal({ title: "a" }));
      useJournalStore.getState().dismissProposal(-1);
      expect(useJournalStore.getState().proposals).toHaveLength(1);
    });

    it("dismissProposal on empty list is a no-op", () => {
      useJournalStore.getState().dismissProposal(0);
      expect(useJournalStore.getState().proposals).toEqual([]);
    });
  });

  describe("fetchEntries", () => {
    it("populates entries on success and clears loading", async () => {
      const e = makeEntry({ id: "x" });
      getJournalEntries.mockResolvedValueOnce([e]);
      await useJournalStore.getState().fetchEntries("t1");
      expect(getJournalEntries).toHaveBeenCalledWith("t1", undefined);
      const s = useJournalStore.getState();
      expect(s.entries).toEqual([e]);
      expect(s.loading).toBe(false);
    });

    it("forwards the kindFilter parameter", async () => {
      getJournalEntries.mockResolvedValueOnce([]);
      await useJournalStore.getState().fetchEntries("t1", "decision");
      expect(getJournalEntries).toHaveBeenCalledWith("t1", "decision");
    });

    it("toggles loading=true while in flight, false after success", async () => {
      let resolveFn: ((v: ThreadJournalEntry[]) => void) | null = null;
      getJournalEntries.mockReturnValueOnce(
        new Promise((res) => {
          resolveFn = res;
        }),
      );
      const promise = useJournalStore.getState().fetchEntries("t1");
      // Loading flipped on synchronously after first set()
      expect(useJournalStore.getState().loading).toBe(true);
      resolveFn!([]);
      await promise;
      expect(useJournalStore.getState().loading).toBe(false);
    });

    it("clears loading on rejection without throwing", async () => {
      getJournalEntries.mockRejectedValueOnce(new Error("boom"));
      await expect(
        useJournalStore.getState().fetchEntries("t1"),
      ).resolves.toBeUndefined();
      expect(useJournalStore.getState().loading).toBe(false);
    });
  });

  describe("addEntry", () => {
    it("prepends new entry and returns it", async () => {
      const existing = makeEntry({ id: "old" });
      useJournalStore.setState({ entries: [existing] });
      const created = makeEntry({ id: "new" });
      createJournalEntry.mockResolvedValueOnce(created);
      const ret = await useJournalStore.getState().addEntry("t1", "decision", "T", "C");
      expect(createJournalEntry).toHaveBeenCalledWith("t1", "decision", "T", "C");
      expect(ret).toBe(created);
      expect(useJournalStore.getState().entries.map((e) => e.id)).toEqual(["new", "old"]);
    });
  });

  describe("updateEntry", () => {
    it("updates the matching entry and bumps updated_at", async () => {
      const e = makeEntry({ id: "e1", title: "old", content: "old" });
      useJournalStore.setState({ entries: [e] });
      updateJournalEntry.mockResolvedValueOnce(undefined);
      await useJournalStore.getState().updateEntry("e1", "newT", "newC");
      expect(updateJournalEntry).toHaveBeenCalledWith("e1", "newT", "newC");
      const updated = useJournalStore.getState().entries[0];
      expect(updated.title).toBe("newT");
      expect(updated.content).toBe("newC");
      expect(updated.updated_at).not.toBe(e.updated_at);
    });

    it("leaves non-matching entries untouched", async () => {
      const a = makeEntry({ id: "a", title: "A" });
      const b = makeEntry({ id: "b", title: "B" });
      useJournalStore.setState({ entries: [a, b] });
      updateJournalEntry.mockResolvedValueOnce(undefined);
      await useJournalStore.getState().updateEntry("a", "A2", "C");
      const after = useJournalStore.getState().entries;
      expect(after[0].title).toBe("A2");
      expect(after[1]).toBe(b); // unchanged reference
    });
  });

  describe("removeEntry", () => {
    it("filters the matching id from the list", async () => {
      const a = makeEntry({ id: "a" });
      const b = makeEntry({ id: "b" });
      useJournalStore.setState({ entries: [a, b] });
      deleteJournalEntry.mockResolvedValueOnce(undefined);
      await useJournalStore.getState().removeEntry("a");
      expect(deleteJournalEntry).toHaveBeenCalledWith("a");
      expect(useJournalStore.getState().entries).toEqual([b]);
    });

    it("is a no-op on the list when id is missing", async () => {
      const a = makeEntry({ id: "a" });
      useJournalStore.setState({ entries: [a] });
      deleteJournalEntry.mockResolvedValueOnce(undefined);
      await useJournalStore.getState().removeEntry("missing");
      expect(useJournalStore.getState().entries).toEqual([a]);
    });
  });

  describe("acceptProposal", () => {
    it("prepends the entry returned and removes the proposal", async () => {
      const p = makeProposal({ title: "p1" });
      useJournalStore.setState({ proposals: [p] });
      const created = makeEntry({ id: "from-proposal" });
      acceptJournalProposal.mockResolvedValueOnce(created);
      await useJournalStore.getState().acceptProposal("t1", p);
      expect(acceptJournalProposal).toHaveBeenCalledWith("t1", p.kind, p.title, p.content);
      const s = useJournalStore.getState();
      expect(s.entries[0]).toBe(created);
      expect(s.proposals).not.toContain(p);
    });

    it("removes only the matching proposal reference, leaves others intact", async () => {
      const p1 = makeProposal({ title: "1" });
      const p2 = makeProposal({ title: "2" });
      useJournalStore.setState({ proposals: [p1, p2] });
      acceptJournalProposal.mockResolvedValueOnce(makeEntry());
      await useJournalStore.getState().acceptProposal("t1", p1);
      expect(useJournalStore.getState().proposals).toEqual([p2]);
    });
  });
});
