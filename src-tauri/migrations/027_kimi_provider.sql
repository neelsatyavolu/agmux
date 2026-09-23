-- Add 'Kimi' to the threads.provider CHECK constraint (replaces Factory Droid
-- as a first-class terminal provider). Keep 'Droid' in the allowlist so any
-- pre-existing rows still load, then rename them to Kimi.

-- SQLite requires table recreation to modify CHECK constraints.
-- Child tables with ON DELETE CASCADE FKs must be backed up first (same pattern
-- as 024_cursor_provider.sql).

CREATE TEMP TABLE xanom_027_agent_logs_backup AS
SELECT id, thread_id, direction, content, timestamp, log_type
FROM agent_logs;

CREATE TEMP TABLE xanom_027_thread_journal_entries_backup AS
SELECT
    id, thread_id, kind, title, content, source, confidence, created_by,
    created_at, updated_at, is_archived
FROM thread_journal_entries;

CREATE TEMP TABLE xanom_027_prompt_logs_backup AS
SELECT
    id, thread_id, raw_prompt, optimized_prompt, user_approved_optimization,
    context_fetched, context_score, context_reason, context_mode,
    final_prompt_sent, timestamp
FROM prompt_logs;

CREATE TEMP TABLE xanom_027_thread_turns_backup AS
SELECT
    id, thread_id, seq, prompt_text, status, started_at, ended_at,
    summary, summary_source, anchor_kind, anchor_ref, facts_json, created_at
FROM thread_turns;

CREATE TABLE threads_new (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN (
        'ClaudeCode', 'Codex', 'Droid', 'Kimi', 'OpenCode', 'MLX', 'Grok', 'Cursor'
    )),
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
    interaction_mode TEXT NOT NULL DEFAULT 'pty' CHECK (interaction_mode IN (
        'pty', 'sdk', 'opencode-sdk', 'mlx', 'grok-sdk', 'cursor-sdk'
    )),
    sdk_session_id TEXT,
    forked_from_thread_id TEXT,
    forked_at_message_index INTEGER,
    lines_added INTEGER NOT NULL DEFAULT 0,
    lines_removed INTEGER NOT NULL DEFAULT 0,
    files_changed INTEGER NOT NULL DEFAULT 0,
    opencode_session_id TEXT,
    agent_profile TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

INSERT INTO threads_new (
    id, project_id, name, provider, run_mode, work_mode, work_dir, state_dir,
    status, created_at, last_active, model, reasoning_effort, fast_mode,
    is_archived, worktree_branch, interaction_mode, sdk_session_id,
    forked_from_thread_id, forked_at_message_index,
    lines_added, lines_removed, files_changed, opencode_session_id, agent_profile
)
SELECT
    id, project_id, name,
    CASE WHEN provider = 'Droid' THEN 'Kimi' ELSE provider END,
    run_mode, work_mode, work_dir, state_dir,
    status, created_at, last_active, model, reasoning_effort, fast_mode,
    is_archived, worktree_branch, interaction_mode, sdk_session_id,
    forked_from_thread_id, forked_at_message_index,
    lines_added, lines_removed, files_changed, opencode_session_id, agent_profile
FROM threads;

DROP TABLE threads;
ALTER TABLE threads_new RENAME TO threads;

-- When PRAGMA foreign_keys is OFF (sqlx migrator), DROP TABLE threads leaves
-- child rows in place. Clear them before restoring from the temp backups so
-- re-insert does not hit UNIQUE constraint failures.
DELETE FROM agent_logs;
DELETE FROM thread_journal_entries;
DELETE FROM prompt_logs;
DELETE FROM thread_turns;

INSERT INTO agent_logs (id, thread_id, direction, content, timestamp, log_type)
SELECT id, thread_id, direction, content, timestamp, log_type
FROM xanom_027_agent_logs_backup;

INSERT INTO thread_journal_entries (
    id, thread_id, kind, title, content, source, confidence, created_by,
    created_at, updated_at, is_archived
)
SELECT
    id, thread_id, kind, title, content, source, confidence, created_by,
    created_at, updated_at, is_archived
FROM xanom_027_thread_journal_entries_backup;

INSERT INTO prompt_logs (
    id, thread_id, raw_prompt, optimized_prompt, user_approved_optimization,
    context_fetched, context_score, context_reason, context_mode,
    final_prompt_sent, timestamp
)
SELECT
    id, thread_id, raw_prompt, optimized_prompt, user_approved_optimization,
    context_fetched, context_score, context_reason, context_mode,
    final_prompt_sent, timestamp
FROM xanom_027_prompt_logs_backup;

INSERT INTO thread_turns (
    id, thread_id, seq, prompt_text, status, started_at, ended_at,
    summary, summary_source, anchor_kind, anchor_ref, facts_json, created_at
)
SELECT
    id, thread_id, seq, prompt_text, status, started_at, ended_at,
    summary, summary_source, anchor_kind, anchor_ref, facts_json, created_at
FROM xanom_027_thread_turns_backup;

DROP TABLE xanom_027_agent_logs_backup;
DROP TABLE xanom_027_thread_journal_entries_backup;
DROP TABLE xanom_027_prompt_logs_backup;
DROP TABLE xanom_027_thread_turns_backup;

CREATE INDEX IF NOT EXISTS idx_threads_project_id ON threads(project_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_thread_id ON agent_logs(thread_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_thread_timestamp ON agent_logs(thread_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_journal_thread_id ON thread_journal_entries(thread_id);
CREATE INDEX IF NOT EXISTS idx_prompt_logs_thread_id ON prompt_logs(thread_id);
CREATE INDEX IF NOT EXISTS idx_thread_turns_thread_started ON thread_turns(thread_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_thread_turns_thread_status ON thread_turns(thread_id, status);
