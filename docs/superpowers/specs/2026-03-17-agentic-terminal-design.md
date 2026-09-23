# Agentic Terminal — Design Spec

## Overview

Add Cmd+Enter support to the standalone terminal's WarpInputBar that sends natural language prompts to an AI CLI (Claude or Codex), which runs commands autonomously in the existing PTY until the task is complete.
This keeps the terminal-first workflow intact while adding a faster path for natural-language task entry.

## User Flow

1. User types a natural language prompt in WarpInputBar (e.g., "set up Redis caching for my web app")
2. User presses Cmd+Enter (instead of Enter for regular commands)
3. The appropriate CLI command is constructed and sent to the PTY
4. Input bar transitions to "agent running" state (sparkle icon, disabled input, stop button)
5. CLI output streams into the terminal naturally (commands, reasoning, results)
6. When the CLI exits, a sentinel escape sequence is detected
7. Input bar returns to normal state, ready for the next command

## Input Bar States

### Normal State (unchanged)
- `$` prompt prefix
- Placeholder: `"Describe a task... (⌘↵)"`  (updated from current "Type a command...")
- Enter → sends command to shell
- Cmd+Enter → triggers agentic mode

### Agent Running State
- Sparkle icon replaces `$` prompt
- Text: "Agent running..." (non-editable)
- Stop button (square icon) visible — sends SIGINT (Ctrl+C) to PTY
- Regular input disabled
- Cmd+C also sends SIGINT as escape hatch

## CLI Commands

### Claude
```
claude -p "ESCAPED_PROMPT" --model claude-haiku-4-5-20251001
```
- `-p` = print mode (non-interactive, streams output, exits when done)
- Model: haiku for speed/cost efficiency

### Codex
```
codex -q --model gpt-5.3-codex --approval-mode full-auto "ESCAPED_PROMPT"
```
- `-q` = quiet mode
- `--approval-mode full-auto` = no approval prompts, runs autonomously

## Agent Completion Detection

After the CLI command, append a sentinel:
```
; printf '\033]133;XANOM_AGENT_DONE\a'
```

The `handleData` callback in `StandaloneTerminalView.tsx` watches for `\033]133;XANOM_AGENT_DONE\a` in the PTY output stream (using the existing `tailRef` buffer). When detected:
1. Strip the sentinel from terminal output (don't render it)
2. Call `onAgentDone()` callback
3. WarpInputBar transitions back to normal state

## Provider Selection

### Settings
- New field in `settingsStore`: `agenticProvider: "auto" | "claude" | "codex"`
- Default: `"auto"`

### Auto-detection Logic
New Rust command `detect_agentic_provider`:
1. Check if `claude` CLI is in PATH and executable → "claude"
2. Check if `codex` CLI is in PATH and executable → "codex"
3. If both available → prefer "claude"
4. If neither → return null (Cmd+Enter shows a toast/error)

### Settings UI
New section in SettingsDialog: "Agentic Terminal"
- Segmented control: Auto / Claude / Codex
- Below: shows detected provider when "Auto" is selected

## Prompt Escaping

The user's prompt is embedded in a shell command, so it must be properly escaped:
- Single quotes in the prompt are escaped: `'` → `'\''`
- The prompt is wrapped in single quotes
- This prevents shell injection from user input

## Files to Modify

| File | Changes |
|------|---------|
| `src/components/thread/WarpInputBar.tsx` | Cmd+Enter handler, agent running state UI, stop button |
| `src/components/thread/StandaloneTerminalView.tsx` | Sentinel detection in `handleData`, `onAgentDone` callback, strip sentinel from output |
| `src/stores/terminalStore.ts` | `agentRunning` state per session |
| `src/stores/settingsStore.ts` | `agenticProvider` setting |
| `src/components/sidebar/SettingsDialog.tsx` | Provider picker UI |
| `src/lib/commands.ts` | `detectAgenticProvider` wrapper |
| `src-tauri/src/commands/terminal.rs` or new file | `detect_agentic_provider` Rust command |

## Edge Cases

- **No CLI installed:** Cmd+Enter shows brief error in input bar ("No AI CLI found — install Claude or Codex")
- **Agent interrupted:** Ctrl+C / Stop button sends SIGINT; sentinel won't fire, so also clear agent state on shell prompt return (OSC 133 prompt detection as fallback)
- **Long-running agent:** No timeout — user controls via Stop button
- **Prompt is empty:** Cmd+Enter with empty input does nothing
- **Alt-screen during agent:** If CLI enters alt-screen, WarpInputBar hides as usual; agent state persists and clears on sentinel or alt-screen exit + prompt return
