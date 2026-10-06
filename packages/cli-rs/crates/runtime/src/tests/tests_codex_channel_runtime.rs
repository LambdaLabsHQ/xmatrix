mod attachment_fixture {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../core/tests/support/attachment_fixture.rs"
    ));
}

#[test]
fn combined_inbound_prompt_preserves_each_message_once() {
    let prompt = combined_inbound_channel_prompt(vec![
        "xMatrix channel chan-a messageId=m1 from Yiming Hu [user]: first".to_string(),
        "xMatrix channel chan-a messageId=m2 from Yiming Hu [user]: second".to_string(),
    ]);

    assert!(prompt.starts_with("Multiple xMatrix messages delivered together:"));
    assert_eq!(prompt.matches("messageId=m1").count(), 1);
    assert_eq!(prompt.matches("messageId=m2").count(), 1);
    assert_eq!(prompt.matches("\n---\n").count(), 1);
}

#[test]
fn combined_inbound_prompt_preserves_reply_and_attachment_context() {
    let sender = test_sender("Yiming Hu");
    let reply_sender = MessageSender {
        kind: "agent".to_string(),
        label: "codex".to_string(),
        identity_id: Some("agent:codex".to_string()),
        instance_id: Some("inst-1".to_string()),
        ..test_sender("codex")
    };
    let reply = ChannelReplyContext {
        message_id: "reply-1".to_string(),
        from: reply_sender,
        body_preview: "previous answer".to_string(),
        sent_at: "2026-01-01T00:00:00.000Z".to_string(),
        recalled_at: None,
    };
    let mut first_files = LocalImageFiles::empty();
    first_files.remember_path("att-1", PathBuf::from("/tmp/one.png"));
    let mut second_files = LocalImageFiles::empty();
    second_files.remember_path("att-2", PathBuf::from("/tmp/two.png"));
    let parts = vec![
        format_incoming_channel_message_with_context(
            "chan-a",
            Some("m1"),
            Some("reply-1"),
            Some(&reply),
            true,
            &sender,
            None,
            "first",
            Some(&[test_attachment("att-1", "one.png")]),
            Some(&first_files),
        ),
        format_incoming_channel_message_with_context(
            "chan-a",
            Some("m2"),
            None,
            None,
            false,
            &sender,
            None,
            "second",
            Some(&[test_attachment("att-2", "two.png")]),
            Some(&second_files),
        ),
    ];

    let prompt = combined_inbound_channel_prompt(parts);

    assert!(prompt.contains("messageId=m1 replyToMessageId=reply-1"));
    assert!(prompt.contains("replied to your message"));
    assert!(prompt.contains("- image one.png at /tmp/one.png"));
    assert!(prompt.contains("messageId=m2"));
    assert!(prompt.contains("- image two.png at /tmp/two.png"));
}

#[test]
fn combined_inbound_attachments_collects_all_messages() {
    let messages = vec![
        InboundChannelMessage {
            entity_version: None,
            body_hash: None,
            message_id: "m1".to_string(),
            channel_id: "chan-a".to_string(),
            sequence: Some(1),
            from: test_sender("Yiming Hu"),
            body: "first".to_string(),
            reply_to_message_id: None,
            reply_to: None,
            attachments: Some(vec![test_attachment("att-1", "one.png")]),
            metadata: None,
        },
        InboundChannelMessage {
            entity_version: None,
            body_hash: None,
            message_id: "m2".to_string(),
            channel_id: "chan-a".to_string(),
            sequence: Some(2),
            from: test_sender("Yiming Hu"),
            body: "second".to_string(),
            reply_to_message_id: None,
            reply_to: None,
            attachments: Some(vec![test_attachment("att-2", "two.png")]),
            metadata: None,
        },
    ];

    let attachments = combined_inbound_channel_attachments(&messages).unwrap();

    assert_eq!(attachments.len(), 2);
    assert_eq!(attachments[0].id, "att-1");
    assert_eq!(attachments[1].id, "att-2");
}

#[test]
fn inbound_ready_drain_stops_at_lifecycle_boundary() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    tx.send(channel_message_event("m1", "chan-a", "first"))
        .unwrap();
    tx.send(channel_message_event("m2", "chan-a", "second"))
        .unwrap();
    tx.send(AgentInstanceConnectionEvent::Disconnected {
        reason: "offline".to_string(),
    })
    .unwrap();
    tx.send(channel_message_event("m3", "chan-a", "after disconnect"))
        .unwrap();

    let mut pending = VecDeque::new();
    let mut messages = Vec::new();

    drain_ready_inbound_channel_messages(&mut rx, &mut pending, "chan-a", &mut messages, None);

    assert_channel_message_ids(&messages, &["m1", "m2"]);
    assert_eq!(pending.len(), 1);
    assert!(matches!(
        pending.pop_front(),
        Some(AgentInstanceConnectionEvent::Disconnected { .. })
    ));
    assert!(matches!(
        rx.try_recv().unwrap(),
        AgentInstanceConnectionEvent::Server(AgentInstanceServerMessage::ChannelMessageReceived { message, .. })
            if message.message_id == "m3"
    ));
}

#[test]
fn inbound_ready_drain_stops_in_front_of_slash_passthrough_message() {
    let agent = test_serialized_agent("codex");
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    tx.send(channel_message_event("m1", "chan-a", "first"))
        .unwrap();
    tx.send(channel_message_event(
        "m2",
        "chan-a",
        "@codex:1 /goal ship it",
    ))
    .unwrap();
    tx.send(channel_message_event("m3", "chan-a", "after slash"))
        .unwrap();

    let mut pending = VecDeque::new();
    let mut messages = Vec::new();

    drain_ready_inbound_channel_messages(
        &mut rx,
        &mut pending,
        "chan-a",
        &mut messages,
        Some(&agent),
    );

    // The slash command must not join the batch; it parks in pending so
    // it seeds the next delivery, and nothing newer jumps ahead of it.
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].message_id, "m1");
    assert_eq!(pending.len(), 1);
    assert!(matches!(
        rx.try_recv().unwrap(),
        AgentInstanceConnectionEvent::Server(AgentInstanceServerMessage::ChannelMessageReceived { message, .. })
            if message.message_id == "m3"
    ));

    // The parked slash command seeds its own single-message batch.
    let mut slash_batch =
        vec![inbound_channel_message_from_event(pending.pop_front().unwrap()).unwrap()];
    tx.send(channel_message_event("m4", "chan-a", "even newer"))
        .unwrap();
    drain_ready_inbound_channel_messages(
        &mut rx,
        &mut pending,
        "chan-a",
        &mut slash_batch,
        Some(&agent),
    );
    assert_eq!(slash_batch.len(), 1);
    assert_eq!(
        single_message_slash_passthrough(&slash_batch, &agent).as_deref(),
        Some("/goal ship it")
    );
}

#[test]
fn inbound_pending_drain_parks_slash_passthrough_for_next_delivery() {
    let agent = test_serialized_agent("codex");
    let (_tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let mut pending = VecDeque::from([
        channel_message_event("m2", "chan-a", "@codex:1 /goal clear"),
        channel_message_event("m3", "chan-a", "queued after slash"),
    ]);
    let mut messages = seeded_inbound_messages();

    drain_ready_inbound_channel_messages(
        &mut rx,
        &mut pending,
        "chan-a",
        &mut messages,
        Some(&agent),
    );

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].message_id, "m1");
    // Both the slash command and everything behind it stay pending, in order.
    assert_eq!(pending.len(), 2);
    assert!(matches!(
        pending.front(),
        Some(AgentInstanceConnectionEvent::Server(AgentInstanceServerMessage::ChannelMessageReceived { message, .. }))
            if message.message_id == "m2"
    ));
}

#[test]
fn inbound_drain_without_agent_keeps_slash_messages_batched() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    tx.send(channel_message_event(
        "m2",
        "chan-a",
        "@codex:1 /goal ship it",
    ))
    .unwrap();

    let mut pending = VecDeque::new();
    let mut messages = seeded_inbound_messages();

    drain_ready_inbound_channel_messages(&mut rx, &mut pending, "chan-a", &mut messages, None);

    assert_eq!(messages.len(), 2);
    assert!(pending.is_empty());
}

#[test]
fn inbound_drain_ignores_attachment_bearing_slash_messages() {
    let agent = test_serialized_agent("codex");
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let AgentInstanceConnectionEvent::Server(AgentInstanceServerMessage::ChannelMessageReceived {
        mut message,
        ack_required,
        interrupt_requested,
        ..
    }) = channel_message_event("m2", "chan-a", "@codex:1 /goal ship it")
    else {
        unreachable!("channel_message_event returns a channel message");
    };
    message.attachments = Some(vec![test_attachment("att-1", "one.png")]);
    tx.send(AgentInstanceConnectionEvent::Server(
        AgentInstanceServerMessage::ChannelMessageReceived {
            message,
            client_message_id: None,
            ack_required,
            interrupt_requested,
            delivery_intent: None,
        },
    ))
    .unwrap();

    let mut pending = VecDeque::new();
    let mut messages = seeded_inbound_messages();

    drain_ready_inbound_channel_messages(
        &mut rx,
        &mut pending,
        "chan-a",
        &mut messages,
        Some(&agent),
    );

    // Attachment-bearing bodies are not passthrough-eligible, so they
    // keep normal batching.
    assert_eq!(messages.len(), 2);
    assert!(pending.is_empty());
}

#[test]
fn codex_app_turn_input_preserves_channel_image_attachment() {
    let attachment = test_attachment("att-1", "screen.png");
    let sender = test_sender("Yiming Hu");

    let prompt = format_incoming_channel_message(
        "chan-1",
        &sender,
        "我发了个图片，你能看到吗",
        Some(std::slice::from_ref(&attachment)),
    );
    let image_files = write_local_image_files(Some(std::slice::from_ref(&attachment)))
        .expect("image attachment should materialize");
    let input = codex_turn_input_items(&prompt, Some(&[attachment]), Some(image_files.paths()))
        .expect("local image input should encode");

    assert_eq!(input.len(), 2);
    assert_eq!(input[0]["type"], "text");
    let prompt_text = input[0]["text"].as_str().unwrap();
    assert!(prompt_text.contains("xMatrix channel chan-1 from Yiming Hu [user]"));
    assert!(prompt_text.ends_with(&super::bootstrap::channel_collaboration_policy("chan-1")));
    assert!(prompt_text.contains("Attachments:"));
    assert!(prompt_text.contains("- image screen.png (68 bytes, image/png)"));
    assert!(!prompt_text.contains("data:image/png;base64"));
    assert_eq!(input[1]["type"], "image");
    assert_eq!(input[1]["url"], "data:image/png;base64,iVBORw0KGgo=");
}

#[test]
fn codex_app_turn_does_not_forward_remote_image_after_local_download_failure() {
    let attachment = ChannelAttachment {
        id: "att-1".to_string(),
        kind: "image".to_string(),
        name: "screen.png".to_string(),
        mime_type: "image/png".to_string(),
        size: 68,
        channel_id: Some("chan-1".to_string()),
        message_id: Some("message-1".to_string()),
        data_url: String::new(),
        url: Some("https://hub.example.test/stale-image-url".to_string()),
    };
    let prompt = codex_turn_text_with_unavailable_images("please inspect this image");

    let input = codex_turn_input_items(&prompt, Some(&[attachment]), Some(&[]))
        .expect("failed local materialization should still produce text input");

    assert_eq!(input.len(), 1);
    assert_eq!(input[0]["type"], "text");
    let text = input[0]["text"].as_str().unwrap();
    assert!(text.contains("xMatrix retried local retrieval"));
    assert!(text.contains("do not claim to have inspected"));
    assert!(!text.contains("stale-image-url"));
}

#[test]
fn claude_inbound_message_embeds_local_image_paths() {
    let attachment = test_attachment("att-1", "screen.png");
    let sender = test_sender("Yiming Hu");

    let local_path = PathBuf::from("/tmp/xmatrix-attachment-fake.png");
    let payload = format_incoming_channel_message_with_local_paths(
        "chan-1",
        &sender,
        "看这张图",
        Some(&[attachment]),
        Some(std::slice::from_ref(&local_path)),
    );

    assert!(payload.contains("xMatrix channel chan-1 from Yiming Hu [user]"));
    assert!(payload.contains("Attachments:"));
    assert!(payload.contains("- image screen.png at /tmp/xmatrix-attachment-fake.png"));
    assert!(payload.contains("read this file to view the image"));
    assert!(payload.ends_with(&super::bootstrap::channel_collaboration_policy("chan-1")));
    assert!(!payload.contains("data:image/png;base64"));
}

#[test]
fn write_local_image_files_materializes_image_bytes_on_disk() {
    let original_bytes: Vec<u8> = vec![137, 80, 78, 71, 13, 10, 26, 10];
    let encoded = base64::engine::general_purpose::STANDARD.encode(&original_bytes);
    let attachment = ChannelAttachment {
        size: original_bytes.len() as u64,
        data_url: format!("data:image/png;base64,{encoded}"),
        ..test_attachment("att-1", "shot.png")
    };

    let files = write_local_image_files(Some(&[attachment])).unwrap();
    assert_eq!(files.paths().len(), 1);
    let path = files.paths()[0].clone();
    let on_disk = std::fs::read(&path).unwrap();
    assert_eq!(on_disk, original_bytes);
    assert_eq!(path.extension().and_then(|s| s.to_str()), Some("png"));
    assert!(
        path.file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.starts_with("xmatrix-attachment-"))
            .unwrap_or(false)
    );

    drop(files);
    assert!(!path.exists());
}

#[test]
fn incoming_file_attachment_uses_local_path_when_materialized() {
    let attachment = ChannelAttachment {
        id: "att-file".to_string(),
        kind: "file".to_string(),
        name: "notes.pdf".to_string(),
        mime_type: "application/pdf".to_string(),
        size: 12,
        channel_id: Some("ch-1".to_string()),
        message_id: Some("msg-1".to_string()),
        data_url: String::new(),
        url: None,
    };
    let sender = test_sender("Yiming Hu");
    let payload = format_incoming_channel_message_with_local_paths(
        "chan-1",
        &sender,
        "see this pdf",
        Some(&[attachment]),
        Some(&[PathBuf::from("/tmp/xmatrix-attachment-notes.pdf")]),
    );
    assert!(payload.contains("- file notes.pdf at /tmp/xmatrix-attachment-notes.pdf"));
    assert!(payload.contains("read this file"));
}

#[tokio::test]
async fn materialize_reuses_durable_attachment_cache_across_drops() {
    let _guard = test_process_env_lock();
    let root = std::env::temp_dir().join(format!(
        "xmatrix-attachment-cache-test-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let previous = std::env::var("XMATRIX_CONFIG_DIR").ok();
    unsafe { std::env::set_var("XMATRIX_CONFIG_DIR", &root) };

    let original_bytes: Vec<u8> = vec![37, 80, 68, 70, 45, 49, 46, 52];
    let encoded = base64::engine::general_purpose::STANDARD.encode(&original_bytes);
    let attachment = ChannelAttachment {
        id: "att-pdf".to_string(),
        kind: "file".to_string(),
        name: "notes.pdf".to_string(),
        mime_type: "application/pdf".to_string(),
        size: original_bytes.len() as u64,
        channel_id: Some("ch-1".to_string()),
        message_id: Some("msg-1".to_string()),
        data_url: format!("data:application/pdf;base64,{encoded}"),
        url: None,
    };

    let first = materialize_local_image_files(Some(std::slice::from_ref(&attachment)), None)
        .await
        .unwrap();
    assert_eq!(first.paths().len(), 1);
    let ephemeral = first.paths()[0].clone();
    assert_eq!(std::fs::read(&ephemeral).unwrap(), original_bytes);
    let stem = attachment_cache::cache_stem_for_attachment(&attachment, Some(&original_bytes));
    let cached = attachment_cache::cached_attachment_path(&stem);
    assert!(cached.exists());
    drop(first);
    assert!(!ephemeral.exists());
    assert!(cached.exists());

    let second = materialize_local_image_files(Some(&[attachment]), None)
        .await
        .unwrap();
    assert_eq!(second.paths().len(), 1);
    assert_eq!(std::fs::read(&second.paths()[0]).unwrap(), original_bytes);
    drop(second);

    match previous {
        Some(value) => unsafe { std::env::set_var("XMATRIX_CONFIG_DIR", value) },
        None => unsafe { std::env::remove_var("XMATRIX_CONFIG_DIR") },
    }
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn incoming_url_attachment_uses_local_path_when_materialized() {
    let attachment = attachment_fixture::stored_url_attachment();
    let sender = test_sender("Yiming Hu");
    let local_path = PathBuf::from("/tmp/xmatrix-attachment-url.png");

    let payload = format_incoming_channel_message_with_local_paths(
        "chan-1",
        &sender,
        "",
        Some(&[attachment]),
        Some(&[local_path]),
    );

    assert!(payload.contains("- image stored.png at /tmp/xmatrix-attachment-url.png"));
    assert!(payload.contains("read this file to view the image"));
    assert!(!payload.contains("https://xmatrix.sh/api/xmatrix/channels/"));
}

#[test]
fn channel_image_data_url_accepts_parameters_before_base64() {
    let original_bytes: Vec<u8> = vec![1, 2, 3, 4];
    let encoded = base64::engine::general_purpose::STANDARD.encode(&original_bytes);
    let attachment = ChannelAttachment {
        size: original_bytes.len() as u64,
        data_url: format!("DATA:IMAGE/PNG;charset=utf-8;BASE64,{encoded}"),
        ..test_attachment("att-1", "shot.png")
    };

    let bytes = decode_channel_image_attachment_data_url(&attachment).unwrap();

    assert_eq!(bytes, original_bytes);
}

#[test]
fn channel_image_data_url_rejects_mime_mismatch() {
    let attachment = ChannelAttachment {
        data_url: "data:image/jpeg;base64,AQID".to_string(),
        ..attachment_fixture::image_attachment("att-1", "shot.png", "image/png", 3)
    };

    let error = decode_channel_image_attachment_data_url(&attachment).unwrap_err();

    assert!(
        error
            .to_string()
            .contains("Invalid channel image attachment data URL")
    );
}

#[test]
fn render_initial_message_attachment_lines_includes_paths() {
    let attachment = ChannelAttachment {
        data_url: "data:image/png;base64,AAAA".to_string(),
        ..attachment_fixture::image_attachment("att-1", "task.png", "image/png", 12)
    };
    let path = PathBuf::from("/tmp/xmatrix-attachment-init.png");
    let mut files = LocalImageFiles::empty();
    files.remember_path("att-1", path);
    let lines = render_initial_message_attachment_lines(Some(&[attachment]), &files);
    assert!(lines.contains("Attachments from xMatrix chat:"));
    assert!(lines.contains("- image task.png at /tmp/xmatrix-attachment-init.png"));
    assert!(lines.contains("read this file to view the image"));
}

#[test]
fn shared_bootstrap_is_folded_once_into_the_first_runtime_input() {
    let mut bootstrap = Some("shared bootstrap".to_string());

    let first = codex_turn_with_bootstrap(&mut bootstrap, "current assignment");
    assert!(first.contains("shared bootstrap"));
    assert!(first.contains("only live assignment"));
    assert!(first.ends_with("current assignment"));
    assert!(bootstrap.is_none());
    assert_eq!(
        codex_turn_with_bootstrap(&mut bootstrap, "next input"),
        "next input"
    );

    let mut blank_bootstrap = Some("  \n".to_string());
    assert_eq!(
        codex_turn_with_bootstrap(&mut blank_bootstrap, "first input"),
        "first input"
    );
}

#[test]
fn child_agent_env_keeps_existing_utf8_overrides_and_adds_missing_defaults() {
    let mut env = vec![("PYTHONUTF8".to_string(), "custom".to_string())];
    append_windows_utf8_env(&mut env);

    if cfg!(windows) {
        assert_eq!(
            env.iter()
                .find(|(key, _)| key == "PYTHONUTF8")
                .map(|(_, value)| value.as_str()),
            Some("custom")
        );
        assert!(
            env.iter()
                .any(|(key, value)| key == "PYTHONIOENCODING" && value == "utf-8")
        );
    } else {
        assert_eq!(env, vec![("PYTHONUTF8".to_string(), "custom".to_string())]);
    }
}

#[test]
fn windows_utf8_env_defaults_fill_only_what_nobody_configured() {
    let all = windows_utf8_env_defaults(|_| false);
    for expected in [
        ("PYTHONUTF8", "1"),
        ("PYTHONIOENCODING", "utf-8"),
        ("LANG", "C.UTF-8"),
    ] {
        assert!(all.contains(&expected), "{expected:?} missing from {all:?}");
    }
    assert!(!all.iter().any(|(key, _)| *key == "LC_ALL"));

    let configured = windows_utf8_env_defaults(|key| key == "PYTHONIOENCODING");
    assert!(!configured.iter().any(|(key, _)| *key == "PYTHONIOENCODING"));
    assert!(configured.contains(&("PYTHONUTF8", "1")));

    // Any configured locale variable keeps the user's locale untouched.
    for locale in ["LANG", "LC_ALL", "LC_CTYPE"] {
        let defaults = windows_utf8_env_defaults(|key| key == locale);
        assert!(
            !defaults.iter().any(|(key, _)| *key == "LANG"),
            "{locale} should suppress LANG"
        );
        assert!(defaults.contains(&("PYTHONUTF8", "1")));
    }
}

#[test]
fn utf8_env_key_lookup_matches_explicit_names_case_insensitively() {
    let explicit = [std::ffi::OsStr::new("PythonUtf8")];
    assert!(utf8_env_key_configured("PYTHONUTF8", explicit.into_iter()));
    assert!(!utf8_env_key_configured(
        "XMATRIX_TEST_UNSET_UTF8_KEY",
        explicit.into_iter()
    ));
}

#[test]
fn codex_app_cwd_preflight_rejects_missing_directory() {
    let missing = std::env::temp_dir().join(format!("xmatrix-missing-cwd-{}", std::process::id()));
    let result = validate_codex_app_cwd(Some(&missing.to_string_lossy()));

    assert!(result.is_err());
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("cwd preflight hook failed")
    );
}

#[test]
fn codex_resume_session_round_trips_by_resume_key() {
    let _guard = test_process_env_lock();
    let key = format!("codex-resume-test-{}", uuid::Uuid::new_v4());
    save_codex_resume_session_id(Some(&key), Some("thread-123")).expect("save codex resume");

    assert_eq!(
        load_codex_resume_session_id(Some(&key)).as_deref(),
        Some("thread-123")
    );

    let _ = std::fs::remove_file(codex_resume_session_path(&key));
}

#[test]
fn codex_resume_session_ignores_blank_values() {
    assert_eq!(load_codex_resume_session_id(None), None);
    assert_eq!(load_codex_resume_session_id(Some("   ")), None);
    save_codex_resume_session_id(Some("   "), Some("thread-123")).expect("blank key ignored");
    save_codex_resume_session_id(Some("codex-blank-thread"), Some("   "))
        .expect("blank session ignored");

    let _ = std::fs::remove_file(codex_resume_session_path("codex-blank-thread"));
}

#[test]
fn codex_cancelled_turn_is_not_labeled_failed() {
    let message = codex_turn_error_message("operation was canceled");

    assert!(message.contains("turn cancelled"));
    assert!(!message.contains("turn failed"));
}

#[test]
fn codex_turn_restart_is_limited_to_session_transport_failures() {
    assert!(!codex_turn_error_requires_restart(
        "Invalid channel image attachment data URL"
    ));
    assert!(!codex_turn_error_requires_restart("Network failed"));
    assert!(!codex_turn_error_requires_restart(
        "codex app-server turn/start failed: {\"message\":\"image not found\"}"
    ));
    assert!(codex_turn_error_requires_restart(
        "Codex app-server exited during turn"
    ));
    assert!(codex_turn_error_requires_restart(
        "codex app-server write failed: broken pipe"
    ));
    assert!(codex_turn_error_requires_restart(
        "Codex app-server connection lost: no events for 180s after final reconnect attempt (Reconnecting... 5/5)"
    ));
}

#[test]
fn codex_auth_failure_exits_instead_of_leaving_app_server_idle() {
    assert!(codex_auth_failure_requires_exit(
        "The token could not be refreshed because you logged out or switched accounts."
    ));
    assert!(codex_auth_failure_requires_exit(
        "Refresh token already used; please sign in again"
    ));
    assert!(codex_auth_failure_requires_exit(
        "Authentication required. Run `codex login`"
    ));
    assert!(!codex_auth_failure_requires_exit(
        "You have 120 weighted tokens left"
    ));
    assert!(!codex_auth_failure_requires_exit(
        "Codex app-server connection lost"
    ));
}

#[test]
fn codex_app_error_message_prefers_human_readable_fields() {
    let direct = serde_json::json!({
        "message": "Network failed",
        "code": "network_error",
    });
    let nested = serde_json::json!({
        "error": {
            "message": "Connection reset by peer",
            "type": "api_error"
        }
    });

    assert_eq!(codex_app_error_message(&direct), "Network failed");
    assert_eq!(codex_app_error_message(&nested), "Connection reset by peer");
}

#[test]
fn zcode_app_helpers_accept_interrupt_session_events_and_errors() {
    let cancel = zcode_cancel_notification("session-1");
    assert_eq!(cancel["method"], "session/cancel");
    assert_eq!(cancel["params"]["sessionId"], "session-1");
    assert!(cancel.get("id").is_none());
    assert!(zcode_message_id_matches(
        Some(&serde_json::json!("42")),
        "42"
    ));
    assert!(zcode_message_id_matches(Some(&serde_json::json!(42)), "42"));
    assert!(zcode_is_session_event(&serde_json::json!({
        "method": "session/event",
        "params": {
            "sessionId": "session-1",
            "type": "turn.completed",
        }
    })));
    assert_eq!(
        zcode_app_error_message(&serde_json::json!({
            "message": "Model unavailable",
            "code": "model_error",
        })),
        "Model unavailable"
    );
}

#[test]
fn codex_app_transport_reconnect_errors_are_transient() {
    assert!(codex_app_error_is_transient_transport(
        "Reconnecting... 2/5 (unexpected status 403 Forbidden)"
    ));
    assert!(codex_app_error_is_transient_transport(
        "Falling back from WebSockets to HTTPS transport. unexpected status 403 Forbidden"
    ));
    assert!(!codex_app_error_is_transient_transport("Network failed"));
    assert!(!codex_app_error_is_transient_transport(
        "codex app-server turn/start failed"
    ));
}

#[test]
fn codex_https_fallback_clears_final_reconnect_grace() {
    let mut state = CodexTransportRecoveryState::Healthy;

    assert!(state.observe_transport_error("Reconnecting... 2/5 (unexpected status 403 Forbidden)"));
    assert_eq!(state, CodexTransportRecoveryState::WebsocketReconnecting);
    assert!(state.observe_transport_error("Reconnecting... 5/5 (unexpected status 403 Forbidden)"));
    assert!(state.awaiting_https_fallback());
    assert_eq!(
        codex_reconnect_wait_timeout(state.awaiting_https_fallback()),
        Some(std::time::Duration::from_secs(180)),
    );

    assert!(state.observe_transport_error(
        "Falling back from WebSockets to HTTPS transport. unexpected status 403 Forbidden"
    ));
    assert_eq!(state, CodexTransportRecoveryState::Healthy);
    assert_eq!(
        codex_reconnect_wait_timeout(state.awaiting_https_fallback()),
        None
    );

    state.observe_non_error_event();
    assert_eq!(state, CodexTransportRecoveryState::Healthy);
}

#[test]
fn codex_final_reconnect_without_fallback_keeps_silence_grace() {
    let mut state = CodexTransportRecoveryState::Healthy;
    assert!(state.observe_transport_error("Reconnecting... 5/5"));

    assert_eq!(state.last_exhausted_error(), Some("Reconnecting... 5/5"));
    assert_eq!(
        codex_reconnect_wait_timeout(state.awaiting_https_fallback()),
        Some(std::time::Duration::from_secs(180)),
    );
}

#[test]
fn codex_non_transport_error_does_not_change_recovery_state() {
    let mut state = CodexTransportRecoveryState::Healthy;
    assert!(!state.observe_transport_error("Network failed"));
    assert_eq!(state, CodexTransportRecoveryState::Healthy);
}

#[test]
fn codex_reconnect_attempts_parses_attempt_fraction() {
    assert_eq!(
        codex_reconnect_attempts("Reconnecting... 2/5"),
        Some((2, 5))
    );
    assert_eq!(
        codex_reconnect_attempts("Reconnecting... 5/5 (unexpected status 403 Forbidden)"),
        Some((5, 5))
    );
    assert_eq!(codex_reconnect_attempts("Reconnecting..."), None);
    assert_eq!(
        codex_reconnect_attempts("Falling back from WebSockets to HTTPS transport"),
        None
    );
    assert_eq!(codex_reconnect_attempts("Network failed"), None);
}

#[test]
fn codex_reconnect_wait_timeout_error_reports_connection_loss() {
    let error = codex_reconnect_wait_timeout_error("Reconnecting... 5/5", 180);
    assert!(error.contains("connection lost"));
    assert!(error.contains("no events for 180s"));
    assert!(error.contains("Reconnecting... 5/5"));
}

#[tokio::test]
async fn agent_disconnect_falls_back_locally_without_failing_completed_work() {
    let hard_disconnected = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let hard_disconnected_for_callback = hard_disconnected.clone();
    let result = finish_agent_disconnect(
        async { Err(CliError::Relay("unregister unavailable".to_string())) },
        move || {
            hard_disconnected_for_callback.store(true, std::sync::atomic::Ordering::SeqCst);
        },
    )
    .await;

    assert!(result.is_ok());
    assert!(hard_disconnected.load(std::sync::atomic::Ordering::SeqCst));
}

#[test]
fn codex_runtime_trace_payload_classifies_transient_reconnect_errors() {
    let params = serde_json::json!({
        "error": {
            "message": "Reconnecting... 2/5",
            "additionalDetails": "request timed out",
        },
        "threadId": "thread-1",
        "turnId": "turn-1",
    });

    let payload = codex_runtime_trace_payload("error", &params, "thread-1", Some("turn-1"));

    assert_eq!(payload["category"], "connection");
    assert_eq!(payload["status"], "retrying");
    assert_eq!(
        payload["summary"],
        "connection retrying: Reconnecting... 2/5"
    );
    assert_eq!(payload["message"], "Reconnecting... 2/5");
}

#[test]
fn codex_runtime_trace_payload_keeps_fatal_errors_with_readable_summary() {
    let params = serde_json::json!({
        "error": { "message": "Model unavailable" },
    });

    let payload = codex_runtime_trace_payload("error", &params, "thread-1", None);

    assert_eq!(payload["category"], "error");
    assert_eq!(payload["status"], "failed");
    assert_eq!(payload["summary"], "error failed: Model unavailable");
    assert_eq!(payload["message"], "Model unavailable");
}

#[test]
fn codex_text_input_redacts_inline_data_urls() {
    let text = "before data:image/png;base64,iVBORw0KGgo= after";
    let input = codex_turn_input_items(text, None, None).unwrap();
    let prompt_text = input[0]["text"].as_str().unwrap();

    assert!(prompt_text.contains("before [data URL redacted: "));
    assert!(prompt_text.contains(" after"));
    assert!(!prompt_text.contains("data:image/png;base64"));
}

#[test]
fn codex_raw_response_message_extracts_output_text() {
    let item = serde_json::json!({
        "type": "message",
        "role": "assistant",
        "phase": codex_primary_output_phase(),
        "content": [
            { "type": "output_text", "text": "hello " },
            { "type": "output_text", "text": "world" }
        ]
    });

    let (text, phase) = codex_raw_response_message_text(&item).unwrap();

    assert_eq!(text, "hello world");
    assert_eq!(
        phase.as_deref(),
        Some(codex_primary_output_phase().as_str())
    );
}

#[test]
fn codex_raw_response_delta_extracts_common_stream_shapes() {
    let direct = serde_json::json!({
        "itemId": "raw-1",
        "delta": "hello "
    });
    let nested = serde_json::json!({
        "item": {
            "id": "raw-2",
            "type": "message",
            "role": "assistant",
            "content": [
                { "type": "output_text", "text": "world" }
            ]
        }
    });

    assert_eq!(codex_response_item_id(&direct).as_deref(), Some("raw-1"));
    assert_eq!(codex_response_item_id(&nested).as_deref(), Some("raw-2"));
    assert_eq!(
        codex_raw_response_delta_text(&direct).as_deref(),
        Some("hello ")
    );
    assert_eq!(
        codex_raw_response_delta_text(&nested).as_deref(),
        Some("world")
    );
}

#[test]
fn codex_runtime_trace_payload_normalizes_function_call_items() {
    let event = serde_json::json!({
        "item": {
            "id": "call-1",
            "type": "function_call",
            "name": "exec_command",
            "status": "completed",
            "arguments": { "cmd": "rg trace apps/web" }
        }
    });

    let payload = codex_runtime_trace_payload(
        "rawResponseItem/completed",
        &event,
        "thread-1",
        Some("turn-1"),
    );

    assert_eq!(payload["threadId"], "thread-1");
    assert_eq!(payload["turnId"], "turn-1");
    assert_eq!(payload["runtimeMethod"], "rawResponseItem/completed");
    assert_eq!(payload["category"], "tool");
    assert_eq!(payload["status"], "completed");
    assert_eq!(payload["itemId"], "call-1");
    assert_eq!(payload["itemType"], "function_call");
    assert_eq!(payload["toolName"], "exec_command");
    assert_eq!(payload["details"]["arguments"]["cmd"], "rg trace apps/web");
}

#[test]
fn codex_runtime_trace_payload_normalizes_shell_call_shapes() {
    let event = serde_json::json!({
        "item": {
            "id": "call-2",
            "type": "local_shell_call",
            "status": "completed",
            "call_id": "call_abc",
            "action": { "type": "shell_command", "command": "git status --short" },
            "output": " M packages/cli-rs/src/main.rs"
        }
    });

    let payload =
        codex_runtime_trace_payload("responseItem/completed", &event, "thread-1", Some("turn-1"));

    assert_eq!(payload["category"], "tool");
    assert_eq!(payload["status"], "completed");
    assert_eq!(payload["itemType"], "local_shell_call");
    assert_eq!(payload["toolName"], "shell_command");
    assert_eq!(payload["details"]["call_id"], "call_abc");
    assert_eq!(
        payload["details"]["action"]["command"],
        "git status --short"
    );
    assert!(should_publish_codex_runtime_trace(
        "responseItem/completed",
        &event
    ));
}

#[test]
fn codex_runtime_trace_payload_normalizes_function_call_output_items() {
    let event = serde_json::json!({
        "item": {
            "type": "function_call_output",
            "call_id": "call_abc",
            "output": "Exit code: 0\nWall time: 0.3 seconds\nOutput:\n M packages/cli-rs/src/main.rs"
        }
    });

    let payload = codex_runtime_trace_payload(
        "rawResponseItem/completed",
        &event,
        "thread-1",
        Some("turn-1"),
    );

    assert_eq!(payload["category"], "tool");
    assert_eq!(payload["status"], "completed");
    assert_eq!(payload["itemType"], "function_call_output");
    assert_eq!(payload["details"]["call_id"], "call_abc");
    assert!(
        payload["details"]["output"]
            .as_str()
            .unwrap()
            .contains("Exit code: 0")
    );
    assert!(should_publish_codex_runtime_trace(
        "rawResponseItem/completed",
        &event
    ));
}

#[test]
fn codex_runtime_trace_payload_covers_historical_tool_item_types() {
    let cases = vec![
        (
            "custom_tool_call",
            serde_json::json!({
                "type": "custom_tool_call",
                "name": "apply_patch",
                "status": "completed",
                "call_id": "call_patch",
                "input": "*** Begin Patch\n*** End Patch"
            }),
        ),
        (
            "custom_tool_call_output",
            serde_json::json!({
                "type": "custom_tool_call_output",
                "call_id": "call_patch",
                "output": "Success. Updated files"
            }),
        ),
        (
            "patch_apply_end",
            serde_json::json!({
                "type": "patch_apply_end",
                "status": "completed",
                "call_id": "call_patch",
                "success": true,
                "stdout": "Success. Updated files",
                "stderr": "",
                "changes": ["packages/cli-rs/src/main.rs"]
            }),
        ),
        (
            "exec_command_end",
            serde_json::json!({
                "type": "exec_command_end",
                "status": "completed",
                "call_id": "call_exec",
                "command": "cargo test codex_runtime_trace",
                "exit_code": 0,
                "stdout": "test result: ok",
                "stderr": "",
                "formatted_output": "Exit code: 0\nOutput:\ntest result: ok"
            }),
        ),
        (
            "mcp_tool_call_end",
            serde_json::json!({
                "type": "mcp_tool_call_end",
                "call_id": "call_mcp",
                "duration": 42,
                "invocation": { "tool": "browser.open" },
                "result": { "ok": true }
            }),
        ),
        (
            "web_search_call",
            serde_json::json!({
                "type": "web_search_call",
                "status": "completed",
                "action": { "query": "xmatrix trace" }
            }),
        ),
        (
            "web_search_end",
            serde_json::json!({
                "type": "web_search_end",
                "call_id": "ws_123",
                "query": "xmatrix trace",
                "action": { "query": "xmatrix trace" }
            }),
        ),
        (
            "image_generation_call",
            serde_json::json!({
                "type": "image_generation_call",
                "id": "ig_123",
                "status": "generating",
                "revised_prompt": "diagram"
            }),
        ),
        (
            "image_generation_end",
            serde_json::json!({
                "type": "image_generation_end",
                "call_id": "ig_123",
                "status": "completed",
                "saved_path": "C:/tmp/image.png"
            }),
        ),
        (
            "tool_search_call",
            serde_json::json!({
                "type": "tool_search_call",
                "status": "completed",
                "call_id": "call_search",
                "arguments": { "query": "browser tools" }
            }),
        ),
        (
            "tool_search_output",
            serde_json::json!({
                "type": "tool_search_output",
                "status": "completed",
                "call_id": "call_search",
                "tools": [{ "name": "browser.open" }]
            }),
        ),
    ];

    for (item_type, item) in cases {
        let event = serde_json::json!({ "item": item });
        let payload = codex_runtime_trace_payload(
            "responseItem/completed",
            &event,
            "thread-1",
            Some("turn-1"),
        );

        assert_eq!(payload["category"], "tool", "{item_type}");
        assert_eq!(payload["itemType"], item_type, "{item_type}");
        assert!(
            should_publish_codex_runtime_trace("responseItem/completed", &event),
            "{item_type}"
        );
        assert!(payload.get("details").is_some(), "{item_type}");
    }
}

/* The daemon hands the wrapper the Profile's stored name, and the Hub binds the
run to that exact string. Folding a valid name into a sanitized one made every
Profile named after a macOS host fail to start. */
#[test]
fn a_valid_profile_name_survives_the_override_verbatim() {
    for name in [
        "claude-Devs-MacBook-Pro.local",
        "kimi-eeveewangdeMac-mini.local",
        "codex_worker.02",
        "a",
    ] {
        assert!(super::is_platform_agent_name(name), "{name}");
    }
}

#[test]
fn a_name_the_platform_would_reject_is_not_taken_verbatim() {
    for name in [
        "",
        " ",
        "-leading-dash",
        ".leading-dot",
        "has space",
        "has/slash",
        "has:colon",
        "emoji-🎉",
    ] {
        assert!(!super::is_platform_agent_name(name), "{name:?}");
    }
}

#[test]
fn an_over_long_name_falls_back_to_sanitizing() {
    let long = format!("a{}", "b".repeat(124));
    assert!(!super::is_platform_agent_name(&long));
}

#[test]
fn sanitizing_still_folds_names_the_platform_rejects() {
    // The fallback keeps working for hand-set values like `XMATRIX_AGENT_NAME_OVERRIDE="My Agent"`.
    assert_eq!(super::sanitize_agent_name("My Agent"), "my-agent");
    assert_eq!(
        super::sanitize_agent_name("claude-Devs-MacBook-Pro.local"),
        "claude-devs-macbook-pro-local"
    );
}

#[test]
fn a_linked_agent_header_names_the_channel_its_ordinal_belongs_to() {
    let linked = MessageSender {
        kind: "agent".to_string(),
        label: "claude:3".to_string(),
        origin_channel_id: Some("chan-home".to_string()),
        ..test_sender("claude:3")
    };
    let prompt = format_incoming_channel_message("chan-away", &linked, "can you confirm?", None);
    assert!(
        prompt.contains("xMatrix channel chan-away from claude:3 [agent] via Channel chan-home:")
    );

    let local = MessageSender {
        kind: "agent".to_string(),
        label: "claude:3".to_string(),
        ..test_sender("claude:3")
    };
    let prompt = format_incoming_channel_message("chan-away", &local, "hi", None);
    assert!(prompt.contains("xMatrix channel chan-away from claude:3 [agent]:"));
}

#[test]
fn a_relayed_reply_header_names_who_answered_and_where_to_answer_back() {
    let relayed = MessageSender {
        kind: "user".to_string(),
        label: "claude:2".to_string(),
        ..test_sender("claude:2")
    };
    let metadata = serde_json::json!({
        "xmatrixProvenance": "cross_channel_reply",
        "crossChannelReply": {
            "sourceChannelId": "chan-away",
            "sourceMessageId": "reply-9",
            "linkMessageId": "link-1",
            "replierKind": "agent",
        },
    });
    let prompt = format_incoming_channel_message_with_context(
        "chan-home",
        Some("link-reply:reply-9"),
        None,
        None,
        false,
        &relayed,
        Some(&metadata),
        "confirmed",
        None,
        None,
    );
    assert!(
        prompt.contains(
            "from claude:2 [agent] replying in Channel chan-away to a cross-Channel request from this Channel \
             (answer there with `xmatrix send chan-away --reply-to reply-9`):"
        ),
        "{prompt}"
    );
    assert!(prompt.contains("reply-9`):confirmed"), "{prompt}");
}

fn seeded_inbound_messages() -> Vec<InboundChannelMessage> {
    vec![inbound_channel_message_from_event(channel_message_event("m1", "chan-a", "seed")).unwrap()]
}

fn assert_channel_message_ids(messages: &[InboundChannelMessage], expected: &[&str]) {
    assert_eq!(messages.len(), expected.len());
    for (message, expected_id) in messages.iter().zip(expected) {
        assert_eq!(&message.message_id, expected_id);
    }
}
