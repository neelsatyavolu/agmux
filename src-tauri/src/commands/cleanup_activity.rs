use crate::state::AppState;
use serde::Serialize;
use tauri::State;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::time::UNIX_EPOCH;

const MAX_IDS: usize = 20_000;
const MAX_DISK_ENTRIES: usize = 100_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupSessionActivity {
    pub id: String,
    pub last_active_ms: Option<i64>,
    pub protected: bool,
}

#[derive(sqlx::FromRow)]
struct ThreadActivity {
    id: String,
    provider: String,
    last_active_ms: Option<i64>,
    sdk_session_id: Option<String>,
    opencode_session_id: Option<String>,
}

/// Read-only, conservative evidence for generated-cache cleanup. A null age is
/// never eligible. Call again at confirmation; this is a snapshot, not a lease.
#[tauri::command]
pub async fn get_cleanup_session_activity(
    state: State<'_, AppState>,
    session_ids: Vec<String>,
) -> Result<Vec<CleanupSessionActivity>, String> {
    if session_ids.len() > MAX_IDS || session_ids.iter().any(|id| id.len() > 256) {
        return Err("Cleanup activity accepts at most 20000 IDs of at most 256 bytes".into());
    }
    if session_ids.is_empty() { return Ok(Vec::new()); }
    let rows = sqlx::query_as::<_, ThreadActivity>(
        "SELECT id, provider, CAST(ROUND((julianday(last_active) - 2440587.5) * 86400000) AS INTEGER) AS last_active_ms, sdk_session_id, opencode_session_id FROM threads LIMIT 20001"
    ).fetch_all(&state.db).await.map_err(|e| e.to_string())?;
    if rows.len() > MAX_IDS { return Err("Too many threads to safely resolve cleanup aliases".into()); }
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let (rows, disk, edges) = tauri::async_runtime::spawn_blocking(move || {
        let disk = scan_native_activity(&home)?;
        let mut edges = Vec::new();
        for row in &rows {
            for id in [&row.sdk_session_id, &row.opencode_session_id].into_iter().flatten() {
                edges.push((row.id.clone(), id.clone()));
            }
            if safe_id(&row.id) {
                // Deliberately avoid agmux_home(): it performs migration/writes.
                let dir = home.join(".agmux/threads").join(&row.id);
                for provider in ["pi", "droid", "kimi", "cline", "gemini", "hermes", "opencode", "grok"] {
                    let path = dir.join(format!("{provider}-session-id.txt"));
                    if safe_metadata(&path).is_some_and(|m| m.is_file() && m.len() <= 256) {
                        if let Ok(raw) = std::fs::read_to_string(path) {
                            let id = raw.trim();
                            if safe_id(id) { edges.push((row.id.clone(), id.to_string())); }
                        }
                    }
                }
            }
        }
        Ok::<_, String>((rows, disk, edges))
    }).await.map_err(|e| e.to_string())??;

    // Membership alone protects even idle mounted sessions; do not poll/reap
    // child handles or send provider RPCs from a cleanup scan.
    let mut live = crate::hooks::hook_running_session_ids();
    live.extend(crate::codex::app_server::codex_active_turn_thread_ids());
    let ptys: Vec<_> = state.sessions.lock().await.iter()
        .map(|(id, context)| (id.clone(), context.provider.clone())).collect();
    live.extend(ptys.iter().map(|(id, _)| id.clone()));
    let sdk: Vec<_> = state.sdk_sessions.lock().await.iter()
        .map(|(id, context)| (id.clone(), context.session_id.clone())).collect();
    let mut uncertain_providers = HashSet::new();
    for (id, native) in sdk {
        live.insert(id);
        if let Some(native) = native.lock().await.as_ref() { live.insert(native.clone()); }
        else { uncertain_providers.insert("ClaudeCode".to_string()); }
    }
    for (id, context) in state.cursor_sdk_sessions.lock().await.iter() {
        live.insert(id.clone());
        live.insert(context.agent_id.clone());
    }
    for (id, context) in state.opencode_sdk_sessions.lock().await.iter() {
        live.insert(id.clone());
        live.insert(context.opencode_session_id.clone());
    }
    live.extend(state.grok_servers.lock().await.thread_ids());
    live.extend(state.gemini_servers.lock().await.thread_ids());
    expand_live_aliases(&mut live, &edges);
    for (id, provider) in &ptys {
        let resolved = unique_disk_activity(&disk, id, Some(provider)).is_some()
            || edges.iter().any(|(owner, alias)| owner == id && unique_disk_activity(&disk, alias, Some(provider)).is_some());
        if !resolved { uncertain_providers.insert(provider.clone()); }
    }
    let mut owners: HashMap<&str, Vec<&ThreadActivity>> = HashMap::new();
    let mut aliases: HashMap<&str, Vec<&str>> = HashMap::new();
    for (owner, alias) in &edges { aliases.entry(owner).or_default().push(alias); }
    for row in &rows {
        owners.entry(&row.id).or_default().push(row);
        if let Some(ids) = aliases.get(row.id.as_str()) {
            for id in ids { owners.entry(id).or_default().push(row); }
        }
    }
    Ok(session_ids.into_iter().map(|id| {
        let mut timestamp = unique_disk_activity(&disk, &id, None);
        let mut protected = live.contains(&id) || !safe_id(&id);
        if let Some(rows) = owners.get(id.as_str()) {
            let distinct: HashSet<_> = rows.iter().map(|r| r.id.as_str()).collect();
            if distinct.len() != 1 {
                timestamp = None;
            } else {
                let row = rows[0];
                let native: HashSet<&str> = aliases.get(row.id.as_str()).into_iter().flatten()
                    .copied().filter(|alias| *alias != row.id).collect();
                timestamp = if native.len() > 1 { None } else {
                    let native_id = native.iter().next().copied().unwrap_or(&row.id);
                    // Invalid DB time is uncertainty, not permission to discard it.
                    row.last_active_ms.and_then(|db| proven_activity(
                        unique_disk_activity(&disk, native_id, Some(&row.provider)), Some(db)))
                };
                protected |= uncertain_providers.contains(&row.provider);
            }
        }
        if let Some(matches) = disk.get(&id) {
            protected |= matches.iter().any(|(provider, _)| uncertain_providers.contains(provider));
        }
        CleanupSessionActivity { id, last_active_ms: timestamp, protected: protected || timestamp.is_none() }
    }).collect())
}

type DiskActivity = HashMap<String, Vec<(String, i64)>>;

fn proven_activity(disk: Option<i64>, db: Option<i64>) -> Option<i64> {
    disk.map(|disk| disk.max(db.unwrap_or(disk)))
}

fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn expand_live_aliases(live: &mut HashSet<String>, edges: &[(String, String)]) {
    let mut adjacent: HashMap<&str, Vec<&str>> = HashMap::new();
    for (a, b) in edges {
        adjacent.entry(a).or_default().push(b);
        adjacent.entry(b).or_default().push(a);
    }
    let mut queue: VecDeque<_> = live.iter().cloned().collect();
    while let Some(id) = queue.pop_front() {
        if let Some(aliases) = adjacent.get(id.as_str()) {
            for alias in aliases {
                if live.insert((*alias).to_string()) { queue.push_back((*alias).to_string()); }
            }
        }
    }
}

fn unique_disk_activity(disk: &DiskActivity, id: &str, provider: Option<&str>) -> Option<i64> {
    let matches = disk.get(id)?;
    if matches.len() != 1 { return None; }
    let (found_provider, timestamp) = &matches[0];
    if provider.is_some_and(|p| p != found_provider) { return None; }
    if *timestamp <= 0 { return None; }
    Some(*timestamp)
}

fn native_file_id(provider: &str, filename: &str) -> Option<String> {
    let stem = filename.strip_suffix(".jsonl")?;
    let id = match provider {
        "Codex" => {
            if !stem.starts_with("rollout-") { return None; }
            let start = stem.len().checked_sub(36)?;
            if stem.as_bytes().get(start.checked_sub(1)?) != Some(&b'-') { return None; }
            stem.get(start..)?
        },
        "Pi" => stem.rsplit_once('_')?.1,
        "ClaudeCode" | "Droid" => stem,
        _ => return None,
    };
    // Native file identity must be a complete UUID, never a substring match.
    if id.len() != 36 || !id.bytes().enumerate().all(|(i, b)| {
        if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() }
    }) { return None; }
    Some(id.to_string())
}

/// Reject symlinks in every component, including provider roots and home.
fn safe_metadata(path: &Path) -> Option<std::fs::Metadata> {
    for ancestor in path.ancestors() {
        if std::fs::symlink_metadata(ancestor).ok()?.file_type().is_symlink() { return None; }
    }
    std::fs::symlink_metadata(path).ok()
}

fn scan_native_activity(home: &Path) -> Result<DiskActivity, String> {
    let mut disk = HashMap::new();
    let mut budget = MAX_DISK_ENTRIES;
    for (provider, relative, depth) in [
        ("ClaudeCode", ".claude/projects", 1),
        ("Codex", ".codex/sessions", 3),
        ("Pi", ".pi/agent/sessions", 1),
        ("Droid", ".factory/sessions", 1),
    ] {
        let root = home.join(relative);
        if let Err(e) = std::fs::symlink_metadata(&root) {
            if e.kind() == std::io::ErrorKind::NotFound { continue; }
            return Err("Cannot inspect native session directory".into());
        }
        if !safe_metadata(&root).is_some_and(|m| m.is_dir()) {
            return Err("Unsafe native session directory".into());
        }
        scan_directory(&root, provider, depth, &mut budget, &mut disk)?;
    }
    Ok(disk)
}

fn scan_directory(path: &Path, provider: &str, depth: usize, budget: &mut usize, disk: &mut DiskActivity) -> Result<(), String> {
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        if *budget == 0 { return Err("Native session metadata scan limit exceeded".into()); }
        *budget -= 1;
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = std::fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() {
            // Never follow links. Preserve exact file IDs as unknown evidence;
            // a linked directory could hide arbitrary aliases, so fail closed.
            if depth > 0 { return Err("Ambiguous native session directory symlink".into()); }
            if let Some(id) = native_file_id(provider, &entry.file_name().to_string_lossy()) {
                disk.entry(id).or_default().push((provider.to_string(), 0));
            }
            continue;
        }
        if metadata.is_dir() && depth > 0 {
            scan_directory(&entry.path(), provider, depth - 1, budget, disk)?;
        } else if metadata.is_file() && depth == 0 {
            if let Some(id) = native_file_id(provider, &entry.file_name().to_string_lossy()) {
                let ms = metadata.modified().map_err(|e| e.to_string())?
                    .duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis();
                let ms = i64::try_from(ms).map_err(|e| e.to_string())?;
                disk.entry(id).or_default().push((provider.to_string(), ms));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disk_proof_is_required_and_recent_activity_wins() {
        assert_eq!(proven_activity(None, Some(10)), None);
        assert_eq!(proven_activity(Some(100), Some(10)), Some(100));
        assert_eq!(proven_activity(Some(10), Some(100)), Some(100));
        assert_eq!(proven_activity(Some(10), None), Some(10));
    }

    #[test]
    fn live_aliases_are_transitive() {
        let edges = vec![("app".into(), "native".into()), ("other".into(), "native".into())];
        let mut live = HashSet::from(["app".to_string()]);
        expand_live_aliases(&mut live, &edges);
        assert!(live.contains("native"));
        assert!(live.contains("other"));
        assert!(!live.contains("unknown"));
    }

    #[test]
    fn native_identity_is_exact_and_unsafe_ids_are_rejected() {
        let id = "12345678-1234-1234-1234-123456789abc";
        assert_eq!(native_file_id("Codex", &format!("rollout-2026-09-12T12-00-00-{id}.jsonl")), Some(id.to_string()));
        assert_eq!(native_file_id("ClaudeCode", &format!("{id}.jsonl")), Some(id.to_string()));
        assert_eq!(native_file_id("Codex", &format!("other-{id}.jsonl")), None);
        assert!(!safe_id("../outside"));
        assert!(!safe_id(".."));
        assert!(!safe_id("a/b"));
        assert!(!safe_id(""));
    }

    #[test]
    fn unknown_and_duplicate_native_ids_are_protected() {
        let mut disk = HashMap::new();
        assert_eq!(unique_disk_activity(&disk, "unknown", None), None);
        disk.insert("id".into(), vec![("ClaudeCode".into(), 10)]);
        assert_eq!(unique_disk_activity(&disk, "id", None), Some(10));
        assert_eq!(unique_disk_activity(&disk, "id", Some("Codex")), None);
        disk.get_mut("id").unwrap().push(("Codex".into(), 20));
        assert_eq!(unique_disk_activity(&disk, "id", None), None);
        assert_eq!(unique_disk_activity(&disk, "id", Some("ClaudeCode")), None);
    }

    #[test]
    fn scanner_uses_metadata_and_rejects_links_and_budget_exhaustion() {
        let suffix = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let temp = std::env::temp_dir().join(format!("cleanup-activity-{}-{suffix}", std::process::id()));
        std::fs::create_dir_all(&temp).unwrap();
        // macOS /var and /tmp are aliases; use a canonical test root.
        let temp = temp.canonicalize().unwrap();
        let root = temp.join(".claude/projects/project");
        std::fs::create_dir_all(&root).unwrap();
        let id = "12345678-1234-1234-1234-123456789abc";
        let file = root.join(format!("{id}.jsonl"));
        std::fs::write(&file, "not parsed as transcript content").unwrap();
        let disk = scan_native_activity(&temp).unwrap();
        let expected = std::fs::metadata(&file).unwrap().modified().unwrap()
            .duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
        assert_eq!(unique_disk_activity(&disk, id, None), Some(expected));
        let mut budget = 0;
        assert!(scan_directory(&root, "ClaudeCode", 0, &mut budget, &mut HashMap::new()).is_err());
        #[cfg(unix)]
        {
            let link_id = "aaaaaaaa-1234-1234-1234-123456789abc";
            let link = root.join(format!("{link_id}.jsonl"));
            std::os::unix::fs::symlink(&file, &link).unwrap();
            assert!(safe_metadata(&link).is_none());
            let disk = scan_native_activity(&temp).unwrap();
            assert_eq!(unique_disk_activity(&disk, link_id, None), None);
            assert_eq!(unique_disk_activity(&disk, id, None), Some(expected));
        }
        std::fs::remove_dir_all(temp).unwrap();
    }
}
