import { resolveAvatarUrl } from "../avatar";
import type { Env } from "../env";
import { json, notFound } from "../http";
import { can, requireTeam, requireViewMember, type TeamContext } from "../authz";
import type { Principal } from "../session";
import { roster } from "./members";
import {
  dailySeries,
  delta,
  heatmap,
  idleDays,
  isRangeKey,
  mix,
  perMember,
  previousWindow,
  projects,
  totals,
  windowFromDates,
  windowFromRange,
  type Bucket,
  type RangeKey,
  type TimeWindow,
} from "../aggregate";
import { budgetFor } from "./budget";
import { resolveAnalyticsScope, type AnalyticsScope } from "../scope";

/** Resolve the request's time window from `range=` or `from=`+`to=`. */
function windowOf(url: URL): TimeWindow {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (from && to) {
    const custom = windowFromDates(from, to);
    if (custom) return custom;
  }
  const raw = url.searchParams.get("range") ?? "30d";
  const range: RangeKey = isRangeKey(raw) ? raw : "30d";
  return windowFromRange(range);
}

/**
 * Optional filter: a single user id, a list of user ids, or nothing (team).
 * Empty list returns no rows (shouldn't happen — scope always includes self).
 */
type UserFilter = string | string[] | undefined;

async function fetchBuckets(
  env: Env,
  teamId: string,
  sinceHour: string,
  untilHour: string | null,
  userFilter?: UserFilter,
): Promise<Bucket[]> {
  const clauses = ["team_id = ?", "hour_utc >= ?"];
  const binds: unknown[] = [teamId, sinceHour];
  if (untilHour) {
    clauses.push("hour_utc < ?");
    binds.push(untilHour);
  }
  if (typeof userFilter === "string") {
    clauses.push("user_id = ?");
    binds.push(userFilter);
  } else if (Array.isArray(userFilter)) {
    if (userFilter.length === 0) return [];
    clauses.push(`user_id IN (${userFilter.map(() => "?").join(",")})`);
    binds.push(...userFilter);
  }
  const r = await env.DB.prepare(
    `SELECT user_id, hour_utc, provider, model, project_key,
            tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, tokens_reasoning, cost_usd, cost_incomplete,
            active_ms, after_hours_ms, weekend_ms, sessions, turns, tool_calls,
            peak_concurrent,
            tool_bash, tool_edit, tool_read, tool_search, tool_web, tool_agent,
            tool_mcp, tool_other, tool_errors, tools_measured,
            files_changed, lines_added, lines_removed,
            COALESCE(approval_requests, 0) AS approval_requests,
            COALESCE(approval_wait_ms, 0) AS approval_wait_ms,
            local_hour, local_dow
     FROM metric_hourly WHERE ${clauses.join(" AND ")}`,
  )
    .bind(...binds)
    .all<Bucket>();
  return r.results ?? [];
}

async function fetchForWindow(
  env: Env,
  teamId: string,
  win: TimeWindow,
  userFilter?: UserFilter,
): Promise<{ current: Bucket[]; previous: Bucket[] }> {
  const prev = previousWindow(win);
  const [current, previous] = await Promise.all([
    fetchBuckets(env, teamId, win.sinceHour, win.untilHour, userFilter),
    fetchBuckets(env, teamId, prev.sinceHour, prev.untilHour, userFilter),
  ]);
  return { current, previous };
}

/** Map resolved scope → the filter fetchBuckets understands. */
function filterFromScope(scope: AnalyticsScope): UserFilter {
  if (scope.userIds === null) return undefined;
  if (scope.kind === "self" && scope.userIds.length === 1) return scope.userIds[0];
  return scope.userIds;
}

export async function teamOverview(
  req: Request,
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  const url = new URL(req.url);
  const win = windowOf(url);

  // Owner → team; unscoped manager → team; scoped manager → partial;
  // employee → self. Same route, different filter.
  const scope = await resolveAnalyticsScope(env, ctx);
  const userFilter = filterFromScope(scope);
  const wholeTeam = scope.kind === "team";

  const [{ current, previous }, members, budget] = await Promise.all([
    fetchForWindow(env, ctx.team.id, win, userFilter),
    roster(env, ctx.team.id),
    // Team budget is a whole-team number — only for whole-team viewers.
    wholeTeam && can(ctx.role, "budget.view")
      ? budgetFor(env, ctx.team.id)
      : Promise.resolve(null),
  ]);

  const t = totals(current);
  const p = totals(previous);

  const visibleMembers =
    scope.userIds === null
      ? members
      : members.filter((m) => scope.userIds!.includes(m.user_id));

  return json({
    range: win.range,
    from: win.sinceHour.slice(0, 10),
    to: win.endDate.toISOString().slice(0, 10),
    scope: scope.kind,
    scopeLabel: scope.label,
    role: ctx.role,
    totals: t,
    deltas: {
      tokens: delta(t.tokens, p.tokens),
      costUsd: delta(t.costUsd, p.costUsd),
      activeHours: delta(t.activeHours, p.activeHours),
      sessions: delta(t.sessions, p.sessions),
    },
    daily: dailySeries(current, win.days, win.endDate),
    heatmap: heatmap(current),
    providerMix: mix(current, "provider"),
    modelMix: mix(current, "model"),
    projects: projects(current).slice(0, 20),
    flags: buildFlags(current, p, win),
    // Null when no budget is set, or when the caller can't see spend. The UI
    // shows nothing rather than a $0 budget every team is instantly over.
    budget,
    canManageBudget: can(ctx.role, "budget.manage"),
    // Audit is team-wide admin history — whole-team managers + owners only.
    canViewAudit: wholeTeam && can(ctx.role, "audit.view"),
    members: scope.kind === "self" ? [] : memberRows(visibleMembers, current),
    memberCount: visibleMembers.length,
    teamMemberCount: members.length,
    lastUploadAt: visibleMembers.reduce<string | null>(
      (acc, m) => (m.last_upload_at && (!acc || m.last_upload_at > acc) ? m.last_upload_at : acc),
      null,
    ),
  });
}

function memberRows(
  members: Awaited<ReturnType<typeof roster>>,
  buckets: Bucket[],
): unknown[] {
  const summaries = perMember(
    buckets,
    members.map((m) => m.user_id),
  );
  const byId = new Map(summaries.map((s) => [s.userId, s]));
  return members
    .map((m) => {
      const s = byId.get(m.user_id)!;
      return {
        userId: m.user_id,
        displayName: m.display_name,
        handle: m.handle,
        avatarColor: m.avatar_color,
        avatarUrl: m.avatar_url,
        role: m.role,
        lastUploadAt: m.last_upload_at,
        // IANA zone used for after-hours / weekend classification on their machine.
        timezone: m.timezone,
        // The design's honest-state rule: never-synced members must not be
        // rendered as a row of zeros.
        neverSynced: s.neverSynced && !m.last_upload_at,
        joinedAt: m.joined_at,
        totals: s.totals,
      };
    })
    .sort((a, b) => b.totals.activeHours - a.totals.activeHours);
}

function buildFlags(current: Bucket[], previous: ReturnType<typeof totals>, win: TimeWindow) {
  const t = totals(current);
  return {
    afterHoursShare: t.afterHoursShare,
    afterHoursSharePrev: previous.afterHoursShare,
    weekendShare: t.weekendShare,
    idleDays: idleDays(current, win.days, win.endDate),
  };
}

export async function memberDetail(
  req: Request,
  env: Env,
  principal: Principal,
  key: string,
  targetUserId: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  const scope = await resolveAnalyticsScope(env, ctx);
  requireViewMember(ctx, targetUserId, scope.userIds);

  const rawMember = await env.DB.prepare(
    `SELECT m.user_id, u.display_name, u.handle, u.avatar_color, u.avatar_url AS stored_avatar_url,
            (SELECT i.provider_user_id FROM identities i
             WHERE i.user_id = u.id AND i.provider = 'github' LIMIT 1) AS github_id,
            u.timezone, m.role, m.joined_at,
            (SELECT MAX(s.last_upload_at) FROM sync_state s WHERE s.user_id = m.user_id) AS last_upload_at
     FROM team_members m JOIN users u ON u.id = m.user_id
     WHERE m.team_id = ? AND m.user_id = ? AND m.left_at IS NULL`,
  )
    .bind(ctx.team.id, targetUserId)
    .first<{
      user_id: string;
      display_name: string;
      handle: string | null;
      avatar_color: string;
      stored_avatar_url: string | null;
      github_id: string | null;
      timezone: string | null;
      role: string;
      joined_at: string;
      last_upload_at: string | null;
    }>();
  if (!rawMember) throw notFound("That person isn't on this team.");
  const { stored_avatar_url, github_id, ...memberRest } = rawMember;
  const member = {
    ...memberRest,
    avatar_url: resolveAvatarUrl(stored_avatar_url, github_id),
  };

  const url = new URL(req.url);
  const win = windowOf(url);

  const { current, previous } = await fetchForWindow(env, ctx.team.id, win, targetUserId);

  const t = totals(current);
  const p = totals(previous);

  return json({
    range: win.range,
    from: win.sinceHour.slice(0, 10),
    to: win.endDate.toISOString().slice(0, 10),
    role: ctx.role,
    isSelf: targetUserId === principal.userId,
    member,
    totals: t,
    deltas: {
      tokens: delta(t.tokens, p.tokens),
      activeHours: delta(t.activeHours, p.activeHours),
      sessions: delta(t.sessions, p.sessions),
      costUsd: delta(t.costUsd, p.costUsd),
    },
    daily: dailySeries(current, win.days, win.endDate),
    heatmap: heatmap(current),
    providerMix: mix(current, "provider"),
    modelMix: mix(current, "model"),
    projects: projects(current),
    flags: buildFlags(current, p, win),
    neverSynced: current.length === 0 && !(member as { last_upload_at: string | null }).last_upload_at,
  });
}

/** Employee self-view — same shape as member detail, always scoped to caller. */
export async function selfDetail(
  req: Request,
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  return memberDetail(req, env, principal, key, principal.userId);
}

export type { TeamContext };
