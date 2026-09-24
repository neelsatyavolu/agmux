/** Explicit team credential sharing. Never part of telemetry, exports, or audit detail. */
import type { Env } from "../env";
import type { Principal } from "../session";
import { requireTeam, type TeamContext } from "../authz";
import { HttpError, badRequest, forbidden, notFound, json } from "../http";
import { newId, sha256 } from "../crypto";

type Provider = "codex" | "grok";
interface AccountRow {
  id: string; team_id: string; provider: Provider; label: string; created_by: string;
  scope_kind: "team" | "manager"; enabled: number; credentials_ciphertext: string; identity_hash: string;
  created_at: number; updated_at: number; last_used_at: number | null;
  blocked_until: number | null; remaining_percent: number | null; health_reported_at: number | null;
  lease_id: string | null; lease_expires_at: number | null;
}
const TTL = 300;
const HEALTH_TTL = 300;
const MAX_CREDENTIAL_BYTES = 32 * 1024;
const encoder = new TextEncoder();
const unavailable = () => new HttpError(503, "Provider account storage is unavailable.", "provider_accounts_unavailable");
const now = () => Math.floor(Date.now() / 1000);
const response = (data: unknown, status = 200) => json(data, { status, headers: { "cache-control": "no-store" } });
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const token = (x: unknown) => typeof x === "string" && x.trim().length > 0 && x.length <= 16384;

function provider(x: unknown): Provider {
  if (x !== "codex" && x !== "grok") throw badRequest("Provider must be codex or grok.");
  return x;
}
function shortString(x: unknown, max: number): string {
  if (typeof x !== "string" || !x.trim() || x.length > max || /[\x00-\x1f\x7f]/.test(x)) throw badRequest("Invalid label or identifier.");
  return x.trim();
}
function nativeCredentials(p: Provider, value: unknown): string {
  if (!object(value)) throw badRequest("Native OAuth credentials required.");
  const raw = JSON.stringify(value);
  if (encoder.encode(raw).length > MAX_CREDENTIAL_BYTES) throw badRequest("Credentials exceed 32 KiB.");
  if (p === "codex") {
    const t = value.tokens;
    if (!object(t) || !token(t.access_token) || !token(t.refresh_token) || !token(t.id_token)
      || (value.auth_mode !== undefined && value.auth_mode !== "chatgpt") || value.OPENAI_API_KEY) {
      throw badRequest("Native Codex OAuth credentials required.");
    }
  } else {
    const entries = Object.entries(value);
    if (!entries.length || !entries.every(([scope, entry]) =>
      (scope.startsWith("https://auth.x.ai::") || scope === "https://accounts.x.ai/sign-in")
      && object(entry) && token(entry.key))) throw badRequest("Native Grok OAuth credentials required.");
  }
  return raw;
}

/** Stable native identity, never access/refresh tokens. JWT claims are identity hints,
 * not authentication of the uploader (Teams auth handles that). Missing identity fails closed.
 */
async function identityHash(p: Provider, raw: string): Promise<string> {
  const value = JSON.parse(raw) as Record<string, unknown>;
  let identity: string[];
  if (p === "codex") {
    const t = value.tokens as Record<string, unknown>;
    if (!token(t.account_id)) throw badRequest("Codex account identity is required.");
    let subject: unknown;
    try {
      const part = (t.id_token as string).split(".")[1];
      subject = JSON.parse(new TextDecoder().decode(unbase64(part.replace(/-/g, "+").replace(/_/g, "/")))).sub;
    } catch { throw badRequest("Codex account identity is required."); }
    if (!token(subject)) throw badRequest("Codex account identity is required.");
    identity = [t.account_id as string, subject as string];
  } else {
    const ids = Object.values(value).map(entry => {
      const e = entry as Record<string, unknown>;
      if (e.user_id && e.principal_id && e.user_id !== e.principal_id) throw badRequest("Conflicting Grok account identity.");
      return e.user_id ?? e.principal_id;
    });
    if (!ids.every(token) || new Set(ids).size !== 1) throw badRequest("One consistent Grok user identity is required.");
    identity = [ids[0] as string];
  }
  return sha256(JSON.stringify([p, ...identity]));
}

/** Bound the actual stream, not merely an attacker-controlled Content-Length. */
async function body(req: Request, fields: string[]): Promise<Record<string, unknown>> {
  if (!req.body) throw badRequest("JSON object required.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 40 * 1024) { await reader.cancel(); throw badRequest("Request body exceeds 40 KiB."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw badRequest("JSON object required."); }
  if (!object(parsed) || Object.keys(parsed).some(k => !fields.includes(k))) throw badRequest("Unexpected request fields.");
  return parsed;
}
function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function unbase64(s: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
async function encryptionKey(env: Env): Promise<CryptoKey> {
  if (env.PROVIDER_ACCOUNTS_KEY === undefined) {
    throw new HttpError(503, "Team provider accounts are not configured.", "provider_accounts_not_configured");
  }
  try {
    if (!env.PROVIDER_ACCOUNTS_KEY) throw unavailable();
    const bytes = unbase64(env.PROVIDER_ACCOUNTS_KEY);
    if (bytes.length !== 32) throw unavailable();
    return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch { throw unavailable(); }
}
const aad = (team: string, id: string, p: Provider) => encoder.encode(JSON.stringify(["provider-accounts-v1", team, id, p]));
async function encrypt(key: CryptoKey, team: string, id: string, p: Provider, raw: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(team, id, p) }, key, encoder.encode(raw));
  return `v1.${base64(iv)}.${base64(new Uint8Array(data))}`;
}
async function decrypt(key: CryptoKey, row: AccountRow): Promise<unknown> {
  try {
    const [version, iv, data] = row.credentials_ciphertext.split(".");
    if (version !== "v1" || !iv || !data) throw unavailable();
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64(iv), additionalData: aad(row.team_id, row.id, row.provider) }, key, unbase64(data));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { throw unavailable(); }
}
function metadata(row: AccountRow, ctx: TeamContext) {
  // A reported reset passing means capacity is unknown, not 100%. Keep raw health in storage.
  const resetPassed = row.blocked_until !== null && row.blocked_until <= now();
  const staleHeadroom = row.remaining_percent !== null && row.remaining_percent > 0
    && (row.health_reported_at === null || row.health_reported_at <= now() - HEALTH_TTL);
  return {
    canManage: !ctx.staffPreview && (ctx.role === "owner" || (ctx.role === "manager" && row.created_by === ctx.membership.user_id)),
    id: row.id, provider: row.provider, label: row.label, enabled: !!row.enabled,
    createdBy: row.created_by, scope: row.scope_kind, createdAt: row.created_at, updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at, blockedUntil: row.blocked_until,
    remainingPercent: resetPassed || staleHeadroom ? null : row.remaining_percent, healthReportedAt: row.health_reported_at,
    // Display-only: the last measurement, however old. Allocation never ranks by it.
    lastRemainingPercent: resetPassed ? null : row.remaining_percent,
    leasedUntil: row.lease_expires_at && row.lease_expires_at > now() ? row.lease_expires_at : null,
  };
}
const META_COLUMNS = "id,team_id,provider,label,created_by,scope_kind,enabled,created_at,updated_at,last_used_at,blocked_until,remaining_percent,health_reported_at,lease_expires_at";

// All predicates are evaluated at the write, including live membership and creator role.
// Match manager scope defaults, but manager accounts target employees and self only.
const LIVE_MEMBER = `EXISTS (SELECT 1 FROM team_members caller JOIN teams t ON t.id=caller.team_id
  WHERE caller.team_id=provider_accounts.team_id AND caller.user_id=? AND caller.left_at IS NULL AND t.deleted_at IS NULL)`;
const ELIGIBLE = `${LIVE_MEMBER} AND EXISTS (
  SELECT 1 FROM team_members creator WHERE creator.team_id=provider_accounts.team_id
    AND creator.user_id=provider_accounts.created_by AND creator.left_at IS NULL
    AND creator.role IN ('owner','manager')
    AND (EXISTS (SELECT 1 FROM team_members own WHERE own.team_id=provider_accounts.team_id
      AND own.user_id=? AND own.role='owner' AND own.left_at IS NULL)
      OR (scope_kind='team' AND creator.role='owner')
      OR (scope_kind='manager' AND (created_by=? OR (
        EXISTS (SELECT 1 FROM team_members employee WHERE employee.team_id=provider_accounts.team_id
          AND employee.user_id=? AND employee.role='employee' AND employee.left_at IS NULL)
        AND (NOT EXISTS (SELECT 1 FROM manager_scope s WHERE s.team_id=provider_accounts.team_id AND s.manager_user_id=created_by)
          OR EXISTS (SELECT 1 FROM manager_scope s WHERE s.team_id=provider_accounts.team_id AND s.manager_user_id=created_by
            AND (s.target_user_id=? OR EXISTS (SELECT 1 FROM team_group_members gm JOIN team_groups g ON g.id=gm.group_id
              WHERE gm.group_id=s.target_group_id AND g.team_id=provider_accounts.team_id AND gm.user_id=?))))))))
)`;
const MANAGE = `${LIVE_MEMBER} AND EXISTS (SELECT 1 FROM team_members manager
  WHERE manager.team_id=provider_accounts.team_id AND manager.user_id=? AND manager.left_at IS NULL
    AND (manager.role='owner' OR (manager.role='manager' AND created_by=manager.user_id)))`;
const eligibleArgs = (user: string) => [user, user, user, user, user, user];

export async function handle(req: Request, env: Env, principal: Principal, teamKey: string, suffix = ""): Promise<Response> {
  try {
    return await handleAccount(req, env, principal, teamKey, suffix);
  } catch (err) {
    // D1/crypto errors must never reach the generic logger (which prints error details).
    if (err instanceof HttpError) throw err;
    throw unavailable();
  }
}
async function handleAccount(req: Request, env: Env, principal: Principal, teamKey: string, suffix: string): Promise<Response> {
  const ctx = await requireTeam(env, teamKey, principal.userId, principal.via);
  const team = ctx.team.id, user = principal.userId;
  const leaseMatch = /^\/leases\/([^/]+)(\/renew)?$/.exec(suffix);
  const allocating = suffix === "/allocate" && req.method === "POST";
  const checkMatch = req.method === "POST" ? /^\/([^/]+)\/check$/.exec(suffix) : null;
  if (allocating || leaseMatch || checkMatch) {
    if (ctx.staffPreview || principal.via !== "device" || !principal.deviceId) throw forbidden("A member's desktop device token is required.");
  } else if (req.method !== "GET" && (ctx.staffPreview || ctx.role === "employee")) {
    throw forbidden("Only owners and account-creating managers can manage provider accounts.");
  }
  if (!suffix && req.method === "GET") {
    await encryptionKey(env);
    const filter = ctx.staffPreview || ctx.role === "owner" ? "" : ctx.role === "manager" ? ` AND (${ELIGIBLE} OR created_by=?)` : ` AND ${ELIGIBLE}`;
    const args = ctx.staffPreview || ctx.role === "owner" ? [] : [...eligibleArgs(user), ...(ctx.role === "manager" ? [user] : [])];
    const rows = await env.DB.prepare(`SELECT ${META_COLUMNS} FROM provider_accounts WHERE team_id=?${filter} ORDER BY created_at,id`).bind(team, ...args).all<AccountRow>();
    return response({ accounts: rows.results.map(row => metadata(row, ctx)) });
  }
  if (!suffix && req.method === "POST") {
    const input = await body(req, ["provider", "label", "credentials"]);
    const p = provider(input.provider), label = shortString(input.label, 120);
    const raw = nativeCredentials(p, input.credentials), key = await encryptionKey(env);
    const identity = await identityHash(p, raw);
    const existing = await env.DB.prepare("SELECT id FROM provider_accounts WHERE team_id=? AND provider=? AND identity_hash=?")
      .bind(team, p, identity).first<{ id: string }>();
    const identityConflict = () => new HttpError(409, "Account already exists and cannot be reconnected while leased or outside your management scope.", "provider_account_conflict");
    if (existing) {
      // Preserve original creator/scope/enabled/health. Owner reconnect must not widen a manager's pool.
      const encrypted = await encrypt(key, team, existing.id, p, raw);
      const row = await env.DB.prepare(`UPDATE provider_accounts SET credentials_ciphertext=?,label=?,updated_at=?
        WHERE id=? AND team_id=? AND identity_hash=? AND (lease_expires_at IS NULL OR lease_expires_at<=?)
        AND ${MANAGE} RETURNING ${META_COLUMNS}`)
        .bind(encrypted, label, now(), existing.id, team, identity, now(), user, user).first<AccountRow>();
      if (!row) throw identityConflict();
      return response({ account: metadata(row, ctx) });
    }
    const id = newId("pac"), time = now();
    const encrypted = await encrypt(key, team, id, p, raw);
    const row = await env.DB.prepare(`INSERT INTO provider_accounts
      (id,team_id,provider,label,created_by,scope_kind,credentials_ciphertext,identity_hash,created_at,updated_at)
      SELECT ?,?,?,?,user_id,CASE role WHEN 'owner' THEN 'team' ELSE 'manager' END,?,?,?,?
      FROM team_members WHERE team_id=? AND user_id=? AND left_at IS NULL AND role IN ('owner','manager')
      AND EXISTS (SELECT 1 FROM teams WHERE id=? AND deleted_at IS NULL)
      ON CONFLICT(team_id,provider,identity_hash) DO NOTHING RETURNING ${META_COLUMNS}`)
      .bind(id, team, p, label, encrypted, identity, time, time, team, user, team).first<AccountRow>();
    if (!row) throw identityConflict(); // Includes racing duplicate uploads; retry can reconnect when unleased.
    return response({ account: metadata(row, ctx) }, 201);
  }

  if (allocating) {
    const input = await body(req, ["provider", "sessionId", "excludeIds"]);
    const p = provider(input.provider), session = shortString(input.sessionId, 200);
    const exclude = input.excludeIds ?? [];
    if (!Array.isArray(exclude) || exclude.length > 50 || exclude.some(x => typeof x !== "string" || !x || x.length > 100)) throw badRequest("excludeIds must contain at most 50 account IDs.");
    const key = await encryptionKey(env), time = now(), lease = newId("pal");
    const capacity = `CASE WHEN (blocked_until IS NOT NULL AND blocked_until<=?)
      OR (remaining_percent>0 AND (health_reported_at IS NULL OR health_reported_at<=?))
      THEN NULL ELSE remaining_percent END`;
    // One statement selects and claims. No read/insert gap, even across Worker isolates.
    const row = await env.DB.prepare(`UPDATE provider_accounts SET lease_id=?,lease_user_id=?,lease_device_id=?,
      lease_session_id=?,lease_expires_at=?,last_used_at=? WHERE id=(
        SELECT id FROM provider_accounts WHERE team_id=? AND provider=? AND enabled=1
        AND (lease_expires_at IS NULL OR lease_expires_at<=?)
        AND (blocked_until IS NULL OR blocked_until<=?) AND (${capacity} IS NULL OR ${capacity}>0)
        AND ${ELIGIBLE} ${exclude.length ? `AND id NOT IN (${exclude.map(() => "?").join(",")})` : ""}
        ORDER BY (${capacity} IS NULL), ${capacity} DESC, COALESCE(last_used_at,0),id LIMIT 1
      ) RETURNING *`).bind(lease, user, principal.deviceId, session, time + TTL, time,
        team, p, time, time, time, time - HEALTH_TTL, time, time - HEALTH_TTL,
        ...eligibleArgs(user), ...exclude, time, time - HEALTH_TTL, time, time - HEALTH_TTL).first<AccountRow>();
    if (!row) throw new HttpError(409, "No provider account is currently available.", "no_provider_account_available");
    let credentials: unknown;
    try { credentials = await decrypt(key, row); }
    catch (err) {
      await env.DB.prepare("UPDATE provider_accounts SET lease_id=NULL,lease_expires_at=NULL,lease_user_id=NULL,lease_device_id=NULL,lease_session_id=NULL WHERE id=? AND lease_id=?").bind(row.id, lease).run();
      throw err;
    }
    // Re-check after crypto awaits, so a concurrent scope/member/account revocation fences delivery.
    const live = await env.DB.prepare(`SELECT id FROM provider_accounts WHERE id=? AND lease_id=? AND enabled=1 AND lease_expires_at>? AND ${ELIGIBLE}`)
      .bind(row.id, lease, now(), ...eligibleArgs(user)).first();
    if (!live) throw notFound();
    return response({ account: metadata(row, ctx), leaseId: lease, credentials, expiresAt: row.lease_expires_at });
  }
  if (checkMatch) {
    // A short lease on one exact account so a desktop can measure its quota and report it.
    // Capacity is deliberately ignored: checking is how an exhausted account is seen to reset.
    const id = checkMatch[1], key = await encryptionKey(env), time = now(), lease = newId("pal");
    const row = await env.DB.prepare(`UPDATE provider_accounts SET lease_id=?,lease_user_id=?,lease_device_id=?,
      lease_session_id='usage-check',lease_expires_at=? WHERE id=? AND team_id=? AND enabled=1
      AND (lease_expires_at IS NULL OR lease_expires_at<=?) AND ${ELIGIBLE} RETURNING *`)
      .bind(lease, user, principal.deviceId, time + TTL, id, team, time, ...eligibleArgs(user)).first<AccountRow>();
    if (!row) {
      const leased = await env.DB.prepare(`SELECT id FROM provider_accounts WHERE id=? AND team_id=? AND enabled=1 AND lease_expires_at>? AND ${ELIGIBLE}`)
        .bind(id, team, time, ...eligibleArgs(user)).first();
      if (leased) throw new HttpError(409, "This account is in use right now.", "provider_account_in_use");
      throw notFound();
    }
    let credentials: unknown;
    try { credentials = await decrypt(key, row); }
    catch (err) {
      await env.DB.prepare("UPDATE provider_accounts SET lease_id=NULL,lease_expires_at=NULL,lease_user_id=NULL,lease_device_id=NULL,lease_session_id=NULL WHERE id=? AND lease_id=?").bind(row.id, lease).run();
      throw err;
    }
    const live = await env.DB.prepare(`SELECT id FROM provider_accounts WHERE id=? AND lease_id=? AND enabled=1 AND lease_expires_at>? AND ${ELIGIBLE}`)
      .bind(row.id, lease, now(), ...eligibleArgs(user)).first();
    if (!live) throw notFound();
    return response({ account: metadata(row, ctx), leaseId: lease, credentials, expiresAt: row.lease_expires_at });
  }
  if (leaseMatch) {
    const lease = leaseMatch[1];
    const holder = `team_id=? AND lease_id=? AND lease_user_id=? AND lease_device_id=? AND lease_expires_at>?`;
    const holderArgs = [team, lease, user, principal.deviceId, now()];
    if (req.method === "DELETE" && !leaseMatch[2]) {
      const result = await env.DB.prepare(`UPDATE provider_accounts SET lease_id=NULL,lease_user_id=NULL,lease_device_id=NULL,lease_session_id=NULL,lease_expires_at=NULL
        WHERE ${holder} AND ${LIVE_MEMBER} RETURNING id`).bind(...holderArgs, user).first();
      if (!result) throw notFound();
      return response({ deleted: true });
    }
    if (req.method === "POST" && leaseMatch[2]) {
      const input = await body(req, ["credentials", "blockedUntil", "remainingPercent"]);
      const key = await encryptionKey(env);
      const row = await env.DB.prepare(`SELECT ${META_COLUMNS},identity_hash FROM provider_accounts WHERE ${holder} AND enabled=1 AND ${ELIGIBLE}`)
        .bind(...holderArgs, ...eligibleArgs(user)).first<AccountRow>();
      if (!row) throw notFound();
      const sets: string[] = [], values: (string | number)[] = [];
      if (Object.hasOwn(input, "credentials")) {
        const raw = nativeCredentials(row.provider, input.credentials);
        if (await identityHash(row.provider, raw) !== row.identity_hash) throw badRequest("Renewal cannot change provider account identity.");
        sets.push("credentials_ciphertext=?"); values.push(await encrypt(key, team, row.id, row.provider, raw));
      }
      if (Object.hasOwn(input, "blockedUntil")) {
        const n = input.blockedUntil;
        if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > 253402300799) throw badRequest("blockedUntil must be Unix seconds.");
        sets.push("blocked_until=NULLIF(?,0)"); values.push(n);
        if (n === 0 && !Object.hasOwn(input, "remainingPercent")) sets.push("remaining_percent=NULL");
      }
      if (Object.hasOwn(input, "remainingPercent")) {
        const n = input.remainingPercent;
        if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 100) throw badRequest("remainingPercent must be between 0 and 100.");
        sets.push("remaining_percent=?"); values.push(n);
        // A fresh positive measurement supersedes an elapsed reset, but not a future block.
        if (!Object.hasOwn(input, "blockedUntil")) {
          sets.push("blocked_until=CASE WHEN blocked_until<=? THEN NULL ELSE blocked_until END"); values.push(now());
        }
      }
      if (Object.hasOwn(input, "remainingPercent") || Object.hasOwn(input, "blockedUntil")) { sets.push("health_reported_at=?"); values.push(now()); }
      const time = now(), expires = time + TTL;
      const updated = await env.DB.prepare(`UPDATE provider_accounts SET ${[...sets, "updated_at=?", "lease_expires_at=?"].join(",")}
        WHERE ${holder} AND enabled=1 AND ${ELIGIBLE} RETURNING id`)
        .bind(...values, time, expires, team, lease, user, principal.deviceId, time, ...eligibleArgs(user)).first();
      if (!updated) throw notFound();
      return response({ leaseId: lease, expiresAt: expires });
    }
  }
  if (/^\/[^/]+$/.test(suffix)) {
    const id = suffix.slice(1);
    if (req.method === "PATCH") {
      const input = await body(req, ["enabled", "label"]), sets: string[] = [], args: (string | number)[] = [];
      if (Object.hasOwn(input, "label")) { sets.push("label=?"); args.push(shortString(input.label, 120)); }
      if (Object.hasOwn(input, "enabled")) {
        if (typeof input.enabled !== "boolean") throw badRequest("enabled must be boolean.");
        sets.push("enabled=?"); args.push(input.enabled ? 1 : 0);
      }
      if (!sets.length) throw badRequest("Provide enabled or label.");
      const row = await env.DB.prepare(`UPDATE provider_accounts SET ${sets.join(",")},updated_at=? WHERE id=? AND team_id=? AND ${MANAGE} RETURNING ${META_COLUMNS}`)
        .bind(...args, now(), id, team, user, user).first<AccountRow>();
      if (!row) throw notFound();
      return response({ account: metadata(row, ctx) });
    }
    if (req.method === "DELETE") {
      const row = await env.DB.prepare(`DELETE FROM provider_accounts WHERE id=? AND team_id=? AND ${MANAGE} RETURNING id`).bind(id, team, user, user).first();
      if (!row) throw notFound();
      return response({ deleted: true });
    }
  }
  throw notFound();
}
