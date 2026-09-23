-- Incremental scan cursors for the agmux Teams telemetry reader.
--
-- Provider JSONL logs are append-only, so a byte offset is a safe resume point:
-- only appended bytes are re-parsed on each 2-minute tick. A file that shrank
-- is treated as rewritten and read from the start.
--
-- Stores paths to the user's own local log files. Nothing here is ever
-- uploaded — the uploader only ships counters and short labels.
CREATE TABLE IF NOT EXISTS teams_scan_cursor (
    path         TEXT PRIMARY KEY,
    offset_bytes INTEGER NOT NULL DEFAULT 0,
    scanned_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_teams_scan_cursor_scanned
    ON teams_scan_cursor(scanned_at);
