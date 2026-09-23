-- Retain observed, normalized usage for the Teams retention window even when
-- a provider removes its transcript. No prompts, replies or tool arguments.
CREATE TABLE IF NOT EXISTS teams_usage_snapshots (
    provider TEXT NOT NULL,
    session_id TEXT NOT NULL,
    last_event_at INTEGER NOT NULL,
    events_json TEXT NOT NULL,
    PRIMARY KEY (provider, session_id)
);
