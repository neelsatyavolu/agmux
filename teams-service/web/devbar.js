/* Local dev toolbar. Renders only when /api/dev/status says dev mode is on,
   which requires DEV_AUTH=true *and* a localhost request — so this is invisible
   in any deployed Worker. Lets one person drive the whole product: sign in,
   seed a populated team, and flip roles to see all three dashboards. */

import { html, icons, raw, toast } from "./dom.js";

async function call(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.ok) throw new Error(payload?.error ?? `request failed (${res.status})`);
  return payload.data;
}

export async function mountDevBar(onChanged) {
  let state;
  try {
    state = await call("/api/dev/status");
  } catch {
    return; // not in dev mode
  }
  if (!state.enabled) return;

  const host = document.createElement("div");
  host.id = "devbar";
  document.body.appendChild(host);

  const render = () => {
    const roles = ["owner", "manager", "employee"];
    host.innerHTML = html`
      <div class="devbar">
        <span class="devbar-tag">dev</span>

        ${state.signedIn
          ? raw(`<span class="devbar-ok">signed in</span>`)
          : raw(`<button class="btn primary" data-dev="login">Sign in as You</button>`)}

        ${state.signedIn && !state.seeded
          ? raw(`<button class="btn primary" data-dev="seed">Seed demo team</button>`)
          : ""}

        ${state.signedIn && state.seeded
          ? raw(`
            <span class="devbar-sep"></span>
            <span class="devbar-lbl">View as</span>
            <div class="seg">
              ${roles
                .map(
                  (r) =>
                    `<button data-dev="role" data-role="${r}" class="${state.role === r ? "on" : ""}">${r}</button>`,
                )
                .join("")}
            </div>
            <span class="devbar-sep"></span>
            <button class="btn" data-dev="reseed">Reseed</button>
            <button class="btn" data-dev="token">Desktop token</button>
          `)
          : ""}

        <div class="devbar-sp"></div>
        <button class="btn danger" data-dev="reset">Reset all</button>
      </div>
    `;
    icons();
  };

  const busy = (on) => {
    host.querySelectorAll("button").forEach((b) => (b.disabled = on));
  };

  host.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-dev]");
    if (!el) return;
    const action = el.getAttribute("data-dev");
    busy(true);
    try {
      if (action === "login") {
        // On /link?code=… the desktop app is waiting on us; pass the code so
        // dev login completes the device handshake the way OAuth would.
        const linkCode = new URLSearchParams(location.search).get("code");
        const r = await call("/api/dev/login", { name: "You", linkCode });
        state = await call("/api/dev/status");
        render();
        onChanged?.();
        toast(r.linked ? "Signed in — desktop app linked" : "Signed in as You");
      } else if (action === "seed" || action === "reseed") {
        toast("Seeding 90 days of activity…");
        const r = await call("/api/dev/seed", { days: 90 });
        state = await call("/api/dev/status");
        render();
        onChanged?.();
        toast(`Seeded ${r.members} members · ${r.buckets.toLocaleString()} hourly buckets`);
      } else if (action === "role") {
        const role = el.getAttribute("data-role");
        await call("/api/dev/role", { role });
        state.role = role;
        render();
        onChanged?.();
        toast(`Viewing as ${role}`);
      } else if (action === "token") {
        const r = await call("/api/dev/device-token", { deviceId: "dev-desktop" });
        await navigator.clipboard.writeText(r.token).catch(() => {});
        toast("Device token copied — see teams-service/README.md");
        // Also print it, in case the clipboard is blocked.
        console.info("agmux Teams dev device token:", r.token);
      } else if (action === "reset") {
        if (!confirm("Delete every user, team and metric in the local database?")) return;
        await call("/api/dev/reset", {});
        state = await call("/api/dev/status");
        render();
        onChanged?.();
        toast("Local database cleared");
      }
    } catch (err) {
      toast(err.message, "error");
    } finally {
      busy(false);
    }
  });

  render();
}
