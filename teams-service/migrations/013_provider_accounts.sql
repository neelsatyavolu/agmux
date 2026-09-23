-- Explicitly shared team OAuth credentials: separate from aggregate analytics.
-- Lease state lives on the account row so claim/renew/refresh are atomic updates.
CREATE TABLE IF NOT EXISTS provider_accounts (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('codex', 'grok')),
    label TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('team', 'manager')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    credentials_ciphertext TEXT NOT NULL,
    identity_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    blocked_until INTEGER,
    remaining_percent REAL CHECK (remaining_percent BETWEEN 0 AND 100),
    health_reported_at INTEGER,
    lease_id TEXT UNIQUE,
    lease_user_id TEXT,
    lease_device_id TEXT,
    lease_session_id TEXT,
    lease_expires_at INTEGER,
    UNIQUE (team_id, provider, identity_hash)
);
CREATE INDEX IF NOT EXISTS idx_provider_accounts_pool ON provider_accounts(team_id, provider, enabled, lease_expires_at);
