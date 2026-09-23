import type { Env } from "./env";
import { nowIso, utcDay, type EventDims } from "./validate";

export async function upsertHeartbeat(
  env: Env,
  payload: {
    installId: string;
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
       os_name, os_version, arch, channel
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(install_id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       first_app_version = COALESCE(installs.first_app_version, excluded.first_app_version),
       last_app_version = excluded.last_app_version,
       os_name = excluded.os_name, os_version = excluded.os_version,
       arch = excluded.arch, channel = excluded.channel`,
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
    )
    .run();

  await env.DB.prepare(
    "INSERT OR IGNORE INTO daily_active (day, install_id, app_version) VALUES (?, ?, ?)",
  )
    .bind(day, payload.installId, payload.appVersion)
    .run();
}

export async function recordEvent(
  env: Env,
  installId: string,
  name: string,
  dims: EventDims,
): Promise<void> {
  const day = utcDay();
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO installs (install_id, first_seen_at, last_seen_at)
     VALUES (?, ?, ?)
     ON CONFLICT(install_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  )
    .bind(installId, now, now)
    .run();

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
