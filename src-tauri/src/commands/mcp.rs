use crate::process::provider::build_augmented_path;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::process::Command;

#[derive(Debug, Serialize, Deserialize)]
pub struct McpServerInfo {
    pub name: String,
    pub transport: String, // "stdio" | "sse" | "http"
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub url: Option<String>,
    pub env: Option<HashMap<String, String>>,
    pub scope: String,               // "claude.ai" | "plugin" | "local" | "codex"
    pub project_path: Option<String>,
    pub status: Option<String>,      // "connected" | "needs_auth" | "error" | null
}

/// Parse `claude mcp list` CLI output into McpServerInfo entries.
/// Each line after the header has format:
///   name: command_or_url [(transport)] - status_icon status_text
///
/// Public so Cowork session setup can load the same Claude.ai connectors.
pub fn parse_claude_mcp_list_output(output: &str) -> Vec<McpServerInfo> {
    let mut result = Vec::new();

    for line in output.lines() {
        let line = line.trim();
        // Skip header, empty lines, blank lines
        if line.is_empty()
            || line.starts_with("Checking")
            || line.starts_with("Note:")
            || !line.contains(": ")
        {
            continue;
        }

        // Split on first ": " to get name and the rest
        let (name, rest) = match line.split_once(": ") {
            Some(parts) => parts,
            None => continue,
        };

        // Split rest on " - " from the right to separate command/url from status
        let (cmd_part, status) = match rest.rfind(" - ") {
            Some(idx) => {
                let cmd = rest[..idx].trim();
                let stat = rest[idx + 3..].trim();
                (cmd, Some(stat))
            }
            None => (rest.trim(), None),
        };

        // Detect transport from trailing (HTTP) or (SSE)
        let (cmd_clean, transport) = if cmd_part.ends_with("(HTTP)") {
            (cmd_part.trim_end_matches("(HTTP)").trim(), "http")
        } else if cmd_part.ends_with("(SSE)") {
            (cmd_part.trim_end_matches("(SSE)").trim(), "sse")
        } else if cmd_part.starts_with("http://") || cmd_part.starts_with("https://") {
            (cmd_part, "sse")
        } else {
            (cmd_part, "stdio")
        };

        // Determine scope from name prefix
        let scope = if name.starts_with("claude.ai ") {
            "claude.ai"
        } else if name.starts_with("plugin:") {
            "plugin"
        } else {
            "local"
        };

        // Parse status
        let status_str = status.map(|s| {
            if s.contains('✓') || s.contains("Connected") {
                "connected".to_string()
            } else if s.contains('!') || s.contains("Needs") {
                "needs_auth".to_string()
            } else {
                "error".to_string()
            }
        });

        // For stdio: first word is command, rest are implicit args
        let (command, url) = if transport == "stdio" {
            (Some(cmd_clean.to_string()), None)
        } else {
            (None, Some(cmd_clean.to_string()))
        };

        result.push(McpServerInfo {
            name: name.to_string(),
            transport: transport.to_string(),
            command,
            args: None,
            url,
            env: None,
            scope: scope.to_string(),
            project_path: None,
            status: status_str,
        });
    }

    result
}

/// Parse mcp_servers from Codex's config.toml (TOML format).
async fn parse_codex_config_toml(path: &std::path::Path) -> Vec<McpServerInfo> {
    let content = match tokio::fs::read_to_string(path).await {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    let parsed: toml::Value = match content.parse() {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let servers_table = match parsed.get("mcp_servers").and_then(|v| v.as_table()) {
        Some(t) => t,
        None => return vec![],
    };

    let mut result = Vec::new();
    for (name, config) in servers_table {
        let table = match config.as_table() {
            Some(t) => t,
            None => continue,
        };

        let has_url = table.get("url").is_some();
        let transport = if has_url { "sse".to_string() } else { "stdio".to_string() };

        let command = table
            .get("command")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let args = table.get("args").and_then(|v| v.as_array()).map(|arr| {
            arr.iter()
                .filter_map(|a| a.as_str())
                .map(|s| s.to_string())
                .collect::<Vec<String>>()
        });

        let url = table
            .get("url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let env = table.get("env").and_then(|v| v.as_table()).map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect::<HashMap<String, String>>()
        });

        result.push(McpServerInfo {
            name: name.clone(),
            transport,
            command,
            args,
            url,
            env,
            scope: "codex".to_string(),
            project_path: None,
            status: None,
        });
    }
    result
}

#[tauri::command]
pub async fn list_mcp_servers() -> Result<Vec<McpServerInfo>, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    let augmented_path = build_augmented_path();

    let mut result = Vec::new();

    // 1. Claude MCPs: parse `claude mcp list` output (single source of truth)
    let claude_output = Command::new("claude")
        .args(["mcp", "list"])
        .env("PATH", &augmented_path)
        .output()
        .await;

    if let Ok(output) = claude_output {
        let stdout = String::from_utf8_lossy(&output.stdout);
        result.extend(parse_claude_mcp_list_output(&stdout));
    }

    // 2. Codex MCPs: parse ~/.codex/config.toml
    let codex_config = home.join(".codex").join("config.toml");
    result.extend(parse_codex_config_toml(&codex_config).await);

    Ok(result)
}

#[tauri::command]
pub async fn remove_mcp_server(name: String) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Server name must not be empty".to_string());
    }

    let augmented_path = build_augmented_path();

    let output = Command::new("claude")
        .args(["mcp", "remove", "-s", "user", &name])
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run claude mcp remove: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "claude mcp remove failed (exit {}): {}{}",
            output.status.code().unwrap_or(-1),
            stderr,
            stdout
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn add_mcp_server(
    name: String,
    transport: String,
    command_or_url: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    scope: String,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Server name must not be empty".to_string());
    }
    if command_or_url.trim().is_empty() {
        return Err("command_or_url must not be empty".to_string());
    }

    let valid_scopes = ["user", "project", "local"];
    if !valid_scopes.contains(&scope.as_str()) {
        return Err(format!(
            "Invalid scope '{}'. Must be one of: user, project, local",
            scope
        ));
    }

    let augmented_path = build_augmented_path();

    // Build base args
    let mut cmd_args: Vec<String> = vec!["mcp".to_string(), "add".to_string()];

    // Scope flag
    cmd_args.push("-s".to_string());
    cmd_args.push(scope.clone());

    // Transport flag (for non-stdio)
    let transport_lower = transport.to_lowercase();
    if transport_lower == "sse" || transport_lower == "http" {
        cmd_args.push("-t".to_string());
        cmd_args.push(transport_lower.clone());
    }

    // Env flags
    for (key, value) in &env {
        cmd_args.push("-e".to_string());
        cmd_args.push(format!("{}={}", key, value));
    }

    // Server name
    cmd_args.push(name.clone());

    if transport_lower == "sse" || transport_lower == "http" {
        // SSE/HTTP: next arg is the URL
        cmd_args.push(command_or_url.clone());
    } else {
        // stdio: separator then command and args
        cmd_args.push("--".to_string());
        cmd_args.push(command_or_url.clone());
        cmd_args.extend(args.iter().cloned());
    }

    let output = Command::new("claude")
        .args(&cmd_args)
        .env("PATH", &augmented_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run claude mcp add: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "claude mcp add failed (exit {}): {}{}",
            output.status.code().unwrap_or(-1),
            stderr,
            stdout
        ));
    }

    Ok(())
}

/// Scan the installed `claude` CLI for `/model` catalog slugs.
/// Empty when the binary is missing or unreadable — the UI falls back to
/// its static list. Cached in-process by binary mtime.
#[tauri::command]
pub async fn claude_list_models() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(|| {
        crate::process::provider::resolve_cli_path("claude")
            .map(|path| crate::process::claude_models::list_claude_model_slugs_from_path(&path))
            .unwrap_or_default()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Read the default model from Claude Code's settings.json / settings.local.json.
/// Returns the model slug string, or null if not configured.
#[tauri::command]
pub async fn get_claude_default_model() -> Result<Option<String>, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;

    // settings.local.json takes precedence over settings.json
    for filename in &["settings.local.json", "settings.json"] {
        let path = home.join(".claude").join(filename);
        if !path.exists() {
            continue;
        }
        let content = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| format!("Failed to read {filename}: {e}"))?;
        let parsed: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse {filename}: {e}"))?;
        if let Some(model) = parsed.get("model").and_then(|v| v.as_str()) {
            return Ok(Some(model.to_string()));
        }
    }

    Ok(None)
}

/// Read the current reasoning effort from Claude Code's settings.json / settings.local.json.
/// Returns "low", "medium", or "high", or null if not configured.
#[tauri::command]
pub async fn get_claude_effort() -> Result<Option<String>, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;

    for filename in &["settings.local.json", "settings.json"] {
        let path = home.join(".claude").join(filename);
        if !path.exists() {
            continue;
        }
        let content = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| format!("Failed to read {filename}: {e}"))?;
        let parsed: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse {filename}: {e}"))?;
        // Claude CLI stores effort as top-level "effortLevel"; fall back to legacy "preferences.reasoning_effort"
        let effort = parsed
            .get("effortLevel")
            .or_else(|| parsed.get("preferences").and_then(|p| p.get("reasoning_effort")))
            .and_then(|v| v.as_str());
        if let Some(e) = effort {
            return Ok(Some(e.to_string()));
        }
    }

    Ok(None)
}

/// Set the reasoning effort in Claude Code's settings.local.json.
/// Valid values: "low", "medium", "high". Pass null to remove the setting.
#[tauri::command]
pub async fn set_claude_effort(effort: Option<String>) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    let path = home.join(".claude").join("settings.local.json");
    set_claude_effort_at(&path, effort).await
}

async fn set_claude_effort_at(path: &std::path::Path, effort: Option<String>) -> Result<(), String> {
    // Validate effort value.
    // Claude CLI / Agent SDK accepts low | medium | high | xhigh | max on
    // effort-capable models (Opus 4.7, Opus 4.6, Sonnet 4.6). "max" is
    // session-scoped (uncapped reasoning for the current session only)
    // unless written here via CLAUDE_CODE_EFFORT_LEVEL / effortLevel, which
    // the user has explicitly opted into by selecting it in the UI.
    if let Some(ref e) = effort {
        if !["low", "medium", "high", "xhigh", "max"].contains(&e.as_str()) {
            return Err(format!(
                "Invalid effort value: {e}. Must be low, medium, high, xhigh, or max."
            ));
        }
    }

    // Read existing settings or start fresh
    let mut settings: serde_json::Value = if path.exists() {
        let content = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| format!("Failed to read settings.local.json: {e}"))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse settings.local.json: {e}"))?
    } else {
        serde_json::json!({})
    };

    let root = settings.as_object_mut()
        .ok_or_else(|| "settings.local.json must contain a JSON object".to_string())?;

    // Write as top-level "effortLevel" to match Claude CLI's format.
    // Also clean up the legacy "preferences.reasoning_effort" key if present.
    match effort {
        Some(e) => {
            root.insert("effortLevel".to_string(), serde_json::Value::String(e));
        }
        None => {
            root.remove("effortLevel");
        }
    }
    if let Some(prefs) = root.get_mut("preferences").and_then(|p| p.as_object_mut()) {
        prefs.remove("reasoning_effort");
    }

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create .claude directory: {e}"))?;
    }

    let serialized = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;
    tokio::fs::write(&path, serialized)
        .await
        .map_err(|e| format!("Failed to write settings.local.json: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::set_claude_effort_at;

    #[tokio::test]
    async fn effort_rejects_non_object_settings_without_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.local.json");
        for content in ["null", "[]", "true", "42", "\"settings\""] {
            for effort in [Some("high".to_string()), None] {
                tokio::fs::write(&path, content).await.unwrap();
                let result = set_claude_effort_at(&path, effort).await;
                assert!(result.is_err(), "accepted non-object settings: {content}");
                assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), content);
            }
        }
    }

    #[tokio::test]
    async fn effort_preserves_other_settings_and_supports_removal() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.local.json");
        tokio::fs::write(&path, r#"{"model":"opus","preferences":{"reasoning_effort":"low","other":true}}"#)
            .await.unwrap();

        set_claude_effort_at(&path, Some("high".to_string())).await.unwrap();
        let settings: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(&path).await.unwrap(),
        ).unwrap();
        assert_eq!(settings, serde_json::json!({
            "model": "opus", "effortLevel": "high", "preferences": {"other": true}
        }));

        set_claude_effort_at(&path, None).await.unwrap();
        let settings: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(&path).await.unwrap(),
        ).unwrap();
        assert_eq!(settings, serde_json::json!({"model": "opus", "preferences": {"other": true}}));
    }

    #[tokio::test]
    async fn effort_creates_missing_settings_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude/settings.local.json");
        set_claude_effort_at(&path, Some("medium".to_string())).await.unwrap();
        let settings: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(&path).await.unwrap(),
        ).unwrap();
        assert_eq!(settings, serde_json::json!({"effortLevel": "medium"}));
    }
}
