//! Cline terminal history.
//!
//! CLI sessions (what agmux binds): `~/.cline/data/sessions/<id>/<id>.messages.json`
//! = `{messages: [{id, role, ts, content: [text|thinking|tool_use|tool_result|image|file]}]}`.
//! User text is wrapped in `<user_input mode="…">…</user_input>`; only the ask is shown.
//! Older task dirs keep `api_conversation_history.json` (a bare message array)
//! where the ask is wrapped in `<task>` / `<feedback>` next to injected context.

use super::native::{alias_keys, epoch_ms_to_rfc3339, push_message_blocks, BlockStyle, LogSink};
use super::{agent_logs_to_entries, MobileTimelineEntry};
use crate::db::models::Thread;
use serde_json::Value;
use std::path::Path;

/// Transcripts are whole JSON documents (no tail read possible); refuse huge ones.
const MAX_TRANSCRIPT_BYTES: u64 = 32 * 1024 * 1024;

pub(super) fn try_cline_history(thread: &Thread) -> Option<Vec<MobileTimelineEntry>> {
    use crate::process::cline_session;
    let sid = cline_session::read_session_id(Path::new(&thread.state_dir))
        .or_else(|| thread.sdk_session_id.clone())?;
    if let Some(path) = cline_session::cli_messages_json(&sid).filter(|p| p.is_file()) {
        return cline_history_from_file(&thread.id, &path, &CLI_STYLE);
    }
    let path = cline_session::task_dir(&sid)?.join("api_conversation_history.json");
    cline_history_from_file(&thread.id, &path, &TASK_STYLE)
}

const CLI_STYLE: BlockStyle = BlockStyle { user_text: cli_user_text, tool: cline_tool };
const TASK_STYLE: BlockStyle = BlockStyle { user_text: task_user_text, tool: cline_tool };

fn cline_history_from_file(thread_id: &str, path: &Path, style: &BlockStyle) -> Option<Vec<MobileTimelineEntry>> {
    if std::fs::metadata(path).ok()?.len() > MAX_TRANSCRIPT_BYTES {
        return None;
    }
    let raw = std::fs::read(path).ok()?;
    let doc: Value = serde_json::from_slice(&raw).ok()?;
    let messages = doc.get("messages").unwrap_or(&doc).as_array()?;
    let mut sink = LogSink::new(thread_id);
    for (n, message) in messages.iter().enumerate() {
        let id = match message.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            Some(id) => format!("cline-{id}"),
            None => format!("cline-{n}"),
        };
        let role = message.get("role").and_then(|v| v.as_str()).unwrap_or("");
        let ts = epoch_ms_to_rfc3339(message.get("ts"));
        push_message_blocks(&mut sink, style, &id, role, message.get("content"), &ts);
    }
    Some(agent_logs_to_entries(&sink.logs))
}

fn cli_user_text(raw: &str) -> Option<String> {
    Some(crate::process::cline_session::unwrap_user_input(raw))
}

/// Task transcripts mix the ask with injected blocks (environment details,
/// progress reminders); keep only text inside the user-authored wrappers.
fn task_user_text(raw: &str) -> Option<String> {
    let t = raw.trim();
    ["task", "feedback", "answer", "user_message"].iter().find_map(|tag| {
        let inner = t.strip_prefix(&format!("<{tag}>"))?;
        let inner = inner.strip_suffix(&format!("</{tag}>")).unwrap_or(inner);
        Some(inner.trim().to_string())
    })
}

/// Cline SDK tool names → names the shared lead/diff helpers already understand.
fn cline_tool(name: &str, input: Value) -> (String, Value) {
    let first = |keys: &[&str]| -> Option<Value> {
        keys.iter().find_map(|k| input.get(*k)?.as_array()?.first().cloned())
    };
    match name {
        "read_files" => {
            let path = first(&["file_paths", "paths", "files"])
                .and_then(|v| v.as_str().map(str::to_string).or_else(|| v.get("path")?.as_str().map(str::to_string)));
            let mut input = input.clone();
            if let (Some(path), Some(obj)) = (path, input.as_object_mut()) {
                obj.entry("path").or_insert(Value::String(path));
            }
            ("Read".into(), input)
        }
        "run_commands" => {
            let commands: Vec<String> = input.get("commands").and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|c| c.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            let mut input = input.clone();
            if let (false, Some(obj)) = (commands.is_empty(), input.as_object_mut()) {
                obj.entry("command").or_insert(Value::String(commands.join("\n")));
            }
            ("Bash".into(), input)
        }
        "editor" => ("Edit".into(), alias_keys(input, &[("old_text", "old_string"), ("new_text", "new_string")])),
        "search_codebase" => ("Grep".into(), input),
        "fetch_web_content" => ("WebFetch".into(), input),
        other => (other.to_string(), input),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::timeline::assert_timeline_renderable;

    const CLI_FIXTURE: &str = r#"{"version":1,"sessionId":"1790000000000_abcde","messages":[
        {"id":"msg_u1","role":"user","ts":1790000000000,"content":[{"type":"text","text":"<user_input mode=\"act\">List the files</user_input>"}]},
        {"id":"msg_a1","role":"assistant","ts":1790000001000,"content":[
            {"type":"thinking","thinking":"Use a command"},
            {"type":"tool_use","id":"call-1","name":"run_commands","input":{"commands":["ls"]}},
            {"type":"tool_use","id":"call-2","name":"read_files","input":{"file_paths":["/example/repo/README.md"]}}]},
        {"id":"msg_r1","role":"user","ts":1790000002000,"content":[
            {"type":"tool_result","tool_use_id":"call-1","name":"run_commands","content":[{"type":"text","text":"README.md"}]},
            {"type":"tool_result","tool_use_id":"call-2","name":"read_files","content":"not found","is_error":true}]},
        {"id":"msg_a2","role":"assistant","ts":1790000003000,"content":[{"type":"text","text":"There is one file."}]},
        {"id":"msg_u2","role":"user","ts":1790000004000,"content":[{"type":"image","data":"AA==","mediaType":"image/png"}]}
    ]}"#;

    #[test]
    fn cline_cli_messages_render_ask_tools_and_reply() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("1790000000000_abcde.messages.json");
        std::fs::write(&path, CLI_FIXTURE).unwrap();
        let entries = cline_history_from_file("thread-1", &path, &CLI_STYLE).unwrap();
        assert_timeline_renderable(&entries).unwrap();
        let kinds: Vec<&str> = entries.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, ["user", "thinking", "tool", "tool", "assistant", "user"]);
        assert_eq!(entries[0].text.as_deref(), Some("List the files"));
        assert_eq!(entries[0].id, "cline-msg_u1-user");
        assert_eq!(entries[0].ts, 1_790_000_000_000);
        assert_eq!(entries[2].lead.as_deref(), Some("Ran"));
        assert_eq!(entries[2].subject.as_deref(), Some("ls"));
        assert_eq!(entries[2].body.as_deref(), Some("README.md"));
        assert_eq!(entries[3].lead.as_deref(), Some("Read"));
        assert_eq!(entries[3].subject.as_deref(), Some("repo/README.md"));
        assert_eq!(entries[3].status.as_deref(), Some("error"));
        assert_eq!(entries[4].text.as_deref(), Some("There is one file."));
        assert_eq!(entries[5].text.as_deref(), Some("[1 image]"));
    }

    #[test]
    fn cline_task_history_keeps_only_the_wrapped_ask() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("api_conversation_history.json");
        std::fs::write(&path, r##"[
            {"role":"user","ts":1790000000000,"content":[
                {"type":"text","text":"<task>\nhelp\n</task>"},
                {"type":"text","text":"# progress reminder"},
                {"type":"text","text":"<environment_details>cwd</environment_details>"}]},
            {"role":"assistant","ts":1790000001000,"content":[{"type":"text","text":"Sure."}]},
            "not a message"
        ]"##).unwrap();
        let entries = cline_history_from_file("thread-1", &path, &TASK_STYLE).unwrap();
        assert_timeline_renderable(&entries).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].text.as_deref(), Some("help"));
        assert_eq!(entries[0].id, "cline-0-user");
        assert_eq!(entries[1].text.as_deref(), Some("Sure."));
    }

    #[test]
    fn cline_history_rejects_missing_or_malformed_files() {
        let dir = tempfile::tempdir().unwrap();
        assert!(cline_history_from_file("t", &dir.path().join("missing.json"), &CLI_STYLE).is_none());
        let bad = dir.path().join("bad.json");
        std::fs::write(&bad, "{\"messages\":").unwrap();
        assert!(cline_history_from_file("t", &bad, &CLI_STYLE).is_none());
    }

    /// Read-only sanity check against this machine's real Cline sessions.
    /// Self-skips when there is no app DB or no linked Cline session.
    #[tokio::test]
    async fn live_cline_history_loads_when_present() {
        let Some(pool) = super::super::native::tests::open_live_pool().await else { return };
        let threads = sqlx::query_as::<_, Thread>("SELECT * FROM threads WHERE provider = 'Cline' ORDER BY last_active DESC LIMIT 20")
            .fetch_all(&pool).await.unwrap_or_default();
        for thread in threads {
            let Some(entries) = try_cline_history(&thread) else { continue };
            assert_timeline_renderable(&entries).unwrap();
            eprintln!("Cline live history: {} entries, {} tools", entries.len(), entries.iter().filter(|e| e.kind == "tool").count());
            return;
        }
        eprintln!("SKIP Cline live history: no linked local session file");
    }
}
