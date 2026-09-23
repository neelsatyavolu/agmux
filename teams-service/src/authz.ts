/**
 * Role gating. The `can` table is pure so it can be tested exhaustively without
 * a database; the request-level guards below layer membership lookup on top.
 */
import type { Env } from "./env";
import type { MemberRow, Role, TeamRow } from "./db";
import { getActiveMembership, getTeamBySlugOrId } from "./db";
import { forbidden, notFound } from "./http";
import { isPlatformStaff } from "./staff";
import type { Principal } from "./session";

export type Capability =
  | "team.rename"
  | "team.delete"
  | "invite.manage"
  | "member.setRole"
  | "member.remove"
  | "analytics.viewAll"
  | "analytics.viewSelf"
  | "metrics.upload"
  | "team.leave"
  | "budget.view"
  | "budget.manage"
  | "audit.view"
  | "group.manage"
  | "scope.manage"
  | "leaderboard.view"
  | "leaderboard.manage";

const MATRIX: Record<Capability, ReadonlySet<Role>> = {
  "team.rename": new Set<Role>(["owner"]),
  "team.delete": new Set<Role>(["owner"]),
  // v1 decision: invites are owner-only. Managers are deliberately excluded.
  "invite.manage": new Set<Role>(["owner"]),
  "member.setRole": new Set<Role>(["owner"]),
  "member.remove": new Set<Role>(["owner"]),
  // Role-level: managers *can* view team analytics. Per-manager scope may
  // narrow that set further — see `scope.ts` / `canViewMember`.
  "analytics.viewAll": new Set<Role>(["owner", "manager"]),
  "analytics.viewSelf": new Set<Role>(["owner", "manager", "employee"]),
  "metrics.upload": new Set<Role>(["owner", "manager", "employee"]),
  // An owner must transfer ownership before leaving, so the team keeps an owner.
  "team.leave": new Set<Role>(["manager", "employee"]),
  // Spend is a manager's job, so managers read it; only owners set it, matching
  // the existing rule that owners hold the destructive/administrative levers.
  // Scoped managers are filtered out at the route layer (team-wide number only).
  "budget.view": new Set<Role>(["owner", "manager"]),
  "budget.manage": new Set<Role>(["owner"]),
  "audit.view": new Set<Role>(["owner", "manager"]),
  // Groups and manager scope are ownership levers — managers don't edit the
  // org chart for themselves.
  "group.manage": new Set<Role>(["owner"]),
  "scope.manage": new Set<Role>(["owner"]),
  // Full team always (no manager_scope filter at the route layer).
  "leaderboard.view": new Set<Role>(["owner", "manager"]),
  "leaderboard.manage": new Set<Role>(["owner"]),
};

export function can(role: Role, capability: Capability): boolean {
  return MATRIX[capability].has(role);
}

export interface TeamContext {
  team: TeamRow;
  membership: MemberRow;
  role: Role;
  /**
   * True when a platform staff GitHub login opened a team they do not belong
   * to. Read-only: view capabilities only. Never set for device-token calls.
   */
  staffPreview: boolean;
}

/** Caps staff preview is allowed to use. Everything else is a write. */
const STAFF_VIEW_CAPS: ReadonlySet<Capability> = new Set([
  "analytics.viewAll",
  "analytics.viewSelf",
  "budget.view",
  "audit.view",
  "leaderboard.view",
]);

/** Resolves the team and the caller's active membership, or throws. */
export async function requireTeam(
  env: Env,
  teamKey: string,
  userId: string,
  via: Principal["via"] | null = null,
): Promise<TeamContext> {
  const team = await getTeamBySlugOrId(env, teamKey);
  if (!team) throw notFound("That team doesn't exist.");
  const membership = await getActiveMembership(env, team.id, userId);
  if (membership) {
    return { team, membership, role: membership.role, staffPreview: false };
  }
  // Web cookie only — never widen desktop device tokens into other teams.
  if (via !== "device" && (await isPlatformStaff(env, userId))) {
    return {
      team,
      membership: {
        id: "staff",
        team_id: team.id,
        user_id: userId,
        role: "manager",
        joined_at: team.created_at,
        left_at: null,
      },
      role: "manager",
      staffPreview: true,
    };
  }
  throw notFound("That team doesn't exist.");
}

export function requireCapability(ctx: TeamContext, capability: Capability): void {
  if (ctx.staffPreview && !STAFF_VIEW_CAPS.has(capability)) {
    throw forbidden("Staff preview is read-only.");
  }
  if (!can(ctx.role, capability)) {
    throw forbidden(`Your role (${ctx.role}) can't do that.`);
  }
}

/**
 * Synchronous per-member gate for callers that already resolved scope.
 * Prefer `requireViewMemberAsync` on request paths so manager scope is honoured.
 */
export function canViewMember(
  ctx: TeamContext,
  targetUserId: string,
  /** When provided, overrides the legacy "managers see everyone" rule. */
  allowedUserIds?: string[] | null,
): boolean {
  if (targetUserId === ctx.membership.user_id) return can(ctx.role, "analytics.viewSelf");
  if (!can(ctx.role, "analytics.viewAll")) return false;
  // null = whole team; undefined = legacy (whole team for managers).
  if (allowedUserIds === undefined || allowedUserIds === null) return true;
  return allowedUserIds.includes(targetUserId);
}

export function requireViewMember(
  ctx: TeamContext,
  targetUserId: string,
  allowedUserIds?: string[] | null,
): void {
  if (!canViewMember(ctx, targetUserId, allowedUserIds)) {
    throw forbidden(
      ctx.role === "employee"
        ? "Employees can only see their own stats."
        : "You can only see stats for people in your management scope.",
    );
  }
}
