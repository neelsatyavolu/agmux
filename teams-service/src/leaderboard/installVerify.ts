/**
 * Proving that the person finishing the GitHub App install actually controls
 * the installation they hand back. The setup callback's `installation_id` is
 * just a URL parameter, and the App's own credentials can read *any*
 * installation, so without this check a team owner could link another
 * organisation's installation and read its private repos and PRs.
 *
 * Strongest proof: the App's "Request user authorization (OAuth) during
 * installation" setting sends a `code`; we exchange it for a user token and
 * require the id in `GET /user/installations`. That needs the App's client id
 * and secret (GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET).
 *
 * Without those secrets: personal-account installs must belong to the
 * signer's linked GitHub account, and organisation installs must have been
 * created or changed in the last few minutes (i.e. by this flow). In both
 * cases an installation already linked to another team is refused.
 */
import type { Env } from "../env";

export interface GhInstallation {
  id: number;
  account: { login: string; type: string; id?: number };
  created_at?: string;
  updated_at?: string;
}

export type InstallProof = { kind: "user_installations"; ids: ReadonlySet<string> } | { kind: "none" };

/** How recently an org installation must have been created/changed when no user proof exists. */
export const RECENT_INSTALL_MS = 15 * 60 * 1000;

export type OwnershipError = "install_in_use" | "install_not_yours" | "install_verify";

export function checkInstallOwnership(args: {
  installation: GhInstallation;
  proof: InstallProof;
  principalGithubIds: readonly string[];
  linkedToOtherTeam: boolean;
  nowMs: number;
}): OwnershipError | null {
  const { installation, proof, principalGithubIds, linkedToOtherTeam, nowMs } = args;
  if (linkedToOtherTeam) return "install_in_use";

  if (proof.kind === "user_installations") {
    return proof.ids.has(String(installation.id)) ? null : "install_not_yours";
  }

  if (principalGithubIds.length === 0) return "install_verify";

  if (installation.account.type === "User") {
    const owner = installation.account.id;
    return owner !== undefined && principalGithubIds.includes(String(owner)) ? null : "install_not_yours";
  }

  const touched = [installation.created_at, installation.updated_at]
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter((t) => Number.isFinite(t));
  const recent = touched.some((t) => t <= nowMs + 60_000 && nowMs - t <= RECENT_INSTALL_MS);
  return recent ? null : "install_verify";
}

export function githubAppUserAuthConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_APP_CLIENT_ID?.trim() && env.GITHUB_APP_CLIENT_SECRET?.trim());
}

const GH_HEADERS = {
  accept: "application/vnd.github+json",
  "user-agent": "agmux-teams",
  "x-github-api-version": "2022-11-28",
};

/** Installation ids the GitHub user behind `code` can access. Throws on any failure. */
export async function userInstallationIds(env: Env, code: string): Promise<Set<string>> {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "agmux-teams" },
    body: JSON.stringify({
      client_id: env.GITHUB_APP_CLIENT_ID!.trim(),
      client_secret: env.GITHUB_APP_CLIENT_SECRET!.trim(),
      code,
    }),
  });
  if (!tokenRes.ok) throw new Error(`GitHub code exchange failed (${tokenRes.status})`);
  const { access_token: token } = (await tokenRes.json()) as { access_token?: string };
  if (!token) throw new Error("GitHub code exchange returned no token");

  const ids = new Set<string>();
  for (let page = 1; page <= 5; page += 1) {
    const res = await fetch(`https://api.github.com/user/installations?per_page=100&page=${page}`, {
      headers: { ...GH_HEADERS, authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`GitHub user installations failed (${res.status})`);
    const body = (await res.json()) as { installations?: Array<{ id: number }> };
    const list = body.installations ?? [];
    for (const inst of list) ids.add(String(inst.id));
    if (list.length < 100) break;
  }
  return ids;
}
