//! Normalised tool-activity signals shared by the three provider readers.
//!
//! Managers asked two questions the token counters could not answer: *what are
//! the agents actually doing* (exploring vs. writing code) and *how much of the
//! spend is going into failed calls*. Both are answerable from the logs without
//! reading a single byte of content — tool **names**, terminal **statuses** and
//! **line counts** are all this module extracts.
//!
//! Two deliberate shapes here, both learned from the real logs:
//!
//! - `ToolTally::measured` is a separate denominator from the tool counts.
//!   Claude flags every `tool_result` with `is_error`, and Grok gives every tool
//!   call a terminal status, but **Codex reports no general error flag** — only
//!   `patch_apply_end.success`. Dividing errors by all tool calls would quietly
//!   report Codex as error-free. The error rate is `errors / measured`, and
//!   `measured` only counts calls whose outcome was actually observable.
//!
//! - `files_changed` counts file-change *operations*, not distinct files. The
//!   server sums buckets, and a distinct-file count is not summable — two hours
//!   that each touched the same three files are not six files, but any sum would
//!   say so. An operation count stays true under addition.

use serde::{Deserialize, Serialize};

/// Which bucket a tool call falls into. Provider tool names are normalised into
/// this fixed taxonomy so one chart can span Claude, Codex and Grok.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    Bash,
    Edit,
    Read,
    Search,
    Web,
    Agent,
    Mcp,
    Other,
}

/// Per-event tool activity. Every field is a plain counter.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolTally {
    pub bash: i64,
    pub edit: i64,
    pub read: i64,
    pub search: i64,
    pub web: i64,
    pub agent: i64,
    pub mcp: i64,
    pub other: i64,
    /// Tool calls that failed, among those whose outcome was observable.
    pub errors: i64,
    /// Tool calls whose success/failure the log actually reports. The honest
    /// denominator for the error rate — see the module note.
    pub measured: i64,
    /// File-change operations (an edit, a write, one file in a patch).
    pub files_changed: i64,
    pub lines_added: i64,
    pub lines_removed: i64,
}

impl ToolTally {
    pub fn add(&mut self, other: &ToolTally) {
        self.bash += other.bash;
        self.edit += other.edit;
        self.read += other.read;
        self.search += other.search;
        self.web += other.web;
        self.agent += other.agent;
        self.mcp += other.mcp;
        self.other += other.other;
        self.errors += other.errors;
        self.measured += other.measured;
        self.files_changed += other.files_changed;
        self.lines_added += other.lines_added;
        self.lines_removed += other.lines_removed;
    }

    /// Total classified tool calls (excludes the error/line counters).
    pub fn calls(&self) -> i64 {
        self.bash + self.edit + self.read + self.search + self.web + self.agent + self.mcp + self.other
    }

    pub fn count(&mut self, kind: ToolKind) {
        match kind {
            ToolKind::Bash => self.bash += 1,
            ToolKind::Edit => self.edit += 1,
            ToolKind::Read => self.read += 1,
            ToolKind::Search => self.search += 1,
            ToolKind::Web => self.web += 1,
            ToolKind::Agent => self.agent += 1,
            ToolKind::Mcp => self.mcp += 1,
            ToolKind::Other => self.other += 1,
        }
    }

    pub fn is_empty(&self) -> bool {
        *self == ToolTally::default()
    }
}

/// Maps a provider's tool name onto the shared taxonomy.
///
/// Names come from three different vocabularies: Claude's `Bash`/`Edit`/`Read`,
/// Codex's `exec_command`/`apply_patch`, and Grok's `run_terminal_command`/
/// `search_replace`. Unknown names land in `Other` rather than being dropped, so
/// the kind columns always re-sum to the tool-call total.
pub fn classify(name: &str) -> ToolKind {
    let n = name.trim();
    if n.starts_with("mcp__") {
        return ToolKind::Mcp;
    }
    // Compared case-insensitively: Claude capitalises, the others do not.
    let lower = n.to_ascii_lowercase();
    match lower.as_str() {
        "bash" | "bashoutput" | "killshell" | "exec" | "exec_command" | "local_shell_call"
        | "shell" | "run_terminal_command" | "run_command" | "terminal" | "execute" => {
            ToolKind::Bash
        }

        "edit" | "write" | "multiedit" | "notebookedit" | "apply_patch" | "search_replace"
        | "str_replace" | "create_file" | "edit_file" | "write_file" => ToolKind::Edit,

        "read" | "read_file" | "view" | "view_file" | "notebookread" => ToolKind::Read,

        "grep" | "glob" | "list_dir" | "ls" | "find" | "search_tool" | "codebase_search"
        | "file_search" | "grep_search" => ToolKind::Search,

        "webfetch" | "websearch" | "web_fetch" | "web_search" | "browser" | "fetch" | "web" => {
            ToolKind::Web
        }

        "task" | "agent" | "spawn_agent" | "spawn_subagent" | "wait_agent" | "list_agents"
        | "interrupt_agent" | "send_message" | "followup_task" | "subagent" => ToolKind::Agent,

        _ => ToolKind::Other,
    }
}

/// Line count of a text block. Empty text is zero lines, not one — Rust's
/// `split('\n')` would otherwise credit every empty string with a line.
pub fn line_count(s: &str) -> i64 {
    if s.is_empty() {
        return 0;
    }
    s.lines().count() as i64
}

/// Added/removed line counts from a unified diff (Codex `patch_apply_end`).
///
/// `+++`/`---` file headers are excluded; only real content lines count.
pub fn unified_diff_lines(diff: &str) -> (i64, i64) {
    let mut added = 0;
    let mut removed = 0;
    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if let Some(first) = line.as_bytes().first() {
            match first {
                b'+' => added += 1,
                b'-' => removed += 1,
                _ => {}
            }
        }
    }
    (added, removed)
}

/// Line delta of an old→new string replacement (Claude `Edit`, Grok
/// `search_replace`).
pub fn replacement_lines(old: &str, new: &str) -> (i64, i64) {
    (line_count(new), line_count(old))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_all_three_provider_vocabularies() {
        // Claude
        assert_eq!(classify("Bash"), ToolKind::Bash);
        assert_eq!(classify("Edit"), ToolKind::Edit);
        assert_eq!(classify("Read"), ToolKind::Read);
        assert_eq!(classify("Grep"), ToolKind::Search);
        assert_eq!(classify("WebSearch"), ToolKind::Web);
        assert_eq!(classify("Task"), ToolKind::Agent);
        // Codex
        assert_eq!(classify("exec_command"), ToolKind::Bash);
        assert_eq!(classify("apply_patch"), ToolKind::Edit);
        assert_eq!(classify("spawn_agent"), ToolKind::Agent);
        // Grok
        assert_eq!(classify("run_terminal_command"), ToolKind::Bash);
        assert_eq!(classify("search_replace"), ToolKind::Edit);
        assert_eq!(classify("read_file"), ToolKind::Read);
        assert_eq!(classify("list_dir"), ToolKind::Search);
        assert_eq!(classify("spawn_subagent"), ToolKind::Agent);
    }

    #[test]
    fn mcp_tools_are_their_own_kind() {
        assert_eq!(classify("mcp__agmux-memory__memory_add"), ToolKind::Mcp);
        assert_eq!(classify("mcp__whatever"), ToolKind::Mcp);
    }

    #[test]
    fn unknown_names_fall_to_other_so_kinds_resum_to_the_total() {
        assert_eq!(classify("TodoWrite"), ToolKind::Other);
        assert_eq!(classify("update_plan"), ToolKind::Other);

        let mut t = ToolTally::default();
        for name in ["Bash", "Edit", "TodoWrite", "mcp__x__y", "Read"] {
            t.count(classify(name));
        }
        assert_eq!(t.calls(), 5, "every call lands in exactly one kind");
    }

    #[test]
    fn empty_text_counts_as_zero_lines() {
        assert_eq!(line_count(""), 0);
        assert_eq!(line_count("one"), 1);
        assert_eq!(line_count("one\ntwo"), 2);
        assert_eq!(line_count("trailing\n"), 1);
    }

    #[test]
    fn unified_diff_skips_file_headers() {
        let diff = "--- a/src/main.rs\n+++ b/src/main.rs\n@@ -1,3 +1,4 @@\n context\n-gone\n+added one\n+added two\n";
        assert_eq!(unified_diff_lines(diff), (2, 1));
    }

    #[test]
    fn replacement_counts_both_sides() {
        assert_eq!(replacement_lines("a\nb", "a\nb\nc"), (3, 2));
        // A pure insertion removes nothing.
        assert_eq!(replacement_lines("", "new line"), (1, 0));
    }

    #[test]
    fn add_sums_every_counter() {
        let mut a = ToolTally { bash: 1, edit: 2, errors: 1, measured: 3, lines_added: 10, ..Default::default() };
        let b = ToolTally { bash: 4, read: 1, errors: 2, measured: 5, lines_removed: 7, ..Default::default() };
        a.add(&b);
        assert_eq!(a.bash, 5);
        assert_eq!(a.edit, 2);
        assert_eq!(a.read, 1);
        assert_eq!(a.errors, 3);
        assert_eq!(a.measured, 8);
        assert_eq!(a.lines_added, 10);
        assert_eq!(a.lines_removed, 7);
    }
}
