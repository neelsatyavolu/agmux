import type { Env } from "../env";
import {
  billingSnapshot,
  countSeats,
  defaultTrialEndsAt,
  ensureTeamTrial,
} from "../billing/entitlement";
import {
  createCheckoutSession,
  createPortalSession,
  priceIdForInterval,
  requireStripe,
  stripeForm,
  updateSubscriptionQuantity,
  verifyStripeWebhook,
} from "../billing/stripe";
import type { BillingStatus, TeamRow } from "../db";
import { nowIso } from "../db";
import { badRequest, json, readJson } from "../http";
import { requireCapability, requireTeam } from "../authz";
import type { Principal } from "../session";
import { getUser } from "../db";
import { writeAudit } from "./audit";

export async function getBilling(
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  const team = await ensureTeamTrial(env, ctx.team);
  const snap = await billingSnapshot(env, team);
  return json({
    billing: snap,
    prices: {
      monthly: env.STRIPE_PRICE_MONTHLY ?? null,
      annual: env.STRIPE_PRICE_ANNUAL ?? null,
      monthlyUsd: 12,
      annualUsdPerYear: 120,
      freeSeats: 3,
      trialDays: 30,
    },
  });
}

export async function startCheckout(
  req: Request,
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  requireStripe(env);
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "team.rename"); // owner-only
  const body = await readJson<{ interval?: string; seats?: number }>(req);
  const interval = body.interval === "year" ? "year" : body.interval === "month" ? "month" : null;
  if (!interval) throw badRequest("interval must be 'month' or 'year'.");

  // Default quantity = current active members. Owner may pass a higher `seats`
  // to pre-purchase headroom (Stripe graduated tiers: first 3 free).
  const roster = await countSeats(env, ctx.team.id);
  let seats = Math.max(1, roster);
  if (body.seats != null) {
    const n = Math.trunc(Number(body.seats));
    if (!Number.isFinite(n) || n < 1 || n > 500) {
      throw badRequest("seats must be an integer from 1 to 500.");
    }
    // Never bill for fewer seats than the live roster (would under-cover members).
    seats = Math.max(roster, n);
  }
  const priceId = priceIdForInterval(env, interval);
  const origin = env.APP_ORIGIN.replace(/\/$/, "");
  const user = await getUser(env, principal.userId);

  const session = await createCheckoutSession(env, {
    teamId: ctx.team.id,
    teamSlug: ctx.team.slug,
    customerId: ctx.team.stripe_customer_id,
    customerEmail: user?.email ?? null,
    priceId,
    quantity: seats,
    // session_id={CHECKOUT_SESSION_ID} appended in createCheckoutSession
    successUrl: `${origin}/#/t/${encodeURIComponent(ctx.team.slug)}/plan?billing=success`,
    cancelUrl: `${origin}/#/t/${encodeURIComponent(ctx.team.slug)}/plan?billing=cancel`,
  });

  await writeAudit(env, ctx.team.id, principal.userId, "billing.checkout_started", null, interval);

  return json({ url: session.url, sessionId: session.id, seats, interval });
}

export async function startPortal(
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  requireStripe(env);
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "team.rename");
  if (!ctx.team.stripe_customer_id) {
    throw badRequest("No Stripe customer yet — subscribe first.");
  }
  const origin = env.APP_ORIGIN.replace(/\/$/, "");
  const session = await createPortalSession(
    env,
    ctx.team.stripe_customer_id,
    `${origin}/#/t/${encodeURIComponent(ctx.team.slug)}/settings`,
  );
  return json({ url: session.url });
}

/**
 * Owner returns from Checkout with session_id — confirm and write D1 even if
 * the webhook has not arrived yet (idempotent with webhook).
 */
export async function confirmCheckout(
  req: Request,
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  requireStripe(env);
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "team.rename");
  const body = await readJson<{ sessionId?: string }>(req);
  const sessionId = (body.sessionId ?? "").trim();
  if (!sessionId.startsWith("cs_")) throw badRequest("sessionId is required.");

  const session = await stripeForm(env, "GET", `/checkout/sessions/${sessionId}`, {
    "expand[]": "subscription",
  });
  const metaTeam =
    (session.client_reference_id as string) ||
    ((session.metadata as { team_id?: string } | undefined)?.team_id ?? "");
  if (metaTeam && metaTeam !== ctx.team.id) {
    throw badRequest("That Checkout session is not for this team.");
  }
  if (session.status !== "complete" && session.payment_status !== "paid") {
    return json({
      confirmed: false,
      status: session.status ?? null,
      paymentStatus: session.payment_status ?? null,
    });
  }

  await applyCheckoutSession(env, session);
  const team = await env.DB.prepare("SELECT * FROM teams WHERE id = ?")
    .bind(ctx.team.id)
    .first<TeamRow>();
  const snap = team ? await billingSnapshot(env, team) : null;
  return json({ confirmed: true, billing: snap });
}

/**
 * After roster grows past licensed seats, bump Stripe quantity immediately
 * (prorated). Leaving members does NOT reduce seats — owners manage that
 * explicitly (downgrades apply at period end).
 */
export async function syncSeatQuantity(env: Env, teamId: string): Promise<void> {
  if (!env.STRIPE_SECRET_KEY) return;
  const team = await env.DB.prepare("SELECT * FROM teams WHERE id = ?")
    .bind(teamId)
    .first<TeamRow>();
  if (!team?.stripe_subscription_id) return;
  const roster = Math.max(1, await countSeats(env, teamId));
  const licensed = team.seat_quantity ?? 0;
  if (roster <= licensed) return;
  try {
    await updateSubscriptionQuantity(env, team.stripe_subscription_id, roster, {
      proration: "create_prorations",
    });
    // Clear pending downgrade if roster grew past it.
    const pending =
      team.pending_seat_quantity != null && team.pending_seat_quantity < roster
        ? null
        : team.pending_seat_quantity;
    await env.DB.prepare(
      `UPDATE teams SET seat_quantity = ?, pending_seat_quantity = ? WHERE id = ?`,
    )
      .bind(roster, pending, teamId)
      .run();
  } catch (err) {
    console.error("teams-billing: quantity sync failed", teamId, err);
  }
}

/**
 * Owner sets licensed seat count.
 * - Increase → Stripe immediately (prorated charge).
 * - Decrease → schedule for billing_period_end (keep seats until then).
 * - Must be ≥ current roster.
 */
export async function setSeats(
  req: Request,
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  requireStripe(env);
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "team.rename");
  if (!ctx.team.stripe_subscription_id) {
    throw badRequest("Subscribe first, then you can change seat count.");
  }

  const body = await readJson<{ seats?: number }>(req);
  const desired = Math.trunc(Number(body.seats));
  if (!Number.isFinite(desired) || desired < 1 || desired > 500) {
    throw badRequest("seats must be an integer from 1 to 500.");
  }

  const roster = await countSeats(env, ctx.team.id);
  if (desired < roster) {
    throw badRequest(
      `You have ${roster} active member${roster === 1 ? "" : "s"}. Remove people before dropping below that, or keep at least ${roster} seats.`,
    );
  }

  const current = Math.max(ctx.team.seat_quantity ?? roster, roster);

  if (desired > current) {
    await updateSubscriptionQuantity(env, ctx.team.stripe_subscription_id, desired, {
      proration: "create_prorations",
    });
    await env.DB.prepare(
      `UPDATE teams SET seat_quantity = ?, pending_seat_quantity = NULL WHERE id = ?`,
    )
      .bind(desired, ctx.team.id)
      .run();
    await writeAudit(env, ctx.team.id, principal.userId, "billing.seats_increased", null, `${current} → ${desired}`);
  } else if (desired < current) {
    // Schedule downgrade; keep Stripe quantity until period end.
    await env.DB.prepare(`UPDATE teams SET pending_seat_quantity = ? WHERE id = ?`)
      .bind(desired, ctx.team.id)
      .run();
    await writeAudit(
      env,
      ctx.team.id,
      principal.userId,
      "billing.seats_decrease_scheduled",
      null,
      `${current} → ${desired} at period end`,
    );
  } else {
    // Same as current — cancel any pending decrease.
    await env.DB.prepare(`UPDATE teams SET pending_seat_quantity = NULL WHERE id = ?`)
      .bind(ctx.team.id)
      .run();
  }

  const team = await env.DB.prepare("SELECT * FROM teams WHERE id = ?")
    .bind(ctx.team.id)
    .first<TeamRow>();
  const snap = team ? await billingSnapshot(env, team) : null;
  return json({ billing: snap });
}

/** Apply pending seat decreases whose billing period has ended (or force). */
export async function applyPendingSeatDecreases(env: Env): Promise<number> {
  if (!env.STRIPE_SECRET_KEY) return 0;
  const now = nowIso();
  const rows = await env.DB.prepare(
    `SELECT * FROM teams
     WHERE deleted_at IS NULL
       AND pending_seat_quantity IS NOT NULL
       AND stripe_subscription_id IS NOT NULL
       AND billing_period_end IS NOT NULL
       AND billing_period_end <= ?)`,
  )
    .bind(now)
    .all<TeamRow>();

  let applied = 0;
  for (const team of rows.results ?? []) {
    const pending = team.pending_seat_quantity;
    if (pending == null || !team.stripe_subscription_id) continue;
    const roster = await countSeats(env, team.id);
    const target = Math.max(pending, roster, 1);
    try {
      await updateSubscriptionQuantity(env, team.stripe_subscription_id, target, {
        proration: "none",
      });
      await env.DB.prepare(
        `UPDATE teams SET seat_quantity = ?, pending_seat_quantity = NULL WHERE id = ?`,
      )
        .bind(target, team.id)
        .run();
      applied += 1;
    } catch (err) {
      console.error("teams-billing: apply pending seats failed", team.id, err);
    }
  }
  return applied;
}

export async function stripeWebhook(req: Request, env: Env): Promise<Response> {
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return new Response("webhook unconfigured", { status: 503 });
  }
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature");
  const ok = await verifyStripeWebhook(raw, sig, secret);
  if (!ok) return new Response("invalid signature", { status: 400 });

  let event: {
    id: string;
    type: string;
    data?: { object?: Record<string, unknown> };
  };
  try {
    event = JSON.parse(raw) as typeof event;
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // Mark seen only after a successful handler so Stripe retries on failure.
  const seen = await env.DB.prepare("SELECT 1 FROM stripe_webhook_events WHERE id = ?")
    .bind(event.id)
    .first();
  if (seen) return json({ received: true, duplicate: true });

  const obj = event.data?.object ?? {};
  try {
    switch (event.type) {
      case "checkout.session.completed":
        await onCheckoutCompleted(env, obj);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await onSubscription(env, obj);
        break;
      case "customer.subscription.deleted":
        await onSubscriptionDeleted(env, obj);
        break;
      case "invoice.paid":
        await onInvoicePaid(env, obj);
        break;
      case "invoice.payment_failed":
        await onInvoiceFailed(env, obj);
        break;
      default:
        break;
    }
  } catch (err) {
    console.error("teams-billing: webhook handler error", event.type, err);
    return new Response("handler error", { status: 500 });
  }

  await env.DB.prepare(
    "INSERT INTO stripe_webhook_events (id, type, received_at) VALUES (?, ?, ?)",
  )
    .bind(event.id, event.type, nowIso())
    .run();

  return json({ received: true });
}

async function applyCheckoutSession(
  env: Env,
  session: Record<string, unknown>,
): Promise<void> {
  const teamId =
    (session.client_reference_id as string) ||
    ((session.metadata as { team_id?: string } | undefined)?.team_id ?? "");
  if (!teamId) return;

  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : ((session.customer as { id?: string } | null)?.id ?? null);

  let subscriptionId: string | null = null;
  let subObj: Record<string, unknown> | null = null;
  if (typeof session.subscription === "string") {
    subscriptionId = session.subscription;
  } else if (session.subscription && typeof session.subscription === "object") {
    subObj = session.subscription as Record<string, unknown>;
    subscriptionId = (subObj.id as string) ?? null;
  }

  // Prefer full subscription payload so seat qty + period end land immediately.
  if (subscriptionId && env.STRIPE_SECRET_KEY && !subObj?.items) {
    try {
      subObj = await stripeForm(env, "GET", `/subscriptions/${subscriptionId}`, {
        "expand[]": "items.data",
      });
    } catch (err) {
      console.error("teams-billing: fetch subscription after checkout failed", err);
    }
  }

  if (subObj) {
    const meta = {
      ...((subObj.metadata as Record<string, string> | undefined) ?? {}),
      team_id: teamId,
    };
    await onSubscription(env, { ...subObj, metadata: meta, customer: customerId ?? subObj.customer });
    return;
  }

  if (customerId || subscriptionId) {
    const seats = await countSeats(env, teamId);
    await env.DB.prepare(
      `UPDATE teams SET
         stripe_customer_id = COALESCE(?, stripe_customer_id),
         stripe_subscription_id = COALESCE(?, stripe_subscription_id),
         billing_status = 'active',
         seat_quantity = COALESCE(seat_quantity, ?)
       WHERE id = ?`,
    )
      .bind(customerId, subscriptionId, seats, teamId)
      .run();
  }
}

async function onCheckoutCompleted(env: Env, session: Record<string, unknown>): Promise<void> {
  await applyCheckoutSession(env, session);
}

function mapSubStatus(status: string | undefined): BillingStatus {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return "active";
  }
}

async function onSubscription(env: Env, sub: Record<string, unknown>): Promise<void> {
  const teamId =
    (sub.metadata as { team_id?: string } | undefined)?.team_id ||
    (await findTeamByCustomer(env, sub.customer as string | undefined));
  if (!teamId) return;

  const items = (sub.items as { data?: { price?: { id?: string }; quantity?: number; current_period_end?: number }[] })?.data;
  const priceId = items?.[0]?.price?.id ?? null;
  const quantity = items?.[0]?.quantity ?? null;
  const periodEndUnix =
    (typeof sub.current_period_end === "number" ? sub.current_period_end : null) ??
    items?.[0]?.current_period_end ??
    null;
  const periodEnd = periodEndUnix
    ? new Date(Number(periodEndUnix) * 1000).toISOString()
    : null;
  const status = mapSubStatus(sub.status as string | undefined);
  const customerId = (sub.customer as string) ?? null;

  await env.DB.prepare(
    `UPDATE teams SET
       billing_status = ?,
       stripe_subscription_id = ?,
       stripe_customer_id = COALESCE(?, stripe_customer_id),
       stripe_price_id = COALESCE(?, stripe_price_id),
       seat_quantity = COALESCE(?, seat_quantity),
       billing_period_end = COALESCE(?, billing_period_end)
     WHERE id = ?`,
  )
    .bind(
      status,
      sub.id as string,
      customerId,
      priceId,
      quantity,
      periodEnd,
      teamId,
    )
    .run();
}

async function onSubscriptionDeleted(env: Env, sub: Record<string, unknown>): Promise<void> {
  const teamId =
    (sub.metadata as { team_id?: string } | undefined)?.team_id ||
    (await findTeamBySubscription(env, sub.id as string));
  if (!teamId) return;
  await env.DB.prepare(
    `UPDATE teams SET
       billing_status = 'canceled',
       stripe_subscription_id = NULL,
       seat_quantity = NULL,
       billing_period_end = NULL
     WHERE id = ?`,
  )
    .bind(teamId)
    .run();
}

function invoiceSubscriptionId(inv: Record<string, unknown>): string | undefined {
  if (typeof inv.subscription === "string" && inv.subscription) return inv.subscription;
  const parent = inv.parent as
    | { subscription_details?: { subscription?: string } }
    | undefined;
  const nested = parent?.subscription_details?.subscription;
  return typeof nested === "string" && nested ? nested : undefined;
}

async function onInvoicePaid(env: Env, inv: Record<string, unknown>): Promise<void> {
  const subId = invoiceSubscriptionId(inv);
  if (!subId) return;
  const teamId = await findTeamBySubscription(env, subId);
  if (!teamId) return;
  await env.DB.prepare(
    `UPDATE teams SET billing_status = 'active' WHERE id = ? AND billing_status != 'comp'`,
  )
    .bind(teamId)
    .run();
  // New period started — apply any scheduled seat downgrade.
  try {
    await applyPendingSeatDecreases(env);
  } catch (err) {
    console.error("teams-billing: pending seats on invoice.paid", err);
  }
}

async function onInvoiceFailed(env: Env, inv: Record<string, unknown>): Promise<void> {
  const subId = invoiceSubscriptionId(inv);
  if (!subId) return;
  const teamId = await findTeamBySubscription(env, subId);
  if (!teamId) return;
  await env.DB.prepare(
    `UPDATE teams SET billing_status = 'past_due' WHERE id = ? AND billing_status != 'comp'`,
  )
    .bind(teamId)
    .run();
}

async function findTeamByCustomer(env: Env, customerId?: string): Promise<string | null> {
  if (!customerId) return null;
  const row = await env.DB.prepare("SELECT id FROM teams WHERE stripe_customer_id = ?")
    .bind(customerId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function findTeamBySubscription(env: Env, subId?: string): Promise<string | null> {
  if (!subId) return null;
  const row = await env.DB.prepare("SELECT id FROM teams WHERE stripe_subscription_id = ?")
    .bind(subId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

// re-export for createTeam
export { defaultTrialEndsAt };
