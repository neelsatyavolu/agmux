//! Discover Claude Code picker slugs from the installed `claude` CLI binary.
//!
//! Claude Code does not expose a `models` subcommand. The `/model` catalog is
//! compiled into the native binary as C strings, so we scan for
//! `claude-{family}-{version}` ids (optional `[1m]` / `[2m]` tier). Results are
//! cached by path + mtime + size so the 200MB+ binary is only read when it changes.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

const PREFIX: &[u8] = b"claude-";
const FAMILIES: &[&[u8]] = &[
    b"fable-",
    b"mythos-",
    b"opus-",
    b"sonnet-",
    b"haiku-",
];

struct CatalogCache {
    path: PathBuf,
    modified: SystemTime,
    len: u64,
    slugs: Vec<String>,
}

static CACHE: Mutex<Option<CatalogCache>> = Mutex::new(None);

fn is_left_boundary(b: u8) -> bool {
    !b.is_ascii_alphanumeric() && b != b'_' && b != b'.'
}

fn is_version_byte(b: u8) -> bool {
    b.is_ascii_digit() || b == b'.' || b == b'-'
}

/// Scan `hay` for Claude Code model ids. Public for unit tests.
pub fn extract_claude_model_slugs(hay: &[u8]) -> Vec<String> {
    let mut i = 0;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    while i + PREFIX.len() < hay.len() {
        if hay[i] != b'c' {
            i += 1;
            continue;
        }
        if !hay[i..].starts_with(PREFIX) {
            i += 1;
            continue;
        }
        if i > 0 && !is_left_boundary(hay[i - 1]) {
            i += 1;
            continue;
        }
        if let Some(end) = slug_end(hay, i) {
            if let Ok(s) = std::str::from_utf8(&hay[i..end]) {
                if seen.insert(s.to_string()) {
                    out.push(s.to_string());
                }
            }
            i = end;
            continue;
        }
        i += 1;
    }
    out
}

fn slug_end(hay: &[u8], start: usize) -> Option<usize> {
    let mut p = start + PREFIX.len();
    let rest = hay.get(p..)?;
    let family = FAMILIES.iter().copied().find(|f| rest.starts_with(f))?;
    p += family.len();
    if p >= hay.len() || !hay[p].is_ascii_digit() {
        return None;
    }
    while p < hay.len() && is_version_byte(hay[p]) {
        p += 1;
    }
    // Optional context-tier suffix: [1m], [2m], [400k], …
    if p < hay.len() && hay[p] == b'[' {
        let mut q = p + 1;
        while q < hay.len() && hay[q] != b']' {
            if !hay[q].is_ascii_alphanumeric() {
                break;
            }
            q += 1;
        }
        if q < hay.len() && hay[q] == b']' {
            p = q + 1;
        }
    }
    if p < hay.len() && (hay[p].is_ascii_alphanumeric() || hay[p] == b'_' || hay[p] == b'.') {
        return None;
    }
    Some(p)
}

/// Read the CLI at `path` (cached by mtime/size) and return discovered slugs.
pub fn list_claude_model_slugs_from_path(path: &Path) -> Vec<String> {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };
    let len = meta.len();
    let modified = meta.modified().ok();
    if let (Ok(guard), Some(modified)) = (CACHE.lock(), modified) {
        if let Some(cache) = guard.as_ref() {
            if cache.path == path && cache.len == len && cache.modified == modified {
                return cache.slugs.clone();
            }
        }
    }
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let slugs = extract_claude_model_slugs(&bytes);
    if let (Ok(mut guard), Some(modified)) = (CACHE.lock(), modified) {
        *guard = Some(CatalogCache {
            path: path.to_path_buf(),
            modified,
            len,
            slugs: slugs.clone(),
        });
    }
    slugs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_full_ids_and_1m_tiers() {
        let hay = b"\0claude-fable-5\0claude-opus-5[1m]\0claude-sonnet-4-6\0claude-haiku-4-5\0";
        let slugs = extract_claude_model_slugs(hay);
        assert_eq!(
            slugs,
            vec![
                "claude-fable-5",
                "claude-opus-5[1m]",
                "claude-sonnet-4-6",
                "claude-haiku-4-5",
            ]
        );
    }

    #[test]
    fn skips_bedrock_prefixed_ids() {
        let hay = b"us.anthropic.claude-sonnet-5\0anthropic.claude-opus-5\0claude-sonnet-5\0";
        let slugs = extract_claude_model_slugs(hay);
        assert_eq!(slugs, vec!["claude-sonnet-5"]);
    }

    #[test]
    fn skips_incomplete_family_prefix() {
        let hay = b"claude-opus-\0claude-\0claude-sonnet\0";
        assert!(extract_claude_model_slugs(hay).is_empty());
    }

    #[test]
    fn dedupes_repeated_slugs() {
        let hay = b"claude-opus-5\0xxxclaude-opus-5\0claude-opus-5\0";
        // `xxxclaude-opus-5` is rejected by left boundary; two bare copies collapse.
        assert_eq!(extract_claude_model_slugs(hay), vec!["claude-opus-5"]);
    }
}
