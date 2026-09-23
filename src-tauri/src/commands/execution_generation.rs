//! Cancellation tickets for multiplexed bridges: one thread cannot invalidate
//! another thread's request while its policy refresh is pending.

use std::collections::HashMap;
use std::sync::{Arc, atomic::{AtomicU64, Ordering}};
use tokio::sync::Mutex;

#[derive(Default)]
pub(super) struct ExecutionGenerations {
    threads: Mutex<HashMap<String, Arc<AtomicU64>>>,
}

pub(super) struct ExecutionTicket {
    generation: Arc<AtomicU64>,
    value: u64,
}

impl ExecutionGenerations {
    pub async fn capture(&self, thread_id: &str, cancel: bool) -> ExecutionTicket {
        let mut threads = self.threads.lock().await;
        let generation = threads.entry(thread_id.to_string())
            .or_insert_with(|| Arc::new(AtomicU64::new(0)));
        if cancel { generation.fetch_add(1, Ordering::SeqCst); }
        ExecutionTicket { generation: generation.clone(), value: generation.load(Ordering::SeqCst) }
    }
}

impl ExecutionTicket {
    pub fn validate(&self) -> Result<(), String> {
        if self.value != self.generation.load(Ordering::SeqCst) {
            return Err("Execution cancelled before delivery".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_rejects_delayed_write_only_for_its_thread() {
        let generations = ExecutionGenerations::default();
        let cancelled = generations.capture("cancelled", false).await;
        let other = generations.capture("other", false).await;
        let (resume, refresh) = tokio::sync::oneshot::channel();
        let output = Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
        let sink = output.clone();
        let delayed = tokio::spawn(async move {
            refresh.await.unwrap();
            cancelled.validate()?;
            sink.lock().unwrap().extend_from_slice(b"must not be written");
            Ok::<_, String>(())
        });
        generations.capture("cancelled", true).await;
        resume.send(()).unwrap();
        assert!(delayed.await.unwrap().is_err());
        assert!(output.lock().unwrap().is_empty());
        other.validate().unwrap();
        generations.capture("cancelled", false).await.validate().unwrap();
    }

    #[tokio::test]
    async fn repeated_cancel_invalidates_all_earlier_tickets_not_new_requests() {
        let generations = ExecutionGenerations::default();
        let first = generations.capture("thread", false).await;
        let second = generations.capture("thread", false).await;
        generations.capture("thread", true).await;
        let between = generations.capture("thread", false).await;
        generations.capture("thread", true).await;
        assert!(first.validate().is_err());
        assert!(second.validate().is_err());
        assert!(between.validate().is_err());
        generations.capture("thread", false).await.validate().unwrap();
    }
}
