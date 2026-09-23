# agmux Teams

Org-level analytics for AI coding agents. Cloudflare Workers + D1, entirely
separate from `remote-relay` — no shared bindings, and device pairing is
untouched.

Design: `agmux Teams.html` in the Xanom Design System project.
Spec: `docs/superpowers/specs/2026-07-29-teams-analytics-design.md`.

---

## Try it locally (no Cloudflare account, no OAuth, no second person)

```bash
cd teams-service
npm install
npx wrangler d1 create agmux-teams --local   # one-off, creates the local DB
npm run db:local                             # apply schema.sql
npm run dev                                  # http://localhost:8787
```

Open <http://localhost:8787>. A **dev toolbar** appears along the bottom:

1. **Sign in as You** — fake session, no GitHub/Google round-trip.
2. **Seed demo team** — creates *Helios Platform* with 8 members and ~1,900
   hourly buckets across 90 days.
3. **View as** `owner` / `manager` / `employee` — flips *your own* role on the
   demo team so one person can see all three dashboards.

That's it. Every range (7d/30d/90d), every chart, and every honest-state case is
populated:

| You'll see | Because |
|---|---|
| A populated leaderboard | 7 members with different intensities |
| `waiting for first sync` | Riley Chen joined but never uploads |
| An amber stale pill | Jules' last upload is 2 days old |
| A green healthy pill | Yours is 6 minutes old |
| After-hours flag | Dani works ~27% outside 08:00–18:00 |
| Auto-upload | the desktop flushes aggregates every 2 minutes |
| Idle-days flag | Everyone takes days off; weekends are mostly empty |
| A multi-provider mix | Claude / Codex / Grok split across the team |
| A broken trend line | Idle days render as gaps, never interpolated |

**Reset all** wipes the local database so you can start over.

### Safety

The dev routes require **two** signals, and `wrangler deploy` supplies neither:

1. `DEV_AUTH=true` — not present in wrangler.toml's `[vars]`, only in the
   `dev` npm script.
2. `APP_ORIGIN` pointing at a local origin.

If either is missing the routes return 404 — invisible, not merely forbidden.
`test/dev.test.ts` pins both, including `localhost.evil.example`.

The request's own hostname is deliberately **not** used: once `routes` names a
custom domain, `wrangler dev` simulates that hostname locally, so a
request-host check would report `teams.agmux.dev` on your own machine and
switch dev mode off exactly where it is needed.

### Testing the desktop app against local

```bash
AGMUX_TEAMS_URL=http://localhost:8787 npx tauri dev
```

Then **Settings → Teams → Sign in**. The desktop opens
`localhost:8787/link?code=…`; click **Sign in as You** in the dev toolbar and the
app picks up its device token within a couple of seconds — the normal device-link
handshake, just with the OAuth step swapped out.

If you'd rather skip the browser entirely, the toolbar's **Desktop token** button
copies a bearer token straight to your clipboard (also logged to the browser
console).

---

## Production

Already provisioned and live:

| | |
|---|---|
| Worker | `agmux-teams` |
| URLs | <https://teams.agmux.dev> · <https://agmux-teams.xanom.workers.dev> |
| D1 | `agmux-teams` (`31b8a340-eb82-41f1-b335-6bf82e097512`), schema applied |
| DNS + TLS | provisioned by `custom_domain = true` on deploy |

**Accounts rollout, 2026-09-21:** production has migration 013 and the provider-account
encryption key, but intentionally retains the legacy policy implementation and web
assets. Migration 012 is not deployed. A plain `npm run deploy` from this checkout
would introduce policy queries that its production schema cannot serve. See
[the deployment compatibility boundary](../AGMUX_TEAMS.md#team-provider-account-pool-separate-credential-plane-deployed-2026-09-21)
for the tested source baseline and rollback version. Complete a separate, compatible
Restrictions rollout before deploying the full checkout.

The production configuration never sets `DEV_AUTH`, so dev routes stay disabled.

### Remaining: OAuth credentials

Sign-in returns `503 "github sign-in isn't configured on this server"` until
these are set. Create the apps, then:

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Callback URLs:

- GitHub — <https://github.com/settings/developers> → New OAuth App →
  `https://teams.agmux.dev/api/auth/github/callback`
- Google — <https://console.cloud.google.com/apis/credentials> → OAuth client ID
  (Web) → `https://teams.agmux.dev/api/auth/google/callback`

No secrets are needed for local dev.

---

## Layout

```
src/
  index.ts       router; /api/* here, everything else is the SPA
  authz.ts       role → capability matrix, checked on every route
  aggregate.ts   pure: hourly buckets → dashboard shapes
  metrics.ts     ingest; idempotent, replace-not-add
  dev.ts         local dev mode + demo seed (localhost-gated)
  routes/        auth, teams, members, invites, dashboard, metrics, dev
web/             the SPA — vanilla, ports the design 1:1
test/            vitest; D1 shim backed by node:sqlite
```

## Things not to break

- **The upsert replaces, it does not add.** The desktop sends *absolute*
  counters per bucket, so a retried batch converges. Making it additive would
  inflate every number on every retry. Pinned by `test/metrics.test.ts`.
- **No content, ever.** There is nowhere in `schema.sql` to put prompt text,
  replies, diffs or paths. `metrics.ts` drops any label containing a path
  separator.
- **Disclosure copy is duplicated on purpose** in `web/disclosure.js` and
  `src/components/teams/disclosureCopy.ts` (desktop). They must stay
  word-identical.
- **D1 allows 100 bind variables per statement.** Use `DB.batch()` with
  single-row statements rather than multi-row `VALUES`. The test shim enforces
  the limit so this fails locally rather than in production.
- **`run_worker_first = ["/api/*"]` must stay in wrangler.toml.** With SPA
  `not_found_handling`, Cloudflare's asset layer answers *navigation* requests
  (`Accept: text/html`) before the Worker runs — so a browser hitting
  `/api/auth/github/start` gets `index.html` instead of the OAuth redirect, and
  sign-in silently does nothing. A plain `fetch()` does **not** send
  `Accept: text/html`, so every scripted health check still passes while the
  real browser is broken. When testing API routes, send the HTML accept header:

  ```bash
  curl -sI -H 'Accept: text/html' https://teams.agmux.dev/api/auth/github/start
  # must be 302 to github.com, not 200 text/html
  ```

- **Telemetry comes from the provider logs, never `session_usage`.** That table
  is only refreshed when the user opens the Usage panel and stamps rows with the
  scan time — reading it meant zero tokens uploaded and a wrong heatmap. The
  desktop's `teams::scan` reads Claude/Codex/Grok JSONL per event instead.
- **There are no approval or stop-rate metrics.** The desktop turn ledger has no
  reliable source for either — pressing Stop closes a turn as `done`, so it is
  indistinguishable from finishing. They were removed rather than left reading
  zero. Don't re-add them without a real signal to back them.

## Commands

| | |
|---|---|
| `npm run dev` | local server with dev mode on |
| `npm test` | vitest (108 tests) |
| `npm run typecheck` | worker + tests |
| `npm run db:local` / `db:remote` | apply `schema.sql` |
| `npm run deploy` | production deploy |

### Restrictions (policy contract v2)

Apply `migrations/012_restrictions.sql` before deploying this service version.
Fresh installs use `schema.sql`. The migration adds `allowed_modes` and
`allowed_efforts` to the owner policy and creates `manager_policies`. It
normalizes legacy empty provider/model arrays to SQL NULL, preserving their
previous unrestricted meaning. All new saves use **null = unrestricted,
[] = deny all** for all four restriction allowlists.

`GET /api/teams/:key/policy` and successful `PUT` use the existing `{ ok, data }`
envelope. `data` contains:

- `enforcementVersion: 2` (desktop must reject missing/older versions).
- `policy`: effective policy for the active calling member. Includes `teamId`,
  `allowedProviders`, `allowedModels`, `allowedModes`, `allowedEfforts`,
  `defaultPermissionMode`, `mcpAllowlist`, `spendHardStopUsd`, `updatedAt`.
- `editablePolicy`: owner base (full policy), manager's own four-field layer,
  or null for employees and staff previews.
- `canManage`: true only for active owners/managers, never staff previews.
- `scopeLabel`: human-readable editing scope, including manager exclusions.

`allowedModes`: `chat`, `terminal`. `allowedEfforts`: `none`, `minimal`, `low`,
`medium`, `high`, `xhigh`, `max`, `ultra`. Providers retain the existing canonical
IDs. Models are exact, case-sensitive IDs, without wildcard matching. Arrays
reject duplicates, unknown enum values, non-strings, blank entries, surrounding
whitespace, control characters, entries over 200 characters, or more than 64
entries (128 for models). Unknown fields and invalid scalar types return 400.

PUT is a partial update: omitted fields are preserved. Owners edit the team
base; managers edit only their own four allowlists. Attempts by managers to
write permission, spend, or MCP fields return 403, including null values.
Employees and staff previews cannot write. Audit entries record layer and
known-field counts/null (owner-only fields record only a change marker), never
raw model IDs or client text.

Effective restrictions intersect owner + all applicable manager layers. An
active manager's layer always covers self, and only active employees in their
**current** analytics scope (direct people, assigned groups, or all employees
when no scope rows exist). It never restricts owners or peer managers. Scope,
group, membership and role changes are evaluated on every request; stored
layers belonging to inactive or demoted managers do not apply. Owner-only
fields are inherited unchanged. Staff previews see the owner base read-only.

The dedicated `#/t/:slug/restrictions` page makes unrestricted vs deny-all explicit, previews the
editable layer before saving, and separately shows the caller's current
effective restrictions. A model or effort rule makes terminals unavailable
even if Terminal is checked: terminal agents choose these values internally.
Restrictions concern new execution in agmux-controlled sessions, not external
apps, MDM, already-running turns or internal subagent model/effort choices.
Desktop integration refreshes on execution with a maximum 30-second cache;
everything is allowed by default when no restrictions are saved, even if the
policy service cannot be reached. Explicit restrictions survive failed or partial
refreshes and still block execution until verified. This
service stores the legacy spend field without claiming spend enforcement.

Strict desktop support: Claude/Codex support explicit selected models and effort;
Cursor/OpenCode/Local MLX support exact models only. MLX models use the canonical
`local/<id>` ID: preserve the `local/` prefix during exact matching, never strip
it to a raw ID. Local agents can run with only `MLX` in `allowedProviders`,
subject to the other effective restrictions. Grok/Gemini execution is blocked
under model or effort rules until their effective settings can be verified.
Owners/managers have a Restrictions navigation link; employees and staff can
visit directly in read-only mode. Settings links to this page. The route loads
only team context and policy, without roster/group requests.
The editor exposes these limits in a collapsed support note.
