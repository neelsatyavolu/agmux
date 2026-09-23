# Terminal Clickable File Paths — Design Spec

**Date**: 2026-03-24
**Scope**: `ClaudeTerminalView` only
**Trigger**: Cmd+hover to highlight, Cmd+click to open in built-in editor

## Overview

Add clickable file path detection to the Claude terminal view (ghostty-web). When the user holds Cmd and hovers over a file path in terminal output, the path underlines and becomes clickable. Cmd+clicking opens the file in the built-in editor via `uiStore.openFile()`.

Uses ghostty-web's native `registerLinkProvider` API — no custom overlay or coordinate math needed.

## ghostty-web Link Provider API

ghostty-web provides a built-in link detection system:

```typescript
interface ILinkProvider {
  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void;
  dispose?(): void;
}

interface ILink {
  text: string;
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  activate(event: MouseEvent): void;
  hover?(isHovered: boolean): void;
  dispose?(): void;
}
```

- `provideLinks(y)` is called per row with the absolute buffer row index
- ghostty-web handles all mouse-to-cell coordinate mapping, Cmd+click detection, hover underline rendering, and scroll tracking natively
- Multiple providers can be registered; they don't conflict

## File Path Detection

### Regex Patterns

Match terminal row text against these patterns:

1. **Paths with file extensions**: `[\w./@~+-]+\.(ts|tsx|js|jsx|rs|md|json|toml|css|html|py|go|yaml|yml|sql|sh|svg|lock|cfg|txt|log|env|scss|less|vue|svelte|proto|graphql|zig|wasm)`
2. **Absolute paths** (2+ segments): `/[\w./@~+-]+/[\w./@~+-]+`
3. **Relative prefixed**: `\.\.?/[\w./@~+-]+`
4. **Home-relative**: `~/[\w./@~+-]+`

Character class `[\w./@~+-]` covers standard paths including scoped npm packages (`@tauri-apps/...`) and C++ files.

### Post-processing

- Strip surrounding punctuation: parens `()`, brackets `[]`, quotes `"'`, trailing colons/commas
- Optionally capture trailing `:line:col` (e.g., `foo.ts:42:10`) for future line-jump support
- Deduplicate overlapping matches (prefer longest match)

## Path Resolution

Resolve detected paths to absolute paths for the editor:

| Path format | Resolution |
|-------------|------------|
| `/absolute/path` | Use as-is |
| `~/relative` | Expand `~` via `@tauri-apps/api/path` `homeDir()` (cached once) |
| `./relative` or `../relative` | Resolve against project `repo_path` |
| `bare/relative.ts` | Resolve against project `repo_path` |

Project `repo_path` is sourced from `projectStore` using the current thread's project ID.

No file existence validation — skip async checks to keep the provider synchronous. If the file doesn't exist, `openFile` handles the error naturally when CodeMirror loads.

## Editor Integration

- Call `uiStore.openFile(absolutePath)` — this existing action opens the file tab and shows the editor panel in one call
- Future enhancement: if `:line` was captured, scroll CodeMirror to that line

## Implementation

### Registration

Inside `ClaudeTerminalView.tsx`'s terminal lifecycle `useEffect` (where `onData`, `onResize` are registered), register the link provider after terminal creation:

```typescript
import { filePathLinkProvider } from '../../lib/terminalLinks';

// Inside useEffect, after term is created:
const linkProvider = filePathLinkProvider(projectPath, homeDir);
term.registerLinkProvider(linkProvider);
```

### Link Provider Module: `src/lib/terminalLinks.ts`

New module (~60 lines) exporting `filePathLinkProvider(projectPath, homeDir)`:

```typescript
export function filePathLinkProvider(
  projectPath: string,
  homeDir: string
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y);
      if (!line) { callback(undefined); return; }
      const text = line.translateToString(true);
      const links = detectFilePaths(text, y, projectPath, homeDir);
      callback(links.length > 0 ? links : undefined);
    }
  };
}
```

Each `ILink.activate()` calls `uiStore.openFile(resolvedPath)`.

### Cleanup

Provider disposal follows existing pattern in ClaudeTerminalView (line ~837):

```typescript
// No explicit dispose needed — ghostty-web cleans up providers on terminal.dispose()
// But if manual cleanup is desired:
cleanups.push(() => linkProvider.dispose?.());
```

## Performance

- `provideLinks` is called by ghostty-web on demand (hover/scroll), not on every mousemove
- Regex runs only for visible rows as needed — ghostty handles caching
- No async operations in the provider (path resolution is pure string manipulation)
- Home directory cached once on mount, not fetched per call

## File Changes

| File | Change |
|------|--------|
| `src/lib/terminalLinks.ts` | New module — regex detection, path resolution, link provider factory |
| `src/components/thread/ClaudeTerminalView.tsx` | Register link provider in terminal lifecycle useEffect |

## Out of Scope

- Other terminal views (StandaloneTerminalView, AgentTerminalView, TerminalPanel)
- URL hyperlink detection (http/https links)
- Line-number jump on open (future enhancement)
- File existence validation on hover
