import { describe, expect, it } from "vitest";
import { can, canViewMember, requireCapability, requireTeam, requireViewMember } from "../src/authz";
import type { Role } from "../src/db";
import { HttpError } from "../src/http";
import { addMember, makeEnv, seedGithubUser, seedTeam, seedUser } from "./helpers/d1";
import { listTeams } from "../src/routes/teams";

const ROLES: Role[] = ["owner", "manager", "employee"];

describe("capability matrix", () => {
  it("restricts team mutation to the owner", () => {
    for (const cap of ["team.rename", "team.delete", "member.setRole", "member.remove"] as const) {
      expect(can("owner", cap)).toBe(true);
      expect(can("manager", cap)).toBe(false);
      expect(can("employee", cap)).toBe(false);
    }
  });

  it("keeps invites owner-only in v1", () => {
    expect(can("owner", "invite.manage")).toBe(true);
    expect(can("manager", "invite.manage")).toBe(false);
    expect(can("employee", "invite.manage")).toBe(false);
  });

  it("gives full analytics to owner and manager only", () => {
    expect(can("owner", "analytics.viewAll")).toBe(true);
    expect(can("manager", "analytics.viewAll")).toBe(true);
    expect(can("employee", "analytics.viewAll")).toBe(false);
  });

  it("lets every role see their own stats and upload", () => {
    for (const role of ROLES) {
      expect(can(role, "analytics.viewSelf")).toBe(true);
      expect(can(role, "metrics.upload")).toBe(true);
    }
  });

  it("blocks an owner from leaving without transferring first", () => {
    expect(can("owner", "team.leave")).toBe(false);
    expect(can("manager", "team.leave")).toBe(true);
    expect(can("employee", "team.leave")).toBe(true);
  });

  it("leaderboard is manager-readable, owner-managed", () => {
    expect(can("owner", "leaderboard.view")).toBe(true);
    expect(can("manager", "leaderboard.view")).toBe(true);
    expect(can("employee", "leaderboard.view")).toBe(false);
    expect(can("owner", "leaderboard.manage")).toBe(true);
    expect(can("manager", "leaderboard.manage")).toBe(false);
  });
});

describe("per-member analytics access", () => {
  const ctx = (role: Role, userId: string) =>
    ({
      team: { id: "tm", slug: "tm", name: "T", created_by: "u", created_at: "", deleted_at: null },
      membership: {
        id: "m",
        team_id: "tm",
        user_id: userId,
        role,
        joined_at: "",
        left_at: null,
      },
      role,
      staffPreview: false,
    }) as const;

  it("lets managers and owners view anyone", () => {
    expect(canViewMember(ctx("owner", "me"), "someone-else")).toBe(true);
    expect(canViewMember(ctx("manager", "me"), "someone-else")).toBe(true);
  });

  it("limits employees to themselves", () => {
    expect(canViewMember(ctx("employee", "me"), "me")).toBe(true);
    expect(canViewMember(ctx("employee", "me"), "someone-else")).toBe(false);
    expect(() => requireViewMember(ctx("employee", "me"), "someone-else")).toThrow(HttpError);
  });
});

describe("requireTeam", () => {
  it("resolves a team for an active member", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedTeam(env, "tm1", "owner1");

    const ctx = await requireTeam(env, "tm1", "owner1");
    expect(ctx.role).toBe("owner");
    expect(ctx.team.name).toBe("Helios Platform");
  });

  it("hides the team from non-members entirely (404, not 403)", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "stranger");
    await seedTeam(env, "tm1", "owner1");

    await expect(requireTeam(env, "tm1", "stranger")).rejects.toMatchObject({ status: 404 });
  });

  it("revokes access the moment a member leaves", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "emp1");
    await seedTeam(env, "tm1", "owner1");
    await addMember(env, "tm1", "emp1", "employee");

    await expect(requireTeam(env, "tm1", "emp1")).resolves.toMatchObject({ role: "employee" });

    await env.DB.prepare("UPDATE team_members SET left_at = ? WHERE team_id = ? AND user_id = ?")
      .bind(new Date().toISOString(), "tm1", "emp1")
      .run();

    await expect(requireTeam(env, "tm1", "emp1")).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a capability the role lacks", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "mgr1");
    await seedTeam(env, "tm1", "owner1");
    await addMember(env, "tm1", "mgr1", "manager");

    const ctx = await requireTeam(env, "tm1", "mgr1");
    expect(() => requireCapability(ctx, "team.delete")).toThrow(/can't do that/);
    expect(() => requireCapability(ctx, "analytics.viewAll")).not.toThrow();
  });
});

describe("platform staff preview", () => {
  async function dataOf<T>(res: Response): Promise<T> {
    const body = (await res.json()) as { ok: boolean; data: T };
    return body.data;
  }

  it("lets the allowlisted GitHub login open a team they do not belong to", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedGithubUser(env, "neel", "neelsatyavolu");
    await seedTeam(env, "tm1", "owner1", "Acme");

    const ctx = await requireTeam(env, "tm1", "neel", "cookie");
    expect(ctx.staffPreview).toBe(true);
    expect(ctx.role).toBe("manager");
    expect(ctx.team.name).toBe("Acme");
    expect(() => requireCapability(ctx, "analytics.viewAll")).not.toThrow();
    expect(() => requireCapability(ctx, "team.delete")).toThrow(/read-only/);
    expect(() => requireCapability(ctx, "invite.manage")).toThrow(/read-only/);
  });

  it("does not widen desktop device tokens into other teams", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedGithubUser(env, "neel", "neelsatyavolu");
    await seedTeam(env, "tm1", "owner1");

    await expect(requireTeam(env, "tm1", "neel", "device")).rejects.toMatchObject({ status: 404 });
  });

  it("does not grant a Google-only account with the same handle", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "impostor", "Impostor");
    await env.DB.prepare("UPDATE users SET handle = 'neelsatyavolu' WHERE id = 'impostor'").run();
    await seedTeam(env, "tm1", "owner1");

    await expect(requireTeam(env, "tm1", "impostor", "cookie")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("lists other teams for staff on the web, marked as preview", async () => {
    const env = makeEnv();
    await seedGithubUser(env, "neel", "neelsatyavolu");
    await seedUser(env, "owner1");
    await seedTeam(env, "tm-mine", "neel", "Mine");
    await seedTeam(env, "tm-other", "owner1", "Other Co");

    const web = await dataOf<{ teams: Array<{ slug: string; staffPreview?: boolean }> }>(
      await listTeams(env, { userId: "neel", deviceId: null, via: "cookie" }),
    );
    expect(web.teams.map((t) => t.slug).sort()).toEqual(["tm-mine", "tm-other"]);
    expect(web.teams.find((t) => t.slug === "tm-mine")?.staffPreview).toBe(false);
    expect(web.teams.find((t) => t.slug === "tm-other")?.staffPreview).toBe(true);

    const desktop = await dataOf<{ teams: Array<{ slug: string }> }>(
      await listTeams(env, { userId: "neel", deviceId: "dev1", via: "device" }),
    );
    expect(desktop.teams.map((t) => t.slug)).toEqual(["tm-mine"]);
  });
});
