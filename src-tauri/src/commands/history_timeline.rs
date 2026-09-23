//! Recover turn cards from the same structured history used by conversation views.
use crate::db::models::{Thread, ThreadTurn};
use crate::remote::protocol::MobileTimelineEntry;
use crate::thread_turns::{extractive_prompt_title, history::reply_summary};

pub(super) async fn read_turns(pool: &sqlx::SqlitePool, thread: &Thread) -> Result<Vec<ThreadTurn>, String> {
    let (entries, _) = crate::remote::timeline::load_timeline_with_hint(pool, thread).await?;
    Ok(from_entries(&thread.id, &entries, thread.status == "Running"))
}

pub(super) fn read_native_claude(session_id: &str) -> Vec<ThreadTurn> {
    use std::io::BufRead;
    let Some(home) = dirs::home_dir() else { return vec![] };
    let Ok(projects) = std::fs::read_dir(home.join(".claude/projects")) else { return vec![] };
    for project in projects.flatten() {
        let path = project.path().join(format!("{session_id}.jsonl"));
        let Ok(file) = std::fs::File::open(path) else { continue };
        let mut items = Vec::new();
        for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
            items.extend(super::claude_chat::parse_line(&line));
        }
        let entries = crate::remote::timeline::claude_items_to_entries(&items);
        return from_entries(session_id, &entries, false);
    }
    vec![]
}

fn from_entries(thread_id: &str, entries: &[MobileTimelineEntry], running: bool) -> Vec<ThreadTurn> {
    let mut turns: Vec<ThreadTurn> = Vec::new();
    for entry in entries {
        let text = entry.text.as_deref().unwrap_or_default().trim();
        let timestamp = chrono::DateTime::from_timestamp_millis(entry.ts)
            .map(|t| t.to_rfc3339()).unwrap_or_default();
        if entry.kind == "user" && !text.is_empty() && entry.state.as_deref() != Some("queued") {
            let seq = turns.len() as i64 + 1;
            turns.push(ThreadTurn {
                id: format!("history:{thread_id}:{}", entry.id), thread_id: thread_id.into(), seq,
                prompt_text: text.into(), prompt_summary: Some(extractive_prompt_title(text)),
                status: "done".into(), started_at: timestamp.clone(), ended_at: None,
                summary: None, summary_source: "none".into(), anchor_kind: "chat_item".into(),
                anchor_ref: entry.id.clone(), facts_json: "{}".into(), created_at: timestamp,
            });
        } else if entry.kind == "assistant" && !text.is_empty() {
            if let Some(turn) = turns.last_mut() {
                turn.summary = reply_summary(text);
                turn.summary_source = "extractive".into();
                turn.ended_at = Some(timestamp);
            }
        }
    }
    if let Some(last) = turns.last_mut() {
        if running { last.status = "running".into(); last.ended_at = None; }
    }
    turns.reverse();
    turns
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(id: &str, kind: &str, text: &str) -> MobileTimelineEntry {
        serde_json::from_value(serde_json::json!({"id":id,"kind":kind,"text":text,"ts":1})).unwrap()
    }
    #[test]
    fn recovers_short_repeated_prompts_with_distinct_anchors_and_outcomes() {
        let rows = from_entries("t", &[
            entry("u1", "user", "continue"), entry("a1", "assistant", "Added a refresh button."),
            entry("u2", "user", "continue"), entry("a2", "assistant", "Fixed scrolling."),
        ], true);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].anchor_ref, "u2");
        assert_eq!(rows[0].summary.as_deref(), Some("Fixed scrolling."));
        assert_eq!(rows[0].status, "running");
        assert_eq!(rows[1].summary.as_deref(), Some("Added a refresh button."));
        assert_ne!(rows[0].id, rows[1].id);
    }
}
