import { describe, expect, it } from "vitest";
import { newId } from "../src/crypto";
import { nowIso } from "../src/db";
import {
  clearManagerScope,
  expandScopeUserIds,
  loadManagerScopeConfig,
  resolveAnalyticsScope,
} from "../src/scope";
import { createGroup, setGroupMembers } from "../src/routes/groups";
import { setMemberScope } from "../src/routes/scope";
import { teamOverview, memberDetail } from "../src/routes/dashboard";
import { addMember, makeEnv, seedTeam, seedUser } from "./helpers/d1";
import type { Principal } from "../src/session";
import type { TeamContext } from "../src/authz";

function principal(userId: string): Principal {
  return { userId, via: "cookie", deviceId: null };
}

/** Routes wrap payloads in `{ ok, data }`. */
async function dataOf<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { ok: boolean; data: T };
  return body.data;
}

function ctx(
  teamId: string,
  userId: string,
  role: "owner" | "manager" | "employee",
): TeamContext {
  return {
    team: {
      id: teamId,
      slug: teamId,
      name: "T",
      created_by: "owner1",
      created_at: "",
      deleted_at: null,
    },
    membership: {
      id: "m",
      team_id: teamId,
      user_id: userId,
      role,
      joined_at: "",
      left_at: null,
    },
    role,
    staffPreview: false,
  };
}

async function seedHourly(
  env: ReturnType<typeof makeEnv>,
  teamId: string,
  userId: string,
  hour: string,
  cost: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO metric_hourly (
       team_id, user_id, device_id, hour_utc, provider, model, project_key,
       tokens_in, tokens_out, cost_usd, active_ms, sessions, turns, tool_calls,
       local_hour, local_dow, updated_at
     ) VALUES (?, ?, 'dev', ?, 'claude', 'sonnet', 'app', 100, 50, ?, 60000, 1, 1, 1, 10, 1, ?)`,
  )
    .bind(teamId, userId, hour, cost, nowIso())
    .run();
}

describe("resolveAnalyticsScope", () => {
  it("owners and unscoped managers see the entire team", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "mgr1");
    await seedTeam(env, "tm1", "owner1");
    await addMember(env, "tm1", "mgr1", "manager");

    const ownerScope = await resolveAnalyticsScope(env, ctx("tm1", "owner1", "owner"));
    expect(ownerScope.kind).toBe("team");
    expect(ownerScope.userIds).toBeNull();

    const mgrScope = await resolveAnalyticsScope(env, ctx("tm1", "mgr1", "manager"));
    expect(mgrScope.kind).toBe("team");
    expect(mgrScope.userIds).toBeNull();
  });

  it("employees only see themselves", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "emp1");
    await seedTeam(env, "tm1", "owner1");
    await addMember(env, "tm1", "emp1", "employee");

    const scope = await resolveAnalyticsScope(env, ctx("tm1", "emp1", "employee"));
    expect(scope.kind).toBe("self");
    expect(scope.userIds).toEqual(["emp1"]);
  });

  it("expands groups + people and always includes the manager", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "mgr1");
    await seedUser(env, "alice");
    await seedUser(env, "bob");
    await seedUser(env, "carol");
    await seedTeam(env, "tm1", "owner1");
    await addMember(env, "tm1", "mgr1", "manager");
    await addMember(env, "tm1", "alice", "employee");
    await addMember(env, "tm1", "bob", "employee");
    await addMember(env, "tm1", "carol", "employee");

    const gid = newId("grp");
    await env.DB.prepare(
      "INSERT INTO team_groups (id, team_id, name, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(gid, "tm1", "Platform", nowIso())
      .run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO team_group_members (group_id, user_id, added_at) VALUES (?, ?, ?)",
      ).bind(gid, "alice", nowIso()),
      env.DB.prepare(
        "INSERT INTO team_group_members (group_id, user_id, added_at) VALUES (?, ?, ?)",
      ).bind(gid, "bob", nowIso()),
    ]);

    // Scope: Platform group + carol directly.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO manager_scope (id, team_id, manager_user_id, target_user_id, target_group_id, created_at)
         VALUES (?, ?, ?, NULL, ?, ?)`,
      ).bind(newId("scp"), "tm1", "mgr1", gid, nowIso()),
      env.DB.prepare(
        `INSERT INTO manager_scope (id, team_id, manager_user_id, target_user_id, target_group_id, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      ).bind(newId("scp"), "tm1", "mgr1", "carol", nowIso()),
    ]);

    const expanded = await expandScopeUserIds(env, "tm1", "mgr1", ["carol"], [gid]);
    expect(expanded).toEqual(["alice", "bob", "carol", "mgr1"]);

    const scope = await resolveAnalyticsScope(env, ctx("tm1", "mgr1", "manager"));
    expect(scope.kind).toBe("partial");
    expect(scope.userIds).toEqual(["alice", "bob", "carol", "mgr1"]);
    expect(scope.label).toMatch(/Platform/);
  });
});

describe("manager scope API + overview filter", () => {
  it("filters overview metrics to the manager's people only", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "mgr1");
    await seedUser(env, "alice");
    await seedUser(env, "bob");
    await seedTeam(env, "tm1", "owner1");
    await addMember(env, "tm1", "mgr1", "manager");
    await addMember(env, "tm1", "alice", "employee");
    await addMember(env, "tm1", "bob", "employee");

    // Recent hour so 30d range includes it.
    const hour = new Date().toISOString().slice(0, 13);
    await seedHourly(env, "tm1", "alice", hour, 10);
    await seedHourly(env, "tm1", "bob", hour, 40);

    const req = new Request("https://teams.test/api/teams/tm1/members/mgr1/scope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "custom", userIds: ["alice"], groupIds: [] }),
    });
    const setRes = await setMemberScope(req, env, principal("owner1"), "tm1", "mgr1");
    expect(setRes.status).toBe(200);
    const setBody = await dataOf<{ resolvedUserIds: string[] }>(setRes);
    expect(setBody.resolvedUserIds).toContain("alice");
    expect(setBody.resolvedUserIds).toContain("mgr1");
    expect(setBody.resolvedUserIds).not.toContain("bob");

    const overviewReq = new Request("https://teams.test/api/teams/tm1/overview?range=30d");
    const res = await teamOverview(overviewReq, env, principal("mgr1"), "tm1");
    const body = await dataOf<{
      scope: string;
      totals: { costUsd: number };
      members: { userId: string }[];
      budget: unknown;
    }>(res);
    expect(body.scope).toBe("partial");
    // Only alice's $10 (mgr has no buckets).
    expect(body.totals.costUsd).toBe(10);
    expect(body.members.map((m) => m.userId).sort()).toEqual(["alice", "mgr1"]);
    // Scoped managers don't get team-wide budget.
    expect(body.budget).toBeNull();
  });

  it("blocks detail for people outside the scope", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "mgr1");
    await seedUser(env, "alice");
    await seedUser(env, "bob");
    await seedTeam(env, "tm1", "owner1");
    await addMember(env, "tm1", "mgr1", "manager");
    await addMember(env, "tm1", "alice", "employee");
    await addMember(env, "tm1", "bob", "employee");

    await setMemberScope(
      new Request("https://x", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "custom", userIds: ["alice"] }),
      }),
      env,
      principal("owner1"),
      "tm1",
      "mgr1",
    );

    await expect(
      memberDetail(
        new Request("https://x?range=30d"),
        env,
        principal("mgr1"),
        "tm1",
        "bob",
      ),
    ).rejects.toMatchObject({ status: 403 });

    const ok = await memberDetail(
      new Request("https://x?range=30d"),
      env,
      principal("mgr1"),
      "tm1",
      "alice",
    );
    expect(ok.status).toBe(200);
  });

  it("mode team clears custom scope", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "mgr1");
    await seedUser(env, "alice");
    await seedTeam(env, "tm1", "owner1");
    await addMember(env, "tm1", "mgr1", "manager");
    await addMember(env, "tm1", "alice", "employee");

    await setMemberScope(
      new Request("https://x", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "custom", userIds: ["alice"] }),
      }),
      env,
      principal("owner1"),
      "tm1",
      "mgr1",
    );

    await setMemberScope(
      new Request("https://x", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "team" }),
      }),
      env,
      principal("owner1"),
      "tm1",
      "mgr1",
    );

    const config = await loadManagerScopeConfig(env, "tm1", "mgr1");
    expect(config.mode).toBe("team");
    const scope = await resolveAnalyticsScope(env, ctx("tm1", "mgr1", "manager"));
    expect(scope.kind).toBe("team");
  });
});

describe("groups", () => {
  it("creates a group and assigns members", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "alice");
    await seedTeam(env, "tm1", "owner1");
    await addMember(env, "tm1", "alice", "employee");

    const res = await createGroup(
      new Request("https://x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Platform", memberIds: ["alice"] }),
      }),
      env,
      principal("owner1"),
      "tm1",
    );
    expect(res.status).toBe(201);
    const body = await dataOf<{ group: { id: string; member_count: number } }>(res);
    expect(body.group.member_count).toBe(1);

    await setGroupMembers(
      new Request("https://x", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memberIds: [] }),
      }),
      env,
      principal("owner1"),
      "tm1",
      body.group.id,
    );
  });

  it("rejects group create from non-owners", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "mgr1");
    await seedTeam(env, "tm1", "owner1");
    await addMember(env, "tm1", "mgr1", "manager");

    await expect(
      createGroup(
        new Request("https://x", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "X" }),
        }),
        env,
        principal("mgr1"),
        "tm1",
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("clearManagerScope", () => {
  it("wipes rows", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "mgr1");
    await seedUser(env, "alice");
    await seedTeam(env, "tm1", "owner1");
    await addMember(env, "tm1", "mgr1", "manager");
    await addMember(env, "tm1", "alice", "employee");
    await env.DB.prepare(
      `INSERT INTO manager_scope (id, team_id, manager_user_id, target_user_id, target_group_id, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    )
      .bind(newId("scp"), "tm1", "mgr1", "alice", nowIso())
      .run();

    await clearManagerScope(env, "tm1", "mgr1");
    const config = await loadManagerScopeConfig(env, "tm1", "mgr1");
    expect(config.mode).toBe("team");
  });
});
