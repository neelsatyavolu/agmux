-- NenuAI complexity points on synced PRs (Project Size field → points).
-- Additive only. Apply: wrangler d1 execute agmux-teams --local|--remote --file=./migrations/006_complexity_points.sql

ALTER TABLE github_prs ADD COLUMN complexity_points INTEGER;
