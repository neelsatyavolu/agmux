-- Display-only team account details reported by the desktop holding a lease:
-- quota windows (5-hour, weekly, ...) and the provider's plan/tier label.
ALTER TABLE provider_accounts ADD COLUMN usage_json TEXT;
ALTER TABLE provider_accounts ADD COLUMN plan TEXT;
