/* Members directory — roster with usage metrics (not the leaderboard). */

import { agoLabel, esc, html, raw } from "../dom.js";
import { fmt } from "../charts.js";
import { avatar, emptyState, rangeSeg, roleBadge, syncPillHtml } from "../components.js";

const SORTS = [
  { key: "activeHours", label: "Active hours" },
  { key: "tokens", label: "Tokens" },
  { key: "sessions", label: "Sessions" },
  { key: "name", label: "Name" },
  { key: "lastSeen", label: "Last sync" },
];

/**
 * @param {{ team, role, members, range, from?, to?, sortKey?, memberCount?, scopeLabel? }} opts
 */
export function membersDirectory({
  team,
  role,
  members,
  range,
  from = "",
  to = "",
  sortKey = "activeHours",
  memberCount = null,
  scopeLabel = null,
}) {
  const isOwner = role === "owner";
  const count = memberCount ?? members.length;
  const synced = members.filter((m) => !m.neverSynced).length;
  const pending = members.length - synced;
  const maxActive = Math.max(
    1,
    ...members.filter((m) => !m.neverSynced).map((m) => m.totals?.activeHours ?? 0),
  );

  const sortSeg = SORTS.map(
    (s) =>
      `<button type="button" data-mem-sort="${esc(s.key)}" class="${sortKey === s.key ? "on" : ""}">${esc(s.label)}</button>`,
  ).join("");

  const rows = members.map((m) => memberRow(m, { maxActive, teamSlug: team.slug })).join("");

  return html`
    <section class="page members-page">
      <div class="phead mem-phead">
        <div>
          <p class="eyeb">Team</p>
          <h1>Members</h1>
          <div class="meta">
            <span>${esc(team.name)}</span>
            <span class="meta-sep">·</span>
            <span>${count} ${count === 1 ? "person" : "people"}</span>
            ${
              scopeLabel
                ? raw(
                    `<span class="meta-sep">·</span><span class="pill"><i data-lucide="users"></i>${esc(scopeLabel)}</span>`,
                  )
                : ""
            }
            ${
              pending > 0
                ? raw(
                    `<span class="meta-sep">·</span><span class="pill warn">${pending} awaiting sync</span>`,
                  )
                : ""
            }
          </div>
        </div>
        <div class="sp"></div>
        <div class="ov-toolbar">
          ${raw(rangeSeg(range, { from, to }))}
          ${
            isOwner
              ? raw(
                  `<div class="ov-actions"><a class="btn primary" href="#/t/${encodeURIComponent(team.slug)}/settings"><i data-lucide="user-plus"></i>Invite &amp; roles</a></div>`,
                )
              : ""
          }
        </div>
      </div>

      <div class="mem-summary">
        <dl class="set-kpis mem-kpis">
          <div>
            <dt>On roster</dt>
            <dd>${members.length}</dd>
          </div>
          <div>
            <dt>Synced</dt>
            <dd>${synced}</dd>
          </div>
          <div>
            <dt>Awaiting</dt>
            <dd>${pending}</dd>
          </div>
        </dl>
        <div class="mem-sort" role="group" aria-label="Sort members">
          <span class="mem-sort-lbl">Sort</span>
          <div class="seg">${raw(sortSeg)}</div>
        </div>
      </div>

      ${
        members.length === 0
          ? raw(
              `<div class="pnl mem-panel">${emptyState({
                icon: "users",
                title: "No members yet",
                body: isOwner
                  ? "Create an invite link in Settings so people can join."
                  : "No one is in your scope yet.",
                actions: isOwner
                  ? `<a class="btn primary" href="#/t/${encodeURIComponent(team.slug)}/settings"><i data-lucide="link"></i>Open settings</a>`
                  : "",
              })}</div>`,
            )
          : raw(`<div class="mem-list" role="list">${rows}</div>`)
      }
    </section>
  `;
}

function memberRow(m, { maxActive, teamSlug }) {
  const never = Boolean(m.neverSynced);
  const t = m.totals || {};
  const active = t.activeHours ?? 0;
  const barPct = never ? 0 : Math.round((active / maxActive) * 100);
  const last = m.lastUploadAt ? agoLabel(m.lastUploadAt) : null;
  const href = m.userId
    ? `#/t/${encodeURIComponent(teamSlug)}/m/${encodeURIComponent(m.userId)}`
    : null;

  const who = `
    <div class="mem-who">
      ${avatar(m.displayName, m.avatarColor, 44, m.avatarUrl)}
      <div class="mem-who-text">
        <div class="mem-name-line">
          <span class="mem-name">${esc(m.displayName)}</span>
          ${m.role && m.role !== "employee" ? roleBadge(m.role) : ""}
        </div>
        <div class="mem-sub">
          ${m.handle ? `<span class="mono">@${esc(m.handle)}</span>` : ""}
          ${last ? `<span class="meta-sep">·</span><span>synced ${esc(last)}</span>` : ""}
        </div>
      </div>
    </div>`;

  const metrics = never
    ? `<div class="mem-pending">
         <span class="pill"><span class="dot" style="background:var(--t5)"></span>Never synced</span>
         <span class="hint">Joined ${esc(fmtJoined(m.joinedAt))} · waiting for first desktop upload</span>
       </div>`
    : `<div class="mem-metrics">
         <div class="mem-metric">
           <span class="mem-metric-k">Active</span>
           <span class="mem-metric-v">${fmt.h(active)}</span>
           <span class="mem-bar" aria-hidden="true"><i style="width:${barPct}%"></i></span>
         </div>
         <div class="mem-metric">
           <span class="mem-metric-k">Tokens</span>
           <span class="mem-metric-v">${fmt.tok(t.tokens ?? 0)}</span>
         </div>
         <div class="mem-metric">
           <span class="mem-metric-k">Sessions</span>
           <span class="mem-metric-v">${(t.sessions ?? 0).toLocaleString("en-US")}</span>
         </div>
         <div class="mem-metric">
           <span class="mem-metric-k">Peak</span>
           <span class="mem-metric-v">${(t.peakConcurrent ?? 0).toLocaleString("en-US")}</span>
         </div>
         <div class="mem-metric">
           <span class="mem-metric-k">Cache hit</span>
           <span class="mem-metric-v dim">${fmt.pct(t.cacheHitRate ?? 0)}</span>
         </div>
       </div>`;

  const side = `
    <div class="mem-side">
      ${syncPillHtml(m.lastUploadAt)}
      ${href ? `<i data-lucide="chevron-right" class="mem-chev"></i>` : ""}
    </div>`;

  const cls = `mem-row${never ? " is-pending" : ""}`;
  if (href) {
    return `<a class="${cls}" role="listitem" href="${esc(href)}" data-member="${esc(m.userId)}">${who}${metrics}${side}</a>`;
  }
  return `<div class="${cls}" role="listitem">${who}${metrics}${side}</div>`;
}

function fmtJoined(iso) {
  if (!iso) return "recently";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "recently";
  }
}

/** Sort members for the directory (never-synced sink to bottom). */
export function sortMembers(members, key = "activeHours", asc = false) {
  const ready = members.filter((m) => !m.neverSynced);
  const pending = members.filter((m) => m.neverSynced);
  const value = (m) => {
    if (key === "name") return (m.displayName || "").toLowerCase();
    if (key === "lastSeen") return m.lastUploadAt ? Date.parse(m.lastUploadAt) : -1;
    return m.totals?.[key] ?? -1;
  };
  if (key === "name") {
    ready.sort((a, b) => {
      const cmp = String(value(a)).localeCompare(String(value(b)));
      return asc ? cmp : -cmp;
    });
  } else {
    ready.sort((a, b) => (asc ? value(a) - value(b) : value(b) - value(a)));
  }
  return [...ready, ...pending];
}
