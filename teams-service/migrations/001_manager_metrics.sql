-- Adds the manager-facing columns and tables to an existing deployment.
--
-- `schema.sql` already contains all of this for a fresh database; this file is
-- the additive path for the live D1, which predates these columns.
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`, so the ALTERs below are **one-shot**:
-- re-running the file fails with "duplicate column name" once they are applied.
-- That is loud rather than silent, which is the right failure mode. The
-- CREATE TABLEs are guarded and safe to re-run.
--
--   npx wrangler d1 execute agmux-teams --local  --file=./migrations/001_manager_metrics.sql
--   npx wrangler d1 execute agmux-teams --remote --file=./migrations/001_manager_metrics.sql

-- ── tool mix ──────────────────────────────────────────────────────────────
ALTER TABLE metric_hourly ADD COLUMN tool_bash      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metric_hourly ADD COLUMN tool_edit      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metric_hourly ADD COLUMN tool_read      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metric_hourly ADD COLUMN tool_search    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metric_hourly ADD COLUMN tool_web       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metric_hourly ADD COLUMN tool_agent     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metric_hourly ADD COLUMN tool_mcp       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metric_hourly ADD COLUMN tool_other     INTEGER NOT NULL DEFAULT 0;

-- tools_measured is deliberately separate from tool_calls: Codex reports no
-- general tool-outcome flag, so dividing errors by tool_calls would score every
-- unobservable Codex call as a success.
ALTER TABLE metric_hourly ADD COLUMN tool_errors    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metric_hourly ADD COLUMN tools_measured INTEGER NOT NULL DEFAULT 0;

-- ── output ────────────────────────────────────────────────────────────────
ALTER TABLE metric_hourly ADD COLUMN files_changed  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metric_hourly ADD COLUMN lines_added    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metric_hourly ADD COLUMN lines_removed  INTEGER NOT NULL DEFAULT 0;

-- ── budgets, alerts, audit ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS team_budgets (
    team_id      TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
    monthly_usd  REAL NOT NULL,
    thresholds   TEXT NOT NULL DEFAULT '80,100',
    webhook_url  TEXT,
    updated_by   TEXT NOT NULL REFERENCES users(id),
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_alerts (
    team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    month       TEXT NOT NULL,
    threshold   INTEGER NOT NULL,
    fired_at    TEXT NOT NULL,
    spend_usd   REAL NOT NULL,
    delivered   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (team_id, month, threshold)
);

CREATE TABLE IF NOT EXISTS audit_log (
    id             TEXT PRIMARY KEY,
    team_id        TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    actor_user_id  TEXT,
    action         TEXT NOT NULL,
    target         TEXT,
    detail         TEXT,
    created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_team_time ON audit_log(team_id, created_at DESC);
