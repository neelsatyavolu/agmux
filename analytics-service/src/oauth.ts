import type { Env } from "./env";
import { HttpError, badRequest } from "./http";

export function githubConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

function creds(env: Env): { id: string; secret: string } {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new HttpError(503, "GitHub sign-in isn't configured on this server.", "oauth_unconfigured");
  }
  return { id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET };
}

export function redirectUri(env: Env): string {
  return `${env.APP_ORIGIN}/api/auth/github/callback`;
}

export function authorizeUrl(env: Env, state: string): string {
  const { id } = creds(env);
  const p = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(env),
    scope: "read:user",
    state,
    allow_signup: "false",
  });
  return `https://github.com/login/oauth/authorize?${p}`;
}

export async function fetchGithubLogin(env: Env, code: string): Promise<string> {
  const { id, secret } = creds(env);
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      code,
      redirect_uri: redirectUri(env),
    }),
  });
  if (!tokenRes.ok) throw badRequest("Sign-in failed — the provider rejected the code.");
  const tokenBody = (await tokenRes.json()) as { access_token?: string };
  if (!tokenBody.access_token) throw badRequest("Sign-in failed — no access token returned.");

  const userRes = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${tokenBody.access_token}`, "user-agent": "agmux-owner" },
  });
  if (!userRes.ok) throw badRequest("Couldn't read your GitHub profile.");
  const u = (await userRes.json()) as { login?: string };
  if (!u.login) throw badRequest("GitHub profile had no login.");
  return u.login;
}
