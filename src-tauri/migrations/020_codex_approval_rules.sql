-- 020_codex_approval_rules.sql
-- Per-workspace allowlist of Codex shell commands that auto-approve.
-- Patterns use shell-style globs (e.g. "git push *", "npm run *").

CREATE TABLE IF NOT EXISTS codex_approval_rules (
    id TEXT PRIMARY KEY NOT NULL,
    work_dir TEXT NOT NULL,
    pattern TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_codex_approval_rules_work_dir
    ON codex_approval_rules(work_dir);

CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_approval_rules_unique
    ON codex_approval_rules(work_dir, pattern);
