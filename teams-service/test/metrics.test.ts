import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyUpload,
  pruneStale,
  validatePayload,
  validatePrunePayload,
  type IncomingBucket,
  type UploadPayload,
} from "../src/metrics";
import type { Env } from "../src/env";
import { addMember, makeEnv, seedTeam, seedUser } from "./helpers/d1";

const bucket = (over: Partial<IncomingBucket> = {}): IncomingBucket => ({
  hourUtc: "2026-07-29T14",
  provider: "ClaudeCode",
  model: "claude-opus-5",
  projectKey: "helios-api",
  tokensIn: 1000,
  tokensOut: 500,
  tokensCacheRead: 4000,
  tokensCacheWrite: 100,
  costUsd: 0.42,
  activeMs: 1_800_000,
  sessions: 3,
  turns: 12,
  toolCalls: 40,
  peakConcurrent: 2,
  localHour: 14,
  localDow: 2,
  ...over,
});

const payload = (
  batchId: string,
  buckets: IncomingBucket[],
  over: Partial<UploadPayload> = {},
): UploadPayload => ({ batchId, buckets, ...over });

async function rows(env: Env) {
  const r = await env.DB.prepare(
    "SELECT team_id, tokens_in, tokens_out, sessions, active_ms FROM metric_hourly ORDER BY team_id",
  ).all<{ team_id: string; tokens_in: number; tokens_out: number; sessions: number; active_ms: number }>();
  return r.results ?? [];
}

describe("validatePayload", () => {
  it("requires a batch id", () => {
    expect(() => validatePayload({ buckets: [] })).toThrow(/batchId/);
  });
  it("requires a well-formed hour key", () => {
    expect(() => validatePayload(payload("b1", [bucket({ hourUtc: "2026-07-29" })]))).toThrow(/hourUtc/);
  });
  it("requires a provider", () => {
    expect(() => validatePayload(payload("b1", [bucket({ provider: "" })]))).toThrow(/provider/);
  });
  it("accepts a valid batch", () => {
    expect(validatePayload(payload("b1", [bucket()])).buckets).toHaveLength(1);
  });
});

describe("upload idempotency", () => {
  async function fixture() {
    const env = makeEnv();
    await seedUser(env, "emp1");
    await seedUser(env, "owner1");
    await seedTeam(env, "tm1", "owner1");
    await addMember(env, "tm1", "emp1", "employee");
    return env;
  }

  it("defaults unknown costs to incomplete and replaces completeness with each snapshot", async () => {
    const env = await fixture();
    const stored = () => env.DB.prepare("SELECT cost_incomplete FROM metric_hourly").first<{ cost_incomplete: number }>();
    await applyUpload(env, "emp1", "dev1", payload("cost-old", [bucket()]));
    expect(await stored()).toEqual({ cost_incomplete: 1 });
    await applyUpload(env, "emp1", "dev1", payload("cost-complete", [bucket({ costIncomplete: false })]));
    expect(await stored()).toEqual({ cost_incomplete: 0 });
    await applyUpload(env, "emp1", "dev1", payload("cost-partial", [bucket({ costIncomplete: true })]));
    expect(await stored()).toEqual({ cost_incomplete: 1 });
    await applyUpload(env, "emp1", "dev1", payload("cost-invalid", [bucket({ costIncomplete: 0 as unknown as boolean })]));
    expect(await stored()).toEqual({ cost_incomplete: 1 });
  });

  it("stores session starts, keeps an absent count unknown, and replaces on retry", async () => {
    const env = await fixture();
    const stored = () => env.DB.prepare("SELECT sessions, sessions_started FROM metric_hourly")
      .first<{ sessions: number; sessions_started: number | null }>();
    await applyUpload(env, "emp1", "dev1", payload("starts-old", [bucket({ sessions: 3 })]));
    expect(await stored()).toEqual({ sessions: 3, sessions_started: null });
    await applyUpload(env, "emp1", "dev1", payload("starts-new", [bucket({ sessions: 3, sessionsStarted: 2 })]));
    expect(await stored()).toEqual({ sessions: 3, sessions_started: 2 });
    await applyUpload(env, "emp1", "dev1", payload("starts-retry", [bucket({ sessions: 3, sessionsStarted: 2 })]));
    expect(await stored()).toEqual({ sessions: 3, sessions_started: 2 });
    await applyUpload(env, "emp1", "dev1", payload("starts-hostile", [bucket({ sessionsStarted: -5 })]));
    expect((await stored())?.sessions_started).toBe(0);
  });

  it("persists every app provider without filtering", async () => {
    const env = await fixture();
    const providers = ["ClaudeCode", "Codex", "Grok", "Cursor", "Droid", "Pi", "Kimi", "Cline", "Gemini", "Hermes", "OpenCode", "MLX"];
    const result = await applyUpload(env, "emp1", "dev1", payload("all-providers", providers.map((provider) => bucket({ provider }))));
    expect(result.bucketsApplied).toBe(providers.length);
    const stored = await env.DB.prepare("SELECT provider FROM metric_hourly ORDER BY provider").all<{ provider: string }>();
    expect(stored.results?.map((row) => row.provider)).toEqual([...providers].sort());
  });

  it("applies a batch once", async () => {
    const env = await fixture();
    const res = await applyUpload(env, "emp1", "dev1", payload("batch-1", [bucket()]));
    expect(res).toMatchObject({ accepted: true, duplicate: false, bucketsApplied: 1 });
    expect(await rows(env)).toEqual([
      { team_id: "tm1", tokens_in: 1000, tokens_out: 500, sessions: 3, active_ms: 1_800_000 },
    ]);
  });

  it("does not double-count a replayed batch id", async () => {
    const env = await fixture();
    await applyUpload(env, "emp1", "dev1", payload("batch-1", [bucket()]));
    const again = await applyUpload(env, "emp1", "dev1", payload("batch-1", [bucket()]));

    expect(again).toMatchObject({ accepted: true, duplicate: true });
    const after = await rows(env);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ tokens_in: 1000, sessions: 3 });
  });

  it("converges when the same bucket is resent under a new batch id", async () => {
    const env = await fixture();
    // A device that lost its receipt retries with a fresh batch id. Counters are
    // absolute for the bucket, so the row is replaced rather than summed.
    await applyUpload(env, "emp1", "dev1", payload("batch-1", [bucket()]));
    await applyUpload(env, "emp1", "dev1", payload("batch-2", [bucket()]));

    const after = await rows(env);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ tokens_in: 1000, tokens_out: 500, sessions: 3 });
  });

  it("takes the latest value when a bucket is revised upward mid-hour", async () => {
    const env = await fixture();
    await applyUpload(env, "emp1", "dev1", payload("b1", [bucket({ tokensIn: 1000, sessions: 1 })]));
    await applyUpload(env, "emp1", "dev1", payload("b2", [bucket({ tokensIn: 2500, sessions: 4 })]));

    const after = await rows(env);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ tokens_in: 2500, sessions: 4 });
  });

  it("stores the tool mix and output counters", async () => {
    const env = await fixture();
    await applyUpload(
      env,
      "emp1",
      "dev1",
      payload("b1", [
        bucket({
          toolBash: 12,
          toolEdit: 5,
          toolMcp: 2,
          toolErrors: 3,
          toolsMeasured: 17,
          filesChanged: 4,
          linesAdded: 260,
          linesRemoved: 31,
        }),
      ]),
    );
    const r = await env.DB.prepare(
      `SELECT tool_bash, tool_edit, tool_mcp, tool_errors, tools_measured,
              files_changed, lines_added, lines_removed FROM metric_hourly`,
    ).first<Record<string, number>>();
    expect(r).toMatchObject({
      tool_bash: 12,
      tool_edit: 5,
      tool_mcp: 2,
      tool_errors: 3,
      tools_measured: 17,
      files_changed: 4,
      lines_added: 260,
      lines_removed: 31,
    });
  });

  it("replaces the new counters on retry instead of adding to them", async () => {
    const env = await fixture();
    const b = bucket({ toolBash: 10, linesAdded: 100, toolsMeasured: 10 });
    await applyUpload(env, "emp1", "dev1", payload("b1", [b]));
    await applyUpload(env, "emp1", "dev1", payload("b2", [b]));

    const r = await env.DB.prepare(
      "SELECT tool_bash, lines_added, tools_measured FROM metric_hourly",
    ).first<Record<string, number>>();
    expect(r).toMatchObject({ tool_bash: 10, lines_added: 100, tools_measured: 10 });
  });

  it("keeps two devices in the same hour as separate rows", async () => {
    const env = await fixture();
    await applyUpload(env, "emp1", "dev1", payload("b1", [bucket()]));
    await applyUpload(env, "emp1", "dev2", payload("b1", [bucket()]));

    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM metric_hourly").first<{ n: number }>();
    expect(r!.n).toBe(2);
  });

  it("fans out to every active membership", async () => {
    const env = await fixture();
    await seedUser(env, "owner2");
    await seedTeam(env, "tm2", "owner2", "Cortex Infra");
    await addMember(env, "tm2", "emp1", "employee");

    const res = await applyUpload(env, "emp1", "dev1", payload("b1", [bucket()]));
    expect(res.teams.sort()).toEqual(["tm1", "tm2"]);
    expect((await rows(env)).map((r) => r.team_id)).toEqual(["tm1", "tm2"]);
  });

  it("stops feeding a team the member has left", async () => {
    const env = await fixture();
    await env.DB.prepare("UPDATE team_members SET left_at = ? WHERE user_id = ? AND team_id = ?")
      .bind(new Date().toISOString(), "emp1", "tm1")
      .run();

    const res = await applyUpload(env, "emp1", "dev1", payload("b1", [bucket()]));
    expect(res.teams).toEqual([]);
    expect(await rows(env)).toHaveLength(0);
  });

  it("drops path-like labels instead of storing them", async () => {
    const env = await fixture();
    await applyUpload(
      env,
      "emp1",
      "dev1",
      payload("b1", [bucket({ projectKey: "/Users/neel/secret/helios-api" })]),
    );
    const r = await env.DB.prepare("SELECT project_key FROM metric_hourly").first<{ project_key: string }>();
    expect(r!.project_key).toBe("");
  });

  it("clamps hostile numbers rather than trusting them", async () => {
    const env = await fixture();
    await applyUpload(
      env,
      "emp1",
      "dev1",
      payload("b1", [bucket({ tokensIn: -5000, localHour: 99, localDow: -3 })]),
    );
    const r = await env.DB.prepare("SELECT tokens_in, local_hour, local_dow FROM metric_hourly").first<{
      tokens_in: number;
      local_hour: number;
      local_dow: number;
    }>();
    expect(r).toMatchObject({ tokens_in: 0, local_hour: 23, local_dow: 0 });
  });

  it("records sync freshness for the device", async () => {
    const env = await fixture();
    await applyUpload(env, "emp1", "dev1", payload("b1", [bucket({ hourUtc: "2026-07-29T14" })]));
    const s = await env.DB.prepare("SELECT last_bucket_hour FROM sync_state WHERE user_id = ?")
      .bind("emp1")
      .first<{ last_bucket_hour: string }>();
    expect(s!.last_bucket_hour).toBe("2026-07-29T14");
  });

  it("stores the member IANA timezone from the upload payload", async () => {
    const env = await fixture();
    await applyUpload(
      env,
      "emp1",
      "dev1",
      payload("b1", [bucket()], { timezone: "Asia/Tokyo" }),
    );
    const u = await env.DB.prepare("SELECT timezone FROM users WHERE id = ?")
      .bind("emp1")
      .first<{ timezone: string | null }>();
    expect(u!.timezone).toBe("Asia/Tokyo");
  });

  it("ignores a junk timezone without failing the upload", async () => {
    const env = await fixture();
    const validated = validatePayload(
      payload("b1", [bucket()], { timezone: "not a zone!!!" } as Partial<UploadPayload>),
    );
    expect(validated.timezone).toBeUndefined();
    await applyUpload(env, "emp1", "dev1", validated);
    const u = await env.DB.prepare("SELECT timezone FROM users WHERE id = ?")
      .bind("emp1")
      .first<{ timezone: string | null }>();
    expect(u!.timezone).toBeNull();
  });
});

describe("pruneStale", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("conserves tokens and cost across chunks despite an ahead desktop clock and a retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T10:00:00.000Z"));
    const env = makeEnv();
    await seedUser(env, "emp1");
    await seedUser(env, "owner1");
    await seedTeam(env, "tm1", "owner1");
    await addMember(env, "tm1", "emp1", "employee");
    await applyUpload(env, "emp1", "dev1", payload("old", [bucket({ model: "obsolete" })]));
    vi.setSystemTime(new Date("2026-09-08T10:01:00.000Z"));
    const first = await applyUpload(env, "emp1", "dev1", payload("part1", [bucket({ tokensIn: 100, costUsd: 0.11 })]));
    vi.setSystemTime(new Date("2026-09-08T10:01:03.000Z"));
    await applyUpload(env, "emp1", "dev1", payload("part2", [bucket({ model: "second", tokensIn: 200, costUsd: 0.22 })]));
    vi.setSystemTime(new Date("2026-09-08T10:01:05.000Z"));
    const retry = await applyUpload(env, "emp1", "dev1", payload("part1", [bucket({ tokensIn: 999, costUsd: 99 })]));
    await pruneStale(env, "emp1", "dev1", {
      sinceHour: "2026-07-01T00",
      notBefore: retry.acceptedAt ?? "2026-09-08T10:06:00.000Z",
    });
    const total = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(tokens_in) AS tokens, SUM(cost_usd) AS cost FROM metric_hourly")
      .first<{ n: number; tokens: number; cost: number }>();
    expect(total?.n).toBe(2);
    expect(total?.tokens).toBe(300);
    expect(total?.cost).toBeCloseTo(0.33, 12);
    expect(retry.acceptedAt).toBe(first.acceptedAt);
    expect(first.acceptedAt).toBe("2026-09-08T10:01:00.000Z");
  });

  it("rejects a bad hour key", () => {
    expect(() => validatePrunePayload({ sinceHour: "2026-07-29" })).toThrow(/sinceHour/);
  });

  it("drops rows this device did not refresh in the full sync", async () => {
    const env = makeEnv();
    await seedUser(env, "emp1");
    await seedUser(env, "owner1");
    await seedTeam(env, "tm1", "owner1");
    await addMember(env, "tm1", "emp1", "employee");

    await applyUpload(env, "emp1", "dev1", payload("old", [bucket({ hourUtc: "2026-07-01T10" })]));
    await env.DB.prepare("UPDATE metric_hourly SET updated_at = '2026-07-01T00:00:00.000Z'").run();

    await applyUpload(env, "emp1", "dev1", payload("fresh", [bucket({ hourUtc: "2026-07-29T14" })]));

    const res = await pruneStale(env, "emp1", "dev1", {
      sinceHour: "2026-05-01T00",
    });
    expect(res.deleted).toBeGreaterThanOrEqual(1);
    const hours = await env.DB.prepare("SELECT hour_utc FROM metric_hourly ORDER BY hour_utc")
      .all<{ hour_utc: string }>();
    expect(hours.results?.map((r) => r.hour_utc)).toEqual(["2026-07-29T14"]);
  });

  it("keeps just-uploaded rows when prune runs seconds later", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T21:12:55.000Z"));
    const env = makeEnv();
    await seedUser(env, "emp1");
    await seedUser(env, "owner1");
    await seedTeam(env, "tm1", "owner1");
    await addMember(env, "tm1", "emp1", "employee");

    await applyUpload(env, "emp1", "dev1", payload("fresh", [bucket({ hourUtc: "2026-07-29T14" })]));

    // Production: upload of hundreds of buckets, then a separate prune POST.
    vi.setSystemTime(new Date("2026-08-25T21:13:10.000Z"));
    const res = await pruneStale(env, "emp1", "dev1", {
      sinceHour: "2026-05-01T00",
      notBefore: "2026-08-25T21:12:55.000Z",
    });
    expect(res.deleted).toBe(0);
    const hours = await env.DB.prepare("SELECT hour_utc FROM metric_hourly")
      .all<{ hour_utc: string }>();
    expect(hours.results?.map((r) => r.hour_utc)).toEqual(["2026-07-29T14"]);
  });

  it("keeps history in a team this upload no longer writes to (trial ended, read-only)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T10:00:00.000Z"));
    const env = makeEnv({ BILLING_ENFORCE: "true" });
    for (const id of ["owner1", "emp1", "emp2", "emp3"]) await seedUser(env, id);
    await seedTeam(env, "tm1", "owner1");
    for (const id of ["emp1", "emp2", "emp3"]) await addMember(env, "tm1", id, "employee");
    await env.DB.prepare("UPDATE teams SET billing_status = 'trialing', trial_ends_at = ?")
      .bind("2026-09-10T00:00:00.000Z").run();
    await applyUpload(env, "emp1", "dev1", payload("during-trial", [bucket({ hourUtc: "2026-09-05T10" })]));
    expect(await rows(env)).toHaveLength(1);

    // Trial ends: the team is read-only (dashboards stay readable), so the
    // desktop's next complete snapshot is not written to it — and its prune
    // must not delete the history that team can still read.
    vi.setSystemTime(new Date("2026-09-12T10:00:00.000Z"));
    const next = await applyUpload(env, "emp1", "dev1", payload("after-trial", [bucket({ hourUtc: "2026-09-05T10" })]));
    expect(next.teamsSkipped).toEqual([{ id: "tm1", reason: "billing" }]);
    vi.setSystemTime(new Date("2026-09-12T10:00:05.000Z"));
    await pruneStale(env, "emp1", "dev1", { sinceHour: "2026-06-14T00", notBefore: next.acceptedAt });
    expect(await rows(env)).toHaveLength(1);
  });

  it("does nothing when this device has never uploaded", async () => {
    const env = makeEnv();
    await seedUser(env, "emp1");
    const res = await pruneStale(env, "emp1", "dev1", { sinceHour: "2026-05-01T00" });
    expect(res.deleted).toBe(0);
  });
});
