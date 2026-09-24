//! Mode-aware deliver primitive shared by remote control, rooms, and A2A.
//!
//! Routes a text prompt into the correct provider surface (Claude/Grok SDK
//! chat, Codex app-server chat, or PTY terminal) without remote-only policy.

use crate::db::models::Thread;
use crate::db::queries;
use crate::state::AppState;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug)]
pub enum DispatchError {
    Message(String),
}

impl std::fmt::Display for DispatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DispatchError::Message(m) => write!(f, "{m}"),
        }
    }
}

/// Map provider + interaction_mode to the UI surface used for routing.
/// Chat → structured SDK/app-server; everything else → terminal/PTY.
pub fn surface_for(provider: &str, interaction_mode: &str) -> &'static str {
    match (provider, interaction_mode) {
        ("ClaudeCode", "sdk") => "chat",
        ("Grok", "grok-sdk") => "chat",
        ("Gemini", "gemini-sdk") => "chat",
        // Codex app-server chat often still stores interaction_mode as "pty";
        // callers may override when a codex thread id / chat flag is known.
        ("Codex", "sdk") | ("Codex", "codex-sdk") | ("Codex", "app-server") => "chat",
        ("OpenCode", "opencode-sdk") | ("OpenCode", "sdk") => "chat",
        // Cursor is chat-only (cursor-sdk); never PTY.
        ("Cursor", "cursor-sdk") | ("Cursor", "sdk") | ("Cursor", _) => "chat",
        _ => "terminal",
    }
}

/// App-server RPCs use the provider id; database logs and memory retain the
/// agmux owner id. Phone-created Codex chats use the same value for both.
pub(crate) fn codex_session_id(thread: &Thread) -> &str {
    thread.sdk_session_id.as_deref().filter(|id| !id.is_empty()).unwrap_or(&thread.id)
}

/// Legacy/discovered Codex rows lack a saved chat mode. Promote only the
/// exact thread owned by the app-server; a neighboring chat proves nothing
/// about another terminal in the same workspace.
pub(crate) async fn effective_surface(state: &AppState, thread: &Thread) -> &'static str {
    let surface = surface_for(&thread.provider, &thread.interaction_mode);
    if thread.provider != "Codex" || surface != "terminal" {
        return surface;
    }
    let session_id = codex_session_id(thread);
    {
        let sessions = state.sessions.lock().await;
        if sessions.contains_key(&thread.id) || sessions.contains_key(session_id) {
            return "terminal";
        }
    }
    if crate::codex::app_server::codex_active_turn_thread_ids().contains(session_id) {
        return "chat";
    }
    let server = state.codex_servers.lock().await.get_for_thread(&thread.work_dir, session_id);
    if let Some(server) = server {
        if let Ok(Ok(ids)) = tokio::time::timeout(
            std::time::Duration::from_secs(2), server.list_loaded_thread_ids(),
        ).await {
            if ids.iter().any(|id| id == session_id) {
                return "chat";
            }
        }
    }
    "terminal"
}

/// Deliver `text` to a thread using the same provider/surface routing as
/// remote control (Claude chat, Grok chat, Codex chat, PTY).
pub async fn send_to_thread(
    app: &AppHandle,
    thread_id: &str,
    text: &str,
) -> Result<(), DispatchError> {
    send_to_thread_with_images(app, thread_id, text, &[]).await
}

/// Human-facing prompt for logs / sidebar titles — never temp image paths.
/// Grok ACP and PTYs inject `~/.agmux/tmp/…` paths into the model prompt; those
/// must not become thread titles or thread_turns.prompt_text.
pub fn display_prompt_text(text: &str, image_count: usize) -> String {
    let text = text.trim();
    if text.is_empty() && image_count > 0 {
        format!(
            "[{} image{}]",
            image_count,
            if image_count == 1 { "" } else { "s" }
        )
    } else {
        text.to_string()
    }
}

/// Like [`send_to_thread`], with optional base64 image attachments.
///
/// - **Chat** (Claude / Codex / OpenCode): multimodal content blocks.
/// - **Grok chat** / **terminals**: save images under `~/.agmux/tmp/` and
///   inject quoted paths into the prompt (desktop InputBar / terminal paste).
pub async fn send_to_thread_with_images(
    app: &AppHandle,
    thread_id: &str,
    text: &str,
    images: &[crate::remote::protocol::RemoteImage],
) -> Result<(), DispatchError> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| DispatchError::Message("app state unavailable".into()))?;
    let text = text.trim();
    if text.is_empty() && images.is_empty() {
        return Err(DispatchError::Message("empty message".into()));
    }
    let (thread, synthetic) = resolve_thread(&state.db, thread_id).await?;

    // Route by surface: chat → provider runtime, terminal → PTY resume.
    // (A Codex terminal with no live PTY must resume the terminal, not
    // silently become an app-server chat — unless a live app-server is already
    // driving it, in which case effective_surface promotes it to chat.)
    let surface = effective_surface(&state, &thread).await;

    // Chat surfaces never fire PTY UserPromptSubmit hooks, so remote / A2A
    // sends would leave "New Grok Chat" forever. Emit *before* deliver —
    // Grok ACP `send_prompt` blocks until the turn ends, so post-await emit
    // only renamed the thread after completion.
    // Terminals already get titles from hooks — skip to avoid double LLM.
    if surface == "chat" {
        let title_text = display_prompt_text(text, images.len());
        if !title_text.is_empty() {
            let _ = app.emit(
                "session-title-prompt",
                serde_json::json!({
                    "threadId": thread_id,
                    "text": title_text,
                }),
            );
        }
        // Headless chat (phone / A2A) has no ClaudeInputBar mount to set the
        // desktop sidebar spinner. open_turn/close_turn also emit this, but
        // Claude enqueue-and-return paths still need a start pulse here when
        // no session view is listening to sdk-events.
        let _ = app.emit(
            "session-processing",
            serde_json::json!({
                "threadId": thread_id,
                "processing": true,
            }),
        );
    }

    let result = match (thread.provider.as_str(), surface) {
        ("ClaudeCode", "chat") => {
            send_claude_sdk(app, &state, thread_id, text, images).await
        }
        ("Grok", "chat") => send_grok_sdk(app, &state, &thread, text, images).await,
        ("Gemini", "chat") => send_gemini_sdk(app, &state, &thread, text, images).await,
        ("Codex", "chat") => send_codex_chat(app, &state, &thread, text, images).await,
        ("OpenCode", "chat") => {
            send_opencode_sdk(app, &state, thread_id, text, images).await
        }
        ("Cursor", "chat") => send_cursor_sdk(app, &state, &thread, text, images).await,
        _ => {
            // Terminal / PTY path — resume if unloaded. Images become temp paths.
            let line = materialize_pty_message(text, images).await?;
            send_pty_line(app, &state, &thread, synthetic, &line).await
        }
    };

    if surface == "chat" && result.is_err() {
        let _ = queries::update_thread_status(&state.db, thread_id, "Error").await;
        let _ = crate::thread_turns::close_turn(&state.db, Some(app), thread_id, "failed", None).await;
    }

    // Grok ACP `send_prompt` blocks until the turn ends, so clear the
    // spinner here. Streaming chats (Claude / Cursor / OpenCode / Codex)
    // clear via sdk-events / close_turn — emitting false here races their
    // start pulse and leaves the desktop sidebar idle while the agent works.
    if surface == "chat" && (result.is_err() || thread.provider == "Grok" || thread.provider == "Gemini") {
        let _ = app.emit(
            "session-processing",
            serde_json::json!({
                "threadId": thread_id,
                "processing": false,
            }),
        );
    }
    result
}

/// Save remote images to `~/.agmux/tmp/` and build a PTY line: quoted paths
/// then optional text (matches ClaudeInputBar PTY attach).
async fn materialize_pty_message(
    text: &str,
    images: &[crate::remote::protocol::RemoteImage],
) -> Result<String, DispatchError> {
    if images.is_empty() {
        return Ok(text.to_string());
    }
    let mut parts: Vec<String> = Vec::with_capacity(images.len() + 1);
    for img in images {
        let path = crate::commands::files::save_temp_image(img.data.clone(), img.media_type.clone())
            .await
            .map_err(DispatchError::Message)?;
        // JSON.stringify-style quotes so spaces don't break tokenization.
        parts.push(serde_json::to_string(&path).unwrap_or_else(|_| format!("\"{path}\"")));
    }
    if !text.is_empty() {
        parts.push(text.to_string());
    }
    Ok(parts.join(" "))
}

async fn send_cursor_sdk(
    app: &AppHandle,
    state: &AppState,
    thread: &Thread,
    text: &str,
    images: &[crate::remote::protocol::RemoteImage],
) -> Result<(), DispatchError> {
    // Ensure a live Cursor session (same as CursorSdkSessionView mount).
    let has_session = state
        .cursor_sdk_sessions
        .lock()
        .await
        .contains_key(&thread.id);
    if !has_session {
        crate::commands::cursor_sdk::cursor_sdk_start_session(
            app.clone(),
            app.state(),
            crate::commands::cursor_sdk::CursorStartArgs {
                thread_id: thread.id.clone(),
                directory: thread.work_dir.clone(),
                model: thread.model.clone(),
                mode: read_remote_agent_mode(&thread.state_dir),
                permission_mode: Some(read_remote_permission_mode(&thread.state_dir)),
                resume_agent_id: thread.sdk_session_id.clone().filter(|s| !s.is_empty()),
            },
        )
        .await
        .map_err(|e| DispatchError::Message(format!("start cursor session: {e}")))?;
    }
    apply_live_chat_permission(app, state, thread).await?;

    let sdk_images: Option<Vec<serde_json::Value>> = if images.is_empty() {
        None
    } else {
        Some(
            images
                .iter()
                .map(|img| {
                    serde_json::json!({
                        "data": img.data,
                        "mimeType": img.media_type,
                    })
                })
                .collect(),
        )
    };

    // cursor_sdk_send_message marks Running + emits session-processing true,
    // and bridge events clear processing on turn.completed / error.
    crate::commands::cursor_sdk::cursor_sdk_send_message(
        app.clone(),
        app.state(),
        thread.id.clone(),
        text.to_string(),
        sdk_images,
        None,
    )
    .await
    .map_err(DispatchError::Message)?;
    Ok(())
}

async fn send_opencode_sdk(
    app: &AppHandle,
    state: &AppState,
    thread_id: &str,
    text: &str,
    images: &[crate::remote::protocol::RemoteImage],
) -> Result<(), DispatchError> {
    let log_text = display_prompt_text(text, images.len());
    let _ = queries::insert_agent_log(&state.db, thread_id, "Input", &log_text).await;
    // Offloaded chat: bring the bridge + session up the way OpenCodeSdkSessionView
    // does — initialize bridge if needed, resume when opencode_session_id is set,
    // otherwise start fresh. Phones must not require the desktop chat open first.
    let thread = queries::get_thread(&state.db, thread_id)
        .await
        .map_err(|e| DispatchError::Message(e.to_string()))?;
    let has_session = state
        .opencode_sdk_sessions
        .lock()
        .await
        .contains_key(thread_id);
    if !has_session {
        let bridge_up = state.opencode_sdk_bridge.lock().await.is_some();
        if !bridge_up {
            crate::commands::opencode_sdk::opencode_sdk_initialize_bridge(
                app.clone(),
                app.state(),
                crate::commands::opencode_sdk::OpenCodeInitArgs {
                    binary_path: None,
                    server_url: None,
                    server_password: None,
                },
            )
            .await
            .map_err(|e| DispatchError::Message(format!("start opencode bridge: {e}")))?;
        }
        let resume = thread
            .opencode_session_id
            .clone()
            .filter(|s| !s.is_empty());
        let resuming = resume.is_some();
        crate::commands::opencode_sdk::opencode_sdk_start_session(
            app.clone(),
            app.state(),
            crate::commands::opencode_sdk::OpenCodeStartArgs {
                thread_id: thread_id.to_string(),
                directory: thread.work_dir.clone(),
                model: thread
                    .model
                    .clone()
                    .unwrap_or_else(|| "anthropic/claude-sonnet-4-5".into()),
                agent: None,
                permission_mode: Some(opencode_permission_from_remote(
                    &read_remote_permission_mode(&thread.state_dir),
                )),
                resume_session_id: resume,
            },
        )
        .await
        .map_err(|e| {
            DispatchError::Message(if resuming {
                format!("resume opencode session: {e}")
            } else {
                format!("start opencode session: {e}")
            })
        })?;
    }
    apply_live_chat_permission(app, state, &thread).await?;
    let bridge = state
        .opencode_sdk_bridge
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| DispatchError::Message("opencode bridge not initialized".into()))?;
    let _ = crate::thread_turns::open_turn(
        &state.db,
        Some(app),
        thread_id,
        &log_text,
        "chat_item",
    )
    .await;
    // Desktop OpenCodeSdkSessionView shape: name/mimeType/dataUrl.
    let attachments: Vec<serde_json::Value> = images
        .iter()
        .enumerate()
        .map(|(i, img)| {
            serde_json::json!({
                "name": format!("image-{i}"),
                "mimeType": img.media_type,
                "dataUrl": format!("data:{};base64,{}", img.media_type, img.data),
            })
        })
        .collect();
    let _ = queries::update_thread_status(&state.db, thread_id, "Running").await;
    bridge
        .send_request(
            "sendMessage",
            serde_json::json!({
                "threadId": thread_id,
                "text": text,
                "attachments": attachments,
            }),
        )
        .await
        .map_err(DispatchError::Message)?;
    Ok(())
}

/// A thread / session id is safe to use as a path component only if it is a
/// non-empty run of the characters real agmux/provider ids use (UUIDs, plus the
/// hyphen/underscore some providers emit). Anything with a separator, `..`, or a
/// leading dot is rejected so it can never escape the intended directory.
fn is_safe_thread_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('.')
        && !id.starts_with('-') // never let the id become a CLI flag (`claude --resume <id>`)
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Resolve a catalog id to a Thread. Falls back to synthesizing one for
/// on-disk Claude sessions the desktop sidebar lists without a `threads` row
/// (discovered sessions). The bool is true for synthesized threads.
pub async fn resolve_thread(
    pool: &sqlx::SqlitePool,
    id: &str,
) -> Result<(Thread, bool), DispatchError> {
    // The id becomes a path component (`{id}.jsonl`, `~/.agmux/threads/{id}`,
    // `--resume {id}`) and can arrive raw off the remote WebSocket, so reject
    // anything that could traverse the filesystem before it is used.
    if !is_safe_thread_id(id) {
        return Err(DispatchError::Message(format!("invalid thread id: {id}")));
    }
    if let Ok(t) = queries::get_thread(pool, id).await {
        return Ok((t, false));
    }
    let home = dirs::home_dir()
        .ok_or_else(|| DispatchError::Message("no home dir".into()))?;
    let projects = queries::list_projects(pool)
        .await
        .map_err(|e| DispatchError::Message(e.to_string()))?;
    for p in &projects {
        let enc = crate::encode_claude_project_path(&p.repo_path);
        let jsonl = home
            .join(".claude")
            .join("projects")
            .join(&enc)
            .join(format!("{id}.jsonl"));
        if jsonl.is_file() {
            return Ok((synthetic_pty_thread(id, "ClaudeCode", p), true));
        }
    }
    // Discovered Codex sessions: a rollout under ~/.codex/sessions whose
    // session_meta cwd matches a project (same rows the desktop sidebar lists
    // via the app-server thread list).
    if let Some(cwd) = crate::remote::client::codex_rollout_cwd(&home, id) {
        if let Some(p) = projects.iter().find(|p| p.repo_path == cwd) {
            return Ok((synthetic_pty_thread(id, "Codex", p), true));
        }
    }
    // Discovered Kimi / Pi / Grok terminals (sidebar kimiSessions /
    // piSessions / grokSessions). Readers use sdk_session_id; the first send
    // claims a host row (see send_pty_line).
    if let Some((provider, p)) = crate::remote::discovered_terminals::locate(&home, &projects, id).await {
        return Ok((synthetic_pty_thread(id, provider, p), true));
    }
    Err(DispatchError::Message(format!("thread not found: {id}")))
}

/// Thread stand-in for an on-disk provider session with no `threads` row.
/// The session uuid doubles as the thread id (matches how the desktop keys
/// PTYs for discovered sessions).
fn synthetic_pty_thread(
    id: &str,
    provider: &str,
    p: &crate::db::models::Project,
) -> Thread {
    let state_dir = crate::paths::agmux_home().join("threads").join(id);
    Thread {
        id: id.to_string(),
        project_id: p.id.clone(),
        name: String::new(),
        provider: provider.into(),
        run_mode: "Local".into(),
        work_mode: "DirectRepo".into(),
        work_dir: p.repo_path.clone(),
        state_dir: state_dir.to_string_lossy().into_owned(),
        status: "Idle".into(),
        created_at: String::new(),
        last_active: String::new(),
        model: None,
        reasoning_effort: None,
        fast_mode: 0,
        is_archived: 0,
        worktree_branch: None,
        interaction_mode: "pty".into(),
        sdk_session_id: Some(id.to_string()),
        opencode_session_id: None,
        forked_from_thread_id: None,
        forked_at_message_index: None,
        lines_added: 0,
        lines_removed: 0,
        files_changed: 0,
        agent_profile: None,
    }
}

async fn send_claude_sdk(
    app: &AppHandle,
    state: &AppState,
    thread_id: &str,
    text: &str,
    images: &[crate::remote::protocol::RemoteImage],
) -> Result<(), DispatchError> {
    let log_text = display_prompt_text(text, images.len());
    let _ = queries::insert_agent_log(&state.db, thread_id, "Input", &log_text).await;
    // Offloaded chat: bring the sidecar session up EXACTLY the way the
    // desktop chat view does (ClaudeSdkSessionView) — fresh threads start
    // with an auto-generated session id (the real sid binds via the
    // session.started event; pinning ids produced headerless transcripts),
    // and threads with a bound session resume via sdk_resume_session.
    // Diverging from that flow forked a new JSONL per send and littered the
    // sidebar with orphaned duplicate "terminal" sessions.
    let thread = queries::get_thread(&state.db, thread_id)
        .await
        .map_err(|e| DispatchError::Message(e.to_string()))?;
    let session_up = state.sdk_sessions.lock().await.contains_key(thread_id);
    if !session_up {
        let has_session = thread
            .sdk_session_id
            .as_deref()
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        let perm = Some(claude_permission_from_remote(&thread.state_dir));
        if has_session {
            crate::commands::claude_sdk::sdk_resume_session(
                app.state(),
                app.clone(),
                thread_id.to_string(),
                perm.clone(),
            )
            .await
            .map_err(|e| DispatchError::Message(format!("resume chat session: {e}")))?;
        } else {
            crate::commands::claude_sdk::sdk_start_session(
                app.state(),
                app.clone(),
                thread_id.to_string(),
                thread.work_dir.clone(),
                Some(thread.model.clone().unwrap_or_else(|| "sonnet".into())),
                perm,
                thread.reasoning_effort.clone(),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                thread.agent_profile.clone(),
                None,
                None,
            )
            .await
            .map_err(|e| DispatchError::Message(format!("start chat session: {e}")))?;
        }
    }
    // Follow-up turns keep the sidecar up, so start/resume is skipped —
    // push the (possibly changed) phone permission onto the live session.
    apply_live_chat_permission(app, state, &thread).await?;
    let ctx = state.sdk_sessions.lock().await
        .get(thread_id).cloned()
        .ok_or_else(|| DispatchError::Message("no SDK session — open the chat on desktop first".into()))?;
    let mut params = serde_json::json!({ "text": text });
    if !images.is_empty() {
        let sdk_images: Vec<serde_json::Value> = images
            .iter()
            .map(|img| {
                serde_json::json!({
                    "data": img.data,
                    "mediaType": img.media_type,
                })
            })
            .collect();
        params["images"] = serde_json::Value::Array(sdk_images);
    }
    // Persist the start before sending: a fast completion must not be followed
    // by a detached open_turn that leaves the phone permanently busy.
    let _ = queries::update_thread_status(&state.db, thread_id, "Running").await;
    let _ = crate::thread_turns::open_turn(&state.db, Some(app), thread_id, &log_text, "chat_item").await;
    ctx.send_request("sendMessage", params)
        .await
        .map_err(DispatchError::Message)?;
    Ok(())
}

async fn send_grok_sdk(
    app: &AppHandle,
    state: &AppState,
    thread: &Thread,
    text: &str,
    images: &[crate::remote::protocol::RemoteImage],
) -> Result<(), DispatchError> {
    crate::teams::policy::refresh_for_execution().await.map_err(DispatchError::Message)?;
    crate::teams::policy::enforce_session("Grok", "chat").map_err(DispatchError::Message)?;
    // Offloaded / brand-new chat: spawn the ACP server and resume-or-create
    // the session so phones don't need the desktop UI open first.
    let server_up = state.grok_servers.lock().await.get(&thread.id).is_some();
    let session_id = if server_up {
        match thread.sdk_session_id.clone().filter(|s| !s.is_empty()) {
            Some(sid) => sid,
            None => ensure_grok_session(app, thread).await?,
        }
    } else {
        ensure_grok_session(app, thread).await?
    };
    apply_live_chat_permission(app, state, thread).await?;
    // Grok ACP `session/prompt` accepts image content blocks (same as Gemini).
    // Logs / titles keep the human text only so remote fallback titles aren't
    // temp-file paths.
    let display = display_prompt_text(text, images.len());
    let mapped: Vec<crate::grok::app_server::AcpPromptImage> = images
        .iter()
        .map(|img| crate::grok::app_server::AcpPromptImage {
            data: img.data.clone(),
            media_type: img.media_type.clone(),
        })
        .collect();
    let _ = crate::thread_turns::open_turn(
        &state.db,
        Some(app),
        &thread.id,
        &display,
        "chat_item",
    )
    .await;
    let server = {
        let servers = state.grok_servers.lock().await;
        servers
            .get(&thread.id)
            .ok_or_else(|| DispatchError::Message("grok server not running — open session on desktop first".into()))?
    };
    let _ = queries::insert_agent_log(&state.db, &thread.id, "Input", &display).await;
    // `send_prompt` resolves only when the turn ends, so the turn opened above
    // MUST be closed on both paths — an abandoned "running" row is what remote
    // control reads to decide whether the session is still working.
    let result = server
        .send_prompt_blocks(&session_id, text, mapped)
        .await;
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
    let _ = crate::thread_turns::close_turn(&state.db, Some(app), &thread.id, status, local_port)
        .await;
    result.map_err(|e| DispatchError::Message(e.to_string()))?;
    Ok(())
}

async fn ensure_grok_session(app: &AppHandle, thread: &Thread) -> Result<String, DispatchError> {
    let grok_perm = if read_remote_agent_mode(&thread.state_dir).as_deref() == Some("plan") {
        Some("plan".to_string())
    } else {
        match read_remote_permission_mode(&thread.state_dir).as_str() {
            "full" | "bypassPermissions" => Some("bypassPermissions".to_string()),
            "auto" => Some("auto".to_string()),
            "plan" => Some("plan".to_string()),
            _ => Some("default".to_string()),
        }
    };
    crate::commands::grok_sdk::grok_sdk_ensure_server(
        app.clone(),
        app.state(),
        thread.id.clone(),
        thread.work_dir.clone(),
        grok_perm,
        thread.reasoning_effort.clone(),
        thread.model.clone(),
    )
    .await
    .map_err(|e| DispatchError::Message(format!("start grok session: {e}")))
}

async fn send_gemini_sdk(
    app: &AppHandle,
    state: &AppState,
    thread: &Thread,
    text: &str,
    images: &[crate::remote::protocol::RemoteImage],
) -> Result<(), DispatchError> {
    crate::teams::policy::refresh_for_execution().await.map_err(DispatchError::Message)?;
    crate::teams::policy::enforce_session("Gemini", "chat").map_err(DispatchError::Message)?;
    let server_up = state.gemini_servers.lock().await.get(&thread.id).is_some();
    let session_id = if server_up {
        match thread.sdk_session_id.clone().filter(|s| !s.is_empty()) {
            Some(sid) => sid,
            None => ensure_gemini_session(app, thread).await?,
        }
    } else {
        ensure_gemini_session(app, thread).await?
    };
    apply_live_chat_permission(app, state, thread).await?;
    let display = display_prompt_text(text, images.len());
    let mapped: Vec<crate::commands::gemini_sdk::GeminiPromptImage> = images
        .iter()
        .map(|img| crate::commands::gemini_sdk::GeminiPromptImage {
            data: img.data.clone(),
            media_type: img.media_type.clone(),
        })
        .collect();
    let _ = queries::insert_agent_log(&state.db, &thread.id, "Input", &display).await;
    crate::commands::gemini_sdk::gemini_sdk_send_prompt(
        app.clone(),
        app.state(),
        thread.id.clone(),
        session_id,
        text.to_string(),
        if mapped.is_empty() { None } else { Some(mapped) },
    )
    .await
    .map_err(|e| DispatchError::Message(e.to_string()))?;
    Ok(())
}

async fn ensure_gemini_session(app: &AppHandle, thread: &Thread) -> Result<String, DispatchError> {
    let gemini_perm = if read_remote_agent_mode(&thread.state_dir).as_deref() == Some("plan") {
        Some("plan".to_string())
    } else {
        match read_remote_permission_mode(&thread.state_dir).as_str() {
            "full" | "bypassPermissions" => Some("bypassPermissions".to_string()),
            "auto" => Some("auto".to_string()),
            "plan" => Some("plan".to_string()),
            _ => Some("default".to_string()),
        }
    };
    crate::commands::gemini_sdk::gemini_sdk_ensure_server(
        app.clone(),
        app.state(),
        thread.id.clone(),
        thread.work_dir.clone(),
        gemini_perm,
        thread.reasoning_effort.clone(),
        thread.model.clone(),
    )
    .await
    .map_err(|e| DispatchError::Message(format!("start gemini session: {e}")))
}

async fn send_codex_chat(
    app: &AppHandle,
    state: &AppState,
    thread: &Thread,
    text: &str,
    images: &[crate::remote::protocol::RemoteImage],
) -> Result<(), DispatchError> {
    let work_dir = thread.work_dir.clone();
    let thread_id = thread.id.clone();
    let session_id = codex_session_id(thread);
    let project_id = thread.project_id.clone();
    crate::provider_accounts::remember_model("codex", session_id, thread.model.as_deref())
        .await.map_err(DispatchError::Message)?;
    let reservation = {
        let mut servers = state.codex_servers.lock().await;
        servers
            .get_or_spawn_for_turn(
                app,
                &work_dir,
                Some(&project_id),
                Some(&work_dir),
                session_id,
            )
            .await
            .map_err(DispatchError::Message)?
    };
    // `send_message` resumes if this process does not have the thread loaded
    // (Mac relaunch, idle reaper, Stop). Do not resume twice here.
    let memory_context = crate::memory::codex_turn_memory_instruction_if_available(
        &thread_id,
        crate::memory::is_enabled(),
        reservation.server().memory_mcp_configured(),
    );
    let log_text = display_prompt_text(text, images.len());
    let _ = queries::insert_agent_log(&state.db, &thread_id, "Input", &log_text).await;
    let _ = queries::update_thread_status(&state.db, &thread_id, "Running").await;
    let codex_images: Vec<crate::codex::app_server::ImageAttachment> = images
        .iter()
        .map(|img| crate::codex::app_server::ImageAttachment {
            data: img.data.clone(),
            media_type: img.media_type.clone(),
        })
        .collect();
    let access_mode = codex_access_from_remote(&read_remote_permission_mode(&thread.state_dir));
    let result = reservation
        .server()
        .send_message(
            session_id,
            text,
            thread.model.as_deref(),
            thread.reasoning_effort.as_deref(),
            Some(&work_dir),
            access_mode.as_deref(),
            &codex_images,
            None,
            (thread.fast_mode != 0).then_some("priority"),
            memory_context.as_deref(),
        )
        .await;
    match result {
        Ok(value) => {
            reservation.commit(&value);
            Ok(())
        }
        Err(error) => Err(DispatchError::Message(error.to_string())),
    }
}

async fn send_pty_line(
    app: &AppHandle,
    state: &AppState,
    thread: &Thread,
    synthetic: bool,
    text: &str,
) -> Result<(), DispatchError> {
    // Discovered Kimi/Pi/Grok sessions: host them in a threads row first, like
    // the desktop sidebar click, then resume through ensure_pty_session below.
    let claimed: Thread;
    let (thread, synthetic) = if synthetic && crate::remote::discovered_terminals::needs_claim(&thread.provider) {
        claimed = crate::remote::discovered_terminals::claim_discovered_terminal(app, thread)
            .await
            .map_err(DispatchError::Message)?;
        (&claimed, false)
    } else {
        (thread, synthetic)
    };
    let thread_id = thread.id.as_str();
    // Grok PTY MCP is project-scoped (shared config.toml) and resolves the
    // session via AGMUX_ACTIVE_THREAD_FILE — refresh on each send so handoffs
    // land on the thread that is currently talking.
    if thread.provider == "Grok" && !thread.project_id.is_empty() {
        crate::handoff::write_active_thread_id(&thread.project_id, thread_id);
    }
    let was_alive = {
        let sessions = state.sessions.lock().await;
        match sessions.get(thread_id) {
            Some(s) => s.is_alive().await,
            None => false,
        }
    };
    // Unloaded / offloaded terminals: resume the provider session so the
    // phone can talk without first opening the thread on desktop. Discovered
    // Claude sessions (no threads row) resume via the same claude --resume
    // path the sidebar uses, keyed by the session uuid.
    let claude_resume_sid = if thread.provider == "ClaudeCode" {
        // Synthetic threads use the session uuid as their id; DB rows carry it
        // in sdk_session_id. ensure_pty_session would spawn a FRESH claude
        // session (its option builder only wires --resume for Grok), so route
        // Claude terminals through the same resume path the sidebar uses.
        thread
            .sdk_session_id
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| synthetic.then(|| thread.id.clone()))
    } else {
        None
    };
    if let Some(sid) = claude_resume_sid {
        if !was_alive {
            crate::commands::threads::spawn_claude_resume(
                app.state(),
                app.clone(),
                thread_id.to_string(),
                thread.work_dir.clone(),
                Some(sid),
                None,
            )
            .await
            .map_err(|e| DispatchError::Message(format!("resume claude session: {e}")))?;
        }
    } else if thread.provider == "Codex" && synthetic {
        // Discovered Codex sessions resume via the same `codex resume <id>`
        // path the desktop sidebar uses, PTY keyed by the session uuid.
        if !was_alive {
            crate::commands::threads::spawn_codex_resume(
                app.state(),
                app.clone(),
                thread.id.clone(),
                thread.work_dir.clone(),
                None,
            )
            .await
            .map_err(|e| DispatchError::Message(format!("resume codex session: {e}")))?;
        }
    } else if synthetic {
        return Err(DispatchError::Message(
            "session has no resumable transcript — open it on desktop first".into(),
        ));
    } else {
        crate::commands::threads::ensure_pty_session(state, app, thread_id, None)
            .await
            .map_err(|e| DispatchError::Message(format!("resume terminal: {e}")))?;
    }
    if !was_alive {
        // Freshly resumed: wait until the TUI finishes booting before typing.
        // A fixed sleep wasn't enough — Claude resuming a large session takes
        // many seconds, and prompts typed early are eaten by the boot screen.
        // "Booted" = PTY produced output, then went quiet for a beat.
        wait_for_pty_quiescence(state, thread_id, 1200, 20_000).await;
    }
    let text = text.trim_end_matches(['\r', '\n']);
    // Clear any half-typed prompt line (Ctrl-U) before injecting. Without this,
    // remote sends into a live Grok/Claude prompt can lose the first keystroke
    // (phone typed "implement", chat_history logged "mplement") — the phone then
    // keeps a dashed optimistic bubble forever because exact text match fails.
    send_pty_raw(state, thread_id, "\x15").await?;
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    // Mirror the desktop `sendPtyLine` convention: multi-line pastes (and any
    // write into a freshly-spawned TUI) submit CR separately after a pause.
    if text.contains('\n') || !was_alive {
        send_pty_raw(state, thread_id, text).await?;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        send_pty_raw(state, thread_id, "\r").await
    } else {
        send_pty_raw(state, thread_id, &format!("{text}\r")).await
    }
}

/// Wait until the thread's PTY has produced output and then stayed quiet for
/// `quiet_ms` (or `max_ms` elapses). Used to detect that a freshly-resumed
/// provider TUI is ready for input.
async fn wait_for_pty_quiescence(state: &AppState, thread_id: &str, quiet_ms: u64, max_ms: u64) {
    let start = std::time::Instant::now();
    let mut last_off: u64 = 0;
    let mut last_change = std::time::Instant::now();
    let mut seen_output = false;
    loop {
        if start.elapsed().as_millis() as u64 > max_ms {
            return;
        }
        let off = {
            let sessions = state.sessions.lock().await;
            match sessions.get(thread_id) {
                Some(s) => s
                    .output_buffer
                    .lock()
                    .map(|b| b.end_offset())
                    .unwrap_or(0),
                None => return,
            }
        };
        if off != last_off {
            last_off = off;
            last_change = std::time::Instant::now();
            if off > 0 {
                seen_output = true;
            }
        }
        if seen_output && last_change.elapsed().as_millis() as u64 >= quiet_ms {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
}

/// Write raw bytes to a live PTY (used by send path and remote interrupt/approval).
pub async fn send_pty_raw(state: &AppState, thread_id: &str, data: &str) -> Result<(), DispatchError> {
    send_pty_raw_checked(state, thread_id, data, None).await
}

/// Consume a terminal approval only after the target and writer are ready.
/// Once writing begins, failures may include delivered bytes: never restore
/// the request automatically after a write/flush error.
/// Keys come from the live PTY's provider (Claude/Kimi numbered dialog:
/// `1` allows once, Esc denies — `n` would be ignored and Enter would allow).
pub(crate) async fn send_pty_approval(
    state: &AppState,
    thread_id: &str,
    request_id: &str,
    approve: bool,
) -> Result<(), DispatchError> {
    let provider = state.sessions.lock().await.get(thread_id)
        .map(|s| s.provider.clone())
        .ok_or_else(|| DispatchError::Message("no active terminal session".into()))?;
    let data = crate::remote::terminal_approvals::approval_keys(&provider, approve)
        .ok_or_else(|| DispatchError::Message("terminal approvals are not supported for this agent".into()))?;
    send_pty_raw_checked(state, thread_id, data, Some(request_id)).await?;
    crate::remote::terminal_approvals::answered(thread_id, request_id);
    Ok(())
}

async fn send_pty_raw_checked(
    state: &AppState,
    thread_id: &str,
    data: &str,
    approval_request_id: Option<&str>,
) -> Result<(), DispatchError> {
    let input_ticket = {
        let sessions = state.sessions.lock().await;
        let session = sessions.get(thread_id)
            .ok_or_else(|| DispatchError::Message("no active terminal session".into()))?;
        session.input_ticket(matches!(data, "\x03" | "\x1b"))
    };
    if !matches!(data, "\x03" | "\x1b" | "") {
        // Refresh before acquiring the global session registry: cancellation
        // must not wait behind an online policy fetch.
        crate::teams::policy::refresh_for_execution().await.map_err(DispatchError::Message)?;
    }
    let sessions = state.sessions.lock().await;
    let session = sessions.get(thread_id).ok_or_else(|| {
        DispatchError::Message(
            "no active terminal session — open the thread on desktop first".into(),
        )
    })?;
    if !session.is_alive().await {
        return Err(DispatchError::Message("terminal process is not running".into()));
    }
    let mut writer = session.writer.lock().await;
    session.validate_input_ticket(&input_ticket).map_err(DispatchError::Message)?;
    if let Some(request_id) = approval_request_id {
        if !state.remote.take_pending_approval(thread_id, request_id).await {
            return Err(DispatchError::Message("approval already resolved".into()));
        }
    }
    use std::io::Write;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| DispatchError::Message(format!("pty write: {e}")))?;
    writer
        .flush()
        .map_err(|e| DispatchError::Message(format!("pty flush: {e}")))?;
    // Don't log control-only writes (Ctrl-U clear, bare CR, Ctrl-C, ESC…) as
    // user Input — phones would show a blank/garbage bubble and Ctrl-U `\x15`
    // was appearing as a user turn after remote path-inject.
    // An approval key (`1`) is a dialog answer, not a user message.
    if approval_request_id.is_none() && !data.is_empty() && !data.chars().all(|c| c.is_control()) {
        let pool = state.db.clone();
        let tid = thread_id.to_string();
        let content = data.to_string();
        tauri::async_runtime::spawn(async move {
            let _ = queries::insert_agent_log(&pool, &tid, "Input", &content).await;
        });
    }

    // Clear hooks only when the key is the provider's stop (phone interrupt
    // sends `terminal_stop_key`: Ctrl-C for Grok, Escape for the rest).
    if data == "\x03" || data == "\x1b" {
        let pool = state.db.clone();
        let tid = thread_id.to_string();
        let key = data.to_string();
        tauri::async_runtime::spawn(async move {
            let thread = queries::get_thread(&pool, &tid).await.ok();
            let provider = thread
                .as_ref()
                .map(|t| t.provider.as_str())
                .unwrap_or("");
            let is_grok = provider.eq_ignore_ascii_case("Grok");
            // Escape only clears non-Grok (desktop parity).
            let clear = key == "\x03" || (!is_grok && key == "\x1b");
            if !clear {
                return;
            }
            let sid = thread.and_then(|t| t.sdk_session_id).unwrap_or_default();
            crate::hooks::hook_clear_running(&[tid.as_str(), sid.as_str()]);
        });
    }
    Ok(())
}

fn remote_permission_path(state_dir: &str) -> std::path::PathBuf {
    std::path::Path::new(state_dir).join("remote-permission-mode.txt")
}

fn remote_agent_mode_path(state_dir: &str) -> std::path::PathBuf {
    std::path::Path::new(state_dir).join("remote-agent-mode.txt")
}

pub fn write_remote_permission_mode(state_dir: &str, mode: &str) {
    let mode = mode.trim();
    if state_dir.is_empty() || mode.is_empty() {
        return;
    }
    let _ = std::fs::create_dir_all(state_dir);
    let _ = std::fs::write(remote_permission_path(state_dir), mode);
}

pub fn read_remote_permission_mode(state_dir: &str) -> String {
    std::fs::read_to_string(remote_permission_path(state_dir))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".into())
}

pub fn write_remote_agent_mode(state_dir: &str, mode: &str) {
    let mode = mode.trim();
    if state_dir.is_empty() || mode.is_empty() {
        return;
    }
    let _ = std::fs::create_dir_all(state_dir);
    let _ = std::fs::write(remote_agent_mode_path(state_dir), mode);
}

pub fn read_remote_agent_mode(state_dir: &str) -> Option<String> {
    std::fs::read_to_string(remote_agent_mode_path(state_dir))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn claude_permission_from_remote(state_dir: &str) -> String {
    if read_remote_agent_mode(state_dir).as_deref() == Some("plan") {
        return "plan".into();
    }
    match read_remote_permission_mode(state_dir).as_str() {
        "full" | "bypassPermissions" => "bypassPermissions".into(),
        "auto" => "auto".into(),
        "plan" => "plan".into(),
        _ => "default".into(),
    }
}

pub fn map_remote_perm_to_sdk(mode: &str) -> String {
    match mode {
        "full" | "bypassPermissions" => "bypassPermissions".into(),
        "auto" => "auto".into(),
        "plan" => "plan".into(),
        _ => "default".into(),
    }
}

pub fn opencode_permission_from_remote(mode: &str) -> String {
    match mode {
        "full" | "bypassPermissions" | "full-access" => "bypassPermissions".into(),
        "auto" => "auto".into(),
        _ => "normal".into(),
    }
}

/// Codex `turn/start` accessMode. `None` keeps supervised (user reviews).
pub fn codex_access_from_remote(mode: &str) -> Option<String> {
    match mode {
        "full" | "bypassPermissions" | "full-access" => Some("full-access".into()),
        "auto" | "auto-review" => Some("auto".into()),
        _ => None,
    }
}

/// Wire payload to push onto an already-running chat so a permission change
/// after the first turn takes effect on the next send (and on setConfig).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveChatPermission {
    /// Claude / Grok / Gemini `setPermissionMode`.
    Sdk(String),
    /// OpenCode bridge mode (`normal` | `auto` | `bypassPermissions`).
    OpenCode(String),
    /// Cursor bridge mode (`default` | `auto` | `full` | `plan`).
    Cursor(String),
    /// Codex `turn/start` accessMode. `None` = supervised.
    Codex(Option<String>),
}

pub fn live_chat_permission(
    provider: &str,
    remote_mode: &str,
    plan: bool,
) -> Option<LiveChatPermission> {
    if plan && matches!(provider, "ClaudeCode" | "Grok" | "Gemini" | "Cursor") {
        return Some(match provider {
            "Cursor" => LiveChatPermission::Cursor("plan".into()),
            _ => LiveChatPermission::Sdk("plan".into()),
        });
    }
    match provider {
        "ClaudeCode" | "Grok" | "Gemini" => {
            Some(LiveChatPermission::Sdk(map_remote_perm_to_sdk(remote_mode)))
        }
        "OpenCode" => Some(LiveChatPermission::OpenCode(
            opencode_permission_from_remote(remote_mode),
        )),
        "Cursor" => Some(LiveChatPermission::Cursor(remote_mode.to_string())),
        "Codex" => Some(LiveChatPermission::Codex(codex_access_from_remote(
            remote_mode,
        ))),
        _ => None,
    }
}

/// Push the persisted remote permission onto a live chat session. No-op when
/// the session is not running yet (start/resume still reads the file). Codex
/// applies per `turn/start` and is skipped here.
pub async fn apply_live_chat_permission(app: &AppHandle, state: &AppState, thread: &Thread) -> Result<(), DispatchError> {
    let Some(payload) = saved_live_chat_permission(&thread.provider, &thread.state_dir) else {
        return Ok(());
    };
    match payload {
        LiveChatPermission::Sdk(mode) => match thread.provider.as_str() {
            "ClaudeCode" => {
                if state.sdk_sessions.lock().await.contains_key(&thread.id) {
                    crate::commands::claude_sdk::sdk_set_permission_mode(
                        app.state(),
                        thread.id.clone(),
                        mode,
                    )
                    .await.map_err(DispatchError::Message)?;
                }
            }
            "Grok" => {
                if state.grok_servers.lock().await.get(&thread.id).is_some() {
                    crate::commands::grok_sdk::grok_sdk_set_permission_mode(
                        app.state(),
                        thread.id.clone(),
                        mode,
                    )
                    .await.map_err(DispatchError::Message)?;
                }
            }
            "Gemini" => {
                if state.gemini_servers.lock().await.get(&thread.id).is_some() {
                    crate::commands::gemini_sdk::gemini_sdk_set_permission_mode(
                        app.state(),
                        thread.id.clone(),
                        mode,
                    )
                    .await.map_err(DispatchError::Message)?;
                }
            }
            _ => {}
        },
        LiveChatPermission::OpenCode(mode) => {
            if state
                .opencode_sdk_sessions
                .lock()
                .await
                .contains_key(&thread.id)
            {
                crate::commands::opencode_sdk::opencode_sdk_set_permission_mode(
                    app.state(),
                    thread.id.clone(),
                    mode,
                )
                .await.map_err(DispatchError::Message)?;
            }
        }
        LiveChatPermission::Cursor(mode) => {
            if state
                .cursor_sdk_sessions
                .lock()
                .await
                .contains_key(&thread.id)
            {
                crate::commands::cursor_sdk::cursor_sdk_set_permission_mode(
                    app.clone(),
                    app.state(),
                    thread.id.clone(),
                    mode,
                )
                .await.map_err(DispatchError::Message)?;
            }
        }
        LiveChatPermission::Codex(_) => {}
    }
    Ok(())
}

fn saved_live_chat_permission(provider: &str, state_dir: &str) -> Option<LiveChatPermission> {
    // Shared dispatch also delivers room/A2A messages to desktop-owned chats.
    // No phone preference is not a request to replace their live mode.
    if !remote_permission_path(state_dir).is_file() && !remote_agent_mode_path(state_dir).is_file() {
        return None;
    }
    let plan = read_remote_agent_mode(state_dir).as_deref() == Some("plan");
    let remote_mode = read_remote_permission_mode(state_dir);
    live_chat_permission(provider, &remote_mode, plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surface_for_modes() {
        assert_eq!(surface_for("ClaudeCode", "sdk"), "chat");
        assert_eq!(surface_for("ClaudeCode", "pty"), "terminal");
        assert_eq!(surface_for("Grok", "grok-sdk"), "chat");
        assert_eq!(surface_for("Grok", "pty"), "terminal");
        assert_eq!(surface_for("Gemini", "gemini-sdk"), "chat");
        assert_eq!(surface_for("Gemini", "pty"), "terminal");
        assert_eq!(surface_for("Codex", "pty"), "terminal");
        assert_eq!(surface_for("Codex", "sdk"), "chat");
        assert_eq!(surface_for("Codex", "codex-sdk"), "chat");
        assert_eq!(surface_for("Codex", "app-server"), "chat");
        assert_eq!(surface_for("Cursor", "cursor-sdk"), "chat");
        assert_eq!(surface_for("Cursor", "sdk"), "chat");
        assert_eq!(surface_for("Cursor", "pty"), "chat");
    }

    #[test]
    fn display_prompt_prefers_text_over_image_placeholder() {
        assert_eq!(display_prompt_text("fix login", 2), "fix login");
        assert_eq!(display_prompt_text("  ", 1), "[1 image]");
        assert_eq!(display_prompt_text("", 3), "[3 images]");
        assert_eq!(display_prompt_text("hello", 0), "hello");
    }

    #[test]
    fn maps_remote_permission_modes() {
        assert_eq!(map_remote_perm_to_sdk("full"), "bypassPermissions");
        assert_eq!(map_remote_perm_to_sdk("auto"), "auto");
        assert_eq!(map_remote_perm_to_sdk("default"), "default");
        assert_eq!(opencode_permission_from_remote("full"), "bypassPermissions");
        assert_eq!(opencode_permission_from_remote("default"), "normal");
        assert_eq!(codex_access_from_remote("full").as_deref(), Some("full-access"));
        assert_eq!(codex_access_from_remote("auto").as_deref(), Some("auto"));
        assert_eq!(codex_access_from_remote("default"), None);
    }

    #[test]
    fn followup_send_picks_up_permission_change_after_first_turn() {
        // First turn started with default; user then flips the phone chip.
        assert_eq!(
            live_chat_permission("ClaudeCode", "default", false),
            Some(LiveChatPermission::Sdk("default".into()))
        );
        assert_eq!(
            live_chat_permission("ClaudeCode", "full", false),
            Some(LiveChatPermission::Sdk("bypassPermissions".into()))
        );
        assert_eq!(
            live_chat_permission("Grok", "auto", false),
            Some(LiveChatPermission::Sdk("auto".into()))
        );
        assert_eq!(
            live_chat_permission("Gemini", "full", false),
            Some(LiveChatPermission::Sdk("bypassPermissions".into()))
        );
        assert_eq!(
            live_chat_permission("OpenCode", "full", false),
            Some(LiveChatPermission::OpenCode("bypassPermissions".into()))
        );
        assert_eq!(
            live_chat_permission("Cursor", "auto", false),
            Some(LiveChatPermission::Cursor("auto".into()))
        );
        assert_eq!(
            live_chat_permission("Codex", "full", false),
            Some(LiveChatPermission::Codex(Some("full-access".into())))
        );
        assert_eq!(
            live_chat_permission("Grok", "full", true),
            Some(LiveChatPermission::Sdk("plan".into()))
        );
        assert_eq!(live_chat_permission("Pi", "full", false), None);
    }

    #[test]
    fn permission_file_roundtrip() {
        let dir = std::env::temp_dir().join(format!("agmux-perm-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.to_string_lossy();
        write_remote_permission_mode(&path, "full");
        write_remote_agent_mode(&path, "plan");
        assert_eq!(read_remote_permission_mode(&path), "full");
        assert_eq!(read_remote_agent_mode(&path).as_deref(), Some("plan"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn absent_remote_preferences_do_not_override_live_chat_permissions() {
        let dir = std::env::temp_dir().join(format!("agmux-no-remote-perm-{}", uuid::Uuid::new_v4()));
        let path = dir.to_string_lossy();
        for provider in ["ClaudeCode", "Grok", "Gemini", "OpenCode", "Cursor"] {
            assert_eq!(saved_live_chat_permission(provider, &path), None, "{provider}");
        }
        write_remote_permission_mode(&path, "default");
        assert_eq!(saved_live_chat_permission("ClaudeCode", &path), Some(LiveChatPermission::Sdk("default".into())));
        write_remote_agent_mode(&path, "plan");
        assert_eq!(saved_live_chat_permission("ClaudeCode", &path), Some(LiveChatPermission::Sdk("plan".into())));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
