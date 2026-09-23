-- Teams: approval wait / blocked-time samples (no prompts, no paths).
-- Open rows (resolved_at NULL) are in-flight waits; closed rows feed hourly
-- aggregates as approval_requests + approval_wait_ms on upload.

CREATE TABLE IF NOT EXISTS teams_approval_waits (
    request_id   TEXT PRIMARY KEY,
    thread_id    TEXT NOT NULL,
    provider     TEXT NOT NULL DEFAULT '',
    project_key  TEXT NOT NULL DEFAULT '',
    tool_name    TEXT NOT NULL DEFAULT '',
    started_at   TEXT NOT NULL,
    resolved_at  TEXT,
    wait_ms      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_teams_approval_waits_started
    ON teams_approval_waits(started_at);

CREATE INDEX IF NOT EXISTS idx_teams_approval_waits_open
    ON teams_approval_waits(resolved_at)
    WHERE resolved_at IS NULL;
