-- Preserve legacy empty allowlists as unrestricted before adopting [] = deny all.
ALTER TABLE team_policies ADD COLUMN allowed_modes TEXT;
ALTER TABLE team_policies ADD COLUMN allowed_efforts TEXT;
UPDATE team_policies SET allowed_providers = NULL WHERE json_valid(allowed_providers) AND json_array_length(allowed_providers) = 0;
UPDATE team_policies SET allowed_models = NULL WHERE json_valid(allowed_models) AND json_array_length(allowed_models) = 0;
CREATE TABLE IF NOT EXISTS manager_policies (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    manager_user_id TEXT NOT NULL REFERENCES users(id),
    allowed_providers TEXT,
    allowed_models TEXT,
    allowed_modes TEXT,
    allowed_efforts TEXT,
    updated_by TEXT REFERENCES users(id),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (team_id, manager_user_id)
);
