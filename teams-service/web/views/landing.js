/* 1 · Landing / sign in   —   2 · No teams yet   —   3 · Create team */

import { html, raw, toast } from "../dom.js";
import { api, signInUrl } from "../api.js";
import { brandMark, emptyState } from "../components.js";
import { disclosureBlock } from "../disclosure.js";

export function landing({ next }) {
  return html`
    <div class="landing">
      <header class="landing-nav">
        <nav class="landing-wrap" aria-label="Main">
          <a class="landing-brand" href="https://agmux.dev">
            ${raw(brandMark())}
            <b>agmux</b>
            <span class="brand-sub">Teams</span>
          </a>
          <div class="landing-nav-links">
            <a href="#/privacy">What gets shared</a>
            <a class="hide-sm" href="https://agmux.dev">agmux.dev</a>
          </div>
        </nav>
      </header>

      <div>
        <section class="landing-wrap landing-hero">
          <h1 class="landing-title">See how your team uses AI coding agents.</h1>
          <p class="landing-lead">
            Tokens, active hours, budgets and leaderboards across Claude, Codex and Grok, from
            sessions your team runs in agmux. Aggregates only. Never prompts, diffs or source code.
          </p>
          <div class="landing-actions">
            <a class="btn lg primary" href="${signInUrl("github", next)}"
              ><i data-lucide="github"></i>Continue with GitHub</a
            >
            <a class="btn lg" href="${signInUrl("google", next)}"
              ><i data-lucide="chrome"></i>Continue with Google</a
            >
          </div>
          <p class="landing-fine">
            First 3 seats are free. Members use the
            <a href="https://agmux.dev">agmux Mac app</a> and review the
            <a href="#/privacy">disclosure</a> before joining.
          </p>
        </section>

        <section class="landing-section">
          <div class="landing-wrap">
            <h2 class="landing-h2">Built for the people paying for the tokens.</h2>
            <ul class="landing-trio">
              <li>
                <b>Know where the spend goes</b>
                <span>Token and cost totals by person, provider, model and project, with budgets and a forecast.</span>
              </li>
              <li>
                <b>See how agents work</b>
                <span>Active hours, tool calls, files changed and how long agents waited for approval.</span>
              </li>
              <li>
                <b>Set the rules once</b>
                <span>Roles, groups and restrictions on the agents, models and modes your team can use.</span>
              </li>
            </ul>
          </div>
        </section>

        <section class="landing-section">
          <div class="landing-wrap">
            <h2 class="landing-h2">Every member sees exactly what is shared.</h2>
            <p class="landing-body">
              Members accept this list before their usage appears. It is the same list the Mac app
              shows.
            </p>
            ${raw(
              disclosureBlock({ short: true }).replace('class="dsc"', 'class="dsc landing-dsc"'),
            )}
          </div>
        </section>
      </div>

      <footer class="landing-foot">
        <div class="landing-wrap">
          <span>agmux Teams</span>
          <a href="https://agmux.dev">agmux.dev</a>
          <a href="#/privacy">Disclosure</a>
          <a href="https://github.com/neelsatyavolu/agmux">GitHub</a>
        </div>
      </footer>
    </div>
  `;
}

export function noTeams() {
  return html`
    <section class="center">
      <div class="col">
        <div class="pnl">
          ${raw(
            emptyState({
              icon: "users",
              title: "No teams yet",
              body: "Create a team to invite engineers and see aggregated agent usage. You'll be the owner.",
              actions: `<a class="btn primary" href="#/teams/new"><i data-lucide="plus"></i>Create team</a>`,
            }),
          )}
        </div>
        <p class="hint" style="text-align:center">
          Already invited? Open the <span class="mono">teams.agmux.dev/join/…</span> link your owner
          sent you.
        </p>
      </div>
    </section>
  `;
}

export function createTeam() {
  return html`
    <section class="center">
      <div
        class="col"
        style="max-width:900px;display:grid;grid-template-columns:1fr 320px;gap:14px;align-items:start"
      >
        <div class="pnl">
          <div class="pnl-h"><h3>Create team</h3></div>
          <div class="pnl-b" style="display:flex;flex-direction:column;gap:14px">
            <div>
              <label class="lbl" for="tn">Team name</label>
              <input class="input" id="tn" placeholder="Helios Platform" autocomplete="off" />
              <p class="hint" style="margin:6px 0 0">
                Shown to every member. Rename any time in settings.
              </p>
            </div>
            <label class="chk"
              ><input type="checkbox" id="createAck" /><span
                >I understand members must accept the metrics disclosure before their usage appears
                here, and that telemetry is required while they are on the team.</span
              ></label
            >
            <div style="display:flex;gap:9px">
              <button class="btn primary" id="createBtn" disabled>Create team</button>
              <a class="btn" href="#/teams">Cancel</a>
            </div>
          </div>
        </div>
        <div class="pnl">
          <div class="pnl-h"><h3>What members will see</h3></div>
          <div class="pnl-b" style="display:flex;flex-direction:column;gap:10px">
            <p class="hint" style="margin:0">
              On join, every invitee reads the same disclosure you do.
            </p>
            <div class="flag ok">
              <i data-lucide="shield-check"></i>
              <div>
                <b>Aggregates only</b>
                <div class="m">
                  Token counts, active-time buckets, sessions, concurrency, provider/model, project
                  basenames.
                </div>
              </div>
            </div>
            <div class="flag err">
              <i data-lucide="eye-off"></i>
              <div>
                <b>Never collected</b>
                <div class="m">
                  Prompts, agent replies, diffs, code, absolute paths, secrets.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}

/** Wiring for the create-team form: the ack gate is not decorative. */
export function bindCreateTeam(root, navigate) {
  const name = root.querySelector("#tn");
  const ack = root.querySelector("#createAck");
  const btn = root.querySelector("#createBtn");
  if (!name || !ack || !btn) return;

  const sync = () => {
    btn.disabled = !ack.checked || !name.value.trim();
  };
  name.addEventListener("input", sync);
  ack.addEventListener("change", sync);

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const { team } = await api.createTeam(name.value.trim());
      navigate(`#/t/${team.slug}`);
    } catch (err) {
      toast(err.message, "error");
      sync();
    }
  });
}
