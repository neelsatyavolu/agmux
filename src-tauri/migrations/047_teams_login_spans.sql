-- Which Claude/Codex login each agmux session ran under, from the moment agmux
-- started, resumed or switched it. A session can move to another login
-- (automatic switching), so each row is the start of a span: an event belongs
-- to the latest row of its session at or before the event's time.
-- `session_key` is the agmux thread id or the native session id the account
-- was bound under. `identity_hash` is the same opaque hash the team pool uses;
-- `label` is a Claude login's email, kept on this Mac and uploaded only when a
-- team owner turns on Shared Claude accounts. Never credentials.
CREATE TABLE IF NOT EXISTS teams_login_spans (
    provider      TEXT NOT NULL,
    session_key   TEXT NOT NULL,
    from_ms       INTEGER NOT NULL,
    identity_hash TEXT NOT NULL,
    label         TEXT,
    PRIMARY KEY (provider, session_key, from_ms)
);

-- Per-login counters and labels queued with each upload batch. NULL for
-- batches queued by an older build, which upload without them.
ALTER TABLE teams_upload_queue ADD COLUMN accounts_json TEXT;
