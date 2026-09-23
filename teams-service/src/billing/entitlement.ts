/**
 * Teams billing entitlement. Pure access math + seat count.
 * App-managed trial (no card). Stripe subscription after convert.
 * First FREE_SEATS members are free forever; paid seats = max(0, n - FREE_SEATS).
 */
import type { Env } from "../env";
import { BILLING_GRACE_DAYS, billingEnforce, TRIAL_DAYS } from "../env";
import type { BillingStatus, TeamRow } from "../db";
import { isoPlusDays, nowIso } from "../db";
import { HttpError } from "../http";

/** Included free seats on every team (Stripe tiered prices match this). */
export const FREE_SEATS = 3;

export type Access = "full" | "read_only" | "locked";

export interface BillingSnapshot {
  status: BillingStatus;
  access: Access;
  trialEndsAt: string | null;
  /** Active members (roster). */
  seats: number;
  freeSeats: number;
  billableSeats: number;
  /** Estimated monthly $ for licensed seats (or roster if unlicensed). */
  estimatedMonthlyUsd: number;
  /** Licensed / billed seat count on Stripe (may be > roster). */
  seatQuantity: number | null;
  /** Downgrade scheduled for period end. */
  pendingSeatQuantity: number | null;
  periodEnd: string | null;
  priceId: string | null;
  hasCustomer: boolean;
  hasSubscription: boolean;
  enforce: boolean;
  /** True when roster fits entirely in the free tier. */
  onFreeTierize: boolean;
  /**
   * Access to paid-only product features (Knowledge, Leaderboard).
   * Independent of free-seat analytics access.
   */
  paidFeatures: Access;
  /** Human-readable for UI banners. */
  message: string;
}

export function billableSeats(totalSeats: number): number {
  const n = Math.max(0, Math.trunc(totalSeats));
  return Math.max(0, n - FREE_SEATS);
}

export function estimatedMonthlyUsd(totalSeats: number): number {
  return billableSeats(totalSeats) * 12;
}

export function trialEndsFrom(createdAt: Date | string = new Date()): string {
  const from = typeof createdAt === "string" ? new Date(createdAt) : createdAt;
  return isoPlusDays(TRIAL_DAYS, from);
}

/**
 * @param seats active members; when ≤ FREE_SEATS the team is free forever.
 */
export function accessForTeam(
  team: Pick<TeamRow, "billing_status" | "trial_ends_at">,
  now: Date = new Date(),
  seats?: number,
): Access {
  if (typeof seats === "number" && seats <= FREE_SEATS) return "full";

  const status = (team.billing_status ?? "trialing") as BillingStatus;
  if (status === "active" || status === "comp") return "full";
  // past_due: keep full with banner so payment recovery doesn't hard-lock mid-month
  if (status === "past_due") return "full";

  const trialEnd = team.trial_ends_at ? new Date(team.trial_ends_at) : null;
  if (trialEnd && !Number.isNaN(trialEnd.getTime()) && now < trialEnd) {
    return "full";
  }

  if (status === "trialing" && trialEnd && now < trialEnd) return "full";

  if (trialEnd && !Number.isNaN(trialEnd.getTime())) {
    const graceEnd = new Date(trialEnd.getTime() + BILLING_GRACE_DAYS * 86_400_000);
    if (now < graceEnd) return "read_only";
  }

  return "locked";
}

/**
 * Paid-plan features (Team Knowledge, Leaderboard).
 * Unlike accessForTeam, free-tier size (≤ FREE_SEATS) does NOT unlock these —
 * only trial, active subscription, comp, or past_due recovery does.
 */
export function paidPlanAccess(
  team: Pick<TeamRow, "billing_status" | "trial_ends_at" | "stripe_subscription_id">,
  now: Date = new Date(),
): Access {
  const status = (team.billing_status ?? "trialing") as BillingStatus;
  if (status === "active" || status === "comp") return "full";
  if (status === "past_due") return "full";
  if (team.stripe_subscription_id) return "full";

  const trialEnd = team.trial_ends_at ? new Date(team.trial_ends_at) : null;
  if (trialEnd && !Number.isNaN(trialEnd.getTime()) && now < trialEnd) {
    return "full";
  }
  if (trialEnd && !Number.isNaN(trialEnd.getTime())) {
    const graceEnd = new Date(trialEnd.getTime() + BILLING_GRACE_DAYS * 86_400_000);
    if (now < graceEnd) return "read_only";
  }
  return "locked";
}

/** Require Teams plan (trial/active/comp/past_due) for Knowledge / Leaderboard. */
export async function requirePaidPlanFeatures(
  env: Env,
  team: TeamRow,
  mode: "read" | "write" = "write",
): Promise<TeamRow> {
  if (!billingEnforce(env)) return team;
  const t = await ensureTeamTrial(env, team);
  const access = paidPlanAccess(t);
  if (access === "full") return t;
  if (mode === "read" && access === "read_only") return t;
  throw new HttpError(
    402,
    access === "read_only"
      ? "Team Knowledge and Leaderboard are read-only until you subscribe on the Plan tab."
      : "Team Knowledge and Leaderboard require a Teams plan (or active trial). Open Plan to upgrade.",
    "billing_required",
  );
}

export function billingMessage(
  access: Access,
  team: Pick<TeamRow, "trial_ends_at" | "billing_status">,
  seats = 0,
): string {
  const status = team.billing_status ?? "trialing";
  if (seats > 0 && seats <= FREE_SEATS) {
    return `Free tier: first ${FREE_SEATS} members included. Add more to unlock paid seats ($${12}/seat/mo after that).`;
  }
  if (status === "comp") return "Complimentary access.";
  if (status === "active") {
    const paid = billableSeats(seats);
    return paid > 0
      ? `Subscription active — ${paid} paid seat${paid === 1 ? "" : "s"} (first ${FREE_SEATS} free).`
      : "Subscription active.";
  }
  if (status === "past_due") return "Payment past due — update billing to avoid interruption.";
  if (access === "full" && team.trial_ends_at) {
    const end = new Date(team.trial_ends_at);
    const days = Math.max(0, Math.ceil((end.getTime() - Date.now()) / 86_400_000));
    const paid = billableSeats(seats);
    const seatNote =
      paid > 0
        ? ` After trial: $${paid * 12}/mo for ${paid} paid seat${paid === 1 ? "" : "s"} (first ${FREE_SEATS} free).`
        : "";
    return days <= 0
      ? `Trial ends today.${seatNote}`
      : `Trial ends in ${days} day${days === 1 ? "" : "s"} (${end.toISOString().slice(0, 10)}).${seatNote}`;
  }
  if (access === "read_only") {
    return `Trial ended. Subscribe for seats beyond ${FREE_SEATS} to keep uploading and inviting. Dashboards stay readable for a short grace period.`;
  }
  return `This team is locked. Subscribe for seats beyond the free ${FREE_SEATS} members.`;
}

export async function countSeats(env: Env, teamId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND left_at IS NULL",
  )
    .bind(teamId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function billingSnapshot(env: Env, team: TeamRow): Promise<BillingSnapshot> {
  const seats = await countSeats(env, team.id);
  const licensed = team.seat_quantity ?? seats;
  const access = accessForTeam(team, new Date(), seats);
  const status = (team.billing_status ?? "trialing") as BillingStatus;
  const paid = billableSeats(licensed);
  const enforce = billingEnforce(env);
  const paidFeatures = enforce ? paidPlanAccess(team) : "full";
  return {
    status,
    access,
    trialEndsAt: team.trial_ends_at ?? null,
    seats,
    freeSeats: FREE_SEATS,
    billableSeats: paid,
    estimatedMonthlyUsd: estimatedMonthlyUsd(licensed),
    seatQuantity: team.seat_quantity ?? null,
    pendingSeatQuantity: team.pending_seat_quantity ?? null,
    periodEnd: team.billing_period_end ?? null,
    priceId: team.stripe_price_id ?? null,
    hasCustomer: Boolean(team.stripe_customer_id),
    hasSubscription: Boolean(team.stripe_subscription_id),
    enforce,
    onFreeTierize: seats <= FREE_SEATS,
    paidFeatures,
    message: billingMessage(access, team, seats),
  };
}

/**
 * When BILLING_ENFORCE is off, always allow writes (pre-release).
 * When on, free tier (≤3 seats) always allowed; else require access === 'full'.
 */
export async function requireWritableBilling(env: Env, team: TeamRow): Promise<void> {
  if (!billingEnforce(env)) return;
  const seats = await countSeats(env, team.id);
  const access = accessForTeam(team, new Date(), seats);
  if (access === "full") return;
  throw new HttpError(
    402,
    access === "read_only"
      ? `Trial ended. Subscribe for members beyond the free ${FREE_SEATS}, or reduce the roster.`
      : `This team is locked. Subscribe for members beyond the free ${FREE_SEATS}.`,
    "billing_required",
  );
}

/** Filter team ids to those that may receive metric uploads. */
export async function filterUploadTeamIds(env: Env, teamIds: string[]): Promise<{
  allowed: string[];
  skipped: { id: string; reason: string }[];
}> {
  if (!teamIds.length) return { allowed: [], skipped: [] };
  if (!billingEnforce(env)) return { allowed: teamIds, skipped: [] };

  const skipped: { id: string; reason: string }[] = [];
  const allowed: string[] = [];
  for (const id of teamIds) {
    const team = await env.DB.prepare("SELECT * FROM teams WHERE id = ? AND deleted_at IS NULL")
      .bind(id)
      .first<TeamRow>();
    if (!team) {
      skipped.push({ id, reason: "missing" });
      continue;
    }
    const seats = await countSeats(env, id);
    if (accessForTeam(team, new Date(), seats) === "full") allowed.push(id);
    else skipped.push({ id, reason: "billing" });
  }
  return { allowed, skipped };
}

/**
 * Lazy-grandfather teams created before billing: give a full 30-day trial
 * if they have no trial clock and no Stripe subscription yet.
 * Returns the (possibly refreshed) team row.
 */
export async function ensureTeamTrial(env: Env, team: TeamRow): Promise<TeamRow> {
  if (team.deleted_at) return team;
  if (team.stripe_subscription_id) return team;
  if (team.billing_status === "active" || team.billing_status === "comp") return team;
  if (team.trial_ends_at) return team;

  const trialEnds = defaultTrialEndsAt();
  await env.DB.prepare(
    `UPDATE teams SET trial_ends_at = ?, billing_status = 'trialing'
     WHERE id = ? AND trial_ends_at IS NULL AND stripe_subscription_id IS NULL`,
  )
    .bind(trialEnds, team.id)
    .run();
  return { ...team, trial_ends_at: trialEnds, billing_status: "trialing" };
}

export function defaultTrialEndsAt(): string {
  return trialEndsFrom(new Date());
}

export { nowIso };
