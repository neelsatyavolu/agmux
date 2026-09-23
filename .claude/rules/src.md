---
paths:
  - "src/**"
---

# React / TypeScript Rules (src/)

## Zustand v5 + React 19
- Selectors MUST return stable references — NEVER `|| []` or `|| {}` in selectors
- Use module-level constants: `const EMPTY: T[] = []; ... useStore((s) => s.x ?? EMPTY)`
- Store functions (actions) are stable references — safe as useEffect dependencies
- Data selectors may return new references on updates — don't put them in useEffect deps

## Session visibility

- Task mode renders `ClaudeSessionView`, `CodexSessionView`, and `ThreadView`, retaining shared provider lifecycle and controls. Mode layouts stay mounted after first entry; the task session host caches visited agents across task switches, evicting only idle sessions without pending input after three minutes. `SessionPresentationContext` supplies exact visibility for cached task views; `useIsSessionActive` otherwise resolves the selected task tab (falling back from missing/archived tabs). Persisted agent panes/sidebar selections do not determine task visibility. `SessionPanelsContext` routes session toolbar Git/shell buttons to task-owned panels and suppresses duplicate per-agent editor/Git/shell mounts. Preserve the task's worktree for Git and its agent's `work_dir` for provider operations, including multi-repo tasks. Both creation menus share `taskAgentCreation.ts`; Codex task views pass `initialViewMode` from the loaded thread, before either engine starts.
- Pass actual presentation visibility to `ThreadTopBar`, `ClaudeInputBar`, `InputBar` and `GitBranchSelector`; Codex's mounted chat composer is inactive in terminal mode. Git polling uses `lib/gitPolling.ts` to share only pending reads for the exact work directory (no settled cache or cross-worktree reuse). Running-time timers pause off-screen and catch up from their original start. Codex snapshots remain active for questions/completion while hidden; active terminal turns use the one-second monitor instead of an additional three-second read, sharing pending snapshots without caching settled results. Lifecycle reads are scoped to the submitted turn start, so they cannot reuse a pre-submit snapshot. Sidebar completion/idle events batch automatic list refreshes with one trailing request and a five-second minimum between starts; manual refresh remains immediate.
- `useIsSessionActive` / `useIsSessionHiddenInPanes` / `useIsPresentationActive` (`src/hooks/useIsSessionActive.ts`) gate terminal pausing and presentation work. Pane tabs in `splitViewStore` are persisted but only rendered while `settings.multiViewEnabled` is on; the hooks return false for pane membership when it is off. Never derive "hidden" from pane tabs alone — a stale tab made on-screen terminals skip output (black Codex terminals, frozen Claude/Grok terminals).

## File Drag & Drop
- `tauri.conf.json` sets `dragDropEnabled: true`, so OS file drops do NOT reach the DOM as HTML5 drop events — WKWebView never exposes real filesystem paths to the DOM. Do NOT add `onDrop`/`dataTransfer` handlers for files; they won't fire.
- All file drops flow through `useNativeFileDrop(ref, onDrop, onDragState?)` (`src/hooks/useNativeFileDrop.ts`): one shared `getCurrentWebview().onDragDropEvent` listener hit-tests each drop position (via `document.elementFromPoint`) against registered target elements. Register a drop zone by attaching its ref and passing an `onDrop(paths)` callback.
- The hit area is expanded from the leaf element (terminal viewport / input pill) to its enclosing pane: the hook registers `ref.closest("[data-native-drop-pane]")` if present. Mark a pane's outermost root with `data-native-drop-pane=""` so a drop anywhere in it (top bar, padding) routes to that pane's input. ONLY mark panes with a single drop leaf — a pane with both a composer and an always-mounted `TerminalView` (e.g. `CodexSessionView`) must stay unmarked or the two registrations collide on the same element.
- Composer drops: image paths → `pathToImageAttachment` → `addImages`; other paths → `appendPathsToText` into the input (quoted only when they contain spaces). Terminal drops → `sendPtyInput` the quoted paths (no submit). Helpers live in `ImageAttachmentBar.tsx` (`isImagePath`, `quotePathIfNeeded`, `appendPathsToText`, `pathToImageAttachment`).
- Composer + buttons use `FileAttachmentButton`: dynamically open the native all-files picker (DOM file inputs do not expose real paths), preview supported images, and insert other files or unavailable previews with `appendPathsToText`.
- Clipboard/paste image handling is separate (`extractImagesFromPaste`) and still uses DOM `paste` events — unaffected by the drag-drop change.

## Tauri Invoke
- `invoke()` parameter keys MUST be camelCase (Tauri auto-converts from Rust snake_case)
- Every `invoke()` in event handlers or effects MUST have error handling (.catch or try/catch)
- Unhandled invoke errors are invisible — always surface errors to the user

## Agent accounts settings
- Native CLI logins appear automatically as read-only `native` rows with `currentLogin`; adding Codex/Grok logins to switching remains explicit. A managed row with the same verified identity gets the badge without duplication. Current login is the native CLI login, not proof of which account an existing session uses. Email/plan are display metadata; unknown plans stay unknown.
- Home and Usage share `useAccountUsage` and `AccountUsageRows`: show each native or managed Claude/Codex/Grok account instead of the provider’s single default login. Personal windows come from native quota reports; team rows use server-reported summary capacity only. Never allocate team credentials to paint usage; preserve unknown, stale and elapsed-reset states.
- `agentAccounts` is the dedicated Settings tab for Claude/Codex/Grok accounts and automatic fallback. Keep Git identities and existing connections in `accounts`; runtime account notices link to `agentAccounts`. Account rows are grouped by provider, with extra actions collapsed under Options and role checks retained for team editing.
- Claude accounts are personal-only: reset a Claude selection to Codex when changing to team scope, exclude Claude team rows, and reject Claude team login requests. Native Claude is already primary; hide both “Add to switching” and “Use existing login” and never import its credentials. New personal Claude profiles use native browser sign-in. Preserve reported Sonnet/Opus/Designs/Routines windows without inventing absent limits. Runtime notices accept Claude with the same fixed-copy validation and provider/session deduplication as Codex/Grok; label them Claude and never expose native error or credential fields.

## Settings cleanup
- `CleanupSection` scans before confirmation. `sessionNameStore` rechecks cache fingerprints, verified native activity, manual names and open/running IDs before removing entries older than 90 days; unknown ages are kept. Discovery calls from Home/ProjectGroup use `mode="discovery"` so cleared summaries are not immediately regenerated. Real prompts and explicit resummarization still work. Native cleanup is a finite allowlist in `commands/cleanup.rs`; never broaden it to transcripts, attachments, thread state, project memory or Teams data.

## Components
- Dialogs return `null` when `!open` — they remount each time (useState resets)
- `@tauri-apps/plugin-dialog` must be dynamically imported (see `useDialogOpen()` pattern)
- ErrorBoundary wraps the entire app in `main.tsx` — catches render crashes
- Slash commands defined in `src/lib/slashCommands.ts` — `SlashCommandPopup` provides autocomplete UI

## Session Views
- `ClaudeSessionView.tsx` — PTY mode container; renders `ClaudeChatView` + `ClaudeTerminalView`
- `ClaudeSdkSessionView.tsx` — Claude SDK mode; structured chat from `sdk-event-{threadId}`
- `CursorSdkSessionView.tsx` — Cursor SDK chat (same event bus / adapter patterns as Claude SDK)
- `OpenCodeSdkSessionView.tsx` — OpenCode SDK chat
- `GrokSdkSessionView.tsx` — Grok ACP chat (events normalized to `sdk-event-{threadId}`)
- `ClaudeChatView.tsx` — renders structured chat with markdown, tool use blocks, inline diffs
- `CodexSessionView.tsx` — Codex session container with JSON-RPC event rendering
- `DraftChatView.tsx` — pre-session draft view for composing initial prompts
- `ClaudeInputBar.tsx` — input bar with slash command popup, file mentions, model/effort dropdowns
- `ProviderModelDropdown.tsx` — model selection dropdown with claudeOnly mode for SDK
- `ToolUseBlock.tsx` — renders tool invocations; `InlineDiff.tsx` — renders code diffs
- `ApprovalBanner.tsx` — approval prompts for tool use

## PTY Events (Claude Code threads)
- Listen to `pty-output-{threadId}` for base64-encoded terminal data
- Listen to `pty-exit-{threadId}` for process exit (exit_code may be null)
- Use `useClaudeChat` hook for structured chat; `useCodex` for Codex sessions

## SDK Events (Claude SDK threads)
- Listen to `sdk-event-{threadId}` for structured SDK events
- `sdkSessionAdapter.ts` adapts SDK events into renderable chat messages
- SDK events include: content deltas, tool starts/completions, approval requests, turn completions

## Codex Events
- Sidebar Recalculate diff uses `recalculate_session_diff` for the exact selected owner/session. Publish returned absolute totals only if no newer live store update arrived; keep shell ledger totals separate. A saved-only refresh must not replace native history counters or clear capture guards.
- Recalculation must visibly distinguish no recorded changes from missing capture evidence. Persist known incomplete-capture notices across navigation/restarts; aging out hook metadata cannot restore historical before-images. Numeric badges with known capture gaps show partial totals.
- Native parent/subagent totals come from the backend; CodexSessionView keeps own-session edit bookkeeping without publishing competing sidebar totals. `nativeIncomplete` marks verifiable-history gaps separately from permanently missing capture snapshots and clears when a later complete result arrives.
- Home/sidebar discovery share `src/lib/codexThreadsCache.ts`: hydrate compact persisted rows at startup, then refresh in the background. `thread/list` is global, so overlapping project requests share one promise. Persist metadata only and reset cached runtime status on restart.
- Listen to `codex-event` for JSON-RPC notifications from the Codex App Server
- Listen to `codex-thread-models` (`Record<threadId, model>`) — background model enrichment for the sidebar thread list; `codex_list_threads` returns without model labels and emits this when JSONL scanning completes
- CodexSessionView uses `activeThreadIdRef` to prevent race conditions when switching sessions
- Codex chat following is user intent: layout-only `atBottom=false` must not unpin it. Coalesce `totalListHeightChanged`, viewport resize, content changes, and window focus/visibility recovery into one guarded frame. Wheel/touch/keyboard scrolling and tool/timeline inspection pause following; reaching the bottom or Jump to latest resumes it. Observe the scroller only for viewport size: Virtuoso’s first child is a fixed-height viewport, not the measured list.

## Terminal Rendering (xterm.js + Canvas)
- Terminal uses xterm.js 5.x with `addon-canvas`, `addon-fit`, `addon-serialize`, `addon-unicode11`, `addon-clipboard`, `addon-search`
- **Why Canvas, not WebGL:** `@xterm/addon-webgl` has a known DPR mismatch on Tauri's WKWebView that produces textured/distressed glyph rendering. The Canvas addon is the officially-supported middle ground — still GPU-composited, 2–5× faster than the DOM fallback, DPR-correct, and more than fast enough for AI agent terminal workloads.
- Terminal palettes preserve ANSI black/white background semantics in both modes. Keep xterm `minimumContrastRatio: 4.5` enabled so indexed/truecolor text remains readable against each cell background, including CLI input panels; do not invert ANSI black/white to fix foreground contrast. Light terminal host backgrounds must match the canvas.
- `src/lib/xterm-loader.ts` — `createXterm()` factory builds a configured Terminal + addons + RAF-batched `writeBatched()`. `prepareTerminalFont(family, size)` actively triggers `document.fonts.load()` so cell metrics are measured against the correct font. `attachCanvas(bundle)` loads the renderer after `term.open()`. `reattachCanvas(bundle)` disposes and re-loads on font change (the Canvas addon caches its glyph cache at attach time and won't pick up font changes otherwise). `decodeSnapshot(b64)` turns a base64 PTY snapshot into a Uint8Array.
- `TerminalView.tsx` — general-purpose xterm-based terminal for Claude/Codex PTY threads with snapshot rehydration on mount
- `ClaudeTerminalView.tsx` — Claude-specific xterm terminal: alt-screen detection, startup buffering, prompt-draft tracking for session naming, file path link provider, image paste/drop, approval state machine, snapshot rehydration
- `StandaloneTerminalView.tsx` — generic shell terminal with alt-screen on/off callbacks, OSC7 cwd detection, agent-done sentinel, Warp-style preexec block rendering
- `TerminalPanel.tsx` — slide-in shell terminal with drag-to-resize chrome and Cmd+K AI popup
- All four components share the same RAF-batched coalescer via `bundle.writeBatched()` and pull cached scrollback from Rust via `getPtySnapshot(threadId)` on mount
- Terminal catch-up with a known byte watermark appends only the missing snapshot suffix when the ring still covers it and the local write queue has not discarded output. Preserve parser state, mouse modes and scrollback; only reset/replay when continuity is lost. Do not trim VT/UTF-8 continuation bytes on the append path.

## Tool Renderers (`src/components/thread/tools/`)
- Each tool type has a dedicated renderer: Bash, Edit, Read, Write, GlobGrep, Task, ApplyPatch, AskUser, TodoWrite
- Shared types in `tools/types.ts`; barrel export in `tools/index.ts`
- Used by `ToolUseBlock.tsx` to delegate rendering per tool type

## Codex Minimal Tool Rows (`src/components/thread/tools/codex/`)
- The "Glassy Chat / Codex Minimal" design language: every tool call is one inline monospace row that expands into its detail panel.
- `CodexToolRow` — the row itself (icon, lead verb, subject, dim detail, `+N −M`, toggle). The **whole row** is the click target (`role="button"`) when it has a toggle.
- `CodexDiffBlock` / `CodexTermBlock` / `CodexOutputBlock` / `CodexThinkRow` — the expandable bodies (diff, shell output, tool/MCP/subagent result, reasoning).
- `CodexCollapse` — height-animated reveal wrapping every expandable body. Children **unmount** when closed (not CSS-hidden), which collapsed-content tests rely on. Reads `settings.animationSpeed` directly, because `ThemeProvider` sets `setAttribute("n", speed)` instead of `data-animation`, so the CSS speed overrides in `index.css` never match. (Pre-existing bug.)
- Shared across Codex and the SDK tool renderers. `ToolActivityGroup` uses borderless child rows with inline `CodexOutputBlock` input/results; keep file opening separate from expansion. `TaskToolRenderer` uses compact `CodexToolRow` children and preserves its newest-first overflow behavior.
- Rows expose `data-testid="codex-tool-row"` + `data-lead` + `data-status` — prefer these over text matching in tests.
- Command rows never render a blank **Ran**. `codexCommandRowCopy` labels in-flight shells **Running** (or **Serving** for an HTTP server) and summarizes heredoc/compound commands to the runner line. `item/started` must stamp `commandName` so background `outputDelta` streams are not nameless.
- Codex code-mode wrappers must remain visible even when they cannot be expanded safely. Preserve an expandable raw Code execution row for unknown, partial or truncated print plans; never pair outputs by scanning around unrecognized prints. A missing shell exit status is not exit zero, and expanded command panels show the full original command rather than the shortened row subject.
- Expansion state lives in `MessageList`'s `expandedDiffs` record, keyed by item id. Reasoning rows default to the global `settings.showThinking` preference.
- Text colors come from CSS variables (`--text-*`). Surfaces come from the `.codex-*` classes in `index.css` — **never** from `--surface-1`, which is a translucent *overlay* (`rgba(255,255,255,0.03)`), not a base color. Mixing an accent into it yields near-transparency. Don't hardcode hex in `.tsx` — `src/lib/__tests__/themeLightModeCoverage.test.ts` lints for it; put literal colors in `index.css` with a `html[data-mode="light"]` override.

## Composer Controls (`src/components/ui/`)
- `EffortSlider` — stepped "Faster ↔ Smarter" slider. Steps come from the caller (`codexEffortsForModel` yields 3–6 rungs), so never hardcode a level count. Handles pointer drag, click-to-snap, and Arrow/Home/End. Geometry: knob centre travels `10px → 100%-10px` and the fill runs to the knob's trailing edge, so both ends land flush — see the geometry tests before changing the `calc()` strings.
- Don't add a CSS `transform` rule for `.effort-knob`; its transform is an inline style and would win.
- `ContextRing` with `compact` renders a masked donut (not an opaque inner circle) so it sits correctly on any surface. Shared with the Claude and OpenCode composers.
- `EffortBars` / `SelectedRail` are still used by `ClaudeInputBar` and `InputBar` — don't delete them when touching Codex.

## Codex Turn Collapse (`src/components/thread/codexTurns.ts`)
- `collapseCompletedTurns(entries, turnActive)` folds each finished turn into one `turnSummary` entry: prompt → `Thought for 3m 45s` → the agent's **last** message. Everything between hides until clicked.
- The in-flight turn (`turnActive`, i.e. `sending`) is never collapsed — it renders every row live.
- Duration is turn wall-time (prompt timestamp → final reply timestamp), formatted by `formatTurnDuration`. The reasoning row itself carries **no** duration.
- `CodexTimelineEntry` lives here, not in `CodexSessionView`. `CodexSessionView` exports `ConversationItem` / `FileChange` for it via type-only imports (erased at runtime, so no cycle).
- Expansion state is `MessageList`'s `expandedTurns`, keyed by summary id (`turn-<user item id>`).

## Stores (`src/stores/`)
- `threadStore` — thread CRUD, selection, state management
- `settingsStore` — application settings and preferences
- `sessionNameStore` — Claude/Codex session display names with batched LLM summarization
- Session title updates share `sessionNameStore.summarize` across normal sends, delivered queues, and steering. Preserve established titles for approval/continuation-only messages and bare slash commands (check the user ask before skill expansion). Keep substantive history when trimming and include the current title as context for new asks. Merely queueing a message must not rename the session.
- `splitViewStore` — split view panel layout and pane state
- `editorStore` — open files, active tab, editor state
- `projectStore` — project CRUD and selection
- `uiStore` — sidebar tab, UI flags, transient state, appMode ("agent" | "task" | "ide")
- `journalStore` — AEL journal entries
- `skillsStore` — skills management
- `terminalStore` — terminal session state
- `localModelStore` — local LLM model state
- `mlxBootstrapStore` — MLX bootstrap / readiness
- `taskViewStore` — task/worktree view state, selected task, git state
- `notificationHistoryStore` — notification history tracking
- `composerDraftStore` — composer draft state for pre-session prompts
- `updateStore` — app update state
- `toastStore` — transient toasts
- `usageQuotaStore` — provider usage / quota chrome
- `yourThreadsStore` — cross-project "your threads" list

## Styling
- Tailwind CSS v4 with `@import "tailwindcss"` in index.css
- `@tailwindcss/vite` plugin in vite.config.ts
- Dark theme: zinc-950 bg, zinc-100 text, blue-600 accents
- All icons from lucide-react

## Subagent Conversations (`src/components/thread/subagents/`)
- `SubagentInspector` is a shared docked, read-only viewer for ClaudeCode, Cursor, Grok, Codex and OpenCode. Gemini/MLX recognized launches use the same shell with assignment/result details and an explicit unavailable-history message; their integrations do not expose native child transcripts. Pass the agmux parent ID separately from the native provider session ID; never mount a lifecycle-owning chat view for a child.
- `SubagentLaunchRow` owns the Viewing/Running/Completed/Waiting labels. `groupMessages` keeps all recognized provider launch tools individual so they reach this row. Parent status changes invalidate stale inspector status. Codex history reads and parent turn completion must not complete child launches; child lifecycle comes from child history or explicit child status. Codex task-path-only spawn results resolve against the child metadata’s exact agent path and parent ID.
- `read_subagent_conversation` is the viewer's only backend operation. Reads run while the pane is open and the parent surface is presented; completed snapshots refresh less often. Closing does not stop/resume the provider. The Tasks pane yields its space while inspecting.
- `cleanSubagentPrompt`/`prepareSubagentConversation` remove injected AGENTS/environment setup from the display only, preserving the actual assignment. The inspector uses the regular `codex-wall`/`codex-glass`/`codex-topbar` theme classes, including light-mode overrides.
- `src/lib/subagentConversations.ts` normalizes native tool names/inputs/results for existing `ToolUseBlock`/Codex renderers. Keep child content and lifecycle out of parent reducers. Nested launch details remain inline until provider ancestry can be verified.
- Claude/Cursor bridges capture child snapshots under `~/.agmux/threads/{id}/subagent-conversations/{toolUseId}.json`; Rust reads native Claude/Codex/Grok history or stored Cursor task results as fallback. Missing/truncated transcripts must be identified explicitly, never replaced by a fabricated conversation.
- OpenCode reads its local database without starting a provider: match the parent's exact task part ID/call ID and child session metadata, then verify `session.parent_id`. Its full block feed drives the overview even when launch rows are collapsed. Claude/Cursor completed results must refresh stale captures and preserve final replies; child arguments need normalization because they bypass parent bridge adapters.

- Codex child history must start at the child-owned thread boundary, not include forked parent history. Recover delegated assignments from actual spawn/NEW_TASK records; encrypted saved assignments require an explicit unavailable state, never the parent user prompt. `subagentExec.ts` parses only literal, directly printed tool calls with Acorn; never execute saved JavaScript or infer tool calls from comments/branches. Preserve ambiguous wrapper output under “Code execution”. Parent Codex chat expands the same printed `exec` calls into command/MCP rows (grouped when there are 2+) and keeps unparseable wrappers hidden.

- The approved overview is stacked Tasks then Subagents cards. Parents pass full `subagents` feeds into `SubagentInspector`, independent of virtualized/collapsed launch rows. `SubagentInspectorTasks` renders the existing Tasks card (embedded mode) plus `SubagentActivityCards` at the original Tasks location inside the chat stage BELOW the thread top bar. These are floating cards, never a full-height sibling column or a portal beside the top bar. Only the child conversation is a sidebar. Reserve space within `.subagent-card-stage`, never shrink the thread top bar.
- `useSubagentActivity` polls `read_subagent_conversation` with `activityOnly: true` for nonterminal agents every 5s, at most 3 readers concurrently, only while overview/parent are presented. Summary responses omit transcript/assignment/output and contain at most the latest tool. Parent transitions invalidate stale cached status; the full inspector remains read-only. Narrow windows use an expandable activity rail.

- `useSubagentRegistry` treats the current parent feed as authoritative: removed agents must disappear from Completed too. Scope observations to native conversation identity, reject stale callbacks and reused child IDs, and keep callbacks stable for equivalent streamed feeds. Reset viewer state without remounting the parent chat.

- Codex user questions render inline above the composer using `CodexUserInput`, not the approval modal. Native `requestUserInput` replies are `{ answers: { [questionId]: { answers: string[] } } }`; retain the form on send failure. Async question tool records remain readable in history and their answers steer a running turn or send a normal follow-up when idle. Hide shell polling/control rows in both live and history rendering.

## Session timeline
- `commands/thread_turns.rs` reads the ledger, with structured-history recovery when it is empty. Native Codex/Claude IDs need read-only history because they may have no `threads` row. Never create a DB thread merely to show its timeline.
- Recovered turns derive their outcome from their own assistant reply; local summaries reuse `thread_turns/history.rs`. Keep summary evidence within the turn's time window.
- Chat jump mappings use full user-message data and prompt matching, never end-align a virtualized DOM subset. Missing prompts/scrollback must report a failed jump. Only Grok may receive Grok navigation keys.
- Phone session pickers consume the normalized conversation feed and jump by entry ID for chat and terminal sessions. Keep `remote-relay/public/{app,index}.html` and `remote-mobile/www/{app,index}.html` in sync; test `remote-relay/tests/session-timeline.test.mjs`.

- Codex terminal MCP permission forms are absent from native transcripts. `TerminalView` observes the current xterm screen (never scrollback) and reports them through `onPermissionPrompt`; `CodexSessionView` publishes terminal-only attention independently of transcript questions. Hidden terminals with this observer skip output like every other provider; a chunk that hints at a form (`codexPermissionChunkHint`) triggers a throttled snapshot catch-up and screen scan, and while a form is showing the contiguous stream keeps parsing so its dismissal is seen. Permission decisions stay in the native terminal.

- Codex chat recovery keeps one-second lifecycle checks but reads full history only while presented, at most every five seconds, with independent, non-overlapping status/history requests. A slow history read must not block completion checks. Live events remain immediate; hidden reasoning deltas buffer until activation or the next non-reasoning event. Preserve background completion and approval tracking when changing presentation work.

- Buffered OpenCode text/thinking must flush before non-stream events append tools, prompts, errors or completion so background conversations preserve arrival order. Cursor history diff backfill counts only successful completed tool results and uses the atomic `onlyIfZero` update, while live Codex deltas remain additive. Codex tool identity is the call ID; matching names/arguments alone cannot merge separate calls.

## Support and startup recovery
- `StartupGate` loads the main app only after `startup_status` succeeds; recovery and `SupportSection` must work without AppState. Initialize app visibility/notification tracking only after successful startup.
- Support is explicit user submission to owner.agmux.dev, separate from anonymous analytics. Never auto-upload crash files/transcripts. Preserve the draft on send failure; show success only with a server receipt. Native file picker/drop routing only. The error boundary and startup recovery can render Support directly.
- First-run setup defaults to the short provider/permissions/project path. Appearance and local models are opt-in customization; installed-provider detection is not authenticated readiness.
