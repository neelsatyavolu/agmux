//! Grok native terminal and ACP chat usage reader.
//!
//! `turn_completed.usage` is cumulative within `update.prompt_id`, not across
//! the session. Input includes cached reads; reasoning is a subset of output.
//! Context-only metadata is activity, never evidence of billable tokens/cache.
//! Reported cost ticks are authoritative (1e10 ticks = $1); missing cost remains
//! unreported rather than pricing a multi-request total as one long request.

use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::Path;

use super::super::aggregate::{parse_ts, project_key, UsageEvent};
use super::tools::{classify, line_count, replacement_lines, ToolTally};

#[derive(Clone, Copy, Default)]
pub(crate) struct UsageSnap {
    pub(crate) input: i64,
    pub(crate) output: i64,
    pub(crate) cache: i64,
    pub(crate) cache_write: i64,
    pub(crate) reasoning: i64,
    pub(crate) num_turns: i64,
    pub(crate) cost_ticks: i64,
}

impl UsageSnap {
    pub(crate) fn observe(&mut self, snap: Self, allow_reset: bool) -> Self {
        // A known prompt cannot become a new segment: late partial snapshots
        // keep each watermark. Only anonymous legacy counters may reset.
        if allow_reset && (snap.num_turns < self.num_turns || snap.input < self.input
            || snap.output < self.output || snap.cache < self.cache)
        {
            *self = Self::default();
        }
        let high = Self {
            input: self.input.max(snap.input),
            output: self.output.max(snap.output),
            cache: self.cache.max(snap.cache),
            cache_write: self.cache_write.max(snap.cache_write),
            reasoning: self.reasoning.max(snap.reasoning),
            num_turns: self.num_turns.max(snap.num_turns),
            cost_ticks: self.cost_ticks.max(snap.cost_ticks),
        };
        let delta = Self {
            input: high.input - self.input,
            output: high.output - self.output,
            cache: high.cache - self.cache,
            cache_write: high.cache_write - self.cache_write,
            reasoning: high.reasoning - self.reasoning,
            num_turns: high.num_turns - self.num_turns,
            cost_ticks: high.cost_ticks - self.cost_ticks,
        };
        *self = high;
        delta
    }

    pub(crate) fn is_empty(self) -> bool {
        self.input == 0 && self.output == 0 && self.cache == 0 && self.cache_write == 0
            && self.reasoning == 0 && self.cost_ticks == 0
    }
}

/// Parses native updates for either transport. Ownership is enforced by caller.
pub fn parse_session(lines: &str, session_id: &str, cwd: &str, model_hint: &str) -> Vec<UsageEvent> {
    parse_lines(lines.lines().map(Ok), session_id, cwd, model_hint).unwrap_or_default()
}

/// Streaming full snapshot; I/O failures must not turn into partial uploads.
pub fn parse_file(path: &Path, session_id: &str, cwd: &str, model_hint: &str) -> Result<Vec<UsageEvent>, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    parse_lines(BufReader::new(file).lines(), session_id, cwd, model_hint)
}

fn parse_lines<S: AsRef<str>>(
    lines: impl Iterator<Item = Result<S, std::io::Error>>,
    session_id: &str, cwd: &str, model_hint: &str,
) -> Result<Vec<UsageEvent>, String> {
    let mut out = Vec::new();
    let mut activity = Vec::new();
    let mut seen_events = HashSet::new();
    let mut usage_rows = Vec::new();
    let mut unpartitioned_prompts = HashSet::new();
    let mut prompt_models: HashMap<String, HashSet<String>> = HashMap::new();
    let mut activity_turns = HashSet::new();
    let mut saw_usage = false;
    let mut prev_total = None;
    let mut model = model_hint.trim().to_string();
    let project = project_key(cwd, false);

    for line in lines {
        let line = line.map_err(|e| e.to_string())?;
        let Ok(v) = serde_json::from_str::<Value>(line.as_ref()) else { continue };
        let update = v.pointer("/params/update").unwrap_or(&Value::Null);
        let meta = v.pointer("/params/_meta").unwrap_or(&Value::Null);
        let Some(at) = event_time(&v, meta) else { continue };
        if let Some(id) = meta.get("eventId").and_then(Value::as_str) {
            if !seen_events.insert(replay_key(id, &v)) { continue; }
        }
        if let Some(m) = model_from_line(&v) { model = m; }
        let event = |model: String| UsageEvent {
            at, provider: "Grok".into(), model, project_key: project.clone(),
            session_id: session_id.to_string(), tokens_in: 0, tokens_out: 0,
            cache_read: 0, cache_write: 0, reasoning: 0, cost_usd: 0.0, cost_incomplete: false,
            is_turn: false, tool_calls: 0, tools: ToolTally::default(),
            claude_row_key: None, is_sidechain: false, is_subagent_path: false, subagent: false,
        };
        let tool = tool_signal(&v);
        if !tool.is_empty() {
            let mut e = event(model.clone());
            e.tool_calls = tool.calls();
            e.tools = tool;
            out.push(e);
        }

        if let Some(usage) = update.get("usage") {
            if let Some(root) = parse_usage_snap(usage) {
                saw_usage = true;
                let prompt = update.get("prompt_id").or_else(|| meta.get("promptId"))
                    .and_then(Value::as_str).unwrap_or("");
                let parts: Vec<(String, UsageSnap)> = usage.get("modelUsage")
                    .and_then(Value::as_object).into_iter().flat_map(|m| m.iter())
                    .filter_map(|(m, u)| parse_usage_snap(u).map(|s| (m.clone(), s)))
                    .collect();
                // Use one basis for the entire prompt. Switching from a model
                // map to a root fallback mid-prompt creates a second watermark
                // and rebills prior work. Buffer numeric usage only so a later
                // incomplete map can also invalidate an earlier partition.
                let sum = |f: fn(UsageSnap) -> i64| parts.iter().map(|(_, s)| f(*s)).sum::<i64>();
                if parts.is_empty() || sum(|s| s.input) != root.input
                    || sum(|s| s.output) != root.output || sum(|s| s.cache) != root.cache
                    || sum(|s| s.cache_write) != root.cache_write
                    || sum(|s| s.cost_ticks) != root.cost_ticks
                    || (usage.get("reasoningTokens").is_some() && sum(|s| s.reasoning) != root.reasoning)
                {
                    unpartitioned_prompts.insert(prompt.to_string());
                }
                let models = prompt_models.entry(prompt.to_string()).or_default();
                if parts.is_empty() { models.insert(model.clone()); }
                else { models.extend(parts.iter().map(|(m, _)| m.clone())); }
                let mut template = event(model.clone());
                template.cost_incomplete = cost_is_incomplete(usage);
                let missing_model_costs: HashSet<String> = usage.get("modelUsage")
                    .and_then(Value::as_object).into_iter().flat_map(|m| m.iter())
                    .filter(|(_, u)| cost_is_incomplete(u)).map(|(m, _)| m.clone()).collect();
                usage_rows.push((prompt.to_string(), template, root, parts, missing_model_costs));
                continue;
            }
        }
        // Retain timestamps/turn activity from older context-only logs without
        // fabricating either a token split or repeated cached context.
        if let Some(total) = meta.get("totalTokens").and_then(Value::as_i64) {
            if prev_total != Some(total) && tool_signal(&v).is_empty() {
                let mut e = event(model.clone());
                e.is_turn = meta.get("promptId").and_then(Value::as_str)
                    .filter(|p| !p.is_empty()).map(|p| activity_turns.insert(p.to_string())).unwrap_or(false);
                e.cost_incomplete = true;
                activity.push(e);
            }
            prev_total = Some(total);
        }
    }
    let mut snapshots: HashMap<(String, String), UsageSnap> = HashMap::new();
    let mut turns = HashSet::new();
    let mut last_usage: HashMap<(String, String), usize> = HashMap::new();
    let mut pending_cost_flags = HashSet::new();
    for (prompt, template, root, mut parts, missing_model_costs) in usage_rows {
        if unpartitioned_prompts.contains(&prompt) {
            let models = &prompt_models[&prompt];
            // Multiple possible models plus an incomplete partition means the
            // model is unknown, not the last model in the session summary.
            let m = if models.len() == 1 { models.iter().next().cloned().unwrap_or_default() }
                else { String::new() };
            parts = vec![(m, root)];
        }
        for (m, snap) in parts {
            let key = (prompt.clone(), m.clone());
            let d = snapshots.entry(key.clone()).or_default().observe(snap, prompt.is_empty());
            let mut e = template.clone();
            if !unpartitioned_prompts.contains(&prompt) {
                e.cost_incomplete |= missing_model_costs.contains(&m);
            }
            // A quality-only observation is not work: attach uncertainty to
            // existing usage, or hold it until usage actually appears. Never
            // add a timestamp/turn merely to carry this flag. Recovery can
            // still leave earlier monetary allocation uncertain.
            if d.is_empty() {
                if e.cost_incomplete {
                    if let Some(&index) = last_usage.get(&key) {
                        out[index].cost_incomplete = true;
                    } else {
                        pending_cost_flags.insert(key);
                    }
                }
                continue;
            }
            e.cost_incomplete |= pending_cost_flags.remove(&key);
            last_usage.insert(key, out.len());
            e.model = m;
            e.tokens_in = (d.input - d.cache - d.cache_write).max(0);
            e.tokens_out = d.output;
            e.cache_read = d.cache;
            e.cache_write = d.cache_write;
            e.reasoning = d.reasoning;
            e.cost_usd = d.cost_ticks as f64 / 10_000_000_000.0;
            e.is_turn = prompt.is_empty() || turns.insert(prompt.clone());
            out.push(e);
        }
    }
    if !saw_usage { out.extend(activity); }
    out.sort_by_key(|e| e.at);
    Ok(out)
}

/// Identity of a replayed update. Grok restarts its `eventId` counter when a
/// session is resumed, so the same ID can label a different, genuinely new
/// event later in the file. Only a repeat of the same ID with identical
/// content is a replay.
pub(crate) fn replay_key(event_id: &str, row: &Value) -> (String, u64) {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    row.to_string().hash(&mut hasher);
    (event_id.to_string(), hasher.finish())
}

fn cost_is_incomplete(usage: &Value) -> bool {
    // Grok's native projection scrubs monetary totals for incomplete usage.
    // Retain any reported ticks, but never call that partial report complete.
    usage.get("usageIsIncomplete").and_then(Value::as_bool).unwrap_or(false)
        || !usage.get("costUsdTicks").and_then(Value::as_i64).is_some_and(|n| n >= 0)
}

pub(crate) fn parse_usage_snap(usage: &Value) -> Option<UsageSnap> {
    if !["inputTokens", "outputTokens", "cachedReadTokens", "cacheCreationTokens", "costUsdTicks"]
        .iter().any(|k| usage.get(k).and_then(Value::as_i64).is_some()) { return None; }
    let n = |k: &str| usage.get(k).and_then(Value::as_i64).unwrap_or(0).max(0);
    Some(UsageSnap { input: n("inputTokens"), output: n("outputTokens"),
        cache: n("cachedReadTokens"), cache_write: n("cacheCreationTokens"), reasoning: n("reasoningTokens"),
        num_turns: n("numTurns"), cost_ticks: n("costUsdTicks") })
}

fn model_from_line(v: &Value) -> Option<String> {
    let update = v.pointer("/params/update")?;
    update.pointer("/_meta/modelId").or_else(|| update.get("modelId"))
        .and_then(Value::as_str).filter(|m| !m.trim().is_empty()).map(str::to_string)
        .or_else(|| {
            let models = update.pointer("/usage/modelUsage")?.as_object()?;
            (models.len() == 1).then(|| models.keys().next().cloned()).flatten()
        })
}

/// Tool activity on one ACP update line.
///
/// Two traps here, both found by reading the real logs:
///
/// - **`update.kind` is null on virtually every call** (2103 of 2113 locally).
///   The usable name is the first word of `title`, which is either the raw tool
///   name (`run_terminal_command`, `search_replace`) or a prettified phrase
///   (``Edit `/path` ``). Only that first word is read — the rest of the title
///   holds an absolute path and is never touched.
/// - **`tool_call_update` reports status three ways**: `completed` and `failed`
///   are terminal and measurable, `in_progress` is not and must not count
///   towards the denominator.
fn tool_signal(v: &Value) -> ToolTally {
    let mut t = ToolTally::default();
    let Some(u) = v.pointer("/params/update") else {
        return t;
    };
    match u.get("sessionUpdate").and_then(Value::as_str) {
        Some("tool_call") => {
            let name = u
                .get("kind")
                .and_then(Value::as_str)
                .filter(|k| !k.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| title_word(u.get("title").and_then(Value::as_str).unwrap_or("")));
            t.count(classify(&name));
            t.add(&edit_size(u.get("rawInput")));
        }
        Some("tool_call_update") => match u.get("status").and_then(Value::as_str) {
            Some("completed") => t.measured += 1,
            Some("failed") => {
                t.measured += 1;
                t.errors += 1;
            }
            _ => {}
        },
        _ => {}
    }
    t
}

/// The leading identifier of a Grok tool title, lowercased.
fn title_word(title: &str) -> String {
    title
        .trim()
        .split(|c: char| c.is_whitespace() || c == '`')
        .find(|s| !s.is_empty())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn edit_size(raw: Option<&Value>) -> ToolTally {
    let mut t = ToolTally::default();
    let Some(raw) = raw else { return t };
    let s = |k: &str| raw.get(k).and_then(Value::as_str).unwrap_or("");

    if raw.get("old_string").is_some() || raw.get("new_string").is_some() {
        let (add, del) = replacement_lines(s("old_string"), s("new_string"));
        t.lines_added += add;
        t.lines_removed += del;
        t.files_changed += 1;
    } else if raw.get("content").is_some() && raw.get("file_path").is_some() {
        t.lines_added += line_count(s("content"));
        t.files_changed += 1;
    }
    t
}

/// Grok writes `timestamp` as a **Unix epoch number**, not an RFC3339 string —
/// reading it as a string silently drops every event. `agentTimestampMs` is the
/// millisecond fallback.
fn event_time(v: &Value, meta: &Value) -> Option<chrono::DateTime<chrono::Utc>> {
    if let Some(n) = v.get("timestamp").and_then(Value::as_i64) {
        // Seconds if small, ms if large.
        let secs = if n > 10_000_000_000 { n / 1000 } else { n };
        return chrono::DateTime::from_timestamp(secs, 0);
    }
    if let Some(s) = v.get("timestamp").and_then(Value::as_str) {
        if let Some(dt) = parse_ts(s) {
            return Some(dt);
        }
    }
    if let Some(ms) = meta.get("agentTimestampMs").and_then(Value::as_i64) {
        return chrono::DateTime::from_timestamp(ms / 1000, 0);
    }
    None
}

/// Grok encodes cwd as a single path segment with `/` → `%2F`.
pub fn decode_dir(name: &str) -> String {
    let bytes = name.as_bytes();
    let mut out = String::with_capacity(name.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&name[i + 1..i + 3], 16) {
                out.push(b as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

/// Prefer `current_model_id` from summary.json.
pub fn model_from_summary(session_dir: &std::path::Path) -> String {
    let Ok(text) = std::fs::read_to_string(session_dir.join("summary.json")) else {
        return String::new();
    };
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| {
            v.get("current_model_id")
                .or_else(|| v.get("model"))
                .or_else(|| v.pointer("/config/model"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default()
}

/// Falls back to `[models] default` in `~/.grok/config.toml` when a session
/// doesn't name its model.
pub fn configured_default_model() -> String {
    let Some(home) = dirs::home_dir() else {
        return String::new();
    };
    let Ok(text) = std::fs::read_to_string(home.join(".grok").join("config.toml")) else {
        return String::new();
    };
    let mut in_models = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_models = t == "[models]";
            continue;
        }
        if !in_models {
            continue;
        }
        if let Some(rest) = t.strip_prefix("default") {
            if let Some(v) = rest.split('=').nth(1) {
                return v.trim().trim_matches('"').to_string();
            }
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts_to_epoch(ts: &str) -> i64 {
        parse_ts(ts).map(|d| d.timestamp()).unwrap_or(1_785_283_200)
    }

    fn line(ts: &str, total: i64, prompt: &str, _x: &str) -> String {
        let epoch = ts_to_epoch(ts);
        format!(
            r#"{{"timestamp":{epoch},"params":{{"_meta":{{"totalTokens":{total},"promptId":"{prompt}","updateType":"AgentThoughtChunk","agentTimestampMs":{ms}}}}}}}"#,
            epoch = epoch,
            total = total,
            prompt = prompt,
            ms = epoch * 1000,
        )
    }

    fn tool_call(ts: &str, total: i64, title: &str, raw: &str) -> String {
        let epoch = ts_to_epoch(ts);
        format!(
            r#"{{"timestamp":{epoch},"params":{{"update":{{"sessionUpdate":"tool_call","title":"{title}","rawInput":{raw}}},"_meta":{{"totalTokens":{total},"promptId":"p1","updateType":"ToolCall","agentTimestampMs":{ms}}}}}}}"#,
            epoch = epoch,
            title = title,
            raw = raw,
            total = total,
            ms = epoch * 1000,
        )
    }

    fn tool_status(ts: &str, total: i64, status: &str) -> String {
        let epoch = ts_to_epoch(ts);
        format!(
            r#"{{"timestamp":{epoch},"params":{{"update":{{"sessionUpdate":"tool_call_update","status":"{status}"}},"_meta":{{"totalTokens":{total},"promptId":"p1","agentTimestampMs":{ms}}}}}}}"#,
            epoch = epoch,
            status = status,
            total = total,
            ms = epoch * 1000,
        )
    }

    fn turn_completed(ts: &str, input: i64, output: i64, cache: i64, turns: i64, ticks: i64) -> String {
        let epoch = ts_to_epoch(ts);
        format!(
            r#"{{"timestamp":{epoch},"params":{{"update":{{"sessionUpdate":"turn_completed","usage":{{"inputTokens":{input},"outputTokens":{output},"cachedReadTokens":{cache},"numTurns":{turns},"costUsdTicks":{ticks},"modelUsage":{{"grok-4.5":{{}}}}}}}},"_meta":{{"agentTimestampMs":{ms}}}}}}}"#,
            epoch = epoch,
            input = input,
            output = output,
            cache = cache,
            turns = turns,
            ticks = ticks,
            ms = epoch * 1000,
        )
    }

    #[test]
    fn measures_edit_size_from_raw_input() {
        let raw = r#"{"file_path":"/x/a.rs","old_string":"one\ntwo","new_string":"one\ntwo\nthree"}"#;
        let l = tool_call("2026-07-29T14:00:00Z", 100, "search_replace", raw);
        let e = &parse_session(&l, "s", "/x/y", "")[0];
        assert_eq!((e.tools.lines_added, e.tools.lines_removed), (3, 2));
        assert_eq!(e.tools.files_changed, 1);
    }

    #[test]
    fn only_terminal_statuses_count_towards_the_error_rate() {
        let lines = [
            tool_status("2026-07-29T14:00:00Z", 100, "in_progress"),
            tool_status("2026-07-29T14:01:00Z", 200, "completed"),
            tool_status("2026-07-29T14:02:00Z", 300, "failed"),
        ]
        .join("\n");
        let events = parse_session(&lines, "s", "/x/y", "");
        assert_eq!(events.iter().map(|e| e.tools.measured).sum::<i64>(), 2);
        assert_eq!(events.iter().map(|e| e.tools.errors).sum::<i64>(), 1);
    }

    #[test]
    fn a_tool_call_with_no_token_growth_is_still_counted() {
        let lines = [
            tool_call("2026-07-29T14:00:00Z", 100, "read_file", "{}"),
            tool_call("2026-07-29T14:01:00Z", 100, "run_terminal_command", "{}"),
            tool_call("2026-07-29T14:02:00Z", 300, "grep", "{}"),
        ]
        .join("\n");
        let events = parse_session(&lines, "s", "/x/y", "");
        assert_eq!(
            events.iter().map(|e| e.tool_calls).sum::<i64>(),
            3,
            "the zero-delta line's tool call must not be dropped"
        );
    }

    #[test]
    fn context_only_usage_has_no_reported_cost() {
        let l = line("2026-07-29T14:00:00Z", 1_000_000, "p1", "x");
        let e = &parse_session(&l, "s", "/x/y", "grok-4.5")[0];
        assert_eq!(e.cost_usd, 0.0);
    }

    #[test]
    fn context_growth_does_not_prove_cached_reads() {
        let lines = [
            line("2026-07-29T14:00:00Z", 1_000_000, "p1", "x"),
            line("2026-07-29T14:05:00Z", 2_000_000, "p2", "x"),
        ]
        .join("\n");
        let events = parse_session(&lines, "s", "/x/y", "grok-4.5");
        assert_eq!(events[1].tokens_in, 0, "context growth is not billable input");
        assert_eq!(events[1].cache_read, 0, "cache hits must be reported");
        assert_eq!(events[1].cost_usd, 0.0);
    }

    #[test]
    fn a_context_reset_does_not_invent_fresh_input() {
        let lines = [
            line("2026-07-29T14:00:00Z", 900, "p1", "x"),
            line("2026-07-29T14:05:00Z", 100, "p1", "x"),
        ]
        .join("\n");
        let events = parse_session(&lines, "s", "/x/y", "grok-4.5");
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|e| e.tokens_in >= 0 && e.cache_read >= 0));
        assert_eq!(events[1].tokens_in, 0, "post-reset context is not billable input");
        assert_eq!(events[1].cache_read, 0, "nothing carried over a reset");
    }

    #[test]
    fn ignores_chunk_lines_without_a_token_total() {
        let lines = [
            r#"{"timestamp":1785283200,"method":"update","params":{"_meta":{"promptId":"p1"}}}"#.to_string(),
            r#"not json"#.to_string(),
            line("2026-07-29T14:01:00Z", 50, "p1", "x"),
        ]
        .join("\n");
        assert_eq!(parse_session(&lines, "s", "/x/y", "").len(), 1);
    }

    #[test]
    fn prefers_turn_completed_usage_with_cache_and_ticks() {
        // Mid-turn totalTokens noise must be ignored once usage exists.
        let lines = [
            line("2026-07-29T14:00:00Z", 50_000, "p1", "x"),
            turn_completed("2026-07-29T14:05:00Z", 145_113, 1_011, 69_248, 2, 1_785_704_000),
        ]
        .join("\n");
        let events = parse_session(&lines, "s", "/x/y", "grok-4.5");
        assert_eq!(events.len(), 1, "estimate path must not also emit");
        let e = &events[0];
        assert_eq!(e.tokens_in, 145_113 - 69_248);
        assert_eq!(e.tokens_out, 1_011);
        assert_eq!(e.cache_read, 69_248);
        assert!((e.cost_usd - 0.1785704).abs() < 1e-9, "got {}", e.cost_usd);
        assert_eq!(e.model, "grok-4.5");
    }

    #[test]
    fn usage_segments_emit_deltas_and_reset() {
        let lines = [
            turn_completed("2026-07-29T14:00:00Z", 1_000, 10, 800, 2, 1_000_000_000),
            turn_completed("2026-07-29T14:10:00Z", 5_000, 50, 4_000, 10, 5_000_000_000),
            // reset
            turn_completed("2026-07-29T15:00:00Z", 2_000, 20, 1_500, 3, 2_000_000_000),
        ]
        .join("\n");
        let events = parse_session(&lines, "s", "/x/y", "grok-4.5");
        assert_eq!(events.len(), 3);
        // First snapshot full
        assert_eq!(events[0].tokens_in, 1_000 - 800);
        assert_eq!(events[0].cache_read, 800);
        // Delta of second - first
        assert_eq!(events[1].tokens_in, (5_000 - 4_000) - (1_000 - 800));
        assert_eq!(events[1].cache_read, 4_000 - 800);
        assert_eq!(events[1].tokens_out, 50 - 10);
        // New segment after reset
        assert_eq!(events[2].tokens_in, 2_000 - 1_500);
        assert_eq!(events[2].cache_read, 1_500);
        // ticks: 1e9 + (5e9−1e9) + 2e9 = 7e9 → $0.70
        let total_cost: f64 = events.iter().map(|e| e.cost_usd).sum();
        assert!((total_cost - 0.7).abs() < 1e-9, "got {total_cost}");
    }

    #[test]
    fn reads_current_model_id_from_summary() {
        let dir = std::env::temp_dir().join(format!("agmux-grok-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("summary.json"),
            r#"{"current_model_id":"grok-4.5","num_messages":403}"#,
        )
        .unwrap();
        assert_eq!(model_from_summary(&dir), "grok-4.5");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
#[path = "grok_audit_tests.rs"]
mod audit_tests;
