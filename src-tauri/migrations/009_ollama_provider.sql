-- Add 'Ollama' to the provider CHECK constraint on the threads table.
-- SQLite requires table recreation to modify CHECK constraints.

-- 1. Create new table with updated constraint
CREATE TABLE threads_new (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('ClaudeCode', 'Codex', 'Ollama')),
    run_mode TEXT NOT NULL DEFAULT 'Local' CHECK (run_mode IN ('Local', 'Cloud')),
    work_mode TEXT NOT NULL DEFAULT 'DirectRepo' CHECK (work_mode IN ('DirectRepo', 'Worktree')),
    work_dir TEXT NOT NULL,
    state_dir TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Idle',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_active TEXT NOT NULL DEFAULT (datetime('now')),
    model TEXT,
    reasoning_effort TEXT,
    fast_mode INTEGER NOT NULL DEFAULT 0,
    is_archived INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 2. Copy data
INSERT INTO threads_new SELECT * FROM threads;

-- 3. Drop old table and rename
DROP TABLE threads;
ALTER TABLE threads_new RENAME TO threads;

-- 4. Recreate indexes
CREATE INDEX IF NOT EXISTS idx_threads_project_id ON threads(project_id);
