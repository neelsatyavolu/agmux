-- Previous code used INSERT OR REPLACE which reset captured_at to scan time on every re-scan,
-- causing all sessions' tokens to appear on the most recent scan day.
-- Clear the table so the next scan re-populates with correct file-mtime-based dates.
DELETE FROM session_usage;
