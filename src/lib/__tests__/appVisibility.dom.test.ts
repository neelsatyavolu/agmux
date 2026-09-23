/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  installAppVisibilitySync,
  isAppForeground,
  subscribeAppVisibility,
  syncPollingToAppForeground,
  _resetAppVisibilityForTests,
} from "../appVisibility";

beforeEach(() => {
  _resetAppVisibilityForTests();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => false,
  });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  _resetAppVisibilityForTests();
  vi.restoreAllMocks();
});

describe("installAppVisibilitySync", () => {
  it("pushes initial foreground state on install", () => {
    installAppVisibilitySync();
    expect(invoke).toHaveBeenCalledWith(
      "set_app_foreground",
      expect.objectContaining({ foreground: expect.any(Boolean) }),
    );
  });

  it("emits set_app_foreground on visibilitychange events", () => {
    installAppVisibilitySync();
    vi.mocked(invoke).mockClear();

    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(invoke).toHaveBeenCalledWith("set_app_foreground", {
      foreground: false,
    });
    expect(document.documentElement.classList.contains("app-backgrounded")).toBe(
      true,
    );

    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(invoke).toHaveBeenCalledWith("set_app_foreground", {
      foreground: true,
    });
    expect(document.documentElement.classList.contains("app-backgrounded")).toBe(
      false,
    );
  });

  it("treats window blur as background even when the document is visible", () => {
    installAppVisibilitySync();
    vi.mocked(invoke).mockClear();

    window.dispatchEvent(new Event("blur"));
    expect(isAppForeground()).toBe(false);
    expect(invoke).toHaveBeenCalledWith("set_app_foreground", {
      foreground: false,
    });
    expect(document.documentElement.classList.contains("app-backgrounded")).toBe(
      true,
    );

    window.dispatchEvent(new Event("focus"));
    expect(isAppForeground()).toBe(true);
    expect(invoke).toHaveBeenCalledWith("set_app_foreground", {
      foreground: true,
    });
  });

  it("dedupes redundant emits when state hasn't changed", () => {
    installAppVisibilitySync();
    vi.mocked(invoke).mockClear();

    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));

    expect(invoke).not.toHaveBeenCalled();
  });

  it("notifies subscribers on focus changes", () => {
    installAppVisibilitySync();
    const seen: boolean[] = [];
    const unsub = subscribeAppVisibility((s) => seen.push(s.foreground));
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    unsub();
    expect(seen).toEqual([false, true]);
  });

  it("syncPollingToAppForeground stops on blur and resumes on focus", () => {
    installAppVisibilitySync();
    const start = vi.fn();
    const stop = vi.fn();
    const resume = vi.fn();
    const unsub = syncPollingToAppForeground(start, stop, resume);
    expect(start).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("blur"));
    expect(stop).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("focus"));
    expect(resume).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);
    unsub();
  });
});
