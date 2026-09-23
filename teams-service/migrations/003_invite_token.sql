-- Persist the invite token so owners can re-copy the link after leaving settings.
-- token_hash stays the lookup key for /join/:token; raw token is owner-only API.
--
-- Fresh DBs get this from schema.sql. Existing deployments:
--
--   npx wrangler d1 execute agmux-teams --local  --file=./migrations/003_invite_token.sql
--   npx wrangler d1 execute agmux-teams --remote --file=./migrations/003_invite_token.sql
--
-- Pre-existing rows keep token NULL (masked UI until regenerate).

ALTER TABLE invites ADD COLUMN token TEXT;
