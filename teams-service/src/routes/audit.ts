/**
 * Audit log — who changed the team, and when.
 *
 * Membership, roles, invites, budgets and exports. This is the record a
 * security review asks for, and the one a manager needs when someone asks "who
 * removed them?" a month later.
 *
 * It deliberately holds **no telemetry**: `detail` is a short server-authored
 * summary, never client-supplied text and never anything derived from a
 * session. The disclosure promise is unaffected by this table's existence.
 */
import type { Env } from "../env";
import { nowIso } from "../db";
import { json } from "../http";
import { requireCapability, requireTeam } from "../authz";
import type { Principal } from "../session";
import { resolveAnalyticsScope } from "../scope";

export type AuditAction =
  | "team.created"
  | "team.renamed"
  | "team.deleted"
  | "member.joined"
  | "member.role_changed"
  | "member.removed"
  | "member.left"
  | "invite.created"
  | "invite.revoked"
  | "budget.updated"
  | "budget.cleared"
  | "policy.updated"
  | "data.exported"
  | "group.created"
  | "group.renamed"
  | "group.deleted"
  | "group.members_set"
  | "scope.updated"
  | "leaderboard.enabled"
  | "leaderboard.disabled"
  | "leaderboard.settings_updated"
  | "leaderboard.installed"
  | "leaderboard.unlinked"
  | "leaderboard.repos_set"
  | "billing.checkout_started"
  | "billing.quantity_sync"
  | "billing.seats_increased"
  | "billing.seats_decrease_scheduled"
  | "knowledge.settings"
  | "knowledge.record_create"
  | "knowledge.record_purge"
  | "knowledge.share"
  | "knowledge.promote"
  | "knowledge.verify"
  | "knowledge.export"
  | "knowledge.disclosure"
  | "knowledge.mcp_quota";

export interface AuditRow {
  id: string;
  actor_user_id: string | null;
  actor_name: string | null;
  action: string;
  target: string | null;
  target_name: string | null;
  detail: string | null;
  created_at: string;
}

const MAX_DETAIL = 200;

/**
 * Appends one entry. Never throws into the caller's path — an audit write that
 * fails must not roll back the action the user actually asked for, and a lost
 * line is better than a 500 on a successful role change.
 */
export async function writeAudit(
  env: Env,
  teamId: string,
  actorUserId: string | null,
  action: AuditAction,
  target: string | null,
  detail?: string | null,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (id, team_id, actor_user_id, action, target, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        teamId,
        actorUserId,
        action,
        target,
        detail ? detail.slice(0, MAX_DETAIL) : null,
        nowIso(),
      )
      .run();
  } catch {
    // Intentionally swallowed — see the note above.
  }
}

const MAX_LIMIT = 200;

export async function listAudit(
  req: Request,
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "audit.view");
  // Scoped managers don't get the team-wide activity log (membership changes
  // outside their slice). Owners always do.
  if (ctx.role !== "owner") {
    const scope = await resolveAnalyticsScope(env, ctx);
    if (scope.kind !== "team") {
      return json({ entries: [], role: ctx.role, scopeLimited: true });
    }
  }

  const url = new URL(req.url);
  const raw = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(raw) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(raw))) : 50;

  const r = await env.DB.prepare(
    `SELECT a.id, a.actor_user_id, actor.display_name AS actor_name,
            a.action, a.target, target_user.display_name AS target_name,
            a.detail, a.created_at
     FROM audit_log a
     LEFT JOIN users actor ON actor.id = a.actor_user_id
     LEFT JOIN users target_user ON target_user.id = a.target
     WHERE a.team_id = ?
     ORDER BY a.created_at DESC
     LIMIT ?`,
  )
    .bind(ctx.team.id, limit)
    .all<AuditRow>();

  return json({ entries: r.results ?? [], role: ctx.role });
}
