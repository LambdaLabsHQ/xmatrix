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
    let agent = test_serialized_agent("claude-test");
    let (_tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let mut events =
        crate::RunLoopEvents::new(rx, &relay, Some("channel"), &agent).without_termination();
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
