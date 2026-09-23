/* Owner-only modal: Teams is becoming a subscription; 30-day trial to convert. */

import { esc, html, icons } from "../dom.js";
import { api } from "../api.js";

const storageKey = (teamId) => `agmux.teams.billingIntro.${teamId}`;

function daysLeft(trialEndsAt) {
  if (!trialEndsAt) return null;
  const end = new Date(trialEndsAt).getTime();
  if (!Number.isFinite(end)) return null;
  return Math.max(0, Math.ceil((end - Date.now()) / 86_400_000));
}

function shouldShow(role, billing) {
  if (role !== "owner") return false;
  if (!billing) return false;
  // Only after BILLING_ENFORCE=true — stay silent while infrastructure is dark.
  if (!billing.enforce) return false;
  // ≤ free seats forever — no conversion nag.
  if (billing.onFreeTierize || (billing.seats ?? 0) <= (billing.freeSeats ?? 3)) return false;
  if (billing.status === "active" || billing.status === "comp") return false;
  if (billing.hasSubscription) return false;
  return true; // trialing / past trial and oversized roster
}

function isDismissed(teamId, billing) {
  try {
    const raw = localStorage.getItem(storageKey(teamId));
    if (!raw) return false;
    const days = daysLeft(billing.trialEndsAt);
    // Re-show in the last week of trial even if they dismissed earlier.
    if (days !== null && days <= 7) return false;
    return true;
  } catch {
    return false;
  }
}

function dismiss(teamId) {
  try {
    localStorage.setItem(storageKey(teamId), new Date().toISOString());
  } catch {
    /* private mode */
  }
}

/**
 * Show once per owner (until last 7 trial days). Non-blocking after dismiss.
 * @returns {Promise<void>}
 */
export async function maybeShowBillingNotice({ slug, teamId, role, billing }) {
  if (!shouldShow(role, billing)) return;
  if (!teamId) return;
  if (isDismissed(teamId, billing)) return;
  if (document.querySelector("[data-billing-notice]")) return;

  const days = daysLeft(billing.trialEndsAt);
  const dayLabel =
    days === null
      ? "30 days"
      : days === 0
        ? "today"
        : days === 1
          ? "1 day"
          : `${days} days`;
  const deadline = billing.trialEndsAt
    ? new Date(billing.trialEndsAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "30 days from now";
  const seats = billing.seats ?? 1;
  const freeSeats = billing.freeSeats ?? 3;
  const paid = billing.billableSeats ?? Math.max(0, seats - freeSeats);
  const mo = billing.estimatedMonthlyUsd ?? paid * 12;
  const yr = paid * 120;

  document.querySelector(".modal-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.setAttribute("data-billing-notice", "1");
  overlay.innerHTML = html`
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="billing-notice-title" style="max-width:460px;width:92vw">
      <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:12px">
        <div style="width:36px;height:36px;border-radius:10px;background:rgba(247,173,60,0.12);border:1px solid rgba(247,173,60,0.28);display:grid;place-items:center;flex-shrink:0">
          <i data-lucide="sparkles" style="width:18px;height:18px;color:var(--acc,#f7ad3c)"></i>
        </div>
        <div>
          <h3 id="billing-notice-title" style="margin:0 0 4px">Teams is becoming a subscription</h3>
          <p style="margin:0;color:var(--t3);font-size:12.5px;line-height:1.45">
            First ${freeSeats} members stay free. Your team stays available while you evaluate.
          </p>
        </div>
      </div>
      <div style="font-size:13px;line-height:1.55;color:var(--t2)">
        <p style="margin:0 0 10px">
          We're introducing paid <b style="color:var(--ink)">agmux Teams</b> so we can keep building
          org analytics, budgets, and leaderboards. Existing teams get a
          <b style="color:var(--ink)">free trial</b> — no card required right now.
        </p>
        <ul style="margin:0 0 12px;padding-left:1.15em;color:var(--t2)">
          <li style="margin-bottom:6px">
            <b style="color:var(--ink)">First ${freeSeats} members free forever</b>
            on every team. You have ${seats} member${seats === 1 ? "" : "s"}
            (${paid} paid seat${paid === 1 ? "" : "s"} after trial).
          </li>
          <li style="margin-bottom:6px">
            <b style="color:var(--ink)">Trial ends ${esc(deadline)}</b>
            (${esc(dayLabel)} left). Subscribe by then if you stay above ${freeSeats} members.
          </li>
          <li style="margin-bottom:6px">
            After trial: <b style="color:var(--ink)">$${mo}/mo</b>
            ($12 per seat beyond ${freeSeats}), or <b style="color:var(--ink)">$${yr}/yr</b>
            ($10/seat/mo billed yearly).
          </li>
          <li>Personal agmux on your Mac stays free. Only the shared team workspace is paid.</li>
        </ul>
        <p style="margin:0;font-size:12px;color:var(--t4)">
          Manage seats and billing anytime on the <b style="color:var(--t3)">Plan</b> tab. Cancel anytime from the Stripe portal.
        </p>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:16px">
        <button type="button" class="btn" data-billing="later">Remind me later</button>
        <a class="btn" data-billing="plan" href="#/t/${encodeURIComponent(slug)}/plan">View plan</a>
        <button type="button" class="btn" data-billing="annual">Subscribe annual</button>
        <button type="button" class="btn primary" data-billing="month">Subscribe monthly</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  icons();

  const close = () => {
    dismiss(teamId);
    overlay.remove();
  };

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector('[data-billing="later"]')?.addEventListener("click", (e) => {
    e.preventDefault();
    close();
  });
  overlay.querySelector('[data-billing="plan"]')?.addEventListener("click", () => {
    dismiss(teamId);
    overlay.remove();
  });

  const startCheckout = async (interval) => {
    try {
      const { url } = await api.billingCheckout(slug, interval);
      dismiss(teamId);
      if (url) window.location.href = url;
    } catch (err) {
      const msg = err?.message || "Couldn't start checkout.";
      // Soft fail — keep modal open so they can dismiss.
      const hint = overlay.querySelector("[data-billing-err]");
      if (hint) {
        hint.textContent = msg;
      } else {
        const p = document.createElement("p");
        p.setAttribute("data-billing-err", "1");
        p.style.cssText = "margin:10px 0 0;font-size:12px;color:#fca5a5";
        p.textContent = msg;
        overlay.querySelector(".modal")?.appendChild(p);
      }
    }
  };

  overlay.querySelector('[data-billing="month"]')?.addEventListener("click", (e) => {
    e.preventDefault();
    startCheckout("month");
  });
  overlay.querySelector('[data-billing="annual"]')?.addEventListener("click", (e) => {
    e.preventDefault();
    startCheckout("year");
  });
}
