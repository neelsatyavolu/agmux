-- Add fork lineage columns to threads
ALTER TABLE threads ADD COLUMN forked_from_thread_id TEXT;
ALTER TABLE threads ADD COLUMN forked_at_message_index INTEGER;
