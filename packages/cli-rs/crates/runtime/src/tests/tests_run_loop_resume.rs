/// A runtime that accepts any switch, so these tests exercise only the run
/// loop's decision of what comes next.
struct SwitchAcceptingRuntime;

impl crate::ChannelControlledRuntime for SwitchAcceptingRuntime {
    async fn request_model_switch(&mut self, requested: &str) -> Result<String, String> {
        Ok(requested.to_string())
    }

    async fn request_effort_switch(&mut self, requested: &str) -> Result<String, String> {
        Ok(requested.to_string())
    }

    fn switch_presence(&self) -> crate::PresencePatch {
        crate::PresencePatch::usage(None)
    }

    async fn parameter_control(
        &mut self,
        _command: crate::harness_parameters::ParameterCommand,
        _message: &crate::InboundChannelMessage,
        _agent: &SerializedAgent,
    ) -> Result<String, String> {
        Err("unused".to_string())
    }

    fn parameter_presence(&self) -> crate::PresencePatch {
        crate::PresencePatch::usage(None)
    }

    fn parameter_catalog(&self) -> Vec<crate::protocol::HarnessParameter> {
        Vec::new()
    }
}

fn model_switch_event(model: &str) -> AgentInstanceConnectionEvent {
    AgentInstanceConnectionEvent::Server(AgentInstanceServerMessage::AgentModelSwitchRequested {
        request_id: format!("req-{model}"),
        model: model.to_string(),
    })
}

fn effort_switch_event(effort: &str) -> AgentInstanceConnectionEvent {
    AgentInstanceConnectionEvent::Server(AgentInstanceServerMessage::AgentEffortSwitchRequested {
        request_id: format!("req-{effort}"),
        effort: effort.to_string(),
    })
}

/// The first two inputs a run loop takes once its last turn ended the given
/// way with `queued` waiting; `None` where it would wait for more input.
async fn run_loop_inputs_after_turn(
    turn_interrupted: bool,
    queued: Vec<AgentInstanceConnectionEvent>,
) -> [Option<crate::RunLoopInput>; 2] {
    let relay = AgentInstanceConnectionClient::new(
        "ws://127.0.0.1:9/ws".into(),
        "token".into(),
        "claude-test".into(),
        "claude_code".into(),
        None,
    );
    run_loop_inputs(&relay, turn_interrupted, queued).await
}

/// The first two inputs a run loop on `relay` takes after its last turn.
async fn run_loop_inputs(
    relay: &AgentInstanceConnectionClient,
    turn_interrupted: bool,
    queued: Vec<AgentInstanceConnectionEvent>,
) -> [Option<crate::RunLoopInput>; 2] {
    let agent = test_serialized_agent("claude-test");
    let (_tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let mut events =
        crate::RunLoopEvents::new(rx, relay, Some("channel"), &agent).without_termination();
    events.pending.extend(queued);
    events.turn_ended("channel", turn_interrupted);
    let mut inputs = [None, None];
    for input in &mut inputs {
        *input = tokio::time::timeout(
            Duration::from_millis(200),
            events.next_input(&mut SwitchAcceptingRuntime),
        )
        .await
        .ok()
        .flatten();
    }
    inputs
}

#[tokio::test]
async fn a_switch_that_cancelled_a_turn_resumes_it_on_the_new_selection() {
    let [first, second] = run_loop_inputs_after_turn(true, vec![model_switch_event("sonnet")]).await;
    let Some(crate::RunLoopInput::Resume { channel_id, prompt }) = first else {
        panic!("expected the cancelled turn to resume");
    };
    assert_eq!(channel_id, "channel");
    assert!(prompt.contains("model `sonnet`"), "{prompt}");
    assert!(prompt.contains("no person interrupted or rejected"), "{prompt}");
    // Resumed once: the loop then waits for input again.
    assert!(second.is_none());
}

#[tokio::test]
async fn a_switch_queued_behind_another_lands_before_the_work_resumes() {
    let [first, _] = run_loop_inputs_after_turn(
        true,
        vec![model_switch_event("opus"), effort_switch_event("high")],
    )
    .await;
    let Some(crate::RunLoopInput::Resume { prompt, .. }) = first else {
        panic!("expected one resume after both switches");
    };
    assert!(prompt.contains("model `opus` and effort `high`"), "{prompt}");
}

#[tokio::test]
async fn a_switch_between_turns_resumes_nothing() {
    let [first, _] = run_loop_inputs_after_turn(false, vec![model_switch_event("sonnet")]).await;
    assert!(first.is_none());
}

#[tokio::test]
async fn a_newer_message_is_the_next_turn_instead_of_a_resume() {
    let [first, second] = run_loop_inputs_after_turn(
        true,
        vec![
            model_switch_event("sonnet"),
            channel_message_event("m1", "channel", "do this instead"),
        ],
    )
    .await;
    assert!(matches!(first, Some(crate::RunLoopInput::Delivery { .. })));
    assert!(second.is_none());
}

/// A relay registered with a Hub that decides switch continuations, and the
/// frames the run loop sends it. The Hub answers a switch that cancelled a
/// turn with its continuation instruction, over the socket.
async fn continuation_hub_relay() -> (AgentInstanceConnectionClient, TraceFixtureLog) {
    use futures_util::{SinkExt as _, StreamExt as _};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws/agent-instances", listener.local_addr().unwrap());
    let sent: TraceFixtureLog = Arc::default();
    let log = sent.clone();
    let agent = test_serialized_agent("claude-test");
    tokio::spawn(async move {
        let connected = AgentInstanceServerMessage::AgentInstanceConnected {
            agent,
            peers: Vec::new(),
            hub_capabilities: Some(vec!["switch_continuation".into()]),
        };
        let (mut hub, mut frames) = trace_fixture_socket::registered_agent_socket(&listener, connected)
            .await
            .split();
        while let Some(Ok(frame)) = frames.next().await {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&frame.into_text().unwrap_or_default()) else {
                continue;
            };
            log.lock().unwrap().push(value.clone());
            if value["type"] == "agent_model_switch_result" && value["interruptedTurn"] == true {
                let AgentInstanceConnectionEvent::Server(instruction) =
                    continuation_event(9, &[value["requestId"].as_str().unwrap()])
                else {
                    unreachable!()
                };
                let text = serde_json::to_string(&instruction).unwrap();
                let _ = hub.send(tokio_tungstenite::tungstenite::Message::Text(text.into())).await;
            }
        }
    });
    let mut relay = AgentInstanceConnectionClient::new(
        url,
        "token".into(),
        "claude-test".into(),
        "claude_code".into(),
        None,
    );
    relay.register().await.unwrap();
    (relay, sent)
}

/// The Hub's committed instruction to continue the turn `switches` cancelled.
fn continuation_event(sequence: u64, switches: &[&str]) -> AgentInstanceConnectionEvent {
    AgentInstanceConnectionEvent::Server(
        serde_json::from_value(serde_json::json!({
            "type": "channel_message_received",
            "deliveryIntent": "context",
            "message": {
                "messageId": format!("continuation-{sequence}"), "channelId": "channel", "sequence": sequence,
                "from": { "kind": "system", "label": "xMatrix", "userId": "owner", "email": "" },
                "body": "[xMatrix] Hub-worded continuation", "sentAt": "2026-10-14T11:30:00.000Z",
                "metadata": { "xmatrixProvenance": "system_fact", "xmatrixSystemNotice": true,
                    "xmatrixSwitchContinuation": { "version": 1, "instanceId": "inst-claude-test", "requestIds": switches } },
            },
        }))
        .unwrap(),
    )
}

async fn inputs_with_hub_continuation(
    queued: Vec<AgentInstanceConnectionEvent>,
) -> ([Option<crate::RunLoopInput>; 2], TraceFixtureLog) {
    let (relay, sent) = continuation_hub_relay().await;
    (run_loop_inputs(&relay, true, queued).await, sent)
}

#[tokio::test]
async fn a_hub_that_decides_continuations_is_told_and_its_instruction_resumes_the_turn() {
    let ([first, second], sent) =
        inputs_with_hub_continuation(vec![model_switch_event("sonnet"), continuation_event(2, &["req-sonnet"])])
            .await;
    let Some(crate::RunLoopInput::Resume { channel_id, prompt }) = first else {
        panic!("expected the Hub's continuation to resume the turn");
    };
    assert_eq!(channel_id, "channel");
    assert_eq!(prompt, "[xMatrix] Hub-worded continuation", "the Hub words the input");
    assert!(second.is_none(), "resumed once, with no local resume of its own");
    let reported = sent.lock().unwrap().clone();
    assert!(reported.iter().any(|frame| frame["type"] == "agent_model_switch_result"
        && frame["interruptedTurn"] == true));
}

#[tokio::test]
async fn a_newer_message_supersedes_the_hubs_continuation() {
    let ([first, second], _) = inputs_with_hub_continuation(vec![
        model_switch_event("sonnet"),
        channel_message_event("m1", "channel", "do this instead"),
        continuation_event(3, &["req-sonnet"]),
    ])
    .await;
    assert!(matches!(first, Some(crate::RunLoopInput::Delivery { .. })));
    assert!(second.is_none(), "the continuation is acknowledged and dropped");
}

#[tokio::test]
async fn a_continuation_for_another_switch_runs_nothing() {
    let ([first, _], _) =
        inputs_with_hub_continuation(vec![model_switch_event("sonnet"), continuation_event(2, &["req-other"])])
            .await;
    assert!(first.is_none());
}

#[tokio::test]
async fn the_hubs_continuation_reaches_the_run_loop_over_the_socket() {
    let (mut relay, _) = continuation_hub_relay().await;
    let rx = relay.event_rx.take().expect("event receiver");
    let agent = test_serialized_agent("claude-test");
    let mut events =
        crate::RunLoopEvents::new(rx, &relay, Some("channel"), &agent).without_termination();
    events.pending.push_back(model_switch_event("sonnet"));
    events.turn_ended("channel", true);
    let input = tokio::time::timeout(
        Duration::from_secs(5),
        events.next_input(&mut SwitchAcceptingRuntime),
    )
    .await
    .expect("the Hub's continuation arrives");
    // Delivered as context like any system fact, it is not dropped: it names
    // this Instance and the switch that cancelled its turn.
    let Some(crate::RunLoopInput::Resume { prompt, .. }) = input else {
        panic!("expected the Hub's continuation to resume the turn");
    };
    assert_eq!(prompt, "[xMatrix] Hub-worded continuation");
}
