//! Host side of a trace history read, including a live delta that waits
//! (long-polls) for an event newer than its watermark.

use std::sync::{Arc, Mutex};

use crate::agent_instance_connection::now_ms;
use crate::agent_trace_store::{
    AgentHostTraceAvailability, AgentHostTraceHistory, AgentHostTraceHistoryQuery,
    AgentHostTraceStore,
};
use crate::protocol::AgentInstanceClientMessage;

/// Longest a live trace delta may wait on the host for a newer event.
pub(crate) const TRACE_HISTORY_MAX_WAIT_MS: u32 = 25_000;
/// Waiting reads held at once on one connection; past this a read answers now.
pub(crate) const TRACE_HISTORY_MAX_WAITS: usize = 16;

pub(crate) struct TraceHistoryRead {
    pub(crate) request_id: String,
    pub(crate) instance_id: String,
    pub(crate) max_events: usize,
    pub(crate) max_bytes: Option<usize>,
    pub(crate) since: Option<String>,
    pub(crate) before: Option<String>,
}

impl TraceHistoryRead {
    pub(crate) fn response(&self, history: AgentHostTraceHistory) -> AgentInstanceClientMessage {
        AgentInstanceClientMessage::TraceHistoryResult {
            request_id: self.request_id.clone(),
            instance_id: self.instance_id.clone(),
            availability: history.availability.as_str().to_string(),
            complete: history.complete,
            events: history.events,
            next_cursor: history.next_cursor,
        }
    }
}

pub(crate) fn read_trace_history(
    store: &Arc<Mutex<AgentHostTraceStore>>,
    read: &TraceHistoryRead,
) -> AgentHostTraceHistory {
    let query = AgentHostTraceHistoryQuery {
        max_events: read.max_events,
        max_bytes: read.max_bytes,
        since: read.since.as_deref(),
        before: read.before.as_deref(),
    };
    match store.lock() {
        Ok(mut store) => store.history(&read.instance_id, query, now_ms()),
        Err(_) => AgentHostTraceHistory {
            availability: AgentHostTraceAvailability::Unavailable,
            complete: false,
            events: Vec::new(),
            next_cursor: None,
        },
    }
}

pub(crate) fn try_start_trace_wait(waits: &std::sync::atomic::AtomicUsize) -> bool {
    waits
        .fetch_update(
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
            |current| (current < TRACE_HISTORY_MAX_WAITS).then_some(current + 1),
        )
        .is_ok()
}

/// Answer a `since` delta once it holds more than it did when asked, the
/// history stops being available, or `wait` elapses. `since` is inclusive,
/// so the events already at the watermark are the baseline, not news.
pub(crate) async fn wait_for_trace_history(
    store: &Arc<Mutex<AgentHostTraceStore>>,
    read: &TraceHistoryRead,
    wait: std::time::Duration,
) -> AgentHostTraceHistory {
    let deadline = tokio::time::Instant::now() + wait;
    let Some(signal) = store.lock().ok().map(|store| store.change_signal()) else {
        return read_trace_history(store, read);
    };
    let mut baseline = None;
    loop {
        // Register before reading, so an event recorded in between still wakes us.
        let notified = signal.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let history = read_trace_history(store, read);
        let count = history.events.len();
        let settled = history.availability != AgentHostTraceAvailability::Available
            || count >= read.max_events
            || baseline.is_some_and(|baseline| count > baseline);
        if settled || tokio::time::Instant::now() >= deadline {
            return history;
        }
        baseline.get_or_insert(count);
        if tokio::time::timeout_at(deadline, notified).await.is_err() {
            return read_trace_history(store, read);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::agent_instance_connection::tests::trace_test_agent;

    fn waiting_trace_store(events: &[(&str, &str)]) -> Arc<Mutex<AgentHostTraceStore>> {
        let store = Arc::new(Mutex::new(AgentHostTraceStore::default()));
        {
            let mut guard = store.lock().unwrap();
            guard.bind_session(&trace_test_agent("instance:1"), now_ms());
            for (id, at) in events {
                guard.record(
                    "channel:1",
                    serde_json::json!({ "phase": "tool_call" }),
                    (*id).into(),
                    (*at).into(),
                    now_ms(),
                );
            }
        }
        store
    }

    fn waiting_trace_read(since: &str) -> TraceHistoryRead {
        TraceHistoryRead {
            request_id: "request:1".into(),
            instance_id: "instance:1".into(),
            max_events: 500,
            max_bytes: None,
            since: Some(since.into()),
            before: None,
        }
    }

    async fn wait_for_fresh_trace(
        store: &std::sync::Arc<std::sync::Mutex<AgentHostTraceStore>>,
    ) -> (std::time::Instant, AgentHostTraceHistory) {
        let started = std::time::Instant::now();
        let history = wait_for_trace_history(
            store,
            &waiting_trace_read("2026-07-20T00:00:01Z"),
            Duration::from_secs(10),
        )
        .await;
        (started, history)
    }

    #[tokio::test]
    async fn a_waiting_delta_answers_as_soon_as_a_newer_event_lands() {
        let store = waiting_trace_store(&[("event:1", "2026-07-20T00:00:01Z")]);
        let recorder = store.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            recorder.lock().unwrap().record(
                "channel:1",
                serde_json::json!({ "phase": "tool_call" }),
                "event:2".into(),
                "2026-07-20T00:00:02Z".into(),
                now_ms(),
            );
        });
        let (started, history) = wait_for_fresh_trace(&store).await;
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "answered on the event, not the deadline"
        );
        let ids: Vec<_> = history
            .events
            .iter()
            .map(|event| event.id.as_str())
            .collect();
        assert_eq!(ids, ["event:2", "event:1"]);
    }

    #[tokio::test]
    async fn a_waiting_delta_treats_the_inclusive_watermark_as_baseline_and_times_out() {
        let store = waiting_trace_store(&[("event:1", "2026-07-20T00:00:01Z")]);
        let started = std::time::Instant::now();
        let history = wait_for_trace_history(
            &store,
            &waiting_trace_read("2026-07-20T00:00:01Z"),
            Duration::from_millis(200),
        )
        .await;
        assert!(
            started.elapsed() >= Duration::from_millis(200),
            "the watermark event is not news"
        );
        assert_eq!(history.availability, AgentHostTraceAvailability::Available);
        assert_eq!(history.events.len(), 1);
    }

    #[tokio::test]
    async fn a_waiting_delta_answers_when_the_session_ends() {
        let store = waiting_trace_store(&[("event:1", "2026-07-20T00:00:01Z")]);
        let terminator = store.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            terminator.lock().unwrap().terminate(None);
        });
        let (started, history) = wait_for_fresh_trace(&store).await;
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(history.availability, AgentHostTraceAvailability::Expired);
    }

    #[test]
    fn trace_waits_are_bounded_per_connection() {
        let waits = std::sync::atomic::AtomicUsize::new(0);
        for _ in 0..TRACE_HISTORY_MAX_WAITS {
            assert!(try_start_trace_wait(&waits));
        }
        assert!(!try_start_trace_wait(&waits));
    }
}
