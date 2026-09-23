//! Summary upgrades for read-only provider history, without requiring a DB thread.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone)]
struct CachedSummary {
    evidence: String,
    title: Option<String>,
    summary: String,
}

fn cache() -> &'static Mutex<HashMap<String, CachedSummary>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedSummary>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}
static SUMMARIZING: AtomicBool = AtomicBool::new(false);

/// Always show an evidence-based blurb, even without a downloaded local model.
pub fn reply_summary(reply: &str) -> Option<String> {
    let plain = reply.lines()
        .filter(|line| !line.trim_start().starts_with("```"))
        .map(|line| line.trim().trim_start_matches('#').trim())
        .collect::<Vec<_>>().join(" ").replace("**", "").replace('`', "");
    normalize_work_summary(&plain)
}

/// Reuse Grok's local title/work summarizer. One background job globally keeps
/// repeated history polls from flooding the model. Later polls pick up upgrades.
pub fn upgrade_summaries(app: &AppHandle, turns: &mut [ThreadTurn]) {
    let mut candidate = None;
    if let Ok(cached) = cache().lock() {
        for turn in turns.iter_mut() {
            if turn.status == "running" { continue; }
            let evidence = turn.summary.clone().unwrap_or_default();
            if evidence.is_empty() { continue; }
            if let Some(entry) = cached.get(&turn.id).filter(|c| c.evidence == evidence) {
                turn.prompt_summary = entry.title.clone().or_else(|| turn.prompt_summary.clone());
                turn.summary = Some(entry.summary.clone());
                turn.summary_source = "llm".into();
            } else if candidate.is_none() && turn.summary_source != "llm" {
                candidate = Some((turn.clone(), evidence));
            }
        }
    }
    let Some((turn, evidence)) = candidate else { return };
    if SUMMARIZING.swap(true, Ordering::AcqRel) { return; }
    let app = app.clone();
    tokio::spawn(async move {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) { SUMMARIZING.store(false, Ordering::Release); }
        }
        let _reset = Reset;
        let Some(port) = resolve_local_port(Some(&app), None).await else { return };
        let title = try_llm_prompt_title(port, &turn.prompt_text).await;
        let Some(summary) = try_llm_work_summary(port, &turn.prompt_text, &turn.facts_json, &evidence, &evidence).await else { return };
        if let Ok(mut cached) = cache().lock() {
            if cached.len() >= 2000 { cached.clear(); }
            cached.insert(turn.id, CachedSummary { evidence, title, summary });
        }
    });
}
