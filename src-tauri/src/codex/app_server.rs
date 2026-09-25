//! Codex App Server JSON-RPC client.
//!
//! Spawns `codex app-server` as a child process and communicates via
//! line-delimited JSON-RPC over stdin/stdout.
//!
//! Supports multi-workspace: one app-server per workspace path, each managed
//! independently via `CodexServerManager`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};

use crate::codex::approval_rules::matches_pattern;
use crate::process::provider::build_augmented_path;
use tauri::{Emitter, Manager};

/// Request timeout: 300s (matches CodexMonitor).
const REQUEST_TIMEOUT_SECS: u64 = 300;

pub(crate) fn register_capture_instance(directory: &std::path::Path, instance: &str, pid: u32) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    use std::io::Write;
    if uuid::Uuid::parse_str(instance).is_err() || pid <= 1 || !directory.is_absolute()
        || directory.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "Invalid capture owner"));
    }
    for path in directory.ancestors() {
        match std::fs::symlink_metadata(path) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() =>
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "Linked capture owner directory")),
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
    }
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(directory)?;
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW).open(directory.join(format!("{instance}.json")))?;
    file.write_all(json!({"serverInstance":instance,"pid":pid}).to_string().as_bytes())?;
    file.sync_all()
}

struct PendingRequestGuard {
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    id: u64,
}

impl Drop for PendingRequestGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.pending.try_lock() {
            pending.remove(&self.id);
            return;
        }
        let pending = self.pending.clone();
        let id = self.id;
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move { pending.lock().await.remove(&id); });
        }
    }
}

fn drain_codex_stderr(child: &mut Child) {
    if let Some(mut stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
        });
    }
}

// MCP consent can outlive a mounted chat view. Keep it until Codex or the
// user resolves it, so a missed frontend event does not strand the tool.
fn update_pending_mcp_requests(pending: &mut HashMap<u64, Value>, event: &Value) {
    let params = &event["params"];
    match event["method"].as_str() {
        Some("mcpServer/elicitation/request") => {
            if let Some(id) = event["requestId"].as_u64() {
                pending.insert(id, event.clone());
            }
        }
        Some("serverRequest/resolved") => {
            if let Some(id) = params["requestId"].as_u64() { pending.remove(&id); }
        }
        Some("turn/completed" | "turn/failed" | "turn/aborted" | "thread/archived") => {
            let tid = extract_thread_id(event);
            let turn_id = extract_turn_id(event);
            pending.retain(|_, request| {
                tid.is_none() || extract_thread_id(request) != tid
                    || (turn_id.is_some() && extract_turn_id(request).is_some()
                        && extract_turn_id(request) != turn_id)
            });
        }
        _ => {}
    }
}

/// Idle app-servers (no open turns) are shut down after this much inactivity.
/// Home discovery spawns one server per project; without a TTL those stick
/// around forever (~60–100 MB each). The next list/start re-spawns as needed.
pub const CODEX_SERVER_IDLE_TTL_SECS: u64 = 120;

/// How often the background reaper scans for idle Codex app-servers.
pub const CODEX_SERVER_IDLE_SWEEP_SECS: u64 = 30;

/// Codex threads with an open turn, keyed by thread id → turn start.
///
/// Codex is the one provider with no hook relay and no DB turn rows, so
/// nothing outside the frontend knew a Codex turn was in flight — the phone
/// could never show "Working…" or a Stop button for a Codex session. The
/// notification loop is the only place that sees `turn/started` /
/// `turn/completed`, so it maintains this registry the same way the hook
/// server maintains `hooks::hook_running_session_ids`.
static CODEX_ACTIVE_TURNS: std::sync::Mutex<Option<HashMap<String, std::time::Instant>>> =
    std::sync::Mutex::new(None);

/// Backstop for a `turn/completed` that never arrives (interrupt races, a
/// killed app-server). Without it a missed terminal event would pin a session
/// to "Running" forever.
const CODEX_TURN_MAX_AGE_SECS: u64 = 3600;

fn codex_turn_started(thread_id: &str) {
    let mut guard = CODEX_ACTIVE_TURNS.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .get_or_insert_with(HashMap::new)
        .insert(thread_id.to_string(), std::time::Instant::now());
}

fn codex_turn_ended(thread_id: &str) {
    let mut guard = CODEX_ACTIVE_TURNS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(map) = guard.as_mut() {
        map.remove(thread_id);
    }
}

/// Every Codex thread whose turn is still open. Stale entries (see
/// `CODEX_TURN_MAX_AGE_SECS`) are dropped on read so a missed terminal event
/// self-heals instead of sticking a permanent spinner on the phone.
pub fn codex_active_turn_thread_ids() -> HashSet<String> {
    let mut guard = CODEX_ACTIVE_TURNS.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_mut() {
        Some(map) => {
            map.retain(|_, started| started.elapsed().as_secs() < CODEX_TURN_MAX_AGE_SECS);
            map.keys().cloned().collect()
        }
        None => HashSet::new(),
    }
}

/// Drop the given turns — their app-server died, so no `turn/completed` is
/// coming for any of them.
fn codex_turns_clear(thread_ids: &HashSet<String>) {
    if thread_ids.is_empty() {
        return;
    }
    let mut guard = CODEX_ACTIVE_TURNS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(map) = guard.as_mut() {
        for id in thread_ids {
            map.remove(id);
        }
    }
}
const METHOD_THREAD_COMPACT_START: &str = "thread/compact/start";
const METHOD_THREAD_NAME_SET: &str = "thread/name/set";
const METHOD_ACCOUNT_RATE_LIMITS_READ: &str = "account/rateLimits/read";

/// An image attachment to be sent alongside a text message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    /// Base64-encoded image data.
    pub data: String,
    /// MIME type of the image (e.g. "image/png").
    pub media_type: String,
}

/// Whether `turn/start` can run as-is or the thread must be loaded first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TurnStartLoadAction {
    Start,
    ResumeThenStart,
}

/// Codex `turn/start` only works on a thread loaded in this app-server
/// process. After Stop, the idle reaper, or a process recycle, the rollout is
/// still on disk but the id is gone from the in-memory registry.
fn turn_start_load_action(loaded_ids: Option<&[String]>, thread_id: &str) -> TurnStartLoadAction {
    match loaded_ids {
        Some(ids) if ids.iter().any(|id| id == thread_id) => TurnStartLoadAction::Start,
        _ => TurnStartLoadAction::ResumeThenStart,
    }
}

fn is_unloaded_thread_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("thread not found") || lower.contains("thread not loaded")
}

fn image_attachment_to_input(img: &ImageAttachment) -> Value {
    json!({
        "type": "image",
        "url": format!("data:{};base64,{}", img.media_type, img.data),
    })
}

fn build_turn_start_params(
    thread_id: &str,
    text: &str,
    model: Option<&str>,
    effort: Option<&str>,
    cwd: &str,
    access_mode: Option<&str>,
    images: &[ImageAttachment],
    collaboration_mode: Option<Value>,
    service_tier: Option<&str>,
    additional_context: Option<&str>,
) -> Value {
    let mut input = vec![json!({"type": "text", "text": text})];
    for img in images {
        input.push(image_attachment_to_input(img));
    }

    let access = access_mode.unwrap_or("default");
    let sandbox_policy = match access {
        "full-access" => json!({ "type": "dangerFullAccess" }),
        "read-only" => json!({ "type": "readOnly" }),
        // "default" | "auto" | "auto-review" keep workspace-write sandbox
        _ => json!({
            "type": "workspaceWrite",
            "writableRoots": [cwd],
            "networkAccess": true
        }),
    };

    let approval_policy = if access == "full-access" {
        "never"
    } else {
        "on-request"
    };

    // Who reviews approval requests (sandbox escapes, network, MCP, etc.).
    // `auto_review` routes them to Codex's risk-based subagent instead of the
    // user. Always set explicitly: turn/start treats this as sticky for later
    // turns, so leaving it out would not clear a prior auto-review selection.
    let approvals_reviewer = match access {
        "auto" | "auto-review" => "auto_review",
        _ => "user",
    };

    let mut params = json!({
        "threadId": thread_id,
        "input": input,
        "cwd": cwd,
        "approvalPolicy": approval_policy,
        "sandboxPolicy": sandbox_policy,
        "approvalsReviewer": approvals_reviewer,
    });

    if let Some(model) = model {
        params["model"] = json!(model);
    }
    if let Some(effort) = effort {
        params["effort"] = json!(effort);
    }
    if let Some(mode) = collaboration_mode {
        if !mode.is_null() {
            params["collaborationMode"] = mode;
        }
    }
    if let Some(service_tier) = service_tier {
        params["serviceTier"] = json!(service_tier);
    }
    if let Some(context) = additional_context.filter(|value| !value.is_empty()) {
        params["additionalContext"] = json!({
            "agmux-memory": {
                "value": context,
                "kind": "application"
            }
        });
    }

    params
}

// ── Hidden thread detection ─────────────────────────────

/// Check if a `thread/started` event is a memory consolidation thread that should be hidden.
fn thread_started_is_hidden(value: &Value) -> bool {
    let source = value.get("params").and_then(|params| {
        params
            .get("thread")
            .and_then(|thread| thread.get("source"))
            .or_else(|| params.get("source"))
    });

    if let Some(source) = source {
        // Check for subAgent.kind == "memory_consolidation"
        if let Some(sub_agent) = source.get("subAgent").or_else(|| source.get("sub_agent")) {
            let kind = sub_agent.get("kind").and_then(|k| k.as_str()).or_else(|| {
                // Single-key object pattern: { "memory_consolidation": { ... } }
                let obj = sub_agent.as_object()?;
                let keys: Vec<&String> = obj
                    .keys()
                    .filter(|k| k.as_str() != "thread_spawn" && k.as_str() != "threadSpawn")
                    .collect();
                if keys.len() == 1 {
                    Some(keys[0].as_str())
                } else {
                    None
                }
            });
            if let Some(k) = kind {
                let normalized = k.to_ascii_lowercase().replace('-', "_");
                return normalized == "memory_consolidation";
            }
        }
    }
    false
}

/// Check if an event for a hidden thread should be suppressed (not emitted to frontend).
fn should_suppress_hidden_thread_event(method: Option<&str>, has_result_or_error: bool) -> bool {
    // Always allow responses and archive/background notifications through
    !has_result_or_error
        && !matches!(
            method,
            Some("thread/archived") | Some("codex/backgroundThread")
        )
}

/// Extract the shell command string from a `commandExecution/requestApproval`
/// payload. Codex's protocol carries the argv as `Vec<String>` but older /
/// experimental builds (and our test fixtures) sometimes send it as a single
/// joined string, so we accept both shapes.
fn extract_approval_command(value: &Value) -> Option<String> {
    let c = value.get("params")?.get("command")?;
    if let Some(s) = c.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = c.as_array() {
        let parts: Vec<&str> = arr.iter().filter_map(|v| v.as_str()).collect();
        if parts.is_empty() {
            return None;
        }
        return Some(parts.join(" "));
    }
    None
}

/// JSON-RPC reply that approves an allowlisted `commandExecution/requestApproval`.
fn allowlist_approval_response(id: u64) -> Value {
    json!({
        "id": id,
        "result": { "decision": "accept" }
    })
}

/// Extract a thread ID from a JSON-RPC message.
fn extract_thread_id(value: &Value) -> Option<String> {
    value
        .get("params")
        .and_then(|p| {
            p.get("threadId")
                .or_else(|| p.get("thread_id"))
                .or_else(|| p.get("thread").and_then(|t| t.get("id")))
        })
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn extract_turn_id(value: &Value) -> Option<String> {
    let payload = value.get("params").unwrap_or(value);
    payload
        .get("turnId")
        .or_else(|| payload.get("turn_id"))
        .or_else(|| payload.get("turn").and_then(|turn| turn.get("id")))
        .and_then(|turn_id| turn_id.as_str())
        .map(str::to_string)
}

// ── CodexAppServer ──────────────────────────────────────

#[derive(Debug)]
enum ThreadActivity {
    Reserved { generation: u64 },
    Running {
        generation: u64,
        provider_turn_id: String,
    },
}

#[derive(Default)]
struct ThreadActivityRegistry {
    next_generation: u64,
    entries: HashMap<String, ThreadActivity>,
}

impl ThreadActivityRegistry {
    fn next_generation(&mut self) -> u64 {
        self.next_generation = self.next_generation.wrapping_add(1).max(1);
        self.next_generation
    }

    fn reserve(&mut self, thread_id: &str) -> Result<u64, String> {
        if self.entries.contains_key(thread_id) {
            return Err(format!(
                "Codex turn is already active for thread {thread_id}"
            ));
        }
        let generation = self.next_generation();
        self.entries.insert(
            thread_id.to_string(),
            ThreadActivity::Reserved { generation },
        );
        Ok(generation)
    }

    fn mark_started(&mut self, thread_id: &str, provider_turn_id: &str) {
        let current = self.entries.remove(thread_id);
        let activity = match current {
            Some(ThreadActivity::Reserved { generation, .. }) => ThreadActivity::Running {
                generation,
                provider_turn_id: provider_turn_id.to_string(),
            },
            Some(activity @ ThreadActivity::Running { .. }) => activity,
            None => ThreadActivity::Running {
                generation: self.next_generation(),
                provider_turn_id: provider_turn_id.to_string(),
            },
        };
        self.entries.insert(thread_id.to_string(), activity);
    }

    fn mark_terminal(&mut self, thread_id: &str, provider_turn_id: &str) -> bool {
        let matches_current = matches!(
            self.entries.get(thread_id),
            Some(ThreadActivity::Running {
                provider_turn_id: current,
                ..
            }) if current == provider_turn_id
        );
        if matches_current {
            self.entries.remove(thread_id);
        }
        matches_current
    }

    fn mark_thread_status_terminal(&mut self, thread_id: &str) {
        if matches!(self.entries.get(thread_id), Some(ThreadActivity::Running { .. })) {
            self.entries.remove(thread_id);
        }
    }

    fn release_reservation(&mut self, thread_id: &str, generation: u64) {
        let owns_current = matches!(
            self.entries.get(thread_id),
            Some(ThreadActivity::Reserved {
                generation: current,
                ..
            }) if *current == generation
        );
        if owns_current {
            self.entries.remove(thread_id);
        }
    }

    fn commit_reservation(
        &mut self,
        thread_id: &str,
        generation: u64,
        provider_turn_id: Option<&str>,
    ) {
        match self.entries.get(thread_id) {
            Some(ThreadActivity::Reserved {
                generation: current,
                ..
            }) if *current == generation => {
                if let Some(provider_turn_id) = provider_turn_id {
                    self.entries.insert(
                        thread_id.to_string(),
                        ThreadActivity::Running {
                            generation,
                            provider_turn_id: provider_turn_id.to_string(),
                        },
                    );
                }
            }
            Some(ThreadActivity::Running {
                generation: current,
                provider_turn_id: current_turn_id,
                ..
            }) if *current == generation
                && provider_turn_id.map_or(true, |turn_id| turn_id == current_turn_id) => {}
            _ => {}
        }
    }

    #[cfg(test)]
    fn is_reserved(&self, thread_id: &str, generation: u64) -> bool {
        matches!(
            self.entries.get(thread_id),
            Some(ThreadActivity::Reserved {
                generation: current,
                ..
            }) if *current == generation
        )
    }

    fn has_active(&self) -> bool {
        !self.entries.is_empty()
    }

    fn is_thread_active(&self, thread_id: &str) -> bool {
        self.entries.contains_key(thread_id)
    }

    fn clear(&mut self) {
        self.entries.clear();
    }
}

fn update_active_turns_from_notification(
    activity: &std::sync::Mutex<ThreadActivityRegistry>,
    value: &Value,
) {
    enum Update {
        Started(String),
        Terminal(String),
        StatusTerminal,
    }
    let update = match value.get("method").and_then(|method| method.as_str()) {
        Some("turn/started") => match extract_turn_id(value) {
            Some(turn_id) => Update::Started(turn_id),
            None => return,
        },
        Some("turn/completed") | Some("turn/failed") | Some("turn/aborted") => {
            match extract_turn_id(value) {
                Some(turn_id) => Update::Terminal(turn_id),
                None => return,
            }
        }
        // Collab children emit `idle` on the parent thread id when a child
        // finishes. Clearing the parent turn here lets the idle reaper kill
        // the app-server while the parent is still working, which drops the
        // live event stream (agmux then only catches up after a full restart).
        // Only `systemError` is a real terminal status without a turn id.
        Some("thread/status/changed")
            if matches!(
                value
                    .get("params")
                    .and_then(|params| params.get("status"))
                    .and_then(|status| status.get("type"))
                    .and_then(|status_type| status_type.as_str()),
                Some("systemError")
            ) => Update::StatusTerminal,
        _ => return,
    };
    let Some(thread_id) = extract_thread_id(value) else {
        return;
    };
    let mut activity = activity.lock().unwrap_or_else(|e| e.into_inner());
    match update {
        Update::Started(turn_id) => {
            activity.mark_started(&thread_id, &turn_id);
        }
        Update::Terminal(turn_id) => {
            activity.mark_terminal(&thread_id, &turn_id);
        }
        Update::StatusTerminal => activity.mark_thread_status_terminal(&thread_id),
    }
}

struct ActiveTurnReservation {
    activity: Arc<std::sync::Mutex<ThreadActivityRegistry>>,
    thread_id: String,
    generation: u64,
    committed: bool,
}

impl ActiveTurnReservation {
    fn new(
        activity: Arc<std::sync::Mutex<ThreadActivityRegistry>>,
        thread_id: &str,
    ) -> Result<Self, String> {
        let generation = activity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reserve(thread_id)?;
        Ok(Self {
            activity,
            thread_id: thread_id.to_string(),
            generation,
            committed: false,
        })
    }

    fn commit(&mut self, result: &Value) {
        self.activity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .commit_reservation(
                &self.thread_id,
                self.generation,
                extract_turn_id(result).as_deref(),
            );
        self.committed = true;
    }
}

impl Drop for ActiveTurnReservation {
    fn drop(&mut self) {
        if !self.committed {
            self.activity
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .release_reservation(&self.thread_id, self.generation);
        }
    }
}

pub struct CodexTurnReservation {
    server: Arc<CodexAppServer>,
    active_turn: ActiveTurnReservation,
}

impl CodexTurnReservation {
    pub fn server(&self) -> &CodexAppServer {
        &self.server
    }

    pub fn commit(mut self, result: &Value) {
        self.active_turn.commit(result);
    }
}

/// A running Codex app-server process with JSON-RPC communication.
pub struct CodexAppServer {
    /// Child process handle
    _child: Arc<Mutex<Child>>,
    /// Stdin writer (send requests)
    stdin: Arc<Mutex<tokio::process::ChildStdin>>,
    /// Pending request channels: id -> oneshot sender
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    pending_mcp_requests: Arc<Mutex<HashMap<u64, Value>>>,
    request_ids: Arc<std::sync::Mutex<crate::provider_accounts::runtime::RequestIds>>,
    /// Public request id -> Codex thread that raised it, so desktop answers
    /// clear the right phone card even when another thread reuses the id.
    request_threads: Arc<std::sync::Mutex<HashMap<u64, String>>>,
    pub account_id: Option<String>,
    /// Auto-incrementing request ID
    next_id: Arc<AtomicU64>,
    /// Tauri app handle for emitting events
    app_handle: tauri::AppHandle,
    /// Flag for shutdown
    is_shutting_down: Arc<std::sync::atomic::AtomicBool>,
    /// Thread IDs that are hidden (memory consolidation, background threads).
    /// Accessed via Arc clone in the read loop task.
    #[allow(dead_code)]
    hidden_thread_ids: Arc<Mutex<HashSet<String>>>,
    /// Per-workspace command allowlist patterns. Exec-approval requests whose
    /// command matches any pattern are auto-approved inside the read loop and
    /// never reach the frontend.
    approval_rules: Arc<Mutex<HashSet<String>>>,
    /// The workspace path this server was spawned for
    pub work_dir: String,
    /// Private identity of this exact process, inherited by synchronous hooks.
    pub(crate) capture_instance: String,
    capture_cwd: String,
    /// True only when this process was spawned with an agmux-memory MCP override.
    memory_mcp_configured: bool,
    /// Whether this server was spawned with a resolved agmux project.
    memory_project_resolved: bool,
    /// Ownership records for turns submitted to this app-server.
    thread_activity: Arc<std::sync::Mutex<ThreadActivityRegistry>>,
    /// Last time this server handled an RPC or was handed out by the manager.
    /// Idle reaping uses this so discovery-spawned servers don't stick forever.
    last_used: std::sync::Mutex<Instant>,
}

impl CodexAppServer {
    /// Spawn a new `codex app-server` process and start the read loop.
    ///
    /// When `project_id` + `repo_path` are known, injects project-memory MCP and
    /// developer_instructions so structured Codex chat uses the same shared store.
    pub async fn spawn(
        app_handle: tauri::AppHandle,
        work_dir: &str,
        project_id: Option<&str>,
        repo_path: Option<&str>,
    ) -> anyhow::Result<Self> {
        Self::spawn_with_account(app_handle, work_dir, project_id, repo_path, None).await
    }

    async fn spawn_with_account(
        app_handle: tauri::AppHandle,
        work_dir: &str,
        project_id: Option<&str>,
        repo_path: Option<&str>,
        account: Option<&crate::provider_accounts::AccountAssignment>,
    ) -> anyhow::Result<Self> {
        let augmented_path = build_augmented_path();
        let mut capture_instance = uuid::Uuid::new_v4().to_string();
        let capture_cwd = std::fs::canonicalize(work_dir)?.to_string_lossy().into_owned();

        if let Err(error) = crate::hooks::codex_diff::ensure_trusted().await {
            tracing::warn!(%error, "Codex synchronous diff hooks unavailable");
        }

        let mut cmd = Command::new("codex");
        cmd.arg("app-server")
            .current_dir(work_dir)
            .env("PATH", &augmented_path)
            .env("FORCE_COLOR", "0")
            .env("AGMUX_SHELL_DIFF_HOOK", "1")
            .env("AGMUX_CODEX_CAPTURE_INSTANCE", &capture_instance)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        if let Some(account) = account.filter(|a| !a.account_id.starts_with("native:")) {
            cmd.env("CODEX_HOME", &account.home)
                .env_remove("OPENAI_API_KEY").env_remove("CODEX_API_KEY");
        }
        let request_ids = Arc::new(std::sync::Mutex::new(crate::provider_accounts::runtime::RequestIds::default()));
        let request_threads = Arc::new(std::sync::Mutex::new(HashMap::<u64, String>::new()));
        let mut memory_mcp_configured = false;
        if crate::memory::is_enabled() {
            let instr_root = repo_path.unwrap_or(work_dir);
            // Project memory policy for all threads on this app-server process.
            for arg in crate::memory::codex_cli_developer_instruction_overrides(
                project_id,
                instr_root,
            ) {
                cmd.arg(arg);
            }
            if let (Some(pid), Some(repo)) = (project_id, repo_path) {
                // Multi-thread server: no process-wide AGMUX_THREAD_ID or
                // active-thread fallback. Each turn carries explicit identity.
                for (k, v) in crate::memory::memory_env_pairs_with_app(None, pid, repo, None) {
                    cmd.env(k, v);
                }
                if let Ok(overrides) =
                    crate::memory::codex_cli_mcp_overrides_for_thread(
                        None,
                        pid,
                        repo,
                        &[work_dir],
                        None,
                    )
                {
                    for arg in overrides {
                        cmd.arg(arg);
                    }
                    memory_mcp_configured = true;
                }
                let _ = crate::memory::ensure_memory(pid, repo, &[work_dir]);
            }
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| anyhow::anyhow!("Failed to spawn codex app-server: {}", e))?;
        let marker = child.id().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "Missing Codex process id"))
            .and_then(|pid| register_capture_instance(&crate::paths::agmux_home().join("shell-diff-hooks/instances"), &capture_instance, pid));
        if let Err(error) = marker {
            tracing::warn!(%error, "Codex capture recovery identity unavailable");
            // The child still runs and its ordinary hooks work; this process
            // cannot reconcile captures without a durable private owner marker.
            capture_instance.clear();
        }

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("Failed to capture stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("Failed to capture stdout"))?;
        // Never leave a piped stream unread: Codex can block on a full stderr
        // pipe before it delivers an approval or completion on stdout.
        drain_codex_stderr(&mut child);

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let is_shutting_down = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hidden_thread_ids: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        let approval_rules: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        let stdin_arc = Arc::new(Mutex::new(stdin));
        let thread_activity = Arc::new(std::sync::Mutex::new(ThreadActivityRegistry::default()));
        let pending_mcp_requests = Arc::new(Mutex::new(HashMap::<u64, Value>::new()));

        let server = Self {
            _child: Arc::new(Mutex::new(child)),
            stdin: stdin_arc.clone(),
            pending: pending.clone(),
            pending_mcp_requests: pending_mcp_requests.clone(),
            request_ids: request_ids.clone(),
            request_threads: request_threads.clone(),
            account_id: account.map(|a| a.account_id.clone()),
            next_id: Arc::new(AtomicU64::new(1)),
            app_handle: app_handle.clone(),
            is_shutting_down: is_shutting_down.clone(),
            hidden_thread_ids: hidden_thread_ids.clone(),
            approval_rules: approval_rules.clone(),
            work_dir: work_dir.to_string(),
            capture_instance,
            capture_cwd,
            memory_mcp_configured,
            memory_project_resolved: project_id.is_some() && repo_path.is_some(),
            thread_activity: thread_activity.clone(),
            last_used: std::sync::Mutex::new(Instant::now()),
        };

        let replay_pending = pending_mcp_requests.clone();
        let replay_shutdown = is_shutting_down.clone();
        let replay_app = app_handle.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            loop {
                interval.tick().await;
                if replay_shutdown.load(Ordering::Relaxed) { break; }
                let pending = replay_pending.lock().await;
                for event in pending.values() {
                    let _ = replay_app.emit("codex-event", event);
                }
            }
        });

        // Spawn the stdout read loop
        let pending_clone = pending.clone();
        let app_handle_clone = app_handle.clone();
        let shutdown_clone = is_shutting_down.clone();
        let hidden_clone = hidden_thread_ids.clone();
        let rules_clone = approval_rules.clone();
        let stdin_for_loop = stdin_arc.clone();
        let thread_activity_clone = thread_activity.clone();
        let work_dir_for_loop = work_dir.to_string();
        let managed_account = account.map(|a| a.account_id.clone());
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            // Turns this server opened — cleared if its read loop dies, so one
            // workspace's crash never wipes another workspace's live turns.
            let mut own_turns: HashSet<String> = HashSet::new();
            let mut sidebar_diffs = super::diff_stats::DiffObserver::default();
            let mut quota_failed_threads = HashSet::new();

            while let Ok(Some(line)) = lines.next_line().await {
                if shutdown_clone.load(Ordering::Relaxed) {
                    break;
                }
                if line.trim().is_empty() {
                    continue;
                }

                let value: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!(
                            "Failed to parse app-server line: {} - {}",
                            e,
                            crate::text::byte_prefix(&line, 200)
                        );
                        continue;
                    }
                };

                let maybe_id = value.get("id").and_then(|id| id.as_u64());
                let has_result = value.get("result").is_some();
                let has_error = value.get("error").is_some();
                let has_result_or_error = has_result || has_error;

                // Handle responses to our requests
                if let Some(id) = maybe_id {
                    if has_result_or_error {
                        let mut pending = pending_clone.lock().await;
                        if let Some(tx) = pending.remove(&id) {
                            let _ = tx.send(value);
                        }
                        continue;
                    }
                }

                // This is a notification or server request
                let method = value.get("method").and_then(|m| m.as_str());
                let method_str = method.unwrap_or("unknown");
                let thread_id = extract_thread_id(&value);

                // ── Allowlist short-circuit for exec approvals ──
                // If the model is asking us to approve a shell command and the
                // workspace has a pattern that matches, auto-respond `approved`
                // and skip emitting to the frontend so the user is never
                // bothered with a banner.
                if let (Some(id), Some("item/commandExecution/requestApproval")) =
                    (maybe_id, method)
                {
                    if let Some(cmd_str) = extract_approval_command(&value) {
                        let matched = {
                            let rules = rules_clone.lock().await;
                            rules.iter().any(|p| matches_pattern(&cmd_str, p))
                        };
                        if matched {
                            tracing::info!(
                                "Codex auto-approving (matched allowlist): {}",
                                cmd_str
                            );
                            let body = allowlist_approval_response(id);
                            match serde_json::to_string(&body) {
                                Ok(mut s) => {
                                    s.push('\n');
                                    let mut stdin_guard = stdin_for_loop.lock().await;
                                    if let Err(e) = stdin_guard.write_all(s.as_bytes()).await {
                                        tracing::warn!(
                                            "Failed to write auto-approval response: {}",
                                            e
                                        );
                                    }
                                    let _ = stdin_guard.flush().await;
                                    continue;
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        "Failed to serialize auto-approval body for command '{}': {} — falling through to manual approval",
                                        cmd_str,
                                        e
                                    );
                                }
                            }
                        }
                    }
                }

                // A typed native error is authoritative. Text in a tool result,
                // message, or terminal stream is never a quota signal.
                if managed_account.is_some() && method == Some("error")
                    && value.pointer("/params/error/codexErrorInfo").and_then(Value::as_str) == Some("usageLimitExceeded")
                {
                    if let Some(tid) = thread_id.as_deref() {
                        // Only the account still assigned to this exact thread may
                        // be marked; delayed events from an old process cannot poison its replacement.
                        if let Some(current) = crate::provider_accounts::current_assignment(tid).await {
                            if managed_account.as_deref() == Some(current.account_id.as_str()) {
                                quota_failed_threads.insert(tid.to_string());
                                if let Err(error) = crate::provider_accounts::mark_exhausted("codex", tid, None).await {
                                    tracing::warn!(%error, "Could not record Codex quota exhaustion");
                                }
                            }
                        }
                    }
                }

                // Track every open turn before hidden-thread filtering so a
                // memory toggle never retires a server doing background work.
                update_active_turns_from_notification(&thread_activity_clone, &value);

                // ── Hidden thread filtering ──
                if let Some(ref tid) = thread_id {
                    // Detect new hidden threads (memory consolidation)
                    if method == Some("thread/started") && thread_started_is_hidden(&value) {
                        hidden_clone.lock().await.insert(tid.clone());
                        // Emit a backgroundThread event so frontend knows to hide it
                        let bg_event = json!({
                            "method": "codex/backgroundThread",
                            "params": {
                                "threadId": tid,
                                "action": "hide"
                            }
                        });
                        let _ = app_handle_clone.emit("codex-event", &bg_event);
                        continue;
                    }

                    // Suppress events for hidden threads
                    let is_hidden = hidden_clone.lock().await.contains(tid);
                    if is_hidden && should_suppress_hidden_thread_event(method, has_result_or_error)
                    {
                        continue;
                    }
                }

                // Build and emit the event
                let params = value.get("params").cloned().unwrap_or(Value::Null);
                let mut event_payload = json!({
                    "method": method_str,
                    "params": params,
                });
                if let Some(id) = maybe_id {
                    let public = request_ids.lock().unwrap_or_else(|e| e.into_inner()).register(id);
                    event_payload["requestId"] = json!(public);
                    if let Some(tid) = thread_id.as_ref() {
                        request_threads.lock().unwrap_or_else(|e| e.into_inner()).insert(public, tid.clone());
                    }
                }
                if method == Some("serverRequest/resolved") {
                    if let Some(native) = event_payload["params"]["requestId"].as_u64() {
                        if let Some(public) = request_ids.lock().unwrap_or_else(|e| e.into_inner()).resolve(native) {
                            event_payload["params"]["requestId"] = json!(public);
                        } else {
                            // An unmapped native id must never resolve another
                            // account process's public approval by coincidence.
                            continue;
                        }
                    }
                }
                if matches!(method, Some("mcpServer/elicitation/request" | "serverRequest/resolved"
                    | "turn/completed" | "turn/failed" | "turn/aborted" | "thread/archived")) {
                    update_pending_mcp_requests(&mut *pending_mcp_requests.lock().await, &event_payload);
                }

                let child_turn_end = matches!(method, Some("turn/completed" | "turn/failed" | "turn/aborted"))
                    && thread_id.as_deref().is_some_and(|tid| thread_activity_clone
                        .lock().unwrap_or_else(|e| e.into_inner()).is_thread_active(tid));
                if !child_turn_end {
                    crate::shell_diff::observe_codex(&app_handle_clone, &work_dir_for_loop, &event_payload).await;
                    if let Some(tid) = thread_id.as_deref() {
                        if sidebar_diffs.observe(tid, method_str, &event_payload["params"]) {
                            super::diff_stats::refresh(&app_handle_clone, tid);
                        }
                    }
                }

                // Track open turns so surfaces without the event stream (remote
                // control) can tell a working session from an idle one.
                if let Some(ref tid) = thread_id {
                    match method {
                        Some("turn/started") => {
                            own_turns.insert(tid.clone());
                            codex_turn_started(tid);
                        }
                        Some("turn/completed") | Some("turn/failed") | Some("turn/aborted") => {
                            // Child turns reuse the parent thread id. The
                            // activity registry already ignores a mismatched
                            // turn id; only drop the parent when that turn
                            // is actually gone.
                            let still_active = thread_activity_clone
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .is_thread_active(tid);
                            if !still_active {
                                own_turns.remove(tid);
                                codex_turn_ended(tid);
                                request_threads.lock().unwrap_or_else(|e| e.into_inner()).retain(|_, t| t != tid);
                                crate::remote::notify_thread_requests_cleared(&app_handle_clone, tid);
                                if quota_failed_threads.remove(tid) {
                                    // Prepare a replacement only after native turn completion.
                                    // Never replay a user prompt or a partially executed tool.
                                    tokio::spawn(prepare_after_quota(app_handle_clone.clone(), work_dir_for_loop.clone(), tid.clone()));
                                }
                            }
                        }
                        _ => {}
                    }
                }

                if let Err(e) = app_handle_clone.emit("codex-event", &event_payload) {
                    tracing::warn!("Failed to emit codex event: {}", e);
                }

                if method_str == "item/tool/requestUserInput" {
                    if let (Some(id), Some(tid)) = (event_payload["requestId"].as_u64(), thread_id.as_deref()) {
                        crate::remote::notify_user_input(
                            &app_handle_clone, tid, &id.to_string(),
                            params.get("questions").cloned().unwrap_or_else(|| json!([])),
                        );
                    }
                }

                // Forward the same globally routed id to paired phones.
                if let Some(id) = event_payload["requestId"].as_u64() {
                    if method_str.contains("requestApproval") {
                        let tid = thread_id
                            .clone()
                            .or_else(|| {
                                params
                                    .get("threadId")
                                    .or_else(|| params.get("thread_id"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                            })
                            .unwrap_or_default();
                        if !tid.is_empty() {
                            let detail = extract_approval_command(&value)
                                .unwrap_or_else(|| {
                                    params
                                        .get("command")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string()
                                });
                            let tool = method_str.rsplit('/').next().unwrap_or("approval");
                            crate::remote::notify_approval(
                                &app_handle_clone,
                                &tid,
                                &id.to_string(),
                                tool,
                                &detail,
                            );
                        }
                    }
                }
            }

            // Read loop ended — emit a disconnection event so the frontend can
            // clear the "sending" spinner instead of hanging forever.
            // No further `turn/completed` can arrive on a dead read loop.
            codex_turns_clear(&own_turns);
            // A dead app-server can't take answers for requests it raised.
            let orphaned: HashSet<String> = std::mem::take(&mut *request_threads.lock().unwrap_or_else(|e| e.into_inner()))
                .into_values().collect();
            for tid in orphaned {
                crate::remote::notify_thread_requests_cleared(&app_handle_clone, &tid);
            }
            thread_activity_clone
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clear();

            if !shutdown_clone.load(Ordering::Relaxed) {
                tracing::warn!("Codex app-server read loop ended unexpectedly");
                let disconnect_event = json!({
                    "method": "codex/serverDisconnected",
                    "params": {
                        "reason": "App-server process exited or stdout closed"
                    }
                });
                crate::shell_diff::observe_codex(&app_handle_clone, &work_dir_for_loop, &disconnect_event).await;
                let _ = app_handle_clone.emit("codex-event", &disconnect_event);

                // Resolve all pending request channels so callers don't hang
                // for the full 300s timeout.
                let mut pending = pending_clone.lock().await;
                let ids: Vec<u64> = pending.keys().cloned().collect();
                for id in ids {
                    if let Some(tx) = pending.remove(&id) {
                        let _ = tx.send(json!({
                            "id": id,
                            "error": { "message": "App-server disconnected" }
                        }));
                    }
                }
            } else {
                tracing::info!("Codex app-server read loop ended (shutdown)");
            }
            pending_mcp_requests.lock().await.clear();
            shutdown_clone.store(true, Ordering::Relaxed);
        });

        // Send initialize request
        server.initialize().await?;

        Ok(server)
    }

    fn touch(&self) {
        if let Ok(mut guard) = self.last_used.lock() {
            *guard = Instant::now();
        }
    }

    fn idle_for(&self) -> Duration {
        self.last_used
            .lock()
            .map(|g| g.elapsed())
            .unwrap_or(Duration::ZERO)
    }

    /// Send a JSON-RPC request and wait for the response.
    pub async fn send_request(&self, method: &str, params: Value) -> anyhow::Result<Value> {
        self.touch();
        self.send_request_bounded(method, params, Duration::from_secs(REQUEST_TIMEOUT_SECS)).await
    }

    async fn send_request_bounded(&self, method: &str, params: Value, timeout: Duration) -> anyhow::Result<Value> {
        if matches!(method, "thread/start" | "thread/resume" | "thread/fork") {
            crate::teams::policy::refresh_for_execution().await.map_err(anyhow::Error::msg)?;
            // These establish thread metadata, not an inference request. Exact
            // model/effort are checked on the next executing turn below.
            crate::teams::policy::enforce_mode("Codex", "chat").map_err(anyhow::Error::msg)?;
        } else if method == "turn/start" {
            crate::teams::policy::refresh_for_execution().await.map_err(anyhow::Error::msg)?;
            let (model, effort) = execution_configuration(&params);
            crate::teams::policy::enforce("Codex", "chat", model, effort).map_err(anyhow::Error::msg)?;
        } else if matches!(method, "thread/compact/start" | "turn/steer" | "review/start") {
            crate::teams::policy::refresh_for_execution().await.map_err(anyhow::Error::msg)?;
            // These operations inherit configuration and do not accept the
            // explicit per-turn model/effort contract used by turn/start.
            crate::teams::policy::enforce_session("Codex", "chat").map_err(anyhow::Error::msg)?;
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();

        // Register pending response
        {
            let mut pending = self.pending.lock().await;
            pending.insert(id, tx);
        }
        let _registration = PendingRequestGuard { pending: self.pending.clone(), id };

        // Build and send the request
        let request = json!({
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&request)?;
        line.push('\n');

        // Include a busy/full stdin pipe in the bound. Cancellation and every
        // error path drop the registration instead of leaking a response waiter.
        let response = tokio::time::timeout(timeout, async {
            {
                let mut stdin = self.stdin.lock().await;
                stdin.write_all(line.as_bytes()).await?;
                stdin.flush().await?;
            }
            rx.await.map_err(|_| anyhow::anyhow!("Response channel closed for: {}", method))
        }).await.map_err(|_| anyhow::anyhow!("Request timed out: {}", method))??;

        // Check for error response
        if let Some(error) = response.get("error") {
            let msg = error
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("Unknown error");
            return Err(anyhow::anyhow!("RPC error ({}): {}", method, msg));
        }

        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    pub(crate) fn capture_parent_idle(&self, session: &str) -> bool {
        !self.is_shutting_down.load(Ordering::Relaxed)
            && !self.thread_activity.lock().unwrap_or_else(|e| e.into_inner()).is_thread_active(session)
    }

    /// Read only this existing process. Recovery must not keep an idle server
    /// alive, create/resume threads, or consult a replacement process registry.
    pub(crate) async fn capture_terminals_page(&self, session: &str, cursor: Option<String>) -> anyhow::Result<Value> {
        self.send_request_bounded("thread/backgroundTerminals/list",
            json!({"threadId":session,"cursor":cursor,"limit":100}), Duration::from_secs(2)).await
    }

    /// Send a JSON-RPC notification (no response expected).
    pub async fn send_notification(&self, method: &str, params: Value) -> anyhow::Result<()> {
        let notification = json!({
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&notification)?;
        line.push('\n');

        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;

        Ok(())
    }

    /// Initialize the app-server connection.
    async fn initialize(&self) -> anyhow::Result<()> {
        let version = self.app_handle.package_info().version.to_string();

        let result = self
            .send_request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "xanom",
                        "title": "agmux",
                        "version": version
                    },
                    "capabilities": {
                        "experimentalApi": true
                    }
                }),
            )
            .await?;

        tracing::info!(
            "Codex app-server initialized: {:?}",
            result.get("serverInfo")
        );

        // Send initialized notification
        self.send_notification("initialized", json!({})).await?;

        Ok(())
    }

    // ── Thread operations ───────────────────────────────

    /// List all threads.
    pub async fn list_threads(
        &self,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> anyhow::Result<Value> {
        let mut params = json!({
            "sourceKinds": ["cli", "vscode", "appServer", "unknown"],
            "sortKey": "updated_at",
        });
        if let Some(cursor) = cursor {
            params["cursor"] = json!(cursor);
        }
        if let Some(limit) = limit {
            params["limit"] = json!(limit);
        }

        self.send_request("thread/list", params).await
    }

    /// Read the effective Codex config for this workspace.
    pub async fn read_config(&self) -> anyhow::Result<Value> {
        self.send_request(
            "config/read",
            json!({
                "includeLayers": true,
                "cwd": self.work_dir
            }),
        )
        .await
    }

    /// Start a new thread.
    pub async fn start_thread(
        &self,
        model: Option<&str>,
        cwd: Option<&str>,
        base_instructions: Option<&str>,
    ) -> anyhow::Result<Value> {
        let mut params = json!({});
        if let Some(model) = model {
            params["model"] = json!(model);
        }
        if let Some(cwd) = cwd {
            params["cwd"] = json!(cwd);
        }
        if let Some(instr) = base_instructions.filter(|s| !s.is_empty()) {
            // Work replaces the coding prompt; keep Codex CLI MCP/plugin names
            // in the prompt so the session matches `codex` / ChatGPT.app.
            params["baseInstructions"] = json!(crate::codex::cli_config::with_cli_mcp_note(instr));
        }

        self.send_request("thread/start", params).await
    }

    /// Resume an existing thread.
    pub async fn resume_thread(&self, thread_id: &str) -> anyhow::Result<Value> {
        self.send_request("thread/resume", json!({ "threadId": thread_id }))
            .await
    }

    /// Drop this client's event subscription on a loaded thread.
    ///
    /// **Not sufficient for PTY handoff on Codex ≥0.147.** Unsubscribe leaves
    /// the thread in `thread/loaded/list` with a cross-process exclusive
    /// writer. Use [`Self::release_thread_writer_for_pty`] before
    /// `codex resume` in a PTY.
    pub async fn unsubscribe_thread(&self, thread_id: &str) -> anyhow::Result<Value> {
        self.send_request("thread/unsubscribe", json!({ "threadId": thread_id }))
            .await
    }

    /// Thread ids currently loaded (and writer-owned) by this app-server.
    pub async fn list_loaded_thread_ids(&self) -> anyhow::Result<Vec<String>> {
        let mut ids = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen = HashSet::new();
        for _ in 0..512 {
            let result = self.send_request("thread/loaded/list", json!({"cursor": cursor})).await?;
            let data = result.get("data").and_then(Value::as_array)
                .ok_or_else(|| anyhow::anyhow!("Codex loaded thread list is incomplete"))?;
            for value in data {
                let id = value.as_str().or_else(|| value.get("id").and_then(Value::as_str))
                    .ok_or_else(|| anyhow::anyhow!("Invalid loaded thread identity"))?;
                ids.push(id.to_string());
            }
            cursor = result.get("nextCursor").and_then(Value::as_str).map(str::to_string);
            let Some(next) = &cursor else { return Ok(ids); };
            if !seen.insert(next.clone()) { anyhow::bail!("Codex loaded thread cursor repeated"); }
        }
        anyhow::bail!("Codex loaded thread list exceeded page bound")
    }

    /// Release this process's exclusive writer so a PTY `codex resume` can load
    /// the same thread.
    ///
    /// New terminal sessions are minted with app-server `thread/start`, which
    /// loads the thread here. The PTY then runs its own app-server and
    /// `thread/resume`; if this process still holds the writer, the TUI fails
    /// with "thread … already has an active writer" (code -32600).
    ///
    /// On Codex 0.147, `thread/unsubscribe` alone does **not** unload — the id
    /// stays in `thread/loaded/list`. Archiving unloads (moves the rollout to
    /// `archived_sessions/` and drops the writer); unarchiving restores the
    /// file under `sessions/` without reloading it into this process.
    pub async fn release_thread_writer_for_pty(&self, thread_id: &str) {
        let unsub_status = match self.unsubscribe_thread(thread_id).await {
            Ok(status) => {
                tracing::info!(
                    "codex unsubscribe before PTY resume {thread_id}: {status:?}"
                );
                status
                    .get("status")
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string())
            }
            Err(e) => {
                tracing::debug!("codex unsubscribe before PTY resume {thread_id}: {e}");
                None
            }
        };

        let still_loaded = match self.list_loaded_thread_ids().await {
            Ok(ids) => ids.iter().any(|id| id == thread_id),
            Err(e) => {
                // If we cannot list, force-unload only when unsubscribe confirmed
                // the thread was subscribed (writer almost certainly still held).
                tracing::debug!("codex loaded/list before PTY {thread_id}: {e}");
                unsub_status.as_deref() == Some("unsubscribed")
            }
        };
        if !still_loaded {
            return;
        }

        match self.archive_thread(thread_id).await {
            Ok(_) => {
                tracing::info!(
                    "codex archive before PTY resume {thread_id} (unload writer)"
                );
            }
            Err(e) => {
                tracing::warn!("codex archive before PTY resume {thread_id}: {e}");
                return;
            }
        }
        match self.unarchive_thread(thread_id).await {
            Ok(_) => {
                tracing::info!(
                    "codex unarchive before PTY resume {thread_id} (restore rollout)"
                );
            }
            Err(e) => {
                // Rollout may sit under archived_sessions until the user
                // unarchives; surface loudly so we notice in logs.
                tracing::warn!("codex unarchive before PTY resume {thread_id}: {e}");
            }
        }
    }

    /// Fork an existing thread (branch the conversation).
    pub async fn fork_thread(&self, thread_id: &str) -> anyhow::Result<Value> {
        self.send_request("thread/fork", json!({ "threadId": thread_id }))
            .await
    }

    /// Archive a thread via app-server.
    pub async fn archive_thread(&self, thread_id: &str) -> anyhow::Result<Value> {
        self.send_request("thread/archive", json!({ "threadId": thread_id }))
            .await
    }

    /// Unarchive a thread via app-server (restores rollout; does not load it).
    pub async fn unarchive_thread(&self, thread_id: &str) -> anyhow::Result<Value> {
        self.send_request("thread/unarchive", json!({ "threadId": thread_id }))
            .await
    }

    /// Compact a thread's history to save context.
    pub async fn compact_thread(&self, thread_id: &str) -> anyhow::Result<Value> {
        self.send_request(METHOD_THREAD_COMPACT_START, json!({ "threadId": thread_id }))
            .await
    }

    /// Set a thread's display name via app-server.
    pub async fn set_thread_name(&self, thread_id: &str, name: &str) -> anyhow::Result<Value> {
        self.send_request(
            METHOD_THREAD_NAME_SET,
            json!({ "threadId": thread_id, "name": name }),
        )
        .await
    }

    // ── Turn operations ─────────────────────────────────

    /// Send a user message to a thread (starts a new turn).
    ///
    /// Uses Codex app-server protocol params directly, including `serviceTier`
    /// for the Fast tier.
    pub async fn send_message(
        &self,
        thread_id: &str,
        text: &str,
        model: Option<&str>,
        effort: Option<&str>,
        cwd: Option<&str>,
        access_mode: Option<&str>,
        images: &[ImageAttachment],
        collaboration_mode: Option<Value>,
        service_tier: Option<&str>,
        additional_context: Option<&str>,
    ) -> anyhow::Result<Value> {
        let params = build_turn_start_params(
            thread_id,
            text,
            model,
            effort,
            cwd.unwrap_or(&self.work_dir),
            access_mode,
            images,
            collaboration_mode,
            service_tier,
            additional_context,
        );
        if let Some(model) = execution_configuration(&params).0 {
            crate::provider_accounts::remember_model("codex", thread_id, Some(model))
                .await.map_err(anyhow::Error::msg)?;
        }

        // Desktop chat resumes once on mount. Stop + idle reaper (120s) — or
        // interrupt unload — leaves the UI connected while this process no
        // longer has the thread. `turn/start` then fails with "thread not found".
        let loaded = self.list_loaded_thread_ids().await.ok();
        if turn_start_load_action(loaded.as_deref(), thread_id)
            == TurnStartLoadAction::ResumeThenStart
        {
            if let Err(e) = self.resume_thread(thread_id).await {
                tracing::debug!("codex resume before turn/start {thread_id}: {e}");
            }
        }

        match self.send_request("turn/start", params.clone()).await {
            Ok(value) => Ok(value),
            Err(error) if is_unloaded_thread_error(&error.to_string()) => {
                tracing::info!(
                    "codex turn/start thread not loaded; resuming {thread_id} and retrying"
                );
                self.resume_thread(thread_id).await?;
                self.send_request("turn/start", params).await
            }
            Err(error) => Err(error),
        }
    }

    pub fn memory_mcp_configured(&self) -> bool {
        self.memory_mcp_configured
    }

    fn has_active_turns(&self) -> bool {
        self.thread_activity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .has_active()
    }

    /// Steer a running turn mid-execution (proper JSON-RPC method).
    pub async fn steer_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
        text: &str,
        images: &[ImageAttachment],
    ) -> anyhow::Result<Value> {
        let mut input = vec![json!({"type": "text", "text": text})];
        for img in images {
            input.push(image_attachment_to_input(img));
        }

        self.send_request(
            "turn/steer",
            json!({
                "threadId": thread_id,
                "expectedTurnId": turn_id,
                "input": input
            }),
        )
        .await
    }

    /// Interrupt the current turn.
    pub async fn interrupt_turn(&self, thread_id: &str, turn_id: &str) -> anyhow::Result<Value> {
        self.send_request(
            "turn/interrupt",
            json!({ "threadId": thread_id, "turnId": turn_id }),
        )
        .await
    }

    // ── Other operations ────────────────────────────────

    /// List available models.
    pub async fn list_models(&self) -> anyhow::Result<Value> {
        self.send_request("model/list", json!({})).await
    }

    /// List available collaboration modes (e.g., "default", "plan").
    pub async fn list_collaboration_modes(&self) -> anyhow::Result<Value> {
        self.send_request("collaborationMode/list", json!({})).await
    }

    /// Read a specific thread's current state.
    pub async fn read_thread(&self, thread_id: &str) -> anyhow::Result<Value> {
        self.send_request("thread/read", json!({ "threadId": thread_id }))
            .await
    }

    /// Respond to a server request (e.g., command approval).
    pub async fn respond_to_request(&self, request_id: u64, result: Value) -> anyhow::Result<()> {
        let mut pending_mcp = self.pending_mcp_requests.lock().await;
        let native = self.request_ids.lock().unwrap_or_else(|e| e.into_inner()).native(request_id)
            .ok_or_else(|| anyhow::anyhow!("Approval is no longer pending on this server"))?;
        let response = json!({
            "id": native,
            "result": result,
        });
        let mut line = serde_json::to_string(&response)?;
        line.push('\n');

        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;

        pending_mcp.remove(&request_id);
        self.request_ids.lock().unwrap_or_else(|e| e.into_inner()).remove(request_id);
        self.request_threads.lock().unwrap_or_else(|e| e.into_inner()).remove(&request_id);

        Ok(())
    }

    /// Codex thread that raised a still-pending public request id.
    pub fn request_thread(&self, request_id: u64) -> Option<String> {
        self.request_threads.lock().unwrap_or_else(|e| e.into_inner()).get(&request_id).cloned()
    }

    /// Replace the in-memory allowlist patterns for this server. Called by
    /// `CodexServerManager` after loading rules from SQLite.
    pub async fn set_approval_rules(&self, patterns: Vec<String>) {
        let mut rules = self.approval_rules.lock().await;
        rules.clear();
        rules.extend(patterns);
    }

    /// Add a single pattern to the in-memory allowlist. Idempotent.
    pub async fn add_approval_rule(&self, pattern: String) {
        self.approval_rules.lock().await.insert(pattern);
    }

    /// Remove a pattern from the in-memory allowlist.
    pub async fn remove_approval_rule(&self, pattern: &str) {
        self.approval_rules.lock().await.remove(pattern);
    }

    /// Query account rate limit status.
    pub async fn account_rate_limits(&self) -> anyhow::Result<Value> {
        self.send_request(METHOD_ACCOUNT_RATE_LIMITS_READ, json!({}))
            .await
    }

    /// Read account info (email, plan, auth status).
    pub async fn account_read(&self) -> anyhow::Result<Value> {
        self.send_request("account/read", json!({})).await
    }

    /// Initiate Codex OAuth login flow.
    pub async fn login(&self) -> anyhow::Result<Value> {
        self.send_request("account/login/start", json!({ "type": "chatgpt" })).await
    }

    /// Cancel an in-flight login.
    pub async fn login_cancel(&self, login_id: &str) -> anyhow::Result<Value> {
        let params = json!({
            "loginId": login_id,
        });
        self.send_request("account/login/cancel", params).await
    }

    /// List MCP server connection statuses.
    pub async fn list_mcp_server_status(&self) -> anyhow::Result<Value> {
        self.send_request("mcpServerStatus/list", json!({})).await
    }

    /// Shut down the app-server.
    pub async fn shutdown(&self) {
        self.is_shutting_down.store(true, Ordering::Relaxed);

        // Try graceful shutdown
        let _ = self.send_notification("shutdown", json!({})).await;

        // Kill the child process
        let mut child = self._child.lock().await;
        let _ = child.kill().await;
    }
}

// ── Multi-workspace server manager ──────────────────────

fn should_restart_for_memory_config(
    configured: bool,
    project_resolved: bool,
    memory_enabled: bool,
    has_active_turns: bool,
) -> bool {
    matches!(
        memory_config_reconfiguration(
            configured,
            project_resolved,
            memory_enabled,
            has_active_turns,
        ),
        Ok(true)
    )
}

fn memory_config_reconfiguration(
    configured: bool,
    project_resolved: bool,
    memory_enabled: bool,
    has_active_turns: bool,
) -> Result<bool, &'static str> {
    let mismatched = configured != (memory_enabled && project_resolved);
    if mismatched && has_active_turns {
        return Err(
            "Project memory changed while a Codex turn is active; retry after the current Codex turn finishes",
        );
    }
    Ok(mismatched)
}

// Box the future to keep spawning a replacement independent of the stdout
// loop's own spawn future. The old process continues serving unrelated threads.
fn prepare_after_quota(app: tauri::AppHandle, work_dir: String, thread_id: String)
    -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
{
    Box::pin(async move {
        if !crate::provider_accounts::auto_switch_enabled().await.unwrap_or(false) { return; }
        let state = app.state::<crate::state::AppState>();
        let project = crate::commands::memory::find_project_for_path(state.inner(), &work_dir).await;
        let (project_id, repo_path) = match &project {
            Some(p) => (Some(p.project_id.as_str()), Some(p.repo_path.as_str())),
            None => (None, None),
        };
        let prepared = state.codex_servers.lock().await
            .get_or_spawn_for_turn(&app, &work_dir, project_id, repo_path, &thread_id).await;
        let status = match prepared {
            Ok(reservation) => {
                match reservation.server().resume_thread(&thread_id).await {
                    Ok(_) => "ready",
                    Err(_) => "resume_failed",
                }
            }
            Err(_) => "unavailable",
        };
        let _ = app.emit("provider-account-runtime", json!({
            "provider": "codex", "sessionKey": thread_id, "status": status,
        }));
    })
}

fn codex_quota_exhaustion(response: &Value) -> Option<Option<i64>> {
    let limits = response.get("rateLimits")?;
    if limits.pointer("/credits/hasCredits").and_then(Value::as_bool) == Some(true)
        || limits.pointer("/credits/unlimited").and_then(Value::as_bool) == Some(true) { return None; }
    let now = chrono::Utc::now().timestamp();
    let windows: Vec<_> = ["primary", "secondary"].iter().filter_map(|name| {
        let window = limits.get(*name)?;
        crate::provider_accounts::runtime::exhausted_window(
            window.get("usedPercent").and_then(Value::as_f64),
            window.get("resetsAt").and_then(Value::as_i64), now)
    }).collect();
    if windows.is_empty() { None }
    else if windows.iter().any(Option::is_none) { Some(None) }
    else { Some(windows.into_iter().flatten().max()) }
}

/// Manages Codex servers per workspace/account and routes exact thread identities.
pub struct CodexServerManager {
    servers: HashMap<String, Arc<CodexAppServer>>,
    thread_servers: HashMap<String, String>,
    monitored_threads: HashMap<String, String>,
}

impl CodexServerManager {
    pub fn new() -> Self {
        Self {
            servers: HashMap::new(),
            thread_servers: HashMap::new(),
            monitored_threads: HashMap::new(),
        }
    }

    /// Get or spawn a server for the given workspace path.
    pub async fn get_or_spawn(
        &mut self,
        app_handle: &tauri::AppHandle,
        work_dir: &str,
        project_id: Option<&str>,
        repo_path: Option<&str>,
    ) -> Result<Arc<CodexAppServer>, String> {
        self.get_or_spawn_account(app_handle, work_dir, project_id, repo_path, None).await
    }

    async fn get_or_spawn_account(
        &mut self,
        app_handle: &tauri::AppHandle,
        work_dir: &str,
        project_id: Option<&str>,
        repo_path: Option<&str>,
        account: Option<&crate::provider_accounts::AccountAssignment>,
    ) -> Result<Arc<CodexAppServer>, String> {
        let key = crate::provider_accounts::runtime::server_key(work_dir, account.map(|a| a.account_id.as_str()));
        let project_resolved = project_id.is_some() && repo_path.is_some();
        let should_restart = match self.servers.get(&key) {
            Some(server) if server.is_shutting_down.load(Ordering::Relaxed) => true,
            Some(server) => memory_config_reconfiguration(
                server.memory_mcp_configured,
                project_resolved,
                crate::memory::is_enabled(),
                server.has_active_turns(),
            )
            .map_err(str::to_string)?,
            None => false,
        };
        if should_restart {
            if let Some(server) = self.servers.remove(&key) {
                server.shutdown().await;
            }
        }
        if !self.servers.contains_key(&key) {
            let server =
                CodexAppServer::spawn_with_account(app_handle.clone(), work_dir, project_id, repo_path, account)
                    .await
                    .map_err(|e| e.to_string())?;
            self.servers.insert(key.clone(), Arc::new(server));
        }
        let server = Arc::clone(self.servers.get(&key).unwrap());
        server.touch();
        Ok(server)
    }

    pub async fn get_or_spawn_for_thread(
        &mut self,
        app_handle: &tauri::AppHandle,
        work_dir: &str,
        project_id: Option<&str>,
        repo_path: Option<&str>,
        thread_id: &str,
    ) -> Result<Arc<CodexAppServer>, String> {
        // Never acquire a different account while the exact thread is loaded.
        if let Some(server) = self.get_for_thread(work_dir, thread_id) {
            let account = crate::provider_accounts::current_assignment(thread_id).await;
            if server.account_id.is_some() && account.as_ref().map(|a| &a.account_id) != server.account_id.as_ref() {
                return Err("Codex account assignment changed while the session is loaded".into());
            }
            // Preserve existing memory-toggle reconfiguration, including the
            // active-turn guard, without changing this thread's account.
            let server = self.get_or_spawn_account(app_handle, work_dir, project_id, repo_path, account.as_ref()).await?;
            self.bind_thread(thread_id, &server);
            return Ok(server);
        }
        let account = crate::provider_accounts::acquire("codex", thread_id).await?;
        let server = self.get_or_spawn_account(app_handle, work_dir, project_id, repo_path, account.as_ref()).await?;
        self.bind_thread(thread_id, &server);
        Ok(server)
    }

    pub fn bind_thread(&mut self, thread_id: &str, server: &Arc<CodexAppServer>) {
        self.thread_servers.insert(thread_id.to_string(), crate::provider_accounts::runtime::server_key(
            &server.work_dir, server.account_id.as_deref()));
        // Provisional creation keys are transferred immediately after thread/start.
        if thread_id.starts_with("codex-new:") || server.account_id.is_none()
            || self.monitored_threads.get(thread_id) == Some(&server.capture_instance) { return; }
        self.monitored_threads.insert(thread_id.to_string(), server.capture_instance.clone());
        let weak = Arc::downgrade(server);
        let key = thread_id.to_string();
        let account_id = server.account_id.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let Some(server) = weak.upgrade() else { break; };
                if server.is_shutting_down.load(Ordering::Relaxed) { break; }
                let Some(current) = crate::provider_accounts::current_assignment(&key).await else { break; };
                if Some(&current.account_id) != account_id.as_ref() { break; }
                if crate::provider_accounts::maintain(&key).await.is_err() {
                    // maintain reports only definitive revocation / expired leases.
                    let app = server.app_handle.clone();
                    let state = app.state::<crate::state::AppState>();
                    state.codex_servers.lock().await.stop_instance(&server.capture_instance).await;
                    break;
                }
            }
        });
    }

    pub fn get_for_thread(&self, work_dir: &str, thread_id: &str) -> Option<Arc<CodexAppServer>> {
        let key = self.thread_servers.get(thread_id)?;
        self.servers.get(key).filter(|s| s.work_dir == work_dir
            && !s.is_shutting_down.load(Ordering::Relaxed)).cloned()
    }

    pub fn get_for_request(&self, work_dir: &str, request_id: u64) -> Option<Arc<CodexAppServer>> {
        self.servers.values().find(|s| s.work_dir == work_dir && s.request_ids.lock()
            .unwrap_or_else(|e| e.into_inner()).native(request_id).is_some()).cloned()
    }

    pub fn workspace_servers(&self, work_dir: &str) -> Vec<Arc<CodexAppServer>> {
        self.servers.values().filter(|s| s.work_dir == work_dir).cloned().collect()
    }

    /// Validate the current memory configuration and reserve this thread as
    /// active before the caller releases the manager lock.
    pub async fn get_or_spawn_for_turn(
        &mut self,
        app_handle: &tauri::AppHandle,
        work_dir: &str,
        project_id: Option<&str>,
        repo_path: Option<&str>,
        thread_id: &str,
    ) -> Result<CodexTurnReservation, String> {
        let mut attempted = HashSet::new();
        for _ in 0..3 {
            let server = self.get_or_spawn_for_thread(app_handle, work_dir, project_id, repo_path, thread_id).await?;
            if !attempted.is_empty() && server.account_id.is_none() {
                return Err("No managed Codex replacement account is available".into());
            }
            if server.thread_activity.lock().unwrap_or_else(|e| e.into_inner()).is_thread_active(thread_id) {
                return Err("Codex thread already has an active turn".into());
            }
            if let Some(account_id) = &server.account_id {
                if !attempted.insert(account_id.clone()) {
                    return Err("No different Codex account is available".into());
                }
                crate::provider_accounts::maintain(thread_id).await?;
                let observed = match server.account_rate_limits().await {
                    Ok(limits) => codex_quota_exhaustion(&limits),
                    Err(_) => None,
                };
                let exhausted = observed.or(crate::provider_accounts::quota_exhaustion(account_id).await?);
                if let Some(reset) = exhausted {
                        if !crate::provider_accounts::auto_switch_enabled().await? {
                            return Err("Codex account quota exhausted; automatic switching is disabled".into());
                        }
                        // Never stop the account server: unrelated threads may be
                        // active. Release and verify just this native writer.
                        server.release_thread_writer_for_pty(thread_id).await;
                        let loaded = server.list_loaded_thread_ids().await.map_err(|e| e.to_string())?;
                        if loaded.iter().any(|id| id == thread_id) {
                            return Err("Codex quota exhausted; session is still busy and cannot switch accounts".into());
                        }
                        crate::provider_accounts::mark_exhausted("codex", thread_id, reset).await?;
                        crate::provider_accounts::release(thread_id).await?;
                        self.thread_servers.remove(thread_id);
                        continue;
                }
            }
            let active_turn = ActiveTurnReservation::new(server.thread_activity.clone(), thread_id)?;
            return Ok(CodexTurnReservation { server, active_turn });
        }
        Err("Codex account fallback attempt limit reached".into())
    }

    async fn release_server_bindings(&mut self, key: &str) {
        let threads: Vec<_> = self.thread_servers.iter().filter(|(_, route)| route.as_str() == key)
            .map(|(thread, _)| thread.clone()).collect();
        for thread in threads {
            self.thread_servers.remove(&thread);
            self.monitored_threads.remove(&thread);
            if let Err(error) = crate::provider_accounts::release(&thread).await {
                tracing::warn!(%error, "Could not release stopped Codex account assignment");
            }
        }
    }

    pub fn forget_thread_route(&mut self, thread_id: &str) {
        self.thread_servers.remove(thread_id);
        self.monitored_threads.remove(thread_id);
    }

    pub fn all_servers(&self) -> Vec<Arc<CodexAppServer>> {
        self.servers.values().cloned().collect()
    }

    /// Retire idle app-servers whose spawn-time memory configuration no longer
    /// matches the toggle. Active turns finish on their existing process; the
    /// next access restarts that workspace through `get_or_spawn`.
    pub async fn retire_idle_memory_mismatches(&mut self, memory_enabled: bool) {
        let work_dirs: Vec<String> = self
            .servers
            .iter()
            .filter_map(|(work_dir, server)| {
                should_restart_for_memory_config(
                    server.memory_mcp_configured,
                    server.memory_project_resolved,
                    memory_enabled,
                    server.has_active_turns(),
                )
                .then(|| work_dir.clone())
            })
            .collect();
        for work_dir in work_dirs {
            if let Some(server) = self.servers.remove(&work_dir) {
                server.shutdown().await;
                self.release_server_bindings(&work_dir).await;
            }
        }
    }

    /// Shut down app-servers that have had no RPC activity for `max_idle` and
    /// are not mid-turn. Used by the background reaper so Home discovery does
    /// not leave one process per project for the whole app lifetime.
    pub async fn retire_idle_servers(&mut self, max_idle: Duration) {
        let work_dirs: Vec<String> = self
            .servers
            .iter()
            .filter_map(|(work_dir, server)| {
                if server.has_active_turns() {
                    return None;
                }
                if server.idle_for() < max_idle {
                    return None;
                }
                Some(work_dir.clone())
            })
            .collect();
        for work_dir in work_dirs {
            if let Some(server) = self.servers.remove(&work_dir) {
                // Re-check under the same logical decision: a turn may have
                // started between the filter snapshot and remove.
                if server.has_active_turns() {
                    self.servers.insert(work_dir, server);
                    continue;
                }
                tracing::info!(
                    target: "xanom::codex",
                    %work_dir,
                    idle_secs = server.idle_for().as_secs(),
                    "retiring idle Codex app-server"
                );
                server.shutdown().await;
                self.release_server_bindings(&work_dir).await;
            }
        }
    }

    /// Get an existing server for any workspace (used when caller doesn't know the workspace).
    /// Returns the first available server, or None.
    pub fn get_any(&self) -> Option<Arc<CodexAppServer>> {
        self.servers.values().next().map(Arc::clone)
    }

    /// Get an existing server for a specific workspace path.
    pub fn get(&self, work_dir: &str) -> Option<Arc<CodexAppServer>> {
        self.servers.get(work_dir).map(Arc::clone)
    }

    pub(crate) fn capture_server(&self, instance: &str, cwd: &str) -> Option<Arc<CodexAppServer>> {
        self.servers.values().find(|server| server.capture_instance == instance && server.capture_cwd == cwd
            && !server.is_shutting_down.load(Ordering::Relaxed)).map(Arc::clone)
    }

    /// Workspaces currently driven by an app-server. Threads in these dirs are
    /// app-server CHATS regardless of their stored `interaction_mode`.
    pub fn work_dirs(&self) -> Vec<String> {
        self.servers.values().map(|s| s.work_dir.clone()).collect::<HashSet<_>>().into_iter().collect()
    }

    async fn stop_instance(&mut self, instance: &str) {
        let keys: Vec<_> = self.servers.iter().filter(|(_, server)| server.capture_instance == instance)
            .map(|(key, _)| key.clone()).collect();
        for key in keys {
            if let Some(server) = self.servers.remove(&key) {
                server.shutdown().await;
                self.release_server_bindings(&key).await;
            }
        }
    }

    /// Stop and remove a specific workspace server.
    pub async fn stop(&mut self, work_dir: &str) {
        let keys: Vec<_> = self.servers.iter().filter(|(_, s)| s.work_dir == work_dir).map(|(k, _)| k.clone()).collect();
        for key in keys {
            if let Some(server) = self.servers.remove(&key) {
                server.shutdown().await;
                self.release_server_bindings(&key).await;
            }
        }
    }

    /// Stop all servers.
    pub async fn stop_all(&mut self) {
        let servers: Vec<(String, Arc<CodexAppServer>)> = self.servers.drain().collect();
        for (key, server) in servers {
            server.shutdown().await;
            self.release_server_bindings(&key).await;
        }
    }

    /// Check if a server exists for the given workspace.
    #[allow(dead_code)]
    pub fn has(&self, work_dir: &str) -> bool {
        self.servers.contains_key(work_dir)
    }

    /// List workspace paths with active servers.
    #[allow(dead_code)]
    pub fn workspaces(&self) -> Vec<String> {
        self.servers.values().map(|s| s.work_dir.clone()).collect::<HashSet<_>>().into_iter().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_auto_approval_uses_the_command_approval_decision_schema() {
        // Codex 0.157 CommandExecutionRequestApprovalResponse requires
        // `decision` ("accept" | "acceptForSession" | …); `approved` is unknown.
        assert_eq!(
            allowlist_approval_response(7),
            json!({ "id": 7, "result": { "decision": "accept" } }),
        );
    }

    #[test]
    fn capture_instance_marker_is_private_immutable_and_never_linked() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(directory.path()).unwrap();
        let instances = root.join("instances");
        let instance = uuid::Uuid::new_v4().to_string();
        register_capture_instance(&instances, &instance, 12345).unwrap();
        let path = instances.join(format!("{instance}.json"));
        let value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(value, json!({"serverInstance":instance,"pid":12345}));
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(register_capture_instance(&instances, &instance, 54321).is_err());
        assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap(), value);
        symlink(&instances, root.join("linked")).unwrap();
        assert!(register_capture_instance(&root.join("linked"), &uuid::Uuid::new_v4().to_string(), 12345).is_err());
        let other = uuid::Uuid::new_v4().to_string();
        symlink(&path, instances.join(format!("{other}.json"))).unwrap();
        assert!(register_capture_instance(&instances, &other, 12345).is_err());
    }

    #[tokio::test]
    async fn cancelled_capture_request_removes_waiter_even_when_contended() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        for contended in [false, true] {
            let (sender, receiver) = oneshot::channel();
            pending.lock().await.insert(1, sender);
            let registration = PendingRequestGuard { pending: pending.clone(), id: 1 };
            let lock = if contended { Some(pending.lock().await) } else { None };
            drop(registration); // Same guard runs on timeout, cancellation and write errors.
            drop(lock);
            assert!(tokio::time::timeout(Duration::from_secs(1), receiver).await.unwrap().is_err());
            assert!(pending.lock().await.is_empty());
        }
    }

    #[tokio::test]
    async fn codex_stderr_flood_does_not_block_protocol_output() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "dd if=/dev/zero bs=65536 count=32 >&2 2>/dev/null\nprintf 'ready\\n'"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn().unwrap();
        drain_codex_stderr(&mut child);
        let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
        let line = tokio::time::timeout(Duration::from_secs(3), stdout.next_line())
            .await.expect("stderr must not block stdout").unwrap();
        assert_eq!(line.as_deref(), Some("ready"));
        child.wait().await.unwrap();
    }

    #[test]
    fn mcp_consent_survives_missed_delivery_until_resolution() {
        let mut pending = HashMap::new();
        let request = json!({"method":"mcpServer/elicitation/request","requestId":0,
            "params":{"threadId":"parent","turnId":"turn","serverName":"cua_repl",
                "message":"Allow Computer Use to use agmux?"}});
        update_pending_mcp_requests(&mut pending, &request);
        update_pending_mcp_requests(&mut pending, &request);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending.get(&0), Some(&request));
        update_pending_mcp_requests(&mut pending, &json!({"method":"turn/completed",
            "params":{"threadId":"child","turn":{"id":"child-turn"}}}));
        assert_eq!(pending.len(), 1);
        update_pending_mcp_requests(&mut pending, &json!({"method":"serverRequest/resolved",
            "params":{"threadId":"parent","requestId":0}}));
        assert!(pending.is_empty());
        update_pending_mcp_requests(&mut pending, &request);
        update_pending_mcp_requests(&mut pending, &json!({"method":"turn/aborted",
            "params":{"threadId":"parent","turnId":"turn"}}));
        assert!(pending.is_empty());
    }

    #[test]
    fn turn_registry_tracks_open_turns() {
        // Remote control has no other way to know a Codex session is working:
        // Codex fires no hooks and writes no turn rows.
        let tid = "turn-registry-test-thread";
        assert!(!codex_active_turn_thread_ids().contains(tid));
        codex_turn_started(tid);
        assert!(codex_active_turn_thread_ids().contains(tid));
        codex_turn_ended(tid);
        assert!(!codex_active_turn_thread_ids().contains(tid));

        // A dead read loop takes its own turns with it.
        codex_turn_started(tid);
        codex_turns_clear(&HashSet::from([tid.to_string()]));
        assert!(!codex_active_turn_thread_ids().contains(tid));
    }

    #[test]
    fn turn_registry_expires_stale_entries() {
        // Backstop for a `turn/completed` that never arrives — otherwise a
        // missed terminal event pins the phone to "Running" forever.
        let tid = "turn-registry-stale-thread";
        {
            let mut guard = CODEX_ACTIVE_TURNS.lock().unwrap_or_else(|e| e.into_inner());
            guard.get_or_insert_with(HashMap::new).insert(
                tid.to_string(),
                std::time::Instant::now()
                    - std::time::Duration::from_secs(CODEX_TURN_MAX_AGE_SECS + 60),
            );
        }
        assert!(!codex_active_turn_thread_ids().contains(tid));
    }

    #[test]
    fn manager_stores_shareable_server_handles() {
        let manager = CodexServerManager::new();
        let servers_type = std::any::type_name_of_val(&manager.servers);

        assert!(
            servers_type.contains("Arc<"),
            "CodexServerManager must store shareable server handles so callers can release the manager lock before awaiting RPCs; got {servers_type}"
        );
    }

    #[test]
    fn idle_server_candidate_skips_active_turns_and_fresh_activity() {
        // Pure policy for the reaper filter: retire only when idle long enough
        // AND no open turn. (Full shutdown needs a real child process.)
        fn should_retire(has_active: bool, idle: Duration, max_idle: Duration) -> bool {
            !has_active && idle >= max_idle
        }
        let ttl = Duration::from_secs(CODEX_SERVER_IDLE_TTL_SECS);
        assert!(!should_retire(true, ttl + Duration::from_secs(1), ttl));
        assert!(!should_retire(false, Duration::from_secs(1), ttl));
        assert!(should_retire(false, ttl, ttl));
        assert!(should_retire(false, ttl + Duration::from_secs(60), ttl));
    }

    #[test]
    fn cached_server_memory_reconfiguration_waits_for_idle() {
        assert!(should_restart_for_memory_config(false, true, true, false));
        assert!(should_restart_for_memory_config(true, true, false, false));
        assert!(!should_restart_for_memory_config(false, true, true, true));
        assert!(!should_restart_for_memory_config(false, false, true, false));
    }

    #[test]
    fn mismatched_active_server_rejects_new_turn_then_restarts_after_terminal_status() {
        let mut registry = ThreadActivityRegistry::default();
        registry.reserve("thread-1").unwrap();
        registry.mark_started("thread-1", "turn-1");
        let active = std::sync::Mutex::new(registry);
        let error = memory_config_reconfiguration(
            false,
            true,
            true,
            active.lock().unwrap().has_active(),
        )
        .unwrap_err();
        assert!(error.contains("retry after the current Codex turn"));

        update_active_turns_from_notification(
            &active,
            &json!({
                "method": "turn/completed",
                "params": {
                    "threadId": "thread-1",
                    "turn": { "id": "turn-1" }
                }
            }),
        );
        assert_eq!(
            memory_config_reconfiguration(
                false,
                true,
                true,
                active.lock().unwrap().has_active(),
            ),
            Ok(true)
        );
    }

    #[test]
    fn turn_reservation_serializes_toggle_and_releases_failed_start() {
        let active = Arc::new(std::sync::Mutex::new(ThreadActivityRegistry::default()));
        let reservation = ActiveTurnReservation::new(active.clone(), "thread-1").unwrap();
        let duplicate_error = match ActiveTurnReservation::new(active.clone(), "thread-1") {
            Ok(_) => panic!("duplicate same-thread reservation must fail"),
            Err(error) => error,
        };
        assert!(duplicate_error.contains("turn is already active"));
        assert!(active
            .lock()
            .unwrap()
            .is_reserved("thread-1", reservation.generation));

        let has_active_turns = active
            .lock()
            .unwrap()
            .has_active();
        assert!(!should_restart_for_memory_config(
            false,
            true,
            true,
            has_active_turns
        ));
        assert!(memory_config_reconfiguration(false, true, true, has_active_turns).is_err());
        assert_eq!(active.lock().unwrap().entries.len(), 1);

        drop(reservation);
        assert!(!active
            .lock()
            .unwrap()
            .has_active());
        assert_eq!(
            memory_config_reconfiguration(false, true, true, false),
            Ok(true)
        );
    }

    #[test]
    fn collab_child_idle_does_not_clear_parent_turn() {
        // Codex 0.153 collab children announce turn/completed + idle on the
        // parent thread id. That must not look like the parent turn ended,
        // or the idle reaper kills the app-server and live chat goes dark.
        let mut registry = ThreadActivityRegistry::default();
        registry.mark_started("parent", "turn-parent");
        let active = std::sync::Mutex::new(registry);

        update_active_turns_from_notification(
            &active,
            &json!({
                "method": "turn/started",
                "params": { "threadId": "parent", "turnId": "turn-child" }
            }),
        );
        update_active_turns_from_notification(
            &active,
            &json!({
                "method": "turn/completed",
                "params": { "threadId": "parent", "turn": { "id": "turn-child" } }
            }),
        );
        update_active_turns_from_notification(
            &active,
            &json!({
                "method": "thread/status/changed",
                "params": { "threadId": "parent", "status": { "type": "idle" } }
            }),
        );
        assert!(active.lock().unwrap().is_thread_active("parent"));

        update_active_turns_from_notification(
            &active,
            &json!({
                "method": "turn/completed",
                "params": { "threadId": "parent", "turnId": "turn-parent" }
            }),
        );
        assert!(!active.lock().unwrap().is_thread_active("parent"));
    }

    #[test]
    fn terminal_thread_status_clears_active_turn_without_completed_event() {
        let mut registry = ThreadActivityRegistry::default();
        registry.reserve("thread-1").unwrap();
        registry.mark_started("thread-1", "turn-1");
        registry.reserve("thread-2").unwrap();
        registry.mark_started("thread-2", "turn-2");
        let active = std::sync::Mutex::new(registry);

        update_active_turns_from_notification(
            &active,
            &json!({
                "method": "turn/completed",
                "params": {
                    "threadId": "thread-1",
                    "turn": { "id": "turn-old" }
                }
            }),
        );
        assert!(active.lock().unwrap().entries.contains_key("thread-1"));

        update_active_turns_from_notification(
            &active,
            &json!({
                "method": "thread/status/changed",
                "params": { "threadId": "thread-1", "status": { "type": "active" } }
            }),
        );
        assert!(active.lock().unwrap().entries.contains_key("thread-1"));

        // Child-style idle on the parent thread must not drop the running turn.
        update_active_turns_from_notification(
            &active,
            &json!({
                "method": "thread/status/changed",
                "params": { "threadId": "thread-1", "status": { "type": "idle" } }
            }),
        );
        assert!(active.lock().unwrap().entries.contains_key("thread-1"));

        update_active_turns_from_notification(
            &active,
            &json!({
                "method": "turn/completed",
                "params": {
                    "threadId": "thread-1",
                    "turn": { "id": "turn-1" }
                }
            }),
        );
        assert!(!active.lock().unwrap().entries.contains_key("thread-1"));
        assert!(active.lock().unwrap().entries.contains_key("thread-2"));

        update_active_turns_from_notification(
            &active,
            &json!({
                "method": "thread/status/changed",
                "params": { "threadId": "thread-2", "status": { "type": "systemError" } }
            }),
        );
        assert!(active.lock().unwrap().entries.is_empty());
    }

    #[test]
    fn old_terminal_event_does_not_clear_new_reservation_or_running_turn() {
        let mut activity = ThreadActivityRegistry::default();

        let old_generation = activity.reserve("thread-1").unwrap();
        activity.mark_started("thread-1", "turn-old");
        assert!(activity.mark_terminal("thread-1", "turn-old"));

        let new_generation = activity.reserve("thread-1").unwrap();
        assert_ne!(old_generation, new_generation);
        assert!(!activity.mark_terminal("thread-1", "turn-old"));
        assert!(activity.has_active());

        activity.commit_reservation(
            "thread-1",
            new_generation,
            Some("turn-new"),
        );
        assert!(!activity.mark_terminal("thread-1", "turn-old"));
        assert!(activity.has_active());
        assert!(activity.mark_terminal("thread-1", "turn-new"));
        assert!(!activity.has_active());
    }

    #[test]
    fn late_reservation_finish_or_drop_cannot_remove_new_generation() {
        let activity = Arc::new(std::sync::Mutex::new(ThreadActivityRegistry::default()));

        let old = ActiveTurnReservation::new(activity.clone(), "thread-1").unwrap();
        {
            let mut registry = activity.lock().unwrap();
            registry.mark_started("thread-1", "turn-old");
            assert!(registry.mark_terminal("thread-1", "turn-old"));
        }
        let newer = ActiveTurnReservation::new(activity.clone(), "thread-1").unwrap();
        drop(old);
        assert!(activity
            .lock()
            .unwrap()
            .is_reserved("thread-1", newer.generation));
        drop(newer);

        let mut old = ActiveTurnReservation::new(activity.clone(), "thread-1").unwrap();
        {
            let mut registry = activity.lock().unwrap();
            registry.mark_started("thread-1", "turn-old-2");
            assert!(registry.mark_terminal("thread-1", "turn-old-2"));
        }
        let newer = ActiveTurnReservation::new(activity.clone(), "thread-1").unwrap();
        old.commit(&json!({ "turn": { "id": "turn-old-2" } }));
        drop(old);
        assert!(activity
            .lock()
            .unwrap()
            .is_reserved("thread-1", newer.generation));
    }

    #[test]
    fn long_running_reservations_and_turns_keep_ownership_until_explicit_release() {
        let now = std::time::Instant::now();
        let mut activity = ThreadActivityRegistry::default();
        let much_later = now + std::time::Duration::from_secs(CODEX_TURN_MAX_AGE_SECS + 60);
        assert!(much_later.duration_since(now).as_secs() > CODEX_TURN_MAX_AGE_SECS);

        let generation = activity.reserve("thread-1").unwrap();
        activity.mark_thread_status_terminal("thread-1");
        assert!(activity.is_reserved("thread-1", generation));
        assert!(activity.has_active());
        assert!(activity.reserve("thread-1").is_err());
        assert!(memory_config_reconfiguration(false, true, true, true).is_err());

        activity.release_reservation("thread-1", generation);
        let running_generation = activity.reserve("thread-1").unwrap();
        activity.mark_started("thread-1", "turn-1");
        assert!(activity.has_active());
        assert!(activity.reserve("thread-1").is_err());
        assert!(memory_config_reconfiguration(false, true, true, true).is_err());

        assert_ne!(generation, running_generation);
        activity.mark_thread_status_terminal("thread-1");
        assert!(!activity.has_active());
    }

    #[test]
    fn unloaded_thread_error_matches_turn_start_not_found() {
        assert!(is_unloaded_thread_error(
            "RPC error (turn/start): thread not found: 01a074c6-5dc9-78e3-928b-0e7969934d4c"
        ));
        assert!(is_unloaded_thread_error(
            "RPC error (turn/start): thread not loaded: 01a074c6-5dc9-78e3-928b-0e7969934d4c"
        ));
        assert!(!is_unloaded_thread_error(
            "RPC error (turn/start): You've hit your usage limit."
        ));
        assert!(!is_unloaded_thread_error(
            "RPC error (thread/resume): cannot resume running thread"
        ));
    }

    #[test]
    fn turn_start_resumes_when_app_server_does_not_have_the_thread_loaded() {
        // Desktop chat resumes once on mount. Stop + idle reaper (or interrupt
        // unload) leaves the UI connected while this process no longer has the
        // thread — turn/start then fails with "thread not found".
        let tid = "01a074c6-5dc9-78e3-928b-0e7969934d4c";
        assert_eq!(
            turn_start_load_action(Some(&["other-thread".to_string()]), tid),
            TurnStartLoadAction::ResumeThenStart
        );
        assert_eq!(
            turn_start_load_action(Some(&[]), tid),
            TurnStartLoadAction::ResumeThenStart
        );
        assert_eq!(
            turn_start_load_action(None, tid),
            TurnStartLoadAction::ResumeThenStart
        );
        assert_eq!(
            turn_start_load_action(Some(&[tid.to_string()]), tid),
            TurnStartLoadAction::Start
        );
    }

    #[test]
    fn turn_start_params_use_priority_service_tier_for_fast_mode() {
        let params = build_turn_start_params(
            "thread-1",
            "hello",
            Some("gpt-5.5"),
            Some("high"),
            "/repo",
            None,
            &[],
            None,
            Some("priority"),
            None,
        );

        assert_eq!(params["serviceTier"], json!("priority"));
        assert!(params.get("fastMode").is_none());
    }

    #[test]
    fn turn_start_params_keep_request_scoped_memory_context_out_of_user_input() {
        let memory_context =
            "For session_upsert on this turn, pass id: \"codex-thread-one\".";
        let params = build_turn_start_params(
            "codex-thread-one",
            "hello",
            None,
            None,
            "/repo",
            None,
            &[],
            None,
            None,
            Some(memory_context),
        );

        assert_eq!(params["input"][0]["text"], json!("hello"));
        assert_eq!(
            params["additionalContext"]["agmux-memory"],
            json!({ "value": memory_context, "kind": "application" })
        );
    }

    #[test]
    fn turn_start_params_default_routes_approvals_to_user() {
        let params = build_turn_start_params(
            "thread-1",
            "hello",
            None,
            None,
            "/repo",
            Some("default"),
            &[],
            None,
            None,
            None,
        );

        assert_eq!(params["approvalPolicy"], json!("on-request"));
        assert_eq!(params["approvalsReviewer"], json!("user"));
        assert_eq!(params["sandboxPolicy"]["type"], json!("workspaceWrite"));
    }

    #[test]
    fn turn_start_params_auto_enables_auto_review() {
        let params = build_turn_start_params(
            "thread-1",
            "hello",
            None,
            None,
            "/repo",
            Some("auto"),
            &[],
            None,
            None,
            None,
        );

        assert_eq!(params["approvalPolicy"], json!("on-request"));
        assert_eq!(params["approvalsReviewer"], json!("auto_review"));
        assert_eq!(params["sandboxPolicy"]["type"], json!("workspaceWrite"));
    }

    #[test]
    fn turn_start_params_full_access_never_asks() {
        let params = build_turn_start_params(
            "thread-1",
            "hello",
            None,
            None,
            "/repo",
            Some("full-access"),
            &[],
            None,
            None,
            None,
        );

        assert_eq!(params["approvalPolicy"], json!("never"));
        assert_eq!(params["approvalsReviewer"], json!("user"));
        assert_eq!(params["sandboxPolicy"]["type"], json!("dangerFullAccess"));
    }

    #[test]
    fn app_server_uses_current_protocol_method_names() {
        assert_eq!(METHOD_THREAD_COMPACT_START, "thread/compact/start");
        assert_eq!(METHOD_THREAD_NAME_SET, "thread/name/set");
        assert_eq!(METHOD_ACCOUNT_RATE_LIMITS_READ, "account/rateLimits/read");
    }
}

/// Collaboration settings override the ordinary turn fields. An incomplete
/// override is unknown, never evidence that the outer configuration applies.
fn execution_configuration(params: &Value) -> (Option<&str>, Option<&str>) {
    if let Some(mode) = params.get("collaborationMode").filter(|v| !v.is_null()) {
        return (
            mode.pointer("/settings/model").and_then(Value::as_str),
            mode.pointer("/settings/reasoning_effort").and_then(Value::as_str),
        );
    }
    (params.get("model").and_then(Value::as_str), params.get("effort").and_then(Value::as_str))
}

#[cfg(test)]
mod execution_configuration_tests {
    use super::*;

    #[test]
    fn collaboration_configuration_takes_precedence() {
        let params = json!({"model":"outer", "effort":"low", "collaborationMode":{
            "settings":{"model":"override", "reasoning_effort":"high"}
        }});
        assert_eq!(execution_configuration(&params), (Some("override"), Some("high")));
    }

    #[test]
    fn missing_override_fields_are_unknown() {
        for mode in [json!({}), json!({"settings":{"model":null}}), json!("plan")] {
            let params = json!({"model":"outer", "effort":"low", "collaborationMode":mode});
            assert_eq!(execution_configuration(&params), (None, None));
        }
        assert_eq!(execution_configuration(&json!({"model":"exact", "effort":"low"})), (Some("exact"), Some("low")));
    }
}
