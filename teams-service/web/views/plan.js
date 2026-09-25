/* Plan tab — subscription status, free vs paid features, seat management. */

import { esc, html, raw } from "../dom.js";

const FREE_FEATURES = [
  { icon: "layout-dashboard", title: "Team overview", body: "Cost, tokens, active time, heatmaps across the roster." },
  { icon: "users", title: "Up to 3 members", body: "Owner, managers, and employees with role-based access." },
  { icon: "link", title: "Invite links", body: "Share a join link with disclosure before metrics upload." },
  { icon: "shield", title: "Privacy-first telemetry", body: "Aggregates only — never prompts, diffs, paths, or secrets." },
  { icon: "gauge", title: "Budgets & alerts", body: "Monthly spend caps with once-per-threshold alerts." },
  { icon: "download", title: "CSV export", body: "Download team metrics for the range you pick." },
];

const PAID_FEATURES = [
  { icon: "book-open", title: "Team Knowledge", body: "Shared decisions and session digests. Agents read official records when you allow MCP." },
  { icon: "trophy", title: "PR Leaderboard", body: "Weekly cost and GitHub PR ranking for owners and managers." },
  { icon: "infinity", title: "Unlimited members", body: "Scale past three seats. First three always free." },
  { icon: "sliders-horizontal", title: "Licensed seat control", body: "Add seats anytime (prorated). Reduce at next period." },
  { icon: "credit-card", title: "Self-serve billing", body: "Stripe Checkout, invoices, and Customer Portal." },
  { icon: "building-2", title: "Org-ready ops", body: "Groups, manager scope, audit log, CSV export at scale." },
  { icon: "badge-percent", title: "Annual savings", body: "$10/seat/mo when billed yearly ($120/seat/yr)." },
  { icon: "headphones", title: "Priority path", body: "Billing and account issues go straight to the agmux team." },
];

function daysLeft(trialEndsAt) {
  if (!trialEndsAt) return null;
  const end = new Date(trialEndsAt).getTime();
  if (!Number.isFinite(end)) return null;
  return Math.max(0, Math.ceil((end - Date.now()) / 86_400_000));
}

function planStatus(billing) {
  if (!billing) return { key: "unknown", label: "Unknown", tone: "" };
  if (billing.status === "comp") return { key: "comp", label: "Complimentary", tone: "ok" };
  if (billing.status === "active" || billing.hasSubscription)
    return { key: "paid", label: "Teams", tone: "acc" };
  if (billing.status === "past_due") return { key: "past_due", label: "Past due", tone: "warn" };
  // Free analytics while the roster fits — unless paid extras are locked
  // (Knowledge / Leaderboard), in which case owners need a checkout path.
  if (
    (billing.onFreeTierize || (billing.seats ?? 0) <= (billing.freeSeats ?? 3)) &&
    billing.paidFeatures !== "locked"
  ) {
    const trialDays = daysLeft(billing.trialEndsAt);
    if (trialDays != null && trialDays > 0) {
      return { key: "trial", label: "Free trial", tone: "warn" };
    }
    return { key: "free", label: "Free", tone: "ok" };
  }
  const days = daysLeft(billing.trialEndsAt);
  if (days != null && days > 0) return { key: "trial", label: "Free trial", tone: "warn" };
  if (billing.access === "read_only") return { key: "grace", label: "Trial ended", tone: "warn" };
  if (billing.access === "locked") return { key: "locked", label: "Locked", tone: "err" };
  return { key: "trial", label: "Trial", tone: "warn" };
}

function featureList(items) {
  return items
    .map(
      (f) => `
    <li class="plan-feat">
      <span class="plan-feat-ico"><i data-lucide="${esc(f.icon)}"></i></span>
      <span>
        <span class="plan-feat-t">${esc(f.title)}</span>
        <span class="plan-feat-d">${esc(f.body)}</span>
      </span>
    </li>`,
    )
    .join("");
}

/**
 * @param {{ team, role, billing, prices, membersCount }} opts
 */
export function teamPlan({ team, role, billing = null, prices = null, membersCount = 0 }) {
  const isOwner = role === "owner";
  const b = billing ?? {};
  const seats = b.seats ?? membersCount ?? 1;
  const freeSeats = b.freeSeats ?? prices?.freeSeats ?? 3;
  const licensed = b.seatQuantity ?? seats;
  const pending = b.pendingSeatQuantity;
  const paid = b.billableSeats ?? Math.max(0, licensed - freeSeats);
  const monthly = prices?.monthlyUsd ?? 12;
  const annual = prices?.annualUsdPerYear ?? 120;
  const moTotal = b.estimatedMonthlyUsd ?? paid * monthly;
  const status = planStatus(b);
  const days = daysLeft(b.trialEndsAt);
  const periodEnd = b.periodEnd
    ? new Date(b.periodEnd).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;
  const trialEnd = b.trialEndsAt
    ? new Date(b.trialEndsAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;

  const needSubscribe =
    isOwner &&
    status.key !== "paid" &&
    status.key !== "comp" &&
    status.key !== "past_due" &&
    (status.key !== "free" || b.paidFeatures === "locked");

  const showSeatMgr =
    isOwner && (b.hasSubscription || status.key === "paid" || status.key === "past_due");

  const checkoutSeats = Math.max(seats, freeSeats + 1);
  const checkoutPaid = Math.max(0, checkoutSeats - freeSeats);
  const checkoutMo = checkoutPaid * monthly;
  const checkoutYr = checkoutPaid * annual;

  const heroMeta = (() => {
    if (status.key === "paid") {
      return `${seats} member${seats === 1 ? "" : "s"} · ${licensed} licensed · ${paid} paid`;
    }
    if (status.key === "past_due") {
      return "Payment past due — update your card in the billing portal";
    }
    if (status.key === "free") {
      return `${seats} of ${freeSeats} free seats used · forever free at this size`;
    }
    if (status.key === "trial") {
      return days != null
        ? `Trial ends ${trialEnd ?? "soon"} · ${days} day${days === 1 ? "" : "s"} left`
        : "Trial active";
    }
    if (status.key === "grace" || status.key === "locked") {
      return "Subscribe to keep multi-seat uploads and invites";
    }
    if (status.key === "comp") return "Full access · not billed";
    return b.message ?? "";
  })();

  const heroTitle = (() => {
    switch (status.key) {
      case "paid":
        return "Your team is on Teams";
      case "free":
        return "Your team is on Free";
      case "comp":
        return "Complimentary access";
      case "past_due":
        return "Payment needs attention";
      case "grace":
      case "locked":
        return "Trial ended";
      case "trial":
        return "You're on a free trial";
      default:
        return "Your plan";
    }
  })();

  const subscribeBlock = needSubscribe
    ? `<div class="plan-cta-row">
        <label class="plan-seat-field">
          <span>Seats at checkout</span>
          <input class="input" type="number" id="billing-seats" min="${seats}" max="500"
            value="${checkoutSeats}"
            title="At least current members (${seats}). First ${freeSeats} free." />
        </label>
        <button type="button" class="btn lg primary" data-act="billing-checkout-month">
          Subscribe monthly · $${checkoutMo}/mo
        </button>
        <button type="button" class="btn lg" data-act="billing-checkout-year">
          Annual · $${checkoutYr}/yr
        </button>
      </div>
      <p class="hint plan-promo-hint">First ${freeSeats} seats free on every plan. Have a code? Enter it on Stripe Checkout under <b>Add promotion code</b>.</p>`
    : "";

  const seatMgrBlock = showSeatMgr
    ? `<div class="plan-seats pnl">
        <div class="pnl-h">
          <h3>Licensed seats</h3>
          <div class="sp"></div>
          <span class="sub">${licensed} current${pending != null && pending < licensed ? ` · reducing to ${pending}` : ""}</span>
        </div>
        <div class="pnl-b">
          <div class="plan-cta-row">
            <label class="plan-seat-field">
              <span>Seats</span>
              <input class="input" type="number" id="billing-seats-live" min="${seats}" max="500"
                value="${pending ?? licensed}"
                title="Min = active members (${seats})" />
            </label>
            <button type="button" class="btn primary" data-act="billing-seats-update">Update seats</button>
            ${
              b.hasCustomer
                ? `<button type="button" class="btn" data-act="billing-portal"><i data-lucide="external-link"></i>Billing portal</button>`
                : ""
            }
          </div>
          <p class="hint" style="margin:10px 0 0">
            <b style="color:var(--t3)">Add seats</b> — billed immediately (prorated).
            <b style="color:var(--t3)">Remove seats</b> — keep access until
            ${periodEnd ? esc(periodEnd) : "the next billing date"}, then the lower count applies.
          </p>
          ${
            pending != null && pending < licensed
              ? `<p class="banner warn" style="margin-top:12px"><i data-lucide="calendar-clock"></i><div>Scheduled reduction to <b>${pending}</b> seat${pending === 1 ? "" : "s"}${periodEnd ? ` on ${esc(periodEnd)}` : ""}.</div></p>`
              : ""
          }
        </div>
      </div>`
    : "";

  const portalOnly =
    isOwner && b.hasCustomer && !showSeatMgr
      ? `<button type="button" class="btn" data-act="billing-portal"><i data-lucide="external-link"></i>Billing portal</button>`
      : "";

  return html`
    <section class="page plan-page">
      <div class="phead plan-phead">
        <div>
          <p class="eyeb">Billing</p>
          <h1>Plan</h1>
          <div class="meta">
            <span>${esc(team.name)}</span>
            <span style="color:var(--t5)">·</span>
            <span>First ${freeSeats} members free · then $${monthly}/seat/mo</span>
          </div>
        </div>
        <div class="sp"></div>
        ${!isOwner ? raw(`<span class="pill">View only · owner manages billing</span>`) : ""}
      </div>

      <div class="plan-hero">
        <div class="plan-hero-main">
          <div class="plan-hero-top">
            <span class="pill ${status.tone === "acc" ? "acc" : status.tone === "ok" ? "ok" : status.tone === "warn" ? "warn" : status.tone === "err" ? "err" : ""}">${esc(status.label)}</span>
            ${
              status.key === "trial" || status.key === "trialing"
                ? raw(`<span class="plan-countdown">${days ?? "—"}d left</span>`)
                : ""
            }
          </div>
          <h2 class="plan-hero-title">${heroTitle}</h2>
          <p class="plan-hero-sub">${esc(heroMeta)}</p>
          ${
            status.key === "paid" || status.key === "past_due"
              ? raw(
                  `<dl class="plan-kpis">
                    <div><dt>Members</dt><dd>${seats}</dd></div>
                    <div><dt>Licensed</dt><dd>${licensed}</dd></div>
                    <div><dt>Paid seats</dt><dd>${paid}</dd></div>
                    <div><dt>Est. monthly</dt><dd>$${moTotal}</dd></div>
                    ${periodEnd ? `<div><dt>Renews</dt><dd style="font-size:18px">${esc(periodEnd)}</dd></div>` : ""}
                  </dl>`,
                )
              : status.key === "free"
                ? raw(
                    `<dl class="plan-kpis">
                      <div><dt>Members</dt><dd>${seats}</dd></div>
                      <div><dt>Free seats</dt><dd>${freeSeats}</dd></div>
                      <div><dt>Monthly</dt><dd>$0</dd></div>
                    </dl>`,
                  )
                : status.key === "trial"
                  ? raw(
                      `<dl class="plan-kpis">
                        <div><dt>Members</dt><dd>${seats}</dd></div>
                        <div><dt>Days left</dt><dd>${days ?? "—"}</dd></div>
                        <div><dt>After trial</dt><dd>$${moTotal}/mo</dd></div>
                      </dl>`,
                    )
                  : ""
          }
          ${raw(subscribeBlock)}
          ${raw(portalOnly ? `<div class="plan-cta-row" style="margin-top:14px">${portalOnly}</div>` : "")}
        </div>
        <aside class="plan-hero-aside">
          <p class="eyeb">At a glance</p>
          <ul class="plan-glance">
            <li><i data-lucide="check"></i> First ${freeSeats} members always free</li>
            <li><i data-lucide="check"></i> Knowledge + Leaderboard on Teams plan</li>
            <li><i data-lucide="check"></i> Aggregates only — no prompt text</li>
            <li><i data-lucide="check"></i> Desktop app remains free forever</li>
            <li><i data-lucide="check"></i> Cancel anytime in the billing portal</li>
          </ul>
          ${
            b.message && status.key !== "free"
              ? raw(`<p class="hint" style="margin:14px 0 0">${esc(b.message)}</p>`)
              : ""
          }
        </aside>
      </div>

      ${raw(seatMgrBlock)}

      <div class="plan-compare">
        <article class="plan-tier">
          <header class="plan-tier-h">
            <p class="eyeb">Included</p>
            <h3>Free</h3>
            <p class="plan-price"><span class="plan-price-num">$0</span><span class="plan-price-unit">/ forever</span></p>
            <p class="hint">Up to ${freeSeats} members. Analytics and budgets — not Knowledge or Leaderboard.</p>
          </header>
          <ul class="plan-feat-list">${raw(featureList(FREE_FEATURES))}</ul>
        </article>
        <article class="plan-tier plan-tier-paid">
          <header class="plan-tier-h">
            <p class="eyeb">Scale</p>
            <h3>Teams</h3>
            <p class="plan-price"><span class="plan-price-num">$${monthly}</span><span class="plan-price-unit">/ paid seat / mo</span></p>
            <p class="hint">Or $${annual}/seat/yr. Unlocks Knowledge, Leaderboard, and extra seats (first ${freeSeats} free).</p>
          </header>
          <ul class="plan-feat-list">${raw(featureList(PAID_FEATURES))}</ul>
        </article>
      </div>

      <div class="pnl plan-footnote">
        <div class="pnl-b hint" style="margin:0">
          Pricing is per <b style="color:var(--t3)">active linked member</b> beyond the free allotment.
          Personal usage in the agmux desktop app is never billed. Questions?
          <a href="mailto:neel@xanom.co">neel@xanom.co</a>
        </div>
      </div>
    </section>
  `;
}
