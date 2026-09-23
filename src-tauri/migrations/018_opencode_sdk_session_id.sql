-- Add opencode_session_id column for OpenCode SDK chat sessions.
ALTER TABLE threads ADD COLUMN opencode_session_id TEXT;
