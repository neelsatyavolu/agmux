import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { makeEnv, seedUser, seedTeam, addMember, seedGithubUser } from "./helpers/d1";
import { createDeviceToken, createSession } from "../src/session";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const credentials = { auth_mode: "chatgpt", tokens: { access_token: "access-secret", refresh_token: "refresh-secret", id_token: `header.${btoa(JSON.stringify({ sub: "subject" }))}.signature`, account_id: "acct" }, last_refresh: "2026-09-21T00:00:00Z" };
const grok = { "https://auth.x.ai::grok-build": { key: "grok-secret", refreshToken: "grok-refresh", user_id: "grok-user" } };
async function fixture() {
  const env = makeEnv();
  Object.assign(env, { PROVIDER_ACCOUNTS_KEY: btoa("k".repeat(32)) });
  for (const id of ["owner", "manager", "employee", "other", "peer"]) await seedUser(env, id);
  await seedTeam(env, "team", "owner");
  await seedTeam(env, "second", "owner");
  for (const [id, role] of [["manager", "manager"], ["peer", "manager"], ["employee", "employee"], ["other", "employee"]] as const) await addMember(env, "team", id, role);
  const tokens: Record<string, string> = {};
  for (const id of ["owner", "manager", "employee", "other", "peer"]) tokens[id] = await createDeviceToken(env, id, `${id}-device`, null);
  tokens.secondDevice = await createDeviceToken(env, "employee", "second-device", null);
  tokens.cookie = await createSession(env, "employee");
  await seedGithubUser(env, "staff", "neelsatyavolu");
  tokens.staff = await createSession(env, "staff");
  async function call(who: string, method = "GET", suffix = "", body?: unknown, team = "team") {
    const headers: Record<string, string> = who === "staff" || who === "cookie" ? { cookie: `__Host-agmux_teams=${tokens[who]}` } : { authorization: `Bearer ${tokens[who]}` };
    const response = await worker.fetch(new Request(`https://teams.agmux.dev/api/teams/${team}/provider-accounts${suffix}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
    return { status: response.status, headers: response.headers, ...await response.json() as any };
  }
  let serial = 0;
  const add = (who = "owner", provider = "codex") => call(who, "POST", "", { provider, label: "Team account", credentials: provider === "codex" ? { ...credentials, tokens: { ...credentials.tokens, account_id: serial++ ? `acct-${serial}` : "acct" } } : grok });
  const allocate = (who = "employee", extra = {}) => call(who, "POST", "/allocate", { provider: "codex", sessionId: "session", ...extra });
  return { env, call, add, allocate };
}

describe("provider account pool", () => {
  it("applies the additive migration to an existing database and matches the fresh schema", () => {
    const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
    const migration = readFileSync(new URL("../migrations/013_provider_accounts.sql", import.meta.url), "utf8");
    const upgraded = new DatabaseSync(":memory:"), fresh = new DatabaseSync(":memory:");
    try {
      upgraded.exec(schema.slice(0, schema.indexOf("-- Explicitly shared team OAuth credentials")));
      upgraded.exec(migration);
      fresh.exec(schema);
      expect(upgraded.prepare("PRAGMA table_info(provider_accounts)").all()).toEqual(fresh.prepare("PRAGMA table_info(provider_accounts)").all());
    } finally { upgraded.close(); fresh.close(); }
  });

  it("binds AES-GCM ciphertext to team/account/provider and fails without leaking crypto errors", async () => {
    const { env, add, allocate, call } = await fixture();
    const a = (await add()).data.account, b = (await add()).data.account;
    const source = await env.DB.prepare("SELECT credentials_ciphertext FROM provider_accounts WHERE id=?").bind(a.id).first<{ credentials_ciphertext: string }>();
    await env.DB.prepare("UPDATE provider_accounts SET credentials_ciphertext=? WHERE id=?").bind(source!.credentials_ciphertext, b.id).run();
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await allocate("employee", { excludeIds: [a.id] })).status).toBe(503);
      expect(logs).not.toHaveBeenCalled();
      expect((await call("owner")).data.accounts.find((x: any) => x.id === b.id).leasedUntil).toBeNull();
    } finally { logs.mockRestore(); }
  });

  it("uses LRU for equal capacity and keeps exhausted accounts unavailable without a reset", async () => {
    const { env, add, allocate, call } = await fixture();
    const a = (await add()).data.account, b = (await add()).data.account;
    await env.DB.prepare("UPDATE provider_accounts SET remaining_percent=50,last_used_at=20 WHERE id=?").bind(a.id).run();
    await env.DB.prepare("UPDATE provider_accounts SET remaining_percent=50,last_used_at=10 WHERE id=?").bind(b.id).run();
    const lease = (await allocate()).data;
    expect(lease.account.id).toBe(b.id);
    await call("employee", "POST", `/leases/${lease.leaseId}/renew`, { remainingPercent: 0 });
    await call("employee", "DELETE", `/leases/${lease.leaseId}`);
    expect((await allocate("employee", { excludeIds: [a.id] })).status).toBe(409);
  });

  it("ages positive headroom to unknown in metadata and ranking, but never forgets stale exhaustion", async () => {
    const { env, add, call, allocate } = await fixture();
    const a = (await add()).data.account, b = (await add()).data.account;
    const time = Math.floor(Date.now() / 1000);
    await env.DB.prepare("UPDATE provider_accounts SET remaining_percent=90,health_reported_at=?,last_used_at=1 WHERE id=?").bind(time-301, a.id).run();
    await env.DB.prepare("UPDATE provider_accounts SET remaining_percent=20,health_reported_at=?,last_used_at=2 WHERE id=?").bind(time, b.id).run();
    const listed = (await call("owner")).data.accounts;
    expect(listed.find((x: any) => x.id === a.id).remainingPercent).toBeNull();
    expect(listed.find((x: any) => x.id === b.id).remainingPercent).toBe(20);
    const lease = (await allocate()).data;
    expect(lease.account.id).toBe(b.id);
    await call("employee", "DELETE", `/leases/${lease.leaseId}`);
    await env.DB.prepare("UPDATE provider_accounts SET remaining_percent=0 WHERE id=?").bind(a.id).run();
    expect((await allocate("employee", { excludeIds: [b.id] })).status).toBe(409);
    expect((await call("owner")).data.accounts.find((x: any) => x.id === a.id).remainingPercent).toBe(0);
    await env.DB.prepare("UPDATE provider_accounts SET blocked_until=? WHERE id=?").bind(time+600, a.id).run();
    expect((await allocate("employee", { excludeIds: [b.id] })).status).toBe(409);
    await env.DB.prepare("UPDATE provider_accounts SET blocked_until=? WHERE id=?").bind(time-1, a.id).run();
    const reset = await allocate("employee", { excludeIds: [b.id] });
    expect(reset.status).toBe(200);
    expect(reset.data.account.remainingPercent).toBeNull();
  });

  it("reports the last measured headroom separately from fresh capacity", async () => {
    const { env, add, call } = await fixture();
    const a = (await add()).data.account;
    const time = Math.floor(Date.now() / 1000);
    await env.DB.prepare("UPDATE provider_accounts SET remaining_percent=90,health_reported_at=? WHERE id=?").bind(time-3600, a.id).run();
    let row = (await call("employee")).data.accounts[0];
    expect(row.remainingPercent).toBeNull();
    expect(row.lastRemainingPercent).toBe(90);
    expect(row.healthReportedAt).toBe(time-3600);
    await env.DB.prepare("UPDATE provider_accounts SET remaining_percent=0,blocked_until=? WHERE id=?").bind(time-1, a.id).run();
    row = (await call("employee")).data.accounts[0];
    expect(row.remainingPercent).toBeNull();
    expect(row.lastRemainingPercent).toBeNull();
  });

  it("leases one exact account for a usage check, including exhausted ones, and never a leased or paused one", async () => {
    const { env, add, call, allocate } = await fixture();
    const a = (await add()).data.account, b = (await add()).data.account;
    const time = Math.floor(Date.now() / 1000);
    await env.DB.prepare("UPDATE provider_accounts SET remaining_percent=0,blocked_until=?,health_reported_at=? WHERE id=?").bind(time+600, time, a.id).run();
    const check = await call("employee", "POST", `/${a.id}/check`);
    expect(check.status).toBe(200);
    expect(check.headers.get("cache-control")).toBe("no-store");
    expect(check.data.account.id).toBe(a.id);
    expect(check.data.credentials.tokens.refresh_token).toBe("refresh-secret");
    expect((await call("other", "POST", `/${a.id}/check`)).status).toBe(409);
    expect((await allocate("other", { excludeIds: [b.id] })).status).toBe(409);
    const renewed = await call("employee", "POST", `/leases/${check.data.leaseId}/renew`, { remainingPercent: 40, blockedUntil: 0 });
    expect(renewed.status).toBe(200);
    expect((await call("employee", "DELETE", `/leases/${check.data.leaseId}`)).status).toBe(200);
    const row = (await call("owner")).data.accounts.find((x: any) => x.id === a.id);
    expect(row.remainingPercent).toBe(40);
    expect(row.leasedUntil).toBeNull();
    await call("owner", "PATCH", `/${b.id}`, { enabled: false });
    expect((await call("employee", "POST", `/${b.id}/check`)).status).toBe(404);
    expect((await call("employee", "POST", "/missing/check")).status).toBe(404);
    expect((await call("staff", "POST", `/${a.id}/check`)).status).toBe(403);
    expect((await call("cookie", "POST", `/${a.id}/check`)).status).toBe(403);
  });

  it("normalizes blockedUntil zero to NULL and preserves fresh positive capacity after clearing a block", async () => {
    const { env, add, call, allocate } = await fixture();
    await add();
    const lease = (await allocate()).data;
    expect((await call("employee", "POST", `/leases/${lease.leaseId}/renew`, {
      blockedUntil: Math.floor(Date.now() / 1000) + 600, remainingPercent: 0,
    })).status).toBe(200);
    expect((await call("employee", "POST", `/leases/${lease.leaseId}/renew`, {
      blockedUntil: 0, remainingPercent: 75,
    })).status).toBe(200);
    const account = (await call("owner")).data.accounts[0];
    expect(account.blockedUntil).toBeNull();
    expect(account.remainingPercent).toBe(75);
    expect((await env.DB.prepare("SELECT blocked_until FROM provider_accounts").first())?.blocked_until).toBeNull();
    await call("employee", "DELETE", `/leases/${lease.leaseId}`);
    const next = await allocate();
    expect(next.status).toBe(200);
    expect(next.data.account.remainingPercent).toBe(75);
    expect((await call("employee", "POST", `/leases/${next.data.leaseId}/renew`, { remainingPercent: 80 })).status).toBe(200);
    expect((await call("owner")).data.accounts[0].remainingPercent).toBe(80);
  });

  it("clears exhaustion to unknown when blockedUntil zero omits remainingPercent", async () => {
    const { env, add, call, allocate } = await fixture();
    await add();
    const lease = (await allocate()).data;
    await call("employee", "POST", `/leases/${lease.leaseId}/renew`, { remainingPercent: 0 });
    expect((await call("employee", "POST", `/leases/${lease.leaseId}/renew`, { blockedUntil: 0 })).status).toBe(200);
    const account = (await call("owner")).data.accounts[0];
    expect(account.blockedUntil).toBeNull();
    expect(account.remainingPercent).toBeNull();
    const stored = await env.DB.prepare("SELECT blocked_until,remaining_percent FROM provider_accounts").first();
    expect(stored?.blocked_until).toBeNull();
    expect(stored?.remaining_percent).toBeNull();
    await call("employee", "DELETE", `/leases/${lease.leaseId}`);
    const next = await allocate();
    expect(next.status).toBe(200);
    expect(next.data.account.remainingPercent).toBeNull();
  });

  it("fails closed before claiming with missing config or after device revocation", async () => {
    const { env, add, allocate } = await fixture();
    await add();
    Object.assign(env, { PROVIDER_ACCOUNTS_KEY: undefined });
    expect((await allocate()).status).toBe(503);
    expect((await env.DB.prepare("SELECT lease_id FROM provider_accounts").first())?.lease_id).toBeNull();
    Object.assign(env, { PROVIDER_ACCOUNTS_KEY: btoa("k".repeat(32)) });
    await env.DB.prepare("UPDATE device_tokens SET revoked_at='now' WHERE user_id='employee'").run();
    expect((await allocate()).status).toBe(401);
  });

  it("rejects invalid health, patches, exclusions and oversized/malformed bodies without secret echoes", async () => {
    const { add, allocate, call } = await fixture();
    const a = (await add()).data.account, lease = (await allocate()).data;
    for (const input of [{ remainingPercent: -1 }, { remainingPercent: 101 }, { blockedUntil: -1 }, { blockedUntil: 1.5 }, { credentials: grok }]) {
      expect((await call("employee", "POST", `/leases/${lease.leaseId}/renew`, input)).status).toBe(400);
    }
    expect((await call("owner", "PATCH", `/${a.id}`, { enabled: "false" })).status).toBe(400);
    expect((await allocate("other", { excludeIds: Array(51).fill(a.id) })).status).toBe(400);
    const oversized = await call("owner", "POST", "", { provider: "codex", label: "A", credentials: { ...credentials, padding: "access-secret".repeat(4000) } });
    expect(oversized.status).toBe(400);
    expect(JSON.stringify(oversized)).not.toContain("access-secret");
  });

  it("stores encrypted native credentials, exposes only metadata, and leases native JSON with no-store", async () => {
    const { env, add, call, allocate } = await fixture();
    const created = await add();
    expect(created.status).toBe(201);
    expect(created.data.account.remainingPercent).toBeNull();
    const row = await env.DB.prepare("SELECT * FROM provider_accounts").first();
    expect(JSON.stringify(row)).not.toContain("access-secret");
    expect(JSON.stringify(row)).not.toContain("refresh-secret");
    expect(JSON.stringify((await call("owner")).data)).not.toContain("credentials");
    const lease = await allocate();
    expect(lease.status).toBe(200);
    expect(lease.data.credentials).toEqual(credentials);
    expect(lease.data.expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(lease.headers.get("cache-control")).toBe("no-store");
  });

  it("returns per-account canManage for owners, creators, employees, peer managers and staff", async () => {
    const { add, call } = await fixture();
    const manager = (await add("manager")).data.account;
    const owner = (await add()).data.account;
    expect(manager.canManage).toBe(true);
    expect(owner.canManage).toBe(true);
    for (const who of ["owner", "manager", "employee", "peer", "staff"]) {
      const accounts = (await call(who)).data.accounts;
      for (const a of accounts) expect(a.canManage).toBe(who === "owner" || (who === "manager" && a.id === manager.id));
    }
    expect((await call("owner", "PATCH", `/${manager.id}`, { label: "Renamed" })).data.account.canManage).toBe(true);
  });

  it("gates management by live roles and staff is metadata-only", async () => {
    const { add, call, allocate, env } = await fixture();
    expect((await add("employee")).status).toBe(403);
    const account = (await add("manager")).data.account;
    expect((await call("peer", "PATCH", `/${account.id}`, { label: "stolen" })).status).toBe(404);
    expect((await call("staff")).status).toBe(200);
    expect((await add("staff")).status).toBe(403);
    expect((await allocate("staff")).status).toBe(403);
    expect((await allocate("cookie")).status).toBe(403);
    await env.DB.prepare("UPDATE team_members SET role='employee' WHERE user_id='manager'").run();
    expect((await call("manager", "DELETE", `/${account.id}`)).status).toBe(403);
    expect((await allocate("manager")).status).toBe(409);
    expect((await call("owner", "DELETE", `/${account.id}`)).status).toBe(200);
  });

  it("manager pool follows default whole-team employee scope and configured direct/group scope", async () => {
    const { env, add, allocate, call } = await fixture();
    await add("manager");
    const initial = await allocate();
    expect(initial.status).toBe(200);
    await call("employee", "DELETE", `/leases/${initial.data.leaseId}`);
    expect((await allocate("peer")).status).toBe(409);
    await env.DB.prepare("INSERT INTO manager_scope (id,team_id,manager_user_id,target_user_id,created_at) VALUES ('s','team','manager','employee','now')").run();
    expect((await allocate("other")).status).toBe(409);
    const lease = await allocate();
    expect(lease.status).toBe(200);
    await env.DB.prepare("UPDATE manager_scope SET target_user_id='other'").run();
    expect((await call("employee", "POST", `/leases/${lease.data.leaseId}/renew`, {})).status).toBe(404);
    expect((await call("employee", "DELETE", `/leases/${lease.data.leaseId}`)).status).toBe(200);
    await env.DB.prepare("INSERT INTO team_groups VALUES ('g','team','Group','now')").run();
    await env.DB.prepare("INSERT INTO team_group_members VALUES ('g','employee','now')").run();
    await env.DB.prepare("UPDATE manager_scope SET target_user_id=NULL,target_group_id='g'").run();
    expect((await allocate()).status).toBe(200);
  });

  it("deduplicates OAuth identities and reconnects only unleased accounts without moving manager scope", async () => {
    const { add, call, allocate, env } = await fixture();
    const original = (await add("manager")).data.account;
    const upload = (who: string, creds = credentials) => call(who, "POST", "", { provider: "codex", label: "Reconnected", credentials: creds });
    expect((await upload("peer")).status).toBe(409);
    const reconnect = await upload("owner", { ...credentials, last_refresh: "reconnected" });
    expect(reconnect.status).toBe(200);
    expect(reconnect.data.account).toMatchObject({ id: original.id, createdBy: "manager", scope: "manager" });
    expect((await call("owner")).data.accounts).toHaveLength(1);
    const lease = await allocate();
    expect(lease.data.credentials.last_refresh).toBe("reconnected");
    expect((await upload("owner")).status).toBe(409);
    expect((await call("employee", "POST", `/leases/${lease.data.leaseId}/renew`, {
      credentials: { ...credentials, tokens: { ...credentials.tokens, account_id: "different" } },
    })).status).toBe(400);
    await env.DB.prepare("UPDATE provider_accounts SET lease_expires_at=1").run();
    expect((await upload("manager")).status).toBe(200);
    const row = await env.DB.prepare("SELECT identity_hash FROM provider_accounts").first();
    expect(row?.identity_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("concurrent duplicate uploads create one account and one lease; distinct JWT subjects remain distinct", async () => {
    const { call, allocate } = await fixture();
    const upload = (creds: unknown) => call("owner", "POST", "", { provider: "codex", label: "Account", credentials: creds });
    const replies = await Promise.all([upload(credentials), upload(credentials)]);
    expect(replies.filter(r => r.status === 201)).toHaveLength(1);
    expect((await call("owner")).data.accounts).toHaveLength(1);
    expect((await allocate()).status).toBe(200);
    expect((await allocate("other")).status).toBe(409);
    expect((await upload({ ...credentials, tokens: { ...credentials.tokens, id_token: `header.${btoa(JSON.stringify({sub:"another"}))}.signature` } })).status).toBe(201);
  });

  it("deduplicates Grok by user ID and rejects missing or conflicting identity", async () => {
    const { call } = await fixture();
    const upload = (creds: unknown) => call("owner", "POST", "", { provider: "grok", label: "Account", credentials: creds });
    const created = await upload(grok);
    const reconnect = await upload({ "https://auth.x.ai::grok-build": { ...grok["https://auth.x.ai::grok-build"], key: "rotated" } });
    expect(reconnect.status).toBe(200);
    expect(reconnect.data.account.id).toBe(created.data.account.id);
    expect((await upload({ "https://auth.x.ai::grok-build": {key:"secret"} })).status).toBe(400);
    expect((await upload({ ...grok, "https://accounts.x.ai/sign-in": {key:"secret", user_id:"other"} })).status).toBe(400);
  });

  it("distinguishes an absent feature key from invalid keys and storage failures", async () => {
    const { env, add, allocate, call } = await fixture();
    await add();
    Object.assign(env, { PROVIDER_ACCOUNTS_KEY: undefined });
    for (const reply of [await call("owner"), await allocate()]) {
      expect(reply.status).toBe(503);
      expect(reply.code).toBe("provider_accounts_not_configured");
    }
    for (const invalid of ["", "invalid"]) {
      Object.assign(env, { PROVIDER_ACCOUNTS_KEY: invalid });
      const reply = await call("owner");
      expect(reply.status).toBe(503);
      expect(reply.code).toBe("provider_accounts_unavailable");
    }
    Object.assign(env, { PROVIDER_ACCOUNTS_KEY: btoa("x".repeat(32)) });
    const wrongKey = await allocate();
    expect(wrongKey.status).toBe(503);
    expect(wrongKey.code).toBe("provider_accounts_unavailable");
    Object.assign(env, { PROVIDER_ACCOUNTS_KEY: btoa("k".repeat(32)) });
    await env.DB.prepare("DROP TABLE provider_accounts").run();
    const missingSchema = await call("owner");
    expect(missingSchema.status).toBe(503);
    expect(missingSchema.code).toBe("provider_accounts_unavailable");
  });

  it("allocates exclusively under concurrent requests, fences stale renewals and other devices/teams", async () => {
    const { env, add, allocate, call } = await fixture();
    await add();
    const results = await Promise.all([allocate(), allocate("other"), allocate("secondDevice")]);
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
    expect(results.filter(r => r.status === 409)).toHaveLength(2);
    const lease = results[0].data;
    expect((await call("secondDevice", "POST", `/leases/${lease.leaseId}/renew`, {})).status).toBe(404);
    expect((await call("other", "DELETE", `/leases/${lease.leaseId}`)).status).toBe(404);
    expect((await call("owner", "DELETE", `/leases/${lease.leaseId}`, undefined, "second")).status).toBe(404);
    await env.DB.prepare("UPDATE provider_accounts SET lease_expires_at=1").run();
    const replacement = await allocate("other");
    expect(replacement.status).toBe(200);
    expect((await call("employee", "POST", `/leases/${lease.leaseId}/renew`, { credentials })).status).toBe(404);
    expect((await call("other", "POST", `/leases/${replacement.data.leaseId}/renew`, { credentials: { ...credentials, last_refresh: "new" } })).status).toBe(200);
    await call("other", "DELETE", `/leases/${replacement.data.leaseId}`);
    expect((await allocate()).data.credentials.last_refresh).toBe("new");
  });

  it("retains health across release, selects available capacity then LRU and honours exclusions", async () => {
    const { env, add, allocate, call } = await fixture();
    const a = (await add()).data.account, b = (await add()).data.account;
    const first = (await allocate()).data;
    await call("employee", "POST", `/leases/${first.leaseId}/renew`, { remainingPercent: 70 });
    await call("employee", "DELETE", `/leases/${first.leaseId}`);
    const healthy = (await allocate()).data;
    expect(healthy.account.id).toBe(first.account.id);
    const reset = Math.floor(Date.now() / 1000) + 1000;
    await call("employee", "POST", `/leases/${healthy.leaseId}/renew`, { remainingPercent: 0, blockedUntil: reset });
    await call("employee", "DELETE", `/leases/${healthy.leaseId}`);
    const other = (await allocate()).data;
    expect(other.account.id).not.toBe(first.account.id);
    await call("employee", "DELETE", `/leases/${other.leaseId}`);
    expect((await allocate("employee", { excludeIds: [a.id, b.id] })).status).toBe(409);
    const listed = (await call("owner")).data.accounts.find((x: any) => x.id === first.account.id);
    expect(listed.blockedUntil).toBe(reset);
    await env.DB.prepare("UPDATE provider_accounts SET blocked_until=1 WHERE id=?").bind(first.account.id).run();
    const afterReset = await allocate("employee", { excludeIds: [other.account.id] });
    expect(afterReset.status).toBe(200);
    expect(afterReset.data.account.remainingPercent).toBeNull();
  });

  it("fails closed on missing/wrong keys or tampering without logging credentials", async () => {
    const { env, add, allocate } = await fixture();
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      Object.assign(env, { PROVIDER_ACCOUNTS_KEY: undefined });
      expect((await add()).status).toBe(503);
      Object.assign(env, { PROVIDER_ACCOUNTS_KEY: "invalid" });
      expect((await add()).status).toBe(503);
      Object.assign(env, { PROVIDER_ACCOUNTS_KEY: btoa("k".repeat(32)) });
      await add();
      Object.assign(env, { PROVIDER_ACCOUNTS_KEY: btoa("x".repeat(32)) });
      expect((await allocate()).status).toBe(503);
      expect(logs).not.toHaveBeenCalled();
    } finally { logs.mockRestore(); }
  });

  it("bounds and validates native provider-shaped OAuth credentials", async () => {
    const { add, call } = await fixture();
    expect((await add("owner", "grok")).status).toBe(201);
    for (const creds of [null, [], { OPENAI_API_KEY: "secret" }, grok, { ...credentials, padding: "x".repeat(33000) }]) {
      expect((await call("owner", "POST", "", { provider: "codex", label: "A", credentials: creds })).status).toBe(400);
    }
    expect((await call("owner", "POST", "", { provider: "grok", label: "A", credentials })).status).toBe(400);
    expect((await call("owner", "POST", "", { provider: "claude", label: "A", credentials })).status).toBe(400);
  });

  it("disabled/deleted accounts and departed members cannot renew or allocate", async () => {
    const { env, add, call, allocate } = await fixture();
    const account = (await add()).data.account;
    const lease = (await allocate()).data;
    await call("owner", "PATCH", `/${account.id}`, { enabled: false, label: "Paused" });
    expect((await call("employee", "POST", `/leases/${lease.leaseId}/renew`, {})).status).toBe(404);
    expect((await allocate()).status).toBe(409);
    await call("owner", "PATCH", `/${account.id}`, { enabled: true });
    // Re-enabling never frees an outstanding lease early.
    expect((await allocate("other")).status).toBe(409);
    await env.DB.prepare("UPDATE team_members SET left_at='now' WHERE user_id='employee'").run();
    expect((await call("employee", "POST", `/leases/${lease.leaseId}/renew`, {})).status).toBe(404);
    expect((await call("owner", "DELETE", `/${account.id}`)).status).toBe(200);
    expect((await call("owner")).data.accounts).toEqual([]);
  });
});
