//! Grok ACP (Agent Client Protocol) JSON-RPC client.
//!
//! Spawns `grok --cwd <work_dir> agent stdio` as a child process and communicates
//! via line-delimited JSON-RPC 2.0 over stdin/stdout.
//!
//! Grok's stdio mode speaks the open Agent Client Protocol (ACP) standard.
//! Methods: initialize, authenticate, session/new, session/resume, session/prompt,
//! session/cancel. Notifications from agent: session/update with various
//! sessionUpdate kinds (agent_message_chunk, agent_thought_chunk, tool_call,
//! tool_call_update, plan, available_commands_update). Agent→client requests:
//! session/request_permission, fs/read_text_file, fs/write_text_file.
//!
//! One `grok agent stdio` process per agmux thread; the thread's ACP
//! sessionId maps 1:1 to its process. Per-thread keying lets each chat thread
//! carry its own spawn flags (effort/model) and client-side permission policy.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};

use crate::gemini::conversation;
use crate::gemini::event_mapper::{
    build_session_ended, build_session_init, build_tool_completed, build_turn_completed,
    client_read_from_started, content_from_fs_result, extract_prompt_usage,
    normalize_client_read_path, translate_approval_request, translate_session_update,
    PendingClientReads,
};

/// Per-thread grok process configuration.
#[derive(Debug, Clone, Default)]
pub struct GeminiSpawnConfig {
    /// Initial client-side permission policy ("default" | "acceptEdits" |
    /// "auto" | "bypassPermissions" | "plan"). NOT a spawn flag — `grok agent
    /// stdio` ignores `--permission-mode` (it is headless-only), so the gate
    /// is enforced in the `session/request_permission` handler. Runtime-mutable
    /// afterwards via `set_permission_mode` (no respawn needed).
    pub permission_mode: Option<String>,
    /// Reasoning effort, passed as `grok agent --reasoning-effort`. Spawn-time
    /// only — changing it requires a respawn. Accepts the UI effort labels;
    /// `normalize_reasoning_effort` maps them to grok's accepted values.
    pub effort: Option<String>,
    /// Model id, passed as `grok agent --model`. Defaults to `grok-4.6`
    /// (CLI default as of Grok 4.6).
    pub model: Option<String>,
}
use tauri::{Emitter, Manager};

const REQUEST_TIMEOUT_SECS: u64 = 300;

fn model_config_id(result: &Value) -> Option<String> {
    result.get("configOptions")?.as_array()?.iter()
        .find(|option| option.get("category").and_then(Value::as_str) == Some("model"))?
        .get("id")?.as_str().filter(|id| !id.is_empty()).map(str::to_string)
}

#[cfg(test)]
mod model_config_tests {
    use super::*;

    #[test]
    fn uses_advertised_model_id_instead_of_mode_or_literal_model() {
        let response = json!({"configOptions": [
            {"id":"mode", "category":"mode", "type":"select", "currentValue":"default"},
            {"id":"provider-model-picker", "category":"model", "type":"select", "currentValue":"old-model"}
        ]});
        assert_eq!(model_config_id(&response).as_deref(), Some("provider-model-picker"));
    }

    #[test]
    fn absent_or_invalid_catalog_does_not_guess_an_option_id() {
        for response in [
            json!({}),
            json!({"models":{"currentModelId":"old-model"}}),
            json!({"configOptions":[{"id":"model","category":"mode"}]}),
            json!({"configOptions":[{"id":"","category":"model"}]}),
        ] {
            assert_eq!(model_config_id(&response), None);
        }
    }
}

/// An outside-workspace `fs/` proxy request awaiting user approval. Stored
/// while the frontend shows the approval banner; the file op runs only once
/// the user allows it (see `resolve_approval`).
struct PendingFsApproval {
    /// true for `fs/write_text_file`, false for `fs/read_text_file`.
    is_write: bool,
    /// Original ACP request params (`path`, plus `content` for writes).
    params: Value,
}

/// One Grok ACP server (one `grok agent stdio` process for a workspace).
/// Hosts multiple ACP sessions (one per agmux thread).
pub struct GeminiAppServer {
    _child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<tokio::process::ChildStdin>>,
    /// id -> response sender
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    next_id: Arc<AtomicU64>,
    app_handle: tauri::AppHandle,
    is_shutting_down: Arc<std::sync::atomic::AtomicBool>,
    /// Model the process was spawned with, used to populate `turn.completed`'s
    /// modelUsage so the frontend ContextRing can size itself correctly.
    model: String,
    // Apply the launch selection once. Warm ensures must not override phone changes.
    initial_model: Mutex<Option<String>>,
    model_config_id: Mutex<Option<String>>,
    /// ACP sessionId -> agmux thread_id (for routing notifications to the
    /// frontend channel `sdk-event-{threadId}`).
    session_to_thread: Arc<Mutex<HashMap<String, String>>>,
    /// Serializes session/new + session/resume so a desktop remount cannot
    /// issue session/resume while a remote first prompt is in flight.
    session_setup: Mutex<()>,
    /// Pending agent->client approval requests: ACP request-id -> agmux thread_id.
    /// Frontend resolves via `gemini_sdk_respond_approval(threadId, requestId, ...)`.
    pending_approvals: Arc<Mutex<HashMap<u64, String>>>,
    /// ACP permission options offered with each pending `session/request_permission`,
    /// keyed by request-id. The frontend sends a simple allow/deny decision; the
    /// real `optionId` is server-defined, so it is resolved from these options.
    pending_approval_options: Arc<Mutex<HashMap<u64, Vec<Value>>>>,
    /// Outside-workspace `fs/` proxy requests gated behind a user approval,
    /// keyed by ACP request-id. Resolved via the same `gemini_sdk_respond_approval`
    /// path as ACP permissions — see `resolve_approval`.
    pending_fs_approvals: Arc<Mutex<HashMap<u64, PendingFsApproval>>>,
    /// Client-side permission policy consulted by the `session/request_permission`
    /// handler. `grok agent stdio` delegates every gated action to the client,
    /// so this — not a grok flag — is what enforces the user-selected mode.
    /// Runtime-mutable via `set_permission_mode`; no respawn on change.
    permission_mode: Arc<Mutex<String>>,
    #[allow(dead_code)]
    pub work_dir: String,
    /// ACP sessionId → project-memory preamble still to inject once on the
    /// first `session/prompt` (ACP has no append-system-prompt equivalent).
    memory_preamble_pending: Arc<Mutex<HashMap<String, String>>>,
    /// Last captured Google OAuth URL (stderr/stdout prefix).
    auth_url: Arc<Mutex<Option<String>>>,
    /// Coalesced assistant text/thinking for remote `agent_logs`.
    log_acc: Arc<Mutex<super::remote_log::GeminiLogMap>>,
    /// Match Antigravity `client_view_file` starts to `fs/read_text_file`
    /// replies so the chat UI can mark Reads done (ACP never sends a
    /// matching `tool_call_update` for those ids).
    pending_client_reads: Arc<Mutex<PendingClientReads>>,
}

impl GeminiAppServer {
    /// Spawn a new grok agent stdio process for the workspace and complete
    /// initialize + authenticate handshake. The `config` flags are applied at
    /// spawn time (grok agent stdio inherits top-level grok flags).
    pub async fn spawn(
        app_handle: tauri::AppHandle,
        work_dir: &str,
        config: &GeminiSpawnConfig,
        thread_id: &str,
    ) -> anyhow::Result<Self> {
        let (spawn_env, exe, _harness) = crate::gemini::install::stripped_spawn_env(work_dir)
            .map_err(|e| anyhow::anyhow!(e))?;

        let mut cmd = Command::new(&exe);
        cmd.current_dir(work_dir)
            .env_clear()
            .envs(spawn_env)
            .env("NO_COLOR", "1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            anyhow::anyhow!("Failed to spawn Antigravity ACP server: {}", e)
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("Failed to capture grok stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("Failed to capture grok stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow::anyhow!("Failed to capture grok stderr"))?;

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let is_shutting_down = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let session_to_thread: Arc<Mutex<HashMap<String, String>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_approvals: Arc<Mutex<HashMap<u64, String>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_approval_options: Arc<Mutex<HashMap<u64, Vec<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_fs_approvals: Arc<Mutex<HashMap<u64, PendingFsApproval>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let permission_mode = Arc::new(Mutex::new(
            config
                .permission_mode
                .clone()
                .unwrap_or_else(|| "default".to_string()),
        ));
        let stdin_arc = Arc::new(Mutex::new(stdin));
        let auth_url: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let log_acc: Arc<Mutex<super::remote_log::GeminiLogMap>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_client_reads: Arc<Mutex<PendingClientReads>> =
            Arc::new(Mutex::new(PendingClientReads::default()));

        let server = Self {
            _child: Arc::new(Mutex::new(child)),
            stdin: stdin_arc.clone(),
            pending: pending.clone(),
            next_id: Arc::new(AtomicU64::new(1)),
            app_handle: app_handle.clone(),
            is_shutting_down: is_shutting_down.clone(),
            session_to_thread: session_to_thread.clone(),
            session_setup: Mutex::new(()),
            pending_approvals: pending_approvals.clone(),
            pending_approval_options: pending_approval_options.clone(),
            pending_fs_approvals: pending_fs_approvals.clone(),
            permission_mode: permission_mode.clone(),
            model: config
                .model
                .clone()
                .unwrap_or_else(|| "gemini-3.8-flash-high".to_string()),
            initial_model: Mutex::new(config.model.clone().filter(|model| !model.is_empty())),
            model_config_id: Mutex::new(None),
            work_dir: work_dir.to_string(),
            memory_preamble_pending: Arc::new(Mutex::new(HashMap::new())),
            auth_url: auth_url.clone(),
            log_acc: log_acc.clone(),
            pending_client_reads: pending_client_reads.clone(),
        };

        let shutdown_clone_err = is_shutting_down.clone();
        let auth_url_err = auth_url.clone();
        let app_for_auth = app_handle.clone();
        let thread_id_for_auth = thread_id.to_string();
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if shutdown_clone_err.load(Ordering::Relaxed) {
                    break;
                }
                note_auth_url(&line, &auth_url_err, &app_for_auth, &thread_id_for_auth).await;
                tracing::debug!("[gemini-stderr] {}", line);
            }
        });

        // stdout read loop.
        let pending_clone = pending.clone();
        let app_handle_clone = app_handle.clone();
        let shutdown_clone = is_shutting_down.clone();
        let session_to_thread_clone = session_to_thread.clone();
        let pending_approvals_clone = pending_approvals.clone();
        let pending_approval_options_clone = pending_approval_options.clone();
        let pending_fs_approvals_clone = pending_fs_approvals.clone();
        let permission_mode_clone = permission_mode.clone();
        let stdin_for_loop = stdin_arc.clone();
        // Workspace root used to scope grok's `fs/*` proxy requests.
        let work_dir_for_loop = work_dir.to_string();
        let auth_url_out = auth_url.clone();
        let app_for_auth_out = app_handle.clone();
        let thread_id_for_auth_out = thread_id.to_string();
        let log_acc_clone = log_acc.clone();
        let pending_reads_clone = pending_client_reads.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            let mut diff_tracker = super::diff_tracker::DiffTracker::default();

            while let Ok(Some(line)) = lines.next_line().await {
                if shutdown_clone.load(Ordering::Relaxed) {
                    break;
                }
                if line.trim().is_empty() {
                    continue;
                }
                if note_auth_url(
                    &line,
                    &auth_url_out,
                    &app_for_auth_out,
                    &thread_id_for_auth_out,
                )
                .await
                {
                    continue;
                }
                let value: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!(
                            "[gemini] failed to parse stdout line: {} - {}",
                            e,
                            crate::text::byte_prefix(&line, 200)
                        );
                        continue;
                    }
                };

                let maybe_id = value.get("id").and_then(|id| id.as_u64());
                let has_result = value.get("result").is_some();
                let has_error = value.get("error").is_some();

                // ── responses to our outgoing requests ──
                if let Some(id) = maybe_id {
                    if has_result || has_error {
                        let mut pending = pending_clone.lock().await;
                        if let Some(tx) = pending.remove(&id) {
                            let _ = tx.send(value);
                        }
                        continue;
                    }
                }

                let method = value.get("method").and_then(|m| m.as_str());

                // ── agent → client requests (have id but no result/error) ──
                if let (Some(id), Some(m)) = (maybe_id, method) {
                    match m {
                        "session/request_permission" => {
                            // ACP delegates every gated action to the client.
                            // Consult the thread's client-side permission
                            // policy: auto-allow / auto-deny on the wire, or
                            // route to the frontend approval banner when the
                            // policy says to ask the user.
                            let params =
                                value.get("params").cloned().unwrap_or(Value::Null);
                            let session_id = params
                                .get("sessionId")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            let thread_id = if let Some(ref sid) = session_id {
                                session_to_thread_clone.lock().await.get(sid).cloned()
                            } else {
                                None
                            };
                            let kind = params
                                .get("toolCall")
                                .and_then(|t| t.get("kind"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let options = params
                                .get("options")
                                .and_then(|o| o.as_array())
                                .cloned()
                                .unwrap_or_default();
                            let mode = permission_mode_clone.lock().await.clone();
                            let decision = decide_permission(&mode, kind);
                            if thread_id.is_none() {
                                // No thread mapping — fall through to a wire
                                // reply so grok doesn't hang on a dead session.
                                tracing::warn!(
                                    "[gemini] session/request_permission for unknown session {:?}; resolving on the wire",
                                    session_id
                                );
                            }

                            match (decision, thread_id) {
                                (PermissionDecision::Ask, Some(tid)) => {
                                    // Cache options so resolve_approval can map
                                    // the frontend's allow/deny into a real
                                    // server-defined optionId.
                                    pending_approvals_clone
                                        .lock()
                                        .await
                                        .insert(id, tid.clone());
                                    pending_approval_options_clone
                                        .lock()
                                        .await
                                        .insert(id, options);
                                    let event =
                                        translate_approval_request(id, &params);
                                    let channel = format!("sdk-event-{}", tid);
                                    let _ = app_handle_clone.emit(&channel, &event);
                                    crate::remote::notify_approval(
                                        &app_handle_clone,
                                        &tid,
                                        &id.to_string(),
                                        event
                                            .get("toolName")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("tool"),
                                        event
                                            .get("detail")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or(""),
                                    );
                                }
                                (decision, _) => {
                                    // Allow / Deny — or Ask with no thread —
                                    // resolve immediately on the wire.
                                    let outcome = match decision {
                                        PermissionDecision::Allow => {
                                            match pick_allow_option(&options, false) {
                                                Some(opt) => json!({
                                                    "outcome": "selected",
                                                    "optionId": opt
                                                }),
                                                None => json!({"outcome": "cancelled"}),
                                            }
                                        }
                                        PermissionDecision::Deny => {
                                            // Prefer a reject option so grok
                                            // treats it as guidance and keeps
                                            // planning, rather than aborting.
                                            match pick_reject_option(&options) {
                                                Some(opt) => json!({
                                                    "outcome": "selected",
                                                    "optionId": opt
                                                }),
                                                None => json!({"outcome": "cancelled"}),
                                            }
                                        }
                                        PermissionDecision::Ask => {
                                            json!({"outcome": "cancelled"})
                                        }
                                    };
                                    let body = json!({
                                        "jsonrpc": "2.0",
                                        "id": id,
                                        "result": { "outcome": outcome }
                                    });
                                    let mut s = serde_json::to_string(&body)
                                        .unwrap_or_default();
                                    s.push('\n');
                                    let mut guard = stdin_for_loop.lock().await;
                                    let _ = guard.write_all(s.as_bytes()).await;
                                    let _ = guard.flush().await;
                                }
                            }
                            continue;
                        }
                        "fs/read_text_file" | "fs/write_text_file" => {
                            // Proxy filesystem access. Paths inside the spawn
                            // workspace are served directly; paths OUTSIDE it
                            // are gated behind a user approval so a buggy or
                            // prompt-injected agent can't read/write anywhere
                            // unprompted.
                            let params = value.get("params").cloned().unwrap_or(Value::Null);
                            let is_write = m == "fs/write_text_file";
                            let path = params
                                .get("path")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            // An empty path is handled inline (errors cleanly);
                            // a resolvable in-workspace path needs no prompt.
                            let within = path.is_empty()
                                || resolve_within(&work_dir_for_loop, &path).is_ok();
                            if within {
                                let result = if is_write {
                                    handle_fs_write(&params, &work_dir_for_loop)
                                } else {
                                    handle_fs_read(&params, &work_dir_for_loop)
                                };
                                let body = match &result {
                                    Ok(v) => json!({"jsonrpc":"2.0","id":id,"result":v}),
                                    Err(e) => json!({
                                        "jsonrpc":"2.0","id":id,
                                        "error":{"code":-32603,"message":e}
                                    }),
                                };
                                let mut s = serde_json::to_string(&body).unwrap_or_default();
                                s.push('\n');
                                let mut guard = stdin_for_loop.lock().await;
                                let _ = guard.write_all(s.as_bytes()).await;
                                let _ = guard.flush().await;
                                if !is_write {
                                    let session_id = params
                                        .get("sessionId")
                                        .and_then(|v| v.as_str());
                                    let thread_id = if let Some(sid) = session_id {
                                        session_to_thread_clone.lock().await.get(sid).cloned()
                                    } else {
                                        None
                                    };
                                    maybe_complete_client_read(
                                        &pending_reads_clone,
                                        &app_handle_clone,
                                        &log_acc_clone,
                                        thread_id.as_deref(),
                                        &work_dir_for_loop,
                                        &path,
                                        &result,
                                    )
                                    .await;
                                }
                                continue;
                            }
                            // Outside the workspace — route to the frontend
                            // approval banner. The JSON-RPC reply is sent later
                            // from gemini_sdk_respond_approval -> resolve_approval.
                            let session_id = params
                                .get("sessionId")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            let thread_id = if let Some(ref sid) = session_id {
                                session_to_thread_clone.lock().await.get(sid).cloned()
                            } else {
                                None
                            };
                            if let Some(tid) = thread_id {
                                pending_fs_approvals_clone.lock().await.insert(
                                    id,
                                    PendingFsApproval {
                                        is_write,
                                        params: params.clone(),
                                    },
                                );
                                let tool_name = if is_write { "Write File" } else { "Read File" };
                                let event = json!({
                                    "type": "approval.requested",
                                    "requestId": id.to_string(),
                                    "toolName": tool_name,
                                    "detail": path,
                                    "requestType": if is_write { "file_change" } else { "file_read" },
                                });
                                let channel = format!("sdk-event-{}", tid);
                                let _ = app_handle_clone.emit(&channel, &event);
                                crate::remote::notify_approval(
                                    &app_handle_clone,
                                    &tid,
                                    &id.to_string(),
                                    tool_name,
                                    &path,
                                );
                            } else {
                                // No thread mapping — fall back to hard-deny so
                                // grok doesn't hang waiting for a reply.
                                tracing::warn!(
                                    "[gemini] fs/* for unknown session {:?}; denying",
                                    session_id
                                );
                                let body = json!({
                                    "jsonrpc":"2.0","id":id,
                                    "error":{"code":-32603,"message":"path outside workspace"}
                                });
                                let mut s = serde_json::to_string(&body).unwrap_or_default();
                                s.push('\n');
                                let mut guard = stdin_for_loop.lock().await;
                                let _ = guard.write_all(s.as_bytes()).await;
                                let _ = guard.flush().await;
                            }
                            continue;
                        }
                        _ => {
                            // Unknown agent->client request — reply with method-not-found.
                            tracing::warn!("[gemini] unknown agent->client request: {}", m);
                            let body = json!({
                                "jsonrpc":"2.0","id":id,
                                "error":{"code":-32601,"message":"Method not found"}
                            });
                            let mut s = serde_json::to_string(&body).unwrap_or_default();
                            s.push('\n');
                            let mut guard = stdin_for_loop.lock().await;
                            let _ = guard.write_all(s.as_bytes()).await;
                            let _ = guard.flush().await;
                            continue;
                        }
                    }
                }

                // ── notifications ──
                if method.is_some() {
                    // session/update is the main stream of agent activity.
                    let session_id = value
                        .get("params")
                        .and_then(|p| p.get("sessionId"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let thread_id = if let Some(ref sid) = session_id {
                        session_to_thread_clone.lock().await.get(sid).cloned()
                    } else {
                        None
                    };

                    if let Some(tid) = thread_id {
                        if let Some(translated) = translate_session_update(&value, &tid) {
                            crate::shell_diff::observe_sdk(&app_handle_clone, &tid, &translated).await;
                            if let Some((added, removed, files)) =
                                diff_tracker.process(&translated, &work_dir_for_loop).await
                            {
                                let state = app_handle_clone.state::<crate::state::AppState>();
                                if let Err(e) = crate::diff_stats::record_thread_diff_delta(
                                    &app_handle_clone, &state.db, &tid, added, removed, files,
                                ).await {
                                    tracing::warn!(thread_id = %tid, error = %e, "Gemini diff stats update failed");
                                }
                            }
                            let channel = format!("sdk-event-{}", tid);
                            let _ = app_handle_clone.emit(&channel, &translated);
                            let state = app_handle_clone.state::<crate::state::AppState>();
                            super::remote_log::persist_event(
                                &state.db,
                                &log_acc_clone,
                                &tid,
                                &translated,
                            )
                            .await;
                            if let Some((tool_id, read_path)) =
                                client_read_from_started(&translated)
                            {
                                let norm = normalize_client_read_path(
                                    &read_path,
                                    &work_dir_for_loop,
                                );
                                if let Some(served) = pending_reads_clone
                                    .lock()
                                    .await
                                    .note_started(&tool_id, &norm)
                                {
                                    let event = build_tool_completed(
                                        &tool_id,
                                        &served.content,
                                        served.is_error,
                                    );
                                    emit_sdk_event(
                                        &app_handle_clone,
                                        &log_acc_clone,
                                        &tid,
                                        &event,
                                    )
                                    .await;
                                }
                            } else if translated
                                .get("type")
                                .and_then(|v| v.as_str())
                                == Some("tool.completed")
                            {
                                if let Some(id) = translated
                                    .get("toolUseId")
                                    .and_then(|v| v.as_str())
                                {
                                    pending_reads_clone.lock().await.note_completed(id);
                                }
                            }
                        }
                    } else {
                        // Either a global notification (no sessionId) or a session
                        // we don't track. Vendor `_x.ai/*` extension notifications
                        // are silently filtered for v1.
                    }
                    continue;
                }

                tracing::debug!("[gemini] unhandled stdout line: {}", line);
            }

            // Read loop ended (grok disconnected, or graceful shutdown).
            // Resolve every pending request channel so callers don't hang —
            // unconditionally, since an untimed `session/prompt` would
            // otherwise wait forever when the process goes away.
            {
                let mut pending = pending_clone.lock().await;
                let ids: Vec<u64> = pending.keys().cloned().collect();
                for id in ids {
                    if let Some(tx) = pending.remove(&id) {
                        let _ = tx.send(json!({
                            "id": id,
                            "error": {"message": "grok agent disconnected"}
                        }));
                    }
                }
            }
            if !shutdown_clone.load(Ordering::Relaxed) {
                tracing::warn!("[gemini] read loop ended unexpectedly");
                // Emit a session.ended event to every known thread so spinners clear.
                let map = session_to_thread_clone.lock().await;
                let seen: HashSet<String> = map.values().cloned().collect();
                for tid in seen {
                    let event = build_session_ended("error");
                    crate::shell_diff::observe_sdk(&app_handle_clone, &tid, &event).await;
                    let channel = format!("sdk-event-{}", tid);
                    let _ = app_handle_clone.emit(&channel, &event);
                    crate::remote::notify_thread_requests_cleared(&app_handle_clone, &tid);
                }
            }
        });

        server.initialize().await?;
        if crate::gemini::install::is_signed_in() {
            // Cached Google login — a hung untimed authenticate leaves the
            // composer on "Starting session…" forever. Bound it; session/new
            // can still succeed with the on-disk token.
            if let Err(e) = server
                .send_request_inner(
                    "authenticate",
                    json!({"methodId": "oauth-personal"}),
                    Some(std::time::Duration::from_secs(15)),
                )
                .await
            {
                tracing::warn!("[gemini] authenticate failed: {e}");
            }
        } else if let Err(e) = server.authenticate_personal().await {
            // First-run OAuth is untimed; the ACP server prints a Google URL
            // on stderr/stdout and we open it. Fail spawn if that handshake
            // errors so session/new does not sit on a 300s timeout instead.
            return Err(e);
        }

        Ok(server)
    }

    /// Send a JSON-RPC request and wait for the response, bounded by
    /// `REQUEST_TIMEOUT_SECS`. Use for control requests (handshake, session
    /// lifecycle) that are expected to resolve quickly.
    pub async fn send_request(&self, method: &str, params: Value) -> anyhow::Result<Value> {
        self.send_request_inner(
            method,
            params,
            Some(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS)),
        )
        .await
    }

    /// Like `send_request` but with NO timeout. Used for `session/prompt`,
    /// whose turn duration is unbounded — a long agentic turn easily exceeds
    /// the 5-minute control timeout, and a spurious timeout there means
    /// `turn.completed` never fires, leaving the UI's turn lifecycle desynced
    /// (stuck "running" sidebar / prematurely cleared indicator). Grok process
    /// death is still handled: the stdout read loop resolves every pending
    /// channel with an error on disconnect, so this can't hang forever.
    pub async fn send_request_untimed(
        &self,
        method: &str,
        params: Value,
    ) -> anyhow::Result<Value> {
        self.send_request_inner(method, params, None).await
    }

    async fn send_request_inner(
        &self,
        method: &str,
        params: Value,
        timeout: Option<std::time::Duration>,
    ) -> anyhow::Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.insert(id, tx);
        }
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&request)?;
        line.push('\n');
        {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await?;
        }

        let response = match timeout {
            Some(dur) => tokio::time::timeout(dur, rx)
                .await
                .map_err(|_| {
                    let pending = self.pending.clone();
                    tokio::spawn(async move {
                        pending.lock().await.remove(&id);
                    });
                    anyhow::anyhow!("grok request timed out: {}", method)
                })?
                .map_err(|_| {
                    anyhow::anyhow!("grok response channel closed for: {}", method)
                })?,
            None => rx
                .await
                .map_err(|_| anyhow::anyhow!("grok response channel closed for: {}", method))?,
        };

        if let Some(err) = response.get("error") {
            let msg = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("Unknown error");
            return Err(anyhow::anyhow!("grok RPC error ({}): {}", method, msg));
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    /// Send a JSON-RPC notification (no id, no response awaited). ACP
    /// `session/cancel` is a notification — sending it as a request makes grok
    /// reply "Method not found", so cancellation must go through this path.
    async fn send_notification(&self, method: &str, params: Value) -> anyhow::Result<()> {
        let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let mut line = serde_json::to_string(&msg)?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    async fn initialize(&self) -> anyhow::Result<()> {
        let result = self
            .send_request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": {"readTextFile": true, "writeTextFile": true}
                    },
                    "clientInfo": {"name": "xanom", "version": "1"}
                }),
            )
            .await?;
        tracing::info!(
            "[gemini] initialized — agentCapabilities={:?}",
            result.get("agentCapabilities")
        );
        Ok(())
    }

    pub async fn authenticate_personal(&self) -> anyhow::Result<()> {
        let _ = self
            .send_request_untimed("authenticate", json!({"methodId": "oauth-personal"}))
            .await?;
        Ok(())
    }

    pub async fn take_auth_url(&self) -> Option<String> {
        self.auth_url.lock().await.clone()
    }

    pub async fn native_logout(&self) -> anyhow::Result<()> {
        let _ = self
            .send_request("logout", json!({}))
            .await;
        Ok(())
    }

    /// ACP session already mapped to this agmux thread, if any.
    pub async fn session_id_for_thread(&self, thread_id: &str) -> Option<String> {
        let map = self.session_to_thread.lock().await;
        acp_session_id_for_thread(&map, thread_id)
    }

    /// Hold while creating or resuming an ACP session so concurrent
    /// `gemini_sdk_ensure_server` callers (desktop mount + remote send) share
    /// one session instead of racing `session/new` / `session/resume`.
    pub async fn session_setup_lock(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.session_setup.lock().await
    }

    /// Create a new ACP session and register the thread mapping.
    ///
    /// `mcp_servers` is the ACP array form (name/command/args/env). Empty
    /// means no extra MCP servers beyond whatever grok loads by default.
    pub async fn new_session(
        &self,
        thread_id: &str,
        cwd: &str,
        mcp_servers: Vec<Value>,
        memory_instructions: Option<String>,
        system_prompt_override: Option<String>,
    ) -> anyhow::Result<String> {
        let mut params = json!({
            "cwd": cwd,
            "mcpServers": mcp_servers,
        });
        if let Some(prompt) = system_prompt_override.filter(|s| !s.trim().is_empty()) {
            params["_meta"] = json!({ "systemPromptOverride": prompt });
        }
        let result = self
            .send_request("session/new", params)
            .await?;
        let session_id = result
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("session/new missing sessionId"))?
            .to_string();
        *self.model_config_id.lock().await = model_config_id(&result);
        self.session_to_thread
            .lock()
            .await
            .insert(session_id.clone(), thread_id.to_string());
        if let Some(instr) = memory_instructions.filter(|s| !s.trim().is_empty()) {
            self.memory_preamble_pending
                .lock()
                .await
                .insert(session_id.clone(), instr);
        }
        // Emit session.init so ClaudeSdkSessionView flips from starting → running.
        let channel = format!("sdk-event-{}", thread_id);
        let _ = self
            .app_handle
            .emit(&channel, &build_session_init(&session_id));
        Ok(session_id)
    }

    /// Resume a previously created ACP session.
    pub async fn load_session(
        &self,
        thread_id: &str,
        session_id: &str,
        cwd: &str,
        mcp_servers: Vec<Value>,
        memory_instructions: Option<String>,
        system_prompt_override: Option<String>,
    ) -> anyhow::Result<()> {
        let mut params = json!({
            "sessionId": session_id,
            "cwd": cwd,
            "mcpServers": mcp_servers,
        });
        if let Some(prompt) = system_prompt_override.filter(|s| !s.trim().is_empty()) {
            params["_meta"] = json!({ "systemPromptOverride": prompt });
        }
        let result = self.send_request("session/resume", params).await?;
        *self.model_config_id.lock().await = model_config_id(&result);
        self.session_to_thread
            .lock()
            .await
            .insert(session_id.to_string(), thread_id.to_string());
        // On resume, re-inject once so the model sees memory policy after reload.
        if let Some(instr) = memory_instructions.filter(|s| !s.trim().is_empty()) {
            self.memory_preamble_pending
                .lock()
                .await
                .insert(session_id.to_string(), instr);
        }
        Ok(())
    }

    pub async fn configure_initial_model(&self, session_id: &str) -> anyhow::Result<()> {
        let mut initial = self.initial_model.lock().await;
        let Some(model) = initial.as_deref() else { return Ok(()) };
        let id = self.model_config_id.lock().await.clone()
            .ok_or_else(|| anyhow::anyhow!("Gemini did not advertise a model configuration option"))?;
        self.set_config_option(session_id, &id, model).await?;
        *initial = None;
        Ok(())
    }

    pub async fn set_config_option(
        &self,
        session_id: &str,
        id: &str,
        value: &str,
    ) -> anyhow::Result<Value> {
        self.send_request(
            "session/set_config_option",
            json!({
                "sessionId": session_id,
                "configId": id,
                "value": value,
            }),
        )
        .await
    }

    pub async fn send_prompt_blocks(
        &self,
        session_id: &str,
        text: &str,
        images: Vec<crate::commands::gemini_sdk::GeminiPromptImage>,
    ) -> anyhow::Result<Value> {
        let mut prompt: Vec<Value> = Vec::new();
        if !text.is_empty() {
            prompt.push(json!({"type": "text", "text": text}));
        }
        for img in images {
            let mime = img.media_type.to_lowercase();
            if !(mime == "image/jpeg"
                || mime == "image/png"
                || mime == "image/webp"
                || mime == "image/bmp")
            {
                continue;
            }
            prompt.push(json!({
                "type": "image",
                "data": img.data,
                "mimeType": img.media_type,
            }));
        }
        if prompt.is_empty() {
            anyhow::bail!("A turn requires text or supported attachments.");
        }
        let mut result = self
            .send_request_untimed(
                "session/prompt",
                json!({
                    "sessionId": session_id,
                    "prompt": prompt,
                }),
            )
            .await?;
        attach_disk_usage(session_id, &mut result).await;
        let stop_reason = result
            .get("stopReason")
            .and_then(|v| v.as_str())
            .unwrap_or("EndTurn")
            .to_string();
        if let Some(thread_id) = self
            .session_to_thread
            .lock()
            .await
            .get(session_id)
            .cloned()
        {
            let channel = format!("sdk-event-{}", thread_id);
            let event = build_turn_completed(
                session_id,
                &stop_reason,
                &self.model,
                Some(&result),
            );
            crate::shell_diff::observe_sdk(&self.app_handle, &thread_id, &event).await;
            let _ = self.app_handle.emit(&channel, &event);
            // session/prompt only returns once its permission requests are settled.
            crate::remote::notify_thread_requests_cleared(&self.app_handle, &thread_id);
            let state = self.app_handle.state::<crate::state::AppState>();
            super::remote_log::flush_thread(&state.db, &self.log_acc, &thread_id).await;
        }
        Ok(result)
    }

    pub async fn send_prompt(&self, session_id: &str, text: &str) -> anyhow::Result<Value> {
        // Inject project-memory instructions once per ACP session (first turn).
        // `instr` is already a full first-turn preamble from `first_turn_memory_preamble`.
        // Join with a unique delimiter so history UI can strip the preamble and
        // only show the real user turn (ACP has no separate system prompt).
        let prompt_text = {
            let mut pending = self.memory_preamble_pending.lock().await;
            if let Some(instr) = pending.remove(session_id) {
                crate::memory::join_first_turn_prompt(&instr, text)
            } else {
                text.to_string()
            }
        };
        // No timeout: a turn runs as long as the agent needs. A spurious
        // timeout here would skip the `turn.completed` emit below.
        let mut result = self
            .send_request_untimed(
                "session/prompt",
                json!({
                    "sessionId": session_id,
                    "prompt": [{"type": "text", "text": prompt_text}]
                }),
            )
            .await?;
        attach_disk_usage(session_id, &mut result).await;
        let stop_reason = result
            .get("stopReason")
            .and_then(|v| v.as_str())
            .unwrap_or("EndTurn")
            .to_string();
        if let Some(thread_id) = self
            .session_to_thread
            .lock()
            .await
            .get(session_id)
            .cloned()
        {
            let channel = format!("sdk-event-{}", thread_id);
            let event = build_turn_completed(
                session_id,
                &stop_reason,
                &self.model,
                Some(&result),
            );
            crate::shell_diff::observe_sdk(&self.app_handle, &thread_id, &event).await;
            let _ = self.app_handle.emit(&channel, &event);
            // session/prompt only returns once its permission requests are settled.
            crate::remote::notify_thread_requests_cleared(&self.app_handle, &thread_id);
            let state = self.app_handle.state::<crate::state::AppState>();
            super::remote_log::flush_thread(&state.db, &self.log_acc, &thread_id).await;
        }
        Ok(result)
    }

    /// Cancel an in-flight turn. ACP `session/cancel` is a *notification* —
    /// grok then resolves the still-pending `session/prompt` request with
    /// `stopReason: "cancelled"`, which fires the normal `turn.completed`
    /// emit in `send_prompt`. (Sent as a request it replies "Method not
    /// found" and the turn keeps running.)
    pub async fn cancel(&self, session_id: &str) -> anyhow::Result<()> {
        self.send_notification("session/cancel", json!({ "sessionId": session_id }))
            .await
    }
}

/// agy_acp_server returns PromptResponse { stopReason } with no usage.
/// Fill it from the on-disk conversation DB so the context ring is not 0.
async fn attach_disk_usage(session_id: &str, result: &mut Value) {
    attach_disk_usage_from_db(&conversation::conversation_db_path(session_id), result).await;
}

async fn attach_disk_usage_from_db(path: &std::path::Path, result: &mut Value) {
    let (input, output, cache_read, cache_write) = extract_prompt_usage(Some(result));
    if input + output + cache_read + cache_write > 0 {
        return;
    }
    let Some(usage) = conversation::latest_usage_from_db(path).await else {
        return;
    };
    result["usage"] = json!({
        "inputTokens": usage.prompt_tokens,
        // Native output already includes thought tokens; keep the breakdown
        // separately without charging it again downstream.
        "outputTokens": usage.output_tokens,
        "cacheReadTokens": usage.cache_tokens,
        "cacheCreationTokens": 0,
        "thoughtTokens": usage.thought_tokens,
    });
}

#[cfg(test)]
mod disk_usage_tests {
    use super::*;
    use sqlx::Connection;

    #[tokio::test]
    async fn disk_output_stays_inclusive_through_turn_completed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("conversation.db");
        let opts = sqlx::sqlite::SqliteConnectOptions::new().filename(&path).create_if_missing(true);
        let mut db = sqlx::SqliteConnection::connect_with(&opts).await.unwrap();
        sqlx::query("CREATE TABLE steps(idx INTEGER, metadata BLOB)").execute(&mut db).await.unwrap();
        // Sanitized live wire fields: prompt 9406, inclusive output 176,
        // cache 50, thought 110, visible 66 (176 = 110 + 66).
        let meta = vec![0x4a_u8, 12, 0x10, 0xbe, 0x49, 0x18, 0xb0, 1, 0x28, 50, 0x48, 110, 0x50, 66];
        sqlx::query("INSERT INTO steps VALUES(1, ?)").bind(meta).execute(&mut db).await.unwrap();
        let mut result = json!({"stopReason":"end_turn"});
        attach_disk_usage_from_db(&path, &mut result).await;
        assert_eq!(result["usage"]["outputTokens"], 176);
        assert_eq!(result["usage"]["thoughtTokens"], 110);
        assert_eq!(extract_prompt_usage(Some(&result)), (9406, 176, 50, 0));
        let event = build_turn_completed("s", "end_turn", "gemini", Some(&result));
        assert_eq!(event["usage"]["outputTokens"], 176);
        let original = result.clone();
        attach_disk_usage_from_db(&path, &mut result).await;
        assert_eq!(result, original);

        let mut reported = json!({"usage":{"inputTokens":1,"outputTokens":2,"thoughtTokens":1}});
        let original = reported.clone();
        attach_disk_usage_from_db(&path, &mut reported).await;
        assert_eq!(reported, original, "reported usage takes precedence over disk");
        let mut missing = json!({"stopReason":"cancelled"});
        attach_disk_usage_from_db(&dir.path().join("missing.db"), &mut missing).await;
        assert_eq!(missing, json!({"stopReason":"cancelled"}));
    }
}

impl GeminiAppServer {
    /// Update the client-side permission policy at runtime. Unlike effort and
    /// model, this needs no respawn — the next `session/request_permission`
    /// the read loop handles sees the new mode.
    pub async fn set_permission_mode(&self, mode: String) {
        *self.permission_mode.lock().await = mode;
    }

    /// Current client-side permission mode, so an effort respawn can preserve
    /// it (effort is a spawn flag; the permission policy is runtime state).
    pub async fn permission_mode_value(&self) -> String {
        self.permission_mode.lock().await.clone()
    }

    /// Respond to a pending agent->client request (e.g., approval).
    pub async fn respond_to_request(
        &self,
        request_id: u64,
        result: Value,
    ) -> anyhow::Result<()> {
        let response = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": result,
        });
        let mut s = serde_json::to_string(&response)?;
        s.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(s.as_bytes()).await?;
        stdin.flush().await?;
        // Clean up pending-approval tracking.
        self.pending_approvals.lock().await.remove(&request_id);
        self.pending_approval_options
            .lock()
            .await
            .remove(&request_id);
        Ok(())
    }

    /// Resolve a frontend approval decision. Handles two kinds of pending
    /// request, both surfaced to the UI as `approval.requested`:
    ///
    /// 1. An outside-workspace `fs/` proxy request — on allow the file op runs
    ///    and the file content/error is returned to grok; on deny grok gets an
    ///    error. (This branch.)
    /// 2. An ACP `session/request_permission` — `decision` ("allow" |
    ///    "allowProject" | "deny") is mapped to a server-defined `optionId`.
    pub async fn resolve_approval(&self, request_id: u64, decision: &str) -> anyhow::Result<()> {
        // ── fs/* proxy approval ──
        if let Some(fs) = self.pending_fs_approvals.lock().await.remove(&request_id) {
            let result = if decision == "deny" {
                Err("file access denied by user".to_string())
            } else if fs.is_write {
                handle_fs_write_unscoped(&fs.params)
            } else {
                handle_fs_read_unscoped(&fs.params)
            };
            let body = match &result {
                Ok(v) => json!({"jsonrpc": "2.0", "id": request_id, "result": v}),
                Err(e) => json!({
                    "jsonrpc": "2.0", "id": request_id,
                    "error": {"code": -32603, "message": e}
                }),
            };
            let mut s = serde_json::to_string(&body)?;
            s.push('\n');
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(s.as_bytes()).await?;
            stdin.flush().await?;
            if !fs.is_write {
                let path = fs
                    .params
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let tid = if let Some(sid) = fs.params.get("sessionId").and_then(|v| v.as_str()) {
                    self.session_to_thread.lock().await.get(sid).cloned()
                } else {
                    None
                };
                maybe_complete_client_read(
                    &self.pending_client_reads,
                    &self.app_handle,
                    &self.log_acc,
                    tid.as_deref(),
                    &self.work_dir,
                    path,
                    &result,
                )
                .await;
            }
            return Ok(());
        }

        // ── ACP session/request_permission approval ──
        let options = self
            .pending_approval_options
            .lock()
            .await
            .get(&request_id)
            .cloned()
            .unwrap_or_default();

        let outcome = if decision == "deny" {
            json!({ "outcome": "cancelled" })
        } else {
            let prefer_always = decision == "allowProject" || decision == "allowAlways";
            match pick_allow_option(&options, prefer_always) {
                Some(option_id) => json!({ "outcome": "selected", "optionId": option_id }),
                None => {
                    tracing::warn!(
                        "[gemini] approval {} offered no allow option among {} option(s); cancelling",
                        request_id,
                        options.len()
                    );
                    json!({ "outcome": "cancelled" })
                }
            }
        };
        self.respond_to_request(request_id, json!({ "outcome": outcome }))
            .await
    }

    /// Look up the thread for an in-flight approval request.
    #[allow(dead_code)]
    pub async fn thread_for_approval(&self, request_id: u64) -> Option<String> {
        self.pending_approvals.lock().await.get(&request_id).cloned()
    }

    pub async fn shutdown(&self) {
        self.is_shutting_down.store(true, Ordering::Relaxed);
        let mut child = self._child.lock().await;
        let _ = child.kill().await;
    }
}

impl Drop for GeminiAppServer {
    /// Best-effort synchronous teardown. `Drop` can't be async, so we mark the
    /// server shutting-down (read loops exit quietly) and `start_kill` the
    /// child without awaiting. This is the safety net for any server dropped
    /// without an explicit `shutdown()` — notably a redundant process from a
    /// lost spawn race in `grok_sdk::ensure_grok_server`.
    fn drop(&mut self) {
        self.is_shutting_down.store(true, Ordering::Relaxed);
        if let Ok(mut child) = self._child.try_lock() {
            let _ = child.start_kill();
        }
    }
}

/// Resolve `requested` against the spawn `work_dir` and confirm it stays
/// inside that workspace. Rejects absolute paths outside the workspace,
/// `..` components, and symlinked-directory escapes (the deepest existing
/// ancestor is canonicalized). Trailing not-yet-created components (a new
/// file or directory) are permitted.
async fn emit_sdk_event(
    app: &tauri::AppHandle,
    log_acc: &Mutex<super::remote_log::GeminiLogMap>,
    thread_id: &str,
    event: &Value,
) {
    let channel = format!("sdk-event-{}", thread_id);
    crate::shell_diff::observe_sdk(app, thread_id, event).await;
    let _ = app.emit(&channel, event);
    let state = app.state::<crate::state::AppState>();
    super::remote_log::persist_event(&state.db, log_acc, thread_id, event).await;
}

async fn maybe_complete_client_read(
    pending: &Mutex<PendingClientReads>,
    app: &tauri::AppHandle,
    log_acc: &Mutex<super::remote_log::GeminiLogMap>,
    thread_id: Option<&str>,
    work_dir: &str,
    path: &str,
    result: &Result<Value, String>,
) {
    let (content, is_error) = content_from_fs_result(result);
    let norm = normalize_client_read_path(path, work_dir);
    let Some(tool_id) = pending.lock().await.note_fs_read(&norm, content.clone(), is_error) else {
        return;
    };
    let Some(tid) = thread_id else { return };
    let event = build_tool_completed(&tool_id, &content, is_error);
    emit_sdk_event(app, log_acc, tid, &event).await;
}

fn resolve_within(work_dir: &str, requested: &str) -> Result<std::path::PathBuf, String> {
    let root = std::fs::canonicalize(work_dir)
        .map_err(|e| format!("workspace root unavailable: {}", e))?;
    let req = std::path::Path::new(requested);
    if req
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("path must not contain '..'".to_string());
    }
    let abs = if req.is_absolute() {
        req.to_path_buf()
    } else {
        root.join(req)
    };
    // Canonicalize the deepest existing ancestor (resolving symlinks), then
    // re-append any trailing components that don't exist yet.
    let mut existing: &std::path::Path = &abs;
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let canonical_existing = loop {
        match std::fs::canonicalize(existing) {
            Ok(c) => break c,
            Err(_) => {
                let name = existing
                    .file_name()
                    .ok_or_else(|| "path outside workspace".to_string())?;
                tail.push(name.to_os_string());
                existing = existing
                    .parent()
                    .ok_or_else(|| "path outside workspace".to_string())?;
            }
        }
    };
    let mut resolved = canonical_existing;
    for name in tail.iter().rev() {
        resolved.push(name);
    }
    if !resolved.starts_with(&root) {
        return Err("path outside workspace".to_string());
    }
    Ok(resolved)
}

/// Read `path` and wrap its contents in the ACP `fs/read_text_file` result.
fn fs_read_at(path: &std::path::Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(json!({"content": content})),
        Err(e) => Err(format!("read failed: {}", e)),
    }
}

/// Write `content` to `path`, creating parent directories as needed.
fn fs_write_at(path: &std::path::Path, content: &str) -> Result<Value, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create dir failed: {}", e))?;
    }
    match std::fs::write(path, content) {
        Ok(()) => Ok(json!({})),
        Err(e) => Err(format!("write failed: {}", e)),
    }
}

fn fs_param_path(params: &Value) -> Result<&str, String> {
    params
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing path".to_string())
}

fn fs_param_content(params: &Value) -> Result<&str, String> {
    params
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing content".to_string())
}

/// In-workspace read — `resolve_within` rejects paths outside `work_dir`.
fn handle_fs_read(params: &Value, work_dir: &str) -> Result<Value, String> {
    let resolved = resolve_within(work_dir, fs_param_path(params)?)?;
    fs_read_at(&resolved)
}

/// In-workspace write — `resolve_within` rejects paths outside `work_dir`.
fn handle_fs_write(params: &Value, work_dir: &str) -> Result<Value, String> {
    let content = fs_param_content(params)?;
    let resolved = resolve_within(work_dir, fs_param_path(params)?)?;
    fs_write_at(&resolved, content)
}

/// Unscoped read for a user-approved outside-workspace path.
fn handle_fs_read_unscoped(params: &Value) -> Result<Value, String> {
    fs_read_at(std::path::Path::new(fs_param_path(params)?))
}

/// Unscoped write for a user-approved outside-workspace path.
fn handle_fs_write_unscoped(params: &Value) -> Result<Value, String> {
    let content = fs_param_content(params)?;
    fs_write_at(std::path::Path::new(fs_param_path(params)?), content)
}

/// Pick the ACP `optionId` for an "allow" decision from the permission options
/// grok offered. ACP `kind` is one of allow_once / allow_always / reject_once /
/// reject_always. Prefers allow_always when `prefer_always`, else allow_once;
/// falls back to any allow-kind option, then to the first option offered
/// (ACP lists allow options first).
fn pick_allow_option(options: &[Value], prefer_always: bool) -> Option<String> {
    fn kind_of(o: &Value) -> &str {
        o.get("kind").and_then(|v| v.as_str()).unwrap_or("")
    }
    fn id_of(o: &Value) -> Option<String> {
        o.get("optionId")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    }
    let (primary, secondary) = if prefer_always {
        ("allow_always", "allow_once")
    } else {
        ("allow_once", "allow_always")
    };
    for wanted in [primary, secondary] {
        if let Some(o) = options.iter().find(|o| kind_of(o) == wanted) {
            return id_of(o);
        }
    }
    if let Some(o) = options.iter().find(|o| kind_of(o).starts_with("allow")) {
        return id_of(o);
    }
    options.first().and_then(id_of)
}

/// Pick the ACP `optionId` for a "deny" outcome. Prefers `reject_once` so the
/// agent treats the denial as guidance and keeps going (e.g. keeps planning in
/// plan mode) over `reject_always`; falls back to any reject-kind option.
fn pick_reject_option(options: &[Value]) -> Option<String> {
    fn kind_of(o: &Value) -> &str {
        o.get("kind").and_then(|v| v.as_str()).unwrap_or("")
    }
    fn id_of(o: &Value) -> Option<String> {
        o.get("optionId")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    }
    for wanted in ["reject_once", "reject_always"] {
        if let Some(o) = options.iter().find(|o| kind_of(o) == wanted) {
            return id_of(o);
        }
    }
    options
        .iter()
        .find(|o| kind_of(o).starts_with("reject"))
        .and_then(id_of)
}

async fn note_auth_url(
    line: &str,
    auth_url: &Arc<Mutex<Option<String>>>,
    app: &tauri::AppHandle,
    thread_id: &str,
) -> bool {
    let Some(url) = crate::gemini::install::extract_auth_url(line) else {
        return false;
    };
    *auth_url.lock().await = Some(url.to_string());
    let _ = std::process::Command::new("/usr/bin/open").arg(url).spawn();
    let _ = app.emit(
        "gemini-auth-url",
        serde_json::json!({ "url": url, "threadId": thread_id }),
    );
    true
}

/// Client-side permission outcome for one `session/request_permission`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PermissionDecision {
    /// Auto-approve on the wire (no frontend round-trip).
    Allow,
    /// Auto-reject on the wire (no frontend round-trip).
    Deny,
    /// Route to the frontend approval banner.
    Ask,
}

/// Decide a `session/request_permission` outcome from the user-selected
/// permission mode and the ACP tool `kind`. `grok agent stdio` ignores
/// `--permission-mode`, so xanom enforces the mode here. The input-bar pill is
/// a graduated three-tier control:
///  - `bypassPermissions` ("Full access") → allow everything
///  - `acceptEdits` / `auto` ("Auto") → allow file edits, still ask before
///    running commands
///  - `plan` → deny mutating actions, allow read-only ones
///  - `default` ("Supervised", and anything unrecognized) → ask the user
fn decide_permission(mode: &str, kind: &str) -> PermissionDecision {
    // ACP ToolKind values that neither change the workspace nor run code.
    let non_mutating = matches!(kind, "read" | "search" | "fetch" | "think" | "switch_mode");
    match mode {
        "bypassPermissions" | "yolo" => PermissionDecision::Allow,
        "acceptEdits" | "auto" | "auto_edit" => {
            if kind == "execute" {
                PermissionDecision::Ask
            } else {
                PermissionDecision::Allow
            }
        }
        "plan" => {
            if non_mutating {
                PermissionDecision::Allow
            } else {
                PermissionDecision::Deny
            }
        }
        _ => PermissionDecision::Ask,
    }
}

/// Map a UI effort label to a value `grok agent --reasoning-effort` accepts
/// (`none|minimal|low|medium|high|xhigh`). The effort selector also offers
/// "max", which that flag rejects — it is clamped to "xhigh". Unknown labels
/// return None so the flag is omitted and grok uses its configured default.
fn normalize_reasoning_effort(effort: &str) -> Option<&'static str> {
    match effort {
        "none" => Some("none"),
        "minimal" => Some("minimal"),
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        "max" => Some("xhigh"),
        _ => None,
    }
}

pub(crate) fn acp_session_id_for_thread(
    session_to_thread: &HashMap<String, String>,
    thread_id: &str,
) -> Option<String> {
    session_to_thread
        .iter()
        .find_map(|(sid, tid)| (tid == thread_id).then(|| sid.clone()))
}

// ── Per-thread server manager ──────────────────────
//
// One `grok agent stdio` process per agmux thread. Per-thread keying lets us
// apply distinct spawn flags (permission mode / effort / plan) per chat thread
// without restarting unrelated threads when a user toggles config.

pub struct GeminiServerManager {
    servers: HashMap<String, Arc<GeminiAppServer>>, // thread_id -> server
    configs: HashMap<String, GeminiSpawnConfig>,    // thread_id -> last-applied config
}

impl GeminiServerManager {
    pub fn new() -> Self {
        Self {
            servers: HashMap::new(),
            configs: HashMap::new(),
        }
    }

    pub fn get(&self, thread_id: &str) -> Option<Arc<GeminiAppServer>> {
        self.servers.get(thread_id).cloned()
    }

    /// Threads with a live ACP process. A warm server does NOT mean a turn is
    /// in flight — remote control pairs this with the thread's running-turn row
    /// so a session that was mid-turn when the app died can't stick "Running".
    pub fn thread_ids(&self) -> Vec<String> {
        self.servers.keys().cloned().collect()
    }

    /// Register a freshly-spawned server for `thread_id`. If a server already
    /// exists (the caller lost a spawn race) the existing one is kept and
    /// returned instead — callers MUST compare the result against their
    /// `server` with `Arc::ptr_eq` and `shutdown()` the redundant process
    /// when it loses.
    ///
    /// Spawning is done by the caller WITHOUT holding the manager lock, so a
    /// slow `grok agent stdio` handshake can't block grok commands for other
    /// threads (this manager lock gates every grok command).
    pub fn insert_or_keep(
        &mut self,
        thread_id: &str,
        server: Arc<GeminiAppServer>,
        config: GeminiSpawnConfig,
    ) -> Arc<GeminiAppServer> {
        if let Some(existing) = self.servers.get(thread_id) {
            return existing.clone();
        }
        self.servers.insert(thread_id.to_string(), server.clone());
        self.configs.insert(thread_id.to_string(), config);
        server
    }

    /// Remove a server without shutting it down — the caller owns teardown.
    /// Used by `gemini_sdk_restart` to drop the old process before respawning.
    pub fn take(&mut self, thread_id: &str) -> Option<Arc<GeminiAppServer>> {
        self.configs.remove(thread_id);
        self.servers.remove(thread_id)
    }

    pub async fn stop(&mut self, thread_id: &str) {
        if let Some(server) = self.servers.remove(thread_id) {
            server.shutdown().await;
        }
        self.configs.remove(thread_id);
    }

    pub async fn stop_all(&mut self) {
        let drained: Vec<(String, Arc<GeminiAppServer>)> = self.servers.drain().collect();
        for (_, server) in drained {
            server.shutdown().await;
        }
        self.configs.clear();
    }
}

impl Default for GeminiServerManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod resolve_within_tests {
    use super::resolve_within;

    #[test]
    fn allows_existing_file_inside_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let file = root.join("inside.txt");
        std::fs::write(&file, "x").unwrap();
        let resolved =
            resolve_within(root.to_str().unwrap(), file.to_str().unwrap()).unwrap();
        assert!(resolved.starts_with(std::fs::canonicalize(root).unwrap()));
    }

    #[test]
    fn allows_relative_path_inside_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("rel.txt"), "x").unwrap();
        let resolved = resolve_within(root.to_str().unwrap(), "rel.txt").unwrap();
        assert!(resolved.ends_with("rel.txt"));
    }

    #[test]
    fn allows_new_file_in_new_subdir() {
        // A write target where neither the subdir nor the file exist yet.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let target = root.join("newdir").join("new.txt");
        let resolved =
            resolve_within(root.to_str().unwrap(), target.to_str().unwrap()).unwrap();
        assert!(resolved.starts_with(std::fs::canonicalize(root).unwrap()));
    }

    #[test]
    fn rejects_absolute_path_outside_workspace() {
        let dir = tempfile::tempdir().unwrap();
        assert!(resolve_within(dir.path().to_str().unwrap(), "/etc/passwd").is_err());
    }

    #[test]
    fn rejects_parent_dir_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        assert!(resolve_within(root, "../../../etc/passwd").is_err());
        assert!(resolve_within(root, "sub/../../escape").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_directory_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "top secret").unwrap();
        // A symlink inside the workspace pointing at an external directory —
        // canonicalize resolves it so the escape is caught.
        let link = root.join("link");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        let through_link = link.join("secret.txt");
        assert!(
            resolve_within(root.to_str().unwrap(), through_link.to_str().unwrap()).is_err()
        );
    }
}

#[cfg(test)]
mod approval_option_tests {
    use super::pick_allow_option;
    use serde_json::json;

    #[test]
    fn resolves_server_defined_option_id_by_kind() {
        // grok uses server-defined ids — never literally "allow", which is why
        // hardcoding "allow" got rejected with "unknown permission option".
        let options = vec![
            json!({"optionId": "proceed_once", "name": "Allow", "kind": "allow_once"}),
            json!({"optionId": "proceed_always", "name": "Always allow", "kind": "allow_always"}),
            json!({"optionId": "stop", "name": "Reject", "kind": "reject_once"}),
        ];
        assert_eq!(
            pick_allow_option(&options, false).as_deref(),
            Some("proceed_once")
        );
        assert_eq!(
            pick_allow_option(&options, true).as_deref(),
            Some("proceed_always")
        );
    }

    #[test]
    fn prefers_other_allow_kind_when_exact_kind_absent() {
        // Only allow_always offered — a plain allow still resolves to it.
        let options = vec![
            json!({"optionId": "always", "name": "Always", "kind": "allow_always"}),
            json!({"optionId": "no", "name": "Reject", "kind": "reject_once"}),
        ];
        assert_eq!(pick_allow_option(&options, false).as_deref(), Some("always"));
    }

    #[test]
    fn falls_back_to_first_option_when_kind_missing() {
        let options = vec![json!({"optionId": "yes", "name": "Yes"})];
        assert_eq!(pick_allow_option(&options, false).as_deref(), Some("yes"));
    }

    #[test]
    fn returns_none_when_no_options_offered() {
        assert_eq!(pick_allow_option(&[], false), None);
    }
}

#[cfg(test)]
mod fs_proxy_tests {
    use super::{handle_fs_read, handle_fs_read_unscoped, handle_fs_write_unscoped};
    use serde_json::json;

    #[test]
    fn in_workspace_read_is_served_but_outside_read_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path();
        std::fs::write(work.join("inside.txt"), "hello").unwrap();
        let ok = handle_fs_read(
            &json!({"path": work.join("inside.txt").to_str().unwrap()}),
            work.to_str().unwrap(),
        );
        assert_eq!(ok.unwrap()["content"], "hello");

        // A path outside the workspace is refused by the scoped handler — the
        // read loop routes these to a user approval instead.
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "x").unwrap();
        assert!(handle_fs_read(
            &json!({"path": outside.path().join("secret.txt").to_str().unwrap()}),
            work.to_str().unwrap(),
        )
        .is_err());
    }

    #[test]
    fn unscoped_helpers_read_and_write_outside_the_workspace() {
        // Used only after the user approves an outside-workspace fs/ request.
        let outside = tempfile::tempdir().unwrap();
        let file = outside.path().join("approved.txt");
        std::fs::write(&file, "top secret").unwrap();

        let read = handle_fs_read_unscoped(&json!({"path": file.to_str().unwrap()}));
        assert_eq!(read.unwrap()["content"], "top secret");

        let new_file = outside.path().join("nested").join("written.txt");
        handle_fs_write_unscoped(&json!({
            "path": new_file.to_str().unwrap(),
            "content": "approved write",
        }))
        .unwrap();
        assert_eq!(std::fs::read_to_string(&new_file).unwrap(), "approved write");
    }

    #[test]
    fn unscoped_read_reports_missing_path_and_files() {
        assert!(handle_fs_read_unscoped(&json!({})).is_err());
        assert!(handle_fs_read_unscoped(&json!({"path": "/no/such/file/xyz"})).is_err());
    }
}

#[cfg(test)]
mod permission_policy_tests {
    use super::{
        acp_session_id_for_thread, decide_permission, normalize_reasoning_effort,
        pick_reject_option, PermissionDecision,
    };
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn bypass_allows_everything() {
        for kind in ["execute", "edit", "read", "delete", "other", ""] {
            for mode in ["bypassPermissions", "yolo"] {
                assert_eq!(
                    decide_permission(mode, kind),
                    PermissionDecision::Allow
                );
            }
        }
    }

    #[test]
    fn accept_edits_and_auto_allow_edits_but_ask_before_commands() {
        // "auto" is the input-bar pill's middle tier — it behaves like
        // acceptEdits: file edits proceed, shell commands still prompt.
        for mode in ["acceptEdits", "auto", "auto_edit"] {
            assert_eq!(decide_permission(mode, "edit"), PermissionDecision::Allow);
            assert_eq!(decide_permission(mode, "read"), PermissionDecision::Allow);
            assert_eq!(decide_permission(mode, "execute"), PermissionDecision::Ask);
        }
    }

    #[test]
    fn plan_denies_mutating_actions_and_allows_read_only() {
        for mutating in ["execute", "edit", "delete", "move", "other", ""] {
            assert_eq!(
                decide_permission("plan", mutating),
                PermissionDecision::Deny,
                "kind {mutating:?} should be denied in plan mode"
            );
        }
        for read_only in ["read", "search", "fetch", "think"] {
            assert_eq!(
                decide_permission("plan", read_only),
                PermissionDecision::Allow,
                "kind {read_only:?} should be allowed in plan mode"
            );
        }
    }

    #[test]
    fn default_and_unknown_modes_ask_the_user() {
        assert_eq!(
            decide_permission("default", "execute"),
            PermissionDecision::Ask
        );
        assert_eq!(decide_permission("", "execute"), PermissionDecision::Ask);
        assert_eq!(decide_permission("nonsense", "read"), PermissionDecision::Ask);
    }

    #[test]
    fn reject_option_prefers_reject_once() {
        let options = vec![
            json!({"optionId": "allow1", "kind": "allow_once"}),
            json!({"optionId": "no-always", "kind": "reject_always"}),
            json!({"optionId": "no-once", "kind": "reject_once"}),
        ];
        assert_eq!(pick_reject_option(&options).as_deref(), Some("no-once"));
    }

    #[test]
    fn reject_option_falls_back_to_any_reject_kind() {
        let options = vec![
            json!({"optionId": "allow1", "kind": "allow_once"}),
            json!({"optionId": "no-always", "kind": "reject_always"}),
        ];
        assert_eq!(pick_reject_option(&options).as_deref(), Some("no-always"));
    }

    #[test]
    fn reject_option_is_none_when_only_allow_options() {
        let options = vec![json!({"optionId": "yes", "kind": "allow_once"})];
        assert_eq!(pick_reject_option(&options), None);
    }

    #[test]
    fn reasoning_effort_clamps_max_to_xhigh_and_drops_unknown() {
        assert_eq!(normalize_reasoning_effort("low"), Some("low"));
        assert_eq!(normalize_reasoning_effort("xhigh"), Some("xhigh"));
        // The UI offers "max"; `--reasoning-effort` rejects it → clamp to xhigh.
        assert_eq!(normalize_reasoning_effort("max"), Some("xhigh"));
        assert_eq!(normalize_reasoning_effort("bogus"), None);
    }

    #[test]
    fn acp_session_id_for_thread_finds_mapped_session() {
        let mut map = HashMap::new();
        map.insert("acp-1".into(), "thread-1".into());
        map.insert("acp-2".into(), "thread-2".into());
        assert_eq!(
            acp_session_id_for_thread(&map, "thread-1").as_deref(),
            Some("acp-1")
        );
        assert_eq!(acp_session_id_for_thread(&map, "missing"), None);
    }
}
