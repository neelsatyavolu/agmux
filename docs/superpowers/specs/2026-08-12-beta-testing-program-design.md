# agmux beta testing program

Status: design  
Repos: `xanom-website` (agmux.dev) + this repo (desktop)  
Audience: invited testers who apply on the website

Approved testers sign up on agmux.dev, Neel approves them, then they can download upcoming beta builds that the public cannot. They can also turn on an in-app beta update channel with a tester token. Beta artifacts live on the website (Vercel Blob), never on GitHub.

Public stable stays as it is today: GitHub `neel-xanom/agmux-releases` + Homebrew.

---

## 1. Problem

Upcoming builds are published as public GitHub release assets. Anyone with the URL can download them. There is no apply / approve step, no private file store, and no in-app channel. Settings only has on/off automatic updates (`autoUpdateEnabled`). The “stable / beta / off” tip in the app is aspirational — there is no beta channel.

## 2. Goals

| Goal | Detail |
|------|--------|
| Apply on the website | Email, name, optional why. No password. |
| Manual approve | Private admin page with a password. Approve / reject a queue. |
| Magic link | After approval, one-time email link signs them into agmux.dev. |
| Gated download | Only signed-in approved testers get the beta DMG / updater archive. |
| In-app beta updates | Settings: toggle + paste token. `check()` sends `Authorization: Bearer`. Asset downloads do not. |
| Files on the website | Beta `.app.tar.gz` + `.sig` + `latest.json` in Vercel Blob, served from agmux.dev. |
| Stable untouched | Public download, GitHub `latest.json`, and Homebrew stay stable-only. |
| Revocable | Admin (or tester regenerate) invalidates a token. Next check is stable. |

### Non-goals (v1)

- GitHub / Google OAuth for testers
- Email + password accounts
- Deep-link token install (`agmux://beta?…`)
- Secret-URL-only access (no identity)
- Separate Cloudflare Worker / D1 / R2 service
- Beta Homebrew cask
- NDAs, surveys, crash-report inbox, tester chat
- Windows / Linux
- Auto-approve, caps, or waitlist ranking
- Shipping a no-op “beta” UI before the site can serve a file

---

## 3. Architecture

Two codebases, one program.

```
agmux.dev (xanom-website, Next.js on Vercel)
  /beta                  apply + (signed-in) status, token, download
  /beta/login            magic-link landing
  /admin/beta            password gate, queue, publish
  /api/beta/*            apply, session, download, admin, token verify
  /api/updates/latest.json
  /api/updates/assets/*  HMAC-gated archive redirect (no tester Bearer)
  Postgres (Neon / Vercel)     applications, testers, sessions, releases
  Vercel Blob                  archives + signatures
  Resend                       apply receipt + magic link

desktop (this repo)
  Settings → About → Updates   beta toggle + token field
  updateStore                  Bearer on check() only; HMAC asset URLs for download
  tauri.conf.json              website updater endpoint first, GitHub second
```

```
Visitor --POST /api/beta/apply--> applications(pending)
Admin  --approve--> testers(token hash) + Resend magic link
Tester --GET /beta/login?token=--> session cookie --> /beta
App    --GET /api/updates/latest.json + Authorization--> beta or stable JSON
```

**Why the website is the updater endpoint.** `@tauri-apps/plugin-updater` `check()` accepts headers but cannot change endpoints at runtime. Endpoints are compile-time in `tauri.conf.json`. To send a token, every build that supports beta must call the site. The site returns stable JSON without a valid token, and beta JSON with one.

**Why object storage, not an API body.** Beta archives are tens to hundreds of MB. Vercel serverless request bodies are too small. Admin upload uses a **presigned Blob PUT** from the browser. Publish only writes DB metadata after **both** arches are in Blob.

**Why GitHub remains a second updater endpoint.** If agmux.dev is down, testers and everyone else still get **stable** from `https://github.com/neel-xanom/agmux-releases/releases/latest/download/latest.json`. GitHub must be **second**. If it were first, the plugin would never ask the site, and beta would never win.

---

## 4. Identity and sessions

### 4.1 Apply

`POST /api/beta/apply` body:

| Field | Rules |
|-------|--------|
| `email` | required, trimmed, lowercased, valid email, max 320 |
| `name` | required, 1–80 chars |
| `why` | optional, max 500 chars |

Same email: do **not** insert a second row. Return the existing status (`pending` / `approved` / `rejected`). Show “already applied” on the form.

Rate limit (Postgres, not in-memory — Vercel instances do not share RAM): 5 applies per IP per hour; 1 mutating apply per email per day (status-read for duplicates is free). Same table can count `token/verify` and magic-link requests.

On first insert: send “we got your application” via Resend. No access yet.

### 4.2 Admin

`ADMIN_PASSWORD` env (min 16 chars in production). `/admin/beta` is a password form; success sets an httpOnly, `Secure`, `SameSite=Lax` cookie (`agmux_beta_admin`, 12h). Timing-safe compare.

Admin can: list by status, approve, reject (optional reason, 200 chars), revoke tester, regenerate tester token, start upload, publish, unpublish (hides beta; does not delete Blob).

Reject does **not** email unless the admin checks “email them”.

### 4.3 Approve → magic link

Approve:

1. If no tester row, create one. Mint `agmux_beta_` + 32 random bytes hex (**75** chars: prefix 11 + 64 hex). Store **SHA-256 hex** only. Show the raw token once in the admin UI (copy).
2. Mint a magic-link token (32 random bytes, hashed in `sessions`). `expires_at` = now + 15 minutes, `used_at` null, `kind = magic_link`. Copy the raw tester token into `sessions.flash_token` so the first login can show it. A later “request new link” before consume copies `flash_token` onto the new row; after consume it is gone.
3. Email: “You’re in” + link `https://agmux.dev/beta/login?token=<raw>` + “After you sign in, copy your tester token into Settings → About → Updates.” The email does **not** contain the tester token.

Magic link: one use. After consume, set `used_at`, issue tester session cookie (`agmux_beta_sess`, 30 days, httpOnly, Secure, SameSite=Lax), read-and-null `flash_token`, redirect `/beta` (no token in the URL). The page shows the raw tester token **once** from that flash. After that: prefix + **Regenerate** only.

Expired / used: page says so. Approved, **non-revoked** emails may `POST /api/beta/auth/request-link`. Limits (not apply’s 1/day — links last 15 minutes): 5 / IP / hour and 3 / email / hour. Pending, unknown, or revoked emails get a generic “if this address is approved, you’ll get a link” and no mail.

Logout: `POST /api/beta/auth/logout` clears the tester cookie.

### 4.4 Tester token

- Format: `agmux_beta_[64 hex chars]`
- Stored: SHA-256 hex, plus first 8 hex chars after the prefix as `token_prefix` for admin/UI (`agmux_beta_ab12cd34…`)
- Never log the raw token. Never put it in `latest.json`.
- Revoke: set `revoked_at`, delete that email’s `tester` + `magic_link` sessions, null any leftover `flash_token`. Website session is dead (cookie no longer matches). `request-link`, session download, and **Regenerate** all fail. `latest.json` with the old token is stable. Only admin can un-revoke (clear `revoked_at` and mint a new token + magic link).
- Regenerate (signed-in, **not** revoked): rotate hash, show raw token once. Existing **website** session stays; they must paste the new token into the app. Revoked testers cannot regenerate.

---

## 5. Data model (Postgres)

```sql
applications (
  id            text primary key,          -- ulid / uuid
  email         text not null unique,
  name          text not null,
  why           text,
  status        text not null,             -- pending | approved | rejected
  reject_reason text,
  created_at    timestamptz not null,
  decided_at    timestamptz
);

testers (
  id            text primary key,
  application_id text not null unique references applications(id),
  email         text not null unique,
  token_hash    text not null unique,
  token_prefix  text not null,
  revoked_at    timestamptz,
  created_at    timestamptz not null
);

sessions (
  id            text primary key,
  kind          text not null,             -- magic_link | tester | admin
  subject       text not null,             -- email, or 'admin'
  token_hash    text not null unique,
  flash_token   text,                      -- one-time tester token reveal; null after consume
  expires_at    timestamptz not null,
  used_at       timestamptz,
  created_at    timestamptz not null
);

rate_limits (
  key         text primary key,            -- e.g. apply:ip:1.2.3.4
  window_start timestamptz not null,
  count       int not null
);

beta_releases (
  id            text primary key,
  version       text not null unique,      -- semver, e.g. 3.2.0-beta.1
  notes         text not null default '',
  status        text not null,             -- draft | published | unpublished
  platforms     jsonb not null,            -- see below
  published_at  timestamptz,
  created_at    timestamptz not null
);
```

`platforms` JSON:

```json
{
  "darwin-aarch64": {
    "dmg": "beta/3.2.0-beta.1/darwin-aarch64.dmg",
    "blob": "beta/3.2.0-beta.1/darwin-aarch64.app.tar.gz",
    "sig": "beta/3.2.0-beta.1/darwin-aarch64.app.tar.gz.sig",
    "signature": "<minisign contents>"
  },
  "darwin-x86_64": { "...": "..." }
}
```

Many rows may be `published`. “The beta” in §7.2 is `max(version)` among `status = published`. Unpublish sets `unpublished` and drops that row from the max.

`signature` is the `.sig` file text so `latest.json` can embed it without a second fetch.

---

## 6. Website surfaces

### 6.1 Public apply — `/beta`

Marketing-adjacent page (same fonts/colors as the landing site). Form: email, name, optional why. Success: “We’ll email you if you’re approved.” Duplicate email: same page with current status, no new row.

Navbar: add **Beta** next to Changelog. Footer too.

### 6.2 Signed-in `/beta`

If `agmux_beta_sess` is a valid tester session:

- Status: approved
- Latest **published** beta version + notes (or “nothing to download yet”)
- Two download buttons (Apple Silicon / Intel). Do **not** sniff `User-Agent` (Safari on Apple Silicon still says Intel).
- Tester token: show prefix + **Regenerate**. Raw token appears only: (1) admin Approve, once; (2) first page after magic-link consume, once (flash, not emailed, not in the URL); (3) after Regenerate, once. Regenerating emails nothing.
- Sign out

Correction vs the conversation sketch: we cannot persist the raw token, so `/beta` is not a permanent “copy your token” locker. Magic-link landing + regenerate cover lost tokens.

### 6.3 Admin — `/admin/beta`

Password page, then:

1. **Queue** — tabs Pending / Approved / Rejected. Rows: date, name, email, why. Actions: Approve, Reject.
2. **Testers** — prefix, revoked or not, Revoke, Regenerate (shows new raw token once).
3. **Releases** — list drafts + published. New draft: version, notes. Upload widgets (presigned) per platform: `.dmg`, `.app.tar.gz`, `.sig`. **Publish** enabled only when **both** `darwin-aarch64` and `darwin-x86_64` have all three. A 200 `latest.json` that omits the requester’s arch makes the plugin `TargetNotFound` and **skip** GitHub, so an arm64-only beta would break Intel testers (including stable). Unpublish.

No other admin users in v1.

### 6.4 Legal

Update `xanom-website` privacy + terms: beta program collects email/name/why, session cookies, and stores a token hash. Beta builds may be unstable. Link `/beta` from both.

---

## 7. Files and updater protocol

### 7.1 What admin uploads

Tauri `createUpdaterArtifacts` output, not the public `.dmg`:

- `agmux_<version>_<target>.app.tar.gz`
- `agmux_<version>_<target>.app.tar.gz.sig`

Website first-install is the `.dmg`. Publish requires, for **each** of `darwin-aarch64` and `darwin-x86_64`: `.dmg` + `.app.tar.gz` + `.sig`. No arm64-only publish in v1.

### 7.2 `GET /api/updates/latest.json`

Always **200** with a full Tauri payload when we can build one. Never 204 (a 204 makes the plugin stop and skip GitHub endpoint #2). On DB/Blob failure, **5xx** so the plugin falls through to GitHub.

Response headers: `Cache-Control: private, no-store` and `Vary: Authorization`. The 5-minute cache is only the **outbound GitHub fetch**, not this response (a CDN-cached beta body would leak HMAC URLs).

Same shape as today’s GitHub file. `platforms.*.url` is **not** a Blob URL (Blob’s own `Authorization: Bearer` would collide with a tester token). It is an HMAC asset URL on this host — see §7.3.

```json
{
  "version": "3.2.0-beta.1",
  "notes": "…",
  "pub_date": "2026-08-12T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<sig file contents>",
      "url": "https://agmux.dev/api/updates/assets/<releaseId>/darwin-aarch64?e=<unix>&s=<hmac>"
    }
  }
}
```

Resolution (normative — the only rule):

1. Parse `Authorization: Bearer <token>` if present.
2. Load **stable** payload: fetch-and-cache GitHub `latest.json` (revalidate 5 minutes; on GitHub failure use last good cache; if no cache, 5xx).
3. Candidates = `{stable}`. If the bearer hashes to a non-revoked tester, also add `max(version)` among `beta_releases` with `status = published` (both arches present — enforced at Publish).
4. Return **200** JSON for `max(candidates)` by semver (prerelease-aware: `3.2.0-beta.1 < 3.2.0`). The plugin compares to the running app. Do not read the app version on the server — `check()` does not send it, and the endpoint has no `{{current_version}}` placeholder. If the winning candidate is a beta, every `platforms` key the plugin will look up (`darwin-aarch64`, `darwin-x86_64`) must be present.

Shipping public `3.2.0` therefore beats `3.2.0-beta.*` and testers move onto stable automatically.

`latest.json` never includes the tester token.

### 7.3 HMAC asset URLs

`GET /api/updates/assets/:releaseId/:target?e=&s=`

- `s` = hex HMAC-SHA256 of `releaseId|target|e` with `BETA_SESSION_SECRET`.
- Valid for 60 minutes (`e` is unix expiry).
- No session cookie. Ignore any `Authorization` header (so a leftover tester Bearer cannot break this GET).
- Blob objects are uploaded with **private** access (not Vercel’s public default). Deterministic `beta/<version>/…` keys must not be world-readable.
- Looks up the published (or still-referenced) archive; **302** to a short-lived Blob URL. The 302 must **not** forward `Authorization`.
- Expired/bad HMAC → 403. `installUpdate` re-`check()`s **once with the same Bearer** (so the new `Update` has a fresh HMAC URL) and retries download. Do not map that 403 to `manual-required`.

Website first-install download stays session-gated (§7.4) and may 302 the same way.

### 7.4 Website download

`GET /api/beta/download?arch=aarch64|x64` requires tester session. Returns 302 to a 60-minute signed Blob URL for the latest **published** beta’s `.dmg` for that arch, or 404 if none. Browser download; not the Tauri updater.

### 7.5 Desktop updater config

`src-tauri/tauri.conf.json` `plugins.updater.endpoints` becomes:

1. `https://agmux.dev/api/updates/latest.json`
2. `https://github.com/neel-xanom/agmux-releases/releases/latest/download/latest.json`

Existing `pubkey` unchanged. Beta artifacts must be signed with the same minisign key as stable.

Native updater does not use webview CSP. Token **verify** (§8) is a webview `fetch` to agmux.dev, so `connect-src` must add `https://agmux.dev`.

---

## 8. Desktop surfaces

Settings → About → Updates (existing card):

| Control | Behavior |
|---------|----------|
| Automatic updates | unchanged |
| **Beta channel** | toggle, default off |
| **Tester token** | password-style input; shown when beta is on; save stores in settings blob |
| After save / Check now | If the token field is empty, skip verify (no error). Else `POST https://agmux.dev/api/beta/token/verify` with `{ "token": "<raw>" }`. Body JSON `{ "ok": true }` or `{ "ok": false, "reason": "invalid" \| "revoked" }`. On `ok: false`, show “Token rejected or revoked” under the field. Do **not** infer this from `check()` — the plugin hides headers and returns `null` for both “bad token” and “already on newest”. No toast spam on background polls. |

Settings keys:

```ts
betaUpdatesEnabled: boolean; // default false
betaUpdateToken: string;     // default ""
```

`POST /api/beta/token/verify` is public (token is the secret). No cookies. CORS: allow `http://localhost:1420`, `tauri://localhost`, `https://tauri.localhost`. Rate limit like apply.

`updateStore.checkForUpdate` / `installUpdate`:

- If `betaUpdatesEnabled && betaUpdateToken.trim()`: `check({ headers: { Authorization: \`Bearer ${token}\` } })`.
- `download` / `downloadAndInstall` **must** pass headers that omit the tester token as the **options** argument (`downloadAndInstall(onEvent, { headers: {} })` — `{}` as the first argument does **not** clear `check()` headers). The plugin copies `check()` headers onto `Update`; if those leak onto a Blob GET, Vercel Blob’s own bearer auth 401s. HMAC asset URLs on agmux.dev also ignore `Authorization` and must not forward it on the 302.
- Else: `check()` with no Authorization (stable).

Toggle off: keep the stored token, just stop sending it.

**Chicken and egg.** Builds before this change only talk to GitHub. In-app beta works only after the user is on a build that includes this endpoint + UI. **First jump onto beta is always the website DMG.** Ship order: site apply/admin/files → desktop token + endpoint in the next **stable** → then publish `x.y.z-beta.1`.

---

## 9. Email (Resend)

From: `agmux <noreply@agmux.dev>` (or the verified domain you already have).

| Event | Email |
|-------|--------|
| First apply | “We got your beta application.” |
| Approve | “You’re in” + magic link (15 min) + “after you sign in, copy your tester token into Settings → About → Updates.” No raw token in the email. |
| Request new link | Same magic-link body. |
| Reject | Only if admin opted in. One sentence, no debate. |

No marketing list. No “new beta is out” blast in v1 (in-app check covers testers who opted in).

---

## 10. Error handling

| Case | Behavior |
|------|----------|
| Duplicate apply | Existing row + status; no second insert |
| Magic link expired/used | Explain; approved emails can request another |
| Pending user requests link | Generic success, no email |
| Bad / revoked token in app | `verify` fails → Settings message; `check()` still 200 stable JSON; plugin compares normally |
| No published beta | `/beta` empty state; `latest.json` is stable |
| Incomplete publish | Draft stays draft; download + updater ignore it |
| Blob / Resend / DB down | Apply/admin return a visible error; `latest.json` 5xx → plugin uses GitHub |
| Expired HMAC asset URL | 403; user re-checks |
| Site outage | GitHub endpoint #2 serves stable only |

---

## 11. Security

- Raw tester tokens and magic links are unguessable (256-bit). At rest: hashes, except `sessions.flash_token` until first consume (then nulled).
- Admin password only in env; cookie is httpOnly.
- Presigned uploads: max size 500 MB, content-type allowlist, key prefix `beta/<version>/` minted by the server (client cannot choose an arbitrary key).
- Signed download URLs: 60 minutes, GET only.
- No directory listing on Blob.
- Apply CSRF: same-origin + Origin check on cookie-authenticated mutating routes. `token/verify` is bearer-in-body and CORS-limited (§8).
- Do not put beta bytes on GitHub, even as a draft release.
- Privacy policy must mention the new data.

This is **not** a high-assurance DRM scheme. A tester can still share a live signed URL for 60 minutes or leak their token. Revoke is the response.

---

## 12. Testing

### Website (unit / route tests, Blob + Resend mocked)

- Apply creates `pending`; duplicate email does not insert.
- Approve stores hash only; magic link works once, then fails.
- Reject / revoke: session cookie no longer works; `request-link` and Regenerate fail; download 403; `latest.json` with that token is the stable payload.
- `latest.json`: no header → stable 200; valid token + published beta with semver `> stable` → that beta + HMAC asset URLs; valid token + beta `< stable` → stable; garbage/revoked → stable 200. Never 204.
- `token/verify`: ok / invalid / revoked.
- Publish refused unless **both** arches have DMG + `.app.tar.gz` + `.sig`; after publish, session download and updater see `max(published)` version.
- Asset HMAC: good signature 302s without forwarding Authorization; expired/bad 403.

### Desktop

- Toggle off / empty token → `check()` called without `Authorization`.
- Toggle on + token → `Authorization` on `check()` only; `download`/`downloadAndInstall` called with headers that omit it.
- Save / Check now calls `token/verify`; `ok: false` shows Settings message, no install loop, status is not `manual-required`.
- `connect-src` includes `https://agmux.dev`.

Out of scope: real Blob/Resend, signing a DMG in CI, e2e click-through on Vercel.

---

## 13. Ship order

1. **Website** — schema, apply, admin queue, magic link, Blob upload, `latest.json`, legal copy, Beta nav link.
2. **Desktop** — settings + updater headers + endpoint order. Ship this in a **public stable** so testers who paste a token on that build get later betas in-app.
3. **First beta** — admin publishes `x.y.z-beta.1`. Testers still on older stables download the DMG once from `/beta`.

`RELEASE_NOTES.md` (desktop) under Unreleased → New: beta channel + token in Settings, link to agmux.dev/beta.

---

## 14. Env (website)

| Name | Purpose |
|------|---------|
| `DATABASE_URL` | Postgres |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob |
| `RESEND_API_KEY` | Email |
| `ADMIN_PASSWORD` | Admin page |
| `BETA_SESSION_SECRET` | Cookie signing (≥32 bytes) |
| `GITHUB_RELEASES_JSON` | optional override; default GitHub latest.json URL |

No secrets in the desktop app. The tester token is user-supplied settings, not a baked key.
