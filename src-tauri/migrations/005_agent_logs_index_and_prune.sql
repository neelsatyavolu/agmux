-- Composite index for ordered queries on agent_logs (H1/M5 perf fix)
CREATE INDEX IF NOT EXISTS idx_agent_logs_thread_timestamp ON agent_logs(thread_id, timestamp DESC);
