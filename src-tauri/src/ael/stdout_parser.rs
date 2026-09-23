use regex::Regex;
use serde::{Deserialize, Serialize};

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalProposal {
    pub kind: String,
    pub title: String,
    pub content: String,
    pub confidence: f32,
}

#[allow(dead_code)]
pub struct StdoutParser {
    buffer: String,
}

#[allow(dead_code)]
impl StdoutParser {
    pub fn new() -> Self {
        Self {
            buffer: String::new(),
        }
    }

    /// Accumulate text into the parser buffer.
    pub fn feed(&mut self, text: &str) {
        self.buffer.push_str(text);
    }

    /// Clear the buffer.
    pub fn clear(&mut self) {
        self.buffer.clear();
    }

    /// Get the current buffer contents.
    pub fn buffer(&self) -> &str {
        &self.buffer
    }
}

/// Parse a block of text for potential journal entry proposals.
#[allow(dead_code)]
pub fn parse_for_proposals(text: &str) -> Vec<JournalProposal> {
    let mut proposals = Vec::new();

    // Decision signals
    let decision_patterns = [
        (r"(?i)I'll use\s+(.+?)(?:\.|$)", 0.7_f32),
        (r"(?i)I've decided\s+(?:to\s+)?(.+?)(?:\.|$)", 0.8),
        (r"(?i)going with\s+(.+?)(?:\.|$)", 0.7),
        (r"(?i)choosing\s+(.+?)\s+over\s+(.+?)(?:\.|$)", 0.85),
    ];

    for (pattern, confidence) in &decision_patterns {
        if let Ok(re) = Regex::new(pattern) {
            for cap in re.captures_iter(text) {
                let full_match = cap.get(0).map_or("", |m| m.as_str()).trim();
                let detail = cap.get(1).map_or("", |m| m.as_str()).trim();

                if !detail.is_empty() && detail.len() > 3 {
                    proposals.push(JournalProposal {
                        kind: "Decision".to_string(),
                        title: truncate(detail, 80),
                        content: full_match.to_string(),
                        confidence: *confidence,
                    });
                }
            }
        }
    }

    // Completion signals: "Done/Implemented/Added/Fixed/Created" + optional file path
    let completion_patterns = [(
        r"(?i)(Done|Implemented|Added|Fixed|Created|Updated)\s+(.+?)(?:\.|$)",
        0.65_f32,
    )];

    for (pattern, confidence) in &completion_patterns {
        if let Ok(re) = Regex::new(pattern) {
            for cap in re.captures_iter(text) {
                let action = cap.get(1).map_or("", |m| m.as_str()).trim();
                let detail = cap.get(2).map_or("", |m| m.as_str()).trim();

                if !detail.is_empty() && detail.len() > 3 {
                    // Check if detail contains a file path for higher confidence
                    let has_path = Regex::new(r"[a-zA-Z0-9_\-]+(/[a-zA-Z0-9_\-]+)+(\.\w+)?")
                        .map(|re| re.is_match(detail))
                        .unwrap_or(false);

                    let adjusted_confidence = if has_path {
                        (confidence + 0.15).min(1.0)
                    } else {
                        *confidence
                    };

                    proposals.push(JournalProposal {
                        kind: "CompletedWork".to_string(),
                        title: format!("{} {}", action, truncate(detail, 70)),
                        content: cap.get(0).map_or("", |m| m.as_str()).trim().to_string(),
                        confidence: adjusted_confidence,
                    });
                }
            }
        }
    }

    proposals
}

#[allow(dead_code)]
fn truncate(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}...", &s[..max_len - 3])
    }
}

impl Default for StdoutParser {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_buffer_starts_empty() {
        let p = StdoutParser::new();
        assert_eq!(p.buffer(), "");
    }

    #[test]
    fn parser_feed_accumulates() {
        let mut p = StdoutParser::new();
        p.feed("hello ");
        p.feed("world");
        assert_eq!(p.buffer(), "hello world");
    }

    #[test]
    fn parser_clear_resets_buffer() {
        let mut p = StdoutParser::new();
        p.feed("garbage");
        p.clear();
        assert_eq!(p.buffer(), "");
    }

    #[test]
    fn parser_default_equals_new() {
        let a = StdoutParser::default();
        let b = StdoutParser::new();
        assert_eq!(a.buffer(), b.buffer());
    }

    #[test]
    fn truncate_short_string_unchanged() {
        assert_eq!(truncate("hi", 80), "hi");
    }

    #[test]
    fn truncate_long_string_appends_ellipsis() {
        let s = "a".repeat(100);
        let out = truncate(&s, 20);
        assert_eq!(out.len(), 20);
        assert!(out.ends_with("..."));
    }

    #[test]
    fn parse_for_proposals_detects_decision_keyword() {
        let proposals = parse_for_proposals("I'll use TypeScript for the new module.");
        let kinds: Vec<&str> = proposals.iter().map(|p| p.kind.as_str()).collect();
        assert!(kinds.contains(&"Decision"), "expected Decision proposal: {:?}", proposals);
    }

    #[test]
    fn parse_for_proposals_detects_completion_keyword() {
        let proposals = parse_for_proposals("Implemented user login flow.");
        let kinds: Vec<&str> = proposals.iter().map(|p| p.kind.as_str()).collect();
        assert!(kinds.contains(&"CompletedWork"), "expected CompletedWork: {:?}", proposals);
    }

    #[test]
    fn parse_for_proposals_boosts_confidence_when_path_present() {
        let with_path = parse_for_proposals("Fixed src/components/foo.tsx for the bug.");
        let without_path = parse_for_proposals("Fixed the bug we discussed.");
        let with_max = with_path
            .iter()
            .filter(|p| p.kind == "CompletedWork")
            .map(|p| p.confidence)
            .fold(0.0_f32, f32::max);
        let without_max = without_path
            .iter()
            .filter(|p| p.kind == "CompletedWork")
            .map(|p| p.confidence)
            .fold(0.0_f32, f32::max);
        assert!(
            with_max > without_max,
            "with-path confidence {} should exceed without-path {}",
            with_max,
            without_max
        );
    }

    #[test]
    fn parse_for_proposals_returns_empty_for_neutral_text() {
        let proposals = parse_for_proposals("The weather is nice today.");
        assert!(proposals.is_empty());
    }

    #[test]
    fn parse_for_proposals_skips_too_short_detail() {
        // "I'll use X." has only 1 char of detail, below the 3-char floor.
        let proposals = parse_for_proposals("I'll use X.");
        assert!(proposals.iter().all(|p| p.kind != "Decision"));
    }
}
