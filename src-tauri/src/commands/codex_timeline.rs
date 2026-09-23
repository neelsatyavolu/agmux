//! Read-only timeline for native Codex sessions (which have no app thread ledger).
use crate::db::models::ThreadTurn;
use serde_json::Value;

pub(super) fn read_turns(session_id: &str) -> Result<Vec<ThreadTurn>, String> {
    let Some(home) = dirs::home_dir() else { return Ok(vec![]) };
    let Some(path) = super::codex::find_session_file(&home.join(".codex/sessions"), session_id) else {
        return Ok(vec![]);
    };
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(parse_turns(session_id, &content))
}

fn parse_turns(session_id: &str, content: &str) -> Vec<ThreadTurn> {
    let mut turns: Vec<ThreadTurn> = Vec::new();
    for line in content.lines() {
        let Ok(row) = serde_json::from_str::<Value>(line) else { continue };
        if row["type"] != "event_msg" { continue; }
        let payload = &row["payload"];
        let timestamp = row["timestamp"].as_str().unwrap_or_default();
        match payload["type"].as_str().unwrap_or_default() {
            "user_message" => {
                let prompt = payload["message"].as_str().unwrap_or_default();
                if prompt.trim().is_empty() { continue; }
                let seq = turns.len() as i64 + 1;
                turns.push(ThreadTurn {
                    id: format!("codex:{session_id}:{seq}"), thread_id: session_id.into(), seq,
                    prompt_text: prompt.into(), prompt_summary: Some(crate::thread_turns::extractive_prompt_title(prompt)), status: "running".into(),
                    started_at: timestamp.into(), ended_at: None, summary: None,
                    summary_source: "none".into(), anchor_kind: "pty_marker".into(),
                    anchor_ref: seq.to_string(), facts_json: "{}".into(), created_at: timestamp.into(),
                });
            }
            "agent_message" => {
                if let Some(turn) = turns.last_mut().filter(|t| t.status == "running") {
                    turn.summary = payload["message"].as_str().and_then(crate::thread_turns::history::reply_summary);
                    turn.summary_source = "extractive".into();
                }
            }
            "task_complete" | "turn_aborted" => {
                // Steering messages can share the same active task.
                for turn in turns.iter_mut().rev().take_while(|t| t.status == "running") {
                    turn.status = if payload["type"] == "turn_aborted" { "cancelled" } else { "done" }.into();
                    turn.ended_at = Some(timestamp.into());
                    if let Some(summary) = payload["last_agent_message"].as_str().and_then(crate::thread_turns::history::reply_summary) {
                        turn.summary = Some(summary);
                        turn.summary_source = "extractive".into();
                    }
                }
            }
            _ => {}
        }
    }
    turns.reverse();
    turns
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "read-only acceptance against AGMUX_TIMELINE_SESSION on local disk"]
    fn saved_codex_timeline_has_outcomes() {
        let id = std::env::var("AGMUX_TIMELINE_SESSION").expect("set a native Codex session ID");
        let turns = read_turns(&id).unwrap();
        assert!(!turns.is_empty());
        let completed: Vec<_> = turns.iter().filter(|t| t.status == "done").collect();
        assert!(!completed.is_empty());
        assert!(completed.iter().all(|t| t.summary.as_deref().is_some_and(|s| !s.is_empty())));
    }

    #[test]
    fn summaries_come_from_each_turns_final_reply() {
        let content = [
            serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":"Fix timeline"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"The timeline now shows saved turns and jumps to their prompts."}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":"Fix sidebar"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"agent_message","message":"The sidebar now displays file changes."}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"task_complete"}}),
        ].iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n");
        let turns = parse_turns("session", &content);
        assert_eq!(turns[0].summary.as_deref(), Some("The sidebar now displays file changes."));
        assert_eq!(turns[1].summary.as_deref(), Some("The timeline now shows saved turns and jumps to their prompts."));
        assert_eq!(turns[1].prompt_summary.as_deref(), Some("Fix timeline"));
    }

    #[test]
    fn native_turns_ignore_injected_messages_and_keep_stable_ids() {
        let content = concat!(
            "{\"type\":\"response_item\",\"payload\":{\"role\":\"user\",\"content\":\"AGENTS instructions\"}}\n",
            "{\"timestamp\":\"a\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"fix timeline\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"role\":\"user\",\"content\":\"fix timeline\"}}\n",
            "{\"timestamp\":\"b\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n",
            "{\"timestamp\":\"c\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"ok\"}}\n",
            "{partial"
        );
        let turns = parse_turns("session", content);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].prompt_text, "ok");
        assert_eq!(turns[0].status, "running");
        assert_eq!(turns[1].id, "codex:session:1");
        assert_eq!(turns[1].status, "done");
        assert_eq!(turns[1].ended_at.as_deref(), Some("b"));
        let completed = parse_turns("session", &format!("{content}\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"turn_aborted\"}}}}"));
        assert_eq!(completed[0].id, turns[0].id);
        assert_eq!(completed[0].status, "cancelled");
    }
}
