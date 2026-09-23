import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearLocalStorage } from "./setup";

vi.mock("../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  summarizeThreadNamesBatch: vi.fn().mockResolvedValue([]),
  localModelStatus: vi.fn().mockResolvedValue({ model_downloaded: false }),
  ensureLocalLlmServer: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
}));

const PREVIEW_KEY = "agmux-session-previews";
const HISTORY_KEY = "agmux-session-prompt-history";

function readJson<T>(key: string): T {
  return JSON.parse(localStorage.getItem(key) ?? "{}") as T;
}

beforeEach(() => {
  vi.resetModules();
  clearLocalStorage();
});

// These caches share WebKit's 5 MiB localStorage quota with the created-session
// list. Unbounded growth filled the quota and new Claude terminals vanished.
describe("title caches stay bounded", () => {
  it("stores only the head of a very long prompt", async () => {
    const { useSessionNameStore, MAX_STORED_TITLE_TEXT } = await import("../sessionNameStore");
    useSessionNameStore.getState().summarize("s1", `Fix the login flow ${"x".repeat(50_000)}`);

    const history = readJson<Record<string, string[]>>(HISTORY_KEY);
    expect(history.s1).toHaveLength(1);
    expect(history.s1[0].length).toBeLessThanOrEqual(MAX_STORED_TITLE_TEXT);
    expect(history.s1[0].startsWith("Fix the login flow")).toBe(true);
    for (const preview of Object.values(readJson<Record<string, string>>(PREVIEW_KEY))) {
      expect(preview.length).toBeLessThanOrEqual(MAX_STORED_TITLE_TEXT);
    }
  });

  it("does not duplicate a repeated long prompt after truncation", async () => {
    const { useSessionNameStore } = await import("../sessionNameStore");
    const long = `Refactor the parser ${"y".repeat(5_000)}`;
    useSessionNameStore.getState().summarize("s1", long);
    useSessionNameStore.getState().summarize("s1", long);
    expect(readJson<Record<string, string[]>>(HISTORY_KEY).s1).toHaveLength(1);
  });

  it("evicts the least recently written sessions beyond the cap", async () => {
    const { useSessionNameStore, MAX_STORED_TITLE_SESSIONS } = await import("../sessionNameStore");
    const seededHistory: Record<string, string[]> = {};
    const seededPreviews: Record<string, string> = {};
    for (let i = 0; i < MAX_STORED_TITLE_SESSIONS + 50; i++) {
      seededHistory[`old-${i}`] = [`task ${i}`];
      seededPreviews[`old-${i}`] = `task ${i}`;
    }
    localStorage.setItem(HISTORY_KEY, JSON.stringify(seededHistory));
    localStorage.setItem(PREVIEW_KEY, JSON.stringify(seededPreviews));

    useSessionNameStore.getState().summarize("fresh", "Add dark mode to settings");

    const history = readJson<Record<string, string[]>>(HISTORY_KEY);
    expect(Object.keys(history)).toHaveLength(MAX_STORED_TITLE_SESSIONS);
    expect(history.fresh).toEqual(["Add dark mode to settings"]);
    expect(history["old-0"]).toBeUndefined();
    expect(history[`old-${MAX_STORED_TITLE_SESSIONS + 49}`]).toBeDefined();

    const previews = readJson<Record<string, string>>(PREVIEW_KEY);
    expect(Object.keys(previews)).toHaveLength(MAX_STORED_TITLE_SESSIONS);
    expect(previews.fresh).toBeDefined();
    expect(previews["old-0"]).toBeUndefined();
  });

  it("moves a re-written session to the most recent slot", async () => {
    const { useSessionNameStore, MAX_STORED_TITLE_SESSIONS } = await import("../sessionNameStore");
    const seeded: Record<string, string[]> = {};
    for (let i = 0; i < MAX_STORED_TITLE_SESSIONS; i++) seeded[`old-${i}`] = [`task ${i}`];
    localStorage.setItem(HISTORY_KEY, JSON.stringify(seeded));

    useSessionNameStore.getState().summarize("old-0", "Follow up on the first task");
    useSessionNameStore.getState().summarize("fresh", "Add dark mode to settings");

    const history = readJson<Record<string, string[]>>(HISTORY_KEY);
    expect(history["old-0"]).toBeDefined();
    expect(history["old-1"]).toBeUndefined();
  });
});
