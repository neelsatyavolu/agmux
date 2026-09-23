/**
 * GitHub App JWT + installation tokens for org PR sync.
 * Secrets: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_SLUG.
 *
 * Efficiency: prefer org-wide GraphQL search (≤3 HTTP calls for any # of repos)
 * instead of per-repo pagination or N+1 REST detail fetches.
 */
import type { Env } from "../env";
import { HttpError } from "../http";

const b64url = (data: ArrayBuffer | Uint8Array | string): string => {
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function pemToBytes(pem: string): Uint8Array {
  const cleaned = pem
    .replace(/-----BEGIN [A-Z0-9 ]+-----/g, "")
    .replace(/-----END [A-Z0-9 ]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(cleaned);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const oidRsa = Uint8Array.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
  const nullParams = Uint8Array.from([0x05, 0x00]);
  const algId = encodeSeq(concat(oidRsa, nullParams));
  const version = Uint8Array.from([0x02, 0x01, 0x00]);
  const oct = encodeOctetString(pkcs1);
  return encodeSeq(concat(version, algId, oct));
}

function encodeLen(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.from([n]);
  if (n < 0x100) return Uint8Array.from([0x81, n]);
  if (n < 0x10000) return Uint8Array.from([0x82, (n >> 8) & 0xff, n & 0xff]);
  return Uint8Array.from([0x83, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

function encodeSeq(body: Uint8Array): Uint8Array {
  return concat(Uint8Array.from([0x30]), encodeLen(body.length), body);
}

function encodeOctetString(body: Uint8Array): Uint8Array {
  return concat(Uint8Array.from([0x04]), encodeLen(body.length), body);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function privateKeyDer(pem: string): Uint8Array {
  const isPkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const raw = pemToBytes(pem);
  return isPkcs1 ? pkcs1ToPkcs8(raw) : raw;
}

export function githubAppConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_APP_ID?.trim() && env.GITHUB_APP_PRIVATE_KEY?.trim());
}

export async function appJwt(env: Env): Promise<string> {
  if (!githubAppConfigured(env)) {
    throw new HttpError(503, "GitHub App isn't configured on this server.", "github_app_unconfigured");
  }
  const appId = env.GITHUB_APP_ID!.trim();
  const pem = env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyDer(pem) as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data);
  return `${header}.${payload}.${b64url(sig)}`;
}

export async function installationToken(env: Env, installationId: string): Promise<string> {
  const jwt = await appJwt(env);
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "user-agent": "agmux-teams",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new HttpError(502, `GitHub installation token failed (${res.status}).`, "github_token_failed");
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new HttpError(502, "GitHub returned no installation token.", "github_token_failed");
  return body.token;
}

export function installUrl(env: Env, state: string): string {
  const slug = (env.GITHUB_APP_SLUG ?? "").trim();
  if (!slug) {
    throw new HttpError(
      503,
      "GitHub App slug isn't configured (GITHUB_APP_SLUG).",
      "github_app_unconfigured",
    );
  }
  const p = new URLSearchParams({ state });
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?${p}`;
}

export interface GhPr {
  number: number;
  user: { id: number; login: string; type?: string } | null;
  created_at: string;
  merged_at: string | null;
  closed_at: string | null;
  updated_at: string;
  additions: number;
  deletions: number;
  draft?: boolean;
}

export interface GhPrWithRepo extends GhPr {
  repo_full_name: string;
}

/**
 * Hard ceiling for GitHub HTTP calls per Worker invocation (token + GraphQL).
 * Workers Paid allows 10k; we stay tiny so usage/CPU stay in the noise of $5 plan.
 */
export const MAX_GITHUB_SUBREQUESTS = 6;

/** Search pages × 100 PRs. 2 weeks of activity almost always fits in 1 page. */
const MAX_SEARCH_PAGES = 2;

const SEARCH_PULLS = `
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        createdAt
        mergedAt
        closedAt
        updatedAt
        additions
        deletions
        isDraft
        repository { nameWithOwner }
        author {
          __typename
          login
          ... on User { databaseId }
        }
      }
    }
  }
}`;

const REPO_PULLS_FRAGMENT = `
  number createdAt mergedAt closedAt updatedAt additions deletions isDraft
  author { __typename login ... on User { databaseId } }
`;

interface GqlAuthor {
  __typename?: string;
  login?: string;
  databaseId?: number;
}

interface GqlPullNode {
  number: number;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  additions: number;
  deletions: number;
  isDraft?: boolean;
  author: GqlAuthor | null;
  repository?: { nameWithOwner: string };
}

async function githubGraphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "agmux-teams",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new HttpError(502, `GitHub GraphQL failed (${res.status}).`, "github_list_failed");
  }
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) {
    throw new HttpError(
      502,
      `GitHub GraphQL: ${body.errors[0]!.message.slice(0, 140)}`,
      "github_list_failed",
    );
  }
  if (!body.data) throw new HttpError(502, "GitHub GraphQL returned no data.", "github_list_failed");
  return body.data;
}

function gqlNodeToPr(node: GqlPullNode): GhPr {
  const isBot =
    !node.author ||
    node.author.__typename === "Bot" ||
    (node.author.login ?? "").toLowerCase().endsWith("[bot]");
  const login = node.author?.login ?? "";
  const id = typeof node.author?.databaseId === "number" ? node.author.databaseId : 0;
  return {
    number: node.number,
    user: { id, login, type: isBot ? "Bot" : "User" },
    created_at: node.createdAt,
    merged_at: node.mergedAt,
    closed_at: node.closedAt,
    updated_at: node.updatedAt,
    additions: Number(node.additions ?? 0),
    deletions: Number(node.deletions ?? 0),
    draft: Boolean(node.isDraft),
  };
}

/**
 * Fetch PRs for selected repos with minimal subrequests.
 *
 * Strategy:
 * 1. Same-org selection → GraphQL search `org:X is:pr updated:>=day` (1–3 calls total).
 * 2. Else → one multi-alias GraphQL query for up to 15 repos (1 call).
 *
 * Always includes additions/deletions — never N+1 detail fetches.
 */
export async function listPullsForRepos(
  token: string,
  repos: string[],
  sinceIso: string,
  orgLogin: string | null,
): Promise<{ pulls: GhPrWithRepo[]; httpCalls: number }> {
  const selected = new Set(repos.map((r) => r.toLowerCase()));
  const sinceDay = sinceIso.slice(0, 10); // YYYY-MM-DD for search

  // Prefer a single search query. Scope tightly when few repos so we don't
  // page through the whole org's noise.
  if (repos.length > 0 && repos.length <= 12) {
    const q = `${repos.map((r) => `repo:${r}`).join(" ")} is:pr updated:>=${sinceDay}`;
    return listPullsViaSearch(token, q, selected, sinceIso);
  }

  const org =
    orgLogin?.trim() ||
    (repos.length && repos.every((r) => r.split("/")[0] === repos[0]!.split("/")[0])
      ? repos[0]!.split("/")[0]!
      : null);

  if (org) {
    const q = `org:${org} is:pr updated:>=${sinceDay}`;
    return listPullsViaSearch(token, q, selected, sinceIso);
  }
  return listPullsViaMultiRepo(token, repos, sinceIso);
}

async function listPullsViaSearch(
  token: string,
  q: string,
  selectedLower: Set<string>,
  sinceIso: string,
): Promise<{ pulls: GhPrWithRepo[]; httpCalls: number }> {
  const out: GhPrWithRepo[] = [];
  let cursor: string | null = null;
  let httpCalls = 0;
  let pages = 0;

  type SearchData = {
    search: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<GqlPullNode | null>;
    };
  };

  while (pages < MAX_SEARCH_PAGES) {
    httpCalls += 1;
    pages += 1;
    const data: SearchData = await githubGraphql<SearchData>(token, SEARCH_PULLS, {
      q,
      cursor,
    });

    let hitOlder = false;
    for (const node of data.search.nodes ?? []) {
      if (!node?.number || !node.repository?.nameWithOwner) continue;
      if (node.updatedAt < sinceIso) {
        hitOlder = true;
        break;
      }
      const full = node.repository.nameWithOwner;
      if (!selectedLower.has(full.toLowerCase())) continue;
      out.push({ ...gqlNodeToPr(node), repo_full_name: full });
    }

    if (hitOlder || !data.search.pageInfo.hasNextPage) break;
    cursor = data.search.pageInfo.endCursor;
    if (!cursor) break;
  }

  return { pulls: out, httpCalls };
}

/** One GraphQL request covering many repos (aliases). */
async function listPullsViaMultiRepo(
  token: string,
  repos: string[],
  sinceIso: string,
): Promise<{ pulls: GhPrWithRepo[]; httpCalls: number }> {
  const slice = repos.slice(0, 15);
  if (!slice.length) return { pulls: [], httpCalls: 0 };

  const parts: string[] = [];
  const vars: Record<string, string> = {};
  slice.forEach((full, i) => {
    const [owner, name] = full.split("/");
    if (!owner || !name) return;
    vars[`o${i}`] = owner;
    vars[`n${i}`] = name;
    parts.push(`
      r${i}: repository(owner: $o${i}, name: $n${i}) {
        nameWithOwner
        pullRequests(first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes { ${REPO_PULLS_FRAGMENT} }
        }
      }`);
  });

  const varDecls = Object.keys(vars)
    .map((k) => `$${k}: String!`)
    .join(", ");
  const query = `query(${varDecls}) { ${parts.join("\n")} }`;

  const data = await githubGraphql<
    Record<
      string,
      {
        nameWithOwner: string;
        pullRequests: { nodes: GqlPullNode[] };
      } | null
    >
  >(token, query, vars);

  const out: GhPrWithRepo[] = [];
  for (let i = 0; i < slice.length; i++) {
    const block = data[`r${i}`];
    if (!block) continue;
    const full = block.nameWithOwner || slice[i]!;
    for (const node of block.pullRequests?.nodes ?? []) {
      if (node.updatedAt < sinceIso) break; // sorted DESC
      out.push({ ...gqlNodeToPr(node), repo_full_name: full });
    }
  }
  return { pulls: out, httpCalls: 1 };
}

/** Cap repo listing — settings UI only needs a page or two (not every install repo forever). */
export async function listInstallationRepos(
  token: string,
): Promise<Array<{ full_name: string; private: boolean }>> {
  const out: Array<{ full_name: string; private: boolean }> = [];
  let page = 1;
  const maxPages = 2; // 200 repos max — enough for picker; avoids waste
  while (page <= maxPages) {
    const res = await fetch(
      `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "agmux-teams",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!res.ok) {
      throw new HttpError(502, `GitHub list repos failed (${res.status}).`, "github_list_failed");
    }
    const body = (await res.json()) as {
      repositories?: Array<{ full_name: string; private: boolean }>;
    };
    const repos = body.repositories ?? [];
    out.push(...repos.map((r) => ({ full_name: r.full_name, private: r.private })));
    if (repos.length < 100) break;
    page += 1;
  }
  return out;
}

export async function getInstallation(
  env: Env,
  installationId: string,
): Promise<{ id: number; account: { login: string; type: string } }> {
  const jwt = await appJwt(env);
  const res = await fetch(`https://api.github.com/app/installations/${installationId}`, {
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "user-agent": "agmux-teams",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new HttpError(502, `GitHub installation lookup failed (${res.status}).`, "github_install_failed");
  }
  return (await res.json()) as { id: number; account: { login: string; type: string } };
}

export function isBotUser(user: { login: string; type?: string } | null): boolean {
  if (!user) return true;
  if (user.type === "Bot") return true;
  const login = user.login.toLowerCase();
  return (
    login.endsWith("[bot]") ||
    login === "dependabot" ||
    login === "dependabot[bot]" ||
    login === "github-actions" ||
    login === "github-actions[bot]" ||
    login === "renovate" ||
    login === "renovate[bot]"
  );
}

/** Key for PR complexity maps: `owner/repo#number` (lowercased full name). */
export function prComplexityKey(repoFullName: string, prNumber: number): string {
  return `${repoFullName.toLowerCase()}#${prNumber}`;
}

/**
 * NenuAI: batch-read each PR's GitHub Project "Size" (complexity) via
 * projectItems.fieldValueByName. Requires the installation to have Projects read.
 *
 * Chunked multi-alias GraphQL (≤25 PRs / request) — no N+1, stays under
 * Workers subrequest budgets for a typical 2-week window.
 *
 * Returns map key → points. Missing Size → omitted (caller falls back to LOC).
 * On permission / GraphQL failure, returns empty map (sync still succeeds).
 */
export async function fetchPrComplexityPoints(
  token: string,
  prs: Array<{ repo_full_name: string; number: number }>,
  complexityPointsFromSize: (size: string | null | undefined) => number | null,
): Promise<{ map: Map<string, number>; httpCalls: number; error?: string }> {
  const map = new Map<string, number>();
  if (!prs.length) return { map, httpCalls: 0 };

  // Dedupe by key; keep stable order.
  const seen = new Set<string>();
  const unique: Array<{ owner: string; name: string; number: number; key: string }> = [];
  for (const p of prs) {
    const key = prComplexityKey(p.repo_full_name, p.number);
    if (seen.has(key)) continue;
    seen.add(key);
    const [owner, name] = p.repo_full_name.split("/");
    if (!owner || !name || !Number.isFinite(p.number)) continue;
    unique.push({ owner, name, number: p.number, key });
  }

  const CHUNK = 25;
  let httpCalls = 0;
  let lastError: string | undefined;

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const varDecls: string[] = [];
    const fields: string[] = [];
    const vars: Record<string, string | number> = {};

    chunk.forEach((p, j) => {
      varDecls.push(`$o${j}: String!`, `$n${j}: String!`, `$p${j}: Int!`);
      vars[`o${j}`] = p.owner;
      vars[`n${j}`] = p.name;
      vars[`p${j}`] = p.number;
      // projectItems may include multiple boards; take first non-empty Size.
      fields.push(`
        i${j}: repository(owner: $o${j}, name: $n${j}) {
          pullRequest(number: $p${j}) {
            projectItems(first: 10) {
              nodes {
                size: fieldValueByName(name: "Size") {
                  ... on ProjectV2ItemFieldSingleSelectValue { name }
                }
              }
            }
          }
        }`);
    });

    const query = `query(${varDecls.join(", ")}) { ${fields.join("\n")} }`;
    httpCalls += 1;
    try {
      type ItemNode = { size?: { name?: string } | null };
      type ChunkData = Record<
        string,
        {
          pullRequest?: {
            projectItems?: { nodes?: ItemNode[] };
          } | null;
        } | null
      >;
      const data = await githubGraphql<ChunkData>(token, query, vars);
      chunk.forEach((p, j) => {
        const nodes = data[`i${j}`]?.pullRequest?.projectItems?.nodes ?? [];
        for (const node of nodes) {
          const pts = complexityPointsFromSize(node.size?.name);
          if (pts != null) {
            map.set(p.key, pts);
            break;
          }
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "complexity fetch failed";
      lastError = msg.slice(0, 160);
      // Soft-fail the rest: LOC fallback still ranks the board.
      break;
    }
  }

  return { map, httpCalls, error: lastError };
}
