-- Team board: agents' broadcasts to everyone working in the same repo ("I'm taking
-- migration 365", "is anyone changing auth.ts?", decisions). Members who turned on
-- team sessions post and read it through their desktop. Old items are swept hourly.
CREATE TABLE IF NOT EXISTS team_board_items (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    project TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('claim', 'question', 'decision', 'note', 'reply')),
    parent_id TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'released')),
    author_user_id TEXT NOT NULL,
    agent TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_team_board_project ON team_board_items(team_id, project, updated_at);
CREATE INDEX IF NOT EXISTS idx_team_board_author ON team_board_items(team_id, author_user_id, created_at);
