# Terminal Clickable File Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Cmd+click file path detection to `ClaudeTerminalView` so file paths in terminal output underline on hover and open in the built-in editor when Cmd+clicked.

**Architecture:** A pure `src/lib/terminalLinks.ts` module handles regex detection and path resolution. `ClaudeTerminalView` registers a ghostty-web `ILinkProvider` that calls into this module per row — ghostty handles all hover rendering, coordinate mapping, and Cmd+click detection natively. No DOM overlays or coordinate math.

**Tech Stack:** ghostty-web (`ILink`, `ILinkProvider`, `registerLinkProvider`, `IBufferLine.translateToString`), `@tauri-apps/api/path` (`homeDir`), Zustand (`uiStore.openFile`, `threadStore`, `projectStore`), TypeScript 5.8

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/terminalLinks.ts` | **Create** | Regex patterns, path stripping, path resolution, `ILink[]` factory |
| `src/components/thread/ClaudeTerminalView.tsx` | **Modify** | Import helpers, cache homeDir, look up project path, register provider |

---

### Task 1: Create `src/lib/terminalLinks.ts`

**Files:**
- Create: `src/lib/terminalLinks.ts`

Pure string-processing module — no terminal instance, no side effects at module load. Exports `FILE_PATH_REGEX`, `stripSurrounding`, `resolvePath`, and `makeFileLinks`.

- [ ] **Step 1: Create the file with regex and strip helper**

```typescript
import type { ILink } from "ghostty-web";
import { useUiStore } from "../stores/uiStore";

// ---------------------------------------------------------------------------
// Regex
// ---------------------------------------------------------------------------

const EXTENSIONS =
  "ts|tsx|js|jsx|rs|md|json|toml|css|html|py|go|yaml|yml|sql|sh|svg|lock|" +
  "cfg|txt|log|env|scss|less|vue|svelte|proto|graphql|zig|wasm";

// Path character class: word chars, dots, slashes, @, ~, +, -
const PC = "[\\w./@~+\\-]";

/**
 * Combined file path regex. Matches four forms (order = most specific first):
 *   1. Paths with a recognised extension:  src/foo.ts, ./bar.md
 *   2. Absolute paths with 2+ segments:    /usr/local/bin/thing
 *   3. Relative-prefixed:                  ./foo, ../bar/baz
 *   4. Home-relative:                      ~/Documents/foo.ts
 *
 * Uses a capturing group (index 1) so callers get just the path, not leading
 * whitespace or punctuation that may be part of the full match.
 */
export const FILE_PATH_REGEX = new RegExp(
  `(?:^|(?<=[^\\w/]))` +
  `(${PC}+\\.(?:${EXTENSIONS})` +
  `|/(?:${PC}+/)+${PC}*` +
  `|\\.{1,2}/${PC}+` +
  `|~/${PC}+)` +
  `(?=[^\\w]|$)`,
  "g"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip surrounding punctuation that terminals commonly wrap paths in:
 * parens (), brackets [], braces {}, quotes, trailing colons/commas/semicolons.
 */
export function stripSurrounding(raw: string): string {
  return raw
    .replace(/^[([{'"]+/, "")
    .replace(/[)\]}'",;:]+$/, "");
}
```

- [ ] **Step 2: Add path resolution helper**

Append to `src/lib/terminalLinks.ts`:

```typescript
// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a raw detected path to an absolute filesystem path.
 *
 * Rules (in priority order):
 *  - Starts with /      → already absolute, use as-is
 *  - Starts with ~/     → expand home dir
 *  - Starts with ./ or ../  → resolve relative to projectPath
 *  - Bare relative (src/foo.ts) → join with projectPath
 */
export function resolvePath(
  raw: string,
  projectPath: string,
  homeDir: string
): string {
  const path = stripSurrounding(raw);

  if (path.startsWith("/")) return path;

  if (path.startsWith("~/")) {
    return homeDir.replace(/\/$/, "") + "/" + path.slice(2);
  }

  const base = projectPath.replace(/\/$/, "");

  if (path.startsWith("./")) {
    return base + "/" + path.slice(2);
  }

  // Handles ../ and bare relative paths
  return _joinPath(base, path);
}

/** Join base + relative, resolving .. segments. */
function _joinPath(base: string, relative: string): string {
  const parts = (base + "/" + relative).split("/").filter(Boolean);
  const result: string[] = [];
  for (const part of parts) {
    if (part === "..") result.pop();
    else if (part !== ".") result.push(part);
  }
  return "/" + result.join("/");
}
```

- [ ] **Step 3: Add `makeFileLinks` — the ILink factory**

Append to `src/lib/terminalLinks.ts`:

```typescript
// ---------------------------------------------------------------------------
// ILink factory
// ---------------------------------------------------------------------------

/**
 * Scan one terminal row (`text`) for file paths and return ghostty-web ILink
 * objects. Called by the ILinkProvider registered in ClaudeTerminalView.
 *
 * @param text        Full text of the terminal row (from translateToString)
 * @param y           Absolute buffer row index (passed straight to ILink.range)
 * @param projectPath Absolute path of the project repo root
 * @param homeDir     User's home directory (e.g. /Users/neel)
 */
export function makeFileLinks(
  text: string,
  y: number,
  projectPath: string,
  homeDir: string
): ILink[] {
  FILE_PATH_REGEX.lastIndex = 0;
  const links: ILink[] = [];
  let match: RegExpExecArray | null;

  while ((match = FILE_PATH_REGEX.exec(text)) !== null) {
    const raw = match[1];
    // match[0] may include a leading non-word char; match[1] starts at the path
    const startX = match.index + (match[0].length - raw.length);
    const endX = startX + raw.length - 1;
    const resolved = resolvePath(raw, projectPath, homeDir);

    links.push({
      text: raw,
      range: {
        start: { x: startX, y },
        end: { x: endX, y },
      },
      activate(_event: MouseEvent) {
        useUiStore.getState().openFile(resolved);
      },
    });
  }

  return links;
}
```

- [ ] **Step 4: Run TypeScript check**

```bash
npx tsc --noEmit 2>&1 | grep terminalLinks
```

Expected: no output (no errors). Fix any type errors before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/terminalLinks.ts
git commit -m "feat: add terminalLinks module for file path detection and resolution"
```

---

### Task 2: Wire up link provider in `ClaudeTerminalView.tsx`

**Files:**
- Modify: `src/components/thread/ClaudeTerminalView.tsx`

Changes touch four areas:
1. **Imports** (top of file) — add ghostty-web types, `homeDir`, `makeFileLinks`, stores
2. **Module-level cache** — `getCachedHomeDir()` so homeDir is fetched once per app session
3. **`init()` — parallel fetch** — fetch homeDir alongside WASM (line ~684)
4. **`init()` — registration** — look up project path, create provider, register, push cleanup

- [ ] **Step 1: Add imports**

After the existing imports block (after line 15, before the `interface Props` block), add:

```typescript
import type { ILink, ILinkProvider } from "ghostty-web";
import { homeDir as tauriHomeDir } from "@tauri-apps/api/path";
import { makeFileLinks } from "../../lib/terminalLinks";
import { useThreadStore } from "../../stores/threadStore";
import { useProjectStore } from "../../stores/projectStore";
```

> **Note:** `useUiStore` is already imported in this file — do NOT add it again.

- [ ] **Step 2: Add module-level homeDir cache**

After the imports, before `const ALT_SCREEN_SEQUENCES` (before line 28), add:

```typescript
// Cache the home directory — a filesystem call that never changes at runtime.
let _cachedHomeDir: string | null = null;
async function getCachedHomeDir(): Promise<string> {
  if (_cachedHomeDir !== null) return _cachedHomeDir;
  _cachedHomeDir = await tauriHomeDir();
  return _cachedHomeDir;
}
```

- [ ] **Step 3: Fetch homeDir in parallel with WASM load**

In `init()`, find the existing line (line ~684):

```typescript
const { mod, ghostty } = await loadGhostty();
```

Replace with:

```typescript
const [{ mod, ghostty }, homeDirPath] = await Promise.all([
  loadGhostty(),
  getCachedHomeDir(),
]);
if (cancelled) return; // preserve the existing early-exit guard
```

- [ ] **Step 4: Look up project path after terminal creation**

After line ~744 (`fitAddonRef.current = fitAddon;`), add:

```typescript
// Look up the project's repo root for relative path resolution in links
const allThreads = Object.values(useThreadStore.getState().threads).flat();
const currentThread = allThreads.find((t) => t.id === threadId);
const projectId = currentThread?.projectId;
const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
const projectPath = project?.repo_path ?? "";
```

- [ ] **Step 5: Register the link provider**

Insert **between** the `resizeDisposable` cleanup push (line ~851) and the existing
`cleanups.push(() => { term.dispose(); ... })` block that immediately follows it.
Do NOT place this after `term.dispose()` — the provider must be registered while
the terminal is still alive. Add:

```typescript
// File path link provider: Cmd+hover underlines, Cmd+click opens in editor.
// ghostty-web handles coordinate mapping, hover rendering, and modifier detection.
const fileLinkProvider: ILinkProvider = {
  provideLinks(y: number, callback: (links: ILink[] | undefined) => void) {
    const line = term.buffer.active.getLine(y);
    if (!line) {
      callback(undefined);
      return;
    }
    const text = line.translateToString(true);
    const links = makeFileLinks(text, y, projectPath, homeDirPath);
    callback(links.length > 0 ? links : undefined);
  },
};
term.registerLinkProvider(fileLinkProvider);
cleanups.push(() => fileLinkProvider.dispose?.());
```

- [ ] **Step 6: Full TypeScript check**

```bash
npx tsc --noEmit
```

Expected: zero errors. Common issues to fix:
- `homeDirPath` used before assignment → ensure `Promise.all` destructuring in Step 3 is correct
- `IBufferLine` not exported → `term.buffer.active.getLine(y)` returns `IBufferLine | undefined`, which is typed — no cast needed
- `fileLinkProvider.dispose` is optional — the `?.()` handles it

- [ ] **Step 7: Manual verification**

```bash
npx tauri dev
```

Test checklist:
1. Open a Claude Code session in a project with source files
2. Run a command that outputs file paths (e.g. `ls src/` or let Claude write a file)
3. Hold **Cmd** and move the mouse over a file path in the terminal output
4. Confirm the path underlines and cursor changes to pointer
5. **Cmd+click** the path — the built-in editor should open that file
6. Test with: relative path (`src/foo.ts`), absolute path (`/Users/.../file.ts`), home-relative (`~/Documents/file.md`)
7. Confirm non-paths (plain words, numbers) do NOT trigger links

- [ ] **Step 8: Commit**

```bash
git add src/components/thread/ClaudeTerminalView.tsx
git commit -m "feat: register file path link provider in ClaudeTerminalView"
```
