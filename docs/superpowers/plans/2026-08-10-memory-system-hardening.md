# Memory System Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agmux project memory crash-recoverable, provenance-safe, concise, searchable, private by default, and easy to curate.

**Architecture:** Keep the existing version-1 JSON stores as source of truth, adding compatible revision, authority, and binding defaults in both Node and Rust. Enforce the same mutation contract at every boundary, generate balanced local-only projections, and expose health/curation through narrow MCP, CLI, Tauri, and React surfaces.

**Tech Stack:** Rust/Tauri, Node.js ESM sidecars, JSON-RPC MCP, React/TypeScript, Node test runner, Cargo tests, Vitest.

**Design:** `docs/superpowers/specs/2026-08-10-memory-system-hardening-design.md`

---

## File map

- `sidecar/agmux-memory-store.mjs` — Node memory contract, revisions, trust, health, rendering, locking.
- `sidecar/agmux-handoff-store.mjs` — Node handoff revisions, no-op commits, locking, warnings.
- `sidecar/agmux-search.mjs` — ranked matching and revision-backed cursors.
- `sidecar/agmux-memory-mcp.mjs` — schemas, resources, health tool, trusted caller mapping, warnings.
- `sidecar/agmux-memory-cli.mjs` — strict CLI inputs and warning propagation.
- `sidecar/fixtures/memory-contract.json` — shared compatibility, classification, snapshot, and projection fixtures.
- `sidecar/*memory*.test.mjs`, `sidecar/agmux-search.test.mjs` — Node red/green coverage.
- `src-tauri/src/memory/mod.rs` — Rust parity contract, context snapshot, env/instruction injection.
- `src-tauri/src/handoff/mod.rs` — Rust handoff revision and lock parity.
- `src-tauri/src/commands/memory.rs`, `src-tauri/src/lib.rs` — snapshot, health, binding, and mutation envelopes.
- `src-tauri/src/commands/codex.rs` — explicit per-turn handoff identity for multiplexed Codex.
- `src/lib/commands.ts` — typed snapshot/health/mutation wrappers.
- `src/components/thread/MemoryMainPanel.tsx` — health, review queue, confirmation, warnings, honest search copy.
- `src/components/thread/__tests__/MemoryMainPanel.test.tsx` — UI behavior.
- `.gitignore`, `.agmux/MEMORY.md`, `.agmux/SESSIONS.md` — local-only generated projection migration.
- `RELEASE_NOTES.md`, `AGENTS.md` or `.claude/rules/architecture.md` — user-facing delta and durable implementation conventions.

### Task 1: Define the shared memory contract in Node

**Files:**
- Create: `sidecar/fixtures/memory-contract.json`
- Modify: `sidecar/agmux-memory-store.test.mjs`
- Modify: `sidecar/agmux-memory-store.mjs`

- [ ] **Step 1: Write failing tests and golden cases**

Add fixtures for legacy defaults (`revision=0`, `authority=source`, derived binding), strict kind rejection, secret classification without value disclosure, user/system/agent precedence, no-op revisions, duplicate-title repair boundaries, cumulative supersession, legacy integrity health findings, and exact JSONL snapshot/Markdown projection rendering. Both Node and Rust consume the expected render cases.

```js
assert.equal(loadStore(legacyPath, "p1").revision, 0);
assert.equal(entry.authority, entry.source);
assert.equal(agentImportant.binding, false);
assert.throws(() => updateEntry(store, userEntry.id, { actor: "agent", kind: "note" }), /authority/i);
assert.equal(store.revision, beforeRevision);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd sidecar && node --test agmux-memory-store.test.mjs`

Expected: failures for missing revision/authority/binding, secret validation, health, and lifecycle behavior.

- [ ] **Step 3: Implement the minimal Node contract**

Add compatible defaults to `emptyStore`/`validateStore`, strict mutation kind validation, immutable `source`, monotonic `authority`, explicit confirm/revoke binding helpers, generic secret rejection, normalized-title guards on every activation path, cumulative supersession, structural validation plus non-blocking integrity analysis, and change-aware mutation results.

- [ ] **Step 4: Verify GREEN**

Run: `cd sidecar && node --test agmux-memory-store.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add sidecar/fixtures/memory-contract.json sidecar/agmux-memory-store.mjs sidecar/agmux-memory-store.test.mjs
git commit -m "feat(memory): harden Node memory contract"
```

### Task 2: Implement safe crash-lock recovery in both Node stores

**Files:**
- Modify: `sidecar/agmux-memory-store.test.mjs`
- Modify: `sidecar/agmux-handoff-store.test.mjs`
- Modify: `sidecar/agmux-memory-store.mjs`
- Modify: `sidecar/agmux-handoff-store.mjs`

- [ ] **Step 1: Write failing crash-lock tests**

Create expired locks owned by a definitely absent PID and verify the next mutation succeeds. Create expired locks owned by the current PID and malformed/ambiguous locks and verify they are not reclaimed. Assert the replacement lock token is never removed. Add handoff assertions for legacy `revision=0`, increment-on-change, no-op stability, and projection-warning preservation.

- [ ] **Step 2: Verify RED**

Run: `cd sidecar && node --test agmux-memory-store.test.mjs agmux-handoff-store.test.mjs`

- [ ] **Step 3: Implement shared recovery semantics**

Inspect owner metadata only after acquisition fails. Confirm lease age and `process.kill(pid, 0)` reports `ESRCH`, atomically rename to a unique quarantine path, verify the observed token, and delete only that quarantined directory. Keep the five-second timeout for active or ambiguous owners. Add compatible handoff revisions and change-aware commits so projection-only retries do not advance revision.

- [ ] **Step 4: Verify GREEN and concurrent writers**

Run: `cd sidecar && node --test agmux-memory-store.test.mjs agmux-handoff-store.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add sidecar/agmux-memory-store.mjs sidecar/agmux-handoff-store.mjs sidecar/agmux-memory-store.test.mjs sidecar/agmux-handoff-store.test.mjs
git commit -m "fix(memory): recover abandoned store locks"
```

### Task 3: Bring Rust memory and handoffs to contract parity

**Files:**
- Modify: `src-tauri/src/memory/mod.rs`
- Modify: `src-tauri/src/handoff/mod.rs`
- Test: inline `#[cfg(test)]` modules in both files
- Read fixture: `sidecar/fixtures/memory-contract.json`

- [ ] **Step 1: Add failing Rust golden/parity tests**

Load the shared fixture using a path relative to `CARGO_MANIFEST_DIR`. Cover legacy defaults, precedence/authority elevation, binding derivation, secret classifications, no-op revision behavior, title/lifecycle invariants, rendering, handoff revision, dead-lock recovery, and active-lock refusal.

- [ ] **Step 2: Verify RED**

Run: `cargo test -p xanom memory::tests`

Run: `cargo test -p xanom handoff::tests`

- [ ] **Step 3: Implement Rust parity**

Add serde-defaulted `revision`, `authority`, `binding`, and confirmation fields; actor-aware mutation helpers; health analysis; generic secret scanning; monotonic commit revisions; change-aware mutations; balanced JSONL snapshots; single-entry projection rendering; and the same lock quarantine algorithm used by Node. Extend the existing child-process tests so Node reclaims dead Rust-created memory and handoff locks and Rust reclaims dead Node-created locks; both runtimes must refuse active/ambiguous locks and preserve replacement tokens.

- [ ] **Step 4: Verify Rust and mixed Node/Rust writers**

Run: `cargo test -p xanom memory::tests`

Run: `cargo test -p xanom handoff::tests`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/memory/mod.rs src-tauri/src/handoff/mod.rs
git commit -m "feat(memory): enforce Rust memory contract parity"
```

### Task 4: Fix MCP, CLI, resources, warnings, and health

**Files:**
- Create: `sidecar/agmux-memory-cli.test.mjs`
- Modify: `sidecar/agmux-memory-mcp.test.mjs`
- Modify: `sidecar/agmux-memory-mcp.mjs`
- Modify: `sidecar/agmux-memory-cli.mjs`
- Modify: `src-tauri/src/memory/mod.rs` (allowed-tool list)

- [ ] **Step 1: Write failing protocol-boundary tests**

Assert `allow_duplicate` is absent, kind/scope/from schemas use enums, `memory_health` is listed, resources capability is advertised, only the advertised URI can be read, lower-authority mutations fail, agent binding is impossible, and projection warnings appear on all mutations including `session_upsert`. In the CLI integration test, spawn every memory mutation plus `session-upsert` against temporary stores and assert warnings reach stderr/stdout, invalid enums fail, and duplicate/source bypass flags are rejected.

- [ ] **Step 2: Verify RED**

Run: `cd sidecar && node --test agmux-memory-mcp.test.mjs agmux-memory-cli.test.mjs`

- [ ] **Step 3: Implement minimal MCP/CLI changes**

Map both MCP and CLI memory mutations to actor `agent`; remove caller-controlled source and duplicate bypass; add the read-only health tool; correct resource metadata/capability/URI checks; validate bounded integers/enums; and consistently append non-secret projection warnings. Add `memory_health` to `claude_allowed_memory_tools()`.

- [ ] **Step 4: Verify GREEN and CLI smoke behavior**

Run: `cd sidecar && node --test agmux-memory-mcp.test.mjs agmux-memory-cli.test.mjs agmux-memory-store.test.mjs agmux-handoff-store.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add sidecar/agmux-memory-mcp.mjs sidecar/agmux-memory-cli.mjs sidecar/agmux-memory-mcp.test.mjs sidecar/agmux-memory-cli.test.mjs src-tauri/src/memory/mod.rs
git commit -m "fix(memory): align MCP and CLI trust boundaries"
```

### Task 5: Improve projection and search retrieval quality

**Files:**
- Modify: `sidecar/agmux-memory-store.test.mjs`
- Modify: `sidecar/agmux-search.test.mjs`
- Modify: `sidecar/agmux-memory-store.mjs`
- Modify: `sidecar/agmux-search.mjs`
- Modify: `src-tauri/src/memory/mod.rs`

- [ ] **Step 1: Write failing retrieval tests**

Assert important entries render exactly once, generated data is JSON encoded, capped projection reports omissions, snapshots include at least one entry from every non-empty lane when the budget permits, agent-important entries are marked review rather than binding, short queries require all terms, longer queries require a majority, phrase/title boosts win, and any revision change invalidates a cursor.

- [ ] **Step 2: Verify RED in Node and Rust**

Run: `cd sidecar && node --test agmux-memory-store.test.mjs agmux-search.test.mjs`

Run: `cargo test -p xanom memory::tests`

- [ ] **Step 3: Implement balanced context and ranking**

Render each entry once, encode all untrusted fields, allocate snapshot budget round-robin across binding/issues+pins/decisions/facts+notes, report counts, filter search hits by minimum token coverage, apply bounded phrase/title/proximity/recency boosts, and encode store revisions in cursors.

- [ ] **Step 4: Verify GREEN**

Run both commands from Step 2.

- [ ] **Step 5: Commit**

```bash
git add sidecar/agmux-memory-store.mjs sidecar/agmux-search.mjs sidecar/agmux-memory-store.test.mjs sidecar/agmux-search.test.mjs src-tauri/src/memory/mod.rs
git commit -m "feat(memory): balance context and improve retrieval"
```

### Task 6: Make Codex handoff identity request-scoped

**Files:**
- Modify: `src-tauri/src/memory/mod.rs`
- Modify: `src-tauri/src/commands/codex.rs`
- Modify: related inline Rust tests

- [ ] **Step 1: Write a failing multiplexed-session test**

Construct two overlapping Codex thread instructions and assert each contains its own explicit `session_upsert id`, while the shared MCP environment does not enable `AGMUX_ALLOW_ACTIVE_THREAD_FALLBACK`.

- [ ] **Step 2: Verify RED**

Run: `cargo test -p xanom memory::tests`

Run: `cargo test -p xanom commands::codex`

- [ ] **Step 3: Remove the shared fallback and inject explicit identity**

Keep process-scoped fallback for PTY/single-thread surfaces only. Add the current agmux thread id to each Codex turn's memory instruction and make the MCP tool error instructively when a multiplexed caller omits it.

- [ ] **Step 4: Verify GREEN**

Run: `cargo test -p xanom memory::tests`

Run: `cargo test -p xanom commands::codex`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/memory/mod.rs src-tauri/src/commands/codex.rs
git commit -m "fix(memory): scope Codex handoffs to each thread"
```

### Task 7: Add Tauri snapshot, health, binding, and warning APIs

**Files:**
- Modify: `src-tauri/src/commands/memory.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/commands.ts`
- Modify: Rust command tests or memory tests

- [ ] **Step 1: Write failing API tests**

Cover `memory_snapshot`, `memory_health`, confirm/revoke binding, `expectedRevision` rejection, actor derivation as user, and `MemoryMutationResult` warning propagation.

- [ ] **Step 2: Verify RED**

Run: `cargo test -p xanom commands::memory`

Run: `cargo test -p xanom memory::tests`

- [ ] **Step 3: Implement commands and typed wrappers**

Register the four new commands, remove caller-controlled source/duplicate inputs from Tauri mutations, return `{ entry, revision, projectionWarning }`, and provide TypeScript wrappers that preserve simple entry-returning calls while exposing detailed results to the Memory screen.

- [ ] **Step 4: Verify Rust and TypeScript**

Run: `cargo test -p xanom commands::memory`

Run: `cargo test -p xanom memory::tests`

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/memory.rs src-tauri/src/lib.rs src/lib/commands.ts
git commit -m "feat(memory): expose health and binding controls"
```

### Task 8: Add Memory-screen health and guided curation

**Files:**
- Modify: `src/components/thread/__tests__/MemoryMainPanel.test.tsx`
- Modify: `src/components/thread/MemoryMainPanel.tsx`
- Modify: existing nearby CSS file only if required by current component conventions

- [ ] **Step 1: Write failing UI tests**

Mock snapshot/health responses and assert the health summary, Needs Review filter, binding confirmation, stale-revision reload, projection warning, and view-specific search placeholder/copy.

- [ ] **Step 2: Verify RED**

Run: `npm run test -- MemoryMainPanel`

- [ ] **Step 3: Implement the minimal UI**

Load snapshots and health per project, keep existing cards/actions, show compact counts/warnings, add Needs Review, require confirmation before binding, pass the loaded revision to mutations, refresh on stale errors, and change placeholder/empty-state copy with the selected view.

- [ ] **Step 4: Verify GREEN and typecheck**

Run: `npm run test -- MemoryMainPanel`

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/components/thread/MemoryMainPanel.tsx src/components/thread/__tests__/MemoryMainPanel.test.tsx
git commit -m "feat(memory): add health and review curation"
```

### Task 9: Make projections local-only and document the shipped behavior

**Files:**
- Modify: `.gitignore`
- Remove from Git tracking, preserve locally: `.agmux/MEMORY.md`, `.agmux/SESSIONS.md`
- Modify: `RELEASE_NOTES.md`
- Modify: `AGENTS.md` or `.claude/rules/architecture.md`

- [ ] **Step 1: Add projection ignore rules**

Add explicit `.agmux/MEMORY.md` and `.agmux/SESSIONS.md` entries with a comment explaining that the app-owned JSON is authoritative and the Markdown is regenerated locally.

- [ ] **Step 2: Remove only the projections from Git tracking**

Run: `git rm --cached .agmux/MEMORY.md .agmux/SESSIONS.md`

Expected: files remain on disk and appear ignored; any current local `SESSIONS.md` content is preserved.

- [ ] **Step 3: Update durable docs and release notes**

Document revision/authority/binding semantics, local projections, crash-lock recovery, explicit Codex identity, and the new health/curation surface. Add plain-language entries under `## Unreleased`.

- [ ] **Step 4: Verify projection regeneration**

Use temporary store/projection paths in tests or the CLI; do not overwrite the user's live store. Confirm both ignored files can be regenerated locally.

- [ ] **Step 5: Commit**

```bash
git add .gitignore RELEASE_NOTES.md AGENTS.md .claude/rules/architecture.md
git commit -m "docs(memory): keep generated projections local"
```

### Task 10: Rebuild and complete verification

**Files:**
- Generated: `sidecar/dist/agmux-memory-mcp.bundle.mjs`
- Generated: `sidecar/dist/agmux-memory-cli.bundle.mjs`

- [ ] **Step 1: Rebuild required sidecar bundles**

Run: `cd sidecar && node build.mjs`

- [ ] **Step 2: Run all sidecar tests**

Run: `cd sidecar && npm test`

- [ ] **Step 3: Run frontend tests**

Run: `npm run test`

- [ ] **Step 4: Run Rust tests**

Run: `cargo test -p xanom`

- [ ] **Step 5: Run mandatory typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Inspect final diff and projection privacy**

Run: `git status --short`

Run: `git diff --check`

Confirm unrelated pre-existing changes remain untouched, generated projections are ignored/local, no secret value appears in tests/errors/docs, and every changed production behavior has a red/green regression test.

- [ ] **Step 7: Record handoff and durable decisions**

Call `session_upsert` with the implementation/test summary. Add project memory only for lasting decisions not already captured by the committed spec and project rules.
