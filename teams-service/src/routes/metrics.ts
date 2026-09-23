import type { Env } from "../env";
import { forbidden, json, readJson } from "../http";
import type { Principal } from "../session";
import {
  applyUpload,
  pruneStale,
  trimRetention,
  validatePayload,
  validatePrunePayload,
} from "../metrics";

/**
 * Upload endpoint. Device-token only — a browser session must never be able to
 * inject metrics, because the web surface has no legitimate reason to write.
 */
export async function upload(req: Request, env: Env, principal: Principal): Promise<Response> {
  if (principal.via !== "device" || !principal.deviceId) {
    throw forbidden("Metrics upload requires a linked desktop device token.");
  }
  const payload = validatePayload(await readJson<unknown>(req));
  const result = await applyUpload(env, principal.userId, principal.deviceId, payload);
  // Retention trim rides along with ingest so there is no cron to keep alive.
  await trimRetention(env);
  return json(result);
}

/** Full-sync follow-up: drop stale hourly rows this device no longer reports. */
export async function prune(req: Request, env: Env, principal: Principal): Promise<Response> {
  if (principal.via !== "device" || !principal.deviceId) {
    throw forbidden("Metrics prune requires a linked desktop device token.");
  }
  const payload = validatePrunePayload(await readJson<unknown>(req));
  const result = await pruneStale(env, principal.userId, principal.deviceId, payload);
  return json(result);
}

/** What the desktop Sync pane reads back to show freshness and reach. */
export async function syncState(env: Env, principal: Principal): Promise<Response> {
  const devices = await env.DB.prepare(
    `SELECT device_id, device_label, last_seen_at, created_at
     FROM device_tokens WHERE user_id = ? AND revoked_at IS NULL
     ORDER BY created_at DESC`,
  )
    .bind(principal.userId)
    .all();

  const uploads = await env.DB.prepare(
    "SELECT device_id, last_upload_at, last_bucket_hour FROM sync_state WHERE user_id = ?",
  )
    .bind(principal.userId)
    .all();

  const teams = await env.DB.prepare(
    `SELECT t.id, t.slug, t.name, m.role
     FROM team_members m JOIN teams t ON t.id = m.team_id
     WHERE m.user_id = ? AND m.left_at IS NULL AND t.deleted_at IS NULL`,
  )
    .bind(principal.userId)
    .all();

  return json({
    devices: devices.results ?? [],
    uploads: uploads.results ?? [],
    teamsReceiving: teams.results ?? [],
  });
}
