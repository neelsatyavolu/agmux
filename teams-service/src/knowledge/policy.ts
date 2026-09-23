/**
 * Per-team Knowledge policy (owner-activated).
 */
import type { Env } from "../env";
import { nowIso } from "../db";
import { badRequest } from "../http";

export type KnowledgeMode = "disabled" | "read_only" | "full";
export type ShareRole = "all" | "manager_plus" | "owner_only";
export type EditRecordsRole = "all" | "manager_plus";
export type McpAuthorityFilter = "official_only" | "official_and_member";

export interface KnowledgePolicy {
  teamId: string;
  knowledgeMode: KnowledgeMode;
  shareRole: ShareRole;
  editRecordsRole: EditRecordsRole;
  knowledgeMcpEnabled: boolean;
  mcpAuthorityFilter: McpAuthorityFilter;
  digestRetentionDays: number;
  disclosureVersion: number;
  updatedAt: string;
  updatedBy: string | null;
}

const DEFAULTS: Omit<KnowledgePolicy, "teamId" | "updatedAt" | "updatedBy"> = {
  knowledgeMode: "disabled",
  shareRole: "manager_plus",
  editRecordsRole: "manager_plus",
  knowledgeMcpEnabled: false,
  mcpAuthorityFilter: "official_only",
  digestRetentionDays: 90,
  disclosureVersion: 1,
};

function rowToPolicy(teamId: string, row: Record<string, unknown> | null): KnowledgePolicy {
  if (!row) {
    return {
      teamId,
      ...DEFAULTS,
      updatedAt: nowIso(),
      updatedBy: null,
    };
  }
  return {
    teamId,
    knowledgeMode: (row.knowledge_mode as KnowledgeMode) || "disabled",
    shareRole: (row.share_role as ShareRole) || "manager_plus",
    editRecordsRole: (row.edit_records_role as EditRecordsRole) || "manager_plus",
    knowledgeMcpEnabled: Number(row.knowledge_mcp_enabled) === 1,
    mcpAuthorityFilter: (row.mcp_authority_filter as McpAuthorityFilter) || "official_only",
    digestRetentionDays: Number(row.digest_retention_days) || 90,
    disclosureVersion: Number(row.disclosure_version) || 1,
    updatedAt: String(row.updated_at ?? nowIso()),
    updatedBy: row.updated_by == null ? null : String(row.updated_by),
  };
}

export async function getPolicy(env: Env, teamId: string): Promise<KnowledgePolicy> {
  const row = await env.DB.prepare("SELECT * FROM kw_team_policy WHERE team_id = ?")
    .bind(teamId)
    .first<Record<string, unknown>>();
  return rowToPolicy(teamId, row);
}

/** Ensure a policy row exists (defaults). */
export async function ensurePolicy(env: Env, teamId: string, actorUserId: string | null): Promise<KnowledgePolicy> {
  const existing = await env.DB.prepare("SELECT team_id FROM kw_team_policy WHERE team_id = ?")
    .bind(teamId)
    .first();
  if (existing) return getPolicy(env, teamId);
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO kw_team_policy (
      team_id, knowledge_mode, share_role, edit_records_role,
      knowledge_mcp_enabled, mcp_authority_filter, digest_retention_days,
      disclosure_version, updated_at, updated_by
    ) VALUES (?, 'disabled', 'manager_plus', 'manager_plus', 0, 'official_only', 90, 1, ?, ?)`,
  )
    .bind(teamId, now, actorUserId)
    .run();
  return getPolicy(env, teamId);
}

export async function updatePolicy(
  env: Env,
  teamId: string,
  actorUserId: string,
  patch: Partial<{
    knowledgeMode: KnowledgeMode;
    shareRole: ShareRole;
    editRecordsRole: EditRecordsRole;
    knowledgeMcpEnabled: boolean;
    mcpAuthorityFilter: McpAuthorityFilter;
    digestRetentionDays: number;
  }>,
): Promise<KnowledgePolicy> {
  await ensurePolicy(env, teamId, actorUserId);
  const cur = await getPolicy(env, teamId);

  const mode = patch.knowledgeMode ?? cur.knowledgeMode;
  if (!["disabled", "read_only", "full"].includes(mode)) throw badRequest("Invalid knowledgeMode.");
  const share = patch.shareRole ?? cur.shareRole;
  if (!["all", "manager_plus", "owner_only"].includes(share)) throw badRequest("Invalid shareRole.");
  const edit = patch.editRecordsRole ?? cur.editRecordsRole;
  if (!["all", "manager_plus"].includes(edit)) throw badRequest("Invalid editRecordsRole.");
  const mcpFilter = patch.mcpAuthorityFilter ?? cur.mcpAuthorityFilter;
  if (!["official_only", "official_and_member"].includes(mcpFilter)) {
    throw badRequest("Invalid mcpAuthorityFilter.");
  }
  let retention = patch.digestRetentionDays ?? cur.digestRetentionDays;
  if (!Number.isFinite(retention)) throw badRequest("Invalid digestRetentionDays.");
  retention = Math.max(7, Math.min(365, Math.floor(retention)));
  const mcpOn =
    patch.knowledgeMcpEnabled !== undefined ? Boolean(patch.knowledgeMcpEnabled) : cur.knowledgeMcpEnabled;

  // MCP only makes sense when Knowledge is not disabled
  const mcpEnabled = mode === "disabled" ? false : mcpOn;

  const now = nowIso();
  await env.DB.prepare(
    `UPDATE kw_team_policy SET
      knowledge_mode = ?, share_role = ?, edit_records_role = ?,
      knowledge_mcp_enabled = ?, mcp_authority_filter = ?, digest_retention_days = ?,
      updated_at = ?, updated_by = ?
     WHERE team_id = ?`,
  )
    .bind(
      mode,
      share,
      edit,
      mcpEnabled ? 1 : 0,
      mcpFilter,
      retention,
      now,
      actorUserId,
      teamId,
    )
    .run();
  return getPolicy(env, teamId);
}

export function policyJson(p: KnowledgePolicy) {
  return {
    teamId: p.teamId,
    knowledgeMode: p.knowledgeMode,
    shareRole: p.shareRole,
    editRecordsRole: p.editRecordsRole,
    knowledgeMcpEnabled: p.knowledgeMcpEnabled,
    mcpAuthorityFilter: p.mcpAuthorityFilter,
    digestRetentionDays: p.digestRetentionDays,
    disclosureVersion: p.disclosureVersion,
    updatedAt: p.updatedAt,
    updatedBy: p.updatedBy,
  };
}
