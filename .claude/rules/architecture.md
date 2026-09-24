# Architecture (reference)

Read when you need interaction modes, PTY/SDK/MLX behavior, hooks, app modes, or DB tables. Keep `AGENTS.md` short — do not copy this wholesale into agent instructions.

## Interaction modes

Stored per-thread in `threads.interaction_mode` (default `pty`):

| Mode | Value | Notes |
|------|-------|-------|
| PTY | `pty` | portable-pty + xterm Canvas |
| Claude SDK | `sdk` | Node sidecar per thread → `sdk-event-{threadId}` |
| OpenCode SDK | `opencode-sdk` | One shared Node process, multiplexed |
| Cursor SDK | `cursor-sdk` | One shared Node bridge, multiplexed → `sdk-event-{threadId}` |
| MLX | `mlx` | In-process loop + `mlx_lm.server` |
| Grok SDK | `grok-sdk` | ACP `grok agent stdio` → same `sdk-event-{threadId}` |
| Gemini chat | `gemini-sdk` | Antigravity ACP `agy_acp_server` → same `sdk-event-{threadId}` |

## PTY

- Spawn/read/kill: `src-tauri/src/process/` — blocking `std::thread`, never tokio for I/O
- Flusher: condvar-driven coalesce (16ms on-screen / 100ms otherwise); idle parks with zero CPU. On-screen = window focused AND that session is the active tab. Cmd+Tab does not set `document.hidden` on WKWebView. Hidden running sessions skip JS decode and catch up from the ring-buffer snapshot when shown.
- 1MB ring buffer → `getPtySnapshot(threadId)` for xterm rehydrate
- Kill: SIGTERM → 500ms → SIGKILL; global `SPAWN_LOCK` serializes spawns

## SDK / Cursor / Grok / MLX

- Claude/OpenCode/Cursor: JSON-RPC stdin/stdout — protocol in `.claude/rules/sidecar.md`
- Cursor: `commands/cursor_sdk.rs` + `sidecar/cursor-sdk-bridge.mjs` (shared bridge; events on `sdk-event-{threadId}`)
- Grok: `src-tauri/src/grok/`; permission mode client-side; effort via `--reasoning-effort`
- MLX: `wire_model` at spawn must match request `model`; mutating tools need approval; orphan/exit cleanup required
- MLX backends (`mlx/backend.rs`): `sitecustomize.py` applies catalog `kv_bits` and caps mlx-lm's prompt-cache bytes. Never a rotating `max_kv_size` window — it drops the head of 15–30K-token agent prompts, can't be quantized or prefix-reused. `mlx/memory.rs` plans each model from its `config.json` (KV bytes/token over full-attention layers only; sliding layers capped at the window): cost = weights + active KV + saved prompt-cache copy + quantized prefill scores + overhead. It prefers 16-bit KV (faster, exact), then 4-bit with `--prefill-step-size 256`, then no saved copy, shrinking context toward the 32K floor. The same plan sets the declared context for Pi (`contextWindow`/`maxTokens`), OpenCode (`limit`) and Grok, the prompt-cache cap, and the pool's admission cost. Discovery sizes follow symlinks (HF snapshots). Readiness = a 1-token warm-up completion (`/v1/models` answers even when the generator thread is dead). Residency: a model above the shared budget may run alone up to RAM − 2 GB; the sweep unloads non-newest models only after 10 min idle.

## Hooks

- Relay scripts: `~/.agmux/hooks/`; Unix socket per app pid: `/tmp/xanom-hooks-{pid}.sock`
- Events: prompt-submit, pre-tool-use, stop, notification; HookDedup fingerprints

## App modes (UI)

- agent (default) Cmd+Shift+A · cowork (briefcase; own folder list — starts empty, user adds folders; Claude/ChatGPT Work desktop sessions attach to those folders; Opening Cowork overlay while lists load) · task Cmd+Shift+T · ide Cmd+Shift+.

## Database

- Path: `~/.agmux/agmux.db` (WAL; migrated from `~/.xanom/xanom.db` on first launch). Migrations: `src-tauri/migrations/` (`NNN_*.sql`, currently through 033+)
- Core types: `src/lib/types.ts`, `src-tauri/src/db/models.rs`
- Notable tables: projects, threads, agent_logs, session_usage, tasks, terminal_sessions, thread_journal_entries, prompt_logs, codex_approval_rules, agent_rooms, agent_room_members, agent_room_events, search_messages (FTS5), search_index_state, teams_approval_waits, thread_turns (+ `prompt_summary`), …
- In-app message search: FTS5 + BM25 in `src-tauri/src/search/` (migration `031`); content maintained by Rust, not SQL triggers

## Multi-Agent Rooms (headless — no UI)

Rooms are **plumbing only**: they group threads so agents can message and spawn each other. There is no room UI, no Orchestrator tab, and no Multi-Agent draft picker option (all removed). Migration `028_agent_rooms.sql` (027 is Kimi provider).

- **Entry point:** no user-facing launch path. The former draft provider `MultiAgent` / `launchMultiAgentFromDraft` path was removed; rooms are only created if something calls the room commands/RPC (e.g. agent `room_spawn`). Never route room work to a board — that path had no streaming.

- **Tables:** `agent_rooms` (name, `a2a_enabled`, `max_a2a_rounds`), `agent_room_members` (room↔thread), `agent_room_events` (board timeline). Delete room cascades members + events.
- **Human @send:** `send_agent_room_message` still exists (Rust command, `@mentions` → `dispatch::send_to_thread` per target) but has no caller now that the board is gone — humans talk to the main agent in its normal chat.
- **A2A:** `post_agent_room_a2a` with per-pair round cap (`max_a2a_rounds`, default 4); over cap → system board event + error. Reply threads (Traycer-style): `rooms::a2a::post_a2a_ext` mints/reuses a `responseId` when `expect_reply` (meta `expectReply`/`responseId`/`inReplyTo`); one reply closes the thread.
- **Agent-initiated A2A:** member agents get `room_members` / `room_send` / `room_read` / `room_spawn` MCP tools (memory MCP bundle) → Unix socket `~/.agmux/room.sock` (`rooms::rpc::RoomRpcServer`, methods `room.context`/`room.send`/`room.read`/`room.spawn`) → same `post_a2a_ext` policy path. Identity = `AGMUX_THREAD_ID` (or Codex active-thread fallback / explicit `thread_id` arg). `room_read` excerpts the member's `agent_logs` (ANSI-stripped; terminal members expose raw scrollback, Codex chat / Grok SDK log prompts only → `repliesRecorded: false`). Design: `docs/room-a2a-autonomy-design.md`.
- **Gotcha:** every new memory-MCP tool must also be added to `memory::claude_allowed_memory_tools()` — Claude SDK passes that list as `--allowedTools`, so an omitted tool triggers a human approval prompt on each call (fatal for autonomous A2A). Covered by `memory::tests::allowed_tools_cover_room_a2a`.
- **Delivery:** shared `src-tauri/src/dispatch` (SDK/chat surfaces or PTY). PTY is best-effort resume + inject; delivery failures reported per target, board event still kept when targets resolve.
- **Spawn:** `room_spawn` creates a teammate thread (Claude `sdk` or Grok `grok-sdk` only — Codex chat needs a UI-minted app-server thread), adds it as a labelled member, writes a `system` join event, then delivers its first task through `post_a2a_ext` (delivery starts the session).
- **UI:** none. Rooms/Orchestrator components were deleted; `agent_room_events` is a record, not a rendered board.
- **Out of scope:** multiplayer / multi-user collaboration.

## Product analytics (owner.agmux.dev)

Anonymous install heartbeats + allowlisted event counters. **Not Teams.** Worker: `analytics-service/` (D1 `agmux-owner`). Desktop: `src-tauri/src/product_analytics/` + `productAnalyticsEnabled` (default on). Never prompts, paths, project names, or account ids. Dashboard is GitHub-login allowlisted (`neelsatyavolu`) / optional password.

## Teams (org analytics)

Separate Cloudflare service — **not** `remote-relay`, no shared bindings, device pairing untouched. Spec: `docs/superpowers/specs/2026-07-29-teams-analytics-design.md`.

- **Service:** `teams-service/` — Workers + D1. `src/` (router, oauth, authz, invites, metrics, aggregate), `schema.sql`, `web/` (vanilla SPA porting the design 1:1), `test/` (vitest, `node:sqlite`-backed D1 shim).
- **Desktop:** `src-tauri/src/teams/` (`aggregate.rs` pure hourly folding, `uploader.rs` queue + backoff, `secret_store.rs`), commands in `commands/teams.rs`, migration `029_teams.sql`. UI: `src/components/teams/` + `settings/TeamsSection.tsx` / `TeamsSyncSection.tsx`.
- **Telemetry invariant:** hourly aggregates only — counters and short labels. No prompt text, replies, diffs, file contents, absolute paths, or secrets. `project_key` is a basename or opaque hash; `metrics.ts` drops anything containing a path separator.
- **Source of truth is the provider logs, NOT `session_usage`.** `teams::scan` reads `~/.claude/projects/**.jsonl`, `~/.codex/sessions/**/rollout-*.jsonl` and `~/.grok/sessions/**/updates.jsonl` per event, with each event's own timestamp. `session_usage` is only refreshed when the user opens the Usage panel and stamps rows with the *scan* time — using it produced empty dashboards and a wrong heatmap. Scans are incremental via `teams_scan_cursor` (byte offsets; migration 030).
- **Per-provider gotchas:** Codex `total_token_usage` is cumulative (difference it; `last_token_usage` is per-turn) and is the only provider reporting `reasoning_output_tokens`. Grok usage lives in `updates.jsonl` at `params._meta.totalTokens` (not `chat_history.jsonl`) and its `timestamp` is a **numeric epoch**, not RFC3339. Claude carries per-message `model` + `cwd`.
- **Tool activity** (`teams::scan::tools`) normalises tool names into a fixed taxonomy (bash/edit/read/search/web/agent/mcp/other); unknown names go to `other` so the kinds re-sum to `tool_calls`. Grok's `update.kind` is null on ~99.5% of calls — use the first word of `title`. **Codex reports no general tool outcome**, so `tools_measured` is a separate denominator and the error rate is `errors / measured`, `null` when nothing was measurable. `files_changed` counts operations, not distinct files (a distinct count isn't summable across buckets).
- **Manager surface:** budgets + straight-line forecast + once-per-month threshold alerts (`routes/budget.ts`, hourly `[triggers] crons`), CSV export (`routes/export.ts`, formula-injection guarded, employees auto-rescoped), and an audit log (`routes/audit.ts`, membership/roles/invites/budget/exports — never telemetry).
- **D1 schema changes are manual and additive:** `schema.sql` for a fresh DB *and* a numbered file in `teams-service/migrations/` for the live one.
- **Active time** is derived from gaps between a session's consecutive events, capped at `ACTIVE_GAP_CAP` (5 min) so idle doesn't count, plus a 30s tail for the last event. The session timeline must NOT be keyed by hour, or cross-hour gaps vanish.
- **Upload cadence:** `teams::spawn_auto_uploader` (started in `lib.rs`) flushes every 2 min; each tick no-ops unless linked and on a team. `teams_sync_now` is the manual path.
- **Approval wait metrics (not stop-rate).** `teams_approval_waits` (migration `033`, `teams::approval_wait`) samples blocked time only — no prompts, paths, or tool args. Open rows (`resolved_at` NULL) are in-flight; closed rows feed hourly `approval_requests` + `approval_wait_ms` on upload. Stop-rate is still not measured (Stop hook closes turns as `done`).
- **Idempotency:** the desktop sends *absolute* counters per bucket and the server **replaces** rather than adds (`ON CONFLICT … DO UPDATE SET x = excluded.x`), plus an `upload_receipts` ledger keyed `(device_id, batch_id)`. Retries converge; never make the upsert additive.
- **Roles:** owner / manager / employee, checked on every route via `authz.ts`. v1 invites are owner-only. Employees see their own stats only — `teamOverview` silently rescopes rather than 403ing.
- **Honest state:** never render a zero where the truth is "no data yet". Never-synced members collapse to one sentence; missing days break the chart line instead of interpolating.
- **Disclosure copy** lives in exactly two places whose `SHARED`/`NEVER` lists must stay word-identical: `teams-service/web/disclosure.js` and `src/components/teams/disclosureCopy.ts`. Collecting a new field means updating both before shipping.
- **Device token:** `~/.agmux/teams/credentials.json` (0600), matching `remote::auth`. Keychain is a deliberate follow-up — `teams::secret_store` is the only seam.
- **`run_worker_first = ["/api/*"]`** is load-bearing: with SPA `not_found_handling`, the asset layer serves `index.html` for `Accept: text/html` navigations *before* the Worker runs, which silently breaks OAuth (sign-in appears to do nothing). `fetch()` doesn't send that header, so scripted checks pass while the browser fails — always verify API routes with an HTML accept header.
- **Deployed:** Worker `agmux-teams` at `teams.agmux.dev` (custom_domain route provisions DNS/TLS on deploy) + D1 `agmux-teams`. OAuth is fully configured (GitHub app 3762739 + Google client in the Xanom GCP project) and the full sign-in round trip is verified. Local dev needs no Cloudflare account — see `teams-service/README.md`.

## Remote control

- Task agents use the regular remote session actions. Catalog task metadata joins by project ID + saved branch; never group unrelated projects by display name alone. `models.list` may carry `threadId` and `requestId`; resolve the selected session's actual working directory and echo correlation on snapshots/errors so late responses cannot replace another task's catalog. New task/git operations remain desktop-only.
- Canonical PWA: `remote-relay/public/app.html`; keep `index.html` identical. Visual language follows agmux.dev (Archivo, self-hosted in `public/fonts/` under OFL; blue = working, gold = needs you, green = done; gold = primary action) with a compact, Mac-density session list. Light mode is browser-tab only (`display-mode: browser`, no `data-shell`) because the installed PWA and Capacitor shell pin a white status bar. Headers pad with `env(safe-area-inset-top)`.
- Claude terminal queue overlay (`remote/timeline.rs` `scan_claude_queue`): Claude Code writes `dequeue` without `content` when it sends the front of the queue, so a content-less dequeue pops the oldest pending entry.
- Phone sends/creates carry `requestId`; desktop advertises `message-ack` and responds with `message.accepted` or a scoped error. Acceptance is dispatch completion, which is turn completion for blocking ACP/OpenCode calls but enqueue/start for Claude/Codex. Queue drain also checks processing/history; a dropped acknowledgment must not trigger automatic duplicate delivery.
- Approval and question IDs are scoped to thread IDs. Reconnect replay is deduplicated in the PWA. Claude answers use question text; Codex uses question IDs with answer arrays; OpenCode uses ordered arrays of choices.
- Regression commands and remaining provider coverage: `remote-relay/README.md`, `docs/remote-control-audit-2026-09-23.md`.

## Debugging

| What | How |
|------|-----|
| Rust logs | `RUST_LOG=xanom=debug npx tauri dev` |
| Hook socket | `nc -U /tmp/xanom-hooks-{pid}.sock` (or path printed at startup) |
| SQLite | `sqlite3 ~/.agmux/agmux.db` |
| PTY snapshot | `invoke('get_pty_snapshot', { threadId })` in DevTools |
| Sidecar stderr | `[sdk-bridge]` prefix in `tauri dev` console |

## Shared performance diagnostics

Settings → Debug Mode enables the app-wide recorder in `src-tauri/src/debug_mode.rs`. Agents read `debug_status` / `debug_recent` through the existing memory MCP, or `~/.agmux/debug/diagnostics.json` directly. Collection starts off; restart preserves the last capture. Five-second samples, ten-minute/120-record/2-MiB bounds; static operation labels and allowlisted executable categories only. CPU is OS-smoothed and summed RSS may double-count shared pages. Read `DEBUG_MODE.md` for freshness, coverage and interpretation. Do not add prompts, command arguments, paths or raw logs to this recorder.
