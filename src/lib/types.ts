export interface Project {
  id: string;
  name: string;
  repo_path: string;
  conventions: string;
  created_at: string;
}

export type Provider = "ClaudeCode" | "Codex" | "Droid" | "Kimi" | "Pi" | "OpenCode" | "MLX" | "Grok" | "Cursor" | "Cline" | "Gemini" | "Hermes";

/** Draft-chat provider picker (same set as real DB providers). */
export type DraftProvider = Provider;

/**
 * Providers that ship a TUI and have no structured chat view in agmux.
 * These providers always render via TerminalView with the Claude-style
 * top bar. Note: this helper is for top-bar / render-branch parity only —
 * do NOT use it to force DirectRepo work mode, because ClaudeCode supports
 * Worktree mode (and Grok ships its own `-w/--worktree` flag).
 */
export function isTerminalOnlyProvider(p: Provider): boolean {
  return (
    p === "ClaudeCode" ||
    p === "Droid" ||
    p === "Kimi" ||
    p === "Pi" ||
    p === "OpenCode" ||
    p === "Grok" ||
    p === "Cline" ||
    p === "Gemini" ||
    p === "Hermes"
  );
}

/**
 * Short display name for a provider, used in default thread names like
 * "New Claude Thread", "New Codex Thread", etc.
 */
export function providerDisplayName(p: Provider): string {
  switch (p) {
    case "ClaudeCode":
      return "Claude";
    case "Codex":
      return "Codex";
    case "Droid":
      return "Droid";
    case "Kimi":
      return "Kimi";
    case "Pi":
      return "Pi";
    case "OpenCode":
      return "OpenCode";
    case "MLX":
      return "MLX";
    case "Grok":
      return "Grok";
    case "Cursor":
      return "Cursor";
    case "Cline":
      return "Cline";
    case "Gemini":
      return "Gemini";
    case "Hermes":
      return "Hermes";
    default: {
      const _exhaustive: never = p;
      return _exhaustive;
    }
  }
}

/**
 * Default placeholder thread name shown before the first prompt is summarized.
 * Format: "New <Provider> Thread" — e.g. "New Claude Thread", "New OpenCode Thread".
 */
export function defaultThreadName(p: Provider): string {
  return `New ${providerDisplayName(p)} Thread`;
}

export type ThreadStatus = "Idle" | "Running" | "Done" | "Error";
/** Codex reasoning efforts. GPT-5.6 adds `max` (all tiers) and `ultra`
 *  (Sol/Terra only — max reasoning with automatic task delegation). */
export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type InteractionMode = "pty" | "sdk" | "opencode-sdk" | "mlx" | "grok-sdk" | "cursor-sdk" | "gemini-sdk";

export interface Thread {
  id: string;
  project_id: string;
  name: string;
  provider: Provider;
  run_mode: string;
  work_mode: string;
  work_dir: string;
  state_dir: string;
  status: ThreadStatus;
  created_at: string;
  last_active: string;
  model: string | null;
  reasoning_effort: string | null;
  fast_mode: number;
  is_archived: number;
  worktree_branch: string | null;
  interaction_mode: InteractionMode;
  sdk_session_id: string | null;
  opencode_session_id: string | null;
  forked_from_thread_id: string | null;
  forked_at_message_index: number | null;
  lines_added: number;
  lines_removed: number;
  files_changed: number;
  /** NULL/"code" = Claude Code agent; "cowork" = knowledge-work SDK profile. */
  agent_profile?: string | null;
}

// ── SDK Event Types ──────────────────────────────────────

/** Union of all events emitted on the `sdk-event-{threadId}` channel. */
export type SdkEvent =
  | SdkContentDelta
  | SdkToolStarted
  | SdkToolCompleted
  | SdkApprovalRequested
  | SdkUserInputRequested
  | SdkTaskNotification
  | SdkTurnCompleted
  | SdkUsageUpdate
  | SdkSessionStarted
  | SdkSessionEnded
  | SdkSessionInit
  | SdkCompactBoundary
  | SdkRateLimit
  | SdkError
  | SdkStatus
  | SdkHookStarted
  | SdkHookResponse
  | SdkToolProgress
  | SdkTaskStarted
  | SdkTaskProgress
  | SdkCommandOutput
  | SdkAuthStatus
  | SdkFilesPersisted;

export interface SdkContentDelta {
  type: "content.delta";
  contentType: "text" | "thinking";
  text: string;
}

export interface SdkToolStarted {
  type: "tool.started";
  toolUseId: string;
  parentToolUseId?: string | null;
  name: string;
  input: Record<string, unknown>;
}

export interface SdkToolCompleted {
  type: "tool.completed";
  toolUseId: string;
  parentToolUseId?: string | null;
  content: string;
  isError: boolean;
}

export interface SdkApprovalRequested {
  type: "approval.requested";
  requestId: string;
  toolName: string;
  detail: string;
  requestType: "command_execution" | "file_change" | "file_read" | "dynamic_tool_call";
}

/** One selectable choice in an AskUserQuestion question. */
export interface AskQuestionOption {
  label: string;
  description?: string;
  /** Optional preview content (mockup / code snippet) shown when the option is selected. */
  preview?: string;
}

/** A single AskUserQuestion question with its multiple-choice options. */
export interface AskQuestion {
  question: string;
  /** Short chip label (e.g. "Auth method"). */
  header?: string;
  options: AskQuestionOption[];
  /** When true the user may pick more than one option. */
  multiSelect?: boolean;
}

export interface SdkUserInputRequested {
  type: "userInput.requested";
  requestId: string;
  questions: AskQuestion[];
}

export interface SdkTaskNotification {
  type: "task.notification";
  taskId: string | null;
  title: string;
  body: string;
  status: "completed" | "failed" | "stopped" | null;
  summary: string | null;
}

export interface SdkTurnCompleted {
  type: "turn.completed";
  sessionId: string | null;
  model: string | null;
  /** Grok ACP stopReason (e.g. cancelled). Claude SDK omits this. */
  _stopReason?: string;
  stopReason?: string;
  /** Per-model usage with contextWindow from the SDK result — used to derive maxTokens */
  modelUsage: Record<string, { contextWindow?: number }> | null;
  /** Latest user message UUID — used as rewind target for undo */
  userMessageUuid: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalCostUsd: number;
    numTurns: number;
  };
}

export interface SdkSessionStarted {
  type: "session.started";
  sessionId?: string;
}

export interface SdkSessionEnded {
  type: "session.ended";
  reason: "completed" | "error" | "interrupted";
}

export interface SdkUsageUpdate {
  type: "usage.update";
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** total_tokens from the API if provided — preferred for context window sizing */
  totalTokens: number | null;
  /** ACP `usage_update.size` when the agent reports the live window. */
  maxTokens?: number | null;
}

export interface SdkSessionInit {
  type: "session.init";
  sessionId: string | null;
  slashCommands: string[];
}

export interface SdkCompactBoundary {
  type: "compact.boundary";
  preTokens: number | null;
  trigger: string | null;
}

export interface SdkRateLimit {
  type: "rate.limit";
  message: string;
  retryAfterSeconds: number | null;
}

export interface SdkError {
  type: "error";
  message: string;
}

export interface SdkStatus {
  type: "status";
  status: string | null;
  message: string;
}

export interface SdkHookStarted {
  type: "hook.started";
  hookName: string;
  hookEvent: string;
}

export interface SdkHookResponse {
  type: "hook.response";
  hookName: string;
  hookEvent: string;
  outcome: string;
  exitCode: number | null;
}

export interface SdkToolProgress {
  type: "tool.progress";
  toolUseId: string | null;
  content: string;
}

export interface SdkTaskStarted {
  type: "task.started";
  taskId: string | null;
  description: string;
}

export interface SdkTaskProgress {
  type: "task.progress";
  taskId: string | null;
  status: string;
  lastToolName: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalTokens: number | null;
    toolUses: number;
    durationMs: number;
  } | null;
}

/** State of a background task tracked by the session view. */
export type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped";

export interface BackgroundTask {
  taskId: string;
  /** toolUseId of the Agent tool that dispatched this background task */
  toolUseId: string | null;
  description: string;
  status: BackgroundTaskStatus;
  lastToolName: string | null;
  toolUses: number;
  durationMs: number;
  summary: string | null;
}

export interface SdkCommandOutput {
  type: "command.output";
  command: string;
  output: string;
}

export interface SdkAuthStatus {
  type: "auth.status";
  status: string;
  message: string;
}

export interface SdkFilesPersisted {
  type: "files.persisted";
  files: Array<{ filename: string; fileId: string }>;
  failed: Array<{ filename: string; error: string }>;
  uuid: string | null;
  sessionId: string | null;
}

export interface CodexModelOption {
  slug: string;
  name: string;
}

/** Convert a raw Codex model slug into a human-friendly display name.
 *  e.g. "gpt-5.3-codex" → "GPT 5.3 Codex", "gpt-5.6-sol" → "GPT 5.6 Sol" */
export function prettifyCodexModelName(slug: string): string {
  // Split on hyphens, capitalise each segment intelligently
  const parts = slug.split("-");
  const result: string[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    // "gpt" prefix — merge with the version number that follows (e.g. "gpt" + "5.6" → "GPT 5.6")
    if (part.toLowerCase() === "gpt" && i + 1 < parts.length && /^\d/.test(parts[i + 1])) {
      result.push(`GPT ${parts[i + 1]}`);
      i += 2;
      continue;
    }
    // Capitalise first letter of remaining segments
    result.push(part.charAt(0).toUpperCase() + part.slice(1));
    i++;
  }
  return result.join(" ");
}

/** Convert an OpenCode slug (`provider/model`, e.g. `openrouter/minimax-2.7` or
 *  `opencode-go/minimax-m2.7`) into a human-friendly display label
 *  (`MiniMax 2.7`, `Claude Sonnet 4.5`). Strips the provider prefix and
 *  title-cases the model id, with special-case handling for common models. */
export function prettifyOpenCodeSlug(slug: string | null | undefined): string {
  if (!slug) return "";
  const part = slug.includes("/") ? (slug.split("/")[1] ?? slug) : slug;
  const SPECIAL: Record<string, string> = {
    "gpt-6-sol": "GPT 6 Sol",
    "gpt-6-luna": "GPT 6 Luna",
    "minimax-2.7": "MiniMax 2.7",
    "minimax-m2.7": "MiniMax 2.7",
    "minimax-2.6": "MiniMax 2.6",
    "minimax-m2.6": "MiniMax 2.6",
    "deepseek-v3": "DeepSeek V3",
    "deepseek-r1": "DeepSeek R1",
    "qwen-2.5": "Qwen 2.5",
    "qwen3": "Qwen 3",
    "gpt-5.6-sol": "GPT 5.6 Sol",
    "gpt-5.6-terra": "GPT 5.6 Terra",
    "gpt-5.6-luna": "GPT 5.6 Luna",
    "gpt-5.4": "GPT 5.4",
    "gpt-5.4-mini": "GPT 5.4 mini",
    "gpt-4o": "GPT-4o",
    "gpt-4o-mini": "GPT-4o mini",
  };
  if (SPECIAL[part]) return SPECIAL[part];
  if (part.startsWith("claude-")) {
    const rest = part.slice("claude-".length);
    return "Claude " + rest
      .split("-")
      .map((w, i) => /^\d+$/.test(w) ? (i === 0 ? w : "." + w) : w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")
      .replace(/ \./g, ".");
  }
  if (part.startsWith("gemini-")) {
    return "Gemini " + part.slice("gemini-".length).replace(/-/g, " ");
  }
  return part
    .split(/[-_]/)
    .map((w) => /^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export const CODEX_MODELS: CodexModelOption[] = [
  { slug: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
  { slug: "gpt-6-sol", name: "GPT 6 Sol" },
  { slug: "gpt-6-luna", name: "GPT 6 Luna" },
  { slug: "gpt-5.6-terra", name: "GPT 5.6 Terra" },
  { slug: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
];

/** Retired Codex slugs — still valid for historical sessions / pricing, but
 *  hidden from the model picker even if `model/list` still returns them.
 *  Keep Spark variants (e.g. gpt-5.3-codex-spark) — only the base 5.3 Codex is retired. */
const CODEX_RETIRED_SLUGS = new Set([
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.4",
]);

/**
 * Build the Codex picker from `model/list`.
 *
 * Live catalog is the source of truth so new models appear without an app
 * update. The curated `CODEX_MODELS` list is only used when the live list is
 * empty (CLI not running / request failed). Retired slugs are dropped even
 * if the server still returns them, and slugs are de-duplicated (first
 * occurrence wins). Names are always prettified from the slug — live
 * display names are often hyphenated ("GPT-5.6-Sol").
 */
export function mergeCodexModelOptions(
  dynamic: readonly { slug: string; name: string }[] | null | undefined,
): CodexModelOption[] {
  const dyn = (dynamic ?? []).filter((m) => !CODEX_RETIRED_SLUGS.has(m.slug));
  if (dyn.length === 0) {
    return CODEX_MODELS.map((m) => ({ slug: m.slug, name: m.name }));
  }

  const seen = new Set<string>();
  const out: CodexModelOption[] = [];
  for (const m of dyn) {
    if (seen.has(m.slug)) continue;
    seen.add(m.slug);
    out.push({ slug: m.slug, name: prettifyCodexModelName(m.slug) });
  }
  return out;
}

export const CODEX_REASONING_EFFORTS: {
  value: CodexReasoningEffort;
  label: string;
  description: string;
}[] = [
  { value: "low", label: "Low", description: "Fast responses with lighter reasoning" },
  { value: "medium", label: "Medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { value: "high", label: "High", description: "Greater reasoning depth for complex problems" },
  { value: "xhigh", label: "Extra High", description: "Extra high reasoning depth for complex problems" },
  { value: "max", label: "Max", description: "Maximum reasoning depth for the hardest problems" },
  { value: "ultra", label: "Ultra", description: "Maximum reasoning with automatic task delegation" },
];

const CODEX_BASE_EFFORTS: readonly CodexReasoningEffort[] = ["low", "medium", "high", "xhigh"];

/** Parse a raw effort string into a known Codex effort, or null. */
export function normalizeCodexEffort(value: unknown): CodexReasoningEffort | null {
  return value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max" ||
    value === "ultra"
    ? value
    : null;
}

/**
 * Whether a Codex model supports a given reasoning effort.
 * Source: Codex `model/list` supportedReasoningEfforts.
 * - All models: low / medium / high / xhigh
 * - GPT-5.6 family and GPT-6 Sol / Luna: + max
 * - GPT-5.6 Sol / Terra and GPT-6 Sol: + ultra (Luna does not)
 */
export function supportsCodexEffort(
  model: string | null | undefined,
  effort: string,
): boolean {
  if (CODEX_BASE_EFFORTS.includes(effort as CodexReasoningEffort)) return true;
  const slug = (model ?? "").toLowerCase();
  const is56 =
    slug.includes("gpt-5.6") ||
    slug.includes("5.6-sol") ||
    slug.includes("5.6-terra") ||
    slug.includes("5.6-luna");
  if (effort === "max") return is56 || slug.includes("gpt-6-sol") || slug.includes("gpt-6-luna");
  if (effort === "ultra") {
    return (
      slug.includes("gpt-5.6-sol") ||
      slug.includes("gpt-5.6-terra") ||
      slug.includes("gpt-6-sol") ||
      slug.includes("5.6-sol") ||
      slug.includes("5.6-terra")
    );
  }
  return false;
}

/** Effort options to show in the picker for the active Codex model. */
export function codexEffortsForModel(
  model: string | null | undefined,
): typeof CODEX_REASONING_EFFORTS {
  return CODEX_REASONING_EFFORTS.filter((e) => supportsCodexEffort(model, e.value));
}

/** Clamp an effort to one the given model supports (prefer current, else high). */
export function clampCodexEffort(
  model: string | null | undefined,
  effort: string | null | undefined,
): CodexReasoningEffort {
  const normalized = normalizeCodexEffort(effort);
  if (normalized && supportsCodexEffort(model, normalized)) return normalized;
  for (const fallback of ["high", "medium", "low", "xhigh"] as const) {
    if (supportsCodexEffort(model, fallback)) return fallback;
  }
  return "medium";
}

export interface ClaudeModelOption {
  slug: string;
  name: string;
}

export const CLAUDE_MODELS: ClaudeModelOption[] = [
  { slug: "claude-fable-5", name: "Fable 5" },
  { slug: "claude-opus-5-5", name: "Opus 5.5" },
  { slug: "claude-opus-5[1m]", name: "Opus 5 (1M)" },
  { slug: "claude-opus-4-8[1m]", name: "Opus 4.8 (1M)" },
  { slug: "claude-sonnet-5", name: "Sonnet 5" },
  { slug: "sonnet", name: "Sonnet 4.6" },
  { slug: "haiku", name: "Haiku 4.5" },
];

export interface ClaudePickerModel {
  slug: string;
  name: string;
  meta: string;
}

interface ParsedClaudeSlug {
  family: string;
  version: number[];
  tier: string | null;
  dated: boolean;
  slug: string;
}

/** Parse `claude-{family}-{version}` plus optional `[1m]` / dated snapshot. */
export function parseClaudeSlug(slug: string): ParsedClaudeSlug | null {
  const trimmed = slug.trim();
  if (!trimmed) return null;
  const tierMatch = trimmed.match(/\[([0-9]+[mk])\]$/i);
  const tier = tierMatch ? tierMatch[1].toLowerCase() : null;
  const base = trimmed.replace(/\[.*\]$/, "");
  const m = base.match(/^claude-(fable|mythos|opus|sonnet|haiku)-(.+)$/i);
  if (!m) return null;
  const family = m[1].toLowerCase();
  const rest = m[2];
  const dated = /(?:^|-)\d{8}$/.test(rest);
  const versionPart = rest.replace(/-\d{8}$/, "");
  const version = versionPart.split(/[-.]/).filter(Boolean).map(Number);
  if (version.length === 0 || version.some((n) => !Number.isFinite(n))) return null;
  return { family, version, tier, dated, slug: trimmed };
}

function claudeVersionCmp(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function claudeFamilyRank(family: string): number {
  if (family === "fable") return 0;
  if (family === "opus") return 2;
  if (family === "sonnet") return 3;
  if (family === "haiku") return 4;
  // New flagship families (whatever ships after Fable) sit just under it.
  return 1;
}

function claudeTakeCount(family: string): number {
  return family === "opus" || family === "sonnet" ? 2 : 1;
}

function isBareClaudeGen4(parsed: ParsedClaudeSlug): boolean {
  if (parsed.family === "fable" || parsed.family === "mythos") return false;
  return parsed.version[0] === 4 && (parsed.version.length === 1 || parsed.version[1] === 0);
}

function preferClaudeTier(family: string): boolean {
  return family !== "haiku";
}

function claudePickerMeta(slug: string, family: string, isLatest: boolean): string {
  const ctx = getModelContextWindow(slug);
  const ctxLabel =
    ctx >= 1_000_000 ? "1M context" : ctx >= 200_000 ? "200K" : `${Math.round(ctx / 1000)}K`;
  const bits = [ctxLabel];
  if (family === "fable" || family === "mythos") bits.push("most capable");
  else if (family === "opus") bits.push(isLatest ? "latest Opus" : "previous Opus");
  else if (family === "sonnet") bits.push(isLatest ? "latest Sonnet" : "fastest · daily driver");
  else if (family === "haiku") bits.push("lightweight · quick edits");
  return bits.join(" · ");
}

function fallbackClaudePicker(): ClaudePickerModel[] {
  return CLAUDE_MODELS.map((m, i, arr) => {
    const parsed = parseClaudeSlug(m.slug);
    const family =
      parsed?.family ??
      (m.slug.includes("fable")
        ? "fable"
        : m.slug.includes("opus")
          ? "opus"
          : m.slug.includes("sonnet") || m.slug === "sonnet"
            ? "sonnet"
            : m.slug.includes("haiku") || m.slug === "haiku"
              ? "haiku"
              : "other");
    const isLatest = !arr.slice(0, i).some((prev) => {
      const p = parseClaudeSlug(prev.slug);
      const prevFamily =
        p?.family ??
        (prev.slug.includes("opus")
          ? "opus"
          : prev.slug.includes("sonnet") || prev.slug === "sonnet"
            ? "sonnet"
            : "");
      return prevFamily === family;
    });
    return {
      slug: m.slug,
      name: getClaudeModelDisplayName(m.slug),
      meta: claudePickerMeta(m.slug, family, isLatest),
    };
  });
}

/**
 * Build the Anthropic picker from slugs discovered in the installed Claude
 * CLI. Newer built-in entries supplement stale installed catalogs; discovered
 * models still appear without an app update. Empty / unusable input falls
 * back to `CLAUDE_MODELS`.
 *
 * Policy: latest of each family, plus the previous Opus and Sonnet. Prefer
 * the `[1m]` slug when the CLI lists one (except Haiku). Mythos, dated
 * snapshots, and bare gen-4 aliases are omitted.
 */
export function mergeClaudeModelOptions(
  dynamic: readonly string[] | readonly { slug: string }[] | null | undefined,
): ClaudePickerModel[] {
  const slugs = (dynamic ?? [])
    .map((s) => (typeof s === "string" ? s : s.slug))
    .filter((s): s is string => typeof s === "string" && s.length > 0);

  const parsed = slugs
    .map(parseClaudeSlug)
    .filter((p): p is ParsedClaudeSlug => {
      if (!p) return false;
      if (p.family === "mythos") return false;
      if (p.dated) return false;
      if (isBareClaudeGen4(p)) return false;
      return true;
    });

  if (parsed.length === 0) return fallbackClaudePicker();

  // An older installed CLI must not hide newer built-in models. Only add
  // versions newer than its catalog, preserving discovered variants/tiers.
  for (const model of CLAUDE_MODELS) {
    const fallback = parseClaudeSlug(model.slug);
    if (!fallback) continue;
    const family = parsed.filter((p) => p.family === fallback.family);
    if (family.length > 0 && family.every((p) => claudeVersionCmp(fallback.version, p.version) > 0)) {
      parsed.push(fallback);
    }
  }

  const byVersion = new Map<string, ParsedClaudeSlug[]>();
  for (const p of parsed) {
    const key = `${p.family}:${p.version.join(".")}`;
    const arr = byVersion.get(key) ?? [];
    arr.push(p);
    byVersion.set(key, arr);
  }

  const chosen: ParsedClaudeSlug[] = [];
  for (const [key, variants] of byVersion) {
    const family = key.split(":")[0] ?? "";
    const wantTier = preferClaudeTier(family);
    const ranked = [...variants].sort((a, b) => {
      const aTier = a.tier ? 1 : 0;
      const bTier = b.tier ? 1 : 0;
      return wantTier ? bTier - aTier : aTier - bTier;
    });
    const pick = ranked[0];
    if (pick) chosen.push(pick);
  }

  const byFamily = new Map<string, ParsedClaudeSlug[]>();
  for (const p of chosen) {
    const arr = byFamily.get(p.family) ?? [];
    arr.push(p);
    byFamily.set(p.family, arr);
  }

  const families = [...byFamily.keys()].sort(
    (a, b) => claudeFamilyRank(a) - claudeFamilyRank(b) || a.localeCompare(b),
  );

  const out: ClaudePickerModel[] = [];
  for (const family of families) {
    const versions = (byFamily.get(family) ?? []).sort((a, b) =>
      claudeVersionCmp(b.version, a.version),
    );
    const take = versions.slice(0, claudeTakeCount(family));
    take.forEach((p, i) => {
      out.push({
        slug: p.slug,
        name: getClaudeModelDisplayName(p.slug),
        meta: claudePickerMeta(p.slug, family, i === 0),
      });
    });
  }
  return out.length > 0 ? out : fallbackClaudePicker();
}

export interface GrokModelOption {
  slug: string;
  name: string;
}

/**
 * Curated default models for the xAI Grok Build CLI. The CLI's authoritative
 * list comes from `grok models` at runtime — this is a fallback used before
 * we've shelled out to discover the live default.
 *
 * `grok-4.3` is retired: still prettified for history, but not offered in the
 * picker (same pattern as retired Claude Opus versions).
 */
export const GROK_MODELS: GrokModelOption[] = [
  { slug: "grok-4.7", name: "Grok 4.7" },
  { slug: "grok-4.6", name: "Grok 4.6" },
  { slug: "grok-4.5", name: "Grok 4.5" },
];

/** Display names for retired / aliased Grok slugs still present on old threads. */
const GROK_LEGACY_DISPLAY_NAMES: Record<string, string> = {
  "grok-4.3": "Grok 4.3",
  "grok-build": "Grok Build",
  // Composer was briefly offered under xAI chat; keep labels for historical threads.
  "composer-2.5": "Composer 2.5",
  "grok-composer-2.5-fast": "Composer 2.5",
};

export const CURSOR_MODELS = [
  { slug: "composer-2.5", name: "Cursor Composer 2.5", meta: "default" },
] as const;

/** Map a grok model slug to a compact display name. Falls back to a
 *  title-cased version of the slug when grok returns a model we don't know. */
export function prettifyGrokModel(slug: string | null | undefined): string | null {
  if (!slug) return null;
  const known = GROK_MODELS.find((m) => m.slug === slug);
  if (known) return known.name;
  if (GROK_LEGACY_DISPLAY_NAMES[slug]) return GROK_LEGACY_DISPLAY_NAMES[slug];
  // Generic prettifier — drop the leading "grok-" and title-case the rest,
  // so unknown ids like "grok-4-fast" render as "4 Fast" rather than the raw
  // slug. Keep numbers as-is.
  const stripped = slug.replace(/^grok-/i, "");
  if (!stripped) return slug;
  const titled = stripped
    .split("-")
    .map((p) => (p.length === 0 ? p : p[0].toUpperCase() + p.slice(1)))
    .join(" ");
  return `Grok ${titled}`;
}

/** Join spaced version digits so `Fable 5 1` renders as `Fable 5.1`. */
function joinVersionDigits(label: string): string {
  let prev = "";
  let next = label;
  while (next !== prev) {
    prev = next;
    next = next.replace(/\b(\d+(?:\.\d+)*) (\d+)\b/g, "$1.$2");
  }
  return next;
}

/** Compact sidebar/top-bar label for Cursor model slugs.
 *  Strips query params (`?thinking=high`), maps Composer + Claude Cursor ids
 *  to short titles, and title-cases unknown slugs. */
export function prettifyCursorModel(slug: string | null | undefined): string | null {
  if (!slug) return null;
  const base = slug.split("?")[0]?.trim();
  if (!base) return null;

  // Composer family: composer-2 / composer-2.5
  const composer = base.match(/^composer-(\d+(?:\.\d+)?)$/i);
  if (composer) return `Composer ${composer[1]}`;

  // Cursor Claude ids: claude-4.6-sonnet-medium-thinking, claude-4-opus, claude-fable-5-1
  if (/^claude[-/]/i.test(base)) {
    let rest = base.replace(/^claude[-/]/i, "");
    let thinking = false;
    if (/-thinking$/i.test(rest)) {
      thinking = true;
      rest = rest.replace(/-thinking$/i, "");
    }
    // Drop effort rung (medium/high/…) — keeps sidebar compact.
    rest = rest.replace(/-(?:low|medium|high|xhigh|max|extra-high)$/i, "");

    // version-first: 4.6-sonnet / 4-opus / 5-1-fable
    const vf = rest.match(/^(\d+(?:[.-]\d+)*)-([a-z][\w]*)$/i);
    if (vf) {
      const family = vf[2].charAt(0).toUpperCase() + vf[2].slice(1).toLowerCase();
      return `${family} ${vf[1].replace(/-/g, ".")}${thinking ? " Thinking" : ""}`;
    }
    // family-first: sonnet-4.6 / opus-4 / fable-5-1
    const fv = rest.match(/^([a-z][\w]*)-(\d+(?:[.-]\d+)*)$/i);
    if (fv) {
      const family = fv[1].charAt(0).toUpperCase() + fv[1].slice(1).toLowerCase();
      return `${family} ${fv[2].replace(/-/g, ".")}${thinking ? " Thinking" : ""}`;
    }
    const titled = rest
      .split(/[-_/]+/)
      .filter(Boolean)
      .map((p) => (p.length === 0 ? p : p[0].toUpperCase() + p.slice(1)))
      .join(" ");
    return titled ? `${joinVersionDigits(titled)}${thinking ? " Thinking" : ""}` : base;
  }

  // gpt-5 / gemini-2.5-pro / fable-5-1 / etc.
  return joinVersionDigits(
    base
      .replace(/^cursor[-/]/i, "")
      .split(/[-_/]+/)
      .filter(Boolean)
      .map((p) => {
        if (/^gpt$/i.test(p)) return "GPT";
        if (/^\d/.test(p)) return p;
        return p.charAt(0).toUpperCase() + p.slice(1);
      })
      .join(" "),
  );
}

/** Known Kimi Code model display names (from ~/.kimi-code/config.toml). */
const KIMI_MODEL_DISPLAY: Record<string, string> = {
  "kimi-code/kimi-for-coding": "K2.7 Coding",
  "kimi-for-coding": "K2.7 Coding",
  "kimi-code/kimi-for-coding-highspeed": "K2.7 Highspeed",
  "kimi-for-coding-highspeed": "K2.7 Highspeed",
  "kimi-code/k3": "K3",
  k3: "K3",
};

/** Map a Kimi Code model slug to a compact sidebar / top-bar label. */
export function prettifyKimiModel(slug: string | null | undefined): string | null {
  if (!slug) return null;
  if (KIMI_MODEL_DISPLAY[slug]) return KIMI_MODEL_DISPLAY[slug];
  // Strip provider prefix ("kimi-code/…") and title-case the rest.
  const bare = slug.includes("/") ? slug.split("/").pop()! : slug;
  if (KIMI_MODEL_DISPLAY[bare]) return KIMI_MODEL_DISPLAY[bare];
  const titled = bare
    .replace(/^kimi[-_]?/i, "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((p) => (p.length === 0 ? p : p[0].toUpperCase() + p.slice(1)))
    .join(" ");
  return titled || bare;
}

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const CLAUDE_EFFORTS: { value: ClaudeEffort; label: string; description: string }[] = [
  { value: "low", label: "Low", description: "Faster, less thorough" },
  { value: "medium", label: "Medium", description: "Default — balanced speed and quality" },
  { value: "high", label: "High", description: "Thorough reasoning" },
  { value: "xhigh", label: "XHigh", description: "Extra-thorough reasoning (persists across sessions)" },
  { value: "max", label: "Max", description: "Maximum reasoning — uncapped, current session only" },
];

/**
 * Returns true when the given Claude model supports the XHigh / Max
 * extended-thinking effort levels — Fable 5, Sonnet 5, latest Opus flagships
 * (Opus 5, 4.7, 4.8), and the `opus` alias that resolves to them on the CLI side.
 */
export function supportsXHighEffort(slug: string | null | undefined): boolean {
  if (!slug) return false;
  const base = slug.replace(/\[.*\]$/, "").replace(/-\d{8}$/, "").toLowerCase();
  if (base === "opus" || base === "fable" || base === "mythos") return true;
  if (base === "sonnet-5") return true;
  const parsed = parseClaudeSlug(slug);
  if (!parsed) return false;
  if (parsed.family === "fable" || parsed.family === "mythos") return true;
  // Opus 4.7+ (4.6 and older stay on High). Future 5.x ids are included.
  if (parsed.family === "opus") return claudeVersionCmp(parsed.version, [4, 7]) >= 0;
  if (parsed.family === "sonnet") return claudeVersionCmp(parsed.version, [5]) >= 0;
  return false;
}

/**
 * Whether a Grok model catalog entry supports a given reasoning effort.
 *
 * Source of truth: Grok CLI model catalog (`~/.grok/models_cache.json` /
 * cli-chat-proxy). Grok 4.5 lists `low | medium | high`. Grok 4.6 and 4.7
 * add `xhigh`. `max` is a Claude-only session rung — not in the Grok catalog.
 * Composer does not support reasoning effort at all.
 */
export function supportsGrokEffort(
  slug: string | null | undefined,
  effort: string,
): boolean {
  if (!slug) return false;
  // Composer (and any non-reasoning Grok model) has no effort dial.
  if (slug.includes("composer")) return false;
  if (effort === "low" || effort === "medium" || effort === "high") return true;
  if (effort === "xhigh") {
    const base = slug.replace(/\[.*\]$/, "").replace(/-\d{8}$/, "");
    // Prefix covers dated and fast suffixes (grok-4.7-build-fast).
    return base.startsWith("grok-4.6") || base.startsWith("grok-4.7");
  }
  return false;
}

/**
 * Whether an effort option should be disabled in the shared Claude/Grok
 * effort picker for the active provider + model.
 */
export function isEffortOptionDisabled(
  effort: ClaudeEffort,
  opts: { provider?: string | null; model?: string | null },
): boolean {
  const { provider, model } = opts;
  const isGrok =
    provider === "Grok" || (!!model && model.startsWith("grok-"));
  if (isGrok) {
    // Fall back to grok-4.7 when the model slug is empty so the picker still
    // reflects the default Grok catalog (low/medium/high/xhigh).
    return !supportsGrokEffort(model || "grok-4.7", effort);
  }
  if (provider === "Gemini") {
    return effort !== "low" && effort !== "medium" && effort !== "high";
  }
  // Claude: XHigh is Fable 5 / Sonnet 5 / Opus 5 / 4.7 / 4.8 only.
  // Max stays available (session-only).
  if (effort === "xhigh") return !supportsXHighEffort(model);
  return false;
}

export type ClaudeThinkingBudget = "high" | "medium" | "low";

// ── Model Context Windows ────────────────────────────────────────────

/** Default context window sizes per base model slug (tokens). */
const BASE_CONTEXT_WINDOWS: Record<string, number> = {
  // Claude models (full IDs)
  "claude-fable-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-opus-4-5": 200_000,
  "claude-sonnet-5": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
  // Claude models (aliases used by /model command)
  "opus": 1_000_000,
  "sonnet": 1_000_000,
  "haiku": 200_000,
  "opusplan": 1_000_000,
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  "gemini-2.0-flash": 1_000_000,
  "gemini-1.5-pro": 2_000_000,
  // Codex / OpenAI models (context_window from Codex model catalog)
  "gpt-6-sol": 272_000,
  "gpt-6-luna": 272_000,
  "gpt-5.6-sol": 372_000,
  "gpt-5.6-terra": 372_000,
  "gpt-5.6-luna": 372_000,
  "gpt-5.4": 258_000,
  "gpt-5.4-mini": 272_000,
  "gpt-5.3-codex": 200_000,
  "gpt-5.2-codex": 200_000,
  "o4-mini": 200_000,
  "o3": 200_000,
  "codex-mini": 200_000,
  // Grok models — real usage snapshots come from signals.json when available,
  // but these keep the fallback denominator truthful before that file exists.
  "grok-4.7": 500_000,
  "grok-4.6": 500_000,
  "grok-4.5": 500_000,
  "grok-composer-2.5-fast": 200_000,
  // Legacy / retired (still used for historical session ContextRing sizing)
  "grok-4.3": 256_000,
  "grok-build": 512_000,
  "composer-2.5": 200_000,
  // Kimi Code — max_context_size from ~/.kimi-code/config.toml (262144).
  "kimi-code/kimi-for-coding": 262_144,
  "kimi-for-coding": 262_144,
  "kimi-code/kimi-for-coding-highspeed": 262_144,
  "kimi-for-coding-highspeed": 262_144,
  "kimi-code/k3": 262_144,
  k3: 262_144,
};

/** Known context-tier suffixes → token counts (e.g. "[1m]" → 1M). */
const CONTEXT_TIER_SUFFIXES: Record<string, number> = {
  "[1m]": 1_000_000,
  "[500k]": 500_000,
  "[400k]": 400_000,
  "[258k]": 258_000,
  "[200k]": 200_000,
  "[128k]": 128_000,
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Resolve context window size from a model string.
 * Supports suffixes like "claude-opus-4-6[1m]" → 1M tokens.
 * Falls back to base model defaults, then DEFAULT_CONTEXT_WINDOW.
 */
export function getModelContextWindow(modelSlug: string | null | undefined): number {
  if (!modelSlug) return DEFAULT_CONTEXT_WINDOW;

  // Cursor model slugs may carry query params (`composer-2.5?thinking=high`).
  const withoutQuery = modelSlug.split("?")[0] ?? modelSlug;

  // Check for context-tier suffix (e.g. "[1m]", "[400k]")
  for (const [suffix, tokens] of Object.entries(CONTEXT_TIER_SUFFIXES)) {
    if (withoutQuery.endsWith(suffix)) {
      return tokens;
    }
  }

  // Match against base model slugs
  if (BASE_CONTEXT_WINDOWS[withoutQuery]) return BASE_CONTEXT_WINDOWS[withoutQuery];
  const base = withoutQuery.replace(/\[.*\]$/, "");
  if (BASE_CONTEXT_WINDOWS[base]) return BASE_CONTEXT_WINDOWS[base];
  const noDate = base.replace(/-\d{8}$/, "");
  if (BASE_CONTEXT_WINDOWS[noDate]) return BASE_CONTEXT_WINDOWS[noDate];

  // Prefix fallback for full API ids we haven't pinned yet (e.g. dated or
  // provider-qualified variants of known 1M flagships).
  if (
    /claude-opus-5\b/.test(noDate) ||
    /claude-fable-5\b/.test(noDate) ||
    /claude-sonnet-5\b/.test(noDate) ||
    /claude-opus-4-[678]\b/.test(noDate) ||
    /^gemini-/.test(noDate) ||
    /^gemini /i.test(noDate)
  ) {
    return 1_000_000;
  }

  // Family fallback so a new Claude generation (Fable 6, Opus 5.1, …) does
  // not wait for a catalog bump to size the context ring.
  const parsed = parseClaudeSlug(withoutQuery);
  if (parsed) {
    if (parsed.family === "fable" || parsed.family === "mythos" || parsed.family === "opus") {
      return 1_000_000;
    }
    if (parsed.family === "sonnet") return 1_000_000;
    if (parsed.family === "haiku") return 200_000;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Tokens occupying the context window from a usage snapshot.
 *
 * Anthropic-style fields are disjoint: occupancy = input + cache-read + cache-write.
 * Grok / OpenAI-style cache-read is a *subset* of input (xAI `_meta.totalTokens`
 * is input+output; cachedReadTokens is already inside inputTokens). Adding it
 * overcounts — Cursor Grok chats showed 713k / 500k at 100%.
 *
 * `totalTokens` is only trusted as occupancy when the agent also reports a
 * window size (ACP `used` + `size`). Cursor's totalTokens is a billed sum
 * (input+output+cache) and must not drive the ring.
 */
export function contextTokensUsed(
  usage: {
    inputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheCreationTokens?: number | null;
    totalTokens?: number | null;
    maxTokens?: number | null;
  },
  opts?: { preferTotalTokens?: boolean },
): number {
  const input = Math.max(0, usage.inputTokens ?? 0);
  const cacheRead = Math.max(0, usage.cacheReadTokens ?? 0);
  const cacheCreate = Math.max(0, usage.cacheCreationTokens ?? 0);
  const total = usage.totalTokens;
  const max = usage.maxTokens ?? 0;

  if (opts?.preferTotalTokens && total != null && total > 0) {
    return total;
  }

  const disjoint = input + cacheRead + cacheCreate;
  // Cache-read fits inside input *and* adding it overflows the window → subset.
  if (cacheRead > 0 && cacheRead <= input && max > 0 && disjoint > max) {
    return input + cacheCreate;
  }
  return disjoint;
}

/** Map Claude model slugs (e.g. "opus[1m]", "sonnet") to user-friendly display names. */
const CLAUDE_MODEL_DISPLAY_NAMES: Record<string, string> = {
  // The `opus` alias resolves to the latest Opus on the CLI side (currently Opus 5).
  // Retired picker entries (`opus[1m]`, 4.7, 4.6) still prettify for history.
  "opus[1m]": "Claude Opus 4.7",
  opus: "Claude Opus 5",
  "sonnet": "Claude Sonnet 4.6",
  "haiku": "Claude Haiku 4.5",
  // Full model IDs from JSONL history (e.g. "claude-opus-4-7")
  "claude-fable-5": "Claude Fable 5",
  "claude-opus-5": "Claude Opus 5",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  // Older model IDs
  "claude-opus-4-5": "Claude Opus 4.5",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-opus-4-1": "Claude Opus 4.1",
  "claude-sonnet-4-1": "Claude Sonnet 4.1",
};

/**
 * Resolve a Claude model slug to a friendly display name.
 * Returns the full name (e.g. "Claude Opus 4.6") or "Claude" if unknown.
 */
export function getClaudeModelDisplayName(modelSlug: string | null | undefined): string {
  if (!modelSlug) return "Claude";
  // Direct match first
  if (CLAUDE_MODEL_DISPLAY_NAMES[modelSlug]) return CLAUDE_MODEL_DISPLAY_NAMES[modelSlug];
  // Strip context-tier suffix (e.g. "[1m]", "[400k]") and try base match
  const base = modelSlug.replace(/\[.*\]$/, "");
  if (CLAUDE_MODEL_DISPLAY_NAMES[base]) return CLAUDE_MODEL_DISPLAY_NAMES[base];
  // Strip date suffix (e.g. "claude-opus-4-6-20260301" → "claude-opus-4-6")
  const noDate = base.replace(/-\d{8}$/, "");
  if (noDate !== base && CLAUDE_MODEL_DISPLAY_NAMES[noDate]) return CLAUDE_MODEL_DISPLAY_NAMES[noDate];
  // Parse "claude-{family}-{major}-{minor}" pattern (e.g. "claude-opus-4-7" → "Claude Opus 4.7")
  const candidate = noDate !== base ? noDate : base;
  // Cline (and some catalogs) use dots: `claude-sonnet-4.6` → same as `claude-sonnet-4-6`.
  const normalized = candidate.replace(/(\d+)\.(\d+)$/, "$1-$2");
  if (normalized !== candidate && CLAUDE_MODEL_DISPLAY_NAMES[normalized]) {
    return CLAUDE_MODEL_DISPLAY_NAMES[normalized];
  }
  const twoPartMatch = normalized.match(/^claude-(\w+)-(\d+)-(\d+)$/);
  if (twoPartMatch) {
    const family = twoPartMatch[1].charAt(0).toUpperCase() + twoPartMatch[1].slice(1);
    return `Claude ${family} ${twoPartMatch[2]}.${twoPartMatch[3]}`;
  }
  // Parse "claude-{family}-{version}" pattern (e.g. "claude-sonnet-5" → "Claude Sonnet 5")
  const onePartMatch = candidate.match(/^claude-(\w+)-(\d+)$/);
  if (onePartMatch) {
    const family = onePartMatch[1].charAt(0).toUpperCase() + onePartMatch[1].slice(1);
    return `Claude ${family} ${onePartMatch[2]}`;
  }
  // Fallback: capitalize slug after "Claude "
  const label = base.startsWith("claude-") ? base.slice("claude-".length) : base;
  return `Claude ${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

/** Map a Pi coding-agent model slug to a compact sidebar / top-bar label.
 *  Pi can run any configured backend (xAI, Anthropic, Google, OpenAI, …),
 *  so slugs look like `grok-4.6`, `gemini-2.5-flash`, or `anthropic/claude-sonnet-4-5`. */
export function prettifyPiModel(slug: string | null | undefined): string | null {
  if (!slug) return null;
  const trimmed = slug.trim();
  if (!trimmed) return null;
  const bare = trimmed.includes("/") ? (trimmed.split("/").pop() ?? trimmed) : trimmed;
  const lower = bare.toLowerCase();

  if (lower.startsWith("grok") || lower.startsWith("composer-")) {
    return prettifyGrokModel(bare);
  }
  if (
    lower.startsWith("claude-") ||
    lower === "sonnet" ||
    lower === "haiku" ||
    lower === "opus" ||
    lower.startsWith("opus[")
  ) {
    return getClaudeModelDisplayName(bare);
  }
  if (lower.startsWith("kimi") || lower === "k3") {
    return prettifyKimiModel(bare);
  }
  if (lower.startsWith("gpt-")) {
    return prettifyCodexModelName(bare);
  }
  if (lower.startsWith("gemini") || lower.startsWith("gemma")) {
    return prettifyGeminiModel(bare);
  }
  const pretty = prettifyOpenCodeSlug(bare);
  return pretty || bare;
}

/** Cline CLI slugs are `provider/model` or bare (`gpt-5.6-luna`, `anthropic/claude-sonnet-4.6`). */
export function prettifyClineModel(slug: string | null | undefined): string | null {
  return prettifyPiModel(slug);
}

const GEMINI_EFFORT = new Set(["low", "medium", "high", "fast"]);
const GEMINI_EFFORT_SUFFIX = /\s+\((Low|Medium|High|Fast)\)$/i;
const GEMINI_SLUG_EFFORT = /-(low|medium|high)$/i;

export function geminiEffortFromSlug(
  slug: string | null | undefined,
): "low" | "medium" | "high" | null {
  if (!slug) return null;
  const bare = slug.includes("/") ? (slug.split("/").pop() ?? slug) : slug;
  const m = bare.toLowerCase().match(GEMINI_SLUG_EFFORT);
  return m ? (m[1] as "low" | "medium" | "high") : null;
}

export function applyGeminiEffort(slug: string, effort: string): string {
  const base = slug.replace(GEMINI_SLUG_EFFORT, "");
  if (effort === "low" || effort === "medium" || effort === "high") {
    return `${base}-${effort}`;
  }
  return base;
}

function stripGeminiEffortSuffix(name: string): string {
  return name.replace(GEMINI_EFFORT_SUFFIX, "").trim();
}

/** Antigravity / Gemini CLI slugs (`gemini-3.6-flash-medium`) and display
 *  names (`Gemini 3.7 Flash (High)`). Trailing effort tokens become `(High)`
 *  unless `includeEffort` is false (sidebar labels). */
export function prettifyGeminiModel(
  slug: string | null | undefined,
  opts?: { includeEffort?: boolean },
): string | null {
  if (!slug) return null;
  const trimmed = slug.trim();
  if (!trimmed) return null;
  const includeEffort = opts?.includeEffort ?? true;
  const bare = trimmed.includes("/") ? (trimmed.split("/").pop() ?? trimmed) : trimmed;
  const lower = bare.toLowerCase();
  if (!(lower.startsWith("gemini") || lower.startsWith("gemma"))) {
    return bare;
  }
  if (/\s/.test(bare) && !/[-_]/.test(bare)) {
    return includeEffort ? bare : stripGeminiEffortSuffix(bare);
  }
  const parts = bare.split(/[-_]/).filter(Boolean);
  let effort: string | null = null;
  const last = parts[parts.length - 1]?.toLowerCase();
  if (last && GEMINI_EFFORT.has(last) && parts.length > 1) {
    effort = last.charAt(0).toUpperCase() + last.slice(1);
    parts.pop();
  }
  const title = parts
    .map((p) => (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ");
  return includeEffort && effort ? `${title} (${effort})` : title;
}

export const CLAUDE_THINKING_BUDGETS: { value: ClaudeThinkingBudget; label: string; tokens: string }[] = [
  { value: "high", label: "High", tokens: "32k" },
  { value: "medium", label: "Medium", tokens: "16k" },
  { value: "low", label: "Low", tokens: "4k" },
];

/** A Codex session from the CLI's session_index.jsonl */
export interface CodexSession {
  id: string;
  thread_name: string;
  updated_at: string;
}

/** A Claude Code session discovered from ~/.claude/projects/ */
export interface ClaudeSession {
  id: string;
  preview: string;
  updated_at: string;
  cwd: string;
  /** Model ID used in the most recent assistant turn (extracted from the Claude JSONL). */
  model: string | null;
  lines_added: number;
  lines_removed: number;
  files_changed: number;
}

/** A Kimi Code session discovered from ~/.kimi-code/sessions/ */
export interface KimiSession {
  id: string;
  preview: string;
  updated_at: string;
  cwd: string;
  /** Model alias from wire.jsonl / config.toml, when known. */
  model?: string | null;
}

/** A Pi coding-agent session discovered from ~/.pi/agent/sessions/ */
export interface PiSession {
  id: string;
  preview: string;
  updated_at: string;
  cwd: string;
  model?: string | null;
  lines_added: number;
  lines_removed: number;
  files_changed: number;
}

/** A Grok Build session discovered from ~/.grok/sessions/<urlencoded-cwd>/<uuid>/.
 *  `model` comes from `summary.json#current_model_id` and may be null for very
 *  fresh sessions that haven't completed a turn. */
export interface GrokSession {
  id: string;
  preview: string;
  updated_at: string;
  cwd: string;
  model: string | null;
  lines_added: number;
  lines_removed: number;
  files_changed: number;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

export interface PtyOutputEvent {
  thread_id: string;
  data: string; // base64 encoded
  /**
   * Cumulative byte offset of the FIRST byte in this event's `data`
   * (after base64 decoding). Equals `end_offset - decoded.length`.
   */
  start_offset: number;
  /**
   * Cumulative byte offset of the byte that would come right after this
   * event's data in the PTY stream. Used together with the snapshot's
   * `end_offset` watermark to dedupe overlapping live events after a
   * snapshot rehydration.
   */
  end_offset: number;
}

/** Snapshot of a session's PTY output ring buffer at a specific stream position. */
export interface PtySnapshot {
  /** Base64-encoded raw bytes of the most recent ring-buffer contents. */
  data: string;
  /**
   * Cumulative byte offset of the byte that would be written next —
   * equivalently, the absolute position right after the most recent byte
   * in `data`. Frontend uses this as a watermark to drop live PTY events
   * whose `end_offset <= snapshot.end_offset`.
   */
  end_offset: number;
}

export interface PtyExitEvent {
  thread_id: string;
  exit_code: number | null;
}

export interface FileChangeEvent {
  thread_id: string;
  paths: string[];
  kind: string;
}

// ── Phase 2 Types ────────────────────────────────────────

export type JournalKind = "Decision" | "Convention" | "CompletedWork" | "KnownIssue" | "Note" | "Pin";

/** One user→agent cycle in the session timeline ledger (camelCase from Rust). */
export interface ThreadTurn {
  id: string;
  threadId: string;
  seq: number;
  promptText: string;
  /** Short title of the user ask (local LLM or extractive); preferred over promptText in the timeline. */
  promptSummary?: string | null;
  status: "running" | "done" | "failed" | "cancelled" | string;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  summarySource: "none" | "extractive" | "llm" | string;
  anchorKind: "chat_item" | "pty_marker" | string;
  anchorRef: string;
  factsJson: string;
  createdAt: string;
}

export interface ThreadJournalEntry {
  id: string;
  thread_id: string;
  kind: JournalKind;
  title: string;
  content: string;
  source: "User" | "AgentParsed" | "System";
  confidence: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  is_archived: number;
}

export interface PromptLog {
  id: string;
  thread_id: string;
  raw_prompt: string;
  optimized_prompt: string | null;
  user_approved_optimization: number;
  context_fetched: number;
  context_score: number | null;
  context_reason: string | null;
  context_mode: string | null;
  final_prompt_sent: string;
  timestamp: string;
}

export interface ThreadSearchResult {
  thread_id: string;
  project_id: string;
  thread_name: string;
  provider: string;
  work_dir: string;
  matched_content: string | null;
  relevance: number;
  last_active: string;
  /** "user" | "assistant" | "name" | "meta" — from FTS message index */
  match_role?: string | null;
  /** "name" | "turn" | "claude" | "codex" | "grok" | "prompt" | "journal" | "agent_log" */
  match_source?: string | null;
}

export interface OptimizedResult {
  original: string;
  optimized: string;
}

export interface JournalProposal {
  kind: string;
  title: string;
  content: string;
  confidence: number;
}

export interface ChatBlock {
  id: string;
  type: "user" | "response";
  content: string;
  rawContent: string;
  timestamp: number;
}

// ── Claude Code Chat View Types ─────────────────────────

export interface ClaudeChatItemUserMessage {
  itemType: "UserMessage";
  content: string;
  timestamp: string;
  uuid: string;
  /** Base64 image data URLs attached to this message (SDK mode) */
  imageDataUrls?: string[];
}

export interface ClaudeChatItemAssistantText {
  itemType: "AssistantText";
  text: string;
  model?: string | null;
  timestamp: string;
  uuid: string;
}

export interface ClaudeChatItemAssistantThinking {
  itemType: "AssistantThinking";
  thinking: string;
  model?: string | null;
  timestamp: string;
  uuid: string;
}

export interface ClaudeChatItemToolUse {
  itemType: "ToolUse";
  id: string;
  parentToolUseId?: string | null;
  name: string;
  input: Record<string, unknown>;
  model?: string | null;
  timestamp: string;
  uuid: string;
  /** Populated when tool.completed arrives — inlined so Virtuoso sees the data change. */
  result?: { content: string; isError: boolean };
  childTools?: Array<{
    name: string;
    toolId: string;
    input: Record<string, unknown>;
    result?: { content: string; isError: boolean };
    pending: boolean;
  }>;
}

export interface ClaudeChatItemToolResult {
  itemType: "ToolResult";
  tool_use_id: string;
  content: string;
  is_error: boolean;
  timestamp: string;
  uuid: string;
}

export interface ClaudeChatItemSystemMessage {
  itemType: "SystemMessage";
  text: string;
  timestamp: string;
  uuid: string;
}

export interface ClaudeChatItemResultInfo {
  itemType: "ResultInfo";
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_cost_usd: number;
  num_turns: number;
  session_id: string;
  timestamp: string;
  uuid: string;
  /** Pre-computed file change summary for this turn (populated during message grouping) */
  turnChanges?: TurnFileChange[];
  /** User message UUID for file checkpoint rewind (set when file checkpointing is active) */
  userMessageId?: string | null;
}

/** Summary of a file change within a turn */
export interface TurnFileChange {
  filePath: string;
  shortPath: string;
  action: "edited" | "created" | "read";
  additions: number;
  deletions: number;
}

export interface ClaudeChatItemToolGroup {
  itemType: "ToolGroup";
  tools: ClaudeChatItemToolUse[];
  timestamp: string;
  uuid: string;
}

export interface ClaudeChatItemFilesChanged {
  itemType: "FilesChanged";
  files: Array<{ filename: string; fileId: string }>;
  failed: Array<{ filename: string; error: string }>;
  userMessageId: string | null;
  timestamp: string;
  uuid: string;
}

export interface ClaudeChatItemCompactBoundary {
  itemType: "CompactBoundary";
  preTokens: number | null;
  trigger: string | null;
  timestamp: string;
  uuid: string;
}

export type ClaudeChatItem =
  | ClaudeChatItemUserMessage
  | ClaudeChatItemAssistantText
  | ClaudeChatItemAssistantThinking
  | ClaudeChatItemToolUse
  | ClaudeChatItemToolResult
  | ClaudeChatItemSystemMessage
  | ClaudeChatItemResultInfo
  | ClaudeChatItemToolGroup
  | ClaudeChatItemFilesChanged
  | ClaudeChatItemCompactBoundary;

// -- Task View / Worktree Mode --

export type TaskStatus = "in_progress" | "done" | "blocked";

export interface LinkedIssue {
  slug: string;
  title: string;
  source: "github" | "linear";
  url: string;
}

export interface Task {
  id: string;
  project_id: string;
  name: string;
  branch_name: string;
  worktree_path: string;
  base_branch: string;
  status: TaskStatus;
  prompt: string | null;
  linked_pr_number: number | null;
  linked_pr_url: string | null;
  linked_issues: string | null; // JSON string of LinkedIssue[]
  created_at: string;
  /**
   * 1 when the task spans multiple repos checked out as siblings under the
   * worktree's parent dir. Agents are pinned to that parent instead of the
   * single repo worktree so they can see all sibling repos. Optional only so
   * pre-migration test fixtures keep compiling — the DB column is NOT NULL.
   */
  multi_repo?: number;
}

export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
  status: string;
}

export interface WorktreeGitState {
  ahead: number;
  behind: number;
  dirty_files: string[];
  changed_files: ChangedFile[];
  /** False when no upstream ref exists to compare against (fresh repo, no
   *  origin, or unrelated histories). Distinguish this from "truly 0/0". */
  has_upstream: boolean;
}

export interface AheadBehind {
  ahead: number;
  behind: number;
  has_upstream: boolean;
}

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface NewTaskDraft {
  projectId: string;
  name: string;
  branchName: string;
  baseBranch: string;
  prompt: string;
  provider: Provider | null;
  linkedPrNumber: number | null;
  linkedPrUrl: string | null;
  linkedIssues: LinkedIssue[];
}

// ── Multi-agent rooms ─────────────────────────────────────

/** Shared board grouping existing threads (A2A later). camelCase from Rust serde. */
export interface AgentRoom {
  id: string;
  projectId: string;
  name: string;
  /** SQLite bool: 0/1 */
  a2aEnabled: number;
  maxA2aRounds: number;
  createdAt: string;
  lastActive: string;
}

export interface AgentRoomMember {
  roomId: string;
  threadId: string;
  label: string | null;
  sortOrder: number;
}

export type AgentRoomEventKind =
  | "human"
  | "agent"
  | "system"
  | "a2a"
  | string;

export interface AgentRoomEvent {
  id: string;
  roomId: string;
  kind: AgentRoomEventKind;
  fromThreadId: string | null;
  toThreadId: string | null;
  body: string;
  metaJson: string | null;
  createdAt: string;
}

export interface AgentRoomDetail {
  room: AgentRoom;
  members: AgentRoomMember[];
}

/** Per-target outcome from `send_agent_room_message`. */
export interface RoomMessageDelivery {
  threadId: string;
  ok: boolean;
  error?: string | null;
}

export interface SendAgentRoomMessageResult {
  event: AgentRoomEvent;
  deliveries: RoomMessageDelivery[];
}
