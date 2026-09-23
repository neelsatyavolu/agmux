/**
 * agmux Teams — Worker entry point.
 *
 *   /api/*  → JSON API (this file routes it)
 *   /*      → the SPA in ./web, served from the ASSETS binding
 *
 * Entirely separate from agmux-remote-relay: no shared bindings, no shared
 * deployment, and nothing here touches device pairing.
 */
import type { Env } from "./env";
import { HttpError, errorResponse, json, notFound } from "./http";
import { requirePrincipal, type Principal } from "./session";
import * as auth from "./routes/auth";
import * as teams from "./routes/teams";
import * as members from "./routes/members";
import * as invites from "./routes/invites";
import * as dashboard from "./routes/dashboard";
import * as metrics from "./routes/metrics";
import * as exportCsv from "./routes/export";
import * as budget from "./routes/budget";
import * as audit from "./routes/audit";
import * as groups from "./routes/groups";
import * as scope from "./routes/scope";
import * as leaderboard from "./routes/leaderboard";
import * as policy from "./routes/policy";
import * as billing from "./routes/billing";
import * as knowledge from "./routes/knowledge";
import * as dev from "./routes/dev";
import * as providerAccounts from "./routes/provider-accounts";
import { runLeaderboardSyncs } from "./leaderboard/sync";

type Handler = (
  req: Request,
  env: Env,
  params: string[],
  principal: Principal,
) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
  /** Routes that must work before the caller is signed in. */
  anonymous?: (req: Request, env: Env, params: string[]) => Promise<Response>;
}

const seg = "([^/]+)";

const ROUTES: Route[] = [
  // ── auth (anonymous) ────────────────────────────────────────────────────
  {
    method: "GET",
    pattern: new RegExp(`^/api/auth/${seg}/start$`),
    handler: () => Promise.reject(notFound()),
    anonymous: (req, env, p) => auth.startOAuth(req, env, p[0]!),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/auth/${seg}/callback$`),
    handler: () => Promise.reject(notFound()),
    anonymous: (req, env, p) => auth.oauthCallback(req, env, p[0]!),
  },
  {
    method: "GET",
    pattern: /^\/api\/auth\/me$/,
    handler: () => Promise.reject(notFound()),
    anonymous: (req, env) => auth.me(req, env),
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/logout$/,
    handler: () => Promise.reject(notFound()),
    anonymous: (req, env) => auth.logout(req, env),
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/device\/start$/,
    handler: () => Promise.reject(notFound()),
    anonymous: (req, env) => auth.deviceStart(req, env),
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/device\/claim$/,
    handler: () => Promise.reject(notFound()),
    anonymous: (req, env) => auth.deviceClaim(req, env),
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/device\/attach$/,
    handler: (req, env) => auth.deviceAttach(req, env),
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/device\/revoke$/,
    handler: (req, env) => auth.deviceRevoke(req, env),
  },

  // ── Stripe webhook (anonymous, signature-verified) ──────────────────────
  {
    method: "POST",
    pattern: /^\/api\/billing\/webhook$/,
    handler: () => Promise.reject(notFound()),
    anonymous: (req, env) => billing.stripeWebhook(req, env),
  },

  // ── invite preview is public (the token is the credential) ──────────────
  {
    method: "GET",
    pattern: new RegExp(`^/api/invites/${seg}$`),
    handler: () => Promise.reject(notFound()),
    anonymous: (_req, env, p) => invites.previewInvite(env, p[0]!),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/invites/${seg}/accept$`),
    handler: (req, env, p, principal) => invites.acceptInvite(req, env, principal, p[0]!),
  },

  // Explicit team credential plane, separate from analytics.
  ...["GET", "POST", "PATCH", "DELETE"].map(method => ({
    method,
    pattern: new RegExp(`^/api/teams/${seg}/provider-accounts((?:/[^/]+){0,3})$`),
    handler: (req: Request, env: Env, p: string[], pr: Principal) => providerAccounts.handle(req, env, pr, p[0]!, p[1]!),
  })),

  // ── teams ───────────────────────────────────────────────────────────────
  { method: "GET", pattern: /^\/api\/teams$/, handler: (_r, env, _p, pr) => teams.listTeams(env, pr) },
  { method: "POST", pattern: /^\/api\/teams$/, handler: (req, env, _p, pr) => teams.createTeam(req, env, pr) },
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}$`),
    handler: (_r, env, p, pr) => teams.getTeam(env, pr, p[0]!),
  },
  {
    method: "PATCH",
    pattern: new RegExp(`^/api/teams/${seg}$`),
    handler: (req, env, p, pr) => teams.renameTeam(req, env, pr, p[0]!),
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^/api/teams/${seg}$`),
    handler: (_r, env, p, pr) => teams.deleteTeam(env, pr, p[0]!),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/teams/${seg}/leave$`),
    handler: (_r, env, p, pr) => teams.leaveTeam(env, pr, p[0]!),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/billing$`),
    handler: (_r, env, p, pr) => billing.getBilling(env, pr, p[0]!),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/teams/${seg}/billing/checkout$`),
    handler: (req, env, p, pr) => billing.startCheckout(req, env, pr, p[0]!),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/teams/${seg}/billing/portal$`),
    handler: (_r, env, p, pr) => billing.startPortal(env, pr, p[0]!),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/teams/${seg}/billing/confirm$`),
    handler: (req, env, p, pr) => billing.confirmCheckout(req, env, pr, p[0]!),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/teams/${seg}/billing/seats$`),
    handler: (req, env, p, pr) => billing.setSeats(req, env, pr, p[0]!),
  },

  // ── roster ──────────────────────────────────────────────────────────────
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/members$`),
    handler: (_r, env, p, pr) => members.listMembers(env, pr, p[0]!),
  },
  {
    method: "PATCH",
    pattern: new RegExp(`^/api/teams/${seg}/members/${seg}$`),
    handler: (req, env, p, pr) => members.setMemberRole(req, env, pr, p[0]!, p[1]!),
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^/api/teams/${seg}/members/${seg}$`),
    handler: (_r, env, p, pr) => members.removeMember(env, pr, p[0]!, p[1]!),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/members/${seg}/scope$`),
    handler: (_r, env, p, pr) => scope.getMemberScope(env, pr, p[0]!, p[1]!),
  },
  {
    method: "PUT",
    pattern: new RegExp(`^/api/teams/${seg}/members/${seg}/scope$`),
    handler: (req, env, p, pr) => scope.setMemberScope(req, env, pr, p[0]!, p[1]!),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/manager-scopes$`),
    handler: (_r, env, p, pr) => scope.listManagerScopes(env, pr, p[0]!),
  },

  // ── groups ──────────────────────────────────────────────────────────────
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/groups$`),
    handler: (_r, env, p, pr) => groups.listGroups(env, pr, p[0]!),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/teams/${seg}/groups$`),
    handler: (req, env, p, pr) => groups.createGroup(req, env, pr, p[0]!),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/groups/${seg}$`),
    handler: (_r, env, p, pr) => groups.getGroupDetail(env, pr, p[0]!, p[1]!),
  },
  {
    method: "PATCH",
    pattern: new RegExp(`^/api/teams/${seg}/groups/${seg}$`),
    handler: (req, env, p, pr) => groups.renameGroup(req, env, pr, p[0]!, p[1]!),
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^/api/teams/${seg}/groups/${seg}$`),
    handler: (_r, env, p, pr) => groups.deleteGroup(env, pr, p[0]!, p[1]!),
  },
  {
    method: "PUT",
    pattern: new RegExp(`^/api/teams/${seg}/groups/${seg}/members$`),
    handler: (req, env, p, pr) => groups.setGroupMembers(req, env, pr, p[0]!, p[1]!),
  },

  // ── invites ─────────────────────────────────────────────────────────────
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/invite$`),
    handler: (_r, env, p, pr) => invites.getInvite(env, pr, p[0]!),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/teams/${seg}/invite$`),
    handler: (req, env, p, pr) => invites.createInvite(req, env, pr, p[0]!),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/teams/${seg}/invite/revoke$`),
    handler: (_r, env, p, pr) => invites.revokeInvite(env, pr, p[0]!),
  },

  // ── org policy plane ────────────────────────────────────────────────────
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/policy$`),
    handler: (_r, env, p, pr) => policy.getPolicy(env, pr, p[0]!),
  },
  {
    method: "PUT",
    pattern: new RegExp(`^/api/teams/${seg}/policy$`),
    handler: (req, env, p, pr) => policy.putPolicy(req, env, pr, p[0]!),
  },

  // ── knowledge (content plane — not metrics) ─────────────────────────────
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/knowledge/settings$`),
    handler: (_r, env, p, pr) => knowledge.getSettings(env, pr, p[0]!),
  },
  {
    method: "PATCH",
    pattern: new RegExp(`^/api/teams/${seg}/knowledge/settings$`),
    handler: (req, env, p, pr) => knowledge.patchSettings(env, pr, p[0]!, req),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/teams/${seg}/knowledge/disclosure/accept$`),
    handler: (_r, env, p, pr) => knowledge.acceptDisclosure(env, pr, p[0]!),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/knowledge/overview$`),
    handler: (req, env, p, pr) => knowledge.overview(env, pr, p[0]!, req),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/knowledge/search$`),
    handler: (req, env, p, pr) => knowledge.search(env, pr, p[0]!, req),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/knowledge/records$`),
    handler: (req, env, p, pr) => knowledge.listRecords(env, pr, p[0]!, req),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/teams/${seg}/knowledge/records$`),
    handler: (req, env, p, pr) => knowledge.createRecord(env, pr, p[0]!, req),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/knowledge/records/${seg}$`),
    handler: (req, env, p, pr) => knowledge.getRecord(env, pr, p[0]!, p[1]!, req),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/knowledge/export$`),
    handler: (_r, env, p, pr) => knowledge.exportKnowledge(env, pr, p[0]!),
  },
  {
    method: "PATCH",
    pattern: new RegExp(`^/api/teams/${seg}/knowledge/records/${seg}$`),
    handler: (req, env, p, pr) => knowledge.patchRecord(env, pr, p[0]!, p[1]!, req),
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^/api/teams/${seg}/knowledge/records/${seg}$`),
    handler: (req, env, p, pr) => knowledge.deleteRecord(env, pr, p[0]!, p[1]!, req),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/teams/${seg}/knowledge/records/${seg}/verify$`),
    handler: (_r, env, p, pr) => knowledge.verifyRecord(env, pr, p[0]!, p[1]!),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/teams/${seg}/knowledge/digests$`),
    handler: (req, env, p, pr) => knowledge.createDigest(env, pr, p[0]!, req),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/knowledge/digests$`),
    handler: (req, env, p, pr) => knowledge.listDigests(env, pr, p[0]!, req),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/knowledge/digests/${seg}$`),
    handler: (_r, env, p, pr) => knowledge.getDigest(env, pr, p[0]!, p[1]!),
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^/api/teams/${seg}/knowledge/digests/${seg}$`),
    handler: (req, env, p, pr) => knowledge.deleteDigest(env, pr, p[0]!, p[1]!, req),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/teams/${seg}/knowledge/promote$`),
    handler: (req, env, p, pr) => knowledge.promote(env, pr, p[0]!, req),
  },

  // ── analytics ───────────────────────────────────────────────────────────
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/overview$`),
    handler: (req, env, p, pr) => dashboard.teamOverview(req, env, pr, p[0]!),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/me$`),
    handler: (req, env, p, pr) => dashboard.selfDetail(req, env, pr, p[0]!),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/members/${seg}/detail$`),
    handler: (req, env, p, pr) => dashboard.memberDetail(req, env, pr, p[0]!, p[1]!),
  },

  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/export\\.csv$`),
    handler: (req, env, p, pr) => exportCsv.exportCsv(req, env, pr, p[0]!),
  },

  // ── budget ──────────────────────────────────────────────────────────────
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/budget$`),
    handler: (_r, env, p, pr) => budget.getBudget(env, pr, p[0]!),
  },
  {
    method: "PUT",
    pattern: new RegExp(`^/api/teams/${seg}/budget$`),
    handler: (req, env, p, pr) => budget.setBudget(req, env, pr, p[0]!),
  },

  // ── audit ───────────────────────────────────────────────────────────────
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/audit$`),
    handler: (req, env, p, pr) => audit.listAudit(req, env, pr, p[0]!),
  },

  // ── leaderboard (owner config; owner+manager view) ─────────────────────
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/leaderboard/settings$`),
    handler: (_r, env, p, pr) => leaderboard.getLeaderboardSettings(env, pr, p[0]!),
  },
  {
    method: "PATCH",
    pattern: new RegExp(`^/api/teams/${seg}/leaderboard/settings$`),
    handler: (req, env, p, pr) => leaderboard.patchLeaderboardSettings(req, env, pr, p[0]!),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/leaderboard/install-url$`),
    handler: (_r, env, p, pr) => leaderboard.getInstallUrl(env, pr, p[0]!),
  },
  {
    method: "GET",
    pattern: /^\/api\/leaderboard\/github\/callback$/,
    handler: () => Promise.reject(notFound()),
    anonymous: (req, env) => leaderboard.installCallback(req, env),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/leaderboard/repos$`),
    handler: (req, env, p, pr) => leaderboard.getRepos(req, env, pr, p[0]!),
  },
  {
    method: "PUT",
    pattern: new RegExp(`^/api/teams/${seg}/leaderboard/repos$`),
    handler: (req, env, p, pr) => leaderboard.putRepos(req, env, pr, p[0]!),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/teams/${seg}/leaderboard/sync$`),
    handler: (_r, env, p, pr) => leaderboard.postSync(env, pr, p[0]!),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/teams/${seg}/leaderboard/week$`),
    handler: (req, env, p, pr) => leaderboard.getWeek(req, env, pr, p[0]!),
  },

  // ── telemetry ───────────────────────────────────────────────────────────
  {
    method: "POST",
    pattern: /^\/api\/metrics\/upload$/,
    handler: (req, env, _p, pr) => metrics.upload(req, env, pr),
  },
  {
    method: "POST",
    pattern: /^\/api\/metrics\/prune$/,
    handler: (req, env, _p, pr) => metrics.prune(req, env, pr),
  },
  {
    method: "GET",
    pattern: /^\/api\/metrics\/sync-state$/,
    handler: (_r, env, _p, pr) => metrics.syncState(env, pr),
  },

  // ── local development only ──────────────────────────────────────────────
  // Each handler re-checks DEV_AUTH + localhost and 404s otherwise, so these
  // are inert in a deployed Worker.
  {
    method: "GET",
    pattern: /^\/api\/dev\/status$/,
    handler: () => Promise.reject(notFound()),
    anonymous: (req, env) => dev.devStatus(req, env),
  },
  {
    method: "POST",
    pattern: /^\/api\/dev\/login$/,
    handler: () => Promise.reject(notFound()),
    anonymous: (req, env) => dev.devLogin(req, env),
  },
  {
    method: "POST",
    pattern: /^\/api\/dev\/seed$/,
    handler: () => Promise.reject(notFound()),
    anonymous: (req, env) => dev.devSeed(req, env),
  },
  {
    method: "POST",
    pattern: /^\/api\/dev\/role$/,
    handler: () => Promise.reject(notFound()),
    anonymous: (req, env) => dev.devSwitchRole(req, env),
  },
  {
    method: "POST",
    pattern: /^\/api\/dev\/device-token$/,
    handler: () => Promise.reject(notFound()),
    anonymous: (req, env) => dev.devDeviceToken(req, env),
  },
  {
    method: "POST",
    pattern: /^\/api\/dev\/reset$/,
    handler: () => Promise.reject(notFound()),
    anonymous: (req, env) => dev.devReset(req, env),
  },
];

async function handleApi(req: Request, env: Env, path: string): Promise<Response> {
  let methodMismatch = false;

  for (const route of ROUTES) {
    const m = route.pattern.exec(path);
    if (!m) continue;
    if (route.method !== req.method) {
      methodMismatch = true;
      continue;
    }
    const params = m.slice(1).map((v) => decodeURIComponent(v));
    if (route.anonymous) return route.anonymous(req, env, params);
    const principal = await requirePrincipal(req, env);
    return route.handler(req, env, params, principal);
  }

  if (methodMismatch) throw new HttpError(405, "Method not allowed.", "method_not_allowed");
  throw notFound();
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/health") return json({ service: "agmux-teams", ok: true });

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env, url.pathname);
      } catch (err) {
        return errorResponse(err);
      }
    }

    // Everything else is the SPA. `not_found_handling = single-page-application`
    // means deep links like /t/helios/settings resolve to index.html.
    return env.ASSETS.fetch(req);
  },

  /**
   * Hourly budget check. The alert ledger makes each threshold fire once per
   * month, so the cadence here only bounds how quickly a manager hears — it
   * never controls how often they are told.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      budget.runBudgetAlerts(env).catch(() => {
        // A failed sweep must not retry-storm; the next tick re-evaluates from
        // the ledger anyway.
      }),
    );
    ctx.waitUntil(
      runLeaderboardSyncs(env).catch(() => {
        // Next hourly tick retries; do not throw out of the schedule handler.
      }),
    );
    ctx.waitUntil(
      billing.applyPendingSeatDecreases(env).catch(() => {
        // Next hourly tick retries pending seat downgrades.
      }),
    );
  },
} satisfies ExportedHandler<Env>;
