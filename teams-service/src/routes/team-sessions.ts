/**
 * Team sessions. Members opt in per team; an opted-in desktop reports its live agent
 * sessions, and opted-in teammates' agents (through consult) can list them, ask a
 * read-only copy of one, or message one when its owner allows messages. The owner's
 * desktop does the work: it claims requests from its inbox, runs them locally and
 * posts the result. Question text is dropped once claimed and an answer once read.
 */
import type { Env } from "../env";
import type { Principal } from "../session";
import { requireTeam, type TeamContext } from "../authz";
import { HttpError, badRequest, forbidden, notFound, json, readJson } from "../http";
import { newId, sha256 } from "../crypto";
import { writeAudit } from "./audit";

/** A session counts as live while its desktop reported it this recently (seconds). */
export const LIVE_TTL = 120;
/** Unclaimed requests fail after this; a desktop that is online claims within seconds. */
export const PENDING_TTL = 120;
/** A claimed request fails after this (asks replay a whole conversation). */
export const CLAIMED_TTL = 20 * 60;
/** Finished requests the asker never read are purged after this. */
const KEEP_TTL = 60 * 60;
const MAX_SESSIONS = 50;
const MAX_OPEN_PER_USER = 5;
const MAX_QUESTION = 8_000;
const MAX_MESSAGE = 4_000;
const MAX_ANSWER = 100_000;
const MAX_ERROR = 500;
const KEY = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const STATUSES = new Set(["working", "needs_you", "idle", "done"]);
const EFFORTS = new Set(["low", "medium", "high"]);

const now = () => Math.floor(Date.now() / 1000);
const noStore = (data: unknown, status = 200) => json(data, { status, headers: { "cache-control": "no-store" } });

// C0/C1 controls except tab and newline: none of this text may steer a terminal.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

function text(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw badRequest("Expected text.");
  const trimmed = value.replace(CONTROL, " ").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function requireDevice(principal: Principal): string {
  if (principal.via !== "device" || !principal.deviceId) throw forbidden("Only a linked desktop can do that.");
  return principal.deviceId;
}

interface SharingRow { accept_messages: number }

async function sharing(env: Env, teamId: string, userId: string): Promise<SharingRow | null> {
  return env.DB.prepare("SELECT accept_messages FROM team_session_sharing WHERE team_id = ? AND user_id = ?")
    .bind(teamId, userId)
    .first<SharingRow>();
}

async function requireSharing(env: Env, ctx: TeamContext): Promise<SharingRow> {
  const row = await sharing(env, ctx.team.id, ctx.membership.user_id);
  if (!row) throw new HttpError(403, "Turn on team sessions first: agterm Settings → Teams & Phone.", "sharing_off");
  return row;
}

async function context(env: Env, principal: Principal, key: string): Promise<TeamContext> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  if (ctx.staffPreview) throw notFound("That team doesn't exist.");
  return ctx;
}

// ── sharing ──────────────────────────────────────────────────────────────────

export async function getSharing(env: Env, principal: Principal, key: string): Promise<Response> {
  const ctx = await context(env, principal, key);
  const row = await sharing(env, ctx.team.id, principal.userId);
  return noStore({ enabled: !!row, acceptMessages: !!row?.accept_messages });
}

export async function putSharing(req: Request, env: Env, principal: Principal, key: string): Promise<Response> {
  const ctx = await context(env, principal, key);
  const body = await readJson<{ enabled?: unknown; acceptMessages?: unknown }>(req);
  if (typeof body.enabled !== "boolean") throw badRequest("enabled must be true or false.");
  const accept = body.acceptMessages === true;
  const teamId = ctx.team.id;
  const before = await sharing(env, teamId, principal.userId);
  if (body.enabled) {
    await env.DB.prepare(
      `INSERT INTO team_session_sharing (team_id, user_id, accept_messages, enabled_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (team_id, user_id) DO UPDATE SET accept_messages = excluded.accept_messages`,
    ).bind(teamId, principal.userId, accept ? 1 : 0, now()).run();
    if (!accept) {
      await env.DB.prepare(
        `UPDATE team_session_requests SET status = 'failed', error = 'Its owner stopped accepting messages.', body = '', finished_at = ?
         WHERE team_id = ? AND to_user_id = ? AND kind = 'message' AND status = 'pending'`,
      ).bind(now(), teamId, principal.userId).run();
    }
  } else {
    await env.DB.prepare("DELETE FROM team_session_sharing WHERE team_id = ? AND user_id = ?").bind(teamId, principal.userId).run();
    await env.DB.prepare("DELETE FROM team_live_sessions WHERE team_id = ? AND user_id = ?").bind(teamId, principal.userId).run();
    await env.DB.prepare(
      `UPDATE team_session_requests SET status = 'failed', error = 'Its owner stopped sharing sessions.', body = '', finished_at = ?
       WHERE team_id = ? AND to_user_id = ? AND status IN ('pending', 'claimed')`,
    ).bind(now(), teamId, principal.userId).run();
  }
  if (!!before !== body.enabled) {
    await writeAudit(env, teamId, principal.userId, body.enabled ? "team_sessions.on" : "team_sessions.off", principal.userId);
  }
  return noStore({ enabled: body.enabled, acceptMessages: body.enabled && accept });
}

// ── live sessions ────────────────────────────────────────────────────────────

interface ReportedSession { key: string; agent: string; title: string | null; project: string | null; branch: string | null; status: string; canAsk: boolean }

/** Validates one reported session. `project` keeps only a folder name, never a path. */
export function parseReported(value: unknown): ReportedSession {
  if (!value || typeof value !== "object") throw badRequest("Each session must be an object.");
  const v = value as Record<string, unknown>;
  if (typeof v.key !== "string" || !KEY.test(v.key)) throw badRequest("Session key must be 1–64 letters, digits or dashes.");
  const agent = text(v.agent, 20);
  if (!agent || !/^[a-z0-9-]+$/.test(agent)) throw badRequest("Session agent is required.");
  const status = typeof v.status === "string" && STATUSES.has(v.status) ? v.status : "idle";
  const project = text(v.project, 200)?.split(/[\\/]/).filter(Boolean).pop()?.slice(0, 100) ?? null;
  return { key: v.key, agent, title: text(v.title, 200), project, branch: text(v.branch, 100), status, canAsk: v.canAsk === true };
}

async function publicId(teamId: string, userId: string, deviceId: string, sessionKey: string): Promise<string> {
  return "ts-" + (await sha256(`${teamId}\u0000${userId}\u0000${deviceId}\u0000${sessionKey}`)).slice(0, 20);
}

export async function putLive(req: Request, env: Env, principal: Principal, key: string): Promise<Response> {
  const deviceId = requireDevice(principal);
  const ctx = await context(env, principal, key);
  await requireSharing(env, ctx);
  const body = await readJson<{ sessions?: unknown }>(req);
  if (!Array.isArray(body.sessions)) throw badRequest("sessions must be a list.");
  if (body.sessions.length > MAX_SESSIONS) throw badRequest(`At most ${MAX_SESSIONS} sessions.`);
  const sessions = body.sessions.map(parseReported);
  const teamId = ctx.team.id;
  const at = now();
  const statements = [env.DB.prepare("DELETE FROM team_live_sessions WHERE team_id = ? AND user_id = ? AND device_id = ?")
    .bind(teamId, principal.userId, deviceId)];
  for (const s of sessions) {
    statements.push(env.DB.prepare(
      `INSERT OR REPLACE INTO team_live_sessions
         (team_id, user_id, device_id, session_key, public_id, agent, title, project, branch, status, can_ask, reported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(teamId, principal.userId, deviceId, s.key, await publicId(teamId, principal.userId, deviceId, s.key), s.agent, s.title,
      s.project, s.branch, s.status, s.canAsk ? 1 : 0, at));
  }
  await env.DB.batch(statements);
  return noStore({ count: sessions.length, liveSeconds: LIVE_TTL });
}

interface LiveRow {
  public_id: string; user_id: string; device_id: string; session_key: string; agent: string; title: string | null;
  project: string | null; branch: string | null; status: string; can_ask: number; reported_at: number;
  display_name: string; accept_messages: number;
}

const LIVE_SELECT = `
  SELECT l.public_id, l.user_id, l.device_id, l.session_key, l.agent, l.title, l.project, l.branch, l.status,
         l.can_ask, l.reported_at, u.display_name, s.accept_messages
  FROM team_live_sessions l
  JOIN team_session_sharing s ON s.team_id = l.team_id AND s.user_id = l.user_id
  JOIN team_members m ON m.team_id = l.team_id AND m.user_id = l.user_id AND m.left_at IS NULL
  JOIN users u ON u.id = l.user_id
  WHERE l.team_id = ? AND l.reported_at >= ?`;

const isThisDevice = (r: { user_id: string; device_id: string }, p: Principal) => r.user_id === p.userId && r.device_id === p.deviceId;

export async function listLive(env: Env, principal: Principal, key: string): Promise<Response> {
  const ctx = await context(env, principal, key);
  await requireSharing(env, ctx);
  const rows = await env.DB.prepare(`${LIVE_SELECT} ORDER BY u.display_name COLLATE NOCASE, l.reported_at DESC`)
    .bind(ctx.team.id, now() - LIVE_TTL)
    .all<LiveRow>();
  const sessions = (rows.results ?? [])
    .filter((r) => !isThisDevice(r, principal))
    .map((r) => ({
      session_id: r.public_id,
      member: r.display_name,
      mine: r.user_id === principal.userId,
      agent: r.agent,
      title: r.title,
      project: r.project,
      branch: r.branch,
      status: r.status,
      can_ask: !!r.can_ask,
      accepts_messages: !!r.accept_messages,
      last_reported: new Date(r.reported_at * 1000).toISOString(),
    }));
  return noStore({ sessions });
}

// ── requests ─────────────────────────────────────────────────────────────────

export async function createRequest(req: Request, env: Env, principal: Principal, key: string, sessionId: string): Promise<Response> {
  const ctx = await context(env, principal, key);
  await requireSharing(env, ctx);
  const body = await readJson<{ kind?: unknown; body?: unknown; effort?: unknown }>(req);
  const kind = body.kind;
  if (kind !== "ask" && kind !== "message") throw badRequest("kind must be ask or message.");
  const content = text(body.body, kind === "ask" ? MAX_QUESTION : MAX_MESSAGE);
  if (!content) throw badRequest(kind === "ask" ? "The question is empty." : "The message is empty.");
  if (typeof body.body === "string" && body.body.trim().length > (kind === "ask" ? MAX_QUESTION : MAX_MESSAGE)) {
    throw badRequest(`Keep it under ${kind === "ask" ? MAX_QUESTION : MAX_MESSAGE} characters.`);
  }
  const effort = typeof body.effort === "string" && EFFORTS.has(body.effort) ? body.effort : null;
  const teamId = ctx.team.id;
  const target = await env.DB.prepare(`${LIVE_SELECT} AND l.public_id = ?`).bind(teamId, now() - LIVE_TTL, sessionId).first<LiveRow>();
  if (!target) throw notFound("That session isn't live any more; call list_team_sessions again.");
  if (isThisDevice(target, principal)) throw badRequest("That session is on this Mac; use list_sessions instead.");
  if (kind === "ask" && !target.can_ask) throw badRequest(`A copy of this ${target.agent} session can't be asked; it can only be messaged.`);
  if (kind === "message" && !target.accept_messages) throw forbidden(`${target.display_name} doesn't accept messages into their sessions.`);
  const id = newId("tsr");
  const at = now();
  // One statement, so concurrent requests can't all see room under the cap.
  const inserted = await env.DB.prepare(
    `INSERT INTO team_session_requests
       (id, team_id, from_user_id, to_user_id, to_device_id, session_key, kind, body, effort, status, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?
     WHERE (SELECT COUNT(*) FROM team_session_requests
            WHERE team_id = ? AND from_user_id = ?
              AND ((status = 'pending' AND created_at >= ?) OR (status = 'claimed' AND claimed_at >= ?))) < ?`,
  ).bind(id, teamId, principal.userId, target.user_id, target.device_id, target.session_key, kind, content, effort, at,
    teamId, principal.userId, at - PENDING_TTL, at - CLAIMED_TTL, MAX_OPEN_PER_USER).run();
  if (inserted.meta.changes !== 1) {
    throw new HttpError(429, `You already have ${MAX_OPEN_PER_USER} requests waiting; wait for one to finish.`, "rate_limited");
  }
  await writeAudit(env, teamId, principal.userId, kind === "ask" ? "team_sessions.ask" : "team_sessions.message", target.user_id, target.agent);
  return noStore({ id, member: target.display_name, agent: target.agent }, 201);
}

interface RequestRow { id: string; from_user_id: string; to_device_id: string; status: string; answer: string | null; error: string | null; kind: string }

export async function getRequest(env: Env, principal: Principal, key: string, id: string): Promise<Response> {
  const ctx = await context(env, principal, key);
  await expire(env);
  const row = await env.DB.prepare(
    "SELECT id, from_user_id, to_device_id, status, answer, error, kind FROM team_session_requests WHERE id = ? AND team_id = ?",
  ).bind(id, ctx.team.id).first<RequestRow>();
  if (!row || row.from_user_id !== principal.userId) throw notFound("No such request.");
  const done = row.status === "answered" || row.status === "failed";
  // An answer is handed over once and then dropped.
  if (done) await env.DB.prepare("DELETE FROM team_session_requests WHERE id = ?").bind(id).run();
  return noStore({ id, kind: row.kind, status: row.status, answer: row.answer, error: row.error });
}

/** Fails stale requests and purges old ones and stale sessions; runs on every poll and hourly. */
export async function expire(env: Env, at = now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE team_session_requests SET status = 'failed', body = '', finished_at = ?,
         error = 'Its owner''s Mac didn''t pick this up; it may be asleep or offline.'
       WHERE status = 'pending' AND created_at < ?`,
    ).bind(at, at - PENDING_TTL),
    env.DB.prepare(
      `UPDATE team_session_requests SET status = 'failed', finished_at = ?, error = 'No answer came back in time.'
       WHERE status = 'claimed' AND claimed_at < ?`,
    ).bind(at, at - CLAIMED_TTL),
    env.DB.prepare("DELETE FROM team_session_requests WHERE created_at < ?").bind(at - KEEP_TTL),
    env.DB.prepare("DELETE FROM team_live_sessions WHERE reported_at < ?").bind(at - LIVE_TTL),
  ]);
}

interface InboxRow { id: string; session_key: string; kind: string; body: string; effort: string | null; created_at: number; display_name: string }

/** The calling desktop's new requests, each claimed exactly once. */
export async function claimInbox(env: Env, principal: Principal, key: string): Promise<Response> {
  const deviceId = requireDevice(principal);
  const ctx = await context(env, principal, key);
  await expire(env);
  const rows = await env.DB.prepare(
    `SELECT r.id, r.session_key, r.kind, r.body, r.effort, r.created_at, u.display_name
     FROM team_session_requests r
     JOIN users u ON u.id = r.from_user_id
     JOIN team_session_sharing mine ON mine.team_id = r.team_id AND mine.user_id = r.to_user_id
     JOIN team_session_sharing theirs ON theirs.team_id = r.team_id AND theirs.user_id = r.from_user_id
     JOIN team_members sender ON sender.team_id = r.team_id AND sender.user_id = r.from_user_id AND sender.left_at IS NULL
     WHERE r.team_id = ? AND r.to_user_id = ? AND r.to_device_id = ? AND r.status = 'pending'
       AND (r.kind = 'ask' OR mine.accept_messages = 1)
     ORDER BY r.created_at LIMIT 5`,
  ).bind(ctx.team.id, principal.userId, deviceId).all<InboxRow>();
  const claimed = [];
  for (const r of rows.results ?? []) {
    const update = await env.DB.prepare(
      "UPDATE team_session_requests SET status = 'claimed', claimed_at = ?, body = '' WHERE id = ? AND status = 'pending'",
    ).bind(now(), r.id).run();
    if (update.meta.changes !== 1) continue;
    claimed.push({ id: r.id, sessionKey: r.session_key, kind: r.kind, body: r.body, effort: r.effort, from: r.display_name });
  }
  return noStore({ requests: claimed });
}

export async function answerRequest(req: Request, env: Env, principal: Principal, key: string, id: string): Promise<Response> {
  const deviceId = requireDevice(principal);
  const ctx = await context(env, principal, key);
  const body = await readJson<{ answer?: unknown; error?: unknown }>(req);
  const answer = text(body.answer, MAX_ANSWER);
  const error = text(body.error, MAX_ERROR);
  if (!answer && !error) throw badRequest("Send an answer or an error.");
  const update = await env.DB.prepare(
    `UPDATE team_session_requests SET status = ?, answer = ?, error = ?, finished_at = ?
     WHERE id = ? AND team_id = ? AND to_user_id = ? AND to_device_id = ? AND status = 'claimed'`,
  ).bind(answer ? "answered" : "failed", answer, answer ? null : error, now(), id, ctx.team.id, principal.userId, deviceId).run();
  if (update.meta.changes !== 1) throw notFound("That request isn't waiting for this Mac's answer.");
  return noStore({ ok: true });
}
