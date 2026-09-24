---
paths:
  - "src-tauri/**"
---

# Rust / Tauri v2 Rules (src-tauri/)

## Tauri Commands
- All commands use `#[tauri::command]` with `async` and return `Result<T, String>`
- Parameter names are `snake_case` in Rust — Tauri auto-converts to `camelCase` for JS
- Always `map_err(|e| e.to_string())` on anyhow errors for serialization
- Register every new command in `lib.rs` `invoke_handler![]`

## Crash safety
- Release builds use `panic = "abort"`, including background tasks. Validate external data before indexing or unwrapping; use `crate::text::byte_prefix` for byte-limited text diagnostics.
- Check decoded binary lengths against the remaining buffer before adding offsets (Gemini conversation metadata has regression coverage for oversized lengths).
- Objective-C exceptions cannot cross any Rust frame under `panic = "abort"` (not even `extern "C-unwind"`), so AppKit raising inside tao's `sendEvent:` override aborts the app. `native/send_event_guard.m` (installed by `appkit_guard::install` in `setup`) replaces that override with an `@try/@catch` version; caught exceptions and all panics land in `~/.agmux/logs/crash.log` via `crash_log`. Read that file first when the installed app dies with SIGABRT.

## Database
- Use `sqlx::query_as::<_, Model>()` with `FromRow` derive for typed queries
- All IDs are UUID v4 strings generated in Rust
- Migrations in `src-tauri/migrations/` with `NNN_name.sql` naming (currently 001–033+)
- Tables use `TEXT NOT NULL DEFAULT (datetime('now'))` for timestamps

## Shell diff statistics
- `shell_diff/` records supplemental live shell edits from concrete command targets plus actual before/after file contents. Native tool/transcript counters remain independent; the sidebar adds the supplemental totals only at render.
- Missing start events, unsupported/dynamic targets, overlapping writers, ignored/out-of-workspace files and unreadable/binary/oversized snapshots must not fabricate counts. Never reconstruct a before-image from current disk when replaying history.
- `shell_diff_events` is idempotent by owner/tool/file. Owner totals span provider sessions; native-session aliases expose only that session's totals. All backend provider event adapters must observe starts and completions before native edit tracking.
- Codex literal sequential exec wrappers include shell calls alongside memory helpers; heredoc bodies stay opaque. Yielded executor sessions retain their before-images until a matching `write_stdin` result completes them. A poll is related to its original command, but other writers still invalidate attribution. Late transcript starts never create a before-image, including fast polls that must still retain continuation identity.
- Wrapped `tools.apply_patch` contributes through Codex history, using the decoded literal patch plus its successful printed result. Preserve result positions, reject failed/unknown results, and deduplicate matching native patch events. Do not also count shell snapshots for a wrapper containing a patch. Confirmed patch history is recoverable without a live before-image.
- Native Codex sidebar totals must also publish from `codex/diff_stats.rs`, independently of mounted chat views. Edit completions and turn-end request coalesced, serialized background history reads; `codex-session-diff-updated` carries absolute native-session totals to the app-level `useThreadDiffUpdates` listener. Do not make background badges depend on a DB thread row or the selected conversation, or add idle history polling.
- Codex discovery follows every native catalog page and queues saved diff hydration through the same serialized worker, caching unchanged revisions and prioritizing live events. Parent totals include explicitly linked subagents (user-approved); aggregate stable edit identities and paths without counting copied history twice. Manual recalculation and automatic publication share the backend calculation; mounted views must not overwrite it with own-session-only totals.
- Both transports must feed that publisher: app-server events for Chat, and the exact-session JSONL watcher for Terminal (including safe native-history refresh at watcher attachment). A chat-only publisher leaves terminal edits stale until view-local refresh. Wrapped/native dedup must account for equivalent boundary blank-line placement and never count unconfirmed pending direct patches.
- Native Codex edits may be saved as `patch_apply_end` or `item_completed` with a `FileChange` item. Normalize both before history counting and deduplicate by native call/item ID; only completed edits earn counts. Both event formats must also trigger the global publisher.
- Wrapped/native equivalence must preserve ordered edits and use observed context when moving diff boundaries. Bound alternative states; never use unordered lines or counts alone. Native results replace earlier wrapper counts, and failed native results retract them without shifting pending history indices.
- Same-turn native patch ownership requires an exclusive outstanding literal patch, matching complete file set and successful printed result; only strictly parsed pure-read tails qualify. Test commands are executable code, not ownership proof. Extra diff context may come from a bounded immediately preceding retained read whose native before-hunks and file boundary match uniquely; never fetch today's disk to repair historical equivalence. Tool-call/output deduplication must include call identity, not content alone.
- Relative paths in an exclusively owned literal patch resolve only against the recorded absolute session cwd when matching the complete native file set. Reject traversal and unknown scope; keep native deletion contents authoritative so a zero-line wrapper deletion cannot create a duplicate file row.
- Preserve exclusive patch ownership across only same-turn, same-thread receipts for strictly read-only literal shell commands. Once ownership is proven, match exact resolved paths rather than suffixes. Diff file headers are metadata only before the hunk/patch body; `---` and `+++` content inside a hunk counts as edits. Missing or yielded command output never supplies an implicit zero exit status.
- A history read invalidated by concurrent writes gets at most two retries without another user event. Permanent/exhausted read failures publish `codex-session-diff-updated` with `{sessionId, unavailable: true}`; the listener preserves measured totals and marks history incomplete until a verified update arrives.

## PTY / Process
- PTY I/O is blocking — use `std::thread::spawn`, NOT tokio tasks
- Always use `master.try_clone_reader()` for the reader (don't consume the master)
- Process kill uses `nix` crate to send SIGTERM to process group, then SIGKILL
- `is_shutting_down` AtomicBool prevents error spam during graceful shutdown

## Claude SDK Sidecar
- Node.js sidecar at `sidecar/claude-sdk-bridge.mjs` wraps `@anthropic-ai/claude-agent-sdk`
- Rust manages sidecar via `commands/claude_sdk.rs` (and parallel grok_sdk.rs for ACP); many commands for session lifecycle, model, approvals, history, rewind
- Communication: JSON-RPC over stdin/stdout of spawned Node.js process
- Session state in `AppState.sdk_sessions`: `Arc<Mutex<HashMap<String, SdkSessionContext>>>`
- Events emitted as `sdk-event-{threadId}` to frontend via `app_handle.emit()`
- Sidecar bundle built with esbuild: `sidecar/build.mjs` → `sidecar/dist/claude-sdk-bridge.bundle.mjs`

## Cursor SDK Bridge
- Node bridge at `sidecar/cursor-sdk-bridge.mjs` wraps `@cursor/sdk` (native runtime copied via `copy-cursor-runtime.mjs`)
- Rust: `commands/cursor_sdk.rs` — one shared `CursorBridge` multiplexes all Cursor threads
- State: `AppState.cursor_sdk_bridge` + `cursor_sdk_sessions`
- Events normalized to `sdk-event-{threadId}` (reuses Claude SDK UI adapters / `CursorSdkSessionView`)
- Bundle: `sidecar/dist/cursor-sdk-bridge.bundle.mjs` (external `@cursor/sdk` + platform natives)

## AEL (Agent Experience Layer)
- `src-tauri/src/ael/` — LLM provider abstraction and prompt optimization
- Prompt pipeline: optimizer → context_detector → prompt_wrapper → PTY write

## Claude Chat Commands
- `src-tauri/src/commands/claude_chat.rs` — structured chat commands for Claude Code sessions
- Provides structured interaction layer on top of PTY subprocess model

## Codex App Server
- `codex/app_server.rs` — `CodexServerManager` manages JSON-RPC servers per workspace/account with exact thread routing
- Server state in `AppState.codex_servers`: `Arc<Mutex<CodexServerManager>>`
- Commands in `src-tauri/src/commands/codex.rs` validate inputs: absolute paths, model prefixes, effort, IDs
- Emits `codex-event` notifications to frontend via `app_handle.emit()`
- Keep unanswered MCP consent requests in the workspace server and replay until response, resolution, or turn end. Frontend consent must deduplicate request IDs (including zero), preserve thread isolation, and allow known child consent through presentation filtering. Always drain Codex stderr with bounded memory.
- `codex_ensure_server` must be called before any other codex commands

## Grok ACP Server
- `grok/app_server.rs` + `grok/event_mapper.rs` — `GrokServerManager` manages one `grok agent stdio` ACP process per thread
- Server state in `AppState.grok_servers`: `Arc<Mutex<GrokServerManager>>`
- Commands in `src-tauri/src/commands/grok_sdk.rs`; events normalized to `sdk-event-{threadId}` (reuses SDK UI adapters)
- `grok_sdk_ensure_server` must be called before other grok commands
- `grok agent stdio` ignores `--permission-mode`/`--effort` (headless-only flags): permission mode is enforced **client-side** in the `session/request_permission` handler (runtime-mutable via `grok_sdk_set_permission_mode`), and effort is passed as `--reasoning-effort` (spawn-time; `grok_sdk_restart` respawns). ACP `session/cancel` is a notification, not a request.

## Terminal shell change counts

- Codex chat and terminal launches enable `hooks/codex_diff.rs` synchronous before/after capture (`codex_diff_hook.py`). Trust only the exact app-owned hook hashes returned by Codex; preserve unrelated hooks and disabled settings. Never bypass hook approval globally or rewrite agent commands.
- `shell_diff/captured.rs` imports measured journals into the existing ledger and emits `shell-diff-updated`. A session capture marker disables asynchronous shell snapshots to prevent duplicates. Codex hooks omit command workdir: resolve it from the exact outstanding transcript request before execution; ambiguous relative paths and overlapping writers are skipped.
- Python content `+=` must invalidate unknown path bindings. Codex scope parsing accepts literal `Promise.all`/`allSettled` calls and immediate async `text(await tools...)` wrappers; all matching calls still participate in workdir ambiguity checks, and dynamic branches remain unsupported.
- Imported Python `re.sub` may transform content without losing literal write targets, but replacement text must be a literal string or a known literal binding. Reject callable/unknown replacements and positional/keyword spreads. Keep whole-script rejection for unknown Python: continuing afterward can lose cwd/binding identity or count unexecuted bodies.
- Pure `ALL_TOOLS.filter(x=>/pattern/.test(x.name))` discovery alongside tools must not discard known command scope. Expired snapshots never earn retrospective counts, but a matching late PostToolUse must retire their writer guard. Unconfirmed guards do not become safe merely through age; unpolled yielded shell commands can omit their PostToolUse until polled.
- Unpolled chat captures reconcile only through the original app-server instance and complete paginated background-terminal listings, after exact parent-idle transcript checks. Store immutable capture start, transcript path and instance; group children separately. Owner PID markers permit snapshot-free retirement only on confirmed owner death. Keep inbox draining independent of the bounded recovery worker.
- Codex PTY launches also register a unique capture instance against the spawned child PID. Hooks record the kernel boot UUID; a different observed boot retires old guards without counts. Legacy guards without a boot UUID are pinned to the current boot before a later reboot can retire them. Same-boot guards, unknown boot queries and missing/ambiguous ownership stay protected; wall-clock age or a parent turn ending is not completion evidence.
- Codex terminal starters use native paginated history (`history_mode: paginated`, ordinal 0). Legacy resumes use Codex's per-thread `migrate-rollouts --apply --json`; busy writers must be left untouched. This format preserves exact `item_completed.CommandExecution` exit receipts even when a command finishes after its parent turn and is never polled.
- The coalesced capture worker invokes the private Python `--reconcile` helper. It scans exact session/cwd histories in bounded forward chunks, retaining partial records and cursors, and measures a pending capture once only on its exact terminal receipt. Expired snapshots never earn retroactive counts. Never infer legacy guard ownership from timestamp proximity or a unique wrapper interval: clock changes break that association. Absent ownership, age, current server listings and turn completion are insufficient.
- Explicit Codex shell targets from an exact outstanding request may capture across Git repositories. Resolve each concrete destination's Git root; never widen to arbitrary non-repository directories. Keep parent `cwd` for transcript reconciliation and per-path `captureRoots` for snapshots; emit separate root-scoped journals with the same native-session/tool ownership. Registered worktrees remain supported, including with stale unrelated registrations. Native patches and unknown writers must collide with these destination scopes too.
- Bounded JSON file lists (64 KiB/64 relative paths) may supply literal Python copy targets. Parse data only, revalidate the list hash at completion, reject traversal/directory copies and unknown control flow, and do not execute helper scripts to discover targets. Literal file copies and pure `Path.exists()` branches may contribute measured destinations; temporary preview/backup directories outside repositories do not earn counts.
- Literal `git apply` patch files use read-only NUL-delimited numstat for repository-relative targets, then real before/after snapshots. Preserve include/exclude rules, skip check-only/unsupported modes, and suppress counts if the patch input changes. Rename/copy/binary patches remain unsupported. Sequential heredocs and guarded literal file copies can supply targets; an unknown suffix stops further discovery and retains a workspace-wide collision claim.
- Codex capture scope accepts pure result-printing wrappers (`const`/`let` results, `forEach(text)`, `.then(r => r.forEach(text))`, and fixed image/result projections); arbitrary callbacks or assignments remain unsupported. Literal `mkdir -p` prefixes may precede heredoc writes. `python -B` does not change target identity.
- Static JavaScript template literals use cooked escape/newline semantics; interpolations remain unsupported. Bounded literal command maps, empty-input poll loops and pure indexed/result print loops preserve scope. Unresolved relative write targets retain a wide collision guard. Strict inspection-only `rg`/`head`/`tail`/`wc` and sed print scripts do not claim unknown writes; preprocessors, archive helpers and arbitrary scripts remain guarded.
- A literal numeric `sleep` preserves surrounding shell write targets. A delay or parent reply is never completion evidence; an unpolled command still needs its exact native terminal receipt before measuring changes.
- PRE persists a provisional wide pending claim before receipt/target discovery. If interrupted, the next cleanup marks overlapping captures before retiring it; a normal PRE narrows the claim without introducing provisional false conflicts. Rust idle-parent matching accepts only directory aliases that canonicalize to the same location. Codex history readers, terminal discovery and resume/seed lookups share `cli_config::codex_home()`.
- Capture receipt checkpoints record execution-session identity, inode/header and boundary fingerprints at PRE. Explicit parent-linked child transcripts may account to their parent while matching completion to the child execution ID. New checkpoints establish receipt ordering without wall time; rejected/replaced checkpoints cannot fall back to timestamp inference. Existing unknown legacy writers remain protected.
- Bulk `Path.rglob('*')` rename capture recognizes only the bounded literal-root/suffix-filter/read/replace/changed-write pattern. It never runs transcript Python: permit literal replacements and simple word regexes only, reject symlinks/out-of-scope roots/callbacks/loop-mutated replacement bindings, and bound traversal to 4096 entries, one second, 16 MiB read and 64 changed targets. Match `read_text()` universal newlines and retain a workspace-wide collision claim even when no files currently match. Historical replay cannot reconstruct these before-images from today's files.
- Claude Code's own `bashEditDiff` on Bash results (transcript `toolUseResult` / PostToolUse `tool_response`) is native: `scan_claude_diff_stats` counts it and shell capture abandons that call, via the shared `claude_bash_edit_diff` predicate. `shared`/`skipped`/`unavailable` diffs stay with shell capture.
- `shell_diff/terminal.rs` tails only newly appended records from exact bound Claude/Codex/Droid sessions; attachment, replacement, and truncation start at EOF. Native edit starts also enter the shared collision guard. Starts already completed in a batch are collision-only, never retrospective snapshots.
- `shell_diff/terminal_opencode.rs` reads exact top-level OpenCode sessions using a read-only SQLite connection. Running-to-completed/error transitions settle observations; `data_version` skips unchanged databases. Known transcript paths are cached; no eligible streams means slower discovery.
- Kimi has no registered completion hook and local wire samples do not establish a reliable tool-completion pair. Do not infer its writes from turn ends, cwd-wide file events, or historical totals. Other hook providers use `shell_diff::observe_hook` before native diff handling; hook payloads remain unchanged.

## AppState Fields
- `db`, `sessions` (PTY), `sdk_sessions` (Claude SDK), `codex_servers`, `grok_servers`, `watchers`
- `claude_chat_watchers`, `local_llm_server`, `hook_server`, `hook_socket_path`, `hook_script_path`, `kimi_hook_script_path`
- `usage_scan_times`, `opencode_sdk_bridge`, `opencode_sdk_sessions`, `cursor_sdk_bridge`, `cursor_sdk_sessions`
- `diff_backfill_scanned`, `mlx` (MlxState), `remote` (mobile relay handle)

## Capabilities
- New Tauri plugins require permissions added to `src-tauri/capabilities/default.json`
- Missing permissions = silent runtime failures (no error, feature just doesn't work)

## Remote control
- Remote Codex surface routing uses exact loaded session identity with live PTY precedence; a shared workspace is not evidence that another terminal is a chat.
- Keep dispatch busy visible until runtime task progress is established. A dispatch acknowledgment or user-message echo is not a completed turn. Terminal handoff must distinguish a new task from stale history and surface uncertainty without automatically resending.
- `remote/frames.rs` enforces the relay UTF-8 frame budget. Large timelines use ordered snapshot/append frames; large catalogs use indexed snapshots staged atomically by the phone. Keep desktop and phone chunk handling compatible when shipping.
- Pi remote history follows the last saved parent chain, with bounded disk reads. Failed tools must retain their error rather than speculative file changes. The current audit and live-test gaps are recorded in `docs/remote-control-audit-2026-09-07.md`.

- Shell change snapshots can expire, but live-writer collision guards must remain until completion or cancellation. Unsupported Codex shell targets participate as workspace-wide, snapshot-free blockers; they never earn speculative change counts.

- Terminal approval dispatch validates the live PTY and acquires its writer before consuming the one-shot remote request. Never restore a consumed approval after writing starts: write/flush errors may follow partial delivery. Shared dispatch must not apply default phone permissions when no phone preferences were saved.

- Gemini applies its initial model once after new/resume using the advertised model-category config ID and waits for acknowledgment before readiness. Warm ensures must preserve model changes made in a running chat.

## Startup data safety
- Pending migrations of an existing DB require a consistent SQLite `VACUUM INTO` snapshot under `backups/`; a backup failure stops startup before migrations. No raw live DB copy for migration backups (WAL must be included by SQLite).
- DB initialization errors retain a native app with `StartupFailure`, no AppState. Menu/exit/deep-link paths must tolerate that state. Recovery restore is startup-only, verifies the snapshot and preserves original DB/WAL/SHM in a private folder before replacement. Never auto-reset or delete user data to make startup pass.
- Support uploads selected files with bounded reads (5 MiB each, 10 MiB total), works without AppState and does not depend on product-analytics consent. Inbox/download auth lives in analytics-service, not Teams.

## Provider accounts
- Claude account profiles are personal-only and use native Claude browser login. The existing native login stays primary and is exposed as read-only metadata; never copy its credentials into a managed profile. Reject Claude team login/import and credential sharing; the Codex/Grok team credential plane does not include Claude.
- Claude chat bindings belong to a unique process key, not just the thread. Preflight replacement before retiring the old process; preserve exact resume/settings without replaying input. Native completion/hook IDs, pending work, per-thread lifecycle cancellation and configuration serialization (including file rewind) gate handoff. Missing/ambiguous completion identities block switching. Native typed 429 synthetic terminal records can establish a stopped turn, but only separately confirmed quota windows trigger account selection; Opus/Sonnet limits remain model-scoped.
- Keep the native current login primary while its quota is healthy or unknown, regardless of added account priority. Auto-switch off must not select a different added account. Preserve native authentication/environment; isolated overrides apply only to managed homes. Codex fallback requires exact remembered/current native model context, an advertised candidate model, and a conservative verified plan floor; unknown access fails closed. Do not replace the session model to make an account fit.
- `native.rs` discovers current native OAuth logins as ephemeral metadata rows. Never persist them in the switching pool or copy credentials just to display them. Deduplicate by provider account/seat identity, never email; identity-scoped quota caches must not cross a login change. `profile.rs` maps reported Codex plan values (`prolite` = Pro 5x, `pro` = Pro 20x), not usage percentages.
- `provider_accounts/` owns personal Codex/Grok native OAuth homes and team lease credentials, separate from analytics. Frontend commands return metadata only. Homes share provider history/integrations but never authentication or leader sockets; never rewrite the global login to switch a session.
- Select personal accounts before team overflow. Keep exact session bindings and route Codex approvals to the originating account server. Missing quota is unknown; only provider-owned windows or typed quota errors establish exhaustion. Never infer limits from model/tool/terminal prose or blindly replay an interrupted prompt.
- Team usage checks (`refresh_team_account`) take an exact short lease via `POST …/provider-accounts/{id}/check` (409 = in use), probe quota in a scratch home, renew with the reading plus any refreshed OAuth tokens, then release and delete the scratch home. A lease already held by a local session is measured through that binding instead. Server `remainingPercent` stays the 5-minute-fresh capacity used for allocation; `lastRemainingPercent` is display-only.
- `transfer.rs` moves personal Codex/Grok logins to a team. Added accounts are paused (not locked) during the upload, restored on failure, then deleted locally. Shared native logins are recorded in `Store.team_links` (native row ID = identity hash, never credentials); `attach_team_logins` hides the native row from Personal only while its team row is present. `team::upload` returns the team account ID.
- Usage checks report a rate limit only when the provider says so (`quota::rate_limited`/`is_rate_limited`): Grok's 429, a Codex rateLimits error mentioning 429/rate limit, or Claude's own `--debug-file` log for the usage probe (Claude's `get_usage` returns `rate_limits: null` for every failure, 429 included). The log is written under the private `provider-accounts` root and deleted immediately. A rate-limited check keeps the last reading.
- `Account.tier` is display-only. Claude takes it from the verified `.claude.json` `*RateLimitTier` (`…max_5x/20x`) and Grok from its CLI log's latest `subscriptionTier` (bounded 8 MiB tail). Never feed `tier` into routing: Claude plan compatibility parses `plan`.
- Team OAuth accounts use the Teams service's encrypted credential plane and exclusive renewable leases. Keep ownership through native shutdown/unload, persist refreshed credentials before release, and stop use on revocation/expiry. Staff preview cannot receive credentials. The service migration and encryption secret must be configured before shared accounts work.
