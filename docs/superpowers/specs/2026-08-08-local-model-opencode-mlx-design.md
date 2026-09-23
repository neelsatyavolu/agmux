# Local Models via OpenCode + grok over an agmux Gateway — Design

**Date:** 2026-08-08
**Status:** Approved design, pending implementation plan
**Scope:** Sub-project 1 of 2 (see [Decomposition](#decomposition))

---

## Problem

agmux has a large, working local-model *infrastructure* and a large,
underperforming local-model *agent*, and almost none of it is reachable:

- `src-tauri/src/mlx/` is ~8.8k lines: Python/mlx-lm bootstrap, `mlx_lm.server`
  lifecycle, an OpenAI-compatible client, a full agent loop with tools, FIM
  completion, approvals.
- `src/components/settings/LocalModelsPanel.tsx` is 809 lines implementing a
  complete model browser — hardware-tiered curated catalog, HuggingFace search,
  download with live progress, delete. **It is rendered nowhere.**
- `src-tauri/src/commands/feature_gate.rs:8` hard-codes `AUTHORIZED_HW_UUID` and
  gates MLX chat to a single Mac, enforced in both the picker
  (`ProviderModelDropdown.tsx:780`) and the backend (`commands/mlx.rs:169`).
- The homegrown agent loop, in practice, is not good enough to ship.

So the work is not "build a local model agent." It is: retire the homegrown
harness, keep the model-management infrastructure, and drive it with established
harnesses that agmux already integrates.

## Target experience

Two launch surfaces, one shared local runtime.

1. **Chat** — a "Local Model" provider in the draft/chat picker, listing the
   models actually installed on this Mac.
2. **Terminal** — a "local" option in the project plus-button picker
   (`ProjectGroup.tsx:1893`, currently a 5-up grid of claude/codex/kimi/opencode/grok).
   It opens **grok** preconfigured against the local models, and the user can
   switch models from inside grok.

Models are loaded and offloaded intelligently based on what is actually in use,
so the two surfaces can coexist within a fixed RAM budget.

## Decision

**One agmux-owned gateway, two established harnesses.**

```
   Chat: OpenCode SDK session          Terminal: grok PTY
   (provider `local`)                  (~/.grok/managed_config.toml)
             │                                   │
             └───────────────┬───────────────────┘
                             │ OpenAI /v1 @ 127.0.0.1:21434
             ┌───────────────┴────────────────────────────┐
             │  agmux local gateway  (NEW)                │
             │  routes by request `model` field           │
             │  residency manager: load / evict / offload │
             └───────────────┬────────────────────────────┘
                             │  spawns per resident model
             ┌───────────────┴────────────────┐
             │  mlx_lm.server (ephemeral port)│  × N resident
             └────────────────────────────────┘
                             ▲
             agmux MLX runtime (KEPT): bootstrap · catalog ·
             discovery · downloader · server
```

### Why this works (verified, not assumed)

| Claim | Evidence |
|---|---|
| OpenCode supports custom OpenAI-compatible providers | `opencode` 1.16.2 binary bundles `@ai-sdk/openai-compatible` (171 refs) and `baseURL` (345 refs) |
| agmux already owns OpenCode's config | `sidecar/opencode-sdk-bridge.mjs:94` spawns with `OPENCODE_CONFIG_CONTENT: JSON.stringify({})` |
| A custom provider's models reach the picker with no bridge change | `opencode-sdk-bridge.mjs:540-552` surfaces all models from all providers |
| OpenCode model slugs are `providerID/modelID` | `DraftChatView.tsx:702` |
| grok supports local endpoints with zero code | `xai-grok-shell/src/agent/model_providers.rs:8` (`base_url`, `api_backend`, `api_key`, `context_window`); `ApiBackend::ChatCompletions` is the default (`xai-grok-sampling-types/src/types.rs:1013`); per-model overrides at `agent/config.rs:4015` |
| agmux can teach grok about local models without touching the user's config | `$GROK_HOME/managed_config.toml` is a lower-priority merge layer beneath `config.toml` (`xai-grok-config/src/lib.rs:3-6`) |
| grok does not strip injected providers from base config files | `PATCH_STRIP_KEYS` removes `model_providers` only from the campaigns / version-override patch layers (`config_override.rs:78-81`, used solely by `campaigns.rs` and `version_overrides.rs`) |
| grok-build is forkable if ever needed | Apache License 2.0 |

### Runtime choice

MLX (`mlx_lm.server`) stays the coding runtime. Considered and rejected:

- **Unify on the existing llama-server/GGUF stack** (already required at startup for
  titles/summaries) — would collapse two local stacks into one and drop the Python
  dependency, but gives up MLX's Apple Silicon speed advantage.
- **Magnitude** (`magnitudedev/magnitude`, Apache-2.0) is a close reference
  implementation of this whole idea — hardware profiling, curated catalog, model
  browser, HF-cache scanning, local agent, CLI — but its engine is llama.cpp/GGUF.
  Useful prior art, not adopted as a base.
- **Connecting to a user's existing Ollama / LM Studio server** — deferred.

## The gateway

This is the core new component, and the reason the earlier
"ensure the model is served before the session starts" approach was abandoned:
grok can switch models mid-session and runs as a separate process, so no
pre-flight call can know what will be requested next. Two independent consumers
contending for one model slot needs a single arbiter.

**Gateway** — an agmux-owned OpenAI-compatible HTTP server bound to
`127.0.0.1:21434` (the port `mlx_lm.server` used to occupy directly).

- `GET /v1/models` — the installed set, from `discovery::scan_all()`.
- `POST /v1/chat/completions` — reads `model` from the body, ensures residency,
  reverse-proxies to that model's backend. SSE must be forwarded unbuffered;
  buffering a stream turns a working model into an apparent hang.
- Everything else: 404.

**Backends** — one `mlx_lm.server` per *resident* model, each on an ephemeral
port. `server.rs` stops being a single-slot singleton and becomes a
"spawn/health-check/kill one backend" helper.

**Residency manager** — the load/offload policy, in one place:

- **Budget** = `catalog::detect_hardware().total_ram_gb` minus a reserve for the
  OS and agmux itself. Per-model cost comes from `catalog.rs`'s `ram_gb`
  (which already includes KV-cache headroom); non-catalog models estimate from
  weight file size.
- **Admit(model)** — resident → touch LRU and return its port. Otherwise evict
  least-recently-used *idle* models until the new model fits, spawn it,
  health-check, return.
- **Never evict a model with in-flight requests.** In-flight counters, not
  session bookkeeping, are the safety interlock — a grok session that has gone
  quiet is genuinely idle and its model is fair game.
- **Idle offload** — a background sweep unloads models idle beyond a threshold,
  returning RAM without waiting for pressure. This is the "depending on what's
  online" behaviour.
- **Single-flight per model** — concurrent requests for a loading model await the
  same load rather than spawning duplicates.
- **Too large to ever fit** — if one model alone exceeds the budget, fail with an
  explicit "this model needs ~X GB, this Mac has ~Y GB" message, not a timeout.

**New dependency.** agmux has `tokio` and `reqwest` but no HTTP *server* crate.
The gateway needs one (`axum` or bare `hyper`). Choosing it is an explicit task
in the implementation plan, not an incidental import.

## What changes

### Kept vs retired

| Keep — model library + runtime | Retire — homegrown harness |
|---|---|
| `mlx/bootstrap.rs` — Python / mlx-lm venv | `mlx/agent.rs` (3554 lines) |
| `mlx/catalog.rs` — hardware tiers, curated picks | `mlx/tools.rs` (1824 lines) |
| `mlx/discovery.rs` — LM Studio / HF cache scan | `mlx/client.rs` (576 lines) |
| `mlx/downloader.rs` — HF download + progress | `MlxSessionView.tsx` |
| `mlx/server.rs` — reworked to per-model backends | `interaction_mode = "mlx"` |

Existing threads with `interaction_mode = "mlx"` remain readable as history. No
DB migration: `interaction_mode` is a value, not a column.

### The changes

1. **Drop the device lock.** Delete `AUTHORIZED_HW_UUID` and `feature_mlx_chat`
   from `feature_gate.rs`, and the check at `commands/mlx.rs:169`. Replace with a
   capability gate (see [Error handling](#error-handling)).
2. **Build the gateway + residency manager.** Rework `server.rs` from a single
   fixed-port singleton into per-model backends behind it.
3. **Chat surface.** A "Local Model" provider tile whose models are the installed
   set. Selecting one creates an **`opencode-sdk`** thread with model
   `local/<id>`, reusing the existing OpenCode launch path
   (`DraftChatView.tsx:699`) — not a new interaction mode. The bridge's
   `OPENCODE_CONFIG_CONTENT` gains a `local` provider
   (`@ai-sdk/openai-compatible`, `baseURL` `http://127.0.0.1:21434/v1`).
4. **Terminal surface.** A sixth entry, "local", in the plus-button grid
   (`ProjectGroup.tsx:1893` and ~2102 — both copies). It spawns an ordinary
   `grok` PTY, and agmux writes `~/.grok/managed_config.toml` declaring
   `[model_providers.agmux-local] base_url = "http://127.0.0.1:21434/v1"` plus a
   `[model."local/<id>"]` entry per installed model, so grok's own model switcher
   lists them. The user's `~/.grok/config.toml` is never modified and always wins
   on conflict, since `managed_config.toml` is the lower-priority layer.

   **`GROK_HOME` was rejected.** Relocating it would move grok's session
   directory, breaking the nine hard-coded `~/.grok` paths in `spawn.rs`,
   `threads.rs` (×4), `projects.rs`, `teams/scan` (×2) and `usage_stats.rs` —
   taking session discovery, resume, usage scanning and Teams telemetry with it.
   agmux refuses to overwrite a `managed_config.toml` it did not write (sentinel
   first line), so an MDM-deployed file is left alone with a clear message.
5. **Render the orphaned browser.** New Settings page **"Local Models"** hosting
   the existing `LocalModelsPanel.tsx`, alongside the existing **"Summaries"**
   page which keeps owning the GGUF utility model — no naming collision.
6. **Retire the old loop.** Delete everything in the right-hand column above.

### Onboarding

Opt-in and discoverable. Both entry points are always visible and never silently
download anything. With nothing installed they route to the model browser instead
of failing. Machines that cannot run MLX show the entry disabled with a reason.

## Data flow

1. **App start** — no MLX work, no gateway. Fully lazy.
2. **First local launch** (either surface) — start the gateway, verify bootstrap.
3. **Chat** — thread created with `local/<id>` → OpenCode posts to the gateway →
   residency manager loads the model if needed → SSE streams back → events map to
   `sdk-event-{threadId}` exactly as today.
4. **Terminal** — grok PTY starts with the managed layer in place. Whatever model
   the user selects in grok arrives as the `model` field on the next request; the
   gateway loads it and evicts as needed. No coordination with agmux required.
5. **Idle** — the sweep offloads unused models; RAM returns without user action.

### Config freshness

Both harnesses take a *static* model list at process start — OpenCode via
`OPENCODE_CONFIG_CONTENT`, grok via `config.toml`. A model downloaded afterwards
will not appear in either until its config is rebuilt, even though the gateway's
`/v1/models` is live.

- **OpenCode**: rebuild and restart the shared bridge when the installed-model set
  changes — but only while no sessions are active; otherwise mark dirty and apply
  on next idle.
- **grok**: rewrite the managed `config.toml` whenever the installed set changes.
  It is read at process start, so already-running terminals keep their old list
  and new ones are correct. Acceptable; do not restart a user's live terminal.

## Error handling

Every failure state gets a specific, actionable message. No generic
"local models unavailable".

| Condition | Surface |
|---|---|
| Not Apple Silicon | Entry disabled + reason (`catalog::detect_hardware().is_apple_silicon`) |
| Python 3.10+ missing | Existing `MlxBootstrapBanner` → install flow |
| mlx-lm venv missing | Auto-bootstrap with progress |
| No models installed | Entry → Settings → Local Models |
| Gateway port in use | Explicit conflict message naming port 21434 |
| Backend won't start | Surface the `mlx_lm.server` stderr tail, not just "failed" |
| Model loading | Gateway holds the request; UI shows "Loading <model>…" |
| Model too large for this Mac | "Needs ~X GB, this Mac has ~Y GB" — never a silent timeout |
| Model lacks native tool calls | Badge in the browser + warning at both entry points |

The last row is load-bearing. Both OpenCode and grok drive everything through
structured tool calls, so a model whose chat template cannot emit them is useless
for coding. `catalog.rs` already tracks this per model; it only needs surfacing.

## Testing

**Rust**
- Residency manager: admission, LRU eviction, in-flight interlock (a model with
  in-flight requests is never evicted), single-flight loads, over-budget refusal.
- Gateway routing: `model` field → correct backend; SSE forwarded unbuffered.
- Capability-gate resolution across all states.
- Existing `catalog` / `discovery` tests retained.

**Sidecar (vitest)**
- `OPENCODE_CONFIG_CONTENT` contains the `local` provider with the correct
  `baseURL` and a models map matching discovery output.
- Rebuild-on-change logic including the "dirty while sessions active" path.

**Frontend**
- Chat: the Local Model tile creates an `opencode-sdk` thread with a `local/` slug.
- Terminal: the plus-button "local" entry writes the managed layer, then spawns grok.
- `render_managed_config` output parses as TOML and refuses to clobber a
  `managed_config.toml` lacking the agmux sentinel.
- Empty-state routes to Settings rather than failing.
- Settings renders the Local Models page.

**Manual shakedown — required before this is considered done**
Clean state → bootstrap → download a model → a real coding turn that edits files
in chat → the same in a grok terminal → switch models inside grok and confirm the
gateway swaps cleanly → both surfaces active at once and confirm eviction does not
kill an in-flight turn. This is the step whose absence let the current agent loop
ship as "not great," and it is a completion criterion, not a nicety.

## Decomposition

| # | Sub-project | Depends on | Rationale |
|---|---|---|---|
| 1 | **Gateway + both surfaces** — this spec | — | Chat and terminal share the gateway, so splitting them would mean designing it twice |
| 2 | **Quality** — tune the harness/model pairing (tool-call reliability, context, speed), refine residency heuristics under real use | 1 | Needs a working baseline to measure against |

The originally-planned third sub-project — "build a local-model CLI" — is gone.
grok already supports local endpoints via config, so the CLI is the terminal
surface in item 1, not a separate build.

## Out of scope

- Connecting to user-managed Ollama / LM Studio / llama.cpp servers.
- Replacing the llama-server GGUF utility model used for titles and summaries.
- Non-Apple-Silicon support.
- Forking grok-build. It is Apache-2.0 and forkable, but config is sufficient.
- Exposing the gateway beyond `127.0.0.1`.
- FIM / inline completion. `mlx_fim_complete` is registered in `lib.rs:680` and
  exported at `src/lib/mlx.ts:211` but called from no component — already dead
  code, so it retires with `client.rs` at no cost.
