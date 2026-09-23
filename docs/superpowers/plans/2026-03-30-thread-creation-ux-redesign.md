# Thread Creation UX Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign thread creation to use a pencil icon for instant default creation and a simplified + menu with a "New Chat" option featuring lazy thread creation with a provider/model dropdown in the input bar.

**Architecture:** Add `draftChat` state to `uiStore` to represent the pre-creation "New Chat" view. The `MainPanel` renders a `DraftChatView` when `draftChat` is active — showing an input bar with a provider/model dropdown. On first prompt submission, the thread is lazily created and the normal session view takes over. The + menu is simplified to 6 flat options; the pencil icon uses `defaultProvider` + new `defaultMode` setting.

**Tech Stack:** React 19, TypeScript, Zustand 5, Tailwind CSS v4, Framer Motion

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/stores/settingsStore.ts` | Add `defaultMode` setting |
| Modify | `src/stores/uiStore.ts` | Add `draftChat` state + actions |
| Create | `src/components/thread/DraftChatView.tsx` | Empty thread view with provider dropdown + input bar |
| Create | `src/components/thread/ProviderModelDropdown.tsx` | Reusable provider/model selector dropdown |
| Modify | `src/components/layout/MainPanel.tsx` | Route `draftChat` to `DraftChatView` |
| Modify | `src/components/sidebar/ProjectGroup.tsx` | Replace + menu items, update pencil icon behavior |
| Modify | `src/components/sidebar/NewThreadDialog.tsx` | Scope down to worktree-only |
| Modify | `src/components/sidebar/SettingsDialog.tsx` | Add `defaultMode` setting UI |

---

### Task 1: Add `defaultMode` to Settings Store

**Files:**
- Modify: `src/stores/settingsStore.ts`

- [ ] **Step 1: Add `defaultMode` to `AppSettings` interface**

In `src/stores/settingsStore.ts`, add the new field to the `AppSettings` interface after the `defaultProvider` field:

```typescript
/** Default creation mode for the pencil icon: terminal spawns a PTY session, chat opens draft chat. */
defaultMode: "terminal" | "chat";
```

- [ ] **Step 2: Add default value**

In the `DEFAULT_SETTINGS` object, add after `defaultProvider: "Codex"`:

```typescript
defaultMode: "terminal" as const,
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add src/stores/settingsStore.ts
git commit -m "feat: add defaultMode setting for pencil icon behavior"
```

---

### Task 2: Add `draftChat` State to UI Store

**Files:**
- Modify: `src/stores/uiStore.ts`

- [ ] **Step 1: Add DraftChat type and state**

At the top of `src/stores/uiStore.ts`, add the type (near other type definitions):

```typescript
export interface DraftChat {
  projectId: string;
  repoPath: string;
  provider: Provider;
  model: string | null;
}
```

Add to the store's state interface:

```typescript
draftChat: DraftChat | null;
setDraftChat: (draft: DraftChat | null) => void;
```

- [ ] **Step 2: Implement in store creation**

Add initial state:

```typescript
draftChat: null,
```

Add the setter — it should clear all other selections when activating a draft:

```typescript
setDraftChat: (draft) => {
  if (draft) {
    set({
      draftChat: draft,
      selectedThreadId: null,
      selectedClaudeSessionId: null,
      selectedClaudeSessionCwd: null,
      selectedClaudeSessionIsNew: false,
      selectedCodexSessionId: null,
      selectedCodexSessionCwd: null,
      selectedTerminalSessionId: null,
      selectedTerminalSessionCwd: null,
    });
  } else {
    set({ draftChat: null });
  }
},
```

- [ ] **Step 3: Clear draftChat when selecting other sessions**

In `selectThread`, `selectClaudeSession`, `selectCodexSession`, and `selectTerminalSession`, add `draftChat: null` to each `set()` call so that selecting any real session clears the draft.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 5: Commit**

```bash
git add src/stores/uiStore.ts
git commit -m "feat: add draftChat state to uiStore for lazy thread creation"
```

---

### Task 3: Create ProviderModelDropdown Component

**Files:**
- Create: `src/components/thread/ProviderModelDropdown.tsx`

- [ ] **Step 1: Create the dropdown component**

Create `src/components/thread/ProviderModelDropdown.tsx`:

```tsx
import { useState, useEffect, useRef } from "react";
import { ChevronDown, ChevronRight, Check } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { ollamaListModels } from "../../lib/commands";
import { CODEX_MODELS } from "../../lib/types";
import type { Provider, OllamaModel } from "../../lib/types";
import claudeIcon from "../../assets/claude-ai-icon.svg";
import chatgptIcon from "../../assets/chatgpt-icon.svg";

interface Props {
  provider: Provider;
  model: string | null;
  onSelect: (provider: Provider, model: string | null) => void;
}

const PROVIDERS: { id: Provider; label: string; hasModels: boolean }[] = [
  { id: "ClaudeCode", label: "Claude", hasModels: false },
  { id: "Codex", label: "Codex", hasModels: true },
  { id: "Ollama", label: "Ollama", hasModels: true },
  { id: "ForgeCode", label: "Forge", hasModels: false },
];

function ProviderIcon({ provider, size = 16 }: { provider: Provider; size?: number }) {
  if (provider === "Ollama") {
    return (
      <div
        className="shrink-0 flex items-center justify-center rounded-sm bg-purple-500/20"
        style={{ width: size, height: size }}
      >
        <span className="text-[9px] font-bold text-purple-400">O</span>
      </div>
    );
  }
  if (provider === "ForgeCode") {
    return (
      <div
        className="shrink-0 flex items-center justify-center rounded-sm bg-orange-500/20"
        style={{ width: size, height: size }}
      >
        <span className="text-[9px] font-bold text-orange-400">F</span>
      </div>
    );
  }
  return (
    <img
      src={provider === "ClaudeCode" ? claudeIcon : chatgptIcon}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-sm"
    />
  );
}

function displayLabel(provider: Provider, model: string | null): string {
  const providerLabel = PROVIDERS.find((p) => p.id === provider)?.label ?? provider;
  if (!model) return providerLabel;
  return `${providerLabel} · ${model}`;
}

export function ProviderModelDropdown({ provider, model, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [hoveredProvider, setHoveredProvider] = useState<Provider | null>(null);
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [loadingOllama, setLoadingOllama] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Fetch Ollama models when hovering over Ollama
  useEffect(() => {
    if (hoveredProvider !== "Ollama" || ollamaModels.length > 0) return;
    setLoadingOllama(true);
    ollamaListModels()
      .then(setOllamaModels)
      .catch(() => setOllamaModels([]))
      .finally(() => setLoadingOllama(false));
  }, [hoveredProvider, ollamaModels.length]);

  const handleProviderClick = (p: Provider) => {
    if (!PROVIDERS.find((pr) => pr.id === p)?.hasModels) {
      onSelect(p, null);
      setOpen(false);
    }
  };

  const handleModelClick = (p: Provider, m: string) => {
    onSelect(p, m);
    setOpen(false);
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.04] px-2.5 py-1 text-xs text-zinc-300 hover:bg-white/[0.08] hover:text-white transition-colors"
      >
        <ProviderIcon provider={provider} size={14} />
        <span className="max-w-[180px] truncate">{displayLabel(provider, model)}</span>
        <ChevronDown size={12} className={`text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.12 }}
            className="absolute bottom-full left-0 mb-2 z-50 min-w-[200px] rounded-xl border border-white/10 bg-zinc-900/95 backdrop-blur-xl py-1.5 shadow-2xl"
          >
            {PROVIDERS.map((p) => (
              <div
                key={p.id}
                className="relative"
                onMouseEnter={() => setHoveredProvider(p.id)}
                onMouseLeave={() => setHoveredProvider(null)}
              >
                <button
                  onClick={() => handleProviderClick(p.id)}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors ${
                    provider === p.id && !p.hasModels
                      ? "text-white bg-white/[0.06]"
                      : "text-zinc-300 hover:bg-white/[0.05] hover:text-white"
                  }`}
                >
                  <ProviderIcon provider={p.id} size={16} />
                  <span className="flex-1">{p.label}</span>
                  {provider === p.id && !p.hasModels && <Check size={14} className="text-blue-400" />}
                  {p.hasModels && <ChevronRight size={14} className="text-zinc-500" />}
                </button>

                {/* Sub-menu for providers with models */}
                {p.hasModels && hoveredProvider === p.id && (
                  <motion.div
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.1 }}
                    className="absolute left-full top-0 ml-1 z-50 min-w-[180px] rounded-xl border border-white/10 bg-zinc-900/95 backdrop-blur-xl py-1.5 shadow-2xl"
                  >
                    {p.id === "Codex" &&
                      CODEX_MODELS.map((m) => (
                        <button
                          key={m.slug}
                          onClick={() => handleModelClick("Codex", m.slug)}
                          className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors ${
                            provider === "Codex" && model === m.slug
                              ? "text-white bg-white/[0.06]"
                              : "text-zinc-300 hover:bg-white/[0.05] hover:text-white"
                          }`}
                        >
                          <span className="flex-1">{m.name}</span>
                          {provider === "Codex" && model === m.slug && (
                            <Check size={14} className="text-green-400" />
                          )}
                        </button>
                      ))}
                    {p.id === "Ollama" && loadingOllama && (
                      <div className="px-3 py-2 text-xs text-zinc-500">Loading models...</div>
                    )}
                    {p.id === "Ollama" &&
                      !loadingOllama &&
                      ollamaModels.map((m) => (
                        <button
                          key={m.name}
                          onClick={() => handleModelClick("Ollama", m.name)}
                          className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors ${
                            provider === "Ollama" && model === m.name
                              ? "text-white bg-white/[0.06]"
                              : "text-zinc-300 hover:bg-white/[0.05] hover:text-white"
                          }`}
                        >
                          <span className="flex-1">{m.name}</span>
                          {provider === "Ollama" && model === m.name && (
                            <Check size={14} className="text-purple-400" />
                          )}
                        </button>
                      ))}
                    {p.id === "Ollama" && !loadingOllama && ollamaModels.length === 0 && (
                      <div className="px-3 py-2 text-xs text-zinc-500">No models found</div>
                    )}
                  </motion.div>
                )}
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/components/thread/ProviderModelDropdown.tsx
git commit -m "feat: create ProviderModelDropdown component for draft chat"
```

---

### Task 4: Create DraftChatView Component

**Files:**
- Create: `src/components/thread/DraftChatView.tsx`

- [ ] **Step 1: Create the draft chat view**

Create `src/components/thread/DraftChatView.tsx`:

```tsx
import { useState, useCallback } from "react";
import { MessageSquarePlus } from "lucide-react";
import { useUiStore } from "../../stores/uiStore";
import { useThreadStore } from "../../stores/threadStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { ProviderModelDropdown } from "./ProviderModelDropdown";
import type { Provider } from "../../lib/types";
import type { DraftChat } from "../../stores/uiStore";

interface Props {
  draft: DraftChat;
}

export function DraftChatView({ draft }: Props) {
  const [provider, setProvider] = useState<Provider>(draft.provider);
  const [model, setModel] = useState<string | null>(draft.model);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const addThread = useThreadStore((s) => s.addThread);
  const selectThread = useUiStore((s) => s.selectThread);
  const selectClaudeSession = useUiStore((s) => s.selectClaudeSession);
  const selectCodexSession = useUiStore((s) => s.selectCodexSession);
  const setDraftChat = useUiStore((s) => s.setDraftChat);
  const sdkEnabled = useSettingsStore((s) => s.settings.sdkEnabled);

  const handleProviderSelect = useCallback((p: Provider, m: string | null) => {
    setProvider(p);
    setModel(m);
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    try {
      // Determine interaction mode for Claude
      const interactionMode = provider === "ClaudeCode" && sdkEnabled ? "sdk" : "pty";

      // Create the thread
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const name = `Thread ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

      const thread = await addThread({
        projectId: draft.projectId,
        name,
        provider,
        model: model ?? undefined,
        interactionMode: provider === "ClaudeCode" ? interactionMode : undefined,
      });

      // Clear draft and select the new thread
      setDraftChat(null);
      selectThread(thread.id);

      // Queue the first message to be sent after the session initializes.
      // The thread view components handle initial message sending via their
      // own mechanisms (PTY write, SDK send, Codex send, Ollama send).
      // We store the message so the target view can pick it up.
      useUiStore.getState().setPendingFirstMessage(thread.id, trimmed);
    } catch (err) {
      console.error("Failed to create thread from draft:", err);
    } finally {
      setLoading(false);
    }
  }, [input, loading, provider, model, sdkEnabled, draft.projectId, addThread, selectThread, selectClaudeSession, selectCodexSession, setDraftChat]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Empty state center content */}
      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-zinc-500">
          <MessageSquarePlus size={40} strokeWidth={1.2} className="text-zinc-600" />
          <p className="text-sm">Start a new conversation</p>
        </div>
      </div>

      {/* Input bar */}
      <div className="border-t border-white/[0.06] bg-zinc-950/50 px-4 py-3">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-end gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] p-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your message..."
              rows={1}
              className="max-h-32 min-h-[36px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none"
              style={{ height: "auto", overflow: "hidden" }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
              }}
              disabled={loading}
              autoFocus
            />
            <button
              onClick={handleSubmit}
              disabled={!input.trim() || loading}
              className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm shadow-blue-600/20 transition-colors hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? "Creating..." : "Send"}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <ProviderModelDropdown
              provider={provider}
              model={model}
              onSelect={handleProviderSelect}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit`
Expected: No new errors (may need to add `setPendingFirstMessage` to uiStore — see Task 5)

- [ ] **Step 3: Commit**

```bash
git add src/components/thread/DraftChatView.tsx
git commit -m "feat: create DraftChatView component for lazy thread creation"
```

---

### Task 5: Add `pendingFirstMessage` to UI Store

**Files:**
- Modify: `src/stores/uiStore.ts`

The draft chat view needs a way to pass the first message to the session view that will be created after the thread is made. This is a simple key-value store of `threadId → message`.

- [ ] **Step 1: Add state and actions to uiStore**

Add to the store's state interface:

```typescript
pendingFirstMessages: Record<string, string>;
setPendingFirstMessage: (threadId: string, message: string) => void;
consumePendingFirstMessage: (threadId: string) => string | null;
```

Add initial state:

```typescript
pendingFirstMessages: {},
```

Add the actions:

```typescript
setPendingFirstMessage: (threadId, message) =>
  set((s) => ({
    pendingFirstMessages: { ...s.pendingFirstMessages, [threadId]: message },
  })),

consumePendingFirstMessage: (threadId) => {
  const msg = get().pendingFirstMessages[threadId] ?? null;
  if (msg !== null) {
    set((s) => {
      const { [threadId]: _, ...rest } = s.pendingFirstMessages;
      return { pendingFirstMessages: rest };
    });
  }
  return msg;
},
```

Note: This requires changing `create<UiState>((set) =>` to `create<UiState>((set, get) =>` if `get` is not already destructured.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/stores/uiStore.ts
git commit -m "feat: add pendingFirstMessage store for draft chat handoff"
```

---

### Task 6: Route DraftChatView in MainPanel

**Files:**
- Modify: `src/components/layout/MainPanel.tsx`

- [ ] **Step 1: Import DraftChatView and read draftChat state**

Add import at the top of `MainPanel.tsx`:

```typescript
import { DraftChatView } from "../thread/DraftChatView";
```

In `SingleViewPanel`, add the draftChat selector:

```typescript
const draftChat = useUiStore((s) => s.draftChat);
```

- [ ] **Step 2: Render DraftChatView when draftChat is active**

In the `activeView` useMemo, add a check at the very top (before the Claude session check):

```typescript
// Draft chat takes priority — it's a pre-creation state
if (draftChat) {
  return {
    key: "draft-chat",
    type: "draft" as const,
  };
}
```

Update the `CachedSingleView` type to include draft:

```typescript
| { key: string; type: "draft" }
```

Add `draftChat` to the `useMemo` dependency array.

- [ ] **Step 3: Render DraftChatView in the views loop**

In the `renderedViews` useMemo, add handling for the draft type inside the `for (const view of cachedViews)` loop:

```typescript
if (view.type === "draft") {
  const currentDraft = useUiStore.getState().draftChat;
  if (currentDraft) {
    views.push({
      key: view.key,
      node: <DraftChatView key="draft-chat" draft={currentDraft} />,
    });
  }
  continue;
}
```

- [ ] **Step 4: Also handle the HomeScreen fallback**

In the return JSX, the `HomeScreen` is shown when there's no `activeView`. The draft chat should prevent `HomeScreen` from showing. Since `activeView` now includes "draft", this should work automatically. Verify that the condition `{!activeView && showSessionViews && <HomeScreen />}` does not render when `draftChat` is active.

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 6: Commit**

```bash
git add src/components/layout/MainPanel.tsx
git commit -m "feat: route DraftChatView in MainPanel when draftChat is active"
```

---

### Task 7: Redesign ProjectGroup + Menu and Pencil Icon

**Files:**
- Modify: `src/components/sidebar/ProjectGroup.tsx`

This is the largest task — it replaces the current dropdown menu and updates the pencil icon behavior.

- [ ] **Step 1: Import setDraftChat and update dependencies**

Add the import for `MessageSquarePlus` from lucide-react (alongside existing imports). Import `DraftChat` type:

```typescript
import type { DraftChat } from "../../stores/uiStore";
```

Add store selector inside the component:

```typescript
const setDraftChat = useUiStore((s) => s.setDraftChat);
const defaultMode = useSettingsStore((s) => s.settings.defaultMode);
```

- [ ] **Step 2: Add handleNewChat callback**

Add a new callback for the "New Chat" menu option:

```typescript
const handleNewChat = useCallback(() => {
  setNewMenu(false);
  setExpanded(true);
  setDraftChat({
    projectId: project.id,
    repoPath: project.repo_path,
    provider: defaultProvider as Provider,
    model: null,
  });
}, [project.id, project.repo_path, defaultProvider, setDraftChat]);
```

- [ ] **Step 3: Add handleNewForgeSession callback**

Add a callback for the "New Forge Terminal" option (similar to handleNewClaudeSession but for Forge):

```typescript
const handleNewForgeSession = useCallback(async () => {
  setNewMenu(false);
  setExpanded(true);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const name = `Thread ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  try {
    const thread = await addThread({
      projectId: project.id,
      name,
      provider: "ForgeCode",
    });
    selectThread(thread.id);
  } catch (err) {
    console.error("Failed to create Forge session:", err);
  }
}, [project.id, addThread, selectThread]);
```

- [ ] **Step 4: Update handleNewWorktreeThread to open dialog**

Change `handleNewWorktreeThread` to no longer take a provider parameter. Instead, open the NewThreadDialog in worktree mode:

```typescript
const handleNewWorktreeThread = useCallback(() => {
  setNewMenu(false);
  setNewThreadOpen(true);
}, []);
```

- [ ] **Step 5: Replace the dropdown menu items**

Replace the entire `<motion.div>` menu content (the block inside `{newMenu && (...)}`) with the new 6-option menu:

```tsx
<motion.div
  initial={{ opacity: 0, scale: 0.95, y: -5 }}
  animate={{ opacity: 1, scale: 1, y: 0 }}
  exit={{ opacity: 0, scale: 0.95, y: -5 }}
  transition={{ duration: 0.15 }}
  className="absolute right-0 top-full z-50 mt-2 w-52 rounded-xl border border-[var(--glass-border-strong)] bg-black/55 backdrop-blur-xl py-1 shadow-2xl overflow-hidden origin-top-right ring-1 ring-black/50"
>
  <button
    onClick={handleNewChat}
    className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-xs font-semibold text-zinc-300 hover:bg-white/5 hover:text-white transition-colors"
  >
    <MessageSquarePlus size={14} className="shrink-0 text-blue-400" />
    New Chat
  </button>
  <div className="mx-2 my-1 border-t border-white/5" />
  <button
    onClick={() => { handleNewClaudeSession(); setExpanded(true); }}
    className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-xs font-semibold text-zinc-300 hover:bg-white/5 hover:text-white transition-colors"
  >
    <Terminal size={14} className="shrink-0 text-zinc-400" />
    New Claude Terminal
  </button>
  <button
    onClick={() => { handleNewCodexSession(); setExpanded(true); }}
    className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-xs font-semibold text-zinc-300 hover:bg-white/5 hover:text-white transition-colors"
  >
    <Terminal size={14} className="shrink-0 text-zinc-400" />
    New Codex Terminal
  </button>
  <button
    onClick={handleNewForgeSession}
    className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-xs font-semibold text-zinc-300 hover:bg-white/5 hover:text-white transition-colors"
  >
    <Terminal size={14} className="shrink-0 text-zinc-400" />
    New Forge Terminal
  </button>
  {isGitRepo && (
    <>
      <div className="mx-2 my-1 border-t border-white/5" />
      <button
        onClick={handleNewWorktreeThread}
        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-xs font-semibold text-zinc-300 hover:bg-white/5 hover:text-white transition-colors"
      >
        <GitBranch size={14} className="shrink-0 text-amber-400" />
        New Worktree
      </button>
    </>
  )}
  <div className="mx-2 my-1 border-t border-white/5" />
  <button
    onClick={() => { handleNewTerminal(); setExpanded(true); }}
    className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-xs font-semibold text-zinc-300 hover:bg-white/5 hover:text-white transition-colors"
  >
    <Terminal size={14} className="shrink-0 text-zinc-400" />
    New Terminal
  </button>
</motion.div>
```

- [ ] **Step 6: Update pencil icon (handleQuickNewThread)**

Replace the `handleQuickNewThread` callback to use `defaultMode`:

```typescript
const handleQuickNewThread = useCallback(() => {
  setExpanded(true);
  if (defaultMode === "chat") {
    handleNewChat();
    return;
  }
  // Terminal mode — use provider-specific handlers
  if (defaultProvider === "Codex") {
    handleNewCodexSession();
  } else if (defaultProvider === "Ollama") {
    handleNewChat(); // Ollama has no terminal mode, fall back to chat
  } else if (defaultProvider === "ForgeCode") {
    handleNewForgeSession();
  } else {
    handleNewClaudeSession();
  }
}, [defaultProvider, defaultMode, handleNewCodexSession, handleNewClaudeSession, handleNewChat, handleNewForgeSession]);
```

- [ ] **Step 7: Remove unused state**

Remove `newThreadInitialProvider` state and its setter since the menu no longer sets an initial provider for the dialog:

```typescript
// Remove this line:
const [newThreadInitialProvider, setNewThreadInitialProvider] = useState<"ClaudeCode" | "Codex" | "Ollama" | "ForgeCode" | undefined>(undefined);

// Remove the handleNewOllamaThread callback (Ollama is now handled via New Chat)
```

Update the `NewThreadDialog` usage at the bottom — remove `initialProvider` prop:

```tsx
<NewThreadDialog
  projectId={project.id}
  repoPath={project.repo_path}
  open={newThreadOpen}
  onClose={() => setNewThreadOpen(false)}
/>
```

- [ ] **Step 8: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 9: Commit**

```bash
git add src/components/sidebar/ProjectGroup.tsx
git commit -m "feat: redesign + menu with New Chat, terminal shortcuts, and updated pencil icon"
```

---

### Task 8: Scope NewThreadDialog to Worktree-Only

**Files:**
- Modify: `src/components/sidebar/NewThreadDialog.tsx`

- [ ] **Step 1: Remove provider selection UI**

Remove the `initialProvider` prop from the `Props` interface. Remove the provider selection buttons section (the `<div>` with the four provider buttons). Remove the `useEffect` that syncs provider with `initialProvider`.

The dialog should always default to the `defaultProvider` from settings and be focused on worktree configuration.

- [ ] **Step 2: Update dialog title**

Change the dialog title from "New Thread" to "New Worktree":

```tsx
<h2 className="text-lg font-semibold text-zinc-100">New Worktree</h2>
```

- [ ] **Step 3: Make worktree always enabled**

Remove the worktree toggle button. Instead, always set `useWorktree = true`. Remove the `setUseWorktree` state setter. The dialog is now only for creating worktree threads, so worktree is always on.

Keep the branch selection UI and advanced options as they are.

- [ ] **Step 4: Add provider selector back (simpler)**

Since the worktree dialog still needs to know which provider to use, add a simple provider row (just Claude, Codex, Forge — no Ollama for worktrees):

```tsx
<div>
  <label className="mb-1.5 block text-sm text-zinc-400">Provider</label>
  <div className="flex gap-2">
    <button
      type="button"
      onClick={() => setProvider("ClaudeCode")}
      className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-all ${
        provider === "ClaudeCode"
          ? "border-blue-500/50 bg-blue-500/15 text-blue-400 shadow-sm shadow-blue-500/10"
          : "border-white/[0.06] bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200"
      }`}
    >
      Claude
    </button>
    <button
      type="button"
      onClick={() => setProvider("Codex")}
      className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-all ${
        provider === "Codex"
          ? "border-green-500/50 bg-green-500/15 text-green-400 shadow-sm shadow-green-500/10"
          : "border-white/[0.06] bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200"
      }`}
    >
      Codex
    </button>
    <button
      type="button"
      onClick={() => setProvider("ForgeCode")}
      className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-all ${
        provider === "ForgeCode"
          ? "border-orange-500/50 bg-orange-500/15 text-orange-400 shadow-sm shadow-orange-500/10"
          : "border-white/[0.06] bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200"
      }`}
    >
      Forge
    </button>
  </div>
</div>
```

- [ ] **Step 5: Remove Ollama model selection**

Remove the entire Ollama model section (the `{provider === "Ollama" && (...)}` block), the `ollamaModels` state, the `selectedModel` / `customModel` state, and the `loadingModels` state. Remove the `ollamaListModels` import.

- [ ] **Step 6: Remove SDK mode toggle**

Remove the SDK mode toggle section (`{provider === "ClaudeCode" && sdkEnabled && sdkAvailable && (...)}`). Remove `interactionMode`, `sdkAvailable` state and the SDK availability check effect. Remove the `sdkCheckAvailable` import.

- [ ] **Step 7: Update handleSubmit**

Simplify `handleSubmit` — always create with `workMode: "Worktree"`:

```typescript
const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();
  setLoading(true);
  try {
    const thread = await addThread({
      projectId,
      name: generateThreadName(),
      provider,
      workMode: "Worktree",
      baseBranch: baseBranch || undefined,
      worktreeRoot: worktreeRoot || undefined,
    });
    selectThread(thread.id);
    onClose();
  } catch (err) {
    console.error("Failed to create worktree thread:", err);
  } finally {
    setLoading(false);
  }
};
```

- [ ] **Step 8: Update Props interface**

Remove `initialProvider` from Props:

```typescript
interface Props {
  projectId: string;
  repoPath: string;
  open: boolean;
  onClose: () => void;
}
```

Update the component signature:

```typescript
export function NewThreadDialog({ projectId, repoPath, open, onClose }: Props) {
```

- [ ] **Step 9: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 10: Commit**

```bash
git add src/components/sidebar/NewThreadDialog.tsx
git commit -m "refactor: scope NewThreadDialog to worktree-only creation"
```

---

### Task 9: Add Default Mode to Settings Dialog

**Files:**
- Modify: `src/components/sidebar/SettingsDialog.tsx`

- [ ] **Step 1: Find the Default Provider setting in the dialog**

Locate the existing `defaultProvider` setting UI in `SettingsDialog.tsx`. It should be a dropdown or button group for selecting the default provider.

- [ ] **Step 2: Add Default Mode selector below it**

Add a new setting row below the Default Provider row:

```tsx
<div>
  <label className="mb-1 block text-xs text-zinc-400">Default Mode</label>
  <p className="mb-2 text-[11px] text-zinc-500">
    What the pencil icon creates
  </p>
  <div className="flex gap-2">
    <button
      onClick={() => updateSettings({ defaultMode: "terminal" })}
      className={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
        settings.defaultMode === "terminal"
          ? "border-blue-500/50 bg-blue-500/15 text-blue-400"
          : "border-white/[0.06] bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08]"
      }`}
    >
      Terminal
    </button>
    <button
      onClick={() => updateSettings({ defaultMode: "chat" })}
      className={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
        settings.defaultMode === "chat"
          ? "border-blue-500/50 bg-blue-500/15 text-blue-400"
          : "border-white/[0.06] bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08]"
      }`}
    >
      Chat
    </button>
  </div>
</div>
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add src/components/sidebar/SettingsDialog.tsx
git commit -m "feat: add default mode setting to preferences dialog"
```

---

### Task 10: Update Cmd+N Shortcut in App.tsx

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Update the Cmd+N handler**

The current `Cmd+N` handler in `App.tsx` always creates a Claude terminal session. Update it to respect `defaultMode` and `defaultProvider` settings, matching the pencil icon behavior.

Find the `// Cmd+N — new Claude session in current project` block and update it to:

```typescript
// Cmd+N — new thread using default pairing
if (key === "n" && !e.shiftKey) {
  e.preventDefault();
  e.stopPropagation();
  const ui = useUiStore.getState();
  const projects = useProjectStore.getState().projects;
  const settings = useSettingsStore.getState().settings;
  const cwd = ui.selectedClaudeSessionCwd ?? ui.selectedCodexSessionCwd ?? ui.selectedTerminalSessionCwd;
  const project = cwd
    ? projects.find((p) => p.repo_path === cwd) ?? projects[0]
    : projects[0];
  if (!project) return;

  if (settings.defaultMode === "chat") {
    // Open draft chat
    useUiStore.getState().setDraftChat({
      projectId: project.id,
      repoPath: project.repo_path,
      provider: settings.defaultProvider,
      model: null,
    });
  } else {
    // Terminal mode — spawn directly based on provider
    if (settings.defaultProvider === "Codex") {
      import("./lib/commands").then(async ({ codexEnsureServer, codexStartThread, codexAccountRead }) => {
        try {
          await codexEnsureServer(project.repo_path);
          const account = await codexAccountRead(project.repo_path);
          if (!account.authenticated) return;
          const result = await codexStartThread(project.repo_path) as { thread?: { id?: string } };
          const threadId = result?.thread?.id;
          if (threadId) ui.selectCodexSession(threadId, project.repo_path);
        } catch (err) {
          console.error("Cmd+N Codex failed:", err);
        }
      });
    } else if (settings.defaultProvider === "ForgeCode") {
      import("./lib/commands").then(async ({ spawnClaudeNew }) => {
        // ForgeCode uses the thread store, not direct spawn
      });
      import("./stores/threadStore").then(async ({ useThreadStore }) => {
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const name = `Thread ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
        try {
          const thread = await useThreadStore.getState().addThread({
            projectId: project.id,
            name,
            provider: "ForgeCode",
          });
          ui.selectThread(thread.id);
        } catch (err) {
          console.error("Cmd+N Forge failed:", err);
        }
      });
    } else {
      // Default: Claude terminal (existing behavior)
      import("./lib/commands").then(async ({ spawnClaudeNew, listClaudeSessions }) => {
        const { claudeAutoMode: autoMode, claudeSkipPermissions: skipPerms } = settings;
        let existingIds: string[] = [];
        try {
          const existing = await listClaudeSessions(project.repo_path);
          existingIds = existing.map((s) => s.id);
        } catch { /* empty */ }
        const sessionId = await spawnClaudeNew(project.repo_path, skipPerms, autoMode);
        ui.setPreSpawnSessionIds(sessionId, existingIds);
        ui.selectClaudeSession(sessionId, project.repo_path, true);
      }).catch(console.error);
    }
  }
  return;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat: update Cmd+N shortcut to respect default mode and provider settings"
```

---

### Task 11: Final Integration Verification

- [ ] **Step 1: Run full TypeScript check**

Run: `cd /Users/neel/Documents/GitHub/xanom && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Manual smoke test checklist**

Start the app with `npx tauri dev` and verify:

1. **Pencil icon**: Creates thread using default provider + mode from settings
2. **+ menu**: Shows 6 options (New Chat, 3 terminals, Worktree if git, Terminal)
3. **New Chat**: Opens empty view with input bar and provider/model dropdown
4. **Provider dropdown**: Shows providers, hover expands sub-menus for Codex/Ollama
5. **Send first message**: Creates thread lazily, session view takes over
6. **New Claude/Codex/Forge Terminal**: Creates instantly (no dialog)
7. **New Worktree**: Opens dialog with provider + branch selection
8. **New Terminal**: Creates plain terminal
9. **Cmd+N**: Matches pencil icon behavior
10. **Settings**: Default Mode toggle appears, persists across restart

- [ ] **Step 3: Final commit**

If any fixes were needed during smoke testing, commit them:

```bash
git add -A
git commit -m "fix: thread creation UX polish from smoke testing"
```
