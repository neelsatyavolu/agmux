//! consult: second opinions from other agents, built into agmux.
//!
//! The `consult-mcp` package (bundled as `sidecar/dist/agmux-consult-mcp.bundle.mjs`)
//! is registered next to agmux-memory with every Claude, Codex and Grok session
//! agmux launches. agmux supplies its own session list and message delivery
//! through the room socket (`sessions.list` / `sessions.send`, see [`sessions`]),
//! so `list_sessions` / `send_message` cover every agmux session.
//!
//! Advisors stay read-only and MCP-free: consult's own adapter flags are untouched.

pub mod sessions;

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const MCP_SERVER_NAME: &str = "consult";
const SOURCE_NAME: &str = "agmux-consult-mcp.mjs";
const BUNDLE_NAME: &str = "agmux-consult-mcp.bundle.mjs";
/// consult uses `AbortSignal.any` and other Node 22 APIs.
const MIN_NODE_MAJOR: u32 = 22;
/// Codex's 60s default tool timeout is shorter than an advisor call
/// (consult's `install` uses the same values).
const CODEX_TOOL_TIMEOUT_SEC: u32 = 960;
const CODEX_STARTUP_TIMEOUT_SEC: u32 = 60;

/// Read-only consult tools that Claude chat may call without an approval
/// prompt. `send_message` starts a turn in another session, so it still asks.
const AUTO_ALLOWED_TOOLS: &[&str] = &[
    "ask_agent",
    "ask_agents",
    "review_changes",
    "list_agents",
    "list_sessions",
    "ask_session",
];

fn enabled_flag_path() -> PathBuf {
    crate::paths::agmux_home_opt()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("consult-enabled")
}

/// Settings → Second opinions. Default **on** when the flag file is absent.
pub fn is_enabled() -> bool {
    crate::memory::read_bool_flag(&enabled_flag_path(), true)
}

pub fn set_enabled(enabled: bool) -> Result<(), String> {
    crate::memory::write_bool_flag(&enabled_flag_path(), enabled)
}

/// Who the consult server speaks for. `thread_id` is absent for multiplexed
/// processes (Codex chat app-server) and shared configs (Grok terminal).
#[derive(Debug, Clone, Default)]
pub struct ConsultIdentity<'a> {
    pub thread_id: Option<&'a str>,
    pub project_id: Option<&'a str>,
}

#[derive(Debug, Clone)]
struct Spec {
    node: String,
    script: PathBuf,
    env: Vec<(String, String)>,
}

fn node_major(version: &str) -> Option<u32> {
    version.trim().trim_start_matches('v').split('.').next()?.parse().ok()
}

/// The Node binary consult can run on, checked once per app run.
fn consult_node() -> Result<String, String> {
    // Only a success is remembered, so installing Node 22 works without a restart.
    static NODE: OnceLock<String> = OnceLock::new();
    if let Some(node) = NODE.get() {
        return Ok(node.clone());
    }
    let found = (|| {
        let node = crate::memory::find_node_binary()?;
        let out = std::process::Command::new(&node)
            .arg("--version")
            .output()
            .map_err(|e| format!("could not run {node} --version: {e}"))?;
        let version = String::from_utf8_lossy(&out.stdout).to_string();
        match node_major(&version) {
            Some(major) if major >= MIN_NODE_MAJOR => Ok(node),
            _ => Err(format!(
                "consult needs Node {MIN_NODE_MAJOR} or later; {node} is {}",
                version.trim()
            )),
        }
    })()?;
    Ok(NODE.get_or_init(|| found).clone())
}

fn env_pairs(identity: &ConsultIdentity) -> Vec<(String, String)> {
    let mut env = vec![("PATH".to_string(), crate::process::provider::build_augmented_path())];
    if let Some(tid) = identity.thread_id.filter(|t| !t.is_empty()) {
        env.push(("AGMUX_THREAD_ID".into(), tid.to_string()));
    }
    // No "last active thread" fallback: a shared process (Codex chat) would
    // name the wrong sender. Without a thread id, agmux matches the parent pid.
    if let Some(pid) = identity.project_id.filter(|p| !p.is_empty()) {
        env.push(("AGMUX_PROJECT_ID".into(), pid.to_string()));
    }
    env
}

fn spec(app: Option<&tauri::AppHandle>, identity: &ConsultIdentity) -> Result<Spec, String> {
    Ok(Spec {
        node: consult_node()?,
        script: crate::memory::resolve_sidecar_script(app, SOURCE_NAME, BUNDLE_NAME)?,
        env: env_pairs(identity),
    })
}

fn stdio_json(s: &Spec) -> Value {
    let env: Map<String, Value> = s.env.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
    json!({
        "command": s.node,
        "args": [s.script.to_string_lossy()],
        "env": env,
    })
}

/// `--mcp-config` JSON string for a Claude terminal (Claude accepts several
/// `--mcp-config` values, so this rides next to the agmux-memory file).
pub fn claude_mcp_config_json(
    app: Option<&tauri::AppHandle>,
    identity: &ConsultIdentity,
) -> Result<String, String> {
    let s = spec(app, identity)?;
    Ok(json!({ "mcpServers": { MCP_SERVER_NAME: stdio_json(&s) } }).to_string())
}

/// Claude chat `mcpServers` entry.
pub fn claude_sdk_mcp_server(
    app: &tauri::AppHandle,
    identity: &ConsultIdentity,
) -> Result<(String, Value), String> {
    let s = spec(Some(app), identity)?;
    Ok((MCP_SERVER_NAME.to_string(), stdio_json(&s)))
}

pub fn claude_allowed_tools() -> Vec<String> {
    AUTO_ALLOWED_TOOLS
        .iter()
        .map(|t| format!("mcp__{MCP_SERVER_NAME}__{t}"))
        .collect()
}

/// Merge consult into Claude chat `params` (`mcpServers` + `allowedTools`).
pub fn merge_into_claude_sdk_params(
    params: &mut Map<String, Value>,
    app: &tauri::AppHandle,
    identity: &ConsultIdentity,
) -> Result<(), String> {
    let (name, server) = claude_sdk_mcp_server(app, identity)?;
    if let Some(dst) = params
        .entry("mcpServers".to_string())
        .or_insert_with(|| json!({}))
        .as_object_mut()
    {
        dst.insert(name, server);
    }
    if let Some(arr) = params
        .entry("allowedTools".to_string())
        .or_insert_with(|| json!([]))
        .as_array_mut()
    {
        for t in claude_allowed_tools() {
            if !arr.iter().any(|v| v.as_str() == Some(t.as_str())) {
                arr.push(json!(t));
            }
        }
    }
    Ok(())
}

fn codex_override(s: &Spec) -> Vec<String> {
    use crate::memory::toml_escape;
    let env = s
        .env
        .iter()
        .map(|(k, v)| format!(r#"{k} = "{}""#, toml_escape(v)))
        .collect::<Vec<_>>()
        .join(", ");
    let value = format!(
        r#"{{ command = "{}", args = ["{}"], env = {{ {env} }}, tool_timeout_sec = {CODEX_TOOL_TIMEOUT_SEC}, startup_timeout_sec = {CODEX_STARTUP_TIMEOUT_SEC} }}"#,
        toml_escape(&s.node),
        toml_escape(&s.script.to_string_lossy()),
    );
    vec!["-c".to_string(), format!("mcp_servers.{MCP_SERVER_NAME}={value}")]
}

/// Codex `-c` override (terminal and chat app-server). Replaces any
/// `[mcp_servers.consult]` from `~/.codex/config.toml` for this process only.
pub fn codex_cli_overrides(
    app: Option<&tauri::AppHandle>,
    identity: &ConsultIdentity,
) -> Result<Vec<String>, String> {
    Ok(codex_override(&spec(app, identity)?))
}

/// Grok ACP `mcpServers` entry (env as `[{name, value}]`).
pub fn acp_mcp_server(
    app: &tauri::AppHandle,
    identity: &ConsultIdentity,
) -> Result<Value, String> {
    let s = spec(Some(app), identity)?;
    let env: Vec<Value> = s
        .env
        .iter()
        .map(|(k, v)| json!({ "name": k, "value": v }))
        .collect();
    Ok(json!({
        "name": MCP_SERVER_NAME,
        "command": s.node,
        "args": [s.script.to_string_lossy()],
        "env": env,
    }))
}

/// Grok chat: `servers` plus consult when it is on.
pub fn with_acp_server(mut servers: Vec<Value>, app: &tauri::AppHandle, thread_id: Option<&str>) -> Vec<Value> {
    if is_enabled() {
        match acp_mcp_server(app, &ConsultIdentity { thread_id, project_id: None }) {
            Ok(server) => servers.push(server),
            Err(e) => tracing::warn!("[grok] consult ACP MCP inject failed: {e}"),
        }
    }
    servers
}

/// Add consult to `{project_dir}/.grok/config.toml` when on, remove agmux's
/// entry when off. The file is shared by every Grok terminal in that folder,
/// so no thread id goes in: the server names its parent pid (the Grok
/// terminal's process) and agmux looks the session up from that.
pub fn sync_grok_project_config(
    project_dir: &str,
    identity: &ConsultIdentity,
    enabled: bool,
) -> Result<(), String> {
    let path = Path::new(project_dir).join(".grok").join("config.toml");
    if !enabled && !path.exists() {
        return Ok(());
    }
    let raw = if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let mut doc = raw
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("parse .grok/config.toml: {e}"))?;
    let shared = ConsultIdentity { thread_id: None, ..identity.clone() };
    let changed = if enabled {
        upsert_grok_entry(&mut doc, &spec(None, &shared)?)?
    } else {
        remove_grok_entry(&mut doc)
    };
    if changed {
        crate::memory::atomic_write(&path, &doc.to_string())?;
    }
    Ok(())
}

const GROK_ENTRY_MARKER: &str = "# agmux consult (auto-managed";

fn is_ours(item: &toml_edit::Item) -> bool {
    item.as_table()
        .and_then(|t| t.decor().prefix())
        .and_then(|p| p.as_str())
        .is_some_and(|p| p.contains(GROK_ENTRY_MARKER))
}

/// A `consult` server the user set up or turned off themselves is left alone.
fn user_owns_grok_entry(doc: &toml_edit::DocumentMut) -> bool {
    let existing = doc.get("mcp_servers").and_then(|s| s.get(MCP_SERVER_NAME));
    let disabled = doc
        .get("disabled_mcp_servers")
        .and_then(|i| i.as_array())
        .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(MCP_SERVER_NAME)));
    match existing {
        Some(item) => !is_ours(item),
        None => disabled,
    }
}

fn upsert_grok_entry(doc: &mut toml_edit::DocumentMut, s: &Spec) -> Result<bool, String> {
    if user_owns_grok_entry(doc) {
        return Ok(false);
    }
    let before = doc.to_string();
    let servers = doc
        .entry("mcp_servers")
        .or_insert(toml_edit::Item::Table(toml_edit::Table::new()))
        .as_table_mut()
        .ok_or_else(|| "mcp_servers is not a table".to_string())?;
    let mut table = toml_edit::Table::new();
    table["command"] = toml_edit::value(s.node.clone());
    let mut args = toml_edit::Array::new();
    args.push(s.script.to_string_lossy().to_string());
    table["args"] = toml_edit::value(args);
    let mut env = toml_edit::InlineTable::new();
    for (k, v) in &s.env {
        env.insert(k, v.as_str().into());
    }
    table["env"] = toml_edit::Item::Value(toml_edit::Value::InlineTable(env));
    table
        .decor_mut()
        .set_prefix(format!("\n{GROK_ENTRY_MARKER} — turn off in agmux Settings)\n"));
    servers.insert(MCP_SERVER_NAME, toml_edit::Item::Table(table));
    Ok(doc.to_string() != before)
}

/// Removes only an entry agmux wrote (marked by its comment), never a
/// `consult` server the user configured themselves.
fn remove_grok_entry(doc: &mut toml_edit::DocumentMut) -> bool {
    let Some(servers) = doc.get_mut("mcp_servers").and_then(|i| i.as_table_mut()) else {
        return false;
    };
    let ours = servers.get(MCP_SERVER_NAME).is_some_and(is_ours);
    if ours {
        servers.remove(MCP_SERVER_NAME);
    }
    ours
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_spec() -> Spec {
        Spec {
            node: "/opt/node/bin/node".into(),
            script: PathBuf::from("/Applications/agmux.app/Contents/Resources/sidecar/dist/agmux-consult-mcp.bundle.mjs"),
            env: env_pairs(&ConsultIdentity { thread_id: Some("t-1"), project_id: Some("p-1") }),
        }
    }

    #[test]
    fn node_major_parses_versions() {
        assert_eq!(node_major("v22.22.3\n"), Some(22));
        assert_eq!(node_major("v18.0.0"), Some(18));
        assert_eq!(node_major("garbage"), None);
    }

    #[test]
    fn env_carries_identity_and_path() {
        let env = env_pairs(&ConsultIdentity { thread_id: Some("t-1"), project_id: Some("p-1") });
        let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"PATH"));
        assert!(keys.contains(&"AGMUX_THREAD_ID"));
        assert!(keys.contains(&"AGMUX_PROJECT_ID"));

        let shared = env_pairs(&ConsultIdentity { thread_id: None, project_id: Some("p-1") });
        assert!(!shared.iter().any(|(k, _)| k == "AGMUX_THREAD_ID"));
        assert!(!shared.iter().any(|(k, _)| k.starts_with("AGMUX_ALLOW_ACTIVE")));
    }

    #[test]
    fn codex_override_sets_timeouts_and_parses_as_toml() {
        let args = codex_override(&fake_spec());
        assert_eq!(args[0], "-c");
        let (key, value) = args[1].split_once('=').unwrap();
        assert_eq!(key, "mcp_servers.consult");
        let parsed: toml_edit::DocumentMut = format!("v = {value}").parse().unwrap();
        let table = parsed["v"].as_inline_table().unwrap();
        assert_eq!(table.get("tool_timeout_sec").and_then(|v| v.as_integer()), Some(960));
        assert_eq!(
            table.get("env").and_then(|e| e.as_inline_table()).and_then(|e| e.get("AGMUX_THREAD_ID")).and_then(|v| v.as_str()),
            Some("t-1")
        );
    }

    #[test]
    fn allowed_tools_skip_send_message() {
        let tools = claude_allowed_tools();
        assert!(tools.contains(&"mcp__consult__ask_agent".to_string()));
        assert!(!tools.iter().any(|t| t.ends_with("send_message")));
    }

    #[test]
    fn grok_entry_round_trip_keeps_other_servers() {
        let mut doc: toml_edit::DocumentMut =
            "disabled_mcp_servers = [\"other\"]\n\n[mcp_servers.other]\ncommand = \"x\"\n"
                .parse()
                .unwrap();
        assert!(upsert_grok_entry(&mut doc, &fake_spec()).unwrap());
        assert!(doc["mcp_servers"]["consult"]["command"].as_str().is_some());
        assert!(!upsert_grok_entry(&mut doc, &fake_spec()).unwrap(), "unchanged entry is not rewritten");

        assert!(remove_grok_entry(&mut doc));
        assert!(doc["mcp_servers"].get("consult").is_none());
        assert!(doc["mcp_servers"]["other"]["command"].as_str().is_some());
    }

    #[test]
    fn grok_removal_leaves_a_user_entry_alone() {
        let mut doc: toml_edit::DocumentMut =
            "[mcp_servers.consult]\ncommand = \"npx\"\n".parse().unwrap();
        assert!(!remove_grok_entry(&mut doc));
        assert!(!upsert_grok_entry(&mut doc, &fake_spec()).unwrap(), "never overwrites it");
        assert_eq!(doc["mcp_servers"]["consult"]["command"].as_str(), Some("npx"));

        let mut disabled: toml_edit::DocumentMut = "disabled_mcp_servers = [\"consult\"]\n".parse().unwrap();
        assert!(!upsert_grok_entry(&mut disabled, &fake_spec()).unwrap(), "respects the user turning it off");
    }
}
