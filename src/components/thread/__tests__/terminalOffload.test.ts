import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/commands", () => ({
  sessionHasBackgroundWork: vi.fn().mockResolvedValue(false),
}));

import { sessionHasBackgroundWork } from "../../../lib/commands";
import { useUiStore } from "../../../stores/uiStore";
import {
  shouldKeepTerminalLoaded,
  shouldKeepClaudeTerminalLoaded,
  scheduleClaudeSessionOffload,
  cancelClaudeSessionOffload,
  resetClaudeSessionOffloadForTests,
  pendingClaudeOffloadCountForTests,
} from "../terminalOffload";

describe("shouldKeepTerminalLoaded", () => {
  it("keeps the active session loaded", () => {
    expect(
      shouldKeepTerminalLoaded({
        isActive: true,
        agentRunning: false,
        isAltScreen: false,
      }),
    ).toBe(true);
  });

  it("keeps a session with a running (input-bar) agent loaded", () => {
    expect(
      shouldKeepTerminalLoaded({
        isActive: false,
        agentRunning: true,
        isAltScreen: false,
      }),
    ).toBe(true);
  });

  it("keeps a backgrounded session loaded while an interactive agent is on the alt-screen (asking a question)", () => {
    expect(
      shouldKeepTerminalLoaded({
        isActive: false,
        agentRunning: false,
        isAltScreen: true,
      }),
    ).toBe(true);
  });

  it("allows offloading an inactive, agent-idle, non-alt-screen session", () => {
    expect(
      shouldKeepTerminalLoaded({
        isActive: false,
        agentRunning: false,
        isAltScreen: false,
      }),
    ).toBe(false);
  });
});

describe("shouldKeepClaudeTerminalLoaded", () => {
  it("keeps a visible Claude terminal loaded", () => {
    expect(
      shouldKeepClaudeTerminalLoaded({
        isVisible: true,
        isProcessing: false,
        hasPendingApproval: false,
      }),
    ).toBe(true);
  });

  it("keeps a processing Claude terminal loaded", () => {
    expect(
      shouldKeepClaudeTerminalLoaded({
        isVisible: false,
        isProcessing: true,
        hasPendingApproval: false,
      }),
    ).toBe(true);
  });

  it("keeps a backgrounded, idle Claude terminal loaded while a question (pending approval) is outstanding", () => {
    // Regression: when Claude asks a permission question it stops processing
    // (isProcessing=false), so without the approval guard the terminal would
    // unload out from under the pending prompt.
    expect(
      shouldKeepClaudeTerminalLoaded({
        isVisible: false,
        isProcessing: false,
        hasPendingApproval: true,
      }),
    ).toBe(true);
  });

  it("allows unloading a backgrounded, idle Claude terminal with no pending question", () => {
    expect(
      shouldKeepClaudeTerminalLoaded({
        isVisible: false,
        isProcessing: false,
        hasPendingApproval: false,
      }),
    ).toBe(false);
  });
});

describe("scheduleClaudeSessionOffload", () => {
  beforeEach(() => {
    vi.mocked(sessionHasBackgroundWork).mockReset().mockResolvedValue(false);
  });

  afterEach(() => {
    resetClaudeSessionOffloadForTests();
    useUiStore.setState({ claudeProcessingById: {}, pendingApprovalsBySession: {} });
    vi.useRealTimers();
  });

  it("does not stop immediately — waits for the delay so tab-switch can remount", async () => {
    vi.useFakeTimers();
    const stop = vi.fn().mockResolvedValue(undefined);
    scheduleClaudeSessionOffload("s1", stop, 2_000);
    expect(stop).not.toHaveBeenCalled();
    expect(pendingClaudeOffloadCountForTests()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stop).toHaveBeenCalledWith("s1");
    expect(pendingClaudeOffloadCountForTests()).toBe(0);
  });

  it("cancel on remount prevents the delayed stop", async () => {
    vi.useFakeTimers();
    const stop = vi.fn().mockResolvedValue(undefined);
    scheduleClaudeSessionOffload("s1", stop, 2_000);
    cancelClaudeSessionOffload("s1");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stop).not.toHaveBeenCalled();
    expect(pendingClaudeOffloadCountForTests()).toBe(0);
  });

  it("keeps a session whose background work is still running, then stops it once the work ends", async () => {
    vi.useFakeTimers();
    const stop = vi.fn().mockResolvedValue(undefined);
    vi.mocked(sessionHasBackgroundWork).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    scheduleClaudeSessionOffload("s1", stop, 2_000);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(sessionHasBackgroundWork).toHaveBeenCalledWith("s1");
    expect(stop).not.toHaveBeenCalled();
    expect(pendingClaudeOffloadCountForTests()).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(stop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("re-checks processing when the timer fires, not only when it was armed", async () => {
    vi.useFakeTimers();
    const stop = vi.fn().mockResolvedValue(undefined);
    scheduleClaudeSessionOffload("s1", stop, 2_000);
    // A finished background task started a new turn while the tab was hidden.
    useUiStore.setState({ claudeProcessingById: { s1: true } });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(stop).not.toHaveBeenCalled();
    expect(pendingClaudeOffloadCountForTests()).toBe(1);
  });

  it("keeps a session waiting on an approval", async () => {
    vi.useFakeTimers();
    const stop = vi.fn().mockResolvedValue(undefined);
    useUiStore.setState({
      pendingApprovalsBySession: { s1: {} } as unknown as ReturnType<typeof useUiStore.getState>["pendingApprovalsBySession"],
    });
    scheduleClaudeSessionOffload("s1", stop, 2_000);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(stop).not.toHaveBeenCalled();
  });

  it("keeps the session running when the background check fails", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = vi.fn().mockResolvedValue(undefined);
    vi.mocked(sessionHasBackgroundWork).mockRejectedValueOnce(new Error("boom"));
    scheduleClaudeSessionOffload("s1", stop, 2_000);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(stop).not.toHaveBeenCalled();
    expect(pendingClaudeOffloadCountForTests()).toBe(1);
    warn.mockRestore();
  });

  it("does not stop when the user comes back while the check is in flight", async () => {
    vi.useFakeTimers();
    const stop = vi.fn().mockResolvedValue(undefined);
    let answer: (busy: boolean) => void = () => {};
    vi.mocked(sessionHasBackgroundWork).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
    );
    scheduleClaudeSessionOffload("s1", stop, 2_000);

    await vi.advanceTimersByTimeAsync(2_000);
    cancelClaudeSessionOffload("s1");
    answer(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stop).not.toHaveBeenCalled();
    expect(pendingClaudeOffloadCountForTests()).toBe(0);
  });
});
