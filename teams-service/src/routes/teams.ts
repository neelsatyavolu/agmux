import type { Env } from "../env";
import { newId } from "../crypto";
import { nowIso, slugify, type Role } from "../db";
import { badRequest, conflict, forbidden, json, readJson } from "../http";
import { requireCapability, requireTeam } from "../authz";
import { isPlatformStaff } from "../staff";
import { writeAudit } from "./audit";
import type { Principal } from "../session";
import { purgeUserFromScopes } from "../scope";
import {
  billingSnapshot,
  defaultTrialEndsAt,
  ensureTeamTrial,
  requireWritableBilling,
} from "../billing/entitlement";
import { cancelSubscription } from "../billing/stripe";
import { syncSeatQuantity } from "./billing";
import { featuresPayload, isKnowledgeReady } from "../knowledge/ready";

interface TeamListRow {
  id: string;
  slug: string;
  name: string;
  role: Role;
  member_count: number;
  last_upload_at: string | null;
  staffPreview?: boolean;
}

export async function listTeams(env: Env, principal: Principal): Promise<Response> {
  const r = await env.DB.prepare(
    `SELECT t.id, t.slug, t.name, m.role,
            (SELECT COUNT(*) FROM team_members x WHERE x.team_id = t.id AND x.left_at IS NULL) AS member_count,
            (SELECT MAX(s.last_upload_at) FROM sync_state s WHERE s.user_id = m.user_id) AS last_upload_at
     FROM team_members m
     JOIN teams t ON t.id = m.team_id
     WHERE m.user_id = ? AND m.left_at IS NULL AND t.deleted_at IS NULL
     ORDER BY t.name COLLATE NOCASE`,
  )
    .bind(principal.userId)
    .all<TeamListRow>();
  const mine = (r.results ?? []).map((t) => ({ ...t, staffPreview: false }));

  // Web only: platform staff also see every other registered team as a
  // read-only preview. Desktop device tokens stay membership-only.
  if (principal.via !== "device" && (await isPlatformStaff(env, principal.userId))) {
    const extra = await env.DB.prepare(
      `SELECT t.id, t.slug, t.name, 'manager' AS role,
              (SELECT COUNT(*) FROM team_members x WHERE x.team_id = t.id AND x.left_at IS NULL) AS member_count,
              (SELECT MAX(s.last_upload_at)
                 FROM sync_state s
                 JOIN team_members m ON m.user_id = s.user_id
                WHERE m.team_id = t.id AND m.left_at IS NULL) AS last_upload_at
       FROM teams t
       WHERE t.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM team_members m
            WHERE m.team_id = t.id AND m.user_id = ? AND m.left_at IS NULL
         )
       ORDER BY t.name COLLATE NOCASE`,
    )
      .bind(principal.userId)
      .all<TeamListRow>();
    for (const t of extra.results ?? []) mine.push({ ...t, role: "manager", staffPreview: true });
  }

  // Extra `features` is ignored by older desktop clients that only read `teams`.
  return json({ teams: mine, features: await featuresPayload(env) });
}

export async function createTeam(req: Request, env: Env, principal: Principal): Promise<Response> {
  const body = await readJson<{ name?: string }>(req);
  const name = (body.name ?? "").trim();
  if (!name) throw badRequest("Give the team a name.");
  if (name.length > 80) throw badRequest("Team names are limited to 80 characters.");

  const teamId = newId("tm");
  const now = nowIso();
  let slug = slugify(name);
  // Slugs are user-visible in URLs, so resolve collisions rather than failing.
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await env.DB.prepare("SELECT 1 FROM teams WHERE slug = ?").bind(slug).first();
    if (!clash) break;
    slug = `${slugify(name)}-${teamId.slice(-4)}${attempt || ""}`;
  }

  const trialEnds = defaultTrialEndsAt();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO teams (id, slug, name, created_by, created_at, trial_ends_at, billing_status)
       VALUES (?, ?, ?, ?, ?, ?, 'trialing')`,
    ).bind(teamId, slug, name, principal.userId, now, trialEnds),
    // Creator is always the owner.
    env.DB.prepare(
      "INSERT INTO team_members (id, team_id, user_id, role, joined_at) VALUES (?, ?, ?, 'owner', ?)",
    ).bind(newId("mem"), teamId, principal.userId, now),
  ]);

  await writeAudit(env, teamId, principal.userId, "team.created", null, name);

  return json(
    {
      team: {
        id: teamId,
        slug,
        name,
        role: "owner" as Role,
        trialEndsAt: trialEnds,
        billingStatus: "trialing",
      },
    },
    { status: 201 },
  );
}

export async function getTeam(env: Env, principal: Principal, key: string): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  // Existing teams (pre-billing) get a seamless 30-day trial on first load.
  const team = await ensureTeamTrial(env, ctx.team);
  const counts = await env.DB.prepare(
    `SELECT
       COUNT(*) AS members,
       SUM(CASE WHEN role = 'manager' THEN 1 ELSE 0 END) AS managers,
       SUM(CASE WHEN role = 'owner' THEN 1 ELSE 0 END) AS owners
     FROM team_members WHERE team_id = ? AND left_at IS NULL`,
  )
    .bind(team.id)
    .first<{ members: number; managers: number; owners: number }>();

  const fresh = await env.DB.prepare(
    `SELECT MAX(s.last_upload_at) AS last_upload_at
     FROM sync_state s
     JOIN team_members m ON m.user_id = s.user_id
     WHERE m.team_id = ? AND m.left_at IS NULL`,
  )
    .bind(team.id)
    .first<{ last_upload_at: string | null }>();

  const billing = await billingSnapshot(env, team);
  return json({
    team: { id: team.id, slug: team.slug, name: team.name },
    role: ctx.role,
    staffPreview: ctx.staffPreview,
    counts: counts ?? { members: 0, managers: 0, owners: 0 },
    lastUploadAt: fresh?.last_upload_at ?? null,
    billing,
    // Older clients ignore unknown fields; new web/desktop gate Knowledge UI on this.
    features: await featuresPayload(env),
  });
}

export async function renameTeam(
  req: Request,
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  await requireWritableBilling(env, ctx.team);
  requireCapability(ctx, "team.rename");
  const body = await readJson<{ name?: string }>(req);
  const name = (body.name ?? "").trim();
  if (!name) throw badRequest("Give the team a name.");
  await env.DB.prepare("UPDATE teams SET name = ? WHERE id = ?").bind(name.slice(0, 80), ctx.team.id).run();
  await writeAudit(env, ctx.team.id, principal.userId, "team.renamed", null, `${ctx.team.name} → ${name}`);
  return json({ team: { id: ctx.team.id, slug: ctx.team.slug, name } });
}

export async function deleteTeam(env: Env, principal: Principal, key: string): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "team.delete");
  const now = nowIso();

  // Cancel Stripe first (best-effort) so the team is not billed after delete.
  const subId = ctx.team.stripe_subscription_id?.trim();
  if (subId) {
    try {
      await cancelSubscription(env, subId);
    } catch {
      // Still soft-delete the team; webhook/orphan cleanup can clear Stripe state.
    }
  }

  // Soft-delete the team, hard-delete its telemetry — the disclosure promises
  // that deleting a team removes every uploaded aggregate.
  const stmts = [
    env.DB.prepare("UPDATE teams SET deleted_at = ? WHERE id = ?").bind(now, ctx.team.id),
    env.DB.prepare("UPDATE team_members SET left_at = ? WHERE team_id = ? AND left_at IS NULL")
      .bind(now, ctx.team.id),
    env.DB.prepare("DELETE FROM metric_hourly WHERE team_id = ?").bind(ctx.team.id),
    env.DB.prepare("UPDATE invites SET revoked_at = ? WHERE team_id = ? AND revoked_at IS NULL")
      .bind(now, ctx.team.id),
  ];

  // Knowledge content plane: hard-delete all kw_* rows for this team when present.
  if (await isKnowledgeReady(env)) {
    const tid = ctx.team.id;
    stmts.push(
      env.DB.prepare("DELETE FROM kw_records WHERE team_id = ?").bind(tid),
      env.DB.prepare("DELETE FROM kw_record_versions WHERE team_id = ?").bind(tid),
      env.DB.prepare("DELETE FROM kw_session_digests WHERE team_id = ?").bind(tid),
      env.DB.prepare("DELETE FROM kw_team_policy WHERE team_id = ?").bind(tid),
      env.DB.prepare("DELETE FROM kw_workspaces WHERE team_id = ?").bind(tid),
      env.DB.prepare("DELETE FROM kw_disclosure_accept WHERE team_id = ?").bind(tid),
      env.DB.prepare("DELETE FROM kw_idempotency WHERE team_id = ?").bind(tid),
    );
  }

  await env.DB.batch(stmts);
  return json({ deleted: true });
}

export async function leaveTeam(env: Env, principal: Principal, key: string): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  if (ctx.role === "owner") {
    throw forbidden("Transfer ownership before leaving, so the team keeps an owner.");
  }
  requireCapability(ctx, "team.leave");
  const res = await env.DB.prepare(
    "UPDATE team_members SET left_at = ? WHERE team_id = ? AND user_id = ? AND left_at IS NULL",
  )
    .bind(nowIso(), ctx.team.id, principal.userId)
    .run();
  if ((res.meta?.changes ?? 0) === 0) throw conflict("You're not on that team.");
  await purgeUserFromScopes(env, ctx.team.id, principal.userId);
  await writeAudit(env, ctx.team.id, principal.userId, "member.left", principal.userId, `was ${ctx.role}`);
  await syncSeatQuantity(env, ctx.team.id);
  return json({ left: true });
}
