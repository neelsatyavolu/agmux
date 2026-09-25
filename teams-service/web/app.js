import { mountRestrictions, restrictionsPage } from "./views/restrictions.js";
/* agmux Teams — SPA shell: hash routing, chrome, chart mounting, actions.
   Deliberately framework-free: the design ships as HTML, and staying close to
   HTML is what keeps the port faithful. */

import { $, $$, esc, html, icons, initials, onClick, raw, toast } from "./dom.js";
import { api, ApiError, exportCsvUrl, linkProviderUrl } from "./api.js";
import * as charts from "./charts.js";
import { auditList, avatar, brandMark, skeletonDashboard } from "./components.js";
import { landing, noTeams, createTeam, bindCreateTeam } from "./views/landing.js";
import { teamHome } from "./views/team.js";
import { memberDetail } from "./views/member.js";
import { membersDirectory, sortMembers } from "./views/members.js";
import { teamSettings, pickPeopleDialog, editScopeDialog } from "./views/settings.js";
import { teamPlan } from "./views/plan.js";
import {
  LB_SORT_DEFAULTS,
  leaderboardView,
  weekUtcToCustomRange,
} from "./views/leaderboard.js";
import { knowledgeView, bindKnowledge } from "./views/knowledge.js";
import * as join from "./views/join.js";
import { privacy } from "./views/privacy.js";
import { teamHelp } from "./views/help.js";
import { maybeShowBillingNotice } from "./views/billing-notice.js";

let app = $("#app");
const chrome = $("#chrome");

/**
 * Views attach delegated listeners to #app. Swapping in a fresh node between
 * routes drops them all, so re-entering a view (a range change re-runs it)
 * can't stack duplicate handlers.
 */
function resetApp() {
  const fresh = document.createElement("main");
  fresh.id = "app";
  fresh.setAttribute("aria-live", "polite");
  app.replaceWith(fresh);
  app = fresh;
}

const state = {
  user: null,
  teams: [],
  team: null,
  hasGithub: false,
  leaderboardEnabled: false,
  /** Server features.knowledge after migration; hide nav on older backends. */
  knowledgeAvailable: false,
  /**
   * Paid-plan features (Knowledge, Leaderboard): "full" | "read_only" | "locked".
   * From team billing.paidFeatures; defaults full when billing not loaded / enforce off.
   */
  paidFeatures: "full",
  // Preset key ("30d") or { from, to } for a custom window.
  range: loadStoredRange(),
};

function applyTeamBilling(info) {
  if (info?.billing?.paidFeatures) {
    state.paidFeatures = info.billing.paidFeatures;
  } else if (info?.billing?.enforce === false) {
    state.paidFeatures = "full";
  } else if (info?.billing) {
    // Older snapshots without paidFeatures: free forever ⇒ locked for paid extras.
    state.paidFeatures =
      info.billing.onFreeTierize &&
      !info.billing.hasSubscription &&
      info.billing.status !== "active" &&
      info.billing.status !== "comp" &&
      info.billing.status !== "past_due"
        ? "locked"
        : "full";
  }
}

function applyTeamInfo(info) {
  if (info?.team) state.team = { ...info.team, staffPreview: Boolean(info.staffPreview) };
  if (info?.features) state.knowledgeAvailable = Boolean(info.features.knowledge);
  applyTeamBilling(info);
}

function paidFeaturesUnlocked() {
  return state.paidFeatures !== "locked";
}

function loadStoredRange() {
  try {
    const raw = localStorage.getItem("agmux.teams.range");
    if (!raw) return "30d";
    if (raw.startsWith("{")) {
      const o = JSON.parse(raw);
      if (o?.from && o?.to) return { from: o.from, to: o.to };
    }
    if (["7d", "14d", "30d", "90d"].includes(raw)) return raw;
  } catch {
    /* fall through */
  }
  return "30d";
}

function persistRange(range) {
  state.range = range;
  localStorage.setItem(
    "agmux.teams.range",
    typeof range === "object" ? JSON.stringify(range) : range,
  );
}

/* ── routing ──────────────────────────────────────────────────────────── */

/** `/join/<token>` is a real path (invite links must survive email clients);
    everything else lives behind the hash so the Worker serves one document. */
function currentRoute() {
  const path = location.pathname;
  if (path.startsWith("/join/")) {
    return { name: "join", token: decodeURIComponent(path.slice("/join/".length)) };
  }
  if (path === "/link") return { name: "link" };

  const hash = location.hash.replace(/^#/, "") || "/";
  const parts = hash.split("/").filter(Boolean);

  if (!parts.length) return { name: "root" };
  if (parts[0] === "privacy") return { name: "privacy" };
  if (parts[0] === "teams") {
    return parts[1] === "new" ? { name: "team-new" } : { name: "teams" };
  }
  if (parts[0] === "t" && parts[1]) {
    const slug = decodeURIComponent(parts[1]);
    if (parts[2] === "restrictions") return { name: "team-restrictions", slug };
    if (parts[2] === "settings") return { name: "team-settings", slug };
    if (parts[2] === "plan") return { name: "team-plan", slug };
    if (parts[2] === "members") return { name: "team-members", slug };
    if (parts[2] === "knowledge") return { name: "knowledge", slug };
    if (parts[2] === "leaderboard") return { name: "leaderboard", slug };
    if (parts[2] === "help") return { name: "team-help", slug };
    if (parts[2] === "me") return { name: "self", slug };
    if (parts[2] === "m" && parts[3]) {
      return { name: "member", slug, userId: decodeURIComponent(parts[3]) };
    }
    return { name: "team", slug };
  }
  return { name: "root" };
}

export function navigate(to) {
  if (to.startsWith("#")) {
    if (location.pathname !== "/") {
      history.pushState({}, "", "/" + to);
      render();
      return;
    }
    location.hash = to.slice(1);
    return;
  }
  history.pushState({}, "", to);
  render();
}

/* ── chrome ───────────────────────────────────────────────────────────── */

function renderChrome(route) {
  const showChrome = [
    "teams",
    "team",
    "team-settings",
    "team-restrictions",
    "team-plan",
    "team-members",
    "knowledge",
    "leaderboard",
    "team-help",
    "member",
    "self",
    "team-new",
  ].includes(route.name);
  if (!showChrome || !state.user) {
    chrome.innerHTML = "";
    chrome.hidden = true;
    return;
  }
  chrome.hidden = false;

  const team = state.team;
  const slug = team ? encodeURIComponent(team.slug) : "";
  const teamEntry = state.teams.find((t) => t.id === team?.id);
  const teamRole = teamEntry?.role;
  const staffPreview = Boolean(teamEntry?.staffPreview || team?.staffPreview);
  const isOwner = teamRole === "owner" && !staffPreview;
  const isManager = teamRole === "manager" || teamRole === "owner" || staffPreview;
  const onOverview = route.name === "team" || route.name === "self";
  // Leaderboard + Knowledge are Teams-plan features (trial/active/comp).
  const showLb = isManager && state.leaderboardEnabled && paidFeaturesUnlocked();
  const showKw = state.knowledgeAvailable && paidFeaturesUnlocked();
  // Managers/owners see the directory; employees only see self via Overview → /me.
  const showMembersTab = isManager;

  chrome.innerHTML = html`
    <div class="wtop">
      <a class="brand" href="#/teams" title="All teams">
        ${raw(brandMark())}
        <b>agmux</b>
        <span class="brand-sub">Teams</span>
      </a>
      ${team
        ? raw(`<button class="tsw" id="teamSwitch" title="${esc(team.name)}"><span class="sq">${esc(
            initials(team.name)[0],
          )}</span><span class="tsw-nm">${esc(team.name)}</span><i data-lucide="chevrons-up-down"></i></button>${
            staffPreview ? `<span class="pill">Staff view</span>` : ""
          }`)
        : ""}
      ${team
        ? raw(`<nav class="wnav" aria-label="Team">
              <a href="#/t/${slug}" class="${onOverview ? "on" : ""}">Overview</a>
              ${
                showMembersTab
                  ? `<a href="#/t/${slug}/members" class="${route.name === "team-members" || route.name === "member" ? "on" : ""}">Members</a>`
                  : ""
              }
              ${
                showLb
                  ? `<a href="#/t/${slug}/leaderboard" class="${route.name === "leaderboard" ? "on" : ""}">Leaderboard</a>`
                  : ""
              }
              ${
                showKw
                  ? `<a href="#/t/${slug}/knowledge" class="${route.name === "knowledge" ? "on" : ""}">Knowledge</a>`
                  : ""
              }
              ${
                (teamRole === "owner" || teamRole === "manager") && !staffPreview
                  ? `<a href="#/t/${slug}/restrictions" class="${route.name === "team-restrictions" ? "on" : ""}">Restrictions</a>`
                  : ""
              }
              ${
                isOwner
                  ? `<a href="#/t/${slug}/settings" class="${route.name === "team-settings" ? "on" : ""}">Settings</a>
                     <a href="#/t/${slug}/plan" class="${route.name === "team-plan" ? "on" : ""}">Plan</a>`
                  : ""
              }
              <a href="#/t/${slug}/help" class="${route.name === "team-help" ? "on" : ""}">Help</a>
            </nav>`)
        : ""}
      <div class="sp"></div>
      <button class="btn" id="signOut">Sign out</button>
      ${raw(avatar(state.user.display_name, state.user.avatar_color, null, state.user.avatar_url))}
    </div>
  `;
  icons();

  const sw = $("#teamSwitch", chrome);
  if (sw) sw.addEventListener("click", () => openTeamSwitcher(sw));
  $("#signOut", chrome)?.addEventListener("click", async () => {
    await api.logout().catch(() => {});
    state.user = null;
    navigate("#/");
    location.reload();
  });
}

function openTeamSwitcher(anchor) {
  $(".tswmenu")?.remove();
  const menu = document.createElement("div");
  menu.className = "tswmenu";
  menu.innerHTML = html`
    ${state.teams.map(
      (t) => html`<button data-goto="${t.slug}">
        <span class="sq"
          >${initials(t.name)[0]}</span
        >
        ${t.name}<span class="role ${t.role === "owner" && !t.staffPreview ? "owner" : ""}">${t.staffPreview ? "staff" : t.role}</span>
      </button>`,
    )}
    <hr class="hr" />
    <button data-goto="__new">+ Create team</button>
  `;
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${r.left}px`;
  menu.style.top = `${r.bottom + 6}px`;
  document.body.appendChild(menu);
  icons();

  onClick(menu, "data-goto", (slug) => {
    menu.remove();
    navigate(slug === "__new" ? "#/teams/new" : `#/t/${encodeURIComponent(slug)}`);
  });
  setTimeout(() => {
    const close = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener("click", close);
      }
    };
    document.addEventListener("click", close);
  }, 0);
}

/* ── chart mounting ───────────────────────────────────────────────────── */

/** Charts are drawn after markup lands, from the same payload the view used. */
function mountCharts(data) {
  const dailyHost = $("[data-chart=daily]");
  if (dailyHost) charts.daily(dailyHost, data.daily);

  const heatHost = $("[data-chart=heat]");
  if (heatHost) charts.heat(heatHost, data.heatmap);

  const concHost = $("[data-chart=conc]");
  if (concHost) {
    const values = data.daily.map((d) => d.peakConcurrent);
    const dayLabels = data.daily.map((d) => d.full);
    charts.steps(concHost, values, [`${data.daily.length}d ago`, "mid", "today"], dayLabels);
  }

  const series = {
    tok: data.daily.map((d) => d.tokens),
    cost: data.daily.map((d) => d.tokens), // cost tracks tokens in shape
    hrs: data.daily.map((d) => d.activeHours),
    ses: data.daily.map((d) => d.sessionsStarted),
    con: data.daily.map((d) => d.peakConcurrent),
  };
  $$("svg.spark[data-spark]").forEach((svg) => {
    const key = svg.dataset.spark;
    charts.spark(svg, series[key] ?? [], key === "con" ? "var(--amber)" : null);
  });
}

/* ── shared behaviours ────────────────────────────────────────────────── */

function bindRange(reload) {
  onClick(app, "data-range", (value) => {
    if (value === "custom") {
      // Reveal the date inputs; only apply once the user hits Apply.
      const box = app.querySelector(".range-custom");
      if (box) box.hidden = false;
      // Seed empty inputs with the last 30 days if blank.
      const fromEl = app.querySelector("[data-range-from]");
      const toEl = app.querySelector("[data-range-to]");
      if (fromEl && !fromEl.value) {
        const to = new Date();
        const from = new Date(to.getTime() - 29 * 86_400_000);
        toEl.value = to.toISOString().slice(0, 10);
        fromEl.value = from.toISOString().slice(0, 10);
      }
      // Mark Custom active without refetching yet.
      app.querySelectorAll(".seg [data-range]").forEach((b) =>
        b.classList.toggle("on", b.getAttribute("data-range") === "custom"),
      );
      return;
    }
    persistRange(value);
    reload();
  });
  onClick(app, "data-range-apply", () => {
    const from = app.querySelector("[data-range-from]")?.value;
    const to = app.querySelector("[data-range-to]")?.value;
    if (!from || !to) {
      toast("Pick a start and end date.");
      return;
    }
    if (from > to) {
      toast("Start date must be on or before the end date.");
      return;
    }
    persistRange({ from, to });
    reload();
  });
}

async function viewMembers(slug) {
  resetApp();
  app.innerHTML = `<section class="page">${skeletonDashboard(3)}</section>`;
  icons();
  try {
    const info = await api.getTeam(slug);
    applyTeamInfo(info);
    if (info.role === "owner" || info.role === "manager") {
      try {
        const { settings } = await api.leaderboardSettings(slug);
        state.leaderboardEnabled = Boolean(settings?.enabled);
      } catch {
        state.leaderboardEnabled = false;
      }
    } else {
      state.leaderboardEnabled = false;
    }

    // Employees don't get a team directory — their Overview is already /me.
    if (info.role === "employee") {
      navigate(`#/t/${encodeURIComponent(slug)}/me`);
      return;
    }

    renderChrome({ name: "team-members", slug });

    const data = await api.overview(slug, state.range);
    if (data.scope === "self") {
      navigate(`#/t/${encodeURIComponent(slug)}/me`);
      return;
    }

    let sortKey = "activeHours";
    let sortAsc = false;

    const draw = (list, key) => {
      app.innerHTML = membersDirectory({
        team: info.team,
        role: info.role,
        members: list,
        range: data.range,
        from: data.from,
        to: data.to,
        sortKey: key,
        memberCount: data.memberCount ?? list.length,
        scopeLabel: data.scope === "partial" ? data.scopeLabel || "Your people" : null,
      });
      icons();
    };

    draw(sortMembers(data.members, sortKey, sortAsc), sortKey);

    bindRange(() => viewMembers(slug));

    onClick(app, "data-mem-sort", (key) => {
      if (!key) return;
      if (key === sortKey) sortAsc = !sortAsc;
      else {
        sortKey = key;
        sortAsc = key === "name";
      }
      draw(sortMembers(data.members, sortKey, sortAsc), sortKey);
    });
  } catch (err) {
    fail(err);
  }
}

function fail(err) {
  const message = err instanceof ApiError ? err.message : "Something went wrong.";
  app.innerHTML = html`
    <section class="page">
      <div class="pnl">
        <div class="empty">
          <div
            class="ic"
            style="color:var(--red-text);border-color:var(--red-line);background:var(--red-soft)"
          >
            <i data-lucide="alert-triangle"></i>
          </div>
          <h3>Couldn't load that</h3>
          <p>${message}</p>
          <div style="display:flex;gap:9px"><a class="btn" href="#/teams">Back to your teams</a></div>
        </div>
      </div>
    </section>
  `;
  icons();
}

/* ── views ────────────────────────────────────────────────────────────── */

async function loadSession() {
  try {
    const me = await api.me();
    state.user = me.user;
    state.hasGithub = Boolean(me.hasGithub);
  } catch {
    state.user = null;
    state.hasGithub = false;
  }
  if (state.user) {
    try {
      state.teams = (await api.listTeams()).teams;
    } catch {
      state.teams = [];
    }
  }
}

async function viewTeams() {
  if (!state.teams.length) {
    app.innerHTML = noTeams();
    icons();
    return;
  }
  navigate(`#/t/${encodeURIComponent(state.teams[0].slug)}`);
}

async function viewTeam(slug) {
  resetApp();
  app.innerHTML = `<section class="page">${skeletonDashboard(5)}</section>`;
  icons();
  try {
    const info = await api.getTeam(slug);
    applyTeamInfo(info);
    if (info.role === "owner" || info.role === "manager") {
      try {
        const { settings } = await api.leaderboardSettings(slug);
        state.leaderboardEnabled = Boolean(settings?.enabled);
      } catch {
        state.leaderboardEnabled = false;
      }
    } else {
      state.leaderboardEnabled = false;
    }
    renderChrome({ name: "team", slug });

    const data = await api.overview(slug, state.range);
    if (data.scope === "self") {
      // An employee who lands on the team URL gets their own view, not a 403.
      navigate(`#/t/${encodeURIComponent(slug)}/me`);
      return;
    }

    app.innerHTML = teamHome({
      team: info.team,
      data,
      role: info.role,
    });
    icons();
    mountCharts(data);

    // Owner-only: explain subscription switch + 30-day trial for existing teams.
    void maybeShowBillingNotice({
      slug,
      teamId: info.team.id,
      role: info.role,
      billing: info.billing,
    });

    bindRange(() => viewTeam(slug));

    // The activity log is a second request on purpose — it is never the reason
    // the dashboard is slow to paint.
    if (data.canViewAudit) loadAudit(slug);

    onClick(app, "data-act", async (action) => {
      if (action === "export-csv") {
        // A plain navigation, so the browser handles the download itself.
        window.location.assign(exportCsvUrl(slug, state.range));
        return;
      }
      if (action === "edit-budget") {
        await promptBudget(slug, data.budget);
      }
    });
  } catch (err) {
    fail(err);
  }
}

/** Fills the activity-log panel once the dashboard is already on screen. */
async function loadAudit(slug) {
  const slot = $('[data-slot="audit"]');
  if (!slot) return;
  try {
    const { entries } = await api.audit(slug);
    slot.innerHTML = auditList(entries);
    icons();
  } catch {
    // The log is supplementary; a failure here must not blank the dashboard.
    slot.innerHTML = `<div class="pnl-b"><p class="hint" style="margin:0">Couldn't load the activity log.</p></div>`;
  }
}

/**
 * Budget editing.
 *
 * `prompt` rather than a modal: this is one number and two optional fields,
 * and the SPA has no dialog primitive to borrow. An empty answer cancels; a
 * zero clears the budget, which the server treats as "no budget set".
 */
async function promptBudget(slug, current) {
  const answer = window.prompt(
    "Monthly budget in USD for this team.\nEnter 0 to remove the budget.",
    current ? String(current.monthlyUsd) : "1000",
  );
  if (answer === null) return;
  const monthlyUsd = Number(answer);
  if (!Number.isFinite(monthlyUsd) || monthlyUsd < 0) {
    toast("That isn't a valid amount.", "error");
    return;
  }

  let thresholds = current?.thresholds?.join(",") ?? "80,100";
  let webhookUrl;
  if (monthlyUsd > 0) {
    const t = window.prompt(
      "Alert when spend crosses these percentages (comma separated).",
      thresholds,
    );
    if (t === null) return;
    thresholds = t;
    const w = window.prompt(
      "Optional https webhook to notify (Slack-compatible). Leave blank for none.",
      "",
    );
    if (w === null) return;
    webhookUrl = w.trim();
  }

  try {
    await api.setBudget(slug, { monthlyUsd, thresholds, webhookUrl });
    toast(monthlyUsd > 0 ? "Budget saved." : "Budget removed.");
    viewTeam(slug);
  } catch (err) {
    toast(err.message, "error");
  }
}

async function viewMember(slug, userId, isSelf) {
  resetApp();
  app.innerHTML = `<section class="page">${skeletonDashboard(4)}</section>`;
  icons();
  try {
    const info = await api.getTeam(slug);
    applyTeamInfo(info);
    renderChrome({ name: isSelf ? "self" : "member" });

    const data = isSelf
      ? await api.selfDetail(slug, state.range)
      : await api.memberDetail(slug, userId, state.range);

    const lbCtx = takeLeaderboardDrill(slug, userId ?? data.member?.user_id);
    app.innerHTML = memberDetail({
      team: info.team,
      data,
      isSelf: data.isSelf,
      fromLeaderboard: lbCtx,
    });
    icons();
    mountCharts(data);
    bindRange(() => viewMember(slug, userId, isSelf));
  } catch (err) {
    fail(err);
  }
}

/** One-shot context when opening a member from the leaderboard (week range). */
function takeLeaderboardDrill(slug, userId) {
  try {
    const raw = sessionStorage.getItem("agmux.teams.lbDrill");
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o?.week || o.slug !== slug) return null;
    // Match row or self-view of the same person.
    if (userId && o.userId && o.userId !== userId) return null;
    sessionStorage.removeItem("agmux.teams.lbDrill");
    return { week: o.week, from: o.from, to: o.to };
  } catch {
    return null;
  }
}

function setLeaderboardDrill({ slug, userId, week, from, to }) {
  try {
    sessionStorage.setItem(
      "agmux.teams.lbDrill",
      JSON.stringify({ slug, userId, week, from, to }),
    );
  } catch {
    /* private mode */
  }
}

async function viewHelp(slug) {
  resetApp();
  try {
    const info = await api.getTeam(slug);
    applyTeamInfo(info);
    if (info.role === "owner" || info.role === "manager") {
      try {
        const { settings } = await api.leaderboardSettings(slug);
        state.leaderboardEnabled = Boolean(settings?.enabled);
      } catch {
        /* keep prior */
      }
    }
    renderChrome({ name: "team-help", slug });
    app.innerHTML = teamHelp({ team: info.team, role: info.role });
    icons();
  } catch (err) {
    fail(err);
  }
}

async function viewPlan(slug) {
  resetApp();
  try {
    const [info, membersRes, billingRes] = await Promise.all([
      api.getTeam(slug),
      api.members(slug).catch(() => ({ members: [] })),
      api.getBilling(slug).catch(() => null),
    ]);
    applyTeamInfo(info);
    let billing = billingRes?.billing ?? info.billing ?? null;
    if (billing) applyTeamBilling({ billing });
    const prices = billingRes?.prices ?? null;
    const membersCount = membersRes.members?.length ?? billing?.seats ?? 0;

    renderChrome({ name: "team-plan" });

    const draw = () => {
      app.innerHTML = teamPlan({
        team: info.team,
        role: info.role,
        billing,
        prices,
        membersCount,
      });
      icons();
    };
    draw();

    void maybeShowBillingNotice({
      slug,
      teamId: info.team.id,
      role: info.role,
      billing,
    });

    // Return from Stripe Checkout — confirm payment into D1 (webhook may lag).
    try {
      const hash = location.hash || "";
      const q = hash.includes("?") ? new URLSearchParams(hash.slice(hash.indexOf("?") + 1)) : null;
      const billingFlag = q?.get("billing");
      const sessionId = q?.get("session_id");
      if (billingFlag === "success" && sessionId && info.role === "owner") {
        const res = await api.billingConfirm(slug, sessionId);
        if (res.confirmed) toast("Subscription active — thank you.");
        else toast("Payment received — status will update shortly.");
        history.replaceState({}, "", `#/t/${encodeURIComponent(slug)}/plan`);
        if (res.billing) {
          billing = res.billing;
          draw();
        }
      } else if (billingFlag === "cancel") {
        toast("Checkout canceled.");
        history.replaceState({}, "", `#/t/${encodeURIComponent(slug)}/plan`);
      }
    } catch (err) {
      if (err instanceof ApiError) toast(err.message, "error");
    }

    let planBusy = false;
    onClick(app, "data-act", async (action) => {
      if (planBusy) return;
      planBusy = true;
      try {
        if (action === "billing-checkout-month" || action === "billing-checkout-year") {
          const interval = action.endsWith("year") ? "year" : "month";
          const seatsEl = document.getElementById("billing-seats");
          const seatsRaw = seatsEl?.value?.trim();
          const seats =
            seatsRaw === "" || seatsRaw == null ? undefined : Math.trunc(Number(seatsRaw));
          const { url } = await api.billingCheckout(
            slug,
            interval,
            Number.isFinite(seats) ? seats : undefined,
          );
          if (url) window.location.href = url;
          return;
        }
        if (action === "billing-portal") {
          const { url } = await api.billingPortal(slug);
          if (url) window.location.href = url;
          return;
        }
        if (action === "billing-seats-update") {
          const el = document.getElementById("billing-seats-live");
          const n = Math.trunc(Number(el?.value));
          if (!Number.isFinite(n) || n < 1) {
            toast("Enter a valid seat count.", "error");
            return;
          }
          const res = await api.billingSetSeats(slug, n);
          if (
            res.billing?.pendingSeatQuantity != null &&
            res.billing.pendingSeatQuantity < (res.billing.seatQuantity ?? n)
          ) {
            toast(
              `Seats will drop to ${res.billing.pendingSeatQuantity} at the next billing period.`,
            );
          } else {
            toast(`Licensed seats set to ${res.billing?.seatQuantity ?? n}.`);
          }
          billing = res.billing ?? billing;
          draw();
          return;
        }
      } catch (err) {
        toast(err.message, "error");
      } finally {
        planBusy = false;
      }
    });
  } catch (err) {
    fail(err);
  }
}

async function viewRestrictions(slug) {
  resetApp();
  const page = app;
  page.innerHTML = '<section class="page restrictions-page"><p role="status">Loading restrictions…</p></section>';
  try {
    const info = await api.getTeam(slug);
    if (!page.isConnected) return;
    applyTeamInfo(info);
    renderChrome({ name: "team-restrictions" });
    page.innerHTML = restrictionsPage(info.team);
    await mountRestrictions(page.querySelector("#restrictions"), api, slug);
  } catch (err) {
    if (page.isConnected) fail(err);
  }
}

async function viewSettings(slug) {
  resetApp();
  try {
    const [info, membersRes, inviteRes, groupsRes, scopesRes] = await Promise.all([
      api.getTeam(slug),
      api.members(slug),
      api.getInvite(slug).catch(() => ({ invite: null })),
      api.groups(slug).catch(() => ({ groups: [] })),
      api.managerScopes(slug).catch(() => ({ scopes: [] })),
    ]);
    let members = membersRes.members;
    let groups = groupsRes.groups ?? [];
    let managerScopes = scopesRes.scopes ?? [];
    applyTeamInfo(info);

    let lbSettings = null;
    let lbRepos = null;
    if (info.role === "owner") {
      try {
        const [s, r] = await Promise.all([
          api.leaderboardSettings(slug),
          api.leaderboardRepos(slug).catch(() => ({ selected: [], available: [] })),
        ]);
        lbSettings = s.settings;
        lbRepos = r;
        state.leaderboardEnabled = Boolean(lbSettings?.enabled);
      } catch {
        /* optional */
      }
    }

    renderChrome({ name: "team-settings" });

    const draw = (invite) => {
      app.innerHTML = teamSettings({
        team: info.team,
        role: info.role,
        members,
        invite,
        groups,
        managerScopes,
        leaderboard: lbSettings,
        leaderboardRepos: lbRepos,
      });
      icons();
    };
    draw(inviteRes.invite);

    const reloadSettings = () => viewSettings(slug);

    // Prevent double-clicks / stacked prompts while an async action is open.
    let settingsBusy = false;

    onClick(app, "data-act", async (action, el) => {
      if (settingsBusy) return;
      settingsBusy = true;
      try {
        if (action === "rename") {
          const name = $("#tn2").value.trim();
          if (!name) return toast("Give the team a name.", "error");
          await api.renameTeam(slug, name);
          toast("Team renamed.");
          state.team = { ...state.team, name };
          renderChrome({ name: "team-settings" });
        } else if (action === "delete") {
          if (!confirm(`Delete ${info.team.name}? This removes every uploaded aggregate and cannot be undone.`))
            return;
          await api.deleteTeam(slug);
          state.teams = state.teams.filter((t) => t.slug !== slug);
          state.team = null;
          navigate("#/teams");
        } else if (action === "invite-create") {
          const { invite } = await api.createInvite(slug);
          draw(invite);
          toast("New invite link created.");
        } else if (action === "invite-revoke") {
          await api.revokeInvite(slug);
          draw({ ...inviteRes.invite, state: "revoked" });
          toast("Invite revoked.");
        } else if (action === "invite-copy") {
          await navigator.clipboard.writeText(el.dataset.url);
          const original = el.innerHTML;
          el.innerHTML = '<i data-lucide="check"></i>Copied';
          icons();
          setTimeout(() => {
            el.innerHTML = original;
            icons();
          }, 1400);
        } else if (action === "group-create") {
          // Single modal: name + people (no window.prompt first).
          const pick = await pickPeopleDialog({
            title: "New group",
            members,
            selectedIds: [],
            nameValue: "",
            saveLabel: "Create group",
          });
          if (pick === null) return;
          await api.createGroup(slug, { name: pick.name, memberIds: pick.userIds });
          toast("Group created.");
          reloadSettings();
        } else if (action === "group-rename") {
          const current = el.dataset.groupName ?? "";
          const pick = await pickPeopleDialog({
            title: "Rename group",
            members: [],
            selectedIds: [],
            nameValue: current,
            nameLabel: "Name",
            saveLabel: "Rename",
          });
          if (pick === null) return;
          await api.renameGroup(slug, el.dataset.groupId, pick.name);
          toast("Group renamed.");
          reloadSettings();
        } else if (action === "group-delete") {
          if (!confirm(`Delete group “${el.dataset.groupName}”? Managers using it will lose that part of their scope.`))
            return;
          await api.deleteGroup(slug, el.dataset.groupId);
          toast("Group deleted.");
          reloadSettings();
        } else if (action === "group-edit") {
          const groupId = el.dataset.groupId;
          const detail = await api.getGroup(slug, groupId);
          const pick = await pickPeopleDialog({
            title: `People in “${detail.group.name}”`,
            members,
            selectedIds: detail.group.memberIds ?? [],
          });
          if (pick === null) return;
          await api.setGroupMembers(slug, groupId, pick.userIds);
          toast("Group updated.");
          reloadSettings();
        } else if (action === "scope-edit") {
          const userId = el.dataset.userId;
          const person = members.find((m) => m.user_id === userId);
          const current = await api.getMemberScope(slug, userId);
          const result = await editScopeDialog({
            memberName: person?.display_name ?? "this manager",
            members,
            groups,
            current: {
              mode: current.mode,
              userIds: current.userIds ?? [],
              groupIds: current.groupIds ?? [],
            },
          });
          if (result === null) return;
          if (result.mode === "custom" && !result.userIds.length && !result.groupIds.length) {
            toast("Pick at least one person or group, or choose Entire team.", "error");
            return;
          }
          await api.setMemberScope(slug, userId, result);
          toast("Manager scope updated.");
          reloadSettings();
        } else if (action === "lb-install") {
          const { url } = await api.leaderboardInstallUrl(slug);
          location.href = url;
        } else if (action === "lb-unlink") {
          if (!confirm("Disconnect GitHub org from leaderboard?")) return;
          const res = await api.patchLeaderboardSettings(slug, { unlink: true });
          lbSettings = res.settings;
          toast("GitHub disconnected.");
          draw(inviteRes.invite);
        } else if (action === "lb-sync") {
          const res = await api.leaderboardSync(slug);
          if (res.error) toast(res.error, "error");
          else if (res.partial) toast(`Synced ${res.upserted} PRs (partial; more next hour).`);
          else toast(`Synced ${res.upserted} PRs.`);
          reloadSettings();
        } else if (action === "lb-save-repos") {
          const repos = [...app.querySelectorAll("[data-lb-repo]:checked")].map(
            (n) => n.getAttribute("data-lb-repo"),
          );
          lbRepos = await api.setLeaderboardRepos(slug, repos);
          toast("Repositories saved — syncing…");
          try {
            const syncRes = await api.leaderboardSync(slug);
            if (syncRes.error) toast(`Saved; sync failed: ${syncRes.error}`, "error");
            else if (syncRes.partial) toast(`Saved; synced ${syncRes.upserted} PR(s) (partial).`);
            else toast(`Saved; synced ${syncRes.upserted} PR(s).`);
          } catch (err) {
            toast(`Saved repos; sync failed: ${err.message}`, "error");
          }
          reloadSettings();
        } else if (action === "lb-save-weights") {
          const res = await api.patchLeaderboardSettings(slug, {
            thresholds: {
              smallMax: Number($("#lb-th-s")?.value),
              mediumMax: Number($("#lb-th-m")?.value),
            },
            weights: {
              small: Number($("#lb-w-s")?.value),
              medium: Number($("#lb-w-m")?.value),
              large: Number($("#lb-w-l")?.value),
              merge: Number($("#lb-w-merge")?.value),
            },
          });
          lbSettings = res.settings;
          toast("Leaderboard weights saved.");
          draw(inviteRes.invite);
        }
      } catch (err) {
        toast(err.message, "error");
      } finally {
        settingsBusy = false;
      }
    });

    app.addEventListener("change", async (e) => {
      const en = e.target.closest("[data-lb-enabled]");
      if (en) {
        try {
          const res = await api.patchLeaderboardSettings(slug, { enabled: en.checked });
          lbSettings = res.settings;
          state.leaderboardEnabled = Boolean(lbSettings?.enabled);
          toast(en.checked ? "Leaderboard enabled." : "Leaderboard disabled.");
          renderChrome({ name: "team-settings" });
        } catch (err) {
          toast(err.message, "error");
          en.checked = !en.checked;
        }
        return;
      }
      const sel = e.target.closest("[data-role-for]");
      if (!sel) return;
      try {
        await api.setRole(slug, sel.dataset.roleFor, sel.value);
        toast(
          sel.value === "manager"
            ? "Promoted to manager (entire team). Edit scope anytime."
            : "Role updated.",
        );
        reloadSettings();
      } catch (err) {
        toast(err.message, "error");
      }
    });

    onClick(app, "data-remove", async (userId) => {
      const person = members.find((m) => m.user_id === userId);
      if (!confirm(`Remove ${person?.display_name ?? "this member"} from ${info.team.name}?`)) return;
      try {
        await api.removeMember(slug, userId);
        toast("Member removed.");
        viewSettings(slug);
      } catch (err) {
        toast(err.message, "error");
      }
    });
  } catch (err) {
    fail(err);
  }
}

async function viewJoin(token) {
  resetApp();
  chrome.hidden = true;
  let preview;
  try {
    preview = await api.previewInvite(token);
  } catch {
    app.innerHTML = join.joinUnknown();
    icons();
    return;
  }

  if (preview.state !== "active") {
    app.innerHTML = join.joinDead(preview);
    icons();
    return;
  }

  if (!state.user) {
    app.innerHTML = join.joinSignIn(preview, token);
    icons();
    return;
  }

  app.innerHTML = join.joinDisclose(preview);
  icons();

  const acc = $("#acc");
  const btn = $("#joinBtn");
  acc.addEventListener("change", () => {
    btn.disabled = !acc.checked;
  });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const { team } = await api.acceptInvite(token);
      state.teams = (await api.listTeams()).teams;
      app.innerHTML = join.joinDone(team);
      icons();
    } catch (err) {
      toast(err.message, "error");
      app.innerHTML = join.joinDead({ state: "expired", expiresAt: preview.expiresAt });
      icons();
    }
  });
}

/** The desktop app's browser half: sign in, confirm, bind the code, then send them back. */
async function viewLink() {
  resetApp();
  chrome.hidden = true;
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const label = (params.get("label") || "").trim();

  if (!state.user) {
    const qs = new URLSearchParams();
    if (code) qs.set("code", code);
    if (label) qs.set("label", label);
    const next = `/link${qs.toString() ? `?${qs}` : ""}`;
    app.innerHTML = landing({ next });
    icons();
    return;
  }

  if (!code) {
    app.innerHTML = linkPanel({
      ok: false,
      title: "Nothing to link",
      body: "Open this page from agmux (Settings → Teams → Sign in) so it can hand over its link request.",
    });
    icons();
    return;
  }

  // Explicit confirm — never auto-attach on page load (accidental link / open-in-browser).
  const who = state.user.display_name || "your account";
  const deviceLine = label
    ? raw(`Device: <strong>${esc(label)}</strong>`)
    : "This will authorize the agmux desktop app that opened this page.";
  app.innerHTML = html`
    <section class="center">
      <div class="col">
        <div class="pnl">
          <div class="empty">
            <div class="ic" style="color:var(--blue);border-color:var(--blue-line);background:var(--blue-soft)">
              <i data-lucide="laptop"></i>
            </div>
            <h3>Link this device?</h3>
            <p>
              Sign-in as ${who} will be connected to your desktop app.
              ${deviceLine}
            </p>
            <div style="display:flex;gap:9px;flex-wrap:wrap;justify-content:center">
              <a class="btn" href="#/teams">Cancel</a>
              <button class="btn primary" type="button" id="linkConfirm">Link device</button>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
  icons();

  $("#linkConfirm")?.addEventListener("click", async () => {
    const btn = $("#linkConfirm");
    if (btn) btn.disabled = true;
    try {
      await api.attachDevice(code);
    } catch (err) {
      app.innerHTML = linkPanel({ ok: false, title: "Couldn't link this Mac", body: err.message });
      icons();
      return;
    }
    app.innerHTML = linkPanel({
      ok: true,
      title: "Desktop app linked",
      body: `You're signed in as ${state.user.display_name}. Return to agmux — it will pick up the link within a few seconds.`,
    });
    icons();
  });
}

function linkPanel({ ok, title, body }) {
  const tint = ok
    ? "color:var(--green-text);border-color:var(--green-line);background:var(--green-soft)"
    : "color:var(--red-text);border-color:var(--red-line);background:var(--red-soft)";
  return html`
    <section class="center">
      <div class="col">
        <div class="pnl">
          <div class="empty">
            <div class="ic" style="${raw(tint)}">
              <i data-lucide="${ok ? "check" : "alert-triangle"}"></i>
            </div>
            <h3>${title}</h3>
            <p>${body}</p>
            <div style="display:flex;gap:9px"><a class="btn" href="#/teams">Open your teams</a></div>
          </div>
        </div>
      </div>
    </section>
  `;
}

/* ── render ───────────────────────────────────────────────────────────── */

async function render() {
  const route = currentRoute();
  resetApp();
  renderChrome(route);

  if (route.name === "privacy") {
    app.innerHTML = privacy({ backHref: state.team ? `#/t/${state.team.slug}` : "#/teams" });
    icons();
    return;
  }
  if (route.name === "join") return viewJoin(route.token);
  if (route.name === "link") return viewLink();

  if (!state.user) {
    app.innerHTML = landing({});
    icons();
    return;
  }

  switch (route.name) {
    case "root":
    case "teams":
      return viewTeams();
    case "team-new":
      app.innerHTML = createTeam();
      icons();
      return bindCreateTeam(app, navigate);
    case "team":
      return viewTeam(route.slug);
    case "team-members":
      return viewMembers(route.slug);
    case "team-restrictions":
      return viewRestrictions(route.slug);
    case "team-settings":
      return viewSettings(route.slug);
    case "team-plan":
      return viewPlan(route.slug);
    case "team-help":
      return viewHelp(route.slug);
    case "knowledge":
      return viewKnowledge(route.slug);
    case "leaderboard":
      return viewLeaderboard(route.slug);
    case "member":
      return viewMember(route.slug, route.userId, false);
    case "self":
      return viewMember(route.slug, null, true);
    default:
      return viewTeams();
  }
}

async function viewKnowledge(slug, searchHits = null) {
  resetApp();
  try {
    const info = await api.getTeam(slug);
    applyTeamInfo(info);
    if (!state.knowledgeAvailable) {
      toast("Team Knowledge is not available on this server yet.");
      navigate(`#/t/${encodeURIComponent(slug)}`);
      return;
    }
    if (!paidFeaturesUnlocked()) {
      toast("Team Knowledge is on the Teams plan. Open Plan to upgrade.", "error");
      navigate(`#/t/${encodeURIComponent(slug)}/plan`);
      return;
    }
    renderChrome({ name: "knowledge", slug });
    let settings;
    let overview = { records: [], digests: [] };
    try {
      settings = await api.knowledgeSettings(slug);
      if (settings?.available === false) {
        toast("Team Knowledge is not available on this server yet.");
        navigate(`#/t/${encodeURIComponent(slug)}`);
        return;
      }
      if (settings?.planRequired) {
        toast("Team Knowledge is on the Teams plan. Open Plan to upgrade.", "error");
        navigate(`#/t/${encodeURIComponent(slug)}/plan`);
        return;
      }
    } catch (err) {
      fail(err);
      return;
    }
    if (settings.access !== "none") {
      try {
        overview = await api.knowledgeOverview(slug);
      } catch {
        overview = { records: [], digests: [] };
      }
    }
    app.innerHTML = knowledgeView({
      team: info.team,
      settings,
      overview,
      role: info.role,
      searchHits,
    });
    icons();
    bindKnowledge(app, {
      api,
      teamKey: slug,
      reload: () => viewKnowledge(slug),
      toast: (m) => toast(m),
      onSearch: (hits) => viewKnowledge(slug, hits),
      onClearSearch: () => viewKnowledge(slug),
    });
  } catch (err) {
    fail(err);
  }
}

async function viewLeaderboard(slug) {
  resetApp();
  try {
    const info = await api.getTeam(slug);
    applyTeamInfo(info);
    if (info.role === "employee") {
      toast("Leaderboard is for owners and managers.", "error");
      navigate(`#/t/${encodeURIComponent(slug)}`);
      return;
    }
    if (!paidFeaturesUnlocked()) {
      toast("Leaderboard is on the Teams plan. Open Plan to upgrade.", "error");
      navigate(info.role === "owner" ? `#/t/${encodeURIComponent(slug)}/plan` : `#/t/${encodeURIComponent(slug)}`);
      return;
    }

    // Owners: auto-sync at most once if never synced (don't retry-loop on every visit).
    if (info.role === "owner") {
      try {
        const { settings } = await api.leaderboardSettings(slug);
        if (settings?.planRequired) {
          toast("Leaderboard is on the Teams plan. Open Plan to upgrade.", "error");
          navigate(`#/t/${encodeURIComponent(slug)}/plan`);
          return;
        }
        const key = `lb-autosync:${slug}`;
        const already = sessionStorage.getItem(key);
        if (
          settings?.enabled &&
          settings?.installationConnected &&
          !settings?.lastSyncAt &&
          !already
        ) {
          sessionStorage.setItem(key, "1");
          toast("Syncing GitHub PRs…");
          await api.leaderboardSync(slug).catch((err) => {
            toast(err.message || "Sync failed", "error");
          });
        }
      } catch {
        /* optional */
      }
    }

    let weekMode = "current";
    let sortKey = "costPerPoint";
    let sortAsc = true;
    let cachedData = null;

    const paint = () => {
      if (!cachedData) return;
      state.leaderboardEnabled = Boolean(cachedData.enabled);
      renderChrome({ name: "leaderboard" });
      app.innerHTML = leaderboardView({
        team: info.team,
        role: info.role,
        data: cachedData,
        week: weekMode,
        hasGithub: Boolean(state.hasGithub),
        sortKey,
        sortAsc,
      });
      icons();
    };

    // Delegated once on this view's #app (resetApp discards listeners on leave).
    onClick(app, "data-lb-week", (w) => {
      weekMode = w;
      sortKey = "costPerPoint";
      sortAsc = true;
      draw().catch((err) => toast(err.message, "error"));
    });
    onClick(app, "data-act", (action) => {
      if (action === "link-github") {
        location.href = linkProviderUrl("github", `/#/t/${encodeURIComponent(slug)}/leaderboard`);
      }
    });
    onClick(app, "data-sort", (key) => {
      if (!key || !(key in LB_SORT_DEFAULTS)) return;
      if (key === sortKey) sortAsc = !sortAsc;
      else {
        sortKey = key;
        sortAsc = LB_SORT_DEFAULTS[key];
      }
      paint();
    });
    // Drill into token drivers for the ranked ISO week (same bounds as TOK/pt).
    onClick(app, "data-member", (userId) => {
      if (!userId || !cachedData) return;
      const range = weekUtcToCustomRange(cachedData.weekStart, cachedData.weekEnd);
      if (range) {
        persistRange(range);
        setLeaderboardDrill({
          slug,
          userId,
          week: cachedData.week,
          from: range.from,
          to: range.to,
        });
      }
      navigate(`#/t/${encodeURIComponent(slug)}/m/${encodeURIComponent(userId)}`);
    });
    app.addEventListener("keydown", (e) => {
      const th = e.target.closest?.("[data-sort]");
      if (!th || !app.contains(th)) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      const key = th.getAttribute("data-sort");
      if (!key || !(key in LB_SORT_DEFAULTS)) return;
      if (key === sortKey) sortAsc = !sortAsc;
      else {
        sortKey = key;
        sortAsc = LB_SORT_DEFAULTS[key];
      }
      paint();
    });

    const draw = async () => {
      let weekArg;
      if (weekMode === "prev") {
        const cur = await api.leaderboardWeek(slug);
        weekArg = prevIsoWeek(cur.week);
      }
      cachedData = await api.leaderboardWeek(slug, weekArg);
      paint();
    };
    await draw();
  } catch (err) {
    fail(err);
  }
}

/** Step ISO week string YYYY-Www back one week. */
function prevIsoWeek(weekId) {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekId);
  if (!m) return undefined;
  let year = Number(m[1]);
  let week = Number(m[2]) - 1;
  if (week < 1) {
    year -= 1;
    week = 52;
  }
  return `${year}-W${String(week).padStart(2, "0")}`;
}

window.addEventListener("hashchange", render);
window.addEventListener("popstate", render);

await loadSession();
await render();

// Local dev toolbar. `mountDevBar` returns immediately unless the Worker
// reports dev mode, so this costs one 404-ish fetch in production.
const { mountDevBar } = await import("./devbar.js");
await mountDevBar(async () => {
  await loadSession();
  // Land on the seeded team rather than wherever we happened to be.
  if (state.teams.length && location.hash.replace(/^#/, "").replace(/\/$/, "") === "") {
    location.hash = `/t/${encodeURIComponent(state.teams[0].slug)}`;
  }
  await render();
});
