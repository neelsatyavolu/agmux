import { DesktopHub, type Env } from "./desktop-hub";

export { DesktopHub };

export interface EnvWithAssets extends Env {
  ASSETS?: Fetcher;
}

/** desktopId is an idFromName key — bound length + charset to avoid abuse. */
const DESKTOP_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Routes:
 *  GET  /ws?desktopId=… → WebSocket upgrade to that desktop's DO
 *  GET  /*              → PWA static assets
 */
export default {
  async fetch(request: Request, env: EnvWithAssets): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const desktopId = url.searchParams.get("desktopId");
      if (!desktopId) {
        return new Response("desktopId required", { status: 400 });
      }
      if (!DESKTOP_ID_RE.test(desktopId)) {
        return new Response("invalid desktopId", { status: 400 });
      }
      const id = env.DESKTOP_HUB.idFromName(desktopId);
      const stub = env.DESKTOP_HUB.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "agmux-remote-relay" });
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("agmux remote relay — configure [assets]", { status: 200 });
  },
};
