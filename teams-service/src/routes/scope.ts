/**
 * Manager scope API — owners configure who each manager can see.
 *
 * PUT body:
 *   { mode: "team" }                          → entire team (clears rows)
 *   { mode: "custom", userIds?, groupIds? }   → at least one target required
 */
import type { Env } from "../env";
import { nowIso, type Role } from "../db";
import { newId } from "../crypto";
import { badRequest, json, notFound, readJson } from "../http";
import { requireCapability, requireTeam } from "../authz";
import type { Principal } from "../session";
import {
  clearManagerScope,
  expandScopeUserIds,
  loadManagerScopeConfig,
} from "../scope";
import { writeAudit } from "./audit";

export async function getMemberScope(
  env: Env,
  principal: Principal,
  key: string,
  managerUserId: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  // Owners configure any manager; a manager may read their own scope.
  if (ctx.role !== "owner" && principal.userId !== managerUserId) {
    requireCapability(ctx, "scope.manage");
  }

  const target = await env.DB.prepare(
    "SELECT role FROM team_members WHERE team_id = ? AND user_id = ? AND left_at IS NULL",
  )
    .bind(ctx.team.id, managerUserId)
    .first<{ role: Role }>();
  if (!target) throw notFound("That person isn't on this team.");

  const config = await loadManagerScopeConfig(env, ctx.team.id, managerUserId);
  let resolvedUserIds: string[] | null = null;
  if (config.mode === "custom") {
    resolvedUserIds = await expandScopeUserIds(
      env,
      ctx.team.id,
      managerUserId,
      config.userIds,
      config.groupIds,
    );
  }

  return json({
    managerUserId,
    role: target.role,
    mode: target.role === "manager" ? config.mode : "team",
    userIds: config.userIds,
    groupIds: config.groupIds,
    resolvedUserIds,
    // Scope only applies to managers; other roles ignore it.
    applies: target.role === "manager",
  });
}

export async function setMemberScope(
  req: Request,
  env: Env,
  principal: Principal,
  key: string,
  managerUserId: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "scope.manage");

  const target = await env.DB.prepare(
    "SELECT role FROM team_members WHERE team_id = ? AND user_id = ? AND left_at IS NULL",
  )
    .bind(ctx.team.id, managerUserId)
    .first<{ role: Role }>();
  if (!target) throw notFound("That person isn't on this team.");
  if (target.role !== "manager") {
    throw badRequest("Scope only applies to managers. Promote them first.");
  }

  const body = await readJson<{
    mode?: string;
    userIds?: string[];
    groupIds?: string[];
  }>(req);

  const mode = body.mode === "custom" ? "custom" : body.mode === "team" ? "team" : null;
  if (!mode) throw badRequest("mode must be 'team' or 'custom'.");

  if (mode === "team") {
    await clearManagerScope(env, ctx.team.id, managerUserId);
    await writeAudit(
      env,
      ctx.team.id,
      principal.userId,
      "scope.updated",
      managerUserId,
      "entire team",
    );
    return json({
      managerUserId,
      mode: "team",
      userIds: [],
      groupIds: [],
      resolvedUserIds: null,
    });
  }

  const userIds = [...new Set((body.userIds ?? []).map(String).filter(Boolean))];
  const groupIds = [...new Set((body.groupIds ?? []).map(String).filter(Boolean))];
  if (userIds.length === 0 && groupIds.length === 0) {
    throw badRequest("Pick at least one person or group, or choose Entire team.");
  }

  // Validate people are active members.
  if (userIds.length) {
    const placeholders = userIds.map(() => "?").join(",");
    const r = await env.DB.prepare(
      `SELECT user_id FROM team_members
       WHERE team_id = ? AND left_at IS NULL AND user_id IN (${placeholders})`,
    )
      .bind(ctx.team.id, ...userIds)
      .all<{ user_id: string }>();
    if ((r.results ?? []).length !== userIds.length) {
      throw badRequest("Every scoped person must be an active member of this team.");
    }
  }

  // Validate groups belong to this team.
  if (groupIds.length) {
    const placeholders = groupIds.map(() => "?").join(",");
    const r = await env.DB.prepare(
      `SELECT id FROM team_groups WHERE team_id = ? AND id IN (${placeholders})`,
    )
      .bind(ctx.team.id, ...groupIds)
      .all<{ id: string }>();
    if ((r.results ?? []).length !== groupIds.length) {
      throw badRequest("Every group must belong to this team.");
    }
  }

  await clearManagerScope(env, ctx.team.id, managerUserId);
  const now = nowIso();
  const statements = [
    ...userIds.map((uid) =>
      env.DB.prepare(
        `INSERT INTO manager_scope
           (id, team_id, manager_user_id, target_user_id, target_group_id, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      ).bind(newId("scp"), ctx.team.id, managerUserId, uid, now),
    ),
    ...groupIds.map((gid) =>
      env.DB.prepare(
        `INSERT INTO manager_scope
           (id, team_id, manager_user_id, target_user_id, target_group_id, created_at)
         VALUES (?, ?, ?, NULL, ?, ?)`,
      ).bind(newId("scp"), ctx.team.id, managerUserId, gid, now),
    ),
  ];
  if (statements.length) await env.DB.batch(statements);

  const resolvedUserIds = await expandScopeUserIds(
    env,
    ctx.team.id,
    managerUserId,
    userIds,
    groupIds,
  );

  await writeAudit(
    env,
    ctx.team.id,
    principal.userId,
    "scope.updated",
    managerUserId,
    `${groupIds.length} groups, ${userIds.length} people → ${resolvedUserIds.length} total`,
  );

  return json({
    managerUserId,
    mode: "custom",
    userIds,
    groupIds,
    resolvedUserIds,
  });
}

/** Summaries for every manager on the roster (settings UI). */
export async function listManagerScopes(
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  // Owners always; managers see their own row only (handy on Members page).
  const managers = await env.DB.prepare(
    `SELECT m.user_id, u.display_name, u.avatar_color
     FROM team_members m JOIN users u ON u.id = m.user_id
     WHERE m.team_id = ? AND m.left_at IS NULL AND m.role = 'manager'
     ORDER BY u.display_name COLLATE NOCASE`,
  )
    .bind(ctx.team.id)
    .all<{ user_id: string; display_name: string; avatar_color: string }>();

  const rows = managers.results ?? [];
  const filtered =
    ctx.role === "owner" ? rows : rows.filter((m) => m.user_id === principal.userId);

  const scopes = [];
  for (const m of filtered) {
    const config = await loadManagerScopeConfig(env, ctx.team.id, m.user_id);
    let resolvedCount: number | null = null;
    let label = "Entire team";
    if (config.mode === "custom") {
      const resolved = await expandScopeUserIds(
        env,
        ctx.team.id,
        m.user_id,
        config.userIds,
        config.groupIds,
      );
      resolvedCount = resolved.length;
      label =
        config.groupIds.length || config.userIds.length
          ? `${config.groupIds.length ? `${config.groupIds.length} group${config.groupIds.length === 1 ? "" : "s"}` : ""}${
              config.groupIds.length && config.userIds.length ? " · " : ""
            }${config.userIds.length ? `${config.userIds.length} person${config.userIds.length === 1 ? "" : "s"}` : ""} · ${resolvedCount} total`.replace(
              /^ · /,
              "",
            )
          : `${resolvedCount} people`;
    }
    scopes.push({
      userId: m.user_id,
      displayName: m.display_name,
      avatarColor: m.avatar_color,
      mode: config.mode,
      userIds: config.userIds,
      groupIds: config.groupIds,
      resolvedCount,
      label,
    });
  }

  return json({ scopes, canManage: ctx.role === "owner" });
}
