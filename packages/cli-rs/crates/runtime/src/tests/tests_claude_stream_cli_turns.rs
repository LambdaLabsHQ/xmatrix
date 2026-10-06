mod agent_socket_fixture {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../core/tests/support/agent_socket_fixture.rs"
    ));
}

// Turns Claude starts by itself (a background task finished), driven end to end:
// a real ClaudeStreamSession, reader and watchdog talk to a fake Claude that
// replays the stream-json shapes observed from Claude 2.1.280, and publish to a
// fake Hub that records every frame the relay client sends.

type ClaudeCliTurnLog = Arc<std::sync::Mutex<Vec<serde_json::Value>>>;
type ClaudeCommitGate = Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>>;

/// Accepts one relay connection, confirms registration, and records every frame
/// after it. Traces never ride the socket unasked (the Agent host retains them
/// until a Human opens the instance), so the fake Hub keeps asking for trace
/// history the way the real one does and keeps the latest answer.
async fn claude_cli_turn_fake_hub(
    agent: SerializedAgent,
) -> (String, ClaudeCliTurnLog, ClaudeCliTurnLog, ClaudeCommitGate) {
    use futures_util::{SinkExt as _, StreamExt as _};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let frames: ClaudeCliTurnLog = Arc::default();
    let traces: ClaudeCliTurnLog = Arc::default();
    let commit_gate: ClaudeCommitGate = Arc::default();
    let held_commit = commit_gate.clone();
    let recorded = frames.clone();
    let retained = traces.clone();
    let instance_id = agent.instance_id.clone().unwrap_or_default();
    tokio::spawn(async move {
        let mut socket = agent_socket_fixture::registered_agent_socket(
            &listener,
            AgentInstanceServerMessage::AgentInstanceConnected {
                agent,
                peers: Vec::new(),
                hub_capabilities: None,
            },
        )
        .await;
        let mut poll = tokio::time::interval(Duration::from_millis(50));
        loop {
            tokio::select! {
                _ = poll.tick() => {
                    let request = serde_json::to_string(&AgentInstanceServerMessage::TraceHistoryRequested {
                        request_id: uuid::Uuid::new_v4().to_string(),
                        instance_id: instance_id.clone(),
                        max_events: 1000,
                        since: None,
                        before: None,
                        max_bytes: None,
                        wait_ms: None,
                    })
                    .unwrap();
                    if socket.send(tokio_tungstenite::tungstenite::Message::Text(request.into())).await.is_err() {
                        break;
                    }
                }
                message = socket.next() => {
                    let Some(Ok(message)) = message else { break };
                    let Ok(text) = message.into_text() else { continue };
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                    if value["type"] == "trace_history_result" {
                        // History is newest first; keep it in publication order.
                        let mut events = value["events"].as_array().cloned().unwrap_or_default();
                        events.reverse();
                        events.sort_by(|a, b| a["timestamp"].as_str().cmp(&b["timestamp"].as_str()));
                        let mut retained = retained.lock().unwrap();
                        if events.len() >= retained.len() {
                            *retained = events;
                        }
                    } else {
                        recorded.lock().unwrap().push(value.clone());
                        if value["type"] == "ping" {
                            if value["requestId"].is_string() {
                                // The real Hub completes the preceding durable
                                // presence write before answering this fence.
                                let gate = held_commit.lock().unwrap().take();
                                if let Some(gate) = gate {
                                    tokio::time::timeout(Duration::from_secs(10), gate)
                                        .await.expect("test releases the commit fence").unwrap();
                                }
                            }
                            let pong = serde_json::json!({"type":"pong", "requestId":value["requestId"], "ts":"2026-10-03T23:00:00Z"});
                            if socket.send(tokio_tungstenite::tungstenite::Message::Text(pong.to_string().into())).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        }
    });
    (
        format!("ws://{address}/ws/agent-instances"),
        frames,
        traces,
        commit_gate,
    )
}

struct ClaudeCliTurnFixture {
    // Readers persist observed model/effort through the process environment.
    // Keep other tests from redirecting those writes until shutdown completes.
    _process_env: std::sync::MutexGuard<'static, ()>,
    root: std::path::PathBuf,
    session: ClaudeStreamSession,
    relay: Arc<AgentInstanceConnectionClient>,
    agent: SerializedAgent,
    frames: ClaudeCliTurnLog,
    traces: ClaudeCliTurnLog,
    commit_gate: ClaudeCommitGate,
    /// How long a turn or an expected frame may take.
    patience: Duration,
}

impl ClaudeCliTurnFixture {
    async fn start(script: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("xmatrix-claude-cli-turn-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let script_path = root.join("fake-claude.sh");
        // Native initialization is a control frame, never a submitted turn.
        let read_user = r#"read_user() { while IFS= read -r line; do case "$line" in *'"type":"user"'*) return 0;; esac; done; return 1; }
"#;
        std::fs::write(&script_path, format!("{read_user}{script}")).unwrap();
        let args = [
            script_path.to_string_lossy().into_owned(),
            root.to_string_lossy().into_owned(),
        ];
        Self::start_command(root, "sh", &args, Duration::from_secs(5)).await
    }

    async fn start_command(
        root: std::path::PathBuf,
        cmd: &str,
        args: &[String],
        patience: Duration,
    ) -> Self {
        let mut agent = test_serialized_agent("claude-cli-turn");
        agent.agent_type = "claude_code".into();
        let (url, frames, traces, commit_gate) = claude_cli_turn_fake_hub(agent.clone()).await;
        let mut relay = AgentInstanceConnectionClient::new(
            url,
            "token".into(),
            "claude-cli-turn".into(),
            "claude_code".into(),
            None,
        );
        relay.register().await.expect("fake hub registration");
        let relay = Arc::new(relay);
        let session = ClaudeStreamSession::new(
            cmd,
            args,
            root.to_str(),
            None,
            false,
            relay.clone(),
            agent.clone(),
            None,
        );
        Self {
            _process_env: test_process_env_lock(),
            root,
            session,
            relay,
            agent,
            frames,
            traces,
            commit_gate,
            patience,
        }
    }

    async fn submit(
        &mut self,
        text: &str,
    ) -> crate::runtime_claude_stream_session::ClaudeStreamOutcome {
        tokio::time::timeout(
            self.patience * 2,
            self.session.submit_turn(
                text,
                vec![serde_json::json!({ "type": "text", "text": text })],
                "channel-1",
            ),
        )
        .await
        .expect("turn finishes")
    }

    /// Index of the first presence/control frame at or after `from` matching
    /// `pred`, waiting up to five seconds for it to arrive.
    async fn wait_for(&self, from: usize, pred: impl Fn(&serde_json::Value) -> bool) -> usize {
        Self::wait_in(&self.frames, from, self.patience, pred).await
    }

    /// Same, over the retained trace events, in publication order.
    async fn wait_for_trace(
        &self,
        from: usize,
        pred: impl Fn(&serde_json::Value) -> bool,
    ) -> usize {
        Self::wait_in(&self.traces, from, self.patience, pred).await
    }

    async fn wait_in(
        log: &ClaudeCliTurnLog,
        from: usize,
        patience: Duration,
        pred: impl Fn(&serde_json::Value) -> bool,
    ) -> usize {
        let deadline = std::time::Instant::now() + patience;
        loop {
            if let Some(index) = log.lock().unwrap().iter().skip(from).position(&pred) {
                return from + index;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "frame never arrived after index {from}: {:#?}",
                log.lock()
                    .unwrap()
                    .iter()
                    .map(|entry| {
                        let trace = &entry["metadata"]["payload"];
                        if trace.is_null() {
                            entry.clone()
                        } else {
                            serde_json::json!([trace["phase"], trace["payload"]])
                        }
                    })
                    .collect::<Vec<_>>()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn finish(mut self) {
        self.session.shutdown().await;
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn claude_cli_turn_trace(event: &serde_json::Value, phase: &str) -> bool {
    event["channelId"] == "channel-1"
        && event["metadata"]["payload"]["phase"] == phase
        && event["metadata"]["payload"]["payload"]["origin"] == "task-notification"
}

fn claude_cli_turn_presence(frame: &serde_json::Value, status: &str) -> bool {
    frame["type"] == "presence_update" && frame["status"] == status
}

/// The first turn starts a background task and ends; the task's completion
/// then drives a turn of its own. `$1` (the first argument after the script) is the
/// fixture root, so the fake can tell a respawn from its first run.
const CLAUDE_CLI_TURN_PRELUDE: &str = r#"root="$1"
emit() { printf '%s\n' "$1"; }
runs=$(cat "$root/runs" 2>/dev/null || echo 0)
echo $((runs + 1)) > "$root/runs"
read_user || exit 0
if [ "$runs" -gt 0 ]; then
  emit '{"type":"result","subtype":"success","result":"SECOND","session_id":"s2"}'
  sleep 30
  exit 0
fi
emit '{"type":"system","subtype":"init","session_id":"s1","model":"claude-test"}'
emit '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"STARTED"}]},"session_id":"s1"}'
emit '{"type":"result","subtype":"success","result":"STARTED","session_id":"s1"}'
sleep 1
emit '{"type":"system","subtype":"task_notification","task_id":"t1","status":"completed","summary":"Background command \"hub suite\" completed (exit code 0)","session_id":"s1"}'
"#;

const CLAUDE_CLI_TURN_WORKS: &str = r#"emit '{"type":"system","subtype":"init","session_id":"s1","model":"claude-test"}'
emit '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":500,"error_status":529,"error":"overloaded","session_id":"s1"}'
emit '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"FINISHED"}]},"session_id":"s1"}'
sleep 2
emit '{"type":"result","subtype":"success","result":"FINISHED","origin":{"kind":"task-notification"},"session_id":"s1"}'
read_user || exit 0
emit '{"type":"result","subtype":"success","result":"SECOND","session_id":"s1"}'
sleep 30
"#;

#[cfg(unix)]
#[tokio::test]
async fn claude_self_started_turn_is_published_on_the_last_channel() {
    let mut fixture =
        ClaudeCliTurnFixture::start(&format!("{CLAUDE_CLI_TURN_PRELUDE}{CLAUDE_CLI_TURN_WORKS}"))
            .await;
    let first = fixture.submit("start the suite in the background").await;
    assert!(matches!(first.status, ClaudeTurnStatus::Completed));
    assert_eq!(first.answer, "STARTED");

    let started = fixture
        .wait_for_trace(0, |event| claude_cli_turn_trace(event, "turn_started"))
        .await;
    let retry = fixture
        .wait_for_trace(started, |event| {
            event["metadata"]["payload"]["phase"] == "runtime_event"
                && event["metadata"]["payload"]["payload"]["category"] == "connection"
                && event["metadata"]["payload"]["payload"]["status"] == "retrying"
        })
        .await;
    let completed = fixture
        .wait_for_trace(started, |event| {
            claude_cli_turn_trace(event, "turn_completed")
        })
        .await;
    assert!(started < retry && retry < completed);
    let events = fixture.traces.lock().unwrap().clone();
    assert!(
        events[started..completed]
            .iter()
            .any(|event| event.to_string().contains("FINISHED")),
        "the self-started turn's own output is traced: {events:#?}"
    );
    assert_eq!(
        events[completed]["metadata"]["payload"]["payload"]["text"],
        "FINISHED"
    );
    assert_eq!(
        events[retry]["metadata"]["payload"]["payload"]["message"],
        "Claude API error 529 (overloaded); retry 1/10 in 1s"
    );

    // Presence goes busy for the self-started turn and back to idle after it.
    let busy = fixture
        .wait_for(0, |frame| claude_cli_turn_presence(frame, "busy"))
        .await;
    fixture
        .wait_for(busy, |frame| claude_cli_turn_presence(frame, "idle"))
        .await;

    let second = fixture.submit("next").await;
    assert_eq!(second.answer, "SECOND");
    fixture.finish().await;
}

#[cfg(unix)]
#[tokio::test]
async fn claude_self_started_result_does_not_complete_a_queued_channel_turn() {
    let mut fixture =
        ClaudeCliTurnFixture::start(&format!("{CLAUDE_CLI_TURN_PRELUDE}{CLAUDE_CLI_TURN_WORKS}"))
            .await;
    fixture.submit("start the suite in the background").await;
    fixture
        .wait_for_trace(0, |event| claude_cli_turn_trace(event, "turn_started"))
        .await;
    // Submitted while the self-started turn is still running: the process
    // queues it, and the self-started turn's result arrives first.
    let queued = fixture.submit("a human message").await;
    assert!(matches!(queued.status, ClaudeTurnStatus::Completed));
    assert_eq!(queued.answer, "SECOND");
    fixture
        .wait_for_trace(0, |event| claude_cli_turn_trace(event, "turn_completed"))
        .await;
    fixture.finish().await;
}

/// Claude 2.1.x absorbs an input written during a self-started turn at its next
/// tool boundary: it replays the input, finishes the one turn, and emits a
/// single task-notification result. No second result ever follows.
const CLAUDE_CLI_TURN_ABSORBS_INPUT: &str = r#"emit '{"type":"system","subtype":"init","session_id":"s1","model":"claude-test"}'
emit '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"sleep 12"}}]},"session_id":"s1"}'
read_user || exit 0
emit '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"done"}]},"session_id":"s1"}'
emit '{"type":"user","isReplay":true,"message":{"role":"user","content":[{"type":"text","text":"a human message"}]},"session_id":"s1"}'
emit '{"type":"assistant","message":{"id":"m3","role":"assistant","content":[{"type":"text","text":"FINISHED"}]},"session_id":"s1"}'
emit '{"type":"result","subtype":"success","result":"FINISHED","origin":{"kind":"task-notification"},"session_id":"s1"}'
sleep 30
"#;

#[cfg(unix)]
#[tokio::test]
async fn claude_self_started_result_completes_the_channel_turn_it_absorbed() {
    let mut fixture = ClaudeCliTurnFixture::start(&format!(
        "{CLAUDE_CLI_TURN_PRELUDE}{CLAUDE_CLI_TURN_ABSORBS_INPUT}"
    ))
    .await;
    fixture.submit("start the suite in the background").await;
    fixture
        .wait_for_trace(0, |event| claude_cli_turn_trace(event, "turn_started"))
        .await;
    let absorbed = fixture.submit("a human message").await;
    assert!(matches!(absorbed.status, ClaudeTurnStatus::Completed));
    assert_eq!(absorbed.answer, "FINISHED");
    fixture
        .wait_for_trace(0, |event| claude_cli_turn_trace(event, "turn_completed"))
        .await;
    fixture.finish().await;
}

#[cfg(unix)]
#[tokio::test]
async fn claude_watchdog_recovers_a_hung_self_started_turn() {
    // The self-started turn goes silent and never reads the liveness probe.
    let mut fixture =
        ClaudeCliTurnFixture::start(&format!("{CLAUDE_CLI_TURN_PRELUDE}sleep 30\n")).await;
    fixture.session.set_watchdog_timings(
        crate::runtime_claude_stream_session::ClaudeWatchdogTimings {
            tick: Duration::from_millis(100),
            idle_limit: Duration::from_millis(500),
            probe_grace: Duration::from_millis(500),
            ..Default::default()
        },
    );
    fixture.submit("start the suite in the background").await;
    let started = fixture
        .wait_for_trace(0, |event| claude_cli_turn_trace(event, "turn_started"))
        .await;
    fixture
        .wait_for_trace(started, |event| claude_cli_turn_trace(event, "turn_failed"))
        .await;
    let busy = fixture
        .wait_for(0, |frame| claude_cli_turn_presence(frame, "busy"))
        .await;
    fixture
        .wait_for(busy, |frame| claude_cli_turn_presence(frame, "idle"))
        .await;

    // The next channel message replaces the hung process.
    let next = fixture.submit("are you there").await;
    assert_eq!(next.answer, "SECOND");
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("runs"))
            .unwrap()
            .trim(),
        "2"
    );
    fixture.finish().await;
}

/// The same path against a real Claude Code process: a background Bash task
/// finishes after the channel turn ended, and the turn Claude starts for it
/// must reach the Hub. Requires an authenticated `claude` install, so it is
/// ignored by default. Run with:
///   cargo test -p xmatrix-cli-runtime -- --ignored claude_self_started_turn_live
#[cfg(unix)]
#[tokio::test]
#[ignore = "requires an authenticated `claude` install + network"]
async fn claude_self_started_turn_live() {
    let root = std::env::temp_dir().join(format!(
        "xmatrix-claude-cli-turn-live-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let args = [
        "--dangerously-skip-permissions".to_string(),
        "--model".to_string(),
        "haiku".to_string(),
    ];
    let mut fixture =
        ClaudeCliTurnFixture::start_command(root, "claude", &args, Duration::from_secs(120)).await;
    let first = fixture
        .submit(
            "Use the Bash tool with run_in_background set to true to run `sleep 5; echo done-marker`, \
             then end your turn replying only STARTED. When you are notified that it completed, \
             reply only FINISHED.",
        )
        .await;
    assert!(
        matches!(first.status, ClaudeTurnStatus::Completed),
        "{}",
        first.answer
    );
    let started = fixture
        .wait_for_trace(0, |event| claude_cli_turn_trace(event, "turn_started"))
        .await;
    let completed = fixture
        .wait_for_trace(started, |event| {
            claude_cli_turn_trace(event, "turn_completed")
        })
        .await;
    let text = fixture.traces.lock().unwrap()[completed]["metadata"]["payload"]["payload"]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert!(
        text.contains("FINISHED"),
        "self-started turn answered {text:?}"
    );
    let busy = fixture
        .wait_for(0, |frame| claude_cli_turn_presence(frame, "busy"))
        .await;
    fixture
        .wait_for(busy, |frame| claude_cli_turn_presence(frame, "idle"))
        .await;
    fixture.finish().await;
}

#[tokio::test]
async fn claude_pending_background_task_stream_end_reports_unknown_without_private_description() {
    let script = r#"read_user || exit 0
printf '%s\n' '{"type":"system","subtype":"init","session_id":"s1"}'
printf '%s\n' '{"type":"system","subtype":"task_started","task_id":"background-1","description":"PRIVATE_TASK_INPUT"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"waiting","session_id":"s1"}'
exit 0
"#;
    let mut fixture = ClaudeCliTurnFixture::start(script).await;
    let _ = fixture.submit("start background work").await;
    let index = fixture
        .wait_for(0, |frame| {
            frame["type"] == "agent_lifecycle" && frame["reason"] == "background_tasks_interrupted"
        })
        .await;
    let frame = fixture.frames.lock().unwrap()[index].clone();
    assert_eq!(frame["channelId"], "channel-1");
    assert_eq!(frame["status"], "blocked");
    assert!(
        frame["detail"]
            .as_str()
            .unwrap()
            .contains("outcome is unknown")
    );
    assert!(!frame.to_string().contains("PRIVATE_TASK_INPUT"));
    assert!(uuid::Uuid::parse_str(frame["requestId"].as_str().unwrap()).is_ok());
    fixture.finish().await;
}

#[cfg(unix)]
#[tokio::test]
async fn claude_rejected_usage_window_is_carried_on_that_turn_only() {
    let mut fixture = ClaudeCliTurnFixture::start(
        r#"emit() { printf '%s\n' "$1"; }
read_user || exit 0
emit '{"type":"system","subtype":"init","session_id":"s1","model":"claude-test"}'
emit '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":1790000000},"session_id":"s1"}'
emit '{"type":"result","subtype":"success","is_error":true,"result":"You have hit your limit","session_id":"s1"}'
read_user || exit 0
emit '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"},"session_id":"s1"}'
emit '{"type":"result","subtype":"success","result":"BACK","session_id":"s1"}'
sleep 30
"#,
    )
    .await;
    let limited = fixture.submit("work").await;
    assert!(matches!(limited.status, ClaudeTurnStatus::Failed));
    assert_eq!(
        limited.usage_limit,
        Some(crate::runtime_usage_limit::UsageLimit {
            resets_at: Some("2026-09-21T14:13:20Z".to_string())
        })
    );
    let next = fixture.submit("again").await;
    assert!(matches!(next.status, ClaudeTurnStatus::Completed));
    assert_eq!(next.answer, "BACK");
    assert_eq!(next.usage_limit, None);
    fixture.finish().await;
}

/// A background task finishes after the account is used up: the turn Claude
/// starts for it fails on the limit, and that limit reaches the Hub so the
/// Instance is handed off, even though no channel message started the turn.
#[cfg(unix)]
#[tokio::test]
async fn claude_self_started_turn_reports_its_usage_limit() {
    let mut fixture = ClaudeCliTurnFixture::start(&format!(
        "{CLAUDE_CLI_TURN_PRELUDE}{}",
        r#"emit '{"type":"assistant","message":{"id":"m2","model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"You have hit your weekly limit · resets Oct 4, 11pm (UTC)"}]},"session_id":"s1"}'
emit '{"type":"result","subtype":"success","is_error":true,"result":"You have hit your weekly limit · resets Oct 4, 11pm (UTC)","session_id":"s1"}'
sleep 30
"#
    ))
    .await;
    fixture.submit("start the suite in the background").await;
    let index = fixture
        .wait_for(0, |frame| {
            frame["type"] == "agent_lifecycle" && frame["reason"] == "usage_limited"
        })
        .await;
    let frame = fixture.frames.lock().unwrap()[index].clone();
    assert_eq!(frame["channelId"], "channel-1");
    assert_eq!(frame["status"], "failed");
    assert!(
        frame["detail"]
            .as_str()
            .unwrap()
            .contains("hit your weekly limit")
    );
    fixture.finish().await;
}

/// A channel turn whose `gh pr checks --watch` outlasts the threshold, then
/// ends with a background task still running; the task's completion starts a
/// turn of its own (docs/design/agent-status.md).
const CLAUDE_WAITING_SCRIPT: &str = r#"emit() { printf '%s\n' "$1"; }
read_user || exit 0
emit '{"type":"system","subtype":"init","session_id":"s1","model":"claude-test"}'
emit '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"gh pr checks 7 --watch","description":"Wait for CI on PR #7"}}]},"session_id":"s1"}'
sleep 1
emit '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"all checks passed"}]},"session_id":"s1"}'
emit '{"type":"system","subtype":"task_started","task_id":"bg1","description":"Tail the deploy log","session_id":"s1"}'
emit '{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"WATCHING"}]},"session_id":"s1"}'
emit '{"type":"result","subtype":"success","result":"WATCHING","session_id":"s1"}'
sleep 1
emit '{"type":"system","subtype":"task_notification","task_id":"bg1","status":"completed","summary":"done","session_id":"s1"}'
emit '{"type":"result","subtype":"success","result":"DONE","origin":{"kind":"task-notification"},"session_id":"s1"}'
sleep 30
"#;

fn claude_waiting_report(frame: &serde_json::Value) -> bool {
    frame["type"] == "presence_update" && frame["runtimeState"].is_object()
}

#[cfg(unix)]
#[tokio::test]
async fn claude_reports_a_long_tool_call_and_its_background_tasks_as_waits() {
    let mut fixture = ClaudeCliTurnFixture::start(CLAUDE_WAITING_SCRIPT).await;
    fixture.session.set_watchdog_timings(
        crate::runtime_claude_stream_session::ClaudeWatchdogTimings {
            tool_wait: Duration::from_millis(200),
            ..Default::default()
        },
    );
    let outcome = fixture.submit("merge it when CI is green").await;
    assert_eq!(outcome.answer, "WATCHING");

    // The watch outlasts the threshold: a wait, as Claude described the call,
    // with the command under it.
    let tool = fixture
        .wait_for(0, |frame| {
            claude_waiting_report(frame) && frame["runtimeState"]["waiting"]["kind"] == "tool"
        })
        .await;
    let frames = fixture.frames.lock().unwrap().clone();
    assert_eq!(
        frames[tool]["runtimeState"]["waiting"]["label"],
        "Wait for CI on PR #7"
    );
    assert_eq!(
        frames[tool]["runtimeState"]["waiting"]["details"],
        serde_json::json!(["gh pr checks 7 --watch"])
    );
    assert!(
        frames[tool]["status"].is_null(),
        "a wait report restates no status"
    );
    // Its result ends the wait.
    fixture
        .wait_for(tool + 1, |frame| {
            claude_waiting_report(frame) && frame["runtimeState"]["waiting"].is_null()
        })
        .await;

    // The turn ended with the task running: the state its `idle` report
    // carries says so, with the task's description.
    let between = fixture
        .session
        .runtime_state
        .waiting_snapshot()
        .expect("a background wait outlives the turn");
    let waiting = between.waiting.expect("waiting");
    assert_eq!(waiting.kind, "background");
    assert_eq!(waiting.label.as_deref(), Some("1 task"));
    assert_eq!(waiting.details, vec!["Tail the deploy log".to_string()]);

    // The task's own turn starts: nothing is waited on any more.
    let busy = fixture
        .wait_for(tool, |frame| claude_cli_turn_presence(frame, "busy"))
        .await;
    fixture
        .wait_for(busy, |frame| {
            claude_waiting_report(frame) && frame["runtimeState"]["waiting"].is_null()
        })
        .await;
    let idle = fixture
        .wait_for(busy, |frame| claude_cli_turn_presence(frame, "idle"))
        .await;
    let frames = fixture.frames.lock().unwrap().clone();
    assert!(
        frames[idle]["runtimeState"].is_null(),
        "no wait is left to carry"
    );
    assert!(fixture.session.runtime_state.waiting_snapshot().is_none());
    assert!(
        !frames
            .iter()
            .any(|frame| frame.to_string().contains("private deploy log"))
    );
    fixture.finish().await;
}

fn claude_presentation_read_context(
    controls: Arc<crate::runtime_claude_stream_session::ClaudeSessionControls>,
    effort_transcript: crate::runtime_agent_goal_status::ClaudeTranscriptWatcher,
    presentation_pending: bool,
) -> crate::runtime_claude_stream_io::ClaudeStreamReadContext {
    crate::runtime_claude_stream_io::ClaudeStreamReadContext {
        session: crate::runtime_claude_stream_io::ClaudeSessionState {
            last_session_id: Arc::new(std::sync::Mutex::new(None)),
            resume_session_key: None,
            goal_supported: Arc::new(std::sync::Mutex::new(None)),
            slash_command_overlay: Arc::new(std::sync::Mutex::new(Vec::new())),
            model_state: controls,
        },
        control_stdin: Arc::new(std::sync::Mutex::new(None)),
        cli_turn_channel: Arc::new(std::sync::Mutex::new(None)),
        effort_transcript,
        presentation_pending,
        runtime_state: crate::AgentRuntimeStateTracker::new("claude_code"),
        tool_wait_threshold: crate::runtime_waiting::TOOL_WAIT_THRESHOLD,
    }
}

#[tokio::test]
async fn claude_first_turn_publishes_observed_model_and_transcript_effort_without_slash_overlay() {
    use crate::runtime_claude_stream_session::{ActiveStreamTurn, ClaudeSessionControls};
    for scenario in ["delayed", "buffered", "absent"] {
        let buffered = scenario == "buffered";
        let fixture = ClaudeCliTurnFixture::start("read_user || exit 0\nsleep 30\n").await;
        let transcript = fixture.root.join("first.jsonl");
        std::fs::write(&transcript, "{\"type\":\"assistant\",\"effort\":\"low\"}\n").unwrap();
        let mut effort_transcript =
            crate::runtime_agent_goal_status::ClaudeTranscriptWatcher::bound_to(
                fixture.root.clone(),
                "first",
                transcript.clone(),
            );
        effort_transcript.poll(Some("first"));
        if buffered {
            std::fs::write(&transcript, "{\"type\":\"assistant\",\"effort\":\"low\"}\n{\"type\":\"assistant\",\"effort\":\"high\"}\n").unwrap();
        }
        let mut child = tokio::process::Command::new("sh")
        .args([
            "-c",
            r#"printf '%s\n' '{"type":"system","subtype":"init","session_id":"first","model":"claude-test"}'
sleep 1
printf '%s\n' '{"type":"assistant","session_id":"first","message":{"id":"first-answer","model":"claude-test","content":[{"type":"text","text":"READY"}]}}'
sleep 0.16
if [ "$2" != absent ]; then
    printf '%s\n' '{"type":"assistant","effort":"high"}' >> "$1"
fi
sleep 1"#,
            "fixture",
            transcript.to_str().unwrap(),
            scenario,
        ])
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn().unwrap();
        let controls = Arc::new(ClaudeSessionControls::new(None, None));
        let active = Arc::new(tokio::sync::Mutex::new(Some(ActiveStreamTurn {
            channel_id: "channel-1".into(),
            ..Default::default()
        })));
        let reader = tokio::spawn(crate::runtime_claude_stream_io::claude_stream_reader(
            child.stdout.take().unwrap(),
            fixture.relay.clone(),
            fixture.agent.clone(),
            active,
            Arc::new(std::sync::atomic::AtomicBool::new(true)),
            Arc::new(std::sync::Mutex::new(std::time::Instant::now())),
            claude_presentation_read_context(controls.clone(), effort_transcript, false),
        ));
        // The init has no slash_commands. State must already be published while
        // Claude is still waiting to emit its first assistant frame/tool action.
        let initial = fixture
            .wait_for(0, |frame| {
                frame["type"] == "presence_update" && frame["model"] == "claude-test"
            })
            .await;
        if buffered {
            assert_eq!(
                fixture.frames.lock().unwrap()[initial]["effort"],
                "high",
                "init must not discard this turn's effort when stdout is buffered"
            );
        } else {
            assert!(
                fixture.frames.lock().unwrap()[initial]["effort"].is_null(),
                "an unseen effort must not be invented"
            );
            if scenario != "absent" {
                fixture
                    .wait_for(initial + 1, |frame| {
                        frame["type"] == "presence_update"
                            && frame["model"] == "claude-test"
                            && frame["effort"] == "high"
                    })
                    .await;
            }
        }
        assert_eq!(controls.current().as_deref(), Some("claude-test"));
        assert_eq!(
            controls.current_effort().as_deref(),
            if scenario == "absent" {
                None
            } else {
                Some("high")
            }
        );
        tokio::time::timeout(Duration::from_secs(5), reader)
            .await
            .unwrap()
            .unwrap();
        child.wait().await.unwrap();
        if scenario == "absent" {
            assert!(
                controls.current_effort().is_none(),
                "a bounded read timeout must retain unknown effort"
            );
            assert!(
                fixture
                    .frames
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|frame| frame["type"] == "presence_update")
                    .all(|frame| frame["effort"].is_null())
            );
        }
        fixture.finish().await;
    }
}

/// The native tool starts independently of the stdout reader, while its own
/// assistant record is still being written and the Hub has not committed
/// presentation. Exercise the exact gate used by channel::cmd_send.
#[tokio::test]
async fn claude_first_tool_send_waits_for_native_effort_and_hub_commit() {
    const CHILD: &str = "XMATRIX_TEST_CLAUDE_PRESENTATION_CHILD";
    if std::env::var_os(CHILD).is_none() {
        // Other session fixtures legitimately clear their ambient Run marker
        // during shutdown. A process-env mutex only excludes cooperating tests;
        // run this real marker/send boundary in its own process, like a wrapper.
        let output = tokio::time::timeout(
            Duration::from_secs(15),
            tokio::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tests::claude_first_tool_send_waits_for_native_effort_and_hub_commit",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env(CHILD, "1")
                .env_remove("XMATRIX_RUN_ID")
                .env_remove("XMATRIX_RUN_STATUS_FILE")
                .kill_on_drop(true)
                .output(),
        )
        .await
        .expect("isolated first-send fixture must remain bounded")
        .expect("start isolated first-send fixture");
        assert!(
            output.status.success(),
            "isolated first-send fixture failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        return;
    }
    use crate::runtime_claude_stream_session::{ActiveStreamTurn, ClaudeSessionControls};
    let fixture = ClaudeCliTurnFixture::start("read_user || exit 0\nsleep 30\n").await;
    let (release_commit, commit) = tokio::sync::oneshot::channel();
    *fixture.commit_gate.lock().unwrap() = Some(commit);
    let marker = fixture.root.join("run.status.json");
    crate::write_daemon_run_status_marker_to_path(&marker, "turn_running", false, None);
    struct RestoreStatus(Option<std::ffi::OsString>);
    impl Drop for RestoreStatus {
        fn drop(&mut self) {
            unsafe {
                match self.0.take() {
                    Some(value) => std::env::set_var("XMATRIX_RUN_STATUS_FILE", value),
                    None => std::env::remove_var("XMATRIX_RUN_STATUS_FILE"),
                }
            }
        }
    }
    let restore = RestoreStatus(std::env::var_os("XMATRIX_RUN_STATUS_FILE"));
    unsafe { std::env::set_var("XMATRIX_RUN_STATUS_FILE", &marker) };
    assert!(crate::write_current_run_presentation_pending(true));
    let transcript = fixture.root.join("first.jsonl");
    std::fs::write(&transcript, "").unwrap();
    let mut effort_transcript = crate::runtime_agent_goal_status::ClaudeTranscriptWatcher::bound_to(
        fixture.root.clone(),
        "first",
        transcript.clone(),
    );
    effort_transcript.poll(Some("first"));
    let started = fixture.root.join("tool-started");
    let mut child = tokio::process::Command::new("sh").args([
        "-c",
        r#"printf '%s\n' '{"type":"system","subtype":"init","session_id":"first","model":"claude-test"}'
printf '%s\n' '{"type":"assistant","session_id":"first","message":{"id":"tool-1","model":"claude-test","content":[{"type":"tool_use","id":"send-1","name":"Bash","input":{}}]}}'
: > "$2"
sleep 0.16
printf '%s\n' '{"type":"assistant","effort":"medium"}' >> "$1"
sleep 1"#,
        "fixture", transcript.to_str().unwrap(), started.to_str().unwrap(),
    ]).stdout(std::process::Stdio::piped()).kill_on_drop(true).spawn().unwrap();
    let controls = Arc::new(ClaudeSessionControls::new(None, None));
    let reader = tokio::spawn(crate::runtime_claude_stream_io::claude_stream_reader(
        child.stdout.take().unwrap(),
        fixture.relay.clone(),
        fixture.agent.clone(),
        Arc::new(tokio::sync::Mutex::new(Some(ActiveStreamTurn {
            channel_id: "channel-1".into(),
            ..Default::default()
        }))),
        Arc::new(std::sync::atomic::AtomicBool::new(true)),
        Arc::new(std::sync::Mutex::new(std::time::Instant::now())),
        claude_presentation_read_context(controls.clone(), effort_transcript, true),
    ));
    let tool_marker = marker.clone();
    let (tool_started, waiting_tool) = tokio::sync::oneshot::channel();
    let tool = tokio::spawn(async move {
        while !started.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        tool_started.send(()).unwrap();
        xmatrix_cli_core::presentation_barrier::wait_for_path(&tool_marker, Duration::from_secs(10))
            .await
    });
    let ping = fixture
        .wait_for(0, |frame| {
            frame["type"] == "ping" && frame["requestId"].is_string()
        })
        .await;
    waiting_tool.await.unwrap();
    assert!(
        !tool.is_finished(),
        "enqueueing presence is insufficient to release the tool"
    );
    // The commit remains held regardless of how late CI schedules an assertion.
    // Still exercise a real delayed Hub response, then explicitly release it.
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(
        !tool.is_finished(),
        "the tool must wait through the Hub commit delay"
    );
    release_commit.send(()).unwrap();
    assert!(tool.await.unwrap());
    {
        let frames = fixture.frames.lock().unwrap();
        let presence = frames[..ping]
            .iter()
            .rev()
            .find(|frame| frame["type"] == "presence_update" && frame["requestId"].is_string())
            .unwrap();
        assert_eq!(presence["model"], "claude-test");
        assert_eq!(presence["effort"], "medium");
        assert_eq!(presence["requestId"], frames[ping]["requestId"]);
    }
    reader.await.unwrap();
    child.wait().await.unwrap();
    drop(restore);
    fixture.finish().await;
}
