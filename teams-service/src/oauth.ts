/**
 * GitHub + Google authorization-code flow. We ask for the minimum: identity and
 * a verified email. No repo scopes, no Drive scopes, nothing that could read code.
 */
import { sanitizeAvatarUrl } from "./avatar";
import type { Env } from "./env";
import { HttpError, badRequest } from "./http";

export type OAuthProvider = "github" | "google";

export interface OAuthProfile {
  providerUserId: string;
  displayName: string;
  email: string | null;
  handle: string | null;
  /** https URL of the provider profile photo, or null. */
  avatarUrl: string | null;
}

export function isOAuthProvider(v: string): v is OAuthProvider {
  return v === "github" || v === "google";
}

function creds(env: Env, provider: OAuthProvider): { id: string; secret: string } {
  const id = provider === "github" ? env.GITHUB_CLIENT_ID : env.GOOGLE_CLIENT_ID;
  const secret = provider === "github" ? env.GITHUB_CLIENT_SECRET : env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) {
    throw new HttpError(503, `${provider} sign-in isn't configured on this server.`, "oauth_unconfigured");
  }
  return { id, secret };
}

export function redirectUri(env: Env, provider: OAuthProvider): string {
  return `${env.APP_ORIGIN}/api/auth/${provider}/callback`;
}

export function authorizeUrl(env: Env, provider: OAuthProvider, state: string): string {
  const { id } = creds(env, provider);
  if (provider === "github") {
    const p = new URLSearchParams({
      client_id: id,
      redirect_uri: redirectUri(env, provider),
      scope: "read:user user:email",
      state,
allow_signup: "true",
    });
    return `https://github.com/login/oauth/authorize?${p}`;
  }
  const p = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(env, provider),
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function exchange(env: Env, provider: OAuthProvider, code: string): Promise<string> {
  const { id, secret } = creds(env, provider);
  const url =
    provider === "github"
      ? "https://github.com/login/oauth/access_token"
      : "https://oauth2.googleapis.com/token";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      code,
      redirect_uri: redirectUri(env, provider),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw badRequest("Sign-in failed — the provider rejected the code.");
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!body.access_token) throw badRequest("Sign-in failed — no access token returned.");
  return body.access_token;
}

export async function fetchProfile(
  env: Env,
  provider: OAuthProvider,
  code: string,
): Promise<OAuthProfile> {
  const token = await exchange(env, provider, code);
  const headers = { authorization: `Bearer ${token}`, "user-agent": "agmux-teams" };

  if (provider === "github") {
    const userRes = await fetch("https://api.github.com/user", { headers });
    if (!userRes.ok) throw badRequest("Couldn't read your GitHub profile.");
    const u = (await userRes.json()) as {
      id: number;
      login: string;
      name: string | null;
      email: string | null;
      avatar_url?: string | null;
    };
    let email = u.email;
    if (!email) {
      const emailsRes = await fetch("https://api.github.com/user/emails", { headers });
      if (emailsRes.ok) {
        const list = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[];
        email = list.find((e) => e.primary && e.verified)?.email ?? null;
      }
    }
    return {
      providerUserId: String(u.id),
      displayName: u.name || u.login,
      email,
      handle: u.login,
      avatarUrl: sanitizeAvatarUrl(u.avatar_url),
    };
  }

  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers });
  if (!res.ok) throw badRequest("Couldn't read your Google profile.");
  const u = (await res.json()) as {
    sub: string;
    name?: string;
    email?: string;
    email_verified?: boolean;
    picture?: string;
  };
  return {
    providerUserId: u.sub,
    displayName: u.name || u.email || "agmux user",
    email: u.email_verified ? (u.email ?? null) : null,
    handle: u.email ? u.email.split("@")[0]! : null,
    avatarUrl: sanitizeAvatarUrl(u.picture),
  };
}
