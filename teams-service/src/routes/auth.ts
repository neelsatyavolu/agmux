import type { Env } from "../env";
import { avatarColor, mintToken, newId, sha256, timingSafeEqual } from "../crypto";
import { nowIso } from "../db";
import {
  badRequest,
  clearedSessionCookie,
  conflict,
  json,
  notFound,
  parseCookies,
  readJson,
  redirect,
  sessionCookie,
  unauthorized,
} from "../http";
import { resolveAvatarUrl, sanitizeAvatarUrl } from "../avatar";
import { authorizeUrl, fetchProfile, isOAuthProvider, type OAuthProfile, type OAuthProvider } from "../oauth";
import {
  SESSION_MAX_AGE,
  attachLinkCode,
  authenticate,
  claimLinkCode,
  createLinkCode,
  createSession,
  destroySession,
} from "../session";

const STATE_COOKIE = "__Host-agmux_oauth";

interface StateBlob {
  nonce: string;
  provider: OAuthProvider;
  next: string;
  /** When set, attach this provider identity to the existing user (no new user row). */
  linkUserId?: string;
}

const stateCookie = (blob: StateBlob): string =>
  `${STATE_COOKIE}=${encodeURIComponent(JSON.stringify(blob))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=900`;

/** Only same-origin relative paths may be used as a post-login destination. */
function safeNext(raw: string | null): string {
  // Must be an absolute path whose second character is neither `/` nor `\`.
  // Browsers normalize `\` to `/`, so `/\evil.com` (and `//evil.com`) would
  // otherwise redirect off-origin.
  if (!raw || !/^\/[^/\\]/.test(raw)) return "/teams";
  return raw;
}

export async function startOAuth(req: Request, env: Env, provider: string): Promise<Response> {
  if (!isOAuthProvider(provider)) throw notFound();
  const url = new URL(req.url);
  const blob: StateBlob = {
    nonce: mintToken(16),
    provider,
    next: safeNext(url.searchParams.get("next")),
  };

  // Link a second provider to the signed-in account (leaderboard GitHub requirement).
  if (url.searchParams.get("intent") === "link") {
    const principal = await authenticate(req, env);
    if (!principal) throw unauthorized("Sign in first, then link this account.");
    blob.linkUserId = principal.userId;
    blob.next = safeNext(url.searchParams.get("next") || "/#/teams");
  }

  return redirect(authorizeUrl(env, provider, blob.nonce), { "set-cookie": stateCookie(blob) });
}

export async function oauthCallback(req: Request, env: Env, provider: string): Promise<Response> {
  if (!isOAuthProvider(provider)) throw notFound();
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw badRequest("Sign-in was cancelled or incomplete.");

  const raw = parseCookies(req.headers.get("cookie"))[STATE_COOKIE];
  if (!raw) throw badRequest("Sign-in took too long — please try again.");
  let blob: StateBlob;
  try {
    blob = JSON.parse(raw) as StateBlob;
  } catch {
    throw badRequest("Sign-in state was malformed — please try again.");
  }
  if (blob.provider !== provider || !timingSafeEqual(blob.nonce, state)) {
    throw badRequest("Sign-in state didn't match — please try again.");
  }

  const profile = await fetchProfile(env, provider, code);

  if (blob.linkUserId) {
    try {
      await linkIdentity(env, blob.linkUserId, provider, profile);
    } catch (err) {
      const msg =
        err instanceof Error && "status" in err
          ? (err as { message: string }).message
          : "Could not link that account.";
      const dest = `${env.APP_ORIGIN}/#/teams?link_error=${encodeURIComponent(msg)}`;
      const headers = new Headers({ location: dest });
      headers.append("set-cookie", `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
      return new Response(null, { status: 302, headers });
    }
    // Keep existing session if present; otherwise mint one for the linked user.
    const existingSession = parseCookies(req.headers.get("cookie"))["__Host-agmux_teams"];
    const token = existingSession || (await createSession(env, blob.linkUserId));
    const headers = new Headers({ location: blob.next.startsWith("http") ? blob.next : blob.next });
    if (!existingSession) headers.append("set-cookie", sessionCookie(token, SESSION_MAX_AGE));
    headers.append("set-cookie", `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    // Fix next: hash routes often stored as /#/… which is fine as relative location.
    headers.set("location", blob.next.startsWith("/") ? blob.next : `/${blob.next}`);
    return new Response(null, { status: 302, headers });
  }

  const userId = await upsertUser(env, provider, profile);

  // Device linking happens only through the authenticated `deviceAttach` path
  // (POST /api/auth/device/attach), never as an unconfirmed side effect of a
  // `?link=` query param on the OAuth callback — that was a one-click
  // account-takeover primitive.

  const token = await createSession(env, userId);
  const headers = new Headers({ location: blob.next });
  headers.append("set-cookie", sessionCookie(token, SESSION_MAX_AGE));
  headers.append("set-cookie", `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return new Response(null, { status: 302, headers });
}

/**
 * Attach provider identity to an existing user. Refuses if that identity is on
 * another user. Idempotent when already on this user.
 */
async function linkIdentity(
  env: Env,
  userId: string,
  provider: OAuthProvider,
  profile: OAuthProfile,
): Promise<void> {
  const avatarUrl = sanitizeAvatarUrl(profile.avatarUrl);
  const existing = await env.DB.prepare(
    "SELECT user_id FROM identities WHERE provider = ? AND provider_user_id = ?",
  )
    .bind(provider, profile.providerUserId)
    .first<{ user_id: string }>();

  if (existing) {
    if (existing.user_id === userId) {
      await env.DB.prepare(
        "UPDATE users SET display_name = COALESCE(?, display_name), email = COALESCE(?, email), handle = COALESCE(?, handle), avatar_url = COALESCE(?, avatar_url) WHERE id = ?",
      )
        .bind(profile.displayName, profile.email, profile.handle, avatarUrl, userId)
        .run();
      return;
    }
    throw conflict("This GitHub account is already linked to another Teams user.");
  }

  // Same provider already on this user under a different id? Replace not supported — error.
  const sameProvider = await env.DB.prepare(
    "SELECT provider_user_id FROM identities WHERE provider = ? AND user_id = ?",
  )
    .bind(provider, userId)
    .first<{ provider_user_id: string }>();
  if (sameProvider && sameProvider.provider_user_id !== profile.providerUserId) {
    throw conflict(`This account already has a different ${provider} identity linked.`);
  }

  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO identities (provider, provider_user_id, user_id, created_at) VALUES (?, ?, ?, ?)",
    ).bind(provider, profile.providerUserId, userId, now),
    env.DB.prepare(
      "UPDATE users SET display_name = COALESCE(?, display_name), email = COALESCE(?, email), handle = COALESCE(?, handle), avatar_url = COALESCE(?, avatar_url) WHERE id = ?",
    ).bind(profile.displayName, profile.email, profile.handle, avatarUrl, userId),
  ]);
}

async function upsertUser(env: Env, provider: OAuthProvider, profile: OAuthProfile): Promise<string> {
  const avatarUrl = sanitizeAvatarUrl(profile.avatarUrl);
  const existing = await env.DB.prepare(
    "SELECT user_id FROM identities WHERE provider = ? AND provider_user_id = ?",
  )
    .bind(provider, profile.providerUserId)
    .first<{ user_id: string }>();

  if (existing) {
    await env.DB.prepare(
      "UPDATE users SET display_name = ?, email = COALESCE(?, email), handle = COALESCE(?, handle), avatar_url = COALESCE(?, avatar_url) WHERE id = ?",
    )
      .bind(profile.displayName, profile.email, profile.handle, avatarUrl, existing.user_id)
      .run();
    return existing.user_id;
  }

  const userId = newId("usr");
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, display_name, email, handle, avatar_color, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(userId, profile.displayName, profile.email, profile.handle, avatarColor(userId), avatarUrl, now),
    env.DB.prepare(
      "INSERT INTO identities (provider, provider_user_id, user_id, created_at) VALUES (?, ?, ?, ?)",
    ).bind(provider, profile.providerUserId, userId, now),
  ]);
  return userId;
}

export async function logout(req: Request, env: Env): Promise<Response> {
  const token = parseCookies(req.headers.get("cookie"))["__Host-agmux_teams"];
  if (token) await destroySession(env, token);
  return json({ signedOut: true }, { headers: { "set-cookie": clearedSessionCookie } });
}

export async function me(req: Request, env: Env): Promise<Response> {
  const principal = await authenticate(req, env);
  if (!principal) return json({ user: null });
  const user = await env.DB.prepare(
    "SELECT id, display_name, email, handle, avatar_color, avatar_url FROM users WHERE id = ?",
  )
    .bind(principal.userId)
    .first<{
      id: string;
      display_name: string;
      email: string | null;
      handle: string | null;
      avatar_color: string;
      avatar_url: string | null;
    }>();
  const ids = await env.DB.prepare(
    "SELECT provider, provider_user_id FROM identities WHERE user_id = ?",
  )
    .bind(principal.userId)
    .all<{ provider: string; provider_user_id: string }>();
  const idRows = ids.results ?? [];
  const providers = idRows.map((r) => r.provider);
  const githubId = idRows.find((r) => r.provider === "github")?.provider_user_id ?? null;
  return json({
    user: user
      ? {
          ...user,
          avatar_url: resolveAvatarUrl(user.avatar_url, githubId),
        }
      : null,
    via: principal.via,
    deviceId: principal.deviceId,
    providers,
    hasGithub: providers.includes("github"),
  });
}

/** Desktop step 1: mint a one-shot code and hand back the sign-in URL to open. */
export async function deviceStart(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ deviceId?: string; label?: string }>(req);
  const deviceId = (body.deviceId ?? "").trim();
  if (!deviceId) throw badRequest("deviceId is required.");
  const label = (body.label ?? "").slice(0, 80) || null;
  const code = await createLinkCode(env, deviceId.slice(0, 80), label);
  const qs = new URLSearchParams({ code, next: "/link-complete" });
  if (label) qs.set("label", label);
  return json({
    code,
    // The app opens this; the user picks GitHub or Google on the web page.
    // `label` is shown on the confirm step before attach (not auto-linked).
    url: `${env.APP_ORIGIN}/link?${qs.toString()}`,
    expiresInSeconds: 1800,
  });
}

/**
 * Binds a pending device-link code to the signed-in user.
 *
 * The `/link` page calls this after sign-in. Doing it here rather than
 * threading a `?link=` parameter through the whole OAuth round trip means the
 * link cannot be silently lost by a redirect that drops the query — which is
 * exactly how this broke before. Idempotent and safe: it only fills in
 * `user_id` on a code that is still unclaimed and unexpired.
 */
export async function deviceAttach(req: Request, env: Env): Promise<Response> {
  const principal = await authenticate(req, env);
  if (!principal) throw unauthorized("Sign in first, then reopen the link from agmux.");

  const body = await readJson<{ code?: string }>(req);
  const code = (body.code ?? "").trim();
  if (!code) throw badRequest("code is required.");

  const attached = await attachLinkCode(env, code, principal.userId);
  if (!attached) {
    throw badRequest(
      "That link request has expired or was already used. Click Sign in again in agmux.",
    );
  }
  return json({ attached: true });
}

/** Desktop step 2: poll until the browser half completes, then take the token. */
export async function deviceClaim(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ code?: string }>(req);
  const code = (body.code ?? "").trim();
  if (!code) throw badRequest("code is required.");
  const token = await claimLinkCode(env, code);
  if (!token) return json({ pending: true, token: null });

  const row = await env.DB.prepare(
    `SELECT u.id, u.display_name, u.email, u.handle, u.avatar_color, u.avatar_url,
            (SELECT i.provider_user_id FROM identities i
             WHERE i.user_id = u.id AND i.provider = 'github' LIMIT 1) AS github_id
     FROM device_tokens d JOIN users u ON u.id = d.user_id
     WHERE d.token_hash = ?`,
  )
    .bind(await sha256(token))
    .first<{
      id: string;
      display_name: string;
      email: string | null;
      handle: string | null;
      avatar_color: string;
      avatar_url: string | null;
      github_id: string | null;
    }>();
  if (!row) return json({ pending: false, token, user: null });
  const { github_id, avatar_url, ...rest } = row;
  return json({
    pending: false,
    token,
    user: { ...rest, avatar_url: resolveAvatarUrl(avatar_url, github_id) },
  });
}

export async function deviceRevoke(req: Request, env: Env): Promise<Response> {
  const principal = await authenticate(req, env);
  if (!principal) throw unauthorized();
  const body = await readJson<{ deviceId?: string }>(req);
  const deviceId = (body.deviceId ?? principal.deviceId ?? "").trim();
  if (!deviceId) throw badRequest("deviceId is required.");
  await env.DB.prepare(
    "UPDATE device_tokens SET revoked_at = ? WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL",
  )
    .bind(nowIso(), principal.userId, deviceId)
    .run();
  return json({ revoked: true });
}
