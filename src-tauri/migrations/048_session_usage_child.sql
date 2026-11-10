-- Subagent and workflow agent transcripts (Claude `subagents/`, Codex child
-- threads) keep their own Usage rows so their tokens and models count, but
-- they are not sessions a person started.
ALTER TABLE session_usage ADD COLUMN is_child INTEGER NOT NULL DEFAULT 0;
