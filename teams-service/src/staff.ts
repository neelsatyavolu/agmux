/**
 * Platform staff: a tiny, explicit allowlist of GitHub logins that can open
 * any team on the *web* dashboard as a read-only preview. Device-token
 * (desktop) traffic stays membership-only so this never becomes an upload path.
 *
 * Identification is GitHub identity + users.handle, not display name, so a
 * Google-only account cannot inherit the privilege by handle collision.
 */
import type { Env } from "./env";

export const PLATFORM_STAFF_GITHUB_LOGINS = ["neelsatyavolu"] as const;

const LOGIN_SET = new Set(
  PLATFORM_STAFF_GITHUB_LOGINS.map((h) => h.toLowerCase()),
);

export function isStaffGithubLogin(handle: string | null | undefined): boolean {
  if (!handle) return false;
  return LOGIN_SET.has(handle.trim().toLowerCase());
}

export async function isPlatformStaff(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT u.handle
     FROM users u
     JOIN identities i ON i.user_id = u.id AND i.provider = 'github'
     WHERE u.id = ?
     LIMIT 1`,
  )
    .bind(userId)
    .first<{ handle: string | null }>();
  return isStaffGithubLogin(row?.handle ?? null);
}
