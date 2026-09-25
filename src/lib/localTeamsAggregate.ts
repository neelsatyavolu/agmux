/**
 * Fold local `HourlyBucket[]` (from teams scan) into the same dashboard shapes
 * the Teams self-view renders — without a team membership or upload.
 *
 * Mirrors `teams-service/src/aggregate.ts` but uses the desktop camelCase wire
 * shape from `teams::aggregate::HourlyBucket`.
 */

import type {
  DayPoint,
  HourlyBucket,
  MixSlice,
  ProjectRow,
  TeamFlags,
  TeamRange,
  Totals,
} from "./teams";
import { TEAM_RANGES } from "./teams";

const RANGE_DAYS: Record<TeamRange, number> = {
  "7d": 7,
  "14d": 14,
  "30d": 30,
  "90d": 90,
};

const TOOL_KIND_KEYS = [
  "bash",
  "edit",
  "read",
  "search",
  "web",
  "agent",
  "mcp",
  "other",
] as const;

const TOOL_KIND_FIELD: Record<(typeof TOOL_KIND_KEYS)[number], keyof HourlyBucket> = {
  bash: "toolBash",
  edit: "toolEdit",
  read: "toolRead",
  search: "toolSearch",
  web: "toolWeb",
  agent: "toolAgent",
  mcp: "toolMcp",
  other: "toolOther",
};

const MS_PER_HOUR = 3_600_000;

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function isTeamRange(v: string): v is TeamRange {
  return (TEAM_RANGES as string[]).includes(v);
}

export function rangeDays(range: TeamRange): number {
  return RANGE_DAYS[range];
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function hourFloorDaysAgo(daysAgo: number, now = new Date()): string {
  const d = new Date(now.getTime() - daysAgo * 86_400_000);
  return `${dateKey(d)}T00`;
}

function dayRange(days: number, end = new Date()): string[] {
  const out: string[] = [];
  const base = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  for (let i = days - 1; i >= 0; i--) out.push(dateKey(new Date(base - i * 86_400_000)));
  return out;
}

/** Total billable-ish tokens. Reasoning is a subset of output for OpenAI — do not add it. */
export function bucketTokens(b: HourlyBucket): number {
  return b.tokensIn + b.tokensOut + b.tokensCacheRead + b.tokensCacheWrite;
}

/** Inclusive lower bound as `YYYY-MM-DDTHH`. */
export function filterBucketsByRange(
  buckets: HourlyBucket[],
  range: TeamRange,
  now = new Date(),
): HourlyBucket[] {
  // Today is the last of the range's days, matching `dailySeries`.
  const since = hourFloorDaysAgo(RANGE_DAYS[range] - 1, now);
  return buckets.filter((b) => b.hourUtc >= since && b.hourUtc <= `${dateKey(now)}T23`);
}

/** An active bucket from a build that predates session-start counting. */
const startsUnknown = (b: HourlyBucket): boolean => b.sessions > 0 && b.sessionsStarted == null;

export function totals(buckets: HourlyBucket[]): Totals {
  const t: Totals = {
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    tokensReasoning: 0,
    tokens: 0,
    cacheHitRate: 0,
    costUsd: 0,
    activeHours: 0,
    afterHoursShare: 0,
    weekendShare: 0,
    sessions: 0,
    sessionsStarted: 0,
    sessionsStartedIncomplete: false,
    turns: 0,
    toolCalls: 0,
    peakConcurrent: 0,
    daysWithData: 0,
    toolMix: Object.fromEntries(TOOL_KIND_KEYS.map((k) => [k, 0])),
    toolErrors: 0,
    toolsMeasured: 0,
    toolErrorRate: null,
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
  };

  let activeMs = 0;
  let afterHoursMs = 0;
  let weekendMs = 0;
  const days = new Set<string>();
  const peakByHour = new Map<string, number>();

  for (const b of buckets) {
    t.tokensIn += b.tokensIn;
    t.tokensOut += b.tokensOut;
    t.tokensCacheRead += b.tokensCacheRead;
    t.tokensCacheWrite += b.tokensCacheWrite;
    t.tokensReasoning += b.tokensReasoning;
    t.costUsd += b.costUsd;
    t.sessions += b.sessions;
    t.sessionsStarted! += b.sessionsStarted ?? 0;
    t.sessionsStartedIncomplete ||= startsUnknown(b);
    t.turns += b.turns;
    t.toolCalls += b.toolCalls;
    for (const kind of TOOL_KIND_KEYS) {
      t.toolMix[kind] += Number(b[TOOL_KIND_FIELD[kind]] ?? 0);
    }
    t.toolErrors += b.toolErrors ?? 0;
    t.toolsMeasured += b.toolsMeasured ?? 0;
    t.filesChanged += b.filesChanged ?? 0;
    t.linesAdded += b.linesAdded ?? 0;
    t.linesRemoved += b.linesRemoved ?? 0;
    activeMs += b.activeMs;
    afterHoursMs += b.afterHoursMs;
    weekendMs += b.weekendMs;
    if (b.activeMs > 0 || b.sessions > 0) days.add(b.hourUtc.slice(0, 10));
    peakByHour.set(b.hourUtc, Math.max(peakByHour.get(b.hourUtc) ?? 0, b.peakConcurrent));
  }

  t.tokens =
    t.tokensIn + t.tokensOut + t.tokensCacheRead + t.tokensCacheWrite;
  const inputSide = t.tokensIn + t.tokensCacheRead;
  t.cacheHitRate = inputSide > 0 ? t.tokensCacheRead / inputSide : 0;
  t.activeHours = activeMs / MS_PER_HOUR;
  t.afterHoursShare = activeMs > 0 ? afterHoursMs / activeMs : 0;
  t.weekendShare = activeMs > 0 ? weekendMs / activeMs : 0;
  t.peakConcurrent = peakByHour.size ? Math.max(...peakByHour.values()) : 0;
  t.daysWithData = days.size;
  t.toolErrorRate = t.toolsMeasured > 0 ? t.toolErrors / t.toolsMeasured : null;
  return t;
}

export function dailySeries(
  buckets: HourlyBucket[],
  days: number,
  end = new Date(),
): DayPoint[] {
  const byDay = new Map<string, HourlyBucket[]>();
  for (const b of buckets) {
    const k = b.hourUtc.slice(0, 10);
    const list = byDay.get(k);
    if (list) list.push(b);
    else byDay.set(k, [b]);
  }

  return dayRange(days, end).map((date) => {
    const rows = byDay.get(date);
    const d = new Date(`${date}T00:00:00Z`);
    const dow = d.getUTCDay();
    const point: DayPoint = {
      date,
      label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
      full: `${DOW_SHORT[dow]}, ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`,
      tokens: 0,
      activeHours: 0,
      sessions: 0,
      peakConcurrent: 0,
      weekend: dow === 0 || dow === 6,
      hasData: Boolean(rows?.length),
    };
    if (!rows) return point;

    const peakByHour = new Map<string, number>();
    let weekendMs = 0;
    let activeMs = 0;
    for (const b of rows) {
      point.tokens += bucketTokens(b);
      point.activeHours += b.activeMs / MS_PER_HOUR;
      point.sessions += b.sessions;
      peakByHour.set(b.hourUtc, Math.max(peakByHour.get(b.hourUtc) ?? 0, b.peakConcurrent));
      weekendMs += b.weekendMs;
      activeMs += b.activeMs;
    }
    point.peakConcurrent = peakByHour.size ? Math.max(...peakByHour.values()) : 0;
    if (activeMs > 0) {
      point.weekend = weekendMs * 2 >= activeMs;
    }
    return point;
  });
}

export function heatmap(buckets: HourlyBucket[]): number[][] {
  const grid: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const b of buckets) {
    const dow = Math.min(6, Math.max(0, b.localDow | 0));
    const hour = Math.min(23, Math.max(0, b.localHour | 0));
    grid[dow]![hour] += b.activeMs / 60_000;
  }
  return grid.map((row) => row.map((v) => Math.round(v)));
}

export function mix(
  buckets: HourlyBucket[],
  field: "provider" | "model",
  minShare = 0.03,
): MixSlice[] {
  const byKey = new Map<string, { tokens: number; activeMs: number }>();
  let totalTokens = 0;
  let totalMs = 0;
  for (const b of buckets) {
    const k = ((field === "provider" ? b.provider : b.model) || "unknown").trim() || "unknown";
    const n = bucketTokens(b);
    const ms = b.activeMs || 0;
    const cur = byKey.get(k) ?? { tokens: 0, activeMs: 0 };
    cur.tokens += n;
    cur.activeMs += ms;
    byKey.set(k, cur);
    totalTokens += n;
    totalMs += ms;
  }
  if (totalTokens === 0 && totalMs === 0) return [];

  const kept: MixSlice[] = [];
  let otherTokens = 0;
  let otherMs = 0;
  for (const [key, v] of byKey) {
    const tokenShare = totalTokens > 0 ? v.tokens / totalTokens : 0;
    const timeShare = totalMs > 0 ? v.activeMs / totalMs : 0;
    if (tokenShare < minShare && timeShare < minShare) {
      otherTokens += v.tokens;
      otherMs += v.activeMs;
    } else {
      kept.push({
        key,
        tokens: v.tokens,
        share: tokenShare,
        activeMs: v.activeMs,
        timeShare,
      });
    }
  }
  kept.sort((a, b) => b.tokens - a.tokens || b.activeMs - a.activeMs);
  if (otherTokens > 0 || otherMs > 0) {
    kept.push({
      key: "Other",
      tokens: otherTokens,
      share: totalTokens > 0 ? otherTokens / totalTokens : 0,
      activeMs: otherMs,
      timeShare: totalMs > 0 ? otherMs / totalMs : 0,
    });
  }
  return kept;
}

export function projects(buckets: HourlyBucket[]): ProjectRow[] {
  const byKey = new Map<string, ProjectRow>();
  for (const b of buckets) {
    const key = b.projectKey || "(unlabelled)";
    let row = byKey.get(key);
    if (!row) {
      row = {
        projectKey: key, activeHours: 0, tokens: 0, sessions: 0,
        sessionsStarted: 0, sessionsStartedIncomplete: false,
      };
      byKey.set(key, row);
    }
    row.activeHours += b.activeMs / MS_PER_HOUR;
    row.tokens += bucketTokens(b);
    row.sessions += b.sessions;
    row.sessionsStarted! += b.sessionsStarted ?? 0;
    row.sessionsStartedIncomplete ||= startsUnknown(b);
  }
  return [...byKey.values()].sort((a, b) => b.activeHours - a.activeHours);
}

function idleDays(buckets: HourlyBucket[], days: number, end = new Date()): number {
  const active = new Set<string>();
  for (const b of buckets) if (b.activeMs > 0) active.add(b.hourUtc.slice(0, 10));
  return dayRange(days, end).filter((d) => !active.has(d)).length;
}

/** Local self-view — same fields TeamSelfView renders. */
export interface LocalSelfView {
  range: TeamRange;
  totals: Totals;
  daily: DayPoint[];
  heatmap: number[][];
  providerMix: MixSlice[];
  modelMix: MixSlice[];
  projects: ProjectRow[];
  flags: TeamFlags;
  /** True when no buckets exist in the full scan window (not just this range). */
  neverSynced: boolean;
  /** Newest bucket hour in the filtered set, if any. */
  lastBucketHour: string | null;
}

export function buildLocalSelfView(
  allBuckets: HourlyBucket[],
  range: TeamRange,
  now = new Date(),
): LocalSelfView {
  const days = RANGE_DAYS[range];
  const filtered = filterBucketsByRange(allBuckets, range, now);
  const t = totals(filtered);

  let lastBucketHour: string | null = null;
  for (const b of filtered) {
    if (!lastBucketHour || b.hourUtc > lastBucketHour) lastBucketHour = b.hourUtc;
  }

  // Previous window for after-hours delta on flags (same length, immediately prior).
  const since = hourFloorDaysAgo(days - 1, now);
  const prevUntil = since;
  const prevStartMs = Date.parse(`${prevUntil.slice(0, 10)}T00:00:00Z`) - days * 86_400_000;
  const prevSince = `${dateKey(new Date(prevStartMs))}T00`;
  const prevBuckets = allBuckets.filter(
    (b) => b.hourUtc >= prevSince && b.hourUtc < prevUntil,
  );
  const prevTotals = totals(prevBuckets);

  return {
    range,
    totals: t,
    daily: dailySeries(filtered, days, now),
    heatmap: heatmap(filtered),
    providerMix: mix(filtered, "provider"),
    modelMix: mix(filtered, "model"),
    projects: projects(filtered),
    flags: {
      afterHoursShare: t.afterHoursShare,
      afterHoursSharePrev: prevTotals.afterHoursShare,
      weekendShare: t.weekendShare,
      idleDays: idleDays(filtered, days, now),
    },
    neverSynced: allBuckets.length === 0,
    lastBucketHour,
  };
}
