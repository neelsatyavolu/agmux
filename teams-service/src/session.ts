/**
 * Two ways to authenticate:
 *   • web  — `__Host-agmux_teams` cookie holding a session token
 *   • desktop — `Authorization: Bearer <device token>`
 * Both resolve to the same `Principal`. Tokens are stored hashed.
 */
import type { Env } from "./env";
import { mintToken, newId, sha256 } from "./crypto";
import { isoPlusDays, nowIso } from "./db";
import { parseCookies, unauthorized } from "./http";

const SESSION_DAYS = 30;
export const SESSION_MAX_AGE = SESSION_DAYS * 86_400;

export interface Principal {
  userId: string;
  /** Present only for desktop device-token calls. */
  deviceId: string | null;
  via: "cookie" | "device";
}

export async function createSession(env: Env, userId: string): Promise<string> {
  const token = mintToken();
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(await sha256(token), userId, nowIso(), isoPlusDays(SESSION_DAYS))
    .run();
  return token;
}

export async function destroySession(env: Env, token: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
}

export async function createDeviceToken(
  env: Env,
  userId: string,
  deviceId: string,
  label: string | null,
): Promise<string> {
  const token = mintToken();
  await env.DB.prepare(
    `INSERT INTO device_tokens (token_hash, device_id, user_id, device_label, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(await sha256(token), deviceId, userId, label, nowIso())
    .run();
  return token;
}

/** Resolves the caller, or null when unauthenticated. Never throws on absence. */
export async function authenticate(req: Request, env: Env): Promise<Principal | null> {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const hash = await sha256(auth.slice(7).trim());
    const row = await env.DB.prepare(
      "SELECT device_id, user_id FROM device_tokens WHERE token_hash = ? AND revoked_at IS NULL",
    )
      .bind(hash)
      .first<{ device_id: string; user_id: string }>();
    if (!row) return null;
    // Sync freshness is what dashboards show as "last seen".
    await env.DB.prepare("UPDATE device_tokens SET last_seen_at = ? WHERE token_hash = ?")
      .bind(nowIso(), hash)
      .run();
    return { userId: row.user_id, deviceId: row.device_id, via: "device" };
  }

  const cookie = parseCookies(req.headers.get("cookie"))["__Host-agmux_teams"];
  if (!cookie) return null;
  const row = await env.DB.prepare(
    "SELECT user_id, expires_at FROM sessions WHERE token_hash = ?",
  )
    .bind(await sha256(cookie))
    .first<{ user_id: string; expires_at: string }>();
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  return { userId: row.user_id, deviceId: null, via: "cookie" };
}

export async function requirePrincipal(req: Request, env: Env): Promise<Principal> {
  const p = await authenticate(req, env);
  if (!p) throw unauthorized();
  return p;
}

/**
 * Device-link handshake. The desktop app opens the web sign-in with a device id,
 * then polls with the same one-shot code to collect its bearer token.
 */
export async function createLinkCode(
  env: Env,
  deviceId: string,
  label: string | null,
): Promise<string> {
  const code = mintToken(24);
  await env.DB.prepare(
    `INSERT INTO device_link_codes (code_hash, device_id, device_label, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(await sha256(code), deviceId, label, nowIso(), isoPlusDays(1 / 48))
    .run();
  return code;
}

/**
 * Bind a pending device-link code to the signed-in user.
 *
 * Idempotent for the same user: if the code is already bound (or even claimed)
 * by this user, returns true. That covers the common case of refreshing
 * `/link?code=…` after a successful handoff — previously that re-showed
 * "Couldn't link this Mac" even though the desktop already had the token.
 */
export async function attachLinkCode(env: Env, code: string, userId: string): Promise<boolean> {
  const hash = await sha256(code);
  const res = await env.DB.prepare(
    `UPDATE device_link_codes SET user_id = ?
     WHERE code_hash = ? AND claimed_at IS NULL AND expires_at > ?`,
  )
    .bind(userId, hash, nowIso())
    .run();
  if ((res.meta?.changes ?? 0) > 0) return true;

  // Already bound/claimed by this user → success. Unknown, expired-without-
  // binding, or bound to someone else → fail.
  const row = await env.DB.prepare(
    "SELECT user_id FROM device_link_codes WHERE code_hash = ?",
  )
    .bind(hash)
    .first<{ user_id: string | null }>();
  return row?.user_id === userId;
}

/** Claims a code exactly once, returning the freshly minted device token. */
export async function claimLinkCode(env: Env, code: string): Promise<string | null> {
  const hash = await sha256(code);
  const row = await env.DB.prepare(
    `SELECT device_id, user_id, device_label FROM device_link_codes
     WHERE code_hash = ? AND claimed_at IS NULL AND expires_at > ?`,
  )
    .bind(hash, nowIso())
    .first<{ device_id: string; user_id: string | null; device_label: string | null }>();
  if (!row?.user_id) return null;

  const claimed = await env.DB.prepare(
    "UPDATE device_link_codes SET claimed_at = ? WHERE code_hash = ? AND claimed_at IS NULL",
  )
    .bind(nowIso(), hash)
    .run();
  if ((claimed.meta?.changes ?? 0) === 0) return null; // lost the race

  return createDeviceToken(env, row.user_id, row.device_id, row.device_label);
}

export const newUserId = () => newId("usr");
