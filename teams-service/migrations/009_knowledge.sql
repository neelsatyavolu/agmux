-- ── knowledge (team shared context; content plane, not telemetry) ──────────
-- See docs/superpowers/specs/2026-08-10-teams-knowledge-design.md
CREATE TABLE IF NOT EXISTS kw_workspaces (
    id          TEXT PRIMARY KEY,
    team_id     TEXT NOT NULL,
    title       TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS kw_workspaces_one_live
  ON kw_workspaces(team_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS kw_team_policy (
    team_id                 TEXT PRIMARY KEY,
    knowledge_mode          TEXT NOT NULL DEFAULT 'disabled',
    share_role              TEXT NOT NULL DEFAULT 'manager_plus',
    edit_records_role       TEXT NOT NULL DEFAULT 'manager_plus',
    knowledge_mcp_enabled   INTEGER NOT NULL DEFAULT 0,
    mcp_authority_filter    TEXT NOT NULL DEFAULT 'official_only',
    digest_retention_days   INTEGER NOT NULL DEFAULT 90,
    disclosure_version      INTEGER NOT NULL DEFAULT 1,
    updated_at              TEXT NOT NULL,
    updated_by              TEXT
);

CREATE TABLE IF NOT EXISTS kw_records (
    id              TEXT PRIMARY KEY,
    team_id         TEXT NOT NULL,
    workspace_id    TEXT NOT NULL,
    kind            TEXT NOT NULL,
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'current',
    authority       TEXT NOT NULL DEFAULT 'member',
    important       INTEGER NOT NULL DEFAULT 0,
    version         INTEGER NOT NULL DEFAULT 1,
    archived        INTEGER NOT NULL DEFAULT 0,
    source          TEXT NOT NULL DEFAULT 'user',
    owner_user_id   TEXT NOT NULL,
    project_key     TEXT,
    created_by      TEXT NOT NULL,
    updated_by      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    deleted_at      TEXT,
    deleted_by      TEXT,
    supersedes_json TEXT
);
CREATE INDEX IF NOT EXISTS kw_records_team ON kw_records(team_id, status, updated_at);

CREATE TABLE IF NOT EXISTS kw_record_versions (
    id          TEXT PRIMARY KEY,
    team_id     TEXT NOT NULL,
    record_id   TEXT NOT NULL,
    version     INTEGER NOT NULL,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    changed_by  TEXT NOT NULL,
    changed_at  TEXT NOT NULL,
    UNIQUE (team_id, record_id, version)
);

CREATE TABLE IF NOT EXISTS kw_session_digests (
    id                  TEXT PRIMARY KEY,
    team_id             TEXT NOT NULL,
    workspace_id        TEXT NOT NULL,
    title               TEXT NOT NULL,
    summary             TEXT NOT NULL,
    outcomes_json       TEXT,
    decisions_json      TEXT,
    files_json          TEXT,
    providers           TEXT,
    project_key         TEXT,
    source_project_id   TEXT,
    thread_id_hash      TEXT,
    review_state        TEXT NOT NULL DEFAULT 'published',
    risk_flags_json     TEXT,
    composed_on         TEXT NOT NULL DEFAULT 'desktop',
    shared_by           TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    deleted_at          TEXT,
    deleted_by          TEXT
);
CREATE INDEX IF NOT EXISTS kw_digests_team ON kw_session_digests(team_id, created_at);

CREATE TABLE IF NOT EXISTS kw_disclosure_accept (
    team_id             TEXT NOT NULL,
    user_id             TEXT NOT NULL,
    disclosure_version  INTEGER NOT NULL,
    accepted_at         TEXT NOT NULL,
    PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS kw_idempotency (
    team_id       TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    device_id     TEXT NOT NULL,
    op            TEXT NOT NULL,
    key           TEXT NOT NULL,
    response_json TEXT,
    created_at    TEXT NOT NULL,
    PRIMARY KEY (team_id, user_id, device_id, op, key)
);
