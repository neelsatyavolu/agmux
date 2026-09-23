/** GitHub logins that may open owner.agmux.dev. Handle, not display name. */
export const OWNER_GITHUB_LOGINS = ["neelsatyavolu"] as const;

const LOGIN_SET = new Set(OWNER_GITHUB_LOGINS.map((h) => h.toLowerCase()));

export function isOwnerGithubLogin(handle: string | null | undefined): boolean {
  if (!handle) return false;
  return LOGIN_SET.has(handle.trim().toLowerCase());
}
