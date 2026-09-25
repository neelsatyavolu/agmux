-- Distinct top-level sessions started in each bucket. NULL means the row came
-- from a desktop build that did not report it (unknown, not zero).
ALTER TABLE metric_hourly ADD COLUMN sessions_started INTEGER;
