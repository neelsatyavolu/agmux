import { invoke } from "@tauri-apps/api/core";

const CREATED_PREFIX = "agmux-created-claude-sessions:";
const SESSION_MAP_KEY = "agmux-claude-session-map";
const LEGACY_SNAPSHOT_KEY = "agmux-legacy-claude-creation-ids-v1";
const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

function sessionIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && id.length === 36 && CLAUDE_SESSION_ID_RE.test(id))
    : [];
}

/** Only explicit creation proves ownership; opening/resuming a session does not. */
export function extractCreatedClaudeSessionIds(entries: Iterable<readonly [string, string]>): string[] {
  const created = new Set<string>();
  let mapping: unknown;
  for (const [key, raw] of entries) {
    if (key.startsWith(CREATED_PREFIX)) {
      for (const id of sessionIds(parse(raw))) created.add(id);
    } else if (key === SESSION_MAP_KEY) {
      mapping = parse(raw);
    }
  }
  const ids = new Set(created);
  if (mapping && typeof mapping === "object" && !Array.isArray(mapping)) {
    for (const [owner, nativeIds] of Object.entries(mapping)) {
      if (!created.has(owner)) continue;
      for (const id of sessionIds(nativeIds)) ids.add(id);
    }
  }
  return [...ids];
}

/** One-time legacy migration. New sessions use backend creation/binding records.
 * Freeze the initial IDs so a failed import cannot pick up future discoveries. */
export async function syncCreatedClaudeSessionsToTeams(): Promise<void> {
  try {
    const snapshot = localStorage.getItem(LEGACY_SNAPSHOT_KEY);
    if (snapshot !== null) {
      await invoke("teams_register_created_claude_sessions", { sessionIds: sessionIds(parse(snapshot)) });
      return;
    }
    const entries: [string, string][] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || (!key.startsWith(CREATED_PREFIX) && key !== SESSION_MAP_KEY)) continue;
      const raw = localStorage.getItem(key);
      if (raw !== null) entries.push([key, raw]);
    }
    const ids = extractCreatedClaudeSessionIds(entries);
    localStorage.setItem(LEGACY_SNAPSHOT_KEY, JSON.stringify(ids));
    await invoke("teams_register_created_claude_sessions", { sessionIds: ids });
  } catch (error) {
    console.warn("Failed to register created Claude sessions for Teams:", error);
  }
}
