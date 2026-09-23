//! Runtime-only routing helpers. No credentials or provider output text is stored here.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_APPROVAL: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct RequestIds {
    // UI ids are global; native ids are meaningful only within one process.
    ids: HashMap<u64, u64>,
    answered: HashMap<u64, u64>,
}

impl RequestIds {
    pub fn register(&mut self, native: u64) -> u64 {
        if let Some(public) = self.ids.iter().find_map(|(p, n)| (*n == native).then_some(*p)) {
            return public;
        }
        let public = NEXT_APPROVAL.fetch_add(1, Ordering::Relaxed);
        self.ids.insert(public, native);
        public
    }
    pub fn native(&self, public: u64) -> Option<u64> { self.ids.get(&public).copied() }
    pub fn remove(&mut self, public: u64) {
        if let Some(native) = self.ids.remove(&public) {
            // Resolution receipts can arrive after the response is written.
            // Bound tombstones for servers which omit those receipts.
            if self.answered.len() >= 4096 { self.answered.clear(); }
            self.answered.insert(native, public);
        }
    }
    pub fn resolve(&mut self, native: u64) -> Option<u64> {
        if let Some(public) = self.ids.iter().find_map(|(p, n)| (*n == native).then_some(*p)) {
            self.ids.remove(&public);
            Some(public)
        } else { self.answered.remove(&native) }
    }
}

pub fn server_key(work_dir: &str, account_id: Option<&str>) -> String {
    match account_id {
        Some(account) => format!("{}\0{}", work_dir, account),
        None => work_dir.to_string(),
    }
}

/// Provider-owned quota windows only; never pass model/tool/terminal text here.
pub fn exhausted_window(used: Option<f64>, reset: Option<i64>, now: i64) -> Option<Option<i64>> {
    let used = used?;
    if !used.is_finite() || used < 100.0 || reset.is_some_and(|r| r <= now) { return None; }
    Some(reset)
}

#[derive(Default)]
pub struct NativeBoundary {
    complete: bool,
    pending: std::collections::HashSet<String>,
}
impl NativeBoundary {
    pub fn started(&mut self) { self.complete = false; }
    pub fn completed(&mut self) { self.complete = true; }
    pub fn tool_started(&mut self, id: &str) { self.pending.insert(id.to_string()); }
    pub fn tool_completed(&mut self, id: &str) { self.pending.remove(id); }
    pub fn idle(&self) -> bool { self.complete && self.pending.is_empty() }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_boundary_requires_completion_and_no_pending_tools() {
        let mut state = NativeBoundary::default();
        assert!(!state.idle());
        state.started(); state.tool_started("tool"); state.completed();
        assert!(!state.idle());
        state.tool_completed("tool");
        assert!(state.idle());
        state.started();
        assert!(!state.idle());
    }
    #[test]
    fn resolved_notification_keeps_public_id_after_answer() {
        let mut ids = RequestIds::default();
        let public = ids.register(7);
        ids.remove(public);
        assert_eq!(ids.native(public), None);
        assert_eq!(ids.resolve(7), Some(public));
        assert_eq!(ids.resolve(7), None);
    }
    #[test]
    fn exhaustion_requires_measured_unexpired_window() {
        assert_eq!(exhausted_window(None, None, 10), None);
        assert_eq!(exhausted_window(Some(f64::NAN), None, 10), None);
        assert_eq!(exhausted_window(Some(99.9), None, 10), None);
        assert_eq!(exhausted_window(Some(100.0), Some(9), 10), None);
        assert_eq!(exhausted_window(Some(100.0), Some(20), 10), Some(Some(20)));
        assert_eq!(exhausted_window(Some(100.0), None, 10), Some(None));
    }
    #[test]
    fn same_native_request_on_two_processes_cannot_cross_approve() {
        let mut a = RequestIds::default();
        let mut b = RequestIds::default();
        let first = a.register(0);
        let second = b.register(0);
        assert_ne!(first, second);
        assert_eq!(a.native(first), Some(0));
        assert_eq!(b.native(first), None);
        assert_eq!(a.register(0), first);
        assert_eq!(a.resolve(0), Some(first));
        assert_eq!(a.native(first), None);
    }
    #[test]
    fn account_server_keys_preserve_legacy_and_isolate_accounts() {
        assert_eq!(server_key("/repo", None), "/repo");
        assert_ne!(server_key("/repo", Some("a")), server_key("/repo", Some("b")));
        assert_ne!(server_key("/repo", Some("a")), server_key("/repo/a", None));
    }
}
