/**
 * Team groups — named collections of members used for manager scope and
 * organisation. Owners create/edit; every member can list (names only help
 * managers understand "I manage Platform").
 */
import type { Env } from "../env";
import { nowIso } from "../db";
import { newId } from "../crypto";
import { badRequest, conflict, json, notFound, readJson } from "../http";
import { requireCapability, requireTeam } from "../authz";
import type { Principal } from "../session";
import { writeAudit } from "./audit";

export interface GroupRow {
  id: string;
  name: string;
  created_at: string;
  member_count: number;
}

export interface GroupDetail extends GroupRow {
  memberIds: string[];
}

async function loadGroups(env: Env, teamId: string): Promise<GroupRow[]> {
  const r = await env.DB.prepare(
    `SELECT g.id, g.name, g.created_at,
            (SELECT COUNT(*) FROM team_group_members gm WHERE gm.group_id = g.id) AS member_count
     FROM team_groups g
     WHERE g.team_id = ?
     ORDER BY g.name COLLATE NOCASE`,
  )
    .bind(teamId)
    .all<GroupRow>();
  return r.results ?? [];
}

async function getGroup(
  env: Env,
  teamId: string,
  groupId: string,
): Promise<{ id: string; name: string; created_at: string } | null> {
  return env.DB.prepare(
    "SELECT id, name, created_at FROM team_groups WHERE id = ? AND team_id = ?",
  )
    .bind(groupId, teamId)
    .first();
}

export async function listGroups(
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  const groups = await loadGroups(env, ctx.team.id);
  return json({ groups, role: ctx.role, canManage: ctx.role === "owner" });
}

export async function createGroup(
  req: Request,
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "group.manage");

  const body = await readJson<{ name?: string; memberIds?: string[] }>(req);
  const name = (body.name ?? "").trim();
  if (!name || name.length > 64) throw badRequest("Group name must be 1–64 characters.");

  const id = newId("grp");
  const now = nowIso();
  try {
    await env.DB.prepare(
      "INSERT INTO team_groups (id, team_id, name, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(id, ctx.team.id, name, now)
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE/i.test(msg)) throw conflict("A group with that name already exists.");
    throw err;
  }

  const memberIds = Array.isArray(body.memberIds) ? body.memberIds : [];
  if (memberIds.length) {
    await setGroupMembersInternal(env, ctx.team.id, id, memberIds);
  }

  await writeAudit(env, ctx.team.id, principal.userId, "group.created", id, name);
  const groups = await loadGroups(env, ctx.team.id);
  return json({ group: groups.find((g) => g.id === id), groups }, { status: 201 });
}

export async function renameGroup(
  req: Request,
  env: Env,
  principal: Principal,
  key: string,
  groupId: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "group.manage");
  const group = await getGroup(env, ctx.team.id, groupId);
  if (!group) throw notFound("That group doesn't exist.");

  const body = await readJson<{ name?: string }>(req);
  const name = (body.name ?? "").trim();
  if (!name || name.length > 64) throw badRequest("Group name must be 1–64 characters.");

  try {
    await env.DB.prepare("UPDATE team_groups SET name = ? WHERE id = ?")
      .bind(name, groupId)
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE/i.test(msg)) throw conflict("A group with that name already exists.");
    throw err;
  }

  await writeAudit(
    env,
    ctx.team.id,
    principal.userId,
    "group.renamed",
    groupId,
    `${group.name} → ${name}`,
  );
  return json({ group: { ...group, name } });
}

export async function deleteGroup(
  env: Env,
  principal: Principal,
  key: string,
  groupId: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "group.manage");
  const group = await getGroup(env, ctx.team.id, groupId);
  if (!group) throw notFound("That group doesn't exist.");

  // manager_scope rows for this group cascade via FK.
  await env.DB.prepare("DELETE FROM team_groups WHERE id = ?").bind(groupId).run();
  await writeAudit(env, ctx.team.id, principal.userId, "group.deleted", groupId, group.name);
  return json({ deleted: true, groupId });
}

export async function getGroupDetail(
  env: Env,
  principal: Principal,
  key: string,
  groupId: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  const group = await getGroup(env, ctx.team.id, groupId);
  if (!group) throw notFound("That group doesn't exist.");

  const members = await env.DB.prepare(
    `SELECT gm.user_id
     FROM team_group_members gm
     JOIN team_members m ON m.user_id = gm.user_id AND m.team_id = ? AND m.left_at IS NULL
     WHERE gm.group_id = ?
     ORDER BY gm.added_at`,
  )
    .bind(ctx.team.id, groupId)
    .all<{ user_id: string }>();

  const memberIds = (members.results ?? []).map((r) => r.user_id);
  return json({
    group: {
      id: group.id,
      name: group.name,
      created_at: group.created_at,
      member_count: memberIds.length,
      memberIds,
    } satisfies GroupDetail,
    canManage: ctx.role === "owner",
  });
}

export async function setGroupMembers(
  req: Request,
  env: Env,
  principal: Principal,
  key: string,
  groupId: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "group.manage");
  const group = await getGroup(env, ctx.team.id, groupId);
  if (!group) throw notFound("That group doesn't exist.");

  const body = await readJson<{ memberIds?: string[] }>(req);
  if (!Array.isArray(body.memberIds)) throw badRequest("memberIds must be an array of user ids.");

  const memberIds = [...new Set(body.memberIds.map(String))];
  await setGroupMembersInternal(env, ctx.team.id, groupId, memberIds);

  await writeAudit(
    env,
    ctx.team.id,
    principal.userId,
    "group.members_set",
    groupId,
    `${group.name}: ${memberIds.length} members`,
  );

  return json({ groupId, memberIds, memberCount: memberIds.length });
}

async function setGroupMembersInternal(
  env: Env,
  teamId: string,
  groupId: string,
  memberIds: string[],
): Promise<void> {
  // Validate every id is an active team member.
  if (memberIds.length) {
    const placeholders = memberIds.map(() => "?").join(",");
    const r = await env.DB.prepare(
      `SELECT user_id FROM team_members
       WHERE team_id = ? AND left_at IS NULL AND user_id IN (${placeholders})`,
    )
      .bind(teamId, ...memberIds)
      .all<{ user_id: string }>();
    const ok = new Set((r.results ?? []).map((x) => x.user_id));
    const missing = memberIds.filter((id) => !ok.has(id));
    if (missing.length) {
      throw badRequest("Every group member must be an active member of this team.");
    }
  }

  await env.DB.prepare("DELETE FROM team_group_members WHERE group_id = ?")
    .bind(groupId)
    .run();

  if (!memberIds.length) return;

  const now = nowIso();
  const statements = memberIds.map((userId) =>
    env.DB.prepare(
      "INSERT INTO team_group_members (group_id, user_id, added_at) VALUES (?, ?, ?)",
    ).bind(groupId, userId, now),
  );
  await env.DB.batch(statements);
}
