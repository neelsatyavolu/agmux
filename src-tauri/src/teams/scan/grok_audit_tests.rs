use super::*;
use serde_json::json;

fn completion(prompt: &str, event: &str, input: i64, cache: i64, output: i64, ticks: i64) -> Value {
    json!({"timestamp":1785283200,"params":{"_meta":{"eventId":event},"update":{
        "sessionUpdate":"turn_completed","prompt_id":prompt,"usage":{
            "inputTokens":input,"cachedReadTokens":cache,"outputTokens":output,
            "totalTokens":input+output,"numTurns":1,"costUsdTicks":ticks
        }
    }}})
}
fn parse(rows: &[Value]) -> Vec<UsageEvent> {
    parse_session(&rows.iter().map(Value::to_string).collect::<Vec<_>>().join("\n"), "s", "", "grok-4.5")
}
#[test]
fn distinct_prompts_are_independent_even_when_counters_increase() {
    let e = parse(&[completion("a","1",100,80,10,100),completion("b","2",200,160,20,200)]);
    assert_eq!(e.iter().map(|e| e.tokens_in+e.cache_read+e.tokens_out).sum::<i64>(),330);
    assert!((e.iter().map(|e| e.cost_usd).sum::<f64>()-300.0/1e10).abs()<1e-15);
}
#[test]
fn replayed_events_do_not_reset_or_rebill() {
    let a=completion("a","1",100,80,10,100);
    let b=completion("b","2",200,160,20,200);
    assert_eq!(parse(&[a.clone(),b,a]).iter().map(|e|e.tokens_in+e.cache_read+e.tokens_out).sum::<i64>(),330);
}
#[test]
fn cost_only_ticks_and_explicit_zero_cost_survive() {
    let e=parse(&[completion("a","1",0,0,0,100),completion("b","2",100,0,10,0)]);
    assert_eq!(e.len(),2);
    assert_eq!(e[0].cost_usd,100.0/1e10);
    assert_eq!(e[1].cost_usd,0.0);
}
#[test]
fn per_model_usage_and_reasoning_are_preserved_without_double_counting() {
    let mut row=completion("a","1",300,240,30,300);
    row["params"]["update"]["usage"]["modelUsage"]=json!({
        "grok-4.5":{"inputTokens":100,"cachedReadTokens":80,"outputTokens":10,"reasoningTokens":7,"costUsdTicks":100},
        "grok-4.6":{"inputTokens":200,"cachedReadTokens":160,"outputTokens":20,"reasoningTokens":15,"costUsdTicks":200}
    });
    let e=parse(&[row]);
    assert_eq!(e.len(),2);
    assert!(e.iter().all(|e| !e.cost_incomplete && e.cost_usd.is_finite()));
    assert_eq!(e.iter().map(|e|e.tokens_in+e.cache_read+e.tokens_out).sum::<i64>(),330);
    assert_eq!(e.iter().map(|e|e.reasoning).sum::<i64>(),22);
    assert_eq!(e.iter().filter(|e|e.is_turn).count(),1);
}
#[test]
fn context_is_activity_not_billable_tokens() {
    let e=parse(&[json!({"timestamp":1785283200,"params":{"_meta":{"totalTokens":1000000,"promptId":"a"}}})]);
    assert_eq!(e.len(),1);
    assert_eq!((e[0].tokens_in,e[0].cache_read,e[0].tokens_out,e[0].cost_usd),(0,0,0,0.0));
}

#[test]
fn repeated_snapshots_within_one_prompt_only_emit_growth() {
    let e=parse(&[completion("a","1",100,80,10,100),completion("a","2",200,160,20,200)]);
    assert_eq!(e.iter().map(|e|e.tokens_in+e.cache_read+e.tokens_out).sum::<i64>(),220);
    assert_eq!(e.iter().filter(|e|e.is_turn).count(),1);
}

#[test]
fn tool_only_lines_keep_activity_and_replays_are_deduplicated() {
    let row=json!({"timestamp":1785283200,"params":{"_meta":{"eventId":"e"},
        "update":{"sessionUpdate":"tool_call","title":"read_file","toolCallId":"t"}}});
    let e=parse(&[row.clone(),row]);
    assert_eq!(e.iter().map(|e|e.tool_calls).sum::<i64>(),1);
}

#[test]
fn resumed_session_event_ids_restart_without_dropping_new_work() {
    // A resumed Grok process numbers events from 1 again; observed locally
    // when a later turn_completed reused an earlier hook_execution's ID.
    let usage=|prompt:&str,input:i64|json!({"timestamp":1785283300,"params":{"_meta":{"eventId":"s-7"},
        "update":{"sessionUpdate":"turn_completed","prompt_id":prompt,
            "usage":{"inputTokens":input,"outputTokens":10,"totalTokens":input+10,"costUsdTicks":1000}}}});
    let first=json!({"timestamp":1785283200,"params":{"_meta":{"eventId":"s-7"},
        "update":{"sessionUpdate":"hook_execution"}}});
    let e=parse(&[first,usage("p1",100),usage("p1",100),usage("p2",50)]);
    assert_eq!(e.iter().map(|e|e.tokens_in).sum::<i64>(),150,"identical replays still count once");
}

#[test]
fn live_grok_native_usage_matches_independent_prompt_sums() {
    let Some(home)=dirs::home_dir() else { return };
    let root=home.join(".grok/sessions");
    if !root.exists() { return; }
    let mut files=0;
    let mut billable_files=0;
    let mut rows=0;
    let mut expected=[0i64;7];
    let mut actual=[0i64;7];
    for project in std::fs::read_dir(root).unwrap().flatten() {
        let Ok(sessions)=std::fs::read_dir(project.path()) else { continue };
        for session in sessions.flatten() {
            let Ok(text)=std::fs::read_to_string(session.path().join("updates.jsonl")) else { continue };
            files+=1;
            let mut want=[0i64;7];
            let mut prompts=HashSet::new();
            let mut has_usage=false;
            for line in text.lines() {
                let Ok(v)=serde_json::from_str::<Value>(line) else { continue };
                let Some(u)=v.pointer("/params/update/usage") else { continue };
                let Some(pid)=v.pointer("/params/update/prompt_id").and_then(Value::as_str) else { continue };
                // Independent oracle: local native completions have one final
                // usage record per prompt. Fail if this assumption changes.
                assert!(prompts.insert(pid.to_string()), "native prompt repeated; audit oracle needs revision");
                let n=|k:&str|u.get(k).and_then(Value::as_i64).unwrap_or(0);
                assert_eq!(n("inputTokens")+n("outputTokens"),n("totalTokens"));
                let values=[n("inputTokens")-n("cachedReadTokens")-n("cacheCreationTokens"),n("cachedReadTokens"),n("cacheCreationTokens"),
                    n("outputTokens"),n("totalTokens"),n("reasoningTokens"),n("costUsdTicks")];
                for i in 0..7 { want[i]+=values[i]; }
                rows+=1;
                has_usage=true;
            }
            if !has_usage { continue; }
            billable_files+=1;
            let events=parse_session(&text,"audit","","grok");
            let mut got=[0i64;7];
            for e in events {
                let values=[e.tokens_in,e.cache_read,e.cache_write,e.tokens_out,e.tokens_in+e.cache_read+e.cache_write+e.tokens_out,
                    e.reasoning,(e.cost_usd*1e10).round() as i64];
                for i in 0..7 { got[i]+=values[i]; }
            }
            assert_eq!(got,want,"native file arithmetic mismatch (file ordinal {files})");
            for i in 0..7 { expected[i]+=want[i]; actual[i]+=got[i]; }
        }
    }
    eprintln!("Grok native audit: files={files}, billable_files={billable_files}, completions={rows}; [pure input, cache read, cache write, output, total, reasoning subset, cost ticks] expected={expected:?} actual={actual:?}");
}

#[test]
fn streaming_file_matches_snapshot_and_rejects_partial_reads() {
    let dir=tempfile::tempdir().unwrap();
    let path=dir.path().join("updates.jsonl");
    let lines=[completion("a","1",100,80,10,100),completion("b","2",200,160,20,200)]
        .iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
    std::fs::write(&path,&lines).unwrap();
    let file=parse_file(&path,"s","","grok-4.5").unwrap();
    let text=parse_session(&lines,"s","","grok-4.5");
    assert_eq!(file.len(),text.len());
    for (a,b) in file.iter().zip(&text) {
        assert_eq!((a.tokens_in,a.cache_read,a.tokens_out,a.cost_usd),
            (b.tokens_in,b.cache_read,b.tokens_out,b.cost_usd));
    }
    let mut bytes=lines.into_bytes();
    bytes.extend_from_slice(b"\n\xff");
    std::fs::write(&path,bytes).unwrap();
    assert!(parse_file(&path,"s","","grok").is_err());
}

#[test]
fn known_prompt_rollback_with_new_event_ids_keeps_watermarks() {
    let e = parse(&[
        completion("a", "1", 100, 80, 10, 100),
        completion("a", "2", 200, 160, 20, 200),
        completion("a", "3", 100, 80, 10, 100),
        completion("a", "4", 200, 160, 20, 200),
    ]);
    assert_eq!(e.iter().map(|e| e.tokens_in + e.cache_read + e.tokens_out).sum::<i64>(), 220);
    assert!((e.iter().map(|e| e.cost_usd).sum::<f64>() - 200.0 / 1e10).abs() < 1e-15);
}

#[test]
fn interleaved_prompt_snapshots_keep_independent_watermarks() {
    let e = parse(&[
        completion("a", "1", 100, 80, 10, 100),
        completion("b", "2", 300, 240, 30, 300),
        completion("a", "3", 200, 160, 20, 200),
        completion("b", "4", 400, 320, 40, 400),
        completion("a", "5", 150, 120, 15, 150),
        completion("b", "6", 350, 280, 35, 350),
    ]);
    assert_eq!(e.iter().map(|e| e.tokens_in + e.cache_read + e.tokens_out).sum::<i64>(), 660);
    assert_eq!(e.iter().filter(|e| e.is_turn).count(), 2);
    assert!((e.iter().map(|e| e.cost_usd).sum::<f64>() - 600.0 / 1e10).abs() < 1e-15);
}

#[test]
fn cache_creation_is_a_separate_input_bucket_without_inflating_total() {
    let mut a = completion("a", "1", 100, 40, 10, 100);
    a["params"]["update"]["usage"]["cacheCreationTokens"] = json!(30);
    let mut b = completion("a", "2", 200, 80, 20, 200);
    b["params"]["update"]["usage"]["cacheCreationTokens"] = json!(60);
    let e = parse(&[a, b]);
    assert_eq!(e.iter().map(|e| e.cache_write).sum::<i64>(), 60);
    assert_eq!(e.iter().map(|e| e.tokens_in).sum::<i64>(), 60);
    assert_eq!(e.iter().map(|e| e.tokens_in + e.cache_read + e.cache_write + e.tokens_out).sum::<i64>(), 220);
}

#[test]
fn incomplete_parent_keeps_reported_tokens_without_inventing_child_cost() {
    let mut row = completion("a", "1", 300, 240, 30, 0);
    let u = row["params"]["update"]["usage"].as_object_mut().unwrap();
    u.remove("costUsdTicks");
    u.insert("usageIsIncomplete".into(), json!(true));
    u.insert("modelUsage".into(), json!({
        "parent-model": {"inputTokens":100,"cachedReadTokens":80,"outputTokens":10},
        "child-model": {"inputTokens":200,"cachedReadTokens":160,"outputTokens":20}
    }));
    let e = parse(&[row]);
    assert_eq!(e.iter().map(|e| e.tokens_in + e.cache_read + e.tokens_out).sum::<i64>(), 330);
    assert_eq!(e.iter().map(|e| e.cost_usd).sum::<f64>(), 0.0);
    assert_eq!(e.iter().filter(|e| e.is_turn).count(), 1);
}

/// The Python oracle reads native root/model reports independently, freezes
/// numeric-only rows, and refuses unsupported cumulative shapes. This test
/// verifies each prompt/model and the combined session's hourly buckets.
#[test]
#[ignore = "requires read-only native manifest from scripts/audit-teams-grok-accounting.py"]
fn independent_manifest_matches_native_buckets() {
    let path = std::env::var("AGMUX_GROK_AUDIT_MANIFEST").expect("set manifest path");
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let values = |e: &UsageEvent| [e.tokens_in, e.cache_read, e.cache_write, e.tokens_out,
        e.reasoning, (e.cost_usd * 1e10).round() as i64];
    let mut prompts = 0;
    let mut buckets = 0;
    let mut total = [0i64; 6];
    for session in manifest["sessions"].as_array().unwrap() {
        let rows = session["rows"].as_array().unwrap();
        let expected = session["expected"].as_array().unwrap();
        let mut want: HashMap<(String, i64), [i64; 6]> = HashMap::new();
        for (ordinal, row) in rows.iter().enumerate() {
            let mut per_model = HashMap::new();
            for e in parse(&[row.clone()]) {
                let u = &row["params"]["update"]["usage"];
                let part = &u["modelUsage"][&e.model];
                let missing = u.get("costUsdTicks").is_none() || part.get("costUsdTicks").is_none()
                    || u["usageIsIncomplete"] == true;
                assert_eq!(e.cost_incomplete, missing, "native cost completeness mismatch");
                assert!(e.cost_usd.is_finite());
                per_model.insert(e.model.clone(), values(&e));
            }
            for part in expected.iter().filter(|p| p["prompt"] == ordinal.to_string()) {
                let model = part["model"].as_str().unwrap();
                let nums: [i64; 6] = serde_json::from_value(part["values"].clone()).unwrap();
                // Native zero reports produce no UsageEvent, which is correct.
                assert_eq!(per_model.remove(model).unwrap_or([0; 6]), nums,
                    "prompt/model mismatch in {} ordinal {ordinal} model {model}", session["label"]);
                let key = (model.to_string(), part["hour"].as_i64().unwrap());
                let counter = want.entry(key).or_default();
                for i in 0..6 { counter[i] += nums[i]; }
            }
            assert!(per_model.is_empty(), "unexpected model attribution");
            prompts += 1;
        }
        let mut got: HashMap<(String, i64), [i64; 6]> = HashMap::new();
        for e in parse(rows) {
            let nums = values(&e);
            let counter = got.entry((e.model.clone(), e.at.timestamp() / 3600)).or_default();
            for i in 0..6 { counter[i] += nums[i]; total[i] += nums[i]; }
        }
        want.retain(|_, v| *v != [0; 6]);
        got.retain(|_, v| *v != [0; 6]);
        assert_eq!(got, want, "session/model/hour mismatch in {}", session["label"]);
        buckets += want.len();
    }
    let expected: [i64; 6] = serde_json::from_value(manifest["totals"].clone()).unwrap();
    assert_eq!(total, expected);
    eprintln!("Independent Grok audit: {prompts} prompts, {buckets} session/model/hour buckets; mismatch=0; [uncached,cache-read,cache-write,output,reasoning-subset,cost-ticks]={total:?}");
}

#[test]
fn incomplete_then_complete_model_map_does_not_rebill_the_prompt() {
    let a = completion("a", "1", 100, 80, 10, 100);
    let mut b = completion("a", "2", 300, 240, 30, 300);
    b["params"]["update"]["usage"]["modelUsage"] = json!({
        "grok-4.5": {"inputTokens":50,"cachedReadTokens":40,"outputTokens":5,"costUsdTicks":50},
        "other-model": {"inputTokens":250,"cachedReadTokens":200,"outputTokens":25,"costUsdTicks":250}
    });
    let e = parse(&[a, b]);
    assert!(e.iter().all(|e| e.model.is_empty()), "ambiguous model split must stay unknown");
    assert_eq!(e.iter().map(|e| e.tokens_in + e.cache_read + e.tokens_out).sum::<i64>(), 330);
    assert!((e.iter().map(|e| e.cost_usd).sum::<f64>() - 300.0 / 1e10).abs() < 1e-15);
}

#[test]
fn complete_then_incomplete_model_map_does_not_rebill_the_prompt() {
    let mut a = completion("a", "1", 300, 240, 30, 300);
    a["params"]["update"]["usage"]["modelUsage"] = json!({
        "grok-4.5": {"inputTokens":100,"cachedReadTokens":80,"outputTokens":10,"costUsdTicks":100},
        "other-model": {"inputTokens":200,"cachedReadTokens":160,"outputTokens":20,"costUsdTicks":200}
    });
    let b = completion("a", "2", 400, 320, 40, 400);
    let e = parse(&[a, b]);
    assert_eq!(e.iter().map(|e| e.tokens_in + e.cache_read + e.tokens_out).sum::<i64>(), 440);
    assert!((e.iter().map(|e| e.cost_usd).sum::<f64>() - 400.0 / 1e10).abs() < 1e-15);
}

#[test]
fn incomplete_model_cache_write_and_reasoning_cannot_replace_root_buckets() {
    let mut row = completion("a", "1", 100, 40, 30, 100);
    let u = &mut row["params"]["update"]["usage"];
    u["cacheCreationTokens"] = json!(20);
    u["reasoningTokens"] = json!(25);
    u["modelUsage"] = json!({"grok-4.5": {
        "inputTokens":100,"cachedReadTokens":40,"outputTokens":30,
        "reasoningTokens":10,"costUsdTicks":100
    }});
    let e = parse(&[row]);
    assert_eq!((e[0].tokens_in, e[0].cache_read, e[0].cache_write, e[0].tokens_out, e[0].reasoning),
        (40, 40, 20, 30, 25));
}

#[test]
fn cost_coverage_distinguishes_missing_explicit_zero_and_reported_cost() {
    let mut missing = completion("missing", "1", 100, 80, 10, 0);
    missing["params"]["update"]["usage"].as_object_mut().unwrap().remove("costUsdTicks");
    let e = parse(&[missing, completion("free", "2", 100, 80, 10, 0),
        completion("paid", "3", 100, 80, 10, 12345)]);
    assert_eq!(e.iter().map(|e| e.cost_incomplete).collect::<Vec<_>>(), vec![true, false, false]);
    assert!(e.iter().all(|e| e.cost_usd.is_finite()));
    assert_eq!(e.iter().map(|e| e.cost_usd).sum::<f64>(), 12345.0 / 1e10);
}

#[test]
fn later_cumulative_cost_recovery_keeps_earlier_hour_uncertainty() {
    let mut a = completion("a", "1", 100, 80, 10, 0);
    a["params"]["update"]["usage"].as_object_mut().unwrap().remove("costUsdTicks");
    let mut b = completion("a", "2", 200, 160, 20, 300);
    b["timestamp"] = json!(1785286800);
    let e = parse(&[a, b]);
    assert!(e[0].cost_incomplete);
    assert!(!e[1].cost_incomplete);
    assert_eq!(e.iter().map(|e| e.cost_usd).sum::<f64>(), 300.0 / 1e10);
    assert_eq!(e.iter().map(|e| e.tokens_in + e.cache_read + e.tokens_out).sum::<i64>(), 220);
}

#[test]
fn native_incomplete_usage_flags_cost_without_changing_reported_money() {
    let mut row = completion("a", "1", 100, 80, 10, 123);
    row["params"]["update"]["usage"]["usageIsIncomplete"] = json!(true);
    let e = parse(&[row]);
    assert!(e[0].cost_incomplete);
    assert_eq!(e[0].cost_usd, 123.0 / 1e10);
}

#[test]
fn missing_cost_on_unchanged_usage_does_not_create_activity() {
    use super::super::super::aggregate::build_buckets;
    let at = parse_ts("2026-07-29T10:00:00Z").unwrap();
    let mut a = completion("a", "1", 100, 80, 10, 123);
    a["timestamp"] = json!(at.timestamp());
    let baseline = parse(&[a.clone()]);
    let mut b = completion("a", "2", 100, 80, 10, 0);
    b["params"]["update"]["usage"].as_object_mut().unwrap().remove("costUsdTicks");
    b["timestamp"] = json!(at.timestamp() + 600);
    let e = parse(&[a, b]);
    let now = at + chrono::Duration::hours(1);
    let original = build_buckets(&baseline, now);
    let updated = build_buckets(&e, now);
    assert_eq!(updated.iter().map(|b| b.active_ms).sum::<i64>(),
        original.iter().map(|b| b.active_ms).sum::<i64>(), "quality-only update must not create work");
    assert_eq!(e.len(), 1);
    assert!(e[0].cost_incomplete);
    assert_eq!(e[0].at, baseline[0].at);
    assert_eq!(e[0].cost_usd, baseline[0].cost_usd);
    assert_eq!((e[0].tokens_in, e[0].cache_read, e[0].tokens_out),
        (baseline[0].tokens_in, baseline[0].cache_read, baseline[0].tokens_out));
    assert_eq!(updated.iter().map(|b| b.turns).sum::<i64>(),
        original.iter().map(|b| b.turns).sum::<i64>());
}

#[test]
fn model_cost_coverage_distinguishes_unreported_from_explicit_zero() {
    let mut row = completion("a", "1", 300, 240, 30, 0);
    row["params"]["update"]["usage"]["modelUsage"] = json!({
        "free-model": {"inputTokens":100,"cachedReadTokens":80,"outputTokens":10,"costUsdTicks":0},
        "unknown-model": {"inputTokens":200,"cachedReadTokens":160,"outputTokens":20}
    });
    let e = parse(&[row]);
    assert_eq!(e.iter().find(|e| e.model == "free-model").unwrap().cost_incomplete, false);
    assert_eq!(e.iter().find(|e| e.model == "unknown-model").unwrap().cost_incomplete, true);
    assert!(e.iter().all(|e| e.cost_usd == 0.0 && e.cost_usd.is_finite()));
}

#[test]
fn zero_work_missing_cost_never_creates_a_turn_or_timeline_event() {
    let mut empty = completion("a", "1", 0, 0, 0, 0);
    empty["params"]["update"]["usage"].as_object_mut().unwrap().remove("costUsdTicks");
    assert!(parse(&[empty.clone()]).is_empty());
    let mut work = completion("a", "2", 100, 80, 10, 123);
    work["timestamp"] = json!(1785286800);
    let e = parse(&[empty, work]);
    assert_eq!(e.len(), 1);
    assert_eq!(e[0].at.timestamp(), 1785286800);
    assert!(e[0].cost_incomplete);
    assert!(e[0].is_turn);
    assert_eq!(e[0].cost_usd, 123.0 / 1e10);
}
