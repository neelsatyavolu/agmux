-- Next Teams upload does a full rescan + prune so dashboards drop sessions
-- that were never started in agmux (Codex app, Claude Code CLI, …).
DELETE FROM teams_scan_cursor;
ALTER TABLE teams_sync_state ADD COLUMN agmux_sessions_only INTEGER NOT NULL DEFAULT 0;
