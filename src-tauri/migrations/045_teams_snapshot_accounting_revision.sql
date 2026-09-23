-- Preserve old normalized history for review when its original source is gone.
-- Codex rows predating the native-history-boundary repair cannot certify totals.
ALTER TABLE teams_usage_snapshots ADD COLUMN accounting_revision INTEGER NOT NULL DEFAULT 0;
UPDATE teams_sync_state SET agmux_sessions_only=0 WHERE id=1;
