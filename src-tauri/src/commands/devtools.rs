//! Hardware-gated devtools toggle for release builds.
//!
//! Enables the browser inspector (Cmd+Opt+Shift+I) in production, but only on
//! authorized Macs. Gate check compares SHA-256 of the machine's
//! `IOPlatformUUID` (read via `ioreg`) against an embedded hash so the raw UUID
//! never ships in the binary. Any other machine silently returns an error.
//!
//! Tauri's built-in ungated hotkey (Cmd+Opt+I → `internal_toggle_devtools`) is
//! denied in `capabilities/default.json`. Do not re-allow that permission.

use sha2::{Digest, Sha256};
use std::process::Command;
use std::sync::OnceLock;
use tauri::WebviewWindow;

/// SHA-256 hex digests of authorized macOS `IOPlatformUUID` values.
/// Adding a device requires a rebuild.
const AUTHORIZED_UUID_HASHES: &[&str] = &[
    "bdc307ae00d9f551001795abab7560a62e0a678507514aa246392dfb8a0707ce",
    "5d443a81ff7c7acf39f72fb92818ffeb56c6a1bab52913707ed103c7c9de84ce",
];

/// Cached authorization result — `ioreg` is invoked at most once per process.
static AUTHORIZED: OnceLock<bool> = OnceLock::new();

/// Reads `IOPlatformUUID` from `ioreg -rd1 -c IOPlatformExpertDevice`.
/// Returns `None` if `ioreg` fails or the key is absent (non-macOS, sandboxed, etc.).
fn read_platform_uuid() -> Option<String> {
    let output = Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("\"IOPlatformUUID\" = \"") {
            if let Some(end) = rest.find('"') {
                return Some(rest[..end].to_string());
            }
        }
    }
    None
}

/// Decodes a lowercase hex string into bytes. Returns `None` on any parse error.
fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// Constant-time byte comparison to resist trivial timing side-channels.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Checks whether the current machine is allowed to open devtools.
/// Result is cached after first call.
fn is_authorized() -> bool {
    *AUTHORIZED.get_or_init(|| {
        let Some(uuid) = read_platform_uuid() else {
            return false;
        };
        let hash = Sha256::digest(uuid.as_bytes());
        AUTHORIZED_UUID_HASHES.iter().any(|hex| {
            hex_decode(hex)
                .map(|expected| ct_eq(hash.as_slice(), &expected))
                .unwrap_or(false)
        })
    })
}

/// Toggles the devtools inspector for the given window.
/// Returns the new open state (`true` = opened, `false` = closed).
/// Returns `Err` on unauthorized machines with a generic message.
#[tauri::command]
pub async fn toggle_devtools(window: WebviewWindow) -> Result<bool, String> {
    if !is_authorized() {
        return Err("unavailable".to_string());
    }
    if window.is_devtools_open() {
        window.close_devtools();
        Ok(false)
    } else {
        window.open_devtools();
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_decode_roundtrip() {
        let bytes = hex_decode("deadbeef").unwrap();
        assert_eq!(bytes, vec![0xde, 0xad, 0xbe, 0xef]);
    }

    #[test]
    fn hex_decode_rejects_odd_length() {
        assert!(hex_decode("abc").is_none());
    }

    #[test]
    fn hex_decode_rejects_non_hex() {
        assert!(hex_decode("zz").is_none());
    }

    #[test]
    fn ct_eq_matches_equality_semantics() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"abcd"));
    }

    #[test]
    fn authorized_hashes_are_valid_hex() {
        for hash in AUTHORIZED_UUID_HASHES {
            let decoded = hex_decode(hash)
                .expect("embedded authorized UUID hash must be valid hex");
            assert_eq!(decoded.len(), 32, "SHA-256 must be 32 bytes");
        }
    }

    #[test]
    fn authorized_hashes_are_distinct() {
        let mut seen = std::collections::HashSet::new();
        for hash in AUTHORIZED_UUID_HASHES {
            assert!(seen.insert(*hash), "duplicate hash in AUTHORIZED_UUID_HASHES: {hash}");
        }
    }

    #[test]
    fn ct_eq_empty_slices_are_equal() {
        assert!(ct_eq(b"", b""));
    }

    #[test]
    fn ct_eq_different_lengths_not_equal() {
        assert!(!ct_eq(b"ab", b"a"));
        assert!(!ct_eq(b"", b"a"));
    }

    #[test]
    fn hex_decode_empty_string_returns_empty_vec() {
        let result = hex_decode("");
        assert_eq!(result, Some(vec![]));
    }

    #[test]
    fn hex_decode_uppercase_fails() {
        // from_str_radix with base 16 accepts uppercase, but let's verify behaviour
        // of our function with uppercase hex (it should parse fine since Rust's
        // from_str_radix is case-insensitive for hex digits).
        let result = hex_decode("DEADBEEF");
        assert!(result.is_some(), "uppercase hex should parse");
        assert_eq!(result.unwrap(), vec![0xde, 0xad, 0xbe, 0xef]);
    }

    #[test]
    fn is_authorized_returns_bool_without_panic() {
        // This machine is almost certainly not in the authorized list, so
        // we only assert that calling it does not panic.  The cached OnceLock
        // means subsequent calls in the same process return the same result.
        let result = std::panic::catch_unwind(is_authorized);
        assert!(result.is_ok(), "is_authorized must not panic");
    }
}
