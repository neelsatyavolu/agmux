# @ File Mention Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `@` file mention popup to ClaudeInputBar that lets users browse and insert file paths from the project directory.

**Architecture:** New Rust command `list_directory_entries` in `commands/files.rs` returns directory entries for a given path. New `FileMentionPopup` React component mirrors `SlashCommandPopup` styling. `ClaudeInputBar` detects `@` in input, fetches entries, and renders the popup with keyboard navigation.

**Tech Stack:** Rust (tokio::fs), React 19, Framer Motion, lucide-react, Tauri invoke

---

### Task 1: Add `list_directory_entries` Rust Command

**Files:**
- Modify: `src-tauri/src/commands/files.rs`
- Modify: `src-tauri/src/lib.rs` (invoke_handler registration)

- [ ] **Step 1: Add the DirectoryEntry struct and command to files.rs**

Append to the end of `src-tauri/src/commands/files.rs`:

```rust
#[derive(Debug, Serialize, Clone)]
pub struct DirectoryEntry {
    pub name: String,
    pub is_dir: bool,
}

/// List immediate children of `base_path/relative_path` for the @ file mention popup.
/// Returns directories first, then files, both sorted case-insensitive alphabetically.
/// Hidden files (starting with `.`) are excluded unless `show_hidden` is true.
/// Returns an empty vec on any error (invalid path, permission denied, etc.).
#[tauri::command]
pub async fn list_directory_entries(
    base_path: String,
    relative_path: String,
    show_hidden: bool,
) -> Result<Vec<DirectoryEntry>, String> {
    let base = std::path::Path::new(&base_path)
        .canonicalize()
        .map_err(|e| format!("Invalid base path: {e}"))?;
    let target = base.join(&relative_path);

    // Canonicalize target and ensure it's within base_path (prevent traversal)
    let canonical_target = match target.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(Vec::new()),
    };
    if !canonical_target.starts_with(&base) {
        return Ok(Vec::new());
    }

    let mut read_dir = match tokio::fs::read_dir(&canonical_target).await {
        Ok(rd) => rd,
        Err(_) => return Ok(Vec::new()),
    };

    let mut entries = Vec::new();
    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();

        // Filter hidden files unless show_hidden is true
        if !show_hidden && name.starts_with('.') {
            continue;
        }

        let is_dir = entry
            .file_type()
            .await
            .map(|ft| ft.is_dir())
            .unwrap_or(false);

        entries.push(DirectoryEntry { name, is_dir });
    }

    // Sort: directories first, then files, both case-insensitive alphabetical
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}
```

- [ ] **Step 2: Register the command in lib.rs**

In `src-tauri/src/lib.rs`, add inside the `invoke_handler![]` macro, after the line `commands::files::get_claude_read_whitelist,`:

```rust
            commands::files::list_directory_entries,
```

- [ ] **Step 3: Verify Rust compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && cargo check --manifest-path src-tauri/Cargo.toml`
Expected: Compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/files.rs src-tauri/src/lib.rs
git commit -m "feat: add list_directory_entries command for @ file mention popup"
```

---

### Task 2: Add Frontend Command Wrapper

**Files:**
- Modify: `src/lib/commands.ts`

- [ ] **Step 1: Add the DirectoryEntry type and invoke wrapper**

In `src/lib/commands.ts`, add after the existing `// ── Files` section (after the `writeFile` function around line 519):

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

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/commands.ts
git commit -m "feat: add listDirectoryEntries frontend command wrapper"
```

---

### Task 3: Create FileMentionPopup Component

**Files:**
- Create: `src/components/thread/FileMentionPopup.tsx`

- [ ] **Step 1: Create the FileMentionPopup component**

Create `src/components/thread/FileMentionPopup.tsx`:

```tsx
import { useEffect, useRef } from "react";
import { Folder, FileText, AtSign } from "lucide-react";
import { motion } from "framer-motion";
import type { DirectoryEntry } from "../../lib/commands";

interface Props {
  entries: DirectoryEntry[];
  activeIndex: number;
  currentPath: string;
  onSelect: (entry: DirectoryEntry) => void;
}

export function FileMentionPopup({ entries, activeIndex, currentPath, onSelect }: Props) {
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.95 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      className="absolute bottom-full left-0 right-0 z-40 mb-1 mx-4 rounded-xl border border-white/10 bg-[#0c0c0c] shadow-2xl overflow-hidden backdrop-blur-md"
      role="listbox"
      aria-label="File mentions"
    >
      <div className="flex items-center gap-1.5 border-b border-white/5 bg-white/[0.02] px-3 py-2">
        <AtSign size={11} className="text-zinc-400" />
        <span className="text-xs text-zinc-400 font-medium">
          {currentPath ? `Files in ${currentPath}` : "Project files"}
        </span>
        <span className="ml-auto text-xs text-zinc-500">Esc to close</span>
      </div>
      <div className="max-h-52 overflow-y-auto py-1">
        {entries.length === 0 ? (
          <div className="px-3 py-3 text-xs text-zinc-500 text-center">No matches</div>
        ) : (
          entries.map((entry, index) => {
            const isActive = index === activeIndex;
            return (
              <button
                key={entry.name}
                ref={isActive ? activeRef : undefined}
                role="option"
                aria-selected={isActive}
                onClick={() => onSelect(entry)}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                  isActive ? "bg-indigo-500/10" : "hover:bg-white/5"
                }`}
              >
                {entry.isDir ? (
                  <Folder
                    size={13}
                    className={`shrink-0 ${isActive ? "text-indigo-400" : "text-blue-400"}`}
                  />
                ) : (
                  <FileText
                    size={13}
                    className={`shrink-0 ${isActive ? "text-indigo-400" : "text-zinc-400"}`}
                  />
                )}
                <span
                  className={`font-mono text-xs ${
                    isActive
                      ? "text-indigo-300"
                      : entry.isDir
                        ? "text-blue-300"
                        : "text-zinc-300"
                  }`}
                >
                  {entry.name}{entry.isDir ? "/" : ""}
                </span>
              </button>
            );
          })
        )}
      </div>
    </motion.div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/thread/FileMentionPopup.tsx
git commit -m "feat: add FileMentionPopup component for @ file mentions"
```

---

### Task 4: Integrate @ Detection and Popup into ClaudeInputBar

**Files:**
- Modify: `src/components/thread/ClaudeInputBar.tsx`

This is the main integration task. It adds state, detection logic, fetching, keyboard navigation, and renders the popup.

- [ ] **Step 1: Add imports**

In `ClaudeInputBar.tsx`, add to the existing import from `../../lib/commands`:

```typescript
import {
  // ... existing imports ...
  listDirectoryEntries,
} from "../../lib/commands";
import type { DirectoryEntry } from "../../lib/commands";
```

Add the `FileMentionPopup` import after the `SlashCommandPopup` import:

```typescript
import { FileMentionPopup } from "./FileMentionPopup";
```

- [ ] **Step 2: Add @ mention helper function**

Add this helper function above the `ClaudeInputBar` component (after the `truncate` function, around line 98):

```typescript
/** Parse the @ mention query from text at a given cursor position.
 *  Returns null if no active @ mention, otherwise { atPos, dirPart, filterPart, showHidden }. */
function parseAtMention(text: string, cursorPos: number): {
  atPos: number;
  dirPart: string;
  filterPart: string;
  showHidden: boolean;
} | null {
  // Search backwards from cursor for the last @
  const beforeCursor = text.slice(0, cursorPos);
  const atPos = beforeCursor.lastIndexOf("@");
  if (atPos < 0) return null;

  // @ must be at start or preceded by whitespace
  if (atPos > 0 && !/\s/.test(text[atPos - 1])) return null;

  // Extract the mention query (text between @ and cursor)
  const query = text.slice(atPos + 1, cursorPos);

  // If query contains whitespace, mention is no longer active
  if (/\s/.test(query)) return null;

  // Split into directory part and filter part
  const lastSlash = query.lastIndexOf("/");
  const dirPart = lastSlash >= 0 ? query.slice(0, lastSlash + 1) : "";
  const filterPart = lastSlash >= 0 ? query.slice(lastSlash + 1) : query;
  const showHidden = filterPart.startsWith(".");

  return { atPos, dirPart, filterPart, showHidden };
}
```

- [ ] **Step 3: Add state variables**

Inside the `ClaudeInputBar` component, after the slash command state (after line ~146 `const [dynamicCommands, setDynamicCommands] = useState...`), add:

```typescript
  // @ file mention state
  const [fileMentionEntries, setFileMentionEntries] = useState<DirectoryEntry[]>([]);
  const [fileMentionActiveIndex, setFileMentionActiveIndex] = useState(0);
  const [fileMentionDirPart, setFileMentionDirPart] = useState("");
  const fetchSeqRef = useRef(0);
```

- [ ] **Step 4: Add computed mention state and fetch effect**

After the `useEffect` that resets `slashActiveIndex` (around line 176), add:

```typescript
  // Parse @ mention from current input and cursor position
  const cursorPos = textareaRef.current?.selectionStart ?? value.length;
  const atMention = !showSlashPopup ? parseAtMention(value, cursorPos) : null;
  const showFileMention = atMention !== null;

  // Fetch directory entries when the directory part changes
  useEffect(() => {
    if (!atMention) {
      setFileMentionEntries([]);
      return;
    }

    const seq = ++fetchSeqRef.current;
    listDirectoryEntries(workDir, atMention.dirPart, atMention.showHidden)
      .then((entries) => {
        // Only apply if this is still the latest fetch
        if (fetchSeqRef.current === seq) {
          setFileMentionEntries(entries);
          setFileMentionActiveIndex(0);
        }
      })
      .catch(() => {
        if (fetchSeqRef.current === seq) {
          setFileMentionEntries([]);
        }
      });
  }, [atMention?.dirPart, atMention?.showHidden, workDir]);

  // Filter entries client-side by the filter part
  const filteredFileMentionEntries = atMention
    ? fileMentionEntries.filter((e) =>
        e.name.toLowerCase().startsWith(atMention.filterPart.toLowerCase())
      )
    : [];

  // Reset active index when filtered results change
  useEffect(() => {
    setFileMentionActiveIndex(0);
  }, [filteredFileMentionEntries.length]);
```

- [ ] **Step 5: Add file mention selection handler**

After the `handleSlashSelect` callback (around line 186), add:

```typescript
  const handleFileMentionSelect = useCallback(
    (entry: DirectoryEntry) => {
      if (!atMention) return;
      const beforeAt = value.slice(0, atMention.atPos + 1); // includes the @
      const afterCursor = value.slice(textareaRef.current?.selectionStart ?? value.length);

      if (entry.isDir) {
        // Drill into directory: replace query with dir path
        const newPath = atMention.dirPart + entry.name + "/";
        const newValue = beforeAt + newPath + afterCursor;
        setValue(newValue);
        // Set cursor position after the new path
        requestAnimationFrame(() => {
          const pos = atMention.atPos + 1 + newPath.length;
          textareaRef.current?.setSelectionRange(pos, pos);
          textareaRef.current?.focus();
        });
      } else {
        // Insert file path and close popup
        const fullPath = atMention.dirPart + entry.name;
        const newValue = beforeAt + fullPath + " " + afterCursor;
        setValue(newValue);
        requestAnimationFrame(() => {
          const pos = atMention.atPos + 1 + fullPath.length + 1;
          textareaRef.current?.setSelectionRange(pos, pos);
          textareaRef.current?.focus();
        });
      }
    },
    [value, atMention]
  );
```

- [ ] **Step 6: Add keyboard navigation for file mention popup**

In the `handleKeyDown` function, add this block **after** the slash command popup navigation block (after line ~480 `}`) and **before** the `if (e.key === "Escape" && isWorking)` block:

```typescript
    // @ file mention popup navigation
    if (showFileMention && filteredFileMentionEntries.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFileMentionActiveIndex((prev) =>
          prev < filteredFileMentionEntries.length - 1 ? prev + 1 : 0
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFileMentionActiveIndex((prev) =>
          prev > 0 ? prev - 1 : filteredFileMentionEntries.length - 1
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        handleFileMentionSelect(filteredFileMentionEntries[fileMentionActiveIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Remove the @ and query to dismiss
        if (atMention) {
          const beforeAt = value.slice(0, atMention.atPos);
          const afterCursor = value.slice(textareaRef.current?.selectionStart ?? value.length);
          setValue(beforeAt + afterCursor);
        }
        return;
      }
    }
```

- [ ] **Step 7: Update handleChange to trigger cursor-position re-evaluation**

Replace the existing `handleChange` function (around line 493) with:

```typescript
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  };
```

(This is unchanged — the `atMention` computed value already re-evaluates on every render when `value` changes. No change needed here, but verify it stays as-is.)

- [ ] **Step 8: Render the FileMentionPopup**

In the JSX, after the slash command popup `AnimatePresence` block (around line 594, after `</AnimatePresence>`), add:

```tsx
        {/* @ file mention popup */}
        <AnimatePresence>
          {showFileMention && filteredFileMentionEntries.length > 0 && (
            <FileMentionPopup
              entries={filteredFileMentionEntries}
              activeIndex={fileMentionActiveIndex}
              currentPath={atMention?.dirPart ?? ""}
              onSelect={handleFileMentionSelect}
            />
          )}
        </AnimatePresence>
```

- [ ] **Step 9: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 10: Commit**

```bash
git add src/components/thread/ClaudeInputBar.tsx
git commit -m "feat: integrate @ file mention autocomplete into ClaudeInputBar"
```

---

### Task 5: Manual Testing & Polish

**Files:**
- Possibly modify: `src/components/thread/ClaudeInputBar.tsx` (minor fixes)

- [ ] **Step 1: Launch the app in dev mode**

Run: `npx tauri dev`

- [ ] **Step 2: Test basic @ flow**

1. Open a Claude Code session for any project
2. Type `@` in the input bar → verify popup shows project root entries
3. Type `@src` → verify it filters to entries matching "src"
4. Press Enter on `src/` → verify input becomes `@src/` and popup shows `src/` contents
5. Type `@src/components/` → verify it shows components directory contents
6. Select a file → verify full path inserted and popup closes

- [ ] **Step 3: Test edge cases**

1. Type `Can you look at @src/` → verify popup works with text before the `@`
2. Type `/model` → verify slash popup shows (not file popup)
3. Press Escape when file popup is open → verify it dismisses
4. Type `@.` → verify hidden files are shown
5. Type `@nonexistent/` → verify empty state "No matches" shows

- [ ] **Step 4: Test keyboard navigation**

1. Arrow Up/Down through entries → verify active highlight moves
2. Tab to select → verify it works same as Enter
3. Type text after selecting a file → verify cursor is in right position

- [ ] **Step 5: Commit any fixes**

```bash
git add -u
git commit -m "fix: polish @ file mention autocomplete edge cases"
```

---

### Task 6: Final Verification

- [ ] **Step 1: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 2: Verify Rust builds**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: No errors.

- [ ] **Step 3: Run full dev build**

Run: `npx tauri dev`
Expected: App launches and @ mention feature works end-to-end.
