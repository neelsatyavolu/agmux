use std::collections::{HashMap, HashSet, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

use crate::db::queries;
use crate::diff_stats;
use crate::process::kill::{kill_process_tree, pid_is_alive};
use crate::process::provider::build_augmented_path;
use crate::state::AppState;

pub type SidecarResponse = Result<Value, String>;

const LOG_BUFFER_CAP: usize = 500;

fn bridge_log_buffer() -> &'static StdMutex<VecDeque<String>> {
    static BUF: OnceLock<StdMutex<VecDeque<String>>> = OnceLock::new();
    BUF.get_or_init(|| StdMutex::new(VecDeque::with_capacity(LOG_BUFFER_CAP)))
}

fn push_bridge_log(line: &str) {
    if let Ok(mut buf) = bridge_log_buffer().lock() {
        if buf.len() == LOG_BUFFER_CAP {
            buf.pop_front();
        }
        buf.push_back(line.to_string());
    }
}

#[tauri::command]
pub async fn cursor_bridge_log_tail(lines: Option<usize>) -> Result<Vec<String>, String> {
    let want = lines.unwrap_or(200);
    let buf = bridge_log_buffer()
        .lock()
        .map_err(|e| format!("log buffer poisoned: {e}"))?;
    let start = buf.len().saturating_sub(want);
    Ok(buf.iter().skip(start).cloned().collect())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CursorSdkSessionContext {
    pub thread_id: String,
    pub agent_id: String,
    pub directory: String,
    pub model: Option<String>,
    pub current_run_id: Option<String>,
}

fn parse_sidecar_response(parsed: &Value) -> Option<(u64, SidecarResponse)> {
    let id = parsed.get("id")?.as_u64()?;
    if let Some(err) = parsed.get("error") {
        let msg = err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        return Some((id, Err(msg)));
    }
    let result = parsed.get("result").cloned().unwrap_or(Value::Null);
    Some((id, Ok(result)))
}

fn parse_orphan_error(parsed: &Value) -> Option<String> {
    if parsed.get("id").map(|v| v.is_null()).unwrap_or(false) {
        let msg = parsed
            .get("error")?
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        return Some(msg);
    }
    None
}

fn find_node_binary() -> Result<String, String> {
    let augmented_path = build_augmented_path();
    for dir in augmented_path.split(':') {
        let candidate = std::path::Path::new(dir).join("node");
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }
    Err("node binary not found on PATH".to_string())
}

fn resolve_bridge_path(app: &AppHandle) -> Result<String, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir
            .join("sidecar")
            .join("dist")
            .join("cursor-sdk-bridge.bundle.mjs");
        if bundled.exists() {
            return Ok(bundled.to_string_lossy().to_string());
        }
    }

    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let candidates = [
        cwd.join("sidecar").join("cursor-sdk-bridge.mjs"),
        cwd.parent()
            .map(|p| p.join("sidecar").join("cursor-sdk-bridge.mjs"))
            .unwrap_or_else(|| cwd.join("sidecar").join("cursor-sdk-bridge.mjs")),
    ];
    for candidate in candidates {
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    Err("cursor-sdk-bridge script not found. Run: cd sidecar && node build.mjs".to_string())
}

fn resolve_runtime_node_path(app: &AppHandle) -> Option<String> {
    let resource_dir = app.path().resource_dir().ok()?;
    let node_modules = resource_dir
        .join("sidecar")
        .join("dist")
        .join("cursor-sdk-runtime")
        .join("node_modules");
    node_modules
        .exists()
        .then(|| node_modules.to_string_lossy().to_string())
}

#[derive(Default)]
struct CursorLogAccumulator {
    chunks: Vec<CursorLogChunk>,
}

struct CursorLogChunk {
    log_type: &'static str,
    content: String,
}

impl CursorLogAccumulator {
    fn push(&mut self, log_type: &'static str, content: &str) {
        if let Some(last) = self.chunks.last_mut() {
            if last.log_type == log_type {
                last.content.push_str(content);
                return;
            }
        }
        self.chunks.push(CursorLogChunk {
            log_type,
            content: content.to_string(),
        });
    }
}

async fn flush_cursor_accumulator(
    db: &SqlitePool,
    thread_id: &str,
    acc: CursorLogAccumulator,
) {
    for chunk in acc.chunks {
        if chunk.content.trim().is_empty() {
            continue;
        }
        if let Err(e) = queries::insert_agent_log_typed(
            db,
            thread_id,
            "Output",
            &chunk.content,
            chunk.log_type,
        )
        .await
        {
            tracing::warn!(
                thread_id = %thread_id,
                error = %e,
                log_type = %chunk.log_type,
                "cursor agent_log insert failed (chunk flush)",
            );
        }
    }
}

async fn flush_cursor_accumulator_for_thread(
    db: &SqlitePool,
    accumulators: &mut HashMap<String, CursorLogAccumulator>,
    thread_id: &str,
) {
    if let Some(acc) = accumulators.remove(thread_id) {
        flush_cursor_accumulator(db, thread_id, acc).await;
    }
}

async fn insert_cursor_tool_use(db: &SqlitePool, thread_id: &str, parsed: &Value) {
    let content = json!({
        "toolUseId": parsed.get("toolUseId").cloned().unwrap_or(Value::Null),
        "parentToolUseId": parsed.get("parentToolUseId").cloned().unwrap_or(Value::Null),
        "name": parsed.get("name").cloned().unwrap_or(Value::Null),
        "input": parsed.get("input").cloned().unwrap_or(Value::Null),
    });
    if let Err(e) =
        queries::insert_agent_log_typed(db, thread_id, "Output", &content.to_string(), "tool_use")
            .await
    {
        tracing::warn!(
            thread_id = %thread_id,
            error = %e,
            "cursor agent_log insert failed (tool.started)",
        );
    }
}

async fn insert_cursor_tool_result(db: &SqlitePool, thread_id: &str, parsed: &Value) {
    let content = json!({
        "toolUseId": parsed.get("toolUseId").cloned().unwrap_or(Value::Null),
        "parentToolUseId": parsed.get("parentToolUseId").cloned().unwrap_or(Value::Null),
        "content": parsed.get("content").cloned().unwrap_or(Value::Null),
        "isError": parsed.get("isError").cloned().unwrap_or(Value::Null),
    });
    if let Err(e) = queries::insert_agent_log_typed(
        db,
        thread_id,
        "Output",
        &content.to_string(),
        "tool_result",
    )
    .await
    {
        tracing::warn!(
            thread_id = %thread_id,
            error = %e,
            "cursor agent_log insert failed (tool.completed)",
        );
    }
}

async fn insert_cursor_error(db: &SqlitePool, thread_id: &str, parsed: &Value) {
    let message = parsed
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if message.is_empty() {
        return;
    }
    if let Err(e) = queries::insert_agent_log_typed(db, thread_id, "Output", message, "text").await
    {
        tracing::warn!(
            thread_id = %thread_id,
            error = %e,
            "cursor agent_log insert failed (error)",
        );
    }
}

async fn insert_cursor_input_log(
    db: &SqlitePool,
    thread_id: &str,
    content: &str,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now()
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string();
    sqlx::query(
        "INSERT INTO agent_logs (id, thread_id, direction, content, log_type, timestamp)
         VALUES (?, ?, 'Input', ?, 'text', ?)",
    )
    .bind(&id)
    .bind(thread_id)
    .bind(content)
    .bind(&now)
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(id)
}

async fn delete_agent_log_by_id(db: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM agent_logs WHERE id = ?")
        .bind(id)
        .execute(db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn mark_cursor_send_running(
    db: &SqlitePool,
    thread_id: &str,
) -> Result<Option<String>, String> {
    let previous = sqlx::query_scalar::<_, String>("SELECT status FROM threads WHERE id = ?")
        .bind(thread_id)
        .fetch_optional(db)
        .await
        .map_err(|e| e.to_string())?;
    queries::update_thread_status(db, thread_id, "Running")
        .await
        .map_err(|e| e.to_string())?;
    Ok(previous)
}

/// Desktop sidebar spinner (`claudeProcessingById`) for headless / remote
/// Cursor sends when no ClaudeSdkSessionView is mounted. Same event Claude
/// open_turn / dispatch emit.
fn emit_cursor_session_processing(app: &AppHandle, thread_id: &str, processing: bool) {
    let _ = app.emit(
        "session-processing",
        json!({
            "threadId": thread_id,
            "processing": processing,
        }),
    );
}

async fn restore_cursor_send_status(
    db: &SqlitePool,
    thread_id: &str,
    previous_status: Option<&str>,
) -> Result<(), String> {
    if let Some(status) = previous_status {
        queries::update_thread_status(db, thread_id, status)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn is_immediate_send_rejection(err: &str) -> bool {
    let lowered = err.to_ascii_lowercase();
    lowered.contains("send already in flight") || lowered.contains("no cursor session")
}

fn is_cursor_bridge_io_failure(err: &str) -> bool {
    let lowered = err.to_ascii_lowercase();
    lowered.contains("failed to write to cursor-sdk-bridge stdin")
        || lowered.contains("failed to flush cursor-sdk-bridge stdin")
        || lowered.contains("cursor-sdk-bridge closed before responding")
        || lowered.contains("cursor-sdk-bridge exited before responding")
}

fn cursor_send_error_was_emitted(before_error_count: u64, after_error_count: u64) -> bool {
    after_error_count > before_error_count
}

async fn handle_cursor_non_event_send_failure(
    db: &SqlitePool,
    thread_id: &str,
    input_log_id: &str,
    previous_status: Option<&str>,
    err: &str,
) {
    if is_immediate_send_rejection(err) {
        if let Err(delete_err) = delete_agent_log_by_id(db, input_log_id).await {
            tracing::warn!(
                thread_id = %thread_id,
                log_id = %input_log_id,
                error = %delete_err,
                "failed to remove rejected cursor input log",
            );
        }
        if let Err(restore_err) =
            restore_cursor_send_status(db, thread_id, previous_status).await
        {
            tracing::warn!(
                thread_id = %thread_id,
                error = %restore_err,
                "failed to restore cursor thread status after rejected send",
            );
        }
    } else {
        update_cursor_thread_status(db, thread_id, "Error", "sendMessage failure").await;
    }
}

async fn cursor_error_event_count(
    counts: &Arc<Mutex<HashMap<String, u64>>>,
    thread_id: &str,
) -> u64 {
    counts.lock().await.get(thread_id).copied().unwrap_or(0)
}

async fn record_cursor_error_event(counts: &Arc<Mutex<HashMap<String, u64>>>, thread_id: &str) {
    let mut guard = counts.lock().await;
    *guard.entry(thread_id.to_string()).or_insert(0) += 1;
}

async fn record_cursor_fallback_error(
    counts: &Arc<Mutex<HashMap<String, u64>>>,
    suppress_next_bridge_exit_error_threads: &Arc<Mutex<HashSet<String>>>,
    thread_id: &str,
    err: &str,
) {
    if is_cursor_bridge_io_failure(err) {
        suppress_next_bridge_exit_error_threads
            .lock()
            .await
            .insert(thread_id.to_string());
    }
    record_cursor_error_event(counts, thread_id).await;
}

fn emit_cursor_fallback_error(app: &AppHandle, thread_id: &str, message: &str) {
    let channel = format!("sdk-event-{}", thread_id);
    let _ = app.emit(&channel, json!({ "type": "error", "message": message }));
}

async fn cursor_bridge_exit_error_events(
    counts: &Arc<Mutex<HashMap<String, u64>>>,
    suppress_next_bridge_exit_error_threads: &Arc<Mutex<HashSet<String>>>,
    thread_ids: &[String],
) -> Vec<(String, Value)> {
    let thread_ids = {
        let mut suppress = suppress_next_bridge_exit_error_threads.lock().await;
        thread_ids
            .iter()
            .filter(|thread_id| !suppress.remove(*thread_id))
            .cloned()
            .collect::<Vec<_>>()
    };
    {
        let mut guard = counts.lock().await;
        for thread_id in &thread_ids {
            *guard.entry(thread_id.clone()).or_insert(0) += 1;
        }
    }
    thread_ids
        .iter()
        .map(|thread_id| {
            (
                format!("sdk-event-{}", thread_id),
                json!({
                    "type": "error",
                    "message": "cursor-sdk-bridge exited",
                }),
            )
        })
        .collect()
}

async fn update_cursor_thread_status(db: &SqlitePool, thread_id: &str, status: &str, reason: &str) {
    if let Err(e) = queries::update_thread_status(db, thread_id, status).await {
        tracing::warn!(
            thread_id = %thread_id,
            status = %status,
            error = %e,
            "cursor thread status update failed ({reason})",
        );
    }
}

async fn update_current_run_id(
    sessions: &Arc<Mutex<HashMap<String, CursorSdkSessionContext>>>,
    thread_id: &str,
    run_id: Option<String>,
) {
    if let Some(ctx) = sessions.lock().await.get_mut(thread_id) {
        ctx.current_run_id = run_id;
    }
}

fn field_str(value: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(s) = value.get(*key).and_then(|v| v.as_str()) {
            if !s.is_empty() {
                return s.to_string();
            }
        }
    }
    String::new()
}

fn count_content_lines(s: &str) -> u64 {
    if s.is_empty() {
        0
    } else {
        s.split('\n').count() as u64
    }
}

fn is_cursor_file_tool(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "edit"
            | "write"
            | "delete"
            | "apply_patch"
            | "apply_patch_freeform"
            | "patch"
            | "applyagentdiff"
            | "multiedit"
            | "multi_edit"
    )
}

fn parse_cursor_result_value(content: &Value) -> Option<Value> {
    let parsed = match content {
        Value::Object(_) => content.clone(),
        Value::String(s) => {
            let trimmed = s.trim();
            if !trimmed.starts_with('{') {
                return None;
            }
            serde_json::from_str::<Value>(trimmed).ok()?
        }
        _ => return None,
    };
    if let Some(value) = parsed.get("value") {
        return Some(value.clone());
    }
    Some(parsed)
}

/// `(added, removed, file_path)` for a Cursor file-mutating tool.
/// Prefers provider-reported `linesAdded` / `linesRemoved` / `linesCreated`.
fn cursor_tool_line_delta(name: &str, input: &Value, content: &Value) -> (u64, u64, Option<String>) {
    let path = field_str(input, &["file_path", "filePath", "path"]);
    let file_path = if path.is_empty() { None } else { Some(path) };
    let lowered = name.to_ascii_lowercase();

    if let Some(value) = parse_cursor_result_value(content) {
        let added = value
            .get("linesAdded")
            .and_then(|v| v.as_u64())
            .or_else(|| value.get("linesCreated").and_then(|v| v.as_u64()))
            .unwrap_or(0);
        let removed = value.get("linesRemoved").and_then(|v| v.as_u64()).unwrap_or(0);
        if added > 0 || removed > 0 {
            return (added, removed, file_path);
        }
    }

    match lowered.as_str() {
        "write" => {
            let body = field_str(input, &["content", "fileText", "new_string"]);
            (count_content_lines(&body), 0, file_path)
        }
        "edit" | "apply_patch" | "apply_patch_freeform" | "patch" | "applyagentdiff" => {
            let old = field_str(input, &["old_string", "oldString", "oldText"]);
            let new_s = field_str(input, &["new_string", "newString", "newText"]);
            (count_content_lines(&new_s), count_content_lines(&old), file_path)
        }
        "multiedit" | "multi_edit" => {
            let mut added = 0u64;
            let mut removed = 0u64;
            if let Some(edits) = input.get("edits").and_then(|v| v.as_array()) {
                for edit in edits {
                    let old = field_str(edit, &["old_string", "oldString", "oldText"]);
                    let new_s = field_str(edit, &["new_string", "newString", "newText"]);
                    added += count_content_lines(&new_s);
                    removed += count_content_lines(&old);
                }
            }
            (added, removed, file_path)
        }
        _ => (0, 0, file_path),
    }
}

async fn persist_cursor_event(
    db: &SqlitePool,
    sessions: &Arc<Mutex<HashMap<String, CursorSdkSessionContext>>>,
    accumulators: &mut HashMap<String, CursorLogAccumulator>,
    thread_id: &str,
    parsed: &Value,
) {
    let event_type = match parsed.get("type").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return,
    };

    match event_type {
        "content.delta" => {
            let text = parsed.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if text.is_empty() {
                return;
            }
            let acc = accumulators.entry(thread_id.to_string()).or_default();
            match parsed
                .get("contentType")
                .and_then(|v| v.as_str())
                .unwrap_or("text")
            {
                "thinking" => acc.push("thinking", text),
                _ => acc.push("text", text),
            }
        }
        "turn.completed" => {
            flush_cursor_accumulator_for_thread(db, accumulators, thread_id).await;
            update_current_run_id(sessions, thread_id, None).await;
            update_cursor_thread_status(db, thread_id, "Idle", event_type).await;
        }
        "session.ended" => {
            flush_cursor_accumulator_for_thread(db, accumulators, thread_id).await;
            update_current_run_id(sessions, thread_id, None).await;
            let status = if parsed.get("reason").and_then(|v| v.as_str()) == Some("error") {
                "Error"
            } else {
                "Idle"
            };
            update_cursor_thread_status(db, thread_id, status, event_type).await;
        }
        "error" => {
            flush_cursor_accumulator_for_thread(db, accumulators, thread_id).await;
            insert_cursor_error(db, thread_id, parsed).await;
            update_current_run_id(sessions, thread_id, None).await;
            update_cursor_thread_status(db, thread_id, "Error", "error").await;
        }
        "tool.started" => {
            flush_cursor_accumulator_for_thread(db, accumulators, thread_id).await;
            insert_cursor_tool_use(db, thread_id, parsed).await;
        }
        "tool.completed" => {
            flush_cursor_accumulator_for_thread(db, accumulators, thread_id).await;
            insert_cursor_tool_result(db, thread_id, parsed).await;
        }
        "status" => {
            let run_id = parsed
                .get("runId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if run_id.is_some() {
                update_current_run_id(sessions, thread_id, run_id).await;
            }
        }
        _ => {}
    }
}

pub struct CursorBridge {
    execution_generations: super::execution_generation::ExecutionGenerations,
    pub pid: u32,
    #[allow(dead_code)]
    pub child: Arc<Mutex<Child>>,
    pub stdin: Arc<Mutex<ChildStdin>>,
    pub is_shutting_down: Arc<AtomicBool>,
    pub next_request_id: Arc<Mutex<u64>>,
    pub pending_responses: Arc<Mutex<HashMap<u64, oneshot::Sender<SidecarResponse>>>>,
    pub error_event_counts: Arc<Mutex<HashMap<String, u64>>>,
    pub suppress_next_bridge_exit_error_threads: Arc<Mutex<HashSet<String>>>,
}

impl Drop for CursorBridge {
    fn drop(&mut self) {
        if self.pid != 0 && !self.is_shutting_down.load(Ordering::Relaxed) {
            kill_process_tree(self.pid);
        }
    }
}

impl CursorBridge {
    pub async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        let execution = matches!(method, "startSession" | "sendMessage" | "setModel");
        let thread_id = params.get("threadId").and_then(Value::as_str).unwrap_or("");
        let cancel = matches!(method, "interrupt" | "stopSession");
        let ticket = if execution || cancel {
            Some(self.execution_generations.capture(thread_id, cancel).await)
        } else { None };
        if execution {
            crate::teams::policy::refresh_for_execution().await?;
            // Only explicit transport configuration is known here. Missing or
            // inherited configuration must not be inferred from UI settings.
            crate::teams::policy::enforce("Cursor", "chat",
                params.get("model").and_then(|v| v.as_str()),
                params.get("effort").and_then(|v| v.as_str()))?;
        }
        let mut id_guard = self.next_request_id.lock().await;
        *id_guard += 1;
        let id = *id_guard;
        drop(id_guard);

        let (tx, rx) = oneshot::channel();
        self.pending_responses.lock().await.insert(id, tx);

        let req = json!({ "id": id, "method": method, "params": params });
        let mut line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        line.push('\n');

        {
            let mut stdin = self.stdin.lock().await;
            if execution {
                if let Some(ticket) = &ticket {
                    if let Err(error) = ticket.validate() {
                        self.pending_responses.lock().await.remove(&id);
                        return Err(error);
                    }
                }
            }
            if let Err(err) = stdin.write_all(line.as_bytes()).await {
                self.pending_responses.lock().await.remove(&id);
                return Err(format!(
                    "Failed to write to cursor-sdk-bridge stdin: {}",
                    err
                ));
            }
            if let Err(err) = stdin.flush().await {
                self.pending_responses.lock().await.remove(&id);
                return Err(format!(
                    "Failed to flush cursor-sdk-bridge stdin: {}",
                    err
                ));
            }
        }

        let timeout = if method == "sendMessage" {
            std::time::Duration::from_secs(60 * 60 * 24)
        } else if method == "authLogin" {
            // Browser OAuth poll can take several minutes.
            std::time::Duration::from_secs(60 * 10)
        } else {
            std::time::Duration::from_secs(30)
        };

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!(
                "cursor-sdk-bridge closed before responding to {}",
                method
            )),
            Err(_) => {
                self.pending_responses.lock().await.remove(&id);
                Err(format!(
                    "Timed out waiting for cursor-sdk-bridge response to {}",
                    method
                ))
            }
        }
    }
}

async fn spawn_bridge(app: &AppHandle) -> Result<Arc<CursorBridge>, String> {
    let node = find_node_binary()?;
    let bridge_path = resolve_bridge_path(app)?;

    let mut cmd = Command::new(&node);
    cmd.arg(&bridge_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PATH", build_augmented_path())
        .kill_on_drop(true);
    if let Some(node_path) = resolve_runtime_node_path(app) {
        cmd.env("NODE_PATH", node_path);
    }

    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn cursor-sdk-bridge: {}", e))?;
    let pid = child.id().unwrap_or(0);
    if pid == 0 {
        tracing::warn!("cursor-sdk-bridge spawned without a PID; cleanup may be incomplete");
    }

    let stdin = child.stdin.take().ok_or("bridge stdin missing")?;
    let stdout = child.stdout.take().ok_or("bridge stdout missing")?;
    let stderr = child.stderr.take().ok_or("bridge stderr missing")?;

    let pending_responses: Arc<Mutex<HashMap<u64, oneshot::Sender<SidecarResponse>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let is_shutting_down = Arc::new(AtomicBool::new(false));
    let error_event_counts: Arc<Mutex<HashMap<String, u64>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let suppress_next_bridge_exit_error_threads: Arc<Mutex<HashSet<String>>> =
        Arc::new(Mutex::new(HashSet::new()));
    let child_arc = Arc::new(Mutex::new(child));

    let bridge = Arc::new(CursorBridge {
        execution_generations: Default::default(),
        pid,
        child: child_arc.clone(),
        stdin: Arc::new(Mutex::new(stdin)),
        is_shutting_down: is_shutting_down.clone(),
        next_request_id: Arc::new(Mutex::new(0)),
        pending_responses: pending_responses.clone(),
        error_event_counts: error_event_counts.clone(),
        suppress_next_bridge_exit_error_threads: suppress_next_bridge_exit_error_threads.clone(),
    });

    let stderr_app = app.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::debug!(target: "cursor_sdk_bridge", "{}", line);
            push_bridge_log(&line);
            let _ = stderr_app.emit("cursor-bridge-log", &line);
        }
    });

    let app_clone = app.clone();
    let pending_clone = pending_responses.clone();
    let state: tauri::State<AppState> = app.state();
    let db = state.db.clone();
    let sessions = state.cursor_sdk_sessions.clone();
    let bridge_slot = state.cursor_sdk_bridge.clone();
    let bridge_for_reader = bridge.clone();
    let error_counts = error_event_counts.clone();
    let suppress_bridge_exit_errors = suppress_next_bridge_exit_error_threads.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        let mut accumulators: HashMap<String, CursorLogAccumulator> = HashMap::new();
        let mut pending_edits: HashMap<String, (String, Value)> = HashMap::new();
        let mut touched_files: HashMap<String, HashSet<String>> = HashMap::new();

        while let Ok(Some(line)) = lines.next_line().await {
            let parsed: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(err) => {
                    let log_line = format!("[bridge stdout parse error] {}: {}", err, line);
                    tracing::warn!(target: "cursor_sdk_bridge", "{}", log_line);
                    push_bridge_log(&log_line);
                    let _ = app_clone.emit("cursor-bridge-log", &log_line);
                    continue;
                }
            };

            if let Some((id, response)) = parse_sidecar_response(&parsed) {
                if let Some(tx) = pending_clone.lock().await.remove(&id) {
                    let _ = tx.send(response);
                }
                continue;
            }

            if let Some(msg) = parse_orphan_error(&parsed) {
                let log_line = format!("[bridge orphan error] {}", msg);
                tracing::warn!(target: "cursor_sdk_bridge", "{}", log_line);
                push_bridge_log(&log_line);
                let _ = app_clone.emit("cursor-bridge-log", &log_line);
                continue;
            }

            let thread_id = match parsed.get("threadId").and_then(|v| v.as_str()) {
                Some(t) => t.to_string(),
                None => continue,
            };

            if parsed.get("type").and_then(|v| v.as_str()) == Some("error") {
                record_cursor_error_event(&error_counts, &thread_id).await;
            }
            crate::shell_diff::observe_sdk(&app_clone, &thread_id, &parsed).await;
            persist_cursor_event(&db, &sessions, &mut accumulators, &thread_id, &parsed).await;

            match parsed.get("type").and_then(|v| v.as_str()) {
                Some("tool.started") => {
                    if let (Some(tool_use_id), Some(tool_name)) = (
                        parsed.get("toolUseId").and_then(|v| v.as_str()),
                        parsed.get("name").and_then(|v| v.as_str()),
                    ) {
                        if is_cursor_file_tool(tool_name) {
                            let input = parsed.get("input").cloned().unwrap_or(Value::Null);
                            pending_edits.insert(
                                format!("{thread_id}:{tool_use_id}"),
                                (tool_name.to_string(), input),
                            );
                        }
                    }
                }
                Some("tool.completed") => {
                    let is_error = parsed
                        .get("isError")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    if !is_error {
                        if let Some(tool_use_id) = parsed.get("toolUseId").and_then(|v| v.as_str())
                        {
                            let key = format!("{thread_id}:{tool_use_id}");
                            if let Some((tool_name, input)) = pending_edits.remove(&key) {
                                let content = parsed.get("content").cloned().unwrap_or(Value::Null);
                                let (added, removed, file_path) =
                                    cursor_tool_line_delta(&tool_name, &input, &content);
                                let files_delta = if let Some(fp) = file_path {
                                    let files = touched_files.entry(thread_id.clone()).or_default();
                                    if files.insert(fp) { 1 } else { 0 }
                                } else {
                                    0
                                };
                                if added > 0 || removed > 0 || files_delta > 0 {
                                    let app_emit = app_clone.clone();
                                    let db_emit = db.clone();
                                    let tid = thread_id.clone();
                                    tokio::spawn(async move {
                                        if let Err(e) = diff_stats::record_thread_diff_delta(
                                            &app_emit, &db_emit, &tid, added, removed, files_delta,
                                        )
                                        .await
                                        {
                                            tracing::warn!(
                                                thread_id = %tid,
                                                error = %e,
                                                "cursor diff_stats update failed",
                                            );
                                        }
                                    });
                                }
                            }
                        }
                    }
                }
                _ => {}
            }

            // Keep desktop sidebar spinner in sync for headless / remounted
            // sessions (mirrors open_turn/close_turn for Claude).
            match parsed.get("type").and_then(|v| v.as_str()) {
                Some("turn.completed") | Some("session.ended") | Some("error") => {
                    emit_cursor_session_processing(&app_clone, &thread_id, false);
                }
                Some("status") => {
                    let status = parsed
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    if matches!(
                        status.as_str(),
                        "running" | "started" | "in_progress" | "in-progress"
                    ) {
                        emit_cursor_session_processing(&app_clone, &thread_id, true);
                    }
                }
                _ => {}
            }

            let channel = format!("sdk-event-{}", thread_id);
            let _ = app_clone.emit(&channel, parsed);
        }

        for (thread_id, acc) in accumulators.drain() {
            flush_cursor_accumulator(&db, &thread_id, acc).await;
            update_current_run_id(&sessions, &thread_id, None).await;
        }

        bridge_for_reader
            .is_shutting_down
            .store(true, Ordering::Relaxed);
        let cleared_current_bridge = {
            let mut guard = bridge_slot.lock().await;
            if guard
                .as_ref()
                .map(|current| Arc::ptr_eq(current, &bridge_for_reader))
                .unwrap_or(false)
            {
                *guard = None;
                true
            } else {
                false
            }
        };
        let mut should_kill_process_group = false;
        if cleared_current_bridge {
            let thread_ids = {
                let guard = sessions.lock().await;
                let mut ids = guard.keys().cloned().collect::<Vec<_>>();
                ids.sort();
                ids
            };
            for thread_id in &thread_ids {
                crate::shell_diff::observe_sdk(
                    &app_clone, thread_id, &json!({ "type": "session.ended", "reason": "error" }),
                ).await;
                update_cursor_thread_status(&db, thread_id, "Error", "bridge eof").await;
            }
            {
                let mut guard = sessions.lock().await;
                guard.clear();
            }
            for (channel, payload) in
                cursor_bridge_exit_error_events(
                    &error_counts,
                    &suppress_bridge_exit_errors,
                    &thread_ids,
                )
                .await
            {
                let _ = app_clone.emit(&channel, payload);
            }
            should_kill_process_group = true;
        }

        let mut pending = pending_clone.lock().await;
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(
                "cursor-sdk-bridge exited before responding".to_string()
            ));
        }

        let child_arc = bridge_for_reader.child.clone();
        let pid = bridge_for_reader.pid;
        tokio::spawn(async move {
            if should_kill_process_group && pid != 0 {
                kill_process_tree(pid);
            }
            let wait_result = tokio::time::timeout(std::time::Duration::from_secs(2), async {
                let mut child = child_arc.lock().await;
                child.wait().await
            })
            .await;
            if wait_result.is_err() && pid != 0 && pid_is_alive(pid) {
                kill_process_tree(pid);
                let mut child = child_arc.lock().await;
                let _ = child.wait().await;
            }
        });
    });

    Ok(bridge)
}

async fn get_or_spawn_bridge(
    app: &AppHandle,
    state: &AppState,
) -> Result<Arc<CursorBridge>, String> {
    let mut guard = state.cursor_sdk_bridge.lock().await;
    if let Some(bridge) = guard.as_ref() {
        if bridge.pid == 0 || pid_is_alive(bridge.pid) {
            return Ok(bridge.clone());
        }
        *guard = None;
    }
    let bridge = spawn_bridge(app).await?;
    *guard = Some(bridge.clone());
    Ok(bridge)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorStartArgs {
    pub thread_id: String,
    pub directory: String,
    pub model: Option<String>,
    pub resume_agent_id: Option<String>,
    pub mode: Option<String>,
    /// Cursor local tool policy: `default` (sandbox), `auto` (auto-review), `full`.
    pub permission_mode: Option<String>,
}

#[tauri::command]
pub async fn cursor_sdk_check_available(app: AppHandle) -> Result<bool, String> {
    Ok(find_node_binary().is_ok() && resolve_bridge_path(&app).is_ok())
}

#[tauri::command]
pub async fn cursor_sdk_start_session(
    app: AppHandle,
    state: State<'_, AppState>,
    args: CursorStartArgs,
) -> Result<String, String> {
    // Serialize starts without blocking the event reader's session-map lock.
    // A reused sidecar context must never be mistaken for native creation.
    static START_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _start = START_LOCK.lock().await;
    let bridge = get_or_spawn_bridge(&app, &state).await?;
    let existing_agent_id: Option<String> =
        sqlx::query_scalar("SELECT sdk_session_id FROM threads WHERE id = ?")
            .bind(&args.thread_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| e.to_string())?
            .flatten();
    let resume_agent_id = args.resume_agent_id.clone().filter(|sid| !sid.is_empty())
        .or(existing_agent_id.filter(|sid| !sid.is_empty()));

    queries::record_thread_session_start(&state.db, &args.thread_id, resume_agent_id.as_deref()).await?;

    let result = bridge
        .send_request(
            "startSession",
            json!({
                "threadId": args.thread_id,
                "directory": args.directory,
                "model": args.model,
                "mode": args.mode,
                "permissionMode": args.permission_mode,
                "resumeAgentId": resume_agent_id,
            }),
        )
        .await?;

    let agent_id = result
        .get("agentId")
        .and_then(|v| v.as_str())
        .ok_or("cursor-sdk-bridge startSession response missing agentId")?
        .to_string();
    let model = result
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or(args.model.clone());

    if resume_agent_id.is_none() && result.get("resumed").and_then(Value::as_bool) == Some(false) {
        crate::teams::ownership::record_native_creation(&state.db, "Cursor", &args.thread_id, &agent_id).await?;
    } else {
        queries::record_thread_session_start(&state.db, &args.thread_id, Some(&agent_id)).await?;
    }
    queries::bind_thread_session(&state.db, &args.thread_id, &agent_id).await?;

    sqlx::query(
        "UPDATE threads SET sdk_session_id = ?1, model = COALESCE(?2, model), last_active = datetime('now') WHERE id = ?3",
    )
    .bind(&agent_id)
    .bind(model.as_deref())
    .bind(&args.thread_id)
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    state.cursor_sdk_sessions.lock().await.insert(
        args.thread_id.clone(),
        CursorSdkSessionContext {
            thread_id: args.thread_id,
            agent_id: agent_id.clone(),
            directory: args.directory,
            model,
            current_run_id: None,
        },
    );

    Ok(agent_id)
}

#[tauri::command]
pub async fn cursor_sdk_send_message(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    text: String,
    images: Option<Vec<Value>>,
    mode: Option<String>,
) -> Result<(), String> {
    let bridge = match state.cursor_sdk_bridge.lock().await.as_ref().cloned() {
        Some(bridge) => bridge,
        None => {
            let err = "cursor bridge not initialized".to_string();
            emit_cursor_fallback_error(&app, &thread_id, &err);
            return Err(err);
        }
    };

    let before_error_count = cursor_error_event_count(&bridge.error_event_counts, &thread_id).await;
    let input_log_id = match insert_cursor_input_log(&state.db, &thread_id, &text).await {
        Ok(id) => id,
        Err(err) => {
            emit_cursor_fallback_error(&app, &thread_id, &err);
            return Err(err);
        }
    };
    let previous_status = match mark_cursor_send_running(&state.db, &thread_id).await {
        Ok(status) => status,
        Err(err) => {
            if let Err(delete_err) = delete_agent_log_by_id(&state.db, &input_log_id).await {
                tracing::warn!(
                    thread_id = %thread_id,
                    log_id = %input_log_id,
                    error = %delete_err,
                    "failed to remove cursor input log after status update failure",
                );
            }
            emit_cursor_fallback_error(&app, &thread_id, &err);
            return Err(err);
        }
    };
    // Sidebar spinner for headless remote / any path without a mounted view.
    // Local CursorSdkSessionView also sets claudeProcessingById on send.
    emit_cursor_session_processing(&app, &thread_id, true);

    let model = state
        .cursor_sdk_sessions
        .lock()
        .await
        .get(&thread_id)
        .and_then(|ctx| ctx.model.clone());

    let result = bridge
        .send_request(
            "sendMessage",
            json!({
                "threadId": thread_id,
                "text": text,
                "images": images.unwrap_or_default(),
                "model": model,
                "mode": mode,
            }),
        )
        .await;

    if let Err(err) = result {
        let after_error_count =
            cursor_error_event_count(&bridge.error_event_counts, &thread_id).await;
        if cursor_send_error_was_emitted(before_error_count, after_error_count) {
            // Event path already cleared status / processing via error handler.
            return Ok(());
        }
        // Record before DB cleanup: stdout EOF may race while cleanup awaits.
        record_cursor_fallback_error(
            &bridge.error_event_counts,
            &bridge.suppress_next_bridge_exit_error_threads,
            &thread_id,
            &err,
        )
        .await;
        handle_cursor_non_event_send_failure(
            &state.db,
            &thread_id,
            &input_log_id,
            previous_status.as_deref(),
            &err,
        )
        .await;
        emit_cursor_session_processing(&app, &thread_id, false);
        emit_cursor_fallback_error(&app, &thread_id, &err);
        return Err(err);
    }

    Ok(())
}

#[tauri::command]
pub async fn cursor_sdk_interrupt(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), String> {
    let bridge_opt = state.cursor_sdk_bridge.lock().await.as_ref().cloned();
    if let Some(bridge) = bridge_opt {
        bridge
            .send_request("interrupt", json!({ "threadId": thread_id }))
            .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn cursor_sdk_set_model(
    state: State<'_, AppState>,
    thread_id: String,
    model: String,
) -> Result<(), String> {
    let bridge = state
        .cursor_sdk_bridge
        .lock()
        .await
        .as_ref()
        .ok_or("cursor bridge not initialized")?
        .clone();
    bridge
        .send_request(
            "setModel",
            json!({
                "threadId": thread_id,
                "model": model,
            }),
        )
        .await?;

    if let Some(ctx) = state.cursor_sdk_sessions.lock().await.get_mut(&thread_id) {
        ctx.model = Some(model.clone());
    }
    sqlx::query("UPDATE threads SET model = ?1, last_active = datetime('now') WHERE id = ?2")
        .bind(&model)
        .bind(&thread_id)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn cursor_sdk_stop_session(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), String> {
    let bridge_opt = state.cursor_sdk_bridge.lock().await.as_ref().cloned();
    if let Some(bridge) = bridge_opt {
        let _ = bridge
            .send_request("stopSession", json!({ "threadId": thread_id }))
            .await;
    }
    state.cursor_sdk_sessions.lock().await.remove(&thread_id);
    update_cursor_thread_status(&state.db, &thread_id, "Idle", "stopSession").await;
    Ok(())
}

pub async fn get_cursor_history_rows(
    pool: &SqlitePool,
    thread_id: &str,
    limit: i64,
) -> anyhow::Result<Vec<crate::db::models::AgentLog>> {
    let mut rows = queries::get_agent_logs(pool, thread_id, limit).await?;
    rows.reverse();
    Ok(rows)
}

#[tauri::command]
pub async fn cursor_sdk_get_history(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<Vec<crate::db::models::AgentLog>, String> {
    get_cursor_history_rows(&state.db, &thread_id, 1000)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cursor_sdk_list_models(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let bridge = get_or_spawn_bridge(&app, &state).await?;
    bridge.send_request("listModels", json!({})).await
}

#[tauri::command]
pub async fn cursor_sdk_set_permission_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    mode: String,
) -> Result<Value, String> {
    let bridge = get_or_spawn_bridge(&app, &state).await?;
    bridge
        .send_request(
            "setPermissionMode",
            json!({
                "threadId": thread_id,
                "mode": mode,
            }),
        )
        .await
}

#[tauri::command]
pub async fn cursor_sdk_auth_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let bridge = get_or_spawn_bridge(&app, &state).await?;
    bridge.send_request("authStatus", json!({})).await
}

#[tauri::command]
pub async fn cursor_sdk_auth_login(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let bridge = get_or_spawn_bridge(&app, &state).await?;
    bridge
        .send_request("authLogin", json!({ "openBrowser": true }))
        .await
}

#[tauri::command]
pub async fn cursor_sdk_auth_logout(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let bridge = get_or_spawn_bridge(&app, &state).await?;
    bridge.send_request("authLogout", json!({})).await
}

pub async fn shutdown_cursor_bridge_resources(
    bridge_slot: Arc<Mutex<Option<Arc<CursorBridge>>>>,
    sessions: Arc<Mutex<HashMap<String, CursorSdkSessionContext>>>,
) -> Result<(), String> {
    let bridge_opt = {
        let mut guard = bridge_slot.lock().await;
        guard.take()
    };
    if let Some(bridge) = bridge_opt {
        bridge.is_shutting_down.store(true, Ordering::Relaxed);
        let pid = bridge.pid;
        let child_arc = bridge.child.clone();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            bridge.send_request("shutdown", json!({})),
        )
        .await;
        if pid != 0 && pid_is_alive(pid) {
            kill_process_tree(pid);
        }
        let mut child = child_arc.lock().await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await;
    }
    sessions.lock().await.clear();
    Ok(())
}

#[tauri::command]
pub async fn cursor_sdk_shutdown_bridge(state: State<'_, AppState>) -> Result<(), String> {
    shutdown_cursor_bridge_resources(
        state.cursor_sdk_bridge.clone(),
        state.cursor_sdk_sessions.clone(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        cursor_bridge_exit_error_events, cursor_error_event_count, cursor_send_error_was_emitted,
        cursor_tool_line_delta, get_cursor_history_rows, handle_cursor_non_event_send_failure,
        insert_cursor_input_log, mark_cursor_send_running, parse_sidecar_response,
        persist_cursor_event, record_cursor_fallback_error, CursorLogAccumulator,
        CursorSdkSessionContext,
    };
    use crate::db::queries;
    use std::collections::{HashMap, HashSet};
    use std::sync::Arc;
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;
    use tokio::sync::Mutex;
    use uuid::Uuid;

    async fn fresh_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("failed to open in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migrations should apply cleanly");
        pool
    }

    async fn make_cursor_thread(pool: &sqlx::SqlitePool) -> String {
        let project = queries::create_project(pool, "Cursor Test", "/tmp/cursor-test")
            .await
            .unwrap();
        let thread_id = Uuid::new_v4().to_string();
        queries::create_thread(
            pool,
            &thread_id,
            &project.id,
            "cursor",
            "Cursor",
            "/tmp/cursor-test",
            "/tmp/cursor-test/state",
            Some("gpt-5"),
            None,
            false,
            "DirectRepo",
            None,
            Some("cursor-sdk"),
            None,
        )
        .await
        .unwrap();
        thread_id
    }

    #[test]
    fn parse_cursor_sidecar_response_success() {
        let parsed = json!({ "id": 7, "result": { "agentId": "agent-1" } });

        let (id, response) = parse_sidecar_response(&parsed).expect("response should parse");

        assert_eq!(id, 7);
        assert_eq!(response.unwrap()["agentId"], "agent-1");
    }

    #[test]
    fn parse_cursor_sidecar_response_error() {
        let parsed = json!({ "id": 8, "error": { "message": "bad key" } });

        let (id, response) = parse_sidecar_response(&parsed).expect("response should parse");

        assert_eq!(id, 8);
        assert_eq!(response.unwrap_err(), "bad key");
    }

    #[tokio::test]
    async fn cursor_send_running_helper_updates_thread_status() {
        let pool = fresh_pool().await;
        let thread_id = make_cursor_thread(&pool).await;

        let previous = mark_cursor_send_running(&pool, &thread_id).await.unwrap();
        let thread = queries::get_thread(&pool, &thread_id).await.unwrap();

        assert_eq!(previous.as_deref(), Some("Idle"));
        assert_eq!(thread.status, "Running");
    }

    #[tokio::test]
    async fn cursor_bridge_exit_error_events_target_active_threads_and_increment_counts() {
        let counts: Arc<Mutex<HashMap<String, u64>>> = Arc::new(Mutex::new(HashMap::new()));
        let suppress: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        let events = cursor_bridge_exit_error_events(&counts, &suppress, &[
            "thread-a".to_string(),
            "thread-b".to_string(),
        ])
        .await;

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, "sdk-event-thread-a");
        assert_eq!(events[0].1, json!({
            "type": "error",
            "message": "cursor-sdk-bridge exited",
        }));
        assert_eq!(events[1].0, "sdk-event-thread-b");
        assert_eq!(events[1].1, json!({
            "type": "error",
            "message": "cursor-sdk-bridge exited",
        }));
        assert_eq!(cursor_error_event_count(&counts, "thread-a").await, 1);
        assert_eq!(cursor_error_event_count(&counts, "thread-b").await, 1);
    }

    #[tokio::test]
    async fn cursor_bridge_exit_error_events_suppresses_only_marked_thread() {
        let counts: Arc<Mutex<HashMap<String, u64>>> = Arc::new(Mutex::new(HashMap::new()));
        let suppress: Arc<Mutex<HashSet<String>>> =
            Arc::new(Mutex::new(HashSet::from(["thread-a".to_string()])));
        let events = cursor_bridge_exit_error_events(&counts, &suppress, &[
            "thread-a".to_string(),
            "thread-b".to_string(),
        ])
        .await;

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "sdk-event-thread-b");
        assert_eq!(events[0].1, json!({
            "type": "error",
            "message": "cursor-sdk-bridge exited",
        }));
        assert_eq!(cursor_error_event_count(&counts, "thread-a").await, 0);
        assert_eq!(cursor_error_event_count(&counts, "thread-b").await, 1);
        assert!(suppress.lock().await.is_empty());
    }

    #[tokio::test]
    async fn cursor_bridge_io_fallback_records_next_exit_suppression() {
        let counts: Arc<Mutex<HashMap<String, u64>>> = Arc::new(Mutex::new(HashMap::new()));
        let suppress: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

        record_cursor_fallback_error(
            &counts,
            &suppress,
            "thread-a",
            "Failed to write to cursor-sdk-bridge stdin: broken pipe",
        )
        .await;

        assert_eq!(cursor_error_event_count(&counts, "thread-a").await, 1);
        assert!(suppress.lock().await.contains("thread-a"));
    }

    #[tokio::test]
    async fn cursor_bridge_io_fallback_recorded_before_exit_suppresses_synthetic_error() {
        let counts: Arc<Mutex<HashMap<String, u64>>> = Arc::new(Mutex::new(HashMap::new()));
        let suppress: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

        record_cursor_fallback_error(
            &counts,
            &suppress,
            "thread-a",
            "cursor-sdk-bridge closed before responding to sendMessage",
        )
        .await;
        let events = cursor_bridge_exit_error_events(&counts, &suppress, &[
            "thread-a".to_string(),
            "thread-b".to_string(),
        ])
        .await;

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "sdk-event-thread-b");
        assert_eq!(cursor_error_event_count(&counts, "thread-a").await, 1);
        assert_eq!(cursor_error_event_count(&counts, "thread-b").await, 1);
    }

    #[tokio::test]
    async fn cursor_terminal_events_update_thread_status() {
        let pool = fresh_pool().await;
        let thread_id = make_cursor_thread(&pool).await;
        let sessions: Arc<Mutex<HashMap<String, CursorSdkSessionContext>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let mut accumulators: HashMap<String, CursorLogAccumulator> = HashMap::new();

        queries::update_thread_status(&pool, &thread_id, "Running")
            .await
            .unwrap();
        persist_cursor_event(
            &pool,
            &sessions,
            &mut accumulators,
            &thread_id,
            &json!({ "type": "turn.completed" }),
        )
        .await;
        let thread = queries::get_thread(&pool, &thread_id).await.unwrap();
        assert_eq!(thread.status, "Idle");

        queries::update_thread_status(&pool, &thread_id, "Running")
            .await
            .unwrap();
        persist_cursor_event(
            &pool,
            &sessions,
            &mut accumulators,
            &thread_id,
            &json!({ "type": "error", "message": "failed" }),
        )
        .await;
        let thread = queries::get_thread(&pool, &thread_id).await.unwrap();
        assert_eq!(thread.status, "Error");
    }

    #[tokio::test]
    async fn cursor_error_then_session_ended_error_keeps_thread_error() {
        let pool = fresh_pool().await;
        let thread_id = make_cursor_thread(&pool).await;
        let sessions: Arc<Mutex<HashMap<String, CursorSdkSessionContext>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let mut accumulators: HashMap<String, CursorLogAccumulator> = HashMap::new();

        queries::update_thread_status(&pool, &thread_id, "Running")
            .await
            .unwrap();
        persist_cursor_event(
            &pool,
            &sessions,
            &mut accumulators,
            &thread_id,
            &json!({ "type": "error", "message": "failed" }),
        )
        .await;
        persist_cursor_event(
            &pool,
            &sessions,
            &mut accumulators,
            &thread_id,
            &json!({ "type": "session.ended", "reason": "error" }),
        )
        .await;

        let thread = queries::get_thread(&pool, &thread_id).await.unwrap();
        assert_eq!(thread.status, "Error");
    }

    #[tokio::test]
    async fn cursor_non_event_send_failure_marks_thread_error() {
        let pool = fresh_pool().await;
        let thread_id = make_cursor_thread(&pool).await;
        let input_log_id = insert_cursor_input_log(&pool, &thread_id, "hello")
            .await
            .unwrap();
        let previous_status = mark_cursor_send_running(&pool, &thread_id).await.unwrap();

        handle_cursor_non_event_send_failure(
            &pool,
            &thread_id,
            &input_log_id,
            previous_status.as_deref(),
            "cursor-sdk-bridge closed before responding to sendMessage",
        )
        .await;

        let thread = queries::get_thread(&pool, &thread_id).await.unwrap();
        assert_eq!(thread.status, "Error");
        let rows = get_cursor_history_rows(&pool, &thread_id, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].content, "hello");
    }

    #[test]
    fn cursor_send_error_is_eventful_only_when_error_count_increases() {
        assert!(!cursor_send_error_was_emitted(0, 0));
        assert!(cursor_send_error_was_emitted(0, 1));
        assert!(!cursor_send_error_was_emitted(2, 2));
    }

    #[tokio::test]
    async fn cursor_history_rows_returns_chronological_agent_logs() {
        let pool = fresh_pool().await;
        let thread_id = make_cursor_thread(&pool).await;

        queries::insert_agent_log_typed(&pool, &thread_id, "Input", "hello", "text")
            .await
            .unwrap();
        queries::insert_agent_log_typed(&pool, &thread_id, "Output", "reply", "text")
            .await
            .unwrap();
        queries::insert_agent_log_typed(&pool, &thread_id, "Output", "thinking", "thinking")
            .await
            .unwrap();
        queries::insert_agent_log_typed(
            &pool,
            &thread_id,
            "Output",
            &json!({
                "toolUseId": "tool-1",
                "parentToolUseId": null,
                "name": "read",
                "input": { "path": "src/lib.rs" },
            })
            .to_string(),
            "tool_use",
        )
        .await
        .unwrap();
        queries::insert_agent_log_typed(
            &pool,
            &thread_id,
            "Output",
            &json!({
                "toolUseId": "tool-1",
                "parentToolUseId": null,
                "content": "done",
                "isError": false,
            })
            .to_string(),
            "tool_result",
        )
        .await
        .unwrap();

        let rows = get_cursor_history_rows(&pool, &thread_id, 10).await.unwrap();

        assert_eq!(rows.len(), 5);
        assert_eq!(rows[0].direction, "Input");
        assert_eq!(rows[0].log_type, "text");
        assert_eq!(rows[0].content, "hello");
        assert_eq!(rows[1].log_type, "text");
        assert_eq!(rows[1].content, "reply");
        assert_eq!(rows[2].log_type, "thinking");
        assert_eq!(rows[3].log_type, "tool_use");
        assert_eq!(rows[4].log_type, "tool_result");

        let rowids: Vec<i64> = rows
            .iter()
            .map(|row| row.rowid.expect("rowid should be selected"))
            .collect();
        let mut sorted = rowids.clone();
        sorted.sort_unstable();
        assert_eq!(rowids, sorted);
    }

    #[tokio::test]
    async fn cursor_history_flushes_text_before_tool_rows() {
        let pool = fresh_pool().await;
        let thread_id = make_cursor_thread(&pool).await;
        let sessions: Arc<Mutex<HashMap<String, CursorSdkSessionContext>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let mut accumulators: HashMap<String, CursorLogAccumulator> = HashMap::new();

        persist_cursor_event(
            &pool,
            &sessions,
            &mut accumulators,
            &thread_id,
            &json!({
                "type": "content.delta",
                "contentType": "text",
                "text": "Before tool",
            }),
        )
        .await;
        persist_cursor_event(
            &pool,
            &sessions,
            &mut accumulators,
            &thread_id,
            &json!({
                "type": "tool.started",
                "toolUseId": "tool-1",
                "name": "read",
                "input": { "path": "src/lib.rs" },
            }),
        )
        .await;
        persist_cursor_event(
            &pool,
            &sessions,
            &mut accumulators,
            &thread_id,
            &json!({
                "type": "tool.completed",
                "toolUseId": "tool-1",
                "content": "done",
                "isError": false,
            }),
        )
        .await;
        persist_cursor_event(
            &pool,
            &sessions,
            &mut accumulators,
            &thread_id,
            &json!({ "type": "turn.completed" }),
        )
        .await;

        let rows = get_cursor_history_rows(&pool, &thread_id, 10).await.unwrap();
        let actual: Vec<(&str, &str)> = rows
            .iter()
            .map(|row| (row.log_type.as_str(), row.content.as_str()))
            .collect();

        assert_eq!(
            actual,
            vec![
                ("text", "Before tool"),
                (
                    "tool_use",
                    r#"{"input":{"path":"src/lib.rs"},"name":"read","parentToolUseId":null,"toolUseId":"tool-1"}"#,
                ),
                (
                    "tool_result",
                    r#"{"content":"done","isError":false,"parentToolUseId":null,"toolUseId":"tool-1"}"#,
                ),
            ]
        );
    }

    #[tokio::test]
    async fn cursor_history_preserves_mixed_text_thinking_before_tool_rows() {
        let pool = fresh_pool().await;
        let thread_id = make_cursor_thread(&pool).await;
        let sessions: Arc<Mutex<HashMap<String, CursorSdkSessionContext>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let mut accumulators: HashMap<String, CursorLogAccumulator> = HashMap::new();

        persist_cursor_event(
            &pool,
            &sessions,
            &mut accumulators,
            &thread_id,
            &json!({
                "type": "content.delta",
                "contentType": "text",
                "text": "Visible",
            }),
        )
        .await;
        persist_cursor_event(
            &pool,
            &sessions,
            &mut accumulators,
            &thread_id,
            &json!({
                "type": "content.delta",
                "contentType": "thinking",
                "text": "Hidden",
            }),
        )
        .await;
        persist_cursor_event(
            &pool,
            &sessions,
            &mut accumulators,
            &thread_id,
            &json!({
                "type": "tool.started",
                "toolUseId": "tool-1",
                "name": "read",
                "input": { "path": "src/lib.rs" },
            }),
        )
        .await;

        let rows = get_cursor_history_rows(&pool, &thread_id, 10).await.unwrap();
        let actual: Vec<&str> = rows.iter().map(|row| row.log_type.as_str()).collect();

        assert_eq!(actual, vec!["text", "thinking", "tool_use"]);
        assert_eq!(rows[0].content, "Visible");
        assert_eq!(rows[1].content, "Hidden");
    }

    #[tokio::test]
    async fn cursor_history_flushes_deltas_between_tool_start_and_result() {
        let pool = fresh_pool().await;
        let thread_id = make_cursor_thread(&pool).await;
        let sessions: Arc<Mutex<HashMap<String, CursorSdkSessionContext>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let mut accumulators: HashMap<String, CursorLogAccumulator> = HashMap::new();

        persist_cursor_event(
            &pool,
            &sessions,
            &mut accumulators,
            &thread_id,
            &json!({
                "type": "tool.started",
                "toolUseId": "tool-1",
                "name": "read",
                "input": { "path": "src/lib.rs" },
            }),
        )
        .await;
        persist_cursor_event(
            &pool,
            &sessions,
            &mut accumulators,
            &thread_id,
            &json!({
                "type": "content.delta",
                "contentType": "text",
                "text": "After start",
            }),
        )
        .await;
        persist_cursor_event(
            &pool,
            &sessions,
            &mut accumulators,
            &thread_id,
            &json!({
                "type": "content.delta",
                "contentType": "thinking",
                "text": " and thought",
            }),
        )
        .await;
        persist_cursor_event(
            &pool,
            &sessions,
            &mut accumulators,
            &thread_id,
            &json!({
                "type": "tool.completed",
                "toolUseId": "tool-1",
                "content": "done",
                "isError": false,
            }),
        )
        .await;

        let rows = get_cursor_history_rows(&pool, &thread_id, 10).await.unwrap();
        let actual: Vec<&str> = rows.iter().map(|row| row.log_type.as_str()).collect();

        assert_eq!(actual, vec!["tool_use", "text", "thinking", "tool_result"]);
        assert_eq!(rows[1].content, "After start");
        assert_eq!(rows[2].content, " and thought");
    }

    #[tokio::test]
    async fn cursor_history_flushes_text_before_error_row() {
        let pool = fresh_pool().await;
        let thread_id = make_cursor_thread(&pool).await;
        let sessions: Arc<Mutex<HashMap<String, CursorSdkSessionContext>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let mut accumulators: HashMap<String, CursorLogAccumulator> = HashMap::new();

        persist_cursor_event(
            &pool,
            &sessions,
            &mut accumulators,
            &thread_id,
            &json!({
                "type": "content.delta",
                "contentType": "text",
                "text": "Partial answer",
            }),
        )
        .await;
        persist_cursor_event(
            &pool,
            &sessions,
            &mut accumulators,
            &thread_id,
            &json!({
                "type": "error",
                "message": "Cursor failed",
            }),
        )
        .await;

        let rows = get_cursor_history_rows(&pool, &thread_id, 10).await.unwrap();
        let actual: Vec<(&str, &str)> = rows
            .iter()
            .map(|row| (row.log_type.as_str(), row.content.as_str()))
            .collect();

        assert_eq!(
            actual,
            vec![("text", "Partial answer"), ("text", "Cursor failed")]
        );
    }

    #[test]
    fn cursor_tool_line_delta_prefers_result_lines_added() {
        let (added, removed, path) = cursor_tool_line_delta(
            "edit",
            &json!({ "path": "src/foo.ts" }),
            &json!({
                "status": "success",
                "value": { "linesAdded": 4, "linesRemoved": 2, "diffString": "--- a\n+++ b\n" }
            }),
        );
        assert_eq!(added, 4);
        assert_eq!(removed, 2);
        assert_eq!(path.as_deref(), Some("src/foo.ts"));
    }

    #[test]
    fn cursor_tool_line_delta_parses_stringified_result() {
        let (added, removed, path) = cursor_tool_line_delta(
            "edit",
            &json!({ "file_path": "a.rs" }),
            &json!("{\"status\":\"success\",\"value\":{\"linesAdded\":9,\"linesRemoved\":1}}"),
        );
        assert_eq!((added, removed), (9, 1));
        assert_eq!(path.as_deref(), Some("a.rs"));
    }

    #[test]
    fn cursor_tool_line_delta_write_counts_file_text() {
        let (added, removed, path) = cursor_tool_line_delta(
            "write",
            &json!({ "path": "new.ts", "fileText": "a\nb\nc" }),
            &json!("ok"),
        );
        assert_eq!((added, removed), (3, 0));
        assert_eq!(path.as_deref(), Some("new.ts"));
    }

    #[test]
    fn cursor_tool_line_delta_edit_counts_old_new_text() {
        let (added, removed, _) = cursor_tool_line_delta(
            "edit",
            &json!({ "path": "x.ts", "oldText": "a\nb", "newText": "a\nb\nc" }),
            &json!(null),
        );
        assert_eq!((added, removed), (3, 2));
    }
}
