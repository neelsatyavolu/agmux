/**
 * Detect whether Muse Code is showing its interactive approval card.
 *
 * Muse fires PermissionRequest as soon as a tool call needs a decision. With
 * its approval judge on (the default) that is the START of an automatic
 * review: the status line reads "Reviewing approval request" for a few
 * seconds and the call is usually approved with no card at all. So the hook
 * alone never raises amber — we wait for the card itself.
 *
 * The Muse status line animates constantly (≈5 KB/s of PTY output), so the
 * card scrolls out of any fixed tail within a second. Instead of a tail, scan
 * only the bytes written since the watch started, using the snapshot's
 * cumulative `end_offset`.
 */

import { getPtySnapshot } from "./commands";
import { stripAnsi } from "./grokPermissionPrompt";

/** The judge has answered within ~5s in practice; leave it plenty of room. */
export const MUSE_PERMISSION_TIMEOUT_MS = 30_000;

/** Covers a card painted between the hook firing and the first snapshot. */
const START_LOOKBACK_BYTES = 512;
/** Re-read this much on each poll so a marker split across polls still matches. */
const POLL_OVERLAP_BYTES = 512;

export interface MusePtyRead {
  /** Ring-buffer contents, one char per byte. */
  text: string;
  /** Cumulative offset just past the last byte of `text`. */
  endOffset: number;
}

export interface WaitForMusePermissionPromptOptions {
  timeoutMs?: number;
  /** Poll interval. Default 200ms. */
  intervalMs?: number;
  /** Abort when the call resolved without a card (post-tool-use / stop). */
  signal?: AbortSignal;
  /** Test seam — defaults to getPtySnapshot + decode. */
  readPty?: (threadId: string) => Promise<MusePtyRead>;
  /** Test seam — defaults to setTimeout. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

async function defaultReadPty(threadId: string): Promise<MusePtyRead> {
  const snap = await getPtySnapshot(threadId);
  if (!snap?.data) return { text: "", endOffset: snap?.end_offset ?? 0 };
  let text = "";
  try {
    // atob yields one char per byte, which keeps offsets aligned with bytes.
    text = atob(snap.data);
  } catch {
    text = "";
  }
  return { text, endOffset: snap.end_offset };
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
 * True when `text` contains Muse's approval card (labels from Muse Code 1.4.7).
 * The card header "Approval request" is deliberately not a marker: the judge's
 * "Reviewing approval request" status contains it.
 */
export function ptyTextLooksLikeMusePermissionPrompt(text: string): boolean {
  if (!text) return false;
  const plain = stripAnsi(text).toLowerCase();
  if (plain.includes("change approval defaults in /permissions")) return true;
  return (
    plain.includes("abort the entire command") &&
    plain.includes("would you like to run the following command")
  );
}

/**
 * Poll the PTY until Muse's approval card is painted, or `timeoutMs` elapses.
 * Only output written after the watch started counts, so an earlier card left
 * in the buffer cannot match.
 */
export async function waitForMusePermissionPrompt(
  threadId: string,
  options: WaitForMusePermissionPromptOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? MUSE_PERMISSION_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 200;
  const readPty = options.readPty ?? defaultReadPty;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;

  let scanFrom: number | null = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    try {
      const { text, endOffset } = await readPty(threadId);
      if (signal?.aborted) return false;
      if (scanFrom === null) scanFrom = Math.max(0, endOffset - START_LOOKBACK_BYTES);
      const fresh = Math.min(text.length, Math.max(0, endOffset - scanFrom));
      if (fresh > 0 && ptyTextLooksLikeMusePermissionPrompt(text.slice(text.length - fresh))) {
        return true;
      }
      scanFrom = Math.max(scanFrom, endOffset - POLL_OVERLAP_BYTES);
    } catch {
      // Snapshot can fail if the PTY was torn down; treat as no card.
      return false;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      await sleep(Math.min(intervalMs, remaining), signal);
    } catch {
      return false;
    }
  }
  return false;
}
