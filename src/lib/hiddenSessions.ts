/**
 * Persist hidden (archived) session IDs per project in localStorage.
 * Hidden sessions are filtered out of the project's thread list and
 * survive app restarts — unlike the previous in-memory-only approach.
 *
 * Also mirrored to ~/.agmux/sidebar-prefs.json via syncRemoteSidebarPrefs so
 * the mobile remote catalog does not resurrect dismissed on-disk sessions.
 */

import { syncRemoteSidebarPrefs } from "./remoteSidebarPrefs";

const KEY_PREFIX = "xanom:hidden-sessions:";

function persistSet(projectId: string, set: Set<string>): void {
  localStorage.setItem(`${KEY_PREFIX}${projectId}`, JSON.stringify([...set]));
  syncRemoteSidebarPrefs();
}

/** Load hidden session IDs for a project. */
export function loadHiddenSessions(projectId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}${projectId}`);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    return new Set(parsed);
  } catch {
    return new Set();
  }
}

/** Hide a session and persist. */
export function addHiddenSession(projectId: string, sessionId: string): void {
  if (!sessionId) return;
  const set = loadHiddenSessions(projectId);
  set.add(sessionId);
  persistSet(projectId, set);
}

/** Unhide a session and persist. */
export function removeHiddenSession(projectId: string, sessionId: string): void {
  const set = loadHiddenSessions(projectId);
  if (set.delete(sessionId)) {
    persistSet(projectId, set);
  }
}

/** Merge all hidden session IDs from one project into another, then clear source. */
export function transferHiddenSessions(fromProjectId: string, toProjectId: string): void {
  if (fromProjectId === toProjectId) return;
  const from = loadHiddenSessions(fromProjectId);
  if (from.size === 0) return;
  const to = loadHiddenSessions(toProjectId);
  for (const id of from) to.add(id);
  persistSet(toProjectId, to);
  persistSet(fromProjectId, new Set());
}
