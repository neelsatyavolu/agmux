-- Active agent time per usage row (gap-capped, idle excluded).
-- Populated on the next Usage-panel scan of provider logs.
ALTER TABLE session_usage ADD COLUMN active_ms INTEGER NOT NULL DEFAULT 0;
