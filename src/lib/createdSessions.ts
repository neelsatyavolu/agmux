/**
 * Per-project localStorage persistence for created Claude session IDs.
 *
 * When a user creates a Claude PTY session in-app, its agmux UUID is tracked
 * here so it remains visible in the sidebar after app restart — even when
 * the session's preview text matches the DEFAULT_SESSION_RE pattern that
 * would normally filter it out.
 */

const CREATED_SESSIONS_KEY_PREFIX = "agmux-created-claude-sessions:";

/**
 * Changes that could not be saved (e.g. localStorage quota exceeded), kept for
 * the rest of this app run: projectId → sessionId → present. A new Claude
 * terminal has no transcript until its first prompt, so this list is the only
 * thing keeping its sidebar row alive — a failed write must not drop it.
 */
const unsaved = new Map<string, Map<string, boolean>>();

function readSaved(projectId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`${CREATED_SESSIONS_KEY_PREFIX}${projectId}`);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    return new Set(parsed);
  } catch {
    return new Set();
  }
}

/** Load the set of created Claude session IDs for a project. */
export function loadCreatedClaudeSessions(projectId: string): Set<string> {
  const ids = readSaved(projectId);
  for (const [id, present] of unsaved.get(projectId) ?? []) {
    if (present) ids.add(id);
    else ids.delete(id);
  }
  return ids;
}

function persistSet(projectId: string, ids: Set<string>, changes: Array<[string, boolean]>): void {
  try {
    localStorage.setItem(
      `${CREATED_SESSIONS_KEY_PREFIX}${projectId}`,
      JSON.stringify([...ids]),
    );
    // The full set (including earlier unsaved changes) is now on disk.
    unsaved.delete(projectId);
  } catch (err) {
    unsaved.set(projectId, new Map([...(unsaved.get(projectId) ?? []), ...changes]));
    console.warn("[createdSessions] could not save created Claude sessions; keeping them for this run", err);
  }
}

/** Add a session ID and persist the updated set. */
export function addCreatedClaudeSession(projectId: string, sessionId: string): void {
  const set = loadCreatedClaudeSessions(projectId);
  set.add(sessionId);
  persistSet(projectId, set, [[sessionId, true]]);
}

/** Remove a session ID and persist if it was present. */
export function removeCreatedClaudeSession(projectId: string, sessionId: string): void {
  const set = loadCreatedClaudeSessions(projectId);
  if (set.delete(sessionId)) {
    persistSet(projectId, set, [[sessionId, false]]);
  }
}

/** Merge created Claude session IDs from one project into another, then clear source. */
export function transferCreatedClaudeSessions(fromProjectId: string, toProjectId: string): void {
  if (fromProjectId === toProjectId) return;
  const from = loadCreatedClaudeSessions(fromProjectId);
  if (from.size === 0) return;
  const to = loadCreatedClaudeSessions(toProjectId);
  for (const id of from) to.add(id);
  persistSet(toProjectId, to, [...from].map((id): [string, boolean] => [id, true]));
  persistSet(fromProjectId, new Set(), [...from].map((id): [string, boolean] => [id, false]));
}
