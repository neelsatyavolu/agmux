//! Mode-aware send / interrupt / approval for remote control.
//!
//! Message delivery goes through `crate::dispatch::send_to_thread` after
//! remote-only eligibility checks.

use crate::db::models::Thread;
use crate::db::queries;
use crate::dispatch::{self, effective_surface, send_pty_raw};
use crate::state::AppState;
use tauri::{AppHandle, Emitter, Manager};

// Re-export so existing remote call sites keep working.
pub use crate::dispatch::{resolve_thread, DispatchError};

pub async fn send_message(
    app: &AppHandle,
    thread_id: &str,
    text: &str,
    images: &[super::protocol::RemoteImage],
    permission_mode: Option<&str>,
    plan_mode: Option<bool>,
) -> Result<(), DispatchError> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| DispatchError::Message("app state unavailable".into()))?;
    let text = text.trim();
    if text.is_empty() && images.is_empty() {
        return Err(DispatchError::Message("empty message".into()));
    }
    let (thread, _synthetic) = resolve_thread(&state.db, thread_id).await?;
    if !super::protocol::is_remote_eligible_provider(&thread.provider) {
        return Err(DispatchError::Message("thread not eligible for remote".into()));
    }

    let surface = effective_surface(&state, &thread).await;
    let signals = super::client::collect_run_signals(&state).await;
    if super::client::thread_is_processing(&thread, surface, &signals, &crate::hooks::hook_running_session_ids()) {
        return Err(DispatchError::Message("session is already running — queue the message or stop the current turn first".into()));
    }

    persist_remote_session_ui(&thread.state_dir, permission_mode, plan_mode);

    let before_seq = if surface == "terminal" {
        queries::next_thread_turn_seq(&state.db, thread_id).await.unwrap_or(0)
    } else { 0 };
    let session_id = thread.sdk_session_id.as_deref().filter(|id| !id.is_empty()).unwrap_or(thread_id);
    let before_start = if surface == "terminal" && thread.provider == "Codex" {
        crate::commands::codex::codex_refresh_thread_model(session_id.to_string()).await
            .ok().and_then(|snapshot| snapshot.last_task_started_at)
    } else { None };
    // Shared mode-aware deliver (Claude/Grok/Codex chat + PTY).
    dispatch::send_to_thread_with_images(app, thread_id, text, images).await?;
    if surface == "terminal" {
        // Enter only confirms a PTY write. Keep the phone's dispatch busy
        // until the provider has accepted a turn, including one which already
        // finished between polls. Never release a queued follow-up on an old
        // idle snapshot before the new prompt's hook/JSONL arrives.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let hooks = crate::hooks::hook_running_session_ids();
            let after_seq = queries::next_thread_turn_seq(&state.db, thread_id).await.unwrap_or(before_seq);
            let after_start = if thread.provider == "Codex" {
                crate::commands::codex::codex_refresh_thread_model(session_id.to_string()).await
                    .ok().and_then(|snapshot| snapshot.last_task_started_at)
            } else { None };
            if terminal_turn_observed(before_seq, after_seq, before_start.as_deref(), after_start.as_deref(),
                hooks.contains(thread_id) || hooks.contains(session_id))
            {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(DispatchError::Message("Message was sent, but the terminal has not confirmed a new turn. Check the terminal before retrying.".into()));
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }
    Ok(())
}

/// Terminal key that stops a turn, matching the desktop
/// (`src/lib/terminalUserInterrupt.ts`): Grok cancels on Ctrl-C and ignores
/// Escape; every other terminal agent stops on Escape.
fn terminal_stop_key(provider: &str) -> &'static str {
    if provider.eq_ignore_ascii_case("Grok") {
        "\x03"
    } else {
        "\x1b"
    }
}

pub async fn interrupt_turn(app: &AppHandle, thread_id: &str) -> Result<(), DispatchError> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| DispatchError::Message("app state unavailable".into()))?;
    let (thread, _synthetic) = resolve_thread(&state.db, thread_id).await?;
    if !super::protocol::is_remote_eligible_provider(&thread.provider) {
        return Err(DispatchError::Message("thread not eligible for remote".into()));
    }

    let surface = effective_surface(&state, &thread).await;
    match (thread.provider.as_str(), surface) {
        ("ClaudeCode", "chat") => {
            let ctx = state.sdk_sessions.lock().await
                .get(thread_id).cloned()
                .ok_or_else(|| DispatchError::Message("no SDK session".into()))?;
            ctx.send_request("interrupt", serde_json::json!({}))
                .await
                .map_err(|e| DispatchError::Message(e))?;
            Ok(())
        }
        ("Grok", "chat") => {
            let session_id = thread
                .sdk_session_id
                .clone()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| DispatchError::Message("no grok session id".into()))?;
            // Mirror the send path: spawn/resume the ACP server if it isn't
            // running so interrupt works after a Mac relaunch instead of
            // erroring with "grok server not running".
            let server_up = state.grok_servers.lock().await.get(thread_id).is_some();
            if !server_up {
                crate::commands::grok_sdk::grok_sdk_ensure_server(
                    app.clone(),
                    app.state(),
                    thread.id.clone(),
                    thread.work_dir.clone(),
                    None,
                    thread.reasoning_effort.clone(),
                    thread.model.clone(),
                )
                .await
                .map_err(|e| DispatchError::Message(format!("start grok session: {e}")))?;
            }
            let server = {
                let servers = state.grok_servers.lock().await;
                servers
                    .get(thread_id)
                    .ok_or_else(|| DispatchError::Message("grok server not running".into()))?
            };
            server
                .cancel(&session_id)
                .await
                .map_err(|e| DispatchError::Message(e.to_string()))?;
            Ok(())
        }
        ("Gemini", "chat") => {
            let session_id = thread
                .sdk_session_id
                .clone()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| DispatchError::Message("no gemini session id".into()))?;
            let server_up = state.gemini_servers.lock().await.get(thread_id).is_some();
            if !server_up {
                crate::commands::gemini_sdk::gemini_sdk_ensure_server(
                    app.clone(),
                    app.state(),
                    thread.id.clone(),
                    thread.work_dir.clone(),
                    None,
                    thread.reasoning_effort.clone(),
                    thread.model.clone(),
                )
                .await
                .map_err(|e| DispatchError::Message(format!("start gemini session: {e}")))?;
            }
            let server = {
                let servers = state.gemini_servers.lock().await;
                servers
                    .get(thread_id)
                    .ok_or_else(|| DispatchError::Message("gemini server not running".into()))?
            };
            server
                .cancel(&session_id)
                .await
                .map_err(|e| DispatchError::Message(e.to_string()))?;
            Ok(())
        }
        ("Codex", "chat") => {
            // Desktop uses activeTurnId ?? "pending" when the turn id is unknown.
            let session_id = crate::dispatch::codex_session_id(&thread);
            let work_dir = thread.work_dir.clone();
            let server = state.codex_servers.lock().await.get_for_thread(&work_dir, session_id)
                .ok_or_else(|| DispatchError::Message("Codex thread is no longer running".into()))?;
            server
                .interrupt_turn(session_id, "pending")
                .await
                .map_err(|e| DispatchError::Message(e.to_string()))?;
            Ok(())
        }
        ("OpenCode", "chat") => {
            let bridge = state
                .opencode_sdk_bridge
                .lock()
                .await
                .as_ref()
                .cloned()
                .ok_or_else(|| DispatchError::Message("opencode bridge not initialized".into()))?;
            bridge
                .send_request(
                    "interrupt",
                    serde_json::json!({ "threadId": thread_id }),
                )
                .await
                .map_err(DispatchError::Message)?;
            Ok(())
        }
        ("Cursor", "chat") => {
            // No-op when the bridge is down (Mac relaunch / never started).
            // Do not fall through to PTY Ctrl-C — Cursor is chat-only.
            crate::commands::cursor_sdk::cursor_sdk_interrupt(
                app.state(),
                thread_id.to_string(),
            )
            .await
            .map_err(DispatchError::Message)?;
            Ok(())
        }
        _ => {
            // PTY (only if live — don't spawn just to interrupt). Same stop key
            // as the desktop terminal: a second Ctrl-C quits Claude/Codex.
            send_pty_raw(&state, thread_id, terminal_stop_key(&thread.provider)).await
        }
    }
}

/// Keystrokes approve a terminal dialog, so only a known decision may send
/// them; anything unrecognised is refused rather than treated as allow.
fn terminal_decision_approves(decision: &str) -> Option<bool> {
    match decision {
        "allow" | "allowProject" | "allow_always" | "approve" | "accept" => Some(true),
        "deny" | "reject" | "decline" => Some(false),
        _ => None,
    }
}

/// Permissions requested by pending Codex `item/permissions/requestApproval`
/// calls, keyed by the global public request id.
static CODEX_PERMISSION_REQUESTS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<u64, serde_json::Value>>,
> = std::sync::LazyLock::new(Default::default);

pub fn remember_codex_permissions_request(request_id: u64, permissions: serde_json::Value) {
    let mut map = CODEX_PERMISSION_REQUESTS.lock().unwrap_or_else(|e| e.into_inner());
    // Requests answered on the Mac never come back through here; stay bounded.
    if map.len() >= 256 {
        map.clear();
    }
    map.insert(request_id, permissions);
}

/// Codex app-server approval answer (matches desktop buildCodexApprovalResponse).
/// A permissions request grants the requested subset (or none), not a decision.
fn codex_approval_result(request_id: u64, decision: &str) -> serde_json::Value {
    let accepted = !matches!(decision, "deny" | "reject" | "decline");
    let requested = CODEX_PERMISSION_REQUESTS.lock().unwrap_or_else(|e| e.into_inner())
        .get(&request_id).cloned();
    match requested {
        Some(permissions) => serde_json::json!({
            "scope": "turn",
            "permissions": if accepted { permissions } else { serde_json::json!({}) },
        }),
        None => serde_json::json!({
            "decision": if accepted { "accept" } else { "decline" }
        }),
    }
}

pub async fn respond_approval(
    app: &AppHandle,
    thread_id: Option<&str>,
    request_id: &str,
    decision: &str,
) -> Result<(), DispatchError> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| DispatchError::Message("app state unavailable".into()))?;

    // Prefer explicit thread; else scan SDK sessions for pending — for v1 require thread via remote pending map
    let tid = thread_id
        .map(|s| s.to_string())
        .ok_or_else(|| DispatchError::Message("threadId required for approval".into()))?;

    // resolve_thread (not get_thread) so a discovered/synthetic Codex chat with
    // no DB row still resolves to its provider + work_dir for app-server routing.
    let (thread, _synthetic) = resolve_thread(&state.db, &tid).await?;
    if !super::protocol::is_remote_eligible_provider(&thread.provider) {
        return Err(DispatchError::Message("thread not eligible for remote".into()));
    }

    let surface = effective_surface(&state, &thread).await;
    match (thread.provider.as_str(), surface) {
        ("ClaudeCode", "chat") => {
            let ctx = state.sdk_sessions.lock().await
                .get(&tid).cloned()
                .ok_or_else(|| DispatchError::Message("no SDK session".into()))?;
            // Map allow/deny to sidecar decisions
            let decision = match decision {
                "allow" | "allowProject" | "allow_always" => decision,
                "deny" => "deny",
                other => other,
            };
            ctx.send_request(
                "respondApproval",
                serde_json::json!({
                    "requestId": request_id,
                    "decision": decision,
                }),
            )
            .await
            .map_err(DispatchError::Message)?;
            Ok(())
        }
        ("Grok", "chat") => {
            let rid: u64 = request_id.parse().map_err(|_| {
                DispatchError::Message("invalid grok request id".into())
            })?;
            // Clone the Arc out and drop the registry guard before the RPC await
            // so a slow approval doesn't serialize every other grok operation.
            let server = {
                let servers = state.grok_servers.lock().await;
                servers
                    .get(&tid)
                    .ok_or_else(|| DispatchError::Message("grok server not running".into()))?
            };
            server
                .resolve_approval(rid, decision)
                .await
                .map_err(|e| DispatchError::Message(e.to_string()))?;
            Ok(())
        }
        ("Gemini", "chat") => {
            let rid: u64 = request_id.parse().map_err(|_| {
                DispatchError::Message("invalid gemini request id".into())
            })?;
            let server = {
                let servers = state.gemini_servers.lock().await;
                servers
                    .get(&tid)
                    .ok_or_else(|| DispatchError::Message("gemini server not running".into()))?
            };
            server
                .resolve_approval(rid, decision)
                .await
                .map_err(|e| DispatchError::Message(e.to_string()))?;
            Ok(())
        }
        ("Codex", "chat") => {
            let rid: u64 = request_id.parse().map_err(|_| {
                DispatchError::Message("invalid codex request id".into())
            })?;
            let work_dir = thread.work_dir.clone();
            let server = state.codex_servers.lock().await.get_for_request(&work_dir, rid)
                .ok_or_else(|| DispatchError::Message("Codex approval is no longer pending".into()))?;
            let result = codex_approval_result(rid, decision);
            server
                .respond_to_request(rid, result)
                .await
                .map_err(|e| DispatchError::Message(e.to_string()))?;
            CODEX_PERMISSION_REQUESTS.lock().unwrap_or_else(|e| e.into_inner()).remove(&rid);
            Ok(())
        }
        ("OpenCode", "chat") => {
            let bridge = state
                .opencode_sdk_bridge
                .lock()
                .await
                .as_ref()
                .cloned()
                .ok_or_else(|| DispatchError::Message("opencode bridge not initialized".into()))?;
            let decision = opencode_approval_decision(decision)?;
            bridge
                .send_request(
                    "respondPermission",
                    serde_json::json!({
                        "threadId": tid,
                        "permissionId": request_id,
                        "decision": decision,
                    }),
                )
                .await
                .map_err(DispatchError::Message)?;
            Ok(())
        }
        // Cursor runs its own policy and never asks for approvals.
        ("Cursor", _) => Err(DispatchError::Message("Cursor chats have no approvals to answer".into())),
        _ => {
            // Terminal approvals answer the PTY dialog. Only do that while the
            // matching request is still open — a late phone tap after the Mac
            // already answered (or the prompt moved on) would otherwise land
            // as raw keystrokes in whatever is running now.
            let approve = terminal_decision_approves(decision)
                .ok_or_else(|| DispatchError::Message(format!("unknown approval decision: {decision}")))?;
            crate::dispatch::send_pty_approval(&state, &tid, request_id, approve).await
        }
    }
}

pub async fn respond_user_input(
    app: &AppHandle,
    thread_id: &str,
    request_id: &str,
    answers: serde_json::Value,
) -> Result<(), DispatchError> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| DispatchError::Message("app state unavailable".into()))?;
    let (thread, _) = resolve_thread(&state.db, thread_id).await?;
    if !super::protocol::is_remote_eligible_provider(&thread.provider) {
        return Err(DispatchError::Message("thread not eligible for remote".into()));
    }
    match thread.provider.as_str() {
        "ClaudeCode" => {
            let ctx = state.sdk_sessions.lock().await.get(thread_id).cloned()
                .ok_or_else(|| DispatchError::Message("no SDK session".into()))?;
            ctx.send_request("respondUserInput", serde_json::json!({
                "requestId": request_id, "answers": answers,
            })).await.map_err(DispatchError::Message)?;
        }
        "OpenCode" => {
            let answers: Vec<Vec<String>> = serde_json::from_value(answers)
                .map_err(|_| DispatchError::Message("invalid OpenCode question answers".into()))?;
            crate::commands::opencode_sdk::opencode_sdk_respond_question(
                app.state(), thread_id.to_string(), request_id.to_string(), answers,
            ).await.map_err(DispatchError::Message)?;
        }
        "Codex" => {
            let rid = request_id.parse::<u64>()
                .map_err(|_| DispatchError::Message("invalid Codex request id".into()))?;
            let server = state.codex_servers.lock().await.get_for_request(&thread.work_dir, rid)
                .ok_or_else(|| DispatchError::Message("Codex server is no longer running".into()))?;
            server.respond_to_request(rid, answers).await
                .map_err(|e| DispatchError::Message(e.to_string()))?;
        }
        _ => return Err(DispatchError::Message("questions are not supported for this provider".into())),
    }
    Ok(())
}

/// Create a new CHAT thread from the phone (never a terminal surface).
/// Claude → "sdk", Grok → "grok-sdk", Gemini → "gemini-sdk",
/// OpenCode → "opencode-sdk", Cursor → "cursor-sdk", Codex → app-server
/// thread whose DB row reuses the codex-generated thread id.
pub async fn create_chat_thread(
    app: &AppHandle,
    provider: &str,
    project_id: &str,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
    fast_mode: Option<bool>,
    permission_mode: Option<&str>,
    plan_mode: Option<bool>,
) -> Result<Thread, DispatchError> {
    validate_remote_config(model, reasoning_effort)?;
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| DispatchError::Message("app state unavailable".into()))?;
    let project = queries::get_project(&state.db, project_id)
        .await
        .map_err(|e| DispatchError::Message(format!("project: {e}")))?;
    let effort_owned = reasoning_effort.map(|s| s.to_string());
    let model_owned = if provider == "Gemini" {
        gemini_model_with_effort(
            model
                .map(|s| s.to_string())
                .or_else(|| Some("gemini-3.8-flash".into())),
            reasoning_effort,
        )
    } else {
        model.map(|s| s.to_string())
    };

    match provider {
        "ClaudeCode" | "Grok" | "Gemini" | "OpenCode" | "Cursor" => {
            let (name, mode) = match provider {
                "ClaudeCode" => ("New Claude Chat", "sdk"),
                "Grok" => ("New Grok Chat", "grok-sdk"),
                "Gemini" => ("New Gemini Chat", "gemini-sdk"),
                "Cursor" => ("New Cursor Chat", "cursor-sdk"),
                _ => ("New OpenCode Chat", "opencode-sdk"),
            };
            let thread = crate::commands::threads::create_thread(
                app.state(),
                project_id.to_string(),
                name.to_string(),
                provider.to_string(),
                model_owned,
                effort_owned,
                fast_mode,
                None,
                None,
                None,
                Some(mode.to_string()),
                None,
                None, // thread_id — generate
            )
            .await
            .map_err(DispatchError::Message)?;
            persist_remote_session_ui(&thread.state_dir, permission_mode, plan_mode);
            Ok(thread)
        }
        "Codex" => {
            // Codex chat rows use the app-server thread id as the DB id.
            // Pass the phone-selected model so thread/start is not left on the
            // server default while the DB row stores a different slug.
            let result = crate::commands::codex::codex_start_thread(
                app.state(),
                app.clone(),
                project.repo_path.clone(),
                model_owned.clone(),
                None,
            )
            .await
            .map_err(|e| DispatchError::Message(format!("codex start: {e}")))?;
            let codex_id = result
                .get("thread")
                .or_else(|| result.get("result").and_then(|r| r.get("thread")))
                .and_then(|t| t.get("id"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| DispatchError::Message("codex start: no thread id".into()))?
                .to_string();
            let state_dir = crate::paths::agmux_home_opt()
                .ok_or_else(|| DispatchError::Message("no home dir".into()))?
                .join("threads")
                .join(&codex_id);
            std::fs::create_dir_all(&state_dir)
                .map_err(|e| DispatchError::Message(e.to_string()))?;
            let thread = queries::create_thread(
                &state.db,
                &codex_id,
                project_id,
                "New Codex Chat",
                "Codex",
                &project.repo_path,
                &state_dir.to_string_lossy(),
                model_owned.as_deref(),
                effort_owned.as_deref(),
                fast_mode.unwrap_or(false),
                "DirectRepo",
                None,
                Some("sdk"),
                None,
            )
            .await
            .map_err(|e| DispatchError::Message(e.to_string()))?;
            persist_remote_session_ui(&thread.state_dir, permission_mode, plan_mode);
            Ok(thread)
        }
        other => Err(DispatchError::Message(format!(
            "cannot create remote chat for provider {other}"
        ))),
    }
}

/// Update a thread's model / reasoning effort / fast mode from the phone.
/// Terminals pick the change up on next resume; Codex chat reads it per turn;
/// live Claude SDK sessions switch model immediately.
pub async fn set_thread_config(
    app: &AppHandle,
    thread_id: &str,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
    fast_mode: Option<bool>,
    permission_mode: Option<&str>,
    plan_mode: Option<bool>,
) -> Result<(), DispatchError> {
    validate_remote_config(model, reasoning_effort)?;
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| DispatchError::Message("app state unavailable".into()))?;
    let (thread, synthetic) = resolve_thread(&state.db, thread_id).await?;
    if !super::protocol::is_remote_eligible_provider(&thread.provider) {
        return Err(DispatchError::Message("thread not eligible for remote".into()));
    }

    if synthetic && (reasoning_effort.is_some() || fast_mode.is_some()) {
        return Err(DispatchError::Message(
            "this session has no saved settings yet — open it on the desktop before changing effort or fast mode".into(),
        ));
    }

    // Hard guard: never reconfigure a terminal with an open turn. Injecting
    // /model would land as prompt text, and a mismatched effort/model on a
    // generating session is exactly the state we must not create.
    let surface = effective_surface(&state, &thread).await;
    if surface == "terminal"
        || (surface == "chat" && matches!(thread.provider.as_str(), "Grok" | "Gemini")
            && (model.is_some() || reasoning_effort.is_some()))
    {
        let signals = super::client::collect_run_signals(&state).await;
        if super::client::thread_is_processing(&thread, surface, &signals, &crate::hooks::hook_running_session_ids()) {
            return Err(DispatchError::Message(
                "session is running — wait for the turn to finish before changing model or effort".into(),
            ));
        }
    }

    persist_remote_session_ui(&thread.state_dir, permission_mode, plan_mode);
    crate::dispatch::apply_live_chat_permission(app, &state, &thread).await?;

    // Live apply for model changes (already validated above).
    if let Some(m) = model {
        match (
            thread.provider.as_str(),
            surface,
        ) {
            ("ClaudeCode", "chat") => {
                let ctx = state.sdk_sessions.lock().await.get(thread_id).cloned();
                if let Some(ctx) = ctx {
                    ctx.send_request("setModel", serde_json::json!({ "model": m }))
                        .await
                        .map_err(DispatchError::Message)?;
                }
            }
            ("Codex", _) | ("Grok", _) | ("Kimi", _) | ("Pi", _) if synthetic => {
                // No row to persist into and no live knob for these runtimes —
                // returning Ok would report success for a change that is never
                // applied and vanishes on the next catalog push.
                return Err(DispatchError::Message(
                    "this session has no saved settings yet — open it on the desktop once before changing the model".into(),
                ));
            }
            ("Cursor", "chat") => {
                if state.cursor_sdk_sessions.lock().await.contains_key(thread_id) {
                    crate::commands::cursor_sdk::cursor_sdk_set_model(
                        app.state(),
                        thread_id.to_string(),
                        m.to_string(),
                    )
                    .await
                    .map_err(DispatchError::Message)?;
                }
            }
            ("OpenCode", "chat") => {
                if state.opencode_sdk_sessions.lock().await.contains_key(thread_id) {
                    crate::commands::opencode_sdk::opencode_sdk_set_model(
                        app.state(),
                        thread_id.to_string(),
                        m.to_string(),
                    )
                    .await
                    .map_err(DispatchError::Message)?;
                }
            }
            ("Grok", "chat") => {
                if state.grok_servers.lock().await.get(thread_id).is_some() {
                    crate::commands::grok_sdk::grok_sdk_restart(
                        app.clone(),
                        app.state(),
                        thread_id.to_string(),
                        thread.work_dir.clone(),
                        reasoning_effort.or(thread.reasoning_effort.as_deref()).map(str::to_string),
                        Some(m.to_string()),
                    )
                    .await
                    .map_err(DispatchError::Message)?;
                }
            }
            ("Gemini", "chat") => {
                let effort = reasoning_effort.or(thread.reasoning_effort.as_deref());
                let model = gemini_model_with_effort(Some(m.to_string()), effort)
                    .unwrap_or_else(|| m.to_string());
                if state.gemini_servers.lock().await.get(thread_id).is_some() {
                    crate::commands::gemini_sdk::gemini_sdk_restart(
                        app.clone(),
                        app.state(),
                        thread_id.to_string(),
                        thread.work_dir.clone(),
                        effort.map(|s| s.to_string()),
                        Some(model),
                    )
                    .await
                    .map_err(DispatchError::Message)?;
                }
            }
            ("ClaudeCode", "terminal") => {
                // Claude sessions keep their model in session state, so the DB
                // value never reaches a resume — the real switch is `/model`,
                // exactly what a user would type. The mid-turn guard above
                // already ensured the TUI is idle.
                let alive = {
                    let sessions = state.sessions.lock().await;
                    match sessions.get(thread_id) {
                        Some(s) => s.is_alive().await,
                        None => false,
                    }
                };
                if alive {
                    send_pty_raw(&state, thread_id, &format!("/model {m}\r")).await?;
                } else if synthetic {
                    return Err(DispatchError::Message(
                        "session isn't running — open it or send a message first, then set the model".into(),
                    ));
                }
            }
            _ => {}
        }
    } else if thread.provider == "Grok" && surface == "chat" && reasoning_effort.is_some() {
        if state.grok_servers.lock().await.get(thread_id).is_some() {
            crate::commands::grok_sdk::grok_sdk_restart(
                app.clone(),
                app.state(),
                thread_id.to_string(),
                thread.work_dir.clone(),
                reasoning_effort.map(str::to_string),
                thread.model.clone(),
            )
            .await
            .map_err(DispatchError::Message)?;
        }
    } else if thread.provider == "Gemini"
        && surface == "chat"
        && reasoning_effort.is_some()
    {
        let model = gemini_model_with_effort(thread.model.clone(), reasoning_effort);
        if state.gemini_servers.lock().await.get(thread_id).is_some() {
            crate::commands::gemini_sdk::gemini_sdk_restart(
                app.clone(),
                app.state(),
                thread_id.to_string(),
                thread.work_dir.clone(),
                reasoning_effort.map(|s| s.to_string()),
                model,
            )
            .await
            .map_err(DispatchError::Message)?;
        }
    } else if synthetic
        && model.is_none()
        && permission_mode.is_none()
        && plan_mode.is_none()
    {
        // Nothing to persist into and no live knob for effort/fast-mode on a
        // discovered session — be explicit rather than silently dropping it.
        // Permission/plan-only updates already persisted + live-applied above.
        return Err(DispatchError::Message(
            "only model can be set for this session from remote".into(),
        ));
    }
    if thread.provider == "ClaudeCode" && surface == "chat" {
        if let Some(effort) = reasoning_effort {
            if state.sdk_sessions.lock().await.contains_key(thread_id) {
                crate::commands::claude_sdk::sdk_set_effort(
                    app.state(), thread_id.to_string(), effort.to_string(),
                )
                .await
                .map_err(DispatchError::Message)?;
            }
        }
    }
    // Persist so the next spawn/resume picks it up (Grok/Codex pass --model /
    // effort at spawn). Discovered sessions have no row to persist into.
    if !synthetic {
        let next_model = if thread.provider == "Gemini" {
            gemini_model_with_effort(
                model.map(|s| s.to_string()).or_else(|| thread.model.clone()),
                reasoning_effort.or(thread.reasoning_effort.as_deref()),
            )
        } else {
            model
                .map(|s| s.to_string())
                .or_else(|| thread.model.clone())
        };
        let next_effort = reasoning_effort
            .map(|s| s.to_string())
            .or_else(|| thread.reasoning_effort.clone());
        let next_fast = fast_mode.unwrap_or(thread.fast_mode != 0);
        queries::update_thread_settings(
            &state.db,
            thread_id,
            next_model.as_deref(),
            next_effort.as_deref(),
            next_fast,
        )
        .await
        .map_err(|e| DispatchError::Message(e.to_string()))?;
    }

    Ok(())
}

fn opencode_approval_decision(decision: &str) -> Result<&'static str, DispatchError> {
    match decision {
        "allow" | "accept" => Ok("accept"),
        "allowProject" | "allow_always" | "acceptForSession" => Ok("acceptForSession"),
        "deny" | "reject" | "decline" => Ok("decline"),
        _ => Err(DispatchError::Message("invalid approval decision".into())),
    }
}

fn terminal_turn_observed(before_seq: i64, after_seq: i64, before_start: Option<&str>, after_start: Option<&str>, hook_running: bool) -> bool {
    hook_running || after_seq > before_seq
        || (after_start.is_some() && after_start != before_start)
}

fn validate_remote_config(model: Option<&str>, effort: Option<&str>) -> Result<(), DispatchError> {
    if model.is_some_and(|m| !is_valid_remote_model_id(m)) {
        return Err(DispatchError::Message("invalid model id".into()));
    }
    if effort.is_some_and(|e| !matches!(e, "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra")) {
        return Err(DispatchError::Message("invalid reasoning effort".into()));
    }
    Ok(())
}

fn persist_remote_session_ui(
    state_dir: &str,
    permission_mode: Option<&str>,
    plan_mode: Option<bool>,
) {
    if let Some(mode) = permission_mode {
        crate::dispatch::write_remote_permission_mode(state_dir, mode);
        crate::remote::draft_prefs::remember_permission_mode(mode);
    }
    if let Some(plan) = plan_mode {
        crate::dispatch::write_remote_agent_mode(state_dir, if plan { "plan" } else { "agent" });
    }
}

fn gemini_model_with_effort(model: Option<String>, effort: Option<&str>) -> Option<String> {
    let model = model?;
    let base = ["-low", "-medium", "-high"]
        .iter()
        .find_map(|suffix| model.strip_suffix(suffix))
        .unwrap_or(model.as_str());
    let effort = match effort {
        Some("low" | "medium" | "high") => effort.unwrap(),
        _ => ["low", "medium", "high"].into_iter()
            .find(|level| model.ends_with(&format!("-{level}")))
            .unwrap_or("high"),
    };
    Some(format!("{base}-{effort}"))
}

/// Accept OpenCode `provider/model` slashes and Cursor `slug?param=value` slugs.
pub(crate) fn is_valid_remote_model_id(model: &str) -> bool {
    !model.is_empty()
        && !model.contains("..")
        && !model.starts_with('/')
        && !model.ends_with('/')
        && model.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '-' | '.' | '_' | '[' | ']' | '/' | '?' | '=' | '&')
        })
}

/// Forward SDK-style approval events from desktop UI/hooks to phones.
/// Call from places that already know about approvals when remote is on.
#[allow(dead_code)]
pub fn emit_remote_approval(
    app: &AppHandle,
    thread_id: &str,
    request_id: &str,
    tool_name: &str,
    detail: &str,
) {
    if let Some(state) = app.try_state::<AppState>() {
        let remote = state.remote.clone();
        let thread_id = thread_id.to_string();
        let request_id = request_id.to_string();
        let tool_name = tool_name.to_string();
        let detail = detail.to_string();
        tauri::async_runtime::spawn(async move {
            remote
                .push_approval_requested(&thread_id, &request_id, &tool_name, &detail)
                .await;
        });
    }
}

// silence unused Emitter import when not used
#[allow(dead_code)]
fn _emit_marker(app: &AppHandle) {
    let _ = app.emit("remote-dispatch-noop", ());
}

#[cfg(test)]
mod tests {
    use super::terminal_turn_observed;
    use super::is_valid_remote_model_id;
    use super::terminal_stop_key;
    use super::terminal_decision_approves;
    use super::{codex_approval_result, remember_codex_permissions_request};

    #[test]
    fn codex_permissions_approval_answers_with_the_granted_subset() {
        // `item/permissions/requestApproval` requires `permissions`, not `decision`.
        let permissions = serde_json::json!({
            "fileSystem": { "read": null, "write": ["/tmp/example/src"] },
            "network": { "enabled": true },
        });
        remember_codex_permissions_request(9_000_001, permissions.clone());
        assert_eq!(
            codex_approval_result(9_000_001, "allow"),
            serde_json::json!({ "scope": "turn", "permissions": permissions }),
        );
        remember_codex_permissions_request(9_000_002, permissions);
        assert_eq!(
            codex_approval_result(9_000_002, "deny"),
            serde_json::json!({ "scope": "turn", "permissions": {} }),
        );
        assert_eq!(codex_approval_result(9_000_003, "allow"), serde_json::json!({ "decision": "accept" }));
        assert_eq!(codex_approval_result(9_000_003, "deny"), serde_json::json!({ "decision": "decline" }));
    }

    #[test]
    fn terminal_approval_needs_a_known_decision() {
        assert_eq!(terminal_decision_approves("allow"), Some(true));
        assert_eq!(terminal_decision_approves("allow_always"), Some(true));
        assert_eq!(terminal_decision_approves("deny"), Some(false));
        assert_eq!(terminal_decision_approves(""), None);
        assert_eq!(terminal_decision_approves("cancel"), None);
    }

    #[test]
    fn terminal_stop_matches_desktop_interrupt_keys() {
        assert_eq!(terminal_stop_key("Grok"), "\x03");
        for provider in ["ClaudeCode", "Codex", "Kimi", "OpenCode", "Pi", "Droid", "Cline", "Hermes", "Gemini"] {
            assert_eq!(terminal_stop_key(provider), "\x1b", "{provider}");
        }
    }

    #[test]
    fn terminal_handoff_requires_new_progress_and_accepts_fast_completed_turns() {
        assert!(!terminal_turn_observed(4, 4, Some("old"), Some("old"), false));
        assert!(terminal_turn_observed(4, 4, Some("old"), Some("old"), true));
        assert!(terminal_turn_observed(4, 5, None, None, false), "fast hook turn is already complete");
        assert!(terminal_turn_observed(4, 4, Some("old"), Some("new"), false), "fast Codex turn is already complete");
        assert!(!terminal_turn_observed(4, 4, Some("old"), None, false), "missing transcript is not progress");
    }

    #[test]
    fn opencode_remote_approval_uses_the_existing_bridge_vocabulary() {
        assert_eq!(super::opencode_approval_decision("allow").unwrap(), "accept");
        assert_eq!(super::opencode_approval_decision("allowProject").unwrap(), "acceptForSession");
        assert_eq!(super::opencode_approval_decision("deny").unwrap(), "decline");
        assert!(super::opencode_approval_decision("typo").is_err());
    }

    #[test]
    fn remote_config_rejects_invalid_values_before_mutating_sessions() {
        assert!(super::validate_remote_config(Some("../model"), Some("high")).is_err());
        assert!(super::validate_remote_config(Some("grok-4.6"), Some("banana")).is_err());
        assert!(super::validate_remote_config(Some("anthropic/claude-sonnet-4-5"), None).is_ok());
        assert!(super::validate_remote_config(Some("gpt-6-astra"), Some("ultra")).is_ok());
        assert!(super::validate_remote_config(None, None).is_ok());
    }

    #[test]
    fn accepts_common_provider_slugs() {
        assert!(is_valid_remote_model_id("sonnet"));
        assert!(is_valid_remote_model_id("claude-opus-5[1m]"));
        assert!(is_valid_remote_model_id("anthropic/claude-sonnet-4-5"));
        assert!(is_valid_remote_model_id("composer-2.5"));
        assert!(is_valid_remote_model_id("composer-2.5?thinking=high"));
        assert!(is_valid_remote_model_id("claude-4.6-sonnet?thinking=medium"));
    }

    #[test]
    fn rejects_path_and_empty_model_ids() {
        assert!(!is_valid_remote_model_id(""));
        assert!(!is_valid_remote_model_id("../etc/passwd"));
        assert!(!is_valid_remote_model_id("/absolute"));
        assert!(!is_valid_remote_model_id("trailing/"));
        assert!(!is_valid_remote_model_id("has space"));
    }

    #[test]
    fn gemini_effort_is_baked_into_the_slug() {
        assert_eq!(
            super::gemini_model_with_effort(Some("gemini-3.8-flash".into()), Some("high")).as_deref(),
            Some("gemini-3.8-flash-high")
        );
        assert_eq!(
            super::gemini_model_with_effort(Some("gemini-3.8-flash-medium".into()), Some("low"))
                .as_deref(),
            Some("gemini-3.8-flash-low")
        );
        assert_eq!(
            super::gemini_model_with_effort(Some("gemini-3.1-pro".into()), None).as_deref(),
            Some("gemini-3.1-pro-high")
        );
        assert_eq!(
            super::gemini_model_with_effort(Some("gemini-3.8-flash-low".into()), None).as_deref(),
            Some("gemini-3.8-flash-low")
        );
    }
}
