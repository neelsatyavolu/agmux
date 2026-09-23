-- 016_tasks.sql
-- Add tasks table for Task View / Worktree Mode

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    base_branch TEXT NOT NULL DEFAULT 'main',
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress', 'done', 'blocked')),
    prompt TEXT,
    linked_pr_number INTEGER,
    linked_pr_url TEXT,
    linked_issues TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_branch_name_project ON tasks(project_id, branch_name);
