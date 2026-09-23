/**
 * agmux owner analytics — Worker entry.
 *
 *   POST /v1/heartbeat   anonymous install ping
 *   POST /v1/event       allowlisted product event
 *   GET  /api/summary    owner-only dashboard payload
 *   /api/auth/*          GitHub / password / dev sign-in
 *   /*                   SPA in ./web
 *
 * Separate from teams-service and remote-relay. No shared bindings.
 */
import { submitSupport, listSupport, updateSupport, downloadSupport } from "./routes/support";
import type { Env } from "./env";
import { HttpError, errorResponse, json, notFound } from "./http";
import { requirePrincipal } from "./session";
import * as auth from "./routes/auth";
import { heartbeat } from "./routes/heartbeat";
import { event } from "./routes/event";
import { summary } from "./routes/summary";

type Anon = (req: Request, env: Env) => Promise<Response>;
type Authed = (req: Request, env: Env) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  anonymous?: Anon;
  handler?: Authed;
}

const ROUTES: Route[] = [
  { method: "POST", pattern: /^\/v1\/support$/, anonymous: submitSupport },
  { method: "GET", pattern: /^\/api\/support$/, handler: listSupport },
  { method: "PATCH", pattern: /^\/api\/support\/[a-f0-9-]+$/, handler: updateSupport },
  { method: "GET", pattern: /^\/api\/support\/attachment\/.+$/, handler: downloadSupport },
  { method: "GET", pattern: /^\/api\/auth\/me$/, anonymous: (req, env) => auth.me(req, env) },
  {
    method: "GET",
    pattern: /^\/api\/auth\/github\/start$/,
    anonymous: (req, env) => auth.startGithub(req, env),
  },
  {
    method: "GET",
    pattern: /^\/api\/auth\/github\/callback$/,
    anonymous: (req, env) => auth.githubCallback(req, env),
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/password$/,
    anonymous: (req, env) => auth.passwordLogin(req, env),
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/dev$/,
    anonymous: (req, env) => auth.devLogin(req, env),
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/logout$/,
    anonymous: (req, env) => auth.logout(req, env),
  },
  { method: "POST", pattern: /^\/v1\/heartbeat$/, anonymous: heartbeat },
  { method: "POST", pattern: /^\/v1\/event$/, anonymous: event },
  { method: "GET", pattern: /^\/api\/summary$/, handler: summary },
];

async function handleApi(req: Request, env: Env, path: string): Promise<Response> {
  let methodMismatch = false;
  for (const route of ROUTES) {
    if (!route.pattern.test(path)) continue;
    if (route.method !== req.method) {
      methodMismatch = true;
      continue;
    }
    if (route.anonymous) return route.anonymous(req, env);
    await requirePrincipal(req, env);
    if (!route.handler) throw notFound();
    return route.handler(req, env);
  }
  if (methodMismatch) throw new HttpError(405, "Method not allowed.", "method_not_allowed");
  throw notFound();
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      return json({ service: "agmux-owner", ok: true });
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/")) {
      try {
        return await handleApi(req, env, url.pathname);
      } catch (err) {
        return errorResponse(err);
      }
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
