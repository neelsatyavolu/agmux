-- agmux Teams — D1 schema.
-- Apply:  npm run db:local   /   npm run db:remote
--
-- Telemetry tables store counters and short labels, never prompt text, replies,
-- diffs, file contents, absolute paths or secrets. Explicit Knowledge sharing and
-- encrypted provider_accounts are separate content/credential planes.

-- ── identity ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL,
    email         TEXT,
    handle        TEXT,
    avatar_color  TEXT NOT NULL DEFAULT '#60a5fa',
    -- https URL of the GitHub/Google profile photo; null → colored initials (or
    -- GitHub CDN fallback from identities when the user linked GitHub).
    avatar_url    TEXT,
    -- IANA zone last reported by the desktop (e.g. Asia/Tokyo). After-hours,
    -- weekend and the hour-of-day heatmap are classified in this zone on the
    -- device; the server only stores the name so managers can see it.
    timezone      TEXT,
    timezone_updated_at TEXT,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identities (
    provider          TEXT NOT NULL CHECK (provider IN ('github', 'google')),
    provider_user_id  TEXT NOT NULL,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at        TEXT NOT NULL,
    PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);

-- Web session cookies. Only the SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Desktop device tokens (upload + dashboard read). Hashed, revocable.
CREATE TABLE IF NOT EXISTS device_tokens (
    token_hash    TEXT PRIMARY KEY,
    device_id     TEXT NOT NULL,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_label  TEXT,
    created_at    TEXT NOT NULL,
    last_seen_at  TEXT,
    revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);

-- One-shot codes handing a device token to the desktop app after web OAuth.
CREATE TABLE IF NOT EXISTS device_link_codes (
    code_hash    TEXT PRIMARY KEY,
    device_id    TEXT NOT NULL,
    user_id      TEXT,
    device_label TEXT,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    claimed_at   TEXT
);

-- ── teams ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teams (
    id          TEXT PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    created_by  TEXT NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL,
    deleted_at  TEXT,
    -- Billing (Stripe). trial_ends_at set on create = now+30d.
    -- billing_status: trialing | active | past_due | canceled | locked | comp
    trial_ends_at          TEXT,
    billing_status         TEXT NOT NULL DEFAULT 'trialing',
    stripe_customer_id     TEXT,
    stripe_subscription_id TEXT,
    stripe_price_id        TEXT,
    seat_quantity          INTEGER,
    -- Desired seats after current period ends (downgrades only). Null = no pending change.
    pending_seat_quantity  INTEGER,
    billing_period_end     TEXT,
    billing_email          TEXT
);

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
    id         TEXT PRIMARY KEY,
    team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'employee')),
    joined_at  TEXT NOT NULL,
    left_at    TEXT,
    UNIQUE (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

-- Named groups of members (org structure). Reused for manager scope and
-- future filtering. Membership is soft: leaving the team does not delete the
-- user row, so app code drops group membership on leave/remove.
CREATE TABLE IF NOT EXISTS team_groups (
    id          TEXT PRIMARY KEY,
    team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE (team_id, name)
);
CREATE INDEX IF NOT EXISTS idx_team_groups_team ON team_groups(team_id);

CREATE TABLE IF NOT EXISTS team_group_members (
    group_id  TEXT NOT NULL REFERENCES team_groups(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_at  TEXT NOT NULL,
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_group_members_user ON team_group_members(user_id);

-- Manager analytics scope. Zero rows for a manager ⇒ entire team (default).
-- One or more rows ⇒ union of target people and people in target groups,
-- always including the manager themselves. Owners ignore this table.
CREATE TABLE IF NOT EXISTS manager_scope (
    id                TEXT PRIMARY KEY,
    team_id           TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    manager_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
    target_group_id   TEXT REFERENCES team_groups(id) ON DELETE CASCADE,
    created_at        TEXT NOT NULL,
    CHECK (
      (target_user_id IS NOT NULL AND target_group_id IS NULL)
      OR (target_user_id IS NULL AND target_group_id IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_manager_scope_mgr
  ON manager_scope(team_id, manager_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_manager_scope_user
  ON manager_scope(team_id, manager_user_id, target_user_id)
  WHERE target_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_manager_scope_group
  ON manager_scope(team_id, manager_user_id, target_group_id)
  WHERE target_group_id IS NOT NULL;

-- Invite: token_hash for /join lookup; raw token so owners can re-copy the URL.
CREATE TABLE IF NOT EXISTS invites (
    id          TEXT PRIMARY KEY,
    team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    token       TEXT,                          -- plaintext for owner re-display; NULL when revoked/legacy
    created_by  TEXT NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL,
    expires_at  TEXT,
    max_uses    INTEGER,
    uses        INTEGER NOT NULL DEFAULT 0,
    revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_invites_team ON invites(team_id);

-- ── telemetry ─────────────────────────────────────────────────────────────
-- The only metrics table. One row per (team, user, device, hour, provider,
-- model, project). Counters are absolute for the bucket, so a replayed batch
-- overwrites rather than double-counts.
CREATE TABLE IF NOT EXISTS metric_hourly (
    team_id             TEXT NOT NULL,
    user_id             TEXT NOT NULL,
    device_id           TEXT NOT NULL,
    hour_utc            TEXT NOT NULL,          -- 'YYYY-MM-DDTHH'
    provider            TEXT NOT NULL,
    model               TEXT NOT NULL DEFAULT '',
    project_key         TEXT NOT NULL DEFAULT '',  -- basename or opaque hash
    tokens_in           INTEGER NOT NULL DEFAULT 0,
    tokens_out          INTEGER NOT NULL DEFAULT 0,
    tokens_cache_read   INTEGER NOT NULL DEFAULT 0,
    tokens_cache_write  INTEGER NOT NULL DEFAULT 0,
    tokens_reasoning    INTEGER NOT NULL DEFAULT 0,  -- Codex reports these
    cost_usd            REAL    NOT NULL DEFAULT 0,
    cost_incomplete     INTEGER NOT NULL DEFAULT 1 CHECK (cost_incomplete IN (0, 1)),
    active_ms           INTEGER NOT NULL DEFAULT 0,
    after_hours_ms      INTEGER NOT NULL DEFAULT 0,
    weekend_ms          INTEGER NOT NULL DEFAULT 0,
    sessions            INTEGER NOT NULL DEFAULT 0,
    turns               INTEGER NOT NULL DEFAULT 0,
    tool_calls          INTEGER NOT NULL DEFAULT 0,
    peak_concurrent     INTEGER NOT NULL DEFAULT 0,
    -- Tool mix. Provider tool *names* only, folded into a fixed taxonomy by
    -- the desktop scanner; unknown names land in tool_other so these columns
    -- re-sum to tool_calls.
    tool_bash           INTEGER NOT NULL DEFAULT 0,
    tool_edit           INTEGER NOT NULL DEFAULT 0,
    tool_read           INTEGER NOT NULL DEFAULT 0,
    tool_search         INTEGER NOT NULL DEFAULT 0,
    tool_web            INTEGER NOT NULL DEFAULT 0,
    tool_agent          INTEGER NOT NULL DEFAULT 0,
    tool_mcp            INTEGER NOT NULL DEFAULT 0,
    tool_other          INTEGER NOT NULL DEFAULT 0,
    -- Failed tool calls, and the number whose outcome was observable at all.
    -- Codex reports no general tool-outcome flag, so tools_measured is NOT the
    -- same as tool_calls and the error rate must divide by tools_measured.
    tool_errors         INTEGER NOT NULL DEFAULT 0,
    tools_measured      INTEGER NOT NULL DEFAULT 0,
    -- Output. files_changed counts change *operations*, which stay correct when
    -- buckets are summed; a distinct-file count would not.
    files_changed       INTEGER NOT NULL DEFAULT 0,
    lines_added         INTEGER NOT NULL DEFAULT 0,
    lines_removed       INTEGER NOT NULL DEFAULT 0,
    -- Approval wait / blocked time (desktop tracks request → response wall clock).
    approval_requests   INTEGER NOT NULL DEFAULT 0,
    approval_wait_ms    INTEGER NOT NULL DEFAULT 0,
    local_hour          INTEGER NOT NULL DEFAULT 0,  -- 0-23, member local time
    local_dow           INTEGER NOT NULL DEFAULT 0,  -- 0=Mon … 6=Sun
    updated_at          TEXT NOT NULL,
    PRIMARY KEY (team_id, user_id, device_id, hour_utc, provider, model, project_key)
);

-- Org policy plane: null = unrestricted; empty restriction arrays = deny all.
CREATE TABLE IF NOT EXISTS team_policies (
    team_id                  TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
    allowed_providers        TEXT,
    allowed_models           TEXT,
    allowed_modes            TEXT,
    allowed_efforts          TEXT,
    default_permission_mode  TEXT,
    mcp_allowlist            TEXT,
    spend_hard_stop_usd      REAL,
    updated_by               TEXT REFERENCES users(id),
    updated_at               TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manager_policies (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    manager_user_id TEXT NOT NULL REFERENCES users(id),
    allowed_providers TEXT,
    allowed_models TEXT,
    allowed_modes TEXT,
    allowed_efforts TEXT,
    updated_by TEXT REFERENCES users(id),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (team_id, manager_user_id)
);
CREATE INDEX IF NOT EXISTS idx_metric_team_hour ON metric_hourly(team_id, hour_utc);
CREATE INDEX IF NOT EXISTS idx_metric_team_user_hour ON metric_hourly(team_id, user_id, hour_utc);

-- Idempotency ledger for upload batches. A retried batch id is accepted and
-- acknowledged without re-applying, so the desktop can retry freely.
CREATE TABLE IF NOT EXISTS upload_receipts (
    device_id    TEXT NOT NULL,
    batch_id     TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    accepted_at  TEXT NOT NULL,
    bucket_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, batch_id)
);

-- ── budgets ───────────────────────────────────────────────────────────────
-- One monthly spend target per team. Forecasting is done at read time from
-- metric_hourly, so nothing here needs to be kept in sync with the metrics.
CREATE TABLE IF NOT EXISTS team_budgets (
    team_id      TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
    monthly_usd  REAL NOT NULL,
    -- Comma-separated percentages of budget at which to fire an alert.
    thresholds   TEXT NOT NULL DEFAULT '80,100',
    -- Optional outbound webhook (Slack-compatible JSON body). Never rendered
    -- back to the client in full — it can contain a secret path.
    webhook_url  TEXT,
    updated_by   TEXT NOT NULL REFERENCES users(id),
    updated_at   TEXT NOT NULL
);

-- Ledger so a crossed threshold fires once per month, not once per cron tick.
CREATE TABLE IF NOT EXISTS budget_alerts (
    team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    month       TEXT NOT NULL,      -- 'YYYY-MM'
    threshold   INTEGER NOT NULL,   -- the percentage that was crossed
    fired_at    TEXT NOT NULL,
    spend_usd   REAL NOT NULL,
    delivered   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (team_id, month, threshold)
);

-- ── audit ─────────────────────────────────────────────────────────────────
-- Who did what to the team. Membership, roles, invites, budgets and exports —
-- the questions a security review asks. Never contains telemetry.
CREATE TABLE IF NOT EXISTS audit_log (
    id             TEXT PRIMARY KEY,
    team_id        TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    actor_user_id  TEXT,            -- null once the actor's account is deleted
    action         TEXT NOT NULL,   -- 'member.role_changed', 'invite.created', …
    target         TEXT,            -- user id, invite id, or a short label
    detail         TEXT,            -- short human-readable summary, no content
    created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_team_time ON audit_log(team_id, created_at DESC);

-- Per (user, device) sync freshness, so dashboards can show "last seen".
CREATE TABLE IF NOT EXISTS sync_state (
    user_id           TEXT NOT NULL,
    device_id         TEXT NOT NULL,
    last_upload_at    TEXT NOT NULL,
    last_bucket_hour  TEXT,
    PRIMARY KEY (user_id, device_id)
);

-- ── leaderboard (optional, owner-enabled) ─────────────────────────────────
-- Weekly PR shipping vs token usage. Managers/owners only. See design
-- docs/superpowers/specs/2026-08-06-teams-leaderboard-design.md
CREATE TABLE IF NOT EXISTS team_leaderboard_settings (
    team_id                 TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
    enabled                 INTEGER NOT NULL DEFAULT 0,
    github_installation_id  TEXT,
    github_org_login        TEXT,
    threshold_small_max     INTEGER NOT NULL DEFAULT 100,
    threshold_medium_max    INTEGER NOT NULL DEFAULT 500,
    weight_small            REAL NOT NULL DEFAULT 1,
    weight_medium           REAL NOT NULL DEFAULT 2,
    weight_large            REAL NOT NULL DEFAULT 4,
    weight_merge            REAL NOT NULL DEFAULT 0.5,
    last_sync_at            TEXT,
    last_sync_error         TEXT,
    sync_cursor             TEXT,
    updated_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_leaderboard_repos (
    team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    repo_full_name  TEXT NOT NULL,
    added_at        TEXT NOT NULL,
    PRIMARY KEY (team_id, repo_full_name)
);
CREATE INDEX IF NOT EXISTS idx_leaderboard_repos_team ON team_leaderboard_repos(team_id);

-- No PR titles/bodies — numbers and ids only.
CREATE TABLE IF NOT EXISTS github_prs (
    id                  TEXT PRIMARY KEY,
    team_id             TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    repo_full_name      TEXT NOT NULL,
    pr_number           INTEGER NOT NULL,
    author_github_id    TEXT NOT NULL,
    author_login        TEXT NOT NULL DEFAULT '',
    opened_at           TEXT NOT NULL,
    merged_at           TEXT,
    closed_at           TEXT,
    additions           INTEGER NOT NULL DEFAULT 0,
    deletions           INTEGER NOT NULL DEFAULT 0,
    size_tier           TEXT NOT NULL CHECK (size_tier IN ('small', 'medium', 'large')),
    -- NenuAI: Project Size → complexity points (XS=1…XXL=32). NULL = use size_tier weights.
    complexity_points   INTEGER,
    is_bot              INTEGER NOT NULL DEFAULT 0,
    updated_at_github   TEXT,
    synced_at           TEXT NOT NULL,
    UNIQUE (team_id, repo_full_name, pr_number)
);
CREATE INDEX IF NOT EXISTS idx_github_prs_team_opened ON github_prs(team_id, opened_at);
CREATE INDEX IF NOT EXISTS idx_github_prs_team_merged ON github_prs(team_id, merged_at);
CREATE INDEX IF NOT EXISTS idx_github_prs_author ON github_prs(team_id, author_github_id);

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
    usage_json TEXT,
    plan TEXT,
    UNIQUE (team_id, provider, identity_hash)
);
CREATE INDEX IF NOT EXISTS idx_provider_accounts_pool ON provider_accounts(team_id, provider, enabled, lease_expires_at);
