-- Supplemental observed shell edits, independent of transcript-derived totals.
-- Native provider session IDs may not have an agmux threads row.
CREATE TABLE shell_diff_events (
    owner_id TEXT NOT NULL,
    session_id TEXT,
    tool_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    lines_added INTEGER NOT NULL CHECK (lines_added >= 0),
    lines_removed INTEGER NOT NULL CHECK (lines_removed >= 0),
    PRIMARY KEY (owner_id, tool_id, file_path)
);
CREATE INDEX shell_diff_events_session ON shell_diff_events(session_id);
