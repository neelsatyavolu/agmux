import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEIGHTS,
  complexityPointsFromSize,
  inRange,
  isComplexityOrg,
  isoWeekId,
  openPointsForPr,
  prRelevantToWindow,
  scoreWeek,
  sizeTier,
  validateThresholds,
  validateWeights,
  weekBounds,
  type EligibleMember,
  type PrForScore,
} from "../src/leaderboard/score";
// @ts-expect-error The web SPA is plain JavaScript without declarations.
import { sortLeaderboardRows } from "../web/views/leaderboard.js";
import { can } from "../src/authz";
import { addMember, makeEnv, seedTeam, seedUser } from "./helpers/d1";
import { getWeek, patchLeaderboardSettings } from "../src/routes/leaderboard";
import type { Principal } from "../src/session";
import { HttpError } from "../src/http";

describe("sizeTier", () => {
  it("classifies by additions+deletions thresholds", () => {
    expect(sizeTier(0)).toBe("small");
    expect(sizeTier(100)).toBe("small");
    expect(sizeTier(101)).toBe("medium");
    expect(sizeTier(500)).toBe("medium");
    expect(sizeTier(501)).toBe("large");
  });
});

describe("Nenu complexity points", () => {
  it("detects NenuAI org case-insensitively", () => {
    expect(isComplexityOrg("NenuAI")).toBe(true);
    expect(isComplexityOrg("nenuai")).toBe(true);
    expect(isComplexityOrg("other")).toBe(false);
    expect(isComplexityOrg(null)).toBe(false);
  });

  it("maps Size labels to the Nenu scale", () => {
    expect(complexityPointsFromSize("XS")).toBe(1);
    expect(complexityPointsFromSize("s")).toBe(2);
    expect(complexityPointsFromSize("M")).toBe(4);
    expect(complexityPointsFromSize("L")).toBe(8);
    expect(complexityPointsFromSize("XL")).toBe(16);
    expect(complexityPointsFromSize("XXL")).toBe(32);
    expect(complexityPointsFromSize("")).toBeNull();
    expect(complexityPointsFromSize("huge")).toBeNull();
  });

  it("prefers complexity points over LOC tier weights", () => {
    const pr: PrForScore = {
      authorGithubId: "1",
      openedAt: "2026-08-04T00:00:00.000Z",
      mergedAt: null,
      sizeTier: "small", // would be 1 pt by LOC
      isBot: false,
      complexityPoints: 16, // XL
    };
    expect(openPointsForPr(pr, DEFAULT_WEIGHTS)).toBe(16);
  });

  it("falls back to LOC weights when complexity is missing", () => {
    const pr: PrForScore = {
      authorGithubId: "1",
      openedAt: "2026-08-04T00:00:00.000Z",
      mergedAt: null,
      sizeTier: "large",
      isBot: false,
      complexityPoints: null,
    };
    expect(openPointsForPr(pr, DEFAULT_WEIGHTS)).toBe(4);
  });

  it("scores a week using complexity points on open", () => {
    const members: EligibleMember[] = [
      {
        userId: "u1",
        displayName: "Ada",
        handle: "ada",
        githubId: "111",
        githubLogin: "ada",
        tokens: 1000,
        costUsd: 8,
        costIncomplete: false,
      },
    ];
    const weekStart = "2026-08-03T00:00:00.000Z";
    const weekEnd = "2026-08-10T00:00:00.000Z";
    const prs: PrForScore[] = [
      {
        authorGithubId: "111",
        openedAt: "2026-08-04T10:00:00.000Z",
        mergedAt: "2026-08-05T10:00:00.000Z",
        sizeTier: "small", // LOC would give 1
        isBot: false,
        complexityPoints: 8, // L
      },
    ];
    const r = scoreWeek(members, prs, weekStart, weekEnd, DEFAULT_WEIGHTS);
    // 8 open + 0.5 merge
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.points).toBe(8.5);
    expect(r.rows[0]!.prOpened).toBe(1);
    expect(r.rows[0]!.prMerged).toBe(1);
  });
});

describe("ISO week bounds", () => {
  it("starts Monday UTC and ends next Monday exclusive", () => {
    // 2026-W32: Mon 2026-08-03
    const { start, end } = weekBounds("2026-W32");
    expect(start).toBe("2026-08-03T00:00:00.000Z");
    expect(end).toBe("2026-08-10T00:00:00.000Z");
  });

  it("round-trips isoWeekId for a known Monday", () => {
    const d = new Date("2026-08-05T12:00:00.000Z"); // Wed of W32
    expect(isoWeekId(d)).toBe("2026-W32");
  });
});

describe("scoreWeek", () => {
  const members: EligibleMember[] = [
    {
      userId: "u1",
      displayName: "Ada",
      handle: "ada",
      githubId: "111",
      githubLogin: "ada",
      tokens: 1000,
      costIncomplete: false,
      costUsd: 4.5, // $1/pt at 4.5 pts
    },
    {
      userId: "u2",
      displayName: "Bob",
      handle: "bob",
      githubId: "222",
      githubLogin: "bob",
      tokens: 500,
      costIncomplete: false,
      costUsd: 0.5, // $0.50/pt at 1 pt — cheaper → ranks first
    },
    {
      userId: "u3",
      displayName: "NoTokens",
      handle: "nt",
      githubId: "333",
      githubLogin: "nt",
      tokens: 0,
      costUsd: 0,
    },
  ];

  const weekStart = "2026-08-03T00:00:00.000Z";
  const weekEnd = "2026-08-10T00:00:00.000Z";

  it("ranks by $/pt (lower better), then tok/pt; excludes zero tokens", () => {
    const prs: PrForScore[] = [
      {
        authorGithubId: "111",
        openedAt: "2026-08-04T10:00:00.000Z",
        mergedAt: "2026-08-05T10:00:00.000Z",
        sizeTier: "large",
        isBot: false,
      },
      {
        authorGithubId: "222",
        openedAt: "2026-08-04T10:00:00.000Z",
        mergedAt: null,
        sizeTier: "small",
        isBot: false,
      },
      {
        authorGithubId: "333",
        openedAt: "2026-08-04T10:00:00.000Z",
        mergedAt: null,
        sizeTier: "medium",
        isBot: false,
      },
      {
        authorGithubId: "111",
        openedAt: "2026-07-01T10:00:00.000Z",
        mergedAt: null,
        sizeTier: "large",
        isBot: false,
      }, // outside week
    ];

    const r = scoreWeek(members, prs, weekStart, weekEnd, DEFAULT_WEIGHTS);
    // Ada: 4.5 pts, 1000 tok → 222.2 tok/pt, $1/pt
    // Bob: 1 pt, 500 tok → 500 tok/pt, $0.50/pt → ranks first (cheaper $/pt)
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]!.userId).toBe("u2");
    expect(r.rows[0]!.costPerPoint).toBeCloseTo(0.5);
    expect(r.rows[0]!.tokensPerPoint).toBeCloseTo(500);
    expect(r.rows[1]!.userId).toBe("u1");
    expect(r.rows[1]!.points).toBe(4.5);
    expect(r.rows[1]!.costPerPoint).toBeCloseTo(1);
    expect(r.rows[1]!.tokensPerPoint).toBeCloseTo(1000 / 4.5);
    expect(r.excludedNoTokens).toHaveLength(1);
    expect(r.excludedNoTokens[0]!.userId).toBe("u3");
  });

  it.each([0, 0.1])("keeps incomplete cost %s visible but unranked", (costUsd) => {
    const cohort = members.slice(0, 2).map((m, i) => ({ ...m, costUsd: i ? costUsd : 4.5, costIncomplete: i === 1 }));
    const prs: PrForScore[] = cohort.map((m) => ({ authorGithubId: m.githubId, openedAt: "2026-08-04T00:00:00.000Z", mergedAt: null, sizeTier: "small", isBot: false }));
    const r = scoreWeek(cohort, prs, weekStart, weekEnd);
    expect(r.rows.map((row) => row.userId)).toEqual(["u1", "u2"]);
    expect(r.rows[1]).toMatchObject({ rank: null, costPerPoint: null, tokens: 500, points: 1, costUsd });
    expect(r.memberCountRanked).toBe(1);
  });

  it("requires explicit complete cost, but permits reported zero cost", () => {
    const prs: PrForScore[] = [{ authorGithubId: "111", openedAt: "2026-08-04T00:00:00.000Z", mergedAt: null, sizeTier: "small", isBot: false }];
    const m = { ...members[0]!, costUsd: 0, costIncomplete: false };
    expect(scoreWeek([m], prs, weekStart, weekEnd).rows[0]).toMatchObject({ rank: 1, costPerPoint: 0 });
    expect(scoreWeek([{ ...m, costIncomplete: undefined }], prs, weekStart, weekEnd).rows[0]).toMatchObject({ rank: null, costPerPoint: null });
  });

  it.each([true, false])("keeps incomplete costs last in web cost sorting (%s)", (asc) => {
    const rows = [{ rank: null, costPerPoint: null }, { rank: 1, costPerPoint: 0 }, { rank: 2, costPerPoint: 2 }];
    expect(sortLeaderboardRows(rows, "costPerPoint", asc).map((r: { rank: number | null }) => r.rank)).toEqual(asc ? [1, 2, null] : [2, 1, null]);
  });

  it.each(["tokens", "prMerged", "tokensPerPr", "member"])("keeps unranked members last when web %s values tie", (key) => {
    const rows = [null, 2, 1].map((rank) => ({ rank, tokens: 100, prMerged: 2, displayName: "Ada" }));
    for (const asc of [true, false]) {
      expect(sortLeaderboardRows(rows, key, asc).map((r: { rank: number | null }) => r.rank)).toEqual([1, 2, null]);
    }
  });

  it("omits members with zero PR points", () => {
    const r = scoreWeek(members, [], weekStart, weekEnd);
    expect(r.rows).toHaveLength(0);
    expect(r.excludedNoTokens).toHaveLength(0);
  });

  it("ignores bots", () => {
    const prs: PrForScore[] = [
      {
        authorGithubId: "111",
        openedAt: "2026-08-04T10:00:00.000Z",
        mergedAt: null,
        sizeTier: "large",
        isBot: true,
      },
    ];
    const r = scoreWeek(members, prs, weekStart, weekEnd);
    expect(r.rows).toHaveLength(0);
  });

  it("attributes merge bonus to merge week not open week", () => {
    const prs: PrForScore[] = [
      {
        authorGithubId: "111",
        openedAt: "2026-07-20T10:00:00.000Z",
        mergedAt: "2026-08-04T10:00:00.000Z",
        sizeTier: "small",
        isBot: false,
      },
    ];
    const r = scoreWeek(members, prs, weekStart, weekEnd);
    expect(r.rows[0]!.prSmall).toBe(0);
    expect(r.rows[0]!.prMerged).toBe(1);
    expect(r.rows[0]!.points).toBe(0.5);
  });
});

describe("prRelevantToWindow", () => {
  const start = "2026-08-03T00:00:00.000Z";
  const end = "2026-08-17T00:00:00.000Z";
  it("keeps old opens that merge in window", () => {
    expect(
      prRelevantToWindow(
        { openedAt: "2026-07-01T00:00:00.000Z", mergedAt: "2026-08-05T00:00:00.000Z" },
        start,
        end,
      ),
    ).toBe(true);
  });
  it("drops fully outside", () => {
    expect(
      prRelevantToWindow(
        { openedAt: "2026-06-01T00:00:00.000Z", mergedAt: "2026-06-02T00:00:00.000Z" },
        start,
        end,
      ),
    ).toBe(false);
  });
});

describe("validation", () => {
  it("rejects inverted thresholds", () => {
    expect(validateThresholds(500, 100)).toMatch(/cannot exceed/i);
  });
  it("rejects negative weights", () => {
    expect(validateWeights({ small: 1, medium: 2, large: 4, merge: -1 })).toMatch(/non-negative/i);
  });
});

describe("authz leaderboard", () => {
  it("lets managers view but only owners manage", () => {
    expect(can("owner", "leaderboard.view")).toBe(true);
    expect(can("manager", "leaderboard.view")).toBe(true);
    expect(can("employee", "leaderboard.view")).toBe(false);
    expect(can("owner", "leaderboard.manage")).toBe(true);
    expect(can("manager", "leaderboard.manage")).toBe(false);
  });
});

describe("leaderboard week API", () => {
  const principal = (userId: string): Principal => ({ userId, via: "cookie", deviceId: null });

  it("403s employees", async () => {
    const env = makeEnv();
    const owner = await seedUser(env, "owner");
    await seedTeam(env, "team1", owner);
    const emp = await seedUser(env, "emp");
    await addMember(env, "team1", emp, "employee");

    await expect(getWeek(new Request("http://x/week"), env, principal(emp), "team1")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("returns enabled:false when off", async () => {
    const env = makeEnv();
    const owner = await seedUser(env, "owner");
    await seedTeam(env, "team1", owner);
    const mgr = await seedUser(env, "mgr");
    await addMember(env, "team1", mgr, "manager");

    const res = await getWeek(new Request("http://x/week"), env, principal(mgr), "team1");
    const body = (await res.json()) as { data: { enabled: boolean; rows: unknown[] } };
    expect(body.data.enabled).toBe(false);
    expect(body.data.rows).toEqual([]);
  });

  it("ranks github-linked members with PRs and tokens", async () => {
    const env = makeEnv();
    const owner = await seedUser(env, "owner", "Owner");
    await seedTeam(env, "team1", owner);
    const ada = await seedUser(env, "ada", "Ada");
    await addMember(env, "team1", ada, "employee");
    await env.DB.prepare(
      "INSERT INTO identities (provider, provider_user_id, user_id, created_at) VALUES ('github', '999', ?, ?)",
    )
      .bind(ada, new Date().toISOString())
      .run();

    const week = isoWeekId();
    const { start, end } = weekBounds(week);
    const hour = start.slice(0, 13);

    await env.DB.prepare(
      `INSERT INTO metric_hourly (
         team_id, user_id, device_id, hour_utc, provider, model, project_key,
         tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, tokens_reasoning,
         cost_usd, cost_incomplete, active_ms, after_hours_ms, weekend_ms, sessions, turns, tool_calls,
         peak_concurrent, local_hour, local_dow, updated_at
       ) VALUES (?, ?, 'dev', ?, 'ClaudeCode', 'x', 'repo', 500, 500, 0, 0, 300, 2.5, 0, 0, 0, 0, 1, 1, 0, 1, 10, 1, ?)`,
    )
      .bind("team1", ada, hour, new Date().toISOString())
      .run();

    await env.DB.prepare(
      `INSERT INTO team_leaderboard_settings (
         team_id, enabled, threshold_small_max, threshold_medium_max,
         weight_small, weight_medium, weight_large, weight_merge, updated_at
       ) VALUES ('team1', 1, 100, 500, 1, 2, 4, 0.5, ?)`,
    )
      .bind(new Date().toISOString())
      .run();

    const mid = new Date((Date.parse(start) + Date.parse(end)) / 2).toISOString();
    await env.DB.prepare(
      `INSERT INTO github_prs (
         id, team_id, repo_full_name, pr_number, author_github_id, author_login,
         opened_at, merged_at, closed_at, additions, deletions, size_tier, is_bot,
         updated_at_github, synced_at
       ) VALUES ('gpr1', 'team1', 'org/r', 1, '999', 'ada', ?, NULL, NULL, 50, 10, 'small', 0, ?, ?)`,
    )
      .bind(mid, mid, mid)
      .run();

    const res = await getWeek(
      new Request(`http://x/week?week=${week}`),
      env,
      principal(owner),
      "team1",
    );
    const body = (await res.json()) as {
      data: {
        enabled: boolean;
        rows: Array<{
          userId: string;
          prSmall: number;
          tokensPerPoint: number;
          costPerPoint: number;
        }>;
      };
    };
    expect(body.data.enabled).toBe(true);
    expect(body.data.rows).toHaveLength(1);
    expect(body.data.rows[0]!.userId).toBe(ada);
    expect(body.data.rows[0]!.prSmall).toBe(1);
    expect(body.data.rows[0]!.tokensPerPoint).toBeCloseTo(1000); // 1000 tok / 1 pt
    expect(body.data.rows[0]!.costPerPoint).toBeCloseTo(2.5); // $2.50 / 1 pt
    await env.DB.prepare("UPDATE metric_hourly SET cost_incomplete = 1 WHERE user_id = ?").bind(ada).run();
    const partial = await getWeek(new Request(`http://x/week?week=${week}`), env, principal(owner), "team1");
    const partialBody = await partial.json() as { data: { rows: unknown[]; memberCountRanked: number } };
    expect(partialBody.data.rows[0]).toMatchObject({ tokens: 1000, points: 1, costUsd: 2.5, costIncomplete: true, rank: null, costPerPoint: null });
    expect(partialBody.data.memberCountRanked).toBe(0);
  });

  it("blocks manager from patching settings", async () => {
    const env = makeEnv();
    const owner = await seedUser(env, "owner");
    await seedTeam(env, "team1", owner);
    const mgr = await seedUser(env, "mgr");
    await addMember(env, "team1", mgr, "manager");

    const req = new Request("http://x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    await expect(patchLeaderboardSettings(req, env, principal(mgr), "team1")).rejects.toBeInstanceOf(
      HttpError,
    );
  });
});

describe("inRange", () => {
  it("is half-open on end", () => {
    expect(inRange("2026-08-10T00:00:00.000Z", "2026-08-03T00:00:00.000Z", "2026-08-10T00:00:00.000Z")).toBe(
      false,
    );
    expect(inRange("2026-08-09T23:59:59.000Z", "2026-08-03T00:00:00.000Z", "2026-08-10T00:00:00.000Z")).toBe(
      true,
    );
  });
});
