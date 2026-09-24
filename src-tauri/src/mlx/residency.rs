//! Pure admission / eviction policy for locally-resident MLX models.
//!
//! No I/O and no process handling — `pool.rs` owns those and drives this.
//! Keeping the policy pure is what makes the eviction rules testable, which
//! matters because the failure mode (evicting a model mid-turn) is invisible
//! at runtime until a user's turn dies.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// What the caller must do to satisfy an `admit` request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResidencyPlan {
    /// Models to shut down first, in eviction order.
    pub evict: Vec<String>,
    /// False when the model is already resident and nothing needs spawning.
    pub load: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResidencyError {
    /// The model cannot fit even in an empty machine.
    ExceedsBudget { needed_mb: u64, budget_mb: u64 },
    /// Room could only be made by evicting models that have in-flight work.
    AllBusy,
}

impl std::fmt::Display for ResidencyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResidencyError::ExceedsBudget { needed_mb, budget_mb } => write!(
                f,
                "model needs ~{:.1} GB but only ~{:.1} GB is available for local models on this Mac",
                *needed_mb as f64 / 1024.0,
                *budget_mb as f64 / 1024.0
            ),
            ResidencyError::AllBusy => write!(
                f,
                "every loaded local model is mid-request; retry once one finishes"
            ),
        }
    }
}

struct Entry {
    cost_mb: u64,
    /// Monotonic counter, not a clock — LRU ordering is all eviction needs.
    last_used: u64,
    /// When the model last started or finished a request. Only the idle
    /// sweep reads it, through `idle_for(model, now)`.
    last_active: Instant,
    in_flight: u32,
}

pub struct Residency {
    /// RAM that models may share. Eviction keeps co-resident models under it.
    budget_mb: u64,
    /// Largest model that may run at all, alone, with everything else
    /// evicted. Above `budget_mb` so a Mac can run the model its own tier
    /// recommends even when the shared budget couldn't hold it.
    solo_cap_mb: u64,
    tick: u64,
    entries: HashMap<String, Entry>,
}

impl Residency {
    pub fn new(budget_mb: u64, solo_cap_mb: u64) -> Self {
        Self {
            budget_mb,
            solo_cap_mb: solo_cap_mb.max(budget_mb),
            tick: 0,
            entries: HashMap::new(),
        }
    }

    fn next_tick(&mut self) -> u64 {
        self.tick += 1;
        self.tick
    }

    fn used_mb(&self) -> u64 {
        self.entries.values().map(|e| e.cost_mb).sum()
    }

    pub fn resident(&self) -> Vec<String> {
        let mut v: Vec<String> = self.entries.keys().cloned().collect();
        v.sort();
        v
    }

    pub fn touch(&mut self, model: &str) {
        let t = self.next_tick();
        if let Some(e) = self.entries.get_mut(model) {
            e.last_used = t;
        }
    }

    pub fn contains(&self, model: &str) -> bool {
        self.entries.contains_key(model)
    }

    pub fn begin_request(&mut self, model: &str) {
        let t = self.next_tick();
        if let Some(e) = self.entries.get_mut(model) {
            e.in_flight += 1;
            e.last_used = t;
            e.last_active = Instant::now();
        }
    }

    pub fn end_request(&mut self, model: &str) {
        if let Some(e) = self.entries.get_mut(model) {
            e.in_flight = e.in_flight.saturating_sub(1);
            // A turn that streamed for five minutes was in use until now, not
            // idle since it began.
            e.last_active = Instant::now();
        }
    }

    pub fn idle_since(&self, model: &str) -> Option<u64> {
        self.entries.get(model).map(|e| e.last_used)
    }

    /// How long `model` has gone without a request, or `None` while one is
    /// outstanding (or the model isn't resident).
    pub fn idle_for(&self, model: &str, now: Instant) -> Option<Duration> {
        let e = self.entries.get(model)?;
        (e.in_flight == 0).then(|| now.saturating_duration_since(e.last_active))
    }

    /// True while any request is outstanding. The idle sweep must consult
    /// this before unloading — evicting a model mid-turn kills a user's
    /// in-flight request with no visible cause.
    #[cfg(test)]
    pub fn is_busy(&self, model: &str) -> bool {
        self.entries.get(model).is_some_and(|e| e.in_flight > 0)
    }

    pub fn remove(&mut self, model: &str) {
        self.entries.remove(model);
    }

    pub fn admit(&mut self, model: &str, cost_mb: u64) -> Result<ResidencyPlan, ResidencyError> {
        if self.entries.contains_key(model) {
            self.touch(model);
            return Ok(ResidencyPlan { evict: Vec::new(), load: false });
        }
        if cost_mb > self.solo_cap_mb {
            return Err(ResidencyError::ExceedsBudget {
                needed_mb: cost_mb,
                budget_mb: self.solo_cap_mb,
            });
        }
        // A model bigger than the shared budget may still run alone: every
        // other model has to go, which the loop below demands exactly.
        let limit = self.budget_mb.max(cost_mb);

        // Idle models, least-recently-used first — the eviction candidates.
        let mut candidates: Vec<(String, u64, u64)> = self
            .entries
            .iter()
            .filter(|(_, e)| e.in_flight == 0)
            .map(|(k, e)| (k.clone(), e.last_used, e.cost_mb))
            .collect();
        candidates.sort_by_key(|(_, last_used, _)| *last_used);

        let mut freed = 0u64;
        let mut evict: Vec<String> = Vec::new();
        let mut used = self.used_mb();
        for (name, _, cost) in candidates {
            if used + cost_mb - freed <= limit {
                break;
            }
            freed += cost;
            evict.push(name);
        }
        if used + cost_mb - freed > limit {
            return Err(ResidencyError::AllBusy);
        }

        for name in &evict {
            self.entries.remove(name);
        }
        used = self.used_mb();
        debug_assert!(used + cost_mb <= limit);

        let t = self.next_tick();
        self.entries.insert(
            model.to_string(),
            Entry { cost_mb, last_used: t, last_active: Instant::now(), in_flight: 0 },
        );
        Ok(ResidencyPlan { evict, load: true })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admits_when_budget_allows() {
        let mut r = Residency::new(16_000, 16_000);
        let plan = r.admit("a", 4_000).unwrap();
        assert_eq!(plan.evict, Vec::<String>::new());
        assert!(plan.load);
        assert_eq!(r.resident(), vec!["a".to_string()]);
    }

    #[test]
    fn resident_model_is_a_noop_load() {
        let mut r = Residency::new(16_000, 16_000);
        r.admit("a", 4_000).unwrap();
        let plan = r.admit("a", 4_000).unwrap();
        assert!(!plan.load);
        assert_eq!(plan.evict, Vec::<String>::new());
    }

    #[test]
    fn evicts_least_recently_used_to_fit() {
        let mut r = Residency::new(10_000, 10_000);
        r.admit("a", 4_000).unwrap();
        r.admit("b", 4_000).unwrap();
        r.touch("a");
        let plan = r.admit("c", 4_000).unwrap();
        assert_eq!(plan.evict, vec!["b".to_string()]);
    }

    #[test]
    fn never_evicts_a_model_with_in_flight_requests() {
        let mut r = Residency::new(10_000, 10_000);
        r.admit("a", 4_000).unwrap();
        r.admit("b", 4_000).unwrap();
        r.begin_request("b");
        r.touch("a");
        let plan = r.admit("c", 4_000).unwrap();
        assert_eq!(plan.evict, vec!["a".to_string()]);
    }

    #[test]
    fn refuses_when_model_exceeds_budget_alone() {
        let mut r = Residency::new(8_000, 8_000);
        let err = r.admit("huge", 12_000).unwrap_err();
        assert!(matches!(err, ResidencyError::ExceedsBudget { needed_mb: 12_000, budget_mb: 8_000 }));
    }

    #[test]
    fn refuses_when_only_busy_models_could_be_evicted() {
        let mut r = Residency::new(8_000, 8_000);
        r.admit("a", 4_000).unwrap();
        r.begin_request("a");
        r.admit("b", 4_000).unwrap();
        r.begin_request("b");
        let err = r.admit("c", 4_000).unwrap_err();
        assert!(matches!(err, ResidencyError::AllBusy));
    }

    #[test]
    fn is_busy_tracks_in_flight_requests() {
        let mut r = Residency::new(16_000, 16_000);
        r.admit("a", 4_000).unwrap();
        assert!(!r.is_busy("a"));
        r.begin_request("a");
        assert!(r.is_busy("a"));
        r.end_request("a");
        assert!(!r.is_busy("a"));
        // An unknown model is not busy.
        assert!(!r.is_busy("nope"));
    }

    #[test]
    fn is_busy_survives_overlapping_requests() {
        let mut r = Residency::new(16_000, 16_000);
        r.admit("a", 4_000).unwrap();
        r.begin_request("a");
        r.begin_request("a");
        r.end_request("a");
        assert!(r.is_busy("a"), "still one request outstanding");
        r.end_request("a");
        assert!(!r.is_busy("a"));
    }

    #[test]
    fn a_model_over_the_shared_budget_runs_alone_under_the_solo_cap() {
        let mut r = Residency::new(2_000, 6_000);
        r.admit("small", 1_000).unwrap();
        let plan = r.admit("big", 4_500).unwrap();
        assert_eq!(plan.evict, vec!["small".to_string()]);
        assert!(plan.load);
        assert_eq!(r.resident(), vec!["big".to_string()]);
    }

    #[test]
    fn a_solo_model_waits_for_busy_models_instead_of_killing_them() {
        let mut r = Residency::new(2_000, 6_000);
        r.admit("small", 1_000).unwrap();
        r.begin_request("small");
        assert!(matches!(r.admit("big", 4_500).unwrap_err(), ResidencyError::AllBusy));
    }

    #[test]
    fn refuses_a_model_over_the_solo_cap() {
        let mut r = Residency::new(2_000, 6_000);
        let err = r.admit("huge", 7_000).unwrap_err();
        assert!(matches!(err, ResidencyError::ExceedsBudget { needed_mb: 7_000, budget_mb: 6_000 }));
    }

    #[test]
    fn idle_time_runs_from_the_end_of_the_last_request() {
        let mut r = Residency::new(16_000, 16_000);
        r.admit("a", 4_000).unwrap();
        r.begin_request("a");
        assert_eq!(r.idle_for("a", Instant::now()), None, "busy models are never idle");
        r.end_request("a");
        let later = Instant::now() + Duration::from_secs(600);
        let idle = r.idle_for("a", later).unwrap();
        assert!(idle >= Duration::from_secs(599) && idle <= Duration::from_secs(601));
        assert_eq!(r.idle_for("missing", later), None);
    }

    #[test]
    fn end_request_makes_a_model_evictable_again() {
        let mut r = Residency::new(8_000, 8_000);
        r.admit("a", 8_000).unwrap();
        r.begin_request("a");
        r.end_request("a");
        let plan = r.admit("b", 8_000).unwrap();
        assert_eq!(plan.evict, vec!["a".to_string()]);
    }
}
