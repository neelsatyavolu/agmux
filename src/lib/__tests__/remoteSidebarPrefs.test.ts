import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { setRemoteSidebarProjectOrder, syncRemoteSidebarPrefs } from "../remoteSidebarPrefs";
import { useSettingsStore } from "../../stores/settingsStore";

describe("remote sidebar order", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    useSettingsStore.getState().updateSettings({ projectOrder: ["a", "b"] });
    setRemoteSidebarProjectOrder(null);
    vi.mocked(invoke).mockClear();
  });
  afterEach(() => {
    setRemoteSidebarProjectOrder(null);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("keeps the displayed order during pin/hide syncs and restores the manual order", async () => {
    setRemoteSidebarProjectOrder(["b", "a"]);
    localStorage.setItem("xanom:pinned-sessions:b", JSON.stringify(["session-b"]));
    syncRemoteSidebarPrefs();
    await vi.advanceTimersByTimeAsync(400);
    expect(invoke).toHaveBeenLastCalledWith("remote_sync_sidebar_prefs", {
      projectOrder: ["b", "a"], pinned: { b: ["session-b"] }, hidden: {},
    });
    expect(useSettingsStore.getState().settings.projectOrder).toEqual(["a", "b"]);
    setRemoteSidebarProjectOrder(null);
    await vi.advanceTimersByTimeAsync(400);
    expect(invoke).toHaveBeenLastCalledWith("remote_sync_sidebar_prefs", {
      projectOrder: ["a", "b"], pinned: { b: ["session-b"] }, hidden: {},
    });
  });
});
