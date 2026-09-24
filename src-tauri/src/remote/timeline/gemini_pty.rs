//! Gemini terminal (Antigravity CLI `agy`) history from
//! `~/.gemini/antigravity-cli/brain/{id}/.system_generated/logs/transcript.jsonl`.
//!
//! Only used for `interaction_mode == "pty"`; `gemini-sdk` chats already log
//! through the ACP bridge into agent_logs. Steps: `USER_INPUT` (prompt inside
//! `<USER_REQUEST>`), `PLANNER_RESPONSE` (`thinking`, `content`, id-less
//! `tool_calls[{name,args}]`) and `GENERIC` (the next tool output, headed by a
//! `Created At:` line). Tool outputs carry no call id, so they pair FIFO with
//! the calls of the current turn.

use super::super::protocol::MobileTimelineEntry;
use crate::db::models::{AgentLog, Thread};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::Path;

const MAX_BYTES: u64 = 8 * 1024 * 1024;

pub(super) fn try_gemini_pty_history(thread: &Thread) -> Option<Vec<MobileTimelineEntry>> {
    let sid = crate::process::gemini_session::read_session_id(Path::new(&thread.state_dir))
        .or_else(|| thread.sdk_session_id.clone())?;
    let path = crate::process::gemini_session::agy_transcript_path(&sid)?;
    read_transcript(&path, &thread.id)
}

fn read_transcript(path: &Path, thread_id: &str) -> Option<Vec<MobileTimelineEntry>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let start = file.metadata().ok()?.len().saturating_sub(MAX_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.lines();
    if start > 0 { lines.next(); }
    let records = lines.filter_map(|line| serde_json::from_str::<Value>(line).ok());
    Some(super::agent_logs_to_entries(&records_to_logs(thread_id, records)))
}

fn records_to_logs(thread_id: &str, records: impl Iterator<Item = Value>) -> Vec<AgentLog> {
    let mut logs = Vec::new();
    let mut pending: VecDeque<String> = VecDeque::new();
    for v in records {
        // step_index is unique per transcript: it keeps entry ids stable.
        let Some(step) = v.get("step_index").and_then(|s| s.as_i64()) else { continue };
        let ts = v.get("created_at").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let mut push = |suffix: &str, direction: &str, log_type: &str, content: String| {
            logs.push(AgentLog {
                id: format!("agy-{step}-{suffix}"), thread_id: thread_id.into(), direction: direction.into(),
                log_type: log_type.into(), content, timestamp: ts.clone(), rowid: None,
            });
        };
        match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "USER_INPUT" => {
                pending.clear();
                if let Some(text) = crate::process::gemini_session::user_text_from_value(&v) {
                    push("user", "Input", "text", text);
                }
            }
            "PLANNER_RESPONSE" => {
                if let Some(t) = v.get("thinking").and_then(|s| s.as_str()) {
                    push("think", "Output", "thinking", t.to_string());
                }
                if let Some(t) = v.get("content").and_then(|s| s.as_str()) {
                    push("text", "Output", "text", t.to_string());
                }
                // A new model step means earlier outputs can no longer arrive.
                pending.clear();
                for (n, call) in v.get("tool_calls").and_then(|c| c.as_array()).into_iter().flatten().enumerate() {
                    let raw = call.get("name").and_then(|s| s.as_str()).unwrap_or("tool");
                    let name = crate::gemini::event_mapper::canonical_tool_name("", raw);
                    let args = call.get("args").cloned().unwrap_or_else(|| json!({}));
                    let input = crate::gemini::event_mapper::normalize_tool_input(&args);
                    let call_id = format!("agy-{step}-tool-{n}");
                    push(&format!("tool-{n}"), "Output", "tool_use", json!({
                        "toolUseId": call_id, "name": name, "input": input,
                    }).to_string());
                    pending.push_back(call_id);
                }
            }
            "GENERIC" => {
                let Some(call_id) = pending.pop_front() else { continue };
                // A still-running output stays open rather than looking finished.
                if v.get("status").and_then(|s| s.as_str()) == Some("RUNNING") {
                    continue;
                }
                let content = strip_created_header(v.get("content").and_then(|s| s.as_str()).unwrap_or(""));
                push("result", "Output", "tool_result", json!({
                    "toolUseId": call_id, "content": content, "isError": false,
                }).to_string());
            }
            _ => {}
        }
    }
    logs
}

/// Drop the leading `Created At: …` metadata line(s) from a tool output.
fn strip_created_header(content: &str) -> String {
    let mut rest = content;
    while let Some(line) = rest.lines().next().filter(|l| l.trim_start().starts_with("Created At:")) {
        rest = rest[line.len()..].trim_start_matches(['\r', '\n']);
    }
    rest.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(dir: &Path) -> std::path::PathBuf {
        let path = dir.join("transcript.jsonl");
        std::fs::write(&path, concat!(
            "{\"step_index\":0,\"source\":\"SYSTEM\",\"type\":\"SYSTEM_MESSAGE\",\"status\":\"DONE\",\"created_at\":\"2026-09-01T10:00:00Z\",\"content\":\"system setup\"}\n",
            "{\"step_index\":1,\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"created_at\":\"2026-09-01T10:00:01Z\",\"content\":\"<USER_REQUEST>\\nRead main.rs\\n</USER_REQUEST>\\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>\"}\n",
            "{\"step_index\":2,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"created_at\":\"2026-09-01T10:00:02Z\",\"thinking\":\"Open the file\",\"tool_calls\":[{\"name\":\"view_file\",\"args\":{\"AbsolutePath\":\"/tmp/example/main.rs\",\"toolSummary\":\"read\"}}]}\n",
            "{\"step_index\":3,\"source\":\"MODEL\",\"type\":\"GENERIC\",\"status\":\"DONE\",\"created_at\":\"2026-09-01T10:00:03Z\",\"content\":\"Created At: 2026-09-01T10:00:03Z\\nfn main() {}\"}\n",
            "{\"step_index\":4,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"created_at\":\"2026-09-01T10:00:04Z\",\"tool_calls\":[{\"name\":\"run_command\",\"args\":{\"CommandLine\":\"cargo check\",\"Cwd\":\"/tmp/example\"}}]}\n",
            "{\"step_index\":5,\"source\":\"MODEL\",\"type\":\"GENERIC\",\"status\":\"RUNNING\",\"created_at\":\"2026-09-01T10:00:05Z\",\"content\":\"Created At: 2026-09-01T10:00:05Z\\nstill going\"}\n",
            "{\"step_index\":6,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"created_at\":\"2026-09-01T10:00:06Z\",\"content\":\"main.rs is empty.\"}\n",
            "{\"step_index\":7,\"source\":\"MODEL\",\"type\":\"GENERIC\",\"status\":\"DONE\",\"created_at\":\"2026-09-01T10:00:07Z\",\"content\":\"Created At: 2026-09-01T10:00:07Z\\nunpaired\"}\n",
            "{not json\n",
            "{\"step_index\":8,\"type\":\"CHECKPOINT\",\"content\":\"{{ CHECKPOINT 1 }}\"}\n",
            "{\"step_index\":9,\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"status\":\"DONE\",\"created_at\":\"2026-09-01T10:01:00Z\",\"content\":\"<USER_REQUEST>Thanks</USER_REQUEST>\"}\n",
            "{\"step_index\":10,\"type\":\"PLANNER_RESP"
        )).unwrap();
        path
    }

    #[test]
    fn gemini_pty_history_pairs_outputs_with_calls() {
        let dir = tempfile::tempdir().unwrap();
        let entries = read_transcript(&fixture(dir.path()), "t").unwrap();
        let kinds: Vec<&str> = entries.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, ["user", "thinking", "tool", "tool", "assistant", "user"]);
        assert_eq!(entries[0].text.as_deref(), Some("Read main.rs"));
        assert_eq!(entries[0].id, "agy-1-user");
        assert_eq!(entries[2].id, "agy-2-tool-0");
        assert_eq!(entries[2].subject.as_deref(), Some("example/main.rs"));
        assert_eq!(entries[2].status.as_deref(), Some("ok"));
        assert_eq!(entries[2].body.as_deref(), Some("fn main() {}"));
        assert_eq!(entries[3].lead.as_deref(), Some("Ran"));
        assert_eq!(entries[3].subject.as_deref(), Some("cargo check"));
        assert_eq!(entries[3].status.as_deref(), Some("running"));
        assert_eq!(entries[4].text.as_deref(), Some("main.rs is empty."));
        assert_eq!(entries[5].text.as_deref(), Some("Thanks"));
        super::super::assert_timeline_renderable(&entries).unwrap();
    }

    #[test]
    fn gemini_pty_history_missing_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_transcript(&dir.path().join("absent.jsonl"), "t").is_none());
        assert_eq!(strip_created_header("Created At: x\r\nCreated At: y\nbody\nCreated At: z"), "body\nCreated At: z");
    }

    /// Live check against this Mac's agy transcripts. Prints counts only.
    #[test]
    #[ignore]
    fn live_gemini_pty_history_counts() {
        let threads = crate::paths::agmux_home().join("threads");
        let mut n = 0;
        for entry in std::fs::read_dir(&threads).into_iter().flatten().flatten() {
            let Some(sid) = crate::process::gemini_session::read_session_id(&entry.path()) else { continue };
            let Some(path) = crate::process::gemini_session::agy_transcript_path(&sid).filter(|p| p.is_file()) else {
                eprintln!("gemini binding #{n}: no transcript");
                n += 1;
                continue;
            };
            let entries = read_transcript(&path, "live").unwrap();
            super::super::assert_timeline_renderable(&entries).unwrap();
            eprintln!("gemini binding #{n}: {} entries, {} tools ({} unpaired), {} assistant", entries.len(),
                entries.iter().filter(|e| e.kind == "tool").count(),
                entries.iter().filter(|e| e.status.as_deref() == Some("running")).count(),
                entries.iter().filter(|e| e.kind == "assistant").count());
            n += 1;
        }
    }
}
