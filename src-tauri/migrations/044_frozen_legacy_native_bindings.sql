-- Resume pointers are mutable UI state, not creation evidence. Freeze only
-- the pre-existing legacy bindings; future identities require native proof.
CREATE TABLE IF NOT EXISTS session_legacy_bindings (
    provider TEXT NOT NULL,
    session_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    PRIMARY KEY (provider, session_id)
);
INSERT OR IGNORE INTO session_legacy_bindings(provider,session_id,owner_id)
SELECT t.provider,t.sdk_session_id,t.id FROM threads t JOIN session_legacy_thread_claims l
ON l.provider=t.provider AND l.owner_id=t.id
WHERE t.sdk_session_id IS NOT NULL AND trim(t.sdk_session_id)!='';
INSERT OR IGNORE INTO session_legacy_bindings(provider,session_id,owner_id)
SELECT t.provider,t.opencode_session_id,t.id FROM threads t JOIN session_legacy_thread_claims l
ON l.provider=t.provider AND l.owner_id=t.id
WHERE t.opencode_session_id IS NOT NULL AND trim(t.opencode_session_id)!='';
INSERT OR IGNORE INTO session_origin_imports(source,completed_at)
VALUES ('legacy-native-cutoff-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
UPDATE teams_sync_state SET agmux_sessions_only=0 WHERE id=1;
