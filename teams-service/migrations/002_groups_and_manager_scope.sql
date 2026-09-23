-- Groups + per-manager analytics scope.
--
-- Fresh DBs get these from schema.sql. Existing deployments apply this file:
--
--   npx wrangler d1 execute agmux-teams --local  --file=./migrations/002_groups_and_manager_scope.sql
--   npx wrangler d1 execute agmux-teams --remote --file=./migrations/002_groups_and_manager_scope.sql
--
-- Semantics (enforced in app code, not CHECK constraints alone):
--   * Owner always sees the whole team.
--   * Manager with zero manager_scope rows sees the whole team (default).
--   * Manager with one or more rows sees the union of those people + group
--     members, plus themselves. Empty custom scope is rejected by the API.
--   * Groups are reusable labels; a manager can be assigned groups and/or
--     individual people freely.

CREATE TABLE IF NOT EXISTS team_groups (
    id          TEXT PRIMARY KEY,
    team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE (team_id, name)
);
CREATE INDEX IF NOT EXISTS idx_team_groups_team ON team_groups(team_id);

CREATE TABLE IF NOT EXISTS team_group_members (
    group_id  TEXT NOT NULL REFERENCES team_groups(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_at  TEXT NOT NULL,
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_group_members_user ON team_group_members(user_id);

-- Who a manager can see analytics for. No rows ⇒ entire team.
-- Exactly one of target_user_id / target_group_id is set per row.
CREATE TABLE IF NOT EXISTS manager_scope (
    id                TEXT PRIMARY KEY,
    team_id           TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    manager_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
    target_group_id   TEXT REFERENCES team_groups(id) ON DELETE CASCADE,
    created_at        TEXT NOT NULL,
    CHECK (
      (target_user_id IS NOT NULL AND target_group_id IS NULL)
      OR (target_user_id IS NULL AND target_group_id IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_manager_scope_mgr
  ON manager_scope(team_id, manager_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_manager_scope_user
  ON manager_scope(team_id, manager_user_id, target_user_id)
  WHERE target_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_manager_scope_group
  ON manager_scope(team_id, manager_user_id, target_group_id)
  WHERE target_group_id IS NOT NULL;
