# Thread Creation UX Redesign

**Date:** 2026-03-30
**Status:** Draft

## Problem

The `+` button dropdown menu grows linearly with each new provider. Currently 6 options (Claude, Codex, Ollama, Forge agents + worktrees + terminal), and it will only get worse. Too many clicks to create a thread for the common case.

## Design

### Two Entry Points

#### 1. Pencil Icon (✏️) — Instant Default

Single click creates a thread using the **default pairing** from settings (e.g. "Claude Terminal"). No dialog, no menu. The thread is created and selected immediately.

The default pairing is configured in Settings and consists of:
- A provider (ClaudeCode, Codex, Ollama, ForgeCode)
- A mode (Terminal or Chat)

#### 2. Plus Icon (+) — Dropdown Menu

Flat list of 6 options:

| Option | Behavior |
|--------|----------|
| **New Chat** | No thread created yet. Shows empty thread view with input bar containing a provider/model dropdown. Thread is lazily created on first prompt submission. |
| **New Claude Terminal** | Instant creation. PTY with parsed chat view (current behavior). |
| **New Codex Terminal** | Instant creation. Terminal with chat view toggle (current behavior). |
| **New Forge Terminal** | Instant creation. PTY terminal. |
| **New Worktree** | Opens dialog for provider, branch, and model selection (current NewThreadDialog, scoped to worktree creation). |
| **New Terminal** | Plain terminal, no agent. |

### New Chat Flow

The "New Chat" option is the primary new feature. It works as follows:

#### Empty Thread State

When the user clicks "New Chat":
1. No thread is created in the database
2. The main panel shows an empty thread view — the existing empty state but with the input bar at the bottom
3. The input bar includes a **provider/model dropdown** (inspired by T3 Code's design)

#### Provider/Model Dropdown

Located in the input bar (bottom-left area, similar to T3's placement):

```
┌─────────────────────────┐
│ Codex              ▸    │  → sub-menu: model list
│ Claude (selected)  ▸    │  → no sub-menu (CLI-controlled)
│ Ollama             ▸    │  → sub-menu: model list
│ Forge              ▸    │  → no sub-menu (CLI-controlled)
└─────────────────────────┘
```

**Sub-options rules:**
- **Codex:** Shows available Codex models (from `CODEX_MODELS` in types.ts)
- **Ollama:** Shows installed Ollama models (fetched via `ollamaListModels` command)
- **Claude:** No sub-options. Model is controlled by the CLI. Just selects the provider.
- **Forge:** No sub-options. Model is controlled by the CLI. Just selects the provider.

**Default selection:** Uses the last-used provider or `settings.defaultProvider`.

#### Thread Creation (Lazy)

The thread is created only when the user submits their first prompt:

1. User types a message and hits Enter/Send
2. Frontend calls `threadStore.addThread()` with the selected provider and model
3. Thread is created in the database
4. The appropriate session view loads (chat view for the selected provider)
5. The first message is sent to the newly created thread

**Claude + Agent SDK:** If `settings.sdkEnabled` is true and the user selects Claude as the provider, the thread is created with `interaction_mode: "sdk"` (Agent SDK chat mode). Otherwise, it uses `interaction_mode: "pty"` (PTY chat mode).

#### Provider Dropdown Display

The selected provider/model is shown as a compact label in the input bar:
- `Claude` (no model shown — CLI-controlled)
- `Codex · o4-mini` (provider + model)
- `Ollama · qwen2.5-coder:7b` (provider + model)
- `Forge` (no model shown — CLI-controlled)

Clicking the label opens the dropdown. The dropdown uses nested sub-menus (hover to expand) for providers with model selection.

### Settings Changes

#### Default Pairing

The existing `defaultProvider` setting is extended to also store a default mode:

```typescript
// settingsStore
defaultProvider: Provider;       // existing
defaultMode: "terminal" | "chat"; // new — what the pencil icon creates
```

The pencil icon uses both to determine what to create:
- `defaultProvider: "ClaudeCode"` + `defaultMode: "terminal"` → New Claude Terminal
- `defaultProvider: "ClaudeCode"` + `defaultMode: "chat"` → New Chat with Claude pre-selected
- `defaultProvider: "Codex"` + `defaultMode: "terminal"` → New Codex Terminal
- etc.

### UI State Management

#### New State: "Draft Chat"

A new UI state represents the "New Chat" pre-creation view:

```typescript
// uiStore or threadStore
draftChat: {
  active: boolean;
  provider: Provider;
  model: string | null;  // null for CLI-controlled providers
} | null;
```

When `draftChat` is active:
- The main panel shows the empty thread view with the input bar
- The input bar shows the provider/model dropdown
- No thread exists in the sidebar yet
- Selecting a different thread or project clears the draft

When the user sends the first prompt:
- `draftChat` is consumed to create the thread
- `draftChat` is set to `null`
- Normal thread view takes over

### Components Affected

| Component | Changes |
|-----------|---------|
| `ProjectGroup.tsx` | Replace dropdown menu options. Pencil icon behavior. Add "New Chat" option that sets `draftChat` state. |
| `NewThreadDialog.tsx` | Scope down to worktree-only creation. Remove provider selection buttons (moved to input bar dropdown). |
| `ClaudeInputBar.tsx` | Add provider/model dropdown when in draft chat mode. Handle lazy thread creation on submit. |
| `settingsStore.ts` | Add `defaultMode` setting. |
| `uiStore.ts` or `threadStore.ts` | Add `draftChat` state. |
| `App.tsx` or main panel router | Render empty thread view when `draftChat` is active. |

### What Gets Removed

- The per-provider "New X agent" menu items (replaced by "New Chat")
- Provider selection buttons inside `NewThreadDialog` (dialog is now worktree-only)
- The `newThreadInitialProvider` state in `ProjectGroup.tsx`

### What Stays the Same

- Terminal thread creation (Claude/Codex/Forge/plain) — instant, no dialog
- Worktree dialog — still opens for branch/model selection
- All existing thread views and session management
- Settings dialog structure (just adds `defaultMode`)
- Thread store's `addThread()` interface

## Out of Scope

- Model selection for Claude/Forge (controlled by their CLI configs)
- Keyboard shortcuts for thread creation (can be added later)
- Command palette integration (separate feature)
- Drag-and-drop provider reordering in the dropdown
