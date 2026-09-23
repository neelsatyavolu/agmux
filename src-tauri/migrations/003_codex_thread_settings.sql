-- Add Codex-specific thread settings: model, reasoning effort, fast mode
ALTER TABLE threads ADD COLUMN model TEXT DEFAULT NULL;
ALTER TABLE threads ADD COLUMN reasoning_effort TEXT DEFAULT NULL;
ALTER TABLE threads ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0;
