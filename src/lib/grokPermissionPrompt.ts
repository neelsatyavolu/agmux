/**
 * Detect whether Grok's interactive permission prompt is actually on-screen.
 *
 * Grok's `approval_required` ui.notifications event fires when a tool needs a
 * permission *decision* — often at the START of Auto-mode classification, not
 * when the Yes/No menu is painted. Classification can take several seconds and
 * may end with either:
 *   1. An interactive Yes / No / always-approve menu (user must act), or
 *   2. Silent auto-approve with no menu (no amber / OS notif wanted).
 *
 * So we never trust the event alone. We poll the *recent* PTY tail for live
 * menu chrome, for long enough that the classifier can finish. Matching the
 * full ring buffer is wrong: an earlier real prompt would stay in scrollback.
 */

import { getPtySnapshot } from "./commands";

/** Only inspect this many trailing bytes of the PTY stream (≈ current screen). */
export const GROK_PERMISSION_TAIL_BYTES = 2048;

/** Opt-in Grok permission debug logs (filter: `grok-perm`). Enable with localStorage `agmux-grok-perm-debug=1`. */
export function grokPermLog(message: string, detail?: Record<string, unknown>): void {
  try {
    if (typeof window !== "undefined" && window.localStorage?.getItem("agmux-grok-perm-debug") !== "1") {
      return;
    }
  } catch {
    return;
  }
  if (detail) {
    console.log(`[grok-perm] ${message}`, detail);
  } else {
    console.log(`[grok-perm] ${message}`);
  }
}

/** Decode a base64 PTY snapshot without pulling in xterm (keeps this module node-testable). */
function decodeBase64ToBytes(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0);
  try {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

/** Keep only the trailing window used for live-menu detection. */
export function ptyTail(text: string, maxBytes = GROK_PERMISSION_TAIL_BYTES): string {
  if (text.length <= maxBytes) return text;
  return text.slice(text.length - maxBytes);
}

/** Strip CSI / OSC ANSI so marker matching is against readable text. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][0-9A-Za-z]/g, "")
    .replace(/\x1b./g, "");
}

/**
 * True when `text` looks like Grok's interactive permission chooser.
 * Prefers the distinctive footer shortcut `Ctrl+o:yolo` (unique to that menu).
 */
export function ptyTextLooksLikeGrokPermissionPrompt(text: string): boolean {
  if (!text) return false;
  // Always evaluate against the recent tail so stale scrollback can't match.
  const plain = stripAnsi(ptyTail(text)).toLowerCase();

  // Primary: footer chrome from the live permission menu.
  // Screenshot: "1/3:select | Ctrl+o:yolo | Ctrl+c:cancel"
  if (plain.includes("ctrl+o:yolo") || plain.includes("ctrl+o: yolo")) {
    return true;
  }

  // Secondary: option rows that co-occur only on that menu.
  const hasAlwaysApprove =
    plain.includes("always-approve mode") || plain.includes("always approve mode");
  const hasProceed = plain.includes("yes, proceed");
  const hasReject = plain.includes("no, reject");
  if (hasAlwaysApprove && (hasProceed || hasReject)) {
    return true;
  }
  if (hasProceed && hasReject && plain.includes("/3:select")) {
    return true;
  }

  return false;
}

/**
 * How long to wait for the interactive menu after `approval_required`.
 * Auto-mode classification often runs for multiple seconds before either
 * painting the Yes/No UI or silently auto-approving.
 */
export const GROK_PERMISSION_CLASSIFIER_TIMEOUT_MS = 15_000;

export interface WaitForGrokPermissionPromptOptions {
  /**
   * How long to keep polling the PTY for prompt chrome.
   * Default {@link GROK_PERMISSION_CLASSIFIER_TIMEOUT_MS} (15s) so Auto-mode
   * classification can finish before we give up.
   */
  timeoutMs?: number;
  /** Poll interval. Default 150ms. */
  intervalMs?: number;
  /**
   * Abort if the tool resolved without a menu (post-tool-use / stop).
   * Do NOT abort on pre-tool-use — that often fires before classification ends.
   */
  signal?: AbortSignal;
  /** Test seam — defaults to getPtySnapshot + decode. */
  readPtyText?: (threadId: string) => Promise<string>;
  /** Test seam — defaults to setTimeout. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

async function defaultReadPtyText(threadId: string): Promise<string> {
  const snap = await getPtySnapshot(threadId);
  if (!snap?.data) return "";
  const bytes = decodeBase64ToBytes(snap.data);
  // Latin-1: 1:1 byte→char so we don't corrupt mid-UTF-8 sequences in the ring.
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll the PTY until Grok's permission menu is visible, or `timeoutMs` elapses.
 * Returns true only when interactive prompt chrome is detected in the recent tail.
 */
export async function waitForGrokPermissionPrompt(
  threadId: string,
  options: WaitForGrokPermissionPromptOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? GROK_PERMISSION_CLASSIFIER_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 150;
  const readPtyText = options.readPtyText ?? defaultReadPtyText;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;
  const sid = threadId.slice(0, 8);
  const t0 = Date.now();

  grokPermLog(`watch start session=${sid}`, { timeoutMs, intervalMs });

  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  // Do not treat the initial snapshot as decisive unless the menu is already
  // painted — approval_required often arrives during classification with no UI.
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      grokPermLog(`watch aborted session=${sid}`, {
        polls,
        elapsedMs: Date.now() - t0,
        reason: "signal",
      });
      return false;
    }
    try {
      const text = await readPtyText(threadId);
      polls += 1;
      const matched = ptyTextLooksLikeGrokPermissionPrompt(text);
      // Log first poll, every ~1s, and match — avoid flooding every 150ms.
      if (polls === 1 || matched || polls % 7 === 0) {
        const tail = stripAnsi(ptyTail(text)).slice(-160).replace(/\s+/g, " ");
        grokPermLog(`watch poll session=${sid}`, {
          polls,
          elapsedMs: Date.now() - t0,
          matched,
          tailLen: text.length,
          tailPreview: tail,
        });
      }
      if (matched) {
        grokPermLog(`watch MENU DETECTED session=${sid}`, {
          polls,
          elapsedMs: Date.now() - t0,
        });
        return true;
      }
    } catch (err) {
      grokPermLog(`watch snapshot error session=${sid}`, {
        polls,
        err: String(err),
      });
      // Snapshot can fail if the PTY was torn down; treat as no prompt.
      return false;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      await sleep(Math.min(intervalMs, remaining), signal);
    } catch {
      grokPermLog(`watch aborted session=${sid}`, {
        polls,
        elapsedMs: Date.now() - t0,
        reason: "sleep-abort",
      });
      return false; // aborted (tool finished / session stopped)
    }
  }
  grokPermLog(`watch timeout (no menu) session=${sid}`, {
    polls,
    elapsedMs: Date.now() - t0,
  });
  return false;
}

/**
 * True when a hook payload is Grok's approval_required-style notification
 * (used so we still gate even if thread lookup fails momentarily).
 */
export function isGrokApprovalRequiredPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  const event = String(p.event ?? p.event_name ?? p.hook_event_name ?? "").toLowerCase();
  return event === "approval_required" || event.includes("approval_required");
}

/**
 * After amber is raised for a live menu, poll until the menu is gone so we can
 * clear the pulse as soon as the user accepts/rejects — not when the tool later
 * finishes. Requires `goneStreak` consecutive no-menu polls to ride out TUI redraws.
 */
export async function waitForGrokPermissionMenuGone(
  threadId: string,
  options: WaitForGrokPermissionPromptOptions & { goneStreak?: number } = {},
): Promise<boolean> {
  // Cap how long we watch after amber is up; post-tool-use also clears amber.
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const intervalMs = options.intervalMs ?? 150;
  const goneStreakNeeded = options.goneStreak ?? 2;
  const readPtyText = options.readPtyText ?? defaultReadPtyText;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;
  const sid = threadId.slice(0, 8);
  const t0 = Date.now();
  let goneStreak = 0;
  let polls = 0;
  // Cap iterations so a no-op sleep mock (or stuck clock) can't spin forever.
  const maxPolls = Math.max(4, Math.ceil(timeoutMs / Math.max(intervalMs, 1)) + 2);

  grokPermLog(`dismiss-watch start session=${sid}`, {
    timeoutMs,
    intervalMs,
    goneStreakNeeded,
  });

  const deadline = Date.now() + timeoutMs;
  while (polls < maxPolls && Date.now() < deadline) {
    if (signal?.aborted) {
      grokPermLog(`dismiss-watch aborted session=${sid}`, {
        polls,
        elapsedMs: Date.now() - t0,
      });
      return false;
    }
    try {
      const text = await readPtyText(threadId);
      polls += 1;
      const menuUp = ptyTextLooksLikeGrokPermissionPrompt(text);
      if (menuUp) {
        goneStreak = 0;
      } else {
        goneStreak += 1;
        if (goneStreak >= goneStreakNeeded) {
          grokPermLog(`dismiss-watch MENU GONE session=${sid}`, {
            polls,
            elapsedMs: Date.now() - t0,
            goneStreak,
          });
          return true;
        }
      }
      if (polls === 1 || polls % 10 === 0) {
        grokPermLog(`dismiss-watch poll session=${sid}`, {
          polls,
          menuUp,
          goneStreak,
          elapsedMs: Date.now() - t0,
        });
      }
    } catch (err) {
      grokPermLog(`dismiss-watch error session=${sid}`, { err: String(err) });
      return false;
    }
    if (polls >= maxPolls || Date.now() >= deadline) break;
    try {
      await sleep(intervalMs, signal);
    } catch {
      grokPermLog(`dismiss-watch aborted session=${sid}`, {
        polls,
        elapsedMs: Date.now() - t0,
        reason: "sleep-abort",
      });
      return false;
    }
  }
  grokPermLog(`dismiss-watch timeout session=${sid}`, {
    polls,
    elapsedMs: Date.now() - t0,
  });
  return false;
}
