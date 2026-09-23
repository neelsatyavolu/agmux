-- Approval wait / blocked-time counters (absolute per hourly bucket).
-- Additive only — re-running fails with "duplicate column name" once applied.
--
--   npx wrangler d1 execute agmux-teams --local  --file=./migrations/008_approval_wait.sql
--   npx wrangler d1 execute agmux-teams --remote --file=./migrations/008_approval_wait.sql

ALTER TABLE metric_hourly ADD COLUMN approval_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metric_hourly ADD COLUMN approval_wait_ms  INTEGER NOT NULL DEFAULT 0;

-- Org policy plane (allowed agents/models + defaults). One row per team.
CREATE TABLE IF NOT EXISTS team_policies (
    team_id                  TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
    -- JSON string arrays; empty/null = no restriction.
    allowed_providers        TEXT,
    allowed_models           TEXT,
    -- default | auto | plan | bypassPermissions (provider-normalized on desktop).
    default_permission_mode  TEXT,
    -- JSON string array of MCP server names; empty/null = no restriction.
    mcp_allowlist            TEXT,
    -- Soft/hard spend cap in USD for the month; null = unset.
    spend_hard_stop_usd      REAL,
    updated_by               TEXT REFERENCES users(id),
    updated_at               TEXT NOT NULL
);
