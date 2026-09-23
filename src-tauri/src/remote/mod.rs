//! Mobile remote control: outbound bridge to Cloudflare Durable Object relay.

pub mod auth;
pub mod client;
mod frames;
pub mod deeplink;
pub mod dispatch;
pub mod draft_prefs;
pub mod prefs;
pub mod protocol;
pub mod timeline;
pub mod titles;
pub mod unread;

pub use client::RemoteClientHandle;

use crate::state::AppState;
use tauri::{AppHandle, Manager};

/// Codex events carry a native session id. Phone requests must use the catalog
/// owner id, but only when a single Codex row owns that binding. Existing ids
/// take precedence and other providers' bindings are never remapped.
async fn remote_thread_id(pool: &sqlx::SqlitePool, thread_id: &str) -> String {
    let ids = sqlx::query_scalar::<_, String>(
        "SELECT id FROM threads WHERE id = ? OR (provider = 'Codex' AND sdk_session_id = ?) ORDER BY (id = ?) DESC LIMIT 2",
    )
    .bind(thread_id).bind(thread_id).bind(thread_id)
    .fetch_all(pool).await.unwrap_or_default();
    if ids.first().is_some_and(|id| id == thread_id) || ids.len() != 1 {
        thread_id.to_string()
    } else {
        ids[0].clone()
    }
}

/// Resolve provider + project_key for Teams approval-wait telemetry.
///
/// Codex app-server passes its own session id (often `threads.sdk_session_id`,
/// not `threads.id`). Empty provider poisons the whole Teams upload batch
/// (server rejects it), so we never return an empty provider when we can
/// infer Codex/Claude from on-disk sessions.
async fn approval_identity(
    pool: &sqlx::SqlitePool,
    thread_id: &str,
) -> (String, String) {
    use crate::db::models::Thread;
    use crate::teams::aggregate::project_key;

    if let Ok(t) = crate::db::queries::get_thread(pool, thread_id).await {
        return (t.provider, project_key(&t.work_dir, false));
    }
    // Desktop Codex chat: agmux uuid in `id`, provider session in `sdk_session_id`.
    if let Ok(Some(t)) = sqlx::query_as::<_, Thread>(
        "SELECT * FROM threads WHERE sdk_session_id = ? LIMIT 1",
    )
    .bind(thread_id)
    .fetch_optional(pool)
    .await
    {
        return (t.provider, project_key(&t.work_dir, false));
    }
    // Discovered Claude/Codex sessions (synthetic thread from on-disk logs).
    if let Ok((t, _)) = crate::dispatch::resolve_thread(pool, thread_id).await {
        return (t.provider, project_key(&t.work_dir, false));
    }
    // Codex rollout exists but cwd didn't match a known project.
    if let Some(home) = dirs::home_dir() {
        if let Some(cwd) = client::codex_rollout_cwd(&home, thread_id) {
            return ("Codex".into(), project_key(&cwd, false));
        }
        if crate::process::spawn::codex_session_file_exists(thread_id) {
            return ("Codex".into(), String::new());
        }
    }
    (String::new(), String::new())
}

/// Forward an approval request to paired phones (no-op if remote off/disconnected).
/// Also records Teams approval-wait start (blocked-time telemetry).
pub fn notify_approval(
    app: &AppHandle,
    thread_id: &str,
    request_id: &str,
    tool_name: &str,
    detail: &str,
) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let remote = state.remote.clone();
    let pool = state.db.clone();
    let thread_id = thread_id.to_string();
    let request_id = request_id.to_string();
    let tool_name = tool_name.to_string();
    let detail = detail.to_string();
    tauri::async_runtime::spawn(async move {
        // Teams blocked-time: start wait even when remote is off.
        let (provider, project_key) = approval_identity(&pool, &thread_id).await;
        if !provider.is_empty() {
            let _ = crate::teams::approval_wait::note_requested(
                &pool,
                &request_id,
                &thread_id,
                &provider,
                &project_key,
                &tool_name,
            )
            .await;
        }
        let remote_id = remote_thread_id(&pool, &thread_id).await;
        remote
            .push_approval_requested(&remote_id, &request_id, &tool_name, &detail)
            .await;
    });
}

/// Clear a remote approval after desktop (or phone) resolves it.
/// Also closes the Teams approval-wait sample.
pub fn notify_approval_resolved(app: &AppHandle, request_id: &str, thread_id: Option<&str>) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let remote = state.remote.clone();
    let pool = state.db.clone();
    let request_id = request_id.to_string();
    let thread_id = thread_id.map(str::to_string);
    tauri::async_runtime::spawn(async move {
        let _ = crate::teams::approval_wait::note_resolved(&pool, &request_id).await;
        let remote_id = match thread_id {
            Some(id) => Some(remote_thread_id(&pool, &id).await),
            None => None,
        };
        remote.push_approval_resolved(&request_id, remote_id.as_deref()).await;
    });
}

/// Forward AskUser questions to paired phones.
pub fn notify_user_input(
    app: &AppHandle,
    thread_id: &str,
    request_id: &str,
    questions: serde_json::Value,
) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let remote = state.remote.clone();
    let pool = state.db.clone();
    let thread_id = thread_id.to_string();
    let request_id = request_id.to_string();
    tauri::async_runtime::spawn(async move {
        let remote_id = remote_thread_id(&pool, &thread_id).await;
        remote
            .push_user_input_requested(&remote_id, &request_id, questions)
            .await;
    });
}

/// Clear an agent question on paired phones after it is answered on desktop.
pub fn notify_user_input_resolved(app: &AppHandle, request_id: &str, thread_id: Option<&str>) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let remote = state.remote.clone();
    let pool = state.db.clone();
    let request_id = request_id.to_string();
    let thread_id = thread_id.map(str::to_string);
    tauri::async_runtime::spawn(async move {
        let remote_id = match thread_id {
            Some(id) => Some(remote_thread_id(&pool, &id).await),
            None => None,
        };
        remote.push_user_input_resolved(&request_id, remote_id.as_deref()).await;
    });
}

#[cfg(test)]
mod tests {
    use super::remote_thread_id;

    #[tokio::test]
    async fn remote_thread_identity_maps_only_unambiguous_codex_bindings() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE threads (id TEXT PRIMARY KEY, provider TEXT, sdk_session_id TEXT)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO threads VALUES ('owner', 'Codex', 'native'), ('claude-owner', 'ClaudeCode', 'claude-native')")
            .execute(&pool).await.unwrap();
        assert_eq!(remote_thread_id(&pool, "native").await, "owner");
        assert_eq!(remote_thread_id(&pool, "owner").await, "owner");
        assert_eq!(remote_thread_id(&pool, "unknown").await, "unknown");
        assert_eq!(remote_thread_id(&pool, "claude-native").await, "claude-native");

        sqlx::query("INSERT INTO threads VALUES ('second-owner', 'Codex', 'native')")
            .execute(&pool).await.unwrap();
        assert_eq!(remote_thread_id(&pool, "native").await, "native", "ambiguous ownership must not pick a thread");

        sqlx::query("INSERT INTO threads VALUES ('native', 'Grok', NULL)")
            .execute(&pool).await.unwrap();
        assert_eq!(remote_thread_id(&pool, "native").await, "native", "an existing owner id always wins");
    }
}
