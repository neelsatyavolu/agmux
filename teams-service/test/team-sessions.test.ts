import { describe, expect, it, vi, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index";
import { makeEnv, seedUser, seedTeam, addMember } from "./helpers/d1";
import { createDeviceToken, createSession } from "../src/session";
import { parseReported, expire, LIVE_TTL, PENDING_TTL } from "../src/routes/team-sessions";

async function fixture() {
  const env = makeEnv();
  for (const id of ["owner", "alice", "bob", "outsider"]) await seedUser(env, id);
  await seedTeam(env, "team", "owner");
  await seedTeam(env, "other", "outsider");
  await addMember(env, "team", "alice", "employee");
  await addMember(env, "team", "bob", "employee");
  const tokens: Record<string, string> = {};
  for (const id of ["owner", "alice", "bob", "outsider"]) tokens[id] = await createDeviceToken(env, id, `${id}-mac`, null);
  tokens.aliceLaptop = await createDeviceToken(env, "alice", "alice-laptop", null);
  tokens.aliceWeb = await createSession(env, "alice");
  // Device ids are chosen by the desktop, so a teammate can pick someone else's.
  tokens.bobAsAliceMac = await createDeviceToken(env, "bob", "alice-mac", null);
  async function call(who: string, method: string, suffix: string, body?: unknown, team = "team") {
    const headers: Record<string, string> = who === "aliceWeb"
      ? { cookie: `__Host-agmux_teams=${tokens[who]}` }
      : { authorization: `Bearer ${tokens[who]}` };
    const response = await worker.fetch(new Request(`https://teams.agmux.dev/api/teams/${team}${suffix}`,
      { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
    return { status: response.status, ...await response.json() as any };
  }
  const share = (who: string, acceptMessages = false) => call(who, "PUT", "/session-sharing", { enabled: true, acceptMessages });
  const report = (who: string, sessions: unknown[]) => call(who, "PUT", "/live-sessions", { sessions });
  const session = { key: "tab-1", agent: "claude", title: "Fix login", project: "/Users/alice/src/web", branch: "main", status: "working", canAsk: true };
  return { env, call, share, report, session };
}

afterEach(() => vi.useRealTimers());

describe("team sessions", () => {
  it("adds the same tables to an existing database as the fresh schema", () => {
    const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
    const migration = readFileSync(new URL("../migrations/017_team_sessions.sql", import.meta.url), "utf8");
    const upgraded = new DatabaseSync(":memory:"), fresh = new DatabaseSync(":memory:");
    try {
      upgraded.exec(schema.slice(0, schema.indexOf("-- Team sessions:")));
      upgraded.exec(migration);
      fresh.exec(schema);
      for (const table of ["team_session_sharing", "team_live_sessions", "team_session_requests"]) {
        expect(upgraded.prepare(`PRAGMA table_info(${table})`).all()).toEqual(fresh.prepare(`PRAGMA table_info(${table})`).all());
      }
    } finally { upgraded.close(); fresh.close(); }
  });

  it("keeps only a folder name for the project", () => {
    expect(parseReported({ key: "a", agent: "codex", project: "/Users/alice/src/web" }).project).toBe("web");
    expect(parseReported({ key: "a", agent: "codex", status: "bogus" }).status).toBe("idle");
    expect(() => parseReported({ key: "../x", agent: "codex" })).toThrow();
  });

  it("is off until a member opts in, for reporting and for listing", async () => {
    const { call, report, session } = await fixture();
    expect((await call("alice", "GET", "/session-sharing")).data).toEqual({ enabled: false, acceptMessages: false });
    expect((await report("alice", [session])).code).toBe("sharing_off");
    expect((await call("bob", "GET", "/live-sessions")).code).toBe("sharing_off");
  });

  it("lists opted-in teammates' live sessions, not this Mac's own", async () => {
    const { call, share, report, session } = await fixture();
    await share("alice");
    await share("bob");
    expect((await report("alice", [session])).status).toBe(200);
    const listed = (await call("bob", "GET", "/live-sessions")).data.sessions;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ member: "alice", mine: false, agent: "claude", project: "web", can_ask: true, accepts_messages: false });
    expect(listed[0].session_id).toMatch(/^ts-[0-9a-f]{20}$/);
    expect((await call("alice", "GET", "/live-sessions")).data.sessions).toEqual([]);
    // Alice's other Mac sees it, marked as hers.
    expect((await call("aliceLaptop", "GET", "/live-sessions")).data.sessions[0].mine).toBe(true);
  });

  it("drops sessions that stopped reporting and ones whose owner opted out or left", async () => {
    const { env, call, share, report, session } = await fixture();
    await share("alice");
    await share("bob");
    await report("alice", [session]);
    vi.useFakeTimers({ now: Date.now() + (LIVE_TTL + 5) * 1000 });
    expect((await call("bob", "GET", "/live-sessions")).data.sessions).toEqual([]);
    vi.useRealTimers();
    await report("alice", [session]);
    await env.DB.prepare("UPDATE team_members SET left_at = '2026-11-04' WHERE user_id = 'alice'").run();
    expect((await call("bob", "GET", "/live-sessions")).data.sessions).toEqual([]);
  });

  it("never lets a device token of another team in", async () => {
    const { call } = await fixture();
    expect((await call("outsider", "GET", "/live-sessions")).status).toBe(404);
  });

  it("only a linked desktop reports sessions or claims its inbox", async () => {
    const { call, share, session } = await fixture();
    await share("aliceWeb");
    expect((await call("aliceWeb", "PUT", "/live-sessions", { sessions: [session] })).status).toBe(403);
    expect((await call("aliceWeb", "POST", "/session-inbox")).status).toBe(403);
  });

  it("carries an ask to the owner's Mac and its answer back exactly once", async () => {
    const { env, call, share, report, session } = await fixture();
    await share("alice");
    await share("bob");
    await report("alice", [session]);
    const [target] = (await call("bob", "GET", "/live-sessions")).data.sessions;
    const created = await call("bob", "POST", `/live-sessions/${target.session_id}/requests`, { kind: "ask", body: "Which table holds logins?", effort: "low" });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ member: "alice", agent: "claude" });
    const id = created.data.id;
    expect((await call("bob", "GET", `/session-requests/${id}`)).data.status).toBe("pending");
    // Another of Alice's Macs doesn't get it.
    expect((await call("aliceLaptop", "POST", "/session-inbox")).data.requests).toEqual([]);
    const inbox = (await call("alice", "POST", "/session-inbox")).data.requests;
    expect(inbox).toEqual([{ id, sessionKey: "tab-1", kind: "ask", body: "Which table holds logins?", effort: "low", from: "bob" }]);
    expect((await call("alice", "POST", "/session-inbox")).data.requests).toEqual([]);
    // The question isn't kept once claimed.
    const stored = await env.DB.prepare("SELECT body FROM team_session_requests WHERE id = ?").bind(id).first<{ body: string }>();
    expect(stored?.body).toBe("");
    expect((await call("bob", "POST", `/session-requests/${id}/answer`, { answer: "nope" })).status).toBe(404);
    expect((await call("alice", "POST", `/session-requests/${id}/answer`, { answer: "provider_accounts" })).status).toBe(200);
    expect((await call("alice", "GET", `/session-requests/${id}`)).status).toBe(404);
    const answered = await call("bob", "GET", `/session-requests/${id}`);
    expect(answered.data).toMatchObject({ status: "answered", answer: "provider_accounts" });
    expect((await call("bob", "GET", `/session-requests/${id}`)).status).toBe(404);
    const audit = await env.DB.prepare("SELECT action, actor_user_id, target, detail FROM audit_log WHERE action LIKE 'team_sessions.%' ORDER BY created_at").all();
    expect(audit.results.map((r: any) => r.action)).toEqual(["team_sessions.on", "team_sessions.on", "team_sessions.ask"]);
    expect(JSON.stringify(audit.results)).not.toContain("logins");
  });

  it("refuses messages unless the owner accepts them", async () => {
    const { call, share, report, session } = await fixture();
    await share("alice");
    await share("bob");
    await report("alice", [session]);
    const [target] = (await call("bob", "GET", "/live-sessions")).data.sessions;
    const path = `/live-sessions/${target.session_id}/requests`;
    expect((await call("bob", "POST", path, { kind: "message", body: "I moved main" })).status).toBe(403);
    await share("alice", true);
    expect((await call("bob", "POST", path, { kind: "message", body: "I moved main" })).status).toBe(201);
    expect((await call("alice", "POST", "/session-inbox")).data.requests[0]).toMatchObject({ kind: "message", body: "I moved main" });
  });

  it("refuses asks of sessions that can't be copied, and oversized or empty bodies", async () => {
    const { call, share, report, session } = await fixture();
    await share("alice");
    await share("bob");
    await report("alice", [{ ...session, canAsk: false }]);
    const [target] = (await call("bob", "GET", "/live-sessions")).data.sessions;
    const path = `/live-sessions/${target.session_id}/requests`;
    expect((await call("bob", "POST", path, { kind: "ask", body: "hi" })).status).toBe(400);
    await report("alice", [session]);
    expect((await call("bob", "POST", path, { kind: "ask", body: "   " })).status).toBe(400);
    expect((await call("bob", "POST", path, { kind: "ask", body: "x".repeat(8_001) })).status).toBe(400);
    expect((await call("bob", "POST", "/live-sessions/ts-0000/requests", { kind: "ask", body: "hi" })).status).toBe(404);
  });

  it("caps how many requests one member has open", async () => {
    const { call, share, report, session } = await fixture();
    await share("alice");
    await share("bob");
    await report("alice", [session]);
    const [target] = (await call("bob", "GET", "/live-sessions")).data.sessions;
    const ask = () => call("bob", "POST", `/live-sessions/${target.session_id}/requests`, { kind: "ask", body: "hi" });
    for (let i = 0; i < 5; i++) expect((await ask()).status).toBe(201);
    expect((await ask()).status).toBe(429);
  });

  it("fails a request nobody picked up, and open ones when the owner opts out", async () => {
    const { call, share, report, session } = await fixture();
    await share("alice");
    await share("bob");
    await report("alice", [session]);
    const [target] = (await call("bob", "GET", "/live-sessions")).data.sessions;
    const path = `/live-sessions/${target.session_id}/requests`;
    const stale = (await call("bob", "POST", path, { kind: "ask", body: "hi" })).data.id;
    vi.useFakeTimers({ now: Date.now() + (PENDING_TTL + 5) * 1000 });
    const expired = await call("bob", "GET", `/session-requests/${stale}`);
    expect(expired.data.status).toBe("failed");
    expect(expired.data.error).toMatch(/didn't pick this up/);
    vi.useRealTimers();
    await report("alice", [session]);
    const open = (await call("bob", "POST", path, { kind: "ask", body: "hi" })).data.id;
    await call("alice", "PUT", "/session-sharing", { enabled: false });
    expect((await call("bob", "GET", `/session-requests/${open}`)).data).toMatchObject({ status: "failed", error: "Its owner stopped sharing sessions." });
    expect((await call("bob", "GET", "/live-sessions")).data.sessions).toEqual([]);
  });

  it("never treats a device id as identity: another member with the same id gets nothing", async () => {
    const { call, share, report, session } = await fixture();
    await share("alice");
    await share("bob");
    await share("owner");
    await report("alice", [session]);
    // Bob's desktop claiming Alice's device id doesn't replace or see her sessions.
    await report("bobAsAliceMac", []);
    const [target] = (await call("owner", "GET", "/live-sessions")).data.sessions;
    expect(target?.member).toBe("alice");
    const { id } = (await call("owner", "POST", `/live-sessions/${target.session_id}/requests`, { kind: "ask", body: "hi" })).data;
    expect((await call("bobAsAliceMac", "POST", "/session-inbox")).data.requests).toEqual([]);
    expect((await call("alice", "POST", "/session-inbox")).data.requests.map((r: any) => r.id)).toEqual([id]);
    expect((await call("bobAsAliceMac", "POST", `/session-requests/${id}/answer`, { answer: "forged" })).status).toBe(404);
  });

  it("drops queued messages once the owner stops accepting them, and ones from a member who left", async () => {
    const { env, call, share, report, session } = await fixture();
    await share("alice", true);
    await share("bob");
    await report("alice", [session]);
    const [target] = (await call("bob", "GET", "/live-sessions")).data.sessions;
    const path = `/live-sessions/${target.session_id}/requests`;
    const queued = (await call("bob", "POST", path, { kind: "message", body: "first" })).data.id;
    await share("alice", false);
    expect((await call("alice", "POST", "/session-inbox")).data.requests).toEqual([]);
    expect((await call("bob", "GET", `/session-requests/${queued}`)).data).toMatchObject({ status: "failed", error: "Its owner stopped accepting messages." });
    await share("alice", true);
    await report("alice", [session]);
    await call("bob", "POST", path, { kind: "message", body: "second" });
    await env.DB.prepare("UPDATE team_members SET left_at = '2026-11-04' WHERE user_id = 'bob'").run();
    expect((await call("alice", "POST", "/session-inbox")).data.requests).toEqual([]);
  });

  it("holds the open-request cap under concurrent requests", async () => {
    const { call, share, report, session } = await fixture();
    await share("alice");
    await share("bob");
    await report("alice", [session]);
    const [target] = (await call("bob", "GET", "/live-sessions")).data.sessions;
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      call("bob", "POST", `/live-sessions/${target.session_id}/requests`, { kind: "ask", body: "hi" })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(7);
  });

  it("strips terminal control characters from what reaches a tab", async () => {
    const { call, share, report, session } = await fixture();
    await share("alice", true);
    await share("bob");
    await report("alice", [session]);
    const [target] = (await call("bob", "GET", "/live-sessions")).data.sessions;
    await call("bob", "POST", `/live-sessions/${target.session_id}/requests`, { kind: "message", body: "hi\u0015\u0003\u001b[2Jthere" });
    const [message] = (await call("alice", "POST", "/session-inbox")).data.requests;
    expect(message.body).toBe("hi   [2Jthere");
  });

  it("the hourly sweep purges stale sessions and old requests without any polling", async () => {
    const { env, share, report, session } = await fixture();
    await share("alice");
    await report("alice", [session]);
    await expire(env, Math.floor(Date.now() / 1000) + LIVE_TTL + 5);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM team_live_sessions").first<{ n: number }>())?.n).toBe(0);
  });
});
