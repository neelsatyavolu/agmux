-- A second app (agterm) reports to the same service. Existing rows are agmux.
ALTER TABLE installs ADD COLUMN app TEXT NOT NULL DEFAULT 'agmux';
ALTER TABLE daily_active ADD COLUMN app TEXT NOT NULL DEFAULT 'agmux';
CREATE INDEX IF NOT EXISTS idx_daily_active_app_day ON daily_active(app, day);
