/**
 * Build a GitHub commit URL from a git remote URL and full/abbrev SHA.
 * Returns null when the remote is not a github.com host or inputs are invalid.
 */
export function buildGithubCommitUrl(
  remoteUrl: string | null | undefined,
  sha: string | null | undefined,
): string | null {
  if (!remoteUrl || !sha) return null;
  const trimmedRemote = remoteUrl.trim();
  const trimmedSha = sha.trim();
  if (!trimmedRemote || !trimmedSha) return null;
  if (!/^[0-9a-f]{7,40}$/i.test(trimmedSha)) return null;

  const ownerRepo = parseGithubOwnerRepo(trimmedRemote);
  if (!ownerRepo) return null;
  return `https://github.com/${ownerRepo}/commit/${trimmedSha}`;
}

/** Extract `owner/repo` from common GitHub remote URL forms. */
export function parseGithubOwnerRepo(remoteUrl: string): string | null {
  const url = remoteUrl.trim().replace(/\/+$/, "");

  // git@github.com:owner/repo.git
  let m = url.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (m) return stripDotGit(m[1]);

  // ssh://git@github.com/owner/repo.git
  m = url.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (m) return stripDotGit(m[1]);

  // https://github.com/owner/repo(.git)
  // https://www.github.com/owner/repo
  m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (m) return stripDotGit(m[1]);

  return null;
}

function stripDotGit(s: string): string {
  return s.endsWith(".git") ? s.slice(0, -4) : s;
}
