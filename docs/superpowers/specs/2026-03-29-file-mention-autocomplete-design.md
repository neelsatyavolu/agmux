# @ File Mention Autocomplete

**Date:** 2026-03-29
**Status:** Approved

## Overview

Add an `@` file mention autocomplete popup to ClaudeInputBar. When the user types `@` in the chat input, a popup appears showing files and directories from the project root. Typing filters results; selecting a directory drills into it; selecting a file inserts the relative path inline.

## Backend

### New Tauri Command: `list_directory_entries`

**Module:** `src-tauri/src/commands/files.rs` (new file)

**Signature:**
```rust
#[tauri::command]
pub async fn list_directory_entries(
    base_path: String,
    relative_path: String,
    show_hidden: bool,
) -> Result<Vec<DirectoryEntry>, String>
```

**DirectoryEntry struct:**
```rust
#[derive(Debug, Serialize, Clone)]
pub struct DirectoryEntry {
    pub name: String,
    pub is_dir: bool,
}
```

**Behavior:**
- Joins `base_path` + `relative_path` to get the target directory
- Lists immediate children (one level only)
- Filters hidden files (names starting with `.`) unless `show_hidden` is true
- Sorts: directories first, then files, both case-insensitive alphabetical
- Returns empty vec on invalid/inaccessible paths (no error propagation to UI)
- Canonicalizes paths to prevent directory traversal outside `base_path`

**Registration:** Add to `invoke_handler![]` in `lib.rs`.

### Frontend Command Wrapper

**File:** `src/lib/commands.ts`

```typescript
export interface DirectoryEntry {
  name: string;
  isDir: boolean;
}

export async function listDirectoryEntries(
  basePath: string,
  relativePath: string,
  showHidden: boolean,
): Promise<DirectoryEntry[]> {
  return invoke<DirectoryEntry[]>("list_directory_entries", {
    basePath,
    relativePath,
    showHidden,
  });
}
```

## Frontend

### New Component: `FileMentionPopup.tsx`

**Location:** `src/components/thread/FileMentionPopup.tsx`

**Props:**
```typescript
interface FileMentionPopupProps {
  entries: DirectoryEntry[];
  activeIndex: number;
  onSelect: (entry: DirectoryEntry) => void;
  onActiveIndexChange: (index: number) => void;
}
```

**Visual design:**
- Mirrors `SlashCommandPopup` styling: absolute positioned above input, `bottom-full left-0 right-0 z-40 mb-1 mx-4`
- `rounded-xl border border-white/10 bg-[#0c0c0c] shadow-2xl backdrop-blur-md`
- Framer Motion entry animation (fade + scale, 150ms)
- Max height `max-h-52 overflow-y-auto`
- Each entry row: icon + name
  - Directories: `Folder` icon (lucide-react), blue-400 text, name shown with trailing `/`
  - Files: `FileText` icon (lucide-react), zinc-300 text
- Active item: `bg-white/10` highlight, scrolls into view via ref
- Empty state: "No matches" in muted text

### ClaudeInputBar.tsx Changes

**New state:**
```typescript
const [showFileMention, setShowFileMention] = useState(false);
const [fileMentionEntries, setFileMentionEntries] = useState<DirectoryEntry[]>([]);
const [fileMentionActiveIndex, setFileMentionActiveIndex] = useState(0);
```

**@ Detection logic in `handleChange`:**
1. Find the last `@` in the input value
2. If no `@` found, or there's a space before the cursor after the `@` position — hide popup
3. Extract the "mention query" = text between `@` and cursor position
4. Parse into `directoryPart` and `filterPart`:
   - `@src/comp` → directoryPart=`src/`, filterPart=`comp`
   - `@sr` → directoryPart=`""`, filterPart=`sr`
   - `@src/` → directoryPart=`src/`, filterPart=`""`
5. Determine `showHidden` from whether filterPart starts with `.`
6. Fetch entries for directoryPart (debounced, ~150ms) from `listDirectoryEntries`
7. Filter fetched entries client-side by filterPart (case-insensitive prefix match)
8. Reset activeIndex to 0 when filtered results change

**Keyboard handling in `handleKeyDown` (when `showFileMention` is true):**
- ArrowUp/ArrowDown: navigate entries, prevent default
- Enter/Tab: select active entry, prevent default
- Escape: close popup, prevent default
- All other keys: passthrough to normal input

**Selection behavior (`onSelect`):**
- If entry `isDir`: replace mention query with `dirname/`, keep popup open, fetch new directory
- If entry is a file: replace mention query with full relative path, close popup
- Replacement target: text from `@` position through current filterPart

**Popup priority:**
- Slash command popup takes precedence (if input starts with `/`)
- File mention popup shows only when slash popup is not active

### Interaction Flow

```
User types: "Can you look at @"
→ Popup shows root directory entries

User types: "Can you look at @sr"
→ Popup filters to entries matching "sr" (e.g., "src/")

User presses Enter on "src/"
→ Input becomes "Can you look at @src/"
→ Popup shows contents of src/

User types: "Can you look at @src/comp"
→ Popup filters to "components/"

User presses Enter on "components/"
→ Input becomes "Can you look at @src/components/"
→ Popup shows contents of src/components/

User presses Enter on "ClaudeInputBar.tsx"
→ Input becomes "Can you look at @src/components/thread/ClaudeInputBar.tsx"
→ Popup closes

User continues typing normally.
```

## Files Changed

| File | Change |
|------|--------|
| `src-tauri/src/commands/files.rs` | New — `list_directory_entries` command |
| `src-tauri/src/commands/mod.rs` | Add `pub mod files;` |
| `src-tauri/src/lib.rs` | Register command in `invoke_handler![]` |
| `src/lib/commands.ts` | Add `DirectoryEntry` type + `listDirectoryEntries` wrapper |
| `src/components/thread/FileMentionPopup.tsx` | New — popup component |
| `src/components/thread/ClaudeInputBar.tsx` | Add @ detection, state, keyboard handling, render popup |

## Edge Cases

- **Empty project directory**: Show "No files found" empty state
- **Permission errors / invalid paths**: Return empty array, no error UI
- **Very long file lists**: Capped by max-h-52 scroll container; no pagination needed
- **Multiple @ in message**: Use the last `@` before cursor position
- **@ in middle of word**: Only trigger if `@` is preceded by whitespace or is at position 0
- **Concurrent fetches**: Latest fetch wins; discard stale results via request sequencing
