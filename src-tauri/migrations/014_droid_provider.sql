-- Add 'Droid' to the provider CHECK constraint on the threads table.
-- SQLite requires table recreation to modify CHECK constraints.
--
-- Unlike migration 009, the current threads table has accumulated columns
-- from subsequent migrations (010 worktree_branch, 011 interaction_mode +
-- sdk_session_id, 013 forked_from_thread_id + forked_at_message_index).
-- We enumerate all columns explicitly in both the CREATE and the INSERT
-- to avoid silent data loss if the schema drifts further.

-- 1. Create new table with the updated CHECK constraint
CREATE TABLE threads_new (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('ClaudeCode', 'Codex', 'Ollama', 'Droid')),
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
    worktree_branch TEXT,
    interaction_mode TEXT NOT NULL DEFAULT 'pty',
    sdk_session_id TEXT,
    forked_from_thread_id TEXT,
    forked_at_message_index INTEGER,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 2. Copy data with explicit column list
INSERT INTO threads_new (
    id, project_id, name, provider, run_mode, work_mode, work_dir, state_dir,
    status, created_at, last_active, model, reasoning_effort, fast_mode,
    is_archived, worktree_branch, interaction_mode, sdk_session_id,
    forked_from_thread_id, forked_at_message_index
)
SELECT
    id, project_id, name, provider, run_mode, work_mode, work_dir, state_dir,
    status, created_at, last_active, model, reasoning_effort, fast_mode,
    is_archived, worktree_branch, interaction_mode, sdk_session_id,
    forked_from_thread_id, forked_at_message_index
FROM threads;

-- 3. Drop old table and rename
DROP TABLE threads;
ALTER TABLE threads_new RENAME TO threads;

-- 4. Recreate indexes
CREATE INDEX IF NOT EXISTS idx_threads_project_id ON threads(project_id);
