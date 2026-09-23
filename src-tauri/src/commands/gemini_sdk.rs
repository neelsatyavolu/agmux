//! Tauri commands for Gemini chat via Antigravity ACP (`agy_acp_server`).

use crate::db::queries;
use crate::gemini::app_server::{GeminiAppServer, GeminiSpawnConfig};
use crate::gemini::install;
use crate::state::AppState;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

fn gemini_session_id_file(state_dir: &str) -> PathBuf {
    PathBuf::from(state_dir).join("gemini-session-id.txt")
}

fn read_cached_session_id(state_dir: &str) -> Option<String> {
    std::fs::read_to_string(gemini_session_id_file(state_dir))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn write_cached_session_id(state_dir: &str, session_id: &str) {
    let path = gemini_session_id_file(state_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, session_id);
}

async fn persist_thread_session_id(
    app: &AppHandle,
    state: &AppState,
    thread_id: &str,
    session_id: &str,
) {
    match queries::update_thread_grok_session_and_model(&state.db, thread_id, session_id, None)
        .await
    {
        Ok(()) => {
            let _ = app.emit(
                "thread-gemini-updated",
                serde_json::json!({
                    "thread_id": thread_id,
                    "session_id": session_id,
                    "model": serde_json::Value::Null,
                }),
            );
        }
        Err(e) => {
            tracing::warn!("[gemini] failed to persist ACP session: {e}");
        }
    }
}

fn build_config(
    permission_mode: Option<String>,
    effort: Option<String>,
    model: Option<String>,
) -> GeminiSpawnConfig {
    GeminiSpawnConfig {
        permission_mode,
        effort,
        model,
    }
}

fn map_permission_mode(mode: &str) -> &'static str {
    match mode {
        "bypassPermissions" | "yolo" | "full" => "yolo",
        "acceptEdits" | "auto" | "auto_edit" => "auto_edit",
        "plan" => "plan",
        _ => "default",
    }
}

async fn resume_or_new_session(
    app: &AppHandle,
    state: &AppState,
    server: &Arc<GeminiAppServer>,
    thread_id: &str,
    work_dir: &str,
) -> Result<String, String> {
    let _setup = server.session_setup_lock().await;
    if let Some(sid) = server.session_id_for_thread(thread_id).await {
        queries::record_thread_session_start(&state.db, thread_id, Some(&sid)).await?;
        server.configure_initial_model(&sid).await.map_err(|e| e.to_string())?;
        return Ok(sid);
    }
    let thread = queries::get_thread(&state.db, thread_id).await.ok();
    let cached = thread
        .as_ref()
        .and_then(|t| t.sdk_session_id.clone())
        .or_else(|| thread.as_ref().and_then(|t| read_cached_session_id(&t.state_dir)));

    if let Some(prev_session_id) = cached {
        queries::record_thread_session_start(&state.db, thread_id, Some(&prev_session_id)).await?;
        match server
            .load_session(thread_id, &prev_session_id, work_dir, Vec::new(), None, None)
            .await
        {
            Ok(()) => {
                queries::bind_thread_session(&state.db, thread_id, &prev_session_id).await?;
                persist_thread_session_id(app, state, thread_id, &prev_session_id).await;
                server.configure_initial_model(&prev_session_id).await.map_err(|e| e.to_string())?;
                return Ok(prev_session_id);
            }
            Err(e) => {
                tracing::warn!("[gemini] session/resume failed ({e}); starting fresh");
            }
        }
    }

    queries::record_thread_session_start(&state.db, thread_id, None).await?;
    let session_id = server
        .new_session(thread_id, work_dir, Vec::new(), None, None)
        .await
        .map_err(|e| e.to_string())?;
    crate::teams::ownership::record_native_creation(&state.db, "Gemini", thread_id, &session_id).await?;
    queries::bind_thread_session(&state.db, thread_id, &session_id).await?;
    if let Ok(thread) = queries::get_thread(&state.db, thread_id).await {
        write_cached_session_id(&thread.state_dir, &session_id);
    }
    persist_thread_session_id(app, state, thread_id, &session_id).await;
    server.configure_initial_model(&session_id).await.map_err(|e| e.to_string())?;
    Ok(session_id)
}

async fn ensure_gemini_server(
    app: &AppHandle,
    state: &AppState,
    thread_id: &str,
    work_dir: &str,
    config: GeminiSpawnConfig,
) -> Result<Arc<GeminiAppServer>, String> {
    crate::teams::policy::refresh_for_execution().await?;
    crate::teams::policy::enforce_session("Gemini", "chat")?;
    if let Some(server) = {
        let servers = state.gemini_servers.lock().await;
        servers.get(thread_id)
    } {
        return Ok(server);
    }
    let spawned = Arc::new(
        GeminiAppServer::spawn(app.clone(), work_dir, &config, thread_id)
            .await
            .map_err(|e| e.to_string())?,
    );
    let canonical = {
        let mut servers = state.gemini_servers.lock().await;
        servers.insert_or_keep(thread_id, spawned.clone(), config)
    };
    if !Arc::ptr_eq(&canonical, &spawned) {
        spawned.shutdown().await;
    }
    Ok(canonical)
}

#[tauri::command]
pub async fn gemini_sdk_ensure_server(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    work_dir: String,
    permission_mode: Option<String>,
    effort: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    if !install::is_apple_silicon() {
        return Err("Gemini chat needs Apple Silicon".to_string());
    }
    install::ensure_runtime()?;
    install::ensure_profile()?;
    let mapped_mode = permission_mode
        .as_deref()
        .map(map_permission_mode)
        .map(|s| s.to_string());
    let config = build_config(mapped_mode, effort, model);
    let server = ensure_gemini_server(&app, state.inner(), &thread_id, &work_dir, config).await?;
    resume_or_new_session(&app, state.inner(), &server, &thread_id, &work_dir).await
}

#[tauri::command]
pub async fn gemini_sdk_restart(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    work_dir: String,
    effort: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let old = {
        let mut servers = state.gemini_servers.lock().await;
        servers.take(&thread_id)
    };
    let preserved_mode = match &old {
        Some(server) => Some(server.permission_mode_value().await),
        None => None,
    };
    if let Some(old) = old {
        old.shutdown().await;
    }
    let persisted_model = match model.filter(|s| !s.is_empty()) {
        Some(m) => Some(m),
        None => queries::get_thread(&state.db, &thread_id)
            .await
            .ok()
            .and_then(|t| t.model),
    };
    let config = build_config(preserved_mode, effort, persisted_model);
    let server = ensure_gemini_server(&app, state.inner(), &thread_id, &work_dir, config).await?;
    resume_or_new_session(&app, state.inner(), &server, &thread_id, &work_dir).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiPromptImage {
    pub data: String,
    pub media_type: String,
}

#[tauri::command]
pub async fn gemini_sdk_send_prompt(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    session_id: String,
    text: String,
    images: Option<Vec<GeminiPromptImage>>,
) -> Result<Value, String> {
    crate::teams::policy::refresh_for_execution().await?;
    crate::teams::policy::enforce_session("Gemini", "chat")?;
    let trimmed = text.trim();
    if trimmed == "/logout" {
        gemini_sdk_logout(app, state).await?;
        return Ok(serde_json::json!({ "stopReason": "logout" }));
    }

    let _ = crate::thread_turns::open_turn(
        &state.db,
        Some(&app),
        &thread_id,
        &text,
        "chat_item",
    )
    .await;

    let server = {
        let servers = state.gemini_servers.lock().await;
        servers
            .get(&thread_id)
            .ok_or_else(|| "Gemini ACP server not running for this thread".to_string())?
    };
    let result = server
        .send_prompt_blocks(&session_id, &text, images.unwrap_or_default())
        .await;
    // `send_prompt_blocks` resolves only when the turn ends. An abandoned
    // "running" row is what remote control uses to decide the session is
    // still working, so close on both success and error (same as Grok).
    let status = match &result {
        Ok(v) => {
            let stop = v
                .get("stopReason")
                .and_then(|s| s.as_str())
                .unwrap_or("EndTurn");
            if stop.eq_ignore_ascii_case("cancelled") {
                "cancelled"
            } else {
                "done"
            }
        }
        Err(_) => "failed",
    };
    let local_port = {
        let guard = state.local_llm_server.lock().await;
        guard.as_ref().map(|s| s.port())
    };
    let _ = crate::thread_turns::close_turn(&state.db, Some(&app), &thread_id, status, local_port)
        .await;
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn gemini_sdk_cancel(
    state: State<'_, AppState>,
    thread_id: String,
    session_id: String,
) -> Result<(), String> {
    let server = {
        let servers = state.gemini_servers.lock().await;
        servers
            .get(&thread_id)
            .ok_or_else(|| "Gemini ACP server not running for this thread".to_string())?
    };
    server.cancel(&session_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn gemini_sdk_set_permission_mode(
    state: State<'_, AppState>,
    thread_id: String,
    mode: String,
) -> Result<(), String> {
    let mapped = map_permission_mode(&mode).to_string();
    let server = {
        let servers = state.gemini_servers.lock().await;
        servers
            .get(&thread_id)
            .ok_or_else(|| "Gemini ACP server not running for this thread".to_string())?
    };
    server.set_permission_mode(mapped.clone()).await;
    if let Some(sid) = server.session_id_for_thread(&thread_id).await {
        let _ = server
            .set_config_option(&sid, "mode", &mapped)
            .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn gemini_sdk_set_model(
    state: State<'_, AppState>,
    thread_id: String,
    model: String,
) -> Result<(), String> {
    crate::teams::policy::refresh_for_execution().await?;
    crate::teams::policy::enforce_session("Gemini", "chat")?;
    let server = {
        let servers = state.gemini_servers.lock().await;
        servers
            .get(&thread_id)
            .ok_or_else(|| "Gemini ACP server not running for this thread".to_string())?
    };
    if let Some(sid) = server.session_id_for_thread(&thread_id).await {
        server
            .set_config_option(&sid, "model", &model)
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Ok(thread) = queries::get_thread(&state.db, &thread_id).await {
        let _ = queries::update_thread_settings(
            &state.db,
            &thread_id,
            Some(&model),
            thread.reasoning_effort.as_deref(),
            thread.fast_mode != 0,
        )
        .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn gemini_sdk_respond_approval(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    thread_id: String,
    request_id: u64,
    decision: String,
) -> Result<(), String> {
    let server = {
        let servers = state.gemini_servers.lock().await;
        servers
            .get(&thread_id)
            .ok_or_else(|| "Gemini ACP server not running for this thread".to_string())?
    };
    server
        .resolve_approval(request_id, &decision)
        .await
        .map_err(|e| e.to_string())?;
    crate::remote::notify_approval_resolved(&app_handle, &request_id.to_string(), Some(&thread_id));
    Ok(())
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GeminiAuthStatus {
    pub signed_in: bool,
    pub apple_silicon: bool,
    pub runtime_ready: bool,
    pub auth_url: Option<String>,
}

#[tauri::command]
pub async fn gemini_sdk_auth_status(
    state: State<'_, AppState>,
    thread_id: Option<String>,
) -> Result<GeminiAuthStatus, String> {
    let mut auth_url = None;
    if let Some(tid) = thread_id {
        if let Some(server) = state.gemini_servers.lock().await.get(&tid) {
            auth_url = server.take_auth_url().await;
        }
    }
    Ok(GeminiAuthStatus {
        signed_in: install::is_signed_in(),
        apple_silicon: install::is_apple_silicon(),
        runtime_ready: install::runtime_ready(),
        auth_url,
    })
}

#[tauri::command]
pub async fn gemini_sdk_sign_in(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    work_dir: String,
) -> Result<GeminiAuthStatus, String> {
    let config = GeminiSpawnConfig::default();
    let server = ensure_gemini_server(&app, state.inner(), &thread_id, &work_dir, config).await?;
    let join = {
        let s = server.clone();
        tauri::async_runtime::spawn(async move { s.authenticate_personal().await })
    };
    // Give stderr a moment to print the URL.
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let auth_url = server.take_auth_url().await;
    let _ = join.await;
    Ok(GeminiAuthStatus {
        signed_in: install::is_signed_in(),
        apple_silicon: install::is_apple_silicon(),
        runtime_ready: install::runtime_ready(),
        auth_url,
    })
}

#[tauri::command]
pub async fn gemini_sdk_logout(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let ids = {
        let servers = state.gemini_servers.lock().await;
        servers.thread_ids()
    };
    for tid in &ids {
        if let Some(server) = {
            let servers = state.gemini_servers.lock().await;
            servers.get(tid)
        } {
            let _ = server.native_logout().await;
        }
    }
    {
        let mut servers = state.gemini_servers.lock().await;
        servers.stop_all().await;
    }
    install::clear_token();
    let _ = app.emit("gemini-auth-status", serde_json::json!({ "signedIn": false }));
    Ok(())
}

#[tauri::command]
pub async fn gemini_sdk_stop_session(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), String> {
    let mut servers = state.gemini_servers.lock().await;
    servers.stop(&thread_id).await;
    Ok(())
}

#[tauri::command]
pub async fn gemini_sdk_stop_all(state: State<'_, AppState>) -> Result<(), String> {
    let mut servers = state.gemini_servers.lock().await;
    servers.stop_all().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::map_permission_mode;

    #[test]
    fn maps_ui_permission_modes_to_acp() {
        assert_eq!(map_permission_mode("bypassPermissions"), "yolo");
        assert_eq!(map_permission_mode("yolo"), "yolo");
        assert_eq!(map_permission_mode("full"), "yolo");
        assert_eq!(map_permission_mode("acceptEdits"), "auto_edit");
        assert_eq!(map_permission_mode("auto"), "auto_edit");
        assert_eq!(map_permission_mode("auto_edit"), "auto_edit");
        assert_eq!(map_permission_mode("plan"), "plan");
        assert_eq!(map_permission_mode("default"), "default");
        assert_eq!(map_permission_mode("nope"), "default");
    }
}
