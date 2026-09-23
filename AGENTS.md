# Agent Instructions — agmux

macOS Tauri app for AI coding agents (Claude, Codex, Cursor, Droid, Kimi, Pi, OpenCode, Grok, Cline, Gemini, Hermes, MLX). Modes: PTY, Claude SDK, Cursor SDK, OpenCode SDK, Grok ACP, MLX. UI: agent / cowork / task / ide.

## Open source — this repo is public

Source: https://github.com/neelsatyavolu/agmux (MIT). Every commit pushed is published, forever. Be careful:

- Never commit secrets, tokens, credentials, keys, personal files, photos/screenshots, local databases, transcripts, or machine-specific paths/configs. Review `git status` and the staged diff before every commit; stage explicit paths, not unknown files.
- Local tool/agent state stays gitignored: `.agmux/`, `.wrangler/`, `.playwright-cli/`, `.superset/`, `.grok/config.toml`, `memory.json`, `handoffs.json`.
- No hardcoded API keys and no unauthenticated endpoints that spend the owner's keys. Users bring their own keys.
- Tests and docs use placeholder data (example.com, fake IDs), never real users, emails, or account IDs.
- `private` remote = `neel-xanom/agmux`: pre-open-source history plus the signed release pipeline (secrets, self-hosted runners). Never push private history (any branch based on it) to `origin`; `.git/hooks/pre-push` blocks it. Releases: see `.claude/commands/release.md`.

## Package manager

- Use **npm** (`package-lock.json`).

## Commands

| Task | Command |
|------|---------|
| Vite only | `npm run dev` (port 1420) |
| Full app | `npx tauri dev` |
| Release build | `npx tauri build --no-bundle` |
| Typecheck | `npx tsc --noEmit` (**mandatory** before ending a session) |
| Frontend tests | `npm run test` · single: `npm run test -- <pattern>` |
| Sidecar rebuild | `cd sidecar && node build.mjs` (**required** after any `sidecar/` edit) |
| Sidecar tests | `cd sidecar && npm test` |
| Rust tests | `cargo test -p xanom` · single: `cargo test -p xanom <name>` |

## External references

| Need | File |
|------|------|
| React / Zustand / terminal UI | `.claude/rules/src.md` |
| Rust / Tauri / PTY / AppState | `.claude/rules/src-tauri.md` |
| Node sidecars / JSON-RPC events | `.claude/rules/sidecar.md` |
| Architecture, DB, debugging | `.claude/rules/architecture.md` |
| context-mode routing (Claude plugin) | `.claude/rules/context-mode.md` |
| Teams (org analytics) — read before touching it | `AGMUX_TEAMS.md` |
| Owner product analytics | `analytics-service/` (Worker + D1 at owner.agmux.dev); desktop `src-tauri/src/product_analytics/` |
| Remote phone UI (PWA) | `remote.agmux.dev` (Worker assets); legacy mirror `agmux.dev/remote`; relay `remote-relay/` |
| Remote iOS shell (Capacitor) | `remote-mobile/` — same PWA + relay; `npm run ios` |
| User-facing release notes — **update when shipping** | `RELEASE_NOTES.md` |
| Living project memory (local generated view) | `.agmux/MEMORY.md` |
| Session handoffs index (local generated view) | `.agmux/SESSIONS.md` |

## Key conventions

- Tauri `invoke()` keys: **camelCase**. Rust commands: `Result<T, String>` + `map_err(|e| e.to_string())`.
- Zustand selectors: stable refs only — module-level `EMPTY`, never `|| []` / `|| {}`.
- PTY I/O: blocking `std::thread::spawn`, never tokio. Canvas xterm only — never WebGL.
- No ESLint/Prettier/rustfmt — match neighboring code.
- Dual IDs: agmux UUIDs (DB/threads) vs provider session IDs (Claude/Codex files).
- New SDK providers: normalize events to `sdk-event-{threadId}`.
- `@tauri-apps/plugin-dialog`: dynamic import via `useDialogOpen()`.
- Personal overrides: `AGENTS.local.md` (gitignored). `# key` can append to this file.

## Terminal sessions — verify on local disk

When working on **Claude / Codex / Droid / Kimi / Pi / OpenCode / Grok terminal (PTY)** or **Cursor SDK** behavior (resume, listing, titles, stop/finish, history), **double-check real local sessions** — do not trust UI state alone. Discovery/resume code lives in `src-tauri/src/process/spawn.rs` and `src-tauri/src/commands/threads.rs`.

| Provider | On-disk path | What to open |
|----------|--------------|--------------|
| Claude | `~/.claude/projects/{encoded_cwd}/{session_id}.jsonl` | cwd → Claude project encoding (`encode_claude_project_path`); JSONL turns |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*-{session_id}.jsonl` | walk tree; filename contains UUID |
| Droid | `~/.factory/sessions/{cwd-hash}/{uuid}.jsonl` | cwd `/` → `-`; agmux binds `~/.agmux/threads/{id}/droid-session-id.txt` |
| Kimi | `~/.kimi-code/sessions/…` + `session_index.jsonl` | agmux binds `~/.agmux/threads/{id}/kimi-session-id.txt` |
| Cline | `~/.cline/data/tasks/{taskId}/` · CLI `~/.cline/data/sessions/{id}/` | `--tui`; resume `--id`; bind `cline-session-id.txt`; hooks in `~/.cline/hooks` (TaskStart→prompt-submit — TUI `run("")` skips UserPromptSubmit). Transcript `prompt` / `*.messages.json` `<user_input>` is the ask for titles. |
| Gemini | PTY: `~/.gemini/antigravity-cli/` (`cache/last_conversations.json`, `brain/{id}/.../transcript.jsonl`). Chat (`gemini-sdk`): isolated `~/.agmux/antigravity-acp/home` + `agy_acp_server`; bind `threads.sdk_session_id`. | Spawn `agy` for the New-menu terminal tile. Chat uses Antigravity ACP (`gemini_sdk_*`), not `agy`. PTY hooks: `~/.gemini/antigravity-cli/plugins/agmux/hooks.json` + `agy-hook.sh`. agy has no PermissionRequest hook — amber pulse/toast wait for the live Allow/Deny card in the PTY. Chat approvals are ACP `session/request_permission`. |
| Hermes | `~/.hermes/state.db` sessions table | `hermes --tui --accept-hooks`; bind `hermes-session-id.txt`; plugin `~/.hermes/plugins/agmux-hooks` (TUI spinner/titles; shell hooks in config.yaml do not fire in `--tui`) |
| Pi | `~/.pi/agent/sessions/--{encoded_cwd}--/{ts}_{uuid}.jsonl` | agmux binds `~/.agmux/threads/{id}/pi-session-id.txt`. New-menu **local** tile also spawns Pi against the MLX gateway (`--model local/<id>`; writes `~/.pi/agent/models.json`). |
| OpenCode PTY | `~/.agmux/threads/{id}/opencode-session-id.txt` → `~/.local/share/opencode/opencode.db` (or `$XDG_DATA_HOME/opencode`) | session.model + usage in SQLite |
| Grok | `~/.grok/sessions/{urlencoded_cwd}/{session_id}/` | cwd with `/` → `%2F`; `summary.json`, `chat_history.jsonl`, `updates.jsonl` |
| Cursor | app-owned via Cursor SDK bridge (not Claude-style JSONL) | thread state under `~/.agmux/threads/{thread_id}/` |
| agmux thread | `~/.agmux/threads/{thread_id}/` | app-owned state for that thread |

Also useful: provider configs `~/.claude/settings.json`, `~/.codex/`, `~/.factory/`, `~/.kimi-code/`, `~/.pi/agent/`, `~/.grok/config.toml` / `auth.json`.

## Hard stops — ask first

- DB table/column delete or rename (needs `src-tauri/migrations/0NN_*.sql`)
- PTY spawn / I/O / kill; hook socket protocol or dedup fingerprint
- Sidecar JSON-RPC method/event shapes; OpenCode multiplex shape
- Cursor SDK bridge / `cursor-sdk` event shapes (`commands/cursor_sdk.rs`, `sidecar/cursor-sdk-bridge.mjs`)
- Search FTS schema / index pipeline (`src-tauri/src/search/`, migration `031`)
- Grok ACP server / `event_mapper`; MLX `wire_model` or orphan/exit cleanup
- Rename/remove Tauri commands; add plugins without `src-tauri/capabilities/default.json`
- Task/worktree git flows without dual-repo (main vs worktree) awareness

## Project memory (do not regress)

| Piece | Location |
|-------|----------|
| Store | `~/.agmux/projects/{project_id}/memory.json` |
| Projection (local, generated, gitignored) | `.agmux/MEMORY.md` |
| MCP | `sidecar/dist/agmux-memory-mcp.bundle.mjs` |
| CLI fallback | `sidecar/dist/agmux-memory-cli.bundle.mjs` (`AGMUX_MEMORY_NODE` / `AGMUX_MEMORY_CLI`) |

- App-owned JSON is authoritative; `.agmux/MEMORY.md` and `.agmux/SESSIONS.md` are private local views that can be regenerated and must not be committed.
- Stores use monotonic revisions. Mutations re-read while holding a token-owned lock. Node MCP/CLI and desktop Rust writers reclaim only expired locks whose owner is confirmed dead; malformed or ambiguous locks always time out.
- `source` is immutable authorship; `authority` controls later edits (`user > system > agent`). Importance is attention only (not binding). Agents decide `binding` after verifying accuracy/safety — keep binding and important sparse.
- On code changes / durable facts: `memory_list` first → work → `session_upsert` before final reply; `memory_add` only for lasting decisions/constraints. Set `important: true` for items that deserve attention, and do not claim an agent-created entry is binding until it is explicitly confirmed.
- Bundles: **exactly one** shebang (esbuild banner only). Claude PTY: `--strict-mcp-config`. Setting: `projectMemoryEnabled` (default on).

## On-disk paths (agmux)

- App data: `~/.agmux/` (SQLite `agmux.db`, projects, threads, hooks, teams, tmp, …).
- First launch after the rename migrates `~/.xanom/` → `~/.agmux/` and `xanom.db` → `agmux.db` (see `src-tauri/src/paths.rs`); leaves a compatibility symlink at `~/.xanom` when possible.
- localStorage keys are `agmux-*` (one-time migrate from `xanom-*` on boot).
- Still **xanom** on purpose (do not rename lightly): bundle id `com.xanom.app`, Rust crate `xanom`, some Cloudflare worker hostnames, resource filenames like `xanom-notify.wav`. Env: prefer `AGMUX_*`; spawn dual-writes legacy `XANOM_*` for hooks.
- Homebrew: tap `neel-xanom/homebrew-agmux` → `brew install --cask neel-xanom/agmux/agmux`.

## Workflow

- Medium/big surface changes: update this file **or** the domain rule it points at.
- Tests for non-trivial behavior changes. Branch `feat|fix|…` for big work; minor fixes on `master`.
- **User-visible product change → update `RELEASE_NOTES.md`** under `## Unreleased` (`### New` / `### Improved` / `### Fixed`). Plain language for a non-technical user; delta vs last GitHub release only — no eng jargon, internals, or session diary. Skip pure refactors/tests/tooling with no user-facing effect.
