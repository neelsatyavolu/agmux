import { describe, expect, it } from "vitest";
import {
  accessForTeam,
  billableSeats,
  billingMessage,
  countSeats,
  ensureTeamTrial,
  estimatedMonthlyUsd,
  filterUploadTeamIds,
  FREE_SEATS,
  paidPlanAccess,
  requireWritableBilling,
  trialEndsFrom,
} from "../src/billing/entitlement";
import { HttpError } from "../src/http";
import { addMember, makeEnv, seedTeam, seedUser } from "./helpers/d1";

describe("free seats", () => {
  it("billableSeats is zero for first FREE_SEATS", () => {
    expect(FREE_SEATS).toBe(3);
    expect(billableSeats(0)).toBe(0);
    expect(billableSeats(3)).toBe(0);
    expect(billableSeats(4)).toBe(1);
    expect(billableSeats(10)).toBe(7);
    expect(estimatedMonthlyUsd(5)).toBe(24);
  });
});

describe("accessForTeam", () => {
  const now = new Date("2026-08-15T12:00:00.000Z");

  it("is full for free-tier roster even after trial expired", () => {
    expect(
      accessForTeam(
        { billing_status: "trialing", trial_ends_at: "2020-01-01T00:00:00.000Z" },
        now,
        3,
      ),
    ).toBe("full");
  });

  it("locks oversized roster after trial without sub", () => {
    expect(
      accessForTeam(
        { billing_status: "trialing", trial_ends_at: "2020-01-01T00:00:00.000Z" },
        now,
        5,
      ),
    ).toBe("locked");
  });

  it("is full during app trial", () => {
    expect(
      accessForTeam(
        { billing_status: "trialing", trial_ends_at: "2026-09-01T00:00:00.000Z" },
        now,
        10,
      ),
    ).toBe("full");
  });

  it("is full when active or comp", () => {
    expect(accessForTeam({ billing_status: "active", trial_ends_at: "2026-01-01T00:00:00.000Z" }, now)).toBe(
      "full",
    );
    expect(accessForTeam({ billing_status: "comp", trial_ends_at: null }, now)).toBe("full");
  });

  it("is full when past_due (grace for recovery)", () => {
    expect(
      accessForTeam({ billing_status: "past_due", trial_ends_at: "2026-01-01T00:00:00.000Z" }, now),
    ).toBe("full");
  });

  it("is read_only in post-trial grace window", () => {
    // trial ended 2026-08-10; grace 14d → until 2026-08-24
    expect(
      accessForTeam(
        { billing_status: "trialing", trial_ends_at: "2026-08-10T00:00:00.000Z" },
        now,
      ),
    ).toBe("read_only");
  });

  it("is locked after grace", () => {
    expect(
      accessForTeam(
        { billing_status: "canceled", trial_ends_at: "2026-07-01T00:00:00.000Z" },
        now,
      ),
    ).toBe("locked");
  });
});

describe("paidPlanAccess (Knowledge + Leaderboard)", () => {
  const now = new Date("2026-08-15T12:00:00.000Z");

  it("locks free-tier after trial even when analytics stay free", () => {
    expect(
      paidPlanAccess(
        {
          billing_status: "trialing",
          trial_ends_at: "2020-01-01T00:00:00.000Z",
          stripe_subscription_id: null,
        },
        now,
      ),
    ).toBe("locked");
  });

  it("is full during trial", () => {
    expect(
      paidPlanAccess(
        {
          billing_status: "trialing",
          trial_ends_at: "2026-09-01T00:00:00.000Z",
          stripe_subscription_id: null,
        },
        now,
      ),
    ).toBe("full");
  });

  it("is full when active, comp, or subscribed", () => {
    expect(
      paidPlanAccess({ billing_status: "active", trial_ends_at: null, stripe_subscription_id: "sub_x" }, now),
    ).toBe("full");
    expect(
      paidPlanAccess({ billing_status: "comp", trial_ends_at: null, stripe_subscription_id: null }, now),
    ).toBe("full");
    expect(
      paidPlanAccess(
        { billing_status: "canceled", trial_ends_at: "2020-01-01T00:00:00.000Z", stripe_subscription_id: "sub_y" },
        now,
      ),
    ).toBe("full");
  });

  it("is read_only in post-trial grace", () => {
    expect(
      paidPlanAccess(
        {
          billing_status: "trialing",
          trial_ends_at: "2026-08-10T00:00:00.000Z",
          stripe_subscription_id: null,
        },
        now,
      ),
    ).toBe("read_only");
  });
});

describe("trialEndsFrom", () => {
  it("adds 30 days", () => {
    const end = trialEndsFrom(new Date("2026-08-01T00:00:00.000Z"));
    expect(end.startsWith("2026-08-31")).toBe(true);
  });
});

describe("billingMessage", () => {
  it("mentions trial days remaining", () => {
    const msg = billingMessage("full", {
      billing_status: "trialing",
      trial_ends_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });
    expect(msg).toMatch(/Trial ends/);
  });
});

describe("countSeats + filterUploadTeamIds", () => {
  it("counts active members only", async () => {
    const env = makeEnv();
    await seedUser(env, "u1");
    await seedUser(env, "u2");
    await seedUser(env, "u3");
    await seedTeam(env, "tm1", "u1");
    await addMember(env, "tm1", "u2", "employee");
    await addMember(env, "tm1", "u3", "employee");
    await env.DB.prepare(
      "UPDATE team_members SET left_at = ? WHERE team_id = ? AND user_id = ?",
    )
      .bind(new Date().toISOString(), "tm1", "u3")
      .run();
    expect(await countSeats(env, "tm1")).toBe(2);
  });

  it("does not filter uploads when BILLING_ENFORCE is off", async () => {
    const env = makeEnv({ BILLING_ENFORCE: "false" });
    await seedUser(env, "u1");
    await seedTeam(env, "tm1", "u1");
    await env.DB.prepare(
      "UPDATE teams SET trial_ends_at = ?, billing_status = 'trialing' WHERE id = ?",
    )
      .bind("2020-01-01T00:00:00.000Z", "tm1")
      .run();
    const r = await filterUploadTeamIds(env, ["tm1"]);
    expect(r.allowed).toEqual(["tm1"]);
    expect(r.skipped).toEqual([]);
  });

  it("skips oversized locked teams when BILLING_ENFORCE is on", async () => {
    const env = makeEnv({ BILLING_ENFORCE: "true" });
    await seedUser(env, "u1");
    await seedUser(env, "u2");
    await seedUser(env, "u3");
    await seedUser(env, "u4");
    await seedTeam(env, "tm1", "u1");
    await addMember(env, "tm1", "u2", "employee");
    await addMember(env, "tm1", "u3", "employee");
    await addMember(env, "tm1", "u4", "employee");
    await env.DB.prepare(
      "UPDATE teams SET trial_ends_at = ?, billing_status = 'canceled' WHERE id = ?",
    )
      .bind("2020-01-01T00:00:00.000Z", "tm1")
      .run();
    const r = await filterUploadTeamIds(env, ["tm1"]);
    expect(r.allowed).toEqual([]);
    expect(r.skipped[0]?.reason).toBe("billing");
  });

  it("requireWritableBilling no-ops when enforce off", async () => {
    const env = makeEnv({ BILLING_ENFORCE: "false" });
    await seedUser(env, "u1");
    await seedTeam(env, "tm1", "u1");
    const team = await env.DB.prepare("SELECT * FROM teams WHERE id = ?").bind("tm1").first();
    await expect(requireWritableBilling(env, team as never)).resolves.toBeUndefined();
  });

  it("requireWritableBilling allows free-tier roster under enforce", async () => {
    const env = makeEnv({ BILLING_ENFORCE: "true" });
    await seedUser(env, "u1");
    await seedTeam(env, "tm1", "u1");
    await env.DB.prepare(
      "UPDATE teams SET trial_ends_at = ?, billing_status = 'trialing' WHERE id = ?",
    )
      .bind("2020-01-01T00:00:00.000Z", "tm1")
      .run();
    const team = await env.DB.prepare("SELECT * FROM teams WHERE id = ?").bind("tm1").first();
    await expect(requireWritableBilling(env, team as never)).resolves.toBeUndefined();
  });

  it("requireWritableBilling throws 402 when enforce on, oversized, and trial ended", async () => {
    const env = makeEnv({ BILLING_ENFORCE: "true" });
    await seedUser(env, "u1");
    await seedUser(env, "u2");
    await seedUser(env, "u3");
    await seedUser(env, "u4");
    await seedTeam(env, "tm1", "u1");
    await addMember(env, "tm1", "u2", "employee");
    await addMember(env, "tm1", "u3", "employee");
    await addMember(env, "tm1", "u4", "employee");
    await env.DB.prepare(
      "UPDATE teams SET trial_ends_at = ?, billing_status = 'trialing' WHERE id = ?",
    )
      .bind("2020-01-01T00:00:00.000Z", "tm1")
      .run();
    const team = await env.DB.prepare("SELECT * FROM teams WHERE id = ?").bind("tm1").first();
    await expect(requireWritableBilling(env, team as never)).rejects.toBeInstanceOf(HttpError);
    try {
      await requireWritableBilling(env, team as never);
    } catch (e) {
      expect((e as HttpError).status).toBe(402);
      expect((e as HttpError).code).toBe("billing_required");
    }
  });
});

describe("billing notice gating (client contract)", () => {
  it("billing snapshot exposes enforce from env", async () => {
    const env = makeEnv({ BILLING_ENFORCE: "false" });
    await seedUser(env, "u1");
    await seedTeam(env, "tm1", "u1");
    const team = await env.DB.prepare("SELECT * FROM teams WHERE id = ?").bind("tm1").first();
    const { billingSnapshot } = await import("../src/billing/entitlement");
    const off = await billingSnapshot(env, team as never);
    expect(off.enforce).toBe(false);
    const onEnv = makeEnv({ BILLING_ENFORCE: "true" });
    // reuse same shape — snapshot only reads env flag
    const on = await billingSnapshot(onEnv, {
      ...(team as object),
      trial_ends_at: new Date(Date.now() + 864e5).toISOString(),
      billing_status: "trialing",
    } as never);
    expect(on.enforce).toBe(true);
  });
});

describe("ensureTeamTrial", () => {
  it("backfills trial for pre-billing teams", async () => {
    const env = makeEnv();
    await seedUser(env, "u1");
    await seedTeam(env, "tm1", "u1");
    const before = await env.DB.prepare("SELECT * FROM teams WHERE id = ?").bind("tm1").first();
    expect((before as { trial_ends_at: string | null }).trial_ends_at).toBeNull();
    const after = await ensureTeamTrial(env, before as never);
    expect(after.trial_ends_at).toBeTruthy();
    expect(after.billing_status).toBe("trialing");
  });

  it("does not overwrite an existing trial clock", async () => {
    const env = makeEnv();
    await seedUser(env, "u1");
    await seedTeam(env, "tm1", "u1");
    await env.DB.prepare("UPDATE teams SET trial_ends_at = ?, billing_status = 'trialing' WHERE id = ?")
      .bind("2026-09-01T00:00:00.000Z", "tm1")
      .run();
    const team = await env.DB.prepare("SELECT * FROM teams WHERE id = ?").bind("tm1").first();
    const after = await ensureTeamTrial(env, team as never);
    expect(after.trial_ends_at).toBe("2026-09-01T00:00:00.000Z");
  });
});
