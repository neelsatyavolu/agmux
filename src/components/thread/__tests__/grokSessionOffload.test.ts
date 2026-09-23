import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  stopThread: vi.fn().mockResolvedValue(undefined),
  grokSdkStopSession: vi.fn().mockResolvedValue(undefined),
}));

import { stopThread, grokSdkStopSession } from "../../../lib/commands";
import {
  cancelGrokSessionOffload,
  GROK_OFFLOAD_DELAY_MS,
  isGrokSessionOffloaded,
  pendingGrokOffloadCountForTests,
  resetGrokSessionOffloadForTests,
  scheduleGrokSessionOffload,
  shouldKeepGrokSessionLoaded,
} from "../grokSessionOffload";

describe("shouldKeepGrokSessionLoaded", () => {
  it("keeps visible or processing or pending-approval sessions", () => {
    expect(
      shouldKeepGrokSessionLoaded({
        isVisible: true,
        isProcessing: false,
        hasPendingApproval: false,
      }),
    ).toBe(true);
    expect(
      shouldKeepGrokSessionLoaded({
        isVisible: false,
        isProcessing: true,
        hasPendingApproval: false,
      }),
    ).toBe(true);
    expect(
      shouldKeepGrokSessionLoaded({
        isVisible: false,
        isProcessing: false,
        hasPendingApproval: true,
      }),
    ).toBe(true);
  });

  it("allows offloading a background idle session", () => {
    expect(
      shouldKeepGrokSessionLoaded({
        isVisible: false,
        isProcessing: false,
        hasPendingApproval: false,
      }),
    ).toBe(false);
  });
});

describe("scheduleGrokSessionOffload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetGrokSessionOffloadForTests();
    vi.mocked(stopThread).mockClear();
    vi.mocked(grokSdkStopSession).mockClear();
  });

  afterEach(() => {
    resetGrokSessionOffloadForTests();
    vi.useRealTimers();
  });

  it("stops a PTY session after the delay (survives 'unmount' cancel absence)", async () => {
    scheduleGrokSessionOffload("t-pty", "pty");
    expect(pendingGrokOffloadCountForTests()).toBe(1);
    expect(isGrokSessionOffloaded("t-pty")).toBe(false);

    await vi.advanceTimersByTimeAsync(GROK_OFFLOAD_DELAY_MS - 1);
    expect(stopThread).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(stopThread).toHaveBeenCalledWith("t-pty");
    expect(isGrokSessionOffloaded("t-pty")).toBe(true);
  });

  it("stops an SDK session via grokSdkStopSession", async () => {
    scheduleGrokSessionOffload("t-sdk", "sdk");
    await vi.advanceTimersByTimeAsync(GROK_OFFLOAD_DELAY_MS);
    expect(grokSdkStopSession).toHaveBeenCalledWith("t-sdk");
    expect(stopThread).not.toHaveBeenCalled();
    expect(isGrokSessionOffloaded("t-sdk")).toBe(true);
  });

  it("cancel before fire prevents stop (user switched back)", async () => {
    scheduleGrokSessionOffload("t1", "pty");
    cancelGrokSessionOffload("t1");
    expect(pendingGrokOffloadCountForTests()).toBe(0);

    await vi.advanceTimersByTimeAsync(GROK_OFFLOAD_DELAY_MS + 1000);
    expect(stopThread).not.toHaveBeenCalled();
    expect(isGrokSessionOffloaded("t1")).toBe(false);
  });

  it("re-schedule replaces the previous timer", async () => {
    scheduleGrokSessionOffload("t1", "pty", 5000);
    scheduleGrokSessionOffload("t1", "pty", 10_000);
    expect(pendingGrokOffloadCountForTests()).toBe(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(stopThread).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(stopThread).toHaveBeenCalledTimes(1);
  });
});
