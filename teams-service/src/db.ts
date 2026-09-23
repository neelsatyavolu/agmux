import type { Env } from "./env";

export const nowIso = (): string => new Date().toISOString();

export function isoPlusDays(days: number, from = new Date()): string {
  return new Date(from.getTime() + days * 86_400_000).toISOString();
}

export type Role = "owner" | "manager" | "employee";

export interface UserRow {
  id: string;
  display_name: string;
  email: string | null;
  handle: string | null;
  avatar_color: string;
  avatar_url: string | null;
  created_at: string;
}

export type BillingStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "locked"
  | "comp";

export interface TeamRow {
  id: string;
  slug: string;
  name: string;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
  trial_ends_at?: string | null;
  billing_status?: BillingStatus | string | null;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  stripe_price_id?: string | null;
  seat_quantity?: number | null;
  pending_seat_quantity?: number | null;
  billing_period_end?: string | null;
  billing_email?: string | null;
}

export interface MemberRow {
  id: string;
  team_id: string;
  user_id: string;
  role: Role;
  joined_at: string;
  left_at: string | null;
}

export interface InviteRow {
  id: string;
  team_id: string;
  token_hash: string;
  /** Plaintext for owner re-display; null when revoked or pre-migration row. */
  token: string | null;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  max_uses: number | null;
  uses: number;
  revoked_at: string | null;
}

export async function getUser(env: Env, userId: string): Promise<UserRow | null> {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
}

export async function getTeamBySlugOrId(env: Env, key: string): Promise<TeamRow | null> {
  return env.DB.prepare(
    "SELECT * FROM teams WHERE (id = ? OR slug = ?) AND deleted_at IS NULL",
  )
    .bind(key, key)
    .first<TeamRow>();
}

/** Active membership only — a member who left has no access and no upload. */
export async function getActiveMembership(
  env: Env,
  teamId: string,
  userId: string,
): Promise<MemberRow | null> {
  return env.DB.prepare(
    "SELECT * FROM team_members WHERE team_id = ? AND user_id = ? AND left_at IS NULL",
  )
    .bind(teamId, userId)
    .first<MemberRow>();
}

export async function listActiveMemberships(env: Env, userId: string): Promise<MemberRow[]> {
  const r = await env.DB.prepare(
    "SELECT * FROM team_members WHERE user_id = ? AND left_at IS NULL",
  )
    .bind(userId)
    .all<MemberRow>();
  return r.results ?? [];
}

/** Slugify a team name; collisions get a short suffix from the caller. */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "team";
}
