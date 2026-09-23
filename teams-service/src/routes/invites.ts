import { resolveAvatarUrl } from "../avatar";
import type { Env } from "../env";
import { inviteTtlDays } from "../env";
import { mintInviteToken, newId, sha256 } from "../crypto";
import { isoPlusDays, nowIso, type InviteRow } from "../db";
import { badRequest, conflict, HttpError, json, notFound, readJson } from "../http";
import { requireCapability, requireTeam } from "../authz";
import type { Principal } from "../session";
import { writeAudit } from "./audit";
import {
  accessForTeam,
  countSeats,
  requireWritableBilling,
} from "../billing/entitlement";
import { billingEnforce } from "../env";
import { syncSeatQuantity } from "./billing";

/**
 * Invite state is deliberately explicit rather than boolean: the UI shows
 * "expired" / "revoked" / "used up" as distinct, honest states.
 */
export type InviteState = "active" | "expired" | "revoked" | "exhausted";

export function inviteState(row: InviteRow, now = new Date()): InviteState {
  if (row.revoked_at) return "revoked";
  if (row.expires_at && Date.parse(row.expires_at) <= now.getTime()) return "expired";
  if (row.max_uses !== null && row.uses >= row.max_uses) return "exhausted";
  return "active";
}

const publicInvite = (row: InviteRow, token: string | null, env: Env) => ({
  id: row.id,
  state: inviteState(row),
  url: token ? `${env.APP_ORIGIN}/join/${token}` : null,
  expiresAt: row.expires_at,
  maxUses: row.max_uses,
  uses: row.uses,
  usesLeft: row.max_uses === null ? null : Math.max(0, row.max_uses - row.uses),
  createdAt: row.created_at,
  createdBy: row.created_by,
});

/** The most recent non-revoked invite is "the" team link in the UI. */
async function currentInvite(env: Env, teamId: string): Promise<InviteRow | null> {
  return env.DB.prepare(
    "SELECT * FROM invites WHERE team_id = ? ORDER BY revoked_at IS NOT NULL, created_at DESC LIMIT 1",
  )
    .bind(teamId)
    .first<InviteRow>();
}

export async function getInvite(env: Env, principal: Principal, key: string): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "invite.manage");
  const row = await currentInvite(env, ctx.team.id);
  if (!row) return json({ invite: null });

  const creator = await env.DB.prepare("SELECT display_name FROM users WHERE id = ?")
    .bind(row.created_by)
    .first<{ display_name: string }>();
  // Prefer stored plaintext token so owners can re-copy after navigation.
  // Legacy rows (pre-token column) and revoked invites have token NULL → masked UI.
  const token = row.revoked_at ? null : (row.token ?? null);
  return json({
    invite: { ...publicInvite(row, token, env), creatorName: creator?.display_name ?? null },
  });
}

export async function createInvite(
  req: Request,
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "invite.manage");
  await requireWritableBilling(env, ctx.team);

  const body = await readJson<{ expiresInDays?: number; maxUses?: number | null }>(req).catch(
    () => ({}) as { expiresInDays?: number; maxUses?: number | null },
  );
  const days = Number.isFinite(body.expiresInDays) ? Number(body.expiresInDays) : inviteTtlDays(env);
  if (days <= 0 || days > 365) throw badRequest("Expiry must be between 1 and 365 days.");
  const maxUses =
    body.maxUses === null || body.maxUses === undefined ? null : Math.max(1, Math.trunc(body.maxUses));

  const token = mintInviteToken();
  const row: InviteRow = {
    id: newId("inv"),
    team_id: ctx.team.id,
    token_hash: await sha256(token),
    token,
    created_by: principal.userId,
    created_at: nowIso(),
    expires_at: isoPlusDays(days),
    max_uses: maxUses,
    uses: 0,
    revoked_at: null,
  };

  await env.DB.batch([
    // Regenerating supersedes the old link, matching the design's single-link UI.
    // Wipe the old plaintext so a revoked row cannot re-expose the prior URL.
    env.DB.prepare(
      "UPDATE invites SET revoked_at = ?, token = NULL WHERE team_id = ? AND revoked_at IS NULL",
    ).bind(row.created_at, ctx.team.id),
    env.DB.prepare(
      `INSERT INTO invites (id, team_id, token_hash, token, created_by, created_at, expires_at, max_uses, uses)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).bind(
      row.id,
      row.team_id,
      row.token_hash,
      row.token,
      row.created_by,
      row.created_at,
      row.expires_at,
      row.max_uses,
    ),
  ]);

  await writeAudit(
    env,
    ctx.team.id,
    principal.userId,
    "invite.created",
    row.id,
    `expires in ${days}d, ${maxUses === null ? "unlimited uses" : `${maxUses} use(s)`}`,
  );

  // This is the only moment the raw token exists outside the URL.
  return json({ invite: publicInvite(row, token, env) }, { status: 201 });
}

export async function revokeInvite(env: Env, principal: Principal, key: string): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "invite.manage");
  await env.DB.prepare(
    "UPDATE invites SET revoked_at = ?, token = NULL WHERE team_id = ? AND revoked_at IS NULL",
  )
    .bind(nowIso(), ctx.team.id)
    .run();
  await writeAudit(env, ctx.team.id, principal.userId, "invite.revoked", null, null);
  return json({ revoked: true });
}

/** Public preview for /join/<token>. Reveals only what the invitee must see. */
export async function previewInvite(env: Env, token: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM invites WHERE token_hash = ?")
    .bind(await sha256(token))
    .first<InviteRow>();
  if (!row) throw notFound("That invite link isn't valid.");

  const state = inviteState(row);
  const team = await env.DB.prepare("SELECT id, name FROM teams WHERE id = ? AND deleted_at IS NULL")
    .bind(row.team_id)
    .first<{ id: string; name: string }>();
  if (!team) throw notFound("That team no longer exists.");

  const inviterRaw = await env.DB.prepare(
    `SELECT display_name, avatar_color, avatar_url AS stored_avatar_url,
            (SELECT i.provider_user_id FROM identities i
             WHERE i.user_id = users.id AND i.provider = 'github' LIMIT 1) AS github_id
     FROM users WHERE id = ?`,
  )
    .bind(row.created_by)
    .first<{
      display_name: string;
      avatar_color: string;
      stored_avatar_url: string | null;
      github_id: string | null;
    }>();
  const inviter = inviterRaw
    ? {
        display_name: inviterRaw.display_name,
        avatar_color: inviterRaw.avatar_color,
        avatar_url: resolveAvatarUrl(inviterRaw.stored_avatar_url, inviterRaw.github_id),
      }
    : null;
  const owner = await env.DB.prepare(
    `SELECT u.display_name FROM team_members m JOIN users u ON u.id = m.user_id
     WHERE m.team_id = ? AND m.role = 'owner' AND m.left_at IS NULL LIMIT 1`,
  )
    .bind(team.id)
    .first<{ display_name: string }>();
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND left_at IS NULL",
  )
    .bind(team.id)
    .first<{ n: number }>();

  return json({
    state,
    expiresAt: row.expires_at,
    team: { name: team.name },
    inviter,
    ownerName: owner?.display_name ?? null,
    memberCount: count?.n ?? 0,
  });
}

/**
 * Join. The disclosure is not optional: without an explicit `accepted: true`
 * the request is refused, so there is no code path that enrolls someone
 * silently.
 */
export async function acceptInvite(
  req: Request,
  env: Env,
  principal: Principal,
  token: string,
): Promise<Response> {
  const body = await readJson<{ accepted?: boolean }>(req);
  if (body.accepted !== true) {
    throw badRequest("You must accept the metrics disclosure to join.");
  }

  const row = await env.DB.prepare("SELECT * FROM invites WHERE token_hash = ?")
    .bind(await sha256(token))
    .first<InviteRow>();
  if (!row) throw notFound("That invite link isn't valid.");

  const state = inviteState(row);
  if (state !== "active") {
    throw conflict(
      state === "expired"
        ? "This invite has expired — ask the team owner for a new link."
        : state === "revoked"
          ? "This invite was revoked — ask the team owner for a new link."
          : "This invite has been used up — ask the team owner for a new link.",
    );
  }

  const team = await env.DB.prepare("SELECT * FROM teams WHERE id = ? AND deleted_at IS NULL")
    .bind(row.team_id)
    .first<import("../db").TeamRow>();
  if (!team) throw notFound("That team no longer exists.");
  await requireWritableBilling(env, team);
  if (billingEnforce(env)) {
    const seats = await countSeats(env, team.id);
    const now = new Date();
    const current = accessForTeam(team, now, seats);
    const next = accessForTeam(team, now, seats + 1);
    if (current === "full" && next !== "full") {
      throw new HttpError(
        402,
        "Adding this member would lock the team. Subscribe on the Plan tab first, or keep the roster at 3.",
        "billing_required",
      );
    }
  }

  const existing = await env.DB.prepare(
    "SELECT id, left_at FROM team_members WHERE team_id = ? AND user_id = ?",
  )
    .bind(team.id, principal.userId)
    .first<{ id: string; left_at: string | null }>();

  const now = nowIso();
  if (existing && !existing.left_at) {
    // Already a member — idempotent, and doesn't burn a use.
    return json({
      joined: true,
      alreadyMember: true,
      team: { id: team.id, slug: team.slug, name: team.name },
    });
  }

  // Atomic seat claim — closes TOCTOU where two concurrent accepts both pass
  // inviteState(max_uses) then both increment past the cap.
  const claim = await env.DB.prepare(
    "UPDATE invites SET uses = uses + 1 WHERE id = ? AND (max_uses IS NULL OR uses < max_uses)",
  )
    .bind(row.id)
    .run();
  if (!claim.meta.changes) {
    throw conflict(
      "This invite has been used up — ask the team owner for a new link.",
    );
  }

  const memberStmt = existing
    ? env.DB.prepare(
        "UPDATE team_members SET left_at = NULL, role = 'employee', joined_at = ? WHERE id = ?",
      ).bind(now, existing.id)
    : env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, role, joined_at) VALUES (?, ?, ?, 'employee', ?)",
      ).bind(newId("mem"), team.id, principal.userId, now);
  try {
    await memberStmt.run();
  } catch (err) {
    // Roll back the burned use so a failed enroll can retry.
    await env.DB.prepare(
      "UPDATE invites SET uses = CASE WHEN uses > 0 THEN uses - 1 ELSE 0 END WHERE id = ?",
    )
      .bind(row.id)
      .run();
    throw err;
  }

  await writeAudit(
    env,
    team.id,
    principal.userId,
    "member.joined",
    principal.userId,
    existing ? "rejoined via invite" : "joined via invite",
  );
  await syncSeatQuantity(env, team.id);

  return json({
    joined: true,
    alreadyMember: false,
    team: { id: team.id, slug: team.slug, name: team.name },
  });
}
