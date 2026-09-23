/**
 * Dev-only routes. Every handler calls `requireDev` first, which needs both
 * `DEV_AUTH=true` and a localhost request — see `src/dev.ts`.
 */
import type { Env } from "../env";
import { avatarColor, newId } from "../crypto";
import { getActiveMembership, getTeamBySlugOrId, nowIso, type Role } from "../db";
import { badRequest, json, notFound, readJson, sessionCookie } from "../http";
import {
  SESSION_MAX_AGE,
  attachLinkCode,
  authenticate,
  createDeviceToken,
  createSession,
} from "../session";
import { SEED_CAST, applySeed, devEnabled, requireDev } from "../dev";

/** Advertises dev mode to the SPA so it can show the dev banner. */
export async function devStatus(req: Request, env: Env): Promise<Response> {
  if (!devEnabled(env, req)) return json({ enabled: false });
  const principal = await authenticate(req, env);
  const team = await getTeamBySlugOrId(env, "helios-platform");

  let role: Role | null = null;
  if (principal && team) {
    const membership = await getActiveMembership(env, team.id, principal.userId);
    role = membership?.role ?? null;
  }

  const seeded = team
    ? await env.DB.prepare("SELECT COUNT(*) AS n FROM metric_hourly WHERE team_id = ?")
        .bind(team.id)
        .first<{ n: number }>()
    : null;

  return json({
    enabled: true,
    signedIn: Boolean(principal),
    seeded: (seeded?.n ?? 0) > 0,
    teamSlug: team?.slug ?? null,
    role,
    cast: SEED_CAST.map((p) => ({ key: p.key, name: p.name, role: p.role })),
  });
}

/**
 * Signs you in as a fake user with no OAuth round-trip. Reuses the same user
 * row every time so seeded history stays attached to you.
 */
export async function devLogin(req: Request, env: Env): Promise<Response> {
  requireDev(env, req);
  const body = await readJson<{ name?: string; linkCode?: string }>(req).catch(
    () => ({}) as { name?: string; linkCode?: string },
  );
  const name = (body.name ?? "You").trim().slice(0, 60) || "You";
  const handle = "you";

  let user = await env.DB.prepare("SELECT id FROM users WHERE handle = ?")
    .bind(handle)
    .first<{ id: string }>();

  if (!user) {
    const id = newId("usr");
    await env.DB.prepare(
      "INSERT INTO users (id, display_name, email, handle, avatar_color, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(id, name, "you@localhost", handle, avatarColor(handle), null, nowIso())
      .run();
    user = { id };
  } else {
    await env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?").bind(name, user.id).run();
  }

  // When the desktop app sent us here, complete its half of the device link —
  // this is what the OAuth callback normally does.
  let linked = false;
  if (body.linkCode) linked = await attachLinkCode(env, body.linkCode, user.id);

  const token = await createSession(env, user.id);
  return json(
    { userId: user.id, name, linked },
    { headers: { "set-cookie": sessionCookie(token, SESSION_MAX_AGE) } },
  );
}

/** Creates the demo team and 90 days of believable metrics. */
export async function devSeed(req: Request, env: Env): Promise<Response> {
  requireDev(env, req);
  const principal = await authenticate(req, env);
  if (!principal) throw badRequest("Sign in with dev login first.");

  const body = await readJson<{ days?: number }>(req).catch(() => ({}) as { days?: number });
  const days = Math.min(180, Math.max(7, Math.trunc(body.days ?? 90)));

  const result = await applySeed(env, principal.userId, days);
  return json(result);
}

/**
 * Flips your own role on the demo team, so one person can see the owner,
 * manager and employee views without a second account.
 */
export async function devSwitchRole(req: Request, env: Env): Promise<Response> {
  requireDev(env, req);
  const principal = await authenticate(req, env);
  if (!principal) throw badRequest("Sign in with dev login first.");

  const body = await readJson<{ role?: string }>(req);
  const role = body.role as Role | undefined;
  if (!role || !["owner", "manager", "employee"].includes(role)) {
    throw badRequest("role must be owner, manager, or employee.");
  }

  const team = await getTeamBySlugOrId(env, "helios-platform");
  if (!team) throw notFound("Seed the demo team first.");

  await env.DB.prepare(
    "UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?",
  )
    .bind(role, team.id, principal.userId)
    .run();

  // A team must always have an owner; hand it to Marcus while you play manager.
  if (role !== "owner") {
    const owners = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND role = 'owner' AND left_at IS NULL",
    )
      .bind(team.id)
      .first<{ n: number }>();
    if ((owners?.n ?? 0) === 0) {
      await env.DB.prepare(
        `UPDATE team_members SET role = 'owner'
         WHERE team_id = ? AND user_id = (
           SELECT user_id FROM team_members m JOIN users u ON u.id = m.user_id
           WHERE m.team_id = ? AND u.handle = 'mwebb' LIMIT 1)`,
      )
        .bind(team.id, team.id)
        .run();
    }
  }

  return json({ role });
}

/** Mints a device token directly, for wiring the desktop app up locally. */
export async function devDeviceToken(req: Request, env: Env): Promise<Response> {
  requireDev(env, req);
  const principal = await authenticate(req, env);
  if (!principal) throw badRequest("Sign in with dev login first.");

  const body = await readJson<{ deviceId?: string }>(req).catch(
    () => ({}) as { deviceId?: string },
  );
  const deviceId = (body.deviceId ?? "dev-desktop").trim().slice(0, 80);
  const token = await createDeviceToken(env, principal.userId, deviceId, "dev desktop");
  return json({ token, deviceId, baseUrl: env.APP_ORIGIN });
}

/** Wipes everything so you can start over. */
export async function devReset(req: Request, env: Env): Promise<Response> {
  requireDev(env, req);
  for (const table of [
    "metric_hourly",
    "upload_receipts",
    "sync_state",
    "invites",
    "team_members",
    "teams",
    "device_link_codes",
    "device_tokens",
    "sessions",
    "identities",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  return json({ reset: true });
}
