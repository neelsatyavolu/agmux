-- SDK interaction mode support.
-- interaction_mode: "pty" (default, terminal + JSONL chat) or "sdk" (Agent SDK via Node sidecar)
-- sdk_session_id: Claude's real session ID for SDK resume (null for PTY threads)
-- Validation done in Rust code (SQLite ALTER TABLE cannot add CHECK constraints).
ALTER TABLE threads ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'pty';
ALTER TABLE threads ADD COLUMN sdk_session_id TEXT;
