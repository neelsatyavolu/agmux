#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PtyUsageSnapshot {
    pub context_tokens_used: u64,
    pub context_window_tokens: u64,
    pub model: Option<String>,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub files_changed: i64,
}

#[allow(dead_code)]
pub fn count_newlines(s: &str) -> u64 {
    if s.is_empty() {
        return 0;
    }
    let n = s.bytes().filter(|b| *b == b'\n').count() as u64;
    if s.ends_with('\n') {
        n
    } else {
        n + 1
    }
}
