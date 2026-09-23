use crate::db::models::ThreadJournalEntry;

/// Wrap a prompt with context information for the AI agent.
///
/// If `include_auggie` is true, the wrapper includes instructions to use
/// auggie/codebase-retrieval for context. Journal entries are injected
/// as a context block.
pub fn wrap_prompt(
    prompt: &str,
    include_auggie: bool,
    journal_entries: &[ThreadJournalEntry],
) -> String {
    let mut parts = Vec::new();

    if include_auggie {
        parts.push(format!(
            r#"<xanom-context>
Before executing, use the auggie codebase-retrieval tool to understand the relevant parts of the codebase. Search for files and symbols related to this task.
</xanom-context>

{}"#,
            prompt
        ));
    } else {
        parts.push(prompt.to_string());
    }

    if !journal_entries.is_empty() {
        let mut journal_block = String::from("\n\n<xanom-journal>\n");
        journal_block.push_str(
            "The following context has been gathered from previous work on this thread:\n\n",
        );

        for entry in journal_entries {
            journal_block.push_str(&format!(
                "- [{}] {}: {}\n",
                entry.kind, entry.title, entry.content
            ));
        }

        journal_block.push_str("</xanom-journal>");
        parts.push(journal_block);
    }

    parts.join("")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: &str, title: &str, content: &str) -> ThreadJournalEntry {
        ThreadJournalEntry {
            id: "id".into(),
            thread_id: "tid".into(),
            kind: kind.into(),
            title: title.into(),
            content: content.into(),
            source: "User".into(),
            confidence: None,
            created_by: None,
            created_at: "2025-01-01 00:00:00".into(),
            updated_at: "2025-01-01 00:00:00".into(),
            is_archived: 0,
        }
    }

    #[test]
    fn wrap_passes_through_when_no_extras() {
        let out = wrap_prompt("hello", false, &[]);
        assert_eq!(out, "hello");
    }

    #[test]
    fn wrap_includes_auggie_block_when_requested() {
        let out = wrap_prompt("do thing", true, &[]);
        assert!(out.contains("<xanom-context>"));
        assert!(out.contains("</xanom-context>"));
        assert!(out.contains("auggie"));
        assert!(out.contains("do thing"));
    }

    #[test]
    fn wrap_omits_auggie_block_when_false() {
        let out = wrap_prompt("just do it", false, &[]);
        assert!(!out.contains("<xanom-context>"));
        assert!(out.contains("just do it"));
    }

    #[test]
    fn wrap_appends_journal_block_when_entries_present() {
        let entries = vec![
            entry("Decision", "Use TS", "We picked TS over JS"),
            entry("Convention", "Files small", "Prefer many small files"),
        ];
        let out = wrap_prompt("task", false, &entries);
        assert!(out.contains("<xanom-journal>"));
        assert!(out.contains("</xanom-journal>"));
        assert!(out.contains("[Decision] Use TS: We picked TS over JS"));
        assert!(out.contains("[Convention] Files small: Prefer many small files"));
    }

    #[test]
    fn wrap_combines_auggie_and_journal() {
        let entries = vec![entry("Note", "n", "c")];
        let out = wrap_prompt("p", true, &entries);
        // Order: prompt-with-auggie first, then journal block.
        let auggie_idx = out.find("<xanom-context>").unwrap();
        let journal_idx = out.find("<xanom-journal>").unwrap();
        assert!(auggie_idx < journal_idx);
    }
}
