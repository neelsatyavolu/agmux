-- Add 'Cursor' to provider and 'cursor-sdk' to interaction_mode.
-- SQLite requires table recreation to modify CHECK constraints.

CREATE TEMP TABLE xanom_024_agent_logs_backup AS
SELECT id, thread_id, direction, content, timestamp, log_type
FROM agent_logs;

CREATE TEMP TABLE xanom_024_thread_journal_entries_backup AS
SELECT
    id, thread_id, kind, title, content, source, confidence, created_by,
    created_at, updated_at, is_archived
FROM thread_journal_entries;

CREATE TEMP TABLE xanom_024_prompt_logs_backup AS
SELECT
    id, thread_id, raw_prompt, optimized_prompt, user_approved_optimization,
    context_fetched, context_score, context_reason, context_mode,
    final_prompt_sent, timestamp
FROM prompt_logs;

CREATE TABLE threads_new (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('ClaudeCode', 'Codex', 'Droid', 'OpenCode', 'MLX', 'Grok', 'Cursor')),
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
    interaction_mode TEXT NOT NULL DEFAULT 'pty' CHECK (interaction_mode IN ('pty', 'sdk', 'opencode-sdk', 'mlx', 'grok-sdk', 'cursor-sdk')),
    sdk_session_id TEXT,
    forked_from_thread_id TEXT,
    forked_at_message_index INTEGER,
    lines_added INTEGER NOT NULL DEFAULT 0,
    lines_removed INTEGER NOT NULL DEFAULT 0,
    files_changed INTEGER NOT NULL DEFAULT 0,
    opencode_session_id TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

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

DROP TABLE threads;
ALTER TABLE threads_new RENAME TO threads;

INSERT INTO agent_logs (id, thread_id, direction, content, timestamp, log_type)
SELECT id, thread_id, direction, content, timestamp, log_type
FROM xanom_024_agent_logs_backup;

INSERT INTO thread_journal_entries (
    id, thread_id, kind, title, content, source, confidence, created_by,
    created_at, updated_at, is_archived
)
SELECT
    id, thread_id, kind, title, content, source, confidence, created_by,
    created_at, updated_at, is_archived
FROM xanom_024_thread_journal_entries_backup;

INSERT INTO prompt_logs (
    id, thread_id, raw_prompt, optimized_prompt, user_approved_optimization,
    context_fetched, context_score, context_reason, context_mode,
    final_prompt_sent, timestamp
)
SELECT
    id, thread_id, raw_prompt, optimized_prompt, user_approved_optimization,
    context_fetched, context_score, context_reason, context_mode,
    final_prompt_sent, timestamp
FROM xanom_024_prompt_logs_backup;

DROP TABLE xanom_024_agent_logs_backup;
DROP TABLE xanom_024_thread_journal_entries_backup;
DROP TABLE xanom_024_prompt_logs_backup;

CREATE INDEX IF NOT EXISTS idx_threads_project_id ON threads(project_id);
