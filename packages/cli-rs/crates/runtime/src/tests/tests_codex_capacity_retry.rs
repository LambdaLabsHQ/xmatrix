// Actual stdio and WebSocket boundaries: a host must follow a Hub permit,
// never start a local retry or accept a permit for different work.
async fn capacity_fixture_relay(
    mode: &'static str,
    agent: &SerializedAgent,
) -> (Arc<AgentInstanceConnectionClient>, TraceFixtureLog) {
    use futures_util::{SinkExt, StreamExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let frames: TraceFixtureLog = Arc::default();
    let recorded = frames.clone();
    let connected_agent = agent.clone();
    tokio::spawn(async move {
        let mut socket = trace_fixture_socket::registered_agent_socket(
            &listener,
            AgentInstanceServerMessage::AgentInstanceConnected {
                agent: connected_agent,
                peers: vec![],
                hub_capabilities: Some(vec!["agent_turn_retry".into()]),
            },
        )
        .await;
        let mut failures = 0;
        while let Some(Ok(message)) = socket.next().await {
            let Ok(text) = message.into_text() else {
                continue;
            };
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            recorded.lock().unwrap().push(value.clone());
            let response = if value["type"] == "ping" {
                Some(
                    serde_json::json!({"type":"pong", "requestId":value["requestId"], "ts":"2026-10-13T10:30:00Z"}),
                )
            } else if value["type"] == "agent_turn_retry" {
                if value["action"] == "failed" {
                    failures += 1;
                    if mode == "hold" {
                        continue;
                    }
                }
                let retry = value["action"] == "failed" && failures == 1 && mode != "stop";
                Some(serde_json::json!({
                    "type":"agent_turn_retry_decision", "requestId":value["requestId"],
                    "operationId": if mode == "wrong_scope" { serde_json::json!("other-operation") } else { value["operationId"].clone() },
                    "threadId":value["threadId"].as_str().unwrap_or("none"),
                    "turnId":value["turnId"].as_str().unwrap_or("none"),
                    "attemptToken":"hub-permit", "action":if retry {"retry"} else {"stop"},
                    "input":if retry {Some("Continue the previous request approved by Hub.")} else {None},
                    "reason":"exhausted",
                }))
            } else {
                None
            };
            if let Some(response) = response
                && socket
                    .send(tokio_tungstenite::tungstenite::Message::Text(
                        response.to_string().into(),
                    ))
                    .await
                    .is_err()
            {
                break;
            }
        }
    });
    let mut relay = AgentInstanceConnectionClient::new(
        format!("ws://{address}/ws/agent-instances"),
        "token".into(),
        "codex".into(),
        "codex".into(),
        None,
    );
    relay.set_runtime_capabilities(vec!["agent_turn_retry".into()]);
    relay.register().await.unwrap();
    (Arc::new(relay), frames)
}

#[tokio::test]
async fn codex_capacity_never_retries_without_hub_authority() {
    for mode in ["codex-capacity-recover", "codex-capacity-terminal-only"] {
        let mut codex = initialized_codex_fixture(mode).await;
        let agent = test_serialized_agent(mode);
        let turn = tokio::time::timeout(
            Duration::from_secs(2),
            codex.submit_turn(CodexTurnRequest::new("original request", &agent)),
        )
        .await
        .expect("host attempted autonomous recovery")
        .unwrap();
        assert!(turn.failed);
        assert_eq!(
            codex
                .request("thread/goal/get", serde_json::json!({}))
                .await
                .unwrap()["capacityStarts"],
            1
        );
        codex.shutdown().await;
    }
}

#[tokio::test]
async fn codex_capacity_follows_hub_input_and_retains_selected_settings() {
    let agent = test_serialized_agent("capacity");
    let (relay, frames) = capacity_fixture_relay("permit", &agent).await;
    let mut codex = initialized_codex_fixture("codex-capacity-hub-recover").await;
    let turn = tokio::time::timeout(
        Duration::from_secs(5),
        codex.submit_turn(CodexTurnRequest {
            trace_relay: Some(&relay),
            trace_channel_id: Some("channel-1"),
            model: Some("codex-fixture"),
            effort: Some("high"),
            developer_instructions: Some("preserve this"),
            ..CodexTurnRequest::new("original request", &agent)
        }),
    )
    .await
    .expect("host did not execute Hub permit")
    .unwrap();
    assert!(!turn.failed);
    assert_eq!(turn.local_output, "capacity recovered");
    let reports = frames.lock().unwrap().clone();
    let failed = reports
        .iter()
        .find(|r| r["type"] == "agent_turn_retry" && r["action"] == "failed")
        .unwrap();
    assert_eq!(failed["safeToContinue"], true);
    assert!(failed.get("attempt").is_none());
    assert!(failed.get("delayMs").is_none());
    assert_eq!(
        codex
            .request("thread/goal/get", serde_json::json!({}))
            .await
            .unwrap()["capacityStarts"],
        2
    );
    codex.shutdown().await;
    relay.disconnect();
}

#[tokio::test]
async fn codex_capacity_obeys_hub_stop_and_rejects_foreign_permits() {
    for mode in ["permit", "stop", "wrong_scope"] {
        let agent = test_serialized_agent("capacity");
        let (relay, _) = capacity_fixture_relay(mode, &agent).await;
        let mut codex = initialized_codex_fixture("codex-capacity-exhausted").await;
        let turn = tokio::time::timeout(
            Duration::from_secs(5),
            codex.submit_turn(CodexTurnRequest {
                trace_relay: Some(&relay),
                trace_channel_id: Some("channel-1"),
                ..CodexTurnRequest::new("original request", &agent)
            }),
        )
        .await
        .expect("host ignored Hub decision")
        .unwrap();
        assert!(turn.failed);
        assert_eq!(turn.failure_reported_by_hub, mode != "wrong_scope");
        assert_eq!(
            codex
                .request("thread/goal/get", serde_json::json!({}))
                .await
                .unwrap()["capacityStarts"],
            if mode == "permit" { 2 } else { 1 }
        );
        codex.shutdown().await;
        relay.disconnect();
    }
}

#[tokio::test]
async fn codex_capacity_wait_yields_to_new_message_and_shutdown() {
    for shutdown in [false, true] {
        let agent = test_serialized_agent("capacity");
        let (relay, frames) = capacity_fixture_relay("hold", &agent).await;
        let mut codex = initialized_codex_fixture("codex-capacity-recover").await;
        let event = if shutdown {
            AgentInstanceConnectionEvent::Server(AgentInstanceServerMessage::ShutdownRequested {
                reason: Some("stop".into()),
            })
        } else {
            interrupting_channel_message_event("new-message", "channel-1", "continue now")
        };
        let mut events = test_event_after(Duration::from_millis(300), event, "interrupt Hub wait");
        let mut pending = VecDeque::new();
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            super::submit_codex_turn_interruptible(
                &mut codex,
                &mut events,
                &mut pending,
                CodexTurnRequest {
                    trace_relay: Some(&relay),
                    trace_channel_id: Some("channel-1"),
                    ..CodexTurnRequest::new("original request", &agent)
                },
            ),
        )
        .await
        .expect("Hub wait blocked stop");
        assert!(if shutdown {
            matches!(result, super::InterruptibleCodexTurn::Shutdown(_))
        } else {
            matches!(result, super::InterruptibleCodexTurn::Interrupted)
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if frames
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|r| r["type"] == "agent_turn_retry" && r["action"] == "cancelled")
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("host did not notify Hub about cancelled wait");
        assert_eq!(
            codex
                .request("thread/goal/get", serde_json::json!({}))
                .await
                .unwrap()["capacityStarts"],
            1
        );
        codex.shutdown().await;
        relay.disconnect();
    }
}

#[tokio::test]
async fn codex_capacity_reports_safety_and_keeps_native_recovery_bounded() {
    for (mode, eligible, restart) in [
        ("codex-capacity-recover", Some(true), false),
        ("codex-capacity-progress", Some(false), false),
        ("codex-capacity-other-error", Some(true), false),
        ("codex-capacity-provider-retry", None, false),
        ("codex-capacity-no-terminal", None, false),
    ] {
        let mut codex = initialized_codex_fixture(mode).await;
        let agent = test_serialized_agent(mode);
        let mut offer = None;
        let turn = tokio::time::timeout(
            Duration::from_secs(13),
            codex.submit_turn_attempt(
                CodexTurnRequest::new("original request", &agent),
                &mut offer,
                true,
            ),
        )
        .await
        .expect("terminal wait was unbounded")
        .unwrap();
        assert_eq!(offer.map(|o| o.safe_to_continue), eligible, "{mode}");
        assert_eq!(turn.restart_after_turn, restart, "{mode}");
        if mode == "codex-capacity-no-terminal" {
            assert!(
                codex.child.try_wait().unwrap().is_some(),
                "uncertain provider must stop without autonomous resume"
            );
        } else {
            assert_eq!(
                codex
                    .request("thread/goal/get", serde_json::json!({}))
                    .await
                    .unwrap()["capacityStarts"],
                1
            );
        }
        codex.shutdown().await;
    }
}
