//! Draft-composer defaults mirrored from the desktop for the phone PWA.
//!
//! Desktop DraftChatView persists `defaultProvider` / `lastUsedModel` /
//! `lastUsedEffort` in webview localStorage. The frontend also writes them
//! here so every catalog push can seed the remote new-chat picker.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDraftPrefs {
    /// ClaudeCode | Codex | Grok | Gemini | OpenCode | Cursor (remote draft allow-list).
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// Last permission mode from desktop or phone (default | auto | full).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
}

pub fn draft_prefs_path() -> Option<PathBuf> {
    Some(crate::paths::agmux_home_opt()?.join("remote-draft-prefs.json"))
}

pub fn load_draft_prefs() -> Option<RemoteDraftPrefs> {
    let path = draft_prefs_path()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let mut prefs: RemoteDraftPrefs = serde_json::from_str(&raw).ok()?;
    normalize_remote_provider(&mut prefs);
    if prefs.provider.is_empty() || prefs.model.is_empty() {
        return None;
    }
    Some(prefs)
}

/// Keep last-used permission for new chats without clobbering provider/model.
pub fn remember_permission_mode(mode: &str) {
    let mode = mode.trim();
    if mode.is_empty() {
        return;
    }
    let Some(mut prefs) = load_draft_prefs() else {
        return;
    };
    prefs.permission_mode = Some(mode.to_string());
    let _ = save_draft_prefs(&prefs);
}

pub fn save_draft_prefs(prefs: &RemoteDraftPrefs) -> Result<(), String> {
    let path = draft_prefs_path().ok_or_else(|| "no home dir".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut cleaned = prefs.clone();
    normalize_remote_provider(&mut cleaned);
    if cleaned.provider.is_empty() || cleaned.model.is_empty() {
        return Err("provider and model required".into());
    }
    let json = serde_json::to_string_pretty(&cleaned).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Providers the phone can start a chat with (`dispatch::create_chat_thread`).
/// Terminal-only providers are started on the Mac, so a last-used one of those
/// falls back to Claude.
fn normalize_remote_provider(prefs: &mut RemoteDraftPrefs) {
    let provider = prefs.provider.clone();
    match provider.as_str() {
        "ClaudeCode" | "Codex" | "Grok" | "Gemini" | "OpenCode" | "Cursor" => {}
        "claude" | "Claude" => prefs.provider = "ClaudeCode".into(),
        "codex" => prefs.provider = "Codex".into(),
        "grok" => prefs.provider = "Grok".into(),
        "gemini" => prefs.provider = "Gemini".into(),
        "opencode" | "Open Code" => prefs.provider = "OpenCode".into(),
        "cursor" => prefs.provider = "Cursor".into(),
        // Unknown or terminal-only desktop last-use — fall back to Claude.
        _ => {
            prefs.provider = "ClaudeCode".into();
            if prefs.model.is_empty()
                || prefs.model.contains('/')
                || prefs.model.starts_with("gpt-")
                || prefs.model.starts_with("grok")
                || !matches!(provider.to_ascii_lowercase().as_str(), "" | "claudecode")
            {
                prefs.model = "sonnet".into();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_opencode_on_allowlist() {
        let mut p = RemoteDraftPrefs {
            provider: "OpenCode".into(),
            model: "anthropic/claude-sonnet-4-5".into(),
            reasoning_effort: Some("high".into()),
            permission_mode: Some("full".into()),
        };
        normalize_remote_provider(&mut p);
        assert_eq!(p.provider, "OpenCode");
        assert_eq!(p.model, "anthropic/claude-sonnet-4-5");
    }

    #[test]
    fn terminal_only_last_use_falls_back_to_claude() {
        for prov in ["Kimi", "Pi", "MLX", "local", "Droid"] {
            let mut p = RemoteDraftPrefs {
                provider: prov.into(),
                model: "kimi-k2".into(),
                reasoning_effort: None,
                permission_mode: None,
            };
            normalize_remote_provider(&mut p);
            assert_eq!(p.provider, "ClaudeCode", "{prov}");
            assert_eq!(p.model, "sonnet", "{prov}");
        }
    }

    #[test]
    fn keeps_remote_allowlist_providers() {
        for prov in ["ClaudeCode", "Codex", "Grok", "Gemini", "OpenCode", "Cursor"] {
            let mut p = RemoteDraftPrefs {
                provider: prov.into(),
                model: "x".into(),
                reasoning_effort: None,
                permission_mode: None,
            };
            normalize_remote_provider(&mut p);
            assert_eq!(p.provider, prov);
            assert_eq!(p.model, "x");
        }
    }
}
