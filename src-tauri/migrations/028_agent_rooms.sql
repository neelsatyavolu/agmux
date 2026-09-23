-- 028_agent_rooms.sql
-- Multi-Agent Rooms: group existing threads for a shared board + A2A later.

CREATE TABLE IF NOT EXISTS agent_rooms (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  a2a_enabled INTEGER NOT NULL DEFAULT 1,
  max_a2a_rounds INTEGER NOT NULL DEFAULT 4,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_room_members (
  room_id TEXT NOT NULL REFERENCES agent_rooms(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  label TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, thread_id)
);

CREATE TABLE IF NOT EXISTS agent_room_events (
  id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES agent_rooms(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  from_thread_id TEXT,
  to_thread_id TEXT,
  body TEXT NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_room_events_room_created
  ON agent_room_events(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_room_members_thread
  ON agent_room_members(thread_id);
