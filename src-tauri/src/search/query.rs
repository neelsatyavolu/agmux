//! FTS5 query path for session / message search.

use crate::db::models::SearchResult;
use sqlx::SqlitePool;

/// Significant tokens (len >= 2), lowercased, FTS-safe.
///
/// Hyphens are separators, matching FTS5 `unicode61` tokenization. Keeping
/// `multi-prompt` intact would emit `multi-prompt*` which FTS5 parses as
/// `multi` NOT `prompt*` (unary `-`) — empty or wrong hits for common
/// product phrases like "multi-prompt titles".
fn search_tokens(query: &str) -> Vec<String> {
    query
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '.')
        .map(|t| t.trim().to_lowercase())
        .filter(|t| t.chars().count() >= 2)
        .collect()
}

/// Sanitize a bare FTS5 token (alphanumeric / _ / . only — already filtered).
/// Never emit `-`: FTS5 treats it as the NOT operator.
/// FTS5 prefix queries must be barewords (`auth*`), not quoted (`"auth"*`).
fn fts_bare_token(tok: &str) -> String {
    tok.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.'))
        .collect()
}

/// Build an FTS5 MATCH expression.
/// Multi-token → AND of prefix tokens so "auth bug" finds both words.
/// Single token → prefix match.
pub fn build_fts_match(query: &str) -> Option<String> {
    let q = query.trim();
    if q.is_empty() {
        return None;
    }
    // Phrase search when user wraps in quotes.
    if q.starts_with('"') && q.ends_with('"') && q.len() >= 3 {
        let inner = &q[1..q.len() - 1];
        // Same tokenizer as free-text: split hyphens so "multi-prompt titles"
        // matches the indexed tokens multi + prompt + titles.
        let cleaned: String = search_tokens(inner)
            .into_iter()
            .map(|t| fts_bare_token(&t))
            .filter(|t| t.len() >= 2)
            .collect::<Vec<_>>()
            .join(" ");
        if cleaned.is_empty() {
            return None;
        }
        return Some(format!("\"{cleaned}\""));
    }
    let tokens = search_tokens(q);
    if tokens.is_empty() {
        return None;
    }
    let parts: Vec<String> = tokens
        .iter()
        .map(|t| fts_bare_token(t))
        .filter(|t| t.len() >= 2)
        .map(|t| format!("{t}*"))
        .collect();
    if parts.is_empty() {
        return None;
    }
    Some(parts.join(" AND "))
}

#[derive(Debug, sqlx::FromRow)]
struct FtsHit {
    thread_id: String,
    #[allow(dead_code)]
    project_id: String,
    source: String,
    role: String,
    body: String,
    rank: f64,
}

/// Query the FTS index. Caller should `ensure_db_index` first.
pub async fn search_threads_fts(
    pool: &SqlitePool,
    query: &str,
    limit: i64,
) -> anyhow::Result<Vec<SearchResult>> {
    let Some(match_expr) = build_fts_match(query) else {
        return Ok(Vec::new());
    };

    // Over-fetch so we can dedupe by thread and keep best message hit.
    let fetch = (limit * 4).clamp(40, 200);

    // bm25() is lower-is-better (more negative / smaller = better).
    // Avoid table aliases with FTS5 MATCH/bm25 — some SQLite builds are picky.
    let hits = sqlx::query_as::<_, FtsHit>(
        "SELECT
            search_messages.thread_id AS thread_id,
            search_messages.project_id AS project_id,
            search_messages.source AS source,
            search_messages.role AS role,
            search_messages.body AS body,
            bm25(search_messages) AS rank
         FROM search_messages
         JOIN threads ON threads.id = search_messages.thread_id
         WHERE search_messages MATCH ?1
           AND threads.is_archived = 0
         ORDER BY rank
         LIMIT ?2",
    )
    .bind(&match_expr)
    .bind(fetch)
    .fetch_all(pool)
    .await;

    let hits = match hits {
        Ok(h) => h,
        Err(e) => {
            // Table missing mid-migration or empty MATCH — soft-fail.
            tracing::warn!("search fts query failed (match={match_expr}): {e}");
            return Ok(Vec::new());
        }
    };

    // Dedupe by thread_id, keep best rank (lowest bm25). Also capture best message hit.
    let mut best: std::collections::HashMap<String, (FtsHit, f64)> =
        std::collections::HashMap::new();
    for h in hits {
        let score = fts_relevance(&h);
        match best.get(&h.thread_id) {
            Some((_, existing)) if *existing >= score => {}
            _ => {
                best.insert(h.thread_id.clone(), (h, score));
            }
        }
    }

    // Load thread metadata for survivors.
    let mut results = Vec::with_capacity(best.len());
    for (thread_id, (hit, score)) in best {
        let meta = sqlx::query_as::<_, (String, String, String, String, String, String)>(
            "SELECT id, project_id, name, provider, work_dir, last_active
             FROM threads WHERE id = ?",
        )
        .bind(&thread_id)
        .fetch_optional(pool)
        .await?;

        let Some((_id, project_id, name, provider, work_dir, last_active)) = meta else {
            continue;
        };

        let matched_content = if hit.source == "name" {
            None
        } else {
            Some(format_snippet(&hit))
        };

        results.push(SearchResult {
            thread_id,
            project_id,
            thread_name: name,
            provider,
            work_dir,
            matched_content,
            relevance: score,
            last_active,
            match_role: if hit.source == "name" {
                None
            } else {
                Some(hit.role.clone())
            },
            match_source: Some(hit.source.clone()),
        });
    }

    results.sort_by(|a, b| {
        b.relevance
            .partial_cmp(&a.relevance)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.last_active.cmp(&a.last_active))
    });
    results.truncate(limit as usize);
    Ok(results)
}

/// Convert BM25 rank + role/source into a 0–100-ish relevance (higher = better).
fn fts_relevance(hit: &FtsHit) -> f64 {
    // bm25: more negative is better. Map to positive score.
    // Typical range roughly [-20, 0] for good hits.
    let base = 50.0 + (-hit.rank).clamp(0.0, 40.0);
    let role_boost = match hit.role.as_str() {
        "name" => 30.0,
        "user" => 12.0,
        "assistant" => 6.0,
        "meta" => 4.0,
        _ => 0.0,
    };
    let source_boost = match hit.source.as_str() {
        "name" => 20.0,
        "turn" => 8.0,
        "claude" | "codex" | "grok" => 10.0,
        "prompt" => 6.0,
        "journal" => 5.0,
        "agent_log" => 2.0,
        _ => 0.0,
    };
    (base + role_boost + source_boost).min(100.0)
}

fn format_snippet(hit: &FtsHit) -> String {
    let label = match (hit.role.as_str(), hit.source.as_str()) {
        ("user", _) => "You",
        ("assistant", "turn") => "Summary",
        ("assistant", _) => "Agent",
        ("meta", _) => "Journal",
        _ => "Match",
    };
    let body = snippet_trim(&hit.body, 140);
    format!("{label} · {body}")
}

fn snippet_trim(text: &str, max_chars: usize) -> String {
    let compact: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = compact.chars().count();
    if count <= max_chars {
        return compact;
    }
    compact.chars().take(max_chars).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_fts_match_and_prefix() {
        let m = build_fts_match("auth bug").unwrap();
        assert_eq!(m, "auth* AND bug*");
    }

    #[test]
    fn build_fts_match_phrase() {
        let m = build_fts_match("\"exact phrase\"").unwrap();
        assert_eq!(m, "\"exact phrase\"");
    }

    #[test]
    fn build_fts_match_empty() {
        assert!(build_fts_match("  ").is_none());
        assert!(build_fts_match("a").is_none()); // too short
    }

    #[test]
    fn build_fts_match_splits_hyphens() {
        // Regression: unary FTS5 "-" must never appear inside a bare token.
        let m = build_fts_match("multi-prompt titles").unwrap();
        assert_eq!(m, "multi* AND prompt* AND titles*");
        assert!(!m.contains('-'));
    }

    #[test]
    fn build_fts_match_phrase_splits_hyphens() {
        let m = build_fts_match("\"multi-prompt titles\"").unwrap();
        assert_eq!(m, "\"multi prompt titles\"");
    }
}
