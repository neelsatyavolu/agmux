//! Agent-to-agent (A2A) post path with per-pair round limits.
//!
//! Round counting v1: since the last `kind=human` board event for the room,
//! count `kind=a2a` events involving the unordered pair `{from,to}`. When
//! that count already meets `max_a2a_rounds`, refuse the post, append a
//! system event, and return Err.

use crate::db::models::{AgentRoomEvent, AgentRoomMember};
use crate::db::queries;
use crate::state::AppState;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

/// System board body written when a pair hits its round cap.
pub const A2A_MAX_ROUNDS_BODY: &str = "A2A stopped: max rounds";

/// Result of the pure A2A policy check (before board append / delivery).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct A2aRoundDecision {
    /// 1-based round number for the message about to be posted.
    pub round: i32,
    pub max: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum A2aPolicyError {
    Disabled,
    NotMember { thread_id: String },
    /// Existing pair count already at/over max; caller should append system event.
    MaxRounds { max: i32, count: i32 },
}

impl A2aPolicyError {
    pub fn message(&self) -> String {
        match self {
            A2aPolicyError::Disabled => "A2A is disabled for this room".into(),
            A2aPolicyError::NotMember { thread_id } => {
                format!("thread {thread_id} is not a member of this room")
            }
            A2aPolicyError::MaxRounds { max, count } => {
                format!("A2A stopped: max rounds ({count}/{max})")
            }
        }
    }
}

/// True when an event's from/to endpoints match the unordered pair `{a,b}`.
pub fn event_involves_pair(
    from_thread_id: Option<&str>,
    to_thread_id: Option<&str>,
    a: &str,
    b: &str,
) -> bool {
    match (from_thread_id, to_thread_id) {
        (Some(f), Some(t)) => (f == a && t == b) || (f == b && t == a),
        _ => false,
    }
}

/// Count `kind=a2a` events involving `{from,to}` after the latest `kind=human`.
///
/// `events` must be **newest-first** (same order as `queries::list_events`).
pub fn count_a2a_for_pair_since_last_human(
    events: &[AgentRoomEvent],
    from: &str,
    to: &str,
) -> i32 {
    let mut count = 0i32;
    for e in events {
        if e.kind == "human" {
            break;
        }
        if e.kind != "a2a" {
            continue;
        }
        if event_involves_pair(
            e.from_thread_id.as_deref(),
            e.to_thread_id.as_deref(),
            from,
            to,
        ) {
            count += 1;
        }
    }
    count
}

/// Membership + enabled flag + round limit (pure; no I/O).
pub fn decide_a2a_round(
    a2a_enabled: i32,
    max_a2a_rounds: i32,
    members: &[AgentRoomMember],
    events_newest_first: &[AgentRoomEvent],
    from_thread_id: &str,
    to_thread_id: &str,
) -> Result<A2aRoundDecision, A2aPolicyError> {
    if a2a_enabled == 0 {
        return Err(A2aPolicyError::Disabled);
    }
    if !members.iter().any(|m| m.thread_id == from_thread_id) {
        return Err(A2aPolicyError::NotMember {
            thread_id: from_thread_id.to_string(),
        });
    }
    if !members.iter().any(|m| m.thread_id == to_thread_id) {
        return Err(A2aPolicyError::NotMember {
            thread_id: to_thread_id.to_string(),
        });
    }

    let max = max_a2a_rounds.max(1);
    let count = count_a2a_for_pair_since_last_human(
        events_newest_first,
        from_thread_id,
        to_thread_id,
    );
    if count >= max {
        return Err(A2aPolicyError::MaxRounds { max, count });
    }

    Ok(A2aRoundDecision {
        round: count + 1,
        max,
    })
}

/// Delivery envelope injected into the target thread (Traycer-style reply threads).
///
/// `response_id`: the sender expects a reply on this thread — tell the receiver
/// exactly how to answer. `in_reply_to`: this message closes that thread.
#[allow(clippy::too_many_arguments)]
pub fn format_a2a_envelope_ext(
    room_id: &str,
    from_label: &str,
    round: i32,
    max: i32,
    kind: &str,
    body: &str,
    response_id: Option<&str>,
    in_reply_to: Option<&str>,
) -> String {
    let mut out = format!(
        "[agmux-a2a room={room_id} from={from_label} round={round}/{max} kind={kind}]"
    );
    if let Some(rid) = in_reply_to {
        out.push_str(&format!("\n[agmux-a2a] This is a reply on thread {rid}."));
    }
    if let Some(rid) = response_id {
        out.push_str(&format!(
            "\n[agmux-a2a] A reply is expected. Call the room_send tool with response_id=\"{rid}\". One reply on this thread answers every message received on it."
        ));
    }
    out.push('\n');
    out.push_str(body);
    out
}

/// Find the open reply thread from `from` → `to`, newest-first scan.
///
/// A thread is open when an `a2a` event by `from` targeting `to` carries
/// `meta.expectReply == true` and no newer event answers its `responseId`
/// (`meta.inReplyTo`). Used to keep `response_id` idempotent per pair.
pub fn find_open_response_id(
    events_newest_first: &[AgentRoomEvent],
    from: &str,
    to: &str,
) -> Option<String> {
    let mut replied: std::collections::HashSet<String> = std::collections::HashSet::new();
    for e in events_newest_first {
        if e.kind != "a2a" {
            continue;
        }
        let meta: serde_json::Value = e
            .meta_json
            .as_deref()
            .and_then(|m| serde_json::from_str(m).ok())
            .unwrap_or(serde_json::Value::Null);
        if let Some(rid) = meta.get("inReplyTo").and_then(|v| v.as_str()) {
            replied.insert(rid.to_string());
        }
        let is_pair = e.from_thread_id.as_deref() == Some(from)
            && e.to_thread_id.as_deref() == Some(to);
        if !is_pair {
            continue;
        }
        if meta.get("expectReply").and_then(|v| v.as_bool()) != Some(true) {
            continue;
        }
        if let Some(rid) = meta.get("responseId").and_then(|v| v.as_str()) {
            if !replied.contains(rid) {
                return Some(rid.to_string());
            }
        }
    }
    None
}

fn member_label<'a>(members: &'a [AgentRoomMember], thread_id: &'a str) -> &'a str {
    members
        .iter()
        .find(|m| m.thread_id == thread_id)
        .and_then(|m| m.label.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(thread_id)
}

/// Post an A2A message: policy check → board event → deliver to `to_thread_id`.
///
/// On max-rounds: appends a system board event and returns `Err` with a clear
/// message so the UI can surface it.
pub async fn post_a2a(
    app: &AppHandle,
    room_id: &str,
    from_thread_id: &str,
    to_thread_id: &str,
    kind: &str,
    body: &str,
) -> Result<AgentRoomEvent, String> {
    post_a2a_ext(app, room_id, from_thread_id, to_thread_id, kind, body, false, None)
        .await
        .map(|o| o.event)
}

/// Outcome of an extended A2A post (agent-initiated sends need the thread id).
#[derive(Debug, Clone)]
pub struct A2aPostOutcome {
    pub event: AgentRoomEvent,
    /// Reply-thread id when the sender expects a reply (reused if one is open).
    pub response_id: Option<String>,
    pub round: i32,
    pub max: i32,
    pub to_label: String,
}

/// `post_a2a` plus Traycer-style reply threads: `expect_reply` mints (or
/// reuses) a `responseId`; `in_reply_to` marks this message as closing that
/// thread. Meta and delivery envelope carry both.
#[allow(clippy::too_many_arguments)]
pub async fn post_a2a_ext(
    app: &AppHandle,
    room_id: &str,
    from_thread_id: &str,
    to_thread_id: &str,
    kind: &str,
    body: &str,
    expect_reply: bool,
    in_reply_to: Option<&str>,
) -> Result<A2aPostOutcome, String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("body must not be empty".into());
    }
    if room_id.trim().is_empty()
        || from_thread_id.trim().is_empty()
        || to_thread_id.trim().is_empty()
    {
        return Err("roomId, fromThreadId, and toThreadId are required".into());
    }

    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "app state unavailable".to_string())?;
    let pool = &state.db;

    let room = queries::get_room(pool, room_id)
        .await
        .map_err(|e| e.to_string())?;
    let members = queries::list_members(pool, room_id)
        .await
        .map_err(|e| e.to_string())?;
    // Newest-first; high enough page for round counting within a human turn.
    let events = queries::list_events(pool, room_id, 500, None)
        .await
        .map_err(|e| e.to_string())?;

    let decision = match decide_a2a_round(
        room.a2a_enabled,
        room.max_a2a_rounds,
        &members,
        &events,
        from_thread_id,
        to_thread_id,
    ) {
        Ok(d) => d,
        Err(A2aPolicyError::MaxRounds { max, count }) => {
            let _ = queries::append_event(
                pool,
                room_id,
                "system",
                A2A_MAX_ROUNDS_BODY,
                Some(from_thread_id),
                Some(to_thread_id),
                Some(
                    &json!({
                        "reason": "max_a2a_rounds",
                        "max": max,
                        "count": count,
                        "fromThreadId": from_thread_id,
                        "toThreadId": to_thread_id,
                    })
                    .to_string(),
                ),
            )
            .await
            .map_err(|e| e.to_string())?;
            return Err(A2aPolicyError::MaxRounds { max, count }.message());
        }
        Err(e) => return Err(e.message()),
    };

    let kind = {
        let k = kind.trim();
        if k.is_empty() {
            if in_reply_to.is_some() {
                "reply"
            } else {
                "message"
            }
        } else {
            k
        }
    };

    // Reply-thread bookkeeping: reuse the open thread for this pair, else mint.
    let response_id = if expect_reply {
        Some(
            find_open_response_id(&events, from_thread_id, to_thread_id)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        )
    } else {
        None
    };

    let mut meta = json!({
        "round": decision.round,
        "max": decision.max,
        "kind": kind,
    });
    if let Some(rid) = &response_id {
        meta["expectReply"] = json!(true);
        meta["responseId"] = json!(rid);
    }
    if let Some(rid) = in_reply_to {
        meta["inReplyTo"] = json!(rid);
    }

    let event = queries::append_event(
        pool,
        room_id,
        "a2a",
        body,
        Some(from_thread_id),
        Some(to_thread_id),
        Some(&meta.to_string()),
    )
    .await
    .map_err(|e| e.to_string())?;

    // Live board refresh for agent-initiated posts (UI posts already refetch).
    let _ = app.emit("agent-room-event", &event);

    let from_label = member_label(&members, from_thread_id);
    let envelope = format_a2a_envelope_ext(
        room_id,
        from_label,
        decision.round,
        decision.max,
        kind,
        body,
        response_id.as_deref(),
        in_reply_to,
    );

    crate::dispatch::send_to_thread(app, to_thread_id, &envelope)
        .await
        .map_err(|e| e.to_string())?;

    let to_label = member_label(&members, to_thread_id).to_string();
    Ok(A2aPostOutcome {
        event,
        response_id,
        round: decision.round,
        max: decision.max,
        to_label,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::AgentRoomEvent;

    fn ev(
        kind: &str,
        from: Option<&str>,
        to: Option<&str>,
        id: &str,
    ) -> AgentRoomEvent {
        AgentRoomEvent {
            id: id.into(),
            room_id: "r1".into(),
            kind: kind.into(),
            from_thread_id: from.map(str::to_string),
            to_thread_id: to.map(str::to_string),
            body: String::new(),
            meta_json: None,
            created_at: id.into(),
        }
    }

    fn mem(thread_id: &str) -> AgentRoomMember {
        AgentRoomMember {
            room_id: "r1".into(),
            thread_id: thread_id.into(),
            label: None,
            sort_order: 0,
        }
    }

    #[test]
    fn involves_pair_unordered() {
        assert!(event_involves_pair(Some("a"), Some("b"), "a", "b"));
        assert!(event_involves_pair(Some("b"), Some("a"), "a", "b"));
        assert!(!event_involves_pair(Some("a"), Some("c"), "a", "b"));
        assert!(!event_involves_pair(Some("a"), None, "a", "b"));
        assert!(!event_involves_pair(None, Some("b"), "a", "b"));
    }

    #[test]
    fn count_zero_when_empty() {
        assert_eq!(count_a2a_for_pair_since_last_human(&[], "a", "b"), 0);
    }

    #[test]
    fn count_stops_at_human_newest_first() {
        // newest → oldest
        let events = vec![
            ev("a2a", Some("a"), Some("b"), "3"),
            ev("a2a", Some("b"), Some("a"), "2"),
            ev("human", None, None, "1"),
            ev("a2a", Some("a"), Some("b"), "0"), // before human — ignored
        ];
        assert_eq!(count_a2a_for_pair_since_last_human(&events, "a", "b"), 2);
    }

    #[test]
    fn count_ignores_other_pairs_and_kinds() {
        let events = vec![
            ev("a2a", Some("a"), Some("c"), "4"),
            ev("agent", Some("a"), Some("b"), "3"),
            ev("a2a", Some("a"), Some("b"), "2"),
            ev("system", None, None, "1"),
        ];
        assert_eq!(count_a2a_for_pair_since_last_human(&events, "a", "b"), 1);
    }

    #[test]
    fn under_limit_allows_next_round() {
        let members = vec![mem("a"), mem("b")];
        let events = vec![
            ev("a2a", Some("a"), Some("b"), "2"),
            ev("a2a", Some("b"), Some("a"), "1"),
        ];
        // max=4, count=2 → round 3
        let d = decide_a2a_round(1, 4, &members, &events, "a", "b").unwrap();
        assert_eq!(d, A2aRoundDecision { round: 3, max: 4 });
    }

    #[test]
    fn at_limit_stops() {
        let members = vec![mem("a"), mem("b")];
        let events = vec![
            ev("a2a", Some("a"), Some("b"), "4"),
            ev("a2a", Some("b"), Some("a"), "3"),
            ev("a2a", Some("a"), Some("b"), "2"),
            ev("a2a", Some("b"), Some("a"), "1"),
        ];
        let err = decide_a2a_round(1, 4, &members, &events, "a", "b").unwrap_err();
        assert_eq!(err, A2aPolicyError::MaxRounds { max: 4, count: 4 });
        assert!(err.message().contains("max rounds"));
    }

    #[test]
    fn human_resets_pair_counter() {
        let members = vec![mem("a"), mem("b")];
        let events = vec![
            // newest: one a2a after human
            ev("a2a", Some("a"), Some("b"), "3"),
            ev("human", None, None, "2"),
            // older a2a burst would have hit max=2
            ev("a2a", Some("a"), Some("b"), "1"),
            ev("a2a", Some("b"), Some("a"), "0"),
        ];
        let d = decide_a2a_round(1, 2, &members, &events, "a", "b").unwrap();
        assert_eq!(d.round, 2);
        assert_eq!(d.max, 2);
    }

    #[test]
    fn disabled_and_not_member() {
        let members = vec![mem("a"), mem("b")];
        assert_eq!(
            decide_a2a_round(0, 4, &members, &[], "a", "b").unwrap_err(),
            A2aPolicyError::Disabled
        );
        assert_eq!(
            decide_a2a_round(1, 4, &members, &[], "a", "z").unwrap_err(),
            A2aPolicyError::NotMember {
                thread_id: "z".into()
            }
        );
        assert_eq!(
            decide_a2a_round(1, 4, &members, &[], "z", "b").unwrap_err(),
            A2aPolicyError::NotMember {
                thread_id: "z".into()
            }
        );
    }

    #[test]
    fn envelope_format() {
        let s = format_a2a_envelope_ext(
            "rid", "Claude", 2, 4, "question", "hello", None, None,
        );
        assert_eq!(
            s,
            "[agmux-a2a room=rid from=Claude round=2/4 kind=question]\nhello"
        );
    }

    #[test]
    fn envelope_ext_reply_lines() {
        let s = format_a2a_envelope_ext(
            "rid", "Claude", 1, 4, "question", "hello", Some("R1"), None,
        );
        assert!(s.starts_with("[agmux-a2a room=rid from=Claude round=1/4 kind=question]"));
        assert!(s.contains("A reply is expected"));
        assert!(s.contains("response_id=\"R1\""));
        assert!(s.ends_with("\nhello"));

        let r = format_a2a_envelope_ext(
            "rid", "codex", 2, 4, "reply", "answer", None, Some("R1"),
        );
        assert!(r.contains("This is a reply on thread R1."));
        assert!(!r.contains("A reply is expected"));
    }

    fn ev_meta(
        kind: &str,
        from: Option<&str>,
        to: Option<&str>,
        id: &str,
        meta: serde_json::Value,
    ) -> AgentRoomEvent {
        let mut e = ev(kind, from, to, id);
        e.meta_json = Some(meta.to_string());
        e
    }

    #[test]
    fn open_response_id_found_and_reused() {
        let events = vec![ev_meta(
            "a2a",
            Some("a"),
            Some("b"),
            "1",
            json!({"expectReply": true, "responseId": "R1"}),
        )];
        assert_eq!(
            find_open_response_id(&events, "a", "b"),
            Some("R1".to_string())
        );
        // Direction matters: b→a has no open thread.
        assert_eq!(find_open_response_id(&events, "b", "a"), None);
    }

    #[test]
    fn replied_thread_is_closed() {
        // newest-first: reply from b closes R1.
        let events = vec![
            ev_meta("a2a", Some("b"), Some("a"), "2", json!({"inReplyTo": "R1"})),
            ev_meta(
                "a2a",
                Some("a"),
                Some("b"),
                "1",
                json!({"expectReply": true, "responseId": "R1"}),
            ),
        ];
        assert_eq!(find_open_response_id(&events, "a", "b"), None);
    }

    #[test]
    fn open_response_ignores_fire_and_forget_and_bad_meta() {
        let events = vec![
            ev("a2a", Some("a"), Some("b"), "3"), // no meta
            ev_meta("a2a", Some("a"), Some("b"), "2", json!({"kind": "message"})),
            ev_meta(
                "a2a",
                Some("a"),
                Some("b"),
                "1",
                json!({"expectReply": true, "responseId": "R9"}),
            ),
        ];
        assert_eq!(
            find_open_response_id(&events, "a", "b"),
            Some("R9".to_string())
        );
    }
}
