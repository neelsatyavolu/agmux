# Performance Scan Report — Xanom (Jul 1, 2026)

Full scan across all 7 areas: React rendering, Zustand stores, Tauri IPC, Rust backend, terminal/WASM, bundle size, memory leaks. Findings only — no code changed.

## Critical (User-visible impact)

1. **[React] `renderMessage` depends on `messages` — Virtuoso itemContent invalidated every 12ms during streaming**
   - File: `src/components/thread/ClaudeSdkSessionView.tsx:2952` (dep array), `:1263` (12ms typewriter interval), `:3093` (`itemContent={renderMessage}`)
   - Problem: The typewriter reveal calls `setMessages` every 12ms (~83Hz). `renderMessage` is `useCallback`'d with `messages` in its deps (only used for `messages.findIndex(...)` at `:2781`), so its identity changes on every flush. Virtuoso re-renders **all visible rows**, not just the streaming one — each visible `MarkdownContent` re-runs a full remark/GFM parse 83 times per second.
   - Impact: ~83 full re-renders/sec of every visible message during streaming; visible jank on long assistant responses, high CPU on battery.
   - Fix: drop `messages` from the deps and read via a ref:
     ```tsx
     // before (line 2952)
     [sessionId, cwd, messages, isWorking, handleForkFromMessage, getBackgroundTask, compactedExpanded, threadModel],
     // after: add near other refs
     const messagesRef = useRef(messages); messagesRef.current = messages;
     // inside renderMessage: const msgIndex = messagesRef.current.findIndex(...)
     [sessionId, cwd, isWorking, handleForkFromMessage, getBackgroundTask, compactedExpanded, threadModel],
     ```
     Item identity then comes from Virtuoso's `data` diffing — only the changed row re-renders.

2. **[React] `MarkdownContent` is not memoized — used by all four chat views**
   - File: `src/components/thread/MarkdownContent.tsx:214`
   - Problem: Plain function component; `closeOpenMarkers()` + `cleanContent()` regexes plus a full `ReactMarkdown` parse run on every parent render even when `content` is unchanged. Consumers: ClaudeSdkSessionView, CodexSessionView, OpenCodeSdkSessionView, ChatView, CodeEditor.
   - Impact: Multiplies findings #1, #3, #4 — markdown parsing is the single most expensive per-row operation in every transcript.
   - Fix:
     ```tsx
     // before
     export function MarkdownContent({ content }: Props) {
     // after
     import { memo } from "react";
     export const MarkdownContent = memo(function MarkdownContent({ content }: Props) { ... });
     ```

3. **[React] OpenCode view: non-virtualized transcript + non-memoized `BlockRenderer` + per-delta `setBlocks`**
   - File: `src/components/thread/OpenCodeSdkSessionView.tsx:853` (per-event `setBlocks` with `fullText`), `:470` (`groupBlocks(blocks)` recomputed per update), `:1642-1644` (plain `renderBlocks.map`, no virtualization), `:2152` (`BlockRenderer` not memoized)
   - Problem: Every streaming `assistant_text` event re-runs `groupBlocks` over the whole conversation and re-renders **every** block in the thread — including a markdown re-parse of every historical assistant message.
   - Impact: O(conversation length) work per delta; long OpenCode threads degrade progressively until input feels laggy.
   - Fix (minimal, no rewrite): wrap `BlockRenderer` in `React.memo` (blocks other than the streaming one keep reference equality through the upsert-copy pattern at `:869`, so memo works immediately). Longer term, adopt Virtuoso as the other views do.

4. **[React] Codex view: O(len²) re-normalization per delta + inline `itemContent` closure**
   - File: `src/components/thread/CodexSessionView.tsx:4230-4247` (delta handler), `:1168` (`normalizeCodexAgentContent`), `:2089` (inline `itemContent`)
   - Problem: Each `item/agentMessage/delta` runs `setItems` with `prev.find` + `prev.map` and calls `normalizeCodexAgentContent(i.content + delta)` over the **entire accumulated message** — quadratic in message length, once per delta, with no coalescing (unlike the Claude view's 12ms buffer). The inline `itemContent` arrow also gets a new identity on every parent render, re-rendering all visible Virtuoso rows.
   - Impact: A 20KB streamed answer triggers hundreds of full-string normalizations + full visible-row re-renders; CPU spike on every Codex turn.
   - Fix: accumulate deltas in a ref and flush on a 12-16ms interval (reuse the ClaudeSdkSessionView pattern); run `normalizeCodexAgentContent` only at flush; hoist the `itemContent` body into a `useCallback` keyed on `expandedDiffs`/`model`.

## High (Measurable impact)

5. **[Zustand] `ProjectGroup` subscribes to whole per-session maps — sidebar-wide re-render cascade**
   - File: `src/components/sidebar/ProjectGroup.tsx:289-292` (`codexProcessingById`, `claudeProcessingById`, `unreadSessionIds`, `lastPromptAt`)
   - Problem: Any single session's processing flag/prompt-time/unread change re-renders **every** `ProjectGroup` (2,277-line component) for every project, even unrelated ones. These maps churn constantly while any agent is working (hook state machine transitions).
   - Impact: N-projects × full group re-render per hook event.
   - Fix: subscribe to project-scoped derived values, e.g. `useUiStore(useShallow((s) => threadIds.map(id => s.claudeProcessingById[id] ?? false)))`, or move per-session lookups into a memoized per-row component that selects only its own key.

6. **[Bundle] 3.17MB main chunk, zero `React.lazy` — Settings/Editor/CodeMirror all in the startup path**
   - File: `src/App.tsx:3-18`, `src/components/layout/MainPanel.tsx:5-12`, `src/lib/languageMap.ts:2-12`
   - Problem: `index-BkoVD4MU.js` is 3,175,266 bytes. `SettingsDialog` (3,435 lines), `TaskViewLayout`, all five session views, and CodeMirror + 13 language modes (statically imported via `languageMap.ts` → `CodeEditor` → `EditorPanel` → every session view) load and parse before first paint. No `React.lazy` exists anywhere in `src/`.
   - Impact: Startup parse/compile cost of code most sessions never use (settings, IDE editor).
   - Fix: `const SettingsDialog = lazy(() => import("./components/sidebar/SettingsDialog"))` (+Suspense) — it renders only when opened; same for `EditorPanel`. CodeMirror language modes can be dynamic-imported in `getLanguageExtension` keyed by extension.

7. **[Rust] `list_claude_sessions` does synchronous filesystem scanning on the tokio runtime**
   - File: `src-tauri/src/commands/threads.rs:434` (`std::fs::read_dir`), `:500-560` (head/tail reads of up to 30 JSONL files, sync `File::open`/`BufReader`)
   - Problem: The scan (dir listing + `metadata()` per file + up to 30 × 128KB bounded reads) runs inline in the async command, blocking a tokio worker. Called every 15s per project by HomeScreen (`HomeScreen.tsx:380`) plus sidebar bursts and `ClaudeSessionView` polls.
   - Impact: With 600+ JSONL projects, each scan holds a runtime worker for tens of ms; concurrent scans across projects can starve other commands (PTY resize, git status).
   - Fix: wrap the post-cache-miss scan body in `tokio::task::spawn_blocking` — the file already uses this pattern for `scan_claude_diff_stats` at `:727` and `:1830`.

## Medium (Minor optimization)

8. **[IPC] SDK `content.delta` events are emitted per-delta with no coalescing**
   - File: `src-tauri/src/commands/claude_sdk.rs:549`
   - Problem: Each sidecar delta line becomes one Tauri emit, unlike the PTY path which coalesces at 16ms (`process/io.rs`). The frontend buffers into refs so render cost is contained, but every delta pays JSON serialize + IPC bridge crossing.
   - Fix: accumulate delta text and emit at a 16ms cadence, mirroring `spawn_flusher` in `io.rs`. (Hard-stop note: this changes event *timing* only, not the JSON-RPC protocol shape — still worth confirming before touching per CLAUDE.md sidecar rules.)

9. **[Zustand] Whole-store subscriptions in three components**
   - Files: `src/components/UpdateChecker.tsx:94` (`useUpdateStore()`), `src/components/thread/MlxBootstrapBanner.tsx:6`, `src/components/thread/JournalPanel.tsx:131`
   - Problem: Selector-less subscription re-renders on every store change. UpdateChecker re-renders on download-progress ticks even when only a hidden field changed.
   - Fix: select the fields used, e.g. `useUpdateStore((s) => s.status)`.

10. **[IPC] Ungated / always-fresh-object polls**
    - Files: `src/components/thread/GrokSdkSessionView.tsx:134` (2.5s poll constructs a new usage object every tick → guaranteed re-render even when values are unchanged); `src/components/thread/GitBranchSelector.tsx:44`, `src/components/thread/InputBar.tsx:109`, `src/components/thread/DraftChatView.tsx:240` (5s `getGitInfo` polls with no `document.hidden` gating — contrast `useGitStatus.ts` which gets this right)
    - Fix: shallow-compare before `setUsage` in Grok view; add the `visibilitychange` pause pattern from `useGitStatus.ts:60-70` to the branch polls (or extract a shared `usePolledInvoke` helper).

## Low (Micro-optimization, do when convenient)

11. **[Rust] `SELECT *` on wide tables** — `src-tauri/src/db/queries.rs:25,147,320` etc. `agent_logs.content` can be multi-KB; list queries that only need metadata still deserialize full rows. Explicit column lists would trim payloads crossing the command boundary. Low priority: usage sites mostly consume full rows.
12. **[React] HomeScreen 15s poll runs while window is hidden** — `src/components/layout/HomeScreen.tsx:380`. It already refetches on focus/visibility, so add `if (document.hidden) return;` inside the interval callback.
13. **[Memory] Unbounded (but small) accumulation** — `uiStore` per-session maps (`claudeProcessingById`, `lastPromptAt`, `unreadSessionIds`) and `sessionNameStore` localStorage entries grow with session count and are never evicted. Bytes-per-entry is tiny; only worth a prune pass if session counts reach thousands.

## Healthy (No issues found)

- **PTY pipeline** (`src-tauri/src/process/io.rs`): visibility-aware coalescing (16ms foreground / slower hidden), bounded emit payloads, ring-buffer snapshot rehydration, final drain before `pty-exit`, flusher joined before exit. Well engineered.
- **Terminal frontend** (`src/lib/xterm-loader.ts`, `TerminalInstance.tsx`): RAF-batched `writeBatched`, Canvas renderer with documented WKWebView rationale, pause-while-hidden, correct listener/disposable cleanup. Base64 decode is a simple linear pass on already-coalesced chunks — fine.
- **Event listener hygiene**: `usePtyOutput.ts`, `Sidebar.tsx`, `TerminalInstance.tsx`, `useGitStatus.ts` all have correct unlisten/cancelled-flag cleanup; every `setInterval` found has a matching `clearInterval`.
- **Memory management**: `MainPanel.tsx:149` evicts cached views after 3 min idle with a processing-guard; `lastActiveTimeRef` entries deleted on evict; `ClaudeSdkSessionView` clears typewriter interval and state-machine timers on unmount.
- **Backend caching**: `list_claude_sessions` 500ms cache + mtime-sorted head/tail bounded reads + deferred background diff scans; `usage_stats.rs` 12h scan TTL; `git.rs` uses `tokio::process::Command` (fully async, no runtime blocking).
- **Bundle (partial)**: `@withfig/autocomplete` loaded via `/dynamic` (lazy per-spec chunks); Vite `optimizeDeps.entries` scoped; App.tsx uses dynamic `import()` for cold paths.
- **List virtualization**: Claude and Codex views use react-virtuoso with stable `computeItemKey`, pagination for older messages (`loadOlderMessages`, 200/page), and module-level Virtuoso components to avoid Header/Footer remounts.

**Top-3 by effort/impact ratio**: #2 (one-line `memo()` wrap), #1 (one dep-array change + one ref), #5 (selector scoping) — together they eliminate the bulk of streaming-time CPU burn in the two most-used views.
