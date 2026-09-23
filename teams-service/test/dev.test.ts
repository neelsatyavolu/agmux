import { describe, expect, it } from "vitest";
import { SEED_CAST, applySeed, devEnabled, generateSeed, requireDev } from "../src/dev";
import { totals, type Bucket } from "../src/aggregate";
import { devLogin } from "../src/routes/dev";
import { deviceAttach } from "../src/routes/auth";
import { claimLinkCode, createLinkCode, createSession } from "../src/session";
import { makeEnv, seedUser } from "./helpers/d1";
import type { Env } from "../src/env";

const req = (url: string) => new Request(url);

describe("dev-mode guard", () => {
  /** The env the `dev` npm script produces. */
  const devEnv = (over: Record<string, unknown> = {}) =>
    makeEnv({ DEV_AUTH: "true", APP_ORIGIN: "http://localhost:8787", ...over });

  it("is on for the exact env the dev script sets", () => {
    expect(devEnabled(devEnv())).toBe(true);
  });

  it("is off unless DEV_AUTH is exactly true", () => {
    for (const flag of [undefined, "false", "1", "TRUE", "yes", ""]) {
      expect(devEnabled(devEnv({ DEV_AUTH: flag }))).toBe(false);
    }
  });

  it("accepts a boolean true, because --var JSON-parses the value", () => {
    // `wrangler dev --var DEV_AUTH:true` yields a boolean, not a string.
    expect(devEnabled(devEnv({ DEV_AUTH: true as unknown as string }))).toBe(true);
  });

  it("is off for any non-local APP_ORIGIN, even with the flag set", () => {
    // This is the gate that keeps dev mode dead on a real deployment.
    for (const origin of [
      "https://teams.agmux.dev",
      "https://agmux-teams.xanom.workers.dev",
      "https://evil.example",
      "https://localhost.evil.example",
      "not a url",
      "",
    ]) {
      expect(devEnabled(devEnv({ APP_ORIGIN: origin }))).toBe(false);
    }
  });

  it("allows the usual local origins", () => {
    for (const origin of [
      "http://localhost:8787",
      "http://127.0.0.1:8787",
      "http://0.0.0.0:8787",
      "http://app.localhost:8787",
    ]) {
      expect(devEnabled(devEnv({ APP_ORIGIN: origin }))).toBe(true);
    }
  });

  it("ignores the request hostname, which wrangler simulates from routes", () => {
    // With `routes` naming a custom domain, `wrangler dev` reports that
    // hostname locally. Dev mode must not depend on it in either direction.
    expect(devEnabled(devEnv(), req("https://teams.agmux.dev/api/dev/login"))).toBe(true);
    expect(
      devEnabled(
        devEnv({ APP_ORIGIN: "https://teams.agmux.dev" }),
        req("http://localhost:8787/api/dev/login"),
      ),
    ).toBe(false);
  });

  it("throws 404 rather than 403, so the routes stay invisible", () => {
    const env = makeEnv({ DEV_AUTH: "false" });
    expect(() => requireDev(env)).toThrow();
    try {
      requireDev(env);
    } catch (e) {
      expect(e).toMatchObject({ status: 404 });
    }
  });
});

describe("dev login and the desktop link handshake", () => {
  const post = (url: string, body: unknown) =>
    new Request(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });

  async function unwrap<T>(res: Response): Promise<T> {
    const body = (await res.json()) as { ok: boolean; data: T };
    expect(body.ok).toBe(true);
    return body.data;
  }

  it("signs in without OAuth and sets a session cookie", async () => {
    const env = makeEnv({ DEV_AUTH: "true", APP_ORIGIN: "http://localhost:8787" });
    const res = await devLogin(post("http://localhost:8787/api/dev/login", { name: "You" }), env);
    const data = await unwrap<{ userId: string; linked: boolean }>(res);

    expect(data.userId).toMatch(/^usr_/);
    expect(data.linked).toBe(false);
    expect(res.headers.get("set-cookie")).toContain("__Host-agmux_teams=");
  });

  it("reuses the same user across sign-ins, so seeded history stays attached", async () => {
    const env = makeEnv({ DEV_AUTH: "true", APP_ORIGIN: "http://localhost:8787" });
    const a = await unwrap<{ userId: string }>(
      await devLogin(post("http://localhost:8787/api/dev/login", {}), env),
    );
    const b = await unwrap<{ userId: string }>(
      await devLogin(post("http://localhost:8787/api/dev/login", {}), env),
    );
    expect(a.userId).toBe(b.userId);
  });

  it("completes the desktop device link, which OAuth would normally do", async () => {
    const env = makeEnv({ DEV_AUTH: "true", APP_ORIGIN: "http://localhost:8787" });
    const code = await createLinkCode(env, "sim-desktop", "agmux desktop");

    // Before sign-in the desktop's poll must report pending, not fail.
    expect(await claimLinkCode(env, code)).toBeNull();

    const data = await unwrap<{ linked: boolean }>(
      await devLogin(post("http://localhost:8787/api/dev/login", { name: "You", linkCode: code }), env),
    );
    expect(data.linked).toBe(true);

    const token = await claimLinkCode(env, code);
    expect(token).toBeTruthy();
    expect(token!.length).toBe(64);
    // One-shot: a replayed claim must not mint a second token.
    expect(await claimLinkCode(env, code)).toBeNull();
  });

  it("binds a pending link code to the signed-in user via /device/attach", async () => {
    // This is the seam that broke in production: the OAuth flow never carried
    // the code, so the desktop polled forever while the web claimed success.
    const env = makeEnv({ DEV_AUTH: "true", APP_ORIGIN: "http://localhost:8787" });
    const code = await createLinkCode(env, "sim-desktop", "agmux desktop");

    // Sign in WITHOUT passing linkCode — exactly what real OAuth does.
    const login = await devLogin(post("http://localhost:8787/api/dev/login", { name: "You" }), env);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    expect(await claimLinkCode(env, code)).toBeNull();

    const attachReq = new Request("http://localhost:8787/api/auth/device/attach", {
      method: "POST",
      body: JSON.stringify({ code }),
      headers: { "content-type": "application/json", cookie },
    });
    const res = await deviceAttach(attachReq, env);
    expect(await unwrap<{ attached: boolean }>(res)).toEqual({ attached: true });

    const token = await claimLinkCode(env, code);
    expect(token).toBeTruthy();
    expect(token!.length).toBe(64);
  });

  it("refuses to attach without a session", async () => {
    const env = makeEnv({ DEV_AUTH: "true", APP_ORIGIN: "http://localhost:8787" });
    const code = await createLinkCode(env, "sim-desktop", null);
    await expect(
      deviceAttach(post("http://localhost:8787/api/auth/device/attach", { code }), env),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("reports a real error for an unknown code, but is idempotent after claim", async () => {
    const env = makeEnv({ DEV_AUTH: "true", APP_ORIGIN: "http://localhost:8787" });
    const login = await devLogin(post("http://localhost:8787/api/dev/login", {}), env);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const attach = (code: string) =>
      deviceAttach(
        new Request("http://localhost:8787/api/auth/device/attach", {
          method: "POST",
          body: JSON.stringify({ code }),
          headers: { "content-type": "application/json", cookie },
        }),
        env,
      );

    await expect(attach("not-a-real-code")).rejects.toMatchObject({ status: 400 });

    const code = await createLinkCode(env, "sim-desktop", null);
    await attach(code);
    await claimLinkCode(env, code);
    // Refreshing /link?code=… after the desktop claimed must still succeed —
    // the code is already bound to this user.
    expect(await unwrap<{ attached: boolean }>(await attach(code))).toEqual({ attached: true });
  });

  it("refuses to re-bind a code already claimed by a different user", async () => {
    const env = makeEnv({ DEV_AUTH: "true", APP_ORIGIN: "http://localhost:8787" });
    const code = await createLinkCode(env, "sim-desktop", null);

    const aliceId = await seedUser(env, "usr_alice", "Alice");
    const bobId = await seedUser(env, "usr_bob", "Bob");
    const aliceToken = await createSession(env, aliceId);
    const bobToken = await createSession(env, bobId);
    const cookieFor = (token: string) => `__Host-agmux_teams=${token}`;

    await deviceAttach(
      new Request("http://localhost:8787/api/auth/device/attach", {
        method: "POST",
        body: JSON.stringify({ code }),
        headers: {
          "content-type": "application/json",
          cookie: cookieFor(aliceToken),
        },
      }),
      env,
    );
    await claimLinkCode(env, code);

    await expect(
      deviceAttach(
        new Request("http://localhost:8787/api/auth/device/attach", {
          method: "POST",
          body: JSON.stringify({ code }),
          headers: {
            "content-type": "application/json",
            cookie: cookieFor(bobToken),
          },
        }),
        env,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses dev login entirely on a deployed origin", async () => {
    const env = makeEnv({ DEV_AUTH: "true", APP_ORIGIN: "https://teams.agmux.dev" });
    await expect(
      devLogin(post("https://teams.agmux.dev/api/dev/login", { name: "You" }), env),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("seed generation", () => {
  const NOW = new Date("2026-07-29T12:00:00Z");

  it("produces activity for everyone except the never-syncs member", () => {
    const buckets = generateSeed(SEED_CAST, 90, NOW);
    const keys = new Set(buckets.map((b) => b.userKey));
    expect(keys.has("you")).toBe(true);
    expect(keys.has("dani")).toBe(true);
    // Riley exists on the roster but has never uploaded — that is the point.
    expect(keys.has("riley")).toBe(false);
  });

  it("is deterministic, so reseeding does not reshuffle the dashboard", () => {
    const a = generateSeed(SEED_CAST, 30, NOW);
    const b = generateSeed(SEED_CAST, 30, NOW);
    expect(a.length).toBe(b.length);
    expect(a[0]).toEqual(b[0]);
    expect(a.at(-1)).toEqual(b.at(-1));
  });

  it("stays inside the requested window", () => {
    const buckets = generateSeed(SEED_CAST, 7, NOW);
    const hours = buckets.map((b) => b.hourUtc).sort();
    expect(hours[0] >= "2026-07-23T00").toBe(true);
    expect(hours.at(-1)! <= "2026-07-29T23").toBe(true);
  });

  it("keeps after-hours and weekend time within active time", () => {
    for (const b of generateSeed(SEED_CAST, 30, NOW)) {
      expect(b.afterHoursMs).toBeLessThanOrEqual(b.activeMs);
      expect(b.weekendMs).toBeLessThanOrEqual(b.activeMs);
      expect(b.localHour).toBeGreaterThanOrEqual(0);
      expect(b.localHour).toBeLessThan(24);
      expect(b.localDow).toBeGreaterThanOrEqual(0);
      expect(b.localDow).toBeLessThan(7);
    }
  });

  it("emits no duplicate bucket keys, so nothing is lost on insert", () => {
    // metric_hourly's primary key is (team, user, device, hour, provider,
    // model, project). Duplicates here would be silently collapsed by the
    // database, losing activity and leaving incoherent counters behind.
    const buckets = generateSeed(SEED_CAST, 90, NOW);
    const keys = buckets.map((b) =>
      [b.userKey, b.hourUtc, b.provider, b.model, b.projectKey].join("|"),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("merges same-hour activity instead of dropping it", () => {
    const merged = generateSeed(SEED_CAST, 90, NOW);
    // Merging must preserve totals, not discard the collided rows.
    const totalSessions = merged.reduce((a, b) => a + b.sessions, 0);
    expect(totalSessions).toBeGreaterThan(merged.length);
    for (const b of merged) {
      expect(b.peakConcurrent).toBeGreaterThanOrEqual(1);
    }
  });

  it("never emits a path as a project key", () => {
    for (const b of generateSeed(SEED_CAST, 30, NOW)) {
      expect(b.projectKey).not.toMatch(/[/\\]/);
    }
  });

  it("gives the dashboard enough shape to be worth looking at", () => {
    const buckets = generateSeed(SEED_CAST, 30, NOW);
    const asBuckets: Bucket[] = buckets.map((b) => ({
      user_id: b.userKey,
      hour_utc: b.hourUtc,
      provider: b.provider,
      model: b.model,
      project_key: b.projectKey,
      tokens_in: b.tokensIn,
      tokens_out: b.tokensOut,
      tokens_cache_read: b.tokensCacheRead,
      tokens_cache_write: b.tokensCacheWrite,
      tokens_reasoning: 0,
      cost_usd: b.costUsd,
      active_ms: b.activeMs,
      after_hours_ms: b.afterHoursMs,
      weekend_ms: b.weekendMs,
      sessions: b.sessions,
      turns: b.turns,
      tool_calls: b.toolCalls,
      peak_concurrent: b.peakConcurrent,
      tool_bash: b.toolBash,
      tool_edit: b.toolEdit,
      tool_read: b.toolRead,
      tool_search: b.toolSearch,
      tool_web: b.toolWeb,
      tool_agent: b.toolAgent,
      tool_mcp: b.toolMcp,
      tool_other: b.toolOther,
      tool_errors: b.toolErrors,
      tools_measured: b.toolsMeasured,
      files_changed: b.filesChanged,
      lines_added: b.linesAdded,
      lines_removed: b.linesRemoved,
      approval_requests: 0,
      approval_wait_ms: 0,
      local_hour: b.localHour,
      local_dow: b.localDow,
    }));

    const t = totals(asBuckets);
    expect(t.tokens).toBeGreaterThan(1_000_000);
    expect(t.activeHours).toBeGreaterThan(20);
    expect(t.sessions).toBeGreaterThan(50);
    // Dani's after-hours tail should be visible at the team level.
    expect(t.afterHoursShare).toBeGreaterThan(0.02);
    expect(t.daysWithData).toBeGreaterThan(15);
  });

  it("seeds a tool mix and output counters worth rendering", () => {
    const buckets = generateSeed(SEED_CAST, 30, NOW);
    const sum = (pick: (b: (typeof buckets)[number]) => number) =>
      buckets.reduce((a, b) => a + pick(b), 0);

    // Every kind column must be exercised, or a dev-mode chart looks broken
    // for reasons that have nothing to do with the code under test.
    expect(sum((b) => b.toolBash)).toBeGreaterThan(0);
    expect(sum((b) => b.toolEdit)).toBeGreaterThan(0);
    expect(sum((b) => b.toolRead)).toBeGreaterThan(0);
    expect(sum((b) => b.toolSearch)).toBeGreaterThan(0);
    expect(sum((b) => b.linesAdded)).toBeGreaterThan(0);
    expect(sum((b) => b.filesChanged)).toBeGreaterThan(0);

    // The kind columns must re-sum to the tool-call total, exactly as the
    // desktop scanner guarantees.
    for (const b of buckets) {
      const kinds =
        b.toolBash + b.toolEdit + b.toolRead + b.toolSearch + b.toolWeb + b.toolAgent + b.toolMcp + b.toolOther;
      expect(kinds).toBe(b.toolCalls);
    }

    // Codex buckets must show fewer measured calls than calls made, so the
    // honest-denominator path is visible in dev.
    const codex = buckets.filter((b) => b.provider === "Codex" && b.toolCalls > 20);
    if (codex.length) {
      expect(codex.some((b) => b.toolsMeasured < b.toolCalls)).toBe(true);
    }
  });

  it("spreads work across providers so the mix chart has more than one track", () => {
    const buckets = generateSeed(SEED_CAST, 30, NOW);
    const providers = new Set(buckets.map((b) => b.provider));
    expect(providers.size).toBeGreaterThan(1);
  });
});

describe("applySeed", () => {
  async function seeded(env: Env) {
    const you = await seedUser(env, "usr_you", "You");
    // The cast is matched by handle, so give "you" the handle the seeder expects.
    await env.DB.prepare("UPDATE users SET handle = 'you' WHERE id = ?").bind(you).run();
    return { you, result: await applySeed(env, you, 30, new Date("2026-07-29T12:00:00Z")) };
  }

  it("creates the team with you as owner and the full cast as members", async () => {
    const env = makeEnv({ DEV_AUTH: "true", APP_ORIGIN: "http://localhost:8787" });
    const { you, result } = await seeded(env);

    expect(result.slug).toBe("helios-platform");
    expect(result.members).toBe(SEED_CAST.length);

    const mine = await env.DB.prepare(
      "SELECT role FROM team_members WHERE team_id = ? AND user_id = ?",
    )
      .bind(result.teamId, you)
      .first<{ role: string }>();
    expect(mine!.role).toBe("owner");

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND left_at IS NULL",
    )
      .bind(result.teamId)
      .first<{ n: number }>();
    expect(count!.n).toBe(SEED_CAST.length);
  });

  it("writes metrics for the team", async () => {
    const env = makeEnv({ DEV_AUTH: "true", APP_ORIGIN: "http://localhost:8787" });
    const { result } = await seeded(env);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM metric_hourly WHERE team_id = ?",
    )
      .bind(result.teamId)
      .first<{ n: number }>();
    expect(rows!.n).toBe(result.buckets);
    expect(rows!.n).toBeGreaterThan(100);
  });

  it("replaces rather than accumulating when reseeded", async () => {
    const env = makeEnv({ DEV_AUTH: "true", APP_ORIGIN: "http://localhost:8787" });
    const { you } = await seeded(env);
    const first = await env.DB.prepare("SELECT COUNT(*) AS n FROM metric_hourly").first<{ n: number }>();

    await applySeed(env, you, 30, new Date("2026-07-29T12:00:00Z"));
    const second = await env.DB.prepare("SELECT COUNT(*) AS n FROM metric_hourly").first<{ n: number }>();

    expect(second!.n).toBe(first!.n);
  });

  it("leaves the never-synced member with no metrics and no sync row", async () => {
    const env = makeEnv({ DEV_AUTH: "true", APP_ORIGIN: "http://localhost:8787" });
    const { result } = await seeded(env);

    const riley = await env.DB.prepare("SELECT id FROM users WHERE handle = 'rchen'").first<{
      id: string;
    }>();
    expect(riley).toBeTruthy();

    const metrics = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM metric_hourly WHERE team_id = ? AND user_id = ?",
    )
      .bind(result.teamId, riley!.id)
      .first<{ n: number }>();
    expect(metrics!.n).toBe(0);

    const sync = await env.DB.prepare("SELECT COUNT(*) AS n FROM sync_state WHERE user_id = ?")
      .bind(riley!.id)
      .first<{ n: number }>();
    expect(sync!.n).toBe(0);
  });

  it("staggers sync freshness so healthy, stale and never all appear", async () => {
    const env = makeEnv({ DEV_AUTH: "true", APP_ORIGIN: "http://localhost:8787" });
    const you = await seedUser(env, "usr_you", "You");
    await env.DB.prepare("UPDATE users SET handle = 'you' WHERE id = ?").bind(you).run();
    // Freshness is relative to the seed's `now`, so use the real clock here —
    // the point is that the roster shows all three states when you look at it.
    await applySeed(env, you, 30);

    const rows = await env.DB.prepare("SELECT last_upload_at FROM sync_state").all<{
      last_upload_at: string;
    }>();
    const ages = (rows.results ?? []).map((r: { last_upload_at: string }) =>
      Date.now() - Date.parse(r.last_upload_at),
    );
    expect(ages.length).toBeGreaterThan(0);
    expect(ages.some((a: number) => a < 3_600_000)).toBe(true); // healthy, green
    expect(ages.some((a: number) => a > 86_400_000)).toBe(true); // stale, amber
    // Riley never uploads, so there is no row at all — that is the third state.
    expect(ages.length).toBeLessThan(SEED_CAST.length);
  });
});
