//! Codex rollout reader.
//!
//! Source: `~/.codex/sessions/YYYY/MM/DD/rollout-*-{session_id}.jsonl`. Every
//! line is timestamped, and token-count events carry `input_tokens`,
//! `cached_input_tokens` / `cache_read_input_tokens`, `cache_write_input_tokens`,
//! `output_tokens` and `reasoning_output_tokens` — Codex is the one provider
//! that reports reasoning tokens, and the old pipeline dropped them entirely.
//!
//! `total_token_usage` is cumulative for the session, so we prefer
//! `last_token_usage` (per turn) and fall back to differencing the running
//! total. Summing the cumulative field directly would massively over-count.

use serde_json::Value;
use std::collections::{HashMap, HashSet};

use super::super::aggregate::{parse_ts, project_key, UsageEvent};
use crate::commands::usage_stats::{estimate_token_cost_checked, model_requires_cache_write_usage, TokenCostSpec};
use super::tools::{classify, line_count, unified_diff_lines, ToolTally};
use crate::commands::usage_stats::{CodexHistoryBoundary, CodexSessionCounter, CodexUsageFields};

pub struct CodexParse {
    pub session_id: String,
    pub forked_from_id: Option<String>,
    pub watermark: CodexUsageFields,
    pub events: Vec<UsageEvent>,
}

/// Native Codex chats use provider IDs directly and need not have a `threads`
/// row. The rollout header records the client that actually created them.
pub fn started_in_agmux(header: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(header) else { return false };
    v.get("type").and_then(Value::as_str) == Some("session_meta")
        && matches!(v.pointer("/payload/originator").and_then(Value::as_str), Some("agmux" | "xanom"))
}

/// Parses one rollout file into usage events.
pub fn parse_session(lines: &str, session_id: &str) -> Vec<UsageEvent> {
    parse_session_ex(lines, session_id, None).events
}

/// Like [`parse_session`], retaining the legacy inheritance argument for callers.
/// Parent final totals are not a fork baseline: the parent can keep working and
/// subagents start fresh counters even when their header has `forked_from_id`.
pub fn parse_session_ex(
    lines: &str,
    session_id: &str,
    inherit: Option<CodexUsageFields>,
) -> CodexParse {
    parse_lines(lines.lines(), session_id, inherit)
}

/// Stream large rollouts instead of dropping them at the JSONL size limit or
/// holding all changed transcripts in memory at once.
pub fn parse_file(
    path: &std::path::Path,
    session_id: &str,
    inherit: Option<CodexUsageFields>,
) -> Result<CodexParse, String> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let mut error = None;
    let lines = std::iter::from_fn(|| {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => None,
            Ok(_) => Some(line),
            Err(e) => { error = Some(e.to_string()); None }
        }
    });
    let parsed = parse_lines(lines, session_id, inherit);
    match error {
        Some(e) => Err(e),
        None => Ok(parsed),
    }
}

fn parse_lines<I, S>(
    lines: I,
    session_id: &str,
    _inherit: Option<CodexUsageFields>,
) -> CodexParse
where I: IntoIterator<Item = S>, S: AsRef<str> {
    let mut out: Vec<UsageEvent> = Vec::new();
    let mut cwd: Option<String> = None;
    let mut model = String::new();
    let mut parsed_id = session_id.to_string();
    let mut header_seen = false;
    let mut forked_from_id: Option<String> = None;
    let mut counter = CodexSessionCounter::default();
    let mut history_boundary = CodexHistoryBoundary::default();
    // Tool calls and patch results sit on their own lines, ahead of the
    // `token_count` line that closes the turn, so they are accumulated here and
    // flushed into the next usage event.
    let mut pending_tools = ToolTally::default();
    let mut turn_id = String::new();
    let mut native_turns = HashSet::new();
    let mut native_responses = HashSet::new();
    let mut native_coverage: HashMap<String, ([i64; 5], [i64; 5])> = HashMap::new();
    let mut event_turns = Vec::new();
    let mut tools_by_turn: HashMap<String, ToolTally> = HashMap::new();
    let mut eligible_tool_turns = HashSet::new();
    let mut first_native_at = None;

    for line in lines {
        let line = line.as_ref().trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };

        // Fork histories may contain copied ancestor headers. Only the first
        // header describes this rollout; later ones cannot change its identity,
        // creation cutoff, lineage, or project metadata.
        if v.get("type").and_then(Value::as_str) == Some("session_meta") {
            if header_seen { continue; }
            header_seen = v.get("payload").is_some_and(Value::is_object);
        }

        if let Some(c) = v
            .pointer("/payload/cwd")
            .or_else(|| v.get("cwd"))
            .and_then(Value::as_str)
        {
            if !c.is_empty() {
                cwd = Some(c.to_string());
            }
        }
        if let Some(m) = v
            .pointer("/payload/model")
            .or_else(|| v.pointer("/payload/turn_context/model"))
            .or_else(|| v.get("model"))
            .and_then(Value::as_str)
        {
            if !m.is_empty() {
                model = m.to_string();
            }
        }

        if v.get("type").and_then(Value::as_str) == Some("session_meta") {
            if let Some(p) = v.get("payload") {
                if let Some(id) = p
                    .get("id")
                    .or_else(|| p.get("session_id"))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    parsed_id = id.to_string();
                }
                if forked_from_id.is_none() {
                    forked_from_id = p
                        .get("forked_from_id")
                        .or_else(|| p.get("forkedFromId"))
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(ToOwned::to_owned);
                }
                history_boundary = CodexHistoryBoundary::from_meta(p);
            }
        }

        if v.get("type").and_then(Value::as_str) == Some("turn_context") {
            turn_id = v.pointer("/payload/turn_id").and_then(Value::as_str).unwrap_or("").to_string();
        }
        let native = v.get("type").and_then(Value::as_str) == Some("token_usage_record");
        // This is a logical billing owner, unlike the physical history/projection
        // boundary. Compaction can retain OWN response records before that boundary.
        if native && v.pointer("/payload/thread_id").and_then(Value::as_str) != Some(parsed_id.as_str()) { continue; }
        let copied = !native && history_boundary.is_copied(&v);
        let signal = tool_signal(&v);
        if !turn_id.is_empty() {
            if !copied { eligible_tool_turns.insert(turn_id.clone()); }
            tools_by_turn.entry(turn_id.clone()).or_default().add(&signal);
        } else if !copied { pending_tools.add(&signal); }

        let info = v
            .pointer("/payload/info")
            .or_else(|| v.get("info"))
            .unwrap_or(&Value::Null);

        let last_usage = if native { v.pointer("/payload/usage") } else { info.get("last_token_usage") }
            .filter(|u| u.is_object());
        let total_usage = if native { None } else { info.get("total_token_usage").filter(|u| u.is_object()) };
        let last = last_usage.map(CodexUsageFields::read);
        let total = total_usage.map(CodexUsageFields::read);
        if last.is_none() && total.is_none() {
            continue;
        }

        let Some(at) = v
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_ts)
        else {
            continue;
        };

        let event_turn = if native { v.pointer("/payload/turn_id").and_then(Value::as_str).unwrap_or("") } else { &turn_id };
        let t = if native {
            let Some(response) = v.pointer("/payload/response_id").and_then(Value::as_str).filter(|id| !id.is_empty()) else { continue };
            if !native_responses.insert(response.to_string()) { continue; }
            let Some(usage) = last else { continue };
            native_turns.insert(event_turn.to_string());
            let coverage = native_coverage.entry(event_turn.to_string()).or_default();
            let measured = [usage.input, usage.cached, usage.cache_write, usage.output, usage.reasoning];
            let reported = CodexUsageFields::read(&v["payload"]["turn_token_usage"]);
            let reported = [reported.input, reported.cached, reported.cache_write, reported.output, reported.reasoning];
            for i in 0..5 { coverage.0[i] += measured[i]; coverage.1[i] = coverage.1[i].max(reported[i]); }
            first_native_at = Some(first_native_at.map_or(at, |first: chrono::DateTime<chrono::Utc>| first.min(at)));
            usage
        } else {
            let Some(delta) = counter.apply(last, total) else { continue };
            delta
        };

        // Copied history is before the native ordinal/time boundary. Consume its counters
        // as the baseline, but do not bill it again. A fresh subagent's first
        // usage occurs after creation and is counted without parent totals.
        if copied {
            pending_tools = ToolTally::default();
            continue;
        }

        let m = model.clone(); // Missing model identity stays unknown, not a guessed family.
        let tools = if event_turn.is_empty() { std::mem::take(&mut pending_tools) } else { ToolTally::default() };
        let (pure_in, cached, cache_write) = t.split_input();
        // A cumulative-only delta may cover several requests. Tokens remain
        // usable, but request-tier pricing cannot be reconstructed from it.
        // Missing write counters are not explicit zero on write-priced models.
        let write_reported = last_usage.and_then(|u| u.get("cache_write_input_tokens"))
            .and_then(Value::as_i64).is_some_and(|n| n >= 0);
        let cost = estimate_token_cost_checked(Some(&m), TokenCostSpec {
            pure_input: pure_in, pure_output: t.output, cache_read: cached,
            cache_write, cache_write_1h: 0,
        });
        let cost_incomplete = model.is_empty() || last.is_none() || cost.is_err()
            || last.is_some_and(|last| last != t)
            || (model_requires_cache_write_usage(&m) && !write_reported);
        event_turns.push((event_turn.to_string(), native));
        out.push(UsageEvent {
            at,
            provider: "Codex".into(),
            model: m.clone(),
            project_key: project_key(cwd.as_deref().unwrap_or(""), false),
            session_id: parsed_id.clone(),
            tokens_in: pure_in,
            tokens_out: t.output,
            cache_read: cached,
            cache_write,
            reasoning: t.reasoning,
            cost_usd: if cost_incomplete { 0.0 } else { cost.unwrap_or(0.0) },
            cost_incomplete,
            is_turn: true,
            tool_calls: tools.calls(),
            tools,
            claude_row_key: None,
            is_sidechain: false,
            is_subagent_path: false,
        });
    }

    // Per-response records are the accounting authority for their turn. Legacy
    // token_count mirrors can use a different cumulative basis; never add both.
    out = out.into_iter().zip(event_turns).filter_map(|(mut event, (turn, native))| {
        if !native && (native_turns.contains(&turn)
            || (turn.is_empty() && first_native_at.is_some_and(|first| event.at >= first))) { return None; }
        if native && native_coverage.get(&turn).is_some_and(|(measured, reported)| measured.iter().zip(reported).any(|(a, b)| a < b)) {
            event.cost_incomplete = true; // Missing responses cannot be reconstructed or priced by guessing.
        }
        if let Some(tools) = tools_by_turn.remove(&turn) {
            event.tools.add(&tools);
            event.tool_calls = event.tools.calls();
        }
        Some(event)
    }).collect();

    for (turn, tools) in tools_by_turn {
        if eligible_tool_turns.contains(&turn) { pending_tools.add(&tools); }
    }

    // A turn whose tool calls were never closed by a `token_count` line still
    // did the work; credit it to the last event rather than losing it.
    if !pending_tools.is_empty() {
        if let Some(last) = out.last_mut() {
            last.tools.add(&pending_tools);
            last.tool_calls = last.tools.calls();
        }
    }

    // Backfill project for events seen before the first `cwd` line.
    if let Some(c) = cwd {
        let key = project_key(&c, false);
        for e in &mut out {
            if e.project_key.is_empty() {
                e.project_key = key.clone();
            }
        }
    }
    CodexParse {
        session_id: parsed_id,
        forked_from_id,
        watermark: counter.watermark(),
        events: out,
    }
}

/// Tool activity on one rollout line.
///
/// Codex spreads this across three payload types: `function_call` and
/// `custom_tool_call` name the tool, and `patch_apply_end` reports what a patch
/// actually did.
///
/// **Codex has no general tool-outcome flag.** `function_call_output` is a bare
/// text blob — "Script completed" reads the same whether the command exited 0 or
/// 1. So only patch applies contribute to `measured`; the error rate is honest
/// about covering a subset rather than scoring every other call as a success.
fn tool_signal(v: &serde_json::Value) -> ToolTally {
    let mut t = ToolTally::default();
    let Some(payload) = v.get("payload") else {
        return t;
    };
    match payload.get("type").and_then(Value::as_str) {
        Some("function_call") | Some("custom_tool_call") | Some("local_shell_call") => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("local_shell_call");
            t.count(classify(name));
        }
        Some("patch_apply_end") => {
            t.measured += 1;
            let ok = payload.get("success").and_then(Value::as_bool) != Some(false);
            if !ok {
                t.errors += 1;
                // A patch that failed changed nothing; don't credit its lines.
                return t;
            }
            let changes = payload.get("changes").and_then(Value::as_object);
            for (_path, change) in changes.into_iter().flatten() {
                t.files_changed += 1;
                match change.get("type").and_then(Value::as_str) {
                    // A new file: every line is an addition.
                    Some("add") => {
                        t.lines_added += line_count(
                            change.get("content").and_then(Value::as_str).unwrap_or(""),
                        );
                    }
                    // An edit: the diff carries both sides.
                    _ => {
                        let (add, del) = unified_diff_lines(
                            change.get("unified_diff").and_then(Value::as_str).unwrap_or(""),
                        );
                        t.lines_added += add;
                        t.lines_removed += del;
                    }
                }
            }
        }
        _ => {}
    }
    t
}

/// Rollout filenames embed the session UUID: `rollout-<ts>-<uuid>.jsonl`.
pub fn session_id_from_path(path: &std::path::Path) -> String {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    stem.rsplit('-').take(5).collect::<Vec<_>>().join("-");
    // The UUID is the last 5 dash-separated groups; fall back to the whole stem.
    let parts: Vec<&str> = stem.split('-').collect();
    if parts.len() >= 5 {
        parts[parts.len() - 5..].join("-")
    } else {
        stem
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agmux_originators_claim_native_chats_without_database_rows() {
        for originator in ["agmux", "xanom"] {
            let meta = serde_json::json!({"type":"session_meta","payload":{
                "id":"native-chat", "originator":originator, "source":"cli"
            }});
            assert!(started_in_agmux(&meta.to_string()), "{originator}");
        }
    }

    #[test]
    fn external_sessions_and_prompt_mentions_do_not_claim_ownership() {
        for originator in ["codex-tui", "codex_exec", "codex_work_desktop", ""] {
            let meta = serde_json::json!({"type":"session_meta","payload":{
                "id":"external", "originator":originator
            }});
            assert!(!started_in_agmux(&meta.to_string()));
        }
        assert!(!started_in_agmux(r#"{"type":"response_item","payload":{"originator":"agmux"}}"#));
        assert!(!started_in_agmux("not json"));
    }

    fn line(ts: &str, body: &str) -> String {
        format!(r#"{{"timestamp":"{ts}","payload":{{{body}}}}}"#)
    }

    /// Closes a turn so pending tool calls flush into an event.
    fn usage(ts: &str, input: i64) -> String {
        line(
            ts,
            &format!(
                r#""model":"gpt-5-codex","info":{{"last_token_usage":{{"input_tokens":{input}}}}}"#
            ),
        )
    }

    #[test]
    fn counts_tool_calls_by_kind() {
        let lines = [
            line("2026-07-29T14:00:00Z", r#""type":"function_call","name":"exec_command""#),
            line("2026-07-29T14:00:01Z", r#""type":"custom_tool_call","name":"apply_patch""#),
            line("2026-07-29T14:00:02Z", r#""type":"function_call","name":"spawn_agent""#),
            usage("2026-07-29T14:00:03Z", 10),
        ]
        .join("\n");
        let e = &parse_session(&lines, "s")[0];
        assert_eq!(e.tools.bash, 1);
        assert_eq!(e.tools.edit, 1);
        assert_eq!(e.tools.agent, 1);
        assert_eq!(e.tool_calls, 3, "Codex used to report zero tool calls");
    }

    #[test]
    fn patch_apply_end_supplies_the_line_counts() {
        let changes = r#"{"/w/a.rs":{"type":"update","unified_diff":"--- a/a.rs\n+++ b/a.rs\n@@\n-old\n+new\n+extra\n"},"/w/b.md":{"type":"add","content":"x\ny\nz"}}"#;
        let lines = [
            line(
                "2026-07-29T14:00:00Z",
                &format!(r#""type":"patch_apply_end","success":true,"changes":{changes}"#),
            ),
            usage("2026-07-29T14:00:01Z", 10),
        ]
        .join("\n");
        let e = &parse_session(&lines, "s")[0];
        assert_eq!(e.tools.files_changed, 2);
        assert_eq!(e.tools.lines_added, 5, "2 from the diff + 3 from the new file");
        assert_eq!(e.tools.lines_removed, 1);
        assert_eq!(e.tools.measured, 1);
        assert_eq!(e.tools.errors, 0);
    }

    #[test]
    fn a_failed_patch_is_an_error_and_changes_nothing() {
        let lines = [
            line("2026-07-29T14:00:00Z", r#""type":"patch_apply_end","success":false,"changes":{"/w/a.rs":{"type":"add","content":"a\nb"}}"#),
            usage("2026-07-29T14:00:01Z", 10),
        ]
        .join("\n");
        let e = &parse_session(&lines, "s")[0];
        assert_eq!((e.tools.errors, e.tools.measured), (1, 1));
        assert_eq!(e.tools.lines_added, 0, "a failed patch wrote nothing");
        assert_eq!(e.tools.files_changed, 0);
    }

    #[test]
    fn plain_tool_calls_do_not_inflate_the_error_denominator() {
        // Codex reports no outcome for exec calls, so they must stay out of
        // `measured` rather than being scored as successes.
        let lines = [
            line("2026-07-29T14:00:00Z", r#""type":"function_call","name":"exec_command""#),
            usage("2026-07-29T14:00:01Z", 10),
        ]
        .join("\n");
        let e = &parse_session(&lines, "s")[0];
        assert_eq!(e.tools.bash, 1);
        assert_eq!(e.tools.measured, 0, "an unobservable outcome is not a success");
    }

    #[test]
    fn tool_calls_after_the_last_usage_line_are_still_credited() {
        let lines = [
            usage("2026-07-29T14:00:00Z", 10),
            line("2026-07-29T14:00:05Z", r#""type":"function_call","name":"exec_command""#),
        ]
        .join("\n");
        let events = parse_session(&lines, "s");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tool_calls, 1);
    }

    #[test]
    fn parses_per_turn_usage_including_reasoning() {
        // Realistic OpenAI shape: input includes cache; reasoning ⊆ output.
        let l = line(
            "2026-07-29T14:05:00Z",
            r#""cwd":"/Users/neel/code/helios-api","model":"gpt-5.6-sol","info":{"last_token_usage":{"input_tokens":1000,"output_tokens":50,"cached_input_tokens":900,"cache_write_input_tokens":10,"reasoning_output_tokens":40}}"#,
        );
        let e = &parse_session(&l, "sess-1")[0];
        assert_eq!(e.provider, "Codex");
        assert_eq!(e.model, "gpt-5.6-sol");
        assert_eq!(e.project_key, "helios-api");
        assert_eq!(
            (e.tokens_in, e.tokens_out, e.cache_read, e.cache_write),
            (90, 50, 900, 10),
            "tokens_in is uncached (input − cache − write)"
        );
        assert_eq!(e.reasoning, 40, "reasoning tokens must survive as breakdown");
        // uncached 90 @ $4 + cache 900 @ $0.40 + write 10 @ $5 + out 50 @ $20
        let expected =
            90.0 / 1e6 * 4.0 + 900.0 / 1e6 * 0.40 + 10.0 / 1e6 * 5.0 + 50.0 / 1e6 * 20.0;
        assert!(
            (e.cost_usd - expected).abs() < 1e-9,
            "got {} expected {}",
            e.cost_usd,
            expected
        );
    }

    #[test]
    fn pure_input_subtracts_cache_from_openai_inclusive_input() {
        let l = line(
            "2026-07-29T14:05:00Z",
            r#""cwd":"/Users/neel/code/helios-api","model":"gpt-5.6-sol","info":{"last_token_usage":{"input_tokens":17879,"output_tokens":363,"cached_input_tokens":11008,"cache_write_input_tokens":0,"reasoning_output_tokens":101}}"#,
        );
        let e = &parse_session(&l, "sess-1")[0];
        assert_eq!(e.tokens_in, 17879 - 11008);
        assert_eq!(e.cache_read, 11008);
        assert_eq!(e.tokens_out, 363);
        assert_eq!(e.reasoning, 101);
        // Sol: pure*4 + cache*0.40 + out*20 — reasoning already inside out.
        let expected = (17879 - 11008) as f64 / 1e6 * 4.0
            + 11008.0 / 1e6 * 0.40
            + 363.0 / 1e6 * 20.0;
        assert!((e.cost_usd - expected).abs() < 1e-9, "got {}", e.cost_usd);
    }

    #[test]
    fn write_priced_models_require_reported_write_counters() {
        let row = |model: &str, write: Option<i64>| {
            let mut usage = serde_json::json!({"input_tokens":1000,"cached_input_tokens":800,
                "output_tokens":100,"reasoning_output_tokens":80});
            if let Some(write) = write { usage["cache_write_input_tokens"] = write.into(); }
            serde_json::json!({"timestamp":"2026-09-08T14:00:00Z", "payload":{
                "model":model,"info":{"last_token_usage":usage}}}).to_string()
        };
        // Reproduce the audit cohort's missing-write reports without private logs.
        let missing = std::iter::repeat_n(row("gpt-5.6-sol", None), 432)
            .chain(std::iter::repeat_n(row("gpt-5.6-luna", None), 14)).collect::<Vec<_>>().join("\n");
        let events = parse_session(&missing, "s");
        assert_eq!(events.len(), 446);
        assert!(events.iter().all(|e| e.cost_incomplete && e.cost_usd == 0.0));
        for model in ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"] {
            let events = parse_session(&row(model, Some(0)), "s");
            assert!(!events[0].cost_incomplete, "explicit zero is reported: {model}");
            assert!(events[0].cost_usd > 0.0, "known model: {model}");
            let written = parse_session(&row(model, Some(150)), "s");
            assert_eq!((written[0].tokens_in, written[0].cache_read, written[0].cache_write), (50, 800, 150));
            assert_eq!(written[0].tokens_in + written[0].cache_read + written[0].cache_write + written[0].tokens_out, 1100);
            assert_eq!(written[0].reasoning, 80);
        }
    }

    #[test]
    fn cumulative_write_buckets_survive_deltas_without_double_counting() {
        let row = |n: i64| serde_json::json!({"timestamp":"2026-09-08T14:00:00Z",
            "payload":{"model":"gpt-6-astra","info":{
                "last_token_usage":{"input_tokens":1000,"cached_input_tokens":800,
                    "cache_write_input_tokens":150,"output_tokens":100,"reasoning_output_tokens":80},
                "total_token_usage":{"input_tokens":1000*n,"cached_input_tokens":800*n,
                    "cache_write_input_tokens":150*n,"output_tokens":100*n,"reasoning_output_tokens":80*n}
            }}}).to_string();
        let events = parse_session(&[row(1), row(1), row(2)].join("\n"), "s");
        assert_eq!(events.len(), 2);
        assert_eq!(events.iter().map(|e| e.cache_write).sum::<i64>(), 300);
        assert_eq!(events.iter().map(|e| e.tokens_in + e.cache_read + e.cache_write + e.tokens_out).sum::<i64>(), 2200);
        assert!(events.iter().all(|e| !e.cost_incomplete && e.cost_usd > 0.0));
    }

    #[test]
    fn cumulative_only_and_unknown_models_keep_tokens_but_not_a_price() {
        for payload in [
            serde_json::json!({"model":"gpt-6-astra","info":{"total_token_usage":{
                "input_tokens":300000,"cache_write_input_tokens":0,"output_tokens":100}}}),
            serde_json::json!({"model":"unknown-audit-model","info":{"last_token_usage":{
                "input_tokens":300000,"cache_write_input_tokens":0,"output_tokens":100}}}),
            serde_json::json!({"info":{"last_token_usage":{
                "input_tokens":300000,"cache_write_input_tokens":0,"output_tokens":100}}}),
        ] {
            let missing_model = payload.get("model").is_none();
            let row = serde_json::json!({"timestamp":"2026-09-08T14:00:00Z","payload":payload}).to_string();
            let events = parse_session(&row, "s");
            assert_eq!(events[0].tokens_in + events[0].tokens_out, 300100);
            assert!(events[0].cost_incomplete);
            assert_eq!(events[0].cost_usd, 0.0);
            if missing_model { assert!(events[0].model.is_empty()); }
        }
    }

    #[test]
    fn accounting_audit_prices_each_request_with_its_model() {
        let row = |model: &str, total: i64| serde_json::json!({
            "timestamp":"2026-07-29T14:05:00Z", "payload":{"model":model,"info":{
                "last_token_usage":{"input_tokens":160000,"cached_input_tokens":150000,"cache_write_input_tokens":0,
                    "output_tokens":100,"reasoning_output_tokens":80},
                "total_token_usage":{"input_tokens":160000*total,"cached_input_tokens":150000*total,"cache_write_input_tokens":0,
                    "output_tokens":100*total,"reasoning_output_tokens":80*total}
            }}
        }).to_string();
        let rows = [row("gpt-5.6-sol", 1), row("gpt-5.6-sol", 1), row("gpt-5.6-sol", 2)].join("\n");
        let events = parse_session(&rows, "s");
        assert_eq!(events.len(), 2);
        // 320k cumulative input must not charge the >272k request tier.
        // Cached input is a subset of input; reasoning a subset of output.
        let per_request = (10000.0 * 4.0 + 150000.0 * 0.4 + 100.0 * 20.0) / 1e6;
        assert!((events.iter().map(|e| e.cost_usd).sum::<f64>() - 2.0 * per_request).abs() < 1e-9);
        let changed = parse_session(&[row("gpt-5.6-sol", 1), row("gpt-5.4-mini", 2)].join("\n"), "s");
        assert_eq!(changed[0].model, "gpt-5.6-sol");
        assert_eq!(changed[1].model, "gpt-5.4-mini");
        assert!(changed[1].cost_usd < changed[0].cost_usd);
    }

    #[test]
    fn differences_a_cumulative_total_instead_of_summing_it() {
        // total_token_usage grows across the session; naive summing would
        // report 100 + 300 = 400 input tokens instead of 300.
        let a = line(
            "2026-07-29T14:00:00Z",
            r#""model":"gpt-5.6-sol","info":{"total_token_usage":{"input_tokens":100,"output_tokens":10}}"#,
        );
        let b = line(
            "2026-07-29T14:05:00Z",
            r#""model":"gpt-5.6-sol","info":{"total_token_usage":{"input_tokens":300,"output_tokens":40}}"#,
        );
        let events = parse_session(&format!("{a}\n{b}"), "s");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].tokens_in, 100);
        assert_eq!(events[1].tokens_in, 200, "second event is the delta");
        assert_eq!(events.iter().map(|e| e.tokens_in).sum::<i64>(), 300);
    }

    #[test]
    fn explicit_zero_reset_counts_total_only_usage_in_each_segment() {
        // A zero snapshot is an observed boundary. A bare 500 -> 20 without
        // last usage or a reset boundary could also be restored history.
        let totals = [500, 0, 20, 20, 0, 20, 40];
        let lines = totals.iter().enumerate().map(|(i, input)| line(
            &format!("2026-07-29T14:00:{i:02}Z"),
            &format!(r#""info":{{"total_token_usage":{{"input_tokens":{input}}}}}"#),
        )).collect::<Vec<_>>().join("\n");
        let events = parse_session(&lines, "s");
        assert_eq!(events.iter().map(|e| e.tokens_in).sum::<i64>(), 560);
        assert_eq!(events.len(), 4);
    }

    #[test]
    fn explicit_zero_reset_counts_equal_response_totals_in_new_segment() {
        let mut counter = CodexSessionCounter::default();
        let usage = CodexUsageFields { input: 500, cached: 400, output: 20, reasoning: 5, ..Default::default() };
        for _ in 0..2 {
            assert_eq!(counter.apply(Some(usage), Some(usage)), Some(usage));
            assert!(counter.apply(Some(usage), Some(usage)).is_none());
            assert!(counter.apply(Some(CodexUsageFields::default()), Some(CodexUsageFields::default())).is_none());
        }
    }

    #[test]
    fn prefers_per_turn_over_cumulative_when_both_are_present() {
        let l = line(
            "2026-07-29T14:00:00Z",
            r#""info":{"last_token_usage":{"input_tokens":7},"total_token_usage":{"input_tokens":9999}}"#,
        );
        assert_eq!(parse_session(&l, "s")[0].tokens_in, 7);
    }

    #[test]
    fn uses_cache_read_input_tokens_when_cached_input_tokens_is_absent() {
        let l = line(
            "2026-07-29T14:05:00Z",
            r#""model":"gpt-5.6-sol","info":{"last_token_usage":{"input_tokens":1000,"output_tokens":10,"cache_read_input_tokens":400}}"#,
        );
        let e = &parse_session(&l, "s")[0];
        assert_eq!((e.tokens_in, e.cache_read, e.tokens_out), (600, 400, 10));
    }

    #[test]
    fn prefers_the_larger_of_the_two_cache_aliases() {
        let l = line(
            "2026-07-29T14:05:00Z",
            r#""model":"gpt-5.6-sol","info":{"last_token_usage":{"input_tokens":1000,"cached_input_tokens":100,"cache_read_input_tokens":400,"output_tokens":1}}"#,
        );
        let e = &parse_session(&l, "s")[0];
        assert_eq!((e.tokens_in, e.cache_read), (600, 400));
    }

    fn fork_header() -> String {
        serde_json::json!({"type":"session_meta", "payload":{
            "id":"child", "session_id":"parent", "forked_from_id":"parent",
            "timestamp":"2026-07-29T14:01:00Z",
            "source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}}
        }}).to_string()
    }

    #[test]
    fn native_response_records_preserve_own_work_and_replace_legacy_turn_mirrors() {
        let header = serde_json::json!({"type":"session_meta","payload":{"id":"child","forked_from_id":"parent",
            "timestamp":"2026-07-29T14:00:00Z","subagent_history_start_ordinal":100}});
        let usage = serde_json::json!({"input_tokens":30,"output_tokens":10});
        let native = serde_json::json!({"type":"token_usage_record","ordinal":50,"timestamp":"2026-07-29T14:02:00Z",
            "payload":{"thread_id":"child","turn_id":"own-turn","response_id":"response-1","usage":usage,
                "thread_token_usage":{"input_tokens":10030,"output_tokens":10010}}});
        let outside = serde_json::json!({"type":"token_usage_record","ordinal":51,"timestamp":"2026-07-29T14:02:00Z",
            "payload":{"thread_id":"parent","turn_id":"parent-turn","response_id":"parent-response","usage":{"input_tokens":500}}});
        let context = serde_json::json!({"type":"turn_context","payload":{"turn_id":"own-turn","model":"gpt-5"}});
        let legacy = serde_json::json!({"type":"event_msg","ordinal":101,"timestamp":"2026-07-29T14:02:00Z",
            "payload":{"type":"token_count","info":{"last_token_usage":usage,"total_token_usage":usage}}});
        for rows in [vec![header.clone(),context.clone(),native.clone(),native.clone(),outside.clone(),legacy.clone()],
            vec![header.clone(),context.clone(),legacy,native.clone(),outside]] {
            let parsed = parse_session(&rows.iter().map(Value::to_string).collect::<Vec<_>>().join("\n"), "child");
            assert_eq!(parsed.iter().map(|e| e.tokens_in + e.tokens_out).sum::<i64>(), 40);
            assert_eq!(parsed.len(), 1);
        }
        let only = parse_session(&[header.to_string(),context.to_string(),native.to_string()].join("\n"),"child");
        assert_eq!(only.iter().map(|e| e.tokens_in + e.tokens_out).sum::<i64>(),40);
    }

    #[test]
    fn paginated_child_counts_only_own_ordinals_even_when_history_is_retimestamped() {
        let mut header: Value = serde_json::from_str(&fork_header()).unwrap();
        header["payload"]["history_mode"] = "paginated".into();
        header["payload"]["subagent_history_start_ordinal"] = 10.into();
        let mut rows = vec![header.to_string()];
        for (ordinal, total, last) in [(5, 1000, 0), (8, 1100, 100), (10, 1130, 30)] {
            rows.push(serde_json::json!({"type":"event_msg", "ordinal":ordinal,
                "timestamp":"2026-07-29T14:02:00Z", "payload":{"type":"token_count", "info":{
                    "total_token_usage":{"input_tokens":total}, "last_token_usage":{"input_tokens":last}
                }}}).to_string());
        }
        let parsed = parse_session(&rows.join("\n"), "child");
        assert_eq!(parsed.iter().map(|e| e.tokens_in).sum::<i64>(), 30);
        assert_eq!(parsed.len(), 1);
    }

    #[test]
    fn fork_subagent_counts_own_usage_below_parent_final_watermark() {
        let lines = [fork_header(), usage("2026-07-29T14:02:00Z", 50)].join("\n");
        let parent_final = CodexUsageFields { input: 5000, output: 100, ..Default::default() };
        let child = parse_session_ex(&lines, "child", Some(parent_final));
        assert_eq!(child.events.len(), 1);
        assert_eq!(child.events[0].tokens_in, 50);
        assert_eq!(child.events[0].session_id, "child");
    }

    #[test]
    fn fork_uses_its_copied_prefix_not_later_parent_work() {
        let copied = line("2026-07-29T14:00:00Z",
            r#""info":{"last_token_usage":{"input_tokens":100},"total_token_usage":{"input_tokens":100}}"#);
        let unique = line("2026-07-29T14:02:00Z",
            r#""info":{"last_token_usage":{"input_tokens":50},"total_token_usage":{"input_tokens":150}}"#);
        let lines = [fork_header(), copied, unique].join("\n");
        for inherit in [None, Some(CodexUsageFields { input: 5000, ..Default::default() })] {
            let child = parse_session_ex(&lines, "child", inherit);
            assert_eq!(child.events.len(), 1);
            assert_eq!(child.events[0].tokens_in, 50);
        }
    }

    #[test]
    fn fork_with_fresh_cumulative_counters_counts_first_and_repeated_events_once() {
        let first = line("2026-07-29T14:02:00Z",
            r#""info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":10,"reasoning_output_tokens":4},"total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":10,"reasoning_output_tokens":4}}"#);
        let lines = [fork_header(), first.clone(), first].join("\n");
        let child = parse_session_ex(&lines, "child", Some(CodexUsageFields { input: 5000, ..Default::default() }));
        assert_eq!(child.events.len(), 1);
        let e = &child.events[0];
        assert_eq!((e.tokens_in, e.cache_read, e.tokens_out, e.reasoning), (20, 80, 10, 4));
    }

    #[test]
    fn copied_fork_metadata_cannot_replace_child_identity_or_cutoff() {
        let parent = serde_json::json!({"type":"session_meta","payload":{
            "id":"parent", "forked_from_id":"grandparent", "timestamp":"2026-07-29T14:00:00Z"
        }}).to_string();
        let copied = line("2026-07-29T14:00:30Z",
            r#""info":{"total_token_usage":{"input_tokens":100},"last_token_usage":{"input_tokens":100}}"#);
        let own = line("2026-07-29T14:02:00Z",
            r#""info":{"total_token_usage":{"input_tokens":150},"last_token_usage":{"input_tokens":50}}"#);
        let parsed = parse_session_ex(&[fork_header(), parent, copied, own].join("\n"), "child", None);
        assert_eq!(parsed.session_id, "child");
        assert_eq!(parsed.forked_from_id.as_deref(), Some("parent"));
        assert_eq!(parsed.events.len(), 1);
        assert_eq!(parsed.events[0].session_id, "child");
        assert_eq!(parsed.events[0].tokens_in, 50);
    }

    #[test]
    fn copied_fork_metadata_cannot_add_lineage_to_nonfork_header() {
        let root = serde_json::json!({"type":"session_meta","payload":{"id":"root"}}).to_string();
        let parsed = parse_session_ex(&[root, fork_header(), usage("2026-07-29T14:00:00Z", 50)].join("\n"), "root", None);
        assert_eq!(parsed.session_id, "root");
        assert!(parsed.forked_from_id.is_none());
        assert_eq!(parsed.events[0].tokens_in, 50);
    }

    /// Independent cumulative acceptance, without a global set of seen totals.
    /// Nonzero decreases cannot distinguish a new segment from restored history
    /// from usage fields alone; report those files separately, not as certified.
    #[test]
    #[ignore = "reads local Codex rollouts; run explicitly for aggregate-only acceptance"]
    fn live_codex_tokens_match_independent_cumulative_accounting() {
        use std::io::{BufRead, BufReader};
        fn walk(dir: &std::path::Path, paths: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() { walk(&path, paths); }
                else if path.extension().is_some_and(|ext| ext == "jsonl") { paths.push(path); }
            }
        }
        let home = std::path::PathBuf::from(std::env::var("HOME").unwrap());
        let mut roots = vec![home.join(".codex/sessions"), home.join(".codex/archived_sessions")];
        if let Some(config) = std::env::var_os("CODEX_HOME").map(std::path::PathBuf::from).filter(|p| p.is_absolute()) {
            roots.extend([config.join("sessions"), config.join("archived_sessions")]);
        }
        let mut paths = Vec::new();
        for root in roots { if root.is_dir() { walk(&root, &mut paths); } }
        paths.sort();
        paths.dedup();
        let mut sums = [0i64; 5];
        let (mut verified, mut ambiguous, mut empty, mut mismatches) = (0, 0, 0, 0);
        for path in &paths {
            let mut expected = [0i64; 5];
            let mut legacy_samples = Vec::new();
            let mut native_samples = HashMap::new();
            let mut native_turns = HashSet::new();
            let mut native_first_at: Option<chrono::DateTime<chrono::Utc>> = None;
            let mut oracle_id = String::new();
            let mut turn = String::new();
            let mut previous = [0i64; 5];
            let mut uncertain = false;
            let mut fork_at = None;
            let mut own_ordinal = None;
            let mut usage_seen = false;
            let mut header_seen = false;
            let reader = BufReader::new(std::fs::File::open(path).unwrap());
            let lines = reader.lines().map(|line| {
                let line = line.unwrap();
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if !header_seen && v.get("type").and_then(Value::as_str) == Some("session_meta")
                        && v.get("payload").is_some_and(Value::is_object) {
                        header_seen = true;
                        oracle_id = v.pointer("/payload/id").or_else(|| v.pointer("/payload/session_id"))
                            .and_then(Value::as_str).unwrap_or("").to_string();
                        own_ordinal = v.pointer("/payload/subagent_history_start_ordinal").and_then(Value::as_u64)
                            .or_else(|| v.pointer("/payload/forked_from_ordinal_exclusive").and_then(Value::as_u64));
                        if v.pointer("/payload/forked_from_id").or_else(|| v.pointer("/payload/forkedFromId"))
                            .and_then(Value::as_str).is_some_and(|id| !id.is_empty()) {
                            fork_at = v.pointer("/payload/timestamp").and_then(Value::as_str).and_then(parse_ts);
                        }
                    }
                    if v.get("type").and_then(Value::as_str) == Some("turn_context") {
                        turn = v.pointer("/payload/turn_id").and_then(Value::as_str).unwrap_or("").to_string();
                    }
                    if v.get("type").and_then(Value::as_str) == Some("token_usage_record")
                        && v.pointer("/payload/thread_id").and_then(Value::as_str) == Some(oracle_id.as_str()) {
                        if let (Some(response), Some(usage), Some(at)) = (
                            v.pointer("/payload/response_id").and_then(Value::as_str).filter(|id| !id.is_empty()),
                            v.pointer("/payload/usage").filter(|u| u.is_object()),
                            v.get("timestamp").and_then(Value::as_str).and_then(parse_ts)) {
                            let fields = ["input_tokens","cached_input_tokens","cache_write_input_tokens","output_tokens","reasoning_output_tokens"]
                                .map(|k| usage.get(k).and_then(Value::as_i64).unwrap_or(0));
                            native_samples.entry(response.to_string()).or_insert(fields);
                            native_turns.insert(v.pointer("/payload/turn_id").and_then(Value::as_str).unwrap_or("").to_string());
                            native_first_at = Some(native_first_at.map_or(at, |first| first.min(at)));
                        }
                    }
                    if let Some(info) = v.pointer("/payload/info").filter(|info| info.is_object()) {
                        if let Some(total) = info.get("total_token_usage").filter(|x| x.is_object()) {
                            let keys = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"];
                            let current = keys.map(|k| total.get(k).and_then(Value::as_i64).unwrap_or(0));
                            let copied = v.get("ordinal").and_then(Value::as_u64).zip(own_ordinal)
                                .map(|(ordinal, start)| ordinal < start)
                                .unwrap_or_else(|| fork_at.zip(v.get("timestamp").and_then(Value::as_str).and_then(parse_ts))
                                    .is_some_and(|(fork, at)| at < fork));
                            // A retained file can start at a restored cumulative
                            // baseline. The absent earlier calls are not proven new
                            // work; do not certify an oracle that adds that baseline.
                            if !usage_seen && !copied {
                                if let Some(last) = info.get("last_token_usage").filter(|u| u.is_object()) {
                                    let last = keys.map(|k| last.get(k).and_then(Value::as_i64).unwrap_or(0));
                                    if current.iter().zip(last).any(|(total, last)| *total > last) { uncertain = true; }
                                }
                            }
                            usage_seen = true;
                            let zero_reset = current == [0; 5];
                            if !zero_reset && current.iter().zip(previous).any(|(a, b)| *a < b) { uncertain = true; }
                            if !copied && !zero_reset {
                                let delta = std::array::from_fn::<_, 5, _>(|i| (current[i] - previous[i]).max(0));
                                if let Some(at) = v.get("timestamp").and_then(Value::as_str).and_then(parse_ts) {
                                    legacy_samples.push((turn.clone(), at, delta));
                                }
                            }
                            previous = current;
                        } else if info.get("last_token_usage").is_some_and(|last| last.is_object()) {
                            uncertain = true;
                        }
                    }
                }
                line
            });
            let parsed = parse_lines(lines, "local-audit", None);
            if uncertain { ambiguous += 1; continue; }
            for (turn, at, fields) in legacy_samples {
                if native_turns.contains(&turn) || (turn.is_empty() && native_first_at.is_some_and(|first| at >= first)) { continue; }
                for i in 0..5 { expected[i] += fields[i]; }
            }
            for fields in native_samples.values() { for i in 0..5 { expected[i] += fields[i]; } }
            if expected == [0; 5] { empty += 1; continue; }
            let mut actual = [0i64; 5];
            for event in &parsed.events {
                for (i, n) in [event.tokens_in + event.cache_read + event.cache_write, event.cache_read, event.cache_write, event.tokens_out, event.reasoning].iter().enumerate() {
                    actual[i] += n;
                }
            }
            verified += 1;
            mismatches += usize::from(actual != expected);
            for i in 0..5 { sums[i] += actual[i]; }
        }
        eprintln!("Codex cumulative acceptance: files={}, verified_usage_files={}, ambiguous_reset_or_last_only_files={}, empty_files={}, mismatches={}, verified_inclusive_input={}, verified_cached={}, verified_cache_write={}, verified_output={}, verified_reasoning_subset={}", paths.len(), verified, ambiguous, empty, mismatches, sums[0], sums[1], sums[2], sums[3], sums[4]);
        assert!(verified > 0);
        assert_eq!(mismatches, 0, "parser differs from independent cumulative accounting");
    }

    #[test]
    fn skips_lines_without_token_info() {
        let l = line("2026-07-29T14:00:00Z", r#""type":"event_msg""#);
        assert!(parse_session(&l, "s").is_empty());
    }

    #[test]
    fn tolerates_malformed_lines() {
        let good = line(
            "2026-07-29T14:00:00Z",
            r#""info":{"last_token_usage":{"input_tokens":5}}"#,
        );
        assert_eq!(parse_session(&format!("garbage\n{good}"), "s").len(), 1);
    }

    #[test]
    fn never_emits_a_path_as_the_project_key() {
        let l = line(
            "2026-07-29T14:00:00Z",
            r#""cwd":"/Users/neel/secret/thing","info":{"last_token_usage":{"input_tokens":5}}"#,
        );
        let e = &parse_session(&l, "s")[0];
        assert_eq!(e.project_key, "thing");
        assert!(!e.project_key.contains('/'));
    }

    #[test]
    fn extracts_the_session_uuid_from_a_rollout_filename() {
        let p = std::path::Path::new(
            "/x/rollout-2026-07-29T14-00-00-0199c7f0-1111-2222-3333-444455556666.jsonl",
        );
        assert_eq!(
            session_id_from_path(p),
            "0199c7f0-1111-2222-3333-444455556666"
        );
    }
}
