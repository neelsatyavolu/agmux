/**
 * Minimal Stripe REST client for Workers (no SDK).
 * Form-urlencoded bodies; Bearer secret key.
 */
import type { Env } from "../env";
import { badRequest, HttpError } from "../http";

const API = "https://api.stripe.com/v1";

export function requireStripe(env: Env): string {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    throw new HttpError(
      503,
      "Billing is not configured yet (missing STRIPE_SECRET_KEY).",
      "billing_unconfigured",
    );
  }
  return key;
}

export function priceIdForInterval(env: Env, interval: "month" | "year"): string {
  const id =
    interval === "year"
      ? env.STRIPE_PRICE_ANNUAL?.trim()
      : env.STRIPE_PRICE_MONTHLY?.trim();
  if (!id) {
    throw new HttpError(
      503,
      `Billing is not configured yet (missing STRIPE_PRICE_${interval === "year" ? "ANNUAL" : "MONTHLY"}).`,
      "billing_unconfigured",
    );
  }
  return id;
}

export async function stripeForm(
  env: Env,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | number | undefined | null> = {},
): Promise<Record<string, unknown>> {
  const key = requireStripe(env);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    body.set(k, String(v));
  }
  const url =
    (method === "GET" || method === "DELETE") && body.toString()
      ? `${API}${path}?${body.toString()}`
      : `${API}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(method === "POST"
        ? { "content-type": "application/x-www-form-urlencoded" }
        : {}),
    },
    body: method === "POST" ? body.toString() : undefined,
  });
  const json = (await res.json()) as Record<string, unknown> & {
    error?: { message?: string };
  };
  if (!res.ok) {
    const msg = json.error?.message ?? `Stripe error (${res.status})`;
    throw new HttpError(res.status >= 500 ? 502 : 400, msg, "stripe_error");
  }
  return json;
}

/** Immediate cancel — used when a team is deleted (no period left to serve). */
export async function cancelSubscription(env: Env, subscriptionId: string): Promise<void> {
  const id = subscriptionId.trim();
  if (!id) return;
  await stripeForm(env, "DELETE", `/subscriptions/${encodeURIComponent(id)}`);
}

/** Nested form keys for Checkout line_items[0][price]=… */
export async function createCheckoutSession(
  env: Env,
  args: {
    teamId: string;
    teamSlug: string;
    customerId?: string | null;
    customerEmail?: string | null;
    priceId: string;
    quantity: number;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<{ id: string; url: string }> {
  const qty = Math.max(1, Math.trunc(args.quantity));
  const params: Record<string, string | number> = {
    mode: "subscription",
    // Stripe substitutes {CHECKOUT_SESSION_ID} so we can confirm payment client-side
    // if the webhook is delayed.
    success_url: args.successUrl.includes("{CHECKOUT_SESSION_ID}")
      ? args.successUrl
      : `${args.successUrl}${args.successUrl.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: args.cancelUrl,
    "line_items[0][price]": args.priceId,
    "line_items[0][quantity]": qty,
    "subscription_data[metadata][team_id]": args.teamId,
    "metadata[team_id]": args.teamId,
    "metadata[team_slug]": args.teamSlug,
    client_reference_id: args.teamId,
    allow_promotion_codes: "true",
    // Account has Managed Payments on by default; we collect card for
    // subscriptions ourselves. Product also has tax_code=txcd_10103001 (SaaS).
    "managed_payments[enabled]": "false",
  };
  if (args.customerId) {
    params.customer = args.customerId;
  } else if (args.customerEmail) {
    params.customer_email = args.customerEmail;
  }
  const session = await stripeForm(env, "POST", "/checkout/sessions", params);
  const url = session.url as string | undefined;
  const id = session.id as string | undefined;
  if (!url || !id) throw badRequest("Stripe Checkout did not return a URL.");
  return { id, url };
}

export async function createPortalSession(
  env: Env,
  customerId: string,
  returnUrl: string,
): Promise<{ url: string }> {
  const session = await stripeForm(env, "POST", "/billing_portal/sessions", {
    customer: customerId,
    return_url: returnUrl,
  });
  const url = session.url as string | undefined;
  if (!url) throw badRequest("Stripe Portal did not return a URL.");
  return { url };
}

/**
 * Update licensed seat quantity on the subscription item.
 * - Increases: proration create_prorations (charge immediately).
 * - Decreases: proration_behavior none (no mid-period credit; call at period end).
 */
export async function updateSubscriptionQuantity(
  env: Env,
  subscriptionId: string,
  quantity: number,
  opts: { proration?: "create_prorations" | "none" | "always_invoice" } = {},
): Promise<void> {
  const qty = Math.max(1, Math.trunc(quantity));
  const proration = opts.proration ?? "create_prorations";
  const sub = await stripeForm(env, "GET", `/subscriptions/${subscriptionId}`, {
    "expand[]": "items.data",
  });
  const items = (sub.items as { data?: { id: string }[] } | undefined)?.data;
  const itemId = items?.[0]?.id;
  if (!itemId) throw badRequest("Subscription has no items to update.");
  await stripeForm(env, "POST", `/subscription_items/${itemId}`, {
    quantity: qty,
    proration_behavior: proration,
  });
}

export async function verifyStripeWebhook(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !secret) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => {
      const [k, v] = p.split("=");
      return [k?.trim() ?? "", v?.trim() ?? ""];
    }),
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts)) return false;
  // 5 minute tolerance
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqualHex(expected, v1);
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
