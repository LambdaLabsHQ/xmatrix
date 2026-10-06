//! Session-owned quota polling, independent of long turns and idle delivery.

use std::{future::Future, time::Duration};

use crate::LlmUsage;

/// The polling task; dropping it stops the polling.
pub struct QuotaRefreshTask(tokio::task::JoinHandle<()>);

impl Drop for QuotaRefreshTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// The startup read remains synchronous. Subsequent reads respect the provider
/// cache; failures publish nothing and never manufacture fresh observations.
pub fn spawn_quota_refresh<R, F, P>(mut read: R, mut publish: P) -> QuotaRefreshTask
where
    R: FnMut() -> F + Send + 'static,
    F: Future<Output = Option<LlmUsage>> + Send,
    P: FnMut(LlmUsage) + Send + 'static,
{
    QuotaRefreshTask(tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        tick.tick().await;
        loop {
            tick.tick().await;
            // Bound the entire read, including body parsing. Never overlap
            // periodic requests or catch up with a burst after suspension.
            if let Ok(Some(usage)) = tokio::time::timeout(Duration::from_secs(15), read()).await {
                publish(usage);
            }
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    async fn advance_poll_interval() {
        tokio::time::advance(Duration::from_secs(60)).await;
        tokio::task::yield_now().await;
    }

    #[tokio::test(start_paused = true)]
    async fn refreshes_without_turn_completion_and_stops_on_drop() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let task = spawn_quota_refresh(
            || async { Some(LlmUsage::default()) },
            move |usage| {
                tx.send(usage).unwrap();
            },
        );
        tokio::task::yield_now().await;
        assert!(rx.try_recv().is_err());
        advance_poll_interval().await;
        assert!(rx.try_recv().is_ok());
        advance_poll_interval().await;
        assert!(rx.try_recv().is_ok());
        drop(task);
        tokio::task::yield_now().await;
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn unavailable_read_does_not_refresh_timestamp_and_later_success_publishes() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut first = true;
        let task = spawn_quota_refresh(
            move || {
                let unavailable = std::mem::replace(&mut first, false);
                async move {
                    (!unavailable).then(|| LlmUsage {
                        quota_observed_at: Some("2026-09-21T18:30:00Z".into()),
                        ..Default::default()
                    })
                }
            },
            move |usage| {
                tx.send(usage).unwrap();
            },
        );
        tokio::task::yield_now().await;
        advance_poll_interval().await;
        assert!(rx.try_recv().is_err());
        advance_poll_interval().await;
        assert_eq!(
            rx.try_recv().unwrap().quota_observed_at.as_deref(),
            Some("2026-09-21T18:30:00Z")
        );
        drop(task);
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_reads_time_out_and_retry_without_publishing() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let reads = attempts.clone();
        let task = spawn_quota_refresh(
            move || {
                reads.fetch_add(1, Ordering::SeqCst);
                std::future::pending()
            },
            |_| panic!("failed read must not publish"),
        );
        tokio::task::yield_now().await;
        advance_poll_interval().await;
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_secs(15)).await;
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(45)).await;
        tokio::task::yield_now().await;
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        drop(task);
        tokio::time::advance(Duration::from_secs(120)).await;
        tokio::task::yield_now().await;
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }
}
