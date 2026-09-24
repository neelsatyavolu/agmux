//! OpenCode terminal history from its local SQLite DB (`message` + `part`).
//!
//! Only used for `interaction_mode == "pty"`; `opencode-sdk` chats already log
//! through the bridge into agent_logs. Parts: `text` (user/assistant),
//! `reasoning`, `tool` (`tool`, `callID`, `state.{status,input,output,error}`)
//! and `file` (user attachments; images become a placeholder).

use super::super::protocol::MobileTimelineEntry;
use super::sqlite_ro::{millis_to_rfc3339, read_only};
use crate::db::models::{AgentLog, Thread};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Latest messages only; the phone timeline is capped at 250 entries anyway.
const MAX_MESSAGES: i64 = 200;
const MAX_PARTS: i64 = 4000;

#[derive(sqlx::FromRow)]
struct PartRow {
    id: String,
    message_id: String,
    role: Option<String>,
    time_created: i64,
    kind: Option<String>,
    text: Option<String>,
    tool: Option<String>,
    call_id: Option<String>,
    status: Option<String>,
    input: Option<String>,
    output: Option<String>,
    error: Option<String>,
    mime: Option<String>,
    hidden: i64,
}

// Extract only the fields the phone renders and cap blobs inside SQLite.
// json_valid guards keep one corrupt row from failing the whole read.
const PARTS_SQL: &str = "SELECT p.id, p.message_id, m.role, p.time_created, \
    json_extract(p.data, '$.type') AS kind, \
    substr(json_extract(p.data, '$.text'), 1, 262144) AS text, \
    json_extract(p.data, '$.tool') AS tool, json_extract(p.data, '$.callID') AS call_id, \
    json_extract(p.data, '$.state.status') AS status, \
    CASE WHEN length(json_extract(p.data, '$.state.input')) <= 1048576 \
      THEN json_extract(p.data, '$.state.input') END AS input, \
    substr(json_extract(p.data, '$.state.output'), 1, 65536) AS output, \
    substr(json_extract(p.data, '$.state.error'), 1, 65536) AS error, \
    json_extract(p.data, '$.mime') AS mime, \
    (coalesce(json_extract(p.data, '$.synthetic'), 0) = 1 OR coalesce(json_extract(p.data, '$.ignored'), 0) = 1) AS hidden \
    FROM part p JOIN (SELECT id, time_created, json_extract(data, '$.role') AS role FROM message \
      WHERE session_id = ? AND json_valid(data) ORDER BY time_created DESC, id DESC LIMIT ?) m \
    ON m.id = p.message_id \
    WHERE p.session_id = ? AND json_valid(p.data) \
    ORDER BY m.time_created DESC, m.id DESC, p.time_created DESC, p.id DESC LIMIT ?";

pub(super) fn try_opencode_pty_history(thread: &Thread) -> Option<Vec<MobileTimelineEntry>> {
    let sid = crate::hooks::read_opencode_session_id(Path::new(&thread.state_dir))
        .or_else(|| thread.opencode_session_id.clone())?;
    let db = crate::process::opencode_session::opencode_db_path()?;
    read_session(&db, &thread.id, &sid)
}

fn read_session(db: &Path, thread_id: &str, sid: &str) -> Option<Vec<MobileTimelineEntry>> {
    if sid.trim().is_empty() {
        return None;
    }
    let mut rows: Vec<PartRow> = read_only(db, |mut conn| async move {
        // The relay plugin can observe a child (subagent) session id: only a
        // top-level session belongs to this terminal.
        let top: Option<i64> = sqlx::query_scalar("SELECT 1 FROM session WHERE id = ? AND parent_id IS NULL")
            .bind(sid).fetch_optional(&mut conn).await.ok()?;
        top?;
        sqlx::query_as(PARTS_SQL).bind(sid).bind(MAX_MESSAGES).bind(sid).bind(MAX_PARTS)
            .fetch_all(&mut conn).await.ok()
    })?;
    rows.reverse();
    Some(super::agent_logs_to_entries(&rows_to_logs(thread_id, &rows)))
}

fn rows_to_logs(thread_id: &str, rows: &[PartRow]) -> Vec<AgentLog> {
    let is_user = |r: &PartRow| r.role.as_deref() == Some("user");
    let mut user_text: HashSet<&str> = HashSet::new();
    let mut images: HashMap<&str, usize> = HashMap::new();
    for r in rows.iter().filter(|r| is_user(r)) {
        match r.kind.as_deref() {
            Some("text") if r.hidden == 0 && r.text.as_deref().is_some_and(|t| !t.trim().is_empty()) => {
                user_text.insert(r.message_id.as_str());
            }
            Some("file") if r.mime.as_deref().is_some_and(|m| m.starts_with("image/")) => {
                *images.entry(r.message_id.as_str()).or_default() += 1;
            }
            _ => {}
        }
    }
    let mut seen: HashSet<&str> = HashSet::new();
    let mut logs = Vec::new();
    for r in rows {
        let ts = millis_to_rfc3339(r.time_created);
        let mut push = |id: String, direction: &str, log_type: &str, content: String| {
            logs.push(AgentLog {
                id, thread_id: thread_id.into(), direction: direction.into(),
                log_type: log_type.into(), content, timestamp: ts.clone(), rowid: None,
            });
        };
        if seen.insert(r.message_id.as_str()) && is_user(r) && !user_text.contains(r.message_id.as_str()) {
            if let Some(n) = images.get(r.message_id.as_str()).copied() {
                push(format!("oc-{}-images", r.message_id), "Input", "text",
                    format!("[{n} image{}]", if n == 1 { "" } else { "s" }));
            }
        }
        let id = format!("oc-{}", r.id);
        match r.kind.as_deref().unwrap_or("") {
            "text" if r.hidden == 0 => {
                let text = r.text.clone().unwrap_or_default();
                if is_user(r) {
                    push(id, "Input", "text", text);
                } else if r.role.as_deref() == Some("assistant") {
                    push(id, "Output", "text", text);
                }
            }
            "reasoning" => push(id, "Output", "thinking", r.text.clone().unwrap_or_default()),
            "tool" => {
                let tool_use_id = r.call_id.clone().unwrap_or_else(|| r.id.clone());
                let input = r.input.as_deref().and_then(|s| serde_json::from_str::<Value>(s).ok())
                    .unwrap_or_else(|| json!({}));
                push(id.clone(), "Output", "tool_use", json!({
                    "toolUseId": tool_use_id, "name": r.tool.as_deref().unwrap_or("tool"), "input": input,
                }).to_string());
                // pending/running stay open; only settled states carry a result.
                let result = match r.status.as_deref() {
                    Some("completed") => Some((r.output.clone().unwrap_or_default(), false)),
                    Some("error") => Some((r.error.clone().unwrap_or_default(), true)),
                    _ => None,
                };
                if let Some((content, is_error)) = result {
                    push(format!("{id}-result"), "Output", "tool_result", json!({
                        "toolUseId": tool_use_id, "content": content, "isError": is_error,
                    }).to_string());
                }
            }
            _ => {}
        }
    }
    logs
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fixture(dir: &Path) -> std::path::PathBuf {
        let path = dir.join("opencode.db");
        let url = format!("sqlite:{}?mode=rwc", path.display());
        let pool = sqlx::SqlitePool::connect(&url).await.unwrap();
        for sql in [
            "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT)",
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
            "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
            "INSERT INTO session VALUES ('ses_top', NULL, '/tmp/example'), ('ses_child', 'ses_top', '/tmp/example')",
        ] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        let messages = [
            ("msg_1", "ses_top", 1_000, r#"{"role":"user"}"#),
            ("msg_2", "ses_top", 2_000, r#"{"role":"assistant"}"#),
            ("msg_3", "ses_top", 3_000, r#"{"role":"user"}"#),
            ("msg_4", "ses_top", 4_000, "{not json"),
            ("msg_c", "ses_child", 5_000, r#"{"role":"user"}"#),
        ];
        for (id, sid, t, data) in messages {
            sqlx::query("INSERT INTO message VALUES (?, ?, ?, ?, ?)").bind(id).bind(sid).bind(t).bind(t).bind(data)
                .execute(&pool).await.unwrap();
        }
        let parts = [
            ("prt_01", "msg_1", "ses_top", 1_001, r#"{"type":"text","text":"Fix the bug"}"#),
            ("prt_02", "msg_1", "ses_top", 1_002, r#"{"type":"text","text":"Called the Read tool","synthetic":true}"#),
            ("prt_03", "msg_2", "ses_top", 2_001, r#"{"type":"step-start"}"#),
            ("prt_04", "msg_2", "ses_top", 2_002, r#"{"type":"reasoning","text":"Look at the file"}"#),
            ("prt_05", "msg_2", "ses_top", 2_003, r#"{"type":"tool","callID":"call_a","tool":"edit","state":{"status":"completed","input":{"filePath":"/tmp/example/a.rs","oldString":"old","newString":"new"},"output":"Edit applied"}}"#),
            ("prt_06", "msg_2", "ses_top", 2_004, r#"{"type":"tool","callID":"call_b","tool":"bash","state":{"status":"error","input":{"command":"cargo test"},"error":"exit 101"}}"#),
            ("prt_07", "msg_2", "ses_top", 2_005, r#"{"type":"tool","callID":"call_c","tool":"read","state":{"status":"running","input":{"filePath":"/tmp/example/b.rs"}}}"#),
            ("prt_08", "msg_2", "ses_top", 2_006, r#"{"type":"text","text":"Fixed."}"#),
            ("prt_09", "msg_2", "ses_top", 2_007, "{broken"),
            ("prt_10", "msg_3", "ses_top", 3_001, r#"{"type":"file","mime":"image/png","filename":"shot.png","url":"data:image/png;base64,AA"}"#),
            ("prt_11", "msg_c", "ses_child", 5_001, r#"{"type":"text","text":"Child task"}"#),
        ];
        for (id, msg, sid, t, data) in parts {
            sqlx::query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").bind(id).bind(msg).bind(sid).bind(t).bind(t).bind(data)
                .execute(&pool).await.unwrap();
        }
        pool.close().await;
        path
    }

    #[tokio::test]
    async fn opencode_pty_history_reads_parts_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let db = fixture(dir.path()).await;
        let entries = tokio::task::spawn_blocking(move || read_session(&db, "t", "ses_top")).await.unwrap().unwrap();
        let kinds: Vec<&str> = entries.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, ["user", "thinking", "tool", "tool", "tool", "assistant", "user"]);
        assert_eq!(entries[0].text.as_deref(), Some("Fix the bug"));
        assert_eq!(entries[0].id, "oc-prt_01");
        assert_eq!(entries[2].lead.as_deref(), Some("Edited"));
        assert_eq!(entries[2].status.as_deref(), Some("ok"));
        assert_eq!((entries[2].additions, entries[2].deletions), (Some(1), Some(1)));
        assert_eq!(entries[3].status.as_deref(), Some("error"));
        assert_eq!(entries[3].body.as_deref(), Some("exit 101"));
        assert_eq!(entries[4].status.as_deref(), Some("running"));
        assert_eq!(entries[5].text.as_deref(), Some("Fixed."));
        assert_eq!(entries[6].text.as_deref(), Some("[1 image]"));
        assert_eq!(entries[6].id, "oc-msg_3-images");
        super::super::assert_timeline_renderable(&entries).unwrap();
    }

    #[tokio::test]
    async fn opencode_pty_history_rejects_child_and_unknown_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let db = fixture(dir.path()).await;
        let child = db.clone();
        assert!(tokio::task::spawn_blocking(move || read_session(&child, "t", "ses_child")).await.unwrap().is_none());
        assert!(tokio::task::spawn_blocking(move || read_session(&db, "t", "ses_missing")).await.unwrap().is_none());
    }

    /// Live check against this Mac's OpenCode DB. Prints counts only.
    #[test]
    #[ignore]
    fn live_opencode_pty_history_counts() {
        let Some(db) = crate::process::opencode_session::opencode_db_path() else {
            eprintln!("SKIP: no OpenCode DB");
            return;
        };
        let threads = crate::paths::agmux_home().join("threads");
        let mut sids: Vec<String> = std::fs::read_dir(&threads).into_iter().flatten().flatten()
            .filter_map(|e| crate::hooks::read_opencode_session_id(&e.path())).collect();
        let largest: Option<Vec<String>> = read_only(&db, |mut conn| async move {
            sqlx::query_scalar("SELECT p.session_id FROM part p JOIN session s ON s.id = p.session_id WHERE s.parent_id IS NULL GROUP BY p.session_id ORDER BY count(*) DESC LIMIT 3")
                .fetch_all(&mut conn).await.ok()
        });
        sids.extend(largest.unwrap_or_default());
        for (n, sid) in sids.iter().enumerate() {
            let Some(entries) = read_session(&db, "live", sid) else {
                eprintln!("opencode session #{n}: none");
                continue;
            };
            super::super::assert_timeline_renderable(&entries).unwrap();
            eprintln!("opencode session #{n}: {} entries, {} tools, {} assistant", entries.len(),
                entries.iter().filter(|e| e.kind == "tool").count(),
                entries.iter().filter(|e| e.kind == "assistant").count());
        }
    }
}
