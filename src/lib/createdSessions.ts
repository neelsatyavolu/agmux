/**
 * Per-project localStorage persistence for created Claude session IDs.
 *
 * When a user creates a Claude PTY session in-app, its agmux UUID is tracked
 * here so it remains visible in the sidebar after app restart — even when
 * the session's preview text matches the DEFAULT_SESSION_RE pattern that
 * would normally filter it out.
 */

const CREATED_SESSIONS_KEY_PREFIX = "agmux-created-claude-sessions:";

/** Load the set of created Claude session IDs for a project from localStorage. */
export function loadCreatedClaudeSessions(projectId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`${CREATED_SESSIONS_KEY_PREFIX}${projectId}`);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    return new Set(parsed);
  } catch {
    return new Set();
  }
}

function persistSet(projectId: string, ids: Set<string>): void {
  try {
    localStorage.setItem(
      `${CREATED_SESSIONS_KEY_PREFIX}${projectId}`,
      JSON.stringify([...ids]),
    );
  } catch {
    // Quota exceeded — silently ignore
  }
}

/** Add a session ID and persist the updated set. */
export function addCreatedClaudeSession(projectId: string, sessionId: string): void {
  const set = loadCreatedClaudeSessions(projectId);
  set.add(sessionId);
  persistSet(projectId, set);
}

/** Remove a session ID and persist if it was present. */
export function removeCreatedClaudeSession(projectId: string, sessionId: string): void {
  const set = loadCreatedClaudeSessions(projectId);
  if (set.delete(sessionId)) {
    persistSet(projectId, set);
  }
}

/** Merge created Claude session IDs from one project into another, then clear source. */
export function transferCreatedClaudeSessions(fromProjectId: string, toProjectId: string): void {
  if (fromProjectId === toProjectId) return;
  const from = loadCreatedClaudeSessions(fromProjectId);
  if (from.size === 0) return;
  const to = loadCreatedClaudeSessions(toProjectId);
  for (const id of from) to.add(id);
  persistSet(toProjectId, to);
  persistSet(fromProjectId, new Set());
}
