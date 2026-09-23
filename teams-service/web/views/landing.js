/* 1 · Landing / sign in   —   2 · No teams yet   —   3 · Create team */

import { html, raw, toast } from "../dom.js";
import { api, signInUrl } from "../api.js";
import { emptyState } from "../components.js";

export function landing({ next }) {
  return html`
    <section class="center landing">
      <div class="tex"></div>
      <div class="glow"></div>
      <div class="col landing-col">
        <div class="landing-brand">
          <img class="mark lg" src="/favicon.png" width="32" height="32" alt="" />
          <b style="font-size:17px;font-weight:600;color:var(--ink)">agmux</b>
          <span class="pill acc">teams</span>
        </div>
        <h1 class="landing-title">
          Org analytics for <em>AI coding agents</em>
        </h1>
        <p class="landing-lead">
          Tokens, active hours, budgets, and leaderboards across Claude, Codex, and Grok —
          aggregates only. Never prompts, diffs, or source code.
        </p>
        <div class="landing-actions">
          <a class="btn lg primary" href="${signInUrl("github", next)}"
            ><i data-lucide="github"></i>Continue with GitHub</a
          >
          <a class="btn lg" href="${signInUrl("google", next)}"
            ><i data-lucide="chrome"></i>Continue with Google</a
          >
        </div>
        <div class="landing-trust">
          <span><i data-lucide="shield-check"></i>Privacy-first telemetry</span>
          <span><i data-lucide="users"></i>First 3 seats free</span>
          <span><i data-lucide="laptop"></i>macOS desktop required</span>
        </div>
        <p class="hint" style="max-width:400px;margin-top:14px">
          Members review the disclosure before joining.
          <a href="#/privacy">Read the disclosure →</a>
        </p>
      </div>
    </section>
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
