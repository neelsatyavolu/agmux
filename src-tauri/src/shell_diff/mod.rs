//! Verified supplemental shell edits; provider-native edit statistics stay separate.

mod targets;
pub(crate) fn exec_patch_sources(source: &str, output: &serde_json::Value) -> Vec<String> {
    targets::exec_patch_sources(source, output)
}
mod storage;
mod terminal;
mod continuations;
mod captured;
pub(crate) use storage::{ShellDiffStats, list as list_stats};
pub(crate) fn start(app: tauri::AppHandle) { captured::start(app.clone()); terminal::start(app); }

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_PENDING: usize = 256;
const MAX_AGE: Duration = Duration::from_secs(600);

struct Pending {
    root: PathBuf,
    paths: Vec<PathBuf>,
    before: Vec<(PathBuf, Vec<u8>)>,
    ambiguous: bool,
    wide: bool,
    started: Instant,
}

struct Change {
    path: PathBuf,
    added: u64,
    removed: u64,
}

#[derive(Default)]
struct Tracker {
    pending: HashMap<(String, String), Pending>,
    sessions: HashMap<(String, String), Option<String>>,
    hook_calls: HashMap<String, Vec<(String, String, Value)>>,
    continuations: continuations::Continuations,
}

fn tracker() -> &'static tokio::sync::Mutex<Tracker> {
    static TRACKER: OnceLock<tokio::sync::Mutex<Tracker>> = OnceLock::new();
    TRACKER.get_or_init(|| tokio::sync::Mutex::new(Tracker::default()))
}

// Missing is distinct from unreadable/oversized/binary. Only a confirmed
// ENOENT is an empty before-image; every other failure suppresses the delta.
async fn read_text(path: &Path) -> Option<Vec<u8>> {
    // Paths were canonicalized before the command. A replaced parent symlink
    // must not redirect the after-image to some other file.
    if tokio::fs::canonicalize(path.parent()?).await.ok()?.as_path() != path.parent()? { return None; }
    let meta = match tokio::fs::symlink_metadata(path).await {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(Vec::new()),
        Err(_) => return None,
    };
    if !meta.is_file() || meta.len() > MAX_BYTES as u64 { return None; }
    let bytes = tokio::fs::read(path).await.ok()?;
    if bytes.len() > MAX_BYTES || bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
        return None;
    }
    Some(bytes)
}

fn overlaps(a: &Pending, b: &Pending) -> bool {
    if a.wide || b.wide || a.paths.is_empty() || b.paths.is_empty() {
        a.root.starts_with(&b.root) || b.root.starts_with(&a.root)
    } else {
        a.paths.iter().any(|p| b.paths.contains(p))
    }
}

impl Tracker {
    #[cfg(test)]
    async fn begin_observed(&mut self, owner: &str, id: &str, root: &Path, paths: Vec<PathBuf>, shell: bool) {
        self.begin_observed_related(owner, id, root, paths, shell, &[]).await;
    }

    async fn begin_observed_related(&mut self, owner: &str, id: &str, root: &Path, paths: Vec<PathBuf>, shell: bool, related: &[String]) {
        let key = (owner.to_string(), id.to_string());
        if self.pending.contains_key(&key) { return; }
        let probe = Pending { root: root.to_path_buf(), paths: vec![], before: vec![], ambiguous: false, wide: true, started: Instant::now() };
        let mut collided = false;
        for (key, other) in &mut self.pending {
            if key.0 == owner && related.contains(&key.1) { continue; }
            if overlaps(&probe, other) { other.ambiguous = true; collided = true; }
        }
        self.begin_related(owner, id, root, paths, shell, related).await;
        if let Some(pending) = self.pending.get_mut(&key) {
            pending.wide = true;
            pending.ambiguous |= collided;
        }
    }

    #[cfg(test)]
    async fn begin(&mut self, owner: &str, id: &str, root: &Path, paths: Vec<PathBuf>, shell: bool) {
        self.begin_related(owner, id, root, paths, shell, &[]).await;
    }

    async fn begin_related(&mut self, owner: &str, id: &str, root: &Path, paths: Vec<PathBuf>, shell: bool, related: &[String]) {
        let key = (owner.to_string(), id.to_string());
        // Expiration invalidates snapshots, not evidence of a live writer.
        // Keep its collision guard until completion/cancellation; another tool
        // can still observe writes from a command that exceeded the time limit.
        for pending in self.pending.values_mut().filter(|p| p.started.elapsed() >= MAX_AGE) {
            pending.before.clear();
            pending.ambiguous = true;
        }
        self.sessions.retain(|key, _| self.pending.contains_key(key));
        if self.pending.contains_key(&key) { return; }
        if self.pending.len() >= MAX_PENDING {
            // Unknown work during overload makes every in-flight attribution unsafe.
            for p in self.pending.values_mut() { p.ambiguous = true; }
            return;
        }
        let root = tokio::fs::canonicalize(root).await.unwrap_or_else(|_| root.to_path_buf());
        let mut resolved = Vec::new();
        for path in paths {
            if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
                if let Ok(parent) = tokio::fs::canonicalize(parent).await { resolved.push(parent.join(name)); }
            }
        }
        let mut pending = Pending {
            root, paths: resolved, before: Vec::new(),
            ambiguous: false, wide: false, started: Instant::now(),
        };
        for (key, other) in &mut self.pending {
            if key.0 == owner && related.contains(&key.1) { continue; }
            if overlaps(&pending, other) {
                pending.ambiguous = true;
                other.ambiguous = true;
            }
        }
        if shell && !pending.ambiguous {
            let mut retained: usize = self.pending.values().flat_map(|p| &p.before).map(|(_, bytes)| bytes.len()).sum();
            for path in &pending.paths {
                if let Some(bytes) = read_text(path).await {
                    retained += bytes.len();
                    if retained > 32 * 1024 * 1024 { break; }
                    pending.before.push((path.clone(), bytes));
                }
            }
        }
        self.pending.insert(key, pending);
    }

    async fn finish(&mut self, owner: &str, id: &str) -> Vec<Change> {
        let Some(pending) = self.pending.remove(&(owner.to_string(), id.to_string())) else { return Vec::new() };
        if pending.ambiguous || pending.started.elapsed() >= MAX_AGE { return Vec::new(); }
        let mut changes = Vec::new();
        for (path, before) in pending.before {
            let Some(after) = read_text(&path).await else { continue };
            if before == after { continue; }
            let (added, removed) = crate::diff_stats::compute_delta(&before, &after).await;
            if added > 0 || removed > 0 { changes.push(Change { path, added, removed }); }
        }
        changes
    }
}

pub(super) async fn cancel(owner: &str) {
    let mut tracker = tracker().lock().await;
    tracker.pending.retain(|(o, _), _| o != owner);
    tracker.sessions.retain(|(o, _), _| o != owner);
    tracker.hook_calls.remove(owner);
    tracker.continuations.clear_owner(owner);
}

pub(super) async fn abandon(app: &AppHandle, owner: &str, id: &str) {
    let owner = context(app, owner, Some("/"), None).await.map(|c| c.0).unwrap_or_else(|| owner.to_string());
    let mut tracker = tracker().lock().await;
    if let Some(pending) = tracker.pending.get_mut(&(owner, id.to_string())) {
        pending.before.clear();
        pending.paths.clear();
        pending.wide = true;
        pending.ambiguous = true;
    }
}

/// Claude Code already reported this Bash command's own file diff, which
/// the Claude transcript scanner counts as native stats.
fn native_bash_diff(response: &Value) -> bool {
    crate::commands::threads::claude_bash_edit_diff(response).is_some()
}

fn yielded(value: &Value) -> bool {
    match value {
        Value::String(s) => {
            s.len() > MAX_BYTES || s.contains("Process running with session ID") || s.contains("Script running with cell ID")
                || serde_json::from_str::<Value>(s).ok().filter(|v| !v.is_string()).is_some_and(|v| yielded(&v))
        }
        Value::Array(items) => items.iter().any(yielded),
        Value::Object(fields) => {
            (fields.get("session_id").is_some_and(Value::is_number) && fields.get("exit_code").is_none_or(Value::is_null))
                || fields.get("sessionId").is_some_and(Value::is_number)
                || ["content", "output", "text"].iter().filter_map(|key| fields.get(*key)).any(yielded)
        }
        _ => false,
    }
}

fn str_field<'a>(v: &'a Value, names: &[&str]) -> Option<&'a str> {
    names.iter().find_map(|n| v.get(*n).and_then(Value::as_str)).filter(|s| !s.is_empty())
}

async fn context(app: &AppHandle, owner: &str, cwd: Option<&str>, session: Option<&str>) -> Option<(String, String, Option<String>)> {
    let state = app.try_state::<crate::AppState>()?;
    let mut rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, work_dir, sdk_session_id FROM threads WHERE id = ? OR sdk_session_id = ? ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 2"
    ).bind(owner).bind(owner).bind(owner).fetch_all(&state.db).await.ok()?;
    if rows.len() > 1 && rows[0].0 != owner { return None; }
    if !rows.is_empty() {
        let (id, dir, native) = rows.remove(0);
        let dir = cwd.map(|cwd| Path::new(&dir).join(cwd)).unwrap_or_else(|| PathBuf::from(dir));
        Some((id, dir.to_str()?.to_string(), session.map(str::to_string).or(native)))
    } else {
        if !Path::new(cwd?).is_absolute() { return None; }
        Some((owner.to_string(), cwd?.to_string(), session.map(str::to_string).or_else(|| Some(owner.to_string()))))
    }
}

fn native_targets(tool: &str, input: &Value) -> Option<Vec<String>> {
    match tool {
        "Edit" | "Write" | "MultiEdit" | "edit" | "write" | "search_replace" |
        "NotebookEdit" | "write_to_file" | "replace_file_content" | "multi_replace_file_content" |
        "fileChange" | "apply_patch" | "apply_patch_freeform" => {
            Some(str_field(input, &["file_path", "path", "notebook_path", "TargetFile", "filePath"])
                .map(|s| vec![s.to_string()]).unwrap_or_default())
        }
        _ => None,
    }
}

fn read_only(tool: &str) -> bool {
    matches!(tool, "Read" | "read" | "read_file" | "view_file" | "client_view_file" |
        "Glob" | "Grep" | "glob" | "grep" | "list_directory" | "list_dir" |
        "WebSearch" | "WebFetch" | "web_search" | "TodoWrite" | "update_plan")
}

async fn safe_targets(cwd: &Path, names: Vec<String>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for name in names.into_iter().take(32) {
        let path = if Path::new(&name).is_absolute() { PathBuf::from(name) } else { cwd.join(name) };
        // Do not follow symlinks, even inside the workspace. Resolve the parent
        // to reject traversal and symlink escapes for new files as well.
        let Some(parent) = path.parent() else { continue };
        let Ok(parent) = tokio::fs::canonicalize(parent).await else { continue };
        let Some(file) = path.file_name() else { continue };
        let path = parent.join(file);
        if !path.starts_with(cwd) || path.components().any(|c| {
            matches!(c.as_os_str().to_str(), Some(".git" | "node_modules" | ".agmux" | "target" | "__pycache__"))
        }) { continue; }
        let ignored = tokio::time::timeout(Duration::from_secs(1), tokio::process::Command::new("git")
            .arg("-C").arg(cwd).args(["check-ignore", "-q", "--"]).arg(&path).output()).await;
        if matches!(ignored, Ok(Ok(ref output)) if output.status.success()) { continue; }
        if !paths.contains(&path) { paths.push(path); }
    }
    paths
}

pub(super) async fn begin(app: &AppHandle, owner: &str, session: Option<&str>, cwd: &str, id: &str, tool: &str, input: &Value) {
    begin_observation(app, owner, session, cwd, id, tool, input, true).await;
}

pub(super) async fn begin_observation(app: &AppHandle, owner: &str, session: Option<&str>, cwd: &str, id: &str, tool: &str, input: &Value, snapshot: bool) {
    let tool = tool.strip_prefix("functions.").unwrap_or(tool);
    if owner.is_empty() || id.is_empty() || read_only(tool) { return; }
    // A completion must not publish while this new writer is still resolving
    // targets. Hold the same gate through identity lookup and snapshot capture.
    let mut tracker = tracker().lock().await;
    let Some((owner, cwd, session)) = context(app, owner, (!cwd.is_empty()).then_some(cwd), session).await else { return };
    if captured::active(session.as_deref().unwrap_or(&owner)) { return; }
    let waits = if tool == "exec" {
        input.as_str().and_then(targets::exec_waits).unwrap_or_default()
    } else if tool == "write_stdin" && str_field(input, &["chars"]).is_none() {
        input.get("session_id").and_then(Value::as_i64).map(|id| vec![(id, 0)]).unwrap_or_default()
    } else { Vec::new() };
    let related = tracker.continuations.link_wait(&owner, id, &waits);
    let expected = if tool == "exec" { input.as_str().and_then(targets::exec_result_count) }
        else if tool == "write_stdin" { Some(1) } else { None };
    if let Some(count) = expected { tracker.continuations.expect_results(&owner, id, count); }
    let cwd = str_field(input, &["workdir", "cwd", "working_directory"])
        .map(|dir| Path::new(&cwd).join(dir)).unwrap_or_else(|| PathBuf::from(cwd));
    let Ok(root) = tokio::fs::canonicalize(&cwd).await else { return };
    let (paths, shell) = if tool == "exec" {
        (exec_target_paths(&root, input).await, true)
    } else {
        let names = targets::shell_targets(tool, input);
        let shell = !names.is_empty();
        let names = if shell { names } else { native_targets(tool, input).unwrap_or_default() };
        (safe_targets(&root, names).await, shell)
    };
    // Unsupported tools remain wildcard writers until completion. This is
    // deliberately conservative for dynamic scripts and subagents.
    // Hints are not an exhaustive write set: a script may write other paths
    // indirectly. Any overlapping writer in this workspace makes shell
    // attribution ambiguous, even if their recognized targets differ.
    // A polling call continues the original command, rather than becoming a
    // competing writer. Extra commands in that wrapper get no new snapshots.
    tracker.begin_observed_related(&owner, id, &root, paths, snapshot && shell && related.is_empty(), &related).await;
    tracker.sessions.entry((owner, id.to_string())).or_insert(session);
}

pub(super) async fn complete_output(app: &AppHandle, owner: &str, id: &str, output: &Value) {
    let owner = context(app, owner, Some("/"), None).await.map(|c| c.0).unwrap_or_else(|| owner.to_string());
    let outcome = {
        let mut tracker = tracker().lock().await;
        if !tracker.pending.contains_key(&(owner.clone(), id.to_string())) { return; }
        tracker.continuations.output(&owner, id, output)
    };
    for completed in outcome.completed { finish(app, &owner, &completed).await; }
    if outcome.running { return; }
    if outcome.continued { finish(app, &owner, id).await; return; }
    if yielded(output) { abandon(app, &owner, id).await; }
    else { finish(app, &owner, id).await; }
}

async fn exec_target_paths(root: &Path, input: &Value) -> Vec<PathBuf> {
    let Some(commands) = input.as_str().and_then(targets::exec_commands) else { return Vec::new() };
    let mut paths = Vec::new();
    for command in commands {
        let cwd = str_field(&command, &["workdir"]).map(|cwd| root.join(cwd)).unwrap_or_else(|| root.to_path_buf());
        let Ok(cwd) = tokio::fs::canonicalize(cwd).await else { continue };
        if !cwd.starts_with(root) { continue; }
        for path in safe_targets(&cwd, targets::shell_targets("exec_command", &command)).await {
            if paths.len() >= 32 { return paths; }
            if !paths.contains(&path) { paths.push(path); }
        }
    }
    paths
}

pub(super) async fn finish(app: &AppHandle, owner: &str, id: &str) {
    // Owners without a DB row (native terminal sessions) are valid too.
    let resolved = context(app, owner, Some("/"), None).await.map(|c| c.0).unwrap_or_else(|| owner.to_string());
    let mut tracker = tracker().lock().await;
    let session = tracker.sessions.remove(&(resolved.clone(), id.to_string())).flatten();
    let changes = tracker.finish(&resolved, id).await;
    if captured::active(session.as_deref().unwrap_or(&resolved)) { return; }
    // Serialize completion + persistence with starts so a delayed duplicate
    // cannot publish a second count or steal a subsequent command's baseline.
    if let Some(state) = app.try_state::<crate::AppState>() {
        if let Err(e) = storage::record(app, &state.db, &resolved, session.as_deref(), id, &changes).await {
            tracing::warn!(error = %e, "shell diff persistence failed");
        }
    }
}

pub async fn observe_sdk(app: &AppHandle, owner: &str, event: &Value) {
    match str_field(event, &["type", "event"]) {
        Some("tool.started") => {
            let (Some(id), Some(tool)) = (str_field(event, &["toolUseId"]), str_field(event, &["name"])) else { return };
            if read_only(tool) { return; }
            let input = event.get("input").unwrap_or(&Value::Null);
            begin(app, owner, None, "", id, tool, input).await;
        }
        Some("tool.completed") => {
            if let Some(id) = str_field(event, &["toolUseId"]) {
                if yielded(event) { abandon(app, owner, id).await; }
                else if event.get("snapshotEligible").and_then(Value::as_bool) == Some(false) {
                    abandon(app, owner, id).await;
                    finish(app, owner, id).await;
                } else { finish(app, owner, id).await; }
            }
        }
        Some("turn.completed" | "session.ended" | "error") => {
            let owner = context(app, owner, Some("/"), None).await.map(|c| c.0).unwrap_or_else(|| owner.to_string());
            cancel(&owner).await;
        }
        _ => {}
    }
}

// Cline emits both its native tool_call/tool_result record and legacy nested
// preToolUse/postToolUse data. Normalize only these known envelopes; the hook
// transport and other providers' payloads remain untouched.
fn normalize_hook_payload(event: &str, payload: &Value) -> Option<Value> {
    let (record_key, legacy_key) = match event {
        "pre-tool-use" => ("tool_call", "preToolUse"),
        "post-tool-use" | "post-tool-use-failure" => ("tool_result", "postToolUse"),
        _ => return None,
    };
    let record = payload.get(record_key);
    let legacy = payload.get(legacy_key);
    if record.is_none() && legacy.is_none() { return None; }
    let roots = payload.get("workspaceRoots").and_then(Value::as_array);
    let cwd = payload.pointer("/workspaceInfo/rootPath").and_then(Value::as_str)
        .or_else(|| roots.filter(|roots| roots.len() == 1).and_then(|roots| roots[0].as_str()));
    Some(json!({
        "tool_use_id": record.and_then(|r| r.get("id")),
        "tool_name": record.and_then(|r| r.get("name")).or_else(|| legacy.and_then(|l| l.get("toolName"))),
        "tool_input": record.and_then(|r| r.get("input")).or_else(|| legacy.and_then(|l| l.get("parameters"))),
        "tool_response": record.and_then(|r| r.get("output")).or_else(|| legacy.and_then(|l| l.get("result"))),
        "session_id": payload.pointer("/sessionContext/rootSessionId").or_else(|| payload.get("taskId")),
        "cwd": cwd,
    }))
}

pub async fn observe_hook(app: &AppHandle, owner: &str, event: &str, payload: &Value) {
    let normalized = normalize_hook_payload(event, payload);
    let payload = normalized.as_ref().unwrap_or(payload);
    let id = str_field(payload, &["tool_use_id", "toolUseId", "tool_call_id", "toolCallId", "call_id"])
        .map(str::to_string)
        .or_else(|| payload.get("stepIdx").and_then(Value::as_u64).map(|s| format!("step:{s}")));
    match event {
        "pre-tool-use" => {
            let Some(tool) = str_field(payload, &["tool_name", "toolName"]) else { return };
            if read_only(tool) { return; }
            let input = payload.get("tool_input").or_else(|| payload.get("toolInput")).unwrap_or(&Value::Null);
            let cwd = str_field(payload, &["cwd"]);
            let session = str_field(payload, &["session_id", "sessionId", "conversationId"]);
            let id = if let Some(id) = id { id } else {
                // Some relays omit provider call IDs. Pair only an unambiguous
                // outstanding call; never fabricate identity from path alone.
                let id = format!("hook:{}", uuid::Uuid::new_v4());
                let mut tracker = tracker().lock().await;
                let calls = tracker.hook_calls.entry(owner.to_string()).or_default();
                if calls.len() >= MAX_PENDING { return; }
                calls.push((id.clone(), tool.to_string(), input.clone()));
                id
            };
            begin(app, owner, session, cwd.unwrap_or(""), &id, tool, input).await;
        }
        "post-tool-use" | "post-tool-use-failure" => {
            let response = payload.get("tool_response").or_else(|| payload.get("toolResponse")).unwrap_or(&Value::Null);
            let still_running = yielded(response);
            if let Some(id) = id {
                if still_running { abandon(app, owner, &id).await; }
                else {
                    if native_bash_diff(response) { abandon(app, owner, &id).await; }
                    finish(app, owner, &id).await;
                }
            }
            else if let Some(tool) = str_field(payload, &["tool_name", "toolName"]) {
                let resolved = context(app, owner, Some("/"), None).await.map(|c| c.0).unwrap_or_else(|| owner.to_string());
                let input = payload.get("tool_input").or_else(|| payload.get("toolInput"));
                let ids = {
                    let mut tracker = tracker().lock().await;
                    let calls = tracker.hook_calls.entry(owner.to_string()).or_default();
                    let ids: Vec<String> = calls.iter().filter(|(_, name, args)| name == tool && input.is_none_or(|input| input == args))
                        .map(|(id, _, _)| id.clone()).collect();
                    calls.retain(|(id, _, _)| !ids.contains(id));
                    if ids.len() > 1 {
                        for id in &ids {
                            tracker.pending.remove(&(resolved.clone(), id.clone()));
                            tracker.sessions.remove(&(resolved.clone(), id.clone()));
                        }
                        Vec::new()
                    } else { ids }
                };
                if let Some(id) = ids.first() {
                    if still_running { abandon(app, &resolved, id).await; }
                    else { finish(app, &resolved, id).await; }
                }
            }
        }
        "stop" | "session-end" => {
            let owner = context(app, owner, Some("/"), None).await.map(|c| c.0).unwrap_or_else(|| owner.to_string());
            cancel(&owner).await;
        }
        _ => {}
    }
}

pub async fn observe_codex(app: &AppHandle, cwd: &str, event: &Value) {
    if str_field(event, &["method"]) == Some("codex/serverDisconnected") {
        if let Ok(root) = tokio::fs::canonicalize(cwd).await {
            let mut tracker = tracker().lock().await;
            tracker.pending.retain(|_, p| !p.root.starts_with(&root));
            let live: std::collections::HashSet<_> = tracker.pending.keys().cloned().collect();
            tracker.sessions.retain(|key, _| live.contains(key));
        }
        return;
    }
    let params = event.get("params").unwrap_or(event);
    let Some(owner) = str_field(params, &["threadId", "thread_id"]) else { return };
    if matches!(str_field(event, &["method"]), Some("turn/completed" | "turn/failed" | "turn/aborted" | "server/disconnected")) {
        let owner = context(app, owner, Some(cwd), None).await.map(|c| c.0).unwrap_or_else(|| owner.to_string());
        cancel(&owner).await;
        return;
    }
    let item = params.get("item").unwrap_or(params);
    let raw = str_field(event, &["method"]) == Some("rawResponseItem/completed");
    let Some(id) = (if raw { str_field(item, &["call_id"]) } else { str_field(item, &["id", "call_id"]) }) else { return };
    // A raw response-item "completed" means the model finished producing the
    // call, not that the tool ran. Its separate *_output is the completion.
    if raw {
        match str_field(item, &["type"]) {
            Some("custom_tool_call" | "function_call") => {
                let tool = str_field(item, &["name"]).unwrap_or("");
                let input = if item["type"] == "function_call" {
                    item.get("arguments").and_then(Value::as_str).and_then(|s| serde_json::from_str(s).ok()).unwrap_or(Value::Null)
                } else { item.get("input").cloned().unwrap_or(Value::Null) };
                begin(app, owner, Some(owner), cwd, id, tool, &input).await;
            }
            Some("custom_tool_call_output" | "function_call_output") => {
                complete_output(app, owner, id, item.get("output").unwrap_or(&Value::Null)).await;
            }
            _ => {}
        }
        return;
    }
    match str_field(event, &["method"]) {
        Some("item/started") => {
            match str_field(item, &["type"]) {
                Some("commandExecution") => {
                    let input = json!({"command": item.get("command")});
                    begin(app, owner, Some(owner), str_field(item, &["cwd"]).unwrap_or(cwd), id, "exec_command", &input).await;
                }
                Some("fileChange") => begin(app, owner, Some(owner), cwd, id, "fileChange", item).await,
                Some("dynamicToolCall") => {
                    let tool = str_field(item, &["tool", "name"]).unwrap_or("");
                    let input = item.get("arguments").unwrap_or(&Value::Null);
                    begin(app, owner, Some(owner), cwd, id, tool, input).await;
                }
                Some("custom_tool_call" | "function_call") => {
                    let tool = str_field(item, &["name"]).unwrap_or("");
                    let input = if item["type"] == "function_call" {
                        item.get("arguments").and_then(Value::as_str).and_then(|s| serde_json::from_str(s).ok()).unwrap_or(Value::Null)
                    } else { item.get("input").cloned().unwrap_or(Value::Null) };
                    begin(app, owner, Some(owner), cwd, id, tool, &input).await;
                }
                _ => {}
            }
        }
        Some("item/completed") => {
            if yielded(item) { abandon(app, owner, id).await; }
            else { finish(app, owner, id).await; }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests;
