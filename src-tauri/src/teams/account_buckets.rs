//! Usage split by the Claude/Codex login that ran it.
//!
//! Pure, like `aggregate`: events come in with the login spans recorded for
//! their session (`login_spans`), hourly per-login counters go out. An event
//! belongs to the latest span of its session that started at or before it.
//! Events with no such span (sessions from before agmux recorded logins, or a
//! login agmux could not identify) are left out: the server shows the
//! difference from the regular buckets as "Not attributed", never a guess.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::aggregate::{hour_key, session_spans, split_by_hour, UsageEvent};

/// The start of a stretch of a session that ran under one login.
#[derive(Debug, Clone, PartialEq)]
pub struct LoginSpan {
    pub from: DateTime<Utc>,
    pub identity_hash: String,
}

/// Spans per `(event provider, event session id)`, each list sorted by `from`.
pub type SessionLogins = HashMap<(String, String), Vec<LoginSpan>>;

/// The wire shape of `accountBuckets[]`. Field names match the Worker exactly.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountBucket {
    pub hour_utc: String,
    /// `claude` | `codex`.
    pub provider: String,
    pub identity_hash: String,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub tokens_cache_read: i64,
    pub tokens_cache_write: i64,
    pub tokens_reasoning: i64,
    pub cost_usd: f64,
    pub cost_incomplete: bool,
    pub active_ms: i64,
    pub turns: i64,
}

/// The wire shape of `accountLabels[]`: a Claude login's email.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLabel {
    pub provider: String,
    pub identity_hash: String,
    pub label: String,
}

/// Upload provider for the scanner's provider name; other providers have no
/// login split.
pub fn wire_provider(provider: &str) -> Option<&'static str> {
    match provider {
        "ClaudeCode" => Some("claude"),
        "Codex" => Some("codex"),
        _ => None,
    }
}

/// The login a session was on at `at`: the latest span starting at or before it.
pub fn login_at(spans: &[LoginSpan], at: DateTime<Utc>) -> Option<&str> {
    // An unknown boundary (`login_spans::UNKNOWN_LOGIN`) ends the previous login's span.
    spans.iter().filter(|s| s.from <= at).max_by_key(|s| s.from).map(|s| s.identity_hash.as_str()).filter(|h| !h.is_empty())
}

type Key = (String, String, String); // (hour, wire provider, identity hash)

/// Folds attributed events into hourly per-login buckets. Counters are the
/// same numbers `build_buckets` sums (tokens, cost, turns); active time uses the
/// same capped gaps, credited to the login running when each gap started.
pub fn build_account_buckets(events: &[UsageEvent], logins: &SessionLogins, now: DateTime<Utc>) -> Vec<AccountBucket> {
    let mut acc: HashMap<Key, AccountBucket> = HashMap::new();
    let mut timelines: HashMap<(String, String), Vec<(DateTime<Utc>, Option<String>)>> = HashMap::new();
    for e in events {
        if e.at > now { continue; }
        let Some(provider) = wire_provider(&e.provider) else { continue };
        let session = (e.provider.clone(), e.session_id.clone());
        let login = logins.get(&session).and_then(|spans| login_at(spans, e.at)).map(str::to_owned);
        timelines.entry(session).or_default().push((e.at, login.clone()));
        let Some(hash) = login else { continue };
        let b = bucket(&mut acc, hour_key(e.at), provider, &hash);
        b.tokens_in += e.tokens_in;
        b.tokens_out += e.tokens_out;
        b.tokens_cache_read += e.cache_read;
        b.tokens_cache_write += e.cache_write;
        b.tokens_reasoning += e.reasoning;
        b.cost_usd += e.cost_usd;
        b.cost_incomplete |= e.cost_incomplete;
        if e.is_turn { b.turns += 1; }
    }
    for ((event_provider, _), timeline) in &mut timelines {
        let Some(provider) = wire_provider(event_provider) else { continue };
        for (span, login) in session_spans(timeline) {
            let Some(hash) = login else { continue };
            for (bucket_start, slice) in split_by_hour(span.start, span.end) {
                bucket(&mut acc, hour_key(bucket_start), provider, &hash).active_ms += (slice.end - slice.start).num_milliseconds();
            }
        }
    }
    let mut out: Vec<AccountBucket> = acc.into_values().collect();
    out.sort_by(|a, b| (&a.hour_utc, &a.provider, &a.identity_hash).cmp(&(&b.hour_utc, &b.provider, &b.identity_hash)));
    out
}

fn bucket<'a>(acc: &'a mut HashMap<Key, AccountBucket>, hour: String, provider: &str, hash: &str) -> &'a mut AccountBucket {
    acc.entry((hour.clone(), provider.into(), hash.into())).or_insert_with(|| AccountBucket {
        hour_utc: hour,
        provider: provider.into(),
        identity_hash: hash.into(),
        cost_incomplete: false,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::teams::aggregate::{build_buckets, parse_ts};
    use crate::teams::scan::tools::ToolTally;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn ts(s: &str) -> DateTime<Utc> { parse_ts(s).unwrap() }

    fn ev(provider: &str, session: &str, at: &str, tokens: i64) -> UsageEvent {
        UsageEvent {
            at: ts(at), provider: provider.into(), model: "m".into(), project_key: "p".into(),
            session_id: session.into(), tokens_in: tokens, tokens_out: 1, cache_read: 2, cache_write: 3,
            reasoning: 0, cost_usd: 0.5, cost_incomplete: false, is_turn: true, tool_calls: 0,
            tools: ToolTally::default(), claude_row_key: None, is_sidechain: false,
            is_subagent_path: false, subagent: false, parent_session_id: None,
        }
    }

    fn span(from: &str, hash: &str) -> LoginSpan { LoginSpan { from: ts(from), identity_hash: hash.into() } }

    #[test]
    fn latest_span_at_or_before_the_event_wins() {
        let spans = [span("2026-11-06T10:00:00Z", A), span("2026-11-06T12:00:00Z", B)];
        assert_eq!(login_at(&spans, ts("2026-11-06T09:59:59Z")), None);
        assert_eq!(login_at(&spans, ts("2026-11-06T10:00:00Z")), Some(A));
        assert_eq!(login_at(&spans, ts("2026-11-06T11:59:59Z")), Some(A));
        assert_eq!(login_at(&spans, ts("2026-11-06T12:00:00Z")), Some(B));
        // Order of storage does not matter.
        let reversed = [span("2026-11-06T12:00:00Z", B), span("2026-11-06T10:00:00Z", A)];
        assert_eq!(login_at(&reversed, ts("2026-11-06T13:00:00Z")), Some(B));
    }

    #[test]
    fn an_account_switch_mid_session_splits_tokens_between_logins() {
        let events = vec![
            ev("ClaudeCode", "s1", "2026-11-06T10:05:00Z", 100),
            ev("ClaudeCode", "s1", "2026-11-06T10:20:00Z", 200),
            ev("ClaudeCode", "s1", "2026-11-06T10:40:00Z", 400),
        ];
        let logins = SessionLogins::from([(("ClaudeCode".into(), "s1".into()),
            vec![span("2026-11-06T10:00:00Z", A), span("2026-11-06T10:30:00Z", B)])]);
        let out = build_account_buckets(&events, &logins, ts("2026-11-06T12:00:00Z"));
        assert_eq!(out.len(), 2);
        let a = out.iter().find(|b| b.identity_hash == A).unwrap();
        let b = out.iter().find(|b| b.identity_hash == B).unwrap();
        assert_eq!((a.provider.as_str(), a.hour_utc.as_str()), ("claude", "2026-11-06T10"));
        assert_eq!((a.tokens_in, a.turns, a.cost_usd), (300, 2, 1.0));
        assert_eq!((b.tokens_in, b.turns), (400, 1));
        // Both gaps exceed the 5 min cap, so A gets 5 + 5 min; B the 30 s tail.
        assert_eq!(a.active_ms, 10 * 60_000);
        assert_eq!(b.active_ms, 30_000);
    }

    #[test]
    fn attributed_counters_match_the_regular_buckets_and_unknown_sessions_are_left_out() {
        let mut events = vec![
            ev("ClaudeCode", "known", "2026-11-06T10:00:00Z", 100),
            ev("ClaudeCode", "known", "2026-11-06T10:02:00Z", 50),
            ev("Codex", "thread", "2026-11-06T11:00:00Z", 70),
            ev("ClaudeCode", "unknown", "2026-11-06T10:01:00Z", 999),
            ev("Grok", "known", "2026-11-06T10:01:00Z", 5),
        ];
        events[1].cost_incomplete = true;
        events[2].reasoning = 9;
        let logins = SessionLogins::from([
            (("ClaudeCode".into(), "known".into()), vec![span("2026-11-06T09:00:00Z", A)]),
            (("Codex".into(), "thread".into()), vec![span("2026-11-06T09:00:00Z", B)]),
            (("Grok".into(), "known".into()), vec![span("2026-11-06T09:00:00Z", A)]),
        ]);
        let now = ts("2026-11-06T12:00:00Z");
        let out = build_account_buckets(&events, &logins, now);
        assert_eq!(out.len(), 2, "unknown session and Grok produce no login rows: {out:?}");
        let claude = &out[0];
        assert_eq!((claude.provider.as_str(), claude.tokens_in, claude.tokens_cache_read), ("claude", 150, 4));
        assert!(claude.cost_incomplete);
        let codex = &out[1];
        assert_eq!((codex.provider.as_str(), codex.tokens_reasoning, codex.cost_incomplete), ("codex", 9, false));
        // The same events through the regular fold give the same active time.
        let regular = build_buckets(&events[..2], now);
        assert_eq!(claude.active_ms, regular.iter().map(|b| b.active_ms).sum::<i64>());
    }

    #[test]
    fn active_time_crossing_an_hour_lands_in_both_hours_and_future_events_are_dropped() {
        let events = vec![
            ev("Codex", "t", "2026-11-06T10:58:00Z", 1),
            ev("Codex", "t", "2026-11-06T11:01:00Z", 1),
            ev("Codex", "t", "2026-11-06T13:00:00Z", 1),
        ];
        let logins = SessionLogins::from([(("Codex".into(), "t".into()), vec![span("2026-11-06T10:00:00Z", A)])]);
        let out = build_account_buckets(&events, &logins, ts("2026-11-06T12:00:00Z"));
        let hours: Vec<_> = out.iter().map(|b| (b.hour_utc.as_str(), b.active_ms, b.tokens_in)).collect();
        assert_eq!(hours, vec![("2026-11-06T10", 120_000, 1), ("2026-11-06T11", 60_000 + 30_000, 1)]);
    }

    #[test]
    fn wire_names_match_the_worker_contract() {
        let json = serde_json::to_string(&AccountBucket {
            hour_utc: "2026-11-06T14".into(), provider: "claude".into(), identity_hash: A.into(),
            tokens_in: 1, tokens_out: 2, tokens_cache_read: 3, tokens_cache_write: 4, tokens_reasoning: 5,
            cost_usd: 0.25, cost_incomplete: true, active_ms: 6, turns: 7,
        }).unwrap();
        for field in ["\"hourUtc\":\"2026-11-06T14\"", "\"provider\":\"claude\"", "\"identityHash\"", "\"tokensIn\":1",
            "\"tokensOut\":2", "\"tokensCacheRead\":3", "\"tokensCacheWrite\":4", "\"tokensReasoning\":5",
            "\"costUsd\":0.25", "\"costIncomplete\":true", "\"activeMs\":6", "\"turns\":7"] {
            assert!(json.contains(field), "missing {field} in {json}");
        }
        let label = serde_json::to_string(&AccountLabel { provider: "claude".into(), identity_hash: A.into(), label: "name@example.com".into() }).unwrap();
        assert_eq!(label, format!("{{\"provider\":\"claude\",\"identityHash\":\"{A}\",\"label\":\"name@example.com\"}}"));
    }
}
