# Product analytics — anonymous install heartbeats

Status: implemented 2026-08-28 (dashboard at owner.agmux.dev)
Date: 2026-08-08

Product analytics answers *"how many people use the agmux mac app"* with a
minimal, privacy-first pipeline. It is **not** Teams (org agent telemetry) and
**not** remote-relay. No third-party product-analytics vendor (PostHog, etc.).

---

## 1. Goals

| Metric | How |
|--------|-----|
| Unique installs | Count of `installs` rows |
| New installs | `first_seen_at` in a date range |
| DAU | Distinct `install_id` in `daily_active` for UTC day D |
| WAU / MAU | Distinct over last 7 / 28 UTC days |
| Version mix | Latest (or per-day) `app_version` on heartbeats |
| OS mix | `os_name` / `os_version` / `arch` on `installs` |
| Retention (optional v1.1) | Cohort day C → active on C+1 / C+7 |

### Non-goals (v1)

- Feature / funnel events (which provider, modes, settings screens)
- Crash reporting, error traces, session replay
- Remote iOS / phone PWA analytics
- Public marketing dashboard SPA (owner.agmux.dev is private, owner-login only)
- Remote "delete my data" API
- Linking installs to Teams accounts, OAuth, or device-pairing identity

---

## 2. Decisions (locked)

| Decision | Choice |
|----------|--------|
| Scope | Core product metrics only (installs, DAU/WAU/MAU, app + OS version, retention later) |
| Consent | **On by default**, easy opt-out in Settings |
| Backend | **Custom** Cloudflare Worker + D1 (not PostHog/Amplitude) |
| Identity | Anonymous random UUID install id — **not** hardware `IOPlatformUUID` |
| Separation | New service; no shared bindings with `teams-service` or `remote-relay` |
| Content | Never prompts, paths, project names, emails, hostnames, provider/session content |

---

## 3. Architecture

```
mac app (productAnalyticsEnabled default true)
  · ~/.xanom/product-analytics.json  { installId, lastHeartbeatDay }
  · on launch: if enabled && day ≠ today UTC → product_analytics_heartbeat
        │
        ▼
POST https://owner.agmux.dev/v1/heartbeat
POST https://owner.agmux.dev/v1/event
        │
        ▼
analytics-service/   (Cloudflare Worker + D1)
  · upsert installs
  · INSERT OR IGNORE daily_active (today, install_id)
  · allowlisted event counters
  · GET /api/summary  (GitHub owner login / OWNER_PASSWORD / ADMIN_TOKEN)
  · SPA at owner.agmux.dev
```

```
analytics-service/
  wrangler.toml          # Worker + D1; route owner.agmux.dev
  schema.sql             # installs + daily_active
  src/
    index.ts             # router
    env.ts
    http.ts
    routes/
      heartbeat.ts
      summary.ts
  test/                  # vitest: validation, idempotency, summary auth
```

Mirror the lightweight patterns from `teams-service/` (Workers + D1, numbered
migrations for live D1, `schema.sql` for fresh DBs) without OAuth, SPA assets,
or telemetry scanners.

**Deploy:** custom domain `owner.agmux.dev` on the agmux.dev zone (same
account pattern as `teams.agmux.dev`). Free-tier friendly: one row per install
per day maximum. Dashboard is GitHub-login allowlisted (`neelsatyavolu`) with
optional `OWNER_PASSWORD`.

---

## 4. Data model (D1)

### `installs`

One row per anonymous install.

| Column | Type | Notes |
|--------|------|--------|
| `install_id` | TEXT PK | UUID v4 |
| `first_seen_at` | TEXT NOT NULL | ISO UTC |
| `last_seen_at` | TEXT NOT NULL | ISO UTC |
| `first_app_version` | TEXT | set once |
| `last_app_version` | TEXT | updated each heartbeat |
| `os_name` | TEXT | e.g. `macos` |
| `os_version` | TEXT | e.g. `15.5` |
| `arch` | TEXT | e.g. `aarch64` |
| `channel` | TEXT | `release` \| `dev` |

### `daily_active`

Building block for DAU/WAU/MAU.

| Column | Type | Notes |
|--------|------|--------|
| `day` | TEXT NOT NULL | `YYYY-MM-DD` UTC |
| `install_id` | TEXT NOT NULL | FK logical to installs |
| `app_version` | TEXT | version that day |
| PRIMARY KEY | `(day, install_id)` | idempotent retries |

Index: `idx_daily_active_day ON daily_active(day)`.

**Retention of rows:** keep indefinitely for v1 (volume is tiny). Optional later
trim of `daily_active` older than N days if needed.

**Do not store:** client IP, User-Agent beyond what we already normalize into
os/arch fields, request bodies in logs.

---

## 5. API

### `POST /v1/heartbeat`

Public. Body (JSON):

```json
{
  "install_id": "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
  "app_version": "3.1.4",
  "os_name": "macos",
  "os_version": "15.5",
  "arch": "aarch64",
  "channel": "release"
}
```

**Validation:**

- `install_id`: UUID v4 only (reject otherwise → 400)
- `app_version`: non-empty, max 32 chars, printable
- `os_name`, `os_version`, `arch`, `channel`: length-capped; `channel` ∈
  `release` \| `dev` (default `release` if omitted)
- Unknown fields: ignore (forward compatible) or reject — prefer **ignore**

**Behavior:**

1. Upsert `installs` (insert on first see; always refresh `last_seen_at`,
   `last_app_version`, os fields).
2. `INSERT OR IGNORE` into `daily_active` for today's UTC date.
3. Response: `204 No Content` (empty body).

**Anti-abuse:**

- Client local gate: at most one successful attempt per UTC day.
- Server PK makes retries free.
- Soft rate limit if easy (e.g. CF rate limiting or in-memory per-install
  burst cap). Not load-bearing for correctness.

### `GET /v1/summary?days=30`

Auth: `Authorization: Bearer <ADMIN_TOKEN>` (Worker secret). Missing/wrong → 401.

Response shape (illustrative):

```json
{
  "asOf": "2026-08-08T12:00:00Z",
  "days": 30,
  "installsTotal": 1200,
  "installsNew": 40,
  "dau": [{ "day": "2026-08-01", "count": 90 }, ...],
  "wau": 310,
  "mau": 800,
  "byVersion": [{ "app_version": "3.1.4", "count": 700 }, ...],
  "byOs": [{ "os_name": "macos", "os_version": "15.5", "count": 500 }, ...]
}
```

**Summary field definitions (locked):**

| Field | Definition |
|-------|------------|
| `installsTotal` | `COUNT(*)` from `installs` |
| `installsNew` | installs with `first_seen_at` date (UTC) in the last `days` days inclusive |
| `dau[]` | for each UTC day in the window: distinct `install_id` in `daily_active` |
| `wau` / `mau` | distinct installs with any `daily_active` row in the last **7** / **28** UTC days ending today (fixed windows; not the `days` query param) |
| `byVersion` | group `installs` by `last_app_version` (current snapshot of last-known version) |
| `byOs` | group `installs` by `(os_name, os_version)` from latest install row |

### `GET /health`

Public liveness: `{ "ok": true }`.

No SPA / `run_worker_first` needed unless a static admin page is added later.

---

## 6. Desktop client

### Persistence

File: `~/.agmux/product-analytics.json` (mode 0600 when created):

```json
{
  "installId": "<uuid-v4>",
  "lastHeartbeatDay": "2026-08-08"
}
```

- Mint `installId` on first need (crypto random UUID) and **persist it immediately**
  even if the heartbeat has not succeeded yet. Only `lastHeartbeatDay` is deferred
  until a successful POST. Failed/offline attempts must **not** mint a new UUID.
- **Do not** use hardware UUID / `IOPlatformUUID` (reserved for authorized
  devtools gate only).
- Prefer this file over `localStorage` so clearing web storage does not mint a
  new install and inflate counts.

### Settings

- `productAnalyticsEnabled: boolean` in `settingsStore` / `AppSettings`.
- **Default: `true`**.
- Opt-out: set false → client must not open a network connection for analytics.

### Invoke path

Rust module e.g. `src-tauri/src/product_analytics/` + command
`product_analytics_heartbeat` (camelCase invoke: `productAnalyticsHeartbeat`):

1. If settings say disabled (pass flag from frontend **or** read a synced file
   flag — simplest: frontend gates and only invokes when enabled), return ok
   without HTTP.
2. Load/create analytics JSON (persist new `installId` immediately); if
   `lastHeartbeatDay === today UTC`, no-op.
3. Build payload from `CARGO_PKG_VERSION` / Tauri package version, `std::env::consts`,
   macOS version (`sw_vers -productVersion` or equivalent), channel
   (`debug_assertions` → `dev`, else `release`).
4. POST to configured base URL (`https://owner.agmux.dev`, overridable for
   local/dev via env or compile-time constant). Use a **short timeout** (e.g. 5s)
   so a hung host never blocks startup.
5. On **HTTP success only**: write `lastHeartbeatDay`. Failures silent (debug log);
   do not change `installId`.

Frontend: after app ready (e.g. root `useEffect`), if
`settings.productAnalyticsEnabled`, fire-and-forget
`invoke('productAnalyticsHeartbeat')` once (do not await in a critical path).
No interval timers.

### Settings UI

Not under **Your Data** (local provider usage charts). Add a **Privacy** card on
the existing **General** settings section (no new nav item in v1):

- **Title:** Product analytics  
- **Body:** Helps us understand how many people use agmux. Anonymous device id,
  app version, and OS version only. No prompts, paths, or account info.  
- **Toggle:** Share anonymous usage stats (default on)

### Disclosure (must stay accurate)

**We collect:** anonymous install id; first/last seen; app version; OS name,
version, arch; channel (release/dev); calendar days the app was opened (UTC).

**We never collect:** prompts, replies, file paths, project names, emails,
machine hostname, IP (not stored server-side), provider/session content, Teams
or remote-control data.

**Opt-out:** toggle off → no further heartbeats. Historical rows remain (v1 has
no remote delete).

---

## 7. Security & privacy

| Topic | Policy |
|-------|--------|
| Auth on write | None (anonymous). Rely on UUID validation + volume limits |
| Auth on read | Shared admin bearer secret |
| Secrets | `ADMIN_TOKEN` via `wrangler secret`; never in client |
| PII | No account linkage; random install id only |
| Logging | No full body logs in production |
| CORS | Allow only if needed; desktop is not a browser CORS concern for Tauri HTTP |
| Teams / remote | Completely separate services and data stores |

---

## 8. Testing

**Worker**

- Valid heartbeat inserts install + daily_active  
- Second same-day heartbeat updates install, no second daily row  
- Invalid install_id → 400  
- Summary without token → 401; with token returns counts  

**Desktop**

- Disabled setting → no HTTP  
- Same `lastHeartbeatDay` → no HTTP  
- Day rollover → one POST; success updates stamp; failure does not  

**Manual**

- Deploy Worker + D1; run app twice same day → one daily_active row  
- `curl` summary with token for smoke numbers  

---

## 9. Implementation sketch (for plan, not binding order)

1. Scaffold `analytics-service/` (wrangler, schema, heartbeat, summary, tests).  
2. Create D1 + deploy route `analytics.agmux.dev`; set `ADMIN_TOKEN`.  
3. Rust `product_analytics` module + command registration + capability if needed.  
4. Settings field + Privacy UI toggle + disclosure copy.  
5. Frontend one-shot invoke on launch.  
6. `RELEASE_NOTES.md` under Unreleased (privacy/analytics disclosure in user language).  

Hard stops to respect: do not bolt onto Teams D1; do not log prompts; do not
use platform UUID as install id.

---

## 10. Open follow-ups (explicitly later)

- D1 day-N retention curves in `/v1/summary`  
- Minimal password-gated HTML admin page  
- Optional "request deletion" endpoint  
- iOS remote shell analytics (separate install id space)  
- Feature events only if product needs them after core metrics land  
