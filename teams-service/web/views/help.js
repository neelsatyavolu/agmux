/* Help — plain-language guide for everything on this site.
   No marketing fluff. Same disclosure wording as join / privacy. */

import { esc, html, raw } from "../dom.js";
import { disclosureBlock } from "../disclosure.js";

/**
 * @param {{ team: { name: string, slug: string }, role: string }} opts
 */
export function teamHelp({ team, role }) {
  const slug = encodeURIComponent(team.slug);
  const roleLabel =
    role === "owner" ? "owner" : role === "manager" ? "manager" : "member";

  return html`
    <section class="page help-page">
      <div class="phead">
        <div>
          <p class="eyeb">Guide</p>
          <h1>Help</h1>
          <div class="meta">
            <span>${esc(team.name)}</span>
            <span style="color:var(--t5)">·</span>
            <span>You're signed in as <b style="color:var(--t3)">${roleLabel}</b></span>
          </div>
        </div>
        <div class="sp"></div>
        <a class="btn" href="#/privacy"><i data-lucide="shield"></i>Full disclosure</a>
      </div>

      <nav class="help-toc" aria-label="On this page">
        <a href="#help-what">What this is</a>
        <a href="#help-start">Get set up</a>
        <a href="#help-data">What is collected</a>
        <a href="#help-roles">Roles</a>
        <a href="#help-tabs">Tabs</a>
        <a href="#help-metrics">Reading metrics</a>
        <a href="#help-budget">Budgets</a>
        <a href="#help-lb">Leaderboard</a>
        <a href="#help-kw">Knowledge</a>
        <a href="#help-plan">Plan &amp; seats</a>
        <a href="#help-leave">Leave or delete</a>
        <a href="#help-fix">Stuck?</a>
      </nav>

      <div class="help-stack">
        <section class="pnl" id="help-what">
          <div class="pnl-h"><h3>What agmux Teams is</h3></div>
          <div class="pnl-b help-prose">
            <p>
              Teams is org analytics for AI coding agents on Mac: Claude, Codex, Grok, and the
              others you run in the agmux desktop app. It answers questions like how much the team
              spent on tokens this month, who is blocked waiting on approvals, and which models
              people actually use.
            </p>
            <p>
              Numbers and short labels only. No prompt text, no agent replies, no diffs, no
              source code. The desktop app counts locally, then uploads hourly aggregates when
              someone is on a team and has accepted the disclosure.
            </p>
            <p>
              This website is the manager view. The desktop app stays free for personal use either
              way.
            </p>
          </div>
        </section>

        <section class="pnl" id="help-start">
          <div class="pnl-h"><h3>Get set up</h3></div>
          <div class="pnl-b flags">
            <div class="flag">
              <div class="num">1</div>
              <div>
                <b>Create a team (or accept an invite)</b>
                <div class="m">
                  Owners create the team here, then copy the invite link from Settings. Invitees open
                  <span class="mono">teams.agmux.dev/join/…</span>, sign in with GitHub or Google,
                  read the disclosure, and accept. Until they accept, nothing uploads for them.
                </div>
              </div>
            </div>
            <div class="flag">
              <div class="num">2</div>
              <div>
                <b>Link the desktop app</b>
                <div class="m">
                  On each Mac: Settings → Teams, then sign in / link device. The web session and the
                  Mac need to be the same person. Linking is what lets the app attach uploads to your
                  membership.
                </div>
              </div>
            </div>
            <div class="flag">
              <div class="num">3</div>
              <div>
                <b>Keep working as usual</b>
                <div class="m">
                  Use Claude, Codex, Grok, and the rest. The app uploads about every two minutes when
                  linked and on a team. Overview stays empty until the first successful upload —
                  empty means “no data yet,” not “everyone did zero work.”
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="pnl" id="help-data">
          <div class="pnl-h">
            <h3>What is collected</h3>
            <div class="sp"></div>
            <a class="btn" href="#/privacy">Privacy page →</a>
          </div>
          <div class="pnl-b help-prose" style="padding-bottom:10px">
            <p>
              Same list as join and the privacy page. Managers see named rows; that is the product,
              and members agreed to it when they joined.
            </p>
          </div>
          ${raw(disclosureBlock())}
          <div class="pnl-b help-prose" style="padding-top:12px">
            <p class="hint" style="margin:0">
              Project names are basenames (or a hash for private repos) — never full disk paths.
              File and line change numbers are counts only; the actual lines never leave the Mac.
            </p>
          </div>
        </section>

        <section class="pnl" id="help-roles">
          <div class="pnl-h"><h3>Roles</h3></div>
          <div class="tbl-scroll">
            <table class="tbl">
              <thead>
                <tr>
                  <th>Capability</th>
                  <th>Owner</th>
                  <th>Manager</th>
                  <th>Employee</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Own metrics</td>
                  <td class="n">yes</td>
                  <td class="n">yes</td>
                  <td class="n">yes</td>
                </tr>
                <tr>
                  <td>Other people&apos;s metrics</td>
                  <td class="n">yes</td>
                  <td class="n">yes (in scope)</td>
                  <td class="dim">no</td>
                </tr>
                <tr>
                  <td>Team overview &amp; CSV export</td>
                  <td class="n">yes</td>
                  <td class="n">yes (scoped)</td>
                  <td class="dim">self only</td>
                </tr>
                <tr>
                  <td>Leaderboard (if enabled)</td>
                  <td class="n">yes</td>
                  <td class="n">yes</td>
                  <td class="dim">no</td>
                </tr>
                <tr>
                  <td>Invite link create / revoke</td>
                  <td class="n">yes</td>
                  <td class="dim">no</td>
                  <td class="dim">no</td>
                </tr>
                <tr>
                  <td>Roles, groups, remove members</td>
                  <td class="n">yes</td>
                  <td class="dim">no</td>
                  <td class="dim">no</td>
                </tr>
                <tr>
                  <td>Budget set / change</td>
                  <td class="n">yes</td>
                  <td class="dim">view only</td>
                  <td class="dim">no</td>
                </tr>
                <tr>
                  <td>Plan &amp; billing</td>
                  <td class="n">yes</td>
                  <td class="dim">no</td>
                  <td class="dim">no</td>
                </tr>
                <tr>
                  <td>Delete team</td>
                  <td class="n">yes</td>
                  <td class="dim">no</td>
                  <td class="dim">no</td>
                </tr>
                <tr>
                  <td>Leave team</td>
                  <td class="dim">transfer first</td>
                  <td class="n">yes</td>
                  <td class="n">yes</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="pnl-b help-prose">
            <p>
              <b style="color:var(--t3)">Managers</b> default to the whole roster. Owners can limit a
              manager to specific groups or people (Settings → Edit scope). Scoped managers still
              cannot invite, bill, or change roles.
            </p>
            <p>
              <b style="color:var(--t3)">Employees</b> open Overview and land on their own numbers.
              They do not see the Members directory or Leaderboard.
            </p>
          </div>
        </section>

        <section class="pnl" id="help-tabs">
          <div class="pnl-h"><h3>What each tab does</h3></div>
          <div class="pnl-b help-prose">
            <dl class="help-dl">
              <div>
                <dt>Overview</dt>
                <dd>
                  Cost, tokens, active hours, heatmaps, tool mix, and per-person rows for the date
                  range you pick (7 / 14 / 30 / 90 days or a custom window). Export downloads that
                  same range as CSV. Employees see only themselves.
                </dd>
              </div>
              <div>
                <dt>Members</dt>
                <dd>
                  Directory for owners and managers. Open a person for their full breakdown. “Never
                  synced” means they joined but the Mac has not uploaded yet; “stale” means no upload
                  in over a day.
                </dd>
              </div>
              <div>
                <dt>Leaderboard</dt>
                <dd>
                  Teams plan only (trial or paid). Owners turn it on in Settings, connect a GitHub
                  App installation, and pick repos. Ranks cost and PR activity by ISO week. Managers
                  can view; employees cannot. Free tier teams do not get Leaderboard.
                </dd>
              </div>
              <div>
                <dt>Knowledge</dt>
                <dd>
                  Teams plan only (trial or paid). Shared decisions and short session digests.
                  Owners enable the mode. Agents only read records marked official when MCP is on —
                  not full chats. Free tier does not include Knowledge.
                </dd>
              </div>
              <div>
                <dt>Settings</dt>
                <dd>
                  Owner tools: rename team, invite link, roster, groups, manager scope, org policy,
                  Leaderboard GitHub setup, danger zone. Managers may open this for a read-only
                  roster view depending on layout; only the owner can change things.
                </dd>
              </div>
              <div>
                <dt>Plan</dt>
                <dd>
                  Owner-only billing. First three seats free forever; paid seats after that.
                  Stripe Checkout and Customer Portal for card, invoices, and cancel.
                </dd>
              </div>
              <div>
                <dt>Help</dt>
                <dd>This page.</dd>
              </div>
            </dl>
            <p class="hint">
              Jump:
              <a href="#/t/${slug}">Overview</a>
              ·
              <a href="#/t/${slug}/members">Members</a>
              ·
              <a href="#/t/${slug}/settings">Settings</a>
              ·
              <a href="#/t/${slug}/plan">Plan</a>
            </p>
          </div>
        </section>

        <section class="pnl" id="help-metrics">
          <div class="pnl-h"><h3>Reading the metrics</h3></div>
          <div class="pnl-b help-prose">
            <dl class="help-dl">
              <div>
                <dt>Cost</dt>
                <dd>
                  Estimated USD from token counts and model prices. Useful for trends and budgets;
                  not a tax invoice.
                </dd>
              </div>
              <div>
                <dt>Tokens</dt>
                <dd>
                  Input, output, and cached. Cached is still usage; it just costs less than a full
                  input token on providers that report it.
                </dd>
              </div>
              <div>
                <dt>Active time</dt>
                <dd>
                  Time the agent was actually working, from gaps between events (idle capped so a
                  long coffee break does not inflate the bar). Not “app open in the dock.”
                </dd>
              </div>
              <div>
                <dt>Sessions / turns / tools</dt>
                <dd>
                  Sessions counts each conversation started in agmux once, on the day it started. Subagents and automatic reviews add to tokens and active time but are not sessions. Per-hour rates divide by active session-hours instead (each session counts once per hour it was active). Conversation turns and tool calls are counted separately. Tools are grouped:
                  terminal, edits, reads, search, web, subagents, MCP, other.
                </dd>
              </div>
              <div>
                <dt>Errors</dt>
                <dd>
                  Failed tool calls only where the provider reports an outcome. Some providers do
                  not report general tool success/failure; those periods do not invent an error rate.
                </dd>
              </div>
              <div>
                <dt>Files / lines</dt>
                <dd>
                  Counts of change operations and lines added or removed. Not a distinct file list
                  and never the file contents.
                </dd>
              </div>
              <div>
                <dt>After-hours / weekend / idle days</dt>
                <dd>
                  Work pattern shares from the same active-time timeline. Idle days are days with no
                  measured agent activity in the range.
                </dd>
              </div>
              <div>
                <dt>Approval wait</dt>
                <dd>
                  How often tools blocked on your approve/deny decision, and how long they waited in
                  total. High wait time often means the team is stuck on permissions, not writing
                  code.
                </dd>
              </div>
              <div>
                <dt>As of …</dt>
                <dd>
                  Last successful upload from that person&apos;s desktop. If it never moves, they are
                  not linked, not on the team, or the Mac is offline.
                </dd>
              </div>
            </dl>
            <p>
              Charts break the line or leave a gap when a day has no data. We do not draw a flat
              zero and pretend the day was measured.
            </p>
          </div>
        </section>

        <section class="pnl" id="help-budget">
          <div class="pnl-h"><h3>Budgets</h3></div>
          <div class="pnl-b help-prose">
            <p>
              Owners set a monthly spend cap on Overview. Managers can see the bar; employees
              cannot. The forecast is a straight-line run rate from spend so far in the month — if
              the pace holds, where you land.
            </p>
            <p>
              Alerts fire once per threshold per calendar month (for example 50%, 80%, 100%).
              Clearing the budget removes the row; there is no “$0 budget” that blocks the team.
            </p>
          </div>
        </section>

        <section class="pnl" id="help-lb">
          <div class="pnl-h"><h3>Leaderboard</h3></div>
          <div class="pnl-b help-prose">
            <p>
              Teams plan only (trial or paid). Turns agent cost and GitHub PR activity into a weekly
              ranking. Requires: owner enables Leaderboard, GitHub App connected, at least one repo
              selected, and a successful PR sync.
            </p>
            <p>
              Click a row to open that person&apos;s metrics for the same week. Employees never see
              this tab. Ranking is for ops visibility, not a performance review product — use it with
              that in mind.
            </p>
          </div>
        </section>

        <section class="pnl" id="help-kw">
          <div class="pnl-h"><h3>Team Knowledge</h3></div>
          <div class="pnl-b help-prose">
            <p>
              Included on the <b style="color:var(--t3)">Teams plan</b> (active trial, paid, or
              complimentary) — not Free. A small store of shared decisions and digests. Owners pick
              the mode and whether agents may read via MCP. Only records marked official are fed to
              agents when MCP is on.
            </p>
            <p>
              Members can add decisions or promote a session digest. Managers and owners can mark
              something official. Turning Knowledge off stops new collection; check Knowledge for
              the exact switch.
            </p>
          </div>
        </section>

        <section class="pnl" id="help-plan">
          <div class="pnl-h"><h3>Plan and seats</h3></div>
          <div class="pnl-b help-prose">
            <p>
              First <b style="color:var(--t3)">3 seats are free forever</b> for analytics and
              budgets. <b style="color:var(--t3)">Knowledge</b> and
              <b style="color:var(--t3)">Leaderboard</b> need a Teams plan (or active trial). Beyond
              three seats, pricing is per paid seat (monthly or annual). The desktop app itself is
              not billed.
            </p>
            <p>
              Seats track active linked members. Adding seats on a paid plan is prorated
              immediately; reducing seats takes effect at the next period end. Owners manage this on
              the Plan tab and in the Stripe portal (cards, invoices, cancel).
            </p>
            <p class="hint" style="margin:0">
              Promo codes go in Stripe Checkout under Add promotion code. Billing questions:
              <a href="mailto:neel@xanom.co">neel@xanom.co</a>
            </p>
          </div>
        </section>

        <section class="pnl" id="help-leave">
          <div class="pnl-h"><h3>Leave, remove, delete</h3></div>
          <div class="pnl-b help-prose">
            <p>
              <b style="color:var(--t3)">Leave the team</b> — managers and employees can leave.
              Uploads stop right away. Past aggregates stay with the team until an owner removes the
              member or deletes the team. Owners must transfer ownership before they can leave.
            </p>
            <p>
              <b style="color:var(--t3)">Remove a member</b> — owner only. Stops their uploads and
              drops them from the roster.
            </p>
            <p>
              <b style="color:var(--t3)">Delete the team</b> — owner only, irreversible. Removes the
              team, memberships, metrics, budgets, and related records on the server.
            </p>
          </div>
        </section>

        <section class="pnl" id="help-fix">
          <div class="pnl-h"><h3>Stuck?</h3></div>
          <div class="pnl-b">
            <div class="flags">
              <div class="flag warn">
                <i data-lucide="activity"></i>
                <div>
                  <b>Overview empty / “Waiting for first sync”</b>
                  <div class="m">
                    Members must accept the invite disclosure, link the desktop app (Settings →
                    Teams), and use an agent so something exists to count. Wait a few minutes after
                    linking; uploads are not instant on every machine.
                  </div>
                </div>
              </div>
              <div class="flag warn">
                <i data-lucide="laptop"></i>
                <div>
                  <b>Member stuck on “never synced”</b>
                  <div class="m">
                    Wrong account on the Mac vs the web, desktop not linked, or app too old. Confirm
                    the same GitHub/Google identity, open Settings → Teams on the Mac, and that
                    they&apos;re still on the roster here.
                  </div>
                </div>
              </div>
              <div class="flag warn">
                <i data-lucide="git-branch"></i>
                <div>
                  <b>Leaderboard empty</b>
                  <div class="m">
                    Enable it, connect GitHub, select repos, and run a sync from Settings. Only
                    owners and managers see the tab. PR data is weekly; quiet weeks look empty for a
                    reason.
                  </div>
                </div>
              </div>
              <div class="flag warn">
                <i data-lucide="credit-card"></i>
                <div>
                  <b>Past due or locked plan</b>
                  <div class="m">
                    Owner opens Plan → Billing portal and updates the card. Free tier (≤3 seats)
                    stays free; enforcement only bites when you need more seats than the free
                    allotment allows without a working subscription.
                  </div>
                </div>
              </div>
            </div>
            <p class="hint help-foot">
              Full legal-ish wording of what ships over the wire:
              <a href="#/privacy">What your team can see</a>.
              Product mail:
              <a href="mailto:neel@xanom.co">neel@xanom.co</a>.
            </p>
          </div>
        </section>
      </div>
    </section>
  `;
}
