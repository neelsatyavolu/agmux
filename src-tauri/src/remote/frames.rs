//! Keep outbound snapshots within the relay's UTF-8 frame budget.

use super::protocol::WireMessage;
use serde_json::json;

const MAX_FRAME_BYTES: usize = 1024 * 1024;

pub(super) fn encode(message: &WireMessage) -> Result<Vec<String>, String> {
    let raw = serde_json::to_string(message).map_err(|e| e.to_string())?;
    if raw.len() <= MAX_FRAME_BYTES {
        return Ok(vec![raw]);
    }
    let mut value = serde_json::to_value(message).map_err(|e| e.to_string())?;
    match message {
        WireMessage::TimelineSnapshot { .. } | WireMessage::TimelineAppend { .. } => {
            let entries = value["entries"].as_array_mut().map(std::mem::take).unwrap_or_default();
            let mut frames = Vec::new();
            let mut size = value.to_string().len();
            for mut entry in entries {
                let mut entry_size = entry.to_string().len();
                if entry_size + size + 1 > MAX_FRAME_BYTES && value["entries"].as_array().is_some_and(|a| !a.is_empty()) {
                    frames.push(value.to_string());
                    value["type"] = json!("timeline.append");
                    value["entries"] = json!([]);
                    value.as_object_mut().map(|o| o.remove("emptyHint"));
                    size = value.to_string().len();
                }
                if entry_size + size > MAX_FRAME_BYTES {
                    // A single tool result or assistant message can exceed the
                    // entire budget. Preserve its identity/state and make loss
                    // of long display fields explicit instead of losing history.
                    for field in ["text", "body", "detail", "subject", "message", "lead"] {
                        if let Some(text) = entry[field].as_str().filter(|s| s.len() > 32 * 1024) {
                            entry[field] = json!(format!("{}\n\n[Trimmed for remote viewing. Open this session on your Mac for the full content.]",
                                crate::text::byte_prefix(text, 32 * 1024)));
                        }
                    }
                    entry_size = entry.to_string().len();
                }
                let separator = usize::from(value["entries"].as_array().is_some_and(|a| !a.is_empty()));
                if size + entry_size + separator > MAX_FRAME_BYTES {
                    return oversized_error(message);
                }
                size += entry_size + separator;
                if let Some(entries) = value["entries"].as_array_mut() {
                    entries.push(entry);
                }
            }
            frames.push(value.to_string());
            Ok(frames)
        }
        WireMessage::ThreadsSnapshot { .. } => {
            let threads = value["threads"].as_array_mut().map(std::mem::take).unwrap_or_default();
            // Reserve space for sequence metadata added once the final count
            // is known. Phone stages these chunks and applies them atomically.
            let budget = MAX_FRAME_BYTES - 256;
            let mut chunks = Vec::new();
            let base_size = value.to_string().len();
            let mut size = base_size;
            for thread in threads {
                let thread_size = thread.to_string().len() + 1;
                if base_size + thread_size > budget {
                    return oversized_error(message);
                }
                if size + thread_size > budget {
                    chunks.push(value.clone());
                    value["threads"] = json!([]);
                    size = base_size;
                }
                if let Some(threads) = value["threads"].as_array_mut() {
                    threads.push(thread);
                }
                size += thread_size;
            }
            chunks.push(value);
            let snapshot_id = uuid::Uuid::new_v4().to_string();
            let count = chunks.len();
            Ok(chunks.into_iter().enumerate().map(|(index, mut chunk)| {
                chunk["snapshotId"] = json!(snapshot_id);
                chunk["chunkIndex"] = json!(index);
                chunk["chunkCount"] = json!(count);
                chunk.to_string()
            }).collect())
        }
        WireMessage::ApprovalRequested { .. } | WireMessage::UserInputRequested { .. } => {
            // A dropped prompt leaves the phone blind while the Mac waits, so
            // trim long display text instead. Answers are keyed by question
            // text and option labels, which stay intact.
            trim_long_strings(&mut value);
            let raw = value.to_string();
            if raw.len() > MAX_FRAME_BYTES {
                return oversized_error(message);
            }
            Ok(vec![raw])
        }
        _ => oversized_error(message),
    }
}

const TRIMMED_FIELD_BYTES: usize = 32 * 1024;

fn trim_long_strings(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, field) in map.iter_mut() {
                if matches!(key.as_str(), "question" | "label" | "id" | "header" | "threadId" | "requestId") {
                    continue;
                }
                if let Some(text) = field.as_str().filter(|s| s.len() > TRIMMED_FIELD_BYTES) {
                    *field = json!(format!("{}\n\n[Trimmed for remote viewing. Open this session on your Mac for the full content.]",
                        crate::text::byte_prefix(text, TRIMMED_FIELD_BYTES)));
                } else {
                    trim_long_strings(field);
                }
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(trim_long_strings),
        _ => {}
    }
}

fn oversized_error(message: &WireMessage) -> Result<Vec<String>, String> {
    let thread_id = match message {
        WireMessage::TimelineSnapshot { thread_id, .. }
        | WireMessage::TimelineAppend { thread_id, .. }
        | WireMessage::TimelinePatch { thread_id, .. }
        | WireMessage::ApprovalRequested { thread_id, .. }
        | WireMessage::UserInputRequested { thread_id, .. } => Some(thread_id.clone()),
        _ => None,
    };
    serde_json::to_string(&WireMessage::Error {
        request_id: None,
        thread_id,
        message: "This remote response is too large to display. Open it on your Mac.".into(),
    }).map(|frame| vec![frame]).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn timeline(entries: Vec<Value>) -> WireMessage {
        serde_json::from_value(json!({
            "type": "timeline.snapshot", "threadId": "t1", "entries": entries,
        })).unwrap()
    }

    fn entry(id: usize, text: &str) -> Value {
        json!({ "id": id.to_string(), "kind": "assistant", "text": text, "ts": id })
    }

    #[test]
    fn oversized_prompts_trim_display_text_but_keep_answer_keys() {
        let big = "x".repeat(2 * MAX_FRAME_BYTES);
        let approval = WireMessage::ApprovalRequested {
            thread_id: "t1".into(),
            request_id: "r1".into(),
            tool_name: "Bash".into(),
            detail: big.clone(),
        };
        let frames = encode(&approval).unwrap();
        let v: Value = serde_json::from_str(&frames[0]).unwrap();
        assert_eq!(v["type"], "approval.requested");
        assert_eq!(v["requestId"], "r1");
        assert!(frames[0].len() < MAX_FRAME_BYTES);

        let question = WireMessage::UserInputRequested {
            thread_id: "t1".into(),
            request_id: "q1".into(),
            questions: json!([{ "question": "Which layout?", "options": [{ "label": "A", "preview": big }] }]),
        };
        let frames = encode(&question).unwrap();
        let v: Value = serde_json::from_str(&frames[0]).unwrap();
        assert_eq!(v["type"], "userInput.requested");
        assert_eq!(v["questions"][0]["question"], "Which layout?");
        assert_eq!(v["questions"][0]["options"][0]["label"], "A");
        assert!(frames[0].len() < MAX_FRAME_BYTES);
    }

    #[test]
    fn large_timeline_frames_preserve_every_entry_in_order() {
        let entries: Vec<Value> = (0..30).map(|i| entry(i, &"界\n\"".repeat(16000))).collect();
        let message = timeline(entries.clone());
        let frames = encode(&message).unwrap();
        assert!(frames.len() > 1);
        let mut restored = Vec::new();
        for (index, frame) in frames.iter().enumerate() {
            assert!(frame.len() <= MAX_FRAME_BYTES);
            let value: Value = serde_json::from_str(frame).unwrap();
            assert_eq!(value["type"], if index == 0 { "timeline.snapshot" } else { "timeline.append" });
            assert_eq!(value["threadId"], "t1");
            restored.extend(value["entries"].as_array().unwrap().clone());
        }
        assert_eq!(restored, entries);
    }

    #[test]
    fn single_huge_tool_output_is_explicitly_trimmed_with_valid_unicode() {
        let message = timeline(vec![entry(1, &"界😀".repeat(250000))]);
        let frames = encode(&message).unwrap();
        assert_eq!(frames.len(), 1);
        assert!(frames[0].len() <= MAX_FRAME_BYTES);
        let value: Value = serde_json::from_str(&frames[0]).unwrap();
        let text = value["entries"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("界😀"));
        assert!(text.ends_with("[Trimmed for remote viewing. Open this session on your Mac for the full content.]"));
    }

    #[test]
    fn small_messages_keep_their_wire_representation() {
        let message = timeline(vec![entry(1, "hello")]);
        assert_eq!(encode(&message).unwrap(), vec![serde_json::to_string(&message).unwrap()]);
    }

    #[test]
    fn large_catalog_chunks_have_atomic_sequence_metadata_and_all_rows() {
        let threads: Vec<Value> = (0..1200).map(|i| json!({
            "id": i.to_string(), "title": "界\n\"".repeat(200), "provider": "Codex",
            "interactionMode": "sdk", "surface": "chat", "processing": false,
            "needsApproval": false, "lastActive": "",
        })).collect();
        let message: WireMessage = serde_json::from_value(json!({
            "type": "threads.snapshot", "threads": threads,
            "draftPrefs": { "provider": "Codex", "model": "example" },
        })).unwrap();
        let frames = encode(&message).unwrap();
        assert!(frames.len() > 1);
        let mut ids = Vec::new();
        let mut snapshot_id = None;
        for (index, frame) in frames.iter().enumerate() {
            assert!(frame.len() <= MAX_FRAME_BYTES);
            let value: Value = serde_json::from_str(frame).unwrap();
            assert_eq!(value["type"], "threads.snapshot");
            assert_eq!(value["chunkIndex"], index);
            assert_eq!(value["chunkCount"], frames.len());
            assert_eq!(value["draftPrefs"]["model"], "example");
            let id = value["snapshotId"].as_str().unwrap().to_string();
            assert_eq!(snapshot_id.get_or_insert(id.clone()), &id);
            ids.extend(value["threads"].as_array().unwrap().iter().map(|t| t["id"].clone()));
        }
        assert_eq!(ids, (0..1200).map(|i| json!(i.to_string())).collect::<Vec<_>>());
        let next: Value = serde_json::from_str(&encode(&message).unwrap()[0]).unwrap();
        assert_ne!(next["snapshotId"].as_str(), snapshot_id.as_deref());
    }
}
