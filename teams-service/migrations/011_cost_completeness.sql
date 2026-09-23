-- Older uploads and retained rows have unknown cost completeness.
ALTER TABLE metric_hourly ADD COLUMN cost_incomplete INTEGER NOT NULL DEFAULT 1 CHECK (cost_incomplete IN (0, 1));
