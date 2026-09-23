-- Optional PR leaderboard (owner-enabled). Additive only.
-- Apply: wrangler d1 execute agmux-teams --local|--remote --file=./migrations/005_leaderboard.sql

CREATE TABLE IF NOT EXISTS team_leaderboard_settings (
    team_id                 TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
    enabled                 INTEGER NOT NULL DEFAULT 0,
    github_installation_id  TEXT,
    github_org_login        TEXT,
    threshold_small_max     INTEGER NOT NULL DEFAULT 100,
    threshold_medium_max    INTEGER NOT NULL DEFAULT 500,
    weight_small            REAL NOT NULL DEFAULT 1,
    weight_medium           REAL NOT NULL DEFAULT 2,
    weight_large            REAL NOT NULL DEFAULT 4,
    weight_merge            REAL NOT NULL DEFAULT 0.5,
    last_sync_at            TEXT,
    last_sync_error         TEXT,
    sync_cursor             TEXT,
    updated_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_leaderboard_repos (
    team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    repo_full_name  TEXT NOT NULL,
    added_at        TEXT NOT NULL,
    PRIMARY KEY (team_id, repo_full_name)
);
CREATE INDEX IF NOT EXISTS idx_leaderboard_repos_team ON team_leaderboard_repos(team_id);

CREATE TABLE IF NOT EXISTS github_prs (
    id                  TEXT PRIMARY KEY,
    team_id             TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    repo_full_name      TEXT NOT NULL,
    pr_number           INTEGER NOT NULL,
    author_github_id    TEXT NOT NULL,
    author_login        TEXT NOT NULL DEFAULT '',
    opened_at           TEXT NOT NULL,
    merged_at           TEXT,
    closed_at           TEXT,
    additions           INTEGER NOT NULL DEFAULT 0,
    deletions           INTEGER NOT NULL DEFAULT 0,
    size_tier           TEXT NOT NULL CHECK (size_tier IN ('small', 'medium', 'large')),
    is_bot              INTEGER NOT NULL DEFAULT 0,
    updated_at_github   TEXT,
    synced_at           TEXT NOT NULL,
    UNIQUE (team_id, repo_full_name, pr_number)
);
CREATE INDEX IF NOT EXISTS idx_github_prs_team_opened ON github_prs(team_id, opened_at);
CREATE INDEX IF NOT EXISTS idx_github_prs_team_merged ON github_prs(team_id, merged_at);
CREATE INDEX IF NOT EXISTS idx_github_prs_author ON github_prs(team_id, author_github_id);
