import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock Tauri plugin-notification & api/window before importing the module
// under test, so module-level imports use these stubs.
const isPermissionGranted = vi.fn().mockResolvedValue(true);
const requestPermission = vi.fn().mockResolvedValue("granted");
const sendNotification = vi.fn();
const isFocused = vi.fn().mockResolvedValue(false);

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => isPermissionGranted(),
  requestPermission: () => requestPermission(),
  sendNotification: (args: { title: string; body: string; sound?: string }) =>
    sendNotification(args),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: () => isFocused() }),
}));

import {
  resolveProviderForSession,
  providerizeNotification,
  sendNotification as appSendNotification,
  NOTIFICATION_SOUNDS,
  armNotificationNavigation,
  consumePendingNotificationNavigation,
  clearPendingNotificationNavigation,
  __resetNotificationActivationForTests,
  __getPendingNotificationNavForTests,
} from "../notifications";
import { useThreadStore } from "../../stores/threadStore";
import { useUiStore } from "../../stores/uiStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useNotificationHistoryStore } from "../../stores/notificationHistoryStore";
import type { Thread } from "../types";

const selectThread = vi.fn();
const selectClaudeSession = vi.fn();
const selectCodexSession = vi.fn();
const selectProject = vi.fn();
const setAppMode = vi.fn();

const mkThread = (overrides: Partial<Thread> = {}): Thread => ({
  id: "t1",
  project_id: "p1",
  name: "thread",
  provider: "ClaudeCode",
  run_mode: "Resume",
  work_mode: "DirectRepo",
  work_dir: "/work",
  state_dir: "/state",
  status: "Idle",
  created_at: "",
  last_active: "",
  model: null,
  reasoning_effort: null,
  fast_mode: 0,
  is_archived: 0,
  worktree_branch: null,
  interaction_mode: "pty",
  sdk_session_id: null,
  opencode_session_id: null,
  forked_from_thread_id: null,
  forked_at_message_index: null,
  lines_added: 0,
  lines_removed: 0,
  files_changed: 0,
  ...overrides,
});

function resetStores(): void {
  useThreadStore.setState({ threads: {}, archivedThreads: {} }, false);
  useUiStore.setState(
    {
      claudeSessionMap: {},
      sessionCwdMap: {},
      codexProcessingById: {},
      codexDiffStatsById: {},
      claudeSessionDiffStatsById: {},
      selectedProjectId: null,
      appMode: "agent",
      taskViewAllowed: false,
      selectThread,
      selectClaudeSession,
      selectCodexSession,
      selectProject,
      setAppMode,
    } as Partial<ReturnType<typeof useUiStore.getState>>,
    false,
  );
  useNotificationHistoryStore.setState(
    { entries: [], unreadCount: 0 } as Partial<ReturnType<typeof useNotificationHistoryStore.getState>>,
    false,
  );
  __resetNotificationActivationForTests();
  selectThread.mockReset();
  selectClaudeSession.mockReset();
  selectCodexSession.mockReset();
  selectProject.mockReset();
  setAppMode.mockReset();
}

describe("notifications", () => {
  beforeEach(() => {
    resetStores();
    isPermissionGranted.mockReset().mockResolvedValue(true);
    requestPermission.mockReset().mockResolvedValue("granted");
    sendNotification.mockReset();
    isFocused.mockReset().mockResolvedValue(false);
  });

  describe("NOTIFICATION_SOUNDS", () => {
    it("includes the default agmux sound and silent option", () => {
      const values = NOTIFICATION_SOUNDS.map((s) => s.value);
      expect(values).toContain("xanom-notify.wav");
      expect(values).toContain("none");
      expect(values).toContain("default");
    });
  });

  describe("resolveProviderForSession", () => {
    it("returns null for empty id", () => {
      expect(resolveProviderForSession("")).toBeNull();
    });

    it("returns provider when sessionId matches a thread id directly", () => {
      useThreadStore.setState(
        { threads: { p1: [mkThread({ id: "t1", provider: "Codex" })] }, archivedThreads: {} },
        false,
      );
      expect(resolveProviderForSession("t1")).toBe("Codex");
    });

    it("falls back to claude session map for PTY threads", () => {
      useThreadStore.setState(
        { threads: { p1: [mkThread({ id: "x1", provider: "ClaudeCode" })] }, archivedThreads: {} },
        false,
      );
      useUiStore.setState(
        { claudeSessionMap: { x1: ["real-1"] } } as Partial<ReturnType<typeof useUiStore.getState>>,
        false,
      );
      expect(resolveProviderForSession("real-1")).toBe("ClaudeCode");
    });

    it("returns null for unknown session id", () => {
      expect(resolveProviderForSession("missing")).toBeNull();
    });
  });

  describe("providerizeNotification", () => {
    it("returns input unchanged when provider is ClaudeCode", () => {
      useThreadStore.setState(
        { threads: { p1: [mkThread({ id: "t1", provider: "ClaudeCode" })] }, archivedThreads: {} },
        false,
      );
      expect(providerizeNotification("t1", "Claude Finished", "Claude is done")).toEqual({
        title: "Claude Finished",
        body: "Claude is done",
      });
    });

    it("rewrites Claude → provider name for non-Claude providers", () => {
      useThreadStore.setState(
        { threads: { p1: [mkThread({ id: "t1", provider: "Codex" })] }, archivedThreads: {} },
        false,
      );
      const out = providerizeNotification("t1", "Claude Finished", "Claude is done");
      expect(out.title).toBe("Codex Finished");
      expect(out.body).toBe("Codex is done");
    });

    it("returns input unchanged when session is not resolvable", () => {
      const out = providerizeNotification("missing", "Claude X", "Claude Y");
      expect(out).toEqual({ title: "Claude X", body: "Claude Y" });
    });
  });

  describe("sendNotification", () => {
    it("logs to in-app history regardless of focus", async () => {
      isFocused.mockResolvedValueOnce(true); // focused → no native notification
      appSendNotification("Title", "Body");

      // history is updated synchronously
      const entries = useNotificationHistoryStore.getState().entries;
      expect(entries).toHaveLength(1);
      expect(entries[0].title).toBe("Title");
      expect(entries[0].body).toBe("Body");

      // Wait for the async block to settle.
      await Promise.resolve();
      await Promise.resolve();
      expect(sendNotification).not.toHaveBeenCalled();
    });

    it("force=true bypasses focus check and dispatches via Tauri", async () => {
      // Simulate a system-default sound to avoid playing custom audio.
      useSettingsStore.setState(
        {
          settings: {
            ...useSettingsStore.getState().settings,
            notificationSound: "Glass",
          },
        } as Partial<ReturnType<typeof useSettingsStore.getState>>,
        false,
      );
      isFocused.mockResolvedValue(true);

      appSendNotification("T", "B", { force: true });
      // Allow microtasks to resolve the async IIFE.
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(sendNotification).toHaveBeenCalledTimes(1);
      const call = sendNotification.mock.calls[0][0];
      expect(call.title).toBe("T");
      expect(call.body).toBe("B");
      expect(call.sound).toBe("Glass");
    });

    it("requests permission when not yet granted", async () => {
      isPermissionGranted.mockResolvedValueOnce(false);
      requestPermission.mockResolvedValueOnce("denied");

      appSendNotification("T", "B", { force: true });
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(requestPermission).toHaveBeenCalled();
      expect(sendNotification).not.toHaveBeenCalled();
    });

    it("does not pass sound key when sound is 'none'", async () => {
      useSettingsStore.setState(
        {
          settings: {
            ...useSettingsStore.getState().settings,
            notificationSound: "none",
          },
        } as Partial<ReturnType<typeof useSettingsStore.getState>>,
        false,
      );

      appSendNotification("T", "B", { force: true });
      for (let i = 0; i < 5; i++) await Promise.resolve();

      const call = sendNotification.mock.calls[0]?.[0];
      expect(call).toBeDefined();
      expect(call.sound).toBeUndefined();
    });

    it("stores sessionId on history and arms navigation when threadId is set", async () => {
      useThreadStore.setState(
        { threads: { p1: [mkThread({ id: "t1", provider: "Grok" })] }, archivedThreads: {} },
        false,
      );
      useSettingsStore.setState(
        {
          settings: {
            ...useSettingsStore.getState().settings,
            notificationSound: "none",
          },
        } as Partial<ReturnType<typeof useSettingsStore.getState>>,
        false,
      );

      appSendNotification("Done", "body", { force: true, threadId: "t1" });
      for (let i = 0; i < 5; i++) await Promise.resolve();

      const entries = useNotificationHistoryStore.getState().entries;
      expect(entries[0]?.sessionId).toBe("t1");
      expect(__getPendingNotificationNavForTests()?.threadId).toBe("t1");
      expect(__getPendingNotificationNavForTests()?.provider).toBe("Grok");
    });

    it("skips native complete notifications when notifyOnComplete is off", async () => {
      useSettingsStore.setState(
        {
          settings: {
            ...useSettingsStore.getState().settings,
            notifyOnComplete: false,
            notificationSound: "none",
          },
        } as Partial<ReturnType<typeof useSettingsStore.getState>>,
        false,
      );

      appSendNotification("agmux — Claude Finished", "Claude has finished working.");
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
      expect(sendNotification).not.toHaveBeenCalled();
    });

    it("skips native approval notifications when notifyOnApproval is off", async () => {
      useSettingsStore.setState(
        {
          settings: {
            ...useSettingsStore.getState().settings,
            notifyOnApproval: false,
            notificationSound: "none",
          },
        } as Partial<ReturnType<typeof useSettingsStore.getState>>,
        false,
      );

      appSendNotification("agmux — Approval Required", "Claude wants to run a command.");
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
      expect(sendNotification).not.toHaveBeenCalled();
    });

    it("does not arm navigation when focus skips the native notification", async () => {
      isFocused.mockResolvedValueOnce(true);
      appSendNotification("Title", "Body", { threadId: "t1" });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(__getPendingNotificationNavForTests()).toBeNull();
    });
  });

  describe("pending notification navigation", () => {
    it("consumePending navigates to the armed thread once", () => {
      useThreadStore.setState(
        { threads: { p1: [mkThread({ id: "t1", provider: "Grok", name: "Work" })] }, archivedThreads: {} },
        false,
      );
      armNotificationNavigation("t1", "Grok");
      expect(consumePendingNotificationNavigation()).toBe(true);
      expect(selectThread).toHaveBeenCalledWith("t1", "Work");
      expect(consumePendingNotificationNavigation()).toBe(false);
    });

    it("routes Codex via selectCodexSession", () => {
      armNotificationNavigation("codex-sess", "Codex");
      expect(consumePendingNotificationNavigation()).toBe(true);
      expect(selectCodexSession).toHaveBeenCalled();
      expect(selectThread).not.toHaveBeenCalled();
    });

    it("clearPending prevents navigation", () => {
      armNotificationNavigation("t1");
      clearPendingNotificationNavigation();
      expect(consumePendingNotificationNavigation()).toBe(false);
    });
  });
});
