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

/**
 * Changes that could not be saved (e.g. localStorage quota exceeded), kept for
 * the rest of this app run: projectId → sessionId → hidden. A failed write
 * must not throw out of hide/delete handlers or bring the session back.
 */
const unsaved = new Map<string, Map<string, boolean>>();

function persistSet(projectId: string, set: Set<string>, changes: Array<[string, boolean]>): void {
  try {
    localStorage.setItem(`${KEY_PREFIX}${projectId}`, JSON.stringify([...set]));
    // The full set (including earlier unsaved changes) is now on disk.
    unsaved.delete(projectId);
  } catch (err) {
    unsaved.set(projectId, new Map([...(unsaved.get(projectId) ?? []), ...changes]));
    console.warn("[hiddenSessions] could not save hidden sessions; keeping them for this run", err);
    return;
  }
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

/** Load hidden session IDs for a project. */
export function loadHiddenSessions(projectId: string): Set<string> {
  const ids = readSaved(projectId);
  for (const [id, hidden] of unsaved.get(projectId) ?? []) {
    if (hidden) ids.add(id);
    else ids.delete(id);
  }
  return ids;
}

/** Hide a session and persist. */
export function addHiddenSession(projectId: string, sessionId: string): void {
  if (!sessionId) return;
  const set = loadHiddenSessions(projectId);
  set.add(sessionId);
  persistSet(projectId, set, [[sessionId, true]]);
}

/** Unhide a session and persist. */
export function removeHiddenSession(projectId: string, sessionId: string): void {
  const set = loadHiddenSessions(projectId);
  if (set.delete(sessionId)) {
    persistSet(projectId, set, [[sessionId, false]]);
  }
}

/** Merge all hidden session IDs from one project into another, then clear source. */
export function transferHiddenSessions(fromProjectId: string, toProjectId: string): void {
  if (fromProjectId === toProjectId) return;
  const from = loadHiddenSessions(fromProjectId);
  if (from.size === 0) return;
  const to = loadHiddenSessions(toProjectId);
  for (const id of from) to.add(id);
  persistSet(toProjectId, to, [...from].map((id): [string, boolean] => [id, true]));
  persistSet(fromProjectId, new Set(), [...from].map((id): [string, boolean] => [id, false]));
}
