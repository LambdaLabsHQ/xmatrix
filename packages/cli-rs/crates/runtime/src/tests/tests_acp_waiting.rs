fn acp_waiting_fixture_path() -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/mock-acp-waiting.mjs")
        .to_string_lossy()
        .into_owned()
}

fn acp_waiting_report(frame: &serde_json::Value) -> bool {
    frame["type"] == "presence_update" && frame["runtimeState"].is_object()
}

async fn wait_for_frame(
    frames: &TraceFixtureLog,
    from: usize,
    predicate: impl Fn(&serde_json::Value) -> bool,
) -> usize {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(index) = frames
            .lock()
            .unwrap()
            .iter()
            .enumerate()
            .skip(from)
            .find_map(|(index, frame)| predicate(frame).then_some(index))
        {
            return index;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for expected frame; seen: {:#?}",
            frames.lock().unwrap()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn spawn_acp_waiting_fixture(
    name: &str,
    tool: &str,
    mode: &str,
    config: AcpVendorConfig,
) -> (
    SerializedAgent,
    Arc<AgentInstanceConnectionClient>,
    TraceFixtureLog,
    AcpSession,
) {
    require_node_fixture_runtime();
    let agent = test_serialized_agent(name);
    let (url, frames, _, _) = trace_fixture_hub(agent.clone()).await;
    let mut relay =
        AgentInstanceConnectionClient::new(url, "token".into(), name.into(), tool.into(), None);
    relay.register().await.expect("register relay");
    let mut app = AcpSession::spawn_stdio_with_prefix_args(
        "node",
        &[acp_waiting_fixture_path(), mode.into()],
        &[],
        Some(env!("CARGO_MANIFEST_DIR")),
        config,
    )
    .await
    .expect("spawn ACP waiting fixture");
    app.set_wait_timings(Duration::from_millis(150), Duration::from_millis(200));
    app.initialize(Some(env!("CARGO_MANIFEST_DIR")), None, false, None)
        .await
        .expect("initialize ACP waiting fixture");
    (agent, Arc::new(relay), frames, app)
}

async fn submit_acp_waiting_turn(
    app: &mut AcpSession,
    agent: &SerializedAgent,
    relay: &Arc<AgentInstanceConnectionClient>,
    runtime_state: &AgentRuntimeStateTracker,
) -> super::error::Result<super::CodexTurnResult> {
    app.submit_turn(
        "watch CI",
        vec![serde_json::json!({"type":"text","text":"watch CI"})],
        None,
        None,
        agent,
        Some(relay),
        Some("channel-1"),
        Some(runtime_state),
    )
    .await
}

fn make_acp_run<'a>(
    app: AcpSession,
    config: &'a AcpVendorConfig,
    relay: &'a Arc<AgentInstanceConnectionClient>,
    agent: &'a SerializedAgent,
    runtime_state: &'a AgentRuntimeStateTracker,
) -> super::AcpRun<'a> {
    super::AcpRun {
        app,
        config,
        relay,
        agent,
        cmd: "node",
        cmd_args: &[],
        cwd: Some(env!("CARGO_MANIFEST_DIR")),
        resume_session_key: None,
        trusted_rules: None,
        runtime_state,
        skill_overlay: Vec::new(),
        latest_model: None,
        latest_effort: None,
        available_models: Vec::new(),
        latest_goal: None,
        latest_usage: None,
        last_channel_id: Some("channel-1".into()),
        pending_bg_message: None,
        reactive_wakeup: None,
        subagent_wakeup_grace_deadline: None,
    }
}

#[tokio::test]
async fn acp_reports_long_tool_call_and_antigravity_background_tasks_as_waits() {
    tokio::time::timeout(Duration::from_secs(15), async {
        use crate::ChannelControlledRuntime as _;
        let _env_guard = crate::tests::test_process_env_lock();
        let config = AcpVendorConfig::generic("antigravity");
        assert!(config.supports_background_tasks);
        let (agent, relay, frames, app) =
            spawn_acp_waiting_fixture("antigravity-wait", "antigravity", "antigravity", config.clone())
                .await;
        let runtime_state = AgentRuntimeStateTracker::new("antigravity_acp");
        let mut run = make_acp_run(app, &config, &relay, &agent, &runtime_state);

        let mut runtime_turn = runtime_state.begin_turn(Some("channel-1"), None);
        let turn = submit_acp_waiting_turn(&mut run.app, &agent, &relay, &runtime_state).await;
        let cancelled = run
            .settle_turn(turn, Some("channel-1"), None, Some(&mut runtime_turn))
            .await
            .expect("settle turn");
        assert!(!cancelled);

        // 1. Long foreground command was reported as a tool wait, and the
        //    subagent call before it was never reported as a wait.
        let tool = wait_for_frame(&frames, 0, |frame| {
            acp_waiting_report(frame) && frame["runtimeState"]["waiting"]["kind"] == "tool"
        })
        .await;
        {
            let recorded = frames.lock().unwrap();
            assert_eq!(recorded[tool]["runtimeState"]["waiting"]["label"], "Wait for CI");
            assert_eq!(
                recorded[tool]["runtimeState"]["waiting"]["details"],
                serde_json::json!(["gh pr checks 7 --watch"])
            );
            assert!(
                recorded[tool]["status"].is_null(),
                "an in-turn wait update restates no status"
            );
            assert!(
                !recorded.iter().any(|frame| {
                    frame["runtimeState"]["waiting"]["label"]
                        .as_str()
                        .is_some_and(|label| label.contains("invoke_subagent"))
                }),
                "subagent calls must not report as waiting"
            );
        }
        // 2. Completing the foreground command cleared the tool wait.
        let cleared = wait_for_frame(&frames, tool + 1, |frame| {
            acp_waiting_report(frame) && frame["runtimeState"]["waiting"].is_null()
        })
        .await;
        // 3. end_turn with an open non-daemon schedule (and an open IsDaemon
        //    command) settled as idle + background wait for only the schedule.
        let bg_idle = wait_for_frame(&frames, cleared + 1, |frame| {
            acp_waiting_report(frame)
                && frame["status"] == "idle"
                && frame["runtimeState"]["waiting"]["kind"] == "background"
        })
        .await;
        {
            let recorded = frames.lock().unwrap();
            assert_eq!(recorded[bg_idle]["runtimeState"]["waiting"]["count"], 1);
            assert_eq!(
                recorded[bg_idle]["runtimeState"]["waiting"]["details"],
                serde_json::json!(["Check PR #1816 CI"])
            );
        }
        assert!(runtime_state.waiting_snapshot().is_some());

        // 4. Drive between-turns background polling until the timer completes,
        //    runs its reactive wakeup (`busy`), and settles back to `idle` with
        //    no remaining wait.
        while run.has_active_background_work() {
            if run.next_background_ready().await {
                run.handle_background_ready().await;
            }
        }
        let wakeup_busy = wait_for_frame(&frames, bg_idle + 1, |frame| {
            acp_waiting_report(frame)
                && frame["status"] == "busy"
                && frame["runtimeState"]["waiting"].is_null()
        })
        .await;
        wait_for_frame(&frames, wakeup_busy + 1, |frame| {
            acp_waiting_report(frame)
                && frame["status"] == "idle"
                && frame["runtimeState"]["waiting"].is_null()
        })
        .await;
        assert!(runtime_state.waiting_snapshot().is_none());

        run.app.shutdown().await;
    })
    .await
    .expect("antigravity waiting fixture must not hang");
}

#[tokio::test]
async fn non_antigravity_acp_reports_tool_waits_and_clears_unclosed_tools_at_end_turn() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let config = AcpVendorConfig::grok();
        assert!(!config.supports_background_tasks);
        let (agent, relay, frames, mut app) =
            spawn_acp_waiting_fixture("grok-wait", "grok", "unclosed-tool", config).await;
        let runtime_state = AgentRuntimeStateTracker::new("grok_acp");
        let _turn_guard = runtime_state.begin_turn(Some("channel-1"), None);
        let turn = submit_acp_waiting_turn(&mut app, &agent, &relay, &runtime_state)
            .await
            .expect("grok turn");
        assert!(!turn.failed, "{:?}", turn.failure_detail);

        let tool = wait_for_frame(&frames, 0, |frame| {
            acp_waiting_report(frame) && frame["runtimeState"]["waiting"]["kind"] == "tool"
        })
        .await;
        assert_eq!(
            frames.lock().unwrap()[tool]["runtimeState"]["waiting"]["label"],
            "gh pr checks 9 --watch"
        );
        wait_for_frame(&frames, tool + 1, |frame| {
            acp_waiting_report(frame) && frame["runtimeState"]["waiting"].is_null()
        })
        .await;
        assert!(runtime_state.waiting_snapshot().is_none());

        app.shutdown().await;
    })
    .await
    .expect("grok waiting fixture must not hang");
}

struct ScopedAppDataDir {
    path: PathBuf,
    previous: Option<std::ffi::OsString>,
}

impl ScopedAppDataDir {
    fn new(prefix: &str) -> Self {
        let path = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create temp app data dir");
        let previous = std::env::var_os("ANTIGRAVITY_APP_DATA_DIR");
        unsafe {
            std::env::set_var("ANTIGRAVITY_APP_DATA_DIR", &path);
        }
        Self { path, previous }
    }
}

impl Drop for ScopedAppDataDir {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(value) => unsafe { std::env::set_var("ANTIGRAVITY_APP_DATA_DIR", value) },
            None => unsafe { std::env::remove_var("ANTIGRAVITY_APP_DATA_DIR") },
        }
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

async fn run_antigravity_subagent_fixture(mode: &str) -> Vec<serde_json::Value> {
    use crate::ChannelControlledRuntime as _;
    let _env_guard = crate::tests::test_process_env_lock();
    let _app_data = ScopedAppDataDir::new("xmatrix-acp-subagent-fixture");

    let config = AcpVendorConfig::generic("antigravity");
    let (agent, relay, frames, app) =
        spawn_acp_waiting_fixture("antigravity-subagent", "antigravity", mode, config.clone())
            .await;
    let runtime_state = AgentRuntimeStateTracker::new("antigravity_acp");
    let mut run = make_acp_run(app, &config, &relay, &agent, &runtime_state);

    let mut runtime_turn = runtime_state.begin_turn(Some("channel-1"), None);
    let turn = submit_acp_waiting_turn(&mut run.app, &agent, &relay, &runtime_state).await;
    let cancelled = run
        .settle_turn(turn, Some("channel-1"), None, Some(&mut runtime_turn))
        .await
        .expect("settle turn");
    assert!(!cancelled);

    // At end_turn the subagent is still running: must stay `busy` (not `idle`
    // or `waiting`) and keep polling ACP stdout for the reactive wakeup.
    let busy_at_end_turn = wait_for_frame(&frames, 0, |frame| {
        acp_waiting_report(frame)
            && frame["status"] == "busy"
            && frame["runtimeState"]["waiting"].is_null()
    })
    .await;
    assert!(run.should_poll_background());
    assert!(run.has_active_background_work());
    assert!(runtime_state.waiting_snapshot().is_none());

    while run.has_active_background_work() {
        if run.next_background_ready().await {
            run.handle_background_ready().await;
        }
    }

    wait_for_frame(&frames, busy_at_end_turn + 1, |frame| {
        acp_waiting_report(frame)
            && frame["status"] == "idle"
            && frame["runtimeState"]["waiting"].is_null()
    })
    .await;

    run.app.shutdown().await;
    frames.lock().unwrap().clone()
}

#[tokio::test]
async fn antigravity_stays_busy_across_end_turn_while_subagent_runs_and_handles_wakeup() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let recorded = run_antigravity_subagent_fixture("antigravity-subagent").await;
        // Must never flash `idle` between end_turn and the reactive wakeup.
        let statuses: Vec<&str> = recorded
            .iter()
            .filter(|frame| acp_waiting_report(frame))
            .filter_map(|frame| frame["status"].as_str())
            .collect();
        assert!(
            statuses.len() >= 2 && statuses.last() == Some(&"idle"),
            "expected busy -> ... -> idle statuses, saw {statuses:?}"
        );
        assert!(
            statuses[..statuses.len() - 1].iter().all(|&s| s == "busy"),
            "must stay busy without flashing idle while subagent runs and wakes parent: {statuses:?}"
        );
    })
    .await
    .expect("antigravity subagent wakeup fixture must not hang");
}

#[tokio::test]
async fn antigravity_subagent_killed_without_wakeup_settles_back_to_idle() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let recorded = run_antigravity_subagent_fixture("antigravity-subagent-killed").await;
        let statuses: Vec<&str> = recorded
            .iter()
            .filter(|frame| acp_waiting_report(frame))
            .filter_map(|frame| frame["status"].as_str())
            .collect();
        assert_eq!(statuses, vec!["busy", "idle"]);
    })
    .await
    .expect("antigravity killed subagent fixture must not hang");
}
