//! Phone approvals for terminal (PTY) sessions.
//!
//! Chat runtimes hand agmux a structured request id; terminals only announce
//! the native permission dialog through the `permission-request` hook. This
//! tracker turns that hook into one pending phone approval per thread and
//! settles it when the dialog is certainly gone (next tool, next prompt,
//! stop, session end, PTY exit, or the user answering on the desktop).
//!
//! Only providers whose dialog has a known keyboard contract are published:
//! Claude Code and Kimi both render a numbered menu where `1` allows once and
//! Esc denies. Grok's `approval_required` fires before its classifier decides
//! whether a menu appears at all, agy has no permission hook, and Codex MCP
//! forms are screen-scraped — none of those are answerable blind.
//!
//! Claude Code's AskUserQuestion menu is published as a phone question and
//! answered by keystrokes (see `question_keys`); its plan-approval menu is not.

use serde_json::Value;
use std::collections::HashMap;
use tauri::{AppHandle, Manager};

/// Longest detail sent to phones (characters). The desktop terminal shows the
/// same command/path in its own dialog; this only bounds the frame.
const DETAIL_MAX_CHARS: usize = 200;

/// Keys that answer a live terminal permission dialog, or `None` when the
/// provider's dialog cannot be answered safely by keystroke.
pub(crate) fn approval_keys(provider: &str, approve: bool) -> Option<&'static str> {
    match provider {
        "ClaudeCode" | "Kimi" => Some(if approve { "1" } else { "\x1b" }),
        _ => None,
    }
}

/// The hook relay label that belongs to each answerable PTY provider.
fn hook_matches_provider(pty_provider: &str, hook_provider: Option<&str>) -> bool {
    match pty_provider {
        "ClaudeCode" => hook_provider.unwrap_or("claude") == "claude",
        "Kimi" => hook_provider == Some("kimi"),
        _ => false,
    }
}

/// Question/plan dialogs reuse the permission flow but their option 1 is an
/// answer or a plan acceptance, not "allow this tool once".
fn is_question_tool(tool_name: &str) -> bool {
    matches!(tool_name, "AskUserQuestion" | "ExitPlanMode" | "ask_user_question" | "ask_question")
}

fn hook_str<'a>(payload: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|k| payload.get(*k).and_then(Value::as_str)).filter(|s| !s.is_empty())
}

fn tool_name(payload: &Value) -> &str {
    hook_str(payload, &["tool_name", "toolName"]).unwrap_or("")
}

fn tool_input(payload: &Value) -> &Value {
    payload.get("tool_input").or_else(|| payload.get("toolInput")).unwrap_or(&Value::Null)
}

/// Identity of a tool call as both PreToolUse and PermissionRequest carry it.
fn call_signature(payload: &Value) -> String {
    format!("{}\u{1f}{}", tool_name(payload), tool_input(payload))
}

/// One-line, bounded command/path for the phone card.
fn approval_detail(payload: &Value) -> String {
    let input = tool_input(payload);
    let raw = hook_str(input, &["command", "file_path", "filePath", "notebook_path", "path", "url", "pattern"])
        .unwrap_or("");
    let line = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= DETAIL_MAX_CHARS {
        return line;
    }
    let mut cut: String = line.chars().take(DETAIL_MAX_CHARS).collect();
    cut.push('…');
    cut
}

/// Claude Code draws AskUserQuestion as numbered menus; digits past 9 don't exist.
const MAX_QUESTION_OPTIONS: usize = 8;
const KEY_DOWN: &str = "\x1b[B";

/// The questions of a Claude Code AskUserQuestion call, when its terminal
/// menu can be answered by keystroke.
fn answerable_questions(provider: &str, tool_name: &str, payload: &Value) -> Option<Value> {
    if provider != "ClaudeCode" || tool_name != "AskUserQuestion" {
        return None;
    }
    let questions = tool_input(payload).get("questions")?.as_array()?;
    let answerable = !questions.is_empty() && questions.iter().all(|q| {
        q.get("question").and_then(Value::as_str).is_some_and(|s| !s.is_empty())
            && q.get("options").and_then(Value::as_array)
                .is_some_and(|o| !o.is_empty() && o.len() <= MAX_QUESTION_OPTIONS)
    });
    answerable.then(|| Value::Array(questions.clone()))
}

fn option_labels(question: &Value) -> Vec<&str> {
    question.get("options").and_then(Value::as_array).into_iter().flatten()
        .map(|o| o.get("label").and_then(Value::as_str).unwrap_or(""))
        .collect()
}

/// Typed answers go in as one chunk of printable text on a single line.
fn typed_text(text: &str) -> String {
    let line: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    line.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Split a phone multi-select answer (the chosen labels joined by ", ",
/// custom text last) into option indexes plus leftover custom text.
fn split_multi_answer(answer: &str, labels: &[&str]) -> (Vec<usize>, String) {
    let mut picked = Vec::new();
    let mut rest = answer.trim();
    loop {
        let next = labels.iter().enumerate()
            .filter(|(i, l)| !l.is_empty() && !picked.contains(i))
            .filter(|(_, l)| rest == **l || rest.starts_with(&format!("{l}, ")))
            .max_by_key(|(_, l)| l.len());
        let Some((i, label)) = next else { break };
        picked.push(i);
        rest = rest[label.len()..].trim_start_matches(", ").trim();
    }
    picked.sort_unstable();
    (picked, rest.to_string())
}

/// Keystrokes that answer Claude Code's AskUserQuestion menu, one write each
/// (Ink ignores several keys arriving in one read). Verified against Claude
/// Code 2.1.283:
/// - single choice: the option's digit picks it and moves on; custom text is
///   the "Type something" digit, the text, then Enter;
/// - multi choice: digits toggle without moving the cursor (row 1); custom
///   text is typed on the "Type something" row; the "Submit" row under it
///   (reached with Down) moves on when Enter is pressed;
/// - several questions or any multi choice end on a review screen where `1`
///   submits; a lone single-choice question submits immediately.
/// `answers` is the phone reply: `{ answers: { [question]: "A, B" } }`, or
/// `{ error }` when dismissed (Esc cancels the menu).
pub(crate) fn question_keys(questions: &Value, answers: &Value) -> Result<Vec<String>, String> {
    let questions = questions.as_array().ok_or("invalid question")?;
    let Some(map) = answers.get("answers").and_then(Value::as_object) else {
        return Ok(vec!["\x1b".into()]);
    };
    let mut keys = Vec::new();
    let mut review = questions.len() > 1;
    for question in questions {
        let text = question.get("question").and_then(Value::as_str).unwrap_or("");
        let answer = map.get(text)
            .or_else(|| question.get("header").and_then(Value::as_str).and_then(|h| map.get(h)))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|a| !a.is_empty())
            .ok_or_else(|| format!("missing answer for \"{text}\""))?;
        let labels = option_labels(question);
        let other = labels.len() + 1;
        if question.get("multiSelect").and_then(Value::as_bool) == Some(true) {
            review = true;
            let (picked, custom) = split_multi_answer(answer, &labels);
            keys.extend(picked.iter().map(|i| (i + 1).to_string()));
            let custom = typed_text(&custom);
            // Row 1 → "Type something" is one Down per option; Submit is one more.
            let downs = if custom.is_empty() { labels.len() + 1 } else { labels.len() };
            keys.extend(std::iter::repeat(KEY_DOWN.to_string()).take(downs));
            if !custom.is_empty() {
                keys.push(custom);
                keys.push(KEY_DOWN.into());
            }
            keys.push("\r".into());
        } else if let Some(i) = labels.iter().position(|l| *l == answer) {
            keys.push((i + 1).to_string());
        } else {
            keys.push(other.to_string());
            keys.push(typed_text(answer));
            keys.push("\r".into());
        }
    }
    if review {
        keys.push("1".into());
    }
    Ok(keys)
}

/// `remote_id` is the id phones list the session under (see `phone_thread_id`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Change {
    Publish { request_id: String, remote_id: String, tool_name: String, detail: String },
    Resolve { request_id: String, remote_id: String },
    Ask { request_id: String, remote_id: String, questions: Value },
    ResolveQuestion { request_id: String, remote_id: String },
}

struct Pending {
    request_id: String,
    /// Where the card was published, so it resolves there too.
    remote_id: String,
    signature: String,
    /// Set for an AskUserQuestion menu (a phone question, not an approval).
    questions: Option<Value>,
}

/// At most one open terminal dialog per thread (the CLI shows one at a time).
#[derive(Default)]
pub(crate) struct Tracker {
    pending: HashMap<String, Pending>,
}

impl Tracker {
    fn resolve(&mut self, thread_id: &str) -> Option<Change> {
        self.pending.remove(thread_id).map(|p| match p.questions {
            Some(_) => Change::ResolveQuestion { request_id: p.request_id, remote_id: p.remote_id },
            None => Change::Resolve { request_id: p.request_id, remote_id: p.remote_id },
        })
    }

    /// The terminal holding the open request `request_id`, as (PTY id, phone
    /// id), when `phone_thread_id` names it by either id.
    fn find(&self, phone_thread_id: &str, request_id: &str) -> Option<(String, String)> {
        self.pending.iter()
            .find(|(id, p)| p.request_id == request_id
                && (id.as_str() == phone_thread_id || p.remote_id == phone_thread_id))
            .map(|(id, p)| (id.clone(), p.remote_id.clone()))
    }

    fn pending_questions(&self, thread_id: &str, request_id: &str) -> Option<&Value> {
        self.pending.get(thread_id)
            .filter(|p| p.request_id == request_id)
            .and_then(|p| p.questions.as_ref())
    }

    /// `live` is the thread's live PTY, if any: its provider and the id phones
    /// list it under.
    pub(crate) fn on_hook(
        &mut self,
        thread_id: &str,
        hook_provider: Option<&str>,
        event: &str,
        payload: &Value,
        live: Option<(&str, &str)>,
    ) -> Vec<Change> {
        match event {
            "permission-request" => {
                // A new dialog replaces whatever the previous one was.
                let mut changes: Vec<Change> = self.resolve(thread_id).into_iter().collect();
                let name = tool_name(payload);
                let Some((provider, remote_id)) = live.filter(|(p, _)| {
                    approval_keys(p, true).is_some() && hook_matches_provider(p, hook_provider)
                }) else {
                    return changes;
                };
                let remote_id = remote_id.to_string();
                if let Some(questions) = answerable_questions(provider, name, payload) {
                    let request_id = format!("term-{}", uuid::Uuid::new_v4());
                    self.pending.insert(thread_id.to_string(), Pending {
                        request_id: request_id.clone(),
                        remote_id: remote_id.clone(),
                        signature: call_signature(payload),
                        questions: Some(questions.clone()),
                    });
                    changes.push(Change::Ask { request_id, remote_id, questions });
                } else if !is_question_tool(name) {
                    let request_id = format!("term-{}", uuid::Uuid::new_v4());
                    self.pending.insert(thread_id.to_string(), Pending {
                        request_id: request_id.clone(),
                        remote_id: remote_id.clone(),
                        signature: call_signature(payload),
                        questions: None,
                    });
                    changes.push(Change::Publish {
                        request_id,
                        remote_id,
                        tool_name: if name.is_empty() { "Tool".into() } else { name.to_string() },
                        detail: approval_detail(payload),
                    });
                }
                changes
            }
            // PreToolUse is async and may land after the dialog it precedes;
            // only a different call proves the dialog was answered.
            "pre-tool-use" => {
                let moved_on = self.pending.get(thread_id)
                    .is_some_and(|p| p.signature != call_signature(payload));
                if moved_on { self.resolve(thread_id).into_iter().collect() } else { Vec::new() }
            }
            "post-tool-use" | "prompt-submit" | "stop" | "session-end" | "session-start" => {
                self.resolve(thread_id).into_iter().collect()
            }
            _ => Vec::new(),
        }
    }

    /// Desktop keystrokes that answer a numbered dialog (digit, Enter, Esc,
    /// Ctrl-C). Terminal reports (`ESC [ …`), arrows and text are ignored.
    pub(crate) fn on_desktop_input(&mut self, thread_id: &str, data: &str) -> Option<Change> {
        let answers = matches!(data, "\r" | "\x1b" | "\x03")
            || (data.len() == 1 && data.as_bytes()[0].is_ascii_digit());
        if answers { self.resolve(thread_id) } else { None }
    }

    pub(crate) fn forget(&mut self, thread_id: &str) -> Option<Change> {
        self.resolve(thread_id)
    }
}

static TRACKER: std::sync::Mutex<Option<Tracker>> = std::sync::Mutex::new(None);

fn with_tracker<T>(f: impl FnOnce(&mut Tracker) -> T) -> T {
    let mut guard = TRACKER.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(Tracker::default))
}

fn apply(app: &AppHandle, changes: Vec<Change>) {
    for change in changes {
        match change {
            Change::Publish { request_id, remote_id, tool_name, detail } => {
                super::notify_approval(app, &remote_id, &request_id, &tool_name, &detail);
            }
            Change::Resolve { request_id, remote_id } => {
                super::notify_approval_resolved(app, &request_id, Some(&remote_id));
            }
            Change::Ask { request_id, remote_id, questions } => {
                super::notify_user_input(app, &remote_id, &request_id, questions);
            }
            Change::ResolveQuestion { request_id, remote_id } => {
                super::notify_user_input_resolved(app, &request_id, Some(&remote_id));
            }
        }
    }
}

/// The id phones list a live Claude terminal under. One started in agmux has
/// no threads row: its PTY and hooks carry agmux's own id, while the phone
/// lists the transcript by Claude's session id (`payload.session_id`).
async fn phone_thread_id(pool: &sqlx::SqlitePool, thread_id: &str, payload: &Value) -> String {
    let Some(native) = hook_str(payload, &["session_id"]).filter(|sid| *sid != thread_id) else {
        return thread_id.to_string();
    };
    let has_row = sqlx::query_scalar::<_, i64>("SELECT 1 FROM threads WHERE id = ? LIMIT 1")
        .bind(thread_id)
        .fetch_optional(pool)
        .await
        .map_or(true, |row| row.is_some());
    if has_row { thread_id.to_string() } else { native.to_string() }
}

/// Hook events after parsing (never alters the hook socket protocol).
pub(crate) async fn on_hook_event(
    app: &AppHandle,
    hook_provider: Option<&str>,
    event: &str,
    thread_id: &str,
    payload: &Value,
) {
    if !matches!(
        event,
        "permission-request" | "pre-tool-use" | "post-tool-use" | "prompt-submit" | "stop" | "session-end" | "session-start"
    ) {
        return;
    }
    let live = if event == "permission-request" {
        match app.try_state::<crate::state::AppState>() {
            Some(state) => {
                let provider = {
                    let sessions = state.sessions.lock().await;
                    match sessions.get(thread_id) {
                        Some(session) if session.is_alive().await => Some(session.provider.clone()),
                        _ => None,
                    }
                };
                match provider {
                    Some(p) if p == "ClaudeCode" => Some((p, phone_thread_id(&state.db, thread_id, payload).await)),
                    Some(p) => Some((p, thread_id.to_string())),
                    None => None,
                }
            }
            None => None,
        }
    } else {
        None
    };
    let live = live.as_ref().map(|(p, id)| (p.as_str(), id.as_str()));
    let changes = with_tracker(|t| t.on_hook(thread_id, hook_provider, event, payload, live));
    apply(app, changes);
}

/// Desktop typed into the terminal (see `send_pty_input`).
pub(crate) fn on_desktop_input(app: &AppHandle, thread_id: &str, data: &str) {
    let change = with_tracker(|t| t.on_desktop_input(thread_id, data));
    apply(app, change.into_iter().collect());
}

/// The thread's terminal process exited.
pub(crate) fn forget(app: &AppHandle, thread_id: &str) {
    let change = with_tracker(|t| t.forget(thread_id));
    apply(app, change.into_iter().collect());
}

/// The live terminal whose open dialog is `request_id`, as (PTY id, phone id),
/// when the phone's `thread_id` names it. Phone replies route through this, not
/// a thread lookup: a Claude terminal started in agmux has no threads row.
pub(crate) fn pending_terminal(thread_id: &str, request_id: &str) -> Option<(String, String)> {
    with_tracker(|t| t.find(thread_id, request_id))
}

/// Drop tracking without a resolve: the caller clears the phone cards itself.
pub(crate) fn discard(thread_id: &str) {
    with_tracker(|t| t.forget(thread_id));
}

/// Keys answering the open AskUserQuestion menu `request_id` with the phone's
/// reply, or an error when that menu is no longer open.
pub(crate) fn pending_question_keys(thread_id: &str, request_id: &str, answers: &Value) -> Result<Vec<String>, String> {
    with_tracker(|t| {
        let questions = t.pending_questions(thread_id, request_id)
            .ok_or("question already answered")?;
        question_keys(questions, answers)
    })
}

/// True while `request_id` is still the open dialog of `thread_id` (a desktop
/// answer key, next tool, stop or exit settles it).
pub(crate) fn is_pending(thread_id: &str, request_id: &str) -> bool {
    with_tracker(|t| t.pending.get(thread_id).is_some_and(|p| p.request_id == request_id))
}

/// The phone answered `request_id`; its resolution is already sent.
pub(crate) fn answered(thread_id: &str, request_id: &str) {
    with_tracker(|t| {
        if t.pending.get(thread_id).is_some_and(|p| p.request_id == request_id) {
            t.pending.remove(thread_id);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn permission(command: &str) -> Value {
        json!({ "tool_name": "Bash", "tool_input": { "command": command } })
    }

    fn published(changes: &[Change]) -> Option<String> {
        changes.iter().find_map(|c| match c {
            Change::Publish { request_id, .. } => Some(request_id.clone()),
            _ => None,
        })
    }

    #[test]
    fn keys_follow_the_numbered_dialog_contract() {
        for provider in ["ClaudeCode", "Kimi"] {
            assert_eq!(approval_keys(provider, true), Some("1"));
            assert_eq!(approval_keys(provider, false), Some("\x1b"), "Esc denies; Enter would pick Yes");
        }
        for provider in ["Grok", "Gemini", "Codex", "Droid", "Shell"] {
            assert_eq!(approval_keys(provider, true), None);
        }
    }

    #[test]
    fn permission_request_publishes_only_for_answerable_live_terminals() {
        let mut t = Tracker::default();
        let changes = t.on_hook("t1", None, "permission-request", &permission("ls -la"), Some(("ClaudeCode", "t1")));
        assert!(matches!(&changes[..], [Change::Publish { tool_name, detail, .. }]
            if tool_name == "Bash" && detail == "ls -la"));

        assert!(t.on_hook("t2", None, "permission-request", &permission("ls"), None).is_empty(), "no live PTY");
        assert!(t.on_hook("t3", Some("grok"), "permission-request", &permission("ls"), Some(("Grok", "t3"))).is_empty());
        assert!(t.on_hook("t4", Some("kimi"), "permission-request", &permission("ls"), Some(("ClaudeCode", "t4"))).is_empty(),
            "a hook from another provider must not drive this PTY");
        assert!(published(&t.on_hook("t5", Some("kimi"), "permission-request", &permission("ls"), Some(("Kimi", "t5")))).is_some());
        let question = json!({ "tool_name": "AskUserQuestion", "tool_input": {} });
        assert!(t.on_hook("t6", None, "permission-request", &question, Some(("ClaudeCode", "t6"))).is_empty());
    }

    #[test]
    fn same_call_pre_tool_use_keeps_the_card_but_the_next_call_resolves_it() {
        let mut t = Tracker::default();
        let id = published(&t.on_hook("t1", None, "permission-request", &permission("make"), Some(("ClaudeCode", "t1")))).unwrap();
        // Async PreToolUse for the same call arriving after the dialog.
        assert!(t.on_hook("t1", None, "pre-tool-use", &permission("make"), None).is_empty());
        assert_eq!(
            t.on_hook("t1", None, "pre-tool-use", &permission("make test"), None),
            vec![Change::Resolve { request_id: id, remote_id: "t1".into() }],
        );
        assert!(t.on_hook("t1", None, "stop", &json!({}), None).is_empty(), "already resolved");
    }

    #[test]
    fn stop_prompt_and_session_end_resolve_the_open_dialog() {
        for event in ["stop", "prompt-submit", "session-end", "post-tool-use"] {
            let mut t = Tracker::default();
            let id = published(&t.on_hook("t1", None, "permission-request", &permission("ls"), Some(("ClaudeCode", "t1")))).unwrap();
            assert!(t.on_hook("t2", None, event, &json!({}), None).is_empty(), "other threads are untouched");
            assert_eq!(t.on_hook("t1", None, event, &json!({}), None), vec![Change::Resolve { request_id: id, remote_id: "t1".into() }]);
        }
    }

    #[test]
    fn a_new_dialog_replaces_the_previous_request() {
        let mut t = Tracker::default();
        let first = published(&t.on_hook("t1", None, "permission-request", &permission("a"), Some(("ClaudeCode", "t1")))).unwrap();
        let changes = t.on_hook("t1", None, "permission-request", &permission("b"), Some(("ClaudeCode", "t1")));
        assert_eq!(changes[0], Change::Resolve { request_id: first.clone(), remote_id: "t1".into() });
        assert_ne!(published(&changes).unwrap(), first);
    }

    #[test]
    fn desktop_answer_keys_resolve_but_terminal_reports_do_not() {
        let mut t = Tracker::default();
        let id = published(&t.on_hook("t1", None, "permission-request", &permission("ls"), Some(("ClaudeCode", "t1")))).unwrap();
        for noise in ["\x1b[I", "\x1b[A", "\x1b]11;rgb:0/0/0\x07", "abc", "12"] {
            assert!(t.on_desktop_input("t1", noise).is_none(), "{noise:?}");
        }
        assert_eq!(t.on_desktop_input("t1", "2"), Some(Change::Resolve { request_id: id, remote_id: "t1".into() }));
        assert!(t.on_desktop_input("t1", "\r").is_none());
    }

    #[test]
    fn cards_use_the_phone_id_and_replies_find_the_terminal_by_request() {
        // A Claude terminal started in agmux: PTY "pty", listed on phones as "native".
        let mut t = Tracker::default();
        let changes = t.on_hook("pty", None, "permission-request", &permission("ls"), Some(("ClaudeCode", "native")));
        let [Change::Publish { request_id, remote_id, .. }] = &changes[..] else { panic!("{changes:?}") };
        assert_eq!(remote_id, "native");
        let found = Some(("pty".to_string(), "native".to_string()));
        assert_eq!(t.find("native", request_id), found);
        assert_eq!(t.find("pty", request_id), found);
        assert_eq!(t.find("other", request_id), None, "another session's id never answers it");
        assert_eq!(t.find("native", "term-other"), None);
        assert_eq!(t.on_hook("pty", None, "stop", &json!({}), None),
            vec![Change::Resolve { request_id: request_id.clone(), remote_id: "native".into() }],
            "resolves where it was published");
        assert_eq!(t.find("native", request_id), None);
    }

    #[tokio::test]
    async fn claude_terminals_without_a_thread_row_are_listed_by_transcript_id() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE threads (id TEXT PRIMARY KEY)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO threads VALUES ('row')").execute(&pool).await.unwrap();
        let payload = json!({ "session_id": "native" });
        assert_eq!(phone_thread_id(&pool, "placeholder", &payload).await, "native");
        assert_eq!(phone_thread_id(&pool, "row", &payload).await, "row", "rows are listed by their own id");
        assert_eq!(phone_thread_id(&pool, "native", &payload).await, "native");
        assert_eq!(phone_thread_id(&pool, "placeholder", &json!({})).await, "placeholder");
    }

    fn ask(questions: Value) -> Value {
        json!({ "tool_name": "AskUserQuestion", "tool_input": { "questions": questions } })
    }

    fn color() -> Value {
        json!({ "question": "Which color?", "header": "Color", "multiSelect": false,
            "options": [{ "label": "Red", "description": "r" }, { "label": "Blue", "description": "b" }] })
    }

    fn fruits() -> Value {
        json!({ "question": "Which fruits?", "header": "Fruit", "multiSelect": true,
            "options": [{ "label": "Apple" }, { "label": "Pear" }, { "label": "Plum" }] })
    }

    fn keys(questions: Value, answers: Value) -> Vec<String> {
        question_keys(&questions, &json!({ "answers": answers })).unwrap()
    }

    const DOWN: &str = "\x1b[B";

    #[test]
    fn claude_terminal_questions_publish_as_phone_questions() {
        let mut t = Tracker::default();
        let changes = t.on_hook("t1", None, "permission-request", &ask(json!([color()])), Some(("ClaudeCode", "t1")));
        let [Change::Ask { request_id, questions, .. }] = &changes[..] else { panic!("{changes:?}") };
        assert_eq!(questions, &json!([color()]));
        assert_eq!(pending_keys(&t, "t1", request_id), vec!["2"]);
        assert!(t.pending_questions("t1", "term-other").is_none(), "only the open request answers");
        assert_eq!(t.on_hook("t1", None, "stop", &json!({}), None),
            vec![Change::ResolveQuestion { request_id: request_id.clone(), remote_id: "t1".into() }]);

        assert!(t.on_hook("t2", Some("kimi"), "permission-request", &ask(json!([color()])), Some(("Kimi", "t2"))).is_empty(),
            "only Claude's menu contract is verified");
        let plan = json!({ "tool_name": "ExitPlanMode", "tool_input": { "plan": "x" } });
        assert!(t.on_hook("t3", None, "permission-request", &plan, Some(("ClaudeCode", "t3"))).is_empty());
        let too_many = json!({ "question": "Pick", "options": (0..9).map(|i| json!({ "label": i.to_string() })).collect::<Vec<_>>() });
        assert!(t.on_hook("t4", None, "permission-request", &ask(json!([too_many])), Some(("ClaudeCode", "t4"))).is_empty());
    }

    fn pending_keys(t: &Tracker, thread_id: &str, request_id: &str) -> Vec<String> {
        let questions = t.pending_questions(thread_id, request_id).unwrap();
        question_keys(questions, &json!({ "answers": { "Which color?": "Blue" } })).unwrap()
    }

    #[test]
    fn single_choice_keys_pick_or_type() {
        assert_eq!(keys(json!([color()]), json!({ "Which color?": "Blue" })), vec!["2"]);
        assert_eq!(keys(json!([color()]), json!({ "Which color?": "teal\nish" })), vec!["3", "teal ish", "\r"]);
        let size = json!({ "question": "Which size?", "options": [{ "label": "Small" }, { "label": "Large" }] });
        assert_eq!(keys(json!([color(), size]), json!({ "Which color?": "Blue", "Which size?": "Large" })),
            vec!["2", "2", "1"], "several questions end on the review screen");
    }

    #[test]
    fn multi_choice_keys_toggle_then_submit() {
        assert_eq!(keys(json!([fruits()]), json!({ "Which fruits?": "Apple, Plum" })),
            vec!["1", "3", DOWN, DOWN, DOWN, DOWN, "\r", "1"]);
        assert_eq!(keys(json!([fruits()]), json!({ "Which fruits?": "Apple, kiwi" })),
            vec!["1", DOWN, DOWN, DOWN, "kiwi", DOWN, "\r", "1"]);
        let commas = json!({ "question": "Q", "multiSelect": true,
            "options": [{ "label": "Red, dark" }, { "label": "Red" }] });
        assert_eq!(keys(json!([commas]), json!({ "Q": "Red, Red, dark" })),
            vec!["1", "2", DOWN, DOWN, DOWN, "\r", "1"]);
    }

    #[test]
    fn dismissed_or_incomplete_answers() {
        assert_eq!(question_keys(&json!([color()]), &json!({ "error": "User dismissed the question." })).unwrap(),
            vec!["\x1b"]);
        assert!(question_keys(&json!([color()]), &json!({ "answers": { "Other?": "Blue" } })).is_err());
        assert_eq!(keys(json!([color()]), json!({ "Color": "Red" })), vec!["1"], "header works as the key too");
    }

    #[test]
    fn detail_is_one_bounded_line() {
        let long = format!("echo {}\n  done", "x".repeat(400));
        let detail = approval_detail(&permission(&long));
        assert!(!detail.contains('\n'));
        assert_eq!(detail.chars().count(), DETAIL_MAX_CHARS + 1);
        let edit = json!({ "tool_name": "Edit", "tool_input": { "file_path": "/tmp/example.rs" } });
        assert_eq!(approval_detail(&edit), "/tmp/example.rs");
    }
}
