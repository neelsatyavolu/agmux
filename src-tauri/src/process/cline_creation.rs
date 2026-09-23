use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreatedSession {
    pub session_id: String,
    pub provider: String,
    pub model: String,
}

pub async fn create(
    pool: &sqlx::SqlitePool,
    owner: &str,
    state_dir: &Path,
    cwd: &str,
    model: Option<&str>,
) -> Result<CreatedSession, String> {
    let node = super::provider::resolve_cli_path("node").ok_or("Node.js is required to create a tracked Cline session")?;
    let cline = super::provider::resolve_cli_path("cline").ok_or("Cline CLI not found")?;
    let mut input = serde_json::json!({"clineBin": cline, "cwd": cwd});
    if let Some(model) = model.filter(|m| !m.is_empty()) { input["model"] = model.into(); }
    let work = async {
        let mut child = tokio::process::Command::new(node)
            .args(["--input-type=module", "-e", include_str!("cline_precreate.mjs")])
            .env("PATH", super::provider::build_augmented_path())
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .kill_on_drop(true).spawn().map_err(|e| format!("Cline session preparation failed: {e}"))?;
        let mut stdin = child.stdin.take().ok_or("Cline helper input unavailable")?;
        stdin.write_all(input.to_string().as_bytes()).await.map_err(|e| e.to_string())?;
        stdin.shutdown().await.map_err(|e| e.to_string())?;
        drop(stdin);
        let stdout = child.stdout.take().ok_or("Cline helper output unavailable")?;
        let mut bytes = Vec::new();
        stdout.take(8193).read_to_end(&mut bytes).await.map_err(|e| e.to_string())?;
        if bytes.len() > 8192 { return Err("Cline creation response exceeded its limit".into()); }
        if !child.wait().await.map_err(|e| e.to_string())?.success() {
            return Err("Cline could not prepare a tracked session. Check the installed Cline CLI and Node.js versions.".into());
        }
        let created: CreatedSession = serde_json::from_slice(&bytes).map_err(|_| "Invalid Cline creation response")?;
        if uuid::Uuid::parse_str(&created.session_id).is_err()
            || [&created.provider, &created.model].iter().any(|s| s.trim().is_empty() || s.len() > 1024 || s.chars().any(char::is_control)) {
            return Err("Invalid Cline creation identity or configuration".into());
        }
        retain_created_session(pool, owner, state_dir, &created.session_id).await?;
        Ok(created)
    };
    tokio::time::timeout(std::time::Duration::from_secs(15), work).await
        .map_err(|_| "Cline session preparation timed out".to_string())?
}

async fn retain_created_session(
    pool: &sqlx::SqlitePool,
    owner: &str,
    state_dir: &Path,
    native_id: &str,
) -> Result<(), String> {
    crate::teams::ownership::record_native_creation(pool, "Cline", owner, native_id).await?;
    super::cline_session::write_session_id(state_dir, native_id)
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    #[ignore = "requires installed Cline and CLINE_DIR isolated under a temporary directory"]
    async fn native_empty_creation_is_durably_bound_before_terminal_handoff() {
        let root = std::env::var_os("CLINE_DIR").map(std::path::PathBuf::from).expect("isolated CLINE_DIR");
        let root = root.canonicalize().unwrap();
        let temp = std::env::temp_dir().canonicalize().unwrap();
        assert!(root.starts_with(&temp) || root.starts_with("/private/tmp"));
        assert!(root.file_name().unwrap().to_string_lossy().starts_with("agmux-cline-rust-"));
        let db = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(db.path().join("agmux.db").to_str().unwrap()).await.unwrap();
        crate::teams::ownership::record_origin(&pool, "Cline", "new-owner", "pty", true).await.unwrap();
        let state = root.join("app-thread");
        let created = super::create(&pool, "new-owner", &state, root.to_str().unwrap(), None).await.unwrap();
        assert!(crate::teams::ownership::is_native_owned(&pool, "Cline", &created.session_id).await.unwrap());
        assert_eq!(crate::process::cline_session::read_session_id(&state).as_deref(), Some(created.session_id.as_str()));
        assert!(crate::process::cline_session::session_exists(&created.session_id));
        assert!(!created.provider.is_empty() && !created.model.is_empty());
    }

    #[tokio::test]
    async fn creation_is_bound_before_resume_pointer_and_import_stays_external() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE threads(provider TEXT,id TEXT,interaction_mode TEXT,sdk_session_id TEXT,opencode_session_id TEXT);
            CREATE TABLE teams_sync_state(id INTEGER,agmux_sessions_only INTEGER);")
            .execute(&pool).await.unwrap();
        for migration in [include_str!("../../migrations/041_teams_created_claude_sessions.sql"),
            include_str!("../../migrations/042_session_origins.sql"),
            include_str!("../../migrations/044_frozen_legacy_native_bindings.sql")] {
            sqlx::raw_sql(migration).execute(&pool).await.unwrap();
        }
        crate::teams::ownership::record_origin(&pool, "Cline", "import", "pty", false).await.unwrap();
        let dir = tempfile::tempdir().unwrap();
        let native = uuid::Uuid::new_v4().to_string();
        super::retain_created_session(&pool, "import", dir.path(), &native).await.unwrap();
        assert!(crate::teams::ownership::is_native_owned(&pool, "Cline", &native).await.unwrap());
        assert!(!crate::teams::ownership::is_native_owned(&pool, "Cline", "import").await.unwrap());
        assert_eq!(crate::process::cline_session::read_session_id(dir.path()).as_deref(), Some(native.as_str()));
        pool.close().await;
        let failed_dir = tempfile::tempdir().unwrap();
        assert!(super::retain_created_session(&pool, "import", failed_dir.path(), &native).await.is_err());
        assert!(crate::process::cline_session::read_session_id(failed_dir.path()).is_none(), "failed binding must not leave an untracked launch pointer");
    }
}
