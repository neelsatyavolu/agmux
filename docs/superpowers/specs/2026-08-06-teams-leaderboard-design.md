# agmux Teams — optional PR leaderboard

Status: design approved (not implemented)  
Parent: `docs/superpowers/specs/2026-07-29-teams-analytics-design.md`  
Agent guide: `AGMUX_TEAMS.md`

Optional **owner-enabled** weekly leaderboard for Teams. Ranks GitHub-linked members by
how much shipping (opened PRs, tiered by size, with a merge bonus) they produce **per
token of AI usage**. Visible only to **owners and managers**, on **teams.agmux.dev** only.
Manager analytics scope does **not** filter the board.

Telemetry invariant unchanged: no prompt text, replies, diffs, file contents, absolute
paths, or secrets. PR titles are **not** stored or shown in v1.

---

## 1. Goals

| Goal | Detail |
|------|--------|
| Opt-in | Default off. Owner enables and configures. |
| Honest ranking | Score needs real PR activity **and** Teams token usage for the week. |
| GitHub as source of PRs | Team installs a **GitHub App** on an org; owner selects repos. |
| Identity | Only members with a Teams **GitHub** identity appear on the board. |
| Audience | Owners + managers read the board. Employees never see it. |
| Surface | Web SPA only (`teams.agmux.dev`). No desktop leaderboard UI in v1. |

### Non-goals (v1)

- Employee self-view of rank
- Desktop React dashboard parity
- Webhook-driven real-time updates (cron sync only; webhooks optional later)
- Full historical PR backfill beyond current + previous week
- Storing PR titles, bodies, review comments, or file paths
- Multi-org per team (one GitHub org installation per team)
- Custom week timezone UI (UTC Monday start only)
- Applying manager `manager_scope` to the leaderboard

---

## 2. Product rules

### Eligibility

- Active team members (`left_at` null) with `identities.provider = 'github'`.
- Matched to PRs by **GitHub user id** (`identities.provider_user_id`), not display name.
- Google-only accounts: can **view** the board if manager/owner; they **do not appear**
  until a GitHub identity is attached to **the same** `user_id` that owns their
  `metric_hourly` rows (see §5.1 identity link).
- Bot authors (e.g. dependabot, github-actions): **excluded** from counts.

### What counts as a PR

- **Opened** PRs in **selected** repos of the linked installation count for the week of
  `opened_at` (UTC).
- **Merged** PRs grant an additional small point bonus in the week of `merged_at` if that
  falls in the scoring week (a PR opened in week N and merged in week N+1 contributes
  open points to N and merge bonus to N+1).
- Draft / closed-without-merge: still count as **opened** (no merge bonus).
- PRs whose author is not a team member with a GitHub identity: ignored (no anonymous rows).

### Size tiers

- Size = GitHub `additions + deletions` on the PR (total diff volume).
- Default thresholds (owner-configurable, non-negative integers):

  | Tier | Default |
  |------|---------|
  | Small | `lines <= 100` |
  | Medium | `100 < lines <= 500` |
  | Large | `lines > 500` |

- Tier is stored at sync time using **current** thresholds; changing thresholds does not
  rewrite historical PR rows in v1 (document in UI: “applies to newly synced PRs”).
  Recompute-on-threshold-change is a possible follow-up.

### Score

Default weights (owner-configurable):

| Component | Default weight |
|-----------|----------------|
| Small PR (opened, attributed to open week) | 1 |
| Medium | 2 |
| Large | 4 |
| Merge bonus (per merge in week) | +0.5 |

```
points = S*w_s + M*w_m + L*w_l + merged_count * w_merge
score  = points / weekly_tokens
```

- `weekly_tokens` = sum of existing `bucketTokens` over that `team_id` + `user_id` for
  hours in the week. Definition is fixed in `aggregate.ts`:
  `tokens_in + tokens_out + tokens_cache_read + tokens_cache_write + tokens_reasoning`.
  Do not invent a partial or alternate counter.
- **Zero or missing tokens** for the week → member is **excluded from the ranked list**
  (optional side list `excludedNoTokens` for honesty).
- Higher score is better (more shipping per token).

### Week window

- Weeks start **Monday 00:00:00 UTC**, end **Sunday 23:59:59.999 UTC**.
- API accepts `week=YYYY-Www` (ISO week) or omits for “current week”.
- UI: this week / last week picker.

### Visibility and roles

| Action | Owner | Manager | Employee |
|--------|-------|---------|----------|
| Enable / disable leaderboard | yes | no | no |
| Install / unlink GitHub App | yes | no | no |
| Select repos, edit thresholds/weights | yes | no | no |
| View leaderboard | yes | yes | no |
| Manager scope filters board | n/a | **no** — full team | n/a |

Employees get **403** on leaderboard APIs and no nav entry.

---

## 3. Architecture

```
GitHub org
   │  GitHub App (installation)
   ▼
teams-service (Worker + D1)
   ├── team_leaderboard_settings
   ├── team_leaderboard_repos
   ├── github_prs  (upserted by cron sync)
   ├── score from github_prs + metric_hourly
   └── /api/teams/:id/leaderboard/*
         │
         ▼
   teams.agmux.dev SPA (owner settings + manager/owner board)
```

- Extends **existing** `teams-service` only. No change to `remote-relay`, desktop
  uploader protocol, or device pairing.
- Desktop remains the only telemetry writer; leaderboard **reads** `metric_hourly` and
  does not require new desktop upload fields.
- GitHub App uses **installation access tokens** (short-lived). Never store a personal
  PAT for org access.

### Why cron over on-demand GitHub

- Rate limits and multi-repo teams make on-demand listing too slow/fragile.
- D1 upserts keep week endpoints cheap and testable.
- Webhooks can be added later as a freshness optimization without changing the score model.

---

## 4. Data model (D1)

Additive only: update `teams-service/schema.sql` **and** a numbered file under
`teams-service/migrations/` (e.g. `004_leaderboard.sql`). Never rely on `schema.sql`
`CREATE TABLE IF NOT EXISTS` to alter live tables.

### `team_leaderboard_settings`

| Column | Type | Notes |
|--------|------|-------|
| `team_id` | TEXT PK | FK teams |
| `enabled` | INTEGER | 0/1 |
| `github_installation_id` | TEXT | null until App installed |
| `github_org_login` | TEXT | org login for display |
| `threshold_small_max` | INTEGER | default 100 |
| `threshold_medium_max` | INTEGER | default 500 |
| `weight_small` | REAL | default 1 |
| `weight_medium` | REAL | default 2 |
| `weight_large` | REAL | default 4 |
| `weight_merge` | REAL | default 0.5 |
| `last_sync_at` | TEXT | ISO, nullable |
| `last_sync_error` | TEXT | nullable, short |
| `sync_cursor` | TEXT | opaque (e.g. ISO of last PR `updated_at` window) |
| `updated_at` | TEXT | |

### `team_leaderboard_repos`

| Column | Type | Notes |
|--------|------|-------|
| `team_id` | TEXT | FK |
| `repo_full_name` | TEXT | `owner/name` |
| `added_at` | TEXT | |
| PK | `(team_id, repo_full_name)` | |

Empty set ⇒ no PRs tracked while enabled.

### `github_prs`

One row per PR per team (same GitHub PR can exist on multiple teams if rare multi-team
install; key by team).

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | uuid |
| `team_id` | TEXT | |
| `repo_full_name` | TEXT | |
| `pr_number` | INTEGER | |
| `author_github_id` | TEXT | numeric id as string |
| `author_login` | TEXT | for display join fallback |
| `opened_at` | TEXT | ISO UTC |
| `merged_at` | TEXT | null if not merged |
| `closed_at` | TEXT | nullable |
| `additions` | INTEGER | |
| `deletions` | INTEGER | |
| `size_tier` | TEXT | `small` \| `medium` \| `large` at sync |
| `is_bot` | INTEGER | 0/1 |
| `updated_at_github` | TEXT | for incremental sync |
| `synced_at` | TEXT | |

Unique: `(team_id, repo_full_name, pr_number)`.

No title, body, branch names with secrets, or patch text.

### Optional cache

v1 may compute week scores on read. If teams grow large, add
`leaderboard_week_cache (team_id, week_id, payload_json, computed_at)` later. Not required
for the first plan.

---

## 5. GitHub App

### Permissions (minimum)

- Repository metadata: read
- Pull requests: read

No contents write, no admin.

### Install flow

1. Owner clicks **Connect GitHub org** on leaderboard settings.
2. Worker returns GitHub App install URL (`state` binds `team_id` + user session).
3. Callback verifies owner role, stores `github_installation_id` + `github_org_login`.
4. Worker lists installation repositories; owner multi-selects into
   `team_leaderboard_repos`.

### Unlink / disable

- **Disable** (`enabled=0`): hide board, skip cron sync; retain settings + PR rows.
- **Unlink installation**: clear installation fields; stop sync; retain historical
  `github_prs` for past weeks until product decides otherwise (v1: retain).

### App hosting

- New GitHub App owned by the same org as Teams OAuth (`agmux-teams` or successor).
- Secrets on Worker: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`,
  `GITHUB_APP_CLIENT_SECRET` (if user-to-server needed), webhook secret only if webhooks
  added later.
- Distinct from existing **user OAuth** used for sign-in (`identities`); App install is
  for **org data**, not login.

### 5.1 Link GitHub to an existing Teams user (required for v1)

Today OAuth **creates a new `users` row** when the GitHub identity is unknown
(`auth.ts` `upsertUser`). Ranking needs the **same** `user_id` for GitHub identity and
`metric_hourly`. Without a link path, Google-first members either never rank or would
rank under a different user with zero tokens.

**In scope for v1** — minimal second-provider attach (not full account merge UI):

1. Signed-in user opens **Link GitHub** (account / settings).
2. `startOAuth` with `intent=link` (or dedicated `/api/auth/github/link`) stores state
   binding the **current session `user_id`**.
3. Callback:
   - If `(github, provider_user_id)` is free → `INSERT` into `identities` for current
     `user_id`; keep session.
   - If already bound to **current** `user_id` → no-op success.
   - If already bound to a **different** `user_id` → error page: “This GitHub account is
     already linked to another Teams user.” No auto-merge.
4. Do **not** create a second user row on the link path.
5. Unlink (optional v1): only if user still has another identity (Google); cannot leave
   a user with zero identities.

Copy must say **Link GitHub to this account**, not imply re-sign-in alone is enough.

---

## 6. Sync

### Trigger

- Cloudflare cron (hourly is enough; can share or sit near existing budget cron
  `7 * * * *` with a different minute).
- Only teams with `enabled=1` and non-null `github_installation_id` and ≥1 repo.

### Scorable window

Let `W` = current ISO week ∪ previous ISO week (UTC Monday bounds). A PR is **relevant**
if **`opened_at ∈ W` OR `merged_at ∈ W`** (merged_at non-null). This keeps older opens
that merge this week so merge bonus is correct.

### Algorithm (per team)

1. Mint installation token.
2. For each selected repo, list PRs **updated** since `sync_cursor` (or a lookback that
   covers at least the start of the previous ISO week on first run / null cursor —
   e.g. `max(14 days, start of previous week)`).
3. **Include filter before upsert:** keep the PR only if it is relevant to `W` as above
   **or** it already exists in `github_prs` for this team (update in place so state can
   move to merged). Drop brand-new PRs that are outside `W` and not already stored.
4. Upsert kept rows; set `size_tier` from additions+deletions and current thresholds.
5. Mark `is_bot` from GitHub user type / known bot logins.
6. Advance `sync_cursor`; set `last_sync_at` / clear or set `last_sync_error`.

### Failure

- Rate limit / 5xx: backoff, leave previous data; surface `last_sync_error` and
  `last_sync_at` on settings + week payload.
- Partial repo failure: best-effort other repos; record error string.

---

## 7. Scoring (pure)

Implement as a pure module (e.g. `src/leaderboard/score.ts`) with unit tests:

Inputs: PR rows for team, settings weights, week bounds, token totals by `user_id`.

For each eligible user (active member + github identity + not only bot):

1. `S/M/L` = count of non-bot PRs with `opened_at` in week, by `size_tier`.
2. `merged_count` = non-bot PRs with `merged_at` in week.
3. `points` as above.
4. If `points <= 0`, omit from ranked list (eligible but no shipping this week — not an error).
5. Else if `tokens <= 0`, put in `excludedNoTokens`.
6. Else `score = points / tokens`; sort by score desc; rank (tie-break: points desc, then display name).

---

## 8. API

Base: `/api/teams/:teamId/leaderboard/...`  
Auth: existing session / device token; role checks via `authz.ts`.

| Method | Path | Role | Purpose |
|--------|------|------|---------|
| `GET` | `/settings` | owner, manager | settings (managers: no secrets; `installationConnected` boolean + org login only) |
| `PATCH` | `/settings` | owner | enable, thresholds, weights; reject if `threshold_small_max > threshold_medium_max` or any weight &lt; 0 |
| `GET` | `/install-url` | owner | GitHub App install URL + state |
| `GET` | `/github/callback` | browser | complete install (or top-level App callback route) |
| `GET` | `/repos` | owner | available + selected repos |
| `PUT` | `/repos` | owner | replace selected repo list |
| `POST` | `/sync` | owner | optional manual sync kick (rate-limited) |
| `GET` | `/week?week=` | owner, manager | ranked board |

### `GET /week` response (sketch)

```json
{
  "week": "2026-W32",
  "weekStart": "2026-08-03T00:00:00.000Z",
  "weekEnd": "2026-08-10T00:00:00.000Z",
  "enabled": true,
  "lastSyncAt": "...",
  "rows": [
    {
      "rank": 1,
      "userId": "...",
      "displayName": "...",
      "handle": "...",
      "githubLogin": "...",
      "prSmall": 2,
      "prMedium": 1,
      "prLarge": 0,
      "prMerged": 2,
      "points": 5.0,
      "tokens": 120000,
      "score": 0.00004167
    }
  ],
  "excludedNoTokens": [],
  "memberCountEligible": 8,
  "memberCountRanked": 5
}
```

If feature disabled: managers get empty/`enabled: false` without leaking repo config
beyond what’s needed; or 404 — prefer **200 + enabled:false** so UI can show a calm empty
state. Employees always **403**.

---

## 9. Web UI

### Settings (owner)

- Toggle enable.
- Connect / disconnect GitHub org (install state, org name).
- Repo multi-select.
- Advanced: thresholds + weights (collapsed by default).
- Last sync time + error.
- Copy: members must **link GitHub to their Teams account** (or sign up with GitHub) to
  appear; linking is required for Google-first accounts so tokens and PRs share one user.

### Leaderboard (owner + manager)

- Nav item **Leaderboard** only when `enabled` (or always for owners with setup CTA).
- Table: rank, person, S / M / L, merged, points, tokens, score.
- Week toggle: this / last.
- Empty states: not enabled; no installation; no repos; no GitHub-linked members; no
  ranked rows this week.
- No employee entry points.

### Desktop

No leaderboard UI in v1. Optional later: same APIs from React Teams views.

---

## 10. Authz matrix (tests)

| Case | Expected |
|------|----------|
| Employee GET week | 403 |
| Manager GET week, feature on | 200, all GitHub-linked members (ignore manager_scope) |
| Manager PATCH settings | 403 |
| Manager GET settings | 200; no private keys; install as boolean + org login |
| Manager POST sync | 403 |
| Owner POST sync | 200 or 429 if rate-limited |
| Owner enable without install | allowed; week empty until install + repos + sync |
| Owner disable | board hidden/enabled false; PR rows retained |
| Owner unlink installation | installation cleared; historical PR rows retained |
| Link GitHub while signed in | identity on same user_id; no second user |
| Link GitHub already on other user | 409/error; no merge |
| Unauthenticated | 401 |

---

## 11. Privacy & disclosure

- Leaderboard is org-internal manager tooling; still no prompt content.
- Do not store PR titles in v1.
- Disclosure copy (`disclosure.js` / `disclosureCopy.ts`): if product claims need
  updating for “PR counts from linked GitHub org,” update **both** SHARED lists in
  the same change (existing Teams rule).

Suggested SHARED addition (word-identical in `teams-service/web/disclosure.js` and
`src/components/teams/disclosureCopy.ts` — both long **and** short lists as applicable):

- “Counts of pull requests (size tier by lines changed) from GitHub repositories your
  team owner selected, when Leaderboard is enabled.”

NEVER list unchanged (still no source code, prompts, etc.).

Config changes (enable/disable, install/unlink, repo set, weight/threshold changes)
should write `audit_log` rows consistent with existing Teams security events.

---

## 12. Testing plan

| Layer | Coverage |
|-------|----------|
| Unit | size tier boundaries; points; score; zero-token exclude; week bounds (UTC Mon); merge week vs open week split |
| Authz | employee/manager/owner on each route; manager sees full team |
| Sync | mock GitHub list → upsert idempotent; bot filter; repo filter |
| API | week payload shape; disabled feature behavior |
| Local | `teams-service` vitest + optional dev seed with fake PRs |

No requirement for live GitHub in CI; mock App API.

---

## 13. Rollout

1. Migration `004_leaderboard.sql` on local + remote D1 (manual, additive).
2. Ship Worker routes + SPA UI behind feature (settings exist; board empty until owner
   enables).
3. Create/register GitHub App; set Worker secrets.
4. Document in `AGMUX_TEAMS.md` + `teams-service/README.md` (install App, secrets, cron).
5. Owner enables for pilot team.

---

## 14. Open follow-ups (not v1)

- Webhooks for faster PR sync
- Re-tier all PRs when thresholds change
- Desktop manager view
- Multi-org installations
- Configurable week timezone
- PR detail drill-down (still without titles if privacy prefers)

---

## 15. Decisions log

| Decision | Choice |
|----------|--------|
| PR inclusion | Opened counts; merged gets small bonus |
| Size | additions + deletions; S/M/L thresholds |
| Score | weighted points ÷ weekly tokens |
| Zero tokens | exclude from rank |
| GitHub access | GitHub App install on org |
| Who ranks | GitHub-linked members only |
| Who sees | owners + managers; full team (no manager_scope) |
| Surface | web only |
| Week | UTC Monday ISO week |
| Sync | scheduled; backfill current + previous week |
| Titles | not stored |
| Google-first members | Must **link** GitHub to same user_id (§5.1); no silent second user |
| Sync include | PR kept if opened_at or merged_at in current∪previous week |
| Token denominator | Existing `bucketTokens` only |
