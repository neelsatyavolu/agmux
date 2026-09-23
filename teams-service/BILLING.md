# Teams billing (Stripe) — setup notes

**Status (2026-08-14):** Paywall **on**.  
`BILLING_ENFORCE=true` — owners see the trial/subscribe modal; Knowledge and Leaderboard follow paid-plan access. Code + D1 + webhook already live.

Catalog + webhook on **live** Stripe account **agmux** (`acct_1U2LX6BPM9ZAoURp`).

## Stripe catalog (live)

| Item | ID |
|------|-----|
| Product | `prod_V2jJpiBmBnFLsW` (`agmux Teams`) |
| Monthly seat ($12) | `price_1U2druBPM9ZAoURpB1pNWMvh` · lookup `teams_seat_monthly` |
| Annual seat ($120/yr = $10/mo) | `price_1U2ds0BPM9ZAoURpIqUCecnj` · lookup `teams_seat_annual` |
| Webhook endpoint | `we_1U2eFwBPM9ZAoURp2k8kzhbW` → `https://teams.agmux.dev/api/billing/webhook` |

Trial is **app-managed** (30 days from team create), not Stripe `trial_period_days`.  
Existing teams grandfathered with `trial_ends_at = now+30d` when migration landed.  
`ensureTeamTrial()` also lazy-backfills any team missing a trial clock on `getTeam`.  
**Owner modal** (`web/views/billing-notice.js`): shows only when `billing.enforce === true` (i.e. `BILLING_ENFORCE=true`). Silent while dark. Explains subscription switch + 30-day deadline; dismissible (re-shows in last 7 trial days). Settings Billing panel also hidden until enforce (unless already a Stripe customer).

## Env / secrets

`wrangler.toml` `[vars]` (committed):

- `BILLING_ENFORCE = "true"` ← paywall live; set `"false"` to dark it
- `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_ANNUAL`

Worker secrets:

| Secret | Status |
|--------|--------|
| `STRIPE_WEBHOOK_SECRET` | **Set** on Worker |
| `STRIPE_SECRET_KEY` | **Set** on Worker (from 1Password item `wlpan3ckloiuo62auvbh2inpmu`) |

Customer Portal config (live): `bpc_1U2hBWBPM9ZAoURpcCcAtqae` (default, active)

- Payment method update: on  
- Cancel at period end: on  
- Invoice history: on  
- Subscription update: **price only** (monthly ↔ annual); **not** quantity (seats stay app-owned)

Local: same names in `.dev.vars` (gitignored).

## Customer Portal (Dashboard once)

Settings → Billing → Customer portal:

- Payment method update, cancel, invoices  
- Do **not** allow customers to change quantity (we set seats from roster)

## D1

Already applied remote: `migrations/008_billing.sql` + grandfather trial.

## UI

Owner **Plan** tab: `#/t/{slug}/plan` — status hero (Free / trial / Teams), Free vs Teams feature compare, checkout + seat manager. Settings no longer hosts billing.

## Payment path (wired)

| Step | Mechanism |
|------|-----------|
| Checkout | `POST …/billing/checkout` → Stripe Session (`managed_payments=false`, tax code on product) |
| Webhook | `POST /api/billing/webhook` → subscription/customer → D1 `billing_status=active` |
| Confirm | Return URL `#/t/{slug}/plan?billing=success&session_id=cs_…` → `POST …/billing/confirm` (idempotent if webhook first) |
| Failed pay | `invoice.payment_failed` → `past_due` |
| Seats | Owner `POST …/billing/seats` — **add** prorated now; **remove** → `pending_seat_quantity` until period end (hourly cron + `invoice.paid`). Join auto-bumps if roster > licensed. Leave does **not** auto-drop. |
| Portal | `POST …/billing/portal` for cancel / PM / invoices |

## Flip paywall (actual release)

Turned on **2026-08-14** (`BILLING_ENFORCE=true`, Worker version `693b7932-aaa0-486e-ac36-4041bedf784d`).

To dark it again: set `BILLING_ENFORCE = "false"` and `npm run deploy`.

Optional: `comp` status for friends via D1.

## Pricing recap

- **First 3 members free forever** (Stripe graduated tiers on live prices)  
- Then **$12 / paid seat / month** or **$120 / paid seat / year** ($10/mo)  
- Checkout quantity defaults to **active roster**; owner can set a **higher** seat count to pre-buy. Join/leave later syncs Stripe quantity.  
- 30-day trial for teams **above** free size (enforced only when `BILLING_ENFORCE=true`)  
- Personal app free  
- Checkout has **Add promotion code** enabled  

Live tiered prices:  
- Monthly `price_1U2xkVBPM9ZAoURpEgMGg6ZQ`  
- Annual `price_1U2xkVBPM9ZAoURpRcR1HJfP`

### Owner QA promo (100% off, forever)

| | |
|--|--|
| Coupon | `agmux_teams_owner_test` |
| Code | `AGMUX-OWNER-E08EDC` |
| Cap | 25 redemptions |

Enter at Stripe Checkout → “Add promotion code”. Keep private.
