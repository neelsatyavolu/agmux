import type { Env } from "../env";
import { json } from "../http";
import { utcDay } from "../validate";

const ALLOWED_DAYS = new Set([7, 30, 90]);

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (n - 1));
  return utcDay(d);
}

export async function summary(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const raw = Number(url.searchParams.get("days") ?? "30");
  const days = ALLOWED_DAYS.has(raw) ? raw : 30;
  const since = daysAgo(days);
  const today = utcDay();
  const wauSince = daysAgo(7);
  const mauSince = daysAgo(28);
  const asOf = new Date().toISOString();

  const [
    installsTotal,
    installsNew,
    dauRows,
    wau,
    mau,
    byVersion,
    byOs,
    events,
    eventDims,
  ] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM installs").first<{ n: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM installs WHERE substr(first_seen_at, 1, 10) >= ?",
    )
      .bind(since)
      .first<{ n: number }>(),
    env.DB.prepare(
      "SELECT day, COUNT(*) AS count FROM daily_active WHERE day >= ? GROUP BY day ORDER BY day",
    )
      .bind(since)
      .all<{ day: string; count: number }>(),
    env.DB.prepare("SELECT COUNT(DISTINCT install_id) AS n FROM daily_active WHERE day >= ?")
      .bind(wauSince)
      .first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(DISTINCT install_id) AS n FROM daily_active WHERE day >= ?")
      .bind(mauSince)
      .first<{ n: number }>(),
    env.DB.prepare(
      `SELECT last_app_version AS app_version, COUNT(*) AS count
       FROM installs GROUP BY last_app_version ORDER BY count DESC LIMIT 20`,
    ).all<{ app_version: string | null; count: number }>(),
    env.DB.prepare(
      `SELECT os_name, os_version, COUNT(*) AS count
       FROM installs GROUP BY os_name, os_version ORDER BY count DESC LIMIT 20`,
    ).all<{ os_name: string | null; os_version: string | null; count: number }>(),
    env.DB.prepare(
      "SELECT day, name, count FROM daily_events WHERE day >= ? ORDER BY day, name",
    )
      .bind(since)
      .all<{ day: string; name: string; count: number }>(),
    env.DB.prepare(
      `SELECT day, name, dim_key, dim_value, count
       FROM daily_event_dims WHERE day >= ? ORDER BY day, name, dim_key, count DESC`,
    )
      .bind(since)
      .all<{ day: string; name: string; dim_key: string; dim_value: string; count: number }>(),
  ]);

  const dau = fillDays(
    since,
    today,
    (dauRows.results ?? []).map((r) => ({ day: r.day, count: Number(r.count) })),
  );
  const todayDau = dau.find((d) => d.day === today)?.count ?? 0;

  return json({
    asOf,
    days,
    installsTotal: Number(installsTotal?.n ?? 0),
    installsNew: Number(installsNew?.n ?? 0),
    todayDau,
    dau,
    wau: Number(wau?.n ?? 0),
    mau: Number(mau?.n ?? 0),
    byVersion: (byVersion.results ?? []).map((r) => ({
      app_version: r.app_version ?? "(unknown)",
      count: Number(r.count),
    })),
    byOs: (byOs.results ?? []).map((r) => ({
      os_name: r.os_name ?? "unknown",
      os_version: r.os_version ?? "unknown",
      count: Number(r.count),
    })),
    events: (events.results ?? []).map((r) => ({
      day: r.day,
      name: r.name,
      count: Number(r.count),
    })),
    eventDims: (eventDims.results ?? []).map((r) => ({
      day: r.day,
      name: r.name,
      key: r.dim_key,
      value: r.dim_value,
      count: Number(r.count),
    })),
  });
}

function fillDays(
  since: string,
  today: string,
  rows: { day: string; count: number }[],
): { day: string; count: number }[] {
  const map = new Map(rows.map((r) => [r.day, r.count]));
  const out: { day: string; count: number }[] = [];
  const d = new Date(`${since}T00:00:00Z`);
  const end = new Date(`${today}T00:00:00Z`);
  while (d <= end) {
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, count: map.get(key) ?? 0 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
