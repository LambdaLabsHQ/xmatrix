use super::*;
use serde_json::json;

fn active() -> RuntimeIssueTracker {
    let mut tracker = RuntimeIssueTracker::default();
    tracker.observe_presence(None, Some("busy"), None, 1_000);
    tracker.observe_trace(
        "channel-1",
        &trace("turn_started", json!({"turnId":"turn-1"})),
        1_000,
    );
    tracker
}

fn trace(phase: &str, payload: Value) -> Value {
    json!({"schemaVersion":1,"phase":phase,"payload":payload})
}

fn retry() -> Value {
    trace(
        "runtime_event",
        json!({"category":"connection","status":"retrying"}),
    )
}

#[test]
fn retries_keep_the_first_time_and_only_execution_progress_recovers() {
    let mut tracker = active();
    tracker.observe_trace("channel-1", &retry(), 2_000);
    tracker.observe_trace("channel-1", &retry(), 3_000);
    assert_eq!(
        tracker.issue,
        Some(AgentRuntimeIssue {
            kind: AgentRuntimeIssueKind::Retrying,
            since_millis: 2_000
        })
    );
    tracker.observe_trace(
        "channel-1",
        &trace(
            "runtime_event",
            json!({"category":"thread","status":"info"}),
        ),
        4_000,
    );
    tracker.observe_presence(Some("busy"), Some("busy"), None, 5_000);
    tracker.observe_trace(
        "channel-1",
        &trace("turn_started", json!({"turnId":"turn-1"})),
        5_100,
    );
    tracker.observe_trace(
        "channel-1",
        &trace("assistant_delta", json!({"delta":""})),
        5_200,
    );
    tracker.observe_presence(
        Some("busy"),
        Some("busy"),
        Some(&AgentRuntimeState {
            waiting: Some(crate::protocol::AgentRuntimeWaiting {
                kind: "tool".into(),
                label: None,
                details: Vec::new(),
                since_millis: 5_250,
            }),
            ..Default::default()
        }),
        5_250,
    );
    assert!(tracker.issue.is_some());
    tracker.observe_trace(
        "channel-1",
        &trace("assistant_delta", json!({"delta":"answer"})),
        6_000,
    );
    assert!(tracker.issue.is_none());
}

#[test]
fn other_channels_and_old_turns_cannot_recover_or_replace_a_symptom() {
    let mut tracker = active();
    tracker.observe_trace("channel-1", &retry(), 2_000);
    for (channel, payload) in [
        ("channel-2", json!({"delta":"answer"})),
        ("channel-1", json!({"turnId":"old","delta":"answer"})),
    ] {
        tracker.observe_trace(channel, &trace("assistant_delta", payload), 3_000);
    }
    tracker.observe_trace("channel-2", &trace("turn_failed", json!({})), 4_000);
    assert_eq!(tracker.issue.unwrap().kind, AgentRuntimeIssueKind::Retrying);
}

#[test]
fn heartbeat_does_not_postpone_stall_but_waits_and_tools_do() {
    let mut tracker = active();
    tracker.tick(1_000 + NO_PROGRESS_MS - 1);
    assert!(tracker.issue.is_none());
    tracker.observe_presence(Some("busy"), Some("busy"), None, 1_000 + NO_PROGRESS_MS);
    tracker.tick(1_000 + NO_PROGRESS_MS);
    assert_eq!(
        tracker.issue.as_ref().unwrap().kind,
        AgentRuntimeIssueKind::Stalled
    );
    let wait = AgentRuntimeState {
        waiting: Some(crate::protocol::AgentRuntimeWaiting {
            kind: "tool".into(),
            label: None,
            details: Vec::new(),
            since_millis: 2_000,
        }),
        ..Default::default()
    };
    tracker.observe_presence(Some("busy"), Some("busy"), Some(&wait), 400_000);
    tracker.tick(900_000);
    assert!(tracker.issue.is_none());
    tracker.observe_presence(Some("busy"), Some("busy"), None, 900_000);
    tracker.tick(900_001);
    assert!(tracker.issue.is_none());
    tracker.observe_trace(
        "channel-1",
        &trace("tool_call_started", json!({"item":{"id":"tool-1"}})),
        901_000,
    );
    tracker.tick(901_000 + NO_PROGRESS_MS);
    assert!(tracker.issue.is_none());
    tracker.observe_trace(
        "channel-1",
        &trace("tool_result", json!({"item":{"tool_use_id":"tool-1"}})),
        1_300_000,
    );
    tracker.tick(1_300_000 + NO_PROGRESS_MS);
    assert_eq!(tracker.issue.unwrap().since_millis, 1_300_000);
}

#[test]
fn failure_survives_idle_until_new_work_and_cancel_is_not_failure() {
    let mut tracker = active();
    tracker.observe_failure(Some("channel-1"), 2_000);
    tracker.observe_presence(Some("busy"), Some("idle"), None, 3_000);
    tracker.tick(4_000_000);
    assert_eq!(
        tracker.issue.as_ref().unwrap().kind,
        AgentRuntimeIssueKind::Failed
    );
    tracker.observe_presence(Some("idle"), Some("busy"), None, 4_001_000);
    assert!(tracker.issue.is_none());
    tracker.observe_trace("channel-1", &retry(), 4_002_000);
    tracker.observe_trace("channel-1", &trace("turn_cancelled", json!({})), 4_003_000);
    tracker.tick(5_000_000);
    assert!(tracker.issue.is_none());
}

#[test]
fn malformed_metadata_and_model_error_text_do_not_create_a_failure() {
    let mut tracker = active();
    for event in [
        json!({"phase":"runtime_event","payload":{"category":"error","status":"failed"}}),
        trace(
            "assistant_delta",
            json!({"delta":"Connection failed: error sending request"}),
        ),
        trace(
            "runtime_event",
            json!({"category":"tool","status":"failed","itemId":"tool-1"}),
        ),
        trace(
            "runtime_event",
            json!({"category":"quota","status":"warning"}),
        ),
    ] {
        tracker.observe_trace("channel-1", &event, 2_000);
        assert!(tracker.issue.is_none());
    }
}

#[test]
fn acp_and_codex_tools_share_the_same_silence_exclusion() {
    for (start, end) in [
        (
            trace(
                "tool_call",
                json!({"update":{"toolCallId":"1","status":"pending"}}),
            ),
            trace(
                "tool_call_update",
                json!({"update":{"toolCallId":"1","status":"completed"}}),
            ),
        ),
        (
            trace(
                "runtime_event",
                json!({"category":"tool","status":"started","itemId":"1"}),
            ),
            trace(
                "runtime_event",
                json!({"category":"tool","status":"completed","itemId":"1"}),
            ),
        ),
    ] {
        let mut tracker = active();
        tracker.observe_trace("channel-1", &start, 2_000);
        tracker.tick(2_000 + NO_PROGRESS_MS);
        assert!(tracker.issue.is_none());
        tracker.observe_trace("channel-1", &end, 400_000);
        tracker.tick(400_000 + NO_PROGRESS_MS);
        assert_eq!(tracker.issue.unwrap().kind, AgentRuntimeIssueKind::Stalled);
    }
}

#[test]
fn an_uncorrelated_tool_suppresses_guesses_until_the_next_turn() {
    let mut tracker = active();
    tracker.observe_trace("channel-1", &trace("tool_call_started", json!({})), 2_000);
    tracker.tick(9_000_000);
    assert!(tracker.issue.is_none());
    tracker.observe_presence(Some("busy"), Some("idle"), None, 10_000_000);
    tracker.observe_presence(Some("idle"), Some("busy"), None, 10_001_000);
    tracker.tick(10_001_000 + NO_PROGRESS_MS);
    assert_eq!(tracker.issue.unwrap().kind, AgentRuntimeIssueKind::Stalled);
}

#[test]
fn advisories_never_change_execution_state_or_hide_a_retry() {
    let mut tracker = active();
    tracker.observe_trace("channel-1", &retry(), 2_000);
    tracker.observe_trace(
        "channel-1",
        &trace(
            "runtime_event",
            json!({"category":"notice","status":"error","summary":"PRIVATE_TEXT"}),
        ),
        3_000,
    );
    assert!(tracker.active);
    assert_eq!(
        tracker.issue.as_ref().unwrap().kind,
        AgentRuntimeIssueKind::Retrying
    );
    assert_eq!(tracker.notice.as_ref().unwrap().severity, "error");
    tracker.observe_trace(
        "channel-1",
        &trace("assistant_delta", json!({"delta":"answer"})),
        4_000,
    );
    assert!(tracker.issue.is_none());
    assert!(tracker.notice.is_some());
    tracker.observe_trace(
        "channel-1",
        &trace(
            "runtime_event",
            json!({"category":"notice","status":"info"}),
        ),
        5_000,
    );
    tracker.tick(65_000);
    assert!(tracker.notice.is_none());
}
