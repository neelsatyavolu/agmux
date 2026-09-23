const $ = (sel, el = document) => el.querySelector(sel);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return body.data ?? body;
}

function fmt(n) {
  return new Intl.NumberFormat("en-US").format(n ?? 0);
}

function sumDims(rows, name, key) {
  const map = new Map();
  for (const r of rows) {
    if (r.name !== name || r.key !== key) continue;
    map.set(r.value, (map.get(r.value) ?? 0) + r.count);
  }
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

function sumEvents(rows, name) {
  return rows.filter((r) => r.name === name).reduce((n, r) => n + r.count, 0);
}

function mix(rows) {
  const total = rows.reduce((n, r) => n + r.count, 0) || 1;
  return rows
    .map(
      (r) => `
      <div class="mix-row">
        <span class="nm">${esc(r.label)}</span>
        <span class="n">${fmt(r.count)}</span>
        <div class="track"><i style="width:${Math.max(2, (100 * r.count) / total)}%"></i></div>
      </div>`,
    )
    .join("") || `<div class="empty">No data yet.</div>`;
}

function bars(dau) {
  const max = Math.max(1, ...dau.map((d) => d.count));
  return `<div class="bars" title="Daily active installs">
    ${dau
      .map(
        (d) =>
          `<div class="col" title="${d.day}: ${d.count}">
            <div class="fill" style="height:${Math.round((100 * d.count) / max)}%"></div>
          </div>`,
      )
      .join("")}
  </div>`;
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loginView(me, err) {
  const github = me.auth?.github
    ? `<a class="btn primary lg" href="/api/auth/github/start">Sign in with GitHub</a>`
    : "";
  const password = me.auth?.password
    ? `<form id="pw">
        <input class="input" type="password" name="password" placeholder="Owner password" autocomplete="current-password" />
        <button class="btn primary lg" type="submit" style="margin-top:8px;width:100%;justify-content:center">Sign in</button>
      </form>`
    : "";
  const dev = me.auth?.dev
    ? `<button class="btn lg" id="dev" type="button">Dev sign-in</button>`
    : "";
  return `
    <div class="center">
      <div class="tex"></div><div class="glow"></div>
      <div class="col">
        <div class="brand"><span class="mark">a</span><span>agmux owner</span></div>
        <h1>Product analytics</h1>
        <p>Anonymous installs and allowlisted events. Sign in with the owner GitHub account.</p>
        ${err ? `<div class="err">${esc(err)}</div>` : ""}
        ${github}
        ${password}
        ${dev}
      </div>
    </div>`;
}

function dashView(me, data, days) {
  const versions = (data.byVersion ?? []).map((r) => ({
    label: r.app_version,
    count: r.count,
  }));
  const os = (data.byOs ?? []).map((r) => ({
    label: `${r.os_name} ${r.os_version}`.trim(),
    count: r.count,
  }));
  const providers = sumDims(data.eventDims ?? [], "thread_created", "provider");
  const modes = sumDims(data.eventDims ?? [], "app_mode", "mode");
  const threads = sumEvents(data.events ?? [], "thread_created");
  return `
    <header class="top">
      <div class="brand"><span class="mark">a</span> agmux owner</div>
      <div class="sp"></div>
      <span class="who">${esc(me.user?.githubLogin ?? "")}</span>
      <button class="btn" id="out" type="button">Sign out</button>
    </header>
    <main class="page">
      <div class="phead">
        <div>
          <h1>Product</h1>
          <div class="meta">Anonymous installs · updated ${esc(data.asOf?.replace("T", " ").slice(0, 16) ?? "")} UTC</div>
        </div>
        <div class="sp"></div>
        <div class="seg" id="range">
          ${[7, 30, 90].map((d) => `<button data-d="${d}" class="${d === days ? "on" : ""}">${d}d</button>`).join("")}
        </div>
      </div>
      <section class="stats">
        <div class="stat"><span class="k">Installs</span><span class="v">${fmt(data.installsTotal)}</span><span class="s">all time</span></div>
        <div class="stat"><span class="k">New</span><span class="v">${fmt(data.installsNew)}</span><span class="s">last ${days}d</span></div>
        <div class="stat"><span class="k">Today</span><span class="v">${fmt(data.todayDau)}</span><span class="s">active installs</span></div>
        <div class="stat"><span class="k">WAU</span><span class="v">${fmt(data.wau)}</span><span class="s">last 7 days</span></div>
        <div class="stat"><span class="k">MAU</span><span class="v">${fmt(data.mau)}</span><span class="s">last 28 days</span></div>
      </section>
      <section class="grid">
        <div class="card">
          <h2>Daily active installs</h2>
          ${bars(data.dau ?? [])}
        </div>
        <div class="card">
          <h2>App version</h2>
          <div class="mix">${mix(versions)}</div>
        </div>
      </section>
      <section class="grid">
        <div class="card">
          <h2>New chats · ${fmt(threads)}</h2>
          <div class="mix">${mix(providers)}</div>
        </div>
        <div class="card">
          <h2>App mode</h2>
          <div class="mix">${mix(modes)}</div>
        </div>
      </section>
      <section class="card">
        <h2>macOS</h2>
        <div class="mix">${mix(os)}</div>
      </section>
    </main>`;
}

async function render(days = 30) {
  const root = $("#app");
  const params = new URLSearchParams(location.search);
  let me;
  try {
    me = await api("/api/auth/me");
  } catch (e) {
    root.innerHTML = loginView({ auth: {} }, e.message);
    return;
  }
  if (!me.user) {
    const denied = params.get("denied") ? "That GitHub account isn't on the owner list." : "";
    root.innerHTML = loginView(me, denied);
    bindLogin();
    return;
  }
  try {
    const data = await api(`/api/summary?days=${days}`);
    root.innerHTML = dashView(me, data, days);
    const inbox = document.createElement("section");
    inbox.className = "card";
    $("main").prepend(inbox);
    void renderSupport(inbox);
    $("#out")?.addEventListener("click", async () => {
      await api("/api/auth/logout", { method: "POST" });
      location.reload();
    });
    $("#range")?.addEventListener("click", (ev) => {
      const d = Number(ev.target?.dataset?.d);
      if (d) void render(d);
    });
  } catch (e) {
    root.innerHTML = loginView(me, e.message);
    bindLogin();
  }
}

function bindLogin() {
  $("#pw")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = new FormData(e.target).get("password");
    try {
      await api("/api/auth/password", { method: "POST", body: JSON.stringify({ password }) });
      location.replace("/");
    } catch (err) {
      $("#app").innerHTML = loginView(
        { auth: { password: true } },
        err.message,
      );
      bindLogin();
    }
  });
  $("#dev")?.addEventListener("click", async () => {
    await api("/api/auth/dev", { method: "POST" });
    location.replace("/");
  });
}

void render();

async function renderSupport(root, before = "", append = false) {
  try {
    const reports = await api(`/api/support${before ? `?before=${encodeURIComponent(before)}` : ""}`);
    if (!append) root.innerHTML = '<h2>Support inbox</h2><div id="support-reports"></div>';
    const list = $("#support-reports", root);
    if (!reports.length && !append) list.textContent = "No reports yet.";
    for (const report of reports) {
      const article = document.createElement("details");
      article.style.cssText = "padding:16px 0;border-bottom:1px solid #333";
      const files = JSON.parse(report.attachments || "[]");
      article.innerHTML = `<summary>${esc(report.status)} · ${esc(report.kind)} · ${esc(report.title)} <small>${esc(report.created_at)}</small></summary>
        <p>${esc(report.app_version)} · ${esc(report.system)}</p>
        <p>Reply email: ${esc(report.email || "Not provided")}</p>
        <pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(report.description)}</pre>
        <p>Reference: ${esc(report.id)}</p>
        <div>${files.map(f => `<p><a class="btn" href="/api/support/attachment/${encodeURIComponent(report.id)}/${encodeURIComponent(f.id)}">Download ${esc(f.name)} (${fmt(f.size)} bytes)</a></p>`).join("")}</div>
        <button class="btn" type="button">${report.status === "open" ? "Mark resolved" : "Reopen"}</button><p role="alert"></p>`;
      $("button", article).addEventListener("click", async (event) => {
        event.target.disabled = true;
        try {
          await api(`/api/support/${report.id}`, { method: "PATCH", body: JSON.stringify({ status: report.status === "open" ? "resolved" : "open" }) });
          await renderSupport(root);
        } catch (error) { $('[role="alert"]', article).textContent = error.message; event.target.disabled = false; }
      });
      list.append(article);
    }
    $(".support-more", root)?.remove();
    if (reports.length === 50) {
      const more = document.createElement("button"); more.className = "btn support-more"; more.textContent = "Load older reports";
      more.onclick = () => { more.disabled = true; void renderSupport(root, reports[reports.length - 1].created_at, true); };
      root.append(more);
    }
  } catch (error) { root.textContent = `Support inbox could not load: ${error.message}`; }
}
