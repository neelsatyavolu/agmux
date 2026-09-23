export interface Env {
  DB: D1Database;
  SUPPORT_FILES?: R2Bucket;
  ASSETS: Fetcher;
  APP_ORIGIN: string;
  /** "true" only via the `dev` npm script. Never set by `wrangler deploy`. */
  DEV_AUTH?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Optional password for the owner dashboard. */
  OWNER_PASSWORD?: string;
  /** Optional Bearer token for GET /api/summary. */
  ADMIN_TOKEN?: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host) || host.endsWith(".localhost");
}

/** DEV_AUTH=true AND APP_ORIGIN is localhost. wrangler deploy sets neither. */
export function devEnabled(env: Env): boolean {
  if (String(env.DEV_AUTH) !== "true") return false;
  try {
    return isLocalHost(new URL(env.APP_ORIGIN).hostname);
  } catch {
    return false;
  }
}
