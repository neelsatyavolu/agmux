import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLocalStorage } from "./setup";

vi.mock("../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
}));

const now = Date.UTC(2026, 8, 12);
const cutoff = now - 90 * 86400000;
const activity = (id: string, lastActiveMs = cutoff - 1, protected_ = false) =>
  ({ id, lastActiveMs, protected: protected_ });

beforeEach(() => {
  vi.resetModules();
  clearLocalStorage();
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function seed(ids: string[]) {
  localStorage.setItem("agmux-session-names", JSON.stringify(Object.fromEntries(ids.map(id => [id, `Title ${id}`]))));
  localStorage.setItem("agmux-session-previews", JSON.stringify(Object.fromEntries(ids.map(id => [id, `Prompt ${id}`]))));
  localStorage.setItem("agmux-session-prompt-history", JSON.stringify(Object.fromEntries(ids.map(id => [id, [`Prompt ${id}`]]))));
}

describe("90-day title cache cleanup", () => {
  it("previews only verified old, inactive, automatically named sessions without writing", async () => {
    seed(["old", "boundary", "recent", "unknown", "manual", "live", "open"]);
    localStorage.setItem("agmux-session-manual-names", '["manual"]');
    const { useSessionNameStore } = await import("../sessionNameStore");
    const before = localStorage.getItem("agmux-session-names");
    const result = useSessionNameStore.getState().previewCleanup([
      activity("old"), activity("boundary", cutoff), activity("recent", now),
      activity("manual"), activity("live", cutoff - 1, true), activity("open"),
    ], ["open"]);
    expect(result.entries.map(e => e.id)).toEqual(["old"]);
    expect(result.entries[0].bytes).toBeGreaterThan(0);
    expect(result.unknownCount).toBe(1);
    expect(localStorage.getItem("agmux-session-names")).toBe(before);
  });

  it("removes only reviewed caches and preserves unrelated storage, manual names and conversations", async () => {
    seed(["old", "manual"]);
    localStorage.setItem("agmux-session-manual-names", '["manual"]');
    localStorage.setItem("agmux-teams", "protected");
    localStorage.setItem("agmux-project-memory", "protected");
    const { useSessionNameStore } = await import("../sessionNameStore");
    const state = useSessionNameStore.getState();
    const preview = state.previewCleanup([activity("old"), activity("manual")]);
    const result = state.cleanup(preview, [activity("old"), activity("manual")]);
    expect(result.removedCount).toBe(1);
    expect(useSessionNameStore.getState().names).toEqual({ manual: "Title manual" });
    expect(JSON.parse(localStorage.getItem("agmux-session-prompt-history")!)).toEqual({ manual: ["Prompt manual"] });
    expect(localStorage.getItem("agmux-session-manual-names")).toBe('["manual"]');
    expect(localStorage.getItem("agmux-teams")).toBe("protected");
    expect(localStorage.getItem("agmux-project-memory")).toBe("protected");
    state.summarize("old", "Prompt old", "discovery");
    expect(useSessionNameStore.getState().names.old).toBeUndefined();
    expect(useSessionNameStore.getState().logs).toEqual([]);
  });

  it("rechecks activity, newly manual names and cache changes after the preview", async () => {
    seed(["active", "changed", "manual", "untouched"]);
    const { useSessionNameStore } = await import("../sessionNameStore");
    const state = useSessionNameStore.getState();
    const proof = ["active", "changed", "manual", "untouched"].map(id => activity(id));
    const preview = state.previewCleanup(proof);
    state.setName("manual", "Keep me");
    localStorage.setItem("agmux-session-previews", JSON.stringify({ changed: "New prompt" }));
    const result = state.cleanup(preview, [activity("active", now), ...proof.slice(1)]);
    expect(result.removedCount).toBe(0); // all remaining preview fingerprints changed
    expect(result.skippedCount).toBe(4);
    expect(useSessionNameStore.getState().names.manual).toBe("Keep me");
  });

  it("keeps recent summary edits even when the underlying conversation is old", async () => {
    seed(["old"]);
    localStorage.setItem("agmux-session-name-updated-at", JSON.stringify({ old: now }));
    const { useSessionNameStore } = await import("../sessionNameStore");
    expect(useSessionNameStore.getState().previewCleanup([activity("old")]).entries).toEqual([]);
  });

  it("reports unknown ages even when the backend marks them protected", async () => {
    seed(["unknown"]);
    const { useSessionNameStore } = await import("../sessionNameStore");
    const preview = useSessionNameStore.getState().previewCleanup([{ id: "unknown", lastActiveMs: null, protected: true }]);
    expect(preview.entries).toEqual([]);
    expect(preview.unknownCount).toBe(1);
  });

  it("protects queued work and lets an actual new prompt recreate a cleaned title", async () => {
    seed(["old"]);
    const { useSessionNameStore } = await import("../sessionNameStore");
    const state = useSessionNameStore.getState();
    state.cleanup(state.previewCleanup([activity("old")]), [activity("old")]);
    state.summarize("old", "Fix the new issue", "sdk");
    expect(useSessionNameStore.getState().names.old).toBe("Fix the new issue");
    expect(useSessionNameStore.getState().previewCleanup([activity("old")]).entries).toEqual([]);
  });

  it("fails closed for corrupt persisted cache rather than overwriting it", async () => {
    seed(["old"]);
    localStorage.setItem("agmux-session-prompt-history", "broken JSON");
    const { useSessionNameStore } = await import("../sessionNameStore");
    expect(() => useSessionNameStore.getState().previewCleanup([activity("old")])).toThrow();
    expect(localStorage.getItem("agmux-session-prompt-history")).toBe("broken JSON");
  });
});
