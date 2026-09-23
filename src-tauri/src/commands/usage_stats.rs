use crate::db::queries::{accumulate_session_usage, record_session_usage};
use crate::state::AppState;
use chrono::{DateTime, Duration, TimeZone, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::time::{Duration as StdDuration, Instant};
use tauri::State;
use walkdir::WalkDir;

const SCAN_CACHE_TTL: StdDuration = StdDuration::from_secs(12 * 3600);

/// Longest gap between two usage events that still counts as the agent working.
/// Matches Teams `ACTIVE_GAP_CAP` so Usage and Teams report the same "active
/// time" (idle / coffee breaks are not counted past this cap).
const ACTIVE_GAP_CAP: Duration = Duration::minutes(5);
/// Credited to the last event in a session, which has no following event.
const ACTIVE_TAIL: Duration = Duration::seconds(30);

/// Gap-capped active time from a session's usage-bearing timestamps.
#[derive(Default)]
struct ActiveTimeAcc {
    stamps: Vec<DateTime<Utc>>,
}

impl ActiveTimeAcc {
    fn push(&mut self, at: DateTime<Utc>) {
        self.stamps.push(at);
    }

    fn total_ms(&self) -> i64 {
        active_ms_from_stamps(&self.stamps)
    }

    /// Last usage-bearing event, for Usage-tab day buckets. File mtime is the
    /// scan/write time and put work on the wrong day.
    fn last_captured_at(&self) -> Option<String> {
        self.stamps
            .iter()
            .max()
            .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
    }
}

fn active_ms_from_stamps(stamps: &[DateTime<Utc>]) -> i64 {
    if stamps.is_empty() {
        return 0;
    }
    let mut stamps = stamps.to_vec();
    stamps.sort_unstable();
    let mut total = 0i64;
    for pair in stamps.windows(2) {
        let gap = pair[1] - pair[0];
        let counted = if gap > ACTIVE_GAP_CAP { ACTIVE_GAP_CAP } else { gap };
        total += counted.num_milliseconds().max(0);
    }
    total + ACTIVE_TAIL.num_milliseconds()
}

fn event_timestamp(value: &Value) -> Option<DateTime<Utc>> {
    if let Some(s) = value.get("timestamp").and_then(Value::as_str) {
        if let Ok(t) = DateTime::parse_from_rfc3339(s) {
            return Some(t.with_timezone(&Utc));
        }
        return chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
            .ok()
            .map(|n| Utc.from_utc_datetime(&n));
    }
    if let Some(n) = value
        .get("timestamp")
        .and_then(Value::as_i64)
        .or_else(|| value.get("timestamp").and_then(Value::as_f64).map(|v| v as i64))
    {
        let secs = if n > 10_000_000_000 { n / 1000 } else { n };
        return DateTime::from_timestamp(secs, 0);
    }
    None
}

fn grok_event_timestamp(value: &Value, meta: &Value) -> Option<DateTime<Utc>> {
    event_timestamp(value)
        .or_else(|| event_timestamp(value.get("params").unwrap_or(&Value::Null)))
        .or_else(|| {
            meta.get("agentTimestampMs")
                .and_then(Value::as_i64)
                .and_then(|ms| DateTime::from_timestamp(ms / 1000, 0))
        })
}

/// Standard direct-API USD per million tokens, verified through 2026-09-22.
/// Sources and limitations: docs/teams-pricing-verification-2026-09-08.md.
/// These are API-equivalent estimates, not subscription charges or invoices.
struct ModelPricing {
    input_per_mtok: f64,
    output_per_mtok: f64,
    cache_read_per_mtok: f64,
    // Full charge for the disjoint write class, not an additional surcharge.
    cache_write_per_mtok: f64,
    known: bool,
    catalog: Option<crate::pricing_catalog::CatalogPricing>,
}

fn pricing_model_key(model: &str) -> String {
    let lower = model.trim().to_lowercase();
    let bare = match lower.split_once('/') {
        Some(("openai", name)) if name.starts_with("gpt-") || name.starts_with('o') => name,
        Some(("anthropic", name)) if name.starts_with("claude-") => name,
        Some(("x-ai" | "xai", name)) if name.starts_with("grok-") => name,
        _ => &lower,
    };
    // Claude's dated snapshots retain the same version-specific list rate.
    // OpenAI snapshots are explicit below: some older GPT-4o dates cost more.
    if bare.starts_with("claude-") {
        return normalize_model_name(bare).replace('.', "-");
    }
    bare.to_string()
}

fn model_pricing(model: &str) -> ModelPricing {
    let key = pricing_model_key(model);
    // Exact IDs only. Family substrings accidentally priced pro/audio/unknown
    // variants and even Cursor Composer as Grok. Never infer those aliases.
    let rates = match key.as_str() {
        // 4.7 matches 4.6: $2 / $0.50 / $6 below 200k (docs.x.ai, 2026-09-21).
        "grok-4.7" | "grok-4.6" => Some((2.0, 6.0, 0.50, 2.0)),
        "grok-4.5" => Some((2.0, 6.0, 0.30, 2.0)),
        "grok-build-0.1" => Some((1.0, 2.0, 0.20, 1.0)),
        "grok-4.3" | "grok-4.20-multi-agent-0309" |
        "grok-4.20-0309-reasoning" | "grok-4.20-0309-non-reasoning" =>
            Some((1.25, 2.50, 0.20, 1.25)),
        "claude-fable-5-1" | "claude-mythos-5-1" => Some((10.0, 50.0, 0.25, 12.50)),
        "claude-fable-5" | "claude-mythos-5" => Some((10.0, 50.0, 1.0, 12.50)),
        "claude-opus-5-5" => Some((4.0, 20.0, 0.20, 5.0)),
        "claude-opus-5" | "claude-opus-4-8" | "claude-opus-4-7" |
        "claude-opus-4-6" | "claude-opus-4-5" => Some((5.0, 25.0, 0.50, 6.25)),
        "claude-opus-4-1" | "claude-opus-4" => Some((15.0, 75.0, 1.50, 18.75)),
        // Anthropic made Sonnet 5's introductory price permanent.
        "claude-sonnet-5" => Some((2.0, 10.0, 0.20, 2.50)),
        "claude-sonnet-4-6" | "claude-sonnet-4-5" | "claude-sonnet-4" =>
            Some((3.0, 15.0, 0.30, 3.75)),
        "claude-haiku-4-5" => Some((1.0, 5.0, 0.10, 1.25)),
        "claude-3-5-haiku" => Some((0.80, 4.0, 0.08, 1.0)),
        // OpenAI documents explicit cache writes only for GPT-5.6 and later.
        "gpt-6-astra" => Some((10.0, 50.0, 1.0, 12.50)),
        "gpt-6-sol" => Some((2.0, 10.0, 0.20, 2.50)),
        "gpt-6-luna" => Some((0.10, 0.50, 0.01, 0.125)),
        "gpt-5.6" | "gpt-5.6-sol" | "gpt-daybreak-blue-latest" =>
            Some((4.0, 20.0, 0.40, 5.0)),
        "gpt-5.6-terra" => Some((2.0, 12.0, 0.20, 2.50)),
        "gpt-5.6-luna" => Some((0.20, 1.20, 0.02, 0.25)),
        "gpt-5.5" => Some((5.0, 30.0, 0.50, 5.0)),
        "gpt-5.4" | "gpt-5.4-2026-03-05" => Some((2.50, 15.0, 0.25, 2.50)),
        "gpt-5.4-mini" => Some((0.75, 4.50, 0.075, 0.75)),
        "gpt-5.4-nano" => Some((0.20, 1.25, 0.02, 0.20)),
        "gpt-5.1-codex-mini" => Some((0.25, 2.0, 0.025, 0.25)),
        "gpt-5.1-codex" => Some((1.25, 10.0, 0.125, 1.25)),
        "gpt-5.3-codex" | "gpt-5.2-codex" | "gpt-5.2" => Some((1.75, 14.0, 0.175, 1.75)),
        "o4-mini" | "o4-mini-2025-04-16" => Some((1.10, 4.40, 0.275, 1.10)),
        "o3-mini" | "o3-mini-2025-01-31" => Some((1.10, 4.40, 0.55, 1.10)),
        "o3" => Some((2.0, 8.0, 0.50, 2.0)),
        "o1" => Some((15.0, 60.0, 7.50, 15.0)),
        "gpt-4o-mini" | "gpt-4o-mini-2024-07-18" => Some((0.15, 0.60, 0.075, 0.15)),
        "gpt-4o" | "gpt-4o-2024-08-06" | "gpt-4o-2024-11-20" =>
            Some((2.50, 10.0, 1.25, 2.50)),
        "gpt-4.1-mini" | "gpt-4.1-mini-2025-04-14" => Some((0.40, 1.60, 0.10, 0.40)),
        "gpt-4.1-nano" | "gpt-4.1-nano-2025-04-14" => Some((0.10, 0.40, 0.025, 0.10)),
        "gpt-4.1" | "gpt-4.1-2025-04-14" => Some((2.0, 8.0, 0.50, 2.0)),
        _ => None,
    };
    if let Some((input, output, read, write)) = rates {
        return ModelPricing { input_per_mtok: input, output_per_mtok: output,
            cache_read_per_mtok: read, cache_write_per_mtok: write, known: true, catalog: None };
    }
    // Catalog prices are another API estimate, not proof of the user's provider
    // route, negotiated price, service tier, or historical price at request time.
    if let Some(c) = crate::pricing_catalog::lookup(model) {
        return ModelPricing {
            input_per_mtok: c.input_per_mtok,
            output_per_mtok: c.output_per_mtok,
            cache_read_per_mtok: c.cache_read_per_mtok.unwrap_or(0.0),
            cache_write_per_mtok: c.cache_write_per_mtok.unwrap_or(0.0),
            known: true, catalog: Some(c),
        };
    }
    // Existing wire contract uses zero for unpriced; this does NOT mean free.
    ModelPricing { input_per_mtok: 0.0, output_per_mtok: 0.0,
        cache_read_per_mtok: 0.0, cache_write_per_mtok: 0.0, known: false, catalog: None }
}

/// Whether a known write-class rate differs from ordinary input pricing.
/// False includes unknown pricing; it does not certify complete/free usage.
pub(crate) fn model_requires_cache_write_usage(model: &str) -> bool {
    let price = model_pricing(model);
    price.known
        && price.catalog.is_none_or(|c| c.cache_write_per_mtok.is_some())
        && price.cache_write_per_mtok != price.input_per_mtok
}

/// Discrete token classes for one request/turn. Cache-write 1h is billed at
/// 2× input for verified Claude models; other APIs use their own write rate.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct TokenCostSpec {
    pub pure_input: i64,
    pub pure_output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub cache_write_1h: i64,
}

/// Coverage metadata for callers that must distinguish unavailable from zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TokenCostUnavailable {
    ModelPrice,
    CacheReadPrice,
    CacheWritePrice,
    CacheWriteHourPrice,
    RequestBoundaries,
}

impl ModelPricing {
    fn unavailable(&self, spec: TokenCostSpec) -> Option<TokenCostUnavailable> {
        if !self.known { return Some(TokenCostUnavailable::ModelPrice); }
        if let Some(c) = self.catalog {
            // A generic catalog write rate does not establish a 1h tariff.
            if spec.cache_write_1h > 0 {
                return Some(TokenCostUnavailable::CacheWriteHourPrice);
            }
            if spec.cache_read > 0 && c.cache_read_per_mtok.is_none() {
                return Some(TokenCostUnavailable::CacheReadPrice);
            }
            if (spec.cache_write > 0 || spec.cache_write_1h > 0) && c.cache_write_per_mtok.is_none() {
                return Some(TokenCostUnavailable::CacheWritePrice);
            }
        }
        None
    }
}

/// Per-request standard long-context step. Threshold is the largest short
/// prompt: xAI switches at >=200k, whereas OpenAI switches at >272k.
fn long_context_step(model: &str) -> Option<(i64, f64, f64)> {
    match pricing_model_key(model).as_str() {
        "gpt-5.4" | "gpt-5.4-2026-03-05" | "gpt-5.5" | "gpt-5.6" |
        "gpt-5.6-sol" | "gpt-daybreak-blue-latest" | "gpt-5.6-terra" |
        "gpt-5.6-luna" | "gpt-6-astra" | "gpt-6-sol" | "gpt-6-luna" =>
            Some((272_000, 2.0, 1.5)),
        "grok-4.7" | "grok-4.6" | "grok-4.5" | "grok-build-0.1" | "grok-4.3" |
        "grok-4.20-multi-agent-0309" | "grok-4.20-0309-reasoning" |
        "grok-4.20-0309-non-reasoning" => Some((199_999, 2.0, 2.0)),
        // Claude 4.6+ has no premium. The Sonnet 4/4.5 1M beta was
        // retired April 30, 2026; do not apply its obsolete premium today.
        _ => None,
    }
}

/// Per-request cost. Long-context and Claude 1h cache are applied here so
/// Usage and Teams never disagree, and so a session *sum* cannot trip the
/// 200k/272k step (that step is per prompt, not per day).
pub(crate) fn estimate_token_cost(model: Option<&str>, spec: TokenCostSpec) -> f64 {
    // Compatibility only: existing numeric aggregates cannot express unknown.
    // Monetary displays/coverage must use the checked API, never infer free.
    estimate_token_cost_checked(model, spec).unwrap_or(0.0)
}

/// Price a group only when its total prompt proves every constituent request
/// is below the known context step. Otherwise request boundaries are required.
pub(crate) fn estimate_aggregated_token_cost_checked(
    model: Option<&str>, spec: TokenCostSpec,
) -> Result<f64, TokenCostUnavailable> {
    let prompt = spec.pure_input.max(0)
        .saturating_add(spec.cache_read.max(0))
        .saturating_add(spec.cache_write.max(0))
        .saturating_add(spec.cache_write_1h.max(0));
    if model.and_then(long_context_step).is_some_and(|(threshold, _, _)| prompt > threshold) {
        return Err(TokenCostUnavailable::RequestBoundaries);
    }
    estimate_token_cost_checked(model, spec)
}

pub(crate) fn estimate_token_cost_checked(
    model: Option<&str>, spec: TokenCostSpec,
) -> Result<f64, TokenCostUnavailable> {
    let Some(name) = model.map(str::trim).filter(|s| !s.is_empty()) else {
        return Err(TokenCostUnavailable::ModelPrice);
    };
    let base = model_pricing(name);
    if let Some(reason) = base.unavailable(spec) { return Err(reason); }
    let prompt = spec.pure_input.max(0)
        + spec.cache_read.max(0)
        + spec.cache_write.max(0)
        + spec.cache_write_1h.max(0);
    let rates = if let Some((threshold, in_mult, out_mult)) = long_context_step(name) {
        if prompt > threshold {
            ModelPricing {
                input_per_mtok: base.input_per_mtok * in_mult,
                output_per_mtok: base.output_per_mtok * out_mult,
                cache_read_per_mtok: base.cache_read_per_mtok * in_mult,
                cache_write_per_mtok: base.cache_write_per_mtok * in_mult,
                ..base
            }
        } else {
            base
        }
    } else {
        base
    };
    let hour_write_rate = if rates.catalog.is_none() && pricing_model_key(name).starts_with("claude-")
        && rates.cache_write_per_mtok > 0.0
    {
        rates.input_per_mtok * 2.0
    } else {
        rates.cache_write_per_mtok
    };
    let mtok = 1_000_000.0;
    Ok((spec.pure_input.max(0) as f64 / mtok) * rates.input_per_mtok
        + (spec.pure_output.max(0) as f64 / mtok) * rates.output_per_mtok
        + (spec.cache_read.max(0) as f64 / mtok) * rates.cache_read_per_mtok
        + (spec.cache_write.max(0) as f64 / mtok) * rates.cache_write_per_mtok
        + (spec.cache_write_1h.max(0) as f64 / mtok) * hour_write_rate)
}

/// Cost for **discrete, non-overlapping** token counts — the shape
/// `teams::scan` produces by reading provider logs per event.
///
/// `pure_input` / `pure_output` must **exclude** cache read/write. OpenAI's
/// `input_tokens` includes cached tokens — callers must subtract first.
/// Reasoning that is already inside `pure_output` must not be added again.
///
/// One pricing table: Teams and the local Usage panel never disagree on cost.
pub(crate) fn estimate_cost_for_model(
    model: &str,
    pure_input: i64,
    pure_output: i64,
    cache_write: i64,
    cache_read: i64,
) -> f64 {
    estimate_token_cost(
        Some(model),
        TokenCostSpec {
            pure_input,
            pure_output,
            cache_read,
            cache_write,
            cache_write_1h: 0,
        },
    )
}

pub(crate) fn claude_cache_write_1h(usage: &Value, cache_create_total: i64) -> i64 {
    usage
        .get("cache_creation")
        .and_then(|c| c.get("ephemeral_1h_input_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0)
        .min(cache_create_total.max(0))
}

/// Native lineage boundary. Paginated forks can retimestamp inherited rows;
/// their ordinal remains the reliable boundary for usage and tool accounting.
/// Contract: openai/codex protocol::SessionMeta::subagent_history_start_ordinal.
#[derive(Debug, Clone, Default)]
pub(crate) struct CodexHistoryBoundary {
    pub created_at: Option<DateTime<Utc>>,
    own_ordinal: Option<u64>,
}

impl CodexHistoryBoundary {
    pub fn from_meta(meta: &Value) -> Self {
        let fork = meta.get("forked_from_id").or_else(|| meta.get("forkedFromId"))
            .and_then(Value::as_str).is_some_and(|id| !id.is_empty());
        Self {
            created_at: if fork { meta.get("timestamp").and_then(Value::as_str)
                .and_then(|ts| DateTime::parse_from_rfc3339(ts).ok()).map(|ts| ts.with_timezone(&Utc)) } else { None },
            own_ordinal: meta.get("subagent_history_start_ordinal").and_then(Value::as_u64)
                .or_else(|| if fork { meta.get("forked_from_ordinal_exclusive").and_then(Value::as_u64) } else { None }),
        }
    }

    pub fn is_copied(&self, row: &Value) -> bool {
        if let Some((ordinal, start)) = row.get("ordinal").and_then(Value::as_u64).zip(self.own_ordinal) {
            return ordinal < start;
        }
        self.created_at.zip(event_timestamp(row)).is_some_and(|(created, at)| at < created)
    }
}

/// OpenAI/Codex usage object.
///
/// `input_tokens` is the full prompt size and **includes** cached reads
/// (and cache writes, when that field is present). Matches CodexBar / tokscale:
/// cached = max(`cached_input_tokens`, `cache_read_input_tokens`); reasoning is
/// a subset of output; writes are a subset of the non-cached remainder.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct CodexUsageFields {
    pub input: i64,
    pub cached: i64,
    pub cache_write: i64,
    pub output: i64,
    pub reasoning: i64,
}

impl CodexUsageFields {
    pub fn read(u: &Value) -> Self {
        let n = |k: &str| u.get(k).and_then(Value::as_i64).unwrap_or(0).max(0);
        let output = n("output_tokens");
        Self {
            input: n("input_tokens"),
            cached: n("cached_input_tokens").max(n("cache_read_input_tokens")),
            cache_write: n("cache_write_input_tokens"),
            output,
            reasoning: n("reasoning_output_tokens").min(output),
        }
    }

    /// `(uncached, cached, cache_write)` with subset clamps so tokens are never
    /// invented or double-counted.
    pub fn split_input(self) -> (i64, i64, i64) {
        let total = self.input.max(0);
        let cached = self.cached.max(0).min(total);
        let remaining = total - cached;
        let write = self.cache_write.max(0).min(remaining);
        (remaining - write, cached, write)
    }

    pub fn saturating_sub(self, prev: Self) -> Self {
        Self {
            input: (self.input - prev.input).max(0),
            cached: (self.cached - prev.cached).max(0),
            cache_write: (self.cache_write - prev.cache_write).max(0),
            output: (self.output - prev.output).max(0),
            reasoning: (self.reasoning - prev.reasoning).max(0),
        }
    }

    pub fn is_empty(self) -> bool {
        self.input + self.output + self.cached + self.cache_write + self.reasoning == 0
    }

    fn is_below(self, prev: Self) -> bool {
        self.input < prev.input || self.cached < prev.cached || self.output < prev.output
    }

    fn min_components(self, other: Self) -> Self {
        Self {
            input: self.input.min(other.input),
            cached: self.cached.min(other.cached),
            cache_write: self.cache_write.min(other.cache_write),
            output: self.output.min(other.output),
            reasoning: self.reasoning.min(other.reasoning),
        }
    }

    fn add(self, other: Self) -> Self {
        Self {
            input: self.input + other.input,
            cached: self.cached + other.cached,
            cache_write: self.cache_write + other.cache_write,
            output: self.output + other.output,
            reasoning: self.reasoning + other.reasoning,
        }
    }
}

/// Intra-file Codex totals accounting (CodexBar / tokscale).
///
/// When both `last` and `total` exist, cap the response at cumulative growth.
/// Explicit zero snapshots start a fresh segment; deduplication must not carry
/// totals across that boundary. Nonzero decreases without response usage or a
/// reset boundary remain ambiguous with restored history.
#[derive(Debug, Clone, Default)]
pub(crate) struct CodexSessionCounter {
    counted: CodexUsageFields,
    watermark: Option<CodexUsageFields>,
    seen: Vec<CodexUsageFields>,
}

impl CodexSessionCounter {
    const SEEN_LIMIT: usize = 64;

    pub fn watermark(&self) -> CodexUsageFields {
        self.watermark.unwrap_or(self.counted)
    }

    pub fn apply(
        &mut self,
        last: Option<CodexUsageFields>,
        total: Option<CodexUsageFields>,
    ) -> Option<CodexUsageFields> {
        let before = self.counted;

        if let Some(total) = total {
            // A repeated zero is still a reset, even if a prior segment already
            // recorded zero. Rebase before deduplication so equal usage in the
            // next segment is billable again.
            if total.is_empty() {
                self.watermark = Some(total);
                self.seen.clear();
                return None;
            }
            if self.seen.iter().any(|s| *s == total) {
                return None;
            }
            if let Some(prev) = self.watermark {
                if total.is_below(prev) {
                    self.remember(total);
                    if let Some(last) = last {
                        self.counted = self.counted.add(last);
                    }
                    self.watermark = Some(total);
                    return self.delta_since(before);
                }
            }
            let base = self.watermark.unwrap_or_default();
            let total_delta = total.saturating_sub(base);
            let delta = match last {
                Some(last) => last.min_components(total_delta),
                None => total_delta,
            };
            self.counted = self.counted.add(delta);
            self.watermark = Some(total);
            self.remember(total);
            return self.delta_since(before);
        }

        if let Some(last) = last {
            self.counted = self.counted.add(last);
            self.watermark = Some(self.counted);
            return self.delta_since(before);
        }
        None
    }

    fn delta_since(&self, before: CodexUsageFields) -> Option<CodexUsageFields> {
        let d = self.counted.saturating_sub(before);
        if d.is_empty() {
            None
        } else {
            Some(d)
        }
    }

    fn remember(&mut self, t: CodexUsageFields) {
        if !self.seen.iter().any(|s| *s == t) {
            self.seen.push(t);
            if self.seen.len() > Self::SEEN_LIMIT {
                self.seen.remove(0);
            }
        }
    }
}

/// Record one Grok ACP turn's token usage into `session_usage`.
///
/// Grok reports billable counts on the `session/prompt` result `_meta`:
/// `inputTokens`, `outputTokens`, `cachedReadTokens`. Mid-turn updates only
/// carry context `totalTokens` and are ignored here.
///
/// `inputTokens` from Grok appears to include cached reads (input ≥ cache);
/// we store pure input + cache_read separately so `get_usage_summary` /
/// `get_model_breakdown` (which sum `input + cache_read`) match Claude.
pub async fn record_grok_turn_usage(
    pool: &SqlitePool,
    thread_id: &str,
    model: Option<&str>,
    prompt_result: &Value,
) -> anyhow::Result<()> {
    let meta = prompt_result.get("_meta").unwrap_or(&Value::Null);
    let Some(usage) = crate::teams::scan::grok::parse_usage_snap(meta) else {
        return Ok(());
    };
    if usage.is_empty() {
        return Ok(());
    }
    let pure_input = (usage.input - usage.cache).max(0);
    let output = usage.output;
    let cache_read = usage.cache;

    let model_name = model
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(normalize_model_name);
    // The result covers a prompt's model calls, not one pricing request.
    // Missing ticks are unreported cost; an explicit zero must stay zero.
    let cost = usage.cost_ticks as f64 / 10_000_000_000.0;
    let captured_at = Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();

    accumulate_session_usage(
        pool,
        thread_id,
        "grok",
        model_name.as_deref(),
        pure_input,
        output,
        0,
        cache_read,
        cost,
        1,
        0,
        &captured_at,
    )
    .await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cost_usd: f64,
    pub session_count: i64,
    pub total_active_ms: i64,
    pub daily_breakdown: Vec<DailyUsage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsage {
    pub date: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
    pub session_count: i64,
    pub active_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub percentage: f64,
    pub active_ms: i64,
    pub time_percentage: f64,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PaceStatus {
    Behind,
    OnTrack,
    Ahead,
    WellOver,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaceWindow {
    pub utilization: f64,
    pub expected_utilization: f64,
    pub delta: f64,
    pub pace_status: PaceStatus,
    pub pace_label: String,
    pub resets_at: Option<String>,
    pub window_minutes: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaceInfo {
    pub session: Option<PaceWindow>,
    pub weekly: Option<PaceWindow>,
    /// Claude Max sub-quotas. Each is `None` for providers/accounts that
    /// don't expose the window (e.g. Codex, free-tier Claude).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sonnet: Option<PaceWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opus: Option<PaceWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub design: Option<PaceWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routines: Option<PaceWindow>,
}

#[tauri::command]
pub async fn get_usage_summary(
    state: State<'_, AppState>,
    provider: String,
    days: i64,
) -> Result<UsageSummary, String> {
    load_usage_summary(&state.db, &provider, days).await
}

async fn load_usage_summary(pool: &SqlitePool, provider: &str, days: i64) -> Result<UsageSummary, String> {
    let days_param = days.clamp(1, 90);

    // Token sums are display; cost is stored per session from per-request
    // pricing (1h cache + long-context). Recomputing from the sums would
    // trip those thresholds on the *day* instead of the prompt.
    let model_rows = sqlx::query_as::<_, (Option<String>, i64, i64, i64, i64, i64, i64, f64)>(
        "SELECT
            model,
            COALESCE(SUM(input_tokens), 0),
            COALESCE(SUM(output_tokens), 0),
            COALESCE(SUM(cache_read_tokens), 0),
            COALESCE(SUM(cache_creation_tokens), 0),
            COUNT(*),
            COALESCE(SUM(active_ms), 0),
            COALESCE(SUM(total_cost_usd), 0)
         FROM session_usage
         WHERE provider = ? AND captured_at >= datetime('now', '-' || ? || ' days')
         GROUP BY model",
    )
    .bind(provider)
    .bind(days_param)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to load usage summary: {e}"))?;

    let mut total_input: i64 = 0;
    let mut total_output: i64 = 0;
    let mut total_cost: f64 = 0.0;
    let mut total_sessions: i64 = 0;
    let mut total_active_ms: i64 = 0;
    for (_model, input, output, cache_read, cache_create, count, active_ms, stored_cost) in &model_rows {
        let combined_input = input + cache_read + cache_create;
        let combined_output = output;
        total_input += combined_input;
        total_output += combined_output;
        total_sessions += count;
        total_active_ms += active_ms;
        total_cost += stored_cost;
    }

    // Daily breakdown (last 7 days) — group by day + model for accurate costing
    let daily_model_rows = sqlx::query_as::<_, (String, Option<String>, i64, i64, i64, i64, i64, i64, f64)>(
        "SELECT
            DATE(captured_at) AS day,
            model,
            COALESCE(SUM(input_tokens), 0),
            COALESCE(SUM(output_tokens), 0),
            COALESCE(SUM(cache_read_tokens), 0),
            COALESCE(SUM(cache_creation_tokens), 0),
            COUNT(*),
            COALESCE(SUM(active_ms), 0),
            COALESCE(SUM(total_cost_usd), 0)
         FROM session_usage
         WHERE provider = ? AND captured_at >= datetime('now', '-7 days')
         GROUP BY day, model
         ORDER BY day ASC",
    )
    .bind(provider)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to load daily usage: {e}"))?;

    // Aggregate daily rows by date
    let mut daily_map: std::collections::BTreeMap<String, DailyUsage> = std::collections::BTreeMap::new();
    for (date, _model, input, output, cache_read, cache_create, count, active_ms, stored_cost) in daily_model_rows {
        let combined_input = input + cache_read + cache_create;
        let combined_output = output;
        let cost = stored_cost;
        let entry = daily_map.entry(date.clone()).or_insert(DailyUsage {
            date,
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0.0,
            session_count: 0,
            active_ms: 0,
        });
        entry.input_tokens += combined_input;
        entry.output_tokens += combined_output;
        entry.cost_usd += cost;
        entry.session_count += count;
        entry.active_ms += active_ms;
    }

    Ok(UsageSummary {
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        total_cost_usd: total_cost,
        session_count: total_sessions,
        total_active_ms,
        daily_breakdown: daily_map.into_values().collect(),
    })
}

#[tauri::command]
pub async fn get_model_breakdown(
    state: State<'_, AppState>,
    provider: String,
    days: i64,
) -> Result<Vec<ModelUsage>, String> {
    load_model_breakdown(&state.db, &provider, days).await
}

async fn load_model_breakdown(pool: &SqlitePool, provider: &str, days: i64) -> Result<Vec<ModelUsage>, String> {
    let days_param = days.clamp(1, 90);
    let rows = sqlx::query_as::<_, (String, i64, i64, i64)>(
        "SELECT
            COALESCE(model, 'unknown') AS model_name,
            COALESCE(SUM(input_tokens + cache_read_tokens + cache_creation_tokens), 0),
            COALESCE(SUM(output_tokens), 0),
            COALESCE(SUM(active_ms), 0)
         FROM session_usage
         WHERE provider = ? AND captured_at >= datetime('now', '-' || ? || ' days')
         GROUP BY model_name
         ORDER BY (COALESCE(SUM(input_tokens + cache_read_tokens + cache_creation_tokens), 0) + COALESCE(SUM(output_tokens), 0)) DESC",
    )
    .bind(provider)
    .bind(days_param)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to load model breakdown: {e}"))?;

    let grand_total: i64 = rows.iter().map(|(_, input, output, _)| input + output).sum();
    let grand_active: i64 = rows.iter().map(|(_, _, _, ms)| *ms).sum();

    Ok(rows
        .into_iter()
        .map(|(model, input_tokens, output_tokens, active_ms)| {
            let total_tokens = input_tokens + output_tokens;
            ModelUsage {
                model,
                input_tokens,
                output_tokens,
                total_tokens,
                percentage: if grand_total > 0 {
                    (total_tokens as f64 / grand_total as f64) * 100.0
                } else {
                    0.0
                },
                active_ms,
                time_percentage: if grand_active > 0 {
                    (active_ms as f64 / grand_active as f64) * 100.0
                } else {
                    0.0
                },
            }
        })
        .collect())
}

#[tauri::command]
pub async fn get_pace_info(provider: String) -> Result<PaceInfo, String> {
    let usage = match provider.as_str() {
        "claude" => super::usage::fetch_claude_usage().await?,
        "grok" => super::usage::fetch_grok_usage().await?,
        "gemini" => super::usage::fetch_gemini_usage().await?,
        // These providers are known to the Usage panel UI but their live
        // fetchers haven't been ported from codexbar yet. Surface a distinct
        // error so the frontend can render the "Live fetch coming soon" state
        // instead of a silent empty card.
        "warp" | "cursor" => {
            return Err(format!("fetch_not_implemented:{provider}"));
        }
        _ => {
            return Ok(PaceInfo {
                session: None,
                weekly: None,
                sonnet: None,
                opus: None,
                design: None,
                routines: None,
            });
        }
    };

    Ok(PaceInfo {
        session: usage.session.as_ref().map(|w| calculate_pace_window(w, 0.0)),
        weekly: usage.weekly.as_ref().map(|w| calculate_pace_window(w, 0.0)),
        sonnet: usage.sonnet.as_ref().map(|w| calculate_pace_window(w, 0.0)),
        opus: usage.opus.as_ref().map(|w| calculate_pace_window(w, 0.0)),
        design: usage.design.as_ref().map(|w| calculate_pace_window(w, 0.0)),
        routines: usage.routines.as_ref().map(|w| calculate_pace_window(w, 0.0)),
    })
}

#[tauri::command]
pub async fn get_pace_info_codex(state: State<'_, AppState>) -> Result<PaceInfo, String> {
    let usage = super::usage::fetch_codex_usage(state).await?;
    Ok(PaceInfo {
        session: usage.session.as_ref().map(|w| calculate_pace_window(w, 0.0)),
        weekly: usage.weekly.as_ref().map(|w| calculate_pace_window(w, 0.0)),
        sonnet: None,
        opus: None,
        design: None,
        routines: None,
    })
}

#[tauri::command]
pub async fn scan_usage_logs(
    state: State<'_, AppState>,
    provider: String,
) -> Result<u64, String> {
    let _debug_timer = crate::debug_mode::operation("scan_usage_logs");
    // Grok's prompt-accounting repair must bypass the 12h cache even when
    // existing rows have cache hits and native files have not changed.
    let force_grok = if provider == "grok" {
        grok_needs_forced_rescan(&state.db)
            .await
            .map_err(|e| format!("Failed to check Grok usage repair: {e}"))?
    } else {
        false
    };

    let force_pricing = pricing_needs_forced_rescan(&state.db, &provider).await
        .map_err(|e| format!("Failed to check usage pricing revision: {e}"))?;
    {
        let scan_times = state.usage_scan_times.lock().await;
        if usage_scan_is_cached(scan_times.get(&provider), force_grok || force_pricing) {
            return Ok(0);
        }
    }

    // Refresh OpenRouter price list (no-op if <24h cache) before costing.
    crate::pricing_catalog::ensure_fresh().await;

    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let cutoff = Utc::now() - Duration::days(30);
    let count = match provider.as_str() {
        "claude" => scan_claude_logs(&state.db, &home.join(".claude").join("projects"), cutoff)
            .await
            .map_err(|e| format!("Failed to scan Claude logs: {e}"))?,
        "codex" => {
            let mut roots = vec![home.join(".codex/sessions"), home.join(".codex/archived_sessions")];
            if let Some(config) = crate::codex::cli_config::codex_home().filter(|p| p.is_absolute()) {
                roots.extend([config.join("sessions"), config.join("archived_sessions")]);
            }
            scan_codex_logs(&state.db, &roots).await
                .map_err(|e| format!("Failed to scan Codex logs: {e}"))?
        },
        // Grok reports prompt-scoped billable usage; context is activity only.
        "grok" => scan_grok_logs(&state.db, &home.join(".grok").join("sessions"), cutoff)
            .await
            .map_err(|e| format!("Failed to scan Grok logs: {e}"))?,
        _ => return Ok(0),
    };

    state
        .usage_scan_times
        .lock()
        .await
        .insert(provider, Instant::now());

    Ok(count)
}

// The legacy scan-metadata table is no longer used for Teams byte cursors.
// A namespaced, non-filesystem key keeps this local Usage repair independent
// of Teams backfill revisions and of other providers' Usage repairs.
const GROK_USAGE_REPAIR_KEY: &str = "usage-stats:grok:prompt-accounting-v2";

// Bump when static pricing or catalog semantics change. This seals a retained
// file walk only, never certifies missing logs or reprices lifetime aggregates.
const USAGE_PRICING_REVISION: i64 = 5;

fn usage_scan_is_cached(last: Option<&Instant>, force: bool) -> bool {
    !force && last.is_some_and(|last| last.elapsed() < SCAN_CACHE_TTL)
}

async fn pricing_needs_forced_rescan(pool: &SqlitePool, provider: &str) -> anyhow::Result<bool> {
    if !matches!(provider, "claude" | "codex") { return Ok(false); }
    let revision: Option<i64> = sqlx::query_scalar(
        "SELECT offset_bytes FROM teams_scan_cursor WHERE path = ?",
    ).bind(format!("usage-stats:pricing:{provider}")).fetch_optional(pool).await?;
    Ok(revision != Some(USAGE_PRICING_REVISION))
}

async fn mark_pricing_rescan_complete(pool: &SqlitePool, provider: &str) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO teams_scan_cursor(path, offset_bytes, scanned_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(path) DO UPDATE SET offset_bytes = excluded.offset_bytes, scanned_at = excluded.scanned_at",
    ).bind(format!("usage-stats:pricing:{provider}")).bind(USAGE_PRICING_REVISION)
        .execute(pool).await?;
    Ok(())
}

fn collect_pricing_repair_files(root: &Path) -> anyhow::Result<Vec<PathBuf>> {
    if !root.try_exists()? { return Ok(Vec::new()); }
    anyhow::ensure!(root.is_dir(), "Usage pricing source must be a directory");
    let mut files = Vec::new();
    for entry in WalkDir::new(root) {
        let entry = entry?;
        if entry.file_type().is_file() && entry.path().extension().and_then(|s| s.to_str()) == Some("jsonl") {
            files.push(entry.into_path());
        }
    }
    Ok(files)
}

async fn grok_needs_forced_rescan(pool: &SqlitePool) -> anyhow::Result<bool> {
    let done: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM teams_scan_cursor WHERE path = ? AND offset_bytes = 1",
    )
    .bind(GROK_USAGE_REPAIR_KEY)
    .fetch_one(pool)
    .await?;
    Ok(done == 0)
}

fn calculate_pace_window(window: &super::usage::UsageWindow, reserve_percent: f64) -> PaceWindow {
    let utilization = window.utilization;
    let target_percent = 100.0 - reserve_percent;
    let expected_utilization = compute_expected_utilization(window.resets_at.as_deref(), window.window_minutes, target_percent);
    let delta = utilization - expected_utilization;
    let (pace_status, pace_label) = if delta < -1.0 {
        (PaceStatus::Behind, "Behind pace".to_string())
    } else if delta <= 1.0 {
        (PaceStatus::OnTrack, "On track".to_string())
    } else if delta <= 20.0 {
        (
            PaceStatus::Ahead,
            format!("Ahead of pace by {:.0}%", delta.round()),
        )
    } else {
        (
            PaceStatus::WellOver,
            format!("Well over pace by {:.0}%", delta.round()),
        )
    };

    PaceWindow {
        utilization,
        expected_utilization,
        delta,
        pace_status,
        pace_label,
        resets_at: window.resets_at.clone(),
        window_minutes: window.window_minutes,
    }
}

fn compute_expected_utilization(resets_at: Option<&str>, window_minutes: Option<i64>, target_percent: f64) -> f64 {
    let window_minutes = window_minutes.unwrap_or(300).max(1) as f64;
    let Some(resets_at) = resets_at else {
        return target_percent * 0.5;
    };
    let Some(reset_at_ms) = parse_reset_timestamp_ms(resets_at) else {
        return target_percent * 0.5;
    };

    let now_ms = Utc::now().timestamp_millis() as f64;
    let window_ms = window_minutes * 60.0 * 1000.0;
    let window_start = reset_at_ms - window_ms;
    let elapsed = (now_ms - window_start).clamp(0.0, window_ms);
    (elapsed / window_ms) * target_percent
}

fn parse_reset_timestamp_ms(value: &str) -> Option<f64> {
    if let Ok(num) = value.parse::<f64>() {
        if num > 10_000_000_000.0 {
            return Some(num);
        }
        return Some(num * 1000.0);
    }

    DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis() as f64)
        .ok()
}

struct ClaudeFileAcc {
    path: PathBuf,
    acc: ClaudeUsageAccumulator,
}

fn reconcile_claude_files(files: &mut [ClaudeFileAcc]) {
    // Same message.id:requestId in a parent transcript and a /subagents/ file
    // (or a sidechain) is one request — keep one copy (CodexBar).
    let mut best: std::collections::HashMap<String, (usize, bool, bool)> = std::collections::HashMap::new();
    for (fi, file) in files.iter().enumerate() {
        for (key, row) in &file.acc.seen_ids {
            let cand = (fi, row.is_sidechain, file.acc.from_subagent_path);
            match best.get(key) {
                None => {
                    best.insert(key.clone(), cand);
                }
                Some(&(ej, e_side, e_sub)) => {
                    let wins = if cand.1 != e_side {
                        e_side
                    } else if cand.2 != e_sub {
                        e_sub
                    } else {
                        false
                    };
                    if wins {
                        best.insert(key.clone(), cand);
                    }
                }
            }
        }
    }
    let mut drop_at: std::collections::HashMap<usize, Vec<String>> = std::collections::HashMap::new();
    for (fi, file) in files.iter().enumerate() {
        for key in file.acc.seen_ids.keys() {
            if best.get(key).map(|(w, _, _)| *w) != Some(fi) {
                drop_at.entry(fi).or_default().push(key.clone());
            }
        }
    }
    for (fi, keys) in drop_at {
        for key in keys {
            files[fi].acc.subtract_key(&key);
        }
    }
}

async fn scan_claude_logs(pool: &SqlitePool, root: &Path, cutoff: DateTime<Utc>) -> anyhow::Result<u64> {
    if !root.exists() {
        return Ok(0);
    }

    let repair = pricing_needs_forced_rescan(pool, "claude").await?;
    let paths = if repair { collect_pricing_repair_files(root)? }
        else { collect_recent_jsonl_files(root, cutoff) };
    let mut files: Vec<ClaudeFileAcc> = Vec::new();
    for file_path in paths {
        let content = match tokio::fs::read_to_string(&file_path).await {
            Ok(content) => content,
            Err(e) if repair => return Err(e.into()),
            Err(_) => continue,
        };

        let mut summary = ClaudeUsageAccumulator {
            from_subagent_path: file_path.components().any(|c| c.as_os_str() == "subagents"),
            ..Default::default()
        };
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            summary.ingest(&value);
        }

        if !summary.has_usage() {
            continue;
        }

        files.push(ClaudeFileAcc {
            path: file_path,
            acc: summary,
        });
    }

    reconcile_claude_files(&mut files);

    let mut upserted = 0;
    for file in files {
        if !file.acc.has_usage() {
            continue;
        }
        let captured_at = file
            .acc
            .active
            .last_captured_at()
            .unwrap_or_else(|| file_modified_datetime(&file.path));
        let thread_id = thread_id_from_path(&file.path);
        record_session_usage(
            pool,
            &thread_id,
            "claude",
            file.acc.model_name.as_deref(),
            file.acc.input_tokens,
            file.acc.output_tokens,
            file.acc.cache_creation_tokens,
            file.acc.cache_read_tokens,
            file.acc.cost_usd,
            file.acc.num_turns,
            file.acc.active.total_ms(),
            &captured_at,
        )
        .await?;
        upserted += 1;
    }

    if repair { mark_pricing_rescan_complete(pool, "claude").await?; }
    Ok(upserted)
}

fn ingest_codex_content(content: &str) -> CodexUsageAccumulator {
    let mut summary = CodexUsageAccumulator::default();
    let mut has_native_records = false;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        has_native_records |= value.get("type").and_then(Value::as_str) == Some("token_usage_record");
        summary.ingest(&value);
    }
    if has_native_records {
        let parsed = crate::teams::scan::codex::parse_session_ex(content, summary.thread_id.as_deref().unwrap_or(""), None);
        summary = CodexUsageAccumulator { thread_id: Some(parsed.session_id), model_name: summary.model_name, ..Default::default() };
        for event in parsed.events {
            summary.input_tokens += event.tokens_in;
            summary.output_tokens += event.tokens_out;
            summary.cached_input_tokens += event.cache_read;
            summary.cache_write_tokens += event.cache_write;
            summary.cost_usd += event.cost_usd;
            summary.num_turns += i64::from(event.is_turn);
            summary.active.push(event.at);
            if !event.model.is_empty() { summary.model_name = Some(event.model); }
        }
    }
    summary
}

async fn scan_codex_logs(pool: &SqlitePool, roots: &[PathBuf]) -> anyhow::Result<u64> {

    let repair = pricing_needs_forced_rescan(pool, "codex").await?;
    let mut summaries = std::collections::BTreeMap::<String, (PathBuf, usize, CodexUsageAccumulator)>::new();
    // Persisted Usage rows outlive the display window. Rebuild old, unchanged
    // rollouts too so arithmetic repairs replace their cached absolute totals.
    // The command's process-local TTL still bounds repeated scans.
    let mut paths = std::collections::BTreeSet::new();
    for root in roots {
        paths.extend(if repair { collect_pricing_repair_files(root)? }
            else { collect_recent_jsonl_files(root, DateTime::<Utc>::MIN_UTC) });
    }
    for file_path in paths {
        let content = match tokio::fs::read_to_string(&file_path).await {
            Ok(content) => content,
            Err(e) if repair => return Err(e.into()),
            Err(_) => continue,
        };
        // Forks have their own counters. A parent's later work must never
        // change the child's usage or suppress an independently billed child.
        let summary = ingest_codex_content(&content);

        let thread_id = summary.thread_id.clone().unwrap_or_else(|| thread_id_from_path(&file_path));
        // Active/archive/configured roots can contain copies of one session.
        // Keep the fuller rollout once, independent of root traversal order.
        if summaries.get(&thread_id).is_some_and(|(_, bytes, _)| *bytes >= content.len()) { continue; }
        summaries.insert(thread_id, (file_path, content.len(), summary));
    }

    let mut upserted = 0;
    for (thread_id, (file_path, _, summary)) in summaries {
        if !summary.has_usage() {
            // No reported usage is unknown, not zero. A reported snapshot that
            // is entirely copied history can, however, clear an old charge.
            if summary.counter.watermark.is_none() { continue; }
            let cached: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_usage WHERE thread_id=? AND provider='codex')")
                .bind(&thread_id).fetch_one(pool).await?;
            if !cached { continue; }
        }

        let captured_at = summary
            .active
            .last_captured_at()
            .unwrap_or_else(|| file_modified_datetime(&file_path));
        record_session_usage(
            pool,
            &thread_id,
            "codex",
            summary.model_name.as_deref(),
            summary.input_tokens,
            summary.output_tokens,
            summary.cache_write_tokens,
            summary.cached_input_tokens,
            summary.cost_usd,
            summary.num_turns,
            summary.active.total_ms(),
            &captured_at,
        )
        .await?;
        upserted += 1;
    }

    if repair && roots.iter().any(|root| root.is_dir()) {
        mark_pricing_rescan_complete(pool, "codex").await?;
    }
    Ok(upserted)
}

/// Scan `~/.grok/sessions/{encoded_cwd}/{session_id}/updates.jsonl`.
///
/// Map a Grok on-disk session UUID to the agmux `threads.id` used by live ACP
/// usage recording (`record_grok_turn_usage`). Prefers `sdk_session_id`, then
/// a direct id match (some rows use the provider session id as PK).
async fn resolve_grok_scan_thread_id(
    pool: &SqlitePool,
    provider_session_id: &str,
) -> anyhow::Result<String> {
    if let Some(id) = sqlx::query_scalar::<_, String>(
        "SELECT id FROM threads WHERE sdk_session_id = ? LIMIT 1",
    )
    .bind(provider_session_id)
    .fetch_optional(pool)
    .await?
    {
        return Ok(id);
    }
    if let Some(id) = sqlx::query_scalar::<_, String>(
        "SELECT id FROM threads WHERE id = ? LIMIT 1",
    )
    .bind(provider_session_id)
    .fetch_optional(pool)
    .await?
    {
        return Ok(id);
    }
    Ok(provider_session_id.to_string())
}

/// Grok terminal/chat native usage. Counters are prompt-scoped; share the
/// Teams snapshot arithmetic and retain only reported billable tokens/cost.
async fn scan_grok_logs(pool: &SqlitePool, root: &Path, cutoff: DateTime<Utc>) -> anyhow::Result<u64> {
    if !root.exists() {
        return Ok(0);
    }

    let repair = grok_needs_forced_rescan(pool).await?;
    // Repair all available lifetime rows, including files older than the
    // normal 30-day discovery window. Never reconstruct deleted sources.
    let cutoff = if repair { DateTime::<Utc>::MIN_UTC } else { cutoff };
    let mut upserted = 0;
    for updates_path in collect_recent_grok_updates_files(root, cutoff)? {
        use tokio::io::AsyncBufReadExt;
        let file = tokio::fs::File::open(&updates_path).await?;
        let mut lines = tokio::io::BufReader::new(file).lines();
        let mut summary = GrokUsageAccumulator::default();
        while let Some(line) = lines.next_line().await? {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            summary.ingest(&value);
        }

        if !summary.has_usage() {
            continue;
        }

        // Prefer model from summary.json when the stream never named one.
        if summary.model_name.is_none() {
            if let Some(session_dir) = updates_path.parent() {
                summary.model_name = read_grok_session_model(session_dir);
            }
        }

        let model_name = summary.model_name.as_deref().map(normalize_model_name);
        let cost = summary.cost_usd_from_ticks;

        let captured_at = summary
            .active
            .last_captured_at()
            .unwrap_or_else(|| file_modified_datetime(&updates_path));
        // Session id is the parent directory name (UUID), not "updates".
        let provider_session_id = updates_path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("unknown")
            .to_string();

        // Prefer agmux thread id (live ACP records by threads.id). Without
        // this, scan keys by provider UUID and get_usage_summary double-counts.
        let thread_id = resolve_grok_scan_thread_id(pool, &provider_session_id)
            .await
            .unwrap_or_else(|_| provider_session_id.clone());

        record_session_usage(
            pool,
            &thread_id,
            "grok",
            model_name.as_deref(),
            summary.input_tokens,
            summary.output_tokens,
            0,
            summary.cache_read_tokens,
            cost,
            summary.num_turns,
            summary.active.total_ms(),
            &captured_at,
        )
        .await?;

        // Drop dual-key orphans: live ACP uses threads.id, disk scan may use
        // the provider session UUID — both must not appear in the SUM.
        if thread_id != provider_session_id {
            sqlx::query(
                "DELETE FROM session_usage WHERE provider = 'grok' AND thread_id = ?",
            )
            .bind(&provider_session_id)
            .execute(pool)
            .await?;
        } else if summary.saw_real_billable {
            // Wrote under provider session id — drop estimate rows under any
            // agmux thread that points at this session.
            sqlx::query(
                "DELETE FROM session_usage
                 WHERE provider = 'grok'
                   AND cache_read_tokens = 0
                   AND thread_id IN (
                     SELECT id FROM threads WHERE sdk_session_id = ?
                   )",
            )
            .bind(&provider_session_id)
            .execute(pool)
            .await?;
        }

        upserted += 1;
    }

    // Final sweep: estimate-only rows that still shadow a real cached row for
    // the same Grok session (via threads.sdk_session_id).
    purge_grok_estimate_orphans(pool).await?;
    if repair {
        // Seal only after the complete walk, reads, upserts and alias cleanup.
        sqlx::query(
            "INSERT INTO teams_scan_cursor(path, offset_bytes, scanned_at) VALUES (?, 1, datetime('now'))
             ON CONFLICT(path) DO UPDATE SET offset_bytes = 1, scanned_at = excluded.scanned_at",
        )
        .bind(GROK_USAGE_REPAIR_KEY)
        .execute(pool)
        .await?;
    }

    Ok(upserted)
}

/// Remove only exact aliases shadowed by another row for the same Grok session.
/// Zero-cache rows without an exact counterpart must be preserved.
async fn purge_grok_estimate_orphans(pool: &SqlitePool) -> anyhow::Result<u64> {
    // 1) Dual-key: estimate under one id while the paired id has real cache.
    let dual = sqlx::query(
        "DELETE FROM session_usage
         WHERE provider = 'grok'
           AND cache_read_tokens = 0
           AND input_tokens > 0
           AND (
             thread_id IN (
               SELECT t.sdk_session_id FROM threads t
               INNER JOIN session_usage su
                 ON su.thread_id = t.id AND su.provider = 'grok' AND su.cache_read_tokens > 0
               WHERE t.sdk_session_id IS NOT NULL AND length(t.sdk_session_id) > 0
             )
             OR thread_id IN (
               SELECT t.id FROM threads t
               INNER JOIN session_usage su
                 ON su.thread_id = t.sdk_session_id
                AND su.provider = 'grok' AND su.cache_read_tokens > 0
               WHERE t.sdk_session_id IS NOT NULL AND length(t.sdk_session_id) > 0
             )
           )",
    )
    .execute(pool)
    .await?
    .rows_affected();

    // Zero cache is valid reported usage, not provenance for an estimate.
    // Never delete unrelated rows based on their size or another session's cache.
    Ok(dual)
}

/// Collect `updates.jsonl` files under `~/.grok/sessions/**` modified after `cutoff`.
fn collect_recent_grok_updates_files(root: &Path, cutoff: DateTime<Utc>) -> anyhow::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in WalkDir::new(root) {
        // A failed directory walk must not certify a partial repair as done.
        let path = entry?.into_path();
        if path.file_name().and_then(|n| n.to_str()) != Some("updates.jsonl") {
            continue;
        }
        let metadata = std::fs::metadata(&path)?;
        if metadata.is_file() && DateTime::<Utc>::from(metadata.modified()?) >= cutoff {
            files.push(path);
        }
    }
    Ok(files)
}

fn read_grok_session_model(session_dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(session_dir.join("summary.json")).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    value
        .get("current_model_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

// Use the same inclusive-input, reset and tick arithmetic as Teams.
use crate::teams::scan::grok::{parse_usage_snap as parse_grok_usage_snap, UsageSnap as GrokUsageSnap};

#[derive(Default)]
struct GrokUsageAccumulator {
    model_name: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    num_turns: i64,
    cost_usd_from_ticks: f64,
    saw_real_billable: bool,
    active: ActiveTimeAcc,
    pending_usage: std::collections::HashMap<String, GrokUsageSnap>,
    seen_events: std::collections::HashSet<String>,
}

impl GrokUsageAccumulator {
    fn ingest(&mut self, value: &Value) {
        let params = value.get("params").unwrap_or(value);
        let meta = params.get("_meta").unwrap_or(&Value::Null);
        let update = params.get("update").unwrap_or(&Value::Null);
        if let Some(id) = meta.get("eventId").and_then(Value::as_str) {
            if !self.seen_events.insert(id.to_string()) {
                return;
            }
        }
        if let Some(at) = grok_event_timestamp(value, meta) {
            self.active.push(at);
        }
        if let Some(model) = update.pointer("/_meta/modelId")
            .or_else(|| update.get("modelId")).and_then(Value::as_str)
            .or_else(|| {
                let models = update.pointer("/usage/modelUsage")?.as_object()?;
                if models.len() == 1 { models.keys().next().map(String::as_str) } else { None }
            })
        {
            if !model.is_empty() {
                self.model_name = Some(normalize_model_name(model));
            }
        }
        let canonical = update.get("usage").and_then(parse_grok_usage_snap);
        let Some(snap) = canonical.or_else(|| parse_grok_usage_snap(meta)) else {
            // Context totals retain activity above, never inferred billing.
            return;
        };
        self.saw_real_billable = true;
        let prompt = update.get("prompt_id").or_else(|| meta.get("promptId"))
            .and_then(Value::as_str).filter(|p| !p.is_empty());
        let delta = if canonical.is_some() || prompt.is_some() {
            let key = prompt.unwrap_or("").to_string();
            self.pending_usage.entry(key).or_default().observe(snap, prompt.is_none())
        } else {
            // Older ACP result metadata has per-prompt counts but no identity.
            snap
        };
        self.input_tokens += (delta.input - delta.cache).max(0);
        self.output_tokens += delta.output;
        self.cache_read_tokens += delta.cache;
        self.cost_usd_from_ticks += delta.cost_ticks as f64 / 10_000_000_000.0;
        self.num_turns += delta.num_turns;
        if snap.num_turns == 0 && !delta.is_empty() {
            self.num_turns += 1;
        }
    }

    fn has_usage(&self) -> bool {
        self.input_tokens > 0 || self.output_tokens > 0 || self.cache_read_tokens > 0
            || self.cost_usd_from_ticks > 0.0
    }
}

fn collect_recent_jsonl_files(root: &Path, cutoff: DateTime<Utc>) -> Vec<PathBuf> {
    WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .map(|entry| entry.into_path())
        .filter(|path| path.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
        .filter(|path| {
            std::fs::metadata(path)
                .and_then(|meta| meta.modified())
                .ok()
                .map(DateTime::<Utc>::from)
                .map(|modified| modified >= cutoff)
                .unwrap_or(true)
        })
        .collect()
}

fn file_modified_datetime(path: &Path) -> String {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .map(DateTime::<Utc>::from)
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| Utc::now().format("%Y-%m-%d %H:%M:%S").to_string())
}

fn thread_id_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown")
        .to_string()
}

fn normalize_model_name(name: &str) -> String {
    let name = name.trim();
    if let Some((base, suffix)) = name.rsplit_once('-') {
        if suffix.len() == 8 && suffix.chars().all(|c| c.is_ascii_digit()) {
            return base.to_string();
        }
    }
    name.to_string()
}

#[derive(Clone, Copy, Default)]
struct ClaudeKeyedRow {
    input: i64,
    output: i64,
    cache_create: i64,
    cache_read: i64,
    cost_usd: f64,
    is_sidechain: bool,
}

#[derive(Default)]
struct ClaudeUsageAccumulator {
    /// message.id:requestId → last-seen row. Streaming chunks share the key;
    /// the final cumulative chunk wins (CodexBar / ccusage).
    seen_ids: std::collections::HashMap<String, ClaudeKeyedRow>,
    model_name: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    cache_creation_tokens: i64,
    cache_read_tokens: i64,
    cost_usd: f64,
    num_turns: i64,
    from_subagent_path: bool,
    active: ActiveTimeAcc,
}

impl ClaudeUsageAccumulator {
    fn ingest(&mut self, value: &Value) {
        if let Some(ty) = value.get("type").and_then(Value::as_str) {
            if ty != "assistant" {
                return;
            }
        }

        let Some(message) = value.get("message").and_then(Value::as_object) else {
            return;
        };

        if let Some(model) = message.get("model").and_then(Value::as_str) {
            if model != "<synthetic>" {
                self.model_name = Some(normalize_model_name(model));
            }
        }

        let Some(usage) = message.get("usage") else {
            return;
        };

        let input = usage.get("input_tokens").and_then(Value::as_i64).unwrap_or(0);
        let output = usage.get("output_tokens").and_then(Value::as_i64).unwrap_or(0);
        let cache_create = usage
            .get("cache_creation_input_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let cache_read = usage
            .get("cache_read_input_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let cache_create_1h = claude_cache_write_1h(usage, cache_create);
        let five_m = (cache_create - cache_create_1h).max(0);
        let cost_usd = estimate_token_cost(
            self.model_name.as_deref(),
            TokenCostSpec {
                pure_input: input,
                pure_output: output,
                cache_read,
                cache_write: five_m,
                cache_write_1h: cache_create_1h,
            },
        );
        let row = ClaudeKeyedRow {
            input,
            output,
            cache_create,
            cache_read,
            cost_usd,
            is_sidechain: value.get("isSidechain").and_then(Value::as_bool).unwrap_or(false),
        };

        let dedupe_key = format!(
            "{}:{}",
            message.get("id").and_then(Value::as_str).unwrap_or(""),
            value.get("requestId").and_then(Value::as_str).unwrap_or("")
        );
        let replacing = if dedupe_key != ":" {
            if let Some(prev) = self.seen_ids.insert(dedupe_key, row) {
                self.subtract_row(&prev);
                true
            } else {
                false
            }
        } else {
            false
        };

        self.add_row(&row);
        if !replacing {
            self.num_turns += 1;
            if let Some(at) = event_timestamp(value) {
                self.active.push(at);
            }
        }
    }

    fn add_row(&mut self, row: &ClaudeKeyedRow) {
        self.input_tokens += row.input;
        self.output_tokens += row.output;
        self.cache_creation_tokens += row.cache_create;
        self.cache_read_tokens += row.cache_read;
        self.cost_usd += row.cost_usd;
    }

    fn subtract_row(&mut self, row: &ClaudeKeyedRow) {
        self.input_tokens -= row.input;
        self.output_tokens -= row.output;
        self.cache_creation_tokens -= row.cache_create;
        self.cache_read_tokens -= row.cache_read;
        self.cost_usd -= row.cost_usd;
    }

    fn subtract_key(&mut self, key: &str) {
        if let Some(row) = self.seen_ids.remove(key) {
            self.subtract_row(&row);
            self.num_turns = (self.num_turns - 1).max(0);
        }
    }

    fn has_usage(&self) -> bool {
        self.input_tokens > 0
            || self.output_tokens > 0
            || self.cache_creation_tokens > 0
            || self.cache_read_tokens > 0
    }
}

#[derive(Default)]
struct CodexUsageAccumulator {
    thread_id: Option<String>,
    header_seen: bool,
    history_boundary: CodexHistoryBoundary,
    model_name: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    cached_input_tokens: i64,
    cache_write_tokens: i64,
    cost_usd: f64,
    num_turns: i64,
    counter: CodexSessionCounter,
    active: ActiveTimeAcc,
}

impl CodexUsageAccumulator {
    fn ingest(&mut self, value: &Value) {
        let Some(payload) = value.get("payload").and_then(Value::as_object) else {
            return;
        };

        match value.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                // Copied ancestor headers are history, not this rollout's metadata.
                if self.header_seen { return; }
                self.header_seen = true;
                if self.thread_id.is_none() {
                    self.thread_id = payload
                        .get("id")
                        .or_else(|| payload.get("session_id"))
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned);
                }
                self.history_boundary = CodexHistoryBoundary::from_meta(&value["payload"]);
            }
            Some("turn_context") => {
                if let Some(model) = payload.get("model").and_then(Value::as_str) {
                    self.model_name = Some(normalize_model_name(model));
                }
            }
            Some("event_msg") => {
                if payload.get("type").and_then(Value::as_str) == Some("token_count") {
                    let at = event_timestamp(value);
                    let copied = self.history_boundary.is_copied(value);
                    self.ingest_token_count(payload, copied);
                    if !copied {
                        if let Some(at) = at { self.active.push(at); }
                    }
                }
            }
            _ => {}
        }
    }

    fn ingest_token_count(&mut self, payload: &serde_json::Map<String, Value>, copied: bool) {
        let Some(info) = payload.get("info").and_then(Value::as_object) else {
            return;
        };

        let totals = info
            .get("total_token_usage")
            .filter(|v| v.is_object())
            .map(CodexUsageFields::read);
        let last = info
            .get("last_token_usage")
            .filter(|v| v.is_object())
            .map(CodexUsageFields::read);

        let Some(delta) = self.counter.apply(last, totals) else {
            return;
        };
        if copied { return; }
        self.add_fields(delta);
        self.num_turns += 1;
    }

    fn add_fields(&mut self, fields: CodexUsageFields) {
        let (uncached, cached, write) = fields.split_input();
        self.input_tokens += uncached;
        self.output_tokens += fields.output;
        self.cached_input_tokens += cached;
        self.cache_write_tokens += write;
        self.cost_usd += estimate_token_cost(
            self.model_name.as_deref(),
            TokenCostSpec {
                pure_input: uncached,
                pure_output: fields.output,
                cache_read: cached,
                cache_write: write,
                cache_write_1h: 0,
            },
        );
    }

    fn has_usage(&self) -> bool {
        self.input_tokens > 0
            || self.output_tokens > 0
            || self.cached_input_tokens > 0
            || self.cache_write_tokens > 0
    }
}

#[cfg(test)]
mod tests {
    use super::{
        active_ms_from_stamps, calculate_pace_window, collect_recent_jsonl_files,
        event_timestamp, file_modified_datetime, model_pricing, normalize_model_name,
        parse_reset_timestamp_ms, record_grok_turn_usage, scan_claude_logs, scan_codex_logs,
        scan_grok_logs, thread_id_from_path, ACTIVE_GAP_CAP, ACTIVE_TAIL, ClaudeUsageAccumulator,
        CodexUsageAccumulator, CodexUsageFields, GrokUsageAccumulator,
        TokenCostSpec, estimate_token_cost,
    };
    use chrono::{DateTime, Duration, Utc};
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;
    use std::path::PathBuf;

    async fn fresh_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("failed to open in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migrations should apply cleanly");
        pool
    }

    #[test]
    fn normalizes_model_suffix_dates() {
        assert_eq!(normalize_model_name("claude-opus-4-1-20250301"), "claude-opus-4-1");
        assert_eq!(normalize_model_name("o4-mini"), "o4-mini");
    }

    #[test]
    fn parses_reset_timestamps_from_seconds_and_rfc3339() {
        assert_eq!(parse_reset_timestamp_ms("1771674185"), Some(1_771_674_185_000.0));
        assert!(parse_reset_timestamp_ms("2026-03-24T12:00:00Z").is_some());
    }

    #[test]
    fn codex_accumulator_handles_rollbacks_with_last_usage() {
        let mut accumulator = CodexUsageAccumulator::default();
        accumulator.ingest(&json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": { "input_tokens": 100, "output_tokens": 20, "cached_input_tokens": 5 },
                    "last_token_usage": { "input_tokens": 100, "output_tokens": 20, "cached_input_tokens": 5 }
                }
            }
        }));
        accumulator.ingest(&json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": { "input_tokens": 130, "output_tokens": 30, "cached_input_tokens": 7 },
                    "last_token_usage": { "input_tokens": 30, "output_tokens": 10, "cached_input_tokens": 2 }
                }
            }
        }));
        accumulator.ingest(&json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": { "input_tokens": 40, "output_tokens": 8, "cached_input_tokens": 1 },
                    "last_token_usage": { "input_tokens": 40, "output_tokens": 8, "cached_input_tokens": 1 }
                }
            }
        }));

        // Pure input (OpenAI input includes cache): (100-5)+(123-95)+(40-1)=95+28+39=162
        assert_eq!(accumulator.input_tokens, 162);
        assert_eq!(accumulator.output_tokens, 38);
        assert_eq!(accumulator.cached_input_tokens, 8);
    }

    #[test]
    fn pace_window_clamps_elapsed_progress() {
        let window = super::super::usage::UsageWindow {
            utilization: 40.0,
            resets_at: Some((Utc::now().timestamp() + 3_600).to_string()),
            window_minutes: Some(300),
        };
        let pace = calculate_pace_window(&window, 0.0);
        assert!(pace.expected_utilization >= 0.0);
        assert!(pace.expected_utilization <= 100.0);

        // With 20% reserve, expected should top out at 80%
        let pace_reserved = calculate_pace_window(&window, 20.0);
        assert!(pace_reserved.expected_utilization >= 0.0);
        assert!(pace_reserved.expected_utilization <= 80.0);
    }

    // ── model_pricing ────────────────────────────────────────────────────────

    #[test]
    fn model_pricing_opus() {
        let p = model_pricing("claude-opus-4-6");
        assert_eq!(p.input_per_mtok, 5.0);
        assert_eq!(p.output_per_mtok, 25.0);
    }

    #[test]
    fn model_pricing_haiku() {
        let p = model_pricing("claude-haiku-4-5");
        assert_eq!(p.input_per_mtok, 1.0);
        assert_eq!(p.output_per_mtok, 5.0);
    }

    #[test]
    fn model_pricing_sonnet() {
        let p = model_pricing("claude-sonnet-4-6");
        assert_eq!(p.input_per_mtok, 3.0);
        assert_eq!(p.output_per_mtok, 15.0);
    }

    #[test]
    fn model_pricing_grok_uses_real_xai_rates() {
        // Short-context rates from docs.x.ai/docs/pricing (2026-08-26).
        let p = model_pricing("grok-4.5");
        assert_eq!(p.input_per_mtok, 2.0);
        assert_eq!(p.output_per_mtok, 6.0);
        assert_eq!(p.cache_read_per_mtok, 0.30);
        // No write surcharge: disjoint writes still pay the ordinary input rate.
        assert_eq!(p.cache_write_per_mtok, 2.0);
        let p46 = model_pricing("grok-4.6");
        assert_eq!(p46.cache_read_per_mtok, 0.50, "4.6 cache reads are not 4.5's $0.30");
        assert_eq!((p46.input_per_mtok, p46.output_per_mtok), (2.0, 6.0));
        let p47 = model_pricing("grok-4.7");
        assert_eq!((p47.input_per_mtok, p47.output_per_mtok, p47.cache_read_per_mtok), (2.0, 6.0, 0.50));

        let build = model_pricing("grok-build-0.1");
        assert_eq!((build.input_per_mtok, build.output_per_mtok), (1.0, 2.0));

        let four_twenty = model_pricing("grok-4.20-0309-reasoning");
        assert_eq!((four_twenty.input_per_mtok, four_twenty.output_per_mtok), (1.25, 2.50));
    }

    #[test]
    fn pricing_audit_rejects_unverified_aliases_and_variants() {
        crate::pricing_catalog::test_clear_catalog();
        for model in ["grok-something-new", "grok-composer-2.5-fast", "composer-2",
            "claude-opus-999", "my-fable-model", "gpt-5.4-turbo", "gpt-5.4-pro",
            "gpt-5.6-cyber-unknown", "gpt-6-unknown", "codex", "o1-pro", "o3-pro",
            "gpt-4o-audio-preview", "custom/gpt-4.1", "gpt-5.1-codex-unknown"] {
            let p = model_pricing(model);
            assert_eq!(p.input_per_mtok, 0.0, "must not invent a rate: {model}");
        }
    }

    #[test]
    fn pricing_audit_verified_standard_rates() {
        // Independent official rate checks; tuple is input/output/cache read/cache write.
        for (model, expected) in [
            ("gpt-6-astra", (10.0, 50.0, 1.0, 12.5)),
            ("gpt-6-sol", (2.0, 10.0, 0.2, 2.5)),
            ("gpt-6-luna", (0.1, 0.5, 0.01, 0.125)),
            ("openai/gpt-6-sol", (2.0, 10.0, 0.2, 2.5)),
            ("openai/gpt-6-luna", (0.1, 0.5, 0.01, 0.125)),
            ("claude-opus-5-5", (4.0, 20.0, 0.2, 5.0)),
            ("anthropic/claude-opus-5-5-20260922", (4.0, 20.0, 0.2, 5.0)),
            ("gpt-5.6-sol", (4.0, 20.0, 0.4, 5.0)),
            ("gpt-5.1-codex", (1.25, 10.0, 0.125, 1.25)),
            ("gpt-5.2-codex", (1.75, 14.0, 0.175, 1.75)),
            ("gpt-5.5", (5.0, 30.0, 0.5, 5.0)),
            ("gpt-daybreak-blue-latest", (4.0, 20.0, 0.4, 5.0)),
            ("o1", (15.0, 60.0, 7.5, 15.0)),
            ("o3", (2.0, 8.0, 0.5, 2.0)),
            ("o3-mini", (1.1, 4.4, 0.55, 1.1)),
            ("o4-mini", (1.1, 4.4, 0.275, 1.1)),
            ("gpt-4o", (2.5, 10.0, 1.25, 2.5)),
            ("gpt-4o-mini", (0.15, 0.6, 0.075, 0.15)),
            ("gpt-4.1", (2.0, 8.0, 0.5, 2.0)),
            ("gpt-4.1-mini", (0.4, 1.6, 0.1, 0.4)),
            ("gpt-4.1-nano", (0.1, 0.4, 0.025, 0.1)),
            ("claude-opus-4-1", (15.0, 75.0, 1.5, 18.75)),
            ("claude-3-5-haiku-20241022", (0.8, 4.0, 0.08, 1.0)),
            ("anthropic/claude-fable-5.1", (10.0, 50.0, 0.25, 12.5)),
            (" OPENAI/GPT-4.1-2025-04-14 ", (2.0, 8.0, 0.5, 2.0)),
        ] {
            let p = model_pricing(model);
            assert_eq!((p.input_per_mtok, p.output_per_mtok, p.cache_read_per_mtok,
                p.cache_write_per_mtok), expected, "{model}");
        }
    }

    #[test]
    fn pricing_audit_cache_classes_and_openai_boundary() {
        let claude = estimate_token_cost(Some("claude-fable-5.1"), TokenCostSpec {
            pure_input: 10_000, pure_output: 20_000, cache_read: 30_000,
            cache_write: 40_000, cache_write_1h: 50_000,
        });
        assert!((claude - (0.1 + 1.0 + 0.0075 + 0.5 + 1.0)).abs() < 1e-9);
        for (model, input_rate, cache_read_rate, cache_write_rate) in [
            ("gpt-6-astra", 10.0, 1.0, 12.5),
            ("gpt-6-sol", 2.0, 0.2, 2.5),
            ("gpt-6-luna", 0.1, 0.01, 0.125),
        ] {
            for input in [271_999, 272_000, 272_001] {
                let mult = if input > 272_000 { 2.0 } else { 1.0 };
                let cost = estimate_token_cost(Some(model), TokenCostSpec {
                    pure_input: input - 2000, cache_read: 1000, cache_write: 1000,
                    ..Default::default()
                });
                let expected = ((input - 2000) as f64 * input_rate +
                    1000.0 * cache_read_rate + 1000.0 * cache_write_rate) / 1e6 * mult;
                assert!((cost - expected).abs() < 1e-9, "{model}: {input}");
            }
        }
    }

    #[test]
    fn pricing_audit_non_claude_does_not_invent_hour_cache_premium() {
        // TTL-specific Claude field must not impose Anthropic's 2x tariff
        // on another API. A reported write still uses that API's write rate.
        let cost = estimate_token_cost(Some("gpt-5.6-sol"), TokenCostSpec {
            cache_write_1h: 1000, ..Default::default()
        });
        assert!((cost - 0.005).abs() < 1e-9);
    }

    #[test]
    fn no_write_surcharge_still_bills_disjoint_write_tokens_as_input() {
        for model in ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-4.1", "o1", "grok-4.6"] {
            let rate = model_pricing(model).input_per_mtok;
            let cost = super::estimate_token_cost_checked(Some(model), TokenCostSpec {
                pure_input: 10, cache_write: 5, ..Default::default()
            }).unwrap();
            assert!((cost - 15.0 * rate / 1e6).abs() < 1e-12, "{model}: {cost}");
            assert!(!super::model_requires_cache_write_usage(model), "equal class rates need no split: {model}");
        }
    }

    #[test]
    fn cache_write_usage_requirement_uses_only_known_distinct_tariffs() {
        use super::model_requires_cache_write_usage;
        crate::pricing_catalog::test_clear_catalog();
        for model in ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
            "openai/gpt-5.6", "claude-sonnet-5"] {
            assert!(model_requires_cache_write_usage(model), "{model}");
        }
        for model in ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "grok-4.6",
            "gpt-6-unknown", "codex-auto-review", ""] {
            assert!(!model_requires_cache_write_usage(model), "{model}");
        }
        for rate in [None, Some(0.0), Some(0.5), Some(1.0), Some(1.25)] {
            crate::pricing_catalog::test_set_catalog(vec![("vendor/write-contract".into(),
                crate::pricing_catalog::CatalogPricing {
                    input_per_mtok: 1.0, output_per_mtok: 2.0,
                    cache_read_per_mtok: None, cache_write_per_mtok: rate,
                })]);
            assert_eq!(model_requires_cache_write_usage("vendor/write-contract"), rate.is_some_and(|rate| rate != 1.0));
        }
        crate::pricing_catalog::test_clear_catalog();
    }

    #[test]
    fn pricing_checked_distinguishes_missing_cache_rates_from_free() {
        use super::{estimate_token_cost_checked, TokenCostUnavailable};
        crate::pricing_catalog::test_set_catalog(vec![("vendor/coverage-test".into(),
            crate::pricing_catalog::CatalogPricing {
                input_per_mtok: 2.0, output_per_mtok: 5.0,
                cache_read_per_mtok: None, cache_write_per_mtok: Some(0.0),
            })]);
        let input = TokenCostSpec { pure_input: 1000, ..Default::default() };
        assert_eq!(estimate_token_cost_checked(Some("coverage-test"), input), Ok(0.002));
        assert_eq!(estimate_token_cost_checked(Some("coverage-test"), TokenCostSpec {
            cache_read: 100, ..input
        }), Err(TokenCostUnavailable::CacheReadPrice));
        assert_eq!(estimate_token_cost_checked(Some("coverage-test"), TokenCostSpec {
            cache_write: 100, ..input
        }), Ok(0.002));
        assert_eq!(estimate_token_cost_checked(Some("not-a-real-model"), input),
            Err(TokenCostUnavailable::ModelPrice));
        assert_eq!(estimate_token_cost_checked(Some("coverage-test"), TokenCostSpec {
            cache_write_1h: 100, ..input
        }), Err(TokenCostUnavailable::CacheWriteHourPrice));
        // Compatibility path must not output a misleading partial estimate.
        assert_eq!(estimate_token_cost(Some("coverage-test"), TokenCostSpec {
            cache_read: 100, ..input
        }), 0.0);
        crate::pricing_catalog::test_set_catalog(vec![("vendor/write-unknown".into(),
            crate::pricing_catalog::CatalogPricing {
                input_per_mtok: 0.0, output_per_mtok: 0.0,
                cache_read_per_mtok: Some(0.0), cache_write_per_mtok: None,
            })]);
        assert_eq!(estimate_token_cost_checked(Some("write-unknown"), input), Ok(0.0));
        assert_eq!(estimate_token_cost_checked(Some("write-unknown"), TokenCostSpec {
            cache_write: 100, ..input
        }), Err(TokenCostUnavailable::CacheWritePrice));
        crate::pricing_catalog::test_clear_catalog();
    }

    #[test]
    fn aggregated_pricing_requires_request_boundaries_above_short_context() {
        use super::{estimate_aggregated_token_cost_checked, TokenCostUnavailable};
        for (model, largest_short, input_rate, read_rate, output_rate) in [
            ("grok-4.6", 199_999, 2.0, 0.5, 6.0),
            ("gpt-6-astra", 272_000, 10.0, 1.0, 50.0),
        ] {
            let group = TokenCostSpec {
                pure_input: largest_short - 1000, cache_read: 1000, pure_output: 100,
                ..Default::default()
            };
            let expected = ((largest_short - 1000) as f64 * input_rate
                + 1000.0 * read_rate + 100.0 * output_rate) / 1e6;
            let actual = estimate_aggregated_token_cost_checked(Some(model), group).unwrap();
            assert!((actual - expected).abs() < 1e-9, "{model}");
            assert_eq!(estimate_aggregated_token_cost_checked(Some(model), TokenCostSpec {
                cache_read: 1001, ..group
            }), Err(TokenCostUnavailable::RequestBoundaries));
        }
        assert_eq!(estimate_aggregated_token_cost_checked(Some("grok-4.6"), TokenCostSpec {
            pure_input: 1_600_000, ..Default::default()
        }), Err(TokenCostUnavailable::RequestBoundaries));
        // No context tariff: linear grouped pricing remains valid.
        let linear = estimate_aggregated_token_cost_checked(Some("claude-sonnet-4-6"), TokenCostSpec {
            pure_input: 1_600_000, ..Default::default()
        }).unwrap();
        assert!((linear - 4.8).abs() < 1e-9);
    }

    #[test]
    fn pricing_audit_grok_threshold_is_inclusive() {
        for input in [199_999, 200_000, 200_001] {
            let rate = if input >= 200_000 { 4.0 } else { 2.0 };
            let cost = estimate_token_cost(Some("x-ai/grok-4.6"), TokenCostSpec {
                pure_input: input, ..Default::default()
            });
            assert!((cost - input as f64 / 1e6 * rate).abs() < 1e-9);
        }
    }

    #[tokio::test]
    async fn record_grok_turn_usage_splits_cache_and_accumulates() {
        let pool = fresh_pool().await;
        let result = json!({
            "_meta": {
                "inputTokens": 30407,
                "outputTokens": 100,
                "cachedReadTokens": 29440,
            }
        });
        record_grok_turn_usage(&pool, "thread-g1", Some("grok-4.5"), &result)
            .await
            .unwrap();
        record_grok_turn_usage(&pool, "thread-g1", Some("grok-4.5"), &result)
            .await
            .unwrap();

        let row: (i64, i64, i64, i64, f64) = sqlx::query_as(
            "SELECT input_tokens, output_tokens, cache_read_tokens, num_turns, total_cost_usd
             FROM session_usage WHERE thread_id = ?",
        )
        .bind("thread-g1")
        .fetch_one(&pool)
        .await
        .unwrap();
        // pure input = 30407 - 29440 = 967, accumulated twice
        assert_eq!(row.0, 967 * 2);
        assert_eq!(row.1, 200);
        assert_eq!(row.2, 29440 * 2);
        assert_eq!(row.3, 2);
        // No ticks were reported; do not fabricate a price for multiple calls.
        assert_eq!(row.4, 0.0);
    }

    #[tokio::test]
    async fn record_grok_turn_usage_skips_zero_meta() {
        let pool = fresh_pool().await;
        record_grok_turn_usage(&pool, "thread-g2", Some("grok-4.5"), &json!({}))
            .await
            .unwrap();
        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM session_usage WHERE thread_id = ?")
                .bind("thread-g2")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count.0, 0);
    }

    #[test]
    fn model_pricing_gpt_5_6_sol() {
        let p = model_pricing("gpt-5.6-sol");
        assert_eq!(p.input_per_mtok, 4.0);
        assert_eq!(p.output_per_mtok, 20.0);
        assert_eq!(p.cache_read_per_mtok, 0.40);
        assert_eq!(p.cache_write_per_mtok, 5.0);
        // Bare alias routes to Sol pricing.
        let alias = model_pricing("gpt-5.6");
        assert_eq!(alias.input_per_mtok, 4.0);
        assert_eq!(alias.output_per_mtok, 20.0);
    }

    #[test]
    fn model_pricing_gpt_5_6_terra() {
        // Post 2026-07-30 OpenAI cut: $2 / $12
        let p = model_pricing("gpt-5.6-terra");
        assert_eq!(p.input_per_mtok, 2.0);
        assert_eq!(p.output_per_mtok, 12.0);
        assert_eq!(p.cache_read_per_mtok, 0.20);
        assert_eq!(p.cache_write_per_mtok, 2.50);
    }

    #[test]
    fn model_pricing_gpt_5_6_luna() {
        // Post 2026-07-30 OpenAI cut: $0.20 / $1.20
        let p = model_pricing("gpt-5.6-luna");
        assert_eq!(p.input_per_mtok, 0.20);
        assert_eq!(p.output_per_mtok, 1.20);
        assert_eq!(p.cache_read_per_mtok, 0.02);
        assert_eq!(p.cache_write_per_mtok, 0.25);
    }

    #[test]
    fn model_pricing_claude_fable() {
        let p = model_pricing("claude-fable-5");
        assert_eq!(p.input_per_mtok, 10.0);
        assert_eq!(p.output_per_mtok, 50.0);
        assert_eq!(p.cache_read_per_mtok, 1.0);
    }

    #[test]
    fn model_pricing_sonnet_5_standard_not_sonnet_4_5() {
        let s5 = model_pricing("claude-sonnet-5");
        assert_eq!((s5.input_per_mtok, s5.output_per_mtok), (2.0, 10.0));
        // sonnet-4-5 must stay at standard $3/$15
        let s45 = model_pricing("claude-sonnet-4-5");
        assert_eq!((s45.input_per_mtok, s45.output_per_mtok), (3.0, 15.0));
    }

    #[test]
    fn model_pricing_gpt_5_4_mini_and_nano_not_flagship() {
        let mini = model_pricing("gpt-5.4-mini");
        assert_eq!((mini.input_per_mtok, mini.output_per_mtok), (0.75, 4.50));
        let nano = model_pricing("gpt-5.4-nano");
        assert_eq!((nano.input_per_mtok, nano.output_per_mtok), (0.20, 1.25));
        let flagship = model_pricing("gpt-5.4");
        assert_eq!((flagship.input_per_mtok, flagship.output_per_mtok), (2.50, 15.0));
    }

    #[test]
    fn grok_long_context_doubles_input_and_output() {
        let spec = TokenCostSpec {
            pure_input: 250_000,
            pure_output: 1_000_000,
            cache_read: 0,
            cache_write: 0,
            cache_write_1h: 0,
        };
        let cost = estimate_token_cost(Some("grok-4.6"), spec);
        let expected = 250_000.0 / 1e6 * 4.0 + 12.0;
        assert!((cost - expected).abs() < 1e-9, "got {cost}");
    }

    #[test]
    fn model_pricing_gpt_5_4() {
        let p = model_pricing("gpt-5.4");
        assert_eq!(p.input_per_mtok, 2.50);
        assert_eq!(p.output_per_mtok, 15.0);
        assert_eq!(p.cache_write_per_mtok, 2.50);
    }

    #[test]
    fn model_pricing_codex_mini_5_1() {
        let p = model_pricing("gpt-5.1-codex-mini");
        assert_eq!(p.input_per_mtok, 0.25);
        assert_eq!(p.output_per_mtok, 2.0);
    }

    #[test]
    fn model_pricing_codex_plain() {
        let p = model_pricing("codex");
        assert_eq!(p.input_per_mtok, 0.0);
        assert_eq!(p.output_per_mtok, 0.0);
    }

    #[test]
    fn model_pricing_o4_mini() {
        let p = model_pricing("o4-mini");
        assert_eq!(p.input_per_mtok, 1.10);
        assert_eq!(p.output_per_mtok, 4.40);
    }

    #[test]
    fn model_pricing_o3_mini() {
        let p = model_pricing("o3-mini");
        assert_eq!(p.input_per_mtok, 1.10);
        assert_eq!(p.output_per_mtok, 4.40);
    }

    #[test]
    fn model_pricing_o3() {
        let p = model_pricing("o3");
        assert_eq!(p.input_per_mtok, 2.0);
        assert_eq!(p.output_per_mtok, 8.0);
    }

    #[test]
    fn model_pricing_o1() {
        let p = model_pricing("o1");
        assert_eq!(p.input_per_mtok, 15.0);
        assert_eq!(p.output_per_mtok, 60.0);
    }

    #[test]
    fn model_pricing_gpt4o_mini() {
        let p = model_pricing("gpt-4o-mini");
        assert_eq!(p.input_per_mtok, 0.15);
        assert_eq!(p.output_per_mtok, 0.60);
    }

    #[test]
    fn model_pricing_gpt4_1_mini() {
        let p = model_pricing("gpt-4.1-mini");
        assert_eq!(p.input_per_mtok, 0.40);
        assert_eq!(p.output_per_mtok, 1.60);
    }

    #[test]
    fn model_pricing_gpt4_1_nano() {
        let p = model_pricing("gpt-4.1-nano");
        assert_eq!(p.input_per_mtok, 0.10);
        assert_eq!(p.output_per_mtok, 0.40);
    }

    #[test]
    fn model_pricing_gpt4o() {
        let p = model_pricing("gpt-4o");
        assert_eq!(p.input_per_mtok, 2.50);
        assert_eq!(p.output_per_mtok, 10.0);
    }

    #[test]
    fn model_pricing_gpt4_1() {
        let p = model_pricing("gpt-4.1");
        assert_eq!(p.input_per_mtok, 2.0);
        assert_eq!(p.output_per_mtok, 8.0);
    }

    #[test]
    fn model_pricing_unknown_is_unpriced_not_fabricated() {
        crate::pricing_catalog::test_clear_catalog();
        let p = model_pricing("totally-unknown-model-xyz-999");
        // Never invent Sonnet (or any) rates for unknowns.
        assert_eq!(p.input_per_mtok, 0.0);
        assert_eq!(p.output_per_mtok, 0.0);
        assert_eq!(p.cache_read_per_mtok, 0.0);
        assert_eq!(p.cache_write_per_mtok, 0.0);
    }

    #[test]
    fn model_pricing_uses_openrouter_catalog_on_miss() {
        crate::pricing_catalog::test_set_catalog(vec![(
            "some-new-frontier-9".into(),
            crate::pricing_catalog::CatalogPricing {
                input_per_mtok: 7.0,
                output_per_mtok: 21.0,
                cache_read_per_mtok: Some(0.7),
                cache_write_per_mtok: Some(8.75),
            },
        )]);
        let p = model_pricing("some-new-frontier-9");
        assert_eq!(p.input_per_mtok, 7.0);
        assert_eq!(p.output_per_mtok, 21.0);
        assert_eq!(p.cache_read_per_mtok, 0.7);
        crate::pricing_catalog::test_clear_catalog();
    }

    #[test]
    fn claude_1h_cache_is_billed_at_twice_input() {
        let spec = TokenCostSpec {
            pure_input: 0,
            pure_output: 0,
            cache_read: 0,
            cache_write: 0,
            cache_write_1h: 1_000_000,
        };
        let cost = estimate_token_cost(Some("claude-sonnet-4-6"), spec);
        assert!((cost - 6.0).abs() < 1e-9, "1h write is 2× $3 input, got {cost}");
    }

    #[test]
    fn sonnet_4_5_does_not_apply_retired_beta_premium() {
        let spec = TokenCostSpec {
            pure_input: 250_000,
            pure_output: 0,
            cache_read: 0,
            cache_write: 0,
            cache_write_1h: 0,
        };
        let cost = estimate_token_cost(Some("claude-sonnet-4-5"), spec);
        let expected = 250_000.0 / 1e6 * 3.0;
        assert!((cost - expected).abs() < 1e-9, "got {cost}");
    }

    #[test]
    fn gpt_56_sol_long_context_uses_1_5x_output() {
        let spec = TokenCostSpec {
            pure_input: 300_000,
            pure_output: 1_000_000,
            cache_read: 0,
            cache_write: 0,
            cache_write_1h: 0,
        };
        let cost = estimate_token_cost(Some("gpt-5.6-sol"), spec);
        let expected = 300_000.0 / 1e6 * 8.0 + 30.0;
        assert!((cost - expected).abs() < 1e-9, "got {cost}");
    }

    #[test]
    fn gpt_54_mini_has_no_long_context_step() {
        let spec = TokenCostSpec {
            pure_input: 300_000,
            pure_output: 0,
            cache_read: 0,
            cache_write: 0,
            cache_write_1h: 0,
        };
        let cost = estimate_token_cost(Some("gpt-5.4-mini"), spec);
        let expected = 300_000.0 / 1e6 * 0.75;
        assert!((cost - expected).abs() < 1e-9, "got {cost}");
    }

    #[test]
    fn local_usage_counts_native_response_records_once() {
        let header = json!({"type":"session_meta","payload":{"id":"owned"}});
        let context = json!({"type":"turn_context","payload":{"turn_id":"turn","model":"gpt-5"}});
        let record = json!({"type":"token_usage_record","timestamp":"2026-07-29T14:02:00Z",
            "payload":{"thread_id":"owned","turn_id":"turn","response_id":"response",
                "usage":{"input_tokens":30,"output_tokens":10}}});
        let summary = super::ingest_codex_content(&[header,context,record.clone(),record]
            .iter().map(serde_json::Value::to_string).collect::<Vec<_>>().join("\n"));
        assert_eq!((summary.input_tokens,summary.output_tokens,summary.num_turns),(30,10,1));
    }

    #[test]
    fn paginated_child_usage_ignores_retimestamped_parent_prefix() {
        let mut acc = CodexUsageAccumulator::default();
        acc.ingest(&json!({"type":"session_meta", "payload":{
            "id":"child", "forked_from_id":"parent", "timestamp":"2026-07-29T14:01:00Z",
            "history_mode":"paginated", "subagent_history_start_ordinal":10
        }}));
        for (ordinal, total, last) in [(5, 1000, 0), (8, 1100, 100), (10, 1130, 30)] {
            acc.ingest(&json!({"type":"event_msg", "ordinal":ordinal,
                "timestamp":"2026-07-29T14:02:00Z", "payload":{"type":"token_count", "info":{
                    "total_token_usage":{"input_tokens":total}, "last_token_usage":{"input_tokens":last}
                }}}));
        }
        assert_eq!(acc.input_tokens, 30);
        assert_eq!(acc.num_turns, 1);
    }

    #[test]
    fn codex_accumulator_excludes_only_usage_before_fork_creation() {
        let mut acc = CodexUsageAccumulator::default();
        acc.ingest(&json!({"type":"session_meta", "payload":{
            "id":"child", "session_id":"parent", "forked_from_id":"parent",
            "timestamp":"2026-07-29T14:01:00Z"
        }}));
        for (timestamp, input, last) in [("2026-07-29T14:00:00Z", 100, 100), ("2026-07-29T14:02:00Z", 150, 50)] {
            acc.ingest(&json!({"type":"event_msg", "timestamp":timestamp, "payload":{
                "type":"token_count", "info":{
                    "total_token_usage":{"input_tokens":input},
                    "last_token_usage":{"input_tokens":last}
                }
            }}));
        }
        assert_eq!(acc.thread_id.as_deref(), Some("child"));
        assert_eq!(acc.input_tokens, 50);
        assert_eq!(acc.num_turns, 1);
    }

    #[test]
    fn codex_accumulator_copied_fork_metadata_keeps_first_header() {
        for first_is_fork in [true, false] {
            let mut acc = CodexUsageAccumulator::default();
            acc.ingest(&json!({"type":"session_meta","payload":{
                "id":"child", "forked_from_id":if first_is_fork { Some("parent") } else { None },
                "timestamp":"2026-07-29T14:01:00Z"
            }}));
            acc.ingest(&json!({"type":"session_meta","payload":{
                "id":"parent", "forked_from_id":"grandparent", "timestamp":"2026-07-29T14:00:00Z"
            }}));
            for (timestamp, total, last) in [("2026-07-29T14:00:30Z", 100, 100), ("2026-07-29T14:02:00Z", 150, 50)] {
                acc.ingest(&json!({"type":"event_msg","timestamp":timestamp,"payload":{"type":"token_count","info":{
                    "total_token_usage":{"input_tokens":total},"last_token_usage":{"input_tokens":last}
                }}}));
            }
            assert_eq!(acc.thread_id.as_deref(), Some("child"));
            assert_eq!(acc.input_tokens, if first_is_fork { 50 } else { 150 });
            assert_eq!(acc.history_boundary.created_at.is_some(), first_is_fork);
        }
    }

    #[tokio::test]
    async fn scan_codex_logs_deduplicates_roots_and_keeps_fuller_session() {
        let pool = fresh_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let active = dir.path().join("sessions");
        let archived = dir.path().join("archived_sessions");
        let configured = dir.path().join("configured/sessions");
        for root in [&active, &archived, &configured] { std::fs::create_dir_all(root).unwrap(); }
        let log = |id: &str, totals: &[i64]| {
            let mut lines = vec![json!({"type":"session_meta","payload":{"id":id}}).to_string()];
            for input in totals {
                lines.push(json!({"type":"event_msg","payload":{"type":"token_count","info":{
                    "total_token_usage":{"input_tokens":input}
                }}}).to_string());
            }
            lines.join("\n")
        };
        std::fs::write(active.join("same-name.jsonl"), log("same-id", &[50])).unwrap();
        std::fs::write(archived.join("different-name.jsonl"), log("same-id", &[50, 150])).unwrap();
        std::fs::write(configured.join("same-name.jsonl"), log("other-id", &[30])).unwrap();
        for roots in [vec![archived.clone(), active.clone(), active.clone(), configured.clone()], vec![configured, active, archived]] {
            assert_eq!(scan_codex_logs(&pool, &roots).await.unwrap(), 2);
            let total: i64 = sqlx::query_scalar("SELECT SUM(input_tokens) FROM session_usage WHERE provider='codex'")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(total, 180);
        }
    }

    #[tokio::test]
    async fn scan_codex_logs_repairs_cached_usage_from_unchanged_old_file() {
        let pool = fresh_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old-child.jsonl");
        let old = "2026-01-01T00:00:00Z";
        let log = format!("{}\n{}\n",
            json!({"type":"session_meta","payload":{"id":"old-child"}}),
            json!({"type":"event_msg","timestamp":old,"payload":{"type":"token_count","info":{
                "total_token_usage":{"input_tokens":50},"last_token_usage":{"input_tokens":50}
            }}}));
        std::fs::write(&path, log).unwrap();
        let old_mtime = std::time::SystemTime::now() - std::time::Duration::from_secs(60 * 86400);
        std::fs::File::options().write(true).open(&path).unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old_mtime)).unwrap();
        for wrong_cached_tokens in [1, 999] {
            super::record_session_usage(&pool, "old-child", "codex", None, wrong_cached_tokens, 0, 0, 0, 0.0, 1, 0, old).await.unwrap();
            let updated = scan_codex_logs(&pool, &[dir.path().to_path_buf()]).await.unwrap();
            assert_eq!(updated, 1);
            let tokens: i64 = sqlx::query_scalar("SELECT input_tokens FROM session_usage WHERE thread_id='old-child'")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(tokens, 50);
        }
        assert_eq!(std::fs::metadata(path).unwrap().modified().unwrap(), old_mtime);
    }

    #[tokio::test]
    async fn scan_codex_logs_clears_cached_charge_for_only_copied_usage() {
        let pool = fresh_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let log = format!("{}\n{}\n",
            json!({"type":"session_meta","payload":{"id":"child","forked_from_id":"parent","timestamp":"2026-07-29T14:01:00Z"}}),
            json!({"type":"event_msg","timestamp":"2026-07-29T14:00:00Z","payload":{"type":"token_count","info":{
                "total_token_usage":{"input_tokens":500},"last_token_usage":{"input_tokens":500}
            }}}));
        std::fs::write(dir.path().join("child.jsonl"), log).unwrap();
        super::record_session_usage(&pool, "child", "codex", None, 500, 0, 0, 0, 0.0, 1, 0, "2026-07-29T14:00:00Z").await.unwrap();
        let updated = scan_codex_logs(&pool, &[dir.path().to_path_buf()]).await.unwrap();
        assert_eq!(updated, 1);
        let tokens: i64 = sqlx::query_scalar("SELECT input_tokens FROM session_usage WHERE thread_id='child'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(tokens, 0);
    }

    #[tokio::test]
    async fn scan_codex_logs_fork_usage_is_independent_of_parent_final() {
        let pool = fresh_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let log = |id: &str, parent: Option<&str>, input: i64| format!("{}\n{}\n",
            json!({"type":"session_meta","payload":{"id":id,"session_id":parent,"forked_from_id":parent,"timestamp":"2026-07-29T14:01:00Z"}}),
            json!({"type":"event_msg","timestamp":"2026-07-29T14:02:00Z","payload":{"type":"token_count","info":{
                "total_token_usage":{"input_tokens":input},"last_token_usage":{"input_tokens":input}
            }}}));
        std::fs::write(dir.path().join("child.jsonl"), log("child", Some("parent"), 50)).unwrap();
        for parent_total in [5000, 9000] {
            std::fs::write(dir.path().join("parent.jsonl"), log("parent", None, parent_total)).unwrap();
            scan_codex_logs(&pool, &[dir.path().to_path_buf()]).await.unwrap();
            let child: i64 = sqlx::query_scalar("SELECT input_tokens FROM session_usage WHERE thread_id='child' AND provider='codex'")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(child, 50);
        }
    }

    #[test]
    fn codex_fields_use_larger_cache_alias() {
        let f = CodexUsageFields::read(&json!({
            "input_tokens": 1000,
            "cached_input_tokens": 100,
            "cache_read_input_tokens": 400,
            "output_tokens": 20,
        }));
        assert_eq!(f.cached, 400);
        assert_eq!(f.split_input(), (600, 400, 0));
    }

    #[test]
    fn codex_fields_split_treats_writes_as_subset_of_uncached() {
        let f = CodexUsageFields::read(&json!({
            "input_tokens": 1000,
            "cached_input_tokens": 900,
            "cache_write_input_tokens": 10,
            "output_tokens": 50,
            "reasoning_output_tokens": 40,
        }));
        assert_eq!(f.split_input(), (90, 900, 10));
        assert_eq!(f.reasoning, 40);
    }

    #[test]
    fn codex_fields_cap_reasoning_at_output() {
        let f = CodexUsageFields::read(&json!({
            "input_tokens": 10,
            "output_tokens": 5,
            "reasoning_output_tokens": 50,
        }));
        assert_eq!(f.reasoning, 5);
    }

    // ── normalize_model_name ─────────────────────────────────────────────────

    #[test]
    fn normalize_strips_8_digit_date_suffix() {
        assert_eq!(normalize_model_name("claude-opus-4-1-20250301"), "claude-opus-4-1");
        assert_eq!(normalize_model_name("o4-mini-20251231"), "o4-mini");
    }

    #[test]
    fn normalize_keeps_non_date_suffix() {
        // "mini" is 4 chars, not 8 digits — must be kept
        assert_eq!(normalize_model_name("gpt-4o-mini"), "gpt-4o-mini");
        assert_eq!(normalize_model_name("o4-mini"), "o4-mini");
    }

    #[test]
    fn normalize_trims_whitespace() {
        assert_eq!(normalize_model_name("  claude-sonnet  "), "claude-sonnet");
    }

    #[test]
    fn normalize_empty_string() {
        assert_eq!(normalize_model_name(""), "");
    }

    #[test]
    fn normalize_no_dash() {
        assert_eq!(normalize_model_name("opus"), "opus");
    }

    #[test]
    fn normalize_partial_digit_suffix_kept() {
        // 7 digits — not exactly 8, should not be stripped
        assert_eq!(normalize_model_name("model-2025031"), "model-2025031");
    }

    // ── parse_reset_timestamp_ms ─────────────────────────────────────────────

    #[test]
    fn parse_reset_ts_unix_seconds_multiplied() {
        // Value > 10B → already ms, returned as-is
        // Value ≤ 10B → treated as seconds, multiplied by 1000
        let result = parse_reset_timestamp_ms("1771674185");
        assert_eq!(result, Some(1_771_674_185_000.0));
    }

    #[test]
    fn parse_reset_ts_already_ms() {
        // > 10_000_000_000 → returned as-is
        let result = parse_reset_timestamp_ms("1771674185999");
        assert_eq!(result, Some(1_771_674_185_999.0));
    }

    #[test]
    fn parse_reset_ts_rfc3339() {
        let result = parse_reset_timestamp_ms("2026-03-24T12:00:00Z");
        assert!(result.is_some());
        // Should be a reasonable ms timestamp (after 2020-01-01)
        assert!(result.unwrap() > 1_577_836_800_000.0);
    }

    #[test]
    fn parse_reset_ts_invalid_returns_none() {
        assert!(parse_reset_timestamp_ms("not-a-timestamp").is_none());
        assert!(parse_reset_timestamp_ms("").is_none());
    }

    // ── compute_expected_utilization ─────────────────────────────────────────

    #[test]
    fn compute_expected_utilization_none_resets_at_returns_half_target() {
        let result = super::compute_expected_utilization(None, Some(300), 100.0);
        assert!((result - 50.0).abs() < 1e-9, "got {}", result);
    }

    #[test]
    fn compute_expected_utilization_invalid_resets_at_returns_half_target() {
        let result = super::compute_expected_utilization(Some("garbage"), Some(300), 80.0);
        assert!((result - 40.0).abs() < 1e-9, "got {}", result);
    }

    #[test]
    fn compute_expected_utilization_at_end_of_window_returns_target() {
        // reset_at = now → elapsed = full window → expected = target
        let reset_at_ms = Utc::now().timestamp_millis() as f64;
        let reset_at_s = reset_at_ms / 1000.0; // seconds
        let result = super::compute_expected_utilization(
            Some(&reset_at_s.to_string()),
            Some(300),
            100.0,
        );
        // Should be close to 100% (small clock drift tolerance)
        assert!(result > 90.0, "expected near 100, got {}", result);
    }

    #[test]
    fn compute_expected_utilization_at_start_of_window_near_zero() {
        // reset_at = now + full_window → elapsed ≈ 0 → expected ≈ 0
        let reset_at_s = (Utc::now() + Duration::minutes(300)).timestamp() as f64;
        let result = super::compute_expected_utilization(
            Some(&reset_at_s.to_string()),
            Some(300),
            100.0,
        );
        assert!(result < 5.0, "expected near 0, got {}", result);
    }

    // ── calculate_pace_window (all 4 PaceStatus branches) ───────────────────

    fn make_window(utilization: f64) -> super::super::usage::UsageWindow {
        // Use a reset_at far in the future so expected_utilization ≈ 0,
        // making delta ≈ utilization, giving full control over the branch.
        let far_future = (Utc::now() + Duration::hours(10)).timestamp();
        super::super::usage::UsageWindow {
            utilization,
            resets_at: Some(far_future.to_string()),
            window_minutes: Some(300),
        }
    }

    #[test]
    fn pace_status_behind() {
        // utilization very low, expected ≈ 0 → delta < 0 → but we need delta < -1
        // Use a window that's almost over so expected ≈ 100, utilization = 0
        let reset_at_s = (Utc::now() + Duration::seconds(1)).timestamp() as f64;
        let window = super::super::usage::UsageWindow {
            utilization: 0.0,
            resets_at: Some(reset_at_s.to_string()),
            window_minutes: Some(300),
        };
        let pace = calculate_pace_window(&window, 0.0);
        assert!(matches!(pace.pace_status, super::PaceStatus::Behind));
        assert_eq!(pace.pace_label, "Behind pace");
    }

    #[test]
    fn pace_status_on_track() {
        // delta in [-1, 1]: utilization = expected (both near 0 with far future reset)
        let window = make_window(0.0); // expected ≈ 0, delta = 0 → OnTrack
        let pace = calculate_pace_window(&window, 0.0);
        assert!(matches!(pace.pace_status, super::PaceStatus::OnTrack));
        assert_eq!(pace.pace_label, "On track");
    }

    #[test]
    fn pace_status_two_percent_ahead_is_ahead() {
        // expected ≈ 0, utilization = 2 → delta ≈ 2, which should be called ahead.
        let window = make_window(2.0);
        let pace = calculate_pace_window(&window, 0.0);
        assert!(matches!(pace.pace_status, super::PaceStatus::Ahead));
        assert!(pace.pace_label.starts_with("Ahead of pace"));
    }

    #[test]
    fn pace_status_ahead() {
        // expected ≈ 0, utilization = 12 → delta = 12 → Ahead (1 < delta ≤ 20)
        let window = make_window(12.0);
        let pace = calculate_pace_window(&window, 0.0);
        assert!(matches!(pace.pace_status, super::PaceStatus::Ahead));
        assert!(pace.pace_label.starts_with("Ahead of pace"));
    }

    #[test]
    fn pace_status_well_over() {
        // expected ≈ 0, utilization = 50 → delta = 50 → WellOver (> 20)
        let window = make_window(50.0);
        let pace = calculate_pace_window(&window, 0.0);
        assert!(matches!(pace.pace_status, super::PaceStatus::WellOver));
        assert!(pace.pace_label.starts_with("Well over pace"));
    }

    // ── ClaudeUsageAccumulator ───────────────────────────────────────────────

    #[test]
    fn claude_accumulator_basic_token_accumulation() {
        let mut acc = ClaudeUsageAccumulator::default();
        acc.ingest(&json!({
            "requestId": "req-1",
            "message": {
                "id": "msg-1",
                "model": "claude-sonnet-4-6",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 50,
                    "cache_creation_input_tokens": 10,
                    "cache_read_input_tokens": 5
                }
            }
        }));
        assert_eq!(acc.input_tokens, 100);
        assert_eq!(acc.output_tokens, 50);
        assert_eq!(acc.cache_creation_tokens, 10);
        assert_eq!(acc.cache_read_tokens, 5);
        assert_eq!(acc.num_turns, 1);
        assert_eq!(acc.model_name.as_deref(), Some("claude-sonnet-4-6"));
    }

    #[test]
    fn claude_accumulator_deduplicates_same_id() {
        let mut acc = ClaudeUsageAccumulator::default();
        let entry = json!({
            "requestId": "req-1",
            "message": {
                "id": "msg-1",
                "model": "claude-sonnet-4-6",
                "usage": { "input_tokens": 100, "output_tokens": 50 }
            }
        });
        acc.ingest(&entry);
        acc.ingest(&entry); // duplicate — should be ignored
        assert_eq!(acc.input_tokens, 100);
        assert_eq!(acc.num_turns, 1);
    }

    #[test]
    fn claude_accumulator_streaming_last_chunk_wins() {
        let mut acc = ClaudeUsageAccumulator::default();
        acc.ingest(&json!({
            "type": "assistant",
            "requestId": "req-1",
            "message": {
                "id": "msg-1",
                "usage": { "input_tokens": 10, "output_tokens": 2 }
            }
        }));
        acc.ingest(&json!({
            "type": "assistant",
            "requestId": "req-1",
            "message": {
                "id": "msg-1",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 50,
                    "cache_read_input_tokens": 20
                }
            }
        }));
        assert_eq!(acc.input_tokens, 100);
        assert_eq!(acc.output_tokens, 50);
        assert_eq!(acc.cache_read_tokens, 20);
        assert_eq!(acc.num_turns, 1);
    }

    #[test]
    fn claude_accumulator_skips_non_assistant_types() {
        let mut acc = ClaudeUsageAccumulator::default();
        acc.ingest(&json!({
            "type": "user",
            "requestId": "req-1",
            "message": {
                "id": "msg-1",
                "usage": { "input_tokens": 999, "output_tokens": 1 }
            }
        }));
        assert_eq!(acc.input_tokens, 0);
        assert!(!acc.has_usage());
    }

    #[test]
    fn claude_accumulator_ignores_synthetic_model() {
        let mut acc = ClaudeUsageAccumulator::default();
        // First set a real model name
        acc.ingest(&json!({
            "requestId": "req-1",
            "message": {
                "id": "msg-1",
                "model": "claude-sonnet-4-6",
                "usage": { "input_tokens": 10, "output_tokens": 5 }
            }
        }));
        // Then a synthetic one — should not overwrite
        acc.ingest(&json!({
            "requestId": "req-2",
            "message": {
                "id": "msg-2",
                "model": "<synthetic>",
                "usage": { "input_tokens": 20, "output_tokens": 8 }
            }
        }));
        assert_eq!(acc.model_name.as_deref(), Some("claude-sonnet-4-6"));
    }

    #[test]
    fn claude_accumulator_missing_message_field_skipped() {
        let mut acc = ClaudeUsageAccumulator::default();
        acc.ingest(&json!({ "requestId": "req-1", "type": "ping" }));
        assert_eq!(acc.input_tokens, 0);
        assert_eq!(acc.num_turns, 0);
        assert!(!acc.has_usage());
    }

    #[test]
    fn claude_accumulator_missing_usage_field_skipped() {
        let mut acc = ClaudeUsageAccumulator::default();
        acc.ingest(&json!({
            "requestId": "req-1",
            "message": { "id": "msg-1", "model": "claude-sonnet-4-6" }
        }));
        assert_eq!(acc.input_tokens, 0);
        assert_eq!(acc.num_turns, 0);
    }

    #[test]
    fn claude_accumulator_accumulates_multiple_turns() {
        let mut acc = ClaudeUsageAccumulator::default();
        acc.ingest(&json!({
            "requestId": "req-1",
            "message": { "id": "msg-1", "usage": { "input_tokens": 100, "output_tokens": 20 } }
        }));
        acc.ingest(&json!({
            "requestId": "req-2",
            "message": { "id": "msg-2", "usage": { "input_tokens": 200, "output_tokens": 40 } }
        }));
        assert_eq!(acc.input_tokens, 300);
        assert_eq!(acc.output_tokens, 60);
        assert_eq!(acc.num_turns, 2);
    }

    #[test]
    fn active_ms_from_stamps_caps_idle_gaps_and_adds_tail() {
        let a = DateTime::parse_from_rfc3339("2026-08-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let b = a + Duration::minutes(2);
        let c = b + Duration::minutes(20); // idle — only the 5 min cap counts
        let ms = active_ms_from_stamps(&[a, b, c]);
        assert_eq!(
            ms,
            Duration::minutes(2).num_milliseconds()
                + ACTIVE_GAP_CAP.num_milliseconds()
                + ACTIVE_TAIL.num_milliseconds()
        );
    }

    #[test]
    fn active_ms_from_stamps_empty_is_zero() {
        assert_eq!(active_ms_from_stamps(&[]), 0);
    }

    #[test]
    fn claude_accumulator_records_active_ms_from_timestamps() {
        let mut acc = ClaudeUsageAccumulator::default();
        acc.ingest(&json!({
            "timestamp": "2026-08-25T12:00:00Z",
            "requestId": "req-1",
            "message": { "id": "msg-1", "usage": { "input_tokens": 10, "output_tokens": 2 } }
        }));
        acc.ingest(&json!({
            "timestamp": "2026-08-25T12:01:00Z",
            "requestId": "req-2",
            "message": { "id": "msg-2", "usage": { "input_tokens": 10, "output_tokens": 2 } }
        }));
        assert_eq!(
            acc.active.total_ms(),
            Duration::minutes(1).num_milliseconds() + ACTIVE_TAIL.num_milliseconds()
        );
    }

    #[test]
    fn event_timestamp_reads_rfc3339_and_unix() {
        assert!(event_timestamp(&json!({ "timestamp": "2026-08-25T12:00:00Z" })).is_some());
        assert!(event_timestamp(&json!({ "timestamp": 1_787_644_800 })).is_some());
        assert!(event_timestamp(&json!({ "timestamp": "nope" })).is_none());
    }

    #[test]
    fn claude_accumulator_has_usage_true_when_tokens_nonzero() {
        let mut acc = ClaudeUsageAccumulator::default();
        assert!(!acc.has_usage());
        acc.ingest(&json!({
            "requestId": "req-1",
            "message": { "id": "msg-1", "usage": { "input_tokens": 1, "output_tokens": 0 } }
        }));
        assert!(acc.has_usage());
    }

    #[test]
    fn claude_accumulator_dedupe_key_missing_both_ids() {
        // When both message.id and requestId are absent, dedupe_key = ":" which
        // is treated as invalid — entry should NOT be deduplicated (counted each time).
        let mut acc = ClaudeUsageAccumulator::default();
        let entry = json!({
            "message": { "usage": { "input_tokens": 10, "output_tokens": 5 } }
        });
        acc.ingest(&entry);
        acc.ingest(&entry);
        // Both should be counted since key is ":"
        assert_eq!(acc.input_tokens, 20);
        assert_eq!(acc.num_turns, 2);
    }

    // ── CodexUsageAccumulator ────────────────────────────────────────────────

    #[test]
    fn codex_accumulator_session_meta_extracts_thread_id() {
        let mut acc = CodexUsageAccumulator::default();
        acc.ingest(&json!({
            "type": "session_meta",
            "payload": { "id": "codex-thread-abc123" }
        }));
        assert_eq!(acc.thread_id.as_deref(), Some("codex-thread-abc123"));
    }

    #[test]
    fn codex_accumulator_session_meta_not_overwritten() {
        let mut acc = CodexUsageAccumulator::default();
        acc.ingest(&json!({ "type": "session_meta", "payload": { "id": "first" } }));
        acc.ingest(&json!({ "type": "session_meta", "payload": { "id": "second" } }));
        assert_eq!(acc.thread_id.as_deref(), Some("first"));
    }

    #[test]
    fn codex_accumulator_turn_context_extracts_model() {
        let mut acc = CodexUsageAccumulator::default();
        acc.ingest(&json!({
            "type": "turn_context",
            "payload": { "model": "codex-mini-20250531" }
        }));
        assert_eq!(acc.model_name.as_deref(), Some("codex-mini"));
    }

    #[test]
    fn codex_accumulator_first_event_uses_last_token_usage() {
        let mut acc = CodexUsageAccumulator::default();
        acc.ingest(&json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": { "input_tokens": 100, "output_tokens": 20, "cached_input_tokens": 5 },
                    "last_token_usage": { "input_tokens": 100, "output_tokens": 20, "cached_input_tokens": 5 }
                }
            }
        }));
        // First event: uses last_token_usage; pure = 100 - 5
        assert_eq!(acc.input_tokens, 95);
        assert_eq!(acc.output_tokens, 20);
        assert_eq!(acc.cached_input_tokens, 5);
    }

    #[test]
    fn codex_accumulator_subsequent_event_uses_delta() {
        let mut acc = CodexUsageAccumulator::default();
        // First event
        acc.ingest(&json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": { "input_tokens": 100, "output_tokens": 20, "cached_input_tokens": 0 },
                    "last_token_usage": { "input_tokens": 100, "output_tokens": 20, "cached_input_tokens": 0 }
                }
            }
        }));
        // Second event: total grew by 50/10/0 → delta
        acc.ingest(&json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": { "input_tokens": 150, "output_tokens": 30, "cached_input_tokens": 0 },
                    "last_token_usage": { "input_tokens": 50, "output_tokens": 10, "cached_input_tokens": 0 }
                }
            }
        }));
        assert_eq!(acc.input_tokens, 150); // 100 + 50
        assert_eq!(acc.output_tokens, 30); // 20 + 10
    }

    #[test]
    fn codex_accumulator_missing_total_falls_back_to_last() {
        let mut acc = CodexUsageAccumulator::default();
        acc.ingest(&json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": { "input_tokens": 77, "output_tokens": 33, "cached_input_tokens": 0 }
                }
            }
        }));
        assert_eq!(acc.input_tokens, 77);
        assert_eq!(acc.output_tokens, 33);
    }

    #[test]
    fn codex_accumulator_reads_cache_read_alias_and_splits_writes() {
        let mut acc = CodexUsageAccumulator::default();
        acc.ingest(&json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": {
                        "input_tokens": 1000,
                        "output_tokens": 50,
                        "cache_read_input_tokens": 900,
                        "cache_write_input_tokens": 10
                    }
                }
            }
        }));
        assert_eq!(acc.input_tokens, 90);
        assert_eq!(acc.cached_input_tokens, 900);
        assert_eq!(acc.cache_write_tokens, 10);
        assert_eq!(acc.output_tokens, 50);
    }

    #[test]
    fn codex_accumulator_ignores_non_token_count_event_msg() {
        let mut acc = CodexUsageAccumulator::default();
        acc.ingest(&json!({
            "type": "event_msg",
            "payload": { "type": "other_event", "info": {} }
        }));
        assert_eq!(acc.input_tokens, 0);
        assert_eq!(acc.num_turns, 0);
    }

    #[test]
    fn codex_accumulator_missing_payload_skipped() {
        let mut acc = CodexUsageAccumulator::default();
        acc.ingest(&json!({ "type": "event_msg" }));
        assert_eq!(acc.input_tokens, 0);
    }

    // ── collect_recent_jsonl_files ───────────────────────────────────────────

    #[test]
    fn collect_recent_jsonl_files_finds_recent_files() {
        let dir = tempfile::tempdir().unwrap();
        // Create a .jsonl file (mtime = now, which is after cutoff)
        let file = dir.path().join("test.jsonl");
        std::fs::write(&file, b"{}").unwrap();

        let cutoff = Utc::now() - Duration::days(1);
        let files = collect_recent_jsonl_files(dir.path(), cutoff);
        assert!(!files.is_empty(), "should find the recent .jsonl file");
        assert!(files.iter().any(|p| p == &file));
    }

    #[test]
    fn collect_recent_jsonl_files_excludes_non_jsonl() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("test.txt"), b"{}").unwrap();
        std::fs::write(dir.path().join("test.json"), b"{}").unwrap();

        let cutoff = Utc::now() - Duration::days(1);
        let files = collect_recent_jsonl_files(dir.path(), cutoff);
        assert!(files.is_empty(), "should not return non-.jsonl files");
    }

    #[test]
    fn collect_recent_jsonl_files_empty_for_missing_dir() {
        let files = collect_recent_jsonl_files(
            PathBuf::from("/this/path/does/not/exist/xyz987").as_path(),
            Utc::now() - Duration::days(1),
        );
        assert!(files.is_empty());
    }

    // ── file_modified_datetime ───────────────────────────────────────────────

    #[test]
    fn file_modified_datetime_returns_formatted_string() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("ts.txt");
        std::fs::write(&file, b"x").unwrap();
        let ts = file_modified_datetime(&file);
        // Should be "YYYY-MM-DD HH:MM:SS" format
        assert_eq!(ts.len(), 19, "unexpected format: {}", ts);
        assert!(ts.contains('-') && ts.contains(':'), "unexpected format: {}", ts);
    }

    #[test]
    fn file_modified_datetime_falls_back_for_missing_file() {
        // Should return a valid timestamp even for a missing file (falls back to now)
        let ts = file_modified_datetime(PathBuf::from("/nonexistent/path.jsonl").as_path());
        assert_eq!(ts.len(), 19, "fallback format wrong: {}", ts);
    }

    // ── thread_id_from_path ──────────────────────────────────────────────────

    #[test]
    fn thread_id_from_path_strips_extension() {
        let path = PathBuf::from("/some/dir/abc123.jsonl");
        assert_eq!(thread_id_from_path(&path), "abc123");
    }

    #[test]
    fn thread_id_from_path_no_extension() {
        let path = PathBuf::from("/some/dir/abc123");
        assert_eq!(thread_id_from_path(&path), "abc123");
    }

    #[test]
    fn thread_id_from_path_just_filename() {
        let path = PathBuf::from("myfile.jsonl");
        assert_eq!(thread_id_from_path(&path), "myfile");
    }

    // ── scan_claude_logs / scan_codex_logs (DB-backed) ────────────────────────

    #[tokio::test]
    async fn scan_claude_logs_returns_zero_for_missing_root() {
        let pool = fresh_pool().await;
        let cutoff = Utc::now() - Duration::days(30);
        let count = scan_claude_logs(&pool, &PathBuf::from("/this/does/not/exist/xxx"), cutoff)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn scan_codex_logs_returns_zero_for_missing_root() {
        let pool = fresh_pool().await;
        let count = scan_codex_logs(&pool, &[PathBuf::from("/this/does/not/exist/yyy")])
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn scan_claude_logs_zero_for_empty_dir() {
        let pool = fresh_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let cutoff = Utc::now() - Duration::days(30);
        let count = scan_claude_logs(&pool, dir.path(), cutoff).await.unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn scan_claude_logs_skips_files_without_usage() {
        let pool = fresh_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let session_path = dir.path().join("noop.jsonl");
        // Lines without `message.usage` -> ingest is a no-op, has_usage() = false
        std::fs::write(
            &session_path,
            r#"{"type":"user","message":{"content":"hi"}}
{"type":"system","content":"x"}
"#,
        )
        .unwrap();
        let cutoff = Utc::now() - Duration::days(30);
        let count = scan_claude_logs(&pool, dir.path(), cutoff).await.unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn local_usage_views_put_cache_writes_in_input() {
        let pool = fresh_pool().await;
        let captured = Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
        super::record_session_usage(&pool, "split-test", "claude", Some("claude-sonnet-4-6"),
            10, 20, 5, 3, 1.25, 1, 100, &captured).await.unwrap();
        let summary = super::load_usage_summary(&pool, "claude", 7).await.unwrap();
        assert_eq!((summary.total_input_tokens, summary.total_output_tokens), (18, 20));
        assert_eq!((summary.daily_breakdown[0].input_tokens, summary.daily_breakdown[0].output_tokens), (18, 20));
        let models = super::load_model_breakdown(&pool, "claude", 7).await.unwrap();
        assert_eq!((models[0].input_tokens, models[0].output_tokens, models[0].total_tokens), (18, 20, 38));
    }

    #[tokio::test]
    async fn local_usage_preserves_zero_cost_instead_of_repricing_sums() {
        let pool = fresh_pool().await;
        let captured = Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
        for id in ["zero-a", "zero-b"] {
            super::record_session_usage(&pool, id, "codex", Some("gpt-6-astra"),
                200_000, 50, 1000, 500, 0.0, 1, 100, &captured).await.unwrap();
        }
        let summary = super::load_usage_summary(&pool, "codex", 7).await.unwrap();
        assert_eq!(summary.total_cost_usd, 0.0);
        assert_eq!(summary.daily_breakdown[0].cost_usd, 0.0);
        super::record_session_usage(&pool, "priced", "codex", Some("gpt-6-astra"),
            10, 20, 0, 0, 1.25, 1, 100, &captured).await.unwrap();
        let summary = super::load_usage_summary(&pool, "codex", 7).await.unwrap();
        assert_eq!(summary.total_cost_usd, 1.25);
        assert_eq!(summary.daily_breakdown[0].cost_usd, 1.25);
    }

    #[tokio::test]
    async fn pricing_revision_bypasses_recent_scan_and_is_provider_scoped() {
        let pool = fresh_pool().await;
        let now = std::time::Instant::now();
        assert!(super::pricing_needs_forced_rescan(&pool, "claude").await.unwrap());
        assert!(!super::usage_scan_is_cached(Some(&now), true));
        super::mark_pricing_rescan_complete(&pool, "claude").await.unwrap();
        assert!(!super::pricing_needs_forced_rescan(&pool, "claude").await.unwrap());
        assert!(super::usage_scan_is_cached(Some(&now), false));
        assert!(super::pricing_needs_forced_rescan(&pool, "codex").await.unwrap());
        sqlx::query("UPDATE teams_scan_cursor SET offset_bytes=? WHERE path='usage-stats:pricing:claude'")
            .bind(super::USAGE_PRICING_REVISION - 1).execute(&pool).await.unwrap();
        assert!(super::pricing_needs_forced_rescan(&pool, "claude").await.unwrap());
    }

    #[tokio::test]
    async fn pricing_revision_failure_retries_and_missing_logs_keep_original_cost() {
        let pool = fresh_pool().await;
        let dir = tempfile::tempdir().unwrap();
        super::record_session_usage(&pool, "missing-source", "claude", Some("claude-opus-4-1"),
            10, 20, 0, 0, 321.0, 1, 0, "2026-07-01 00:00:00").await.unwrap();
        let broken = dir.path().join("broken.jsonl");
        std::fs::write(&broken, [0xff]).unwrap();
        assert!(scan_claude_logs(&pool, dir.path(), Utc::now()).await.is_err());
        assert!(super::pricing_needs_forced_rescan(&pool, "claude").await.unwrap());
        assert!(scan_codex_logs(&pool, &[dir.path().to_path_buf()]).await.is_err());
        assert!(super::pricing_needs_forced_rescan(&pool, "codex").await.unwrap());
        std::fs::remove_file(broken).unwrap();
        assert_eq!(scan_claude_logs(&pool, dir.path(), Utc::now()).await.unwrap(), 0);
        let cost: f64 = sqlx::query_scalar("SELECT total_cost_usd FROM session_usage WHERE thread_id='missing-source'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(cost, 321.0, "missing request detail cannot be repriced from totals");
    }

    #[tokio::test]
    async fn pricing_revision_rebuilds_old_claude_requests_with_hour_cache() {
        let pool = fresh_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("closed-priced.jsonl");
        std::fs::write(&path, json!({"type":"assistant","message":{
            "id":"old-request", "model":"claude-fable-5-1", "usage":{
                "input_tokens":1000,"output_tokens":1000,"cache_read_input_tokens":1000,
                "cache_creation_input_tokens":2000,
                "cache_creation":{"ephemeral_1h_input_tokens":1000}
            }
        }}).to_string()).unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60 * 86400);
        std::fs::File::options().write(true).open(&path).unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old)).unwrap();
        super::record_session_usage(&pool, "closed-priced", "claude", Some("claude-fable-5-1"),
            1000, 1000, 2000, 1000, 999.0, 1, 0, "2026-07-01 00:00:00").await.unwrap();
        assert_eq!(scan_claude_logs(&pool, dir.path(), Utc::now() - Duration::days(30)).await.unwrap(), 1);
        let cost: f64 = sqlx::query_scalar("SELECT total_cost_usd FROM session_usage WHERE thread_id='closed-priced'")
            .fetch_one(&pool).await.unwrap();
        assert!((cost - 0.09275).abs() < 1e-9, "{cost}");
    }

    #[tokio::test]
    async fn scan_claude_logs_records_usage_for_valid_jsonl() {
        let pool = fresh_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let session_path = dir.path().join("abc-123.jsonl");
        let line = serde_json::to_string(&json!({
            "type": "assistant",
            "message": {
                "id": "msg-1",
                "model": "claude-sonnet-4-20250514",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 50,
                    "cache_creation_input_tokens": 10,
                    "cache_read_input_tokens": 5,
                }
            }
        }))
        .unwrap();
        std::fs::write(&session_path, format!("{}\n", line)).unwrap();
        let cutoff = Utc::now() - Duration::days(30);
        let count = scan_claude_logs(&pool, dir.path(), cutoff).await.unwrap();
        assert_eq!(count, 1);

        // Verify the row was inserted
        let row: (String, String, i64, i64) = sqlx::query_as(
            "SELECT thread_id, provider, input_tokens, output_tokens FROM session_usage WHERE thread_id = ?",
        )
        .bind("abc-123")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, "abc-123");
        assert_eq!(row.1, "claude");
        assert_eq!(row.2, 100);
        assert_eq!(row.3, 50);
    }

    #[tokio::test]
    async fn scan_claude_logs_skips_invalid_json_lines() {
        let pool = fresh_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let session_path = dir.path().join("mixed.jsonl");
        // First line is invalid JSON, second is valid usage row.
        let valid = serde_json::to_string(&json!({
            "type": "assistant",
            "message": {
                "id": "msg-1",
                "model": "claude-haiku-4-5",
                "usage": {"input_tokens": 7, "output_tokens": 11}
            }
        }))
        .unwrap();
        std::fs::write(&session_path, format!("not json\n\n{}\n", valid)).unwrap();
        let cutoff = Utc::now() - Duration::days(30);
        let count = scan_claude_logs(&pool, dir.path(), cutoff).await.unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn scan_codex_logs_records_usage_for_valid_jsonl() {
        let pool = fresh_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let session_path = dir.path().join("codex-sess.jsonl");
        // Codex format: payload.type=token_count with info.{total_token_usage,last_token_usage}.
        let session_meta = serde_json::to_string(&json!({
            "type": "session_meta",
            "payload": {
                "id": "thread-xyz",
            }
        }))
        .unwrap();
        let token_count = serde_json::to_string(&json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": 200,
                        "output_tokens": 80,
                        "cached_input_tokens": 20
                    },
                    "last_token_usage": {
                        "input_tokens": 200,
                        "output_tokens": 80,
                        "cached_input_tokens": 20
                    }
                }
            }
        }))
        .unwrap();
        std::fs::write(
            &session_path,
            format!("{}\n{}\n", session_meta, token_count),
        )
        .unwrap();
        let count = scan_codex_logs(&pool, &[dir.path().to_path_buf()]).await.unwrap();
        assert_eq!(count, 1);

        let row: (String, String, i64, i64) = sqlx::query_as(
            "SELECT thread_id, provider, input_tokens, output_tokens FROM session_usage WHERE provider = 'codex'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        // Codex should derive thread_id from session_meta payload.id when present.
        assert!(row.0 == "thread-xyz" || row.0 == "codex-sess");
        assert_eq!(row.1, "codex");
        // Codex input includes cached tokens; we store pure (uncached) input.
        assert_eq!(row.2, 180);
        assert_eq!(row.3, 80);
    }

    #[tokio::test]
    async fn scan_codex_logs_skips_files_without_usage() {
        let pool = fresh_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let session_path = dir.path().join("empty.jsonl");
        std::fs::write(&session_path, "{\"type\":\"session_meta\",\"payload\":{}}\n").unwrap();
        let count = scan_codex_logs(&pool, &[dir.path().to_path_buf()]).await.unwrap();
        assert_eq!(count, 0);
        super::record_session_usage(&pool, "empty", "codex", None, 100, 0, 0, 0, 0.0, 1, 0, "2026-07-29T14:00:00Z").await.unwrap();
        assert_eq!(scan_codex_logs(&pool, &[dir.path().to_path_buf()]).await.unwrap(), 0);
        let cached: i64 = sqlx::query_scalar("SELECT input_tokens FROM session_usage WHERE thread_id='empty'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(cached, 100, "missing usage must not erase a previously reported charge");
    }

    #[tokio::test]
    async fn scan_claude_logs_handles_unreadable_file() {
        // A directory named *.jsonl will cause read_to_string to fail; should
        // be silently skipped without halting the scan.
        let pool = fresh_pool().await;
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("notafile.jsonl")).unwrap();
        let cutoff = Utc::now() - Duration::days(30);
        let count = scan_claude_logs(&pool, dir.path(), cutoff).await.unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn scan_codex_logs_handles_unreadable_file() {
        let pool = fresh_pool().await;
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("dir.jsonl")).unwrap();
        let count = scan_codex_logs(&pool, &[dir.path().to_path_buf()]).await.unwrap();
        assert_eq!(count, 0);
    }

    // ── Grok usage accumulator / scan ────────────────────────────────────────

    #[test]
    fn grok_accumulator_does_not_bill_context_segments() {
        let mut acc = GrokUsageAccumulator::default();
        // Segment 1: start at 1000, tool call jumps to 1200 → input 1000, output 200
        acc.ingest(&json!({
            "params": {
                "_meta": {
                    "totalTokens": 1000,
                    "promptId": "p1",
                    "updateType": "AgentThoughtChunk"
                }
            }
        }));
        acc.ingest(&json!({
            "params": {
                "_meta": {
                    "totalTokens": 1000,
                    "promptId": "p1",
                    "updateType": "AgentMessageChunk"
                }
            }
        }));
        acc.ingest(&json!({
            "params": {
                "_meta": {
                    "totalTokens": 1200,
                    "promptId": "p1",
                    "updateType": "ToolCall"
                }
            }
        }));
        // Tool results grow context — must not count as output.
        acc.ingest(&json!({
            "params": {
                "_meta": {
                    "totalTokens": 5000,
                    "promptId": "p1",
                    "updateType": "ToolCallUpdate"
                }
            }
        }));
        // Segment 2
        acc.ingest(&json!({
            "params": {
                "_meta": {
                    "totalTokens": 5000,
                    "promptId": "p1",
                    "updateType": "AgentThoughtChunk"
                }
            }
        }));
        acc.ingest(&json!({
            "params": {
                "update": { "sessionUpdate": "turn_completed" },
                "_meta": { "eventId": "x" }
            }
        }));

        assert_eq!(acc.input_tokens, 0);
        assert_eq!(acc.output_tokens, 0);
        assert_eq!(acc.num_turns, 0);
        assert!(!acc.has_usage());
    }

    #[test]
    fn grok_accumulator_prefers_real_billable_meta() {
        let mut acc = GrokUsageAccumulator::default();
        acc.ingest(&json!({
            "params": {
                "_meta": {
                    "inputTokens": 30407,
                    "outputTokens": 100,
                    "cachedReadTokens": 29440,
                    "promptId": "p-real"
                }
            }
        }));
        assert!(acc.saw_real_billable);
        assert_eq!(acc.input_tokens, 30407 - 29440);
        assert_eq!(acc.output_tokens, 100);
        assert_eq!(acc.cache_read_tokens, 29440);
        assert_eq!(acc.num_turns, 1);
    }

    #[test]
    fn grok_accumulator_reads_turn_completed_usage_with_cache() {
        let mut acc = GrokUsageAccumulator::default();
        // Mid-turn totalTokens noise — must be ignored once real usage exists.
        acc.ingest(&json!({
            "params": {
                "_meta": {
                    "totalTokens": 50000,
                    "updateType": "AgentThoughtChunk",
                    "promptId": "p1"
                }
            }
        }));
        acc.ingest(&json!({
            "params": {
                "update": {
                    "sessionUpdate": "turn_completed",
                    "usage": {
                        "inputTokens": 145113,
                        "outputTokens": 1011,
                        "cachedReadTokens": 69248,
                        "numTurns": 2,
                        "costUsdTicks": 1785704000i64,
                        "modelUsage": { "grok-4.5-build": {} }
                    }
                }
            }
        }));
        assert!(acc.saw_real_billable);
        assert_eq!(acc.input_tokens, 145113 - 69248);
        assert_eq!(acc.output_tokens, 1011);
        assert_eq!(acc.cache_read_tokens, 69248);
        assert_eq!(acc.num_turns, 2);
        assert!((acc.cost_usd_from_ticks - 0.1785704).abs() < 1e-9);
        assert_eq!(acc.model_name.as_deref(), Some("grok-4.5-build"));
    }

    #[test]
    fn grok_accumulator_sums_usage_segments_on_counter_reset() {
        let mut acc = GrokUsageAccumulator::default();
        // Growing cumulative segment.
        acc.ingest(&json!({
            "params": {
                "update": {
                    "sessionUpdate": "turn_completed",
                    "usage": {
                        "inputTokens": 1000,
                        "outputTokens": 10,
                        "cachedReadTokens": 800,
                        "numTurns": 2,
                        "costUsdTicks": 1000000000i64
                    }
                }
            }
        }));
        acc.ingest(&json!({
            "params": {
                "update": {
                    "sessionUpdate": "turn_completed",
                    "usage": {
                        "inputTokens": 5000,
                        "outputTokens": 50,
                        "cachedReadTokens": 4000,
                        "numTurns": 10,
                        "costUsdTicks": 5000000000i64
                    }
                }
            }
        }));
        // Reset (e.g. /clear) — commit previous peak, start new segment.
        acc.ingest(&json!({
            "params": {
                "update": {
                    "sessionUpdate": "turn_completed",
                    "usage": {
                        "inputTokens": 2000,
                        "outputTokens": 20,
                        "cachedReadTokens": 1500,
                        "numTurns": 3,
                        "costUsdTicks": 2000000000i64
                    }
                }
            }
        }));
        // Segment A (final): pure 1000 + cache 4000 + out 50
        // Segment B: pure 500 + cache 1500 + out 20
        assert_eq!(acc.input_tokens, (5000 - 4000) + (2000 - 1500));
        assert_eq!(acc.output_tokens, 50 + 20);
        assert_eq!(acc.cache_read_tokens, 4000 + 1500);
        assert_eq!(acc.num_turns, 10 + 3);
        assert!((acc.cost_usd_from_ticks - 0.7).abs() < 1e-9);
    }

    #[tokio::test]
    async fn scan_grok_logs_returns_zero_for_missing_root() {
        let pool = fresh_pool().await;
        let cutoff = Utc::now() - Duration::days(30);
        let count = scan_grok_logs(&pool, &PathBuf::from("/this/does/not/exist/grok"), cutoff)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn scan_grok_logs_does_not_record_estimated_usage_from_updates() {
        let pool = fresh_pool().await;
        let dir = tempfile::tempdir().unwrap();
        // Mirror ~/.grok/sessions/{cwd}/{session_id}/updates.jsonl
        let session_dir = dir
            .path()
            .join("%2Ftmp%2Fproj")
            .join("sess-grok-1");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(
            session_dir.join("summary.json"),
            r#"{"current_model_id":"grok-4.5"}"#,
        )
        .unwrap();
        let updates = session_dir.join("updates.jsonl");
        let lines = [
            r#"{"params":{"_meta":{"totalTokens":1000,"promptId":"p1","updateType":"AgentThoughtChunk"}}}"#,
            r#"{"params":{"_meta":{"totalTokens":1300,"promptId":"p1","updateType":"ToolCall"}}}"#,
            r#"{"params":{"update":{"sessionUpdate":"turn_completed"},"_meta":{}}}"#,
        ];
        std::fs::write(&updates, lines.join("\n") + "\n").unwrap();

        let cutoff = Utc::now() - Duration::days(30);
        let count = scan_grok_logs(&pool, dir.path(), cutoff).await.unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn scan_grok_logs_skips_sessions_without_tokens() {
        let pool = fresh_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("cwd").join("empty-sess");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(
            session_dir.join("updates.jsonl"),
            r#"{"params":{"update":{"sessionUpdate":"user_message_chunk"},"_meta":{"eventId":"1"}}}"#,
        )
        .unwrap();
        let cutoff = Utc::now() - Duration::days(30);
        let count = scan_grok_logs(&pool, dir.path(), cutoff).await.unwrap();
        assert_eq!(count, 0);
    }
}

#[cfg(test)]
#[path = "grok_usage_audit_tests.rs"]
mod grok_usage_audit_tests;
