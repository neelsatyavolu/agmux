use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

const MAX_OWNERS: usize = 128;
const MAX_ENTRIES: usize = 1024;
const MAX_ID_BYTES: usize = 1024;

/// Completed calls and session IDs remain as tombstones until clear_owner.
/// Capacity exhaustion disables tracking instead of evicting safety evidence.
#[derive(Default)]
pub(super) struct Continuations {
    owners: BTreeMap<String, Owner>,
    disabled: bool,
}

#[derive(Default)]
struct Owner {
    calls: BTreeMap<String, Call>,
    sessions: BTreeMap<i64, Session>,
    disabled: bool,
}

#[derive(Default)]
struct Call {
    waits: Option<BTreeMap<usize, (i64, Option<String>)>>,
    seen: bool,
    blocked: bool,
    completed: bool,
    expected_results: Option<usize>,
}

struct Session {
    origin: String,
    done: bool,
    ambiguous: bool,
}

pub(super) struct Outcome {
    pub completed: Vec<String>,
    /// Current call owns live sessions (a linked wait does not acquire ownership).
    pub running: bool,
    /// Current call registered at least one unambiguous original-session wait.
    pub continued: bool,
}

impl Continuations {
    pub(super) fn expect_results(&mut self, owner: &str, call: &str, count: usize) {
        if let Some(state) = self.owner_call(owner, call) {
            let current = state.calls.get_mut(call).unwrap();
            if current.expected_results.is_some_and(|previous| previous != count) { current.blocked = true; }
            current.expected_results = Some(count);
        }
    }
    fn owner_call(&mut self, owner: &str, call: &str) -> Option<&mut Owner> {
        if self.disabled { return None; }
        if owner.len() > MAX_ID_BYTES || call.len() > MAX_ID_BYTES
            || (!self.owners.contains_key(owner) && self.owners.len() >= MAX_OWNERS) {
            self.owners.clear();
            self.disabled = true;
            return None;
        }
        let state = self.owners.entry(owner.to_string()).or_default();
        if state.disabled { return None; }
        if !state.calls.contains_key(call) && state.calls.len() >= MAX_ENTRIES {
            state.disable();
            return None;
        }
        state.calls.entry(call.to_string()).or_default();
        Some(state)
    }

    /// Ordinals count executor results only, excluding wrapper headers/metadata.
    /// Unknown or ambiguous sessions never grant an overlap exemption.
    pub(super) fn link_wait(&mut self, owner: &str, call: &str, waits: &[(i64, usize)]) -> Vec<String> {
        let Some(state) = self.owner_call(owner, call) else { return vec![]; };
        if waits.len() > MAX_ENTRIES {
            state.disable();
            return vec![];
        }
        let mut links = BTreeMap::new();
        for &(id, ordinal) in waits {
            let origin = state.sessions.get(&id)
                .filter(|s| !s.ambiguous && !s.done && s.origin != call)
                .filter(|s| !state.calls[&s.origin].blocked)
                .map(|s| s.origin.clone());
            if let Some((previous, _)) = links.insert(ordinal, (id, origin)) {
                if previous != id {
                    state.calls.get_mut(call).unwrap().blocked = true;
                    return vec![];
                }
            }
        }
        let current = state.calls.get_mut(call).unwrap();
        if current.seen || current.blocked { return vec![]; }
        if let Some(previous) = &current.waits {
            // Re-registering identical waits is safe even if a session has since finished.
            if previous.iter().map(|(n, (id, _))| (*n, *id)).collect::<Vec<_>>()
                != links.iter().map(|(n, (id, _))| (*n, *id)).collect::<Vec<_>>() {
                current.blocked = true;
                return vec![];
            }
        } else {
            current.waits = Some(links);
        }
        let origins: BTreeSet<_> = current.waits.as_ref().unwrap().values()
            .filter_map(|(_, origin)| origin.clone())
            .collect();
        origins.into_iter().filter(|origin| !state.calls[origin].blocked).collect()
    }

    pub(super) fn output(&mut self, owner: &str, call: &str, output: &Value) -> Outcome {
        let results = executor_results(output);
        let mut outcome = Outcome {
            completed: vec![],
            running: false,
            continued: false,
        };
        let Some(state) = self.owner_call(owner, call) else { return outcome; };
        if results.len() > MAX_ENTRIES {
            state.disable();
            return outcome;
        }
        let current = state.calls.get_mut(call).unwrap();
        if current.seen { return state.outcome(call); }
        current.seen = true;
        let waits = current.waits.clone().unwrap_or_default();
        // If an executor result is missing, later results must not slide into
        // its ordinal and falsely complete an unrelated waiting process.
        if !waits.is_empty() && current.expected_results.is_some_and(|count| count != results.len()) {
            current.blocked = true;
            return outcome;
        }
        // Register every yielded session before releasing any origins: a reused
        // ID later in the same wrapper must prevent an earlier wait completing it.
        for (ordinal, result) in results.iter().enumerate() {
            let Some(id) = result.session else { continue; };
            if let Some((expected, origin)) = waits.get(&ordinal) {
                if *expected != id {
                    state.calls.get_mut(call).unwrap().blocked = true;
                    if let Some(origin) = origin {
                        state.calls.get_mut(origin).unwrap().blocked = true;
                    }
                }
                // Even an unknown wait cannot establish ownership of a process.
                continue;
            }
            if let Some(session) = state.sessions.get_mut(&id) {
                if session.origin != call {
                    session.ambiguous = true;
                    state.calls.get_mut(&session.origin).unwrap().blocked = true;
                    state.calls.get_mut(call).unwrap().blocked = true;
                }
            } else {
                if state.sessions.len() >= MAX_ENTRIES {
                    state.disable();
                    return outcome;
                }
                state.sessions.insert(id, Session { origin: call.to_string(), done: false, ambiguous: false });
            }
        }
        outcome = state.outcome(call);
        if state.calls[call].blocked { return outcome; }
        let mut candidates = BTreeSet::new();
        for (ordinal, (id, origin)) in waits {
            let Some(origin) = origin else { continue; };
            let Some(result) = results.get(ordinal) else { continue; };
            if !result.terminal || result.session.is_some_and(|actual| actual != id) { continue; }
            let Some(session) = state.sessions.get_mut(&id) else { continue; };
            if session.ambiguous || session.origin != origin { continue; }
            session.done = true;
            candidates.insert(origin);
        }
        for origin in candidates {
            if state.sessions.values().any(|s| s.origin == origin && !s.done) { continue; }
            let original = state.calls.get_mut(&origin).unwrap();
            if !original.blocked && !original.completed {
                original.completed = true;
                outcome.completed.push(origin);
            }
        }
        outcome
    }

    pub(super) fn clear_owner(&mut self, owner: &str) {
        self.owners.remove(owner);
    }
}

impl Owner {
    fn outcome(&self, call: &str) -> Outcome {
        let current = &self.calls[call];
        Outcome {
            completed: vec![],
            running: self.sessions.values().any(|s| s.origin == call && !s.done),
            continued: !current.blocked && current.waits.as_ref().is_some_and(|waits| {
                waits.values().any(|(id, origin)| {
                    origin.as_ref().is_some_and(|origin| {
                        !self.calls[origin].blocked && self.sessions.get(id)
                            .is_some_and(|s| !s.ambiguous && s.origin == *origin)
                    })
                })
            }),
        }
    }

    fn disable(&mut self) {
        self.calls.clear();
        self.sessions.clear();
        self.disabled = true;
    }
}

struct ExecutorResult {
    session: Option<i64>,
    terminal: bool,
}

fn executor_result(value: &Value) -> Option<ExecutorResult> {
    if !value.get("wall_time_seconds")?.is_number() || !value.get("output")?.is_string() {
        return None;
    }
    let session = value.get("session_id").and_then(Value::as_i64);
    let terminal = value.get("exit_code").and_then(Value::as_i64).is_some();
    (session.is_some() || terminal).then_some(ExecutorResult { session, terminal })
}

fn parse_text(text: &str) -> Option<Value> {
    let text = text.trim();
    if let Ok(value) = serde_json::from_str(text) { return Some(value); }
    // Recognize the wrapper envelope only; never search arbitrary output text.
    let rest = text.strip_prefix("Script completed\n")?;
    let (_, json) = rest.split_once("\nOutput:\n")?;
    serde_json::from_str(json.trim()).ok()
}

fn executor_results(output: &Value) -> Vec<ExecutorResult> {
    let decoded;
    let output = if let Some(text) = output.as_str() {
        let Some(value) = parse_text(text) else { return vec![]; };
        decoded = value;
        &decoded
    } else { output };
    if let Some(blocks) = output.as_array() {
        blocks.iter().filter(|block| block.get("type").and_then(Value::as_str) == Some("input_text"))
            .filter_map(|block| parse_text(block.get("text")?.as_str()?))
            .filter_map(|value| executor_result(&value))
            .collect()
    } else {
        executor_result(output).into_iter().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn running(id: i64) -> Value {
        json!({"session_id":id,"exit_code":null,"output":"...","wall_time_seconds":1})
    }
    fn done() -> Value {
        json!({"exit_code":0,"output":"done","wall_time_seconds":0.1})
    }
    fn wrapper(results: Vec<Value>) -> Value {
        let mut blocks = vec![json!({"type":"input_text","text":"Script completed\nWall time 1s"})];
        blocks.extend(results.into_iter().map(|v| json!({"type":"input_text","text":v.to_string()})));
        Value::Array(blocks)
    }

    #[test]
    fn actual_mixed_wrapper_completes_origins_in_order() {
        let mut tracker = Continuations::default();
        assert!(tracker.output("owner", "initial", &running(79058)).running);
        assert_eq!(tracker.link_wait("owner", "mixed", &[(79058, 0)]), ["initial"]);
        let output = wrapper(vec![json!({"metadata":true}), done(), running(39172), done()]);
        let result = tracker.output("owner", "mixed", &output);
        assert!(result.running);
        assert_eq!(result.completed, ["initial"]);
        assert!(tracker.output("owner", "mixed", &output).completed.is_empty());
        assert_eq!(tracker.link_wait("owner", "last", &[(39172, 0)]), ["mixed"]);
        assert_eq!(tracker.output("owner", "last", &done()).completed, ["mixed"]);
    }

    #[test]
    fn missing_executor_result_cannot_shift_a_later_result_into_the_wait_slot() {
        let mut tracker = Continuations::default();
        tracker.output("owner", "initial", &running(79058));
        tracker.link_wait("owner", "mixed", &[(79058, 0)]);
        tracker.expect_results("owner", "mixed", 2);
        let outcome = tracker.output("owner", "mixed", &wrapper(vec![done()]));
        assert!(outcome.completed.is_empty());
    }

    #[test]
    fn all_sessions_must_finish_and_wait_yields_keep_original_owner() {
        let mut t = Continuations::default();
        t.output("o", "a", &wrapper(vec![running(1), running(2)]));
        t.link_wait("o", "poll", &[(1, 0)]);
        let poll = t.output("o", "poll", &running(1));
        assert!(!poll.running);
        assert!(poll.continued);
        assert_eq!(t.link_wait("o", "w1", &[(1, 0)]), ["a"]);
        assert!(t.output("o", "w1", &Value::String(done().to_string())).completed.is_empty());
        assert_eq!(t.link_wait("o", "w2", &[(2, 0)]), ["a"]);
        assert_eq!(t.output("o", "w2", &done()).completed, ["a"]);
        assert!(t.output("o", "w2", &done()).completed.is_empty());
    }

    #[test]
    fn reused_session_is_ambiguous_even_after_original_finished() {
        for finish_first in [false, true] {
            let mut t = Continuations::default();
            t.output("o", "a", &running(1));
            if finish_first {
                t.link_wait("o", "finish", &[(1, 0)]);
                assert_eq!(t.output("o", "finish", &done()).completed, ["a"]);
            }
            t.output("o", "b", &running(1));
            assert!(t.link_wait("o", "w", &[(1, 0)]).is_empty());
            assert!(t.output("o", "w", &done()).completed.is_empty());
        }
    }

    #[test]
    fn owner_isolation_and_clear() {
        let mut t = Continuations::default();
        t.output("a", "start", &running(1));
        assert!(t.link_wait("b", "w", &[(1, 0)]).is_empty());
        assert!(t.output("b", "w", &done()).completed.is_empty());
        t.output("b", "start", &running(1));
        t.clear_owner("a");
        assert!(t.link_wait("a", "w", &[(1, 0)]).is_empty());
        assert_eq!(t.link_wait("b", "w2", &[(1, 0)]), ["start"]);
        assert_eq!(t.output("b", "w2", &done()).completed, ["start"]);
    }

    #[test]
    fn ignores_nested_text_and_requires_executor_shape() {
        let mut t = Continuations::default();
        for v in [json!({"output":running(1)}), json!({"session_id":1}),
            json!({"wall_time_seconds":1,"output":"x","session_id":"1"}),
            json!({"type":"text","text":running(1).to_string()}),
            json!(format!("arbitrary text {}", running(1)))] {
            assert!(!t.output("o", "bad", &v).running);
        }
        let text = format!("Script completed\nWall time 1s\nOutput:\n{}", running(3));
        assert!(t.output("o", "good", &json!(text)).running);
    }

    #[test]
    fn nonterminal_missing_and_wrong_ordinal_do_not_complete() {
        let mut t = Continuations::default();
        t.output("o", "a", &running(1));
        t.link_wait("o", "wrong", &[(1, 1)]);
        assert!(t.output("o", "wrong", &done()).completed.is_empty());
        t.link_wait("o", "null", &[(1, 0)]);
        assert!(t.output("o", "null", &json!({"exit_code":null,"output":"x","wall_time_seconds":1})).completed.is_empty());
        t.link_wait("o", "finish", &[(1, 0), (1, 0)]);
        assert_eq!(t.output("o", "finish", &done()).completed, ["a"]);
    }

    #[test]
    fn capacity_exhaustion_never_releases_retained_origins() {
        let mut t = Continuations::default();
        t.output("o", "a", &running(1));
        for n in 0..MAX_ENTRIES {
            t.link_wait("o", &format!("wait-{n}"), &[(1, 0)]);
        }
        assert!(t.owners["o"].disabled);
        assert!(t.owners["o"].calls.is_empty());
        assert!(t.output("o", "wait-0", &done()).completed.is_empty());
        t.clear_owner("o");
        t.output("o", "fresh", &running(1));
        assert_eq!(t.link_wait("o", "w", &[(1, 0)]), ["fresh"]);
        assert_eq!(t.output("o", "w", &done()).completed, ["fresh"]);
    }

    #[test]
    fn collision_later_in_wrapper_prevents_earlier_completion() {
        let mut t = Continuations::default();
        t.output("o", "a", &running(1));
        t.link_wait("o", "mixed", &[(1, 0)]);
        assert!(t.output("o", "mixed", &wrapper(vec![done(), running(1)])).completed.is_empty());
        assert!(t.link_wait("o", "later", &[(1, 0)]).is_empty());
    }

    #[test]
    fn conflicting_wait_ordinals_fail_closed() {
        let mut t = Continuations::default();
        t.output("o", "a", &running(1));
        t.output("o", "b", &running(2));
        assert!(t.link_wait("o", "w", &[(1, 0), (2, 0)]).is_empty());
        assert!(t.output("o", "w", &done()).completed.is_empty());
    }

    #[test]
    fn unknown_wait_cannot_capture_a_later_session() {
        let mut t = Continuations::default();
        assert!(t.link_wait("o", "w", &[(1, 0)]).is_empty());
        t.output("o", "a", &running(1));
        assert!(t.output("o", "w", &done()).completed.is_empty());
    }

    #[test]
    fn unknown_nonterminal_wait_does_not_claim_ownership() {
        let mut t = Continuations::default();
        assert!(t.link_wait("o", "w", &[(1, 0)]).is_empty());
        let result = t.output("o", "w", &running(1));
        assert!(!result.running);
        assert!(!result.continued);
        assert!(t.link_wait("o", "later", &[(1, 0)]).is_empty());
    }

    #[test]
    fn repeated_nonterminal_waiters_do_not_own_original_sessions() {
        let mut t = Continuations::default();
        let first = t.output("o", "start", &running(79058));
        assert!(first.running);
        assert!(!first.continued);
        for call in ["poll-1", "poll-2", "poll-3"] {
            assert_eq!(t.link_wait("o", call, &[(79058, 0)]), ["start"]);
            for _ in 0..2 {
                let result = t.output("o", call, &wrapper(vec![running(79058)]));
                assert!(!result.running);
                assert!(result.continued);
                assert!(result.completed.is_empty());
            }
        }
        t.link_wait("o", "last", &[(79058, 0)]);
        let last = t.output("o", "last", &done());
        assert!(!last.running);
        assert!(last.continued);
        assert_eq!(last.completed, ["start"]);
    }
}
