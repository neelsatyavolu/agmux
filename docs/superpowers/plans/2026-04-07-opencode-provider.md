# OpenCode Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenCode (https://opencode.ai) as a 4th first-class agent provider in Xanom — terminal-only PTY, DirectRepo work mode, with full session-state fidelity (processing spinner, auto-open on edit, top bar, IDE mode wiring) via OpenCode's plugin system relayed over Xanom's existing Unix hook socket.

**Architecture:** Spawn `opencode` as a PTY (mirroring the Droid integration). On app startup, write a JS plugin file to `~/.xanom/opencode-plugins/xanom-relay.js` and register it in `~/.opencode/opencode.json`. The plugin is session-gated by `XANOM_SESSION_ID` and relays a curated set of OpenCode bus events to Xanom's existing Unix hook socket as the same JSON envelope Droid uses. Frontend extends the existing Droid branch in `ThreadView.tsx` to cover OpenCode, reusing `ThreadTopBar` and `TerminalView` verbatim for byte-identical UX.

**Tech Stack:** Rust (Tauri v2), TypeScript/React 19, OpenCode plugin API (`@opencode-ai/plugin`), Unix domain sockets, portable-pty.

**Spec:** `docs/superpowers/specs/2026-04-07-opencode-provider-design.md`

---

## File Manifest

### New files
- `src-tauri/src/hooks/opencode_plugin.rs` — relay script writer + opencode.json registrar (with co-located unit tests)

### Modified files
- `src-tauri/src/db/models.rs` — add `Provider::OpenCode` enum variant
- `src-tauri/src/process/spawn.rs` — add `Provider::OpenCode` match arm with env vars
- `src-tauri/src/hooks/mod.rs` — module declaration + re-exports
- `src-tauri/src/lib.rs` — call `ensure_opencode_*` at startup
- `src/lib/types.ts` — add `OpenCode` to `Provider` union; add `isTerminalOnlyProvider` helper
- `src/components/sidebar/NewThreadDialog.tsx` — add 4th provider button + DirectRepo guards
- `src/components/thread/ThreadView.tsx` — extend Droid branch to cover OpenCode + local renames
- `CLAUDE.md` — add OpenCode to the provider mention

### Runtime artifacts (written by the app, not checked in)
- `~/.xanom/opencode-plugins/xanom-relay.js` — JS plugin written on startup
- `~/.opencode/opencode.json` — global OpenCode config, modified to include the plugin

---

## Task 1: Add `Provider::OpenCode` enum variant

**Files:**
- Modify: `src-tauri/src/db/models.rs:122-156`

- [ ] **Step 1: Read the current Provider enum**

Use Read tool on `src-tauri/src/db/models.rs` lines 115-160 to confirm the exact form before editing.

- [ ] **Step 2: Add `OpenCode` to the enum**

Edit `src-tauri/src/db/models.rs`:

```rust
// Enums for type safety in Rust code (not stored directly -- converted to/from strings)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Provider {
    ClaudeCode,
    Codex,
    Droid,
    OpenCode,
}
```

- [ ] **Step 3: Update `as_str()` to handle the new variant**

```rust
pub fn as_str(&self) -> &'static str {
    match self {
        Provider::ClaudeCode => "ClaudeCode",
        Provider::Codex => "Codex",
        Provider::Droid => "Droid",
        Provider::OpenCode => "OpenCode",
    }
}
```

- [ ] **Step 4: Update `from_str()` to parse the new variant**

```rust
pub fn from_str(s: &str) -> anyhow::Result<Self> {
    match s {
        "ClaudeCode" => Ok(Provider::ClaudeCode),
        "Codex" => Ok(Provider::Codex),
        "Droid" => Ok(Provider::Droid),
        "OpenCode" => Ok(Provider::OpenCode),
        _ => anyhow::bail!("Unknown provider: {}", s),
    }
}
```

- [ ] **Step 5: Update `cli_binary_name()` to return `"opencode"`**

```rust
pub fn cli_binary_name(&self) -> &'static str {
    match self {
        Provider::ClaudeCode => "claude",
        Provider::Codex => "codex",
        Provider::Droid => "droid",
        Provider::OpenCode => "opencode",
    }
}
```

- [ ] **Step 6: Compile-check**

Run: `cd src-tauri && cargo check 2>&1 | tail -40`
Expected: Compiles cleanly. Any non-exhaustive match warnings on `Provider` from other modules will surface here — these are the call sites we'll touch in later tasks (e.g. `spawn.rs`). They're expected. If there are errors **other than** non-exhaustive match warnings on `Provider`, stop and investigate.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/db/models.rs
git commit -m "feat(provider): add OpenCode enum variant"
```

---

## Task 2: Add `OpenCode` to TypeScript `Provider` union

**Files:**
- Modify: `src/lib/types.ts:9`

- [ ] **Step 1: Update the Provider union type**

Edit `src/lib/types.ts`:

```ts
export type Provider = "ClaudeCode" | "Codex" | "Droid" | "OpenCode";
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit 2>&1 | tail -40`
Expected: Will surface every call site that switches on `Provider` exhaustively (likely in `NewThreadDialog`, `ThreadView`, `Sidebar`, `ProjectGroup`). These are the call sites we'll touch in Tasks 8-9. If there are unexpected errors in unrelated files, stop and investigate.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(provider): add OpenCode to Provider TypeScript union"
```

---

## Task 3: Create `opencode_plugin.rs` with relay script writer

**Files:**
- Create: `src-tauri/src/hooks/opencode_plugin.rs`
- Modify: `src-tauri/src/hooks/mod.rs:1-7`

This task creates the function that writes the JS relay plugin to disk. We follow the `droid_settings.rs` pattern of splitting into a high-level function (`ensure_opencode_relay_script`) and a path-explicit variant (`ensure_opencode_relay_script_at`) so unit tests can use temp dirs without racing on `HOME`.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/hooks/opencode_plugin.rs` with a stub and a test:

```rust
use std::fs;
use std::path::{Path, PathBuf};

/// Returns the path to the JS relay plugin Xanom writes for OpenCode.
/// The plugin is loaded by OpenCode's config system and forwards a curated
/// set of bus events to Xanom's Unix hook socket.
pub fn opencode_relay_script_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".xanom").join("opencode-plugins").join("xanom-relay.js"))
}

/// Ensure the OpenCode relay plugin exists at `~/.xanom/opencode-plugins/xanom-relay.js`.
/// Returns the path to the script. Idempotent: rewrites only if content has drifted.
pub fn ensure_opencode_relay_script() -> Result<PathBuf, String> {
    let path = opencode_relay_script_path()?;
    ensure_opencode_relay_script_at(&path)?;
    Ok(path)
}

/// Same as `ensure_opencode_relay_script` but takes an explicit path. Exposed
/// for tests so they can write to temp dirs without mutating `HOME`.
pub fn ensure_opencode_relay_script_at(path: &Path) -> Result<(), String> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn writes_relay_script_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("plugins").join("xanom-relay.js");

        ensure_opencode_relay_script_at(&path).unwrap();

        assert!(path.exists(), "relay script was not created");
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("XANOM_SESSION_ID"), "relay script must check session env var");
        assert!(content.contains("XANOM_HOOK_SOCKET"), "relay script must read socket path");
        assert!(content.contains("node:net"), "relay script must use node:net for Unix socket");
    }

    #[test]
    fn rewrite_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("plugins").join("xanom-relay.js");

        ensure_opencode_relay_script_at(&path).unwrap();
        let mtime1 = fs::metadata(&path).unwrap().modified().unwrap();

        // Sleep briefly so any rewrite would change mtime.
        std::thread::sleep(std::time::Duration::from_millis(10));
        ensure_opencode_relay_script_at(&path).unwrap();
        let mtime2 = fs::metadata(&path).unwrap().modified().unwrap();

        assert_eq!(mtime1, mtime2, "second call must not rewrite the file");
    }

    #[test]
    fn rewrite_when_content_drifted() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("plugins").join("xanom-relay.js");

        // Write a stale version
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "// stale content").unwrap();

        ensure_opencode_relay_script_at(&path).unwrap();
        let content = fs::read_to_string(&path).unwrap();
        assert!(!content.contains("stale"), "stale content must be replaced");
        assert!(content.contains("XANOM_SESSION_ID"));
    }
}
```

Add the module declaration to `src-tauri/src/hooks/mod.rs` (top of file, alongside the other `mod` lines):

```rust
mod droid_script;
mod droid_settings;
mod opencode_plugin;
mod script;
pub use droid_script::ensure_droid_hook_script;
pub use droid_settings::ensure_droid_hooks_merged;
pub use opencode_plugin::ensure_opencode_relay_script;
pub use script::{build_hook_settings_json, ensure_hook_script};
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib hooks::opencode_plugin 2>&1 | tail -40`
Expected: Three test failures with `not yet implemented` panics (from `todo!()`).

If `tempfile` is not yet a dev-dependency, add it to `src-tauri/Cargo.toml` under `[dev-dependencies]`:
```toml
[dev-dependencies]
tempfile = "3"
```
Then re-run.

- [ ] **Step 3: Implement `ensure_opencode_relay_script_at`**

Replace the `todo!()` body in `src-tauri/src/hooks/opencode_plugin.rs`:

```rust
pub fn ensure_opencode_relay_script_at(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create opencode plugin dir: {}", e))?;
    }

    let needs_write = match fs::read_to_string(path) {
        Ok(existing) => existing != RELAY_SCRIPT,
        Err(_) => true,
    };

    if needs_write {
        fs::write(path, RELAY_SCRIPT)
            .map_err(|e| format!("Failed to write opencode relay script: {}", e))?;
    }

    Ok(())
}

/// JS plugin source. Loaded by OpenCode's Bun runtime via the `plugin` array
/// in opencode.json. Session-gated by XANOM_SESSION_ID — a no-op when the user
/// runs `opencode` outside Xanom.
///
/// The event mapping below uses placeholder OpenCode bus event names. The
/// actual names are confirmed in Task 6 (manual smoke test) and finalized
/// before shipping. The plugin filters to a small whitelist to avoid socket
/// spam from OpenCode's full bus firehose (LSP, file watcher, MCP, etc.).
const RELAY_SCRIPT: &str = r#"// xanom-relay.js — written by Xanom. Do not edit by hand.
// Forwards a curated set of OpenCode bus events to Xanom's Unix hook socket.
// Session-gated: only relays when XANOM_SESSION_ID is set, so running `opencode`
// outside Xanom is a no-op.

import net from "node:net";

const SOCKET = process.env.XANOM_HOOK_SOCKET;
const SESSION = process.env.XANOM_SESSION_ID;

// Map OpenCode bus event types → the 5 canonical events Xanom's hook handler
// understands (matching the Droid relay envelope).
const EVENT_MAP = {
  "session.message.user":   "prompt-submit",
  "session.tool.start":     "pre-tool-use",
  "session.idle":           "stop",
  "session.notification":   "notification",
  "session.deleted":        "session-end",
};

function send(eventType, payload) {
  if (!SOCKET || !SESSION) return;
  const msg = JSON.stringify({
    event: eventType,
    session_id: SESSION,
    provider: "opencode",
    payload,
  }) + "\n";
  try {
    const sock = net.createConnection(SOCKET);
    sock.on("error", () => {}); // swallow — Xanom may not be running
    sock.on("connect", () => { sock.write(msg); sock.end(); });
  } catch (_) {
    // never throw out of an event hook
  }
}

export default async function xanomRelay() {
  return {
    event: async ({ event }) => {
      if (!SESSION) return;
      const mapped = EVENT_MAP[event && event.type];
      if (!mapped) return;
      send(mapped, (event && event.properties) || {});
    },
  };
}
"#;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib hooks::opencode_plugin 2>&1 | tail -40`
Expected: All three tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/hooks/opencode_plugin.rs src-tauri/src/hooks/mod.rs src-tauri/Cargo.toml
git commit -m "feat(opencode): add relay plugin script writer"
```

---

## Task 4: Add `ensure_opencode_plugin_registered` for opencode.json

**Files:**
- Modify: `src-tauri/src/hooks/opencode_plugin.rs`
- Modify: `src-tauri/src/hooks/mod.rs` (add re-export)

This task adds the function that reads/writes `~/.opencode/opencode.json` to register the relay plugin. Follows the `droid_settings.rs` pattern of preserving every other key in the file and only mutating the `plugin` array.

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/hooks/opencode_plugin.rs` (inside the existing `mod tests`):

```rust
    #[test]
    fn registers_when_config_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join(".opencode").join("opencode.json");
        let plugin_path = tmp.path().join("plugins").join("xanom-relay.js");

        ensure_opencode_plugin_registered_at(&config_path, &plugin_path).unwrap();

        assert!(config_path.exists(), "config file must be created");
        let content = fs::read_to_string(&config_path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        let plugins = parsed.get("plugin").and_then(|v| v.as_array()).expect("plugin must be array");
        assert_eq!(plugins.len(), 1);
        let entry = plugins[0].as_str().unwrap();
        assert!(entry.starts_with("file://"), "entry must be a file:// URL");
        assert!(entry.ends_with("xanom-relay.js"), "entry must point at the relay script");
    }

    #[test]
    fn registers_when_config_has_no_plugin_field() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("opencode.json");
        let plugin_path = tmp.path().join("xanom-relay.js");

        // Pre-existing config with other settings but no `plugin` field.
        fs::write(&config_path, r#"{"theme":"dark","autoupdate":true}"#).unwrap();

        ensure_opencode_plugin_registered_at(&config_path, &plugin_path).unwrap();

        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
        // Existing keys preserved.
        assert_eq!(parsed.get("theme").and_then(|v| v.as_str()), Some("dark"));
        assert_eq!(parsed.get("autoupdate").and_then(|v| v.as_bool()), Some(true));
        // Plugin field added.
        let plugins = parsed.get("plugin").and_then(|v| v.as_array()).unwrap();
        assert_eq!(plugins.len(), 1);
    }

    #[test]
    fn idempotent_when_already_registered() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("opencode.json");
        let plugin_path = tmp.path().join("xanom-relay.js");

        ensure_opencode_plugin_registered_at(&config_path, &plugin_path).unwrap();
        let content1 = fs::read_to_string(&config_path).unwrap();

        ensure_opencode_plugin_registered_at(&config_path, &plugin_path).unwrap();
        let content2 = fs::read_to_string(&config_path).unwrap();

        assert_eq!(content1, content2, "second call must produce identical content");

        let parsed: serde_json::Value = serde_json::from_str(&content2).unwrap();
        let plugins = parsed.get("plugin").and_then(|v| v.as_array()).unwrap();
        assert_eq!(plugins.len(), 1, "plugin must not be duplicated");
    }

    #[test]
    fn preserves_other_plugins() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("opencode.json");
        let plugin_path = tmp.path().join("xanom-relay.js");

        // Pre-existing config with another plugin already registered.
        fs::write(
            &config_path,
            r#"{"plugin":["oh-my-opencode@1.2.3","file:///foo/bar.js"]}"#,
        )
        .unwrap();

        ensure_opencode_plugin_registered_at(&config_path, &plugin_path).unwrap();

        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
        let plugins = parsed.get("plugin").and_then(|v| v.as_array()).unwrap();
        assert_eq!(plugins.len(), 3, "must keep both existing plugins and append ours");
        let entries: Vec<&str> = plugins.iter().filter_map(|v| v.as_str()).collect();
        assert!(entries.contains(&"oh-my-opencode@1.2.3"));
        assert!(entries.contains(&"file:///foo/bar.js"));
        assert!(entries.iter().any(|e| e.ends_with("xanom-relay.js")));
    }
```

Add stub function declarations near the top of `opencode_plugin.rs` (before the `#[cfg(test)]` block):

```rust
/// Returns the path to the user's global OpenCode config file.
pub fn opencode_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".opencode").join("opencode.json"))
}

/// Ensure the global `~/.opencode/opencode.json` registers Xanom's relay
/// plugin in its `plugin` array. Preserves every other key in the file and
/// every other plugin entry. Idempotent.
pub fn ensure_opencode_plugin_registered() -> Result<(), String> {
    let config_path = opencode_config_path()?;
    let plugin_path = opencode_relay_script_path()?;
    ensure_opencode_plugin_registered_at(&config_path, &plugin_path)
}

/// Same as `ensure_opencode_plugin_registered` but takes explicit paths.
/// Exposed for tests so they can use temp dirs without mutating `HOME`.
pub fn ensure_opencode_plugin_registered_at(
    config_path: &Path,
    plugin_path: &Path,
) -> Result<(), String> {
    todo!()
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib hooks::opencode_plugin 2>&1 | tail -50`
Expected: Four new tests fail with `not yet implemented` panics. The three tests from Task 3 still pass.

- [ ] **Step 3: Implement `ensure_opencode_plugin_registered_at`**

Replace the `todo!()` in `opencode_plugin.rs`:

```rust
pub fn ensure_opencode_plugin_registered_at(
    config_path: &Path,
    plugin_path: &Path,
) -> Result<(), String> {
    use serde_json::{json, Value};

    // Build the file:// URL for the plugin entry.
    let plugin_url = format!("file://{}", plugin_path.display());

    // Ensure parent dir exists. ~/.opencode may not exist if the user has
    // never run opencode.
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create opencode config dir: {}", e))?;
    }

    // Read existing config, or start from an empty JSON object. Tolerate
    // a missing file but propagate parse errors so we don't silently clobber
    // a config the user is editing.
    let mut config: Value = match fs::read_to_string(config_path) {
        Ok(s) if s.trim().is_empty() => json!({}),
        Ok(s) => serde_json::from_str(&s)
            .map_err(|e| format!("Failed to parse opencode.json: {}", e))?,
        Err(_) => json!({}),
    };

    // Ensure root is an object — if it's an array or scalar, that's a config
    // we don't understand and we shouldn't touch it.
    let obj = config
        .as_object_mut()
        .ok_or("opencode.json root must be a JSON object")?;

    // Ensure `plugin` is an array. If absent or null, create an empty one.
    // If present but not an array, refuse to mutate.
    let plugins = match obj.get_mut("plugin") {
        None => {
            obj.insert("plugin".to_string(), json!([]));
            obj.get_mut("plugin").unwrap().as_array_mut().unwrap()
        }
        Some(v) if v.is_null() => {
            *v = json!([]);
            v.as_array_mut().unwrap()
        }
        Some(v) => v
            .as_array_mut()
            .ok_or("opencode.json `plugin` field must be an array")?,
    };

    // Check if our entry is already present (compare by file:// URL).
    let already_present = plugins.iter().any(|entry| {
        entry
            .as_str()
            .map(|s| s == plugin_url)
            .unwrap_or(false)
    });

    if !already_present {
        plugins.push(json!(plugin_url));
    } else {
        // Idempotent — no write needed.
        return Ok(());
    }

    // Serialize with two-space indent and write atomically.
    let serialized = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize opencode.json: {}", e))?;
    fs::write(config_path, serialized + "\n")
        .map_err(|e| format!("Failed to write opencode.json: {}", e))?;

    Ok(())
}
```

Add the re-export to `src-tauri/src/hooks/mod.rs`:

```rust
pub use opencode_plugin::{ensure_opencode_plugin_registered, ensure_opencode_relay_script};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib hooks::opencode_plugin 2>&1 | tail -50`
Expected: All seven tests pass (three from Task 3 + four from Task 4).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/hooks/opencode_plugin.rs src-tauri/src/hooks/mod.rs
git commit -m "feat(opencode): register relay plugin in opencode.json"
```

---

## Task 5: Wire `opencode_plugin` into `lib.rs` startup

**Files:**
- Modify: `src-tauri/src/lib.rs:88-114` (the setup callback)

- [ ] **Step 1: Read the existing setup block**

Use Read tool on `src-tauri/src/lib.rs` lines 80-130 to see the exact context around the existing `ensure_droid_hook_script` and `ensure_droid_hooks_merged` calls.

- [ ] **Step 2: Add the OpenCode startup calls**

In the setup callback, after the existing `ensure_droid_hooks_merged(...)` call, add the equivalent for OpenCode. Match the existing error-logging pattern (warn-and-continue, never block startup):

```rust
// OpenCode integration: write the relay plugin and register it in
// ~/.opencode/opencode.json. Both are no-ops if already up to date.
// Failures are logged but don't block startup — OpenCode is optional.
match hooks::ensure_opencode_relay_script() {
    Ok(plugin_path) => {
        if let Err(e) = hooks::ensure_opencode_plugin_registered() {
            tracing::warn!(
                "Failed to register OpenCode relay plugin in opencode.json: {} \
                 — OpenCode threads will not receive events",
                e
            );
        } else {
            tracing::info!(
                "OpenCode relay plugin registered at {}",
                plugin_path.display()
            );
        }
    }
    Err(e) => {
        tracing::warn!(
            "Failed to write OpenCode relay plugin: {} \
             — OpenCode threads will not receive events",
            e
        );
    }
}
```

- [ ] **Step 3: Compile-check**

Run: `cd src-tauri && cargo check 2>&1 | tail -20`
Expected: Compiles cleanly (still warning about non-exhaustive `Provider` matches in `spawn.rs` — that's Task 6).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(opencode): wire plugin writer into startup"
```

---

## Task 6: Add `Provider::OpenCode` arm in `spawn.rs`

**Files:**
- Modify: `src-tauri/src/process/spawn.rs:144` (after the existing Droid arm)

- [ ] **Step 1: Read the existing Droid arm**

Use Read tool on `src-tauri/src/process/spawn.rs` lines 140-200 to confirm the exact form before editing. The Droid arm sets three env vars (`XANOM_HOOK_SOCKET`, `XANOM_SESSION_ID`, `XANOM_PROVIDER`) and writes a `--settings` file for model inheritance.

- [ ] **Step 2: Add the OpenCode arm**

Inside the `match provider_enum { ... }` block, add a new arm right after `Provider::Droid => { ... }`:

```rust
Provider::OpenCode => {
    // The relay plugin is registered in the user's global ~/.opencode/opencode.json
    // at app startup (see hooks::opencode_plugin). The plugin is session-gated
    // by XANOM_SESSION_ID — when the user runs `opencode` manually outside
    // Xanom, the env var is unset and the plugin's event handler short-circuits.
    if let Some(ref socket_path) = options.hook_socket_path {
        cmd.env("XANOM_HOOK_SOCKET", socket_path);
    }
    cmd.env("XANOM_SESSION_ID", thread_id);
    cmd.env("XANOM_PROVIDER", "opencode");
    // No --settings flag, no model lookup — defer to opencode's built-in
    // /models picker. Worktree work mode is not supported in v1; the
    // frontend forces DirectRepo for OpenCode threads.
}
```

- [ ] **Step 3: Compile-check**

Run: `cd src-tauri && cargo check 2>&1 | tail -20`
Expected: Compiles cleanly with no warnings.

- [ ] **Step 4: Build the full app to confirm**

Run: `cd src-tauri && cargo build 2>&1 | tail -10`
Expected: Successful build.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/process/spawn.rs
git commit -m "feat(opencode): add PTY spawn arm with hook env vars"
```

---

## Task 7: Add `isTerminalOnlyProvider` helper to `types.ts`

**Files:**
- Modify: `src/lib/types.ts` (after the `Provider` type, before `Thread`)

- [ ] **Step 1: Add the helper**

Edit `src/lib/types.ts`. After the line `export type Provider = "ClaudeCode" | "Codex" | "Droid" | "OpenCode";`, add:

```ts
/**
 * Providers that ship a TUI and have no structured chat view in Xanom.
 * These providers always render via TerminalView with the Claude-style
 * top bar and force `DirectRepo` work mode.
 */
export function isTerminalOnlyProvider(p: Provider): boolean {
  return p === "ClaudeCode" || p === "Droid" || p === "OpenCode";
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit 2>&1 | tail -30`
Expected: No new errors. Pre-existing exhaustive-switch errors from Task 2 still present (they'll be fixed in Tasks 8-9).

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "refactor(types): add isTerminalOnlyProvider helper"
```

---

## Task 8: Add OpenCode provider button to `NewThreadDialog`

**Files:**
- Modify: `src/components/sidebar/NewThreadDialog.tsx:60-170`

- [ ] **Step 1: Read the current NewThreadDialog provider section**

Use Read tool on `src/components/sidebar/NewThreadDialog.tsx` lines 60-170 to see the exact form of the provider buttons and the existing `provider === "Droid"` guards.

- [ ] **Step 2: Update the workMode/baseBranch/worktreeRoot guards**

The existing code at `src/components/sidebar/NewThreadDialog.tsx:65-74` forces `DirectRepo` only when `provider === "Droid"`, leaving Claude/Codex on `Worktree`. Broaden the predicate to include OpenCode.

**Do NOT use `isTerminalOnlyProvider` here** — that helper includes ClaudeCode (for top-bar parity in `ThreadView`), but ClaudeCode supports Worktree mode and must keep it. Use a local `forceDirectRepo` predicate instead.

Find (lines 65-74):

```ts
// Droid is terminal-only and has no worktree integration — create as DirectRepo
// regardless of what this dialog is doing for Claude/Codex.
const workMode = provider === "Droid" ? "DirectRepo" : "Worktree";
const thread = await addThread({
  projectId,
  name: generateThreadName(),
  provider,
  workMode,
  baseBranch: provider === "Droid" ? undefined : baseBranch || undefined,
  worktreeRoot: provider === "Droid" ? undefined : worktreeRoot || undefined,
});
```

Replace with:

```ts
// Droid and OpenCode are terminal-only and have no worktree integration —
// create as DirectRepo regardless of what this dialog is doing for Claude/Codex.
const forceDirectRepo = provider === "Droid" || provider === "OpenCode";
const workMode = forceDirectRepo ? "DirectRepo" : "Worktree";
const thread = await addThread({
  projectId,
  name: generateThreadName(),
  provider,
  workMode,
  baseBranch: forceDirectRepo ? undefined : baseBranch || undefined,
  worktreeRoot: forceDirectRepo ? undefined : worktreeRoot || undefined,
});
```

No new imports needed — `Provider` is already in scope via the existing store types.

- [ ] **Step 3: Add the OpenCode provider button**

Find the existing three provider buttons (around lines 125-160). Add a fourth button after the Droid button, using cyan as the brand color (visually distinct from ClaudeCode blue, Codex green, Droid purple):

```tsx
<button
  type="button"
  onClick={() => setProvider("OpenCode")}
  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-all ${
    provider === "OpenCode"
      ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-400 shadow-sm shadow-cyan-500/10"
      : "border-white/[0.06] bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200"
  }`}
>
  OpenCode
</button>
```

- [ ] **Step 4: Update the branch picker visibility**

Find the existing condition that hides the branch picker:

```tsx
{/* Branch selection — hidden for Droid (terminal-only, no worktree) */}
{isGitRepo && provider !== "Droid" && (
```

Replace with:

```tsx
{/* Branch selection — hidden for Droid and OpenCode (terminal-only, no worktree) */}
{isGitRepo && provider !== "Droid" && provider !== "OpenCode" && (
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit 2>&1 | tail -30`
Expected: No errors in `NewThreadDialog.tsx`. Errors in `ThreadView.tsx` (exhaustive switch on `Provider`) still present — those are Task 9.

- [ ] **Step 6: Commit**

```bash
git add src/components/sidebar/NewThreadDialog.tsx
git commit -m "feat(opencode): add OpenCode provider button to NewThreadDialog"
```

---

## Task 9: Extend `ThreadView` Droid branch to cover OpenCode

**Files:**
- Modify: `src/components/thread/ThreadView.tsx:97-200`

This is the biggest UI task. The existing Droid branch already produces the exact UX the user wants — `ThreadTopBar` with file tree button / commit / IDE launcher, and `TerminalView` with the Claude-style loading animation. We extend the branch to cover OpenCode and rename the Droid-specific local state names so they read naturally for both providers.

- [ ] **Step 1: Read the current Droid branch**

Use Read tool on `src/components/thread/ThreadView.tsx` lines 95-210 to see the exact form. Confirm the local variable names: `droidAutoSpawnedRef`, `droidTerminalOpen`, `droidGitSidebarOpen`, `setDroidGitSidebarOpen`, `droidProcessing`, and the `if (thread.provider === "Droid")` block.

- [ ] **Step 2: Rename `droidAutoSpawnedRef` and broaden the auto-spawn effect**

Find:

```tsx
// Droid: auto-spawn the PTY when an existing thread is opened from the
// sidebar. Without this, re-selecting an existing Droid thread shows a black
// screen until the user types something.
const droidAutoSpawnedRef = useRef<string | null>(null);
useEffect(() => {
  if (thread.provider !== "Droid") return;
  // ... rest of effect
  if (droidAutoSpawnedRef.current === thread.id) return;
  droidAutoSpawnedRef.current = thread.id;
  // ...
}).catch((err) => {
  console.error("Droid auto-spawn failed:", err);
  // ...
  droidAutoSpawnedRef.current = null;
});
```

Replace with:

```tsx
// Terminal-only TUI providers (Droid, OpenCode): auto-spawn the PTY when an
// existing thread is opened from the sidebar. Without this, re-selecting an
// existing thread shows a black screen until the user types something.
const terminalAutoSpawnedRef = useRef<string | null>(null);
useEffect(() => {
  if (thread.provider !== "Droid" && thread.provider !== "OpenCode") return;
  // ... rest of effect (unchanged body)
  if (terminalAutoSpawnedRef.current === thread.id) return;
  terminalAutoSpawnedRef.current = thread.id;
  // ...
}).catch((err) => {
  console.error(`${thread.provider} auto-spawn failed:`, err);
  // ...
  terminalAutoSpawnedRef.current = null;
});
```

(Use Edit's `replace_all` to rename `droidAutoSpawnedRef` → `terminalAutoSpawnedRef` across the file.)

- [ ] **Step 3: Extend `providerLabel` and `providerClass` to cover OpenCode**

At `src/components/thread/ThreadView.tsx:122-130` there are two provider-keyed ternaries: `providerLabel` (display name shown in headers) and `providerClass` (Tailwind color classes for provider pill). Add an `OpenCode` branch to each, using cyan to match the `NewThreadDialog` button from Task 8.

Find:

```tsx
const providerLabel =
  thread.provider === "ClaudeCode"
    ? "Claude Code"
    : thread.provider === "Droid"
      ? "Droid"
      : "Codex";
const providerClass =
  thread.provider === "ClaudeCode"
    ? "bg-blue-500/20 text-blue-400"
    : thread.provider === "Droid"
      ? "bg-purple-500/20 text-purple-400"
      : "bg-green-500/20 text-green-400";
```

Replace with:

```tsx
const providerLabel =
  thread.provider === "ClaudeCode"
    ? "Claude Code"
    : thread.provider === "Droid"
      ? "Droid"
      : thread.provider === "OpenCode"
        ? "OpenCode"
        : "Codex";
const providerClass =
  thread.provider === "ClaudeCode"
    ? "bg-blue-500/20 text-blue-400"
    : thread.provider === "Droid"
      ? "bg-purple-500/20 text-purple-400"
      : thread.provider === "OpenCode"
        ? "bg-cyan-500/20 text-cyan-400"
        : "bg-green-500/20 text-green-400";
```

Note: the `loadingLabel` change happens separately in Step 8 — do NOT touch `loadingLabel` here.

- [ ] **Step 4: Update `isTerminalOnly` to cover OpenCode**

Find:

```tsx
const isTerminalOnly = thread.provider === "ClaudeCode" || thread.provider === "Droid";
```

Replace with:

```tsx
import { isTerminalOnlyProvider } from "../../lib/types";
// ... at top of file alongside other imports

const isTerminalOnly = isTerminalOnlyProvider(thread.provider);
```

- [ ] **Step 5: Rename `droidTerminalOpen` / `droidGitSidebarOpen` / `droidProcessing` → `terminalOpen` / `terminalGitSidebarOpen` / `terminalProcessing`**

Find:

```tsx
// Droid-specific top bar state (mirrors ClaudeSessionView / DraftChatView usage of ThreadTopBar)
const droidTerminalOpen = useUiStore((s) => s.sessionTerminalOpenByKey[sessionUiKey] ?? false);
const setSessionTerminalOpen = useUiStore((s) => s.setSessionTerminalOpen);
const [droidGitSidebarOpen, setDroidGitSidebarOpen] = useState(false);
// ...
const droidProcessing = useUiStore((s) => s.claudeProcessingById[thread.id] ?? false);
```

Replace with:

```tsx
// Terminal-only providers (Droid, OpenCode) reuse the Claude-style ThreadTopBar
// + TerminalView. State names are provider-agnostic.
const terminalOpen = useUiStore((s) => s.sessionTerminalOpenByKey[sessionUiKey] ?? false);
const setSessionTerminalOpen = useUiStore((s) => s.setSessionTerminalOpen);
const [terminalGitSidebarOpen, setTerminalGitSidebarOpen] = useState(false);
// Read per-session processing state from the same store ClaudeSessionView uses.
// The hook router writes here on pre-tool-use → true, stop → false, so the
// ThreadTopBar spinner reflects actual tool activity for both Droid and OpenCode.
const terminalProcessing = useUiStore((s) => s.claudeProcessingById[thread.id] ?? false);
```

Then update the corresponding usages (use Edit `replace_all` per identifier to be safe):
- `droidTerminalOpen` → `terminalOpen`
- `droidGitSidebarOpen` → `terminalGitSidebarOpen`
- `setDroidGitSidebarOpen` → `setTerminalGitSidebarOpen`
- `droidProcessing` → `terminalProcessing`

**Collision check (verified during plan review):** In the current `ThreadView.tsx`, `terminalOpen` appears only as a JSX prop name (`terminalOpen={droidTerminalOpen}` at line 166) — not as a local variable — so the rename is safe. `terminalProcessing` and `terminalGitSidebarOpen` do not appear at all. No fallback needed.

- [ ] **Step 6: Broaden the render-branch conditional**

Find:

```tsx
// Droid uses the Claude-style ThreadTopBar (project / git branch / commit / IDE launcher)
// instead of the generic ThreadView header. Terminal-only, no view-mode controls.
if (thread.provider === "Droid") {
```

Replace with:

```tsx
// Droid and OpenCode use the Claude-style ThreadTopBar (project / git branch /
// commit / IDE launcher) instead of the generic ThreadView header.
// Terminal-only, no view-mode controls.
if (thread.provider === "Droid" || thread.provider === "OpenCode") {
```

- [ ] **Step 7: Update the TerminalView key prop**

Find:

```tsx
<TerminalView
  key={`droid-terminal-${thread.id}`}
```

Replace with:

```tsx
<TerminalView
  key={`${thread.provider.toLowerCase()}-terminal-${thread.id}`}
```

(The `key` change ensures the terminal remounts cleanly if the user somehow switches a thread's provider, which shouldn't happen in v1 but is defensive.)

- [ ] **Step 8: Update the TerminalView loadingLabel**

Find:

```tsx
loadingLabel="Starting Droid"
```

Replace with:

```tsx
loadingLabel={thread.provider === "OpenCode" ? "Starting OpenCode" : "Starting Droid"}
```

- [ ] **Step 9: Type-check**

Run: `npx tsc --noEmit 2>&1 | tail -30`
Expected: No errors in `ThreadView.tsx`. If there are exhaustive-switch errors in other files (e.g. `Sidebar.tsx`, `ProjectGroup.tsx`, `SlashCommandPopup.tsx`, `SetupWizardDialog.tsx`), those need a `case "OpenCode":` added — fix them inline by mirroring the existing `case "Droid":` arm in each file.

- [ ] **Step 10: Commit**

```bash
git add src/components/thread/ThreadView.tsx
git commit -m "feat(opencode): extend ThreadView terminal branch to OpenCode"
```

If other files needed exhaustive-switch fixes:

```bash
git add src/components/sidebar/Sidebar.tsx src/components/sidebar/ProjectGroup.tsx ...
git commit -m "fix(opencode): add OpenCode arms to provider switch sites"
```

---

## Task 10: Optional — feature gate via `settingsStore`

**Files:**
- Inspect: `src/stores/settingsStore.ts`
- Modify (conditional): `src/stores/settingsStore.ts`, `src/components/sidebar/NewThreadDialog.tsx`, `src/components/sidebar/SetupWizardDialog.tsx`

This task is **conditional** — only execute it if Droid has a feature flag in `settingsStore`. If Droid has no flag, OpenCode also has no flag and you skip this task entirely.

- [ ] **Step 1: Inspect for an existing Droid feature flag**

Run: `grep -n 'droid' /Users/neel/Documents/GitHub/xanom/src/stores/settingsStore.ts`

If the result contains something like `droidEnabled: boolean` or `droidProviderEnabled: boolean`, continue. Otherwise, **skip this task entirely** and proceed to Task 11.

- [ ] **Step 2: Add `openCodeEnabled` mirror**

Add a parallel field to the store with the same default as Droid's flag, and persist it the same way.

- [ ] **Step 3: Gate the OpenCode button in `NewThreadDialog`**

Wrap the OpenCode button (added in Task 8) in `{openCodeEnabled && (...)}` matching how the Droid button is gated.

- [ ] **Step 4: Add a SetupWizardDialog toggle**

Mirror the Droid toggle exactly. Same wording structure.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit 2>&1 | tail -20`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/stores/settingsStore.ts src/components/sidebar/NewThreadDialog.tsx src/components/sidebar/SetupWizardDialog.tsx
git commit -m "feat(opencode): add openCodeEnabled feature flag"
```

---

## Task 11: Update `CLAUDE.md` provider mention

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Find the existing provider mention**

Run: `grep -n 'ClaudeCode.*Codex.*Droid\|provider.*claude.*codex' CLAUDE.md`

The most likely location is the "Key Types" section (`type Provider = "ClaudeCode" | "Codex" | "Droid"`).

- [ ] **Step 2: Add OpenCode**

Update the type union in CLAUDE.md to:

```ts
type Provider = "ClaudeCode" | "Codex" | "Droid" | "OpenCode"
```

If there's a prose paragraph describing providers (e.g. in the architecture section), append a short sentence:

> **OpenCode** is a 4th terminal-only provider (PTY mode, DirectRepo only). Sessions are observed via a JS plugin written to `~/.xanom/opencode-plugins/xanom-relay.js` and registered in `~/.opencode/opencode.json`. The plugin relays a curated set of bus events to the same Unix hook socket Claude/Droid use.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add OpenCode provider to CLAUDE.md"
```

---

## Task 12: Manual smoke test + final type-check

**Files:** none

This is a verification task — no code is written. The plan ends here only if all steps pass.

- [ ] **Step 1: Final type-check**

Run: `npx tsc --noEmit 2>&1 | tail -20`
Expected: clean.

- [ ] **Step 2: Final cargo test**

Run: `cd src-tauri && cargo test --lib 2>&1 | tail -30`
Expected: All tests pass (including the seven new `hooks::opencode_plugin` tests).

- [ ] **Step 3: Verify OpenCode is installed**

Run: `which opencode`
Expected: A path. If empty, install OpenCode first: `curl -fsSL https://opencode.ai/install | bash`

- [ ] **Step 4: Verify the user is logged into OpenCode**

Run: `opencode auth list`
Expected: At least one account listed. If empty, run `opencode login` first.

- [ ] **Step 5: Launch Xanom in dev mode**

Run: `npx tauri dev`

Wait for the app to load. Check the dev console for the log line:
> `OpenCode relay plugin registered at /Users/<user>/.xanom/opencode-plugins/xanom-relay.js`

- [ ] **Step 6: Verify the plugin file exists**

In a separate terminal:
```sh
cat ~/.xanom/opencode-plugins/xanom-relay.js | head -5
```
Expected: First 5 lines of the relay script (starting with `// xanom-relay.js — written by Xanom`).

- [ ] **Step 7: Verify opencode.json was updated**

```sh
cat ~/.opencode/opencode.json
```
Expected: Contains a `"plugin"` array with an entry ending in `xanom-relay.js`.

- [ ] **Step 8: Create an OpenCode thread in Xanom**

In the running Xanom app:
1. Click the "+" button to open `NewThreadDialog`
2. Click the "OpenCode" provider button (cyan)
3. Verify the branch picker is hidden
4. Submit

Expected:
- Thread is created
- The thread view shows `ThreadTopBar` (project name, git branch, commit, IDE launcher button, terminal toggle, git sidebar toggle)
- A `TerminalView` mounts with the "Starting OpenCode" loading overlay
- Within ~1s, the OpenCode TUI appears (loading overlay fades)

- [ ] **Step 9: Verify event relay is working**

In the OpenCode TUI, type a prompt that triggers a tool use (e.g. `read package.json`).

Expected:
- The processing spinner in the top bar lights up while OpenCode is working
- The spinner clears when OpenCode finishes (returns to idle)

If the spinner does NOT light up, the OpenCode bus event names in `RELAY_SCRIPT` (Task 3 Step 3) don't match OpenCode's actual event types. Inspect OpenCode's source at `~/Documents/GitHub/xanom/xanom-temp/opencode-dev/packages/opencode/src/session/` for `Bus.publish(...)` calls and update the `EVENT_MAP` in `opencode_plugin.rs`. Then re-run `cargo test --lib hooks::opencode_plugin` and restart Xanom (the plugin is rewritten on startup if content drifted).

- [ ] **Step 10: Verify auto-open on edit (IDE mode)**

In Xanom, switch to IDE mode (`Cmd+Shift+.`). Create or open another OpenCode thread. Issue a prompt that edits a file (e.g. `add a TODO comment to src/lib/types.ts`).

Expected: The edited file auto-opens in CodeEditor.

If auto-open does NOT work, the `pre-tool-use` payload from OpenCode is missing the file path field expected by `useAutoOpenOnAiEdit`. Inspect Claude's `pre-tool-use` payload shape for comparison and either (a) reshape the payload in `xanom-relay.js` before sending, or (b) add a per-provider mapper before HookDedup in `hooks/mod.rs`. (This is Risk #2 from the spec — fix in a follow-up if needed.)

- [ ] **Step 11: Verify out-of-Xanom safety**

Quit Xanom. In a normal terminal, run:
```sh
opencode
```

Expected: OpenCode TUI loads normally with no errors. The relay plugin is loaded but its event handler is a no-op because `XANOM_SESSION_ID` is unset. No connection attempts to the (now non-existent) hook socket.

- [ ] **Step 12: Verify plugin doesn't break opencode logs**

```sh
tail -30 ~/.opencode/log/*.log
```

Expected: No errors related to `xanom-relay.js`. If there are errors (e.g. syntax errors, import failures), the relay script needs fixing.

- [ ] **Step 13: Document any deviations**

If any of steps 9-12 surfaced issues that required fixing, commit the fix with a clear message:

```bash
git add <files>
git commit -m "fix(opencode): <what>"
```

If everything works on the first try, no commit is needed for this task.

---

## Self-Review Checklist

After completing all tasks, verify:

- [ ] `Provider::OpenCode` is in the Rust enum (Task 1)
- [ ] `"OpenCode"` is in the TypeScript `Provider` union (Task 2)
- [ ] `~/.xanom/opencode-plugins/xanom-relay.js` is written on app startup (Task 3, 5)
- [ ] `~/.opencode/opencode.json` has the relay plugin in its `plugin` array (Task 4, 5)
- [ ] `spawn.rs` Provider::OpenCode arm sets `XANOM_HOOK_SOCKET`, `XANOM_SESSION_ID`, `XANOM_PROVIDER` (Task 6)
- [ ] `isTerminalOnlyProvider` helper exists in `lib/types.ts` (Task 7)
- [ ] `NewThreadDialog` shows a 4th OpenCode button and forces DirectRepo (Task 8)
- [ ] `ThreadView` extends the Droid branch to cover OpenCode with renamed local state (Task 9)
- [ ] `CLAUDE.md` mentions OpenCode (Task 11)
- [ ] All Rust unit tests pass (`cargo test --lib hooks::opencode_plugin` — 7 tests)
- [ ] `npx tsc --noEmit` is clean
- [ ] Manual smoke test passed (Task 12, steps 5-11)

## Risks (deferred to runtime / follow-up PRs)

- **Risk #1 — OpenCode bus event names.** The `EVENT_MAP` in `RELAY_SCRIPT` uses placeholder names (`session.message.user`, `session.tool.start`, `session.idle`, `session.notification`, `session.deleted`). These are confirmed during Task 12 Step 9. If the spinner doesn't light up, grep `~/Documents/GitHub/xanom/xanom-temp/opencode-dev/packages/opencode/src/session/` for `Bus.publish(...)` and finalize the names.

- **Risk #2 — Tool payload shape divergence.** OpenCode's tool event payload may put file paths under a different key than Claude's. Fix in a follow-up PR if Task 12 Step 10 fails.

- **Risk #3 — Bun module compatibility.** The relay uses `node:net`. If Bun reports module errors in OpenCode logs (Task 12 Step 12), swap to `Bun.connect`.

- **Risk #4 — Global config pollution.** Writing into `~/.opencode/opencode.json` modifies user state outside Xanom. Mitigation: the plugin is session-gated and a no-op outside Xanom. Document in release notes.

## Out of scope (per spec)

- Worktree work mode for OpenCode threads
- Model picker in the Xanom top bar
- First-run auth wizard step
- Structured chat view (`OpenCodeSessionView` via `opencode serve` + `@opencode-ai/sdk`)
- Usage stats integration (OpenCode session DB scanning)
- Bundling the `opencode` binary
