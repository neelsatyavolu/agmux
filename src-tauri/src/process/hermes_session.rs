use super::pty_usage::PtyUsageSnapshot;
use super::sidecar_id;
use std::path::Path;
use std::process::Command;

const STEM: &str = "hermes-session-id";

pub fn read_session_id(thread_state_dir: &Path) -> Option<String> {
    sidecar_id::read_sidecar_id(thread_state_dir, STEM)
}

pub fn write_session_id(thread_state_dir: &Path, session_id: &str) -> Result<(), String> {
    sidecar_id::write_sidecar_id(thread_state_dir, STEM, session_id)
}

pub fn remove_session_id(thread_state_dir: &Path) {
    sidecar_id::remove_sidecar_id(thread_state_dir, STEM);
}

fn state_db() -> Option<std::path::PathBuf> {
    Some(dirs::home_dir()?.join(".hermes").join("state.db"))
}

pub fn session_exists(session_id: &str) -> bool {
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains('\'')
    {
        return false;
    }
    let Some(db) = state_db() else {
        return false;
    };
    if !db.is_file() {
        return false;
    }
    let output = Command::new("sqlite3")
        .arg(db)
        .arg(format!(
            "SELECT 1 FROM sessions WHERE id = '{}' LIMIT 1;",
            session_id.replace('\'', "''")
        ))
        .output();
    match output {
        Ok(o) => !String::from_utf8_lossy(&o.stdout).trim().is_empty(),
        Err(_) => false,
    }
}

pub fn read_usage_for_thread(thread_state_dir: &Path) -> PtyUsageSnapshot {
    let Some(sid) = read_session_id(thread_state_dir) else {
        return PtyUsageSnapshot::default();
    };
    read_usage(&sid)
}

pub fn read_usage(session_id: &str) -> PtyUsageSnapshot {
    if session_id.is_empty() || session_id.contains('\'') {
        return PtyUsageSnapshot::default();
    }
    let Some(db) = state_db() else {
        return PtyUsageSnapshot::default();
    };
    if !db.is_file() {
        return PtyUsageSnapshot::default();
    }
    let escaped = session_id.replace('\'', "''");
    let sql = format!(
        "SELECT ifnull(model,''), ifnull(input_tokens,0)+ifnull(cache_read_tokens,0), \
         ifnull(model_config,'') \
         FROM sessions WHERE id = '{escaped}' LIMIT 1;"
    );
    let Ok(output) = Command::new("sqlite3").arg(&db).arg(&sql).output() else {
        return PtyUsageSnapshot::default();
    };
    let line = String::from_utf8_lossy(&output.stdout);
    let line = line.trim();
    let mut snap = PtyUsageSnapshot::default();
    let parts: Vec<&str> = line.splitn(3, '|').collect();
    if parts.len() >= 2 {
        let model = parts[0].trim();
        if !model.is_empty() {
            snap.model = Some(model.to_string());
        }
        snap.context_tokens_used = parts[1].trim().parse().unwrap_or(0);
        if parts.len() >= 3 {
            if let Ok(cfg) = serde_json::from_str::<serde_json::Value>(parts[2].trim()) {
                if let Some(w) = cfg
                    .get("context_length")
                    .or_else(|| cfg.get("context_window"))
                    .or_else(|| cfg.get("max_tokens"))
                    .and_then(|v| v.as_u64())
                {
                    if w > 0 {
                        snap.context_window_tokens = w;
                    }
                }
            }
        }
    }
    // Patch/write_file payloads live in `content`, not `tool_calls`.
    let diff_sql = format!(
        "SELECT ifnull(tool_name,''), ifnull(content,''), ifnull(tool_calls,'') \
         FROM messages WHERE session_id = '{escaped}' AND active = 1 \
         AND lower(ifnull(tool_name,'')) IN ('patch','write_file');"
    );
    if let Ok(out) = Command::new("sqlite3")
        .arg("-separator")
        .arg("\u{1f}")
        .arg(&db)
        .arg(&diff_sql)
        .output()
    {
        let mut files = std::collections::HashSet::new();
        let mut added: i64 = 0;
        let mut removed: i64 = 0;
        for row in String::from_utf8_lossy(&out.stdout).lines() {
            let mut cols = row.split('\u{1f}');
            let name = cols.next().unwrap_or("");
            let content = cols.next().unwrap_or("");
            let tool_calls = cols.next().unwrap_or("");
            let (f, a, r) = parse_tool_row(name, content, tool_calls);
            files.extend(f);
            added += a;
            removed += r;
        }
        snap.lines_added = added;
        snap.lines_removed = removed;
        snap.files_changed = files.len() as i64;
    }
    snap
}

fn parse_tool_row(name: &str, content: &str, tool_calls: &str) -> (Vec<String>, i64, i64) {
    let lname = name.to_ascii_lowercase();
    let blob = if content.trim().starts_with('{') {
        content
    } else {
        tool_calls
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(blob) else {
        return (Vec::new(), 0, 0);
    };
    let mut files = Vec::new();
    if let Some(fp) = v
        .get("resolved_path")
        .or_else(|| v.get("path"))
        .or_else(|| v.get("file_path"))
        .and_then(|x| x.as_str())
    {
        if !fp.is_empty() {
            files.push(fp.to_string());
        }
    }
    if let Some(arr) = v.get("files_modified").and_then(|x| x.as_array()) {
        for item in arr {
            if let Some(fp) = item.as_str() {
                files.push(fp.to_string());
            }
        }
    }
    let mut added: i64 = 0;
    let mut removed: i64 = 0;
    if lname == "patch" {
        if let Some(diff) = v.get("diff").and_then(|x| x.as_str()) {
            count_diff_lines(diff, &mut added, &mut removed);
            if files.is_empty() {
                if let Some(fp) = path_from_diff_header(diff) {
                    files.push(fp);
                }
            }
        }
    }
    (files, added, removed)
}

fn count_diff_lines(diff: &str, added: &mut i64, removed: &mut i64) {
    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            *added += 1;
        } else if line.starts_with('-') {
            *removed += 1;
        }
    }
}

fn path_from_diff_header(diff: &str) -> Option<String> {
    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("+++ b/") {
            let p = rest.trim();
            if !p.is_empty() && p != "/dev/null" {
                return Some(p.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_ids() {
        assert!(!session_exists("../x"));
        assert!(!session_exists("a'b"));
        assert!(!session_exists(""));
    }

    #[test]
    fn parses_patch_content_json() {
        let content = r#"{"success":true,"diff":"--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n","files_modified":["src/a.ts"]}"#;
        let (files, added, removed) = parse_tool_row("patch", content, "");
        assert_eq!(files, vec!["src/a.ts"]);
        assert_eq!(added, 2);
        assert_eq!(removed, 1);
    }
}
