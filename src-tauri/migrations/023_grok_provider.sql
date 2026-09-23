-- Add 'Grok' to the provider CHECK constraint and 'grok-sdk' to the interaction_mode CHECK constraint.
-- SQLite requires table recreation to modify CHECK constraints.

-- 1. Create new table with the updated CHECK constraints
CREATE TABLE threads_new (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('ClaudeCode', 'Codex', 'Droid', 'OpenCode', 'MLX', 'Grok')),
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
    interaction_mode TEXT NOT NULL DEFAULT 'pty' CHECK (interaction_mode IN ('pty', 'sdk', 'opencode-sdk', 'mlx', 'grok-sdk')),
    sdk_session_id TEXT,
    forked_from_thread_id TEXT,
    forked_at_message_index INTEGER,
    lines_added INTEGER NOT NULL DEFAULT 0,
    lines_removed INTEGER NOT NULL DEFAULT 0,
    files_changed INTEGER NOT NULL DEFAULT 0,
    opencode_session_id TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 2. Copy data with explicit column list
INSERT INTO threads_new (
    id, project_id, name, provider, run_mode, work_mode, work_dir, state_dir,
    status, created_at, last_active, model, reasoning_effort, fast_mode,
    is_archived, worktree_branch, interaction_mode, sdk_session_id,
    forked_from_thread_id, forked_at_message_index,
    lines_added, lines_removed, files_changed, opencode_session_id
)
SELECT
    id, project_id, name, provider, run_mode, work_mode, work_dir, state_dir,
    status, created_at, last_active, model, reasoning_effort, fast_mode,
    is_archived, worktree_branch, interaction_mode, sdk_session_id,
    forked_from_thread_id, forked_at_message_index,
    lines_added, lines_removed, files_changed, opencode_session_id
FROM threads;

-- 3. Drop old table and rename
DROP TABLE threads;
ALTER TABLE threads_new RENAME TO threads;

-- 4. Recreate indexes
CREATE INDEX IF NOT EXISTS idx_threads_project_id ON threads(project_id);
