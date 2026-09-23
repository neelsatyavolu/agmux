import { describe, expect, it } from "vitest";
import {
  acceptInvite,
  createInvite,
  getInvite,
  inviteState,
  previewInvite,
  revokeInvite,
} from "../src/routes/invites";
import { sha256 } from "../src/crypto";
import type { InviteRow } from "../src/db";
import type { Principal } from "../src/session";
import { addMember, makeEnv, seedTeam, seedUser } from "./helpers/d1";

const principal = (userId: string): Principal => ({ userId, deviceId: null, via: "cookie" });

const post = (body: unknown) =>
  new Request("https://teams.agmux.dev/api/x", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

async function unwrap<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { ok: boolean; data: T };
  expect(body.ok).toBe(true);
  return body.data;
}

/** Pulls the raw token out of the create response's invite URL. */
async function newInvite(env: ReturnType<typeof makeEnv>, teamId: string, owner: string) {
  const res = await createInvite(post({}), env, principal(owner), teamId);
  const data = await unwrap<{ invite: { url: string; state: string } }>(res);
  return data.invite.url.split("/join/")[1]!;
}

describe("inviteState", () => {
  const base: InviteRow = {
    id: "inv",
    team_id: "tm",
    token_hash: "h",
    token: "raw-token",
    created_by: "u",
    created_at: "2026-07-01T00:00:00.000Z",
    expires_at: "2026-08-01T00:00:00.000Z",
    max_uses: null,
    uses: 0,
    revoked_at: null,
  };
  const at = (iso: string) => new Date(iso);

  it("is active inside its window", () => {
    expect(inviteState(base, at("2026-07-15T00:00:00Z"))).toBe("active");
  });
  it("expires on time", () => {
    expect(inviteState(base, at("2026-08-02T00:00:00Z"))).toBe("expired");
  });
  it("reports revoked ahead of expiry", () => {
    expect(inviteState({ ...base, revoked_at: "2026-07-02T00:00:00.000Z" }, at("2026-08-02T00:00:00Z"))).toBe(
      "revoked",
    );
  });
  it("reports exhausted when uses run out", () => {
    expect(inviteState({ ...base, max_uses: 2, uses: 2 }, at("2026-07-15T00:00:00Z"))).toBe("exhausted");
  });
});

describe("invite lifecycle", () => {
  it("hashes the token for lookup and keeps plaintext for owner re-display", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedTeam(env, "tm1", "owner1");
    const token = await newInvite(env, "tm1", "owner1");

    const row = await env.DB.prepare("SELECT token_hash, token FROM invites").first<{
      token_hash: string;
      token: string | null;
    }>();
    expect(row!.token_hash).toBe(await sha256(token));
    expect(row!.token_hash).not.toBe(token);
    expect(row!.token).toBe(token);

    // getInvite must still return a copyable URL after "navigating away".
    const again = await unwrap<{ invite: { url: string | null; state: string } }>(
      await getInvite(env, principal("owner1"), "tm1"),
    );
    expect(again.invite.state).toBe("active");
    expect(again.invite.url).toContain(`/join/${token}`);
  });

  it("clears the plaintext token when the invite is revoked", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedTeam(env, "tm1", "owner1");
    await newInvite(env, "tm1", "owner1");
    await revokeInvite(env, principal("owner1"), "tm1");

    const row = await env.DB.prepare("SELECT token, revoked_at FROM invites").first<{
      token: string | null;
      revoked_at: string | null;
    }>();
    expect(row!.revoked_at).not.toBeNull();
    expect(row!.token).toBeNull();

    const again = await unwrap<{ invite: { url: string | null; state: string } }>(
      await getInvite(env, principal("owner1"), "tm1"),
    );
    expect(again.invite.state).toBe("revoked");
    expect(again.invite.url).toBeNull();
  });

  it("refuses invite creation for a manager (v1 is owner-only)", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "mgr1");
    await seedTeam(env, "tm1", "owner1");
    await addMember(env, "tm1", "mgr1", "manager");

    await expect(createInvite(post({}), env, principal("mgr1"), "tm1")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("joins as employee only after the disclosure is accepted", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "newbie");
    await seedTeam(env, "tm1", "owner1");
    const token = await newInvite(env, "tm1", "owner1");

    // Not accepting is a hard refusal — there is no silent-enroll path.
    await expect(
      acceptInvite(post({ accepted: false }), env, principal("newbie"), token),
    ).rejects.toMatchObject({ status: 400 });
    await expect(acceptInvite(post({}), env, principal("newbie"), token)).rejects.toMatchObject({
      status: 400,
    });

    const res = await acceptInvite(post({ accepted: true }), env, principal("newbie"), token);
    const data = await unwrap<{ joined: boolean; alreadyMember: boolean }>(res);
    expect(data).toMatchObject({ joined: true, alreadyMember: false });

    const member = await env.DB.prepare(
      "SELECT role, left_at FROM team_members WHERE team_id = ? AND user_id = ?",
    )
      .bind("tm1", "newbie")
      .first<{ role: string; left_at: string | null }>();
    expect(member).toMatchObject({ role: "employee", left_at: null });
  });

  it("is idempotent for someone who is already a member and does not burn a use", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "newbie");
    await seedTeam(env, "tm1", "owner1");
    const token = await newInvite(env, "tm1", "owner1");

    await acceptInvite(post({ accepted: true }), env, principal("newbie"), token);
    const again = await acceptInvite(post({ accepted: true }), env, principal("newbie"), token);
    expect(await unwrap<{ alreadyMember: boolean }>(again)).toMatchObject({ alreadyMember: true });

    const row = await env.DB.prepare("SELECT uses FROM invites WHERE revoked_at IS NULL").first<{
      uses: number;
    }>();
    expect(row!.uses).toBe(1);
  });

  it("lets a member who left rejoin through a fresh link", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "emp1");
    await seedTeam(env, "tm1", "owner1");
    await addMember(env, "tm1", "emp1", "employee");
    await env.DB.prepare("UPDATE team_members SET left_at = ? WHERE user_id = ?")
      .bind(new Date().toISOString(), "emp1")
      .run();

    const token = await newInvite(env, "tm1", "owner1");
    await acceptInvite(post({ accepted: true }), env, principal("emp1"), token);

    const member = await env.DB.prepare("SELECT left_at FROM team_members WHERE user_id = ?")
      .bind("emp1")
      .first<{ left_at: string | null }>();
    expect(member!.left_at).toBeNull();
  });

  it("refuses a revoked link with an explanation, not a 404", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "newbie");
    await seedTeam(env, "tm1", "owner1");
    const token = await newInvite(env, "tm1", "owner1");

    await revokeInvite(env, principal("owner1"), "tm1");

    await expect(
      acceptInvite(post({ accepted: true }), env, principal("newbie"), token),
    ).rejects.toMatchObject({ status: 409 });

    const preview = await unwrap<{ state: string }>(await previewInvite(env, token));
    expect(preview.state).toBe("revoked");
  });

  it("refuses an expired link", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "newbie");
    await seedTeam(env, "tm1", "owner1");
    const token = await newInvite(env, "tm1", "owner1");

    await env.DB.prepare("UPDATE invites SET expires_at = ?")
      .bind("2020-01-01T00:00:00.000Z")
      .run();

    await expect(
      acceptInvite(post({ accepted: true }), env, principal("newbie"), token),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("supersedes the previous link when regenerating", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "newbie");
    await seedTeam(env, "tm1", "owner1");

    const first = await newInvite(env, "tm1", "owner1");
    const second = await newInvite(env, "tm1", "owner1");
    expect(second).not.toBe(first);

    await expect(
      acceptInvite(post({ accepted: true }), env, principal("newbie"), first),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      acceptInvite(post({ accepted: true }), env, principal("newbie"), second),
    ).resolves.toBeDefined();
  });

  it("rejects an unknown token", async () => {
    const env = makeEnv();
    await expect(previewInvite(env, "not-a-real-token")).rejects.toMatchObject({ status: 404 });
  });

  it("enforces max_uses atomically — second join fails without overshooting", async () => {
    const env = makeEnv();
    await seedUser(env, "owner1");
    await seedUser(env, "a");
    await seedUser(env, "b");
    await seedTeam(env, "tm1", "owner1");

    const res = await createInvite(post({ maxUses: 1 }), env, principal("owner1"), "tm1");
    const data = await unwrap<{ invite: { url: string; maxUses: number } }>(res);
    expect(data.invite.maxUses).toBe(1);
    const token = data.invite.url.split("/join/")[1]!;

    await acceptInvite(post({ accepted: true }), env, principal("a"), token);
    await expect(
      acceptInvite(post({ accepted: true }), env, principal("b"), token),
    ).rejects.toMatchObject({ status: 409 });

    const row = await env.DB.prepare("SELECT uses, max_uses FROM invites WHERE revoked_at IS NULL").first<{
      uses: number;
      max_uses: number;
    }>();
    expect(row).toMatchObject({ uses: 1, max_uses: 1 });

    const members = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND left_at IS NULL",
    )
      .bind("tm1")
      .first<{ n: number }>();
    // owner + a only
    expect(members!.n).toBe(2);
  });
});
