//! Live Claude terminals whose PTY id differs from their transcript id.
//!
//! A Claude terminal started in agmux runs under agmux's own id (the PTY key
//! and the hooks' `AGMUX_THREAD_ID`), even after a resume, while Claude names
//! the conversation by its own session id, which is the id phones list it
//! under. Claude's SessionStart and UserPromptSubmit hooks carry both ids and
//! keep this map current, so phone sends, stops and model changes reach the
//! running terminal instead of resuming a second copy of the conversation.

use std::collections::HashMap;

use crate::state::AppState;

#[derive(Default)]
struct Aliases {
    /// transcript id → PTY id
    by_transcript: HashMap<String, String>,
}

impl Aliases {
    /// `pty_id` now runs `transcript_id`. A terminal runs one conversation at
    /// a time (`/clear` moves it to a new transcript), so older entries for it go.
    fn note(&mut self, pty_id: &str, transcript_id: &str) {
        self.by_transcript.retain(|_, pty| pty != pty_id);
        if !transcript_id.is_empty() && transcript_id != pty_id {
            self.by_transcript.insert(transcript_id.to_string(), pty_id.to_string());
        }
    }

    fn get(&self, transcript_id: &str) -> Option<String> {
        self.by_transcript.get(transcript_id).cloned()
    }

    fn transcript_of(&self, pty_id: &str) -> Option<String> {
        self.by_transcript.iter().find(|(_, pty)| *pty == pty_id).map(|(t, _)| t.clone())
    }
}

static ALIASES: std::sync::Mutex<Option<Aliases>> = std::sync::Mutex::new(None);

fn with_aliases<T>(f: impl FnOnce(&mut Aliases) -> T) -> T {
    let mut guard = ALIASES.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(Aliases::default))
}

/// A Claude hook from terminal `pty_id` reported its session id. Recorded only
/// for live Claude terminals, so chats and other providers never enter the map.
pub(crate) async fn note_hook(state: &AppState, pty_id: &str, transcript_id: &str) {
    let is_claude_pty = state.sessions.lock().await
        .get(pty_id)
        .is_some_and(|s| s.provider == "ClaudeCode");
    if is_claude_pty {
        note(pty_id, transcript_id);
    }
}

/// Claude terminal `pty_id` now runs `transcript_id`.
pub(crate) fn note(pty_id: &str, transcript_id: &str) {
    with_aliases(|a| a.note(pty_id, transcript_id));
}

/// The transcript a Claude terminal last reported running, if it differs
/// from the terminal's own id.
pub(crate) fn transcript_of(pty_id: &str) -> Option<String> {
    with_aliases(|a| a.transcript_of(pty_id))
}

/// The PTY id to drive for a phone thread id: the id itself when a terminal
/// runs under it, else the live Claude terminal running that transcript. An
/// entry whose terminal has exited is ignored, so it never needs clearing.
pub(crate) async fn terminal_id(state: &AppState, id: &str) -> String {
    let Some(pty_id) = with_aliases(|a| a.get(id)) else {
        return id.to_string();
    };
    let sessions = state.sessions.lock().await;
    let own_live = match sessions.get(id) {
        Some(session) => session.is_alive().await,
        None => false,
    };
    let alias_live = match sessions.get(&pty_id) {
        Some(session) => session.provider == "ClaudeCode" && session.is_alive().await,
        None => false,
    };
    pick(id, pty_id, own_live, alias_live)
}

/// A terminal running under the phone's id wins; otherwise the mapped
/// terminal, only while it is a live Claude terminal.
fn pick(id: &str, pty_id: String, own_live: bool, alias_live: bool) -> String {
    if !own_live && alias_live { pty_id } else { id.to_string() }
}

#[cfg(test)]
mod tests {
    use super::{pick, Aliases};

    #[test]
    fn drives_the_mapped_terminal_only_while_it_is_live() {
        assert_eq!(pick("native", "pty".into(), false, true), "pty");
        assert_eq!(pick("native", "pty".into(), false, false), "native",
            "an exited terminal falls back to the normal resume path");
        assert_eq!(pick("native", "pty".into(), true, true), "native",
            "a terminal running under the phone's id wins");
    }

    #[test]
    fn maps_a_transcript_to_the_terminal_running_it() {
        let mut a = Aliases::default();
        a.note("pty", "native");
        assert_eq!(a.get("native").as_deref(), Some("pty"));
        assert_eq!(a.get("pty"), None, "the PTY id needs no mapping");
        assert_eq!(a.get("other"), None);
        assert_eq!(a.transcript_of("pty").as_deref(), Some("native"));
        assert_eq!(a.transcript_of("native"), None);
    }

    #[test]
    fn clear_moves_the_terminal_to_its_new_transcript() {
        let mut a = Aliases::default();
        a.note("pty", "before-clear");
        a.note("pty", "after-clear");
        assert_eq!(a.get("before-clear"), None, "the old conversation no longer runs there");
        assert_eq!(a.get("after-clear").as_deref(), Some("pty"));
    }

    #[test]
    fn same_id_or_missing_session_id_records_nothing() {
        let mut a = Aliases::default();
        a.note("pty", "native");
        a.note("pty", "pty");
        assert_eq!(a.get("native"), None, "a terminal under its own id drops older entries");
        a.note("pty", "");
        assert!(a.by_transcript.is_empty());
    }

    #[test]
    fn a_newer_terminal_takes_over_a_transcript() {
        let mut a = Aliases::default();
        a.note("old", "native");
        a.note("new", "native");
        assert_eq!(a.get("native").as_deref(), Some("new"));
    }
}
