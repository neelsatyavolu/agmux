import { resolveAvatarUrl } from "../avatar";
import type { Env } from "../env";
import { nowIso, type Role } from "../db";
import { badRequest, conflict, json, notFound, readJson } from "../http";
import { can, requireCapability, requireTeam } from "../authz";
import type { Principal } from "../session";
import { writeAudit } from "./audit";
import { requireWritableBilling } from "../billing/entitlement";
import { syncSeatQuantity } from "./billing";
import {
  clearManagerScope,
  loadManagerScopeConfig,
  purgeUserFromScopes,
  resolveAnalyticsScope,
} from "../scope";

export interface RosterRow {
  user_id: string;
  display_name: string;
  handle: string | null;
  email: string | null;
  avatar_color: string;
  /** Resolved https photo URL, or null for initials. */
  avatar_url: string | null;
  role: Role;
  joined_at: string;
  last_upload_at: string | null;
  /** IANA zone from the last metrics upload, e.g. `Asia/Tokyo`. */
  timezone: string | null;
}

export async function roster(env: Env, teamId: string): Promise<RosterRow[]> {
  const r = await env.DB.prepare(
    `SELECT m.user_id, u.display_name, u.handle, u.email, u.avatar_color, u.avatar_url AS stored_avatar_url,
            (SELECT i.provider_user_id FROM identities i
             WHERE i.user_id = u.id AND i.provider = 'github' LIMIT 1) AS github_id,
            u.timezone, m.role, m.joined_at,
            (SELECT MAX(s.last_upload_at) FROM sync_state s WHERE s.user_id = m.user_id) AS last_upload_at
     FROM team_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.team_id = ? AND m.left_at IS NULL
     ORDER BY
       CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,
       u.display_name COLLATE NOCASE`,
  )
    .bind(teamId)
    .all<
      Omit<RosterRow, "avatar_url"> & {
        stored_avatar_url: string | null;
        github_id: string | null;
      }
    >();
  return (r.results ?? []).map(({ stored_avatar_url, github_id, ...rest }) => ({
    ...rest,
    avatar_url: resolveAvatarUrl(stored_avatar_url, github_id),
  }));
}

export async function listMembers(env: Env, principal: Principal, key: string): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  const rows = await roster(env, ctx.team.id);
  const scope = await resolveAnalyticsScope(env, ctx);
  // Roster is always visible (names, roles). Emails only for people the
  // caller can already see analytics for — or themselves.
  const canSeeEmail = (userId: string): boolean => {
    if (userId === principal.userId) return true;
    if (!can(ctx.role, "analytics.viewAll")) return false;
    if (scope.userIds === null) return true;
    return scope.userIds.includes(userId);
  };

  // Owner gets each manager's scope summary inline so settings can render
  // without N+1 round trips for the common case.
  const scopeByManager = new Map<
    string,
    { mode: "team" | "custom"; userIds: string[]; groupIds: string[] }
  >();
  if (ctx.role === "owner") {
    for (const m of rows) {
      if (m.role !== "manager") continue;
      scopeByManager.set(m.user_id, await loadManagerScopeConfig(env, ctx.team.id, m.user_id));
    }
  }

  return json({
    members: rows.map((m) => ({
      ...m,
      email: canSeeEmail(m.user_id) ? m.email : null,
      manageScope: scopeByManager.get(m.user_id) ?? null,
    })),
    role: ctx.role,
    myScope: {
      kind: scope.kind,
      label: scope.label,
      userIds: scope.userIds,
    },
  });
}

const ROLES: Role[] = ["owner", "manager", "employee"];

export async function setMemberRole(
  req: Request,
  env: Env,
  principal: Principal,
  key: string,
  targetUserId: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "member.setRole");
  await requireWritableBilling(env, ctx.team);

  const body = await readJson<{ role?: string }>(req);
  const role = body.role as Role | undefined;
  if (!role || !ROLES.includes(role)) throw badRequest("role must be owner, manager, or employee.");

  const target = await env.DB.prepare(
    "SELECT id, role FROM team_members WHERE team_id = ? AND user_id = ? AND left_at IS NULL",
  )
    .bind(ctx.team.id, targetUserId)
    .first<{ id: string; role: Role }>();
  if (!target) throw notFound("That person isn't on this team.");

  if (target.role === "owner" && role !== "owner") {
    const owners = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND role = 'owner' AND left_at IS NULL",
    )
      .bind(ctx.team.id)
      .first<{ n: number }>();
    if ((owners?.n ?? 0) <= 1) throw conflict("A team must always have an owner.");
  }

  await env.DB.prepare("UPDATE team_members SET role = ? WHERE id = ?").bind(role, target.id).run();

  // Leaving the manager role drops any custom scope so a re-promote starts clean
  // (entire team). Promoting to manager leaves zero rows = entire team default.
  if (target.role === "manager" && role !== "manager") {
    await clearManagerScope(env, ctx.team.id, targetUserId);
  }

  await writeAudit(
    env,
    ctx.team.id,
    principal.userId,
    "member.role_changed",
    targetUserId,
    `${target.role} → ${role}`,
  );
  return json({ userId: targetUserId, role });
}

export async function removeMember(
  env: Env,
  principal: Principal,
  key: string,
  targetUserId: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "member.remove");
  if (targetUserId === principal.userId) {
    throw conflict("Use 'leave team' to remove yourself.");
  }

  const target = await env.DB.prepare(
    "SELECT id, role FROM team_members WHERE team_id = ? AND user_id = ? AND left_at IS NULL",
  )
    .bind(ctx.team.id, targetUserId)
    .first<{ id: string; role: Role }>();
  if (!target) throw notFound("That person isn't on this team.");
  if (target.role === "owner") throw conflict("Transfer ownership before removing an owner.");

  // Removal stops upload acceptance immediately; historical aggregates stay
  // with the team, exactly as the disclosure states.
  await env.DB.prepare("UPDATE team_members SET left_at = ? WHERE id = ?")
    .bind(nowIso(), target.id)
    .run();
  await purgeUserFromScopes(env, ctx.team.id, targetUserId);
  await writeAudit(env, ctx.team.id, principal.userId, "member.removed", targetUserId, `was ${target.role}`);
  await syncSeatQuantity(env, ctx.team.id);
  return json({ removed: true, userId: targetUserId });
}
