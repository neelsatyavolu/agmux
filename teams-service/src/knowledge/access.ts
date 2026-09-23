/**
 * Knowledge entitlement + role gates.
 */
import type { Env } from "../env";
import type { Role, TeamRow } from "../db";
import { ensureTeamTrial, paidPlanAccess } from "../billing/entitlement";
import { billingEnforce } from "../env";
import type { TeamContext } from "../authz";
import { forbidden, HttpError } from "../http";
import {
  ensurePolicy,
  type KnowledgePolicy,
  type ShareRole,
  type EditRecordsRole,
} from "./policy";

export type KnowledgeAccessLevel = "none" | "read" | "write";

/**
 * Knowledge is a Teams-plan feature (trial / active / comp / past_due).
 * Free-tier analytics access does not unlock Knowledge.
 */
export async function knowledgeBillingAccess(
  env: Env,
  team: TeamRow,
): Promise<"full" | "read_only" | "locked"> {
  if (!billingEnforce(env)) return "full";
  const t = await ensureTeamTrial(env, team);
  const access = paidPlanAccess(t);
  // past_due: allow read of existing records; block new writes
  if (t.billing_status === "past_due" && access === "full") return "read_only";
  return access;
}

export async function resolveKnowledgeAccess(
  env: Env,
  ctx: TeamContext,
): Promise<{ level: KnowledgeAccessLevel; policy: KnowledgePolicy; paidFeatures: "full" | "read_only" | "locked" }> {
  const policy = await ensurePolicy(env, ctx.team.id, ctx.membership.user_id);
  const billing = await knowledgeBillingAccess(env, ctx.team);
  if (billing === "locked") {
    return { level: "none", policy, paidFeatures: billing };
  }
  if (policy.knowledgeMode === "disabled") {
    return { level: "none", policy, paidFeatures: billing };
  }
  if (billing === "read_only" || policy.knowledgeMode === "read_only") {
    return { level: "read", policy, paidFeatures: billing };
  }
  return { level: "write", policy, paidFeatures: billing };
}

export function requireKnowledgeRead(
  level: KnowledgeAccessLevel,
): void {
  if (level === "none") {
    throw new HttpError(
      403,
      "Team Knowledge is off or unavailable for this team. An owner can enable it in Settings.",
      "knowledge_disabled",
    );
  }
}

export function requireKnowledgeWrite(level: KnowledgeAccessLevel): void {
  if (level === "none") {
    throw new HttpError(
      403,
      "Team Knowledge is off or unavailable for this team. An owner can enable it in Settings.",
      "knowledge_disabled",
    );
  }
  if (level === "read") {
    throw new HttpError(
      402,
      "Team Knowledge is read-only right now (billing or mode). Subscribe or ask an owner to set mode to full.",
      "knowledge_read_only",
    );
  }
}

function roleMeets(share: ShareRole | EditRecordsRole | "owner_only", role: Role): boolean {
  if (share === "all") return true;
  if (share === "manager_plus") return role === "owner" || role === "manager";
  if (share === "owner_only") return role === "owner";
  return false;
}

function denyStaffWrite(staffPreview?: boolean): void {
  if (staffPreview) throw forbidden("Staff preview is read-only.");
}

export function requireCanShare(
  policy: KnowledgePolicy,
  role: Role,
  staffPreview = false,
): void {
  denyStaffWrite(staffPreview);
  if (!roleMeets(policy.shareRole, role)) {
    throw forbidden(`Your role (${role}) cannot share session digests.`);
  }
}

export function requireCanEditRecords(
  policy: KnowledgePolicy,
  role: Role,
  staffPreview = false,
): void {
  denyStaffWrite(staffPreview);
  if (!roleMeets(policy.editRecordsRole, role)) {
    throw forbidden(`Your role (${role}) cannot edit team records.`);
  }
}

export function requireOwner(role: Role, staffPreview = false): void {
  denyStaffWrite(staffPreview);
  if (role !== "owner") throw forbidden("Only the team owner can do that.");
}

export function requireManagerPlus(role: Role, staffPreview = false): void {
  denyStaffWrite(staffPreview);
  if (role !== "owner" && role !== "manager") {
    throw forbidden("Managers and owners only.");
  }
}
