// Shared pace-info cache for provider usage widgets (HomeScreen + UsagePanel).
//
// Both the home tab's Provider Usage card and the sidebar Usage tab read the
// same per-provider pace data. Keeping separate module-level caches meant each
// consumer fetched independently, doubling the hits on getPaceInfo and making
// rate-limit backoff state diverge between views. This module is the single
// source of truth — every consumer goes through these accessors so a fetch
// triggered from one surface populates the other for free.

import { getPaceInfo, type PaceInfo } from "./commands";

export type ProviderId = "claude" | "codex" | "grok" | "warp" | "gemini" | "cursor";

export interface PaceCell {
  data: PaceInfo | null;
  /** Timestamp of the most recent successful fetch (0 if never). */
  dataAt: number;
  error: string | null;
  errorAt: number;
  rateLimited: boolean;
}

const EMPTY: PaceCell = {
  data: null,
  dataAt: 0,
  error: null,
  errorAt: 0,
  rateLimited: false,
};

/** How long a successful response stays fresh before we refetch. */
export const PACE_TTL_MS = 10 * 60_000;
/** How long to wait after a 429 before we try that provider again. */
export const RATE_LIMIT_BACKOFF_MS = 30 * 60_000;

const cache: Record<ProviderId, PaceCell> = {
  claude: { ...EMPTY },
  codex: { ...EMPTY },
  grok: { ...EMPTY },
  warp: { ...EMPTY },
  gemini: { ...EMPTY },
  cursor: { ...EMPTY },
};

const inFlight: Partial<Record<ProviderId, Promise<void>>> = {};

export function isRateLimitError(err: unknown): boolean {
  const raw =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : typeof err === "object" && err !== null && "message" in err
          ? String((err as { message?: unknown }).message ?? "")
          : String(err ?? "");
  const msg = raw.toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("rate-limit") ||
    msg.includes("ratelimit") ||
    msg.includes("429") ||
    msg.includes("too many requests")
  );
}

export function getPaceCell(id: ProviderId): PaceCell {
  return cache[id];
}

export function shouldRefetchPace(id: ProviderId, now: number = Date.now()): boolean {
  const cell = cache[id];
  if (cell.rateLimited && now - cell.errorAt < RATE_LIMIT_BACKOFF_MS) return false;
  if (cell.dataAt > 0 && now - cell.dataAt < PACE_TTL_MS) return false;
  return true;
}

/** Fetch a provider's pace info unless cached fresh. Coalesces concurrent
 *  callers so two mounts hitting this at once share one network round-trip. */
export async function fetchPaceIfStale(id: ProviderId): Promise<void> {
  if (!shouldRefetchPace(id)) return;
  const existing = inFlight[id];
  if (existing) return existing;
  const cell = cache[id];
  const job = (async () => {
    try {
      const data = await getPaceInfo(id);
      cell.data = data;
      cell.dataAt = Date.now();
      cell.error = null;
      cell.errorAt = 0;
      cell.rateLimited = false;
    } catch (err) {
      cell.error = err instanceof Error ? err.message : String(err);
      cell.errorAt = Date.now();
      cell.rateLimited = isRateLimitError(err);
    }
  })();
  inFlight[id] = job.finally(() => {
    delete inFlight[id];
  });
  return inFlight[id];
}

/** Shallow snapshot so React consumers can setState and trigger rerenders. */
export function snapshotPaceCache(): Record<ProviderId, PaceCell> {
  return {
    claude: { ...cache.claude },
    codex: { ...cache.codex },
    grok: { ...cache.grok },
    warp: { ...cache.warp },
    gemini: { ...cache.gemini },
    cursor: { ...cache.cursor },
  };
}

/**
 * Contextual label for Grok's credit bar — "Weekly" / "Monthly" when the
 * billing period matches those cycles, else "Credits" (CodexBar convention).
 */
export function grokCreditsLabel(window: {
  windowMinutes?: number | null;
  resetsAt?: string | null;
} | null | undefined): string {
  if (!window) return "Credits";
  let seconds: number | null = null;
  if (window.windowMinutes != null && window.windowMinutes > 0) {
    seconds = window.windowMinutes * 60;
  } else if (window.resetsAt) {
    const numeric = Number(window.resetsAt);
    const target = Number.isFinite(numeric) && numeric > 1_000_000_000
      ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric)
      : new Date(window.resetsAt).getTime();
    if (Number.isFinite(target)) {
      seconds = Math.max(0, (target - Date.now()) / 1000);
    }
  }
  if (seconds == null || seconds <= 3600) return "Credits";
  const days = Math.round(seconds / 86_400);
  if (days >= 4 && days <= 12) return "Weekly";
  if (days >= 20 && days <= 45) return "Monthly";
  return "Credits";
}

/**
 * Label a rate-limit window from its duration. Codex no longer always has a
 * 5-hour primary bucket — after that limit was lifted, primary can be weekly.
 * Prefer the real window when known; fall back to the historical slot name.
 */
export function usageWindowLabel(
  window: { windowMinutes?: number | null } | null | undefined,
  fallback: "5-hour" | "Weekly" | string,
): string {
  const mins = window?.windowMinutes;
  if (mins == null || mins <= 0) return fallback;
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m`;
  if (mins < 24 * 60) {
    const hours = Math.round(mins / 60);
    return hours === 1 ? "1-hour" : `${hours}-hour`;
  }
  const days = Math.round(mins / (24 * 60));
  if (days >= 4 && days <= 12) return "Weekly";
  if (days >= 20 && days <= 45) return "Monthly";
  if (days === 1) return "Daily";
  return `${days}-day`;
}
