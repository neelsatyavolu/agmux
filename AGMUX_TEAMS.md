# agmux Teams — agent guide

Org-level analytics for AI coding agents. Answers *"how does this team actually
use their coding agents"* from **aggregates only** — never prompt text,
replies, diffs, file contents, absolute paths, or secrets.

**Status:** live at <https://teams.agmux.dev>. OAuth configured, desktop uploader
running.

Read this before touching anything under `teams-service/`,
`src-tauri/src/teams/`, `src/components/teams/`, or `src/lib/teams.ts`.

| Also see | For |
|---|---|
| `teams-service/README.md` | running locally, deploying, OAuth setup |
| `docs/superpowers/specs/2026-07-29-teams-analytics-design.md` | design rationale, screen→route map |
| `docs/superpowers/specs/2026-08-10-teams-knowledge-design.md` | **Team Knowledge** (shared decisions/digests; content plane) |
| `.claude/rules/architecture.md` § Teams | the short version, in the shared rules |


### Team provider account pool (separate credential plane; deployed 2026-09-21)

Personal provider credentials are never uploaded by analytics. Owners/managers may
explicitly add **team** Grok/Codex OAuth credentials for sharing with eligible members.
`provider_accounts` stores AES-256-GCM ciphertext with a fresh 96-bit IV per write;
AAD binds version, team, account ID and provider. No credential values in metadata,
analytics, audit details, error responses or logs. This is application encryption
in separate D1 tables, not a separate D1 database. Worker code has decryption access.

Production has additive `teams-service/migrations/013_provider_accounts.sql`
(or fresh `schema.sql`) and Worker secret `PROVIDER_ACCOUNTS_KEY`, standard base64 of
32 cryptographically random bytes. No default/fallback key. An absent (undefined) key
returns 503 `provider_accounts_not_configured`: execution clients may treat only this
code as an empty pool during rollout, while Settings shows feature unavailable.
Empty/malformed keys, unmigrated storage and decryption failures return 503
`provider_accounts_unavailable` and must not be treated as a disabled feature. A
syntactically valid but wrong key is detected on decryption, not metadata GET.
Metadata GET also requires valid key configuration so clients detect unavailability
before login/upload. Administrative disable/delete remain available without the key.
Keep the key stable: replacing it does not migrate existing ciphertext. Key rotation
requires a controlled re-encryption migration; do not blindly replace the secret.
Migration 013 and the encryption secret were configured on 2026-09-21. Production
Worker version: `fc068a6e-5352-4fef-9b8c-bdc71a3a4174` (2026-09-23, usage check route +
`lastRemainingPercent`). It was built by patching the downloaded live `84ac9ca1` bundle,
not from this checkout, so legacy policy and assets are unchanged (13 public responses/assets
byte-identical before/after). Uploaded via the versions API with `keep_assets` and
`keep_bindings: ["secret_text"]`. Roll back with `wrangler versions deploy 84ac9ca1-fdb8-4376-8699-7a9bc38ab0f8@100%`.

**2026-09-24 update (current production):** version `9728aa23-4c30-45fd-9e9a-3e83f0adb806`, again built by
patching the downloaded live `fc068a6e` bundle (provider-accounts section only; the rest byte-identical),
uploaded with `keep_bindings: ["secret_text"]` + `keep_assets`, runtime and all 18 bindings verified identical,
11 public responses/assets byte-identical before/after. Additive migration
`014_provider_account_display.sql` (`usage_json`, `plan`) was applied first; D1 bookmark before it:
`0000431b-00000054-000050f0-5a0288acadb18484544dc28816bfd470`. Live code `fc068a6e` was verified to work with 014,
so roll back with `wrangler versions deploy fc068a6e-5352-4fef-9b8c-bdc71a3a4174@100%` and leave the columns.
Changes: list metadata adds `identityHash` (sha256 of `[provider, ...identity]`), `inUse`
(`{self, by: display name, kind: session|cli|check}` while leased), `plan` and `usage` (display-only windows);
re-uploading an existing login keeps its team name (rename is PATCH); `POST …/{id}/check` accepts optional
`{"purpose":"cli"}` for a member's own CLI lease; renew accepts optional `usage`/`plan`. Desktops send
`usage`/`plan` in a separate best-effort renew so an older server can never reject a credentials renewal.

**Account activity (current production, 2026-09-24):** version `89f699da-6449-4f21-a761-cf1fbb073836`, the live
`9728aa23` bundle patched (provider-accounts section only) and uploaded with `wrangler versions upload --no-bundle`
from a release dir. Static assets are the production set reproduced byte for byte from git (25 files; 24 already on
the asset store), with only `disclosure.js` changed. Runtime and all 18 bindings were verified identical, and the
preview served all 25 files identically. Migration `015_provider_account_activity.sql` was applied first; D1
bookmark before it: `0000433c-000003d2-000050f0-33471cef47b8015257b19b8da0990fee`. Roll back with
`wrangler versions deploy 9728aa23-4c30-45fd-9e9a-3e83f0adb806@100%` and leave the tables; that restores the
previous disclosure asset too. A live report/read/clear round trip passed. Behaviour:
desktops `POST …/provider-accounts/activity` about once a minute with the logins their *running agmux sessions*
use (`{provider, identityHash, sessions, label?}`; never activity outside agmux, never credentials). Rows expire
after 180 s. `GET …/activity` returns per-login `activeUsers`/`sessions`/`self`; a Claude login's `label` (email)
is returned only when the owner enabled `PATCH …/settings {claudeActivity}` and 2+ members are active on it.
Turning it off deletes Claude rows. Pool list rows add `activeUsers` (reporting members plus a non-check lease
holder), and allocation ranks by other members active on the same login first, then capacity. The disclosure
gains one `SHARED`/`SHARED_SHORT` line in both copies, so the release uploads the reproduced production asset
set with only `disclosure.js` changed.

**Sessions started (current production, 2026-09-25):** version `34ceef93-bf9c-44c2-ae8f-87b09e6b4e0b`, deployed
08:32 UTC. The live `0bf613dc` bundle with only the `sessions_started` edits from `2d807267` applied by exact,
match-once string patches (aggregate totals/daily/projects, dashboard select + deltas, metrics upsert, CSV export incl.
`tokens_total` without reasoning), uploaded with `--no-bundle`. Web = the 27 live files with the 8 web files from
`2d807267` patched (no rejects). Migration `016_sessions_started.sql` was applied first; D1 bookmark before it:
`00004340-00001a53-000050f1-797d365c607eec110c832f44d598a2b1` (existing 10,569 rows stay NULL = unknown). Before
deploy, a local Miniflare run of the live bundle vs the candidate on the production schema (legacy + 013–015) checked
old-client upload/retry, 20 read contracts identical apart from the added fields, CSV columns, and the live Worker plus
rollback with 016 applied. 18 bindings and runtime identical; all 27 served files matched the release. An old desktop
upload succeeded 19 s after deploy. Roll back with `wrangler versions deploy 0bf613dc-4878-4e6a-b49d-0988126f8150@100%`
and leave the column.

**Web restyle (previous production, 2026-09-25):** version `0bf613dc-4878-4e6a-b49d-0988126f8150`. The server
bundle is the live `89f699da` bundle, unchanged (both modules byte for byte, uploaded with `--no-bundle`). The web
assets are the 25 live files with the agmux.dev restyle from `4d869a52` applied: new `teams.css`/`app.css`, a
`fonts/` directory, and 12 patched files. `views/restrictions.js` and the Settings Restrictions card stay out, and
production Settings still shows the legacy "Agent policy" card. All 18 bindings and the runtime settings were verified
identical to `89f699da`, and the preview API answered the same as live. Roll back with
`wrangler versions deploy 89f699da-6449-4f21-a761-cf1fbb073836@100%`.

**Deployment compatibility boundary:** production intentionally retains the legacy
policy implementation (`src/routes/policy.ts` from `acd290ea`) and its existing web
assets. Migration 012 / the newer Restrictions behavior are **not deployed**.
Do not blindly deploy the full current checkout: its policy queries require that
undeployed schema and its web assets change policy behavior. The Accounts rollout
used an isolated release directory with current Accounts code plus the exact legacy
policy and production assets, changing only the credential-sharing disclosure.
A rebuilt baseline matched downloaded production code after generated source-name
normalization. Rollback version with the encryption key retained:
`88add5d5-30fa-41d7-b8ec-71c8b81145e9` (old code plus new key). Leave the additive table
and encryption key intact on a Worker rollback; do not restore the entire live DB.
Before-migration D1 bookmark: `00004203-00000468-000050ed-9e190b69c184201ccb185a275f1283c3`.

`test/provider-accounts-compat.test.ts` covers migration/older-client contracts and
reproduces the full-checkout/missing-012 blocker. The local-only comparison command
`node test/provider-accounts-release.workerd.mjs baseline.js candidate.js` runs the
actual downloaded production bundle and built release side-by-side, including old
uploads/retries and policy PUT. Preserve redirect targets when snapshotting web
assets: `/index.html` redirects to `/`; an unfollowed redirect is not an asset body.
The initial rollout's empty entry-page packaging error was corrected immediately
by restoring the unchanged source index. Post-correction live API and asset checks
are recorded in the session handoff. Desktop release/install is separate.

**API contract:** prefix `/api/teams/:key/provider-accounts` (team ID or slug).
Existing envelope `{ok:true,data:...}` / `{ok:false,error,code}`. All successful
responses use `Cache-Control: no-store`. Auth uses existing web cookies or device
tokens; allocate/renew/release require a desktop bearer device token.

| Method/path | Request | `data` response |
|---|---|---|
| GET `/` | none | `{accounts: AccountMetadata[]}` |
| POST `/` | `{provider: "codex"\|"grok", label, credentials}` | 201 new / 200 reconnect `{account: AccountMetadata}` |
| PATCH `/:id` | `{enabled?: boolean, label?: string}` (at least one) | `{account: AccountMetadata}` |
| DELETE `/:id` | none | `{deleted:true}` |
| POST `/allocate` | `{provider, sessionId, excludeIds?: string[]}` | `{account: AccountMetadata, leaseId, credentials, expiresAt}` |
| POST `/leases/:leaseId/renew` | `{credentials?: nativeJSON, blockedUntil?: number, remainingPercent?: number}` | `{leaseId, expiresAt}` |
| DELETE `/leases/:leaseId` | none | `{deleted:true}` |
| POST `/:id/check` | none | same as allocate. Short exact lease for a desktop usage check; ignores capacity; 409 `provider_account_in_use` when leased; device token required |

`AccountMetadata` is `{id,provider,label,enabled,canManage,createdBy,scope,createdAt,updatedAt,
lastUsedAt,blockedUntil,remainingPercent,healthReportedAt,leasedUntil,lastRemainingPercent}`
(`lastRemainingPercent` is the last measurement regardless of age, null after an elapsed reset;
display-only, and older clients ignore it). Scope is
`team` or `manager`. All timestamps are **Unix seconds**, nullable where unreported;
remainingPercent is null or 0–100. `canManage` is true for owners and the creating
manager only, false for employees and staff previews; clients parsing older responses
should treat missing `canManage` as false. Never a ciphertext/token field in metadata.
Label max 120 characters, sessionId max 200, excludeIds max 50 IDs of max 100 chars.
Native credentials max **32 KiB UTF-8**; streamed request body max **40 KiB**.
Codex requires `tokens.access_token`, `tokens.refresh_token`, `tokens.id_token`,
`tokens.account_id` and a decodable nonempty JWT `sub`;
optional `auth_mode` must be `chatgpt`; API-key auth is rejected. Grok accepts native
scope maps keyed by `https://auth.x.ai::…` or `https://accounts.x.ai/sign-in`, each
with a nonempty `key` and consistent `user_id` (legacy `principal_id` accepted).
Native refresh fields/metadata are preserved unchanged.

**Authorization:** live membership and role checks at every request and in mutation
SQL. Owners manage all accounts. Managers manage only accounts they created.
Owner-created accounts serve the team while their creator remains an active owner.
Manager-created accounts serve the creator plus employees in the existing manager
scope while the creator remains an active manager/owner; promotion never widens
that account's stored scope. **No manager scope rows means all team employees plus
self**; configured scope means assigned direct/group employees plus self. Peer
managers are excluded even when present in a scope group. Owners can allocate across the pool.
Creator departure/demotion, employee departure and removed scope block further
allocation/renewal. Staff preview can read metadata only, never credentials or leases.
Employees see metadata only for eligible accounts; managers also see their own
accounts. Cross-team/account management and wrong user/device/expired lease IDs
return 404. Unauthorized management/cookie lease requests return 403.

**Allocation and lease protocol:** one atomic `UPDATE … WHERE id=(SELECT … LIMIT 1)
RETURNING` selects/claims an account. Each account has at most one live lease,
including for the same device/session: duplicate allocation is not a renew and may
return 409 `no_provider_account_available`. Select enabled, unblocked accounts with
no live lease; prefer greatest reported positive capacity, then unknown capacity,
then least recently used (ID breaks ties). Unknown is never inferred as 100%.
Positive headroom expires after **300 seconds** (or is unknown if its report time is
missing), both in metadata and allocation ranking. Reported zero without a reset
remains unavailable regardless of age; a passed reset makes effective capacity unknown. Raw blocked/reset and health measurements remain stored across
release/expiry. `excludeIds` supports client failover without globally disabling an
account. There is no provider health polling in the Worker.

Leases last **300 seconds**; renew before expiry (recommended every 60 seconds).
The client must serialize OAuth refresh and publish the entire updated native JSON
on renew **before releasing**. Omitted renewal fields preserve existing values,
except the explicit health-reset operation below.
`blockedUntil: 0` explicitly clears a previous block (stored as SQL NULL, returned as
`blockedUntil: null`); a fresh positive `remainingPercent` stays known until its
five-minute freshness limit. When `blockedUntil: 0` omits `remainingPercent`, it also
clears `remaining_percent` to SQL NULL (unknown), including a previous exhausted zero.
Use this for native extra-credit/unlimited availability with no measured percentage;
never fabricate 100%. Positive quota with a future window reset is not blocked:
only report a future `blockedUntil` for actual unavailability, not a normal quota window.
The request accepts numeric zero as the clear sentinel, not JSON null.
Renewals fence on exact team/user/device/lease ID, current expiry, enabled account
and current scope; stale holders cannot overwrite newer credentials. Release clears
only lease state and is permitted for a current member/holder after scope removal.
Disabling retains outstanding exclusivity until release/expiry; re-enabling cannot
prematurely hand the account to a second device. Store lease IDs securely, renew only
while actively using the account, stop using/refreshing the account before expiry or
immediately on a rejected renewal, and discard the temporary credential copy.
A lost allocation response may keep an account busy for up to five minutes.

Server fencing cannot invalidate OAuth credentials already delivered to a device.
Disabling/deleting accounts or removing members prevents future API access, but
provider-side revocation is required to invalidate those credentials. Identity deduplication
is per team/provider: SHA-256 of Codex account_id plus JWT sub, or Grok user_id.
Identity claims are extracted from supplied native JSON, not remotely verified OAuth
claims. Missing/ambiguous identities fail closed. A unique D1 constraint prevents
concurrent duplicate uploads from creating separate lease slots. POST of an existing
identity reconnects its original row only if unleased and the caller can manage it;
credentials/label update while creator, scope, enabled state and health remain intact.
Leased, unauthorized or racing conflicting uploads return 409 `provider_account_conflict`.
Refresh via renew must preserve the identity hash (400 otherwise). Deduplication does
not span teams or accounts used outside this pool. Desktop/runtime agents own the
temporary credential installation, refresh serialization and cleanup lifecycle.

Verification: `teams-service/test/provider-accounts.test.ts` exercises real SQLite
SQL via the existing D1 shim (not deployed D1): role/scope/device/team checks,
concurrent claim exclusivity, refresh fencing, encryption/AAD/config failures,
health ordering, identity dedup/reconnect, validation and additive migration parity.
`cd teams-service && node test/provider-accounts.workerd.mjs` additionally exercises
the local workerd/D1 runtime: eight concurrent duplicate uploads create one account;
twelve simultaneous allocations produce one live lease and eleven conflicts. This
local test requires localhost sockets and makes no production deployment.

### Team Knowledge (separate content plane)

- **Not analytics.** Metrics upload stays aggregates-only forever.
- Tables: `kw_*` (migration `009_knowledge.sql`). Routes: `/api/teams/:id/knowledge/*` (settings, disclosure, overview, search, records, digests, promote, **export**).
- Default **disabled** until owner enables (`knowledge_mode`). MCP agent read defaults **off** and **official records only** (no digests in MCP Phase 1).
- **Disclosure accept** required before enable/share/promote. Best-effort DLP on share paths.
- Desktop: `teams_knowledge_*` + `teams_get/set/clear_project_bind`, `teams_knowledge_accept_disclosure`. Memory tab **Share to team** (promote or digest). Sticky bind → `AGMUX_TEAMS_TEAM` on MCP spawn.
- MCP tools (read-only, untrusted framing): `team_knowledge_status` / `overview` / `search` / `get` in `agmux-memory` sidecar. Must stay in `claude_allowed_memory_tools()`.
- Web: `#/t/:slug/knowledge` — search, records, digests, owner settings (incl. MCP filter), owner export JSON.
- **Backward compatible rollout:** `features.knowledge` only when `kw_*` exist and `KNOWLEDGE_ENABLED` ≠ `"false"`.
- Apply D1 migration: `wrangler d1 execute agmux-teams --remote --file=migrations/009_knowledge.sql` (and local).

---

## 1. Shape of the thing

Three pieces. They share an API contract and nothing else.

```
teams-service/          Cloudflare Worker + D1 + the web SPA   (the server)
src-tauri/src/teams/    scanner, aggregator, upload queue      (the only writer)
src/components/teams/   desktop React dashboards               (a reader)
```

- **Entirely separate from `remote-relay/`.** No shared bindings, no shared
  deployment. Device pairing and the `DesktopHub` Durable Object are untouched.
  Do not merge them.
- **The desktop app is the only thing that uploads.** The web surface reads.
- **Web is the source of truth for invites.** Desktop can join by pasting a link.

### Deployed resources

| | |
|---|---|
| Worker | `agmux-teams` |

**Platform staff (web only):** GitHub login `neelsatyavolu` can open any non-deleted team as a read-only preview (`staffPreview`). Desktop device tokens stay membership-only. Mutations 403. Identified by GitHub identity + `users.handle`, not display name.
| URLs | `https://teams.agmux.dev`, `https://agmux-teams.xanom.workers.dev` |
| D1 | `agmux-teams` — `31b8a340-eb82-41f1-b335-6bf82e097512` |
| DNS/TLS | provisioned by `custom_domain = true` in `wrangler.toml` |
| Cron | `[triggers] crons = ["7 * * * *"]` — budget threshold sweep + leaderboard PR sync |
| Migrations (desktop) | `029_teams.sql` (local state), `030_teams_scan_cursor.sql` |
| Migrations (D1) | `schema.sql` for a fresh DB; `teams-service/migrations/*.sql` for an existing one (`001`–`007`; `007_avatar_url` stores GitHub/Google profile photos) |

> **D1 schema changes are additive and manual.** `schema.sql` is
> `CREATE TABLE IF NOT EXISTS`, so it will not add a column to a table that
> already exists. New columns go in **both** `schema.sql` (fresh installs) and a
> numbered file under `teams-service/migrations/` (the live database), applied
> with `wrangler d1 execute agmux-teams --remote --file=…`. Those `ALTER`s are
> one-shot: re-running fails loudly with "duplicate column name", which is the
> right failure mode.

---

## 2. Where the data comes from

**Read timestamped provider history. Never `session_usage`, never
`thread_turns`.** Native JSONL/SQLite transcripts are preferred; Cursor, Gemini
chat and legacy MLX can use their persisted `agent_logs` activity when native
usage is unavailable. Missing token/cost reports must not be invented.

That is the single most important thing in this document. An earlier version
folded `session_usage` and shipped dashboards that were empty for most users and
wrong for the rest:

- `session_usage` is only written when the user **opens the Usage panel**. There
  is no background scan. Audited on a real machine: **0 rows in the last 48h**.
- Its `captured_at` is the *scan* time, not when the work happened.
- It holds one **cumulative** row per thread, so a three-day session dumps its
  whole lifetime into a single hour bucket.
- `thread_turns` exists in practice only for Grok. Claude had ~0 turns; Codex had
  no rows at all.

`src-tauri/src/teams/scan/` replaces all of that. It parses per event, carrying
the **real timestamp of the work**.

**Only agmux-created sessions (required policy).** A session needs exact creation
evidence. Current mutable thread or resume
pointers are not ownership evidence. Claude
Code / Codex / Grok used in their own apps or terminals are skipped. Native
Codex chats may have no `threads` row: their `session_meta.originator` must be
exactly `agmux` or legacy `xanom`. Do not infer ownership from cwd, prompt text,
or a parent session's shared ID. Additional providers require exact persisted
session bindings; `providers.rs` documents their sources and measured signals.
Native Claude ownership also imports the UI's explicit
`agmux-created-claude-sessions:*` records and only provider aliases mapped from
those created IDs into `teams_created_claude_sessions` (migration 041). This is a
frozen, one-time startup import, guarded by `session_origin_imports`; new UI
discoveries must not create backend ownership. Recovered creation records request
backfill.
Never claim sessions just because they were opened, share a cwd, or have a
per-session MCP config (resuming an external session can create that config).

**Future sessions use a backend registry** (migration 042): `session_origins`
stores provider, app owner ID, interaction mode and an immutable created/imported
decision. `session_origin_bindings` retains each exact provider session ID. These
records have no foreign key to mutable thread rows and survive tab/thread
removal. Record provenance at explicit create/import operations before work begins;
generic `create_thread` is not creation evidence because imports also use it.
Capture native bindings from provider responses and existing hook payloads,
independently of project-memory settings or frontend state. Do not promote an
imported origin during resume. Unknown legacy sessions need existing creation
evidence, not a guessed new label. `session_legacy_thread_claims` freezes the
pre-upgrade thread-row fallback; future unclassified rows are excluded.
Migration 044 freezes native SQL aliases and sets a cutoff for the one-time
legacy sidecar import. Sidecars modified after that cutoff cannot establish
legacy ownership. Explicit external records veto legacy claims. A new native
session created inside an imported tab gets its own creation record; the
imported session remains excluded.

For future app launches, Grok/Pi's backend-allocated native IDs are bound before
the PTY child starts. Cline uses its native persistence API to create an empty
session, binds it, saves the exact ID, then opens that ID in the TUI. These paths
do not depend on the first hook arriving. Ordinary resumes do not create
ownership; starting fresh under an unknown legacy owner leaves that owner
unknown and records the new native session separately. Cline's helper checks
native API capabilities and persisted artifacts rather than an exact version
number; its SDK defaults preserve first-time onboarding. Gemini terminal still
lacks a verified native creator contract; Gemini chat has explicit ACP creation.

**Strict legacy admission (Sep 12):** unknown legacy rows and frozen resume
aliases are review evidence only. They no longer default to created. Positive
ownership requires an explicit origin/native binding (or Codex's exact native
creator header); explicit imports veto inclusion. Retained unverified history
stays local until independently verified and is excluded from confirmed uploads.
The Sync pane reports unresolved legacy records and missing native bindings.
Do not blanket-confirm ownership to restore an old dashboard total.

Every complete successful snapshot prunes leftover hourly rows for that device.
Incomplete, deferred or dropped uploads must not prune. An empty authoritative
snapshot still stamps the upload before pruning obsolete rows. Upload responses
return the original server `acceptedAt`, including retries; the desktop sends
the earliest receipt across all chunks as `notBefore`. Missing receipt times
disable prune. Using a desktop timestamp could delete early chunks when its
clock was ahead. Server cutoff remains `min(notBefore, last_upload_at)`; neither
desktop wall-clock time nor prune-time `now()` is valid creation of that cutoff.

| Provider | File | Where usage lives |
|---|---|---|
| Claude | `~/.claude/projects/{enc_cwd}/{session}.jsonl` | `message.usage`, root `timestamp`, per-message `message.model`, `cwd` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `token_usage_record.usage` per response, exact logical `thread_id` and `response_id`; legacy `payload.info.last_token_usage` or cumulative `total_token_usage` |
| Grok | `~/.grok/sessions/{urlenc_cwd}/{id}/updates.jsonl` | `turn_completed.usage`, cumulative **within prompt_id**, with per-model splits |
| Pi / Local | `~/.pi/agent/sessions/…/{ts}_{id}.jsonl` | timestamped message usage and tools |
| Kimi | `~/.kimi-code/sessions/…/agents/main/wire.jsonl` | turn-scoped `usage.record`, not mirrored step totals |
| Cline | `~/.cline/data/sessions/*.messages.json` or task `ui_messages.json` | timestamped assistant metrics / request rows |
| OpenCode | `opencode.db`, exact session messages and parts | message tokens/cost; parts supply tools, not duplicate tokens |
| Gemini terminal / chat | native Antigravity conversation SQLite step metadata | timestamped generation input/output/cache-read/thought tokens; thoughts already included in output |
| Droid / Hermes | native transcripts / Hermes `state.db` messages | activity and reported tools; no fabricated token split |
| Cursor / Gemini chat / legacy MLX | app-owned `agent_logs` | timestamped output/tool activity when native history is unavailable |

### Tool activity — what each provider actually reports

`scan/tools.rs` normalises three different vocabularies into one taxonomy
(`bash` · `edit` · `read` · `search` · `web` · `agent` · `mcp` · `other`).
Unknown names fall to `other`, so the kind columns always re-sum to `tool_calls`.

| Signal | Claude | Codex | Grok |
|---|---|---|---|
| Tool name | `tool_use.name` | `function_call` / `custom_tool_call` `.name` | first word of `update.title` |
| Outcome | `tool_result.is_error` — every call | **none** except edits: `patch_apply_end.success` / `FileChange` item `status` | `tool_call_update.status` |
| Lines ± | `Edit` / `Write` / `MultiEdit` inputs (merged across a response's lines, deduped by `tool_use.id`) | `changes` (`unified_diff` / `content`) on `patch_apply_end` or, in current Codex, `item_completed` `FileChange` items (deduped by call/item ID) | `rawInput` old/new strings |

Traps here, each verified against real logs before the code was written:

- **Grok's `update.kind` is null on 2103 of 2113 calls.** Reading it gives an
  empty chart. The tool name is the first word of `title`, which is either a raw
  name (`search_replace`) or a prettified phrase (``Edit `/abs/path` ``). Only
  that first word is read — the rest is a path.
- **Codex reports no general tool outcome.** `function_call_output` is a text
  blob that says "Script completed" whether the command exited 0 or 1. So
  `tools_measured` is a **separate denominator** from `tool_calls`, and the
  error rate is `errors / measured`. Dividing by `tool_calls` would score every
  unobservable Codex call as a success. When nothing is measurable the rate is
  `null` and the UI says "not reported" — never 0%.
- **Grok tool lines are skipped by the usage path** when a turn shows no token
  growth, so the tool signal is extracted *before* the `delta == 0` check.
- **`files_changed` counts operations, not distinct files.** The server sums
  buckets, and a distinct-file count is not summable — two hours that each
  touched the same three files are not six files, but any sum says so.
- Claude tool *results* arrive on the user line **after** the assistant message
  that issued them, so outcomes are credited back to the previous event.
- A `Write` (or Grok `write`) can only count added lines: the log does not say
  what the file held before.

### Per-provider traps (each of these cost a debugging cycle)

- **Codex `total_token_usage` is cumulative.** Difference it with a saturating
  subtract, or a compaction reset produces negative usage. `last_token_usage` is
  the per-turn figure and is preferred.
- **Reasoning is a subset of output** for Codex, Grok, Gemini and Pi. Never add it to the total a second time. OpenCode newer split-output records are normalized using their reported total; ambiguous old records are not guessed.
- **Codex fork children do not inherit the parent's final counters.** Native response
  records use their exact logical `thread_id`, even when retained before the
  projection boundary. Deduplicate `response_id`; those records replace legacy
  mirrors for the same `turn_id`, since their cumulative bases can differ.
  Legacy copied prefixes use the native ordinal boundary when available, with
  creation timestamps as the legacy fallback. Copied counters establish a
  baseline, never another charge. Missing responses remain partial coverage.
- **Claude subagent files belong to their exact parent.** Include `{owned-parent}/subagents/agent-*.jsonl`, keep parent/child accounting identities distinct, and reconcile copied message/request IDs across files.
- **Grok totals are per prompt, not session.** Deduplicate event IDs and difference each prompt/model independently. Context `totalTokens` is activity, not billable input or cache usage.
- **Grok usage is in `updates.jsonl`, not `chat_history.jsonl`.** The chat file
  has the conversation and no usage at all.
- **Grok's `timestamp` is a numeric Unix epoch, not RFC3339.** Reading it with
  `as_str()` silently drops 100% of Grok events.
- **Grok's per-session model is `current_model_id` in `summary.json`** — not
  `model`, not `config.model`. The wrong key returns empty for every session and
  silently prices everything at the fallback rate.
- **Claude `<synthetic>` models** are Claude Code's own messages; skip them or
  they pollute the model mix.

### Scan window and retention

| Layer | Window | Notes |
|---|---|---|
| Desktop walk | **`SCAN_WINDOW_DAYS = 90`** | Files older by mtime are not scanned |
| Event filter | same 90 days | Events outside the window are dropped before fold |
| Server | **`RETENTION_DAYS = 90`** | `trimRetention` on ingest |
| UI ranges | 7 / 14 / 30 / 90 + custom ≤ 366 | Custom beyond retention is empty past 90d |

First link / full "Sync now" can backfill the full 90 days of on-disk logs so the
dashboard ranges match what managers can actually fetch. Keep desktop and server
windows aligned when either changes.

### Incremental scanning

Parsed events are cached in memory by file size and modification time. Changed
files are reparsed whole; **every scan returns the complete retained snapshot**.
Returning only changed sessions would overwrite an hour's absolute counters and
lose unchanged sessions. Persisted byte cursors cannot restore those counters
on restart and are no longer used. Codex rollouts stream from disk, including
large files; transcript text is never kept in the cache. Claude and Grok also
stream long logs, rather than dropping files at a size cutoff. Configured Claude
homes, known Cowork homes and Codex active/archived roots retain the same strict
ownership checks.

Migration 043 stores normalized timestamped per-session usage snapshots locally
for 90 days. They contain counters and short labels, no prompts/replies/tool
arguments. Fresh snapshots replace old ones; repeated scans do not add totals.
Previously observed usage survives provider log removal and app restart;
explicit external ownership still excludes it. This cannot reconstruct reports
that disappeared before agmux ever observed them. Scanner repair revision 5 rebuilds corrected counters on upgrade. Migration 045
versions normalized snapshots: old Codex snapshots without readable source logs
remain local pending revalidation. A successfully reparsed empty source clears
old copied counters; a missing source does not mean an empty history.

Snapshot retention reads metadata first, then loads one required fallback JSON
payload at a time. Freshly observed, unverified, excluded and obsolete-revision
payloads are not loaded just to discard them. JSON decoding/encoding and final
Claude reconciliation run on blocking workers; complete verified event history
still feeds aggregation. Do not cap events or drop missing-file fallbacks to
reduce memory. This avoids a whole-database JSON copy, not all event-memory cost.

The audit and remaining coverage limits are in
`docs/teams-token-audit-2026-09-08.md`.

Manual and automatic syncs are serialized. Old queued snapshots drain before a
new one is enqueued. Scanner revision 5 (the existing integer
`agmux_sessions_only` marker) triggers a full repair after upgrade, and is saved
only after all batches and pruning succeed. Failed/deferred/dropped batches
must not permit pruning a partially uploaded snapshot.

---

## 3. Aggregation rules

Provider mix keeps every provider with tokens or active time visible by name,
even below 3%. Only the model mix folds the small long tail into “Other”.

`src-tauri/src/teams/aggregate.rs` folds events into hourly buckets. It is pure
and heavily tested — put arithmetic there, not in the scanners.

- **Tokens land in the hour they happened.** Not the scan hour.
- **Session activity** is one count per provider/session/hour with recorded
  activity, deduplicated across model/project buckets. It is not distinct
  conversations over an arbitrary range. Web/desktop labels and CSV
  `active_session_hours` use this meaning; the compatible wire field is still
  `sessions`. Session timelines are provider-scoped. It is the denominator for
  the per-hour rates only.
- **Sessions** (`sessionsStarted` on the wire, D1 `sessions_started`, migration
  016) is the count shown as "Sessions": each top-level session +1 in the bucket
  of its first retained event, so any range sums to distinct sessions started
  in it. Codex subagent/auto-review threads (`source.subagent`) and Claude
  `subagents/` files are excluded; their tokens still count. Grok children are
  never separate sessions (their usage rolls into the parent). NULL = uploaded
  by a desktop that predates the field: the UI shows "N+"/"(partial)", CSV a
  blank, and the delta is null — never a zero. Apply migration 016 before
  deploying a Worker that writes it (uploads 500 otherwise; see compat test).
- **Active time** = gaps between a session's consecutive events, each capped at
  `ACTIVE_GAP_CAP` (5 min) so idle does not count, plus `ACTIVE_TAIL` (30s) for
  the final event. The disclosure promises "idle excluded" — honour it.
- **The per-session timeline must NOT be keyed by hour.** Doing so makes
  cross-hour gaps vanish (13:58 → 14:01 measured as two isolated events).
- **Concurrency is a max, never a sum.** Two sessions that each ran ten minutes
  in the same hour are not "two concurrent" unless they actually overlapped.
  The sweep spans every session in the hour (any provider/model/project), and
  each bucket carries that hour's peak.
- **A span that straddles an hour boundary is split** across both buckets.
- **After-hours / weekend** are judged per slice in the **member's own IANA
  timezone** (outside 08:00–18:00; Sat/Sun) — not UTC and not the manager's
  zone. Desktop resolves the OS zone via `iana-time-zone` + `chrono-tz`
  (`teams::aggregate::member_tz`). The same zone name is uploaded with each
  batch and stored on `users.timezone` so dashboards can label it
  (`Asia/Tokyo` vs `America/Los_Angeles`). Team heatmaps use each bucket's
  precomputed `local_hour` / `local_dow`.
- Future-dated events are dropped — clock skew must not create future buckets.

---

## 4. Cost

Unresolved local ownership/binding/snapshot coverage marks outgoing cost as
partial, preserving known dollars. The Sync pane describes excluded records;
token cards explicitly describe measured, verified coverage. Grok/Cline internal
new-session transitions and Gemini terminal still need reliable provider
creation signals; missing logs or usage reports cannot be invented.

Teams and the local Usage panel share the rate calculator in
`commands/usage_stats.rs`; compare identical source cohorts, since their
eligibility and available records differ. Cost is a **reported value or current
standard API-equivalent estimate**, not subscription spend or an invoice.

The September 8 audit verifies exact model rates against official provider
pricing pages. See `docs/teams-pricing-verification-2026-09-08.md` for the model
matrix, sources, date and limitations. Do not use arbitrary family matches:
older Opus/Haiku versions have different rates; Composer is not Grok; unknown
variants must not inherit a flagship tariff. Grok's premium begins at 200,000
prompt tokens inclusive; applicable OpenAI premiums begin above 272,000.
Request-level thresholds must never be applied to an hourly/session sum.
On September 22, GPT-6 Sol and Luna were added at OpenAI's published standard
rates (input / output / cache read / cache write per MTok: 2 / 10 / .2 / 2.5
and .1 / .5 / .01 / .125), and Claude Opus 5.5 at Anthropic's 4 / 20 / .2 / 5.
The local Usage pricing revision is 5 so retained source logs can be repriced;
Teams uses the same calculator on its next full snapshot scan. See the
[OpenAI Sol](https://developers.openai.com/api/docs/models/gpt-6-sol),
[OpenAI Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), and
[Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) pricing pages.

Catalog fallback uses exact IDs or unambiguous bare slugs. Missing cache rates
remain unknown, expired catalogs are not certified, and conditional tariffs
cannot be guessed from their base rate. `estimate_token_cost_checked` exposes
missing-price reasons. The older numeric contract still encodes unavailable
estimates as zero: that is **not evidence of free usage or complete cost**.
Provider-reported cost, including an explicit zero, takes precedence over local
estimates. It may itself be the provider's estimate rather than a billed charge.

**Grok reported cost is authoritative.** Sum `costUsdTicks / 1e10` from the
per-prompt usage deltas. Missing cost ticks remain unreported: do not price a
multi-request total as one long-context request or invent billing from context
growth. This applies to non-xAI models used through Grok too.

---

## 4b. Manager surface

Everything below reads from the same aggregates; none of it collects anything
new beyond the tool/output counters in §2.

**Budget + forecast + alerts** — `src/routes/budget.ts`, tables `team_budgets`
and `budget_alerts`.

- Owners set the budget (`budget.manage`), managers read it (`budget.view`),
  employees never see team spend.
- The forecast is a **straight-line run rate** (`budgetStatus` in
  `aggregate.ts`): spend-so-far ÷ days-elapsed × days-in-month. Deliberately
  simple — a manager can check it in their head. Day one counts as a whole day,
  or the projection explodes on the 1st.
- A budget of `0` **clears** the row. There is no such thing as a $0 budget:
  it would render every team as instantly over.
- Alerts fire **once per threshold per month**, enforced by the `budget_alerts`
  primary key, not by the cron cadence. `[triggers] crons` runs hourly; that
  bounds how quickly someone hears, not how often.
- The webhook URL is write-only over the API — it can embed a secret, so only
  `hasWebhook: true/false` is ever returned. Delivery failure is recorded
  (`delivered = 0`), not retried.

**CSV export** — `src/routes/export.ts`, `GET /api/teams/:key/export.csv`.

- `range`/`from`+`to` and `granularity=day|hour`. Owners and managers get the
  team; an employee is silently rescoped to their own rows, matching
  `teamOverview` rather than 403ing.
- `csvCell` prefixes `=`, `+`, `-`, `@` with `'`. A display name is a place
  someone can hide a formula that Excel executes when the manager opens the file.
- Every export writes a `data.exported` audit entry — egress is the thing a
  security review asks about.

**Audit log** — `src/routes/audit.ts`, table `audit_log`.

- Records membership, roles, invites, budget changes and exports. **Never
  telemetry**: `detail` is a short server-authored string, never client input.
- `writeAudit` swallows its own errors on purpose. A failed audit insert must
  not roll back the role change the user actually asked for.
- Owner + manager read (`audit.view`); loaded as a second request so it is never
  why the dashboard is slow to paint.

## 5. Invariants — do not break these

**The upsert replaces, it does not add.**
`ON CONFLICT … DO UPDATE SET tokens_in = excluded.tokens_in, …`. The desktop
sends *absolute* counters per bucket, so a retried batch converges. Making it
additive inflates every number on every retry. Pinned by
`teams-service/test/metrics.test.ts`.

**No content in analytics, ever.** Analytics tables cannot store prompt text.
Explicit Knowledge sharing and encrypted team provider accounts are separate planes.
`metrics.ts` drops any label containing a path separator. `project_key` is a
basename or an opaque hash.

**Honest state — never render a zero where the truth is "we don't know yet."**
Never-synced members collapse to one sentence instead of a row of zeros. Missing
days break the chart line rather than interpolating. This is why approval and
stop-rate metrics were *removed*: `thread_turns` has no approval data, and the
Stop hook closes turns as `done`, so both read zero forever. Do not re-add them
without a real signal.

**Disclosure copy is duplicated on purpose** — `teams-service/web/disclosure.js`
and `src/components/teams/disclosureCopy.ts` must stay word-identical in
`SHARED` / `NEVER`. (The `*_SHORT` lists are deliberately terser on desktop,
where the join modal is narrower.) **If you collect a new field, add it to both
before shipping**; if you stop collecting something, remove it from both.

**The error rate divides by `tools_measured`, never by `tool_calls`.** See §2 —
Codex reports no outcome for most calls. A rate over the wrong denominator is a
number that reassures without being true.

**`run_worker_first = ["/api/*"]` in `wrangler.toml` is load-bearing.** With SPA
`not_found_handling`, Cloudflare's asset layer answers navigation requests
(`Accept: text/html`) *before* the Worker runs, so a browser hitting
`/api/auth/github/start` gets `index.html` and OAuth silently dies.

**D1 allows 100 bind variables per statement.** Use `DB.batch()` with single-row
statements, not multi-row `VALUES`. The test shim enforces the limit.

**Roles are checked on every route** via `authz.ts`. owner / manager / employee.
v1 invites are owner-only. Employees see their own stats — `teamOverview`
silently rescopes rather than 403ing.

**Manager scope (groups + people).** Owners can limit a manager to specific
people and/or named groups. Tables: `team_groups`, `team_group_members`,
`manager_scope` (migration `002_groups_and_manager_scope.sql`). Semantics:

| Who | Analytics |
|---|---|
| Owner | Entire team always |
| Manager, **zero** `manager_scope` rows | Entire team (**default** — seamless for existing managers) |
| Manager, with scope rows | Union of direct people + people in assigned groups + self |
| Employee | Self only |

Owners configure via Settings → Groups + Members “Edit scope”. Scoped managers
see a partial overview (filtered members/CSV); team budget and audit log stay
whole-team and are hidden for them. Capabilities `group.manage` /
`scope.manage` are owner-only.

---

## 6. Verifying changes

This feature has produced a specific class of bug repeatedly: **the pipe looks
fine, but no real data flows through it.** Fixture tests passed cleanly while
production was empty, four separate times.

So:

- **`teams::scan::tests::live_parses_real_provider_logs`** runs the real parsers
  over the developer's own logs and asserts each provider yields events with
  non-zero tokens. Run it with `--nocapture` to see the numbers. It caught Grok
  returning zero twice. Keep it.
- **Test API routes with an HTML accept header**, not plain `fetch` —
  `curl -H 'Accept: text/html'`. `fetch` sends `Accept: */*` and sails past the
  asset layer that breaks real browsers.
- **Verify against the source, not the status code.** A 302 from
  `/api/auth/*/start` proves nothing about the client secret; only the token
  exchange does.

```bash
# Worker
cd teams-service && npm run typecheck && npm test     # 159 tests
# Desktop
npx tsc --noEmit && npm run test -- teams
cargo test -p xanom teams:: -- --nocapture            # includes the live log parse
```

Pre-existing failures unrelated to Teams: `npm run test` has 8 failing files;
`cargo test` has 3 (`grok_usage_tests::parses_grok_web_billing_sample`,
`mlx::tools`, `remote::timeline::live_sessions`). Compare against those baselines
rather than expecting green.

---

## 7. Local development

No Cloudflare account, no OAuth apps, no second person needed:

```bash
cd teams-service
npx wrangler d1 create agmux-teams --local   # one-off
npm run db:local
npm run dev                                  # http://localhost:8787
```

A dev toolbar appears: **Sign in as You** → **Seed demo team** → **View as
owner/manager/employee**. The seed creates 8 members and ~1,900 hourly buckets
across 90 days, deliberately including a never-synced member, a stale member, and
an after-hours-heavy member so every honest-state case is exercised.

Desktop against local: `AGMUX_TEAMS_URL=http://localhost:8787 npx tauri dev`.

**Dev mode needs two signals, both set only by the `dev` script:** `DEV_AUTH=true`
*and* a local `APP_ORIGIN`. It deliberately does **not** check the request
hostname, because `wrangler dev` simulates the custom-domain host once `routes`
is configured. Failures return 404, not 403, so the routes are invisible.

---

## 8. Reference

### Manager-surface routes

`GET /api/teams/:key/export.csv` · `GET|PUT /api/teams/:key/budget` ·
`GET /api/teams/:key/audit`

### Tauri commands (`src-tauri/src/commands/teams.rs`)

`teams_link_start` · `teams_link_claim` · `teams_sign_out` · `teams_get_status` ·
`teams_list_queue` · `teams_refresh` · `teams_sync_now` · `teams_preview_payload` ·
`teams_overview` · `teams_self_view` · `teams_member_detail` · `teams_leave` ·
`teams_preview_invite` · `teams_accept_invite`

### Upload path

`teams::spawn_auto_uploader` (started in `lib.rs`) fires every **2 minutes**.
Each tick no-ops unless the user is linked and on a team, so it costs nothing for
users who never touch Teams. `scan::collect_events` →
`aggregate::build_buckets` → `uploader::enqueue` → `uploader::flush`, with a
persisted queue and exponential backoff. `teams_sync_now` is the manual path
(full-window rescan). `enqueue` splits payloads into ≤ `MAX_BUCKETS_PER_BATCH`
(1800) chunks so a 90-day resync stays under the Worker's 2000-bucket cap.

### Device linking

`teams_link_start` mints a one-shot code → the app opens
`/link?code=…` → after sign-in the page calls **`POST /api/auth/device/attach`**
→ `teams_link_claim` polls and receives the bearer token.

The attach step binds the code at the `/link` page rather than threading `?link=`
through the OAuth round trip. The original design did the latter and the code was
never carried, so the desktop polled forever while the web page cheerfully
claimed "Desktop app linked" without checking. Do not reintroduce that.

### Secrets

Installation identity lives separately at `~/.agmux/teams/device-id.txt`. Adopt
an existing credential's device ID before sign-out deletes authentication;
relinking reuses that ID. A new ID for the same history would create duplicate
server rows because idempotency is device-scoped. Never merge different devices
or delete old device rows merely because their aggregates look similar.

Device token lives at `~/.agmux/teams/credentials.json` (`0600`), matching
`remote::auth`. `teams::secret_store` is the only seam — the macOS keychain is a
deliberate follow-up, since it needs a `keyring` dependency and a codesign
entitlement review.

OAuth client secrets are Worker secrets (`wrangler secret put`), never committed.

---

## 9. Open follow-ups

- Provider creation/reporting gaps and unavailable historical sources remain visible coverage limits (see §2 and §4).
- Device token is a `0600` file, not the macOS keychain.
- Google consent screen shows *Xanom* branding (the OAuth client lives in the
  existing Xanom GCP project).
- `lucide` icons load from a pinned CDN in the SPA rather than being vendored, so
  the dashboard is not fully offline-capable.

## 10. Execution restrictions

`/api/teams/:key/policy` is a separate configuration plane. `enforcementVersion: 2`
identifies the enforced allowlist contract. `allowedProviders`, `allowedModels`,
`allowedModes` (`chat` / `terminal`), and `allowedEfforts` are nullable lists:
**null means unrestricted; [] means deny everything**. Never convert an empty
intersection into unrestricted access. Legacy empty provider/model arrays migrate
to null; new writes preserve intentional empty lists.

Owners edit the team baseline. Each manager edits their own additional layer;
it applies dynamically to active employees within their existing analytics scope
and to themselves, never to owners or other managers. Removing a manager's role
or membership removes their layer from effective evaluation. The API returns the
caller's effective `policy`, their `editablePolicy`, `canManage`, and `scopeLabel`.
Staff preview is read-only. All applicable layers and team memberships intersect.

Desktop enforcement lives in `src-tauri/src/teams/policy.rs` and shared execution
boundaries. Linked execution resolves memberships plus every effective policy;
success is cached in memory for up to 30 seconds. Everything is allowed by default:
missing policies or policies with all four allowlists null do not block execution
when verification is unavailable. That fallback is also cached for 30 seconds.
Explicit restrictions (including empty allowlists) still require verification;
failed or partial refreshes must retain every known restriction. Only a retained
restricted policy requires reconnecting after sign-out. Corrupt caches remain
errors, not unrestricted defaults. No Teams linkage/cache means no network
requirement. Service migration and updated service enable configuration of rules.

Rules govern agmux-controlled session modes and top-level configuration. Terminal
sessions are unavailable under model/effort restrictions because initial CLI flags
do not prevent later internal changes. Unknown required model/effort configuration
is rejected. Reading history and canceling work remain available. Policies do not
stop already-running turns, control internal agent subagents, or manage external
apps/OS credentials. Do not describe these controls as MDM or a provider billing
firewall. Existing permission defaults, MCP lists and spend fields are not proof
of enforced limits and must not be advertised as such.

The dedicated Teams Restrictions page (`#/t/:slug/restrictions`) has explicit unrestricted controls,
separate mode/agent/model/effort sections, a review summary, and guarded load/save
states. Keep API authorization authoritative; frontend filtering is presentation.

Claude and Codex chat support explicit model/effort settings. Cursor, OpenCode,
and local MLX support model rules only; Grok/Gemini strict model/effort settings
remain unavailable until their effective configuration is verifiable. Local
models use canonical `local/<id>` policy IDs (OpenCode variants are not part of
the model ID). The shared local gateway checks provider/model/effort without
inventing a chat/terminal mode; mode is checked at the session execution boundary.
Generic shells are unavailable when they cannot satisfy agent or mode rules.
