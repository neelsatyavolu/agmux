/**
 * Teams Knowledge API — records + digests + policy.
 * Content plane; never mixes with metrics upload.
 */
import type { Env } from "../env";
import { newId } from "../crypto";
import { nowIso } from "../db";
import {
  badRequest,
  conflict,
  forbidden,
  HttpError,
  json,
  notFound,
  readJson,
} from "../http";
import { requireTeam } from "../authz";
import type { Principal } from "../session";
import { writeAudit } from "./audit";
import {
  RECORD_KINDS,
  validateDigestBody,
  validateRecordContent,
  validateTitle,
  knowledgeProjectKey,
} from "../knowledge/dlp";
import {
  ensurePolicy,
  policyJson,
  updatePolicy,
  type KnowledgeMode,
  type ShareRole,
  type EditRecordsRole,
  type McpAuthorityFilter,
} from "../knowledge/policy";
import {
  knowledgeBillingAccess,
  requireCanEditRecords,
  requireCanShare,
  requireKnowledgeRead,
  requireKnowledgeWrite,
  requireManagerPlus,
  requireOwner,
  resolveKnowledgeAccess,
} from "../knowledge/access";
import { isKnowledgeReady } from "../knowledge/ready";

const MAX_RECORDS = 500;

async function requireReady(env: Env): Promise<void> {
  if (!(await isKnowledgeReady(env))) {
    throw new HttpError(
      503,
      "Team Knowledge is not available on this server yet.",
      "knowledge_unavailable",
    );
  }
}

/** Share / write paths require an explicit knowledge disclosure accept. */
async function requireDisclosureAccepted(
  env: Env,
  teamId: string,
  userId: string,
): Promise<void> {
  const policy = await ensurePolicy(env, teamId, userId);
  const disc = await env.DB.prepare(
    "SELECT disclosure_version FROM kw_disclosure_accept WHERE team_id = ? AND user_id = ?",
  )
    .bind(teamId, userId)
    .first<{ disclosure_version: number }>();
  if (!disc || Number(disc.disclosure_version) < policy.disclosureVersion) {
    throw new HttpError(
      403,
      "Accept the Team Knowledge disclosure before sharing or enabling Knowledge content.",
      "disclosure_required",
    );
  }
}

async function hmacThread(
  env: Env,
  teamId: string,
  threadId: string | null,
): Promise<string | null> {
  if (!threadId) return null;
  const secret = env.KNOWLEDGE_HMAC_SECRET || `kw-default:${env.APP_ORIGIN}`;
  const payload = `${teamId}|${threadId}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function ensureWorkspace(
  env: Env,
  teamId: string,
  title: string,
  userId: string,
): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT id FROM kw_workspaces WHERE team_id = ? AND deleted_at IS NULL",
  )
    .bind(teamId)
    .first<{ id: string }>();
  if (row) return row.id;
  const id = newId("kw");
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO kw_workspaces (id, team_id, title, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, teamId, title.slice(0, 200), userId, now, now)
    .run();
  return id;
}

function recordJson(r: Record<string, unknown>) {
  return {
    id: r.id,
    teamId: r.team_id,
    workspaceId: r.workspace_id,
    kind: r.kind,
    title: r.title,
    content: r.content,
    status: r.status,
    authority: r.authority,
    important: Number(r.important) === 1,
    version: Number(r.version),
    source: r.source,
    ownerUserId: r.owner_user_id,
    projectKey: r.project_key,
    createdBy: r.created_by,
    createdByName:
      typeof r.created_by_name === "string" && r.created_by_name
        ? r.created_by_name
        : null,
    updatedBy: r.updated_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Join author display name for citation in MCP / export. */
const RECORD_SELECT = `SELECT r.*, u.display_name AS created_by_name
  FROM kw_records r
  LEFT JOIN users u ON u.id = r.created_by`;

function digestJson(d: Record<string, unknown>) {
  const parse = (v: unknown) => {
    if (typeof v !== "string" || !v) return [];
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
  };
  return {
    id: d.id,
    teamId: d.team_id,
    title: d.title,
    summary: d.summary,
    outcomes: parse(d.outcomes_json),
    decisions: parse(d.decisions_json),
    files: parse(d.files_json),
    providers: d.providers,
    projectKey: d.project_key,
    sourceProjectId: d.source_project_id,
    reviewState: d.review_state,
    composedOn: d.composed_on,
    sharedBy: d.shared_by,
    createdAt: d.created_at,
  };
}

// ── settings ─────────────────────────────────────────────────────────────

export async function getSettings(
  env: Env,
  principal: Principal,
  teamKey: string,
): Promise<Response> {
  const ctx = await requireTeam(env, teamKey, principal.userId, principal.via);
  // Soft response when migration not applied — never 500 older/new UIs probing.
  if (!(await isKnowledgeReady(env))) {
    return json({
      available: false,
      access: "none",
      policy: null,
      disclosureAccepted: false,
      role: ctx.role,
    });
  }
  const policy = await ensurePolicy(env, ctx.team.id, principal.userId);
  const { level, paidFeatures } = await resolveKnowledgeAccess(env, ctx);
  const disc = await env.DB.prepare(
    "SELECT disclosure_version, accepted_at FROM kw_disclosure_accept WHERE team_id = ? AND user_id = ?",
  )
    .bind(ctx.team.id, principal.userId)
    .first<{ disclosure_version: number; accepted_at: string }>();
  return json({
    available: true,
    access: level,
    paidFeatures,
    planRequired: paidFeatures === "locked",
    policy: policyJson(policy),
    disclosureAccepted:
      disc != null && Number(disc.disclosure_version) >= policy.disclosureVersion,
    role: ctx.role,
  });
}

export async function patchSettings(
  env: Env,
  principal: Principal,
  teamKey: string,
  req: Request,
): Promise<Response> {
  await requireReady(env);
  const ctx = await requireTeam(env, teamKey, principal.userId, principal.via);
  requireOwner(ctx.role, ctx.staffPreview);
  const body = await readJson<Record<string, unknown>>(req);
  // Enabling share surface (mode ≠ disabled or MCP on) requires disclosure.
  const enablingShare =
    (typeof body.knowledgeMode === "string" && body.knowledgeMode !== "disabled") ||
    body.knowledgeMcpEnabled === true;
  if (enablingShare) {
    const billing = await knowledgeBillingAccess(env, ctx.team);
    if (billing === "locked") {
      throw new HttpError(
        402,
        "Team Knowledge requires a Teams plan (or active trial). Open Plan to upgrade.",
        "billing_required",
      );
    }
    if (billing === "read_only") {
      throw new HttpError(
        402,
        "Team Knowledge is read-only until you subscribe on the Plan tab.",
        "billing_required",
      );
    }
    await requireDisclosureAccepted(env, ctx.team.id, principal.userId);
  }
  const policy = await updatePolicy(env, ctx.team.id, principal.userId, {
    knowledgeMode: body.knowledgeMode as KnowledgeMode | undefined,
    shareRole: body.shareRole as ShareRole | undefined,
    editRecordsRole: body.editRecordsRole as EditRecordsRole | undefined,
    knowledgeMcpEnabled:
      body.knowledgeMcpEnabled === undefined ? undefined : Boolean(body.knowledgeMcpEnabled),
    mcpAuthorityFilter: body.mcpAuthorityFilter as McpAuthorityFilter | undefined,
    digestRetentionDays:
      body.digestRetentionDays === undefined ? undefined : Number(body.digestRetentionDays),
  });
  await writeAudit(env, ctx.team.id, principal.userId, "knowledge.settings", "knowledge", "settings");
  return json({ policy: policyJson(policy) });
}

export async function acceptDisclosure(
  env: Env,
  principal: Principal,
  teamKey: string,
): Promise<Response> {
  await requireReady(env);
  const ctx = await requireTeam(env, teamKey, principal.userId, principal.via);
  const policy = await ensurePolicy(env, ctx.team.id, principal.userId);
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO kw_disclosure_accept (team_id, user_id, disclosure_version, accepted_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(team_id, user_id) DO UPDATE SET
       disclosure_version = excluded.disclosure_version,
       accepted_at = excluded.accepted_at`,
  )
    .bind(ctx.team.id, principal.userId, policy.disclosureVersion, now)
    .run();
  await writeAudit(
    env,
    ctx.team.id,
    principal.userId,
    "knowledge.disclosure",
    "disclosure",
    `v${policy.disclosureVersion}`,
  );
  return json({ ok: true, disclosureVersion: policy.disclosureVersion, acceptedAt: now });
}

// ── overview / search ────────────────────────────────────────────────────

export async function overview(
  env: Env,
  principal: Principal,
  teamKey: string,
  req: Request,
): Promise<Response> {
  await requireReady(env);
  const ctx = await requireTeam(env, teamKey, principal.userId, principal.via);
  const { level, policy } = await resolveKnowledgeAccess(env, ctx);
  requireKnowledgeRead(level);

  const url = new URL(req.url);
  const forMcp = url.searchParams.get("for") === "mcp";

  if (forMcp && !policy.knowledgeMcpEnabled) {
    throw new HttpError(403, "Agent Knowledge read is disabled for this team.", "knowledge_mcp_off");
  }

  let sql = `${RECORD_SELECT}
    WHERE r.team_id = ? AND r.deleted_at IS NULL AND r.archived = 0 AND r.status = 'current'`;
  const binds: unknown[] = [ctx.team.id];

  if (forMcp) {
    if (policy.mcpAuthorityFilter === "official_only") {
      sql += ` AND r.authority = 'official'`;
    }
  }

  sql += ` ORDER BY
    CASE r.authority WHEN 'official' THEN 0 WHEN 'member' THEN 1 ELSE 2 END,
    r.important DESC,
    r.updated_at DESC
    LIMIT ${forMcp ? 25 : 40}`;

  const rows = await env.DB.prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>();
  let records = (rows.results ?? []).map(recordJson);

  // MCP: hard cap total payload (~4k chars of body content).
  if (forMcp) {
    let budget = 4000;
    const capped: typeof records = [];
    for (const rec of records) {
      const cost = String(rec.title).length + String(rec.content).length + 40;
      if (capped.length > 0 && budget - cost < 0) break;
      budget -= cost;
      capped.push(rec);
    }
    records = capped;
  }

  // Digests never in MCP overview
  let digests: ReturnType<typeof digestJson>[] = [];
  if (!forMcp) {
    const d = await env.DB.prepare(
      `SELECT * FROM kw_session_digests
       WHERE team_id = ? AND deleted_at IS NULL AND review_state = 'published'
       ORDER BY created_at DESC LIMIT 20`,
    )
      .bind(ctx.team.id)
      .all<Record<string, unknown>>();
    digests = (d.results ?? []).map(digestJson);
  }

  return json({
    records,
    digests,
    policy: {
      knowledgeMode: policy.knowledgeMode,
      knowledgeMcpEnabled: policy.knowledgeMcpEnabled,
      mcpAuthorityFilter: policy.mcpAuthorityFilter,
    },
  });
}

export async function search(
  env: Env,
  principal: Principal,
  teamKey: string,
  req: Request,
): Promise<Response> {
  await requireReady(env);
  const ctx = await requireTeam(env, teamKey, principal.userId, principal.via);
  const { level, policy } = await resolveKnowledgeAccess(env, ctx);
  requireKnowledgeRead(level);

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const forMcp = url.searchParams.get("for") === "mcp";
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20));

  if (forMcp && !policy.knowledgeMcpEnabled) {
    throw new HttpError(403, "Agent Knowledge read is disabled for this team.", "knowledge_mcp_off");
  }
  if (!q) return json({ hits: [] });

  const like = `%${q.replace(/%/g, "")}%`;
  let recSql = `SELECT id, kind, title, authority, updated_at, 'record' AS hit_kind
    FROM kw_records
    WHERE team_id = ? AND deleted_at IS NULL AND archived = 0
      AND (title LIKE ? OR content LIKE ?)`;
  if (forMcp && policy.mcpAuthorityFilter === "official_only") {
    recSql += ` AND authority = 'official'`;
  }
  recSql += ` ORDER BY updated_at DESC LIMIT ?`;

  const recs = await env.DB.prepare(recSql)
    .bind(ctx.team.id, like, like, limit)
    .all<Record<string, unknown>>();

  const hits: unknown[] = (recs.results ?? []).map((r) => ({
    kind: "record",
    id: r.id,
    recordKind: r.kind,
    title: r.title,
    authority: r.authority,
    updatedAt: r.updated_at,
  }));

  if (!forMcp) {
    const digs = await env.DB.prepare(
      `SELECT id, title, created_at FROM kw_session_digests
       WHERE team_id = ? AND deleted_at IS NULL
         AND (title LIKE ? OR summary LIKE ?)
       ORDER BY created_at DESC LIMIT ?`,
    )
      .bind(ctx.team.id, like, like, limit)
      .all<Record<string, unknown>>();
    for (const d of digs.results ?? []) {
      hits.push({
        kind: "digest",
        id: d.id,
        title: d.title,
        createdAt: d.created_at,
      });
    }
  }

  return json({ hits: hits.slice(0, limit), q });
}

// ── records ──────────────────────────────────────────────────────────────

export async function listRecords(
  env: Env,
  principal: Principal,
  teamKey: string,
  req: Request,
): Promise<Response> {
  await requireReady(env);
  const ctx = await requireTeam(env, teamKey, principal.userId, principal.via);
  const { level } = await resolveKnowledgeAccess(env, ctx);
  requireKnowledgeRead(level);

  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 30) || 30));
  const cursor = url.searchParams.get("cursor"); // updated_at|id

  let sql = `SELECT * FROM kw_records
    WHERE team_id = ? AND deleted_at IS NULL AND archived = 0`;
  const binds: unknown[] = [ctx.team.id];
  if (cursor) {
    const [ts, id] = cursor.split("|");
    if (ts && id) {
      sql += ` AND (updated_at < ? OR (updated_at = ? AND id < ?))`;
      binds.push(ts, ts, id);
    }
  }
  sql += ` ORDER BY updated_at DESC, id DESC LIMIT ?`;
  binds.push(limit + 1);

  const rows = await env.DB.prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>();
  const list = rows.results ?? [];
  const hasMore = list.length > limit;
  const page = hasMore ? list.slice(0, limit) : list;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? `${last.updated_at}|${last.id}` : null;

  return json({
    records: page.map(recordJson),
    nextCursor,
  });
}

export async function createRecord(
  env: Env,
  principal: Principal,
  teamKey: string,
  req: Request,
): Promise<Response> {
  await requireReady(env);
  const ctx = await requireTeam(env, teamKey, principal.userId, principal.via);
  const { level, policy } = await resolveKnowledgeAccess(env, ctx);
  requireKnowledgeWrite(level);
  requireCanEditRecords(policy, ctx.role, ctx.staffPreview);
  await requireDisclosureAccepted(env, ctx.team.id, principal.userId);

  const body = await readJson<Record<string, unknown>>(req);
  const kind = typeof body.kind === "string" ? body.kind : "decision";
  if (!RECORD_KINDS.has(kind)) throw badRequest("kind must be decision, fact, or issue.");
  const title = validateTitle(body.title);
  const content = validateRecordContent(body.content);
  const projectKey = knowledgeProjectKey(
    typeof body.projectKey === "string" ? body.projectKey : null,
  );
  const source =
    typeof body.source === "string" && ["user", "promote", "digest_promote"].includes(body.source)
      ? body.source
      : "user";

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM kw_records
     WHERE team_id = ? AND deleted_at IS NULL AND archived = 0`,
  )
    .bind(ctx.team.id)
    .first<{ n: number }>();
  if (Number(count?.n ?? 0) >= MAX_RECORDS) {
    throw new HttpError(409, `Record limit reached (${MAX_RECORDS}).`, "quota_exceeded");
  }

  const ws = await ensureWorkspace(env, ctx.team.id, ctx.team.name, principal.userId);
  const id = newId("kwr");
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO kw_records (
      id, team_id, workspace_id, kind, title, content, status, authority,
      important, version, archived, source, owner_user_id, project_key,
      created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'current', 'member', 0, 1, 0, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      ctx.team.id,
      ws,
      kind,
      title,
      content,
      source,
      principal.userId,
      projectKey,
      principal.userId,
      principal.userId,
      now,
      now,
    )
    .run();

  await writeAudit(env, ctx.team.id, principal.userId, "knowledge.record_create", id, kind);
  const row = await env.DB.prepare(
    `${RECORD_SELECT} WHERE r.id = ? AND r.team_id = ?`,
  )
    .bind(id, ctx.team.id)
    .first<Record<string, unknown>>();
  return json({ record: recordJson(row!) }, { status: 201 });
}

export async function getRecord(
  env: Env,
  principal: Principal,
  teamKey: string,
  recordId: string,
  req?: Request,
): Promise<Response> {
  await requireReady(env);
  const ctx = await requireTeam(env, teamKey, principal.userId, principal.via);
  const { level, policy } = await resolveKnowledgeAccess(env, ctx);
  requireKnowledgeRead(level);

  // Digest ids must not be fetched via the records route (MCP safety).
  if (recordId.startsWith("kwd") || recordId.startsWith("kw_d")) {
    throw new HttpError(
      400,
      "That id is a session digest, not a team record. Agents cannot read digests.",
      "knowledge_digest_not_readable",
    );
  }

  const forMcp = req ? new URL(req.url).searchParams.get("for") === "mcp" : false;
  if (forMcp && !policy.knowledgeMcpEnabled) {
    throw new HttpError(403, "Agent Knowledge read is disabled for this team.", "knowledge_mcp_off");
  }

  const row = await env.DB.prepare(
    `${RECORD_SELECT} WHERE r.id = ? AND r.team_id = ? AND r.deleted_at IS NULL`,
  )
    .bind(recordId, ctx.team.id)
    .first<Record<string, unknown>>();
  if (!row) throw notFound("Record not found.");
  if (forMcp && policy.mcpAuthorityFilter === "official_only" && row.authority !== "official") {
    throw notFound("Record not found.");
  }
  return json({ record: recordJson(row) });
}

export async function patchRecord(
  env: Env,
  principal: Principal,
  teamKey: string,
  recordId: string,
  req: Request,
): Promise<Response> {
  await requireReady(env);
  const ctx = await requireTeam(env, teamKey, principal.userId, principal.via);
  const { level, policy } = await resolveKnowledgeAccess(env, ctx);
  requireKnowledgeWrite(level);
  requireCanEditRecords(policy, ctx.role, ctx.staffPreview);

  const row = await env.DB.prepare(
    "SELECT * FROM kw_records WHERE id = ? AND team_id = ? AND deleted_at IS NULL",
  )
    .bind(recordId, ctx.team.id)
    .first<Record<string, unknown>>();
  if (!row) throw notFound("Record not found.");

  const body = await readJson<Record<string, unknown>>(req);
  const expected = Number(body.expectedVersion ?? body.expected_version);
  if (!Number.isFinite(expected)) {
    throw badRequest("expectedVersion is required.");
  }
  if (Number(row.version) !== expected) {
    throw new HttpError(412, "Record was updated by someone else. Reload and retry.", "precondition_failed");
  }

  // Official protection: employees cannot PATCH official records at all
  // (including their own — would demote authority to member). Matches delete.
  if (row.authority === "official" && ctx.role === "employee") {
    throw forbidden("Cannot edit official records.");
  }

  const title = body.title !== undefined ? validateTitle(body.title) : String(row.title);
  const content =
    body.content !== undefined ? validateRecordContent(body.content) : String(row.content);
  const substantive = title !== row.title || content !== row.content;
  const reverify = body.reverify === true;
  const isManagerPlus = ctx.role === "owner" || ctx.role === "manager";

  let authority = String(row.authority);
  let important = Number(row.important);
  if (substantive) {
    if (authority === "official" && !(isManagerPlus && reverify)) {
      authority = "member";
      important = 0;
    }
  }
  if (body.important !== undefined && isManagerPlus) {
    important = body.important ? 1 : 0;
  }

  const newVersion = Number(row.version) + 1;
  const now = nowIso();

  // Version history
  await env.DB.prepare(
    `INSERT INTO kw_record_versions (id, team_id, record_id, version, title, content, changed_by, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      newId("kwv"),
      ctx.team.id,
      recordId,
      row.version,
      row.title,
      row.content,
      principal.userId,
      now,
    )
    .run();

  const result = await env.DB.prepare(
    `UPDATE kw_records SET title = ?, content = ?, authority = ?, important = ?,
      version = ?, updated_by = ?, updated_at = ?
     WHERE id = ? AND team_id = ? AND version = ?`,
  )
    .bind(
      title,
      content,
      authority,
      important,
      newVersion,
      principal.userId,
      now,
      recordId,
      ctx.team.id,
      expected,
    )
    .run();
  if (!result.meta.changes) {
    throw new HttpError(412, "Record was updated by someone else. Reload and retry.", "precondition_failed");
  }

  // Trim old versions beyond 50
  await env.DB.prepare(
    `DELETE FROM kw_record_versions WHERE team_id = ? AND record_id = ? AND version NOT IN (
       SELECT version FROM kw_record_versions
       WHERE team_id = ? AND record_id = ?
       ORDER BY version DESC LIMIT 50
     )`,
  )
    .bind(ctx.team.id, recordId, ctx.team.id, recordId)
    .run()
    .catch(() => {
      /* SQLite/D1 may not support this form; ignore trim failure */
    });

  const updated = await env.DB.prepare("SELECT * FROM kw_records WHERE id = ? AND team_id = ?")
    .bind(recordId, ctx.team.id)
    .first<Record<string, unknown>>();
  return json({ record: recordJson(updated!) });
}

export async function verifyRecord(
  env: Env,
  principal: Principal,
  teamKey: string,
  recordId: string,
): Promise<Response> {
  await requireReady(env);
  const ctx = await requireTeam(env, teamKey, principal.userId, principal.via);
  const { level } = await resolveKnowledgeAccess(env, ctx);
  requireKnowledgeWrite(level);
  requireManagerPlus(ctx.role, ctx.staffPreview);

  const row = await env.DB.prepare(
    "SELECT * FROM kw_records WHERE id = ? AND team_id = ? AND deleted_at IS NULL",
  )
    .bind(recordId, ctx.team.id)
    .first<Record<string, unknown>>();
  if (!row) throw notFound("Record not found.");

  await env.DB.prepare(
    `UPDATE kw_records SET authority = 'official', updated_by = ?, updated_at = ?
     WHERE id = ? AND team_id = ?`,
  )
    .bind(principal.userId, nowIso(), recordId, ctx.team.id)
    .run();

  await writeAudit(env, ctx.team.id, principal.userId, "knowledge.verify", recordId, "official");

  const updated = await env.DB.prepare(
    `${RECORD_SELECT} WHERE r.id = ? AND r.team_id = ?`,
  )
    .bind(recordId, ctx.team.id)
    .first<Record<string, unknown>>();
  return json({ record: recordJson(updated!) });
}

export async function deleteRecord(
  env: Env,
  principal: Principal,
  teamKey: string,
  recordId: string,
  req: Request,
): Promise<Response> {
  await requireReady(env);
  const ctx = await requireTeam(env, teamKey, principal.userId, principal.via);
  const { level } = await resolveKnowledgeAccess(env, ctx);
  requireKnowledgeWrite(level);

  const url = new URL(req.url);
  const purge = url.searchParams.get("purge") === "1";

  const row = await env.DB.prepare(
    "SELECT * FROM kw_records WHERE id = ? AND team_id = ?",
  )
    .bind(recordId, ctx.team.id)
    .first<Record<string, unknown>>();
  if (!row || (row.deleted_at && !purge)) throw notFound("Record not found.");

  if (purge) {
    requireManagerPlus(ctx.role, ctx.staffPreview);
    await env.DB.prepare("DELETE FROM kw_record_versions WHERE team_id = ? AND record_id = ?")
      .bind(ctx.team.id, recordId)
      .run();
    await env.DB.prepare("DELETE FROM kw_records WHERE id = ? AND team_id = ?")
      .bind(recordId, ctx.team.id)
      .run();
    await writeAudit(env, ctx.team.id, principal.userId, "knowledge.record_purge", recordId, "purge");
    return json({ purged: true });
  }

  // Soft delete
  if (ctx.role === "employee" && row.owner_user_id !== principal.userId) {
    throw forbidden("You can only delete your own records.");
  }
  if (row.authority === "official" && ctx.role === "employee") {
    throw forbidden("Cannot delete official records.");
  }

  await env.DB.prepare(
    `UPDATE kw_records SET deleted_at = ?, deleted_by = ? WHERE id = ? AND team_id = ?`,
  )
    .bind(nowIso(), principal.userId, recordId, ctx.team.id)
    .run();
  return json({ deleted: true });
}

// ── digests ──────────────────────────────────────────────────────────────

export async function createDigest(
  env: Env,
  principal: Principal,
  teamKey: string,
  req: Request,
): Promise<Response> {
  await requireReady(env);
  const ctx = await requireTeam(env, teamKey, principal.userId, principal.via);
  const { level, policy } = await resolveKnowledgeAccess(env, ctx);
  requireKnowledgeWrite(level);
  requireCanShare(policy, ctx.role, ctx.staffPreview);
  await requireDisclosureAccepted(env, ctx.team.id, principal.userId);

  const body = await readJson<Record<string, unknown>>(req);
  const idem =
    (typeof body.idempotencyKey === "string" && body.idempotencyKey) ||
    (typeof body.client_batch_id === "string" && body.client_batch_id) ||
    req.headers.get("idempotency-key");
  if (!idem || typeof idem !== "string" || idem.length < 8 || idem.length > 128) {
    throw badRequest("idempotencyKey is required (8–128 chars).");
  }

  const deviceId = principal.deviceId ?? "web";
  const prior = await env.DB.prepare(
    `SELECT response_json FROM kw_idempotency
     WHERE team_id = ? AND user_id = ? AND device_id = ? AND op = 'digest' AND key = ?`,
  )
    .bind(ctx.team.id, principal.userId, deviceId, idem)
    .first<{ response_json: string }>();
  if (prior?.response_json) {
    return json(JSON.parse(prior.response_json));
  }

  const d = validateDigestBody(body);
  const ws = await ensureWorkspace(env, ctx.team.id, ctx.team.name, principal.userId);
  const id = newId("kwd");
  const now = nowIso();
  const threadHash = await hmacThread(env, ctx.team.id, d.threadId);

  await env.DB.prepare(
    `INSERT INTO kw_session_digests (
      id, team_id, workspace_id, title, summary, outcomes_json, decisions_json,
      files_json, providers, project_key, source_project_id, thread_id_hash,
      review_state, risk_flags_json, composed_on, shared_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', NULL, 'desktop', ?, ?)`,
  )
    .bind(
      id,
      ctx.team.id,
      ws,
      d.title,
      d.summary,
      JSON.stringify(d.outcomes),
      JSON.stringify(d.decisions),
      JSON.stringify(d.files),
      d.providers,
      d.projectKey,
      d.sourceProjectId,
      threadHash,
      principal.userId,
      now,
    )
    .run();

  const row = await env.DB.prepare("SELECT * FROM kw_session_digests WHERE id = ? AND team_id = ?")
    .bind(id, ctx.team.id)
    .first<Record<string, unknown>>();
  const payload = { digest: digestJson(row!) };

  await env.DB.prepare(
    `INSERT INTO kw_idempotency (team_id, user_id, device_id, op, key, response_json, created_at)
     VALUES (?, ?, ?, 'digest', ?, ?, ?)`,
  )
    .bind(ctx.team.id, principal.userId, deviceId, idem, JSON.stringify(payload), now)
    .run();

  await writeAudit(env, ctx.team.id, principal.userId, "knowledge.share", id, "digest");
  return json(payload, { status: 201 });
}

export async function listDigests(
  env: Env,
  principal: Principal,
  teamKey: string,
  req: Request,
): Promise<Response> {
  await requireReady(env);
  const ctx = await requireTeam(env, teamKey, principal.userId, principal.via);
  const { level } = await resolveKnowledgeAccess(env, ctx);
  requireKnowledgeRead(level);

  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 30) || 30));
  const projectKey = url.searchParams.get("projectKey");

  let sql = `SELECT * FROM kw_session_digests
    WHERE team_id = ? AND deleted_at IS NULL`;
  const binds: unknown[] = [ctx.team.id];
  if (projectKey) {
    sql += ` AND project_key = ?`;
    binds.push(projectKey.slice(0, 200));
  }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  binds.push(limit);

  const rows = await env.DB.prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>();
  return json({ digests: (rows.results ?? []).map(digestJson) });
}

export async function getDigest(
  env: Env,
  principal: Principal,
  teamKey: string,
  digestId: string,
): Promise<Response> {
  await requireReady(env);
  const ctx = await requireTeam(env, teamKey, principal.userId, principal.via);
  const { level } = await resolveKnowledgeAccess(env, ctx);
  requireKnowledgeRead(level);

  const row = await env.DB.prepare(
    "SELECT * FROM kw_session_digests WHERE id = ? AND team_id = ? AND deleted_at IS NULL",
  )
    .bind(digestId, ctx.team.id)
    .first<Record<string, unknown>>();
  if (!row) throw notFound("Digest not found.");
  return json({ digest: digestJson(row) });
}

export async function deleteDigest(
  env: Env,
  principal: Principal,
  teamKey: string,
  digestId: string,
  req: Request,
): Promise<Response> {
  await requireReady(env);
  const ctx = await requireTeam(env, teamKey, principal.userId, principal.via);
  const { level } = await resolveKnowledgeAccess(env, ctx);
  requireKnowledgeWrite(level);

  const purge = new URL(req.url).searchParams.get("purge") === "1";
  const row = await env.DB.prepare(
    "SELECT * FROM kw_session_digests WHERE id = ? AND team_id = ?",
  )
    .bind(digestId, ctx.team.id)
    .first<Record<string, unknown>>();
  if (!row) throw notFound("Digest not found.");

  if (purge) {
    requireManagerPlus(ctx.role, ctx.staffPreview);
    await env.DB.prepare("DELETE FROM kw_session_digests WHERE id = ? AND team_id = ?")
      .bind(digestId, ctx.team.id)
      .run();
    return json({ purged: true });
  }

  if (ctx.role === "employee" && row.shared_by !== principal.userId) {
    throw forbidden("You can only delete your own digests.");
  }
  await env.DB.prepare(
    `UPDATE kw_session_digests SET deleted_at = ?, deleted_by = ? WHERE id = ? AND team_id = ?`,
  )
    .bind(nowIso(), principal.userId, digestId, ctx.team.id)
    .run();
  return json({ deleted: true });
}

/** Promote digest decision lines or free-form local memory into a record. */
export async function promote(
  env: Env,
  principal: Principal,
  teamKey: string,
  req: Request,
): Promise<Response> {
  await requireReady(env);
  const ctx = await requireTeam(env, teamKey, principal.userId, principal.via);
  const { level, policy } = await resolveKnowledgeAccess(env, ctx);
  requireKnowledgeWrite(level);
  requireCanEditRecords(policy, ctx.role, ctx.staffPreview);
  await requireDisclosureAccepted(env, ctx.team.id, principal.userId);

  const body = await readJson<Record<string, unknown>>(req);
  const title = validateTitle(body.title);
  const content = validateRecordContent(body.content ?? body.title);
  const kind = typeof body.kind === "string" && RECORD_KINDS.has(body.kind) ? body.kind : "decision";
  const source =
    body.from === "digest" || body.source === "digest_promote" ? "digest_promote" : "promote";

  // Reuse create path via internal insert
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM kw_records WHERE team_id = ? AND deleted_at IS NULL AND archived = 0`,
  )
    .bind(ctx.team.id)
    .first<{ n: number }>();
  if (Number(count?.n ?? 0) >= MAX_RECORDS) {
    throw conflict(`Record limit reached (${MAX_RECORDS}).`);
  }

  const ws = await ensureWorkspace(env, ctx.team.id, ctx.team.name, principal.userId);
  const id = newId("kwr");
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO kw_records (
      id, team_id, workspace_id, kind, title, content, status, authority,
      important, version, archived, source, owner_user_id, project_key,
      created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'current', 'member', 0, 1, 0, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      ctx.team.id,
      ws,
      kind,
      title,
      content,
      source,
      principal.userId,
      knowledgeProjectKey(typeof body.projectKey === "string" ? body.projectKey : null),
      principal.userId,
      principal.userId,
      now,
      now,
    )
    .run();

  await writeAudit(env, ctx.team.id, principal.userId, "knowledge.promote", id, source);

  const row = await env.DB.prepare(
    `${RECORD_SELECT} WHERE r.id = ? AND r.team_id = ?`,
  )
    .bind(id, ctx.team.id)
    .first<Record<string, unknown>>();
  return json({ record: recordJson(row!) }, { status: 201 });
}

/**
 * Owner-only portable export of current Knowledge (records + digests).
 * Metadata-only audit; bodies included for the owner dump.
 * Soft-deleted / purged rows are omitted (purge removes versions too).
 */
export async function exportKnowledge(
  env: Env,
  principal: Principal,
  teamKey: string,
): Promise<Response> {
  await requireReady(env);
  const ctx = await requireTeam(env, teamKey, principal.userId, principal.via);
  requireOwner(ctx.role, ctx.staffPreview);
  const { level } = await resolveKnowledgeAccess(env, ctx);
  requireKnowledgeRead(level);

  const recs = await env.DB.prepare(
    `${RECORD_SELECT}
     WHERE r.team_id = ? AND r.deleted_at IS NULL
     ORDER BY r.updated_at DESC
     LIMIT 2000`,
  )
    .bind(ctx.team.id)
    .all<Record<string, unknown>>();

  const digs = await env.DB.prepare(
    `SELECT * FROM kw_session_digests
     WHERE team_id = ? AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 2000`,
  )
    .bind(ctx.team.id)
    .all<Record<string, unknown>>();

  const policy = await ensurePolicy(env, ctx.team.id, principal.userId);

  await writeAudit(env, ctx.team.id, principal.userId, "knowledge.export", "knowledge", "json");

  return json({
    exportedAt: nowIso(),
    teamId: ctx.team.id,
    teamName: ctx.team.name,
    policy: policyJson(policy),
    records: (recs.results ?? []).map(recordJson),
    digests: (digs.results ?? []).map(digestJson),
  });
}

