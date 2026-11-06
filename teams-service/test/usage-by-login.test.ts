import { describe, expect, it } from "vitest";
import {
  applyUpload,
  pruneStale,
  validatePayload,
  type IncomingAccountBucket,
  type IncomingBucket,
  type UploadPayload,
} from "../src/metrics";
import { buildLogins, memberLogins, providerTotals, type AccountSum } from "../src/logins";
import type { Bucket } from "../src/aggregate";
import type { Env } from "../src/env";
import { addMember, makeEnv, seedTeam, seedUser } from "./helpers/d1";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const bucket = (over: Partial<IncomingBucket> = {}): IncomingBucket => ({
  hourUtc: "2026-11-05T14",
  provider: "ClaudeCode",
  model: "claude-opus-5-5",
  projectKey: "helios",
  tokensIn: 1000,
  tokensOut: 1000,
  costUsd: 1,
  costIncomplete: false,
  ...over,
});

const account = (over: Partial<IncomingAccountBucket> = {}): IncomingAccountBucket => ({
  hourUtc: "2026-11-05T14",
  provider: "claude",
  identityHash: HASH_A,
  tokensIn: 600,
  tokensOut: 400,
  costUsd: 0.5,
  costIncomplete: false,
  activeMs: 1_800_000,
  turns: 3,
  ...over,
});

const payload = (batchId: string, over: Partial<UploadPayload> = {}): UploadPayload =>
  validatePayload({ batchId, buckets: [bucket()], accountsReported: true, ...over });

async function fixture() {
  const env = makeEnv();
  await seedUser(env, "emp1");
  await seedUser(env, "owner1");
  await seedTeam(env, "tm1", "owner1");
  await addMember(env, "tm1", "emp1", "employee");
  return env;
}

async function setSharing(env: Env, on: boolean) {
  await env.DB.prepare(
    `INSERT INTO provider_account_settings (team_id, claude_activity, updated_at, updated_by)
     VALUES ('tm1', ?, 0, 'owner1')
     ON CONFLICT(team_id) DO UPDATE SET claude_activity = excluded.claude_activity`,
  ).bind(on ? 1 : 0).run();
}

async function accountRows(env: Env) {
  const r = await env.DB.prepare(
    "SELECT provider, identity_hash, tokens_in, tokens_out FROM metric_account_hourly ORDER BY identity_hash",
  ).all<{ provider: string; identity_hash: string; tokens_in: number; tokens_out: number }>();
  return r.results ?? [];
}

const view = (env: Env, buckets: Partial<Bucket>[] = [{ provider: "ClaudeCode", tokens_in: 1000, tokens_out: 1000, tokens_cache_read: 0, tokens_cache_write: 0, cost_usd: 1 } as Bucket]) =>
  memberLogins(env, "tm1", "emp1", "2026-11-01T00", null, providerTotals(buckets as Bucket[]));

describe("validatePayload: account fields", () => {
  it("accepts a payload without them (older desktops)", () => {
    const p = validatePayload({ batchId: "b", buckets: [] });
    expect(p.accountBuckets).toEqual([]);
    expect(p.accountsReported).toBe(false);
  });
  it("rejects unknown providers and malformed hashes", () => {
    expect(() => validatePayload({ batchId: "b", buckets: [], accountBuckets: [account({ provider: "grok" })] })).toThrow(/claude or codex/);
    expect(() => validatePayload({ batchId: "b", buckets: [], accountBuckets: [account({ identityHash: "name@example.com" })] })).toThrow(/identityHash/);
    expect(() => validatePayload({ batchId: "b", buckets: [], accountBuckets: [account({ hourUtc: "2026-11-05" })] })).toThrow(/hourUtc/);
  });
  it("drops malformed labels without failing the upload", () => {
    const p = validatePayload({
      batchId: "b",
      buckets: [],
      accountLabels: [
        { provider: "claude", identityHash: HASH_A, label: " a@example.com " },
        { provider: "codex", identityHash: HASH_B, label: "b@example.com" },
        { provider: "claude", identityHash: "short", label: "c@example.com" },
        { provider: "claude", identityHash: HASH_C, label: "bad\u0007label" },
      ],
    });
    expect(p.accountLabels).toEqual([{ provider: "claude", identityHash: HASH_A, label: "a@example.com" }]);
  });
});

describe("account bucket ingest", () => {
  it("replaces counters on retry instead of adding", async () => {
    const env = await fixture();
    await applyUpload(env, "emp1", "dev1", payload("one", { accountBuckets: [account()] }));
    await applyUpload(env, "emp1", "dev1", payload("two", { accountBuckets: [account({ tokensIn: 700 })] }));
    await applyUpload(env, "emp1", "dev1", payload("two", { accountBuckets: [account({ tokensIn: 700 })] }));
    expect(await accountRows(env)).toEqual([{ provider: "claude", identity_hash: HASH_A, tokens_in: 700, tokens_out: 400 }]);
  });

  it("stores a Claude email only while the team shares Claude accounts", async () => {
    const env = await fixture();
    const labels = [{ provider: "claude" as const, identityHash: HASH_A, label: "shared@example.com" }];
    await applyUpload(env, "emp1", "dev1", payload("off", { accountBuckets: [account()], accountLabels: labels }));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM account_labels").first()).toEqual({ n: 0 });

    await setSharing(env, true);
    await applyUpload(env, "emp1", "dev1", payload("on", { accountBuckets: [account()], accountLabels: labels }));
    expect((await view(env)).rows[0]).toMatchObject({ name: "shared@example.com", nameSource: "email" });

    // A stored label is not shown once sharing is off, even before it is deleted.
    await setSharing(env, false);
    expect((await view(env)).rows[0]).toMatchObject({ name: "Claude login 1", nameSource: "number" });
  });

  it("marks the device as reporting logins even with no account buckets", async () => {
    const env = await fixture();
    expect((await view(env)).reported).toBe(false);
    await applyUpload(env, "emp1", "dev1", payload("empty"));
    const v = await view(env);
    expect(v.reported).toBe(true);
    expect(v.rows).toEqual([expect.objectContaining({ identityHash: null, name: "Not attributed", tokens: 2000 })]);
  });

  it("prunes account rows the latest full snapshot did not refresh", async () => {
    const env = await fixture();
    await applyUpload(env, "emp1", "dev1", payload("old", {
      accountBuckets: [account(), account({ identityHash: HASH_B })],
    }));
    const sync = await env.DB.prepare("SELECT last_upload_at FROM sync_state").first<{ last_upload_at: string }>();
    await env.DB.prepare("UPDATE metric_account_hourly SET updated_at = '2000-01-01T00:00:00.000Z'").run();
    await env.DB.prepare("UPDATE metric_account_hourly SET updated_at = ? WHERE identity_hash = ?")
      .bind(sync!.last_upload_at, HASH_A).run();
    await pruneStale(env, "emp1", "dev1", { sinceHour: "2026-11-01T00", notBefore: sync!.last_upload_at });
    expect((await accountRows(env)).map((r) => r.identity_hash)).toEqual([HASH_A]);
  });
});

describe("buildLogins", () => {
  const sum = (hash: string, tokens: number, provider = "claude"): AccountSum => ({
    provider, identity_hash: hash, tokens, cost_usd: tokens / 1000, cost_incomplete: 0, active_ms: 3_600_000,
  });
  const totals = {
    claude: { tokens: 1000, costUsd: 1, costIncomplete: false },
    codex: { tokens: 0, costUsd: 0, costIncomplete: false },
  };

  it("numbers logins by a stable order that does not depend on the range", () => {
    const v = buildLogins({
      reported: true,
      sums: [sum(HASH_C, 300)],
      totals,
      known: { claude: [HASH_C, HASH_A], codex: [] },
      emails: new Map(),
      pool: new Map(),
    });
    expect(v.rows[0]).toMatchObject({ name: "Claude login 2", tokens: 300, share: 0.3 });
  });

  it("puts what could not be attributed in its own row, never below zero", () => {
    const v = buildLogins({
      reported: true,
      sums: [sum(HASH_A, 600), sum(HASH_B, 100)],
      totals,
      known: { claude: [HASH_A, HASH_B], codex: [] },
      emails: new Map([[`claude:${HASH_B}`, "b@example.com"]]),
      pool: new Map(),
    });
    expect(v.rows.map((r) => [r.name, r.tokens])).toEqual([
      ["Claude login 1", 600],
      ["b@example.com", 100],
      ["Not attributed", 300],
    ]);
    const over = buildLogins({
      reported: true, sums: [sum(HASH_A, 1500)], totals,
      known: { claude: [HASH_A], codex: [] }, emails: new Map(), pool: new Map(),
    });
    expect(over.rows.some((r) => r.identityHash === null)).toBe(false);
  });

  it("names a Codex login after the team pool account it matches", () => {
    const v = buildLogins({
      reported: true,
      sums: [sum(HASH_A, 50, "codex")],
      totals: { ...totals, codex: { tokens: 50, costUsd: 0, costIncomplete: true } },
      known: { claude: [], codex: [HASH_A] },
      emails: new Map(),
      pool: new Map([[`codex:${HASH_A}`, "Team Codex Pro"]]),
    });
    expect(v.rows.find((r) => r.provider === "codex")).toMatchObject({ name: "Team Codex Pro", nameSource: "team" });
  });

  it("returns no rows for a member whose app does not report logins", () => {
    expect(buildLogins({
      reported: false, sums: [], totals, known: { claude: [], codex: [] }, emails: new Map(), pool: new Map(),
    })).toEqual({ reported: false, rows: [] });
  });
});

describe("providerTotals", () => {
  it("reads the app's provider names from metric rows", () => {
    const t = providerTotals([
      { provider: "ClaudeCode", tokens_in: 10, tokens_out: 5, tokens_cache_read: 0, tokens_cache_write: 0, cost_usd: 1 } as Bucket,
      { provider: "Codex", tokens_in: 7, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0, cost_usd: 0 } as Bucket,
      { provider: "Grok", tokens_in: 99, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0, cost_usd: 0 } as Bucket,
    ]);
    expect(t.claude.tokens).toBe(15);
    expect(t.codex.tokens).toBe(7);
  });
});
