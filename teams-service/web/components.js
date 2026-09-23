/* Shared view pieces, ported from the design's component inventory.
   Nine primitives carry every screen; everything else is layout. */

import { esc, fmtDate, html, initials, raw, since, syncPill } from "./dom.js";
import { fmt, providerColor } from "./charts.js";
import { prettyMixLabel } from "./labels.js";

export const RANGES = [
  { key: "7d", label: "7 days" },
  { key: "14d", label: "14 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
];

/**
 * The design puts the unit in a de-emphasised <small> — "75.5M" is rendered as
 * 75.5 + M, "$412.80" as $412 + .80. Splitting here keeps that treatment
 * consistent across every stat card.
 */
export function tokenParts(n) {
  const s = fmt.tok(n);
  const m = /^([\d.,]+)([A-Za-z]*)$/.exec(s);
  return m ? { value: m[1], unit: m[2] } : { value: s, unit: "" };
}

export function moneyParts(n) {
  const s = n.toFixed(2);
  const dot = s.indexOf(".");
  const intPart = Number(s.slice(0, dot)).toLocaleString("en-US");
  return { value: "$" + intPart, unit: s.slice(dot) };
}

/**
 * Range control. `active` is a preset key ("30d") or "custom".
 * When custom, `from`/`to` (YYYY-MM-DD) seed the date inputs.
 */
export function rangeSeg(active, { from = "", to = "" } = {}) {
  const isCustom = active === "custom";
  return html`
    <div class="range-ctl">
      <div class="seg" role="group" aria-label="Date range">
        ${RANGES.map(
          (r) =>
            html`<button data-range="${r.key}" class="${!isCustom && r.key === active ? "on" : ""}">
              ${r.label}
            </button>`,
        )}
        <button data-range="custom" class="${isCustom ? "on" : ""}" title="Custom range">
          Custom
        </button>
      </div>
      <div class="range-custom"${isCustom ? "" : " hidden"}>
        <label class="sr-only" for="range-from">From</label>
        <input type="date" id="range-from" data-range-from class="input range-date" value="${from}" />
        <span class="range-sep">→</span>
        <label class="sr-only" for="range-to">To</label>
        <input type="date" id="range-to" data-range-to class="input range-date" value="${to}" />
        <button class="btn" data-range-apply type="button">Apply</button>
      </div>
    </div>
  `;
}

/**
 * Stat card. Icon badge + mono key, tabular value with unit in <small>,
 * optional sparkline, and at most ONE delta line — never two.
 */
export function statCard({ icon, label, value, unit, spark, delta, note, help }) {
  const deltaLine =
    delta === null || delta === undefined
      ? note
        ? html`<div class="d"><span>${note}</span></div>`
        : ""
      : html`
          <div class="d ${delta >= 0 ? "up" : "dn"}">
            <i data-lucide="trending-${delta >= 0 ? "up" : "down"}" style="width:12px;height:12px"></i>
            <b>${(delta >= 0 ? "+" : "") + Math.round(delta * 100)}%</b>
            <span class="stat-vs">vs prev</span>
          </div>
        `;
  return html`
    <div class="stat">
      <div class="stat-top">
        <span class="stat-ico" aria-hidden="true"><i data-lucide="${icon}"></i></span>
        <span class="k">${label}</span>
      </div>
      <div class="v">${value}${unit ? raw(`<small>${esc(unit)}</small>`) : ""}</div>
      ${spark ? raw(`<svg class="spark" data-spark="${esc(spark)}"></svg>`) : ""}
      ${raw(deltaLine)}
      ${help ? raw(html`<div class="d"><span>${help}</span></div>`) : ""}
    </div>
  `;
}

export function avatar(name, color, size, imageUrl) {
  const dim = size
    ? `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.35)}px`
    : "";
  if (imageUrl) {
    const style = dim ? `${dim};` : "";
    return html`<div class="av av-photo" style="${raw(style)}" aria-hidden="true">
      <img src="${esc(imageUrl)}" alt="" referrerpolicy="no-referrer" />
    </div>`;
  }
  const style = size
    ? `width:${size}px;height:${size}px;background:${esc(color)};font-size:${Math.round(size * 0.35)}px`
    : `background:${esc(color)}`;
  return html`<div class="av" style="${raw(style)}" aria-hidden="true">${initials(name)}</div>`;
}

export function roleBadge(role) {
  if (role === "owner") return html`<span class="role owner">owner</span>`;
  if (role === "manager") return html`<span class="role manager">manager</span>`;
  return html`<span class="role">employee</span>`;
}

/** Status always pairs a colour with a dot AND a word — never colour alone. */
export function syncPillHtml(lastUploadAt) {
  const p = syncPill(lastUploadAt);
  return html`<span class="pill ${p.cls}"
    ><span class="dot" style="${raw(p.dotStyle)}"></span>${p.label}</span
  >`;
}

/**
 * Member leaderboard. A member who joined but has never uploaded collapses
 * their metric cells into one honest sentence rather than a row of zeros.
 */
export function memberTable(members, { sortKey = "activeHours", clickable = true } = {}) {
  const withData = members.filter((m) => !m.neverSynced);
  const maxActive = Math.max(1, ...withData.map((m) => m.totals.activeHours));

  const cols = [
    ["member", "Member"],
    ["activeHours", "Active"],
    ["tokens", "Tokens"],
    ["cacheHitRate", "Cache hit"],
    ["sessions", "Session activity"],
    ["turns", "Turns"],
    ["peakConcurrent", "Peak conc."],
    ["lastSeen", "Last seen"],
  ];

  const head = cols
    .map(
      ([key, label]) =>
        html`<th data-sort="${key}" tabindex="0" class="${key === sortKey ? "sorted" : ""}">
          ${label}${key === sortKey ? raw(' <i data-lucide="chevron-down"></i>') : ""}
        </th>`,
    )
    .join("");

  const rows = members
    .map((m) => {
      const who = html`
        <td>
          <div class="who">
            ${raw(avatar(m.displayName, m.avatarColor, null, m.avatarUrl))}
            <div>
              <div class="nm" style="${m.neverSynced ? "color:var(--t3)" : ""}">${m.displayName}</div>
              <div class="hd">${m.handle ? "@" + m.handle : ""}</div>
            </div>
            ${raw(m.role === "employee" ? "" : roleBadge(m.role))}
          </div>
        </td>
      `;

      if (m.neverSynced) {
        return html`
          <tr data-member="">
            ${raw(who)}
            <td colspan="6" style="text-align:left;color:var(--t5)">
              <span class="mono" style="font-size:11px"
                >joined ${since(m.joinedAt) ?? "recently"} ago · waiting for first sync — no metrics
                yet</span
              >
            </td>
            <td>${raw(syncPillHtml(null))}</td>
          </tr>
        `;
      }

      const t = m.totals;
      const barWidth = Math.round((t.activeHours / maxActive) * 64);
      return html`
        <tr ${clickable ? raw(`data-member="${esc(m.userId)}"`) : ""}>
          ${raw(who)}
          <td>
            <div class="bar">
              <i style="width:${barWidth}px"></i><span class="n">${fmt.h(t.activeHours)}</span>
            </div>
          </td>
          <td class="n">${fmt.tok(t.tokens)}</td>
          <td class="dim">${fmt.pct(t.cacheHitRate)}</td>
          <td>${t.sessions.toLocaleString("en-US")}</td>
          <td class="dim">${t.turns.toLocaleString("en-US")}</td>
          <td>${t.peakConcurrent.toLocaleString("en-US")}</td>
          <td>${raw(syncPillHtml(m.lastUploadAt))}</td>
        </tr>
      `;
    })
    .join("");

  return html`
    <div class="tbl-scroll">
      <table class="tbl" id="memberTable">
        <thead>
          <tr>
            ${raw(head)}
          </tr>
        </thead>
        <tbody>
          ${raw(rows)}
        </tbody>
      </table>
    </div>
  `;
}

/** Horizontal tracks, sorted descending. Value is printed, so no tooltip. */
export function mixRows(slices, { mono = false, colorFn = providerColor } = {}) {
  if (!slices.length) {
    return html`<p class="hint" style="margin:0">No sessions in this range.</p>`;
  }
  return slices
    .map((s) => {
      const label = prettyMixLabel(s.key, { mono });
      const color = colorFn(s.key);
      return html`
        <div class="mixrow ${mono ? "mixrow-model" : ""}">
          <div class="t ${mono ? "mono" : ""}" title="${esc(s.key)} · ${fmt.pct(s.share)} tokens · ${s.activeMs > 0 ? fmt.h(s.activeMs / 3_600_000) : "—"}">
            ${mono
              ? ""
              : raw(
                  `<i data-lucide="circle" style="width:9px;height:9px;color:${esc(color)}"></i>`,
                )}${label}
          </div>
          <div class="track">
            <i
              style="width:${(s.share * 100).toFixed(1)}%;background:${raw(esc(color))};${mono
                ? "opacity:0.7"
                : ""}"
            ></i>
          </div>
          <div class="p">${fmt.pct(s.share)}</div>
          <div class="h">${s.activeMs > 0 ? fmt.h(s.activeMs / 3_600_000) : "—"}</div>
        </div>
      `;
    })
    .join("");
}

/**
 * Token composition (in / out / cache / reasoning) as a stacked bar + legend.
 * All fields already land in totals from metric_hourly.
 */
export function tokenBreakdown(t) {
  const parts = [
    { key: "Input", n: t.tokensIn, color: "var(--accent)" },
    { key: "Output", n: t.tokensOut, color: "var(--green)" },
    { key: "Cache read", n: t.tokensCacheRead, color: "var(--violet)" },
    { key: "Cache write", n: t.tokensCacheWrite, color: "var(--cyan)" },
    { key: "Reasoning", n: t.tokensReasoning, color: "var(--amber)" },
  ].filter((p) => p.n > 0);
  const total = parts.reduce((a, p) => a + p.n, 0);
  if (!total) {
    return html`<p class="hint" style="margin:0">No token breakdown in this range.</p>`;
  }
  const segs = parts
    .map(
      (p) =>
        `<i style="width:${((p.n / total) * 100).toFixed(2)}%;background:${p.color}" title="${esc(
          p.key,
        )}: ${fmt.tok(p.n)}"></i>`,
    )
    .join("");
  const legend = parts
    .map(
      (p) => html`
        <div class="tb-row">
          <span class="tb-k"
            ><i style="background:${raw(p.color)}"></i>${p.key}</span
          >
          <span class="tb-v mono">${fmt.tok(p.n)}</span>
          <span class="tb-p">${fmt.pct(p.n / total)}</span>
        </div>
      `,
    )
    .join("");
  return html`
    <div class="tb">
      <div class="tb-bar">${raw(segs)}</div>
      <div class="tb-legend">${raw(legend)}</div>
      <div class="tb-foot">
        <span>Cache hit rate</span>
        <b class="mono">${fmt.pct(t.cacheHitRate)}</b>
      </div>
    </div>
  `;
}

/**
 * Derived manager metrics from totals we already capture — no new signals.
 * Returns empty string when there isn't enough activity to be meaningful.
 */
export function efficiencyGrid(t) {
  if (!t.sessions && !t.turns) {
    return html`<p class="hint" style="margin:0">Not enough activity to derive rates yet.</p>`;
  }
  const rows = [
    {
      k: "Turns / active session-hour",
      v: t.sessions > 0 ? (t.turns / t.sessions).toFixed(1) : "—",
    },
    {
      k: "Tool calls / turn",
      v: t.turns > 0 ? (t.toolCalls / t.turns).toFixed(1) : "—",
    },
    {
      k: "Tokens / active session-hour",
      v: t.sessions > 0 ? fmt.tok(t.tokens / t.sessions) : "—",
    },
    {
      k: "Est. $ / active hour",
      v: t.activeHours > 0 ? fmt.money(t.costUsd / t.activeHours) : "—",
    },
    {
      k: "After-hours share",
      v: fmt.pct(t.afterHoursShare),
    },
    {
      k: "Weekend share",
      v: fmt.pct(t.weekendShare),
    },
  ];
  // Pass the array of html`` fragments (not a joined string) so the outer
  // html`` template does not re-escape the markup as text.
  return html`
    <div class="eff">
      ${rows.map(
        (r) => html`
          <div class="eff-cell">
            <div class="eff-k">${r.k}</div>
            <div class="eff-v mono">${r.v}</div>
          </div>
        `,
      )}
    </div>
  `;
}

/** Fixed order and colour per tool kind, matching `TOOL_KINDS` on the server. */
const TOOL_KINDS = [
  { key: "bash", label: "Terminal", color: "var(--amber)", icon: "terminal" },
  { key: "edit", label: "Edits", color: "var(--green)", icon: "file-pen" },
  { key: "read", label: "Reads", color: "var(--accent)", icon: "book-open" },
  { key: "search", label: "Search", color: "var(--violet)", icon: "search" },
  { key: "web", label: "Web", color: "var(--cyan)", icon: "globe" },
  { key: "agent", label: "Subagents", color: "var(--pink)", icon: "users" },
  { key: "mcp", label: "MCP", color: "var(--teal)", icon: "plug" },
  { key: "other", label: "Other", color: "var(--muted)", icon: "circle" },
];

/**
 * What the agents actually did: terminal vs. edits vs. reading.
 *
 * A single "tool calls" number can't distinguish exploring a codebase from
 * writing to it, which is the distinction a manager is usually after.
 */
/**
 * True when a range has tool calls but no breakdown — i.e. buckets uploaded
 * before the per-kind columns existed, which default to 0.
 *
 * Without this the panel claims "no tool activity" directly under a header
 * reading "3,307 tool calls". Genuinely read-only work still records
 * `tool_read`, so an all-zero mix beside a non-zero total only ever means the
 * data predates the breakdown.
 */
export function isPreBreakdown(t) {
  if (!(t.toolCalls > 0)) return false;
  const mix = t.toolMix || {};
  return TOOL_KINDS.every((k) => !(mix[k.key] > 0));
}

export function toolMixPanel(t) {
  const mix = t.toolMix || {};
  const parts = TOOL_KINDS.map((k) => ({ ...k, n: mix[k.key] || 0 })).filter((p) => p.n > 0);
  const total = parts.reduce((a, p) => a + p.n, 0);
  if (!total) {
    return isPreBreakdown(t)
      ? html`<p class="hint" style="margin:0">
          These ${t.toolCalls.toLocaleString()} tool calls were recorded before the
          breakdown existed, so their kinds aren't known. New activity will fill
          this in.
        </p>`
      : html`<p class="hint" style="margin:0">No tool activity in this range.</p>`;
  }
  const segs = parts
    .map(
      (p) =>
        `<i style="width:${((p.n / total) * 100).toFixed(2)}%;background:${p.color}" title="${esc(
          p.label,
        )}: ${p.n.toLocaleString()}"></i>`,
    )
    .join("");
  const legend = parts
    .map(
      (p) => html`
        <div class="tb-row">
          <span class="tb-k"><i style="background:${raw(p.color)}"></i>${p.label}</span>
          <span class="tb-v mono">${p.n.toLocaleString()}</span>
          <span class="tb-p">${fmt.pct(p.n / total)}</span>
        </div>
      `,
    )
    .join("");
  return html`
    <div class="tb">
      <div class="tb-bar">${raw(segs)}</div>
      <div class="tb-legend">${raw(legend)}</div>
    </div>
  `;
}

/**
 * Output and reliability.
 *
 * The error rate divides by *measured* calls, not all of them: Codex reports no
 * outcome for most tool calls, so counting them as successes would invent a
 * reassuring number. When nothing was measurable the row says so rather than
 * showing 0%.
 */
export function outputPanel(t) {
  const measured = t.toolsMeasured || 0;
  const rate = t.toolErrorRate;

  // A grid of zeros here would assert "nothing was edited" when the truth is
  // "this data predates the counters" — the honest-state rule again.
  if (isPreBreakdown(t)) {
    return html`<p class="hint" style="margin:0">
      Not recorded for this range. These buckets were uploaded before output and
      failure counters existed; they'll appear as new activity syncs.
    </p>`;
  }
  const errText =
    rate == null
      ? "not reported"
      : `${fmt.pct(rate)} of ${measured.toLocaleString()}`;

  const rows = [
    { k: "Files changed", v: (t.filesChanged || 0).toLocaleString() },
    { k: "Lines added", v: `+${(t.linesAdded || 0).toLocaleString()}` },
    { k: "Lines removed", v: `−${(t.linesRemoved || 0).toLocaleString()}` },
    {
      k: "Net lines",
      v: ((t.linesAdded || 0) - (t.linesRemoved || 0)).toLocaleString(),
    },
    { k: "Failed tool calls", v: (t.toolErrors || 0).toLocaleString() },
    { k: "Failure rate", v: errText },
  ];
  return html`
    <div class="eff">
      ${rows.map(
        (r) => html`
          <div class="eff-cell">
            <div class="eff-k">${r.k}</div>
            <div class="eff-v mono">${r.v}</div>
          </div>
        `,
      )}
    </div>
    ${rate == null
      ? raw(html`<p class="hint" style="margin:8px 0 0">
          Only Claude and Grok report per-call outcomes. Codex activity is
          counted, but its success or failure isn't in the logs.
        </p>`)
      : ""}
  `;
}

/**
 * Monthly spend against budget, with a straight-line month-end projection.
 *
 * Renders nothing at all when no budget is set — a $0 budget would show every
 * team as instantly over.
 */
export function budgetCard(budget, { canManage = false } = {}) {
  if (!budget) {
    return canManage
      ? html`
          <div class="pnl-b">
            <p class="hint" style="margin:0 0 8px">
              No monthly budget set. Add one to see a month-end projection and
              get an alert before you go over.
            </p>
            <button class="btn" data-act="edit-budget">Set a budget</button>
          </div>
        `
      : "";
  }

  const pct = Math.min(100, Math.round(budget.usedShare * 100));
  const over = budget.usedShare >= 1;
  const warn = budget.onTrackToExceed;
  const partial = budget.costIncomplete !== false;
  const barColor = over ? "var(--red)" : warn || partial ? "var(--amber)" : "var(--green)";
  const projPct = Math.min(100, Math.round(budget.projectedShare * 100));

  return html`
    <div class="pnl-b">
      <div class="budget-head">
        <div>
          <div class="sub">${partial ? "Partial estimate" : "Estimated cost"}</div>
          <div class="budget-spend mono">${fmt.money(budget.spendUsd)}</div>
          <div class="sub" style="margin-top:4px">of ${fmt.money(budget.monthlyUsd)} this month</div>
        </div>
        <div class="budget-pct mono" style="color:${raw(barColor)}">${pct}%</div>
      </div>
      <div class="budget-track">
        <i style="width:${pct}%;background:${raw(barColor)}"></i>
        ${budget.projectedShare > budget.usedShare
          ? raw(
              `<b class="budget-proj" style="left:${Math.min(99, projPct)}%" title="Projected month end"></b>`,
            )
          : ""}
      </div>
      <div class="budget-foot">
        <span>Day ${budget.daysElapsed} of ${budget.daysInMonth}</span>
        <span class="mono"
          >Projected ${partial ? "(partial estimate) " : ""}${fmt.money(budget.projectedUsd)}</span
        >
      </div>
      <div class="sub">Missing prices or usage details are excluded; not an invoice.</div>
      ${warn
        ? raw(
            `<div class="banner warn" style="margin-top:10px"><i data-lucide="trending-up"></i><div>Based on recorded estimates, this team is projected to finish the month at <b>${esc(
              fmt.money(budget.projectedUsd),
            )}</b> — over the ${esc(fmt.money(budget.monthlyUsd))} budget.</div></div>`,
          )
        : ""}
      ${canManage
        ? raw(html`<button class="btn ghost" data-act="edit-budget" style="margin-top:12px">
            Edit budget
          </button>`)
        : ""}
    </div>
  `;
}

/** Human labels for every audit action. Unknown keys fall back gracefully. */
const AUDIT_LABELS = {
  "team.created": ["plus-circle", "created the team"],
  "team.renamed": ["pencil", "renamed the team"],
  "team.deleted": ["trash-2", "deleted the team"],
  "member.joined": ["user-plus", "joined"],
  "member.role_changed": ["shield", "changed a role"],
  "member.removed": ["user-minus", "removed a member"],
  "member.left": ["log-out", "left the team"],
  "invite.created": ["link", "created an invite"],
  "invite.revoked": ["link-2-off", "revoked an invite"],
  "budget.updated": ["wallet", "updated the budget"],
  "budget.cleared": ["wallet", "cleared the budget"],
  "policy.updated": ["sliders-horizontal", "updated org policy"],
  "data.exported": ["download", "exported data"],
  "group.created": ["users", "created group"],
  "group.renamed": ["pencil", "renamed group"],
  "group.deleted": ["trash-2", "deleted group"],
  "group.members_set": ["users", "updated members in"],
  "scope.updated": ["scan", "updated manager scope"],
  "leaderboard.enabled": ["trophy", "enabled the leaderboard"],
  "leaderboard.disabled": ["trophy", "disabled the leaderboard"],
  "leaderboard.settings_updated": ["settings-2", "updated leaderboard settings"],
  "leaderboard.installed": ["github", "installed the leaderboard app"],
  "leaderboard.unlinked": ["unlink", "unlinked the leaderboard"],
  "leaderboard.repos_set": ["git-branch", "updated leaderboard repos"],
  "billing.checkout_started": ["credit-card", "started checkout"],
  "billing.quantity_sync": ["refresh-cw", "synced seat quantity"],
  "billing.seats_increased": ["arrow-up-right", "increased seats"],
  "billing.seats_decrease_scheduled": ["arrow-down-right", "scheduled a seat decrease"],
  "knowledge.settings": ["book-open", "updated knowledge settings"],
  "knowledge.record_create": ["file-plus", "added a knowledge record"],
  "knowledge.record_purge": ["file-x", "purged a knowledge record"],
  "knowledge.share": ["share-2", "shared knowledge"],
};

/** Soften server-authored detail strings for display. */
function formatAuditDetail(action, detail) {
  if (!detail) return null;
  if (action === "billing.checkout_started") {
    if (detail === "month") return "Monthly plan";
    if (detail === "year") return "Yearly plan";
    return detail;
  }
  if (action === "data.exported") {
    // "day CSV, 7d, 69 rows" → "Day CSV · 7 days · 69 rows"
    return detail
      .replace(/^([a-z]+) CSV/i, (_, g) => g.charAt(0).toUpperCase() + g.slice(1) + " CSV")
      .replace(/\b(\d+)d\b/g, "$1 days")
      .replace(/,\s*/g, " · ");
  }
  if (action === "group.created" || action === "group.deleted") {
    // Name is the whole story — fold into the title, no second line.
    return null;
  }
  if (action === "group.members_set") {
    // "India: 4 members" stays readable; drop mono noise later.
    return detail;
  }
  return detail;
}

/** Subject noun for the title line (member name, group name, …). */
function auditSubject(e) {
  if (e.target_name) return e.target_name;
  if (
    (e.action === "group.created" ||
      e.action === "group.deleted" ||
      e.action === "group.renamed") &&
    e.detail
  ) {
    // group.renamed detail is "Old → New" — keep as detail, not subject.
    if (e.action === "group.renamed") return null;
    return e.detail;
  }
  return null;
}

/**
 * Collapse consecutive identical (actor, action, detail) rows so a burst of
 * the same event (e.g. five checkout attempts) reads as one line with a count.
 */
function collapseAuditEntries(entries) {
  const out = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.actor_user_id === e.actor_user_id &&
      prev.actor_name === e.actor_name &&
      prev.action === e.action &&
      prev.detail === e.detail &&
      prev.target === e.target
    ) {
      prev.count += 1;
      // Keep the newest timestamp (list is DESC).
      continue;
    }
    out.push({ ...e, count: 1 });
  }
  return out;
}

/** Membership, role, invite, budget, billing and export history. */
export function auditList(entries) {
  if (!entries?.length) {
    return html`<div class="pnl-b"><p class="hint" style="margin:0">Nothing recorded yet.</p></div>`;
  }
  const rows = collapseAuditEntries(entries);
  return html`
    <div class="audit">
      ${rows.map((e) => {
        const [icon, verb] = AUDIT_LABELS[e.action] || [
          "circle",
          e.action.replace(/[._]/g, " "),
        ];
        const who = e.actor_name || "Someone";
        const subject = auditSubject(e);
        const detail = formatAuditDetail(e.action, e.detail);
        const titleExtra = subject ? raw(html` <span class="audit-subj">${subject}</span>`) : "";
        const count =
          e.count > 1
            ? raw(html`<span class="audit-count" title="${e.count} times">×${e.count}</span>`)
            : "";
        return html`
          <div class="audit-row">
            <span class="audit-ico"><i data-lucide="${icon}"></i></span>
            <div class="audit-main">
              <div class="audit-t">
                <b>${who}</b> ${verb}${titleExtra}${count}
              </div>
              ${detail ? raw(html`<div class="audit-d">${detail}</div>`) : ""}
            </div>
            <div class="audit-when" title="${fmtDate(e.created_at)}">
              ${since(e.created_at)}
            </div>
          </div>
        `;
      })}
    </div>
  `;
}

/** Compact projects table used on both team and member pages. */
export function projectsTable(rows, { limit = 12 } = {}) {
  if (!rows?.length) {
    return html`<div class="pnl-b"><p class="hint" style="margin:0">No project activity in this range.</p></div>`;
  }
  const shown = rows.slice(0, limit);
  return html`
    <div class="tbl-scroll">
      <table class="tbl">
        <thead>
          <tr>
            <th>Project</th>
            <th>Active</th>
            <th>Tokens</th>
            <th>Session activity</th>
          </tr>
        </thead>
        <tbody>
          ${shown.map(
            (r) => html`
              <tr>
                <td><span class="mono">${r.projectKey}</span></td>
                <td class="n">${fmt.h(r.activeHours)}</td>
                <td>${fmt.tok(r.tokens)}</td>
                <td class="dim">${r.sessions}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
    ${rows.length > limit
      ? raw(
          `<div class="pnl-b" style="padding-top:0"><p class="hint" style="margin:0">+${
            rows.length - limit
          } more projects</p></div>`,
        )
      : ""}
  `;
}

/**
 * Flags are observations with a named cause, never verdicts. No score, no
 * "low performer" — the design is explicit about this.
 */
export function flagsPanel(flags, { rangeLabel = "30d" } = {}) {
  const items = [];

  const ah = flags.afterHoursShare;
  const ahPrev = flags.afterHoursSharePrev;
  if (ah > 0) {
    const dir = ahPrev > 0 ? (ah > ahPrev ? "up" : "down") : null;
    items.push(html`
      <div class="flag ${ah > 0.15 ? "warn" : ""}">
        <i data-lucide="moon"></i>
        <div>
          <b>After-hours ${fmt.pct(ah)}</b> of active time
          ${dir ? `— ${dir} from ${fmt.pct(ahPrev)} last period` : ""}
          <div class="m">Outside 08:00–18:00 in each member's own timezone (from their device).</div>
        </div>
      </div>
    `);
  }

  if (flags.weekendShare > 0) {
    items.push(html`
      <div class="flag">
        <i data-lucide="calendar"></i>
        <div>
          <b>Weekend ${fmt.pct(flags.weekendShare)}</b> of active time
          <div class="m">Saturday and Sunday in each member's own timezone.</div>
        </div>
      </div>
    `);
  }

  if (flags.idleDays > 0) {
    items.push(html`
      <div class="flag">
        <i data-lucide="circle-slash"></i>
        <div>
          <b>${flags.idleDays} idle ${flags.idleDays === 1 ? "day" : "days"}</b> in the last
          ${rangeLabel}
          <div class="m">Days with no agent activity uploaded.</div>
        </div>
      </div>
    `);
  }

  if (!items.length) {
    return html`<p class="hint" style="margin:0">
      Nothing worth flagging in this range — no after-hours concentration, no idle days.
    </p>`;
  }
  return items.join("");
}

export function emptyState({ icon, title, body, actions = "" }) {
  return html`
    <div class="empty">
      <div class="ic"><i data-lucide="${icon}"></i></div>
      <h3>${title}</h3>
      <p>${body}</p>
      ${actions ? raw(`<div style="display:flex;gap:9px">${actions}</div>`) : ""}
    </div>
  `;
}

/** Skeletons mirror the real layout's geometry so nothing shifts on load. */
export function skeletonDashboard(statCount = 5) {
  const stats = Array.from(
    { length: statCount },
    () =>
      '<div class="stat"><div class="sk" style="width:54px;height:8px"></div><div class="sk" style="width:78px;height:20px"></div><div class="sk" style="height:20px"></div></div>',
  ).join("");
  const rows = Array.from(
    { length: 6 },
    () =>
      '<div style="display:flex;gap:12px;align-items:center;padding:0 16px;height:var(--rowh);border-bottom:1px solid rgba(255,255,255,0.035)"><div class="sk" style="width:24px;height:24px;border-radius:9999px"></div><div class="sk" style="width:130px"></div><div style="flex:1"></div><div class="sk" style="width:60px"></div><div class="sk" style="width:60px"></div><div class="sk" style="width:44px"></div></div>',
  ).join("");
  return html`
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="stats" style="grid-template-columns:repeat(${statCount},1fr)">${raw(stats)}</div>
      <div class="g2">
        <div class="pnl" style="height:262px">
          <div class="pnl-h"><div class="sk" style="width:120px"></div></div>
          <div class="pnl-b"><div class="sk" style="height:186px"></div></div>
        </div>
        <div class="pnl" style="height:262px">
          <div class="pnl-h"><div class="sk" style="width:90px"></div></div>
          <div class="pnl-b">
            ${raw(
              Array.from({ length: 6 }, () => '<div class="sk" style="margin-bottom:12px"></div>').join(""),
            )}
          </div>
        </div>
      </div>
      <div class="pnl">
        <div class="pnl-h"><div class="sk" style="width:110px"></div></div>
        ${raw(rows)}
      </div>
    </div>
  `;
}

export function inviteCard(invite, { canManage }) {
  if (!invite) {
    return html`
      <div class="pnl-b" style="display:flex;flex-direction:column;gap:11px">
        <p class="hint" style="margin:0">No invite link yet.</p>
        ${canManage
          ? raw(
              '<button class="btn primary" data-act="invite-create" style="align-self:flex-start"><i data-lucide="plus"></i>Create invite link</button>',
            )
          : ""}
      </div>
    `;
  }

  const dead = invite.state !== "active";
  const reason =
    invite.state === "expired"
      ? html`This link expired on <b style="color:var(--t2)">${fmtDate(invite.expiresAt)}</b>.`
      : invite.state === "revoked"
        ? html`This link was revoked.`
        : html`This link has been used up.`;

  if (dead) {
    // Revoked/expired links stay on screen struck through so the state is legible.
    return html`
      <div class="pnl-b" style="display:flex;flex-direction:column;gap:11px">
        <div class="link dead"><i data-lucide="link-2-off"></i><span>${invite.url ?? "teams.agmux.dev/join/…"}</span></div>
        <p class="hint">
          ${raw(reason)} People opening it now see “Invite expired — ask your owner for a new link.”
        </p>
        ${canManage
          ? raw(
              '<button class="btn primary" data-act="invite-create" style="align-self:flex-start"><i data-lucide="plus"></i>Create new link</button>',
            )
          : ""}
      </div>
    `;
  }

  // Active invites return a full url from the API. Legacy rows (created before
  // token persistence) may still be masked — regenerate once to re-copy.
  const linkText = invite.url ?? "teams.agmux.dev/join/•••••••• (regenerate to copy)";
  return html`
    <div class="pnl-b" style="display:flex;flex-direction:column;gap:11px">
      <div class="link">
        <i data-lucide="link"></i><span id="inviteUrl">${linkText}</span>
        ${invite.url
          ? raw(
              `<button class="btn" data-act="invite-copy" data-url="${esc(invite.url)}"><i data-lucide="copy"></i>Copy</button>`,
            )
          : ""}
      </div>
      <p class="hint">
        Expires <b style="color:var(--t2)">${fmtDate(invite.expiresAt)}</b>
        ${invite.usesLeft === null ? "· unlimited uses" : `· ${invite.usesLeft} uses left`}
        ${invite.creatorName ? `· created by ${invite.creatorName}` : ""}. Anyone with the link can
        join as an employee after accepting the disclosure.
      </p>
      ${canManage
        ? raw(`<div style="display:flex;gap:8px">
              <button class="btn" data-act="invite-create"><i data-lucide="rotate-cw"></i>Regenerate</button>
              <button class="btn danger" data-act="invite-revoke"><i data-lucide="x"></i>Revoke</button>
            </div>`)
        : ""}
    </div>
  `;
}
