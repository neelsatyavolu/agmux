//! Read `~/.codex/config.toml` so ChatGPT Work threads keep the same MCP
//! servers and plugins as Codex CLI / ChatGPT.app.

use std::path::PathBuf;

/// Codex home: `$CODEX_HOME` or `~/.codex`.
pub fn codex_home() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("CODEX_HOME") {
        let p = PathBuf::from(raw);
        if !p.as_os_str().is_empty() {
            return Some(p);
        }
    }
    Some(dirs::home_dir()?.join(".codex"))
}

pub fn codex_config_path() -> Option<PathBuf> {
    Some(codex_home()?.join("config.toml"))
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CodexCliIntegrations {
    pub mcp_servers: Vec<String>,
    pub plugins: Vec<String>,
}

impl CodexCliIntegrations {
    pub fn is_empty(&self) -> bool {
        self.mcp_servers.is_empty() && self.plugins.is_empty()
    }

    /// Short developer note appended to the Work system prompt so the model
    /// knows CLI MCP/plugins are still available after `baseInstructions`.
    pub fn prompt_note(&self) -> Option<String> {
        if self.is_empty() {
            return None;
        }
        let mut lines = vec![
            "# Codex CLI MCP servers and plugins".to_string(),
            "This session uses the same MCP servers and plugins as Codex CLI and the Codex desktop app (`~/.codex/config.toml`). They are available as tools — use them the same way you would in a regular Codex chat. Do not assume they are missing because this is ChatGPT Work.".to_string(),
        ];
        if !self.mcp_servers.is_empty() {
            lines.push(format!("MCP servers: {}.", self.mcp_servers.join(", ")));
        }
        if !self.plugins.is_empty() {
            lines.push(format!("Plugins: {}.", self.plugins.join(", ")));
        }
        Some(lines.join("\n"))
    }
}

pub fn parse_codex_cli_integrations(toml_text: &str) -> CodexCliIntegrations {
    let Ok(doc) = toml_text.parse::<toml::Value>() else {
        return CodexCliIntegrations::default();
    };
    let mut out = CodexCliIntegrations::default();
    if let Some(table) = doc.get("mcp_servers").and_then(|v| v.as_table()) {
        let mut names: Vec<String> = table.keys().cloned().collect();
        names.sort();
        out.mcp_servers = names;
    }
    if let Some(table) = doc.get("plugins").and_then(|v| v.as_table()) {
        let mut names: Vec<String> = table
            .iter()
            .filter(|(_, v)| plugin_enabled(v))
            .map(|(k, _)| k.clone())
            .collect();
        names.sort();
        out.plugins = names;
    }
    out
}

fn plugin_enabled(value: &toml::Value) -> bool {
    match value {
        toml::Value::Table(t) => t
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
        _ => true,
    }
}

pub fn load_codex_cli_integrations() -> CodexCliIntegrations {
    let Some(path) = codex_config_path() else {
        return CodexCliIntegrations::default();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return CodexCliIntegrations::default();
    };
    parse_codex_cli_integrations(&text)
}

/// Append the CLI MCP/plugin note to a Work `baseInstructions` string.
pub fn with_cli_mcp_note(base_instructions: &str) -> String {
    match load_codex_cli_integrations().prompt_note() {
        Some(note) => format!("{}\n\n{}", base_instructions.trim_end(), note),
        None => base_instructions.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_lists_mcp_and_enabled_plugins() {
        let toml = r#"
[mcp_servers.firecrawl]
command = "npx"

[mcp_servers.aside]
command = "aside"

[plugins."slack@openai-curated"]
enabled = true

[plugins."github@openai-curated"]
enabled = false

[plugins."browser@openai-bundled"]
enabled = true
"#;
        let got = parse_codex_cli_integrations(toml);
        assert_eq!(got.mcp_servers, vec!["aside", "firecrawl"]);
        assert_eq!(
            got.plugins,
            vec!["browser@openai-bundled", "slack@openai-curated"]
        );
        let note = got.prompt_note().expect("note");
        assert!(note.contains("aside"));
        assert!(note.contains("firecrawl"));
        assert!(note.contains("slack@openai-curated"));
        assert!(!note.contains("github@openai-curated"));
    }

    #[test]
    fn empty_config_has_no_note() {
        assert!(parse_codex_cli_integrations("model = \"gpt-5\"").prompt_note().is_none());
    }
}
