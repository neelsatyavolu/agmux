# Memory System Hardening Design

## Goal

Make agmux project memory trustworthy, concise, secure, and maintainable across the Rust UI, Node MCP/CLI sidecars, agent prompt injection, and session handoffs.

## Scope

The work is staged into three independently releasable parts:

1. Core correctness and trust boundaries.
2. Retrieval and context quality.
3. Human-visible health and curation.

The existing JSON stores remain authoritative. The migration must preserve every existing memory and handoff. No memory is automatically deleted, archived, merged, demoted, or rewritten.

## Storage and projections

Project memory remains in `~/.xanom/projects/{project_id}/memory.json`; handoffs remain in the corresponding app-owned project data. The JSON stores gain a monotonic `revision` field used to detect intervening writes. Legacy version-1 stores without a revision load as revision zero and receive a revision on their next successful mutation. The store format stays version 1 because every new field has a safe default.

`.agmux/MEMORY.md` and `.agmux/SESSIONS.md` remain generated local projections for agents and humans, but become gitignored and are removed from Git tracking without deleting the local files. Deliberately shared repository guidance belongs in `AGENTS.md` or another explicitly curated document.

Every mutation uses the same conceptual pipeline in Rust and Node:

1. Perform shape validation and reject high-confidence secrets without echoing the candidate value.
2. Acquire the shared filesystem lock, safely reclaiming an abandoned lock only after its lease expired and its process is confirmed dead.
3. Re-read and structurally validate the current store while holding the lock.
4. Authorize the requested semantic changes using source precedence and validate the affected lifecycle graph.
5. Apply the mutation and increment the store revision only when persisted state changed.
6. Atomically commit JSON.
7. Refresh projections and surface any projection failures as warnings.

All writers re-read under the lock, so MCP/CLI mutations do not require a caller-supplied revision. The Memory UI reads a snapshot containing the store revision and submits that value as `expectedRevision` for edits and lifecycle actions; any intervening project-memory mutation fails conservatively with a stale-store error and the UI reloads before retry. Store revision is returned by snapshot/health reads and mutation envelopes and is also used by search cursors. Handoff and memory cursors encode their respective revisions. No-op operations do not change timestamps or revision.

## Trust model

Stored memory is reference data, not executable instruction text. Prompt injection wraps it in a clearly delimited section and states that memory content cannot override system, user, or repository policy. Snapshots use one JSON object per line between fixed start/end sentinels; title and content are JSON encoded, so stored newlines or delimiter text cannot escape the data boundary. Markdown projections use JSON-encoded titles and content strings for the same structural guarantee.

Caller source is derived from the trusted surface and is never accepted from MCP/CLI arguments: Tauri UI actions are `user`, automatic app maintenance is `system`, and MCP/CLI actions are `agent`. Precedence is `user > system > agent`. Changing title, content, kind, importance, or lifecycle requires caller precedence greater than or equal to the entry's controlling `authority`. Superseding another entry also requires sufficient precedence over every target's authority. A lower-precedence writer receives an explicit error rather than a false success or partial update. No-op updates leave timestamps and revision unchanged.

Authorship remains in the immutable `source` field. A separate mutable `authority` field records the highest-precedence actor that has curated the entry and is the value checked for later mutations. Legacy entries derive `authority` from `source`. A successful higher-precedence semantic or lifecycle change raises authority to that actor; authority never decreases. Thus a user edit of agent-authored content preserves its original authorship while protecting the curated result from later agent writes.

Importance means “worthy of attention” and remains separately editable under the precedence rules. Binding authority is represented by `binding: boolean`, `bindingConfirmedAt`, and `bindingConfirmedBy` (`user`, `system`, or `agent`). Agents decide binding (via MCP/CLI `binding` on add/update or confirm/revoke) after verifying the constraint is accurate and safe; user/system may still set or revoke with sufficient authority. Binding and important must stay sparse — not a user review queue. On legacy load, missing binding metadata is derived without rewriting: an important user/system entry is treated as confirmed; an important agent entry is attention-only until explicitly bound. The derived fields persist on the next successful mutation. Setting binding does not change authorship, raises authority to the setting actor when higher, and revocation clears confirmation metadata but does not clear importance or lower authority.

High-confidence secret detection covers private-key blocks, recognized provider token formats, and assignments of secret-like names to long credential-like values. Rejections are generic and never echo the matched text. A health scan reports existing candidate counts without returning their values; it does not rewrite old data.

## Locks and concurrency

Memory and handoff locks use one protocol shared by Rust and Node. A writer fully initializes a uniquely named owner directory, then atomically publishes the canonical lock as a relative symlink. Legacy directory locks remain readable. Lock metadata includes a token, PID, and acquisition time. Safe symlinks are restricted to one role-prefixed sibling directory whose token matches its owner metadata; dangling, chained, malformed, or foreign symlinks are ambiguous and fail closed. A waiting writer may quarantine an existing lock only when:

- its lease is expired;
- its owner metadata is valid enough to identify the lock; and
- the recorded PID is confirmed absent.

Quarantine uses an atomic rename. The quarantined token and owner target are rechecked before deletion, preventing a writer from deleting a replacement lock or unrelated target. Active or ambiguous locks are never reclaimed. A crash before publication leaves only a non-blocking owner directory that can be cleaned after its lease expires; it cannot leave an empty canonical lock that wedges future saves.

Multiplexed Codex app-server sessions must not use a shared last-active-thread file as the default handoff identity. The current agmux thread id is placed in the per-turn instructions, and `session_upsert` requires that explicit id on multiplexed sessions. PTY and single-thread providers may continue using their process-scoped `AGMUX_THREAD_ID`.

## Lifecycle integrity

Normalized active titles are unique across add, update, restore, and reopen. There is no public duplicate bypass. A rejected mutation leaves the store untouched.

Supersession is a directed acyclic graph. Repeated supersession adds lineage rather than replacing prior targets. Resolved issues can be reopened only when doing so preserves active-title uniqueness.

Legacy compatibility separates structural validation from integrity analysis. Malformed shapes, duplicate IDs, unsupported versions, and missing references still fail closed. Pre-existing title collisions, graph cycles, or status/lineage inconsistencies remain readable and appear in `memory_health`; they do not make the whole store uneditable. A mutation may repair an existing issue but may not introduce or worsen one in the affected titles or graph component. New mutations always enforce current invariants.

## Agent context and projection

Important entries are rendered once, not once in an Important section and again by kind. Context selection uses priority lanes:

1. Binding constraints (agent- or user-set).
2. Open issues and pins.
3. Recent decisions.
4. Recent facts and notes.

Each non-empty lane receives space before another lane consumes the remaining character budget. Important-without-binding is attention ranking only, not a constraint. Snapshot headers report total, included, omitted, binding, and attention counts and direct agents to `memory_list` or `search` for more.

The full local projection remains capped, reports how many active entries are omitted by the cap, and never duplicates an entry.

## Search

Search remains dependency-free and rebuilds its small in-memory index per call. Short queries require every meaningful token; longer queries require a majority of tokens. Exact phrase, title, and term-proximity matches receive the strongest boosts. Trusted importance and recency provide small bounded tie-break boosts.

Pagination cursors include the memory and handoff store revisions. Any intervening mutation invalidates the cursor even when multiple writes occur within one timestamp second. Archived, resolved, and superseded memories remain excluded by default.

## MCP and CLI

The misplaced `allow_duplicate` property is removed from `memory_list`; no duplicate bypass is exposed on `memory_add` or the CLI. Kind, scope, and excerpt-origin inputs use explicit enums and unsupported kinds are rejected at mutation boundaries rather than silently becoming notes.

MCP advertises its resources capability, names the project-memory resource accurately, and rejects unknown resource URIs. Projection warnings are returned consistently for every MCP and CLI mutation, including `session_upsert`.

A read-only `memory_health` surface reports counts and actionable categories without exposing secret candidates. It is available to the UI and agents and must be added to Claude's allowed memory tools.

Rust memory mutations return a `MemoryMutationResult { entry, revision, projectionWarning }` envelope. The TypeScript command wrappers unwrap the entry for existing callers and expose the warning to the Memory screen through a dedicated result form, avoiding a repository-wide UI break. Node MCP/CLI mutations append the same warning to their normal success output. Session handoff upserts follow the same warning rule.

## Memory UI

The Memory screen adds a compact health summary for active entries, bindings, important (non-binding) attention items, projection-budget omissions, and integrity/privacy warnings. Binding is agent-decided (not a user confirm gate); the UI can revoke binding and filter binding/important entries.

Existing edit, archive, resolve, reopen, and supersede interactions remain. Health findings route users to those existing controls; the UI does not perform automatic cleanup. Search placeholder and empty-state copy describe the currently selected Durable, Sessions, or Archived view rather than implying a cross-view search.

## Failure behavior

- Invalid or unauthorized mutations fail atomically with a specific field/action error.
- Secret errors are deliberately generic.
- A committed JSON mutation with a failed projection returns success plus a prominent warning, allowing later repair without replaying the mutation.
- Corrupt stores still fail closed and receive a recovery copy.
- Ambiguous lock ownership times out instead of risking concurrent writes.
- Health calculation failures do not hide otherwise readable memory.

## Verification

Tests are written before implementation for each behavior. Coverage includes:

- dead-lock recovery and refusal to reclaim active/ambiguous locks in Node, Rust, and mixed-runtime operation;
- source-precedence rejection across all semantic and lifecycle fields;
- secret rejection without value disclosure;
- active-title and supersession graph invariants;
- single rendering of important entries and balanced snapshot coverage;
- monotonic revision cursor invalidation;
- multi-term search quality;
- MCP schemas, resources discovery, URI validation, and projection warnings;
- multiplexed Codex handoff identity;
- Memory UI health, binding/important filtering, revoke controls, and honest search copy;
- shared JSON golden fixtures loaded by both Rust and Node for legacy defaults, precedence, secret classification, title/DAG integrity, no-op revisions, and rendering parity;
- sidecar rebuild, sidecar tests, Rust tests, frontend tests, and mandatory TypeScript typecheck.

## Non-goals

- Cloud synchronization of personal project memory.
- Automatic LLM rewriting or summarization of durable memories.
- Destructive cleanup based on age heuristics.
- A new database or external search dependency.
- A committed replacement for deliberately curated team guidance.
