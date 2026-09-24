use crate::codex::app_server::{CodexAppServer, CodexTurnReservation, ImageAttachment};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Emitter, State};

#[path = "codex_read_cache.rs"]
mod codex_read_cache;

fn session_read_cache() -> &'static codex_read_cache::ReadCache<CodexThreadLiveSnapshot> {
    static CACHE: OnceLock<codex_read_cache::ReadCache<CodexThreadLiveSnapshot>> = OnceLock::new();
    CACHE.get_or_init(codex_read_cache::ReadCache::default)
}

/// Allowed image MIME types for attachments.
const ALLOWED_IMAGE_MEDIA_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

/// Maximum decoded image size: 20 MB.
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

/// Validate a slice of image attachments.
fn validate_images(images: &[ImageAttachment]) -> Result<(), String> {
    for (i, img) in images.iter().enumerate() {
        if !ALLOWED_IMAGE_MEDIA_TYPES.contains(&img.media_type.as_str()) {
            return Err(format!(
                "Image {}: unsupported media_type '{}'. Must be one of: {}",
                i,
                img.media_type,
                ALLOWED_IMAGE_MEDIA_TYPES.join(", ")
            ));
        }
        // Estimate decoded size: base64 encodes 3 bytes as 4 chars.
        let estimated_bytes = img.data.len() * 3 / 4;
        if estimated_bytes > MAX_IMAGE_BYTES {
            return Err(format!("Image {}: decoded size exceeds 20 MB limit", i));
        }
    }
    Ok(())
}

/// Allowed model prefixes for Codex.
const ALLOWED_MODEL_PREFIXES: &[&str] = &["gpt-", "o1-", "o3-", "o4-", "codex-"];

/// Allowed reasoning effort values.
/// GPT-5.6 Sol/Terra/Luna add `max`; Sol/Terra also add `ultra`.
const ALLOWED_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max", "ultra"];

/// Allowed app-server service tiers.
const ALLOWED_SERVICE_TIERS: &[&str] = &["priority"];

/// Validate a work directory path.
fn validate_work_dir(work_dir: &str) -> Result<(), String> {
    if work_dir.is_empty() {
        return Err("work_dir must not be empty".to_string());
    }
    let path = Path::new(work_dir);
    if !path.is_absolute() {
        return Err("work_dir must be an absolute path".to_string());
    }
    if !path.exists() {
        return Err(format!("work_dir does not exist: {}", work_dir));
    }
    Ok(())
}

/// Validate a thread/session ID (UUID-like or Codex session ID).
fn validate_id(id: &str, label: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err(format!("{} must not be empty", label));
    }
    // Allow alphanumeric, hyphens, underscores (covers UUIDs and Codex IDs)
    if !id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("{} contains invalid characters", label));
    }
    if id.len() > 128 {
        return Err(format!("{} is too long", label));
    }
    Ok(())
}

/// Validate an optional model string.
fn validate_model(model: &Option<String>) -> Result<(), String> {
    if let Some(m) = model {
        if !ALLOWED_MODEL_PREFIXES.iter().any(|p| m.starts_with(p)) {
            return Err(format!("Invalid model: {}", m));
        }
    }
    Ok(())
}

/// Validate an optional effort string.
fn validate_effort(effort: &Option<String>) -> Result<(), String> {
    if let Some(e) = effort {
        if !ALLOWED_EFFORTS.contains(&e.as_str()) {
            return Err(format!(
                "Invalid effort: {}. Must be low, medium, high, xhigh, max, or ultra",
                e
            ));
        }
    }
    Ok(())
}

fn validate_service_tier(service_tier: &Option<String>) -> Result<(), String> {
    if let Some(tier) = service_tier {
        if !ALLOWED_SERVICE_TIERS.contains(&tier.as_str()) {
            return Err(format!("Invalid service tier: {}", tier));
        }
    }
    Ok(())
}

async fn codex_server_for_workspace(
    state: &State<'_, AppState>,
    app_handle: &tauri::AppHandle,
    work_dir: &str,
) -> Result<Arc<CodexAppServer>, String> {
    let project = crate::commands::memory::find_project_for_path(state.inner(), work_dir).await;
    let (project_id, repo_path) = match &project {
        Some(p) => (Some(p.project_id.as_str()), Some(p.repo_path.as_str())),
        None => (None, None),
    };
    let mut mgr = state.codex_servers.lock().await;
    mgr.get_or_spawn(app_handle, work_dir, project_id, repo_path)
        .await
}

async fn codex_server_for_thread(
    state: &State<'_, AppState>,
    app_handle: &tauri::AppHandle,
    work_dir: &str,
    thread_id: &str,
) -> Result<Arc<CodexAppServer>, String> {
    let project = crate::commands::memory::find_project_for_path(state.inner(), work_dir).await;
    let (project_id, repo_path) = match &project {
        Some(p) => (Some(p.project_id.as_str()), Some(p.repo_path.as_str())),
        None => (None, None),
    };
    state.codex_servers.lock().await
        .get_or_spawn_for_thread(app_handle, work_dir, project_id, repo_path, thread_id).await
}

async fn codex_server_for_new_turn(
    state: &State<'_, AppState>,
    app_handle: &tauri::AppHandle,
    work_dir: &str,
    thread_id: &str,
) -> Result<CodexTurnReservation, String> {
    let project = crate::commands::memory::find_project_for_path(state.inner(), work_dir).await;
    let (project_id, repo_path) = match &project {
        Some(p) => (Some(p.project_id.as_str()), Some(p.repo_path.as_str())),
        None => (None, None),
    };
    state
        .codex_servers
        .lock()
        .await
        .get_or_spawn_for_turn(app_handle, work_dir, project_id, repo_path, thread_id)
        .await
}

// ── Server lifecycle ────────────────────────────────────

/// Ensure the Codex app-server is running for a workspace. Spawns it if needed.
#[tauri::command]
pub async fn codex_ensure_server(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
) -> Result<(), String> {
    validate_work_dir(&work_dir)?;
    let _server = codex_server_for_workspace(&state, &app_handle, &work_dir).await?;
    Ok(())
}

/// Stop the Codex app-server for a specific workspace (or all if no work_dir).
#[tauri::command]
pub async fn codex_stop_server(
    state: State<'_, AppState>,
    work_dir: Option<String>,
) -> Result<(), String> {
    let mut mgr = state.codex_servers.lock().await;
    if let Some(dir) = work_dir {
        mgr.stop(&dir).await;
    } else {
        mgr.stop_all().await;
    }
    Ok(())
}

// ── Thread operations ───────────────────────────────────

/// List threads from the Codex app-server.
///
/// The raw `thread/list` RPC response has no per-thread model field, so we
/// enrich each entry with the latest `turn_context.model` from its session
/// JSONL. Reading those files is slow (up to 100 threads), so the response
/// returns immediately with whatever the in-memory cache has; uncached ids
/// are resolved in a background task that emits `codex-thread-models`
/// (`{ id: model }`) for the frontend to merge in.
#[tauri::command]
pub async fn codex_list_threads(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
) -> Result<Value, String> {
    let _debug_timer = crate::debug_mode::operation("codex_list_threads");
    validate_work_dir(&work_dir)?;
    let server = codex_server_for_workspace(&state, &app_handle, &work_dir).await?;
    let mut response = server
        .list_threads(None, Some(100))
        .await
        .map_err(|e| e.to_string())?;

    // The sidebar shares one global catalog across workspaces. A single page
    // silently omitted older chats (and their diff hydration) after 100 rows.
    let mut cursors = std::collections::HashSet::new();
    while let Some(cursor) = response["nextCursor"].as_str().filter(|s| !s.is_empty()).map(str::to_string) {
        if !cursors.insert(cursor.clone()) {
            return Err("Codex thread list repeated its pagination cursor".into());
        }
        let page = server.list_threads(Some(&cursor), Some(100)).await.map_err(|e| e.to_string())?;
        let entries = page["data"].as_array().ok_or("Codex thread list is missing data")?;
        response["data"].as_array_mut().ok_or("Codex thread list is missing data")?.extend(entries.iter().cloned());
        response["nextCursor"] = page["nextCursor"].clone();
    }

    if let Some(data) = response.get_mut("data").and_then(|d| d.as_array_mut()) {
        crate::codex::diff_stats::hydrate_discovered(&app_handle, data);
        let mut pending: Vec<String> = Vec::new();
        {
            let cache = thread_model_cache()
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            for entry in data.iter_mut() {
                let Some(obj) = entry.as_object_mut() else { continue };
                // Skip enrichment only if the server already provided a non-empty
                // model string. `contains_key` alone is too lenient: the server can
                // emit `"model": null`, which we should still enrich.
                let already_set = obj
                    .get("model")
                    .and_then(|m| m.as_str())
                    .map(|s| !s.is_empty())
                    .unwrap_or(false);
                if already_set {
                    continue;
                }
                let Some(id) = obj.get("id").and_then(|v| v.as_str()).map(str::to_string) else {
                    continue;
                };
                if let Some(model) = cache.get(&id) {
                    obj.insert("model".to_string(), Value::String(model.clone()));
                } else {
                    pending.push(id);
                }
            }
        }
        if !pending.is_empty() {
            let app = app_handle.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let Some(sessions_dir) =
                    crate::codex::cli_config::codex_home().map(|h| h.join("sessions"))
                else {
                    return;
                };
                let models = resolve_thread_models(&sessions_dir, &pending);
                if models.is_empty() {
                    return;
                }
                {
                    let mut cache = thread_model_cache()
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    for (id, model) in &models {
                        cache.insert(id.clone(), model.clone());
                    }
                }
                let _ = app.emit("codex-thread-models", &models);
            });
        }
    }

    Ok(response)
}

/// Read the effective Codex config for a workspace.
#[tauri::command]
pub async fn codex_read_config(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    let server = codex_server_for_workspace(&state, &app_handle, &work_dir).await?;
    server.read_config().await.map_err(|e| e.to_string())
}

// Creation ownership must use the newly returned thread, never the fork parent.
fn native_created_thread_id(result: &Value) -> Result<&str, String> {
    let id = result.get("thread")
        .or_else(|| result.get("result").and_then(|r| r.get("thread")))
        .and_then(|thread| thread.get("id").or_else(|| thread.get("sessionId")))
        .and_then(Value::as_str)
        .ok_or_else(|| "Codex creation response has no thread ID".to_string())?;
    validate_id(id, "created thread ID")?;
    Ok(id)
}

async fn record_native_codex_creation(pool: &sqlx::SqlitePool, result: &Value) -> Result<(), String> {
    let id = native_created_thread_id(result)?;
    crate::teams::ownership::record_origin(pool, "Codex", id, "codex", true).await?;
    crate::teams::ownership::bind_session(pool, "Codex", id, id).await
}

/// Start a new thread.
#[tauri::command]
pub async fn codex_start_thread(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
    model: Option<String>,
    base_instructions: Option<String>,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    validate_model(&model)?;
    let provisional = format!("codex-new:{}", uuid::Uuid::new_v4());
    crate::provider_accounts::remember_model("codex", &provisional, model.as_deref()).await?;
    let server = codex_server_for_thread(&state, &app_handle, &work_dir, &provisional).await?;
    let started = server
        .start_thread(
            model.as_deref(),
            Some(&work_dir),
            base_instructions.as_deref(),
        )
        .await;
    let result = match started {
        Ok(result) => result,
        Err(error) => {
            state.codex_servers.lock().await.forget_thread_route(&provisional);
            let _ = crate::provider_accounts::release(&provisional).await;
            return Err(error.to_string());
        }
    };

    if let Some(id) = result.pointer("/thread/id").and_then(Value::as_str) {
        crate::provider_accounts::bind("codex", &provisional, id).await?;
        state.codex_servers.lock().await.bind_thread(id, &server);
    }
    state.codex_servers.lock().await.forget_thread_route(&provisional);
    crate::provider_accounts::release(&provisional).await?;
    record_native_codex_creation(&state.db, &result).await?;

    // App-server returns a planned rollout `path` but does not write the file
    // until the first turn. Terminal mode immediately runs `codex resume <id>`,
    // so seed a minimal session_meta now (idempotent if the file already exists).
    if let Some(thread) = result
        .get("thread")
        .or_else(|| result.get("result").and_then(|r| r.get("thread")))
    {
        let id = thread
            .get("id")
            .or_else(|| thread.get("sessionId"))
            .and_then(|v| v.as_str());
        let path = thread.get("path").and_then(|v| v.as_str());
        let cwd = thread
            .get("cwd")
            .and_then(|v| v.as_str())
            .unwrap_or(work_dir.as_str());
        if let Some(id) = id {
            if let Err(err) =
                crate::process::spawn::ensure_codex_session_rollout(id, cwd, path)
            {
                tracing::warn!("failed to seed Codex rollout for {id}: {err}");
            }
        }
    }

    Ok(result)
}

/// Resume an existing thread.
#[tauri::command]
pub async fn codex_resume_thread(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
    thread_id: String,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    validate_id(&thread_id, "thread_id")?;
    let model = crate::provider_accounts::runtime_pty::native_model("Codex", &thread_id, &work_dir).await;
    crate::provider_accounts::remember_model("codex", &thread_id, model.as_deref()).await?;
    let server = codex_server_for_thread(&state, &app_handle, &work_dir, &thread_id).await?;
    let result = server
        .resume_thread(&thread_id)
        .await
        .map_err(|e| e.to_string())?;
    super::threads::record_native_resume(&state.db, "Codex", &thread_id, "codex", Some(&thread_id)).await?;
    Ok(result)
}

/// Fork an existing thread (branch the conversation).
#[tauri::command]
pub async fn codex_fork_thread(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
    thread_id: String,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    validate_id(&thread_id, "thread_id")?;
    let model = crate::provider_accounts::runtime_pty::native_model("Codex", &thread_id, &work_dir).await;
    crate::provider_accounts::remember_model("codex", &thread_id, model.as_deref()).await?;
    let server = codex_server_for_thread(&state, &app_handle, &work_dir, &thread_id).await?;
    let result = server
        .fork_thread(&thread_id)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(id) = result.pointer("/thread/id").and_then(Value::as_str) {
        crate::provider_accounts::bind("codex", &thread_id, id).await?;
        state.codex_servers.lock().await.bind_thread(id, &server);
    }
    record_native_codex_creation(&state.db, &result).await?;
    Ok(result)
}

/// Compact a thread's history to save context.
#[tauri::command]
pub async fn codex_compact_thread(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
    thread_id: String,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    validate_id(&thread_id, "thread_id")?;
    let server = codex_server_for_thread(&state, &app_handle, &work_dir, &thread_id).await?;
    server
        .compact_thread(&thread_id)
        .await
        .map_err(|e| e.to_string())
}

/// Set a thread's display name via app-server.
#[tauri::command]
pub async fn codex_set_thread_name(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
    thread_id: String,
    name: String,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    validate_id(&thread_id, "thread_id")?;
    if name.trim().is_empty() {
        return Err("Thread name must not be empty".to_string());
    }
    let server = codex_server_for_thread(&state, &app_handle, &work_dir, &thread_id).await?;
    server
        .set_thread_name(&thread_id, &name)
        .await
        .map_err(|e| e.to_string())
}

/// Archive a thread via app-server (in addition to local DB archive).
#[tauri::command]
pub async fn codex_archive_thread_server(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
    thread_id: String,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    validate_id(&thread_id, "thread_id")?;
    let server = codex_server_for_thread(&state, &app_handle, &work_dir, &thread_id).await?;
    server
        .archive_thread(&thread_id)
        .await
        .map_err(|e| e.to_string())
}

// ── Turn operations ─────────────────────────────────────

/// Send a user message (starts a new turn with proper sandbox/approval policies).
#[tauri::command]
pub async fn codex_send_message(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
    thread_id: String,
    text: String,
    model: Option<String>,
    effort: Option<String>,
    access_mode: Option<String>,
    images: Option<Vec<ImageAttachment>>,
    collaboration_mode: Option<Value>,
    service_tier: Option<String>,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    validate_id(&thread_id, "thread_id")?;
    validate_model(&model)?;
    validate_effort(&effort)?;
    validate_service_tier(&service_tier)?;
    if text.is_empty() {
        return Err("Message text must not be empty".to_string());
    }
    if let Some(ref imgs) = images {
        validate_images(imgs)?;
    }

    let requested_model = match collaboration_mode.as_ref().filter(|mode| !mode.is_null()) {
        Some(mode) => mode.pointer("/settings/model").and_then(Value::as_str),
        None => model.as_deref(),
    };
    crate::provider_accounts::remember_model("codex", &thread_id, requested_model).await?;
    let reservation =
        codex_server_for_new_turn(&state, &app_handle, &work_dir, &thread_id).await?;
    let memory_context = crate::memory::codex_turn_memory_instruction_if_available(
        &thread_id,
        crate::memory::is_enabled(),
        reservation.server().memory_mcp_configured(),
    );
    let result = reservation
        .server()
        .send_message(
            &thread_id,
            &text,
            model.as_deref(),
            effort.as_deref(),
            Some(&work_dir),
            access_mode.as_deref(),
            images.as_deref().unwrap_or(&[]),
            collaboration_mode,
            service_tier.as_deref(),
            memory_context.as_deref(),
        )
        .await;
    match result {
        Ok(value) => {
            reservation.commit(&value);
            Ok(value)
        }
        Err(error) => Err(error.to_string()),
    }
}

/// Steer a running turn mid-execution (proper `turn/steer` JSON-RPC method).
#[tauri::command]
pub async fn codex_steer_turn(
    state: State<'_, AppState>,
    _app_handle: tauri::AppHandle,
    work_dir: String,
    thread_id: String,
    turn_id: String,
    text: String,
    images: Option<Vec<ImageAttachment>>,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    validate_id(&thread_id, "thread_id")?;
    validate_id(&turn_id, "turn_id")?;
    if text.is_empty() {
        return Err("Steer text must not be empty".to_string());
    }
    if let Some(ref imgs) = images {
        validate_images(imgs)?;
    }

    let server = state.codex_servers.lock().await.get_for_thread(&work_dir, &thread_id)
        .ok_or_else(|| "Codex thread server is not running".to_string())?;
    server
        .steer_turn(
            &thread_id,
            &turn_id,
            &text,
            images.as_deref().unwrap_or(&[]),
        )
        .await
        .map_err(|e| e.to_string())
}

/// Interrupt the current turn.
#[tauri::command]
pub async fn codex_interrupt_turn(
    state: State<'_, AppState>,
    _app_handle: tauri::AppHandle,
    work_dir: String,
    thread_id: String,
    turn_id: String,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    validate_id(&thread_id, "thread_id")?;
    validate_id(&turn_id, "turn_id")?;

    let server = state.codex_servers.lock().await.get_for_thread(&work_dir, &thread_id)
        .ok_or_else(|| "Codex thread server is not running".to_string())?;
    server
        .interrupt_turn(&thread_id, &turn_id)
        .await
        .map_err(|e| e.to_string())
}

/// Respond to a server request (e.g., approve a command).
#[tauri::command]
pub async fn codex_respond_to_request(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
    request_id: u64,
    result: Value,
) -> Result<(), String> {
    validate_work_dir(&work_dir)?;
    let server = state.codex_servers.lock().await.get_for_request(&work_dir, request_id)
        .ok_or_else(|| "Codex approval is no longer pending".to_string())?;
    // Scope the phone resolve to the raising thread: without it, two pending
    // requests sharing this id made the resolve ambiguous and it was dropped.
    let thread_id = server.request_thread(request_id);
    server
        .respond_to_request(request_id, result)
        .await
        .map_err(|e| e.to_string())?;
    crate::remote::notify_approval_resolved(&app_handle, &request_id.to_string(), thread_id.as_deref());
    crate::remote::notify_user_input_resolved(&app_handle, &request_id.to_string(), thread_id.as_deref());
    Ok(())
}

// ── Other operations ────────────────────────────────────

/// List available models.
#[tauri::command]
pub async fn codex_list_models(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    let server = codex_server_for_workspace(&state, &app_handle, &work_dir).await?;
    server.list_models().await.map_err(|e| e.to_string())
}

/// List available collaboration modes (e.g., "default", "plan").
#[tauri::command]
pub async fn codex_list_collaboration_modes(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    let server = codex_server_for_workspace(&state, &app_handle, &work_dir).await?;
    server
        .list_collaboration_modes()
        .await
        .map_err(|e| e.to_string())
}

/// Read a thread's current state (model, effort, collaboration mode, etc.).
#[tauri::command]
pub async fn codex_read_thread(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
    thread_id: String,
) -> Result<Value, String> {
    let _debug_timer = crate::debug_mode::operation("codex_read_thread");
    validate_work_dir(&work_dir)?;
    validate_id(&thread_id, "thread_id")?;
    let server = codex_server_for_thread(&state, &app_handle, &work_dir, &thread_id).await?;
    server
        .read_thread(&thread_id)
        .await
        .map_err(|e| e.to_string())
}

// ── Approval rules, account, login, MCP status ──────
//
// Codex itself has no project-scoped command allowlist, so agmux owns this:
// rules live in `codex_approval_rules` (SQLite) and are mirrored into the
// running app-server's in-memory cache. The read loop in
// `codex/app_server.rs` short-circuits matching exec approvals before they
// reach the frontend.

/// List allowlist rules for a workspace. Also pushes them into the running
/// server's in-memory cache so the read-loop interceptor stays in sync after
/// a restart or thread switch.
#[tauri::command]
pub async fn codex_list_approval_rules(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
) -> Result<Vec<crate::db::models::CodexApprovalRule>, String> {
    validate_work_dir(&work_dir)?;
    let rules = crate::db::queries::list_codex_approval_rules(&state.db, &work_dir)
        .await
        .map_err(|e| e.to_string())?;
    let server = codex_server_for_workspace(&state, &app_handle, &work_dir).await?;
    server.set_approval_rules(rules.iter().map(|r| r.pattern.clone()).collect()).await;
    for server in state.codex_servers.lock().await.workspace_servers(&work_dir) {
        server.set_approval_rules(rules.iter().map(|r| r.pattern.clone()).collect()).await;
    }
    Ok(rules)
}

/// Persist a new "always allow" pattern and update the in-memory cache.
#[tauri::command]
pub async fn codex_add_approval_rule(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
    pattern: String,
) -> Result<crate::db::models::CodexApprovalRule, String> {
    validate_work_dir(&work_dir)?;
    let pattern = pattern.trim().to_string();
    if pattern.is_empty() {
        return Err("pattern must not be empty".to_string());
    }
    if pattern.len() > 200 {
        return Err("pattern is too long (max 200 chars)".to_string());
    }
    let rule = crate::db::queries::add_codex_approval_rule(&state.db, &work_dir, &pattern)
        .await
        .map_err(|e| e.to_string())?;
    let server = codex_server_for_workspace(&state, &app_handle, &work_dir).await?;
    server.add_approval_rule(rule.pattern.clone()).await;
    for server in state.codex_servers.lock().await.workspace_servers(&work_dir) {
        server.add_approval_rule(rule.pattern.clone()).await;
    }
    Ok(rule)
}

/// Remove a rule by id. Also drops it from the in-memory cache so the next
/// matching exec approval will once again prompt the user.
#[tauri::command]
pub async fn codex_remove_approval_rule(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
    id: String,
) -> Result<u64, String> {
    validate_work_dir(&work_dir)?;
    if id.is_empty() {
        return Err("id must not be empty".to_string());
    }
    // Look up the pattern before deleting so we can refresh the in-memory
    // cache; otherwise the rule would still auto-approve until the server
    // restarts.
    let existing = crate::db::queries::list_codex_approval_rules(&state.db, &work_dir)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|r| r.id == id);
    let removed = crate::db::queries::delete_codex_approval_rule(&state.db, &id)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(rule) = existing {
        let server = codex_server_for_workspace(&state, &app_handle, &work_dir).await?;
        server.remove_approval_rule(&rule.pattern).await;
        for server in state.codex_servers.lock().await.workspace_servers(&work_dir) {
            server.remove_approval_rule(&rule.pattern).await;
        }
    }
    Ok(removed)
}

/// Generate "Always allow X" suggestions for a command. Pure function — no
/// state, no I/O — so the frontend can call it freely as approvals arrive.
#[tauri::command]
pub fn codex_suggest_approval_patterns(command: String) -> Vec<String> {
    crate::codex::approval_rules::suggest_patterns(&command)
}

#[derive(Serialize)]
pub struct CodexCustomPrompt {
    pub name: String,
}

/// Scan a directory for `*.md` files and return them as `/<stem>` slash command
/// names, sorted alphabetically. Missing directory returns an empty vec.
fn scan_prompts_dir(prompts_dir: &Path) -> Result<Vec<CodexCustomPrompt>, String> {
    if !prompts_dir.is_dir() {
        return Ok(Vec::new());
    }
    let entries = std::fs::read_dir(prompts_dir).map_err(|e| e.to_string())?;
    let mut out: Vec<CodexCustomPrompt> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            if !stem.is_empty() {
                out.push(CodexCustomPrompt {
                    name: format!("/{stem}"),
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// List user-defined Codex slash commands found in `$CODEX_HOME/prompts/*.md`
/// (defaulting to `~/.codex/prompts/`). Each `<name>.md` becomes `/<name>`.
#[tauri::command]
pub async fn codex_list_custom_prompts() -> Result<Vec<CodexCustomPrompt>, String> {
    let codex_home = match std::env::var_os("CODEX_HOME") {
        Some(v) => std::path::PathBuf::from(v),
        None => match dirs::home_dir() {
            Some(h) => h.join(".codex"),
            None => return Ok(Vec::new()),
        },
    };
    scan_prompts_dir(&codex_home.join("prompts"))
}

#[cfg(test)]
mod prompts_tests {
    use super::*;
    use std::fs;

    #[test]
    fn returns_empty_when_dir_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let result = scan_prompts_dir(&tmp.path().join("prompts")).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn lists_md_files_with_slash_prefix_sorted() {
        let tmp = tempfile::tempdir().unwrap();
        let prompts = tmp.path().join("prompts");
        fs::create_dir_all(&prompts).unwrap();
        fs::write(prompts.join("zebra.md"), "z").unwrap();
        fs::write(prompts.join("alpha.md"), "a").unwrap();
        fs::write(prompts.join("ignored.txt"), "x").unwrap();
        let names: Vec<String> = scan_prompts_dir(&prompts)
            .unwrap()
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, vec!["/alpha".to_string(), "/zebra".to_string()]);
    }

    #[test]
    fn validate_effort_accepts_known_levels() {
        for value in ["low", "medium", "high", "xhigh", "max", "ultra"] {
            assert!(
                validate_effort(&Some(value.to_string())).is_ok(),
                "expected {value} to be accepted",
            );
        }
        assert!(validate_effort(&None).is_ok());
    }

    #[test]
    fn validate_effort_rejects_unknown_value() {
        let err = validate_effort(&Some("ludicrous".to_string())).unwrap_err();
        assert!(err.contains("ultra"), "error should mention ultra: {err}");
    }

    #[test]
    fn validate_service_tier_accepts_priority() {
        assert!(validate_service_tier(&Some("priority".to_string())).is_ok());
        assert!(validate_service_tier(&None).is_ok());
    }

    #[test]
    fn validate_service_tier_rejects_unknown_value() {
        let err = validate_service_tier(&Some("fast".to_string())).unwrap_err();
        assert!(err.contains("Invalid service tier"), "unexpected error: {err}");
    }

    #[test]
    fn extracts_reasoning_summary_object_text() {
        let payload = serde_json::json!({
            "type": "reasoning",
            "summary": [
                { "type": "summary_text", "text": "Checked the relevant files" },
                { "type": "summary_text", "text": "Planned the patch" }
            ],
            "encrypted_content": "opaque"
        });
        assert_eq!(
            extract_reasoning_summary_text(&payload),
            Some("Checked the relevant files\nPlanned the patch".to_string())
        );
    }

    #[test]
    fn converts_response_items_to_generic_history_tools() {
        let timestamp = "2026-06-05T10:00:00Z";
        let cases = [
            (
                serde_json::json!({
                    "type": "web_search_call",
                    "status": "completed",
                    "action": { "type": "search", "query": "codex app-server", "queries": null }
                }),
                "WebSearch",
                "codex app-server",
            ),
            (
                serde_json::json!({
                    "type": "tool_search_call",
                    "status": "completed",
                    "execution": "client",
                    "arguments": { "query": "browser tools" }
                }),
                "ToolSearch",
                "browser tools",
            ),
            (
                serde_json::json!({
                    "type": "image_generation_call",
                    "status": "completed",
                    "revised_prompt": "A crisp app screenshot",
                    "result": "generated.png"
                }),
                "ImageGeneration",
                "generated.png",
            ),
            (
                serde_json::json!({
                    "type": "function_call",
                    "name": "mcp__docs__search",
                    "arguments": "{\"q\":\"codex\"}",
                    "call_id": "call_1"
                }),
                "mcp__docs__search",
                "codex",
            ),
        ];

        for (payload, expected_name, expected_text) in cases {
            let item = history_tool_item_from_response_item(&payload, timestamp).unwrap();
            assert_eq!(item.role, "tool");
            assert_eq!(item.tool_name.as_deref(), Some(expected_name));
            assert!(
                item.content.contains(expected_text)
                    || item
                        .tool_input
                        .as_ref()
                        .map(|v| v.to_string().contains(expected_text))
                        .unwrap_or(false),
                "expected {expected_text} in {item:?}",
            );
        }
    }
}

/// Query account rate limit status.
#[tauri::command]
pub async fn codex_account_rate_limits(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    let server = codex_server_for_workspace(&state, &app_handle, &work_dir).await?;
    server
        .account_rate_limits()
        .await
        .map_err(|e| e.to_string())
}

/// Read account info (email, plan, auth status).
/// Normalizes the nested app-server response into a flat { authenticated, email, plan }.
#[tauri::command]
pub async fn codex_account_read(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    let server = codex_server_for_workspace(&state, &app_handle, &work_dir).await?;
    let raw = server.account_read().await.map_err(|e| e.to_string())?;

    // App-server returns { account: { type, email, planType } } or { account: null }
    let account = raw.get("account").filter(|v| v.is_object());
    let authenticated = account.is_some();
    let email = account
        .and_then(|a| a.get("email"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let plan = account
        .and_then(|a| a.get("planType").or_else(|| a.get("plan_type")))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    Ok(serde_json::json!({
        "authenticated": authenticated,
        "email": if email.is_empty() { None } else { Some(email) },
        "plan": if plan.is_empty() { None } else { Some(plan) },
    }))
}

/// Initiate Codex OAuth login flow (opens browser for authorization).
#[tauri::command]
pub async fn codex_login(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    let server = codex_server_for_workspace(&state, &app_handle, &work_dir).await?;
    let result = server.login().await.map_err(|e| e.to_string())?;

    // Open authorization URL in system browser (server may use either field name)
    let url = result.get("authorizationUrl").and_then(|v| v.as_str())
        .or_else(|| result.get("authUrl").and_then(|v| v.as_str()));
    if let Some(url) = url {
        use tauri_plugin_opener::OpenerExt;
        if let Err(e) = app_handle.opener().open_url(url, None::<&str>) {
            tracing::warn!("Failed to open browser for Codex login: {}", e);
        }
    }

    Ok(result)
}

/// Cancel an in-flight login.
#[tauri::command]
pub async fn codex_login_cancel(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
    login_id: String,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    validate_id(&login_id, "login_id")?;
    let server = codex_server_for_workspace(&state, &app_handle, &work_dir).await?;
    server
        .login_cancel(&login_id)
        .await
        .map_err(|e| e.to_string())
}

/// List MCP server connection statuses.
#[tauri::command]
pub async fn codex_list_mcp_server_status(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    work_dir: String,
) -> Result<Value, String> {
    validate_work_dir(&work_dir)?;
    let server = codex_server_for_workspace(&state, &app_handle, &work_dir).await?;
    server
        .list_mcp_server_status()
        .await
        .map_err(|e| e.to_string())
}

// ── Session History (reads JSONL files from ~/.codex/sessions/) ──────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionHistoryItem {
    pub role: String, // "user", "assistant", "command", "file", "thinking"
    pub content: String,
    pub timestamp: String,
    pub file_path: Option<String>,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub tool_name: Option<String>,
    pub tool_input: Option<Value>,
    pub tool_error: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionHistoryResult {
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub items: Vec<SessionHistoryItem>,
    /// Model context window size from API (tokens), if available.
    pub model_context_window: Option<u64>,
    /// Last-turn input tokens (context-window fill). Prefer `last_token_usage`.
    pub input_tokens: Option<u64>,
    /// Last-turn output tokens.
    pub output_tokens: Option<u64>,
    /// Last-turn cached input tokens, if available.
    #[serde(default)]
    pub cached_input_tokens: Option<u64>,
    /// Session-cumulative input tokens from `total_token_usage`.
    #[serde(default)]
    pub total_input_tokens: Option<u64>,
    /// Session-cumulative output tokens.
    #[serde(default)]
    pub total_output_tokens: Option<u64>,
    /// Session-cumulative cached input tokens.
    #[serde(default)]
    pub total_cached_input_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexPendingQuestion {
    pub id: String,
    pub summary: String,
}

/// Live model + token usage re-scanned from a Codex session JSONL.
/// Used by terminal mode (no app-server attach) to keep the top bar in sync.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CodexThreadLiveSnapshot {
    #[serde(default)]
    pub pending_question: Option<CodexPendingQuestion>,
    pub model: Option<String>,
    pub model_context_window: Option<u64>,
    /// Last-turn input tokens — fills the context meter.
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub total_input_tokens: Option<u64>,
    pub total_output_tokens: Option<u64>,
    pub total_cached_input_tokens: Option<u64>,
    /// True when the JSONL has a `task_started` with no later completion or abort.
    /// Terminal mode uses this as the source of truth for the working spinner
    /// (PTY idle gaps of 10–20s are normal while Codex thinks/tools).
    #[serde(default)]
    pub task_active: bool,
    /// RFC3339 timestamp of the latest `event_msg` `task_started`, if any.
    #[serde(default)]
    pub last_task_started_at: Option<String>,
    /// RFC3339 timestamp of the latest `event_msg` completion or abort, if any.
    #[serde(default)]
    pub last_task_complete_at: Option<String>,
}

/// Parse a Codex `token_count` info object (or payload) into last/total usage.
/// Real session files nest counters under `last_token_usage` / `total_token_usage`
/// (or camelCase equivalents). Older flat shapes are still accepted.
fn apply_token_count_fields(
    source: &Value,
    model_context_window: &mut Option<u64>,
    input_tokens: &mut Option<u64>,
    output_tokens: &mut Option<u64>,
    cached_input_tokens: &mut Option<u64>,
    total_input_tokens: &mut Option<u64>,
    total_output_tokens: &mut Option<u64>,
    total_cached_input_tokens: &mut Option<u64>,
) {
    if let Some(mcw) = source
        .get("model_context_window")
        .or_else(|| source.get("modelContextWindow"))
        .and_then(|v| v.as_u64())
    {
        *model_context_window = Some(mcw);
    }

    let last = source
        .get("last_token_usage")
        .or_else(|| source.get("lastTokenUsage"))
        .or_else(|| source.get("last"));
    let total = source
        .get("total_token_usage")
        .or_else(|| source.get("totalTokenUsage"))
        .or_else(|| source.get("total"));

    if let Some(last) = last {
        if let Some(inp) = last
            .get("input_tokens")
            .or_else(|| last.get("inputTokens"))
            .and_then(|v| v.as_u64())
        {
            *input_tokens = Some(inp);
        }
        if let Some(out) = last
            .get("output_tokens")
            .or_else(|| last.get("outputTokens"))
            .and_then(|v| v.as_u64())
        {
            *output_tokens = Some(out);
        }
        if let Some(cached) = last
            .get("cached_input_tokens")
            .or_else(|| last.get("cachedInputTokens"))
            .and_then(|v| v.as_u64())
        {
            *cached_input_tokens = Some(cached);
        }
    } else {
        // Flat legacy shape: counters directly on info/payload.
        if let Some(inp) = source
            .get("input_tokens")
            .or_else(|| source.get("inputTokens"))
            .and_then(|v| v.as_u64())
        {
            *input_tokens = Some(inp);
        }
        if let Some(out) = source
            .get("output_tokens")
            .or_else(|| source.get("outputTokens"))
            .and_then(|v| v.as_u64())
        {
            *output_tokens = Some(out);
        }
        if let Some(cached) = source
            .get("cached_input_tokens")
            .or_else(|| source.get("cachedInputTokens"))
            .and_then(|v| v.as_u64())
        {
            *cached_input_tokens = Some(cached);
        }
    }

    if let Some(total) = total {
        if let Some(inp) = total
            .get("input_tokens")
            .or_else(|| total.get("inputTokens"))
            .and_then(|v| v.as_u64())
        {
            *total_input_tokens = Some(inp);
        }
        if let Some(out) = total
            .get("output_tokens")
            .or_else(|| total.get("outputTokens"))
            .and_then(|v| v.as_u64())
        {
            *total_output_tokens = Some(out);
        }
        if let Some(cached) = total
            .get("cached_input_tokens")
            .or_else(|| total.get("cachedInputTokens"))
            .and_then(|v| v.as_u64())
        {
            *total_cached_input_tokens = Some(cached);
        }
    }
}

#[derive(Debug, Clone)]
struct PendingHistoryFileChange {
    path: String,
    diff: String,
    additions: u32,
    deletions: u32,
}

fn history_diff_body_lines(diff: &str) -> impl Iterator<Item = &str> {
    let mut body = false;
    diff.lines().filter(move |line| {
        if line.starts_with("@@") || line.starts_with("*** ") { body = true; }
        body || !(line.starts_with("+++") || line.starts_with("---"))
    })
}

fn history_patch_edit_lines(diff: &str) -> Vec<&str> {
    let lines: Vec<_> = history_diff_body_lines(diff).collect();
    let mut edits = Vec::new();
    // Unified diffs can slide an unchanged boundary blank from before an
    // insertion to after it. Canonicalize only boundary blanks within a run
    // of the same sign; preserve counts, internal blanks and all other text.
    let mut start = 0;
    while start < lines.len() {
        if !lines[start].starts_with('+') && !lines[start].starts_with('-') {
            start += 1;
            continue;
        }
        let sign = lines[start].as_bytes()[0];
        let end = start + lines[start..].iter()
            .take_while(|line| line.as_bytes().first() == Some(&sign)).count();
        let leading_blanks = lines[start..end].iter().take_while(|line| line.len() == 1).count();
        edits.extend_from_slice(&lines[start + leading_blanks..end]);
        edits.extend_from_slice(&lines[start..start + leading_blanks]);
        start = end;
    }
    edits
}

// Adjacent +/- lines describe one replacement, regardless of their interleaving.
// Recover unchanged lines with a bounded ordered LCS, retaining both before and
// after order. Never compare unordered edit bags or just addition/deletion totals.
fn normalize_history_patch_ops<'a>(raw: &[(u8, &'a str)], include_context: bool) -> Option<Vec<(u8, &'a str)>> {
    let mut ops = Vec::new();
    let mut index = 0;
    while index < raw.len() {
        let in_block = |op| matches!(op, b'+' | b'-') || (include_context && op == b' ');
        if !in_block(raw[index].0) { ops.push(raw[index]); index += 1; continue; }
        let start = index;
        while index < raw.len() && in_block(raw[index].0) { index += 1; }
        let old: Vec<_> = raw[start..index].iter().filter(|op| op.0 != b'+').map(|op| op.1).collect();
        let new: Vec<_> = raw[start..index].iter().filter(|op| op.0 != b'-').map(|op| op.1).collect();
        let width = new.len() + 1;
        let cells = (old.len() + 1) * width;
        if cells > 1024 * 1024 { return None; }
        let mut lengths = vec![0u16; cells];
        for i in (0..old.len()).rev() {
            for j in (0..new.len()).rev() {
                lengths[i * width + j] = if old[i] == new[j] {
                    1 + lengths[(i + 1) * width + j + 1]
                } else {
                    lengths[(i + 1) * width + j].max(lengths[i * width + j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < old.len() || j < new.len() {
            if i < old.len() && j < new.len() && old[i] == new[j] {
                ops.push((b' ', old[i])); i += 1; j += 1;
            } else if i < old.len() && (j == new.len() || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
                ops.push((b'-', old[i])); i += 1;
            } else {
                ops.push((b'+', new[j])); j += 1;
            }
        }
    }
    Some(ops)
}

fn history_patch_variants(diff: &str) -> Option<std::collections::HashSet<Vec<(u8, &str)>>> {
    if diff.len() > 64 * 1024 { return None; }
    let mut raw = Vec::new();
    for line in history_diff_body_lines(diff) {
        let op = if line.starts_with("@@") || line.starts_with("***") {
            (b'|', "") // Context must never cross a hunk boundary.
        } else if matches!(line.as_bytes().first(), Some(b' ' | b'+' | b'-')) {
            (line.as_bytes()[0], &line[1..])
        } else { continue; };
        raw.push(op);
        if raw.len() > 2048 { return None; }
    }
    let ops = normalize_history_patch_ops(&raw, false)?;
    let mut variants = std::collections::HashSet::new();
    let mut seen = std::collections::HashSet::from([ops.clone()]);
    let mut queue = std::collections::VecDeque::from([ops]);
    // Diff engines may anchor repeated context at a different occurrence.
    // Re-diff the observed whole hunk as another equivalent starting state.
    // Hunk separators prevent borrowing context from an unrelated edit.
    if let Some(hunks) = normalize_history_patch_ops(&raw, true) {
        if seen.insert(hunks.clone()) { queue.push_back(hunks); }
    }
    while let Some(ops) = queue.pop_front() {
        let mut edits = Vec::new();
        let mut blanks_normalized = Vec::new();
        let mut enqueue = |shifted: Vec<_>| -> Option<()> {
            let shifted = normalize_history_patch_ops(&shifted, false)?;
            if seen.insert(shifted.clone()) {
                if seen.len() > 128 { return None; }
                queue.push_back(shifted);
            }
            Some(())
        };
        let mut index = 0;
        while index < ops.len() {
            if !matches!(ops[index].0, b'+' | b'-') { index += 1; continue; }
            let start = index;
            let sign = ops[index].0;
            while index < ops.len() && ops[index].0 == sign { index += 1; }
            let run = &ops[start..index];
            edits.extend_from_slice(run);
            let blanks = run.iter().take_while(|op| op.1.is_empty()).count();
            blanks_normalized.extend(run[blanks..].iter().chain(&run[..blanks]).copied());
            let mut before = start;
            while before > 0 && ops[before - 1].0 == b' ' { before -= 1; }
            let mut after = index;
            while after < ops.len() && ops[after].0 == b' ' { after += 1; }
            // =C +B +C and +C +B =C have the same before/after text.
            // Move the context too: independent run rotations could reuse it
            // on both sides and incorrectly combine incompatible shifts.
            for count in 1..=run.len().min(start - before) {
                if run[run.len() - count..].iter().map(|op| op.1).eq(ops[start - count..start].iter().map(|op| op.1)) {
                    enqueue(ops[..start - count].iter().chain(&run[run.len() - count..])
                        .chain(&run[..run.len() - count]).chain(&ops[start - count..start])
                        .chain(&ops[index..]).copied().collect())?;
                }
            }
            for count in 1..=run.len().min(after - index) {
                if run[..count].iter().map(|op| op.1).eq(ops[index..index + count].iter().map(|op| op.1)) {
                    enqueue(ops[..start].iter().chain(&ops[index..index + count])
                        .chain(&run[count..]).chain(&run[..count]).chain(&ops[index + count..]).copied().collect())?;
                }
            }
        }
        if !edits.is_empty() {
            variants.insert(edits);
            variants.insert(blanks_normalized);
        }
    }
    (!variants.is_empty()).then_some(variants)
}

fn history_patches_equivalent(left: &str, right: &str) -> bool {
    let left_edits = history_patch_edit_lines(left);
    if !left_edits.is_empty() && left_edits == history_patch_edit_lines(right) { return true; }
    let (Some(left), Some(right)) = (history_patch_variants(left), history_patch_variants(right)) else { return false; };
    left.iter().any(|variant| right.contains(variant))
}

struct PendingExecHistoryPatch {
    call_id: String,
    change: PendingHistoryFileChange,
    native_handled: bool,
    output_handled: bool,
    output_index: Option<usize>,
}

struct PendingExecPatchOwner {
    call_id: String,
    turn_id: String,
    native: Option<Value>,
    read: Option<RetainedHistoryRead>,
}

struct RetainedHistoryRead {
    paths: Vec<String>,
    content: String,
    turn_id: String,
}

fn retained_history_read(source: &str, output: &Value, cwd: &str) -> Option<RetainedHistoryRead> {
    let args = source.trim().strip_prefix("text(await tools.exec_command({")?.trim_start();
    let args = args.strip_prefix("cmd:").or_else(|| args.strip_prefix("\"cmd\":"))?.trim_start();
    let mut literal = serde_json::Deserializer::from_str(args).into_iter::<String>();
    let command = literal.next()?.ok()?;
    static TAIL: OnceLock<regex::Regex> = OnceLock::new();
    if !TAIL.get_or_init(|| regex::Regex::new(
        r#"^,\s*"?max_output_tokens"?:\s*[0-9]+\s*\}\)\);(?:\s*text\(ALL_TOOLS\.filter\(x=>/[A-Za-z0-9_|]+/\.test\(x\.name\)\)\);)?\s*$"#
    ).unwrap()).is_match(args.get(literal.byte_offset()..)?) { return None; }
    let mut paths = Vec::new();
    for command in command.split(';') {
        let command = command.trim();
        if let Some(path) = command.strip_prefix("cat ") {
            if !path.bytes().all(|c| c.is_ascii_alphanumeric() || b"_./-".contains(&c))
                || path.split('/').any(|part| part == "..") { return None; }
            let path = std::path::Path::new(cwd).join(path);
            if !path.is_absolute() { return None; }
            paths.push(path.to_string_lossy().into_owned());
        } else {
            // Only allow the observed trailing numbered search after two cats;
            // the second cat's native diff will bound the first file below.
            static SEARCH: OnceLock<regex::Regex> = OnceLock::new();
            if paths.len() != 2 || !SEARCH.get_or_init(|| regex::Regex::new(
                r"^rg -n '[A-Za-z0-9_:]+' [A-Za-z0-9_./-]+$"
            ).unwrap()).is_match(command) { return None; }
        }
    }
    if paths.is_empty() || paths.len() > 2 { return None; }
    let blocks = output["output"].as_array()?;
    if !blocks.first()?["text"].as_str()?.starts_with("Script completed\n") { return None; }
    let result: Value = serde_json::from_str(blocks.get(1)?["text"].as_str()?).ok()?;
    if result["exit_code"] != 0 { return None; }
    let content = result["output"].as_str()?;
    if content.len() > 64 * 1024 || content.contains("truncated") { return None; }
    Some(RetainedHistoryRead { paths, content: content.to_string(),
        turn_id: output["internal_chat_message_metadata_passthrough"]["turn_id"].as_str()?.to_string() })
}

// The extra context is read from retained command output, never today's disk.
// Check every native before-line at its recorded line number before using it.
fn native_diff_hunks(diff: &str) -> Option<Vec<(usize, Vec<&str>, Vec<&str>)>> {
    if diff.len() > 64 * 1024 { return None; }
    static HEADER: OnceLock<regex::Regex> = OnceLock::new();
    let header = HEADER.get_or_init(|| regex::Regex::new(r"^@@ -([0-9]+)(?:,([0-9]+))? \+[0-9]+(?:,[0-9]+)? @@").unwrap());
    let lines: Vec<_> = diff.lines().collect();
    if lines.len() > 2048 { return None; }
    let mut hunks = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let captures = header.captures(lines[index])?;
        let start = captures[1].parse::<usize>().ok()?.checked_sub(1)?;
        let count = captures.get(2).map(|v| v.as_str().parse::<usize>()).transpose().ok()?.unwrap_or(1);
        let begin = index;
        index += 1;
        let mut old = Vec::new();
        while index < lines.len() && !lines[index].starts_with("@@") {
            let line = lines[index];
            if line.starts_with(' ') || line.starts_with('-') { old.push(&line[1..]); }
            else if !line.starts_with('+') && !line.starts_with("\\ No newline") { return None; }
            index += 1;
        }
        if old.len() != count { return None; }
        hunks.push((start, old, lines[begin..index].to_vec()));
    }
    (!hunks.is_empty()).then_some(hunks)
}

impl RetainedHistoryRead {
    fn native_context(&self, native: &Value) -> Option<(String, String)> {
        let lines: Vec<_> = self.content.lines().collect();
        if lines.len() > 4096 { return None; }
        let matches = |hunks: &[(usize, Vec<&str>, Vec<&str>)], offset: usize| hunks.iter().all(|(start, old, _)| {
            start.checked_add(offset).and_then(|at| at.checked_add(old.len()).map(|end| (at, end)))
                .is_some_and(|(at, end)| lines.get(at..end) == Some(old.as_slice()))
        });
        let end = if let Some(second) = self.paths.get(1) {
            // Concatenated cat output has no separator. Require a unique offset
            // matching ALL recorded native before-hunks of the second file.
            let hunks = native_diff_hunks(native["changes"][second]["unified_diff"].as_str()?)?;
            if !hunks.iter().any(|(_, old, _)| !old.is_empty()) { return None; }
            let offsets: Vec<_> = (1..lines.len()).filter(|at| matches(&hunks, *at)).take(2).collect();
            if offsets.len() != 1 { return None; }
            offsets[0]
        } else { lines.len() };
        let path = &self.paths[0];
        let hunks = native_diff_hunks(native["changes"][path]["unified_diff"].as_str()?)?;
        if !matches(&hunks, 0) { return None; }
        let mut extended = Vec::new();
        for (index, (start, old, original)) in hunks.iter().enumerate() {
            let after = start.checked_add(old.len())?;
            let bound = hunks.get(index + 1).map(|h| h.0).unwrap_or(end).min(end);
            if after > bound { return None; }
            extended.extend(original.iter().map(|line| line.to_string()));
            extended.extend(lines[after..bound.min(after + 2)].iter().map(|line| format!(" {line}")));
        }
        Some((path.clone(), extended.join("\n")))
    }
}

fn history_read_only_shell(command: &str) -> bool {
    static READ_ONLY: OnceLock<regex::Regex> = OnceLock::new();
    let read_only = READ_ONLY.get_or_init(|| regex::Regex::new(
        r"^(cat [A-Za-z0-9_./ -]+|sed -n '[0-9]+(,[0-9]+)?p' [A-Za-z0-9_./-]+)$"
    ).unwrap());
    command.split(';').all(|part| read_only.is_match(part.trim()))
}

fn history_patch_absolute_path(cwd: &str, file: &str) -> Option<String> {
    let path = std::path::Path::new(file);
    if path.is_absolute() { return Some(file.to_string()); }
    if !std::path::Path::new(cwd).is_absolute()
        || !path.components().all(|part| matches!(part, std::path::Component::Normal(_))) { return None; }
    Some(std::path::Path::new(cwd).join(path).to_string_lossy().into_owned())
}

impl PendingExecPatchOwner {
    fn verified_native_id(&self, source: &str, patches: &[String], output: &Value, cwd: &str) -> Option<String> {
        if patches.len() != 1 || output["internal_chat_message_metadata_passthrough"]["turn_id"].as_str() != Some(&self.turn_id) {
            return None;
        }
        // A deliberately narrow provenance rule: one leading literal patch,
        // followed only by simple reads. Test commands can themselves produce
        // patches, so they cannot establish exclusive ownership. The parser has
        // already validated the entire wrapper and its successful printed result.
        let rest = source.trim().strip_prefix("text(await tools.apply_patch(")?;
        let mut literal = serde_json::Deserializer::from_str(rest).into_iter::<String>();
        if literal.next()?.ok()? != patches[0] { return None; }
        let tail = rest.get(literal.byte_offset()..)?.trim_start().strip_prefix("));")?.trim();
        if !tail.is_empty() {
            let mut commands = tail.split("text(await tools.exec_command(");
            if commands.next()? != "" { return None; }
            for command in commands {
                let args = command.trim_start().strip_prefix('{')?.trim_start();
                let args = args.strip_prefix("cmd:").or_else(|| args.strip_prefix("\"cmd\":"))?.trim_start();
                let mut literal = serde_json::Deserializer::from_str(args).into_iter::<String>();
                let cmd = literal.next()?.ok()?;
                if !history_read_only_shell(&cmd) { return None; }
                let metadata = args.get(literal.byte_offset()..)?;
                static OPTIONS: OnceLock<regex::Regex> = OnceLock::new();
                if !OPTIONS.get_or_init(|| regex::Regex::new(
                    r#"^(?:,\s*(?:max_output_tokens|yield_time_ms|"max_output_tokens"|"yield_time_ms")\s*:\s*[0-9]+)*\s*\}\)\);\s*$"#
                ).unwrap()).is_match(metadata) { return None; }
            }
        }
        let native = self.native.as_ref()?;
        let native_changes = native["changes"].as_object()?;
        let changes = parse_apply_patch_history_changes(&patches[0]);
        let paths = changes.iter().map(|change| history_patch_absolute_path(cwd, &change.path))
            .collect::<Option<std::collections::HashSet<_>>>()?;
        if paths.is_empty() || paths.len() != changes.len() || paths.len() != native_changes.len()
            || !paths.iter().all(|path| native_changes.contains_key(path))
            || file_changes_from_patch_apply_end(native).len() != paths.len() { return None; }
        native["call_id"].as_str().map(str::to_string)
    }
}

#[derive(Debug, Clone)]
struct PendingExecCommand {
    index: usize, // index into items vec
    cmd: String,
}

#[derive(Debug, Clone)]
struct PendingApplyPatchCall {
    timestamp: String,
    changes: Vec<PendingHistoryFileChange>,
}

fn history_item(role: &str, content: String, timestamp: String) -> SessionHistoryItem {
    SessionHistoryItem {
        role: role.to_string(),
        content,
        timestamp,
        file_path: None,
        additions: None,
        deletions: None,
        tool_name: None,
        tool_input: None,
        tool_error: None,
    }
}

fn history_file_item(
    content: String,
    timestamp: String,
    path: String,
    additions: u32,
    deletions: u32,
    edit_id: &str,
    native: bool,
) -> SessionHistoryItem {
    SessionHistoryItem {
        file_path: Some(path),
        additions: Some(additions),
        deletions: Some(deletions),
        tool_input: Some(serde_json::json!({"editId":edit_id,"nativeEdit":native})),
        ..history_item("file", content, timestamp)
    }
}

fn history_tool_item(
    name: &str,
    content: String,
    timestamp: String,
    input: Value,
    is_error: bool,
) -> SessionHistoryItem {
    SessionHistoryItem {
        tool_name: Some(name.to_string()),
        tool_input: Some(input),
        tool_error: Some(is_error),
        ..history_item("tool", content, timestamp)
    }
}

fn extract_reasoning_summary_text(payload: &Value) -> Option<String> {
    let summary = payload.get("summary")?.as_array()?;
    let parts: Vec<String> = summary
        .iter()
        .filter_map(|entry| {
            if let Some(text) = entry.as_str() {
                return Some(text.to_string());
            }
            entry
                .get("text")
                .and_then(|text| text.as_str())
                .map(str::to_string)
        })
        .filter(|text| !text.trim().is_empty())
        .collect();

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn output_body_to_text(output: &Value) -> String {
    if let Some(text) = output.as_str() {
        return text.to_string();
    }
    if let Some(text) = output.get("output").and_then(|v| v.as_str()) {
        return text.to_string();
    }
    if let Some(text) = output.get("text").and_then(|v| v.as_str()) {
        return text.to_string();
    }
    if let Some(content) = output.get("content").and_then(|v| v.as_array()) {
        let parts: Vec<String> = content
            .iter()
            .filter_map(|entry| {
                entry
                    .get("text")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .or_else(|| Some(entry.to_string()))
            })
            .filter(|text| !text.trim().is_empty())
            .collect();
        if !parts.is_empty() {
            return parts.join("\n");
        }
    }
    if output.is_null() {
        String::new()
    } else {
        output.to_string()
    }
}

fn parse_json_arguments(raw: &str) -> Value {
    serde_json::from_str::<Value>(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

fn history_tool_item_from_response_item(payload: &Value, timestamp: &str) -> Option<SessionHistoryItem> {
    let item_type = payload.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let status = payload.get("status").and_then(|s| s.as_str()).unwrap_or("");
    let is_error = status.eq_ignore_ascii_case("failed") || status.eq_ignore_ascii_case("error");
    let ts = timestamp.to_string();

    match item_type {
        "web_search_call" => {
            let action = payload.get("action").cloned().unwrap_or(Value::Null);
            let query = action
                .get("query")
                .and_then(|v| v.as_str())
                .or_else(|| {
                    action
                        .get("queries")
                        .and_then(|v| v.as_array())
                        .and_then(|arr| arr.iter().find_map(|v| v.as_str()))
                })
                .unwrap_or("");
            let url = action.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let pattern = action.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
            let content = [query, url, pattern]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            Some(history_tool_item("WebSearch", content, ts, action, is_error))
        }
        "tool_search_call" => Some(history_tool_item(
            "ToolSearch",
            payload.get("arguments").map(|v| v.to_string()).unwrap_or_default(),
            ts,
            serde_json::json!({
                "execution": payload.get("execution").cloned().unwrap_or(Value::Null),
                "arguments": payload.get("arguments").cloned().unwrap_or(Value::Null),
            }),
            is_error,
        )),
        "tool_search_output" => Some(history_tool_item(
            "ToolSearch",
            payload.get("tools").map(|v| v.to_string()).unwrap_or_default(),
            ts,
            serde_json::json!({
                "execution": payload.get("execution").cloned().unwrap_or(Value::Null),
            }),
            is_error,
        )),
        "image_generation_call" => Some(history_tool_item(
            "ImageGeneration",
            payload
                .get("result")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            ts,
            serde_json::json!({
                "status": status,
                "revisedPrompt": payload.get("revised_prompt").and_then(|v| v.as_str()).unwrap_or(""),
            }),
            is_error,
        )),
        "function_call" => {
            let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() || name == "exec_command" {
                return None;
            }
            let args = payload.get("arguments").and_then(|v| v.as_str()).unwrap_or("");
            let call_id = payload.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
            let namespace = payload.get("namespace").and_then(|v| v.as_str()).unwrap_or("");
            // Prefer namespaced name for collab tools so history folds match live
            // events: collaboration.spawn_agent → CollabAgent.spawn_agent path.
            let display_name = if !namespace.is_empty() && !name.contains('.') {
                format!("{namespace}.{name}")
            } else {
                name.to_string()
            };
            let mut input = parse_json_arguments(args);
            if let Value::Object(ref mut map) = input {
                if !call_id.is_empty() {
                    map.insert("callId".to_string(), Value::String(call_id.to_string()));
                }
                if !namespace.is_empty() {
                    map.insert("namespace".to_string(), Value::String(namespace.to_string()));
                }
            } else if !call_id.is_empty() {
                input = serde_json::json!({
                    "value": input,
                    "callId": call_id,
                    "namespace": namespace,
                });
            }
            Some(history_tool_item(&display_name, String::new(), ts, input, false))
        }
        "function_call_output" => Some(history_tool_item(
            "ToolResult",
            output_body_to_text(payload.get("output").unwrap_or(&Value::Null)),
            ts,
            serde_json::json!({
                "callId": payload.get("call_id").and_then(|v| v.as_str()).unwrap_or(""),
            }),
            is_error,
        )),
        "local_shell_call" => {
            let action = payload.get("action").cloned().unwrap_or(Value::Null);
            Some(history_tool_item(
                "LocalShell",
                action
                    .get("command")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                ts,
                action,
                is_error,
            ))
        }
        "custom_tool_call" => {
            let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() {
                return None;
            }
            Some(history_tool_item(
                name,
                String::new(),
                ts,
                serde_json::json!({
                    "input": payload.get("input").cloned().unwrap_or(Value::Null),
                    "callId": payload.get("call_id").and_then(|v| v.as_str()).unwrap_or(""),
                }),
                is_error,
            ))
        }
        // Bare ToolResult rows are only useful when merged into a prior call.
        // Frontend fold expands code-mode `exec` + this output into inner tools.
        "custom_tool_call_output" => {
            let output = payload.get("output").unwrap_or(&Value::Null);
            let content = if output.is_array() {
                output.to_string()
            } else {
                output_body_to_text(output)
            };
            Some(history_tool_item(
                "ToolResult",
                content,
                ts,
                serde_json::json!({
                    "callId": payload.get("call_id").and_then(|v| v.as_str()).unwrap_or(""),
                }),
                is_error,
            ))
        }
        _ => None,
    }
}

fn count_history_diff_lines(diff: &str) -> (u32, u32) {
    let mut additions = 0;
    let mut deletions = 0;
    for line in history_diff_body_lines(diff) {
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }
    (additions, deletions)
}

/// Match pe absolute paths against exec-embedded patch paths (abs or relative).
fn paths_match_for_diff_stats(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let a = a.trim_end_matches('/');
    let b = b.trim_end_matches('/');
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let suffix_matches = |long: &str, short: &str| {
        !short.starts_with('/') && long.strip_suffix(short)
            .is_some_and(|prefix| prefix.ends_with('/'))
    };
    suffix_matches(a, b) || suffix_matches(b, a)
}

fn history_native_patch_event(payload: &Value) -> Option<std::borrow::Cow<'_, Value>> {
    if payload["type"] == "patch_apply_end" {
        return Some(std::borrow::Cow::Borrowed(payload));
    }
    if payload["type"] != "item_completed" || payload["item"]["type"] != "FileChange" {
        return None;
    }
    let item = &payload["item"];
    let call_id = item["id"].as_str().filter(|id| !id.is_empty())?;
    let success = match item["status"].as_str()? {
        "completed" => true,
        "failed" | "declined" => false,
        _ => return None,
    };
    Some(std::borrow::Cow::Owned(serde_json::json!({
        "type":"patch_apply_end", "call_id":call_id, "success":success,
        "changes":item["changes"]
    })))
}

/// Terminal / modern Codex writes edits via `event_msg` `patch_apply_end`
/// (often from code-mode `exec`, not `custom_tool_call` `apply_patch`).
/// That is the authoritative post-apply diff for sidebar +N / -M stats.
fn file_changes_from_patch_apply_end(payload: &Value) -> Vec<PendingHistoryFileChange> {
    let success = payload
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !success {
        return Vec::new();
    }
    let Some(changes_map) = payload.get("changes").and_then(|v| v.as_object()) else {
        return Vec::new();
    };

    let mut out: Vec<PendingHistoryFileChange> = Vec::new();
    for (path, change) in changes_map {
        if path.trim().is_empty() {
            continue;
        }
        let change_type = change
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("update");
        let unified_diff = change
            .get("unified_diff")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let content = change
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let (additions, deletions, diff) = match change_type {
            "add" => {
                let body = if !content.is_empty() {
                    content
                } else {
                    unified_diff
                };
                let additions = if body.is_empty() {
                    0
                } else {
                    // Preserve trailing newline semantics: empty last line does not
                    // add an extra count beyond lines().
                    body.lines().count() as u32
                };
                (additions, 0u32, body.to_string())
            }
            "delete" => {
                let body = if !content.is_empty() {
                    content
                } else {
                    unified_diff
                };
                let deletions = if body.is_empty() {
                    0
                } else {
                    body.lines().count() as u32
                };
                (0u32, deletions, body.to_string())
            }
            _ => {
                // update / move / unknown — prefer unified_diff line counts.
                if !unified_diff.is_empty() {
                    let (a, d) = count_history_diff_lines(unified_diff);
                    (a, d, unified_diff.to_string())
                } else if !content.is_empty() {
                    let a = content.lines().count() as u32;
                    (a, 0u32, content.to_string())
                } else {
                    (0u32, 0u32, String::new())
                }
            }
        };

        // Skip no-op records (empty success shells) so the sidebar badge stays clean.
        if additions == 0 && deletions == 0 && diff.trim().is_empty() {
            continue;
        }

        out.push(PendingHistoryFileChange {
            path: path.clone(),
            diff,
            additions,
            deletions,
        });
    }
    out
}

fn parse_apply_patch_history_changes(patch_text: &str) -> Vec<PendingHistoryFileChange> {
    let normalized = patch_text.replace("\r\n", "\n");
    let mut changes: Vec<PendingHistoryFileChange> = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_lines: Vec<String> = Vec::new();

    let push_current =
        |changes: &mut Vec<PendingHistoryFileChange>,
         current_path: &mut Option<String>,
         current_lines: &mut Vec<String>| {
            let Some(path) = current_path.take() else {
                current_lines.clear();
                return;
            };
            let diff = current_lines.join("\n");
            current_lines.clear();
            if diff.trim().is_empty() {
                return;
            }
            let (additions, deletions) = count_history_diff_lines(&diff);
            changes.push(PendingHistoryFileChange {
                path,
                diff,
                additions,
                deletions,
            });
        };

    for line in normalized.lines() {
        if let Some(path) = line.strip_prefix("*** Update File: ") {
            push_current(&mut changes, &mut current_path, &mut current_lines);
            current_path = Some(path.trim().to_string());
            current_lines.push(line.to_string());
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Add File: ") {
            push_current(&mut changes, &mut current_path, &mut current_lines);
            current_path = Some(path.trim().to_string());
            current_lines.push(line.to_string());
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Delete File: ") {
            push_current(&mut changes, &mut current_path, &mut current_lines);
            current_path = Some(path.trim().to_string());
            current_lines.push(line.to_string());
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Move to: ") {
            if current_path.is_some() {
                current_path = Some(path.trim().to_string());
            }
            current_lines.push(line.to_string());
            continue;
        }
        if line == "*** End Patch" {
            push_current(&mut changes, &mut current_path, &mut current_lines);
            break;
        }
        if current_path.is_some() {
            current_lines.push(line.to_string());
        }
    }

    push_current(&mut changes, &mut current_path, &mut current_lines);
    changes
}

/// Read session history from JSONL files for a given session ID.
#[tauri::command]
pub async fn codex_read_session_history(
    session_id: String,
) -> Result<SessionHistoryResult, String> {
    let _debug_timer = crate::debug_mode::operation("codex_read_session_history");
    validate_id(&session_id, "session_id")?;
    tauri::async_runtime::spawn_blocking(move || read_session_history_blocking(&session_id))
        .await
        .map_err(|e| e.to_string())?
}

fn read_session_history_blocking(session_id: &str) -> Result<SessionHistoryResult, String> {
    let sessions_dir = crate::codex::cli_config::codex_home()
        .ok_or("Cannot determine Codex home")?.join("sessions");

    if !sessions_dir.exists() {
        return Ok(SessionHistoryResult {
            cwd: None,
            model: None,
            effort: None,
            items: vec![],
            model_context_window: None,
            input_tokens: None,
            output_tokens: None,
            cached_input_tokens: None,
            total_input_tokens: None,
            total_output_tokens: None,
            total_cached_input_tokens: None,
        });
    }

    // Reuse the validated path; full history is parsed only for this request.
    let jsonl_path = find_session_file(&sessions_dir, session_id)
        .ok_or_else(|| format!("Session file not found for: {}", session_id))?;

    // Parse the JSONL file
    let content = std::fs::read_to_string(&jsonl_path)
        .map_err(|e| format!("Failed to read session file: {}", e))?;

    parse_session_history_content(&content)
}

pub(crate) fn parse_session_history_content(content: &str) -> Result<SessionHistoryResult, String> {
    let mut cwd: Option<String> = None;
    let mut model: Option<String> = None;
    let mut effort: Option<String> = None;
    let mut items: Vec<SessionHistoryItem> = Vec::new();
    let mut model_context_window: Option<u64> = None;
    let mut input_tokens: Option<u64> = None;
    let mut output_tokens: Option<u64> = None;
    let mut cached_input_tokens: Option<u64> = None;
    let mut total_input_tokens: Option<u64> = None;
    let mut total_output_tokens: Option<u64> = None;
    let mut total_cached_input_tokens: Option<u64> = None;
    let mut pending_apply_patch_calls: HashMap<String, PendingApplyPatchCall> = HashMap::new();
    let mut pending_exec_commands: HashMap<String, PendingExecCommand> = HashMap::new();
    let mut suppressed_exec_patch_items = std::collections::HashSet::new();

    // call_ids already converted to file rows from `patch_apply_end` (authoritative).
    // Dual-source rollouts emit both `patch_apply_end` and later
    // `custom_tool_call_output` for the same apply_patch call_id — skip the second.
    let mut patch_apply_end_call_ids: HashMap<String, ()> = HashMap::new();
    // Index results first so native events can match decoded, success-confirmed
    // literal patches even when the wrapper output follows. Empty native diffs
    // wait for that output; paths alone cannot identify concurrent edits.
    let mut exec_sources: HashMap<String, String> = HashMap::new();
    let mut verified_exec_patches: HashMap<String, Vec<PendingHistoryFileChange>> = HashMap::new();
    let mut native_patch_call_ids: HashMap<String, ()> = HashMap::new();
    let mut native_exec_owners: HashMap<String, String> = HashMap::new();
    let mut native_exec_context: HashMap<(String, String, String), String> = HashMap::new();
    let mut open_calls = std::collections::HashSet::new();
    let mut exclusive_exec: Option<PendingExecPatchOwner> = None;
    let mut native_session_id = String::new();
    let mut native_cwd = String::new();
    let mut last_read: Option<RetainedHistoryRead> = None;
    for line in content.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else { exclusive_exec = None; last_read = None; continue; };
        let native_patch = if value["type"] == "event_msg" { history_native_patch_event(&value["payload"]) } else { None };
        let payload = native_patch.as_deref().unwrap_or(&value["payload"]);
        let raw = &value["payload"];
        match (value["type"].as_str(), raw["type"].as_str()) {
            (Some("session_meta"), _) => {
                native_session_id = raw["id"].as_str().unwrap_or("").to_string();
                native_cwd = raw["cwd"].as_str().unwrap_or("").to_string();
                exclusive_exec = None;
                last_read = None;
            }
            (Some("response_item"), Some("custom_tool_call" | "function_call")) => {
                exclusive_exec = None;
                if open_calls.is_empty() && raw["type"] == "custom_tool_call" && raw["name"] == "exec" {
                    if let (Some(id), Some(turn)) = (raw["call_id"].as_str().filter(|id| !id.is_empty()),
                        raw["internal_chat_message_metadata_passthrough"]["turn_id"].as_str().filter(|id| !id.is_empty())) {
                        exclusive_exec = Some(PendingExecPatchOwner { call_id: id.to_string(), turn_id: turn.to_string(), native: None,
                            read: last_read.take().filter(|read| read.turn_id == turn) });
                    }
                }
                last_read = None;
                open_calls.insert(raw["call_id"].as_str().unwrap_or("").to_string());
            }
            (Some("response_item"), Some("custom_tool_call_output" | "function_call_output")) => {
                last_read = None;
                let id = raw["call_id"].as_str().unwrap_or("");
                open_calls.remove(id);
                if exclusive_exec.as_ref().is_some_and(|owner| owner.call_id != id) { exclusive_exec = None; }
            }
            (Some("event_msg"), _) if native_patch.is_some() => {
                if let Some(owner) = &mut exclusive_exec {
                    if owner.native.is_none() && payload["success"] == true
                        && raw["turn_id"].as_str() == Some(owner.turn_id.as_str())
                        && raw["thread_id"].as_str().is_none_or(|id| id == native_session_id)
                        && payload["call_id"].as_str().is_some_and(|id| !id.is_empty() && id != owner.call_id) {
                        owner.native = Some(payload.clone());
                    } else { exclusive_exec = None; }
                }
            }
            (Some("event_msg"), Some("item_completed")) if raw["item"]["type"] == "CommandExecution" => {
                let harmless = exclusive_exec.as_ref().is_some_and(|owner| {
                    let command = raw["item"]["command"].as_array();
                    raw["turn_id"].as_str() == Some(owner.turn_id.as_str())
                        && raw["thread_id"].as_str().is_none_or(|id| id == native_session_id)
                        && command.is_some_and(|args| args.len() == 3
                            && matches!(args[0].as_str(), Some("/bin/sh" | "/bin/bash" | "/bin/zsh"))
                            && matches!(args[1].as_str(), Some("-c" | "-lc"))
                            && args[2].as_str().is_some_and(history_read_only_shell))
                });
                if !harmless { exclusive_exec = None; }
                last_read = None;
            }
            (Some("token_usage_record"), _) | (Some("event_msg"), Some("token_count")) => {}
            _ => { exclusive_exec = None; last_read = None; }
        }
        let Some(call_id) = payload["call_id"].as_str().filter(|id| !id.is_empty()) else { continue; };
        if value["type"] == "event_msg" && payload["type"] == "patch_apply_end" {
            native_patch_call_ids.insert(call_id.to_string(), ());
            continue;
        }
        if value["type"] != "response_item" { continue; }
        if payload["type"] == "custom_tool_call" && payload["name"] == "exec" {
            if let Some(source) = payload["input"].as_str().filter(|source| source.contains("*** Begin Patch")
                || (source.len() <= 64 * 1024 && source.starts_with("text(await tools.exec_command("))) {
                exec_sources.insert(call_id.to_string(), source.to_string());
            }
        } else if payload["type"] == "custom_tool_call_output" {
            if let Some(source) = exec_sources.remove(call_id) {
                let patches = crate::shell_diff::exec_patch_sources(&source, &payload["output"]);
                if let Some(owner) = exclusive_exec.take() {
                    if let Some(native_id) = owner.verified_native_id(&source, &patches, payload, &native_cwd) {
                        native_exec_owners.insert(native_id, call_id.to_string());
                    }
                    if patches.len() == 1 && source.trim().starts_with("text(await tools.apply_patch(")
                        && source.matches("tools.apply_patch").count() == 1
                        && payload["internal_chat_message_metadata_passthrough"]["turn_id"].as_str() == Some(owner.turn_id.as_str()) {
                        if let (Some(native), Some(read)) = (&owner.native, &owner.read) {
                            if let (Some(native_id), Some((path, context))) = (native["call_id"].as_str(), read.native_context(native)) {
                                native_exec_context.insert((native_id.to_string(), call_id.to_string(), path), context);
                            }
                        }
                    }
                    if owner.native.is_none() && open_calls.is_empty()
                        && payload["internal_chat_message_metadata_passthrough"]["turn_id"].as_str() == Some(owner.turn_id.as_str()) {
                        last_read = retained_history_read(&source, payload, &native_cwd);
                    }
                }
                let changes = patches.into_iter().flat_map(|patch| parse_apply_patch_history_changes(&patch)).collect();
                verified_exec_patches.insert(call_id.to_string(), changes);
            }
        }
    }
    let mut pending_exec_embedded_patches: Vec<PendingExecHistoryPatch> = Vec::new();

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let timestamp = value
            .get("timestamp")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        let event_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let payload = match value.get("payload") {
            Some(p) => p,
            None => continue,
        };

        match event_type {
            "session_meta" => {
                if let Some(c) = payload.get("cwd").and_then(|c| c.as_str()) {
                    cwd = Some(c.to_string());
                }
            }
            "turn_context" => {
                if let Some(current_model) = payload.get("model").and_then(|m| m.as_str()) {
                    model = Some(current_model.to_string());
                }
                if let Some(current_effort) = payload.get("effort").and_then(|e| e.as_str()) {
                    effort = Some(current_effort.to_string());
                }
            }
            "event_msg" => {
                // Both retained native event formats share confirmation and dedup.
                let native_patch = history_native_patch_event(payload);
                let payload = native_patch.as_deref().unwrap_or(payload);
                let msg_type = payload.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match msg_type {
                    "user_message" => {
                        if let Some(text) = payload.get("message").and_then(|m| m.as_str()) {
                            items.push(history_item("user", text.to_string(), timestamp.clone()));
                        }
                    }
                    "agent_message" => {
                        // agent_message in event_msg is a summary; skip if we get
                        // the full response_item version
                    }
                    "token_count" => {
                        // Real Codex rollouts nest counters under
                        // last_token_usage / total_token_usage (and may emit
                        // info:null early in a turn). Prefer nested shape;
                        // fall back to flat legacy fields.
                        if let Some(info) = payload.get("info") {
                            if !info.is_null() {
                                apply_token_count_fields(
                                    info,
                                    &mut model_context_window,
                                    &mut input_tokens,
                                    &mut output_tokens,
                                    &mut cached_input_tokens,
                                    &mut total_input_tokens,
                                    &mut total_output_tokens,
                                    &mut total_cached_input_tokens,
                                );
                            }
                        }
                        apply_token_count_fields(
                            payload,
                            &mut model_context_window,
                            &mut input_tokens,
                            &mut output_tokens,
                            &mut cached_input_tokens,
                            &mut total_input_tokens,
                            &mut total_output_tokens,
                            &mut total_cached_input_tokens,
                        );
                    }
                    "patch_apply_end" => {
                        // Primary source of file diffs for terminal / code-mode
                        // sessions (apply_patch often never appears as a
                        // custom_tool_call — edits go through `exec` + this event).
                        let call_id = payload
                            .get("call_id")
                            .and_then(|c| c.as_str())
                            .unwrap_or("");
                        let success = payload
                            .get("success")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        if !call_id.is_empty() && patch_apply_end_call_ids.contains_key(call_id) {
                            continue;
                        }
                        if !success && !pending_apply_patch_calls.contains_key(call_id) {
                            // Failed native events often omit diffs. Conservatively
                            // consume one path occurrence in call order, not every
                            // wrapper for that path; native IDs cannot identify it.
                            if let Some(changes) = payload["changes"].as_object() {
                                for path in changes.keys() {
                                    if let Some(pending) = pending_exec_embedded_patches.iter_mut().find(|p| {
                                        !p.native_handled && paths_match_for_diff_stats(path, &p.change.path)
                                    }) {
                                        pending.native_handled = true;
                                        if let Some(index) = pending.output_index {
                                            suppressed_exec_patch_items.insert(index);
                                        }
                                    }
                                }
                            }
                        }
                        let mut changes = file_changes_from_patch_apply_end(payload);
                        changes.retain(|change| {
                            if pending_apply_patch_calls.contains_key(call_id) {
                                return true;
                            }
                            let kind = payload["changes"][&change.path]["type"].as_str().unwrap_or("update");
                            let native_diff = match kind {
                                "add" => format!("@@\n{}", change.diff.lines().map(|line| format!("+{line}")).collect::<Vec<_>>().join("\n")),
                                "delete" => format!("@@\n{}", change.diff.lines().map(|line| format!("-{line}")).collect::<Vec<_>>().join("\n")),
                                _ => change.diff.clone(),
                            };
                            // Native IDs differ from wrapper IDs. Match the actual edit,
                            // consuming one occurrence so concurrent wrappers keep theirs.
                            if let Some(pending) = pending_exec_embedded_patches.iter_mut().find(|p| {
                                !p.native_handled && match native_exec_owners.get(call_id) {
                                        Some(owner) => owner == &p.call_id
                                            && history_patch_absolute_path(&native_cwd, &p.change.path).as_deref() == Some(change.path.as_str()),
                                        None => {
                                            let context = native_exec_context.get(&(call_id.to_string(), p.call_id.clone(), change.path.clone()));
                                            paths_match_for_diff_stats(&change.path, &p.change.path)
                                                && (history_patches_equivalent(&p.change.diff, &native_diff)
                                                    || context.is_some_and(|context| history_patches_equivalent(&p.change.diff, context)))
                                        }
                                    }
                            }) {
                                pending.native_handled = true;
                                if let Some(index) = pending.output_index {
                                    // Raw patches can re-add unchanged lines. Native
                                    // counts stay authoritative even for output-first reads.
                                    items[index] = history_file_item(change.diff.clone(), timestamp.clone(),
                                        change.path.clone(), change.additions, change.deletions, call_id, true);
                                }
                                return !pending.output_handled;
                            }
                            true
                        });
                        if !call_id.is_empty() {
                            patch_apply_end_call_ids.insert(call_id.to_string(), ());
                            pending_apply_patch_calls.remove(call_id);
                        }
                        if !success {
                            continue;
                        }
                        for change in changes {
                            items.push(history_file_item(
                                change.diff,
                                timestamp.clone(),
                                change.path,
                                change.additions,
                                change.deletions,
                                call_id, true,
                            ));
                        }
                    }
                    _ => {}
                }
            }
            "response_item" => {
                let role = payload.get("role").and_then(|r| r.as_str()).unwrap_or("");
                let item_type = payload.get("type").and_then(|t| t.as_str()).unwrap_or("");

                match item_type {
                    "message" => {
                        // Extract text content from content array
                        if let Some(content_arr) = payload.get("content").and_then(|c| c.as_array())
                        {
                            let text: String = content_arr
                                .iter()
                                .filter_map(|c| {
                                    let ct = c.get("type").and_then(|t| t.as_str())?;
                                    if ct == "output_text" || ct == "input_text" {
                                        c.get("text").and_then(|t| t.as_str()).map(String::from)
                                    } else {
                                        None
                                    }
                                })
                                .collect::<Vec<_>>()
                                .join("");

                            if !text.is_empty() {
                                // Skip developer/system messages (AGENTS.md, permissions, memory instructions)
                                if role == "developer" || role == "system" {
                                    continue;
                                }
                                let mapped_role = match role {
                                    "assistant" => "assistant",
                                    "user" => "user",
                                    _ => "assistant",
                                };
                                items.push(history_item(mapped_role, text, timestamp.clone()));
                            }
                        }
                    }
                    "function_call" => {
                        let name = payload
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("unknown");
                        let args = payload
                            .get("arguments")
                            .and_then(|a| a.as_str())
                            .unwrap_or("");
                        let call_id = payload
                            .get("call_id")
                            .and_then(|c| c.as_str())
                            .unwrap_or("");
                        // Try to extract command from exec_command calls
                        if name == "exec_command" {
                            if let Ok(args_val) = serde_json::from_str::<Value>(args) {
                                let cmd =
                                    args_val.get("cmd").and_then(|c| c.as_str()).unwrap_or(args);
                                let item_index = items.len();
                                items.push(history_item(
                                    "command",
                                    format!("$ {}", cmd),
                                    timestamp.clone(),
                                ));
                                if !call_id.is_empty() {
                                    pending_exec_commands.insert(
                                        call_id.to_string(),
                                        PendingExecCommand {
                                            index: item_index,
                                            cmd: cmd.to_string(),
                                        },
                                    );
                                }
                            }
                        } else if let Some(tool_item) =
                            history_tool_item_from_response_item(payload, &timestamp)
                        {
                            items.push(tool_item);
                        }
                    }
                    "custom_tool_call" => {
                        let name = payload
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("");
                        let call_id = payload
                            .get("call_id")
                            .and_then(|c| c.as_str())
                            .unwrap_or("");
                        let input = payload
                            .get("input")
                            .and_then(|i| i.as_str())
                            .unwrap_or("");
                        if !call_id.is_empty()
                            && (name == "apply_patch" || name == "apply_patch_freeform")
                            && !input.is_empty()
                        {
                            let changes = parse_apply_patch_history_changes(input);
                            if !changes.is_empty() {
                                pending_apply_patch_calls.insert(
                                    call_id.to_string(),
                                    PendingApplyPatchCall {
                                        timestamp: timestamp.clone(),
                                        changes,
                                    },
                                );
                            }
                        } else if name == "exec" {
                            if let Some(changes) = verified_exec_patches.remove(call_id) {
                                for change in changes {
                                    pending_exec_embedded_patches.push(PendingExecHistoryPatch {
                                        call_id: call_id.to_string(),
                                        change,
                                        native_handled: false,
                                        output_handled: false,
                                        output_index: None,
                                    });
                                }
                            }
                            if let Some(tool_item) =
                                history_tool_item_from_response_item(payload, &timestamp)
                            {
                                items.push(tool_item);
                            }
                        } else if let Some(tool_item) =
                            history_tool_item_from_response_item(payload, &timestamp)
                        {
                            items.push(tool_item);
                        }
                    }
                    "custom_tool_call_output" => {
                        let call_id = payload
                            .get("call_id")
                            .and_then(|c| c.as_str())
                            .unwrap_or("");
                        // Already counted via earlier `patch_apply_end` for this call.
                        if !call_id.is_empty() && patch_apply_end_call_ids.contains_key(call_id) {
                            pending_apply_patch_calls.remove(call_id);
                            continue;
                        }
                        // Direct calls have an exact native ID. Prefer that result
                        // even when it appears after the custom tool output, keeping
                        // the pending identity so it cannot consume a wrapper edit.
                        if pending_apply_patch_calls.contains_key(call_id) && native_patch_call_ids.contains_key(call_id) {
                            continue;
                        }
                        if call_id.is_empty() {
                            if let Some(tool_item) =
                                history_tool_item_from_response_item(payload, &timestamp)
                            {
                                items.push(tool_item);
                            }
                            continue;
                        }
                        for pending in pending_exec_embedded_patches.iter_mut().filter(|p| p.call_id == call_id) {
                            if !pending.native_handled && !pending.output_handled {
                                let change = &pending.change;
                                pending.output_index = Some(items.len());
                                items.push(history_file_item(
                                    change.diff.clone(), timestamp.clone(), change.path.clone(),
                                    change.additions, change.deletions,
                                    call_id, false,
                                ));
                            }
                            pending.output_handled = true;
                        }
                        let Some(pending_call) = pending_apply_patch_calls.remove(call_id) else {
                            // Exec and other custom tools: keep the output so
                            // the frontend can expand inner command/MCP rows.
                            if let Some(tool_item) =
                                history_tool_item_from_response_item(payload, &timestamp)
                            {
                                items.push(tool_item);
                            }
                            continue;
                        };
                        let output = payload
                            .get("output")
                            .and_then(|o| o.as_str())
                            .unwrap_or("");
                        let exit_code = serde_json::from_str::<Value>(output)
                            .ok()
                            .and_then(|v| {
                                v.get("metadata")
                                    .and_then(|m| m.get("exit_code"))
                                    .and_then(|e| e.as_i64())
                            });
                        if exit_code != Some(0) {
                            if let Some(tool_item) =
                                history_tool_item_from_response_item(payload, &timestamp)
                            {
                                items.push(tool_item);
                            }
                            continue;
                        }
                        let item_timestamp = if timestamp.is_empty() {
                            pending_call.timestamp
                        } else {
                            timestamp.clone()
                        };
                        for change in pending_call.changes {
                            items.push(history_file_item(
                                change.diff,
                                item_timestamp.clone(),
                                change.path,
                                change.additions,
                                change.deletions,
                                call_id, false,
                            ));
                        }
                    }
                    "function_call_output" => {
                        let call_id = payload
                            .get("call_id")
                            .and_then(|c| c.as_str())
                            .unwrap_or("");
                        let mut handled_exec_command = false;
                        if !call_id.is_empty() {
                            if let Some(pending_cmd) = pending_exec_commands.remove(call_id) {
                                handled_exec_command = true;
                                let output_str = payload
                                    .get("output")
                                    .and_then(|o| o.as_str())
                                    .unwrap_or("");
                                // Try to parse output as JSON to extract exit_code and text
                                let (output_text, exit_code) =
                                    if let Ok(parsed) = serde_json::from_str::<Value>(output_str) {
                                        let text = parsed
                                            .get("output")
                                            .and_then(|o| o.as_str())
                                            .unwrap_or(output_str);
                                        let code = parsed.get("exit_code")
                                            .or_else(|| parsed.get("metadata").and_then(|m| m.get("exit_code")))
                                            .and_then(|e| e.as_i64());
                                        (text.to_string(), code)
                                    } else {
                                        (output_str.to_string(), None)
                                    };
                                // Update the existing command item with output and exit code
                                if pending_cmd.index < items.len() {
                                    let trimmed = output_text.trim();
                                    let status = exit_code.map(|code| format!("\n[exit: {code}]")).unwrap_or_default();
                                    if trimmed.is_empty() {
                                        items[pending_cmd.index].content =
                                            format!("$ {}{status}", pending_cmd.cmd);
                                    } else {
                                        items[pending_cmd.index].content = format!(
                                            "$ {}\n{}{status}", pending_cmd.cmd, trimmed
                                        );
                                    }
                                }
                            }
                        }
                        if !handled_exec_command {
                            if let Some(tool_item) =
                                history_tool_item_from_response_item(payload, &timestamp)
                            {
                                items.push(tool_item);
                            }
                        }
                    }
                    "reasoning" => {
                        if let Some(text) = extract_reasoning_summary_text(payload) {
                            items.push(history_item("thinking", text, timestamp.clone()));
                        }
                    }
                    _ => {
                        if let Some(tool_item) =
                            history_tool_item_from_response_item(payload, &timestamp)
                        {
                            items.push(tool_item);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    // An unresolved command has no exit status. Keep its original command row.

    // Incomplete direct patches have no confirmed result and must not become
    // successful file rows simply because this history read reached EOF.

    // Deduplicate: if we have a response_item user message and an event_msg user_message
    // with the same content, keep only one. Simple approach: remove consecutive duplicates.
    let mut deduped: Vec<SessionHistoryItem> = Vec::new();
    for (index, item) in items.into_iter().enumerate() {
        if suppressed_exec_patch_items.contains(&index) { continue; }
        if let Some(last) = deduped.last() {
            // Tool calls often have empty content and separate results can be
            // identical. Preserve their call IDs for frontend output matching.
            if item.role != "file" && item.role != "tool" && last.role == item.role && last.content == item.content {
                continue; // Skip duplicate
            }
        }
        deduped.push(item);
    }

    Ok(SessionHistoryResult {
        cwd,
        model,
        effort,
        items: deduped,
        model_context_window,
        input_tokens,
        output_tokens,
        cached_input_tokens,
        total_input_tokens,
        total_output_tokens,
        total_cached_input_tokens,
    })
}

/// Session-id → model cache backing `codex_list_threads` enrichment.
///
/// The sidebar refetches the thread list on every turn completion; without
/// this cache each refresh would re-walk `~/.codex/sessions` and re-parse
/// JSONLs for threads whose model is already known. Mid-session model
/// switches on open threads are reflected by the frontend's live in-session
/// tracker (fed by `codex_refresh_thread_model`), not by re-scanning on every
/// list call. `codex_refresh_thread_model` also overwrites the cache entry so
/// the next list enrichment stays consistent with `/model` switches.
fn thread_model_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Re-scan a Codex session JSONL for the latest model + token usage.
///
/// Used when the CLI changes model mid-session (e.g. `/model` in terminal
/// mode) or finishes a turn that updates context fill. Terminal sessions do
/// not attach the app-server, so `codex_read_thread` / token-usage events
/// cannot observe these; the session file is the source of truth.
/// Updates the list-enrichment model cache when a model is found.
#[tauri::command]
pub async fn codex_refresh_thread_model(
    session_id: String,
) -> Result<CodexThreadLiveSnapshot, String> {
    let _debug_timer = crate::debug_mode::operation("codex_refresh_thread_model");
    validate_id(&session_id, "session_id")?;

    let sessions_dir = crate::codex::cli_config::codex_home()
        .ok_or_else(|| "Cannot determine Codex home".to_string())?.join("sessions");

    let id = session_id.clone();
    let snap = tauri::async_runtime::spawn_blocking(move || {
        let path = find_session_file(&sessions_dir, &id)?;
        Some(scan_live_snapshot_from_file(&path))
    })
    .await
    .map_err(|e| e.to_string())?
    .unwrap_or_default();

    if let Some(ref m) = snap.model {
        let mut cache = thread_model_cache()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        cache.insert(session_id, m.clone());
    }

    Ok(snap)
}

/// Single-pass scan of a session JSONL for model + latest token usage +
/// task lifecycle (`task_started` / `task_complete`).
fn scan_live_snapshot_from_file(path: &Path) -> CodexThreadLiveSnapshot {
    // Retain only small live summaries, never full transcripts or arbitrarily
    // large question/model strings. Oversized summaries are returned uncached.
    let mut uncached = None;
    session_read_cache().snapshot(path, || {
        let (snap, complete) = scan_live_snapshot_uncached(path);
        if !complete || serde_json::to_vec(&snap).ok()?.len() > 16 * 1024 {
            uncached = Some(snap);
            return None;
        }
        Some(snap)
    }).or(uncached).unwrap_or_default()
}

fn scan_live_snapshot_uncached(path: &Path) -> (CodexThreadLiveSnapshot, bool) {
    use std::io::{BufRead, BufReader};
    let Ok(file) = std::fs::File::open(path) else {
        return (CodexThreadLiveSnapshot::default(), false);
    };
    let reader = BufReader::new(file);
    let mut snap = CodexThreadLiveSnapshot::default();
    let mut question_is_async = false;
    for line in reader.lines() {
        let Ok(line) = line else { return (snap, false); };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value): Result<Value, _> = serde_json::from_str(line) else {
            continue;
        };
        let event_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let Some(payload) = value.get("payload") else {
            continue;
        };
        let line_ts = value
            .get("timestamp")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string());
        match event_type {
            "response_item" => {
                let kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
                if kind == "function_call" {
                    let name = payload.get("name").and_then(Value::as_str).unwrap_or("");
                    let leaf = name.rsplit('.').next().unwrap_or(name);
                    if matches!(leaf, "request_user_input" | "request_user_input_async") {
                        let args = payload.get("arguments").cloned().unwrap_or(Value::Null);
                        let args = match args.as_str() {
                            Some(raw) => serde_json::from_str::<Value>(raw).unwrap_or(Value::Null),
                            None => args,
                        };
                        let summary = args.get("questions").and_then(Value::as_array)
                            .and_then(|questions| questions.iter().find_map(|q| {
                                q.get("question").or_else(|| q.get("title"))
                                    .and_then(Value::as_str).filter(|s| !s.trim().is_empty())
                            }));
                        if let (Some(id), Some(summary)) = (payload.get("call_id").and_then(Value::as_str), summary) {
                            snap.pending_question = Some(CodexPendingQuestion { id: id.to_string(), summary: summary.to_string() });
                            question_is_async = leaf == "request_user_input_async";
                        }
                    }
                } else if (kind == "function_call_output" && !question_is_async
                    && snap.pending_question.as_ref().is_some_and(|q| payload.get("call_id").and_then(Value::as_str) == Some(q.id.as_str())))
                    || (kind == "message" && payload.get("role").and_then(Value::as_str) == Some("user"))
                {
                    snap.pending_question = None;
                }
            }
            "turn_context" => {
                if let Some(m) = payload.get("model").and_then(|m| m.as_str()) {
                    if !m.is_empty() {
                        snap.model = Some(m.to_string());
                    }
                }
            }
            "event_msg" => {
                let msg_type = payload.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match msg_type {
                    "token_count" => {
                        if let Some(info) = payload.get("info") {
                            if !info.is_null() {
                                apply_token_count_fields(
                                    info,
                                    &mut snap.model_context_window,
                                    &mut snap.input_tokens,
                                    &mut snap.output_tokens,
                                    &mut snap.cached_input_tokens,
                                    &mut snap.total_input_tokens,
                                    &mut snap.total_output_tokens,
                                    &mut snap.total_cached_input_tokens,
                                );
                            }
                        }
                        apply_token_count_fields(
                            payload,
                            &mut snap.model_context_window,
                            &mut snap.input_tokens,
                            &mut snap.output_tokens,
                            &mut snap.cached_input_tokens,
                            &mut snap.total_input_tokens,
                            &mut snap.total_output_tokens,
                            &mut snap.total_cached_input_tokens,
                        );
                    }
                    "user_message" => { snap.pending_question = None; }
                    "task_started" => {
                        if let Some(ts) = line_ts.clone() {
                            snap.last_task_started_at = Some(ts);
                        }
                        snap.task_active = true;
                    }
                    "task_complete" | "turn_aborted" => {
                        if msg_type == "turn_aborted" || !question_is_async { snap.pending_question = None; }
                        if let Some(ts) = line_ts.clone() {
                            snap.last_task_complete_at = Some(ts);
                        }
                        snap.task_active = false;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    (snap, true)
}

/// Resolve models for the given session ids with a SINGLE walk of the
/// sessions dir (one recursive walk per id was the old behavior — up to
/// 100 walks per list call).
fn resolve_thread_models(sessions_dir: &Path, ids: &[String]) -> HashMap<String, String> {
    let mut models = HashMap::new();
    if ids.is_empty() {
        return models;
    }
    let files = collect_session_files(sessions_dir);
    for id in ids {
        let matched = files.iter().find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.contains(id.as_str()))
                .unwrap_or(false)
        });
        let Some(path) = matched else { continue };
        if let Some(model) = scan_model_from_file(path) {
            models.insert(id.clone(), model);
        }
    }
    models
}

/// Recursively collect every session JSONL under `dir` in one pass.
fn collect_session_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return files;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            files.extend(collect_session_files(&path));
        } else if path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.ends_with(".jsonl"))
            .unwrap_or(false)
        {
            files.push(path);
        }
    }
    files
}

/// Scan a Codex session JSONL for the latest `turn_context.model`.
///
/// Codex emits a `turn_context` event near the top of the file when the session
/// is created, plus additional ones when the user switches model mid-session
/// via `/model`. We stream the whole file and take the LAST one so a mid-session
/// switch is reflected and a large preamble before the initial event can't push
/// it out of a fixed scan window. Returns `None` only when the file has no
/// `turn_context` entry at all.
fn scan_model_from_file(path: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut model: Option<String> = None;
    for line in reader.lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value): Result<Value, _> = serde_json::from_str(line) else {
            continue;
        };
        if value.get("type").and_then(|t| t.as_str()) != Some("turn_context") {
            continue;
        }
        if let Some(m) = value
            .get("payload")
            .and_then(|p| p.get("model"))
            .and_then(|m| m.as_str())
        {
            model = Some(m.to_string());
        }
    }
    model
}

#[cfg(test)]
mod patch_apply_end_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn counts_update_unified_diff_additions_and_deletions() {
        let payload = json!({
            "type": "patch_apply_end",
            "success": true,
            "changes": {
                "/repo/src/foo.ts": {
                    "type": "update",
                    "unified_diff": "@@ -1,3 +1,4 @@\n line\n-old\n+new\n+extra\n",
                    "move_path": null
                }
            }
        });
        let changes = file_changes_from_patch_apply_end(&payload);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "/repo/src/foo.ts");
        assert_eq!(changes[0].additions, 2);
        assert_eq!(changes[0].deletions, 1);
    }

    #[test]
    fn counts_add_content_as_additions() {
        let payload = json!({
            "success": true,
            "changes": {
                "/repo/new.ts": {
                    "type": "add",
                    "content": "a\nb\nc\n"
                }
            }
        });
        let changes = file_changes_from_patch_apply_end(&payload);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].additions, 3);
        assert_eq!(changes[0].deletions, 0);
    }

    #[test]
    fn counts_delete_content_as_deletions() {
        let payload = json!({
            "success": true,
            "changes": {
                "/repo/gone.ts": {
                    "type": "delete",
                    "content": "one\ntwo\n"
                }
            }
        });
        let changes = file_changes_from_patch_apply_end(&payload);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].additions, 0);
        assert_eq!(changes[0].deletions, 2);
    }

    #[test]
    fn skips_failed_or_empty_payloads() {
        let failed = json!({
            "success": false,
            "changes": {
                "/repo/x.ts": {
                    "type": "update",
                    "unified_diff": "@@\n+x\n"
                }
            }
        });
        assert!(file_changes_from_patch_apply_end(&failed).is_empty());

        let empty = json!({
            "success": true,
            "changes": {
                "/repo/x.ts": {
                    "type": "update",
                    "unified_diff": "",
                    "move_path": null
                }
            }
        });
        assert!(file_changes_from_patch_apply_end(&empty).is_empty());
    }

    #[test]
    fn skips_plus_plus_plus_headers_in_unified_diff() {
        let (a, d) = count_history_diff_lines("--- a/foo\n+++ b/foo\n@@\n-a\n+b\n");
        assert_eq!(a, 1);
        assert_eq!(d, 1);
    }

    #[test]
    fn parse_apply_patch_finds_patch_inside_exec_js_wrapper() {
        // Real terminal rollouts embed the patch in a JS `const patch = "..."` exec body.
        let input = r#"const patch = "*** Begin Patch
*** Update File: /Users/neel/Documents/GitHub/agmux/AGENTS.md
@@
 line
-old
+new
+extra
*** End Patch
";
await tools.apply_patch(patch);
"#;
        let changes = parse_apply_patch_history_changes(input);
        assert_eq!(changes.len(), 1);
        assert_eq!(
            changes[0].path,
            "/Users/neel/Documents/GitHub/agmux/AGENTS.md"
        );
        assert_eq!(changes[0].additions, 2);
        assert_eq!(changes[0].deletions, 1);
    }

    #[test]
    fn parse_apply_patch_handles_literal_backslash_n_in_exec_string() {
        // Real JSONL stores the patch as one line with `\n` escapes inside quotes.
        let input = r#"const patch = "*** Begin Patch\n*** Update File: /repo/AGENTS.md\n@@\n line\n-old\n+new\n+extra\n*** End Patch\n";"#;
        let normalized = input.replace("\\n", "\n");
        let changes = parse_apply_patch_history_changes(&normalized);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "/repo/AGENTS.md");
        assert_eq!(changes[0].additions, 2);
        assert_eq!(changes[0].deletions, 1);
    }

    #[test]
    fn paths_match_accepts_absolute_and_relative() {
        assert!(paths_match_for_diff_stats(
            "/Users/neel/Documents/GitHub/agmux/AGENTS.md",
            "/Users/neel/Documents/GitHub/agmux/AGENTS.md"
        ));
        assert!(paths_match_for_diff_stats(
            "/Users/neel/Documents/GitHub/agmux/AGENTS.md",
            "AGENTS.md"
        ));
        assert!(!paths_match_for_diff_stats(
            "/Users/neel/Documents/GitHub/agmux/AGENTS.md",
            "README.md"
        ));
    }
}

#[cfg(test)]
mod exec_history_tests {
    use super::*;
    use serde_json::json;

    // Opt-in, read-only replay of a frozen local corpus. Commands in transcripts
    // are data only. Export parsed histories for the frontend's matching audit.
    #[test]
    fn bounded_local_corpus_replay() {
        use std::io::Read;
        use sha2::Digest;
        let Ok(manifest_path) = std::env::var("AGMUX_CODEX_CORPUS_MANIFEST") else { return; };
        let manifest_path = std::path::Path::new(&manifest_path);
        let read_bounded = |path: &std::path::Path, limit: u64| {
            let mut content = String::new();
            std::fs::File::open(path).unwrap().take(limit + 1).read_to_string(&mut content).unwrap();
            assert!(content.len() as u64 <= limit, "oversized corpus input: {}", path.display());
            content
        };
        let manifest: Value = serde_json::from_str(&read_bounded(manifest_path, 1024 * 1024)).unwrap();
        let sessions = manifest.as_array().unwrap();
        assert!(!sessions.is_empty() && sessions.len() <= 512);
        let output_dir = manifest_path.parent().unwrap().join("histories");
        std::fs::create_dir_all(&output_dir).unwrap();
        let mut report = Vec::new();
        let mut total_bytes = 0;
        let mut ids = std::collections::HashSet::new();
        for session in sessions {
            let id = session["id"].as_str().unwrap();
            uuid::Uuid::parse_str(id).unwrap();
            assert!(ids.insert(id), "duplicate corpus session");
            let path = std::path::Path::new(session["path"].as_str().unwrap());
            let content = read_bounded(path, 128 * 1024 * 1024);
            if let Some(expected) = session["sha256"].as_str() {
                assert_eq!(format!("{:x}", sha2::Sha256::digest(content.as_bytes())), expected, "changed corpus snapshot: {id}");
            }
            total_bytes += content.len();
            assert!(total_bytes <= 512 * 1024 * 1024, "oversized corpus");
            let malformed = content.lines().filter(|line| !line.trim().is_empty()
                && serde_json::from_str::<Value>(line).is_err()).count();
            let history = parse_session_history_content(&content).unwrap();
            std::fs::write(output_dir.join(format!("{id}.json")), serde_json::to_vec(&history).unwrap()).unwrap();
            let mut roles = std::collections::BTreeMap::new();
            for item in &history.items { *roles.entry(item.role.clone()).or_insert(0usize) += 1; }
            let mut native_files = HashMap::new();
            let mut native_ids = std::collections::HashSet::new();
            let mut calls = HashMap::new();
            let mut outputs = std::collections::HashSet::new();
            let mut unsupported_responses = std::collections::BTreeMap::new();
            let mut skipped_native_items = std::collections::BTreeMap::new();
            let mut failed_native = 0;
            let mut represented_messages = 0;
            let mut represented_questions = 0;
            let mut active_turn = String::new();
            let mut output_turns = HashMap::new();
            let mut observer = crate::codex::diff_stats::DiffObserver::default();
            let mut publisher_signals = std::collections::BTreeMap::new();
            for row in content.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()) {
                let payload = &row["payload"];
                let kind = payload["type"].as_str().unwrap_or("");
                let refresh = observer.observe_record(id, &row);
                if refresh { *publisher_signals.entry(kind.to_string()).or_insert(0usize) += 1; }
                if row["type"] == "event_msg" {
                    if matches!(kind, "task_complete" | "turn_aborted") {
                        assert!(refresh, "missing turn-end publisher signal: {id}");
                    }
                    if kind == "task_started" { active_turn = payload["turn_id"].as_str().unwrap_or("").to_string(); }
                    if kind == "item_completed" && payload["item"]["type"] != "FileChange" {
                        *skipped_native_items.entry(payload["item"]["type"].as_str().unwrap_or("").to_string()).or_insert(0usize) += 1;
                        let native_item = &payload["item"];
                        let role = match native_item["type"].as_str() {
                            Some("UserMessage") => "user", Some("AgentMessage") => "assistant", _ => "",
                        };
                        if !role.is_empty() {
                            let text = native_item["content"].as_array().into_iter().flatten()
                                .filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join("");
                            if !text.is_empty() {
                                let represented = history.items.iter().any(|item| item.role == role && item.content.contains(&text));
                                let questions = |value: &Value| value.as_array().into_iter().flatten().map(|q| {
                                    (q["title"].as_str().unwrap_or("").to_string(), q["options"].as_array().cloned().unwrap_or_default())
                                }).collect::<Vec<_>>();
                                let async_question = native_item["delivery"] == "async" && history.items.iter().any(|item| {
                                    item.tool_name.as_deref() == Some("request_user_input_async")
                                        && item.tool_input.as_ref().is_some_and(|input| questions(&input["questions"]) == questions(&native_item["questions"]))
                                });
                                assert!(represented || async_question, "native message missing from history: {id} {}", native_item["id"]);
                                represented_messages += usize::from(represented);
                                represented_questions += usize::from(!represented && async_question);
                            }
                        }
                    }
                    if let Some(native) = history_native_patch_event(payload) {
                        if native["success"] == true { assert!(refresh, "missing confirmed edit publisher signal: {id}"); }
                        let native_id = native["call_id"].as_str().unwrap_or("");
                        if !native_id.is_empty() && !native_ids.insert(native_id.to_string()) { continue; }
                        if native["success"] != true { failed_native += 1; }
                        for file in file_changes_from_patch_apply_end(&native) {
                            let key = (file.path, file.diff, file.additions, file.deletions);
                            *native_files.entry(key).or_insert(0usize) += 1;
                        }
                    }
                } else if row["type"] == "response_item" {
                    let call_id = payload["call_id"].as_str().unwrap_or("");
                    if matches!(kind, "custom_tool_call" | "function_call") {
                        calls.insert(call_id.to_string(), (payload["name"].as_str().unwrap_or("").to_string(), active_turn.clone()));
                    } else if matches!(kind, "custom_tool_call_output" | "function_call_output") {
                        outputs.insert(call_id.to_string());
                        output_turns.insert(call_id.to_string(), active_turn.clone());
                    } else if !matches!(kind, "message" | "reasoning")
                        && history_tool_item_from_response_item(payload, "").is_none() {
                        *unsupported_responses.entry(kind.to_string()).or_insert(0usize) += 1;
                    }
                }
            }
            // Every confirmed native file signature must survive exactly once
            // per observed edit; wrapper rows cannot stand in for missing natives.
            for ((path, diff, added, removed), expected) in &native_files {
                let actual = history.items.iter().filter(|item| item.role == "file"
                    && item.file_path.as_ref() == Some(path) && &item.content == diff
                    && item.additions == Some(*added) && item.deletions == Some(*removed)).count();
                assert_eq!(actual, *expected, "native file coverage/duplication: {id} {path}");
            }
            for (call_id, (name, _)) in &calls {
                if matches!(name.as_str(), "exec_command" | "apply_patch" | "apply_patch_freeform") { continue; }
                let matches_id = |item: &&SessionHistoryItem| item.tool_input.as_ref()
                    .and_then(|input| input["callId"].as_str()) == Some(call_id.as_str());
                assert_eq!(history.items.iter().filter(matches_id).filter(|item| item.tool_name.as_deref() != Some("ToolResult")).count(),
                    1, "missing or duplicate tool call: {id} {call_id}");
                if outputs.contains(call_id) {
                    assert_eq!(history.items.iter().filter(matches_id).filter(|item| item.tool_name.as_deref() == Some("ToolResult")).count(),
                        1, "missing or duplicate output: {id} {call_id}");
                }
            }
            report.push(json!({"id": id, "rows": history.items.len(), "roles": roles,
                "malformedRecords": malformed,
                "confirmedNativeFiles": native_files.values().sum::<usize>(), "failedNativeEdits": failed_native,
                "missingConfirmedNativeFiles": 0, "duplicateNativeSignatures": 0,
                "nativeMessagesRepresentedByText": represented_messages,
                "nativeQuestionsRepresentedByTool": represented_questions,
                "wrapperFileRows": history.items.iter().filter(|item| item.role == "file" && item.content.starts_with("***")).count(),
                "calls": calls.len(), "outputs": outputs.len(),
                "callsWithoutRecordedOutput": calls.keys().filter(|id| !outputs.contains(*id)).collect::<Vec<_>>(),
                "outputsWithoutRecordedCall": outputs.iter().filter(|id| !calls.contains_key(*id)).collect::<Vec<_>>(),
                "crossTurnOutputs": output_turns.iter().filter(|(id, turn)| calls.get(*id).is_some_and(|(_, call_turn)| call_turn != *turn)).count(),
                "responseItemTypesWithoutHistoryAdapter": unsupported_responses,
                "nativeItemTypesWithoutHistoryAdapter": skipped_native_items,
                "publisherSignalsByRecordType": publisher_signals,
                "errorRows": history.items.iter().filter(|item| item.tool_error == Some(true)).count(),
                "additions": history.items.iter().map(|item| item.additions.unwrap_or(0) as u64).sum::<u64>(),
                "deletions": history.items.iter().map(|item| item.deletions.unwrap_or(0) as u64).sum::<u64>()}));
        }
        std::fs::write(output_dir.join("report.json"), serde_json::to_vec_pretty(&report).unwrap()).unwrap();
        eprintln!("replayed {} sessions ({} bytes), exported to {}", sessions.len(), total_bytes, output_dir.display());
    }

    #[test]
    fn custom_tool_call_exec_is_emitted_for_frontend_expansion() {
        let payload = json!({
            "type": "custom_tool_call",
            "name": "exec",
            "call_id": "call_1",
            "input": "text(await tools.exec_command({cmd:\"rg cache\"}));"
        });
        let item = history_tool_item_from_response_item(&payload, "2026-09-07T00:00:00Z").unwrap();
        assert_eq!(item.tool_name.as_deref(), Some("exec"));
        assert_eq!(item.tool_input.as_ref().unwrap()["callId"], "call_1");
    }

    #[test]
    fn custom_tool_call_output_preserves_array_json() {
        let payload = json!({
            "type": "custom_tool_call_output",
            "call_id": "call_1",
            "output": [
                {"type": "input_text", "text": "Script completed"},
                {"type": "input_text", "text": "{\"output\":\"ok\",\"exit_code\":0}"}
            ]
        });
        let item = history_tool_item_from_response_item(&payload, "2026-09-07T00:00:00Z").unwrap();
        assert_eq!(item.tool_name.as_deref(), Some("ToolResult"));
        let parsed: serde_json::Value = serde_json::from_str(&item.content).unwrap();
        assert!(parsed.is_array());
        assert_eq!(parsed.as_array().unwrap().len(), 2);
    }

    #[test]
    fn history_preserves_distinct_calls_and_identical_outputs() {
        // Retained collab sessions interleave calls and return repeated accepted
        // or empty results. Empty display text is not a tool's identity.
        let payloads = [
            json!({"type":"function_call", "name":"send_message", "call_id":"a", "arguments":"{}"}),
            json!({"type":"custom_tool_call", "name":"exec", "call_id":"b", "input":"text(1);"}),
            json!({"type":"function_call_output", "call_id":"a", "output":"{\"accepted\":true}"}),
            json!({"type":"custom_tool_call_output", "call_id":"b", "output":"{\"accepted\":true}"}),
            json!({"type":"function_call", "name":"send_message", "call_id":"c", "arguments":"{}"}),
            json!({"type":"function_call_output", "call_id":"c", "output":""}),
        ];
        let content = payloads.iter().map(|payload| json!({"type":"response_item", "payload":payload}).to_string())
            .collect::<Vec<_>>().join("\n");
        let history = parse_session_history_content(&content).unwrap();
        assert_eq!(history.items.len(), 6);
        let ids: Vec<_> = history.items.iter().map(|item| item.tool_input.as_ref().unwrap()["callId"].as_str().unwrap()).collect();
        assert_eq!(ids, ["a", "b", "a", "b", "c", "c"]);
    }
}

#[cfg(test)]
mod thread_model_tests {
    use super::*;
    use std::fs;

    #[test]
    fn resolves_models_for_multiple_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let day = tmp.path().join("2026").join("07").join("01");
        fs::create_dir_all(&day).unwrap();
        fs::write(
            day.join("rollout-abc123.jsonl"),
            r#"{"type":"turn_context","payload":{"model":"gpt-5.3-codex"}}"#,
        )
        .unwrap();
        fs::write(
            day.join("rollout-def456.jsonl"),
            "{\"type\":\"other\"}\n{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.3\"}}",
        )
        .unwrap();

        let ids = vec![
            "abc123".to_string(),
            "def456".to_string(),
            "missing".to_string(),
        ];
        let models = resolve_thread_models(tmp.path(), &ids);
        assert_eq!(models.get("abc123").map(String::as_str), Some("gpt-5.3-codex"));
        assert_eq!(models.get("def456").map(String::as_str), Some("gpt-5.3"));
        assert!(!models.contains_key("missing"));
    }

    #[test]
    fn takes_last_turn_context_model() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(
            tmp.path().join("rollout-xyz.jsonl"),
            concat!(
                "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.2\"}}\n",
                "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.3-codex\"}}",
            ),
        )
        .unwrap();
        let models = resolve_thread_models(tmp.path(), &["xyz".to_string()]);
        assert_eq!(models.get("xyz").map(String::as_str), Some("gpt-5.3-codex"));
    }

    #[test]
    fn empty_when_sessions_dir_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let models =
            resolve_thread_models(&tmp.path().join("nope"), &["abc".to_string()]);
        assert!(models.is_empty());
    }

    #[test]
    fn live_snapshot_reads_nested_token_count_and_model() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("rollout-live1.jsonl");
        fs::write(
            &path,
            concat!(
                r#"{"type":"turn_context","payload":{"model":"gpt-5.6-terra"}}"#,
                "\n",
                r#"{"type":"event_msg","payload":{"type":"token_count","info":null}}"#,
                "\n",
                r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100000,"cached_input_tokens":80000,"output_tokens":500,"total_tokens":100500},"last_token_usage":{"input_tokens":42000,"cached_input_tokens":30000,"output_tokens":120,"total_tokens":42120},"model_context_window":258400}}}"#,
                "\n",
                r#"{"type":"turn_context","payload":{"model":"gpt-5.6-sol"}}"#,
            ),
        )
        .unwrap();
        let snap = scan_live_snapshot_from_file(&path);
        assert_eq!(snap.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(snap.model_context_window, Some(258400));
        assert_eq!(snap.input_tokens, Some(42000));
        assert_eq!(snap.output_tokens, Some(120));
        assert_eq!(snap.cached_input_tokens, Some(30000));
        assert_eq!(snap.total_input_tokens, Some(100000));
        assert_eq!(snap.total_output_tokens, Some(500));
        assert_eq!(snap.total_cached_input_tokens, Some(80000));
        assert!(!snap.task_active);
        assert!(snap.last_task_started_at.is_none());
        assert!(snap.last_task_complete_at.is_none());
    }

    #[test]
    fn live_snapshot_tracks_task_started_without_complete() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("rollout-task-active.jsonl");
        fs::write(
            &path,
            concat!(
                r#"{"timestamp":"2026-07-15T00:42:06.286Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t1","started_at":1784076126}}"#,
                "\n",
                r#"{"timestamp":"2026-07-15T00:42:10.000Z","type":"event_msg","payload":{"type":"agent_message","message":"working…"}}"#,
                "\n",
            ),
        )
        .unwrap();
        let snap = scan_live_snapshot_from_file(&path);
        assert!(snap.task_active);
        assert!(snap.last_task_started_at.is_some());
        assert!(snap.last_task_complete_at.is_none());
    }

    #[test]
    fn live_snapshot_questions_follow_real_codex_records() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("questions.jsonl");
        let ask = r#"{"type":"response_item","payload":{"type":"function_call","name":"request_user_input_async","call_id":"ask-1","arguments":"{\"questions\":[{\"title\":\"Which option?\"}]}"}}"#;
        let ack = r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"ask-1","output":"{\"accepted\":true}"}}"#;
        let done = r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#;
        fs::write(&path, format!("{ask}\n{ack}\n{done}\n")).unwrap();
        let question = scan_live_snapshot_from_file(&path).pending_question.unwrap();
        assert_eq!(question.id, "ask-1");
        assert_eq!(question.summary, "Which option?");
        let answer = r#"{"type":"event_msg","payload":{"type":"user_message","message":"First option"}}"#;
        fs::write(&path, format!("{ask}\n{ack}\n{answer}\n")).unwrap();
        assert!(scan_live_snapshot_from_file(&path).pending_question.is_none());
        let sync = ask.replace("request_user_input_async", "functions.request_user_input");
        fs::write(&path, format!("{sync}\n")).unwrap();
        assert!(scan_live_snapshot_from_file(&path).pending_question.is_some());
        fs::write(&path, format!("{sync}\n{ack}\n")).unwrap();
        assert!(scan_live_snapshot_from_file(&path).pending_question.is_none());
    }

    #[test]
    fn live_snapshot_abort_clears_active_and_allows_next_turn() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("rollout-aborted.jsonl");
        let started = r#"{"timestamp":"2026-09-10T04:32:45Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}"#;
        let aborted = r#"{"timestamp":"2026-09-10T04:49:51.977Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"t1","reason":"interrupted"}}"#;
        fs::write(&path, format!("{started}\n{aborted}\n")).unwrap();
        let snap = scan_live_snapshot_from_file(&path);
        assert!(!snap.task_active);
        assert_eq!(snap.last_task_complete_at.as_deref(), Some("2026-09-10T04:49:51.977Z"));
        let next = started.replace("04:32:45", "04:50:00").replace("t1", "t2");
        fs::write(&path, format!("{started}\n{aborted}\n{next}\n")).unwrap();
        assert!(scan_live_snapshot_from_file(&path).task_active);
    }

    #[test]
    fn live_snapshot_task_complete_clears_active() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("rollout-task-done.jsonl");
        fs::write(
            &path,
            concat!(
                r#"{"timestamp":"2026-07-15T00:42:06.286Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t1","started_at":1784076126}}"#,
                "\n",
                r#"{"timestamp":"2026-07-15T00:46:48.199Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","completed_at":1784076408,"duration_ms":42000}}"#,
                "\n",
            ),
        )
        .unwrap();
        let snap = scan_live_snapshot_from_file(&path);
        assert!(!snap.task_active);
        assert!(snap.last_task_started_at.is_some());
        assert!(snap.last_task_complete_at.is_some());
    }
}

/// Recursively find a JSONL file whose name contains the session ID.
pub(crate) fn find_session_file(dir: &Path, session_id: &str) -> Option<std::path::PathBuf> {
    session_read_cache().resolve(dir, session_id, || find_session_file_uncached(dir, session_id))
}

fn find_session_file_uncached(dir: &Path, session_id: &str) -> Option<PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_session_file_uncached(&path, session_id) {
                return Some(found);
            }
        } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.contains(session_id) && name.ends_with(".jsonl") {
                return Some(path);
            }
        }
    }
    None
}

#[cfg(test)]
mod exec_patch_history_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fable_review_configured_codex_home_is_shared_by_read_and_resume() {
        let Ok(root) = std::env::var("AGMUX_VERIFY_CUSTOM_CODEX_HOME") else { return; };
        assert_eq!(crate::codex::cli_config::codex_home().unwrap(), std::path::PathBuf::from(&root));
        let session = uuid::Uuid::new_v4().to_string();
        let path = crate::process::spawn::ensure_codex_session_rollout(&session, "/repo", None).unwrap();
        assert!(path.starts_with(std::path::Path::new(&root).join("sessions")));
        assert!(crate::process::spawn::codex_session_file_exists(&session));
        assert_eq!(read_session_history_blocking(&session).unwrap().cwd.as_deref(), Some("/repo"));
        assert_eq!(crate::process::spawn::ensure_codex_session_rollout(&session, "/repo", None).unwrap(), std::path::Path::new(&root).join("sessions"));
    }

    #[test]
    fn fable_review_counts_header_like_content_as_edits() {
        for diff in ["@@\n----\n++++\n", "*** Update File: a\n@@\n----\n++++\n",
            "--- a/file\n+++ b/file\n@@ -1 +1 @@\n----\n++++\n"] {
            assert_eq!(count_history_diff_lines(diff), (1, 1), "{diff}");
            assert_eq!(history_patch_edit_lines(diff), vec!["----", "++++"]);
        }
        assert!(!history_patches_equivalent("@@\n----\n+x\n", "@@\n+x\n"));
    }

    #[test]
    fn fable_review_unowned_add_with_header_like_content_counts_once() {
        let patch = "*** Begin Patch\n*** Add File: added.md\n+++value\n*** End Patch";
        let request = json!({"type":"response_item","payload":{
            "type":"custom_tool_call","name":"exec","call_id":"wrapper",
            "input":format!("text(await tools.apply_patch({}));", serde_json::to_string(patch).unwrap())
        }});
        let native = json!({"type":"event_msg","payload":{
            "type":"patch_apply_end","call_id":"native","success":true,
            "changes":{"/repo/added.md":{"type":"add","content":"++value\n"}}
        }});
        let mut result = output("wrapper", "{}");
        result["payload"]["output"].as_array_mut().unwrap().truncate(2);
        let rows = files(vec![request, native, result]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].additions, Some(1));
    }

    #[test]
    fn fable_review_missing_or_unfinished_command_output_has_no_success_status() {
        let request = json!({"type":"response_item","payload":{
            "type":"function_call","name":"exec_command","call_id":"command","arguments":"{\"cmd\":\"echo check\"}"
        }});
        for output in [None, Some("plain output"), Some("{\"session_id\":123,\"output\":\"running\"}")] {
            let mut rows = vec![request.clone()];
            if let Some(output) = output { rows.push(json!({"type":"response_item","payload":{
                "type":"function_call_output","call_id":"command","output":output
            }})); }
            let content = rows.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
            let history = parse_session_history_content(&content).unwrap();
            assert!(!history.items.iter().any(|item| item.content.contains("[exit: 0]")), "{output:?}");
        }
        let content = format!("{}\n{}", request, json!({"type":"response_item","payload":{
            "type":"function_call_output","call_id":"command","output":"{\"exit_code\":1,\"output\":\"failed\"}"
        }}));
        assert!(parse_session_history_content(&content).unwrap().items.iter().any(|item| item.content.contains("[exit: 1]")));
    }

    fn fable_review_owned_patch(patch: &str, changes: Value, read_tail: bool) -> Vec<SessionHistoryItem> {
        let meta = json!({"type":"session_meta","payload":{"id":"session","cwd":"/repo"}});
        let tail = if read_tail { "text(await tools.exec_command({\"cmd\":\"cat /repo/keep\"}));" } else { "" };
        let request = json!({"type":"response_item","payload":{
            "type":"custom_tool_call","name":"exec","call_id":"wrapper",
            "input":format!("text(await tools.apply_patch({}));{tail}", serde_json::to_string(patch).unwrap()),
            "internal_chat_message_metadata_passthrough":{"turn_id":"turn"}
        }});
        let native = json!({"type":"event_msg","payload":{
            "type":"item_completed","thread_id":"session","turn_id":"turn",
            "item":{"type":"FileChange","id":"native-edit","status":"completed","changes":changes}
        }});
        let mut result = output("wrapper", "{}");
        if !read_tail { result["payload"]["output"].as_array_mut().unwrap().truncate(2); }
        result["payload"]["internal_chat_message_metadata_passthrough"] = json!({"turn_id":"turn"});
        let mut rows = vec![meta, request, native];
        if read_tail { rows.push(json!({"type":"event_msg","payload":{
            "type":"item_completed","thread_id":"session","turn_id":"turn",
            "item":{"type":"CommandExecution","id":"read-command","status":"completed","exit_code":0,
                "command":["/bin/zsh","-lc","cat /repo/keep"]}
        }})); }
        rows.push(result);
        files(rows)
    }

    #[test]
    fn fable_review_read_receipt_preserves_exclusive_patch_identity() {
        let rows = fable_review_owned_patch("*** Begin Patch\n*** Delete File: deleted\n*** End Patch", json!({
            "/repo/deleted":{"type":"delete","content":"old\n"}
        }), true);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].deletions, Some(1));
    }

    #[test]
    fn fable_review_owned_patch_uses_exact_paths_with_shared_suffixes() {
        let rows = fable_review_owned_patch("*** Begin Patch\n*** Update File: x\n@@\n-old\n+one\n*** Update File: b/x\n@@\n-old\n+two\n*** End Patch", json!({
            "/repo/x":{"type":"update","unified_diff":"@@\n-old\n+one\n"},
            "/repo/b/x":{"type":"update","unified_diff":"@@\n-old\n+two\n"}
        }), false);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows.iter().map(|row| row.additions.unwrap_or(0)).sum::<u32>(), 2);
    }

    fn call(id: &str) -> Value {
        let patch = "*** Begin Patch\n*** Update File: shared.rs\n@@\n-old\n+new\n*** End Patch";
        json!({"type":"response_item", "payload": {
            "type":"custom_tool_call", "name":"exec", "call_id":id,
            "input":format!("text(await tools.apply_patch({}));\ntext(await tools.exec_command({{\"cmd\":\"cargo test\"}}));", serde_json::to_string(patch).unwrap())
        }})
    }

    fn output(id: &str, patch_result: &str) -> Value {
        json!({"type":"response_item", "payload": {
            "type":"custom_tool_call_output", "call_id":id, "output":[
                {"type":"input_text","text":"Script completed\nWall time 1.3 seconds\nOutput:\n"},
                {"type":"input_text","text":patch_result},
                {"type":"input_text","text":"{\"session_id\":28810,\"output\":\"running tests\"}"}
            ]
        }})
    }

    fn native(diff: &str) -> Value {
        json!({"type":"event_msg", "payload": {
            "type":"patch_apply_end", "call_id":"exec-native", "success":true,
            "changes":{"shared.rs":{"type":"update","unified_diff":diff}}
        }})
    }

    fn files(rows: Vec<Value>) -> Vec<SessionHistoryItem> {
        let content = rows.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        parse_session_history_content(&content).unwrap().items.into_iter()
            .filter(|item| item.role == "file").collect()
    }

    #[test]
    fn exec_patch_history_exact_wrapper_array() {
        let rows = files(vec![call("a"), output("a", "{}")]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].file_path.as_deref(), Some("shared.rs"));
        assert_eq!((rows[0].additions, rows[0].deletions), (Some(1), Some(1)));
    }

    fn completed_file_change(status: &str) -> Value {
        let legacy = native("@@\n-old\n+new");
        json!({"type":"event_msg", "payload": {
            "type":"item_completed", "thread_id":"session", "turn_id":"turn",
            "item":{"type":"FileChange", "id":"exec-native", "status":status,
                "changes":legacy["payload"]["changes"]}
        }})
    }

    #[test]
    fn exec_patch_history_completed_file_change_requires_success() {
        let rows = files(vec![completed_file_change("completed")]);
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].additions, rows[0].deletions), (Some(1), Some(1)));
        for status in ["failed", "declined", "inProgress", "unknown", ""] {
            assert!(files(vec![completed_file_change(status)]).is_empty(), "{status}");
        }
        let mut started = completed_file_change("completed");
        started["payload"]["type"] = json!("item_started");
        assert!(files(vec![started]).is_empty());
        let mut other = completed_file_change("completed");
        other["payload"]["item"]["type"] = json!("CommandExecution");
        assert!(files(vec![other]).is_empty());
        let mut missing_id = completed_file_change("completed");
        missing_id["payload"]["item"]["id"] = json!("");
        assert!(files(vec![missing_id]).is_empty());
        assert_eq!(files(vec![completed_file_change("inProgress"), completed_file_change("completed")]).len(), 1);
    }

    #[test]
    fn exec_patch_history_completed_file_change_deduplicates_both_native_schemas() {
        let modern = completed_file_change("completed");
        let legacy = native("@@\n-old\n+new");
        for completions in [vec![modern.clone(), legacy.clone()], vec![legacy, modern.clone()]] {
            assert_eq!(files(completions.clone()).len(), 1);
            let mut rows = vec![call("a")];
            rows.extend(completions.clone());
            rows.push(output("a", "{}"));
            assert_eq!(files(rows).len(), 1);
            let mut rows = vec![call("a"), output("a", "{}")];
            rows.extend(completions);
            assert_eq!(files(rows).len(), 1);
        }
        assert!(files(vec![call("a"), completed_file_change("failed"), output("a", "{}")]).is_empty());
        for status in ["failed", "declined"] {
            assert!(files(vec![call("a"), output("a", "{}"), completed_file_change(status)]).is_empty());
        }
        let mut second = modern.clone();
        second["payload"]["item"]["id"] = json!("exec-another");
        assert_eq!(files(vec![modern, second]).len(), 2);
    }

    #[test]
    fn exec_patch_history_completed_file_change_confirms_direct_patch_identity() {
        let request = json!({"type":"response_item", "payload": {
            "type":"custom_tool_call", "name":"apply_patch", "call_id":"exec-native",
            "input":"*** Begin Patch\n*** Update File: shared.rs\n@@\n-old\n+new\n*** End Patch"
        }});
        let response = json!({"type":"response_item", "payload": {
            "type":"custom_tool_call_output", "call_id":"exec-native",
            "output":"{\"output\":\"Success. Updated the following files:\\nM shared.rs\",\"metadata\":{\"exit_code\":0}}"
        }});
        for status in ["completed", "failed"] {
            for native_first in [false, true] {
                let completion = completed_file_change(status);
                let mut rows = vec![call("wrapper"), request.clone()];
                rows.extend(if native_first { vec![completion, response.clone()] } else { vec![response.clone(), completion] });
                rows.push(output("wrapper", "{}"));
                assert_eq!(files(rows).len(), if status == "completed" { 2 } else { 1 });
            }
        }
    }

    #[test]
    fn exec_patch_history_failed_unknown_and_duplicate_output() {
        for result in ["{\"error\":\"failed\"}", "unknown", "{\"exit_code\":1}"] {
            assert!(files(vec![call("a"), output("a", result)]).is_empty());
        }
        assert!(files(vec![call("a")]).is_empty());
        assert_eq!(files(vec![call("a"), output("a", "{}"), output("a", "{}")]).len(), 1);
    }

    #[test]
    fn exec_patch_history_native_dedup_and_concurrent_same_file() {
        for diff in ["", "@@\n-old\n+new"] {
            assert_eq!(files(vec![call("a"), native(diff), output("a", "{}")]).len(), 1);
            assert_eq!(files(vec![call("a"), output("a", "{}"), native(diff)]).len(), 1);
            assert_eq!(files(vec![call("a"), call("b"), native(diff), output("b", "{}"), output("a", "{}")]).len(), 2);
        }
    }

    #[test]
    fn exec_patch_history_native_failure_and_unrelated_direct_call() {
        let mut failed = native("");
        failed["payload"]["success"] = json!(false);
        assert!(files(vec![call("a"), failed.clone(), output("a", "{}")]).is_empty());
        assert_eq!(files(vec![call("a"), call("b"), failed, output("a", "{}"), output("b", "{}")]).len(), 1);
        let direct = json!({"type":"response_item", "payload": {
            "type":"custom_tool_call", "name":"apply_patch", "call_id":"exec-native",
            "input":"*** Begin Patch\n*** Update File: shared.rs\n@@\n-old\n+new\n*** End Patch"
        }});
        assert_eq!(files(vec![call("a"), direct, native("@@\n-old\n+new"), output("a", "{}")]).len(), 2);
    }

    #[test]
    fn exec_patch_history_concurrent_distinct_edits() {
        let mut second = call("b");
        second["payload"]["input"] = json!(second["payload"]["input"].as_str().unwrap().replace("+new", "+new\\n+extra"));
        for diff in ["", "@@\n-old\n+new\n+extra"] {
            let rows = files(vec![call("a"), second.clone(), native(diff), output("b", "{}"), output("a", "{}")]);
            assert_eq!(rows.len(), 2);
            assert_eq!(rows.iter().map(|row| row.additions.unwrap_or(0)).sum::<u32>(), 3);
        }
    }

    #[test]
    fn exec_patch_history_decoded_newlines_and_multiple_patches() {
        let patch = "*** Begin Patch\n*** Update File: shared.rs\n@@\n-old\n+let value = \"literal\\n\";\n*** End Patch";
        let mut request = call("a");
        let printed = format!("text(await tools.apply_patch({}));", serde_json::to_string(patch).unwrap());
        request["payload"]["input"] = json!(format!("{printed}\n{printed}"));
        let mut response = output("a", "{}");
        response["payload"]["output"][2]["text"] = json!("{}");
        let rows = files(vec![request, response]);
        assert_eq!(rows.len(), 2);
        for row in rows {
            assert_eq!(row.additions, Some(1));
            assert!(row.content.contains("literal\\n"));
        }
    }

    // Session 01a07fde…: rows 345/346/348 and 350/352/353. Keep exact patch,
    // native diff, timestamps and result positions; sanitize paths/other tools.
    const TEAMS_PATCH_SLICE: &str = r###"{"timestamp": "2026-09-08T07:50:32.613Z", "type": "response_item", "payload": {"type": "custom_tool_call", "call_id": "call_TuptFXs5OfZDQi85Dscxkkqk", "name": "exec", "input": "text(await tools.exec_command({\"cmd\":\"true\"}));\ntext(await tools.apply_patch(\"*** Begin Patch\\n*** Update File: /repo/teams-service/test/aggregate.test.ts\\n@@\\n-  it(\\\"sorts descending and folds slivers under 3% into Other\\\", () => {\\n+  it(\\\"sorts providers descending without hiding lightly used agents\\\", () => {\\n@@\\n-    expect(m.map((s) => s.key)).toEqual([\\\"ClaudeCode\\\", \\\"Codex\\\", \\\"Grok\\\", \\\"Other\\\"]);\\n+    expect(m.map((s) => s.key)).toEqual([\\\"ClaudeCode\\\", \\\"Codex\\\", \\\"Grok\\\", \\\"Cursor\\\"]);\\n@@\\n   });\\n+\\n+  it(\\\"keeps Claude below 3% visible while still grouping the model long tail\\\", () => {\\n+    const buckets = [\\n+      b({ provider: \\\"Codex\\\", model: \\\"gpt-5\\\", tokens_in: 9990, active_ms: 999000 }),\\n+      b({ provider: \\\"ClaudeCode\\\", model: \\\"claude-sonnet\\\", tokens_in: 10, active_ms: 1000 }),\\n+      b({ provider: \\\"Cursor\\\", model: \\\"unknown\\\" }),\\n+    ];\\n+    expect(mix(buckets, \\\"provider\\\").map((s) => s.key)).toEqual([\\\"Codex\\\", \\\"ClaudeCode\\\"]);\\n+    expect(mix(buckets, \\\"model\\\").map((s) => s.key)).toEqual([\\\"gpt-5\\\", \\\"Other\\\"]);\\n+  });\\n*** End Patch\"));\ntext(await tools.exec_command({\"cmd\":\"true\"}));\n"}}
{"timestamp": "2026-09-08T07:50:32.783Z", "type": "event_msg", "payload": {"type": "patch_apply_end", "call_id": "exec-7f7c1d5b-dfbe-4fce-97cb-8f77b0e55411", "success": true, "changes": {"/repo/teams-service/test/aggregate.test.ts": {"type": "update", "unified_diff": "@@ -197,3 +197,3 @@\n describe(\"mix\", () => {\n-  it(\"sorts descending and folds slivers under 3% into Other\", () => {\n+  it(\"sorts providers descending without hiding lightly used agents\", () => {\n     const m = mix(\n@@ -207,3 +207,3 @@\n     );\n-    expect(m.map((s) => s.key)).toEqual([\"ClaudeCode\", \"Codex\", \"Grok\", \"Other\"]);\n+    expect(m.map((s) => s.key)).toEqual([\"ClaudeCode\", \"Codex\", \"Grok\", \"Cursor\"]);\n     expect(m[0]!.share).toBeCloseTo(0.58);\n@@ -212,2 +212,12 @@\n \n+  it(\"keeps Claude below 3% visible while still grouping the model long tail\", () => {\n+    const buckets = [\n+      b({ provider: \"Codex\", model: \"gpt-5\", tokens_in: 9990, active_ms: 999000 }),\n+      b({ provider: \"ClaudeCode\", model: \"claude-sonnet\", tokens_in: 10, active_ms: 1000 }),\n+      b({ provider: \"Cursor\", model: \"unknown\" }),\n+    ];\n+    expect(mix(buckets, \"provider\").map((s) => s.key)).toEqual([\"Codex\", \"ClaudeCode\"]);\n+    expect(mix(buckets, \"model\").map((s) => s.key)).toEqual([\"gpt-5\", \"Other\"]);\n+  });\n+\n   it(\"returns nothing when there are no tokens, rather than a zero slice\", () => {\n", "move_path": null}}}}
{"timestamp": "2026-09-08T07:50:33.280Z", "type": "response_item", "payload": {"type": "custom_tool_call_output", "call_id": "call_TuptFXs5OfZDQi85Dscxkkqk", "output": [{"type": "input_text", "text": "Script completed\nWall time 0.7 seconds\nOutput:\n"}, {"type": "input_text", "text": "{\"exit_code\": 1}"}, {"type": "input_text", "text": "{}"}, {"type": "input_text", "text": "{\"exit_code\": 0}"}]}}
{"timestamp": "2026-09-08T07:50:51.814Z", "type": "response_item", "payload": {"type": "custom_tool_call", "call_id": "call_n0YKYaIXO59AVbDpB1zWaDqh", "name": "exec", "input": "text(await tools.exec_command({\"cmd\":\"true\"}));\ntext(await tools.apply_patch(\"*** Begin Patch\\n*** Update File: /repo/teams-service/src/aggregate.ts\\n@@\\n- * Anything under 3% of *both* metrics is folded into \\\"Other\\\" — matching the\\n- * chart spec, which refuses a long tail of slivers, while keeping a slice that\\n- * is small in tokens but large in time (or vice versa).\\n+ * Every used provider stays visible, including occasional usage. Model slices\\n+ * under 3% of both metrics are folded into \\\"Other\\\" to keep the long tail short.\\n@@\\n-  minShare = 0.03,\\n+  minShare = field === \\\"provider\\\" ? 0 : 0.03,\\n@@\\n   for (const [key, v] of byKey) {\\n+    if (v.tokens === 0 && v.activeMs === 0) continue;\\n*** End Patch\"));\ntext(await tools.exec_command({\"cmd\":\"true\"}));\n"}}
{"timestamp": "2026-09-08T07:50:55.785Z", "type": "event_msg", "payload": {"type": "patch_apply_end", "call_id": "exec-3a1b5067-b5a1-4b67-8b03-e0e5878f7a8f", "success": true, "changes": {"/repo/teams-service/src/aggregate.ts": {"type": "update", "unified_diff": "@@ -390,5 +390,4 @@\n  * Share of tokens *and* active time by `field`, sorted descending by tokens.\n- * Anything under 3% of *both* metrics is folded into \"Other\" — matching the\n- * chart spec, which refuses a long tail of slivers, while keeping a slice that\n- * is small in tokens but large in time (or vice versa).\n+ * Every used provider stays visible, including occasional usage. Model slices\n+ * under 3% of both metrics are folded into \"Other\" to keep the long tail short.\n  */\n@@ -397,3 +396,3 @@\n   field: \"provider\" | \"model\",\n-  minShare = 0.03,\n+  minShare = field === \"provider\" ? 0 : 0.03,\n ): MixSlice[] {\n@@ -419,2 +418,3 @@\n   for (const [key, v] of byKey) {\n+    if (v.tokens === 0 && v.activeMs === 0) continue;\n     const tokenShare = totalTokens > 0 ? v.tokens / totalTokens : 0;\n", "move_path": null}}}}
{"timestamp": "2026-09-08T07:50:56.273Z", "type": "response_item", "payload": {"type": "custom_tool_call_output", "call_id": "call_n0YKYaIXO59AVbDpB1zWaDqh", "output": [{"type": "input_text", "text": "Script completed\nWall time 4.5 seconds\nOutput:\n"}, {"type": "input_text", "text": "{\"exit_code\": 0}"}, {"type": "input_text", "text": "{}"}, {"type": "input_text", "text": "{\"exit_code\": 0}"}]}}"###;

    fn totals(history: &SessionHistoryResult) -> (u32, u32) {
        history.items.iter().filter(|item| item.role == "file").fold((0, 0), |(a, d), item| {
            (a + item.additions.unwrap_or(0), d + item.deletions.unwrap_or(0))
        })
    }

    #[test]
    fn exec_patch_history_exact_teams_slice() {
        let history = parse_session_history_content(TEAMS_PATCH_SLICE).unwrap();
        assert_eq!(totals(&history), (16, 6));
        let rows: Vec<_> = history.items.iter().filter(|item| item.role == "file").collect();
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].additions, rows[0].deletions), (Some(12), Some(2)));
        assert_eq!((rows[1].additions, rows[1].deletions), (Some(4), Some(4)));
        // Native-first and output-first reads must agree.
        let mut slice: Vec<Value> = TEAMS_PATCH_SLICE.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        slice.swap(1, 2);
        slice.swap(4, 5);
        assert_eq!(files(slice).len(), 2);
    }

    #[test]
    fn exec_patch_history_blank_boundaries_preserve_distinct_edits() {
        let mut request = call("a");
        let patch = "*** Begin Patch\n*** Update File: shared.rs\n@@\n-old\n+\n+first\n+second\n*** End Patch";
        request["payload"]["input"] = json!(format!("text(await tools.apply_patch({}));\ntext(await tools.exec_command({{\"cmd\":\"cargo test\"}}));", serde_json::to_string(patch).unwrap()));
        let matching = native("@@\n-old\n+first\n+second\n+");
        assert_eq!(files(vec![request.clone(), matching.clone(), output("a", "{}")]).len(), 1);
        let mut repeated = request.clone();
        repeated["payload"]["call_id"] = json!("b");
        assert_eq!(files(vec![request.clone(), repeated, matching, output("a", "{}"), output("b", "{}")]).len(), 2);
        for diff in [
            "@@\n-old\n+first\n+\n+second", // internal blank has different meaning
            "@@\n-old\n+first\n+second", // blank count differs
            "@@\n-old\n+second\n+first\n+", // line order differs
            "@@\n-old\n+first \n+second\n+", // whitespace is content
        ] {
            assert_eq!(files(vec![request.clone(), native(diff), output("a", "{}")]).len(), 2, "{diff}");
        }
        let mut other_file = native("@@\n-old\n+first\n+second\n+");
        other_file["payload"]["changes"] = json!({"not-shared.rs":other_file["payload"]["changes"]["shared.rs"].clone()});
        assert_eq!(files(vec![request, other_file, output("a", "{}")]).len(), 2);
    }

    #[test]
    fn exec_patch_history_context_shifts_keep_authoritative_native_counts() {
        // Compact forms of the retained Teams edits: attributes and braces can
        // move between context and additions; re-added old lines are unchanged.
        for (patch, diff) in [
            ("@@\n mod tests {\n use super::*;\n+\n+#[test]\n+fn added() {}",
             "@@\n #[test]\n+fn added() {}\n+\n+#[test]\n fn existing() {}"),
            ("@@\n-old_call\n+new_call\n+}\n+\n+fn added() {\n+body",
             "@@\n-old_call\n+new_call\n }\n \n+fn added() {\n+body\n+}\n+\n next_function"),
            ("@@\n-same\n-old\n+same\n+new\n+added",
             "@@\n same\n-old\n+new\n+added"),
            ("@@\n-fn existing(\n+fn helper() {}\n+\n+fn existing(\n+new_argument",
             "@@\n context\n+fn helper() {}\n+\n fn existing(\n+new_argument\n old_argument"),
        ] {
            let mut request = call("a");
            let patch = format!("*** Begin Patch\n*** Update File: shared.rs\n{patch}\n*** End Patch");
            request["payload"]["input"] = json!(format!("text(await tools.apply_patch({}));", serde_json::to_string(&patch).unwrap()));
            let response = json!({"type":"response_item", "payload": {
                "type":"custom_tool_call_output", "call_id":"a", "output":[
                    {"type":"input_text","text":"Script completed\nOutput:\n"},
                    {"type":"input_text","text":"{}"}
                ]
            }});
            for native_first in [true, false] {
                let mut rows = vec![request.clone()];
                rows.extend(if native_first { vec![native(diff), response.clone()] } else { vec![response.clone(), native(diff)] });
                let rows = files(rows);
                assert_eq!(rows.len(), 1, "{diff}");
                let expected = count_history_diff_lines(diff);
                assert_eq!((rows[0].additions, rows[0].deletions), (Some(expected.0), Some(expected.1)), "{diff}");
            }
        }
    }

    #[test]
    fn exec_patch_history_context_shifts_require_context_and_order() {
        let mut request = call("a");
        let patch = "*** Begin Patch\n*** Update File: shared.rs\n@@\n+#[test]\n+first\n+second\n*** End Patch";
        request["payload"]["input"] = json!(format!("text(await tools.apply_patch({}));\ntext(await tools.exec_command({{\"cmd\":\"cargo test\"}}));", serde_json::to_string(patch).unwrap()));
        for diff in ["@@\n+first\n+second\n+#[test]", "@@\n unrelated\n+first\n+second\n+#[test]",
            "@@\n #[test]\n+second\n+first\n+#[test]", "@@\n #[test]\n+first \n+second\n+#[test]"] {
            assert_eq!(files(vec![request.clone(), native(diff), output("a", "{}")]).len(), 2, "{diff}");
        }
        // One context line cannot be moved both before and after its neighbors.
        assert!(!history_patches_equivalent("@@\n+x\n+a\n x\n+b\n+x", "@@\n+a\n+x\n+x\n+b"));
        assert!(!history_patches_equivalent("@@\n+ctx\n+body", "@@\n ctx\n@@\n+body\n+ctx"));
    }

    #[test]
    fn exec_patch_history_replacement_order_and_internal_context() {
        for (patch, native_diff) in [
            ("@@\n+new1\n+new2\n-old1\n-old2", "@@\n-old1\n-old2\n+new1\n+new2"),
            ("@@\n-old1\n-same\n-old2\n+new1\n+same\n+new2", "@@\n-old1\n+new1\n same\n-old2\n+new2"),
            ("@@\n-old1\n-old2\n+new1\n+old1\n+new2\n-old3\n+new3", "@@\n+new1\n old1\n-old2\n-old3\n+new2\n+new3"),
            ("@@\n-old\n+new\n ctx\n-removed\n+updated\n common1\n common2\n-tail\n+next\n+common1\n+common2\n+tail2",
             "@@\n-old\n+new\n ctx\n-removed\n+updated\n+common1\n+common2\n+next\n common1\n common2\n-tail\n+tail2"),
        ] {
            assert!(history_patches_equivalent(patch, native_diff), "{patch}\nvs\n{native_diff}");
            let patch = format!("*** Begin Patch\n*** Update File: shared.rs\n{patch}\n*** End Patch");
            let mut request = call("a");
            request["payload"]["input"] = json!(format!("text(await tools.apply_patch({}));", serde_json::to_string(&patch).unwrap()));
            for native_first in [true, false] {
                let mut rows = vec![request.clone()];
                rows.extend(if native_first { vec![native(native_diff), output("a", "{}")] }
                    else { vec![output("a", "{}"), native(native_diff)] });
                let rows = files(rows);
                assert_eq!(rows.len(), 1);
                let (added, removed) = count_history_diff_lines(native_diff);
                assert_eq!((rows[0].additions, rows[0].deletions), (Some(added), Some(removed)));
            }
        }
        assert!(!history_patches_equivalent("@@\n+a\n+b\n-x", "@@\n-x\n+b\n+a"));
    }

    #[test]
    fn exec_patch_history_relative_mixed_patch_uses_native_deletion_once() {
        let patch = "*** Begin Patch\n*** Update File: update.txt\n@@\n-old\n+new\n keep\n*** Delete File: delete.txt\n*** Add File: add.txt\n+added-one\n+added-two\n*** End Patch";
        let meta = json!({"type":"session_meta","payload":{"id":"session","cwd":"/repo"}});
        let request = json!({"type":"response_item","payload":{
            "type":"custom_tool_call","name":"exec","call_id":"wrapper",
            "input":format!("text(await tools.apply_patch({}));", serde_json::to_string(patch).unwrap()),
            "internal_chat_message_metadata_passthrough":{"turn_id":"turn"}
        }});
        let native = json!({"type":"event_msg","payload":{
            "type":"item_completed","thread_id":"session","turn_id":"turn",
            "item":{"type":"FileChange","id":"exec-native","status":"completed","changes":{
                "/repo/update.txt":{"type":"update","unified_diff":"@@ -1,2 +1,2 @@\n-old\n+new\n keep\n"},
                "/repo/delete.txt":{"type":"delete","content":"delete-one\ndelete-two\n"},
                "/repo/add.txt":{"type":"add","content":"added-one\nadded-two\n"}
            }}
        }});
        let mut result = output("wrapper", "{}");
        result["payload"]["internal_chat_message_metadata_passthrough"] = json!({"turn_id":"turn"});
        result["payload"]["output"].as_array_mut().unwrap().truncate(2);
        let rows = files(vec![meta.clone(), request.clone(), native.clone(), result.clone()]);
        assert_eq!(rows.len(), 3, "relative deletion must not survive beside its authoritative native record");
        assert!(rows.iter().all(|row| row.tool_input.as_ref().unwrap()["nativeEdit"] == true));
        assert_eq!(rows.iter().map(|row| row.additions.unwrap_or(0)).sum::<u32>(), 3);
        assert_eq!(rows.iter().map(|row| row.deletions.unwrap_or(0)).sum::<u32>(), 3);
        for cwd in ["", "relative", "/other"] {
            let mut invalid = meta.clone();
            invalid["payload"]["cwd"] = json!(cwd);
            assert_eq!(files(vec![invalid, request.clone(), native.clone(), result.clone()]).len(), 4,
                "unverified relative scope must not establish patch ownership");
        }
        let mut traversal = request.clone();
        traversal["payload"]["input"] = json!(format!("text(await tools.apply_patch({}));",
            serde_json::to_string(&patch.replace("delete.txt", "../repo/delete.txt")).unwrap()));
        assert_eq!(files(vec![meta, traversal, native, result]).len(), 4);
    }

    #[test]
    fn exec_patch_history_single_pending_literal_owns_native_placement() {
        let patch = "*** Begin Patch\n*** Update File: /repo/a.ts\n@@\n+import\n@@\n context\n+body\n*** Update File: /repo/b.ts\n@@\n-old\n+new\n*** End Patch";
        let request = json!({"type":"response_item", "payload":{
            "type":"custom_tool_call", "name":"exec", "call_id":"wrapper",
            "input":format!("text(await tools.apply_patch({}));\ntext(await tools.exec_command({{\"cmd\":\"cat /repo/a.ts\"}}));", serde_json::to_string(patch).unwrap()),
            "internal_chat_message_metadata_passthrough":{"turn_id":"turn"}
        }});
        let native = json!({"type":"event_msg", "payload":{
            "type":"patch_apply_end", "call_id":"exec-native", "turn_id":"turn", "success":true,
            "changes":{
                "/repo/a.ts":{"type":"update", "unified_diff":"@@\n context\n+body\n@@\n end\n+import"},
                "/repo/b.ts":{"type":"update", "unified_diff":"@@\n-old\n+new"}
            }
        }});
        let mut result = output("wrapper", "{}");
        result["payload"]["internal_chat_message_metadata_passthrough"] = json!({"turn_id":"turn"});
        let rows = files(vec![request.clone(), native.clone(), result.clone()]);
        assert_eq!(rows.len(), 2, "the native placement is authoritative for its proven wrapper");
        assert!(rows.iter().all(|row| !row.content.starts_with("***")));
        let owner = PendingExecPatchOwner { call_id: "wrapper".into(), turn_id: "turn".into(),
            native: Some(native["payload"].clone()), read: None };
        for option in [",\"cmd\":\"python3 edit.py\"", ",\"shell\":\"custom-shell\"", ",\"unknown\":true"] {
            let source = request["payload"]["input"].as_str().unwrap()
                .replace("\"cat /repo/a.ts\"}", &format!("\"cat /repo/a.ts\"{option}}}"));
            assert!(owner.verified_native_id(&source, &[patch.to_string()], &result["payload"], "/repo").is_none());
        }

        let mut wrong_turn = native.clone();
        wrong_turn["payload"]["turn_id"] = json!("other");
        let mut wrong_files = native.clone();
        wrong_files["payload"]["changes"].as_object_mut().unwrap().remove("/repo/b.ts");
        let mut multiple = request.clone();
        multiple["payload"]["input"] = json!(format!("{}\ntext(await tools.apply_patch ({}));",
            request["payload"]["input"].as_str().unwrap(), serde_json::to_string(patch).unwrap()));
        let mut multiple_result = result.clone();
        multiple_result["payload"]["output"].as_array_mut().unwrap().push(json!({"type":"input_text","text":"{}"}));
        let mut missing_turn = request.clone();
        missing_turn["payload"].as_object_mut().unwrap().remove("internal_chat_message_metadata_passthrough");
        let mut wrong_output_turn = result.clone();
        wrong_output_turn["payload"]["internal_chat_message_metadata_passthrough"]["turn_id"] = json!("other");
        let mut wrong_thread = native.clone();
        wrong_thread["payload"]["thread_id"] = json!("another-session");
        let mut shell_patch = request.clone();
        shell_patch["payload"]["input"] = json!(request["payload"]["input"].as_str().unwrap().replace("cat /repo/a.ts", "apply_patch some.patch"));
        let mut arbitrary_shell = request.clone();
        arbitrary_shell["payload"]["input"] = json!(request["payload"]["input"].as_str().unwrap().replace("cat /repo/a.ts", "python3 edit.py"));
        let mut second_native = native.clone();
        second_native["payload"]["call_id"] = json!("exec-other");
        let failed_native = json!({"type":"event_msg","payload":{
            "type":"patch_apply_end","call_id":"exec-failed","turn_id":"turn","success":false,"changes":{}
        }});
        let mut test_shell = request.clone();
        test_shell["payload"]["input"] = json!(request["payload"]["input"].as_str().unwrap().replace("cat /repo/a.ts", "cargo test"));
        for rows in [
            vec![request.clone(), wrong_turn, result.clone()],
            vec![request.clone(), wrong_files, result.clone()],
            vec![request.clone(), call("overlapping"), native.clone(), result.clone()],
            vec![call("already-pending"), request.clone(), native.clone(), result.clone()],
            vec![request.clone(), result.clone(), native.clone()],
            vec![multiple, native.clone(), multiple_result],
            vec![missing_turn, native.clone(), result.clone()],
            vec![request.clone(), native.clone(), wrong_output_turn],
            vec![request.clone(), wrong_thread, result.clone()],
            vec![shell_patch, native.clone(), result.clone()],
            vec![arbitrary_shell, native.clone(), result.clone()],
            vec![test_shell, native.clone(), result.clone()],
            vec![request.clone(), native.clone(), second_native, result.clone()],
            vec![request.clone(), failed_native, native.clone(), result.clone()],
            vec![request.clone(), json!({"type":"event_msg", "payload":{"type":"task_started","turn_id":"turn"}}), native.clone(), result.clone()],
        ] {
            assert!(files(rows).iter().any(|row| row.file_path.as_deref() == Some("/repo/a.ts") && row.content.starts_with("***")),
                "ambiguous ownership must retain the independently confirmed wrapper");
        }
        // An older completed wrapper with the same native edit signature must
        // not steal the native result from its explicitly proven current owner.
        let older_patch = "*** Begin Patch\n*** Update File: /repo/a.ts\n@@\n context\n+body\n@@\n end\n+import\n*** End Patch";
        let mut older = call("older");
        older["payload"]["input"] = json!(format!("text(await tools.apply_patch({}));\ntext(await tools.exec_command({{\"cmd\":\"cat /repo/a.ts\"}}));", serde_json::to_string(older_patch).unwrap()));
        let rows = files(vec![older, output("older", "{}"), request.clone(), native.clone(), result]);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows.iter().filter(|row| row.content.starts_with("***")).count(), 1);
        assert!(rows.iter().any(|row| row.content == older_patch.trim_start_matches("*** Begin Patch\n").trim_end_matches("\n*** End Patch")));
        let direct = json!({"type":"response_item","payload":{
            "type":"custom_tool_call","name":"apply_patch","call_id":"direct","input":patch
        }});
        let mut direct_native = native.clone();
        direct_native["payload"]["call_id"] = json!("direct");
        assert_eq!(files(vec![direct, request.clone(), direct_native, output("wrapper", "{}")]).len(), 4);
        let mut unprinted = request.clone();
        unprinted["payload"]["input"] = json!(format!("await tools.apply_patch({});", serde_json::to_string(patch).unwrap()));
        assert_eq!(files(vec![unprinted, native.clone(), output("wrapper", "{}")]).len(), 2);
        // Neither missing nor failed output grants provenance or wrapper counts.
        assert_eq!(files(vec![request.clone(), native.clone()]).len(), 2);
        assert_eq!(files(vec![request, native, output("wrapper", "{\"error\":\"failed\"}")]).len(), 2);
    }

    #[test]
    fn exec_patch_history_uses_retained_read_context_for_deletion_boundary() {
        let before = "start\n badge\n },\n {item\n action\n badge\n },\nend\n";
        let meta = json!({"type":"session_meta","payload":{"id":"session","cwd":"/repo"}});
        let read = json!({"type":"response_item","payload":{
            "type":"custom_tool_call","name":"exec","call_id":"read",
            "input":"text(await tools.exec_command({cmd:\"cat /repo/a.ts\",max_output_tokens:4000}));",
            "internal_chat_message_metadata_passthrough":{"turn_id":"turn"}
        }});
        let read_result = |text: &str| json!({"type":"response_item","payload":{
            "type":"custom_tool_call_output","call_id":"read","output":[
                {"type":"input_text","text":"Script completed\nOutput:\n"},
                {"type":"input_text","text":json!({"exit_code":0,"output":text}).to_string()}
            ], "internal_chat_message_metadata_passthrough":{"turn_id":"turn"}
        }});
        let patch = "*** Begin Patch\n*** Update File: /repo/a.ts\n@@\n- {item\n- action\n- badge\n- },\n*** End Patch";
        let mut request = call("wrapper");
        request["payload"]["input"] = json!(format!("text(await tools.apply_patch({}));\ntext(await tools.exec_command({{\"cmd\":\"cargo test\"}}));", serde_json::to_string(patch).unwrap()));
        request["payload"]["internal_chat_message_metadata_passthrough"] = json!({"turn_id":"turn"});
        let native = json!({"type":"event_msg","payload":{
            "type":"patch_apply_end","call_id":"exec-native","turn_id":"turn","success":true,
            "changes":{"/repo/a.ts":{"type":"update","unified_diff":"@@ -1,6 +1,2 @@\n start\n- badge\n- },\n- {item\n- action\n  badge\n"}}
        }});
        let mut result = output("wrapper", "{}");
        result["payload"]["internal_chat_message_metadata_passthrough"] = json!({"turn_id":"turn"});
        let replay = |read_output, extra: Option<Value>| {
            let mut rows = vec![meta.clone(), read.clone(), read_output];
            if let Some(extra) = extra { rows.push(extra); }
            rows.extend([request.clone(), native.clone(), result.clone()]);
            files(rows)
        };
        let rows = replay(read_result(before), None);
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].additions, rows[0].deletions), (Some(0), Some(4)));
        assert_eq!(replay(read_result(&before.replace(" action", " different")), None).len(), 2);
        assert_eq!(replay(read_result(before), Some(call("intervening"))).len(), 2);
        assert_eq!(replay(read_result("Warning: truncated output\n"), None).len(), 2);
    }

    #[test]
    fn exec_patch_history_test_tail_native_edit_does_not_consume_initial_patch() {
        let patch = "*** Begin Patch\n*** Update File: /repo/a.ts\n@@\n-old\n+new\n*** End Patch";
        for command in ["cargo test", "npm run test -- test.ts", "npx tsc --noEmit"] {
            let request = json!({"type":"response_item","payload":{
                "type":"custom_tool_call","name":"exec","call_id":"wrapper",
                "input":format!("text(await tools.apply_patch({}));\ntext(await tools.exec_command({{\"cmd\":{}}}));", serde_json::to_string(patch).unwrap(), serde_json::to_string(command).unwrap()),
                "internal_chat_message_metadata_passthrough":{"turn_id":"turn"}
            }});
            // The first patch has a successful result but no native event. The
            // executable tail then makes a DIFFERENT successful edit to the file.
            let native = json!({"type":"event_msg","payload":{
                "type":"patch_apply_end","call_id":"exec-from-test","turn_id":"turn","success":true,
                "changes":{"/repo/a.ts":{"type":"update","unified_diff":"@@\n-new\n+later"}}
            }});
            let mut result = output("wrapper", "{}");
            result["payload"]["internal_chat_message_metadata_passthrough"] = json!({"turn_id":"turn"});
            let rows = files(vec![request, native, result]);
            assert_eq!(rows.len(), 2, "{command}");
            assert_eq!(rows.iter().map(|row| row.additions.unwrap_or(0)).sum::<u32>(), 2);
            assert_eq!(rows.iter().map(|row| row.deletions.unwrap_or(0)).sum::<u32>(), 2);
        }
    }

    #[test]
    fn retained_read_context_rejects_ambiguous_concatenated_file_boundaries() {
        let native = json!({"changes":{
            "/repo/a":{"unified_diff":"@@ -1,2 +1,1 @@\n first\n-old\n"},
            "/repo/b":{"unified_diff":"@@ -1,1 +1,1 @@\n-second\n+new\n"}
        }});
        let mut read = RetainedHistoryRead {
            paths: vec!["/repo/a".into(), "/repo/b".into()],
            content: "first\nold\nend\nsecond\n".into(), turn_id: "turn".into(),
        };
        let (_, extended) = read.native_context(&native).unwrap();
        assert!(extended.ends_with(" end"));
        assert!(!extended.contains("second"));
        read.content.push_str("second\n");
        assert!(read.native_context(&native).is_none());
        read.content = "first\ndifferent\nend\nsecond\n".into();
        assert!(read.native_context(&native).is_none());
    }

    #[test]
    fn exec_patch_history_context_variants_are_bounded_and_ignore_headers() {
        let diff = "@@\n ctx\n+body\n+ctx";
        assert_eq!(history_patch_variants(diff), history_patch_variants(&format!("--- a\n+++ b\n{diff}")));
        let many_shifts = format!("@@\n{}", ["+x", " x"].repeat(10).join("\n"));
        assert!(history_patch_variants(&many_shifts).is_none());
        assert!(history_patch_variants("@@\n-same\n+same").is_none());
    }

    #[test]
    fn direct_patch_history_requires_confirmed_success() {
        for name in ["apply_patch", "apply_patch_freeform"] {
            let request = json!({"type":"response_item", "payload": {
                "type":"custom_tool_call", "name":name, "call_id":"exec-native",
                "input":"*** Begin Patch\n*** Update File: shared.rs\n@@\n-old\n+new\n*** End Patch"
            }});
            assert!(files(vec![request.clone()]).is_empty(), "pending patch must not flush as success");
            for result in ["", "unknown", "Error: patch failed", "{}", "{\"error\":\"failed\"}", "{\"metadata\":{\"exit_code\":1}}"] {
                let response = json!({"type":"response_item", "payload": {
                    "type":"custom_tool_call_output", "call_id":"exec-native", "output":result
                }});
                assert!(files(vec![request.clone(), response]).is_empty(), "{result}");
            }
            let response = json!({"type":"response_item", "payload": {
                "type":"custom_tool_call_output", "call_id":"exec-native",
                "output":"{\"output\":\"Success. Updated the following files:\\nM shared.rs\",\"metadata\":{\"exit_code\":0}}"
            }});
            assert_eq!(files(vec![request.clone(), response.clone()]).len(), 1);
            for native_first in [false, true] {
                let mut rows = vec![request.clone()];
                let completion = native("@@\n-old\n+new");
                rows.extend(if native_first { vec![completion, response.clone()] } else { vec![response.clone(), completion] });
                // Even an identical wrapper edit is a distinct tool call.
                rows.insert(0, call("wrapper"));
                rows.push(output("wrapper", "{}"));
                assert_eq!(files(rows).len(), 2);
            }
        }
    }

    #[test]
    fn exec_patch_history_exact_local_full_read_delta() {
        let Ok(path) = std::env::var("AGMUX_CODEX_HISTORY_EXACT_REPLAY") else { return; };
        let content = std::fs::read_to_string(path).unwrap();
        let prefix = |cutoff: &str| content.lines().filter(|line| {
            serde_json::from_str::<Value>(line).unwrap()["timestamp"].as_str().unwrap_or("") < cutoff
        }).collect::<Vec<_>>().join("\n");
        let before = totals(&parse_session_history_content(&prefix("2026-09-08T07:48")).unwrap());
        let after = totals(&parse_session_history_content(&prefix("2026-09-08T07:51")).unwrap());
        // The old parser also duplicated six earlier wrappers (+151/-0), at
        // native rows 70, 91, 131, 162, 187 and 270. These are full-read totals,
        // not the old inflated baseline plus only the follow-up correction.
        assert_eq!(before, (221, 23));
        assert_eq!(after, (237, 29));
        assert_eq!((after.0 - before.0, after.1 - before.1), (16, 6));
        for (cutoff, expected) in [("2026-09-08T07:48", before), ("2026-09-08T07:51", after)] {
            let mut seen = std::collections::HashSet::new();
            let native = prefix(cutoff).lines().map(|line| serde_json::from_str::<Value>(line).unwrap())
                .filter(|row| row["type"] == "event_msg")
                .flat_map(|row| {
                    let Some(payload) = history_native_patch_event(&row["payload"]) else { return Vec::new(); };
                    if let Some(id) = payload["call_id"].as_str().filter(|id| !id.is_empty()) {
                        if !seen.insert(id.to_string()) { return Vec::new(); }
                    }
                    file_changes_from_patch_apply_end(&payload)
                })
                .fold((0, 0), |(a, d), change| (a + change.additions, d + change.deletions));
            assert_eq!(native, expected, "full read must count each actual native edit exactly once");
        }
        eprintln!("exact full-read prefixes: {before:?} -> {after:?}; delta +16/-6");
    }

    #[test]
    fn exec_patch_history_local_replay() {
        let Ok(path) = std::env::var("AGMUX_CODEX_HISTORY_REPLAY") else { return; };
        let history = parse_session_history_content(&std::fs::read_to_string(path).unwrap()).unwrap();
        let files: Vec<_> = history.items.iter().filter(|item| item.role == "file").collect();
        eprintln!("replayed file rows: {}, additions: {}, deletions: {}", files.len(),
            files.iter().map(|item| item.additions.unwrap_or(0)).sum::<u32>(),
            files.iter().map(|item| item.deletions.unwrap_or(0)).sum::<u32>());
        assert!(files.len() >= 2);
    }
}

#[cfg(test)]
mod native_ownership_tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn creation_persists_only_the_returned_session() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/041_teams_created_claude_sessions.sql")).execute(&pool).await.unwrap();
        sqlx::raw_sql("CREATE TABLE threads(provider TEXT, id TEXT)").execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/042_session_origins.sql")).execute(&pool).await.unwrap();
        sqlx::raw_sql("CREATE TABLE teams_sync_state(id INTEGER, agmux_sessions_only INTEGER); INSERT INTO teams_sync_state VALUES (1,2)").execute(&pool).await.unwrap();
        assert!(record_native_codex_creation(&pool, &json!({"error": "launch failed"})).await.is_err());
        let response = json!({"thread": {"id": "child-native"}, "parentThreadId": "external-parent"});
        record_native_codex_creation(&pool, &response).await.unwrap();
        record_native_codex_creation(&pool, &response).await.unwrap();
        let rows: Vec<(String, String, bool)> = sqlx::query_as(
            "SELECT o.owner_id,b.session_id,o.created_in_agmux FROM session_origins o JOIN session_origin_bindings b ON b.provider=o.provider AND b.owner_id=o.owner_id",
        ).fetch_all(&pool).await.unwrap();
        assert_eq!(rows, vec![("child-native".into(), "child-native".into(), true)]);
        let origins: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM session_origins").fetch_one(&pool).await.unwrap();
        assert_eq!(origins, 1, "failed creation and fork parent must not gain origins");
    }

    #[test]
    fn creation_uses_returned_child_identity_only() {
        let response = json!({"thread": {"id": "child-native"}, "parentThreadId": "external-parent"});
        assert_eq!(native_created_thread_id(&response).unwrap(), "child-native");
        assert_eq!(native_created_thread_id(&json!({"result": {"thread": {"sessionId": "nested-native"}}})).unwrap(), "nested-native");
        for response in [json!({"parentThreadId": "external-parent"}), json!({"thread": {"id": ""}}), json!({"thread": {"id": "../outside"}})] {
            assert!(native_created_thread_id(&response).is_err());
        }
    }
}

#[cfg(test)]
mod live_snapshot_cache_tests {
    use super::*;

    #[test]
    fn oversized_summary_is_returned_without_retention() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let model = "x".repeat(17 * 1024);
        std::fs::write(&path, serde_json::json!({
            "type": "turn_context", "payload": { "model": model }
        }).to_string()).unwrap();
        assert_eq!(scan_live_snapshot_from_file(&path).model.as_deref(), Some(model.as_str()));
        assert!(session_read_cache().snapshot(&path, || None).is_none());
    }

    #[test]
    fn read_error_preserves_partial_summary_without_retention() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let mut bytes = b"{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-test\"}}\n".to_vec();
        bytes.extend_from_slice(&[0xff, b'\n']);
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(scan_live_snapshot_from_file(&path).model.as_deref(), Some("gpt-test"));
        assert!(session_read_cache().snapshot(&path, || None).is_none());
    }
}
