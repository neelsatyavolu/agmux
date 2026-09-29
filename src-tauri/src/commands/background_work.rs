//! Whether a session still has work running after its turn ended.
//!
//! Hidden sessions are killed after a grace period to free memory (the
//! offload timers in `src/components/thread/terminalOffload.ts` and
//! `grokSessionOffload.ts`). An agent can finish its turn while background
//! work keeps going — a Claude background agent, workflow or shell command,
//! or a Grok background command — and killing the process kills that work.
//! The timers ask `session_has_background_work` before they stop anything.

use std::collections::{HashMap, HashSet};
use std::io::BufRead;
use std::path::PathBuf;

use tauri::State;

use crate::db::queries;
use crate::state::AppState;

/// Live activity of a Claude chat (SDK) session, folded from sidecar events.
#[derive(Default)]
pub(crate) struct SdkActivity {
    turn_open: bool,
    background_tasks: usize,
    open_requests: HashSet<String>,
}

impl SdkActivity {
    /// Returns the previous state, for `submit_rejected`.
    pub(crate) fn submitted(&mut self) -> bool {
        std::mem::replace(&mut self.turn_open, true)
    }

    /// The bridge refused the message outright (no session, busy), so no
    /// turn started from it.
    pub(crate) fn submit_rejected(&mut self, previous: bool) {
        self.turn_open = previous;
    }

    pub(crate) fn request_resolved(&mut self, request_id: &str) {
        self.open_requests.remove(request_id);
    }

    pub(crate) fn observe(&mut self, event: &serde_json::Value) {
        let top_level = event["parentToolUseId"].is_null();
        match event["event"].as_str().unwrap_or("") {
            // A finished background task starts a new turn with no sendMessage.
            "content.delta" | "tool.started" if top_level => self.turn_open = true,
            "turn.completed" if top_level => {
                self.turn_open = false;
                self.open_requests.clear();
            }
            "tasks.background" => {
                self.background_tasks = event["count"].as_u64().unwrap_or(0) as usize;
            }
            "approval.requested" | "userInput.requested" => {
                if let Some(id) = event["requestId"].as_str() {
                    self.open_requests.insert(id.to_string());
                }
            }
            // A new Claude process: the task level is per process and the
            // old one's tasks and questions died with it. The turn that
            // started it is still open.
            "session.started" => {
                self.background_tasks = 0;
                self.open_requests.clear();
            }
            // The Claude process is gone; nothing it ran is still alive.
            "session.ended" | "query.ended" => *self = Self::default(),
            "status" if event["status"] == "stream_ended" => *self = Self::default(),
            _ => {}
        }
    }

    pub(crate) fn busy(&self) -> bool {
        self.turn_open || self.background_tasks > 0 || !self.open_requests.is_empty()
    }
}

#[derive(Debug, PartialEq)]
pub(crate) struct ProcRow {
    pid: u32,
    ppid: u32,
    command: String,
}

/// Parse `ps -axo pid=,ppid=,command=` output.
pub(crate) fn parse_ps(text: &str) -> Vec<ProcRow> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.trim_start().splitn(2, char::is_whitespace);
            let pid = fields.next()?.parse().ok()?;
            let rest = fields.next()?.trim_start();
            let mut rest = rest.splitn(2, char::is_whitespace);
            let ppid = rest.next()?.parse().ok()?;
            let command = rest.next().unwrap_or("").trim().to_string();
            Some(ProcRow { pid, ppid, command })
        })
        .collect()
}

/// `root` and every process below it.
pub(crate) fn process_tree(rows: &[ProcRow], root: u32) -> Vec<&ProcRow> {
    let mut children: HashMap<u32, Vec<&ProcRow>> = HashMap::new();
    for row in rows {
        children.entry(row.ppid).or_default().push(row);
    }
    let mut tree: Vec<&ProcRow> = rows.iter().filter(|row| row.pid == root).collect();
    let mut seen = HashSet::from([root]);
    let mut next = vec![root];
    while let Some(pid) = next.pop() {
        for child in children.get(&pid).into_iter().flatten() {
            if seen.insert(child.pid) {
                tree.push(child);
                next.push(child.pid);
            }
        }
    }
    tree
}

fn list_processes() -> Vec<ProcRow> {
    std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,command="])
        .env("LC_ALL", "C")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| parse_ps(&String::from_utf8_lossy(&out.stdout)))
        .unwrap_or_default()
}

/// Claude Code writes `{config dir}/sessions/{pid}.json` for each running
/// process. Its `status` is "busy" mid-turn and while a background agent,
/// workflow or teammate is live, "waiting" when a dialog needs the user, and
/// "idle" otherwise. Background shell commands are not counted there.
pub(crate) fn claude_status_is_busy(json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|value| value["status"].as_str().map(|status| status != "idle"))
        .unwrap_or(false)
}

/// Claude Code runs every Bash command, background ones included, through a
/// shell that sources its snapshot file. MCP servers are started directly.
pub(crate) fn is_claude_shell_command(command: &str) -> bool {
    command.contains("/shell-snapshots/snapshot-")
}

/// Config dirs a Claude process may use: the native one and each managed
/// account profile (`CLAUDE_CONFIG_DIR` points at the profile home).
fn claude_session_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(home) = crate::provider_accounts::claude::native_global_home() {
        dirs.push(home.join("sessions"));
    }
    if let Ok(entries) = crate::provider_accounts::storage::root().and_then(|root| {
        std::fs::read_dir(root).map_err(|e| e.to_string())
    }) {
        dirs.extend(entries.flatten().map(|entry| entry.path().join("sessions")));
    }
    dirs
}

fn claude_tree_is_busy(root: u32) -> bool {
    let rows = list_processes();
    let tree = process_tree(&rows, root);
    let dirs = claude_session_dirs();
    tree.iter().any(|row| {
        is_claude_shell_command(&row.command)
            || dirs.iter().any(|dir| {
                std::fs::read_to_string(dir.join(format!("{}.json", row.pid)))
                    .is_ok_and(|json| claude_status_is_busy(&json))
            })
    })
}

/// Grok writes a `background_tasks` session update listing every background
/// command each time one starts or ends. The latest one is the live set.
pub(crate) fn grok_background_running(reader: impl BufRead) -> bool {
    let mut running = false;
    for line in reader.lines().map_while(Result::ok) {
        if !line.contains("\"background_tasks\"") {
            continue;
        }
        let Ok(row) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let update = &row["params"]["update"];
        if update["sessionUpdate"] != "background_tasks" {
            continue;
        }
        running = update["tasks"]
            .as_array()
            .is_some_and(|tasks| tasks.iter().any(|task| task["status"] == "running"));
    }
    running
}

fn grok_updates_path(thread: &crate::db::models::Thread) -> Option<PathBuf> {
    let read_id = |path: PathBuf| std::fs::read_to_string(path).ok().map(|id| id.trim().to_string());
    let session_id = thread
        .sdk_session_id
        .clone()
        .or_else(|| read_id(PathBuf::from(&thread.state_dir).join("grok-session-id.txt")))
        .or_else(|| {
            read_id(crate::paths::agmux_home().join("threads").join(&thread.id).join("grok-session-id.txt"))
        })
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())?;
    let home = dirs::home_dir()?;
    Some(
        crate::commands::threads::grok_sessions_dir_for_repo(&home, &thread.work_dir)
            .join(session_id)
            .join("updates.jsonl"),
    )
}

fn grok_thread_is_busy(thread: &crate::db::models::Thread) -> bool {
    grok_updates_path(thread)
        .and_then(|path| std::fs::File::open(path).ok())
        .is_some_and(|file| grok_background_running(std::io::BufReader::new(file)))
}

/// True when stopping this session now would kill work it is still doing.
#[tauri::command]
pub async fn session_has_background_work(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<bool, String> {
    let sdk = state.sdk_sessions.lock().await.get(&thread_id).cloned();
    if let Some(ctx) = sdk {
        if ctx.has_live_work().await {
            return Ok(true);
        }
    }

    let pty_child = state.sessions.lock().await.get(&thread_id).map(|s| s.child.clone());
    let pty_pid = match pty_child {
        Some(child) => {
            let mut child = child.lock().await;
            match child.try_wait() {
                Ok(None) => child.process_id(),
                _ => None,
            }
        }
        None => None,
    };
    // Grok's log outlives its process: a run killed mid-command leaves a
    // "running" entry behind. Only trust it while a Grok process is up.
    let grok_live = pty_pid.is_some() || state.grok_servers.lock().await.get(&thread_id).is_some();
    let grok_thread = if grok_live {
        queries::get_thread(&state.db, &thread_id).await.ok().filter(|t| t.provider == "Grok")
    } else {
        None
    };

    tokio::task::spawn_blocking(move || {
        pty_pid.is_some_and(claude_tree_is_busy) || grok_thread.as_ref().is_some_and(grok_thread_is_busy)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sdk_turn_stays_busy_until_top_level_completion() {
        let mut activity = SdkActivity::default();
        assert!(!activity.busy());
        activity.submitted();
        assert!(activity.busy());
        activity.observe(&json!({"event": "turn.completed", "parentToolUseId": "toolu_sub"}));
        assert!(activity.busy(), "a subagent result must not end the parent turn");
        activity.observe(&json!({"event": "turn.completed", "parentToolUseId": null}));
        assert!(!activity.busy());
    }

    #[test]
    fn sdk_background_tasks_keep_session_busy_after_turn() {
        let mut activity = SdkActivity::default();
        activity.submitted();
        activity.observe(&json!({"event": "tasks.background", "count": 1}));
        activity.observe(&json!({"event": "turn.completed"}));
        assert!(activity.busy());
        activity.observe(&json!({"event": "tasks.background", "count": 0}));
        assert!(!activity.busy());
    }

    #[test]
    fn sdk_turn_started_by_task_completion_is_busy() {
        let mut activity = SdkActivity::default();
        activity.observe(&json!({"event": "content.delta", "text": "The audit finished"}));
        assert!(activity.busy());
        activity.observe(&json!({"event": "content.delta", "parentToolUseId": "toolu_sub"}));
        activity.observe(&json!({"event": "turn.completed"}));
        assert!(!activity.busy());
    }

    #[test]
    fn sdk_open_approval_is_busy_until_answered() {
        let mut activity = SdkActivity::default();
        activity.observe(&json!({"event": "approval.requested", "requestId": "r1"}));
        assert!(activity.busy());
        activity.request_resolved("r1");
        assert!(!activity.busy());
    }

    #[test]
    fn sdk_process_end_clears_activity() {
        let mut activity = SdkActivity::default();
        activity.submitted();
        activity.observe(&json!({"event": "tasks.background", "count": 2}));
        activity.observe(&json!({"event": "status", "status": "stream_ended"}));
        assert!(!activity.busy());
        activity.observe(&json!({"event": "tasks.background", "count": 1}));
        activity.observe(&json!({"event": "session.ended", "reason": "error"}));
        assert!(!activity.busy());
    }

    #[test]
    fn sdk_rejected_send_restores_the_previous_turn_state() {
        let mut activity = SdkActivity::default();
        let previous = activity.submitted();
        activity.submit_rejected(previous);
        assert!(!activity.busy());

        activity.submitted();
        let previous = activity.submitted();
        activity.submit_rejected(previous);
        assert!(activity.busy(), "a rejected follow-up must not close the running turn");
    }

    #[test]
    fn sdk_stream_end_without_completion_clears_everything() {
        // Stop mid-tool ends the stream with no turn.completed.
        let mut activity = SdkActivity::default();
        activity.submitted();
        activity.observe(&json!({"event": "tasks.background", "count": 1}));
        activity.observe(&json!({"event": "approval.requested", "requestId": "r1"}));
        activity.observe(&json!({"event": "query.ended"}));
        assert!(!activity.busy());
    }

    #[test]
    fn sdk_new_process_drops_old_tasks_but_keeps_the_new_turn() {
        let mut activity = SdkActivity::default();
        activity.observe(&json!({"event": "tasks.background", "count": 1}));
        activity.submitted();
        activity.observe(&json!({"event": "session.started", "sessionId": "s"}));
        assert!(activity.busy());
        activity.observe(&json!({"event": "turn.completed"}));
        assert!(!activity.busy());
    }

    #[test]
    fn sdk_turn_completion_clears_unanswered_questions() {
        let mut activity = SdkActivity::default();
        activity.observe(&json!({"event": "approval.requested", "requestId": "r1"}));
        activity.observe(&json!({"event": "turn.completed"}));
        assert!(!activity.busy());
    }

    #[test]
    fn ps_output_parses_commands_with_spaces() {
        let rows = parse_ps("  101     1 /bin/zsh -c source /x/shell-snapshots/snapshot-zsh-1.sh && ls\n 7 1\nbad line\n");
        assert_eq!(rows[0], ProcRow { pid: 101, ppid: 1, command: "/bin/zsh -c source /x/shell-snapshots/snapshot-zsh-1.sh && ls".into() });
        assert_eq!(rows[1], ProcRow { pid: 7, ppid: 1, command: String::new() });
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn process_tree_includes_root_and_all_descendants_only() {
        let rows = parse_ps("10 1 shell\n20 10 claude\n30 20 node mcp.js\n40 1 other\n50 40 child-of-other\n");
        let mut pids: Vec<u32> = process_tree(&rows, 10).iter().map(|row| row.pid).collect();
        pids.sort();
        assert_eq!(pids, vec![10, 20, 30]);
    }

    #[test]
    fn claude_status_file_idle_only_when_idle() {
        assert!(claude_status_is_busy(r#"{"pid":1,"status":"busy"}"#));
        assert!(claude_status_is_busy(r#"{"pid":1,"status":"waiting","waitingFor":"input needed"}"#));
        assert!(!claude_status_is_busy(r#"{"pid":1,"status":"idle"}"#));
        assert!(!claude_status_is_busy(r#"{"pid":1}"#));
        assert!(!claude_status_is_busy("not json"));
    }

    #[test]
    fn claude_shell_commands_are_recognised_but_mcp_servers_are_not() {
        assert!(is_claude_shell_command(
            "/bin/zsh -c source /Users/u/.claude/shell-snapshots/snapshot-zsh-1790-ab.sh 2>/dev/null || true && npm test"
        ));
        assert!(!is_claude_shell_command("/usr/local/bin/node /opt/mcp/server.mjs"));
        assert!(!is_claude_shell_command("npm exec @modelcontextprotocol/server-filesystem /Users/u"));
    }

    #[test]
    fn grok_latest_background_update_wins() {
        let update = |tasks: serde_json::Value| {
            json!({"method": "_x.ai/session/update", "params": {"update": {"sessionUpdate": "background_tasks", "tasks": tasks}}})
                .to_string()
        };
        let running = update(json!([{"task_id": "a", "kind": "bash", "status": "running"}]));
        let done = update(json!([{"task_id": "a", "kind": "bash", "status": "completed"}]));
        let other = json!({"params": {"update": {"sessionUpdate": "agent_message_chunk", "text": "\"background_tasks\""}}}).to_string();

        assert!(grok_background_running(format!("{running}\n{other}\n").as_bytes()));
        assert!(!grok_background_running(format!("{running}\n{done}\n").as_bytes()));
        assert!(!grok_background_running(update(json!([])).as_bytes()));
        assert!(!grok_background_running("".as_bytes()));
    }
}
