//! Kimi Code terminal history: `<session_dir>/agents/main/wire.jsonl`.
//!
//! User asks are `context.append_message` records (`message.role == "user"`,
//! `origin.kind == "user"`). Replies stream as `context.append_loop_event`:
//! `content.part` (`text` / `think`), `tool.call` (`toolCallId`, `name`, `args`)
//! and `tool.result` (`toolCallId`, `result: {output, isError}`). `turn.prompt`
//! duplicates the user ask and is ignored.

use super::native::{epoch_ms_to_rfc3339, image_placeholder, is_image_block, read_tail, LogSink, MAX_TAIL_BYTES};
use super::{agent_logs_to_entries, MobileTimelineEntry};
use crate::db::models::Thread;
use serde_json::Value;
use std::path::Path;

pub(super) fn try_kimi_history(thread: &Thread) -> Option<Vec<MobileTimelineEntry>> {
    let sid = crate::process::kimi_session::read_kimi_session_id(Path::new(&thread.state_dir))
        .or_else(|| thread.sdk_session_id.clone())?;
    if sid.contains('/') || sid.contains("..") {
        return None;
    }
    let dir = crate::process::kimi_session::find_kimi_session_dir(&sid)?;
    // Main agent only: subagent wires are separate conversations.
    kimi_history_from_file(&thread.id, &dir.join("agents").join("main").join("wire.jsonl"))
}

fn kimi_history_from_file(thread_id: &str, path: &Path) -> Option<Vec<MobileTimelineEntry>> {
    let text = read_tail(path, MAX_TAIL_BYTES)?;
    let mut sink = LogSink::new(thread_id);
    for line in text.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else { continue };
        let ts = epoch_ms_to_rfc3339(record.get("time"));
        match record.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "context.append_message" => push_user_message(&mut sink, record.get("message"), &ts),
            "context.append_loop_event" => {
                if let Some(event) = record.get("event") {
                    push_loop_event(&mut sink, event, &ts);
                }
            }
            _ => {}
        }
    }
    Some(agent_logs_to_entries(&sink.logs))
}

fn push_user_message(sink: &mut LogSink<'_>, message: Option<&Value>, ts: &str) {
    let Some(message) = message else { return };
    if message.get("role").and_then(|v| v.as_str()) != Some("user") {
        return;
    }
    let origin = message.pointer("/origin/kind").and_then(|v| v.as_str());
    if origin.is_some_and(|kind| kind != "user") {
        return;
    }
    let Some(id) = message.get("id").and_then(|v| v.as_str()) else { return };
    let parts = message.get("content").and_then(|v| v.as_array());
    let text = parts
        .map(|p| {
            p.iter()
                .filter(|b| b.get("type").and_then(|v| v.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|v| v.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .or_else(|| message.get("content").and_then(|v| v.as_str()).map(str::to_string))
        .unwrap_or_default();
    let images = parts.map(|p| p.iter().filter(|b| is_image_block(b)).count()).unwrap_or(0);
    let text = if text.trim().is_empty() && images > 0 { image_placeholder(images) } else { text };
    sink.push(format!("kimi-{id}"), "Input", "text", text, ts);
}

fn push_loop_event(sink: &mut LogSink<'_>, event: &Value, ts: &str) {
    let str_field = |key: &str| event.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty());
    match str_field("type").unwrap_or("") {
        "content.part" => {
            let Some(uuid) = str_field("uuid") else { return };
            let part = event.get("part").unwrap_or(&Value::Null);
            let (log_type, key) = match part.get("type").and_then(|v| v.as_str()) {
                Some("text") => ("text", "text"),
                Some("think") => ("thinking", "think"),
                _ => return,
            };
            let text = part.get(key).and_then(|v| v.as_str()).unwrap_or("");
            sink.push(format!("kimi-{uuid}"), "Output", log_type, text.to_string(), ts);
        }
        "tool.call" => {
            let (Some(call_id), Some(name)) = (str_field("toolCallId"), str_field("name")) else { return };
            let input = event.get("args").cloned().filter(|v| v.is_object()).unwrap_or_else(|| serde_json::json!({}));
            sink.tool_use(format!("kimi-{call_id}"), event.get("toolCallId"), name, input, ts);
        }
        "tool.result" => {
            let Some(call_id) = str_field("toolCallId") else { return };
            let result = event.get("result").unwrap_or(&Value::Null);
            let is_error = result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
            let output = result.get("output").unwrap_or(&Value::Null);
            sink.tool_result(format!("kimi-{call_id}-result"), event.get("toolCallId"), output, is_error, ts);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::timeline::assert_timeline_renderable;

    const FIXTURE: &str = concat!(
        "{\"type\":\"metadata\",\"protocol_version\":\"1.5\",\"created_at\":1790000000000}\n",
        "{\"type\":\"turn.prompt\",\"input\":[{\"type\":\"text\",\"text\":\"Rename the helper\"}],\"origin\":{\"kind\":\"user\"},\"time\":1790000000001}\n",
        "{\"type\":\"context.append_message\",\"time\":1790000000002,\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Rename the helper\"}],\"toolCalls\":[],\"origin\":{\"kind\":\"user\"},\"id\":\"msg_user_1\"}}\n",
        "{\"type\":\"context.append_message\",\"time\":1790000000003,\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"injected reminder\"}],\"origin\":{\"kind\":\"system\"},\"id\":\"msg_sys\"}}\n",
        "{\"type\":\"context.append_loop_event\",\"time\":1790000000004,\"event\":{\"type\":\"step.begin\",\"uuid\":\"step-1\",\"turnId\":\"0\",\"step\":1}}\n",
        "{\"type\":\"context.append_loop_event\",\"time\":1790000000005,\"event\":{\"type\":\"content.part\",\"uuid\":\"part-think\",\"part\":{\"type\":\"think\",\"think\":\"Find usages first\"}}}\n",
        "{\"type\":\"context.append_loop_event\",\"time\":1790000000006,\"event\":{\"type\":\"tool.call.delta\",\"toolCallId\":\"call-1\"}}\n",
        "{\"type\":\"context.append_loop_event\",\"time\":1790000000007,\"event\":{\"type\":\"tool.call\",\"uuid\":\"call-1\",\"toolCallId\":\"call-1\",\"name\":\"Bash\",\"args\":{\"command\":\"rg helper\"}}}\n",
        "{broken\n",
        "{\"type\":\"context.append_loop_event\",\"time\":1790000000008,\"event\":{\"type\":\"tool.result\",\"parentUuid\":\"call-1\",\"toolCallId\":\"call-1\",\"result\":{\"output\":\"src/a.rs:1\",\"isError\":false}}}\n",
        "{\"type\":\"context.append_loop_event\",\"time\":1790000000009,\"event\":{\"type\":\"tool.call\",\"toolCallId\":\"call-2\",\"name\":\"Edit\",\"args\":{\"file_path\":\"/example/repo/src/a.rs\",\"old_string\":\"helper\",\"new_string\":\"util\"}}}\n",
        "{\"type\":\"context.append_loop_event\",\"time\":1790000000010,\"event\":{\"type\":\"tool.result\",\"toolCallId\":\"call-2\",\"result\":{\"output\":[{\"type\":\"text\",\"text\":\"denied\"}],\"isError\":true}}}\n",
        "{\"type\":\"context.append_loop_event\",\"time\":1790000000011,\"event\":{\"type\":\"content.part\",\"uuid\":\"part-text\",\"part\":{\"type\":\"text\",\"text\":\"I could not edit the file.\"}}}\n",
        "{\"type\":\"turn.ended\",\"turnId\":0,\"reason\":\"completed\",\"time\":1790000000012}\n",
        "{\"type\":\"context.append_message\",\"time\":1790000000013,\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"image_url\",\"imageUrl\":{\"url\":\"data:image/png;base64,AA==\"}}],\"origin\":{\"kind\":\"user\"},\"id\":\"msg_user_2\"}}\n"
    );

    #[test]
    fn kimi_wire_renders_prompts_thinking_tools_and_replies() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wire.jsonl");
        std::fs::write(&path, FIXTURE).unwrap();
        let entries = kimi_history_from_file("thread-1", &path).unwrap();
        assert_timeline_renderable(&entries).unwrap();
        let kinds: Vec<&str> = entries.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, ["user", "thinking", "tool", "tool", "assistant", "user"]);
        assert_eq!(entries[0].text.as_deref(), Some("Rename the helper"));
        assert_eq!(entries[0].id, "kimi-msg_user_1");
        assert_eq!(entries[0].ts, 1_790_000_000_002);
        assert_eq!(entries[2].lead.as_deref(), Some("Ran"));
        assert_eq!(entries[2].subject.as_deref(), Some("rg helper"));
        assert_eq!(entries[2].status.as_deref(), Some("ok"));
        assert_eq!(entries[2].body.as_deref(), Some("src/a.rs:1"));
        assert_eq!(entries[3].lead.as_deref(), Some("Edited"));
        assert_eq!(entries[3].status.as_deref(), Some("error"));
        assert_eq!(entries[3].body.as_deref(), Some("denied"));
        assert_eq!(entries[4].text.as_deref(), Some("I could not edit the file."));
        assert_eq!(entries[5].text.as_deref(), Some("[1 image]"));
    }

    #[test]
    fn kimi_history_missing_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(kimi_history_from_file("t", &dir.path().join("wire.jsonl")).is_none());
    }

    /// Read-only sanity check against this machine's real Kimi sessions.
    /// Self-skips when there is no app DB or no linked Kimi session.
    #[tokio::test]
    async fn live_kimi_history_loads_when_present() {
        let Some(pool) = super::super::native::tests::open_live_pool().await else { return };
        let threads = sqlx::query_as::<_, Thread>("SELECT * FROM threads WHERE provider = 'Kimi' ORDER BY last_active DESC LIMIT 20")
            .fetch_all(&pool).await.unwrap_or_default();
        for thread in threads {
            let Some(entries) = try_kimi_history(&thread) else { continue };
            assert_timeline_renderable(&entries).unwrap();
            eprintln!("Kimi live history: {} entries, {} tools", entries.len(), entries.iter().filter(|e| e.kind == "tool").count());
            return;
        }
        eprintln!("SKIP Kimi live history: no linked local session file");
    }
}
