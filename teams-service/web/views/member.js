/* 5 · Member detail   —   6 · Employee self-view (same shape, self scope). */

import { agoLabel, esc, html, raw } from "../dom.js";
import { fmt } from "../charts.js";
import {
  avatar,
  efficiencyGrid,
  emptyState,
  mixRows,
  moneyParts,
  outputPanel,
  projectsTable,
  rangeSeg,
  roleBadge,
  statCard,
  tokenBreakdown,
  tokenParts,
  toolMixPanel,
} from "../components.js";
import { disclosureBlock } from "../disclosure.js";

export function memberDetail({ team, data, isSelf, fromLeaderboard = null }) {
  const m = data.member;
  const t = data.totals;
  const stale = m.last_upload_at && Date.now() - Date.parse(m.last_upload_at) > 86400_000;
  const lb = fromLeaderboard?.week
    ? {
        week: fromLeaderboard.week,
        href: `#/t/${encodeURIComponent(team.slug)}/leaderboard`,
      }
    : null;

  const head = html`
    ${isSelf
      ? ""
      : raw(`<div class="crumb">
            ${
              lb
                ? `<a href="${lb.href}">Leaderboard</a>
            <i data-lucide="chevron-right" style="width:13px;height:13px"></i>`
                : `<a href="#/t/${encodeURIComponent(team.slug)}">${esc(team.name)}</a>
            <i data-lucide="chevron-right" style="width:13px;height:13px"></i>`
            }
            <span>${esc(m.display_name)}</span>
          </div>`)}
    <div class="phead">
      <div style="display:flex;gap:12px;align-items:center">
        ${raw(avatar(m.display_name, m.avatar_color, 40, m.avatar_url))}
        <div>
          <h1>${isSelf ? "Your metrics" : m.display_name}</h1>
          <div class="meta">
            <span class="mono">${m.handle ? "@" + m.handle : ""}</span>
            ${raw(roleBadge(m.role))}
            ${m.last_upload_at
              ? raw(`<span>last upload ${agoLabel(m.last_upload_at)}</span>`)
              : ""}
            ${m.timezone
              ? raw(`<span title="After-hours &amp; weekend judged in this zone"><span class="mono">${m.timezone}</span></span>`)
              : ""}
            ${raw(
              m.last_upload_at
                ? stale
                  ? '<span class="pill warn"><span class="dot"></span>stale</span>'
                  : '<span class="pill ok"><span class="dot"></span>live</span>'
                : '<span class="pill"><span class="dot" style="background:var(--t5)"></span>never</span>',
            )}
          </div>
        </div>
      </div>
      <div class="sp"></div>
      ${raw(rangeSeg(data.range, { from: data.from, to: data.to }))}
      ${isSelf ? raw('<a class="btn" href="#/privacy"><i data-lucide="eye"></i>What managers see</a>') : ""}
    </div>
  `;

  if (data.neverSynced) {
    return html`
      <section class="page">
        ${raw(head)}
        <div class="pnl">
          ${raw(
            emptyState({
              icon: "cloud-off",
              title: isSelf ? "Nothing uploaded yet" : "Never synced",
              body: isSelf
                ? "Open agmux and run a session — your first upload usually lands within a few minutes."
                : "This member accepted the disclosure but their desktop app hasn't uploaded yet. Ask them to open agmux and sign in under Settings → Teams.",
            }),
          )}
        </div>
        ${isSelf ? raw(selfDisclosurePanel()) : ""}
      </section>
    `;
  }

  const medianDay = medianOf(data.daily.filter((d) => d.hasData).map((d) => d.activeHours));
  const costPerHour = t.activeHours > 0 ? t.costUsd / t.activeHours : null;

  return html`
    <section class="page">
      ${raw(head)}
      ${lb
        ? raw(`<div class="banner"><i data-lucide="gauge"></i><div>
            <b>Leaderboard week ${esc(lb.week)}.</b>
            Range matches the board’s TOK/pt and $/pt window. Use
            <b>provider &amp; model mix</b> and <b>token composition</b> below to see why tokens
            (or cost) are high relative to PR points.
            <a href="${lb.href}" style="margin-left:6px">Back to leaderboard →</a>
          </div></div>`)
        : ""}
      ${stale
        ? raw(`<div class="banner warn"><i data-lucide="clock"></i><div><b>Partial data.</b> Last successful upload was ${agoLabel(
            m.last_upload_at,
          )}, so the most recent days are incomplete.${
            isSelf ? " Your manager sees the same staleness." : ""
          }</div></div>`)
        : ""}

      <div class="stats" style="grid-template-columns:repeat(5,1fr)">
        ${raw(
          statCard({
            icon: "timer",
            label: "Active hours",
            value: t.activeHours.toFixed(1),
            unit: "h",
            spark: "hrs",
            note: `${medianDay.toFixed(1)}h median day`,
          }),
        )}
        ${raw(
          statCard({
            icon: "coins",
            label: "Reported tokens",
            help: "Measured usage from verified agmux-created sessions. Unverified history and unavailable provider reports are excluded.",
            ...tokenParts(t.tokens),
            spark: "tok",
            delta: data.deltas?.tokens,
            note: `${fmt.pct(t.cacheHitRate)} cache hit`,
          }),
        )}
        ${raw(
          statCard({
            icon: "receipt",
            label: t.costIncomplete === false ? "Est. cost" : "Partial est. cost",
            help: "Missing prices or usage details are excluded; not an invoice.",
            ...moneyParts(t.costUsd),
            spark: "cost",
            note: costPerHour != null ? `${fmt.money(costPerHour)}/active hour` : "from model pricing",
          }),
        )}
        ${raw(
          statCard({
            icon: "message-square",
            label: "Session activity",
            help: "Each session counts once per hour with recorded activity. This is not a count of distinct conversations.",
            value: String(t.sessions),
            spark: "ses",
            note: `${t.turns.toLocaleString()} turns · ${t.toolCalls.toLocaleString()} tool calls`,
          }),
        )}
        ${raw(
          statCard({
            icon: "layers",
            label: "Peak concurrent",
            value: String(t.peakConcurrent),
            spark: "con",
            note: "highest simultaneous sessions",
          }),
        )}
      </div>

      <!-- The two wide charts take the full width; everything else flows.
           Pairing a short chart with a tall list in a 2-column grid was what
           left the big holes — a grid row is as tall as its tallest cell. -->
      <div class="pnl">
        <div class="pnl-h">
          <h3>Daily trends</h3>
          <div class="sp"></div>
          <div class="legend">
            <span><i style="background:var(--accent);opacity:0.55"></i>Tokens</span>
            <span><i style="background:var(--amber)"></i>Active hours</span>
          </div>
        </div>
        <div class="pnl-b"><div data-chart="daily"></div></div>
      </div>

      <!-- Masonry, not a grid: these are card-like and vary a lot in height,
           so fixed rows left holes under the short ones. -->
      <div class="flow">
        <div class="pnl">
          <div class="pnl-h">
            <h3>Provider &amp; model mix</h3>
            <div class="sp"></div>
            <span class="sub">tokens · time</span>
          </div>
          <div class="pnl-b mix">
            ${raw(mixRows(data.providerMix))}
            ${data.modelMix?.length
              ? raw(
                  `<hr class="hr" style="margin:4px 0"><div class="eyeb">Top models</div>${mixRows(
                    data.modelMix.slice(0, 6),
                    { mono: true },
                  )}`,
                )
              : ""}
          </div>
        </div>
        <div class="pnl">
          <div class="pnl-h">
            <h3>What the agents did</h3>
            <div class="sp"></div>
            <span class="sub">${t.toolCalls.toLocaleString()} tool calls</span>
          </div>
          <div class="pnl-b">${raw(toolMixPanel(t))}</div>
        </div>
        <div class="pnl">
          <div class="pnl-h">
            <h3>Output &amp; reliability</h3>
            <div class="sp"></div>
            <span class="sub">code written, calls failed</span>
          </div>
          <div class="pnl-b">${raw(outputPanel(t))}</div>
        </div>
        <div class="pnl">
          <div class="pnl-h">
            <h3>Token composition</h3>
            <div class="sp"></div>
            <span class="sub">${fmt.tok(t.tokens)} total</span>
          </div>
          <div class="pnl-b">${raw(tokenBreakdown(t))}</div>
        </div>
        <div class="pnl">
          <div class="pnl-h">
            <h3>Work rates</h3>
            <div class="sp"></div>
            <span class="sub">derived from this range</span>
          </div>
          <div class="pnl-b">${raw(efficiencyGrid(t))}</div>
        </div>
        <div class="pnl">
          <div class="pnl-h">
            <h3>Work patterns</h3>
            <div class="sp"></div>
            <span class="sub">${m.timezone ? m.timezone : "member local time"}</span>
          </div>
          <div class="pnl-b">
            <div class="kv" style="grid-template-columns:1fr auto;font-size:12px">
              <dt>After-hours share</dt>
              <dd>${fmt.pct(t.afterHoursShare)}</dd>
              <dt>Weekend share</dt>
              <dd>${fmt.pct(t.weekendShare)}</dd>
              <dt>Idle days</dt>
              <dd>${data.flags.idleDays}</dd>
              <dt>Days with activity</dt>
              <dd>${t.daysWithData}</dd>
              ${t.tokensReasoning > 0
                ? raw(`<dt>Reasoning tokens</dt><dd>${fmt.tok(t.tokensReasoning)}</dd>`)
                : ""}
            </div>
          </div>
        </div>
        <div class="pnl">
          <div class="pnl-h">
            <h3>Projects</h3>
            <div class="sp"></div>
            <span class="sub">basename or hash only</span>
          </div>
          ${raw(projectsTable(data.projects, { limit: 10 }))}
        </div>
      </div>

      <div class="pnl">
        <div class="pnl-h"><h3>Hour of day</h3><span class="sub">${m.timezone ? m.timezone : "member local time"}</span></div>
        <div class="pnl-b"><div data-chart="heat"></div></div>
      </div>

      ${isSelf ? raw(selfDisclosurePanel()) : ""}
    </section>
  `;
}

function selfDisclosurePanel() {
  return html`
    <div class="pnl">
      <div class="pnl-h">
        <h3>What managers can see</h3>
        <div class="sp"></div>
        <a href="#/privacy" style="font-size:12px">Full disclosure →</a>
      </div>
      <div class="pnl-b">
        ${raw(
          disclosureBlock({
            sharedTitle: "Shared with owner & managers",
            neverTitle: "Never collected or shown",
          }),
        )}
      </div>
    </div>
  `;
}

function medianOf(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
