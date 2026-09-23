use super::Change;
use serde::Serialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShellDiffStats {
    owner_id: String,
    session_id: Option<String>,
    lines_added: i64,
    lines_removed: i64,
    files_changed: i64,
}

pub(super) async fn record(app: &AppHandle, db: &SqlitePool, owner: &str, session: Option<&str>, id: &str, changes: &[Change]) -> Result<(), sqlx::Error> {
    if changes.is_empty() { return Ok(()); }
    persist(db, owner, session, id, changes).await?;
    let stats = sqlx::query_as::<_, ShellDiffStats>(
        "SELECT owner_id, NULL AS session_id, SUM(lines_added) AS lines_added, SUM(lines_removed) AS lines_removed, COUNT(DISTINCT file_path) AS files_changed FROM shell_diff_events WHERE owner_id = ? GROUP BY owner_id"
    ).bind(owner).fetch_one(db).await?;
    let _ = app.emit("shell-diff-updated", stats);
    if let Some(session) = session.filter(|s| *s != owner) {
        let stats = sqlx::query_as::<_, ShellDiffStats>(
            "SELECT session_id AS owner_id, NULL AS session_id, SUM(lines_added) AS lines_added, SUM(lines_removed) AS lines_removed, COUNT(DISTINCT file_path) AS files_changed FROM shell_diff_events WHERE session_id = ? AND NOT EXISTS (SELECT 1 FROM shell_diff_events WHERE owner_id = ?) GROUP BY session_id"
        ).bind(session).bind(session).fetch_optional(db).await?;
        if let Some(stats) = stats { let _ = app.emit("shell-diff-updated", stats); }
    }
    Ok(())
}

pub(super) async fn persist(db: &SqlitePool, owner: &str, session: Option<&str>, id: &str, changes: &[Change]) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    for change in changes {
        sqlx::query("INSERT OR IGNORE INTO shell_diff_events (owner_id, session_id, tool_id, file_path, lines_added, lines_removed) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(owner).bind(session).bind(id).bind(change.path.to_string_lossy().as_ref())
            .bind(change.added as i64).bind(change.removed as i64).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn list(db: &SqlitePool) -> Result<Vec<ShellDiffStats>, sqlx::Error> {
    // Thread rows include every /clear session; native rows include only that
    // session. Exact IDs take precedence in the UI, so aliases are never added
    // together or credited with another session's changes.
    sqlx::query_as("SELECT owner_id, NULL AS session_id, SUM(lines_added) AS lines_added, SUM(lines_removed) AS lines_removed, COUNT(DISTINCT file_path) AS files_changed FROM shell_diff_events GROUP BY owner_id
        UNION ALL SELECT session_id AS owner_id, NULL AS session_id, SUM(lines_added) AS lines_added, SUM(lines_removed) AS lines_removed, COUNT(DISTINCT file_path) AS files_changed FROM shell_diff_events WHERE session_id IS NOT NULL AND session_id NOT IN (SELECT DISTINCT owner_id FROM shell_diff_events) GROUP BY session_id")
        .fetch_all(db).await
}
