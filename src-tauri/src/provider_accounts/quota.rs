use std::path::Path;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use crate::commands::usage::UsageData;

pub struct AccountUsage {
    pub usage: UsageData,
    // Partial reported windows remain displayable, but cannot certify capacity.
    pub(super) quota_complete: bool,
    // Extra credits/unlimited allowance has no meaningful remaining percentage.
    pub allowance_usable: bool,
    pub plan: Option<String>,
}
impl From<UsageData> for AccountUsage {
    fn from(usage: UsageData) -> Self { Self { usage, quota_complete: true, allowance_usable: false, plan: None } }
}

// Native quota refresh can rotate auth.json. Reconnect must hold this same lock.
pub(super) fn credential_lock(home: &Path) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    use std::sync::{Arc, Mutex, OnceLock, Weak};
    static LOCKS: OnceLock<Mutex<std::collections::HashMap<std::path::PathBuf, Weak<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
        .lock().unwrap_or_else(|error| error.into_inner());
    if let Some(lock) = locks.get(home).and_then(Weak::upgrade) { return lock; }
    locks.retain(|_, lock| lock.strong_count() > 0);
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(home.to_path_buf(), Arc::downgrade(&lock));
    lock
}

async fn read_message<R: tokio::io::AsyncBufRead + Unpin>(output: &mut R) -> Result<Value, String> {
    let mut line = Vec::new();
    output.take(1024 * 1024 + 1).read_until(b'\n', &mut line).await
        .map_err(|_| "Could not read Codex account status")?;
    if line.is_empty() { return Err("Codex account check ended unexpectedly".into()); }
    if line.len() > 1024 * 1024 { return Err("Codex account response exceeded its limit".into()); }
    serde_json::from_slice(&line).map_err(|_| "Invalid Codex account response".into())
}

fn start_codex(home: &Path) -> Result<tokio::process::Child, String> {
    tokio::process::Command::new("codex")
        .args(["app-server", "-c", "cli_auth_credentials_store=\"file\""])
        .env("PATH", crate::process::provider::build_augmented_path())
        .env("CODEX_HOME", home).env_remove("OPENAI_API_KEY").env_remove("CODEX_API_KEY")
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null()).kill_on_drop(true).spawn()
        .map_err(|_| "Could not start Codex to check account usage. Install Codex and try again.".into())
}

/// Reads only account metadata and the account-specific native catalog. Never
/// creates a thread/turn or rewrites global credentials. Catalogs can be cached;
/// callers must also enforce the entitlement floor in compatibility.rs.
pub(super) async fn codex_models(home: &Path) -> Result<(Option<String>, Vec<String>), String> {
    let credential_lock = credential_lock(home);
    let _credentials = tokio::time::timeout(std::time::Duration::from_secs(5), credential_lock.lock())
        .await.map_err(|_| "Codex account is busy".to_string())?;
    let mut child = start_codex(home)?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(25), async {
        let mut input = child.stdin.take().ok_or("Missing Codex input")?;
        let output = child.stdout.take().ok_or("Missing Codex output")?;
        codex_model_catalog(&mut input, &mut BufReader::new(output)).await
    }).await.map_err(|_| "Codex model check timed out".to_string()).and_then(|r| r);
    // kill_on_drop also covers cancellation; cleanup itself must never hang.
    let _ = child.start_kill();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await;
    result
}

async fn catalog_request<W: tokio::io::AsyncWrite + Unpin, R: tokio::io::AsyncBufRead + Unpin>(
    input: &mut W, output: &mut R, lines_left: &mut usize, id: i64, method: &str, params: Value,
) -> Result<Value, String> {
    let body = json!({"id":id,"method":method,"params":params}).to_string() + "\n";
    input.write_all(body.as_bytes()).await.map_err(|_| "Could not check Codex models")?;
    while *lines_left > 0 {
        *lines_left -= 1;
        let value = read_message(output).await?;
        if value["id"].as_i64() != Some(id) { continue; }
        if !value["error"].is_null() { return Err("Codex could not check this account's models".into()); }
        return value.get("result").cloned().ok_or_else(|| "Missing Codex model response".into());
    }
    Err("Codex model response exceeded its message limit".into())
}

async fn codex_model_catalog<W: tokio::io::AsyncWrite + Unpin, R: tokio::io::AsyncBufRead + Unpin>(
    input: &mut W, output: &mut R,
) -> Result<(Option<String>, Vec<String>), String> {
    let mut lines_left = 256;
    catalog_request(input, output, &mut lines_left, 1, "initialize",
        json!({"clientInfo":{"name":"agmux","version":"1.0"},"capabilities":{"experimentalApi":true}})).await?;
    input.write_all(b"{\"method\":\"initialized\",\"params\":{}}\n").await.map_err(|_| "Could not initialize Codex")?;
    let account = catalog_request(input, output, &mut lines_left, 2, "account/read", json!({"refreshToken":false})).await?;
    // Prefer the native account response; never fill missing/unknown plans from
    // unverified JWT display metadata or a potentially stale catalog.
    let plan = account.pointer("/account/planType").and_then(Value::as_str).and_then(super::profile::plan_from_value);
    let mut models = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen = std::collections::HashSet::new();
    for page in 0..16 {
        let result = catalog_request(input, output, &mut lines_left, 3 + page, "model/list",
            json!({"includeHidden":false,"limit":100,"cursor":cursor})).await?;
        let data = result["data"].as_array().ok_or("Missing Codex model catalog")?;
        for entry in data {
            // Match the actual model string, never an id, display name or alias.
            if entry["hidden"].as_bool() == Some(false) {
                if let Some(model) = entry["model"].as_str().filter(|s| !s.is_empty()) {
                    models.push(model.to_owned());
                }
            }
        }
        match result.get("nextCursor") {
            None | Some(Value::Null) => return Ok((plan, models)),
            Some(Value::String(next)) if !next.is_empty() && next.len() <= 1024 && seen.insert(next.clone()) => cursor = Some(next.clone()),
            _ => return Err("Invalid Codex model pagination".into()),
        }
    }
    Err("Codex model catalog exceeded its page limit".into())
}

pub async fn fetch(provider: &str, home: &Path) -> Result<AccountUsage, String> {
    super::storage::valid_provider(provider)?;
    let credential_lock = credential_lock(home);
    let _credentials = credential_lock.lock().await;
    if provider == "claude" { return super::claude::usage(home).await; }
    if provider == "grok" {
        return tokio::time::timeout(std::time::Duration::from_secs(50), crate::commands::usage::fetch_grok_usage_at(home))
            .await.map_err(|_| "Account usage check timed out".to_string())?
            .map(AccountUsage::from).map_err(|_| "Could not check Grok account usage".to_string());
    }
    let mut child = start_codex(home)?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(25), async {
        let mut input = child.stdin.take().ok_or("Missing Codex input")?;
        let output = child.stdout.take().ok_or("Missing Codex output")?;
        let mut output = BufReader::new(output);
        let mut account_plan = None;
        for (id, method, params) in [
            (1, "initialize", json!({"clientInfo":{"name":"agmux","version":"1.0"},"capabilities":{"experimentalApi":true}})),
            (2, "account/read", json!({"refreshToken":false})),
            (3, "account/rateLimits/read", json!({})),
        ] {
            let body = json!({"id":id,"method":method,"params":params}).to_string() + "\n";
            input.write_all(body.as_bytes()).await.map_err(|_| "Could not check Codex account")?;
            loop {
                let value = read_message(&mut output).await?;
                if value["id"].as_i64() != Some(id) { continue; }
                if !value["error"].is_null() { return Err("Codex could not check this account. Try signing in again.".into()); }
                if id == 2 {
                    account_plan = value.pointer("/result/account/planType").and_then(Value::as_str).and_then(super::profile::plan_from_value);
                }
                if id == 3 {
                    let mut usage = parse_codex(&value["result"]);
                    usage.plan = account_plan.or(usage.plan);
                    return Ok(usage);
                }
                if id == 1 {
                    input.write_all(b"{\"method\":\"initialized\",\"params\":{}}\n").await.map_err(|_| "Could not initialize Codex")?;
                }
                break;
            }
        }
        Err("Codex did not return usage".to_string())
    }).await.map_err(|_| "Account usage check timed out".to_string()).and_then(|r| r);
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

fn parse_codex(value: &Value) -> AccountUsage {
    let mut limits = value.get("rateLimits").unwrap_or(value).clone();
    let plan = limits.get("planType").and_then(Value::as_str).and_then(super::profile::plan_from_value);
    let allowance_usable = limits["credits"]["hasCredits"].as_bool() == Some(true)
        || limits["credits"]["unlimited"].as_bool() == Some(true);
    let mut unknown_window = false;
    for slot in ["primary", "secondary"] {
        let window = &limits[slot];
        let used = window.get("usedPercent").or_else(|| window.get("used_percent")).and_then(Value::as_f64);
        if !used.is_some_and(|n| n.is_finite() && n >= 0.0) {
            unknown_window |= !window.is_null();
            if let Some(obj) = limits.as_object_mut() { obj.remove(slot); }
        }
    }
    let usage = crate::commands::usage::parse_codex_rate_limits(&limits);
    if unknown_window && ![&usage.session, &usage.weekly].into_iter().flatten().any(|w| w.utilization >= 100.0) {
        return AccountUsage { usage: UsageData::default(), quota_complete: true, allowance_usable, plan };
    }
    AccountUsage { usage, quota_complete: true, allowance_usable, plan }
}

pub fn summarize(account: &AccountUsage, now: i64) -> (Option<f64>, Option<i64>) {
    if account.allowance_usable { return (None, None); }
    let usage = &account.usage;
    let windows: Vec<_> = [&usage.session, &usage.weekly].into_iter().flatten().collect();
    let mut remaining: Option<f64> = None;
    let mut blocked_reset: Option<i64> = None;
    let mut any_reset: Option<i64> = None;
    let mut unknown_block_reset = false;
    let mut unknown_window = !account.quota_complete;
    for w in windows {
        if !w.utilization.is_finite() || w.utilization < 0.0 { unknown_window = true; continue; }
        let reset = w.resets_at.as_deref().and_then(|s| s.parse::<i64>().ok().or_else(||
            chrono::DateTime::parse_from_rfc3339(s).ok().map(|v| v.timestamp())));
        if reset.is_some_and(|v| v <= now) { unknown_window = true; continue; }
        let value = (100.0 - w.utilization).clamp(0.0, 100.0);
        remaining = Some(remaining.map_or(value, |v| v.min(value)));
        if let Some(reset) = reset { any_reset = Some(any_reset.map_or(reset, |v| v.min(reset))); }
        if value == 0.0 {
            match reset {
                Some(reset) => blocked_reset = Some(blocked_reset.map_or(reset, |v| v.max(reset))),
                None => unknown_block_reset = true,
            }
        }
    }
    if unknown_window && remaining != Some(0.0) { return (None, None); }
    (remaining, if unknown_block_reset { None } else { blocked_reset.or(any_reset) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::usage::UsageWindow;

    fn catalog_responses(pages: &[Value], plan: &str) -> Vec<u8> {
        let mut responses = vec![json!({"id":1,"result":{}}), json!({"id":2,"result":{"account":{"planType":plan}}})];
        responses.extend(pages.iter().enumerate().map(|(i, page)| json!({"id":i + 3,"result":page})));
        responses.into_iter().map(|v| v.to_string() + "\n").collect::<String>().into_bytes()
    }

    #[tokio::test]
    async fn catalog_follows_pages_and_uses_only_exact_visible_model_strings() {
        let responses = catalog_responses(&[
            json!({"data":[{"model":"gpt-hidden","hidden":true},{"model":"gpt-unknown"},{"id":"alias-only","hidden":false}],"nextCursor":"page-two"}),
            json!({"data":[{"id":"different-id","model":"gpt-5.4","hidden":false}],"nextCursor":null}),
        ], "prolite");
        let mut requests = Vec::new();
        let (plan, models) = codex_model_catalog(&mut requests, &mut responses.as_slice()).await.unwrap();
        assert_eq!(plan.as_deref(), Some("Pro 5x"));
        assert_eq!(models, vec!["gpt-5.4"]);
        let requests: Vec<Value> = String::from_utf8(requests).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(requests.iter().map(|v| v["method"].as_str().unwrap()).collect::<Vec<_>>(),
            vec!["initialize", "initialized", "account/read", "model/list", "model/list"]);
        assert_eq!(requests[2]["params"]["refreshToken"], false);
        assert_eq!(requests[3]["params"]["includeHidden"], false);
        assert_eq!(requests[4]["params"]["cursor"], "page-two");
    }

    #[tokio::test]
    async fn catalog_unknown_plan_stays_unknown() {
        let responses = catalog_responses(&[json!({"data":[{"model":"gpt-5.4","hidden":false}]})], "future");
        let (plan, models) = codex_model_catalog(&mut Vec::new(), &mut responses.as_slice()).await.unwrap();
        assert_eq!(plan, None);
        assert_eq!(models, vec!["gpt-5.4"]);
    }

    #[tokio::test]
    async fn catalog_rejects_invalid_or_unbounded_pagination_without_partial_success() {
        for pages in [
            vec![json!({"data":[] ,"nextCursor":42})],
            vec![json!({"data":[],"nextCursor":""})],
            vec![json!({"data":[],"nextCursor":"same"}); 2],
            (0..16).map(|i| json!({"data":[],"nextCursor":format!("page-{i}")})).collect(),
            vec![json!({"data":"invalid"})],
        ] {
            let responses = catalog_responses(&pages, "plus");
            assert!(codex_model_catalog(&mut Vec::new(), &mut responses.as_slice()).await.is_err());
        }
    }

    #[tokio::test]
    async fn catalog_bounds_notifications_and_redacts_rpc_errors() {
        let responses = (json!({"method":"notification","params":{}}).to_string() + "\n").repeat(257);
        let error = codex_model_catalog(&mut Vec::new(), &mut responses.as_bytes()).await.unwrap_err();
        assert!(error.contains("message limit"));
        let responses = b"{\"id\":1,\"error\":{\"message\":\"secret-token\"}}\n";
        let error = codex_model_catalog(&mut Vec::new(), &mut responses.as_slice()).await.unwrap_err();
        assert!(!error.contains("secret"));
    }

    fn window(used: f64, reset: Option<&str>) -> Option<UsageWindow> {
        Some(UsageWindow { utilization: used, resets_at: reset.map(str::to_owned), window_minutes: None })
    }
    #[tokio::test]
    async fn credential_locks_serialize_same_home_without_blocking_other_accounts() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("one");
        let first = credential_lock(&home);
        let held = first.lock().await;
        let same = credential_lock(&home);
        let other = credential_lock(&tmp.path().join("two"));
        assert!(std::sync::Arc::ptr_eq(&first, &same));
        assert!(same.try_lock().is_err());
        assert!(other.try_lock().is_ok());
        // A waiting owner must retain the registry entry after the caller drops
        // its Arc; owned guards model release/probe callers that move the lock.
        drop(held);
        drop(first);
        let held = same.lock_owned().await;
        let same = credential_lock(&home);
        assert!(same.try_lock().is_err());
        drop(held);
        assert!(same.try_lock().is_ok());
    }
    #[test]
    fn usable_credit_allowance_overrides_exhaustion_without_inventing_percentage() {
        for credits in [json!({"hasCredits":true}), json!({"unlimited":true})] {
            let usage = parse_codex(&json!({"rateLimits":{"primary":{"usedPercent":100,"resetsAt":500},"credits":credits}}));
            assert!(usage.allowance_usable);
            assert_eq!(summarize(&usage, 100), (None, None));
        }
        for credits in [Value::Null, json!({"hasCredits":false,"unlimited":false}), json!({"hasCredits":"true"}), json!({"balance":"100"})] {
            let usage = parse_codex(&json!({"rateLimits":{"primary":{"usedPercent":100,"resetsAt":500},"credits":credits}}));
            assert!(!usage.allowance_usable);
            assert_eq!(summarize(&usage, 100), (Some(0.0), Some(500)));
        }
    }
    #[tokio::test]
    async fn provider_messages_are_bounded_and_never_echo_payloads() {
        let oversized = vec![b'x'; 1024 * 1024 + 1];
        let error = read_message(&mut oversized.as_slice()).await.unwrap_err();
        assert_eq!(error, "Codex account response exceeded its limit");
        let error = read_message(&mut b"secret token invalid json\n".as_slice()).await.unwrap_err();
        assert!(!error.contains("secret"));
        assert!(read_message(&mut b"".as_slice()).await.is_err());
        assert_eq!(read_message(&mut b"{\"id\":1}\n".as_slice()).await.unwrap()["id"], 1);
    }
    #[test]
    fn incomplete_or_stale_window_cannot_certify_available_capacity() {
        let usage = parse_codex(&json!({"rateLimits":{"primary":{"usedPercent":10},"secondary":{"resetsAt":500}}}));
        assert_eq!(summarize(&usage.into(), 100), (None, None));
        let usage = UsageData { session: window(100.0, Some("90")), weekly: window(20.0, Some("300")), ..Default::default() };
        assert_eq!(summarize(&usage.into(), 100), (None, None));
        let usage = parse_codex(&json!({"rateLimits":{"primary":{"usedPercent":100},"secondary":{"resetsAt":500}}}));
        assert_eq!(summarize(&usage.into(), 100), (Some(0.0), None));
    }
    #[test]
    fn incomplete_quota_preserves_display_windows_but_only_confirms_exhaustion() {
        let mut account = AccountUsage::from(UsageData { weekly: window(20.0, Some("300")), ..Default::default() });
        assert!(account.quota_complete);
        assert!(parse_codex(&json!({"rateLimits":{}})).quota_complete);
        assert_eq!(summarize(&account, 100), (Some(80.0), Some(300)));
        account.quota_complete = false;
        assert_eq!(summarize(&account, 100), (None, None));
        assert_eq!(account.usage.weekly.as_ref().unwrap().utilization, 20.0);
        account.usage.weekly = window(100.0, Some("300"));
        assert_eq!(summarize(&account, 100), (Some(0.0), Some(300)));
        assert_eq!(summarize(&account, 300), (None, None));
        account.usage.weekly = window(100.0, None);
        assert_eq!(summarize(&account, 100), (Some(0.0), None));
    }
    #[test]
    fn negative_usage_does_not_become_free_capacity() {
        let usage = UsageData { session: window(-1.0, None), ..Default::default() };
        assert_eq!(summarize(&usage.into(), 100), (None, None));
    }
    #[test]
    fn missing_used_percent_is_unknown_not_free() {
        let usage = parse_codex(&json!({"rateLimits":{"primary":{"resetsAt":500,"windowDurationMins":300}}}));
        assert_eq!(summarize(&usage.into(), 100), (None, None));
    }
    #[test]
    fn both_exhausted_windows_must_reset() {
        let usage = UsageData { session: window(100.0, Some("200")), weekly: window(100.0, Some("300")), ..Default::default() };
        assert_eq!(summarize(&usage.into(), 100), (Some(0.0), Some(300)));
    }
    #[test]
    fn stale_and_unknown_are_not_free() {
        assert_eq!(summarize(&UsageData::default().into(), 100), (None, None));
        let usage = UsageData { session: window(100.0, Some("90")), ..Default::default() };
        assert_eq!(summarize(&usage.into(), 100), (None, None));
        let usage = UsageData { session: window(100.0, None), weekly: window(20.0, Some("300")), ..Default::default() };
        assert_eq!(summarize(&usage.into(), 100), (Some(0.0), None));
    }
}
