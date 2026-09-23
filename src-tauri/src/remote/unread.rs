//! Mirror of the desktop sidebar "done / unread" set (green pulse).
//!
//! Source of truth is the webview `uiStore.unreadSessionIds`. The frontend
//! pushes the current set via `remote_sync_unread` whenever it changes; the
//! remote catalog reads it here so phones show the same green pulse. Phone
//! `thread.read` clears an id here and asks the webview to drop it too.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

fn unread_set() -> &'static Mutex<HashSet<String>> {
    static UNREAD: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    UNREAD.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn set_unread_ids(ids: impl IntoIterator<Item = String>) {
    let mut guard = unread_set().lock().unwrap_or_else(|e| e.into_inner());
    *guard = ids.into_iter().filter(|s| !s.is_empty()).collect();
}

pub fn is_unread(id: &str) -> bool {
    if id.is_empty() {
        return false;
    }
    unread_set()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(id)
}

/// True if this thread (or its provider session id) is marked unread.
pub fn thread_is_unread(thread_id: &str, sdk_session_id: Option<&str>) -> bool {
    if is_unread(thread_id) {
        return true;
    }
    if let Some(sid) = sdk_session_id {
        if !sid.is_empty() && is_unread(sid) {
            return true;
        }
    }
    false
}

/// Clear unread for a thread id and any aliased provider session id.
/// Returns true if something was actually marked unread.
pub fn clear_unread(thread_id: &str, sdk_session_id: Option<&str>) -> bool {
    let mut guard = unread_set().lock().unwrap_or_else(|e| e.into_inner());
    let mut changed = guard.remove(thread_id);
    if let Some(sid) = sdk_session_id {
        if !sid.is_empty() {
            changed = guard.remove(sid) || changed;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_and_clear() {
        set_unread_ids(["a".into(), "b".into()]);
        assert!(is_unread("a"));
        assert!(thread_is_unread("x", Some("b")));
        assert!(clear_unread("x", Some("b")));
        assert!(!is_unread("b"));
        assert!(is_unread("a"));
        set_unread_ids(Vec::<String>::new());
    }
}
