/// Return a prefix within a byte budget, preserving UTF-8 boundaries.
pub(crate) fn byte_prefix(text: &str, max_bytes: usize) -> &str {
    let mut end = text.len().min(max_bytes);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_prefix_preserves_unicode_boundaries() {
        for text in ["界".repeat(80), format!("{}😀tail", "a".repeat(199))] {
            for cap in 0..=text.len() + 1 {
                let prefix = byte_prefix(&text, cap);
                assert!(prefix.len() <= cap);
                assert!(text.starts_with(prefix));
                assert!(prefix.len() == text.len()
                    || prefix.len() + text[prefix.len()..].chars().next().unwrap().len_utf8() > cap);
            }
        }
        assert_eq!(byte_prefix("short", 200), "short");
        assert_eq!(byte_prefix(&"a".repeat(250), 200).len(), 200);
    }
}
