CREATE TABLE IF NOT EXISTS session_usage (
    thread_id             TEXT PRIMARY KEY,
    provider              TEXT NOT NULL,
    model                 TEXT,
    input_tokens          INTEGER NOT NULL DEFAULT 0,
    output_tokens         INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
    total_cost_usd        REAL NOT NULL DEFAULT 0.0,
    num_turns             INTEGER NOT NULL DEFAULT 0,
    captured_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_session_usage_provider_date
    ON session_usage(provider, captured_at);
