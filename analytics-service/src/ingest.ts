import type { Env } from "./env";
import { nowIso, utcDay, type App, type EventDims } from "./validate";

export async function upsertHeartbeat(
  env: Env,
  payload: {
    installId: string;
    app: App;
    appVersion: string;
    osName: string;
    osVersion: string;
    arch: string;
    channel: "release" | "dev";
  },
): Promise<void> {
  const now = nowIso();
  const day = utcDay();
  await env.DB.prepare(
    `INSERT INTO installs (
       install_id, first_seen_at, last_seen_at, first_app_version, last_app_version,
       os_name, os_version, arch, channel, app
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(install_id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       first_app_version = COALESCE(installs.first_app_version, excluded.first_app_version),
       last_app_version = excluded.last_app_version,
       os_name = excluded.os_name, os_version = excluded.os_version,
       arch = excluded.arch, channel = excluded.channel, app = excluded.app`,
  )
    .bind(
      payload.installId,
      now,
      now,
      payload.appVersion,
      payload.appVersion,
      payload.osName,
      payload.osVersion,
      payload.arch,
      payload.channel,
      payload.app,
    )
    .run();

  await env.DB.prepare(
    "INSERT OR IGNORE INTO daily_active (day, install_id, app_version, app) VALUES (?, ?, ?, ?)",
  )
    .bind(day, payload.installId, payload.appVersion, payload.app)
    .run();
}

export async function recordEvent(
  env: Env,
  installId: string,
  name: string,
  dims: EventDims,
  app: App = "agmux",
): Promise<void> {
  await touchInstall(env, installId, app);
  await countEvent(env, name, dims);
}

/** One install touch for the whole batch, then each event's counters. */
export async function recordEvents(
  env: Env,
  installId: string,
  app: App,
  events: { name: string; dims: EventDims }[],
): Promise<void> {
  if (events.length === 0) return;
  await touchInstall(env, installId, app);
  for (const e of events) await countEvent(env, e.name, e.dims);
}

async function touchInstall(env: Env, installId: string, app: App): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO installs (install_id, first_seen_at, last_seen_at, app)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(install_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  )
    .bind(installId, now, now, app)
    .run();
}

async function countEvent(env: Env, name: string, dims: EventDims): Promise<void> {
  const day = utcDay();
  await env.DB.prepare(
    `INSERT INTO daily_events (day, name, count) VALUES (?, ?, 1)
     ON CONFLICT(day, name) DO UPDATE SET count = count + 1`,
  )
    .bind(day, name)
    .run();

  for (const [key, value] of Object.entries(dims)) {
    await env.DB.prepare(
      `INSERT INTO daily_event_dims (day, name, dim_key, dim_value, count)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(day, name, dim_key, dim_value) DO UPDATE SET count = count + 1`,
    )
      .bind(day, name, key, value)
      .run();
  }
}
