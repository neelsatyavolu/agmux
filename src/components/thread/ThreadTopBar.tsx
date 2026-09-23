import { useSharedSessionPanels } from "./SessionPanelsContext";
import { pollGitInfo, pollGitStatus } from "../../lib/gitPolling";
import { useState, useEffect, useLayoutEffect, useCallback, useRef, type CSSProperties } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Terminal,
  Copy,
  GitBranch,
  Check,
  ChevronDown,
  Loader2,
  PanelRightOpen,
  GitCommitHorizontal,
  RefreshCw,
  Lock,
  LockOpen,
  FileDiff,
  ShieldOff,
} from "lucide-react";
import {
  ThreadTimelinePopover,
  TimelineTriggerButton,
} from "./ThreadTimelinePopover";
import { countThreadTurns } from "../../lib/commands";
import { listen } from "@tauri-apps/api/event";
import type { ThreadTurn } from "../../lib/types";
import {
  openInIde,
  listAvailableIdes,
  type GitInfo,
  type GitStatusSummary,
  type IdeInfo,
} from "../../lib/commands";
import { isAppForeground, syncPollingToAppForeground } from "../../lib/appVisibility";
import {
  DropdownPopover,
  DropdownRow,
  dropdownVariants,
} from "../ui/ComposerDropdown";
import { handleWindowDragStart } from "../../lib/windowDrag";
import { CommitDialog } from "./CommitDialog";
import { useUiStore } from "../../stores/uiStore";
import { useSplitViewStore, countPanes } from "../../stores/splitViewStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThreadStore } from "../../stores/threadStore";
import { useSessionNameStore } from "../../stores/sessionNameStore";
import { useUsageQuotaStore } from "../../stores/usageQuotaStore";
import type { PaceStatus } from "../../lib/commands";
import { useResolvedColorMode } from "../ThemeProvider";
import {
  getClaudeModelDisplayName,
  prettifyCodexModelName,
  prettifyCursorModel,
  prettifyGrokModel,
  prettifyKimiModel,
  prettifyOpenCodeSlug,
  prettifyPiModel,
  prettifyGeminiModel,
  prettifyClineModel,
  type Provider,
} from "../../lib/types";
import { formatLocalModelLabel, isLocalModelSlug } from "../../lib/mlx";
import type { ContextUsage } from "./ContextRing";
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

const TITLE_MAX_CHARS = 32;

function truncateTitle(s: string): string {
  if (s.length <= TITLE_MAX_CHARS) return s;
  return s.slice(0, TITLE_MAX_CHARS - 1).trimEnd() + "…";
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    // Drop trailing .0 for whole thousands (1K not 1.0K)
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}K`;
  }
  // Drop trailing .0 for whole millions (1M not 1.0M)
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function modelDisplayFor(provider: Provider | null, slug: string | null | undefined): string | null {
  if (!slug) return null;
  // Local gateway models always get the short MLX label (OpenCode chat +
  // Pi "local" terminal both use `local/...` slugs).
  if (provider === "MLX" || isLocalModelSlug(slug)) {
    return formatLocalModelLabel(slug);
  }
  if (provider === "ClaudeCode") {
    // Drop the leading "Claude " so the meta row reads as a terse slug
    return getClaudeModelDisplayName(slug).replace(/^Claude\s+/i, "");
  }
  if (provider === "Codex") return prettifyCodexModelName(slug);
  if (provider === "OpenCode") return prettifyOpenCodeSlug(slug) || slug;
  if (provider === "Grok") return prettifyGrokModel(slug);
  if (provider === "Cursor") return prettifyCursorModel(slug);
  if (provider === "Kimi") return prettifyKimiModel(slug);
  if (provider === "Cline") return prettifyClineModel(slug);
  if (provider === "Gemini") return prettifyGeminiModel(slug);
  if (provider === "Pi" || provider === "Hermes") {
    return prettifyPiModel(slug);
  }
  return slug;
}

// ─── Row 2: Status bar ──────────────────────────────────────────────────────

/** Quota window data plumbed into Row 2 — utilization %, reset wall-clock, and
 *  pace status (when available) for color-coding. */
interface QuotaWindowInfo {
  utilization: number | null;
  resetsAt: string | null;
  paceStatus: PaceStatus | null;
  paceLabel: string | null;
  /** Signed delta from expected pace (utilization - expectedUtilization).
   *  Positive = over pace, negative = under. null when pace data unavailable. */
  paceDelta: number | null;
}

/** Props for the second row of the top bar — provider status info. */
interface TopBarRowTwoProps {
  /** When true, shows the bypass-permissions indicator. */
  bypassActive: boolean;
  /** Provider — used to choose which status sections are relevant. */
  provider: Provider | null;
  /** Claude quota data — session (5 h) and weekly windows. Claude-only. */
  quota?: { session: QuotaWindowInfo | null; weekly: QuotaWindowInfo | null } | null;
}

function formatTime(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")}${ampm}`;
}

/** Format an absolute reset time. Same-day → "5:30pm", future-day → "Tue 5:30pm",
 *  >7 days out → "May 17 5:30pm". Returns null when input is missing/invalid. */
function formatResetAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = formatTime(d);
  if (sameDay) return time;
  const diffDays = Math.round((d.getTime() - now.getTime()) / 86_400_000);
  if (diffDays >= -1 && diffDays <= 6) {
    const dow = d.toLocaleDateString(undefined, { weekday: "short" });
    return `${dow} ${time}`;
  }
  const md = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${md} ${time}`;
}

function paceStatusColor(status: PaceStatus | null): string {
  switch (status) {
    case "behind":
      return "var(--status-green)";
    case "on_track":
      return "var(--status-blue, rgb(59,130,246))";
    case "ahead":
      return "var(--status-amber)";
    case "well_over":
      return "var(--status-red)";
    default:
      return "var(--status-green)";
  }
}

/** Render one Claude quota window (5-hour or weekly): mini bar, utilization %,
 *  reset-at wall-clock. Color-coded by paceStatus when available, else by
 *  raw utilization. Tooltip carries the pace label. */
function QuotaChip({ label, info }: { label: string; info: QuotaWindowInfo }) {
  const pct = info.utilization;
  if (pct === null) return null;
  const safePct = Math.min(100, Math.max(0, pct));
  // Pace coloring takes precedence over raw utilization — the user wants to
  // see "are we ahead/behind expected pace" not just "how full is the bar".
  const color = info.paceStatus
    ? paceStatusColor(info.paceStatus)
    : safePct >= 85
      ? "var(--status-red)"
      : safePct >= 60
        ? "var(--status-amber)"
        : "var(--status-green)";
  const resetAt = formatResetAt(info.resetsAt);
  const tooltip = [
    `${label}: ${Math.round(safePct)}% used`,
    info.paceLabel,
    resetAt ? `Resets at ${resetAt}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className="inline-flex items-center" style={{ gap: 4 }} title={tooltip}>
      <span style={{ color: "var(--text-muted)", fontSize: 9, letterSpacing: "0.02em" }}>{label}</span>
      <span
        style={{
          position: "relative",
          display: "inline-block",
          width: 28,
          height: 3,
          borderRadius: 9999,
          background: "var(--surface-3)",
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${safePct}%`,
            background: color,
            borderRadius: 9999,
            transition: "width 400ms ease-out, background 400ms ease-out",
          }}
        />
      </span>
      <span style={{ fontVariantNumeric: "tabular-nums", color }}>{Math.round(safePct)}%</span>
      {info.paceDelta !== null && (
        <span style={{ fontVariantNumeric: "tabular-nums", color }}>
          ({info.paceDelta >= 0 ? "+" : ""}
          {info.paceDelta < 1 && info.paceDelta > -1
            ? info.paceDelta.toFixed(1)
            : Math.round(info.paceDelta)}
          %)
        </span>
      )}
      {resetAt && (
        <span style={{ color: "var(--text-muted)", opacity: 0.7 }}>· resets {resetAt}</span>
      )}
    </span>
  );
}

/** Second row rendered below the main top-bar chrome. Shows the live clock,
 *  Claude quota chips with reset wall-clocks (ClaudeCode-only), and the
 *  bypass-permissions indicator. The redundant context-token % was dropped —
 *  Row 1 already shows live token counts, and percentages of those numbers
 *  add no information. Uses only CSS variables so light/dark both work. */
function TopBarRowTwo({ bypassActive, provider, quota }: TopBarRowTwoProps) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Tick to the next minute boundary then every 60 s after that.
    const msToNextMin = (60 - new Date().getSeconds()) * 1000 - new Date().getMilliseconds();
    let intervalId: ReturnType<typeof setInterval> | undefined;
    const timeoutId = setTimeout(() => {
      setNow(new Date());
      intervalId = setInterval(() => setNow(new Date()), 60_000);
    }, msToNextMin);
    return () => {
      clearTimeout(timeoutId);
      if (intervalId !== undefined) clearInterval(intervalId);
    };
  }, []);

  // Quota chips — render whenever we have utilization data for at least one
  // window. Provider gating happens upstream in the store: providers without
  // a rate-limit endpoint (OpenCode, Kimi, MLX) yield null and the chips
  // simply don't render — Row 2 stays structurally identical for all.
  const showQuota =
    quota != null &&
    ((quota.session?.utilization ?? null) !== null || (quota.weekly?.utilization ?? null) !== null);
  void provider;

  return (
    <div
      className="relative flex w-full items-center pointer-events-none"
      style={{
        height: 20,
        paddingLeft: 14,
        paddingRight: 14,
        gap: 14,
        fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
        fontSize: 10,
        color: "var(--text-muted)",
        borderTop: "1px solid var(--glass-border)",
      }}
    >
      {/* Time — always present */}
      <span style={{ flexShrink: 0, letterSpacing: "0.01em" }}>
        {formatTime(now)}
      </span>

      {/* Claude quota chips — 5-hour and weekly with reset-at and pace colors. */}
      {showQuota && (
        <>
          <span style={{ color: "var(--text-muted)", opacity: 0.4, flexShrink: 0 }}>·</span>
          <span
            className="inline-flex items-center pointer-events-auto"
            style={{ gap: 12, flexShrink: 0 }}
          >
            {quota!.session && <QuotaChip label="5h" info={quota!.session} />}
            {quota!.weekly && <QuotaChip label="wk" info={quota!.weekly} />}
          </span>
        </>
      )}

      {/* Bypass-permissions indicator */}
      {bypassActive && (
        <>
          <span style={{ color: "var(--text-muted)", opacity: 0.4, flexShrink: 0 }}>·</span>
          <span
            className="inline-flex items-center pointer-events-auto"
            style={{ gap: 4, color: "var(--status-amber)", flexShrink: 0 }}
            title="Bypass permissions active — all tool calls are auto-approved"
          >
            <ShieldOff size={10} style={{ flexShrink: 0 }} />
            <span>bypass permissions on</span>
          </span>
        </>
      )}
    </div>
  );
}

/** Fallback shown while the dynamic list is loading or if detection fails. */
const IDE_FALLBACK: IdeInfo[] = [
  { id: "cursor", name: "Cursor", icon: "✦" },
  { id: "vscode", name: "VS Code", icon: "⬡" },
  { id: "zed", name: "Zed", icon: "Z" },
  { id: "windsurf", name: "Windsurf", icon: "W" },
];

/** Small 16px icon tile used inside the IDE trigger pill. Renders the real
 *  macOS app icon when the backend could extract one, else falls back to the
 *  glyph character shipped in the registry. */
function IdeIconTile({ option, size = 14 }: { option: IdeInfo; size?: number }) {
  if (option.iconDataUrl) {
    return (
      <img
        src={option.iconDataUrl}
        alt=""
        width={size}
        height={size}
        style={{ flexShrink: 0, borderRadius: 3 }}
      />
    );
  }
  return (
    <span
      className="inline-flex items-center justify-center"
      style={{ width: size, height: size, fontSize: size - 3, opacity: 0.85, flexShrink: 0 }}
    >
      {option.icon}
    </span>
  );
}

interface Props {
  threadId: string;
  workDir: string;
  onToggleGitSidebar: () => void;
  gitSidebarOpen: boolean;
  onToggleTerminal: () => void;
  terminalOpen: boolean;
  onRefreshTerminal?: () => void;
  onToggleDangerouslySkipPermissions?: () => void;
  dangerouslySkipPermissions?: boolean;
  isProcessing?: boolean;
  /** When true, the centered children slot (Terminal/Chat/Split) is hidden */
  hideViewModeControls?: boolean;
  /** Hide the slide-up shell terminal control (cowork mode). */
  hideTerminal?: boolean;
  /** Explicit provider override — used when no thread exists in the store (e.g. discovered Claude sessions on disk). */
  provider?: Provider;
  /** Explicit title override — used when no thread exists in the store. */
  title?: string;
  /** Context window usage — only SDK/Codex sessions track this. Undefined means "don't render". */
  contextUsage?: ContextUsage | null;
  /** Explicit model slug — used when the thread row in the store isn't yet hydrated
   *  with a model (e.g. Claude PTY sessions before the first JSONL poll lands in the store).
   *  Takes precedence over thread.model. */
  modelSlug?: string | null;
  /** When true, hides Row 2 and reverts to single-row (56px) height.
   *  Used by split-pane callers so each pane doesn't lose 22px to the status row. */
  compact?: boolean;
  /** Generic bypass-permissions state — used by non-Claude providers (MLX, OpenCode).
   *  When provided, the lock icon is shown and reflects this value. */
  bypassActive?: boolean;
  /** Toggle callback for the generic bypass lock icon. Omit for read-only indicators. */
  onToggleBypass?: () => void;
  /** Tooltip text for the lock icon — provider-specific label (e.g. "Auto-approve all (--ask-for-approval never)"). */
  bypassTooltip?: string;
  /** Whether this bar's session is the visible/active one. When false, the git
   *  info/status poll is suspended — with one TopBar mounted per open session,
   *  polling every hidden session forks a `git` subprocess per tick and scales
   *  CPU with session count. Defaults to `true` (poll) when omitted so callers
   *  that don't thread visibility are unaffected. */
  active?: boolean;
  /**
   * Visual chrome variant.
   * - `"chat"` (default): translucent `.codex-topbar` so the emerald wall washes through.
   * - `"terminal"`: solid pre-glass bar — no emerald gradient (PTY / terminal-only sessions).
   */
  surface?: "chat" | "terminal";
  /**
   * When true with surface="terminal", paint the bar solid to match a full-bleed
   * TUI panel (Grok #141414 / light #f5f5f7) instead of the translucent terminal glass.
   */
  flushTerminal?: boolean;
  children?: React.ReactNode;
}

// Ghost icon button — 30×30, radius 7. Matches the design's spacious right cluster.
function IconBtn({
  icon: Icon,
  title,
  onClick,
  active,
  disabled,
  accent,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  accent?: "green" | "amber" | "default";
}) {
  const isLight = useResolvedColorMode();
  const hoverColor = isLight ? "#1a1a1a" : "#e4e4e7";
  const activeColor =
    accent === "green" ? "var(--accent)" : accent === "amber" ? "var(--status-amber)" : hoverColor;
  const idleColor = isLight ? "#52525b" : "#a1a1aa";
  const baseColor = active ? activeColor : idleColor;
  const hoverBg = isLight ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.05)";
  const hoverBorder = isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.06)";
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 30,
        height: 30,
        borderRadius: 7,
        background: active ? hoverBg : "transparent",
        border: `1px solid ${active ? hoverBorder : "transparent"}`,
        color: baseColor,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: disabled ? "not-allowed" : "pointer",
        flexShrink: 0,
        opacity: disabled ? 0.4 : 1,
        transition: "all 150ms cubic-bezier(0.16,1,0.3,1)",
      }}
      onMouseEnter={(e) => {
        if (disabled || active) return;
        e.currentTarget.style.background = hoverBg;
        e.currentTarget.style.borderColor = hoverBorder;
        e.currentTarget.style.color = hoverColor;
      }}
      onMouseLeave={(e) => {
        if (disabled || active) return;
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.borderColor = "transparent";
        e.currentTarget.style.color = baseColor;
      }}
    >
      <Icon size={15} />
    </button>
  );
}

export function ThreadTopBar({
  threadId,
  workDir,
  onToggleGitSidebar: ownToggleGitSidebar,
  gitSidebarOpen: ownGitSidebarOpen,
  onToggleTerminal: ownToggleTerminal,
  terminalOpen: ownTerminalOpen,
  onRefreshTerminal,
  onToggleDangerouslySkipPermissions,
  dangerouslySkipPermissions,
  isProcessing,
  hideViewModeControls,
  hideTerminal = false,
  provider: providerOverride,
  title: titleOverride,
  contextUsage,
  modelSlug,
  compact = false,
  bypassActive: bypassActiveProp,
  onToggleBypass,
  bypassTooltip,
  active = true,
  surface = "chat",
  flushTerminal = false,
  children,
}: Props) {
  const sharedPanels = useSharedSessionPanels();
  const onToggleGitSidebar = sharedPanels?.onToggleGitSidebar ?? ownToggleGitSidebar;
  const gitSidebarOpen = sharedPanels?.gitSidebarOpen ?? ownGitSidebarOpen;
  const onToggleTerminal = sharedPanels?.onToggleTerminal ?? ownToggleTerminal;
  const terminalOpen = sharedPanels?.terminalOpen ?? ownTerminalOpen;
  const isLight = useResolvedColorMode();
  // Mode-aware palette. Dark values match the original design exactly so dark
  // mode is visually unchanged; light values use darker text and lighter
  // glass surfaces so the bar reads against a bright backdrop.
  const textPrimary = isLight ? "#1a1a1a" : "#e4e4e7";
  const textSecondary = isLight ? "#52525b" : "#a1a1aa";
  const textMuted = isLight ? "#71717a" : "#71717a";
  const textDivider = isLight ? "#a1a1aa" : "#3f3f46";
  const chipBg = isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.04)";
  const chipBgHover = isLight ? "rgba(0,0,0,0.07)" : "rgba(255,255,255,0.07)";
  const chipBorder = isLight ? "rgba(0,0,0,0.10)" : "rgba(255,255,255,0.08)";
  const chipBorderHover = isLight ? "rgba(0,0,0,0.14)" : "rgba(255,255,255,0.12)";
  const chipHairline = isLight ? "rgba(0,0,0,0.10)" : "rgba(255,255,255,0.08)";
  const chipHoverSubtle = isLight ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.05)";
  const stateIdleBg = isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.04)";
  const stateIdleBorder = isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.06)";
  const contextTrackBg = isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.06)";
  const titleColor = isLight ? "#1a1a1a" : "#fff";
  // Chat surfaces use `.codex-topbar` (emerald wall washes through). Terminal
  // surfaces use a solid neutral bar so PTY sessions don't inherit the chat
  // emerald gradient. flushTerminal matches Grok's full-bleed panel
  // (.terminal-flush-host / ansiBlackDark).
  const terminalBarBg = flushTerminal
    ? (isLight ? "#f5f5f7" : "#141414")
    : (isLight ? "rgba(255,255,255,0.65)" : "rgba(10,10,11,0.55)");
  const terminalBarBorder = flushTerminal
    ? "none"
    : isLight
      ? "1px solid rgba(0,0,0,0.08)"
      : "1px solid rgba(255,255,255,0.06)";
  const isChatSurface = surface === "chat";

  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatusSummary | null>(null);
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [turnCount, setTurnCount] = useState(0);
  const [timelineToast, setTimelineToast] = useState<string | null>(null);
  const appMode = useUiStore((s) => s.appMode);
  const hideTerm = hideTerminal || appMode === "cowork";
  const editorPanelOpen = useUiStore((s) => s.editorPanelOpen);
  const fileTreeVisible = useUiStore((s) => s.fileTreeVisible);
  const toggleEditorPanel = useUiStore((s) => s.toggleEditorPanel);
  const isSplit = useSplitViewStore((s) => countPanes(s.layout) > 1);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const selectedIde = useSettingsStore((s) => s.settings.preferredIde);
  // Claude PTY passes the real Claude session ID rather than the agmux UUID —
  // resolve back through claudeSessionMap so we can find the owning thread.
  const claudeSessionMap = useUiStore((s) => s.claudeSessionMap);
  const resolvedThreadId = (() => {
    for (const [xanomId, realIds] of Object.entries(claudeSessionMap)) {
      if (xanomId === threadId) return xanomId;
      if (realIds.includes(threadId)) return xanomId;
    }
    return threadId;
  })();
  const thread = useThreadStore((s) => {
    for (const list of Object.values(s.threads)) {
      const t = list.find((x) => x.id === resolvedThreadId);
      if (t) return t;
    }
    return null;
  });
  const sessionName = useSessionNameStore(
    (s) => s.names[resolvedThreadId] || s.names[threadId],
  );
  const effectiveProvider: Provider | null = thread?.provider ?? providerOverride ?? null;
  const displayTitle = truncateTitle(sessionName || thread?.name || titleOverride || "");

  // ── Per-provider bypass state ──────────────────────────────────────────────
  // For Codex: fast_mode (set at spawn, read-only — no runtime toggle).
  // For Claude: dangerouslySkipPermissions prop (toggleable, existing path).
  // For MLX / OpenCode: bypassActiveProp + onToggleBypass (caller-supplied).
  // Kimi: no bypass mechanism found — hide the icon.
  const codexBypassActive = effectiveProvider === "Codex" && (thread?.fast_mode ?? 0) !== 0;
  // Unified resolved values for the lock icon.
  const resolvedBypassActive: boolean = (() => {
    if (effectiveProvider === "ClaudeCode") return !!dangerouslySkipPermissions;
    if (effectiveProvider === "Codex") return codexBypassActive;
    if (effectiveProvider === "MLX" || effectiveProvider === "OpenCode") return !!bypassActiveProp;
    return false;
  })();
  const resolvedToggleBypass: (() => void) | undefined = (() => {
    if (effectiveProvider === "ClaudeCode") return onToggleDangerouslySkipPermissions;
    if (effectiveProvider === "Codex") return undefined; // read-only — set at spawn
    if (effectiveProvider === "MLX" || effectiveProvider === "OpenCode") return onToggleBypass;
    return undefined;
  })();
  const resolvedBypassTooltip: string = (() => {
    if (effectiveProvider === "ClaudeCode") {
      return isProcessing ? "Cannot change while agent is working" : "Skip permission checks (--dangerously-skip-permissions)";
    }
    if (effectiveProvider === "Codex") {
      return codexBypassActive
        ? "Auto-approve all (--sandbox workspace-write --ask-for-approval never) — set at spawn, cannot change mid-session"
        : "Standard permissions — set at spawn, cannot change mid-session";
    }
    if (effectiveProvider === "MLX") return bypassTooltip ?? "Auto-approve all tool calls";
    if (effectiveProvider === "OpenCode") return bypassTooltip ?? "Auto-approve all tool calls";
    return "Bypass permissions";
  })();
  // Show the lock icon for any provider except Kimi, Grok, and Cursor (no
  // toggleable bypass mechanism).
  const showBypassIcon = effectiveProvider !== null && effectiveProvider !== "Kimi" && effectiveProvider !== "Grok" && effectiveProvider !== "Cursor" && (
    effectiveProvider === "ClaudeCode"
      ? !!onToggleDangerouslySkipPermissions
      : true
  );
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const setSelectedIde = useCallback((id: string) => updateSettings({ preferredIde: id }), [updateSettings]);
  const [showIdeMenu, setShowIdeMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [ideOptions, setIdeOptions] = useState<IdeInfo[]>(IDE_FALLBACK);
  const ideMenuRef = useRef<HTMLDivElement>(null);

  // Detect installed editors/IDEs/terminals once on mount. Falls back to the
  // static list if the backend call fails (e.g. non-macOS / permission error).
  useEffect(() => {
    let cancelled = false;
    listAvailableIdes()
      .then((list) => {
        if (cancelled) return;
        if (Array.isArray(list) && list.length > 0) setIdeOptions(list);
      })
      .catch(() => {
        // Keep fallback — surface nothing in UI so the chip always renders.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Elapsed running time — ticks while isProcessing, resets to 0 otherwise.
  const [elapsedMs, setElapsedMs] = useState(0);
  const processingStartedRef = useRef<number | null>(null);
  useEffect(() => {
    processingStartedRef.current = isProcessing ? Date.now() : null;
    if (!isProcessing) setElapsedMs(0);
  }, [isProcessing]);
  useEffect(() => {
    const start = processingStartedRef.current;
    if (!active || start === null) return;
    const tick = () => setElapsedMs(Date.now() - start);
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [isProcessing, active]);

  // Timeline badge: COUNT(*) once on mount. Only re-count on open/close of a
  // turn — not on every mid-turn tool fact upsert (those used to storm SQLite).
  useEffect(() => {
    let cancelled = false;
    let debounceId: ReturnType<typeof setTimeout> | null = null;
    const refresh = (immediate = false) => {
      if (debounceId != null) {
        clearTimeout(debounceId);
        debounceId = null;
      }
      const run = () => {
        countThreadTurns(resolvedThreadId)
          .then((n) => {
            if (!cancelled) setTurnCount(Math.max(0, Math.floor(Number(n) || 0)));
          })
          .catch(() => {
            if (!cancelled) setTurnCount(0);
          });
      };
      if (immediate) run();
      else debounceId = setTimeout(run, 400);
    };
    refresh(true);
    let unlisten: (() => void) | undefined;
    void listen<{ type?: string; turn?: ThreadTurn }>(
      `thread-turn-${resolvedThreadId}`,
      (ev) => {
        const turn = ev.payload?.turn;
        if (ev.payload?.type !== "upsert" || !turn?.id) return;
        // Open: running with no tools yet (fresh open_turn emit).
        // Close: terminal status. Skip mid-turn tool-fact updates.
        if (turn.status === "running") {
          let tools = 0;
          try {
            const f = JSON.parse(turn.factsJson || "{}") as { tools?: number };
            tools = typeof f.tools === "number" ? f.tools : 0;
          } catch {
            tools = 0;
          }
          if (tools > 0) return;
        }
        refresh(false);
      },
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (debounceId != null) clearTimeout(debounceId);
      unlisten?.();
    };
  }, [resolvedThreadId, timelineOpen]);

  useEffect(() => {
    if (!timelineToast) return;
    const id = window.setTimeout(() => setTimelineToast(null), 2200);
    return () => window.clearTimeout(id);
  }, [timelineToast]);

  // Fetch + poll git info and status summary. Both commands spawn multiple
  // git subprocesses, and one TopBar is mounted per open session, so polling is
  // gated on BOTH this being the active/visible session (`active`) and the
  // window being foregrounded — otherwise N background
  // sessions each spawn git every 5s and CPU scales with session count.
  // Mirrors GitBranchSelector's visibility gating; resumes with an immediate
  // refresh when the session becomes active or the window is refocused.
  useEffect(() => {
    if (!workDir || workDir === "/") {
      setGitInfo(null);
      setGitStatus(null);
      return;
    }
    if (!active) return;
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const refresh = () => {
      pollGitInfo(workDir)
        .then((info) => { if (!cancelled) setGitInfo(info); })
        .catch(() => { if (!cancelled) setGitInfo(null); });
      pollGitStatus(workDir)
        .then((s) => { if (!cancelled) setGitStatus(s); })
        .catch(() => { if (!cancelled) setGitStatus(null); });
    };
    const startPolling = () => {
      if (intervalId) return;
      intervalId = setInterval(refresh, 5000);
    };
    const stopPolling = () => {
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
    };
    if (isAppForeground()) refresh();
    const unsub = syncPollingToAppForeground(startPolling, stopPolling, refresh);
    return () => {
      cancelled = true;
      stopPolling();
      unsub();
    };
  }, [workDir, active]);

  // Close IDE menu on outside click
  useEffect(() => {
    if (!showIdeMenu) return;
    const handler = (e: MouseEvent) => {
      if (ideMenuRef.current && !ideMenuRef.current.contains(e.target as Node)) {
        setShowIdeMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showIdeMenu]);

  const handleCopyThreadId = useCallback(() => {
    navigator.clipboard.writeText(threadId).catch(console.error);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [threadId]);

  const handleOpenIde = useCallback(() => {
    if (!workDir || workDir === "/") return;
    setLaunching(true);
    openInIde(workDir, selectedIde)
      .catch(console.error)
      .finally(() => setTimeout(() => setLaunching(false), 1000));
  }, [workDir, selectedIde]);

  const selectedIdeOption =
    ideOptions.find((o) => o.id === selectedIde) ?? ideOptions[0] ?? IDE_FALLBACK[0];
  const folderName = gitInfo?.folder_name ?? workDir.split("/").filter(Boolean).pop() ?? "";
  // Show worktree_branch when present (e.g. task-mode git worktree); fall back to
  // the repo's checked-out branch from getGitInfo().
  const worktreeBranch = thread?.worktree_branch ?? null;
  const branch = worktreeBranch || gitInfo?.branch || "";
  const isWorktree = !!worktreeBranch;
  const filesChanged = gitStatus?.files_changed ?? 0;
  const hasChanges = filesChanged > 0;

  // Meta row visibility — only show pieces we actually have data for.
  // Prefer the explicit modelSlug prop when caller provides it (e.g. Claude PTY
  // reads the model from JSONL directly), else fall back to the store's thread row.
  const effectiveModelSlug = modelSlug ?? thread?.model ?? null;
  const modelLabel = modelDisplayFor(effectiveProvider, effectiveModelSlug);
  const ctxMax = contextUsage?.maxTokens ?? 0;
  const ctxUsed = contextUsage?.usedTokens ?? 0;
  const showContext = !!contextUsage && ctxMax > 0 && ctxUsed >= 0;
  const ctxPct = showContext ? Math.max(0, Math.min(100, (ctxUsed / ctxMax) * 100)) : 0;
  // State pill: running when processing. Idle only when we actually know (thread exists + !isProcessing + isProcessing prop was passed).
  // Show a state pill whenever the caller passed an explicit isProcessing boolean.
  // Parity with SDK chat: "running · duration" while active, "idle" when finished,
  // even on terminal/PTY threads where the thread row might not be hydrated yet.
  const stateKind: "running" | "idle" | null = isProcessing
    ? "running"
    : typeof isProcessing === "boolean"
      ? "idle"
      : null;
  const stateColor = stateKind === "running" ? "var(--status-amber)" : "#71717a";
  const stateHalo = stateKind === "running" ? "rgba(245,158,11,0.22)" : "transparent";
  const stateLabel = stateKind === "running"
    ? elapsedMs > 0 ? `running · ${formatElapsed(elapsedMs)}` : "running"
    : stateKind === "idle"
      ? "idle"
      : "";


  // compact prop takes explicit precedence; otherwise hide when in a split pane.
  // Row 2 is opt-in via the "Move status line to top bar" setting. It also
  // requires the layout to be single-pane and not running in compact mode —
  // a split pane / compact host doesn't have the vertical room and the
  // user already opted out of full chrome there.
  const moveStatusLineToTopBar = useSettingsStore(
    (s) => s.settings.moveStatusLineToTopBar ?? false,
  );
  const showRow2 = moveStatusLineToTopBar && !compact && !isSplit;

  // Provider-agnostic quota — adapter strategy in `lib/providers/usageAdapters`
  // decides whether the current provider has data (Claude OAuth, Codex App
  // Server, OpenCode bridging through to Anthropic OAuth when on a Claude
  // model). The store polls + caches per-provider; the topbar just reads.
  const startQuotaPoll = useUsageQuotaStore((s) => s.start);
  const providerStateAll = useUsageQuotaStore((s) => s.byProvider);
  const providerState = effectiveProvider ? providerStateAll[effectiveProvider] : undefined;
  const rawQuota = providerState?.quota ?? null;
  const rawPace = providerState?.pace ?? null;
  useEffect(() => {
    if (showRow2 && effectiveProvider) {
      // Pass the model slug so the OpenCode adapter can decide whether to
      // bridge to Anthropic OAuth.
      startQuotaPoll(effectiveProvider, effectiveModelSlug);
    }
  }, [showRow2, effectiveProvider, effectiveModelSlug, startQuotaPoll]);
  const quotaForRow2 = rawQuota
    ? {
        session: rawQuota.session
          ? {
              utilization: rawQuota.session.utilization,
              resetsAt: rawQuota.session.resetsAt,
              paceStatus: rawPace?.session?.paceStatus ?? null,
              paceLabel: rawPace?.session?.paceLabel ?? null,
              paceDelta: rawPace?.session?.delta ?? null,
            }
          : null,
        weekly: rawQuota.weekly
          ? {
              utilization: rawQuota.weekly.utilization,
              resetsAt: rawQuota.weekly.resetsAt,
              paceStatus: rawPace?.weekly?.paceStatus ?? null,
              paceLabel: rawPace?.weekly?.paceLabel ?? null,
              paceDelta: rawPace?.weekly?.delta ?? null,
            }
          : null,
      }
    : null;

  const hasMetaRow = !!(modelLabel || showContext);
  const row1Height = hasMetaRow ? 46 : 40;
  const totalHeight = showRow2 ? row1Height + 22 : row1Height;

  // Publish actual bar height to the parent as a CSS variable so sibling
  // content (the offset div using .topbar-offset-full / .topbar-offset-row1)
  // reserves exactly the right padding-top — no static 78 px gap when Row 2
  // is opt-out and the bar is actually 46–56 px tall.
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!parent) return;
    parent.style.setProperty("--xanom-topbar-h", `${totalHeight}px`);
  }, [totalHeight]);

  return (
    <div
      ref={rootRef}
      className="absolute top-0 right-0 left-0 z-20 flex flex-col"
      style={{ height: totalHeight }}
    >
      {/* Drag fill sits *under* interactive chrome (z-0). Without z-index,
          WKWebView app-region hit-testing can steal clicks from the refresh
          button even when the button is painted above this layer. */}
      <div
        data-tauri-drag-region
        className="absolute inset-0 z-0"
        onMouseDown={handleWindowDragStart}
      />

      {/* Chat: translucent glass over emerald wall. Terminal: solid neutral bar.
          flushTerminal: opaque Grok panel color — no blur/border so it reads continuous. */}
      {isChatSurface ? (
        <div className="codex-topbar absolute inset-0 pointer-events-none" aria-hidden />
      ) : (
        <div
          className="absolute inset-0 pointer-events-none"
          aria-hidden
          style={{
            background: terminalBarBg,
            ...(flushTerminal
              ? {}
              : {
                  backdropFilter: "blur(12px)",
                  WebkitBackdropFilter: "blur(12px)",
                }),
            borderBottom: terminalBarBorder,
          }}
        />
      )}

      {/* ROW 1: left breadcrumb + centered title + right actions.
          The middle flex-1 column absorbs all remaining space and centers the title inside it,
          so the title sits visually balanced between the two side clusters. */}
      <div
        className={`relative z-10 flex w-full items-center pointer-events-none transition-[padding] duration-300 ${sidebarCollapsed ? "pl-[20px]" : ""}`}
        style={{
          height: row1Height,
          gap: 14,
          padding: "0 14px",
          boxSizing: "border-box",
        }}
      >
        {/* ─── LEFT: breadcrumb + meta ─────────────────────────── */}
        <div
          data-tauri-drag-region
          className="flex min-w-0 flex-col justify-center pointer-events-auto"
          style={{ gap: hasMetaRow ? 1 : 3 }}
          onMouseDown={handleWindowDragStart}
        >
          {/* Row 1: project › branch › sync */}
          <div
            className="flex items-center"
            style={{
              gap: 7,
              fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
              fontSize: 12,
              minWidth: 0,
            }}
          >
            {folderName && (
              <span className="truncate" style={{ color: textPrimary }}>{folderName}</span>
            )}
            {branch && !isSplit && (
              <>
                <ChevronDown size={10} style={{ color: textDivider, flexShrink: 0 }} strokeWidth={2} />
                {isWorktree && (
                  <span
                    style={{
                      flexShrink: 0,
                      padding: "1px 6px",
                      borderRadius: 4,
                      fontSize: 9,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                      fontWeight: 600,
                      color: "var(--status-green)",
                      background: "rgba(247,173,60,0.10)",
                      border: "1px solid rgba(247,173,60,0.22)",
                    }}
                    title={`Worktree at ${workDir}`}
                  >
                    Worktree
                  </span>
                )}
                <span
                  className="inline-flex items-center min-w-0"
                  style={{
                    gap: 5,
                    color: isWorktree ? "var(--status-green)" : textSecondary,
                  }}
                  title={isWorktree ? `Worktree branch: ${branch}\nPath: ${workDir}` : branch}
                >
                  <GitBranch size={11} style={{ flexShrink: 0 }} />
                  <span className="truncate">{branch}</span>
                </span>
              </>
            )}
            {onRefreshTerminal && (
              <button
                type="button"
                title="Refresh terminal layout"
                onClick={(e) => {
                  e.stopPropagation();
                  onRefreshTerminal();
                }}
                // Parent breadcrumb cluster is a drag region + starts window
                // drag on mousedown; stop propagation so the click reaches us.
                // Do NOT preventDefault on mousedown — that suppresses click.
                // Inline no-drag is belt-and-suspenders with the CSS rule.
                onMouseDown={(e) => {
                  e.stopPropagation();
                }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                }}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 5,
                  marginLeft: 2,
                  background: "transparent",
                  border: "none",
                  color: textMuted,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  flexShrink: 0,
                  WebkitAppRegion: "no-drag",
                  appRegion: "no-drag",
                } as CSSProperties}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = textPrimary;
                  e.currentTarget.style.background = chipHoverSubtle;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = textMuted;
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <RefreshCw size={11} style={{ pointerEvents: "none" }} />
              </button>
            )}

            {/* Inline state pill — only when there's no model/context to show
                (terminal/PTY sessions), so the single row stays compact instead
                of dropping to a second meta row. */}
            {stateKind && !modelLabel && !showContext && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  marginLeft: 4,
                  padding: "1.5px 7px",
                  borderRadius: 9999,
                  fontSize: 10.5,
                  background: stateKind === "running" ? "rgba(245,158,11,0.10)" : stateIdleBg,
                  border: `1px solid ${stateKind === "running" ? "rgba(245,158,11,0.22)" : stateIdleBorder}`,
                  color: stateColor,
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 5,
                    height: 5,
                    borderRadius: 9999,
                    background: stateColor,
                    boxShadow: stateHalo !== "transparent" ? `0 0 0 3px ${stateHalo}` : "none",
                    animation: stateKind === "running" ? "tb-pulse 1.6s ease-in-out infinite" : "none",
                    flexShrink: 0,
                  }}
                />
                {stateLabel}
              </span>
            )}
          </div>

          {/* Row 2: state pill · model · context meter — only when at least one of
              modelLabel or context meter is present (otherwise the state pill moves inline). */}
          {(modelLabel || showContext) && (
            <div
              className="flex items-center"
              style={{
                gap: 8,
                fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
                fontSize: 10.5,
                minWidth: 0,
              }}
            >
              {stateKind && (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "1.5px 7px",
                    borderRadius: 9999,
                    background: stateKind === "running" ? "rgba(245,158,11,0.10)" : "rgba(255,255,255,0.04)",
                    border: `1px solid ${stateKind === "running" ? "rgba(245,158,11,0.22)" : "rgba(255,255,255,0.06)"}`,
                    color: stateColor,
                    flexShrink: 0,
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      width: 5,
                      height: 5,
                      borderRadius: 9999,
                      background: stateColor,
                      boxShadow: stateHalo !== "transparent" ? `0 0 0 3px ${stateHalo}` : "none",
                      animation: stateKind === "running" ? "tb-pulse 1.6s ease-in-out infinite" : "none",
                      flexShrink: 0,
                    }}
                  />
                  {stateLabel}
                </span>
              )}
              {stateKind && (modelLabel || showContext) && (
                <span style={{ color: textDivider, flexShrink: 0 }}>·</span>
              )}
              {modelLabel && (
                <span className="truncate" style={{ color: textSecondary, maxWidth: 160 }} title={effectiveModelSlug ?? undefined}>
                  {modelLabel}
                </span>
              )}
              {modelLabel && showContext && (
                <span style={{ color: textDivider, flexShrink: 0 }}>·</span>
              )}
              {showContext && (
                <span
                  className="inline-flex items-center"
                  style={{ gap: 6, color: textSecondary, flexShrink: 0 }}
                  title={`${ctxUsed.toLocaleString()} / ${ctxMax.toLocaleString()} tokens (${ctxPct.toFixed(1)}%)`}
                >
                  <span
                    style={{
                      position: "relative",
                      width: 28,
                      height: 4,
                      borderRadius: 9999,
                      background: contextTrackBg,
                      overflow: "hidden",
                      flexShrink: 0,
                    }}
                  >
                    <span
                      style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: `${ctxPct}%`,
                        background: ctxPct > 85 ? "var(--status-red)" : ctxPct > 70 ? "var(--status-amber)" : "var(--accent)",
                        borderRadius: 9999,
                        transition: "width 240ms ease-out",
                      }}
                    />
                  </span>
                  <span>
                    {formatTokens(ctxUsed)} / {formatTokens(ctxMax)} ({Math.round(ctxPct)}%)
                  </span>
                </span>
              )}
            </div>
          )}
        </div>

        {/* CENTER: takes all empty space between left breadcrumb and right actions,
            and centers the title inside it — so the title feels balanced in the actual gap. */}
        <div className="flex min-w-0 flex-1 items-center justify-center" style={{ gap: 10 }}>
          {effectiveProvider && displayTitle && (
            <div
              data-tauri-drag-region
              className="flex items-center pointer-events-auto min-w-0"
              onMouseDown={handleWindowDragStart}
              style={{ gap: 7, whiteSpace: "nowrap" }}
            >
              {PROVIDER_ICON_SRC[effectiveProvider] ? (
                <img
                  src={PROVIDER_ICON_SRC[effectiveProvider] ?? claudeIcon}
                  alt=""
                  width={16}
                  height={16}
                  style={{ borderRadius: 4, flexShrink: 0 }}
                />
              ) : (
                <span
                  className="flex shrink-0 items-center justify-center rounded-[4px] bg-zinc-800 font-mono text-[9px] font-bold text-zinc-200"
                  style={{ width: 16, height: 16 }}
                >
                  C
                </span>
              )}
              <span
                className="truncate"
                style={{
                  fontSize: 12.5,
                  color: titleColor,
                  fontWeight: 500,
                  letterSpacing: "-0.01em",
                }}
                title={sessionName || thread?.name || titleOverride || ""}
              >
                {displayTitle}
              </span>
            </div>
          )}
          {!hideViewModeControls && children && (
            <div className="pointer-events-auto">{children}</div>
          )}
        </div>

        {/* ─── RIGHT: action cluster ───────────────────────────── */}
        <div className="flex items-center justify-end pointer-events-auto" style={{ gap: 6 }}>
          {/* Commit chip — small chip with subtle bg/border, +N badge when files changed */}
          <button
            type="button"
            onClick={() => setShowCommitDialog(true)}
            disabled={!workDir || workDir === "/"}
            title="Commit changes"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: hasChanges ? "4px 6px 4px 8px" : "4px 9px",
              borderRadius: 6,
              background: chipBg,
              border: `1px solid ${chipBorder}`,
              color: textPrimary,
              fontSize: 12,
              fontWeight: 500,
              cursor: !workDir || workDir === "/" ? "not-allowed" : "pointer",
              letterSpacing: "-0.01em",
              opacity: !workDir || workDir === "/" ? 0.4 : 1,
              transition: "background 150ms ease-out, border-color 150ms ease-out",
            }}
            onMouseEnter={(e) => {
              if (!workDir || workDir === "/") return;
              e.currentTarget.style.background = chipBgHover;
              e.currentTarget.style.borderColor = chipBorderHover;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = chipBg;
              e.currentTarget.style.borderColor = chipBorder;
            }}
          >
            <GitCommitHorizontal size={12} style={{ color: textSecondary }} />
            {!isSplit && <span>Commit</span>}
            {hasChanges && (
              <span
                style={{
                  marginLeft: 1,
                  fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
                  fontSize: 10,
                  padding: "1px 5px",
                  borderRadius: 4,
                  background: "var(--accent-dim)",
                  color: "var(--accent)",
                  fontWeight: 500,
                }}
              >
                +{filesChanged}
              </span>
            )}
          </button>

          {/* IDE split pill — shares chip chrome with the Commit button
              (bg rgba(255,255,255,0.04), border 0.08, zinc-200 text) so both
              controls read with the same visual weight. Internal hairline
              separates the primary action from the caret. */}
          {!isSplit && selectedIdeOption && (
            <div className="relative" ref={ideMenuRef}>
              <div
                className="flex items-center"
                style={{
                  borderRadius: 6,
                  background: chipBg,
                  border: `1px solid ${chipBorder}`,
                  overflow: "hidden",
                }}
              >
                <button
                  type="button"
                  onClick={handleOpenIde}
                  disabled={launching || !workDir || workDir === "/"}
                  title={`Open in ${selectedIdeOption.name}`}
                  className="select-none"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 8px",
                    fontSize: 12,
                    color: textPrimary,
                    fontWeight: 500,
                    letterSpacing: "-0.01em",
                    background: "transparent",
                    border: "none",
                    cursor: launching || !workDir || workDir === "/" ? "not-allowed" : "pointer",
                    opacity: launching || !workDir || workDir === "/" ? 0.55 : 1,
                    transition: "background 150ms ease-out",
                  }}
                  onMouseEnter={(e) => {
                    if (launching || !workDir || workDir === "/") return;
                    e.currentTarget.style.background = chipHoverSubtle;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  {launching ? (
                    <Loader2 size={14} className="animate-spin" style={{ color: textSecondary }} />
                  ) : (
                    <IdeIconTile option={selectedIdeOption} size={14} />
                  )}
                  <span>{selectedIdeOption.name}</span>
                </button>
                <div style={{ width: 1, height: 14, background: chipHairline, flexShrink: 0 }} />
                <button
                  type="button"
                  onClick={() => setShowIdeMenu((v) => !v)}
                  title="Choose editor"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    padding: "4px 6px",
                    color: textSecondary,
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    transition: "all 150ms ease-out",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = chipHoverSubtle;
                    e.currentTarget.style.color = textPrimary;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.color = textSecondary;
                  }}
                >
                  <ChevronDown size={11} strokeWidth={2} />
                </button>
              </div>
              <AnimatePresence>
                {showIdeMenu && (
                  <motion.div
                    variants={dropdownVariants}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                    className="absolute right-0 top-full z-30 mt-1.5"
                    style={{ width: 220 }}
                  >
                    <DropdownPopover>
                      {ideOptions.map((ide) => (
                        <DropdownRow
                          key={ide.id}
                          selected={ide.id === selectedIde}
                          onClick={() => {
                            setSelectedIde(ide.id);
                            setShowIdeMenu(false);
                          }}
                          icon={
                            <span
                              className={`flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border text-[12px] ${
                                ide.id === selectedIde
                                  ? "bg-[var(--accent-dim)] border-[color:var(--accent-border)] text-[color:var(--accent)]"
                                  : "bg-white/[0.04] border-white/[0.06] text-zinc-400"
                              }`}
                            >
                              {ide.iconDataUrl ? (
                                <img
                                  src={ide.iconDataUrl}
                                  alt=""
                                  width={18}
                                  height={18}
                                  style={{ borderRadius: 4 }}
                                />
                              ) : (
                                ide.icon
                              )}
                            </span>
                          }
                          title={ide.name}
                        />
                      ))}
                    </DropdownPopover>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* Subtle separator — hairline only, no filled bar. Hidden in split to hug Commit. */}
          {!isSplit && (
            <span style={{ width: 6, flexShrink: 0 }} />
          )}

          {/* Session timeline — icon-only, left of terminal panel toggle */}
          <div className="relative">
            <TimelineTriggerButton
              count={turnCount}
              open={timelineOpen}
              onClick={() => setTimelineOpen((v) => !v)}
            />
            <ThreadTimelinePopover
              threadId={resolvedThreadId}
              poll
              open={timelineOpen}
              onClose={() => setTimelineOpen(false)}
              onJumpFail={() =>
                setTimelineToast("Can’t find that turn in the current view")
              }
            />
            {timelineToast && (
              <div
                className="absolute right-0 top-full z-50 mt-10 whitespace-nowrap rounded-md border border-white/10 bg-zinc-900/95 px-2.5 py-1.5 text-[11px] text-zinc-300 shadow-lg"
                role="status"
              >
                {timelineToast}
              </div>
            )}
          </div>

          {!hideTerm && (
            <IconBtn icon={Terminal} title="Toggle terminal" onClick={onToggleTerminal} active={terminalOpen} disabled={!workDir || workDir === "/"} />
          )}

          {showBypassIcon && (
            <IconBtn
              icon={resolvedBypassActive ? LockOpen : Lock}
              title={resolvedBypassTooltip}
              onClick={resolvedToggleBypass}
              active={resolvedBypassActive}
              accent={resolvedBypassActive ? "amber" : "default"}
              // Claude PTY can't toggle while a turn is mid-flight (the CLI
              // flag is set at spawn). Codex Chat resolves accessMode per-turn
              // so toggling mid-session is safe and effective on the next send.
              disabled={effectiveProvider === "ClaudeCode" ? isProcessing : false}
            />
          )}

          {!isChatSurface && (
          <IconBtn
            icon={copied ? Check : Copy}
            title="Copy thread ID"
            onClick={handleCopyThreadId}
            accent={copied ? "green" : "default"}
            active={copied}
          />
          )}

          <IconBtn icon={FileDiff} title="Git panel" onClick={onToggleGitSidebar} active={gitSidebarOpen} />

          <IconBtn icon={PanelRightOpen} title="Toggle file explorer" onClick={toggleEditorPanel} active={editorPanelOpen && fileTreeVisible} />
        </div>
      </div>

      {/* ROW 2: status bar — time, token %, quota bars (Claude), bypass indicator */}
      {showRow2 && (
        <TopBarRowTwo
          bypassActive={resolvedBypassActive}
          provider={effectiveProvider}
          quota={quotaForRow2}
        />
      )}

      <CommitDialog
        open={showCommitDialog}
        onClose={() => setShowCommitDialog(false)}
        workDir={workDir}
      />
    </div>
  );
}
