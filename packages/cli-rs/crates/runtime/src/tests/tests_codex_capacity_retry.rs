// Owning adapter boundary: real stdio events exercise terminal receipts,
// provider-managed retry, bounded recovery, and cancellation during backoff.
#[tokio::test]
async fn codex_capacity_recovers_with_original_settings_and_continuation() {
    for mode in ["codex-capacity-recover", "codex-capacity-terminal-only"] {
        let mut codex = initialized_codex_fixture(mode).await;
        let agent = test_serialized_agent(mode);
        let turn = tokio::time::timeout(
            Duration::from_secs(10),
            codex.submit_turn(CodexTurnRequest {
                model: Some("codex-fixture"),
                effort: Some("high"),
                developer_instructions: Some("keep this instruction"),
                ..CodexTurnRequest::new("original request", &agent)
            }),
        )
        .await
        .expect("capacity retry did not finish")
        .unwrap();
        assert!(!turn.failed);
        assert_eq!(turn.local_output, "capacity recovered");
        assert_eq!(
            codex
                .request("thread/goal/get", serde_json::json!({}))
                .await
                .unwrap()["capacityStarts"],
            2
        );
        codex.shutdown().await;
    }
}

#[tokio::test]
async fn codex_capacity_stops_after_three_retries() {
    let mut codex = initialized_codex_fixture("codex-capacity-exhausted").await;
    let agent = test_serialized_agent("capacity-exhausted");
    let turn = tokio::time::timeout(
        Duration::from_secs(65),
        codex.submit_turn(CodexTurnRequest::new("original request", &agent)),
    )
    .await
    .expect("capacity retry budget was unbounded")
    .unwrap();
    assert!(turn.failed);
    assert!(!turn.restart_after_turn);
    assert_eq!(
        turn.failure_detail.as_deref(),
        Some("Codex error: Selected model is at capacity. Please try a different model.")
    );
    assert_eq!(
        codex
            .request("thread/goal/get", serde_json::json!({}))
            .await
            .unwrap()["capacityStarts"],
        4
    );
    codex.shutdown().await;
}

#[tokio::test]
async fn codex_capacity_does_not_replay_work_or_compete_with_provider_retry() {
    for (mode, failed, restart) in [
        ("codex-capacity-progress", true, false),
        ("codex-capacity-other-error", true, false),
        ("codex-capacity-provider-retry", false, false),
        ("codex-capacity-no-terminal", true, true),
    ] {
        let mut codex = initialized_codex_fixture(mode).await;
        let agent = test_serialized_agent(mode);
        let turn = tokio::time::timeout(
            Duration::from_secs(13),
            codex.submit_turn(CodexTurnRequest::new("original request", &agent)),
        )
        .await
        .expect("capacity terminal receipt wait was unbounded")
        .unwrap();
        assert_eq!(turn.failed, failed, "{mode}");
        assert_eq!(turn.restart_after_turn, restart, "{mode}");
        assert_eq!(
            codex
                .request("thread/goal/get", serde_json::json!({}))
                .await
                .unwrap()["capacityStarts"],
            1,
            "{mode}"
        );
        codex.shutdown().await;
    }
}

#[tokio::test]
async fn codex_capacity_backoff_yields_to_new_message_and_shutdown() {
    for shutdown in [false, true] {
        let mut codex = initialized_codex_fixture("codex-capacity-recover").await;
        let event = if shutdown {
            AgentInstanceConnectionEvent::Server(AgentInstanceServerMessage::ShutdownRequested {
                reason: Some("stop during capacity backoff".to_string()),
            })
        } else {
            interrupting_channel_message_event("new-message", "chan-a", "continue now")
        };
        let mut events = test_event_after(
            Duration::from_millis(300),
            event,
            "interrupt capacity backoff",
        );
        let mut pending = VecDeque::new();
        let agent = test_serialized_agent("capacity-interrupt");
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            submit_old_codex_test_turn(&mut codex, &mut events, &mut pending, &agent),
        )
        .await
        .expect("capacity backoff blocked interruption");
        if shutdown {
            assert!(matches!(result, super::InterruptibleCodexTurn::Shutdown(_)));
        } else {
            assert!(matches!(result, super::InterruptibleCodexTurn::Interrupted));
            assert_eq!(pending.len(), 1);
        }
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
