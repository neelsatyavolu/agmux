/**
 * Resolve a member's profile photo URL.
 * Preference: stored OAuth URL (GitHub avatar_url / Google picture) → public
 * GitHub CDN from numeric user id when they have a linked GitHub identity.
 */

const MAX_AVATAR_URL_LEN = 500;

/** Only allow https URLs we would embed in <img src>. */
export function sanitizeAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const t = String(url).trim();
  if (!t || t.length > MAX_AVATAR_URL_LEN) return null;
  if (!/^https:\/\//i.test(t)) return null;
  return t;
}

/** GitHub serves public avatars at a stable CDN path from the numeric user id. */
export function githubAvatarUrl(providerUserId: string | null | undefined): string | null {
  if (!providerUserId) return null;
  const id = String(providerUserId).trim();
  if (!/^\d{1,20}$/.test(id)) return null;
  return `https://avatars.githubusercontent.com/u/${id}?v=4`;
}

export function resolveAvatarUrl(
  stored: string | null | undefined,
  githubUserId?: string | null,
): string | null {
  return sanitizeAvatarUrl(stored) ?? githubAvatarUrl(githubUserId);
}
