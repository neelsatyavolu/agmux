import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    resetClaudeSessionOffloadForTests();
    vi.useRealTimers();
  });

  it("does not stop immediately — waits for the delay so tab-switch can remount", () => {
    vi.useFakeTimers();
    const stop = vi.fn().mockResolvedValue(undefined);
    scheduleClaudeSessionOffload("s1", stop, 2_000);
    expect(stop).not.toHaveBeenCalled();
    expect(pendingClaudeOffloadCountForTests()).toBe(1);
    vi.advanceTimersByTime(1_999);
    expect(stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stop).toHaveBeenCalledWith("s1");
  });

  it("cancel on remount prevents the delayed stop", () => {
    vi.useFakeTimers();
    const stop = vi.fn().mockResolvedValue(undefined);
    scheduleClaudeSessionOffload("s1", stop, 2_000);
    cancelClaudeSessionOffload("s1");
    vi.advanceTimersByTime(5_000);
    expect(stop).not.toHaveBeenCalled();
    expect(pendingClaudeOffloadCountForTests()).toBe(0);
  });
});
