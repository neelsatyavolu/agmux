use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::AppState;
use crate::process::kill::{kill_process_tree, pid_is_alive};
use crate::process::provider::build_augmented_path;

type SidecarResponse = Result<Value, String>;

/// Normalize only for snapshot tracking; keep the bridge payload intact.
fn normalize_shell_event(
    shell_start_events: &mut HashMap<(String, String), Option<String>>,
    thread_id: &str,
    parsed: &Value,
) -> Value {
    match parsed.get("type").and_then(Value::as_str) {
        Some("tool_use") => {
            if shell_start_events.len() > 1024 { shell_start_events.clear(); }
            if let Some(id) = parsed.get("partId").and_then(Value::as_str) {
                shell_start_events.entry((thread_id.to_string(), id.to_string()))
                    .or_insert_with(|| parsed.get("eventId").and_then(Value::as_str).map(str::to_string));
            }
            json!({
                "type": "tool.started", "toolUseId": parsed.get("partId"),
                "name": parsed.get("toolName"), "input": parsed.get("input"),
            })
        }
        Some("tool_result") => {
            let start = parsed.get("partId").and_then(Value::as_str)
                .and_then(|id| shell_start_events.remove(&(thread_id.to_string(), id.to_string()))).flatten();
            let end = parsed.get("eventId").and_then(Value::as_str);
            json!({
                "type": "tool.completed", "toolUseId": parsed.get("partId"),
                "isError": parsed.get("isError"), "output": parsed.get("output"),
                "snapshotEligible": matches!((start.as_deref(), end), (Some(a), Some(b)) if a != b),
            })
        }
        _ if parsed.get("event").and_then(Value::as_str) == Some("session.idle") => {
            json!({ "type": "turn.completed" })
        }
        _ => parsed.clone(),
    }
}

/// Keep one persisted row per mapper part so phone polling can read streaming
/// text without creating a new message for every delta or repeated tool result.
async fn persist_opencode_event(
    db: &sqlx::SqlitePool,
    rows: &mut HashMap<(String, String, String), String>,
    thread_id: &str,
    event: &Value,
) -> Result<(), sqlx::Error> {
    let Some(part_id) = event.get("partId").and_then(Value::as_str) else {
        return Ok(());
    };
    let (log_type, content) = match event.get("type").and_then(Value::as_str) {
        Some("assistant_text" | "thinking") => {
            let text = event.get("fullText").and_then(Value::as_str).unwrap_or("");
            if text.trim().is_empty() { return Ok(()); }
            let kind = if event["type"] == "thinking" { "thinking" } else { "text" };
            (kind, text.to_string())
        }
        Some("tool_use") => ("tool_use", json!({
            "toolUseId": part_id,
            "name": event.get("toolName"),
            "input": event.get("input"),
        }).to_string()),
        Some("tool_result") => ("tool_result", json!({
            "toolUseId": part_id,
            "content": event.get("output"),
            "isError": event.get("isError"),
        }).to_string()),
        _ => return Ok(()),
    };
    let key = (thread_id.to_string(), part_id.to_string(), log_type.to_string());
    let id = rows.entry(key).or_insert_with(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string();
    sqlx::query(
        "INSERT INTO agent_logs (id, thread_id, direction, content, log_type, timestamp) \
         VALUES (?, ?, 'Output', ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET content = excluded.content WHERE content != excluded.content",
    )
    .bind(id.as_str()).bind(thread_id).bind(content).bind(log_type).bind(now)
    .execute(db).await?;
    Ok(())
}

/// Newline-count helper shared by the opencode diff-stats tracker.
/// Matches `threads::count_newlines` semantics (0 for empty, +1 for no
/// trailing newline).
fn count_newlines(s: &str) -> u64 {
    if s.is_empty() {
        return 0;
    }
    let n = s.matches('\n').count() as u64;
    if s.ends_with('\n') { n } else { n + 1 }
}

/// Tool names that represent in-place file edits in OpenCode. Lowercase
/// matches the names OpenCode's own tool manifest uses; uppercase
/// aliases exist because some models (Anthropic via OpenCode) emit the
/// Claude Code-style capitalized names.
fn is_opencode_edit_tool(name: &str) -> bool {
    matches!(
        name,
        "edit" | "write" | "multiedit" | "Edit" | "Write" | "MultiEdit"
    )
}

/// Lookup a field tolerant of snake_case vs camelCase key naming.
/// Claude tools use snake_case (`file_path`, `old_string`); OpenCode's
/// tools use camelCase (`filePath`, `oldString`). We accept both.
fn field_str<'a>(input: &'a Value, keys: &[&str]) -> &'a str {
    for k in keys {
        if let Some(s) = input.get(k).and_then(|v| v.as_str()) {
            return s;
        }
    }
    ""
}

/// Compute `(added, removed, file_path)` from an OpenCode edit-tool
/// input payload. Uses the newline-count heuristic (matches
/// `scan_claude_diff_stats`) — fast and good enough for sidebar badges.
/// Accepts both snake_case and camelCase input key variants because
/// OpenCode emits camelCase while Claude (and our Claude-shaped tools)
/// emit snake_case.
fn compute_opencode_delta(
    tool_name: &str,
    input: &Value,
) -> (u64, u64, Option<String>) {
    let file_path_str = field_str(input, &["file_path", "filePath", "path"]);
    let file_path = if file_path_str.is_empty() {
        None
    } else {
        Some(file_path_str.to_string())
    };
    let lowered = tool_name.to_ascii_lowercase();
    match lowered.as_str() {
        "edit" => {
            let old = field_str(input, &["old_string", "oldString"]);
            let new_s = field_str(input, &["new_string", "newString"]);
            (count_newlines(new_s), count_newlines(old), file_path)
        }
        "write" => {
            let body = field_str(input, &["content"]);
            (count_newlines(body), 0, file_path)
        }
        "multiedit" => {
            let mut added = 0u64;
            let mut removed = 0u64;
            if let Some(edits) = input.get("edits").and_then(|v| v.as_array()) {
                for edit in edits {
                    let old = field_str(edit, &["old_string", "oldString"]);
                    let new_s = field_str(edit, &["new_string", "newString"]);
                    added += count_newlines(new_s);
                    removed += count_newlines(old);
                }
            }
            (added, removed, file_path)
        }
        _ => (0, 0, file_path),
    }
}

// Rolling buffer of the last N bridge stderr lines. Used by the
// `opencode_bridge_log_tail` command so the frontend can retrieve logs
// emitted BEFORE a listener was attached (e.g. the SSE-subscribe logs that
// fire during the very first `initialize`). Capped to keep memory bounded.
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
pub async fn opencode_bridge_log_tail(lines: Option<usize>) -> Result<Vec<String>, String> {
    let want = lines.unwrap_or(200);
    let buf = bridge_log_buffer()
        .lock()
        .map_err(|e| format!("log buffer poisoned: {e}"))?;
    let start = buf.len().saturating_sub(want);
    Ok(buf.iter().skip(start).cloned().collect())
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

/// Detect a JSON-RPC error response with a missing/null `id`. The bridge
/// emits these for parse-level failures (`respondError(null, ...)`), which
/// have no caller to deliver to. Without explicit handling these lines fall
/// through to the event router, fail the `threadId` check, and disappear
/// silently — leaving every in-flight request to hit its 30 s timeout with
/// no diagnostic. Returning the message lets the reader surface it to logs.
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

/// Locate the opencode binary on the augmented PATH (homebrew/nvm/mise/etc).
/// Users can still override by pointing at a specific path, but auto-detect
/// means most installs "just work" without fiddling with Settings.
fn find_opencode_binary() -> Option<String> {
    let augmented_path = build_augmented_path();
    for dir in augmented_path.split(':') {
        let candidate = std::path::Path::new(dir).join("opencode");
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

fn resolve_bridge_path(app: &AppHandle) -> Result<String, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir
            .join("sidecar")
            .join("dist")
            .join("opencode-sdk-bridge.bundle.mjs");
        if bundled.exists() {
            return Ok(bundled.to_string_lossy().to_string());
        }
    }
    // Dev mode: look relative to the src-tauri directory's parent (repo root)
    let dev_path = std::env::current_dir()
        .map_err(|e| e.to_string())?
        .parent()
        .map(|p| p.join("sidecar").join("opencode-sdk-bridge.mjs"))
        .ok_or_else(|| "Cannot resolve opencode-sdk-bridge path".to_string())?;
    if dev_path.exists() {
        return Ok(dev_path.to_string_lossy().to_string());
    }
    Err("opencode-sdk-bridge script not found. Run: cd sidecar && node build.mjs".to_string())
}

// ---------------------------------------------------------------------------
// Session context (persisted in AppState per thread)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenCodeSdkSessionContext {
    pub thread_id: String,
    pub opencode_session_id: String,
    pub directory: String,
    pub model: String,
    #[serde(default)]
    pub agent: Option<String>,
}

// ---------------------------------------------------------------------------
// Shared bridge subprocess (one per app lifetime)
// ---------------------------------------------------------------------------

// None = not started; Some(None) = provider state is uncertain. A warm
// startSession is a no-op in the sidecar and must preserve the previous model.
type ExecutionModel = Option<Option<String>>;

pub struct OpenCodeBridge {
    execution_generations: super::execution_generation::ExecutionGenerations,
    execution_lifecycle: RwLock<()>,
    execution_models: Mutex<HashMap<String, Arc<Mutex<ExecutionModel>>>>,
    /// PID of the Node sidecar. Because we spawn it with `process_group(0)`,
    /// PID == PGID — so `killpg(pid, SIG*)` reaches the whole subtree
    /// (node → opencode serve → any grandchildren). Captured at spawn time
    /// before `child` is moved behind the Mutex.
    pub pid: u32,
    /// Held for its `kill_on_drop(true)` side effect — ensures the Node PID
    /// is SIGKILL'd if it somehow outlives our own Drop impl. Never read
    /// directly anymore; cleanup goes through `killpg(pid)` via the process
    /// group, which is correct because PID == PGID (we spawn with
    /// `process_group(0)`) and killpg reaches grandchildren like
    /// `opencode serve` that a plain child.kill() would orphan.
    #[allow(dead_code)]
    pub child: Arc<Mutex<Child>>,
    pub stdin: Arc<Mutex<ChildStdin>>,
    pub is_shutting_down: Arc<AtomicBool>,
    pub next_request_id: Arc<Mutex<u64>>,
    pub pending_responses: Arc<Mutex<HashMap<u64, oneshot::Sender<SidecarResponse>>>>,
}

impl Drop for OpenCodeBridge {
    /// Safety net: when the bridge is dropped (app exit, state replacement,
    /// panic), nuke the whole process group. Without this, `opencode serve`
    /// (a grandchild spawned inside the Node sidecar) survives the sidecar's
    /// death — it reparents to init (PPID=1) and keeps running, holding TCC
    /// state and triggering folder prompts even after agmux is closed.
    ///
    /// `kill_process_tree` sends SIGTERM-then-SIGKILL to the negative PID
    /// (process group), reaching node + opencode + descendants atomically.
    ///
    /// Skip this kill when an explicit shutdown is in progress: that path
    /// already handles termination (via the "shutdown" RPC + a 2 s killpg
    /// fallback). Doing it twice opens a small PID-reuse window where the
    /// OS could recycle the now-defunct PID for an unrelated process
    /// before Drop fires, and we'd signal a stranger.
    fn drop(&mut self) {
        if self.pid != 0 && !self.is_shutting_down.load(Ordering::Relaxed) {
            kill_process_tree(self.pid);
        }
    }
}

impl OpenCodeBridge {
    pub async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        let execution = matches!(method, "startSession" | "sendMessage" | "setModel" | "setAgent");
        let thread_id = params.get("threadId").and_then(Value::as_str).unwrap_or("");
        let cancel = matches!(method, "interrupt" | "stopSession");
        let ticket = if execution || cancel {
            Some(self.execution_generations.capture(thread_id, cancel).await)
        } else { None };
        // initialize may restart serve and erase every native session. Keep it
        // ordered against execution, without delaying interrupts or approvals.
        let _initializing = if method == "initialize" { Some(self.execution_lifecycle.write().await) } else { None };
        let slot = if execution || method == "stopSession" {
            let mut models = self.execution_models.lock().await;
            if method == "stopSession" {
                // Detach running/queued sends immediately so Stop never waits
                // for a full turn's configuration lock. New starts wait for
                // this stop's acknowledgement on the replacement slot.
                models.insert(thread_id.to_string(), Arc::new(Mutex::new(Some(None))));
            }
            Some(models.entry(thread_id.to_string()).or_insert_with(|| Arc::new(Mutex::new(None))).clone())
        } else { None };
        let mut config = match &slot {
            Some(slot) => Some(slot.lock().await),
            None => None,
        };
        let next_model = config.as_ref().map(|c| next_execution_model(method, &params, c));
        if execution {
            crate::teams::policy::refresh_for_execution().await?;
            let model = next_model.as_ref().and_then(|v| v.as_ref()).and_then(|v| v.as_deref());
            let (provider, model) = execution_provider_model(model);
            crate::teams::policy::enforce(provider, "chat", model, None)?;
        }
        // Do not hold the lifecycle lock while queued behind this thread's
        // previous turn. initialize may detach the slot while we wait; the
        // registry identity check below rejects such stale requests.
        let _executing = if execution { Some(self.execution_lifecycle.read().await) } else { None };
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
            let registry = self.execution_models.lock().await;
            if let Some(slot) = &slot {
                if !registry.get(thread_id).is_some_and(|current| Arc::ptr_eq(current, slot)) {
                    self.pending_responses.lock().await.remove(&id);
                    return Err("OpenCode session changed before request dispatch; retry the request".into());
                }
            }
            let mut stdin = self.stdin.lock().await;
            if execution {
                if let Some(ticket) = &ticket {
                    if let Err(error) = ticket.validate() {
                        self.pending_responses.lock().await.remove(&id);
                        return Err(error);
                    }
                }
            }
            if let Some(config) = config.as_mut() {
                // A cancelled preflight never erases acknowledged settings.
                **config = Some(None);
            }
            if let Err(err) = stdin.write_all(line.as_bytes()).await {
                self.pending_responses.lock().await.remove(&id);
                return Err(format!(
                    "Failed to write to opencode-sdk-bridge stdin: {}",
                    err
                ));
            }
            if let Err(err) = stdin.flush().await {
                self.pending_responses.lock().await.remove(&id);
                return Err(format!(
                    "Failed to flush opencode-sdk-bridge stdin: {}",
                    err
                ));
            }
        }

        // Only dispatch is ordered against initialize. A turn's response can
        // take hours; its retained per-thread slot does not block other sessions.
        drop(_executing);

        // `sendMessage` is implemented bridge-side as a blocking call to
        // `client.session.prompt()` that resolves only when the full agent
        // turn completes (including every tool call). Real turns routinely
        // exceed 30 s, so a short timeout here would prematurely return an
        // error to the frontend — hiding the Stop button and surfacing a
        // misleading "timed out" message while the agent is still running.
        // Use a very long backstop (24 h) instead; turn-end and errors are
        // signaled via the `session.idle` / `error` Tauri events emitted by
        // the reader task, which is independent of this response channel.
        let timeout = if method == "sendMessage" {
            std::time::Duration::from_secs(60 * 60 * 24)
        } else {
            std::time::Duration::from_secs(30)
        };

        let result = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!(
                "opencode-sdk-bridge closed before responding to {}",
                method
            )),
            Err(_) => {
                self.pending_responses.lock().await.remove(&id);
                Err(format!(
                    "Timed out waiting for opencode-sdk-bridge response to {}",
                    method
                ))
            }
        };
        if method == "initialize" {
            let mut models = self.execution_models.lock().await;
            match &result {
                Ok(value) if value.get("alreadyInitialized").and_then(Value::as_bool) == Some(true) => {},
                Ok(_) => models.clear(),
                Err(_) => {
                    for slot in models.values_mut() {
                        *slot = Arc::new(Mutex::new(Some(None)));
                    }
                }
            }
        }
        if result.is_ok() {
            if let (Some(config), Some(next)) = (config.as_mut(), next_model) {
                **config = next;
            }
        }
        result
    }
}

// ---------------------------------------------------------------------------
// Bridge spawn + reader task
// ---------------------------------------------------------------------------

async fn spawn_bridge(app: &AppHandle) -> Result<Arc<OpenCodeBridge>, String> {
    let node = find_node_binary()?;
    let bridge_path = resolve_bridge_path(app)?;

    let mut cmd = Command::new(&node);
    cmd.arg(&bridge_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn opencode-sdk-bridge: {}", e))?;

    // Capture PID before moving `child` behind the Mutex. Used by Drop to
    // killpg the whole subtree (node + opencode serve + descendants). 0 here
    // would disable cleanup — tolerate it but log; spawn() almost always
    // returns a PID.
    let pid = child.id().unwrap_or(0);
    if pid == 0 {
        tracing::warn!("opencode-sdk-bridge spawned without a PID — orphan cleanup on exit will be skipped");
    }

    let stdin = child.stdin.take().ok_or("bridge stdin missing")?;
    let stdout = child.stdout.take().ok_or("bridge stdout missing")?;
    let stderr = child.stderr.take().ok_or("bridge stderr missing")?;

    let pending_responses: Arc<Mutex<HashMap<u64, oneshot::Sender<SidecarResponse>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let is_shutting_down = Arc::new(AtomicBool::new(false));

    // Forward stderr to tracing, into a rolling in-memory buffer (so logs
    // emitted before the frontend listener attached aren't lost), AND as
    // `opencode-bridge-log` Tauri events for live DevTools viewing.
    let stderr_app = app.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::debug!(target: "opencode_sdk_bridge", "{}", line);
            push_bridge_log(&line);
            let _ = stderr_app.emit("opencode-bridge-log", &line);
        }
    });

    // Reader task: routes responses and events
    let app_clone = app.clone();
    let pending_clone = pending_responses.clone();
    let shutdown_clone = is_shutting_down.clone();
    tokio::spawn(async move {
        // Diff-stats tracking. Tool events from the mapper arrive as:
        //   `{ type: "tool_use", toolName, input, partId, threadId }`  — snapshot
        //   `{ type: "tool_result", toolName, output, isError, partId, threadId }` — delta
        // We remember the `input` from tool_use, then on a successful tool_result
        // we compute the added/removed line delta and persist it to `threads`.
        // Both maps are owned by this single task (one per bridge process), so
        // no synchronization is needed.
        type ThreadEditMap = HashMap<String, (String, Value)>;
        let mut pending_edits: HashMap<String, ThreadEditMap> = HashMap::new();
        let mut touched_files: HashMap<String, std::collections::HashSet<String>> =
            HashMap::new();
        let mut log_rows = HashMap::new();
        // A mapper reconstruction emits start/result with the same eventId.
        // Such a start happened before observation and has no safe baseline.
        let mut shell_start_events: HashMap<(String, String), Option<String>> = HashMap::new();

        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if shutdown_clone.load(Ordering::Relaxed) {
                break;
            }
            let parsed: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            // 1. JSON-RPC response (has numeric `id` + `result` or `error`)
            if let Some((id, response)) = parse_sidecar_response(&parsed) {
                if let Some(tx) = pending_clone.lock().await.remove(&id) {
                    let _ = tx.send(response);
                }
                continue;
            }

            // 1b. Orphan error (id=null) — bridge couldn't even parse a
            //     request line. Surface to tracing + log buffer so the
            //     diagnostic is recoverable; otherwise these vanish and
            //     callers sit through the full 30 s timeout in silence.
            if let Some(msg) = parse_orphan_error(&parsed) {
                let log_line = format!("[bridge orphan error] {}", msg);
                tracing::warn!(target: "opencode_sdk_bridge", "{}", log_line);
                push_bridge_log(&log_line);
                let _ = app_clone.emit("opencode-bridge-log", &log_line);
                continue;
            }

            // 2. Event — must carry `threadId` to route correctly.
            //    Bridge emits two shapes:
            //      a) control events: { event: "session.started" | "session.idle" | "error", threadId, ... }
            //      b) mapper events:  { type: "assistant_text" | ..., threadId, ... }
            //    Both always have `threadId`.
            let thread_id = match parsed.get("threadId").and_then(|v| v.as_str()) {
                Some(t) => t.to_string(),
                None => continue,
            };

            if let Some(state) = app_clone.try_state::<AppState>() {
                if let Err(error) = persist_opencode_event(&state.db, &mut log_rows, &thread_id, &parsed).await {
                    tracing::warn!(thread_id = %thread_id, error = %error, "opencode remote log failed");
                }
            }

            match parsed.get("type").and_then(Value::as_str) {
                Some("permission_request") => {
                    if let Some(id) = parsed.get("permissionId").and_then(Value::as_str) {
                        crate::remote::notify_approval(
                            &app_clone, &thread_id, id,
                            parsed.get("permission").and_then(Value::as_str).unwrap_or("tool"),
                            &parsed.get("patterns").unwrap_or(&Value::Null).to_string(),
                        );
                    }
                }
                Some("user_input_request") => {
                    if let Some(id) = parsed.get("questionId").and_then(Value::as_str) {
                        crate::remote::notify_user_input(
                            &app_clone, &thread_id, id,
                            parsed.get("questions").cloned().unwrap_or_else(|| json!([])),
                        );
                    }
                }
                _ => {}
            }

            // Session timeline close on idle / error control events.
            if let Some(ev) = parsed.get("event").and_then(|v| v.as_str()) {
                if ev == "session.idle" || ev == "error" {
                    let app_emit = app_clone.clone();
                    let tid = thread_id.clone();
                    let status = if ev == "error" { "failed" } else { "done" };
                    tokio::spawn(async move {
                        let state: tauri::State<'_, AppState> = app_emit.state();
                        let _ = crate::db::queries::update_thread_status(
                            &state.db, &tid, if status == "failed" { "Error" } else { "Done" },
                        ).await;
                        let local_port = {
                            let guard = state.local_llm_server.lock().await;
                            guard.as_ref().map(|s| s.port())
                        };
                        let _ = crate::thread_turns::close_turn(
                            &state.db,
                            Some(&app_emit),
                            &tid,
                            status,
                            local_port,
                        )
                        .await;
                    });
                }
            }

            // Normalize only for snapshot tracking; keep the bridge payload intact.
            let shell_event = normalize_shell_event(&mut shell_start_events, &thread_id, &parsed);
            crate::shell_diff::observe_sdk(&app_clone, &thread_id, &shell_event).await;

            // Diff-stats: snapshot tool input on tool_use, record delta on
            // successful tool_result. `partId` correlates the two events.
            if let Some(event_type) = parsed.get("type").and_then(|v| v.as_str()) {
                match event_type {
                    "tool_use" => {
                        let tool_name = parsed
                            .get("toolName")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        {
                            let app_emit = app_clone.clone();
                            let tid = thread_id.clone();
                            let name = tool_name.to_string();
                            let path = parsed
                                .get("input")
                                .and_then(|i| {
                                    i.get("file_path")
                                        .or_else(|| i.get("path"))
                                        .and_then(|p| p.as_str())
                                        .map(|s| s.to_string())
                                });
                            tokio::spawn(async move {
                                let state: tauri::State<'_, AppState> = app_emit.state();
                                let _ = crate::thread_turns::note_tool_use(
                                    &state.db,
                                    Some(&app_emit),
                                    &tid,
                                    &name,
                                    path.as_deref(),
                                )
                                .await;
                            });
                        }
                        if is_opencode_edit_tool(tool_name) {
                            if let (Some(part_id), Some(input)) = (
                                parsed.get("partId").and_then(|v| v.as_str()),
                                parsed.get("input"),
                            ) {
                                pending_edits
                                    .entry(thread_id.clone())
                                    .or_default()
                                    .insert(
                                        part_id.to_string(),
                                        (tool_name.to_string(), input.clone()),
                                    );
                            }
                        }
                    }
                    "tool_result" => {
                        let is_error = parsed
                            .get("isError")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        if !is_error {
                            if let Some(part_id) =
                                parsed.get("partId").and_then(|v| v.as_str())
                            {
                                let pending =
                                    pending_edits.get_mut(&thread_id).and_then(|m| {
                                        m.remove(part_id)
                                    });
                                if let Some((tool_name, input)) = pending {
                                    let (added, removed, file_path) =
                                        compute_opencode_delta(&tool_name, &input);
                                    let files_delta = if let Some(fp) = file_path {
                                        let files = touched_files
                                            .entry(thread_id.clone())
                                            .or_default();
                                        if files.insert(fp) { 1 } else { 0 }
                                    } else {
                                        0
                                    };
                                    if added > 0 || removed > 0 || files_delta > 0 {
                                        let app_emit = app_clone.clone();
                                        let tid = thread_id.clone();
                                        tokio::spawn(async move {
                                            let state: tauri::State<AppState> =
                                                app_emit.state();
                                            let db = state.db.clone();
                                            if let Err(e) =
                                                crate::diff_stats::record_thread_diff_delta(
                                                    &app_emit, &db, &tid, added,
                                                    removed, files_delta,
                                                )
                                                .await
                                            {
                                                tracing::warn!(
                                                    thread_id = %tid,
                                                    error = %e,
                                                    "opencode diff_stats update failed",
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
            }

            let channel = format!("sdk-event-{}", thread_id);
            let _ = app_clone.emit(&channel, parsed);
        }
    });

    Ok(Arc::new(OpenCodeBridge {
        execution_generations: Default::default(),
        execution_lifecycle: RwLock::new(()),
        execution_models: Mutex::new(HashMap::new()),
        pid,
        child: Arc::new(Mutex::new(child)),
        stdin: Arc::new(Mutex::new(stdin)),
        is_shutting_down,
        next_request_id: Arc::new(Mutex::new(0)),
        pending_responses,
    }))
}

async fn get_or_spawn_bridge(
    app: &AppHandle,
    state: &AppState,
) -> Result<Arc<OpenCodeBridge>, String> {
    let mut guard = state.opencode_sdk_bridge.lock().await;
    if let Some(b) = guard.as_ref() {
        return Ok(b.clone());
    }
    let bridge = spawn_bridge(app).await?;
    *guard = Some(bridge.clone());
    Ok(bridge)
}

// ---------------------------------------------------------------------------
// Tauri commands — 13 total
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeInitArgs {
    pub binary_path: Option<String>,
    pub server_url: Option<String>,
    pub server_password: Option<String>,
}

/// Check if the opencode binary at `binaryPath` is available and executes.
#[tauri::command]
pub async fn opencode_sdk_check_available(binary_path: String) -> Result<bool, String> {
    // Empty path → auto-detect from augmented PATH
    let resolved = if binary_path.trim().is_empty() {
        match find_opencode_binary() {
            Some(p) => p,
            None => return Ok(false),
        }
    } else {
        binary_path
    };
    let output = tokio::process::Command::new(&resolved)
        .arg("--version")
        .output()
        .await;
    Ok(output.map(|o| o.status.success()).unwrap_or(false))
}

#[tauri::command]
pub async fn opencode_sdk_auto_detect_binary() -> Result<Option<String>, String> {
    Ok(find_opencode_binary())
}

/// Shape the sidecar's `buildOpencodeConfig` expects for each locally
/// installed model: `id` becomes the OpenCode modelID under the `local`
/// provider, `displayName` its label. Keys are camelCase because the sidecar
/// reads them verbatim (`sidecar/opencode-local-provider.mjs`).
fn local_models_payload(models: &[crate::mlx::types::MlxModel]) -> Vec<Value> {
    models
        .iter()
        // OpenCode edits files exclusively through structured tool calls, so a
        // model whose template can't emit them must never reach its picker.
        .filter(|m| m.supports_tools)
        .map(|m| json!({ "id": m.id, "displayName": m.display_name }))
        .collect()
}

/// Lazily spawn the bridge subprocess (idempotent) and call `initialize`.
#[tauri::command]
pub async fn opencode_sdk_initialize_bridge(
    app: AppHandle,
    state: State<'_, AppState>,
    args: OpenCodeInitArgs,
) -> Result<Value, String> {
    let bridge = get_or_spawn_bridge(&app, &state).await?;
    // Auto-detect binary path if user left it blank AND no external server URL is set.
    let resolved_binary = match (&args.binary_path, &args.server_url) {
        (Some(p), _) if !p.trim().is_empty() => Some(p.clone()),
        (_, Some(url)) if !url.trim().is_empty() => None, // external server — no binary needed
        _ => find_opencode_binary(),
    };
    // Declare locally-installed MLX models so the sidecar can add a `local`
    // provider pointed at agmux's gateway. Without this the chat surface
    // creates threads on `local/<id>` slugs OpenCode has never heard of.
    //
    // Known limitation: the sidecar bakes this into OPENCODE_CONFIG_CONTENT
    // when it spawns `opencode serve`, and that process outlives later
    // installs. A model downloaded after the bridge started needs an app
    // restart to appear. Rebuilding the config on installed-set change is
    // deliberately deferred.
    let local_models = local_models_payload(&crate::mlx::discovery::scan_all());
    bridge
        .send_request(
            "initialize",
            json!({
                "binaryPath": resolved_binary,
                "serverUrl": args.server_url,
                "serverPassword": args.server_password,
                "localModels": local_models,
            }),
        )
        .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeStartArgs {
    pub thread_id: String,
    pub directory: String,
    pub model: String,
    pub agent: Option<String>,
    pub permission_mode: Option<String>,
    pub resume_session_id: Option<String>,
}

/// Start (or resume) an OpenCode session for a thread.
#[tauri::command]
pub async fn opencode_sdk_start_session(
    app: AppHandle,
    state: State<'_, AppState>,
    args: OpenCodeStartArgs,
) -> Result<String, String> {
    static START_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _start = START_LOCK.lock().await;
    let active_id = state.opencode_sdk_sessions.lock().await.get(&args.thread_id)
        .map(|ctx| ctx.opencode_session_id.clone());
    if let (Some(active), Some(requested)) = (&active_id, &args.resume_session_id) {
        if active != requested { return Err("Stop this OpenCode chat before resuming a different session".into()); }
    }
    let resume_session_id = args.resume_session_id.clone().filter(|sid| !sid.is_empty()).or(active_id);
    let bridge = {
        let guard = state.opencode_sdk_bridge.lock().await;
        guard
            .as_ref()
            .ok_or("opencode bridge not initialized — call opencode_sdk_initialize_bridge first")?
            .clone()
    };

    // Materialize project memory so OpenCode can Read `.agmux/MEMORY.md`.
    if crate::memory::is_enabled() {
        if let Ok(thread) = crate::db::queries::get_thread(&state.db, &args.thread_id).await {
            if let Ok(project) =
                crate::db::queries::get_project(&state.db, &thread.project_id).await
            {
                let _ = crate::memory::ensure_memory(
                    &project.id,
                    &project.repo_path,
                    &[&args.directory],
                );
            }
        }
    }

    crate::db::queries::record_thread_session_start(&state.db, &args.thread_id, resume_session_id.as_deref()).await?;

    if resume_session_id.is_none() {
        // The bridge can retain a context after a prior start failed to persist
        // locally. Clear it so this call must execute native session.create.
        bridge.send_request("stopSession", json!({"threadId":args.thread_id})).await?;
    }

    let result = bridge
        .send_request(
            "startSession",
            json!({
                "threadId": args.thread_id,
                "directory": args.directory,
                "model": args.model,
                "agent": args.agent,
                "permissionMode": args.permission_mode,
                "resumeSessionId": resume_session_id,
            }),
        )
        .await?;

    let session_id = result
        .get("sessionId")
        .and_then(|v| v.as_str())
        .filter(|sid| !sid.is_empty())
        .ok_or("OpenCode startSession returned no native session ID")?
        .to_string();

    if resume_session_id.is_none() {
        crate::teams::ownership::record_native_creation(&state.db, "OpenCode", &args.thread_id, &session_id).await?;
    } else {
        crate::db::queries::record_thread_session_start(&state.db, &args.thread_id, Some(&session_id)).await?;
    }
    crate::db::queries::bind_thread_session(&state.db, &args.thread_id, &session_id).await?;

    state.opencode_sdk_sessions.lock().await.insert(
        args.thread_id.clone(),
        OpenCodeSdkSessionContext {
            thread_id: args.thread_id.clone(),
            opencode_session_id: session_id.clone(),
            directory: args.directory.clone(),
            model: args.model.clone(),
            agent: args.agent.clone(),
        },
    );

    // Persist opencode_session_id on the thread row so it survives restarts.
    let pool = state.db.clone();
    if let Err(e) =
        sqlx::query("UPDATE threads SET opencode_session_id = ?1 WHERE id = ?2")
            .bind(&session_id)
            .bind(&args.thread_id)
            .execute(&pool)
            .await
    {
        tracing::warn!("Failed to persist opencode_session_id: {}", e);
    }

    let _ = app; // suppress unused-variable warning
    Ok(session_id)
}

/// Send a user message to the active session on `threadId`.
#[tauri::command]
pub async fn opencode_sdk_send_message(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    text: String,
    attachments: Option<Vec<Value>>,
) -> Result<(), String> {
    let _ = crate::db::queries::insert_agent_log(&state.db, &thread_id, "Input", &text).await;
    let _ = crate::db::queries::update_thread_status(&state.db, &thread_id, "Running").await;
    let _ = crate::thread_turns::open_turn(
        &state.db,
        Some(&app),
        &thread_id,
        &text,
        "chat_item",
    )
    .await;

    let bridge = state
        .opencode_sdk_bridge
        .lock()
        .await
        .as_ref()
        .ok_or("opencode bridge not initialized")?
        .clone();
    bridge
        .send_request(
            "sendMessage",
            json!({
                "threadId": thread_id,
                "text": text,
                "attachments": attachments.unwrap_or_default(),
            }),
        )
        .await?;
    Ok(())
}

/// Respond to a permission request from the model.
#[tauri::command]
pub async fn opencode_sdk_respond_permission(
    state: State<'_, AppState>,
    thread_id: String,
    permission_id: String,
    decision: String,
) -> Result<(), String> {
    let bridge = state
        .opencode_sdk_bridge
        .lock()
        .await
        .as_ref()
        .ok_or("opencode bridge not initialized")?
        .clone();
    bridge
        .send_request(
            "respondPermission",
            json!({
                "threadId": thread_id,
                "permissionId": permission_id,
                "decision": decision,
            }),
        )
        .await?;
    state.remote.push_approval_resolved(&permission_id, Some(&thread_id)).await;
    Ok(())
}

/// Respond to a user-input question from the model.
#[tauri::command]
pub async fn opencode_sdk_respond_question(
    state: State<'_, AppState>,
    thread_id: String,
    question_id: String,
    answers: Vec<Vec<String>>,
) -> Result<(), String> {
    let bridge = state
        .opencode_sdk_bridge
        .lock()
        .await
        .as_ref()
        .ok_or("opencode bridge not initialized")?
        .clone();
    bridge
        .send_request(
            "respondQuestion",
            json!({
                "threadId": thread_id,
                "questionId": question_id,
                "answers": answers,
            }),
        )
        .await?;
    state.remote.push_user_input_resolved(&question_id, Some(&thread_id)).await;
    Ok(())
}

/// Interrupt the current turn for `threadId`.
#[tauri::command]
pub async fn opencode_sdk_interrupt(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), String> {
    let bridge_opt = state.opencode_sdk_bridge.lock().await.as_ref().cloned();
    if let Some(bridge) = bridge_opt {
        bridge
            .send_request("interrupt", json!({ "threadId": thread_id }))
            .await?;
    }
    Ok(())
}

/// Switch the active model for an ongoing session.
#[tauri::command]
pub async fn opencode_sdk_set_model(
    state: State<'_, AppState>,
    thread_id: String,
    model: String,
) -> Result<(), String> {
    let bridge = state
        .opencode_sdk_bridge
        .lock()
        .await
        .as_ref()
        .ok_or("opencode bridge not initialized")?
        .clone();
    bridge
        .send_request(
            "setModel",
            json!({
                "threadId": thread_id,
                "model": model.clone(),
            }),
        )
        .await?;
    // Mirror on Rust side so subsequent reads reflect the new model.
    if let Some(ctx) = state
        .opencode_sdk_sessions
        .lock()
        .await
        .get_mut(&thread_id)
    {
        ctx.model = model.clone();
    }
    // Persist to the threads table so the selection survives an app
    // restart / view re-mount. Without this the dropdown reverts to the
    // bare "OpenCode" label on reopen and `sendMessage` fails because the
    // bridge has no model bound, plus the agent-tab chip in task mode
    // disappears (TaskAgentTab's modelLabel returns "" when thread.model
    // is null).
    sqlx::query("UPDATE threads SET model = ?1, last_active = datetime('now') WHERE id = ?2")
        .bind(&model)
        .bind(&thread_id)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Switch the active agent for an ongoing session (e.g. "build", "plan",
/// "general"). Sent per-turn to the server on the next `sendMessage`.
#[tauri::command]
pub async fn opencode_sdk_set_agent(
    state: State<'_, AppState>,
    thread_id: String,
    agent: Option<String>,
) -> Result<(), String> {
    let bridge = state
        .opencode_sdk_bridge
        .lock()
        .await
        .as_ref()
        .ok_or("opencode bridge not initialized")?
        .clone();
    bridge
        .send_request(
            "setAgent",
            json!({
                "threadId": thread_id,
                "agent": agent.clone(),
            }),
        )
        .await?;
    if let Some(ctx) = state
        .opencode_sdk_sessions
        .lock()
        .await
        .get_mut(&thread_id)
    {
        ctx.agent = agent;
    }
    Ok(())
}

/// Update permission mode on a live OpenCode session (next tool call).
#[tauri::command]
pub async fn opencode_sdk_set_permission_mode(
    state: State<'_, AppState>,
    thread_id: String,
    mode: String,
) -> Result<(), String> {
    let bridge = state
        .opencode_sdk_bridge
        .lock()
        .await
        .as_ref()
        .ok_or("opencode bridge not initialized")?
        .clone();
    bridge
        .send_request(
            "setPermissionMode",
            json!({
                "threadId": thread_id,
                "mode": mode,
            }),
        )
        .await?;
    Ok(())
}

/// Stop the session for `threadId` and remove it from the session map.
#[tauri::command]
pub async fn opencode_sdk_stop_session(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), String> {
    let bridge_opt = state.opencode_sdk_bridge.lock().await.as_ref().cloned();
    if let Some(bridge) = bridge_opt {
        let _ = bridge
            .send_request("stopSession", json!({ "threadId": thread_id }))
            .await;
    }
    state.opencode_sdk_sessions.lock().await.remove(&thread_id);
    Ok(())
}

/// Retrieve the full message history for `threadId`.
#[tauri::command]
pub async fn opencode_sdk_get_history(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<Value, String> {
    let bridge = state
        .opencode_sdk_bridge
        .lock()
        .await
        .as_ref()
        .ok_or("opencode bridge not initialized")?
        .clone();
    bridge
        .send_request("getHistory", json!({ "threadId": thread_id }))
        .await
}

/// List available models for a given project directory.
#[tauri::command]
pub async fn opencode_sdk_list_models(
    state: State<'_, AppState>,
    directory: String,
) -> Result<Value, String> {
    let bridge = state
        .opencode_sdk_bridge
        .lock()
        .await
        .as_ref()
        .ok_or("opencode bridge not initialized")?
        .clone();
    bridge
        .send_request("listModels", json!({ "directory": directory }))
        .await
}

/// List available agents for a given project directory.
#[tauri::command]
pub async fn opencode_sdk_list_agents(
    state: State<'_, AppState>,
    directory: String,
) -> Result<Value, String> {
    let bridge = state
        .opencode_sdk_bridge
        .lock()
        .await
        .as_ref()
        .ok_or("opencode bridge not initialized")?
        .clone();
    bridge
        .send_request("listAgents", json!({ "directory": directory }))
        .await
}

/// List auth methods for all providers, including connection status.
#[tauri::command]
pub async fn opencode_sdk_list_auth_methods(
    state: State<'_, AppState>,
    directory: String,
) -> Result<Value, String> {
    let bridge = state.opencode_sdk_bridge.lock().await.as_ref().ok_or("bridge not initialized")?.clone();
    bridge.send_request("listAuthMethods", json!({ "directory": directory })).await
}

/// Save an API key credential for a provider. Returns `{ ok, connected, envVars }`
/// so the UI can tell the user whether the provider actually flipped to
/// connected (and which env vars OpenCode still expects if it didn't).
#[tauri::command]
pub async fn opencode_sdk_set_api_key(
    state: State<'_, AppState>,
    provider_id: String,
    api_key: String,
) -> Result<Value, String> {
    let bridge = state.opencode_sdk_bridge.lock().await.as_ref().ok_or("bridge not initialized")?.clone();
    bridge.send_request("setApiKey", json!({
        "providerID": provider_id,
        "apiKey": api_key,
    })).await
}

/// Remove stored credentials for a provider (sign out).
#[tauri::command]
pub async fn opencode_sdk_remove_auth(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<(), String> {
    let bridge = state.opencode_sdk_bridge.lock().await.as_ref().ok_or("bridge not initialized")?.clone();
    bridge.send_request("removeAuth", json!({ "providerID": provider_id })).await?;
    Ok(())
}

/// Begin an OAuth flow for a provider; returns `{ url }` to open in browser.
#[tauri::command]
pub async fn opencode_sdk_oauth_authorize(
    state: State<'_, AppState>,
    provider_id: String,
    method: Option<u32>,
    inputs: Option<std::collections::HashMap<String, String>>,
) -> Result<Value, String> {
    let bridge = state.opencode_sdk_bridge.lock().await.as_ref().ok_or("bridge not initialized")?.clone();
    bridge.send_request("oauthAuthorize", json!({
        "providerID": provider_id,
        "method": method,
        "inputs": inputs,
    })).await
}

/// Finalize an OAuth flow with the callback code from the browser.
#[tauri::command]
pub async fn opencode_sdk_oauth_callback(
    state: State<'_, AppState>,
    provider_id: String,
    method: Option<u32>,
    code: String,
) -> Result<Value, String> {
    let bridge = state.opencode_sdk_bridge.lock().await.as_ref().ok_or("bridge not initialized")?.clone();
    bridge.send_request("oauthCallback", json!({
        "providerID": provider_id,
        "method": method,
        "code": code,
    })).await
}

pub async fn shutdown_opencode_bridge_resources(
    bridge_slot: Arc<Mutex<Option<Arc<OpenCodeBridge>>>>,
    sessions: Arc<Mutex<HashMap<String, OpenCodeSdkSessionContext>>>,
) -> Result<(), String> {
    let bridge_opt = {
        let mut guard = bridge_slot.lock().await;
        guard.take()
    };
    if let Some(bridge) = bridge_opt {
        bridge.is_shutting_down.store(true, Ordering::Relaxed);
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            bridge.send_request("shutdown", json!({})),
        )
        .await;
        let pid = bridge.pid;
        let child_arc = bridge.child.clone();
        if pid != 0 && pid_is_alive(pid) {
            kill_process_tree(pid);
        }
        let mut child = child_arc.lock().await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await;
    }
    sessions.lock().await.clear();
    Ok(())
}

/// Gracefully shut down the bridge subprocess and clear all session state.
#[tauri::command]
pub async fn opencode_sdk_shutdown_bridge(state: State<'_, AppState>) -> Result<(), String> {
    shutdown_opencode_bridge_resources(
        state.opencode_sdk_bridge.clone(),
        state.opencode_sdk_sessions.clone(),
    )
    .await
}

#[cfg(test)]
mod local_models_payload_tests {
    use super::*;
    use crate::mlx::types::{MlxModel, MlxModelSource};

    #[tokio::test]
    async fn remote_logs_stream_parts_without_duplicates_and_pair_tools() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE agent_logs (id TEXT PRIMARY KEY, thread_id TEXT, direction TEXT, content TEXT, log_type TEXT, timestamp TEXT)")
            .execute(&pool).await.unwrap();
        let mut rows = HashMap::new();
        for event in [
            json!({"type":"thinking","partId":"reason","fullText":"Considering"}),
            json!({"type":"assistant_text","partId":"text","fullText":"Hel"}),
            json!({"type":"assistant_text","partId":"text","fullText":"Hello"}),
            json!({"type":"tool_use","partId":"tool","toolName":"read","input":{"filePath":"src/main.rs"}}),
            json!({"type":"tool_result","partId":"tool","output":"contents","isError":false}),
            json!({"type":"tool_result","partId":"tool","output":"contents","isError":false}),
        ] {
            persist_opencode_event(&pool, &mut rows, "thread", &event).await.unwrap();
        }
        let mut logs = crate::db::queries::get_agent_logs(&pool, "thread", 200).await.unwrap();
        logs.reverse();
        assert_eq!(logs.len(), 4);
        let entries = crate::remote::timeline::agent_logs_to_entries(&logs);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].kind, "thinking");
        assert_eq!(entries[1].text.as_deref(), Some("Hello"));
        assert_eq!(entries[2].tool_name.as_deref(), Some("read"));
        assert_eq!(entries[2].body.as_deref(), Some("contents"));
        assert_eq!(entries[2].status.as_deref(), Some("ok"));
        persist_opencode_event(&pool, &mut rows, "other-thread", &json!({"type":"assistant_text","partId":"text","fullText":"Other reply"})).await.unwrap();
        assert_eq!(crate::db::queries::get_agent_logs(&pool, "thread", 200).await.unwrap().len(), 4);
    }

    fn model(id: &str, display: &str) -> MlxModel {
        MlxModel {
            id: id.to_string(),
            display_name: display.to_string(),
            source: MlxModelSource::XanomManaged,
            path: std::path::PathBuf::from("/tmp").join(id),
            size_bytes: 1,
            quant: None,
            context_window: None,
            supports_tools: true,
        }
    }

    fn model_without_tools(id: &str) -> MlxModel {
        MlxModel { supports_tools: false, ..model(id, id) }
    }

    /// The sidecar reads `id`/`displayName` verbatim off each entry. A rename
    /// on either side silently degrades to "no local provider declared", which
    /// is exactly the bug this payload exists to fix — so pin the key names.
    #[test]
    fn uses_the_key_names_the_sidecar_reads() {
        let out = local_models_payload(&[model("mlx-community/Qwen3-8B-4bit", "Qwen3-8B-4bit")]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["id"].as_str(), Some("mlx-community/Qwen3-8B-4bit"));
        assert_eq!(out[0]["displayName"].as_str(), Some("Qwen3-8B-4bit"));
    }

    #[test]
    fn preserves_order_and_maps_every_model() {
        let out = local_models_payload(&[model("a/b", "B"), model("c/d", "D")]);
        let ids: Vec<_> = out.iter().map(|v| v["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["a/b", "c/d"]);
    }

    /// OpenCode has no non-tool fallback: a model it can't issue `tool_calls`
    /// to looks fine until the first file edit. Keep it out of the config
    /// entirely rather than let the user pick it.
    #[test]
    fn omits_models_that_cannot_call_tools() {
        let out = local_models_payload(&[
            model("a/b", "B"),
            model_without_tools("c/no-tools"),
            model("d/e", "E"),
        ]);
        let ids: Vec<_> = out.iter().map(|v| v["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["a/b", "d/e"]);
    }

    #[test]
    fn an_all_unsupported_install_declares_no_local_models() {
        let out = local_models_payload(&[model_without_tools("a/b"), model_without_tools("c/d")]);
        assert!(out.is_empty());
    }

    /// `buildOpencodeConfig` returns `{}` for an empty list, so the payload
    /// must be an empty array (not null) — the sidecar's `?? []` fallback
    /// would otherwise be the only thing keeping the shape valid.
    #[test]
    fn empty_installed_set_serializes_as_an_empty_array() {
        let payload = json!({ "localModels": local_models_payload(&[]) });
        assert_eq!(payload["localModels"].as_array().map(|a| a.len()), Some(0));
    }
}

#[cfg(test)]
mod shell_event_tests {
    use super::*;

    fn start(part: &str, event_id: Value) -> Value {
        json!({"type": "tool_use", "partId": part, "eventId": event_id,
            "toolName": "bash", "input": {"command": "echo changed > file.txt"}})
    }

    fn result(part: &str, event_id: Value) -> Value {
        json!({"type": "tool_result", "partId": part, "eventId": event_id,
            "isError": false, "output": "done"})
    }

    #[test]
    fn reconstructed_pair_with_same_event_id_is_ineligible() {
        let mut starts = HashMap::new();
        normalize_shell_event(&mut starts, "thread", &start("part", json!("event")));
        let out = normalize_shell_event(&mut starts, "thread", &result("part", json!("event")));
        assert_eq!(out["snapshotEligible"], false);
        assert!(starts.is_empty());
    }

    #[test]
    fn distinct_start_and_result_ids_are_eligible_once() {
        let mut starts = HashMap::new();
        let input = start("part", json!("start"));
        let out = normalize_shell_event(&mut starts, "thread", &input);
        assert_eq!(out, json!({"type": "tool.started", "toolUseId": "part",
            "name": "bash", "input": input["input"]}));
        let end = result("part", json!("end"));
        assert_eq!(normalize_shell_event(&mut starts, "thread", &end), json!({
            "type": "tool.completed", "toolUseId": "part", "isError": false,
            "output": "done", "snapshotEligible": true,
        }));
        assert_eq!(normalize_shell_event(&mut starts, "thread", &end)["snapshotEligible"], false);
    }

    #[test]
    fn missing_start_or_event_id_is_ineligible() {
        let mut starts = HashMap::new();
        assert_eq!(normalize_shell_event(&mut starts, "thread", &result("part", json!("end")))["snapshotEligible"], false);
        for (start_id, end_id) in [(Value::Null, json!("end")), (json!("start"), Value::Null), (Value::Null, Value::Null)] {
            let mut begin = start("part", start_id);
            let mut end = result("part", end_id);
            if begin["eventId"].is_null() { begin.as_object_mut().unwrap().remove("eventId"); }
            if end["eventId"].is_null() { end.as_object_mut().unwrap().remove("eventId"); }
            normalize_shell_event(&mut starts, "thread", &begin);
            assert_eq!(normalize_shell_event(&mut starts, "thread", &end)["snapshotEligible"], false);
            assert!(starts.is_empty());
        }
    }

    #[test]
    fn starts_are_scoped_by_thread_and_part() {
        let mut starts = HashMap::new();
        for (thread, part, event) in [("a", "one", "a-one"), ("a", "two", "a-two"), ("b", "one", "b-one")] {
            normalize_shell_event(&mut starts, thread, &start(part, json!(event)));
        }
        // An unmatched result must neither borrow nor consume another pair's start.
        assert_eq!(normalize_shell_event(&mut starts, "b", &result("two", json!("end")))["snapshotEligible"], false);
        assert_eq!(starts.len(), 3);
        assert_eq!(normalize_shell_event(&mut starts, "a", &result("one", json!("a-one")))["snapshotEligible"], false);
        assert_eq!(normalize_shell_event(&mut starts, "a", &result("two", json!("end")))["snapshotEligible"], true);
        assert_eq!(normalize_shell_event(&mut starts, "b", &result("one", json!("end")))["snapshotEligible"], true);
        assert!(starts.is_empty());
    }

    #[test]
    fn repeated_start_preserves_first_event_id() {
        let mut starts = HashMap::new();
        normalize_shell_event(&mut starts, "thread", &start("part", json!("start")));
        normalize_shell_event(&mut starts, "thread", &start("part", json!("end")));
        assert_eq!(normalize_shell_event(&mut starts, "thread", &result("part", json!("end")))["snapshotEligible"], true);
    }

    #[test]
    fn output_is_retained_verbatim_for_yielded_detection() {
        for output in [
            json!("Script running with cell ID 9"),
            json!("Process running with session ID 42"),
            json!(r#"{"session_id":42,"output":"working"}"#),
            json!({"session_id": 42, "exit_code": null}),
            json!([{"text": "Script running with cell ID 9"}]),
        ] {
            let mut starts = HashMap::new();
            normalize_shell_event(&mut starts, "thread", &start("part", json!("start")));
            let mut end = result("part", json!("end"));
            end["output"] = output.clone();
            let out = normalize_shell_event(&mut starts, "thread", &end);
            assert_eq!(out["output"], output);
            assert_eq!(out["snapshotEligible"], true);
            assert_eq!(end["type"], "tool_result");
        }
    }
}

fn next_execution_model(method: &str, params: &Value, current: &ExecutionModel) -> ExecutionModel {
    match method {
        "startSession" if current.is_none() => Some(params.get("model").and_then(Value::as_str).map(str::to_string)),
        "setModel" => Some(params.get("model").and_then(Value::as_str).map(str::to_string)),
        "stopSession" => None,
        _ => current.clone(),
    }
}

#[cfg(test)]
mod execution_model_tests {
    use super::*;

    #[tokio::test]
    async fn initialize_during_inflight_turn_detaches_its_late_acknowledgment() {
        // A local sink replaces the sidecar; inject only the initialize ACK.
        // No provider process, policy network request or real credentials used.
        let mut child = Command::new("cat")
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
            .kill_on_drop(true).spawn().expect("spawn test sink");
        let stdin = child.stdin.take().expect("test stdin");
        let old_slot = Arc::new(Mutex::new(Some(Some("provider/old".into()))));
        let bridge = OpenCodeBridge {
            execution_generations: Default::default(),
            execution_lifecycle: RwLock::new(()),
            execution_models: Mutex::new(HashMap::from([("thread".into(), old_slot.clone())])),
            pid: 0,
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(stdin)),
            is_shutting_down: Arc::new(AtomicBool::new(false)),
            next_request_id: Arc::new(Mutex::new(0)),
            pending_responses: Arc::new(Mutex::new(HashMap::new())),
        };
        // The dispatched turn keeps its per-thread guard until its late ACK.
        let mut inflight_config = old_slot.lock().await;
        let old_acknowledged_model = inflight_config.clone();
        *inflight_config = Some(None);
        let initialize = bridge.send_request("initialize", json!({}));
        let acknowledge = async {
            loop {
                if let Some(response) = bridge.pending_responses.lock().await.remove(&1) {
                    response.send(Ok(json!({"serverUrl":"test"}))).unwrap();
                    break;
                }
                tokio::task::yield_now().await;
            }
        };
        let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::join!(initialize, acknowledge)
        }).await.expect("initialize must not wait for the old turn");
        result.expect("initialize ACK");
        assert!(bridge.execution_models.lock().await.is_empty());
        let replacement = Arc::new(Mutex::new(Some(Some("provider/new".into()))));
        bridge.execution_models.lock().await.insert("thread".into(), replacement.clone());
        // This is the late sendMessage ACK: only the detached Arc is updated.
        *inflight_config = old_acknowledged_model;
        let registry = bridge.execution_models.lock().await;
        assert!(Arc::ptr_eq(registry.get("thread").unwrap(), &replacement));
        assert_eq!(*replacement.lock().await, Some(Some("provider/new".into())));
        bridge.child.lock().await.kill().await.expect("stop test sink");
    }

    #[test]
    fn warm_start_retains_the_model_the_sidecar_actually_uses() {
        let current = Some(Some("provider/old".into()));
        let requested = json!({"model":"provider/new"});
        assert_eq!(next_execution_model("startSession", &requested, &current), current);
        assert_eq!(next_execution_model("startSession", &requested, &None), Some(Some("provider/new".into())));
        assert_eq!(next_execution_model("setModel", &requested, &current), Some(Some("provider/new".into())));
        assert_eq!(next_execution_model("sendMessage", &json!({}), &current), current);
        assert_eq!(next_execution_model("setAgent", &json!({"agent":"plan"}), &current), current);
    }

    #[test]
    fn ambiguous_configuration_stays_unknown_until_explicitly_set_or_stopped() {
        let unknown = Some(None);
        assert_eq!(next_execution_model("startSession", &json!({"model":"requested"}), &unknown), unknown);
        assert_eq!(next_execution_model("sendMessage", &json!({}), &unknown), unknown);
        assert_eq!(next_execution_model("stopSession", &json!({}), &unknown), None);
    }
}

/// Match the bridge's first-# variant split and exact local provider prefix.
/// MLX policies use canonical local/<id>, matching the UI and local gateway.
fn execution_provider_model(model: Option<&str>) -> (&'static str, Option<&str>) {
    let model = model.map(|slug| slug.split('#').next().unwrap_or(slug));
    match model.and_then(|slug| slug.strip_prefix("local/")).filter(|id| !id.is_empty()) {
        Some(_) => ("MLX", model),
        None => ("OpenCode", model),
    }
}

#[cfg(test)]
mod execution_provider_tests {
    use super::*;

    #[test]
    fn only_exact_local_provider_is_mlx_and_variant_is_not_the_model() {
        assert_eq!(execution_provider_model(Some("local/org/model#high")), ("MLX", Some("local/org/model")));
        assert_eq!(execution_provider_model(Some("provider/model#high")), ("OpenCode", Some("provider/model")));
        assert_eq!(execution_provider_model(Some("locality/model")), ("OpenCode", Some("locality/model")));
        assert_eq!(execution_provider_model(None), ("OpenCode", None));
        assert_eq!(execution_provider_model(Some("local/")), ("OpenCode", Some("local/")));
    }
}
