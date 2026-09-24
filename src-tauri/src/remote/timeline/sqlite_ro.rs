//! Read-only SQLite access for native provider histories (Hermes, OpenCode).
//!
//! Timeline readers are synchronous and run on `spawn_blocking`, so each read
//! drives its own current-thread runtime instead of borrowing an async worker.

use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};
use sqlx::Connection;
use std::future::Future;
use std::path::Path;
use std::time::Duration;

/// Open `path` read-only (never created, short busy timeout) and run `read`.
/// Any open/query failure yields `None` so callers fall back to agent_logs.
pub(super) fn read_only<T, F, Fut>(path: &Path, read: F) -> Option<T>
where
    F: FnOnce(SqliteConnection) -> Fut,
    Fut: Future<Output = Option<T>>,
{
    if !path.is_file() {
        return None;
    }
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false)
        .busy_timeout(Duration::from_millis(500));
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().ok()?;
    runtime.block_on(async move {
        let conn = SqliteConnection::connect_with(&options).await.ok()?;
        read(conn).await
    })
}

/// Provider timestamps (epoch ms) → RFC 3339 so `parse_log_ts` keeps ordering.
pub(super) fn millis_to_rfc3339(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|d| d.to_rfc3339()).unwrap_or_default()
}
