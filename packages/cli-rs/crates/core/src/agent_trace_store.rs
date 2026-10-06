use std::collections::{HashSet, VecDeque};
use std::sync::Arc;

use tokio::sync::Notify;

use serde::{Deserialize, Serialize};

use crate::protocol::SerializedAgent;

/// Retention: how much of one Instance's trace the host keeps readable.
pub const HOST_TRACE_MAX_EVENTS: usize = 5_000;
pub const HOST_TRACE_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const HOST_TRACE_MAX_AGE_MS: u64 = 24 * 60 * 60 * 1_000;
/// One event larger than this is dropped (and the history marked incomplete)
/// so any single event still fits one Hub page.
pub const HOST_TRACE_MAX_EVENT_BYTES: usize = 512 * 1024;
/// One page of a history read. Retention is paged through `before` cursors;
/// a page never exceeds these bounds, whatever the caller asks for.
pub const HOST_TRACE_PAGE_MAX_EVENTS: usize = 500;
pub const HOST_TRACE_PAGE_MAX_BYTES: usize = 512 * 1024;
const HOST_TRACE_TERMINAL_TOMBSTONES: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentHostTraceEvent {
    pub id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub workspace_user_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub channel_id: String,
    pub metadata: serde_json::Value,
    pub timestamp: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentHostTraceAvailability {
    Available,
    Unavailable,
    Expired,
}

impl AgentHostTraceAvailability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Unavailable => "unavailable",
            Self::Expired => "expired",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentHostTraceHistory {
    pub availability: AgentHostTraceAvailability,
    /// No older retained event remains and nothing was ever evicted.
    pub complete: bool,
    /// Newest first, ordered by (instant, id).
    pub events: Vec<AgentHostTraceEvent>,
    /// Pass back as `before` to read the next older page.
    pub next_cursor: Option<String>,
}

/// One page request. `since` bounds the newest side (inclusive), `before`
/// the oldest side (exclusive cursor from a previous page).
#[derive(Debug, Clone, Copy, Default)]
pub struct AgentHostTraceHistoryQuery<'a> {
    pub max_events: usize,
    pub max_bytes: Option<usize>,
    pub since: Option<&'a str>,
    pub before: Option<&'a str>,
}

#[derive(Debug, Clone)]
struct BoundTraceSession {
    instance_id: String,
    owner_user_id: String,
    agent_id: String,
    agent_name: String,
    agent_type: String,
}

#[derive(Debug, Clone)]
struct StoredTraceEvent {
    event: AgentHostTraceEvent,
    timestamp_epoch_nanos: i128,
    encoded_bytes: usize,
    recorded_at_ms: u64,
}

/// Process-local, session-scoped trace authority for one Agent Instance.
///
/// The store deliberately owns no cloud path. A transient network disconnect
/// does not touch it; only a real terminal transition clears the live binding.
/// TTL expiry clears the old history window but a still-live session can begin
/// a new suffix. Bounded eviction is explicit through `complete=false` so a
/// caller cannot mistake a retained suffix for complete history.
#[derive(Debug, Default)]
pub struct AgentHostTraceStore {
    session: Option<BoundTraceSession>,
    events: VecDeque<StoredTraceEvent>,
    encoded_bytes: usize,
    truncated: bool,
    history_expired: bool,
    terminal_instances: VecDeque<String>,
    terminal_instance_set: HashSet<String>,
    /// Woken whenever the readable history changes, so a waiting read can
    /// answer as soon as a new event lands.
    changed: Arc<Notify>,
}

impl AgentHostTraceStore {
    pub fn change_signal(&self) -> Arc<Notify> {
        self.changed.clone()
    }

    pub fn bind_session(&mut self, agent: &SerializedAgent, now_ms: u64) {
        let Some(instance_id) = non_empty(agent.instance_id.as_deref()) else {
            self.clear_active();
            return;
        };
        self.prune_expired(now_ms);
        if self
            .session
            .as_ref()
            .is_some_and(|session| session.instance_id == instance_id)
        {
            if let Some(session) = self.session.as_mut() {
                session.owner_user_id = agent.user_id.clone();
                session.agent_id = agent.id.clone();
                session.agent_name = agent.name.clone();
                session.agent_type = agent.agent_type.clone();
            }
            return;
        }

        self.clear_active();
        if self.terminal_instance_set.contains(instance_id) {
            return;
        }
        self.session = Some(BoundTraceSession {
            instance_id: instance_id.to_string(),
            owner_user_id: agent.user_id.clone(),
            agent_id: agent.id.clone(),
            agent_name: agent.name.clone(),
            agent_type: agent.agent_type.clone(),
        });
    }

    pub fn record(
        &mut self,
        channel_id: &str,
        payload: serde_json::Value,
        event_id: String,
        timestamp: String,
        now_ms: u64,
    ) {
        self.prune_expired(now_ms);
        let Some(session) = self.session.clone() else {
            return;
        };
        if self.history_expired {
            // TTL expiration ends only the previous retention window. The
            // live Agent Instance remains authoritative and may begin a new
            // bounded suffix, which must not claim whole-session completeness.
            self.history_expired = false;
            self.truncated = true;
        }
        let Some(channel_id) = non_empty(Some(channel_id)) else {
            self.truncated = true;
            return;
        };
        let payload = force_session_agent(payload, &session);
        let event = AgentHostTraceEvent {
            id: event_id,
            event_type: "event_published".to_string(),
            workspace_user_id: session.owner_user_id,
            agent_id: session.agent_id,
            agent_name: session.agent_name,
            channel_id: channel_id.to_string(),
            metadata: serde_json::json!({
                "eventType": "llm_trace",
                "payload": payload,
            }),
            timestamp,
        };
        let Some(timestamp_epoch_nanos) = trace_timestamp_epoch_nanos(&event.timestamp) else {
            self.truncated = true;
            return;
        };
        let Ok(encoded) = serde_json::to_vec(&event) else {
            self.truncated = true;
            return;
        };
        if encoded.len() > HOST_TRACE_MAX_EVENT_BYTES {
            self.truncated = true;
            return;
        }
        self.encoded_bytes = self.encoded_bytes.saturating_add(encoded.len());
        self.events.push_back(StoredTraceEvent {
            timestamp_epoch_nanos,
            event,
            encoded_bytes: encoded.len(),
            recorded_at_ms: now_ms,
        });
        while self.events.len() > HOST_TRACE_MAX_EVENTS || self.encoded_bytes > HOST_TRACE_MAX_BYTES
        {
            self.evict_oldest();
        }
        self.changed.notify_waiters();
    }

    pub fn history(
        &mut self,
        instance_id: &str,
        query: AgentHostTraceHistoryQuery<'_>,
        now_ms: u64,
    ) -> AgentHostTraceHistory {
        self.prune_expired(now_ms);
        if self.terminal_instance_set.contains(instance_id) {
            return empty_history(AgentHostTraceAvailability::Expired);
        }
        let Some(session) = self.session.as_ref() else {
            return empty_history(AgentHostTraceAvailability::Unavailable);
        };
        if session.instance_id != instance_id {
            return empty_history(AgentHostTraceAvailability::Unavailable);
        }
        if self.history_expired && self.events.is_empty() {
            return empty_history(AgentHostTraceAvailability::Expired);
        }
        let since = match query.since.map(trace_timestamp_epoch_nanos) {
            Some(None) => return empty_history(AgentHostTraceAvailability::Available),
            since => since.flatten(),
        };
        let before = match query.before.map(parse_trace_cursor) {
            Some(None) => return empty_history(AgentHostTraceAvailability::Available),
            before => before.flatten(),
        };
        let mut eligible = self
            .events
            .iter()
            .filter(|stored| {
                since.is_none_or(|waterline| stored.timestamp_epoch_nanos >= waterline)
            })
            .filter(|stored| {
                before.as_ref().is_none_or(|(timestamp, id)| {
                    (stored.timestamp_epoch_nanos, stored.event.id.as_str())
                        < (*timestamp, id.as_str())
                })
            })
            .collect::<Vec<_>>();
        eligible.sort_by(|left, right| {
            (right.timestamp_epoch_nanos, right.event.id.as_str())
                .cmp(&(left.timestamp_epoch_nanos, left.event.id.as_str()))
        });
        let max_events = query.max_events.clamp(1, HOST_TRACE_PAGE_MAX_EVENTS);
        let max_bytes = query
            .max_bytes
            .unwrap_or(HOST_TRACE_PAGE_MAX_BYTES)
            .clamp(1, HOST_TRACE_PAGE_MAX_BYTES);
        let mut page_bytes = 0usize;
        let mut page = Vec::new();
        for stored in &eligible {
            // The first event is always taken so a page can never stall.
            if page.len() >= max_events
                || (!page.is_empty() && page_bytes + stored.encoded_bytes > max_bytes)
            {
                break;
            }
            page_bytes += stored.encoded_bytes;
            page.push(*stored);
        }
        let next_cursor = (page.len() < eligible.len())
            .then(|| page.last().map(|stored| trace_cursor(&stored.event)))
            .flatten();
        AgentHostTraceHistory {
            availability: AgentHostTraceAvailability::Available,
            complete: !self.truncated && next_cursor.is_none(),
            events: page
                .into_iter()
                .map(|stored| stored.event.clone())
                .collect(),
            next_cursor,
        }
    }

    /// Reap trace payloads whose host-local retention window has elapsed.
    ///
    /// The connection host calls this on a timer so a silent or paused live
    /// session cannot keep payloads past their TTL merely because no bind,
    /// record, or history operation happens. Expiry deliberately preserves
    /// the live session binding so a resumed session may start a new suffix.
    pub fn reap_expired(&mut self, now_ms: u64) {
        self.prune_expired(now_ms);
    }

    pub fn terminate(&mut self, instance_id: Option<&str>) {
        let terminal_id = instance_id
            .and_then(|value| non_empty(Some(value)).map(str::to_string))
            .or_else(|| {
                self.session
                    .as_ref()
                    .map(|session| session.instance_id.clone())
            });
        self.clear_active();
        if let Some(instance_id) = terminal_id {
            self.remember_terminal(instance_id);
        }
        self.changed.notify_waiters();
    }

    pub fn current_instance_id(&self) -> Option<&str> {
        self.session
            .as_ref()
            .map(|session| session.instance_id.as_str())
    }

    #[cfg(test)]
    pub(crate) fn retained_event_count(&self) -> usize {
        self.events.len()
    }

    #[cfg(test)]
    pub(crate) fn has_expired_history(&self) -> bool {
        self.history_expired
    }

    fn prune_expired(&mut self, now_ms: u64) {
        let had_events = !self.events.is_empty();
        let mut expired_any = false;
        while self.events.front().is_some_and(|event| {
            now_ms.saturating_sub(event.recorded_at_ms) > HOST_TRACE_MAX_AGE_MS
        }) {
            self.evict_oldest();
            expired_any = true;
        }
        if had_events && expired_any && self.events.is_empty() {
            self.history_expired = true;
        }
    }

    fn evict_oldest(&mut self) {
        if let Some(event) = self.events.pop_front() {
            self.encoded_bytes = self.encoded_bytes.saturating_sub(event.encoded_bytes);
            self.truncated = true;
        }
    }

    fn clear_active(&mut self) {
        self.session = None;
        self.events.clear();
        self.encoded_bytes = 0;
        self.truncated = false;
        self.history_expired = false;
    }

    fn remember_terminal(&mut self, instance_id: String) {
        if !self.terminal_instance_set.insert(instance_id.clone()) {
            return;
        }
        self.terminal_instances.push_back(instance_id);
        while self.terminal_instances.len() > HOST_TRACE_TERMINAL_TOMBSTONES {
            if let Some(expired) = self.terminal_instances.pop_front() {
                self.terminal_instance_set.remove(&expired);
            }
        }
    }
}

pub fn trace_timestamp_now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn trace_timestamp_epoch_nanos(value: &str) -> Option<i128> {
    if !trace_timestamp_has_supported_rfc3339_shape(value) {
        return None;
    }
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .ok()
        .map(time::OffsetDateTime::unix_timestamp_nanos)
}

fn trace_timestamp_has_supported_rfc3339_shape(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || !matches!(bytes.get(10), Some(b'T' | b't'))
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
        || !bytes[..4]
            .iter()
            .chain(&bytes[5..7])
            .chain(&bytes[8..10])
            .chain(&bytes[11..13])
            .chain(&bytes[14..16])
            .chain(&bytes[17..19])
            .all(u8::is_ascii_digit)
        || bytes[17] > b'5'
    {
        return false;
    }

    let mut offset_start = 19;
    if bytes.get(offset_start) == Some(&b'.') {
        offset_start += 1;
        let fraction_start = offset_start;
        while bytes.get(offset_start).is_some_and(u8::is_ascii_digit) {
            offset_start += 1;
        }
        if !(1..=9).contains(&(offset_start - fraction_start)) {
            return false;
        }
    }

    match &bytes[offset_start..] {
        [b'Z' | b'z'] => true,
        [b'+' | b'-', h1, h2, b':', m1, m2] => [h1, h2, m1, m2]
            .into_iter()
            .all(|digit| digit.is_ascii_digit()),
        _ => false,
    }
}

/// A page cursor names the oldest event of the previous page. Hub derives the
/// same shape from any event it stops at, so both sides must agree on it.
fn trace_cursor(event: &AgentHostTraceEvent) -> String {
    format!("{}|{}", event.timestamp, event.id)
}

fn parse_trace_cursor(cursor: &str) -> Option<(i128, String)> {
    let (timestamp, id) = cursor.split_once('|')?;
    if id.is_empty() || id.len() > 160 {
        return None;
    }
    Some((trace_timestamp_epoch_nanos(timestamp)?, id.to_string()))
}

fn empty_history(availability: AgentHostTraceAvailability) -> AgentHostTraceHistory {
    AgentHostTraceHistory {
        availability,
        complete: false,
        events: Vec::new(),
        next_cursor: None,
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn force_session_agent(
    mut payload: serde_json::Value,
    session: &BoundTraceSession,
) -> serde_json::Value {
    let Some(record) = payload.as_object_mut() else {
        return payload;
    };
    let mut agent = record
        .get("agent")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default();
    agent.insert(
        "id".to_string(),
        serde_json::Value::String(session.agent_id.clone()),
    );
    agent.insert(
        "instanceId".to_string(),
        serde_json::Value::String(session.instance_id.clone()),
    );
    agent.insert(
        "runtimeInstanceId".to_string(),
        serde_json::Value::String(session.instance_id.clone()),
    );
    agent.insert(
        "name".to_string(),
        serde_json::Value::String(session.agent_name.clone()),
    );
    agent.insert(
        "type".to_string(),
        serde_json::Value::String(session.agent_type.clone()),
    );
    record.insert("agent".to_string(), serde_json::Value::Object(agent));
    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(instance_id: &str) -> SerializedAgent {
        SerializedAgent {
            id: "agent:owner:one".into(),
            user_id: "owner".into(),
            name: "codex".into(),
            email: "owner@example.com".into(),
            ..crate::agent_instance_connection::tests::trace_test_agent(instance_id)
        }
    }

    fn read(
        store: &mut AgentHostTraceStore,
        instance_id: &str,
        max_events: usize,
        since: Option<&str>,
        now_ms: u64,
    ) -> AgentHostTraceHistory {
        store.history(
            instance_id,
            AgentHostTraceHistoryQuery {
                max_events,
                since,
                ..Default::default()
            },
            now_ms,
        )
    }

    fn record(store: &mut AgentHostTraceStore, id: &str, now_ms: u64) {
        let timestamp = time::OffsetDateTime::from_unix_timestamp_nanos(
            1_784_505_600_000_000_000 + i128::from(now_ms) * 1_000_000,
        )
        .expect("test timestamp is in range")
        .format(&time::format_description::well_known::Rfc3339)
        .expect("test timestamp formats as RFC3339");
        record_at(store, id, &timestamp, now_ms);
    }

    fn record_at(store: &mut AgentHostTraceStore, id: &str, timestamp: &str, now_ms: u64) {
        store.record(
            "channel:one",
            serde_json::json!({
                "agent": { "id": "spoofed", "instanceId": "spoofed" },
                "payload": { "delta": id },
            }),
            id.into(),
            timestamp.into(),
            now_ms,
        );
    }

    fn one_event_trace_store() -> AgentHostTraceStore {
        let mut store = AgentHostTraceStore::default();
        store.bind_session(&agent("instance:one"), 0);
        record(&mut store, "event:one", 1_000);
        store
    }

    #[test]
    fn same_instance_reconnect_preserves_trace_but_replacement_drops_it() {
        let mut store = one_event_trace_store();

        store.bind_session(&agent("instance:one"), 2_000);
        let retained = read(&mut store, "instance:one", 500, None, 2_000);
        assert_eq!(retained.availability, AgentHostTraceAvailability::Available);
        assert_eq!(retained.events.len(), 1);
        assert_eq!(
            retained.events[0].metadata["payload"]["agent"]["id"],
            "agent:owner:one"
        );
        assert_eq!(
            retained.events[0].metadata["payload"]["agent"]["instanceId"],
            "instance:one"
        );

        store.bind_session(&agent("instance:two"), 3_000);
        assert_eq!(
            read(&mut store, "instance:one", 500, None, 3_000).availability,
            AgentHostTraceAvailability::Unavailable
        );
        assert!(
            read(&mut store, "instance:two", 500, None, 3_000)
                .events
                .is_empty()
        );
    }

    #[test]
    fn terminal_session_is_purged_and_cannot_be_rebound() {
        let mut store = one_event_trace_store();
        store.terminate(Some("instance:one"));

        let expired = read(&mut store, "instance:one", 500, None, 2_000);
        assert_eq!(expired.availability, AgentHostTraceAvailability::Expired);
        assert!(!expired.complete);
        assert!(expired.events.is_empty());

        store.bind_session(&agent("instance:one"), 3_000);
        assert_eq!(store.current_instance_id(), None);
        assert_eq!(
            read(&mut store, "instance:one", 500, None, 3_000).availability,
            AgentHostTraceAvailability::Expired
        );
    }

    fn page(
        store: &mut AgentHostTraceStore,
        max_events: usize,
        max_bytes: Option<usize>,
        before: Option<&str>,
        now_ms: u64,
    ) -> AgentHostTraceHistory {
        store.history(
            "instance:one",
            AgentHostTraceHistoryQuery {
                max_events,
                max_bytes,
                before,
                ..Default::default()
            },
            now_ms,
        )
    }

    fn walk(
        store: &mut AgentHostTraceStore,
        max_events: usize,
        max_bytes: Option<usize>,
        now_ms: u64,
    ) -> (Vec<String>, usize, bool) {
        let mut ids = Vec::new();
        let mut pages = 0;
        let mut cursor: Option<String> = None;
        loop {
            let history = page(store, max_events, max_bytes, cursor.as_deref(), now_ms);
            pages += 1;
            ids.extend(history.events.iter().map(|event| event.id.clone()));
            match history.next_cursor {
                Some(next) => {
                    assert!(
                        !history.complete,
                        "a page with an older cursor is not complete"
                    );
                    cursor = Some(next);
                }
                None => return (ids, pages, history.complete),
            }
        }
    }

    #[test]
    fn retention_eviction_is_bounded_and_never_claims_completeness() {
        let mut store = AgentHostTraceStore::default();
        store.bind_session(&agent("instance:one"), 0);
        for index in 0..=HOST_TRACE_MAX_EVENTS {
            record(&mut store, &format!("event:{index}"), index as u64 * 1_000);
        }
        let now_ms = HOST_TRACE_MAX_EVENTS as u64 * 1_000;
        let first = read(
            &mut store,
            "instance:one",
            HOST_TRACE_MAX_EVENTS,
            None,
            now_ms,
        );
        assert_eq!(
            first.events.len(),
            HOST_TRACE_PAGE_MAX_EVENTS,
            "one read is one page"
        );
        assert_eq!(
            first.events[0].id,
            format!("event:{}", HOST_TRACE_MAX_EVENTS)
        );

        let (ids, _, complete) = walk(&mut store, HOST_TRACE_PAGE_MAX_EVENTS, None, now_ms);
        assert_eq!(ids.len(), HOST_TRACE_MAX_EVENTS);
        assert_eq!(ids.last().map(String::as_str), Some("event:1"));
        assert!(!complete, "an evicted prefix is never complete");
    }

    #[test]
    fn pages_walk_every_retained_event_once_newest_first() {
        let mut store = AgentHostTraceStore::default();
        store.bind_session(&agent("instance:one"), 0);
        for index in 0..25 {
            record(&mut store, &format!("event:{index:02}"), 1_000 + index);
        }
        let (ids, pages, complete) = walk(&mut store, 10, None, 2_000);
        assert_eq!(pages, 3);
        assert!(
            complete,
            "nothing was evicted, so the oldest page closes the history"
        );
        let expected = (0..25)
            .rev()
            .map(|index| format!("event:{index:02}"))
            .collect::<Vec<_>>();
        assert_eq!(ids, expected);
    }

    #[test]
    fn a_page_respects_its_byte_budget_but_always_makes_progress() {
        let mut store = AgentHostTraceStore::default();
        store.bind_session(&agent("instance:one"), 0);
        for index in 0..6 {
            record(&mut store, &format!("event:{index}"), 1_000 + index);
        }
        let newest_two = store.events[4].encoded_bytes + store.events[5].encoded_bytes;
        let bounded = page(&mut store, 500, Some(newest_two), None, 2_000);
        assert_eq!(bounded.events.len(), 2);
        assert!(bounded.next_cursor.is_some());

        let (ids, pages, complete) = walk(&mut store, 500, Some(1), 2_000);
        assert_eq!(
            (ids.len(), pages),
            (6, 6),
            "a budget below one event still yields one per page"
        );
        assert!(complete);
    }

    #[test]
    fn cursor_breaks_timestamp_ties_by_event_id() {
        let mut store = AgentHostTraceStore::default();
        store.bind_session(&agent("instance:one"), 0);
        for id in ["event:c", "event:a", "event:d", "event:b"] {
            record_at(&mut store, id, "2026-07-20T00:00:00Z", 1_000);
        }
        let (ids, pages, complete) = walk(&mut store, 1, None, 1_000);
        assert_eq!(ids, vec!["event:d", "event:c", "event:b", "event:a"]);
        assert_eq!(pages, 4);
        assert!(complete);
    }

    #[test]
    fn invalid_cursor_fails_closed() {
        let mut store = one_event_trace_store();
        for cursor in [
            "no-separator",
            "not-a-time|event:one",
            "2026-07-20T00:00:00Z|",
        ] {
            let history = page(&mut store, 500, None, Some(cursor), 1_000);
            assert_eq!(history.availability, AgentHostTraceAvailability::Available);
            assert!(!history.complete);
            assert!(history.events.is_empty() && history.next_cursor.is_none());
        }
    }

    #[test]
    fn an_event_larger_than_one_page_is_dropped_as_incomplete() {
        let mut store = AgentHostTraceStore::default();
        store.bind_session(&agent("instance:one"), 0);
        store.record(
            "channel:one",
            serde_json::json!({ "output": "x".repeat(HOST_TRACE_MAX_EVENT_BYTES) }),
            "event:huge".into(),
            "2026-07-20T00:00:00Z".into(),
            1_000,
        );
        record(&mut store, "event:small", 1_000);
        let history = read(&mut store, "instance:one", 500, None, 1_000);
        assert_eq!(history.events.len(), 1);
        assert!(!history.complete);
    }

    #[test]
    fn caller_limit_never_claims_complete_history() {
        let mut store = one_event_trace_store();
        record(&mut store, "event:two", 2_000);

        let history = read(&mut store, "instance:one", 1, None, 2_000);
        assert_eq!(history.events.len(), 1);
        assert!(!history.complete);
    }

    #[test]
    fn since_filter_uses_instant_order_with_an_inclusive_boundary() {
        let mut store = AgentHostTraceStore::default();
        store.bind_session(&agent("instance:one"), 0);
        record_at(
            &mut store,
            "event:before-offset",
            "2026-07-20T01:00:00.100000000+02:00",
            1_000,
        );
        record_at(
            &mut store,
            "event:equal-offset",
            "2026-07-19T19:00:00.100000000-05:00",
            2_000,
        );
        record_at(
            &mut store,
            "event:equal-precision",
            "2026-07-20T00:00:00.100000000Z",
            3_000,
        );
        record_at(
            &mut store,
            "event:after-submillisecond",
            "2026-07-20T00:00:00.100000001Z",
            4_000,
        );
        record_at(
            &mut store,
            "event:before-submillisecond",
            "2026-07-20T00:00:00.099999999Z",
            5_000,
        );

        let history = read(
            &mut store,
            "instance:one",
            HOST_TRACE_MAX_EVENTS,
            Some("2026-07-20T00:00:00.1Z"),
            5_000,
        );

        assert_eq!(history.availability, AgentHostTraceAvailability::Available);
        assert!(history.complete);
        assert_eq!(
            history
                .events
                .iter()
                .map(|event| event.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "event:after-submillisecond",
                "event:equal-precision",
                "event:equal-offset",
            ]
        );
    }

    #[test]
    fn invalid_since_fails_closed_without_changing_host_availability() {
        let mut store = one_event_trace_store();

        let history = read(
            &mut store,
            "instance:one",
            HOST_TRACE_MAX_EVENTS,
            Some("not-a-timestamp"),
            1_000,
        );

        assert_eq!(history.availability, AgentHostTraceAvailability::Available);
        assert!(!history.complete);
        assert!(history.events.is_empty());
    }

    #[test]
    fn trace_timestamps_use_the_bounded_rfc3339_nanosecond_profile() {
        assert_eq!(
            trace_timestamp_epoch_nanos("2026-07-20T00:00:00.1Z"),
            trace_timestamp_epoch_nanos("2026-07-19t19:00:00.100000000-05:00")
        );
        assert!(trace_timestamp_epoch_nanos("2026-07-20T00:00:00.123456789Z").is_some());

        for invalid in [
            "2026-07-20",
            "2026-07-20 00:00:00Z",
            "2026-07-20T00:00:00+0000",
            "2026-07-20T00:00:00.1234567890Z",
            "2026-07-20T00:00:60Z",
            "2026-02-30T00:00:00Z",
        ] {
            assert_eq!(
                trace_timestamp_epoch_nanos(invalid),
                None,
                "unexpectedly accepted {invalid}"
            );
        }
    }

    #[test]
    fn invalid_record_timestamp_is_not_retained_or_reported_complete() {
        let mut store = AgentHostTraceStore::default();
        store.bind_session(&agent("instance:one"), 0);
        record_at(
            &mut store,
            "event:invalid",
            "2026-07-20T00:00:00.1234567890Z",
            1_000,
        );

        for since in [None, Some("2026-07-20T00:00:00Z")] {
            let history = read(
                &mut store,
                "instance:one",
                HOST_TRACE_MAX_EVENTS,
                since,
                1_000,
            );
            assert_eq!(history.availability, AgentHostTraceAvailability::Available);
            assert!(!history.complete);
            assert!(history.events.is_empty());
        }
    }

    #[test]
    fn ttl_eviction_expires_history_without_terminating_the_live_session() {
        let mut store = one_event_trace_store();

        let history = read(
            &mut store,
            "instance:one",
            HOST_TRACE_MAX_EVENTS,
            None,
            1_000 + HOST_TRACE_MAX_AGE_MS + 1,
        );
        assert_eq!(history.availability, AgentHostTraceAvailability::Expired);
        assert!(!history.complete);
        assert!(history.events.is_empty());
        assert_eq!(store.current_instance_id(), Some("instance:one"));

        record(&mut store, "event:two", 1_000 + HOST_TRACE_MAX_AGE_MS + 2);
        let restarted = read(
            &mut store,
            "instance:one",
            HOST_TRACE_MAX_EVENTS,
            None,
            1_000 + HOST_TRACE_MAX_AGE_MS + 2,
        );
        assert_eq!(
            restarted.availability,
            AgentHostTraceAvailability::Available
        );
        assert_eq!(restarted.events.len(), 1);
        assert_eq!(restarted.events[0].id, "event:two");
        assert!(!restarted.complete);
    }

    #[test]
    fn active_reap_expires_silent_history_without_unbinding_the_session() {
        let mut store = one_event_trace_store();

        store.reap_expired(1_000 + HOST_TRACE_MAX_AGE_MS + 1);

        assert_eq!(store.retained_event_count(), 0);
        assert!(store.has_expired_history());
        assert_eq!(store.current_instance_id(), Some("instance:one"));
    }
}
