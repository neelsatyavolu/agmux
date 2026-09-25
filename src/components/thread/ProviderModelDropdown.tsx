import { teamChoiceAllowed, teamPolicyChoice } from "../../lib/teamsRestrictions";
import { useState, useEffect, useRef, useMemo } from "react";
import { useSettingsStore } from "../../stores/settingsStore";
import { ChevronDown, ChevronRight, Check, Search, Radio } from "lucide-react";
import { AnimatePresence } from "framer-motion";
import {
  CURSOR_MODELS,
  GROK_MODELS,
  getClaudeModelDisplayName,
  mergeClaudeModelOptions,
  mergeCodexModelOptions,
  prettifyCodexModelName,
  prettifyCursorModel,
  prettifyGrokModel,
  prettifyGeminiModel,
  prettifyOpenCodeSlug,
  prettifyPiModel,
} from "../../lib/types";
import type { Provider, DraftProvider, CodexModelOption, ClaudePickerModel } from "../../lib/types";
import { listClaudeModels } from "../../lib/commands";
import type { CursorModel } from "../../lib/cursorSdkCommands";
import { fuzzyScore } from "../../lib/fuzzyMatch";
import { prettifyMlxModelName, formatLocalModelLabel, isLocalModelSlug, mlxEjectModel, mlxCapability } from "../../lib/mlx";
import claudeIcon from "../../assets/claude-ai-icon.svg";
import chatgptIcon from "../../assets/chatgpt-icon.svg";
import droidIcon from "../../assets/droid-icon.svg";
import kimiIcon from "../../assets/kimi-icon.svg";
import piIcon from "../../assets/pi-icon.svg";
import opencodeIcon from "../../assets/opencode-icon.png";
import appleIcon from "../../assets/apple-icon.svg";
import grokIcon from "../../assets/grok-icon.svg";
import cursorIcon from "../../assets/cursor-app-icon.png";
import clineIcon from "../../assets/cline-icon.svg";
import geminiIcon from "../../assets/gemini-icon.svg";
import hermesIcon from "../../assets/hermes-icon.png";
import {
  DropdownPopover,
  DropdownHeader,
  DropdownSectionHeader,
  DropdownRow,
  DropdownTag,
} from "../ui/ComposerDropdown";

/** Cap OpenCode rows so a multi-thousand catalog never freezes the main thread. */
const OPENCODE_RENDER_CAP = 60;

/** Live agent sessions that can be selected as a message target (orchestrator). */
export interface RunningSessionOption {
  id: string;
  title: string;
  projectName: string;
  provider: Provider;
  /** Optional status chip: running | waiting | unread | idle */
  state?: string;
}

interface Props {
  provider: DraftProvider;
  model: string | null;
  onSelect: (provider: DraftProvider, model: string | null) => void;
  /** When true, only show Claude models (no provider switching). */
  claudeOnly?: boolean;
  /**
   * Restrict which providers appear in the multi-provider cascade.
   * When set, only these providers are listed (and MLX/Cursor/Kimi stay hidden
   * unless included). Used by Issues dispatch (Claude/Codex/OpenCode/Grok).
   */
  allowedProviders?: readonly Provider[];
  allowedModels?: readonly string[] | null;
  /** Match the actual model sent by composers that encode effort in the slug. */
  resolvePolicyModel?: (provider: DraftProvider, model: string | null) => string | null;
  /** When true, only show OpenCode models (no provider switching). Renders a
   *  flat panel with search — mirrors the OpenCode flyout used in multi-provider
   *  mode but without Claude/Codex sections. */
  opencodeOnly?: boolean;
  /** Dynamic Claude models from the installed CLI catalog. */
  claudeModels?: { slug: string; name?: string }[];
  /** Dynamic Codex models from model/list — live catalog, curated fallback. */
  codexModels?: CodexModelOption[];
  /** Dynamic OpenCode models fetched from the bridge (overrides static curated list). */
  opencodeModels?: { slug: string; name: string; connected?: boolean; variants?: string[] }[];
  /** Dynamic Cursor models fetched from the SDK (overrides static curated list). */
  cursorModels?: CursorModel[];
  /** Recently-used OpenCode model slugs, most-recent-first. Used to bubble the
   *  user's favorites to the top of the submenu. */
  opencodeRecents?: string[];
  /** Compact mode — icon only, no label. */
  compact?: boolean;
  /** Show provider sections as collapsible rows with chevron arrows — cleaner for many models. */
  collapsibleSections?: boolean;
  /** MLX models discovered locally (LM Studio, HuggingFace, agmux-managed). */
  mlxModels?: import("../../lib/mlx").MlxModel[];
  /** When true, only show MLX (Local) models. */
  mlxOnly?: boolean;
  /**
   * Optional live sessions listed at the top of the picker (orchestrator).
   * Selecting one calls `onSelectSession` instead of `onSelect`.
   */
  runningSessions?: RunningSessionOption[];
  /** Recently-used providers, most-recent-first. Defaults to settings.recentProviders. */
  recentProviders?: Provider[];
  /** Currently targeted running session id (mutually exclusive with model launch). */
  selectedSessionId?: string | null;
  /** Called when the user picks a running session from the picker. */
  onSelectSession?: (sessionId: string) => void;
}

const PROVIDER_ICON_SRC: Record<Provider, string | null> = {
  ClaudeCode: claudeIcon,
  Codex: chatgptIcon,
  Droid: droidIcon,
  Kimi: kimiIcon,
  Pi: piIcon,
  OpenCode: opencodeIcon,
  MLX: appleIcon,
  Grok: grokIcon,
  Cursor: cursorIcon,
  Cline: clineIcon,
  Gemini: geminiIcon,
  Hermes: hermesIcon,
};

function ProviderIcon({ provider, size = 16 }: { provider: Provider; size?: number }) {
  const src = PROVIDER_ICON_SRC[provider];
  if (!src) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-sm bg-zinc-800 font-mono font-bold text-zinc-200"
        style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.55)) }}
      >
        C
      </span>
    );
  }
  // MLX runs locally on Apple Silicon, so we use the Apple logo PNG instead
  // of the Claude logo. Keeps the visual language honest about who's serving
  // the inference.
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-sm"
    />
  );
}

/** Rich avatar tile used inside dropdown rows. */
function ProviderAvatar({ provider }: { provider: Provider }) {
  return (
    <span className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] bg-white/[0.04] border border-white/[0.06]">
      <ProviderIcon provider={provider} size={16} />
    </span>
  );
}



/** Default OpenCode models shown in the dropdown. OpenCode accepts any
 *  `providerID/modelID` slug the user has authed with. This is a curated
 *  starter set — to add more, log in to the provider via Settings → OpenCode. */
const OPENCODE_SUBMENU_MODELS: { slug: string; label: string; meta: string }[] = [
  { slug: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", meta: "balanced · default" },
  { slug: "anthropic/claude-opus-4-5", label: "Claude Opus 4.5", meta: "most capable" },
  { slug: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5", meta: "fast · cheap" },
  { slug: "openai/gpt-6-sol", label: "GPT 6 Sol", meta: "OpenAI flagship" },
  { slug: "openai/gpt-6-luna", label: "GPT 6 Luna", meta: "OpenAI fast · cheap" },
  { slug: "openai/gpt-5.6-sol", label: "GPT 5.6 Sol", meta: "OpenAI flagship" },
  { slug: "openai/gpt-5.6-terra", label: "GPT 5.6 Terra", meta: "OpenAI balanced" },
  { slug: "openai/gpt-5.6-luna", label: "GPT 5.6 Luna", meta: "OpenAI fast · cheap" },
  { slug: "openai/gpt-5.4", label: "GPT 5.4", meta: "OpenAI previous" },
  { slug: "openai/gpt-5.4-mini", label: "GPT 5.4 mini", meta: "OpenAI fast" },
  { slug: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", meta: "Google" },
];

/** Default Grok models shown in the dropdown — mirrors GROK_MODELS but with
 *  the richer metadata the submenu layout expects. Live default comes from
 *  `grok models` at runtime; this is a curated fallback. `grok-4.3` is retired
 *  and intentionally omitted (historical sessions still prettify via
 *  prettifyGrokModel). */
const GROK_SUBMENU_MODELS: { slug: string; label: string; meta: string }[] = [
  { slug: "grok-4.7", label: "Grok 4.7", meta: "500K · frontier · default" },
  { slug: "grok-4.6", label: "Grok 4.6", meta: "500K · previous" },
  { slug: "grok-4.5", label: "Grok 4.5", meta: "500K · earlier" },
];

const GEMINI_SUBMENU_MODELS: { slug: string; label: string; meta: string }[] = [
  { slug: "gemini-3.8-flash", label: "Gemini 3.8 Flash", meta: "default" },
  { slug: "gemini-3.1-pro", label: "Gemini 3.1 Pro", meta: "Pro" },
];

function geminiBaseSlug(slug: string): string {
  return slug.replace(/-(low|medium|high)$/i, "");
}

function displayLabel(
  provider: DraftProvider,
  model: string | null,
  codexModels?: CodexModelOption[],
  cursorModels?: CursorModel[],
): string {
  const providerLabel: Record<Provider, string> = {
    ClaudeCode: "Claude",
    Codex: "Codex",
    Droid: "Droid",
    Kimi: "Kimi",
    Pi: "Pi",
    OpenCode: "OpenCode",
    MLX: "MLX",
    Grok: "Grok",
    Cursor: "Cursor",
    Cline: "Cline",
    Gemini: "Gemini",
    Hermes: "Hermes",
  };
  if (!model) return providerLabel[provider] ?? provider;
  if (provider === "ClaudeCode") {
    return getClaudeModelDisplayName(model);
  }
  if (provider === "Codex") {
    const models = mergeCodexModelOptions(codexModels);
    const cm = models.find((m) => m.slug === model);
    if (cm) return cm.name;
    return prettifyCodexModelName(model);
  }
  // Local models first — OpenCode chat and Pi "local" terminal both use
  // `local/<org>/<repo>` slugs; never route those through cloud prettifiers.
  if (provider === "MLX" || isLocalModelSlug(model)) {
    return formatLocalModelLabel(model) ?? model;
  }
  if (provider === "OpenCode") {
    const cm = OPENCODE_SUBMENU_MODELS.find((m) => m.slug === model);
    if (cm) return cm.label;
    // Prettify arbitrary opencode-go/openai/openrouter/etc. slugs
    return prettifyOpenCodeSlug(model) || model;
  }
  if (provider === "Grok") {
    const cm = GROK_SUBMENU_MODELS.find((m) => m.slug === model) ??
      GROK_MODELS.find((m) => m.slug === model);
    if (cm) return "label" in cm ? cm.label : cm.name;
    return prettifyGrokModel(model) ?? `Grok ${model}`;
  }
  if (provider === "Cursor") {
    const models = cursorModels && cursorModels.length > 0 ? cursorModels : CURSOR_MODELS;
    const selectedBase = model?.split("?")[0];
    const cm = models.find((m) => m.slug === model || m.slug.split("?")[0] === selectedBase);
    if (cm) return cm.name.replace(/\b(\d+(?:\.\d+)*) (\d+)\b/g, "$1.$2");
    return prettifyCursorModel(model) ?? model;
  }
  if (provider === "Pi" || provider === "Hermes") {
    return prettifyPiModel(model) ?? model;
  }
  if (provider === "Gemini") {
    return prettifyGeminiModel(model, { includeEffort: false }) ?? model;
  }
  return `${providerLabel[provider]} ${model}`;
}

/** Threshold above which a provider's flyout shows a search input at the top. */
const SEARCH_THRESHOLD = 7;


interface SubmenuShellProps {
  children: React.ReactNode;
  search?: string;
  onSearch?: (v: string) => void;
  width?: number;
  maxHeight?: number;
  showSearch?: boolean;
  emptyHint?: string;
}

function SubmenuShell({
  children,
  search,
  onSearch,
  width = 320,
  // Keep flyouts compact so the cascade stays anchored near the composer
  // instead of climbing the full viewport (draft chat sits at the bottom).
  maxHeight = 320,
  showSearch,
  emptyHint,
}: SubmenuShellProps) {
  const headerHeight = showSearch ? 48 : 0;
  return (
    <div style={{ width, maxHeight, display: "flex", flexDirection: "column" }}>
      {showSearch && onSearch && (
        <div className="sticky top-0 z-10 border-b border-white/[0.05] bg-zinc-900/95 backdrop-blur px-1 pt-1 pb-1.5">
          <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5 focus-within:border-white/[0.12] focus-within:bg-white/[0.05] transition-colors">
            <Search size={12} className="shrink-0 text-zinc-500" />
            <input
              autoFocus
              type="text"
              value={search ?? ""}
              onChange={(e) => onSearch(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="Search models…"
              className="flex-1 min-w-0 bg-transparent text-[12.5px] tracking-[-0.01em] text-zinc-200 placeholder-zinc-600 outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => onSearch("")}
                className="font-mono text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
                title="Clear search"
              >
                esc
              </button>
            )}
          </div>
        </div>
      )}
      <div style={{ overflowY: "auto", maxHeight: maxHeight - headerHeight }}>
        {children}
        {emptyHint && (
          <div className="px-3 py-4 text-center text-[11.5px] text-zinc-500">{emptyHint}</div>
        )}
      </div>
    </div>
  );
}

interface HoverProviderRowProps {
  providerKey: Provider;
  label: string;
  count: number;
  isActive: boolean;
  isHovered: boolean;
  activeLabel: string | null;
  onMouseEnter: () => void;
  onMouseLeave?: () => void;
}

/**
 * Provider summary row used in the hover-flyout layout. Hovering reveals a
 * submenu panel to the right listing that provider's models. Style mirrors
 * DropdownRow so the overall look of the popover stays consistent.
 */
function HoverProviderRow({
  providerKey,
  label,
  count,
  isActive,
  isHovered,
  activeLabel,
  onMouseEnter,
  onMouseLeave,
}: HoverProviderRowProps) {
  const rowBg = isHovered
    ? "bg-white/[0.06]"
    : isActive
    ? "bg-[var(--accent)]/[0.06]"
    : "hover:bg-white/[0.04]";
  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={`flex w-full items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors cursor-default ${rowBg}`}
    >
      <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center">
        <ProviderAvatar provider={providerKey} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13.5px] font-medium tracking-[-0.015em] leading-tight truncate text-zinc-200">
          {label}
        </span>
        <span className="mt-0.5 block font-mono text-[10.5px] text-zinc-500 truncate">
          {activeLabel ? activeLabel : `${count} model${count === 1 ? "" : "s"}`}
        </span>
      </span>
      <ChevronRight size={14} className="shrink-0 text-zinc-500" />
    </div>
  );
}

function claudeMatches(model: string | null, slug: string) {
  if (!model) return false;
  const base = (s: string) => s.replace(/\[.*\]$/, "");
  return model === slug || base(model) === base(slug);
}

function cursorMatches(model: string | null, slug: string) {
  if (!model) return false;
  const base = (s: string) => s.split("?")[0];
  return model === slug || base(model) === base(slug);
}

function cursorModelMeta(model: CursorModel | (typeof CURSOR_MODELS)[number]): string | undefined {
  if ("meta" in model) return model.meta;
  return model.description;
}

function groupMlxBySource(models: import("../../lib/mlx").MlxModel[]) {
  const order = ["lmStudio", "huggingFace", "xanomManaged"] as const;
  const labelOf = (s: typeof order[number]) =>
    s === "lmStudio" ? "LM Studio" : s === "huggingFace" ? "HuggingFace" : "agmux-managed";
  return order
    .map((s) => ({ label: labelOf(s), items: models.filter((m) => m.source === s) }))
    .filter((g) => g.items.length > 0);
}

type HoverTarget = Provider | "running";

/** Providers that have a cascade flyout in the multi-provider picker. */
const FLYOUT_PROVIDERS: ReadonlySet<DraftProvider> = new Set([
  "ClaudeCode",
  "Codex",
  "OpenCode",
  "Grok",
  "Gemini",
  "Cursor",
  "MLX",
]);

/** Canonical cascade order when a provider has never been used. */
export const CASCADE_PROVIDER_ORDER: readonly Provider[] = [
  "ClaudeCode",
  "Codex",
  "OpenCode",
  "Gemini",
  "Grok",
  "Cursor",
  "MLX",
];

const EMPTY_RECENT_PROVIDERS: Provider[] = [];

/** Visible provider rows in the cascade list (~4, with a peek of the next). */
const CASCADE_LIST_MAX_HEIGHT = 200;

export function sortProvidersByRecency(
  providers: readonly Provider[],
  recents: readonly string[] | undefined,
): Provider[] {
  const idx = new Map<string, number>();
  (recents ?? []).forEach((p, i) => {
    if (!idx.has(p)) idx.set(p, i);
  });
  return [...providers].sort((a, b) => {
    const ai = idx.get(a);
    const bi = idx.get(b);
    if (ai !== undefined || bi !== undefined) {
      if (ai === undefined) return 1;
      if (bi === undefined) return -1;
      return ai - bi;
    }
    const ao = CASCADE_PROVIDER_ORDER.indexOf(a);
    const bo = CASCADE_PROVIDER_ORDER.indexOf(b);
    return (ao === -1 ? 99 : ao) - (bo === -1 ? 99 : bo);
  });
}

export function recentsWithCurrent(
  current: Provider,
  stored: readonly Provider[] | undefined,
): Provider[] {
  return [current, ...(stored ?? []).filter((p) => p !== current)];
}

function initialHoverTarget(
  provider: DraftProvider,
  selectedSession: boolean,
): HoverTarget {
  if (selectedSession) return "running";
  if (FLYOUT_PROVIDERS.has(provider)) return provider as HoverTarget;
  return "ClaudeCode";
}

export function ProviderModelDropdown({
  provider,
  model,
  onSelect,
  claudeOnly,
  allowedProviders,
  allowedModels,
  resolvePolicyModel,
  opencodeOnly,
  claudeModels,
  codexModels,
  opencodeModels,
  cursorModels,
  opencodeRecents,
  compact,
  collapsibleSections,
  mlxModels,
  mlxOnly,
  runningSessions,
  selectedSessionId,
  onSelectSession,
  recentProviders: recentProvidersProp,
}: Props) {
  const sessions = runningSessions ?? [];
  const hasSessions = sessions.length > 0 && !!onSelectSession;
  const storedRecents = useSettingsStore((s) => s.settings.recentProviders ?? EMPTY_RECENT_PROVIDERS);
  const recents = recentProvidersProp ?? storedRecents;
  const selectedSession =
    selectedSessionId && hasSessions
      ? sessions.find((s) => s.id === selectedSessionId) ?? null
      : null;
  const allow = (p: Provider) =>
    !allowedProviders || allowedProviders.includes(p);
  const blockedReason = (p: DraftProvider, m: string | null) => {
    const choice = teamPolicyChoice(p, resolvePolicyModel ? resolvePolicyModel(p, m) : m);
    return !allow(choice.provider as Provider) ? "Agent blocked by team restrictions"
      : !teamChoiceAllowed(allowedModels === undefined ? null : allowedModels, choice.model) ? "Model blocked by team restrictions" : undefined;
  };
  const lockedProvider =
    allowedProviders && allowedProviders.length === 1 ? allowedProviders[0] : null;

  // Use dynamic OpenCode models from the bridge when available, fall back to
  // the curated starter set when nothing is fetched (e.g. before bridge init).
  // Memoized — OpenCode catalogs can be thousands of models; re-sorting on
  // every parent re-render freezes the cascade picker on hover.
  const opencode = useMemo(() => {
    const raw = (opencodeModels && opencodeModels.length > 0)
      ? opencodeModels.map((m) => ({
          slug: m.slug,
          label: m.name,
          meta: m.connected === false ? `${m.slug} · needs auth` : m.slug,
          disconnected: m.connected === false,
        }))
      : OPENCODE_SUBMENU_MODELS.map((m) => ({ ...m, disconnected: false }));
    const recentIdx = new Map<string, number>();
    (opencodeRecents ?? []).forEach((slug, i) => recentIdx.set(slug, i));
    // Sort: recents (newest-first) → connected → disconnected, alphabetical within each bucket.
    return [...raw].sort((a, b) => {
      const aRecent = recentIdx.get(a.slug);
      const bRecent = recentIdx.get(b.slug);
      if (aRecent !== undefined || bRecent !== undefined) {
        if (aRecent === undefined) return 1;
        if (bRecent === undefined) return -1;
        return aRecent - bRecent;
      }
      if (a.disconnected !== b.disconnected) return a.disconnected ? 1 : -1;
      return a.label.localeCompare(b.label);
    });
  }, [opencodeModels, opencodeRecents]);
  // Prefer connected count for the provider-row subtitle so a full OpenCode
  // catalog (thousands of un-authed models) doesn't read as "5523 models".
  const opencodeConnectedCount = useMemo(
    () => opencode.filter((m) => !m.disconnected).length,
    [opencode],
  );
  const opencodeRowCount =
    opencodeConnectedCount > 0 && opencodeConnectedCount < opencode.length
      ? opencodeConnectedCount
      : opencode.length;
  const [open, setOpen] = useState(false);
  const [liveClaudeSlugs, setLiveClaudeSlugs] = useState<string[]>([]);
  useEffect(() => {
    if (claudeModels && claudeModels.length > 0) return;
    let cancelled = false;
    listClaudeModels()
      .then((slugs) => {
        if (!cancelled && Array.isArray(slugs) && slugs.length > 0) {
          setLiveClaudeSlugs(slugs);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [claudeModels, open]);
  const claude: ClaudePickerModel[] = useMemo(() => {
    const slugs =
      claudeModels && claudeModels.length > 0
        ? claudeModels.map((m) => m.slug)
        : liveClaudeSlugs;
    return mergeClaudeModelOptions(slugs);
  }, [claudeModels, liveClaudeSlugs]);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Feature gate: MLX chat provider is gated by default
  const [mlxChatEnabled, setMlxChatEnabled] = useState(false);
  // Hover-flyout state: when collapsibleSections is true, hovering a provider
  // row reveals that provider's models in the right-hand flyout card.
  // "running" is a virtual target used when the picker lists live sessions
  // (orchestrator only — draft chat has none).
  // Never clear to null while open — a null hover collapsed the flyout
  // mid-gesture and made every provider below Claude/Codex feel broken.
  const [hoveredProvider, setHoveredProvider] = useState<HoverTarget>(
    () => initialHoverTarget(provider, !!selectedSession),
  );
  // Per-flyout search query — shown when a provider has more than SEARCH_THRESHOLD
  // models so long lists stay browsable without scrolling.
  const [flyoutQuery, setFlyoutQuery] = useState("");

  // Fetch feature gate on mount. Gate on `supported` (Apple Silicon), NOT on
  // readiness: any missing setup step — python, the MLX runtime venv, or the
  // models themselves — must stay discoverable, and clicking the tile
  // deep-links to Settings → Local Models instead of starting a session.
  useEffect(() => {
    mlxCapability()
      .then((cap) => setMlxChatEnabled(cap.supported))
      .catch(() => setMlxChatEnabled(false));
  }, []);

  const handleProviderEnter = (p: HoverTarget) => {
    setHoveredProvider(p);
  };

  // Reset the flyout search query whenever the hovered provider changes or the
  // dropdown closes, so each provider's search starts fresh.
  useEffect(() => {
    setFlyoutQuery("");
  }, [hoveredProvider, open]);

  // Reset hovered provider to the current provider when the dropdown opens,
  // so the initial flyout shows the currently-selected provider's models.
  useEffect(() => {
    if (!open || !collapsibleSections) return;
    if (selectedSession && hasSessions) {
      setHoveredProvider("running");
      return;
    }
    setHoveredProvider(initialHoverTarget(provider, false));
  }, [open, provider, collapsibleSections, selectedSession, hasSessions]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const choose = (p: DraftProvider, m: string | null) => {
    if (blockedReason(p, m)) return;
    const prev = useSettingsStore.getState().settings.recentProviders ?? [];
    useSettingsStore.getState().updateSettings({
      recentProviders: recentsWithCurrent(p, prev),
    });
    onSelect(p, m);
    setOpen(false);
  };

  const chooseSession = (sessionId: string) => {
    onSelectSession?.(sessionId);
    setOpen(false);
  };

  const codex = mergeCodexModelOptions(codexModels);
  const cursor = cursorModels && cursorModels.length > 0 ? cursorModels : CURSOR_MODELS;
  const cascadeProviders = useMemo(() => {
    const isActive = (p: Provider) => !selectedSession && provider === p;
    const defs: {
      key: Provider;
      label: string;
      visible: boolean;
      count: number;
      activeLabel: string | null;
    }[] = [
      {
        key: "ClaudeCode",
        label: "Anthropic",
        visible: allow("ClaudeCode"),
        count: claude.length,
        activeLabel: isActive("ClaudeCode")
          ? claude.find((m) => claudeMatches(model, m.slug))?.name ?? null
          : null,
      },
      {
        key: "Codex",
        label: "OpenAI · Codex",
        visible: allow("Codex") && codex.length > 0,
        count: codex.length,
        activeLabel: isActive("Codex")
          ? codex.find((m) => m.slug === model)?.name ?? null
          : null,
      },
      {
        key: "OpenCode",
        label: "OpenCode",
        visible: allow("OpenCode") || (allow("MLX") && opencode.some((m) => teamPolicyChoice("OpenCode", m.slug).provider === "MLX")),
        count: opencodeRowCount,
        activeLabel: isActive("OpenCode")
          ? opencode.find((m) => m.slug === model)?.label
            ?? (model?.includes("/") ? model.split("/")[1] : model)
            ?? null
          : null,
      },
      {
        key: "Gemini",
        label: "Gemini",
        visible: allow("Gemini"),
        count: GEMINI_SUBMENU_MODELS.length,
        activeLabel: isActive("Gemini")
          ? prettifyGeminiModel(model, { includeEffort: false }) ?? model
          : null,
      },
      {
        key: "Grok",
        label: "xAI · Grok",
        visible: allow("Grok"),
        count: GROK_SUBMENU_MODELS.length,
        activeLabel: isActive("Grok")
          ? GROK_SUBMENU_MODELS.find((m) => m.slug === model)?.label ?? null
          : null,
      },
      {
        key: "Cursor",
        label: "Cursor",
        visible: allow("Cursor"),
        count: cursor.length,
        activeLabel: isActive("Cursor")
          ? cursor.find((m) => cursorMatches(model, m.slug))?.name
            ?? prettifyCursorModel(model)
            ?? null
          : null,
      },
      {
        key: "MLX",
        label: "Local Model",
        visible: allow("MLX") && mlxChatEnabled,
        count: mlxModels?.length ?? 0,
        activeLabel: isActive("MLX")
          ? (() => {
              const found = mlxModels?.find((m) => m.id === model)?.displayName;
              if (found) return prettifyMlxModelName(found);
              const tail = model?.includes("/") ? model.split("/").pop() : model;
              return tail ? prettifyMlxModelName(tail) : null;
            })()
          : null,
      },
    ];
    const visible = defs.filter((d) => d.visible);
    const order = sortProvidersByRecency(
      visible.map((d) => d.key),
      recentsWithCurrent(provider, recents),
    );
    const byKey = new Map(visible.map((d) => [d.key, d]));
    return order.map((k) => byKey.get(k)!);
  }, [
    allowedProviders,
    claude,
    codex,
    cursor,
    mlxChatEnabled,
    mlxModels,
    model,
    opencode,
    opencodeRowCount,
    provider,
    recents,
    selectedSession,
  ]);
  // Trigger icon: session provider, or selected provider (Composer 2.5 uses Cursor logo).
  const displayIconProvider: Provider = selectedSession
    ? selectedSession.provider
    : (provider as Provider);
  const triggerLabel = selectedSession
    ? selectedSession.title
    : displayLabel(provider, model, codexModels, cursorModels);
  const triggerTitle = selectedSession
    ? `${selectedSession.projectName} / ${selectedSession.title}`
    : displayLabel(provider, model, codexModels, cursorModels);

  const sessionRows = (opts?: { max?: number }) => {
    const q = flyoutQuery.trim();
    const filtered = q
      ? sessions.filter(
          (s) =>
            fuzzyScore(q, s.title) > 0 ||
            fuzzyScore(q, s.projectName) > 0 ||
            fuzzyScore(q, s.provider) > 0,
        )
      : sessions;
    const cap = opts?.max ?? 40;
    const overflow = filtered.length > cap && !q;
    const rows = overflow ? filtered.slice(0, cap) : filtered;
    return { rows, overflow, filtered, q };
  };

  return (
    <div className="relative shrink-0" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        // Match Codex ModelEffortSelector trigger: 29px CBTN chrome, primary label.
        className={`inline-flex h-[29px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent font-sans text-[12px] font-medium tracking-[-0.01em] whitespace-nowrap transition-colors hover:bg-white/[0.06] disabled:pointer-events-none disabled:opacity-40 ${
          compact
            ? "w-[30px] px-0 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            : "min-w-0 px-[9px] !text-[var(--text-primary)]"
        } ${selectedSession ? "!text-[color:var(--accent)]" : ""}`}
        title={triggerTitle}
        aria-label={compact ? triggerLabel : undefined}
      >
        {selectedSession ? (
          <Radio size={compact ? 15 : 12} className="shrink-0 text-[color:var(--accent)]" />
        ) : (
          <ProviderIcon provider={displayIconProvider} size={compact ? 15 : 12} />
        )}
        {!compact && (
          <>
            <span className="min-w-0 max-w-[150px] truncate">
              {triggerLabel}
            </span>
            <ChevronDown
              size={12}
              className={`-ml-0.5 shrink-0 opacity-45 transition-transform ${open ? "rotate-180" : ""}`}
            />
          </>
        )}
      </button>

      <AnimatePresence>
        {open && (
          allowedProviders?.length === 0 ? (
            <div className="absolute bottom-full left-0 mb-2 z-50 w-72">
              <DropdownPopover withArrow>
                <DropdownHeader title="Team restrictions" />
                <p className="px-3 py-2 text-xs text-[var(--text-secondary)]">No agents are available under the current restrictions.</p>
              </DropdownPopover>
            </div>
          ) : lockedProvider === "Gemini" ? (
            <div className="absolute bottom-full left-0 mb-2 z-50" style={{ width: 320 }}>
              <DropdownPopover withArrow>
                <DropdownHeader title="Gemini" kbd="⌘M" />
                <SubmenuShell search="" onSearch={() => {}} showSearch={false}>
                  {GEMINI_SUBMENU_MODELS.map((m) => {
                    const selected =
                      provider === "Gemini" &&
                      !!model &&
                      geminiBaseSlug(model) === geminiBaseSlug(m.slug);
                    return (
                      <DropdownRow
                        key={m.slug}
                        onClick={() => choose("Gemini", m.slug)}
                        disabledReason={blockedReason("Gemini", m.slug)}
                        selected={selected}
                        icon={<ProviderAvatar provider="Gemini" />}
                        title={m.label}
                        meta={m.meta}
                        right={
                          selected ? (
                            <Check size={14} className="text-[color:var(--accent)]" />
                          ) : null
                        }
                      />
                    );
                  })}
                </SubmenuShell>
              </DropdownPopover>
            </div>
          ) : lockedProvider === "Grok" ? (
            <div className="absolute bottom-full left-0 mb-2 z-50" style={{ width: 320 }}>
              <DropdownPopover withArrow>
                <DropdownHeader title="xAI · Grok" kbd="⌘M" />
                <SubmenuShell search="" onSearch={() => {}} showSearch={false}>
                  {GROK_SUBMENU_MODELS.map((m) => {
                    const selected = provider === "Grok" && model === m.slug;
                    return (
                      <DropdownRow
                        key={m.slug}
                        onClick={() => choose("Grok", m.slug)}
                        disabledReason={blockedReason("Grok", m.slug)}
                        selected={selected}
                        icon={<ProviderAvatar provider="Grok" />}
                        title={m.label}
                        meta={m.meta}
                        right={
                          selected ? (
                            <Check size={14} className="text-[color:var(--accent)]" />
                          ) : null
                        }
                      />
                    );
                  })}
                </SubmenuShell>
              </DropdownPopover>
            </div>
          ) : opencodeOnly ? (
            // OpenCode-only flat panel with search — mirrors the OpenCode
            // submenu from the multi-provider flyout but without Claude /
            // Codex sections. Used inside OpenCodeSdkSessionView where
            // switching providers mid-session doesn't make sense.
            (() => {
              // Show search when the catalog is long OR when disconnected
              // models are hidden behind connected-only default list.
              const hasHidden =
                opencodeConnectedCount > 0 &&
                opencodeConnectedCount < opencode.length;
              const showSearch = opencode.length > SEARCH_THRESHOLD || hasHidden;
              const q = flyoutQuery.trim();
              const pool = q
                ? opencode
                : hasHidden
                  ? opencode.filter((m) => !m.disconnected)
                  : opencode;
              const filtered = q
                ? pool.filter(
                    (m) =>
                      fuzzyScore(q, m.label) > 0 ||
                      fuzzyScore(q, m.slug) > 0 ||
                      fuzzyScore(q, m.meta) > 0,
                  )
                : pool;
              const overflow = filtered.length > OPENCODE_RENDER_CAP;
              const rows = overflow ? filtered.slice(0, OPENCODE_RENDER_CAP) : filtered;
              return (
                <div className="absolute bottom-full left-0 mb-2 z-50" style={{ width: 320 }}>
                  <DropdownPopover withArrow>
                    <DropdownHeader title="OpenCode model" kbd="⌘M" />
                    <SubmenuShell
                      search={flyoutQuery}
                      onSearch={setFlyoutQuery}
                      showSearch={showSearch}
                      emptyHint={
                        rows.length === 0 && q
                          ? `No models match "${q}"`
                          : rows.length === 0
                            ? "No connected models — type to search all"
                            : undefined
                      }
                    >
                      {rows.map((m) => {
                        const selected = provider === "OpenCode" && model === m.slug;
                        return (
                          <DropdownRow
                            key={m.slug}
                            onClick={() => choose("OpenCode", m.slug)}
                            disabledReason={blockedReason("OpenCode", m.slug)}
                            selected={selected}
                            icon={<ProviderAvatar provider="OpenCode" />}
                            title={m.label}
                            meta={m.meta}
                            right={
                              selected ? (
                                <Check size={14} className="text-[color:var(--accent)]" />
                              ) : null
                            }
                          />
                        );
                      })}
                      {overflow && (
                        <div className="px-3 py-2 text-center text-[10.5px] font-mono text-zinc-500">
                          {filtered.length - OPENCODE_RENDER_CAP} more · type to filter
                        </div>
                      )}
                    </SubmenuShell>
                  </DropdownPopover>
                </div>
              );
            })()
          ) : collapsibleSections && !claudeOnly ? (
            // Dual content-sized cards, bottom-aligned to the trigger.
            // items-end is required: the wrapper is `bottom-full` above the
            // composer, so top-align (items-start) floats the short provider
            // list high up when the model flyout is taller (MLX etc.).
            // Hover stays reliable because we never clear hoveredProvider
            // while open, and the right card is always mounted.
            <div className="absolute bottom-full left-0 mb-2 z-50 flex items-end">
              <div style={{ width: 260 }} className="shrink-0">
                <DropdownPopover withArrow>
                  <DropdownHeader title={hasSessions ? "Model or session" : "Model"} kbd="⌘M" />
                  <div style={{ maxHeight: CASCADE_LIST_MAX_HEIGHT, overflowY: "auto" }}>
                    {hasSessions && (
                      <div
                        onMouseEnter={() => handleProviderEnter("running")}
                        className={`flex w-full items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors cursor-default ${
                          hoveredProvider === "running"
                            ? "bg-white/[0.06]"
                            : selectedSession
                              ? "bg-[var(--accent)]/[0.06]"
                              : "hover:bg-white/[0.04]"
                        }`}
                      >
                        <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] bg-[var(--accent-dim)] border border-[color:var(--accent-border)] text-[color:var(--accent)]">
                          <Radio size={14} />
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-[13.5px] font-medium tracking-[-0.015em] leading-tight truncate text-zinc-200">
                            Running sessions
                          </span>
                          <span className="mt-0.5 block font-mono text-[10.5px] text-zinc-500 truncate">
                            {selectedSession
                              ? selectedSession.title
                              : `${sessions.length} live agent${sessions.length === 1 ? "" : "s"}`}
                          </span>
                        </span>
                        <ChevronRight size={14} className="shrink-0 text-zinc-500" />
                      </div>
                    )}
                    {cascadeProviders.map((row) => (
                      <HoverProviderRow
                        key={row.key}
                        providerKey={row.key}
                        label={row.label}
                        count={row.count}
                        isActive={!selectedSession && provider === row.key}
                        isHovered={hoveredProvider === row.key}
                        activeLabel={row.activeLabel}
                        onMouseEnter={() => handleProviderEnter(row.key)}
                      />
                    ))}
                  </div>
                </DropdownPopover>
              </div>

              {/* Model flyout — separate card, content-sized. Always present
                  while the picker is open so hover never drops the panel. */}
              <div
                className="shrink-0 pl-1.5"
                onMouseEnter={() => handleProviderEnter(hoveredProvider)}
              >
                <DropdownPopover>
                    {hoveredProvider === "running" && hasSessions && (() => {
                      const { rows, overflow, filtered, q } = sessionRows();
                      const showSearch = sessions.length > SEARCH_THRESHOLD;
                      return (
                        <>
                          <DropdownHeader title="Running sessions" />
                          <SubmenuShell
                            search={flyoutQuery}
                            onSearch={setFlyoutQuery}
                            showSearch={showSearch}
                            emptyHint={
                              rows.length === 0 && q
                                ? `No sessions match "${q}"`
                                : rows.length === 0
                                  ? "No live agents"
                                  : undefined
                            }
                          >
                            {rows.map((s) => {
                              const selected = selectedSessionId === s.id;
                              const stateLabel =
                                s.state === "waiting"
                                  ? "needs you"
                                  : s.state === "running"
                                    ? "working"
                                    : s.state === "unread"
                                      ? "unread"
                                      : s.state ?? "live";
                              return (
                                <DropdownRow
                                  key={s.id}
                                  onClick={() => chooseSession(s.id)}
                                  selected={selected}
                                  icon={<ProviderAvatar provider={s.provider} />}
                                  title={s.title}
                                  meta={`${s.projectName} · ${stateLabel}`}
                                  right={
                                    selected ? (
                                      <Check size={14} className="text-[color:var(--accent)]" />
                                    ) : s.state === "waiting" ? (
                                      <DropdownTag variant="amber">Wait</DropdownTag>
                                    ) : s.state === "running" ? (
                                      <DropdownTag variant="accent">Live</DropdownTag>
                                    ) : null
                                  }
                                />
                              );
                            })}
                            {overflow && (
                              <div className="px-3 py-2 text-center text-[10.5px] font-mono text-zinc-500">
                                {filtered.length - rows.length} more · type to filter
                              </div>
                            )}
                          </SubmenuShell>
                        </>
                      );
                    })()}
                    {hoveredProvider === "ClaudeCode" && (() => {
                      const showSearch = claude.length > SEARCH_THRESHOLD;
                      const q = flyoutQuery.trim();
                      const rows = showSearch && q
                        ? claude.filter(
                            (m) =>
                              fuzzyScore(q, m.name) > 0 ||
                              fuzzyScore(q, m.slug) > 0 ||
                              fuzzyScore(q, m.meta) > 0,
                          )
                        : claude;
                      return (
                        <>
                          <DropdownHeader title="Anthropic" />
                          <SubmenuShell
                            search={flyoutQuery}
                            onSearch={setFlyoutQuery}
                            showSearch={showSearch}
                            emptyHint={rows.length === 0 && q ? `No models match "${q}"` : undefined}
                          >
                            {rows.map((m) => {
                              const selected = provider === "ClaudeCode" && claudeMatches(model, m.slug);
                              return (
                                <DropdownRow
                                  key={m.slug}
                                  onClick={() => choose("ClaudeCode", m.slug)}
                                  disabledReason={blockedReason("ClaudeCode", m.slug)}
                                  selected={selected}
                                  icon={<ProviderAvatar provider="ClaudeCode" />}
                                  title={m.name}
                                  meta={m.meta}
                                  right={
                                    selected ? (
                                      <Check size={14} className="text-[color:var(--accent)]" />
                                    ) : null
                                  }
                                />
                              );
                            })}
                          </SubmenuShell>
                        </>
                      );
                    })()}
                    {hoveredProvider === "Codex" && (() => {
                      const showSearch = codex.length > SEARCH_THRESHOLD;
                      const q = flyoutQuery.trim();
                      const rows = showSearch && q
                        ? codex
                            .map((m, i) => ({ m, i }))
                            .filter(
                              ({ m }) =>
                                fuzzyScore(q, m.name) > 0 ||
                                fuzzyScore(q, m.slug) > 0,
                            )
                        : codex.map((m, i) => ({ m, i }));
                      return (
                        <>
                          <DropdownHeader title="OpenAI · Codex" />
                          <SubmenuShell
                            search={flyoutQuery}
                            onSearch={setFlyoutQuery}
                            showSearch={showSearch}
                            emptyHint={rows.length === 0 && q ? `No models match "${q}"` : undefined}
                          >
                            {rows.map(({ m, i }) => {
                              const selected = provider === "Codex" && model === m.slug;
                              return (
                                <DropdownRow
                                  key={m.slug}
                                  onClick={() => choose("Codex", m.slug)}
                                  disabledReason={blockedReason("Codex", m.slug)}
                                  selected={selected}
                                  icon={<ProviderAvatar provider="Codex" />}
                                  title={m.name}
                                  meta="via Codex CLI"
                                  right={
                                    selected ? (
                                      <Check size={14} className="text-[color:var(--accent)]" />
                                    ) : i === 0 ? (
                                      <DropdownTag variant="violet">New</DropdownTag>
                                    ) : null
                                  }
                                />
                              );
                            })}
                          </SubmenuShell>
                        </>
                      );
                    })()}
                    {hoveredProvider === "OpenCode" && (() => {
                      // Default list: connected models only (keeps the panel
                      // snappy). Searching unlocks the full catalog.
                      const hasHidden =
                        opencodeConnectedCount > 0 &&
                        opencodeConnectedCount < opencode.length;
                      const showSearch = opencode.length > SEARCH_THRESHOLD || hasHidden;
                      const q = flyoutQuery.trim();
                      const pool = q
                        ? opencode
                        : hasHidden
                          ? opencode.filter((m) => !m.disconnected)
                          : opencode;
                      const filtered = q
                        ? pool.filter(
                            (m) =>
                              fuzzyScore(q, m.label) > 0 ||
                              fuzzyScore(q, m.slug) > 0 ||
                              fuzzyScore(q, m.meta) > 0,
                          )
                        : pool;
                      const overflow = filtered.length > OPENCODE_RENDER_CAP;
                      const rows = overflow ? filtered.slice(0, OPENCODE_RENDER_CAP) : filtered;
                      return (
                        <>
                          <DropdownHeader title="OpenCode" />
                          <SubmenuShell
                            search={flyoutQuery}
                            onSearch={setFlyoutQuery}
                            showSearch={showSearch}
                            emptyHint={
                              rows.length === 0 && q
                                ? `No models match "${q}"`
                                : rows.length === 0
                                  ? "No connected models — type to search all"
                                  : undefined
                            }
                          >
                            {rows.map((m) => {
                              const selected = provider === "OpenCode" && model === m.slug;
                              return (
                                <DropdownRow
                                  key={m.slug}
                                  onClick={() => choose("OpenCode", m.slug)}
                                  disabledReason={blockedReason("OpenCode", m.slug)}
                                  selected={selected}
                                  icon={<ProviderAvatar provider="OpenCode" />}
                                  title={m.label}
                                  meta={m.meta}
                                  right={
                                    selected ? (
                                      <Check size={14} className="text-[color:var(--accent)]" />
                                    ) : null
                                  }
                                />
                              );
                            })}
                            {overflow && (
                              <div className="px-3 py-2 text-center text-[10.5px] font-mono text-zinc-500">
                                {filtered.length - OPENCODE_RENDER_CAP} more · type to filter
                              </div>
                            )}
                          </SubmenuShell>
                        </>
                      );
                    })()}
                    {hoveredProvider === "Gemini" && (() => {
                      return (
                        <>
                          <DropdownHeader title="Gemini" />
                          <SubmenuShell search="" onSearch={() => {}} showSearch={false}>
                            {GEMINI_SUBMENU_MODELS.map((m) => {
                              const selected =
                                provider === "Gemini" &&
                                !!model &&
                                geminiBaseSlug(model) === geminiBaseSlug(m.slug);
                              return (
                                <DropdownRow
                                  key={m.slug}
                                  onClick={() => choose("Gemini", m.slug)}
                                  disabledReason={blockedReason("Gemini", m.slug)}
                                  selected={selected}
                                  icon={<ProviderAvatar provider="Gemini" />}
                                  title={m.label}
                                  meta={m.meta}
                                  right={
                                    selected ? (
                                      <Check size={14} className="text-[color:var(--accent)]" />
                                    ) : null
                                  }
                                />
                              );
                            })}
                          </SubmenuShell>
                        </>
                      );
                    })()}
                    {hoveredProvider === "Grok" && (() => {
                      const showSearch = GROK_SUBMENU_MODELS.length > SEARCH_THRESHOLD;
                      const q = flyoutQuery.trim();
                      const rows = showSearch && q
                        ? GROK_SUBMENU_MODELS.filter(
                            (m) =>
                              fuzzyScore(q, m.label) > 0 ||
                              fuzzyScore(q, m.slug) > 0 ||
                              fuzzyScore(q, m.meta) > 0,
                          )
                        : GROK_SUBMENU_MODELS;
                      return (
                        <>
                          <DropdownHeader title="xAI · Grok" />
                          <SubmenuShell
                            search={flyoutQuery}
                            onSearch={setFlyoutQuery}
                            showSearch={showSearch}
                            emptyHint={rows.length === 0 && q ? `No models match "${q}"` : undefined}
                          >
                            {rows.map((m) => {
                              const selected = provider === "Grok" && model === m.slug;
                              return (
                                <DropdownRow
                                  key={m.slug}
                                  onClick={() => choose("Grok", m.slug)}
                                  disabledReason={blockedReason("Grok", m.slug)}
                                  selected={selected}
                                  icon={<ProviderAvatar provider="Grok" />}
                                  title={m.label}
                                  meta={m.meta}
                                  right={
                                    selected ? (
                                      <Check size={14} className="text-[color:var(--accent)]" />
                                    ) : null
                                  }
                                />
                              );
                            })}
                          </SubmenuShell>
                        </>
                      );
                    })()}
                    {hoveredProvider === "Cursor" && (() => {
                      // Plan-aware catalog can be long — search once past the threshold.
                      const showSearch = cursor.length > SEARCH_THRESHOLD;
                      const q = flyoutQuery.trim();
                      const rows = showSearch && q
                        ? cursor.filter(
                            (m) =>
                              fuzzyScore(q, m.name) > 0 ||
                              fuzzyScore(q, m.slug) > 0 ||
                              fuzzyScore(q, cursorModelMeta(m) ?? "") > 0,
                          )
                        : cursor;
                      return (
                        <>
                          <DropdownHeader title="Cursor" />
                          <SubmenuShell
                            search={flyoutQuery}
                            onSearch={setFlyoutQuery}
                            showSearch={showSearch}
                            emptyHint={
                              rows.length === 0 && q
                                ? `No models match "${q}"`
                                : rows.length === 0
                                  ? "No models available for this Cursor plan"
                                  : undefined
                            }
                          >
                            {rows.map((m) => {
                              const selected = provider === "Cursor" && cursorMatches(model, m.slug);
                              return (
                                <DropdownRow
                                  key={m.slug}
                                  onClick={() => choose("Cursor", m.slug)}
                                  disabledReason={blockedReason("Cursor", m.slug)}
                                  selected={selected}
                                  icon={<ProviderAvatar provider="Cursor" />}
                                  title={m.name}
                                  meta={cursorModelMeta(m)}
                                  right={selected ? <Check size={14} className="text-[color:var(--accent)]" /> : null}
                                />
                              );
                            })}
                          </SubmenuShell>
                        </>
                      );
                    })()}
                    {hoveredProvider === "MLX" && (() => {
                      const groups = mlxModels ? groupMlxBySource(mlxModels) : [];
                      const totalCount = mlxModels?.length ?? 0;
                      return (
                        <>
                          <DropdownHeader title="Local Model" />
                          <SubmenuShell>
                            {totalCount === 0 ? (
                              <div className="px-3 py-3 text-xs text-zinc-500">
                                No MLX models found in LM Studio or HuggingFace caches.
                                Get one from{" "}
                                <a
                                  href="https://huggingface.co/mlx-community"
                                  className="underline"
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  huggingface.co/mlx-community
                                </a>
                                .
                              </div>
                            ) : (
                              groups.map((group) => (
                                <div key={group.label}>
                                  <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-zinc-600">
                                    {group.label}
                                  </div>
                                  {group.items.map((m) => {
                                    const selected = provider === "MLX" && model === m.id;
                                    const meta = [m.quant, m.contextWindow ? `${m.contextWindow} ctx` : ""].filter(Boolean).join(" · ");
                                    return (
                                      <DropdownRow
                                        key={`mlx:${m.id}`}
                                        onClick={() => choose("MLX", m.id)}
                                        disabledReason={blockedReason("MLX", m.id)}
                                        selected={selected}
                                        title={prettifyMlxModelName(m.displayName)}
                                        meta={meta || "MLX local"}
                                        right={selected ? <Check size={14} className="text-[color:var(--accent)]" /> : null}
                                      />
                                    );
                                  })}
                                </div>
                              ))
                            )}
                            {totalCount > 0 && (
                              <div className="border-t border-white/[0.06] mt-1 pt-1">
                                <button
                                  onClick={() => {
                                    mlxEjectModel().catch((e) => console.error("[mlx] eject failed", e));
                                    setOpen(false);
                                  }}
                                  className="w-full text-left px-3 py-2 text-[12px] text-zinc-300 hover:bg-white/[0.04] rounded-md"
                                  title="Stop the running mlx_lm.server and free the model from RAM"
                                >
                                  Eject loaded model
                                </button>
                              </div>
                            )}
                          </SubmenuShell>
                        </>
                      );
                    })()}
                </DropdownPopover>
              </div>
            </div>
          ) : (
            // Flat layout (used by SDK claudeOnly + legacy callers).
            <div className="absolute bottom-full left-0 mb-2 z-50" style={{ width: 320 }}>
              <DropdownPopover withArrow>
                <DropdownHeader title={hasSessions ? "Model or session" : "Model"} kbd="⌘M" />
                {hasSessions && (
                  <>
                    <DropdownSectionHeader>Running sessions</DropdownSectionHeader>
                    {sessions.map((s) => {
                      const selected = selectedSessionId === s.id;
                      return (
                        <DropdownRow
                          key={s.id}
                          onClick={() => chooseSession(s.id)}
                          selected={selected}
                          icon={<ProviderAvatar provider={s.provider} />}
                          title={s.title}
                          meta={`${s.projectName}${s.state ? ` · ${s.state}` : ""}`}
                          right={selected ? <Check size={14} className="text-[color:var(--accent)]" /> : null}
                        />
                      );
                    })}
                  </>
                )}
                {!mlxOnly && allow("ClaudeCode") && (
                  <>
                    <DropdownSectionHeader>Anthropic</DropdownSectionHeader>
                    {claude.map((m) => {
                      const selected = provider === "ClaudeCode" && claudeMatches(model, m.slug);
                      return (
                        <DropdownRow
                          key={m.slug}
                          onClick={() => choose("ClaudeCode", m.slug)}
                          disabledReason={blockedReason("ClaudeCode", m.slug)}
                          selected={selected}
                          icon={<ProviderAvatar provider="ClaudeCode" />}
                          title={m.name}
                          meta={m.meta}
                          right={
                            selected ? (
                              <Check size={14} className="text-[color:var(--accent)]" />
                            ) : null
                          }
                        />
                      );
                    })}
                    {!claudeOnly && allow("Codex") && codex.length > 0 && (
                      <>
                        <DropdownSectionHeader>OpenAI · Codex</DropdownSectionHeader>
                        {codex.map((m, i) => {
                          const selected = provider === "Codex" && model === m.slug;
                          return (
                            <DropdownRow
                              key={m.slug}
                              onClick={() => choose("Codex", m.slug)}
                              disabledReason={blockedReason("Codex", m.slug)}
                              selected={selected}
                              icon={<ProviderAvatar provider="Codex" />}
                              title={m.name}
                              meta="via Codex CLI"
                              right={
                                selected ? (
                                  <Check size={14} className="text-[color:var(--accent)]" />
                                ) : i === 0 ? (
                                  <DropdownTag variant="violet">New</DropdownTag>
                                ) : null
                              }
                            />
                          );
                        })}
                      </>
                    )}
                  </>
                )}
                {(mlxChatEnabled && (mlxOnly || (mlxModels && mlxModels.length > 0))) && (
                  <>
                    <DropdownSectionHeader>Local Model</DropdownSectionHeader>
                    {mlxModels && groupMlxBySource(mlxModels).map((group) => (
                      <div key={group.label}>
                        <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-zinc-600">{group.label}</div>
                        {group.items.map((m) => {
                          const selected = provider === "MLX" && model === m.id;
                          const meta = [m.quant, m.contextWindow ? `${m.contextWindow} ctx` : ""].filter(Boolean).join(" · ");
                          return (
                            <DropdownRow
                              key={`mlx:${m.id}`}
                              onClick={() => choose("MLX", m.id)}
                              disabledReason={blockedReason("MLX", m.id)}
                              selected={selected}
                              title={m.displayName}
                              meta={meta || "MLX local"}
                              right={selected ? <Check size={14} className="text-[color:var(--accent)]" /> : null}
                            />
                          );
                        })}
                      </div>
                    ))}
                    {mlxOnly && (!mlxModels || mlxModels.length === 0) && (
                      <div className="px-3 py-3 text-xs text-zinc-500">
                        No MLX models found in LM Studio or HuggingFace caches.
                        Get one from{" "}
                        <a
                          href="https://huggingface.co/mlx-community"
                          className="underline"
                          target="_blank"
                          rel="noreferrer"
                        >
                          huggingface.co/mlx-community
                        </a>.
                      </div>
                    )}
                    {/* Eject — kills the running mlx_lm.server child so the
                        currently-loaded model is unloaded from RAM. The next
                        chat-completion request transparently respawns. */}
                    <div className="border-t border-white/[0.06] mt-1 pt-1">
                      <button
                        onClick={() => {
                          mlxEjectModel().catch((e) => console.error("[mlx] eject failed", e));
                          setOpen(false);
                        }}
                        className="w-full text-left px-3 py-2 text-[12px] text-zinc-300 hover:bg-white/[0.04] rounded-md"
                        title="Stop the running mlx_lm.server and free the model from RAM"
                      >
                        Eject loaded model
                      </button>
                    </div>
                  </>
                )}
                {!mlxOnly && !claudeOnly && allow("Cursor") && cursor.length > 0 && (
                  <>
                    <DropdownSectionHeader>Cursor</DropdownSectionHeader>
                    {cursor.map((m) => {
                      const selected = provider === "Cursor" && cursorMatches(model, m.slug);
                      return (
                        <DropdownRow
                          key={m.slug}
                          onClick={() => choose("Cursor", m.slug)}
                          disabledReason={blockedReason("Cursor", m.slug)}
                          selected={selected}
                          icon={<ProviderAvatar provider="Cursor" />}
                          title={m.name}
                          meta={cursorModelMeta(m)}
                          right={selected ? <Check size={14} className="text-[color:var(--accent)]" /> : null}
                        />
                      );
                    })}
                  </>
                )}
                {!mlxOnly && !claudeOnly && allow("Gemini") && (
                  <>
                    <DropdownSectionHeader>Gemini</DropdownSectionHeader>
                    {GEMINI_SUBMENU_MODELS.map((m) => {
                      const selected =
                        provider === "Gemini" &&
                        !!model &&
                        geminiBaseSlug(model) === geminiBaseSlug(m.slug);
                      return (
                        <DropdownRow
                          key={m.slug}
                          onClick={() => choose("Gemini", m.slug)}
                          disabledReason={blockedReason("Gemini", m.slug)}
                          selected={selected}
                          icon={<ProviderAvatar provider="Gemini" />}
                          title={m.label}
                          meta={m.meta}
                          right={selected ? <Check size={14} className="text-[color:var(--accent)]" /> : null}
                        />
                      );
                    })}
                  </>
                )}
              </DropdownPopover>
            </div>
          )
        )}
      </AnimatePresence>
    </div>
  );
}
