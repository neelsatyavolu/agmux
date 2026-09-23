-- Teams billing (Stripe). Additive only — apply once per DB.
-- App-managed 30-day trial; subscription after convert.
-- Enforcement is gated by env BILLING_ENFORCE=true (default off until release).

ALTER TABLE teams ADD COLUMN trial_ends_at TEXT;
ALTER TABLE teams ADD COLUMN billing_status TEXT NOT NULL DEFAULT 'trialing';
ALTER TABLE teams ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE teams ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE teams ADD COLUMN stripe_price_id TEXT;
ALTER TABLE teams ADD COLUMN seat_quantity INTEGER;
ALTER TABLE teams ADD COLUMN billing_period_end TEXT;
ALTER TABLE teams ADD COLUMN billing_email TEXT;

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    received_at TEXT NOT NULL
);
