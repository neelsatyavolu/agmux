//! Fast session / message search (SQLite FTS5 + BM25).
//!
//! Indexes real conversation text — thread names, turn prompts/summaries,
//! journals, prompts, filtered agent logs, and provider session files
//! (Claude JSONL, Codex rollouts, Grok chat_history) — not raw PTY dumps.

mod extract;
mod index;
mod query;

pub use index::{ensure_db_index, spawn_background_reindex};
#[cfg(test)]
pub use index::reindex_all;
pub use query::search_threads_fts;
