mod trace_fixture_socket {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../core/tests/support/agent_socket_fixture.rs"
    ));
}

// Shared real-socket fixture for each trace adapter, on every platform.

type TraceFixtureLog = Arc<std::sync::Mutex<Vec<serde_json::Value>>>;
type TraceFixtureCommitGate = Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>>;

/// Accepts one relay connection, confirms registration, and records every frame
/// after it. Traces never ride the socket unasked (the Agent host retains them
/// until a Human opens the instance), so the fake Hub keeps asking for trace
/// history the way the real one does and keeps the latest answer.
async fn trace_fixture_hub(
    agent: SerializedAgent,
) -> (String, TraceFixtureLog, TraceFixtureLog, TraceFixtureCommitGate) {
    use futures_util::{SinkExt as _, StreamExt as _};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let frames: TraceFixtureLog = Arc::default();
    let traces: TraceFixtureLog = Arc::default();
    let commit_gate: TraceFixtureCommitGate = Arc::default();
    let held_commit = commit_gate.clone();
    let recorded = frames.clone();
    let retained = traces.clone();
    let instance_id = agent.instance_id.clone().unwrap_or_default();
    tokio::spawn(async move {
        let mut socket = trace_fixture_socket::registered_agent_socket(
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
                        received_order: Some(true),
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

async fn completed_trace_events(traces: &TraceFixtureLog) -> Vec<serde_json::Value> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let events = traces.lock().unwrap().clone();
            if events.iter().any(|event| event["metadata"]["payload"]["phase"] == "turn_completed") {
                return events;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.expect("host trace completes")
}
