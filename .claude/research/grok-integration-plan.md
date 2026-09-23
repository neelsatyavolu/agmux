# xAI Grok Build CLI → Xanom Integration Plan (v2)

**Date:** 2026-05-14
**Source of truth:** `grok 0.1.210` bundled docs at `~/.grok/docs/user-guide/` on this machine. This **supersedes v1**, which was based on the community `superagent-ai/grok-cli` and got the storage format wrong (it's JSONL, not SQLite).

---

## What Grok Build actually is

- **Native Rust** binary (`Mach-O arm64`), not Node.js. Installs to `~/.local/bin/grok`, symlinked to `~/.grok/downloads/grok-macos-aarch64`.
- Binary name on PATH: **`grok`** (not `grok-build`).
- Self-managed updates via `grok update`.
- Subcommands: `agent`, `import`, `inspect`, `leader`, `login`, `mcp`, `memory`, `models`, `sessions`, `setup`, `share`, `ssh`, `trace`, `update`, `worktree`.

## Three usage modes (all already supported by the CLI)

| Mode | Command | Xanom mapping |
|---|---|---|
| **Interactive TUI** | `grok` | Maps to existing PTY mode |
| **Headless single-prompt** | `grok -p "..." --output-format streaming-json` | Optional "Grok-SDK-headless" mode |
| **ACP over stdio** | `grok agent stdio` | True "Grok SDK mode" — mirror of Claude SDK bridge |

ACP (Agent Client Protocol) is the authoritative programmatic interface. It exposes `session/new`, `session/load`, etc. as JSON-RPC over stdio. **Xanom can talk to it directly from Rust — no Node.js sidecar required.**

## Authentication

- Default: **OAuth via browser** (`grok login`) → tokens in `~/.grok/auth.json` (auto-refreshed, hot-reloaded).
- API key (CI): `GROK_CODE_XAI_API_KEY` (NOT `GROK_API_KEY`, NOT `XAI_API_KEY`).
- Token lifetime: 7 days.
- Enterprise OIDC + external-auth-provider also supported.
- **Xanom should not own the auth flow.** Detect whether `~/.grok/auth.json` exists or `GROK_CODE_XAI_API_KEY` is set; if neither, surface a "Run `grok login` in a terminal" prompt.

## Session storage (JSONL, NOT SQLite)

**Path:** `~/.grok/sessions/<URL-encoded-cwd>/<session-uuid>/`

Confirmed by inspection — e.g. `~/.grok/sessions/%2FUsers%2Fneel/019e2862-0a7d-71c2-b650-7cbc12f5e03c/` contains:

| File | Contents |
|---|---|
| `summary.json` | `{title, model, created_at, updated_at, message_count, parent_session_id}` — the index entry |
| `updates.jsonl` | ACP session update stream — **authoritative log** for resume/load |
| `events.jsonl` | Lifecycle events |
| `chat_history.jsonl` | Raw chat messages sent to the model |
| `prompt_context.json` | Snapshot of effective system prompt + rules |
| `system_prompt.txt` | Rendered system prompt |
| `plan.json`, `rewind_points.jsonl`, `signals.json`, `feedback.jsonl`, `compaction_checkpoints/`, `subagents/` | Auxiliary (created lazily) |

There is also a top-level `~/.grok/sessions/session_search.sqlite` — FTS index over titles/content. Xanom can ignore it and just glob/parse `summary.json` files like it does for Claude.

**Resume:** `grok --resume <uuid>` or `-r <uuid>`, or `-c` for most recent in cwd.

## Hooks — full Claude Code parity (huge integration win)

**Events:** `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`, `Stop`, `Notification`.

**Hook locations (merged at runtime):**
- `~/.grok/hooks/*.json` (global, always trusted)
- **`~/.claude/settings.json` (Claude Code compatibility — Grok reads this directly!)**
- `<project>/.grok/hooks/*.json` (project, requires `/hooks-trust`)
- `<project>/.claude/settings.json` (project, requires trust)
- Plugin bundled hooks

**Format:** identical JSON schema to Claude Code (`{hooks: {EventName: [{matcher, hooks: [{type: "command"|"http", command, timeout}]}]}}`).

**Tool-name aliases (automatic):** `Bash` → `run_terminal_cmd`, `Edit` → `search_replace`, `Read` → `read_file`.

**stdin / stdout contract:** identical to Claude — JSON event on stdin, `{"decision":"allow"|"deny", "reason":"..."}` on stdout, exit 2 to deny.

**Env vars:** `GROK_HOOK_EVENT`, `GROK_SESSION_ID`, `GROK_WORKSPACE_ROOT`.

**Implication for Xanom:** Whatever we already write into `~/.claude/settings.json` to forward Claude hooks to `~/.xanom/hooks/xanom-hooks.sock` will **run for Grok too, with zero extra work**, as long as the Xanom hook script handles `GROK_*` env vars and the `pre_tool_use` event name. The dedup fingerprint already handles `{sessionId, toolName, toolInput}` which Grok payloads also carry.

## Built-in features Xanom can lean on (don't reimplement)

- **Worktree:** `-w/--worktree [NAME]` flag and `grok worktree` subcommand. Xanom already has its own worktree management for Task mode — for Grok threads we can either pass `-w` or stay out of grok's way and use Xanom's existing pattern.
- **Subagents:** up to 8 parallel; `--disallowed-tools Agent(explore)` to block specific types.
- **Permission rules:** `--allow Bash(npm*)` / `--deny Bash(rm*)` — finer than Xanom currently exposes.
- **Sandbox:** `--sandbox workspace|read-only|strict` or `GROK_SANDBOX` env var.
- **MCP:** `grok mcp` subcommand, `[mcp_servers.*]` in `~/.grok/config.toml`.

## Models

- Listed by `grok models`.
- Config: `[models] default = "grok-build"` (also `models.web_search = "grok-4.20-multi-agent"`).
- Custom OpenAI-compatible endpoints via `[model.<name>]` sections in `config.toml`.
- Streaming-json events: `text`, `thought`, `end` (with `stopReason`, `sessionId`, `requestId`).

---

## Revised integration plan

### Phase 1 — PTY MVP (~½ day, mostly mechanical)
| # | Change | File |
|---|---|---|
| 1 | Add `Grok` variant to provider enum | `src-tauri/src/db/models.rs:16-20` |
| 2 | Add `"grok"` to TS `Provider` union + label/icon | `src/lib/types.ts:9`, `ProviderModelDropdown.tsx:61-67`, `NewThreadDialog.tsx` |
| 3 | Spawn match arm: binary `grok`, no args for TUI; pass `-c` if continuing | `src-tauri/src/process/spawn.rs:244-434` |
| 4 | Add `"grok"` to `cli_binary_name()` and PATH augmentation (include `~/.local/bin`) | `src-tauri/src/process/provider.rs:5-104` |
| 5 | Models list: read live from `grok models --output-format json` on first launch, cache; fall back to `grok-build`, `grok-4-latest`, `grok-3-fast`, `grok-3-mini-fast` | `src/lib/types.ts` + `ProviderModelDropdown.tsx:102-203` |
| 6 | Auth detection: surface "Run `grok login`" CTA if neither `~/.grok/auth.json` nor `GROK_CODE_XAI_API_KEY` is present | new minimal `GrokAuthPanel.tsx` |

### Phase 2 — Hooks (~10 minutes if Claude hooks already work)
Grok reads `~/.claude/settings.json` directly. Xanom's existing Claude hook entry will fire for Grok automatically. **All we need to do:**
- Add `GROK_HOOK_EVENT`/`GROK_SESSION_ID`/`GROK_WORKSPACE_ROOT` to the env-var names the dispatcher recognizes (in addition to `CLAUDE_*`).
- Tag forwarded events with `provider: "grok"` in the socket payload so the frontend renders the right icon.
- That's it. No new config writer, no settings injection, no `--settings` flag plumbing.

Verification gate before shipping: capture one live `pre_tool_use` payload from grok and diff against Claude's to confirm field shapes match the doc.

### Phase 3 — Past-session import + resume (~½ day)
Storage is JSONL — mirror Claude's importer almost line-for-line.
- New module `src-tauri/src/grok/sessions.rs`:
  - List sessions: glob `~/.grok/sessions/*/`*/`summary.json`, decode URL-encoded cwd (`%2F` → `/`), filter by workspace path.
  - Map to existing `PastSession` shape (id, title, updated_at, model, message_count).
- Resume flag: extend Phase-1 spawn arm to append `--resume <uuid>` when user picks one.
- Frontend "Past Sessions" panel auto-picks it up via existing provider switch.

### Phase 4 (optional) — True "Grok SDK mode" via ACP (~1-2 days)
Parallel to Claude SDK / OpenCode SDK modes; **simpler than Claude's** because no Node sidecar is needed — Rust can talk to `grok agent stdio` directly.
- Spawn `grok agent stdio` as a managed child process per thread (or one shared leader via `grok agent leader`).
- Speak ACP JSON-RPC: `session/new`, `session/load`, `prompt`, `tool_call_response`, etc.
- Map ACP `session/update` events → existing `sdk-event-{threadId}` wire format → ThreadView/TaskView reuse the approval flow for free.
- Add `interaction_mode: "grok-sdk"` (migration `023_grok_provider.sql`).

---

## Risks & gotchas

- **API key var:** Use `GROK_CODE_XAI_API_KEY`. The other names (`GROK_API_KEY`, `XAI_API_KEY`) are different products.
- **Config is TOML, not JSON.** If we ever write to `~/.grok/config.toml`, use a TOML library — don't hand-roll.
- **Project hooks require trust.** If Xanom writes `<project>/.grok/hooks/*.json`, the user must run `/hooks-trust` once. Prefer the global `~/.claude/settings.json` path which is always trusted.
- **`session_search.sqlite`** is grok-owned. Never write to it; if we read it, do so read-only (WAL).
- **Worktree double-management:** if a Xanom Task already created a worktree, don't pass `-w` to grok or you get nested worktrees.
- **Auth ownership:** `~/.grok/auth.json` is hot-reloaded by grok. Don't touch it. Just check existence.

## Recommended start
Phase 1 + 2 together — get a Grok thread spawning, talking, and emitting hooks into the existing socket bridge end-to-end. That's the minimum to validate the architecture. Phases 3-4 are additive and don't block shipping.
