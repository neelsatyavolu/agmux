//! Hermes terminal history from `~/.hermes/state.db` (`messages` table).
//!
//! Rows are OpenAI-shaped: `user` / `assistant` (+ `reasoning`, `tool_calls`
//! JSON) / `tool` (`tool_call_id`, string `content`). Only `active = 1` rows
//! are shown so undone turns never reach the phone.

use super::super::protocol::MobileTimelineEntry;
use super::sqlite_ro::{millis_to_rfc3339, read_only};
use crate::db::models::{AgentLog, Thread};
use serde_json::{json, Value};
use std::path::Path;

/// Latest rows only; the phone timeline is capped at 250 entries anyway.
const MAX_MESSAGES: i64 = 400;

type Row = (i64, String, Option<String>, Option<String>, Option<String>, f64, Option<String>);

pub(super) fn try_hermes_history(thread: &Thread) -> Option<Vec<MobileTimelineEntry>> {
    let sid = crate::process::hermes_session::read_session_id(Path::new(&thread.state_dir))
        .or_else(|| thread.sdk_session_id.clone())?;
    let db = crate::process::hermes_session::state_db()?;
    read_session(&db, &thread.id, &sid)
}

fn read_session(db: &Path, thread_id: &str, sid: &str) -> Option<Vec<MobileTimelineEntry>> {
    if sid.trim().is_empty() {
        return None;
    }
    // Cap blobs in SQL so a huge tool output or write payload never crosses over.
    let mut rows: Vec<Row> = read_only(db, |mut conn| async move {
        sqlx::query_as(
            "SELECT id, role, substr(content, 1, 262144), tool_call_id, \
             CASE WHEN length(tool_calls) <= 1048576 THEN tool_calls END, timestamp, \
             substr(coalesce(reasoning, reasoning_content), 1, 65536) \
             FROM messages WHERE session_id = ? AND active = 1 \
             ORDER BY timestamp DESC, id DESC LIMIT ?",
        )
        .bind(sid).bind(MAX_MESSAGES).fetch_all(&mut conn).await.ok()
    })?;
    rows.reverse();
    let mut logs = Vec::new();
    for (id, role, content, tool_call_id, tool_calls, ts, reasoning) in rows {
        let ts = millis_to_rfc3339((ts * 1000.0) as i64);
        let mut push = |suffix: &str, direction: &str, log_type: &str, content: String| {
            logs.push(AgentLog {
                id: format!("hermes-{id}-{suffix}"), thread_id: thread_id.into(), direction: direction.into(),
                log_type: log_type.into(), content, timestamp: ts.clone(), rowid: None,
            });
        };
        let content = content.unwrap_or_default();
        match role.as_str() {
            "user" => push("user", "Input", "text", user_text(&content)),
            "assistant" => {
                if let Some(r) = reasoning.filter(|r| !r.trim().is_empty()) {
                    push("think", "Output", "thinking", r);
                }
                if !content.trim().is_empty() {
                    push("text", "Output", "text", content);
                }
                let calls = tool_calls.and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
                for (n, call) in calls.as_ref().and_then(|v| v.as_array()).into_iter().flatten().enumerate() {
                    let f = call.get("function").unwrap_or(call);
                    let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                    // OpenAI arguments are a JSON string; tolerate an object too.
                    let input = match f.get("arguments") {
                        Some(Value::String(s)) => serde_json::from_str(s).unwrap_or_else(|_| json!({})),
                        Some(v) if v.is_object() => v.clone(),
                        _ => json!({}),
                    };
                    let call_id = call.get("id").or_else(|| call.get("call_id")).and_then(|v| v.as_str());
                    let (name, input) = canonical_tool(name, input);
                    push(&format!("tool-{n}"), "Output", "tool_use", json!({
                        "toolUseId": call_id, "name": name, "input": input,
                    }).to_string());
                }
            }
            "tool" => {
                let (body, is_error) = tool_result(&content);
                push("result", "Output", "tool_result", json!({
                    "toolUseId": tool_call_id, "content": body, "isError": is_error,
                }).to_string());
            }
            _ => {}
        }
    }
    Some(super::agent_logs_to_entries(&logs))
}

/// Map Hermes tool names onto the shared lead/diff vocabulary.
fn canonical_tool(name: &str, input: Value) -> (String, Value) {
    let name = match name {
        "terminal" => "bash",
        "search_files" => "grep",
        // Replace-mode patches carry old/new strings: render them as an edit diff.
        "patch" if input.get("old_string").is_some() => "edit",
        other => other,
    };
    (name.to_string(), input)
}

/// Hermes tool content is usually a JSON envelope (`output`/`content`/`error`).
fn tool_result(content: &str) -> (String, bool) {
    let Ok(v) = serde_json::from_str::<Value>(content.trim()) else {
        return (content.to_string(), false);
    };
    let Some(obj) = v.as_object() else {
        return (content.to_string(), false);
    };
    let error = obj.get("error").and_then(|e| e.as_str()).filter(|e| !e.trim().is_empty());
    let is_error = error.is_some()
        || obj.get("success").and_then(|s| s.as_bool()) == Some(false)
        || obj.get("status").and_then(|s| s.as_str()) == Some("error")
        || obj.get("exit_code").and_then(|c| c.as_i64()).is_some_and(|c| c != 0);
    let body = ["output", "content"].iter()
        .find_map(|k| obj.get(*k).and_then(|s| s.as_str()).filter(|s| !s.trim().is_empty()))
        .or(error)
        .map(str::to_string)
        .unwrap_or_else(|| content.to_string());
    (body, is_error)
}

/// Plain text, or an OpenAI multimodal array (text parts + image placeholder).
fn user_text(content: &str) -> String {
    let trimmed = content.trim();
    let Some(blocks) = trimmed.starts_with('[').then(|| serde_json::from_str::<Value>(trimmed).ok()).flatten() else {
        return content.to_string();
    };
    let Some(blocks) = blocks.as_array().filter(|b| b.iter().all(|x| x.get("type").is_some())) else {
        return content.to_string();
    };
    let text = super::extract_text(Some(&Value::Array(blocks.clone())));
    if !text.trim().is_empty() {
        return text;
    }
    let images = blocks.iter()
        .filter(|b| matches!(b.get("type").and_then(|t| t.as_str()), Some("image_url" | "image" | "input_image")))
        .count();
    if images == 0 {
        return String::new();
    }
    format!("[{images} image{}]", if images == 1 { "" } else { "s" })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fixture(dir: &Path) -> std::path::PathBuf {
        let path = dir.join("state.db");
        let url = format!("sqlite:{}?mode=rwc", path.display());
        let pool = sqlx::SqlitePool::connect(&url).await.unwrap();
        sqlx::query("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, reasoning TEXT, reasoning_content TEXT, active INTEGER NOT NULL DEFAULT 1)")
            .execute(&pool).await.unwrap();
        let calls = r#"[{"id":"call-1","type":"function","function":{"name":"terminal","arguments":"{\"command\":\"ls\"}"}},{"id":"call-2","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"src/a.rs\"}"}}]"#;
        let rows: Vec<(&str, &str, Option<&str>, Option<&str>, Option<&str>, f64, Option<&str>, i64)> = vec![
            ("s1", "user", Some("List files"), None, None, 1_780_000_000.0, None, 1),
            ("s1", "assistant", Some("Undone reply"), None, None, 1_780_000_001.0, None, 0),
            ("s1", "assistant", Some(""), None, Some(calls), 1_780_000_002.0, Some("Plan the listing"), 1),
            ("s1", "tool", Some(r#"{"output":"a.rs\nb.rs","exit_code":0,"error":null}"#), Some("call-1"), None, 1_780_000_003.0, None, 1),
            ("s1", "tool", Some(r#"{"error":"File not found"}"#), Some("call-2"), None, 1_780_000_004.0, None, 1),
            ("s1", "assistant", Some("Two files."), None, None, 1_780_000_005.0, None, 1),
            ("s1", "user", Some(r#"[{"type":"image_url","image_url":{"url":"data:image/png;base64,AA"}}]"#), None, None, 1_780_000_006.0, None, 1),
            ("other", "user", Some("Not this session"), None, None, 1_780_000_007.0, None, 1),
        ];
        for (sid, role, content, call_id, tool_calls, ts, reasoning, active) in rows {
            sqlx::query("INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, timestamp, reasoning, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                .bind(sid).bind(role).bind(content).bind(call_id).bind(tool_calls).bind(ts).bind(reasoning).bind(active)
                .execute(&pool).await.unwrap();
        }
        pool.close().await;
        path
    }

    #[tokio::test]
    async fn hermes_history_reads_active_messages_tools_and_results() {
        let dir = tempfile::tempdir().unwrap();
        let db = fixture(dir.path()).await;
        let entries = tokio::task::spawn_blocking(move || read_session(&db, "t", "s1")).await.unwrap().unwrap();
        let kinds: Vec<&str> = entries.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, ["user", "thinking", "tool", "tool", "assistant", "user"]);
        assert_eq!(entries[0].text.as_deref(), Some("List files"));
        assert_eq!(entries[2].lead.as_deref(), Some("Ran"));
        assert_eq!(entries[2].subject.as_deref(), Some("ls"));
        assert_eq!(entries[2].status.as_deref(), Some("ok"));
        assert_eq!(entries[2].body.as_deref(), Some("a.rs\nb.rs"));
        assert_eq!(entries[3].lead.as_deref(), Some("Read"));
        assert_eq!(entries[3].status.as_deref(), Some("error"));
        assert_eq!(entries[3].body.as_deref(), Some("File not found"));
        assert_eq!(entries[4].text.as_deref(), Some("Two files."));
        assert_eq!(entries[5].text.as_deref(), Some("[1 image]"));
        assert!(entries.iter().all(|e| e.text.as_deref() != Some("Undone reply")));
        // Deterministic ids let the phone diff appends.
        assert_eq!(entries[0].id, "hermes-1-user");
        assert_eq!(entries[2].id, "hermes-3-tool-0");
        super::super::assert_timeline_renderable(&entries).unwrap();
    }

    #[tokio::test]
    async fn hermes_history_missing_db_or_session_is_none_or_empty() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("absent.db");
        assert!(tokio::task::spawn_blocking(move || read_session(&missing, "t", "s1")).await.unwrap().is_none());
        let db = fixture(dir.path()).await;
        let entries = tokio::task::spawn_blocking(move || read_session(&db, "t", "nope")).await.unwrap().unwrap();
        assert!(entries.is_empty());
        // A non-SQLite file must not panic.
        let junk = dir.path().join("junk.db");
        std::fs::write(&junk, b"not sqlite").unwrap();
        assert!(tokio::task::spawn_blocking(move || read_session(&junk, "t", "s1")).await.unwrap().is_none());
    }

    #[test]
    fn hermes_tool_result_flags_errors() {
        assert_eq!(tool_result(r#"{"output":"x","exit_code":2}"#), ("x".into(), true));
        assert_eq!(tool_result(r#"{"success":false,"content":"bad"}"#), ("bad".into(), true));
        assert_eq!(tool_result("plain text"), ("plain text".into(), false));
        assert_eq!(tool_result(r#"{"content":"ok","error":""}"#), ("ok".into(), false));
    }

    /// Live check against this Mac's Hermes sessions. Prints counts only.
    #[test]
    #[ignore]
    fn live_hermes_history_counts() {
        let Some(db) = crate::process::hermes_session::state_db().filter(|p| p.is_file()) else {
            eprintln!("SKIP: no Hermes state.db");
            return;
        };
        let threads = crate::paths::agmux_home().join("threads");
        let mut sids: Vec<String> = std::fs::read_dir(&threads).into_iter().flatten().flatten()
            .filter_map(|e| crate::process::hermes_session::read_session_id(&e.path())).collect();
        // Also exercise the largest local sessions so real shapes are covered.
        let largest: Option<Vec<String>> = read_only(&db, |mut conn| async move {
            sqlx::query_scalar("SELECT session_id FROM messages GROUP BY session_id ORDER BY count(*) DESC LIMIT 3")
                .fetch_all(&mut conn).await.ok()
        });
        sids.extend(largest.unwrap_or_default());
        for (n, sid) in sids.iter().enumerate() {
            let Some(entries) = read_session(&db, "live", sid) else { continue };
            super::super::assert_timeline_renderable(&entries).unwrap();
            eprintln!("hermes session #{n}: {} entries, {} tools, {} assistant", entries.len(),
                entries.iter().filter(|e| e.kind == "tool").count(),
                entries.iter().filter(|e| e.kind == "assistant").count());
        }
    }
}
