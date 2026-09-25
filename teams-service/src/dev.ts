/**
 * Local development mode — lets one person exercise the whole product without
 * a Cloudflare account, OAuth apps, or a second human.
 *
 * SAFETY: every dev route goes through `requireDev`, which needs BOTH an
 * explicit `DEV_AUTH=true` var AND a localhost request. `wrangler deploy` never
 * sets that var (it lives only in the `dev` npm script), and even if it leaked
 * into production the host check would still refuse. Failures are 404, not 403,
 * so the routes are invisible when disabled.
 */
import type { Env } from "./env";
import { avatarColor, newId } from "./crypto";
import { nowIso, type Role } from "./db";
import { notFound } from "./http";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host) || host.endsWith(".localhost");
}

/**
 * Dev mode needs TWO independent signals, and `wrangler deploy` supplies
 * neither — both come only from the `dev` npm script:
 *
 *   1. `DEV_AUTH=true`, which is not in wrangler.toml's `[vars]`.
 *   2. `APP_ORIGIN` pointing at a local origin.
 *
 * The request's own hostname is deliberately NOT used: once `routes` names a
 * custom domain, `wrangler dev` simulates that hostname locally, so a
 * request-host check reports `teams.agmux.dev` on localhost and would disable
 * dev mode on the very machine it exists for.
 */
export function devEnabled(env: Env, _req?: Request): boolean {
  // `--var DEV_AUTH:true` JSON-parses the value, so this can arrive as a
  // boolean. Normalise — anything but exactly true/"true" stays off.
  if (String(env.DEV_AUTH) !== "true") return false;
  try {
    return isLocalHost(new URL(env.APP_ORIGIN).hostname);
  } catch {
    return false;
  }
}

export function requireDev(env: Env, req?: Request): void {
  if (!devEnabled(env, req)) throw notFound();
}

/* ── the cast ─────────────────────────────────────────────────────────── */

export interface SeedPerson {
  key: string;
  name: string;
  handle: string;
  role: Role;
  /** Rough activity multiplier, so the leaderboard isn't a flat line. */
  intensity: number;
  /** Share of active time outside 08:00–18:00. */
  afterHours: number;
  providers: { provider: string; model: string; weight: number }[];
  projects: string[];
  /** Never uploads — exercises the "waiting for first sync" honest state. */
  neverSyncs?: boolean;
}

const CLAUDE = { provider: "ClaudeCode", model: "claude-opus-5", weight: 0.6 };
const CLAUDE_S = { provider: "ClaudeCode", model: "claude-sonnet-5", weight: 0.25 };
const CODEX = { provider: "Codex", model: "gpt-5.6-sol", weight: 0.3 };
const GROK = { provider: "Grok", model: "grok-4-code", weight: 0.15 };

/**
 * You are always the first person, as the owner. The rest exist so the
 * leaderboard, heatmap, mix and flags have something real to show.
 */
export const SEED_CAST: SeedPerson[] = [
  {
    key: "you",
    name: "You",
    handle: "you",
    role: "owner",
    intensity: 1.0,
    afterHours: 0.12,
    providers: [CLAUDE, CODEX, GROK],
    projects: ["helios-api", "helios-web"],
  },
  {
    key: "marcus",
    name: "Marcus Webb",
    handle: "mwebb",
    role: "manager",
    intensity: 0.82,
    afterHours: 0.08,
    providers: [CLAUDE, CLAUDE_S, CODEX],
    projects: ["helios-api", "infra-terraform"],
  },
  {
    key: "dani",
    name: "Dani Okafor",
    handle: "dokafor",
    role: "employee",
    intensity: 0.72,
    // Deliberately high — this is what lights up the after-hours flag.
    afterHours: 0.27,
    providers: [CLAUDE, CODEX],
    projects: ["helios-api", "helios-web", "7f3c9a1e"],
  },
  {
    key: "tomas",
    name: "Tomas Lindqvist",
    handle: "tomasl",
    role: "employee",
    intensity: 0.63,
    afterHours: 0.21,
    providers: [CLAUDE, GROK],
    projects: ["helios-web"],
  },
  {
    key: "jules",
    name: "Jules Beaumont",
    handle: "jules",
    role: "employee",
    intensity: 0.52,
    afterHours: 0.05,
    providers: [CODEX, CLAUDE_S],
    projects: ["infra-terraform"],
  },
  {
    key: "ana",
    name: "Ana Sousa",
    handle: "anas",
    role: "employee",
    intensity: 0.46,
    afterHours: 0.09,
    providers: [CLAUDE, CODEX],
    projects: ["helios-api"],
  },
  {
    key: "kenji",
    name: "Kenji Watanabe",
    handle: "kenji",
    role: "employee",
    intensity: 0.3,
    afterHours: 0.04,
    providers: [CLAUDE_S],
    projects: ["helios-web"],
  },
  {
    key: "riley",
    name: "Riley Chen",
    handle: "rchen",
    role: "employee",
    intensity: 0,
    afterHours: 0,
    providers: [],
    projects: [],
    // Joined, accepted the disclosure, never opened the app.
    neverSyncs: true,
  },
];

/* ── deterministic pseudo-random, so reseeding looks the same ─────────── */

function rng(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function hashKey(s: string): number {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export interface SeedBucket {
  userKey: string;
  hourUtc: string;
  provider: string;
  model: string;
  projectKey: string;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  costUsd: number;
  activeMs: number;
  afterHoursMs: number;
  weekendMs: number;
  sessions: number;
  sessionsStarted: number;
  turns: number;
  toolCalls: number;
  peakConcurrent: number;
  toolBash: number;
  toolEdit: number;
  toolRead: number;
  toolSearch: number;
  toolWeb: number;
  toolAgent: number;
  toolMcp: number;
  toolOther: number;
  toolErrors: number;
  toolsMeasured: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  localHour: number;
  localDow: number;
}

/**
 * Splits a tool-call count into a plausible mix.
 *
 * Deliberately shaped like the real logs measured on a dev machine: terminal
 * and edit calls dominate, search and web are thin, and Codex contributes tool
 * calls whose outcome is never observable — which is what makes
 * `toolsMeasured` smaller than `toolCalls` and keeps the honest-denominator
 * path exercised in dev.
 */
function splitToolMix(
  calls: number,
  provider: string,
  rand: () => number,
): Pick<
  SeedBucket,
  | "toolBash" | "toolEdit" | "toolRead" | "toolSearch" | "toolWeb"
  | "toolAgent" | "toolMcp" | "toolOther" | "toolErrors" | "toolsMeasured"
  | "filesChanged" | "linesAdded" | "linesRemoved"
> {
  // Allocated from a running remainder rather than as independent rounded
  // percentages: rounding each share separately lets the parts exceed the
  // whole, and the kind columns must re-sum to `calls` exactly.
  let left = Math.max(0, calls);
  const take = (pct: number) => {
    const n = Math.min(left, Math.round(calls * pct));
    left -= n;
    return n;
  };
  const bash = take(0.36 + rand() * 0.08);
  const edit = take(0.2 + rand() * 0.06);
  const read = take(0.16);
  const search = take(0.08);
  const web = rand() < 0.25 ? take(0.01) : 0;
  const agent = rand() < 0.3 ? take(0.04) : 0;
  const mcp = rand() < 0.4 ? take(0.05) : 0;
  const other = left;

  // Codex reports no general tool outcome, so only a fraction is measurable.
  const measurable = provider === "Codex" ? Math.round(calls * 0.05) : calls;
  const errors = Math.round(measurable * (0.02 + rand() * 0.05));

  const linesAdded = edit > 0 ? Math.round(edit * (12 + rand() * 60)) : 0;
  return {
    toolBash: bash,
    toolEdit: edit,
    toolRead: read,
    toolSearch: search,
    toolWeb: web,
    toolAgent: agent,
    toolMcp: mcp,
    toolOther: other,
    toolErrors: errors,
    toolsMeasured: measurable,
    filesChanged: edit,
    linesAdded,
    linesRemoved: Math.round(linesAdded * (0.15 + rand() * 0.35)),
  };
}

/**
 * Builds a realistic activity history: weekday-heavy, concentrated in working
 * hours, with a per-person after-hours tail and a few idle days. Pure, so the
 * shape is testable without touching a database.
 */
export function generateSeed(cast: SeedPerson[], days: number, now: Date): SeedBucket[] {
  const out: SeedBucket[] = [];
  const midnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  for (const person of cast) {
    if (person.neverSyncs || person.intensity <= 0) continue;
    const rand = rng(hashKey(person.key));

    for (let dayOffset = days - 1; dayOffset >= 0; dayOffset--) {
      const dayStart = new Date(midnightUtc - dayOffset * 86_400_000);
      const dow = (dayStart.getUTCDay() + 6) % 7; // Monday = 0
      const weekend = dow >= 5;

      // Idle days: everyone takes some, weekends are mostly off.
      const idleChance = weekend ? 0.82 : 0.08;
      if (rand() < idleChance) continue;

      const dayScale = person.intensity * (weekend ? 0.3 : 0.85 + rand() * 0.4);
      const hoursToday = Math.max(1, Math.round((weekend ? 2 : 6) * dayScale + rand() * 2));

      for (let i = 0; i < hoursToday; i++) {
        // Working hours by default, with a tail into evenings for some people.
        const afterHours = rand() < person.afterHours;
        const hour = afterHours
          ? rand() < 0.5
            ? 19 + Math.floor(rand() * 4) // 19:00–22:00
            : 6 + Math.floor(rand() * 2) //  06:00–07:00
          : 9 + Math.floor(rand() * 9); //   09:00–17:00

        const provider = pickProvider(person, rand);
        if (!provider) continue;
        const projectKey = person.projects[Math.floor(rand() * person.projects.length)] ?? "";

        const activeMs = Math.round((12 + rand() * 40) * 60_000 * dayScale);
        const turns = Math.max(1, Math.round((2 + rand() * 8) * dayScale));
        const tokensIn = Math.round((8_000 + rand() * 26_000) * dayScale);
        const tokensOut = Math.round((2_000 + rand() * 9_000) * dayScale);
        const cacheRead = Math.round(tokensIn * (1.6 + rand() * 1.8));

        const hourUtc = `${dayStart.toISOString().slice(0, 10)}T${String(hour).padStart(2, "0")}`;
        const toolCalls = Math.round(turns * (1.5 + rand() * 3));

        out.push({
          userKey: person.key,
          hourUtc,
          provider: provider.provider,
          model: provider.model,
          projectKey,
          tokensIn,
          tokensOut,
          tokensCacheRead: cacheRead,
          tokensCacheWrite: Math.round(tokensIn * 0.08),
          // Roughly Claude-ish blended pricing; this is an estimate either way.
          costUsd: +((tokensIn * 3 + tokensOut * 15 + cacheRead * 0.3) / 1_000_000).toFixed(4),
          activeMs,
          afterHoursMs: afterHours ? activeMs : 0,
          weekendMs: weekend ? activeMs : 0,
          sessions: 1,
          // Each seeded row is its own short session.
          sessionsStarted: 1,
          turns,
          toolCalls,
          peakConcurrent: 1 + (rand() < 0.3 ? Math.round(rand() * 3) : 0),
          ...splitToolMix(toolCalls, provider.provider, rand),
          localHour: hour,
          localDow: dow,
        });
      }
    }
  }

  return mergeDuplicates(out);
}

/**
 * Two sessions in the same hour on the same project and model are ONE bucket —
 * that is exactly what the desktop uploader produces, and it is what the
 * `metric_hourly` primary key enforces. Folding here keeps the seed faithful
 * and stops the database silently dropping rows on insert.
 */
function mergeDuplicates(rows: SeedBucket[]): SeedBucket[] {
  const byKey = new Map<string, SeedBucket>();
  for (const r of rows) {
    const key = [r.userKey, r.hourUtc, r.provider, r.model, r.projectKey].join("\u0000");
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...r });
      continue;
    }
    existing.tokensIn += r.tokensIn;
    existing.tokensOut += r.tokensOut;
    existing.tokensCacheRead += r.tokensCacheRead;
    existing.tokensCacheWrite += r.tokensCacheWrite;
    existing.costUsd = +(existing.costUsd + r.costUsd).toFixed(4);
    existing.activeMs += r.activeMs;
    existing.afterHoursMs += r.afterHoursMs;
    existing.weekendMs += r.weekendMs;
    existing.sessions += r.sessions;
    existing.sessionsStarted += r.sessionsStarted;
    existing.turns += r.turns;
    existing.toolCalls += r.toolCalls;
    existing.toolBash += r.toolBash;
    existing.toolEdit += r.toolEdit;
    existing.toolRead += r.toolRead;
    existing.toolSearch += r.toolSearch;
    existing.toolWeb += r.toolWeb;
    existing.toolAgent += r.toolAgent;
    existing.toolMcp += r.toolMcp;
    existing.toolOther += r.toolOther;
    existing.toolErrors += r.toolErrors;
    existing.toolsMeasured += r.toolsMeasured;
    existing.filesChanged += r.filesChanged;
    existing.linesAdded += r.linesAdded;
    existing.linesRemoved += r.linesRemoved;
    // Concurrency is a max, never a sum.
    existing.peakConcurrent = Math.max(existing.peakConcurrent, r.peakConcurrent);
  }
  return [...byKey.values()];
}

function pickProvider(person: SeedPerson, rand: () => number) {
  const total = person.providers.reduce((a, p) => a + p.weight, 0);
  if (total <= 0) return null;
  let r = rand() * total;
  for (const p of person.providers) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  return person.providers[person.providers.length - 1];
}

/* ── applying the seed ────────────────────────────────────────────────── */

export interface SeedResult {
  teamId: string;
  slug: string;
  name: string;
  members: number;
  buckets: number;
  days: number;
}

const TEAM_NAME = "Helios Platform";
const TEAM_SLUG = "helios-platform";

/**
 * Creates (or refreshes) the demo team with `youUserId` as its owner, then
 * fills 90 days of metrics. Re-running replaces the metrics rather than
 * stacking them, so the numbers stay believable.
 */
export async function applySeed(
  env: Env,
  youUserId: string,
  days = 90,
  now = new Date(),
): Promise<SeedResult> {
  const ts = nowIso();

  let team = await env.DB.prepare("SELECT id FROM teams WHERE slug = ?")
    .bind(TEAM_SLUG)
    .first<{ id: string }>();

  if (!team) {
    const teamId = newId("tm");
    await env.DB.prepare(
      "INSERT INTO teams (id, slug, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(teamId, TEAM_SLUG, TEAM_NAME, youUserId, ts)
      .run();
    team = { id: teamId };
  } else {
    await env.DB.prepare("UPDATE teams SET deleted_at = NULL WHERE id = ?").bind(team.id).run();
  }
  const teamId = team.id;

  // Map every cast member to a real user row; "you" reuses the signed-in user.
  const userIdByKey = new Map<string, string>([["you", youUserId]]);

  for (const person of SEED_CAST) {
    let userId = userIdByKey.get(person.key);
    if (!userId) {
      const existing = await env.DB.prepare("SELECT id FROM users WHERE handle = ?")
        .bind(person.handle)
        .first<{ id: string }>();
      if (existing) {
        userId = existing.id;
      } else {
        userId = newId("usr");
        await env.DB.prepare(
          "INSERT INTO users (id, display_name, email, handle, avatar_color, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
          .bind(
            userId,
            person.name,
            `${person.handle}@helios.dev`,
            person.handle,
            avatarColor(person.handle),
            ts,
          )
          .run();
      }
      userIdByKey.set(person.key, userId);
    }

    const joinedAt = new Date(now.getTime() - (30 + SEED_CAST.indexOf(person) * 9) * 86_400_000)
      .toISOString();

    await env.DB.prepare(
      `INSERT INTO team_members (id, team_id, user_id, role, joined_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (team_id, user_id) DO UPDATE SET role = excluded.role, left_at = NULL`,
    )
      .bind(newId("mem"), teamId, userId, person.role, joinedAt)
      .run();
  }

  // Replace, don't accumulate.
  await env.DB.prepare("DELETE FROM metric_hourly WHERE team_id = ?").bind(teamId).run();
  await env.DB.prepare("DELETE FROM sync_state WHERE user_id IN (SELECT user_id FROM team_members WHERE team_id = ?)")
    .bind(teamId)
    .run();

  const buckets = generateSeed(SEED_CAST, days, now);

  // D1 caps bind variables at 100 per statement, so a multi-row VALUES insert
  // is out (35 columns → 2 rows max). `batch` sends many single-row statements
  // in one round trip instead, which is both allowed and fast.
  const insert = env.DB.prepare(
    `INSERT INTO metric_hourly (
       team_id, user_id, device_id, hour_utc, provider, model, project_key,
       tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, cost_usd,
       active_ms, after_hours_ms, weekend_ms, sessions, sessions_started, turns, tool_calls,
       peak_concurrent,
       tool_bash, tool_edit, tool_read, tool_search, tool_web, tool_agent,
       tool_mcp, tool_other, tool_errors, tools_measured,
       files_changed, lines_added, lines_removed,
       local_hour, local_dow, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (team_id, user_id, device_id, hour_utc, provider, model, project_key)
     DO UPDATE SET tokens_in = excluded.tokens_in`,
  );

  const CHUNK = 200;
  for (let i = 0; i < buckets.length; i += CHUNK) {
    await env.DB.batch(
      buckets.slice(i, i + CHUNK).map((b) =>
        insert.bind(
          teamId,
          userIdByKey.get(b.userKey)!,
          `dev-${b.userKey}`,
          b.hourUtc,
          b.provider,
          b.model,
          b.projectKey,
          b.tokensIn,
          b.tokensOut,
          b.tokensCacheRead,
          b.tokensCacheWrite,
          b.costUsd,
          b.activeMs,
          b.afterHoursMs,
          b.weekendMs,
          b.sessions,
          b.sessionsStarted,
          b.turns,
          b.toolCalls,
          b.peakConcurrent,
          b.toolBash,
          b.toolEdit,
          b.toolRead,
          b.toolSearch,
          b.toolWeb,
          b.toolAgent,
          b.toolMcp,
          b.toolOther,
          b.toolErrors,
          b.toolsMeasured,
          b.filesChanged,
          b.linesAdded,
          b.linesRemoved,
          b.localHour,
          b.localDow,
          ts,
        ),
      ),
    );
  }

  // Sync freshness: staggered so the roster shows healthy, stale and never.
  const freshness: Record<string, number | null> = {
    you: 6,
    marcus: 22,
    dani: 60,
    tomas: 240,
    jules: 2880, // 2 days — stale, amber
    ana: 35,
    kenji: 540,
    riley: null, // never synced
  };
  for (const person of SEED_CAST) {
    const mins = freshness[person.key];
    if (mins === null || mins === undefined) continue;
    const userId = userIdByKey.get(person.key)!;
    await env.DB.prepare(
      `INSERT INTO sync_state (user_id, device_id, last_upload_at, last_bucket_hour)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, device_id) DO UPDATE SET last_upload_at = excluded.last_upload_at`,
    )
      .bind(
        userId,
        `dev-${person.key}`,
        new Date(now.getTime() - mins * 60_000).toISOString(),
        new Date(now.getTime() - mins * 60_000).toISOString().slice(0, 13),
      )
      .run();
  }

  return {
    teamId,
    slug: TEAM_SLUG,
    name: TEAM_NAME,
    members: SEED_CAST.length,
    buckets: buckets.length,
    days,
  };
}
