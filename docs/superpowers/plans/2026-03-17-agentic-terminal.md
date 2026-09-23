# Agentic Terminal Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Cmd+Enter support to the standalone terminal that sends natural language prompts to Claude/Codex CLI for autonomous task execution.

**Architecture:** WarpInputBar gets a Cmd+Enter handler that constructs a CLI command (`claude -p` or `codex -q`) and sends it to the PTY. A sentinel escape sequence appended after the CLI command triggers the input bar to return to normal state when the agent finishes. Provider selection is persisted in settingsStore with auto-detection via the existing `detect_available_providers` command.

**Tech Stack:** React 19, TypeScript, Zustand v5, Tauri v2 (existing PTY infrastructure)

---

### Task 1: Add `agenticProvider` setting to settingsStore

**Files:**
- Modify: `src/stores/settingsStore.ts:28-99`

- [ ] **Step 1: Add the setting type and field**

In `AppSettings` interface (line 28), add after the `customThemeColor` field:

```typescript
/** Preferred AI CLI for agentic terminal: auto-detects if "auto". */
agenticProvider: "auto" | "claude" | "codex";
```

In `DEFAULT_SETTINGS` (line 73), add:

```typescript
agenticProvider: "auto",
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS (no errors)

---

### Task 2: Add `agentRunning` state to terminalStore

**Files:**
- Modify: `src/stores/terminalStore.ts:1-130`

- [ ] **Step 1: Add agent running tracking**

Add a stable empty record constant near line 19:

```typescript
const EMPTY_AGENT_RECORD: Record<string, boolean> = {};
```

Add to the state interface (after `gitInfoBySession`):

```typescript
agentRunningBySession: Record<string, boolean>;
setAgentRunning: (sessionId: string, running: boolean) => void;
```

Add to the store initial state:

```typescript
agentRunningBySession: EMPTY_AGENT_RECORD,
```

Add the action:

```typescript
setAgentRunning: (sessionId, running) => {
  set((s) => ({
    agentRunningBySession: { ...s.agentRunningBySession, [sessionId]: running },
  }));
},
```

Clean up in `removeSession` — destructure `agentRunningBySession` alongside `cwdBySession` and `gitInfoBySession`:

```typescript
const { [id]: _agent, ...agentRest } = s.agentRunningBySession;
// ...
agentRunningBySession: agentRest,
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS

---

### Task 3: Add sentinel detection to StandaloneTerminalView

**Files:**
- Modify: `src/components/thread/StandaloneTerminalView.tsx:8-14,118-157`

- [ ] **Step 1: Add `onAgentDone` prop and sentinel constant**

Add to Props interface (line 8):

```typescript
onAgentDone?: () => void;
```

Add sentinel constant after the ALT_SCREEN constants (after line 21):

```typescript
const AGENT_DONE_SENTINEL = "\x1b]133;XANOM_AGENT_DONE\x07";
```

- [ ] **Step 2: Add sentinel detection in handleData**

In the `handleData` callback (around line 118), after the OSC 7 CWD detection block and before `term.write(bytes)`, add:

```typescript
// Agent completion sentinel detection
if (combined.includes(AGENT_DONE_SENTINEL)) {
  onAgentDone?.();
  // Strip the sentinel from the output so it doesn't render
  const cleaned = text.replace(/\x1b\]133;XANOM_AGENT_DONE\x07/g, "");
  if (cleaned.length === 0) return;
  const cleanedBytes = new TextEncoder().encode(cleaned);
  term.write(cleanedBytes);
  return;
}
```

Note: The early return skips the normal `term.write(bytes)` — we write the cleaned version instead.

- [ ] **Step 3: Add `onAgentDone` to useCallback dependency array**

Update the dependency array of `handleData` (line 157) to include `onAgentDone`:

```typescript
[onAltScreenChange, onCwdChange, onAgentDone]
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS

---

### Task 4: Wire up Cmd+Enter in WarpInputBar

**Files:**
- Modify: `src/components/thread/WarpInputBar.tsx:1-248`

This is the core task. WarpInputBar gets:
- Cmd+Enter handler that constructs and sends the CLI command
- Agent running state (sparkle icon, disabled input, stop button)
- Provider resolution using settings + `detectAvailableProviders`

- [ ] **Step 1: Add imports and props**

Add to imports (line 1):

```typescript
import { Sparkles, Square } from "lucide-react";
import { useSettingsStore } from "../../stores/settingsStore";
import { detectAvailableProviders } from "../../lib/commands";
```

Add to Props interface (line 9):

```typescript
agentRunning: boolean;
onAgentStart: () => void;
```

Update the component signature to destructure the new props:

```typescript
export function WarpInputBar({ sessionId, visible, cwd, gitInfo, agentRunning, onAgentStart }: Props) {
```

- [ ] **Step 2: Add agent command builder**

Add after the `savedInputRef` / `dirPillRef` refs (around line 52):

```typescript
const agenticProvider = useSettingsStore((s) => s.settings.agenticProvider);

const buildAgentCommand = useCallback(async (prompt: string): Promise<string | null> => {
  let provider = agenticProvider;

  if (provider === "auto") {
    try {
      const providers = await detectAvailableProviders();
      const claude = providers.find((p) => p.id === "claude" && p.available);
      const codex = providers.find((p) => p.id === "codex" && p.available);
      if (claude) provider = "claude";
      else if (codex) provider = "codex";
      else return null;
    } catch {
      return null;
    }
  }

  // Escape single quotes for safe shell embedding
  const escaped = prompt.replace(/'/g, "'\\''");

  if (provider === "claude") {
    return `claude -p '${escaped}' --model claude-haiku-4-5-20251001; printf '\\033]133;XANOM_AGENT_DONE\\a'`;
  } else {
    return `codex -q --model gpt-5.3-codex --approval-mode full-auto '${escaped}'; printf '\\033]133;XANOM_AGENT_DONE\\a'`;
  }
}, [agenticProvider]);
```

- [ ] **Step 3: Add agent submit handler**

Add after `handleSubmit` (around line 72):

```typescript
const handleAgentSubmit = useCallback(async () => {
  const trimmed = value.trim();
  if (!trimmed || agentRunning) return;

  const cmd = await buildAgentCommand(trimmed);
  if (!cmd) {
    // No CLI available — briefly flash an error in the input
    // For now, just log; a toast system could be added later
    console.warn("[WarpInputBar] No AI CLI found");
    return;
  }

  setHistory((prev) => {
    const deduped = prev.filter((h) => h !== trimmed);
    return [...deduped, trimmed];
  });
  setHistoryIndex(-1);
  savedInputRef.current = "";
  setValue("");
  onAgentStart();
  sendPtyLine(sessionId, cmd).catch(() => {});
}, [sessionId, value, agentRunning, buildAgentCommand, onAgentStart]);
```

- [ ] **Step 4: Add Cmd+Enter to keydown handler**

In `handleKeyDown` (line 74), add at the **top** of the function (before the existing Enter handler):

```typescript
if (e.key === "Enter" && e.metaKey) {
  e.preventDefault();
  handleAgentSubmit();
  return;
}
```

This must come before the plain Enter handler so Cmd+Enter is caught first.

Also add a stop handler for when agent is running — Cmd+C or clicking Stop:

```typescript
// While agent is running, Escape sends Ctrl+C to stop
if (agentRunning && e.key === "Escape") {
  e.preventDefault();
  sendPtyInput(sessionId, "\x03").catch(() => {});
  return;
}
```

Update the `handleKeyDown` dependency array to include `handleAgentSubmit` and `agentRunning`.

- [ ] **Step 5: Update the render — agent running state**

Replace the `$` prompt span and input section. The `$` prompt changes to a sparkle icon when agent is running, and the input disables:

Replace the `<span>` with `$` (around line 214):

```tsx
<span className="shrink-0 select-none font-mono text-sm leading-6 text-zinc-500">
  {agentRunning ? (
    <Sparkles size={14} className="text-blue-400 animate-pulse" />
  ) : (
    "$"
  )}
</span>
```

Update the input element — disable when agent running, update placeholder:

```tsx
<input
  ref={inputRef}
  type="text"
  value={agentRunning ? "" : value}
  onChange={(e) => {
    if (agentRunning) return;
    setValue(e.target.value);
    setHistoryIndex(-1);
  }}
  onKeyDown={handleKeyDown}
  disabled={agentRunning}
  spellCheck={false}
  autoCorrect="off"
  autoCapitalize="off"
  autoComplete="off"
  className={`relative z-10 h-6 w-full bg-transparent p-0 font-mono text-sm leading-6 outline-none caret-zinc-400 ${
    agentRunning
      ? "text-zinc-500 cursor-not-allowed"
      : "text-zinc-100 placeholder-zinc-600"
  }`}
  placeholder={
    agentRunning
      ? "Agent running..."
      : suggestion
        ? ""
        : "Type a command... (⌘↵ for AI)"
  }
/>
```

Add a stop button after the input's parent div (inside the flex row, after the `relative flex-1` div):

```tsx
{agentRunning && (
  <button
    type="button"
    onClick={() => sendPtyInput(sessionId, "\x03").catch(() => {})}
    className="shrink-0 rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-700/50 hover:text-zinc-300"
    title="Stop agent (Ctrl+C)"
  >
    <Square size={14} />
  </button>
)}
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS

---

### Task 5: Wire parent component to pass agent state

**Files:**
- Modify: `src/components/thread/TerminalMainPanel.tsx` (the component that renders StandaloneTerminalView + WarpInputBar together)

- [ ] **Step 1: Find and read TerminalMainPanel.tsx**

Read the file to understand how StandaloneTerminalView and WarpInputBar are composed.

- [ ] **Step 2: Wire agent state between components**

Import `useTerminalStore` (if not already) and connect:

```typescript
const agentRunningBySession = useTerminalStore((s) => s.agentRunningBySession);
const setAgentRunning = useTerminalStore((s) => s.setAgentRunning);

// For each session's WarpInputBar:
const agentRunning = agentRunningBySession[sessionId] ?? false;
```

Pass to `StandaloneTerminalView`:

```tsx
<StandaloneTerminalView
  // ...existing props
  onAgentDone={() => setAgentRunning(sessionId, false)}
/>
```

Pass to `WarpInputBar`:

```tsx
<WarpInputBar
  // ...existing props
  agentRunning={agentRunning}
  onAgentStart={() => setAgentRunning(sessionId, true)}
/>
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS

---

### Task 6: Add agentic provider picker to SettingsDialog

**Files:**
- Modify: `src/components/sidebar/SettingsDialog.tsx`

- [ ] **Step 1: Add a provider picker in the General tab**

In the General tab section, add an "Agentic Terminal" subsection with a segmented control (matching the existing UI patterns in the file):

```tsx
{/* Agentic Terminal */}
<div>
  <label className="mb-1.5 block text-xs font-medium text-zinc-400">
    Agentic Terminal Provider
  </label>
  <p className="mb-2 text-xs text-zinc-500">
    AI CLI used when pressing ⌘↵ in the terminal
  </p>
  <div className="flex gap-1 rounded-lg bg-zinc-800/50 p-1">
    {(["auto", "claude", "codex"] as const).map((opt) => (
      <button
        key={opt}
        type="button"
        onClick={() => updateSettings({ agenticProvider: opt })}
        className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
          settings.agenticProvider === opt
            ? "bg-zinc-700 text-zinc-100"
            : "text-zinc-400 hover:text-zinc-300"
        }`}
      >
        {opt === "auto" ? "Auto" : opt === "claude" ? "Claude" : "Codex"}
      </button>
    ))}
  </div>
</div>
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS

---

### Task 7: Integration test & commit

- [ ] **Step 1: Manual smoke test**

1. Open Xanom, go to Terminal tab
2. Type a regular command, press Enter — should work as before
3. Type "list files in this directory", press Cmd+Enter
4. Verify: CLI command is sent, terminal shows AI output, input bar shows sparkle + "Agent running..."
5. When agent finishes, verify input bar returns to normal
6. Test Stop button (click or Escape) during agent run
7. Check Settings > General — verify agentic provider picker works

- [ ] **Step 2: Commit**

```bash
git add src/stores/settingsStore.ts src/stores/terminalStore.ts src/components/thread/WarpInputBar.tsx src/components/thread/StandaloneTerminalView.tsx src/components/sidebar/SettingsDialog.tsx
git commit -m "feat: agentic terminal — Cmd+Enter sends prompts to AI CLI"
```

---

### Task 8: Update CLAUDE.md

- [ ] **Step 1: Add agentic terminal section**

Add under "### Standalone Terminal" in CLAUDE.md:

```markdown
### Agentic Terminal
- Cmd+Enter in WarpInputBar sends natural language prompts to AI CLI (Claude or Codex)
- Provider selection: `settingsStore.agenticProvider` ("auto" | "claude" | "codex"), auto-detects installed CLIs
- Claude: `claude -p 'prompt' --model claude-haiku-4-5-20251001`
- Codex: `codex -q --model gpt-5.3-codex --approval-mode full-auto 'prompt'`
- Sentinel `\033]133;XANOM_AGENT_DONE\a` appended after CLI command, detected by StandaloneTerminalView to signal completion
- `terminalStore.agentRunningBySession` tracks per-session agent state
- WarpInputBar shows sparkle icon + "Agent running..." + Stop button during execution
```
