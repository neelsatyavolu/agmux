-- Member IANA timezone (reported by the desktop on metrics upload).
-- After-hours / weekend / heatmap local hours are classified client-side in
-- this zone; we only store the name for display and honest labeling.
-- Additive only — never alter existing columns (see teams D1 migration rules).

ALTER TABLE users ADD COLUMN timezone TEXT;
ALTER TABLE users ADD COLUMN timezone_updated_at TEXT;
