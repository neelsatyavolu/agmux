CREATE TABLE IF NOT EXISTS thread_journal_entries (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('Decision', 'Convention', 'CompletedWork', 'KnownIssue', 'Note', 'Pin')),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('User', 'AgentParsed', 'System')),
    confidence REAL,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_archived INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS prompt_logs (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL,
    raw_prompt TEXT NOT NULL,
    optimized_prompt TEXT,
    user_approved_optimization INTEGER NOT NULL DEFAULT 0,
    context_fetched INTEGER NOT NULL DEFAULT 0,
    context_score REAL,
    context_reason TEXT,
    context_mode TEXT,
    final_prompt_sent TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_journal_thread_id ON thread_journal_entries(thread_id);
CREATE INDEX IF NOT EXISTS idx_prompt_logs_thread_id ON prompt_logs(thread_id);
