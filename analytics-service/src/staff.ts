/**
 * GitHub accounts that may open owner.agmux.dev, by numeric user id.
 * Logins can be renamed and later re-registered by someone else; ids can't.
 */
export const OWNER_GITHUB_IDS = ["70348595"] as const; // neelsatyavolu

const ID_SET = new Set<string>(OWNER_GITHUB_IDS);

export function isOwnerGithubId(id: string | number | null | undefined): boolean {
  if (id === null || id === undefined) return false;
  return ID_SET.has(String(id));
}
