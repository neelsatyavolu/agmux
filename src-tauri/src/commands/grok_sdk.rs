//! Tauri commands bridging the frontend to the Grok ACP server.
//!
//! The frontend talks to one or more grok subprocesses through these commands;
//! events from the subprocess flow back through `sdk-event-{threadId}` emissions
//! made by `grok::app_server::GrokAppServer`. One grok process per thread, so
//! per-thread spawn flags (permission mode / effort / plan) are honored
//! without cross-thread interference.

use crate::db::models::Thread;
use crate::db::queries;
use crate::grok::app_server::{
    resume_session_action, AcpPromptImage, GrokAppServer, GrokSpawnConfig, ResumeAction,
};
use crate::state::AppState;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

async fn grok_prompt_gate(thread_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    static GATES: std::sync::OnceLock<tokio::sync::Mutex<std::collections::HashMap<String, std::sync::Weak<tokio::sync::Mutex<()>>>>> = std::sync::OnceLock::new();
    let mut gates = GATES.get_or_init(Default::default).lock().await;
    gates.retain(|_, gate| gate.strong_count() > 0);
    if let Some(gate) = gates.get(thread_id).and_then(std::sync::Weak::upgrade) { return gate; }
    let gate = Arc::new(tokio::sync::Mutex::new(()));
    gates.insert(thread_id.to_string(), Arc::downgrade(&gate));
    gate
}

/// Path to the cached ACP session id for this thread. Mirrors Droid's
/// `droid-session-id.txt` convention so resume works across app restarts
/// without a DB migration.
/// Knowledge-work overlay. Same file as the frontend. Tools stay the regular
/// Grok ACP set — this only replaces the system prompt via session `_meta`.
const GROK_COWORK_SYSTEM_PROMPT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../src/lib/prompts/grok-cowork-system-prompt.txt"
));

fn grok_cowork_system_prompt(thread: Option<&Thread>) -> Option<String> {
    let profile = thread.and_then(|t| t.agent_profile.as_deref())?;
    (profile == "cowork").then(|| GROK_COWORK_SYSTEM_PROMPT.trim().to_string())
}

fn grok_session_id_file(state_dir: &str) -> PathBuf {
    PathBuf::from(state_dir).join("grok-session-id.txt")
}

fn read_cached_session_id(state_dir: &str) -> Option<String> {
    std::fs::read_to_string(grok_session_id_file(state_dir))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn write_cached_session_id(state_dir: &str, session_id: &str) {
    let path = grok_session_id_file(state_dir);
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
    match queries::update_thread_grok_session_and_model(
        &state.db,
        thread_id,
        session_id,
        None,
    )
    .await
    {
        Ok(()) => {
            // Must include `session_id` — HookEventListener hydrates
            // `threads.sdk_session_id` in the frontend store from this event so
            // ProjectGroup can hide the matching discovered Grok row (otherwise
            // Grok chat looks like a duplicate terminal in the sidebar).
            let _ = app.emit(
                "thread-grok-updated",
                serde_json::json!({
                    "thread_id": thread_id,
                    "session_id": session_id,
                    "model": serde_json::Value::Null,
                }),
            );
            // Drop list cache so the refresh that follows does not serve a
            // pre-claim scan that still includes this UUID.
            if let Ok(thread) = queries::get_thread(&state.db, thread_id).await {
                crate::commands::threads::invalidate_grok_sessions_cache(&thread.work_dir);
            }
        }
        Err(e) => {
            tracing::warn!(
                "[grok] failed to persist ACP session {} for thread {}: {}",
                &session_id[..8.min(session_id.len())],
                &thread_id[..8.min(thread_id.len())],
                e,
            );
        }
    }
}

fn build_config(
    permission_mode: Option<String>,
    effort: Option<String>,
    model: Option<String>,
) -> GrokSpawnConfig {
    GrokSpawnConfig {
        permission_mode,
        effort,
        model,
    }
}

/// Resume the thread's cached ACP session, or create a fresh one when there is
/// no cached id or grok rejects the load (e.g. the session was pruned from
/// `~/.grok/sessions/`). Persists the resulting session id for next time and
/// returns it. Shared by `grok_sdk_ensure_server` and `grok_sdk_restart` so a
/// respawn keeps the conversation instead of starting blank.
async fn resume_or_new_session(
    app: &AppHandle,
    state: &AppState,
    server: &Arc<GrokAppServer>,
    thread_id: &str,
    work_dir: &str,
    process_is_fresh: bool,
    required_session_id: Option<&str>,
) -> Result<String, String> {
    // Desktop remount + remote first-send race: if this thread already has an
    // ACP session (possibly with session/prompt in flight), reuse or adopt it.
    // A session/load while a turn is running hangs ensure_server for up to 5
    // minutes and leaves the chat on "Starting session…" with no messages.
    let _setup = server.session_setup_lock().await;
    let mapped = server.session_id_for_thread(thread_id).await;
    if let (Some(required), Some(mapped)) = (required_session_id, mapped.as_deref()) {
        if required != mapped { return Err("Grok server is bound to a different native session".into()); }
    }
    let thread = queries::get_thread(&state.db, thread_id).await.ok();
    let cached = required_session_id.map(str::to_string)
        .or_else(|| thread.as_ref().and_then(|t| read_cached_session_id(&t.state_dir)));
    match resume_session_action(mapped, cached.clone(), process_is_fresh) {
        ResumeAction::Reuse(sid) => {
            queries::record_thread_session_start(&state.db, thread_id, Some(&sid)).await?;
            return Ok(sid);
        }
        ResumeAction::Adopt(sid) => {
            queries::record_thread_session_start(&state.db, thread_id, Some(&sid)).await?;
            queries::bind_thread_session(&state.db, thread_id, &sid).await?;
            server.adopt_session(thread_id, &sid).await;
            persist_thread_session_id(app, state, thread_id, &sid).await;
            tracing::info!(
                "[grok] adopted live ACP session {} for thread {}",
                &sid[..8.min(sid.len())],
                &thread_id[..8.min(thread_id.len())]
            );
            return Ok(sid);
        }
        ResumeAction::Load(_) | ResumeAction::New => {}
    }
    let (mcp_servers, memory_instructions) = if crate::memory::is_enabled() {
        if let Some(ref t) = thread {
            if let Ok(project) = queries::get_project(&state.db, &t.project_id).await {
                let mcp = match crate::memory::acp_mcp_servers_for_thread(
                    app,
                    &project.id,
                    &project.repo_path,
                    &[work_dir],
                    Some(thread_id),
                ) {
                    Ok(servers) => servers,
                    Err(e) => {
                        tracing::warn!("[grok] agmux-memory ACP MCP inject failed: {e}");
                        Vec::new()
                    }
                };
                let instr = crate::memory::first_turn_memory_preamble(
                    Some(&project.id),
                    &project.repo_path,
                );
                (mcp, Some(instr))
            } else {
                (
                    Vec::new(),
                    Some(crate::memory::first_turn_memory_preamble(None, work_dir)),
                )
            }
        } else {
            (
                Vec::new(),
                Some(crate::memory::first_turn_memory_preamble(None, work_dir)),
            )
        }
    } else {
        (Vec::new(), None)
    };

    let system_prompt_override = grok_cowork_system_prompt(thread.as_ref());

    if let Some(prev_session_id) = cached {
        queries::record_thread_session_start(&state.db, thread_id, Some(&prev_session_id)).await?;
        match server
            .load_session(
                thread_id,
                &prev_session_id,
                work_dir,
                mcp_servers.clone(),
                memory_instructions.clone(),
                system_prompt_override.clone(),
            )
            .await
        {
            Ok(()) => {
                queries::bind_thread_session(&state.db, thread_id, &prev_session_id).await?;
                persist_thread_session_id(app, state, thread_id, &prev_session_id).await;
                tracing::info!(
                    "[grok] resumed ACP session {} for thread {}",
                    &prev_session_id[..8.min(prev_session_id.len())],
                    &thread_id[..8.min(thread_id.len())]
                );
                return Ok(prev_session_id);
            }
            Err(e) => {
                if server.account_id.is_some() || required_session_id.is_some() {
                    return Err(format!("Could not resume the exact Grok session on this account: {e}"));
                }
                tracing::warn!(
                    "[grok] session/load failed ({}); falling back to fresh session",
                    e
                );
            }
        }
    }

    queries::record_thread_session_start(&state.db, thread_id, None).await?;
    let session_id = server
        .new_session(
            thread_id,
            work_dir,
            mcp_servers,
            memory_instructions,
            system_prompt_override,
        )
        .await
        .map_err(|e| e.to_string())?;
    crate::teams::ownership::record_native_creation(&state.db, "Grok", thread_id, &session_id).await?;
    queries::bind_thread_session(&state.db, thread_id, &session_id).await?;
    if let Ok(thread) = queries::get_thread(&state.db, thread_id).await {
        write_cached_session_id(&thread.state_dir, &session_id);
    }
    persist_thread_session_id(app, state, thread_id, &session_id).await;
    Ok(session_id)
}

/// Get the running grok server for a thread, or spawn one.
///
/// The `grok agent stdio` spawn + ACP handshake runs WITHOUT holding the
/// `grok_servers` manager lock — that lock gates every grok command, so a
/// slow handshake held across it would freeze unrelated threads. A redundant
/// process produced by a lost spawn race is shut down before returning.
async fn ensure_grok_server(
    app: &AppHandle,
    state: &AppState,
    thread_id: &str,
    work_dir: &str,
    mut config: GrokSpawnConfig,
) -> Result<(Arc<GrokAppServer>, bool), String> {
    crate::teams::policy::refresh_for_execution().await?;
    crate::teams::policy::enforce_session("Grok", "chat")?;
    if let Some(server) = {
        let servers = state.grok_servers.lock().await;
        servers.get(thread_id)
    } {
        if server.is_alive() {
            return Ok((server, false));
        }
        // Process died (crash / unexpected stdout close) but was left in the
        // map. Drop it so we spawn + session/load instead of Adopt-on-a-corpse.
        let dead = {
            let mut servers = state.grok_servers.lock().await;
            servers.take(thread_id)
        };
        if let Some(dead) = dead {
            dead.shutdown().await;
        }
    }
    if config.model.as_deref().is_none_or(|m| m.trim().is_empty()) {
        config.model = None;
        if let Ok(thread) = queries::get_thread(&state.db, thread_id).await {
            if let Some(native) = thread.sdk_session_id.or_else(|| read_cached_session_id(&thread.state_dir)) {
                config.model = crate::provider_accounts::runtime_pty::native_model("Grok", &native, work_dir).await;
            }
        }
    }
    crate::provider_accounts::remember_model("grok", thread_id, config.model.as_deref()).await?;
    let account = crate::provider_accounts::acquire("grok", thread_id).await?;
    let spawned = Arc::new(
        GrokAppServer::spawn_with_account(app.clone(), work_dir, &config, account.as_ref())
            .await
            .map_err(|e| e.to_string())?,
    );
    let canonical = {
        let mut servers = state.grok_servers.lock().await;
        servers.insert_or_keep(thread_id, spawned.clone(), config)
    };
    let fresh = Arc::ptr_eq(&canonical, &spawned);
    if fresh {
        if let Some(account) = account {
            let weak = Arc::downgrade(&canonical);
            let key = thread_id.to_string();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    let Some(server) = weak.upgrade() else { break; };
                    if !server.is_alive() { break; }
                    let Some(current) = crate::provider_accounts::current_assignment(&key).await else { break; };
                    if current.account_id != account.account_id || current.home != account.home { break; }
                    if crate::provider_accounts::maintain(&key).await.is_err() {
                        server.shutdown().await;
                        let _ = crate::provider_accounts::release(&key).await;
                        break;
                    }
                }
            });
        }
    }
    if !fresh {
        // Another task spawned for this thread concurrently — tear down ours.
        spawned.shutdown().await;
    }
    Ok((canonical, fresh))
}

/// Ensure a Grok ACP server is running for the thread and that an ACP session
/// exists. Returns the ACP sessionId. Spawn flags are applied on first spawn;
/// later calls reuse the existing process — use `grok_sdk_restart` to change
/// flags mid-session.
#[tauri::command]
pub async fn grok_sdk_ensure_server(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    work_dir: String,
    permission_mode: Option<String>,
    effort: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let config = build_config(permission_mode, effort, model);
    let (server, fresh) =
        ensure_grok_server(&app, state.inner(), &thread_id, &work_dir, config).await?;
    resume_or_new_session(&app, state.inner(), &server, &thread_id, &work_dir, fresh, None).await
}

/// Respawn the thread's grok process to apply a new reasoning effort.
///
/// Effort is a spawn flag (`--reasoning-effort`), so changing it requires a
/// fresh process — but the permission mode is runtime state, so it is captured
/// from the old process and re-applied, and the prior ACP session is resumed
/// so the conversation survives the respawn. Permission-mode changes do NOT
/// go through here — see `grok_sdk_set_permission_mode`.
#[tauri::command]
pub async fn grok_sdk_restart(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    work_dir: String,
    effort: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    // Drop the existing process first — the manager lock is held only for the
    // removal, not the respawn — capturing its live permission mode so the
    // respawn doesn't silently reset the user's choice.
    let old = {
        let mut servers = state.grok_servers.lock().await;
        servers.take(&thread_id)
    };
    let preserved_mode = match &old {
        Some(server) => Some(server.permission_mode_value().await),
        None => None,
    };
    if let Some(old) = old {
        old.shutdown().await;
    }
    // Model is a spawn flag (`--model`). Read the persisted thread row so a
    // 4.5 chat does not come back as the CLI default (4.6) after effort
    // change or remount.
    let persisted_model = match model.filter(|s| !s.is_empty()) {
        Some(m) => Some(m),
        None => queries::get_thread(&state.db, &thread_id)
            .await
            .ok()
            .and_then(|t| t.model),
    };
    let config = build_config(preserved_mode, effort, persisted_model);
    let (server, fresh) =
        ensure_grok_server(&app, state.inner(), &thread_id, &work_dir, config).await?;
    resume_or_new_session(&app, state.inner(), &server, &thread_id, &work_dir, fresh, None).await
}

/// Resume an existing Grok session (recovered from `~/.grok/sessions/`).
#[tauri::command]
pub async fn grok_sdk_load_session(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    work_dir: String,
    session_id: String,
) -> Result<(), String> {
    crate::teams::policy::refresh_for_execution().await?;
    crate::teams::policy::enforce_session("Grok", "chat")?;
    queries::record_thread_session_start(&state.db, &thread_id, Some(&session_id)).await?;
    queries::bind_thread_session(&state.db, &thread_id, &session_id).await?;
    let mut config = GrokSpawnConfig::default();
    config.model = crate::provider_accounts::runtime_pty::native_model("Grok", &session_id, &work_dir).await;
    let (server, _) = ensure_grok_server(
        &app,
        state.inner(),
        &thread_id,
        &work_dir,
        config,
    )
    .await?;
    let (mcp_servers, memory_instructions) = if crate::memory::is_enabled() {
        if let Ok(thread) = queries::get_thread(&state.db, &thread_id).await {
            if let Ok(project) = queries::get_project(&state.db, &thread.project_id).await {
                let mcp = match crate::memory::acp_mcp_servers_for_thread(
                    &app,
                    &project.id,
                    &project.repo_path,
                    &[&work_dir],
                    Some(thread_id.as_str()),
                ) {
                    Ok(servers) => servers,
                    Err(e) => {
                        tracing::warn!("[grok] agmux-memory ACP MCP inject failed: {e}");
                        Vec::new()
                    }
                };
                let instr = crate::memory::first_turn_memory_preamble(
                    Some(&project.id),
                    &project.repo_path,
                );
                (mcp, Some(instr))
            } else {
                (
                    Vec::new(),
                    Some(crate::memory::first_turn_memory_preamble(None, &work_dir)),
                )
            }
        } else {
            (
                Vec::new(),
                Some(crate::memory::first_turn_memory_preamble(None, &work_dir)),
            )
        }
    } else {
        (Vec::new(), None)
    };
    let thread = queries::get_thread(&state.db, &thread_id).await.ok();
    let system_prompt_override = grok_cowork_system_prompt(thread.as_ref());
    let _setup = server.session_setup_lock().await;
    server
        .load_session(
            &thread_id,
            &session_id,
            &work_dir,
            mcp_servers,
            memory_instructions,
            system_prompt_override,
        )
        .await
        .map_err(|e| e.to_string())?;

    if let Ok(thread) = queries::get_thread(&state.db, &thread_id).await {
        write_cached_session_id(&thread.state_dir, &session_id);
    }
    persist_thread_session_id(&app, &state, &thread_id, &session_id).await;
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokPromptImage {
    pub data: String,
    pub media_type: String,
}

async fn prepare_grok_account(
    app: &AppHandle,
    state: &AppState,
    thread_id: &str,
    session_id: &str,
    original: Arc<GrokAppServer>,
) -> Result<Arc<GrokAppServer>, String> {
    let mut server = original;
    let mut attempted = std::collections::HashSet::new();
    for attempt in 0..3 {
        let current = state.grok_servers.lock().await.get(&thread_id)
            .ok_or_else(|| "Grok session stopped during account selection".to_string())?;
        if !Arc::ptr_eq(&current, &server) || !server.is_alive() {
            return Err("Grok session changed before the prompt was sent; try again".into());
        }
        if server.session_id_for_thread(&thread_id).await.as_deref() != Some(session_id) {
            return Err("Grok session identity changed before the prompt was sent".into());
        }
        // Use the actual spawn flag or exact native capture. GrokAppServer's
        // display-model default is not evidence for account compatibility.
        let mut config = state.grok_servers.lock().await.config(thread_id)
            .ok_or("Grok server configuration missing")?;
        if config.model.as_deref().is_none_or(|m| m.trim().is_empty()) {
            config.model = crate::provider_accounts::runtime_pty::native_model("Grok", session_id, &server.work_dir).await;
        }
        crate::provider_accounts::remember_model("grok", thread_id, config.model.as_deref()).await?;
        let Some(account_id) = server.account_id.clone() else { break; };
        crate::provider_accounts::maintain(&thread_id).await?;
        // This accessor polls provider-owned quota; text from ACP tools and
        // terminal output is never considered evidence of exhaustion.
        let _ = crate::provider_accounts::refresh_account(&account_id).await;
        let Some(reset) = crate::provider_accounts::quota_exhaustion(&account_id).await? else { break; };
        if !crate::provider_accounts::auto_switch_enabled().await? {
            return Err("Grok account quota exhausted; automatic switching is disabled".into());
        }
        if config.model.is_none() {
            return Err("Grok account fallback requires the exact session model".into());
        }
        if attempt == 2 || !attempted.insert(account_id) {
            return Err("Grok account fallback attempt limit reached".into());
        }
        {
            let mut servers = state.grok_servers.lock().await;
            let active = servers.get(&thread_id).ok_or("Grok server stopped")?;
            if !Arc::ptr_eq(&active, &server) { return Err("Grok server changed during account selection".into()); }
            servers.take(&thread_id);
        }
        server.shutdown().await;
        crate::provider_accounts::mark_exhausted("grok", &thread_id, reset).await?;
        crate::provider_accounts::release(&thread_id).await?;
        let (replacement, fresh) = ensure_grok_server(&app, state, &thread_id, &server.work_dir, config).await?;
        if replacement.account_id.as_ref().is_none_or(|id| attempted.contains(id)) {
            replacement.shutdown().await;
            return Err("No different managed Grok account is available".into());
        }
        let resumed = resume_or_new_session(&app, state, &replacement, &thread_id, &server.work_dir, fresh, Some(session_id)).await?;
        if resumed != session_id {
            replacement.shutdown().await;
            return Err("Account fallback did not resume the exact Grok session".into());
        }
        server = replacement;
    }
    Ok(server)
}

/// Send a user prompt for an existing session.
#[tauri::command]
pub async fn grok_sdk_send_prompt(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    session_id: String,
    text: String,
    images: Option<Vec<GrokPromptImage>>,
) -> Result<Value, String> {
    let gate = grok_prompt_gate(&thread_id).await;
    let _send = gate.lock().await;
    crate::teams::policy::refresh_for_execution().await?;
    crate::teams::policy::enforce_session("Grok", "chat")?;
    // Session timeline: open turn before the (blocking) prompt.
    let image_count = images.as_ref().map(|v| v.len()).unwrap_or(0);
    let log_text = if text.trim().is_empty() && image_count > 0 {
        if image_count == 1 {
            "[1 image]".to_string()
        } else {
            format!("[{image_count} images]")
        }
    } else {
        text.clone()
    };
    let original = {
        let servers = state.grok_servers.lock().await;
        servers
            .get(&thread_id)
            .ok_or_else(|| "grok server not running for this thread".to_string())?
    };
    // Serializes preflight against any prompt using this original process.
    // A stale concurrent sender must never submit on a replaced process.
    let _setup = original.session_setup_lock().await;
    let server = prepare_grok_account(&app, state.inner(), &thread_id, &session_id, original.clone()).await?;
    let mapped: Vec<AcpPromptImage> = images
        .unwrap_or_default()
        .into_iter()
        .map(|img| AcpPromptImage {
            data: img.data,
            media_type: img.media_type,
        })
        .collect();
    let _ = crate::thread_turns::open_turn(
        &state.db,
        Some(&app),
        &thread_id,
        &log_text,
        "chat_item",
    )
    .await;

    let result = match server.send_prompt_blocks(&session_id, &text, mapped).await {
        Ok(result) => result,
        Err(error) => {
            let _ = crate::thread_turns::close_turn(&state.db, Some(&app), &thread_id, "failed", None).await;
            // The prompt RPC is over. A fresh quota probe can confirm exhaustion
            // even when ACP returned an untyped error; do not inspect its text.
            // Prepare the exact history on another account without replaying it.
            if server.account_id.is_some() {
                let prepared = prepare_grok_account(&app, state.inner(), &thread_id, &session_id, server.clone()).await;
                let status = match prepared {
                    Ok(ref replacement) if !Arc::ptr_eq(replacement, &server) => "ready",
                    Ok(_) => "unchanged",
                    Err(_) => "unavailable",
                };
                let _ = app.emit("provider-account-runtime", serde_json::json!({
                    "provider": "grok", "sessionKey": thread_id, "status": status,
                }));
            }
            return Err(error.to_string());
        }
    };

    // Live token stats for the Usage tab. Grok reports billable input/output
    // on the prompt result `_meta`. Key by ACP session_id so this merges with
    // (and is later replaced by) `scan_grok_logs` rows from ~/.grok/sessions.
    let model = queries::get_thread(&state.db, &thread_id)
        .await
        .ok()
        .and_then(|t| t.model);
    if let Err(e) = crate::commands::usage_stats::record_grok_turn_usage(
        &state.db,
        &session_id,
        model.as_deref(),
        &result,
    )
    .await
    {
        tracing::warn!(
            thread_id = %thread_id,
            session_id = %session_id,
            error = %e,
            "[grok] failed to record turn usage"
        );
    }

    // Close timeline turn after prompt resolves (stopReason may be cancelled).
    let stop = result
        .get("stopReason")
        .and_then(|v| v.as_str())
        .unwrap_or("EndTurn");
    let status = if stop.eq_ignore_ascii_case("cancelled") {
        "cancelled"
    } else {
        "done"
    };
    let local_port = {
        let guard = state.local_llm_server.lock().await;
        guard.as_ref().map(|s| s.port())
    };
    let _ = crate::thread_turns::close_turn(
        &state.db,
        Some(&app),
        &thread_id,
        status,
        local_port,
    )
    .await;

    Ok(result)
}

/// Cancel a turn mid-stream. Sends the ACP `session/cancel` notification;
/// grok then resolves the in-flight `session/prompt` with `stopReason:
/// "cancelled"`, which clears the chat spinner via the `turn.completed` emit.
#[tauri::command]
pub async fn grok_sdk_cancel(
    state: State<'_, AppState>,
    thread_id: String,
    session_id: String,
) -> Result<(), String> {
    let server = {
        let servers = state.grok_servers.lock().await;
        servers
            .get(&thread_id)
            .ok_or_else(|| "grok server not running for this thread".to_string())?
    };
    server.cancel(&session_id).await.map_err(|e| e.to_string())
}

/// Update the client-side permission policy for a running grok thread.
///
/// `grok agent stdio` ignores `--permission-mode`, so the gate is enforced in
/// agmux's `session/request_permission` handler. Changing the mode is a cheap
/// runtime update — no respawn, no lost ACP session. `mode` is one of
/// "default" | "acceptEdits" | "auto" | "bypassPermissions" | "plan".
#[tauri::command]
pub async fn grok_sdk_set_permission_mode(
    state: State<'_, AppState>,
    thread_id: String,
    mode: String,
) -> Result<(), String> {
    let server = {
        let servers = state.grok_servers.lock().await;
        servers
            .get(&thread_id)
            .ok_or_else(|| "grok server not running for this thread".to_string())?
    };
    server.set_permission_mode(mode).await;
    Ok(())
}

/// Frontend resolves a pending `session/request_permission` approval.
///
/// `decision` is the simple vocabulary "allow" | "allowProject" | "deny". The
/// ACP `optionId` grok expects is server-defined, so the Grok ACP client
/// resolves it from the options grok offered with the request — the frontend
/// must not guess one.
#[tauri::command]
pub async fn grok_sdk_respond_approval(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    thread_id: String,
    request_id: u64,
    decision: String,
) -> Result<(), String> {
    let server = {
        let servers = state.grok_servers.lock().await;
        servers
            .get(&thread_id)
            .ok_or_else(|| "grok server not running for this thread".to_string())?
    };
    server
        .resolve_approval(request_id, &decision)
        .await
        .map_err(|e| e.to_string())?;
    crate::remote::notify_approval_resolved(&app_handle, &request_id.to_string(), Some(&thread_id));
    Ok(())
}

/// On-disk Grok conversation history for a thread, used to rehydrate the chat
/// after an app restart. `failed_tool_call_ids` carries the ids of tool calls
/// the agent reported as `failed` — `chat_history.jsonl` has no per-result
/// error flag, so the error state is recovered from the `updates.jsonl` stream.
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GrokChatHistory {
    pub history_lines: Vec<String>,
    pub failed_tool_call_ids: Vec<String>,
}

/// Collect tool-call ids whose final ACP `tool_call_update` reported `failed`.
/// `updates.jsonl` is the streaming-event log; the last status per id wins.
fn read_failed_tool_call_ids(updates_path: &std::path::Path) -> Vec<String> {
    let content = match std::fs::read_to_string(updates_path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let mut last_status: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for line in content.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(update) = value.get("params").and_then(|p| p.get("update")) else {
            continue;
        };
        if update.get("sessionUpdate").and_then(|v| v.as_str()) != Some("tool_call_update") {
            continue;
        }
        let (Some(id), Some(status)) = (
            update.get("toolCallId").and_then(|v| v.as_str()),
            update.get("status").and_then(|v| v.as_str()),
        ) else {
            continue; // intermediate updates carry no status — don't clobber
        };
        last_status.insert(id.to_string(), status.to_string());
    }
    last_status
        .into_iter()
        .filter(|(_, status)| status == "failed")
        .map(|(id, _)| id)
        .collect()
}

/// Read a thread's Grok session conversation for restore-on-restart.
///
/// Grok persists every turn to
/// `~/.grok/sessions/<encoded cwd>/<sessionId>/chat_history.jsonl`. After an app
/// restart the SDK event stream is gone, so this on-disk transcript is the only
/// way to rehydrate the chat. Returns an empty result (not an error) when no
/// session or file exists yet — a brand-new thread simply has no history.
#[tauri::command]
pub async fn grok_sdk_read_chat_history(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<GrokChatHistory, String> {
    let thread = match queries::get_thread(&state.db, &thread_id).await {
        Ok(t) => t,
        Err(_) => return Ok(GrokChatHistory::default()),
    };
    // The ACP session id is persisted on the thread row; the cached
    // `grok-session-id.txt` is a fallback for rows written before that landed.
    let session_id = thread
        .sdk_session_id
        .clone()
        .or_else(|| read_cached_session_id(&thread.state_dir));
    let Some(session_id) = session_id else {
        return Ok(GrokChatHistory::default());
    };
    let Some(home) = dirs::home_dir() else {
        return Ok(GrokChatHistory::default());
    };
    let session_dir = crate::commands::threads::grok_sessions_dir_for_repo(&home, &thread.work_dir)
        .join(&session_id);
    let history_lines = match std::fs::read_to_string(session_dir.join("chat_history.jsonl")) {
        Ok(content) => content
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.to_string())
            .collect(),
        Err(_) => return Ok(GrokChatHistory::default()),
    };
    let failed_tool_call_ids = read_failed_tool_call_ids(&session_dir.join("updates.jsonl"));
    Ok(GrokChatHistory {
        history_lines,
        failed_tool_call_ids,
    })
}

/// Stop the grok process for a single thread.
#[tauri::command]
pub async fn grok_sdk_stop_session(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), String> {
    let mut servers = state.grok_servers.lock().await;
    servers.stop(&thread_id).await;
    crate::provider_accounts::release(&thread_id).await?;
    Ok(())
}

/// Tear down all Grok servers (called on app shutdown).
#[tauri::command]
pub async fn grok_sdk_stop_all(state: State<'_, AppState>) -> Result<(), String> {
    let mut servers = state.grok_servers.lock().await;
    let ids = servers.thread_ids();
    servers.stop_all().await;
    for id in ids { crate::provider_accounts::release(&id).await?; }
    Ok(())
}
