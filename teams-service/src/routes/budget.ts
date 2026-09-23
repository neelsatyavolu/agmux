/**
 * Monthly spend budget, forecast, and threshold alerts.
 *
 * The dashboard already answered "what did we spend"; this answers "are we
 * going to blow the month", which is the question a manager actually gets
 * asked. The forecast is a straight-line run rate (see `budgetStatus`) — simple
 * enough that a manager can sanity-check it themselves.
 *
 * Alerts fire at most **once per threshold per month** via the `budget_alerts`
 * ledger, so a cron that runs hourly does not page anyone hourly.
 */
import type { Env } from "../env";
import { nowIso } from "../db";
import { badRequest, json } from "../http";
import { can, requireCapability, requireTeam } from "../authz";
import type { Principal } from "../session";
import { budgetStatus, type BudgetStatus } from "../aggregate";
import { writeAudit } from "./audit";
import { resolveAnalyticsScope } from "../scope";

export interface BudgetRow {
  team_id: string;
  monthly_usd: number;
  thresholds: string;
  webhook_url: string | null;
  updated_by: string;
  updated_at: string;
}

const MAX_BUDGET_USD = 10_000_000;

export async function getBudgetRow(env: Env, teamId: string): Promise<BudgetRow | null> {
  return env.DB.prepare("SELECT * FROM team_budgets WHERE team_id = ?")
    .bind(teamId)
    .first<BudgetRow>();
}

/** Spend for the calendar month containing `now`, across the whole team. */
export async function monthSpend(env: Env, teamId: string, now = new Date()): Promise<number> {
  const prefix = now.toISOString().slice(0, 7); // YYYY-MM
  const r = await env.DB.prepare(
    "SELECT COALESCE(SUM(cost_usd), 0) AS spend FROM metric_hourly WHERE team_id = ? AND hour_utc LIKE ?",
  )
    .bind(teamId, `${prefix}%`)
    .first<{ spend: number }>();
  return Number(r?.spend ?? 0);
}

export function parseThresholds(raw: string): number[] {
  return [
    ...new Set(
      raw
        .split(",")
        .map((s) => Math.trunc(Number(s.trim())))
        .filter((n) => Number.isFinite(n) && n > 0 && n <= 1000),
    ),
  ].sort((a, b) => a - b);
}

/**
 * The status a dashboard renders, or null when no budget is set.
 *
 * Null is the honest answer for "no budget configured" — rendering a $0 budget
 * would show every team as 100% over on their first dollar.
 */
export async function budgetFor(
  env: Env,
  teamId: string,
  now = new Date(),
): Promise<(BudgetStatus & { thresholds: number[]; hasWebhook: boolean }) | null> {
  const row = await getBudgetRow(env, teamId);
  if (!row || !(row.monthly_usd > 0)) return null;
  const costs = await env.DB.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS spend,
            COALESCE(MAX(cost_incomplete), 1) AS cost_incomplete
     FROM metric_hourly WHERE team_id = ? AND hour_utc LIKE ?`,
  ).bind(teamId, `${now.toISOString().slice(0, 7)}%`)
    .first<{ spend: number; cost_incomplete: number }>();
  const spend = Number(costs?.spend ?? 0);
  return {
    ...budgetStatus(row.monthly_usd, spend, now),
    costIncomplete: costs?.cost_incomplete !== 0,
    thresholds: parseThresholds(row.thresholds),
    // The URL itself is never returned: it can embed a secret token.
    hasWebhook: Boolean(row.webhook_url),
  };
}

export async function getBudget(
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "budget.view");
  // Team budget is a whole-team number — hide it from managers who only see a
  // slice, so we never imply their people are the full spend.
  const scope = await resolveAnalyticsScope(env, ctx);
  if (scope.kind !== "team" && ctx.role !== "owner") {
    return json({ budget: null, canManage: false, scopeLimited: true });
  }
  return json({
    budget: await budgetFor(env, ctx.team.id),
    canManage: can(ctx.role, "budget.manage"),
  });
}

export async function setBudget(
  req: Request,
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "budget.manage");

  const body = (await req.json().catch(() => ({}))) as {
    monthlyUsd?: unknown;
    thresholds?: unknown;
    webhookUrl?: unknown;
  };

  const monthly = Number(body.monthlyUsd ?? 0);
  if (!Number.isFinite(monthly) || monthly < 0 || monthly > MAX_BUDGET_USD) {
    throw badRequest(`monthlyUsd must be between 0 and ${MAX_BUDGET_USD}.`);
  }

  // Zero clears the budget rather than storing a target nobody can meet.
  if (monthly === 0) {
    await env.DB.prepare("DELETE FROM team_budgets WHERE team_id = ?").bind(ctx.team.id).run();
    await writeAudit(env, ctx.team.id, principal.userId, "budget.cleared", null, null);
    return json({ budget: null, canManage: true });
  }

  const thresholds = Array.isArray(body.thresholds)
    ? parseThresholds(body.thresholds.join(","))
    : parseThresholds(String(body.thresholds ?? "80,100"));
  if (!thresholds.length) throw badRequest("thresholds must include at least one percentage.");

  const webhook = typeof body.webhookUrl === "string" ? body.webhookUrl.trim() : "";
  if (webhook && !/^https:\/\//i.test(webhook)) {
    throw badRequest("webhookUrl must be an https URL.");
  }

  await env.DB.prepare(
    `INSERT INTO team_budgets (team_id, monthly_usd, thresholds, webhook_url, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (team_id) DO UPDATE SET
       monthly_usd = excluded.monthly_usd,
       thresholds = excluded.thresholds,
       webhook_url = excluded.webhook_url,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  )
    .bind(
      ctx.team.id,
      monthly,
      thresholds.join(","),
      webhook || null,
      principal.userId,
      nowIso(),
    )
    .run();

  await writeAudit(
    env,
    ctx.team.id,
    principal.userId,
    "budget.updated",
    null,
    `$${monthly.toFixed(2)}/mo, alerts at ${thresholds.join("%, ")}%`,
  );

  return json({ budget: await budgetFor(env, ctx.team.id), canManage: true });
}

/**
 * Which thresholds a team has newly crossed this month.
 *
 * Pure so the once-per-month rule is testable without a cron or a clock.
 */
export function newlyCrossed(
  usedShare: number,
  thresholds: number[],
  alreadyFired: number[],
): number[] {
  const fired = new Set(alreadyFired);
  return thresholds.filter((t) => usedShare * 100 >= t && !fired.has(t));
}

interface AlertTarget {
  teamId: string;
  teamName: string;
  webhook: string | null;
  status: BudgetStatus;
  thresholds: number[];
}

/**
 * Cron entry point. Walks every team with a budget, fires any newly-crossed
 * threshold once, and records it.
 *
 * Delivery failure is recorded (`delivered = 0`) rather than retried: the next
 * tick would re-send an alert the manager may already have seen, and a stale
 * duplicate is worse than a missing one that the dashboard still shows.
 */
export async function runBudgetAlerts(env: Env, now = new Date()): Promise<number> {
  const month = now.toISOString().slice(0, 7);
  const { results } = await env.DB.prepare(
    `SELECT b.team_id, b.monthly_usd, b.thresholds, b.webhook_url, t.name AS team_name
     FROM team_budgets b JOIN teams t ON t.id = b.team_id
     WHERE b.monthly_usd > 0 AND t.deleted_at IS NULL`,
  ).all<{
    team_id: string;
    monthly_usd: number;
    thresholds: string;
    webhook_url: string | null;
    team_name: string;
  }>();

  let fired = 0;
  for (const row of results ?? []) {
    const spend = await monthSpend(env, row.team_id, now);
    const status = budgetStatus(row.monthly_usd, spend, now);

    const priorRows = await env.DB.prepare(
      "SELECT threshold FROM budget_alerts WHERE team_id = ? AND month = ?",
    )
      .bind(row.team_id, month)
      .all<{ threshold: number }>();
    const already = (priorRows.results ?? []).map((r) => r.threshold);

    const crossed = newlyCrossed(status.usedShare, parseThresholds(row.thresholds), already);
    for (const threshold of crossed) {
      const delivered = await deliverAlert(
        { teamId: row.team_id, teamName: row.team_name, webhook: row.webhook_url, status, thresholds: [threshold] },
      );
      await env.DB.prepare(
        `INSERT INTO budget_alerts (team_id, month, threshold, fired_at, spend_usd, delivered)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (team_id, month, threshold) DO NOTHING`,
      )
        .bind(row.team_id, month, threshold, nowIso(), spend, delivered ? 1 : 0)
        .run();
      fired += 1;
    }
  }
  return fired;
}

/** Posts a Slack-compatible payload. Returns false rather than throwing. */
async function deliverAlert(target: AlertTarget): Promise<boolean> {
  if (!target.webhook) return false;
  const { status } = target;
  const pct = Math.round(status.usedShare * 100);
  const text =
    `*${target.teamName}* has used ${pct}% of its $${status.monthlyUsd.toFixed(0)} monthly agent budget ` +
    `($${status.spendUsd.toFixed(2)} on day ${status.daysElapsed} of ${status.daysInMonth}). ` +
    (status.onTrackToExceed
      ? `Tracking to $${status.projectedUsd.toFixed(2)} by month end.`
      : `Projected $${status.projectedUsd.toFixed(2)} by month end.`);
  try {
    const res = await fetch(target.webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
