/* agmux remote PWA service worker — push + notification click → open thread */

// Scope is origin-relative: remote.agmux.dev/ → "./" ; agmux.dev/remote/ → "./"
// Never hard-code /remote/ so dual-hosting works for existing installs.
const SCOPE = self.registration.scope; // always ends with /
const assetUrl = (rel) => new URL(rel.replace(/^\//, ""), SCOPE).href;

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(Promise.resolve());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "agmux", body: event.data ? event.data.text() : "Agent needs you" };
  }
  const title = data.title || "Agent needs approval";
  const options = {
    body: data.body || "An agent is waiting on your Mac.",
    icon: data.icon || assetUrl("icons/agmux.png"),
    badge: data.badge || assetUrl("icons/agmux.png"),
    tag: data.tag || data.requestId || "agmux-approval",
    renotify: true,
    data: {
      threadId: data.threadId || null,
      requestId: data.requestId || null,
      url: data.url || SCOPE,
    },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const payload = event.notification.data || {};
  const threadId = payload.threadId;
  const base = payload.url || SCOPE;
  const target = threadId
    ? `${base}${base.includes("?") ? "&" : "?"}thread=${encodeURIComponent(threadId)}`
    : base;

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        if ("focus" in client) {
          await client.focus();
          try {
            client.postMessage({ type: "open-thread", threadId });
          } catch {
            /* ignore */
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(target);
      }
    })(),
  );
});
