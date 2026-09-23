-- Provider-scoped creation provenance, independent of UI state and thread
-- deletion. Imported/resumed sessions must never be promoted to created here.
CREATE TABLE IF NOT EXISTS session_origins (
    provider TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    interaction_mode TEXT NOT NULL,
    created_in_agmux INTEGER NOT NULL CHECK (created_in_agmux IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (provider, owner_id)
);

CREATE TABLE IF NOT EXISTS session_origin_bindings (
    provider TEXT NOT NULL,
    session_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    bound_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (provider, session_id),
    FOREIGN KEY (provider, owner_id) REFERENCES session_origins(provider, owner_id)
);

-- Freeze the old scanner's thread-row fallback at upgrade time. Future blank
-- placeholders (including imports) must acquire explicit creation provenance.
CREATE TABLE IF NOT EXISTS session_legacy_thread_claims (
    provider TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    PRIMARY KEY (provider, owner_id)
);
INSERT OR IGNORE INTO session_legacy_thread_claims(provider, owner_id)
SELECT provider, id FROM threads;

CREATE TABLE IF NOT EXISTS session_origin_imports (
    source TEXT PRIMARY KEY NOT NULL,
    completed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- These are explicit creation records imported by migration 041's bridge,
-- unlike a generic thread row or an MCP config written while opening a session.
INSERT OR IGNORE INTO session_origins(provider, owner_id, interaction_mode, created_in_agmux)
SELECT 'ClaudeCode', session_id, 'pty', 1 FROM teams_created_claude_sessions;
INSERT OR IGNORE INTO session_origin_bindings(provider, session_id, owner_id)
SELECT 'ClaudeCode', session_id, session_id FROM teams_created_claude_sessions;
