/**
 * Persist pinned session IDs per project in localStorage.
 * Pinned sessions float to the top of the project's thread list.
 */

import { syncRemoteSidebarPrefs } from "./remoteSidebarPrefs";

const KEY_PREFIX = "xanom:pinned-sessions:";

function persistSet(projectId: string, set: Set<string>): void {
  localStorage.setItem(`${KEY_PREFIX}${projectId}`, JSON.stringify([...set]));
  // Mirror for the mobile remote catalog (pins float on the phone too).
  syncRemoteSidebarPrefs();
}

/** Load pinned session IDs for a project. */
export function loadPinnedSessions(projectId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}${projectId}`);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    return new Set(parsed);
  } catch {
    return new Set();
  }
}

/** Pin a session and persist. */
export function addPinnedSession(projectId: string, sessionId: string): void {
  const set = loadPinnedSessions(projectId);
  set.add(sessionId);
  persistSet(projectId, set);
}

/** Unpin a session and persist. */
export function removePinnedSession(projectId: string, sessionId: string): void {
  const set = loadPinnedSessions(projectId);
  if (set.delete(sessionId)) {
    persistSet(projectId, set);
  }
}

/** Merge all pinned session IDs from one project into another, then clear source. */
export function transferPinnedSessions(fromProjectId: string, toProjectId: string): void {
  if (fromProjectId === toProjectId) return;
  const from = loadPinnedSessions(fromProjectId);
  if (from.size === 0) return;
  const to = loadPinnedSessions(toProjectId);
  for (const id of from) to.add(id);
  persistSet(toProjectId, to);
  persistSet(fromProjectId, new Set());
}
