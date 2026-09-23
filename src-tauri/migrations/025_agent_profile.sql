-- Optional agent profile for Claude SDK threads.
-- NULL / 'code' = normal Claude Code agent; 'cowork' = knowledge-work prompt + tool allowlist.
ALTER TABLE threads ADD COLUMN agent_profile TEXT;
