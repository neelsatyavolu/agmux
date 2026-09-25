//! Claude Code log reader.
//!
//! Source: `~/.claude/projects/{encoded_cwd}/{session_id}.jsonl`. Every
//! assistant message carries `message.usage`, `message.model` and a top-level
//! `timestamp`, which is exactly the per-event richness Teams needs — and far
//! better than the per-thread cumulative row in `session_usage`.
//!
//! Only counters and short labels are read. `cwd` is reduced to a basename
//! before it leaves this module; prompt and reply text is never touched.

use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::Path;

use super::super::aggregate::{parse_ts, project_key, UsageEvent};
use crate::commands::usage_stats::{estimate_token_cost_checked, TokenCostSpec};
use super::tools::{classify, line_count, replacement_lines, ToolTally};

/// Parses one session file's lines into usage events.
///
/// `session_id` is the file stem; `fallback_dir` is the encoded project folder,
/// used only when a line carries no `cwd`.
pub fn parse_session(lines: &str, session_id: &str, fallback_dir: &str) -> Vec<UsageEvent> {
    // An in-memory UTF-8 string cannot produce a reader error.
    parse_reader(lines.as_bytes(), session_id, fallback_dir).unwrap_or_default()
}

/// Stream long transcripts without a whole-file allocation or size cutoff.
/// Read failures return no snapshot, so incomplete counters cannot be uploaded.
pub fn parse_file(path: &Path, session_id: &str, fallback_dir: &str) -> Result<Vec<UsageEvent>, String> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("Teams could not open a Claude log: {e}"))?;
    parse_reader(BufReader::new(file), session_id, fallback_dir)
}

fn parse_reader(reader: impl BufRead, session_id: &str, fallback_dir: &str) -> Result<Vec<UsageEvent>, String> {
    let mut out: Vec<UsageEvent> = Vec::new();
    let mut cwd_seen: Option<String> = None;
    // Tool *results* arrive on the user line that follows the assistant message
    // which issued the calls, so their outcomes are credited back to the last
    // emitted event. Anything seen before the first usage line is held here and
    // attached to the first event, so nothing is dropped.
    let mut pending_results = ToolTally::default();
    // Streaming assistant chunks share message.id + requestId. Last cumulative
    // usage wins (CodexBar / ccusage) instead of summing partials.
    let mut keyed: HashMap<String, usize> = HashMap::new();
    // One response's content blocks arrive as separate lines, so its tool
    // calls are merged across them; a repeated block is still one call.
    let mut seen_tool_ids: HashSet<String> = HashSet::new();

    for line in reader.lines() {
        let line = line.map_err(|e| format!("Teams could not read a Claude log: {e}"))?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };

        if let Some(cwd) = v.get("cwd").and_then(Value::as_str) {
            if !cwd.is_empty() {
                cwd_seen = Some(cwd.to_string());
            }
        }

        let results = tool_results(&v);
        if !results.is_empty() {
            match out.last_mut() {
                Some(last) => last.tools.add(&results),
                None => pending_results.add(&results),
            }
        }

        if let Some(ty) = v.get("type").and_then(Value::as_str) {
            if ty != "assistant" {
                continue;
            }
        }

        let Some(usage) = v.pointer("/message/usage").or_else(|| v.get("usage")) else {
            continue;
        };
        let Some(at) = v
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_ts)
        else {
            continue;
        };

        let model = v
            .pointer("/message/model")
            .or_else(|| v.get("model"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        // `<synthetic>` marks messages Claude Code generates itself; they carry
        // no real model and would pollute the model mix.
        if model.is_empty() || model.starts_with('<') {
            continue;
        }

        let tokens_in = num(usage, "input_tokens");
        let tokens_out = num(usage, "output_tokens");
        let cache_read = num(usage, "cache_read_input_tokens");
        let cache_write = num(usage, "cache_creation_input_tokens");
        if tokens_in + tokens_out + cache_read + cache_write == 0 {
            continue;
        }
        let cache_write_1h = crate::commands::usage_stats::claude_cache_write_1h(usage, cache_write);
        let five_m = (cache_write - cache_write_1h).max(0);

        let project = project_key(cwd_seen.as_deref().unwrap_or(fallback_dir), false);

        let mut tools = tool_uses(&v, &mut seen_tool_ids);
        if !pending_results.is_empty() {
            tools.add(&pending_results);
            pending_results = ToolTally::default();
        }

        let cost = estimate_token_cost_checked(Some(&model), TokenCostSpec {
            pure_input: tokens_in, pure_output: tokens_out, cache_read,
            cache_write: five_m, cache_write_1h,
        });
        let event = UsageEvent {
            at,
            provider: "ClaudeCode".into(),
            model: model.clone(),
            project_key: project,
            session_id: session_id.to_string(),
            tokens_in,
            tokens_out,
            cache_read,
            cache_write,
            reasoning: 0, // Claude does not report thinking tokens separately.
            cost_usd: cost.unwrap_or(0.0),
            cost_incomplete: cost.is_err(),
            // One assistant message with usage == one agent turn.
            is_turn: true,
            tool_calls: tools.calls(),
            tools,
            claude_row_key: claude_row_key(&v),
            is_sidechain: v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false),
            is_subagent_path: fallback_dir.contains("/subagents")
                || fallback_dir.contains("\\subagents"),
            subagent: false,
        };
        if let Some(key) = claude_row_key(&v) {
            if let Some(&idx) = keyed.get(&key) {
                let mut tools = out[idx].tools;
                tools.add(&event.tools);
                out[idx] = UsageEvent { tool_calls: tools.calls(), tools, ..event };
                continue;
            }
            keyed.insert(key, out.len());
        }
        out.push(event);
    }

    // Results trailing the last usage line still belong to the session.
    if !pending_results.is_empty() {
        if let Some(last) = out.last_mut() {
            last.tools.add(&pending_results);
        }
    }

    // A file's `cwd` often appears only after the first usage line; backfill so
    // early events aren't stranded without a project.
    if let Some(cwd) = cwd_seen {
        let key = project_key(&cwd, false);
        for e in &mut out {
            if e.project_key.is_empty() {
                e.project_key = key.clone();
            }
        }
    }
    Ok(out)
}

fn num(usage: &Value, key: &str) -> i64 {
    usage.get(key).and_then(Value::as_i64).unwrap_or(0).max(0)
}

fn claude_row_key(v: &Value) -> Option<String> {
    let id = v
        .pointer("/message/id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?;
    let req = v
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?;
    Some(format!("{id}:{req}"))
}

/// Drop duplicate Claude requests that appear in both a parent transcript and
/// a fork or `/subagents/` (or sidechain) file. Keep the most complete usage
/// snapshot, then prefer the non-sidechain parent copy. Break remaining ties
/// deterministically because the file cache has no stable iteration order.
pub fn reconcile_events(events: &mut Vec<UsageEvent>) {
    let mut best: HashMap<String, usize> = HashMap::new();
    let mut drop: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for (i, e) in events.iter().enumerate() {
        let Some(key) = e.claude_row_key.as_ref() else {
            continue;
        };
        if let Some(&j) = best.get(key) {
            let cand = &events[i];
            let exist = &events[j];
            let total = |e: &UsageEvent| e.tokens_in as i128 + e.tokens_out as i128
                + e.cache_read as i128 + e.cache_write as i128;
            let wins = if total(cand) != total(exist) {
                total(cand) > total(exist)
            } else if cand.is_sidechain != exist.is_sidechain {
                exist.is_sidechain
            } else if cand.is_subagent_path != exist.is_subagent_path {
                exist.is_subagent_path
            } else {
                (cand.at, &cand.session_id) < (exist.at, &exist.session_id)
            };
            if wins {
                drop.insert(j);
                best.insert(key.clone(), i);
            } else {
                drop.insert(i);
            }
        } else {
            best.insert(key.clone(), i);
        }
    }
    if drop.is_empty() {
        return;
    }
    let mut idx = 0;
    events.retain(|_| {
        let keep = !drop.contains(&idx);
        idx += 1;
        keep
    });
}

/// Classifies the `tool_use` blocks in an assistant message, and measures the
/// size of any edit it requested.
///
/// Only the tool *name* and the *length* of the edit strings are read. The
/// strings themselves, and the file paths beside them, never leave this
/// function.
fn tool_uses(v: &Value, seen_ids: &mut HashSet<String>) -> ToolTally {
    let mut t = ToolTally::default();
    let Some(blocks) = v.pointer("/message/content").and_then(Value::as_array) else {
        return t;
    };
    for b in blocks {
        if b.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        if let Some(id) = b.get("id").and_then(Value::as_str) {
            if !seen_ids.insert(id.to_string()) {
                continue;
            }
        }
        let name = b.get("name").and_then(Value::as_str).unwrap_or("");
        t.count(classify(name));

        let input = b.get("input");
        match name {
            "Edit" => {
                let (add, del) = replacement_lines(str_at(input, "old_string"), str_at(input, "new_string"));
                t.lines_added += add;
                t.lines_removed += del;
                t.files_changed += 1;
            }
            // A Write replaces the file wholesale and the log does not say what
            // was there before, so it can only be counted as added lines.
            "Write" => {
                t.lines_added += line_count(str_at(input, "content"));
                t.files_changed += 1;
            }
            "MultiEdit" => {
                let edits = input
                    .and_then(|i| i.get("edits"))
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                for e in edits {
                    let (add, del) =
                        replacement_lines(str_at(Some(e), "old_string"), str_at(Some(e), "new_string"));
                    t.lines_added += add;
                    t.lines_removed += del;
                }
                // One file per MultiEdit call, however many hunks it carries.
                t.files_changed += 1;
            }
            _ => {}
        }
    }
    t
}

/// Reads the outcome of `tool_result` blocks on a user line.
///
/// Claude flags every result with `is_error`, so every result is measurable —
/// which is what makes the error rate meaningful for this provider.
fn tool_results(v: &Value) -> ToolTally {
    let mut t = ToolTally::default();
    let Some(blocks) = v.pointer("/message/content").and_then(Value::as_array) else {
        return t;
    };
    for b in blocks {
        if b.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        t.measured += 1;
        if b.get("is_error").and_then(Value::as_bool) == Some(true) {
            t.errors += 1;
        }
    }
    t
}

fn str_at<'a>(v: Option<&'a Value>, key: &str) -> &'a str {
    v.and_then(|v| v.get(key)).and_then(Value::as_str).unwrap_or("")
}

/// The session id is the file stem, which is the provider's own session UUID.
pub fn session_id_from_path(path: &std::path::Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_reader_matches_string_parser_and_reads_past_64mb() {
        use std::io::Write;
        let mut file = tempfile::NamedTempFile::new().unwrap();
        let first = usage_line(2, "2026-07-29T14:05:00Z");
        let last = usage_line(50, "2026-07-29T15:05:00Z");
        writeln!(file, "{first}").unwrap();
        // Large valid non-usage rows exercise streaming without a giant buffer.
        let filler = format!("{{\"type\":\"progress\",\"padding\":\"{}\"}}\n", "x".repeat(64 * 1024));
        for _ in 0..1024 { file.write_all(filler.as_bytes()).unwrap(); }
        write!(file, "not json\n{last}").unwrap();
        assert!(file.as_file().metadata().unwrap().len() > 64 * 1024 * 1024);
        let events = parse_file(file.path(), "s", "/proj").unwrap();
        let expected = parse_session(&format!("{first}\nnot json\n{last}"), "s", "/proj");
        assert_eq!(format!("{events:?}"), format!("{expected:?}"));
    }

    #[test]
    fn file_reader_reports_open_and_utf8_errors() {
        let dir = tempfile::tempdir().unwrap();
        assert!(parse_file(&dir.path().join("absent"), "s", "").is_err());
        let path = dir.path().join("invalid.jsonl");
        let mut contents = usage_line(50, "2026-07-29T14:05:00Z").into_bytes();
        contents.extend_from_slice(b"\n\xff\n");
        std::fs::write(&path, contents).unwrap();
        // A read failure must not return a plausible partial snapshot.
        assert!(parse_file(&path, "s", "").is_err());
    }

    fn usage_line(output: i64, timestamp: &str) -> String {
        serde_json::json!({"type":"assistant", "timestamp":timestamp, "requestId":"req-1",
            "message":{"id":"msg-1", "model":"claude-sonnet-4-6",
                "usage":{"input_tokens":100,"output_tokens":output}}}).to_string()
    }

    #[test]
    fn fork_copies_keep_complete_usage_independent_of_scan_order() {
        let partial = usage_line(2, "2026-07-29T14:05:00Z");
        let complete = usage_line(50, "2026-07-29T14:05:01Z");
        for reverse in [false, true] {
            let mut events = parse_session(&partial, "parent", "/proj");
            events.extend(parse_session(&complete, "fork", "/proj"));
            if reverse { events.reverse(); }
            reconcile_events(&mut events);
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].tokens_out, 50);
            assert_eq!(events[0].at, parse_ts("2026-07-29T14:05:01Z").unwrap());
        }
    }

    #[test]
    fn equal_fork_copies_have_stable_attribution() {
        let line = usage_line(50, "2026-07-29T14:05:00Z");
        for reverse in [false, true] {
            let mut events = parse_session(&line, "a", "/proj");
            events.extend(parse_session(&line, "b", "/proj"));
            if reverse { events.reverse(); }
            reconcile_events(&mut events);
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].session_id, "a");
        }
    }

    #[test]
    fn zero_tail_does_not_erase_reported_usage() {
        let line = usage_line(50, "2026-07-29T14:59:59Z");
        let mut zero: Value = serde_json::from_str(&line).unwrap();
        zero["message"]["usage"] = serde_json::json!({"input_tokens":0,"output_tokens":0});
        zero["timestamp"] = Value::String("2026-07-29T15:00:00Z".into());
        let events = parse_session(&format!("{line}\n{zero}"), "s", "");
        assert_eq!(events.len(), 1);
        assert_eq!((events[0].tokens_in, events[0].tokens_out), (100, 50));
        assert_eq!(events[0].at, parse_ts("2026-07-29T14:59:59Z").unwrap());
    }

    #[test]
    fn stream_completion_uses_its_own_hour_and_request_identity() {
        let first = usage_line(2, "2026-07-29T14:59:59Z");
        let last = usage_line(50, "2026-07-29T15:00:01Z");
        let events = parse_session(&format!("{first}\n{last}"), "s", "");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].at, parse_ts("2026-07-29T15:00:01Z").unwrap());
        let distinct = last.replace("req-1", "req-2");
        assert_eq!(parse_session(&format!("{last}\n{distinct}"), "s", "").len(), 2);
    }

    #[test]
    fn unknown_price_preserves_claude_tokens_and_marks_cost_incomplete() {
        let known = usage_line(50, "2026-07-29T14:05:00Z");
        let events = parse_session(&known, "s", "");
        assert!(!events[0].cost_incomplete);
        assert!(events[0].cost_usd > 0.0);
        let unknown = known.replace("claude-sonnet-4-6", "unknown-audit-model");
        let events = parse_session(&unknown, "s", "");
        assert_eq!(events[0].tokens_in + events[0].tokens_out, 150);
        assert!(events[0].cost_incomplete);
        assert_eq!(events[0].cost_usd, 0.0);
    }

    #[test]
    fn accounting_audit_prices_requests_not_the_session_sum() {
        let row = |request: &str, output: i64| serde_json::json!({
            "type":"assistant", "timestamp":"2026-07-29T14:05:00Z", "requestId":request,
            "message":{"id":request,"model":"claude-sonnet-4-5","usage":{
                "input_tokens":10000,"cache_read_input_tokens":140000,
                "cache_creation_input_tokens":10000,"output_tokens":output,
                "cache_creation":{"ephemeral_5m_input_tokens":5000,"ephemeral_1h_input_tokens":5000}
            }}
        }).to_string();
        let rows = [row("a", 1), row("a", 100), row("b", 100)].join("\n");
        let events = parse_session(&rows, "s", "");
        assert_eq!(events.len(), 2);
        // Each prompt is 160k; their 320k session sum must not trigger the
        // long-context tier. The partial stream is not a separate bill.
        let per_request = (10000.0 * 3.0 + 140000.0 * 0.3
            + 5000.0 * 3.75 + 5000.0 * 6.0 + 100.0 * 15.0) / 1e6;
        assert!((events.iter().map(|e| e.cost_usd).sum::<f64>() - 2.0 * per_request).abs() < 1e-9);
    }

    #[test]
    fn mixed_cache_lifetimes_do_not_double_count_tokens() {
        let line = serde_json::json!({"timestamp":"2026-07-29T14:05:00Z",
            "message":{"model":"claude-sonnet-4-6", "usage":{
                "input_tokens":1000000,"output_tokens":1000000,
                "cache_read_input_tokens":1000000,"cache_creation_input_tokens":2000000,
                "cache_creation":{"ephemeral_5m_input_tokens":1000000,"ephemeral_1h_input_tokens":1000000}
            }}}).to_string();
        let event = &parse_session(&line, "s", "")[0];
        assert_eq!(event.cache_write, 2000000);
        assert!((event.cost_usd - (3.0 + 15.0 + 0.3 + 3.75 + 6.0)).abs() < 1e-9);
    }

    /// Local-only acceptance: the manifest contains paths and independent token
    /// sums, never transcript content. Nothing from it is uploaded or printed.
    #[test]
    #[ignore = "requires CLAUDE_TEAMS_AUDIT_MANIFEST with independent local sums"]
    fn retained_owned_logs_match_independent_sums() {
        let manifest = std::env::var("CLAUDE_TEAMS_AUDIT_MANIFEST").unwrap();
        let manifest: Value = serde_json::from_str(&std::fs::read_to_string(manifest).unwrap()).unwrap();
        assert_eq!(manifest["version"], 1);
        let rows = manifest["files"].as_array().unwrap();
        let since = parse_ts(manifest["since"].as_str().unwrap()).unwrap();
        let until = parse_ts(manifest["until"].as_str().unwrap()).unwrap();
        let counters = |events: &[UsageEvent]| {
            let mut fields = [0i64; 4];
            let mut hours: std::collections::BTreeMap<String, [i64; 4]> = Default::default();
            for event in events {
                let hour = hours.entry(super::super::super::aggregate::hour_key(event.at)).or_default();
                for (i, value) in [event.tokens_in, event.tokens_out, event.cache_read, event.cache_write].into_iter().enumerate() {
                    fields[i] += value;
                    hour[i] += value;
                }
            }
            serde_json::json!({"expected": fields.iter().sum::<i64>(), "fields": fields, "hours": hours})
        };
        let mut all = Vec::new();
        for row in rows {
            let path = std::path::Path::new(row["path"].as_str().unwrap());
            let mut events = parse_file(path, row["session"].as_str().unwrap(), &path.parent().unwrap().to_string_lossy()).unwrap();
            events.retain(|e| e.at >= since && e.at <= until);
            let actual = counters(&events);
            for key in ["expected", "fields", "hours"] {
                assert_eq!(actual[key], row[key], "local file aggregate mismatch: {key}");
            }
            all.extend(events);
        }
        reconcile_events(&mut all);
        let actual = counters(&all);
        assert_eq!(actual, manifest["global"], "global reconciled aggregate mismatch");
        eprintln!("Claude local audit: {} files, {} events, {} tokens", rows.len(), all.len(), actual["expected"]);
    }

    const LINE: &str = r#"{"timestamp":"2026-07-29T14:05:00Z","cwd":"/Users/neel/code/helios-api","message":{"model":"claude-opus-5","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":900,"cache_creation_input_tokens":20},"content":[{"type":"text"},{"type":"tool_use"},{"type":"tool_use"}]}}"#;

    #[test]
    fn parses_a_real_assistant_message() {
        let e = &parse_session(LINE, "sess-1", "/fallback/dir")[0];
        assert_eq!(e.provider, "ClaudeCode");
        assert_eq!(e.model, "claude-opus-5");
        assert_eq!(e.project_key, "helios-api");
        assert_eq!(e.session_id, "sess-1");
        assert_eq!((e.tokens_in, e.tokens_out, e.cache_read, e.cache_write), (100, 50, 900, 20));
        assert_eq!(e.tool_calls, 2);
        assert!(e.is_turn);
        assert!(e.cost_usd > 0.0, "opus usage should cost something");
    }

    #[test]
    fn uses_the_events_own_timestamp_not_scan_time() {
        let e = &parse_session(LINE, "s", "")[0];
        assert_eq!(super::super::super::aggregate::hour_key(e.at), "2026-07-29T14");
    }

    #[test]
    fn skips_lines_without_usage() {
        let lines = format!(
            "{}\n{}",
            r#"{"timestamp":"2026-07-29T14:00:00Z","type":"user","message":{"role":"user"}}"#,
            LINE
        );
        assert_eq!(parse_session(&lines, "s", "").len(), 1);
    }

    #[test]
    fn skips_synthetic_and_blank_models() {
        let synthetic = r#"{"timestamp":"2026-07-29T14:00:00Z","message":{"model":"<synthetic>","usage":{"input_tokens":10}}}"#;
        let blank = r#"{"timestamp":"2026-07-29T14:00:00Z","message":{"usage":{"input_tokens":10}}}"#;
        assert!(parse_session(synthetic, "s", "").is_empty());
        assert!(parse_session(blank, "s", "").is_empty());
    }

    #[test]
    fn skips_zero_token_usage_blocks() {
        let zero = r#"{"timestamp":"2026-07-29T14:00:00Z","message":{"model":"claude-opus-5","usage":{"input_tokens":0,"output_tokens":0}}}"#;
        assert!(parse_session(zero, "s", "").is_empty());
    }

    #[test]
    fn tolerates_malformed_lines() {
        let lines = format!("not json\n\n{}\n{{\"broken\":", LINE);
        assert_eq!(parse_session(&lines, "s", "").len(), 1);
    }

    #[test]
    fn falls_back_to_the_directory_when_a_line_has_no_cwd() {
        let no_cwd = r#"{"timestamp":"2026-07-29T14:00:00Z","message":{"model":"claude-opus-5","usage":{"input_tokens":10}}}"#;
        let e = &parse_session(no_cwd, "s", "/Users/neel/code/other-repo")[0];
        assert_eq!(e.project_key, "other-repo");
    }

    #[test]
    fn never_emits_a_path_as_the_project_key() {
        let e = &parse_session(LINE, "s", "")[0];
        assert!(!e.project_key.contains('/'));
        assert!(!e.project_key.contains("Users"));
    }

    const WITH_TOOLS: &str = r#"{"timestamp":"2026-07-29T14:05:00Z","cwd":"/w/repo","message":{"model":"claude-opus-5","usage":{"input_tokens":100},"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}},{"type":"tool_use","name":"Edit","input":{"file_path":"/w/repo/a.rs","old_string":"one\ntwo","new_string":"one\ntwo\nthree"}},{"type":"tool_use","name":"mcp__memory__add","input":{}}]}}"#;

    #[test]
    fn classifies_tool_calls_by_kind() {
        let e = &parse_session(WITH_TOOLS, "s", "")[0];
        assert_eq!(e.tools.bash, 1);
        assert_eq!(e.tools.edit, 1);
        assert_eq!(e.tools.mcp, 1);
        assert_eq!(e.tool_calls, 3, "tool_calls stays the sum of the kinds");
    }

    #[test]
    fn measures_edit_size_without_keeping_the_text() {
        let e = &parse_session(WITH_TOOLS, "s", "")[0];
        assert_eq!(e.tools.lines_added, 3);
        assert_eq!(e.tools.lines_removed, 2);
        assert_eq!(e.tools.files_changed, 1);
    }

    #[test]
    fn a_write_counts_only_added_lines() {
        let write = r#"{"timestamp":"2026-07-29T14:05:00Z","message":{"model":"claude-opus-5","usage":{"input_tokens":10},"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/w/x.rs","content":"a\nb\nc"}}]}}"#;
        let e = &parse_session(write, "s", "")[0];
        assert_eq!((e.tools.lines_added, e.tools.lines_removed), (3, 0));
        assert_eq!(e.tools.files_changed, 1);
    }

    #[test]
    fn tool_errors_attach_to_the_turn_that_issued_them() {
        let lines = format!(
            "{}\n{}",
            WITH_TOOLS,
            r#"{"timestamp":"2026-07-29T14:05:30Z","type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"boom"},{"type":"tool_result","content":"fine"}]}}"#
        );
        let events = parse_session(&lines, "s", "");
        assert_eq!(events.len(), 1, "a tool_result line carries no usage of its own");
        assert_eq!(events[0].tools.errors, 1);
        assert_eq!(events[0].tools.measured, 2, "both results were observable");
    }

    #[test]
    fn results_before_the_first_usage_line_are_not_dropped() {
        let lines = format!(
            "{}\n{}",
            r#"{"timestamp":"2026-07-29T14:04:00Z","type":"user","message":{"content":[{"type":"tool_result","is_error":true}]}}"#,
            WITH_TOOLS
        );
        let events = parse_session(&lines, "s", "");
        assert_eq!(events[0].tools.errors, 1);
        assert_eq!(events[0].tools.measured, 1);
    }

    #[test]
    fn counts_one_turn_per_usage_message() {
        let two = format!("{}\n{}", LINE, LINE.replace("14:05:00", "14:06:00"));
        let events = parse_session(&two, "s", "");
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|e| e.is_turn));
    }

    #[test]
    fn streaming_chunks_keep_the_last_cumulative_usage() {
        let first = r#"{"type":"assistant","timestamp":"2026-07-29T14:05:00Z","requestId":"req-1","message":{"id":"msg-1","model":"claude-opus-5","usage":{"input_tokens":10,"output_tokens":2}}}"#;
        let last = r#"{"type":"assistant","timestamp":"2026-07-29T14:05:01Z","requestId":"req-1","message":{"id":"msg-1","model":"claude-opus-5","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":20}}}"#;
        let events = parse_session(&format!("{first}\n{last}"), "s", "");
        assert_eq!(events.len(), 1);
        assert_eq!(
            (events[0].tokens_in, events[0].tokens_out, events[0].cache_read),
            (100, 50, 20)
        );
    }

    #[test]
    fn parallel_tool_calls_split_across_lines_all_count() {
        // Claude Code writes each content block of one response as its own
        // line (same message.id + requestId), and results can land between.
        let block = |ts: &str, content: &str| format!(
            r#"{{"type":"assistant","timestamp":"{ts}","requestId":"req-1","message":{{"id":"msg-1","model":"claude-opus-5","usage":{{"input_tokens":10,"output_tokens":5}},"content":[{content}]}}}}"#
        );
        let lines = [
            block("2026-07-29T14:05:00Z", r#"{"type":"text","text":"hi"}"#),
            block("2026-07-29T14:05:01Z", r#"{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}"#),
            r#"{"type":"user","timestamp":"2026-07-29T14:05:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","is_error":true}]}}"#.to_string(),
            block("2026-07-29T14:05:03Z", r#"{"type":"tool_use","id":"toolu_2","name":"Edit","input":{"old_string":"a","new_string":"a\nb"}}"#),
            r#"{"type":"user","timestamp":"2026-07-29T14:05:04Z","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_2"}]}}"#.to_string(),
        ].join("\n");
        let events = parse_session(&lines, "s", "");
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!((e.tool_calls, e.tools.bash, e.tools.edit), (2, 1, 1));
        assert_eq!((e.tools.measured, e.tools.errors), (2, 1));
        assert_eq!((e.tools.files_changed, e.tools.lines_added, e.tools.lines_removed), (1, 2, 1));
        assert_eq!((e.tokens_in, e.tokens_out), (10, 5));
        // A repeated copy of a block is still one call.
        let repeated = format!("{lines}\n{}", block("2026-07-29T14:05:05Z", r#"{"type":"tool_use","id":"toolu_2","name":"Edit","input":{"old_string":"a","new_string":"a\nb"}}"#));
        assert_eq!(parse_session(&repeated, "s", "")[0].tool_calls, 2);
    }

    #[test]
    fn skips_non_assistant_usage_when_type_is_present() {
        let user = r#"{"type":"user","timestamp":"2026-07-29T14:05:00Z","message":{"model":"claude-opus-5","usage":{"input_tokens":999}}}"#;
        assert!(parse_session(user, "s", "").is_empty());
    }

    #[test]
    fn one_hour_cache_costs_twice_input_not_write() {
        let line = r#"{"timestamp":"2026-07-29T14:05:00Z","message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":1000000,"cache_creation":{"ephemeral_1h_input_tokens":1000000}}}}"#;
        let e = &parse_session(line, "s", "")[0];
        assert!((e.cost_usd - 6.0).abs() < 1e-9, "got {}", e.cost_usd);
    }

    #[test]
    fn parent_wins_over_subagent_duplicate() {
        let line = r#"{"type":"assistant","timestamp":"2026-07-29T14:05:00Z","requestId":"req-1","message":{"id":"msg-1","model":"claude-opus-5","usage":{"input_tokens":100,"output_tokens":10}}}"#;
        let mut events = parse_session(line, "parent", "/proj");
        events.extend(parse_session(line, "child", "/proj/subagents"));
        assert_eq!(events.len(), 2);
        reconcile_events(&mut events);
        assert_eq!(events.len(), 1);
        assert!(!events[0].is_subagent_path);
        assert_eq!(events[0].tokens_in, 100);
    }
}
