use std::fs;
use std::path::{Path, PathBuf};

/// Returns the path to the JS relay plugin agmux writes for OpenCode.
/// The plugin is loaded by OpenCode's config system and forwards a curated
/// set of bus events to agmux's Unix hook socket.
pub fn opencode_relay_script_path() -> Result<PathBuf, String> {
    crate::paths::agmux_home_opt()
        .map(|h| h.join("opencode-plugins").join("xanom-relay.js"))
        .ok_or_else(|| "Could not determine home directory".to_string())
}

/// Returns the path to the user's global OpenCode config file.
pub fn opencode_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".opencode").join("opencode.json"))
}

/// Ensure the global `~/.opencode/opencode.json` registers agmux's relay
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
    use serde_json::{json, Value};

    // Build the file:// URL for the plugin entry. Use the `url` crate so
    // paths containing spaces or other special characters are percent-encoded
    // correctly (and so Windows backslashes become forward slashes per
    // RFC 8089). `from_file_path` requires an absolute path.
    let absolute_plugin_path = if plugin_path.is_absolute() {
        plugin_path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("Failed to resolve current dir: {}", e))?
            .join(plugin_path)
    };
    let plugin_url = url::Url::from_file_path(&absolute_plugin_path)
        .map_err(|_| {
            format!(
                "Failed to build file:// URL for plugin path: {}",
                absolute_plugin_path.display()
            )
        })?
        .to_string();

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
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(format!("Failed to read opencode.json: {}", e)),
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

    // Rewrite leftover ~/.xanom plugin URLs (same file via migrate symlink)
    // so we do not dual-register and fire every hook twice.
    let mut rewritten = false;
    for entry in plugins.iter_mut() {
        if let Some(s) = entry.as_str() {
            if let Some(next) = crate::hooks::rewrite_legacy_hook_cmd(s, &plugin_url) {
                *entry = json!(next);
                rewritten = true;
            }
        }
    }

    let already_present = plugins.iter().any(|entry| {
        entry
            .as_str()
            .map(|s| s == plugin_url)
            .unwrap_or(false)
    });

    if !already_present {
        plugins.push(json!(plugin_url));
    } else if !rewritten {
        return Ok(());
    }

    // Serialize with two-space indent and write to disk.
    let serialized = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize opencode.json: {}", e))?;
    fs::write(config_path, serialized + "\n")
        .map_err(|e| format!("Failed to write opencode.json: {}", e))?;

    Ok(())
}

/// Ensure the OpenCode relay plugin exists at `~/.agmux/opencode-plugins/xanom-relay.js`.
/// Returns the path to the script. Idempotent: rewrites only if content has drifted.
pub fn ensure_opencode_relay_script() -> Result<PathBuf, String> {
    let path = opencode_relay_script_path()?;
    ensure_opencode_relay_script_at(&path)?;
    Ok(path)
}

/// Same as `ensure_opencode_relay_script` but takes an explicit path. Exposed
/// for tests so they can write to temp dirs without mutating `HOME`.
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
/// runs `opencode` outside agmux.
///
/// Translates OpenCode's bus events into the 5 canonical events agmux's hook
/// handler understands (`prompt-submit`, `pre-tool-use`, `stop`, `notification`,
/// `session-end`), matching the Droid relay envelope.
///
/// Event mapping notes (verified against opencode-dev source 2026-04-07):
/// - `session.idle` → `stop` (defined at `session/status.ts:37`; marked deprecated
///   in the source but still fires via `SessionStatus.set(...)` when the session
///   transitions to idle)
/// - `session.error` → `notification`
/// - `session.deleted` → `session-end`
/// - `message.updated` with `info.role === "user"` → `prompt-submit` (fires
///   immediately on user submit to arm the agmux spinner; the text is empty here
///   because text lives in `TextPart`s that arrive on separate `message.part.updated`
///   events — see below)
/// - `message.part.updated` with `part.type === "text"` AND part belongs to a
///   user message → second `prompt-submit` with real text for thread naming
/// - `message.part.updated` with `part.type === "tool"` → `pre-tool-use` (keeps
///   the spinner in the Running state during tool execution; tool name/file_path
///   extraction is best-effort for auto-open-on-edit)
///
/// Script version is bumped via the `// relay-script-version: N` comment so
/// `ensure_opencode_relay_script_at` rewrites on upgrades (content-hash check).
const RELAY_SCRIPT: &str = r#"// xanom-relay.js — written by agmux. Do not edit by hand.
// relay-script-version: 6
// Forwards a curated set of OpenCode bus events to agmux's Unix hook socket.
// Session-gated: only relays when XANOM_SESSION_ID is set, so running `opencode`
// outside agmux is a no-op.

import net from "node:net";

const SOCKET = process.env.AGMUX_HOOK_SOCKET || process.env.XANOM_HOOK_SOCKET;
const SESSION = process.env.AGMUX_SESSION_ID || process.env.AGMUX_THREAD_ID || process.env.XANOM_SESSION_ID;

// Track user message IDs so we can recognize text parts that belong to user
// messages (vs assistant messages) when `message.part.updated` fires. Bounded
// to the most recent 128 user messages to prevent unbounded growth across a
// long session.
const userMessageIds = new Set();
const userMessageIdOrder = [];
function rememberUserMessage(id) {
  if (!id || userMessageIds.has(id)) return;
  userMessageIds.add(id);
  userMessageIdOrder.push(id);
  if (userMessageIdOrder.length > 128) {
    const drop = userMessageIdOrder.shift();
    userMessageIds.delete(drop);
  }
}

// Extract OpenCode's real session ID from an event's properties. Different
// event shapes nest the session ID differently:
//   - `session.idle` / `session.error`  →  props.sessionID
//   - `session.deleted`                 →  props.info.id       (the session itself)
//   - `message.updated`                 →  props.info.sessionID
//   - `message.part.updated`            →  props.part.sessionID
// Returns "" if no session ID is available (caller should not rely on it).
function extractOpencodeSessionID(eventType, props) {
  if (!props) return "";
  if (typeof props.sessionID === "string" && props.sessionID) return props.sessionID;
  if (props.info) {
    if (typeof props.info.sessionID === "string" && props.info.sessionID) return props.info.sessionID;
    // `session.deleted` uses `info.id` — the session's own ID
    if (eventType === "session.deleted" && typeof props.info.id === "string") return props.info.id;
  }
  if (props.part && typeof props.part.sessionID === "string" && props.part.sessionID) return props.part.sessionID;
  return "";
}

// Remember the last seen OpenCode session ID so we can include it on EVERY
// hook event we forward — even events whose original property shape doesn't
// expose it (e.g. synthetic retries). The Rust hook router persists this to
// ~/.agmux/threads/<id>/opencode-session-id.txt so `spawn.rs` can pass
// `--session <id>` on the next respawn.
let lastSessionID = "";
const createdSessions = new Set();

function send(eventType, payload, nativeSessionID = lastSessionID) {
  if (!SOCKET || !SESSION) return;
  // Always attach the current opencode session_id to the payload (key name
  // matches Droid's convention so the Rust hook router can reuse the same
  // `payload.session_id` extraction code path).
  const envelope = {
    event: eventType,
    session_id: SESSION,
    provider: "opencode",
    payload: { ...(payload || {}), session_id: nativeSessionID,
      ...(createdSessions.has(nativeSessionID) ? { agmux_creation: "opencode-session-created" } : {}) },
  };
  const msg = JSON.stringify(envelope) + "\n";
  try {
    const sock = net.createConnection(SOCKET);
    sock.on("error", () => {}); // swallow — agmux may not be running
    sock.on("connect", () => { sock.write(msg); sock.end(); });
  } catch (_) {
    // never throw out of an event hook
  }
}

function handleMessageUpdated(props) {
  const info = props && props.info;
  if (!info || info.role !== "user") return;
  // OpenCode emits `message.updated` MULTIPLE times per user message — once
  // when the message row is first inserted, then again later when it's
  // updated (with final token counts, parts, etc.). We must only fire
  // prompt-submit ONCE per message; a duplicate emit after `session.idle`
  // would flip the agmux state machine back from awaiting_stop to processing
  // and the spinner would never clear.
  if (userMessageIds.has(info.id)) return;
  rememberUserMessage(info.id);
  // Fire immediately with empty text so agmux's state machine arms the
  // spinner. The Sidebar hook handler's thread-name summarizer will no-op
  // on empty text (it only summarizes non-empty non-slash prompts), so we
  // follow up with real text once the TextPart arrives via `prompt-text`.
  send("prompt-submit", { messageId: info.id, prompt: "" });
}

function handleMessagePartUpdated(props) {
  const part = props && props.part;
  if (!part || !part.type) return;

  if (part.type === "text") {
    // Only surface text parts that belong to user messages (for thread naming).
    // Assistant text parts stream as the model responds and are not relevant.
    if (!userMessageIds.has(part.messageID)) return;
    const text = typeof part.text === "string" ? part.text : "";
    if (!text.trim()) return;
    if (part.synthetic) return; // skip synthetic/system-injected text
    // Fire `prompt-text` (NOT `prompt-submit`) with the real text. OpenCode
    // persists user text parts at the END of the turn — after `session.idle`
    // has fired — so re-emitting `prompt-submit` would thrash the state
    // machine back from `awaiting_stop` to `processing`. `prompt-text` is a
    // agmux-internal summarize-only event that Sidebar.tsx handles without
    // driving the session state machine.
    send("prompt-text", {
      messageId: part.messageID,
      prompt: text,
      message: text, // Sidebar hook handler probes .message first
    });
    return;
  }

  if (part.type === "tool") {
    // Best-effort file_path extraction for agmux's auto-open-on-edit feature.
    // OpenCode tool inputs live under part.state.input; different tools use
    // different field names, so we probe several common keys.
    const state = part.state || {};
    const input = (state && state.input) || {};
    const filePath =
      input.file_path ||
      input.path ||
      input.filePath ||
      input.filename ||
      undefined;
    send("pre-tool-use", {
      tool_name: state.tool || part.tool || "tool",
      tool_input: input,
      file_path: filePath,
    });
    return;
  }
}

export default async function xanomRelay() {
  return {
    event: async ({ event }) => {
      if (!SESSION || !event || !event.type) return;

      const props = event.properties || {};
      if (event.type === "session.created") {
        const sid = props.info && props.info.id;
        if (typeof sid !== "string" || !sid || (props.sessionID && props.sessionID !== sid)) return;
        createdSessions.add(sid);
        // Creation (including a child) is not a parent UI transition. Keep
        // the active pointer untouched; ordinary messages still select it.
        send("session-start", { agmux_provenance_only: true }, sid);
        return;
      }

      // Update our cached session ID before dispatching so every send()
      // call attaches the freshest known value.
      const maybeSid = extractOpencodeSessionID(event.type, props);
      if (maybeSid) lastSessionID = maybeSid;

      switch (event.type) {
        case "session.idle":
          send("stop", {});
          return;
        case "session.error":
          send("notification", props);
          return;
        case "session.deleted":
          send("session-end", {});
          return;
        case "message.updated":
          handleMessageUpdated(props);
          return;
        case "message.part.updated":
          handleMessagePartUpdated(props);
          return;
        default:
          // ignore every other bus event (session.updated,
          // message.part.delta, lsp.*, file.*, mcp.*, etc.) to avoid flooding
          // the hook socket.
          return;
      }
    },
  };
}
"#;

// ── Per-thread OpenCode session ID persistence ───────────────────────────
//
// OpenCode stores its sessions in a SQLite database under `~/.local/share/
// opencode/` keyed by `ses_<id>`. When an OpenCode thread is respawned from
// the sidebar, we want to resume the previous session instead of starting
// fresh — otherwise the conversation history is lost.
//
// Flow:
//   1. Plugin (relay-script-version 5+) attaches the real OpenCode session
//      ID to every hook envelope at `payload.session_id`.
//   2. Hook router (`hooks/mod.rs`) extracts it and calls
//      `write_opencode_session_id(thread_state_dir, id)` on every event,
//      keeping the file fresh as the session evolves.
//   3. `spawn.rs` OpenCode arm calls `read_opencode_session_id(...)` on
//      respawn and passes `--session <id>` to the opencode CLI, which the
//      TUI interprets as "navigate to this session immediately" (see
//      opencode-dev:packages/opencode/src/cli/cmd/tui/app.tsx:299-303).

pub fn opencode_session_id_path(thread_state_dir: &Path) -> PathBuf {
    thread_state_dir.join("opencode-session-id.txt")
}

/// Persist an OpenCode session ID to the thread's state dir. Creates the
/// parent dir if needed. Rejects empty IDs.
pub fn write_opencode_session_id(
    thread_state_dir: &Path,
    session_id: &str,
) -> Result<(), String> {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return Err("Empty opencode session id".to_string());
    }
    fs::create_dir_all(thread_state_dir)
        .map_err(|e| format!("Failed to create thread state dir: {}", e))?;
    let path = opencode_session_id_path(thread_state_dir);
    fs::write(&path, trimmed)
        .map_err(|e| format!("Failed to write opencode-session-id.txt: {}", e))
}

/// Read a previously persisted OpenCode session ID for a thread. Returns
/// `None` if the file is missing or empty.
pub fn read_opencode_session_id(thread_state_dir: &Path) -> Option<String> {
    let path = opencode_session_id_path(thread_state_dir);
    let content = fs::read_to_string(path).ok()?;
    let trimmed = content.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
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

    #[test]
    fn session_id_write_and_read_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let thread_dir = tmp.path().join("threads").join("abc12345");

        write_opencode_session_id(&thread_dir, "ses_abc123def456").unwrap();
        let loaded = read_opencode_session_id(&thread_dir);
        assert_eq!(loaded.as_deref(), Some("ses_abc123def456"));
    }

    #[test]
    fn session_id_write_rejects_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let thread_dir = tmp.path().join("threads").join("abc12345");
        assert!(write_opencode_session_id(&thread_dir, "   ").is_err());
        assert!(read_opencode_session_id(&thread_dir).is_none());
    }

    #[test]
    fn session_id_read_returns_none_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let thread_dir = tmp.path().join("threads").join("missing");
        assert!(read_opencode_session_id(&thread_dir).is_none());
    }

    #[test]
    fn session_id_write_overwrites_previous() {
        let tmp = tempfile::tempdir().unwrap();
        let thread_dir = tmp.path().join("threads").join("abc12345");

        write_opencode_session_id(&thread_dir, "ses_first").unwrap();
        write_opencode_session_id(&thread_dir, "ses_second").unwrap();
        assert_eq!(
            read_opencode_session_id(&thread_dir).as_deref(),
            Some("ses_second")
        );
    }

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
    fn null_plugin_field_treated_as_empty_array() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("opencode.json");
        let plugin_path = tmp.path().join("xanom-relay.js");

        fs::write(&config_path, r#"{"plugin":null}"#).unwrap();
        ensure_opencode_plugin_registered_at(&config_path, &plugin_path).unwrap();

        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
        let plugins = parsed.get("plugin").and_then(|v| v.as_array()).unwrap();
        assert_eq!(plugins.len(), 1);
    }

    #[test]
    fn non_object_root_returns_err() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("opencode.json");
        let plugin_path = tmp.path().join("xanom-relay.js");

        fs::write(&config_path, r#"["not","an","object"]"#).unwrap();
        let result = ensure_opencode_plugin_registered_at(&config_path, &plugin_path);
        assert!(result.is_err(), "non-object root must return Err");
    }

    #[test]
    fn non_array_plugin_field_returns_err() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("opencode.json");
        let plugin_path = tmp.path().join("xanom-relay.js");

        fs::write(&config_path, r#"{"plugin":"not-an-array"}"#).unwrap();
        let result = ensure_opencode_plugin_registered_at(&config_path, &plugin_path);
        assert!(result.is_err(), "non-array plugin field must return Err");
    }

    #[test]
    fn opencode_session_id_path_is_correct_filename() {
        let dir = std::path::Path::new("/tmp/thread123");
        let p = opencode_session_id_path(dir);
        assert_eq!(p.file_name().and_then(|f| f.to_str()), Some("opencode-session-id.txt"));
        assert_eq!(p.parent(), Some(dir));
    }

    #[test]
    fn empty_file_read_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        let thread_dir = tmp.path().join("thread_empty");
        fs::create_dir_all(&thread_dir).unwrap();
        let path = opencode_session_id_path(&thread_dir);
        fs::write(&path, "   ").unwrap(); // whitespace-only
        assert!(read_opencode_session_id(&thread_dir).is_none());
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

    // ── relative plugin path (resolved against current_dir) ───────────────────

    #[test]
    fn registers_with_relative_plugin_path() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("opencode.json");
        // Use a relative path; the function resolves it against env::current_dir.
        let plugin_path = std::path::PathBuf::from("./xanom-relay.js");
        ensure_opencode_plugin_registered_at(&config_path, &plugin_path).unwrap();

        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
        let plugins = parsed.get("plugin").and_then(|v| v.as_array()).unwrap();
        assert_eq!(plugins.len(), 1);
        let entry = plugins[0].as_str().unwrap();
        assert!(entry.starts_with("file://"));
        assert!(entry.ends_with("xanom-relay.js"));
    }

    // ── ensure_opencode_relay_script_at ──────────────────────────────────────

    #[test]
    fn relay_script_written_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plugins").join("xanom-relay.js");
        ensure_opencode_relay_script_at(&path).unwrap();
        assert!(path.is_file(), "relay script should exist after first call");
        let body = fs::read_to_string(&path).unwrap();
        assert!(!body.is_empty(), "relay body should not be empty");
    }

    #[test]
    fn relay_script_idempotent_when_content_matches() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("xanom-relay.js");
        ensure_opencode_relay_script_at(&path).unwrap();
        // Second call should be a no-op; content already matches.
        ensure_opencode_relay_script_at(&path).unwrap();
        let body_second = fs::read_to_string(&path).unwrap();
        assert!(!body_second.is_empty());
    }

    #[test]
    fn relay_script_rewrites_when_content_drifted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("xanom-relay.js");
        // Write a stale body that differs from the bundled relay source.
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "// outdated stub\n").unwrap();
        ensure_opencode_relay_script_at(&path).unwrap();
        let body = fs::read_to_string(&path).unwrap();
        assert_ne!(body, "// outdated stub\n", "stale body should be replaced");
    }

    #[test]
    fn relay_script_creates_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a").join("b").join("c").join("relay.js");
        assert!(!path.parent().unwrap().exists());
        ensure_opencode_relay_script_at(&path).unwrap();
        assert!(path.is_file());
    }

    // ── ensure_opencode_plugin_registered_at: read error ─────────────────────

    #[test]
    fn registered_returns_err_when_read_fails() {
        // A directory at the config path causes `read_to_string` to error
        // with a kind other than NotFound — function should propagate.
        let dir = tempfile::tempdir().unwrap();
        let bogus = dir.path().join("opencode.json");
        fs::create_dir(&bogus).unwrap();
        let plugin_path = dir.path().join("xanom-relay.js");
        let result = ensure_opencode_plugin_registered_at(&bogus, &plugin_path);
        assert!(result.is_err(), "should error when config path is unreadable");
        let err = result.unwrap_err();
        assert!(!err.is_empty());
    }
}
