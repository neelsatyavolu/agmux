/** Restrictions are nullable allowlists: null unrestricted, [] deny all.
 * Effective policy intersects the owner base with currently applicable manager layers.
 */
import type { Env } from "../env";
import { badRequest, forbidden, json } from "../http";
import { requireCapability, requireTeam } from "../authz";
import type { TeamContext } from "../authz";
import type { Principal } from "../session";
import { nowIso } from "../db";
import { resolveAnalyticsScope } from "../scope";
import { writeAudit } from "./audit";

export interface Restrictions {
  allowedProviders: string[] | null;
  allowedModels: string[] | null;
  allowedModes: string[] | null;
  allowedEfforts: string[] | null;
}
export interface TeamPolicy extends Restrictions {
  teamId: string;
  defaultPermissionMode: string | null;
  mcpAllowlist: string[] | null;
  spendHardStopUsd: number | null;
  updatedAt: string | null;
}
const FIELDS = {
  allowedProviders: "allowed_providers", allowedModels: "allowed_models",
  allowedModes: "allowed_modes", allowedEfforts: "allowed_efforts",
} as const;
const PROVIDERS = new Set([
  "ClaudeCode",
  "Codex",
  "Grok",
  "OpenCode",
  "Cursor",
  "Kimi",
  "Pi",
  "Droid",
  "Cline",
  "Gemini",
  "Hermes",
  "MLX",
]);

const PERM_MODES = new Set([
  "default",
  "auto",
  "plan",
  "bypassPermissions",
  "acceptEdits",
  "dontAsk",
]);

const MODES = new Set(["chat", "terminal"]);
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function parseStringList(raw: unknown, max = 64, choices?: Set<string>): string[] | null {
  if (raw === null) return null;
  if (!Array.isArray(raw) || raw.length > max) throw badRequest(`Expected a string array with at most ${max} entries.`);
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim() || item !== item.trim() || item.length > 200 || /[\x00-\x1f]/.test(item)) {
      throw badRequest("List entries must be non-empty strings, at most 200 characters, without surrounding whitespace.");
    }
    if (choices && !choices.has(item)) throw badRequest(`Unknown ${choices === PROVIDERS ? "provider" : "restriction value"}: ${item}`);
  }
  if (new Set(raw).size !== raw.length) throw badRequest("Duplicate list entries.");
  return raw;
}

function rowToPolicy(teamId: string, row: Record<string, unknown> | null): TeamPolicy {
  const list = (key: string): string[] | null => typeof row?.[key] === "string" ? JSON.parse(row[key] as string) : null;
  return {
    teamId, allowedProviders: list("allowed_providers"), allowedModels: list("allowed_models"),
    allowedModes: list("allowed_modes"), allowedEfforts: list("allowed_efforts"),
    defaultPermissionMode: row?.default_permission_mode as string ?? null,
    mcpAllowlist: list("mcp_allowlist"), spendHardStopUsd: row?.spend_hard_stop_usd as number ?? null,
    updatedAt: row?.updated_at as string ?? null,
  };
}

export function intersectRestrictions(base: Restrictions, layer: Restrictions): Restrictions {
  const result = { ...base };
  for (const key of Object.keys(FIELDS) as (keyof Restrictions)[]) {
    const a = base[key], b = layer[key];
    result[key] = a === null ? b : b === null ? a : a.filter(value => b.includes(value));
  }
  return result;
}

async function policyResponse(env: Env, ctx: TeamContext) {
  const teamId = ctx.team.id, userId = ctx.membership.user_id;
  const base = rowToPolicy(teamId, await env.DB.prepare("SELECT allowed_providers, allowed_models, allowed_modes, allowed_efforts, default_permission_mode, mcp_allowlist, spend_hard_stop_usd, updated_at FROM team_policies WHERE team_id = ?").bind(teamId).first());
  let policy = { ...base };
  let editablePolicy: TeamPolicy | Restrictions | null = ctx.role === "owner" ? base : null;
  if (!ctx.staffPreview && ctx.role !== "owner") {
    // Restriction scope follows live analytics assignments, but never targets peers or owners.
    const layers = await env.DB.prepare(`SELECT p.* FROM manager_policies p
      JOIN team_members m ON m.team_id = p.team_id AND m.user_id = p.manager_user_id
      WHERE p.team_id = ? AND m.role = 'manager' AND m.left_at IS NULL
      AND (p.manager_user_id = ? OR (? = 'employee' AND (
        NOT EXISTS (SELECT 1 FROM manager_scope s WHERE s.team_id = p.team_id AND s.manager_user_id = p.manager_user_id)
        OR EXISTS (SELECT 1 FROM manager_scope s WHERE s.team_id = p.team_id AND s.manager_user_id = p.manager_user_id
          AND (s.target_user_id = ? OR EXISTS (
            SELECT 1 FROM team_group_members gm JOIN team_groups g ON g.id = gm.group_id
            WHERE gm.group_id = s.target_group_id AND g.team_id = p.team_id AND gm.user_id = ?)))
      )))`).bind(teamId, userId, ctx.role, userId, userId).all<Record<string, unknown>>();
    for (const row of layers.results) {
      const layer = rowToPolicy(teamId, row);
      policy = { ...policy, ...intersectRestrictions(policy, layer) };
      if (layer.updatedAt && (!policy.updatedAt || layer.updatedAt > policy.updatedAt)) policy.updatedAt = layer.updatedAt;
      if (row.manager_user_id === userId) editablePolicy = Object.fromEntries(Object.keys(FIELDS).map(k => [k, layer[k as keyof Restrictions]])) as unknown as Restrictions;
    }
    if (ctx.role === "manager" && !editablePolicy) editablePolicy = { allowedProviders: null, allowedModels: null, allowedModes: null, allowedEfforts: null };
  }
  const canManage = !ctx.staffPreview && ctx.role !== "employee";
  const scopeLabel = ctx.staffPreview ? "Staff preview · read only" : ctx.role === "owner" ? "Entire team" : ctx.role === "employee" ? "Just you · read only" : `${(await resolveAnalyticsScope(env, ctx)).label} · active employees and you only`;
  return { enforcementVersion: 2, policy, editablePolicy: canManage ? editablePolicy : null, canManage, scopeLabel };
}

export async function getPolicy(env: Env, principal: Principal, teamKey: string): Promise<Response> {
  const ctx = await requireTeam(env, teamKey, principal.userId, principal.via);
  requireCapability(ctx, "analytics.viewSelf");
  return json(await policyResponse(env, ctx));
}

export async function putPolicy(req: Request, env: Env, principal: Principal, teamKey: string): Promise<Response> {
  const ctx = await requireTeam(env, teamKey, principal.userId, principal.via);
  if (ctx.staffPreview || ctx.role === "employee") throw forbidden("Restrictions can only be edited by owners and managers. Staff preview is read-only.");
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("JSON object required.");
  const ownerFields = ["defaultPermissionMode", "mcpAllowlist", "spendHardStopUsd"];
  for (const key of Object.keys(body)) {
    if (!Object.hasOwn(FIELDS, key) && !ownerFields.includes(key)) throw badRequest(`Unknown field: ${key}`);
    if (ctx.role !== "owner" && ownerFields.includes(key)) throw forbidden(`Only owners can edit ${key}.`);
  }
  const columns: string[] = [], values: (string | number | null)[] = [];
  for (const key of Object.keys(FIELDS) as (keyof Restrictions)[]) {
    if (!Object.hasOwn(body, key)) continue;
    const list = parseStringList(body[key], key === "allowedModels" ? 128 : 64,
      key === "allowedProviders" ? PROVIDERS : key === "allowedModes" ? MODES : key === "allowedEfforts" ? EFFORTS : undefined);
    columns.push(FIELDS[key]); values.push(list === null ? null : JSON.stringify(list));
  }
  if (Object.hasOwn(body, "defaultPermissionMode")) {
    const value = body.defaultPermissionMode;
    if (value !== null && (typeof value !== "string" || !PERM_MODES.has(value))) throw badRequest("Invalid defaultPermissionMode.");
    columns.push("default_permission_mode"); values.push(value as string | null);
  }
  if (Object.hasOwn(body, "mcpAllowlist")) {
    const list = parseStringList(body.mcpAllowlist);
    columns.push("mcp_allowlist"); values.push(list === null ? null : JSON.stringify(list));
  }
  if (Object.hasOwn(body, "spendHardStopUsd")) {
    const value = body.spendHardStopUsd;
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw badRequest("spendHardStopUsd must be a non-negative number.");
    columns.push("spend_hard_stop_usd"); values.push(value as number | null);
  }
  if (!columns.length) throw badRequest("Provide at least one policy field.");
  const manager = ctx.role === "manager";
  const table = manager ? "manager_policies" : "team_policies";
  const keys = manager ? ["team_id", "manager_user_id"] : ["team_id"];
  const allColumns = [...keys, ...columns, "updated_by", "updated_at"];
  await env.DB.prepare(`INSERT INTO ${table} (${allColumns.join(",")}) VALUES (${allColumns.map(() => "?").join(",")})
    ON CONFLICT(${keys.join(",")}) DO UPDATE SET ${[...columns, "updated_by", "updated_at"].map(c => `${c}=excluded.${c}`).join(",")}`)
    .bind(ctx.team.id, ...(manager ? [principal.userId] : []), ...values, principal.userId, nowIso()).run();
  await writeAudit(env, ctx.team.id, principal.userId, "policy.updated", manager ? principal.userId : ctx.team.id,
    JSON.stringify({ layer: manager ? "manager" : "team", changes: Object.fromEntries(
      [...Object.keys(FIELDS), ...ownerFields].filter(key => Object.hasOwn(body, key)).map(key => [key,
        Object.hasOwn(FIELDS, key) ? body[key] === null ? null : (body[key] as string[]).length : true,
      ]),
    ) }));
  return json(await policyResponse(env, ctx));
}
