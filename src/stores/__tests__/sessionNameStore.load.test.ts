import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLocalStorage } from "./setup";

vi.mock("../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.resetModules();
  clearLocalStorage();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("session name metadata at startup", () => {
  it.each(["{}", "42", "true", '"session-id"'])("ignores non-array manual IDs: %s", async (raw) => {
    localStorage.setItem("agmux-session-manual-names", raw);
    const { useSessionNameStore } = await import("../sessionNameStore");
    useSessionNameStore.getState().setName("new-id", "New title");
    expect(JSON.parse(localStorage.getItem("agmux-session-manual-names")!)).toEqual(["new-id"]);
  });

  it("preserves valid manual IDs and ignores invalid members", async () => {
    localStorage.setItem("agmux-session-manual-names", JSON.stringify(["existing-id", null, 42, {}]));
    const { useSessionNameStore } = await import("../sessionNameStore");
    useSessionNameStore.getState().setName("new-id", "New title");
    expect(JSON.parse(localStorage.getItem("agmux-session-manual-names")!)).toEqual(["existing-id", "new-id"]);
  });
});
