/**
 * Pure aggregation: hourly buckets → the exact shapes the dashboards render.
 * No I/O here on purpose — every function in this file is unit-testable.
 *
 * Design contract carried through: a bucket that does not exist is *absent*,
 * not zero. Callers distinguish "no data yet" from "zero activity" using
 * `daysWithData`, and charts break their line rather than interpolate.
 */

export interface Bucket {
  user_id: string;
  hour_utc: string; // 'YYYY-MM-DDTHH'
  provider: string;
  model: string;
  project_key: string;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  tokens_reasoning: number;
  cost_usd: number;
  /** Absent in older fixtures/records means unknown, not complete. */
  cost_incomplete?: number;
  active_ms: number;
  after_hours_ms: number;
  weekend_ms: number;
  /** Sessions active in this hour; summing gives session-hours. */
  sessions: number;
  /** Top-level sessions started in this bucket. Null: older desktop, unknown. */
  sessions_started?: number | null;
  turns: number;
  tool_calls: number;
  peak_concurrent: number;
  tool_bash: number;
  tool_edit: number;
  tool_read: number;
  tool_search: number;
  tool_web: number;
  tool_agent: number;
  tool_mcp: number;
  tool_other: number;
  tool_errors: number;
  tools_measured: number;
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  approval_requests: number;
  approval_wait_ms: number;
  local_hour: number;
  local_dow: number;
}

/** The tool taxonomy, in the order dashboards render it. */
export const TOOL_KINDS = [
  { key: "bash", column: "tool_bash", label: "Terminal" },
  { key: "edit", column: "tool_edit", label: "Edits" },
  { key: "read", column: "tool_read", label: "Reads" },
  { key: "search", column: "tool_search", label: "Search" },
  { key: "web", column: "tool_web", label: "Web" },
  { key: "agent", column: "tool_agent", label: "Subagents" },
  { key: "mcp", column: "tool_mcp", label: "MCP" },
  { key: "other", column: "tool_other", label: "Other" },
] as const satisfies ReadonlyArray<{
  key: string;
  column: keyof Bucket;
  label: string;
}>;

export type RangeKey = "7d" | "14d" | "30d" | "90d";

export const RANGE_DAYS: Record<RangeKey, number> = {
  "7d": 7,
  "14d": 14,
  "30d": 30,
  "90d": 90,
};

/** Human labels for the range segment control. */
export const RANGE_LABELS: Record<RangeKey, string> = {
  "7d": "7 days",
  "14d": "14 days",
  "30d": "30 days",
  "90d": "90 days",
};

export function isRangeKey(v: string): v is RangeKey {
  return v === "7d" || v === "14d" || v === "30d" || v === "90d";
}

/** Inclusive window the dashboard is currently showing. */
export interface TimeWindow {
  /** Preset key, or `"custom"` when from/to were supplied. */
  range: RangeKey | "custom";
  /** Inclusive day count covered by the window. */
  days: number;
  /** Inclusive start as `YYYY-MM-DDTHH` (hour 00 of the first day). */
  sinceHour: string;
  /** Exclusive end as `YYYY-MM-DDTHH`, or null for "now". */
  untilHour: string | null;
  /** Last calendar day in the window (UTC), used for daily series alignment. */
  endDate: Date;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Build a window from a preset key (relative to now). */
export function windowFromRange(range: RangeKey, now = new Date()): TimeWindow {
  const days = RANGE_DAYS[range];
  return {
    range,
    days,
    sinceHour: hourFloorDaysAgo(days, now),
    untilHour: null,
    endDate: now,
  };
}

/**
 * Build a window from inclusive `from`/`to` (YYYY-MM-DD). Returns null when
 * the dates are malformed, inverted, empty, or longer than a year.
 */
export function windowFromDates(
  from: string,
  to: string,
  // Accepted for symmetry with windowFromRange; the bounds here come entirely
  // from the supplied dates, so it is deliberately unused.
  _now = new Date(),
): TimeWindow | null {
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || from > to) return null;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const days = Math.floor((end - start) / 86_400_000) + 1;
  if (days < 1 || days > 366) return null;
  // Cap the exclusive end at tomorrow-of-`to`, but never past "now" for the
  // previous-period math (daily series still covers every day in [from, to]).
  const nextDay = new Date(end + 86_400_000);
  const untilHour = `${dateKey(nextDay)}T00`;
  return {
    range: "custom",
    days,
    sinceHour: `${from}T00`,
    untilHour,
    endDate: new Date(`${to}T12:00:00Z`),
  };
}

/** Inclusive lower bound as an 'YYYY-MM-DDTHH' hour key, N calendar days ago. */
export function hourFloorDaysAgo(daysAgo: number, now = new Date()): string {
  const d = new Date(now.getTime() - daysAgo * 86_400_000);
  return `${d.toISOString().slice(0, 10)}T00`;
}

/** Same-length window immediately before `win` — for period-over-period deltas. */
export function previousWindow(win: TimeWindow): { sinceHour: string; untilHour: string } {
  // untilHour of the previous window = sinceHour of the current one.
  const until = win.sinceHour;
  // Walk back `days` from the current start.
  const startMs = Date.parse(`${until.slice(0, 10)}T00:00:00Z`) - win.days * 86_400_000;
  const since = `${dateKey(new Date(startMs))}T00`;
  return { sinceHour: since, untilHour: until };
}

export const MS_PER_HOUR = 3_600_000;

/**
 * Total tokens for dashboards: pure in + out + cache read/write.
 * `tokens_reasoning` is a subset of output (OpenAI) — never add it again.
 */
/** An active bucket whose uploader predates session-start counting. */
const startsUnknown = (b: Bucket): boolean => b.sessions > 0 && b.sessions_started == null;

export const bucketTokens = (b: Bucket): number =>
  b.tokens_in + b.tokens_out + b.tokens_cache_read + b.tokens_cache_write;

export interface Totals {
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  tokensReasoning: number;
  tokens: number;
  cacheHitRate: number; // 0–1; share of input that came from cache
  costUsd: number;
  costIncomplete: boolean;
  activeHours: number;
  afterHoursShare: number; // 0–1
  weekendShare: number; // 0–1
  /** Session-hours: sessions active per hour, summed. Denominator for ratios. */
  sessions: number;
  /** Distinct top-level sessions started in the range (subagents excluded). */
  sessionsStarted: number;
  /** Some active hours came from a desktop that did not report starts. */
  sessionsStartedIncomplete: boolean;
  turns: number;
  toolCalls: number;
  peakConcurrent: number;
  daysWithData: number;
  /** Tool calls per kind, keyed by `TOOL_KINDS[].key`. */
  toolMix: Record<string, number>;
  toolErrors: number;
  /**
   * Calls whose success or failure the provider actually reported. Codex does
   * not report one for most calls, so this is smaller than `toolCalls`.
   */
  toolsMeasured: number;
  /**
   * Failure rate over `toolsMeasured`, or null when nothing was measurable.
   * Null means "we can't tell", which the UI must render as such rather than
   * as a reassuring 0%.
   */
  toolErrorRate: number | null;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  approvalRequests: number;
  /** Total blocked wall-clock hours waiting on human approval. */
  approvalWaitHours: number;
  /** Mean wait seconds per approval (null when none). */
  meanApprovalWaitSec: number | null;
}

export function totals(buckets: Bucket[]): Totals {
  const t: Totals = {
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    tokensReasoning: 0,
    tokens: 0,
    cacheHitRate: 0,
    costUsd: 0,
    costIncomplete: false,
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
    toolMix: Object.fromEntries(TOOL_KINDS.map((k) => [k.key, 0])),
    toolErrors: 0,
    toolsMeasured: 0,
    toolErrorRate: null,
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    approvalRequests: 0,
    approvalWaitHours: 0,
    meanApprovalWaitSec: null,
  };

  let activeMs = 0;
  let afterHoursMs = 0;
  let weekendMs = 0;
  const days = new Set<string>();
  // Concurrency is a max, not a sum — two devices in the same hour do not add.
  const peakByHour = new Map<string, number>();

  for (const b of buckets) {
    t.tokensIn += b.tokens_in;
    t.tokensOut += b.tokens_out;
    t.tokensCacheRead += b.tokens_cache_read;
    t.tokensCacheWrite += b.tokens_cache_write;
    t.tokensReasoning += b.tokens_reasoning;
    t.costUsd += b.cost_usd;
    t.costIncomplete ||= b.cost_incomplete !== 0;
    t.sessions += b.sessions;
    t.sessionsStarted += b.sessions_started ?? 0;
    t.sessionsStartedIncomplete ||= startsUnknown(b);
    t.turns += b.turns;
    t.toolCalls += b.tool_calls;
    for (const kind of TOOL_KINDS) {
      t.toolMix[kind.key] += (b[kind.column] as number) ?? 0;
    }
    t.toolErrors += b.tool_errors ?? 0;
    t.toolsMeasured += b.tools_measured ?? 0;
    t.filesChanged += b.files_changed ?? 0;
    t.linesAdded += b.lines_added ?? 0;
    t.linesRemoved += b.lines_removed ?? 0;
    t.approvalRequests += b.approval_requests ?? 0;
    t.approvalWaitHours += (b.approval_wait_ms ?? 0) / MS_PER_HOUR;
    activeMs += b.active_ms;
    afterHoursMs += b.after_hours_ms;
    weekendMs += b.weekend_ms;
    if (b.active_ms > 0 || b.sessions > 0) days.add(b.hour_utc.slice(0, 10));
    peakByHour.set(b.hour_utc, Math.max(peakByHour.get(b.hour_utc) ?? 0, b.peak_concurrent));
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
  // Null, not zero: "no measurable calls" is not "no failures".
  t.toolErrorRate = t.toolsMeasured > 0 ? t.toolErrors / t.toolsMeasured : null;
  t.meanApprovalWaitSec =
    t.approvalRequests > 0
      ? (t.approvalWaitHours * 3600) / t.approvalRequests
      : null;
  return t;
}

export interface DayPoint {
  date: string; // YYYY-MM-DD
  label: string; // M/D
  full: string; // 'Mon, Jul 21'
  tokens: number;
  activeHours: number;
  sessions: number;
  sessionsStarted: number;
  sessionsStartedIncomplete: boolean;
  peakConcurrent: number;
  weekend: boolean;
  /** False when no bucket exists for this day — the chart breaks the line. */
  hasData: boolean;
}

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** UTC date arithmetic only — no locale surprises on the server. */
export function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function dayRange(days: number, end = new Date()): string[] {
  const out: string[] = [];
  const base = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  for (let i = days - 1; i >= 0; i--) out.push(dateKey(new Date(base - i * 86_400_000)));
  return out;
}

export function dailySeries(buckets: Bucket[], days: number, end = new Date()): DayPoint[] {
  const byDay = new Map<string, Bucket[]>();
  for (const b of buckets) {
    const k = b.hour_utc.slice(0, 10);
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
      sessionsStarted: 0,
      sessionsStartedIncomplete: false,
      peakConcurrent: 0,
      // Prefer the member-local weekend signal when we have buckets: a Tokyo
      // Saturday morning is still Friday UTC and must not be shaded as a weekday.
      weekend: dow === 0 || dow === 6,
      hasData: Boolean(rows?.length),
    };
    if (!rows) return point;

    const peakByHour = new Map<string, number>();
    let weekendMs = 0;
    let activeMs = 0;
    for (const b of rows) {
      point.tokens += bucketTokens(b);
      point.activeHours += b.active_ms / MS_PER_HOUR;
      point.sessions += b.sessions;
      point.sessionsStarted += b.sessions_started ?? 0;
      point.sessionsStartedIncomplete ||= startsUnknown(b);
      peakByHour.set(b.hour_utc, Math.max(peakByHour.get(b.hour_utc) ?? 0, b.peak_concurrent));
      weekendMs += b.weekend_ms;
      activeMs += b.active_ms;
    }
    point.peakConcurrent = peakByHour.size ? Math.max(...peakByHour.values()) : 0;
    if (activeMs > 0) {
      // Majority of active time fell on Sat/Sun in the member's IANA zone.
      point.weekend = weekendMs * 2 >= activeMs;
    }
    return point;
  });
}

/** 7 rows (Mon…Sun) × 24 cols of active minutes, in the member's local time. */
export function heatmap(buckets: Bucket[]): number[][] {
  const grid: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const b of buckets) {
    const dow = Math.min(6, Math.max(0, b.local_dow | 0));
    const hour = Math.min(23, Math.max(0, b.local_hour | 0));
    grid[dow]![hour] += b.active_ms / 60_000;
  }
  return grid.map((row) => row.map((v) => Math.round(v)));
}

export interface MixSlice {
  key: string;
  tokens: number;
  share: number; // 0–1 of tokens
  activeMs: number;
  timeShare: number; // 0–1 of active time
}

/**
 * Share of tokens *and* active time by `field`, sorted descending by tokens.
 * Every used provider stays visible, including occasional usage. Model slices
 * under 3% of both metrics are folded into "Other" to keep the long tail short.
 */
export function mix(
  buckets: Bucket[],
  field: "provider" | "model",
  minShare = field === "provider" ? 0 : 0.03,
): MixSlice[] {
  const byKey = new Map<string, { tokens: number; activeMs: number }>();
  let totalTokens = 0;
  let totalMs = 0;
  for (const b of buckets) {
    const k = (b[field] || "unknown").trim() || "unknown";
    const n = bucketTokens(b);
    const ms = b.active_ms || 0;
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
    if (v.tokens === 0 && v.activeMs === 0) continue;
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

export interface ProjectRow {
  projectKey: string;
  activeHours: number;
  tokens: number;
  sessions: number;
  sessionsStarted: number;
  sessionsStartedIncomplete: boolean;
}

export function projects(buckets: Bucket[]): ProjectRow[] {
  const byKey = new Map<string, ProjectRow>();
  for (const b of buckets) {
    const key = b.project_key || "(unlabelled)";
    let row = byKey.get(key);
    if (!row) {
      row = {
        projectKey: key, activeHours: 0, tokens: 0, sessions: 0,
        sessionsStarted: 0, sessionsStartedIncomplete: false,
      };
      byKey.set(key, row);
    }
    row.activeHours += b.active_ms / MS_PER_HOUR;
    row.tokens += bucketTokens(b);
    row.sessions += b.sessions;
    row.sessionsStarted += b.sessions_started ?? 0;
    row.sessionsStartedIncomplete ||= startsUnknown(b);
  }
  return [...byKey.values()].sort((a, b) => b.activeHours - a.activeHours);
}

/** Days in the window where the member had zero activity but was a member. */
export function idleDays(buckets: Bucket[], days: number, end = new Date()): number {
  const active = new Set<string>();
  for (const b of buckets) if (b.active_ms > 0) active.add(b.hour_utc.slice(0, 10));
  return dayRange(days, end).filter((d) => !active.has(d)).length;
}

export interface MemberSummary {
  userId: string;
  totals: Totals;
  /** True when the member has joined but no bucket has ever arrived. */
  neverSynced: boolean;
}

export function perMember(buckets: Bucket[], memberIds: string[]): MemberSummary[] {
  const byUser = new Map<string, Bucket[]>();
  for (const b of buckets) {
    const list = byUser.get(b.user_id);
    if (list) list.push(b);
    else byUser.set(b.user_id, [b]);
  }
  return memberIds.map((userId) => {
    const rows = byUser.get(userId) ?? [];
    return { userId, totals: totals(rows), neverSynced: rows.length === 0 };
  });
}

/** A month's spend measured against the team's budget. */
export interface BudgetStatus {
  /** Completeness of recorded cost estimates, not invoice verification. */
  costIncomplete?: boolean;
  month: string; // 'YYYY-MM'
  monthlyUsd: number;
  spendUsd: number;
  /** 0–1+, spend as a share of budget. Can exceed 1. */
  usedShare: number;
  /** Straight-line projection for the full month, from the run rate so far. */
  projectedUsd: number;
  projectedShare: number;
  daysElapsed: number;
  daysInMonth: number;
  /** True once the projection exceeds the budget. */
  onTrackToExceed: boolean;
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * Projects month-end spend from the run rate so far.
 *
 * Deliberately a straight line rather than anything cleverer: a manager can
 * check it in their head, and a forecast nobody can verify is a forecast nobody
 * trusts. The elapsed-day count includes today as a whole day, because a
 * part-day would divide by a tiny number early in the month and project wild
 * numbers on day one.
 */
export function budgetStatus(
  monthlyUsd: number,
  spendUsd: number,
  now = new Date(),
): BudgetStatus {
  const year = now.getUTCFullYear();
  const month1 = now.getUTCMonth() + 1;
  const total = daysInMonth(year, month1);
  const elapsed = Math.min(total, Math.max(1, now.getUTCDate()));

  const projected = total > 0 ? (spendUsd / elapsed) * total : spendUsd;
  const share = monthlyUsd > 0 ? spendUsd / monthlyUsd : 0;
  const projectedShare = monthlyUsd > 0 ? projected / monthlyUsd : 0;

  return {
    month: `${year}-${String(month1).padStart(2, "0")}`,
    monthlyUsd,
    spendUsd,
    usedShare: share,
    projectedUsd: projected,
    projectedShare,
    daysElapsed: elapsed,
    daysInMonth: total,
    onTrackToExceed: monthlyUsd > 0 && projected > monthlyUsd,
  };
}

/** Percentage delta vs a previous period. Null when there is no baseline. */
export function delta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}
