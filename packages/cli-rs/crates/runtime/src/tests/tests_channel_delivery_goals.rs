fn test_sender(label: &str) -> MessageSender {
    channel_fixtures::sender(
        Some(&format!("user:{label}")),
        "user",
        label,
        label,
        &format!("{label}@example.com"),
    )
}

/// One message built in one place, so a frame test cannot drift from the
/// declaration it is supposed to be exercising.
/// A message an Agent Instance sent, identified by the protocol subject id the
/// hub stamps on it — never the display label, which is not stable.
fn agent_channel_message(
    message_id: &str,
    channel_id: &str,
    identity_id: &str,
    body: &str,
) -> ChannelMessage {
    let mut message = test_channel_message(message_id, channel_id, body);
    message.from.kind = "agent".to_string();
    message.from.identity_id = Some(identity_id.to_string());
    message.from.agent_name = Some("agent-under-test".to_string());
    message
}

fn test_channel_message(message_id: &str, channel_id: &str, body: &str) -> ChannelMessage {
    channel_fixtures::message(
        message_id,
        channel_id,
        Some(message_id.trim_start_matches('m').parse().unwrap_or(0)),
        test_sender("yiming"),
        body,
        "2026-01-01T00:00:00.000Z",
    )
}

fn channel_message_event(
    message_id: &str,
    channel_id: &str,
    body: &str,
) -> AgentInstanceConnectionEvent {
    AgentInstanceConnectionEvent::Server(AgentInstanceServerMessage::ChannelMessageReceived {
        message: test_channel_message(message_id, channel_id, body),
        client_message_id: None,
        ack_required: Some(true),
        interrupt_requested: None,
        delivery_intent: None,
    })
}

fn interrupting_channel_message_event(
    message_id: &str,
    channel_id: &str,
    body: &str,
) -> AgentInstanceConnectionEvent {
    let AgentInstanceConnectionEvent::Server(AgentInstanceServerMessage::ChannelMessageReceived {
        message,
        ack_required,
        ..
    }) = channel_message_event(message_id, channel_id, body)
    else {
        unreachable!("channel_message_event returns a channel message");
    };
    AgentInstanceConnectionEvent::Server(AgentInstanceServerMessage::ChannelMessageReceived {
        message,
        client_message_id: None,
        ack_required,
        interrupt_requested: Some(true),
        delivery_intent: None,
    })
}

fn test_attachment(id: &str, name: &str) -> ChannelAttachment {
    ChannelAttachment {
        id: id.to_string(),
        kind: "image".to_string(),
        name: name.to_string(),
        mime_type: "image/png".to_string(),
        size: 68,
        channel_id: None,
        message_id: None,
        data_url: "data:image/png;base64,iVBORw0KGgo=".to_string(),
        url: None,
    }
}

#[test]
fn inbound_batch_drain_removes_same_channel_messages_once() {
    let mut pending = VecDeque::from([
        channel_message_event("m1", "chan-a", "first"),
        channel_message_event("m2", "chan-a", "second"),
        channel_message_event("m3", "chan-b", "other channel"),
        AgentInstanceConnectionEvent::Disconnected {
            reason: "offline".to_string(),
        },
    ]);
    let mut messages = Vec::new();

    drain_pending_inbound_channel_messages(&mut pending, "chan-a", &mut messages, None);

    assert_channel_message_ids(&messages, &["m1", "m2"]);
    assert_eq!(pending.len(), 2);
    match pending.pop_front().unwrap() {
        AgentInstanceConnectionEvent::Server(
            AgentInstanceServerMessage::ChannelMessageReceived { message, .. },
        ) => {
            assert_eq!(message.message_id, "m3");
            assert_eq!(message.channel_id, "chan-b");
        }
        other => panic!("unexpected pending event: {other:?}"),
    }
    assert!(matches!(
        pending.pop_front(),
        Some(AgentInstanceConnectionEvent::Disconnected { .. })
    ));

    drain_pending_inbound_channel_messages(&mut pending, "chan-a", &mut messages, None);
    assert_eq!(messages.len(), 2);
    assert!(pending.is_empty());
}

#[test]
fn active_turn_interrupt_covers_marked_live_messages_and_catch_up() {
    let urgent = interrupting_channel_message_event("m1", "chan-a", "@codex:1 stop");
    let foreign = interrupting_channel_message_event("m4", "chan-b", "@codex:1 stop");
    let ordinary = channel_message_event("m2", "chan-a", "context only");
    let replay =
        AgentInstanceConnectionEvent::Server(AgentInstanceServerMessage::ChannelHistoryReplay {
            message: test_channel_message("m3", "chan-a", "replay"),
            ack_required: Some(true),
            delivery_intent: None,
        });
    let foreign_replay =
        AgentInstanceConnectionEvent::Server(AgentInstanceServerMessage::ChannelHistoryReplay {
            message: test_channel_message("m5", "chan-b", "replay"),
            ack_required: Some(true),
            delivery_intent: None,
        });
    let own_replay =
        AgentInstanceConnectionEvent::Server(AgentInstanceServerMessage::ChannelHistoryReplay {
            message: agent_channel_message("m6", "chan-a", "agent:self", "my own send"),
            ack_required: Some(true),
            delivery_intent: None,
        });

    assert!(event_requests_active_turn_interrupt(
        &urgent,
        Some("chan-a"),
        Some("agent:self")
    ));
    assert!(!event_requests_active_turn_interrupt(
        &foreign,
        Some("chan-a"),
        Some("agent:self")
    ));
    assert!(!event_requests_active_turn_interrupt(
        &ordinary,
        Some("chan-a"),
        Some("agent:self")
    ));
    // Catch-up carries no interrupt flag of its own, so this used to be false
    // and the message waited out the running turn. Whether a delivery is urgent
    // cannot depend on which hop carried it: replay reaching the runtime is
    // work the cursor says was never received, and orientation frames are
    // filtered out before they get here.
    assert!(event_requests_active_turn_interrupt(
        &replay,
        Some("chan-a"),
        Some("agent:self")
    ));
    // Initial daemon-assigned work has no source-message cursor to park, so
    // catch-up commonly arrives while that first turn is running. Replay must
    // queue behind the initial message instead of cancelling it.
    assert!(!super::event_requests_active_turn_interrupt_with_replay(
        &replay,
        Some("chan-a"),
        Some("agent:self"),
        false,
    ));
    assert!(super::event_requests_active_turn_interrupt_with_replay(
        &urgent,
        Some("chan-a"),
        Some("agent:self"),
        false,
    ));
    // Channel binding still applies to replay exactly as it does to live.
    assert!(!event_requests_active_turn_interrupt(
        &foreign_replay,
        Some("chan-a"),
        Some("agent:self")
    ));
    // The connection keeps this instance's own messages in replay, where they
    // are context. Interrupting on one would cancel the turn that sent it.
    assert!(!event_requests_active_turn_interrupt(
        &own_replay,
        Some("chan-a"),
        Some("agent:self")
    ));
    // The same frame is real work for any other instance, but replay cannot
    // prove it was exact steering. It queues behind that Instance's active
    // turn instead of cancelling a slower peer response.
    assert!(!event_requests_active_turn_interrupt(
        &own_replay,
        Some("chan-a"),
        Some("agent:other")
    ));
    assert!(event_requests_active_turn_interrupt(
        &foreign,
        None,
        Some("agent:self")
    ));
}

#[test]
fn bound_runtime_rejects_foreign_channel_delivery() {
    assert!(runtime_accepts_channel_delivery(Some("chan-a"), "chan-a"));
    assert!(!runtime_accepts_channel_delivery(Some("chan-a"), "chan-b"));
    assert!(runtime_accepts_channel_delivery(None, "chan-b"));
}

#[test]
fn inbound_batch_drain_caps_same_channel_messages() {
    let mut pending = VecDeque::new();
    for idx in 0..30 {
        pending.push_back(channel_message_event(
            &format!("m{idx}"),
            "chan-a",
            &format!("body {idx}"),
        ));
    }
    let mut messages = Vec::new();

    drain_pending_inbound_channel_messages(&mut pending, "chan-a", &mut messages, None);

    assert_eq!(messages.len(), 25);
    assert_eq!(pending.len(), 5);
    match pending.front().unwrap() {
        AgentInstanceConnectionEvent::Server(
            AgentInstanceServerMessage::ChannelMessageReceived { message, .. },
        ) => {
            assert_eq!(message.message_id, "m25");
        }
        other => panic!("unexpected pending event: {other:?}"),
    }
}

#[test]
fn inbound_batch_max_messages_env_parses_positive_values() {
    assert_eq!(inbound_delivery_batch_max_messages_from_env(Some("7")), 7);
    assert_eq!(inbound_delivery_batch_max_messages_from_env(Some("0")), 25);
    assert_eq!(
        inbound_delivery_batch_max_messages_from_env(Some("nope")),
        25
    );
    assert_eq!(inbound_delivery_batch_max_messages_from_env(None), 25);
    assert_eq!(
        inbound_delivery_batch_max_messages_from_env(Some("1000")),
        100
    );
}

#[test]
fn claude_stream_extra_args_enables_bidirectional_stream_json() {
    let args = claude_stream_extra_args(None, None, None, None);
    // Persistent backend requires print + bidirectional stream-json + the
    // replay echo; a fresh (non-reborn) spawn must NOT resume or pin a model.
    assert!(
        args.windows(2)
            .any(|w| w == ["--input-format", "stream-json"])
    );
    assert!(
        args.windows(2)
            .any(|w| w == ["--output-format", "stream-json"])
    );
    assert!(args.iter().any(|a| a == "--print"));
    assert!(args.iter().any(|a| a == "--verbose"));
    assert!(args.iter().any(|a| a == "--replay-user-messages"));
    assert!(args.windows(2).any(|pair| pair == ["--permission-prompt-tool", "stdio"]));
    assert!(!args.iter().any(|a| a == "--resume"));
    assert!(!args.iter().any(|a| a == "--model"));
}

#[test]
fn claude_stream_extra_args_resumes_only_with_a_real_session_id() {
    let resumed = claude_stream_extra_args(Some("sess-123"), None, None, None);
    assert!(resumed.windows(2).any(|w| w == ["--resume", "sess-123"]));
    // Blank/whitespace ids are not a session and must not add --resume.
    assert!(
        !claude_stream_extra_args(Some("   "), None, None, None)
            .iter()
            .any(|a| a == "--resume")
    );
}

#[test]
fn claude_stream_extra_args_pins_a_selected_model() {
    let args = claude_stream_extra_args(None, Some("sonnet[1m]"), None, None);
    assert!(args.windows(2).any(|w| w == ["--model", "sonnet[1m]"]));
    // Blank selections must not emit a dangling --model flag.
    assert!(
        !claude_stream_extra_args(None, Some("   "), None, None)
            .iter()
            .any(|a| a == "--model")
    );
}

#[test]
fn claude_stream_extra_args_pins_a_selected_effort() {
    let args = claude_stream_extra_args(None, Some("sonnet"), Some("xhigh"), None);
    assert!(args.windows(2).any(|w| w == ["--effort", "xhigh"]));
    // Blank selections must not emit a dangling --effort flag.
    assert!(
        !claude_stream_extra_args(None, None, Some("   "), None)
            .iter()
            .any(|a| a == "--effort")
    );
    // An unpinned session keeps the account default rather than inventing one.
    assert!(
        !claude_stream_extra_args(None, None, None, None)
            .iter()
            .any(|a| a == "--effort")
    );
}

#[test]
fn claude_stream_extra_args_applies_agent_instructions_as_system_prompt() {
    let instructions = trusted_role_system_prompt(Some("  You are the reviewer  "))
        .expect("trusted Agent instructions");
    assert!(trusted_role_system_prompt(Some("   ")).is_none());
    assert!(trusted_role_system_prompt(None).is_none());
    let args = claude_stream_extra_args(None, None, None, Some(&instructions));
    assert!(args.windows(2).any(|window| {
        window[0] == "--append-system-prompt"
            && window[1].starts_with("Agent instructions (trusted xMatrix run configuration):")
            && window[1].ends_with("You are the reviewer")
    }));
}

#[test]
fn claude_model_catalog_lists_switchable_aliases() {
    let catalog = claude_model_catalog();
    let ids: Vec<&str> = catalog.iter().map(|entry| entry.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "default",
            "fable",
            "opus",
            "sonnet",
            "sonnet[1m]",
            "haiku",
            "opusplan"
        ]
    );
    // The hub dedupes by `model` and echoes it back on switch, so id and
    // model must match and stay unique.
    for entry in &catalog {
        assert_eq!(entry.id, entry.model);
    }
    assert_eq!(catalog[0].is_default, Some(true));
}

/// Every alias must advertise the effort levels, because the only thing that
/// makes `/effort` reachable at all — the Composer completion, the `Effort`
/// chip, and the hub's own validation of a requested level — is this catalog.
/// Claude reports no effort on any stream event, so an empty list here is the
/// difference between a working control and a silently missing one.
#[test]
fn claude_model_catalog_advertises_effort_levels() {
    for entry in claude_model_catalog() {
        let levels: Vec<String> = entry
            .supported_reasoning_efforts
            .unwrap_or_default()
            .into_iter()
            .map(|level| level.reasoning_effort)
            .collect();
        assert_eq!(
            levels,
            ["low", "medium", "high", "xhigh", "max"],
            "{}",
            entry.id
        );
        // The account/model default is not observable from this runtime, so
        // claiming one would be a guess.
        assert_eq!(entry.default_reasoning_effort, None, "{}", entry.id);
    }
    // `ultracode` and `auto` are valid `/effort` arguments that this runtime
    // deliberately does not offer; see `claude_effort_catalog`.
    let offered: Vec<String> = claude_effort_catalog()
        .into_iter()
        .map(|level| level.reasoning_effort)
        .collect();
    assert!(!offered.iter().any(|level| level == "ultracode"));
    assert!(!offered.iter().any(|level| level == "auto"));
}

/// The transcript is the only place the *real* effort appears, so the watcher
/// has to read it there. Checked against 2.1.273 transcripts: an unpinned
/// sonnet session records `high`, and a session launched `--effort high` and
/// then switched to `max` records `max` — the level the turn ran at, not the
/// one the launch flag asked for.
#[test]
fn claude_transcript_watcher_reads_the_effort_a_turn_ran_at() {
    let dir = std::env::temp_dir().join(format!(
        "xmatrix-effort-watcher-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create test dir");
    let transcript = dir.join("session-e.jsonl");
    std::fs::write(
        &transcript,
        concat!(
            r#"{"type":"user","message":{}}"#,
            "\n",
            r#"{"type":"assistant","effort":"high","perTurnEffort":null,"message":{}}"#,
            "\n",
        ),
    )
    .expect("write transcript");

    let mut watcher =
        ClaudeTranscriptWatcher::bound_to(dir.clone(), "session-e", transcript.clone());
    assert_eq!(
        watcher.poll(Some("session-e")).effort.as_deref(),
        Some("high")
    );

    // Nothing appended: nothing to report, and the caller keeps what it had.
    assert_eq!(watcher.poll(Some("session-e")).effort, None);

    // A later turn at a different level wins, and a record from a model with
    // no reasoning effort at all does not clear it.
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&transcript)
        .expect("append transcript");
    std::io::Write::write_all(
        &mut file,
        concat!(
            r#"{"type":"assistant","effort":"max","message":{}}"#,
            "\n",
            r#"{"type":"assistant","message":{}}"#,
            "\n",
        )
        .as_bytes(),
    )
    .expect("append records");
    assert_eq!(
        watcher.poll(Some("session-e")).effort.as_deref(),
        Some("max")
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// Until a turn has written a transcript record there is nothing to report:
/// Claude resolves the level when it builds the request, so before the first
/// one there is no answer to give and none is invented.
#[test]
fn claude_session_controls_report_no_effort_before_the_first_turn() {
    let fresh = ClaudeSessionControls::new(None, None);
    assert_eq!(fresh.current_effort(), None);

    // A launch pin is the one thing knowable up front.
    let pinned = ClaudeSessionControls::new(None, Some("high".to_string()));
    assert_eq!(pinned.current_effort(), Some("high".to_string()));

    // An observed level supersedes the pin — that is how a switch Claude
    // quietly declined stops being reported as if it had taken.
    pinned.set_current_effort("medium");
    assert_eq!(pinned.current_effort(), Some("medium".to_string()));
}

#[test]
fn claude_initial_effort_from_args_reads_launcher_pin() {
    let args = |values: &[&str]| values.iter().map(|v| v.to_string()).collect::<Vec<_>>();
    assert_eq!(
        claude_initial_effort_from_args(&args(&["--effort", "high"])),
        Some("high".to_string())
    );
    assert_eq!(
        claude_initial_effort_from_args(&args(&["--effort=max"])),
        Some("max".to_string())
    );
    // Nothing pinned means the account default is in force, which this
    // runtime cannot see — so it reports nothing rather than a guess.
    assert_eq!(
        claude_initial_effort_from_args(&args(&["--model", "sonnet"])),
        None
    );
    // A trailing bare flag has no value to read.
    assert_eq!(claude_initial_effort_from_args(&args(&["--effort"])), None);
}

#[test]
fn claude_apply_effort_control_request_wire_format() {
    let line = claude_apply_effort_control_request("req-9", "xhigh");
    assert_eq!(line["type"], "control_request");
    assert_eq!(line["request_id"], "req-9");
    // Claude has no `set_effort`; effort rides the batched flag-settings write.
    assert_eq!(line["request"]["subtype"], "apply_flag_settings");
    assert_eq!(line["request"]["settings"]["effortLevel"], "xhigh");
}

#[test]
fn claude_initial_model_from_args_reads_launcher_pin() {
    let args = |values: &[&str]| values.iter().map(|v| v.to_string()).collect::<Vec<_>>();
    assert_eq!(
        claude_initial_model_from_args(&args(&["--model", "sonnet"])),
        Some("sonnet".to_string())
    );
    assert_eq!(
        claude_initial_model_from_args(&args(&["--model=opus"])),
        Some("opus".to_string())
    );
    assert_eq!(
        claude_initial_model_from_args(&args(&["--dangerously-skip-permissions"])),
        None
    );
    // A trailing bare flag has no value to read.
    assert_eq!(claude_initial_model_from_args(&args(&["--model"])), None);
}

#[test]
fn claude_set_model_control_request_wire_format() {
    let line = claude_set_model_control_request("req-1", "haiku");
    assert_eq!(line["type"], "control_request");
    assert_eq!(line["request_id"], "req-1");
    assert_eq!(line["request"]["subtype"], "set_model");
    assert_eq!(line["request"]["model"], "haiku");
}

#[test]
fn claude_interrupt_control_request_wire_format() {
    let line = claude_interrupt_control_request("interrupt-1");
    assert_eq!(line["type"], "control_request");
    assert_eq!(line["request_id"], "interrupt-1");
    assert_eq!(line["request"]["subtype"], "interrupt");
}

#[test]
fn claude_liveness_probe_control_request_wire_format() {
    let line = claude_liveness_probe_control_request("liveness-1");
    assert_eq!(line["type"], "control_request");
    assert_eq!(line["request_id"], "liveness-1");
    assert_eq!(line["request"]["subtype"], "status");
}

#[test]
fn claude_control_response_outcome_parses_observed_receipt_shapes() {
    let interrupt_receipt = serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": "xmatrix-interrupt-1",
            "response": { "still_queued": [] },
        },
    });
    assert_eq!(
        claude_control_response_outcome(&interrupt_receipt),
        Some(("xmatrix-interrupt-1".to_string(), Ok(())))
    );
    let probe_refusal = serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "error",
            "request_id": "xmatrix-liveness-1",
            "error": "Unsupported control request subtype: status",
        },
    });
    assert_eq!(
        claude_control_response_outcome(&probe_refusal),
        Some((
            "xmatrix-liveness-1".to_string(),
            Err("Unsupported control request subtype: status".to_string())
        ))
    );
}

#[test]
fn claude_control_response_outcome_parses_success_and_error() {
    let success = serde_json::json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": "req-1" },
    });
    assert_eq!(
        claude_control_response_outcome(&success),
        Some(("req-1".to_string(), Ok(())))
    );

    let error = serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "error",
            "request_id": "req-2",
            "error": "Model \"nope\" is not a recognized model id.",
        },
    });
    assert_eq!(
        claude_control_response_outcome(&error),
        Some((
            "req-2".to_string(),
            Err("Model \"nope\" is not a recognized model id.".to_string())
        ))
    );

    let unrelated = serde_json::json!({ "type": "assistant" });
    assert_eq!(claude_control_response_outcome(&unrelated), None);
}

/// Shapes observed from Claude 2.1.280 in stream-json mode: the result of a turn
/// we submitted has no `origin`; the one the CLI starts after a background task
/// finishes carries `{"kind":"task-notification"}`.
#[test]
fn claude_result_origin_separates_cli_started_turns() {
    let submitted =
        serde_json::json!({ "type": "result", "subtype": "success", "result": "STARTED" });
    assert!(!claude_result_is_cli_originated(&submitted));
    let human = serde_json::json!({ "type": "result", "origin": { "kind": "human" } });
    assert!(!claude_result_is_cli_originated(&human));
    let background = serde_json::json!({
        "type": "result",
        "subtype": "success",
        "result": "FINISHED",
        "origin": { "kind": "task-notification" },
    });
    assert!(claude_result_is_cli_originated(&background));
}

#[test]
fn claude_runtime_notices_cover_retries_and_limit_warnings_only() {
    let first_byte_timeout = serde_json::json!({
        "type": "system", "subtype": "api_retry", "attempt": 1, "max_retries": 1,
        "retry_delay_ms": 516, "error_status": null, "error": "unknown",
        "no_response": { "waited_ms": 237000, "retry_wait_ms": 599000 },
    });
    let notice = claude_runtime_notice_payload(&first_byte_timeout).unwrap();
    assert_eq!(notice["category"], "connection");
    assert_eq!(notice["status"], "retrying");
    assert_eq!(
        notice["message"],
        "no response from the Claude API after 237s; retry 1/1 in 1s"
    );

    let allowed = serde_json::json!({
        "type": "rate_limit_event",
        "rate_limit_info": { "status": "allowed", "rateLimitType": "five_hour" },
    });
    assert_eq!(claude_runtime_notice_payload(&allowed), None);

    let warning = serde_json::json!({
        "type": "rate_limit_event",
        "rate_limit_info": {
            "status": "allowed_warning", "rateLimitType": "seven_day",
            "utilization": 0.91, "resetsAt": 1790208000,
        },
    });
    let notice = claude_runtime_notice_payload(&warning).unwrap();
    assert_eq!(notice["category"], "quota");
    assert_eq!(notice["status"], "warning");
    assert_eq!(
        notice["message"],
        "Claude seven_day limit is nearly used up (91% used); resets 2026-09-24T00:00:00Z"
    );

    let rejected = serde_json::json!({
        "type": "rate_limit_event",
        "rate_limit_info": { "status": "rejected", "rateLimitType": "five_hour" },
    });
    let notice = claude_runtime_notice_payload(&rejected).unwrap();
    assert_eq!(notice["category"], "error");
    assert_eq!(notice["message"], "Claude five_hour limit is used up");

    let other_system = serde_json::json!({ "type": "system", "subtype": "compact_boundary" });
    assert_eq!(claude_runtime_notice_payload(&other_system), None);
}

#[test]
fn claude_inbound_control_requests_are_answered_like_the_agent_sdk() {
    let elicitation = serde_json::json!({
        "type": "control_request",
        "request_id": "cli-1",
        "request": { "subtype": "elicitation", "mcp_server_name": "linear", "message": "Pick one" },
    });
    assert_eq!(
        claude_inbound_control_response(&elicitation),
        Some(serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": "cli-1",
                "response": { "action": "decline" },
            },
        }))
    );

    let permission = serde_json::json!({
        "type": "control_request",
        "request_id": "cli-2",
        "request": { "subtype": "can_use_tool", "tool_name": "Bash", "input": {} },
    });
    assert_eq!(
        claude_inbound_control_response(&permission),
        Some(serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "error",
                "request_id": "cli-2",
                "error": "Unsupported control request subtype: can_use_tool",
            },
        }))
    );

    let dialog = serde_json::json!({
        "type": "control_request",
        "request_id": "cli-3",
        "request": { "subtype": "request_user_dialog", "dialog_kind": "x", "payload": {} },
    });
    assert_eq!(claude_inbound_control_response(&dialog), None);

    let our_own_receipt = serde_json::json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": "xmatrix-interrupt-1" },
    });
    assert_eq!(claude_inbound_control_response(&our_own_receipt), None);
}

/// A live switch steers the instance as hard as a human message does, and a
/// human message always cancels the running turn — the hub sets
/// `interrupt_requested` on every non-context delivery it fans out. The switch
/// arrives on its own frame instead, so it has to be named here or it preempts
/// nothing and waits out the turn the user is trying to redirect.
#[test]
fn a_live_control_switch_cancels_the_running_turn() {
    for event in [
        AgentInstanceConnectionEvent::Server(
            AgentInstanceServerMessage::AgentModelSwitchRequested {
                request_id: "req-model".to_string(),
                model: "fable".to_string(),
            },
        ),
        AgentInstanceConnectionEvent::Server(
            AgentInstanceServerMessage::AgentEffortSwitchRequested {
                request_id: "req-effort".to_string(),
                effort: "high".to_string(),
            },
        ),
    ] {
        assert!(event_requests_active_turn_interrupt(
            &event,
            Some("channel"),
            Some("agent:self")
        ));
        // A switch carries no channel, so no channel binding may filter it out.
        assert!(event_requests_active_turn_interrupt(
            &event,
            Some("some-other-channel"),
            Some("agent:self")
        ));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn claude_error_result_is_not_successful_execution() {
    let root = std::env::temp_dir().join(format!(
        "xmatrix-claude-error-result-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let script = root.join("fake-claude.sh");
    std::fs::write(&script, "IFS= read -r line\nprintf '%s\\n' '{\"type\":\"result\",\"is_error\":true,\"result\":\"synthetic failure\"}'\n").unwrap();
    let relay = Arc::new(AgentInstanceConnectionClient::new(
        "ws://127.0.0.1:9/ws".into(),
        "token".into(),
        "claude-test".into(),
        "claude_code".into(),
        None,
    ));
    let mut agent = test_serialized_agent("claude-test");
    agent.agent_type = "claude_code".into();
    let mut session = ClaudeStreamSession::new(
        "sh",
        &[script.to_string_lossy().into_owned()],
        root.to_str(),
        None,
        false,
        relay,
        agent,
        None,
    );
    let outcome = tokio::time::timeout(
        Duration::from_secs(5),
        session.submit_turn(
            "fail",
            vec![serde_json::json!({"type":"text", "text":"fail"})],
            "channel",
        ),
    )
    .await
    .unwrap();
    assert!(matches!(outcome.status, ClaudeTurnStatus::Failed));
    assert_eq!(outcome.answer, "synthetic failure");
    session.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn reborn_claude_stream_strips_resume_after_pre_accept_failure() {
    let _guard = test_process_env_lock();
    let nonce = uuid::Uuid::new_v4();
    let root = std::env::temp_dir().join(format!("xmatrix-reborn-resume-strip-{nonce}"));
    let config_dir = root.join("xmatrix-config");
    let claude_config_dir = root.join("claude-config");
    std::fs::create_dir_all(&config_dir).expect("create temp config");
    std::fs::create_dir_all(&claude_config_dir).expect("create temp claude config");
    let previous_config = std::env::var("XMATRIX_CONFIG_DIR").ok();
    let previous_claude = std::env::var("CLAUDE_CONFIG_DIR").ok();
    unsafe {
        std::env::set_var("XMATRIX_CONFIG_DIR", &config_dir);
        std::env::set_var("CLAUDE_CONFIG_DIR", &claude_config_dir);
    }
    let script = root.join("fake-claude.sh");
    std::fs::write(
        &script,
        r#"#!/bin/sh
log="$1"
shift
has_resume=false
for arg in "$@"; do
  if [ "$arg" = "--resume" ]; then
    has_resume=true
  fi
done
printf '%s\n' "$*" >> "$log"
# Session initialization is a control frame; only user input starts this turn.
while IFS= read -r line; do
  case "$line" in
    *'"type":"user"'*) break ;;
  esac
done
if [ "$has_resume" = "true" ]; then
  exit 2
fi
printf '%s\n' '{"type":"result","session_id":"sess-new","result":"reborn ok"}'
"#,
    )
    .expect("write fake claude");
    let log = root.join("args.log");
    let root_string = root.to_string_lossy().to_string();
    let transcript_dir = config::claude_projects_dir()
        .expect("claude projects dir")
        .join(format!("xmatrix-reborn-resume-strip-{nonce}"));
    std::fs::create_dir_all(&transcript_dir).expect("create fake claude transcript dir");
    std::fs::write(
        transcript_dir.join("sess-old.jsonl"),
        serde_json::json!({ "cwd": root_string }).to_string(),
    )
    .expect("write fake claude transcript");
    let resume_key = format!("reborn-worktree-channel-{nonce}");
    save_claude_resume_session_id(Some(&resume_key), Some("sess-old")).expect("seed resume id");
    let relay = Arc::new(AgentInstanceConnectionClient::new(
        "ws://127.0.0.1:9/ws".to_string(),
        "token".to_string(),
        "claude-test".to_string(),
        "claude_code".to_string(),
        None,
    ));
    let agent = SerializedAgent {
        id: "agent-1".to_string(),
        instance_id: Some("instance-1".to_string()),
        name: "claude-test".to_string(),
        agent_type: "claude_code".to_string(),
        email: "claude@example.com".to_string(),
        metadata: serde_json::json!({ "cwd": root }),
        ..test_agent_record()
    };
    let mut session = ClaudeStreamSession::new(
        "sh",
        &[
            script.to_string_lossy().to_string(),
            log.to_string_lossy().to_string(),
        ],
        Some(&root_string),
        Some(resume_key.clone()),
        true,
        relay,
        agent,
        None,
    );

    let outcome = tokio::time::timeout(
        Duration::from_secs(5),
        session.submit_turn(
            "continue",
            vec![serde_json::json!({"type":"text","text":"continue"})],
            "ch-1",
        ),
    )
    .await
    .expect("reborn retry should not hang");
    assert!(
        matches!(outcome.status, ClaudeTurnStatus::Completed),
        "{}",
        outcome.answer
    );
    assert_eq!(outcome.answer, "reborn ok");
    let invocations = std::fs::read_to_string(&log).expect("read fake claude args");
    let lines: Vec<&str> = invocations.lines().collect();
    assert_eq!(lines.len(), 2, "{invocations}");
    assert!(lines[0].contains("--resume sess-old"), "{invocations}");
    assert!(!lines[1].contains("--resume"), "{invocations}");
    match previous_config {
        Some(value) => unsafe { std::env::set_var("XMATRIX_CONFIG_DIR", value) },
        None => unsafe { std::env::remove_var("XMATRIX_CONFIG_DIR") },
    }
    match previous_claude {
        Some(value) => unsafe { std::env::set_var("CLAUDE_CONFIG_DIR", value) },
        None => unsafe { std::env::remove_var("CLAUDE_CONFIG_DIR") },
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn normalize_cwd_for_compare_unifies_separators_and_trailing_slash() {
    assert_eq!(
        normalize_cwd_for_compare("C:\\Users\\dev\\Projects\\accelerator\\"),
        "C:/Users/dev/Projects/accelerator"
    );
    assert_eq!(normalize_cwd_for_compare("/Users/dev/x/"), "/Users/dev/x");
    assert_eq!(normalize_cwd_for_compare("  /a/b  "), "/a/b");
}

#[test]
fn claude_transcript_cwd_reads_cwd_past_leading_queue_markers() {
    let dir = std::env::temp_dir().join(format!("xmatrix-transcript-cwd-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("sess.jsonl");
    // First line is a queue-operation with no cwd; the cwd lands on a later line.
    std::fs::write(
        &path,
        "{\"type\":\"queue-operation\",\"sessionId\":\"sess\"}\n\
             {\"type\":\"user\",\"cwd\":\"/Users/dev/proj\",\"message\":{}}\n",
    )
    .unwrap();
    assert_eq!(
        claude_transcript_cwd(&path).as_deref(),
        Some("/Users/dev/proj")
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn claude_stream_user_message_shapes_a_user_turn() {
    let message = claude_stream_user_message(vec![serde_json::json!({
        "type": "text",
        "text": "hello world",
    })]);
    assert_eq!(message["type"], "user");
    assert_eq!(message["message"]["role"], "user");
    assert_eq!(message["message"]["content"][0]["text"], "hello world");
}

fn mock_claude_stream_session(
    root: &Path,
    agent: &SerializedAgent,
    mode: &str,
    stdin_log: Option<&Path>,
) -> (Arc<AgentInstanceConnectionClient>, ClaudeStreamSession) {
    let relay = Arc::new(AgentInstanceConnectionClient::new(
        "ws://127.0.0.1:9/ws".to_string(),
        "token".to_string(),
        agent.name.clone(),
        agent.agent_type.clone(),
        None,
    ));
    let mut args = vec![
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/mock-claude-stream.cjs")
            .to_string_lossy()
            .to_string(),
        mode.to_string(),
    ];
    if let Some(log) = stdin_log {
        args.push(log.to_string_lossy().to_string());
    }
    let session = ClaudeStreamSession::new(
        "node",
        &args,
        Some(root.to_string_lossy().as_ref()),
        None,
        false,
        relay.clone(),
        agent.clone(),
        None,
    );
    (relay, session)
}

#[tokio::test]
async fn claude_stream_turn_interrupts_active_turn_from_marked_channel_message() {
    let root = std::env::temp_dir().join(format!(
        "xmatrix-claude-channel-interrupt-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&root).expect("create fake Claude root");
    let stdin_log = root.join("stdin.jsonl");

    let mut agent = test_serialized_agent("claude-channel-interrupt");
    agent.agent_type = "claude_code".to_string();
    let (relay, mut session) =
        mock_claude_stream_session(&root, &agent, "interrupt", Some(&stdin_log));
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
    let stdin_log_for_interrupt = stdin_log.clone();
    let interrupt_after_turn_started = tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if fs::read_to_string(&stdin_log_for_interrupt)
                    .unwrap_or_default()
                    .lines()
                    .any(|line| line.contains("\"type\":\"user\""))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("fake Claude should receive the active user turn");
        event_tx
            .send(interrupting_channel_message_event(
                "m-interrupt",
                "channel-interrupt",
                "stop and handle this newer message",
            ))
            .expect("queue interrupting channel message");
    });
    let mut pending_events = VecDeque::new();

    tokio::time::timeout(
        Duration::from_secs(5),
        crate::runtime_claude_turn::run_claude_stream_turn(
            &mut session,
            "start a turn that waits for an interrupt".to_string(),
            None,
            None,
            "channel-interrupt".to_string(),
            None,
            None,
            &relay,
            &agent,
            true,
            true,
            None,
            &mut event_rx,
            &mut pending_events,
        ),
    )
    .await
    .expect("interrupt should complete the active Claude turn");
    interrupt_after_turn_started
        .await
        .expect("interrupt sender should not panic");

    let stdin_lines = fs::read_to_string(&stdin_log).expect("read fake Claude stdin");
    let requests = stdin_lines
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("valid fake Claude input"))
        .collect::<Vec<_>>();
    assert!(requests.iter().any(|request| request["type"] == "user"));
    assert!(requests.iter().any(|request| {
        request["type"] == "control_request" && request["request"]["subtype"] == "interrupt"
    }));
    assert!(matches!(
        pending_events.pop_front(),
        Some(AgentInstanceConnectionEvent::Server(
            AgentInstanceServerMessage::ChannelMessageReceived { message, .. }
        )) if message.message_id == "m-interrupt"
    ));
    assert!(pending_events.is_empty());

    assert!(
        !stdin_lines.contains("Your previous turn was interrupted"),
        "the interrupted turn itself carries no notice"
    );

    // Claude reports the cancelled tool call as a human refusal, so the next
    // turn names the interrupt, once.
    for prompt in ["handle the newer message", "an ordinary later message"] {
        tokio::time::timeout(
            Duration::from_secs(5),
            crate::runtime_claude_turn::run_claude_stream_turn(
                &mut session,
                prompt.to_string(),
                None,
                None,
                "channel-interrupt".to_string(),
                None,
                None,
                &relay,
                &agent,
                true,
                true,
                None,
                &mut event_rx,
                &mut pending_events,
            ),
        )
        .await
        .expect("follow-up Claude turn should complete");
    }
    let user_turns = fs::read_to_string(&stdin_log)
        .expect("read fake Claude stdin")
        .lines()
        .filter(|line| line.contains("\"type\":\"user\""))
        .map(str::to_string)
        .collect::<Vec<_>>();
    assert_eq!(user_turns.len(), 3);
    assert!(user_turns[1].contains("Your previous turn was interrupted"));
    assert!(user_turns[1].contains("handle the newer message"));
    assert!(!user_turns[2].contains("Your previous turn was interrupted"));

    session.shutdown().await;
    fs::remove_dir_all(&root).ok();
}

#[test]
fn slash_command_passthrough_accepts_only_instance_targeted_commands() {
    let agent = test_serialized_agent("codex");
    let cases = [
        ("@codex:1 /goal ship the fix", Some("/goal ship the fix")),
        ("  @codex:2   /goal clear  ", Some("/goal clear")),
        // A '/' inside the argument is fine; only the command name must be clean.
        ("@codex:new /model anthropic/opus", Some("/model anthropic/opus")),
        ("@codex:1 /review", Some("/review")),
        // Bare slash commands, ordinary prose, and questions keep their channel context.
        ("/goal ship the fix", None),
        ("  /goal clear  ", None),
        ("/compact", None),
        ("can it support /goal?", None),
        ("hello there", None),
        // Bare agent mentions are identity-level, not instance-level, addressing.
        ("@codex /goal ship it", None),
        // Mentions for another agent profile must not manage this instance.
        ("@claude:1 /compact", None),
        ("@claude:1 /goal ship it", None),
        // xMatrix's own local commands are handled by the runtime.
        ("@codex:1 /agent rename foo", None),
        ("@codex:1 /channel join abc 10", None),
        ("@codex:1 /channels", None),
        // Paths, comments, and bare slashes are not commands.
        ("@codex:1 /usr/local/bin", None),
        ("@codex:1 /* a comment */", None),
        ("@codex:1 /", None),
        ("@codex:1 //", None),
        ("", None),
    ];
    for (input, expected) in cases {
        assert_eq!(slash_command_passthrough(input, &agent), expected, "{input:?}");
    }
}

#[test]
fn single_message_slash_passthrough_only_for_lone_attachment_free_command() {
    let command_message = |body: &str| InboundChannelMessage {
        entity_version: None,
        body_hash: None,
        message_id: "m1".to_string(),
        channel_id: "chan-a".to_string(),
        sequence: Some(1),
        from: test_sender("Yiming Hu"),
        body: body.to_string(),
        reply_to_message_id: None,
        reply_to: None,
        attachments: None,
        metadata: None,
    };
    let agent = test_serialized_agent("codex");

    assert_eq!(
        single_message_slash_passthrough(&[command_message("@codex:1 /goal ship it")], &agent),
        Some("/goal ship it".to_string())
    );

    // Batched delivery falls back to wrapped context.
    assert_eq!(
        single_message_slash_passthrough(
            &[
                command_message("@codex:1 /goal ship it"),
                command_message("and hurry"),
            ],
            &agent
        ),
        None
    );

    // A command carrying attachments keeps its context.
    let mut with_attachment = command_message("@codex:1 /goal ship it");
    with_attachment.attachments = Some(vec![test_attachment("att-1", "one.png")]);
    assert_eq!(
        single_message_slash_passthrough(&[with_attachment], &agent),
        None
    );

    // Ordinary prose is never passed through.
    assert_eq!(
        single_message_slash_passthrough(&[command_message("just a message")], &agent),
        None
    );
}

#[test]
fn parse_goal_command_maps_supported_goal_commands() {
    assert_eq!(parse_goal_command("/goal"), Some(GoalCommand::Get));
    assert_eq!(
        parse_goal_command("/goal ship the release by friday"),
        Some(GoalCommand::Set {
            objective: "ship the release by friday".to_string()
        })
    );
    assert_eq!(
        parse_goal_command("  /goal   keep tests green  "),
        Some(GoalCommand::Set {
            objective: "keep tests green".to_string()
        })
    );
    assert_eq!(parse_goal_command("/goal clear"), Some(GoalCommand::Clear));
    assert_eq!(parse_goal_command("/goal CLEAR"), Some(GoalCommand::Clear));
    assert_eq!(parse_goal_command("/goal get"), Some(GoalCommand::Get));
    assert_eq!(parse_goal_command("/goal status"), Some(GoalCommand::Get));
    assert_eq!(parse_goal_command("/goal show"), Some(GoalCommand::Get));
    assert_eq!(
        parse_goal_command("/goal resume"),
        Some(GoalCommand::Resume)
    );
    assert_eq!(parse_goal_command("/goal pause"), Some(GoalCommand::Pause));
    assert_eq!(parse_goal_command("/goal PAUSE"), Some(GoalCommand::Pause));
    assert_eq!(
        parse_goal_command("/goal replace ship a safer release"),
        Some(GoalCommand::Replace {
            objective: "ship a safer release".to_string()
        })
    );
}

#[test]
fn grok_goal_turn_input_rewrites_onto_native_slash_grammar() {
    assert_eq!(
        grok_goal_turn_input(
            &GoalCommand::Set {
                objective: "ship the release".to_string()
            },
            None
        ),
        "/goal ship the release"
    );
    assert_eq!(
        grok_goal_turn_input(&GoalCommand::Clear, None),
        "/goal clear"
    );
    assert_eq!(
        grok_goal_turn_input(&GoalCommand::Get, None),
        "/goal status"
    );
    assert_eq!(
        grok_goal_turn_input(&GoalCommand::Pause, None),
        "/goal pause"
    );
    assert_eq!(
        grok_goal_turn_input(&GoalCommand::Resume, None),
        "/goal resume"
    );
}

#[test]
fn parse_goal_command_rejects_non_goal_commands() {
    // Other commands and look-alikes are not goal commands.
    assert_eq!(parse_goal_command("/goalpost set a target"), None);
    assert_eq!(parse_goal_command("/compact"), None);
    assert_eq!(parse_goal_command("set a goal please"), None);
}

#[test]
fn codex_goal_set_still_submits_objective_as_turn_payload() {
    let command = parse_goal_command("/goal build the self-review loop").expect("set goal command");
    assert_eq!(
        codex_goal_turn_payload(&command).as_deref(),
        Some("build the self-review loop")
    );

    let clear = parse_goal_command("/goal clear").expect("clear goal command");
    assert_eq!(codex_goal_turn_payload(&clear), None);

    let resume = parse_goal_command("/goal resume").expect("resume goal command");
    assert_eq!(codex_goal_turn_payload(&resume), None);
}

#[test]
fn codex_goal_resume_uses_current_goal_objective_as_turn_payload() {
    let goal = protocol::AgentGoalStatus {
        active: Some(false),
        objective: Some("finish the release checklist".to_string()),
        status: Some("blocked".to_string()),
        updated_at: Some("123".to_string()),
        ..Default::default()
    };
    assert_eq!(
        goal_resume_turn_payload(Some(&goal)).as_deref(),
        Some("Continue working on the current goal: finish the release checklist")
    );

    let empty = protocol::AgentGoalStatus {
        active: Some(false),
        objective: Some("  ".to_string()),
        status: Some("blocked".to_string()),
        updated_at: None,
        ..Default::default()
    };
    assert_eq!(goal_resume_turn_payload(Some(&empty)), None);
    assert_eq!(goal_resume_turn_payload(None), None);
}

#[test]
fn codex_goal_resume_requires_a_current_objective() {
    let paused = serde_json::json!({
        "goal": {
            "active": false,
            "objective": "  finish the release checklist  ",
            "status": "paused"
        }
    });
    assert_eq!(
        codex_resume_goal_objective(&paused).expect("paused goal objective"),
        "finish the release checklist"
    );

    let missing = serde_json::json!({ "goal": { "status": "paused" } });
    let error = codex_resume_goal_objective(&missing).expect_err("missing objective");
    assert!(error.to_string().contains("without a current objective"));
}

#[test]
fn codex_goal_dynamic_tools_expose_full_native_patch_surface() {
    let tools = codex_goal_dynamic_tools();
    let entries = tools
        .pointer("/0/tools")
        .and_then(Value::as_array)
        .expect("goal namespace tools");
    assert_eq!(
        entries
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>(),
        vec!["set", "get", "clear"]
    );
    let set_schema = &entries[0]["inputSchema"];
    assert!(set_schema.pointer("/properties/objective").is_some());
    assert!(set_schema.pointer("/properties/status").is_some());
    // A self-imposed token budget is not offered: an agent that sets one can
    // stall itself with no way to clear it except escalating to a human.
    assert!(set_schema.pointer("/properties/tokenBudget").is_none());
}

#[test]
fn codex_goal_dynamic_set_validates_native_patch_fields() {
    assert_eq!(
        codex_goal_set_patch_from_tool_arguments(&serde_json::json!({
            "objective": "ship it",
            "status": "paused"
        }))
        .expect("valid goal patch"),
        serde_json::json!({
            "objective": "ship it",
            "status": "paused"
        })
    );
    assert!(
        codex_goal_set_patch_from_tool_arguments(&serde_json::json!({"tokenBudget": 1234}))
            .is_err()
    );
    assert!(
        codex_goal_set_patch_from_tool_arguments(&serde_json::json!({"status": "budgetLimited"}))
            .is_err()
    );
    assert!(
        codex_goal_set_patch_from_tool_arguments(&serde_json::json!({"unknown": true})).is_err()
    );
}

#[test]
fn zcode_goal_snapshot_maps_metrics_verification_and_clear() {
    let snapshot = serde_json::json!({
        "snapshot": {
            "session": {
                "target": {
                    "objective": "finish the release",
                    "status": "blocked",
                    "activeInputId": "input-7"
                }
            },
            "goalStats": {
                "iterationCount": 4,
                "tokensUsed": 4321,
                "contextUsed": 876,
                "toolCallCount": 9,
                "timeUsedSeconds": 67
            },
            "runtime": {
                "goalVerifications": [{
                    "passed": false,
                    "reason": "tests still failing",
                    "nextAction": "fix the remaining test"
                }]
            }
        }
    });
    let goal = zcode_goal_state_from_value(&snapshot)
        .expect("goal state was present")
        .expect("goal was not cleared");
    assert_eq!(goal.status.as_deref(), Some("blocked"));
    assert_eq!(goal.active, Some(false));
    assert_eq!(goal.tokens_used, Some(4321));
    assert_eq!(goal.iteration_count, Some(4));
    assert_eq!(goal.context_used, Some(876));
    assert_eq!(goal.tool_call_count, Some(9));
    assert_eq!(goal.time_used_seconds, Some(67));
    assert_eq!(goal.reason.as_deref(), Some("tests still failing"));
    assert_eq!(goal.next_action.as_deref(), Some("fix the remaining test"));
    assert_eq!(
        zcode_goal_active_input_id(&snapshot).as_deref(),
        Some("input-7")
    );

    let cleared = serde_json::json!({"snapshot": {"session": {"target": null}}});
    assert!(matches!(zcode_goal_state_from_value(&cleared), Some(None)));
}

#[test]
fn codex_goal_resume_sets_active_status_without_replacing_objective() {
    let paused = serde_json::json!({
        "goal": {
            "objective": "finish the release checklist",
            "status": "paused"
        }
    });

    assert_eq!(
        super::codex_resume_goal_params("thread-1", &paused).expect("resume goal params"),
        serde_json::json!({
            "threadId": "thread-1",
            "status": "active"
        })
    );
}

#[test]
fn codex_goal_resume_reactivates_the_pause_gate() {
    let resumed = codex_goal_status_from_response(
        &GoalCommand::Resume,
        &serde_json::json!({
            "goal": {
                "objective": "finish the release checklist",
                "status": "active"
            }
        }),
    );

    assert_eq!(resumed.active, Some(true));
    assert_eq!(resumed.status.as_deref(), Some("active"));
    assert!(!codex_goal_is_paused(Some(&resumed)));
}

#[test]
fn initial_spawn_context_carries_goal_without_goal_specific_env_shape() {
    let raw = serde_json::json!({
        "requestedModel": "exact-model",
        "requestedEffort": "high",
        "goal": {
            "active": true,
            "objective": "preserve the north star",
            "status": "active",
            "updatedAt": "123"
        }
    })
    .to_string();
    let context = parse_initial_spawn_context(&raw).expect("spawn context");
    assert_eq!(context.requested_model.as_deref(), Some("exact-model"));
    assert_eq!(context.requested_effort.as_deref(), Some("high"));
    assert_eq!(
        context.goal.and_then(|goal| goal.objective),
        Some("preserve the north star".to_string())
    );
}

#[test]
fn claude_goal_turn_input_rewrites_onto_native_goal_grammar() {
    let latest = protocol::AgentGoalStatus {
        active: Some(true),
        objective: Some("ship the fix".to_string()),
        status: Some("active".to_string()),
        updated_at: None,
        ..Default::default()
    };
    assert_eq!(
        claude_goal_turn_input(
            &GoalCommand::Set {
                objective: "ship the fix".to_string()
            },
            None,
        ),
        "/goal ship the fix"
    );
    assert_eq!(
        claude_goal_turn_input(&GoalCommand::Clear, Some(&latest)),
        "/goal clear"
    );
    // `get`/`status`/`show` must become the bare status query: forwarding
    // them verbatim would set a goal with that literal objective.
    assert_eq!(
        claude_goal_turn_input(&GoalCommand::Get, Some(&latest)),
        "/goal"
    );
    assert_eq!(
        claude_goal_turn_input(&GoalCommand::Resume, Some(&latest)),
        "Continue working on the current goal: ship the fix"
    );
    // Without a known goal, resume degrades to the status query.
    assert_eq!(claude_goal_turn_input(&GoalCommand::Resume, None), "/goal");
}

#[test]
fn claude_goal_status_from_transcript_line_maps_evaluator_records() {
    let pending = serde_json::json!({
        "type": "attachment",
        "timestamp": "2026-07-07T13:34:37.479Z",
        "attachment": {
            "type": "goal_status",
            "met": false,
            "sentinel": true,
            "condition": "create done.txt containing ok"
        }
    });
    let goal = claude_goal_status_from_transcript_line(&pending).expect("goal status");
    assert_eq!(goal.active, Some(true));
    assert_eq!(
        goal.objective.as_deref(),
        Some("create done.txt containing ok")
    );
    assert_eq!(goal.status.as_deref(), Some("active"));

    let met = serde_json::json!({
        "type": "attachment",
        "attachment": {
            "type": "goal_status",
            "met": true,
            "condition": "create done.txt containing ok",
            "reason": "File created successfully"
        }
    });
    let goal = claude_goal_status_from_transcript_line(&met).expect("goal status");
    assert_eq!(goal.active, Some(false));
    assert_eq!(goal.status.as_deref(), Some("complete"));

    let other = serde_json::json!({
        "type": "attachment",
        "attachment": { "type": "queue-operation" }
    });
    assert!(claude_goal_status_from_transcript_line(&other).is_none());
    assert!(
        claude_goal_status_from_transcript_line(&serde_json::json!({"type": "assistant"}))
            .is_none()
    );
}

#[test]
fn claude_goal_status_from_result_text_parses_control_command_acks() {
    let active = claude_goal_status_from_result_text(
        "Goal active: create done.txt containing ok (not yet evaluated)",
    )
    .expect("goal status");
    assert_eq!(active.active, Some(true));
    assert_eq!(
        active.objective.as_deref(),
        Some("create done.txt containing ok")
    );
    assert_eq!(active.status.as_deref(), Some("active"));

    let cleared =
        claude_goal_status_from_result_text("Goal cleared: ship the fix").expect("goal status");
    assert_eq!(cleared.active, Some(false));
    assert_eq!(cleared.objective.as_deref(), Some("ship the fix"));
    assert_eq!(cleared.status.as_deref(), Some("cleared"));

    let none = claude_goal_status_from_result_text("No goal set. Usage: `/goal <condition>`")
        .expect("goal status");
    assert_eq!(none.active, Some(false));
    assert_eq!(none.objective, None);

    assert!(
        claude_goal_status_from_result_text("Done. Created foo.txt with content bar.").is_none()
    );
}

#[test]
fn claude_goal_watcher_polls_transcript_records_incrementally() {
    let dir =
        std::env::temp_dir().join(format!("xmatrix-goal-watcher-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create test dir");
    let transcript = dir.join("session-1.jsonl");
    std::fs::write(
            &transcript,
            concat!(
                r#"{"type":"attachment","attachment":{"type":"goal_status","met":false,"condition":"ship it"}}"#,
                "\n",
                r#"{"type":"assistant","message":{}}"#,
                "\n",
            ),
        )
        .expect("write transcript");

    let mut watcher =
        ClaudeTranscriptWatcher::bound_to(dir.clone(), "session-1", transcript.clone());

    assert!(watcher.poll(Some("session-1")).goal_changed);
    let goal = watcher.current().cloned().expect("goal after first poll");
    assert_eq!(goal.active, Some(true));
    assert_eq!(goal.objective.as_deref(), Some("ship it"));

    // No new records: unchanged.
    assert!(!watcher.poll(Some("session-1")).goal_changed);

    // Appended completion record is picked up from the saved offset; a
    // trailing partial line is left for the next poll.
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&transcript)
        .expect("append transcript");
    std::io::Write::write_all(
            &mut file,
            concat!(
                r#"{"type":"attachment","attachment":{"type":"goal_status","met":true,"condition":"ship it"}}"#,
                "\n",
                r#"{"type":"attachment","attachment":{"type":"goal_status","#
            )
            .as_bytes(),
        )
        .expect("append records");
    assert!(watcher.poll(Some("session-1")).goal_changed);
    let goal = watcher.current().cloned().expect("goal after append");
    assert_eq!(goal.active, Some(false));
    assert_eq!(goal.status.as_deref(), Some("complete"));

    // Session change resets discovery; an unknown session id finds no
    // transcript under the projects store and reports no change.
    assert!(!watcher.poll(Some("session-2")).goal_changed);
    assert!(!watcher.has_transcript());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn codex_goal_status_from_app_event_reads_nested_goal_updates() {
    let event = serde_json::json!({
        "method": "item/completed",
        "params": {
            "item": {
                "type": "toolResult",
                "result": {
                    "goal": {
                        "active": true,
                        "objective": "show goals in message headers",
                        "status": "active",
                        "updatedAt": "123"
                    }
                }
            }
        }
    });

    let goal = codex_goal_status_from_app_event(&event).expect("goal status");
    assert_eq!(goal.active, Some(true));
    assert_eq!(
        goal.objective.as_deref(),
        Some("show goals in message headers")
    );
    assert_eq!(goal.status.as_deref(), Some("active"));
    assert_eq!(goal.updated_at.as_deref(), Some("123"));
}

#[test]
fn codex_goal_status_from_app_event_reads_json_string_tool_output() {
    let event = serde_json::json!({
        "method": "item/completed",
        "params": {
            "item": {
                "type": "toolResult",
                "output": "{\"goal\":{\"objective\":\"done\",\"status\":\"complete\"}}"
            }
        }
    });

    let goal = codex_goal_status_from_app_event(&event).expect("goal status");
    assert_eq!(goal.active, Some(false));
    assert_eq!(goal.objective.as_deref(), Some("done"));
    assert_eq!(goal.status.as_deref(), Some("complete"));
}

#[test]
fn codex_goal_status_from_get_response_maps_paused_goal() {
    let response = serde_json::json!({
        "goal": {
            "objective": "resume paused work",
            "status": "paused",
            "updatedAt": "123"
        }
    });

    let goal = codex_goal_status_from_get_response(&response).expect("goal status");
    assert_eq!(goal.active, Some(false));
    assert_eq!(goal.objective.as_deref(), Some("resume paused work"));
    assert_eq!(goal.status.as_deref(), Some("paused"));
    assert_eq!(goal.updated_at.as_deref(), Some("123"));
}

#[test]
fn codex_goal_status_from_get_response_ignores_missing_goal() {
    assert!(codex_goal_status_from_get_response(&serde_json::json!({})).is_none());
    assert!(codex_goal_status_from_get_response(&serde_json::json!({"goal": null})).is_none());
}

#[test]
fn codex_goal_is_paused_matches_status_only() {
    let paused = protocol::AgentGoalStatus {
        active: Some(false),
        objective: Some("ship it".to_string()),
        status: Some("paused".to_string()),
        updated_at: None,
        ..Default::default()
    };
    let active = protocol::AgentGoalStatus {
        active: Some(true),
        objective: Some("ship it".to_string()),
        status: Some("active".to_string()),
        updated_at: None,
        ..Default::default()
    };

    assert!(codex_goal_is_paused(Some(&paused)));
    assert!(!codex_goal_is_paused(Some(&active)));
    assert!(!codex_goal_is_paused(None));
}

#[test]
fn codex_paused_goal_notice_points_to_explicit_resume() {
    let paused = protocol::AgentGoalStatus {
        active: Some(false),
        objective: Some("resume paused work".to_string()),
        status: Some("paused".to_string()),
        updated_at: None,
        ..Default::default()
    };

    let notice = codex_paused_goal_notice(Some(&paused));
    assert!(notice.contains("resume paused work"));
    assert!(notice.contains("/goal resume"));
}

#[test]
fn codex_goal_status_from_app_event_ignores_plain_text_json() {
    let event = serde_json::json!({
        "method": "item/completed",
        "params": {
            "item": {
                "type": "userMessage",
                "text": "{\"goal\":{\"objective\":\"spoof\",\"status\":\"active\"}}"
            }
        }
    });

    assert!(codex_goal_status_from_app_event(&event).is_none());
}

#[test]
fn agent_runtime_state_tracks_actual_active_turn() {
    let tracker = AgentRuntimeStateTracker::new("codex_app_server");
    let idle = tracker.snapshot();
    assert_eq!(idle.status, "idle");
    assert_eq!(idle.source.as_deref(), Some("codex_app_server"));

    let mut turn = tracker.begin_turn(Some("ch-1"), Some("msg-1"));
    tracker.set_codex_turn(Some(&turn.execution_id), "thread-1", Some("turn-1"), true);
    let running = tracker.snapshot();
    assert_eq!(running.status, "running");
    assert_eq!(running.active_channel_id.as_deref(), Some("ch-1"));
    assert_eq!(running.active_message_id.as_deref(), Some("msg-1"));
    assert_eq!(running.active_thread_id.as_deref(), Some("thread-1"));
    assert_eq!(running.active_turn_id.as_deref(), Some("turn-1"));

    turn.finish_as("completed");
    let idle_again = tracker.snapshot();
    assert_eq!(idle_again.status, "idle");
    assert_eq!(idle_again.active_channel_id, None);
    assert_eq!(idle_again.active_message_id, None);
    assert_eq!(idle_again.active_thread_id, None);
    assert_eq!(idle_again.active_turn_id, None);
}

#[test]
fn final_reply_instruction_is_bound_to_the_captured_input_and_execution() {
    let tracker = AgentRuntimeStateTracker::new("test");
    assert!(tracker.final_reply_instruction(Some("channel")).is_none());
    let unknown = tracker.begin_turn(Some("channel"), Some("message"));
    assert!(tracker.final_reply_instruction(Some("channel")).is_none());
    drop(unknown);
    let source = protocol::AgentRuntimeMessageSource {
        channel_id: "channel".into(),
        message_id: "message".into(),
        sequence: 1,
        entity_version: 1,
        body_hash: "a".repeat(64),
    };
    let mut first =
        tracker.begin_message_turn(Some("channel"), Some("message"), 1, vec![source.clone()]);
    let instruction = tracker.final_reply_instruction(Some("channel")).unwrap();
    assert!(instruction.contains(&format!("--final-for {}", first.execution_id)));
    assert!(tracker.final_reply_instruction(Some("other")).is_none());
    first.finish_as("completed");
    assert!(tracker.final_reply_instruction(Some("channel")).is_none());
    let second = tracker.begin_message_turn(Some("channel"), Some("message"), 1, vec![source]);
    assert!(!instruction.contains(&second.execution_id));
    assert!(
        !tracker
            .final_reply_instruction(Some("channel"))
            .unwrap()
            .contains(&first.execution_id)
    );
}

#[test]
fn runtime_execution_preserves_all_sources_and_fences_late_turn_callbacks() {
    let tracker = AgentRuntimeStateTracker::new("codex_app_server");
    let sources: Vec<_> = (1..=3)
        .map(|n| super::protocol::AgentRuntimeMessageSource {
            channel_id: "channel".into(),
            message_id: format!("message:{n}"),
            sequence: n,
            entity_version: 2,
            body_hash: "a".repeat(64),
        })
        .collect();
    let mut old =
        tracker.begin_message_turn(Some("channel"), Some("message:1"), 3, sources.clone());
    assert_eq!(tracker.snapshot().execution.unwrap().sources, sources);
    let mut current = tracker.begin_message_turn(Some("channel"), Some("message:4"), 1, Vec::new());
    tracker.set_codex_turn(
        Some(&old.execution_id),
        "old-thread",
        Some("old-turn"),
        true,
    );
    old.finish_as("completed");
    assert_eq!(
        tracker.snapshot().active_message_id.as_deref(),
        Some("message:4")
    );
    assert!(tracker.snapshot().active_turn_id.is_none());
    assert_eq!(tracker.snapshot().recent_executions[0].state, "unknown");
    tracker.set_codex_turn(Some(&current.execution_id), "thread", Some("turn"), true);
    assert_eq!(tracker.snapshot().execution.unwrap().state, "running");
    current.finish_as("failed");
    let ended = tracker.snapshot();
    assert_eq!(ended.recent_executions.last().unwrap().state, "failed");
    assert!(ended.execution.is_none());
    let mut resumed =
        tracker.begin_message_turn(Some("channel"), Some("new-message"), 1, Vec::new());
    tracker.set_codex_turn(
        Some(&resumed.execution_id),
        "thread",
        Some("previous-turn"),
        false,
    );
    resumed.finish_as("completed");
    assert_eq!(
        tracker.snapshot().recent_executions.last().unwrap().state,
        "unknown",
        "resuming an old provider turn does not prove the newly received message ran"
    );
    for _ in 0..20 {
        tracker
            .begin_turn(Some("channel"), None)
            .finish_as("completed");
    }
    assert_eq!(tracker.snapshot().recent_executions.len(), 8);
}

#[test]
fn a_classified_turn_is_never_reported_as_unknown() {
    let tracker = AgentRuntimeStateTracker::new("acp");
    let source = protocol::AgentRuntimeMessageSource {
        channel_id: "channel".into(),
        message_id: "initial".into(),
        sequence: 1,
        entity_version: 1,
        body_hash: "a".repeat(64),
    };
    // The initial message's guard is closed with the outcome the runtime already
    // computed, so answering the summoning message reads as completed.
    let mut initial =
        tracker.begin_message_turn(Some("channel"), Some("initial"), 1, vec![source.clone()]);
    initial.finish_as("completed");
    assert_eq!(
        tracker.snapshot().recent_executions.last().unwrap().state,
        "completed"
    );
    let mut failed =
        tracker.begin_message_turn(Some("channel"), Some("second"), 1, vec![source.clone()]);
    failed.finish_as("failed");
    assert_eq!(
        tracker.snapshot().recent_executions.last().unwrap().state,
        "failed"
    );
    // Only a guard that unwinds without ever naming its outcome is unknown.
    drop(tracker.begin_message_turn(Some("channel"), Some("third"), 1, vec![source]));
    assert_eq!(
        tracker.snapshot().recent_executions.last().unwrap().state,
        "unknown"
    );
}

#[test]
fn codex_thread_activity_tracks_continuations_when_idle_precedes_completion() {
    let mut activity = CodexThreadActivity::new("thread-1", Some("turn-1"));
    let status = |kind: &str| {
        serde_json::json!({
            "threadId": "thread-1",
            "status": { "type": kind, "activeFlags": [] }
        })
    };
    let turn = |id: &str| {
        serde_json::json!({
            "threadId": "thread-1",
            "turn": { "id": id }
        })
    };

    assert_eq!(
        activity.observe(Some("thread/status/changed"), &status("idle")),
        CodexThreadActivityEvent::Idle
    );
    assert_eq!(
        activity.observe(Some("thread/status/changed"), &status("active")),
        CodexThreadActivityEvent::Active
    );
    assert_eq!(
        activity.observe(Some("turn/completed"), &turn("turn-1")),
        CodexThreadActivityEvent::TurnCompleted {
            turn_id: "turn-1".to_string()
        }
    );
    assert_eq!(
        activity.observe(Some("thread/status/changed"), &status("active")),
        CodexThreadActivityEvent::Active
    );
    assert_eq!(
        activity.observe(Some("turn/started"), &turn("turn-2")),
        CodexThreadActivityEvent::TurnStarted {
            turn_id: "turn-2".to_string(),
            continued: true
        }
    );
    assert_eq!(activity.active_turn_id(), Some("turn-2"));
    assert_eq!(
        activity.observe(Some("thread/status/changed"), &status("idle")),
        CodexThreadActivityEvent::Idle
    );
    assert_eq!(
        activity.observe(Some("turn/completed"), &turn("turn-2")),
        CodexThreadActivityEvent::TurnCompleted {
            turn_id: "turn-2".to_string()
        }
    );
}

#[test]
fn codex_thread_status_is_published_as_realtime_runtime_trace() {
    let active = serde_json::json!({
        "threadId": "thread-1",
        "status": { "type": "active", "activeFlags": [] }
    });
    let idle = serde_json::json!({
        "threadId": "thread-1",
        "status": { "type": "idle" }
    });

    assert!(should_publish_codex_runtime_trace(
        "thread/status/changed",
        &active
    ));
    let active_payload =
        codex_runtime_trace_payload("thread/status/changed", &active, "thread-1", Some("turn-1"));
    assert_eq!(active_payload["category"], "thread");
    assert_eq!(active_payload["status"], "started");
    assert_eq!(active_payload["details"]["status"]["type"], "active");

    let idle_payload =
        codex_runtime_trace_payload("thread/status/changed", &idle, "thread-1", Some("turn-2"));
    assert_eq!(idle_payload["category"], "thread");
    assert_eq!(idle_payload["status"], "completed");
    assert_eq!(idle_payload["details"]["status"]["type"], "idle");
}

#[test]
fn initial_message_context_is_scoped_and_does_not_turn_malformed_metadata_into_a_source() {
    let source = serde_json::json!({ "channelId": "channel", "messageId": "message", "sequence": 3,
        "entityVersion": 2, "bodyHash": "a".repeat(64) });
    let raw = serde_json::json!({ "initialMessageSource": source }).to_string();
    let context = parse_initial_spawn_context(&raw).unwrap();
    assert_eq!(
        super::scoped_initial_message_source(context.clone(), Some("channel"), "message")
            .unwrap()
            .entity_version,
        2
    );
    assert!(
        super::scoped_initial_message_source(context.clone(), Some("other"), "message").is_none()
    );
    assert!(super::scoped_initial_message_source(context, Some("channel"), "other").is_none());
    let invalid = serde_json::json!({ "initialMessageSource": { "bodyHash": "PRIVATE" },
        "goal": { "active": true, "objective": "preserved", "status": "active", "updatedAt": "1" } }).to_string();
    let context = parse_initial_spawn_context(&invalid).unwrap();
    assert!(context.initial_message_source.is_none());
    assert!(context.goal.is_some());
}

/// A goal the model queues for itself with `xmatrix goal` must land on the very
/// same path a channel-sent `/goal` takes. Rendering the queued record back to
/// its slash command is what keeps that true: Claude Code's own `/goal` stays
/// the only goal implementation, so the evaluator, the Stop hook, and the
/// transcript records all keep working unchanged.
#[test]
fn queued_self_goal_commands_reach_the_native_goal_grammar() {
    use crate::runtime_goal_inbox::{GoalInboxRecord, goal_command_text};

    let set_text = goal_command_text(&GoalInboxRecord::set("every call site compiles", 1))
        .expect("a set renders a slash command");
    assert_eq!(set_text, "/goal every call site compiles");
    let parsed_set = parse_goal_command(&set_text).expect("the rendered command parses back");
    assert_eq!(
        parsed_set,
        GoalCommand::Set {
            objective: "every call site compiles".to_string()
        }
    );
    assert_eq!(
        claude_goal_turn_input(&parsed_set, None),
        "/goal every call site compiles"
    );

    let clear_text =
        goal_command_text(&GoalInboxRecord::clear(2)).expect("a clear renders a slash command");
    let parsed_clear = parse_goal_command(&clear_text).expect("the rendered command parses back");
    assert_eq!(parsed_clear, GoalCommand::Clear);
    assert_eq!(claude_goal_turn_input(&parsed_clear, None), "/goal clear");

    // A malformed record must not silently degrade into "clear the goal".
    assert_eq!(
        goal_command_text(&GoalInboxRecord {
            action: "set".to_string(),
            condition: None,
            issued_at_millis: 3,
        }),
        None
    );
}

/// End to end for the self-goal path, from the file `xmatrix goal set` writes
/// to the `/goal` turn Claude actually receives on stdin.
///
/// The gap this closes is real: nothing else proves the queued record survives
/// the poller, arrives as a `LocalCommand`, and is submitted as a turn — the
/// three seams the delivery loop wires together.
#[tokio::test]
async fn a_queued_self_goal_reaches_claude_as_a_goal_turn() {
    let root = std::env::temp_dir().join(format!("xmatrix-self-goal-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).expect("create fake Claude root");
    let stdin_log = root.join("stdin.jsonl");

    // The wrapper starts watching at launch, then the model queues a goal from
    // inside its own turn — the same order a live run sees.
    let inbox = crate::runtime_goal_inbox::goal_inbox_path(&root, "instance:self-goal:1");
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
    let poller = crate::runtime_goal_inbox::spawn_goal_inbox_poller(inbox.clone(), event_tx);

    // The exact record `xmatrix goal set "keep the suite green"` appends.
    crate::runtime_goal_inbox::append_goal_command(
        &inbox,
        &crate::runtime_goal_inbox::GoalInboxRecord::set("keep the suite green", 1),
    )
    .expect("queue the goal the model set for itself");
    let event = tokio::time::timeout(Duration::from_secs(5), event_rx.recv())
        .await
        .expect("the poller should forward the queued goal")
        .expect("the poller should not drop its sender");
    let AgentInstanceConnectionEvent::LocalCommand { body } = event else {
        panic!("a queued goal must arrive as a self-issued local command");
    };
    assert_eq!(body, "/goal keep the suite green");
    poller.abort();

    // From here on this is exactly what the delivery loop's arm does.
    let command = parse_goal_command(&body).expect("the queued command parses");
    let mut agent = test_serialized_agent("claude-self-goal");
    agent.agent_type = "claude_code".to_string();
    let (relay, mut session) =
        mock_claude_stream_session(&root, &agent, "self-goal", Some(&stdin_log));
    let prompt = claude_goal_turn_input(&command, session.goals().current());
    let mut pending_events = VecDeque::new();
    tokio::time::timeout(
        Duration::from_secs(20),
        crate::runtime_claude_turn::run_claude_stream_turn(
            &mut session,
            prompt,
            None,
            None,
            "channel-self-goal".to_string(),
            None,
            None,
            &relay,
            &agent,
            false,
            false,
            Some(command),
            &mut event_rx,
            &mut pending_events,
        ),
    )
    .await
    .expect("the queued goal should run as a turn");

    // Claude received its own native `/goal` command, not a paraphrase of one.
    let stdin_lines = fs::read_to_string(&stdin_log).expect("read fake Claude stdin");
    let submitted = stdin_lines
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("valid fake Claude input"))
        .filter(|request| request["type"] == "user")
        .collect::<Vec<_>>();
    assert_eq!(submitted.len(), 1);
    assert_eq!(
        submitted[0]["message"]["content"][0]["text"],
        "/goal keep the suite green"
    );

    session.shutdown().await;
    fs::remove_dir_all(&root).ok();
}

/// The commands a Claude build enumerates in `system/init` (skills, custom
/// commands) stay in every later presence frame. Turn and switch frames used to
/// rebuild commands from the docs catalog alone, so the live list vanished from
/// Composer completion after the first turn.
#[tokio::test]
async fn claude_init_slash_commands_stay_in_the_session_presentation() {
    let root = std::env::temp_dir().join(format!("xmatrix-init-commands-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).expect("create fake Claude root");

    let mut agent = test_serialized_agent("claude-init-commands");
    agent.agent_type = "claude_code".to_string();
    let (relay, mut session) = mock_claude_stream_session(&root, &agent, "commands", None);
    let tokens = |session: &ClaudeStreamSession| {
        session
            .presentation()
            .snapshot(None)
            .commands
            .unwrap_or_default()
            .into_iter()
            .map(|command| command.token)
            .collect::<Vec<_>>()
    };
    assert!(!tokens(&session).contains(&"/ship-it".to_string()));

    let (_event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut pending_events = VecDeque::new();
    tokio::time::timeout(
        Duration::from_secs(20),
        crate::runtime_claude_turn::run_claude_stream_turn(
            &mut session,
            "hello".to_string(),
            None,
            None,
            "channel-init-commands".to_string(),
            None,
            None,
            &relay,
            &agent,
            false,
            false,
            None,
            &mut event_rx,
            &mut pending_events,
        ),
    )
    .await
    .expect("the turn should finish");

    let after = tokens(&session);
    assert!(after.contains(&"/ship-it".to_string()), "{after:?}");
    assert!(after.contains(&"/compact".to_string()), "{after:?}");
    assert!(after.contains(&"/model".to_string()), "{after:?}");

    session.shutdown().await;
    fs::remove_dir_all(&root).ok();
}

#[test]
fn parameter_controls_require_one_explicit_instance_and_never_consume_attachments() {
    let agent = test_serialized_agent("codex");
    let message = |body: &str| InboundChannelMessage {
        message_id: "parameter-message".into(),
        sequence: Some(1),
        channel_id: "channel".into(),
        body: body.into(),
        reply_to: None,
        attachments: None,
        entity_version: None,
        body_hash: None,
        from: test_sender("Yiming Hu"),
        reply_to_message_id: None,
        metadata: None,
    };
    let explicit = || message("@codex:1 /config future-speed turbo");
    assert_eq!(
        crate::single_message_parameter_control(&[explicit()], &agent),
        Some(Ok((
            "future-speed".into(),
            crate::harness_parameters::ParameterAction::Select("turbo".into())
        )))
    );
    assert!(
        crate::single_message_parameter_control(&[message("/config future-speed turbo")], &agent)
            .is_none()
    );
    let mut with_attachment = explicit();
    with_attachment.attachments = Some(vec![test_attachment("att-1", "one.png")]);
    assert!(crate::single_message_parameter_control(&[with_attachment], &agent).is_none());
    assert!(crate::single_message_parameter_control(&[explicit(), explicit()], &agent).is_none());
}
