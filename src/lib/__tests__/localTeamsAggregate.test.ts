import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildLocalSelfView,
  bucketTokens,
  filterBucketsByRange,
  mix,
  totals,
} from "../localTeamsAggregate";
import type { HourlyBucket } from "../teams";

afterEach(() => {
  vi.useRealTimers();
});

function bucket(partial: Partial<HourlyBucket> & { hourUtc: string }): HourlyBucket {
  return {
    hourUtc: partial.hourUtc,
    provider: partial.provider ?? "claude",
    model: partial.model ?? "claude-opus-4-6",
    projectKey: partial.projectKey ?? "agmux",
    tokensIn: partial.tokensIn ?? 1000,
    tokensOut: partial.tokensOut ?? 500,
    tokensCacheRead: partial.tokensCacheRead ?? 0,
    tokensCacheWrite: partial.tokensCacheWrite ?? 0,
    tokensReasoning: partial.tokensReasoning ?? 0,
    costUsd: partial.costUsd ?? 0.02,
    activeMs: partial.activeMs ?? 600_000,
    afterHoursMs: partial.afterHoursMs ?? 0,
    weekendMs: partial.weekendMs ?? 0,
    sessions: partial.sessions ?? 1,
    turns: partial.turns ?? 2,
    toolCalls: partial.toolCalls ?? 5,
    peakConcurrent: partial.peakConcurrent ?? 1,
    toolBash: partial.toolBash ?? 2,
    toolEdit: partial.toolEdit ?? 1,
    toolRead: partial.toolRead ?? 2,
    toolSearch: partial.toolSearch ?? 0,
    toolWeb: partial.toolWeb ?? 0,
    toolAgent: partial.toolAgent ?? 0,
    toolMcp: partial.toolMcp ?? 0,
    toolOther: partial.toolOther ?? 0,
    toolErrors: partial.toolErrors ?? 0,
    toolsMeasured: partial.toolsMeasured ?? 5,
    filesChanged: partial.filesChanged ?? 1,
    linesAdded: partial.linesAdded ?? 10,
    linesRemoved: partial.linesRemoved ?? 2,
    localHour: partial.localHour ?? 14,
    localDow: partial.localDow ?? 2,
  };
}

describe("bucketTokens", () => {
  it("sums in + out + cache (reasoning is subset of out — not added)", () => {
    expect(
      bucketTokens(
        bucket({
          hourUtc: "2026-08-01T12",
          tokensIn: 100,
          tokensOut: 50,
          tokensCacheRead: 20,
          tokensCacheWrite: 5,
          tokensReasoning: 10,
        }),
      ),
    ).toBe(175);
  });
});

describe("totals", () => {
  it("folds counters and derives cache hit / error rate", () => {
    const t = totals([
      bucket({
        hourUtc: "2026-08-01T10",
        tokensIn: 100,
        tokensCacheRead: 300,
        toolErrors: 1,
        toolsMeasured: 4,
        activeMs: 3_600_000,
        afterHoursMs: 1_800_000,
      }),
      bucket({
        hourUtc: "2026-08-01T11",
        tokensIn: 100,
        tokensCacheRead: 100,
        toolErrors: 0,
        toolsMeasured: 6,
        activeMs: 1_800_000,
        peakConcurrent: 3,
      }),
    ]);
    expect(t.sessions).toBe(2);
    expect(t.tokensIn).toBe(200);
    expect(t.tokensCacheRead).toBe(400);
    // cache hit = cacheRead / (in + cacheRead)
    expect(t.cacheHitRate).toBeCloseTo(400 / 600);
    expect(t.activeHours).toBeCloseTo(1.5);
    expect(t.afterHoursShare).toBeCloseTo(0.5 / 1.5);
    expect(t.peakConcurrent).toBe(3); // max, not sum
    expect(t.toolErrorRate).toBeCloseTo(1 / 10);
    expect(t.toolMix.bash).toBe(4);
    expect(t.daysWithData).toBe(1);
  });

  it("returns null toolErrorRate when nothing was measured", () => {
    const t = totals([
      bucket({ hourUtc: "2026-08-01T10", toolsMeasured: 0, toolErrors: 0, toolCalls: 3 }),
    ]);
    expect(t.toolErrorRate).toBeNull();
  });
});

describe("filterBucketsByRange", () => {
  it("keeps only buckets inside the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T12:00:00Z"));
    const all = [
      bucket({ hourUtc: "2026-07-01T10" }), // outside 7d
      bucket({ hourUtc: "2026-08-05T10" }),
      bucket({ hourUtc: "2026-08-06T08" }),
    ];
    const week = filterBucketsByRange(all, "7d");
    expect(week.map((b) => b.hourUtc)).toEqual(["2026-08-05T10", "2026-08-06T08"]);
  });
});

describe("mix", () => {
  it("folds slivers under 3% into Other", () => {
    const slices = mix(
      [
        bucket({ hourUtc: "2026-08-01T10", provider: "claude", tokensIn: 9700, tokensOut: 0, activeMs: 0 }),
        bucket({ hourUtc: "2026-08-01T11", provider: "codex", tokensIn: 200, tokensOut: 0, activeMs: 0 }),
        bucket({ hourUtc: "2026-08-01T12", provider: "tiny", tokensIn: 100, tokensOut: 0, activeMs: 0 }),
      ],
      "provider",
    );
    expect(slices[0]?.key).toBe("claude");
    expect(slices.some((s) => s.key === "Other")).toBe(true);
    expect(slices.find((s) => s.key === "tiny")).toBeUndefined();
  });

  it("keeps a slice that is small in tokens but large in time", () => {
    const slices = mix(
      [
        bucket({
          hourUtc: "2026-08-01T10",
          provider: "claude",
          tokensIn: 9800,
          tokensOut: 0,
          activeMs: 1_000,
        }),
        bucket({
          hourUtc: "2026-08-01T11",
          provider: "codex",
          tokensIn: 200,
          tokensOut: 0,
          activeMs: 9_000,
        }),
      ],
      "provider",
    );
    expect(slices.map((s) => s.key)).toEqual(["claude", "codex"]);
    expect(slices.find((s) => s.key === "codex")?.timeShare).toBeCloseTo(0.9);
  });
});

describe("buildLocalSelfView", () => {
  it("marks neverSynced when the scan is empty", () => {
    const view = buildLocalSelfView([], "30d", new Date("2026-08-06T12:00:00Z"));
    expect(view.neverSynced).toBe(true);
    expect(view.totals.daysWithData).toBe(0);
    expect(view.daily).toHaveLength(30);
  });

  it("builds a self-view shaped like TeamSelfView data", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T12:00:00Z"));
    const view = buildLocalSelfView(
      [
        bucket({
          hourUtc: "2026-08-05T14",
          provider: "claude",
          model: "claude-opus-4-6",
          projectKey: "agmux",
        }),
        bucket({
          hourUtc: "2026-08-06T09",
          provider: "codex",
          model: "gpt-5.3-codex",
          projectKey: "other",
          tokensIn: 2000,
        }),
      ],
      "7d",
    );
    expect(view.neverSynced).toBe(false);
    expect(view.range).toBe("7d");
    expect(view.daily).toHaveLength(7);
    expect(view.totals.sessions).toBe(2);
    expect(view.providerMix.length).toBeGreaterThan(0);
    expect(view.projects.map((p) => p.projectKey).sort()).toEqual(["agmux", "other"]);
    expect(view.lastBucketHour).toBe("2026-08-06T09");
    expect(view.heatmap).toHaveLength(7);
    expect(view.heatmap[0]).toHaveLength(24);
  });
});
