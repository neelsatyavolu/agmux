//! Sidebar preferences mirror for the mobile remote.
//!
//! The desktop sidebar's project drag-order (`settings.projectOrder`),
//! per-project pinned sessions (`xanom:pinned-sessions:{projectId}`), and
//! hidden/dismissed discovered sessions (`xanom:hidden-sessions:{projectId}`)
//! live in webview localStorage. The frontend mirrors them to
//! `~/.agmux/sidebar-prefs.json` (same pattern as session-names.json) so the
//! remote catalog can ship the same ordering, pins, and hide set the app shows.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarPrefs {
    /// Project ids in the user's dragged order; projects not listed sort last.
    #[serde(default)]
    pub project_order: Vec<String>,
    /// projectId → pinned session/thread ids (catalog ids).
    #[serde(default)]
    pub pinned: HashMap<String, Vec<String>>,
    /// projectId → session/thread ids the user hid or deleted from the desktop
    /// sidebar (discovered Claude/Codex/etc. that remain on disk). Without this
    /// the remote PWA re-lists them from provider session files forever.
    #[serde(default)]
    pub hidden: HashMap<String, Vec<String>>,
}

pub fn sidebar_prefs_path() -> Option<PathBuf> {
    Some(crate::paths::agmux_home_opt()?.join("sidebar-prefs.json"))
}

pub fn load_sidebar_prefs() -> SidebarPrefs {
    let Some(path) = sidebar_prefs_path() else {
        return SidebarPrefs::default();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return SidebarPrefs::default();
    };
    parse_sidebar_prefs(&raw)
}

pub fn parse_sidebar_prefs(raw: &str) -> SidebarPrefs {
    serde_json::from_str(raw).unwrap_or_default()
}

pub fn save_sidebar_prefs(prefs: &SidebarPrefs) -> Result<(), String> {
    let path = sidebar_prefs_path().ok_or_else(|| "no home dir".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(prefs).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

impl SidebarPrefs {
    /// Sort key for a project: its index in the dragged order, or MAX for
    /// unordered projects (which the app shows last, in created order).
    pub fn project_sort_key(&self, project_id: &str) -> i64 {
        self.project_order
            .iter()
            .position(|p| p == project_id)
            .map(|i| i as i64)
            .unwrap_or(i64::MAX)
    }

    /// Whether a catalog row is pinned — pins store the sidebar item id, which
    /// is the thread id for DB rows and the provider session id for
    /// discovered sessions.
    pub fn is_pinned(&self, project_id: &str, ids: &[&str]) -> bool {
        match self.pinned.get(project_id) {
            Some(list) => ids.iter().any(|id| !id.is_empty() && list.iter().any(|p| p == id)),
            None => false,
        }
    }

    /// Whether any of the catalog row's ids was dismissed on the desktop
    /// sidebar (hide/delete discovered session, or deleted thread id mirrored
    /// so its on-disk provider session can't resurrect on the phone).
    pub fn is_hidden(&self, project_id: &str, ids: &[&str]) -> bool {
        match self.hidden.get(project_id) {
            Some(list) => ids
                .iter()
                .any(|id| !id.is_empty() && list.iter().any(|h| h == id)),
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_roundtrip_and_defaults() {
        let p = parse_sidebar_prefs(
            r#"{"projectOrder":["b","a"],"pinned":{"a":["t1","sid-2"]},"hidden":{"a":["gone","sid-9"]}}"#,
        );
        assert_eq!(p.project_sort_key("b"), 0);
        assert_eq!(p.project_sort_key("a"), 1);
        assert_eq!(p.project_sort_key("zzz"), i64::MAX);
        assert!(p.is_pinned("a", &["t1"]));
        assert!(p.is_pinned("a", &["nope", "sid-2"]));
        assert!(!p.is_pinned("a", &["t9"]));
        assert!(!p.is_pinned("b", &["t1"]));
        assert!(p.is_hidden("a", &["gone"]));
        assert!(p.is_hidden("a", &["x", "sid-9"]));
        assert!(!p.is_hidden("a", &["still-visible"]));
        assert!(!p.is_hidden("b", &["gone"]));

        // Older mirrors without a `hidden` key still parse.
        let no_hidden = parse_sidebar_prefs(r#"{"projectOrder":[],"pinned":{}}"#);
        assert!(!no_hidden.is_hidden("a", &["x"]));

        let empty = parse_sidebar_prefs("not json");
        assert_eq!(empty.project_sort_key("x"), i64::MAX);
    }
}
