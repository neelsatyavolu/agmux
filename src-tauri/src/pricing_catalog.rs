//! Live model pricing catalog (OpenRouter), with a 24h on-disk cache.
//!
//! Used only when the hard-coded table in `usage_stats::model_pricing` has no
//! match. Missing rates stay unknown; lookup misses never establish free usage.
//!
//! Source: `GET https://openrouter.ai/api/v1/models` (no API key required for
//! the public list). Prices are USD per token; we store $/MTok.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const OPENROUTER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
const CACHE_TTL: Duration = Duration::from_secs(24 * 3600);
const CACHE_VERSION: u32 = 2;
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

/// Per-million-token rates (same shape as usage_stats::ModelPricing).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct CatalogPricing {
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    pub cache_read_per_mtok: Option<f64>,
    pub cache_write_per_mtok: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CatalogEntry {
    /// Full OpenRouter id, e.g. `anthropic/claude-sonnet-4.5`.
    id: String,
    /// Segment after `/`, lowercased.
    slug: String,
    bare_ambiguous: bool,
    pricing: CatalogPricing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DiskCache {
    // Old caches contain fabricated cache rates and cannot be reused.
    version: u32,
    /// Unix seconds when fetched.
    fetched_at: u64,
    entries: Vec<CatalogEntry>,
}

struct CatalogState {
    fetched_at: SystemTime,
    revision_key: u64,
    by_id: HashMap<String, Option<CatalogPricing>>,
    // None means multiple full IDs have the same bare slug; never pick one.
    by_slug: HashMap<String, Option<CatalogPricing>>,
}

static CATALOG: Mutex<Option<CatalogState>> = Mutex::new(None);

fn cache_path() -> Option<PathBuf> {
    crate::paths::agmux_home_opt().map(|h| h.join("pricing").join("openrouter_models.json"))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Ensure the in-memory catalog is loaded and younger than 24h.
/// Loads disk cache first; fetches OpenRouter only when stale/missing.
pub async fn ensure_fresh() {
    if catalog_is_fresh() {
        return;
    }
    // Try disk before network.
    if load_disk_into_memory() && catalog_is_fresh() {
        return;
    }
    if let Err(e) = fetch_and_store().await {
        tracing::warn!(error = %e, "openrouter pricing catalog refresh failed; expired rates remain unavailable");
        // Last resort: load stale disk if memory empty.
        let _ = load_disk_into_memory();
    }
}

fn catalog_is_fresh() -> bool {
    let guard = CATALOG.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .as_ref()
        .map(|c| {
            SystemTime::now()
                .duration_since(c.fetched_at)
                .map(|d| d < CACHE_TTL)
                .unwrap_or(false)
                && !c.by_slug.is_empty()
        })
        .unwrap_or(false)
}

fn load_disk_into_memory() -> bool {
    let Some(path) = cache_path() else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return false;
    };
    let Ok(disk) = serde_json::from_str::<DiskCache>(&raw) else {
        return false;
    };
    if disk.version != CACHE_VERSION { return false; }
    let state = build_state(disk.fetched_at, disk.entries);
    if state.by_slug.is_empty() {
        return false;
    }
    if let Ok(mut guard) = CATALOG.lock() {
        *guard = Some(state);
        true
    } else {
        false
    }
}

async fn fetch_and_store() -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent("agmux-pricing-catalog/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(OPENROUTER_MODELS_URL)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("openrouter HTTP {}", resp.status()));
    }
    let body: OpenRouterResponse = resp.json().await.map_err(|e| e.to_string())?;
    let entries = parse_openrouter_models(body.data);
    if entries.is_empty() {
        return Err("openrouter returned zero priced models".into());
    }

    let fetched_at = now_secs();
    let disk = DiskCache {
        version: CACHE_VERSION,
        fetched_at,
        entries: entries.clone(),
    };
    if let Some(path) = cache_path() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string(&disk) {
            let _ = std::fs::write(path, json);
        }
    }

    let state = build_state(fetched_at, entries);
    if let Ok(mut guard) = CATALOG.lock() {
        *guard = Some(state);
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct OpenRouterResponse {
    data: Vec<OpenRouterModel>,
}

#[derive(Debug, Deserialize)]
struct OpenRouterModel {
    id: String,
    #[serde(default)]
    pricing: Option<OpenRouterPricing>,
}

#[derive(Debug, Deserialize)]
struct OpenRouterPricing {
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    completion: Option<String>,
    #[serde(default)]
    input_cache_read: Option<String>,
    #[serde(default)]
    input_cache_write: Option<String>,
    #[serde(default)]
    overrides: Option<serde_json::Value>,
}

fn parse_token_price(s: &str) -> Option<f64> {
    let v: f64 = s.trim().parse().ok()?;
    if !v.is_finite() || v < 0.0 {
        return None;
    }
    // OpenRouter: USD per token → $/MTok
    let per_mtok = v * 1_000_000.0;
    per_mtok.is_finite().then_some(per_mtok)
}

fn parse_openrouter_models(models: Vec<OpenRouterModel>) -> Vec<CatalogEntry> {
    let mut out = Vec::with_capacity(models.len());
    let mut slug_counts = HashMap::new();
    let mut id_counts = HashMap::new();
    // Unpriceable rows still participate in identity ambiguity detection.
    for m in &models {
        let id = m.id.trim().to_ascii_lowercase();
        *slug_counts.entry(id.rsplit('/').next().unwrap_or(&id).to_string()).or_insert(0) += 1;
        *id_counts.entry(id).or_insert(0) += 1;
    }
    for m in models {
        if id_counts.get(&m.id.trim().to_ascii_lowercase()) != Some(&1) { continue; }
        let Some(p) = m.pricing else { continue };
        // The caller has no request instant or override evaluator. Returning
        // the base rate for a conditional tariff could underprice the request.
        if p.overrides.as_ref().is_some_and(|v| !v.is_null() && v.as_array().is_none_or(|a| !a.is_empty())) {
            continue;
        }
        let Some(input) = p.prompt.as_deref().and_then(parse_token_price) else {
            continue;
        };
        let Some(output) = p.completion.as_deref().and_then(parse_token_price) else {
            continue;
        };
        // Absent, null or invalid optional prices are unknown, not zero.
        let cache_read = p
            .input_cache_read
            .as_deref()
            .and_then(parse_token_price);
        let cache_write = p
            .input_cache_write
            .as_deref()
            .and_then(parse_token_price);

        let slug = m
            .id
            .rsplit('/')
            .next()
            .unwrap_or(&m.id)
            .to_ascii_lowercase();
        // Skip empty / router-only noise.
        if slug.is_empty() || slug == "free" {
            continue;
        }
        out.push(CatalogEntry {
            id: m.id,
            bare_ambiguous: slug_counts.get(&slug).copied().unwrap_or(0) > 1,
            slug,
            pricing: CatalogPricing {
                input_per_mtok: input,
                output_per_mtok: output,
                cache_read_per_mtok: cache_read,
                cache_write_per_mtok: cache_write,
            },
        });
    }
    out
}

fn build_state(fetched_at_secs: u64, entries: Vec<CatalogEntry>) -> CatalogState {
    let fetched_at = UNIX_EPOCH.checked_add(Duration::from_secs(fetched_at_secs))
        .unwrap_or(UNIX_EPOCH);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    fetched_at_secs.hash(&mut hasher);
    // Stable for disk reload, but changes with prices even within one second.
    // Include missing-vs-zero coverage and identity ambiguity, not just amounts.
    for e in &entries {
        e.id.hash(&mut hasher);
        e.bare_ambiguous.hash(&mut hasher);
        e.pricing.input_per_mtok.to_bits().hash(&mut hasher);
        e.pricing.output_per_mtok.to_bits().hash(&mut hasher);
        e.pricing.cache_read_per_mtok.map(f64::to_bits).hash(&mut hasher);
        e.pricing.cache_write_per_mtok.map(f64::to_bits).hash(&mut hasher);
    }
    let revision_key = hasher.finish();
    let mut by_id = HashMap::new();
    let mut by_slug = HashMap::new();
    for e in entries {
        let id = e.id.trim().to_ascii_lowercase();
        let slug = id.rsplit('/').next().unwrap_or(&id).to_string();
        // Ambiguous slugs remain unavailable even when the prices coincide.
        by_slug.entry(slug).and_modify(|p| *p = None)
            .or_insert(if e.bare_ambiguous { None } else { Some(e.pricing) });
        by_id.entry(id).and_modify(|p| *p = None).or_insert(Some(e.pricing));
    }
    CatalogState { fetched_at, revision_key, by_id, by_slug }
}

impl CatalogState {
    fn cache_key(&self) -> (u64, bool) {
        (self.revision_key, SystemTime::now().duration_since(self.fetched_at)
            .is_ok_and(|age| age < CACHE_TTL))
    }

    fn lookup(&self, model: &str) -> Option<CatalogPricing> {
        if SystemTime::now().duration_since(self.fetched_at).ok()? >= CACHE_TTL {
            return None;
        }
        let key = model.trim().to_ascii_lowercase();
        if key.contains('/') {
            self.by_id.get(&key).copied().flatten()
        } else {
            self.by_slug.get(&key).copied().flatten()
        }
    }
}

/// Stamp for caches containing computed prices. The freshness bit flips on
/// expiry; reloading the same snapshot preserves the content revision.
pub fn cache_key() -> (u64, bool) {
    #[cfg(test)]
    if let Some(key) = TEST_CATALOG.with(|slot| slot.borrow().as_ref()
        .map(|cat| cat.as_ref().map_or((0, false), CatalogState::cache_key))) {
        return key;
    }
    CATALOG.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
        .map_or((0, false), CatalogState::cache_key)
}

/// Exact full ID or unambiguous exact bare slug only. No guessed provider,
/// punctuation, date, pro/fast, free/batch or substring equivalence.
pub fn lookup(model: &str) -> Option<CatalogPricing> {
    #[cfg(test)]
    if let Some(result) = TEST_CATALOG.with(|slot| slot.borrow().as_ref()
        .map(|cat| cat.as_ref().and_then(|cat| cat.lookup(model)))) {
        return result;
    }
    CATALOG.lock().unwrap_or_else(|e| e.into_inner()).as_ref()?.lookup(model)
}

// Test overrides must not race with another pricing test or real scanner.
#[cfg(test)]
thread_local! {
    static TEST_CATALOG: std::cell::RefCell<Option<Option<CatalogState>>> = const { std::cell::RefCell::new(None) };
}

/// Inject a thread-local catalog for unit tests; never writes disk.
#[cfg(test)]
pub fn test_set_catalog(entries: Vec<(String, CatalogPricing)>) {
    let entries = entries.into_iter().map(|(id, pricing)| CatalogEntry {
        slug: id.rsplit('/').next().unwrap_or(&id).to_string(), bare_ambiguous: false, id, pricing,
    }).collect();
    TEST_CATALOG.with(|slot| *slot.borrow_mut() = Some(Some(build_state(now_secs(), entries))));
}

#[cfg(test)]
pub fn test_clear_catalog() {
    TEST_CATALOG.with(|slot| *slot.borrow_mut() = Some(None));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_cache_rates_are_unknown_in_serialized_catalog() {
        let rows: Vec<OpenRouterModel> = serde_json::from_value(serde_json::json!([
            {"id":"vendor/example", "pricing":{"prompt":"0.000003","completion":"0.000015"}}
        ])).unwrap();
        let entries = parse_openrouter_models(rows);
        let price = serde_json::to_value(entries[0].pricing).unwrap();
        assert!(price["cache_read_per_mtok"].is_null());
        assert!(price["cache_write_per_mtok"].is_null());
    }

    #[test]
    fn numeric_overflow_is_not_a_price() {
        assert!(parse_token_price("1e308").is_none());
    }

    #[test]
    #[ignore = "requires an explicitly supplied public Models API snapshot"]
    fn live_public_catalog_preserves_optional_rate_coverage() {
        let path = std::env::var("AGMUX_PRICING_AUDIT_FILE").unwrap();
        let raw = std::fs::read_to_string(path).unwrap();
        let source: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let response: OpenRouterResponse = serde_json::from_str(&raw).unwrap();
        let total = response.data.len();
        let entries = parse_openrouter_models(response.data);
        assert!(!entries.is_empty());
        let mut missing_read = 0;
        let mut missing_write = 0;
        for e in &entries {
            let row = source["data"].as_array().unwrap().iter()
                .find(|row| row["id"].as_str() == Some(e.id.as_str())).unwrap();
            if row["pricing"].get("input_cache_read").is_none() {
                assert!(e.pricing.cache_read_per_mtok.is_none());
                missing_read += 1;
            }
            if row["pricing"].get("input_cache_write").is_none() {
                assert!(e.pricing.cache_write_per_mtok.is_none());
                missing_write += 1;
            }
        }
        eprintln!("public models={total}, unconditional entries={}, missing read={missing_read}, missing write={missing_write}", entries.len());
    }

    fn fixture_state(rows: serde_json::Value) -> CatalogState {
        let models = serde_json::from_value(rows).unwrap();
        build_state(now_secs(), parse_openrouter_models(models))
    }

    #[test]
    fn exact_namespaces_variants_and_collisions() {
        let cat = fixture_state(serde_json::json!([
            {"id":"a/model", "pricing":{"prompt":"0.000001","completion":"0.000002"}},
            {"id":"b/model", "pricing":{"prompt":"0.000003","completion":"0.000004"}},
            {"id":"a/model-pro", "pricing":{"prompt":"0.000005","completion":"0.000006"}},
            {"id":"a/model-fast", "pricing":{"prompt":"0.000007","completion":"0.000008"}},
            {"id":"a/model.1", "pricing":{"prompt":"0.000001","completion":"0.000002"}}
        ]));
        assert_eq!(cat.lookup("a/model").unwrap().input_per_mtok, 1.0);
        assert_eq!(cat.lookup("b/model").unwrap().input_per_mtok, 3.0);
        assert_eq!(cat.lookup("model-pro").unwrap().input_per_mtok, 5.0);
        assert_eq!(cat.lookup(" A/MODEL-FAST ").unwrap().input_per_mtok, 7.0);
        for name in ["model", "c/model", "model-1", "model-pro-20260801", "model:free", "model:batch"] {
            assert!(cat.lookup(name).is_none(), "{name}");
        }
    }

    #[test]
    fn zero_invalid_missing_and_conditional_rates_stay_distinct() {
        let cat = fixture_state(serde_json::json!([
            {"id":"a/zero", "pricing":{"prompt":"0", "completion":"0", "input_cache_read":"0", "input_cache_write":"0"}},
            {"id":"a/missing", "pricing":{"prompt":"0.000001", "completion":"0.000002", "input_cache_read":null, "input_cache_write":"NaN"}},
            {"id":"a/tiered", "pricing":{"prompt":"0.000001", "completion":"0.000002", "overrides":[{"min_prompt_tokens":200000,"prompt":"0.000004"}]}}
        ]));
        assert_eq!(cat.lookup("zero").unwrap().cache_read_per_mtok, Some(0.0));
        assert_eq!(cat.lookup("missing").unwrap().cache_read_per_mtok, None);
        assert_eq!(cat.lookup("missing").unwrap().cache_write_per_mtok, None);
        assert!(cat.lookup("tiered").is_none());
    }

    #[test]
    fn stale_future_and_old_fabricated_caches_are_unavailable() {
        let mut cat = fixture_state(serde_json::json!([
            {"id":"a/model", "pricing":{"prompt":"0.000001","completion":"0.000002"}}
        ]));
        cat.fetched_at = SystemTime::now() - CACHE_TTL;
        assert!(cat.lookup("model").is_none());
        cat.fetched_at = SystemTime::now() + Duration::from_secs(60);
        assert!(cat.lookup("model").is_none());
        // Version is required: old optional rates were fabricated before save.
        assert!(serde_json::from_value::<DiskCache>(serde_json::json!({
            "fetched_at": 1, "entries": []
        })).is_err());
    }

    #[test]
    fn unpriceable_rows_still_make_bare_names_ambiguous() {
        let cat = fixture_state(serde_json::json!([
            {"id":"a/model", "pricing":{"prompt":"0.000001","completion":"0.000002"}},
            {"id":"b/model", "pricing":null}
        ]));
        assert!(cat.lookup("model").is_none());
        assert!(cat.lookup("a/model").is_some());
    }

    #[test]
    fn cache_key_tracks_price_coverage_and_expiry_not_reload() {
        let rows = serde_json::json!([
            {"id":"a/model", "pricing":{"prompt":"0.000001","completion":"0.000002"}}
        ]);
        let entries = parse_openrouter_models(serde_json::from_value(rows).unwrap());
        let timestamp = now_secs();
        let cat = build_state(timestamp, entries.clone());
        assert_eq!(cat.cache_key(), build_state(timestamp, entries.clone()).cache_key());
        assert!(cat.cache_key().1);
        let mut changed = entries.clone();
        changed[0].pricing.input_per_mtok = 3.0;
        assert_ne!(cat.cache_key().0, build_state(timestamp, changed).cache_key().0);
        let mut coverage = entries.clone();
        coverage[0].pricing.cache_read_per_mtok = Some(0.0);
        assert_ne!(cat.cache_key().0, build_state(timestamp, coverage).cache_key().0);
        let mut expiring = build_state(timestamp, entries.clone());
        let revision = expiring.cache_key().0;
        expiring.fetched_at = SystemTime::now() - CACHE_TTL;
        assert_eq!(expiring.cache_key(), (revision, false));
        let old = timestamp - CACHE_TTL.as_secs() - 1;
        assert_eq!(build_state(old, entries.clone()).cache_key(), build_state(old, entries).cache_key());
    }

    #[test]
    fn test_seed_cache_key_changes_without_clock_advance() {
        let mut price = CatalogPricing { input_per_mtok: 1.0, output_per_mtok: 2.0,
            cache_read_per_mtok: None, cache_write_per_mtok: None };
        test_set_catalog(vec![("a/model".into(), price)]);
        let before = cache_key();
        price.input_per_mtok = 2.0;
        test_set_catalog(vec![("a/model".into(), price)]);
        assert_ne!(before, cache_key());
        test_clear_catalog();
        assert_eq!(cache_key(), (0, false));
    }

    #[test]
    fn duplicate_full_ids_are_not_order_dependent() {
        let cat = fixture_state(serde_json::json!([
            {"id":"a/model", "pricing":{"prompt":"0.000001","completion":"0.000002"}},
            {"id":"a/model", "pricing":{"prompt":"0.000003","completion":"0.000004"}}
        ]));
        assert!(cat.lookup("a/model").is_none());
        assert!(cat.lookup("model").is_none());
    }

    #[test]
    fn parse_token_price_to_mtok() {
        // $3 / MTok = 0.000003 per token
        assert!((parse_token_price("0.000003").unwrap() - 3.0).abs() < 1e-9);
        assert!((parse_token_price("0.000015").unwrap() - 15.0).abs() < 1e-9);
    }

    #[test]
    fn parse_openrouter_keeps_batch_and_free_as_distinct_ids() {
        let models = vec![
            OpenRouterModel {
                id: "anthropic/claude-sonnet-4.5".into(),
                pricing: Some(OpenRouterPricing {
                    prompt: Some("0.000003".into()),
                    completion: Some("0.000015".into()),
                    input_cache_read: Some("0.0000003".into()),
                    input_cache_write: Some("0.00000375".into()),
                    overrides: None,
                }),
            },
            OpenRouterModel {
                id: "anthropic/claude-sonnet-4.5:batch".into(),
                pricing: Some(OpenRouterPricing {
                    prompt: Some("0.0000015".into()),
                    completion: Some("0.0000075".into()),
                    input_cache_read: None,
                    input_cache_write: None,
                    overrides: None,
                }),
            },
            OpenRouterModel {
                id: "meta-llama/llama-3.3-70b-instruct:free".into(),
                pricing: Some(OpenRouterPricing {
                    prompt: Some("0".into()),
                    completion: Some("0".into()),
                    input_cache_read: None,
                    input_cache_write: None,
                    overrides: None,
                }),
            },
        ];
        let entries = parse_openrouter_models(models);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].slug, "claude-sonnet-4.5");
        let cat = build_state(now_secs(), entries.clone());
        assert_eq!(cat.lookup("anthropic/claude-sonnet-4.5:batch").unwrap().input_per_mtok, 1.5);
        assert_eq!(cat.lookup("meta-llama/llama-3.3-70b-instruct:free").unwrap().input_per_mtok, 0.0);
        assert!(cat.lookup("llama-3.3-70b-instruct").is_none());
        assert!((entries[0].pricing.input_per_mtok - 3.0).abs() < 1e-9);
        assert!((entries[0].pricing.cache_read_per_mtok.unwrap() - 0.3).abs() < 1e-9);
    }

    #[test]
    fn lookup_exact_without_guessed_snapshot() {
        test_set_catalog(vec![(
            "claude-fable-5".into(),
            CatalogPricing {
                input_per_mtok: 10.0,
                output_per_mtok: 50.0,
                cache_read_per_mtok: Some(1.0),
                cache_write_per_mtok: Some(12.5),
            },
        )]);
        let p = lookup("claude-fable-5").unwrap();
        assert_eq!(p.input_per_mtok, 10.0);
        // Fuzzy with extra suffix noise
        assert!(lookup("claude-fable-5-20260601").is_none());
        test_clear_catalog();
    }

    #[test]
    fn lookup_empty_is_none() {
        test_set_catalog(vec![]);
        assert!(lookup("").is_none());
        assert!(lookup("totally-unknown-xyz-999").is_none());
        test_clear_catalog();
    }
}
