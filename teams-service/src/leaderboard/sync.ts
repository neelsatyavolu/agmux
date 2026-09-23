/**
 * Pull PRs from a team's GitHub App installation into github_prs.
 * Designed for Cloudflare Workers subrequest limits: typically 2–4 GitHub HTTP
 * calls per sync (token + 1–3 GraphQL search pages), not N×PRs.
 *
 * NenuAI orgs: extra batched GraphQL reads Project "Size" → complexity_points.
 */
import type { Env } from "../env";
import { newId } from "../crypto";
import { nowIso } from "../db";
import {
  complexityPointsFromSize,
  isComplexityOrg,
  prRelevantToWindow,
  scorableWindow,
  sizeTier,
  type LeaderboardThresholds,
} from "./score";
import {
  fetchPrComplexityPoints,
  installationToken,
  isBotUser,
  listPullsForRepos,
  prComplexityKey,
  type GhPrWithRepo,
} from "./githubApp";

export interface SettingsRow {
  team_id: string;
  enabled: number;
  github_installation_id: string | null;
  github_org_login: string | null;
  threshold_small_max: number;
  threshold_medium_max: number;
  weight_small: number;
  weight_medium: number;
  weight_large: number;
  weight_merge: number;
  last_sync_at: string | null;
  last_sync_error: string | null;
  sync_cursor: string | null;
  updated_at: string;
}

export async function getSettings(env: Env, teamId: string): Promise<SettingsRow | null> {
  return env.DB.prepare("SELECT * FROM team_leaderboard_settings WHERE team_id = ?")
    .bind(teamId)
    .first<SettingsRow>();
}

export async function ensureSettings(env: Env, teamId: string): Promise<SettingsRow> {
  const existing = await getSettings(env, teamId);
  if (existing) return existing;
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO team_leaderboard_settings (
       team_id, enabled, threshold_small_max, threshold_medium_max,
       weight_small, weight_medium, weight_large, weight_merge, updated_at
     ) VALUES (?, 0, 100, 500, 1, 2, 4, 0.5, ?)`,
  )
    .bind(teamId, now)
    .run();
  return (await getSettings(env, teamId))!;
}

export async function listSelectedRepos(env: Env, teamId: string): Promise<string[]> {
  const r = await env.DB.prepare(
    "SELECT repo_full_name FROM team_leaderboard_repos WHERE team_id = ? ORDER BY repo_full_name",
  )
    .bind(teamId)
    .all<{ repo_full_name: string }>();
  return (r.results ?? []).map((x) => x.repo_full_name);
}

export async function syncTeam(
  env: Env,
  teamId: string,
): Promise<{ upserted: number; error?: string; partial?: boolean; httpCalls?: number }> {
  const settings = await getSettings(env, teamId);
  if (!settings?.enabled || !settings.github_installation_id) {
    return { upserted: 0, error: "Leaderboard not enabled or GitHub not connected." };
  }
  const repos = await listSelectedRepos(env, teamId);
  if (!repos.length) {
    await markSync(env, teamId, null, "No repositories selected.");
    return { upserted: 0, error: "No repositories selected." };
  }

  const window = scorableWindow();
  // Always look back to the start of the previous ISO week for the scorable window.
  // Do not walk unbounded history via a stale cursor — that blew subrequest budgets.
  const lookback = window.start;

  let upserted = 0;
  try {
    const token = await installationToken(env, settings.github_installation_id);
    const thresholds: LeaderboardThresholds = {
      smallMax: settings.threshold_small_max,
      mediumMax: settings.threshold_medium_max,
    };

    const { pulls, httpCalls: listCalls } = await listPullsForRepos(
      token,
      repos,
      lookback,
      settings.github_org_login,
    );

    const existingKeys = new Set(
      (
        await env.DB.prepare(
          "SELECT repo_full_name || '#' || pr_number AS k FROM github_prs WHERE team_id = ?",
        )
          .bind(teamId)
          .all<{ k: string }>()
      ).results?.map((r) => r.k) ?? [],
    );

    const toUpsert: Array<{ pr: GhPrWithRepo; exists: boolean }> = [];
    let maxUpdated = lookback;
    for (const pr of pulls) {
      const key = `${pr.repo_full_name}#${pr.number}`;
      const exists = existingKeys.has(key);
      const relevant = prRelevantToWindow(
        { openedAt: pr.created_at, mergedAt: pr.merged_at },
        window.start,
        window.end,
      );
      if (!relevant && !exists) continue;
      toUpsert.push({ pr, exists });
      existingKeys.add(key);
      if (pr.updated_at > maxUpdated) maxUpdated = pr.updated_at;
    }

    // NenuAI: Project Size → complexity points (soft-fail → LOC tiers).
    let complexityMap = new Map<string, number>();
    let complexityCalls = 0;
    let complexityWarn: string | null = null;
    if (isComplexityOrg(settings.github_org_login) && toUpsert.length) {
      const fetched = await fetchPrComplexityPoints(
        token,
        toUpsert.map(({ pr }) => ({ repo_full_name: pr.repo_full_name, number: pr.number })),
        complexityPointsFromSize,
      );
      complexityMap = fetched.map;
      complexityCalls = fetched.httpCalls;
      if (fetched.error) {
        // Owners must grant Projects: Read on the GitHub App install.
        complexityWarn = `Complexity Size: ${fetched.error}`;
      } else if (complexityMap.size === 0) {
        complexityWarn =
          "No Project Size on PRs — grant the App Projects: Read and ensure Size is set (autopr). Falling back to line-count tiers.";
      }
    }

    const stmts: D1PreparedStatement[] = [];
    const now = nowIso();
    for (const { pr, exists } of toUpsert) {
      const cKey = prComplexityKey(pr.repo_full_name, pr.number);
      const pts = complexityMap.has(cKey) ? (complexityMap.get(cKey) as number) : null;
      stmts.push(upsertPrStmt(env, teamId, pr, thresholds, now, exists, pts));
      upserted += 1;
    }

    // Batch D1 writes (still local to the Worker — not GitHub subrequests).
    for (let i = 0; i < stmts.length; i += 40) {
      await env.DB.batch(stmts.slice(i, i + 40));
    }

    // Soft complexity warn is stored as last_sync_error so settings UI can surface it.
    await markSync(env, teamId, maxUpdated, complexityWarn);
    return {
      upserted,
      httpCalls: listCalls + complexityCalls + 1 /* token */,
      ...(complexityWarn ? { partial: true, error: complexityWarn } : {}),
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : "Sync failed.";
    const msg = raw
      .replace(/\s*To configure this limit[\s\S]*$/i, "")
      .replace(/Too many subrequests by single Worker invocation\.?/i, "Sync too heavy — try again (now uses fewer GitHub calls).")
      .trim()
      .slice(0, 200);
    await markSync(env, teamId, settings.sync_cursor, msg || "Sync failed.");
    return { upserted, error: msg || "Sync failed." };
  }
}

function upsertPrStmt(
  env: Env,
  teamId: string,
  pr: GhPrWithRepo,
  thresholds: LeaderboardThresholds,
  now: string,
  exists: boolean,
  complexityPoints: number | null,
): D1PreparedStatement {
  const additions = Number(pr.additions ?? 0);
  const deletions = Number(pr.deletions ?? 0);
  const tier = sizeTier(additions + deletions, thresholds);
  const bot = isBotUser(pr.user) ? 1 : 0;
  const authorId = String(pr.user?.id ?? "0");
  const login = pr.user?.login ?? "";

  if (exists) {
    return env.DB.prepare(
      `UPDATE github_prs SET
         author_github_id = ?, author_login = ?, opened_at = ?, merged_at = ?, closed_at = ?,
         additions = ?, deletions = ?, size_tier = ?, complexity_points = ?, is_bot = ?,
         updated_at_github = ?, synced_at = ?
       WHERE team_id = ? AND repo_full_name = ? AND pr_number = ?`,
    ).bind(
      authorId,
      login,
      pr.created_at,
      pr.merged_at,
      pr.closed_at,
      additions,
      deletions,
      tier,
      complexityPoints,
      bot,
      pr.updated_at,
      now,
      teamId,
      pr.repo_full_name,
      pr.number,
    );
  }

  return env.DB.prepare(
    `INSERT INTO github_prs (
       id, team_id, repo_full_name, pr_number, author_github_id, author_login,
       opened_at, merged_at, closed_at, additions, deletions, size_tier, complexity_points, is_bot,
       updated_at_github, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(team_id, repo_full_name, pr_number) DO UPDATE SET
       author_github_id = excluded.author_github_id,
       author_login = excluded.author_login,
       opened_at = excluded.opened_at,
       merged_at = excluded.merged_at,
       closed_at = excluded.closed_at,
       additions = excluded.additions,
       deletions = excluded.deletions,
       size_tier = excluded.size_tier,
       complexity_points = excluded.complexity_points,
       is_bot = excluded.is_bot,
       updated_at_github = excluded.updated_at_github,
       synced_at = excluded.synced_at`,
  ).bind(
    newId("gpr"),
    teamId,
    pr.repo_full_name,
    pr.number,
    authorId,
    login,
    pr.created_at,
    pr.merged_at,
    pr.closed_at,
    additions,
    deletions,
    tier,
    complexityPoints,
    bot,
    pr.updated_at,
    now,
  );
}

async function markSync(
  env: Env,
  teamId: string,
  cursor: string | null,
  error: string | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE team_leaderboard_settings
     SET last_sync_at = ?, last_sync_error = ?, sync_cursor = COALESCE(?, sync_cursor), updated_at = ?
     WHERE team_id = ?`,
  )
    .bind(nowIso(), error, cursor, nowIso(), teamId)
    .run();
}

/**
 * Cron: at most 2 teams per hourly tick (oldest sync first).
 * Each team ≈ 2–3 GitHub HTTP calls + token — keeps cron well under paid limits
 * even with many teams on the account.
 */
export async function runLeaderboardSyncs(env: Env): Promise<void> {
  const r = await env.DB.prepare(
    `SELECT team_id FROM team_leaderboard_settings
     WHERE enabled = 1 AND github_installation_id IS NOT NULL
     ORDER BY COALESCE(last_sync_at, '') ASC
     LIMIT 2`,
  ).all<{ team_id: string }>();
  for (const row of r.results ?? []) {
    try {
      await syncTeam(env, row.team_id);
    } catch {
      // next tick retries
    }
  }
}
