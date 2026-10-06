// Subagent frames, wrapper interrupts and per-turn images on the Claude
// stream path. The fake Claude replays stream-json shapes captured from
// Claude Code 2.1.280 (haiku, background Agent tool + `interrupt` control
// request), trimmed to the fields the runtime reads.

/// Main thread spawns a background subagent; the subagent's own frames carry
/// `parent_tool_use_id` = the Agent tool_use id. The last sentence is the one
/// that leaked to the channel in prod.
const CLAUDE_SUBAGENT_FRAMES: &str = r#"root="$1"
emit() { printf '%s\n' "$1"; }
read_user || exit 0
touch "$root/turn-open"
emit '{"type":"system","subtype":"init","session_id":"s1","model":"claude-main"}'
emit '{"type":"assistant","message":{"id":"m1","role":"assistant","model":"claude-main","content":[{"type":"tool_use","id":"toolu_A","name":"Agent","input":{"run_in_background":true,"prompt":"work"}}]},"parent_tool_use_id":null,"session_id":"s1"}'
emit '{"type":"system","subtype":"task_started","task_id":"t1","tool_use_id":"toolu_A","is_backgrounded":true,"session_id":"s1"}'
emit '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_A","content":"Async agent launched successfully."}]},"parent_tool_use_id":null,"session_id":"s1"}'
emit '{"type":"assistant","message":{"id":"sub1","role":"assistant","model":"claude-sub","content":[{"type":"text","text":"Control confirmed. Commit DB + CLI step."}]},"parent_tool_use_id":"toolu_A","session_id":"s1"}'
emit '{"type":"assistant","message":{"id":"sub2","role":"assistant","model":"claude-sub","content":[{"type":"tool_use","id":"toolu_S","name":"Bash","input":{"command":"true"}}]},"parent_tool_use_id":"toolu_A","session_id":"s1"}'
"#;

/// The rest of an interrupted turn, exactly as 2.1.280 answers `interrupt`:
/// control_response, the subagent stopped, a main-thread
/// "[Request interrupted by user]", then an is_error result with no `result`
/// text, and the stopped subagent's trailing frame after it.
const CLAUDE_INTERRUPT_ANSWER: &str = r#"IFS= read -r line || exit 0
rid=$(printf '%s' "$line" | sed 's/.*"request_id":"\([^"]*\)".*/\1/')
emit "{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"request_id\":\"$rid\",\"response\":{\"still_queued\":[]}}}"
emit '{"type":"system","subtype":"task_notification","task_id":"t1","tool_use_id":"toolu_A","status":"stopped","summary":"bg","session_id":"s1"}'
emit '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"parent_tool_use_id":null,"session_id":"s1"}'
emit '{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming","stop_reason":"tool_use","errors":["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],"session_id":"s1"}'
emit '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]},"parent_tool_use_id":"toolu_A","session_id":"s1"}'
sleep 30
"#;

const CLAUDE_LEAKED_SUBAGENT_TEXT: &str = "Control confirmed";

fn claude_turn_failure_frame(frame: &serde_json::Value) -> bool {
    frame["reason"] == "turn_failed"
}

fn claude_turn_trace(event: &serde_json::Value, phase: &str) -> bool {
    event["channelId"] == "channel-1" && event["metadata"]["payload"]["phase"] == phase
}

impl ClaudeCliTurnFixture {
    /// One full channel turn through `run_claude_stream_turn`, with `events`
    /// arriving on the relay while it runs (after the fake read the turn).
    async fn run_channel_turn(
        &mut self,
        attachments: Option<Vec<ChannelAttachment>>,
        local_image_paths: Option<Vec<PathBuf>>,
        events: Vec<AgentInstanceConnectionEvent>,
    ) -> VecDeque<AgentInstanceConnectionEvent> {
        let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
        let marker = self.root.join("turn-open");
        let patience = self.patience;
        let feeder = tokio::spawn(async move {
            let deadline = std::time::Instant::now() + patience;
            while !marker.exists() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "fake never read the turn"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            for event in events {
                event_tx.send(event).expect("queue relay event");
            }
            // Keep the sender alive until the turn is over.
            tokio::time::sleep(patience * 2).await;
        });
        let mut pending_events = VecDeque::new();
        tokio::time::timeout(
            self.patience * 2,
            crate::runtime_claude_turn::run_claude_stream_turn(
                &mut self.session,
                "do the work".to_string(),
                attachments,
                local_image_paths,
                "channel-1".to_string(),
                None,
                None,
                &self.relay,
                &self.agent,
                true,
                true,
                None,
                &mut event_rx,
                &mut pending_events,
            ),
        )
        .await
        .expect("channel turn finishes");
        feeder.abort();
        pending_events
    }
}

#[tokio::test]
async fn claude_subagent_text_is_never_the_turn_answer() {
    // A success result without `result` text falls back to the streamed
    // narration: the subagent's narration is not part of it.
    let mut fixture = ClaudeCliTurnFixture::start(&format!(
        "{CLAUDE_SUBAGENT_FRAMES}emit '{{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"session_id\":\"s1\"}}'\nsleep 30\n"
    ))
    .await;
    let outcome = fixture.submit("do the work").await;
    assert!(matches!(outcome.status, ClaudeTurnStatus::Completed));
    assert_eq!(outcome.answer, "");
    // A subagent's model is not the session's model.
    assert_eq!(
        fixture.session.presentation().current_model.as_deref(),
        Some("claude-main")
    );
    fixture.finish().await;
}

#[tokio::test]
async fn claude_genuine_failure_still_surfaces_without_subagent_text() {
    // Positive control for the interrupt test below: with no wrapper
    // interrupt, an error result is a failure and reaches the channel as a
    // turn_failed lifecycle, naming Claude's error and not the subagent.
    let mut fixture = ClaudeCliTurnFixture::start(&format!(
        "{CLAUDE_SUBAGENT_FRAMES}emit '{{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"errors\":[\"API Error: 500\"],\"session_id\":\"s1\"}}'\nsleep 30\n"
    ))
    .await;
    fixture.run_channel_turn(None, None, Vec::new()).await;
    let failure = fixture.wait_for(0, claude_turn_failure_frame).await;
    let frame = fixture.frames.lock().unwrap()[failure].clone();
    assert_eq!(frame["detail"], "error_during_execution: API Error: 500");
    let failed = fixture
        .wait_for_trace(0, |event| claude_turn_trace(event, "turn_failed"))
        .await;
    let traces = fixture.traces.lock().unwrap()[..=failed].to_vec();
    assert!(
        !serde_json::Value::from(traces.clone())
            .to_string()
            .contains(CLAUDE_LEAKED_SUBAGENT_TEXT),
        "subagent text reached the trace: {traces:#?}"
    );
    fixture.finish().await;
}

#[tokio::test]
async fn claude_wrapper_interrupt_is_cancelled_not_a_turn_failure() {
    let mut fixture = ClaudeCliTurnFixture::start(&format!(
        "{CLAUDE_SUBAGENT_FRAMES}{CLAUDE_INTERRUPT_ANSWER}"
    ))
    .await;
    let mut pending = fixture
        .run_channel_turn(
            None,
            None,
            vec![interrupting_channel_message_event(
                "m-newer",
                "channel-1",
                "a newer message",
            )],
        )
        .await;

    // The superseding message is queued for the next turn.
    assert!(matches!(
        pending.pop_front(),
        Some(AgentInstanceConnectionEvent::Server(
            AgentInstanceServerMessage::ChannelMessageReceived { message, .. }
        )) if message.message_id == "m-newer"
    ));
    // The turn closes as cancelled...
    let cancelled = fixture
        .wait_for_trace(0, |event| claude_turn_trace(event, "turn_cancelled"))
        .await;
    let traces = fixture.traces.lock().unwrap()[..=cancelled].to_vec();
    assert_eq!(
        traces[cancelled]["metadata"]["payload"]["payload"]["executionState"],
        "interrupted"
    );
    // ...with no failure trace, no subagent text, and no abort diagnostics.
    let rendered = serde_json::Value::from(traces.clone()).to_string();
    assert!(
        !traces
            .iter()
            .any(|event| claude_turn_trace(event, "turn_failed")),
        "{traces:#?}"
    );
    assert!(
        !rendered.contains(CLAUDE_LEAKED_SUBAGENT_TEXT),
        "{traces:#?}"
    );
    assert!(!rendered.contains("ede_diagnostic"), "{traces:#?}");
    // Nothing tells the channel the turn could not complete. The idle
    // presence is sent after the turn's last frame, so by then any failure
    // lifecycle would already be recorded.
    fixture
        .wait_for(0, |frame| claude_cli_turn_presence(frame, "idle"))
        .await;
    let frames = fixture.frames.lock().unwrap().clone();
    assert!(
        !frames.iter().any(claude_turn_failure_frame),
        "an interrupt was reported as a turn failure: {frames:#?}"
    );
    assert!(
        !serde_json::Value::from(frames.clone())
            .to_string()
            .contains(CLAUDE_LEAKED_SUBAGENT_TEXT),
        "{frames:#?}"
    );
    fixture.finish().await;
}

#[test]
fn claude_result_status_distinguishes_wrapper_interrupts() {
    assert!(matches!(
        ClaudeTurnStatus::for_result(true, true, false),
        ClaudeTurnStatus::Interrupted
    ));
    assert!(matches!(
        ClaudeTurnStatus::for_result(true, false, false),
        ClaudeTurnStatus::Failed
    ));
    // A turn that finished before the interrupt landed stays a success.
    assert!(matches!(
        ClaudeTurnStatus::for_result(false, true, false),
        ClaudeTurnStatus::Completed
    ));
    // An exhausted context window fails even when an interrupt raced it.
    assert!(matches!(
        ClaudeTurnStatus::for_result(true, true, true),
        ClaudeTurnStatus::Failed
    ));
}

#[test]
fn claude_subagent_frames_are_recognized_by_parent_tool_use_id() {
    use crate::runtime_claude_messages::claude_frame_is_subagent;
    assert!(claude_frame_is_subagent(
        &serde_json::json!({ "type": "assistant", "parent_tool_use_id": "toolu_A" })
    ));
    assert!(!claude_frame_is_subagent(
        &serde_json::json!({ "type": "assistant", "parent_tool_use_id": null })
    ));
    assert!(!claude_frame_is_subagent(
        &serde_json::json!({ "type": "result" })
    ));
}

fn claude_turn_image_attachment() -> ChannelAttachment {
    // Eight bytes; `size` matches so the authority length check passes.
    ChannelAttachment {
        id: format!("att-{}", uuid::Uuid::new_v4()),
        kind: "image".to_string(),
        name: "image.png".to_string(),
        mime_type: "image/png".to_string(),
        size: 8,
        channel_id: None,
        message_id: None,
        data_url: "data:image/png;base64,iVBORw0KGgo=".to_string(),
        url: None,
    }
}

#[test]
fn claude_turn_image_paths_must_be_this_turns_files() {
    use crate::runtime_claude_turn::claude_turn_image_paths_usable;
    let dir = std::env::temp_dir().join(format!("xmatrix-claude-images-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let live = dir.join("live.png");
    std::fs::write(&live, b"png").unwrap();
    let gone = dir.join("gone.png");
    let attachments = vec![claude_turn_image_attachment()];

    assert!(claude_turn_image_paths_usable(
        Some(&attachments),
        std::slice::from_ref(&live)
    ));
    // A file removed since it was written.
    assert!(!claude_turn_image_paths_usable(
        Some(&attachments),
        std::slice::from_ref(&gone)
    ));
    // Earlier turns' images ahead of this turn's (the old cumulative list).
    assert!(!claude_turn_image_paths_usable(
        Some(&attachments),
        &[live.clone(), live.clone()]
    ));
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn claude_turn_rematerializes_a_missing_image_and_keeps_callers_files() {
    // The fake records the user line it was sent.
    let mut fixture = ClaudeCliTurnFixture::start(
        r#"root="$1"
while IFS= read -r line; do
  printf '%s\n' "$line" > "$root/user-line"
  touch "$root/turn-open"
  printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"SEEN","session_id":"s1"}'
done
"#,
    )
    .await;
    let attachment = claude_turn_image_attachment();

    // The path handed in was deleted before the turn was built (prod: an
    // earlier turn's file, removed when that turn ended).
    let gone = fixture.root.join("xmatrix-attachment-gone.png");
    fixture
        .run_channel_turn(Some(vec![attachment.clone()]), Some(vec![gone]), Vec::new())
        .await;
    let line = std::fs::read_to_string(fixture.root.join("user-line")).unwrap();
    let user: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
    let blocks = user["message"]["content"].as_array().cloned().unwrap();
    assert!(
        blocks
            .iter()
            .any(|block| block["type"] == "image" && block["source"]["data"] == "iVBORw0KGgo="),
        "the image was dropped: {blocks:#?}"
    );

    // A caller-owned file backs the next turn and outlives it: the prompt text
    // cites that path, so the turn must not delete it.
    std::fs::remove_file(fixture.root.join("turn-open")).unwrap();
    let kept = fixture.root.join("xmatrix-attachment-kept.png");
    std::fs::write(&kept, b"kept-png").unwrap();
    fixture
        .run_channel_turn(Some(vec![attachment]), Some(vec![kept.clone()]), Vec::new())
        .await;
    assert!(kept.is_file(), "the turn deleted a file it did not create");
    let line = std::fs::read_to_string(fixture.root.join("user-line")).unwrap();
    // base64("kept-png"): the block came from the caller's file.
    assert!(line.contains("a2VwdC1wbmc="), "{line}");
    fixture.finish().await;
}
