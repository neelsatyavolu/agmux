/** Design screen 13 — employee self-view plus leave-team. */

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CloudOff,
  Coins,
  Receipt,
  Layers,
  LogOut,
  MessageSquare,
  Timer,
} from "lucide-react";
import {
  agoLabel,
  fmtMoney,
  fmtPct,
  fmtSessions,
  fmtTokens,
  sessionsCard,
  parseTeamsTs,
  teamsLeave,
  teamsSelfView,
  TEAM_RANGE_LABELS,
  TEAM_RANGES,
  type MemberDetail,
  type TeamMembership,
  type TeamRange,
} from "../../lib/teams";
import { GlassButton } from "../ui/GlassButton";
import { DailyTrends, MixBars, Sparkline } from "./charts";
import { OutputPanel, ToolMix } from "./TeamDashboard";
import {
  Banner,
  DisclosureBlock,
  EmptyState,
  Panel,
  Pill,
  RangeSeg,
  RoleBadge,
  Skeleton,
  StatCard,
} from "./primitives";

export function TeamSelfView({
  team,
  onLeft,
  onOpenPrivacy,
}: {
  team: TeamMembership;
  onLeft?: () => void;
  onOpenPrivacy?: () => void;
}) {
  const [range, setRange] = useState<TeamRange>("30d");
  const [data, setData] = useState<MemberDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [leaving, setLeaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await teamsSelfView(team.slug, range));
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

  const leave = async () => {
    if (
      !window.confirm(
        `Leave ${team.name}? Uploads stop immediately. Aggregates already sent stay with the team.`,
      )
    ) {
      return;
    }
    setLeaving(true);
    try {
      await teamsLeave(team.slug);
      onLeft?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setLeaving(false);
    }
  };

  const header = (
    <div className="flex items-end gap-3">
      <div>
        <div className="flex items-center gap-2.5">
          <span className="text-[16px] font-semibold text-[var(--text-primary)]" style={{ letterSpacing: "-0.02em" }}>
            {team.name}
          </span>
          <RoleBadge role={team.role} />
        </div>
        <div className="mt-1.5 text-[11.5px] text-[var(--text-muted)]">
          Your stats only. You can&apos;t see other members here.
        </div>
      </div>
      <div className="flex-1" />
      <RangeSeg value={range} onChange={setRange} options={TEAM_RANGES} labels={TEAM_RANGE_LABELS} />
    </div>
  );

  const membershipPanel = (
    <Panel title="Membership" padded={false}>
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-3.5 py-[11px]">
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-[var(--text-primary)]">Metrics upload</div>
          <div className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
            Required while you&apos;re on a team. Aggregates only.{" "}
            {onOpenPrivacy ? (
              <button
                onClick={onOpenPrivacy}
                className="text-[var(--status-blue)] underline-offset-2 hover:underline"
              >
                See the list
              </button>
            ) : null}
          </div>
        </div>
        <Pill tone="ok">on</Pill>
      </div>
      <div className="flex items-center gap-3 px-3.5 py-[11px]">
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-[var(--text-primary)]">Leave {team.name}</div>
          <div className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
            Uploads stop immediately. Aggregates already sent stay with the team.
          </div>
        </div>
        <GlassButton icon={LogOut} size="sm" variant="destructive" onClick={leave} disabled={leaving}>
          {leaving ? "Leaving…" : "Leave team"}
        </GlassButton>
      </div>
    </Panel>
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
            title="Couldn't load your stats"
            body={error}
            actions={
              <GlassButton size="sm" onClick={() => void load()}>
                Try again
              </GlassButton>
            }
          />
        </Panel>
        {membershipPanel}
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
            title="Nothing uploaded yet"
            body="Open a session in agmux — your first upload usually lands within a few minutes."
          />
        </Panel>
        {membershipPanel}
      </div>
    );
  }

  const t = data.totals;
  const tokens = fmtTokens(t.tokens);
  const cost = fmtMoney(t.costUsd);
  const stale =
    data.member.last_upload_at &&
    Date.now() - parseTeamsTs(data.member.last_upload_at) > 86_400_000;

  return (
    <div className="flex flex-col gap-2.5">
      {header}

      {stale ? (
        <Banner tone="warn" icon={AlertTriangle}>
          <b className="font-medium">Partial data.</b> Last successful upload was{" "}
          {agoLabel(data.member.last_upload_at)}, so recent days are incomplete. Your manager sees the
          same staleness.
        </Banner>
      ) : null}

      <div className="grid grid-cols-5 gap-2">
        <StatCard icon={Timer} label="Active" value={t.activeHours.toFixed(1)} unit="h" />
        <StatCard
          icon={Coins}
          label="Reported tokens" help="Measured usage from verified agmux-created sessions. Unverified history and unavailable provider reports are excluded."
          value={tokens.value}
          unit={tokens.unit}
          note={`${fmtPct(t.cacheHitRate)} cache hit`}
        />
        <StatCard
          icon={MessageSquare}
          {...sessionsCard(t)}
          value={fmtSessions(t)}
          note={`${t.turns.toLocaleString()} turns · ${t.toolCalls.toLocaleString()} tools`}
        />
        <StatCard icon={Receipt} label={t.costIncomplete === false ? "Est. cost" : "Partial est. cost"} value={cost.value} unit={cost.unit} help="Missing prices or usage details are excluded; not an invoice." />
        <StatCard icon={Layers} label="Peak conc." value={String(t.peakConcurrent)} />
      </div>

      <div className="grid grid-cols-[2fr_1fr] items-start gap-3">
        <Panel title="Daily trends" sub="what your team sees for you">
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
                <div className="ui-eyebrow text-[var(--text-muted)]">Top models</div>
                <MixBars slices={data.modelMix.slice(0, 5)} mono />
              </>
            ) : null}
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-2 items-start gap-3">
        <Panel
          title="What your agents did"
          right={
            <span className="tabular-nums text-[11.5px] text-[var(--text-muted)]">
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

      <Panel title="What managers can see">
        <DisclosureBlock />
      </Panel>

      {membershipPanel}
    </div>
  );
}
