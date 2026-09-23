-- Full Teams upload after the agmux-only filter used prune-time "now" as the
-- cutoff and deleted the hourly rows that upload had just written. Reset so
-- the next launch does Full+prune with last_upload_at / notBefore instead.
UPDATE teams_sync_state SET agmux_sessions_only = 0 WHERE id = 1;
DELETE FROM teams_scan_cursor;
