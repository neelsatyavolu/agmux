//! Track successful Gemini chat file edits for the shared thread counters.

use crate::diff_stats::{compute_delta, snapshot_file};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

#[derive(Default)]
pub(super) struct DiffTracker {
    pending: HashMap<String, (PathBuf, Vec<u8>)>,
    touched: HashSet<PathBuf>,
}

impl DiffTracker {
    pub async fn process(&mut self, event: &Value, work_dir: &str) -> Option<(u64, u64, u64)> {
        let id = event.get("toolUseId")?.as_str()?;
        match event.get("type")?.as_str()? {
            "tool.started" => {
                let name = event.get("name")?.as_str()?;
                if !matches!(name, "edit_file" | "write_file" | "multi_replace_file_content")
                    || self.pending.contains_key(id)
                {
                    return None;
                }
                let input = event.get("input")?;
                let path = input.get("file_path").or_else(|| input.get("path"))?.as_str()?;
                if path.is_empty() {
                    return None;
                }
                let path = PathBuf::from(work_dir).join(path);
                let before = match snapshot_file(&path).await {
                    Some(bytes) => bytes,
                    None if !path.exists() => Vec::new(),
                    // Unreadable/oversized files are not new files.
                    None => return None,
                };
                self.pending.insert(id.to_string(), (path, before));
                None
            }
            "tool.completed" => {
                let (path, before) = self.pending.remove(id)?;
                if event.get("isError").and_then(Value::as_bool) == Some(true) {
                    return None;
                }
                let after = snapshot_file(&path).await?;
                let (added, removed) = compute_delta(&before, &after).await;
                if added == 0 && removed == 0 {
                    return None;
                }
                let files = u64::from(self.touched.insert(path));
                Some((added, removed, files))
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn started(id: &str, name: &str, path: &str) -> Value {
        json!({"type":"tool.started", "toolUseId":id, "name":name, "input":{"file_path":path}})
    }

    fn completed(id: &str, failed: bool) -> Value {
        json!({"type":"tool.completed", "toolUseId":id, "isError":failed})
    }

    #[tokio::test]
    async fn antigravity_events_track_create_and_replace_tools() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let file = dir.path().join("file.txt");
        let mut tracker = DiffTracker::default();
        for (id, title, key, content, expected) in [
            ("a", "write_to_file", "TargetFile", "old\n", (1, 0, 1)),
            ("b", "replace_file_content", "TargetFile", "new\n", (1, 1, 0)),
            ("c", "multi_replace_file_content", "TargetFile", "last\n", (1, 1, 0)),
        ] {
            let raw = json!({"method":"session/update", "params":{"sessionId":"S", "update":{
                "sessionUpdate":"tool_call", "toolCallId":id, "title":title,
                "kind":"edit", "rawInput":{key:file.to_str().unwrap()}
            }}});
            let event = crate::gemini::event_mapper::translate_session_update(&raw, "T").unwrap();
            tracker.process(&event, root).await;
            std::fs::write(&file, content).unwrap();
            // A repeated start must not replace the original pre-edit snapshot.
            tracker.process(&event, root).await;
            assert_eq!(tracker.process(&completed(id, false), root).await, Some(expected));
        }
    }

    #[tokio::test]
    async fn successful_edits_count_changed_lines_and_deduplicate_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let file = dir.path().join("file.txt");
        std::fs::write(&file, "keep\nold\n").unwrap();
        let mut tracker = DiffTracker::default();
        tracker.process(&started("a", "edit_file", "file.txt"), root).await;
        std::fs::write(&file, "keep\nnew\nextra\n").unwrap();
        assert_eq!(tracker.process(&completed("a", false), root).await, Some((2, 1, 1)));
        assert_eq!(tracker.process(&completed("a", false), root).await, None);
        tracker.process(&started("b", "write_file", "file.txt"), root).await;
        std::fs::write(&file, "keep\n").unwrap();
        assert_eq!(tracker.process(&completed("b", false), root).await, Some((0, 2, 0)));
    }

    #[tokio::test]
    async fn new_files_failed_tools_and_reads() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let file = dir.path().join("new.txt");
        let mut tracker = DiffTracker::default();
        tracker.process(&started("a", "write_file", "new.txt"), root).await;
        std::fs::write(&file, "one\ntwo\n").unwrap();
        assert_eq!(tracker.process(&completed("a", false), root).await, Some((2, 0, 1)));
        tracker.process(&started("b", "edit_file", "new.txt"), root).await;
        assert_eq!(tracker.process(&completed("b", true), root).await, None);
        assert_eq!(tracker.process(&completed("b", false), root).await, None);
        tracker.process(&started("c", "view_file", "new.txt"), root).await;
        assert_eq!(tracker.process(&completed("c", false), root).await, None);
        tracker.process(&started("d", "edit_file", "new.txt"), root).await;
        assert_eq!(tracker.process(&completed("d", false), root).await, None);
    }
}
