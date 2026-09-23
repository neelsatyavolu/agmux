//! Display titles for remote session list.
//!
//! Desktop keeps LLM-summarized names in the webview `localStorage`
//! (`xanom-session-names`). The frontend mirrors that map to
//! `~/.agmux/session-names.json` so the outbound remote bridge can ship
//! the same titles the sidebar shows.

use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

pub fn session_names_path() -> Option<PathBuf> {
    Some(crate::paths::agmux_home_opt()?.join("session-names.json"))
}

/// Load `{ threadId: "Summarized title" }` from the frontend mirror file.
pub fn load_session_display_names() -> HashMap<String, String> {
    let Some(path) = session_names_path() else {
        return HashMap::new();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    parse_names_json(&raw)
}

pub fn parse_names_json(raw: &str) -> HashMap<String, String> {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return HashMap::new();
    };
    let Some(obj) = value.as_object() else {
        return HashMap::new();
    };
    let mut out = HashMap::with_capacity(obj.len());
    for (k, v) in obj {
        if let Some(s) = v.as_str() {
            let t = s.trim();
            if !t.is_empty() {
                out.insert(k.clone(), t.to_string());
            }
        }
    }
    out
}

/// Atomically write the full names map (frontend is source of truth).
pub fn save_session_display_names(names: &HashMap<String, String>) -> Result<(), String> {
    let path = session_names_path().ok_or_else(|| "no home dir".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(names).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Placeholder / auto-generated titles the sidebar would hide in favor of a summary.
pub fn is_placeholder_title(name: &str) -> bool {
    let n = name.trim();
    if n.is_empty() || n.eq_ignore_ascii_case("untitled") {
        return true;
    }
    let lower = n.to_ascii_lowercase();
    lower.starts_with("new grok")
        || lower.starts_with("new claude")
        || lower.starts_with("new codex")
        || lower.starts_with("new opencode")
        || lower.starts_with("new cursor")
        || lower.starts_with("claude code #")
        || lower.starts_with("claude chat #")
        || lower.starts_with("codex #")
        || lower.starts_with("codex chat #")
        || lower.starts_with("grok #")
        || lower == "new thread"
}

/// Prefer summarized title, then non-placeholder DB name, else a cleaned prompt fallback.
pub fn resolve_title(
    thread_id: &str,
    db_name: &str,
    names: &HashMap<String, String>,
    prompt_fallback: Option<&str>,
) -> String {
    resolve_title_aliased(thread_id, &[], db_name, names, prompt_fallback)
}

/// Like [`resolve_title`], also trying provider session ids (sdk / opencode).
/// Desktop `session-names` may be keyed by either agmux thread id or the
/// provider session id (same dual-key as unread).
pub fn resolve_title_aliased(
    thread_id: &str,
    alt_ids: &[&str],
    db_name: &str,
    names: &HashMap<String, String>,
    prompt_fallback: Option<&str>,
) -> String {
    for id in std::iter::once(thread_id).chain(alt_ids.iter().copied()) {
        if id.is_empty() {
            continue;
        }
        if let Some(t) = names.get(id) {
            let t = t.trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    if !is_placeholder_title(db_name) {
        return db_name.trim().to_string();
    }
    if let Some(p) = prompt_fallback {
        let cleaned = clean_prompt_title(p);
        if !cleaned.is_empty() {
            return cleaned;
        }
    }
    if db_name.trim().is_empty() {
        "Untitled".into()
    } else {
        db_name.trim().to_string()
    }
}

/// Persist summarized titles into `threads.name` when the DB still has a placeholder.
/// Returns how many rows were updated.
pub async fn backfill_thread_names(
    pool: &sqlx::SqlitePool,
    names: &HashMap<String, String>,
) -> Result<u64, String> {
    if names.is_empty() {
        return Ok(0);
    }
    let mut updated = 0u64;
    for (id, title) in names {
        let title = title.trim();
        if title.is_empty() || is_placeholder_title(title) {
            continue;
        }
        // Only overwrite placeholders / empty — never clobber a user rename.
        let res = sqlx::query(
            r#"UPDATE threads SET name = ?
               WHERE id = ?
                 AND (
                   name IS NULL OR name = '' OR name = 'Untitled'
                   OR lower(name) LIKE 'new grok%'
                   OR lower(name) LIKE 'new claude%'
                   OR lower(name) LIKE 'new codex%'
                   OR lower(name) LIKE 'new opencode%'
                   OR lower(name) LIKE 'new cursor%'
                   OR lower(name) LIKE 'claude code #%'
                   OR lower(name) LIKE 'claude chat #%'
                   OR lower(name) LIKE 'codex chat #%'
                   OR lower(name) LIKE 'codex #%'
                   OR lower(name) LIKE 'grok #%'
                   OR lower(name) = 'new thread'
                 )"#,
        )
        .bind(title)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
        updated += res.rows_affected();
    }
    Ok(updated)
}

fn clean_prompt_title(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    // Strip Grok/Claude user_query wrapper if present.
    if let Ok(re) = regex::Regex::new(r"(?s)<user_query>\s*(.*?)\s*</user_query>") {
        if let Some(c) = re.captures(&s) {
            if let Some(m) = c.get(1) {
                s = m.as_str().trim().to_string();
            }
        }
    }
    // Drop leading system blobs.
    if s.starts_with("<user_info>") || s.starts_with("<system-reminder>") {
        return String::new();
    }
    // Single-line, capped like the sidebar provisional title.
    let line = s.lines().next().unwrap_or("").trim();
    // Grok chat injects quoted ~/.agmux/tmp paths for images — strip those so
    // titles aren't `"/Users/…/.xanom/tmp/….png"` (with or without trailing text).
    let line = strip_temp_image_path_tokens(line);
    if line.is_empty() {
        return String::new();
    }
    let chars: String = line.chars().take(72).collect();
    if chars.chars().count() == 72 && line.chars().count() > 72 {
        format!("{chars}…")
    } else {
        chars
    }
}

/// Remove quoted/unquoted `…/.agmux/tmp/…` or legacy `…/.xanom/tmp/…` tokens.
fn strip_temp_image_path_tokens(line: &str) -> String {
    let Ok(re) = regex::Regex::new(
        r#"(?i)(?:"[^"]*/\.(?:agmux|xanom)/tmp/[^"]*"|'[^']*/\.(?:agmux|xanom)/tmp/[^']*'|\S*/\.(?:agmux|xanom)/tmp/\S*)"#,
    ) else {
        return line.to_string();
    };
    re.replace_all(line, " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_detects_defaults() {
        assert!(is_placeholder_title("New Grok Thread"));
        assert!(is_placeholder_title("New Claude Thread"));
        assert!(is_placeholder_title("New Claude Chat"));
        assert!(is_placeholder_title("New Grok Chat"));
        assert!(is_placeholder_title("New Codex Chat"));
        assert!(is_placeholder_title("New OpenCode Chat"));
        assert!(is_placeholder_title("New Cursor Chat"));
        assert!(is_placeholder_title("New Cursor Thread"));
        assert!(is_placeholder_title("Claude Code #1"));
        assert!(is_placeholder_title("Codex Chat #3"));
        assert!(!is_placeholder_title("Fix remote titles"));
    }

    #[test]
    fn resolve_prefers_summarized() {
        let mut names = HashMap::new();
        names.insert("t1".into(), "Fix pair flow".into());
        assert_eq!(
            resolve_title("t1", "New Grok Thread", &names, Some("ignored")),
            "Fix pair flow"
        );
    }

    #[test]
    fn resolve_falls_back_to_sdk_session_id_key() {
        let mut names = HashMap::new();
        names.insert("sdk-abc".into(), "Named via provider id".into());
        assert_eq!(
            resolve_title_aliased(
                "thread-uuid",
                &["sdk-abc", "oc-xyz"],
                "New Claude Chat",
                &names,
                Some("ignored"),
            ),
            "Named via provider id"
        );
    }

    #[test]
    fn resolve_uses_prompt_when_placeholder() {
        let names = HashMap::new();
        assert_eq!(
            resolve_title(
                "t1",
                "New Grok Thread",
                &names,
                Some("<user_query>deploy the pwa</user_query>")
            ),
            "deploy the pwa"
        );
    }

    #[test]
    fn parse_names_json_roundtrip_shape() {
        let m = parse_names_json(r#"{"a":"Hello","b":"","c":42}"#);
        assert_eq!(m.get("a").map(|s| s.as_str()), Some("Hello"));
        assert!(!m.contains_key("b"));
        assert!(!m.contains_key("c"));
    }

    #[test]
    fn resolve_skips_temp_image_path_fallback() {
        let names = HashMap::new();
        assert_eq!(
            resolve_title(
                "t1",
                "New Grok Chat",
                &names,
                Some(r#""/Users/neel/.xanom/tmp/f5881cf0.png""#)
            ),
            "New Grok Chat"
        );
    }

    #[test]
    fn clean_prompt_keeps_text_after_temp_paths() {
        assert_eq!(
            clean_prompt_title(r#""/Users/neel/.xanom/tmp/a.png" fix the login bug"#),
            "fix the login bug"
        );
    }
}
