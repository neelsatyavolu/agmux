-- Profile photo URL from GitHub or Google OAuth (https only).
-- Existing GitHub users still resolve via identities.provider_user_id → avatars.githubusercontent.com.
ALTER TABLE users ADD COLUMN avatar_url TEXT;
