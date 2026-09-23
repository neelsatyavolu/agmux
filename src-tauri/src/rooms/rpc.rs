//! Room RPC: Unix-socket surface for agent-initiated room messaging.
//!
//! The agmux-memory MCP sidecar (injected into member sessions) connects here
//! so agents themselves can call `room_members` / `room_send` / `room_read`.
//! Protocol: newline-delimited JSON — `{id, method, params}` in,
//! `{id, result}` or `{id, error: {message}}` out. Methods:
//!   room.context {threadId}
//!   room.send    {fromThreadId, to, body, expectReply?, responseId?}
//!   room.read    {callerThreadId, member, maxChars?}
//!
//! Fixed socket path (`~/.agmux/room.sock`) so the sidecar needs no env
//! plumbing; stale sockets are unlinked on bind (single-app assumption, same
//! as the rest of `~/.agmux`).

use crate::db::queries;
use crate::state::AppState;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Notify;

/// `~/.agmux/room.sock` (temp dir fallback keeps tests/headless alive).
pub fn room_socket_path() -> PathBuf {
    crate::paths::agmux_home()
        .join("room.sock")
}

pub struct RoomRpcServer {
    socket_path: PathBuf,
    shutdown: Arc<Notify>,
}

impl RoomRpcServer {
    pub fn new() -> Self {
        Self {
            socket_path: room_socket_path(),
            shutdown: Arc::new(Notify::new()),
        }
    }

    pub fn start(&self, app_handle: AppHandle) {
        if let Some(dir) = self.socket_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::remove_file(&self.socket_path);

        let socket_path = self.socket_path.clone();
        let shutdown = self.shutdown.clone();

        tokio::spawn(async move {
            let listener = match UnixListener::bind(&socket_path) {
                Ok(l) => l,
                Err(e) => {
                    tracing::error!("Failed to bind room socket at {:?}: {}", socket_path, e);
                    return;
                }
            };

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ =
                    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600));
            }

            tracing::info!("Room RPC listening on {:?}", socket_path);

            loop {
                tokio::select! {
                    result = listener.accept() => {
                        match result {
                            Ok((stream, _)) => {
                                let app = app_handle.clone();
                                tokio::spawn(handle_connection(stream, app));
                            }
                            Err(e) => {
                                tracing::error!("Room socket accept error: {}", e);
                            }
                        }
                    }
                    _ = shutdown.notified() => {
                        break;
                    }
                }
            }

            let _ = std::fs::remove_file(&socket_path);
            tracing::info!("Room RPC shut down");
        });
    }

    #[allow(dead_code)]
    pub fn stop(&self) {
        self.shutdown.notify_waiters();
    }
}

async fn handle_connection(stream: UnixStream, app: AppHandle) {
    let (read_half, mut write_half) = stream.into_split();
    let mut lines = BufReader::new(read_half).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(req) => {
                let id = req.get("id").cloned().unwrap_or(Value::Null);
                let method = req
                    .get("method")
                    .and_then(|m| m.as_str())
                    .unwrap_or_default()
                    .to_string();
                let params = req.get("params").cloned().unwrap_or(json!({}));
                match dispatch_method(&app, &method, &params).await {
                    Ok(result) => json!({ "id": id, "result": result }),
                    Err(message) => json!({ "id": id, "error": { "message": message } }),
                }
            }
            Err(e) => json!({ "id": null, "error": { "message": format!("parse error: {e}") } }),
        };
        let mut out = response.to_string();
        out.push('\n');
        if write_half.write_all(out.as_bytes()).await.is_err() {
            break;
        }
    }
}

async fn dispatch_method(app: &AppHandle, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "room.context" => room_context(app, params).await,
        "room.send" => room_send(app, params).await,
        "room.read" => room_read(app, params).await,
        "room.spawn" => room_spawn(app, params).await,
        _ => Err(format!("unknown method: {method}")),
    }
}

fn str_param<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{key} is required"))
}

/// Room member enriched with thread identity for matching + display.
#[derive(Debug, Clone)]
struct MemberInfo {
    thread_id: String,
    label: Option<String>,
    name: Option<String>,
    provider: String,
    surface: &'static str,
}

/// Resolve the (most recently active) room for a thread and its members.
async fn resolve_room(
    app: &AppHandle,
    thread_id: &str,
) -> Result<(crate::db::models::AgentRoom, Vec<MemberInfo>), String> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "app state unavailable".to_string())?;
    let rooms = queries::rooms_for_thread(&state.db, thread_id)
        .await
        .map_err(|e| e.to_string())?;
    let room = rooms.into_iter().next().ok_or_else(|| {
        format!("thread {thread_id} is not a member of any multi-agent room")
    })?;
    let members = queries::list_members(&state.db, &room.id)
        .await
        .map_err(|e| e.to_string())?;

    let mut infos = Vec::with_capacity(members.len());
    for m in &members {
        let (name, provider, surface) = match queries::get_thread(&state.db, &m.thread_id).await {
            Ok(t) => {
                let name = {
                    let n = t.name.trim();
                    if n.is_empty() {
                        None
                    } else {
                        Some(n.to_string())
                    }
                };
                let surface = crate::dispatch::surface_for(&t.provider, &t.interaction_mode);
                (name, t.provider, surface)
            }
            Err(_) => (None, String::new(), "terminal"),
        };
        infos.push(MemberInfo {
            thread_id: m.thread_id.clone(),
            label: m
                .label
                .as_ref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            name,
            provider,
            surface,
        });
    }
    Ok((room, infos))
}

/// Match a `to`/`member` token against label, thread name, or thread id.
fn match_member<'a>(members: &'a [MemberInfo], token: &str) -> Option<&'a MemberInfo> {
    let token = token.trim().trim_start_matches('@');
    if token.is_empty() {
        return None;
    }
    members.iter().find(|m| {
        m.thread_id == token
            || m.label
                .as_deref()
                .is_some_and(|l| l.eq_ignore_ascii_case(token))
            || m.name
                .as_deref()
                .is_some_and(|n| n.eq_ignore_ascii_case(token))
    })
}

fn member_display(m: &MemberInfo) -> String {
    m.label
        .clone()
        .or_else(|| m.name.clone())
        .unwrap_or_else(|| m.thread_id.clone())
}

async fn room_context(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let thread_id = str_param(params, "threadId")?;
    let (room, members) = resolve_room(app, thread_id).await?;
    let member_rows: Vec<Value> = members
        .iter()
        .map(|m| {
            json!({
                "threadId": m.thread_id,
                "label": m.label,
                "name": m.name,
                "provider": m.provider,
                "surface": m.surface,
                "self": m.thread_id == thread_id,
            })
        })
        .collect();
    Ok(json!({
        "roomId": room.id,
        "roomName": room.name,
        "a2aEnabled": room.a2a_enabled != 0,
        "maxRounds": room.max_a2a_rounds,
        "members": member_rows,
    }))
}

async fn room_send(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let from_thread_id = str_param(params, "fromThreadId")?;
    let to_token = str_param(params, "to")?;
    let body = str_param(params, "body")?;
    let expect_reply = params
        .get("expectReply")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let in_reply_to = params
        .get("responseId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let (room, members) = resolve_room(app, from_thread_id).await?;
    let target = match_member(&members, to_token).ok_or_else(|| {
        let known: Vec<String> = members
            .iter()
            .filter(|m| m.thread_id != from_thread_id)
            .map(member_display)
            .collect();
        format!(
            "no room member matches \"{to_token}\" (members: {})",
            known.join(", ")
        )
    })?;
    if target.thread_id == from_thread_id {
        return Err("cannot send to yourself".to_string());
    }

    let outcome = crate::rooms::a2a::post_a2a_ext(
        app,
        &room.id,
        from_thread_id,
        &target.thread_id,
        "",
        body,
        expect_reply,
        in_reply_to,
    )
    .await?;

    Ok(json!({
        "eventId": outcome.event.id,
        "roomId": room.id,
        "toThreadId": target.thread_id,
        "toLabel": outcome.to_label,
        "round": outcome.round,
        "maxRounds": outcome.max,
        "responseId": outcome.response_id,
    }))
}

async fn room_read(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let caller = str_param(params, "callerThreadId")?;
    let member_token = str_param(params, "member")?;
    let max_chars = params
        .get("maxChars")
        .and_then(|v| v.as_i64())
        .unwrap_or(4000)
        .clamp(200, 12_000) as usize;

    let (_room, members) = resolve_room(app, caller).await?;
    let target = match_member(&members, member_token)
        .ok_or_else(|| format!("no room member matches \"{member_token}\""))?;

    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "app state unavailable".to_string())?;
    // Terminal threads log per-keystroke writes, so a small page is all
    // control noise; take a wider page and let `max_chars` bound the result.
    let page = if target.surface == "terminal" { 400 } else { 60 };
    let logs = queries::get_agent_logs(&state.db, &target.thread_id, page)
        .await
        .map_err(|e| e.to_string())?;

    // Newest-first from the query → chronological for reading. PTY threads
    // log raw terminal bytes, so strip control sequences before an agent
    // reads them (otherwise the excerpt is unreadable escape-code noise).
    let mut saw_output = false;
    let mut lines: Vec<String> = logs
        .iter()
        .rev()
        .filter(|l| l.log_type == "text" || l.log_type.is_empty())
        .filter_map(|l| {
            let clean = sanitize_log_text(&l.content);
            if clean.is_empty() {
                return None;
            }
            let is_input = l.direction == "Input";
            if !is_input {
                saw_output = true;
            }
            let tag = if is_input { ">" } else { "<" };
            Some(format!("{tag} {clean}"))
        })
        .collect();

    let (kept, truncated) = take_tail_within_budget(std::mem::take(&mut lines), max_chars);

    Ok(json!({
        "threadId": target.thread_id,
        "label": member_display(target),
        "surface": target.surface,
        "excerpt": kept.join("\n"),
        "truncated": truncated,
        // Some surfaces (Codex chat, Grok SDK) record prompts but not replies;
        // say so rather than letting the caller read a one-sided transcript as
        // if the agent had answered nothing.
        "repliesRecorded": saw_output,
    }))
}

/// Teammate provider choices an agent may spawn.
///
/// Claude and Grok can be started headlessly by `dispatch` on first delivery;
/// Codex chat needs an app-server thread minted by the UI, so it is not
/// spawnable from here.
fn spawn_provider(kind: &str) -> Result<(&'static str, &'static str), String> {
    match kind.trim().to_ascii_lowercase().as_str() {
        "" | "claude" | "claudecode" | "claude-code" => Ok(("ClaudeCode", "sdk")),
        "grok" => Ok(("Grok", "grok-sdk")),
        other => Err(format!(
            "cannot spawn provider \"{other}\" — supported: claude, grok"
        )),
    }
}

/// Create a teammate thread, add it to the caller's room, and hand it its
/// first task. Delivery starts the session (dispatch resumes dormant chats).
async fn room_spawn(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let caller = str_param(params, "callerThreadId")?;
    let label = str_param(params, "label")?;
    let task = str_param(params, "task")?;
    let (provider, interaction_mode) =
        spawn_provider(params.get("provider").and_then(|v| v.as_str()).unwrap_or(""))?;
    let model = params
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let (room, members) = resolve_room(app, caller).await?;
    if members.iter().any(|m| {
        m.label
            .as_deref()
            .is_some_and(|l| l.eq_ignore_ascii_case(label))
    }) {
        return Err(format!(
            "a member labeled \"{label}\" already exists — pick another label"
        ));
    }

    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "app state unavailable".to_string())?;
    // Inherit the caller's workspace so teammates operate on the same repo.
    let caller_thread = queries::get_thread(&state.db, caller)
        .await
        .map_err(|e| e.to_string())?;

    let thread_id = uuid::Uuid::new_v4().to_string();
    let state_dir = crate::paths::agmux_home()
        .join("threads")
        .join(&thread_id);
    let thread = queries::create_thread(
        &state.db,
        &thread_id,
        &caller_thread.project_id,
        label,
        provider,
        &caller_thread.work_dir,
        &state_dir.to_string_lossy(),
        model,
        None,
        false,
        "DirectRepo",
        None,
        Some(interaction_mode),
        None,
    )
    .await
    .map_err(|e| e.to_string())?;

    let sort_order = members.len() as i32;
    queries::add_member(&state.db, &room.id, &thread.id, Some(label), sort_order)
        .await
        .map_err(|e| e.to_string())?;

    // Board record so the human can see who joined and why.
    let _ = queries::append_event(
        &state.db,
        &room.id,
        "system",
        &format!("{label} joined ({provider})"),
        Some(caller),
        Some(&thread.id),
        Some(&json!({ "reason": "spawn", "provider": provider }).to_string()),
    )
    .await;

    // First task via the normal A2A path: policy, board event, delivery.
    let outcome = crate::rooms::a2a::post_a2a_ext(
        app,
        &room.id,
        caller,
        &thread.id,
        "task",
        task,
        params
            .get("expectReply")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
        None,
    )
    .await?;

    Ok(json!({
        "threadId": thread.id,
        "label": label,
        "provider": provider,
        "roomId": room.id,
        "responseId": outcome.response_id,
    }))
}

/// Keep the most recent lines that fit in `max_chars`, oldest-first.
///
/// A single line longer than the budget is kept as its own tail rather than
/// dropped — one long reply (or a PTY output blob) must never collapse the
/// whole excerpt to nothing. Returns `(lines, truncated)`.
fn take_tail_within_budget(lines: Vec<String>, max_chars: usize) -> (Vec<String>, bool) {
    let mut kept: Vec<String> = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;

    for line in lines.into_iter().rev() {
        let remaining = max_chars.saturating_sub(total);
        if remaining == 0 {
            truncated = true;
            break;
        }
        let cost = line.chars().count() + 1;
        if cost <= remaining {
            total += cost;
            kept.push(line);
            continue;
        }
        // Too big for what's left: keep this line's tail if it's worth reading.
        truncated = true;
        if remaining > 80 {
            let take = remaining - 1;
            let skip = line.chars().count().saturating_sub(take);
            let tail: String = line.chars().skip(skip).collect();
            kept.push(format!("…{tail}"));
        }
        break;
    }

    kept.reverse();
    (kept, truncated)
}

/// Strip ANSI/OSC escape sequences and control chars from a log line, and
/// collapse whitespace. PTY threads store raw terminal output.
fn sanitize_log_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                // OSC: ESC ] ... BEL | ESC \
                Some(']') => {
                    chars.next();
                    while let Some(n) = chars.next() {
                        if n == '\x07' {
                            break;
                        }
                        if n == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                // CSI: ESC [ params final-byte
                Some('[') => {
                    chars.next();
                    for n in chars.by_ref() {
                        if n.is_ascii_alphabetic() || n == '~' {
                            break;
                        }
                    }
                }
                // Other two-char escapes.
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
            continue;
        }
        if c == '\n' || c == '\t' {
            out.push(' ');
        } else if !c.is_control() {
            out.push(c);
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(id: &str, label: Option<&str>, name: Option<&str>) -> MemberInfo {
        MemberInfo {
            thread_id: id.into(),
            label: label.map(str::to_string),
            name: name.map(str::to_string),
            provider: "ClaudeCode".into(),
            surface: "chat",
        }
    }

    #[test]
    fn match_member_label_name_id_and_at_prefix() {
        let members = vec![
            info("t1", Some("main"), Some("Main · Fable")),
            info("t2", None, Some("Reviewer")),
        ];
        assert_eq!(match_member(&members, "main").unwrap().thread_id, "t1");
        assert_eq!(match_member(&members, "@MAIN").unwrap().thread_id, "t1");
        assert_eq!(match_member(&members, "reviewer").unwrap().thread_id, "t2");
        assert_eq!(match_member(&members, "t2").unwrap().thread_id, "t2");
        assert!(match_member(&members, "nobody").is_none());
        assert!(match_member(&members, "  ").is_none());
    }

    #[test]
    fn spawn_provider_maps_supported_kinds() {
        assert_eq!(spawn_provider("").unwrap(), ("ClaudeCode", "sdk"));
        assert_eq!(spawn_provider("claude").unwrap(), ("ClaudeCode", "sdk"));
        assert_eq!(spawn_provider("Claude-Code").unwrap(), ("ClaudeCode", "sdk"));
        assert_eq!(spawn_provider("Grok").unwrap(), ("Grok", "grok-sdk"));
        // Codex chat needs a UI-minted app-server thread — must not silently
        // create a thread that dispatch can never deliver to.
        let err = spawn_provider("codex").unwrap_err();
        assert!(err.contains("codex"), "{err}");
        assert!(err.contains("supported"), "{err}");
    }

    #[test]
    fn budget_keeps_newest_and_never_empties_on_one_long_line() {
        // Fits entirely → chronological order preserved.
        let (kept, trunc) = take_tail_within_budget(
            vec!["a".into(), "b".into(), "c".into()],
            100,
        );
        assert_eq!(kept, vec!["a", "b", "c"]);
        assert!(!trunc);

        // Over budget → newest kept, oldest dropped.
        let (kept, trunc) =
            take_tail_within_budget(vec!["x".repeat(50), "y".repeat(50)], 60);
        assert_eq!(kept.len(), 1);
        assert!(kept[0].starts_with('y'));
        assert!(trunc);

        // A single line bigger than the whole budget must still yield its tail
        // (regression: this returned an EMPTY excerpt for long replies / PTY).
        let long = format!("{}TAIL_END", "z".repeat(5000));
        let (kept, trunc) = take_tail_within_budget(vec![long], 200);
        assert_eq!(kept.len(), 1, "long line must not collapse to nothing");
        assert!(kept[0].starts_with('…'));
        assert!(kept[0].ends_with("TAIL_END"), "keeps the most recent tail");
        assert!(kept[0].chars().count() <= 200);
        assert!(trunc);

        // Multi-byte safety: budget counts chars, never splits a char.
        let (kept, _) = take_tail_within_budget(vec!["é".repeat(500)], 120);
        assert!(kept[0].chars().count() <= 120);
    }

    #[test]
    fn sanitize_strips_pty_escape_noise() {
        // Real Grok PTY prefix captured from agent_logs.
        let raw = "\u{1b}]0;grok\u{7}\u{1b}[?1049h\u{1b}[?1000h\u{1b}[?25l\u{1b}]12;rgb:c8/c8/c8\u{7}Fix onboarding bug";
        assert_eq!(sanitize_log_text(raw), "Fix onboarding bug");

        // ESC \ terminated OSC, CSI with ~, tabs/newlines collapse.
        assert_eq!(sanitize_log_text("\u{1b}]0;t\u{1b}\\ok"), "ok");
        assert_eq!(sanitize_log_text("a\u{1b}[3~b"), "ab");
        assert_eq!(sanitize_log_text("a\n\tb   c"), "a b c");

        // Pure control noise collapses to empty (line gets dropped).
        assert!(sanitize_log_text("\u{1b}[?25l\u{1b}[2J").is_empty());
        // Plain text is untouched.
        assert_eq!(sanitize_log_text("hello world"), "hello world");
    }

    #[test]
    fn member_display_prefers_label() {
        assert_eq!(member_display(&info("t1", Some("main"), Some("N"))), "main");
        assert_eq!(member_display(&info("t1", None, Some("N"))), "N");
        assert_eq!(member_display(&info("t1", None, None)), "t1");
    }
}
