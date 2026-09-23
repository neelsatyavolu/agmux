//! Native Codex sidebar totals must not depend on a mounted chat view.
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::path::{Component, Path, PathBuf};
use std::io::{BufRead, BufReader, Read};
use std::os::unix::fs::MetadataExt;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use crate::commands::codex::SessionHistoryItem;

#[derive(Default)]
pub(crate) struct DiffObserver {
    patch_calls: HashSet<(String, String)>,
}

impl DiffObserver {
    /// PTY rollouts contain the same facts as chat events, but have no
    /// app-server connection. Route their edit completions to the same totals.
    pub(crate) fn observe_record(&mut self, session: &str, record: &Value) -> bool {
        let payload = &record["payload"];
        match record["type"].as_str() {
            Some("event_msg") => match payload["type"].as_str() {
                Some("patch_apply_end") => payload["success"] == true,
                Some("item_completed") => self.observe(session, "codex/event/item_completed", payload),
                Some("task_complete" | "turn_aborted") => {
                    self.patch_calls.retain(|(id, _)| id != session);
                    true
                }
                _ => false,
            },
            Some("response_item") => self.observe(session, "rawResponseItem/completed", &serde_json::json!({"item":payload})),
            _ => false,
        }
    }

    pub(super) fn observe(&mut self, session: &str, method: &str, params: &Value) -> bool {
        let item = &params["item"];
        match method {
            "item/completed" => item["type"] == "fileChange",
            "codex/event/patch_apply_end" => params.get("msg").unwrap_or(params)["success"] == true,
            "codex/event/item_completed" => {
                let item = &params.get("msg").unwrap_or(params)["item"];
                item["type"] == "FileChange" && item["status"] == "completed"
            }
            "turn/completed" | "turn/failed" | "turn/aborted" => {
                self.patch_calls.retain(|(id, _)| id != session);
                true
            }
            "rawResponseItem/completed" => {
                let Some(id) = item["call_id"].as_str() else { return false };
                let key = (session.to_string(), id.to_string());
                match item["type"].as_str() {
                    Some("custom_tool_call" | "function_call") => {
                        let name = item["name"].as_str().unwrap_or("");
                        let input = item["input"].as_str().unwrap_or("");
                        if matches!(name, "apply_patch" | "apply_patch_freeform")
                            || (matches!(name, "exec" | "functions.exec") && input.contains("tools.apply_patch(")) {
                            if self.patch_calls.len() >= 1024 { self.patch_calls.clear(); }
                            self.patch_calls.insert(key);
                        }
                        false
                    }
                    Some("custom_tool_call_output" | "function_call_output") => self.patch_calls.remove(&key),
                    _ => false,
                }
            }
            _ => false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexDiffStats {
    pub session_id: String,
    pub lines_added: u64,
    pub lines_removed: u64,
    pub files_changed: usize,
    pub native_incomplete: bool,
}

fn totals(session: &str, items: &[SessionHistoryItem]) -> CodexDiffStats {
    let mut stats = CodexDiffStats { session_id: session.to_string(), lines_added: 0, lines_removed: 0, files_changed: 0, native_incomplete: false };
    let mut files = HashSet::new();
    for item in items {
        if item.role != "file" { continue; }
        let Some(path) = item.file_path.as_deref().filter(|path| !path.is_empty()) else { continue };
        stats.lines_added += u64::from(item.additions.unwrap_or(0));
        stats.lines_removed += u64::from(item.deletions.unwrap_or(0));
        files.insert(path);
    }
    stats.files_changed = files.len();
    stats
}

// Index headers once per event/discovery batch, not one directory walk per ID.
// Only small edit facts are cached; full histories remain bounded temporary reads.
const MAX_INDEX_FILES: usize = 16_384;
const MAX_ROLLUP_SESSIONS: usize = 512;
type FileStamp = (u64, u64, u64, i64, i64, i64, i64);

fn file_stamp(path: &Path) -> Option<FileStamp> {
    let m = std::fs::symlink_metadata(path).ok()?;
    if !m.is_file() { return None; }
    Some((m.dev(), m.ino(), m.len(), m.mtime(), m.mtime_nsec(), m.ctime(), m.ctime_nsec()))
}

fn valid_session(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

#[derive(Clone)]
struct SessionHeader {
    id: String,
    cwd: String,
    parent: Option<String>,
    meta: Value,
    ambiguous: bool,
}

fn read_header(path: &Path) -> Result<SessionHeader, String> {
    let mut line = String::new();
    BufReader::new(std::fs::File::open(path).map_err(|e| e.to_string())?.take(1024 * 1024))
        .read_line(&mut line).map_err(|e| e.to_string())?;
    let row: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
    let meta = &row["payload"];
    let id = meta["id"].as_str().filter(|id| valid_session(id)).ok_or("Missing native session identity")?;
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if row["type"] != "session_meta" || !(name == format!("{id}.jsonl") || name.ends_with(&format!("-{id}.jsonl"))) {
        return Err("Session header does not match its file".into());
    }
    let cwd = meta["cwd"].as_str().filter(|cwd| Path::new(cwd).is_absolute()).ok_or("Missing native session cwd")?;
    let spawn = &meta["source"]["subagent"]["thread_spawn"];
    let parent = spawn["parent_thread_id"].as_str().filter(|id| valid_session(id)).map(str::to_string);
    let ambiguous = !spawn.is_null() && parent.is_none();
    // Omit instructions and other potentially large header payloads.
    let mut retained = serde_json::Map::new();
    for key in ["id", "cwd", "source", "timestamp", "forked_from_id", "forkedFromId",
        "subagent_history_start_ordinal", "forked_from_ordinal_exclusive"] {
        if let Some(value) = meta.get(key) { retained.insert(key.to_string(), value.clone()); }
    }
    Ok(SessionHeader { id: id.into(), cwd: cwd.into(), parent, meta: Value::Object(retained), ambiguous })
}

#[derive(Clone, Debug)]
struct EditFact {
    id: String,
    occurrence: usize,
    path: String,
    added: u64,
    removed: u64,
    native: bool,
}

#[derive(Clone, Default)]
struct SessionFacts {
    edits: Vec<EditFact>,
    incomplete: bool,
}

fn absolute_file(cwd: &str, file: &str) -> String {
    let joined = Path::new(cwd).join(file);
    let mut normalized = PathBuf::new();
    for part in joined.components() {
        match part {
            Component::CurDir => {},
            Component::ParentDir => { normalized.pop(); },
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized.to_string_lossy().into_owned()
}

fn record_turn(row: &Value) -> Option<&str> {
    row.pointer("/payload/internal_chat_message_metadata_passthrough/turn_id")
        .or_else(|| row.pointer("/payload/turn_id")).and_then(Value::as_str)
}

fn record_owner(row: &Value) -> Option<&str> {
    row.pointer("/payload/thread_id")
        .or_else(|| row.pointer("/payload/internal_chat_message_metadata_passthrough/thread_id")).and_then(Value::as_str)
}

/// Explicit logical owners override stale physical ordinals after migration.
/// Other inherited rows require the saved exact ordinal boundary. A shared
/// session_id is never an owner, and later copied headers never replace it.
fn owned_content(content: &str, header: &SessionHeader) -> Result<(String, bool), String> {
    crate::commands::recalculate_diff::validate_history(content, &header.id, &header.cwd)?;
    let mut turns: HashMap<String, Option<String>> = HashMap::new();
    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        let row: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
        if let (Some(turn), Some(owner)) = (record_turn(&row), record_owner(&row)) {
            let entry = turns.entry(turn.into()).or_insert_with(|| Some(owner.into()));
            if entry.as_deref() != Some(owner) { *entry = None; }
        }
    }
    let fork = header.meta.get("forked_from_id").or_else(|| header.meta.get("forkedFromId"))
        .and_then(Value::as_str).is_some_and(|id| !id.is_empty());
    // This is the observed native SessionMeta boundary. A similarly named
    // fork cutoff is not assumed equivalent, and clocks cannot prove ownership.
    let start = header.meta["subagent_history_start_ordinal"].as_u64();
    let needs_boundary = header.parent.is_some() || fork;
    let mut result = String::new();
    let mut first = true;
    let mut incomplete = false;
    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        let row: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
        if row["type"] == "session_meta" {
            if first { result.push_str(line); result.push('\n'); first = false; }
            continue;
        }
        let owned = if let Some(owner) = record_owner(&row) {
            Some(owner == header.id)
        } else if let Some(owner) = record_turn(&row).and_then(|turn| turns.get(turn)) {
            owner.as_deref().map(|owner| owner == header.id)
        } else if !needs_boundary { Some(true) }
        else if let Some((ordinal, start)) = row["ordinal"].as_u64().zip(start) { Some(ordinal >= start) }
        else { None };
        if owned == Some(true) { result.push_str(line); result.push('\n'); }
        else if owned.is_none() {
            let p = &row["payload"];
            if matches!(p["type"].as_str(), Some("patch_apply_end" | "custom_tool_call" | "function_call"))
                || p["item"]["type"] == "FileChange" { incomplete = true; }
        }
    }
    Ok((result, incomplete))
}

fn read_facts(path: &Path, header: &SessionHeader) -> Result<SessionFacts, String> {
    let content = crate::commands::recalculate_diff::read_history_file(path)?;
    let (owned, incomplete) = owned_content(&content, header)?;
    let history = crate::commands::codex::parse_session_history_content(&owned)?;
    let mut facts = SessionFacts { edits: Vec::new(), incomplete };
    let mut occurrences = HashMap::new();
    for (index, item) in history.items.iter().enumerate().filter(|(_, item)| item.role == "file") {
        let Some(file) = item.file_path.as_deref().filter(|path| !path.is_empty()) else { continue };
        let input = item.tool_input.as_ref().unwrap_or(&Value::Null);
        let id = match input["editId"].as_str().filter(|id| !id.is_empty()) {
            Some(id) => id.to_string(),
            None => {
                facts.incomplete = true;
                if header.parent.is_some() { continue; }
                format!("unidentified:{}:{index}", header.id)
            }
        };
        let path = absolute_file(&header.cwd, file);
        let occurrence = occurrences.entry((id.clone(), path.clone())).or_insert(0usize);
        facts.edits.push(EditFact { id, occurrence: *occurrence, path, added: u64::from(item.additions.unwrap_or(0)),
            removed: u64::from(item.deletions.unwrap_or(0)), native: input["nativeEdit"] == true });
        *occurrence += 1;
    }
    Ok(facts)
}

#[derive(Default)]
struct SessionCatalog {
    root: PathBuf,
    paths: HashMap<String, Vec<PathBuf>>,
    headers: HashMap<PathBuf, (FileStamp, SessionHeader)>,
    facts: HashMap<PathBuf, (FileStamp, SessionFacts)>,
    complete: bool,
}

impl SessionCatalog {
    fn refresh(&mut self, root: &Path) -> Vec<String> {
        if self.root != root { *self = Self { root: root.into(), ..Self::default() }; }
        self.paths.clear();
        self.complete = true;
        let mut seen = HashSet::new();
        let mut changed_children = HashSet::new();
        let mut changed_roots = HashSet::new();
        for entry in walkdir::WalkDir::new(root).follow_links(false) {
            let entry = match entry { Ok(entry) => entry, Err(_) => { self.complete = false; continue; } };
            if !entry.file_type().is_file() || entry.path().extension().is_none_or(|ext| ext != "jsonl") { continue; }
            if seen.len() >= MAX_INDEX_FILES { self.complete = false; break; }
            let path = entry.into_path();
            seen.insert(path.clone());
            let Some(stamp) = file_stamp(&path) else { self.complete = false; continue };
            if self.headers.get(&path).is_none_or(|(old, _)| *old != stamp) {
                match read_header(&path) {
                    Ok(header) => {
                        if header.parent.is_some() { changed_children.insert(header.id.clone()); }
                        else if self.headers.contains_key(&path) { changed_roots.insert(header.id.clone()); }
                        self.headers.insert(path.clone(), (stamp, header));
                    },
                    Err(_) => {
                        if let Some((_, previous)) = self.headers.get(&path) {
                            if previous.parent.is_some() { changed_children.insert(previous.id.clone()); }
                        }
                        continue;
                    }
                }
            }
            if let Some((_, header)) = self.headers.get(&path) {
                self.paths.entry(header.id.clone()).or_default().push(path);
            }
        }
        // Keep a known missing child's lineage so its parent remains partial.
        for (path, (_, header)) in &self.headers {
            if !seen.contains(path) {
                self.paths.entry(header.id.clone()).or_default().push(path.clone());
                if header.parent.is_some() { changed_children.insert(header.id.clone()); }
            }
        }
        changed_roots.extend(changed_children.into_iter().flat_map(|id| self.ancestors(&id).into_iter().skip(1)));
        changed_roots.into_iter().collect()
    }

    fn header(&self, session: &str) -> Result<(PathBuf, SessionHeader), String> {
        let paths = self.paths.get(session).ok_or("Session history file not found")?;
        if paths.len() != 1 { return Err("Multiple history files match this session".into()); }
        let header = self.headers.get(&paths[0]).ok_or("Session header unavailable")?;
        Ok((paths[0].clone(), header.1.clone()))
    }

    fn session_facts(&mut self, path: &Path, header: &SessionHeader) -> Result<SessionFacts, String> {
        let stamp = file_stamp(path).ok_or("Session history unavailable")?;
        if let Some((previous, facts)) = self.facts.get(path) {
            if *previous == stamp { return Ok(facts.clone()); }
        }
        let facts = read_facts(path, header)?;
        if file_stamp(path) == Some(stamp) {
            if self.facts.len() >= DISCOVERY_CACHE_CAPACITY { self.facts.clear(); }
            self.facts.insert(path.into(), (stamp, facts.clone()));
        }
        Ok(facts)
    }

    fn aggregate(&mut self, session: &str, cwd: Option<&str>) -> Result<NativeDiffRollup, String> {
        let (_, root_header) = self.header(session)?;
        if cwd.is_some_and(|cwd| cwd != root_header.cwd) { return Err("Session history identity or cwd does not match".into()); }
        let mut result = NativeDiffRollup { stats: totals(session, &[]), native_files: HashSet::new() };
        result.stats.native_incomplete = !self.complete || root_header.ambiguous;
        let mut pending = vec![(session.to_string(), 0usize)];
        let mut visited = HashSet::new();
        let mut edits: HashMap<(String, usize, String), EditFact> = HashMap::new();
        let mut native_pairs = HashSet::new();
        let mut conflicts = HashSet::new();
        while let Some((id, depth)) = pending.pop() {
            if depth > 32 || visited.len() >= MAX_ROLLUP_SESSIONS || !visited.insert(id.clone()) {
                result.stats.native_incomplete = true; continue;
            }
            let facts = self.header(&id).and_then(|(path, header)| self.session_facts(&path, &header));
            match facts {
                Ok(facts) => {
                    result.stats.native_incomplete |= facts.incomplete;
                    for fact in facts.edits {
                        if fact.native { native_pairs.insert((fact.id.clone(), fact.path.clone())); }
                        let key = (fact.id.clone(), fact.occurrence, fact.path.clone());
                        if conflicts.contains(&key) { continue; }
                        if let Some(old) = edits.get(&key) {
                            if old.native && !fact.native { continue; }
                            if old.native == fact.native {
                                if old.added == fact.added && old.removed == fact.removed { continue; }
                                edits.remove(&key); conflicts.insert(key); result.stats.native_incomplete = true; continue;
                            }
                        }
                        edits.insert(key, fact);
                    }
                }
                Err(error) if id == session || error.contains("Session history changed during recalculation") => return Err(error),
                Err(_) => result.stats.native_incomplete = true,
            }
            for (_, header) in self.headers.values() {
                if header.parent.as_deref() == Some(&id) { pending.push((header.id.clone(), depth + 1)); }
            }
        }
        let mut files = HashSet::new();
        for fact in edits.into_values() {
            // Native receipts describe the whole operation on this file. Keep
            // every native occurrence, but no extra raw-wrapper occurrences.
            if !fact.native && native_pairs.contains(&(fact.id.clone(), fact.path.clone())) { continue; }
            result.stats.lines_added += fact.added;
            result.stats.lines_removed += fact.removed;
            files.insert(fact.path.clone());
            if fact.native { result.native_files.insert((fact.id, fact.path)); }
        }
        result.stats.files_changed = files.len();
        Ok(result)
    }

    fn ancestors(&self, session: &str) -> Vec<String> {
        let mut ids = vec![session.to_string()];
        while ids.len() <= 32 {
            let Ok((_, header)) = self.header(ids.last().unwrap()) else { break };
            let Some(parent) = header.parent else { break };
            if ids.contains(&parent) { break; }
            ids.push(parent);
        }
        ids
    }
}

pub(crate) struct NativeDiffRollup {
    pub stats: CodexDiffStats,
    pub native_files: HashSet<(String, String)>,
}

fn catalog() -> &'static Mutex<SessionCatalog> {
    static CATALOG: OnceLock<Mutex<SessionCatalog>> = OnceLock::new();
    CATALOG.get_or_init(|| Mutex::new(SessionCatalog::default()))
}

/// Shared absolute native totals for automatic badges and manual recalculation.
/// Shell capture remains in its separate ledger and never enters this rollup.
pub(crate) fn read_session_rollup(root: &Path, session: &str, cwd: Option<&str>) -> Result<NativeDiffRollup, String> {
    let mut catalog = catalog().lock().unwrap_or_else(|e| e.into_inner());
    catalog.refresh(root);
    catalog.aggregate(session, cwd)
}

// Retain only discovery revisions, never full transcripts. In-flight work has
// one entry per native session and one reader across live and discovered chats.
const DISCOVERY_CACHE_CAPACITY: usize = 4096;

#[derive(Default)]
struct PendingRefresh {
    generation: u64,
    revision: Option<Value>,
    read_failures: u8,
}

#[derive(Default)]
struct RefreshQueue {
    pending: HashMap<String, PendingRefresh>,
    waiting: VecDeque<String>,
    hydrated: VecDeque<(String, Value)>,
    running: bool,
    catalog_dirty: bool,
}

impl RefreshQueue {
    fn finish_error(&mut self, session: &str, generation: u64, error: &str) -> bool {
        if error.contains("Session history changed during recalculation") {
            if let Some(pending) = self.pending.get_mut(session) {
                if pending.generation == generation && pending.read_failures < 2 {
                    pending.read_failures += 1;
                    self.waiting.push_front(session.to_string());
                    return false;
                }
            }
        }
        self.finish(session, generation, false)
    }

    /// A missing revision means a live edit/turn signal and always refreshes.
    fn request(&mut self, session: &str, revision: Option<Value>) -> bool {
        if session.is_empty() { return false; }
        if let Some(pending) = self.pending.get_mut(session) {
            if revision.is_none() || revision != pending.revision {
                pending.generation = pending.generation.saturating_add(1);
                pending.read_failures = 0;
                if let Some(revision) = revision { pending.revision = Some(revision); }
                else if let Some(index) = self.waiting.iter().position(|id| id == session) {
                    self.waiting.remove(index);
                    self.waiting.push_front(session.to_string());
                }
            }
            return false;
        }
        if let Some(revision) = revision.as_ref() {
            if self.hydrated.iter().any(|(id, seen)| id == session && seen == revision) {
                return false;
            }
        }
        // Prioritize new live signals over a large cold-history backfill.
        if revision.is_none() { self.waiting.push_front(session.to_string()); }
        else { self.waiting.push_back(session.to_string()); }
        self.pending.insert(session.to_string(), PendingRefresh { revision, ..PendingRefresh::default() });
        let start = !self.running;
        self.running = true;
        start
    }

    fn discover(&mut self, entries: &[Value]) -> bool {
        let mut start = false;
        for entry in entries {
            let Some(session) = entry["id"].as_str() else { continue };
            start |= self.request(session, Some(entry["updatedAt"].clone()));
        }
        start
    }

    fn next(&mut self) -> Option<(String, u64)> {
        let Some(session) = self.waiting.pop_front() else {
            self.running = false;
            return None;
        };
        let generation = self.pending.get(&session)?.generation;
        Some((session, generation))
    }

    /// Return false if a newer signal arrived while reading. Do not publish an
    /// outdated snapshot; retry once at the front with the coalesced generation.
    fn finish(&mut self, session: &str, generation: u64, success: bool) -> bool {
        let Some(pending) = self.pending.get(session) else { return false };
        if pending.generation != generation {
            self.waiting.push_front(session.to_string());
            return false;
        }
        let pending = self.pending.remove(session).unwrap_or_default();
        if success {
            if let Some(revision) = pending.revision {
                self.hydrated.retain(|(id, _)| id != session);
                if self.hydrated.len() >= DISCOVERY_CACHE_CAPACITY { self.hydrated.pop_front(); }
                self.hydrated.push_back((session.to_string(), revision));
            }
        }
        success
    }
}

fn queue() -> &'static Mutex<RefreshQueue> {
    static QUEUE: OnceLock<Mutex<RefreshQueue>> = OnceLock::new();
    QUEUE.get_or_init(|| Mutex::new(RefreshQueue::default()))
}

/// Listing history schedules native totals without opening a conversation or
/// invoking Recalculate. Unchanged list refreshes do not reread settled files.
pub(crate) fn hydrate_discovered(app: &AppHandle, entries: &[Value]) {
    let mut queue = queue().lock().unwrap_or_else(|e| e.into_inner());
    let start = !queue.running;
    queue.discover(entries);
    // An unchanged parent listing can still have a new/changed child rollout.
    queue.catalog_dirty = true;
    queue.running = true;
    drop(queue);
    if start { run_worker(app); }
}

/// Coalesce edit bursts per session and serialize all history reads globally.
/// Discovery and edit/turn events schedule work; nothing polls idle histories.
pub(crate) fn refresh(app: &AppHandle, session: &str) {
    let mut queue = queue().lock().unwrap_or_else(|e| e.into_inner());
    let start = queue.request(session, None);
    queue.catalog_dirty = true;
    drop(queue);
    if start { run_worker(app); }
}

fn run_worker(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        loop {
            let dirty = {
                let mut queue = queue().lock().unwrap_or_else(|e| e.into_inner());
                std::mem::take(&mut queue.catalog_dirty)
            };
            if dirty {
                let changed = tokio::task::spawn_blocking(|| {
                    let Some(root) = crate::codex::cli_config::codex_home().map(|home| home.join("sessions")) else { return Vec::new() };
                    catalog().lock().unwrap_or_else(|e| e.into_inner()).refresh(&root)
                }).await.unwrap_or_default();
                let mut queue = queue().lock().unwrap_or_else(|e| e.into_inner());
                for parent in changed { queue.request(&parent, None); }
            }
            let (next, rescan) = {
                let mut queue = queue().lock().unwrap_or_else(|e| e.into_inner());
                // Discovery can arrive during the index scan without adding a
                // new session. Consume that invalidation before stopping.
                if queue.waiting.is_empty() && queue.catalog_dirty { (None, true) }
                else { (queue.next(), false) }
            };
            if rescan { continue; }
            let Some((session, generation)) = next else { break };
            let id = session.clone();
            let result = tokio::task::spawn_blocking(move || {
                let mut catalog = catalog().lock().unwrap_or_else(|e| e.into_inner());
                let mut updates = Vec::new();
                let mut unavailable = Vec::new();
                let mut retry_ancestors = Vec::new();
                for target in catalog.ancestors(&id) {
                    match catalog.aggregate(&target, None) {
                        Ok(rollup) => updates.push(rollup.stats),
                        Err(error) if target == id => return Err(error),
                        Err(error) if error.contains("Session history changed during recalculation") => retry_ancestors.push(target),
                        Err(error) => {
                            tracing::debug!(session_id = %target, %error, "Codex ancestor diff refresh failed");
                            unavailable.push(target);
                        },
                    }
                }
                Ok((updates, unavailable, retry_ancestors))
            }).await.map_err(|e| e.to_string()).and_then(|result| result);
            let (current, retrying) = {
                let mut queue = queue().lock().unwrap_or_else(|e| e.into_inner());
                let current = match &result {
                    Ok(_) => queue.finish(&session, generation, true),
                    Err(error) => queue.finish_error(&session, generation, error),
                };
                (current, queue.pending.contains_key(&session))
            };
            match result {
                Ok((updates, unavailable, retry_ancestors)) if current => {
                    for stats in updates {
                        // A verified zero retracts old counts; incomplete coverage
                        // remains explicit instead of becoming a claimed zero.
                        let _ = app.emit("codex-session-diff-updated", stats);
                    }
                    for session in unavailable {
                        let _ = app.emit("codex-session-diff-updated", serde_json::json!({
                            "sessionId":session, "unavailable":true
                        }));
                    }
                    if !retry_ancestors.is_empty() {
                        let mut queue = queue().lock().unwrap_or_else(|e| e.into_inner());
                        for session in retry_ancestors { queue.request(&session, None); }
                    }
                }
                Err(error) => {
                    tracing::debug!(session_id = %session, %error, "Codex sidebar diff refresh failed");
                    if !retrying {
                        // Preserve the last measured totals but stop presenting
                        // them as complete when their history cannot be verified.
                        let _ = app.emit("codex-session-diff-updated", serde_json::json!({
                            "sessionId":session, "unavailable":true
                        }));
                    }
                },
                _ => {}
            }
            if !current { tokio::time::sleep(std::time::Duration::from_millis(300)).await; }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture_meta(id: &str, parent: Option<&str>, cwd: &str) -> Value {
        let mut meta = json!({"type":"session_meta", "ordinal":0, "payload":{
            "id":id,"session_id":"shared-is-not-an-owner","cwd":cwd,"timestamp":"2026-09-01T00:00:00Z","source":"cli"
        }});
        if let Some(parent) = parent {
            meta["payload"]["source"] = json!({"subagent":{"thread_spawn":{"parent_thread_id":parent}}});
            meta["payload"]["forked_from_id"] = json!(parent);
            meta["payload"]["subagent_history_start_ordinal"] = json!(100);
        }
        meta
    }

    fn fixture_edit(owner: &str, id: &str, path: &str, added: &str, ordinal: u64) -> Value {
        json!({"type":"event_msg","ordinal":ordinal,"timestamp":"2026-09-01T00:01:00Z","payload":{
            "type":"item_completed","thread_id":owner,"turn_id":format!("{owner}-turn"),
            "item":{"type":"FileChange","id":id,"status":"completed","changes":{
                path:{"type":"add","content":added}
            }}
        }})
    }

    fn fixture_write(root: &Path, id: &str, rows: &[Value]) -> PathBuf {
        let path = root.join(format!("{id}.jsonl"));
        std::fs::write(&path, rows.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n").unwrap();
        path
    }

    #[test]
    fn parent_rollup_excludes_copies_and_keeps_distinct_identical_edits() {
        let root = tempfile::tempdir().unwrap();
        let parent = fixture_edit("parent", "parent-edit", "same.rs", "a\n", 1);
        fixture_write(root.path(), "parent", &[fixture_meta("parent", None, "/repo"), parent.clone()]);
        fixture_write(root.path(), "child", &[
            fixture_meta("child", Some("parent"), "/repo"),
            fixture_meta("parent", None, "/wrong-copied-cwd"), parent,
            // The explicit child owner survives a stale migrated cutoff of 100.
            fixture_edit("child", "child-edit", "same.rs", "a\n", 3),
            fixture_edit("child", "second-edit", "same.rs", "a\n", 4),
        ]);
        let mut catalog = SessionCatalog::default();
        catalog.refresh(root.path());
        let rolled = catalog.aggregate("parent", Some("/repo")).unwrap();
        assert_eq!((rolled.stats.lines_added, rolled.stats.lines_removed, rolled.stats.files_changed), (3, 0, 1));
        assert!(!rolled.stats.native_incomplete);
        assert_eq!(rolled.native_files.len(), 3);
        assert_eq!(catalog.aggregate("child", None).unwrap().stats.lines_added, 2);
    }

    #[test]
    fn stable_edit_ids_deduplicate_copied_receipts_across_children() {
        let root = tempfile::tempdir().unwrap();
        fixture_write(root.path(), "parent", &[fixture_meta("parent", None, "/repo")]);
        for child in ["first", "second"] {
            fixture_write(root.path(), child, &[fixture_meta(child, Some("parent"), "/repo"),
                fixture_edit(child, "retained-call", "a.rs", "one\ntwo\n", 101)]);
        }
        let mut catalog = SessionCatalog::default();
        catalog.refresh(root.path());
        assert_eq!(catalog.aggregate("parent", None).unwrap().stats.lines_added, 2);
    }

    fn mixed_provenance_rollup(wrapper_count: usize, native_count: usize) -> NativeDiffRollup {
        let root = tempfile::tempdir().unwrap();
        let mut catalog = SessionCatalog::default();
        let parent_path = fixture_write(root.path(), "parent", &[fixture_meta("parent", None, "/repo")]);
        let child_path = fixture_write(root.path(), "child", &[fixture_meta("child", Some("parent"), "/repo")]);
        catalog.refresh(root.path());
        // Facts retain the parser's per-file occurrence ordinals. Exercise the
        // aggregate reducer with both provenances for the same stable operation.
        for (path, native, count) in [(parent_path, false, wrapper_count), (child_path, true, native_count)] {
            let facts = SessionFacts { incomplete: false, edits: (0..count).map(|occurrence| EditFact {
                id:"shared-edit".into(), occurrence, path:"/repo/a.rs".into(), added:1, removed:0, native,
            }).collect() };
            catalog.facts.insert(path.clone(), (file_stamp(&path).unwrap(), facts));
        }
        catalog.aggregate("parent", None).unwrap()
    }

    #[test]
    fn equal_native_counts_replace_wrapper_provenance() {
        let result = mixed_provenance_rollup(1, 1);
        assert_eq!(result.stats.lines_added, 1);
        assert!(result.native_files.contains(&("shared-edit".into(), "/repo/a.rs".into())));
    }

    #[test]
    fn one_native_occurrence_suppresses_every_wrapper_occurrence_for_its_file() {
        let result = mixed_provenance_rollup(2, 1);
        assert_eq!(result.stats.lines_added, 1);
        assert_eq!(result.stats.files_changed, 1);
    }

    #[test]
    fn multiple_native_occurrences_remain_distinct() {
        let result = mixed_provenance_rollup(3, 2);
        assert_eq!(result.stats.lines_added, 2);
        assert_eq!(result.stats.files_changed, 1);
        assert_eq!(result.native_files.len(), 1);
    }

    #[test]
    fn explicit_owned_turn_keeps_wrapper_pairs_before_migrated_cutoff() {
        let root = tempfile::tempdir().unwrap();
        let patch = "*** Begin Patch\n*** Add File: a.rs\n+one\n*** End Patch";
        fixture_write(root.path(), "parent", &[fixture_meta("parent", None, "/repo")]);
        fixture_write(root.path(), "child", &[
            fixture_meta("child", Some("parent"), "/repo"),
            json!({"type":"response_item","ordinal":2,"payload":{"type":"custom_tool_call","name":"apply_patch",
                "call_id":"wrapped","input":patch,"internal_chat_message_metadata_passthrough":{"turn_id":"owned-turn"}}}),
            json!({"type":"token_usage_record","ordinal":3,"payload":{"thread_id":"child","turn_id":"owned-turn"}}),
            json!({"type":"response_item","ordinal":4,"payload":{"type":"custom_tool_call_output","call_id":"wrapped",
                "output":"{\"metadata\":{\"exit_code\":0}}","internal_chat_message_metadata_passthrough":{"turn_id":"owned-turn"}}}),
        ]);
        let mut catalog = SessionCatalog::default();
        catalog.refresh(root.path());
        assert_eq!(catalog.aggregate("parent", None).unwrap().stats.lines_added, 1);
    }

    #[test]
    fn child_paths_use_own_cwd_and_guardians_never_join_parent() {
        let root = tempfile::tempdir().unwrap();
        fixture_write(root.path(), "parent", &[fixture_meta("parent", None, "/repo"), fixture_edit("parent", "p", "a.rs", "p\n", 1)]);
        fixture_write(root.path(), "child", &[fixture_meta("child", Some("parent"), "/worktree"), fixture_edit("child", "c", "a.rs", "c\n", 1)]);
        let mut guardian = fixture_meta("guardian", None, "/repo");
        guardian["payload"]["session_id"] = json!("parent");
        guardian["payload"]["source"] = json!({"subagent":{"other":"guardian"}});
        fixture_write(root.path(), "guardian", &[guardian, fixture_edit("guardian", "g", "a.rs", "g\n", 1)]);
        let mut catalog = SessionCatalog::default();
        catalog.refresh(root.path());
        let stats = catalog.aggregate("parent", None).unwrap().stats;
        assert_eq!((stats.lines_added, stats.files_changed), (2, 2));
    }

    #[test]
    fn late_child_edits_invalidate_parent_and_missing_child_stays_partial() {
        let root = tempfile::tempdir().unwrap();
        fixture_write(root.path(), "parent", &[fixture_meta("parent", None, "/repo")]);
        let header = fixture_meta("child", Some("parent"), "/repo");
        let path = fixture_write(root.path(), "child", &[header.clone()]);
        let mut catalog = SessionCatalog::default();
        catalog.refresh(root.path());
        assert_eq!(catalog.aggregate("parent", None).unwrap().stats.lines_added, 0);
        fixture_write(root.path(), "child", &[header, fixture_edit("child", "late", "a.rs", "late\n", 1)]);
        assert!(catalog.refresh(root.path()).contains(&"parent".to_string()));
        assert_eq!(catalog.ancestors("child"), vec!["child", "parent"]);
        assert_eq!(catalog.aggregate("parent", None).unwrap().stats.lines_added, 1);
        std::fs::remove_file(path).unwrap();
        assert!(catalog.refresh(root.path()).contains(&"parent".to_string()));
        assert!(catalog.aggregate("parent", None).unwrap().stats.native_incomplete);
    }

    #[test]
    fn ancestry_cycles_and_unowned_child_edits_are_partial() {
        let root = tempfile::tempdir().unwrap();
        fixture_write(root.path(), "parent", &[fixture_meta("parent", Some("child"), "/repo")]);
        let mut child = fixture_meta("child", Some("parent"), "/repo");
        child["payload"].as_object_mut().unwrap().remove("subagent_history_start_ordinal");
        child["payload"].as_object_mut().unwrap().remove("timestamp");
        let mut edit = fixture_edit("child", "unowned", "a.rs", "unknown\n", 1);
        edit["payload"].as_object_mut().unwrap().remove("thread_id");
        fixture_write(root.path(), "child", &[child, edit]);
        let mut catalog = SessionCatalog::default();
        catalog.refresh(root.path());
        let stats = catalog.aggregate("parent", None).unwrap().stats;
        assert!(stats.native_incomplete);
        assert_eq!(stats.lines_added, 0);
    }

    #[test]
    fn timestamps_and_unverified_fork_cutoffs_never_assign_child_edits() {
        let root = tempfile::tempdir().unwrap();
        fixture_write(root.path(), "parent", &[fixture_meta("parent", None, "/repo")]);
        let mut child = fixture_meta("child", Some("parent"), "/repo");
        child["payload"].as_object_mut().unwrap().remove("subagent_history_start_ordinal");
        child["payload"]["forked_from_ordinal_exclusive"] = json!(1);
        let mut edit = fixture_edit("child", "unknown", "a.rs", "unknown\n", 200);
        edit["payload"].as_object_mut().unwrap().remove("thread_id");
        fixture_write(root.path(), "child", &[child.clone(), edit.clone()]);
        let mut catalog = SessionCatalog::default();
        catalog.refresh(root.path());
        let unknown = catalog.aggregate("parent", None).unwrap().stats;
        assert_eq!(unknown.lines_added, 0);
        assert!(unknown.native_incomplete);
        child["payload"]["subagent_history_start_ordinal"] = json!(200);
        fixture_write(root.path(), "child", &[child, edit]);
        catalog.refresh(root.path());
        let verified = catalog.aggregate("parent", None).unwrap().stats;
        assert_eq!(verified.lines_added, 1);
        assert!(!verified.native_incomplete);
    }

    #[test]
    fn malformed_unrelated_header_does_not_taint_known_parent_lineage() {
        let root = tempfile::tempdir().unwrap();
        fixture_write(root.path(), "parent", &[fixture_meta("parent", None, "/repo")]);
        std::fs::write(root.path().join("unrelated.jsonl"), "{broken").unwrap();
        let mut catalog = SessionCatalog::default();
        catalog.refresh(root.path());
        assert!(!catalog.aggregate("parent", None).unwrap().stats.native_incomplete);
    }

    #[test]
    fn changed_root_file_refreshes_even_when_native_updated_at_is_unchanged() {
        let root = tempfile::tempdir().unwrap();
        let meta = fixture_meta("parent", None, "/repo");
        fixture_write(root.path(), "parent", &[meta.clone(), fixture_edit("parent", "edit", "a.rs", "one\n", 1)]);
        let mut catalog = SessionCatalog::default();
        let mut queue = RefreshQueue::default();
        let row = json!({"id":"parent","updatedAt":1});
        assert!(queue.discover(&[row.clone()]));
        assert!(catalog.refresh(root.path()).is_empty(), "initial roots keep discovery order");
        let (id, generation) = queue.next().unwrap();
        assert_eq!(catalog.aggregate(&id, None).unwrap().stats.lines_added, 1);
        assert!(queue.finish(&id, generation, true));
        assert!(queue.next().is_none());
        fixture_write(root.path(), "parent", &[meta, fixture_edit("parent", "edit", "a.rs", "one\ntwo\n", 1)]);
        assert!(!queue.discover(&[row]));
        let changed = catalog.refresh(root.path());
        assert_eq!(changed, vec!["parent"]);
        for id in changed { assert!(queue.request(&id, None)); }
        let (id, generation) = queue.next().unwrap();
        assert_eq!(catalog.aggregate(&id, None).unwrap().stats.lines_added, 2);
        assert!(queue.finish(&id, generation, true));
    }

    #[test]
    fn optional_real_child_rollup_matches_both_reported_parents() {
        let Ok(root) = std::env::var("AGMUX_CODEX_ROLLUP_ROOT") else { return; };
        let mut catalog = SessionCatalog::default();
        catalog.refresh(Path::new(&root));
        for (parent, added, removed) in [
            ("01a08821-0c82-7233-a5c2-bf0db424f2b3", 655, 10),
            ("01a08c53-1958-73d1-a275-600d8e78aab3", 97, 7),
        ] {
            let rolled = catalog.aggregate(parent, None).unwrap();
            assert_eq!((rolled.stats.lines_added, rolled.stats.lines_removed), (added, removed));
            eprintln!("child rollup: {}", serde_json::to_string(&rolled.stats).unwrap());
        }
    }

    #[test]
    fn optional_all_session_aggregate_audit() {
        let (Ok(manifest), Ok(inventory), Ok(root), Ok(output)) = (
            std::env::var("AGMUX_CODEX_ROLLUP_AUDIT_MANIFEST"),
            std::env::var("AGMUX_CODEX_ROLLUP_AUDIT_INVENTORY"),
            std::env::var("AGMUX_CODEX_ROLLUP_AUDIT_ROOT"),
            std::env::var("AGMUX_CODEX_ROLLUP_AUDIT_OUTPUT"),
        ) else { return; };
        let manifest: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(manifest).unwrap()).unwrap();
        let inventory: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(inventory).unwrap()).unwrap();
        let baseline: HashMap<_, _> = inventory.iter().map(|row| (row["id"].as_str().unwrap(), row)).collect();
        let mut catalog = SessionCatalog::default();
        catalog.refresh(Path::new(&root));
        let mut rows = Vec::new();
        let mut errors = Vec::new();
        let mut mismatches = Vec::new();
        let mut incomplete = Vec::new();
        let (mut positive_top, mut positive_top_preserved) = (0, 0);
        let (mut raw_added, mut raw_removed, mut rolled_added, mut rolled_removed) = (0, 0, 0, 0);
        for entry in manifest.iter().filter(|entry| entry["archived"] != true) {
            let id = entry["id"].as_str().unwrap();
            let own = baseline[id];
            let top = matches!(entry["source"].as_str(), Some("cli" | "vscode" | "appServer" | "unknown"));
            let (added, removed) = (own["additions"].as_u64().unwrap(), own["deletions"].as_u64().unwrap());
            raw_added += added; raw_removed += removed;
            if top && added + removed > 0 { positive_top += 1; }
            let mut pending = vec![id.to_string()];
            let mut lineage = HashSet::new();
            let mut reasons = Vec::new();
            let (mut expected_added, mut expected_removed) = (0, 0);
            if !catalog.complete { reasons.push("catalog enumeration incomplete".to_string()); }
            while let Some(member) = pending.pop() {
                if !lineage.insert(member.clone()) { reasons.push(format!("cycle or repeated lineage: {member}")); continue; }
                if let Some(base) = baseline.get(member.as_str()) {
                    expected_added += base["additions"].as_u64().unwrap();
                    expected_removed += base["deletions"].as_u64().unwrap();
                } else { reasons.push(format!("descendant absent from frozen baseline: {member}")); }
                match catalog.header(&member).and_then(|(path, header)| {
                    if header.ambiguous { reasons.push(format!("ambiguous first header: {member}")); }
                    catalog.session_facts(&path, &header)
                }) {
                    Ok(facts) if facts.incomplete => reasons.push(format!("owned-row or edit identity incomplete: {member}")),
                    Err(error) => reasons.push(format!("unreadable lineage {member}: {error}")),
                    _ => {}
                }
                for (_, header) in catalog.headers.values() {
                    if header.parent.as_deref() == Some(member.as_str()) { pending.push(header.id.clone()); }
                }
            }
            match catalog.aggregate(id, Some(entry["cwd"].as_str().unwrap())) {
                Ok(result) => {
                    let stats = result.stats;
                    rolled_added += stats.lines_added; rolled_removed += stats.lines_removed;
                    if top && added + removed > 0 && stats.lines_added >= added && stats.lines_removed >= removed {
                        positive_top_preserved += 1;
                    }
                    if (stats.lines_added, stats.lines_removed) != (expected_added, expected_removed) { mismatches.push(id); }
                    if stats.native_incomplete { incomplete.push(id); }
                    let mut lineage: Vec<_> = lineage.into_iter().collect(); lineage.sort();
                    rows.push(json!({"id":id,"topLevel":top,"baselineAdded":added,"baselineRemoved":removed,
                        "expectedAdded":expected_added,"expectedRemoved":expected_removed,"stats":stats,
                        "lineage":lineage,"incompleteReasons":reasons}));
                }
                Err(error) => { errors.push(json!({"id":id,"error":error,"incompleteReasons":reasons})); }
            }
        }
        let report = json!({"root":root,"sessions":rows.len(),"positiveTopLevel":positive_top,
            "positiveTopLevelPreserved":positive_top_preserved,"rawAdded":raw_added,"rawRemoved":raw_removed,
            "rolledAdded":rolled_added,"rolledRemoved":rolled_removed,"mismatches":mismatches,
            "incomplete":incomplete,"errors":errors,"rows":rows});
        std::fs::write(output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
        eprintln!("aggregate audit: {} sessions, {positive_top_preserved}/{positive_top} positive top-level preserved; raw +{raw_added}/-{raw_removed}, rolled +{rolled_added}/-{rolled_removed}; {} mismatches, {} incomplete, {} errors",
            rows.len(), mismatches.len(), incomplete.len(), errors.len());
        assert!(errors.is_empty(), "aggregate read errors; see audit JSON");
        assert!(mismatches.is_empty(), "unexpected aggregate changes; see audit JSON");
        assert_eq!(positive_top_preserved, positive_top);
    }

    #[tokio::test]
    async fn retained_file_rows_have_stable_edit_identity() {
        let Ok(session) = std::env::var("AGMUX_CODEX_IDENTITY_SESSION") else { return; };
        let history = crate::commands::codex::codex_read_session_history(session).await.unwrap();
        let files: Vec<_> = history.items.iter().filter(|item| item.role == "file").collect();
        assert!(!files.is_empty());
        assert!(files.iter().all(|item| item.tool_input.as_ref()
            .and_then(|input| input["editId"].as_str()).is_some_and(|id| !id.is_empty())),
            "file rows need native call identity before cross-session aggregation");
    }

    #[test]
    fn discovery_schedules_native_totals_without_opening_history() {
        let source = include_str!("../commands/codex.rs");
        let listing = source.split("pub async fn codex_list_threads(").nth(1).unwrap()
            .split("/// Read the effective Codex config").next().unwrap();
        assert!(listing.contains("diff_stats::hydrate_discovered"),
            "listing retained chats must request background native totals independently of view mounting");
        assert!(listing.contains("server.list_threads(Some(&cursor)"),
            "discovery must continue beyond the first 100 native sessions");
    }

    #[test]
    fn discovery_coalesces_all_pages_and_only_revisits_changed_sessions() {
        let mut queue = RefreshQueue::default();
        let rows: Vec<_> = (0..250).map(|i| json!({"id":format!("native-{i}"), "updatedAt":1})).collect();
        assert!(queue.discover(&rows));
        assert!(!queue.discover(&rows));
        assert_eq!(queue.pending.len(), 250);
        let mut reads = 0;
        while let Some((session, generation)) = queue.next() {
            reads += 1;
            // Repeated list events while scanning must not cause a trailing read.
            assert!(!queue.discover(&rows));
            assert!(queue.finish(&session, generation, true));
        }
        assert_eq!(reads, 250);
        assert!(!queue.running);
        assert!(!queue.discover(&rows));
        assert!(queue.next().is_none());
        assert!(queue.discover(&[json!({"id":"native-200", "updatedAt":2})]));
        assert_eq!(queue.next(), Some(("native-200".into(), 0)));
    }

    #[test]
    fn live_signals_supersede_inflight_discovery_and_take_priority() {
        let mut queue = RefreshQueue::default();
        let rows = [json!({"id":"first", "updatedAt":1}), json!({"id":"second", "updatedAt":1})];
        assert!(queue.discover(&rows));
        let (session, old) = queue.next().unwrap();
        for _ in 0..20 { assert!(!queue.request(&session, None)); }
        assert!(!queue.finish(&session, old, true), "stale totals cannot publish");
        assert!(queue.hydrated.is_empty());
        let (retry, new) = queue.next().unwrap();
        assert_eq!(retry, session);
        assert!(queue.finish(&retry, new, true));
        assert!(!queue.request("live", None));
        assert_eq!(queue.next().unwrap().0, "live");
        assert!(queue.finish("live", 0, true));
        assert_eq!(queue.next().unwrap().0, "second");
    }

    #[test]
    fn live_signal_promotes_a_session_already_waiting_for_cold_hydration() {
        let mut queue = RefreshQueue::default();
        queue.discover(&[json!({"id":"old", "updatedAt":1}), json!({"id":"active", "updatedAt":1})]);
        assert!(!queue.request("active", None));
        let (session, generation) = queue.next().unwrap();
        assert_eq!(session, "active");
        assert!(queue.finish(&session, generation, true));
        assert_eq!(queue.next().unwrap().0, "old");
    }

    #[test]
    fn fable_review_unstable_history_retries_without_another_event_and_stops() {
        let mut queue = RefreshQueue::default();
        queue.request("live", None);
        let (id, generation) = queue.next().unwrap();
        assert!(!queue.finish_error(&id, generation, "Session history changed during recalculation; try again"));
        let (id, generation) = queue.next().expect("transient read must retry without another discovery/turn event");
        assert!(queue.finish(&id, generation, true));
        assert!(queue.next().is_none());

        queue.request("busy", None);
        for attempt in 0..3 {
            let (id, generation) = queue.next().unwrap();
            assert!(!queue.finish_error(&id, generation, "Session history changed during recalculation; try again"));
            assert_eq!(queue.pending.contains_key("busy"), attempt < 2);
        }
        assert!(queue.next().is_none());
        queue.request("missing", None);
        let (id, generation) = queue.next().unwrap();
        assert!(!queue.finish_error(&id, generation, "Missing session"));
        assert!(queue.next().is_none());
    }

    #[test]
    fn failed_reads_retry_on_discovery_and_completed_cache_is_bounded() {
        let mut queue = RefreshQueue::default();
        let row = json!({"id":"missing", "updatedAt":1});
        queue.discover(&[row.clone()]);
        let (session, generation) = queue.next().unwrap();
        assert!(!queue.finish(&session, generation, false));
        assert!(queue.next().is_none());
        assert!(queue.discover(&[row]));
        let (session, generation) = queue.next().unwrap();
        assert!(queue.finish(&session, generation, true));
        for i in 0..=DISCOVERY_CACHE_CAPACITY {
            queue.request(&format!("native-{i}"), Some(json!(1)));
            let (session, generation) = queue.next().unwrap();
            assert!(queue.finish(&session, generation, true));
        }
        assert_eq!(queue.hydrated.len(), DISCOVERY_CACHE_CAPACITY);
        assert!(queue.next().is_none());
        assert!(queue.request("native-0", Some(json!(1))));
    }

    #[tokio::test]
    async fn optional_discovery_replays_every_retained_native_session() {
        let (Ok(manifest), Ok(inventory), Ok(destination)) = (
            std::env::var("AGMUX_CODEX_DISCOVERY_MANIFEST"),
            std::env::var("AGMUX_CODEX_DISCOVERY_INVENTORY"),
            std::env::var("AGMUX_CODEX_DISCOVERY_OUTPUT"),
        ) else { return; };
        let manifest: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(manifest).unwrap()).unwrap();
        let inventory: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(inventory).unwrap()).unwrap();
        // Archived entries are not returned by the ordinary native thread list.
        let entries: Vec<_> = manifest.iter().filter(|entry| entry["archived"] != true)
            .map(|entry| json!({"id":entry["id"], "updatedAt":entry["sha256"]})).collect();
        let mut queue = RefreshQueue::default();
        assert!(queue.discover(&entries));
        let mut payloads = Vec::new();
        let mut reads = 0;
        while let Some((session, generation)) = queue.next() {
            let history = crate::commands::codex::codex_read_session_history(session.clone()).await.unwrap();
            let stats = totals(&session, &history.items);
            let expected = inventory.iter().find(|entry| entry["id"] == session).unwrap();
            assert_eq!(stats.lines_added, expected["additions"].as_u64().unwrap(), "{session}");
            assert_eq!(stats.lines_removed, expected["deletions"].as_u64().unwrap(), "{session}");
            assert!(queue.finish(&session, generation, true));
            if stats.files_changed > 0 { payloads.push(stats); }
            reads += 1;
        }
        assert_eq!(reads, entries.len());
        assert!(!queue.discover(&entries), "unchanged history should require no additional reads");
        std::fs::write(destination, serde_json::to_vec_pretty(&payloads).unwrap()).unwrap();
        eprintln!("discovery read {reads} sessions; {} positive absolute event payloads; +{} -{}", payloads.len(),
            payloads.iter().map(|stats| stats.lines_added).sum::<u64>(),
            payloads.iter().map(|stats| stats.lines_removed).sum::<u64>());
    }

    #[test]
    fn native_and_wrapped_edits_refresh_without_a_chat_view() {
        let mut observer = DiffObserver::default();
        assert!(observer.observe("native-id", "item/completed", &json!({"item":{"type":"fileChange"}})));
        assert!(observer.observe("native-id", "codex/event/patch_apply_end", &json!({"msg":{"success":true}})));
        assert!(!observer.observe("native-id", "rawResponseItem/completed", &json!({"item":{"type":"custom_tool_call","call_id":"call","name":"exec","input":"text(await tools.apply_patch(\"patch\"));"}})));
        let result = json!({"item":{"type":"custom_tool_call_output","call_id":"call"}});
        assert!(!observer.observe("other", "rawResponseItem/completed", &result));
        assert!(observer.observe("native-id", "rawResponseItem/completed", &result));
        assert!(!observer.observe("native-id", "rawResponseItem/completed", &result));
        assert!(!observer.observe("native-id", "item/completed", &json!({"item":{"type":"commandExecution"}})));
        assert!(!observer.observe("native-id", "item/commandExecution/outputDelta", &json!({})));
    }

    #[test]
    fn terminal_native_edits_refresh_even_without_app_server_events() {
        let mut observer = DiffObserver::default();
        assert!(observer.observe_record("terminal-id", &json!({"type":"event_msg","payload":{
            "type":"patch_apply_end","success":true,"changes":{"a.ts":{"type":"update","unified_diff":"@@\n-old\n+new\n"}}
        }})));
        assert!(!observer.observe_record("terminal-id", &json!({"type":"event_msg","payload":{"type":"patch_apply_end","success":false}})));
        assert!(!observer.observe_record("terminal-id", &json!({"type":"event_msg","payload":{"type":"token_count"}})));
        assert!(observer.observe_record("terminal-id", &json!({"type":"event_msg","payload":{"type":"task_complete"}})));
        assert!(!observer.observe_record("terminal-id", &json!({"type":"response_item","payload":{
            "type":"custom_tool_call","name":"exec","call_id":"patch","input":"text(await tools.apply_patch(\"patch\"));"
        }})));
        assert!(observer.observe_record("terminal-id", &json!({"type":"response_item","payload":{
            "type":"custom_tool_call_output","call_id":"patch","output":[]
        }})));
    }

    #[test]
    fn completed_file_change_records_refresh_chat_and_terminal_totals() {
        let mut observer = DiffObserver::default();
        let payload = json!({"type":"item_completed", "item":{
            "type":"FileChange", "id":"native-edit", "status":"completed",
            "changes":{"a.ts":{"type":"update","unified_diff":"@@\n-old\n+new\n"}}
        }});
        assert!(observer.observe_record("session", &json!({"type":"event_msg","payload":payload})));
        assert!(observer.observe("session", "codex/event/item_completed", &json!({"msg":payload})));
        for status in ["failed", "inProgress", "declined"] {
            let mut pending = payload.clone();
            pending["item"]["status"] = json!(status);
            assert!(!observer.observe_record("session", &json!({"type":"event_msg","payload":pending})));
        }
        let mut command = payload;
        command["item"]["type"] = json!("CommandExecution");
        assert!(!observer.observe_record("session", &json!({"type":"event_msg","payload":command})));
    }

    #[tokio::test]
    async fn reported_terminal_records_to_sidebar_payload() {
        let (Ok(session), Ok(destination), Ok(file)) = (
            std::env::var("AGMUX_CODEX_DIFF_SESSION"), std::env::var("AGMUX_CODEX_DIFF_PAYLOAD"),
            std::env::var("AGMUX_CODEX_DIFF_TRANSCRIPT"),
        ) else { return; };
        let content = std::fs::read_to_string(file).unwrap();
        let mut observer = DiffObserver::default();
        let mut updates = 0;
        for record in content.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()) {
            if observer.observe_record(&session, &record) { updates += 1; }
        }
        assert!(updates > 0, "real terminal transcript must request a sidebar refresh");
        let history = crate::commands::codex::codex_read_session_history(session.clone()).await.unwrap();
        if let Ok(path) = std::env::var("AGMUX_CODEX_DIFF_HISTORY") {
            std::fs::write(path, serde_json::to_vec(&history).unwrap()).unwrap();
        }
        let stats = totals(&session, &history.items);
        assert!(stats.lines_added > 0 && stats.files_changed > 0);
        std::fs::write(destination, serde_json::to_vec(&stats).unwrap()).unwrap();
        eprintln!("terminal refresh signals: {updates}; sidebar payload: {}", serde_json::to_string(&stats).unwrap());
    }

    #[test]
    fn absolute_totals_only_use_verified_file_rows_and_deduplicate_paths() {
        let file = |added, removed| serde_json::from_value::<SessionHistoryItem>(json!({
            "role":"file","content":"diff","timestamp":"now","file_path":"same.rs","additions":added,"deletions":removed
        })).unwrap();
        let mut failed = file(500,500);
        failed.role = "tool".into();
        failed.tool_error = Some(true);
        let rows = [file(22,0), file(8,0), failed];
        let stats = totals("native-id", &rows);
        assert_eq!(stats, CodexDiffStats { session_id:"native-id".into(), lines_added:30, lines_removed:0, files_changed:1, native_incomplete:false });
        assert_eq!(totals("native-id", &rows), stats);
    }
}
