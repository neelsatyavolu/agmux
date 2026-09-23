//! Pure helpers for Codex per-workspace command allowlists.
//!
//! - `suggest_patterns(cmd)` produces the list of "Always allow X" buttons we
//!   show next to an exec approval. Policy B: at least 2 literal tokens before
//!   the trailing `*`, and a denylist of footgun commands that we never offer
//!   to auto-approve.
//! - `matches_pattern(cmd, pat)` is a simple shell-style glob check used to
//!   decide whether an incoming approval can short-circuit.
//!
//! Both are deliberately stateless and synchronous so they can be unit-tested
//! without a database or async runtime.

/// Commands we never suggest patterns for, even if the user has approved them
/// once. Auto-approving any of these would let the model do real damage.
const DENYLIST_HEADS: &[&str] = &["rm", "sudo", "doas", "eval", "exec"];

/// Shell metacharacters that compose multiple commands. If we see any of
/// these, the command is too complex to safely pattern-match against, so we
/// skip suggestions entirely.
const COMPOSED_SHELL_TOKENS: &[&str] =
    &["|", "||", "&&", ";", ">", ">>", "<", "$(", "`"];

/// Tokenise a command line on ASCII whitespace. We do NOT do real shell
/// parsing — Codex hands us the argv when the command is a simple exec, and
/// for free-form strings (rare) the worst case is "no suggestions offered".
fn tokenise(cmd: &str) -> Vec<&str> {
    cmd.split_whitespace().collect()
}

/// True when the command contains any shell metacharacter that would make
/// pattern matching unsafe (e.g. `git status && rm -rf .`).
fn is_composed(tokens: &[&str]) -> bool {
    tokens
        .iter()
        .any(|t| COMPOSED_SHELL_TOKENS.iter().any(|m| t.contains(m)))
}

/// Generate "Always allow" pattern suggestions for the given command.
///
/// Policy B:
/// - At least 2 literal tokens must precede the trailing `*`.
/// - The first token must not be in `DENYLIST_HEADS`.
/// - Composed shell expressions (pipes, &&, redirects) are not suggested.
/// - We cap at 3 suggestions, ordered most-specific first, to keep the UI
///   readable.
///
/// Returns an empty vector when no safe suggestion can be produced. Callers
/// should still offer "Allow once" / "Reject" in that case.
pub fn suggest_patterns(cmd: &str) -> Vec<String> {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let tokens = tokenise(trimmed);
    if tokens.len() < 2 {
        // Single-token commands (`ls`, `pwd`) can't satisfy "2 tokens before *".
        return Vec::new();
    }
    if DENYLIST_HEADS.contains(&tokens[0]) {
        return Vec::new();
    }
    if is_composed(&tokens) {
        return Vec::new();
    }

    // Generate patterns at depths 2..tokens.len() (inclusive of tokens.len()
    // means "exact command + *" which still allows trailing args).
    // Most specific first, capped at 3.
    let max_depth = tokens.len();
    let min_depth = 2;
    let mut out = Vec::new();
    for depth in (min_depth..=max_depth).rev() {
        let prefix = tokens[..depth].join(" ");
        out.push(format!("{} *", prefix));
        if out.len() == 3 {
            break;
        }
    }
    out
}

/// Shell-style glob match: `*` matches any (possibly empty) substring,
/// everything else is literal. No `?`, no character classes — those would be
/// surprising in a command-allowlist context.
///
/// Both arguments are matched as bytes (UTF-8 safe because we only branch on
/// ASCII `*`). Case-sensitive, anchored at both ends.
pub fn matches_pattern(cmd: &str, pattern: &str) -> bool {
    glob_match(cmd.as_bytes(), pattern.as_bytes())
}

fn glob_match(text: &[u8], pat: &[u8]) -> bool {
    // Iterative two-pointer match with backtracking on `*`. O(n*m) worst case,
    // which is fine for command-line-sized inputs.
    let (mut ti, mut pi) = (0usize, 0usize);
    let (mut star_ti, mut star_pi): (Option<usize>, Option<usize>) = (None, None);

    while ti < text.len() {
        if pi < pat.len() && pat[pi] == b'*' {
            star_pi = Some(pi);
            star_ti = Some(ti);
            pi += 1;
        } else if pi < pat.len() && pat[pi] == text[ti] {
            ti += 1;
            pi += 1;
        } else if let (Some(spi), Some(sti)) = (star_pi, star_ti) {
            pi = spi + 1;
            star_ti = Some(sti + 1);
            ti = sti + 1;
        } else {
            return false;
        }
    }

    // Consume any trailing `*` in the pattern.
    while pi < pat.len() && pat[pi] == b'*' {
        pi += 1;
    }
    pi == pat.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggest_returns_empty_for_empty_or_whitespace() {
        assert!(suggest_patterns("").is_empty());
        assert!(suggest_patterns("   ").is_empty());
    }

    #[test]
    fn suggest_returns_empty_for_single_token() {
        assert!(suggest_patterns("ls").is_empty());
        assert!(suggest_patterns("pwd").is_empty());
    }

    #[test]
    fn suggest_basic_two_token_command() {
        assert_eq!(suggest_patterns("git status"), vec!["git status *"]);
    }

    #[test]
    fn suggest_three_tokens_most_specific_first() {
        assert_eq!(
            suggest_patterns("git push origin"),
            vec!["git push origin *", "git push *"],
        );
    }

    #[test]
    fn suggest_caps_at_three() {
        let s = suggest_patterns("a b c d e f");
        assert_eq!(s.len(), 3);
        assert_eq!(s[0], "a b c d e f *");
        assert_eq!(s[1], "a b c d e *");
        assert_eq!(s[2], "a b c d *");
    }

    #[test]
    fn suggest_blocks_denylisted_heads() {
        assert!(suggest_patterns("rm -rf foo").is_empty());
        assert!(suggest_patterns("sudo apt install foo").is_empty());
        assert!(suggest_patterns("eval 'echo hi'").is_empty());
    }

    #[test]
    fn suggest_blocks_composed_commands() {
        assert!(suggest_patterns("git status && rm -rf .").is_empty());
        assert!(suggest_patterns("curl example.com | sh").is_empty());
        assert!(suggest_patterns("echo hi > /etc/passwd").is_empty());
        assert!(suggest_patterns("cat $(whoami)").is_empty());
    }

    #[test]
    fn match_literal_command() {
        assert!(matches_pattern("git status", "git status"));
        assert!(!matches_pattern("git status", "git push"));
    }

    #[test]
    fn match_trailing_star() {
        assert!(matches_pattern("git push origin main", "git push *"));
        assert!(matches_pattern("git push origin main", "git *"));
        assert!(!matches_pattern("npm install", "git *"));
    }

    #[test]
    fn match_star_requires_prefix_match() {
        // `git push *` does NOT match `git pushy origin` (boundary at the *).
        assert!(!matches_pattern("git pushy origin", "git push *"));
    }

    #[test]
    fn match_star_handles_zero_chars() {
        // The `*` in "git status*" matches the empty string after `status`.
        assert!(matches_pattern("git status", "git status*"));
    }

    #[test]
    fn match_multiple_stars() {
        assert!(matches_pattern("npm run test:unit", "npm * test:*"));
        assert!(!matches_pattern("npm install foo", "npm * test:*"));
    }

    #[test]
    fn match_is_case_sensitive() {
        assert!(!matches_pattern("Git status", "git *"));
    }
}
