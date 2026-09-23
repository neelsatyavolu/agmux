import type { Env } from "../env";
import { devEnabled } from "../env";
import { mintToken, timingSafeEqual } from "../crypto";
import { isOwnerGithubLogin } from "../staff";
import { authorizeUrl, fetchGithubLogin, githubConfigured } from "../oauth";
import { SESSION_MAX_AGE, authenticate, createSession, destroySession } from "../session";
import {
  badRequest,
  clearedSessionCookie,
  forbidden,
  json,
  parseCookies,
  readJson,
  redirect,
  sessionCookie,
  SESSION_COOKIE,
} from "../http";

const STATE_COOKIE = "__Host-agmux_oauth";

const clearedState = `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function authMethods(env: Env) {
  return {
    github: githubConfigured(env),
    password: Boolean(env.OWNER_PASSWORD),
    dev: devEnabled(env),
  };
}

export async function me(req: Request, env: Env): Promise<Response> {
  const principal = await authenticate(req, env);
  return json({
    user: principal ? { githubLogin: principal.githubLogin } : null,
    auth: authMethods(env),
  });
}

export async function startGithub(req: Request, env: Env): Promise<Response> {
  if (!githubConfigured(env)) throw badRequest("GitHub sign-in isn't configured.");
  const nonce = mintToken(16);
  const url = new URL(req.url);
  const next = url.searchParams.get("next");
  // Encode next in the nonce cookie JSON so we don't put it on GitHub state.
  const blob = JSON.stringify({ nonce, next: next && next.startsWith("/") ? next : "/" });
  return redirect(authorizeUrl(env, nonce), {
    "set-cookie": `${STATE_COOKIE}=${encodeURIComponent(blob)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=900`,
  });
}

export async function githubCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw badRequest("Sign-in was cancelled or incomplete.");

  const raw = parseCookies(req.headers.get("cookie"))[STATE_COOKIE];
  if (!raw) throw badRequest("Sign-in took too long — please try again.");
  let blob: { nonce: string; next?: string };
  try {
    blob = JSON.parse(raw) as { nonce: string; next?: string };
  } catch {
    throw badRequest("Sign-in state was malformed — please try again.");
  }
  if (!timingSafeEqual(blob.nonce, state)) {
    throw badRequest("Sign-in state didn't match — please try again.");
  }

  const login = await fetchGithubLogin(env, code);
  if (!isOwnerGithubLogin(login)) {
    const headers = new Headers({ location: "/?denied=1" });
    headers.append("set-cookie", clearedState);
    return new Response(null, { status: 302, headers });
  }

  const token = await createSession(env, login);
  const dest = blob.next && blob.next.startsWith("/") ? blob.next : "/";
  const headers = new Headers({ location: dest });
  headers.append("set-cookie", sessionCookie(token, SESSION_MAX_AGE));
  headers.append("set-cookie", clearedState);
  return new Response(null, { status: 302, headers });
}

export async function passwordLogin(req: Request, env: Env): Promise<Response> {
  if (!env.OWNER_PASSWORD) throw badRequest("Password sign-in isn't configured.");
  const body = await readJson<{ password?: string }>(req);
  const password = typeof body.password === "string" ? body.password : "";
  if (!timingSafeEqual(password, env.OWNER_PASSWORD)) {
    throw forbidden("Wrong password.");
  }
  const token = await createSession(env, "password");
  return json(
    { githubLogin: "password" },
    { headers: { "set-cookie": sessionCookie(token, SESSION_MAX_AGE) } },
  );
}

export async function devLogin(_req: Request, env: Env): Promise<Response> {
  if (!devEnabled(env)) throw badRequest("Dev sign-in is off.");
  const token = await createSession(env, "neelsatyavolu");
  return json(
    { githubLogin: "neelsatyavolu" },
    { headers: { "set-cookie": sessionCookie(token, SESSION_MAX_AGE) } },
  );
}

export async function logout(req: Request, env: Env): Promise<Response> {
  const cookie = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
  if (cookie) await destroySession(env, cookie);
  return json({ ok: true }, { headers: { "set-cookie": clearedSessionCookie } });
}
