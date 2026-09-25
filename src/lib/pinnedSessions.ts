/**
 * Persist pinned session IDs per project in localStorage.
 * Pinned sessions float to the top of the project's thread list.
 */

import { syncRemoteSidebarPrefs } from "./remoteSidebarPrefs";

const KEY_PREFIX = "xanom:pinned-sessions:";

/**
 * Changes that could not be saved (e.g. localStorage quota exceeded), kept for
 * the rest of this app run: projectId → sessionId → pinned. A failed write
 * must not throw out of the pin toggle or a project move.
 */
const unsaved = new Map<string, Map<string, boolean>>();

function persistSet(projectId: string, set: Set<string>, changes: Array<[string, boolean]>): void {
  try {
    localStorage.setItem(`${KEY_PREFIX}${projectId}`, JSON.stringify([...set]));
    // The full set (including earlier unsaved changes) is now on disk.
    unsaved.delete(projectId);
  } catch (err) {
    unsaved.set(projectId, new Map([...(unsaved.get(projectId) ?? []), ...changes]));
    console.warn("[pinnedSessions] could not save pinned sessions; keeping them for this run", err);
    return;
  }
  // Mirror for the mobile remote catalog (pins float on the phone too).
  syncRemoteSidebarPrefs();
}

function readSaved(projectId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}${projectId}`);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    return new Set(parsed);
  } catch {
    return new Set();
  }
}

/** Load pinned session IDs for a project. */
export function loadPinnedSessions(projectId: string): Set<string> {
  const ids = readSaved(projectId);
  for (const [id, pinned] of unsaved.get(projectId) ?? []) {
    if (pinned) ids.add(id);
    else ids.delete(id);
  }
  return ids;
}

/** Pin a session and persist. */
export function addPinnedSession(projectId: string, sessionId: string): void {
  const set = loadPinnedSessions(projectId);
  set.add(sessionId);
  persistSet(projectId, set, [[sessionId, true]]);
}

/** Unpin a session and persist. */
export function removePinnedSession(projectId: string, sessionId: string): void {
  const set = loadPinnedSessions(projectId);
  if (set.delete(sessionId)) {
    persistSet(projectId, set, [[sessionId, false]]);
  }
}

/** Merge all pinned session IDs from one project into another, then clear source. */
export function transferPinnedSessions(fromProjectId: string, toProjectId: string): void {
  if (fromProjectId === toProjectId) return;
  const from = loadPinnedSessions(fromProjectId);
  if (from.size === 0) return;
  const to = loadPinnedSessions(toProjectId);
  for (const id of from) to.add(id);
  persistSet(toProjectId, to, [...from].map((id): [string, boolean] => [id, true]));
  persistSet(fromProjectId, new Set(), [...from].map((id): [string, boolean] => [id, false]));
}
