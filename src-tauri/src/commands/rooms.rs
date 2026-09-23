use crate::db::models::{AgentRoom, AgentRoomEvent, AgentRoomMember};
use crate::db::queries;
use crate::state::AppState;
use serde::Serialize;
use tauri::{AppHandle, State};

/// Room row plus current membership list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoomDetail {
    pub room: AgentRoom,
    pub members: Vec<AgentRoomMember>,
}

/// Per-target delivery outcome for a human board send.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomMessageDelivery {
    pub thread_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Result of `send_agent_room_message`: board event always appended when
/// targets resolve; deliveries report per-thread success/failure.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendAgentRoomMessageResult {
    pub event: AgentRoomEvent,
    pub deliveries: Vec<RoomMessageDelivery>,
}

/// Create a multi-agent room and optionally seed members from `thread_ids`.
#[tauri::command]
pub async fn create_agent_room(
    state: State<'_, AppState>,
    project_id: String,
    name: String,
    thread_ids: Vec<String>,
) -> Result<AgentRoom, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Room name must not be empty".to_string());
    }
    if project_id.trim().is_empty() {
        return Err("projectId is required".to_string());
    }

    let room = queries::create_room(&state.db, &project_id, name)
        .await
        .map_err(|e| e.to_string())?;

    for (i, thread_id) in thread_ids.iter().enumerate() {
        if thread_id.trim().is_empty() {
            continue;
        }
        queries::add_member(
            &state.db,
            &room.id,
            thread_id,
            None,
            i as i32,
        )
        .await
        .map_err(|e| e.to_string())?;
    }

    // Return latest row (membership does not mutate room fields, but keeps
    // a single source of truth if create ever stamps activity).
    queries::get_room(&state.db, &room.id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_agent_rooms(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<AgentRoom>, String> {
    queries::list_rooms(&state.db, &project_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_agent_room(
    state: State<'_, AppState>,
    room_id: String,
) -> Result<AgentRoomDetail, String> {
    let room = queries::get_room(&state.db, &room_id)
        .await
        .map_err(|e| e.to_string())?;
    let members = queries::list_members(&state.db, &room_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(AgentRoomDetail { room, members })
}

#[tauri::command]
pub async fn add_agent_room_member(
    state: State<'_, AppState>,
    room_id: String,
    thread_id: String,
    label: Option<String>,
) -> Result<AgentRoomMember, String> {
    if room_id.trim().is_empty() || thread_id.trim().is_empty() {
        return Err("roomId and threadId are required".to_string());
    }

    // Place new members after existing ones.
    let existing = queries::list_members(&state.db, &room_id)
        .await
        .map_err(|e| e.to_string())?;
    let sort_order = existing
        .iter()
        .map(|m| m.sort_order)
        .max()
        .map(|m| m + 1)
        .unwrap_or(0);

    let label_ref = label.as_deref().filter(|s| !s.trim().is_empty());
    queries::add_member(&state.db, &room_id, &thread_id, label_ref, sort_order)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_agent_room_member(
    state: State<'_, AppState>,
    room_id: String,
    thread_id: String,
) -> Result<(), String> {
    let n = queries::remove_member(&state.db, &room_id, &thread_id)
        .await
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!(
            "Member not found: room={room_id} thread={thread_id}"
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn list_agent_room_events(
    state: State<'_, AppState>,
    room_id: String,
    limit: Option<i64>,
) -> Result<Vec<AgentRoomEvent>, String> {
    queries::list_events(&state.db, &room_id, limit.unwrap_or(100), None)
        .await
        .map_err(|e| e.to_string())
}

/// Toggle A2A and optionally set max rounds for a room.
#[tauri::command]
pub async fn set_agent_room_a2a(
    state: State<'_, AppState>,
    room_id: String,
    enabled: bool,
    max_rounds: Option<i32>,
) -> Result<AgentRoom, String> {
    queries::update_room_a2a(&state.db, &room_id, enabled, max_rounds)
        .await
        .map_err(|e| e.to_string())
}

/// Delete a room; members and events cascade.
#[tauri::command]
pub async fn delete_agent_room(
    state: State<'_, AppState>,
    room_id: String,
) -> Result<(), String> {
    queries::delete_room(&state.db, &room_id)
        .await
        .map_err(|e| e.to_string())
}

/// Human board send: parse `@mentions` (or use `to_thread_id` chip), append a
/// `kind=human` event, and deliver into each target via shared dispatch.
///
/// Partial failure is reported per target in `deliveries`; the board event is
/// always written when at least one target resolves.
#[tauri::command]
pub async fn send_agent_room_message(
    app: AppHandle,
    state: State<'_, AppState>,
    room_id: String,
    text: String,
    to_thread_id: Option<String>,
) -> Result<SendAgentRoomMessageResult, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("text must not be empty".to_string());
    }
    if room_id.trim().is_empty() {
        return Err("roomId is required".to_string());
    }

    let room = queries::get_room(&state.db, &room_id)
        .await
        .map_err(|e| e.to_string())?;
    let members = queries::list_members(&state.db, &room_id)
        .await
        .map_err(|e| e.to_string())?;

    let targets = resolve_send_targets(&state, &members, text, to_thread_id.as_deref()).await?;
    if targets.is_empty() {
        return Err("no delivery targets (no members or unmatched @mentions)".to_string());
    }

    let event_to = if targets.len() == 1 {
        Some(targets[0].as_str())
    } else {
        None
    };

    let event = queries::append_event(
        &state.db,
        &room_id,
        "human",
        text,
        None,
        event_to,
        None,
    )
    .await
    .map_err(|e| e.to_string())?;

    let deliver_body = format!("[agmux-room {}] {}", room.name, text);
    let mut deliveries = Vec::with_capacity(targets.len());
    for tid in &targets {
        match crate::dispatch::send_to_thread(&app, tid, &deliver_body).await {
            Ok(()) => deliveries.push(RoomMessageDelivery {
                thread_id: tid.clone(),
                ok: true,
                error: None,
            }),
            Err(e) => deliveries.push(RoomMessageDelivery {
                thread_id: tid.clone(),
                ok: false,
                error: Some(e.to_string()),
            }),
        }
    }

    Ok(SendAgentRoomMessageResult { event, deliveries })
}

/// Agent-to-agent board post with per-pair round limits (see `rooms::a2a`).
#[tauri::command]
pub async fn post_agent_room_a2a(
    app: AppHandle,
    room_id: String,
    from_thread_id: String,
    to_thread_id: String,
    kind: String,
    body: String,
) -> Result<AgentRoomEvent, String> {
    crate::rooms::a2a::post_a2a(
        &app,
        &room_id,
        &from_thread_id,
        &to_thread_id,
        &kind,
        &body,
    )
    .await
}

/// Resolve target thread ids: explicit chip wins; else @mention parse.
async fn resolve_send_targets(
    state: &AppState,
    members: &[AgentRoomMember],
    text: &str,
    to_thread_id: Option<&str>,
) -> Result<Vec<String>, String> {
    if let Some(tid) = to_thread_id.map(str::trim).filter(|s| !s.is_empty()) {
        if !members.iter().any(|m| m.thread_id == tid) {
            return Err(format!("thread {tid} is not a member of this room"));
        }
        return Ok(vec![tid.to_string()]);
    }

    // Enrich with thread names for @name matching.
    let mut labeled: Vec<MentionMember> = Vec::with_capacity(members.len());
    for m in members {
        let name = match queries::get_thread(&state.db, &m.thread_id).await {
            Ok(t) => {
                let n = t.name.trim();
                if n.is_empty() {
                    None
                } else {
                    Some(n.to_string())
                }
            }
            Err(_) => None,
        };
        labeled.push(MentionMember {
            thread_id: m.thread_id.clone(),
            label: m
                .label
                .as_ref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            name,
        });
    }

    Ok(parse_room_mentions(text, &labeled))
}

#[derive(Debug, Clone)]
struct MentionMember {
    thread_id: String,
    label: Option<String>,
    name: Option<String>,
}

/// Pure @mention routing (mirrors `src/lib/roomMentions.ts` v1 rules).
fn parse_room_mentions(text: &str, members: &[MentionMember]) -> Vec<String> {
    let mentions = extract_mentions(text);
    let broadcast = mentions.is_empty()
        || mentions
            .iter()
            .any(|t| t.eq_ignore_ascii_case("all"));

    if broadcast {
        return unique_ids(members.iter().map(|m| m.thread_id.as_str()));
    }

    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for token in &mentions {
        for m in members {
            if seen.contains(&m.thread_id) {
                continue;
            }
            if member_matches(m, token) {
                seen.insert(m.thread_id.clone());
                out.push(m.thread_id.clone());
            }
        }
    }
    out
}

fn extract_mentions(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'@' {
            let start = i + 1;
            let mut end = start;
            while end < bytes.len() {
                let c = bytes[end];
                if c == b'@' || c.is_ascii_whitespace() {
                    break;
                }
                end += 1;
            }
            if end > start {
                if let Ok(tok) = std::str::from_utf8(&bytes[start..end]) {
                    out.push(tok.to_string());
                }
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn member_matches(m: &MentionMember, token: &str) -> bool {
    if let Some(label) = m.label.as_deref() {
        if label.eq_ignore_ascii_case(token) {
            return true;
        }
    }
    if let Some(name) = m.name.as_deref() {
        if name.eq_ignore_ascii_case(token) {
            return true;
        }
    }
    false
}

fn unique_ids<'a>(ids: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        out.push(id.to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem(id: &str, label: Option<&str>, name: Option<&str>) -> MentionMember {
        MentionMember {
            thread_id: id.into(),
            label: label.map(str::to_string),
            name: name.map(str::to_string),
        }
    }

    #[test]
    fn extract_basic() {
        assert_eq!(
            extract_mentions("hi @Claude and @codex"),
            vec!["Claude".to_string(), "codex".to_string()]
        );
        assert!(extract_mentions("no mentions").is_empty());
    }

    #[test]
    fn broadcast_no_mention_and_all() {
        let members = vec![
            mem("a", Some("Claude"), None),
            mem("b", Some("codex"), None),
        ];
        assert_eq!(
            parse_room_mentions("hello", &members),
            vec!["a".to_string(), "b".to_string()]
        );
        assert_eq!(
            parse_room_mentions("@ALL go", &members),
            vec!["a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn label_and_name_match_case_insensitive() {
        let members = vec![
            mem("a", Some("Claude"), Some("Refactor")),
            mem("b", None, Some("Grok")),
        ];
        assert_eq!(
            parse_room_mentions("@claude please", &members),
            vec!["a".to_string()]
        );
        assert_eq!(
            parse_room_mentions("@Grok please", &members),
            vec!["b".to_string()]
        );
        assert_eq!(
            parse_room_mentions("@Refactor please", &members),
            vec!["a".to_string()]
        );
    }

    #[test]
    fn multi_mention_unique() {
        let members = vec![
            mem("a", Some("Claude"), None),
            mem("b", Some("codex"), None),
            mem("c", Some("Claude"), None),
        ];
        assert_eq!(
            parse_room_mentions("@Claude @codex @CLAUDE", &members),
            vec!["a".to_string(), "c".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn unmatched_yields_empty() {
        let members = vec![mem("a", Some("Claude"), None)];
        assert!(parse_room_mentions("@nobody", &members).is_empty());
    }
}
