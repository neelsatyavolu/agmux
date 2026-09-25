/* 4 · Team home — the manager dashboard. */

import { agoLabel, esc, html, raw } from "../dom.js";
import { fmt } from "../charts.js";
import {
  budgetCard,
  efficiencyGrid,
  emptyState,
  flagsPanel,
  mixRows,
  moneyParts,
  outputPanel,
  projectsTable,
  rangeSeg,
  statCard,
  tokenBreakdown,
  tokenParts,
  toolMixPanel,
} from "../components.js";

export function teamHome({ team, data, role }) {
  const t = data.totals;
  const managers = data.members.filter((m) => m.role === "manager").length;
  const asOf = agoLabel(data.lastUploadAt);
  const staleCount = data.members.filter(
    (m) => !m.neverSynced && m.lastUploadAt && Date.now() - Date.parse(m.lastUploadAt) > 86400_000,
  ).length;
  const neverCount = data.members.filter((m) => m.neverSynced).length;
  const isOwner = role === "owner";
  const rangeLabel = data.range === "custom" ? `${data.from} → ${data.to}` : data.range;
  const partial = data.scope === "partial";
  const scopeNote = partial
    ? `<span class="pill"><i data-lucide="users"></i>${esc(data.scopeLabel || "Your people")}</span>`
    : "";

  const head = html`
    <div class="phead ov-phead">
      <div>
        <p class="eyeb">Overview</p>
        <h1>${esc(team.name)}</h1>
        <div class="meta">
          <span
            >${data.memberCount}
            ${data.memberCount === 1 ? "person" : "people"}${
              partial && data.teamMemberCount && data.teamMemberCount !== data.memberCount
                ? ` of ${data.teamMemberCount}`
                : ""
            }</span
          >
          ${managers
            ? raw(
                `<span class="meta-sep">·</span><span>${managers} ${managers === 1 ? "manager" : "managers"}</span>`,
              )
            : ""}
          ${raw(scopeNote)}
          ${asOf
            ? raw(
                `<span class="meta-sep">·</span><span>as of ${asOf}</span>`,
              )
            : ""}
          ${staleCount
            ? raw(
                `<span class="pill warn"><i data-lucide="clock"></i>${staleCount} ${staleCount === 1 ? "member" : "members"} stale</span>`,
              )
            : ""}
        </div>
      </div>
      <div class="sp"></div>
      <div class="ov-toolbar">
        ${raw(rangeSeg(data.range, { from: data.from, to: data.to }))}
        <div class="ov-actions">
          <button class="btn" data-act="export-csv" title="Download this range as CSV">
            <i data-lucide="download"></i>Export
          </button>
          <a class="btn" href="#/privacy"><i data-lucide="shield"></i>Disclosure</a>
          ${
            isOwner
              ? raw(
                  `<a class="btn primary" href="#/t/${encodeURIComponent(team.slug)}/settings"><i data-lucide="user-plus"></i>Invite</a>`,
                )
              : ""
          }
        </div>
      </div>
    </div>
  `;

  // Empty is not zero: a team with no telemetry says so and offers the fix.
  if (!t.daysWithData && !data.members.some((m) => !m.neverSynced)) {
    return html`
      <section class="page overview-page">
        ${raw(head)}
        <div class="pnl ov-pnl ov-empty">
          ${raw(
            emptyState({
              icon: "activity",
              title: "Waiting for first sync",
              body: "Your team exists but no metrics have arrived yet. Members appear here once they accept the disclosure and their desktop app uploads.",
              actions: isOwner
                ? `<a class="btn primary" href="#/t/${encodeURIComponent(team.slug)}/settings"><i data-lucide="link"></i>Copy invite link</a><a class="btn" href="#/privacy">What gets collected</a>`
                : `<a class="btn" href="#/privacy">What gets collected</a>`,
            }),
          )}
        </div>
      </section>
    `;
  }

  const concurrency = data.daily.map((d) => d.peakConcurrent);
  const costPerHour = t.activeHours > 0 ? t.costUsd / t.activeHours : null;
  const maxConc = Math.max(0, ...concurrency);

  return html`
    <section class="page overview-page">
      ${raw(head)}
      ${
        neverCount
          ? raw(
              `<div class="banner warn"><i data-lucide="clock"></i><div><b>${neverCount} ${
                neverCount === 1 ? "member has" : "members have"
              } never synced.</b> Totals below exclude ${neverCount === 1 ? "them" : "them"}.</div></div>`,
            )
          : ""
      }

      <div class="stats ov-stats">
        ${raw(
          statCard({
            icon: "coins",
            label: "Reported tokens",
            help: "Measured usage from verified agmux-created sessions. Unverified history and unavailable provider reports are excluded.",
            ...tokenParts(t.tokens),
            spark: "tok",
            delta: data.deltas.tokens,
          }),
        )}
        ${raw(
          statCard({
            icon: "receipt",
            label: t.costIncomplete === false ? "Est. cost" : "Partial est. cost",
            help: "Missing prices or usage details are excluded; not an invoice.",
            ...moneyParts(t.costUsd),
            spark: "cost",
            delta: data.deltas.costUsd,
          }),
        )}
        ${raw(
          statCard({
            icon: "timer",
            label: "Active hours",
            value: t.activeHours.toFixed(1),
            unit: "h",
            spark: "hrs",
            note:
              costPerHour != null
                ? `${fmtMoneyShort(costPerHour)}/h · idle excluded`
                : "agent working time, idle excluded",
          }),
        )}
        ${raw(
          statCard({
            icon: "message-square",
            label: t.sessionsStartedIncomplete ? "Sessions (partial)" : "Sessions",
            help: t.sessionsStartedIncomplete
              ? "Sessions started in agmux in this range. Some activity came from an older agmux version that doesn't report session starts, so the real count is higher."
              : "Sessions started in agmux in this range. Subagents and automatic reviews add to usage, not to this count.",
            value: fmt.sessions(t.sessionsStarted, t.sessionsStartedIncomplete),
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
            note: `${fmt.pct(t.cacheHitRate)} cache hit`,
          }),
        )}
      </div>

      <div class="pnl ov-pnl ov-chart">
        <div class="pnl-h">
          <div class="ov-pnl-title">
            <h3>Daily trends</h3>
            <span class="sub">Tokens and active hours over the range</span>
          </div>
          <div class="sp"></div>
          <div class="legend">
            <span><i style="background:var(--accent);opacity:0.7"></i>Tokens</span>
            <span><i style="background:var(--amber)"></i>Active hours</span>
          </div>
        </div>
        <div class="pnl-b ov-chart-body"><div data-chart="daily"></div></div>
      </div>

      ${
        data.budget || data.canManageBudget
          ? raw(html`
              <div class="pnl ov-pnl ov-budget">
                <div class="pnl-h">
                  <div class="ov-pnl-title">
                    <h3>Monthly budget</h3>
                    <span class="sub">Calendar month · all providers</span>
                  </div>
                  <div class="sp"></div>
                </div>
                ${raw(budgetCard(data.budget, { canManage: data.canManageBudget }))}
              </div>
            `)
          : ""
      }

      <p class="ov-section-label">Breakdown</p>
      <div class="flow ov-flow">
        <div class="pnl ov-pnl">
          <div class="pnl-h">
            <h3>Provider &amp; model mix</h3>
            <div class="sp"></div>
            <span class="sub">tokens · time</span>
          </div>
          <div class="pnl-b mix">
            ${raw(mixRows(data.providerMix))}
            ${
              data.modelMix.length
                ? raw(
                    `<hr class="hr" style="margin:6px 0 10px"><div class="eyeb" style="margin-bottom:8px">Top models</div>${mixRows(
                      data.modelMix.slice(0, 6),
                      { mono: true },
                    )}`,
                  )
                : ""
            }
          </div>
        </div>
        <div class="pnl ov-pnl">
          <div class="pnl-h">
            <h3>What the agents did</h3>
            <div class="sp"></div>
            <span class="sub">${t.toolCalls.toLocaleString()} tool calls</span>
          </div>
          <div class="pnl-b">${raw(toolMixPanel(t))}</div>
        </div>
        <div class="pnl ov-pnl">
          <div class="pnl-h">
            <h3>Output &amp; reliability</h3>
            <div class="sp"></div>
            <span class="sub">code written, calls failed</span>
          </div>
          <div class="pnl-b">${raw(outputPanel(t))}</div>
        </div>
        <div class="pnl ov-pnl">
          <div class="pnl-h">
            <h3>Token composition</h3>
            <div class="sp"></div>
            <span class="sub">${fmt.tok(t.tokens)} total</span>
          </div>
          <div class="pnl-b">${raw(tokenBreakdown(t))}</div>
        </div>
        <div class="pnl ov-pnl">
          <div class="pnl-h">
            <h3>Work rates</h3>
            <div class="sp"></div>
            <span class="sub">derived from this range</span>
          </div>
          <div class="pnl-b">${raw(efficiencyGrid(t))}</div>
        </div>
        <div class="pnl ov-pnl">
          <div class="pnl-h">
            <h3>Flags</h3>
            <div class="sp"></div>
            <span class="sub">${esc(rangeLabel)}</span>
          </div>
          <div class="pnl-b flags">${raw(flagsPanel(data.flags, { rangeLabel }))}</div>
        </div>
        <div class="pnl ov-pnl">
          <div class="pnl-h">
            <h3>Peak simultaneous sessions</h3>
            <div class="sp"></div>
            <span class="sub">max ${maxConc}</span>
          </div>
          <div class="pnl-b"><div data-chart="conc"></div></div>
        </div>
        <div class="pnl ov-pnl">
          <div class="pnl-h">
            <h3>Projects</h3>
            <div class="sp"></div>
            <span class="sub">basename or hash only</span>
          </div>
          ${raw(projectsTable(data.projects || [], { limit: 10 }))}
        </div>
      </div>

      <p class="ov-section-label">Patterns</p>
      <div class="pnl ov-pnl ov-heat">
        <div class="pnl-h">
          <div class="ov-pnl-title">
            <h3>Hour of day</h3>
            <span class="sub">Team active hours · local time</span>
          </div>
          <div class="sp"></div>
          <div class="legend">
            <span>low</span>
            <span
              ><i style="background:var(--accent);opacity:0.25"></i
              ><i style="background:var(--accent);opacity:0.55"></i
              ><i style="background:var(--accent)"></i
            ></span>
            <span>high</span>
          </div>
        </div>
        <div class="pnl-b ov-chart-body"><div data-chart="heat"></div></div>
      </div>

      <div class="pnl ov-pnl ov-members-cta">
        <div class="pnl-b set-row" style="align-items:center">
          <div class="sp">
            <div class="t">Member directory</div>
            <div class="d">
              ${data.memberCount ?? data.members?.length ?? 0} people · usage, sync status, and
              drill-down by person for this range.
            </div>
          </div>
          <a class="btn primary" href="#/t/${encodeURIComponent(team.slug)}/members"
            ><i data-lucide="users"></i>Open members</a
          >
        </div>
      </div>

      ${
        data.canViewAudit
          ? raw(html`
              <div class="pnl ov-pnl ov-audit">
                <div class="pnl-h">
                  <div class="ov-pnl-title">
                    <h3>Activity log</h3>
                    <span class="sub">Membership, billing, groups, invites, exports</span>
                  </div>
                  <div class="sp"></div>
                  <span class="sub">no telemetry</span>
                </div>
                <div data-slot="audit">
                  <div class="pnl-b"><p class="hint" style="margin:0">Loading…</p></div>
                </div>
              </div>
            `)
          : ""
      }
    </section>
  `;
}

function fmtMoneyShort(n) {
  if (n >= 100) {
    return "$" + Math.round(n).toLocaleString("en-US");
  }
  return (
    "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}
