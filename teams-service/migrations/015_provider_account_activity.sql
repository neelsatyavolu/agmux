-- Which logins members' running agmux sessions use right now (opaque identity hashes and
-- session counts; Claude only when the owner enables it). Rows expire by reported_at.
CREATE TABLE IF NOT EXISTS provider_account_activity (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'grok')),
    identity_hash TEXT NOT NULL,
    label TEXT,
    sessions INTEGER NOT NULL,
    reported_at INTEGER NOT NULL,
    PRIMARY KEY (team_id, device_id, provider, identity_hash)
);
CREATE INDEX IF NOT EXISTS idx_provider_account_activity_login ON provider_account_activity(team_id, provider, identity_hash, reported_at);
CREATE TABLE IF NOT EXISTS provider_account_settings (
    team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
    claude_activity INTEGER NOT NULL DEFAULT 0 CHECK (claude_activity IN (0, 1)),
    updated_at INTEGER NOT NULL,
    updated_by TEXT
);
