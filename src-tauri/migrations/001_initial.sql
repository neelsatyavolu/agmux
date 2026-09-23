CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    repo_path TEXT NOT NULL UNIQUE,
    conventions TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('ClaudeCode', 'Codex')),
    run_mode TEXT NOT NULL DEFAULT 'Local' CHECK (run_mode IN ('Local', 'Cloud')),
    work_mode TEXT NOT NULL DEFAULT 'DirectRepo' CHECK (work_mode IN ('DirectRepo', 'Worktree')),
    work_dir TEXT NOT NULL,
    state_dir TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Idle',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_active TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_logs (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('Input', 'Output')),
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_threads_project_id ON threads(project_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_thread_id ON agent_logs(thread_id);
