# Terminal Performance Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ghostty-web terminal pipeline with xterm.js + WebGL + headless snapshot persistence + binary/batched PTY transport, matching the architecture that makes `xanom-temp/superset-main/` feel smooth.

**Architecture:**
- **Backend (Rust):** PTY reader emits raw bytes (no base64) coalesced into ~8ms / 256KB flushes via Tauri Channel<Bytes>. Per-session ring buffer (1MB cap) backs a `get_pty_snapshot` command for instant rehydration on remount.
- **Frontend:** xterm.js + addon-webgl + addon-fit + addon-unicode11 + addon-clipboard + addon-serialize + addon-search. Binary channel listener writes directly to xterm via RAF-batched coalescing. Snapshot rehydration on mount means cold tabs come back instant. Resize throttled to 100ms.
- **Mount policy:** ideStore tracks an LRU "warm set" of 8 most-recently-used terminal sessions. Cold tabs render a placeholder until the user clicks them, at which point they pull a snapshot and start consuming events.

**Tech Stack:** Tauri v2, Rust portable-pty, React 19, xterm.js 5.x, addon-webgl, addon-serialize, Zustand 5.

**User authorization (2026-04-06):** Explicitly overrode the `Terminal | ghostty-web 0.4 (WASM) — NOT xterm.js` line in `CLAUDE.md` and the ghostty-web mention in `.claude/rules/src.md`. Both files MUST be updated as part of this work.

---

## Phase A — Backend: binary + batched PTY emits

**Files:**
- Modify: `src-tauri/src/process/io.rs` (full rewrite of `start_stdout_reader` and `start_shell_stdout_reader`)
- Modify: `src/hooks/usePtyOutput.ts` (Channel<Bytes> instead of base64 string)
- Modify: `src/lib/types.ts` (PtyOutputEvent.data: Uint8Array)

**Key decisions:**
- Use `app_handle.emit` with `Vec<u8>` payload — Tauri v2 serializes via JSON; binary needs to be either base64 (current) or use a `tauri::ipc::Channel<Vec<u8>>` registered at session spawn. Channel skips JSON entirely. We'll go with Channel for the data path and keep `app_handle.emit` only for the exit event.
- Coalescing: accumulate into a `Vec<u8>` (cap 256KB). Flush when (a) buffer ≥ 256KB, or (b) ≥ 8ms since last flush. Use `crossbeam_channel::after` or simple `Instant::now()` polling per read iteration.
- Ring buffer is updated on every read, not on flush (snapshot accuracy > flush cadence).

## Phase C — Backend: ring buffer + snapshot command

**Files:**
- Modify: `src-tauri/src/process/session.rs` (add `output_buffer: Arc<Mutex<RingBuffer>>` to PtySessionContext)
- Create: `src-tauri/src/process/ring_buffer.rs` (1MB capacity bounded VecDeque<u8>)
- Modify: `src-tauri/src/process/io.rs` (push every read to ring buffer)
- Modify: `src-tauri/src/commands/session.rs` (or wherever PTY commands live — add `get_pty_snapshot`)
- Modify: `src-tauri/src/lib.rs` (register new command)
- Modify: `src/lib/commands.ts` (TS binding for getPtySnapshot)

**Tests:** Unit test the ring buffer (push past capacity drops oldest; snapshot returns last N bytes; concurrent access).

## Phase E1 — Frontend: xterm.js deps + loader

**Files:**
- Modify: `package.json` (add @xterm/xterm, @xterm/addon-fit, @xterm/addon-webgl, @xterm/addon-clipboard, @xterm/addon-unicode11, @xterm/addon-serialize, @xterm/addon-search)
- Create: `src/lib/xterm-loader.ts` (factory that creates a configured xterm Terminal instance with all addons attached, themed)

## Phase E2 — Frontend: TerminalView.tsx rewrite

**Files:**
- Rewrite: `src/components/thread/TerminalView.tsx`
- Create: `src/hooks/usePtyChannel.ts` (RAF-batched binary channel listener)

## Phase E3 — Frontend: ClaudeTerminalView.tsx rewrite

**Files:**
- Rewrite: `src/components/thread/ClaudeTerminalView.tsx`

**Behaviors to preserve:**
- Alt-screen detection (CLAUDE_ALT_SCREEN_PATTERNS) → use xterm `parser.registerCsiHandler` for `?1049h` instead of regex on raw bytes.
- Loading reveal logic (`holdLoadingUntilReady`, `isResume` idle/timeout)
- Progress UI

## Phase E4 — Delete ghostty-web

**Files:**
- Delete: `src/lib/ghostty.ts`
- Modify: `package.json` (remove ghostty-web)
- Search for and update any other importers

## Phase D — Warm-set mount policy

**Files:**
- Modify: `src/stores/ideStore.ts` (add warmSet: string[], touchTerminal(id) action)
- Modify: `src/components/layout/IdeTerminalPanel.tsx` (only mount sessions in warm set + active)
- Cold tab placeholder: render `term.write(snapshot)` once into a static container without subscribing to live events.

## Phase Docs — Update CLAUDE.md + .claude/rules/src.md

**Files:**
- Modify: `CLAUDE.md` (Tech Stack table; Terminal Rendering section if any)
- Modify: `.claude/rules/src.md` (Terminal Rendering subsection — replace ghostty-web with xterm.js)

## Final — Type check + commit + push

- `npx tsc --noEmit`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- Single commit on `feat/terminal-perf`
- `git push -u origin feat/terminal-perf`
