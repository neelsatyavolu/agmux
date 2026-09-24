//! Droid terminal history: `~/.factory/sessions/<cwd-hash>/<uuid>.jsonl`.
//!
//! Records are `{type:"message", id, parentId, timestamp, message:{role, content}}`
//! with Anthropic-style blocks (`text` / `tool_use` / `tool_result`). User turns
//! carry `<system-reminder>` blocks next to the real ask; `visibility:"llm_only"`
//! messages are injected context the user never typed.

use super::native::{alias_keys, push_message_blocks, read_tail, BlockStyle, LogSink, MAX_TAIL_BYTES};
use super::{agent_logs_to_entries, MobileTimelineEntry};
use crate::db::models::Thread;
use serde_json::Value;
use std::path::Path;

pub(super) fn try_droid_history(thread: &Thread) -> Option<Vec<MobileTimelineEntry>> {
    let sid = crate::process::droid_model::read_droid_session_id(Path::new(&thread.state_dir))
        .or_else(|| thread.sdk_session_id.clone())?;
    let path = crate::process::droid_model::find_droid_session_file(&thread.work_dir, &sid)?;
    droid_history_from_file(&thread.id, &path)
}

const STYLE: BlockStyle = BlockStyle { user_text: droid_user_text, tool: droid_tool };

fn droid_history_from_file(thread_id: &str, path: &Path) -> Option<Vec<MobileTimelineEntry>> {
    let text = read_tail(path, MAX_TAIL_BYTES)?;
    let mut sink = LogSink::new(thread_id);
    for line in text.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else { continue };
        if record.get("type").and_then(|v| v.as_str()) != Some("message") {
            continue;
        }
        let (Some(id), Some(message)) = (record.get("id").and_then(|v| v.as_str()), record.get("message")) else {
            continue;
        };
        if message.get("visibility").and_then(|v| v.as_str()) == Some("llm_only") {
            continue;
        }
        let role = message.get("role").and_then(|v| v.as_str()).unwrap_or("");
        let ts = record.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        push_message_blocks(&mut sink, &STYLE, &format!("droid-{id}"), role, message.get("content"), ts);
    }
    Some(agent_logs_to_entries(&sink.logs))
}

fn droid_user_text(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.starts_with("<system-reminder") || t.starts_with("<system-notification") {
        return None;
    }
    Some(t.to_string())
}

/// Droid tool names → names the shared lead/diff helpers already understand.
fn droid_tool(name: &str, input: Value) -> (String, Value) {
    // MCP tools are `server___tool`; desktop shows those under the MCP lead.
    if let Some((server, tool)) = name.split_once("___") {
        return (format!("mcp__{server}__{tool}"), input);
    }
    let input = alias_keys(input, &[
        ("old_str", "old_string"),
        ("new_str", "new_string"),
        ("directory_path", "path"),
        ("folder", "path"),
    ]);
    let name = if name == "Create" { "Write" } else { name };
    (name.to_string(), input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::timeline::assert_timeline_renderable;

    const FIXTURE: &str = concat!(
        "{\"type\":\"session_start\",\"id\":\"00000000-0000-4000-8000-00000000d001\",\"cwd\":\"/example/repo\"}\n",
        "{\"type\":\"message\",\"id\":\"m1\",\"timestamp\":\"2026-09-20T10:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":[",
        "{\"type\":\"text\",\"text\":\"<system-reminder>injected</system-reminder>\"},{\"type\":\"text\",\"text\":\"Fix the bug\"}]}}\n",
        "{\"type\":\"message\",\"id\":\"m2\",\"parentId\":\"m1\",\"timestamp\":\"2026-09-20T10:00:01.000Z\",\"message\":{\"role\":\"user\",\"visibility\":\"llm_only\",\"content\":[{\"type\":\"text\",\"text\":\"Attached file context\"}]}}\n",
        "{\"type\":\"message\",\"id\":\"m3\",\"parentId\":\"m2\",\"timestamp\":\"2026-09-20T10:00:02.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[",
        "{\"type\":\"text\",\"text\":\"Looking.\"},",
        "{\"type\":\"tool_use\",\"id\":\"call-edit\",\"name\":\"Edit\",\"input\":{\"file_path\":\"/example/repo/src/a.rs\",\"old_str\":\"old\",\"new_str\":\"new\"}},",
        "{\"type\":\"tool_use\",\"id\":\"call-run\",\"name\":\"Execute\",\"input\":{\"command\":\"cargo test\",\"riskLevel\":\"low\"}},",
        "{\"type\":\"tool_use\",\"id\":\"call-mcp\",\"name\":\"docs___lookup\",\"input\":{\"query\":\"x\"}}]}}\n",
        "not json\n",
        "{\"type\":\"message\",\"id\":\"m4\",\"parentId\":\"m3\",\"timestamp\":\"2026-09-20T10:00:03.000Z\",\"message\":{\"role\":\"user\",\"content\":[",
        "{\"type\":\"tool_result\",\"tool_use_id\":\"call-edit\",\"content\":\"ok\"},",
        "{\"type\":\"tool_result\",\"tool_use_id\":\"call-run\",\"content\":\"1 failed\",\"is_error\":true},",
        "{\"type\":\"tool_result\",\"tool_use_id\":\"call-mcp\",\"content\":[{\"type\":\"text\",\"text\":\"found\"}]}]}}\n",
        "{\"type\":\"todo_state\",\"id\":\"t1\",\"todos\":[]}\n",
        "{\"type\":\"message\",\"id\":\"m5\",\"parentId\":\"m4\",\"timestamp\":\"2026-09-20T10:00:04.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"image\",\"source\":{\"type\":\"base64\",\"data\":\"AA==\"}}]}}\n",
        "{\"type\":\"message\",\"id\":\"m6\",\"parentId\":\"m5\",\"timestamp\":\"2026-09-20T10:00:05.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Done.\"}]}}\n",
        "{\"type\":\"message\",\"id\":\"partial"
    );

    #[test]
    fn droid_history_renders_prompts_replies_and_paired_tools() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("00000000-0000-4000-8000-00000000d001.jsonl");
        std::fs::write(&path, FIXTURE).unwrap();
        let entries = droid_history_from_file("thread-1", &path).unwrap();
        assert_timeline_renderable(&entries).unwrap();
        let kinds: Vec<&str> = entries.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, ["user", "assistant", "tool", "tool", "tool", "user", "assistant"]);
        assert_eq!(entries[0].text.as_deref(), Some("Fix the bug"));
        assert_eq!(entries[0].id, "droid-m1-user");
        assert_eq!(entries[2].lead.as_deref(), Some("Edited"));
        assert_eq!(entries[2].subject.as_deref(), Some("src/a.rs"));
        assert_eq!(entries[2].status.as_deref(), Some("ok"));
        assert_eq!((entries[2].additions, entries[2].deletions), (Some(1), Some(1)));
        assert_eq!(entries[3].lead.as_deref(), Some("Ran"));
        assert_eq!(entries[3].status.as_deref(), Some("error"));
        assert_eq!(entries[3].body.as_deref(), Some("1 failed"));
        assert_eq!(entries[4].lead.as_deref(), Some("MCP"));
        assert_eq!(entries[4].body.as_deref(), Some("found"));
        assert_eq!(entries[5].text.as_deref(), Some("[1 image]"));
        assert_eq!(entries[6].text.as_deref(), Some("Done."));
        // Stable ids: a second read yields identical ids for the phone's diffing.
        let again = droid_history_from_file("thread-1", &path).unwrap();
        assert_eq!(
            entries.iter().map(|e| &e.id).collect::<Vec<_>>(),
            again.iter().map(|e| &e.id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn droid_history_missing_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(droid_history_from_file("t", &dir.path().join("missing.jsonl")).is_none());
    }

    /// Read-only sanity check against this machine's real Droid sessions.
    /// Self-skips when there is no app DB or no linked Droid session.
    #[tokio::test]
    async fn live_droid_history_loads_when_present() {
        let Some(pool) = super::super::native::tests::open_live_pool().await else { return };
        let threads = sqlx::query_as::<_, Thread>("SELECT * FROM threads WHERE provider = 'Droid' ORDER BY last_active DESC LIMIT 20")
            .fetch_all(&pool).await.unwrap_or_default();
        for thread in threads {
            let Some(entries) = try_droid_history(&thread) else { continue };
            assert_timeline_renderable(&entries).unwrap();
            eprintln!("Droid live history: {} entries, {} tools", entries.len(), entries.iter().filter(|e| e.kind == "tool").count());
            return;
        }
        eprintln!("SKIP Droid live history: no linked local session file");
    }
}
