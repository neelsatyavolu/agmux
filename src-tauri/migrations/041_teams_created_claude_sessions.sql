-- Explicit in-app creation records, including provider IDs mapped from those
-- created sessions. Opening/resuming an outside session is not ownership.
CREATE TABLE IF NOT EXISTS teams_created_claude_sessions (
    session_id TEXT PRIMARY KEY NOT NULL
);
