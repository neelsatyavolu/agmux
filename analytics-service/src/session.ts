import type { Env } from "./env";
import { mintToken, sha256, timingSafeEqual } from "./crypto";
import { nowIso } from "./validate";
import { parseCookies, SESSION_COOKIE, unauthorized } from "./http";

const SESSION_DAYS = 30;
export const SESSION_MAX_AGE = SESSION_DAYS * 86_400;

export interface Principal {
  githubLogin: string;
}

export async function createSession(env: Env, githubLogin: string): Promise<string> {
  const token = mintToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, github_login, created_at, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(await sha256(token), githubLogin, nowIso(), expires)
    .run();
  return token;
}

export async function destroySession(env: Env, token: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(await sha256(token))
    .run();
}

export async function authenticate(req: Request, env: Env): Promise<Principal | null> {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ") && env.ADMIN_TOKEN) {
    const raw = auth.slice(7).trim();
    if (timingSafeEqual(raw, env.ADMIN_TOKEN)) return { githubLogin: "admin-token" };
  }

  const cookie = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
  if (!cookie) return null;
  const row = await env.DB.prepare(
    "SELECT github_login, expires_at FROM sessions WHERE token_hash = ?",
  )
    .bind(await sha256(cookie))
    .first<{ github_login: string; expires_at: string }>();
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  return { githubLogin: row.github_login };
}

export async function requirePrincipal(req: Request, env: Env): Promise<Principal> {
  const p = await authenticate(req, env);
  if (!p) throw unauthorized();
  return p;
}
