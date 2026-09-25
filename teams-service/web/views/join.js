/* 8 · Join invite + disclosure. Three steps: sign in → disclosure → done.
   The disclosure step is required and the accept button stays disabled until
   the checkbox is ticked — there is no path into a team that skips it. */

import { fmtDate, html, raw } from "../dom.js";
import { signInUrl } from "../api.js";
import { disclosureBlock } from "../disclosure.js";
import { avatar, brandMark, emptyState } from "../components.js";

const shell = (step, body) => html`
  <section class="center">
    <div class="col" style="max-width:600px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div class="landing-brand">
          ${raw(brandMark())}
          <b>agmux</b>
          <span class="brand-sub">Teams</span>
        </div>
        <div class="steps">
          <button class="${step === "signin" ? "on" : ""}" disabled>1 Sign in</button>
          <button class="${step === "disclose" ? "on" : ""}" disabled>2 Disclosure</button>
          <button class="${step === "done" ? "on" : ""}" disabled>3 Done</button>
        </div>
      </div>
      ${raw(body)}
    </div>
  </section>
`;

/** Expired / revoked / used-up all land here with the real reason. */
export function joinDead(preview) {
  const reason =
    preview.state === "expired"
      ? `This link expired on ${fmtDate(preview.expiresAt)}.`
      : preview.state === "revoked"
        ? "This link was revoked by the team owner."
        : "This link has been used up.";
  return shell(
    "signin",
    html`<div class="pnl">
      <div class="empty">
        <div
          class="ic"
          style="color:var(--red-text);border-color:var(--red-line);background:var(--red-soft)"
        >
          <i data-lucide="link-2-off"></i>
        </div>
        <h3>Invite expired</h3>
        <p>${reason} Ask the team owner for a new one — links are single-team and time-limited on purpose.</p>
      </div>
    </div>`,
  );
}

export function joinUnknown() {
  return shell(
    "signin",
    html`<div class="pnl">
      ${raw(
        emptyState({
          icon: "link-2-off",
          title: "That link isn't valid",
          body: "Double-check the URL, or ask the team owner to send you a fresh invite.",
        }),
      )}
    </div>`,
  );
}

export function joinSignIn(preview, token) {
  const inviter = preview.inviter;
  return shell(
    "signin",
    html`<div class="pnl">
      <div class="pnl-b" style="display:flex;flex-direction:column;gap:13px">
        <div style="display:flex;align-items:center;gap:11px">
          ${raw(
            avatar(
              inviter?.display_name ?? "?",
              inviter?.avatar_color ?? "#60a5fa",
              34,
              inviter?.avatar_url,
            ),
          )}
          <div>
            <div class="t">
              ${inviter?.display_name ?? "Someone"} invited you to ${preview.team.name}
            </div>
            <div class="d" style="margin-top:3px">
              ${preview.memberCount} ${preview.memberCount === 1 ? "member" : "members"}${
                preview.ownerName ? ` · owner ${preview.ownerName}` : ""
              }
            </div>
          </div>
        </div>
        <hr class="hr" />
        <p class="hint" style="margin:0">
          Sign in to continue. Next you'll see exactly what your agent usage shares with this team —
          you must accept it to join.
        </p>
        <div style="display:flex;gap:9px">
          <a class="btn lg primary" href="${signInUrl("github", `/join/${token}`)}"
            ><i data-lucide="github"></i>Continue with GitHub</a
          >
          <a class="btn lg" href="${signInUrl("google", `/join/${token}`)}"
            ><i data-lucide="chrome"></i>Continue with Google</a
          >
        </div>
      </div>
    </div>`,
  );
}

export function joinDisclose(preview) {
  return shell(
    "disclose",
    html`<div class="pnl">
      <div class="pnl-h">
        <i data-lucide="shield" style="color:var(--accent)"></i>
        <h3>Before you join</h3>
        <div class="sp"></div>
        <span class="sub">required</span>
      </div>
      <div class="pnl-b" style="display:flex;flex-direction:column;gap:13px">
        <p class="hint" style="margin:0">
          Joining ${preview.team.name} turns on metrics upload from your agmux desktop app. It stays
          on while you're a member. Here is the complete list, in plain language.
        </p>
        ${raw(
          disclosureBlock({
            sharedTitle: "Shared with the team owner and managers",
            neverTitle: "Never collected, never shown to anyone",
            short: true,
            single: true,
          }),
        )}
        <label class="chk"
          ><input type="checkbox" id="acc" /><span
            >I understand what is collected and shared with this team's owner and managers, and that
            upload stays on while I'm a member. I can leave the team at any time from the desktop
            app.</span
          ></label
        >
        <div style="display:flex;gap:9px;align-items:center">
          <button class="btn lg primary" id="joinBtn" disabled>Accept &amp; join team</button>
          <a class="btn lg" href="#/teams">Decline</a>
          <div class="sp" style="flex:1"></div>
          <a href="#/privacy" style="font-size:12px">Full privacy page →</a>
        </div>
      </div>
    </div>`,
  );
}

export function joinDone(team) {
  return shell(
    "done",
    html`<div class="pnl">
      <div class="empty">
        <div
          class="ic"
          style="color:var(--green-text);border-color:var(--green-line);background:var(--green-soft)"
        >
          <i data-lucide="check"></i>
        </div>
        <h3>You're in — ${team.name}</h3>
        <p>
          Open the agmux desktop app to start sync. Your first upload usually lands within a few
          minutes of your next agent session.
        </p>
        <div style="display:flex;gap:9px">
          <a class="btn primary" href="agmux://teams"
            ><i data-lucide="external-link"></i>Open agmux</a
          >
          <a class="btn" href="#/t/${encodeURIComponent(team.slug)}/me">View your metrics</a>
        </div>
        <p class="hint" style="margin-top:2px">
          Don't have the app? <a href="https://agmux.dev">Download for macOS</a> ·
          <span class="mono">brew install --cask agmux</span>
        </p>
      </div>
    </div>`,
  );
}
