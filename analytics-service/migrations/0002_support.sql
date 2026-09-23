
CREATE TABLE IF NOT EXISTS support_reports (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, kind TEXT NOT NULL,
  title TEXT NOT NULL, description TEXT NOT NULL, email TEXT NOT NULL,
  app_version TEXT NOT NULL, system TEXT NOT NULL, attachments TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS support_created ON support_reports(created_at DESC);
CREATE TABLE IF NOT EXISTS support_rate (key TEXT PRIMARY KEY, hour INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS support_rate_hour ON support_rate(hour);
