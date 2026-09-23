/**
 * Detect whether Antigravity CLI (`agy`) is showing an interactive permission
 * card. agy has no PermissionRequest hook — PreToolUse fires for every tool,
 * including auto-allowed workspace reads — so we never raise amber from the
 * hook alone. Poll the recent PTY tail for the live Allow / Deny chrome.
 */

import { getPtySnapshot } from "./commands";
import { ptyTail, stripAnsi } from "./grokPermissionPrompt";

/** agy paints the card as soon as PreToolUse returns; keep this short. */
export const GEMINI_PERMISSION_TIMEOUT_MS = 8_000;

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

async function defaultReadPtyText(threadId: string): Promise<string> {
  const snap = await getPtySnapshot(threadId);
  if (!snap?.data) return "";
  const bytes = decodeBase64ToBytes(snap.data);
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
 * True when `text` looks like agy's interactive permission chooser.
 * Labels taken from the agy binary (Allow / always-allow / persist options).
 */
export function ptyTextLooksLikeGeminiPermissionPrompt(text: string): boolean {
  if (!text) return false;
  const plain = stripAnsi(ptyTail(text)).toLowerCase();

  if (
    plain.includes("yes, and always allow") ||
    plain.includes("yes, grant permission for")
  ) {
    return true;
  }

  const hasYesAllow = plain.includes("yes, allow");
  const hasNoDeny =
    plain.includes("no, deny") || plain.includes("no, and always deny");
  if (hasYesAllow && hasNoDeny) return true;

  if (
    plain.includes("persist to settings.json") &&
    (hasYesAllow || hasNoDeny || plain.includes("always allow") || plain.includes("always deny"))
  ) {
    return true;
  }

  return false;
}

export interface WaitForGeminiPermissionPromptOptions {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  readPtyText?: (threadId: string) => Promise<string>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export async function waitForGeminiPermissionPrompt(
  threadId: string,
  options: WaitForGeminiPermissionPromptOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? GEMINI_PERMISSION_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 150;
  const readPtyText = options.readPtyText ?? defaultReadPtyText;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    try {
      const text = await readPtyText(threadId);
      if (ptyTextLooksLikeGeminiPermissionPrompt(text)) return true;
    } catch {
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

export async function waitForGeminiPermissionMenuGone(
  threadId: string,
  options: WaitForGeminiPermissionPromptOptions & { goneStreak?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const intervalMs = options.intervalMs ?? 150;
  const goneStreakNeeded = options.goneStreak ?? 2;
  const readPtyText = options.readPtyText ?? defaultReadPtyText;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;
  const maxPolls = Math.max(4, Math.ceil(timeoutMs / Math.max(intervalMs, 1)) + 2);

  let goneStreak = 0;
  let polls = 0;
  const deadline = Date.now() + timeoutMs;
  while (polls < maxPolls && Date.now() < deadline) {
    if (signal?.aborted) return false;
    try {
      const text = await readPtyText(threadId);
      polls += 1;
      if (ptyTextLooksLikeGeminiPermissionPrompt(text)) {
        goneStreak = 0;
      } else {
        goneStreak += 1;
        if (goneStreak >= goneStreakNeeded) return true;
      }
    } catch {
      return false;
    }
    if (polls >= maxPolls || Date.now() >= deadline) break;
    try {
      await sleep(intervalMs, signal);
    } catch {
      return false;
    }
  }
  return false;
}
