# Ollama Agentic Chat — Design Spec

**Date:** 2026-03-26
**Status:** Approved

## Overview

Add Ollama as a third provider in Xanom, enabling users to create threads that chat with locally-running Ollama models. Unlike Claude Code and Codex (which run as PTY subprocesses), the Ollama agent runtime is built directly into Xanom's Rust backend, giving the model full tool-calling capabilities (read, write, edit, bash, glob, grep) with a tiered approval system.

## Design Decisions

| Decision | Choice |
|----------|--------|
| Chat scope | Agentic — full tool use, matching Claude Code's tool set |
| UI | Reuse ClaudeChatView rendering pipeline |
| Approval model | Tiered — read-only tools auto-execute, write/bash require approval |
| Model selection | Any installed model from `/api/tags` + free-text custom input |
| Architecture | Rust-native agent loop (Approach 1) |

## 1. Provider & Thread Model

**New provider value:** `"Ollama"` added to the `Provider` type and the `threads.provider` CHECK constraint (via migration 009).

**Thread creation:** `NewThreadDialog` gets an Ollama option. When selected, shows a model dropdown populated from `GET /api/tags` plus a free-text input for custom model names. No `reasoning_effort` or `fast_mode` fields — those are Claude/Codex-specific.

**Thread fields used:**
- `provider = "Ollama"`
- `model` = user-selected model name (e.g., `"qwen2.5-coder:7b"`)
- `work_dir` = project repo path (execution context for file/bash tools)
- `state_dir` = `~/.xanom/threads/{thread_id}/` (stores conversation history JSON)

**No PTY subprocess.** Unlike Claude Code/Codex, Ollama threads don't spawn a CLI process. The agent loop is a Rust async task managed by `AppState`.

## 2. Agent Runtime (Rust)

**Core struct:** `OllamaAgent` in `src-tauri/src/ollama/` (new module, separate from `ael/ollama.rs` which stays for summarization/autocomplete).

**Agent loop:**
1. User sends message -> Tauri command `ollama_send_message(thread_id, content)`
2. Rust builds conversation history (loaded from `state_dir/history.json`) + tool definitions
3. Calls Ollama `/api/chat` with `tools` parameter and `stream: true`
4. Streams response tokens -> emits `ClaudeChatItemAssistantText` events to frontend
5. If model returns tool calls -> emits `ClaudeChatItemToolUse` event
6. **Approval check:** Read-only tools (Read, Glob, Grep, ListDirectory) auto-execute. Write/Edit/Bash pause and emit an approval request event, wait for frontend response.
7. Executes tool -> emits `ClaudeChatItemToolResult` event
8. Feeds tool results back to Ollama -> loop continues from step 3
9. When model produces final text with no tool calls -> loop ends

**Tool definitions** (Ollama tool calling format — OpenAI-compatible):

| Tool | Parameters | Approval |
|------|-----------|----------|
| `read_file` | `path`, `limit?`, `offset?` | Auto |
| `write_file` | `path`, `content` | Required |
| `edit_file` | `path`, `old_string`, `new_string` | Required |
| `bash` | `command`, `timeout?` | Required |
| `glob` | `pattern`, `path?` | Auto |
| `grep` | `pattern`, `path?`, `glob?` | Auto |
| `list_directory` | `path` | Auto |

**State management:**
- Active agents tracked in `AppState` via `HashMap<String, OllamaAgentHandle>` (thread_id -> join handle + cancel token)
- Cancellation: user can stop mid-loop via `ollama_stop(thread_id)` which sets a `CancellationToken`
- Conversation history persisted to `state_dir/history.json` after each turn

**Execution context:** All file/bash tools execute relative to `thread.work_dir`. Bash commands run via `std::process::Command` (not PTY — simpler, captures stdout/stderr directly).

## 3. Frontend Integration

**Provider routing:** `ClaudeSessionView` checks `thread.provider` — if `"Ollama"`, it uses the same `ClaudeChatView` for rendering but swaps the input bar behavior to call `ollama_send_message` instead of PTY write.

**Events:** The Rust agent loop emits Tauri events on channel `ollama-chat-{threadId}` with payloads matching the existing `ClaudeChatItem` types. `ClaudeChatView` subscribes to these alongside the existing PTY events.

**Approval flow:** When the agent hits a write/bash tool, it emits an approval event. The existing `ApprovalBanner` component renders it. User approves/denies -> frontend calls `ollama_approve(thread_id, tool_use_id, approved)` -> Rust agent loop continues or skips.

**Input bar changes:**
- Ollama threads use `ClaudeInputBar` but hide slash commands (not applicable)
- Model name shown in a subtle badge in the input area
- Stop button calls `ollama_stop(thread_id)` instead of PTY SIGTERM

**Session state machine:** Reuse `sessionStateMachine.ts` — states map naturally:
- `idle` -> no active agent loop
- `processing` -> agent loop running
- `awaiting_input` -> waiting for tool approval
- `stopped` -> cancelled or complete

**Sidebar:** Ollama threads appear in the regular thread list with an Ollama icon. `NewThreadDialog` gets a third provider tab/option.

**No changes to:** `CodexSessionView`, `ClaudeTerminalView`, usage tracking (v1 — no token cost tracking for local models), hook system (not applicable to Ollama).

## 4. Tauri Commands

```
// Agent lifecycle
ollama_send_message(thread_id: String, content: String) -> Result<(), String>
ollama_stop(thread_id: String) -> Result<(), String>
ollama_approve(thread_id: String, tool_use_id: String, approved: bool) -> Result<(), String>

// Model discovery
ollama_list_models() -> Result<Vec<OllamaModel>, String>

// History
ollama_get_history(thread_id: String) -> Result<Vec<ClaudeChatItem>, String>
ollama_clear_history(thread_id: String) -> Result<(), String>
```

All registered in `lib.rs` invoke handler. Frontend wrappers in `src/lib/commands.ts`.

## 5. Database Migration

**Migration 009:** Alter `threads.provider` CHECK constraint to allow `'ClaudeCode' | 'Codex' | 'Ollama'`.

No new tables. Conversation history lives in the filesystem (`state_dir/history.json`) rather than the database — keeps it simple and avoids schema changes for message storage. The `agent_logs` table can optionally be reused for Ollama I/O logging with the existing auto-prune.

## 6. File Structure

```
src-tauri/src/ollama/        # NEW module
  mod.rs                     # module exports
  agent.rs                   # OllamaAgent struct, agent loop, streaming
  tools.rs                   # tool definitions, tool execution dispatch
  types.rs                   # OllamaModel, ChatMessage, ToolCall, etc.
  history.rs                 # conversation persistence (JSON file I/O)

src-tauri/src/commands/ollama.rs   # NEW — 6 Tauri commands
```

**Frontend — changes to existing files only:**
- `src/lib/types.ts` — add `"Ollama"` to Provider type, OllamaModel type
- `src/lib/commands.ts` — add ollama command wrappers
- `src/stores/threadStore.ts` — handle Ollama provider in thread creation
- `src/stores/settingsStore.ts` — no changes needed (Ollama uses its own config)
- `src/components/sidebar/NewThreadDialog.tsx` — add Ollama provider option + model selector
- `src/components/thread/ClaudeSessionView.tsx` — route Ollama threads to chat view
- `src/components/thread/ClaudeChatView.tsx` — subscribe to `ollama-chat-{threadId}` events
- `src/lib/sessionStateMachine.ts` — no changes needed (states already fit)

## 7. System Prompt

The agent loop prepends a system prompt that:
- Identifies the model as a coding assistant running inside Xanom
- Lists available tools with descriptions and parameter schemas
- Sets the working directory context (`work_dir`)
- Instructs the model to use tools for file operations rather than guessing file contents
- Keeps it concise — small models have limited context windows

The system prompt is hardcoded in `agent.rs` for v1. A UI for customization is out of scope.

## 8. Out of Scope (v1)

- Token/cost tracking for Ollama models
- Hook system integration
- System prompt customization UI (hardcoded system prompt for v1)
- Model pulling/downloading from within Xanom
- Conversation branching/forking
- Multi-turn tool use limits or safety guardrails beyond approval
