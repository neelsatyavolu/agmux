//! Durable provider-scoped session provenance. Creation and import are recorded
//! at their backend entry points; exact native IDs are attached separately.
//! Never infer creation from cwd, launch config files, or opened tabs.

use sqlx::SqlitePool;

/// Preserve existing PTY identities once, before UI resume pointers can change.
/// The migration cutoff prevents a delayed retry from importing a new pointer.
pub async fn freeze_legacy_bindings(pool: &SqlitePool) -> Result<(), String> {
    let done: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_origin_imports WHERE source='legacy-native-files-v1')")
        .fetch_one(pool).await.map_err(|e| e.to_string())?;
    if done { return Ok(()); }
    let cutoff: String = sqlx::query_scalar("SELECT completed_at FROM session_origin_imports WHERE source='legacy-native-cutoff-v1'")
        .fetch_one(pool).await.map_err(|e| e.to_string())?;
    let cutoff = chrono::DateTime::parse_from_rfc3339(&cutoff).map_err(|e| e.to_string())?.timestamp_millis();
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT t.provider,t.id,t.state_dir FROM threads t JOIN session_legacy_thread_claims l
         ON l.provider=t.provider AND l.owner_id=t.id WHERE t.interaction_mode='pty'",
    ).fetch_all(pool).await.map_err(|e| e.to_string())?;
    let mut candidates = Vec::new();
    for (provider, owner, state_dir) in rows {
        let stem = match provider.as_str() {
            "Pi" => "pi", "Droid" => "droid", "Kimi" => "kimi", "Cline" => "cline",
            "Gemini" => "gemini", "Hermes" => "hermes", "OpenCode" => "opencode", "Grok" => "grok",
            _ => continue,
        };
        let path = std::path::Path::new(&state_dir).join(format!("{stem}-session-id.txt"));
        if !path.is_absolute() { continue; }
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        let Ok(modified) = meta.modified() else { continue };
        if meta.len() > 1024 || chrono::DateTime::<chrono::Utc>::from(modified).timestamp_millis() > cutoff { continue; }
        let Ok(value) = std::fs::read_to_string(path) else { continue };
        let native = value.trim();
        if validate(&provider, native).is_ok() { candidates.push((provider, owner, native.to_string())); }
    }
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    for (provider, owner, native) in candidates {
        sqlx::query("INSERT OR IGNORE INTO session_legacy_bindings(provider,session_id,owner_id) VALUES (?,?,?)")
            .bind(provider).bind(native).bind(owner).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    }
    sqlx::query("INSERT OR IGNORE INTO session_origin_imports(source) VALUES ('legacy-native-files-v1')")
        .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())
}

fn validate(provider: &str, id: &str) -> Result<(), String> {
    if !matches!(provider, "ClaudeCode" | "Codex" | "Grok" | "Droid" | "Kimi" | "Pi"
        | "Cline" | "Gemini" | "Hermes" | "OpenCode" | "Cursor" | "MLX") {
        return Err("Unknown session provider".into());
    }
    if id.is_empty() || id.len() > 256 || id.contains(['/', '\\']) || id.chars().any(char::is_control) {
        return Err("Invalid session identity".into());
    }
    Ok(())
}

/// Exact native identity checks never consult a mutable resume pointer.
pub async fn is_native_owned(pool: &SqlitePool, provider: &str, native_id: &str) -> Result<bool, String> {
    validate(provider, native_id)?;
    let flags: Vec<bool> = sqlx::query_scalar(
        "SELECT created_in_agmux FROM session_origins WHERE provider=?1 AND owner_id=?2
         UNION ALL SELECT o.created_in_agmux FROM session_origin_bindings b JOIN session_origins o
         ON o.provider=b.provider AND o.owner_id=b.owner_id WHERE b.provider=?1 AND b.session_id=?2
         UNION ALL SELECT o.created_in_agmux FROM session_legacy_bindings l
         JOIN session_origins o ON o.provider=l.provider AND o.owner_id=l.owner_id AND o.created_in_agmux=0
         WHERE l.provider=?1 AND l.session_id=?2
         UNION ALL SELECT o.created_in_agmux FROM session_legacy_thread_claims l
         JOIN session_origins o ON o.provider=l.provider AND o.owner_id=l.owner_id AND o.created_in_agmux=0
         WHERE l.provider=?1 AND l.owner_id=?2",
    ).bind(provider).bind(native_id).fetch_all(pool).await.map_err(|e| e.to_string())?;
    Ok(flags.contains(&true) && !flags.contains(&false))
}

/// First creation/import decision wins. Retrying creation or resuming a known
/// session cannot change its provenance, including across app restarts.
pub async fn record_origin(
    pool: &SqlitePool,
    provider: &str,
    owner_id: &str,
    interaction_mode: &str,
    created_in_agmux: bool,
) -> Result<(), String> {
    validate(provider, owner_id)?;
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let result = sqlx::query("INSERT OR IGNORE INTO session_origins(provider,owner_id,interaction_mode,created_in_agmux) VALUES (?,?,?,?)")
        .bind(provider).bind(owner_id).bind(interaction_mode).bind(created_in_agmux)
        .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    if result.rows_affected() > 0 {
        invalidate(&mut tx).await?;
    }
    tx.commit().await.map_err(|e| e.to_string())
}

/// Retain every exact native alias (e.g. after a clear or restart). A binding
/// cannot manufacture ownership for an owner that was never recorded.
pub async fn bind_session(
    pool: &SqlitePool,
    provider: &str,
    owner_id: &str,
    session_id: &str,
) -> Result<(), String> {
    validate(provider, owner_id)?;
    validate(provider, session_id)?;
    // Hook retries are common. Existing immutable aliases need no write lock.
    let bound: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_origin_bindings WHERE provider=? AND session_id=?)")
        .bind(provider).bind(session_id).fetch_one(pool).await.map_err(|e| e.to_string())?;
    if bound { return Ok(()); }
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let known: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_origins WHERE provider=? AND owner_id=?)")
        .bind(provider).bind(owner_id).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
    if !known { return Err("Cannot bind a session before recording its origin".into()); }
    let result = sqlx::query("INSERT OR IGNORE INTO session_origin_bindings(provider,session_id,owner_id)
        SELECT provider,?,owner_id FROM session_origins WHERE provider=? AND owner_id=?")
        .bind(session_id).bind(provider).bind(owner_id)
        .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    if result.rows_affected() > 0 {
        invalidate(&mut tx).await?;
    }
    tx.commit().await.map_err(|e| e.to_string())
}

/// Called only after an explicit native creation operation is established.
/// A new conversation inside an imported terminal is independently owned;
/// this never upgrades the imported parent or an existing outside native ID.
pub async fn record_native_creation(
    pool: &SqlitePool,
    provider: &str,
    relay_owner: &str,
    native_id: &str,
) -> Result<(), String> {
    validate(provider, relay_owner)?;
    validate(provider, native_id)?;
    let imported: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM session_origins WHERE provider=? AND owner_id=? AND created_in_agmux=0)
         OR EXISTS(SELECT 1 FROM session_origin_bindings b JOIN session_origins o
         ON o.provider=b.provider AND o.owner_id=b.owner_id
         WHERE b.provider=? AND b.session_id=? AND o.created_in_agmux=0)",
    ).bind(provider).bind(native_id).bind(provider).bind(native_id)
        .fetch_one(pool).await.map_err(|e| e.to_string())?;
    if imported { return Ok(()); }
    let origin: Option<(String, String, bool)> = sqlx::query_as(
        "SELECT owner_id,interaction_mode,created_in_agmux FROM session_origins
         WHERE provider=? AND owner_id=?
         UNION ALL SELECT o.owner_id,o.interaction_mode,o.created_in_agmux
         FROM session_origin_bindings b JOIN session_origins o
         ON o.provider=b.provider AND o.owner_id=b.owner_id
         WHERE b.provider=? AND b.session_id=? LIMIT 1",
    ).bind(provider).bind(relay_owner).bind(provider).bind(relay_owner)
        .fetch_optional(pool).await.map_err(|e| e.to_string())?;
    let (owner, mode, created) = if let Some(origin) = origin {
        origin
    } else {
        let legacy: Option<(String, String)> = sqlx::query_as(
            "SELECT t.id,t.interaction_mode FROM threads t JOIN session_legacy_thread_claims l
             ON l.provider=t.provider AND l.owner_id=t.id
             WHERE t.provider=? AND (t.id=? OR t.sdk_session_id=?) LIMIT 1",
        ).bind(provider).bind(relay_owner).bind(relay_owner)
            .fetch_optional(pool).await.map_err(|e| e.to_string())?;
        let Some((owner, mode)) = legacy else { return Err("Native creation has no app-managed relay owner".into()) };
        (owner, mode, false)
    };
    let owner = if created { owner } else {
        record_origin(pool, provider, native_id, &mode, true).await?;
        native_id.to_string()
    };
    bind_session(pool, provider, &owner, native_id).await
}

async fn invalidate(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>) -> Result<(), String> {
    sqlx::query("UPDATE teams_sync_state SET agmux_sessions_only = 0 WHERE id = 1")
        .execute(&mut **tx).await.map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn register_created_claude_sessions(pool: &SqlitePool, ids: &[String]) -> Result<(), String> {
    if ids.iter().any(|id| uuid::Uuid::parse_str(id).is_err()) {
        return Err("Invalid created Claude session ID".into());
    }
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let imported: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_origin_imports WHERE source='claude-ui-v1')")
        .fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
    if imported { return Ok(()); }
    let mut added = false;
    for id in ids {
        let result = sqlx::query("INSERT OR IGNORE INTO teams_created_claude_sessions(session_id) VALUES (?)")
            .bind(id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
        added |= result.rows_affected() > 0;
        sqlx::query("INSERT OR IGNORE INTO session_origins(provider,owner_id,interaction_mode,created_in_agmux) VALUES ('ClaudeCode',?,'pty',1)")
            .bind(id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
        sqlx::query("INSERT OR IGNORE INTO session_origin_bindings(provider,session_id,owner_id) VALUES ('ClaudeCode',?,?)")
            .bind(id).bind(id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    }
    if added {
        // Backfill newly recovered history even on a device already repaired
        // by the previous scanner revision. The next successful sync clears it.
        sqlx::query("UPDATE teams_sync_state SET agmux_sessions_only = 0 WHERE id = 1")
            .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    }
    sqlx::query("INSERT INTO session_origin_imports(source) VALUES ('claude-ui-v1')")
        .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn legacy_native_snapshot_cannot_follow_later_resume_pointers() {
        let dir = tempfile::tempdir().unwrap();
        let pointer = dir.path().join("pi-session-id.txt");
        std::fs::write(&pointer, "old-native").unwrap();
        std::fs::File::options().write(true).open(&pointer).unwrap().set_times(
            std::fs::FileTimes::new().set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(60)),
        ).unwrap();
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE threads(provider TEXT,id TEXT,sdk_session_id TEXT,opencode_session_id TEXT,state_dir TEXT,interaction_mode TEXT);
            CREATE TABLE teams_sync_state(id INTEGER,agmux_sessions_only INTEGER);")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO threads VALUES('Pi','legacy',NULL,NULL,?,'pty')")
            .bind(dir.path().to_str().unwrap()).execute(&pool).await.unwrap();
        for migration in [include_str!("../../migrations/041_teams_created_claude_sessions.sql"),
            include_str!("../../migrations/042_session_origins.sql"),
            include_str!("../../migrations/044_frozen_legacy_native_bindings.sql")] {
            sqlx::raw_sql(migration).execute(&pool).await.unwrap();
        }
        freeze_legacy_bindings(&pool).await.unwrap();
        std::fs::write(&pointer, "outside").unwrap();
        freeze_legacy_bindings(&pool).await.unwrap();
        assert!(!is_native_owned(&pool, "Pi", "old-native").await.unwrap());
        let frozen: String = sqlx::query_scalar("SELECT session_id FROM session_legacy_bindings WHERE provider='Pi'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(frozen, "old-native", "retain the frozen alias as review evidence");
        assert!(!is_native_owned(&pool, "Pi", "outside").await.unwrap());
        sqlx::query("INSERT INTO threads VALUES('Pi','future','outside',NULL,'','pty')").execute(&pool).await.unwrap();
        record_origin(&pool, "Pi", "future", "pty", true).await.unwrap();
        assert!(!is_native_owned(&pool, "Pi", "outside").await.unwrap());
        record_native_creation(&pool, "Pi", "future", "new-native").await.unwrap();
        assert!(is_native_owned(&pool, "Pi", "new-native").await.unwrap());
    }

    #[tokio::test]
    #[ignore = "requires an explicitly prepared temporary audit database"]
    async fn prepare_local_audit_copy() {
        let path = std::path::PathBuf::from(std::env::var_os("AGMUX_TEAMS_TEST_DB").unwrap()).canonicalize().unwrap();
        assert!(path.starts_with("/private/tmp") || path.starts_with(std::env::temp_dir().canonicalize().unwrap()));
        let opts = sqlx::sqlite::SqliteConnectOptions::new().filename(path);
        let pool = SqlitePool::connect_with(opts).await.unwrap();
        freeze_legacy_bindings(&pool).await.unwrap();
    }

    #[tokio::test]
    async fn all_providers_keep_creation_and_import_provenance_across_restart() {
        let dir = tempfile::tempdir().unwrap();
        let opts = sqlx::sqlite::SqliteConnectOptions::new().filename(dir.path().join("origins.db")).create_if_missing(true);
        let pool = SqlitePool::connect_with(opts.clone()).await.unwrap();
        sqlx::query("CREATE TABLE threads(provider TEXT,id TEXT)").execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/041_teams_created_claude_sessions.sql")).execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/042_session_origins.sql")).execute(&pool).await.unwrap();
        sqlx::raw_sql("CREATE TABLE teams_sync_state(id INTEGER, agmux_sessions_only INTEGER); INSERT INTO teams_sync_state VALUES(1,2)").execute(&pool).await.unwrap();
        let providers = ["ClaudeCode", "Codex", "Grok", "Droid", "Kimi", "Pi", "Cline", "Gemini", "Hermes", "OpenCode", "Cursor", "MLX"];
        for provider in providers {
            assert!(bind_session(&pool, provider, "not-recorded", "native").await.is_err());
            record_origin(&pool, provider, "created-owner", "pty", true).await.unwrap();
            bind_session(&pool, provider, "created-owner", "native-1").await.unwrap();
            bind_session(&pool, provider, "created-owner", "native-2").await.unwrap();
            record_origin(&pool, provider, "created-owner", "pty", false).await.unwrap();
            record_origin(&pool, provider, "outside-owner", "pty", false).await.unwrap();
            bind_session(&pool, provider, "outside-owner", "outside-native").await.unwrap();
            record_origin(&pool, provider, "outside-owner", "sdk", true).await.unwrap();
        }
        pool.close().await;
        let pool = SqlitePool::connect_with(opts).await.unwrap();
        for provider in providers {
            let owned: Vec<String> = sqlx::query_scalar("SELECT b.session_id FROM session_origin_bindings b JOIN session_origins o ON o.provider=b.provider AND o.owner_id=b.owner_id WHERE b.provider=? AND o.created_in_agmux=1 ORDER BY b.session_id")
                .bind(provider).fetch_all(&pool).await.unwrap();
            assert_eq!(owned, vec!["native-1", "native-2"], "{provider}");
            let imported: bool = sqlx::query_scalar("SELECT created_in_agmux FROM session_origins WHERE provider=? AND owner_id='outside-owner'")
                .bind(provider).fetch_one(&pool).await.unwrap();
            assert!(!imported, "opening an outside {provider} session cannot create ownership");
        }
    }

    #[tokio::test]
    async fn explicit_native_creation_does_not_promote_an_imported_parent() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE threads(provider TEXT,id TEXT,interaction_mode TEXT,sdk_session_id TEXT)").execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/041_teams_created_claude_sessions.sql")).execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/042_session_origins.sql")).execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE teams_sync_state(id INTEGER,agmux_sessions_only INTEGER)").execute(&pool).await.unwrap();
        record_origin(&pool, "Pi", "imported", "pty", false).await.unwrap();
        record_native_creation(&pool, "Pi", "imported", "fresh-native").await.unwrap();
        let values: Vec<(String, bool)> = sqlx::query_as("SELECT owner_id,created_in_agmux FROM session_origins ORDER BY owner_id").fetch_all(&pool).await.unwrap();
        assert_eq!(values, vec![("fresh-native".into(), true), ("imported".into(), false)]);
        record_origin(&pool, "Pi", "outside-native", "pty", false).await.unwrap();
        record_native_creation(&pool, "Pi", "imported", "outside-native").await.unwrap();
        let outside: bool = sqlx::query_scalar("SELECT created_in_agmux FROM session_origins WHERE owner_id='outside-native'").fetch_one(&pool).await.unwrap();
        assert!(!outside);
        assert!(record_native_creation(&pool, "Pi", "unknown", "unproven").await.is_err());
    }

    #[tokio::test]
    async fn explicit_creation_is_idempotent_and_invalid_imports_are_atomic() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE threads(provider TEXT,id TEXT)").execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/041_teams_created_claude_sessions.sql"))
            .execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/042_session_origins.sql"))
            .execute(&pool).await.unwrap();
        sqlx::raw_sql("CREATE TABLE teams_sync_state(id INTEGER, agmux_sessions_only INTEGER); INSERT INTO teams_sync_state VALUES (1,2)")
            .execute(&pool).await.unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        register_created_claude_sessions(&pool, &[id.clone()]).await.unwrap();
        let revision: i64 = sqlx::query_scalar("SELECT agmux_sessions_only FROM teams_sync_state").fetch_one(&pool).await.unwrap();
        assert_eq!(revision, 0);
        sqlx::query("UPDATE teams_sync_state SET agmux_sessions_only=2").execute(&pool).await.unwrap();
        register_created_claude_sessions(&pool, &[id]).await.unwrap();
        let revision: i64 = sqlx::query_scalar("SELECT agmux_sessions_only FROM teams_sync_state").fetch_one(&pool).await.unwrap();
        assert_eq!(revision, 2, "unchanged imports must not repeatedly force repairs");
        register_created_claude_sessions(&pool, &[uuid::Uuid::new_v4().to_string()]).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM teams_created_claude_sessions").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 1, "future UI discoveries must not create ownership");
        assert!(register_created_claude_sessions(&pool, &[uuid::Uuid::new_v4().to_string(), "../outside".into()]).await.is_err());
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM teams_created_claude_sessions").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 1);
    }
}
