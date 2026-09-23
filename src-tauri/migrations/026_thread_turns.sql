-- Session timeline turn ledger (one row per user→agent cycle).
CREATE TABLE IF NOT EXISTS thread_turns (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    prompt_text TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    summary TEXT,
    summary_source TEXT NOT NULL DEFAULT 'none',
    anchor_kind TEXT NOT NULL,
    anchor_ref TEXT NOT NULL,
    facts_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
    UNIQUE (thread_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_thread_turns_thread_started
    ON thread_turns(thread_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_thread_turns_thread_status
    ON thread_turns(thread_id, status);
