/**
 * CSV export.
 *
 * Managers do not live in this dashboard — they live in spreadsheets and BI
 * tools. This hands them the same numbers the dashboard renders, in the format
 * they actually work in.
 *
 * Scope follows the same rule as every other analytics route: owners and
 * unscoped managers export the whole team, scoped managers export their people,
 * an employee exports only their own rows. It rescopes silently rather than
 * 403ing, exactly like `teamOverview`.
 *
 * Contains no more information than the dashboard already shows — counters and
 * short labels. There is no column here that could carry prompt text.
 */
import type { Env } from "../env";
import { badRequest } from "../http";
import { requireTeam } from "../authz";
import type { Principal } from "../session";
import { roster } from "./members";
import { isRangeKey, windowFromDates, windowFromRange, type TimeWindow } from "../aggregate";
import { writeAudit } from "./audit";
import { resolveAnalyticsScope } from "../scope";

export type Granularity = "hour" | "day";

const COLUMNS = [
  "date",
  "hour_utc",
  "member",
  "role",
  "provider",
  "model",
  "project",
  "tokens_in",
  "tokens_out",
  "tokens_cache_read",
  "tokens_cache_write",
  "tokens_reasoning",
  "tokens_total",
  "cost_usd",
  "active_hours",
  "after_hours_hours",
  "weekend_hours",
  "active_session_hours",
  "sessions_started",
  "turns",
  "tool_calls",
  "tool_bash",
  "tool_edit",
  "tool_read",
  "tool_search",
  "tool_web",
  "tool_agent",
  "tool_mcp",
  "tool_other",
  "tool_errors",
  "tools_measured",
  "files_changed",
  "lines_added",
  "lines_removed",
] as const;

/**
 * RFC 4180 quoting. Also strips a leading `=`, `+`, `-` or `@`, which
 * spreadsheets execute as a formula — a display name is not a place to hide a
 * payload that runs when a manager opens the file.
 */
export function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  // Leading tab (0x09) and CR (0x0D) are also treated as formula starts by
  // Excel/LibreOffice, so neutralize them alongside = + - @.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(",");
}

function windowOf(url: URL): TimeWindow {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (from && to) {
    const custom = windowFromDates(from, to);
    if (custom) return custom;
  }
  const raw = url.searchParams.get("range") ?? "30d";
  return windowFromRange(isRangeKey(raw) ? raw : "30d");
}

function granularityOf(url: URL): Granularity {
  const g = url.searchParams.get("granularity");
  if (g && g !== "hour" && g !== "day") {
    throw badRequest("granularity must be 'hour' or 'day'.");
  }
  return g === "hour" ? "hour" : "day";
}

/** Filename-safe slug so the download lands with a recognisable name. */
function safeSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || "team";
}

const HOURS = 3_600_000;
const round = (n: number, dp: number): number => Number((n ?? 0).toFixed(dp));

interface ExportRow extends Record<string, unknown> {
  hour_utc: string;
  user_id: string;
  provider: string;
  model: string;
  project_key: string;
}

export async function exportCsv(
  req: Request,
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  const url = new URL(req.url);
  const win = windowOf(url);
  const granularity = granularityOf(url);

  const scope = await resolveAnalyticsScope(env, ctx);

  // A day export folds the hours server-side; an hour export keeps them. Either
  // way the counters are summed, never averaged.
  const hourExpr = granularity === "day" ? "substr(hour_utc, 1, 10)" : "hour_utc";

  const clauses = ["team_id = ?", "hour_utc >= ?"];
  const binds: unknown[] = [ctx.team.id, win.sinceHour];
  if (win.untilHour) {
    clauses.push("hour_utc < ?");
    binds.push(win.untilHour);
  }
  if (scope.userIds !== null) {
    if (scope.userIds.length === 0) {
      clauses.push("1 = 0");
    } else if (scope.userIds.length === 1) {
      clauses.push("user_id = ?");
      binds.push(scope.userIds[0]);
    } else {
      clauses.push(`user_id IN (${scope.userIds.map(() => "?").join(",")})`);
      binds.push(...scope.userIds);
    }
  }

  const [{ results }, members] = await Promise.all([
    env.DB.prepare(
      `SELECT ${hourExpr} AS hour_utc, user_id, provider, model, project_key,
              SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
              SUM(tokens_cache_read) AS tokens_cache_read,
              SUM(tokens_cache_write) AS tokens_cache_write,
              SUM(tokens_reasoning) AS tokens_reasoning,
              SUM(cost_usd) AS cost_usd, SUM(active_ms) AS active_ms,
              SUM(after_hours_ms) AS after_hours_ms, SUM(weekend_ms) AS weekend_ms,
              SUM(sessions) AS sessions,
              -- Blank, not zero, when an active row came from a desktop that
              -- did not report session starts.
              CASE WHEN SUM(sessions > 0 AND sessions_started IS NULL) > 0 THEN NULL
                   ELSE COALESCE(SUM(sessions_started), 0) END AS sessions_started,
              SUM(turns) AS turns, SUM(tool_calls) AS tool_calls,
              SUM(tool_bash) AS tool_bash, SUM(tool_edit) AS tool_edit,
              SUM(tool_read) AS tool_read, SUM(tool_search) AS tool_search,
              SUM(tool_web) AS tool_web, SUM(tool_agent) AS tool_agent,
              SUM(tool_mcp) AS tool_mcp, SUM(tool_other) AS tool_other,
              SUM(tool_errors) AS tool_errors, SUM(tools_measured) AS tools_measured,
              SUM(files_changed) AS files_changed, SUM(lines_added) AS lines_added,
              SUM(lines_removed) AS lines_removed
       FROM metric_hourly
       WHERE ${clauses.join(" AND ")}
       GROUP BY 1, user_id, provider, model, project_key
       ORDER BY 1, user_id, provider, model, project_key`,
    )
      .bind(...binds)
      .all<ExportRow>(),
    roster(env, ctx.team.id),
  ]);

  const nameOf = new Map(members.map((m) => [m.user_id, m.display_name]));
  const roleOf = new Map(members.map((m) => [m.user_id, m.role]));

  const lines = [csvRow([...COLUMNS])];
  for (const r of results ?? []) {
    const n = (k: string): number => Number(r[k] ?? 0);
    // Reasoning is already inside tokens_out (it is a reported subset), so it
    // is not added again. Matches the dashboard's token total.
    const tokens =
      n("tokens_in") +
      n("tokens_out") +
      n("tokens_cache_read") +
      n("tokens_cache_write");
    lines.push(
      csvRow([
        r.hour_utc.slice(0, 10),
        granularity === "hour" ? r.hour_utc : "",
        nameOf.get(r.user_id) ?? r.user_id,
        roleOf.get(r.user_id) ?? "",
        r.provider,
        r.model,
        r.project_key,
        n("tokens_in"),
        n("tokens_out"),
        n("tokens_cache_read"),
        n("tokens_cache_write"),
        n("tokens_reasoning"),
        tokens,
        round(n("cost_usd"), 4),
        round(n("active_ms") / HOURS, 3),
        round(n("after_hours_ms") / HOURS, 3),
        round(n("weekend_ms") / HOURS, 3),
        n("sessions"),
        r.sessions_started == null ? "" : n("sessions_started"),
        n("turns"),
        n("tool_calls"),
        n("tool_bash"),
        n("tool_edit"),
        n("tool_read"),
        n("tool_search"),
        n("tool_web"),
        n("tool_agent"),
        n("tool_mcp"),
        n("tool_other"),
        n("tool_errors"),
        n("tools_measured"),
        n("files_changed"),
        n("lines_added"),
        n("lines_removed"),
      ]),
    );
  }

  // An export is a data egress event; a security review will ask who ran one.
  const scopeNote =
    scope.kind === "self" ? ", own data only" : scope.kind === "partial" ? ", scoped" : "";
  await writeAudit(
    env,
    ctx.team.id,
    principal.userId,
    "data.exported",
    null,
    `${granularity} CSV, ${win.days}d, ${(results ?? []).length} rows${scopeNote}`,
  );

  const filename = `agmux-${safeSlug(ctx.team.slug)}-${win.days}d-${granularity}.csv`;
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
