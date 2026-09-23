/**
 * Pure leaderboard scoring — week bounds, size tiers, points, ranks.
 * No I/O. Token denominator matches aggregate.bucketTokens.
 *
 * NenuAI orgs use complexity points (XS–XXL from GitHub Project Size) instead
 * of line-count S/M/L weights for opened PRs. See isComplexityOrg().
 */

export type SizeTier = "small" | "medium" | "large";

/** Scoring UI/mode: line-count tiers (default) vs Nenu complexity points. */
export type ScoringMode = "lines" | "complexity";

export interface LeaderboardWeights {
  small: number;
  medium: number;
  large: number;
  merge: number;
}

export interface LeaderboardThresholds {
  /** lines <= smallMax → small */
  smallMax: number;
  /** smallMax < lines <= mediumMax → medium; else large */
  mediumMax: number;
}

export const DEFAULT_WEIGHTS: LeaderboardWeights = {
  small: 1,
  medium: 2,
  large: 4,
  merge: 0.5,
};

export const DEFAULT_THRESHOLDS: LeaderboardThresholds = {
  smallMax: 100,
  mediumMax: 500,
};

/**
 * NenuAI complexity scale (must match developer/plugins/pm-tools COMPLEXITY_WEIGHT).
 * Source of truth at sync: GitHub Project #5 "Size" field on each PR.
 */
export const COMPLEXITY_POINTS: Record<string, number> = {
  XS: 1,
  S: 2,
  M: 4,
  L: 8,
  XL: 16,
  XXL: 32,
};

/** Org logins that use Project Size → complexity points instead of LOC tiers. */
const COMPLEXITY_ORGS = new Set(["nenuai"]);

export function isComplexityOrg(orgLogin: string | null | undefined): boolean {
  return COMPLEXITY_ORGS.has((orgLogin ?? "").trim().toLowerCase());
}

/** Map a board Size label (any case) to complexity points, or null if unknown. */
export function complexityPointsFromSize(size: string | null | undefined): number | null {
  const key = (size ?? "").trim().toUpperCase();
  if (!key) return null;
  const pts = COMPLEXITY_POINTS[key];
  return pts !== undefined ? pts : null;
}

export interface PrForScore {
  authorGithubId: string;
  openedAt: string; // ISO
  mergedAt: string | null;
  sizeTier: SizeTier;
  isBot: boolean;
  /**
   * When set (Nenu Project Size), open-window credit uses this value instead of
   * weight[sizeTier]. null/undefined → fall back to line-count tier weights.
   */
  complexityPoints?: number | null;
}

export interface EligibleMember {
  userId: string;
  displayName: string;
  handle: string | null;
  githubId: string;
  githubLogin: string | null;
  tokens: number;
  /** Teams estimated cost for the week (metric_hourly.cost_usd). */
  costUsd: number;
  costIncomplete?: boolean;
}

export interface RankedRow {
  rank: number | null;
  userId: string;
  displayName: string;
  handle: string | null;
  githubLogin: string | null;
  prSmall: number;
  prMedium: number;
  prLarge: number;
  /** Opened PRs in the week (all tiers). */
  prOpened: number;
  prMerged: number;
  points: number;
  tokens: number;
  costUsd: number;
  costIncomplete?: boolean;
  /** Tokens spent per PR point — lower is more efficient. */
  tokensPerPoint: number;
  /** Estimated $ per PR point — lower is more efficient (≈ $/pt). */
  costPerPoint: number | null;
}

export interface ScoreResult {
  rows: RankedRow[];
  excludedNoTokens: Array<{
    userId: string;
    displayName: string;
    handle: string | null;
    githubLogin: string | null;
    points: number;
  }>;
  memberCountEligible: number;
  memberCountRanked: number;
}

/** ISO week Monday 00:00 UTC → next Monday 00:00 UTC (end exclusive). */
export function weekBounds(weekId: string): { start: string; end: string } {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekId);
  if (!m) throw new Error(`Invalid ISO week id: ${weekId}`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) throw new Error(`Invalid ISO week id: ${weekId}`);

  // ISO week 1 is the week with the year's first Thursday.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const day = jan4.getUTCDay() || 7; // Mon=1 … Sun=7
  const week1Mon = new Date(jan4);
  week1Mon.setUTCDate(jan4.getUTCDate() - (day - 1));
  const start = new Date(week1Mon);
  start.setUTCDate(week1Mon.getUTCDate() + (week - 1) * 7);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** ISO week id for `date` shifted by `offsetWeeks` (UTC calendar). */
export function isoWeekId(date = new Date(), offsetWeeks = 0): string {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  target.setUTCDate(target.getUTCDate() + offsetWeeks * 7);
  const d = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export function sizeTier(lines: number, thresholds: LeaderboardThresholds = DEFAULT_THRESHOLDS): SizeTier {
  const n = Math.max(0, Math.trunc(lines));
  if (n <= thresholds.smallMax) return "small";
  if (n <= thresholds.mediumMax) return "medium";
  return "large";
}

export function inRange(iso: string | null | undefined, start: string, end: string): boolean {
  if (!iso) return false;
  return iso >= start && iso < end;
}

/**
 * Scorable window for sync: current ∪ previous ISO week.
 * A PR is relevant if opened_at or merged_at falls in that window.
 */
export function scorableWindow(now = new Date()): { start: string; end: string; weeks: [string, string] } {
  const current = isoWeekId(now, 0);
  const previous = isoWeekId(now, -1);
  const cur = weekBounds(current);
  const prev = weekBounds(previous);
  return {
    start: prev.start < cur.start ? prev.start : cur.start,
    end: cur.end > prev.end ? cur.end : prev.end,
    weeks: [current, previous],
  };
}

export function prRelevantToWindow(
  pr: { openedAt: string; mergedAt: string | null },
  start: string,
  end: string,
): boolean {
  return inRange(pr.openedAt, start, end) || inRange(pr.mergedAt, start, end);
}

/** Open-window point credit for one PR (complexity points win over LOC tier). */
export function openPointsForPr(pr: PrForScore, weights: LeaderboardWeights): number {
  if (pr.complexityPoints != null && Number.isFinite(pr.complexityPoints) && pr.complexityPoints > 0) {
    return pr.complexityPoints;
  }
  if (pr.sizeTier === "small") return weights.small;
  if (pr.sizeTier === "medium") return weights.medium;
  return weights.large;
}

export function scoreWeek(
  members: EligibleMember[],
  prs: PrForScore[],
  weekStart: string,
  weekEnd: string,
  weights: LeaderboardWeights = DEFAULT_WEIGHTS,
): ScoreResult {
  const byGithub = new Map(members.map((m) => [m.githubId, m]));
  const stats = new Map<
    string,
    {
      small: number;
      medium: number;
      large: number;
      opened: number;
      openPoints: number;
      merged: number;
    }
  >();

  for (const m of members) {
    stats.set(m.userId, { small: 0, medium: 0, large: 0, opened: 0, openPoints: 0, merged: 0 });
  }

  for (const pr of prs) {
    if (pr.isBot) continue;
    const member = byGithub.get(pr.authorGithubId);
    if (!member) continue;
    const s = stats.get(member.userId)!;
    if (inRange(pr.openedAt, weekStart, weekEnd)) {
      s.opened += 1;
      s.openPoints += openPointsForPr(pr, weights);
      if (pr.sizeTier === "small") s.small += 1;
      else if (pr.sizeTier === "medium") s.medium += 1;
      else s.large += 1;
    }
    if (inRange(pr.mergedAt, weekStart, weekEnd)) s.merged += 1;
  }

  const ranked: RankedRow[] = [];
  const excludedNoTokens: ScoreResult["excludedNoTokens"] = [];

  for (const m of members) {
    const s = stats.get(m.userId)!;
    const points = s.openPoints + s.merged * weights.merge;

    if (points <= 0) continue;

    if (!(m.tokens > 0)) {
      excludedNoTokens.push({
        userId: m.userId,
        displayName: m.displayName,
        handle: m.handle,
        githubLogin: m.githubLogin,
        points,
      });
      continue;
    }

    ranked.push({
      rank: 0,
      userId: m.userId,
      displayName: m.displayName,
      handle: m.handle,
      githubLogin: m.githubLogin,
      prSmall: s.small,
      prMedium: s.medium,
      prLarge: s.large,
      prOpened: s.opened,
      prMerged: s.merged,
      points,
      tokens: m.tokens,
      costUsd: m.costUsd > 0 ? m.costUsd : 0,
      tokensPerPoint: m.tokens / points,
      costIncomplete: m.costIncomplete !== false,
      costPerPoint: m.costIncomplete === false ? (m.costUsd > 0 ? m.costUsd : 0) / points : null,
    });
  }

  // Lower cost/pt wins (≈ $/pt). Tie-break: lower tokens/pt, then more points.
  ranked.sort((a, b) => {
    if (a.costPerPoint === null || b.costPerPoint === null) {
      if (a.costPerPoint !== b.costPerPoint) return a.costPerPoint === null ? 1 : -1;
      return a.displayName.localeCompare(b.displayName);
    }
    if (a.costPerPoint !== b.costPerPoint) return a.costPerPoint - b.costPerPoint;
    if (a.tokensPerPoint !== b.tokensPerPoint) return a.tokensPerPoint - b.tokensPerPoint;
    if (b.points !== a.points) return b.points - a.points;
    return a.displayName.localeCompare(b.displayName);
  });
  ranked.forEach((r, i) => {
    r.rank = r.costPerPoint === null ? null : i + 1;
  });

  return {
    rows: ranked,
    excludedNoTokens,
    memberCountEligible: members.length,
    memberCountRanked: ranked.filter((r) => r.rank !== null).length,
  };
}

export function validateThresholds(smallMax: number, mediumMax: number): string | null {
  if (!Number.isFinite(smallMax) || !Number.isFinite(mediumMax)) return "Thresholds must be numbers.";
  if (smallMax < 0 || mediumMax < 0) return "Thresholds cannot be negative.";
  if (Math.trunc(smallMax) !== smallMax || Math.trunc(mediumMax) !== mediumMax) {
    return "Thresholds must be whole numbers.";
  }
  if (smallMax > mediumMax) return "Small max cannot exceed medium max.";
  return null;
}

export function validateWeights(w: LeaderboardWeights): string | null {
  for (const [k, v] of Object.entries(w)) {
    if (!Number.isFinite(v) || v < 0) return `Weight ${k} must be a non-negative number.`;
  }
  return null;
}
