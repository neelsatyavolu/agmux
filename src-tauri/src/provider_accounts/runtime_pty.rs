//! Quota handoff for native terminals. Never consumes or replays terminal input.
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tauri::{Emitter, Listener, Manager};
use serde_json::{json, Value};
use crate::process::spawn::SpawnOptions;

/// Unknown runtime models must not reuse a previously remembered model's
/// window: remember_model(None) intentionally retains the route context.
pub(crate) async fn claude_quota_exhaustion(
    session_key: &str,
    account_id: &str,
    model: Option<&str>,
) -> Result<Option<Option<i64>>, String> {
    if let Some(model) = model.filter(|model| !model.trim().is_empty()) {
        super::remember_model("claude", session_key, Some(model)).await?;
        super::quota_exhaustion_for_session(session_key).await
    } else {
        super::quota_exhaustion(account_id).await
    }
}

fn history_path(provider: &str, session_id: &str, work_dir: &str) -> Option<std::path::PathBuf> {
    let path = if provider == "Codex" {
        let home = crate::codex::cli_config::codex_home()?;
        crate::commands::codex::find_session_file(&home.join("sessions"), session_id)
    } else if provider == "ClaudeCode" {
        super::claude::native_global_home().ok().map(|home| home.join("projects")
            .join(crate::encode_claude_project_path(work_dir)).join(format!("{session_id}.jsonl")))
    } else {
        super::storage::native_home("grok").ok().map(|home| home.join("sessions")
            .join(crate::encode_grok_cwd(work_dir)).join(session_id).join("updates.jsonl"))
    };
    path
}

/// Read only the exact native session, never a CLI default or a sibling's model.
pub(crate) async fn native_model(provider: &str, session_id: &str, work_dir: &str) -> Option<String> {
    if uuid::Uuid::parse_str(session_id).is_err() { return None; }
    let (provider, session_id, work_dir) = (provider.to_string(), session_id.to_string(), work_dir.to_string());
    tokio::task::spawn_blocking(move || {
        let path = history_path(&provider, &session_id, &work_dir)?;
        let path = if provider == "Grok" { path.with_file_name("summary.json") } else { path };
        native_model_path(&provider, &session_id, &path)
    }).await.ok().flatten()
}

fn native_model_path(provider: &str, session_id: &str, path: &std::path::Path) -> Option<String> {
    use std::io::Read;
    let limit = if matches!(provider, "Codex" | "ClaudeCode") { 16 * 1024 * 1024 } else { 256 * 1024 };
    let file = std::fs::File::open(path).ok()?;
    let before = file.metadata().ok()?;
    if before.len() > limit { return None; }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > limit { return None; }
    let model = match provider {
        "Codex" => {
            if !bytes.ends_with(b"\n") { return None; }
            let mut identity_verified = false;
            let mut model = None;
            for line in bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
                let value: Value = serde_json::from_slice(line).ok()?;
                match value["type"].as_str() {
                    Some("session_meta") => {
                        // Child rollouts can share payload.session_id with a parent.
                        if value["payload"]["id"].as_str() != Some(session_id) { return None; }
                        identity_verified = true;
                    },
                    Some("turn_context") => {
                        model = value["payload"]["model"].as_str()
                            .filter(|m| !m.trim().is_empty()).map(str::to_string);
                    },
                    _ => {},
                }
            }
            if !identity_verified { return None; }
            model
        },
        "ClaudeCode" => {
            if !bytes.ends_with(b"\n") { return None; }
            let mut model = None;
            for line in bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
                let value: Value = serde_json::from_slice(line).ok()?;
                if value["isSidechain"] == true { continue; }
                if value.get("sessionId").is_some() && value["sessionId"].as_str() != Some(session_id) { return None; }
                if value["type"] == "assistant" {
                    if value["sessionId"].as_str() != Some(session_id) { return None; }
                    // Native quota rejections carry a synthetic model, not a
                    // model change. Preserve only an already verified model.
                    if claude_quota_rejection(&value) { continue; }
                    let reported = value["message"]["model"].as_str().filter(|m| m.starts_with("claude-"));
                    // API response IDs omit the native CLI context suffix.
                    if !model.as_deref().is_some_and(|m: &str| m.strip_suffix("[1m]").is_some_and(|base| Some(base) == reported)) {
                        model = reported.map(str::to_string);
                    }
                }
                if value["type"] == "attachment" && value["attachment"]["type"] == "model" {
                    if value["sessionId"].as_str() != Some(session_id) { return None; }
                    model = value["attachment"]["identity"]["modelId"].as_str()
                        .filter(|m| m.starts_with("claude-")).map(str::to_string);
                }
                // A native model switch without a subsequent assistant record
                // cannot be reconstructed from local-command prose.
                if value["type"] == "system" && value["subtype"] == "local_command" { model = None; }
            }
            model
        },
        "Grok" => {
            let value: Value = serde_json::from_slice(&bytes).ok()?;
            value["current_model_id"].as_str().filter(|m| !m.trim().is_empty()).map(str::to_string)
        },
        _ => None,
    };
    let after = std::fs::metadata(path).ok()?;
    if before.len() != after.len() || before.modified().ok()? != after.modified().ok()? { return None; }
    model
}

fn claude_quota_rejection(value: &Value) -> bool {
    value["type"] == "assistant" && value["isApiErrorMessage"] == true
        && value["error"] == "rate_limit" && value["apiErrorStatus"] == 429
        && value["message"]["model"] == "<synthetic>" && value["message"]["stop_reason"] == "stop_sequence"
}

fn native_idle(provider: &str, session_id: &str, work_dir: &str, checkpoint: (u64, Option<u64>)) -> bool {
    if checkpoint.0 > 0 && checkpoint.1.is_none() { return false; }
    let Some(path) = history_path(provider, session_id, work_dir) else { return false; };
    native_idle_path(provider, session_id, &path, checkpoint.1)
}

fn native_idle_path(provider: &str, session_id: &str, path: &std::path::Path, required_start: Option<u64>) -> bool {
    use std::io::Read;
    let Ok(before) = std::fs::metadata(&path) else { return false; };
    // Unknown/truncated histories do not prove it is safe to stop a process.
    if before.len() > 16 * 1024 * 1024 { return false; }
    let Ok(file) = std::fs::File::open(path) else { return false; };
    let mut bytes = Vec::new();
    if file.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes).is_err() || bytes.len() > 16 * 1024 * 1024 { return false; }
    if !bytes.ends_with(b"\n") { return false; }
    let mut boundary = super::runtime::NativeBoundary::default();
    let mut identity_verified = !matches!(provider, "Codex" | "ClaudeCode");
    let mut claude_user_turn = false;
    let mut claude_queued = 0usize;
    let mut line_offset = 0u64;
    let mut input_submitted = required_start.is_none();
    let mut active_turn: Option<String> = None;
    for line in bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
        let start = line_offset;
        line_offset += line.len() as u64 + 1;
        let Ok(value) = serde_json::from_slice::<Value>(line) else { return false; };
        if provider == "Codex" {
            if value["type"] == "session_meta" {
                if value["payload"]["id"].as_str() != Some(session_id) { return false; }
                identity_verified = true;
            }
            if value["type"] == "response_item" && matches!(value["payload"]["type"].as_str(), Some("function_call" | "custom_tool_call")) {
                let Some(id) = value["payload"]["call_id"].as_str() else { return false; };
                boundary.tool_started(id);
            }
            if value["type"] != "event_msg" { continue; }
            let event = &value["payload"];
            match event["type"].as_str().unwrap_or("") {
                "task_started" => {
                    active_turn = event["turn_id"].as_str().map(str::to_string);
                    boundary.started();
                    if required_start.is_none_or(|offset| start >= offset) { input_submitted = true; }
                },
                "task_complete" if active_turn.is_some() && event["turn_id"].as_str() == active_turn.as_deref() => boundary.completed(),
                "item_started" | "item_completed" => {
                    let item = &event["item"];
                    match item["type"].as_str().unwrap_or("") {
                        "UserMessage" | "AgentMessage" | "Reasoning" | "Plan" => {},
                        "CommandExecution" | "FileChange" | "McpToolCall" => {
                            let Some(id) = item["id"].as_str() else { return false; };
                            let finished = event["type"] == "item_completed"
                                && matches!(item["status"].as_str(), Some("completed" | "failed"))
                                && (item["type"] != "CommandExecution" || item["exit_code"].as_i64().is_some());
                            if finished { boundary.tool_completed(id); }
                            else { boundary.tool_started(id); }
                        }
                        // Completion of spawn/wait is not completion of every
                        // child or detached process. Unknown item kinds remain unsafe.
                        _ => boundary.tool_started("unverified-modern-execution"),
                    }
                }
                "collab_agent_spawn_begin" | "background_terminal_started" => {
                    boundary.tool_started("unverified-modern-execution");
                }
                "exec_command_begin" | "apply_patch_begin" => {
                    let Some(id) = event["call_id"].as_str() else { return false; };
                    boundary.tool_started(id);
                }
                "exec_command_end" | "apply_patch_end" => {
                    let Some(id) = event["call_id"].as_str() else { return false; };
                    boundary.tool_completed(id);
                }
                _ => {},
            }
        } else if provider == "ClaudeCode" {
            if value["isSidechain"] == true { continue; }
            if value.get("sessionId").is_some() && value["sessionId"].as_str() != Some(session_id) { return false; }
            let kind = value["type"].as_str().unwrap_or("");
            if matches!(kind, "user" | "assistant") {
                if value["sessionId"].as_str() != Some(session_id) { return false; }
                identity_verified = true;
                let content = &value["message"]["content"];
                let results_only = content.as_array().is_some_and(|blocks| !blocks.is_empty()
                    && blocks.iter().all(|b| b["type"] == "tool_result"));
                if kind == "user" && !results_only {
                    boundary.started();
                    if value["isMeta"] != true && value["isCompactSummary"] != true {
                        claude_user_turn = true;
                        if required_start.is_none_or(|offset| start >= offset) { input_submitted = true; }
                    }
                }
                if let Some(blocks) = content.as_array() {
                    for block in blocks {
                        match block["type"].as_str().unwrap_or("") {
                            "tool_use" | "server_tool_use" | "mcp_tool_use" => {
                                let Some(id) = block["id"].as_str() else { return false; };
                                boundary.tool_started(id);
                                if block["input"]["run_in_background"] == true
                                    || matches!(block["name"].as_str(), Some("Agent" | "Task" | "dispatch_agent")) {
                                    boundary.tool_started("unverified-background");
                                }
                            },
                            "tool_result" => {
                                let Some(id) = block["tool_use_id"].as_str() else { return false; };
                                boundary.tool_completed(id);
                            },
                            _ => {},
                        }
                    }
                }
                if kind == "assistant" {
                    boundary.started();
                    if claude_user_turn && (value["message"]["stop_reason"] == "end_turn" || claude_quota_rejection(&value)) { boundary.completed(); }
                }
                // Native Bash may detach even without run_in_background input.
                if value["toolUseResult"]["backgroundTaskId"].is_string()
                    || value["toolUseResult"]["isAsync"] == true { boundary.tool_started("unverified-background"); }
            } else if kind == "queue-operation" {
                match value["operation"].as_str() {
                    Some("enqueue") => { claude_queued += 1; boundary.started(); boundary.tool_started("queued-input"); },
                    Some("dequeue") if claude_queued > 0 => {
                        claude_queued -= 1;
                        if claude_queued == 0 { boundary.tool_completed("queued-input"); }
                    },
                    _ => boundary.tool_started("unverified-queue"),
                }
            } else if kind == "system" && matches!(value["subtype"].as_str(), Some("task_started" | "task_progress")) {
                boundary.tool_started("unverified-background");
            }
        } else {
            let method = value["method"].as_str().unwrap_or("");
            if !matches!(method, "session/update" | "_x.ai/session/update") { continue; }
            if value["params"]["sessionId"].as_str() != Some(session_id) { return false; }
            let update = &value["params"]["update"];
            match update["sessionUpdate"].as_str().unwrap_or("") {
                "user_message_chunk" => { boundary.started(); if required_start.is_none_or(|offset| start >= offset) { input_submitted = true; } },
                "turn_completed" if method == "_x.ai/session/update" => boundary.completed(),
                "tool_call" => {
                    let Some(id) = update["toolCallId"].as_str() else { return false; };
                    boundary.tool_started(id);
                }
                "tool_call_update" if matches!(update["status"].as_str(), Some("completed" | "failed")) => {
                    let Some(id) = update["toolCallId"].as_str() else { return false; };
                    boundary.tool_completed(id);
                }
                "background_tasks" => {
                    if update["tasks"].as_array().is_some_and(Vec::is_empty) { boundary.tool_completed("background"); }
                    else { boundary.tool_started("background"); }
                }
                // Without a complete subagent lifecycle schema, never retire its parent.
                "subagent_spawned" => boundary.tool_started("unverified-subagent"),
                _ => {},
            }
        }
    }
    let Ok(after) = std::fs::metadata(&path) else { return false; };
    input_submitted && identity_verified && boundary.idle() && before.len() == after.len() && before.modified().ok() == after.modified().ok()
}

pub fn monitor(
    app: tauri::AppHandle,
    session: &crate::process::session::PtySessionContext,
    work_dir: String,
    mut options: SpawnOptions,
) {
    if !matches!(session.provider.as_str(), "Codex" | "Grok" | "ClaudeCode") { return; }
    if session.provider == "ClaudeCode" && super::claude::uses_project_auth(std::path::Path::new(&work_dir)) { return; }
    let thread_id = session.thread_id.clone();
    let provider = session.provider.clone();
    let account_provider = if provider == "ClaudeCode" { "claude".to_string() } else { provider.to_lowercase() };
    let mut expected_child = Arc::downgrade(&session.child);
    let initial_writer = session.writer.clone();
    tokio::spawn(async move {
        if let Some(native) = options.resume_session_id.as_deref() {
            if let Some(path) = history_path(&provider, native, &work_dir) {
                initial_writer.lock().await.set_native_history(path);
            }
        }
        drop(initial_writer);
        let mut notices = std::collections::HashSet::new();
        let mut switched = std::collections::HashSet::new();
        let mut switching = false;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            if provider == "ClaudeCode" && super::claude::uses_project_auth(std::path::Path::new(&work_dir)) { break; }
            let Some(child) = expected_child.upgrade() else { break; };
            let state = app.state::<crate::state::AppState>();
            {
                let sessions = state.sessions.lock().await;
                if !sessions.get(&thread_id).is_some_and(|s| Arc::ptr_eq(&s.child, &child)) { break; }
            }
            let mut native = if let Some(id) = &options.resume_session_id { Some(id.clone()) }
                else if let Ok(thread) = crate::db::queries::get_thread(&state.db, &thread_id).await {
                    thread.sdk_session_id
                } else { None };
            if native.is_none() && provider == "Grok" {
                native = std::fs::read_to_string(crate::paths::agmux_home().join("threads").join(&thread_id).join("grok-session-id.txt"))
                    .ok().map(|id| id.trim().to_string()).filter(|id| uuid::Uuid::parse_str(id).is_ok());
            }
            if native.is_none() && provider == "Codex" && crate::process::spawn::codex_session_file_exists(&thread_id) {
                native = Some(thread_id.clone());
            }
            let key = if provider == "Codex" { options.resume_session_id.as_deref().unwrap_or(&thread_id) } else { &thread_id }.to_string();
            let Some(account) = super::current_assignment(&key).await else { break; };
            let _ = super::refresh_account(&account.account_id).await;
            let exhaustion = if provider == "ClaudeCode" {
                let model = match native.as_deref() {
                    Some(native) => native_model(&provider, native, &work_dir).await,
                    None => None,
                };
                claude_quota_exhaustion(&key, &account.account_id, model.as_deref()).await
            } else { super::quota_exhaustion(&account.account_id).await };
            let Ok(Some(reset)) = exhaustion else { continue; };
            if !super::auto_switch_enabled().await.unwrap_or(false) { continue; }
            let Some(native) = native else {
                if notices.insert("identity") { let _ = app.emit("provider-account-runtime", json!({"provider": account_provider, "sessionKey": key, "threadId": thread_id, "status": "identity_unavailable"})); }
                continue;
            };
            let checkpoint = {
                let sessions = state.sessions.lock().await;
                let Some(session) = sessions.get(&thread_id) else { break; };
                let mut writer = session.writer.lock().await;
                if let Some(path) = history_path(&provider, &native, &work_dir) { writer.set_native_history(path); }
                writer.input_checkpoint()
            };
            let (p, n, w) = (provider.clone(), native.clone(), work_dir.clone());
            let idle = tokio::task::spawn_blocking(move || native_idle(&p, &n, &w, checkpoint)).await.unwrap_or(false);
            if !idle {
                if notices.insert("waiting") { let _ = app.emit("provider-account-runtime", json!({"provider": account_provider, "sessionKey": key, "threadId": thread_id, "status": "waiting_for_idle"})); }
                continue;
            }
            if switched.len() >= 3 || switched.contains(&account.account_id) { break; }
            // Subscribe before stopping so a late old-reader exit cannot close
            // the replacement terminal. Keep the session map locked through handoff.
            let mut sessions = state.sessions.lock().await;
            let Some(old) = sessions.get(&thread_id) else { break; };
            if !Arc::ptr_eq(&old.child, &child) || old.is_shutting_down.load(Ordering::Relaxed) { break; }
            let (done, wait) = tokio::sync::oneshot::channel();
            let done = std::sync::Mutex::new(Some(done));
            let listener = app.listen(format!("pty-exit-{thread_id}"), move |_| {
                if let Some(done) = done.lock().unwrap_or_else(|e| e.into_inner()).take() { let _ = done.send(()); }
            });
            // Freeze terminal writes while revalidating the native boundary.
            let writer = old.writer.lock().await;
            if writer.input_checkpoint() != checkpoint { app.unlisten(listener); continue; }
            let generation = old.input_generation.load(Ordering::SeqCst);
            let (p, n, w) = (provider.clone(), native.clone(), work_dir.clone());
            if !tokio::task::spawn_blocking(move || native_idle(&p, &n, &w, checkpoint)).await.unwrap_or(false) {
                app.unlisten(listener);
                drop(writer);
                continue;
            }
            if old.input_generation.load(Ordering::SeqCst) != generation { app.unlisten(listener); continue; }
            // /model inside the terminal can supersede the launch options.
            // Unknown model context must not stop the current native process.
            let Some(model) = native_model(&provider, &native, &work_dir).await else {
                app.unlisten(listener);
                if notices.insert("model") { let _ = app.emit("provider-account-runtime", json!({"provider": account_provider, "sessionKey": key, "threadId": thread_id, "status": "model_unavailable"})); }
                continue;
            };
            if super::remember_model(&account_provider, &key, Some(&model)).await.is_err() {
                app.unlisten(listener);
                continue;
            }
            // /model may have changed since the first quota observation.
            let reset = if provider == "ClaudeCode" {
                match claude_quota_exhaustion(&key, &account.account_id, Some(&model)).await {
                    Ok(Some(reset)) => reset,
                    _ => { app.unlisten(listener); continue; },
                }
            } else { reset };
            if old.input_generation.load(Ordering::SeqCst) != generation { app.unlisten(listener); continue; }
            if provider == "ClaudeCode" && super::claude::uses_project_auth(std::path::Path::new(&work_dir)) { app.unlisten(listener); break; }
            options.model = Some(model);
            switched.insert(account.account_id.clone());
            switching = true;
            let _ = app.emit("provider-account-runtime", json!({"provider": account_provider, "sessionKey": key, "threadId": thread_id, "status": "switching"}));
            old.kill().await;
            drop(writer);
            let exited = tokio::time::timeout(std::time::Duration::from_secs(5), wait).await;
            app.unlisten(listener);
            if !matches!(exited, Ok(Ok(()))) { break; }
            sessions.remove(&thread_id);
            let marked = if provider == "ClaudeCode" {
                super::mark_exhausted_for_session(&account_provider, &key, reset).await
            } else { super::mark_exhausted(&account_provider, &key, reset).await };
            if marked.is_err() || super::release(&key).await.is_err() { break; }
            options.resume_session_id = Some(native);
            let next_key = if provider == "Codex" { options.resume_session_id.as_deref().unwrap_or(&thread_id) } else { &thread_id };
            // A first PTY handoff can move from an agmux key to its native ID.
            // Copy the retained entitlement/exclusions only after the old
            // binding is released, so acquire cannot reuse the exhausted home.
            if super::bind(&account_provider, &key, next_key).await.is_err()
                || super::remember_model(&account_provider, next_key, options.model.as_deref()).await.is_err() { break; }
            match super::acquire(&account_provider, next_key).await {
                Ok(Some(next)) if !switched.contains(&next.account_id) => {},
                _ => break,
            }
            let replacement = crate::process::spawn::spawn_pty_session(&state.db, &thread_id, &provider, &work_dir, &options).await;
            match replacement {
                Ok(replacement) => {
                    expected_child = Arc::downgrade(&replacement.child);
                    crate::process::io::start_stdout_reader(app.clone(), thread_id.clone(), replacement.master.clone(), replacement.child.clone(),
                        replacement.is_shutting_down.clone(), replacement.output_buffer.clone(), state.db.clone());
                    sessions.insert(thread_id.clone(), replacement);
                    notices.clear();
                    switching = false;
                    let _ = app.emit("provider-account-runtime", json!({"provider": account_provider, "sessionKey": options.resume_session_id, "threadId": thread_id, "status": "ready", "continuationRequired": true}));
                }
                Err(_) => {
                    let _ = app.emit("provider-account-runtime", json!({"provider": account_provider, "sessionKey": key, "threadId": thread_id, "status": "unavailable"}));
                    break;
                }
            }
        }
        if switching {
            let _ = app.emit("provider-account-runtime", json!({"provider": account_provider, "sessionKey": thread_id, "threadId": thread_id, "status": "unavailable"}));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn model(provider: &str, text: &str) -> Option<String> {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("native.jsonl");
        std::fs::write(&path, text).unwrap();
        native_model_path(provider, "session", &path)
    }
    fn claude(kind: &str, message: Value) -> Value {
        json!({"type":kind,"sessionId":"session","isSidechain":false,"message":message})
    }
    #[test]
    fn claude_model_is_exact_parent_and_latest() {
        let parent = claude("assistant", json!({"model":"claude-opus-5-5"}));
        let mut child = claude("assistant", json!({"model":"other"}));
        child["isSidechain"] = json!(true);
        let text = format!("{}\n{}\n", parent, child);
        assert_eq!(model("ClaudeCode", &text).as_deref(), Some("claude-opus-5-5"));
        assert_eq!(model("ClaudeCode", &format!("{}\n{}\n", parent, claude("assistant",json!({})))), None);
        let mut wrong = parent.clone(); wrong["sessionId"] = json!("other");
        assert_eq!(model("ClaudeCode", &format!("{}\n",wrong)), None);
        assert_eq!(model("ClaudeCode", &parent.to_string()), None);
        let metadata = json!({"type":"attachment","sessionId":"session","attachment":{"type":"model","identity":{"modelId":"claude-opus-5-5[1m]"}}});
        assert_eq!(model("ClaudeCode", &format!("{}\n{}\n",metadata,parent)).as_deref(), Some("claude-opus-5-5[1m]"));
    }
    #[test]
    fn claude_idle_requires_parent_end_turn_and_completed_tools() {
        let user = claude("user", json!({"role":"user","content":"private"}));
        let end = claude("assistant", json!({"stop_reason":"end_turn","content":[]}));
        assert!(idle("ClaudeCode", &[user.clone(),end.clone()]));
        assert!(!idle("ClaudeCode", &[end.clone()]));
        assert!(!idle("ClaudeCode", &[user.clone(),end.clone(),user.clone()]));
        let tool = claude("assistant",json!({"stop_reason":"tool_use","content":[{"type":"tool_use","id":"t","name":"Read","input":{}}]}));
        let result = claude("user",json!({"content":[{"type":"tool_result","tool_use_id":"t"}]}));
        assert!(!idle("ClaudeCode", &[user.clone(),tool.clone(),end.clone()]));
        assert!(idle("ClaudeCode", &[user.clone(),tool.clone(),result.clone(),end.clone()]));
        let mut background=tool; background["message"]["content"][0]["input"]=json!({"run_in_background":true});
        assert!(!idle("ClaudeCode", &[user.clone(),background,result,end.clone()]));
        let mut child=end; child["isSidechain"]=json!(true);
        assert!(!idle("ClaudeCode", &[user.clone(),child]));
        let enqueue=json!({"type":"queue-operation","sessionId":"session","operation":"enqueue"});
        let dequeue=json!({"type":"queue-operation","sessionId":"session","operation":"dequeue"});
        let end=claude("assistant",json!({"stop_reason":"end_turn","content":[]}));
        assert!(!idle("ClaudeCode", &[user.clone(),end.clone(),enqueue.clone()]));
        assert!(idle("ClaudeCode", &[enqueue,dequeue,user,end]));
    }
    #[test]
    fn claude_native_quota_rejection_is_idle_without_losing_the_verified_model() {
        let user = claude("user", json!({"content":"question"}));
        let assistant = claude("assistant", json!({"model":"claude-opus-5-5","stop_reason":"end_turn","content":[]}));
        let mut rejected = claude("assistant", json!({"model":"<synthetic>","stop_reason":"stop_sequence","content":[]}));
        rejected["isApiErrorMessage"] = json!(true);
        rejected["error"] = json!("rate_limit");
        rejected["apiErrorStatus"] = json!(429);
        let transcript = |values: &[Value]| values.iter().map(|value| format!("{value}\n")).collect::<String>();
        assert!(idle("ClaudeCode", &[user.clone(), rejected.clone()]));
        assert_eq!(model("ClaudeCode", &transcript(&[assistant.clone(), user.clone(), rejected.clone()])).as_deref(), Some("claude-opus-5-5"));
        assert_eq!(model("ClaudeCode", &transcript(&[user.clone(), rejected.clone()])), None);
        let changed = json!({"type":"system","subtype":"local_command","sessionId":"session"});
        assert_eq!(model("ClaudeCode", &transcript(&[assistant, changed, user.clone(), rejected.clone()])), None);
        for (key, value) in [("apiErrorStatus",json!(500)), ("error",json!("other")), ("isApiErrorMessage",json!(false))] {
            let mut invalid = rejected.clone(); invalid[key] = value;
            assert!(!idle("ClaudeCode", &[user.clone(),invalid]));
        }
        let tool = claude("assistant",json!({"stop_reason":"tool_use","content":[{"type":"tool_use","id":"t","name":"Read","input":{}}]}));
        assert!(!idle("ClaudeCode", &[user.clone(),tool,rejected.clone()]));
        let mut child = rejected; child["isSidechain"] = json!(true);
        assert!(!idle("ClaudeCode", &[user,child]));
    }
    #[test]
    fn native_model_uses_latest_exact_codex_context() {
        let text = concat!(
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"session\"}}\n",
            "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5\"}}\n",
            "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-6-sol\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"model\":\"untrusted\"}}\n",
        );
        assert_eq!(model("Codex", text).as_deref(), Some("gpt-6-sol"));
        assert_eq!(model("Codex", &text.replace("\"id\":\"session\"", "\"id\":\"child\",\"session_id\":\"session\"")), None);
        assert_eq!(model("Codex", text.lines().skip(1).collect::<Vec<_>>().join("\n").as_str()), None);
    }
    #[test]
    fn native_model_unknown_or_partial_latest_context_never_uses_old_model() {
        let known = concat!(
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"session\"}}\n",
            "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5\"}}\n",
        );
        for suffix in [
            "{\"type\":\"turn_context\",\"payload\":{}}\n",
            "{\"type\":\"turn_context\",\"payload\":{\"model\":\" \"}}\n",
            "{\"type\":\"turn_context\",\"payload\":{\"model\":null}}\n",
            "{\"type\":\"turn_context\"",
            "invalid\n",
        ] {
            assert_eq!(model("Codex", &format!("{known}{suffix}")), None);
        }
        assert_eq!(model("Codex", "{\"type\":\"session_meta\",\"payload\":{\"id\":\"session\"}}\n"), None);
    }
    #[test]
    fn native_model_reads_grok_capture_without_guessing_defaults() {
        assert_eq!(model("Grok", r#"{"current_model_id":"grok-4.6"}"#).as_deref(), Some("grok-4.6"));
        for text in [r#"{"model":"grok-4.7"}"#, r#"{"current_model_id":null}"#, r#"{"current_model_id":" "}"#, "{}", "{"] {
            assert_eq!(model("Grok", text), None);
        }
    }
    #[test]
    fn native_model_reads_are_bounded_and_missing_history_is_unknown() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("native.jsonl");
        assert_eq!(native_model_path("Codex", "session", &path), None);
        for (provider, limit) in [("Codex", 16 * 1024 * 1024), ("Grok", 256 * 1024)] {
            let file = std::fs::File::create(&path).unwrap();
            file.set_len(limit + 1).unwrap();
            assert_eq!(native_model_path(provider, "session", &path), None);
        }
    }
    fn idle(provider: &str, lines: &[Value]) -> bool {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("native.jsonl");
        let text = lines.iter().map(|v| format!("{v}\n")).collect::<String>();
        std::fs::write(&path, text).unwrap();
        native_idle_path(provider, "session", &path, None)
    }
    #[test]
    fn codex_completion_must_match_latest_identified_turn() {
        let header = json!({"type":"session_meta","payload":{"id":"session"}});
        let start = |id: Value| json!({"type":"event_msg","payload":{"type":"task_started","turn_id":id}});
        let end = |id: Value| json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":id}});
        assert!(!idle("Codex", &[header.clone(), start(json!("parent")), end(json!("child"))]));
        assert!(idle("Codex", &[header.clone(), start(json!("parent")), end(json!("child")), end(json!("parent"))]));
        assert!(!idle("Codex", &[header.clone(), start(json!("parent")), end(Value::Null)]));
        assert!(!idle("Codex", &[header.clone(), start(Value::Null), end(Value::Null)]));
        assert!(!idle("Codex", &[header.clone(), end(json!("parent"))]));
        assert!(!idle("Codex", &[header, start(json!("old")), end(json!("old")), start(json!("new")), end(json!("old"))]));
    }
    #[test]
    fn codex_requires_exact_identity_and_native_completion() {
        let header = json!({"type":"session_meta","payload":{"id":"session"}});
        let turn = json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}});
        let complete = json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn"}});
        assert!(idle("Codex", &[header.clone(), turn.clone(), complete.clone()]));
        assert!(!idle("Codex", &[complete.clone()]));
        assert!(!idle("Codex", &[header.clone(), json!({"type":"response_item","payload":{"text":"task_complete"}})]));
        assert!(!idle("Codex", &[header, turn, json!({"type":"event_msg","payload":{"type":"exec_command_begin","call_id":"pending"}}), complete]));
    }
    #[test]
    fn codex_modern_unverified_execution_survives_task_completion() {
        let header = json!({"type":"session_meta","payload":{"id":"session"}});
        let turn = json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}});
        let complete = json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn"}});
        for pending in [
            json!({"type":"response_item","payload":{"type":"function_call","name":"functions.exec","call_id":"wrapper","arguments":"await tools.exec_command(...)"}}),
            json!({"type":"event_msg","payload":{"type":"item_started","item":{"type":"CommandExecution","id":"command"}}}),
            json!({"type":"event_msg","payload":{"type":"collab_agent_spawn_begin","call_id":"child"}}),
        ] {
            assert!(!idle("Codex", &[header.clone(), turn.clone(), pending, complete.clone()]));
        }
    }
    #[test]
    fn another_turn_completion_does_not_settle_active_parent() {
        let header = json!({"type":"session_meta","payload":{"id":"session"}});
        let start = json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"parent"}});
        let child = json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"child"}});
        let parent = json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"parent"}});
        assert!(!idle("Codex", &[header.clone(), start.clone(), child.clone()]));
        assert!(idle("Codex", &[header, start, child, parent]));
    }
    #[test]
    fn modern_command_requires_its_exact_terminal_receipt() {
        let header = json!({"type":"session_meta","payload":{"id":"session"}});
        let turn = json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}});
        let end = json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn"}});
        let start = json!({"type":"event_msg","payload":{"type":"item_started","item":{"type":"CommandExecution","id":"shell"}}});
        let receipt = |id: &str, exit: Value| json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","id":id,"status":"completed","exit_code":exit}}});
        assert!(idle("Codex", &[header.clone(), turn.clone(), start.clone(), end.clone(), receipt("shell",json!(0))]));
        assert!(!idle("Codex", &[header.clone(), turn.clone(), start.clone(), end.clone(), receipt("different",json!(0))]));
        assert!(!idle("Codex", &[header.clone(), turn.clone(), start.clone(), end.clone(), receipt("shell",Value::Null)]));
        let wrapper = json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"wrapper"}});
        assert!(!idle("Codex", &[header, turn, wrapper, start, receipt("shell",json!(0)), end]));
    }
    #[test]
    fn terminal_draft_requires_a_new_native_turn_after_input_checkpoint() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("native.jsonl");
        let header = json!({"type":"session_meta","payload":{"id":"session"}});
        let end = json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn"}});
        let old = format!("{header}\n{end}\n");
        std::fs::write(&path, &old).unwrap();
        let input_offset = old.len() as u64;
        assert!(!native_idle_path("Codex", "session", &path, Some(input_offset)));
        let start = json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}});
        std::fs::write(&path, format!("{old}{start}\n{end}\n")).unwrap();
        assert!(native_idle_path("Codex", "session", &path, Some(input_offset)));
    }
    #[test]
    fn grok_user_text_cannot_complete_a_turn_and_unfinished_tools_block_handoff() {
        let update = |kind: &str, rest: Value| json!({"method":"_x.ai/session/update","params":{"sessionId":"session","update":{
            "sessionUpdate":kind,"toolCallId":rest["id"],"status":rest["status"]}}});
        let end = update("turn_completed", Value::Null);
        assert!(idle("Grok", &[end.clone()]));
        assert!(!idle("Grok", &[end.clone(), update("user_message_chunk", Value::Null)]));
        assert!(!idle("Grok", &[update("tool_call",json!({"id":"t"})),end.clone()]));
        assert!(idle("Grok", &[update("tool_call",json!({"id":"t"})), update("tool_call_update",json!({"id":"t","status":"completed"})), end]));
        assert!(!idle("Grok", &[json!({"method":"session/update","params":{"sessionId":"session","update":{"sessionUpdate":"agent_message_chunk","content":{"text":"turn_completed"}}}})]));
    }
}
