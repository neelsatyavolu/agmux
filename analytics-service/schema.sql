-- agmux product analytics (owner.agmux.dev)
-- Anonymous install heartbeats + allowlisted event counters. No prompts,
-- paths, project names, emails, hostnames, or account linkage.

CREATE TABLE IF NOT EXISTS installs (
  install_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  first_app_version TEXT,
  last_app_version TEXT,
  os_name TEXT,
  os_version TEXT,
  arch TEXT,
  channel TEXT
);

CREATE TABLE IF NOT EXISTS daily_active (
  day TEXT NOT NULL,
  install_id TEXT NOT NULL,
  app_version TEXT,
  PRIMARY KEY (day, install_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_active_day ON daily_active(day);

CREATE TABLE IF NOT EXISTS daily_events (
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name)
);

CREATE TABLE IF NOT EXISTS daily_event_dims (
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  dim_key TEXT NOT NULL,
  dim_value TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name, dim_key, dim_value)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  github_login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_reports (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, kind TEXT NOT NULL,
  title TEXT NOT NULL, description TEXT NOT NULL, email TEXT NOT NULL,
  app_version TEXT NOT NULL, system TEXT NOT NULL, attachments TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS support_created ON support_reports(created_at DESC);
CREATE TABLE IF NOT EXISTS support_rate (key TEXT PRIMARY KEY, hour INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS support_rate_hour ON support_rate(hour);
