import { describe, expect, it } from "vitest";
import {
  MS_PER_HOUR,
  dailySeries,
  dayRange,
  delta,
  heatmap,
  idleDays,
  mix,
  perMember,
  previousWindow,
  projects,
  totals,
  windowFromDates,
  windowFromRange,
  type Bucket,
} from "../src/aggregate";

const b = (over: Partial<Bucket> = {}): Bucket => ({
  user_id: "u1",
  hour_utc: "2026-07-29T14",
  provider: "ClaudeCode",
  model: "opus-5",
  project_key: "helios-api",
  tokens_in: 0,
  tokens_out: 0,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
  tokens_reasoning: 0,
  cost_usd: 0,
  active_ms: 0,
  after_hours_ms: 0,
  weekend_ms: 0,
  sessions: 0,
  turns: 0,
  tool_calls: 0,
  peak_concurrent: 0,
  tool_bash: 0,
  tool_edit: 0,
  tool_read: 0,
  tool_search: 0,
  tool_web: 0,
  tool_agent: 0,
  tool_mcp: 0,
  tool_other: 0,
  tool_errors: 0,
  tools_measured: 0,
  files_changed: 0,
  lines_added: 0,
  lines_removed: 0,
  approval_requests: 0,
  approval_wait_ms: 0,
  local_hour: 14,
  local_dow: 2,
  ...over,
});

const END = new Date("2026-07-29T12:00:00Z");

describe("totals", () => {
  it("sums counters and derives rates", () => {
    const t = totals([
      b({ tokens_in: 1000, tokens_out: 500, tokens_cache_read: 3000, cost_usd: 1.5, turns: 10 }),
      b({ hour_utc: "2026-07-29T15", tokens_in: 1000, tokens_cache_read: 1000, turns: 10 }),
    ]);
    expect(t.tokens).toBe(6500);
    expect(t.costUsd).toBeCloseTo(1.5);
    // cache hit is measured against the input side only, not total tokens
    expect(t.cacheHitRate).toBeCloseTo(4000 / 6000);
  });

  it("takes the max of peak concurrency, never the sum", () => {
    // Two providers inside the same hour describe the same 3 live sessions.
    const t = totals([
      b({ peak_concurrent: 3 }),
      b({ provider: "Codex", peak_concurrent: 2 }),
      b({ hour_utc: "2026-07-29T15", peak_concurrent: 5 }),
    ]);
    expect(t.peakConcurrent).toBe(5);
  });

  it("reports zero rates rather than NaN when there is no activity", () => {
    const t = totals([]);
    expect(t.cacheHitRate).toBe(0);
    expect(t.afterHoursShare).toBe(0);
    expect(t.daysWithData).toBe(0);
  });

  it("computes after-hours as a share of active time", () => {
    const t = totals([b({ active_ms: 10 * MS_PER_HOUR, after_hours_ms: 2 * MS_PER_HOUR })]);
    expect(t.activeHours).toBe(10);
    expect(t.afterHoursShare).toBeCloseTo(0.2);
  });

  it("sums the tool mix and the output counters", () => {
    const t = totals([
      b({ tool_bash: 3, tool_edit: 2, tool_mcp: 1, files_changed: 2, lines_added: 40, lines_removed: 8 }),
      b({ hour_utc: "2026-07-29T15", tool_bash: 1, tool_read: 5, lines_added: 10 }),
    ]);
    expect(t.toolMix.bash).toBe(4);
    expect(t.toolMix.edit).toBe(2);
    expect(t.toolMix.read).toBe(5);
    expect(t.toolMix.mcp).toBe(1);
    expect(t.filesChanged).toBe(2);
    expect(t.linesAdded).toBe(50);
    expect(t.linesRemoved).toBe(8);
  });

  it("divides the error rate by measured calls, not by all tool calls", () => {
    // 100 calls were made but only 20 reported an outcome, 4 of them failures.
    // The honest answer is 20%, not 4%.
    const t = totals([b({ tool_calls: 100, tool_bash: 100, tool_errors: 4, tools_measured: 20 })]);
    expect(t.toolErrorRate).toBeCloseTo(0.2);
  });

  it("reports an unknown error rate as null, never as a reassuring zero", () => {
    // Codex-only activity: tool calls happened, no outcome was observable.
    const t = totals([b({ tool_calls: 50, tool_bash: 50, tool_errors: 0, tools_measured: 0 })]);
    expect(t.toolErrorRate).toBeNull();
    expect(totals([]).toolErrorRate).toBeNull();
  });
});

describe("dailySeries", () => {
  it("emits one point per day in the range, oldest first", () => {
    const s = dailySeries([], 7, END);
    expect(s).toHaveLength(7);
    expect(s[0]!.date).toBe("2026-07-23");
    expect(s[6]!.date).toBe("2026-07-29");
  });

  it("marks days with no bucket as hasData:false so the chart breaks the line", () => {
    const s = dailySeries([b({ hour_utc: "2026-07-29T14", active_ms: MS_PER_HOUR })], 3, END);
    expect(s.map((p) => p.hasData)).toEqual([false, false, true]);
    // Absent is not the same as zero — the zero days carry no fabricated value.
    expect(s[0]!.tokens).toBe(0);
    expect(s[2]!.activeHours).toBe(1);
  });

  it("flags weekends", () => {
    const s = dailySeries([], 7, END);
    const weekendDates = s.filter((p) => p.weekend).map((p) => p.date);
    expect(weekendDates).toEqual(["2026-07-25", "2026-07-26"]);
  });

  it("prefers member-local weekend_ms over the UTC calendar day", () => {
    // 2026-07-29 is a Wednesday UTC. If most active time was local weekend
    // (e.g. Tokyo Saturday morning still stamped as Friday/Wednesday UTC),
    // the day chart must still shade as weekend.
    const s = dailySeries(
      [
        b({
          hour_utc: "2026-07-29T14",
          active_ms: MS_PER_HOUR,
          weekend_ms: MS_PER_HOUR,
          local_dow: 5,
        }),
      ],
      1,
      END,
    );
    expect(s[0]!.weekend).toBe(true);
  });

  it("aggregates several buckets within a day", () => {
    const s = dailySeries(
      [
        b({ hour_utc: "2026-07-29T09", tokens_in: 100, active_ms: MS_PER_HOUR, sessions: 1 }),
        b({ hour_utc: "2026-07-29T10", tokens_out: 50, active_ms: MS_PER_HOUR, sessions: 2 }),
      ],
      1,
      END,
    );
    expect(s[0]).toMatchObject({ tokens: 150, activeHours: 2, sessions: 3, hasData: true });
  });
});

describe("dayRange", () => {
  it("is inclusive of today and ordered", () => {
    expect(dayRange(3, END)).toEqual(["2026-07-27", "2026-07-28", "2026-07-29"]);
  });
});

describe("heatmap", () => {
  it("places active minutes at local day-of-week and hour", () => {
    const g = heatmap([b({ local_dow: 2, local_hour: 14, active_ms: 30 * 60_000 })]);
    expect(g).toHaveLength(7);
    expect(g[0]).toHaveLength(24);
    expect(g[2]![14]).toBe(30);
    expect(g[3]![14]).toBe(0);
  });

  it("clamps out-of-range indices instead of throwing", () => {
    const g = heatmap([b({ local_dow: 99, local_hour: 99, active_ms: 60_000 })]);
    expect(g[6]![23]).toBe(1);
  });
});

describe("mix", () => {
  it("sorts providers descending without hiding lightly used agents", () => {
    const m = mix(
      [
        b({ provider: "ClaudeCode", tokens_in: 580 }),
        b({ provider: "Codex", tokens_in: 270 }),
        b({ provider: "Grok", tokens_in: 130 }),
        b({ provider: "Cursor", tokens_in: 20 }),
      ],
      "provider",
    );
    expect(m.map((s) => s.key)).toEqual(["ClaudeCode", "Codex", "Grok", "Cursor"]);
    expect(m[0]!.share).toBeCloseTo(0.58);
    expect(m.at(-1)!.share).toBeCloseTo(0.02);
  });

  it("keeps Claude below 3% visible while still grouping the model long tail", () => {
    const buckets = [
      b({ provider: "Codex", model: "gpt-5", tokens_in: 9990, active_ms: 999000 }),
      b({ provider: "ClaudeCode", model: "claude-sonnet", tokens_in: 10, active_ms: 1000 }),
      b({ provider: "Cursor", model: "unknown" }),
    ];
    expect(mix(buckets, "provider").map((s) => s.key)).toEqual(["Codex", "ClaudeCode"]);
    expect(mix(buckets, "model").map((s) => s.key)).toEqual(["gpt-5", "Other"]);
  });

  it("returns nothing when there are no tokens, rather than a zero slice", () => {
    expect(mix([b({ provider: "ClaudeCode" })], "provider")).toEqual([]);
  });

  it("keeps a single-provider team as one full track", () => {
    const m = mix([b({ tokens_in: 100 })], "provider");
    expect(m).toHaveLength(1);
    expect(m[0]!.share).toBe(1);
    expect(m[0]!.timeShare).toBe(0);
  });

  it("keeps a slice that is small in tokens but large in time", () => {
    const m = mix(
      [
        b({ provider: "ClaudeCode", tokens_in: 980, active_ms: 1_000 }),
        b({ provider: "Codex", tokens_in: 20, active_ms: 9_000 }),
      ],
      "provider",
    );
    expect(m.map((s) => s.key)).toEqual(["ClaudeCode", "Codex"]);
    expect(m.find((s) => s.key === "Codex")?.timeShare).toBeCloseTo(0.9);
  });

  it("returns a time-only mix when there are hours but no tokens", () => {
    const m = mix([b({ provider: "ClaudeCode", active_ms: 3_600_000 })], "provider");
    expect(m).toHaveLength(1);
    expect(m[0]!.tokens).toBe(0);
    expect(m[0]!.timeShare).toBe(1);
    expect(m[0]!.activeMs).toBe(3_600_000);
  });
});

describe("projects", () => {
  it("groups by project key, sorted by active time", () => {
    const p = projects([
      b({ project_key: "helios-api", active_ms: 2 * MS_PER_HOUR, tokens_in: 10 }),
      b({ project_key: "helios-web", active_ms: 5 * MS_PER_HOUR }),
      b({ project_key: "helios-api", active_ms: 1 * MS_PER_HOUR }),
    ]);
    expect(p.map((r) => r.projectKey)).toEqual(["helios-web", "helios-api"]);
    expect(p[1]!.activeHours).toBe(3);
  });

  it("labels unkeyed buckets rather than dropping them", () => {
    expect(projects([b({ project_key: "" })])[0]!.projectKey).toBe("(unlabelled)");
  });
});

describe("idleDays", () => {
  it("counts days with no active time", () => {
    expect(idleDays([b({ hour_utc: "2026-07-29T09", active_ms: MS_PER_HOUR })], 7, END)).toBe(6);
  });
  it("ignores buckets that logged zero active time", () => {
    expect(idleDays([b({ hour_utc: "2026-07-29T09", active_ms: 0 })], 3, END)).toBe(3);
  });
});

describe("perMember", () => {
  it("marks members with no buckets as neverSynced instead of zeroing them", () => {
    const rows = perMember([b({ user_id: "u1", tokens_in: 10 })], ["u1", "u2"]);
    expect(rows[0]).toMatchObject({ userId: "u1", neverSynced: false });
    expect(rows[1]).toMatchObject({ userId: "u2", neverSynced: true });
    expect(rows[1]!.totals.tokens).toBe(0);
  });
});

describe("delta", () => {
  it("is a signed ratio", () => {
    expect(delta(112, 100)).toBeCloseTo(0.12);
    expect(delta(90, 100)).toBeCloseTo(-0.1);
  });
  it("is null with no baseline, so the UI can omit the comparison", () => {
    expect(delta(50, 0)).toBeNull();
  });
});


describe("cost completeness", () => {
  it("ORs partial and legacy unknown costs without discarding priced amounts", () => {
    expect(totals([b({ cost_usd: 2, cost_incomplete: 0 })])).toMatchObject({ costUsd: 2, costIncomplete: false });
    expect(totals([b({ cost_incomplete: 0 }), b({ cost_usd: 3, cost_incomplete: 1 })])).toMatchObject({ costUsd: 3, costIncomplete: true });
    expect(totals([b({ cost_incomplete: 0 }), b()]).costIncomplete).toBe(true);
  });
});
