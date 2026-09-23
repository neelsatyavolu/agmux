//! Pure selection policy: missing quota is not evidence of spare capacity.
#[derive(Clone)]
pub struct Candidate<'a> {
    pub id: &'a str,
    pub enabled: bool,
    pub needs_login: bool,
    pub priority: i64,
    pub remaining: Option<f64>,
    pub blocked_until: Option<i64>,
    pub active: usize,
}

/// A connected native login remains primary unless its quota is confirmed exhausted.
pub fn use_native_primary(auto_switch: bool, exhausted: bool) -> bool { !auto_switch || !exhausted }

pub fn choose<'a>(accounts: &'a [Candidate<'a>], now: i64) -> Option<&'a str> {
    accounts.iter().filter(|a| a.enabled && !a.needs_login
        && !a.blocked_until.is_some_and(|until| until > now)
        && !(a.remaining == Some(0.0) && !a.blocked_until.is_some_and(|until| until <= now)))
        .min_by(|a, b| a.priority.cmp(&b.priority)
            .then_with(|| b.remaining.unwrap_or(-1.0).total_cmp(&a.remaining.unwrap_or(-1.0)))
            .then_with(|| a.active.cmp(&b.active))
            .then_with(|| a.id.cmp(b.id)))
        .map(|a| a.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn account(id: &str) -> Candidate<'_> {
        Candidate { id, enabled: true, needs_login: false, priority: 0,
            remaining: None, blocked_until: None, active: 0 }
    }
    #[test]
    fn adding_an_account_cannot_displace_a_healthy_or_unknown_native_login() {
        assert!(use_native_primary(true, false));
        assert!(use_native_primary(false, false));
        assert!(use_native_primary(false, true));
        assert!(!use_native_primary(true, true));
    }
    #[test]
    fn skips_disabled_invalid_and_blocked() {
        let mut rows = vec![account("paused"), account("invalid"), account("blocked"), account("ready")];
        rows[0].enabled = false;
        rows[1].needs_login = true;
        rows[2].blocked_until = Some(101);
        assert_eq!(choose(&rows, 100), Some("ready"));
    }
    #[test]
    fn prefers_priority_then_capacity_then_low_load() {
        let mut rows = vec![account("a"), account("b")];
        rows[0].remaining = Some(20.0);
        rows[1].remaining = Some(80.0);
        assert_eq!(choose(&rows, 100), Some("b"));
        rows[0].priority = -1;
        assert_eq!(choose(&rows, 100), Some("a"));
        rows[0].priority = 0;
        rows[0].remaining = Some(80.0);
        rows[0].active = 1;
        assert_eq!(choose(&rows, 100), Some("b"));
    }
    #[test]
    fn exhausted_unknown_reset_requires_recheck() {
        let mut rows = vec![account("a")];
        rows[0].remaining = Some(0.0);
        assert_eq!(choose(&rows, 100), None);
        rows[0].blocked_until = Some(90);
        // A reset can make an account eligible, but doesn't invent quota.
        assert_eq!(choose(&rows, 100), Some("a"));
    }
    #[test]
    fn known_headroom_wins_over_unknown() {
        let mut rows = vec![account("unknown"), account("measured")];
        rows[1].remaining = Some(1.0);
        assert_eq!(choose(&rows, 100), Some("measured"));
    }
}
