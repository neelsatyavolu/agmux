-- Team sessions: members who opt in list their live agent sessions, and teammates'
-- agents can ask a read-only copy of one or (when allowed) message it. A content
-- plane like Team Knowledge, not analytics: questions and answers are held only
-- until they are delivered and read.
CREATE TABLE IF NOT EXISTS team_session_sharing (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    accept_messages INTEGER NOT NULL DEFAULT 0 CHECK (accept_messages IN (0, 1)),
    enabled_at INTEGER NOT NULL,
    PRIMARY KEY (team_id, user_id)
);

-- One row per live session a desktop reports; a desktop replaces its own rows on
-- every report, rows older than the live window are ignored, and the hourly sweep
-- deletes them. Device ids are chosen by the desktop, so every lookup also uses the user.
CREATE TABLE IF NOT EXISTS team_live_sessions (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    session_key TEXT NOT NULL,
    public_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    title TEXT,
    project TEXT,
    branch TEXT,
    status TEXT NOT NULL,
    can_ask INTEGER NOT NULL DEFAULT 0 CHECK (can_ask IN (0, 1)),
    reported_at INTEGER NOT NULL,
    PRIMARY KEY (team_id, user_id, device_id, session_key)
);
CREATE INDEX IF NOT EXISTS idx_team_live_sessions_public ON team_live_sessions(team_id, public_id);

CREATE TABLE IF NOT EXISTS team_session_requests (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    from_user_id TEXT NOT NULL,
    to_user_id TEXT NOT NULL,
    to_device_id TEXT NOT NULL,
    session_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('ask', 'message')),
    body TEXT NOT NULL,
    effort TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'answered', 'failed')),
    answer TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    claimed_at INTEGER,
    finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_team_session_requests_inbox ON team_session_requests(to_user_id, to_device_id, status);
CREATE INDEX IF NOT EXISTS idx_team_session_requests_from ON team_session_requests(team_id, from_user_id, status);
