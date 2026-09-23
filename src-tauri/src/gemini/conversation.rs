//! Read token usage out of Antigravity's on-disk conversation DB.
//!
//! `agy_acp_server` tracks `UsageMetadata` internally but returns
//! `PromptResponse { stopReason }` with no `usage` and never emits ACP
//! `usage_update`. The numbers still land in `conversations/{id}.db`
//! step metadata (protobuf). After a turn we read the latest generation
//! step so the chat context ring is not stuck at 0.

use super::install::profile_home;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConversationUsage {
    pub prompt_tokens: u64,
    pub output_tokens: u64,
    pub cache_tokens: u64,
    pub thought_tokens: u64,
    pub window_tokens: u64,
}

impl ConversationUsage {
    pub fn context_used(&self) -> u64 {
        self.prompt_tokens.saturating_add(self.cache_tokens)
    }
}

pub fn conversation_db_path(session_id: &str) -> PathBuf {
    profile_home()
        .join("antigravity-acp")
        .join("conversations")
        .join(format!("{session_id}.db"))
}

pub async fn latest_usage_from_db(path: &Path) -> Option<ConversationUsage> {
    if !path.is_file() {
        return None;
    }
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .ok()?;
    let rows: Vec<(Vec<u8>,)> = sqlx::query_as(
        "SELECT metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx DESC LIMIT 80",
    )
    .fetch_all(&pool)
    .await
    .ok()?;
    pool.close().await;
    rows.into_iter()
        .find_map(|(meta,)| usage_from_step_metadata(&meta))
}

/// Parse Antigravity step metadata protobuf.
///
/// Generation steps store usage at field 9:
///   2 = prompt tokens, 3 = candidate/output tokens,
///   5 = cached content, 9 = thought tokens.
/// Field 24 / 4 is the context window (1M on Gemini 3.x).
pub fn usage_from_step_metadata(meta: &[u8]) -> Option<ConversationUsage> {
    let fields = proto_fields(meta);
    let usage_bytes = fields.iter().find_map(|(n, payload)| {
        if *n == 9 {
            payload.as_bytes()
        } else {
            None
        }
    })?;
    let usage = proto_varints(usage_bytes);
    let prompt = *usage.get(&2).unwrap_or(&0);
    let output = *usage.get(&3).unwrap_or(&0);
    let cache = *usage.get(&5).unwrap_or(&0);
    let thought = *usage.get(&9).unwrap_or(&0);
    if prompt + output + cache + thought == 0 {
        return None;
    }
    let mut window = 1_000_000;
    if let Some(cfg) = fields.iter().find_map(|(n, payload)| {
        if *n == 24 {
            payload.as_bytes()
        } else {
            None
        }
    }) {
        let cfg_map = proto_varints(cfg);
        if let Some(w) = cfg_map.get(&4).copied().filter(|n| *n > 0) {
            window = w;
        }
    }
    Some(ConversationUsage {
        prompt_tokens: prompt,
        output_tokens: output,
        cache_tokens: cache,
        thought_tokens: thought,
        window_tokens: window,
    })
}

enum ProtoPayload {
    Varint(u64),
    Bytes(Vec<u8>),
}

impl ProtoPayload {
    fn as_bytes(&self) -> Option<&[u8]> {
        match self {
            ProtoPayload::Bytes(b) => Some(b),
            ProtoPayload::Varint(_) => None,
        }
    }
}

fn proto_fields(buf: &[u8]) -> Vec<(u32, ProtoPayload)> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < buf.len() {
        let (key, ni) = match decode_varint(buf, i) {
            Some(v) => v,
            None => break,
        };
        i = ni;
        let field = (key >> 3) as u32;
        let wire = (key & 7) as u32;
        if field == 0 {
            break;
        }
        match wire {
            0 => {
                let (val, ni) = match decode_varint(buf, i) {
                    Some(v) => v,
                    None => break,
                };
                i = ni;
                out.push((field, ProtoPayload::Varint(val)));
            }
            1 => {
                if i + 8 > buf.len() {
                    break;
                }
                i += 8;
            }
            2 => {
                let (len, ni) = match decode_varint(buf, i) {
                    Some(v) => v,
                    None => break,
                };
                i = ni;
                if len > (buf.len() - i) as u64 {
                    break;
                }
                let n = len as usize;
                out.push((field, ProtoPayload::Bytes(buf[i..i + n].to_vec())));
                i += n;
            }
            5 => {
                if i + 4 > buf.len() {
                    break;
                }
                i += 4;
            }
            _ => break,
        }
    }
    out
}

fn proto_varints(buf: &[u8]) -> BTreeMap<u32, u64> {
    let mut map = BTreeMap::new();
    for (field, payload) in proto_fields(buf) {
        if let ProtoPayload::Varint(v) = payload {
            map.insert(field, v);
        }
    }
    map
}

fn decode_varint(buf: &[u8], mut i: usize) -> Option<(u64, usize)> {
    let mut x: u64 = 0;
    let mut shift = 0;
    while i < buf.len() {
        let b = buf[i];
        i += 1;
        x |= u64::from(b & 0x7f) << shift;
        if b < 0x80 {
            return Some((x, i));
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// First generation step of a live Gemini chat (prompt 9406, output 176).
    const STEP1: &str = "0a0c08dbacedd40610c0e2a095021802320c08ddacedd40610f8f586af013a0c08ddacedd40610e0cdddc101420c08ddacedd40610e0cdddc1014a0a10be4918b001486e504258c602622463383466383466342d363132312d343938632d626239352d383931316631336134636334a2014e0a2463383466383466342d363132312d343938632d626239352d3839313166313361346363341001222463383466383466342d363132312d343938632d626239352d383931316631336134636334a80101c2012e20c0843d320da80101e201070a032a2f2a1001421567656d696e692d332e372d666c6173682d6869676868808004d201240a100808120c08ddacedd40610b8b487af010a100803120c08ddacedd40610c8d5ddc10182020c08ddacedd40610e0cdddc101";

    /// Later generation step with a large cache (prompt 9073, cache 89877).
    const STEP35: &str = "0a0c08abadedd40610d8bcfda3021802320c08adadedd40610a8d495a6033a0c08b0adedd40610d0a181ce01420c08b0adedd40610d0a181ce014a0f10f1461891032895be0548ca02504758c602622463383466383466342d363132312d343938632d626239352d383931316631336134636334a201500a2463383466383466342d363132312d343938632d626239352d38393131663133613463633410231810222463383466383466342d363132312d343938632d626239352d383931316631336134636334a80101c2012e20c0843d320da80101e201070a032a2f2a1001421567656d696e692d332e372d666c6173682d6869676868808004d201240a100808120c08adadedd40610c0c996a6030a100803120c08b0adedd40610b8a981ce0182020c08b0adedd40610d0a181ce01";

    fn decode_hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn first_generation_step_has_prompt_and_1m_window() {
        let u = usage_from_step_metadata(&decode_hex(STEP1)).expect("usage");
        assert_eq!(u.prompt_tokens, 9406);
        assert_eq!(u.output_tokens, 176);
        assert_eq!(u.cache_tokens, 0);
        assert_eq!(u.thought_tokens, 110);
        assert_eq!(u.window_tokens, 1_000_000);
        assert_eq!(u.context_used(), 9406);
    }

    #[test]
    fn later_generation_step_adds_cache_to_context() {
        let u = usage_from_step_metadata(&decode_hex(STEP35)).expect("usage");
        assert_eq!(u.prompt_tokens, 9073);
        assert_eq!(u.output_tokens, 401);
        assert_eq!(u.cache_tokens, 89877);
        assert_eq!(u.thought_tokens, 330);
        assert_eq!(u.window_tokens, 1_000_000);
        assert_eq!(u.context_used(), 9073 + 89877);
    }

    #[test]
    fn empty_metadata_is_none() {
        assert!(usage_from_step_metadata(&[]).is_none());
        assert!(usage_from_step_metadata(&[0x12, 0x03, b'a', b'b', b'c']).is_none());
    }

    #[test]
    fn malformed_metadata_lengths_do_not_panic() {
        // A length-delimited usage field claiming u64::MAX bytes.
        let mut oversized = vec![0x4a];
        oversized.extend([0xff; 9]);
        oversized.push(1);
        assert!(usage_from_step_metadata(&oversized).is_none());
        assert!(usage_from_step_metadata(&[0x4a, 10, 0x10, 1]).is_none());
    }
}
