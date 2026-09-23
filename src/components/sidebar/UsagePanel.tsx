import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
} from "react";
import {
  Activity,
  Settings2,
  Wind,
  MousePointer2,
} from "lucide-react";
import { useSettingsStore, type UsageProvidersConfig } from "../../stores/settingsStore";
import {
  getUsageSummary,
  getModelBreakdown,
  scanUsageLogs,
  type PaceStatus,
  type PaceWindow,
  type UsageSummary,
  type ModelUsage,
} from "../../lib/commands";
import {
  type ProviderId,
  PACE_TTL_MS,
  getPaceCell,
  shouldRefetchPace,
  fetchPaceIfStale,
  grokCreditsLabel,
  usageWindowLabel,
} from "../../lib/providerUsageCache";
import { useAccountUsage } from "../../hooks/useAccountUsage";
import { AccountUsageRows } from "../usage/AccountUsageRows";
import type { ProviderAccount, AccountTeam } from "../../lib/providerAccounts";
import { prettifyCodexModelName } from "../../lib/types";
import { SectionEyebrow, Stat } from "../ui/panel";
import claudeIcon from "../../assets/claude-ai-icon.svg";
import chatgptIcon from "../../assets/chatgpt-icon.svg";
import grokIcon from "../../assets/grok-icon.svg";
import geminiIcon from "../../assets/gemini-icon.svg";

// ─── Provider registry ───────────────────────────────────────────────────
type OptionalProviderId = "warp" | "cursor";

interface ProviderMeta {
  id: ProviderId;
  name: string;
  iconAsset?: string;
  iconComponent?: ComponentType<{ size?: number; strokeWidth?: number }>;
  builtIn: boolean;
  /** When true, only windows with data are rendered (Grok has a single credits bar). */
  hideEmptyWindows?: boolean;
}

const PROVIDERS: ProviderMeta[] = [
  { id: "claude", name: "Claude", iconAsset: claudeIcon, builtIn: true },
  // Codex may only expose weekly after OpenAI lifts the 5-hour limit — hide empty slots.
  { id: "codex", name: "Codex", iconAsset: chatgptIcon, builtIn: true, hideEmptyWindows: true },
  { id: "grok", name: "Grok", iconAsset: grokIcon, builtIn: true, hideEmptyWindows: true },
  // Gemini/Antigravity often has weekly only; hide the empty 5-hour slot.
  { id: "gemini", name: "Gemini", iconAsset: geminiIcon, builtIn: true, hideEmptyWindows: true },
  { id: "warp", name: "Warp", iconComponent: Wind, builtIn: false },
  { id: "cursor", name: "Cursor", iconComponent: MousePointer2, builtIn: false },
];

// ─── Stats cache (UsagePanel-only; HomeScreen doesn't read summary/models) ─
/** Rolling window for the detailed dashboard (daily plot + model breakdown). */
const DETAIL_DAYS = 30;

interface StatsCell {
  summary: UsageSummary | null;
  models: ModelUsage[] | null;
  fetchedAt: number;
  error: string | null;
}

const EMPTY_STATS: StatsCell = {
  summary: null,
  models: null,
  fetchedAt: 0,
  error: null,
};

const statsCache: Record<ProviderId, StatsCell> = {
  claude: { ...EMPTY_STATS },
  codex: { ...EMPTY_STATS },
  grok: { ...EMPTY_STATS },
  warp: { ...EMPTY_STATS },
  gemini: { ...EMPTY_STATS },
  cursor: { ...EMPTY_STATS },
};

function shouldRefetchStats(cell: StatsCell, now: number): boolean {
  return !(cell.fetchedAt > 0 && now - cell.fetchedAt < PACE_TTL_MS);
}

export interface UsageAggregate {
  totalTokens: number;
  totalCostUsd: number;
  totalActiveMs: number;
  /** Providers that have actually returned a summary. */
  reporting: number;
  /** Providers we expect to hear from, so partial totals can say so. */
  expected: number;
}

/**
 * Fold per-provider summaries into one panel-level total.
 *
 * Returns null when nothing has reported yet so callers render a "no data yet"
 * state instead of a zero — a zero here reads as "you used nothing", which is a
 * different and wrong claim.
 */
export function aggregateUsage(
  cells: Array<{ summary: UsageSummary | null } | undefined>,
): UsageAggregate | null {
  let totalTokens = 0;
  let totalCostUsd = 0;
  let totalActiveMs = 0;
  let reporting = 0;

  for (const cell of cells) {
    const summary = cell?.summary;
    if (!summary) continue;
    totalTokens += summary.totalInputTokens + summary.totalOutputTokens;
    totalCostUsd += summary.totalCostUsd;
    totalActiveMs += summary.totalActiveMs ?? 0;
    reporting += 1;
  }

  if (reporting === 0) return null;
  return { totalTokens, totalCostUsd, totalActiveMs, reporting, expected: cells.length };
}

/** In-flight fetchStats promises so concurrent mounts share one round-trip. */
const statsInFlight: Partial<Record<ProviderId, Promise<void>>> = {};

/**
 * Load token history for a provider. Summary/model queries hit SQLite and
 * resolve this promise as soon as they land so the detail pane can paint.
 * Log scanning (Claude/Codex) continues in the background and, if it upserts
 * rows, re-reads the summary and invokes `onUpdate` again.
 *
 * Previously we `await`ed the full `~/.claude/projects` walk first, which left
 * every provider stuck on "Loading usage data…".
 */
async function fetchStats(
  provider: ProviderId,
  onUpdate?: () => void,
): Promise<void> {
  const existing = statsInFlight[provider];
  if (existing) return existing;

  const cell = statsCache[provider];
  // Start scan immediately but never block first paint on it.
  const scanPromise = scanUsageLogs(provider).catch(() => 0);

  const run = (async () => {
    try {
      const [summary, models] = await Promise.all([
        getUsageSummary(provider, DETAIL_DAYS),
        getModelBreakdown(provider, DETAIL_DAYS),
      ]);
      cell.summary = summary;
      cell.models = models;
      cell.fetchedAt = Date.now();
      cell.error = null;
    } catch (err) {
      cell.error = err instanceof Error ? err.message : String(err);
      cell.fetchedAt = Date.now();
    } finally {
      delete statsInFlight[provider];
    }
  })();

  statsInFlight[provider] = run;

  // After first paint, if the scan upserted rows, refresh the summary.
  void run
    .then(() => scanPromise)
    .then(async (upserted) => {
      if (upserted <= 0) return;
      try {
        const [summary2, models2] = await Promise.all([
          getUsageSummary(provider, DETAIL_DAYS),
          getModelBreakdown(provider, DETAIL_DAYS),
        ]);
        cell.summary = summary2;
        cell.models = models2;
        cell.fetchedAt = Date.now();
        onUpdate?.();
      } catch {
        // Keep the first-paint data.
      }
    });

  return run;
}

// ─── Formatters ──────────────────────────────────────────────────────────
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function formatCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 10) return `$${usd.toFixed(1)}`;
  return `$${usd.toFixed(2)}`;
}

/** Compact active-time label. Missing/zero scans render as an em dash. */
function formatActiveMs(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const minutes = ms / 60_000;
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = ms / 3_600_000;
  if (hours < 10) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours)}h`;
}

function paceColor(status: PaceStatus): string {
  switch (status) {
    case "behind":
      return "rgb(34,197,94)";
    case "on_track":
      return "rgb(59,130,246)";
    case "ahead":
      return "rgb(245,158,11)";
    case "well_over":
      return "rgb(239,68,68)";
  }
}

function paceLabelWithDelta(w: PaceWindow): string {
  const pct = Math.abs(w.delta);
  const rounded = pct < 1 ? pct.toFixed(1) : Math.round(pct).toString();
  switch (w.paceStatus) {
    case "behind":
      return `Behind pace by ${rounded}%`;
    case "on_track":
      return "On track";
    case "ahead":
      return `Ahead of pace by ${rounded}%`;
    case "well_over":
      return `Well over pace by ${rounded}%`;
    default:
      return w.paceLabel;
  }
}

function formatCountdown(resetIso: string | null): string | null {
  if (!resetIso) return null;
  const ms = new Date(resetIso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (hours >= 48) return `${Math.floor(hours / 24)}d`;
  if (hours >= 1) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** Display label for model breakdown rows. Keep distinguishing suffixes
 *  (sol/terra/luna, codex, …) so variants of the same family don't all
 *  collapse to identical "GPT 5.6" labels. */
export function shortenModel(slug: string): string {
  const s = slug.toLowerCase();
  const sonnet = s.match(/sonnet[-\s]?(\d+)[.-]?(\d+)?/);
  if (sonnet) return `Sonnet ${sonnet[1]}${sonnet[2] ? `.${sonnet[2]}` : ""}`;
  const opus = s.match(/opus[-\s]?(\d+)[.-]?(\d+)?/);
  if (opus) return `Opus ${opus[1]}${opus[2] ? `.${opus[2]}` : ""}`;
  const haiku = s.match(/haiku[-\s]?(\d+)[.-]?(\d+)?/);
  if (haiku) return `Haiku ${haiku[1]}${haiku[2] ? `.${haiku[2]}` : ""}`;
  // gpt-5.6-sol / gpt-5.3-codex-spark → keep full prettified name
  if (/^gpt[-\s]?\d/.test(s)) return prettifyCodexModelName(slug);
  const grok = s.match(/grok[-\s]?(\d+(?:\.\d+)?)/);
  if (grok) return `Grok ${grok[1]}`;
  if (s.includes("composer")) return "Composer";
  return slug.length > 18 ? `${slug.slice(0, 16)}…` : slug;
}

// ─── Density ─────────────────────────────────────────────────────────────
type Density = "rich" | "compact" | "ultra";

function densityFor(visibleCount: number): Density {
  if (visibleCount <= 2) return "rich";
  if (visibleCount <= 4) return "compact";
  return "ultra";
}

// ─── Main panel ──────────────────────────────────────────────────────────
export function UsagePanel() {
  const { data: accountData, error: accountError } = useAccountUsage();
  const availabilityError = accountError ?? accountData?.teamError ?? accountData?.teams.find((team) => team.error)?.error;
  const providersCfg = useSettingsStore((s) => s.settings.usageProviders);
  const openSettings = useSettingsStore((s) => s.openSettings);

  const visibleProviders = useMemo(() => {
    return PROVIDERS.filter((p) => {
      if (p.builtIn) return true;
      return providersCfg[p.id as OptionalProviderId]?.enabled === true;
    });
  }, [providersCfg]);

  const density = densityFor(visibleProviders.length);

  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    const jobs: Promise<unknown>[] = [];

    for (const provider of visibleProviders) {
      if (provider.builtIn) {
        if (shouldRefetchPace(provider.id, now)) {
          // Re-paint as each pace fetch lands so bars don't wait on token stats.
          jobs.push(fetchPaceIfStale(provider.id).then(() => {
            if (!cancelled) bump();
          }));
        }
        // Token history for the detail section. Always fetch (not only in
        // "rich" density) so ProviderDetail isn't stuck on "Loading…".
        if (shouldRefetchStats(statsCache[provider.id], now)) {
          jobs.push(
            fetchStats(provider.id, () => {
              if (!cancelled) bump();
            }).then(() => {
              if (!cancelled) bump();
            }),
          );
        }
      } else {
        const cfg = providersCfg[provider.id as OptionalProviderId];
        if (cfg?.enabled && shouldRefetchPace(provider.id, now)) {
          jobs.push(fetchPaceIfStale(provider.id).then(() => {
            if (!cancelled) bump();
          }));
        }
      }
    }

    // No network work: still bump once so a remount (React Strict Mode, or
    // navigating back within TTL) re-reads module-level caches that may have
    // been filled by an earlier mount's in-flight promise after cancel.
    if (jobs.length === 0) {
      bump();
      return;
    }
    Promise.allSettled(jobs).then(() => {
      if (!cancelled) bump();
    });
    return () => {
      cancelled = true;
    };
  }, [visibleProviders, density, providersCfg, bump]);

  // Re-render once a minute so the reset countdowns tick.
  useEffect(() => {
    const id = window.setInterval(bump, 60_000);
    return () => window.clearInterval(id);
  }, [bump]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-density={density}>
      {/* Transparent over `.codex-glass` — `.codex-topbar` double-glass reads solid black. */}
      <div className="usage-topbar flex shrink-0 items-center gap-2 px-5 py-3.5">
        <Activity size={14} strokeWidth={1.7} className="text-[var(--text-muted)]" />
        <SectionEyebrow label="Provider Usage" />
        <button
          type="button"
          onClick={() => openSettings("agentAccounts")}
          className="usage-manage-btn ml-auto"
        >
          Accounts
        </button>
        <button
          type="button"
          onClick={() => openSettings()}
          className="usage-manage-btn flex items-center gap-1.5"
          title="Configure providers"
        >
          <Settings2 size={12} strokeWidth={1.7} />
          Manage
        </button>
      </div>

      <div
        className="flex-1 min-h-0 overflow-y-auto"
        data-tick={tick}
      >
        <div className="mx-auto w-full max-w-6xl px-5 pt-5">
          {availabilityError && (
            <p className="mb-3 text-[11px] text-[var(--text-muted)]" role="status">
              {availabilityError}
            </p>
          )}
          <PanelSummary providers={visibleProviders} />

          <div
            className="grid w-full gap-3"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}
          >
            {visibleProviders.map((p) => (
              <ProviderCard
                key={p.id}
                meta={p}
                density={density}
                providersCfg={providersCfg}
                accounts={accountData?.accounts.filter((account) => account.provider === p.id && (account.provider !== "claude" || !account.teamId))}
                teams={accountData?.teams}
                accountsStale={Boolean(accountError)}
              />
            ))}
          </div>

          <div className="mt-6 space-y-4 pb-8">
            {visibleProviders
              .filter((p) => p.builtIn)
              .map((p) => (
                <ProviderDetail key={p.id} meta={p} />
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Per-provider card ───────────────────────────────────────────────────
function ProviderCard({
  meta,
  density,
  providersCfg,
  accounts,
  teams = [],
  accountsStale,
}: {
  meta: ProviderMeta;
  density: Density;
  providersCfg: UsageProvidersConfig;
  accounts?: ProviderAccount[];
  teams?: AccountTeam[];
  accountsStale?: boolean;
}) {
  const pace = getPaceCell(meta.id);
  const stats = statsCache[meta.id];
  const cfg = meta.builtIn ? null : providersCfg[meta.id as OptionalProviderId];

  const paneBase = "app-card transition-colors";
  const paneSpacing =
    density === "rich"
      ? "px-4 py-3.5"
      : density === "compact"
        ? "px-3.5 py-3"
        : "px-3 py-2.5";

  // Optional provider not yet enabled — this path rarely fires because
  // disabled providers are filtered out, but kept so enabling remounts cleanly.
  if (!meta.builtIn && !cfg?.enabled) {
    return (
      <div className={`${paneBase} ${paneSpacing}`}>
        <CardHeader meta={meta} status="Configure in Settings" muted />
      </div>
    );
  }

  // Enabled optional provider without live usage yet.
  const pending = !meta.builtIn && (Boolean(pace.error) || !pace.data);
  if (pending) {
    return (
      <div className={`${paneBase} ${paneSpacing}`}>
        <CardHeader meta={meta} status="Usage not available yet" muted />
      </div>
    );
  }

  const info = pace.data;
  const session = info?.session ?? null;
  const weekly = info?.weekly ?? null;
  const extraWindows = meta.id === "claude" ? [
    { label: "Sonnet", window: info?.sonnet }, { label: "Opus", window: info?.opus },
    { label: "Designs", window: info?.design }, { label: "Routines", window: info?.routines },
  ].filter((entry): entry is { label: string; window: PaceWindow } => entry.window != null) : [];
  const hasData = Boolean(session || weekly || extraWindows.length);
  const stale = Boolean(info && pace.error);

  // Optional providers that return an empty shape (no session/weekly) from the
  // stub Rust command land here. Short-circuit so the user isn't staring at a blank card.
  if (!meta.builtIn && !hasData) {
    return (
      <div className={`${paneBase} ${paneSpacing}`}>
        <CardHeader meta={meta} status="Usage not available yet" muted />
      </div>
    );
  }

  let statusNode: React.ReactNode = null;
  if (pace.rateLimited) {
    statusNode = <Pill tone="warn" label="rate-limited" title={pace.error ?? undefined} />;
  } else if (stale) {
    statusNode = <Pill tone="muted" label="stale" title={pace.error ?? undefined} />;
  } else if (!hasData && pace.errorAt === 0) {
    statusNode = <span className="ml-auto font-mono text-[10px] text-zinc-600">loading…</span>;
  } else if (!hasData) {
    statusNode = <span className="ml-auto font-mono text-[10px] text-zinc-600">unavailable</span>;
  }

  // Grok: dynamic "Credits"/"Weekly"/"Monthly". Codex/Claude: duration-aware
  // labels so a weekly-only Codex account is not stuck under "5-hour".
  const isGrok = meta.id === "grok";
  const sessionLabel = usageWindowLabel(session, "5-hour");
  const weeklyLabel = isGrok ? grokCreditsLabel(weekly) : usageWindowLabel(weekly, "Weekly");
  const sessionShort =
    sessionLabel === "5-hour" ? "5h" : sessionLabel.replace(/-hour$/, "h").replace(/Weekly/i, "wk");
  const weeklyShort = isGrok
    ? (weeklyLabel === "Monthly" ? "mo" : weeklyLabel === "Weekly" ? "wk" : "cr")
    : weeklyLabel === "Weekly"
      ? "wk"
      : weeklyLabel === "Monthly"
        ? "mo"
        : weeklyLabel.replace(/-hour$/, "h").slice(0, 3);
  const showSession = Boolean(session) || !meta.hideEmptyWindows;
  const showWeekly = Boolean(weekly) || !meta.hideEmptyWindows;

  return (
    <div className={`${paneBase} ${paneSpacing}`}>
      <CardHeader meta={meta} statusNode={accounts?.length ? null : statusNode} />
      {accounts?.length ? (
        <AccountUsageRows accounts={accounts} teams={teams} stale={accountsStale} />
      ) : density === "ultra" ? (
        <div className="mt-1.5 flex flex-wrap gap-3">
          {showSession && <MiniBar label={sessionShort} window={session} dimmed={stale} />}
          {showWeekly && <MiniBar label={weeklyShort} window={weekly} dimmed={stale} />}
          {extraWindows.map(({ label, window }) => <MiniBar key={label} label={label} window={window} dimmed={stale} />)}
        </div>
      ) : (
        <>
          {showSession && <UsageBar label={sessionLabel} window={session} dimmed={stale} />}
          {showWeekly && (
            <UsageBar
              label={weeklyLabel}
              window={weekly}
              dimmed={stale}
              className={showSession ? "mt-2" : "mt-2"}
            />
          )}
        </>
      )}
      {!accounts?.length && density !== "ultra" && extraWindows.map(({ label, window }) => (
        <UsageBar key={label} label={label} window={window} dimmed={stale} className="mt-2" />
      ))}
      {density === "rich" && stats.summary && (
        <StatsStrip summary={stats.summary} models={stats.models ?? []} />
      )}
    </div>
  );
}

/**
 * Panel-level total across every visible provider, above the per-provider
 * cards. Renders nothing until at least one provider reports, so the panel
 * never opens on a row of zeros.
 */
function PanelSummary({ providers }: { providers: ProviderMeta[] }) {
  const agg = aggregateUsage(providers.map((p) => statsCache[p.id]));
  if (!agg) return null;

  const partial = agg.reporting < agg.expected;
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 rounded-lg border border-[var(--glass-border)] bg-[var(--surface-popover)] px-4 py-3 sm:grid-cols-4">
      <Stat label={`Tokens ${DETAIL_DAYS}d`} value={formatTokens(agg.totalTokens)} />
      <Stat label={`Time ${DETAIL_DAYS}d`} value={formatActiveMs(agg.totalActiveMs)} />
      <Stat label={`Cost ${DETAIL_DAYS}d`} value={formatCost(agg.totalCostUsd)} />
      <Stat
        label="Providers"
        value={`${agg.reporting}`}
        detail={partial ? `of ${agg.expected} reporting` : "all reporting"}
      />
    </div>
  );
}

function CardHeader({
  meta,
  status,
  statusNode,
  muted,
}: {
  meta: ProviderMeta;
  status?: string;
  statusNode?: React.ReactNode;
  muted?: boolean;
}) {
  const Icon = meta.iconComponent;
  return (
    <div className="flex items-center gap-2">
      {meta.iconAsset ? (
        <img src={meta.iconAsset} alt="" width={15} height={15} className="block shrink-0 rounded-sm opacity-90" />
      ) : Icon ? (
        <span className={muted ? "text-[var(--text-muted)]" : "text-[var(--text-tertiary)]"}>
          <Icon size={14} strokeWidth={1.7} />
        </span>
      ) : null}
      <span
        className={`text-[13px] font-medium tracking-[-0.015em] ${
          muted ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]"
        }`}
      >
        {meta.name}
      </span>
      {statusNode}
      {status && !statusNode && (
        <span className="ml-auto font-mono text-[10px] text-[var(--text-muted)]">{status}</span>
      )}
    </div>
  );
}

function Pill({ tone, label, title }: { tone: "warn" | "muted"; label: string; title?: string }) {
  return (
    <span
      className="app-chip ml-auto px-2 py-[2px] text-[9.5px] uppercase"
      data-tone={tone}
      title={title}
    >
      {label}
    </span>
  );
}

// ─── Usage bars ──────────────────────────────────────────────────────────
function UsageBar({
  label,
  window: w,
  className,
  dimmed,
}: {
  label: string;
  window: PaceWindow | null;
  className?: string;
  dimmed?: boolean;
}) {
  const hasData = Boolean(w);
  const pct = w ? Math.min(100, Math.max(0, w.utilization)) : 0;
  const expected = w ? Math.min(100, Math.max(0, w.expectedUtilization)) : 0;
  const color = w ? paceColor(w.paceStatus) : "rgba(255,255,255,0.20)";
  const reset = hasData && w ? formatCountdown(w.resetsAt) : null;

  return (
    <div className={`${className ?? ""} mt-2.5`} style={dimmed ? { opacity: 0.6 } : undefined}>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span
          className="font-mono text-[9.5px] uppercase text-[var(--text-muted)]"
          style={{ letterSpacing: "0.18em" }}
        >
          {label}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-[var(--text-secondary)]">
          {hasData ? `${pct.toFixed(0)}%` : "—"}
        </span>
        <span className="ml-auto flex items-center gap-2 font-mono text-[10px]">
          {hasData ? (
            <>
              <span style={{ color }}>{paceLabelWithDelta(w!)}</span>
              {reset && <span className="text-[var(--text-muted)]">· resets {reset}</span>}
            </>
          ) : null}
        </span>
      </div>
      <div className="glass-progress h-1.5">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${pct}%`, background: color, transition: "width 240ms ease" }}
        />
        {hasData && expected > 0 && expected < 100 && (
          <div
            className="absolute inset-y-0 w-px bg-white/25"
            style={{ left: `${expected}%` }}
            title={`Expected pace ${expected.toFixed(0)}%`}
          />
        )}
      </div>
    </div>
  );
}

function MiniBar({
  label,
  window: w,
  dimmed,
}: {
  label: string;
  window: PaceWindow | null;
  dimmed?: boolean;
}) {
  const hasData = Boolean(w);
  const pct = w ? Math.min(100, Math.max(0, w.utilization)) : 0;
  const color = w ? paceColor(w.paceStatus) : "rgba(255,255,255,0.20)";
  return (
    <div
      className="flex flex-1 items-center gap-1.5"
      style={dimmed ? { opacity: 0.6 } : undefined}
      title={hasData ? `${label} ${pct.toFixed(0)}% — ${w!.paceLabel}` : undefined}
    >
      <span className="font-mono text-[9px] uppercase text-[var(--text-muted)]">{label}</span>
      <div className="glass-progress h-1 flex-1">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="font-mono text-[9.5px] tabular-nums text-[var(--text-tertiary)]">
        {hasData ? `${pct.toFixed(0)}%` : "—"}
      </span>
    </div>
  );
}

// ─── Rich-density stats strip ────────────────────────────────────────────
function StatsStrip({ summary, models }: { summary: UsageSummary; models: ModelUsage[] }) {
  const totalTokens = summary.totalInputTokens + summary.totalOutputTokens;
  const topModel = models[0];
  return (
    <div className="mt-3 grid grid-cols-2 gap-3 border-t border-white/[0.04] pt-3 sm:grid-cols-4">
      <Stat label="Tokens 30d" value={formatTokens(totalTokens)} />
      <Stat label="Time 30d" value={formatActiveMs(summary.totalActiveMs ?? 0)} />
      <Stat label="Cost 30d" value={formatCost(summary.totalCostUsd)} />
      <Stat
        label="Top model"
        value={topModel ? shortenModel(topModel.model) : "—"}
        detail={topModel ? `${topModel.percentage.toFixed(0)}%` : undefined}
      />
    </div>
  );
}

// ─── Provider detail (stats + daily plot + model breakdown) ──────────────
// Restyled to match the home-screen card aesthetic: flat surfaces, mono
// uppercase eyebrows, subtle per-provider accent. Kept local to UsagePanel
// so the Settings → Usage dashboard (UsageDashboard.tsx) is untouched.
const DETAIL_ACCENT: Record<ProviderId, { primary: string; secondary: string }> = {
  claude: { primary: "rgb(217,119,87)", secondary: "rgba(217,119,87,0.38)" },
  codex: { primary: "rgb(99,102,241)", secondary: "rgba(99,102,241,0.38)" },
  grok: { primary: "rgb(161,161,170)", secondary: "rgba(161,161,170,0.38)" },
  warp: { primary: "rgb(34,197,94)", secondary: "rgba(34,197,94,0.38)" },
  gemini: { primary: "rgb(168,85,247)", secondary: "rgba(168,85,247,0.38)" },
  cursor: { primary: "rgb(14,165,233)", secondary: "rgba(14,165,233,0.38)" },
};

function ProviderDetail({ meta }: { meta: ProviderMeta }) {
  const stats = statsCache[meta.id];
  const summary = stats.summary;
  const models = stats.models ?? [];
  const accent = DETAIL_ACCENT[meta.id];

  if (!summary) {
    return (
      <section className="app-card overflow-hidden">
        <div className="app-card-head px-5 py-3.5">
          <DetailHeader meta={meta} />
        </div>
        <p className="px-5 py-4 font-mono text-[10.5px] text-[var(--text-muted)]">
          {stats.error ? "Usage data unavailable" : "Loading usage data…"}
        </p>
      </section>
    );
  }

  const totalTokens = summary.totalInputTokens + summary.totalOutputTokens;

  return (
    <section className="app-card overflow-hidden">
      <div className="app-card-head px-5 py-3.5">
        <DetailHeader meta={meta} />
      </div>

      <div className="px-5 py-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
          <DetailStat label="Total tokens" value={formatTokens(totalTokens)} />
          <DetailStat label="Active time" value={formatActiveMs(summary.totalActiveMs ?? 0)} />
          <DetailStat label="Input" value={formatTokens(summary.totalInputTokens)} />
          <DetailStat label="Output" value={formatTokens(summary.totalOutputTokens)} />
          <DetailStat label="Cost" value={formatCost(summary.totalCostUsd)} />
        </div>

        <div className="mt-5">
          <SectionEyebrow label={`Usage — last ${DETAIL_DAYS} days`} className="mb-2.5" />
          <DailyPlot data={summary.dailyBreakdown} accent={accent} />
        </div>

        <div className="mt-5">
          <SectionEyebrow label="Model breakdown" className="mb-2.5" />
          <ModelBreakdown models={models} accent={accent.primary} />
        </div>
      </div>
    </section>
  );
}

function DetailHeader({ meta }: { meta: ProviderMeta }) {
  const Icon = meta.iconComponent;
  return (
    <div className="flex items-center gap-2">
      {meta.iconAsset ? (
        <img src={meta.iconAsset} alt="" width={16} height={16} className="block shrink-0 rounded-sm opacity-90" />
      ) : Icon ? (
        <span className="text-[var(--text-tertiary)]">
          <Icon size={15} strokeWidth={1.7} />
        </span>
      ) : null}
      <span className="text-[13.5px] font-medium tracking-[-0.015em] text-[var(--text-primary)]">
        {meta.name}
      </span>
      <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
        {DETAIL_DAYS}d window
      </span>
    </div>
  );
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div
        className="font-mono text-[9px] uppercase text-[var(--text-muted)]"
        style={{ letterSpacing: "0.14em" }}
      >
        {label}
      </div>
      <div className="mt-1 truncate font-mono text-[15px] tabular-nums tracking-[-0.02em] text-[var(--text-primary)]">
        {value}
      </div>
    </div>
  );
}

function DailyPlot({
  data,
  accent,
}: {
  data: UsageSummary["dailyBreakdown"];
  accent: { primary: string; secondary: string };
}) {
  if (data.length === 0) {
    return <p className="font-mono text-[10.5px] text-[var(--text-muted)]">No usage recorded in this window.</p>;
  }
  const maxTokens = Math.max(...data.map((d) => d.inputTokens + d.outputTokens), 1);
  return (
    <div className="space-y-1.5">
      {data.map((day) => {
        const total = day.inputTokens + day.outputTokens;
        const overallPct = (total / maxTokens) * 100;
        const inputPct = total > 0 ? (day.inputTokens / total) * overallPct : 0;
        const outputPct = overallPct - inputPct;
        return (
          <div key={day.date} className="flex items-center gap-3">
            <span className="w-10 text-right font-mono text-[9.5px] text-[var(--text-muted)]">
              {shortDay(day.date)}
            </span>
            <div className="glass-progress h-1.5 flex-1">
              <div
                className="absolute inset-y-0 left-0 h-full"
                style={{ width: `${inputPct}%`, background: accent.primary }}
              />
              <div
                className="absolute top-0 h-full"
                style={{
                  left: `${inputPct}%`,
                  width: `${outputPct}%`,
                  background: accent.secondary,
                }}
              />
            </div>
            <span className="w-16 text-right font-mono text-[9.5px] tabular-nums text-[var(--text-tertiary)]">
              {total > 0 ? formatTokens(total) : "—"}
            </span>
          </div>
        );
      })}
      <div
        className="flex items-center gap-4 pt-1 font-mono text-[9px] uppercase text-[var(--text-muted)]"
        style={{ letterSpacing: "0.16em" }}
      >
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-sm" style={{ background: accent.primary }} />
          Input
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-sm" style={{ background: accent.secondary }} />
          Output
        </span>
      </div>
    </div>
  );
}

function ModelBreakdown({
  models,
  accent,
}: {
  models: ModelUsage[];
  accent: string;
}) {
  if (models.length === 0) {
    return <p className="font-mono text-[10.5px] text-[var(--text-muted)]">No model data yet.</p>;
  }
  return (
    <div className="space-y-2">
      {models.slice(0, 8).map((m) => (
        <div key={m.model} className="flex items-center gap-3">
          <span
            className="w-36 shrink-0 truncate font-mono text-[11px] text-[var(--text-secondary)]"
            title={m.model}
          >
            {shortenModel(m.model)}
          </span>
          <div className="glass-progress h-1.5 flex-1">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, Math.max(0, m.percentage))}%`,
                background: accent,
              }}
            />
          </div>
          <span className="w-16 text-right font-mono text-[9.5px] tabular-nums text-[var(--text-tertiary)]">
            {formatTokens(m.totalTokens)}
          </span>
          <span className="w-10 text-right font-mono text-[9.5px] tabular-nums text-[var(--text-muted)]">
            {formatActiveMs(m.activeMs ?? 0)}
          </span>
          <span className="w-10 text-right font-mono text-[9.5px] text-[var(--text-muted)]">
            {Math.round(m.percentage)}%
          </span>
        </div>
      ))}
    </div>
  );
}

function shortDay(dateStr: string): string {
  const m = dateStr.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}/${m[2]}` : dateStr.slice(5);
}
