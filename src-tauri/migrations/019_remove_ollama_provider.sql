-- Remove 'Ollama' from the provider CHECK constraint on the threads table.
-- SQLite requires table recreation to modify CHECK constraints.
--
-- Any existing rows with provider='Ollama' must be removed from the live
-- table since the new CHECK constraint would reject them during the data
-- copy. To avoid permanent data loss, we first snapshot those rows (and
-- their agent_logs, which would otherwise cascade-delete) into archival
-- tables that survive the migration. Users with no Ollama threads see
-- empty backup tables; users who had Ollama sessions can recover them
-- via direct sqlite3 access at ~/.xanom/xanom.db.

-- 0a. Snapshot Ollama threads into an archival table BEFORE delete.
--     CREATE TABLE ... AS SELECT preserves the row data verbatim. The
--     archival table has no CHECK constraints so it is unaffected by the
--     provider-allowlist change below.
CREATE TABLE IF NOT EXISTS deprecated_ollama_threads AS
    SELECT * FROM threads WHERE 0;
INSERT INTO deprecated_ollama_threads
    SELECT * FROM threads WHERE provider = 'Ollama';

-- 0b. Snapshot agent_logs for those threads — foreign_keys=ON would
--     otherwise cascade-delete them when we DROP the live threads table.
CREATE TABLE IF NOT EXISTS deprecated_ollama_agent_logs AS
    SELECT * FROM agent_logs WHERE 0;
INSERT INTO deprecated_ollama_agent_logs
    SELECT * FROM agent_logs
    WHERE thread_id IN (SELECT id FROM deprecated_ollama_threads);

-- 0c. Now safe to drop Ollama rows from the live table — the CHECK
--     constraint on threads_new (below) would otherwise reject them
--     during the data copy.
DELETE FROM threads WHERE provider = 'Ollama';

-- 1. Create new table without 'Ollama' in the CHECK constraint
CREATE TABLE threads_new (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('ClaudeCode', 'Codex', 'Droid', 'OpenCode')),
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
