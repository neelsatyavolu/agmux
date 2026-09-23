# agmux owner analytics

Private product analytics for the mac app. Live at <https://owner.agmux.dev>.

Separate from **Teams** (`teams-service/`) and **remote-relay**. No shared
bindings. Anonymous analytics contains no prompts, paths, project names, emails, or account linkage — only an
anonymous install id, app/OS version, and allowlisted event counters.

## What is collected

**Heartbeat (once per UTC day per install):** install UUID, app version, macOS
version, arch, release/dev channel.

**Events (counters only):** `thread_created` `{provider, interactionMode}` and
`app_mode` `{mode}`. Unknown names and extra props are dropped.

## Auth

The dashboard is owner-only:

- GitHub login in `OWNER_GITHUB_LOGINS` (`neelsatyavolu`) — add the OAuth
  callback `https://owner.agmux.dev/api/auth/github/callback` on the GitHub app.
- Optional `OWNER_PASSWORD` secret for a password form.
- Optional `ADMIN_TOKEN` Bearer for `GET /api/summary`.
- `npm run dev` enables a localhost-only dev sign-in (`DEV_AUTH=true`).

## Deploy

```sh
cd analytics-service
npm install
npx wrangler d1 create agmux-owner          # paste database_id into wrangler.toml
npx wrangler d1 execute agmux-owner --remote --file=./schema.sql
npx wrangler secret put GITHUB_CLIENT_ID    # optional
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put OWNER_PASSWORD      # optional, easiest first login
npx wrangler deploy
```

Local:

```sh
npm test
npx wrangler d1 execute agmux-owner --local --file=./schema.sql
npm run dev   # http://localhost:8788
```

## Direct support

Settings → Support submits explicit bug/crash/question/feedback reports to
`POST /v1/support`. This is separate from anonymous analytics and works when
analytics is disabled. Reports contain the user's text, optional reply email,
app version, OS/architecture, and only user-selected attachments/performance
capture. They can contain private information: do not describe support as
anonymous telemetry. No automatic crash upload or provider transcript collection.

The existing owner authentication protects the inbox (`GET /api/support`),
resolution (`PATCH /api/support/:id`) and attachment downloads. R2 objects are
private, served as downloads with no content sniffing; never enable a public
bucket domain. Limits: 5 reports/network/hour, 5 files/report, 5 MiB/file and
10 MiB combined. Raw network addresses are not stored; hourly hashes expire.

Before deploying a desktop with Support, provision and deploy the backend:

```sh
npx wrangler r2 bucket create agmux-support-files
npx wrangler d1 execute agmux-owner --remote --file=./migrations/0002_support.sql
npm run typecheck
npm test
npx wrangler deploy
```

The additive migration is also included in schema.sql for new/local databases.
Test with local storage first. Production reports must not be fabricated during
verification; any live test should be clearly marked and authorized.
