/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { codexListThreads } from "../commands";

vi.mock("../commands", () => ({ codexListThreads: vi.fn() }));
const thread = { id: "saved", cwd: "/repo", preview: "Saved thread", createdAt: 1, updatedAt: 2, status: { type: "active" } };

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  vi.mocked(codexListThreads).mockReset();
});

describe("Codex startup cache", () => {
  it("restores compact rows after restart without restoring active status", async () => {
    const cache = await import("../codexThreadsCache");
    vi.mocked(codexListThreads).mockResolvedValue({ data: [{ ...thread, turns: ["large transcript"] }] });
    await cache.refreshCodexThreads("/repo");
    vi.resetModules();
    const restarted = await import("../codexThreadsCache");
    expect(restarted.getCachedCodexThreads()).toEqual([{ ...thread, status: { type: "notLoaded" } }]);
    expect(codexListThreads).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("agmux-codex-threads-v1")).not.toContain("large transcript");
  });

  it("shares a global refresh across projects and preserves rows on failure", async () => {
    const cache = await import("../codexThreadsCache");
    vi.mocked(codexListThreads).mockResolvedValue({ data: [thread] });
    await Promise.all([cache.refreshCodexThreads("/a"), cache.refreshCodexThreads("/b")]);
    expect(codexListThreads).toHaveBeenCalledTimes(1);
    vi.mocked(codexListThreads).mockRejectedValue(new Error("offline"));
    await expect(cache.refreshCodexThreads("/a")).rejects.toThrow("offline");
    expect(cache.getCachedCodexThreads()).toEqual([thread]);
    vi.mocked(codexListThreads).mockResolvedValue({ data: [] });
    await cache.refreshCodexThreads("/a");
    expect(cache.getCachedCodexThreads()).toEqual([]);
  });

  it("ignores malformed persisted data", async () => {
    localStorage.setItem("agmux-codex-threads-v1", '[{"id":12}]');
    const cache = await import("../codexThreadsCache");
    expect(cache.getCachedCodexThreads()).toEqual([]);
  });
});
