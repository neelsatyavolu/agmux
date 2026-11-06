-- Usage split by provider login (docs/teams-usage-by-login.md). Additive.
-- Hourly counters per (member device, provider, login). identity_hash is an
-- opaque sha256; the same counters as metric_hourly, summed across models and
-- projects, for events the desktop could attribute to a login.
CREATE TABLE IF NOT EXISTS metric_account_hourly (
    team_id             TEXT NOT NULL,
    user_id             TEXT NOT NULL,
    device_id           TEXT NOT NULL,
    hour_utc            TEXT NOT NULL,
    provider            TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
    identity_hash       TEXT NOT NULL,
    tokens_in           INTEGER NOT NULL DEFAULT 0,
    tokens_out          INTEGER NOT NULL DEFAULT 0,
    tokens_cache_read   INTEGER NOT NULL DEFAULT 0,
    tokens_cache_write  INTEGER NOT NULL DEFAULT 0,
    tokens_reasoning    INTEGER NOT NULL DEFAULT 0,
    cost_usd            REAL    NOT NULL DEFAULT 0,
    cost_incomplete     INTEGER NOT NULL DEFAULT 1 CHECK (cost_incomplete IN (0, 1)),
    active_ms           INTEGER NOT NULL DEFAULT 0,
    turns               INTEGER NOT NULL DEFAULT 0,
    updated_at          TEXT NOT NULL,
    PRIMARY KEY (team_id, user_id, device_id, hour_utc, provider, identity_hash)
);
CREATE INDEX IF NOT EXISTS idx_metric_account_hourly_user ON metric_account_hourly(team_id, user_id, hour_utc);

-- A Claude login's email, stored only while the team has Shared Claude accounts
-- on (provider_account_settings.claude_activity); deleted when it is turned off.
CREATE TABLE IF NOT EXISTS account_labels (
    team_id         TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    provider        TEXT NOT NULL,
    identity_hash   TEXT NOT NULL,
    label           TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (team_id, user_id, provider, identity_hash)
);

-- Set by desktops that report logins, so "not attributed" can be told apart
-- from "this app version does not report logins".
ALTER TABLE sync_state ADD COLUMN accounts_reported_at TEXT;
