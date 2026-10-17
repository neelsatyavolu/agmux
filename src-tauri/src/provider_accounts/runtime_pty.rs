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

/// Histories larger than this are not read; such a session never counts as idle.
const IDLE_SCAN_LIMIT: u64 = 512 * 1024 * 1024;

/// A history's (length, modified time) when it was found idle. Unchanged at the handoff, it
/// still proves the same thing, so the file needn't be read again under the session lock.
pub(crate) type HistoryMark = (u64, Option<std::time::SystemTime>);

fn history_mark(path: &std::path::Path) -> Option<HistoryMark> {
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.len(), metadata.modified().ok()))
}

/// `pid` is the terminal's CLI process and `process_start` the history's length when it
/// launched: work recorded as started before then died with an earlier process. With
/// `known` (a mark from an earlier check) the history must be unchanged since, unread.
fn native_idle(provider: &str, session_id: &str, work_dir: &str, checkpoint: (u64, Option<u64>), pid: Option<u32>,
    process_start: u64, known: Option<HistoryMark>) -> Option<HistoryMark> {
    if checkpoint.0 > 0 && checkpoint.1.is_none() { return None; }
    let path = history_path(provider, session_id, work_dir)?;
    let mark = match known {
        Some(known) => (history_mark(&path)? == known).then_some(known)?,
        None => native_idle_path(provider, session_id, &path, checkpoint.1, process_start)?,
    };
    // Claude's history can't show its background agents, workflows, queued messages
    // or open dialogs; its own process status does.
    if provider == "ClaudeCode" && !pid.is_some_and(|pid| crate::commands::background_work::claude_tree_is_idle(pid, session_id)) {
        return None;
    }
    Some(mark)
}

/// The history's length now: where a process launched now starts writing.
fn history_len(provider: &str, session_id: &str, work_dir: &str) -> u64 {
    history_path(provider, session_id, work_dir).and_then(|path| history_mark(&path)).map_or(0, |mark| mark.0)
}

/// Streams the history so long sessions are checked too. A partial last line, a session
/// mismatch or a file that changed while it was read is never idle.
fn native_idle_path(provider: &str, session_id: &str, path: &std::path::Path, required_start: Option<u64>, process_start: u64) -> Option<HistoryMark> {
    use std::io::{BufRead, Read};
    let before = history_mark(path)?;
    if before.0 > IDLE_SCAN_LIMIT { return None; }
    let file = std::fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::with_capacity(1 << 20, file.take(IDLE_SCAN_LIMIT + 1));
    let mut scan = IdleScan::new(provider, session_id, required_start, process_start);
    let mut line = Vec::new();
    let mut offset = 0u64;
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line).ok()? == 0 { break; }
        if line.last() != Some(&b'\n') { return None; }
        let start = offset;
        offset += line.len() as u64;
        let text = &line[..line.len() - 1];
        if !text.is_empty() && !scan.observe(start, text) { return None; }
    }
    if offset == 0 || history_mark(path)? != before { return None; }
    scan.idle().then_some(before)
}

/// The kind of a Grok session update, when it is near the start of the line.
fn grok_update_kind(line: &[u8]) -> Option<&[u8]> {
    const KEY: &[u8] = b"\"sessionUpdate\":\"";
    let head = &line[..line.len().min(512)];
    let start = head.windows(KEY.len()).position(|w| w == KEY)? + KEY.len();
    let end = head[start..].iter().position(|b| *b == b'"')?;
    Some(&head[start..start + end])
}

/// Exec results in a Codex tool output: (session id, finished). A command still running
/// reports its session id with no exit code; its receipt comes later as a CommandExecution
/// item whose process_id is that id. Result fields precede the (maybe truncated) output.
fn codex_exec_sessions(output: &Value) -> Vec<(String, bool)> {
    let texts: Vec<&str> = match output {
        Value::String(text) => vec![text],
        Value::Array(blocks) => blocks.iter().filter_map(|block| block["text"].as_str()).collect(),
        _ => Vec::new(),
    };
    let mut found = Vec::new();
    for text in texts {
        // A direct exec_command call reports in text: "Process running with session ID N".
        const RUNNING: &str = "Process running with session ID ";
        let mut rest = text;
        while let Some(at) = rest.find(RUNNING) {
            rest = &rest[at + RUNNING.len()..];
            let id: String = rest.chars().take_while(char::is_ascii_digit).collect();
            if !id.is_empty() { found.push((id, false)); }
        }
        let mut rest = text;
        while let Some(at) = rest.find("\"chunk_id\"") {
            rest = &rest[at + "\"chunk_id\"".len()..];
            let end = [rest.find("\"output\":"), rest.find("\"chunk_id\"")].into_iter().flatten().min().unwrap_or(rest.len());
            let head = &rest[..end];
            let Some(at) = head.find("\"session_id\":") else { continue; };
            let id: String = head[at + "\"session_id\":".len()..].trim_start().chars().take_while(char::is_ascii_digit).collect();
            let exit = head.find("\"exit_code\":").map(|at| head[at + "\"exit_code\":".len()..].trim_start());
            let finished = exit.is_some_and(|code| code.starts_with(|c: char| c.is_ascii_digit() || c == '-'));
            if !id.is_empty() { found.push((id, finished)); }
        }
    }
    found
}

/// Replays one native history. Only work that can still be running blocks a handoff:
/// something started before this process launched died with an earlier one, and a
/// finished turn's leftovers are settled by the provider's own later records.
struct IdleScan<'a> {
    provider: &'a str,
    session_id: &'a str,
    required_start: Option<u64>,
    process_start: u64,
    boundary: super::runtime::NativeBoundary,
    identity_verified: bool,
    input_submitted: bool,
    active_turn: Option<String>,
    claude_user_turn: bool,
    claude_queued: usize,
    /// Grok tool calls of the current turn, ones an earlier turn left open, and background tasks.
    grok_tools: std::collections::HashSet<String>,
    grok_earlier_tools: std::collections::HashSet<String>,
    grok_tasks: std::collections::HashSet<String>,
    grok_dreams: usize,
}

impl<'a> IdleScan<'a> {
    fn new(provider: &'a str, session_id: &'a str, required_start: Option<u64>, process_start: u64) -> Self {
        Self { provider, session_id, required_start, process_start, boundary: Default::default(),
            identity_verified: !matches!(provider, "Codex" | "ClaudeCode"), input_submitted: required_start.is_none(),
            active_turn: None, claude_user_turn: false, claude_queued: 0, grok_tools: Default::default(),
            grok_earlier_tools: Default::default(), grok_tasks: Default::default(), grok_dreams: 0 }
    }

    fn idle(&self) -> bool {
        self.input_submitted && self.identity_verified && self.boundary.idle() && self.grok_tools.is_empty()
            && self.grok_earlier_tools.is_empty() && self.grok_tasks.is_empty() && self.grok_dreams == 0
    }

    fn submitted_at(&mut self, start: u64) {
        if self.required_start.is_none_or(|offset| start >= offset) { self.input_submitted = true; }
    }

    /// Recorded by the process that is running now.
    fn live(&self, start: u64) -> bool { start >= self.process_start }

    fn started(&mut self, start: u64, id: &str) {
        if self.live(start) { self.boundary.tool_started(id); }
    }

    /// False means the history can't prove this session is idle.
    fn observe(&mut self, start: u64, line: &[u8]) -> bool {
        if self.provider == "Grok" {
            // Most Grok lines are hook, message and thought chunks; skip them unparsed.
            let wanted = |kind: &[u8]| matches!(kind, b"user_message_chunk" | b"turn_completed" | b"tool_call" | b"tool_call_update"
                | b"task_backgrounded" | b"task_completed" | b"background_tasks" | b"subagent_spawned" | b"subagent_finished"
                | b"memory_dream_started" | b"memory_dream_completed");
            if grok_update_kind(line).is_some_and(|kind| !wanted(kind)) { return true; }
        }
        let Ok(value) = serde_json::from_slice::<Value>(line) else { return false; };
        match self.provider {
            "Codex" => self.codex(start, &value),
            "ClaudeCode" => self.claude(start, &value),
            _ => self.grok(start, &value),
        }
    }

    fn codex(&mut self, start: u64, value: &Value) -> bool {
        let payload = &value["payload"];
        if value["type"] == "session_meta" {
            if payload["id"].as_str() != Some(self.session_id) { return false; }
            self.identity_verified = true;
        }
        if value["type"] == "response_item" {
            match payload["type"].as_str() {
                Some("function_call" | "custom_tool_call") => {
                    let Some(id) = payload["call_id"].as_str() else { return false; };
                    self.started(start, id);
                }
                Some("function_call_output" | "custom_tool_call_output") => {
                    let Some(id) = payload["call_id"].as_str() else { return false; };
                    self.boundary.tool_completed(id);
                    // A command can outlive the call that started it.
                    for (session, finished) in codex_exec_sessions(&payload["output"]) {
                        let key = format!("exec:{session}");
                        if finished { self.boundary.tool_completed(&key); } else { self.started(start, &key); }
                    }
                }
                _ => {},
            }
        }
        if value["type"] != "event_msg" { return true; }
        match payload["type"].as_str().unwrap_or("") {
            "task_started" => {
                self.active_turn = payload["turn_id"].as_str().map(str::to_string);
                self.boundary.started();
                self.submitted_at(start);
            },
            // An interrupted turn is over too; commands it left running stay tracked above.
            "task_complete" | "turn_aborted" if self.active_turn.is_some() && payload["turn_id"].as_str() == self.active_turn.as_deref() => self.boundary.completed(),
            "item_started" | "item_completed" => {
                let item = &payload["item"];
                let done = payload["type"] == "item_completed";
                match item["type"].as_str().unwrap_or("") {
                    "UserMessage" | "AgentMessage" | "Reasoning" | "Plan" => {},
                    "CommandExecution" | "FileChange" | "McpToolCall" => {
                        let Some(id) = item["id"].as_str() else { return false; };
                        let finished = done && matches!(item["status"].as_str(), Some("completed" | "failed"))
                            && (item["type"] != "CommandExecution" || item["exit_code"].as_i64().is_some());
                        if finished {
                            self.boundary.tool_completed(id);
                            if let Some(process) = item["process_id"].as_str() { self.boundary.tool_completed(&format!("exec:{process}")); }
                        } else { self.started(start, id); }
                    }
                    // A child agent runs inside this process until it reports completed.
                    "SubAgentActivity" => {
                        let Some(child) = item["agent_thread_id"].as_str().or(item["agent_path"].as_str()) else { return false; };
                        if child == self.session_id || item["agent_path"] == "/root" { return true; }
                        let key = format!("subagent:{child}");
                        if item["kind"] == "completed" { self.boundary.tool_completed(&key); }
                        else { self.started(start, &key); }
                    }
                    // Other kinds (web search, image view, hook prompt, agent waits) are
                    // pending only between their own start and completion.
                    _ => match item["id"].as_str() {
                        Some(id) if done => self.boundary.tool_completed(id),
                        Some(id) => self.started(start, id),
                        None => self.started(start, "unverified-modern-execution"),
                    },
                }
            }
            "collab_agent_spawn_begin" | "background_terminal_started" => self.started(start, "unverified-modern-execution"),
            "exec_command_begin" | "apply_patch_begin" => {
                let Some(id) = payload["call_id"].as_str() else { return false; };
                self.started(start, id);
            }
            "exec_command_end" | "apply_patch_end" => {
                let Some(id) = payload["call_id"].as_str() else { return false; };
                self.boundary.tool_completed(id);
            }
            _ => {},
        }
        true
    }

    /// Background agents, workflows and detached shells aren't settled here: the
    /// handoff also needs Claude's own process status to say idle.
    fn claude(&mut self, start: u64, value: &Value) -> bool {
        if value["isSidechain"] == true { return true; }
        if value.get("sessionId").is_some() && value["sessionId"].as_str() != Some(self.session_id) { return false; }
        let kind = value["type"].as_str().unwrap_or("");
        if matches!(kind, "user" | "assistant") {
            if value["sessionId"].as_str() != Some(self.session_id) { return false; }
            self.identity_verified = true;
            let content = &value["message"]["content"];
            let results_only = content.as_array().is_some_and(|blocks| !blocks.is_empty()
                && blocks.iter().all(|b| b["type"] == "tool_result"));
            if kind == "user" && !results_only {
                self.boundary.started();
                if value["isMeta"] != true && value["isCompactSummary"] != true {
                    self.claude_user_turn = true;
                    self.submitted_at(start);
                }
            }
            for block in content.as_array().into_iter().flatten() {
                match block["type"].as_str().unwrap_or("") {
                    "tool_use" | "server_tool_use" | "mcp_tool_use" => {
                        let Some(id) = block["id"].as_str() else { return false; };
                        self.started(start, id);
                    },
                    "tool_result" => {
                        let Some(id) = block["tool_use_id"].as_str() else { return false; };
                        self.boundary.tool_completed(id);
                    },
                    _ => {},
                }
            }
            if kind == "assistant" {
                self.boundary.started();
                if self.claude_user_turn && (value["message"]["stop_reason"] == "end_turn" || claude_quota_rejection(value)) {
                    self.boundary.completed();
                    // Queue records before a finished turn were that turn's; Claude doesn't
                    // record every message it absorbs, so only later ones can still be waiting.
                    self.claude_queued = 0;
                    self.boundary.tool_completed("queued-input");
                }
            }
        } else if kind == "queue-operation" {
            match value["operation"].as_str() {
                Some("enqueue") if self.live(start) => self.claude_queued += 1,
                Some("dequeue" | "remove") => self.claude_queued = self.claude_queued.saturating_sub(1),
                Some("popAll") => self.claude_queued = 0,
                _ => {},
            }
            if self.claude_queued > 0 { self.boundary.tool_started("queued-input"); }
            else { self.boundary.tool_completed("queued-input"); }
        }
        true
    }

    fn grok(&mut self, start: u64, value: &Value) -> bool {
        let method = value["method"].as_str().unwrap_or("");
        if !matches!(method, "session/update" | "_x.ai/session/update") { return true; }
        if value["params"]["sessionId"].as_str() != Some(self.session_id) { return false; }
        let update = &value["params"]["update"];
        let live = self.live(start);
        match update["sessionUpdate"].as_str().unwrap_or("") {
            "user_message_chunk" => {
                // A cancelled turn's tool can still finish after that turn ended.
                self.grok_earlier_tools.extend(self.grok_tools.drain());
                self.boundary.started();
                self.submitted_at(start);
            },
            "turn_completed" if method == "_x.ai/session/update" => {
                self.boundary.completed();
                // A later turn ended normally: Grok has moved past what an earlier one left open.
                if update["stop_reason"] == "end_turn" { self.grok_earlier_tools.clear(); }
            },
            "tool_call" => {
                let Some(id) = update["toolCallId"].as_str() else { return false; };
                if live { self.grok_tools.insert(id.to_string()); }
            }
            "tool_call_update" if matches!(update["status"].as_str(), Some("completed" | "failed")) => {
                let Some(id) = update["toolCallId"].as_str() else { return false; };
                self.grok_tools.remove(id);
                self.grok_earlier_tools.remove(id);
            }
            // A backgrounded command runs on until its task_completed.
            "task_backgrounded" => {
                let Some(id) = update["tool_call_id"].as_str() else { return false; };
                self.grok_tools.remove(id);
                self.grok_earlier_tools.remove(id);
                let task = update["task_id"].as_str().unwrap_or(id);
                if live { self.grok_tasks.insert(task.to_string()); }
            }
            "task_completed" => {
                if let Some(task) = update["task_snapshot"]["task_id"].as_str() { self.grok_tasks.remove(task); }
            }
            // The live set as of then; finished tasks stay listed with their status. One
            // written by an earlier process describes tasks that died with it.
            "background_tasks" => {
                self.grok_tasks.clear();
                if live {
                    let running = update["tasks"].as_array().into_iter().flatten()
                        .filter(|task| task["status"] == "running").filter_map(|task| task["task_id"].as_str());
                    self.grok_tasks.extend(running.map(str::to_string));
                }
            }
            "subagent_spawned" => match update["subagent_id"].as_str() {
                Some(id) => self.started(start, &format!("subagent:{id}")),
                None => self.started(start, "unverified:subagent"),
            },
            "subagent_finished" => {
                if let Some(id) = update["subagent_id"].as_str() { self.boundary.tool_completed(&format!("subagent:{id}")); }
            }
            // Memory consolidation Grok runs after a turn.
            "memory_dream_started" => if live { self.grok_dreams += 1; },
            "memory_dream_completed" => self.grok_dreams = self.grok_dreams.saturating_sub(1),
            _ => {},
        }
        true
    }
}

/// After finding no replacement, how long a terminal waits before looking again.
const RESERVE_RETRY: std::time::Duration = std::time::Duration::from_secs(5 * 60);
/// At most three switches per terminal in this long.
const SWITCH_WINDOW: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// How one handoff attempt ended: switched, try again later, or stop watching.
enum Step { Switched, Retry, Stop }

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
        // Where the running process starts writing; work begun before it died with an earlier one.
        let mut process_start = options.resume_session_id.as_deref().map_or(0, |native| history_len(&provider, native, &work_dir));
        let mut notices = std::collections::HashSet::new();
        let mut recent_switches = std::collections::VecDeque::new();
        let mut switching = false;
        let mut next_reservation_at: Option<tokio::time::Instant> = None;
        // Per monitor, so a late-exiting earlier monitor can't give back this one's reservation.
        let reserve_key = format!("{thread_id}#next-account-{}", uuid::Uuid::new_v4());
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
            // Every session on a login shares one reading; a usage failure keeps the last one.
            let _ = super::refresh_if_stale(&account.account_id, 55).await;
            let exhaustion = if provider == "ClaudeCode" {
                let model = match native.as_deref() {
                    Some(native) => native_model(&provider, native, &work_dir).await,
                    None => None,
                };
                claude_quota_exhaustion(&key, &account.account_id, model.as_deref()).await
            } else { super::quota_exhaustion(&account.account_id).await };
            let Ok(Some(reset)) = exhaustion else {
                notices.clear();
                next_reservation_at = None;
                continue;
            };
            if !super::auto_switch_enabled().await.unwrap_or(false) { continue; }
            if next_reservation_at.is_some_and(|at| tokio::time::Instant::now() < at) { continue; }
            let notice = |status: &str| {
                let _ = app.emit("provider-account-runtime", json!({"provider": account_provider, "sessionKey": key, "threadId": thread_id, "status": status}));
            };
            let Some(native) = native else {
                if notices.insert("identity") { notice("identity_unavailable"); }
                continue;
            };
            let checkpoint = {
                let sessions = state.sessions.lock().await;
                let Some(session) = sessions.get(&thread_id) else { break; };
                let mut writer = session.writer.lock().await;
                if let Some(path) = history_path(&provider, &native, &work_dir) { writer.set_native_history(path); }
                writer.input_checkpoint()
            };
            let pid = child.lock().await.process_id();
            let (p, n, w) = (provider.clone(), native.clone(), work_dir.clone());
            let idle = tokio::task::spawn_blocking(move || native_idle(&p, &n, &w, checkpoint, pid, process_start, None)).await.ok().flatten();
            let Some(mark) = idle else {
                if notices.insert("waiting") { notice("waiting_for_idle"); }
                continue;
            };
            // A reading that keeps flipping must not restart the session over and over.
            let now = tokio::time::Instant::now();
            while recent_switches.front().is_some_and(|at| now.duration_since(*at) > SWITCH_WINDOW) { recent_switches.pop_front(); }
            if recent_switches.len() >= 3 { continue; }
            // /model inside the terminal can supersede the launch options.
            // Unknown model context must not stop the current native process.
            let Some(model) = native_model(&provider, &native, &work_dir).await else {
                if notices.insert("model") { notice("model_unavailable"); }
                continue;
            };
            if super::remember_model(&account_provider, &key, Some(&model)).await.is_err() { continue; }
            // /model may have changed since the first quota observation.
            let reset = if provider == "ClaudeCode" {
                match claude_quota_exhaustion(&key, &account.account_id, Some(&model)).await {
                    Ok(Some(reset)) => reset,
                    _ => continue,
                }
            } else { reset };
            // Find where to go before touching the session: with nowhere to go it keeps running.
            // Its own login is fine again once that limit has reset; other accounts it left stay excluded.
            match super::reserve_replacement(&account_provider, &key, &reserve_key, reset).await {
                Ok(Some(_)) => {},
                result => {
                    if matches!(result, Ok(Some(_))) { super::abandon_reservation(&reserve_key).await; }
                    if let Err(error) = result { tracing::info!("No replacement account for {thread_id}: {error}"); }
                    next_reservation_at = Some(tokio::time::Instant::now() + RESERVE_RETRY);
                    if notices.insert("no_replacement") { notice("no_replacement"); }
                    continue;
                }
            };
            next_reservation_at = None;
            let step = 'handoff: {
                // Subscribe before stopping so a late old-reader exit cannot close the
                // replacement terminal. The map stays locked only to stop and restart.
                let mut sessions = state.sessions.lock().await;
                let Some(old) = sessions.get(&thread_id) else { break 'handoff Step::Stop; };
                if !Arc::ptr_eq(&old.child, &child) || old.is_shutting_down.load(Ordering::Relaxed) { break 'handoff Step::Stop; }
                let (done, wait) = tokio::sync::oneshot::channel();
                let done = std::sync::Mutex::new(Some(done));
                let listener = app.listen(format!("pty-exit-{thread_id}"), move |_| {
                    if let Some(done) = done.lock().unwrap_or_else(|e| e.into_inner()).take() { let _ = done.send(()); }
                });
                // Freeze terminal writes while revalidating the native boundary.
                let writer = old.writer.lock().await;
                let generation = old.input_generation.load(Ordering::SeqCst);
                let (p, n, w) = (provider.clone(), native.clone(), work_dir.clone());
                // Unchanged history only: one that moved on is checked again on the next pass, not
                // re-read while every terminal waits on this lock.
                let still_idle = writer.input_checkpoint() == checkpoint
                    && tokio::task::spawn_blocking(move || native_idle(&p, &n, &w, checkpoint, pid, process_start, Some(mark))).await.ok().flatten().is_some()
                    && native_model(&provider, &native, &work_dir).await.as_deref() == Some(model.as_str())
                    && old.input_generation.load(Ordering::SeqCst) == generation;
                if !still_idle { app.unlisten(listener); break 'handoff Step::Retry; }
                if provider == "ClaudeCode" && super::claude::uses_project_auth(std::path::Path::new(&work_dir)) { app.unlisten(listener); break 'handoff Step::Stop; }
                // A first Codex handoff moves from an agmux key to its native ID, which a chat
                // on the same conversation may hold; then the switch can't be completed.
                let next_key = if provider == "Codex" { native.clone() } else { thread_id.clone() };
                if next_key != key && super::current_assignment(&next_key).await.is_some() {
                    app.unlisten(listener);
                    next_reservation_at = Some(tokio::time::Instant::now() + RESERVE_RETRY);
                    break 'handoff Step::Retry;
                }
                options.model = Some(model);
                recent_switches.push_back(tokio::time::Instant::now());
                switching = true;
                notice("switching");
                old.kill().await;
                drop(writer);
                let exited = tokio::time::timeout(std::time::Duration::from_secs(5), wait).await;
                app.unlisten(listener);
                if !matches!(exited, Ok(Ok(()))) { break 'handoff Step::Stop; }
                sessions.remove(&thread_id);
                options.resume_session_id = Some(native.clone());
                // The old process is gone and out of the session map, so its exit can't
                // release its binding: handing over (or failing to) gives it back here.
                let retired = match super::adopt_reservation(&account_provider, &key, &reserve_key, &next_key).await {
                    Ok(retired) => retired,
                    Err(error) => {
                        tracing::warn!("Could not hand {thread_id} to its replacement account: {error}");
                        let _ = super::release(&key).await;
                        break 'handoff Step::Stop;
                    }
                };
                process_start = history_len(&provider, &native, &work_dir);
                let replacement = crate::process::spawn::spawn_pty_session(&state.db, &thread_id, &provider, &work_dir, &options).await;
                let started = match replacement {
                    Ok(replacement) => {
                        expected_child = Arc::downgrade(&replacement.child);
                        crate::process::io::start_stdout_reader(app.clone(), thread_id.clone(), replacement.master.clone(), replacement.child.clone(),
                            replacement.is_shutting_down.clone(), replacement.output_buffer.clone(), state.db.clone());
                        sessions.insert(thread_id.clone(), replacement);
                        true
                    }
                    // Nothing runs on the new account; holding it would keep a team lease
                    // nobody renews and block "Use this account" until restart.
                    Err(_) => { let _ = super::release(&next_key).await; false }
                };
                drop(sessions);
                if let Some(retired) = retired {
                    if let Err(error) = super::retire(retired).await { tracing::warn!("Could not return the account {thread_id} left: {error}"); }
                }
                switching = false;
                if !started {
                    notice("unavailable");
                    break 'handoff Step::Stop;
                }
                notices.clear();
                let _ = app.emit("provider-account-runtime", json!({"provider": account_provider, "sessionKey": options.resume_session_id, "threadId": thread_id, "status": "ready", "continuationRequired": true}));
                Step::Switched
            };
            match step {
                Step::Switched => {},
                Step::Retry => super::abandon_reservation(&reserve_key).await,
                Step::Stop => { super::abandon_reservation(&reserve_key).await; break; },
            }
        }
        super::abandon_reservation(&reserve_key).await;
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
        // A background agent or shell outlives its tool result. The transcript can't show
        // it; the handoff also needs Claude's process status (`claude_tree_is_idle`).
        let mut background=tool; background["message"]["content"][0]["input"]=json!({"run_in_background":true});
        assert!(idle("ClaudeCode", &[user.clone(),background,result,end.clone()]));
        let mut child=end; child["isSidechain"]=json!(true);
        assert!(!idle("ClaudeCode", &[user.clone(),child]));
        let enqueue=json!({"type":"queue-operation","sessionId":"session","operation":"enqueue"});
        let dequeue=json!({"type":"queue-operation","sessionId":"session","operation":"dequeue"});
        let end=claude("assistant",json!({"stop_reason":"end_turn","content":[]}));
        assert!(!idle("ClaudeCode", &[user.clone(),end.clone(),enqueue.clone()]));
        assert!(idle("ClaudeCode", &[enqueue,dequeue,user,end]));
    }
    #[test]
    fn claude_queue_only_counts_messages_waiting_after_the_last_finished_turn() {
        let user = claude("user", json!({"content":"question"}));
        let end = claude("assistant", json!({"stop_reason":"end_turn","content":[]}));
        let op = |operation: &str| json!({"type":"queue-operation","sessionId":"session","operation":operation});
        // Claude absorbs some queued messages mid-turn without a dequeue record.
        assert!(idle("ClaudeCode", &[user.clone(), op("enqueue"), op("enqueue"), end.clone()]));
        assert!(!idle("ClaudeCode", &[user.clone(), end.clone(), op("enqueue"), op("enqueue"), op("dequeue")]));
        for settled in ["dequeue", "remove", "popAll"] {
            assert!(idle("ClaudeCode", &[user.clone(), end.clone(), op("enqueue"), op(settled)]), "{settled}");
        }
        // Unknown queue operations are not a lasting block.
        assert!(idle("ClaudeCode", &[user, end, op("future-operation")]));
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
        native_idle_path(provider, "session", &path, None, 0).is_some()
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
        assert!(native_idle_path("Codex", "session", &path, Some(input_offset), 0).is_none());
        let start = json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}});
        std::fs::write(&path, format!("{old}{start}\n{end}\n")).unwrap();
        assert!(native_idle_path("Codex", "session", &path, Some(input_offset), 0).is_some());
    }
    #[test]
    fn codex_tool_outputs_finish_their_calls_and_an_interrupt_ends_the_turn() {
        let header = json!({"type":"session_meta","payload":{"id":"session"}});
        let turn = json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}});
        let complete = json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn"}});
        let call = |kind: &str, id: &str| json!({"type":"response_item","payload":{"type":kind,"call_id":id}});
        assert!(idle("Codex", &[header.clone(), turn.clone(), call("custom_tool_call","w"), call("custom_tool_call_output","w"), complete.clone()]));
        assert!(idle("Codex", &[header.clone(), turn.clone(), call("function_call","f"), call("function_call_output","f"), complete.clone()]));
        assert!(!idle("Codex", &[header.clone(), turn.clone(), call("function_call","f"), call("function_call_output","other"), complete.clone()]));
        let aborted = |id: &str| json!({"type":"event_msg","payload":{"type":"turn_aborted","turn_id":id,"reason":"interrupted"}});
        assert!(idle("Codex", &[header.clone(), turn.clone(), aborted("turn")]));
        assert!(!idle("Codex", &[header.clone(), turn.clone(), aborted("other")]));
        // A command an interrupted turn left running is still tracked by its item.
        let command = json!({"type":"event_msg","payload":{"type":"item_started","item":{"type":"CommandExecution","id":"shell"}}});
        assert!(!idle("Codex", &[header, turn, command, aborted("turn")]));
    }
    #[test]
    fn codex_finished_non_execution_items_never_block_but_running_child_agents_do() {
        let header = json!({"type":"session_meta","payload":{"id":"session"}});
        let turn = json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}});
        let complete = json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn"}});
        let item = |event: &str, item: Value| json!({"type":"event_msg","payload":{"type":event,"item":item}});
        for done in [json!({"type":"ImageView","id":"exec-1"}), json!({"type":"Extension","kind":"web.search","id":"exec-2"}),
            json!({"type":"HookPrompt","id":"msg-1"}), json!({"type":"CollabAgentToolCall","id":"call-1","tool":"wait","status":"completed"})] {
            assert!(idle("Codex", &[header.clone(), turn.clone(), item("item_completed", done), complete.clone()]));
        }
        assert!(!idle("Codex", &[header.clone(), turn.clone(), item("item_started", json!({"type":"Future","id":"x"})), complete.clone()]));
        let child = |kind: &str| item("item_completed", json!({"type":"SubAgentActivity","id":"c","kind":kind,"agent_thread_id":"child","agent_path":"/root/review"}));
        assert!(!idle("Codex", &[header.clone(), turn.clone(), child("started"), complete.clone()]));
        assert!(idle("Codex", &[header.clone(), turn.clone(), child("started"), child("completed"), complete.clone()]));
        assert!(!idle("Codex", &[header.clone(), turn.clone(), child("started"), child("completed"), child("interacted"), complete.clone()]));
        // The root agent's own activity is this session, not a child.
        let root = item("item_completed", json!({"type":"SubAgentActivity","id":"r","kind":"interacted","agent_thread_id":"session","agent_path":"/root"}));
        assert!(idle("Codex", &[header, turn, root, complete]));
    }
    fn grok(kind: &str, fields: Value) -> Value {
        let mut update = json!({"sessionUpdate": kind});
        update.as_object_mut().unwrap().extend(fields.as_object().cloned().unwrap_or_default());
        json!({"timestamp":1,"method":"_x.ai/session/update","params":{"sessionId":"session","update":update}})
    }
    #[test]
    fn grok_backgrounded_commands_and_finished_background_tasks_do_not_block() {
        let user = grok("user_message_chunk", json!({}));
        let call = grok("tool_call", json!({"toolCallId":"cmd","status":"in_progress"}));
        let end = grok("turn_completed", json!({"stop_reason":"end_turn"}));
        let backgrounded = grok("task_backgrounded", json!({"tool_call_id":"cmd","task_id":"cmd"}));
        let tasks = |status: &str| grok("background_tasks", json!({"tasks":[{"task_id":"cmd","status":status}]}));
        assert!(!idle("Grok", &[user.clone(), call.clone(), backgrounded.clone(), tasks("running"), end.clone()]));
        assert!(idle("Grok", &[user.clone(), call.clone(), backgrounded.clone(), tasks("running"), end.clone(), tasks("completed")]));
        assert!(idle("Grok", &[user.clone(), call.clone(), backgrounded, end.clone(), tasks("failed")]));
        assert!(idle("Grok", &[user, end, grok("background_tasks", json!({"tasks":[]}))]));
    }
    #[test]
    fn grok_subagents_block_until_their_own_finish_and_cancelled_tools_until_a_later_turn() {
        let user = grok("user_message_chunk", json!({}));
        let end = grok("turn_completed", json!({"stop_reason":"end_turn"}));
        let cancelled = grok("turn_completed", json!({"stop_reason":"cancelled"}));
        let spawned = |id: &str| grok("subagent_spawned", json!({"subagent_id":id}));
        let finished = |id: &str| grok("subagent_finished", json!({"subagent_id":id,"status":"completed"}));
        assert!(!idle("Grok", &[user.clone(), spawned("a"), end.clone()]));
        assert!(!idle("Grok", &[user.clone(), spawned("a"), spawned("b"), finished("b"), end.clone()]));
        assert!(idle("Grok", &[user.clone(), spawned("a"), spawned("b"), finished("b"), finished("a"), end.clone()]));
        // A command can still finish after its turn was cancelled.
        let call = grok("tool_call", json!({"toolCallId":"cmd"}));
        assert!(!idle("Grok", &[user.clone(), call.clone(), cancelled.clone()]));
        assert!(!idle("Grok", &[user.clone(), call.clone(), cancelled.clone(), user.clone(), cancelled.clone()]));
        assert!(idle("Grok", &[user.clone(), call.clone(), cancelled.clone(), user.clone(), end.clone()]));
        let done = grok("tool_call_update", json!({"toolCallId":"cmd","status":"completed"}));
        assert!(idle("Grok", &[user.clone(), call, cancelled, done]));
    }
    /// Idle with `before` written by an earlier process and `after` by the running one.
    fn idle_since(provider: &str, before: &[Value], after: &[Value]) -> bool {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("native.jsonl");
        let earlier = before.iter().map(|v| format!("{v}\n")).collect::<String>();
        let text = earlier.clone() + &after.iter().map(|v| format!("{v}\n")).collect::<String>();
        std::fs::write(&path, text).unwrap();
        native_idle_path(provider, "session", &path, None, earlier.len() as u64).is_some()
    }
    #[test]
    fn codex_commands_still_running_after_their_call_block_until_their_receipt() {
        let header = json!({"type":"session_meta","payload":{"id":"session"}});
        let turn = json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}});
        let complete = json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn"}});
        let call = json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":"w"}});
        let output = |results: &str| json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"w",
            "output":[{"type":"input_text","text":"Script completed\nOutput:\n"},{"type":"input_text","text":results}]}});
        let running = output(r#"{"chunk_id":"a","wall_time_seconds":10.0,"session_id":3203,"original_token_count":3,"output":"listening on :3000"}"#);
        let receipt = |pid: &str| json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution",
            "id":"exec-1","status":"completed","exit_code":0,"process_id":pid}}});
        assert!(!idle("Codex", &[header.clone(), turn.clone(), call.clone(), running.clone(), complete.clone()]));
        assert!(!idle("Codex", &[header.clone(), turn.clone(), call.clone(), running.clone(), complete.clone(), receipt("9")]));
        assert!(idle("Codex", &[header.clone(), turn.clone(), call.clone(), running.clone(), complete.clone(), receipt("3203")]));
        // A later poll reporting its exit settles it too.
        let polled = output(r#"{"chunk_id":"b","wall_time_seconds":0.1,"exit_code":0,"session_id":3203,"output":"done"}"#);
        assert!(idle("Codex", &[header.clone(), turn.clone(), call.clone(), running.clone(), polled, complete.clone()]));
        // allSettled wrappers nest results; truncated output keeps the result fields.
        for text in [r#"[{"i":0,"status":"fulfilled","value":{"chunk_id":"c","session_id":77,"output":"…"}}]"#,
            "Warning: truncated output\n{\"chunk_id\":\"d\",\"wall_time_seconds\":1.0,\"session_id\":77,\"original_token_count\":9,\"output\":\"cut off mid-"] {
            assert!(!idle("Codex", &[header.clone(), turn.clone(), call.clone(), output(text), complete.clone()]), "{text}");
        }
        // A direct exec_command call reports in text instead.
        let direct = json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"w",
            "output":"Chunk ID: 1a2b\nWall time: 10.0 seconds\nProcess running with session ID 4410\nOriginal token count: 4\nOutput:\nready"}});
        assert!(!idle("Codex", &[header.clone(), turn.clone(), call.clone(), direct.clone(), complete.clone()]));
        assert!(idle("Codex", &[header.clone(), turn.clone(), call.clone(), direct, complete.clone(), receipt("4410")]));
        // A command an earlier process started died with it.
        assert!(idle_since("Codex", &[header.clone(), turn.clone(), call.clone(), running], &[turn, complete]));
    }
    #[test]
    fn grok_background_tasks_run_until_their_own_completion() {
        let user = grok("user_message_chunk", json!({}));
        let end = grok("turn_completed", json!({"stop_reason":"end_turn"}));
        let call = grok("tool_call", json!({"toolCallId":"cmd"}));
        let backgrounded = grok("task_backgrounded", json!({"tool_call_id":"cmd","task_id":"cmd"}));
        // Grok often marks the call completed once it is in the background.
        let call_done = grok("tool_call_update", json!({"toolCallId":"cmd","status":"completed"}));
        let task_done = grok("task_completed", json!({"task_snapshot":{"task_id":"cmd","command":"cargo test"}}));
        assert!(!idle("Grok", &[user.clone(), call.clone(), backgrounded.clone(), call_done.clone(), end.clone()]));
        assert!(idle("Grok", &[user.clone(), call.clone(), backgrounded.clone(), call_done.clone(), end.clone(), task_done]));
        // A list or task an earlier process wrote describes work that died with it.
        let listed = grok("background_tasks", json!({"tasks":[{"task_id":"cmd","status":"running"}]}));
        assert!(idle_since("Grok", &[user.clone(), call.clone(), backgrounded.clone(), listed.clone(), end.clone()], &[user.clone(), end.clone()]));
        assert!(!idle_since("Grok", &[user.clone()], &[call, backgrounded, listed, end.clone()]));
        let dream = |kind: &str| grok(kind, json!({}));
        assert!(!idle("Grok", &[user.clone(), end.clone(), dream("memory_dream_started")]));
        assert!(idle("Grok", &[user.clone(), end.clone(), dream("memory_dream_started"), dream("memory_dream_completed")]));
        assert!(idle_since("Grok", &[user, end.clone(), dream("memory_dream_started")], &[end]));
    }
    #[test]
    fn claude_tools_and_queue_from_an_earlier_process_do_not_block() {
        let user = claude("user", json!({"content":"question"}));
        let tool = claude("assistant", json!({"stop_reason":"tool_use","content":[{"type":"tool_use","id":"t","name":"Bash","input":{}}]}));
        let rejected = {
            let mut value = claude("assistant", json!({"model":"<synthetic>","stop_reason":"stop_sequence","content":[]}));
            value["isApiErrorMessage"] = json!(true); value["error"] = json!("rate_limit"); value["apiErrorStatus"] = json!(429);
            value
        };
        let enqueue = json!({"type":"queue-operation","sessionId":"session","operation":"enqueue"});
        assert!(!idle("ClaudeCode", &[user.clone(), tool.clone(), user.clone(), rejected.clone()]));
        assert!(idle_since("ClaudeCode", &[user.clone(), tool, enqueue], &[user, rejected]));
    }
    #[test]
    #[ignore = "Read-only scan of this Mac's Grok, Codex and Claude histories"]
    fn live_histories_settle_once_their_work_is_done() {
        let home = dirs::home_dir().unwrap();
        let month_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(30 * 86400);
        let recent = |path: &std::path::Path| std::fs::metadata(path).and_then(|m| m.modified()).is_ok_and(|t| t > month_ago);
        let mut grok = (0, 0);
        for cwd in std::fs::read_dir(home.join(".grok/sessions")).into_iter().flatten().flatten() {
            for session in std::fs::read_dir(cwd.path()).into_iter().flatten().flatten() {
                let path = session.path().join("updates.jsonl");
                if !recent(&path) { continue; }
                let id = session.file_name().to_string_lossy().to_string();
                grok.0 += 1;
                if native_idle_path("Grok", &id, &path, None, 0).is_some() { grok.1 += 1; }
            }
        }
        let mut codex = (0, 0);
        let mut stack = vec![home.join(".codex/sessions")];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                let path = entry.path();
                if path.is_dir() { stack.push(path); continue; }
                let name = entry.file_name().to_string_lossy().to_string();
                let Some(id) = name.strip_suffix(".jsonl").and_then(|n| n.get(n.len().saturating_sub(36)..)) else { continue; };
                if !name.starts_with("rollout-") || !recent(&path) { continue; }
                codex.0 += 1;
                if native_idle_path("Codex", id, &path, None, 0).is_some() { codex.1 += 1; }
            }
        }
        let mut claude = (0, 0);
        for project in std::fs::read_dir(home.join(".claude/projects")).into_iter().flatten().flatten() {
            for entry in std::fs::read_dir(project.path()).into_iter().flatten().flatten() {
                let path = entry.path();
                let Some(id) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".jsonl")).map(str::to_string) else { continue; };
                if !recent(&path) { continue; }
                claude.0 += 1;
                if native_idle_path("ClaudeCode", &id, &path, None, 0).is_some() { claude.1 += 1; }
            }
        }
        println!("settled histories (last 30 days): grok {}/{} · codex {}/{} · claude {}/{}", grok.1, grok.0, codex.1, codex.0, claude.1, claude.0);
    }
    #[test]
    fn long_histories_are_read_whole() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("updates.jsonl");
        let hook = grok("hook_execution", json!({"event_name":"post_tool_use","runs":[{"name":"x".repeat(400)}]})).to_string();
        let mut text = format!("{}\n{}\n", grok("user_message_chunk", json!({})), grok("tool_call", json!({"toolCallId":"t"})));
        while text.len() < 20 * 1024 * 1024 { text.push_str(&hook); text.push('\n'); }
        std::fs::write(&path, &text).unwrap();
        assert!(native_idle_path("Grok", "session", &path, None, 0).is_none());
        text.push_str(&format!("{}\n{}\n", grok("tool_call_update", json!({"toolCallId":"t","status":"completed"})),
            grok("turn_completed", json!({"stop_reason":"end_turn"}))));
        std::fs::write(&path, &text).unwrap();
        let mark = native_idle_path("Grok", "session", &path, None, 0).expect("a 20 MB history is still checked");
        assert_eq!(mark.0, text.len() as u64);
        std::fs::write(&path, format!("{text}{{\"partial\"")).unwrap();
        assert!(native_idle_path("Grok", "session", &path, None, 0).is_none(), "a line still being written");
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
