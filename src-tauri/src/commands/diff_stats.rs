//! Frontend-facing command for recording line-change deltas. Used by
//! Codex and any other provider whose event stream is easier to parse in
//! the frontend than in Rust — they compute the per-edit added/removed
//! counts from the provider's own diff format and report them here.

use tauri::{AppHandle, Emitter, State};

use crate::diff_stats;
use crate::state::AppState;

#[tauri::command]
pub async fn list_shell_diff_stats(
    state: State<'_, AppState>,
) -> Result<Vec<crate::shell_diff::ShellDiffStats>, String> {
    crate::shell_diff::list_stats(&state.db).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn record_thread_line_delta(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    lines_added: i64,
    lines_removed: i64,
    files_changed: i64,
    only_if_zero: Option<bool>,
) -> Result<(), String> {
    let added = lines_added.max(0) as u64;
    let removed = lines_removed.max(0) as u64;
    let files = files_changed.max(0) as u64;
    if only_if_zero.unwrap_or(false) {
        if let Some((lines_added, lines_removed, files_changed)) = backfill_thread_line_counts(
            &state.db, &thread_id, added as i64, removed as i64, files as i64,
        ).await.map_err(|e| e.to_string())? {
            let _ = app.emit("thread-diff-updated", serde_json::json!({
                "threadId": thread_id,
                "linesAdded": lines_added,
                "linesRemoved": lines_removed,
                "filesChanged": files_changed,
            }));
        }
        return Ok(());
    }
    diff_stats::record_thread_diff_delta(&app, &state.db, &thread_id, added, removed, files)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn backfill_thread_line_counts(
    db: &sqlx::SqlitePool,
    thread_id: &str,
    added: i64,
    removed: i64,
    files: i64,
) -> Result<Option<(i64, i64, i64)>, sqlx::Error> {
    // The frontend's zero check can be stale after another restore or live edit.
    // Check and write in one statement; only the winner emits updated totals.
    sqlx::query_as(
        "UPDATE threads SET lines_added = lines_added + ?, lines_removed = lines_removed + ?, files_changed = files_changed + ?
         WHERE id = ? AND lines_added = 0 AND lines_removed = 0 AND files_changed = 0
         RETURNING lines_added, lines_removed, files_changed",
    ).bind(added).bind(removed).bind(files).bind(thread_id).fetch_optional(db).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> sqlx::SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1)
            .connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE threads(id TEXT PRIMARY KEY, lines_added INTEGER NOT NULL DEFAULT 0,
            lines_removed INTEGER NOT NULL DEFAULT 0, files_changed INTEGER NOT NULL DEFAULT 0)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO threads(id) VALUES ('cursor')").execute(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn concurrent_backfills_apply_once() {
        let pool = pool().await;
        let (a, b) = tokio::join!(
            backfill_thread_line_counts(&pool, "cursor", 10, 2, 1),
            backfill_thread_line_counts(&pool, "cursor", 10, 2, 1),
        );
        let results = [a.unwrap(), b.unwrap()];
        assert_eq!(results.iter().filter(|r| r.is_some()).count(), 1);
        let totals: (i64, i64, i64) = sqlx::query_as("SELECT lines_added, lines_removed, files_changed FROM threads")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(totals, (10, 2, 1));
    }

    #[tokio::test]
    async fn backfill_preserves_any_nonzero_live_counter() {
        let pool = pool().await;
        for totals in [(5, 0, 0), (0, 3, 0), (0, 0, 1)] {
            sqlx::query("UPDATE threads SET lines_added=?, lines_removed=?, files_changed=?")
                .bind(totals.0).bind(totals.1).bind(totals.2).execute(&pool).await.unwrap();
            assert_eq!(backfill_thread_line_counts(&pool, "cursor", 10, 2, 1).await.unwrap(), None);
            let saved: (i64, i64, i64) = sqlx::query_as("SELECT lines_added, lines_removed, files_changed FROM threads")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(saved, totals);
        }
    }
}
