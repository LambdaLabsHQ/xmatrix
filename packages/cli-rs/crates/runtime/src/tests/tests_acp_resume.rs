/// A failed load starts a new session and clears the resume pointer itself,
/// so after one the test's own pointer may already be gone.
fn remove_resume_pointer_after_failed_load(key: &str) {
    match std::fs::remove_file(grok_resume_session_path(key)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => panic!("remove test resume pointer: {error}"),
    }
}

fn acp_resume_fixture_path() -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/mock-acp-resume.mjs")
        .to_string_lossy()
        .into_owned()
}

async fn spawn_acp_resume_fixture(mode: &str) -> (String, AcpSession) {
    let key = format!("acp-resume-test-{}", uuid::Uuid::new_v4());
    super::save_acp_resume_session_id("grok-resume", Some(&key), Some("loaded-session"))
        .expect("save resume pointer");
    let session = AcpSession::spawn_stdio_with_prefix_args(
        "node",
        &[acp_resume_fixture_path(), mode.into()],
        &[],
        Some(env!("CARGO_MANIFEST_DIR")),
        AcpVendorConfig::grok(),
    )
    .await
    .unwrap_or_else(|error| panic!("spawn {mode} resume fixture: {error}"));
    (key, session)
}

#[test]
fn acp_resume_streams_history_beyond_backlog_limit() {
    run_acp_resume_fixture_test(async {
        tokio::time::timeout(Duration::from_secs(10), async {
            let cwd = env!("CARGO_MANIFEST_DIR");
            let (key, mut session) = spawn_acp_resume_fixture("resume").await;
            let result = session.initialize(Some(cwd), Some(&key), true, None).await;
            std::fs::remove_file(grok_resume_session_path(&key))
                .expect("remove test resume pointer");
            let presentation = result.expect("load more than 1024 historical updates");
            assert_eq!(session.session_id.as_deref(), Some("loaded-session"));
            assert_eq!(presentation.model.as_deref(), Some("restored-model"));
            assert_eq!(presentation.effort.as_deref(), Some("high"));
            assert!(
                presentation
                    .commands
                    .unwrap()
                    .iter()
                    .any(|command| command.token == "/restored")
            );
            let usage = presentation.usage.expect("restored usage");
            assert_eq!(usage.context_used_tokens, Some(8192));
            assert_eq!(usage.context_window_tokens, Some(131072));
            assert_eq!(usage.cost_usd, Some(0.0042));
            let goal = session.loaded_goal.as_ref().expect("latest replayed goal");
            assert_eq!(goal.objective.as_deref(), Some("Restored goal"));
            assert_eq!(goal.status.as_deref(), Some("paused"));
            assert_eq!(goal.active, Some(false));
            let pending: Vec<_> = session.inbox.pending().cloned().collect();
            assert_eq!(pending.len(), 3, "only unrelated messages stay deferred");
            assert_eq!(pending[0]["method"], "vendor/notice");
            assert_eq!(pending[1]["id"], 999);
            assert_eq!(pending[2]["params"]["sessionId"], "other-session");
            let turn = session
                .submit_turn(
                    "new work",
                    vec![serde_json::json!({"type":"text","text":"new work"})],
                    None,
                    None,
                    &test_serialized_agent("grok-resume"),
                    None,
                    None,
                )
                .await
                .expect("first live turn after resume");
            assert!(!turn.failed, "{:?}", turn.failure_detail);
            assert_eq!(
                turn.local_output, "live reply",
                "history must not become live output"
            );
            session.shutdown().await;
        })
        .await
        .expect("resume fixture must not hang");
    });
}

#[test]
fn acp_resume_keeps_unrelated_and_new_session_backlogs_bounded() {
    run_acp_resume_fixture_test(async {
        for mode in ["foreign-overflow", "new-overflow"] {
            tokio::time::timeout(Duration::from_secs(10), async {
                let cwd = env!("CARGO_MANIFEST_DIR");
                let (key, mut session) = spawn_acp_resume_fixture(mode).await;
                let result = session
                    .initialize(Some(cwd), Some(&key), mode != "new-overflow", None)
                    .await;
                remove_resume_pointer_after_failed_load(&key);
                assert!(
                    result
                        .unwrap_err()
                        .to_string()
                        .contains("notification backlog full"),
                    "{mode}"
                );
                assert!(session.inbox.has_failure());
                assert!(!session.inbox.retryable());
                session.shutdown().await;
            })
            .await
            .expect("backlog fixture must not hang");
        }
    });
}

#[test]
fn acp_resume_failed_load_does_not_restore_historical_goal() {
    run_acp_resume_fixture_test(async {
        tokio::time::timeout(Duration::from_secs(10), async {
            let cwd = env!("CARGO_MANIFEST_DIR");
            let (key, mut session) = spawn_acp_resume_fixture("load-error").await;
            let result = session.initialize(Some(cwd), Some(&key), true, None).await;
            let saved = super::load_acp_resume_session_id("grok-resume", Some(&key));
            std::fs::remove_file(grok_resume_session_path(&key))
                .expect("remove test resume pointer");
            result.expect("failed load can fall back to a new session");
            assert_eq!(session.session_id.as_deref(), Some("new-session"));
            assert_eq!(saved.as_deref(), Some("new-session"));
            assert!(
                session.loaded_goal.is_none(),
                "failed replay must not restore a goal"
            );
            let turn = session
                .submit_turn(
                    "new work",
                    vec![serde_json::json!({"type":"text","text":"new work"})],
                    None,
                    None,
                    &test_serialized_agent("grok-resume"),
                    None,
                    None,
                )
                .await
                .expect("live turn after fallback");
            assert!(!turn.failed, "{:?}", turn.failure_detail);
            assert_eq!(turn.local_output, "live reply");
            assert!(turn.goal.is_none());
            session.shutdown().await;
        })
        .await
        .expect("fallback fixture must not hang");
    });
}

#[test]
fn acp_resume_only_consumes_target_session_notifications() {
    let request = serde_json::json!({"method":"session/load","params":{"sessionId":"target"}});
    let notification =
        serde_json::json!({"method":"session/update","params":{"sessionId":"target"}});
    assert!(super::acp_is_session_load_replay(&request, &notification));
    for (field, value) in [
        ("id", serde_json::json!(null)),
        ("id", serde_json::json!("permission")),
        ("method", serde_json::json!("vendor/notice")),
        ("params", serde_json::json!({"sessionId":"other"})),
        ("params", serde_json::json!({})),
    ] {
        let mut other = notification.clone();
        other[field] = value;
        assert!(!super::acp_is_session_load_replay(&request, &other));
    }
    let request = serde_json::json!({"method":"session/new","params":{"sessionId":"target"}});
    assert!(!super::acp_is_session_load_replay(&request, &notification));
}

fn run_acp_resume_fixture_test(operation: impl std::future::Future<Output = ()>) {
    // Resume paths use process-wide config; hold the same lock as config writers.
    let _guard = test_process_env_lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(operation);
}
