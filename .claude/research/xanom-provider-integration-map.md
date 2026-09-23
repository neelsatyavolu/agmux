# Xanom Provider Integration Map
## Complete touchpoints for adding a new CLI provider (grok, etc.)

Last updated: 2026-05-14 | Current providers: ClaudeCode, Codex, Droid, OpenCode, MLX

---

## 1. Provider Enum / Type Definitions

**Canonical source:** `src-tauri/src/db/models.rs:16-20` (Rust enum)
**Frontend sync:** `src/lib/types.ts:9` (TypeScript union)

```rust
// src-tauri/src/db/models.rs:16-20
pub enum Provider {
    ClaudeCode,
    Codex,
    Droid,
    OpenCode,
    Mlx,
}
```

```typescript
// src/lib/types.ts:9
export type Provider = "ClaudeCode" | "Codex" | "Droid" | "OpenCode" | "MLX";
```

**Where strings are stored:**
- Database: `threads.provider` column (TEXT) — stores enum name as string ("ClaudeCode", "Codex", etc.)
- Serialization: `Provider::as_str()` and `Provider::from_str()` at `src-tauri/src/db/models.rs:157-180`

**Pattern:** Single enum definition in Rust; TypeScript auto-syncs. Adding a new provider requires:
1. Add variant to Rust enum
2. Update `as_str()` and `from_str()` impls (lines 160–180)
3. Update TypeScript union
4. Update test assertions (lines 251–265)

**Status:** ✅ Centralized, easy to extend (5 lines per provider)

---

## 2. PTY Spawn Logic (Provider Dispatch)

**Primary:** `src-tauri/src/process/spawn.rs:189-469`  
**Match statement:** Lines 244–434 (provider-specific args)

```rust
// src-tauri/src/process/spawn.rs:206-207
let provider_enum = Provider::from_str(provider)?;
let binary_name = provider_enum.cli_binary_name();

// Lines 244–434: match provider_enum { Provider::Codex => {...}, Provider::ClaudeCode => {...}, ... }
match provider_enum {
    Provider::Codex => { /* args from build_codex_args() */ },
    Provider::ClaudeCode => { /* --resume, --worktree, --settings */ },
    Provider::Droid => { /* XANOM_HOOK_SOCKET, --resume, --settings */ },
    Provider::OpenCode => { /* --session, XANOM_HOOK_SOCKET */ },
    Provider::Mlx => { panic!("MLX should not spawn via PTY") },
}
```

**Resume logic:**
- Claude: `--resume <id>` (lines 258–268), checks `~/.claude/projects/<encoded_path>/<id>.jsonl`
- Codex: `resume <id>` (lines 245–248), checks `~/.codex/sessions/YYYY/MM/DD/<uuid>.jsonl`
- Droid: `--resume <id>` (lines 333–349), checks `~/.factory/sessions/<cwd-hash>/<id>.jsonl` + stored pointer
- OpenCode: `--session <id>` (lines 412–419), reads from `~/.xanom/threads/<id>/opencode-session-id.txt`

**Pattern:** Centralized match statement. Each provider has:
- Session resume logic (optional)
- Model/effort injection (varies per provider)
- Hook environment variables (socket path, session ID)
- Per-thread state files (e.g., `~/.xanom/threads/<id>/droid-session-id.txt`)

**Status:** ✅ Single match arm per provider (easiest extension point, lines 244–434)

---

## 3. Binary Discovery / PATH Augmentation

**File:** `src-tauri/src/process/provider.rs:1-120`

```rust
// build_augmented_path() — lines 5–73
pub fn build_augmented_path() -> String {
    // Standard: /usr/local/bin, /opt/homebrew/bin, ~/.cargo/bin, ~/.bun/bin
    // NVM: ~/.nvm/versions/node/*/bin
    // fnm: ~/.fnm/node-versions/*/installation/bin
    // mise: ~/.local/share/mise/shims
}

// verify_cli_binary() — lines 76–104
pub async fn verify_cli_binary(binary_name: &str) -> anyhow::Result<String> {
    // Calls `<binary_name> --version`, 5-second timeout
    // Returns version string or error
}

// resolve_cli_path() — lines 106–117
pub fn resolve_cli_path(binary_name: &str) -> Option<PathBuf>
```

**How it works:**
1. `cli_binary_name()` method (lines 191–200 in models.rs) maps enum to binary name string
2. Spawn.rs calls `verify_cli_binary(binary_name)` at line 211 (5-second timeout, calls `--version`)
3. Failure is fatal — spawn aborts if binary not found

**New provider requirements:**
- Binary must be on PATH (or in augmented paths)
- Must respond to `--version` within 5 seconds
- Define `cli_binary_name()` return value (e.g., "grok")

**Status:** ✅ Unified PATH logic; provider-agnostic (shared by all)

---

## 4. Hook System Integration

**Structure:** `src-tauri/src/hooks/` (7 files: mod.rs, droid_settings.rs, droid_script.rs, opencode_plugin.rs, script.rs, etc.)

**Key flow:**
1. **Startup:** `hooks::setup()` (hooks/mod.rs:152–231) runs at app init
2. **Per-provider wiring:**
   - Claude: Hook script injected via `--settings` JSON (spawn.rs:279–291)
   - Droid: Hooks merged into `~/.factory/settings.json` (hooks/droid_settings.rs)
   - OpenCode: Plugin registered in `~/.opencode/opencode.json` (hooks/opencode_plugin.rs)
3. **Event routing:** Hook server listens on Unix socket `~/.xanom/hooks/xanom-hooks.sock`, routes events to frontend

**Claude-specific (lines 278–292 in spawn.rs):**
```rust
if let (Some(ref socket_path), Some(ref script_path)) = (&options.hook_socket_path, &options.hook_script_path) {
    if !script_path.is_empty() {
        cmd.env("XANOM_HOOK_SOCKET", socket_path);
        cmd.env("XANOM_SESSION_ID", thread_id);
        let settings_json = hooks::build_hook_settings_json(script_path, options.suppress_status_line);
        cmd.arg("--settings");
        cmd.arg(&settings_json);
    }
}
```

**Droid/OpenCode (env vars only, no CLI args):**
```rust
cmd.env("XANOM_HOOK_SOCKET", socket_path);
cmd.env("XANOM_SESSION_ID", thread_id);
cmd.env("XANOM_PROVIDER", "droid" or "opencode");
```

**Files to check:**
- `hooks/mod.rs:10` — public exports (`build_hook_settings_json`, `ensure_droid_hook_script`, `ensure_hook_script`)
- `hooks/script.rs` — Claude hook relay script template
- `hooks/droid_settings.rs` — Droid hook setup (merges into `~/.factory/settings.json`)
- `hooks/opencode_plugin.rs` — OpenCode plugin registration
- `hooks/droid_script.rs` — Droid event relay

**Status:** ⚠️ Provider-specific; no generic hook pattern. Claude/Droid/OpenCode have bespoke integrations.

---

## 5. Past Session Discovery / Import

**Claude sessions:** `src-tauri/src/process/spawn.rs:20–31` + commands/threads.rs
- Scans `~/.claude/projects/<encoded_path>/*.jsonl`
- Encoding: `encode_claude_project_path(work_dir)` — URL-encodes the full path
- Frontend lists via `listClaudeSessions(project_id)` command

**Codex sessions:** `src-tauri/src/process/spawn.rs:69–97`
- Scans `~/.codex/sessions/YYYY/MM/DD/*.jsonl` recursively
- Look for `codex_session_file_exists(session_id)` — checks nested date-stamped dirs

**Droid sessions:** `src-tauri/src/process/droid_model.rs`
- Reads `~/.xanom/threads/<thread_id>/droid-session-id.txt` (written by hook on each event)
- Verifies session file exists: `~/.factory/sessions/<cwd-hash>/<id>.jsonl`
- Fallback to latest model: `find_last_used_model_for_cwd(work_dir)` → scans `~/.factory/sessions/<cwd-hash>/`

**OpenCode sessions:** `src-tauri/src/hooks/mod.rs` + spawn.rs:411
- Reads `~/.xanom/threads/<thread_id>/opencode-session-id.txt`
- No fallback lookup (OpenCode TUI ignores unknown `--session` args)

**Frontend discovery:**
- `ClaudeSessionsList.tsx` + `ProjectGroup.tsx` — renders past sessions as resumable tree items
- Hook: `listClaudeSessions(projectId)` command in `commands/projects.rs`
- Data shape: `ClaudeSession` (types.ts): `{ id, cwd, name, created_at }`

**Status:** ⚠️ Per-provider, scattered across spawn.rs and droid_model.rs; no unified pattern.

---

## 6. Session Resume / Continuation

| Provider | Flag | Value |
|----------|------|-------|
| Claude | `--resume` | session_id (UUID) |
| Codex | `resume` (positional arg 1) | session_id (UUID) |
| Droid | `--resume` | session_id (UUID), source: `~/.xanom/threads/<thread_id>/droid-session-id.txt` |
| OpenCode | `--session` | session_id (string), source: `~/.xanom/threads/<thread_id>/opencode-session-id.txt` |
| MLX | (in-process, no spawn) | N/A |

**Defensive checks:**
- Claude (lines 258–268): Checks JSONL has real (non-meta) turns before passing `--resume`
- Codex (lines 114–122): Checks session file exists in `~/.codex/sessions/` tree
- Droid (lines 321–349): Checks both stored UUID and session file existence in cwd-specific dir
- OpenCode (lines 405–419): No check; OpenCode silently starts fresh if session unknown

**Status:** ✅ Flags vary per provider but pattern is clear (spawn.rs:244–434)

---

## 7. Frontend Provider Selection UI

**Component:** `src/components/sidebar/NewThreadDialog.tsx` (main)  
**Supporting files:**
- `src/components/thread/ProviderModelDropdown.tsx` — model selection per provider
- `src/components/thread/AgentAvatar.tsx` — provider icons
- `src/components/sidebar/SettingsDialog.tsx` — provider settings/auth

**Provider list UI (NewThreadDialog.tsx):**
```typescript
// Icons imported from assets/:
import claudeIcon from "../../assets/claude-ai-icon.svg";
import chatgptIcon from "../../assets/chatgpt-icon.svg";
import droidIcon from "../../assets/droid-icon.svg";
import opencodeIcon from "../../assets/opencode-icon.png";

// Rendered as radio/button group to select provider
```

**Provider icon mapping (ProviderModelDropdown.tsx:61–67):**
```typescript
const PROVIDER_ICON_SRC: Record<Provider, string> = {
  ClaudeCode: claudeIcon,
  Codex: chatgptIcon,
  Droid: droidIcon,
  OpenCode: opencodeIcon,
  MLX: appleIcon,
};
```

**Status:** ✅ Icon map and component props are provider-aware; easy to add (add icon asset + entry in map)

---

## 8. Settings / Per-Provider Config

**Files:**
- `src/components/settings/LocalModelsPanel.tsx` — MLX local models
- `src/components/settings/OpenCodeAuthPanel.tsx` — OpenCode API key auth
- `src/components/sidebar/SettingsDialog.tsx` — general settings with provider-specific sections

**SettingsDialog.tsx structure:**
- `UsageProvidersConfig` type tracks per-provider settings
- `patchProvider(id, patch)` updates provider-specific config
- Provider list in store: `useSettingsStore((s) => s.providers)`

**Config shape (from settingsStore):**
```typescript
providers: {
  claude: { /* auth, install path, etc. */ },
  codex: { /* model, reasoning effort */ },
  droid: { /* settings */ },
  opencode: { /* API key, auth state */ },
  // ...
}
```

**Status:** ⚠️ Provider settings are per-component (OpenCodeAuthPanel, LocalModelsPanel); no unified settings panel pattern.

---

## 9. Models List Per Provider

**Hardcoded defaults:**

| Provider | Location | Constants |
|----------|----------|-----------|
| Claude | `src/lib/types.ts:386–395` | `CLAUDE_MODELS[]` + `CLAUDE_SUBMENU_MODELS[]` in ProviderModelDropdown.tsx |
| Codex | `src/lib/types.ts:368–372` | `CODEX_MODELS[]` |
| Droid | None (inferred from interaction_mode) | Droid has no model selection in UI |
| OpenCode | `ProviderModelDropdown.tsx:193–203` | `OPENCODE_SUBMENU_MODELS[]` + dynamic from bridge |
| MLX | `src/lib/mlx.ts` | Dynamic discovery from LM Studio, HuggingFace, or Xanom-managed |

**Claude example:**
```typescript
export const CLAUDE_MODELS: ClaudeModelOption[] = [
  { slug: "opus[1m]", name: "Opus 4.7 (1M)" },
  { slug: "claude-opus-4-6", name: "Opus 4.6" },
  // ...
];

const CLAUDE_SUBMENU_MODELS: { slug: string; label: string; meta: string; tag?: "Rec" }[] = [
  { slug: "opus[1m]", label: "Claude Opus 4.7", meta: "1M context · best for planning" },
  // ...
];
```

**Dynamic models (Codex, OpenCode):**
- Codex: `codexModels?: CodexModelOption[]` prop passed to ProviderModelDropdown
- OpenCode: Fetched from SDK bridge (`useOpenCodeBridge().models`)

**Status:** ✅ Hardcoded lists in types.ts + ProviderModelDropdown.tsx (easy to extend)

---

## 10. SDK Sidecar Integration

**Files:**
- `sidecar/claude-sdk-bridge.bundle.mjs` — Claude SDK sidecar (Node.js)
- `sidecar/opencode-sdk-bridge.bundle.mjs` — OpenCode SDK sidecar
- `src-tauri/src/commands/claude_sdk.rs` — Rust ↔ sidecar JSON-RPC
- `src-tauri/src/commands/opencode_sdk.rs` — OpenCode sidecar management

**JSON-RPC contract (both sidecars):**
- Stdin/stdout communication with spawned Node.js process
- Messages are newline-delimited JSON
- Bidirectional: Rust sends commands, sidecar emits events

**Example (claude_sdk.rs):**
```rust
// Commands to sidecar: create_session, message, tool_use_result, list_models, etc.
// Events from sidecar: emitted as `sdk-event-{threadId}` to frontend
// Session context: Arc<Mutex<HashMap<String, SdkSessionContext>>>
```

**Contract shape:**
- Rust → Sidecar: `{"jsonrpc":"2.0","method":"...","params":{...},"id":N}`
- Sidecar → Rust: `{"jsonrpc":"2.0","result":{...},"id":N}` or events via `app_handle.emit()`

**New provider sidecar requirements:**
- Must communicate via JSON-RPC over stdin/stdout
- Must emit session events compatible with frontend event listeners
- Build: `sidecar/build.mjs` bundles via esbuild

**Status:** ⚠️ Each sidecar (Claude, OpenCode) is bespoke; no generic pattern. Grok would need its own bridge.

---

## 11. App Server / JSON-RPC Clients in Rust

**Codex example:** `src-tauri/src/codex/app_server.rs`

```rust
// CodexServerManager — manages one JSON-RPC server per workspace
struct CodexServerManager {
    servers: Arc<Mutex<HashMap<String, CodexServer>>>,
}

// Commands in src-tauri/src/commands/codex.rs:
// - codex_ensure_server(workspaceId)
// - codex_message(sessionId, prompt, model, etc.)
// - codex_list_models(workspaceId)
```

**Communication pattern:**
- Rust spawns child process (Codex App Server)
- Exchanges JSON-RPC over stdin/stdout
- Session state tracked in `AppState.codex_servers: Arc<Mutex<CodexServerManager>>`
- Events emitted as `codex-event` to frontend

**Status:** ⚠️ Codex has bespoke AppServer impl; no shared pattern. Grok would need similar if it's an app-server model.

---

## 12. Database Migrations

**Location:** `src-tauri/migrations/`

**Provider-related migrations:**
| File | Purpose |
|------|---------|
| 001_initial.sql | Create `threads` table with `provider` column (TEXT) |
| 003_codex_thread_settings.sql | Add Codex-specific columns |
| 009_ollama_provider.sql | Added OLLAMA provider (later removed) |
| 014_droid_provider.sql | Add Droid support |
| 015_opencode_provider.sql | Add OpenCode support + `opencode_session_id` column |
| 021_mlx_provider.sql | Add MLX support |

**Pattern:** New columns added as migrations (e.g., `opencode_session_id` in 015).

**Adding a new provider:**
1. Add column(s) if needed (e.g., `grok_session_id TEXT`)
2. Add migration: `NNN_grok_provider.sql`
3. Update `Thread` struct in models.rs
4. Update tests

**Status:** ✅ Migrations are sequential; pattern is clear.

---

## 13. Agent Logs / Usage Tracking

**Tables:**
- `agent_logs` — per-turn logs
- `session_usage` — aggregate tokens/costs per thread

**Files:**
- `src-tauri/migrations/005_agent_logs_index_and_prune.sql` — agent_logs schema
- `src-tauri/migrations/007_session_usage.sql` — session_usage schema
- `src-tauri/src/commands/usage_stats.rs` — commands to fetch usage
- `src/stores/usageQuotaStore.ts` — frontend usage display

**Writes to `session_usage`:**
- Provider (string, e.g., "ClaudeCode")
- Thread ID
- Input tokens, output tokens, cached input tokens
- Created/updated timestamps

**Status:** ✅ Provider-agnostic table design; writes keyed by provider string.

---

## 14. AGENTS.md / CLAUDE.md / Project Instruction File Discovery

**File:** `src-tauri/src/ael/living_spec.rs:80–127`

```rust
// write_living_spec() creates XANOM.md in project root
// CLAUDE.md and AGENTS.md are symlinks to XANOM.md
// Same file is read by all providers (no provider-specific override)
```

**Discovery:**
1. On project init, scan for existing `XANOM.md`, `CLAUDE.md`, or `AGENTS.md`
2. If found, consolidate into `XANOM.md`
3. Create symlinks: `CLAUDE.md → XANOM.md`, `AGENTS.md → XANOM.md`

**Exclusion (gitignore):**
- `src-tauri/src/commands/task.rs:262–263` — exclude CLAUDE.md, AGENTS.md, XANOM.md from task scanning

**Status:** ✅ Provider-agnostic; all providers read the same file (no per-provider variants).

---

## Summary: Extension Checklist for New Provider

| Area | File(s) | Pattern | Effort |
|------|---------|---------|--------|
| 1. Enum | `src-tauri/src/db/models.rs:16–20` + `src/lib/types.ts:9` | Add variant + as_str/from_str + TypeScript | 🟢 Easy (2 files) |
| 2. Spawn | `src-tauri/src/process/spawn.rs:244–434` | Add match arm with resume/args logic | 🟢 Easy (1 match block) |
| 3. Binary discovery | `src-tauri/src/process/provider.rs` | Shared; add cli_binary_name() entry + test | 🟡 Medium (models.rs) |
| 4. Hooks | `src-tauri/src/hooks/` | If needed, new file like hooks/grok_*.rs | 🔴 Hard (provider-specific) |
| 5. Session discovery | `src-tauri/src/process/spawn.rs` | Add session check function | 🟡 Medium |
| 6. Resume | `src-tauri/src/process/spawn.rs:244–434` | Integrated in spawn match | 🟢 Easy |
| 7. Frontend UI | `src/components/sidebar/NewThreadDialog.tsx` | Add icon asset + ProviderModelDropdown entry | 🟢 Easy (icon + type) |
| 8. Settings | `src/components/settings/` | New panel component if needed | 🟡 Medium |
| 9. Models | `src/lib/types.ts` + `ProviderModelDropdown.tsx` | Add constants + submenu | 🟢 Easy |
| 10. Sidecar | `sidecar/` | Only if bridge needed (JSON-RPC) | 🔴 Hard |
| 11. App server | `src-tauri/src/` | Only if app-server model (codex-style) | 🔴 Hard |
| 12. Migrations | `src-tauri/migrations/` | Add if new columns needed | 🟡 Medium |
| 13. Usage tracking | `session_usage` table | Automatic (provider string key) | 🟢 Easy |
| 14. Project instructions | `ael/living_spec.rs` | No change (provider-agnostic) | 🟢 Easy |

**Critical path (minimum viable):** Areas 1–3, 6–7, 9 ≈ **1 day**  
**Full integration (with hooks):** Add areas 4–5, 8, 12 ≈ **2–3 days**

