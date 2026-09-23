//! Recovery commands deliberately work without AppState or an open app database.
use tauri::Manager;
use serde::Serialize;

pub struct StartupFailure(pub String);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupStatus { error: Option<String>, data_path: String, backups: Vec<String> }
#[tauri::command]
pub fn startup_status(app: tauri::AppHandle) -> StartupStatus {
    let dir = crate::paths::agmux_home().join("backups");
    let mut backups: Vec<String> = std::fs::read_dir(dir).into_iter().flatten().filter_map(Result::ok)
        .filter_map(|e| e.file_name().into_string().ok()).filter(|s| valid_backup_name(s)).collect();
    backups.sort(); backups.reverse();
    StartupStatus { error: app.try_state::<StartupFailure>().map(|e| e.0.clone()), data_path: crate::paths::agmux_home().to_string_lossy().into_owned(), backups }
}
fn valid_backup_name(name: &str) -> bool {
    name.starts_with("pre-migration-") && name.ends_with(".db") && !name.contains(['/', '\\'])
}
#[tauri::command]
pub async fn startup_restore_backup(app: tauri::AppHandle, name: String) -> Result<(), String> {
    if app.try_state::<StartupFailure>().is_none() || app.try_state::<crate::state::AppState>().is_some() { return Err("Restore is available only when the database could not open.".into()); }
    if !valid_backup_name(&name) { return Err("Invalid backup name.".into()); }
    static RESTORING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if RESTORING.swap(true, std::sync::atomic::Ordering::SeqCst) { return Err("A restore is already in progress.".into()); }
    let result = restore_backup(&crate::paths::db_path(), &crate::paths::agmux_home().join("backups").join(name)).await;
    RESTORING.store(false, std::sync::atomic::Ordering::SeqCst);
    result.map_err(|e| e.to_string())
}
async fn restore_backup(db: &std::path::Path, backup: &std::path::Path) -> anyhow::Result<()> {
    use sqlx::Connection;
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(backup).read_only(true);
    let mut connection = sqlx::SqliteConnection::connect_with(&options).await?;
    let check: String = sqlx::query_scalar("PRAGMA quick_check").fetch_one(&mut connection).await?;
    connection.close().await?;
    anyhow::ensure!(check == "ok", "The backup failed its integrity check.");
    let recovery = db.parent().unwrap().join("backups").join(format!("before-restore-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&recovery)?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&recovery, std::fs::Permissions::from_mode(0o700))?;
    }
    for suffix in ["", "-wal", "-shm"] {
        let original = std::path::PathBuf::from(format!("{}{suffix}", db.display()));
        if original.exists() { std::fs::copy(&original, recovery.join(original.file_name().unwrap()))?; }
    }
    let staged = recovery.join("restored.db");
    std::fs::copy(backup, &staged)?;
    // Original files are preserved above before changing the failed database.
    for suffix in ["-wal", "-shm"] {
        let path = std::path::PathBuf::from(format!("{}{suffix}", db.display()));
        if path.exists() { std::fs::remove_file(path)?; }
    }
    std::fs::rename(staged, db)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn restore_preserves_failed_database_and_rejects_bad_backup() {
        use sqlx::Connection;
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("agmux.db");
        let backup = dir.path().join("saved.db");
        let mut conn = sqlx::SqliteConnection::connect_with(&sqlx::sqlite::SqliteConnectOptions::new().filename(&backup).create_if_missing(true)).await.unwrap();
        sqlx::query("CREATE TABLE saved(value TEXT)").execute(&mut conn).await.unwrap();
        conn.close().await.unwrap();
        std::fs::write(&db, b"broken database").unwrap();
        restore_backup(&db, &backup).await.unwrap();
        let folder = std::fs::read_dir(dir.path().join("backups")).unwrap().next().unwrap().unwrap().path();
        assert_eq!(std::fs::read(folder.join("agmux.db")).unwrap(), b"broken database");
        assert_eq!(std::fs::read(&db).unwrap(), std::fs::read(&backup).unwrap());
        std::fs::write(&backup, b"broken backup").unwrap();
        assert!(restore_backup(&db, &backup).await.is_err());
        assert!(!valid_backup_name("pre-migration-../../secret.db"));
    }
}
