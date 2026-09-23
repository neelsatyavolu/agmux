/**
 * Module-level Grok session offload.
 *
 * ThreadView only mounts the *selected* session. The previous in-component
 * unload timer was cleared on unmount, so switching away from a Grok tab never
 * killed `grok` + its MCP children (~2 GB each). Timers here survive unmount.
 *
 * - PTY: `stop_thread` tears down the process group (CLI + MCP).
 * - SDK/ACP: `grok_sdk_stop_session` kills `grok agent stdio` + MCP.
 *
 * Keep loaded while the agent is processing or waiting on a permission prompt
 * (same policy as `shouldKeepClaudeTerminalLoaded`).
 */

import { stopThread, grokSdkStopSession } from "../../lib/commands";
import { shouldKeepClaudeTerminalLoaded } from "./terminalOffload";

/** Match Claude / prior Grok unload delay. */
export const GROK_OFFLOAD_DELAY_MS = 2 * 60 * 1000;

export type GrokOffloadKind = "pty" | "sdk";

type TimerHandle = ReturnType<typeof setTimeout>;

const pendingTimers = new Map<string, TimerHandle>();
/** Threads we stopped for offload (resume path checks this). */
const offloadedIds = new Set<string>();

function timerKey(threadId: string, kind: GrokOffloadKind): string {
  return `${kind}:${threadId}`;
}

export function isGrokSessionOffloaded(threadId: string): boolean {
  return offloadedIds.has(threadId);
}

/** Cancel a pending offload and clear the offloaded flag (caller is resuming). */
export function cancelGrokSessionOffload(threadId: string): void {
  for (const kind of ["pty", "sdk"] as const) {
    const key = timerKey(threadId, kind);
    const t = pendingTimers.get(key);
    if (t != null) {
      clearTimeout(t);
      pendingTimers.delete(key);
    }
  }
  offloadedIds.delete(threadId);
}

/**
 * Schedule process teardown after `delayMs` if still not cancelled.
 * Idempotent: re-scheduling the same thread+kind replaces the previous timer.
 */
export function scheduleGrokSessionOffload(
  threadId: string,
  kind: GrokOffloadKind,
  delayMs: number = GROK_OFFLOAD_DELAY_MS,
): void {
  if (!threadId) return;
  const key = timerKey(threadId, kind);
  const existing = pendingTimers.get(key);
  if (existing != null) {
    clearTimeout(existing);
  }
  const handle = setTimeout(() => {
    pendingTimers.delete(key);
    offloadedIds.add(threadId);
    const stop =
      kind === "sdk"
        ? grokSdkStopSession(threadId)
        : stopThread(threadId);
    stop.catch((err) => {
      console.error(`Grok ${kind} offload stop failed:`, err);
      // Allow a later attempt; leave offloadedIds so UI still treats as unloaded.
    });
  }, delayMs);
  pendingTimers.set(key, handle);
}

/**
 * Whether a background Grok session should be kept alive (not offloaded).
 * `isVisible` is false when the ThreadView unmounts (user switched tabs).
 */
export function shouldKeepGrokSessionLoaded(opts: {
  isVisible: boolean;
  isProcessing: boolean;
  hasPendingApproval: boolean;
}): boolean {
  return shouldKeepClaudeTerminalLoaded(opts);
}

/** Test helper — clear all pending timers and offload flags. */
export function resetGrokSessionOffloadForTests(): void {
  for (const t of pendingTimers.values()) {
    clearTimeout(t);
  }
  pendingTimers.clear();
  offloadedIds.clear();
}

/** Test helper — how many offload timers are pending. */
export function pendingGrokOffloadCountForTests(): number {
  return pendingTimers.size;
}
