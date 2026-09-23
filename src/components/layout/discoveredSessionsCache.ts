/**
 * Module-level cache for the home screen's discovered CLI sessions.
 *
 * HomeScreen unmounts every time the user opens a thread (see `MainPanel`'s
 * `{!activeViewKey && ... && <HomeScreen />}`) and remounts on return. The
 * Codex/Claude/Kimi session maps used to live in component `useState`, so
 * each remount reset them to `{}` and the Recent Threads card flashed an
 * incomplete, agmux-threads-only list for the few seconds the filesystem
 * session-discovery commands took to re-run.
 *
 * This cache survives unmounts. HomeScreen seeds its state from
 * `snapshotDiscoveredSessions()` so a remount renders the last-known list
 * immediately, then refreshes it in the background (stale-while-revalidate) —
 * mirroring the pattern in `src/lib/providerUsageCache.ts`.
 */

import type { ClaudeSession, KimiSession } from "../../lib/types";
import type { CodexThread } from "../sidebar/CodexSessionsList";

export interface DiscoveredSessions {
  codex: Record<string, CodexThread[]>;
  claude: Record<string, ClaudeSession[]>;
  kimi: Record<string, KimiSession[]>;
}

const cache: DiscoveredSessions = {
  codex: {},
  claude: {},
  kimi: {},
};

/** Cache one project's discovered Codex threads. */
export function storeCodexSessions(projectId: string, data: CodexThread[]): void {
  cache.codex = { ...cache.codex, [projectId]: data };
}

/** Cache one project's discovered Claude sessions. */
export function storeClaudeSessions(projectId: string, data: ClaudeSession[]): void {
  cache.claude = { ...cache.claude, [projectId]: data };
}

/** Cache one project's discovered Kimi sessions. */
export function storeKimiSessions(projectId: string, data: KimiSession[]): void {
  cache.kimi = { ...cache.kimi, [projectId]: data };
}

/** Shallow snapshot so React `useState` initializers get fresh references. */
export function snapshotDiscoveredSessions(): DiscoveredSessions {
  return {
    codex: { ...cache.codex },
    claude: { ...cache.claude },
    kimi: { ...cache.kimi },
  };
}

/**
 * Drop cached entries for projects that no longer exist. Without this the
 * cache only ever grows — a deleted project's discovered sessions linger for
 * the whole app session and can briefly resurface in Recent Threads on a
 * HomeScreen remount. Call after each discovery refetch with the live ids.
 */
export function pruneDiscoveredSessions(validProjectIds: readonly string[]): void {
  const valid = new Set(validProjectIds);
  const filter = <T>(map: Record<string, T>): Record<string, T> => {
    const next: Record<string, T> = {};
    for (const [id, value] of Object.entries(map)) {
      if (valid.has(id)) next[id] = value;
    }
    return next;
  };
  cache.codex = filter(cache.codex);
  cache.claude = filter(cache.claude);
  cache.kimi = filter(cache.kimi);
}
