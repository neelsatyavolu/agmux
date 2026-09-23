use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

/// A single usage window (session or weekly).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub utilization: f64,
    pub resets_at: Option<String>,
    pub window_minutes: Option<i64>,
}

/// Normalized usage data returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UsageData {
    pub session: Option<UsageWindow>,
    pub weekly: Option<UsageWindow>,
    /// Per-model weekly window for Sonnet (Claude Max plans).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sonnet: Option<UsageWindow>,
    /// Per-model weekly window for Opus (Claude Max plans).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opus: Option<UsageWindow>,
    /// Feature-quota: Claude "Designs" weekly window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub design: Option<UsageWindow>,
    /// Feature-quota: Claude "Daily Routines" weekly window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routines: Option<UsageWindow>,
}

// ── Claude Usage ─────────────────────────────────────────────

const CLAUDE_WEEK_MINUTES: i64 = 7 * 24 * 60;

/// Pull a `{ utilization, resets_at }` window from a raw JSON map under any of
/// the supplied key aliases. Returns the first matching key (Anthropic uses
/// different names across account tiers — e.g. `seven_day_design` vs
/// `seven_day_omelette`).
fn extract_claude_window(
    root: &serde_json::Value,
    keys: &[&str],
    default_window_minutes: i64,
) -> Option<UsageWindow> {
    let obj = root.as_object()?;
    for key in keys {
        let Some(value) = obj.get(*key) else { continue };
        if value.is_null() {
            continue;
        }
        let utilization = value
            .get("utilization")
            .and_then(|v| v.as_f64().or_else(|| v.as_i64().map(|n| n as f64)))?;
        let resets_at = value
            .get("resets_at")
            .and_then(|v| v.as_str().map(|s| s.to_string()));
        return Some(UsageWindow {
            utilization,
            resets_at,
            window_minutes: Some(default_window_minutes),
        });
    }
    None
}

/// Extract accessToken from various JSON structures.
fn extract_access_token(creds: &serde_json::Value) -> Option<String> {
    // Try nested: claudeAiOauth.accessToken
    if let Some(token) = creds
        .get("claudeAiOauth")
        .and_then(|v| v.get("accessToken"))
        .and_then(|v| v.as_str())
    {
        return Some(token.to_string());
    }
    // Try top-level accessToken
    if let Some(token) = creds.get("accessToken").and_then(|v| v.as_str()) {
        return Some(token.to_string());
    }
    // Try any nested object that has accessToken
    if let Some(obj) = creds.as_object() {
        for (_key, val) in obj {
            if let Some(token) = val.get("accessToken").and_then(|v| v.as_str()) {
                return Some(token.to_string());
            }
        }
    }
    None
}

/// Read Claude OAuth token from macOS Keychain, with file fallback.
async fn read_claude_token() -> Result<String, String> {
    // The "Claude Code-credentials" service can hold multiple accounts:
    // the user OAuth blob (account = $USER) plus MCP OAuth blobs
    // (e.g. "$USER-projectname") and a "licenseState" entry. An unscoped
    // `-w` lookup returns an arbitrary match, which often lacks the
    // `claudeAiOauth.accessToken` field. Try the current user first and
    // fall back to the unscoped lookup for older setups.
    let user = std::env::var("USER").unwrap_or_default();
    let mut account_attempts: Vec<Option<&str>> = Vec::new();
    if !user.is_empty() {
        account_attempts.push(Some(user.as_str()));
    }
    account_attempts.push(None);

    for account in account_attempts {
        let mut args: Vec<&str> = vec!["find-generic-password", "-s", "Claude Code-credentials"];
        if let Some(a) = account {
            args.push("-a");
            args.push(a);
        }
        args.push("-w");

        let output = tokio::process::Command::new("security")
            .args(&args)
            .output()
            .await
            .map_err(|e| format!("Failed to run security command: {e}"))?;

        if !output.status.success() {
            continue;
        }
        let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
        // The keychain value is JSON — e.g. {"claudeAiOauth":{"accessToken":"sk-ant-..."}}
        if let Ok(creds) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(token) = extract_access_token(&creds) {
                return Ok(token);
            }
        }
        // Maybe the raw value is the token itself
        if raw.starts_with("sk-ant-") {
            return Ok(raw);
        }
    }

    // File fallback: ~/.claude/.credentials.json
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let cred_path = home.join(".claude").join(".credentials.json");
    if cred_path.exists() {
        let content = tokio::fs::read_to_string(&cred_path)
            .await
            .map_err(|e| format!("Failed to read credentials file: {e}"))?;
        let creds: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| format!("Invalid credentials JSON: {e}"))?;
        if let Some(token) = extract_access_token(&creds) {
            return Ok(token);
        }
    }

    // Also try ~/.claude/credentials.json (without leading dot)
    let cred_path2 = home.join(".claude").join("credentials.json");
    if cred_path2.exists() {
        let content = tokio::fs::read_to_string(&cred_path2)
            .await
            .map_err(|e| format!("Failed to read credentials file: {e}"))?;
        let creds: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| format!("Invalid credentials JSON: {e}"))?;
        if let Some(token) = extract_access_token(&creds) {
            return Ok(token);
        }
    }

    Err("No Claude OAuth token found in Keychain or credentials file".to_string())
}

#[tauri::command]
pub async fn fetch_claude_usage() -> Result<UsageData, String> {
    let token = read_claude_token().await?;
    let client = reqwest::Client::new();

    // Retry once on 429
    let mut attempts = 0;
    let resp = loop {
        attempts += 1;
        let r = client
            .get("https://api.anthropic.com/api/oauth/usage")
            .header("Authorization", format!("Bearer {token}"))
            .header("anthropic-beta", "oauth-2025-04-20")
            .header("User-Agent", "xanom/0.1.0")
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("Failed to fetch Claude usage: {e}"))?;

        if r.status() == reqwest::StatusCode::TOO_MANY_REQUESTS && attempts < 3 {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            continue;
        }
        break r;
    };

    if !resp.status().is_success() {
        let status = resp.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err("Rate limited — try again shortly".to_string());
        }
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Claude usage API returned {status}: {body}"));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Claude usage response: {e}"))?;

    Ok(UsageData {
        session: extract_claude_window(&data, &["five_hour"], 300),
        weekly: extract_claude_window(&data, &["seven_day"], CLAUDE_WEEK_MINUTES),
        // Model-specific weekly quotas exposed on Claude Max plans.
        sonnet: extract_claude_window(&data, &["seven_day_sonnet"], CLAUDE_WEEK_MINUTES),
        opus: extract_claude_window(&data, &["seven_day_opus"], CLAUDE_WEEK_MINUTES),
        // Feature quotas — Anthropic uses different keys across account tiers.
        design: extract_claude_window(
            &data,
            &[
                "seven_day_design",
                "seven_day_claude_design",
                "claude_design",
                "design",
                "seven_day_omelette",
                "omelette",
                "omelette_promotional",
            ],
            CLAUDE_WEEK_MINUTES,
        ),
        routines: extract_claude_window(
            &data,
            &[
                "seven_day_routines",
                "seven_day_claude_routines",
                "claude_routines",
                "routines",
                "routine",
                "seven_day_cowork",
                "cowork",
            ],
            CLAUDE_WEEK_MINUTES,
        ),
    })
}

// ── Codex Usage ──────────────────────────────────────────────

/// Historical defaults when the API omits duration (pre-windowDurationMins clients).
const CODEX_SESSION_MINUTES: i64 = 5 * 60;
const CODEX_WEEKLY_MINUTES: i64 = 7 * 24 * 60;
/// Windows shorter than a day are the rolling "session" / 5-hour style bucket.
const CODEX_SHORT_WINDOW_MAX_MINS: i64 = 24 * 60;

#[tauri::command]
pub async fn fetch_codex_usage(state: State<'_, AppState>) -> Result<UsageData, String> {
    let server = {
        let mgr = state.codex_servers.lock().await;
        mgr.get_any().ok_or("Codex server is not running")?
    };

    let result = server
        .send_request("account/rateLimits/read", serde_json::json!({}))
        .await
        .map_err(|e| format!("Failed to fetch Codex rate limits: {e}"))?;

    Ok(parse_codex_rate_limits(&result))
}

/// Normalize `account/rateLimits/read` into session (short) + weekly (long) slots.
///
/// Codex schema (`RateLimitWindow`): `usedPercent`, `windowDurationMins`, `resetsAt`.
/// OpenAI sometimes lifts the 5-hour bucket — only the weekly window remains on
/// `primary` while `secondary` is null. We must not treat null as a 0% bar, and
/// we slot by actual duration rather than always primary→session.
pub(crate) fn parse_codex_rate_limits(result: &serde_json::Value) -> UsageData {
    // { "rateLimits": { "primary": …, "secondary": … } } or flat primary/secondary.
    let limits = result.get("rateLimits").unwrap_or(result);

    let primary = parse_codex_window(limits, "primary");
    let secondary = parse_codex_window(limits, "secondary");
    let (session, weekly) = slot_codex_windows(primary, secondary);

    UsageData {
        session,
        weekly,
        ..UsageData::default()
    }
}

fn parse_codex_window(limits: &serde_json::Value, key: &str) -> Option<UsageWindow> {
    let window = limits.get(key)?;
    // Null / non-object means "this bucket is absent" — not 0% used.
    if !window.is_object() {
        return None;
    }

    let utilization = window
        .get("usedPercent")
        .or_else(|| window.get("used_percent"))
        .and_then(|v| v.as_f64().or_else(|| v.as_i64().map(|n| n as f64)))
        .unwrap_or(0.0);

    let resets_at = window
        .get("resetsAt")
        .or_else(|| window.get("resets_at"))
        .and_then(|v| {
            if let Some(s) = v.as_str() {
                Some(s.to_string())
            } else if let Some(n) = v.as_i64() {
                Some(n.to_string())
            } else if let Some(n) = v.as_f64() {
                Some(n.to_string())
            } else {
                None
            }
        });

    // Codex app-server field is `windowDurationMins` (schema RateLimitWindow).
    // Keep legacy aliases for older payloads / fixtures.
    let window_minutes = window
        .get("windowDurationMins")
        .or_else(|| window.get("window_duration_mins"))
        .or_else(|| window.get("windowMinutes"))
        .or_else(|| window.get("window_minutes"))
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|n| n as i64)));

    Some(UsageWindow {
        utilization,
        resets_at,
        window_minutes,
    })
}

fn is_codex_short_window(mins: Option<i64>) -> bool {
    matches!(mins, Some(m) if m > 0 && m < CODEX_SHORT_WINDOW_MAX_MINS)
}

fn is_codex_long_window(mins: Option<i64>) -> bool {
    matches!(mins, Some(m) if m >= CODEX_SHORT_WINDOW_MAX_MINS)
}

fn with_default_minutes(mut w: UsageWindow, default: i64) -> UsageWindow {
    if w.window_minutes.is_none() || w.window_minutes == Some(0) {
        w.window_minutes = Some(default);
    }
    w
}

/// Map primary/secondary buckets onto session (short) + weekly (long).
fn slot_codex_windows(
    primary: Option<UsageWindow>,
    secondary: Option<UsageWindow>,
) -> (Option<UsageWindow>, Option<UsageWindow>) {
    match (primary, secondary) {
        // Only primary — often the weekly window after the 5-hour limit was lifted.
        (Some(p), None) if is_codex_long_window(p.window_minutes) => {
            (None, Some(with_default_minutes(p, CODEX_WEEKLY_MINUTES)))
        }
        (Some(p), None) if is_codex_short_window(p.window_minutes) => {
            (Some(with_default_minutes(p, CODEX_SESSION_MINUTES)), None)
        }
        (Some(p), None) => {
            // Duration unknown: historical primary = session.
            (Some(with_default_minutes(p, CODEX_SESSION_MINUTES)), None)
        }
        // Primary is long (weekly), secondary is short (session) — rare swap.
        (Some(p), Some(s))
            if is_codex_long_window(p.window_minutes) && is_codex_short_window(s.window_minutes) =>
        {
            (
                Some(with_default_minutes(s, CODEX_SESSION_MINUTES)),
                Some(with_default_minutes(p, CODEX_WEEKLY_MINUTES)),
            )
        }
        // Primary is long, secondary is not short (null-duration stub or second long):
        // treat primary as weekly; keep secondary only if it looks short or has real use.
        (Some(p), Some(s)) if is_codex_long_window(p.window_minutes) => {
            if is_codex_short_window(s.window_minutes) {
                (
                    Some(with_default_minutes(s, CODEX_SESSION_MINUTES)),
                    Some(with_default_minutes(p, CODEX_WEEKLY_MINUTES)),
                )
            } else {
                // 5-hour removed: primary holds weekly usage; ignore empty secondary.
                (None, Some(with_default_minutes(p, CODEX_WEEKLY_MINUTES)))
            }
        }
        // Classic: primary session, secondary weekly.
        (Some(p), Some(s)) => (
            Some(with_default_minutes(p, CODEX_SESSION_MINUTES)),
            Some(with_default_minutes(s, CODEX_WEEKLY_MINUTES)),
        ),
        (None, Some(s)) if is_codex_short_window(s.window_minutes) => {
            (Some(with_default_minutes(s, CODEX_SESSION_MINUTES)), None)
        }
        (None, Some(s)) => (None, Some(with_default_minutes(s, CODEX_WEEKLY_MINUTES))),
        (None, None) => (None, None),
    }
}

// ── Grok Usage ───────────────────────────────────────────────
//
// Ported from CodexBar's Grok provider (steipete/CodexBar):
//   1. Read SuperGrok OAuth credentials from `~/.grok/auth.json`
//   2. POST empty gRPC-web body to grok.com GetGrokCreditsConfig
//   3. Scan the protobuf payload for used-percent (float32) + reset epoch
//
// ACP `x.ai/billing` over `grok agent stdio` is still method-not-found on
// current CLI builds, so the web billing endpoint is the live path.

const GROK_BILLING_URL: &str =
    "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const GROK_OIDC_SCOPE_PREFIX: &str = "https://auth.x.ai::";
const GROK_LEGACY_SCOPE: &str = "https://accounts.x.ai/sign-in";

struct GrokAuthToken {
    access_token: String,
}

/// Load the preferred bearer token from `~/.grok/auth.json` (or `$GROK_HOME`).
fn read_grok_auth_token() -> Result<GrokAuthToken, String> {
    let grok_home = match std::env::var("GROK_HOME") {
        Ok(p) if !p.trim().is_empty() => std::path::PathBuf::from(p),
        _ => dirs::home_dir()
            .ok_or_else(|| "Cannot determine home directory".to_string())?
            .join(".grok"),
    };

    read_grok_auth_token_at(&grok_home)
}

fn read_grok_auth_token_at(grok_home: &std::path::Path) -> Result<GrokAuthToken, String> {
    let path = grok_home.join("auth.json");
    let raw = std::fs::read_to_string(&path).map_err(|_| {
        "Grok auth.json not found. Run `grok login` to authenticate.".to_string()
    })?;
    let root: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse Grok auth.json: {e}"))?;
    let obj = root
        .as_object()
        .ok_or_else(|| "Grok auth.json is not an object".to_string())?;

    // Prefer SuperGrok OIDC entry, then legacy session scope, then any entry
    // that still carries a non-empty `key`.
    let mut oidc: Option<String> = None;
    let mut legacy: Option<String> = None;
    let mut any: Option<String> = None;
    for (scope, entry) in obj {
        let Some(key) = entry.get("key").and_then(|v| v.as_str()) else {
            continue;
        };
        if key.is_empty() {
            continue;
        }
        if scope.starts_with(GROK_OIDC_SCOPE_PREFIX) {
            oidc = Some(key.to_string());
        } else if scope == GROK_LEGACY_SCOPE || scope.contains("/sign-in") {
            legacy = Some(key.to_string());
        } else if any.is_none() {
            any = Some(key.to_string());
        }
    }

    let access_token = oidc
        .or(legacy)
        .or(any)
        .ok_or_else(|| "Grok auth.json exists but contains no access tokens.".to_string())?;

    Ok(GrokAuthToken { access_token })
}

#[derive(Debug, Clone, PartialEq)]
struct GrokWebBillingSnapshot {
    used_percent: f64,
    resets_at_unix: Option<i64>,
    period_start_unix: Option<i64>,
}

/// Fetch SuperGrok credit usage via grok.com's gRPC-web billing endpoint.
/// Mirrors CodexBar's `GrokWebBillingFetcher` (Bearer auth + protobuf scan).
#[tauri::command]
pub async fn fetch_grok_usage() -> Result<UsageData, String> {
    let auth = read_grok_auth_token()?;
    fetch_grok_usage_with_auth(auth).await
}

pub(crate) async fn fetch_grok_usage_at(home: &std::path::Path) -> Result<UsageData, String> {
    fetch_grok_usage_with_auth(read_grok_auth_token_at(home)?).await
}

async fn fetch_grok_usage_with_auth(auth: GrokAuthToken) -> Result<UsageData, String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build().map_err(|_| "Could not create usage client")?;

    let mut attempts = 0;
    let resp = loop {
        attempts += 1;
        // Empty gRPC-web frame: 1 flag byte + 4-byte big-endian length (0).
        let body = vec![0u8, 0, 0, 0, 0];
        let r = client
            .post(GROK_BILLING_URL)
            .header("Authorization", format!("Bearer {}", auth.access_token))
            .header("Origin", "https://grok.com")
            .header("Referer", "https://grok.com/?_s=usage")
            .header("Accept", "*/*")
            .header("Content-Type", "application/grpc-web+proto")
            .header("x-grpc-web", "1")
            .header("x-user-agent", "connect-es/2.1.1")
            // CodexBar's UA is allow-listed; a browser UA triggers CF challenges.
            .header("User-Agent", "CodexBar")
            .body(body)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch Grok usage: {e}"))?;

        if r.status() == reqwest::StatusCode::TOO_MANY_REQUESTS && attempts < 3 {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            continue;
        }
        // Retry once on transient gateway errors (CodexBar does the same).
        if matches!(
            r.status().as_u16(),
            408 | 502 | 503 | 504
        ) && attempts < 2
        {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            continue;
        }
        break r;
    };

    if !resp.status().is_success() {
        let status = resp.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err("Rate limited — try again shortly".to_string());
        }
        if status == reqwest::StatusCode::UNAUTHORIZED
            || status == reqwest::StatusCode::FORBIDDEN
        {
            return Err(
                "Grok billing auth failed. Run `grok login` to refresh credentials.".to_string(),
            );
        }
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Grok usage API returned {status}: {}",
            body.chars().take(200).collect::<String>()
        ));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read Grok usage body: {e}"))?;

    let snapshot = parse_grok_grpc_web_response(&bytes)
        .ok_or_else(|| "Could not parse Grok web billing usage.".to_string())?;

    // Credits map onto the weekly/primary billing window. Grok has no 5-hour
    // session quota — leave session null so the UI can hide the empty bar.
    let window_minutes = match (snapshot.period_start_unix, snapshot.resets_at_unix) {
        (Some(start), Some(end)) if end > start => Some((end - start) / 60),
        (_, Some(end)) => {
            // Fall back to distance-from-now rounded to a common cycle.
            let now = chrono::Utc::now().timestamp();
            let remaining = (end - now).max(0);
            Some(if remaining > 0 {
                // Prefer whole-week or whole-month windows when close.
                let days = ((remaining as f64) / 86_400.0).round() as i64;
                if (4..=12).contains(&days) {
                    7 * 24 * 60
                } else if (20..=45).contains(&days) {
                    30 * 24 * 60
                } else {
                    remaining / 60
                }
            } else {
                7 * 24 * 60
            })
        }
        _ => Some(7 * 24 * 60),
    };

    let resets_at = snapshot.resets_at_unix.map(|ts| {
        chrono::DateTime::<chrono::Utc>::from_timestamp(ts, 0)
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_else(|| ts.to_string())
    });

    Ok(UsageData {
        session: None,
        weekly: Some(UsageWindow {
            utilization: snapshot.used_percent,
            resets_at,
            window_minutes,
        }),
        ..UsageData::default()
    })
}

/// Split a gRPC-web response into data frames (flags & 0x80 == 0).
fn grok_grpc_web_data_frames(data: &[u8]) -> Option<Vec<&[u8]>> {
    let mut frames = Vec::new();
    let mut index = 0usize;
    while index < data.len() {
        if index + 5 > data.len() {
            return None;
        }
        let flags = data[index];
        let length = u32::from_be_bytes([
            data[index + 1],
            data[index + 2],
            data[index + 3],
            data[index + 4],
        ]) as usize;
        let start = index + 5;
        let end = start.checked_add(length)?;
        if end > data.len() {
            return None;
        }
        if flags & 0x80 == 0 {
            frames.push(&data[start..end]);
        }
        index = end;
    }
    Some(frames)
}

#[derive(Default)]
struct ProtobufScan {
    fixed32: Vec<(Vec<u64>, f32, usize)>,
    varint: Vec<(Vec<u64>, u64, usize)>,
    order: usize,
}

fn read_protobuf_varint(buf: &[u8], mut i: usize) -> Option<(u64, usize)> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    while i < buf.len() {
        let b = buf[i];
        i += 1;
        result |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            return Some((result, i));
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
    None
}

fn scan_protobuf(buf: &[u8], path: &[u64], scan: &mut ProtobufScan, depth: usize) {
    if depth > 6 {
        return;
    }
    let mut i = 0usize;
    while i < buf.len() {
        let Some((key, next)) = read_protobuf_varint(buf, i) else {
            return;
        };
        i = next;
        let field_num = key >> 3;
        let wire = (key & 0x07) as u8;
        let mut field_path = path.to_vec();
        field_path.push(field_num);

        match wire {
            0 => {
                // varint
                let Some((val, next)) = read_protobuf_varint(buf, i) else {
                    return;
                };
                i = next;
                scan.varint.push((field_path, val, scan.order));
                scan.order += 1;
            }
            1 => {
                // 64-bit — skip
                if i + 8 > buf.len() {
                    return;
                }
                i += 8;
            }
            2 => {
                // length-delimited (nested message or string)
                let Some((len, next)) = read_protobuf_varint(buf, i) else {
                    return;
                };
                i = next;
                let len = len as usize;
                if i + len > buf.len() {
                    return;
                }
                let nested = &buf[i..i + len];
                i += len;
                scan_protobuf(nested, &field_path, scan, depth + 1);
            }
            5 => {
                // 32-bit fixed / float
                if i + 4 > buf.len() {
                    return;
                }
                let raw = [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
                i += 4;
                let fval = f32::from_le_bytes(raw);
                scan.fixed32.push((field_path, fval, scan.order));
                scan.order += 1;
            }
            _ => return,
        }
    }
}

fn parse_grok_grpc_web_response(data: &[u8]) -> Option<GrokWebBillingSnapshot> {
    parse_grok_grpc_web_response_at(data, chrono::Utc::now().timestamp() as u64)
}

fn parse_grok_grpc_web_response_at(data: &[u8], now: u64) -> Option<GrokWebBillingSnapshot> {

    let mut payloads: Vec<&[u8]> = grok_grpc_web_data_frames(data).unwrap_or_default();
    if payloads.is_empty() {
        // Some responses ship a bare protobuf without framing.
        if !data.is_empty() {
            let first = data[0];
            let field_number = first >> 3;
            let wire_type = first & 0x07;
            if field_number > 0 && matches!(wire_type, 0 | 1 | 2 | 5) {
                payloads = vec![data];
            }
        }
    }
    if payloads.is_empty() {
        return None;
    }

    let mut scan = ProtobufScan::default();
    for payload in payloads {
        scan_protobuf(payload, &[], &mut scan, 0);
    }

    // Prefer the shallowest field-number-1 float in [0, 100] (used percent).
    let mut percent_candidates: Vec<&(Vec<u64>, f32, usize)> = scan
        .fixed32
        .iter()
        .filter(|(_, v, _)| v.is_finite() && *v >= 0.0 && *v <= 100.0)
        .filter(|(path, _, _)| path.last() == Some(&1))
        .collect();
    percent_candidates.sort_by(|a, b| {
        a.0.len()
            .cmp(&b.0.len())
            .then_with(|| a.2.cmp(&b.2))
    });
    let parsed_percent = percent_candidates.first().map(|(_, v, _)| *v as f64);

    // Epoch seconds that look like modern timestamps.
    let reset_fields: Vec<(&(Vec<u64>, u64, usize), u64)> = scan
        .varint
        .iter()
        .filter_map(|entry| {
            let raw = entry.1;
            if (1_700_000_000..=2_100_000_000).contains(&raw) {
                Some((entry, raw))
            } else {
                None
            }
        })
        .collect();

    let future: Vec<_> = reset_fields
        .iter()
        .filter(|(_, ts)| *ts > now)
        .copied()
        .collect();

    // Prefer path [1, 5, 1] (period end) when present.
    let resets_at_unix = future
        .iter()
        .filter(|(entry, _)| entry.0.as_slice() == [1, 5, 1])
        .map(|(_, ts)| *ts as i64)
        .min()
        .or_else(|| future.iter().map(|(_, ts)| *ts as i64).min());

    // Period start often lives at [1, 4, 1].
    let period_start_unix = reset_fields
        .iter()
        .filter(|(entry, _)| entry.0.as_slice() == [1, 4, 1])
        .map(|(_, ts)| *ts as i64)
        .min()
        .or_else(|| {
            // Any past timestamp as a rough start.
            reset_fields
                .iter()
                .filter(|(_, ts)| *ts <= now)
                .map(|(_, ts)| *ts as i64)
                .max()
        });

    let has_usage_period = scan.varint.iter().any(|(path, val, _)| {
        path.starts_with(&[1, 6]) || (path.as_slice() == [1, 8, 1] && (*val == 1 || *val == 2))
    });
    let no_usage_yet = parsed_percent.is_none()
        && scan.fixed32.is_empty()
        && resets_at_unix.is_some()
        && has_usage_period;

    let used_percent = parsed_percent.or(if no_usage_yet { Some(0.0) } else { None })?;

    Some(GrokWebBillingSnapshot {
        used_percent,
        resets_at_unix,
        period_start_unix,
    })
}

#[cfg(test)]
mod codex_usage_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn null_secondary_is_absent_not_zero_weekly() {
        // OpenAI temporarily lifts the 5-hour bucket: only weekly remains on primary.
        let result = json!({
            "rateLimits": {
                "primary": {
                    "usedPercent": 79,
                    "windowDurationMins": 10080,
                    "resetsAt": 1_786_000_000_i64
                },
                "secondary": null
            }
        });
        let usage = parse_codex_rate_limits(&result);
        assert!(usage.session.is_none(), "no short window → no 5-hour bar");
        let weekly = usage.weekly.expect("weekly from primary");
        assert!((weekly.utilization - 79.0).abs() < 0.01);
        assert_eq!(weekly.window_minutes, Some(10080));
    }

    #[test]
    fn classic_primary_session_secondary_weekly() {
        let result = json!({
            "rateLimits": {
                "primary": {
                    "usedPercent": 40,
                    "windowDurationMins": 300,
                    "resetsAt": 1_785_000_000_i64
                },
                "secondary": {
                    "usedPercent": 12,
                    "windowDurationMins": 10080,
                    "resetsAt": 1_786_000_000_i64
                }
            }
        });
        let usage = parse_codex_rate_limits(&result);
        let session = usage.session.expect("session");
        let weekly = usage.weekly.expect("weekly");
        assert!((session.utilization - 40.0).abs() < 0.01);
        assert_eq!(session.window_minutes, Some(300));
        assert!((weekly.utilization - 12.0).abs() < 0.01);
        assert_eq!(weekly.window_minutes, Some(10080));
    }

    #[test]
    fn long_primary_ignores_zero_secondary_stub() {
        // Secondary present as an object but not a short window (5h removed).
        let result = json!({
            "rateLimits": {
                "primary": {
                    "usedPercent": 79,
                    "windowDurationMins": 10080
                },
                "secondary": {
                    "usedPercent": 0,
                    "windowDurationMins": 10080
                }
            }
        });
        let usage = parse_codex_rate_limits(&result);
        assert!(usage.session.is_none());
        let weekly = usage.weekly.expect("weekly");
        assert!((weekly.utilization - 79.0).abs() < 0.01);
    }

    #[test]
    fn reads_legacy_window_minutes_alias() {
        let result = json!({
            "primary": { "usedPercent": 10, "windowMinutes": 300 },
            "secondary": { "usedPercent": 5, "window_minutes": 10080 }
        });
        let usage = parse_codex_rate_limits(&result);
        assert_eq!(usage.session.as_ref().and_then(|w| w.window_minutes), Some(300));
        assert_eq!(usage.weekly.as_ref().and_then(|w| w.window_minutes), Some(10080));
    }
}

#[cfg(test)]
mod grok_usage_tests {
    use super::*;

    /// Live capture from GetGrokCreditsConfig (8% used, weekly reset).
    const SAMPLE_GRPC_WEB: &str = concat!(
        "000000005f0a5d0d0000004112001a00220c08f0a3c0d20610f8c1c0d303",
        "2a0c08f098e5d20610f8c1c0d3033a070802150000c0403a070804150000",
        "0040421e0802120c08f0a3c0d20610f8c1c0d3031a0c08f098e5d20610f8",
        "c1c0d303580162006801"
    );

    fn decode_hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn parses_grok_web_billing_sample() {
        let bytes = decode_hex(SAMPLE_GRPC_WEB);
        // Sample was captured while the weekly reset was still in the future.
        let snap = parse_grok_grpc_web_response_at(&bytes, 1_784_000_000).expect("parse sample");
        assert!((snap.used_percent - 8.0).abs() < 0.01, "got {}", snap.used_percent);
        assert_eq!(snap.resets_at_unix, Some(1_784_237_168));
        assert_eq!(snap.period_start_unix, Some(1_783_632_368));
    }

    #[test]
    fn empty_body_returns_none() {
        assert!(parse_grok_grpc_web_response(&[]).is_none());
    }
}

// ── Gemini / Antigravity Usage ────────────────────────────────
//
// Personal Gemini CLI OAuth no longer serves quota (June 2026 shutdown).
// Antigravity (`agy`) stores tokens in the macOS keychain
// (service=gemini, account=antigravity, go-keyring-base64 JSON) and the
// Cloud Code `retrieveUserQuotaSummary` endpoint returns the same weekly /
// 5-hour groups shown in Antigravity's Model Quota UI.

const GEMINI_WEEK_MINUTES: i64 = 7 * 24 * 60;
const GEMINI_SESSION_MINUTES: i64 = 5 * 60;
const ANTIGRAVITY_KEYCHAIN_SERVICE: &str = "gemini";
const ANTIGRAVITY_KEYCHAIN_ACCOUNT: &str = "antigravity";
const GO_KEYRING_PREFIX: &str = "go-keyring-base64:";
const ANTIGRAVITY_UA: &str = "antigravity";
const ANTIGRAVITY_QUOTA_HOSTS: &[&str] = &[
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
    "https://daily-cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
];

#[derive(Debug, Clone)]
struct AntigravityToken {
    access_token: String,
    refresh_token: Option<String>,
    expiry: Option<String>,
    token_type: String,
    auth_method: Option<String>,
}

fn antigravity_token_expired(token: &AntigravityToken) -> bool {
    let Some(expiry) = token.expiry.as_deref() else {
        return false;
    };
    let Ok(dt) = chrono::DateTime::parse_from_rfc3339(expiry) else {
        return true;
    };
    dt.with_timezone(&chrono::Utc) <= chrono::Utc::now() + chrono::Duration::seconds(60)
}

fn parse_antigravity_keychain_blob(raw: &str) -> Result<AntigravityToken, String> {
    let trimmed = raw.trim();
    let json_str = if let Some(b64) = trimmed.strip_prefix(GO_KEYRING_PREFIX) {
        let bytes = base64_decode(b64).map_err(|e| format!("Antigravity keychain blob: {e}"))?;
        String::from_utf8(bytes).map_err(|e| format!("Antigravity keychain blob is not UTF-8: {e}"))?
    } else {
        trimmed.to_string()
    };
    let root: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| format!("Antigravity keychain JSON: {e}"))?;
    parse_antigravity_token_json(&root)
}

fn parse_antigravity_token_json(root: &serde_json::Value) -> Result<AntigravityToken, String> {
    let auth_method = root
        .get("auth_method")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let token_obj = root.get("token").unwrap_or(root);
    let access_token = token_obj
        .get("access_token")
        .or_else(|| token_obj.get("accessToken"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Antigravity keychain entry has no access token".to_string())?
        .to_string();
    let refresh_token = token_obj
        .get("refresh_token")
        .or_else(|| token_obj.get("refreshToken"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let expiry = token_obj
        .get("expiry")
        .or_else(|| token_obj.get("expiry_date"))
        .or_else(|| token_obj.get("expiryDate"))
        .and_then(|v| {
            if let Some(s) = v.as_str() {
                Some(s.to_string())
            } else if let Some(n) = v.as_f64() {
                // Gemini CLI style: milliseconds since epoch.
                chrono::DateTime::<chrono::Utc>::from_timestamp((n / 1000.0) as i64, 0)
                    .map(|dt| dt.to_rfc3339())
            } else {
                None
            }
        });
    let token_type = token_obj
        .get("token_type")
        .or_else(|| token_obj.get("tokenType"))
        .and_then(|v| v.as_str())
        .unwrap_or("Bearer")
        .to_string();
    Ok(AntigravityToken {
        access_token,
        refresh_token,
        expiry,
        token_type,
        auth_method,
    })
}

fn encode_antigravity_keychain_blob(token: &AntigravityToken) -> Result<String, String> {
    let mut token_obj = serde_json::json!({
        "access_token": token.access_token,
        "token_type": token.token_type,
    });
    if let Some(refresh) = &token.refresh_token {
        token_obj["refresh_token"] = serde_json::Value::String(refresh.clone());
    }
    if let Some(expiry) = &token.expiry {
        token_obj["expiry"] = serde_json::Value::String(expiry.clone());
    }
    let mut root = serde_json::json!({ "token": token_obj });
    if let Some(method) = &token.auth_method {
        root["auth_method"] = serde_json::Value::String(method.clone());
    }
    let json = serde_json::to_vec(&root).map_err(|e| format!("Encode Antigravity token: {e}"))?;
    Ok(format!("{GO_KEYRING_PREFIX}{}", base64_encode(&json)))
}

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(s.trim()))
        .map_err(|e| e.to_string())
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

async fn read_antigravity_token() -> Result<AntigravityToken, String> {
    let output = tokio::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            ANTIGRAVITY_KEYCHAIN_SERVICE,
            "-a",
            ANTIGRAVITY_KEYCHAIN_ACCOUNT,
            "-w",
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to read Antigravity keychain: {e}"))?;
    if !output.status.success() {
        return Err(
            "Gemini (Antigravity) is not signed in. Run `agy` once to sign in.".to_string(),
        );
    }
    let raw = String::from_utf8_lossy(&output.stdout).to_string();
    parse_antigravity_keychain_blob(&raw)
}

async fn write_antigravity_token(token: &AntigravityToken) -> Result<(), String> {
    let blob = encode_antigravity_keychain_blob(token)?;
    let status = tokio::process::Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            ANTIGRAVITY_KEYCHAIN_SERVICE,
            "-a",
            ANTIGRAVITY_KEYCHAIN_ACCOUNT,
            "-w",
            &blob,
        ])
        .status()
        .await
        .map_err(|e| format!("Failed to update Antigravity keychain: {e}"))?;
    if !status.success() {
        return Err("Failed to update Antigravity keychain".to_string());
    }
    Ok(())
}

fn find_agy_binary() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("ANTIGRAVITY_CLI_PATH") {
        let pb = std::path::PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/bin/agy"));
    }
    candidates.push(std::path::PathBuf::from("/opt/homebrew/bin/agy"));
    candidates.push(std::path::PathBuf::from("/usr/local/bin/agy"));
    for path in candidates {
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

/// Client IDs and 35-char `GOCSPX-` secrets embedded in the `agy` binary.
fn extract_antigravity_oauth_from_bytes(bytes: &[u8]) -> (Vec<String>, Vec<String>) {
    let text = String::from_utf8_lossy(bytes);
    let id_re = regex::Regex::new(r"[0-9]{10,}-[a-z0-9]+\.apps\.googleusercontent\.com")
        .expect("oauth client-id regex");
    let secret_re = regex::Regex::new(r"GOCSPX-[A-Za-z0-9_-]{28}").expect("oauth secret regex");
    let mut ids = Vec::new();
    for m in id_re.find_iter(&text) {
        let id = m.as_str().to_string();
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let mut secrets = Vec::new();
    for m in secret_re.find_iter(&text) {
        let secret = m.as_str().to_string();
        if secret.len() == 35 && !secrets.contains(&secret) {
            secrets.push(secret);
        }
    }
    (ids, secrets)
}

async fn refresh_antigravity_token(token: &AntigravityToken) -> Result<AntigravityToken, String> {
    let refresh = token
        .refresh_token
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "Gemini (Antigravity) session expired. Run `agy` once to sign in.".to_string()
        })?;
    let agy = find_agy_binary().ok_or_else(|| {
        "Gemini (Antigravity) session expired and `agy` is not installed.".to_string()
    })?;
    let bytes = tokio::fs::read(&agy)
        .await
        .map_err(|e| format!("Failed to read agy binary: {e}"))?;
    let (ids, secrets) = extract_antigravity_oauth_from_bytes(&bytes);
    if ids.is_empty() || secrets.is_empty() {
        return Err("Could not find Antigravity OAuth client in the agy install.".to_string());
    }

    // Prefer the consumer Antigravity client id when present.
    let mut ordered_ids = ids.clone();
    ordered_ids.sort_by_key(|id| {
        if id.starts_with("1071006060591-") {
            0
        } else {
            1
        }
    });

    let client = reqwest::Client::new();
    let mut last_err = "Antigravity token refresh failed".to_string();
    for client_id in &ordered_ids {
        for client_secret in &secrets {
            let resp = client
                .post("https://oauth2.googleapis.com/token")
                .header("Content-Type", "application/x-www-form-urlencoded")
                .form(&[
                    ("client_id", client_id.as_str()),
                    ("client_secret", client_secret.as_str()),
                    ("refresh_token", refresh),
                    ("grant_type", "refresh_token"),
                ])
                .send()
                .await;
            let Ok(resp) = resp else {
                continue;
            };
            if !resp.status().is_success() {
                last_err = format!("Antigravity token refresh returned {}", resp.status());
                continue;
            }
            let body: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("Antigravity refresh JSON: {e}"))?;
            let access = body
                .get("access_token")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Antigravity refresh missing access_token".to_string())?;
            let expires_in = body.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(3600);
            let expiry = (chrono::Utc::now() + chrono::Duration::seconds(expires_in)).to_rfc3339();
            let token_type = body
                .get("token_type")
                .and_then(|v| v.as_str())
                .unwrap_or("Bearer")
                .to_string();
            let new_refresh = body
                .get("refresh_token")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| token.refresh_token.clone());
            return Ok(AntigravityToken {
                access_token: access.to_string(),
                refresh_token: new_refresh,
                expiry: Some(expiry),
                token_type,
                auth_method: token.auth_method.clone(),
            });
        }
    }
    Err(last_err)
}

fn remaining_fraction_from_bucket(bucket: &serde_json::Value) -> Option<f64> {
    bucket
        .get("remainingFraction")
        .and_then(|v| v.as_f64().or_else(|| v.as_i64().map(|n| n as f64)))
        .or_else(|| {
            bucket
                .get("remaining")
                .and_then(|r| r.get("remainingFraction"))
                .and_then(|v| v.as_f64().or_else(|| v.as_i64().map(|n| n as f64)))
        })
}

fn quota_bucket_kind(bucket: &serde_json::Value) -> Option<&'static str> {
    let id = bucket
        .get("bucketId")
        .or_else(|| bucket.get("bucket_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let window = bucket
        .get("window")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let display = bucket
        .get("displayName")
        .or_else(|| bucket.get("display_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let blob = format!("{id} {window} {display}");
    if blob.contains("weekly") {
        return Some("weekly");
    }
    if blob.contains("5h")
        || blob.contains("5-hour")
        || blob.contains("five hour")
        || blob.contains("five-hour")
        || blob.contains("session")
    {
        return Some("session");
    }
    None
}

fn is_gemini_quota_group(group: &serde_json::Value) -> bool {
    group
        .get("displayName")
        .or_else(|| group.get("display_name"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_ascii_lowercase().contains("gemini"))
        .unwrap_or(false)
}

fn window_from_quota_bucket(bucket: &serde_json::Value, default_minutes: i64) -> Option<UsageWindow> {
    let remaining = remaining_fraction_from_bucket(bucket)?;
    let utilization = ((1.0 - remaining) * 100.0).clamp(0.0, 100.0);
    let resets_at = bucket
        .get("resetTime")
        .or_else(|| bucket.get("reset_time"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Some(UsageWindow {
        utilization,
        resets_at,
        window_minutes: Some(default_minutes),
    })
}

/// Map `retrieveUserQuotaSummary` groups onto session (5-hour) + weekly.
/// Only the Gemini family drives those two slots — Claude/GPT pools are a
/// separate Antigravity entitlement and are not shown as Gemini usage.
fn parse_gemini_quota_summary(root: &serde_json::Value) -> UsageData {
    let groups = root
        .get("groups")
        .or_else(|| root.get("response").and_then(|r| r.get("groups")))
        .and_then(|v| v.as_array());
    let Some(groups) = groups else {
        return UsageData::default();
    };

    let mut session: Option<UsageWindow> = None;
    let mut weekly: Option<UsageWindow> = None;
    for group in groups {
        if !is_gemini_quota_group(group) {
            continue;
        }
        let Some(buckets) = group.get("buckets").and_then(|v| v.as_array()) else {
            continue;
        };
        for bucket in buckets {
            match quota_bucket_kind(bucket) {
                Some("session") => {
                    if let Some(w) = window_from_quota_bucket(bucket, GEMINI_SESSION_MINUTES) {
                        session = match session {
                            Some(prev) if prev.utilization >= w.utilization => Some(prev),
                            _ => Some(w),
                        };
                    }
                }
                Some("weekly") => {
                    if let Some(w) = window_from_quota_bucket(bucket, GEMINI_WEEK_MINUTES) {
                        weekly = match weekly {
                            Some(prev) if prev.utilization >= w.utilization => Some(prev),
                            _ => Some(w),
                        };
                    }
                }
                _ => {}
            }
        }
    }

    UsageData {
        session,
        weekly,
        ..UsageData::default()
    }
}

async fn antigravity_quota_request(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<serde_json::Value, String> {
    let mut last_err = "Gemini quota API failed".to_string();
    for host in ANTIGRAVITY_QUOTA_HOSTS {
        let url = format!("{host}/v1internal:retrieveUserQuotaSummary");
        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {access_token}"))
            .header("User-Agent", ANTIGRAVITY_UA)
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({}))
            .send()
            .await;
        let Ok(resp) = resp else {
            continue;
        };
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err("unauthorized".to_string());
        }
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err("Rate limited — try again shortly".to_string());
        }
        if !status.is_success() {
            last_err = format!("Gemini quota API returned {status}");
            continue;
        }
        return resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse Gemini quota response: {e}"));
    }
    Err(last_err)
}

#[tauri::command]
pub async fn fetch_gemini_usage() -> Result<UsageData, String> {
    let mut token = read_antigravity_token().await?;
    if antigravity_token_expired(&token) {
        token = refresh_antigravity_token(&token).await?;
        let _ = write_antigravity_token(&token).await;
    }

    let client = reqwest::Client::new();
    let data = match antigravity_quota_request(&client, &token.access_token).await {
        Ok(data) => data,
        Err(err) if err == "unauthorized" => {
            token = refresh_antigravity_token(&token).await?;
            let _ = write_antigravity_token(&token).await;
            antigravity_quota_request(&client, &token.access_token).await?
        }
        Err(err) => return Err(err),
    };

    let usage = parse_gemini_quota_summary(&data);
    if usage.session.is_none() && usage.weekly.is_none() {
        return Err("Gemini quota API returned no usage windows".to_string());
    }
    Ok(usage)
}

#[cfg(test)]
mod gemini_usage_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_weekly_only_gemini_group() {
        let root = json!({
            "groups": [
                {
                    "displayName": "Gemini Models",
                    "buckets": [
                        {
                            "bucketId": "gemini-weekly",
                            "displayName": "Weekly Limit Remaining",
                            "window": "weekly",
                            "resetTime": "2026-09-09T20:41:56Z",
                            "remainingFraction": 0.9892
                        }
                    ]
                },
                {
                    "displayName": "Claude and GPT models",
                    "buckets": [
                        {
                            "bucketId": "3p-weekly",
                            "window": "weekly",
                            "remainingFraction": 1,
                            "resetTime": "2026-09-09T20:48:00Z"
                        }
                    ]
                }
            ]
        });
        let usage = parse_gemini_quota_summary(&root);
        assert!(usage.session.is_none(), "no 5-hour bucket → no session bar");
        let weekly = usage.weekly.expect("gemini weekly");
        assert!((weekly.utilization - 1.08).abs() < 0.02, "got {}", weekly.utilization);
        assert_eq!(weekly.window_minutes, Some(GEMINI_WEEK_MINUTES));
        assert_eq!(weekly.resets_at.as_deref(), Some("2026-09-09T20:41:56Z"));
    }

    #[test]
    fn parses_session_and_weekly_from_wrapped_response() {
        let root = json!({
            "response": {
                "groups": [
                    {
                        "displayName": "Gemini Models",
                        "buckets": [
                            {
                                "bucketId": "gemini-weekly",
                                "displayName": "Weekly Limit",
                                "window": "weekly",
                                "remainingFraction": 0.958,
                                "resetTime": "2026-07-30T12:05:10Z"
                            },
                            {
                                "bucketId": "gemini-5h",
                                "displayName": "Five Hour Limit",
                                "window": "5h",
                                "remaining": { "remainingFraction": 0.749 },
                                "resetTime": "2026-07-23T17:05:10Z"
                            }
                        ]
                    }
                ]
            }
        });
        let usage = parse_gemini_quota_summary(&root);
        let session = usage.session.expect("5h");
        let weekly = usage.weekly.expect("weekly");
        assert!((session.utilization - 25.1).abs() < 0.05, "got {}", session.utilization);
        assert_eq!(session.window_minutes, Some(GEMINI_SESSION_MINUTES));
        assert!((weekly.utilization - 4.2).abs() < 0.05, "got {}", weekly.utilization);
        assert_eq!(weekly.window_minutes, Some(GEMINI_WEEK_MINUTES));
    }

    #[test]
    fn ignores_claude_gpt_pool() {
        let root = json!({
            "groups": [{
                "displayName": "Claude and GPT models",
                "buckets": [{
                    "bucketId": "3p-5h",
                    "window": "5h",
                    "remainingFraction": 0.1
                }]
            }]
        });
        let usage = parse_gemini_quota_summary(&root);
        assert!(usage.session.is_none());
        assert!(usage.weekly.is_none());
    }

    #[test]
    fn empty_groups_yield_empty_usage() {
        let usage = parse_gemini_quota_summary(&json!({ "groups": [] }));
        assert!(usage.session.is_none());
        assert!(usage.weekly.is_none());
    }

    #[test]
    fn extracts_oauth_client_from_agy_bytes() {
        let hay = b"noise 1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com \
                     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https://cloudcode-pa.googleapis.com";
        let (ids, secrets) = extract_antigravity_oauth_from_bytes(hay);
        assert!(ids.iter().any(|id| id.starts_with("1071006060591-")));
        assert!(secrets.iter().any(|s| s.len() == 35 && s.starts_with("GOCSPX-")));
    }

    #[test]
    fn keychain_blob_roundtrip() {
        let token = AntigravityToken {
            access_token: "ya29.test".into(),
            refresh_token: Some("1//refresh".into()),
            expiry: Some("2026-09-02T21:00:00+00:00".into()),
            token_type: "Bearer".into(),
            auth_method: Some("consumer".into()),
        };
        let blob = encode_antigravity_keychain_blob(&token).unwrap();
        assert!(blob.starts_with(GO_KEYRING_PREFIX));
        let parsed = parse_antigravity_keychain_blob(&blob).unwrap();
        assert_eq!(parsed.access_token, "ya29.test");
        assert_eq!(parsed.refresh_token.as_deref(), Some("1//refresh"));
        assert_eq!(parsed.auth_method.as_deref(), Some("consumer"));
    }
}
