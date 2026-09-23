export interface Env {
  DB: D1Database;
  /** Required base64 32-byte AES-GCM key for explicitly shared team OAuth accounts. */
  PROVIDER_ACCOUNTS_KEY?: string;
  ASSETS: Fetcher;

  APP_ORIGIN: string;
  RETENTION_DAYS: string;
  INVITE_TTL_DAYS: string;

  /**
   * "true" only via the `dev` npm script. Never set by `wrangler deploy`, and
   * `dev.ts` additionally requires a localhost request before honouring it.
   */
  DEV_AUTH?: string;

  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;

  /** GitHub App (org leaderboard PR sync) — not the user OAuth app. */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /** App slug for install URL: github.com/apps/{slug}/installations/new */
  GITHUB_APP_SLUG?: string;

  /**
   * When "true", paywall/gates apply after trial. Default off until release.
   * Billing UI + webhooks still work so we can dogfood Checkout without locking teams.
   */
  BILLING_ENFORCE?: string;

  /** Stripe Billing — set via wrangler secret / .dev.vars; never commit sk_ keys. */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** price_… for $12/seat/mo */
  STRIPE_PRICE_MONTHLY?: string;
  /** price_… for $120/seat/yr ($10/mo) */
  STRIPE_PRICE_ANNUAL?: string;

  /** Optional HMAC secret for Knowledge thread_id_hash (falls back to APP_ORIGIN). */
  KNOWLEDGE_HMAC_SECRET?: string;

  /**
   * When "false", Knowledge stays dark even if kw_* tables exist (rollback).
   * Default: on once schema is migrated. Older app versions never call Knowledge.
   */
  KNOWLEDGE_ENABLED?: string;
}

/** App-managed free trial length (days) from team create. */
export const TRIAL_DAYS = 30;
/** After trial ends without sub, dashboards stay readable this many days. */
export const BILLING_GRACE_DAYS = 14;

export function billingEnforce(env: Env): boolean {
  return env.BILLING_ENFORCE === "true";
}

export function retentionDays(env: Env): number {
  const n = Number(env.RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 90;
}

export function inviteTtlDays(env: Env): number {
  const n = Number(env.INVITE_TTL_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 14;
}
