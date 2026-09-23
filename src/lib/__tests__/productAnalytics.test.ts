import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settingsStore";
import { sendProductHeartbeat, trackProductEvent } from "../productAnalytics";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
  useSettingsStore.setState({
    settings: { ...useSettingsStore.getState().settings, productAnalyticsEnabled: true },
  });
});

describe("productAnalytics", () => {
  it("heartbeat no-ops when disabled", () => {
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, productAnalyticsEnabled: false },
    });
    sendProductHeartbeat();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("heartbeat invokes when enabled", async () => {
    sendProductHeartbeat();
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("product_analytics_heartbeat", { enabled: true });
    });
  });

  it("drops extra event props", async () => {
    trackProductEvent("thread_created", {
      provider: "ClaudeCode",
      interactionMode: "pty",
      path: "/secret",
    });
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("product_analytics_track", {
        enabled: true,
        name: "thread_created",
        props: { provider: "ClaudeCode", interactionMode: "pty" },
      });
    });
  });

  it("track no-ops when disabled", () => {
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, productAnalyticsEnabled: false },
    });
    trackProductEvent("app_mode", { mode: "agent" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
