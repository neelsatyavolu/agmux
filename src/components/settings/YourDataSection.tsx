/**
 * Settings → Your Data — local Teams-style usage for any individual, no team required.
 * Scans Claude / Codex / Grok provider logs on this machine (same pipeline as Teams upload).
 */

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CloudOff,
  Coins,
  Layers,
  MessageSquare,
  RefreshCw,
  Timer,
} from "lucide-react";
import {
  buildLocalSelfView,
  type LocalSelfView,
} from "../../lib/localTeamsAggregate";
import {
  agoLabel,
  fmtMoney,
  fmtPct,
  fmtSessions,
  fmtTokens,
  sessionsCard,
  teamsPreviewPayload,
  TEAM_RANGE_LABELS,
  TEAM_RANGES,
  type HourlyBucket,
  type TeamRange,
} from "../../lib/teams";
import { GlassButton } from "../ui/GlassButton";
import { DailyTrends, MixBars, Sparkline } from "../teams/charts";
import { OutputPanel, ToolMix } from "../teams/TeamDashboard";
import {
  Banner,
  EmptyState,
  Panel,
  RangeSeg,
  Skeleton,
  StatCard,
} from "../teams/primitives";

/** hourUtc is `YYYY-MM-DDTHH` — coerce for parseTeamsTs. */
function hourAsTs(hourUtc: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(hourUtc)) return `${hourUtc}:00:00Z`;
  return hourUtc;
}

export function YourDataSection() {
  const [range, setRange] = useState<TeamRange>("30d");
  const [buckets, setBuckets] = useState<HourlyBucket[] | null>(null);
  const [data, setData] = useState<LocalSelfView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBuckets(await teamsPreviewPayload());
    } catch (e) {
      setError(String(e));
      setBuckets(null);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial scan on mount.
  useEffect(() => {
    void scan();
  }, [scan]);

  // Fold (and re-fold on range change) without rescanning.
  useEffect(() => {
    if (!buckets) return;
    setData(buildLocalSelfView(buckets, range));
  }, [range, buckets]);

  const header = (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <div
          className="text-[16px] font-semibold text-[var(--text-primary)]"
          style={{ letterSpacing: "-0.02em" }}
        >
          Your Data
        </div>
        <div className="mt-1.5 text-[11.5px] text-[var(--text-muted)]">
          Local usage from Claude, Codex, and Grok on this Mac.
          {data?.lastBucketHour
            ? ` · as of ${agoLabel(hourAsTs(data.lastBucketHour))}`
            : ""}
        </div>
      </div>
      <div className="flex-1" />
      <RangeSeg
        value={range}
        onChange={setRange}
        options={TEAM_RANGES}
        labels={TEAM_RANGE_LABELS}
      />
      <GlassButton
        icon={RefreshCw}
        size="sm"
        variant="ghost"
        onClick={() => void scan()}
        disabled={loading}
      >
        {loading ? "Scanning…" : "Refresh"}
      </GlassButton>
    </div>
  );

  if (loading && !data) {
    return (
      <div className="flex flex-col gap-2.5">
        {header}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div
              key={i}
              className="flex flex-col gap-2 rounded-[10px] border border-[var(--glass-border)] bg-[var(--surface-popover)] p-2.5"
            >
              <Skeleton width={54} height={8} />
              <Skeleton width={78} height={20} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex flex-col gap-2.5">
        {header}
        <Panel padded={false}>
          <EmptyState
            icon={AlertTriangle}
            title="Couldn't read local usage"
            body={error}
            actions={
              <GlassButton size="sm" onClick={() => void scan()}>
                Try again
              </GlassButton>
            }
          />
        </Panel>
      </div>
    );
  }

  if (!data) return null;

  if (data.neverSynced) {
    return (
      <div className="flex flex-col gap-2.5">
        {header}
        <Panel padded={false}>
          <EmptyState
            icon={CloudOff}
            title="No agent activity found"
            body="agmux reads Claude, Codex, and Grok session logs on this machine. Open a session and come back — stats appear after the first turns land."
          />
        </Panel>
        <LocalNote />
      </div>
    );
  }

  if (data.totals.daysWithData === 0) {
    return (
      <div className="flex flex-col gap-2.5">
        {header}
        <Panel padded={false}>
          <EmptyState
            icon={CloudOff}
            title={`Nothing in the last ${TEAM_RANGE_LABELS[range].toLowerCase()}`}
            body="Try a wider range, or run an agent session and refresh."
            actions={
              <GlassButton size="sm" onClick={() => setRange("90d")}>
                Show 90 days
              </GlassButton>
            }
          />
        </Panel>
        <LocalNote />
      </div>
    );
  }

  const t = data.totals;
  const tokens = fmtTokens(t.tokens);
  const cost = fmtMoney(t.costUsd);

  return (
    <div className="flex flex-col gap-2.5">
      {header}

      <Banner tone="plain" icon={Timer}>
        Same charts as Teams — computed here from your provider logs. Nothing is
        uploaded unless you join a team and enable sync.
      </Banner>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard icon={Timer} label="Active" value={t.activeHours.toFixed(1)} unit="h" />
        <StatCard
          icon={Coins}
          label="Tokens"
          value={tokens.value}
          unit={tokens.unit}
          note={`${fmtPct(t.cacheHitRate)} cache hit · ${cost.value}${cost.unit} est.`}
        />
        <StatCard
          icon={MessageSquare}
          {...sessionsCard(t)}
          value={fmtSessions(t)}
          note={`${t.turns.toLocaleString()} turns · ${t.toolCalls.toLocaleString()} tools`}
        />
        <StatCard icon={Layers} label="Peak conc." value={String(t.peakConcurrent)} />
      </div>

      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-[2fr_1fr]">
        <Panel title="Daily trends" sub="tokens · active hours">
          <DailyTrends days={data.daily} />
          <div className="mt-2">
            <Sparkline values={data.daily.map((d) => d.activeHours)} />
          </div>
        </Panel>
        <Panel title="Provider & model mix">
          <div className="flex flex-col gap-2.5">
            <MixBars slices={data.providerMix} />
            {data.modelMix?.length ? (
              <>
                <hr className="my-1 border-0 border-t border-white/[0.06]" />
                <div className="ui-eyebrow text-[var(--text-muted)]">
                  Top models
                </div>
                <MixBars slices={data.modelMix.slice(0, 5)} mono />
              </>
            ) : null}
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
        <Panel
          title="What your agents did"
          right={
            <span className="font-mono text-[11.5px] text-[var(--text-muted)]">
              {data.totals.toolCalls.toLocaleString()} tool calls
            </span>
          }
        >
          <ToolMix totals={data.totals} />
        </Panel>
        <Panel title="Output & reliability" sub="code written, calls failed">
          <OutputPanel totals={data.totals} />
        </Panel>
      </div>

      {data.projects.length > 0 ? (
        <Panel title="Projects" sub="basename or hash only" padded={false}>
          <div className="divide-y divide-white/[0.06]">
            {data.projects.slice(0, 8).map((p) => {
              const tok = fmtTokens(p.tokens);
              return (
                <div
                  key={p.projectKey}
                  className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 px-3.5 py-2 text-[12px]"
                >
                  <span className="truncate font-mono text-[11.5px] text-[var(--text-secondary)]">
                    {p.projectKey}
                  </span>
                  <span className="ui-meta text-[11.5px] text-[var(--text-tertiary)]">
                    {p.activeHours.toFixed(1)}h
                  </span>
                  <span className="ui-meta text-[11.5px] text-[var(--text-tertiary)]">
                    {tok.value}
                    {tok.unit}
                  </span>
                  <span className="ui-meta text-[11.5px] text-[var(--text-muted)]">
                    {fmtSessions(p)} sess
                  </span>
                </div>
              );
            })}
          </div>
        </Panel>
      ) : null}

      <LocalNote />
    </div>
  );
}

function LocalNote() {
  return (
    <Panel title="About this data">
      <p className="m-0 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
        Aggregates only — counters and short labels from Claude, Codex, and Grok session
        logs. No prompt text, replies, diffs, file contents, absolute paths, or secrets.
        Join a team under{" "}
        <span className="text-[var(--text-secondary)]">Settings → Teams</span> if you want to share
        the same aggregates with managers.
      </p>
    </Panel>
  );
}
