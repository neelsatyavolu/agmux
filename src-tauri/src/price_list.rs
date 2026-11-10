//! agterm's shared price list (`prices.json` at the root of the agterm repo), so a new
//! model gets a price without an agmux update. Its rows win over the table in
//! `usage_stats::model_pricing`; cached on disk for 24h.
//!
//! ```json
//! {"version": 1, "updated": "2026-11-09", "models": [
//!   {"ids": ["claude-fable-5-2"], "input": 8, "output": 40, "cacheRead": 0.2, "cacheWrite": 10}]}
//! ```
//! USD per million tokens; `cacheWrite` is Claude's 5-minute write rate.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

const PRICE_LIST_URL: &str = "https://raw.githubusercontent.com/neelsatyavolu/agterm/main/prices.json";
const CACHE_TTL: Duration = Duration::from_secs(24 * 3600);
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

/// `(input, output, cache read, cache write)` per million tokens, by pricing key.
pub(crate) type Rates = (f64, f64, f64, f64);

/// The loaded list and when its file was written.
static LISTED: Mutex<Option<(SystemTime, HashMap<String, Rates>)>> = Mutex::new(None);

fn cache_path() -> Option<PathBuf> {
    crate::paths::agmux_home_opt().map(|h| h.join("pricing").join("prices.json"))
}

/// The listed rates for a model, keyed as `usage_stats::model_pricing` keys it.
pub(crate) fn lookup(key: &str) -> Option<Rates> {
    let guard = LISTED.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref().and_then(|(_, rates)| rates.get(key).copied())
}

/// Loads the cached list, and downloads it again when it is older than a day.
/// A failed download keeps the cached list; a malformed one is never stored.
pub async fn ensure_fresh() {
    let Some(path) = cache_path() else { return };
    let written = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
    let stale = written
        .map(|t| SystemTime::now().duration_since(t).map(|d| d >= CACHE_TTL).unwrap_or(true))
        .unwrap_or(true);
    if stale {
        match fetch().await {
            Ok(body) => {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&path, body);
            }
            Err(e) => tracing::warn!(error = %e, "price list refresh failed; keeping the cached list"),
        }
    }
    let Ok(modified) = std::fs::metadata(&path).and_then(|m| m.modified()) else { return };
    let mut guard = LISTED.lock().unwrap_or_else(|e| e.into_inner());
    if guard.as_ref().is_some_and(|(at, _)| *at == modified) {
        return;
    }
    if let Some(rates) = std::fs::read_to_string(&path).ok().and_then(|raw| parse(&raw).ok()) {
        *guard = Some((modified, rates));
    }
}

async fn fetch() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent("agmux-price-list/1.0")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(PRICE_LIST_URL).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("price list HTTP {}", resp.status()));
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    parse(&body)?;
    Ok(body)
}

/// Pricing key to rates. Any malformed row rejects the whole list, so a broken
/// file never zeroes a price.
pub(crate) fn parse(raw: &str) -> Result<HashMap<String, Rates>, String> {
    let root: serde_json::Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    if root.get("version").and_then(|v| v.as_u64()) != Some(1) {
        return Err("unsupported price list version".into());
    }
    let rows = root.get("models").and_then(|m| m.as_array()).ok_or("no models")?;
    let mut out = HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        let price = |key: &str| {
            row.get(key)
                .and_then(|v| v.as_f64())
                .filter(|v| v.is_finite() && *v >= 0.0)
                .ok_or(format!("row {index}: bad {key}"))
        };
        let rates = (price("input")?, price("output")?, price("cacheRead")?, price("cacheWrite")?);
        let ids: Vec<&str> = row
            .get("ids")
            .and_then(|v| v.as_array())
            .map(|ids| ids.iter().filter_map(|id| id.as_str()).collect())
            .unwrap_or_default();
        if ids.is_empty() {
            return Err(format!("row {index}: no ids"));
        }
        for id in ids {
            out.insert(crate::commands::usage_stats::pricing_model_key(id), rates);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rows_under_pricing_keys() {
        let rates = parse(r#"{"version":1,"models":[{"ids":["claude-fable-5-2","anthropic/claude-mythos-5.2"],
            "input":8,"output":40,"cacheRead":0.2,"cacheWrite":10}]}"#).unwrap();
        assert_eq!(rates.get("claude-fable-5-2"), Some(&(8.0, 40.0, 0.2, 10.0)));
        assert_eq!(rates.get("claude-mythos-5-2"), Some(&(8.0, 40.0, 0.2, 10.0)));
    }

    #[test]
    fn rejects_bad_lists() {
        for body in [
            "[]",
            r#"{"version":2,"models":[]}"#,
            r#"{"version":1}"#,
            r#"{"version":1,"models":[{"ids":["x"],"input":-1,"output":1,"cacheRead":0,"cacheWrite":0}]}"#,
            r#"{"version":1,"models":[{"ids":[],"input":1,"output":1,"cacheRead":0,"cacheWrite":0}]}"#,
            r#"{"version":1,"models":[{"ids":["x"],"input":"1","output":1,"cacheRead":0,"cacheWrite":0}]}"#,
        ] {
            assert!(parse(body).is_err(), "{body}");
        }
    }

    #[test]
    fn agterm_price_list_parses() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../agterm/prices.json");
        let Ok(raw) = std::fs::read_to_string(path) else { return };
        let rates = parse(&raw).unwrap();
        assert_eq!(rates.get("claude-fable-5-2"), Some(&(8.0, 40.0, 0.2, 10.0)));
    }
}
