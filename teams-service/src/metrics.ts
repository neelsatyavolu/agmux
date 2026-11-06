/**
 * Metric ingest. The desktop sends absolute counters for whole hourly buckets;
 * the server replaces (never adds to) whatever it already holds for that key.
 * That is what makes a retried or duplicated batch converge instead of
 * double-counting, and it is the property the idempotency test pins down.
 */
import type { Env } from "./env";
import { retentionDays } from "./env";
import { listActiveMemberships, nowIso } from "./db";
import { badRequest } from "./http";
import { filterUploadTeamIds } from "./billing/entitlement";

export interface IncomingBucket {
  hourUtc: string; // 'YYYY-MM-DDTHH'
  provider: string;
  model?: string;
  projectKey?: string;
  tokensIn?: number;
  tokensOut?: number;
  tokensCacheRead?: number;
  tokensCacheWrite?: number;
  tokensReasoning?: number;
  costUsd?: number;
  costIncomplete?: boolean;
  activeMs?: number;
  afterHoursMs?: number;
  weekendMs?: number;
  sessions?: number;
  /** Absent from older desktops: stored as NULL (unknown), never zero. */
  sessionsStarted?: number | null;
  turns?: number;
  toolCalls?: number;
  peakConcurrent?: number;
  // Tool mix. Field names must match the desktop's `HourlyBucket` serde output
  // exactly — `teams/uploader.rs` has a test pinning them.
  toolBash?: number;
  toolEdit?: number;
  toolRead?: number;
  toolSearch?: number;
  toolWeb?: number;
  toolAgent?: number;
  toolMcp?: number;
  toolOther?: number;
  toolErrors?: number;
  /** Calls whose outcome the provider actually reports. Not `toolCalls`. */
  toolsMeasured?: number;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  /** Tool-approval prompts answered this hour. */
  approvalRequests?: number;
  /** Sum of ms from approval request → human response. */
  approvalWaitMs?: number;
  localHour?: number;
  localDow?: number;
}

/** Counters for one login's attributed events in one hour (docs/teams-usage-by-login.md). */
export interface IncomingAccountBucket {
  hourUtc: string;
  provider: string; // "claude" | "codex"
  identityHash: string; // 64 lowercase hex
  tokensIn?: number;
  tokensOut?: number;
  tokensCacheRead?: number;
  tokensCacheWrite?: number;
  tokensReasoning?: number;
  costUsd?: number;
  costIncomplete?: boolean;
  activeMs?: number;
  turns?: number;
}

/** A Claude login's email. Stored only for teams with Shared Claude accounts on. */
export interface IncomingAccountLabel {
  provider: "claude";
  identityHash: string;
  label: string;
}

export interface UploadPayload {
  batchId: string;
  /**
   * IANA zone the desktop used for after-hours / weekend / local heatmap
   * (e.g. `America/Los_Angeles`). Optional for older clients; when present the
   * server records it on the user so managers can see which wall clock applied.
   */
  timezone?: string;
  buckets: IncomingBucket[];
  /** Absent from desktops that predate the login split. */
  accountBuckets?: IncomingAccountBucket[];
  accountLabels?: IncomingAccountLabel[];
  /** True from every desktop that reports logins, even with no account buckets. */
  accountsReported?: boolean;
}

/** Loose IANA shape — full zone validation is the desktop's job via chrono-tz. */
const TZ_RE = /^[A-Za-z0-9_+\-\/]{1,64}$/;

export function normalizeTimezone(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || !TZ_RE.test(s)) return null;
  return s;
}

export interface UploadResult {
  accepted: boolean;
  /** Original server receipt time, including idempotent retries. */
  acceptedAt?: string;
  duplicate: boolean;
  bucketsApplied: number;
  teams: string[];
  teamsSkipped?: { id: string; reason: string }[];
}

const HOUR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
const MAX_BUCKETS = 2000;
const MAX_ACCOUNT_BUCKETS = 2000;
const MAX_ACCOUNT_LABELS = 50;
const ACCOUNT_PROVIDERS = new Set(["claude", "codex"]);
const IDENTITY_HASH_RE = /^[0-9a-f]{64}$/;
const MAX_LABEL = 120;

const int = (v: unknown): number => {
  const n = Math.trunc(Number(v ?? 0));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const optionalInt = (v: unknown): number | null => (v === undefined || v === null ? null : int(v));
const clamp = (v: unknown, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, int(v)));

/** Labels are short and never paths — enforced here, not just trusted. */
const label = (v: unknown, max: number): string => {
  if (typeof v !== "string") return "";
  const s = v.trim().slice(0, max);
  // Defence in depth: a path separator means the client sent something it
  // shouldn't have, so drop it rather than store it.
  return s.includes("/") || s.includes("\\") ? "" : s;
};

export interface PrunePayload {
  /** Inclusive lower bound, `YYYY-MM-DDTHH`. */
  sinceHour: string;
  /**
   * Desktop clock at the start of this full sync (ISO). Optional — older
   * clients omit it. Combined with `sync_state.last_upload_at` so prune
   * never uses wall-clock "now" (which is after the upload and would
   * delete the rows that upload just wrote).
   */
  notBefore?: string;
}

const parsedIsoMs = (v: unknown): number | null => {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

export function validatePrunePayload(body: unknown): PrunePayload {
  const p = body as Partial<PrunePayload>;
  if (typeof p?.sinceHour !== "string" || !HOUR_RE.test(p.sinceHour)) {
    throw badRequest("sinceHour must be 'YYYY-MM-DDTHH'.");
  }
  const notBeforeMs = parsedIsoMs(p.notBefore);
  return {
    sinceHour: p.sinceHour,
    notBefore: notBeforeMs != null ? new Date(notBeforeMs).toISOString() : undefined,
  };
}

/**
 * Drop this device's hourly rows in the window that were not refreshed by the
 * current full sync. Used when the desktop stops counting non-agmux sessions
 * so Codex-app / Claude-CLI leftovers disappear instead of lingering until
 * retention.
 *
 * Cutoff is the *start* of this sync — never `now()` at prune time. Upload
 * stamps `updated_at` during apply, then this endpoint runs seconds later;
 * using prune-time `now` deleted the just-uploaded rows and zeroed dashboards.
 */
export async function pruneStale(
  env: Env,
  userId: string,
  deviceId: string,
  payload: PrunePayload,
): Promise<{ deleted: number }> {
  const sync = await env.DB.prepare(
    "SELECT last_upload_at FROM sync_state WHERE user_id = ? AND device_id = ?",
  )
    .bind(userId, deviceId)
    .first<{ last_upload_at: string | null }>();
  const candidates = [parsedIsoMs(sync?.last_upload_at), parsedIsoMs(payload.notBefore)].filter(
    (n): n is number => n != null,
  );
  if (candidates.length === 0) return { deleted: 0 };
  // A team the user still belongs to but uploads skip for billing (read-only
  // after a trial) was not refreshed: its rows are old because nothing is
  // sent, not stale. Keep that history; other teams prune as before.
  const memberships = await listActiveMemberships(env, userId);
  const { skipped } = await filterUploadTeamIds(env, memberships.map((m) => m.team_id));
  const kept = skipped.filter((t) => t.reason === "billing").map((t) => t.id);
  const cutoff = new Date(Math.min(...candidates)).toISOString();
  const stale = (table: string) =>
    env.DB.prepare(
      `DELETE FROM ${table}
        WHERE user_id = ? AND device_id = ?
          AND hour_utc >= ?
          AND updated_at < ?${kept.length ? `
          AND team_id NOT IN (${kept.map(() => "?").join(",")})` : ""}`,
    ).bind(userId, deviceId, payload.sinceHour, cutoff, ...kept);
  const [r, accounts] = await env.DB.batch([stale("metric_hourly"), stale("metric_account_hourly")]);
  return { deleted: Number(r.meta?.changes ?? 0) + Number(accounts.meta?.changes ?? 0) };
}

export function validatePayload(body: unknown): UploadPayload {
  const p = body as Partial<UploadPayload>;
  if (typeof p?.batchId !== "string" || !p.batchId.trim()) {
    throw badRequest("batchId is required.");
  }
  if (!Array.isArray(p.buckets)) throw badRequest("buckets must be an array.");
  if (p.buckets.length > MAX_BUCKETS) {
    throw badRequest(`Too many buckets in one batch (max ${MAX_BUCKETS}).`);
  }
  for (const b of p.buckets) {
    if (!b || typeof b.hourUtc !== "string" || !HOUR_RE.test(b.hourUtc)) {
      throw badRequest("Each bucket needs hourUtc as 'YYYY-MM-DDTHH'.");
    }
    if (typeof b.provider !== "string" || !b.provider.trim()) {
      throw badRequest("Each bucket needs a provider.");
    }
  }
  return {
    batchId: p.batchId.trim().slice(0, 80),
    timezone: normalizeTimezone(p.timezone) ?? undefined,
    buckets: p.buckets,
    accountBuckets: validateAccountBuckets(p.accountBuckets),
    accountLabels: validateAccountLabels(p.accountLabels),
    accountsReported: p.accountsReported === true,
  };
}

function validateAccountBuckets(v: unknown): IncomingAccountBucket[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw badRequest("accountBuckets must be an array.");
  if (v.length > MAX_ACCOUNT_BUCKETS) {
    throw badRequest(`Too many account buckets in one batch (max ${MAX_ACCOUNT_BUCKETS}).`);
  }
  for (const b of v as Partial<IncomingAccountBucket>[]) {
    if (!b || typeof b.hourUtc !== "string" || !HOUR_RE.test(b.hourUtc)) {
      throw badRequest("Each account bucket needs hourUtc as 'YYYY-MM-DDTHH'.");
    }
    if (typeof b.provider !== "string" || !ACCOUNT_PROVIDERS.has(b.provider)) {
      throw badRequest("Each account bucket needs provider claude or codex.");
    }
    if (typeof b.identityHash !== "string" || !IDENTITY_HASH_RE.test(b.identityHash)) {
      throw badRequest("Each account bucket needs a 64-character hex identityHash.");
    }
  }
  return v as IncomingAccountBucket[];
}

/** Labels are dropped (not rejected) when malformed: a bad email must not lose the usage upload. */
function validateAccountLabels(v: unknown): IncomingAccountLabel[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw badRequest("accountLabels must be an array.");
  if (v.length > MAX_ACCOUNT_LABELS) {
    throw badRequest(`Too many account labels (max ${MAX_ACCOUNT_LABELS}).`);
  }
  return (v as Partial<IncomingAccountLabel>[]).flatMap((l) => {
    if (!l || l.provider !== "claude" || typeof l.identityHash !== "string" || !IDENTITY_HASH_RE.test(l.identityHash)) return [];
    if (typeof l.label !== "string") return [];
    const text = l.label.trim();
    if (!text || text.length > MAX_LABEL || /[\u0000-\u001f\u007f]/.test(text)) return [];
    return [{ provider: "claude" as const, identityHash: l.identityHash, label: text }];
  });
}

/**
 * Applies a batch to every team the user is currently an active member of.
 * Fan-out is intentional: one upload feeds all memberships, and each team only
 * ever sees the buckets produced while the user belonged to it.
 */
export async function applyUpload(
  env: Env,
  userId: string,
  deviceId: string,
  payload: UploadPayload,
): Promise<UploadResult> {
  const memberships = await listActiveMemberships(env, userId);
  const allTeamIds = memberships.map((m) => m.team_id);
  const { allowed: teams, skipped: teamsSkipped } = await filterUploadTeamIds(env, allTeamIds);

  const existing = await env.DB.prepare(
    "SELECT bucket_count, accepted_at FROM upload_receipts WHERE device_id = ? AND batch_id = ?",
  )
    .bind(deviceId, payload.batchId)
    .first<{ bucket_count: number; accepted_at: string }>();
  if (existing) {
    // Already applied. Acknowledge so the desktop can drop it from the queue.
    return {
      accepted: true,
      acceptedAt: existing.accepted_at,
      duplicate: true,
      bucketsApplied: existing.bucket_count,
      teams,
      teamsSkipped,
    };
  }

  const now = nowIso();
  const statements: D1PreparedStatement[] = [];

  const upsert = env.DB.prepare(
    `INSERT INTO metric_hourly (
       team_id, user_id, device_id, hour_utc, provider, model, project_key,
       tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, tokens_reasoning, cost_usd, cost_incomplete,
       active_ms, after_hours_ms, weekend_ms, sessions, sessions_started, turns, tool_calls,
       peak_concurrent,
       tool_bash, tool_edit, tool_read, tool_search, tool_web, tool_agent,
       tool_mcp, tool_other, tool_errors, tools_measured,
       files_changed, lines_added, lines_removed,
       approval_requests, approval_wait_ms,
       local_hour, local_dow, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (team_id, user_id, device_id, hour_utc, provider, model, project_key)
     DO UPDATE SET
       tokens_in = excluded.tokens_in,
       tokens_out = excluded.tokens_out,
       tokens_cache_read = excluded.tokens_cache_read,
       tokens_cache_write = excluded.tokens_cache_write,
       tokens_reasoning = excluded.tokens_reasoning,
       cost_usd = excluded.cost_usd,
       cost_incomplete = excluded.cost_incomplete,
       active_ms = excluded.active_ms,
       after_hours_ms = excluded.after_hours_ms,
       weekend_ms = excluded.weekend_ms,
       sessions = excluded.sessions,
       sessions_started = excluded.sessions_started,
       turns = excluded.turns,
       tool_calls = excluded.tool_calls,
       peak_concurrent = excluded.peak_concurrent,
       tool_bash = excluded.tool_bash,
       tool_edit = excluded.tool_edit,
       tool_read = excluded.tool_read,
       tool_search = excluded.tool_search,
       tool_web = excluded.tool_web,
       tool_agent = excluded.tool_agent,
       tool_mcp = excluded.tool_mcp,
       tool_other = excluded.tool_other,
       tool_errors = excluded.tool_errors,
       tools_measured = excluded.tools_measured,
       files_changed = excluded.files_changed,
       lines_added = excluded.lines_added,
       lines_removed = excluded.lines_removed,
       approval_requests = excluded.approval_requests,
       approval_wait_ms = excluded.approval_wait_ms,
       local_hour = excluded.local_hour,
       local_dow = excluded.local_dow,
       updated_at = excluded.updated_at`,
  );

  let latestHour = "";
  for (const teamId of teams) {
    for (const b of payload.buckets) {
      if (b.hourUtc > latestHour) latestHour = b.hourUtc;
      statements.push(
        upsert.bind(
          teamId,
          userId,
          deviceId,
          b.hourUtc,
          label(b.provider, 40) || "unknown",
          label(b.model, 60),
          label(b.projectKey, 64),
          int(b.tokensIn),
          int(b.tokensOut),
          int(b.tokensCacheRead),
          int(b.tokensCacheWrite),
          int(b.tokensReasoning),
          num(b.costUsd),
          b.costIncomplete === false ? 0 : 1,
          int(b.activeMs),
          int(b.afterHoursMs),
          int(b.weekendMs),
          int(b.sessions),
          optionalInt(b.sessionsStarted),
          int(b.turns),
          int(b.toolCalls),
          int(b.peakConcurrent),
          int(b.toolBash),
          int(b.toolEdit),
          int(b.toolRead),
          int(b.toolSearch),
          int(b.toolWeb),
          int(b.toolAgent),
          int(b.toolMcp),
          int(b.toolOther),
          int(b.toolErrors),
          int(b.toolsMeasured),
          int(b.filesChanged),
          int(b.linesAdded),
          int(b.linesRemoved),
          int(b.approvalRequests),
          int(b.approvalWaitMs),
          clamp(b.localHour, 0, 23),
          clamp(b.localDow, 0, 6),
          now,
        ),
      );
    }
  }

  const accountBuckets = payload.accountBuckets ?? [];
  if (accountBuckets.length) {
    const accountUpsert = env.DB.prepare(
      `INSERT INTO metric_account_hourly (
         team_id, user_id, device_id, hour_utc, provider, identity_hash,
         tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, tokens_reasoning,
         cost_usd, cost_incomplete, active_ms, turns, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (team_id, user_id, device_id, hour_utc, provider, identity_hash)
       DO UPDATE SET
         tokens_in = excluded.tokens_in,
         tokens_out = excluded.tokens_out,
         tokens_cache_read = excluded.tokens_cache_read,
         tokens_cache_write = excluded.tokens_cache_write,
         tokens_reasoning = excluded.tokens_reasoning,
         cost_usd = excluded.cost_usd,
         cost_incomplete = excluded.cost_incomplete,
         active_ms = excluded.active_ms,
         turns = excluded.turns,
         updated_at = excluded.updated_at`,
    );
    for (const teamId of teams) {
      for (const b of accountBuckets) {
        if (b.hourUtc > latestHour) latestHour = b.hourUtc;
        statements.push(
          accountUpsert.bind(
            teamId, userId, deviceId, b.hourUtc, b.provider, b.identityHash,
            int(b.tokensIn), int(b.tokensOut), int(b.tokensCacheRead), int(b.tokensCacheWrite),
            int(b.tokensReasoning), num(b.costUsd), b.costIncomplete === false ? 0 : 1,
            int(b.activeMs), int(b.turns), now,
          ),
        );
      }
    }
  }

  const labels = payload.accountLabels ?? [];
  if (labels.length) {
    // The sharing check runs inside the statement, in the same transaction as the write, so an
    // owner turning sharing off (which deletes labels) can't be undone by an upload in flight.
    const labelUpsert = env.DB.prepare(
      `INSERT INTO account_labels (team_id, user_id, provider, identity_hash, label, updated_at)
       SELECT ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM provider_account_settings WHERE team_id = ? AND claude_activity = 1)
       ON CONFLICT (team_id, user_id, provider, identity_hash)
       DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`,
    );
    for (const teamId of teams) {
      for (const l of labels) {
        statements.push(labelUpsert.bind(teamId, userId, l.provider, l.identityHash, l.label, now, teamId));
      }
    }
  }

  statements.push(
    env.DB.prepare(
      `INSERT INTO upload_receipts (device_id, batch_id, user_id, accepted_at, bucket_count)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (device_id, batch_id) DO NOTHING`,
    ).bind(deviceId, payload.batchId, userId, now, payload.buckets.length + accountBuckets.length),
  );
  statements.push(
    env.DB.prepare(
      `INSERT INTO sync_state (user_id, device_id, last_upload_at, last_bucket_hour)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, device_id) DO UPDATE SET
         last_upload_at = excluded.last_upload_at,
         last_bucket_hour = MAX(COALESCE(sync_state.last_bucket_hour, ''), excluded.last_bucket_hour)`,
    ).bind(userId, deviceId, now, latestHour),
  );
  if (payload.accountsReported) {
    statements.push(
      env.DB.prepare(
        "UPDATE sync_state SET accounts_reported_at = ? WHERE user_id = ? AND device_id = ?",
      ).bind(now, userId, deviceId),
    );
  }

  // Persist the member's IANA zone so dashboards can label after-hours /
  // weekend as "their wall clock", not the manager's or UTC.
  if (payload.timezone) {
    statements.push(
      env.DB.prepare(
        `UPDATE users SET timezone = ?, timezone_updated_at = ? WHERE id = ?`,
      ).bind(payload.timezone, now, userId),
    );
  }

  if (statements.length) await env.DB.batch(statements);

  return {
    accepted: true,
    acceptedAt: now,
    duplicate: false,
    bucketsApplied: payload.buckets.length + accountBuckets.length,
    teams,
    teamsSkipped,
  };
}

/** Trims past the retention window. Cheap enough to run on ingest. */
export async function trimRetention(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays(env) * 86_400_000)
    .toISOString()
    .slice(0, 13);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM metric_hourly WHERE hour_utc < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM metric_account_hourly WHERE hour_utc < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM upload_receipts WHERE accepted_at < ?").bind(
      new Date(Date.now() - 7 * 86_400_000).toISOString(),
    ),
  ]);
}
