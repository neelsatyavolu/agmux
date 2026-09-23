# Factory Droid CLI — Integration Research for Xanom

**Date:** 2026-04-07
**Author:** deep-researcher
**Purpose:** Evaluate Factory's `droid` CLI as a third provider for Xanom (alongside Claude Code and Codex), with focus on hooks, settings, headless mode, session resume, auth, and parity with Claude Code. The driving question: can the Xanom hooks/settings infrastructure already built for Claude Code be reused for Droid with minimal changes?

---

## TL;DR

Droid is essentially a **near-1:1 clone of Claude Code's hook system and settings model**, with a few cosmetic renames (`autonomyMode` instead of `permissionMode`, `Execute`/`Create` instead of `Bash`/`Write`, etc.). The hook event names, JSON payload schema, exit-code semantics, `hookSpecificOutput.permissionDecision` block, settings file location pattern (`~/.factory/settings.json` + project `.factory/settings.json` + `.local.json` overrides), and `droid exec` headless flag set are all **structurally identical** to Claude Code.

**Verdict:** Xanom can reuse 80–90% of its existing Claude Code hooks/relay-script/settings-injection plumbing for Droid. The main gaps are (a) **no `--settings` CLI flag** documented for Droid (so settings injection has to go through `FACTORY_*` env vars or HOME isolation, same trick used in `reference_droid_vs_claudecode.md`), and (b) tool-name remapping (`Bash`→`Execute`, `Write`→`Create`, etc.) in any matchers Xanom hard-codes.

---

## 1. Hook System

### 1.1 Event list

Droid emits the following hook events (identical naming to Claude Code):

| Event | Trigger | Has `matcher` |
|---|---|---|
| `PreToolUse` | Before any tool call; can block | Yes (tool name regex) |
| `PostToolUse` | After a tool call completes | Yes (tool name regex) |
| `UserPromptSubmit` | When the user submits a prompt, before the model sees it | No |
| `Notification` | When Droid emits a notification (awaiting input, etc.) | No |
| `Stop` | When Droid finishes responding (not on user interrupt) | No |
| `SubagentStop` | When a sub-droid (Task tool call) finishes responding | No |
| `PreCompact` | Before a compact operation; matcher = `manual` or `auto` | Yes |
| `SessionStart` | New session or resume; `source` = `startup` / `resume` / `clear` / `compact` | Yes |
| `SessionEnd` | Session ends; `reason` = `clear` / `logout` / `prompt_input_exit` / `other` | No |

> Quoted from Droid Hooks Reference: *"Runs when a sub-droid (Task tool call) has finished responding."*

### 1.2 Configuration block (in `settings.json`)

Hooks live under a top-level `"hooks"` key inside any `settings.json` (user, project, or `.local`). Same nesting as Claude Code:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Execute",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/script.sh"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/prompt-validator.py"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Create|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "\"$FACTORY_PROJECT_DIR\"/.factory/hooks/check-style.sh"
          }
        ]
      }
    ]
  }
}
```

Quoted from Hooks Reference:

> *"Always use absolute paths for hook commands and scripts, not relative paths. Hooks execute from Droid's current working directory, which may change during execution. Use `\"$FACTORY_PROJECT_DIR\"/path/to/script.sh` for project-relative scripts or full paths like `/usr/local/bin/script.sh` or `~/.factory/hooks/script.sh` for global scripts."*

> *"You can use the environment variable `FACTORY_PROJECT_DIR` (only available when Droid spawns the hook command) to reference scripts stored in your project."*

This is the **direct analogue of `CLAUDE_PROJECT_DIR`** in Claude Code. Xanom's existing relay-script pattern (`~/.xanom/hooks/claude-hook.sh`) can be ported as-is to `~/.xanom/hooks/droid-hook.sh`.

### 1.3 Hook input payloads (stdin JSON)

Every event sends a JSON object on stdin with these **common fields**:

```text
session_id: string
transcript_path: string  // path to conversation JSON
cwd: string              // working dir at hook invocation
permission_mode: string  // "off" | "spec" | "auto-low" | "auto-medium" | "auto-high"
hook_event_name: string
... event-specific fields ...
```

#### PreToolUse Input

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.factory/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "off",
  "hook_event_name": "PreToolUse",
  "tool_name": "Create",
  "tool_input": {
    "file_path": "/path/to/file.txt",
    "content": "file content"
  }
}
```

#### PostToolUse Input

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.factory/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "off",
  "hook_event_name": "PostToolUse",
  "tool_name": "Create",
  "tool_input": {
    "file_path": "/path/to/file.txt",
    "content": "file content"
  },
  "tool_response": {
    "filePath": "/path/to/file.txt",
    "success": true
  }
}
```

#### Notification Input

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "off",
  "hook_event_name": "Notification",
  "message": "Task completed successfully"
}
```

#### UserPromptSubmit Input

Same common fields plus a `prompt: string` field containing the raw user prompt.

#### Stop / SubagentStop Input

Common fields plus `stop_hook_active: boolean` (set when Droid is already inside a stop hook, used to prevent infinite loops). Same semantics as Claude Code.

#### PreCompact Input

```json
{
  "session_id": "abc123",
  "transcript_path": "~/.factory/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "off",
  "hook_event_name": "PreCompact",
  "trigger": "manual",
  "custom_instructions": ""
}
```

#### SessionStart Input

```json
{
  "session_id": "abc123",
  "transcript_path": "~/.factory/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "off",
  "hook_event_name": "SessionStart",
  "source": "startup"
}
```

`source` is one of: `startup`, `resume` (from `--resume`/`--continue`/`/resume`), `clear` (from `/clear`), or `compact` (auto/manual compact).

#### SessionEnd Input

```json
{
  "session_id": "abc123",
  "transcript_path": "~/.factory/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "off",
  "hook_event_name": "SessionEnd",
  "reason": "other"
}
```

`reason` is one of: `clear`, `logout`, `prompt_input_exit`, `other`.

### 1.4 Hook output — exit codes vs JSON

Two ways for a hook to talk back to Droid:

**A. Exit codes (simple).**
> *"Exit code 0: Success. stdout is shown to the user in transcript mode (CTRL-R), except for `UserPromptSubmit` and `SessionStart`, where stdout is added to the context. Exit code 2: Blocking error..."*

Exit code 2 is the magic blocker — stderr is shown to Droid as feedback and the tool call is denied. Same as Claude Code.

**B. JSON output on stdout (advanced).** Hooks can emit a JSON object to control the decision:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "My reason here",
    "updatedInput": {
      "field_to_modify": "new value"
    }
  }
}
```

`permissionDecision` values:
- `"allow"` — auto-approves; reason shown to user only.
- `"deny"` — blocks the tool call; reason shown to Droid (so it can adapt).
- `"ask"` — escalates to a UI confirmation; reason shown to user.

Plus: `updatedInput` lets a hook **mutate the tool's parameters** before execution. Useful for sanitizing paths, adding flags, etc.

> *"The `decision` and `reason` fields are deprecated for PreToolUse hooks. Use `hookSpecificOutput.permissionDecision` and `hookSpecificOutput.permissionDecisionReason` instead. The deprecated fields `\"approve\"` and `\"block\"` map to `\"allow\"` and `\"deny\"` respectively."*

For `PostToolUse`: `decision: "block"` re-prompts Droid with `reason`; `hookSpecificOutput.additionalContext` injects extra context for the next turn.

Common JSON fields shared by all events: `continue` (boolean), `stopReason`, `suppressOutput`, `systemMessage`.

---

## 2. Settings (`settings.json`) Schema

### 2.1 Locations & precedence

| OS | Path |
|---|---|
| macOS / Linux | `~/.factory/settings.json` |
| Windows | `%USERPROFILE%\.factory\settings.json` |

Project-level: `<project>/.factory/settings.json`. Local overrides: `settings.local.json` alongside either, gitignored. Quoted:

> *"Local overrides merge on top of the corresponding `settings.json` at the same level and follow the same hierarchy precedence."*

Precedence (high → low): enterprise managed → project `.local.json` → project `settings.json` → user `.local.json` → user `settings.json`.

### 2.2 Top-level keys

| Key | Values | Default | Notes |
|---|---|---|---|
| `model` | `opus`, `opus-4-6`, `opus-4-6-fast`, `sonnet`, `sonnet-4-6`, `gpt-5.4`, `gpt-5.2`, `gpt-5.2-codex`, `gpt-5.3-codex`, `haiku`, `gemini-3.1-pro`, `gemini-3-flash`, `droid-core`, `glm-5`, `kimi-k2.5`, `minimax-m2.5`, `custom-model` | `opus` | Default model |
| `reasoningEffort` | `off`, `none`, `low`, `medium`, `high` | model-dependent | Structured-thinking budget |
| `autonomyMode` | `normal`, `spec`, `auto-low`, `auto-medium`, `auto-high` | `normal` | Default permission mode at startup |
| `cloudSessionSync` | `true` / `false` | `true` | Mirror sessions to Factory web |
| `diffMode` | `github`, `unified` | `github` | Diff display |
| `completionSound` | `off`, `bell`, `fx-ok01`, `fx-ack01`, file path | `fx-ok01` | Audio cue |
| `awaitingInputSound` | same | `fx-ack01` | Audio cue |
| `soundFocusMode` | `always`, ... | — | Sound focus rules |
| `todoDisplayMode` | `pinned`, `inline` | `pinned` | TODO list placement |
| `commandAllowlist` | `string[]` | `[]` | Auto-run safe commands |
| `commandDenylist` | `string[]` | `[]` | Always-block commands |
| `hooks` | object (see §1.2) | `{}` | Hook definitions |
| `ideAutoConnect` | `true` / `false` | `false` | IDE auto-attach |

### 2.3 Example full settings.json (from docs)

```json
{
  "model": "opus",
  "reasoningEffort": "low",
  "diffMode": "github",
  "cloudSessionSync": true,
  "completionSound": "fx-ok01",
  "awaitingInputSound": "fx-ack01",
  "soundFocusMode": "always",
  "todoDisplayMode": "pinned"
}
```

Plus an allow/deny example:

```json
{
  "commandAllowlist": ["ls", "pwd", "dir"],
  "commandDenylist": ["rm -rf /", "mkfs", "shutdown"]
}
```

---

## 3. Headless Mode (`droid exec`)

`droid exec` is the non-interactive equivalent of `claude -p`. Quoted:

> *"Droid Exec is Factory's headless execution mode designed for automation workflows. Unlike the interactive CLI, `droid exec` runs as a one-shot command that completes a task and exits, making it ideal for CI/CD pipelines, shell scripts, and batch processing."*

### 3.1 Autonomy levels (controls what Droid is allowed to do)

| Flag | Meaning |
|---|---|
| (no flag) | DEFAULT — read-only mode |
| `--auto low` | Low-risk operations (file edits, tests in sandbox) |
| `--auto medium` | Development operations |
| `--auto high` | Production operations |
| `--skip-permissions-unsafe` | Bypass all checks (use with extreme caution) |

> *"If a requested action exceeds the current autonomy level, droid exec will: 1. Stop immediately with a clear error message, 2. Return a non-zero exit code, 3. Not perform any partial changes."*

### 3.2 Output formats

```bash
# Default text
$ droid exec --auto low "create a python file that prints 'hello world'"
Perfect! I've created a Python file named hello_world.py ...

# JSON
$ droid exec "summarize this repository" --output-format json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 5657,
  "num_turns": 1,
  "result": "This is a Factory documentation repository ...",
  "session_id": "8af22e0a-d222-42c6-8c7e-7a059e391b0b"
}

# Streaming JSONL (real-time agent execution)
$ droid exec --output-format stream-json "..."

# Multi-turn JSON-RPC
$ droid exec --input-format stream-jsonrpc -o stream-jsonrpc
```

### 3.3 Piping & resume

```bash
# Piped stdin
git diff | droid exec "draft release notes"

# Resume an existing session
droid exec -s session-abc123 "continue"
```

---

## 4. CLI Reference — Flags

From `/reference/cli-reference`:

| Flag | Description |
|---|---|
| `-f, --file <path>` | Read prompt from a file |
| `-m, --model <id>` | Select a specific model |
| `-s, --session-id <id>` | Continue an existing session |
| `--auto <level>` | Autonomy level (`low`, `medium`, `high`) |
| `--enabled-tools <ids>` | Force-enable specific tools (comma/space separated) |
| `--disabled-tools <ids>` | Disable specific tools for this run |
| `--list-tools` | Print available tools, then exit |
| `-o, --output-format <format>` | `text`, `json`, `stream-json`, `stream-jsonrpc` |
| `--input-format <format>` | `stream-json`, `stream-jsonrpc` (multi-turn) |
| `-r, --reasoning-effort <level>` | `off`, `none`, `low`, `medium`, `high` |
| `--use-spec` | Force spec mode |
| `--skip-permissions-unsafe` | Skip all permission prompts |
| `--cwd <path>` | Execute from a specific working directory |

### Slash commands (interactive mode)

`/account`, `/billing`, `/bg-process`, `/bug`, `/clear`, `/commands`, `/compress`, `/cost`, `/create-skill`, `/droids`, `/enter-mission`, `/favorite`, `/fork`, `/help`, `/hooks`, `/ide`, `/install-github-app`, `/login`, `/logout`, `/mcp`, `/mission`, `/missions`, `/model`, `/new`, `/plugins`, `/quit`, `/readiness-report`, `/rename`, `/review`, `/settings`, `/resume`.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | General runtime error |
| `2` | Invalid CLI args / blocking hook error |

---

## 5. Session Resume

Three mechanisms (all match Claude Code semantics):

1. **`droid exec -s <session-id> "..."`** — resume in headless mode.
2. **`droid --resume`** / **`droid --continue`** — resume the most recent session interactively (the `SessionStart` hook payload uses `source: "resume"` for both).
3. **`/resume`** slash command from inside an interactive session.

Sessions are stored under `~/.factory/projects/<project-hash>/<session-uuid>.jsonl` — same JSONL-per-session pattern Claude Code uses, which means Xanom's existing **JSONL session-file watcher** (the `claude_chat` watcher) can be retargeted at the Droid sessions directory with minimal logic changes.

`/fork` duplicates a session into a new one, and `/compress` migrates the session into a new one with a summary.

---

## 6. Authentication

From the CLI reference's Authentication section:

> *"1. Generate an API key at app.factory.ai/settings/api-keys
> 2. Set the environment variable: `export FACTORY_API_KEY=fk-...`
> Persist the variable in your shell profile (`~/.bashrc`, `~/.zshrc`, or PowerShell `$PROFILE`) for long-term use."*

Two interactive auth flows:
- **Browser sign-in**: launched on first `droid` run if no key is set.
- **`/login`** slash command from inside an interactive session.

There is no documented `/cli/account/byok` page (the URL in the Xanom memory file `reference_factory_droid_docs.md` returns a 404). BYOK (Bring Your Own Key) does exist as a feature — model selector value `custom-model` references it — but the doc URL has moved (probably to `/cli/byok/overview` based on a sidebar link spotted in the settings page).

**For Xanom integration:** the simplest path is to inject `FACTORY_API_KEY` into the spawned PTY's env vars, identical to how API keys are handled today for Codex.

---

## 7. MCP Server Configuration

Droid supports MCP via `droid mcp add`:

```bash
# HTTP/SSE servers
droid mcp add figma https://mcp.figma.com/mcp --type http
droid mcp add twelvelabs https://mcp.twelvelabs.io --type http \
  --header "x-api-key: YOUR_KEY"

# Stdio servers (local processes)
droid mcp add <name> "<command>" [--env KEY=VALUE...]

# Remove
droid mcp remove <name>
```

Configuration is layered the same way settings are (user vs project). The `/mcp` slash command opens an interactive UI that can browse a 40+ server registry (Linear, Sentry, Notion, Stripe, Vercel, etc.).

---

## 8. Comparison: Droid vs Claude Code

| Feature | Claude Code | Droid |
|---|---|---|
| Settings file | `~/.claude/settings.json` | `~/.factory/settings.json` |
| Project settings | `.claude/settings.json` | `.factory/settings.json` |
| Local override | `.claude/settings.local.json` | `.factory/settings.local.json` |
| Hook events | `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Notification`, `Stop`, `SubagentStop`, `PreCompact`, `SessionStart`, `SessionEnd` | **Identical list** |
| Hook config block | `hooks.<EventName>[].matcher + hooks[]` | **Identical structure** |
| Hook stdin payload | JSON with `session_id`, `transcript_path`, `cwd`, `hook_event_name`, ... | **Identical fields** |
| Permission decision schema | `hookSpecificOutput.permissionDecision: allow / deny / ask` + `updatedInput` | **Identical** |
| Exit code 2 = block | Yes | Yes |
| Project dir env var | `CLAUDE_PROJECT_DIR` | `FACTORY_PROJECT_DIR` |
| Tool names | `Bash`, `Write`, `Edit`, `Read`, `Glob`, `Grep`, `Task`, `WebFetch`, ... | `Execute`, `Create`, `Edit`, `Read`, ..., `Task` (subagents called Task too) |
| Permission mode field name | `permission_mode` | `permission_mode` (same key, different values) |
| Permission mode values | `default`, `acceptEdits`, `bypassPermissions`, `plan` | `off`, `spec`, `auto-low`, `auto-medium`, `auto-high` |
| Session storage | `~/.claude/projects/<hash>/<session>.jsonl` | `~/.factory/projects/<hash>/<session>.jsonl` |
| Headless mode | `claude -p "..."` | `droid exec "..."` |
| Output formats | `text`, `json`, `stream-json` | `text`, `json`, `stream-json`, `stream-jsonrpc` |
| Resume flag | `--resume` / `--continue` / `-r <id>` | `--resume` / `--continue` / `-s <id>` |
| `--settings <path>` flag | **Yes** — can point to arbitrary settings.json | **NOT documented** — use HOME isolation or `FACTORY_*` env vars |
| MCP support | `claude mcp add` | `droid mcp add` (40+ registry) |
| Auth env var | `ANTHROPIC_API_KEY` | `FACTORY_API_KEY` (`fk-...` prefix) |
| Subagents (Task tool) | Yes | Yes (custom droids) |
| Skills | Yes | Yes (`/create-skill`) |
| Plugins | Yes | Yes (with hook merging) |
| Notification on awaiting input | Yes | Yes |

---

## 9. Verdict & Recommendation for Xanom

### Verdict: Yes — port the Claude Code hook plumbing for Droid. Reuse is high (~85%).

The Droid hook system is so structurally identical to Claude Code's that the Xanom hooks subsystem (`src-tauri/src/hooks/`) can be parameterized by provider rather than rewritten. The relay script pattern (`~/.xanom/hooks/claude-hook.sh`) translates directly — just write a sibling `droid-hook.sh` that targets the same Unix socket.

### What ports cleanly (zero or near-zero changes)

- **Hook dispatcher logic** in `hook_server.rs` — JSON payload shape is identical, key names match, exit-code semantics match.
- **Session activity state machine** (`HookDedup` / `SessionActivity`) — `Stop`, `Notification`, `UserPromptSubmit`, `SessionStart`, `SessionEnd` all fire with the same lifecycle meaning.
- **JSONL session watcher** (`claude_chat.rs`) — point it at `~/.factory/projects/` instead of `~/.claude/projects/`. Same structure: per-session JSONL files.
- **Settings file injection pattern** — write `~/.xanom/threads/{thread_id}/.factory/settings.json` and isolate the spawned process via `HOME` override (the same trick described in `reference_droid_vs_claudecode.md` for Droid's lack of `--settings`).
- **Tool approval / pre-tool-use blocking** — `permissionDecision: allow|deny|ask` + `updatedInput` is bit-for-bit the same JSON.
- **MCP server config** — both store at the same relative path under their config dirs.

### What needs adapting

1. **No `--settings <path>` CLI flag.** Droid only reads from `~/.factory/settings.json` and `<cwd>/.factory/settings.json`. To inject per-thread hooks, Xanom must either:
   - **(a)** Override `HOME` for the spawned PTY to point at a thread-private dir, then create `<HOME>/.factory/settings.json` there. This is the cleanest isolation but breaks any `~`-relative tooling Droid invokes downstream.
   - **(b)** Write `<thread_cwd>/.factory/settings.json` and rely on project-level layering. Cleaner but means polluting the user's repo with a thread-specific config (must be gitignored or written outside the repo).
   - **(c)** Hybrid: use `FACTORY_*` env vars where possible (e.g. `FACTORY_API_KEY`, `FACTORY_PROJECT_DIR`) and only use file injection for hooks.
   - Recommendation: **(a) HOME isolation**, same as the existing strategy.

2. **Tool name remapping.** Any matchers Xanom hardcodes for Claude Code (`Bash`, `Write`, `Edit`) must be remapped (`Execute`, `Create`, `Edit`) for Droid. Make this a per-provider lookup table.

3. **Permission mode value remapping.** `permission_mode` field name is identical but values differ. If Xanom's `SessionActivity` reads `permission_mode` to display autonomy state, add a translation layer:
   - Claude Code → `default`/`acceptEdits`/`bypassPermissions`/`plan`
   - Droid → `off`/`spec`/`auto-low`/`auto-medium`/`auto-high`

4. **Auth env var.** Use `FACTORY_API_KEY` (prefix `fk-`) instead of `ANTHROPIC_API_KEY`. Xanom likely already has a per-provider env-var injection layer for Codex, so this slots in there.

5. **Headless mode flag.** `claude -p` becomes `droid exec`. The `--auto low|medium|high` flag replaces the implicit Claude Code permission mode. Default (no `--auto`) is read-only.

6. **Output format parity.** Both support `--output-format json`. Droid additionally supports `stream-jsonrpc` which is preferable for multi-turn structured streaming if Xanom builds an SDK-equivalent for Droid.

### Hard stops / open questions

- **Sidecar SDK?** Droid has no documented Node.js SDK equivalent to `@anthropic-ai/claude-agent-sdk`. SDK-mode threads (Xanom's `interaction_mode: "sdk"`) probably can't be supported for Droid in the short term — only PTY mode.
- **Hook socket protocol versioning.** The Xanom hook server currently assumes Claude Code's exact payload shape. Even though Droid matches it 1:1 today, treat the parsing as provider-tagged so future divergence doesn't silently break either provider.
- **Session ID format.** Both use UUIDs. The dual-identity system (Xanom UUID vs provider UUID) already in place for Claude Code can be reused as-is.
- **Cloud session sync.** Droid defaults to `cloudSessionSync: true` (mirrors sessions to Factory web). For privacy-conscious users, Xanom should expose a per-thread toggle and default it to `false` in the injected settings.

### Suggested integration phases

1. **Phase 1 — PTY spawn + auth.** Add `Provider::Droid` enum variant. Detect `droid` binary via the existing augmented-PATH search. Inject `FACTORY_API_KEY` from the user's keychain. Verify a basic interactive PTY session works.
2. **Phase 2 — JSONL watcher.** Generalize `claude_chat.rs` watcher to a `provider_chat.rs` parameterized by session-dir path and JSONL schema. Point it at `~/.factory/projects/` for Droid threads.
3. **Phase 3 — Hooks injection.** HOME-isolation strategy: write `<thread_state_dir>/.factory/settings.json` with the hook block, set `HOME=<thread_state_dir>` in the PTY env. Reuse `hook_server.rs` as-is. Add a tool-name remap table.
4. **Phase 4 — Headless / SDK-equivalent.** Use `droid exec --output-format stream-jsonrpc` to build a structured-chat experience that approximates the SDK mode. Skip until Phases 1–3 are stable.

---

## Sources

All URLs verified accessible 2026-04-07. The four 404'd paths from the previous research session (`/cli/account/sessions`, `/cli/account/authentication`, `/cli/account/byok`, `/cli/exec`, `/cli/configuration/hooks`) are documented below as the **wrong paths** so Xanom's reference memory can be corrected.

**Authoritative pages:**
- `https://docs.factory.ai/reference/hooks-reference` — full hook event reference, JSON schemas, decision controls. Primary source for §1.
- `https://docs.factory.ai/cli/configuration/hooks-guide` — quickstart / overview for hooks. Linked in sidebar as `/cli/configuration/hooks-guide`.
- `https://docs.factory.ai/cli/configuration/settings` — settings.json schema and table of all keys. Primary source for §2.
- `https://docs.factory.ai/cli/droid-exec/overview` — headless mode, autonomy levels, output formats. Primary source for §3.
- `https://docs.factory.ai/reference/cli-reference` — CLI flags table, slash commands, exit codes, authentication. Primary source for §§4, 6.
- `https://docs.factory.ai/cli/configuration/mcp` — MCP server registration. Primary source for §7.
- `https://docs.factory.ai/cli/getting-started/quickstart` — install / first-run flow.
- `https://docs.factory.ai/cli/getting-started/overview` — high-level CLI overview.

**Confirmed dead URLs (404 as of 2026-04-07) — fix in `reference_factory_droid_docs.md`:**
- `https://docs.factory.ai/cli/configuration/hooks` — moved to `/cli/configuration/hooks-guide`.
- `https://docs.factory.ai/cli/exec` — moved to `/cli/droid-exec/overview`.
- `https://docs.factory.ai/cli/account/sessions` — page does not exist; sessions are documented inline in CLI reference.
- `https://docs.factory.ai/cli/account/authentication` — moved into `/reference/cli-reference#authentication`.
- `https://docs.factory.ai/cli/account/byok` — moved to `/cli/byok/overview` (linked from settings page sidebar but not directly verified).
- `https://docs.factory.ai/cli/reference/cli-reference` — wrong prefix; the canonical path is `/reference/cli-reference` (no `/cli/`).

## Caveats

- All findings are based on docs as of 2026-04-07. Factory ships frequently and the model list especially changes (e.g. `opus-4-6` and `gpt-5.4` are unusually advanced naming — verify these are still current before relying on them in code).
- Hook output format quoting from a single source (the Hooks Reference page); cross-validation against actual `droid` binary behavior is recommended before shipping. Spin up a smoke-test hook that just dumps `cat > /tmp/droid-hook-payload.json` and inspect what Droid actually sends.
- BYOK / custom-model integration was not verified (the doc URL 404'd) — treat it as TODO before claiming Xanom supports BYOK with Droid.
- Sidecar SDK availability for Droid is **not documented**. Don't promise SDK-mode parity until Factory publishes a JS/TS agent SDK equivalent.
