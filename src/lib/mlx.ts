import { invoke } from "@tauri-apps/api/core";

export type MlxBootstrapState =
  | { state: "idle" }
  | { state: "checkingPython" }
  | {
      state: "pythonMissing";
      suggestion: string;
      canAutoInstall: boolean;
      installer?: string;
    }
  | { state: "installingPython"; tool: string; line?: string }
  | { state: "installToolMissing"; hint: string }
  | { state: "creatingVenv" }
  | { state: "installingMlxLm"; line?: string }
  | { state: "installFailed"; error: string }
  | { state: "ready"; pythonPath: string };

export type MlxModelSource = "lmStudio" | "huggingFace" | "xanomManaged";

export interface MlxModel {
  id: string;
  displayName: string;
  source: MlxModelSource;
  path: string;
  sizeBytes: number;
  quant?: string;
  contextWindow?: number;
  /**
   * Whether the model's chat template emits structured `tool_calls`. Rust only
   * ever returns models where this is true — it's carried through so callers
   * can't mistake an unfiltered list for a filtered one.
   */
  supportsTools: boolean;
}

/** OpenCode and the Pi CLI both address our models as `local/<id>`. */
export function localModelSlug(modelId: string): string {
  return modelId.startsWith("local/") ? modelId : `local/${modelId}`;
}

/** True for harness slugs that hit the agmux local gateway (`local/<org>/<repo>`). */
export function isLocalModelSlug(model: string | null | undefined): boolean {
  return typeof model === "string" && model.startsWith("local/");
}

/**
 * Compact sidebar / pill label for a local model id.
 *
 * Accepts either a harness slug (`local/mlx-community/Qwen3.6-27B-MLX-4bit`)
 * or a bare discovery id (`mlx-community/Qwen3.6-27B-MLX-4bit`). Strips the
 * `local/` prefix and org segment, then prettifies:
 *   `local/mlx-community/Qwen3.6-27B-MLX-4bit` → `Qwen 3.6 27B`
 *   `Qwen3-Coder-30B-A3B-Instruct-4bit` → `Qwen 3 Coder 30B`
 */
export function formatLocalModelLabel(model: string | null | undefined): string | null {
  if (!model) return null;
  let s = model.trim();
  if (!s) return null;
  if (s.startsWith("local/")) s = s.slice("local/".length);
  // Last path segment is the HF repo / folder name.
  const tail = s.includes("/") ? (s.split("/").pop() ?? s) : s;
  const pretty = prettifyMlxModelName(tail);
  return pretty || null;
}

/**
 * Which installed model a brand-new local session should open on: the
 * caller's preferred id when it is actually installed, otherwise the first
 * installed model, otherwise `null` (nothing installed — the caller should
 * send the user to Settings → Local Models instead of opening a session).
 *
 * Shared by the chat draft and the Pi terminal "local" tile so both surfaces
 * resolve identically. `preferred` may arrive already `local/`-prefixed
 * (it comes from `lastUsedModel`), so strip that before matching.
 */
export function resolveLocalModelId(
  models: MlxModel[] | undefined,
  preferred: string | null | undefined,
): string | null {
  const installed = models ?? [];
  const bare = preferred ? preferred.replace(/^local\//, "") : "";
  if (bare && installed.some((m) => m.id === bare)) return bare;
  return installed[0]?.id ?? null;
}

/**
 * Turn raw HF/MLX model directory names into human-readable labels.
 * Strips trailing quant + MLX tags. Truncates at the first active-params
 * token (e.g. `A3B`) or variant suffix (`Instruct`, `Chat`, `Base`, `IT`,
 * `SFT`, `DPO`, `RL`, `RLHF`), but keeps total-size tokens like `30B`/`27B`:
 * `Qwen3-Coder-30B-A3B-Instruct-MLX-8bit` → `Qwen 3 Coder 30B`,
 * `Qwen3-27B` → `Qwen 3 27B`. Idempotent.
 *
 * Prefer {@link formatLocalModelLabel} when the input may include a
 * `local/` prefix or `org/repo` path — this function expects a bare name.
 */
export function prettifyMlxModelName(name: string): string {
  // Tolerate accidental full slugs so callers don't double-render org paths.
  let base = name.trim();
  if (base.startsWith("local/")) base = base.slice("local/".length);
  if (base.includes("/")) base = base.split("/").pop() || base;

  const cleaned = base
    .replace(/[-_](?:[2-8]bit|bf16|fp16|q[2-8]|mxfp4|mxfp8|optiq)$/i, "")
    .replace(/[-_](?:mlx|MLX)$/g, "")
    // Dated instruct builds: Qwen3-4B-Instruct-2507 → drop the date token later
    .replace(/[-_]\d{4}$/g, "");

  const tokens = cleaned.split(/[-_]+/).filter(Boolean);
  const activeRe = /^a\d+[bmk]?$/i;
  // Pure date tokens mid-name (2507, 2512) after a variant word are dropped
  // by stopping at variant suffixes.
  const variantSuffixes = new Set([
    "instruct",
    "chat",
    "base",
    "it",
    "sft",
    "dpo",
    "rl",
    "rlhf",
  ]);

  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (i > 0) {
      if (activeRe.test(t)) break;
      if (variantSuffixes.has(t.toLowerCase())) break;
      // Skip bare 4-digit build dates that sometimes trail sizes.
      if (/^\d{4}$/.test(t)) continue;
    }
    kept.push(t);
  }

  return (kept.length ? kept : tokens)
    .join(" ")
    // Qwen3.6 → Qwen 3.6 ; Qwen3 → Qwen 3 (but keep 27B intact)
    .replace(/([A-Za-z]{2,})(\d)/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^([a-z])/, (c) => c.toUpperCase());
}

export const mlxBootstrapStatus = () =>
  invoke<MlxBootstrapState>("mlx_bootstrap_status");

export const mlxStartBootstrap = () =>
  invoke<void>("mlx_start_bootstrap");

/** Same as mlxStartBootstrap, but auto-installs Python via uv (preferred) or
 *  brew if it isn't found. Streams progress through the same
 *  `mlx-bootstrap-progress` event channel. */
export const mlxInstallPython = () =>
  invoke<void>("mlx_install_python");

export const mlxListModels = () =>
  invoke<MlxModel[]>("mlx_list_models");

export const mlxRefreshModels = () =>
  invoke<MlxModel[]>("mlx_refresh_models");

export type MlxCapability = {
  /** This machine can run local models at all (Apple Silicon). Entry points
   *  gate on this; the `needs*` flags say which setup step the click leads to. */
  supported: boolean;
  available: boolean;
  reason: string | null;
  needsPython: boolean;
  needsVenv: boolean;
  needsModel: boolean;
};

export const mlxCapability = () => invoke<MlxCapability>("mlx_capability");

export const mlxGatewayStatus = () => invoke<boolean>("mlx_gateway_status");

/** Force-unload the currently-loaded MLX model from RAM. The next chat
 *  request will transparently respawn and reload. */
export const mlxEjectModel = () => invoke<void>("mlx_eject_model");

// ─── Local Models settings tab ──────────────────────────────────────────────

/** Unified-memory recommendation bucket (GB). Matches Rust `HardwareTier`. */
export type HardwareTier =
  | "8"
  | "12"
  | "16"
  | "24"
  | "32"
  | "48"
  | "64"
  | "96"
  | "128"
  | "256";

export type ModelRole = "speed" | "quality" | "balanced";

export const HARDWARE_TIERS: readonly HardwareTier[] = [
  "8",
  "12",
  "16",
  "24",
  "32",
  "48",
  "64",
  "96",
  "128",
  "256",
] as const;

export function tierLabel(tier: HardwareTier): string {
  return `${tier} GB`;
}

export function tierOrder(tier: HardwareTier): number {
  return Number(tier);
}

export interface MlxHardwareInfo {
  chip: string;
  totalRamGb: number;
  cores: number;
  tier: HardwareTier;
  isAppleSilicon: boolean;
}

export interface CatalogModel {
  repoId: string;
  name: string;
  params: string;
  quant: string;
  sizeGb: number;
  /** Catalog's static estimate. Display `memoryGb` instead. */
  ramGb: number;
  /** Memory agmux reserves for this model on this Mac, conversation cache
   *  included — the same figure it checks before loading the model. */
  memoryGb: number;
  /** False when this Mac doesn't have enough memory to run it. */
  fitsThisMac: boolean;
  description: string;
  tier: HardwareTier;
  role: ModelRole;
  installed: boolean;
  /** Per-tier KV-cache quantization (bits). Applied when the model loads. */
  kvBits: number | null;
  /** Per-tier rotating KV cache cap (tokens). Applied when the model loads. */
  maxKvSize: number | null;
  /** True when the model has a chat template that mlx-lm can parse into
   *  structured OpenAI-style tool calls (includes qwen3_coder as of 0.31). */
  supportsNativeTools: boolean;
  /** True when the model has Qwen 2.5-Coder FIM tokens. */
  supportsFim: boolean;
}

export interface MlxDownloadProgress {
  repoId: string;
  stage: string;
  percent: number | null;
  message: string | null;
  complete: boolean;
  cancelled: boolean;
  error: string | null;
}

export interface MlxDownloadStatus {
  active: boolean;
  repoId: string | null;
}

export interface HfSearchHit {
  id: string;
  downloads: number;
  likes: number;
  tags: string[];
}

export const mlxHardwareInfo = () =>
  invoke<MlxHardwareInfo>("mlx_hardware_info");

export const mlxModelCatalog = () =>
  invoke<CatalogModel[]>("mlx_model_catalog");

export const mlxDownloadStatus = () =>
  invoke<MlxDownloadStatus>("mlx_download_status");

export const mlxDownloadModel = (repoId: string) =>
  invoke<void>("mlx_download_model", { repoId });

export const mlxCancelDownload = () =>
  invoke<void>("mlx_cancel_download");

export const mlxDeleteCatalogModel = (repoId: string) =>
  invoke<void>("mlx_delete_catalog_model", { repoId });

export const mlxSearchHfModels = (query: string) =>
  invoke<HfSearchHit[]>("mlx_search_hf_models", { query });

export interface ExaKeyStatus {
  configured: boolean;
  source: "env" | "settings" | "none";
  last4: string;
}

export const mlxGetExaApiKeyStatus = () =>
  invoke<ExaKeyStatus>("mlx_get_exa_api_key_status");

export const mlxSetExaApiKey = (key: string) =>
  invoke<void>("mlx_set_exa_api_key", { key });

export const mlxClearExaApiKey = () => invoke<void>("mlx_clear_exa_api_key");
