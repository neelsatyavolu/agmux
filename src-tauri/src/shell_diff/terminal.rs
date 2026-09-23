//! Live-only terminal transcript observation. Never replay history into snapshots.

use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use serde_json::Value;
use tauri::{AppHandle, Manager};

#[path = "terminal_opencode.rs"]
mod opencode;

const MAX_BATCH: u64 = 2 * 1024 * 1024;

struct Tail {
    offset: u64,
    identity: (u64, u64),
    partial: Vec<u8>,
    discard_partial: bool,
}

impl Tail {
    fn attach(path: &Path) -> std::io::Result<Self> {
        let mut file = std::fs::File::open(path)?;
        let meta = file.metadata()?;
        let mut last = [b'\n'];
        if meta.len() > 0 {
            file.seek(SeekFrom::End(-1))?;
            file.read_exact(&mut last)?;
        }
        Ok(Self {
            offset: meta.len(),
            identity: (meta.dev(), meta.ino()),
            partial: Vec::new(),
            discard_partial: last[0] != b'\n',
        })
    }

    // None means continuity was lost: cancel pending calls and attach at EOF.
    fn read_new(&mut self, path: &Path) -> std::io::Result<Option<Vec<String>>> {
        let mut file = std::fs::File::open(path)?;
        let meta = file.metadata()?;
        if (meta.dev(), meta.ino()) != self.identity || meta.len() < self.offset
            || meta.len().saturating_sub(self.offset) + self.partial.len() as u64 > MAX_BATCH
        {
            *self = Self::attach(path)?;
            return Ok(None);
        }
        let remaining = meta.len() - self.offset;
        file.seek(SeekFrom::Start(self.offset))?;
        let read = file.take(remaining).read_to_end(&mut self.partial)?;
        self.offset += read as u64;
        let mut records = Vec::new();
        let mut consumed = 0;
        for (index, byte) in self.partial.iter().enumerate() {
            if *byte != b'\n' { continue; }
            if self.discard_partial {
                self.discard_partial = false;
            } else if let Ok(line) = std::str::from_utf8(&self.partial[consumed..index]) {
                records.push(line.to_owned());
            }
            consumed = index + 1;
        }
        self.partial.drain(..consumed);
        Ok(Some(records))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Source {
    owner: String,
    pty_id: String,
    generation: usize,
    session: String,
    provider: String,
    cwd: String,
    path: PathBuf,
}

struct Watched {
    source: Source,
    tail: Tail,
    native_diffs: crate::codex::diff_stats::DiffObserver,
}

// Only exact bound sessions are eligible. Do not select "latest in cwd":
// another terminal, SDK, or subagent may be writing the same project.
fn find_codex(root: &Path, session: &str) -> Option<(PathBuf, String)> {
    let suffix = format!("-{session}.jsonl");
    let mut matches = walkdir::WalkDir::new(root).max_depth(5).into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file()
            && entry.file_name().to_string_lossy().ends_with(&suffix));
    let path = matches.next()?.into_path();
    if matches.next().is_some() { return None; }
    // Read identity/cwd only, never feed pre-existing tool history to begin().
    let file = std::fs::File::open(&path).ok()?;
    let mut header = String::new();
    use std::io::BufRead;
    std::io::BufReader::new(file.take(MAX_BATCH)).read_line(&mut header).ok()?;
    let value: Value = serde_json::from_str(&header).ok()?;
    if value["type"] != "session_meta" || value["payload"]["id"].as_str()? != session {
        return None;
    }
    let cwd = value["payload"]["cwd"].as_str()?.to_owned();
    if !Path::new(&cwd).is_absolute() { return None; }
    Some((path, cwd))
}

fn find_claude(root: &Path, session: &str) -> Option<(PathBuf, String)> {
    let filename = format!("{session}.jsonl");
    let mut matches = walkdir::WalkDir::new(root).max_depth(2).into_iter()
        .filter_map(Result::ok).filter(|entry| entry.file_type().is_file()
            && entry.file_name().to_string_lossy() == filename);
    let path = matches.next()?.into_path();
    if matches.next().is_some() { return None; }
    use std::io::BufRead;
    let file = std::fs::File::open(&path).ok()?;
    for line in std::io::BufReader::new(file.take(MAX_BATCH)).lines().take(64).map_while(Result::ok) {
        let Ok(record) = serde_json::from_str::<Value>(&line) else { continue };
        if record["sessionId"].as_str() != Some(session) { continue; }
        if let Some(cwd) = record["cwd"].as_str().filter(|cwd| Path::new(cwd).is_absolute()) {
            return Some((path, cwd.to_owned()));
        }
    }
    None
}

fn find_kimi(session: &str, cwd: &str) -> Option<(PathBuf, String)> {
    let dir = crate::process::kimi_session::find_kimi_session_dir(session)?;
    validate_kimi_dir(&dir, session, cwd)
}

fn validate_kimi_dir(dir: &Path, session: &str, cwd: &str) -> Option<(PathBuf, String)> {
    // The existing usage reader falls back to another agent. Attribution must
    // not: only this exact bound session's main-agent wire file is eligible.
    if dir.file_name()?.to_str()? != session { return None; }
    let dir = std::fs::canonicalize(dir).ok()?;
    if dir.file_name()?.to_str()? != session { return None; }
    let mut state = String::new();
    std::fs::File::open(dir.join("state.json")).ok()?.take(MAX_BATCH)
        .read_to_string(&mut state).ok()?;
    let state: Value = serde_json::from_str(&state).ok()?;
    let recorded_cwd = state["workDir"].as_str()?;
    if std::fs::canonicalize(recorded_cwd).ok()? != std::fs::canonicalize(cwd).ok()? { return None; }
    let path = dir.join("agents/main/wire.jsonl");
    if std::fs::canonicalize(&path).ok()? != path { return None; }
    Some((path, cwd.to_owned()))
}

async fn sources(app: &AppHandle, known: &[Source]) -> Vec<Source> {
    let state = app.state::<crate::state::AppState>();
    let active: Vec<(String, String, usize)> = state.sessions.lock().await.values()
        .filter(|session| !session.is_shutting_down.load(std::sync::atomic::Ordering::SeqCst))
        .map(|session| (session.thread_id.clone(), session.provider.clone(), std::sync::Arc::as_ptr(&session.is_shutting_down) as usize)).collect();
    let mut result = Vec::new();
    for (id, provider, generation) in active {
        if !matches!(provider.as_str(), "Codex" | "ClaudeCode" | "Droid" | "OpenCode" | "Kimi") { continue; }
        let Ok(rows) = sqlx::query_as::<_, (String, String, Option<String>)>(
            "SELECT id, work_dir, sdk_session_id FROM threads WHERE (id = ? OR sdk_session_id = ?) AND provider = ? AND is_archived = 0"
        ).bind(&id).bind(&id).bind(&provider).fetch_all(&state.db).await else { continue };
        if rows.len() > 1 { continue; }
        let thread = rows.into_iter().next();
        let owner = thread.as_ref().map(|t| t.0.clone()).unwrap_or_else(|| id.clone());
        let session = if matches!(provider.as_str(), "Codex" | "ClaudeCode") {
            thread.as_ref().and_then(|t| t.2.clone()).unwrap_or_else(|| id.clone())
        } else if provider == "OpenCode" {
            let Some(home) = crate::paths::agmux_home_opt() else { continue };
            let Some(sid) = crate::hooks::read_opencode_session_id(&home.join("threads").join(&id)) else { continue };
            sid
        } else if provider == "Kimi" {
            let Some(home) = crate::paths::agmux_home_opt() else { continue };
            let Some(sid) = crate::process::kimi_session::read_kimi_session_id(&home.join("threads").join(&id)) else { continue };
            sid
        } else {
            let Some(home) = crate::paths::agmux_home_opt() else { continue };
            let Some(sid) = crate::process::droid_model::read_droid_session_id(&home.join("threads").join(&id)) else { continue };
            sid
        };
        let uuid_part = if provider == "Kimi" { session.strip_prefix("session_").unwrap_or(&session) } else { &session };
        if provider != "OpenCode" && uuid::Uuid::parse_str(uuid_part).is_err() { continue; }
        if let Some(source) = known.iter().find(|source| source.pty_id == id
            && source.generation == generation && source.session == session && source.owner == owner)
        {
            // Validated once at attach; Tail detects replacement/truncation and
            // removes the cache entry before any records from a new file run.
            result.push(source.clone());
            continue;
        }
        let provider_clone = provider.clone();
        let sid = session.clone();
        let work_dir = thread.map(|t| t.1);
        let resolved = tokio::task::spawn_blocking(move || {
            let home = dirs::home_dir()?;
            if provider_clone == "Codex" {
                find_codex(&crate::codex::cli_config::codex_home()?.join("sessions"), &sid)
            } else if provider_clone == "ClaudeCode" {
                find_claude(&home.join(".claude/projects"), &sid)
            } else if provider_clone == "OpenCode" {
                let cwd = work_dir?;
                let path = crate::process::opencode_session::opencode_db_path()?;
                Some((path, cwd))
            } else if provider_clone == "Kimi" {
                find_kimi(&sid, &work_dir?)
            } else {
                let cwd = work_dir?;
                let path = home.join(".factory/sessions")
                    .join(cwd.replace('/', "-")).join(format!("{sid}.jsonl"));
                if !path.is_file() || !Path::new(&cwd).is_absolute() { return None; }
                Some((path, cwd))
            }
        }).await.ok().flatten();
        if let Some((path, cwd)) = resolved {
            result.push(Source { owner, pty_id: id, generation, session, provider, cwd, path });
        }
    }
    result
}

#[derive(Debug)]
enum Observation {
    Begin { id: String, tool: String, input: Value },
    LateBegin { id: String, tool: String, input: Value },
    Finish(String),
    Result(String, Value),
    Abandon(String),
    Cancel,
    Cwd(String),
}

fn observations(provider: &str, record: &Value) -> Vec<Observation> {
    let mut result = Vec::new();
    if provider == "Codex" {
        let payload = &record["payload"];
        if record["type"] == "turn_context" {
            if let Some(cwd) = payload["cwd"].as_str().filter(|cwd| Path::new(cwd).is_absolute()) {
                result.push(Observation::Cwd(cwd.to_owned()));
            }
        } else if record["type"] == "response_item" {
            let id = payload["call_id"].as_str().unwrap_or("");
            if id.is_empty() { return result; }
            match payload["type"].as_str() {
                Some("function_call") => {
                    if let (Some(tool), Some(args)) = (payload["name"].as_str(), payload["arguments"].as_str()) {
                        if let Ok(input) = serde_json::from_str(args) {
                            result.push(Observation::Begin { id: id.to_owned(), tool: tool.to_owned(), input });
                        }
                    }
                }
                Some("custom_tool_call") => {
                    if let Some(tool) = payload["name"].as_str() {
                        // Keep code-mode exec opaque: source text is not evidence
                        // that a nested shell call was actually executed.
                        result.push(Observation::Begin { id: id.to_owned(), tool: tool.to_owned(), input: payload["input"].clone() });
                    }
                }
                Some("function_call_output" | "custom_tool_call_output") => {
                    result.push(Observation::Result(id.to_owned(), payload["output"].clone()));
                }
                _ => {}
            }
        } else if record["type"] == "event_msg"
            && matches!(payload["type"].as_str(), Some("task_complete" | "turn_aborted"))
        {
            result.push(Observation::Cancel);
        }
    } else if provider == "Kimi" {
        // Installed Kimi agent-core records appendLoopEvent before execution:
        // tool.call has final parsed args; tool.call.delta is only streaming.
        if record["type"] == "context.append_loop_event" {
            let event = &record["event"];
            let Some(id) = event["toolCallId"].as_str().filter(|id| !id.is_empty()) else { return result };
            match event["type"].as_str() {
                Some("tool.call") => {
                    if let Some(tool) = event["name"].as_str().filter(|tool| !tool.is_empty()) {
                        result.push(Observation::Begin { id: id.to_owned(), tool: tool.to_owned(), input: event["args"].clone() });
                    }
                }
                Some("tool.result") => {
                    if super::yielded(&event["result"]) {
                        result.push(Observation::Abandon(id.to_owned()));
                    } else {
                        result.push(Observation::Finish(id.to_owned()));
                    }
                }
                _ => {}
            }
        } else if record["type"] == "turn.ended" {
            result.push(Observation::Cancel);
        }
    } else if matches!(provider, "Droid" | "ClaudeCode") {
        if let Some(cwd) = record["cwd"].as_str().filter(|cwd| Path::new(cwd).is_absolute()) {
            result.push(Observation::Cwd(cwd.to_owned()));
        }
        if let Some(blocks) = record["message"]["content"].as_array() {
            for block in blocks {
                match block["type"].as_str() {
                    Some("tool_use") => {
                        if let (Some(id), Some(tool)) = (block["id"].as_str(), block["name"].as_str()) {
                            let tool = if provider == "Droid" && tool == "Execute" { "execute_command" } else { tool };
                            result.push(Observation::Begin { id: id.to_owned(), tool: tool.to_owned(), input: block["input"].clone() });
                        }
                    }
                    Some("tool_result") => {
                        if let Some(id) = block["tool_use_id"].as_str() {
                            // Claude's own Bash diff is counted natively; a snapshot would double it.
                            if provider == "ClaudeCode" && super::native_bash_diff(&record["toolUseResult"]) {
                                result.push(Observation::Abandon(id.to_owned()));
                            }
                            result.push(Observation::Finish(id.to_owned()));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    result
}

fn live_observations(provider: &str, records: &[String]) -> Vec<Observation> {
    let events: Vec<_> = records.iter().filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .flat_map(|record| observations(provider, &record)).collect();
    let completed: std::collections::HashSet<_> = events.iter().filter_map(|event| {
        match event {
            Observation::Finish(id) => Some(id.clone()),
            Observation::Result(id, output) if !super::yielded(output) => Some(id.clone()),
            _ => None,
        }
    }).collect();
    events.into_iter().map(|event| match event {
        Observation::Begin { id, tool, input } if completed.contains(&id) && !super::read_only(&tool) => {
            Observation::LateBegin { id, tool, input }
        }
        event => event,
    }).collect()
}

fn native_capture_completion(session: &str, record: &Value) -> bool {
    let payload = &record["payload"];
    if record["type"] == "event_msg" && payload["type"] == "patch_apply_end" {
        return payload["thread_id"].as_str().is_none_or(|id| id == session)
            && payload["call_id"].as_str().is_some_and(|id| !id.is_empty())
            && payload["success"].is_boolean();
    }
    record["type"] == "event_msg" && payload["type"] == "item_completed"
        && payload["thread_id"].as_str() == Some(session)
        && matches!(payload["item"]["type"].as_str(), Some("CommandExecution" | "FileChange"))
        && payload["item"]["id"].as_str().is_some_and(|id| !id.is_empty())
        && matches!(payload["item"]["status"].as_str(), Some("completed" | "failed"))
}

async fn observe_batch(app: &AppHandle, source: &mut Source, records: Vec<String>, native_diffs: &mut crate::codex::diff_stats::DiffObserver) {
    if source.provider == "Codex" {
        let mut changed = false;
        let mut capture_completed = false;
        for record in records.iter().filter_map(|line| serde_json::from_str::<Value>(line).ok()) {
            changed |= native_diffs.observe_record(&source.session, &record);
            capture_completed |= native_capture_completion(&source.session, &record);
        }
        // Wake only: the Python reconciler owns receipt/guard validation and
        // must also be able to retire expired guards without reconstructing counts.
        if capture_completed { super::captured::wake_recovery(); }
        if changed { crate::codex::diff_stats::refresh(app, &source.session); }
    }
    for observation in live_observations(&source.provider, &records) {
        match observation {
            Observation::Begin { id, tool, input } => {
                // Every tool start participates in the core collision guard,
                // including native edits and tools with no shell targets.
                // A start already completed in this read is only a wildcard
                // collision observation, never a retrospective file snapshot.
                super::begin(app, &source.owner, Some(&source.session), &source.cwd, &id, &tool, &input).await;
            }
            Observation::LateBegin { id, tool, input } => {
                // Keep continuation identity even when a fast poll and its
                // result arrive together. Only new before-images are forbidden.
                super::begin_observation(app, &source.owner, Some(&source.session), &source.cwd, &id, &tool, &input, false).await;
            }
            Observation::Finish(id) => super::finish(app, &source.owner, &id).await,
            Observation::Result(id, output) => super::complete_output(app, &source.owner, &id, &output).await,
            Observation::Abandon(id) => super::abandon(app, &source.owner, &id).await,
            Observation::Cancel => super::cancel(&source.owner).await,
            Observation::Cwd(cwd) => source.cwd = cwd,
        }
    }
}

pub(crate) fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut watched: HashMap<String, Watched> = HashMap::new();
        let mut open_code: HashMap<String, opencode::Watch> = HashMap::new();
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(250));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut discovery_tick = 0;
        loop {
            if watched.is_empty() && open_code.is_empty() {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                discovery_tick = 0;
            } else {
                tick.tick().await;
            }
            if discovery_tick == 0 {
                let known: Vec<_> = watched.values().map(|entry| entry.source.clone())
                    .chain(open_code.values().map(|entry| entry.source.clone())).collect();
                let current = sources(&app, &known).await;
                let removed: Vec<_> = watched.iter().filter(|(owner, existing)| {
                    !current.iter().any(|s| s.owner == **owner
                        && s.session == existing.source.session && s.path == existing.source.path
                        && s.generation == existing.source.generation)
                }).map(|(owner, _)| owner.clone()).collect();
                for owner in removed {
                    watched.remove(&owner);
                    super::cancel(&owner).await;
                }
                let removed: Vec<_> = open_code.iter().filter(|(_, existing)| {
                    !current.iter().any(|s| s == &existing.source)
                }).map(|(owner, _)| owner.clone()).collect();
                for owner in removed {
                    open_code.remove(&owner);
                    super::cancel(&owner).await;
                }
                for source in current {
                    if source.provider == "OpenCode" {
                        if !open_code.contains_key(&source.owner) {
                            if let Some(watch) = opencode::Watch::attach(&app, source.clone()).await {
                                open_code.insert(source.owner.clone(), watch);
                            }
                        }
                        continue;
                    }
                    if watched.contains_key(&source.owner) { continue; }
                    let path = source.path.clone();
                    if let Ok(Ok(tail)) = tokio::task::spawn_blocking(move || Tail::attach(&path)).await {
                        if source.provider == "Codex" {
                            // Native patch history is safe to restore at attach;
                            // only shell before-images must skip existing history.
                            crate::codex::diff_stats::refresh(&app, &source.session);
                        }
                        watched.insert(source.owner.clone(), Watched { source, tail, native_diffs: Default::default() });
                    }
                }
            }
            discovery_tick = (discovery_tick + 1) % 20;
            if discovery_tick % 4 == 0 {
                for owner in open_code.keys().cloned().collect::<Vec<_>>() {
                    let Some(mut watch) = open_code.remove(&owner) else { continue };
                    if is_active(&app, &watch.source).await && watch.poll(&app).await {
                        open_code.insert(owner, watch);
                    } else {
                        super::cancel(&owner).await;
                    }
                }
            }
            for owner in watched.keys().cloned().collect::<Vec<_>>() {
                let Some(mut entry) = watched.remove(&owner) else { continue };
                if !is_active(&app, &entry.source).await { super::cancel(&owner).await; continue; }
                let path = entry.source.path.clone();
                let mut tail = entry.tail;
                let Ok((returned, records)) = tokio::task::spawn_blocking(move || {
                    let records = tail.read_new(&path);
                    (tail, records)
                }).await else { super::cancel(&owner).await; continue };
                entry.tail = returned;
                match records {
                    Ok(Some(records)) => observe_batch(&app, &mut entry.source, records, &mut entry.native_diffs).await,
                    _ => { super::cancel(&owner).await; continue; }
                }
                watched.insert(owner, entry);
            }
        }
    });
}

async fn is_active(app: &AppHandle, source: &Source) -> bool {
    let state = app.state::<crate::state::AppState>();
    let sessions = state.sessions.lock().await;
    sessions.get(&source.pty_id).is_some_and(|session| {
        !session.is_shutting_down.load(std::sync::atomic::Ordering::SeqCst)
            && std::sync::Arc::as_ptr(&session.is_shutting_down) as usize == source.generation
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn native_capture_completion_wakes_only_for_exact_session_finished_commands() {
        let receipt = serde_json::json!({"type":"event_msg", "payload":{
            "type":"item_completed", "thread_id":"native-session", "item":{
                "type":"CommandExecution", "id":"exec-inner", "status":"completed", "exit_code":0
            }
        }});
        assert!(native_capture_completion("native-session", &receipt));
        assert!(!native_capture_completion("different-session", &receipt));
        let mut failed = receipt.clone();
        failed["payload"]["item"]["status"] = serde_json::json!("failed");
        assert!(native_capture_completion("native-session", &failed));
        let mut patch = receipt.clone();
        patch["payload"]["item"]["type"] = serde_json::json!("FileChange");
        assert!(native_capture_completion("native-session", &patch));
        let legacy_patch = serde_json::json!({"type":"event_msg", "payload":{
            "type":"patch_apply_end", "call_id":"exec-patch", "success":true,
        }});
        assert!(native_capture_completion("native-session", &legacy_patch));
        for (pointer, value) in [
            ("/type", "response_item"), ("/payload/type", "item_started"),
            ("/payload/type", "task_complete"), ("/payload/thread_id", ""),
            ("/payload/item/type", "Reasoning"), ("/payload/item/status", "in_progress"),
            ("/payload/item/status", "declined"), ("/payload/item/id", ""),
        ] {
            let mut invalid = receipt.clone();
            *invalid.pointer_mut(pointer).unwrap() = serde_json::json!(value);
            assert!(!native_capture_completion("native-session", &invalid), "{pointer}: {value}");
        }
        assert!(!native_capture_completion("native-session", &serde_json::json!({})));
    }

    #[test]
    fn kimi_wire_uses_final_call_args_and_exact_result_id() {
        let start = serde_json::json!({"type":"context.append_loop_event","event":{
            "type":"tool.call", "toolCallId":"kimi-call-1", "name":"Bash", "args":{"command":"echo hi > file"}, "stepUuid":"step1"
        }});
        assert!(matches!(&observations("Kimi", &start)[0], Observation::Begin { id, tool, input }
            if id == "kimi-call-1" && tool == "Bash" && input["command"] == "echo hi > file"));
        let end = serde_json::json!({"type":"context.append_loop_event","event":{
            "type":"tool.result", "toolCallId":"kimi-call-1", "result":{"output":"done","isError":false}
        }});
        assert!(matches!(&observations("Kimi", &end)[0], Observation::Finish(id) if id == "kimi-call-1"));
        assert!(matches!(&live_observations("Kimi", &[start.to_string(),end.to_string()])[0],
            Observation::LateBegin { .. }));
        for kind in ["tool.call.delta", "content.part", "step.end"] {
            assert!(observations("Kimi", &serde_json::json!({"type":"context.append_loop_event","event":{"type":kind,"toolCallId":"kimi-call-1"}})).is_empty());
        }
    }

    #[test]
    fn completed_batch_is_collision_only_and_exec_source_stays_opaque() {
        let start = serde_json::json!({"type":"response_item", "payload": {
            "type":"function_call", "call_id":"c1", "name":"exec_command",
            "arguments":"{\"cmd\":\"echo hi > file\"}"
        }}).to_string();
        let end = serde_json::json!({"type":"response_item", "payload": {
            "type":"function_call_output", "call_id":"c1", "output":"Process exited with code 0"
        }}).to_string();
        assert!(matches!(&live_observations("Codex", &[start.clone()])[0],
            Observation::Begin { id, tool, .. } if id == "c1" && tool == "exec_command"));
        assert!(matches!(&live_observations("Codex", &[start, end])[0],
            Observation::LateBegin { .. }));
        let wrapped = serde_json::json!({"type":"response_item", "payload": {
            "type":"custom_tool_call", "call_id":"w1", "name":"exec", "input":"text(await tools.exec_command({cmd:'echo hi > file'}))"
        }});
        assert!(matches!(&observations("Codex", &wrapped)[0],
            Observation::Begin { tool, input, .. } if tool == "exec" && input.is_string()));
    }

    #[test]
    fn droid_and_claude_keep_native_call_ids_and_real_tool_inputs() {
        let start = serde_json::json!({"message":{"content":[
            {"type":"tool_use","id":"shell1","name":"Execute","input":{"command":"echo hi > file"}},
            {"type":"tool_use","id":"edit1","name":"Edit","input":{"file_path":"file"}}
        ]}});
        let events = observations("Droid", &start);
        assert!(matches!(&events[0], Observation::Begin { id, tool, input }
            if id == "shell1" && tool == "execute_command" && input["command"] == "echo hi > file"));
        assert!(matches!(&events[1], Observation::Begin { id, tool, .. } if id == "edit1" && tool == "Edit"));
        let end = serde_json::json!({"message":{"content":[{"type":"tool_result","tool_use_id":"shell1","is_error":true}]}});
        // A failed shell may have made real edits; core measures actual bytes.
        assert!(matches!(&observations("ClaudeCode", &end)[0], Observation::Finish(id) if id == "shell1"));
    }

    #[test]
    fn claude_native_bash_diff_drops_the_shell_snapshot_unless_shared() {
        let result = |diff: Value| serde_json::json!({"type":"user",
            "message":{"content":[{"type":"tool_result","tool_use_id":"shell1"}]},
            "toolUseResult":{"stdout":"","bashEditDiff":diff}});
        let own = observations("ClaudeCode", &result(serde_json::json!({"files":[],"moreFiles":0})));
        assert!(matches!(&own[..], [Observation::Abandon(a), Observation::Finish(f)] if a == "shell1" && f == "shell1"));
        let shared = observations("ClaudeCode", &result(serde_json::json!({"files":[],"moreFiles":0,"shared":true})));
        assert!(matches!(&shared[..], [Observation::Finish(id)] if id == "shell1"));
    }

    #[test]
    fn yielded_codex_output_does_not_finish_the_command() {
        let record = serde_json::json!({"type":"response_item","payload":{
            "type":"function_call_output","call_id":"c1","output":"Process running with session ID 42"
        }});
        assert!(matches!(&observations("Codex", &record)[0], Observation::Result(id, _) if id == "c1"));
        let structured = serde_json::json!({"type":"response_item","payload":{
            "type":"function_call_output","call_id":"c2","output":{"session_id":42,"exit_code":null}
        }});
        assert!(matches!(&observations("Codex", &structured)[0], Observation::Result(id, output) if id == "c2" && super::super::yielded(output)));
    }

    #[test]
    fn attachment_skips_history_and_initial_partial_record() {
        let path = std::env::temp_dir().join(format!("agmux-tail-{}-partial", std::process::id()));
        std::fs::write(&path, b"old\npartial").unwrap();
        let mut tail = Tail::attach(&path).unwrap();
        std::fs::OpenOptions::new().append(true).open(&path).unwrap()
            .write_all(b" remainder\nnew\nunfinished").unwrap();
        assert_eq!(tail.read_new(&path).unwrap().unwrap(), ["new"]);
        std::fs::OpenOptions::new().append(true).open(&path).unwrap()
            .write_all(b" end\n").unwrap();
        assert_eq!(tail.read_new(&path).unwrap().unwrap(), ["unfinished end"]);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn truncation_and_replacement_drop_new_baseline_history() {
        let path = std::env::temp_dir().join(format!("agmux-tail-{}-reset", std::process::id()));
        std::fs::write(&path, b"old history\n").unwrap();
        let mut tail = Tail::attach(&path).unwrap();
        std::fs::write(&path, b"reset\n").unwrap();
        assert!(tail.read_new(&path).unwrap().is_none());
        let replacement = path.with_extension("replacement");
        std::fs::write(&replacement, b"replacement history\n").unwrap();
        std::fs::rename(replacement, &path).unwrap();
        assert!(tail.read_new(&path).unwrap().is_none());
        assert!(tail.read_new(&path).unwrap().unwrap().is_empty());
        std::fs::remove_file(path).unwrap();
    }
}
