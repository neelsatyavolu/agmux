use crate::process::provider::build_augmented_path;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tokio::fs;

const RAW_BASE: &str = "https://raw.githubusercontent.com";

// ── Public types ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub author: Option<String>,
    pub installed: bool,
    pub source: String,      // marketplace display name or repo owner
    pub marketplace: String, // marketplace ID for install/uninstall
    pub category: Option<String>,
    pub tags: Option<Vec<String>>,
}

// ── Marketplace discovery types ───────────────────────────

#[derive(Deserialize)]
struct KnownMarketplaces {
    #[serde(flatten)]
    marketplaces: HashMap<String, MarketplaceEntry>,
}

#[derive(Deserialize)]
struct MarketplaceEntry {
    source: MarketplaceSource,
}

#[derive(Deserialize)]
struct MarketplaceSource {
    repo: String,
}

// ── marketplace.json schema ───────────────────────────────

#[derive(Deserialize)]
struct MarketplaceJson {
    name: Option<String>,
    description: Option<String>,
    owner: Option<MarketplaceOwner>,
    plugins: Option<Vec<MarketplacePlugin>>,
}

#[derive(Deserialize)]
struct MarketplaceOwner {
    name: Option<String>,
}

#[derive(Deserialize)]
struct MarketplacePlugin {
    name: String,
    description: Option<String>,
    category: Option<String>,
    tags: Option<Vec<String>>,
    author: Option<PluginAuthor>,
}

// ── plugin.json schema (single-plugin repos) ─────────────

#[derive(Deserialize)]
struct PluginJson {
    name: Option<String>,
    description: Option<String>,
    author: Option<PluginAuthor>,
}

#[derive(Deserialize)]
struct PluginAuthor {
    name: Option<String>,
}

// ── For the official repo which uses directory structure ───

#[derive(Deserialize)]
struct GithubDirEntry {
    name: String,
    #[serde(rename = "type")]
    entry_type: String,
}

// ── Local file helpers ────────────────────────────────────

fn plugins_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("~"))
        .join(".claude")
        .join("plugins")
}

/// Read installed_plugins.json and return set of "{name}@{marketplace}" keys
async fn read_installed_plugins() -> HashSet<String> {
    let path = plugins_dir().join("installed_plugins.json");
    let content = match fs::read_to_string(&path).await {
        Ok(c) => c,
        Err(_) => return HashSet::new(),
    };

    let parsed: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return HashSet::new(),
    };

    let mut installed = HashSet::new();
    if let Some(plugins) = parsed.get("plugins").and_then(|v| v.as_object()) {
        for key in plugins.keys() {
            installed.insert(key.clone());
        }
    }
    installed
}

/// Read known_marketplaces.json → map of marketplace_id → github repo
async fn read_known_marketplaces() -> HashMap<String, String> {
    let path = plugins_dir().join("known_marketplaces.json");
    let content = match fs::read_to_string(&path).await {
        Ok(c) => c,
        Err(_) => return HashMap::new(),
    };

    let parsed: KnownMarketplaces = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return HashMap::new(),
    };

    parsed
        .marketplaces
        .into_iter()
        .map(|(id, entry)| (id, entry.source.repo))
        .collect()
}

// ── Fetching ──────────────────────────────────────────────

/// Try to fetch marketplace.json for a marketplace repo.
/// Returns plugin list if found, None if not a marketplace.
async fn fetch_marketplace_json(client: &reqwest::Client, repo: &str) -> Option<MarketplaceJson> {
    let url = format!("{}/{}/main/.claude-plugin/marketplace.json", RAW_BASE, repo);
    let resp = client
        .get(&url)
        .header("User-Agent", "xanom-app")
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    resp.json().await.ok()
}

/// Fetch plugin.json for a single-plugin repo
async fn fetch_plugin_json(client: &reqwest::Client, repo: &str) -> Option<PluginJson> {
    let url = format!("{}/{}/main/.claude-plugin/plugin.json", RAW_BASE, repo);
    let resp = client
        .get(&url)
        .header("User-Agent", "xanom-app")
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    resp.json().await.ok()
}

/// Fetch plugin.json for a specific plugin within the official repo's
/// plugins/ or external_plugins/ directories
async fn fetch_official_plugin_json(
    client: &reqwest::Client,
    repo: &str,
    dir: &str,
    plugin_name: &str,
) -> Option<PluginJson> {
    let url = format!(
        "{}/{}/main/{}/{}/.claude-plugin/plugin.json",
        RAW_BASE, repo, dir, plugin_name
    );
    let resp = client
        .get(&url)
        .header("User-Agent", "xanom-app")
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    resp.json().await.ok()
}

/// List directory names from a GitHub repo path via API
async fn list_github_dir(client: &reqwest::Client, repo: &str, dir: &str) -> Vec<String> {
    let url = format!("https://api.github.com/repos/{}/contents/{}", repo, dir);
    let resp = match client
        .get(&url)
        .header("User-Agent", "xanom-app")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    let entries: Vec<GithubDirEntry> = match resp.json().await {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    entries
        .into_iter()
        .filter(|e| e.entry_type == "dir")
        .map(|e| e.name)
        .collect()
}

/// Fetch all plugins from a marketplace that uses directory-based structure
/// (like claude-plugins-official with plugins/ and external_plugins/ dirs)
async fn fetch_official_marketplace_plugins(
    client: &reqwest::Client,
    marketplace_id: &str,
    repo: &str,
    installed: &HashSet<String>,
) -> Vec<SkillInfo> {
    // Fetch both directory listings in parallel
    let (official_names, community_names) = tokio::join!(
        list_github_dir(client, repo, "plugins"),
        list_github_dir(client, repo, "external_plugins"),
    );

    let mut handles = Vec::new();

    for name in official_names {
        let client = client.clone();
        let repo = repo.to_string();
        let n = name.clone();
        handles.push(tokio::spawn(async move {
            let meta = fetch_official_plugin_json(&client, &repo, "plugins", &n).await;
            (n, "Official".to_string(), meta)
        }));
    }

    for name in community_names {
        let client = client.clone();
        let repo = repo.to_string();
        let n = name.clone();
        handles.push(tokio::spawn(async move {
            let meta = fetch_official_plugin_json(&client, &repo, "external_plugins", &n).await;
            (n, "Community".to_string(), meta)
        }));
    }

    let mut skills = Vec::new();
    for handle in handles {
        if let Ok((name, source, meta)) = handle.await {
            let install_key = format!("{}@{}", name, marketplace_id);
            skills.push(SkillInfo {
                name: meta
                    .as_ref()
                    .and_then(|m| m.name.clone())
                    .unwrap_or_else(|| name.clone()),
                description: meta
                    .as_ref()
                    .and_then(|m| m.description.clone())
                    .unwrap_or_default(),
                author: meta
                    .as_ref()
                    .and_then(|m| m.author.as_ref())
                    .and_then(|a| a.name.clone()),
                installed: installed.contains(&install_key),
                source,
                marketplace: marketplace_id.to_string(),
                category: Some("Plugins".to_string()),
                tags: None,
            });
        }
    }

    skills
}

// ── Commands ──────────────────────────────────────────────

#[tauri::command]
pub async fn list_skills() -> Result<Vec<SkillInfo>, String> {
    let client = reqwest::Client::new();

    // Read local state
    let (installed, marketplaces) =
        tokio::join!(read_installed_plugins(), read_known_marketplaces(),);

    // Always include the official marketplace
    let mut all_marketplaces = marketplaces.clone();
    all_marketplaces
        .entry("claude-plugins-official".to_string())
        .or_insert_with(|| "anthropics/claude-plugins-official".to_string());
    all_marketplaces
        .entry("skills".to_string())
        .or_insert_with(|| "anthropics/skills".to_string());

    // Fetch from all marketplaces in parallel
    let mut handles = Vec::new();

    for (marketplace_id, repo) in &all_marketplaces {
        let client = client.clone();
        let mid = marketplace_id.clone();
        let repo = repo.clone();
        let installed = installed.clone();

        handles.push(tokio::spawn(async move {
            // First try marketplace.json (multi-plugin marketplace)
            if let Some(mkt) = fetch_marketplace_json(&client, &repo).await {
                if let Some(plugins) = mkt.plugins {
                    let owner_name = mkt.owner.and_then(|o| o.name).unwrap_or_default();
                    let mkt_name = mkt.name.unwrap_or_else(|| mid.clone());
                    return plugins
                        .into_iter()
                        .map(|p| {
                            let install_key = format!("{}@{}", p.name, mid);
                            let author = p.author.and_then(|a| a.name).or_else(|| {
                                if owner_name.is_empty() {
                                    None
                                } else {
                                    Some(owner_name.clone())
                                }
                            });
                            SkillInfo {
                                name: p.name,
                                description: p.description.unwrap_or_default(),
                                author,
                                installed: installed.contains(&install_key),
                                source: mkt_name.clone(),
                                marketplace: mid.clone(),
                                category: p.category.map(|c| {
                                    // Capitalize first letter
                                    let mut chars = c.chars();
                                    match chars.next() {
                                        Some(f) => f.to_uppercase().to_string() + chars.as_str(),
                                        None => c,
                                    }
                                }),
                                tags: p.tags,
                            }
                        })
                        .collect::<Vec<_>>();
                }
            }

            // Check if it's the official repo with directory structure
            if repo == "anthropics/claude-plugins-official" {
                return fetch_official_marketplace_plugins(&client, &mid, &repo, &installed).await;
            }

            // Try plugin.json (single-plugin repo)
            if let Some(plugin) = fetch_plugin_json(&client, &repo).await {
                let name = plugin.name.unwrap_or_else(|| mid.clone());
                let install_key = format!("{}@{}", name, mid);
                return vec![SkillInfo {
                    name,
                    description: plugin.description.unwrap_or_default(),
                    author: plugin.author.and_then(|a| a.name),
                    installed: installed.contains(&install_key),
                    source: mid.clone(),
                    marketplace: mid.clone(),
                    category: Some("Plugins".to_string()),
                    tags: None,
                }];
            }

            Vec::new()
        }));
    }

    let mut skills = Vec::new();
    for handle in handles {
        match handle.await {
            Ok(batch) => skills.extend(batch),
            Err(e) => tracing::warn!("Failed to fetch marketplace: {}", e),
        }
    }

    // Sort: installed first, then alphabetical
    skills.sort_by(|a, b| {
        b.installed
            .cmp(&a.installed)
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(skills)
}

// ── Slash command discovery ──────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeCommandInfo {
    pub name: String,
    pub description: String,
    pub source: String, // "built-in", "user", "project", or plugin name
}

/// Discover available Claude Code slash commands from filesystem:
/// - User commands: ~/.claude/commands/*.md
/// - Project commands: {work_dir}/.claude/commands/*.md
/// - Plugin commands: ~/.claude/plugins/cache/{plugin}/{plugin}/{version}/commands/*.md
#[tauri::command]
pub async fn list_claude_commands(work_dir: String) -> Result<Vec<ClaudeCommandInfo>, String> {
    let mut commands = Vec::new();
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Ok(commands),
    };

    // 1. User-level commands: ~/.claude/commands/*.md
    let user_cmds_dir = home.join(".claude").join("commands");
    if let Ok(mut entries) = fs::read_dir(&user_cmds_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    let desc = read_md_description(&path).await;
                    commands.push(ClaudeCommandInfo {
                        name: format!("/{}", stem),
                        description: desc,
                        source: "user".to_string(),
                    });
                }
            }
        }
    }

    // 2. Project-level commands: {work_dir}/.claude/commands/*.md
    let project_cmds_dir = PathBuf::from(&work_dir).join(".claude").join("commands");
    if let Ok(mut entries) = fs::read_dir(&project_cmds_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    let desc = read_md_description(&path).await;
                    commands.push(ClaudeCommandInfo {
                        name: format!("/{}", stem),
                        description: desc,
                        source: "project".to_string(),
                    });
                }
            }
        }
    }

    // 3. User-level skills: ~/.claude/skills/*/SKILL.md
    let user_skills_dir = home.join(".claude").join("skills");
    if let Ok(mut entries) = fs::read_dir(&user_skills_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill_file = path.join("SKILL.md");
            if let Ok(content) = fs::read_to_string(&skill_file).await {
                if let Some((name, desc)) = parse_skill_frontmatter(&content) {
                    let cmd_name = format!("/{}", name);
                    commands.push(ClaudeCommandInfo {
                        name: cmd_name,
                        description: desc,
                        source: "skill".to_string(),
                    });
                }
            }
        }
    }

    // 4. Project-level skills: {work_dir}/.claude/skills/*/SKILL.md
    let project_skills_dir = PathBuf::from(&work_dir).join(".claude").join("skills");
    if let Ok(mut entries) = fs::read_dir(&project_skills_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill_file = path.join("SKILL.md");
            if let Ok(content) = fs::read_to_string(&skill_file).await {
                if let Some((name, desc)) = parse_skill_frontmatter(&content) {
                    let cmd_name = format!("/{}", name);
                    commands.push(ClaudeCommandInfo {
                        name: cmd_name,
                        description: desc,
                        source: "project-skill".to_string(),
                    });
                }
            }
        }
    }

    // 5. Plugin commands: ~/.claude/plugins/cache/{plugin}/{plugin}/{version}/commands/*.md
    //    Use a HashSet to deduplicate across multiple versions of the same plugin.
    let mut seen_names = HashSet::new();
    // Also deduplicate user/project commands and skills already added
    for cmd in &commands {
        seen_names.insert(cmd.name.clone());
    }

    let plugins_cache = home.join(".claude").join("plugins").join("cache");
    if let Ok(mut marketplaces) = fs::read_dir(&plugins_cache).await {
        while let Ok(Some(marketplace_entry)) = marketplaces.next_entry().await {
            let marketplace_name = marketplace_entry.file_name().to_string_lossy().to_string();
            let marketplace_path = marketplace_entry.path();

            // Look inside {marketplace}/{plugin}/{version}/commands/
            if let Ok(mut plugins) = fs::read_dir(&marketplace_path).await {
                while let Ok(Some(plugin_entry)) = plugins.next_entry().await {
                    let plugin_name = plugin_entry.file_name().to_string_lossy().to_string();
                    let plugin_path = plugin_entry.path();

                    // Find the latest version dir (sort and take last)
                    let mut version_dirs = Vec::new();
                    if let Ok(mut versions) = fs::read_dir(&plugin_path).await {
                        while let Ok(Some(version_entry)) = versions.next_entry().await {
                            version_dirs.push(version_entry.path());
                        }
                    }
                    version_dirs.sort();
                    // Only scan the latest version
                    if let Some(latest_version) = version_dirs.last() {
                        let display_source = if marketplace_name == plugin_name {
                            plugin_name.clone()
                        } else {
                            format!("{}/{}", marketplace_name, plugin_name)
                        };

                        // Scan commands/*.md
                        let cmds_dir = latest_version.join("commands");
                        if let Ok(mut cmd_entries) = fs::read_dir(&cmds_dir).await {
                            while let Ok(Some(cmd_entry)) = cmd_entries.next_entry().await {
                                let cmd_path = cmd_entry.path();
                                if cmd_path.extension().and_then(|e| e.to_str()) == Some("md") {
                                    if let Some(stem) =
                                        cmd_path.file_stem().and_then(|s| s.to_str())
                                    {
                                        let cmd_name = format!("/{}:{}", plugin_name, stem);
                                        if seen_names.contains(&cmd_name) {
                                            continue;
                                        }
                                        seen_names.insert(cmd_name.clone());
                                        let desc = read_md_description(&cmd_path).await;
                                        commands.push(ClaudeCommandInfo {
                                            name: cmd_name,
                                            description: desc,
                                            source: display_source.clone(),
                                        });
                                    }
                                }
                            }
                        }

                        // Scan skills/*/SKILL.md
                        let skills_dir = latest_version.join("skills");
                        if let Ok(mut skill_entries) = fs::read_dir(&skills_dir).await {
                            while let Ok(Some(skill_entry)) = skill_entries.next_entry().await {
                                let skill_path = skill_entry.path();
                                if !skill_path.is_dir() {
                                    continue;
                                }
                                let skill_file = skill_path.join("SKILL.md");
                                if let Ok(content) = fs::read_to_string(&skill_file).await {
                                    if let Some((name, desc)) = parse_skill_frontmatter(&content) {
                                        let cmd_name = format!("/{}:{}", plugin_name, name);
                                        if seen_names.contains(&cmd_name) {
                                            continue;
                                        }
                                        seen_names.insert(cmd_name.clone());
                                        commands.push(ClaudeCommandInfo {
                                            name: cmd_name,
                                            description: desc,
                                            source: display_source.clone(),
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    commands.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(commands)
}

/// Parse YAML frontmatter from a SKILL.md file to extract name and description.
fn parse_skill_frontmatter(content: &str) -> Option<(String, String)> {
    let mut in_frontmatter = false;
    let mut name = None;
    let mut description = None;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "---" {
            if in_frontmatter {
                break; // End of frontmatter
            }
            in_frontmatter = true;
            continue;
        }
        if !in_frontmatter {
            continue;
        }
        if let Some(val) = trimmed.strip_prefix("name:") {
            name = Some(val.trim().trim_matches('"').trim_matches('\'').to_string());
        } else if let Some(val) = trimmed.strip_prefix("description:") {
            let desc = val.trim().trim_matches('"').trim_matches('\'').to_string();
            // Truncate long descriptions
            description = Some(if desc.chars().count() > 120 {
                let truncated: String = desc.chars().take(120).collect();
                format!("{}…", truncated)
            } else {
                desc
            });
        }
    }

    name.map(|n| (n, description.unwrap_or_default()))
}

/// Read the first non-empty, non-frontmatter line from an .md file as a description
async fn read_md_description(path: &std::path::Path) -> String {
    let content = match fs::read_to_string(path).await {
        Ok(c) => c,
        Err(_) => return String::new(),
    };

    let mut in_frontmatter = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "---" {
            in_frontmatter = !in_frontmatter;
            continue;
        }
        if in_frontmatter {
            continue;
        }
        // Skip headings and empty lines
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // Return first meaningful line, truncated
        let desc = if trimmed.chars().count() > 120 {
            let truncated: String = trimmed.chars().take(120).collect();
            format!("{}…", truncated)
        } else {
            trimmed.to_string()
        };
        return desc;
    }
    String::new()
}

#[tauri::command]
pub async fn install_skill(name: String, marketplace: String) -> Result<(), String> {
    let plugin_ref = format!("{}@{}", name, marketplace);
    let path_env = build_augmented_path();

    let output = tokio::process::Command::new("claude")
        .args(["plugin", "install", &plugin_ref, "--scope", "user", "-y"])
        .env("PATH", &path_env)
        .output()
        .await
        .map_err(|e| format!("Failed to run claude CLI: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "Install failed: {}{}",
            stderr,
            if stdout.is_empty() {
                String::new()
            } else {
                format!("\n{}", stdout)
            }
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn uninstall_skill(name: String, marketplace: String) -> Result<(), String> {
    let plugin_ref = format!("{}@{}", name, marketplace);
    let path_env = build_augmented_path();

    let output = tokio::process::Command::new("claude")
        .args(["plugin", "uninstall", &plugin_ref, "-y"])
        .env("PATH", &path_env)
        .output()
        .await
        .map_err(|e| format!("Failed to run claude CLI: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "Uninstall failed: {}{}",
            stderr,
            if stdout.is_empty() {
                String::new()
            } else {
                format!("\n{}", stdout)
            }
        ));
    }

    Ok(())
}
