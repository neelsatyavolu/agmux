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

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Change {
    Publish { request_id: String, tool_name: String, detail: String },
    Resolve { request_id: String },
}

struct Pending {
    request_id: String,
    signature: String,
}

/// At most one open terminal dialog per thread (the CLI shows one at a time).
#[derive(Default)]
pub(crate) struct Tracker {
    pending: HashMap<String, Pending>,
}

impl Tracker {
    fn resolve(&mut self, thread_id: &str) -> Option<Change> {
        self.pending.remove(thread_id).map(|p| Change::Resolve { request_id: p.request_id })
    }

    /// `live_provider` is the provider of the thread's live PTY, if any.
    pub(crate) fn on_hook(
        &mut self,
        thread_id: &str,
        hook_provider: Option<&str>,
        event: &str,
        payload: &Value,
        live_provider: Option<&str>,
    ) -> Vec<Change> {
        match event {
            "permission-request" => {
                // A new dialog replaces whatever the previous one was.
                let mut changes: Vec<Change> = self.resolve(thread_id).into_iter().collect();
                let name = tool_name(payload);
                let answerable = live_provider.is_some_and(|p| {
                    approval_keys(p, true).is_some() && hook_matches_provider(p, hook_provider)
                });
                if answerable && !is_question_tool(name) {
                    let request_id = format!("term-{}", uuid::Uuid::new_v4());
                    self.pending.insert(thread_id.to_string(), Pending {
                        request_id: request_id.clone(),
                        signature: call_signature(payload),
                    });
                    changes.push(Change::Publish {
                        request_id,
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

fn apply(app: &AppHandle, thread_id: &str, changes: Vec<Change>) {
    for change in changes {
        match change {
            Change::Publish { request_id, tool_name, detail } => {
                super::notify_approval(app, thread_id, &request_id, &tool_name, &detail);
            }
            Change::Resolve { request_id } => {
                super::notify_approval_resolved(app, &request_id, Some(thread_id));
            }
        }
    }
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
    let live_provider = if event == "permission-request" {
        match app.try_state::<crate::state::AppState>() {
            Some(state) => {
                let sessions = state.sessions.lock().await;
                match sessions.get(thread_id) {
                    Some(session) if session.is_alive().await => Some(session.provider.clone()),
                    _ => None,
                }
            }
            None => None,
        }
    } else {
        None
    };
    let changes = with_tracker(|t| t.on_hook(thread_id, hook_provider, event, payload, live_provider.as_deref()));
    apply(app, thread_id, changes);
}

/// Desktop typed into the terminal (see `send_pty_input`).
pub(crate) fn on_desktop_input(app: &AppHandle, thread_id: &str, data: &str) {
    let change = with_tracker(|t| t.on_desktop_input(thread_id, data));
    apply(app, thread_id, change.into_iter().collect());
}

/// The thread's terminal process exited.
pub(crate) fn forget(app: &AppHandle, thread_id: &str) {
    let change = with_tracker(|t| t.forget(thread_id));
    apply(app, thread_id, change.into_iter().collect());
}

/// Drop tracking without a resolve: the caller clears the phone cards itself.
pub(crate) fn discard(thread_id: &str) {
    with_tracker(|t| t.forget(thread_id));
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
        let changes = t.on_hook("t1", None, "permission-request", &permission("ls -la"), Some("ClaudeCode"));
        assert!(matches!(&changes[..], [Change::Publish { tool_name, detail, .. }]
            if tool_name == "Bash" && detail == "ls -la"));

        assert!(t.on_hook("t2", None, "permission-request", &permission("ls"), None).is_empty(), "no live PTY");
        assert!(t.on_hook("t3", Some("grok"), "permission-request", &permission("ls"), Some("Grok")).is_empty());
        assert!(t.on_hook("t4", Some("kimi"), "permission-request", &permission("ls"), Some("ClaudeCode")).is_empty(),
            "a hook from another provider must not drive this PTY");
        assert!(published(&t.on_hook("t5", Some("kimi"), "permission-request", &permission("ls"), Some("Kimi"))).is_some());
        let question = json!({ "tool_name": "AskUserQuestion", "tool_input": {} });
        assert!(t.on_hook("t6", None, "permission-request", &question, Some("ClaudeCode")).is_empty());
    }

    #[test]
    fn same_call_pre_tool_use_keeps_the_card_but_the_next_call_resolves_it() {
        let mut t = Tracker::default();
        let id = published(&t.on_hook("t1", None, "permission-request", &permission("make"), Some("ClaudeCode"))).unwrap();
        // Async PreToolUse for the same call arriving after the dialog.
        assert!(t.on_hook("t1", None, "pre-tool-use", &permission("make"), None).is_empty());
        assert_eq!(
            t.on_hook("t1", None, "pre-tool-use", &permission("make test"), None),
            vec![Change::Resolve { request_id: id }],
        );
        assert!(t.on_hook("t1", None, "stop", &json!({}), None).is_empty(), "already resolved");
    }

    #[test]
    fn stop_prompt_and_session_end_resolve_the_open_dialog() {
        for event in ["stop", "prompt-submit", "session-end", "post-tool-use"] {
            let mut t = Tracker::default();
            let id = published(&t.on_hook("t1", None, "permission-request", &permission("ls"), Some("ClaudeCode"))).unwrap();
            assert!(t.on_hook("t2", None, event, &json!({}), None).is_empty(), "other threads are untouched");
            assert_eq!(t.on_hook("t1", None, event, &json!({}), None), vec![Change::Resolve { request_id: id }]);
        }
    }

    #[test]
    fn a_new_dialog_replaces_the_previous_request() {
        let mut t = Tracker::default();
        let first = published(&t.on_hook("t1", None, "permission-request", &permission("a"), Some("ClaudeCode"))).unwrap();
        let changes = t.on_hook("t1", None, "permission-request", &permission("b"), Some("ClaudeCode"));
        assert_eq!(changes[0], Change::Resolve { request_id: first.clone() });
        assert_ne!(published(&changes).unwrap(), first);
    }

    #[test]
    fn desktop_answer_keys_resolve_but_terminal_reports_do_not() {
        let mut t = Tracker::default();
        let id = published(&t.on_hook("t1", None, "permission-request", &permission("ls"), Some("ClaudeCode"))).unwrap();
        for noise in ["\x1b[I", "\x1b[A", "\x1b]11;rgb:0/0/0\x07", "abc", "12"] {
            assert!(t.on_desktop_input("t1", noise).is_none(), "{noise:?}");
        }
        assert_eq!(t.on_desktop_input("t1", "2"), Some(Change::Resolve { request_id: id }));
        assert!(t.on_desktop_input("t1", "\r").is_none());
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
