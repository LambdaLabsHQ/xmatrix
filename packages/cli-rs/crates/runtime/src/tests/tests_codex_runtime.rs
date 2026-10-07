#[test]
fn websocket_combined_admission_does_not_repeat_the_final_remote_lease_confirmation() {
    assert!(!super::daemon_command_requires_final_remote_confirmation(
        true,
        super::DaemonSpawnDelivery::Socket,
    ));
    assert!(super::daemon_command_requires_final_remote_confirmation(
        false,
        super::DaemonSpawnDelivery::Socket,
    ));
}

#[test]
fn http_fallback_reconfirms_the_lease_immediately_before_spawn() {
    assert!(super::daemon_command_requires_final_remote_confirmation(
        true,
        super::DaemonSpawnDelivery::HttpFallback,
    ));
}

#[test]
fn server_agent_execution_adapter_overrides_stale_local_backend_fields() {
    let mut local = std::collections::BTreeMap::from([
        ("XMATRIX_AGENT_BACKEND".to_string(), "pty".to_string()),
        ("XMATRIX_AGENT_PRESET_ID".to_string(), "old".to_string()),
        ("XMATRIX_ACP_ARGS".to_string(), "[\"old\"]".to_string()),
        ("PROVIDER_SECRET".to_string(), "kept-local".to_string()),
    ]);
    local = super::apply_authoritative_agent_execution_env(
        local,
        Some("acp"),
        Some("custom"),
        &["acp".to_string()],
    )
    .unwrap();
    assert_eq!(
        local.get("XMATRIX_AGENT_BACKEND").map(String::as_str),
        Some("acp")
    );
    assert_eq!(
        local.get("XMATRIX_AGENT_PRESET_ID").map(String::as_str),
        Some("custom")
    );
    assert_eq!(
        local.get("XMATRIX_ACP_ARGS").map(String::as_str),
        Some("[\"acp\"]")
    );
    assert_eq!(
        local.get("PROVIDER_SECRET").map(String::as_str),
        Some("kept-local")
    );
    assert!(
        super::apply_authoritative_agent_execution_env(
            std::collections::BTreeMap::new(),
            Some("pty"),
            None,
            &["acp".to_string()],
        )
        .is_err()
    );
}

#[test]
fn daemon_run_file_labels_keep_long_management_runs_distinct() {
    let shared = "run:management:agent-focus-refresh:run:summon:1d948c910961f3263df970291835a1692aa20208fb63624cf659a4af9168c969:";
    let first = format!("{shared}a2502715-5edb-427b-a57f-334210b2d26b:agent:user:instance");
    let second = format!("{shared}64a50749-b559-4a59-990c-f9656aeacbe2:agent:user:instance");

    let first_label = super::daemon_run_file_label(Some(&first), None, "grok");
    let second_label = super::daemon_run_file_label(Some(&second), None, "grok");

    assert_ne!(first_label, second_label);
    assert!(first_label.len() <= 96);
    assert!(second_label.len() <= 96);
    assert_eq!(
        first_label,
        super::daemon_run_file_label(Some(&first), None, "grok")
    );
}

#[test]
fn daemon_run_file_labels_hash_short_sanitization_collisions() {
    let colon = super::daemon_run_file_label(Some("run:a:b"), None, "codex");
    let slash = super::daemon_run_file_label(Some("run:a/b"), None, "codex");
    let already_safe = super::daemon_run_file_label(Some("run-a-b"), None, "codex");

    assert_ne!(colon, slash);
    assert_ne!(colon, already_safe);
    assert_ne!(slash, already_safe);
    assert_eq!(already_safe, "run-a-b");
}

#[test]
fn codex_runtime_trace_payload_covers_current_app_server_thread_items() {
    let cases = vec![
        (
            "commandExecution",
            serde_json::json!({
                "id": "cmd-1",
                "type": "commandExecution",
                "status": "inProgress",
                "command": "git status --short",
                "commandActions": [{ "type": "execve", "command": "git" }],
                "cwd": "C:/Users/Daniel/Projects/xmatrix",
                "aggregatedOutput": " M packages/cli-rs/src/main.rs",
                "exitCode": 0,
                "durationMs": 42
            }),
        ),
        (
            "fileChange",
            serde_json::json!({
                "id": "file-1",
                "type": "fileChange",
                "status": "completed",
                "changes": [{ "path": "packages/cli-rs/src/main.rs", "kind": "update" }]
            }),
        ),
        (
            "mcpToolCall",
            serde_json::json!({
                "id": "mcp-1",
                "type": "mcpToolCall",
                "status": "completed",
                "server": "chrome_devtools",
                "tool": "take_snapshot",
                "arguments": { "verbose": false },
                "result": { "ok": true },
                "durationMs": 7
            }),
        ),
        (
            "dynamicToolCall",
            serde_json::json!({
                "id": "dyn-1",
                "type": "dynamicToolCall",
                "status": "completed",
                "namespace": "tool_search",
                "tool": "tool_search",
                "arguments": { "query": "browser" },
                "success": true
            }),
        ),
        (
            "collabAgentToolCall",
            serde_json::json!({
                "id": "collab-1",
                "type": "collabAgentToolCall",
                "status": "completed",
                "tool": "send_input",
                "senderThreadId": "thread-1",
                "receiverThreadIds": ["thread-2"],
                "agentsStates": []
            }),
        ),
        (
            "webSearch",
            serde_json::json!({
                "id": "web-1",
                "type": "webSearch",
                "query": "openai codex app-server schema",
                "action": { "type": "search" }
            }),
        ),
        (
            "imageView",
            serde_json::json!({
                "id": "image-view-1",
                "type": "imageView",
                "path": "C:/tmp/screenshot.png"
            }),
        ),
        (
            "imageGeneration",
            serde_json::json!({
                "id": "image-gen-1",
                "type": "imageGeneration",
                "status": "completed",
                "result": { "kind": "saved" },
                "savedPath": "C:/tmp/generated.png",
                "revisedPrompt": "diagram"
            }),
        ),
    ];

    for (item_type, item) in cases {
        let event = serde_json::json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "item": item
        });
        let payload =
            codex_runtime_trace_payload("item/completed", &event, "thread-1", Some("turn-1"));

        assert_eq!(payload["category"], "tool", "{item_type}");
        assert_eq!(payload["itemType"], item_type, "{item_type}");
        assert!(
            should_publish_codex_runtime_trace("item/completed", &event),
            "{item_type}"
        );
        assert!(payload.get("details").is_some(), "{item_type}");
    }
}

#[test]
fn codex_runtime_trace_payload_covers_current_app_server_tool_deltas() {
    let command_delta = serde_json::json!({
        "threadId": "thread-1",
        "turnId": "turn-1",
        "itemId": "cmd-1",
        "delta": "Exit code: 0\n"
    });
    let payload = codex_runtime_trace_payload(
        "item/commandExecution/outputDelta",
        &command_delta,
        "thread-1",
        Some("turn-1"),
    );
    assert_eq!(payload["category"], "tool");
    assert_eq!(payload["status"], "delta");
    assert_eq!(payload["itemId"], "cmd-1");
    assert_eq!(payload["details"]["delta"], "Exit code: 0\n");
    assert!(should_publish_codex_runtime_trace(
        "item/commandExecution/outputDelta",
        &command_delta
    ));

    let patch_update = serde_json::json!({
        "threadId": "thread-1",
        "turnId": "turn-1",
        "itemId": "file-1",
        "changes": [{ "path": "packages/cli-rs/src/main.rs", "kind": "update" }]
    });
    let payload = codex_runtime_trace_payload(
        "item/fileChange/patchUpdated",
        &patch_update,
        "thread-1",
        Some("turn-1"),
    );
    assert_eq!(payload["category"], "tool");
    assert_eq!(payload["itemId"], "file-1");
    assert_eq!(
        payload["details"]["changes"][0]["path"],
        "packages/cli-rs/src/main.rs"
    );

    let mcp_progress = serde_json::json!({
        "threadId": "thread-1",
        "turnId": "turn-1",
        "itemId": "mcp-1",
        "message": "calling tool"
    });
    let payload = codex_runtime_trace_payload(
        "item/mcpToolCall/progress",
        &mcp_progress,
        "thread-1",
        Some("turn-1"),
    );
    assert_eq!(payload["category"], "tool");
    assert_eq!(payload["itemId"], "mcp-1");
    assert_eq!(payload["details"]["message"], "calling tool");
}

#[test]
fn codex_runtime_trace_skips_assistant_message_items() {
    let event = serde_json::json!({
        "item": {
            "id": "msg-1",
            "type": "message",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": "already streamed" }]
        }
    });

    assert!(!should_publish_codex_runtime_trace(
        "responseItem/completed",
        &event
    ));
}

#[test]
fn codex_app_event_scope_prefers_the_active_turn_over_a_redirected_thread() {
    let redirected_item = serde_json::json!({
        "threadId": "thread-after-resume",
        "turnId": "turn-1",
        "item": { "id": "cmd-1", "type": "commandExecution" }
    });
    assert!(super::codex_app_event_matches_active_turn(
        &redirected_item,
        "thread-before-resume",
        Some("turn-1")
    ));

    let redirected_completion = serde_json::json!({
        "threadId": "thread-after-resume",
        "turn": { "id": "turn-1", "status": "completed" }
    });
    assert!(super::codex_app_event_matches_active_turn(
        &redirected_completion,
        "thread-before-resume",
        Some("turn-1")
    ));

    let another_turn = serde_json::json!({
        "threadId": "thread-before-resume",
        "turnId": "turn-2"
    });
    assert!(!super::codex_app_event_matches_active_turn(
        &another_turn,
        "thread-before-resume",
        Some("turn-1")
    ));
}

#[test]
fn codex_app_event_scope_falls_back_to_thread_for_thread_only_events() {
    assert!(super::codex_app_event_matches_active_turn(
        &serde_json::json!({ "threadId": "thread-1" }),
        "thread-1",
        Some("turn-1")
    ));
    assert!(!super::codex_app_event_matches_active_turn(
        &serde_json::json!({ "status": "updated" }),
        "thread-1",
        Some("turn-1")
    ));
}

#[test]
fn codex_app_event_turn_id_supports_nested_turns() {
    assert_eq!(
        super::codex_app_event_turn_id(&serde_json::json!({
            "turn": { "id": "turn-nested" }
        })),
        Some("turn-nested")
    );
    assert_eq!(
        super::codex_app_event_turn_id(&serde_json::json!({
            "turnId": "turn-direct",
            "turn": { "id": "turn-nested" }
        })),
        Some("turn-direct")
    );
}

#[test]
fn codex_thread_status_helpers_read_notifications_and_responses() {
    assert_eq!(
        super::codex_thread_status_type(&serde_json::json!({
            "threadId": "thread-1",
            "status": { "type": "idle" }
        })),
        Some("idle")
    );
    assert_eq!(
        super::codex_thread_response_status_type(&serde_json::json!({
            "thread": {
                "id": "thread-1",
                "status": { "type": "active", "activeFlags": [] }
            }
        })),
        Some("active")
    );
    assert!(!super::codex_thread_should_finish_after_completion(
        &serde_json::json!({
            "thread": {
                "id": "thread-1",
                "status": { "type": "active", "activeFlags": [] }
            }
        })
    ));
    assert!(super::codex_thread_should_finish_after_completion(
        &serde_json::json!({
            "thread": {
                "id": "thread-1",
                "status": { "type": "idle" }
            }
        })
    ));
}

#[test]
fn codex_thread_resume_excludes_turns_from_the_restore_payload() {
    let params = super::codex_thread_resume_params(
        "thread-377",
        Some("/tmp/workspace"),
        "never",
        "danger-full-access",
    );
    assert_eq!(params["threadId"], "thread-377");
    assert_eq!(params["excludeTurns"], true);
    assert!(params.get("turns").is_none());
    assert!(params.get("includeTurns").is_none());
}

#[test]
fn codex_resume_detects_an_interrupted_turn_from_queued_events() {
    let events = std::collections::VecDeque::from([
        serde_json::json!({
            "method": "turn/started",
            "params": {
                "threadId": "thread-1",
                "turn": { "id": "recovered-turn" }
            }
        }),
        serde_json::json!({
            "method": "item/started",
            "params": {
                "threadId": "thread-1",
                "turnId": "recovered-turn",
                "item": { "type": "commandExecution" }
            }
        }),
    ]);

    assert_eq!(
        super::codex_active_turn_id_from_events(&events, "thread-1").as_deref(),
        Some("recovered-turn")
    );
}

#[test]
fn codex_resume_does_not_reuse_a_completed_or_foreign_turn() {
    let events = std::collections::VecDeque::from([
        serde_json::json!({
            "method": "turn/started",
            "params": { "threadId": "other-thread", "turn": { "id": "foreign" } }
        }),
        serde_json::json!({
            "method": "turn/started",
            "params": { "threadId": "thread-1", "turn": { "id": "completed-turn" } }
        }),
        serde_json::json!({
            "method": "turn/completed",
            "params": { "threadId": "thread-1", "turn": { "id": "completed-turn" } }
        }),
    ]);

    assert!(super::codex_active_turn_id_from_events(&events, "thread-1").is_none());
}

#[test]
fn codex_runtime_trace_payload_normalizes_future_unknown_items() {
    let event = serde_json::json!({
        "item": {
            "id": "future-1",
            "type": "future_widget",
            "status": "warming",
            "value": "hello"
        },
        "extra": "kept in preview"
    });

    let payload = codex_runtime_trace_payload(
        "rawResponseItem/futureThing",
        &event,
        "thread-1",
        Some("turn-1"),
    );

    assert_eq!(payload["category"], "item");
    assert_eq!(payload["status"], "info");
    assert_eq!(payload["itemId"], "future-1");
    assert_eq!(payload["itemType"], "future_widget");
    assert!(
        payload["summary"]
            .as_str()
            .unwrap()
            .contains("future_widget")
    );
    assert!(
        payload["rawPreview"]
            .as_str()
            .unwrap()
            .contains("kept in preview")
    );
}

#[test]
fn codex_runtime_trace_payload_omits_assistant_message_text() {
    let event = serde_json::json!({
        "item": {
            "id": "msg-1",
            "type": "message",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": "assistant text should not render" }]
        }
    });

    let payload = codex_runtime_trace_payload(
        "rawResponseItem/completed",
        &event,
        "thread-1",
        Some("turn-1"),
    );

    assert_eq!(payload["category"], "message");
    assert_eq!(payload.get("rawPreview"), None);
    assert_eq!(payload["details"].get("content"), None);
    assert!(
        !payload
            .to_string()
            .contains("assistant text should not render")
    );
}

#[test]
fn codex_runtime_trace_value_redacts_and_truncates_sensitive_payloads() {
    let payload = serde_json::json!({
        "authorization": "Bearer secret-token",
        "nested": {
            "api_key": "secret",
            "image": "data:image/png;base64,abcdef"
        },
        "text": "x".repeat(1400)
    });

    let redacted = codex_runtime_trace_value(&payload, 0);

    assert_eq!(redacted["authorization"], "[redacted]");
    assert_eq!(redacted["nested"]["api_key"], "[redacted]");
    assert_eq!(redacted["nested"]["image"], "[data URL redacted: 28 chars]");
    assert!(redacted["text"].as_str().unwrap().contains("[truncated]"));
}

#[test]
fn codex_visible_output_prefers_primary_phase_over_commentary() {
    assert!(codex_is_primary_output_phase(Some(
        codex_primary_output_phase().as_str()
    )));
    assert!(!codex_is_primary_output_phase(Some("commentary")));
    assert!(codex_is_primary_output_phase(None));
    assert_eq!(
        codex_visible_output(" primary reply ", " commentary update "),
        "primary reply"
    );
    assert_eq!(
        codex_visible_output("   ", " commentary update "),
        "commentary update"
    );
}

#[test]
fn codex_visible_output_allows_empty_turn_text() {
    assert_eq!(codex_visible_output("  ", "\n\t"), "");
}

#[test]
fn codex_failure_local_output_includes_last_visible_output() {
    let answer = codex_failure_local_output(
        " primary update ",
        " progress update ",
        "Codex app-server connection lost",
    )
    .unwrap();

    assert!(answer.contains("connection lost"));
    assert!(answer.contains("Last visible output"));
    assert!(answer.contains("primary update"));
    assert!(!answer.contains("progress update"));
    assert!(codex_failure_local_output(" ", "\n", "failed").is_none());
}

#[test]
fn codex_turn_start_retry_only_covers_pre_start_transport_errors() {
    assert!(codex_turn_error_retryable_before_start(
        "codex app-server flush failed: The pipe is being closed. (os error 232)"
    ));
    assert!(codex_turn_error_retryable_before_start(
        "codex app-server exited"
    ));
    assert!(!codex_turn_error_retryable_before_start(
        "Codex app-server connection lost after final reconnect attempt"
    ));
}

#[test]
fn every_runtime_adapter_reports_turn_failure_through_the_protocol_helper() {
    let helper = include_str!("../runtime_codex_turn_errors.rs");
    assert!(helper.contains("pub(crate) fn report_turn_failure("));
    assert!(helper.contains("AGENT_TURN_FAILURE_LIFECYCLE_REASON"));
    assert!(helper.contains("pub(crate) fn report_turn_failure_with_usage_limit("));
    assert!(helper.contains("AGENT_USAGE_LIMIT_LIFECYCLE_REASON"));
    assert!(helper.contains("crate::send_agent_lifecycle_with_reset("));
    assert!(
        !helper.contains(".send_channel_message("),
        "turn failures must not DIY a channel message; Hub persists from the lifecycle"
    );

    let adapters = [
        (
            "runtime_codex_channel_session.rs",
            include_str!("../runtime_codex_channel_session.rs"),
        ),
        (
            "runtime_codex_channel_goals.rs",
            include_str!("../runtime_codex_channel_goals.rs"),
        ),
        (
            "runtime_external_cli_auth.rs",
            include_str!("../runtime_external_cli_auth.rs"),
        ),
        (
            "runtime_claude_turn.rs",
            include_str!("../runtime_claude_turn.rs"),
        ),
        (
            "runtime_headless_runs.rs",
            include_str!("../runtime_headless_runs.rs"),
        ),
    ];
    for (name, source) in adapters {
        assert!(
            source.contains("report_turn_failure(")
                || source.contains("report_turn_failure_with_usage_limit("),
            "{name} must report provider turn failures through report_turn_failure"
        );
        assert!(
            !source.contains("send_codex_turn_failure_notice("),
            "{name} must not DIY Codex turn-failure channel notices"
        );
        assert!(
            !source.contains("write_current_run_status(\"turn_failed\""),
            "{name} must not write turn_failed except via report_turn_failure"
        );
    }

    let dispatch = include_str!("../runtime_external_cli_auth.rs");
    for required in [
        "run_zcode_app_external",
        "run_grok_app_external",
        "run_acp_app_external",
    ] {
        assert!(
            dispatch.contains(required),
            "runtime dispatch must keep {required} on the shared turn-failure contract"
        );
    }
    let session = include_str!("../runtime_codex_channel_session.rs");
    assert!(session.contains("async fn run_codex_app_external("));
    let headless = include_str!("../runtime_headless_runs.rs");
    assert!(headless.contains("pub(crate) async fn run_claude_print_external("));
    assert!(headless.contains("pub(crate) async fn run_headless_external("));
}

#[test]
fn daemon_run_exit_detail_describes_active_phase_crash() {
    let marker = DaemonRunStatusMarker {
        phase: "turn_running".to_string(),
        pid: 123,
        updated_at_millis: 456,
        ..test_daemon_status_marker()
    };
    assert_eq!(
        daemon_run_exit_detail(Some(&marker), Some(1)).as_deref(),
        Some("agent process exited while processing a channel turn")
    );
    let completed = DaemonRunStatusMarker {
        completed: true,
        ..marker
    };
    assert_eq!(daemon_run_exit_detail(Some(&completed), Some(1)), None);
}

#[test]
fn daemon_run_status_preserves_model_snapshot() {
    let path = std::env::temp_dir().join(format!(
        "xmatrix-run-status-preserve-model-{}.json",
        std::process::id()
    ));

    write_daemon_run_status_marker_to_path(&path, "turn_running", false, None);
    let mut marker = read_daemon_run_status_marker(Some(&path)).unwrap();
    marker.model = Some("gpt-5-codex".to_string());
    std::fs::write(&path, serde_json::to_vec_pretty(&marker).unwrap()).unwrap();

    write_daemon_run_status_marker_to_path(&path, "turn_completed", true, None);

    let marker = read_daemon_run_status_marker(Some(&path)).unwrap();
    assert_eq!(marker.phase, "turn_completed");
    assert!(marker.completed);
    assert!(
        !marker.delivered,
        "local model completion has no Channel commit receipt"
    );
    assert_eq!(marker.model.as_deref(), Some("gpt-5-codex"));

    let _ = std::fs::remove_file(path);
}

#[test]
fn wake_metrics_accumulate_in_the_sidecar_and_become_one_record() {
    use crate::runtime_wake_metrics::{self, EndedRun, WakeObserver};
    let dir = std::env::temp_dir().join(format!("xmatrix-wake-sidecar-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("run-1.status.json");
    write_daemon_run_status_marker_to_path(&path, "turn_running", false, None);

    // The wrapper's observer writes its block as frames arrive.
    let mut observer = WakeObserver::new("claude_code".into(), true, true, Some(10_000));
    let persist = |observer: &WakeObserver| {
        let pid = std::process::id();
        super::update_daemon_run_status_marker(&path, |marker| {
            if marker.pid == pid {
                marker.wake = Some(observer.metrics().clone());
            }
        });
    };
    assert!(observer.observe_claude(&serde_json::json!({"type": "assistant"}), 12_500));
    persist(&observer);
    // Phase writes rebuild the marker and keep the block.
    write_daemon_run_status_marker_to_path(&path, "turn_running", false, None);
    assert!(observer.observe_claude(
        &serde_json::json!({"type": "system", "subtype": "compact_boundary"}),
        13_000
    ));
    assert!(observer.observe_claude(
        &serde_json::json!({"type": "result", "usage": {"input_tokens": 9, "cache_read_input_tokens": 2_000}}),
        14_000
    ));
    persist(&observer);
    write_daemon_run_status_marker_to_path(&path, "turn_completed", true, None);
    let marker = read_daemon_run_status_marker(Some(&path)).unwrap();
    let wake = marker.wake.clone().expect("block survives phase writes");
    assert_eq!(wake.compactions, Some(1));
    assert_eq!(wake.first_turn.as_ref().unwrap().total_input_tokens, 2_009);

    // The daemon appends it once the Run ends; a sleep followed by a resumed
    // Run of the same session is a wake.
    let metrics = runtime_wake_metrics::metrics_path(&dir);
    let end = |key: &str, pid: u32, end: &str| {
        runtime_wake_metrics::append_ended_run(
            &metrics,
            &EndedRun {
                registry_key: key,
                pid,
                resume_session_key: Some("session"),
                end,
                wake: &wake,
            },
            1,
            runtime_wake_metrics::METRICS_FILE_MAX_BYTES,
        )
        .unwrap()
    };
    assert!(end("run:first", 1, "sleeping"));
    assert!(end("run:second", 2, "sleeping"));
    let records = runtime_wake_metrics::read_records(&metrics);
    assert_eq!(records[0].launch, "resume");
    assert_eq!(records[1].launch, "wake");
    assert_eq!(records[1].first_response_ms, Some(2_500));
    assert_eq!(records[1].compactions, Some(1));

    // Another wrapper's marker does not inherit the block.
    let mut foreign = read_daemon_run_status_marker(Some(&path)).unwrap();
    foreign.pid = foreign.pid.wrapping_add(1);
    std::fs::write(&path, serde_json::to_vec_pretty(&foreign).unwrap()).unwrap();
    write_daemon_run_status_marker_to_path(&path, "turn_running", false, None);
    assert!(
        read_daemon_run_status_marker(Some(&path))
            .unwrap()
            .wake
            .is_none()
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn task_execution_survives_phase_writes_and_only_the_wrapper_pid_can_report_it() {
    let path =
        std::env::temp_dir().join(format!("xmatrix-task-marker-{}.json", uuid::Uuid::new_v4()));
    write_daemon_run_status_marker_to_path(&path, "runtime_ready", false, None);
    let mut tracker = super::AgentRuntimeStateTracker::new("test");
    tracker.marker_path = Some(path.clone());
    let mut task = tracker.begin_message_turn(
        Some("channel"),
        Some("message"),
        1,
        vec![super::protocol::AgentRuntimeMessageSource {
            channel_id: "channel".into(),
            message_id: "message".into(),
            sequence: 1,
            entity_version: 3,
            body_hash: "a".repeat(64),
        }],
    );
    task.finish_as("completed");
    write_daemon_run_status_marker_to_path(&path, "turn_completed", true, None);
    let marker = read_daemon_run_status_marker(Some(&path)).unwrap();
    assert_eq!(
        marker.task_execution.as_ref().unwrap().recent_executions[0].state,
        "completed"
    );
    assert!(!marker.delivered);
    let request = test_daemon_request_record("task", vec![], "workspace".into(), 30);
    let mut child = test_daemon_run_child(&request, std::process::id());
    child.status_file_path = Some(path.clone());
    let registry = std::collections::HashMap::from([("task".into(), child)]);
    let snapshot = super::daemon_run_snapshot_items_from_guard(&registry);
    let wire = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(
        wire[0]["taskExecution"]["recentExecutions"][0]["sources"][0]["entityVersion"],
        3
    );
    let mut malformed = serde_json::to_value(&marker).unwrap();
    malformed["taskExecution"] = serde_json::json!({"execution":"malformed optional observation"});
    let compatible: DaemonRunStatusMarker = serde_json::from_value(malformed).unwrap();
    assert_eq!(compatible.phase, "turn_completed");
    assert!(compatible.task_execution.is_none());
    write_foreign_status_marker(&path, marker);
    assert!(
        super::daemon_run_snapshot_items_from_guard(&registry)[0]
            .task_execution
            .is_none()
    );
    std::fs::remove_file(path).unwrap();
}

#[test]
fn execution_status_never_fabricates_delivery_and_delivery_alone_is_not_terminal() {
    let path = std::env::temp_dir().join(format!(
        "xmatrix-execution-without-receipt-{}.json",
        std::process::id()
    ));
    for phase in ["turn_completed", "turn_failed", "wrapper_startup_failed"] {
        write_daemon_run_status_marker_to_path(&path, phase, true, None);
        let mut marker = read_daemon_run_status_marker(Some(&path)).unwrap();
        assert!(marker.completed);
        assert!(!marker.delivered);
        assert!(super::daemon_run_status_is_terminal(&marker));
        // An old wrapper's delivery bit is not evidence that its process ended.
        marker.phase = "turn_running".to_string();
        marker.completed = false;
        marker.delivered = true;
        assert!(!super::daemon_run_status_is_terminal(&marker));
    }
    let _ = std::fs::remove_file(path);
}

fn replacement_ready_marker(
    pid: u32,
    version: &str,
    ready_at: Option<u64>,
) -> DaemonRunStatusMarker {
    DaemonRunStatusMarker {
        phase: "turn_running".to_string(),
        pid,
        updated_at_millis: 1_000,
        wrapper_version: Some(version.to_string()),
        wrapper_ready_at_millis: ready_at,
        ..test_daemon_status_marker()
    }
}

#[test]
fn replacement_wrapper_is_ready_only_on_this_handoff_s_own_proof() {
    use super::replacement_wrapper_is_ready;
    let started = 5_000;

    // The replacement registered and rejoined under the installed version.
    assert!(replacement_wrapper_is_ready(
        &replacement_ready_marker(4242, "0.15.48", Some(started + 10)),
        4242,
        "0.15.48",
        started,
    ));

    // Started but never reported ready: this is the shape that used to retire a
    // working wrapper and leave the run mute.
    assert!(!replacement_wrapper_is_ready(
        &replacement_ready_marker(4242, "0.15.48", None),
        4242,
        "0.15.48",
        started,
    ));

    // A stamp the retiring wrapper left behind before the handoff is not proof.
    assert!(!replacement_wrapper_is_ready(
        &replacement_ready_marker(4242, "0.15.48", Some(started - 1)),
        4242,
        "0.15.48",
        started,
    ));

    // The status file is still owned by some other pid.
    assert!(!replacement_wrapper_is_ready(
        &replacement_ready_marker(999, "0.15.48", Some(started + 10)),
        4242,
        "0.15.48",
        started,
    ));

    // Ready, but it is the old binary — the install did not take.
    assert!(!replacement_wrapper_is_ready(
        &replacement_ready_marker(4242, "0.15.47", Some(started + 10)),
        4242,
        "0.15.48",
        started,
    ));
}

#[test]
fn wrapper_ready_stamp_survives_phase_rewrites_and_rides_the_camel_case_wire() {
    let path = std::env::temp_dir().join(format!(
        "xmatrix-run-status-wrapper-ready-{}.json",
        std::process::id()
    ));

    write_daemon_run_status_marker_to_path(&path, "turn_running", false, None);
    assert!(
        read_daemon_run_status_marker(Some(&path))
            .unwrap()
            .wrapper_ready_at_millis
            .is_none()
    );

    // Stamp through the same update path `mark_daemon_run_wrapper_ready` uses.
    use super::update_daemon_run_status_marker;
    assert!(update_daemon_run_status_marker(&path, |marker| {
        marker.wrapper_ready_at_millis = Some(7_777);
    }));
    let marker = read_daemon_run_status_marker(Some(&path)).unwrap();
    assert_eq!(marker.wrapper_ready_at_millis, Some(7_777));
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(raw.contains("\"wrapperReadyAtMillis\""));

    // A later phase write must not drop the proof the handoff waits on.
    write_daemon_run_status_marker_to_path(&path, "turn_completed", true, None);
    let marker = read_daemon_run_status_marker(Some(&path)).unwrap();
    assert_eq!(marker.phase, "turn_completed");
    assert_eq!(marker.wrapper_ready_at_millis, Some(7_777));

    let _ = std::fs::remove_file(path);
}

#[test]
fn daemon_run_status_heartbeat_records_and_full_writes_preserve_wrapper_recipe() {
    let path = std::env::temp_dir().join(format!(
        "xmatrix-run-status-wrapper-recipe-{}.json",
        std::process::id()
    ));

    write_daemon_run_status_marker_to_path(&path, "turn_running", false, None);
    // The heartbeat records the owning process's exact respawn recipe.
    assert!(refresh_daemon_run_status_heartbeat(&path));
    let marker = read_daemon_run_status_marker(Some(&path)).unwrap();
    assert!(marker.wrapper_exe.is_some());
    assert_eq!(
        marker.wrapper_args,
        Some(std::env::args().skip(1).collect::<Vec<_>>())
    );
    assert_eq!(
        marker.wrapper_version.as_deref(),
        Some(xmatrix_cli_core::version::current())
    );
    // Serialized names are the camelCase wire fields update-self reads.
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(raw.contains("\"wrapperExe\""));
    assert!(raw.contains("\"wrapperArgs\""));
    assert!(raw.contains("\"wrapperVersion\""));

    // Phase rewrites must not drop the recorded recipe.
    write_daemon_run_status_marker_to_path(&path, "turn_completed", true, None);
    let marker = read_daemon_run_status_marker(Some(&path)).unwrap();
    assert_eq!(marker.phase, "turn_completed");
    assert!(marker.wrapper_exe.is_some());
    assert_eq!(
        marker.wrapper_version.as_deref(),
        Some(xmatrix_cli_core::version::current())
    );

    let _ = std::fs::remove_file(path);
}

#[test]
fn codex_config_model_reads_top_level_model() {
    let raw = r#"
model = "gpt-5.5"
model_reasoning_effort = "medium"

[profiles.fast]
model = "gpt-4.1"
"#;

    assert_eq!(codex_config_model_from_str(raw).as_deref(), Some("gpt-5.5"));
}

#[test]
fn codex_model_catalog_maps_picker_fields() {
    let response = serde_json::json!({
        "data": [
            {
                "id": "gpt-5.4",
                "model": "gpt-5.4",
                "displayName": "GPT-5.4",
                "hidden": false,
                "isDefault": true,
                "defaultReasoningEffort": "medium",
                "supportedReasoningEfforts": [
                    { "reasoningEffort": "low", "description": "Lower latency" }
                ],
                "inputModalities": ["text", "image"],
                "supportsPersonality": true,
                "upgrade": "gpt-5.5"
            },
            { "displayName": "missing id" }
        ],
        "nextCursor": null
    });
    let models = codex_model_catalog_from_response(&response);
    assert_eq!(models.len(), 1);
    let model = &models[0];
    assert_eq!(model.id, "gpt-5.4");
    assert_eq!(model.model, "gpt-5.4");
    assert_eq!(model.display_name.as_deref(), Some("GPT-5.4"));
    assert_eq!(model.is_default, Some(true));
    assert_eq!(model.default_reasoning_effort.as_deref(), Some("medium"));
    assert_eq!(
        model.supported_reasoning_efforts.as_ref().unwrap()[0].reasoning_effort,
        "low"
    );
    assert_eq!(
        model.input_modalities.as_deref(),
        Some(["text".to_string(), "image".to_string()].as_slice())
    );
    assert_eq!(model.supports_personality, Some(true));
    assert_eq!(model.upgrade.as_deref(), Some("gpt-5.5"));
}

#[test]
fn codex_turn_start_uses_selected_model_override() {
    let params = codex_turn_start_params(
        "thread-1",
        vec![serde_json::json!({ "type": "text", "text": "continue" })],
        Some(" gpt-5.5 "),
        Some(" high "),
        None,
    );
    assert_eq!(params["effort"], "high");
    assert_eq!(params["threadId"], "thread-1");
    assert_eq!(params["model"], "gpt-5.5");
    assert_eq!(params["input"][0]["text"], "continue");
}

#[test]
fn codex_turn_start_injects_trusted_developer_instructions() {
    let params = codex_turn_start_params(
        "thread-1",
        vec![serde_json::json!({ "type": "text", "text": "continue" })],
        None,
        None,
        Some("follow the trusted channel contract"),
    );
    assert!(
        params["developerInstructions"]
            .as_str()
            .is_some_and(|value| value.contains("follow the trusted channel contract"))
    );
    assert_eq!(params["input"][0]["text"], "continue");
}

#[test]
fn codex_channel_turn_injects_channel_send_contract_as_developer_instruction() {
    let instructions =
        super::codex_channel_developer_instructions(Some("channel-123")).expect("channel contract");
    let params = codex_turn_start_params(
        "thread-1",
        vec![serde_json::json!({ "type": "text", "text": "reply READY" })],
        None,
        None,
        Some(&instructions),
    );
    let developer = params["developerInstructions"]
        .as_str()
        .expect("developer instructions");
    assert!(developer.contains("Channel-visible replies are explicit"));
    assert!(developer.contains("xmatrix send channel-123"));
}

#[test]
fn codex_config_model_ignores_profile_model() {
    let raw = r#"
[profiles.fast]
model = "gpt-4.1"
"#;

    assert_eq!(codex_config_model_from_str(raw), None);
}

#[tokio::test]
async fn finished_daemon_child_stays_registered_until_reported() {
    #[cfg(windows)]
    let child = std::process::Command::new("cmd.exe")
        .args(["/D", "/C", "exit", "0"])
        .spawn()
        .expect("spawn short-lived native Windows child");
    #[cfg(not(windows))]
    let child = std::process::Command::new("sh")
        .arg("-c")
        .arg("exit 0")
        .spawn()
        .expect("spawn short-lived POSIX child");
    let registry: DaemonRunRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let key = "run:retry-exit".to_string();
    registry.lock().await.insert(
        key.clone(),
        DaemonRunChild {
            pid: child.id(),
            child: Some(child),
            run_id: Some("retry-exit".to_string()),
            agent_name: Some("codex".to_string()),
            ..test_empty_daemon_run_child()
        },
    );

    let exits = collect_finished_test_children(
        &registry,
        Duration::from_secs(2),
        Duration::from_millis(10),
    )
    .await;

    assert_eq!(exits.len(), 1);
    assert_eq!(exits[0].registry_key.as_deref(), Some(key.as_str()));
    assert!(
        registry.lock().await.contains_key(&key),
        "exit report should remain retryable until relay delivery succeeds"
    );

    remove_daemon_run_child(&registry, &key, "test_cleanup").await;
    assert!(!registry.lock().await.contains_key(&key));
}

#[cfg(windows)]
#[tokio::test]
async fn finished_daemon_child_terminates_owned_job_before_reporting_exit() {
    let pid_file = std::env::temp_dir().join(format!(
        "xmatrix-daemon-owned-job-{}.pid",
        uuid::Uuid::new_v4()
    ));
    let script = concat!(
        "$child = Start-Process -FilePath $env:ComSpec ",
        "-ArgumentList '/d','/c','ping -n 30 127.0.0.1 > nul' ",
        "-WindowStyle Hidden -PassThru; ",
        "[IO.File]::WriteAllText($env:XMATRIX_TEST_CHILD_PID_FILE, [string]$child.Id); ",
        "Start-Sleep -Milliseconds 250"
    );
    let mut command = std::process::Command::new("powershell");
    command
        .args(["-NoProfile", "-Command", script])
        .env("XMATRIX_TEST_CHILD_PID_FILE", &pid_file)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let mut child = command.spawn().expect("spawn wrapper with descendant");
    let process_tree =
        process_tree::guard_std_child(&mut child).expect("bind daemon-owned process-tree job");

    let descendant = {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Ok(value) = std::fs::read_to_string(&pid_file) {
                if let Ok(pid) = value.trim().parse::<u32>() {
                    break pid;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "descendant pid file was not written"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    };
    assert!(
        process_tree::process_alive(descendant),
        "test setup must keep the provider helper alive after its wrapper exits"
    );

    let registry: DaemonRunRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let key = "run:owned-job-exit".to_string();
    registry.lock().await.insert(
        key.clone(),
        DaemonRunChild {
            pid: child.id(),
            child: Some(child),
            process_tree: Some(process_tree),
            run_id: Some("owned-job-exit".to_string()),
            agent_name: Some("codex".to_string()),
            ..test_empty_daemon_run_child()
        },
    );

    let exits = collect_finished_test_children(
        &registry,
        Duration::from_secs(5),
        Duration::from_millis(20),
    )
    .await;

    assert_eq!(exits.len(), 1);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while process_tree::process_alive(descendant) && std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(
        !process_tree::process_alive(descendant),
        "repo-pool exit must close the daemon-owned job before the slot can be retained"
    );

    remove_daemon_run_child(&registry, &key, "test_cleanup").await;
    let _ = std::fs::remove_file(pid_file);
}

#[tokio::test]
async fn daemon_rehydrate_keeps_dead_wrapper_registered_until_tree_cleanup() {
    let mut command = if cfg!(windows) {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "exit 0"]);
        command
    } else {
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "exit 0"]);
        command
    };
    let mut child = command.spawn().expect("spawn short-lived wrapper");
    let pid = child.id();
    child.wait().expect("wait for short-lived wrapper");
    let run = PersistedDaemonRun {
        pid,
        run_id: Some("rehydrate-dead".to_string()),
        agent_name: Some("codex".to_string()),
        updated_at: "1".to_string(),
        ..test_empty_persisted_daemon_run()
    };
    let registry: DaemonRunRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let key = "run:rehydrate-dead";

    let loaded =
        rehydrate_daemon_run_registry_from_persisted_runs(&registry, vec![run], None, None, false)
            .await;

    assert_eq!(loaded, 1);
    assert!(
        registry.lock().await.contains_key(key),
        "dead wrapper evidence must survive rehydrate until descendant cleanup"
    );
    let exits = collect_finished_daemon_children(&registry).await;
    assert_eq!(exits.len(), 1);
    assert_eq!(exits[0].registry_key.as_deref(), Some(key));
    assert!(
        registry.lock().await.contains_key(key),
        "cleaned run remains retryable until terminal reporting succeeds"
    );

    remove_daemon_run_child(&registry, key, "test_cleanup").await;
}

#[cfg(unix)]
#[tokio::test]
async fn daemon_rehydrate_adopts_live_persisted_run_before_snapshot() {
    let temp_dir = std::env::temp_dir().join(format!(
        "xmatrix-daemon-rehydrate-test-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&temp_dir).expect("create rehydrate test dir");
    let mut child = std::process::Command::new("sh")
        .args(["-c", "sleep 30"])
        .spawn()
        .expect("spawn live child");
    let pid = child.id();
    let raw_capability = "rehydrate-auth-capability";
    let capability_key = daemon_capability_key(raw_capability);
    let run = PersistedDaemonRun {
        pid,
        cwd: Some(temp_dir.clone()),
        run_id: Some("run:pre-restart".to_string()),
        execution_key: Some("execution-pre-restart".to_string()),
        agent_id: Some("agent:pre-restart".to_string()),
        agent_name: Some("codex-test".to_string()),
        auth_capability: Some(capability_key.clone()),
        request_context: Some(super::DaemonRequestAgentContext {
            agent_id: Some("agent:pre-restart".to_string()),
            agent_name: "codex-test".to_string(),
            space_id: "space:pre-restart".to_string(),
            approval_channel_id: Some("channel:pre-restart".to_string()),
            channel_id: "channel:pre-restart".to_string(),
            run_id: Some("run:pre-restart".to_string()),
            execution_key: Some("execution-pre-restart".to_string()),
            workspace_cwd: temp_dir.display().to_string(),
            admitted_secrets: None,
        }),
        stdout_log_path: Some(temp_dir.join("run-pre-restart.out.log")),
        stderr_log_path: Some(temp_dir.join("run-pre-restart.err.log")),
        updated_at: "1".to_string(),
        ..test_empty_persisted_daemon_run()
    };
    let registry: DaemonRunRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let auth_broker = test_daemon_auth_broker();
    let capabilities = auth_broker.capabilities.clone();

    let loaded = rehydrate_daemon_run_registry_from_persisted_runs(
        &registry,
        vec![run],
        Some(&auth_broker),
        None,
        false,
    )
    .await;

    assert_eq!(loaded, 1);
    assert!(registry.lock().await.contains_key("run:run:pre-restart"));
    {
        let restored = capabilities.lock().expect("auth capabilities");
        assert_eq!(
            restored.len(),
            1,
            "rehydration restores one exact-scope proof"
        );
        assert!(restored.contains_key(&capability_key));
        assert!(!restored.contains_key(raw_capability));
    }
    assert!(
        take_daemon_agent_auth_grant(&capabilities, raw_capability).is_some(),
        "the surviving wrapper's raw capability must satisfy the persisted verifier"
    );
    assert!(take_daemon_agent_auth_grant(&capabilities, "wrong-capability").is_none());
    assert_daemon_registry_snapshot(&registry, "run:pre-restart", pid).await;

    remove_daemon_run_child(&registry, "run:run:pre-restart", "test_cleanup").await;
    assert!(
        capabilities.lock().expect("auth capabilities").is_empty(),
        "dropping a rehydrated child must revoke its restored daemon auth grant"
    );

    child.kill().expect("kill live child");
    let _ = child.wait();
    let _ = fs::remove_dir_all(temp_dir);
}

#[cfg(unix)]
#[tokio::test]
async fn daemon_registry_recovers_live_child_from_recent_sidecar() {
    let temp_dir = std::env::temp_dir().join(format!(
        "xmatrix-daemon-sidecar-test-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&temp_dir).expect("create sidecar test dir");
    let mut child = std::process::Command::new("sh")
        .args(["-c", "sleep 30"])
        .spawn()
        .expect("spawn live child");
    let pid = child.id();
    let status_file_path = temp_dir.join("run-test-sidecar.status.json");
    let marker = DaemonRunStatusMarker {
        phase: "codex_app_ready".to_string(),
        pid,
        updated_at_millis: u64::MAX,
        ..test_daemon_status_marker()
    };
    assert!(persist_daemon_run_status_marker(&status_file_path, &marker));
    let raw_auth_capability = "sidecar-auth-capability";
    let raw_request_capability = "sidecar-request-capability";
    let auth_capability_key = daemon_capability_key(raw_auth_capability);
    let request_capability_key = daemon_capability_key(raw_request_capability);
    let run = PersistedDaemonRun {
        pid,
        cwd: Some(temp_dir.clone()),
        run_id: Some("run:test-sidecar".to_string()),
        execution_key: Some("execution-test-sidecar".to_string()),
        agent_id: Some("agent:test-sidecar".to_string()),
        agent_name: Some("codex-test".to_string()),
        auth_capability: Some(auth_capability_key.clone()),
        request_capability: Some(request_capability_key.clone()),
        request_context: Some(super::DaemonRequestAgentContext {
            agent_id: Some("agent:test-sidecar".to_string()),
            agent_name: "codex-test".to_string(),
            space_id: "space:test-sidecar".to_string(),
            approval_channel_id: Some("channel:test-sidecar".to_string()),
            channel_id: "channel:test-sidecar".to_string(),
            run_id: Some("run:test-sidecar".to_string()),
            execution_key: Some("execution-test-sidecar".to_string()),
            workspace_cwd: temp_dir.display().to_string(),
            admitted_secrets: None,
        }),
        status_file_path: Some(status_file_path),
        stdout_log_path: Some(temp_dir.join("run-test-sidecar.out.log")),
        stderr_log_path: Some(temp_dir.join("run-test-sidecar.err.log")),
        updated_at: "1".to_string(),
        ..test_empty_persisted_daemon_run()
    };
    assert!(persist_daemon_run_sidecar(&run));
    let sidecar_path = daemon_run_sidecar_path(&run).expect("sidecar path");
    assert!(sidecar_path.exists());
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = fs::metadata(&sidecar_path)
            .expect("sidecar metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        fs::set_permissions(&temp_dir, fs::Permissions::from_mode(0o770))
            .expect("make recovery directory group-accessible");
    }

    let registry: DaemonRunRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let auth_broker = test_daemon_auth_broker();
    let capabilities = auth_broker.capabilities.clone();
    let request_broker = test_daemon_request_broker(Vec::new());
    let rejected = recover_daemon_run_registry_from_sidecars_in_dir(
        &registry,
        &temp_dir,
        Some(&auth_broker),
        Some(&request_broker),
        false,
    )
    .await;
    assert_eq!(
        rejected, 0,
        "group-writable run directories must not recover process control"
    );
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(&temp_dir, fs::Permissions::from_mode(0o700))
            .expect("make recovery directory owner-only");
    }
    let recovered = recover_daemon_run_registry_from_sidecars_in_dir(
        &registry,
        &temp_dir,
        Some(&auth_broker),
        Some(&request_broker),
        false,
    )
    .await;

    assert_eq!(recovered, 1);
    let recovered_again = recover_daemon_run_registry_from_sidecars_in_dir(
        &registry,
        &temp_dir,
        Some(&auth_broker),
        Some(&request_broker),
        false,
    )
    .await;
    assert_eq!(
        recovered_again, 0,
        "existing sidecar entries should restore grants without duplicating registry entries"
    );
    assert!(registry.lock().await.contains_key("run:run:test-sidecar"));
    {
        let restored = capabilities.lock().expect("auth capabilities");
        assert_eq!(restored.len(), 1);
        assert!(restored.contains_key(&auth_capability_key));
        assert!(!restored.contains_key(raw_auth_capability));
    }
    assert!(
        take_daemon_agent_auth_grant(&capabilities, raw_auth_capability).is_some(),
        "the surviving auth proof should work after sidecar recovery"
    );
    {
        let request_capabilities = request_broker
            .agent_capabilities
            .lock()
            .expect("request capabilities");
        assert!(request_capabilities.contains_key(&request_capability_key));
        assert!(!request_capabilities.contains_key(raw_request_capability));
        let context = request_capabilities
            .values()
            .next()
            .expect("rotated request grant should be available immediately");
        assert_eq!(context.agent_id.as_deref(), Some("agent:test-sidecar"));
        assert_eq!(context.channel_id, "channel:test-sidecar");
        assert_eq!(request_capabilities.len(), 1);
    }
    assert_daemon_registry_snapshot(&registry, "run:test-sidecar", pid).await;

    remove_daemon_run_child(&registry, "run:run:test-sidecar", "test_cleanup").await;
    assert!(
        capabilities.lock().expect("auth capabilities").is_empty(),
        "dropping a recovered child must revoke its restored daemon auth grant"
    );
    assert!(
        request_broker
            .agent_capabilities
            .lock()
            .expect("request capabilities")
            .is_empty(),
        "dropping a recovered child must revoke its restored daemon request grant"
    );

    child.kill().expect("kill live child");
    let _ = child.wait();
    let _ = fs::remove_dir_all(temp_dir);
}

#[cfg(unix)]
#[tokio::test]
async fn daemon_registry_rejects_sidecar_without_matching_process_heartbeat() {
    let temp_dir = std::env::temp_dir().join(format!(
        "xmatrix-daemon-sidecar-mismatch-test-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&temp_dir).expect("create sidecar mismatch test dir");
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(&temp_dir, fs::Permissions::from_mode(0o700))
            .expect("make mismatch test directory owner-only");
    }
    let mut child = std::process::Command::new("sh")
        .args(["-c", "sleep 30"])
        .spawn()
        .expect("spawn live child");
    let pid = child.id();
    let status_file_path = temp_dir.join("run-test-mismatch.status.json");
    let marker = DaemonRunStatusMarker {
        phase: "codex_app_ready".to_string(),
        pid: pid.saturating_add(1),
        updated_at_millis: u64::MAX,
        ..test_daemon_status_marker()
    };
    assert!(persist_daemon_run_status_marker(&status_file_path, &marker));
    let run = PersistedDaemonRun {
        pid,
        cwd: Some(temp_dir.clone()),
        run_id: Some("run:test-mismatch".to_string()),
        agent_name: Some("codex-test".to_string()),
        status_file_path: Some(status_file_path),
        updated_at: "1".to_string(),
        ..test_empty_persisted_daemon_run()
    };
    assert!(persist_daemon_run_sidecar(&run));

    let registry: DaemonRunRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let recovered =
        recover_daemon_run_registry_from_sidecars_in_dir(&registry, &temp_dir, None, None, false)
            .await;

    assert_eq!(recovered, 0);
    assert!(registry.lock().await.is_empty());

    child.kill().expect("kill live child");
    let _ = child.wait();
    let _ = fs::remove_dir_all(temp_dir);
}

#[test]
fn daemon_run_status_heartbeat_preserves_state_and_refreshes_pid() {
    let temp_dir = std::env::temp_dir().join(format!(
        "xmatrix-daemon-heartbeat-test-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&temp_dir).expect("create heartbeat test dir");
    let path = temp_dir.join("run-heartbeat.status.json");
    let marker = DaemonRunStatusMarker {
        phase: "turn_completed".to_string(),
        completed: true,
        delivered: true,
        detail: Some("message-1".to_string()),
        model: Some("gpt-test".to_string()),
        pid: 1,
        updated_at_millis: 1,
        ..test_daemon_status_marker()
    };
    assert!(persist_daemon_run_status_marker(&path, &marker));

    assert!(refresh_daemon_run_status_heartbeat(&path));
    let refreshed = read_daemon_run_status_marker(Some(&path)).expect("refreshed marker");
    assert_eq!(refreshed.phase, marker.phase);
    assert_eq!(refreshed.completed, marker.completed);
    assert_eq!(refreshed.delivered, marker.delivered);
    assert_eq!(refreshed.detail, marker.detail);
    assert_eq!(refreshed.model, marker.model);
    assert_eq!(refreshed.pid, std::process::id());
    assert!(refreshed.updated_at_millis > marker.updated_at_millis);

    let _ = fs::remove_dir_all(temp_dir);
}

/// One plain Codex spawn request; tests change the fields they are about.
fn daemon_test_spawn_request() -> super::DaemonSpawnRequest {
    super::DaemonSpawnRequest {
        registration: None,
        launch_id: None,
        request_id: "request-a".to_string(),
        space_id: "space-a".to_string(),
        run_id: Some("run-a".to_string()),
        instance_id: Some("instance-a".to_string()),
        launcher_id: None,
        materializer_id: None,
        execution_key: Some("exec-a".to_string()),
        workspace: protocol::DaemonSpawnWorkspace {
            managed_key: None,
            location: protocol::WorkspaceLocation {
                owner_user_id: "owner-a".to_string(),
                machine_id: "machine-a".to_string(),
                hostname: None,
                canonical_cwd: "C:/workspace-a".to_string(),
                display_name: "workspace-a".to_string(),
                repo_root: None,
                git_remote: None,
                git_branch: None,
            },
            runtimes_seen: vec![],
            bound_channel_ids: vec![],
            visibility: "private".to_string(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            last_seen_at: "1".to_string(),
            metadata: None,
        },
        management_space_id: None,
        channel_id: "channel-a".to_string(),
        runtime: "codex".to_string(),
        runtime_args: vec![],
        agent_backend: None,
        agent_preset_id: None,
        harness: None,
        agent_acp_args: vec![],
        agent_name: "codex-a".to_string(),
        identity_id: None,
        role_initial_prompt: None,
        working_mode: None,
        space_rules_page_id: None,
        resume: false,
        resume_instance_id: None,
        resume_session_key: Some("session-a".to_string()),
        repo_identity: None,
        repo_key_id: None,
        slot_id: None,
        resume_worktree_bootstrap: false,
        handoff_transfer: false,
        handoff_source_instance_id: None,
        handoff_source_resume_session_key: None,
        goal: None,
        run_worktree: false,
        remote_repo: None,
        source_message_id: Some("message-a".to_string()),
        initial_message_source: None,
        requested_model: None,
        requested_effort: None,
        requested_parameters: None,
        prompt: "test".to_string(),
        attachments: None,
        relay_lease: None,
    }
}

#[test]
fn daemon_repo_pool_authority_admits_reborn_and_handoff_only() {
    let slot = |intent: super::DaemonSpawnRequest| super::DaemonSpawnRequest {
        repo_identity: Some("github.com/acme/app".to_string()),
        repo_key_id: Some("b".repeat(64)),
        slot_id: Some("c".repeat(32)),
        run_worktree: true,
        remote_repo: Some("acme/app".to_string()),
        ..intent
    };
    assert!(!super::daemon_repo_pool_authority(&daemon_test_spawn_request()).unwrap());
    // A reborn resumes its retained slot.
    assert!(
        super::daemon_repo_pool_authority(&slot(super::DaemonSpawnRequest {
            resume: true,
            ..daemon_test_spawn_request()
        }))
        .unwrap()
    );
    // A same-machine handoff transfers it to a new Instance without resuming.
    assert!(
        super::daemon_repo_pool_authority(&slot(super::DaemonSpawnRequest {
            handoff_transfer: true,
            ..daemon_test_spawn_request()
        }))
        .unwrap()
    );
    // Any other spawn naming a slot is refused, as is a partial or misplaced one.
    assert!(super::daemon_repo_pool_authority(&slot(daemon_test_spawn_request())).is_err());
    assert!(
        super::daemon_repo_pool_authority(&super::DaemonSpawnRequest {
            slot_id: Some("c".repeat(32)),
            resume: true,
            ..daemon_test_spawn_request()
        })
        .is_err()
    );
    assert!(
        super::daemon_repo_pool_authority(&super::DaemonSpawnRequest {
            run_worktree: false,
            handoff_transfer: true,
            ..slot(daemon_test_spawn_request())
        })
        .is_err()
    );
}

#[tokio::test]
async fn daemon_spawn_claim_blocks_duplicate_inflight_request() {
    assert_eq!(
        daemon_spawn_claim_key(Some("run-a"), Some("exec-a")).as_deref(),
        Some("run:run-a")
    );
    assert_eq!(
        daemon_spawn_claim_key(None, Some("exec-a")).as_deref(),
        Some("execution:exec-a")
    );

    let registry: DaemonRunRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let inflight: DaemonSpawnInflight = Arc::new(tokio::sync::Mutex::new(HashSet::new()));
    let intent = daemon_test_spawn_request();

    let first_key = match claim_daemon_spawn(&registry, &inflight, &intent, None, None).await {
        DaemonSpawnClaim::Claimed(Some(key)) => key,
        _ => panic!("first claim should reserve the run key"),
    };
    assert!(matches!(
        claim_daemon_spawn(&registry, &inflight, &intent, None, None).await,
        DaemonSpawnClaim::Inflight
    ));

    release_daemon_spawn_claim(&inflight, Some(first_key)).await;
    let second_key = match claim_daemon_spawn(&registry, &inflight, &intent, None, None).await {
        DaemonSpawnClaim::Claimed(Some(key)) => key,
        _ => panic!("released claim should be reservable again"),
    };
    release_daemon_spawn_claim(&inflight, Some(second_key)).await;

    registry.lock().await.insert(
        "run:run-a".to_string(),
        DaemonRunChild {
            pid: std::process::id(),
            run_id: intent.run_id.clone(),
            execution_key: intent.execution_key.clone(),
            instance_id: intent.instance_id.clone(),
            resume_session_key: intent.resume_session_key.clone(),
            agent_name: Some(intent.agent_name.clone()),
            ..test_empty_daemon_run_child()
        },
    );
    assert_existing_daemon_claim(&registry, &inflight, &intent).await;
    {
        let mut guard = registry.lock().await;
        let legacy = guard
            .get_mut("run:run-a")
            .expect("registered duplicate fixture");
        legacy.instance_id = None;
        legacy.resume_session_key = None;
    }
    assert_existing_daemon_claim(&registry, &inflight, &intent).await;
    {
        let mut guard = registry.lock().await;
        let current = guard
            .get_mut("run:run-a")
            .expect("registered duplicate fixture");
        current.instance_id = intent.instance_id.clone();
        current.resume_session_key = intent.resume_session_key.clone();
    }
    let mut conflicting_intent = intent;
    conflicting_intent.instance_id = Some("instance-conflict".to_string());
    assert!(matches!(
        claim_daemon_spawn(&registry, &inflight, &conflicting_intent, None, None).await,
        DaemonSpawnClaim::Conflict
    ));
}

async fn initialized_codex_fixture(mode: &str) -> CodexAppSession {
    let cwd = env!("CARGO_MANIFEST_DIR");
    let mut session = CodexAppSession::spawn_stdio_with_prefix_args(
        "node",
        &[goal_runtime_fixture_path(), mode.to_string()],
        Some(cwd),
        None,
    )
    .await
    .expect("spawn Codex fixture");
    session
        .initialize(Some(cwd), None, false)
        .await
        .expect("initialize Codex fixture");
    session
}

async fn submit_old_codex_test_turn(
    codex: &mut CodexAppSession,
    events: &mut tokio::sync::mpsc::UnboundedReceiver<AgentInstanceConnectionEvent>,
    pending: &mut VecDeque<AgentInstanceConnectionEvent>,
    agent: &SerializedAgent,
) -> super::InterruptibleCodexTurn {
    super::submit_codex_turn_interruptible(
        codex,
        events,
        pending,
        CodexTurnRequest {
            trace_channel_id: Some("chan-a"),
            interrupt_history_replay: true,
            ..CodexTurnRequest::new("old turn", agent)
        },
    )
    .await
}

fn goal_runtime_fixture_path() -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("mock-goal-runtime.mjs")
        .to_string_lossy()
        .to_string()
}

#[tokio::test]
async fn codex_submit_turn_finishes_when_idle_precedes_turn_completed() {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut codex = initialized_codex_fixture("codex-turn-order").await;

        let turn = codex
            .submit_turn(CodexTurnRequest::new(
                "finish this fixture turn",
                &test_serialized_agent("codex-turn-order"),
            ))
            .await
            .expect("turn/completed must finish the wrapper turn");

        assert_eq!(turn.local_output, "fixture complete");
        assert!(!turn.failed);
        codex.shutdown().await;
    })
    .await
    .expect("wrapper waited for an impossible post-completion idle event");
}

#[tokio::test]
async fn codex_vendor_error_survives_combined_bootstrap_turn() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let cwd = env!("CARGO_MANIFEST_DIR");
        let mut codex = CodexAppSession::spawn_stdio_with_prefix_args(
            "node",
            &[goal_runtime_fixture_path(), "codex-turn-failure".to_string()],
            Some(cwd),
            None,
        )
        .await
        .expect("spawn Codex failure fixture");
        codex.initialize(Some(cwd), None, false).await.unwrap();
        // A renamed profile must not determine the error's vendor.
        let agent = test_serialized_agent("reviewer");
        let expected = "Codex error: This request was blocked by our safety systems. Reason: Potentially unintended activity.";
        let mut bootstrap = Some("bootstrap the channel".to_string());
        let prompt = super::codex_turn_with_bootstrap(&mut bootstrap, "reproduce the failure");
        let turn = codex
            .submit_turn(CodexTurnRequest::new(&prompt, &agent))
            .await
            .expect("vendor failure is a completed adapter result");
        assert!(turn.failed);
        assert!(!turn.restart_after_turn);
        assert_eq!(turn.failure_detail.as_deref(), Some(expected));
        assert!(bootstrap.is_none(), "bootstrap must be consumed exactly once");
        codex.shutdown().await;
    })
    .await
    .expect("Codex failure fixture timed out");
}

#[tokio::test]
async fn codex_channel_interrupt_yields_without_provider_completion() {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut codex = initialized_codex_fixture("codex-interrupt-no-completion").await;

        let mut event_rx = test_event_after(
            Duration::from_millis(100),
            interrupting_channel_message_event("m2", "chan-a", "continue now"),
            "deliver interrupting channel message",
        );
        let mut pending = VecDeque::new();
        let agent = test_serialized_agent("codex-interrupt-no-completion");
        let result =
            submit_old_codex_test_turn(&mut codex, &mut event_rx, &mut pending, &agent).await;

        assert!(matches!(result, super::InterruptibleCodexTurn::Interrupted));
        assert!(matches!(
            pending.front(),
            Some(AgentInstanceConnectionEvent::Server(
                AgentInstanceServerMessage::ChannelMessageReceived { message, .. }
            )) if message.message_id == "m2"
        ));
        codex.shutdown().await;
    })
    .await
    .expect("wrapper waited for turn/completed after native interruption");
}

#[tokio::test]
async fn codex_shutdown_interrupts_and_quiesces_active_turn_before_exit() {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut codex = initialized_codex_fixture("codex-interrupt-no-completion").await;

        let mut event_rx = test_event_after(
            Duration::from_millis(100),
            AgentInstanceConnectionEvent::Server(AgentInstanceServerMessage::ShutdownRequested {
                reason: Some("reborn".to_string()),
            }),
            "deliver shutdown request",
        );
        let mut pending = VecDeque::new();
        let agent = test_serialized_agent("codex-graceful-shutdown");
        let result =
            submit_old_codex_test_turn(&mut codex, &mut event_rx, &mut pending, &agent).await;

        assert!(matches!(
            result,
            super::InterruptibleCodexTurn::Shutdown(reason) if reason == "reborn"
        ));
        assert!(
            codex
                .active_turn
                .lock()
                .expect("active turn lock")
                .is_none(),
            "Codex must report idle before shutdown proceeds"
        );
        codex.shutdown().await;
    })
    .await
    .expect("graceful shutdown waited for turn/completed instead of idle");
}

#[tokio::test]
async fn codex_shutdown_forces_exit_when_native_interrupt_never_quiesces() {
    tokio::time::timeout(
        Duration::from_secs(super::CODEX_SHUTDOWN_INTERRUPT_GRACE_SECS + 2),
        async {
            let mut codex = initialized_codex_fixture("codex-interrupt-no-ack").await;

            let mut event_rx = test_event_after(
                Duration::from_millis(100),
                AgentInstanceConnectionEvent::Server(
                    AgentInstanceServerMessage::ShutdownRequested {
                        reason: Some("stop".to_string()),
                    },
                ),
                "deliver shutdown request",
            );
            let mut pending = VecDeque::new();
            let agent = test_serialized_agent("codex-forced-shutdown");
            let started = std::time::Instant::now();
            let result =
                submit_old_codex_test_turn(&mut codex, &mut event_rx, &mut pending, &agent).await;

            assert!(matches!(
                result,
                super::InterruptibleCodexTurn::Shutdown(reason) if reason == "stop"
            ));
            assert!(
                started.elapsed()
                    >= Duration::from_secs(super::CODEX_SHUTDOWN_INTERRUPT_GRACE_SECS),
                "shutdown must give Codex its bounded interrupt grace period"
            );
            codex.shutdown().await;
        },
    )
    .await
    .expect("unresponsive Codex prevented forced shutdown");
}

#[tokio::test]
async fn codex_submit_turn_drops_session_quota_snapshots_before_presence_updates() {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut codex = initialized_codex_fixture("codex-session-rate-limit-turn").await;

        let turn = codex
            .submit_turn(CodexTurnRequest::new(
                "finish this session rate-limit fixture turn",
                &test_serialized_agent("codex-session-rate-limit"),
            ))
            .await
            .expect("session rate-limit fixture turn");

        assert_eq!(turn.local_output, "session rate limit fixture complete");
        assert!(
            turn.usage.and_then(|usage| usage.quota_usages).is_none(),
            "session-local quota snapshot must not reach PresenceUpdate"
        );
        codex.shutdown().await;
    })
    .await
    .expect("session quota snapshot fixture timed out");
}

#[tokio::test]
async fn codex_submit_turn_accepts_redirected_thread_events_for_the_active_turn() {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut codex = initialized_codex_fixture("codex-redirected-turn").await;

        let turn = codex
            .submit_turn(CodexTurnRequest::new(
                "finish this redirected fixture turn",
                &test_serialized_agent("codex-redirected-turn"),
            ))
            .await
            .expect("redirected turn/completed must finish the wrapper turn");

        assert_eq!(turn.local_output, "redirected fixture complete");
        assert!(!turn.failed);
        codex.shutdown().await;
    })
    .await
    .expect("redirected active turn did not finish");
}

#[tokio::test]
async fn codex_submit_turn_keeps_active_goal_open_across_continuations() {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut codex = initialized_codex_fixture("codex-goal-turn-order").await;
        let goal = codex
            .set_goal("finish both fixture turns")
            .await
            .ok()
            .and_then(|value| codex_goal_status_from_get_response(&value))
            .expect("set active fixture goal");

        let turn = codex
            .submit_turn(CodexTurnRequest {
                initial_goal: Some(&goal),
                ..CodexTurnRequest::new(
                    "start the fixture goal",
                    &test_serialized_agent("codex-goal-turn-order"),
                )
            })
            .await
            .expect("goal continuation must reach its terminal turn");

        assert_eq!(turn.local_output, "completed goal output");
        assert_eq!(
            turn.goal.and_then(|goal| goal.status).as_deref(),
            Some("complete")
        );
        codex.shutdown().await;
    })
    .await
    .expect("active Codex goal continuation did not finish");
}

/// Credential-free adapter E2E: drive the real Codex app-server, Claude
/// stream-json, Grok ACP, and ZCode app-server clients against wire-level
/// subprocess fixtures. This catches command-mapping and response-shape
/// drift without depending on installed provider CLIs or network access.
#[tokio::test]
async fn provider_goal_adapters_round_trip_offline() {
    tokio::time::timeout(Duration::from_secs(20), async {
        require_node_fixture_runtime();

        let fixture = goal_runtime_fixture_path();
        let cwd = env!("CARGO_MANIFEST_DIR");

        let mut codex = CodexAppSession::spawn_stdio_with_prefix_args(
            "node",
            &[fixture.clone(), "codex".to_string()],
            Some(cwd),
            None,
        )
        .await
        .expect("spawn Codex goal fixture");
        codex
            .initialize(Some(cwd), None, false)
            .await
            .expect("initialize Codex goal fixture");
        let objective = "ship the provider-neutral goal path";
        let set = codex.set_goal(objective).await.expect("Codex goal set");
        let set_goal = codex_goal_status_from_get_response(&set).expect("Codex set goal");
        assert_eq!(set_goal.objective.as_deref(), Some(objective));
        assert_eq!(set_goal.status.as_deref(), Some("active"));
        assert_eq!(set_goal.tokens_used, Some(512));
        assert_eq!(set_goal.time_used_seconds, Some(31));
        assert_eq!(set_goal.iteration_count, Some(4));
        assert_eq!(set_goal.context_used, Some(768));
        assert_eq!(set_goal.tool_call_count, Some(3));
        assert_eq!(set_goal.reason.as_deref(), Some("fixture verification"));
        assert_eq!(set_goal.next_action.as_deref(), Some("fixture next action"));
        let paused = codex.pause_goal().await.expect("Codex goal pause");
        assert_eq!(
            codex_goal_status_from_get_response(&paused)
                .and_then(|goal| goal.status)
                .as_deref(),
            Some("paused")
        );
        let resumed = codex.resume_goal().await.expect("Codex goal resume");
        assert_eq!(
            codex_goal_status_from_get_response(&resumed)
                .and_then(|goal| goal.status)
                .as_deref(),
            Some("active")
        );
        codex.clear_goal().await.expect("Codex goal clear");
        let cleared = codex.get_goal().await.expect("Codex goal after clear");
        assert!(codex_goal_status_from_get_response(&cleared).is_none());
        codex.shutdown().await;

        let mut claude_agent = test_serialized_agent("claude-fixture");
        claude_agent.agent_type = "claude_code".to_string();
        let relay = Arc::new(AgentInstanceConnectionClient::new(
            "ws://127.0.0.1:9/ws".to_string(),
            "fixture-token".to_string(),
            claude_agent.name.clone(),
            claude_agent.agent_type.clone(),
            None,
        ));
        let mut claude = ClaudeStreamSession::new(
            "node",
            &[fixture.clone(), "claude".to_string()],
            Some(cwd),
            None,
            false,
            relay,
            claude_agent,
            None,
        );
        let set_command = GoalCommand::Set {
            objective: objective.to_string(),
        };
        let claude_set_input = claude_goal_turn_input(&set_command, None);
        let set_outcome = claude
            .submit_turn(
                &claude_set_input,
                vec![serde_json::json!({"type":"text","text":&claude_set_input})],
                "fixture-channel",
            )
            .await;
        assert!(matches!(set_outcome.status, ClaudeTurnStatus::Completed));
        let claude_goal = claude_goal_status_from_result_text(&set_outcome.answer)
            .expect("Claude native goal ack");
        assert_eq!(claude_goal.objective.as_deref(), Some(objective));
        assert_eq!(claude_goal.status.as_deref(), Some("active"));
        let claude_get_input = claude_goal_turn_input(&GoalCommand::Get, Some(&claude_goal));
        let get_outcome = claude
            .submit_turn(
                &claude_get_input,
                vec![serde_json::json!({"type":"text","text":&claude_get_input})],
                "fixture-channel",
            )
            .await;
        let claude_status = claude_goal_status_from_result_text(&get_outcome.answer)
            .expect("Claude native status ack");
        assert_eq!(claude_status.objective.as_deref(), Some(objective));
        let claude_resume_input = claude_goal_turn_input(&GoalCommand::Resume, Some(&claude_goal));
        assert_eq!(
            claude_resume_input,
            format!("Continue working on the current goal: {objective}")
        );
        let resume_outcome = claude
            .submit_turn(
                &claude_resume_input,
                vec![serde_json::json!({"type":"text","text":&claude_resume_input})],
                "fixture-channel",
            )
            .await;
        assert!(matches!(resume_outcome.status, ClaudeTurnStatus::Completed));
        let claude_clear_input = claude_goal_turn_input(&GoalCommand::Clear, Some(&claude_goal));
        let clear_outcome = claude
            .submit_turn(
                &claude_clear_input,
                vec![serde_json::json!({"type":"text","text":&claude_clear_input})],
                "fixture-channel",
            )
            .await;
        assert!(matches!(clear_outcome.status, ClaudeTurnStatus::Completed));
        let claude_cleared = claude_goal_status_from_result_text(&clear_outcome.answer)
            .expect("Claude native clear ack");
        assert_eq!(claude_cleared.status.as_deref(), Some("cleared"));
        claude.shutdown().await;

        let mut zcode =
            ZcodeAppSession::spawn("node", &[fixture.clone(), "zcode".to_string()], Some(cwd))
                .await
                .expect("spawn ZCode goal fixture");
        assert!(
            zcode
                .initialize(Some(cwd))
                .await
                .expect("initialize ZCode")
                .is_none()
        );
        let zcode_set = zcode
            .goal_command(&set_command)
            .await
            .expect("ZCode goal set");
        let zcode_goal = zcode_set.goal.expect("ZCode set goal");
        assert_eq!(zcode_goal.objective.as_deref(), Some(objective));
        assert_eq!(zcode_goal.status.as_deref(), Some("active"));
        assert_eq!(zcode_goal.tokens_used, Some(512));
        assert_eq!(zcode_goal.time_used_seconds, Some(31));
        assert_eq!(zcode_goal.iteration_count, Some(4));
        assert_eq!(zcode_goal.context_used, Some(768));
        assert_eq!(zcode_goal.tool_call_count, Some(3));
        assert_eq!(zcode_goal.reason.as_deref(), Some("fixture verification"));
        assert_eq!(
            zcode_goal.next_action.as_deref(),
            Some("fixture next action")
        );
        let replacement = "verify every provider";
        let zcode_replaced = zcode
            .goal_command(&GoalCommand::Replace {
                objective: replacement.to_string(),
            })
            .await
            .expect("ZCode goal replace");
        assert_eq!(
            zcode_replaced
                .goal
                .and_then(|goal| goal.objective)
                .as_deref(),
            Some(replacement)
        );
        let zcode_paused = zcode
            .goal_command(&GoalCommand::Pause)
            .await
            .expect("ZCode goal pause");
        assert_eq!(
            zcode_paused.goal.and_then(|goal| goal.status).as_deref(),
            Some("paused")
        );
        let zcode_resumed = zcode
            .goal_command(&GoalCommand::Resume)
            .await
            .expect("ZCode goal resume");
        assert_eq!(
            zcode_resumed.goal.and_then(|goal| goal.status).as_deref(),
            Some("active")
        );
        let zcode_status = zcode
            .goal_command(&GoalCommand::Get)
            .await
            .expect("ZCode goal get");
        assert_eq!(
            zcode_status.goal.and_then(|goal| goal.objective).as_deref(),
            Some(replacement)
        );
        let zcode_cleared = zcode
            .goal_command(&GoalCommand::Clear)
            .await
            .expect("ZCode goal clear");
        assert!(zcode_cleared.goal.is_none());
        zcode.shutdown().await;

        let mut grok = AcpSession::spawn_stdio_with_prefix_args(
            "node",
            &[fixture, "grok".to_string()],
            &[],
            Some(cwd),
            AcpVendorConfig::grok(),
        )
        .await
        .expect("spawn Grok goal fixture");
        let presentation = grok
            .initialize(Some(cwd), None, false, None)
            .await
            .expect("initialize Grok goal fixture");
        assert_eq!(
            presentation
                .models
                .as_ref()
                .and_then(|models| models.first())
                .map(|model| model.id.as_str()),
            Some("grok-fixture")
        );
        let grok_agent = test_serialized_agent("grok-fixture");
        let grok_set_input = grok_goal_turn_input(&set_command, None);
        let grok_set = grok
            .submit_turn(
                &grok_set_input,
                vec![serde_json::json!({"type":"text","text":&grok_set_input})],
                None,
                Some(&set_command),
                &grok_agent,
                None,
                None,
            )
            .await
            .expect("Grok goal set");
        let grok_goal = grok_set.goal.expect("Grok structured goal update");
        assert_eq!(grok_goal.objective.as_deref(), Some(objective));
        assert_eq!(grok_goal.status.as_deref(), Some("active"));
        let grok_get_input = grok_goal_turn_input(&GoalCommand::Get, Some(&grok_goal));
        let grok_get = grok
            .submit_turn(
                &grok_get_input,
                vec![serde_json::json!({"type":"text","text":&grok_get_input})],
                None,
                Some(&GoalCommand::Get),
                &grok_agent,
                None,
                None,
            )
            .await
            .expect("Grok goal get");
        assert_eq!(
            grok_get.goal.and_then(|goal| goal.objective).as_deref(),
            Some(objective)
        );
        let grok_pause_input = grok_goal_turn_input(&GoalCommand::Pause, Some(&grok_goal));
        let grok_pause = grok
            .submit_turn(
                &grok_pause_input,
                vec![serde_json::json!({"type":"text","text":&grok_pause_input})],
                None,
                Some(&GoalCommand::Pause),
                &grok_agent,
                None,
                None,
            )
            .await
            .expect("Grok goal pause");
        let grok_paused = grok_pause.goal.expect("Grok paused goal update");
        assert_eq!(grok_paused.status.as_deref(), Some("paused"));
        assert_eq!(grok_paused.active, Some(false));
        let grok_resume_input = grok_goal_turn_input(&GoalCommand::Resume, Some(&grok_paused));
        let grok_resume = grok
            .submit_turn(
                &grok_resume_input,
                vec![serde_json::json!({"type":"text","text":&grok_resume_input})],
                None,
                Some(&GoalCommand::Resume),
                &grok_agent,
                None,
                None,
            )
            .await
            .expect("Grok goal resume");
        let grok_resumed = grok_resume.goal.expect("Grok resumed goal update");
        assert_eq!(grok_resumed.objective.as_deref(), Some(objective));
        assert_eq!(grok_resumed.status.as_deref(), Some("active"));
        let grok_clear_input = grok_goal_turn_input(&GoalCommand::Clear, Some(&grok_resumed));
        let grok_clear = grok
            .submit_turn(
                &grok_clear_input,
                vec![serde_json::json!({"type":"text","text":&grok_clear_input})],
                None,
                Some(&GoalCommand::Clear),
                &grok_agent,
                None,
                None,
            )
            .await
            .expect("Grok goal clear");
        assert!(
            grok_clear
                .goal
                .as_ref()
                .is_some_and(goal_status_represents_absence),
            "Grok clear must normalize to an absent goal"
        );
        grok.shutdown().await;
    })
    .await
    .expect("offline provider goal adapters should not hang");
}

/// Kimi adapter against its ACP wire fixture: configOptions presentation,
/// streaming output/usage, and kind-driven permission auto-approval.
#[tokio::test]
async fn generic_acp_session_streams_and_auto_approves_permission() {
    tokio::time::timeout(Duration::from_secs(10), async {
        require_node_fixture_runtime();
        let fixture = goal_runtime_fixture_path();
        let cwd = env!("CARGO_MANIFEST_DIR");
        let mut session = AcpSession::spawn_stdio_with_prefix_args(
            "node",
            &[fixture, "acp".to_string()],
            &[],
            Some(cwd),
            AcpVendorConfig::generic("kimi"),
        )
        .await
        .expect("spawn generic ACP fixture");
        let presentation = session
            .initialize(Some(cwd), None, false, None)
            .await
            .expect("initialize generic ACP fixture");
        assert_eq!(presentation.model.as_deref(), Some("kimi-fixture"));
        assert_eq!(presentation.effort.as_deref(), Some("high"));
        assert_eq!(presentation.models.as_ref().map(Vec::len), Some(1));
        let chips = presentation.status_chips.expect("Kimi presentation chips");
        assert!(chips.iter().any(|chip| chip.id == "model"));
        assert!(chips.iter().any(|chip| chip.id == "effort"));
        assert!(chips.iter().any(|chip| chip.id == "mode"));
        let agent = test_serialized_agent("kimi-fixture");
        let turn = session
            .submit_turn(
                "write a file",
                vec![serde_json::json!({"type":"text","text":"write a file"})],
                None,
                None,
                &agent,
                None,
                None,
            )
            .await
            .expect("generic ACP turn");
        assert!(!turn.failed, "{:?}", turn.failure_detail);
        // approve_always comes from kind=="allow_always", not the optionId;
        // auth:false proves the generic path never called authenticate.
        assert_eq!(
            turn.local_output,
            "fixture acp reply (perm:approve_always,auth:false)"
        );
        assert_eq!(
            turn.usage.as_ref().and_then(|usage| usage.total_tokens),
            Some(13)
        );
        let usage = turn.usage.as_ref().expect("Kimi ACP turn usage");
        assert_kimi_fixture_usage(usage);
        session.shutdown().await;
    })
    .await
    .expect("generic ACP fixture should not hang");
}

/// Live end-to-end check that the runtime's own `CodexAppSession` goal
/// methods drive codex's dedicated `thread/goal/{set,clear}` protocol,
/// including the paused-to-active transition used by `/goal resume`.
/// Requires a valid `codex login` and network access, so it is ignored by
/// default. Run with:
///   cargo test -p xmatrix-cli-runtime -- --ignored codex_session_goal
#[tokio::test]
#[ignore = "requires `codex login` + network"]
async fn codex_session_goal_pause_resume_and_clear_live() {
    let mut session = initialized_live_codex_session("codex-goal-it").await;

    let objective = "Keep the integration test green.";
    let set = session.set_goal(objective).await.expect("set_goal request");
    let goal = set.get("goal").expect("set_goal response carries goal");
    assert_eq!(
        goal.get("objective").and_then(serde_json::Value::as_str),
        Some(objective)
    );
    assert_eq!(
        goal.get("status").and_then(serde_json::Value::as_str),
        Some("active")
    );

    let thread_id = session
        .thread_id
        .clone()
        .expect("initialized session carries thread id");
    let paused = session
        .request(
            "thread/goal/set",
            serde_json::json!({
                "threadId": thread_id,
                "status": "paused"
            }),
        )
        .await
        .expect("pause goal request");
    assert_eq!(
        paused
            .get("goal")
            .and_then(|goal| goal.get("status"))
            .and_then(serde_json::Value::as_str),
        Some("paused")
    );

    let resumed = session.resume_goal().await.expect("resume_goal request");
    assert_eq!(
        resumed
            .get("goal")
            .and_then(|goal| goal.get("objective"))
            .and_then(serde_json::Value::as_str),
        Some(objective)
    );
    assert_eq!(
        resumed
            .get("goal")
            .and_then(|goal| goal.get("status"))
            .and_then(serde_json::Value::as_str),
        Some("active")
    );

    session.clear_goal().await.expect("clear_goal request");
    session.shutdown().await;
}

/// Live check that the installed Codex app-server exposes the model
/// catalog consumed by xMatrix. Requires a valid `codex login` and network
/// access, so it is ignored by default. Run with:
///   cargo test -p xmatrix-cli-runtime -- --ignored codex_session_model_list
#[tokio::test]
#[ignore = "requires `codex login` + network"]
async fn codex_session_model_list_live() {
    let mut session = initialized_live_codex_session("codex-model-it").await;
    let models = session.list_models().await.expect("model/list request");
    assert!(
        !models.is_empty(),
        "model/list should return at least one model"
    );
    assert!(
        models
            .iter()
            .all(|model| !model.id.is_empty() && !model.model.is_empty())
    );
    session.shutdown().await;
}

/// Live end-to-end check of the `set_model` handshake the runtime performs
/// against a real Claude Code process: spawn with the exact stream flags,
/// issue a `set_model` control request, confirm the `control_response`,
/// then verify the next turn's `system/init` reports the switched model.
/// Requires an authenticated `claude` install, so it is ignored by
/// default. Run with:
///   cargo test -p xmatrix-cli-runtime -- --ignored claude_stream_set_model
#[tokio::test]
#[ignore = "requires an authenticated `claude` install + network"]
async fn claude_stream_set_model_switch_live() {
    use super::extract_llm_model;
    use serde_json::Value;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let cwd = std::env::temp_dir().join(format!("claude-model-it-{}", std::process::id()));
    std::fs::create_dir_all(&cwd).expect("create temp cwd");

    let mut args = vec!["--dangerously-skip-permissions".to_string()];
    args.extend(claude_stream_extra_args(None, None, None, None));
    let mut child = tokio::process::Command::new("claude")
        .args(&args)
        .current_dir(&cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn claude stream process");
    let mut stdin = child.stdin.take().expect("claude stdin");
    let stdout = child.stdout.take().expect("claude stdout");

    let mut request =
        serde_json::to_vec(&claude_set_model_control_request("it-set-model-1", "haiku"))
            .expect("encode control request");
    request.push(b'\n');
    stdin.write_all(&request).await.expect("write set_model");
    let mut turn = serde_json::to_vec(&claude_stream_user_message(vec![serde_json::json!({
        "type": "text",
        "text": "Reply with exactly the word ok",
    })]))
    .expect("encode user turn");
    turn.push(b'\n');
    stdin.write_all(&turn).await.expect("write user turn");
    stdin.flush().await.expect("flush stdin");

    let mut lines = BufReader::new(stdout).lines();
    let mut switch_confirmed = false;
    let mut init_model = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    while let Ok(Ok(Some(line))) = tokio::time::timeout_at(deadline, lines.next_line()).await {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some((request_id, outcome)) = claude_control_response_outcome(&value) {
            assert_eq!(request_id, "it-set-model-1");
            outcome.expect("set_model control request should succeed");
            switch_confirmed = true;
            continue;
        }
        if value.get("type").and_then(Value::as_str) == Some("system")
            && value.get("subtype").and_then(Value::as_str) == Some("init")
        {
            init_model = extract_llm_model(&value);
        }
        if value.get("type").and_then(Value::as_str) == Some("result") {
            break;
        }
    }
    let _ = child.start_kill();
    let _ = child.wait().await;

    assert!(switch_confirmed, "no control_response arrived");
    let init_model = init_model.expect("system/init should report a model");
    assert!(
        init_model.contains("haiku"),
        "expected the switched model in init, got {init_model}"
    );
}

#[test]
fn daemon_run_exit_from_status_file_recovers_terminal_run() {
    let marker = DaemonRunStatusMarker {
        phase: "turn_completed".to_string(),
        completed: true,
        delivered: true,
        pid: i32::MAX as u32,
        updated_at_millis: super::unix_millis_now(),
        ..test_daemon_status_marker()
    };
    let status_path = PathBuf::from("/tmp/run-recovered.status.json");

    let exit = daemon_run_exit_from_status_file(&status_path, &marker)
        .expect("terminal status should produce a recovered run exit");

    assert_eq!(exit.registry_key, None);
    assert_eq!(exit.run_id.as_deref(), Some("run-recovered"));
    assert_eq!(exit.execution_key, None);
    assert_eq!(exit.pid, i32::MAX as u32);
    assert_eq!(exit.exit_code, Some(0));
    assert_eq!(exit.completed, Some(true));
    assert_eq!(exit.delivered, Some(true));
    assert_eq!(exit.status_phase.as_deref(), Some("turn_completed"));
}

#[test]
fn daemon_run_exit_from_status_file_preserves_failed_run_outcome() {
    let marker = DaemonRunStatusMarker {
        phase: "turn_failed".to_string(),
        detail: Some("Reconnecting... 2/5".to_string()),
        pid: i32::MAX as u32,
        updated_at_millis: super::unix_millis_now(),
        ..test_daemon_status_marker()
    };
    let status_path = PathBuf::from("/tmp/run-failed.status.json");

    let exit = daemon_run_exit_from_status_file(&status_path, &marker)
        .expect("failed terminal status should produce a recovered run exit");

    assert_eq!(exit.run_id.as_deref(), Some("run-failed"));
    assert_eq!(exit.exit_code, None);
    assert_eq!(exit.completed, Some(false));
    assert_eq!(exit.delivered, Some(false));
    assert_eq!(exit.status_phase.as_deref(), Some("turn_failed"));
    assert_eq!(
        exit.run_status_detail.as_deref(),
        Some("Reconnecting... 2/5")
    );
}

#[test]
fn daemon_run_exit_from_status_file_ignores_live_pid() {
    let marker = DaemonRunStatusMarker {
        phase: "turn_completed".to_string(),
        completed: true,
        delivered: true,
        pid: std::process::id(),
        updated_at_millis: super::unix_millis_now(),
        ..test_daemon_status_marker()
    };
    let status_path = PathBuf::from("/tmp/run-live.status.json");

    assert!(daemon_run_exit_from_status_file(&status_path, &marker).is_none());
}

#[test]
fn managed_status_file_is_never_reported_as_an_orphan() {
    let marker = DaemonRunStatusMarker {
        phase: "turn_completed".to_string(),
        completed: true,
        delivered: true,
        pid: u32::MAX,
        updated_at_millis: super::unix_millis_now(),
        ..test_daemon_status_marker()
    };
    let status_path = PathBuf::from("/tmp/run-managed.status.json");
    let managed = HashSet::from([status_path.clone()]);

    assert!(
        super::daemon_run_exit_from_orphan_status_file(&status_path, &marker, &managed).is_none()
    );
}

#[test]
fn daemon_run_artifact_pruning_is_bounded_and_preserves_recovery_evidence() {
    let temp_dir = std::env::temp_dir().join(format!(
        "xmatrix-run-artifact-prune-{}-{}",
        std::process::id(),
        super::unix_millis_now()
    ));
    fs::create_dir_all(&temp_dir).expect("temp dir");
    for index in 0..(super::DAEMON_RUN_ARTIFACT_RETENTION_MAX_GROUPS + 2) {
        fs::write(temp_dir.join(format!("run-{index}.status.json")), b"{}")
            .expect("status artifact");
        fs::write(temp_dir.join(format!("run-{index}.out.log")), b"output")
            .expect("output artifact");
    }
    let managed_status = temp_dir.join("run-managed.status.json");
    fs::write(&managed_status, b"{}").expect("managed status");
    fs::write(temp_dir.join("run-managed.err.log"), b"error").expect("managed error");
    fs::write(temp_dir.join("run-sidecar.status.json"), b"{}").expect("sidecar status");
    fs::write(temp_dir.join("run-sidecar.registry.json"), b"{}").expect("sidecar");

    let now = super::unix_millis_now()
        .saturating_add(super::DAEMON_RUN_ARTIFACT_RETENTION_GRACE_MILLIS)
        .saturating_add(1);
    let (groups, files) = super::prune_daemon_run_artifacts_in_dir(
        &temp_dir,
        &HashSet::from([managed_status.clone()]),
        now,
    );

    assert_eq!(groups, 2);
    assert_eq!(files, 4);
    assert!(managed_status.exists());
    assert!(temp_dir.join("run-managed.err.log").exists());
    assert!(temp_dir.join("run-sidecar.status.json").exists());
    assert!(temp_dir.join("run-sidecar.registry.json").exists());
    assert_eq!(
        fs::read_dir(&temp_dir)
            .expect("read artifacts")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".status.json")
            })
            .count(),
        super::DAEMON_RUN_ARTIFACT_RETENTION_MAX_GROUPS + 2
    );

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn daemon_run_artifact_pruning_expires_old_unprotected_groups() {
    let temp_dir = std::env::temp_dir().join(format!(
        "xmatrix-run-artifact-expiry-{}-{}",
        std::process::id(),
        super::unix_millis_now()
    ));
    fs::create_dir_all(&temp_dir).expect("temp dir");
    let status_path = temp_dir.join("run-expired.status.json");
    let stderr_path = temp_dir.join("run-expired.err.log");
    fs::write(&status_path, b"{}").expect("status artifact");
    fs::write(&stderr_path, b"error").expect("error artifact");

    let now = super::unix_millis_now()
        .saturating_add(super::DAEMON_RUN_ARTIFACT_RETENTION_MAX_AGE_MILLIS)
        .saturating_add(1);
    assert_eq!(
        super::prune_daemon_run_artifacts_in_dir(&temp_dir, &HashSet::new(), now),
        (1, 2)
    );
    assert!(!status_path.exists());
    assert!(!stderr_path.exists());

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn nested_process_cannot_mutate_sidecar_owned_status_file() {
    let temp_dir = std::env::temp_dir().join(format!(
        "xmatrix-sidecar-status-owner-{}-{}",
        std::process::id(),
        super::unix_millis_now()
    ));
    fs::create_dir_all(&temp_dir).expect("temp dir");
    let status_path = temp_dir.join("run-owned.status.json");
    write_daemon_run_status_marker_to_path(&status_path, "spawned", false, None);

    let run = super::PersistedDaemonRun {
        pid: std::process::id().saturating_add(1),
        run_id: Some("run:owned".to_string()),
        execution_key: Some("exec:owned".to_string()),
        agent_id: Some("agent:owned".to_string()),
        agent_name: Some("codex".to_string()),
        status_file_path: Some(status_path.clone()),
        updated_at: "100".to_string(),
        ..test_empty_persisted_daemon_run()
    };
    assert!(super::persist_daemon_run_sidecar(&run));

    write_daemon_run_status_marker_to_path(&status_path, "turn_completed", true, None);
    assert!(!refresh_daemon_run_status_heartbeat(&status_path));
    let marker = read_daemon_run_status_marker(Some(&status_path)).expect("status marker");
    assert_eq!(marker.phase, "spawned");
    assert!(!marker.completed);
    assert_eq!(marker.pid, std::process::id());

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn registry_reconciliation_detects_missing_sidecar() {
    let temp_dir = std::env::temp_dir().join(format!(
        "xmatrix-sidecar-reconcile-{}-{}",
        std::process::id(),
        super::unix_millis_now()
    ));
    fs::create_dir_all(&temp_dir).expect("temp dir");
    let status_path = temp_dir.join("run-reconcile.status.json");
    let run = super::PersistedDaemonRun {
        pid: std::process::id(),
        run_id: Some("run:reconcile".to_string()),
        execution_key: Some("exec:reconcile".to_string()),
        agent_id: Some("agent:reconcile".to_string()),
        agent_name: Some("codex".to_string()),
        status_file_path: Some(status_path),
        updated_at: "100".to_string(),
        ..test_empty_persisted_daemon_run()
    };

    assert!(!super::persisted_daemon_run_sidecars_match(
        std::slice::from_ref(&run)
    ));
    assert!(super::persist_daemon_run_sidecar(&run));
    assert!(super::persisted_daemon_run_sidecars_match(
        std::slice::from_ref(&run)
    ));
    fs::remove_file(super::daemon_run_sidecar_path(&run).expect("sidecar path"))
        .expect("remove sidecar");
    assert!(!super::persisted_daemon_run_sidecars_match(
        std::slice::from_ref(&run)
    ));

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn daemon_run_sidecar_removal_reports_removed_missing_and_failed() {
    let temp_dir = std::env::temp_dir().join(format!(
        "xmatrix-sidecar-removal-{}-{}",
        std::process::id(),
        super::unix_millis_now()
    ));
    fs::create_dir_all(&temp_dir).expect("temp dir");
    let sidecar_path = temp_dir.join("run.json");
    fs::write(&sidecar_path, b"{}").expect("sidecar");

    assert_eq!(
        super::remove_daemon_run_sidecar_path(&sidecar_path, 424242),
        super::DaemonRunSidecarRemoval::Removed
    );
    assert!(
        !sidecar_path.exists(),
        "removed sidecar should no longer exist"
    );
    assert_eq!(
        super::remove_daemon_run_sidecar_path(&sidecar_path, 424242),
        super::DaemonRunSidecarRemoval::Missing
    );
    assert_eq!(
        super::remove_daemon_run_sidecar_path(&temp_dir, 424242),
        super::DaemonRunSidecarRemoval::Failed
    );

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn orphan_sidecar_removed_audit_event_only_emits_for_removed_file() {
    let path = PathBuf::from("run-recovered.sidecar.json");

    let event = super::orphan_sidecar_removed_audit_event(
        424242,
        &path,
        super::DaemonRunSidecarRemoval::Removed,
    )
    .expect("removed sidecar should emit audit event");
    assert_eq!(
        event,
        "orphan_sidecar_removed pid=424242 path=run-recovered.sidecar.json"
    );
    assert_eq!(
        super::orphan_sidecar_removed_audit_event(
            424242,
            &path,
            super::DaemonRunSidecarRemoval::Missing,
        ),
        None
    );
    assert_eq!(
        super::orphan_sidecar_removed_audit_event(
            424242,
            &path,
            super::DaemonRunSidecarRemoval::Failed,
        ),
        None
    );
}

#[test]
fn rate_limit_snapshots_and_unclaimed_shapes_are_not_quota_usage() {
    // The generic event parser reports token and context telemetry only;
    // provider-specific online readers are the sole quota source.
    let window = |used: serde_json::Value, mins: u32| {
        serde_json::json!({ "usedPercent": used, "windowDurationMins": mins, "resetsAt": 1790012345 })
    };
    let limit = |id: &str, primary: serde_json::Value, secondary: serde_json::Value| {
        serde_json::json!({ "limitId": id, "limitName": id, "primary": primary, "secondary": secondary })
    };
    let codex = limit("codex", window(42.5.into(), 300), window(12.into(), 10080));
    let cases = [
        // A rate-limit snapshot keyed by limit id.
        serde_json::json!({ "rateLimitsByLimitId": {
            "other": limit("other", window(0.into(), 300), window(0.into(), 10080)),
            "codex": codex.clone(),
        } }),
        // A usage-limit error that carries the snapshot.
        serde_json::json!({ "method": "error", "params": { "error": {
            "message": "Usage limit reached",
            "rateLimitsByLimitId": { "codex": limit("codex", window(100.into(), 300), window(65.into(), 10080)) },
        } } }),
        // Windows reported as used/limit/remaining counts.
        serde_json::json!({ "rateLimitsByLimitId": { "codex": limit(
            "codex",
            serde_json::json!({ "used": 25, "limit": 100, "windowDurationMins": 300 }),
            serde_json::json!({ "remaining": 75, "limit": 100, "windowDurationMins": 10080 }),
        ) } }),
        // The per-model shape: a top-level rateLimits plus one entry per model.
        serde_json::json!({
            "rateLimits": codex.clone(),
            "rateLimitsByLimitId": {
                "codex": codex,
                "codex_bengalfox": limit("codex_bengalfox", window(0.into(), 300), window(0.into(), 10080)),
            },
        }),
        // Snake-case snapshots from Codex and Claude sessions are session-local too.
        serde_json::json!({ "rate_limits": {
            "primary": { "usedPercent": 12, "windowDurationMins": 300 },
            "secondary": { "usedPercent": 34, "windowDurationMins": 10080 },
        } }),
        serde_json::json!({ "rate_limits": {
            "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
            "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 },
        } }),
        // No catch-all: a percentage next to a reset is not a quota because it
        // looks like one, and a label does not rescue a shape no vendor claims.
        serde_json::json!({ "limits": [
            { "percent": 100, "resets_at": "2026-08-05T12:59:59+00:00" },
            { "percent": 38, "resets_at": "2026-08-04T18:00:00+00:00" },
        ] }),
        serde_json::json!({ "limits": [{ "label": "5h", "percent": 38, "resets_at": "2026-08-04T18:00:00+00:00" }] }),
    ];
    for payload in cases {
        assert!(extract_llm_usage(&payload).is_none(), "{payload}");
    }
}

#[test]
fn claude_stream_result_extracts_token_usage() {
    let payload = serde_json::json!({
        "type": "result",
        "result": "Done",
        "usage": {
            "input_tokens": 1234,
            "output_tokens": 56,
            "cache_creation_input_tokens": 78,
            "cache_read_input_tokens": 90
        }
    });

    let usage = extract_llm_usage(&payload).unwrap();

    assert_eq!(usage.input_tokens, Some(1234));
    assert_eq!(usage.output_tokens, Some(56));
    assert_eq!(usage.total_tokens, Some(1290));
    assert_eq!(usage.cache_creation_input_tokens, Some(78));
    assert_eq!(usage.cache_read_input_tokens, Some(90));
}

#[test]
fn acp_end_turn_usage_extracts_rfd_token_fields() {
    // ACP End-Turn Token Usage RFD shape on a session/prompt response.
    let payload = serde_json::json!({
        "stopReason": "end_turn",
        "usage": {
            "totalTokens": 53000,
            "inputTokens": 35000,
            "outputTokens": 12000,
            "thoughtTokens": 5000,
            "cachedReadTokens": 5000,
            "cachedWriteTokens": 1000
        }
    });

    let usage = extract_llm_usage(&payload).unwrap();

    assert_eq!(usage.total_tokens, Some(53000));
    assert_eq!(usage.input_tokens, Some(35000));
    assert_eq!(usage.output_tokens, Some(12000));
    assert_eq!(usage.reasoning_tokens, Some(5000));
    assert_eq!(usage.cached_input_tokens, Some(5000));
    assert_eq!(usage.cache_read_input_tokens, Some(5000));
    assert_eq!(usage.cache_creation_input_tokens, Some(1000));
}

#[test]
fn data_url_redaction_preserves_plain_text() {
    let text = "plain data point with no inline payload";

    assert_eq!(redact_data_urls(text), text);
}

#[test]
fn daemon_control_polling_recovers_faster_while_disconnected() {
    assert_eq!(daemon_control_idle_wait_ms(), 2_000);
}

#[cfg(not(windows))]
#[test]
fn submission_enter_preserves_kkp_on_unix_like_platforms() {
    assert_eq!(encode_submission_enter(0), b"\r");
    assert_eq!(encode_submission_enter(1), b"\x1b[13u");
}

#[cfg(windows)]
#[test]
fn submission_enter_uses_raw_lf_on_windows() {
    assert_eq!(encode_submission_enter(0), b"\n");
    assert_eq!(encode_submission_enter(1), b"\n");
}

#[cfg(unix)]
#[test]
fn signal_killed_child_is_classified_as_external_termination() {
    use std::process::Command;

    let signal_status = Command::new("sh")
        .args(["-c", "kill -9 $$"])
        .status()
        .expect("spawn signal-exit probe");
    assert!(
        crate::runtime_claude_turn::exit_status_signal_terminated(signal_status),
        "a SIGKILL exit must be classified as external termination"
    );

    let crash_exit_status = Command::new("sh")
        .args(["-c", "exit 3"])
        .status()
        .expect("spawn nonzero-exit probe");
    assert!(
        !crate::runtime_claude_turn::exit_status_signal_terminated(crash_exit_status),
        "a nonzero exit code keeps the normal crash-recovery path"
    );

    let clean_status = Command::new("sh")
        .args(["-c", "exit 0"])
        .status()
        .expect("spawn clean-exit probe");
    assert!(!crate::runtime_claude_turn::exit_status_signal_terminated(
        clean_status
    ));
}

#[tokio::test]
async fn blob_url_attachment_skips_direct_download_and_requires_coordinates() {
    let attachment = ChannelAttachment {
        id: "att-blob".to_string(),
        kind: "image".to_string(),
        name: "mobile-shot.png".to_string(),
        mime_type: "image/png".to_string(),
        size: 100,
        channel_id: None,
        message_id: None,
        data_url: String::new(),
        url: Some("blob:https://xmatrix.sh/abc123".to_string()),
    };
    let result = materialize_local_image_files(Some(&[attachment]), None).await;
    let err = match result {
        Err(err) => err.to_string(),
        Ok(_) => panic!("expected materialize to fail without owner coordinates"),
    };
    assert!(err.contains("omitted its body and owner coordinates"));
}

#[test]
fn inbound_event_backfills_attachment_channel_and_message_id() {
    let event =
        AgentInstanceConnectionEvent::Server(AgentInstanceServerMessage::ChannelMessageReceived {
            message: ChannelMessage {
                attachments: Some(vec![test_attachment("att-1", "screen.png")]),
                ..test_channel_message("msg-42", "chan-7", "screenshot")
            },
            client_message_id: None,
            ack_required: Some(true),
            interrupt_requested: None,
            delivery_intent: None,
        });

    let message = inbound_channel_message_from_event(event).unwrap();
    let attachments = message.attachments.unwrap();
    assert_eq!(attachments[0].channel_id, Some("chan-7".to_string()));
    assert_eq!(attachments[0].message_id, Some("msg-42".to_string()));
}

const CONTENT_BLOCK_SHAPES: [ImageBlockShape; 2] =
    [ImageBlockShape::Acp, ImageBlockShape::Anthropic];

fn content_block_image_attachment(
    id: &str,
    name: &str,
    size: usize,
    data_url: String,
) -> protocol::ChannelAttachment {
    protocol::ChannelAttachment {
        id: id.into(),
        kind: "image".into(),
        name: name.into(),
        mime_type: "image/png".into(),
        size: size as u64,
        channel_id: None,
        message_id: None,
        data_url,
        url: None,
    }
}

/// The image block each vendor shape carries `encoded` PNG bytes in.
fn assert_png_image_block(shape: ImageBlockShape, block: &Value, encoded: &str) {
    assert_eq!(block["type"], "image");
    match shape {
        ImageBlockShape::Acp => {
            assert_eq!(block["mimeType"], "image/png");
            assert_eq!(block["data"], encoded);
        }
        ImageBlockShape::Anthropic => {
            assert_eq!(block["source"]["type"], "base64");
            assert_eq!(block["source"]["media_type"], "image/png");
            assert_eq!(block["source"]["data"], encoded);
        }
    }
}

#[test]
fn prompt_content_blocks_text_only() {
    for shape in CONTENT_BLOCK_SHAPES {
        let blocks = prompt_content_blocks("hello", None, None, shape).unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[0]["text"], "hello");
    }
}

#[test]
fn prompt_content_blocks_from_data_url() {
    let raw = b"fake-image-bytes";
    let encoded = base64::engine::general_purpose::STANDARD.encode(raw);
    let attachments = vec![content_block_image_attachment(
        "att-1",
        "test.png",
        raw.len(),
        format!("data:image/png;base64,{encoded}"),
    )];
    for shape in CONTENT_BLOCK_SHAPES {
        let blocks = prompt_content_blocks("look", Some(&attachments), None, shape).unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["type"], "text");
        assert_png_image_block(shape, &blocks[1], &encoded);
    }
}

#[test]
fn prompt_content_blocks_from_local_path() {
    let raw = b"local-fake-image-bytes";
    let encoded = base64::engine::general_purpose::STANDARD.encode(raw);
    let mut path = std::env::temp_dir();
    path.push(format!("xmatrix-prompt-image-test-{}", std::process::id()));
    std::fs::write(&path, raw).unwrap();
    let attachments = vec![content_block_image_attachment(
        "att-2",
        "local.png",
        raw.len(),
        String::new(),
    )];
    for shape in CONTENT_BLOCK_SHAPES {
        let blocks = prompt_content_blocks("see", Some(&attachments), Some(&[path.clone()]), shape);
        let blocks = blocks.unwrap();
        assert_eq!(blocks.len(), 2);
        assert_png_image_block(shape, &blocks[1], &encoded);
    }
    let _ = std::fs::remove_file(&path);
}

#[test]
fn structured_failure_survives_owned_marker_and_snapshot_and_clears_on_recovery() {
    let path = std::env::temp_dir().join(format!(
        "xmatrix-failure-marker-{}.json",
        uuid::Uuid::new_v4()
    ));
    let failure = super::protocol::AgentOperationFailure {
        code: "agent_run_binding_mismatch".into(),
        stage: "relay.authenticate".into(),
        origin_stage: Some("authority.request".into()),
        retryable: false,
        diagnostic_id: "diag_11111111-1111-4111-8111-111111111111".into(),
    };
    super::write_daemon_run_status_marker_with_failure(
        &path,
        "wrapper_startup_failed",
        true,
        None,
        Some(&failure),
    );
    let marker = read_daemon_run_status_marker(Some(&path)).unwrap();
    assert_eq!(marker.operation_failure.as_ref(), Some(&failure));
    let request = test_daemon_request_record("failure", vec![], "workspace".into(), 30);
    let mut child = test_daemon_run_child(&request, std::process::id());
    child.status_file_path = Some(path.clone());
    let registry = std::collections::HashMap::from([("failure".into(), child)]);
    assert_eq!(
        super::daemon_run_snapshot_items_from_guard(&registry)[0]
            .operation_failure
            .as_ref(),
        Some(&failure)
    );
    let mut malformed = serde_json::to_value(&marker).unwrap();
    malformed["operationFailure"] = serde_json::json!({ "code": "PRIVATE", "token": "PRIVATE" });
    let compatible: DaemonRunStatusMarker = serde_json::from_value(malformed).unwrap();
    assert_eq!(compatible.phase, "wrapper_startup_failed");
    assert!(compatible.operation_failure.is_none());
    write_foreign_status_marker(&path, marker);
    assert!(
        super::daemon_run_snapshot_items_from_guard(&registry)[0]
            .operation_failure
            .is_none()
    );
    write_daemon_run_status_marker_to_path(&path, "relay_registered", false, None);
    assert!(
        read_daemon_run_status_marker(Some(&path))
            .unwrap()
            .operation_failure
            .is_none()
    );
    std::fs::remove_file(path).unwrap();
}

fn handoff_candidate(
    key: &str,
    version: &str,
    phase: &str,
    pending_at: Option<u64>,
) -> super::DaemonRunHandoffCandidate {
    let mut marker = replacement_ready_marker(7, version, Some(1));
    marker.phase = phase.to_string();
    marker.background_tasks = Some(0);
    super::DaemonRunHandoffCandidate {
        key: key.to_string(),
        pid: 7,
        marker: Some(marker),
        pending: pending_at.map(|at| super::DaemonHandoffRequest {
            version: "0.16.500".to_string(),
            executable: PathBuf::from("/opt/xmatrix"),
            requested_at_millis: at,
        }),
    }
}

#[test]
fn daemon_moves_only_idle_runs_behind_its_version() {
    use super::next_daemon_run_handoff;
    let now = 100 * 60 * 1000;
    let requested = HashMap::new();
    let pick = |candidates: &[super::DaemonRunHandoffCandidate]| {
        next_daemon_run_handoff(candidates, &requested, "0.16.500", now)
            .map(|candidate| candidate.key.clone())
    };

    assert_eq!(
        pick(&[handoff_candidate(
            "current",
            "0.16.500",
            "turn_completed",
            None
        )]),
        None
    );
    assert_eq!(
        pick(&[handoff_candidate("busy", "0.16.499", "turn_running", None)]),
        None
    );
    assert_eq!(
        pick(&[
            handoff_candidate("busy", "0.16.499", "turn_running", None),
            handoff_candidate("idle", "0.16.499", "turn_completed", None),
        ]),
        Some("idle".to_string())
    );

    // The marker must be the tracked wrapper's own.
    let mut foreign = handoff_candidate("foreign", "0.16.499", "turn_completed", None);
    foreign.pid = 8;
    assert_eq!(pick(&[foreign]), None);

    // Between turns with a background task (a CI wait) still running is not
    // idle: the move would kill it.
    let mut waiting = handoff_candidate("waiting", "0.16.499", "turn_completed", None);
    waiting.marker.as_mut().unwrap().background_tasks = Some(1);
    assert_eq!(pick(&[waiting]), None);
    // A runtime that never reports tasks (unset count) is idle: no watch.
    let mut unknown = handoff_candidate("unknown", "0.16.499", "turn_completed", None);
    unknown.marker.as_mut().unwrap().background_tasks = None;
    assert_eq!(pick(&[unknown]), Some("unknown".to_string()));
}

#[test]
fn daemon_moves_runs_one_at_a_time_and_backs_off() {
    use super::next_daemon_run_handoff;
    let now = 100 * 60 * 1000;
    let requested = HashMap::new();

    // A fresh request elsewhere is still being carried out.
    let fresh = [
        handoff_candidate("moving", "0.16.499", "turn_completed", Some(now - 1_000)),
        handoff_candidate("waiting", "0.16.499", "turn_completed", None),
    ];
    assert!(next_daemon_run_handoff(&fresh, &requested, "0.16.500", now).is_none());

    // A stale one (its run stayed busy) no longer holds the others back, and
    // is not rewritten.
    let stale = [
        handoff_candidate(
            "stuck",
            "0.16.499",
            "turn_completed",
            Some(now - 4 * 60 * 1000),
        ),
        handoff_candidate("waiting", "0.16.499", "turn_completed", None),
    ];
    assert_eq!(
        next_daemon_run_handoff(&stale, &requested, "0.16.500", now)
            .map(|candidate| candidate.key.as_str()),
        Some("waiting")
    );

    // A run that was asked recently and did not move waits for the retry.
    let candidates = [handoff_candidate(
        "failed",
        "0.16.499",
        "turn_completed",
        None,
    )];
    let recent = HashMap::from([("failed".to_string(), now - 60 * 1000)]);
    assert!(next_daemon_run_handoff(&candidates, &recent, "0.16.500", now).is_none());
    let old = HashMap::from([("failed".to_string(), now - 11 * 60 * 1000)]);
    assert!(next_daemon_run_handoff(&candidates, &old, "0.16.500", now).is_some());
}

#[test]
fn a_handoff_request_sits_next_to_its_run_status_file() {
    use super::daemon_handoff_request_path;
    assert_eq!(
        daemon_handoff_request_path(Path::new("/runs/run-1.status.json")),
        Some(PathBuf::from("/runs/run-1.handoff.json"))
    );
    assert_eq!(
        daemon_handoff_request_path(Path::new("/runs/other.json")),
        None
    );
}

#[cfg(unix)]
async fn assert_daemon_registry_snapshot(registry: &DaemonRunRegistry, run_id: &str, pid: u32) {
    let snapshot = {
        let guard = registry.lock().await;
        super::daemon_run_snapshot_items_from_guard(&guard)
    };
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].run_id.as_deref(), Some(run_id));
    assert_eq!(snapshot[0].pid, Some(pid));
}

fn require_node_fixture_runtime() {
    let node = std::process::Command::new("node")
        .arg("--version")
        .output()
        .expect("Node.js is required by the workspace test toolchain");
    assert!(node.status.success(), "Node.js must be runnable");
}

async fn initialized_live_codex_session(slug: &str) -> CodexAppSession {
    let cwd = std::env::temp_dir().join(format!("{slug}-{}", std::process::id()));
    std::fs::create_dir_all(&cwd).expect("create temp cwd");
    let cwd = cwd.to_string_lossy().to_string();
    let mut session = CodexAppSession::spawn("codex", Some(&cwd), None)
        .await
        .expect("spawn codex app-server");
    session
        .initialize(Some(&cwd), None, false)
        .await
        .expect("initialize codex app-server");
    session
}

async fn assert_existing_daemon_claim(
    registry: &DaemonRunRegistry,
    inflight: &super::DaemonSpawnInflight,
    intent: &super::DaemonSpawnRequest,
) {
    assert!(matches!(
        claim_daemon_spawn(registry, inflight, intent, None, None).await,
        DaemonSpawnClaim::Existing(DaemonSpawnResultParts { ok: true, .. })
    ));
}

fn write_foreign_status_marker(path: &std::path::Path, mut marker: DaemonRunStatusMarker) {
    marker.pid = marker.pid.saturating_add(1);
    std::fs::write(path, serde_json::to_vec(&marker).unwrap()).unwrap();
}
