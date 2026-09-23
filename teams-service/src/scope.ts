/**
 * Analytics visibility for a team member.
 *
 *   owner                          → entire team
 *   manager, no manager_scope rows → entire team (default, seamless upgrade)
 *   manager, with scope rows       → union of direct people + group members + self
 *   employee                       → self only
 *
 * Budget and the team audit log only make sense for whole-team viewers.
 */
import type { Env } from "./env";
import type { Role } from "./db";
import type { TeamContext } from "./authz";
import { can } from "./authz";

export type ScopeKind = "team" | "partial" | "self";

export interface AnalyticsScope {
  kind: ScopeKind;
  /** null = no SQL user filter (whole team). Otherwise the allowed user ids. */
  userIds: string[] | null;
  /** Direct person ids assigned to this manager (not expanded from groups). */
  directUserIds: string[];
  /** Group ids assigned to this manager. */
  groupIds: string[];
  /** Short label for the UI ("Entire team", "Platform · 4 people", …). */
  label: string;
}

interface ScopeRow {
  target_user_id: string | null;
  target_group_id: string | null;
  group_name: string | null;
}

/** Load and resolve the caller's analytics scope for this team. */
export async function resolveAnalyticsScope(
  env: Env,
  ctx: TeamContext,
): Promise<AnalyticsScope> {
  const selfId = ctx.membership.user_id;

  if (ctx.role === "owner") {
    return {
      kind: "team",
      userIds: null,
      directUserIds: [],
      groupIds: [],
      label: "Entire team",
    };
  }

  if (ctx.role === "employee") {
    return {
      kind: "self",
      userIds: [selfId],
      directUserIds: [],
      groupIds: [],
      label: "Just you",
    };
  }

  // manager
  const rows = await env.DB.prepare(
    `SELECT s.target_user_id, s.target_group_id, g.name AS group_name
     FROM manager_scope s
     LEFT JOIN team_groups g ON g.id = s.target_group_id
     WHERE s.team_id = ? AND s.manager_user_id = ?`,
  )
    .bind(ctx.team.id, selfId)
    .all<ScopeRow>();

  const scopeRows = rows.results ?? [];
  if (scopeRows.length === 0) {
    return {
      kind: "team",
      userIds: null,
      directUserIds: [],
      groupIds: [],
      label: "Entire team",
    };
  }

  const directUserIds = [
    ...new Set(
      scopeRows.map((r) => r.target_user_id).filter((id): id is string => !!id),
    ),
  ];
  const groupIds = [
    ...new Set(
      scopeRows.map((r) => r.target_group_id).filter((id): id is string => !!id),
    ),
  ];
  const groupNames = scopeRows
    .map((r) => r.group_name)
    .filter((n): n is string => !!n);

  const userIds = await expandScopeUserIds(env, ctx.team.id, selfId, directUserIds, groupIds);
  const label = buildScopeLabel(groupNames, directUserIds.length, userIds.length);

  return {
    kind: "partial",
    userIds,
    directUserIds,
    groupIds,
    label,
  };
}

/** Expand group membership + direct people + self into a stable sorted list. */
export async function expandScopeUserIds(
  env: Env,
  teamId: string,
  managerUserId: string,
  directUserIds: string[],
  groupIds: string[],
): Promise<string[]> {
  const set = new Set<string>([managerUserId, ...directUserIds]);

  if (groupIds.length > 0) {
    // Only count people who are still active members of the team.
    const placeholders = groupIds.map(() => "?").join(",");
    const r = await env.DB.prepare(
      `SELECT DISTINCT gm.user_id
       FROM team_group_members gm
       JOIN team_groups g ON g.id = gm.group_id
       JOIN team_members m ON m.team_id = g.team_id AND m.user_id = gm.user_id AND m.left_at IS NULL
       WHERE g.team_id = ? AND gm.group_id IN (${placeholders})`,
    )
      .bind(teamId, ...groupIds)
      .all<{ user_id: string }>();
    for (const row of r.results ?? []) set.add(row.user_id);
  }

  return [...set].sort();
}

function buildScopeLabel(
  groupNames: string[],
  directCount: number,
  totalPeople: number,
): string {
  const uniqueGroups = [...new Set(groupNames)];
  const bits: string[] = [];
  if (uniqueGroups.length === 1) bits.push(uniqueGroups[0]!);
  else if (uniqueGroups.length > 1) bits.push(`${uniqueGroups.length} groups`);
  if (directCount > 0) {
    bits.push(directCount === 1 ? "1 person" : `${directCount} people`);
  }
  if (bits.length === 0) return `${totalPeople} people`;
  // Prefer human group names; append total when mixed.
  if (uniqueGroups.length > 0 && directCount > 0) {
    return `${bits.join(" · ")} · ${totalPeople} total`;
  }
  if (uniqueGroups.length === 1 && directCount === 0) {
    return `${uniqueGroups[0]} · ${totalPeople} ${totalPeople === 1 ? "person" : "people"}`;
  }
  return `${bits.join(" · ")} · ${totalPeople} total`;
}

/** Per-member analytics gate — uses resolved scope when provided. */
export function canViewMemberInScope(
  scope: AnalyticsScope,
  targetUserId: string,
): boolean {
  if (scope.userIds === null) return true;
  return scope.userIds.includes(targetUserId);
}

/**
 * Whether the caller sees whole-team admin surfaces (budget, full audit).
 * Scoped managers get analytics for their people only — not team-wide spend.
 */
export function seesTeamWideAdmin(scope: AnalyticsScope, role: Role): boolean {
  if (role === "owner") return true;
  return scope.kind === "team" && can(role, "budget.view");
}

/** Clear every scope row for a manager (role demotion or "entire team"). */
export async function clearManagerScope(
  env: Env,
  teamId: string,
  managerUserId: string,
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM manager_scope WHERE team_id = ? AND manager_user_id = ?",
  )
    .bind(teamId, managerUserId)
    .run();
}

/** Drop a user from every group on the team and from every manager's scope. */
export async function purgeUserFromScopes(
  env: Env,
  teamId: string,
  userId: string,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM team_group_members
       WHERE user_id = ? AND group_id IN (
         SELECT id FROM team_groups WHERE team_id = ?
       )`,
    ).bind(userId, teamId),
    env.DB.prepare(
      "DELETE FROM manager_scope WHERE team_id = ? AND target_user_id = ?",
    ).bind(teamId, userId),
    env.DB.prepare(
      "DELETE FROM manager_scope WHERE team_id = ? AND manager_user_id = ?",
    ).bind(teamId, userId),
  ]);
}

/** Owner-facing snapshot of one manager's configured scope (not expanded). */
export async function loadManagerScopeConfig(
  env: Env,
  teamId: string,
  managerUserId: string,
): Promise<{ mode: "team" | "custom"; userIds: string[]; groupIds: string[] }> {
  const r = await env.DB.prepare(
    `SELECT target_user_id, target_group_id FROM manager_scope
     WHERE team_id = ? AND manager_user_id = ?`,
  )
    .bind(teamId, managerUserId)
    .all<{ target_user_id: string | null; target_group_id: string | null }>();
  const rows = r.results ?? [];
  if (rows.length === 0) {
    return { mode: "team", userIds: [], groupIds: [] };
  }
  return {
    mode: "custom",
    userIds: rows.map((x) => x.target_user_id).filter((id): id is string => !!id),
    groupIds: rows.map((x) => x.target_group_id).filter((id): id is string => !!id),
  };
}
