/**
 * Platform staff: a tiny, explicit allowlist of GitHub accounts that can open
 * any team on the *web* dashboard as a read-only preview. Device-token
 * (desktop) traffic stays membership-only so this never becomes an upload path.
 *
 * Identification is the numeric GitHub user id on a linked GitHub identity.
 * Never `users.handle`: a linked Google account writes its email local part
 * there, and GitHub logins can be renamed and re-registered by someone else.
 */
import type { Env } from "./env";

/** GitHub numeric user ids (`identities.provider_user_id`). 70348595 = neelsatyavolu. */
export const PLATFORM_STAFF_GITHUB_IDS = ["70348595"] as const;

const ID_SET = new Set<string>(PLATFORM_STAFF_GITHUB_IDS);

export async function isPlatformStaff(env: Env, userId: string): Promise<boolean> {
  const { results } = await env.DB.prepare(
    `SELECT provider_user_id
     FROM identities
     WHERE user_id = ? AND provider = 'github'`,
  )
    .bind(userId)
    .all<{ provider_user_id: string }>();
  return (results ?? []).some((r) => ID_SET.has(String(r.provider_user_id)));
}
