# IDE Mode Design Spec

**Date:** 2026-04-05
**Status:** Approved
**Scope:** Add a global IDE mode to Xanom — Cursor/Windsurf-style layout with file tree, code editor, integrated terminal, and SDK chat sidebar.

---

## 1. Overview

Xanom gains a second top-level layout mode: **IDE mode**. When active, the entire app swaps from the current agent-centric layout (sidebar + split panes) to a fixed four-zone IDE layout: file tree (left), code editor (center), integrated terminal (bottom, toggleable), and SDK chat panel (right).

**Goals:**
- Provide a familiar IDE experience with AI chat as a first-class sidebar
- Auto-open files in the editor when the AI edits them
- Keep agent mode untouched — clean separation, no regressions

**Non-goals (v1):**
- Inline diff/gutter annotations in the editor (diffs stay in chat tool blocks)
- PTY mode in the chat sidebar (SDK only)
- Multi-project workspaces (one project at a time)

---

## 2. Global Mode Toggle

### State

- `uiStore.appMode: "agent" | "ide"` — persisted via zustand `persist` middleware
- Default: `"agent"` (no behavior change for existing users)

### Activation

- **UI:** Prominent toggle in the sidebar header / titlebar area
- **Keyboard:** `Cmd+Shift+.` toggles between modes
- IDE mode requires a selected project (from `projectStore`). If none selected, show a project picker prompt before entering IDE mode.

### Switching Behavior

- **Agent -> IDE:** If the current project has an active SDK thread, the chat panel picks it up. Otherwise, shows `DraftChatView`.
- **IDE -> Agent:** IDE terminal sessions stay alive in background. Chat session remains linked to the thread. User can resume by switching back.
- Layout state (panel widths, terminal visibility) is preserved across switches.

---

## 3. Layout Architecture

### Component: `IdeLayout`

New top-level component that replaces both `Sidebar` and `MainPanel` when `appMode === "ide"`.

```
+------------+---------------------------+--------------+
|            |                           |              |
|  FileTree  |      Code Editor          |  Chat Panel  |
|   (left)   |       (center)            |   (right)    |
|            |                           |              |
|            +---------------------------+              |
|            |   Terminal (bottom)       |              |
|            |   (toggleable)            |              |
+------------+---------------------------+--------------+
```

### Zone Details

| Zone | Default Size | Resizable | Collapsible | Min Size |
|------|-------------|-----------|-------------|----------|
| File tree (left) | 240px | Yes, drag handle | Yes, Cmd+B | 180px |
| Code editor (center) | Flex remaining | N/A (fills) | No | 300px |
| Chat panel (right) | 380px | Yes, drag handle | Yes, Cmd+Shift+B | 280px |
| Terminal (bottom) | 30% of center | Yes, drag handle | Yes, Cmd+` | 100px |

All drag handles use the same `ResizeHandle` pattern already in `EditorPanel`.

### New Files

- `src/components/layout/IdeLayout.tsx` — top-level IDE shell, manages four zones with resize handles
- `src/components/layout/IdeChatPanel.tsx` — chat sidebar wrapper (session lifecycle, header, history dropdown)
- `src/components/layout/IdeTerminalPanel.tsx` — bottom terminal with tab bar
- `src/components/layout/IdeToolbar.tsx` — toolbar between editor and terminal (toggle buttons, breadcrumb)
- `src/stores/ideStore.ts` — IDE-specific persisted state

---

## 4. Chat Panel (SDK-Only Sidebar)

### Behavior

- One persistent SDK chat session per project
- Provider selector at top: Claude or Codex (both via SDK mode)
- Reuses `ClaudeSdkSessionView` rendering pipeline (structured messages, tool use blocks, inline diffs, markdown)
- Reuses `ClaudeInputBar` adapted to narrower width (slash commands, `@` file mentions, model/effort dropdowns)
- File mentions auto-resolve relative to the project's `work_dir`

### Session Lifecycle

- Starting a new chat creates a new thread with `interaction_mode: "sdk"` linked to the current project
- Chat history accessible via a "Chat History" dropdown in the panel header — lists recent SDK threads for this project
- `ApprovalBanner` renders inline in the chat panel

### Component: `IdeChatPanel`

```typescript
interface IdeChatPanelProps {
  projectId: string;
  workDir: string;
  width: number;
  onWidthChange: (width: number) => void;
}
```

Wraps:
- Panel header (project name, provider selector, chat history dropdown, new chat button)
- `ClaudeSdkSessionView` or `DraftChatView` depending on whether an active thread exists
- `ClaudeInputBar` at the bottom

---

## 5. File Integration — Auto-Open on AI Edits

### Detection

A listener in `IdeLayout` watches SDK events for file-mutating tool completions:

- `tool.completed` where `toolName` in `["Edit", "Write", "ApplyPatch", "NotebookEdit"]`
- Extract `file_path` from the tool input payload
- Call `editorStore.openTab(filePath)` to open or focus the file

### Read Tool

- `Read` tool completions also open the file in the editor, but in read-only focus (no dirty indicator, no "AI edited" badge)

### Visual Feedback

- Newly opened/edited files get a 1.5s blue glow pulse on their editor tab (Framer Motion)
- "AI edited" badge on the tab that fades after 5 seconds
- If multiple files edited in one turn: all open as tabs, last edited becomes active tab

### Content Refresh

- Editor reads file content from disk via Tauri's `read_file` command (not an in-memory buffer)
- When a file is already open and gets edited by AI, trigger a content refresh from disk
- Dirty state handling: if the user has unsaved changes in the editor and AI edits the same file, show a conflict dialog with three options:
  - **"Reload"** — discard user changes, load AI's version from disk
  - **"Keep mine"** — keep user's in-memory version, ignore AI edit (tab stays dirty)
  - **"Diff"** — open a side-by-side diff of user's version vs disk (future enhancement, disabled in v1)

---

## 6. Enhanced File Tree

### Git Status Indicators

- New Tauri command: `get_git_status(workDir: string) -> Record<string, string>`
  - Runs `git status --porcelain` on the project's `work_dir`
  - Returns map of `{ relativePath: statusCode }`
- File entries show colored status: `M` (modified, amber), `A` (added, green), `D` (deleted, red), `U` (untracked, gray)
- Directories show aggregated dot if any child has changes
- Refreshed on: 3-second poll interval + file watcher events (existing `watcher` infrastructure)

### File Search (Quick Open)

- `Cmd+P` opens a fuzzy search overlay (when in IDE mode)
- Uses `list_directory_entries` Tauri command recursively, filtered client-side with fuzzy scoring
- Results show: file icon + relative path
- Enter opens in editor, Escape dismisses

### Context Menu

Right-click on file/folder:
- Open in Editor
- Reveal in Finder (`shell:open` Tauri plugin)
- Copy Path / Copy Relative Path
- Delete (with `@tauri-apps/plugin-dialog` confirmation)
- Rename (inline rename input)
- **"Ask Claude about this file"** — inserts `@`-mention into chat input and focuses it

---

## 7. Integrated Terminal

### Lifecycle

- Spawns a PTY session via existing `spawn_pty` command, scoped to `work_dir`
- Independent from the chat panel — chat uses SDK (no PTY), terminal is the user's shell
- Terminal stays alive when collapsed (hidden, not destroyed)

### UI

- Toggle: `Cmd+`` ` or button in toolbar
- Tab bar at top with `+` button to spawn additional terminals (max 4)
- Each tab: independent PTY session at `work_dir`
- Tab labels show running process name (e.g., `zsh`, `npm run dev`)

### Rendering

- Reuses `TerminalView` component (ghostty-web WASM)
- Same renderer as current PTY threads

### Independence

- AI `Bash` tool output renders inline in chat panel only — not piped to the bottom terminal
- Terminal and chat are fully independent

---

## 8. State Management

### New Store: `ideStore`

```typescript
interface IdeState {
  // Panel dimensions (persisted)
  fileTreeWidth: number;        // default: 240
  chatPanelWidth: number;       // default: 380
  terminalHeight: number;       // default: 0.3 (ratio)
  
  // Terminal state
  terminalVisible: boolean;     // default: false
  terminalSessions: Record<string, string[]>;  // projectId -> PTY session IDs
  terminalActiveTab: Record<string, number>;    // projectId -> active tab index
  
  // Chat state
  activeIdeChatThreadId: Record<string, string | null>;  // projectId -> thread ID
  
  // Actions
  setFileTreeWidth: (width: number) => void;
  setChatPanelWidth: (width: number) => void;
  setTerminalHeight: (height: number) => void;
  toggleTerminal: () => void;
  addTerminalSession: (projectId: string, sessionId: string) => void;
  removeTerminalSession: (projectId: string, sessionId: string) => void;
  setTerminalActiveTab: (projectId: string, index: number) => void;
  setActiveIdeChatThread: (projectId: string, threadId: string | null) => void;
}
```

Persisted via zustand `persist` middleware (localStorage).

### Shared Stores (no duplication)

- `editorStore` — same open tabs, file contents, dirty state
- `threadStore` — SDK threads created in IDE mode are normal threads
- `projectStore` — current project drives all IDE scoping
- `settingsStore` — shared settings
- `uiStore` — gains `appMode` field

---

## 9. New Tauri Commands

| Command | Module | Signature | Purpose |
|---------|--------|-----------|---------|
| `get_git_status` | `commands/git.rs` (new) | `(work_dir: String) -> Result<HashMap<String, String>, String>` | Git status for file tree |

All other functionality uses existing commands (`spawn_pty`, `read_file`, `list_directory_entries`, SDK commands).

---

## 10. Keyboard Shortcuts (IDE Mode)

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+.` | Toggle Agent/IDE mode |
| `Cmd+B` | Toggle file tree |
| `Cmd+Shift+B` | Toggle chat panel |
| `Cmd+`` ` | Toggle terminal |
| `Cmd+P` | Quick open (file search) |
| `Cmd+W` | Close active editor tab |
| `Cmd+\` | Focus chat input |

---

## 11. Component Tree

```
App
├── (appMode === "agent") → Sidebar + MainPanel (unchanged)
└── (appMode === "ide") → IdeLayout
    ├── FileTree (enhanced: git status, search, context menu)
    ├── Center
    │   ├── EditorTabs + CodeEditor
    │   └── IdeTerminalPanel (toggleable)
    │       ├── Terminal tab bar
    │       └── TerminalView (ghostty-web) × N
    └── IdeChatPanel
        ├── Panel header (provider, history, new chat)
        ├── ClaudeSdkSessionView | DraftChatView
        └── ClaudeInputBar
```

---

## 12. Files Changed / Created

### New Files
- `src/components/layout/IdeLayout.tsx` — IDE shell with four resizable zones
- `src/components/layout/IdeChatPanel.tsx` — chat sidebar wrapper
- `src/components/layout/IdeTerminalPanel.tsx` — bottom terminal with tabs
- `src/components/layout/IdeToolbar.tsx` — toolbar with toggle buttons
- `src/components/layout/QuickOpenDialog.tsx` — `Cmd+P` fuzzy file search
- `src/stores/ideStore.ts` — IDE-specific persisted state
- `src-tauri/src/commands/git.rs` — `get_git_status` command

### Modified Files
- `src/stores/uiStore.ts` — add `appMode` field
- `src/components/layout/App.tsx` (or equivalent root) — conditional render `IdeLayout` vs current layout
- `src/components/editor/FileTree.tsx` — git status indicators, context menu, "Ask Claude" action
- `src/components/editor/FileIcon.tsx` — git status color overlays
- `src-tauri/src/commands/mod.rs` — register `git` command module
- `src-tauri/src/lib.rs` — register `get_git_status` in `invoke_handler!`
