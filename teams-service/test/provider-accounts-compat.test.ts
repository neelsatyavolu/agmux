import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { createDeviceToken, createSession } from "../src/session";
import { addMember, makeEnv, seedTeam, seedUser } from "./helpers/d1";

const migration = readFileSync(new URL("../migrations/013_provider_accounts.sql", import.meta.url), "utf8");
const catalogSql = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name";

async function call(env: Env, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const response = await worker.fetch(new Request(`https://teams.agmux.dev${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  return { status: response.status, body: await response.json() as any };
}

async function fixture(key?: string) {
  const env = makeEnv({ ...(key === undefined ? {} : { PROVIDER_ACCOUNTS_KEY: key }) });
  await seedUser(env, "owner");
  await seedUser(env, "employee");
  await seedTeam(env, "team", "owner");
  await addMember(env, "team", "employee", "employee");
  // Stable existing billing state avoids first-read trial backfill in comparisons.
  await env.DB.prepare("UPDATE teams SET billing_status='comp',trial_ends_at='2099-01-01T00:00:00.000Z'").run();
  const desktop = { authorization: `Bearer ${await createDeviceToken(env, "employee", "old-device", "Old Mac")}` };
  const cookie = { cookie: `__Host-agmux_teams=${await createSession(env, "owner")}` };
  return { env, desktop, cookie };
}

function oldUpload(batchId = "old-batch") {
  return { batchId, buckets: [{
    hourUtc: new Date(Date.now() - 3_600_000).toISOString().slice(0, 13),
    provider: "Codex", model: "gpt-5", projectKey: "legacy-project",
    tokensIn: 1000, tokensOut: 500, costUsd: 0.42,
    activeMs: 60000, sessions: 1, turns: 2, toolCalls: 3,
  }] };
}

describe("provider accounts backward compatibility", () => {
  it("reproduces the checkout deployment blocker on a pre-012 policy schema, even after 013", async () => {
    const { env, desktop, cookie } = await fixture(btoa("k".repeat(32)));
    await env.DB.prepare("DROP TABLE manager_policies").run();
    await env.DB.prepare("ALTER TABLE team_policies DROP COLUMN allowed_modes").run();
    await env.DB.prepare("ALTER TABLE team_policies DROP COLUMN allowed_efforts").run();
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const headers of [desktop, cookie]) {
        const response = await call(env, "/api/teams/team/policy", headers);
        expect(response.status).toBe(500);
        expect(response.body.ok).toBe(false);
      }
      expect(logs.mock.calls.some(args => args.some(arg => String(arg).includes("allowed_modes")))).toBe(true);
      // Provider accounts itself needs neither restriction columns nor manager_policies.
      expect(await call(env, "/api/teams/team/provider-accounts", desktop)).toEqual({
        status: 200, body: { ok: true, data: { accounts: [] } },
      });
      expect((await call(env, "/api/metrics/upload", desktop, oldUpload())).status).toBe(200);
    } finally { logs.mockRestore(); }
  });

  it("reproduces the additional upload/dashboard blocker if migration 011 is also absent", async () => {
    const { env, desktop } = await fixture();
    await env.DB.prepare("ALTER TABLE metric_hourly DROP COLUMN cost_incomplete").run();
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await call(env, "/api/metrics/upload", desktop, oldUpload())).status).toBe(500);
      expect((await call(env, "/api/teams/team/overview", desktop)).status).toBe(500);
      expect(logs.mock.calls.some(args => args.some(arg => String(arg).includes("cost_incomplete")))).toBe(true);
    } finally { logs.mockRestore(); }
  });

  it("requires migration 016 before a Worker that stores session starts", async () => {
    const { env, desktop } = await fixture();
    await env.DB.prepare("ALTER TABLE metric_hourly DROP COLUMN sessions_started").run();
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await call(env, "/api/metrics/upload", desktop, oldUpload())).status).toBe(500);
      expect(logs.mock.calls.some(args => args.some(arg => String(arg).includes("sessions_started")))).toBe(true);
    } finally { logs.mockRestore(); }
  });

  it("adds only its table/index to the HEAD schema and preserves all existing rows and definitions", async () => {
    const { env, desktop } = await fixture();
    await env.DB.prepare("DROP TABLE provider_accounts").run();
    // Later additive provider-account tables (migration 015) are not part of this comparison.
    await env.DB.prepare("DROP TABLE provider_account_activity").run();
    await env.DB.prepare("DROP TABLE provider_account_settings").run();
    // Nullable session-start counter (migration 016) is also later and additive.
    await env.DB.prepare("ALTER TABLE metric_hourly DROP COLUMN sessions_started").run();
    // Compare against the actual pre-feature schema, not a slice of the new schema.
    const head = new DatabaseSync(":memory:");
    try {
      head.exec(execFileSync("git", ["show", "e2f26037:teams-service/schema.sql"], {
        cwd: new URL("..", import.meta.url), encoding: "utf8",
      }));
      expect((await env.DB.prepare(catalogSql).all()).results).toEqual(head.prepare(catalogSql).all());
      // Restore 016 (the Worker writes it), then compare later steps against this schema.
      await env.DB.prepare("ALTER TABLE metric_hourly ADD COLUMN sessions_started INTEGER").run();
      const catalog = (await env.DB.prepare(catalogSql).all()).results;
      expect((await call(env, "/api/metrics/upload", desktop, oldUpload())).status).toBe(200);
      await env.DB.prepare("INSERT INTO team_policies (team_id,allowed_providers,allowed_models,updated_by,updated_at) VALUES ('team','[]','[]','owner','2026-09-12T00:00:00Z')").run();
      const tables = catalog.filter(row => row.type === "table").map(row => String(row.name));
      const snapshot = async () => Promise.all(tables.map(async table => ({
        table, rows: (await env.DB.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()).results,
      })));
      const before = await snapshot();
      for (const statement of migration.split(";").filter(sql => sql.trim())) {
        await env.DB.prepare(statement).run();
      }
      expect(await snapshot()).toEqual(before);
      const after = (await env.DB.prepare(catalogSql).all()).results;
      expect(after.filter(row => row.tbl_name !== "provider_accounts")).toEqual(catalog);
      expect(after.filter(row => row.tbl_name === "provider_accounts").map(row => [row.type, row.name])).toEqual([
        ["index", "idx_provider_accounts_pool"], ["table", "provider_accounts"],
      ]);
      expect((await env.DB.prepare("SELECT * FROM provider_accounts").all()).results).toEqual([]);
      expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
      expect((await call(env, "/api/auth/me", desktop)).body.data.user.id).toBe("employee");
      expect((await call(env, "/api/teams/team/overview", desktop)).body.data.totals.tokens).toBe(1500);
    } finally { head.close(); }
  });

  for (const [label, key] of [["absent", undefined], ["present", btoa("k".repeat(32))]] as const) {
    it(`keeps old device linking, cookies and bearer tokens working with key ${label}`, async () => {
      const { env, desktop, cookie } = await fixture(key);
      expect(await call(env, "/api/auth/me")).toEqual({ status: 200, body: { ok: true, data: { user: null } } });
      expect((await call(env, "/api/teams")).status).toBe(401);
      expect((await call(env, "/api/auth/me", desktop)).body.data).toMatchObject({
        user: { id: "employee" }, via: "device", deviceId: "old-device", providers: [], hasGithub: false,
      });
      expect((await call(env, "/api/auth/me", cookie)).body.data).toMatchObject({ user: { id: "owner" }, via: "cookie" });
      const start = await call(env, "/api/auth/device/start", {}, { deviceId: "linked-device" });
      expect(start.status).toBe(200);
      expect(start.body.data).toEqual({ code: expect.any(String), url: expect.any(String), expiresInSeconds: 1800 });
      expect(new URL(start.body.data.url).pathname).toBe("/link");
      const { code } = start.body.data;
      expect((await call(env, "/api/auth/device/claim", {}, { code })).body.data).toEqual({ pending: true, token: null });
      expect((await call(env, "/api/auth/device/attach", cookie, { code })).status).toBe(200);
      const claim = await call(env, "/api/auth/device/claim", {}, { code });
      expect(claim.status).toBe(200);
      expect(claim.body.data).toMatchObject({ pending: false, token: expect.any(String), user: { id: "owner" } });
      const linked = { authorization: `Bearer ${claim.body.data.token}` };
      expect((await call(env, "/api/teams", linked)).body.data.teams[0].role).toBe("owner");
      expect((await call(env, "/api/auth/device/revoke", linked, {})).body.data).toEqual({ revoked: true });
      expect((await call(env, "/api/teams", linked)).status).toBe(401);
      expect((await call(env, "/api/auth/logout", cookie, {})).body.data).toEqual({ signedOut: true });
      expect((await call(env, "/api/auth/me", cookie)).body.data).toEqual({ user: null });
    });

    it(`preserves old upload/dashboard, teams, features and billing responses with key ${label} and an empty pool`, async () => {
      const { env, desktop, cookie } = await fixture(key);
      const listing = await call(env, "/api/teams", desktop);
      expect(listing).toEqual({ status: 200, body: { ok: true, data: {
        teams: [{ id: "team", slug: "team", name: "Helios Platform", role: "employee", member_count: 2, last_upload_at: null, staffPreview: false }],
        features: { knowledge: true },
      } } });
      // No new account fields, capability header or client-version header.
      const upload = oldUpload();
      const accepted = await call(env, "/api/metrics/upload", desktop, upload);
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({ ok: true, data: { accepted: true, duplicate: false, bucketsApplied: 1, acceptedAt: expect.any(String) } });
      const replay = await call(env, "/api/metrics/upload", desktop, upload);
      expect(replay.body.data).toMatchObject({ accepted: true, duplicate: true, acceptedAt: accepted.body.data.acceptedAt });
      expect((await call(env, "/api/metrics/upload", cookie, upload)).status).toBe(403);
      const overview = await call(env, "/api/teams/team/overview", desktop);
      expect(overview.status).toBe(200);
      expect(overview.body.data).toMatchObject({ scope: "self", role: "employee", totals: { tokens: 1500, costUsd: 0.42, sessions: 1 } });
      const sync = await call(env, "/api/metrics/sync-state", desktop);
      expect(sync.status).toBe(200);
      expect(sync.body.data).toMatchObject({ devices: [{ device_id: "old-device" }], uploads: [{ device_id: "old-device" }], teamsReceiving: [{ id: "team" }] });
      const paths = ["/api/teams", "/api/teams/team", "/api/teams/team/billing", "/api/teams/team/overview", "/api/teams/team/policy"];
      const before = await Promise.all(paths.map(path => call(env, path, cookie)));
      for (const response of before) expect(response.status).toBe(200);
      expect(before[1]!.body.data.features).toEqual({ knowledge: true });
      expect(before[2]!.body.data.prices).toMatchObject({ freeSeats: 3, monthlyUsd: 12 });
      const pool = await call(env, "/api/teams/team/provider-accounts", desktop);
      if (key === undefined) {
        expect(pool.status).toBe(503);
        expect(pool.body.code).toBe("provider_accounts_not_configured");
      } else {
        expect(pool).toEqual({ status: 200, body: { ok: true, data: { accounts: [] } } });
      }
      // Switching feature configuration cannot alter any old response envelope.
      env.PROVIDER_ACCOUNTS_KEY = key === undefined ? btoa("k".repeat(32)) : undefined;
      expect(await Promise.all(paths.map(path => call(env, path, cookie)))).toEqual(before);
      expect((await env.DB.prepare("SELECT * FROM provider_accounts").all()).results).toEqual([]);
    });

    it(`preserves HTML Accept OAuth routing with key ${label}`, async () => {
      const { env } = await fixture(key);
      env.GITHUB_CLIENT_ID = "compat-github";
      env.GOOGLE_CLIENT_ID = "compat-google";
      env.GITHUB_CLIENT_SECRET = "test-only-github";
      env.GOOGLE_CLIENT_SECRET = "test-only-google";
      const assets = vi.fn(async () => new Response("SPA"));
      env.ASSETS = { fetch: assets } as unknown as Fetcher;
      for (const provider of ["github", "google"]) {
        const response = await worker.fetch(new Request(`https://teams.agmux.dev/api/auth/${provider}/start`, {
          headers: { Accept: "text/html,application/xhtml+xml" },
        }), env);
        expect(response.status).toBe(302);
        const location = new URL(response.headers.get("location")!);
        expect(location.hostname).toBe(provider === "github" ? "github.com" : "accounts.google.com");
        expect(location.searchParams.get("redirect_uri")).toBe(`https://teams.agmux.dev/api/auth/${provider}/callback`);
        expect(response.headers.get("set-cookie")).toContain("__Host-agmux_oauth=");
      }
      expect(assets).not.toHaveBeenCalled();
      // The Worker-only test cannot emulate Cloudflare's asset pre-routing;
      // pin the deployment setting that keeps HTML navigations Worker-first.
      const config = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
      expect(config).toMatch(/^run_worker_first\s*=\s*\["\/api\/\*"\]/m);
    });
  }
});
