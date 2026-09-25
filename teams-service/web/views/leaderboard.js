/* Manager/owner weekly PR leaderboard. */

import { esc, html, raw } from "../dom.js";

function fmtTokens(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Tokens per PR point (lower is better). */
function fmtTokPerPt(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  if (n >= 10) return n.toFixed(0);
  return n.toFixed(1);
}

/** $ per PR point (lower is better). */
function fmtUsdPerPt(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  if (n > 0) return `$${n.toFixed(4)}`;
  return "$0";
}

/**
 * Turn a GitHub-style login into Title Case words.
 * "mohan-gummalam" → "Mohan Gummalam"
 */
export function prettifyHandle(handle) {
  const s = String(handle || "").trim();
  if (!s) return "";
  return s
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Prefer a human display name; if the stored name is just a login (or login-like),
 * title-case it so the Member column doesn't look like two handles.
 */
export function memberDisplayName(displayName, githubLogin) {
  const name = String(displayName || "").trim();
  const login = String(githubLogin || "").trim();
  if (!name && login) return prettifyHandle(login);
  if (!name) return "Unknown";

  const nameLc = name.toLowerCase();
  const loginLc = login.toLowerCase();
  // Exact match with login → prettify once
  if (login && nameLc === loginLc) return prettifyHandle(login);
  // login-like: lowercase/hyphen/underscore, no spaces
  if (/^[a-z0-9][a-z0-9_-]*$/.test(name) && /[-_]/.test(name)) {
    return prettifyHandle(name);
  }
  return name;
}

/** Columns: efficiency metrics default ascending (lower better); volume desc. */
export const LB_SORT_DEFAULTS = {
  rank: true,
  member: true,
  prSmall: false,
  prMedium: false,
  prLarge: false,
  prOpened: false,
  prMerged: false,
  points: false,
  tokens: false,
  tokensPerPr: false,
  tokensPerPoint: true,
  costPerPoint: true,
};

/**
 * Map leaderboard week bounds (UTC ISO, end exclusive) to the dashboard custom
 * range (inclusive YYYY-MM-DD days). Aligns token/cost panels with TOK/pt.
 */
export function weekUtcToCustomRange(weekStart, weekEnd) {
  if (!weekStart || !weekEnd) return null;
  const from = String(weekStart).slice(0, 10);
  const endMs = Date.parse(weekEnd);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(endMs)) return null;
  const to = new Date(endMs - 86_400_000).toISOString().slice(0, 10);
  if (from > to) return null;
  return { from, to };
}

export function sortLeaderboardRows(rows, key, asc) {
  const list = [...(rows || [])];
  const dir = asc ? 1 : -1;
  const num = (v) => (v == null || !Number.isFinite(v) ? Number.POSITIVE_INFINITY * (asc ? 1 : -1) : v);
  list.sort((a, b) => {
    const rankOrder = a.rank == null ? (b.rank == null ? 0 : 1)
      : b.rank == null ? -1 : a.rank - b.rank;
    if (key === "member") {
      const an = memberDisplayName(a.displayName, a.githubLogin).toLowerCase();
      const bn = memberDisplayName(b.displayName, b.githubLogin).toLowerCase();
      return an < bn ? -dir : an > bn ? dir : rankOrder;
    }
    if (key === "tokensPerPr") {
      const av = a.prMerged > 0 ? a.tokens / a.prMerged : Number.POSITIVE_INFINITY;
      const bv = b.prMerged > 0 ? b.tokens / b.prMerged : Number.POSITIVE_INFINITY;
      const d = num(av) - num(bv);
      return d === 0 ? rankOrder : d * dir;
    }
    const av = key === "rank" ? a.rank : a[key];
    const bv = key === "rank" ? b.rank : b[key];
    if (typeof av === "string" || typeof bv === "string") {
      const as = String(av ?? "").toLowerCase();
      const bs = String(bv ?? "").toLowerCase();
      return as < bs ? -dir : as > bs ? dir : rankOrder;
    }
    const d = num(av) - num(bv);
    return d === 0 ? rankOrder : d * dir;
  });
  return list;
}

export function leaderboardView({
  team,
  role,
  data,
  week,
  hasGithub,
  sortKey = "costPerPoint",
  sortAsc = true,
}) {
  const canManage = role === "owner";
  const enabled = data?.enabled;

  return html`
    <section class="page">
      <div class="phead">
        <div>
          <p class="eyeb">Teams plan</p>
          <h1>Leaderboard</h1>
          <div class="meta">
            <span>${esc(team.name)}</span>
            <span style="color:var(--t5)">·</span>
            <span>Weekly efficiency — lower $/pt is better</span>
          </div>
        </div>
        <div class="sp"></div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <div class="seg">
            <button class="btn ${week === "current" ? "on" : ""}" data-lb-week="current">This week</button>
            <button class="btn ${week === "prev" ? "on" : ""}" data-lb-week="prev">Last week</button>
          </div>
          ${canManage
            ? raw(
                `<a class="btn" href="#/t/${encodeURIComponent(team.slug)}/settings">Configure</a>`,
              )
            : ""}
        </div>
      </div>

      ${!hasGithub
        ? raw(`<div class="banner">
            <i data-lucide="github"></i>
            <div>
              <b>Link GitHub to appear on the board.</b>
              Managers can view the board without linking; ranking requires a GitHub identity
              on the same Teams account as your token usage.
              <div style="margin-top:8px">
                <a class="btn primary" data-act="link-github" href="#">Link GitHub</a>
              </div>
            </div>
          </div>`)
        : ""}

      ${raw(
        !enabled
          ? html`<div class="pnl"><div class="pnl-b empty-state">
            <p>Leaderboard is off for this team.</p>
            ${canManage
              ? raw('<p class="hint">Turn it on under Team settings → Leaderboard.</p>')
              : raw('<p class="hint">Ask an owner to enable it.</p>')}
          </div></div>`
          : leaderboardBody(data, canManage, sortKey, sortAsc),
      )}
    </section>
  `;
}

function sortTh(key, label, sortKey, sortAsc, extraClass = "") {
  const on = key === sortKey;
  const icon = on
    ? raw(` <i data-lucide="${sortAsc ? "chevron-up" : "chevron-down"}"></i>`)
    : "";
  const cls = [extraClass, on ? "sorted" : ""].filter(Boolean).join(" ");
  return html`<th data-sort="${key}" tabindex="0" class="${cls}" title="Sort by ${label}">${label}${icon}</th>`;
}

function leaderboardBody(data, canManage, sortKey = "costPerPoint", sortAsc = true) {
  const complexity = data.scoringMode === "complexity";

  if (!data.rows?.length) {
    const hints = [];
    if (!data.lastSyncAt) {
      hints.push(
        canManage
          ? "Not synced yet — open Settings → Leaderboard → Sync now (after saving repos)."
          : "Not synced yet — ask an owner to run Sync.",
      );
    } else {
      hints.push(`Last sync ${data.lastSyncAt}.`);
    }
    if (data.lastSyncError) hints.push(`Sync note: ${data.lastSyncError}`);
    if (typeof data.syncedPrCount === "number") {
      hints.push(`${data.syncedPrCount} PR(s) stored for this team.`);
    }
    if (typeof data.memberCountEligible === "number") {
      hints.push(
        `${data.memberCountEligible} member(s) with GitHub linked; ${data.memberCountRanked ?? 0} ranked this week.`,
      );
    }
    if (data.excludedNoTokens?.length) {
      hints.push(
        `${data.excludedNoTokens.length} had PR points but no token usage this week (listed below).`,
      );
    }
    if (complexity && data.complexityCoverage) {
      hints.push(
        `Complexity coverage: ${data.complexityCoverage.withPoints}/${data.complexityCoverage.total} PRs have Project Size.`,
      );
    }
    hints.push(
      "Need: opened/merged PRs in tracked repos this week, GitHub linked on the same Teams account, and token usage.",
    );

    return html`
      <div class="pnl">
        <div class="pnl-b empty-state">
          <p>No ranked members for ${esc(data.week)}.</p>
          <p class="hint">${raw(hints.map((h) => esc(h)).join("<br>"))}</p>
        </div>
      </div>
      ${data.excludedNoTokens?.length ? raw(excludedBlock(data.excludedNoTokens)) : ""}
    `;
  }

  // If sorted by S/M/L while in complexity mode, fall back to PRs column.
  let effectiveKey = sortKey;
  if (complexity && (sortKey === "prSmall" || sortKey === "prMedium" || sortKey === "prLarge")) {
    effectiveKey = "prOpened";
  }
  const rows = sortLeaderboardRows(data.rows, effectiveKey, sortAsc);

  const coverage =
    complexity && data.complexityCoverage
      ? ` · Size on ${data.complexityCoverage.withPoints}/${data.complexityCoverage.total} PRs`
      : "";

  const rowMeta = (r) => {
    const name = memberDisplayName(r.displayName, r.githubLogin);
    const login = r.githubLogin || r.handle;
    const tokPerPr =
      r.prMerged > 0 && Number.isFinite(r.tokens) ? r.tokens / r.prMerged : null;
    const opened =
      r.prOpened != null
        ? r.prOpened
        : (r.prSmall || 0) + (r.prMedium || 0) + (r.prLarge || 0);
    return { name, login, tokPerPr, opened };
  };

  return html`
    <div class="pnl">
      <div class="pnl-h">
        <h3>
          ${esc(data.week)}${complexity
            ? raw(' <span class="sub">· complexity points</span>')
            : ""}
        </h3>
        <div class="sp"></div>
        <span class="sub"
          >${data.memberCountRanked} ranked · ${data.memberCountEligible} with GitHub${coverage}</span
        >
      </div>
      <div class="tbl-scroll lb-desktop">
        <table class="tbl" id="lbTable">
          <thead>
            <tr>
              ${raw(sortTh("rank", "#", effectiveKey, sortAsc))}
              ${raw(sortTh("member", "Member", effectiveKey, sortAsc, "l"))}
              ${complexity
                ? raw(sortTh("prOpened", "PRs", effectiveKey, sortAsc))
                : raw(
                    [
                      sortTh("prSmall", "S", effectiveKey, sortAsc),
                      sortTh("prMedium", "M", effectiveKey, sortAsc),
                      sortTh("prLarge", "L", effectiveKey, sortAsc),
                    ].join(""),
                  )}
              ${raw(sortTh("prMerged", "Merged", effectiveKey, sortAsc))}
              ${raw(sortTh("points", "Points", effectiveKey, sortAsc))}
              ${raw(sortTh("tokens", "Tokens", effectiveKey, sortAsc))}
              ${raw(sortTh("tokensPerPr", "Tok/PR", effectiveKey, sortAsc))}
              ${raw(sortTh("tokensPerPoint", "Tok/pt", effectiveKey, sortAsc))}
              ${raw(sortTh("costPerPoint", "$/pt", effectiveKey, sortAsc))}
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => {
              const { name, login, tokPerPr, opened } = rowMeta(r);
              return html`
                <tr
                  data-member="${esc(r.userId || "")}"
                  title="Open token breakdown for ${esc(data.week || "this week")}"
                >
                  <td>
                    <span class="num" aria-label="${r.rank == null ? "Unranked: incomplete cost" : `rank ${r.rank}`}">${r.rank ?? "—"}</span>
                  </td>
                  <td class="l">
                    <div class="who">
                      <div>
                        <div class="nm" title="${esc(name)}">${esc(name)}</div>
                        ${login ? raw(`<div class="hd">@${esc(login)}</div>`) : ""}
                      </div>
                    </div>
                  </td>
                  ${complexity
                    ? raw(`<td class="n">${opened}</td>`)
                    : raw(
                        `<td class="n">${r.prSmall}</td>
                         <td class="n">${r.prMedium}</td>
                         <td class="n">${r.prLarge}</td>`,
                      )}
                  <td class="n">${r.prMerged}</td>
                  <td class="n">${r.points.toFixed(1)}</td>
                  <td class="n">${fmtTokens(r.tokens)}</td>
                  <td class="n">${fmtTokPerPt(tokPerPr)}</td>
                  <td class="n">${fmtTokPerPt(r.tokensPerPoint)}</td>
                  <td class="n">${fmtUsdPerPt(r.costPerPoint)}</td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      </div>
      <div class="lb-cards" id="lbCards">
        ${rows.map((r) => {
          const { name, login, tokPerPr, opened } = rowMeta(r);
          return html`
            <button
              type="button"
              class="lb-card"
              data-member="${esc(r.userId || "")}"
              title="Open token breakdown for ${esc(data.week || "this week")}"
            >
              <span class="num" aria-label="${r.rank == null ? "Unranked: incomplete cost" : `rank ${r.rank}`}">${r.rank ?? "—"}</span>
              <div class="lb-card-who">
                <div class="nm" title="${esc(name)}">${esc(name)}</div>
                ${login ? raw(`<div class="hd">@${esc(login)}</div>`) : ""}
              </div>
              <div class="lb-card-score">
                <div class="v">${fmtUsdPerPt(r.costPerPoint)}</div>
                <div class="k">$/pt</div>
              </div>
              <div class="lb-card-metrics">
                <span><b>${opened}</b> PRs</span>
                <span><b>${r.prMerged}</b> merged</span>
                <span><b>${r.points.toFixed(1)}</b> pts</span>
                <span><b>${fmtTokens(r.tokens)}</b> tok</span>
                <span><b>${fmtTokPerPt(r.tokensPerPoint)}</b> tok/pt</span>
                <span><b>${fmtTokPerPt(tokPerPr)}</b> tok/PR</span>
              </div>
            </button>
          `;
        })}
      </div>
    </div>
    ${data.excludedNoTokens?.length ? raw(excludedBlock(data.excludedNoTokens)) : ""}
    <p class="hint" style="margin-top:12px">
      Incomplete costs are unranked; their tokens and PR points remain visible. Default rank is <b>$/pt</b> (lower is better). Click any column to re-sort — # badge stays the
      efficiency rank. <b>Click a person</b> to open their token drivers (model mix, composition,
      cache) for this week. Tok/PR = tokens ÷ merged PRs.
      ${complexity
        ? raw(
            " Points = Nenu <b>complexity points</b> from GitHub Project Size (XS=1, S=2, M=4, L=8, XL=16, XXL=32) on opened PRs + merge bonus. PRs without Size fall back to line-count tiers.",
          )
        : raw(
            " Points = weighted opened PRs (S/M/L) + merge bonus. Size is lines changed (additions + deletions).",
          )}
      ${data.lastSyncAt ? ` Last GitHub sync: ${esc(data.lastSyncAt)}.` : ""}
      ${data.lastSyncError ? ` ${esc(data.lastSyncError)}` : ""}
    </p>
  `;
}

function excludedBlock(rows) {
  return html`
    <div class="pnl" style="margin-top:16px">
      <div class="pnl-h"><h3>PR points, no token usage</h3></div>
      <div class="pnl-b">
        <p class="hint" style="margin:0 0 10px">Excluded from ranking until Teams reports token usage for the week. Click a name to open their metrics.</p>
        <div class="group-list">
          ${rows.map(
            (r) =>
              html`<div
                class="group-row"
                style="padding:8px 0;cursor:pointer"
                data-member="${esc(r.userId || "")}"
                title="Open metrics"
              >
                <div class="nm">${esc(memberDisplayName(r.displayName, r.githubLogin))}</div>
                <div class="meta" style="margin-left:auto;margin-top:0">${r.points.toFixed(1)} pts</div>
              </div>`,
          )}
        </div>
      </div>
    </div>
  `;
}

export function leaderboardSettingsPanel({ settings, repos, isOwner, teamSlug = "" }) {
  if (!isOwner) return "";
  const s = settings || {};
  const selected = new Set(repos?.selected || []);
  const available = repos?.available?.length
    ? repos.available
    : (repos?.selected || []).map((fullName) => ({ fullName, private: false }));
  const planRequired = Boolean(s.planRequired);
  const planHref = teamSlug ? `#/t/${encodeURIComponent(teamSlug)}/plan` : "#/teams";

  if (planRequired) {
    return html`
      <section class="set-card set-card-wide" id="lb-settings" aria-labelledby="set-lb-h">
        <header class="set-card-h">
          <div class="set-card-ico"><i data-lucide="trophy"></i></div>
          <div class="set-card-h-main">
            <p class="eyeb">Teams plan</p>
            <h2 id="set-lb-h">Leaderboard</h2>
          </div>
          <span class="sub">Paid feature</span>
        </header>
        <div class="set-card-b">
          <p class="banner warn" style="margin:0">
            <i data-lucide="lock"></i>
            <div>
              Weekly PR and cost ranking is on the <b>Teams plan</b> (or an active trial) — not Free.
              Open <a href="${esc(planHref)}">Plan</a> to upgrade.
            </div>
          </p>
        </div>
      </section>
    `;
  }

  return html`
    <section class="set-card set-card-wide" id="lb-settings" aria-labelledby="set-lb-h">
      <header class="set-card-h">
        <div class="set-card-ico"><i data-lucide="trophy"></i></div>
        <div class="set-card-h-main">
          <p class="eyeb">Teams plan</p>
          <h2 id="set-lb-h">Leaderboard</h2>
        </div>
        <span class="sub">Managers see weekly ranks</span>
      </header>
      <div class="set-card-b set-lb-body">
        <div class="set-row">
          <div class="sp">
            <div class="t">Enable leaderboard</div>
            <div class="d">
              Weekly ranks for GitHub-linked members. Lower <span class="mono">$/pt</span> and
              <span class="mono">tok/pt</span> is better — owners and managers only.
            </div>
          </div>
          <label class="set-ctrl">
            <input type="checkbox" id="lb-enabled" ${s.enabled ? "checked" : ""} data-lb-enabled />
            <span class="sub">${s.enabled ? "On" : "Off"}</span>
          </label>
        </div>

        <hr class="hr" />

        <div class="set-sec">
          <div class="t">GitHub organization</div>
          <div class="d">
            ${s.installationConnected
              ? raw(
                  `Connected to <b style="color:var(--t2)">${esc(s.githubOrgLogin || "org")}</b>${
                    s.scoringMode === "complexity"
                      ? " · scoring with <b style=\"color:var(--t2)\">Nenu complexity points</b> (Project Size XS–XXL)"
                      : ""
                  }`,
                )
              : s.appConfigured
                ? "Install the agmux Teams GitHub App on your org, then choose which repos count."
                : "Server needs GITHUB_APP_* secrets before org install works."}
          </div>
          <div class="set-actions" style="margin-top:8px">
            ${s.appConfigured && !s.installationConnected
              ? raw(`<button class="btn primary" data-act="lb-install">Connect GitHub org</button>`)
              : ""}
            ${s.installationConnected
              ? raw(`<button class="btn" data-act="lb-unlink">Disconnect</button>
                     <button class="btn" data-act="lb-sync">Sync now</button>`)
              : ""}
          </div>
          ${s.lastSyncAt || s.lastSyncError
            ? raw(
                `<p class="hint" style="margin:8px 0 0">${
                  s.lastSyncAt ? `Last sync ${esc(s.lastSyncAt)}` : "Never synced"
                }${s.lastSyncError ? ` · ${esc(s.lastSyncError)}` : ""}</p>`,
              )
            : raw(
                '<p class="hint" style="margin:8px 0 0">Never synced — pick repos and click Sync now.</p>',
              )}
        </div>

        ${s.installationConnected
          ? raw(`
        <div class="set-sec">
          <div class="t">Repositories</div>
          <div class="d">Only selected repos count. Save, then Sync.</div>
          <div class="lb-repos set-check-list">
            ${
              available.length
                ? available
                    .map(
                      (r) => `
              <label class="set-check">
                <input type="checkbox" data-lb-repo="${esc(r.fullName)}" ${
                  selected.has(r.fullName) ? "checked" : ""
                } />
                <span class="mono" style="font-size:12px">${esc(r.fullName)}</span>
              </label>`,
                    )
                    .join("")
                : '<p class="hint" style="margin:0">No repos returned from the installation yet.</p>'
            }
          </div>
          <div class="set-actions" style="margin-top:10px">
            <button class="btn" data-act="lb-save-repos">Save repos</button>
          </div>
        </div>`)
          : ""}

        <details class="set-sec set-details">
          <summary class="t">Thresholds &amp; weights</summary>
          ${s.scoringMode === "complexity"
            ? raw(`<p class="hint" style="margin:10px 0 0">
              This org uses <b style="color:var(--t2)">complexity points</b> from GitHub Project Size (XS=1 … XXL=32) when Size is set.
              Line thresholds below only apply to PRs missing Size. Merge bonus still applies.
            </p>`)
            : ""}
          <div class="set-form-grid" style="margin-top:12px">
            <label class="lbl">Small max lines
              <input class="input" type="number" id="lb-th-s" value="${s.thresholds?.smallMax ?? 100}" />
            </label>
            <label class="lbl">Medium max lines
              <input class="input" type="number" id="lb-th-m" value="${s.thresholds?.mediumMax ?? 500}" />
            </label>
            <label class="lbl">Weight small
              <input class="input" type="number" step="0.1" id="lb-w-s" value="${s.weights?.small ?? 1}" />
            </label>
            <label class="lbl">Weight medium
              <input class="input" type="number" step="0.1" id="lb-w-m" value="${s.weights?.medium ?? 2}" />
            </label>
            <label class="lbl">Weight large
              <input class="input" type="number" step="0.1" id="lb-w-l" value="${s.weights?.large ?? 4}" />
            </label>
            <label class="lbl">Merge bonus
              <input class="input" type="number" step="0.1" id="lb-w-merge" value="${s.weights?.merge ?? 0.5}" />
            </label>
          </div>
          <p class="hint" style="margin:8px 0 0">
            Size tiers apply to newly synced PRs. Weights recompute on every week view.
          </p>
          <div class="set-actions" style="margin-top:10px">
            <button class="btn" data-act="lb-save-weights">Save weights</button>
          </div>
        </details>

        <p class="hint" style="margin:0">
          Members must <b style="color:var(--t3)">link GitHub</b> (or sign up with it) so PRs and
          token usage share one identity.
        </p>
      </div>
    </section>
  `;
}
