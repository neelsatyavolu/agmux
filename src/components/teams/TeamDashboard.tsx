/** Design screen 12 — desktop manager dashboard (parity with web team home). */

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Calendar,
  CircleSlash,
  Coins,
  ExternalLink,
  Layers,
  MessageSquare,
  Moon,
  Receipt,
  Timer,
  TrendingUp,
} from "lucide-react";
import {
  agoLabel,
  fmtMoney,
  fmtPct,
  fmtSessions,
  fmtTokens,
  sessionsCard,
  teamsOverview,
  TEAM_RANGE_LABELS,
  TEAM_RANGES,
  type MemberRow,
  type ProjectRow,
  type TeamMembership,
  type TeamOverview,
  type TeamRange,
} from "../../lib/teams";
import { GlassButton } from "../ui/GlassButton";
import { DailyTrends, HourHeatmap, MixBars, PeakSessions, Sparkline } from "./charts";
import {
  Avatar,
  Banner,
  EmptyState,
  Panel,
  RangeSeg,
  RoleBadge,
  Skeleton,
  StatCard,
  SyncPill,
} from "./primitives";

export function TeamDashboard({
  team,
  onOpenMember,
  onOpenWeb,
}: {
  team: TeamMembership;
  onOpenMember?: (userId: string) => void;
  onOpenWeb?: () => void;
}) {
  const [range, setRange] = useState<TeamRange>("30d");
  const [data, setData] = useState<TeamOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await teamsOverview(team.slug, range));
    } catch (e) {
      setError(String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [team.slug, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const header = (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <div className="flex items-center gap-2.5">
          <span className="text-[16px] font-semibold text-[var(--text-primary)]" style={{ letterSpacing: "-0.02em" }}>
            {team.name}
          </span>
          <RoleBadge role={team.role} />
        </div>
        <div className="mt-1.5 text-[11.5px] text-[var(--text-muted)]">
          {data
            ? data.scope === "partial"
              ? `${data.memberCount} people${data.teamMemberCount && data.teamMemberCount !== data.memberCount ? ` of ${data.teamMemberCount}` : ""}${data.scopeLabel ? ` · ${data.scopeLabel}` : ""}`
              : `${data.memberCount} members`
            : "—"}
          {data?.lastUploadAt ? ` · as of ${agoLabel(data.lastUploadAt)}` : ""}
        </div>
      </div>
      <div className="flex-1" />
      <RangeSeg value={range} onChange={setRange} options={TEAM_RANGES} labels={TEAM_RANGE_LABELS} />
      {onOpenWeb ? (
        <GlassButton icon={ExternalLink} size="sm" variant="ghost" onClick={onOpenWeb}>
          Open on web
        </GlassButton>
      ) : null}
    </div>
  );

  if (loading && !data) {
    return (
      <div className="flex flex-col gap-2.5">
        {header}
        <div className="grid grid-cols-5 gap-2">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-[10px] border border-white/[0.06] bg-[var(--surface-code-panel)] p-2.5">
              <Skeleton width={54} height={8} />
              <Skeleton width={78} height={20} />
              <Skeleton height={20} />
            </div>
          ))}
        </div>
        <Panel title="Daily trends">
          <Skeleton height={160} />
        </Panel>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-2.5">
        {header}
        <Panel padded={false}>
          <EmptyState
            icon={AlertTriangle}
            title="Couldn't load this team"
            body={error}
            actions={
              <GlassButton size="sm" onClick={() => void load()}>
                Try again
              </GlassButton>
            }
          />
        </Panel>
      </div>
    );
  }

  if (!data) return null;

  // Employees never see team totals; the server scopes them and we route on it.
  if (data.scope === "self") {
    return (
      <div className="flex flex-col gap-2.5">
        {header}
        <Banner tone="plain" icon={Activity}>
          Your role on this team shows your own stats only.
        </Banner>
      </div>
    );
  }

  const t = data.totals;
  const neverSynced = data.members.filter((m) => m.neverSynced).length;
  const hasAnyData = t.daysWithData > 0 || data.members.some((m) => !m.neverSynced);

  if (!hasAnyData) {
    return (
      <div className="flex flex-col gap-2.5">
        {header}
        <Panel padded={false}>
          <EmptyState
            icon={Activity}
            title="Waiting for first sync"
            body="No metrics have arrived yet. Members appear here once they accept the disclosure and their desktop app uploads."
          />
        </Panel>
      </div>
    );
  }

  const tokens = fmtTokens(t.tokens);
  const cost = fmtMoney(t.costUsd);
  const concurrency = data.daily.map((d) => d.peakConcurrent);

  return (
    <div className="flex flex-col gap-2.5">
      {header}

      {neverSynced > 0 ? (
        <Banner tone="warn" icon={AlertTriangle}>
          <b className="font-medium">
            {neverSynced} {neverSynced === 1 ? "member has" : "members have"} never synced.
          </b>{" "}
          Totals below exclude them.
        </Banner>
      ) : null}

      <div className="grid grid-cols-5 gap-2">
        <StatCard icon={Coins} label="Reported tokens" help="Measured usage from verified agmux-created sessions. Unverified history and unavailable provider reports are excluded." value={tokens.value} unit={tokens.unit} delta={data.deltas.tokens} />
        <StatCard icon={Receipt} label={t.costIncomplete === false ? "Est. cost" : "Partial est. cost"} help="Missing prices or usage details are excluded; not an invoice." value={cost.value} unit={cost.unit} delta={data.deltas.costUsd} />
        <StatCard
          icon={Timer}
          label="Active"
          value={t.activeHours.toFixed(1)}
          unit="h"
          note="agent working time, idle excluded"
        />
        <StatCard
          icon={MessageSquare}
          {...sessionsCard(t)}
          value={fmtSessions(t)}
          note={`${t.turns.toLocaleString()} turns · ${t.toolCalls.toLocaleString()} tool calls`}
        />
        <StatCard
          icon={Layers}
          label="Peak conc."
          value={String(t.peakConcurrent)}
          note="highest simultaneous sessions"
        />
      </div>

      {/* Wide chart takes the full width. Pairing it with the taller mix list
          in a 2-column grid left a hole under the chart. */}
      <Panel
        title="Daily trends"
        sub="tokens · active hours"
        right={
          <div className="flex gap-3.5 text-[11px] text-[var(--text-muted)]">
            <span className="inline-flex items-center gap-1.5">
              <i className="block h-2 w-2 rounded-sm" style={{ background: "#60a5fa", opacity: 0.55 }} />
              Tokens
            </span>
            <span className="inline-flex items-center gap-1.5">
              <i className="block h-2 w-2 rounded-sm" style={{ background: "#fbbf24" }} />
              Active
            </span>
          </div>
        }
      >
        <DailyTrends days={data.daily} />
      </Panel>

      {data.budget ? (
        <Panel title="Monthly budget" sub="calendar month · all providers">
          <BudgetPanel budget={data.budget} />
        </Panel>
      ) : null}

      {/* Masonry, not a grid. A grid row is only as short as its TALLEST cell,
          so a short panel beside a tall one left a hole underneath it. These
          five are card-like and width-tolerant, so multi-column packs them by
          height with no fixed rows to leave dead space. The heatmap below needs
          its full width and stays in a real grid. */}
      <div className="columns-3 gap-2.5 [&>*]:mb-2.5 [&>*]:inline-block [&>*]:w-full [&>*]:break-inside-avoid">
        <Panel title="Provider & model mix" right={<span className="text-[11.5px] text-[var(--text-muted)]">tokens · time</span>}>
          <div className="flex flex-col gap-2.5">
            <MixBars slices={data.providerMix} />
            {data.modelMix.length ? (
              <>
                <hr className="my-1 border-0 border-t border-white/[0.06]" />
                <div className="ui-eyebrow text-[var(--text-muted)]">Top models</div>
                <MixBars slices={data.modelMix.slice(0, 6)} mono />
              </>
            ) : null}
          </div>
        </Panel>
        <Panel
          title="What the agents did"
          right={
            <span className="tabular-nums text-[11.5px] text-[var(--text-muted)]">
              {t.toolCalls.toLocaleString()} tool calls
            </span>
          }
        >
          <ToolMix totals={t} />
        </Panel>
        <Panel title="Output & reliability" sub="code written, calls failed">
          <OutputPanel totals={t} />
        </Panel>
        <Panel title="Token composition" right={<span className="tabular-nums text-[11.5px] text-[var(--text-muted)]">{fmtTokens(t.tokens).value}{fmtTokens(t.tokens).unit} total</span>}>
          <TokenBreakdown totals={t} />
        </Panel>
        <Panel title="Work rates" sub="derived from this range">
          <EfficiencyGrid totals={t} />
        </Panel>
        <Panel title="Flags" sub={TEAM_RANGE_LABELS[range]}>
          <Flags flags={data.flags} range={range} />
        </Panel>
        <Panel
          title="Peak simultaneous sessions"
          right={<span className="tabular-nums text-[11.5px] text-[var(--text-muted)]">max {Math.max(0, ...concurrency)}</span>}
        >
          <PeakSessions
            values={concurrency}
            labels={[`${data.daily.length}d ago`, "mid", "today"]}
            dayLabels={data.daily.map((d) => d.full)}
          />
          <div className="mt-2">
            <Sparkline values={concurrency} color="#fbbf24" />
          </div>
        </Panel>
        <Panel title="Projects" sub="basename or hash only" padded={false}>
          <ProjectsTable rows={data.projects ?? []} />
        </Panel>
      </div>

      <Panel title="Members" sub="tap a row for detail" padded={false}>
        <MemberTable members={data.members} onOpenMember={onOpenMember} />
      </Panel>

      {/* Full width: the heatmap has 24 columns and was previously squeezed
          into 2/3 while the taller projects list left a hole beside it. */}
      <Panel title="Hour of day" sub="team active hours, local time">
        <HourHeatmap matrix={data.heatmap} />
      </Panel>
    </div>
  );
}

function TokenBreakdown({ totals: t }: { totals: TeamOverview["totals"] }) {
  // Reasoning is a reported subset of output, so it is split out of Output
  // rather than added again — the bar must sum to the token total.
  const reasoning = Math.min(t.tokensReasoning, t.tokensOut);
  const parts = [
    { key: "Input", n: t.tokensIn, color: "#60a5fa" },
    { key: "Output", n: t.tokensOut - reasoning, color: "#f2a516" },
    { key: "Cache read", n: t.tokensCacheRead, color: "#a78bfa" },
    { key: "Cache write", n: t.tokensCacheWrite, color: "#22d3ee" },
    { key: "Reasoning", n: reasoning, color: "#fbbf24" },
  ].filter((p) => p.n > 0);
  const total = parts.reduce((a, p) => a + p.n, 0);
  if (!total) {
    return <p className="m-0 text-[11.5px] text-[var(--text-muted)]">No token breakdown in this range.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-2.5 overflow-hidden rounded-[5px] bg-white/[0.05]">
        {parts.map((p) => (
          <i
            key={p.key}
            className="block h-full min-w-[2px]"
            style={{ width: `${((p.n / total) * 100).toFixed(2)}%`, background: p.color }}
            title={`${p.key}: ${fmtTokens(p.n).value}${fmtTokens(p.n).unit}`}
          />
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        {parts.map((p) => {
          const tok = fmtTokens(p.n);
          return (
            <div key={p.key} className="grid grid-cols-[1fr_auto_auto] items-center gap-2.5 text-[12px]">
              <span className="flex items-center gap-2 text-[var(--text-tertiary)]">
                <i className="block h-2 w-2 rounded-sm" style={{ background: p.color }} />
                {p.key}
              </span>
              <span className="tabular-nums text-[11.5px] text-[var(--text-secondary)]">
                {tok.value}
                {tok.unit}
              </span>
              <span className="min-w-9 text-right text-[11.5px] text-[var(--text-muted)]">{fmtPct(p.n / total)}</span>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between border-t border-white/[0.06] pt-2 text-[12px] text-[var(--text-muted)]">
        <span>Cache hit rate</span>
        <b className="tabular-nums font-medium text-[var(--text-secondary)]">{fmtPct(t.cacheHitRate)}</b>
      </div>
    </div>
  );
}

/** Foreground ink for the budget projection marker. */
const MARKER_INK = "var(--text-secondary)";

/** Fixed order and colour per tool kind, matching the server's `TOOL_KINDS`. */
const TOOL_KINDS = [
  { key: "bash", label: "Terminal", color: "#fbbf24" },
  { key: "edit", label: "Edits", color: "#f2a516" },
  { key: "read", label: "Reads", color: "#60a5fa" },
  { key: "search", label: "Search", color: "#a78bfa" },
  { key: "web", label: "Web", color: "#22d3ee" },
  { key: "agent", label: "Subagents", color: "#fb7185" },
  { key: "mcp", label: "MCP", color: "#2dd4bf" },
  { key: "other", label: "Other", color: "#71717a" },
] as const;

/**
 * What the agents actually did. A single "tool calls" number can't tell
 * exploring a codebase apart from writing to it.
 */
/**
 * True when a range has tool calls but no breakdown — buckets uploaded before
 * the per-kind columns existed, which default to 0.
 *
 * Without this the panel claims "no tool activity" directly under a header
 * reading "3,307 tool calls". Genuinely read-only work still records
 * `tool_read`, so an all-zero mix beside a non-zero total only ever means the
 * data predates the breakdown.
 */
export function isPreBreakdown(t: TeamOverview["totals"]): boolean {
  if (!(t.toolCalls > 0)) return false;
  const mix = t.toolMix ?? {};
  return TOOL_KINDS.every((k) => !((mix[k.key] ?? 0) > 0));
}

export function ToolMix({ totals: t }: { totals: TeamOverview["totals"] }) {
  const mix = t.toolMix ?? {};
  const parts = TOOL_KINDS.map((k) => ({ ...k, n: mix[k.key] ?? 0 })).filter((p) => p.n > 0);
  const total = parts.reduce((a, p) => a + p.n, 0);
  if (!total) {
    return (
      <p className="m-0 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
        {isPreBreakdown(t)
          ? `These ${t.toolCalls.toLocaleString()} tool calls were recorded before the breakdown existed, so their kinds aren't known. New activity will fill this in.`
          : "No tool activity in this range."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-2.5 overflow-hidden rounded-[5px] bg-white/[0.05]">
        {parts.map((p) => (
          <i
            key={p.key}
            className="block h-full min-w-[2px]"
            style={{ width: `${((p.n / total) * 100).toFixed(2)}%`, background: p.color }}
            title={`${p.label}: ${p.n.toLocaleString()}`}
          />
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        {parts.map((p) => (
          <div key={p.key} className="grid grid-cols-[1fr_auto_auto] items-center gap-2.5 text-[12px]">
            <span className="flex items-center gap-2 text-[var(--text-tertiary)]">
              <i className="block h-2 w-2 rounded-sm" style={{ background: p.color }} />
              {p.label}
            </span>
            <span className="tabular-nums text-[11.5px] text-[var(--text-secondary)]">{p.n.toLocaleString()}</span>
            <span className="min-w-9 text-right text-[11.5px] text-[var(--text-muted)]">{fmtPct(p.n / total)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Output and reliability.
 *
 * The failure rate divides by *measured* calls. Codex reports no outcome for
 * most tool calls, so counting them as successes would invent a reassuring
 * number; when nothing was measurable this says so instead of showing 0%.
 */
export function OutputPanel({ totals: t }: { totals: TeamOverview["totals"] }) {
  const rate = t.toolErrorRate;
  const measured = t.toolsMeasured ?? 0;

  // A grid of zeros would assert "nothing was edited" when the truth is "this
  // data predates the counters" — the honest-state rule again.
  if (isPreBreakdown(t)) {
    return (
      <p className="m-0 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
        Not recorded for this range. These buckets were uploaded before output
        and failure counters existed; they&apos;ll appear as new activity syncs.
      </p>
    );
  }
  const rows = [
    { k: "Files changed", v: (t.filesChanged ?? 0).toLocaleString() },
    { k: "Lines added", v: `+${(t.linesAdded ?? 0).toLocaleString()}` },
    { k: "Lines removed", v: `−${(t.linesRemoved ?? 0).toLocaleString()}` },
    { k: "Net lines", v: ((t.linesAdded ?? 0) - (t.linesRemoved ?? 0)).toLocaleString() },
    { k: "Failed tool calls", v: (t.toolErrors ?? 0).toLocaleString() },
    { k: "Failure rate", v: rate == null ? "not reported" : `${fmtPct(rate)} of ${measured.toLocaleString()}` },
  ];
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        {rows.map((r) => (
          <div key={r.k} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
            <div className="mb-1 text-[10.5px] leading-snug text-[var(--text-muted)]">{r.k}</div>
            <div className="tabular-nums text-[15px] font-semibold tracking-tight text-[var(--text-primary)]">{r.v}</div>
          </div>
        ))}
      </div>
      {rate == null ? (
        <p className="m-0 text-[11px] leading-relaxed text-[var(--text-muted)]">
          Only Claude and Grok report per-call outcomes. Codex activity is counted, but its success
          or failure isn't in the logs.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Monthly spend against budget with a straight-line month-end projection.
 *
 * Renders nothing when no budget is set — a $0 budget would show every team as
 * instantly over.
 */
export function BudgetPanel({ budget }: { budget: NonNullable<TeamOverview["budget"]> }) {
  const pct = Math.min(100, Math.round(budget.usedShare * 100));
  const over = budget.usedShare >= 1;
  const partial = budget.costIncomplete !== false;
  const color = over ? "#f87171" : budget.onTrackToExceed || partial ? "#fbbf24" : "#f2a516";
  const projPct = Math.min(99, Math.round(budget.projectedShare * 100));
  const spend = fmtMoney(budget.spendUsd);
  const monthly = fmtMoney(budget.monthlyUsd);
  const projected = fmtMoney(budget.projectedUsd);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-[11px] text-[var(--text-muted)]">{partial ? "Partial estimate" : "Estimated cost"}</div>
          <div className="tabular-nums text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
            {spend.value}
            <span className="text-[14px] font-normal text-[var(--text-tertiary)]">{spend.unit}</span>
          </div>
          <div className="text-[11.5px] text-[var(--text-muted)]">
            of {monthly.value}
            {monthly.unit} this month
          </div>
        </div>
        <div className="tabular-nums text-[18px] font-semibold" style={{ color }}>
          {pct}%
        </div>
      </div>
      <div className="relative h-2.5 rounded-[5px] bg-white/[0.05]">
        <i
          className="block h-full min-w-[2px] rounded-[5px]"
          style={{ width: `${pct}%`, background: color }}
        />
        {budget.projectedShare > budget.usedShare ? (
          <b
            className="absolute -top-[3px] h-4 w-[2px] rounded-[1px] opacity-75"
            style={{ left: `${projPct}%`, background: MARKER_INK }}
            title="Projected month end"
          />
        ) : null}
      </div>
      <div className="flex justify-between gap-3 text-[11px] text-[var(--text-muted)]">
        <span>
          Day {budget.daysElapsed} of {budget.daysInMonth}
        </span>
        <span className="tabular-nums">
          Projected {partial ? "(partial estimate) " : ""}{projected.value}
          {projected.unit}
        </span>
      </div>
      <div className="text-[11px] text-[var(--text-muted)]">Missing prices or usage details are excluded; not an invoice.</div>
      {budget.onTrackToExceed ? (
        <Banner tone="warn" icon={TrendingUp}>
          Based on recorded estimates, this team is projected to finish the month at{" "}
          <b>
            {projected.value}
            {projected.unit}
          </b>{" "}
          — over the {monthly.value}
          {monthly.unit} budget.
        </Banner>
      ) : null}
    </div>
  );
}

function EfficiencyGrid({ totals: t }: { totals: TeamOverview["totals"] }) {
  if (!t.sessions && !t.turns) {
    return <p className="m-0 text-[11.5px] text-[var(--text-muted)]">Not enough activity to derive rates yet.</p>;
  }
  const tokPerSession = t.sessions > 0 ? fmtTokens(t.tokens / t.sessions) : null;
  const costPerHour = t.activeHours > 0 ? fmtMoney(t.costUsd / t.activeHours) : null;
  const rows = [
    { k: "Turns / active session-hour", v: t.sessions > 0 ? (t.turns / t.sessions).toFixed(1) : "—" },
    { k: "Tool calls / turn", v: t.turns > 0 ? (t.toolCalls / t.turns).toFixed(1) : "—" },
    {
      k: "Tokens / active session-hour",
      v: tokPerSession ? `${tokPerSession.value}${tokPerSession.unit}` : "—",
    },
    {
      k: "Est. $ / active hour",
      v: costPerHour ? `${costPerHour.value}${costPerHour.unit}` : "—",
    },
    { k: "After-hours share", v: fmtPct(t.afterHoursShare) },
    { k: "Weekend share", v: fmtPct(t.weekendShare) },
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {rows.map((r) => (
        <div key={r.k} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
          <div className="mb-1 text-[10.5px] leading-snug text-[var(--text-muted)]">{r.k}</div>
          <div className="tabular-nums text-[15px] font-semibold tracking-tight text-[var(--text-primary)]">{r.v}</div>
        </div>
      ))}
    </div>
  );
}

function ProjectsTable({ rows }: { rows: ProjectRow[] }) {
  if (!rows.length) {
    return <p className="m-0 px-3.5 py-4 text-[11.5px] text-[var(--text-muted)]">No project activity in this range.</p>;
  }
  return (
    <table className="w-full border-collapse tabular-nums">
      <thead>
        <tr>
          {["Project", "Active", "Tokens", "Sessions"].map((h, i) => (
            <th
              key={h}
              className={`ui-eyebrow border-b border-white/[0.06] px-3 py-[7px] text-[var(--text-muted)] ${
                i === 0 ? "text-left" : "text-right"
              }`}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 10).map((r) => {
          const tok = fmtTokens(r.tokens);
          return (
            <tr key={r.projectKey} className="h-[34px]">
              <td className="border-b border-white/[0.035] px-3 text-left font-mono text-[11.5px] text-[var(--text-secondary)]">
                {r.projectKey}
              </td>
              <td className="border-b border-white/[0.035] px-3 text-right text-[12px] text-[var(--text-primary)]">
                {r.activeHours.toFixed(1)}h
              </td>
              <td className="border-b border-white/[0.035] px-3 text-right text-[12px] text-[var(--text-secondary)]">
                {tok.value}
                {tok.unit}
              </td>
              <td className="border-b border-white/[0.035] px-3 text-right text-[12px] text-[var(--text-muted)]">{fmtSessions(r)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Flags are observations with a named cause — never verdicts, never a score. */
function Flags({ flags, range }: { flags: TeamOverview["flags"]; range: TeamRange }) {
  const rows: { icon: typeof Moon; tone: boolean; title: string; detail: string }[] = [];

  if (flags.afterHoursShare > 0) {
    rows.push({
      icon: Moon,
      tone: flags.afterHoursShare > 0.15,
      title: `After-hours ${fmtPct(flags.afterHoursShare)} of active time`,
      detail:
        flags.afterHoursSharePrev > 0
          ? `${flags.afterHoursShare > flags.afterHoursSharePrev ? "Up" : "Down"} from ${fmtPct(flags.afterHoursSharePrev)} last period`
          : "Outside 08:00–18:00 in each member's own timezone (from their device).",
    });
  }
  if (flags.weekendShare > 0) {
    rows.push({
      icon: Calendar,
      tone: false,
      title: `Weekend ${fmtPct(flags.weekendShare)} of active time`,
      detail: "Saturday and Sunday in each member's own timezone.",
    });
  }
  if (flags.idleDays > 0) {
    rows.push({
      icon: CircleSlash,
      tone: false,
      title: `${flags.idleDays} idle ${flags.idleDays === 1 ? "day" : "days"} in the last ${TEAM_RANGE_LABELS[range] ?? range}`,
      detail: "Days with no agent activity uploaded.",
    });
  }
  if (!rows.length) {
    return (
      <p className="m-0 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
        Nothing worth flagging in this range — no after-hours concentration, no idle days.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <div
          key={r.title}
          className={`flex items-start gap-2.5 rounded-[9px] border p-3 text-[12px] leading-snug ${
            r.tone
              ? "border-[#fbbf24]/20 bg-[#fbbf24]/[0.06]"
              : "border-white/[0.06] bg-white/[0.02]"
          }`}
        >
          <r.icon size={14} className={`mt-px shrink-0 ${r.tone ? "text-[var(--status-amber)]" : "text-[var(--text-muted)]"}`} />
          <div>
            <b className="font-medium text-[var(--text-primary)]">{r.title}</b>
            <div className="text-[var(--text-muted)]">{r.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function MemberTable({
  members,
  onOpenMember,
}: {
  members: MemberRow[];
  onOpenMember?: (userId: string) => void;
}) {
  const maxActive = Math.max(1, ...members.filter((m) => !m.neverSynced).map((m) => m.totals.activeHours));

  return (
    <table className="w-full border-collapse tabular-nums">
      <thead>
        <tr>
          {["Member", "Active", "Tokens", "Sessions", "Peak", "Last seen"].map((h, i) => (
            <th
              key={h}
              className={`ui-eyebrow border-b border-white/[0.06] px-3 py-[7px] text-[var(--text-muted)] ${
                i === 0 ? "text-left" : "text-right"
              }`}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {members.map((m) => {
          const tokens = fmtTokens(m.totals.tokens);
          return (
            <tr
              key={m.userId}
              onClick={() => !m.neverSynced && onOpenMember?.(m.userId)}
              className="h-[38px] cursor-default hover:bg-white/[0.025]"
            >
              <td className="border-b border-white/[0.035] px-3 text-left text-[12.5px] text-[var(--text-secondary)]">
                <div className="flex items-center gap-2.5">
                  <Avatar name={m.displayName} color={m.avatarColor} imageUrl={m.avatarUrl} />
                  <span className={`font-medium ${m.neverSynced ? "text-[var(--text-tertiary)]" : "text-[var(--text-primary)]"}`}>
                    {m.displayName}
                  </span>
                  {m.role === "employee" ? null : <RoleBadge role={m.role} />}
                </div>
              </td>
              {m.neverSynced ? (
                // Honest state: one sentence, not a row of zeros.
                <td
                  colSpan={4}
                  className="border-b border-white/[0.035] px-3 text-left text-[11px] text-[var(--text-muted)]"
                >
                  waiting for first sync
                </td>
              ) : (
                <>
                  <td className="border-b border-white/[0.035] px-3 text-right text-[12.5px]">
                    <span className="inline-flex w-full items-center justify-end gap-2">
                      <i
                        className="block h-[5px] rounded-sm bg-[#60a5fa] opacity-75"
                        style={{ width: Math.round((m.totals.activeHours / maxActive) * 56) || 2 }}
                      />
                      <span className="font-medium text-[var(--text-primary)]">{m.totals.activeHours.toFixed(1)}h</span>
                    </span>
                  </td>
                  <td className="border-b border-white/[0.035] px-3 text-right text-[12.5px] text-[var(--text-secondary)]">
                    {tokens.value}
                    {tokens.unit}
                  </td>
                  <td className="border-b border-white/[0.035] px-3 text-right text-[12.5px] text-[var(--text-muted)]">
                    {fmtSessions(m.totals)}
                  </td>
                  <td className="border-b border-white/[0.035] px-3 text-right text-[12.5px] text-[var(--text-muted)]">
                    {m.totals.peakConcurrent.toLocaleString("en-US")}
                  </td>
                </>
              )}
              <td className="border-b border-white/[0.035] px-3 text-right">
                <SyncPill lastUploadAt={m.lastUploadAt} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
