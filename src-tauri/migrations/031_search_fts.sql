-- Message-level full-text search (FTS5 + BM25).
-- Indexes user/agent messages, turn prompts/summaries, thread names, journals.
-- Content is maintained by Rust (`search` module); this migration only creates schema.

CREATE VIRTUAL TABLE IF NOT EXISTS search_messages USING fts5(
    body,
    thread_id UNINDEXED,
    project_id UNINDEXED,
    source UNINDEXED,
    role UNINDEXED,
    external_id UNINDEXED,
    tokenize = 'porter unicode61 remove_diacritics 2'
);

-- Per-source fingerprint so reindex skips unchanged files / DB snapshots.
CREATE TABLE IF NOT EXISTS search_index_state (
    source_key TEXT PRIMARY KEY NOT NULL,
    mtime_ms INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    fingerprint TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_search_index_state_updated
    ON search_index_state(updated_at);
