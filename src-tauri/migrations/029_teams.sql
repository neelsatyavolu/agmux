-- agmux Teams — local state for the org analytics uploader.
--
-- Nothing here stores prompt text, replies, diffs or paths. `project_key` is a
-- basename or an opaque hash, and the queued payload is counters only.
-- The device token itself is NOT in this database; see teams::secret_store.

-- Linked account (single row, id = 1).
CREATE TABLE IF NOT EXISTS teams_account (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    user_id       TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    email         TEXT,
    handle        TEXT,
    avatar_color  TEXT NOT NULL DEFAULT '#60a5fa',
    device_id     TEXT NOT NULL,
    linked_at     TEXT NOT NULL
);

-- Teams this device uploads for. Mirrors the server; refreshed on sync.
CREATE TABLE IF NOT EXISTS teams_memberships (
    team_id    TEXT PRIMARY KEY,
    slug       TEXT NOT NULL,
    name       TEXT NOT NULL,
    role       TEXT NOT NULL,
    joined_at  TEXT,
    active     INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

-- Pending upload batches. A batch survives restarts and is retried with
-- backoff; the server dedupes on (device_id, batch_id) so retries are safe.
CREATE TABLE IF NOT EXISTS teams_upload_queue (
    batch_id        TEXT PRIMARY KEY,
    payload_json    TEXT NOT NULL,
    bucket_count    INTEGER NOT NULL DEFAULT 0,
    byte_size       INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_teams_queue_next
    ON teams_upload_queue(next_attempt_at);

-- Recent upload outcomes, for the desktop Sync pane's history table.
CREATE TABLE IF NOT EXISTS teams_upload_log (
    id          TEXT PRIMARY KEY,
    at          TEXT NOT NULL,
    sessions    INTEGER NOT NULL DEFAULT 0,
    tokens      INTEGER NOT NULL DEFAULT 0,
    byte_size   INTEGER NOT NULL DEFAULT 0,
    result      TEXT NOT NULL,
    detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_teams_upload_log_at
    ON teams_upload_log(at DESC);

-- Uploader status (single row, id = 1).
CREATE TABLE IF NOT EXISTS teams_sync_state (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    last_upload_at    TEXT,
    last_attempt_at   TEXT,
    next_attempt_at   TEXT,
    last_built_hour   TEXT,
    backoff_step      INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT
);
