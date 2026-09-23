-- 022_tasks_multi_repo.sql
-- Add multi_repo flag for tasks that span sibling worktrees under a shared
-- parent dir. When set, agents created via `create_task_agent` are pinned to
-- the parent of `worktree_path` instead of the worktree itself, so they can
-- see all sibling repos checked out for the same task.

ALTER TABLE tasks ADD COLUMN multi_repo INTEGER NOT NULL DEFAULT 0;
