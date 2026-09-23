# Gemini Chat (Antigravity ACP) — Design Spec

**Date:** 2026-09-03
**Status:** Spec review approved, pending user review
**User decisions:** official Antigravity ACP (`agy_acp_server`), Codex-glassy UI, keep Gemini PTY tile, isolated Google login, Apple Silicon only

## 1. Goal

Add a Codex-style structured chat for Gemini in agmux: permission prompts, tool rows, permission modes, model selector, and effort selector. Drive it with Google’s official Antigravity ACP agent (`agy_acp_server`), the same protocol family as Grok chat (`grok agent stdio`). Keep the existing Gemini terminal tile (`agy` PTY).

## 2. Source Findings

Primary sources:

- T3 Code Antigravity provider: [docs/user/providers-antigravity.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-antigravity.md), [permission-modes.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md), PR [#9348](https://github.com/pingdotgg/t3code/pull/9348)
- T3 Code adapters: `apps/server/src/provider/acp/AntigravityAcpSupport.ts`, `AntigravityProtocol.ts`
- ACP registry: [antigravity-acp/agent.json](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json)
- agmux Grok ACP: `src-tauri/src/grok/`, `commands/grok_sdk.rs`, `GrokSdkSessionView.tsx`
- agmux Codex glassy chat: `docs/superpowers/specs/2026-07-09-codex-glassy-chat-redesign-design.md`, `CodexSessionView.tsx`, `src/components/thread/tools/codex/`
- Rejected path: `agy --print --input-format stream-json` has no live Allow/Deny; tools that need approval are soft-denied ([headless docs](https://antigravity.google/docs/cli/headless))

Facts that bind this design:

- T3 Code does **not** wrap the `agy` TUI. It downloads `agy_acp_server` from Google and speaks ACP JSON-RPC over stdio.
- ACP methods match Grok except resume: `initialize`, `authenticate`, `session/new`, **`session/resume`** (not Grok’s `session/load`), `session/prompt`, `session/cancel`, `session/set_config_option`. Agent→client: `session/update`, `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`. T3 sets `resumeMethod: "resume"`. Cloning Grok and calling `session/load` will fail every remount.
- Permission modes on the agent: `default`, `auto_edit`, `yolo`. T3 maps Auto (guardian) to `default` because Antigravity has no reviewer subagent.
- Plan is Antigravity’s native `/plan` slash, not a permission mode. T3 does not show a Plan pill.
- Effort is encoded in the model slug (`gemini-3.8-flash-high`). The ACP model config option is a flat select.
- `session/request_permission` with `toolCallId` prefix `interaction_` is a fixed-choice question, not a tool approval. It still appears in Full access. Custom text is not allowed.
- `allow_always` on shell/web tools may carry `_meta["agy.security.warning"]` (prompt-injection warning).
- Chat file I/O is advertised as client `fs.readTextFile` / `fs.writeTextFile` so writes become permission requests with content.
- Signing in to Antigravity IDE or `agy` CLI does **not** sign in the ACP agent. T3 uses an isolated `GEMINI_HOME`.
- Darwin Intel is unpublished. Registry currently ships `darwin-aarch64` only.
- Zip contains the ACP executable (`agy_acp_server.par` on macOS/Linux) plus a `localharness_external` helper that must sit next to it.
- Registry version observed while designing: `1.1.1`. Pin version + SHA-256 in-repo; bump deliberately.
- Antigravity ACP does not support conversation rewind.
- On-disk ACP conversations live under `$GEMINI_HOME/antigravity-acp/conversations/{uuid}.db`. Do not parse that SQLite in v1.

## 3. Scope

### In Scope

- Interaction mode `gemini-sdk` on existing provider `Gemini`.
- Codex-glassy `GeminiSessionView` (composer, tool rows, turn collapse, approval dialog).
- Rust ACP client cloned from Grok ACP (do not generalize `src-tauri/src/grok/` in v1).
- Managed download of `agy_acp_server` for `darwin-aarch64`.
- Isolated `GEMINI_HOME` and personal Google OAuth (`oauth-personal`).
- Live permission prompts and fixed-choice questions.
- Model picker from ACP config options; effort split from the slug.
- Image attachments.
- Draft-chat launch path (same as Grok chat).
- Keep Gemini PTY tile and existing `agy` permission/toast behavior unchanged.

### Out of Scope (v1)

- `agy` stream-json, hidden PTY overlay, `gemini --acp`
- Sharing `agy` CLI/IDE login
- Gemini Enterprise, API key, Vertex / Agent Platform
- Plan pill, Fast pill, Codex Auto Review
- PDF / audio / text attachments
- Task-view Gemini chat
- Bundling the ACP runtime in the app
- PATH / “binary path” override
- Conversation rewind / edit-and-resubmit
- Intel Mac
- Parsing Google’s conversation SQLite
- Teams scan of ACP transcripts (Gemini PTY usage stays as-is)

## 4. Architecture

```text
DraftChatView (provider Gemini)
  -> addThread { provider: Gemini, interaction_mode: gemini-sdk }
  -> ThreadView
  -> GeminiSessionView (Codex glassy chrome)
       -> invoke gemini_sdk_*
       -> Rust commands/gemini_sdk.rs
       -> src-tauri/src/gemini/  (ACP client, cloned from grok/)
       -> agy_acp_server.par stdio
       -> session/update + session/request_permission
       -> sdk-event-{threadId}
       -> CodexToolRow / ApprovalBanner / EffortSelector
```

One ACP process per agmux thread (Grok pattern). Do not multiplex sessions onto one process in v1.

Do not spawn `agy`. Do not reuse Grok’s process manager. Copy and trim.

Hard stops this work must not touch: PTY I/O, Grok ACP `event_mapper` behavior, sidecar JSON-RPC shapes, `threads.provider` CHECK (Gemini already exists).

**Dispatch / remote:** `dispatch::surface_for` today maps unknown pairs to `"terminal"`. Add `("Gemini", "gemini-sdk") => "chat"` and send via `gemini_sdk_send_prompt`. **Never** fall back to PTY resume/inject for a `gemini-sdk` thread (that would spawn or write `agy` and break “do not spawn `agy`”). If chat send is unavailable, return an error. Rooms/A2A/remote use this same map. Clone Grok’s `send_to_thread` chat arm, not the PTY arm.

When cloning Grok: **do not** copy cowork preamble or memory-MCP injection unless a later spec asks. v1 Gemini chat is a coding agent in the workspace, not Grok cowork.

`terminateThreadProcess` / thread delete/stop must call `gemini_sdk_stop_session` (same as `grok-sdk`). Otherwise stop hits PTY `stopThread` and leaks the ACP process.

`spawn.rs`: reject `interaction_mode == "gemini-sdk"` the way Cursor/MLX do, so a stray `startThread` cannot spawn `agy`.

JSON-RPC request timeout: do **not** reuse Grok’s 300s on `authenticate`. OAuth can outlast it. Prompt/turn timeouts can stay; authenticate waits until the user finishes or cancels sign-in.

Gemini chat `send_to_thread` / `gemini_sdk_send_prompt` takes ACP image **blocks**, not Grok’s temp-path injection (Grok ACP is text-only).

## 5. Data Model

Migration `039_gemini_sdk_interaction_mode.sql`: recreate `threads` to add `'gemini-sdk'` to `interaction_mode` CHECK. Current allowlist (037): `'pty', 'sdk', 'opencode-sdk', 'mlx', 'grok-sdk', 'cursor-sdk'`. Follow 037’s child-table backup pattern.

| Column | Use |
|---|---|
| `provider` | `Gemini` (unchanged) |
| `interaction_mode` | `gemini-sdk` for chat; `pty` for the existing tile |
| `sdk_session_id` | ACP session id |
| `model` | Full ACP model slug, including effort suffix when present |
| `reasoning_effort` | `low` / `medium` / `high` when the slug encodes it; else null |

Frontend `InteractionMode` union gains `"gemini-sdk"`.

Also add `"gemini-sdk"` to Rust `VALID_INTERACTION_MODES` / `normalize_provider_interaction_mode` and the TS `createThread` union. SQL CHECK + the TS type alone still fail `create_thread`.

`isPtyTerminalProvider` treats `Gemini` + `gemini-sdk` as chat, same as `Grok` + `grok-sdk`.

## 6. Binary install

Store under `~/.agmux/antigravity-acp/<version>/`. Keep both files from the zip in that directory, executable.

On first `gemini_sdk_ensure_server`:

1. If pinned version dir is complete, use it.
2. Else download the registry URL for `darwin-aarch64`, verify size + SHA-256, extract, chmod.
3. Probe with ACP `initialize`. Failure surfaces in the chat pane; never fall back to `agy`.

Pin `{ version, url, sha256, size }` in Rust. Bumping the pin is a deliberate change.

Non-arm64 macOS: return a clear error (“Gemini chat needs Apple Silicon”). Do not download.

## 7. Auth

Isolated profile at `~/.agmux/antigravity-acp/home` (`GEMINI_HOME`). Do not read or write `~/.gemini/antigravity-cli/` for chat login. Token file: `$GEMINI_HOME/antigravity-acp/acp_token.json`. Profile dirs `0700`.

`GEMINI_HOME` alone is **not** enough on macOS. Spawn env (T3 `buildAntigravityAcpSpawnInput` / `antigravityEnvironment`):

| Set | Value |
|---|---|
| `GEMINI_HOME` | Isolated profile |
| `AGY_ACP_FORCE_FILE_STORAGE` | `1` (otherwise tokens go to the shared keychain / IDE/`agy` login) |
| `ANTIGRAVITY_HARNESS_PATH` | Absolute path to sibling `localharness_external` |
| `PYTHONUNBUFFERED` | `1` |
| `BROWSER` | Helper that **does not** open a real browser. Capture the URL; agmux opens it once. Without this the agent may auto-open a window **and** we open the captured URL. |

Strip (do not inherit) at least: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_CLOUD_QUOTA_PROJECT`, `GOOGLE_GENAI_USE_VERTEXAI`, `GCLOUD_PROJECT`, `CLOUDSDK_CORE_PROJECT`, `AGY_ACP_CCPA_PROJECT`, `AGY_ACP_ENABLE_OAUTH`. Otherwise the agent can use an API key despite “no API-key fallback”.

v1 auth method: `oauth-personal`.

**Sign-in URL (runtime 1.1.1):** prefix
`Open the following link to authenticate the ACP server: `
on **stderr** (older builds used stdout). Watch **both** streams. This is a non-JSON ACP stdio line, not an RPC field. A Grok-cloned JSON-RPC parser that only reads stdout will miss sign-in.

Accept the rest of the line only if it parses as `https://accounts.google.com/o/oauth2/v2/auth?...` with `response_type=code` and `redirect_uri=http://127.0.0.1:<port>/` (port ≥ 1024). Drop unrelated lines. Deduplicate helper URL vs prefix URL so Google opens **once**.

**Who opens the browser:** Rust opens the captured URL with the system opener (`open` on macOS). The UI only shows Sign in with Google + a copyable URL. Do not open from both layers.

Keep the ACP process alive until the callback returns (known Zed bug: killing the process during OAuth makes `127.0.0.1` fail).

`BROWSER` helper: capture-only (T3 writes the URL, exits 0 on EPIPE). The helper command must not contain `:` or `;` (Python splits `BROWSER` on the platform path separator).

**Already signed in:** token file present **and** `authenticate` completes without emitting that prefix. `gemini_sdk_auth_status` reports this; `gemini_sdk_sign_in` starts OAuth only when needed.

No API-key fallback on `SUBSCRIPTION_REQUIRED` or quota errors. Show Google’s message.

**Logout:** intercept a prompt that is exactly `/logout` **before** `session/prompt` (do not send it to the agent as a user turn). Call native ACP `logout` (unauthenticated is fine), delete `acp_token.json`, stop **all** live `gemini-sdk` ACP processes, and show Sign in with Google. PTY `agy` tile is unaffected.

## 8. ACP client and commands

New module `src-tauri/src/gemini/` (app server + event mapper) and `commands/gemini_sdk.rs`. Register in `lib.rs`. Add AppState: `gemini_servers` analogous to `grok_servers`.

| Command | Purpose |
|---|---|
| `gemini_sdk_ensure_server` | Install/probe binary if needed, spawn ACP, authenticate if already signed in, `session/new` or `session/resume`, return ACP session id |
| `gemini_sdk_send_prompt` | `session/prompt` with text + optional image blocks. If the trimmed prompt is exactly `/logout`, run logout (§7) instead of prompting |
| `gemini_sdk_cancel` | `session/cancel` |
| `gemini_sdk_respond_approval` | Resolve `session/request_permission` with the offered `optionId` |
| `gemini_sdk_set_permission_mode` | Map UI mode → ACP `default` / `auto_edit` / `yolo` (`session/set_config_option` or next-request policy; prefer the agent’s advertised config option) |
| `gemini_sdk_set_model` | ACP model config option (full slug, effort included). If the slug is not in the advertised catalog, fail and ask — do not send a made-up sibling |
| `gemini_sdk_list_models` | From ACP session config options (`id === "model"`) |
| `gemini_sdk_read_history` | `agent_logs` for the thread (empty if none) |
| `gemini_sdk_stop_session` | Kill that thread’s process |
| `gemini_sdk_auth_status` | Signed-in vs needs-login (token file + last authenticate outcome) |
| `gemini_sdk_sign_in` | Start OAuth (`authenticate` oauth-personal); emit the captured URL to the UI |

Advertise client capabilities on `initialize`:

```text
fs.readTextFile: true
fs.writeTextFile: true
terminal: false
```

Workspace `fs/` reads/writes that fall outside the project still need the same approval path Grok uses for outside-workspace fs.

Permission mode is **agent-side** for Antigravity (unlike Grok, which ignores `--permission-mode` in stdio and gates in the client). Still fail closed: if a `session/request_permission` arrives in Full access, show it (questions always; tool asks if the agent sends them). Never auto-pick `allow_always`.

Cancel in-flight prompt: wait for the prompt to settle (T3 `cancelBehavior: "wait-for-prompt"`), then idle.

## 9. Event mapping

Normalize ACP `session/update` into `sdk-event-{threadId}` so the view can consume a Codex-shaped timeline.

| ACP | UI |
|---|---|
| `agent_message_chunk` | Agent prose (no bubble) |
| `agent_thought_chunk` | `CodexThinkRow` |
| `tool_call` / `tool_call_update` kind execute / `run_command` | `Ran <cmd>` → `CodexTermBlock` |
| fs write / edit | `Wrote` / `Edited <path>` → `CodexDiffBlock` |
| read / view_file | `Read <path>` |
| web | `Searched "<query>"` |
| other tools | `CodexToolRow` with tool title |
| `plan` | `ChatTasksPanel` / sticky todos if the payload is a task list; otherwise ignore |
| `session/request_permission` (tool) | `ApprovalBanner` dialog |
| `session/request_permission` (`interaction_*`) | Question dialog; options = offered choices only |
| usage on updates | `ContextRing` when token counts exist |

Tool payload sanitization: bound text (~8 KiB display, ~64 KiB retained), drop `data:image` blobs from retained events (T3 `sanitizeAntigravityToolPayload`).

Completed-turn collapse: reuse `collapseCompletedTurns` against the Gemini timeline.

Write `agent_logs` as events arrive. That is the restart transcript. Do not parse `$GEMINI_HOME/antigravity-acp/conversations/*.db`.

## 10. Composer and permissions

Codex single-row glassy composer:

| Control | Behavior |
|---|---|
| Attach | Images only: JPEG/PNG/WebP (and BMP if the file picker yields it). **Not GIF** — ACP image blocks match T3: `image/jpeg`, `image/png`, `image/webp`, `image/bmp` |
| Model | ACP model list, Gemini glyph. Persist full slug on `threads.model` |
| Effort | Split trailing `-low`/`-medium`/`-high` (existing `prettifyGeminiModel` / `stripGeminiEffortSuffix`). Changing effort writes the sibling slug via `gemini_sdk_set_model` **only if that slug is in the ACP catalog**. If the sibling is missing, keep the current model and tell the user. Hide slider when the selected model has no effort suffix |
| Permissions | Default / Auto-accept edits / Full permissions |
| Context ring | When usage exists |
| Send / stop | Codex behavior |

Omit Plan pill and Fast pill.

| Composer label | ACP mode | Behavior |
|---|---|---|
| Default | `default` | Ask before commands and file writes |
| Auto-accept edits | `auto_edit` | Edits auto; shell/web still ask |
| Full permissions | `yolo` | Auto-approve tools. Questions still appear |

Do not offer Codex “Auto Review”. Antigravity has no guardian subagent.

Approval banner buttons, only if the agent offered that kind:

- Allow once (`allow_once`)
- Allow for this thread (`allow_always`) — show `agy.security.warning` when present
- Deny (`reject_once`)

Never invent an option the request did not include. Cancel maps to `outcome: cancelled` when no matching reject is offered.

Default model: `gemini-3.8-flash-high` when the account lists it; otherwise the agent’s current selection. If a resumed thread’s model disappeared, ask the user to pick — do not silently switch.

## 11. Launch and UI routing

- `DraftChatView`: Gemini is a structured-chat provider (Grok path). First send: `addThread({ provider: "Gemini", interactionMode: "gemini-sdk", model, reasoningEffort })`, stash pending first message + permission mode, select the thread.
- New-menu **gemini** tile stays `handleNewNamedPty("Gemini")`.
- `ThreadView`: `provider === "Gemini" && interaction_mode === "gemini-sdk"` → `GeminiSessionView`. Copy Grok’s **PTY `useEffect` early-returns** (do not auto-spawn PTY or inject the pending first message as `sendPtyInput`), not only the render branch. Also skip Gemini PTY-only hooks (usage poll, surface unload) when `interaction_mode === "gemini-sdk"`. PTY Gemini unchanged.
- `PaneTabBar` `kindNameFor`: `gemini-sdk` is `"Chat"`.
- `NewThreadDialog` `TERMINAL_ONLY_PROVIDERS`: Gemini remains terminal-only there; draft chat is the chat entry.
- `isTerminalOnlyProvider()` is used for top-bar/render parity — do not use it to block Gemini chat. Gate on `interaction_mode` instead where needed.
- Task agent tab: PTY only in v1.
- Sidebar: chat threads are not PTY rows. ACP session ids must not appear as discovered Gemini terminals (they won’t share `agy` conversation files if `GEMINI_HOME` is isolated; still filter `gemini-sdk` threads out of PTY grouping).

`GeminiSessionView` is a dedicated view (not a thin wrap of `GrokSdkSessionView`). Reuse Codex presentational components (`CodexToolRow`, `EffortSelector`, `ApprovalBanner`, composer chrome). Transport/lifecycle can follow `GrokSdkSessionView` (ensure server on mount, pending first message after ACP session id).

## 12. History, resume, errors

- Live: `sdk-event-{threadId}`.
- Durable UI: `agent_logs`. `gemini_sdk_read_history` on mount.
- Resume: `sdk_session_id` → **`session/resume`** (not `session/load`). If resume fails, keep `agent_logs` on screen and `session/new`. Do not wipe the thread. Tell the user the agent lost provider context.
- No rewind.

| Failure | UI |
|---|---|
| Binary missing / checksum / extract fail | Error + Retry. Never spawn `agy` |
| Not signed in | Sign in with Google |
| `SUBSCRIPTION_REQUIRED` / quota | Google’s message. No API-key fallback |
| Process crash | Error + Retry. Pending approval cancelled |
| Intel Mac | “Gemini chat needs Apple Silicon” |
| Tool approval | Banner, never a hang |

Offload: when the view unmounts and no turn/approval is in flight, stop the ACP process after a delay (same idea as Grok session offload). Remount cancels the timer and `ensure_server` + `session/resume`.

## 13. Tests

- Permission option mapping: tool vs `interaction_*`; only advertised kinds; security warning passthrough.
- Model/effort slug split and sibling rewrite; missing sibling slug fails (does not invent).
- Tool update → Codex row lead/subject (`run_command` → Ran, fs write → Edited/Wrote).
- Rust ACP client: initialize, prompt, permission round-trip, **`session/resume` fail → `session/new`**. No live Google in CI (fixture stdio).
- Stdio filter: auth prefix on **stderr and stdout**; unrelated lines ignored; JSON-RPC still parsed from stdout.
- Spawn env: `AGY_ACP_FORCE_FILE_STORAGE=1`, stripped `GEMINI_API_KEY` / `GOOGLE_*`.
- `/logout` intercept: does not `session/prompt`; clears token; stops sibling processes.
- `GeminiSessionView` composer: three permission labels, no Plan/Fast, effort hidden without suffix.
- Draft launch writes `gemini-sdk`.
- Migration 039 CHECK includes `gemini-sdk`; PTY Gemini threads still insert.
- `isPtyTerminalProvider` false for Gemini chat.
- `dispatch::surface_for("Gemini", "gemini-sdk") == "chat"`; PTY Gemini still `"terminal"`. Chat send must not call PTY spawn.
- `create_thread` accepts `gemini-sdk`; `spawn.rs` rejects it; `terminateThreadProcess` stops the ACP process.

## 14. Docs / product copy

- `RELEASE_NOTES.md` under Unreleased → New: Gemini chat (Codex-style) via Antigravity, separate from the Gemini terminal. Sign in with Google on first use. Apple Silicon.
- `AGENTS.md` Gemini row: PTY remains `agy`; chat is `gemini-sdk` / `agy_acp_server`, isolated `GEMINI_HOME`, bind `sdk_session_id`.
- Architecture rule: add `gemini-sdk` to the interaction-mode table.

## 15. Key Decisions

| Decision | Choice | Why |
|---|---|---|
| Protocol | Official `agy_acp_server` ACP | t3code; live permissions. `agy` headless cannot prompt |
| UI | Codex glassy, not Grok/Claude cards | User request |
| Grok code | Clone, don’t generalize | Hard stop on Grok ACP; v1 isolation |
| PTY tile | Keep | Two surfaces, like Grok |
| Login | Isolated `GEMINI_HOME` + `AGY_ACP_FORCE_FILE_STORAGE` + strip `GOOGLE_*` / `GEMINI_API_KEY` | Keychain would share IDE/`agy` login |
| OAuth URL | Prefix on stderr **and** stdout | 1.1.1 prints stderr; older stdout |
| Resume | `session/resume` (not Grok `session/load`) | Cloning Grok would lose provider context on remount |
| Logout | Intercept `/logout` before prompt; ACP `logout` + delete token + stop all `gemini-sdk` processes | Spec’d mechanism, not a model-bound slash |
| Effort | Split slug, not a separate ACP field | Agent models are `name-effort` |
| Auto Review | Omit | No guardian subagent |
| Plan | `/plan` text, no pill | Agent has no Plan permission mode |
| History | `agent_logs` | Don’t parse Google SQLite |
| Runtime | Download, not bundle | Large, versioned independently |
| Arch | Apple Silicon only | Google’s registry |

## 16. PR Plan

Single implementation track on `master` (or `feat/gemini-chat-acp` if the diff is large). Sequence:

1. Migration 039 + `InteractionMode` + routing stub (`GeminiSessionView` placeholder).
2. Binary pin/download + ACP client + `gemini_sdk_*` commands + AppState.
3. Event mapper, permissions, fs client, `agent_logs`.
4. `GeminiSessionView` Codex chrome + approvals + model/effort.
5. Draft launch, sign-in card, sidebar grouping, RELEASE_NOTES / AGENTS.md.
6. Tests listed in §13.

Each step should typecheck. Do not ship a New-menu chat entry until step 4 renders approvals.

## Open Questions

None remaining. User approved architecture, composer/approvals, launch/auth/install, and history/errors/v1 cut.
