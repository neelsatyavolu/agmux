//! Hourly aggregation for agmux Teams.
//!
//! Turns per-event provider activity into the exact bucket shape the server
//! accepts. Kept free of database and network access so the arithmetic is
//! unit-testable — the fiddly parts (spans that straddle an hour boundary,
//! concurrency being a max rather than a sum, idle time not counting as active
//! time) are exactly the parts worth pinning down.
//!
//! Events come from `teams::scan`, which reads each provider's own JSONL logs
//! and carries the **real timestamp of the work**. An earlier version folded
//! `session_usage` instead; that table is only refreshed when the user opens
//! the Usage panel and stamps everything with the scan time, so trends and the
//! hour-of-day heatmap were both wrong. Never go back to it.
//!
//! Nothing here reads prompt text, replies, diffs or absolute paths. Projects
//! arrive already reduced to a basename or an opaque hash.

use chrono::{DateTime, Datelike, Duration, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::scan::tools::ToolTally;

fn cost_coverage_unknown() -> bool { true }

/// Resolves the member's IANA timezone for after-hours / weekend / heatmap.
///
/// Uses the OS timezone (e.g. `Asia/Tokyo`, `America/Los_Angeles`) so each
/// employee is classified on their own wall clock even when the team spans
/// continents. Falls back to UTC only when the OS name is missing or unknown.
pub fn member_tz() -> Tz {
    parse_tz_name(&system_tz_name())
}

/// IANA name for the current machine, or `"UTC"` if detection fails.
pub fn system_tz_name() -> String {
    iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".into())
}

pub fn parse_tz_name(name: &str) -> Tz {
    name.parse::<Tz>().unwrap_or(chrono_tz::UTC)
}

/// Work is "after hours" outside 08:00–18:00 in the member's own IANA timezone
/// (not the manager's, not UTC). Remote teammates in Tokyo and SF are each
/// judged on their wall clock — see [`member_tz`] / [`build_buckets_in_tz`].
const WORK_START_HOUR: u32 = 8;
const WORK_END_HOUR: u32 = 18;

/// Longest gap between two events in a session that still counts as the agent
/// working. Anything longer is the human thinking, at lunch, or gone — the
/// disclosure promises "active agent time, idle excluded".
pub const ACTIVE_GAP_CAP: Duration = Duration::minutes(5);

/// Credited to the last event in a session, which has no following event to
/// measure against. Deliberately small so a one-shot session isn't inflated.
pub const ACTIVE_TAIL: Duration = Duration::seconds(30);

/// One usage-bearing event from a provider log. Serialized in the local usage
/// snapshot store; preserve deserialization compatibility when adding fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageEvent {
    pub at: DateTime<Utc>,
    /// `ClaudeCode` | `Codex` | `Grok` — matches the app's provider names.
    pub provider: String,
    pub model: String,
    pub project_key: String,
    /// Provider session identifier, for counting sessions and concurrency.
    pub session_id: String,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    /// Reasoning/thinking tokens, where the provider reports them (Codex does).
    pub reasoning: i64,
    pub cost_usd: f64,
    /// At least one required price or usage class was unavailable. Older saved
    /// events predate this evidence and cannot claim complete monetary coverage.
    #[serde(default = "cost_coverage_unknown")]
    pub cost_incomplete: bool,
    /// True when this event represents a completed agent turn.
    pub is_turn: bool,
    pub tool_calls: i64,
    /// Tool activity attributed to this event: what kind of work the agent did,
    /// how much of it was observably successful, and the size of the edits.
    pub tools: ToolTally,
    /// Claude only: message.id:requestId for parent/subagent dedupe.
    pub claude_row_key: Option<String>,
    pub is_sidechain: bool,
    pub is_subagent_path: bool,
    /// Native child thread (Codex subagent or auto-review): its usage counts,
    /// but it is not a session a person started. Claude children use
    /// `is_subagent_path`; Grok children roll up into the parent's usage.
    #[serde(default)]
    pub subagent: bool,
}

/// The wire shape. Field names match the Worker's `IncomingBucket` exactly.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HourlyBucket {
    pub hour_utc: String,
    pub provider: String,
    pub model: String,
    pub project_key: String,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub tokens_cache_read: i64,
    pub tokens_cache_write: i64,
    pub tokens_reasoning: i64,
    pub cost_usd: f64,
    #[serde(default = "cost_coverage_unknown")]
    pub cost_incomplete: bool,
    pub active_ms: i64,
    pub after_hours_ms: i64,
    pub weekend_ms: i64,
    /// Sessions active in this hour (session-hours when summed).
    pub sessions: i64,
    /// Top-level sessions whose first retained event falls in this bucket.
    /// Summing over a range gives distinct sessions started in it. `None` only
    /// for batches queued by an older build, which the server stores as unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sessions_started: Option<i64>,
    pub turns: i64,
    pub tool_calls: i64,
    pub peak_concurrent: i64,
    // ── tool mix ────────────────────────────────────────────────────────
    // The kind columns re-sum to `tool_calls` for providers that report per
    // call; unknown tool names land in `tool_other` rather than vanishing.
    pub tool_bash: i64,
    pub tool_edit: i64,
    pub tool_read: i64,
    pub tool_search: i64,
    pub tool_web: i64,
    pub tool_agent: i64,
    pub tool_mcp: i64,
    pub tool_other: i64,
    /// Failed tool calls, among those whose outcome the log reports.
    pub tool_errors: i64,
    /// Denominator for the error rate. Not every provider reports outcomes —
    /// see `scan::tools`. Never divide errors by `tool_calls`.
    pub tools_measured: i64,
    // ── output ──────────────────────────────────────────────────────────
    /// File-change *operations*, which stay true when buckets are summed.
    pub files_changed: i64,
    pub lines_added: i64,
    pub lines_removed: i64,
    // ── approval wait / blocked time ────────────────────────────────────
    /// How many tool-approval prompts were answered in this hour.
    pub approval_requests: i64,
    /// Sum of wall-clock ms from approval request → human response.
    pub approval_wait_ms: i64,
    pub local_hour: u32,
    pub local_dow: u32,
}

/// `(hour, provider, model, project)` — the server's key, minus identity.
type Key = (String, String, String, String);

/// Match the service's path-free, UTF-16-bounded labels before grouping. If
/// normalization happens only at upload, two buckets can collapse to one key
/// and the second absolute upsert silently replaces the first token total.
pub(super) fn wire_label(raw: &str, max_units: usize) -> String {
    let raw = raw.trim();
    if raw.contains(['/', '\\']) { return String::new(); }
    let mut units = 0;
    raw.chars().take_while(|ch| {
        units += ch.len_utf16();
        units <= max_units
    }).collect()
}

/// `YYYY-MM-DDTHH`, the server's bucket key format.
pub fn hour_key(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%dT%H").to_string()
}

fn hour_floor(t: DateTime<Utc>) -> DateTime<Utc> {
    t.with_minute(0)
        .and_then(|t| t.with_second(0))
        .and_then(|t| t.with_nanosecond(0))
        .unwrap_or(t)
}

/// Monday = 0 … Sunday = 6, matching the heatmap's row order.
fn local_dow<Z: TimeZone>(t: DateTime<Z>) -> u32 {
    t.weekday().num_days_from_monday()
}

fn is_weekend<Z: TimeZone>(t: DateTime<Z>) -> bool {
    local_dow(t) >= 5
}

fn is_after_hours<Z: TimeZone>(t: DateTime<Z>) -> bool {
    let h = t.hour();
    h < WORK_START_HOUR || h >= WORK_END_HOUR
}

#[derive(Debug, Clone, Copy)]
struct Span {
    start: DateTime<Utc>,
    end: DateTime<Utc>,
}

/// Splits `[start, end)` on UTC hour boundaries.
///
/// A span running 13:50→14:20 is 10 minutes of the 13:00 bucket and 20 of the
/// 14:00 one. Attributing it wholly to its start hour would misplace
/// long-running work, which is the thing the heatmap exists to show.
fn split_by_hour(start: DateTime<Utc>, end: DateTime<Utc>) -> Vec<(DateTime<Utc>, Span)> {
    if end <= start {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut cursor = start;
    while cursor < end {
        let bucket = hour_floor(cursor);
        let bucket_end = bucket + Duration::hours(1);
        let slice_end = if bucket_end < end { bucket_end } else { end };
        out.push((bucket, Span { start: cursor, end: slice_end }));
        cursor = slice_end;
    }
    out
}

/// Maximum number of simultaneously-open spans, by sweeping the endpoints.
///
/// Concurrency is a max, never a sum: three sessions that each ran ten minutes
/// in the same hour are not "three concurrent" unless they actually overlapped.
fn peak_overlap(spans: &[Span]) -> i64 {
    if spans.is_empty() {
        return 0;
    }
    let mut events: Vec<(DateTime<Utc>, i64)> = Vec::with_capacity(spans.len() * 2);
    for s in spans {
        events.push((s.start, 1));
        events.push((s.end, -1));
    }
    // Ends sort before starts at the same instant, so back-to-back spans do not
    // read as overlapping.
    events.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

    let mut current = 0i64;
    let mut peak = 0i64;
    for (_, delta) in events {
        current += delta;
        if current > peak {
            peak = current;
        }
    }
    peak
}

/// `(provider, model, project)` — what a span's time is attributed to.
type Ident = (String, String, String);

/// Active spans for one session's ordered events, each tagged with the identity
/// that was running when the span started.
///
/// Each consecutive pair contributes the gap between them, capped so that a
/// coffee break doesn't read as work. The final event gets a short tail because
/// there is nothing after it to measure against.
fn session_spans(timeline: &mut Vec<(DateTime<Utc>, Ident)>) -> Vec<(Span, Ident)> {
    timeline.sort_by(|a, b| a.0.cmp(&b.0));
    if timeline.is_empty() {
        return Vec::new();
    }
    let mut spans = Vec::with_capacity(timeline.len());
    for pair in timeline.windows(2) {
        let (a, b) = (&pair[0], &pair[1]);
        let end = if b.0 - a.0 > ACTIVE_GAP_CAP { a.0 + ACTIVE_GAP_CAP } else { b.0 };
        if end > a.0 {
            spans.push((Span { start: a.0, end }, a.1.clone()));
        }
    }
    let last = timeline.last().unwrap();
    spans.push((
        Span { start: last.0, end: last.0 + ACTIVE_TAIL },
        last.1.clone(),
    ));
    spans
}

/// Builds hourly buckets from provider events using the machine's IANA zone.
///
/// `now` bounds anything a log claims happened in the future (clock skew).
pub fn build_buckets(events: &[UsageEvent], now: DateTime<Utc>) -> Vec<HourlyBucket> {
    build_buckets_in_tz(events, now, member_tz())
}

/// Same as [`build_buckets`] but with an explicit IANA zone — used so a Tokyo
/// employee and an SF employee each get after-hours judged on their wall clock,
/// and so unit tests can pin zones without depending on the host TZ.
pub fn build_buckets_in_tz(
    events: &[UsageEvent],
    now: DateTime<Utc>,
    tz: Tz,
) -> Vec<HourlyBucket> {
    let mut acc: HashMap<Key, HourlyBucket> = HashMap::new();
    let mut session_hours: HashMap<(String, String, String), Key> = HashMap::new();
    // Active spans are derived from each session's *continuous* timeline, so
    // the grouping key must NOT include the hour — otherwise the gap between
    // 13:58 and 14:01 falls between two groups and is never measured. Each
    // event carries the identity (provider/model/project) that the following
    // span is attributed to, which keeps active time continuous across a
    // mid-session model switch without double counting it.
    let mut timeline_by_session: HashMap<(String, String), Vec<(DateTime<Utc>, Ident)>> = HashMap::new();
    // Each top-level session is started once, in the bucket of its first event.
    let mut session_starts: HashMap<(String, String), (DateTime<Utc>, Key)> = HashMap::new();

    for e in events {
        if e.at > now {
            continue;
        }
        let key: Key = (
            hour_key(e.at),
            e.provider.clone(),
            wire_label(&e.model, 60),
            wire_label(&e.project_key, 64),
        );

        let b = acc
            .entry(key.clone())
            .or_insert_with(|| new_bucket(e.at, &key, tz));
        b.tokens_in += e.tokens_in;
        b.tokens_out += e.tokens_out;
        b.tokens_cache_read += e.cache_read;
        b.tokens_cache_write += e.cache_write;
        b.tokens_reasoning += e.reasoning;
        b.cost_usd += e.cost_usd;
        b.cost_incomplete |= e.cost_incomplete;
        b.tool_calls += e.tool_calls;
        b.tool_bash += e.tools.bash;
        b.tool_edit += e.tools.edit;
        b.tool_read += e.tools.read;
        b.tool_search += e.tools.search;
        b.tool_web += e.tools.web;
        b.tool_agent += e.tools.agent;
        b.tool_mcp += e.tools.mcp;
        b.tool_other += e.tools.other;
        b.tool_errors += e.tools.errors;
        b.tools_measured += e.tools.measured;
        b.files_changed += e.tools.files_changed;
        b.lines_added += e.tools.lines_added;
        b.lines_removed += e.tools.lines_removed;
        if e.is_turn {
            b.turns += 1;
        }

        session_hours.entry((key.0.clone(), e.provider.clone(), e.session_id.clone()))
            .and_modify(|existing| { if &key < existing { *existing = key.clone(); } })
            .or_insert_with(|| key.clone());
        if !e.subagent && !e.is_subagent_path {
            session_starts.entry((e.provider.clone(), e.session_id.clone()))
                .and_modify(|first| { if (e.at, &key) < (first.0, &first.1) { *first = (e.at, key.clone()); } })
                .or_insert_with(|| (e.at, key.clone()));
        }
        timeline_by_session
            .entry((e.provider.clone(), e.session_id.clone()))
            .or_default()
            .push((
                e.at,
                (key.1.clone(), key.2.clone(), key.3.clone()),
            ));
    }

    // Active time and concurrency, derived from each session's event spacing.
    let mut spans_by_key: HashMap<Key, Vec<Span>> = HashMap::new();
    for ((provider, session), timeline) in &mut timeline_by_session {
        for (span, ident) in session_spans(timeline) {
            for (bucket_start, slice) in split_by_hour(span.start, span.end) {
                // A span can cross into an hour that has no token events; make
                // sure that hour still exists so the heatmap sees the work.
                let sliced: Key = (
                    hour_key(bucket_start),
                    ident.0.clone(),
                    ident.1.clone(),
                    ident.2.clone(),
                );
                session_hours.entry((sliced.0.clone(), provider.clone(), session.clone()))
                    .and_modify(|existing| { if &sliced < existing { *existing = sliced.clone(); } })
                    .or_insert_with(|| sliced.clone());
                let b = acc
                    .entry(sliced.clone())
                    .or_insert_with(|| new_bucket(bucket_start, &sliced, tz));

                let ms = (slice.end - slice.start).num_milliseconds();
                b.active_ms += ms;

                // After-hours / weekend judged on the slice in the member's
                // IANA zone, so a session crossing 18:00 local splits honestly
                // and Tokyo vs SF teammates are not compared on UTC.
                let local = slice.start.with_timezone(&tz);
                if is_after_hours(local) {
                    b.after_hours_ms += ms;
                }
                if is_weekend(local) {
                    b.weekend_ms += ms;
                }

                spans_by_key.entry(sliced).or_default().push(slice);
            }
        }
    }

    for (key, spans) in &spans_by_key {
        if let Some(b) = acc.get_mut(key) {
            b.peak_concurrent = peak_overlap(spans);
        }
    }
    for key in session_hours.values() {
        if let Some(b) = acc.get_mut(key) { b.sessions += 1; }
    }
    for (_, key) in session_starts.values() {
        if let Some(b) = acc.get_mut(key) { *b.sessions_started.get_or_insert(0) += 1; }
    }

    let mut out: Vec<HourlyBucket> = acc.into_values().collect();
    out.sort_by(|a, b| {
        a.hour_utc
            .cmp(&b.hour_utc)
            .then(a.provider.cmp(&b.provider))
            .then(a.model.cmp(&b.model))
            .then(a.project_key.cmp(&b.project_key))
    });
    out
}

fn new_bucket(at: DateTime<Utc>, key: &Key, tz: Tz) -> HourlyBucket {
    let local = at.with_timezone(&tz);
    HourlyBucket {
        hour_utc: key.0.clone(),
        provider: key.1.clone(),
        model: key.2.clone(),
        project_key: key.3.clone(),
        local_hour: local.hour(),
        local_dow: local_dow(local),
        sessions_started: Some(0),
        ..Default::default()
    }
}

/// Reduces a working directory to something safe to upload.
///
/// Public repos keep their basename because managers need to recognise the
/// project; anything flagged private is replaced by a short stable hash. A path
/// is never sent, and neither is a parent directory.
pub fn project_key(work_dir: &str, private: bool) -> String {
    let basename = work_dir
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim();

    if basename.is_empty() {
        return String::new();
    }
    if private {
        return short_hash(work_dir);
    }
    // Defence in depth: a basename should never contain a separator, but if the
    // caller hands us something odd we hash instead of leaking it.
    if basename.contains('/') || basename.contains('\\') {
        return short_hash(work_dir);
    }
    basename.chars().take(64).collect()
}

/// Short, stable, non-reversible label for a private repo.
pub fn short_hash(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(input.as_bytes());
    digest.iter().take(4).map(|b| format!("{b:02x}")).collect()
}

/// Parses the timestamps provider logs use (RFC3339 or `datetime('now')`).
pub fn parse_ts(raw: &str) -> Option<DateTime<Utc>> {
    if let Ok(t) = DateTime::parse_from_rfc3339(raw) {
        return Some(t.with_timezone(&Utc));
    }
    chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S")
        .ok()
        .and_then(|n| Utc.from_local_datetime(&n).single())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incomplete_cost_preserves_known_dollars_and_old_payloads_remain_unverified() {
        let mut known = ev("2026-09-08T10:00:00Z");
        known.tokens_in = 100;
        known.cost_usd = 1.25;
        let mut missing = known.clone();
        missing.tokens_in = 200;
        missing.cost_usd = 0.0;
        missing.cost_incomplete = true;
        let buckets = build_buckets(&[known.clone(), missing], parse_ts("2026-09-08T11:00:00Z").unwrap());
        assert_eq!(buckets[0].tokens_in, 300);
        assert_eq!(buckets[0].cost_usd, 1.25);
        assert!(buckets[0].cost_incomplete);
        let mut old = serde_json::to_value(known).unwrap();
        old.as_object_mut().unwrap().remove("cost_incomplete");
        assert!(serde_json::from_value::<UsageEvent>(old).unwrap().cost_incomplete);
        let mut old_bucket = serde_json::to_value(&buckets[0]).unwrap();
        old_bucket.as_object_mut().unwrap().remove("costIncomplete");
        assert!(serde_json::from_value::<HourlyBucket>(old_bucket).unwrap().cost_incomplete);
    }

    fn ts(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn ev(at: &str) -> UsageEvent {
        UsageEvent {
            at: ts(at),
            provider: "ClaudeCode".into(),
            model: "opus-5".into(),
            project_key: "helios-api".into(),
            session_id: "s1".into(),
            tokens_in: 0,
            tokens_out: 0,
            cache_read: 0,
            cache_write: 0,
            reasoning: 0,
            cost_usd: 0.0,
            cost_incomplete: false,
            is_turn: false,
            tool_calls: 0,
            tools: ToolTally::default(),
            claude_row_key: None,
            is_sidechain: false,
            is_subagent_path: false,
            subagent: false,
        }
    }

    #[test]
    fn hour_key_formats_as_the_server_expects() {
        assert_eq!(hour_key(ts("2026-07-29T14:37:12Z")), "2026-07-29T14");
    }

    #[test]
    fn split_by_hour_divides_a_span_that_straddles_the_boundary() {
        let parts = split_by_hour(ts("2026-07-29T13:50:00Z"), ts("2026-07-29T14:20:00Z"));
        assert_eq!(parts.len(), 2);
        assert_eq!((parts[0].1.end - parts[0].1.start).num_minutes(), 10);
        assert_eq!((parts[1].1.end - parts[1].1.start).num_minutes(), 20);
    }

    #[test]
    fn split_by_hour_rejects_a_backwards_or_empty_range() {
        assert!(split_by_hour(ts("2026-07-29T14:00:00Z"), ts("2026-07-29T13:00:00Z")).is_empty());
        assert!(split_by_hour(ts("2026-07-29T14:00:00Z"), ts("2026-07-29T14:00:00Z")).is_empty());
    }

    #[test]
    fn tokens_land_in_the_hour_the_work_actually_happened() {
        let mut a = ev("2026-07-29T09:15:00Z");
        a.tokens_in = 100;
        let mut b = ev("2026-07-29T15:45:00Z");
        b.tokens_in = 250;

        let buckets = build_buckets(&[a, b], ts("2026-07-29T20:00:00Z"));
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0].hour_utc, "2026-07-29T09");
        assert_eq!(buckets[0].tokens_in, 100);
        assert_eq!(buckets[1].hour_utc, "2026-07-29T15");
        assert_eq!(buckets[1].tokens_in, 250);
    }

    #[test]
    fn every_token_class_is_carried_including_reasoning() {
        let mut e = ev("2026-07-29T14:00:00Z");
        e.tokens_in = 1;
        e.tokens_out = 2;
        e.cache_read = 3;
        e.cache_write = 4;
        e.reasoning = 5;
        e.cost_usd = 0.5;

        let b = &build_buckets(&[e], ts("2026-07-29T15:00:00Z"))[0];
        assert_eq!(
            (b.tokens_in, b.tokens_out, b.tokens_cache_read, b.tokens_cache_write, b.tokens_reasoning),
            (1, 2, 3, 4, 5)
        );
        assert!((b.cost_usd - 0.5).abs() < 1e-9);
    }

    #[test]
    fn active_time_is_the_gap_between_events() {
        // Two events two minutes apart → 2 minutes of work, plus the tail.
        let buckets = build_buckets(
            &[ev("2026-07-29T14:00:00Z"), ev("2026-07-29T14:02:00Z")],
            ts("2026-07-29T15:00:00Z"),
        );
        assert_eq!(
            buckets[0].active_ms,
            2 * 60_000 + ACTIVE_TAIL.num_milliseconds()
        );
    }

    #[test]
    fn a_long_idle_gap_does_not_count_as_active_time() {
        // Three hours between events is the human being away, not the agent
        // working — the disclosure says idle is excluded.
        let buckets = build_buckets(
            &[ev("2026-07-29T14:00:00Z"), ev("2026-07-29T17:00:00Z")],
            ts("2026-07-29T18:00:00Z"),
        );
        let total: i64 = buckets.iter().map(|b| b.active_ms).sum();
        assert_eq!(
            total,
            ACTIVE_GAP_CAP.num_milliseconds() + ACTIVE_TAIL.num_milliseconds()
        );
    }

    #[test]
    fn a_single_event_session_gets_only_the_short_tail() {
        let buckets = build_buckets(&[ev("2026-07-29T14:00:00Z")], ts("2026-07-29T15:00:00Z"));
        assert_eq!(buckets[0].active_ms, ACTIVE_TAIL.num_milliseconds());
    }

    #[test]
    fn active_time_splits_across_the_hour_boundary() {
        let buckets = build_buckets(
            &[ev("2026-07-29T13:58:00Z"), ev("2026-07-29T14:01:00Z")],
            ts("2026-07-29T15:00:00Z"),
        );
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0].active_ms, 2 * 60_000);
        assert_eq!(buckets[1].active_ms, 60_000 + ACTIVE_TAIL.num_milliseconds());
    }

    #[test]
    fn peak_concurrency_is_a_max_not_a_sum() {
        let mut a = ev("2026-07-29T14:00:00Z");
        a.session_id = "s1".into();
        let mut a2 = ev("2026-07-29T14:04:00Z");
        a2.session_id = "s1".into();
        let mut b = ev("2026-07-29T14:02:00Z");
        b.session_id = "s2".into();
        let mut b2 = ev("2026-07-29T14:06:00Z");
        b2.session_id = "s2".into();

        let buckets = build_buckets(&[a, a2, b, b2], ts("2026-07-29T15:00:00Z"));
        assert_eq!(buckets.len(), 1);
        assert_eq!(buckets[0].peak_concurrent, 2);
        assert_eq!(buckets[0].sessions, 2);
    }

    #[test]
    fn sequential_sessions_are_not_concurrent() {
        let mut a = ev("2026-07-29T14:00:00Z");
        a.session_id = "s1".into();
        let mut b = ev("2026-07-29T14:40:00Z");
        b.session_id = "s2".into();

        let buckets = build_buckets(&[a, b], ts("2026-07-29T15:00:00Z"));
        assert_eq!(buckets[0].peak_concurrent, 1);
        assert_eq!(buckets[0].sessions, 2);
    }

    #[test]
    fn turns_and_tool_calls_are_counted() {
        let mut a = ev("2026-07-29T14:00:00Z");
        a.is_turn = true;
        a.tool_calls = 4;
        let mut b = ev("2026-07-29T14:01:00Z");
        b.is_turn = true;
        b.tool_calls = 2;

        let buckets = build_buckets(&[a, b], ts("2026-07-29T15:00:00Z"));
        assert_eq!(buckets[0].turns, 2);
        assert_eq!(buckets[0].tool_calls, 6);
    }

    #[test]
    fn tool_kinds_and_output_counters_fold_into_the_bucket() {
        let mut a = ev("2026-07-29T14:00:00Z");
        a.tools = ToolTally {
            bash: 2,
            edit: 1,
            errors: 1,
            measured: 3,
            files_changed: 1,
            lines_added: 20,
            lines_removed: 4,
            ..Default::default()
        };
        let mut b = ev("2026-07-29T14:30:00Z");
        b.tools = ToolTally { bash: 1, read: 5, measured: 6, lines_added: 3, ..Default::default() };

        let buckets = build_buckets(&[a, b], ts("2026-07-29T15:00:00Z"));
        assert_eq!(buckets[0].tool_bash, 3);
        assert_eq!(buckets[0].tool_edit, 1);
        assert_eq!(buckets[0].tool_read, 5);
        assert_eq!(buckets[0].tool_errors, 1);
        assert_eq!(buckets[0].tools_measured, 9);
        assert_eq!(buckets[0].files_changed, 1);
        assert_eq!((buckets[0].lines_added, buckets[0].lines_removed), (23, 4));
    }

    #[test]
    fn providers_and_models_get_their_own_buckets() {
        let mut a = ev("2026-07-29T14:00:00Z");
        a.provider = "ClaudeCode".into();
        let mut b = ev("2026-07-29T14:00:00Z");
        b.provider = "Codex".into();
        b.model = "gpt-5.6".into();

        let buckets = build_buckets(&[a, b], ts("2026-07-29T15:00:00Z"));
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0].provider, "ClaudeCode");
        assert_eq!(buckets[1].provider, "Codex");
    }

    #[test]
    fn wire_label_collisions_merge_before_absolute_upload() {
        let mut a = ev("2026-07-29T14:00:00Z");
        a.model = "local/model-one".into();
        a.tokens_in = 100;
        let mut b = a.clone();
        b.model = "local/model-two".into();
        b.tokens_in = 200;
        b.session_id = "s2".into();
        let buckets = build_buckets(&[a, b], ts("2026-07-29T15:00:00Z"));
        assert_eq!(buckets.len(), 1);
        assert_eq!(buckets[0].model, "");
        assert_eq!(buckets[0].tokens_in, 300);
        assert_eq!(buckets[0].sessions, 2);
        assert!(buckets[0].active_ms > 0);
    }

    #[test]
    fn wire_labels_stay_within_server_utf16_limits() {
        let prefix = "🌊".repeat(32);
        assert_eq!(wire_label(&format!("{prefix}a"), 64), prefix);
        assert_eq!(wire_label(&"m".repeat(61), 60).len(), 60);
        assert_eq!(wire_label("/private/path", 60), "");
    }

    #[test]
    fn repair_session_activity_counts_once_per_provider_session_hour() {
        let a = ev("2026-07-29T14:00:00Z");
        let mut b = ev("2026-07-29T14:05:00Z");
        b.model = "another-model".into();
        let c = ev("2026-07-29T15:05:00Z");
        let buckets = build_buckets(&[a, b, c], ts("2026-07-29T16:00:00Z"));
        assert_eq!(buckets.iter().map(|b| b.sessions).sum::<i64>(), 2);
    }

    #[test]
    fn sessions_started_counts_each_top_level_session_once_in_its_first_bucket() {
        // s1 runs across two hours and switches model; it is one session.
        let mut late_model = ev("2026-07-29T14:05:00Z");
        late_model.model = "another-model".into();
        let s1 = [ev("2026-07-29T14:00:00Z"), late_model, ev("2026-07-29T15:05:00Z")];
        let mut s2 = ev("2026-07-29T15:30:00Z");
        s2.session_id = "s2".into();
        // Children do real work but nobody started them.
        let mut codex_child = ev("2026-07-29T15:31:00Z");
        codex_child.provider = "Codex".into();
        codex_child.session_id = "review".into();
        codex_child.subagent = true;
        let mut claude_child = ev("2026-07-29T15:32:00Z");
        claude_child.session_id = "s1:agent-a".into();
        claude_child.is_subagent_path = true;
        let events: Vec<_> = s1.into_iter().chain([s2, codex_child, claude_child]).collect();
        let buckets = build_buckets(&events, ts("2026-07-29T16:00:00Z"));
        let started = |hour: &str, model: &str| buckets.iter()
            .filter(|b| b.hour_utc == hour && b.model == model)
            .map(|b| b.sessions_started.unwrap()).sum::<i64>();
        assert_eq!(started("2026-07-29T14", "opus-5"), 1);
        assert_eq!(started("2026-07-29T14", "another-model"), 0);
        assert_eq!(started("2026-07-29T15", "opus-5"), 1, "only s2 starts in the second hour");
        assert_eq!(buckets.iter().map(|b| b.sessions_started.unwrap()).sum::<i64>(), 2);
        assert!(buckets.iter().map(|b| b.sessions).sum::<i64>() > 2, "session-hours still include children");
    }

    #[test]
    fn batches_queued_before_sessions_started_stay_unknown_on_the_wire() {
        let old: Vec<HourlyBucket> = serde_json::from_str(r#"[{"hourUtc":"2026-07-29T14","provider":"Codex",
            "model":"","projectKey":"","tokensIn":0,"tokensOut":0,"tokensCacheRead":0,"tokensCacheWrite":0,
            "tokensReasoning":0,"costUsd":0,"activeMs":0,"afterHoursMs":0,"weekendMs":0,"sessions":3,
            "turns":0,"toolCalls":0,"peakConcurrent":0,"toolBash":0,"toolEdit":0,"toolRead":0,
            "toolSearch":0,"toolWeb":0,"toolAgent":0,"toolMcp":0,"toolOther":0,"toolErrors":0,
            "toolsMeasured":0,"filesChanged":0,"linesAdded":0,"linesRemoved":0,"approvalRequests":0,
            "approvalWaitMs":0,"localHour":0,"localDow":0}]"#).unwrap();
        assert_eq!(old[0].sessions_started, None);
        assert!(!serde_json::to_string(&old).unwrap().contains("sessionsStarted"));
        let fresh = build_buckets(&[ev("2026-07-29T14:00:00Z")], ts("2026-07-29T16:00:00Z"));
        assert!(serde_json::to_string(&fresh).unwrap().contains("\"sessionsStarted\":1"));
    }

    #[test]
    fn a_model_switch_mid_session_splits_the_buckets() {
        // Per-message models are the whole point of reading the logs directly.
        let mut a = ev("2026-07-29T14:00:00Z");
        a.model = "sonnet-5".into();
        a.tokens_in = 10;
        let mut b = ev("2026-07-29T14:05:00Z");
        b.model = "opus-5".into();
        b.tokens_in = 20;

        let buckets = build_buckets(&[a, b], ts("2026-07-29T15:00:00Z"));
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets.iter().map(|x| x.tokens_in).sum::<i64>(), 30);
    }

    #[test]
    fn events_from_the_future_are_ignored() {
        let mut e = ev("2026-07-30T14:00:00Z");
        e.tokens_in = 999;
        let buckets = build_buckets(&[e], ts("2026-07-29T15:00:00Z"));
        assert!(buckets.is_empty(), "clock skew must not create future buckets");
    }

    #[test]
    fn after_hours_and_weekend_never_exceed_active_time() {
        let buckets = build_buckets_in_tz(
            &[ev("2026-07-29T02:00:00Z"), ev("2026-07-29T02:03:00Z")],
            ts("2026-07-29T12:00:00Z"),
            chrono_tz::UTC,
        );
        for b in &buckets {
            assert!(b.after_hours_ms <= b.active_ms);
            assert!(b.weekend_ms <= b.active_ms);
            assert!(b.local_hour < 24);
            assert!(b.local_dow < 7);
        }
    }

    /// Same UTC instant: work hours in SF, after-hours in Tokyo.
    /// 18:00 UTC → 11:00 America/Los_Angeles (PDT), 03:00 Asia/Tokyo.
    #[test]
    fn after_hours_uses_member_iana_zone_not_utc() {
        let now = ts("2026-07-29T20:00:00Z");
        let events = [ev("2026-07-29T18:00:00Z"), ev("2026-07-29T18:02:00Z")];

        let la = build_buckets_in_tz(&events, now, chrono_tz::America::Los_Angeles);
        assert_eq!(la.len(), 1);
        assert_eq!(la[0].local_hour, 11);
        assert_eq!(la[0].after_hours_ms, 0, "11:00 PDT is inside 08:00–18:00");

        let tokyo = build_buckets_in_tz(&events, now, chrono_tz::Asia::Tokyo);
        assert_eq!(tokyo.len(), 1);
        assert_eq!(tokyo[0].local_hour, 3);
        assert!(
            tokyo[0].after_hours_ms > 0 && tokyo[0].after_hours_ms == tokyo[0].active_ms,
            "03:00 JST is after hours; got after={} active={}",
            tokyo[0].after_hours_ms,
            tokyo[0].active_ms
        );
    }

    /// Friday 20:00 UTC is still Friday in London, Saturday morning in Tokyo.
    #[test]
    fn weekend_flag_follows_member_local_calendar() {
        let now = ts("2026-08-01T12:00:00Z");
        // 2026-07-31 is a Friday.
        let events = [ev("2026-07-31T20:00:00Z"), ev("2026-07-31T20:02:00Z")];

        let london = build_buckets_in_tz(&events, now, chrono_tz::Europe::London);
        assert_eq!(london[0].local_dow, 4); // Friday
        assert_eq!(london[0].weekend_ms, 0);

        let tokyo = build_buckets_in_tz(&events, now, chrono_tz::Asia::Tokyo);
        // 20:00 UTC Friday → 05:00 Saturday JST
        assert_eq!(tokyo[0].local_dow, 5); // Saturday
        assert!(tokyo[0].weekend_ms > 0);
    }

    #[test]
    fn parse_tz_name_falls_back_to_utc_for_junk() {
        assert_eq!(parse_tz_name("Not/AZone"), chrono_tz::UTC);
        assert_eq!(parse_tz_name("Asia/Tokyo"), chrono_tz::Asia::Tokyo);
    }

    #[test]
    fn buckets_come_out_in_a_stable_order() {
        let buckets = build_buckets(
            &[ev("2026-07-29T15:00:00Z"), ev("2026-07-29T09:00:00Z")],
            ts("2026-07-29T16:00:00Z"),
        );
        assert_eq!(buckets[0].hour_utc, "2026-07-29T09");
        assert_eq!(buckets[1].hour_utc, "2026-07-29T15");
    }

    #[test]
    fn project_key_keeps_a_public_basename_and_drops_the_path() {
        assert_eq!(project_key("/Users/neel/code/helios-api", false), "helios-api");
        assert_eq!(project_key("/Users/neel/code/helios-api/", false), "helios-api");
    }

    #[test]
    fn project_key_hashes_a_private_repo_instead_of_naming_it() {
        let key = project_key("/Users/neel/secret/acquisition-target", true);
        assert_eq!(key.len(), 8);
        assert!(!key.contains("acquisition"));
        assert_eq!(key, project_key("/Users/neel/secret/acquisition-target", true));
    }

    #[test]
    fn project_key_never_emits_a_separator() {
        for input in ["/a/b/c", "C:\\work\\repo", "", "/"] {
            let key = project_key(input, false);
            assert!(!key.contains('/'), "{input} leaked a separator");
            assert!(!key.contains('\\'), "{input} leaked a separator");
        }
    }

    #[test]
    fn parse_ts_handles_both_timestamp_formats() {
        assert!(parse_ts("2026-07-29T14:00:00Z").is_some());
        assert!(parse_ts("2026-07-29 14:00:00").is_some());
        assert!(parse_ts("not a date").is_none());
    }

    #[test]
    fn a_bucket_serialises_with_the_camel_case_the_worker_expects() {
        let b = HourlyBucket {
            hour_utc: "2026-07-29T14".into(),
            provider: "ClaudeCode".into(),
            tokens_in: 5,
            tokens_reasoning: 7,
            ..Default::default()
        };
        let json = serde_json::to_string(&b).unwrap();
        assert!(json.contains("\"hourUtc\":\"2026-07-29T14\""));
        assert!(json.contains("\"tokensIn\":5"));
        assert!(json.contains("\"tokensReasoning\":7"));
        assert!(!json.contains("hour_utc"));
    }
}
