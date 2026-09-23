//! Owns the live backends and drives the residency policy.
//!
//! `acquire` is the single entry point: it returns a `Lease` that both names
//! the backend to proxy to and holds an in-flight count, so the residency
//! policy can never evict a model that is mid-turn. Dropping the lease
//! releases the count.

use crate::mlx::backend::Backend;
use crate::mlx::residency::Residency;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use tokio::sync::{Mutex, Notify};

/// Memory kept away from local models for macOS, agmux, and the user's apps.
const RESERVE_MB: u64 = 6 * 1024;
/// Cost assumed for a model with no catalog entry and no readable weights.
const DEFAULT_COST_MB: u64 = 6 * 1024;

pub fn budget_mb() -> u64 {
    let hw = crate::mlx::catalog::detect_hardware();
    let total = (hw.total_ram_gb as u64) * 1024;
    total.saturating_sub(RESERVE_MB).max(2 * 1024)
}

/// Runtime cost estimate. Catalog entries already fold in KV-cache headroom;
/// otherwise fall back to on-disk weight size plus a flat allowance.
pub fn model_cost_mb(model: &str) -> u64 {
    if let Some(entry) = crate::mlx::catalog::lookup(model) {
        return (entry.ram_gb * 1024.0).ceil() as u64;
    }
    if let Some(m) = crate::mlx::discovery::scan_all().into_iter().find(|m| m.id == model) {
        let weights_mb = m.size_bytes / (1024 * 1024);
        if weights_mb > 0 {
            return weights_mb + 2 * 1024;
        }
    }
    DEFAULT_COST_MB
}

pub struct Lease {
    pub base_url: String,
    pub model_arg: String,
    model: String,
    residency: Arc<StdMutex<Residency>>,
}

// Manual impl: `Residency` doesn't derive `Debug`, so a derive here would
// fail via the `Arc<StdMutex<Residency>>` field. Tests need `Lease: Debug`
// for `Result::unwrap_err`.
impl std::fmt::Debug for Lease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lease")
            .field("base_url", &self.base_url)
            .field("model_arg", &self.model_arg)
            .field("model", &self.model)
            .finish()
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        // Synchronous and infallible on purpose: a Lease can be dropped
        // from a non-Tokio thread (e.g. PTY I/O uses std::thread), where
        // `tokio::spawn` would panic, and even inside a Tokio context a
        // detached task can be lost if the runtime is shutting down. Either
        // way the decrement would never happen, leaving the model marked
        // busy forever — permanently un-evictable. A std mutex makes the
        // decrement happen inline, guaranteed, before this function returns.
        self.residency
            .lock()
            .expect("residency mutex poisoned")
            .end_request(&self.model);
    }
}

pub struct ModelPool {
    venv_python: Arc<Mutex<Option<PathBuf>>>,
    /// Std, not Tokio: every critical section here is short and contains no
    /// `.await`, and `Lease::drop` needs a synchronous, infallible way to
    /// decrement in-flight count from any thread (see the comment there).
    residency: Arc<StdMutex<Residency>>,
    backends: Arc<Mutex<HashMap<String, Backend>>>,
    /// Serializes load/evict so two concurrent first-requests for the same
    /// model spawn one process, not two. Held only for plan/evict/spawn and
    /// insert — not across the multi-minute `wait_ready` poll.
    load_lock: Arc<Mutex<()>>,
    /// Models mid-spawn+wait_ready. Concurrent acquires for the same id wait
    /// on the Notify instead of double-spawning or seeing a missing backend.
    loading: Arc<Mutex<HashMap<String, Arc<Notify>>>>,
}

impl ModelPool {
    pub fn new(venv_python: Option<PathBuf>) -> Self {
        Self {
            venv_python: Arc::new(Mutex::new(venv_python)),
            residency: Arc::new(StdMutex::new(Residency::new(budget_mb()))),
            backends: Arc::new(Mutex::new(HashMap::new())),
            load_lock: Arc::new(Mutex::new(())),
            loading: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn set_venv(&self, path: PathBuf) {
        *self.venv_python.lock().await = Some(path);
    }

    pub async fn acquire(&self, model: &str) -> Result<Lease, String> {
        let venv = self.venv_python.lock().await.clone().ok_or_else(|| {
            "local models are not set up yet — open Settings → Local Models".to_string()
        })?;

        // Retry when another acquire finishes loading this model for us.
        loop {
            let _guard = self.load_lock.lock().await;

            // Subscribe to the Notify *before* releasing load_lock so we
            // cannot miss a completion that fires between drop and await.
            if let Some(n) = self.loading.lock().await.get(model).cloned() {
                let notified = n.notified();
                drop(_guard);
                notified.await;
                continue;
            }

            let cost = model_cost_mb(model);
            let plan = {
                let mut r = self.residency.lock().expect("residency mutex poisoned");
                r.admit(model, cost).map_err(|e| e.to_string())?
            };

            for victim in &plan.evict {
                if let Some(b) = self.backends.lock().await.remove(victim) {
                    tracing::info!(
                        target: "xanom::mlx::pool",
                        model = %victim,
                        "evicting idle local model"
                    );
                    b.shutdown().await;
                }
            }

            if !plan.load {
                let (base_url, model_arg) = {
                    let backends = self.backends.lock().await;
                    let b = backends
                        .get(model)
                        .ok_or_else(|| format!("local model '{model}' is not loaded"))?;
                    (b.base_url(), b.model_arg.clone())
                };
                // Pin under load_lock so sweep cannot race us.
                self.residency
                    .lock()
                    .expect("residency mutex poisoned")
                    .begin_request(model);
                return Ok(Lease {
                    base_url,
                    model_arg,
                    model: model.to_string(),
                    residency: self.residency.clone(),
                });
            }

            // Pin as busy so concurrent admit/sweep cannot evict this model
            // while wait_ready runs outside the lock. This in_flight count
            // becomes the caller's lease.
            self.residency
                .lock()
                .expect("residency mutex poisoned")
                .begin_request(model);
            let notify = Arc::new(Notify::new());
            self.loading
                .lock()
                .await
                .insert(model.to_string(), notify.clone());
            drop(_guard); // release before multi-minute wait_ready

            let load_result = async {
                let mut backend = Backend::spawn_process(&venv, model).await?;
                backend.wait_ready().await?;
                Ok::<Backend, String>(backend)
            }
            .await;

            let _guard = self.load_lock.lock().await;
            self.loading.lock().await.remove(model);
            match load_result {
                Ok(b) => {
                    // Eject/`shutdown_all` may have cleared residency while
                    // wait_ready ran outside the lock.
                    let still_reserved = {
                        let r = self.residency.lock().expect("residency mutex poisoned");
                        r.resident().iter().any(|m| m == model)
                    };
                    if !still_reserved {
                        drop(_guard);
                        b.shutdown().await;
                        notify.notify_waiters();
                        return Err(format!(
                            "local model '{model}' was unloaded during load"
                        ));
                    }
                    let base_url = b.base_url();
                    let model_arg = b.model_arg.clone();
                    self.backends.lock().await.insert(model.to_string(), b);
                    notify.notify_waiters();
                    // begin_request already applied as the load pin.
                    return Ok(Lease {
                        base_url,
                        model_arg,
                        model: model.to_string(),
                        residency: self.residency.clone(),
                    });
                }
                Err(e) => {
                    // Roll the reservation back so a failed load does not
                    // permanently consume budget.
                    {
                        let mut r = self.residency.lock().expect("residency mutex poisoned");
                        r.end_request(model);
                        r.remove(model);
                    }
                    notify.notify_waiters();
                    return Err(e);
                }
            }
        }
    }

    /// Unload all but the `keep_newest` most-recently-used models, skipping
    /// any that are mid-request. Runs on a timer so RAM comes back without
    /// waiting for memory pressure.
    ///
    /// Busy models are skipped, never counted against `keep_newest`: a model
    /// with an outstanding request is by definition in use, and unloading it
    /// would kill that turn with no visible cause.
    pub async fn sweep_idle(&self, keep_newest: usize) {
        let _guard = self.load_lock.lock().await;

        // Snapshot idle candidates, newest last.
        let mut idle: Vec<(String, u64)> = {
            let r = self.residency.lock().expect("residency mutex poisoned");
            r.resident()
                .into_iter()
                .filter(|m| !r.is_busy(m))
                .filter_map(|m| r.idle_since(&m).map(|t| (m, t)))
                .collect()
        };
        if idle.len() <= keep_newest {
            return;
        }
        idle.sort_by_key(|(_, t)| *t);
        let drop_count = idle.len() - keep_newest;

        for (model, _) in idle.into_iter().take(drop_count) {
            // Re-check under the lock: a request may have arrived since the
            // snapshot. The load_lock does not cover request arrival.
            let claimed = {
                let mut r = self.residency.lock().expect("residency mutex poisoned");
                if r.is_busy(&model) {
                    false
                } else {
                    r.remove(&model);
                    true
                }
            };
            if !claimed {
                continue;
            }
            if let Some(b) = self.backends.lock().await.remove(&model) {
                tracing::info!(target: "xanom::mlx::pool", %model, "offloading idle local model");
                b.shutdown().await;
            }
        }
    }

    pub async fn shutdown_all(&self) {
        // Same discipline as `acquire`/`sweep_idle`: hold `load_lock` for
        // the whole call so this can't interleave with a concurrent
        // `acquire` (which would otherwise be able to reserve budget and
        // spawn a backend for a model this call has already cleared from
        // residency — a leaked process, invisible to eviction).
        let _guard = self.load_lock.lock().await;

        // Wake waiters blocked on in-flight loads; those LoadUs paths re-check
        // residency and shut down the orphan child if we cleared them.
        let pending: Vec<Arc<Notify>> = {
            let mut loading = self.loading.lock().await;
            loading.drain().map(|(_, n)| n).collect()
        };
        for n in pending {
            n.notify_waiters();
        }

        let models: Vec<String> = {
            let r = self.residency.lock().expect("residency mutex poisoned");
            r.resident()
        };

        for m in &models {
            if let Some(b) = self.backends.lock().await.remove(m) {
                b.shutdown().await;
            }
        }

        let mut r = self.residency.lock().expect("residency mutex poisoned");
        for m in &models {
            r.remove(m);
        }
    }
}

#[cfg(test)]
impl ModelPool {
    /// Seeds a resident residency entry directly, bypassing `acquire`'s
    /// backend spawn, so `sweep_idle`'s eviction path can be exercised
    /// without a real `mlx_lm.server` process.
    fn test_seed_idle(&self, model: &str, cost_mb: u64) {
        self.residency
            .lock()
            .expect("residency mutex poisoned")
            .admit(model, cost_mb)
            .expect("test_seed_idle: budget");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_reserves_headroom_below_total_ram() {
        let hw = crate::mlx::catalog::detect_hardware();
        let b = budget_mb();
        assert!(b < (hw.total_ram_gb as u64) * 1024, "budget must reserve OS headroom");
    }

    #[test]
    fn unknown_model_gets_a_nonzero_default_cost() {
        let cost = model_cost_mb("definitely-not-installed/xyz-999");
        assert!(cost > 0, "unknown models must still consume budget");
    }

    #[tokio::test]
    async fn acquire_without_a_venv_reports_setup_not_a_timeout() {
        let pool = ModelPool::new(None);
        let err = pool.acquire("anything").await.unwrap_err();
        assert!(
            err.contains("not set up"),
            "expected a setup message, got: {err}"
        );
    }

    #[tokio::test]
    async fn sweep_on_an_empty_pool_is_a_noop_and_does_not_deadlock() {
        let pool = ModelPool::new(None);
        // Guards against the lock-ordering mistake this method invites:
        // holding the residency lock while taking the backends lock.
        tokio::time::timeout(std::time::Duration::from_secs(5), pool.sweep_idle(1))
            .await
            .expect("sweep_idle deadlocked");
    }

    #[tokio::test]
    async fn sweep_idle_evicts_the_oldest_entries_but_keeps_the_newest() {
        let pool = ModelPool::new(None);
        // No real backends: `backends.remove()` returning `None` for each
        // is fine — this exercises the residency-side eviction and the
        // lock-drop-then-reacquire path, not process teardown.
        pool.test_seed_idle("a", 1);
        pool.test_seed_idle("b", 1);
        pool.test_seed_idle("c", 1);

        tokio::time::timeout(std::time::Duration::from_secs(5), pool.sweep_idle(1))
            .await
            .expect("sweep_idle deadlocked");

        let resident = {
            let r = pool.residency.lock().expect("residency mutex poisoned");
            r.resident()
        };
        assert_eq!(
            resident,
            vec!["c".to_string()],
            "only the newest (most recently admitted) entry should survive"
        );
    }
}
