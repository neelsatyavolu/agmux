/**
 * Team board: broadcasts between agents working in the same repo, across a team. An agent
 * claims work ("I'm taking migration 365"), asks everyone ("is anyone changing auth.ts?"),
 * records a decision or a note, and replies to others. Claims expire unless renewed, so an
 * agent that went away doesn't hold work forever. Only members who turned on team sessions
 * take part. The point-to-point channel is team-sessions.ts (ask / message one session).
 */
import type { Env } from "../env";
import type { Principal } from "../session";
import { requireTeam, type TeamContext } from "../authz";
import { HttpError, badRequest, forbidden, notFound, json, readJson } from "../http";
import { newId } from "../crypto";

export const KINDS = ["claim", "question", "decision", "note", "reply"] as const;
type Kind = (typeof KINDS)[number];
const MAX_BODY = 2_000;
const MAX_PROJECT = 200;
const MAX_POSTS_PER_HOUR = 60;
const DEFAULT_CLAIM_HOURS = 4;
const MAX_CLAIM_HOURS = 24;
/** How long each kind stays on the board (seconds); open claims stay until they expire. */
const KEEP: Record<Kind, number> = {
  claim: 7 * 86_400, question: 7 * 86_400, reply: 7 * 86_400, note: 14 * 86_400, decision: 180 * 86_400,
};
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

const now = () => Math.floor(Date.now() / 1000);
const noStore = (data: unknown, status = 200) => json(data, { status, headers: { "cache-control": "no-store" } });

function clean(value: unknown, max: number, what: string): string {
  if (typeof value !== "string") throw badRequest(`${what} is required.`);
  const text = value.replace(CONTROL, " ").trim();
  if (!text) throw badRequest(`${what} is empty.`);
  if (text.length > max) throw badRequest(`Keep ${what.toLowerCase()} under ${max} characters.`);
  return text;
}

async function context(env: Env, principal: Principal, key: string): Promise<TeamContext> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  if (ctx.staffPreview) throw notFound("That team doesn't exist.");
  const sharing = await env.DB.prepare("SELECT 1 AS on_ FROM team_session_sharing WHERE team_id = ? AND user_id = ?")
    .bind(ctx.team.id, principal.userId).first();
  if (!sharing) throw new HttpError(403, "Turn on team sessions first: agterm Settings → Teams & Phone.", "sharing_off");
  return ctx;
}

interface Row {
  id: string; project: string; kind: Kind; parent_id: string | null; body: string; status: string;
  author_user_id: string; agent: string | null; created_at: number; updated_at: number; expires_at: number | null;
  display_name: string;
}

function view(r: Row, principal: Principal, at: number) {
  const expired = r.kind === "claim" && r.status === "open" && r.expires_at !== null && r.expires_at < at;
  return {
    id: r.id,
    kind: r.kind,
    ...(r.parent_id ? { reply_to: r.parent_id } : {}),
    text: r.body,
    status: expired ? "expired" : r.status,
    member: r.display_name,
    mine: r.author_user_id === principal.userId,
    agent: r.agent,
    posted: new Date(r.created_at * 1000).toISOString(),
    updated: new Date(r.updated_at * 1000).toISOString(),
    ...(r.kind === "claim" && r.expires_at ? { expires: new Date(r.expires_at * 1000).toISOString() } : {}),
  };
}

/**
 * The board for one repo, newest change first: the latest 200 changes since `since` (ISO), plus
 * every claim still held and every claim that ran out since then, however old, so an agent never
 * misses work someone holds. `now` is taken before reading, so the next `since=now` misses nothing.
 */
export async function listBoard(req: Request, env: Env, principal: Principal, key: string): Promise<Response> {
  const ctx = await context(env, principal, key);
  const url = new URL(req.url);
  const project = clean(url.searchParams.get("project") ?? "", MAX_PROJECT, "Project");
  const sinceParam = url.searchParams.get("since");
  const since = sinceParam ? Math.floor(Date.parse(sinceParam) / 1000) : 0;
  if (Number.isNaN(since)) throw badRequest("since must be an ISO date.");
  const at = now();
  const select = "SELECT b.*, u.display_name FROM team_board_items b JOIN users u ON u.id = b.author_user_id";
  const [recent, claims] = await Promise.all([
    env.DB.prepare(`${select} WHERE b.team_id = ? AND b.project = ? AND b.updated_at >= ? ORDER BY b.updated_at DESC LIMIT 200`)
      .bind(ctx.team.id, project, since).all<Row>(),
    env.DB.prepare(
      `${select} WHERE b.team_id = ? AND b.project = ? AND b.kind = 'claim' AND b.status = 'open'
         AND (b.expires_at >= ? OR (b.expires_at >= ? AND b.expires_at <= ?))`,
    ).bind(ctx.team.id, project, since ? at : 0, since, at).all<Row>(),
  ]);
  const seen = new Set<string>();
  const rows = [...(recent.results ?? []), ...(claims.results ?? [])]
    .filter((r) => !seen.has(r.id) && seen.add(r.id))
    .sort((a, b) => b.updated_at - a.updated_at);
  return noStore({ project, items: rows.map((r) => view(r, principal, at)), now: new Date(at * 1000).toISOString() });
}

export async function postBoard(req: Request, env: Env, principal: Principal, key: string): Promise<Response> {
  const ctx = await context(env, principal, key);
  const body = await readJson<{ kind?: unknown; project?: unknown; text?: unknown; replyTo?: unknown; hours?: unknown; agent?: unknown }>(req);
  const kind = body.kind as Kind;
  if (!KINDS.includes(kind)) throw badRequest(`kind must be one of ${KINDS.join(", ")}.`);
  const project = clean(body.project, MAX_PROJECT, "Project");
  const text = clean(body.text, MAX_BODY, "Text");
  const agent = typeof body.agent === "string" ? body.agent.replace(CONTROL, " ").trim().slice(0, 40) || null : null;
  const teamId = ctx.team.id;
  let parent: string | null = null;
  if (kind === "reply") {
    if (typeof body.replyTo !== "string") throw badRequest("A reply needs replyTo: the item it answers.");
    const found = await env.DB.prepare("SELECT id FROM team_board_items WHERE id = ? AND team_id = ? AND project = ?")
      .bind(body.replyTo, teamId, project).first<{ id: string }>();
    if (!found) throw notFound("That board item is gone.");
    parent = found.id;
  }
  let expires: number | null = null;
  const at = now();
  if (kind === "claim") {
    const hours = typeof body.hours === "number" && Number.isFinite(body.hours) ? body.hours : DEFAULT_CLAIM_HOURS;
    expires = at + Math.round(Math.min(MAX_CLAIM_HOURS, Math.max(0.25, hours)) * 3600);
  }
  const id = newId("tb");
  // One statement, so a burst can't slip past the hourly cap.
  const inserted = await env.DB.prepare(
    `INSERT INTO team_board_items (id, team_id, project, kind, parent_id, body, status, author_user_id, agent, created_at, updated_at, expires_at)
     SELECT ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM team_board_items WHERE team_id = ? AND author_user_id = ? AND created_at >= ?) < ?`,
  ).bind(id, teamId, project, kind, parent, text, principal.userId, agent, at, at, expires,
    teamId, principal.userId, at - 3600, MAX_POSTS_PER_HOUR).run();
  if (inserted.meta.changes !== 1) throw new HttpError(429, "Too many board posts this hour.", "rate_limited");
  return noStore({ id, ...(expires ? { expires: new Date(expires * 1000).toISOString() } : {}) }, 201);
}

/** The author closes a claim (done/released), reopens or renews it, or edits the text. */
export async function updateBoard(req: Request, env: Env, principal: Principal, key: string, id: string): Promise<Response> {
  const ctx = await context(env, principal, key);
  const body = await readJson<{ status?: unknown; renew?: unknown; hours?: unknown; text?: unknown }>(req);
  const row = await env.DB.prepare("SELECT author_user_id, kind FROM team_board_items WHERE id = ? AND team_id = ?")
    .bind(id, ctx.team.id).first<{ author_user_id: string; kind: Kind }>();
  if (!row) throw notFound("That board item is gone.");
  if (row.author_user_id !== principal.userId) throw forbidden("Only the agent's own member can change that item.");
  const at = now();
  const sets: string[] = ["updated_at = ?"];
  const binds: unknown[] = [at];
  if (body.status !== undefined) {
    if (body.status !== "open" && body.status !== "done" && body.status !== "released") throw badRequest("status must be open, done or released.");
    sets.push("status = ?");
    binds.push(body.status);
  }
  if (body.text !== undefined) {
    sets.push("body = ?");
    binds.push(clean(body.text, MAX_BODY, "Text"));
  }
  if (body.renew === true || body.status === "open") {
    if (row.kind !== "claim") throw badRequest("Only a claim can be renewed.");
    const hours = typeof body.hours === "number" && Number.isFinite(body.hours) ? body.hours : DEFAULT_CLAIM_HOURS;
    sets.push("expires_at = ?");
    binds.push(at + Math.round(Math.min(MAX_CLAIM_HOURS, Math.max(0.25, hours)) * 3600));
  }
  await env.DB.prepare(`UPDATE team_board_items SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  return noStore({ ok: true });
}

/** Deletes what each kind no longer needs; runs hourly. */
export async function sweepBoard(env: Env, at = now()): Promise<void> {
  await env.DB.batch(KINDS.map((kind) => env.DB.prepare(
    `DELETE FROM team_board_items WHERE kind = ? AND updated_at < ?
       AND NOT (kind = 'claim' AND status = 'open' AND expires_at >= ?)`,
  ).bind(kind, at - KEEP[kind], at)));
}
