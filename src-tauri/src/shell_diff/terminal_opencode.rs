//! OpenCode PTY has no completion hook; observe exact bound SQLite tool parts.
use super::Source;
use serde_json::Value;
use sqlx::{sqlite::{SqliteConnectOptions, SqlitePoolOptions}, SqlitePool};
use std::collections::HashMap;
use tauri::AppHandle;

const MAX_PARTS: usize = 4096;

pub(super) struct Watch {
    pub(super) source: Source,
    pool: SqlitePool,
    statuses: HashMap<String, String>,
    data_version: i64,
}

// Select only tool metadata/input. Never transfer stored outputs or prompts.
async fn parts(pool: &SqlitePool, session: &str) -> Option<Vec<(String, Value)>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, json_object('tool', json_extract(data, '$.tool'), 'callID', json_extract(data, '$.callID'), 'status', json_extract(data, '$.state.status'), 'input', json_extract(data, '$.state.input')) FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'tool' LIMIT 4097"
    ).bind(session).fetch_all(pool).await.ok()?;
    if rows.len() > MAX_PARTS { return None; }
    rows.into_iter().map(|(id, data)| Some((id, serde_json::from_str(&data).ok()?))).collect()
}

#[derive(Debug, PartialEq, Eq)]
enum Transition { Start, Finish, CollisionOnly, None }

fn transition(previous: Option<&str>, current: &str) -> Transition {
    match (previous, current) {
        (Some("running"), "completed" | "error") => Transition::Finish,
        (None | Some("pending"), "running") => Transition::Start,
        (None | Some("pending"), "completed" | "error") => Transition::CollisionOnly,
        _ => Transition::None,
    }
}

impl Watch {
    pub(super) async fn attach(app: &AppHandle, source: Source) -> Option<Self> {
        let options = SqliteConnectOptions::new().filename(&source.path)
            .read_only(true).create_if_missing(false)
            .busy_timeout(std::time::Duration::from_millis(200));
        // data_version is connection-local. Keep exactly this connection alive
        // so a replacement connection cannot reuse the cached version number.
        let pool = SqlitePoolOptions::new().max_connections(1).min_connections(1)
            .max_lifetime(None).idle_timeout(None).connect_with(options).await.ok()?;
        // Plugin lastSessionID may have observed a child: never adopt that
        // child's writes onto the parent terminal solely from its env binding.
        let directory: Option<(String,)> = sqlx::query_as(
            "SELECT directory FROM session WHERE id = ? AND parent_id IS NULL"
        ).bind(&source.session).fetch_optional(&pool).await.ok()?;
        let directory = tokio::fs::canonicalize(directory?.0).await.ok()?;
        if directory != tokio::fs::canonicalize(&source.cwd).await.ok()? { return None; }
        let data_version = sqlx::query_scalar("PRAGMA data_version").fetch_one(&pool).await.ok()?;
        let rows = parts(&pool, &source.session).await?;
        let mut statuses = HashMap::new();
        for (part, value) in rows {
            let status = value["status"].as_str().unwrap_or("");
            if status == "running" {
                // In-flight at attachment: blocker only, no historical baseline.
                crate::shell_diff::begin(app, &source.owner, Some(&source.session), &source.cwd,
                    &part, "terminal_already_running", &Value::Null).await;
            }
            statuses.insert(part, status.to_owned());
        }
        Some(Self { source, pool, statuses, data_version })
    }

    pub(super) async fn poll(&mut self, app: &AppHandle) -> bool {
        let Ok(version) = sqlx::query_scalar::<_, i64>("PRAGMA data_version").fetch_one(&self.pool).await else { return false };
        if version == self.data_version { return true; }
        let Some(rows) = parts(&self.pool, &self.source.session).await else { return false };
        self.data_version = version;
        // Part removal/rewind loses continuity. Reattach at the current baseline.
        if self.statuses.keys().any(|id| !rows.iter().any(|(part, _)| part == id)) { return false; }
        let mut finishes = Vec::new();
        for (part, value) in rows {
            let status = value["status"].as_str().unwrap_or("");
            match transition(self.statuses.get(&part).map(String::as_str), status) {
                Transition::Start | Transition::CollisionOnly => {
                    let late = matches!(status, "completed" | "error");
                    let tool = if late { "terminal_already_completed" } else { value["tool"].as_str().unwrap_or("unknown") };
                    crate::shell_diff::begin(app, &self.source.owner, Some(&self.source.session),
                        &self.source.cwd, &part, tool, &value["input"]).await;
                    if late { finishes.push(part.clone()); }
                }
                Transition::Finish => finishes.push(part.clone()),
                Transition::None => {}
            }
            self.statuses.insert(part, status.to_owned());
        }
        // Observe every newly visible start before settling any finish. SQLite
        // rows in one poll carry no trustworthy cross-tool execution ordering.
        for id in finishes {
            crate::shell_diff::finish(app, &self.source.owner, &id).await;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_live_running_transition_can_capture_a_baseline() {
        assert_eq!(transition(None, "running"), Transition::Start);
        assert_eq!(transition(Some("pending"), "running"), Transition::Start);
        assert_eq!(transition(None, "completed"), Transition::CollisionOnly);
        assert_eq!(transition(Some("pending"), "error"), Transition::CollisionOnly);
        assert_eq!(transition(Some("running"), "running"), Transition::None);
        assert_eq!(transition(Some("running"), "completed"), Transition::Finish);
        assert_eq!(transition(Some("completed"), "completed"), Transition::None);
    }
}
