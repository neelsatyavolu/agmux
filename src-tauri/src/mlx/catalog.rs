//! Curated MLX coding-model catalog + hardware-aware recommendations.
//!
//! Three picks (`speed` / `balanced` / `quality`) for each unified-memory
//! tier (8 / 12 / 16 / 24 / 32 / 48 / 64 / 96 / 128 / 256 GB). Snapshot:
//! August 2026, cross-checked against HuggingFace `mlx-community` +
//! `lmstudio-community` downloads, on-disk safetensors sizes, and mlx-lm
//! 0.31 tool parsers (`qwen3_coder`, `json_tools`, …).
//!
//! Selection rules:
//! - Prefer models mlx-lm can load (`qwen3`, `qwen3_5`, `qwen3_next`,
//!   `qwen3_moe`, …) and that expose a chat template with tool/function
//!   calling (required for OpenCode / agent harnesses).
//! - Weights should land ~50–70% of the tier so OS + KV cache still fit.
//! - MoE (Coder-30B-A3B, 35B-A3B, Coder-Next, 122B-A10B) for speed-at-size.
//! - OptiQ / mxfp4 variants when they are text-side-only and fit better.

use serde::{Deserialize, Serialize};
use std::process::Command;

/// Unified-memory recommendation bucket. Serialized as the GB number string
/// (`"8"`, `"12"`, …) so the frontend can label and sort without a map.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HardwareTier {
    #[serde(rename = "8")]
    Gb8,
    #[serde(rename = "12")]
    Gb12,
    #[serde(rename = "16")]
    Gb16,
    #[serde(rename = "24")]
    Gb24,
    #[serde(rename = "32")]
    Gb32,
    #[serde(rename = "48")]
    Gb48,
    #[serde(rename = "64")]
    Gb64,
    #[serde(rename = "96")]
    Gb96,
    #[serde(rename = "128")]
    Gb128,
    #[serde(rename = "256")]
    Gb256,
}

impl HardwareTier {
    /// Nominal RAM for this tier, in GB.
    pub fn ram_gb(self) -> u32 {
        match self {
            Self::Gb8 => 8,
            Self::Gb12 => 12,
            Self::Gb16 => 16,
            Self::Gb24 => 24,
            Self::Gb32 => 32,
            Self::Gb48 => 48,
            Self::Gb64 => 64,
            Self::Gb96 => 96,
            Self::Gb128 => 128,
            Self::Gb256 => 256,
        }
    }

    /// All tiers, ascending by RAM.
    pub fn all() -> &'static [HardwareTier] {
        &[
            Self::Gb8,
            Self::Gb12,
            Self::Gb16,
            Self::Gb24,
            Self::Gb32,
            Self::Gb48,
            Self::Gb64,
            Self::Gb96,
            Self::Gb128,
            Self::Gb256,
        ]
    }

    #[allow(dead_code)] // used by UI label helpers / tests
    pub fn label(self) -> String {
        format!("{} GB", self.ram_gb())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelRole {
    Speed,
    Quality,
    Balanced,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    /// e.g. "Apple M2 Pro"
    pub chip: String,
    /// Total unified memory in GB (rounded down).
    pub total_ram_gb: u32,
    /// Logical CPU count.
    pub cores: u32,
    /// Tier the recommendations engine maps this hardware to.
    pub tier: HardwareTier,
    /// Whether we believe this is an Apple Silicon Mac (false on Intel/non-Mac).
    pub is_apple_silicon: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    /// HuggingFace repo id, e.g. `mlx-community/Qwen3.5-9B-MLX-4bit`.
    pub repo_id: String,
    /// Human-friendly display name.
    pub name: String,
    /// Parameter count summary, e.g. `"9B"` or `"30B MoE / 3B active"`.
    pub params: String,
    /// Quantization label, e.g. `"4bit"`.
    pub quant: String,
    /// On-disk size in GB (measured from HF safetensors when known).
    pub size_gb: f32,
    /// Approximate runtime RAM in GB (disk + KV + framework overhead).
    pub ram_gb: f32,
    /// 1-line description.
    pub description: String,
    /// Hardware tier this model is recommended for.
    pub tier: HardwareTier,
    /// Recommendation slot within its tier.
    pub role: ModelRole,
    /// Per-tier KV-cache quantization, in bits. `Some(4)` trades a small
    /// quality hit for a memory cut on tight hardware; `None` is unconstrained.
    /// Applied at `mlx_lm.server` spawn via `backend::apply_kv_limits`
    /// (0.31 has no `--kv-bits` CLI flag).
    pub kv_bits: Option<u8>,
    /// Per-tier rotating KV cache cap, in tokens. Applied with `kv_bits`.
    pub max_kv_size: Option<u32>,
    /// Whether this model has a chat template that mlx-lm can parse into
    /// structured OpenAI-style tool calls (see `mlx_lm.tool_parsers`,
    /// including `qwen3_coder` as of 0.31).
    pub supports_native_tools: bool,
    /// Whether this model has the Qwen 2.5-Coder fill-in-the-middle
    /// special tokens (`<|fim_prefix|>`, …) so FIM autocomplete works.
    pub supports_fim: bool,
}

/// Detect the Mac's chip, total RAM, and core count.
///
/// Falls back to safe defaults on Intel Macs / Linux dev machines so we don't
/// hard-error in CI or on contributors' non-Apple boxes.
pub fn detect_hardware() -> HardwareInfo {
    let chip = sysctl_string("machdep.cpu.brand_string").unwrap_or_else(|| "Unknown CPU".into());
    let total_ram_bytes = sysctl_u64("hw.memsize").unwrap_or(8 * 1024 * 1024 * 1024);
    let total_ram_gb = (total_ram_bytes / (1024 * 1024 * 1024)) as u32;
    let cores = sysctl_u64("hw.ncpu").unwrap_or(8) as u32;
    let is_apple_silicon = chip.starts_with("Apple ");
    let tier = tier_from_ram(total_ram_gb);
    HardwareInfo {
        chip,
        total_ram_gb,
        cores,
        tier,
        is_apple_silicon,
    }
}

/// Map installed RAM to the largest tier that fits (`tier.ram_gb <= gb`).
/// Sub-8GB machines still land on the 8GB recommendations (best effort).
fn tier_from_ram(gb: u32) -> HardwareTier {
    let mut chosen = HardwareTier::Gb8;
    for &t in HardwareTier::all() {
        if t.ram_gb() <= gb {
            chosen = t;
        } else {
            break;
        }
    }
    chosen
}

fn sysctl_string(key: &str) -> Option<String> {
    let out = Command::new("sysctl").args(["-n", key]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

fn sysctl_u64(key: &str) -> Option<u64> {
    sysctl_string(key)?.parse().ok()
}

/// Helper to keep the catalog table readable.
fn m(
    repo_id: &str,
    name: &str,
    params: &str,
    quant: &str,
    size_gb: f32,
    ram_gb: f32,
    description: &str,
    tier: HardwareTier,
    role: ModelRole,
    kv_bits: Option<u8>,
    max_kv_size: Option<u32>,
    supports_native_tools: bool,
    supports_fim: bool,
) -> CatalogModel {
    CatalogModel {
        repo_id: repo_id.into(),
        name: name.into(),
        params: params.into(),
        quant: quant.into(),
        size_gb,
        ram_gb,
        description: description.into(),
        tier,
        role,
        kv_bits,
        max_kv_size,
        supports_native_tools,
        supports_fim,
    }
}

/// Curated catalog of MLX coding models — August 2026 snapshot.
///
/// Sources:
///  - HuggingFace `mlx-community` / `lmstudio-community` (sizes from tree API)
///  - mlx-lm 0.31 model + tool_parser modules (`qwen3_5`, `qwen3_coder`, …)
///  - Community coding/agent evals (SWE-bench Verified, LiveCodeBench, practical
///    OpenCode/Aider-style usage) as summarized in the Aug 2026 model audit
pub fn catalog() -> Vec<CatalogModel> {
    use HardwareTier::*;
    use ModelRole::*;

    vec![
        // ── 8 GB ── weights ≤ ~4 GB so KV + OS still fit
        m(
            "mlx-community/Qwen3.5-4B-MLX-4bit",
            "Qwen 3.5 4B",
            "4B",
            "4bit",
            2.83,
            4.5,
            "Fastest daily driver on 8GB. Strong tools for its size; mlx-lm qwen3_5.",
            Gb8,
            Speed,
            Some(4),
            Some(8192),
            true,
            false,
        ),
        m(
            "mlx-community/Qwen3.5-4B-OptiQ-4bit",
            "Qwen 3.5 4B OptiQ",
            "4B",
            "OptiQ-4bit",
            3.75,
            5.5,
            "Higher-fidelity 4B quant. Best balance of speed and quality on 8GB.",
            Gb8,
            Balanced,
            Some(4),
            Some(8192),
            true,
            false,
        ),
        m(
            "mlx-community/Qwen3-4B-Instruct-2507-4bit",
            "Qwen 3 4B Instruct",
            "4B",
            "4bit",
            2.11,
            4.0,
            "Pure text Qwen3 Instruct — most reliable tool calls when VLM quants misbehave.",
            Gb8,
            Quality,
            Some(4),
            Some(8192),
            true,
            false,
        ),

        // ── 12 GB ──
        m(
            "mlx-community/Qwen3-8B-4bit",
            "Qwen 3 8B",
            "8B",
            "4bit",
            4.29,
            6.5,
            "Snappy dense 8B. Solid structured output without saturating 12GB.",
            Gb12,
            Speed,
            Some(4),
            Some(12288),
            true,
            false,
        ),
        m(
            "mlx-community/Qwen3.5-9B-MLX-4bit",
            "Qwen 3.5 9B",
            "9B",
            "4bit",
            5.54,
            8.0,
            "Top mid-small pick. Frequently recommended as a 12–16GB daily driver.",
            Gb12,
            Balanced,
            Some(4),
            Some(12288),
            true,
            false,
        ),
        m(
            "mlx-community/Qwen3.5-9B-OptiQ-4bit",
            "Qwen 3.5 9B OptiQ",
            "9B",
            "OptiQ-4bit",
            7.63,
            10.0,
            "Text-side OptiQ quant of 9B — max quality that still leaves KV headroom on 12GB.",
            Gb12,
            Quality,
            Some(4),
            Some(8192),
            true,
            false,
        ),

        // ── 16 GB ──
        m(
            "lmstudio-community/Qwen3.5-9B-MLX-8bit",
            "Qwen 3.5 9B (8bit)",
            "9B",
            "8bit",
            9.71,
            12.0,
            "Higher-bit 9B for speed-with-fidelity. Often >100 tok/s on recent silicon.",
            Gb16,
            Speed,
            None,
            Some(16384),
            true,
            false,
        ),
        m(
            "mlx-community/Qwen3-14B-4bit",
            "Qwen 3 14B",
            "14B",
            "4bit",
            7.74,
            11.0,
            "Dense 14B generalist. Strong reasoning with comfortable 16GB headroom.",
            Gb16,
            Balanced,
            Some(4),
            Some(16384),
            true,
            false,
        ),
        m(
            "mlx-community/Qwen2.5-Coder-14B-Instruct-4bit",
            "Qwen 2.5 Coder 14B",
            "14B",
            "4bit",
            7.74,
            11.0,
            "Coding specialist with native tools + FIM. Best pure-code quality under 16GB.",
            Gb16,
            Quality,
            Some(4),
            Some(16384),
            true,
            true,
        ),

        // ── 24 GB ── MoE / dense mid-class
        m(
            "mlx-community/Qwen3.6-35B-A3B-4bit",
            "Qwen 3.6 35B-A3B",
            "35B MoE / 3B active",
            "4bit",
            19.0,
            22.0,
            "MoE speed king for 24GB — ~3B active params, high tok/s with big total capacity.",
            Gb24,
            Speed,
            Some(4),
            Some(16384),
            true,
            false,
        ),
        m(
            "mlx-community/Qwen3.6-27B-4bit",
            "Qwen 3.6 27B",
            "27B",
            "4bit",
            14.95,
            18.0,
            "Dense 27B coding workhorse. Community SWE-bench Verified ~77% class.",
            Gb24,
            Balanced,
            Some(4),
            Some(16384),
            true,
            false,
        ),
        m(
            "mlx-community/Qwen3.6-27B-OptiQ-4bit",
            "Qwen 3.6 27B OptiQ",
            "27B",
            "OptiQ-4bit",
            18.61,
            22.0,
            "OptiQ text quant of 27B — highest quality dense fit for 24GB.",
            Gb24,
            Quality,
            Some(4),
            Some(12288),
            true,
            false,
        ),

        // ── 32 GB ── coding MoE comes online
        m(
            "mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit",
            "Qwen 3.6 35B-A3B OptiQ",
            "35B MoE / 3B active",
            "OptiQ-4bit",
            22.98,
            28.0,
            "OptiQ MoE — fast active path with more weight fidelity than plain 4bit.",
            Gb32,
            Speed,
            None,
            Some(32768),
            true,
            false,
        ),
        m(
            "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit",
            "Qwen 3 Coder 30B-A3B",
            "30B MoE / 3B active",
            "4bit",
            16.0,
            20.0,
            "Coding MoE with mlx-lm qwen3_coder tool parser. Agent-friendly daily driver.",
            Gb32,
            Balanced,
            None,
            Some(32768),
            true,
            false,
        ),
        m(
            "lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-MLX-6bit",
            "Qwen 3 Coder 30B-A3B (6bit)",
            "30B MoE / 3B active",
            "6bit",
            23.10,
            28.0,
            "Higher-bit coding MoE. Best agentic quality that still fits 32GB.",
            Gb32,
            Quality,
            None,
            Some(24576),
            true,
            false,
        ),

        // ── 48 GB ── Coder-Next entry
        m(
            "lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-MLX-8bit",
            "Qwen 3 Coder 30B-A3B (8bit)",
            "30B MoE / 3B active",
            "8bit",
            30.21,
            36.0,
            "Full-fidelity coding MoE at still-high tok/s. Great 48GB speed pick.",
            Gb48,
            Speed,
            None,
            Some(32768),
            true,
            false,
        ),
        m(
            "mlx-community/Qwen3-Coder-Next-4bit",
            "Qwen 3 Coder Next",
            "Coder-Next",
            "4bit",
            41.76,
            46.0,
            "Specialized agentic coder (qwen3_next). Strong multi-step tool use.",
            Gb48,
            Balanced,
            None,
            Some(32768),
            true,
            false,
        ),
        m(
            "mlx-community/Qwen3-Coder-Next-mxfp4",
            "Qwen 3 Coder Next mxfp4",
            "Coder-Next",
            "mxfp4",
            39.45,
            44.0,
            "mxfp4 Coder-Next — often better quality-per-byte than plain 4bit.",
            Gb48,
            Quality,
            None,
            Some(32768),
            true,
            false,
        ),

        // ── 64 GB ──
        m(
            "mlx-community/Qwen3-Next-80B-A3B-Instruct-4bit",
            "Qwen 3 Next 80B-A3B",
            "80B MoE / 3B active",
            "4bit",
            41.76,
            48.0,
            "Large MoE generalist — only ~3B active, so it stays snappy on 64GB.",
            Gb64,
            Speed,
            None,
            Some(65536),
            true,
            false,
        ),
        m(
            "mlx-community/Qwen3-Coder-Next-5bit",
            "Qwen 3 Coder Next (5bit)",
            "Coder-Next",
            "5bit",
            51.03,
            58.0,
            "Mid-bit Coder-Next. Primary coding agent for 64GB machines.",
            Gb64,
            Balanced,
            None,
            Some(32768),
            true,
            false,
        ),
        m(
            "mlx-community/Qwen2.5-Coder-32B-Instruct-8bit",
            "Qwen 2.5 Coder 32B (8bit)",
            "32B",
            "8bit",
            32.42,
            42.0,
            "Highest-fidelity dense coder that fits 64GB with long-context room.",
            Gb64,
            Quality,
            None,
            Some(65536),
            true,
            true,
        ),

        // ── 96 GB ── 122B class opens up
        m(
            "mlx-community/Qwen3-Coder-Next-6bit",
            "Qwen 3 Coder Next (6bit)",
            "Coder-Next",
            "6bit",
            60.30,
            70.0,
            "High-bit Coder-Next. Fast relative to size; excellent agent loop quality.",
            Gb96,
            Speed,
            None,
            Some(65536),
            true,
            false,
        ),
        m(
            "mlx-community/Qwen3.5-122B-A10B-mxfp4",
            "Qwen 3.5 122B-A10B mxfp4",
            "122B MoE / 10B active",
            "mxfp4",
            61.28,
            72.0,
            "Large MoE at mxfp4. Top overall coding + tool average that fits 96GB.",
            Gb96,
            Balanced,
            None,
            Some(65536),
            true,
            false,
        ),
        m(
            "mlx-community/Qwen3.5-122B-A10B-4bit",
            "Qwen 3.5 122B-A10B",
            "122B MoE / 10B active",
            "4bit",
            64.81,
            78.0,
            "Standard 4bit 122B-A10B. Maximum quality under 96GB with KV restraint.",
            Gb96,
            Quality,
            Some(4),
            Some(32768),
            true,
            false,
        ),

        // ── 128 GB ──
        m(
            "mlx-community/Qwen3-Coder-Next-8bit",
            "Qwen 3 Coder Next (8bit)",
            "Coder-Next",
            "8bit",
            78.84,
            92.0,
            "Full-precision Coder-Next. Fast coding specialist with 128GB headroom.",
            Gb128,
            Speed,
            None,
            Some(131072),
            true,
            false,
        ),
        m(
            "mlx-community/Qwen3.5-122B-A10B-6bit",
            "Qwen 3.5 122B-A10B (6bit)",
            "122B MoE / 10B active",
            "6bit",
            93.24,
            110.0,
            "6bit 122B-A10B — quality step up while leaving OS + long context room.",
            Gb128,
            Balanced,
            None,
            Some(65536),
            true,
            false,
        ),
        m(
            "mlx-community/Qwen3-235B-A22B-Instruct-2507-4bit",
            "Qwen 3 235B-A22B",
            "235B MoE / 22B active",
            "4bit",
            123.16,
            140.0,
            "Frontier MoE instruct. Heavy — keep context moderate on 128GB machines.",
            Gb128,
            Quality,
            Some(4),
            Some(32768),
            true,
            false,
        ),

        // ── 256 GB ── max fidelity
        m(
            "mlx-community/Qwen3.5-122B-A10B-8bit",
            "Qwen 3.5 122B-A10B (8bit)",
            "122B MoE / 10B active",
            "8bit",
            121.68,
            145.0,
            "Highest practical 122B quant. Plenty of room for long-context agents.",
            Gb256,
            Speed,
            None,
            None,
            true,
            false,
        ),
        m(
            "mlx-community/Qwen3.5-397B-A17B-4bit",
            "Qwen 3.5 397B-A17B",
            "397B MoE / 17B active",
            "4bit",
            208.49,
            230.0,
            "Very large MoE. Top non-coder quality class available in MLX 4bit.",
            Gb256,
            Balanced,
            Some(4),
            Some(65536),
            true,
            false,
        ),
        m(
            "mlx-community/Qwen3-Coder-480B-A35B-Instruct-4bit",
            "Qwen 3 Coder 480B-A35B",
            "480B MoE / 35B active",
            "4bit",
            251.54,
            270.0,
            "Largest coding MoE in MLX. Needs a 256GB machine; cap context if tight.",
            Gb256,
            Quality,
            Some(4),
            Some(32768),
            true,
            false,
        ),
    ]
}

/// The catalog as a user is allowed to see it.
///
/// Both harnesses that run local models (OpenCode chat, the Pi CLI) do every
/// file edit through structured `tool_calls`. An entry with
/// `supports_native_tools: false` would download, load, answer the first
/// question and then fail at the first edit — worse than not offering it.
pub fn offerable_catalog() -> Vec<CatalogModel> {
    catalog()
        .into_iter()
        .filter(|m| m.supports_native_tools)
        .collect()
}

/// Look up a catalog entry by exact `repo_id` match. Returns `None` for
/// user-supplied / discovered models that aren't in the curated list — in
/// which case the supervisor should NOT pass any tier-specific tuning flags
/// (we don't infer from the path).
pub fn lookup(repo_id: &str) -> Option<CatalogModel> {
    catalog().into_iter().find(|m| m.repo_id == repo_id)
}

/// Convenience: catalog filtered to a single tier.
#[allow(dead_code)]
pub fn catalog_for_tier(tier: HardwareTier) -> Vec<CatalogModel> {
    catalog().into_iter().filter(|m| m.tier == tier).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_thresholds() {
        assert_eq!(tier_from_ram(4), HardwareTier::Gb8); // best-effort
        assert_eq!(tier_from_ram(8), HardwareTier::Gb8);
        assert_eq!(tier_from_ram(11), HardwareTier::Gb8);
        assert_eq!(tier_from_ram(12), HardwareTier::Gb12);
        assert_eq!(tier_from_ram(15), HardwareTier::Gb12);
        assert_eq!(tier_from_ram(16), HardwareTier::Gb16);
        assert_eq!(tier_from_ram(24), HardwareTier::Gb24);
        assert_eq!(tier_from_ram(32), HardwareTier::Gb32);
        assert_eq!(tier_from_ram(48), HardwareTier::Gb48);
        assert_eq!(tier_from_ram(64), HardwareTier::Gb64);
        assert_eq!(tier_from_ram(96), HardwareTier::Gb96);
        assert_eq!(tier_from_ram(128), HardwareTier::Gb128);
        assert_eq!(tier_from_ram(192), HardwareTier::Gb128);
        assert_eq!(tier_from_ram(256), HardwareTier::Gb256);
        assert_eq!(tier_from_ram(512), HardwareTier::Gb256);
    }

    #[test]
    fn catalog_has_three_models_per_tier_per_role() {
        let all = catalog();
        assert_eq!(all.len(), 30, "expected 10 tiers × 3 roles");
        for &tier in HardwareTier::all() {
            let in_tier: Vec<&CatalogModel> = all.iter().filter(|m| m.tier == tier).collect();
            assert_eq!(in_tier.len(), 3, "tier {:?} should have 3 picks", tier);
            for role in [ModelRole::Speed, ModelRole::Quality, ModelRole::Balanced] {
                let count = in_tier.iter().filter(|m| m.role == role).count();
                assert_eq!(
                    count, 1,
                    "tier {:?} role {:?} should have exactly 1 pick",
                    tier, role
                );
            }
        }
    }

    #[test]
    fn offerable_catalog_keeps_every_tool_capable_entry() {
        let all = catalog();
        let offered = offerable_catalog();
        // August 2026 catalog is tool-capable throughout — if that changes,
        // update this test deliberately rather than silently shipping duds.
        assert_eq!(offered.len(), all.len());
        assert!(offered.iter().all(|m| m.supports_native_tools));
        let dropped: Vec<_> = all
            .iter()
            .filter(|m| !m.supports_native_tools)
            .map(|m| m.repo_id.as_str())
            .collect();
        assert!(
            dropped.is_empty(),
            "unexpected non-tool entries (would be hidden from UI): {:?}",
            dropped
        );
    }

    #[test]
    fn every_tier_still_offers_at_least_one_pick() {
        let offered = offerable_catalog();
        for &tier in HardwareTier::all() {
            let count = offered.iter().filter(|m| m.tier == tier).count();
            assert!(count > 0, "tier {:?} lost every pick", tier);
            assert_eq!(count, 3, "tier {:?} should offer all 3 roles", tier);
        }
    }

    #[test]
    fn catalog_repo_ids_are_unique() {
        let all = catalog();
        let mut ids: Vec<_> = all.iter().map(|m| m.repo_id.as_str()).collect();
        ids.sort();
        let len = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), len, "duplicate repo ids in catalog");
    }

    #[test]
    fn tight_tiers_set_kv_limits() {
        for m in catalog() {
            if m.tier.ram_gb() <= 12 {
                assert_eq!(
                    m.kv_bits,
                    Some(4),
                    "{} on {}GB should quantize KV",
                    m.repo_id,
                    m.tier.ram_gb()
                );
                assert!(
                    m.max_kv_size.is_some(),
                    "{} on {}GB should cap KV length",
                    m.repo_id,
                    m.tier.ram_gb()
                );
            }
        }
    }

    #[test]
    fn model_weights_roughly_fit_their_tier() {
        // Soft guard: on-disk size should not exceed the tier's nominal RAM.
        // Runtime ram_gb may slightly exceed for the largest picks (we cap
        // max_kv_size there) but disk alone must always fit.
        for m in catalog() {
            assert!(
                m.size_gb <= m.tier.ram_gb() as f32,
                "{} disk {:.1}GB exceeds tier {}GB",
                m.repo_id,
                m.size_gb,
                m.tier.ram_gb()
            );
        }
    }

    #[test]
    fn tier_labels_match_gb() {
        assert_eq!(HardwareTier::Gb8.label(), "8 GB");
        assert_eq!(HardwareTier::Gb256.label(), "256 GB");
    }
}
