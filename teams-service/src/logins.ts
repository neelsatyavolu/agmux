/**
 * Usage split by provider login for one member (docs/teams-usage-by-login.md).
 *
 * The desktop attributes each Claude/Codex event to the login its session ran
 * under and uploads those counters separately (`metric_account_hourly`). What it
 * could not attribute — sessions from before the feature, or launched where the
 * login was unknown — is the provider total minus the attributed part, shown as
 * its own "Not attributed" row rather than spread across logins.
 */
import type { Env } from "./env";
import { totals, type Bucket } from "./aggregate";

export const LOGIN_PROVIDERS = ["claude", "codex"] as const;
export type LoginProvider = (typeof LOGIN_PROVIDERS)[number];

export interface AccountSum {
  provider: string;
  identity_hash: string;
  tokens: number;
  cost_usd: number;
  cost_incomplete: number; // 0/1: any contributing hour incomplete
  active_ms: number;
}

export interface ProviderTotal {
  tokens: number;
  costUsd: number;
  costIncomplete: boolean;
}

export interface LoginRow {
  provider: LoginProvider;
  /** null for the "Not attributed" remainder. */
  identityHash: string | null;
  name: string;
  /** Where the name came from: the member's Claude email, a team pool account, or a number. */
  nameSource: "email" | "team" | "number" | "none";
  tokens: number;
  costUsd: number;
  costIncomplete: boolean;
  activeHours: number;
  /** Fraction of this provider's tokens for the member in the range; null when the total is 0. */
  share: number | null;
}

export interface LoginsView {
  /** False when no device of this member has ever reported logins (older app). */
  reported: boolean;
  rows: LoginRow[];
}

const PROVIDER_NAMES: Record<LoginProvider, string> = { claude: "Claude", codex: "Codex" };

/**
 * Pure: builds the rows. `known` lists every login hash the member has reported
 * for the provider (any range), so "Claude login 2" keeps its number when the
 * range changes.
 */
export function buildLogins(input: {
  reported: boolean;
  sums: AccountSum[];
  totals: Record<LoginProvider, ProviderTotal>;
  known: Record<LoginProvider, string[]>;
  emails: Map<string, string>; // `${provider}:${hash}` → email (only when sharing is on)
  pool: Map<string, string>; // `${provider}:${hash}` → team pool account label
}): LoginsView {
  if (!input.reported) return { reported: false, rows: [] };
  const rows: LoginRow[] = [];
  for (const provider of LOGIN_PROVIDERS) {
    const total = input.totals[provider];
    const share = (tokens: number) => (total.tokens > 0 ? Math.min(1, tokens / total.tokens) : null);
    const numbers = new Map([...input.known[provider]].sort().map((hash, i) => [hash, i + 1]));
    const sums = input.sums.filter((s) => s.provider === provider);
    let attributedTokens = 0;
    let attributedCost = 0;
    const loginRows: LoginRow[] = sums.map((s) => {
      attributedTokens += s.tokens;
      attributedCost += s.cost_usd;
      const key = `${provider}:${s.identity_hash}`;
      const email = input.emails.get(key);
      const team = input.pool.get(key);
      const name = email ?? team ?? `${PROVIDER_NAMES[provider]} login ${numbers.get(s.identity_hash) ?? numbers.size + 1}`;
      return {
        provider,
        identityHash: s.identity_hash,
        name,
        nameSource: email ? "email" : team ? "team" : "number",
        tokens: s.tokens,
        costUsd: s.cost_usd,
        costIncomplete: s.cost_incomplete === 1,
        activeHours: s.active_ms / 3_600_000,
        share: share(s.tokens),
      };
    });
    loginRows.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
    rows.push(...loginRows);
    const rest = Math.max(0, total.tokens - attributedTokens);
    if (rest > 0) {
      rows.push({
        provider,
        identityHash: null,
        name: "Not attributed",
        nameSource: "none",
        tokens: rest,
        costUsd: Math.max(0, total.costUsd - attributedCost),
        costIncomplete: total.costIncomplete,
        activeHours: 0,
        share: share(rest),
      });
    }
  }
  return { reported: true, rows };
}

/** Reads what `buildLogins` needs for one member and window. */
export async function memberLogins(
  env: Env,
  teamId: string,
  userId: string,
  sinceHour: string,
  untilHour: string | null,
  totals: Record<LoginProvider, ProviderTotal>,
): Promise<LoginsView> {
  const range = untilHour ? " AND hour_utc < ?" : "";
  const rangeArgs = untilHour ? [untilHour] : [];
  const [reportedRow, sums, known, labels, pool, sharing] = await Promise.all([
    env.DB.prepare(
      "SELECT 1 AS yes FROM sync_state WHERE user_id = ? AND accounts_reported_at IS NOT NULL LIMIT 1",
    ).bind(userId).first<{ yes: number }>(),
    env.DB.prepare(
      `SELECT provider, identity_hash,
              SUM(tokens_in + tokens_out + tokens_cache_read + tokens_cache_write) AS tokens,
              SUM(cost_usd) AS cost_usd, MAX(cost_incomplete) AS cost_incomplete,
              SUM(active_ms) AS active_ms
         FROM metric_account_hourly
        WHERE team_id = ? AND user_id = ? AND hour_utc >= ?${range}
        GROUP BY provider, identity_hash`,
    ).bind(teamId, userId, sinceHour, ...rangeArgs).all<AccountSum>(),
    env.DB.prepare(
      "SELECT DISTINCT provider, identity_hash FROM metric_account_hourly WHERE team_id = ? AND user_id = ?",
    ).bind(teamId, userId).all<{ provider: string; identity_hash: string }>(),
    env.DB.prepare(
      "SELECT provider, identity_hash, label FROM account_labels WHERE team_id = ? AND user_id = ?",
    ).bind(teamId, userId).all<{ provider: string; identity_hash: string; label: string }>(),
    env.DB.prepare(
      "SELECT provider, identity_hash, label FROM provider_accounts WHERE team_id = ? AND identity_hash IS NOT NULL",
    ).bind(teamId).all<{ provider: string; identity_hash: string; label: string }>(),
    env.DB.prepare(
      "SELECT claude_activity FROM provider_account_settings WHERE team_id = ?",
    ).bind(teamId).first<{ claude_activity: number }>(),
  ]);
  const knownBy: Record<LoginProvider, string[]> = { claude: [], codex: [] };
  for (const k of known.results) {
    if (k.provider === "claude" || k.provider === "codex") knownBy[k.provider].push(k.identity_hash);
  }
  // Labels are deleted when sharing is turned off; the check here also covers a
  // label written in the same second the owner turned it off.
  const emails = new Map(
    sharing?.claude_activity === 1
      ? labels.results.map((l) => [`${l.provider}:${l.identity_hash}`, l.label] as const)
      : [],
  );
  return buildLogins({
    reported: !!reportedRow,
    sums: sums.results,
    totals,
    known: knownBy,
    emails,
    pool: new Map(pool.results.map((p) => [`${p.provider}:${p.identity_hash}`, p.label] as const)),
  });
}

/** `metric_hourly.provider` uses the app's provider names; logins use the pool's. */
const METRIC_PROVIDER: Record<LoginProvider, string> = { claude: "ClaudeCode", codex: "Codex" };

/** Per-provider totals the login split is measured against. */
export function providerTotals(buckets: Bucket[]): Record<LoginProvider, ProviderTotal> {
  return Object.fromEntries(
    LOGIN_PROVIDERS.map((provider) => {
      const t = totals(buckets.filter((b) => b.provider === METRIC_PROVIDER[provider]));
      return [provider, { tokens: t.tokens, costUsd: t.costUsd, costIncomplete: t.costIncomplete }];
    }),
  ) as Record<LoginProvider, ProviderTotal>;
}
