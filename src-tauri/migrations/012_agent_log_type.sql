-- Add log_type column to distinguish text, tool_use, and tool_result entries.
ALTER TABLE agent_logs ADD COLUMN log_type TEXT NOT NULL DEFAULT 'text';
