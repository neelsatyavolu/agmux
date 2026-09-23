-- 017_thread_diff_stats.sql
-- Per-thread cumulative line change counters for sidebar +/- display.

ALTER TABLE threads ADD COLUMN lines_added INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN lines_removed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN files_changed INTEGER NOT NULL DEFAULT 0;
