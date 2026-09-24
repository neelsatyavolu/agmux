//! How much context a local model gets and what it costs to run.
//!
//! One plan feeds three consumers that must agree: the context window declared
//! to the harnesses (Pi, OpenCode, Grok), the prompt-cache cap handed to
//! `mlx_lm.server`, and the RAM the residency policy charges for the model.
//!
//! The KV cache is sized from the model's own `config.json` rather than a flat
//! allowance: at a 32K+ agent context it can rival the weights (16-bit KV on a
//! dense 32B model is ~8 GB at 32K), and mlx-lm keeps a second copy of it in
//! the prompt cache so the next turn can skip re-reading the conversation.
//!
//! Measured on Qwen3-4B with a 30K-token prompt (mlx-lm 0.31.3): 16-bit KV
//! peaked at weights + KV + 0.5 GB and prefilled in 19 s. 4-bit KV stored
//! 3.5× less but prefilled in 53 s, garbled a recalled string, and — with no
//! fused attention kernel for quantized caches — materialized
//! step × context × heads fp32 scores: +7.4 GB at the default 2048-token
//! prefill step, +1.7 GB at 256 (no slower). So 16-bit is used whenever it
//! fits, and 4-bit only as a fallback, with a small prefill step.

use crate::mlx::types::MlxModel;
use serde_json::Value;

/// Smallest context window declared to a harness. OpenCode's first request
/// alone is 15–30K tokens (system prompt + tool schemas + project
/// instructions), so anything smaller can't hold a single turn.
pub const AGENT_CONTEXT_FLOOR: u32 = 32_768;
/// Context declared for models with no catalog entry. KV memory and prefill
/// time grow with context; past this a local turn takes minutes anyway.
pub const UNKNOWN_CONTEXT_CAP: u32 = 65_536;
const MAX_OUTPUT_TOKENS: u32 = 16_384;
const MB: u64 = 1024 * 1024;
/// Framework, activations and prefill scratch, at least this much.
const MIN_OVERHEAD_MB: u64 = 1024;
/// Allowance on top of the weights when the KV shape can't be read.
const UNKNOWN_KV_ALLOWANCE_MB: u64 = 2 * 1024;
/// Cost assumed for a model that isn't on disk and has no catalog entry.
const DEFAULT_COST_MB: u64 = 6 * 1024;
const MIN_PROMPT_CACHE_MB: u64 = 256;
/// KV bits used when 16-bit doesn't fit and the catalog names none.
const FALLBACK_KV_BITS: u8 = 4;
/// Prefill step for quantized caches, whose attention scores grow with it.
pub const QUANTIZED_PREFILL_STEP: u32 = 256;
/// fp32 attention scores.
const SCORE_BYTES: u64 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemoryPlan {
    /// Context window declared to the harnesses.
    pub context: u32,
    /// RAM the residency policy charges while the model is loaded.
    pub cost_mb: u64,
    /// Cap on mlx-lm's saved per-conversation KV caches.
    pub prompt_cache_bytes: u64,
    /// KV quantization applied at spawn; `None` keeps 16-bit.
    pub kv_bits: Option<u8>,
    /// `--prefill-step-size` override; `None` keeps mlx-lm's default.
    pub prefill_step: Option<u32>,
}

/// Per-turn output cap declared alongside the context. Without one,
/// mlx_lm.server falls back to `--max-tokens` (512), which truncates any real
/// file write.
pub fn agent_max_output(context_window: u32) -> u32 {
    (context_window / 4).min(MAX_OUTPUT_TOKENS)
}

/// KV-cache elements stored per token, split by how long each layer keeps them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct KvShape {
    /// Elements per token across layers that keep the whole context.
    full: u64,
    /// Elements per token across sliding-window layers.
    sliding: u64,
    /// Tokens a sliding-window layer keeps.
    window: u64,
    /// Query heads, which size the attention scores of a quantized cache.
    q_heads: u64,
}

/// Reads the KV layout from a model config. Vision and hybrid models keep the
/// language model's settings under `text_config`. Linear-attention layers
/// (Qwen 3.5+/Next) keep a small fixed-size state instead of a per-token cache,
/// so only `full_attention` layers count. Returns `None` for layouts this
/// can't size, e.g. compressed-latent attention, which then use a flat allowance.
fn kv_shape(config: &Value) -> Option<KvShape> {
    let cfg = config
        .get("text_config")
        .filter(|v| v.is_object())
        .unwrap_or(config);
    if cfg.get("kv_lora_rank").is_some() {
        return None;
    }
    let num = |key: &str| cfg.get(key).and_then(Value::as_u64).filter(|n| *n > 0);
    let layers = num("num_hidden_layers")?;
    let heads = num("num_attention_heads")?;
    let kv_heads = num("num_key_value_heads").unwrap_or(heads);
    let head_dim = num("head_dim").or_else(|| Some(num("hidden_size")? / heads))?;
    let window = num("sliding_window").unwrap_or(0);

    let (full_layers, sliding_layers) = match cfg.get("layer_types").and_then(Value::as_array) {
        Some(types) => {
            let count = |kind: &str| types.iter().filter(|t| t.as_str() == Some(kind)).count() as u64;
            (count("full_attention"), count("sliding_attention"))
        }
        None => match num("full_attention_interval") {
            Some(interval) => (layers / interval, 0),
            None => (layers, 0),
        },
    };
    // Without a window size a sliding layer can't be bounded; size it as full.
    let (full_layers, sliding_layers) = if window == 0 {
        (full_layers + sliding_layers, 0)
    } else {
        (full_layers, sliding_layers)
    };
    let per_layer = 2 * kv_heads * head_dim; // keys + values
    Some(KvShape {
        full: full_layers * per_layer,
        sliding: sliding_layers * per_layer,
        window,
        q_heads: heads,
    })
}

/// Bytes per cached element: 16-bit by default; quantized caches store
/// `bits` per element plus a 16-bit scale and bias per group of 64.
fn bytes_per_element(kv_bits: Option<u8>) -> f64 {
    match kv_bits {
        Some(bits) => bits as f64 / 8.0 + 4.0 / 64.0,
        None => 2.0,
    }
}

fn kv_bytes(shape: KvShape, tokens: u64, kv_bits: Option<u8>) -> u64 {
    let elements = shape.full * tokens + shape.sliding * tokens.min(shape.window);
    (elements as f64 * bytes_per_element(kv_bits)).ceil() as u64
}

/// Attention layout of each catalog family, from its HuggingFace
/// `config.json` (September 2026), so Settings can size a model before it's
/// downloaded. Matched by substring of the repo id; every quant of a family
/// shares one layout. Columns: layers, attention heads, KV heads, head dim,
/// full-attention interval (hybrid models), native context.
const CATALOG_FAMILIES: &[(&str, u64, u64, u64, u64, Option<u64>, u32)] = &[
    ("Qwen3-4B-Instruct-2507", 36, 32, 8, 128, None, 262_144),
    ("Qwen3-8B", 36, 32, 8, 128, None, 40_960),
    ("Qwen3-14B", 40, 40, 8, 128, None, 40_960),
    ("Qwen2.5-Coder-14B", 48, 40, 8, 128, None, 32_768),
    ("Qwen3.5-4B", 32, 16, 4, 256, Some(4), 262_144),
    ("Qwen3.5-9B", 32, 16, 4, 256, Some(4), 262_144),
    ("Qwen3.6-35B-A3B", 40, 16, 2, 256, Some(4), 262_144),
    ("Qwen3-Next-80B-A3B", 48, 16, 2, 256, Some(4), 262_144),
    ("Qwen3-Coder-Next", 48, 16, 2, 256, Some(4), 262_144),
    ("Qwen3.8-27B", 64, 24, 4, 256, Some(4), 262_144),
    ("Qwen3.5-122B-A10B", 48, 32, 2, 256, Some(4), 262_144),
    ("Qwen3.5-397B-A17B", 60, 32, 2, 256, Some(4), 262_144),
];

fn catalog_family_config(repo_id: &str) -> Option<(Value, u32)> {
    let &(_, layers, heads, kv_heads, head_dim, interval, native) = CATALOG_FAMILIES
        .iter()
        .find(|(family, ..)| repo_id.contains(family))?;
    let mut config = serde_json::json!({
        "num_hidden_layers": layers,
        "num_attention_heads": heads,
        "num_key_value_heads": kv_heads,
        "head_dim": head_dim,
    });
    if let Some(interval) = interval {
        config["full_attention_interval"] = interval.into();
    }
    Some((config, native))
}

/// What a catalog model will take on this Mac: planned from its files when
/// installed, otherwise from its family's layout and download size. The same
/// plan the pool charges when the model loads, so Settings never shows a
/// smaller figure than what agmux actually reserves.
pub fn plan_catalog(
    entry: &crate::mlx::catalog::CatalogModel,
    installed: Option<&MlxModel>,
) -> MemoryPlan {
    if let Some(m) = installed {
        return plan(m);
    }
    let Some((config, native)) = catalog_family_config(&entry.repo_id) else {
        return plan_for_id(&entry.repo_id);
    };
    let model = MlxModel {
        id: entry.repo_id.clone(),
        display_name: entry.name.clone(),
        source: crate::mlx::types::MlxModelSource::XanomManaged,
        path: std::path::PathBuf::new(),
        size_bytes: (entry.size_gb as f64 * (1024.0 * 1024.0 * 1024.0)) as u64,
        quant: None,
        context_window: Some(native),
        supports_tools: entry.supports_native_tools,
    };
    plan_with(&model, Some(&config), crate::mlx::pool::solo_cap_mb())
}

fn read_config(model: &MlxModel) -> Option<Value> {
    let text = std::fs::read_to_string(model.path.join("config.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// Plan for an installed model on this Mac.
pub fn plan(model: &MlxModel) -> MemoryPlan {
    plan_with(model, read_config(model).as_ref(), crate::mlx::pool::solo_cap_mb())
}

/// Plan by model id. An id that isn't installed has no weights to measure;
/// it gets its catalog estimate, or a flat default.
pub fn plan_for_id(model: &str) -> MemoryPlan {
    let id = model.strip_prefix("local/").unwrap_or(model);
    if let Some(m) = crate::mlx::discovery::scan_all().into_iter().find(|m| m.id == id) {
        return plan(&m);
    }
    let entry = crate::mlx::catalog::lookup(id);
    let context = entry
        .as_ref()
        .and_then(|e| e.max_kv_size)
        .map_or(UNKNOWN_CONTEXT_CAP, |n| n.max(AGENT_CONTEXT_FLOOR));
    let kv_bits = entry.as_ref().and_then(|e| e.kv_bits);
    MemoryPlan {
        context,
        cost_mb: entry
            .as_ref()
            .map_or(DEFAULT_COST_MB, |e| (e.ram_gb * 1024.0).ceil() as u64),
        prompt_cache_bytes: UNKNOWN_KV_ALLOWANCE_MB * MB,
        kv_bits,
        prefill_step: kv_bits.map(|_| QUANTIZED_PREFILL_STEP),
    }
}

/// One way to run a model, from fastest and most faithful to leanest.
#[derive(Clone, Copy)]
struct Setup {
    kv_bits: Option<u8>,
    /// Keep a saved copy of the conversation's KV cache so the next turn
    /// resumes instead of re-reading everything.
    reuse: bool,
}

struct Sizing {
    shape: KvShape,
    weights_mb: u64,
    overhead_mb: u64,
}

impl Sizing {
    fn cost_mb(&self, context: u32, setup: Setup) -> u64 {
        let tokens = context as u64;
        let kv_mb = kv_bytes(self.shape, tokens, setup.kv_bits).div_ceil(MB);
        // The request being served holds one copy of the conversation's KV
        // cache; the prompt cache holds another for the next turn.
        let saved_mb = if setup.reuse { kv_mb } else { MIN_PROMPT_CACHE_MB };
        let scores_mb = match setup.kv_bits {
            Some(_) => (QUANTIZED_PREFILL_STEP as u64 * tokens * self.shape.q_heads * SCORE_BYTES).div_ceil(MB),
            None => 0, // fused kernel; covered by the overhead
        };
        self.weights_mb + kv_mb + saved_mb + scores_mb + self.overhead_mb
    }

    fn plan(&self, context: u32, setup: Setup) -> MemoryPlan {
        let saved = if setup.reuse {
            kv_bytes(self.shape, context as u64, setup.kv_bits)
        } else {
            0
        };
        MemoryPlan {
            context,
            cost_mb: self.cost_mb(context, setup),
            prompt_cache_bytes: saved.max(MIN_PROMPT_CACHE_MB * MB),
            kv_bits: setup.kv_bits,
            prefill_step: setup.kv_bits.map(|_| QUANTIZED_PREFILL_STEP),
        }
    }
}

fn plan_with(model: &MlxModel, config: Option<&Value>, solo_cap_mb: u64) -> MemoryPlan {
    let entry = crate::mlx::catalog::lookup(&model.id);
    let catalog_bits = entry.as_ref().and_then(|e| e.kv_bits);
    let wanted = entry
        .as_ref()
        .and_then(|e| e.max_kv_size)
        .map_or(UNKNOWN_CONTEXT_CAP, |n| n.max(AGENT_CONTEXT_FLOOR));
    let start = model.context_window.map_or(wanted, |native| native.min(wanted));
    let weights_mb = model.size_bytes / MB;
    let overhead_mb = (weights_mb / 10).max(MIN_OVERHEAD_MB);

    let Some(shape) = config.and_then(kv_shape) else {
        return MemoryPlan {
            context: start,
            cost_mb: weights_mb + UNKNOWN_KV_ALLOWANCE_MB + overhead_mb,
            prompt_cache_bytes: UNKNOWN_KV_ALLOWANCE_MB * MB,
            kv_bits: catalog_bits,
            prefill_step: catalog_bits.map(|_| QUANTIZED_PREFILL_STEP),
        };
    };
    let sizing = Sizing { shape, weights_mb, overhead_mb };
    let quantized = Some(catalog_bits.unwrap_or(FALLBACK_KV_BITS));
    let setups = [
        Setup { kv_bits: None, reuse: true },
        Setup { kv_bits: quantized, reuse: true },
        Setup { kv_bits: quantized, reuse: false },
    ];

    // Best setup first; within one, declare less context rather than a
    // window this Mac can't hold. Never below the agent floor: a smaller
    // window can't fit one harness turn.
    for setup in setups {
        let mut context = start;
        loop {
            if sizing.cost_mb(context, setup) <= solo_cap_mb {
                return sizing.plan(context, setup);
            }
            if context <= AGENT_CONTEXT_FLOOR {
                break;
            }
            context = (context / 2).max(AGENT_CONTEXT_FLOOR);
        }
    }
    // Nothing fits. Report the leanest setup's true cost so admission
    // refuses the model with an honest size instead of letting it swap.
    sizing.plan(start.min(AGENT_CONTEXT_FLOOR), setups[2])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mlx::types::MlxModelSource;
    use serde_json::json;
    use std::path::PathBuf;

    const GB: u64 = 1024 * MB;

    fn model(id: &str, weights_gb: u64, native: Option<u32>) -> MlxModel {
        MlxModel {
            id: id.to_string(),
            display_name: id.to_string(),
            source: MlxModelSource::XanomManaged,
            path: PathBuf::from("/nonexistent"),
            size_bytes: weights_gb * GB,
            quant: None,
            context_window: native,
            supports_tools: true,
        }
    }

    /// Qwen3-4B-Instruct-2507 as shipped.
    fn qwen3_4b() -> Value {
        json!({ "num_hidden_layers": 36, "num_attention_heads": 32,
                "num_key_value_heads": 8, "head_dim": 128, "hidden_size": 2560 })
    }

    /// Qwen3-32B as shipped.
    fn qwen3_32b() -> Value {
        json!({ "num_hidden_layers": 64, "num_attention_heads": 64,
                "num_key_value_heads": 8, "head_dim": 128 })
    }

    #[test]
    fn dense_model_caches_every_layer() {
        let shape = kv_shape(&qwen3_4b()).unwrap();
        assert_eq!(shape.full, 36 * 2 * 8 * 128);
        // 16-bit KV at 32K tokens: 4.5 GiB.
        assert_eq!(kv_bytes(shape, 32_768, None), 36 * 2 * 8 * 128 * 2 * 32_768);
    }

    #[test]
    fn hybrid_models_only_cache_full_attention_layers() {
        // Qwen 3.6 27B keeps its language settings under `text_config` and
        // uses full attention on one layer in four.
        let cfg = json!({ "text_config": {
            "num_hidden_layers": 64, "num_attention_heads": 24, "num_key_value_heads": 4,
            "head_dim": 256, "full_attention_interval": 4,
            "layer_types": ["linear_attention", "linear_attention", "linear_attention", "full_attention"]
        }});
        assert_eq!(kv_shape(&cfg).unwrap().full, 2 * 4 * 256);

        let by_interval = json!({ "num_hidden_layers": 64, "num_attention_heads": 24,
            "num_key_value_heads": 4, "head_dim": 256, "full_attention_interval": 4 });
        assert_eq!(kv_shape(&by_interval).unwrap().full, 16 * 2 * 4 * 256);
    }

    #[test]
    fn sliding_window_layers_stop_growing_at_the_window() {
        let cfg = json!({ "num_hidden_layers": 2, "num_attention_heads": 8, "num_key_value_heads": 1,
            "head_dim": 64, "sliding_window": 1024,
            "layer_types": ["sliding_attention", "full_attention"] });
        let shape = kv_shape(&cfg).unwrap();
        let per_layer = 2 * 64;
        assert_eq!(kv_bytes(shape, 32_768, None), (per_layer * 32_768 + per_layer * 1024) * 2);
    }

    #[test]
    fn head_dim_falls_back_to_hidden_size_over_heads() {
        // GLM 4.6V's text config omits head_dim.
        let cfg = json!({ "num_hidden_layers": 40, "num_attention_heads": 32,
            "num_key_value_heads": 2, "hidden_size": 4096 });
        assert_eq!(kv_shape(&cfg).unwrap().full, 40 * 2 * 2 * 128);
    }

    #[test]
    fn unreadable_layouts_have_no_shape() {
        assert_eq!(kv_shape(&json!({ "num_hidden_layers": 61, "num_attention_heads": 128,
            "kv_lora_rank": 512 })), None);
        assert_eq!(kv_shape(&json!({})), None);
    }

    #[test]
    fn four_bit_kv_is_under_a_third_of_sixteen_bit() {
        let shape = kv_shape(&qwen3_4b()).unwrap();
        let q = kv_bytes(shape, 32_768, Some(4)) as f64;
        let f = kv_bytes(shape, 32_768, None) as f64;
        assert!((q / f - 0.28125).abs() < 1e-6);
    }

    #[test]
    fn cost_counts_the_active_cache_and_its_saved_copy() {
        let m = model("unknown/qwen3-4b", 2, Some(262_144));
        let plan = plan_with(&m, Some(&qwen3_4b()), 1_000 * 1024);
        let kv = kv_bytes(kv_shape(&qwen3_4b()).unwrap(), UNKNOWN_CONTEXT_CAP as u64, None);
        assert_eq!(plan.context, UNKNOWN_CONTEXT_CAP);
        assert_eq!(plan.cost_mb, 2 * 1024 + 2 * kv.div_ceil(MB) + MIN_OVERHEAD_MB);
        assert_eq!(plan.prompt_cache_bytes, kv);
        // 2 GB of weights, but 64K tokens of 16-bit KV twice over is ~18 GB.
        assert!(plan.cost_mb > 18 * 1024, "cost {} MB", plan.cost_mb);
    }

    /// Peak active memory measured with mlx-lm 0.31.3 on Qwen3-4B-Instruct
    /// (2.11 GiB of weights) for a 30,414-token prompt. The estimate for one
    /// request (no saved copy) must cover it without wildly overshooting.
    #[test]
    fn estimate_covers_measured_peaks() {
        let sizing = Sizing {
            shape: kv_shape(&qwen3_4b()).unwrap(),
            weights_mb: 2_161,
            overhead_mb: MIN_OVERHEAD_MB,
        };
        let measured = [
            (Setup { kv_bits: None, reuse: false }, 6.83),
            (Setup { kv_bits: Some(4), reuse: false }, 4.95),
        ];
        for (setup, peak_gib) in measured {
            let est_gib = sizing.cost_mb(30_414, setup) as f64 / 1024.0;
            assert!(
                est_gib >= peak_gib && est_gib <= peak_gib * 1.25,
                "kv_bits {:?}: estimated {est_gib:.2} GiB vs measured {peak_gib} GiB",
                setup.kv_bits
            );
        }
    }

    #[test]
    fn sixteen_bit_kv_when_it_fits() {
        // Qwen3-32B, 17 GB of weights, 16-bit KV (~8 GB per 32K tokens).
        let m = model("unknown/qwen3-32b", 17, Some(40_960));
        let plan = plan_with(&m, Some(&qwen3_32b()), 62 * 1024);
        assert_eq!(plan.context, 40_960, "native window fits a 64 GB Mac");
        assert_eq!(plan.kv_bits, None);
        assert_eq!(plan.prefill_step, None);
        assert!(plan.prompt_cache_bytes > 9 * GB, "keeps a full saved copy");
    }

    #[test]
    fn falls_back_to_quantized_kv_with_a_small_prefill_step() {
        let m = model("unknown/qwen3-32b", 17, Some(40_960));
        let plan = plan_with(&m, Some(&qwen3_32b()), 30 * 1024);
        assert_eq!(plan.kv_bits, Some(FALLBACK_KV_BITS));
        assert_eq!(plan.prefill_step, Some(QUANTIZED_PREFILL_STEP));
        assert!(plan.cost_mb <= 30 * 1024);
    }

    #[test]
    fn drops_the_saved_copy_before_refusing() {
        // Qwen3-4B on an 8 GB Mac (6 GB solo cap).
        let m = model("unknown/qwen3-4b", 2, Some(262_144));
        let plan = plan_with(&m, Some(&qwen3_4b()), 6 * 1024);
        assert_eq!(plan.context, AGENT_CONTEXT_FLOOR);
        assert_eq!(plan.kv_bits, Some(FALLBACK_KV_BITS));
        assert_eq!(plan.prompt_cache_bytes, MIN_PROMPT_CACHE_MB * MB);
        assert!(plan.cost_mb <= 6 * 1024);
    }

    #[test]
    fn reports_the_true_cost_when_nothing_fits() {
        let m = model("unknown/qwen3-32b", 17, Some(40_960));
        let plan = plan_with(&m, Some(&qwen3_32b()), 16 * 1024);
        assert_eq!(plan.context, AGENT_CONTEXT_FLOOR);
        assert!(plan.cost_mb > 16 * 1024, "admission must see it doesn't fit");
    }

    #[test]
    fn never_declares_more_than_the_model_supports() {
        let m = model("unknown/short", 2, Some(8_192));
        assert_eq!(plan_with(&m, Some(&qwen3_4b()), 60 * 1024).context, 8_192);
    }

    #[test]
    fn unreadable_config_falls_back_to_a_flat_allowance_on_measured_weights() {
        let m = model("unknown/mystery", 10, None);
        let plan = plan_with(&m, None, 60 * 1024);
        assert_eq!(plan.context, UNKNOWN_CONTEXT_CAP);
        assert_eq!(plan.cost_mb, 10 * 1024 + UNKNOWN_KV_ALLOWANCE_MB + MIN_OVERHEAD_MB);
    }

    #[test]
    fn catalog_models_use_their_context_budget_and_kv_bits_as_fallback() {
        let entry = crate::mlx::catalog::catalog()
            .into_iter()
            // Budget at the floor, so the tight case can't fit by shrinking.
            .find(|e| e.kv_bits.is_some() && e.max_kv_size.is_some_and(|n| n <= AGENT_CONTEXT_FLOOR))
            .expect("catalog has a quantized-KV entry");
        let m = model(&entry.repo_id, entry.size_gb.ceil() as u64, Some(262_144));
        let roomy = plan_with(&m, Some(&qwen3_4b()), 1_000 * 1024);
        assert_eq!(roomy.context, entry.max_kv_size.unwrap().max(AGENT_CONTEXT_FLOOR));
        assert_eq!(roomy.kv_bits, None, "16-bit whenever it fits");

        let tight = plan_with(&m, Some(&qwen3_4b()), roomy.cost_mb - 1);
        assert_eq!(tight.kv_bits, entry.kv_bits);
    }

    /// A catalog model without a layout would fall back to its static
    /// `ram_gb` in Settings. Add its family to `CATALOG_FAMILIES`.
    #[test]
    fn every_catalog_model_has_exactly_one_family_layout() {
        for entry in crate::mlx::catalog::catalog() {
            let matches = CATALOG_FAMILIES
                .iter()
                .filter(|(family, ..)| entry.repo_id.contains(family))
                .count();
            assert_eq!(matches, 1, "{} matches {matches} families", entry.repo_id);
        }
    }

    #[test]
    fn family_layouts_size_hybrid_models_by_their_full_attention_layers() {
        let (config, native) = catalog_family_config("mlx-community/Qwen3.8-27B-4bit").unwrap();
        assert_eq!(native, 262_144);
        // 16 of 64 layers use full attention, 4 KV heads of 256.
        assert_eq!(kv_shape(&config).unwrap().full, 16 * 2 * 4 * 256);
    }

    #[test]
    fn uninstalled_catalog_models_are_planned_from_their_layout() {
        let entry = crate::mlx::catalog::catalog()
            .into_iter()
            .find(|e| e.repo_id.contains("Qwen3-4B-Instruct-2507"))
            .expect("catalog lists Qwen3-4B-Instruct-2507");
        let plan = plan_catalog(&entry, None);
        let weights_mb = (entry.size_gb * 1024.0) as u64;
        assert!(
            plan.cost_mb > weights_mb + 1024,
            "must include the KV cache, not just weights: {} MB",
            plan.cost_mb
        );
    }

    #[test]
    fn output_leaves_room_for_the_prompt() {
        assert_eq!(agent_max_output(32_768), 8_192);
        assert_eq!(agent_max_output(262_144), MAX_OUTPUT_TOKENS);
    }
}
