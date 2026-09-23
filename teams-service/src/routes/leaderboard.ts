/**
 * Optional PR leaderboard — owner config + manager/owner week view.
 */
import type { Env } from "../env";
import { mintToken, timingSafeEqual } from "../crypto";
import { nowIso } from "../db";
import { badRequest, forbidden, json, parseCookies, readJson, redirect } from "../http";
import { can, requireCapability, requireTeam } from "../authz";
import { requirePaidPlanFeatures } from "../billing/entitlement";
import type { Principal } from "../session";
import { authenticate } from "../session";
import { writeAudit } from "./audit";
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  isComplexityOrg,
  isoWeekId,
  scoreWeek,
  validateThresholds,
  validateWeights,
  weekBounds,
  type LeaderboardWeights,
  type PrForScore,
  type ScoringMode,
} from "../leaderboard/score";
import {
  ensureSettings,
  getSettings,
  listSelectedRepos,
  syncTeam,
  type SettingsRow,
} from "../leaderboard/sync";
import {
  getInstallation,
  githubAppConfigured,
  installUrl,
  installationToken,
  listInstallationRepos,
} from "../leaderboard/githubApp";

const INSTALL_STATE_COOKIE = "__Host-agmux_lb_install";
/** Manual sync cooldown — prevents click-spam from burning Workers + GitHub quota. */
const SYNC_COOLDOWN_MS = 120_000;
const lastManualSync = new Map<string, number>();
/** Repo-list cache (installation token + list is the expensive settings path). */
const REPO_LIST_TTL_MS = 15 * 60_000;
const repoListCache = new Map<
  string,
  { at: number; available: Array<{ fullName: string; private: boolean }> }
>();

function publicSettings(row: SettingsRow | null, isOwner: boolean) {
  if (!row) {
    return {
      enabled: false,
      installationConnected: false,
      githubOrgLogin: null as string | null,
      scoringMode: "lines" as ScoringMode,
      thresholds: DEFAULT_THRESHOLDS,
      weights: DEFAULT_WEIGHTS,
      lastSyncAt: null as string | null,
      lastSyncError: null as string | null,
      canManage: isOwner,
      appConfigured: false,
    };
  }
  return {
    enabled: row.enabled === 1,
    installationConnected: Boolean(row.github_installation_id),
    githubOrgLogin: row.github_org_login,
    scoringMode: (isComplexityOrg(row.github_org_login) ? "complexity" : "lines") as ScoringMode,
    thresholds: {
      smallMax: row.threshold_small_max,
      mediumMax: row.threshold_medium_max,
    },
    weights: {
      small: row.weight_small,
      medium: row.weight_medium,
      large: row.weight_large,
      merge: row.weight_merge,
    },
    lastSyncAt: row.last_sync_at,
    lastSyncError: isOwner ? row.last_sync_error : row.last_sync_error ? "Sync error" : null,
    canManage: isOwner,
    appConfigured: false, // filled by caller
  };
}

export async function getLeaderboardSettings(
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "leaderboard.view");
  const row = await getSettings(env, ctx.team.id);
  const data = publicSettings(row, can(ctx.role, "leaderboard.manage"));
  data.appConfigured = githubAppConfigured(env);
  // Soft signal for UI; mutating endpoints still hard-gate with requirePaidPlanFeatures.
  try {
    await requirePaidPlanFeatures(env, ctx.team, "read");
    (data as { planRequired?: boolean }).planRequired = false;
  } catch {
    (data as { planRequired?: boolean }).planRequired = true;
  }
  return json({ settings: data });
}

export async function patchLeaderboardSettings(
  req: Request,
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "leaderboard.manage");
  await requirePaidPlanFeatures(env, ctx.team, "write");
  const body = await readJson<{
    enabled?: boolean;
    thresholds?: { smallMax?: number; mediumMax?: number };
    weights?: Partial<LeaderboardWeights>;
    unlink?: boolean;
  }>(req);

  const row = await ensureSettings(env, ctx.team.id);
  let enabled = row.enabled;
  let smallMax = row.threshold_small_max;
  let mediumMax = row.threshold_medium_max;
  let weights: LeaderboardWeights = {
    small: row.weight_small,
    medium: row.weight_medium,
    large: row.weight_large,
    merge: row.weight_merge,
  };
  let installationId = row.github_installation_id;
  let orgLogin = row.github_org_login;

  if (typeof body.enabled === "boolean") enabled = body.enabled ? 1 : 0;

  if (body.thresholds) {
    if (body.thresholds.smallMax !== undefined) smallMax = Math.trunc(Number(body.thresholds.smallMax));
    if (body.thresholds.mediumMax !== undefined) mediumMax = Math.trunc(Number(body.thresholds.mediumMax));
    const err = validateThresholds(smallMax, mediumMax);
    if (err) throw badRequest(err);
  }

  if (body.weights) {
    weights = {
      small: body.weights.small !== undefined ? Number(body.weights.small) : weights.small,
      medium: body.weights.medium !== undefined ? Number(body.weights.medium) : weights.medium,
      large: body.weights.large !== undefined ? Number(body.weights.large) : weights.large,
      merge: body.weights.merge !== undefined ? Number(body.weights.merge) : weights.merge,
    };
    const err = validateWeights(weights);
    if (err) throw badRequest(err);
  }

  if (body.unlink) {
    installationId = null;
    orgLogin = null;
    await writeAudit(env, ctx.team.id, principal.userId, "leaderboard.unlinked", null, null);
  }

  const now = nowIso();
  await env.DB.prepare(
    `UPDATE team_leaderboard_settings SET
       enabled = ?, threshold_small_max = ?, threshold_medium_max = ?,
       weight_small = ?, weight_medium = ?, weight_large = ?, weight_merge = ?,
       github_installation_id = ?, github_org_login = ?, updated_at = ?
     WHERE team_id = ?`,
  )
    .bind(
      enabled,
      smallMax,
      mediumMax,
      weights.small,
      weights.medium,
      weights.large,
      weights.merge,
      installationId,
      orgLogin,
      now,
      ctx.team.id,
    )
    .run();

  if (typeof body.enabled === "boolean") {
    await writeAudit(
      env,
      ctx.team.id,
      principal.userId,
      body.enabled ? "leaderboard.enabled" : "leaderboard.disabled",
      null,
      null,
    );
  } else if (body.thresholds || body.weights) {
    await writeAudit(env, ctx.team.id, principal.userId, "leaderboard.settings_updated", null, null);
  }

  const updated = await getSettings(env, ctx.team.id);
  const data = publicSettings(updated, true);
  data.appConfigured = githubAppConfigured(env);
  return json({ settings: data });
}

export async function getInstallUrl(
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "leaderboard.manage");
  await requirePaidPlanFeatures(env, ctx.team, "write");
  if (!githubAppConfigured(env)) {
    throw badRequest("GitHub App isn't configured on this server yet.");
  }
  await ensureSettings(env, ctx.team.id);
  const nonce = mintToken(16);
  const blob = JSON.stringify({ nonce, teamId: ctx.team.id, userId: principal.userId });
  const url = installUrl(env, nonce);
  const cookie = `${INSTALL_STATE_COOKIE}=${encodeURIComponent(blob)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=900`;
  return json({ url }, { headers: { "set-cookie": cookie } });
}

/**
 * GitHub App setup callback: ?installation_id=&setup_action=&state=
 * state must match the cookie nonce.
 */
export async function installCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const installationId = url.searchParams.get("installation_id");
  const state = url.searchParams.get("state");
  if (!installationId || !state) {
    return redirect(`${env.APP_ORIGIN}/#/teams?lb=install_failed`);
  }

  const raw = parseCookies(req.headers.get("cookie"))[INSTALL_STATE_COOKIE];
  if (!raw) return redirect(`${env.APP_ORIGIN}/#/teams?lb=install_expired`);
  let blob: { nonce: string; teamId: string; userId: string };
  try {
    blob = JSON.parse(raw) as { nonce: string; teamId: string; userId: string };
  } catch {
    return redirect(`${env.APP_ORIGIN}/#/teams?lb=install_failed`);
  }
  if (!timingSafeEqual(blob.nonce, state)) {
    return redirect(`${env.APP_ORIGIN}/#/teams?lb=install_failed`);
  }

  const principal = await authenticate(req, env);
  if (!principal || principal.userId !== blob.userId) {
    return redirect(`${env.APP_ORIGIN}/#/teams?lb=install_auth`);
  }

  try {
    const ctx = await requireTeam(env, blob.teamId, principal.userId, principal.via);
    if (!can(ctx.role, "leaderboard.manage")) throw forbidden();
    await requirePaidPlanFeatures(env, ctx.team, "write");
    const inst = await getInstallation(env, installationId);
    await ensureSettings(env, ctx.team.id);
    await env.DB.prepare(
      `UPDATE team_leaderboard_settings
       SET github_installation_id = ?, github_org_login = ?, updated_at = ?
       WHERE team_id = ?`,
    )
      .bind(String(inst.id), inst.account.login, nowIso(), ctx.team.id)
      .run();
    await writeAudit(
      env,
      ctx.team.id,
      principal.userId,
      "leaderboard.installed",
      null,
      inst.account.login,
    );

    const team = ctx.team;
    const clear = `${INSTALL_STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
    return redirect(`${env.APP_ORIGIN}/#/t/${encodeURIComponent(team.slug)}/settings?lb=installed`, {
      "set-cookie": clear,
    });
  } catch {
    return redirect(`${env.APP_ORIGIN}/#/teams?lb=install_failed`);
  }
}

export async function getRepos(
  req: Request,
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "leaderboard.manage");
  await requirePaidPlanFeatures(env, ctx.team, "read");
  const settings = await getSettings(env, ctx.team.id);
  const selected = await listSelectedRepos(env, ctx.team.id);
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";

  let available: Array<{ fullName: string; private: boolean }> = [];
  if (settings?.github_installation_id && githubAppConfigured(env)) {
    const cacheKey = settings.github_installation_id;
    const hit = repoListCache.get(cacheKey);
    if (!refresh && hit && Date.now() - hit.at < REPO_LIST_TTL_MS) {
      available = hit.available;
    } else {
      try {
        const token = await installationToken(env, settings.github_installation_id);
        const repos = await listInstallationRepos(token);
        available = repos.map((r) => ({ fullName: r.full_name, private: r.private }));
        repoListCache.set(cacheKey, { at: Date.now(), available });
      } catch {
        available = selected.map((fullName) => ({ fullName, private: false }));
      }
    }
  }
  // Always include selected even if not in the (capped) installation list.
  const seen = new Set(available.map((a) => a.fullName.toLowerCase()));
  for (const fullName of selected) {
    if (!seen.has(fullName.toLowerCase())) {
      available.push({ fullName, private: false });
    }
  }
  return json({ selected, available, cached: !refresh && Boolean(repoListCache.get(settings?.github_installation_id ?? "")) });
}

export async function putRepos(
  req: Request,
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "leaderboard.manage");
  await requirePaidPlanFeatures(env, ctx.team, "write");
  const body = await readJson<{ repos?: string[] }>(req);
  if (!Array.isArray(body.repos)) throw badRequest("repos must be an array of owner/name strings.");
  const repos = [
    ...new Set(
      body.repos
        .map((r) => String(r).trim())
        .filter((r) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)),
    ),
  ].slice(0, 100);

  await ensureSettings(env, ctx.team.id);
  await env.DB.prepare("DELETE FROM team_leaderboard_repos WHERE team_id = ?")
    .bind(ctx.team.id)
    .run();
  const now = nowIso();
  for (const full of repos) {
    await env.DB.prepare(
      "INSERT INTO team_leaderboard_repos (team_id, repo_full_name, added_at) VALUES (?, ?, ?)",
    )
      .bind(ctx.team.id, full, now)
      .run();
  }
  await writeAudit(
    env,
    ctx.team.id,
    principal.userId,
    "leaderboard.repos_set",
    null,
    `${repos.length} repos`,
  );
  return json({ selected: repos });
}

export async function postSync(
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "leaderboard.manage");
  await requirePaidPlanFeatures(env, ctx.team, "write");
  const last = lastManualSync.get(ctx.team.id) ?? 0;
  if (Date.now() - last < SYNC_COOLDOWN_MS) {
    throw badRequest("Sync is rate-limited. Try again in a couple of minutes.");
  }
  lastManualSync.set(ctx.team.id, Date.now());
  const result = await syncTeam(env, ctx.team.id);
  return json(result);
}

export async function getWeek(
  req: Request,
  env: Env,
  principal: Principal,
  key: string,
): Promise<Response> {
  const ctx = await requireTeam(env, key, principal.userId, principal.via);
  requireCapability(ctx, "leaderboard.view");
  await requirePaidPlanFeatures(env, ctx.team, "read");
  const settings = await getSettings(env, ctx.team.id);
  const enabled = settings?.enabled === 1;

  const url = new URL(req.url);
  const weekParam = url.searchParams.get("week");
  const week = weekParam && /^\d{4}-W\d{2}$/.test(weekParam) ? weekParam : isoWeekId();
  let bounds: { start: string; end: string };
  try {
    bounds = weekBounds(week);
  } catch {
    throw badRequest("Invalid week. Use YYYY-Www.");
  }

  const scoringMode: ScoringMode = isComplexityOrg(settings?.github_org_login)
    ? "complexity"
    : "lines";

  if (!enabled) {
    return json({
      week,
      weekStart: bounds.start,
      weekEnd: bounds.end,
      enabled: false,
      scoringMode,
      lastSyncAt: settings?.last_sync_at ?? null,
      lastSyncError: settings?.last_sync_error ?? null,
      syncedPrCount: 0,
      complexityCoverage: null,
      rows: [],
      excludedNoTokens: [],
      memberCountEligible: 0,
      memberCountRanked: 0,
    });
  }

  // Eligible: active members with github identity (full team — no manager_scope).
  const membersR = await env.DB.prepare(
    `SELECT m.user_id, u.display_name, u.handle, i.provider_user_id AS github_id,
            u.handle AS maybe_login
     FROM team_members m
     JOIN users u ON u.id = m.user_id
     JOIN identities i ON i.user_id = m.user_id AND i.provider = 'github'
     WHERE m.team_id = ? AND m.left_at IS NULL`,
  )
    .bind(ctx.team.id)
    .all<{
      user_id: string;
      display_name: string;
      handle: string | null;
      github_id: string;
      maybe_login: string | null;
    }>();

  const memberRows = membersR.results ?? [];
  const usageByUser = await weekUsage(env, ctx.team.id, bounds.start, bounds.end);

  // Prefer author_login from PRs for github login display.
  const loginByGithub = new Map<string, string>();
  const prR = await env.DB.prepare(
    `SELECT author_github_id, author_login, opened_at, merged_at, size_tier,
            complexity_points, is_bot
     FROM github_prs WHERE team_id = ?`,
  )
    .bind(ctx.team.id)
    .all<{
      author_github_id: string;
      author_login: string;
      opened_at: string;
      merged_at: string | null;
      size_tier: "small" | "medium" | "large";
      complexity_points: number | null;
      is_bot: number;
    }>();

  const prs: PrForScore[] = [];
  let complexityWith = 0;
  let complexityTotal = 0;
  for (const p of prR.results ?? []) {
    if (p.author_login) loginByGithub.set(p.author_github_id, p.author_login);
    const cPts =
      p.complexity_points != null && Number.isFinite(Number(p.complexity_points))
        ? Number(p.complexity_points)
        : null;
    if (scoringMode === "complexity" && p.is_bot !== 1) {
      complexityTotal += 1;
      if (cPts != null && cPts > 0) complexityWith += 1;
    }
    prs.push({
      authorGithubId: p.author_github_id,
      openedAt: p.opened_at,
      mergedAt: p.merged_at,
      sizeTier: p.size_tier,
      isBot: p.is_bot === 1,
      complexityPoints: scoringMode === "complexity" ? cPts : null,
    });
  }

  const members = memberRows.map((m) => {
    const u = usageByUser.get(m.user_id);
    return {
      userId: m.user_id,
      displayName: m.display_name,
      handle: m.handle,
      githubId: m.github_id,
      githubLogin: loginByGithub.get(m.github_id) ?? m.handle,
      tokens: u?.tokens ?? 0,
      costUsd: u?.costUsd ?? 0,
      costIncomplete: u?.costIncomplete ?? true,
    };
  });

  const weights: LeaderboardWeights = settings
    ? {
        small: settings.weight_small,
        medium: settings.weight_medium,
        large: settings.weight_large,
        merge: settings.weight_merge,
      }
    : DEFAULT_WEIGHTS;

  const scored = scoreWeek(members, prs, bounds.start, bounds.end, weights);

  const prCountRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM github_prs WHERE team_id = ?",
  )
    .bind(ctx.team.id)
    .first<{ n: number }>();

  return json({
    week,
    weekStart: bounds.start,
    weekEnd: bounds.end,
    enabled: true,
    scoringMode,
    lastSyncAt: settings?.last_sync_at ?? null,
    lastSyncError: settings?.last_sync_error ?? null,
    syncedPrCount: Number(prCountRow?.n ?? 0),
    complexityCoverage:
      scoringMode === "complexity"
        ? { withPoints: complexityWith, total: complexityTotal }
        : null,
    ...scored,
  });
}

/** Tokens (bucketTokens sum) + cost_usd over the week. hour_utc is 'YYYY-MM-DDTHH'. */
async function weekUsage(
  env: Env,
  teamId: string,
  weekStart: string,
  weekEnd: string,
): Promise<Map<string, { tokens: number; costUsd: number; costIncomplete: boolean }>> {
  const hourStart = weekStart.slice(0, 13); // YYYY-MM-DDTHH
  const endDate = new Date(weekEnd);
  endDate.setUTCHours(endDate.getUTCHours() - 1);
  const hourEnd = endDate.toISOString().slice(0, 13);

  const r = await env.DB.prepare(
    `SELECT user_id,
            SUM(tokens_in + tokens_out + tokens_cache_read + tokens_cache_write) AS tokens,
            SUM(cost_usd) AS cost_usd,
            MAX(cost_incomplete) AS cost_incomplete
     FROM metric_hourly
     WHERE team_id = ? AND hour_utc >= ? AND hour_utc <= ?
     GROUP BY user_id`,
  )
    .bind(teamId, hourStart, hourEnd)
    .all<{ user_id: string; tokens: number; cost_usd: number; cost_incomplete: number }>();

  const map = new Map<string, { tokens: number; costUsd: number; costIncomplete: boolean }>();
  for (const row of r.results ?? []) {
    map.set(row.user_id, {
      tokens: Number(row.tokens) || 0,
      costUsd: Number(row.cost_usd) || 0,
      costIncomplete: row.cost_incomplete !== 0,
    });
  }
  return map;
}
