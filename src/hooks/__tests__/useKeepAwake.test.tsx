/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({
    active: false,
    closedLidActive: false,
    closedLidError: null,
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import { useKeepAwake } from "../useKeepAwake";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue({
    active: false,
    closedLidActive: false,
    closedLidError: null,
  });
  cleanup();
  useSettingsStore.setState((s) => ({
    ...s,
    settings: {
      ...s.settings,
      keepAwakeWhileRunning: false,
      keepAwakeClosedLid: false,
    },
  }));
  useUiStore.setState({
    sessionStates: {},
    pendingApprovalsBySession: {},
  } as unknown as Parameters<typeof useUiStore.setState>[0]);
});

describe("useKeepAwake", () => {
  it("calls set_keep_awake with false when feature disabled", () => {
    renderHook(() => useKeepAwake());

    expect(invoke).toHaveBeenCalledWith("set_keep_awake", {
      enabled: false,
      closedLid: false,
    });
  });

  it("calls set_keep_awake with true when enabled and a session is processing", () => {
    useSettingsStore.setState((s) => ({
      ...s,
      settings: { ...s.settings, keepAwakeWhileRunning: true },
    }));
    useUiStore.setState({
      sessionStates: { s1: { state: "processing" } },
      pendingApprovalsBySession: {},
    } as unknown as Parameters<typeof useUiStore.setState>[0]);

    renderHook(() => useKeepAwake());

    expect(invoke).toHaveBeenCalledWith("set_keep_awake", {
      enabled: true,
      closedLid: false,
    });
  });

  it("releases the assertion on unmount", () => {
    const { unmount } = renderHook(() => useKeepAwake());
    vi.mocked(invoke).mockClear();
    unmount();
    expect(invoke).toHaveBeenCalledWith("set_keep_awake", {
      enabled: false,
      closedLid: false,
    });
  });

  it("treats 'awaiting_approval' and 'awaiting_stop' as active", () => {
    useSettingsStore.setState((s) => ({
      ...s,
      settings: { ...s.settings, keepAwakeWhileRunning: true },
    }));
    useUiStore.setState({
      sessionStates: { s1: { state: "awaiting_approval" } },
      pendingApprovalsBySession: {},
    } as unknown as Parameters<typeof useUiStore.setState>[0]);

    renderHook(() => useKeepAwake());
    expect(invoke).toHaveBeenCalledWith("set_keep_awake", {
      enabled: true,
      closedLid: false,
    });
  });

  it("treats pendingApprovalsBySession as active even if state is idle", () => {
    useSettingsStore.setState((s) => ({
      ...s,
      settings: { ...s.settings, keepAwakeWhileRunning: true },
    }));
    useUiStore.setState({
      sessionStates: { s1: { state: "idle" } },
      pendingApprovalsBySession: {
        s1: { sessionId: "s1", toolName: "Bash", summary: "ls" },
      },
    } as unknown as Parameters<typeof useUiStore.setState>[0]);

    renderHook(() => useKeepAwake());
    expect(invoke).toHaveBeenCalledWith("set_keep_awake", {
      enabled: true,
      closedLid: false,
    });
  });

  it("passes closedLid when closed-display mode is enabled and active", () => {
    useSettingsStore.setState((s) => ({
      ...s,
      settings: {
        ...s.settings,
        keepAwakeWhileRunning: true,
        keepAwakeClosedLid: true,
      },
    }));
    useUiStore.setState({
      sessionStates: { s1: { state: "processing" } },
      pendingApprovalsBySession: {},
    } as unknown as Parameters<typeof useUiStore.setState>[0]);

    renderHook(() => useKeepAwake());
    expect(invoke).toHaveBeenCalledWith("set_keep_awake", {
      enabled: true,
      closedLid: true,
    });
  });

  it("does not pass closedLid when no session is active", () => {
    useSettingsStore.setState((s) => ({
      ...s,
      settings: {
        ...s.settings,
        keepAwakeWhileRunning: true,
        keepAwakeClosedLid: true,
      },
    }));

    renderHook(() => useKeepAwake());
    expect(invoke).toHaveBeenCalledWith("set_keep_awake", {
      enabled: false,
      closedLid: false,
    });
  });
});
