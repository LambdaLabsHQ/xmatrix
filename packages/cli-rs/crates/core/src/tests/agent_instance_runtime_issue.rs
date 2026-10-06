use super::*;
use serde_json::{Value, json};

fn client(kind: &str) -> (AgentInstanceConnectionClient, mpsc::Receiver<String>) {
    let client = AgentInstanceConnectionClient::new(
        "ws://localhost/ws/agent-instances".into(),
        "token".into(),
        "builder".into(),
        kind.into(),
        None,
    );
    let (writer, receiver) = mpsc::channel(64);
    *client.write_tx.lock().unwrap() = Some(writer);
    (client, receiver)
}

fn presence(status: &str) -> AgentInstanceClientMessage {
    serde_json::from_value(json!({"type":"presence_update","status":status,"intent":"retain this task","runtimeState":{"status":if status=="busy" {"running"} else {"idle"},"activeChannelId":"ch1"}})).unwrap()
}

fn trace(phase: &str, payload: Value) -> AgentInstanceClientMessage {
    AgentInstanceClientMessage::EventPublish {
        request_id: None,
        channel_id: "ch1".into(),
        event_type: "llm_trace".into(),
        payload: json!({"schemaVersion":1,"source":"arbitrary-provider","phase":phase,"payload":payload}),
        event_id: None,
        timestamp: None,
    }
}

fn frame(receiver: &mut mpsc::Receiver<String>) -> Value {
    serde_json::from_str(&receiver.try_recv().unwrap()).unwrap()
}

#[test]
fn all_harnesses_publish_the_same_safe_retry_and_recovery_without_relaying_traces() {
    for kind in ["codex", "claude_code", "gemini", "copilot", "opencode"] {
        let (client, mut receiver) = client(kind);
        client.send_message(presence("busy")).unwrap();
        frame(&mut receiver);
        client.send_message(trace("runtime_event", json!({"category":"connection","status":"retrying","message":"PRIVATE_ERROR","rawPreview":"PRIVATE_TRACE"}))).unwrap();
        let retry = frame(&mut receiver);
        assert_eq!(retry["type"], "presence_update");
        assert_eq!(retry["runtimeState"]["issue"]["kind"], "retrying");
        assert!(!retry.to_string().contains("PRIVATE"));
        assert!(retry.get("intent").is_none());
        client
            .send_message(trace(
                "runtime_event",
                json!({"category":"connection","status":"retrying"}),
            ))
            .unwrap();
        assert!(receiver.try_recv().is_err());
        client.send_message(presence("busy")).unwrap();
        assert_eq!(
            frame(&mut receiver)["runtimeState"]["issue"],
            retry["runtimeState"]["issue"]
        );
        client
            .send_message(trace(
                "assistant_delta",
                json!({"delta":"PRIVATE_RESPONSE"}),
            ))
            .unwrap();
        let recovered = frame(&mut receiver);
        assert!(recovered["runtimeState"].get("issue").is_none());
        assert!(!recovered.to_string().contains("PRIVATE"));
        assert!(receiver.try_recv().is_err());
    }
}

#[test]
fn lifecycle_failure_covers_legacy_runtimes_and_persists_until_new_work() {
    let (client, mut receiver) = client("external-cli");
    client.send_message(presence("busy")).unwrap();
    frame(&mut receiver);
    client.send_message(serde_json::from_value(json!({"type":"agent_lifecycle","channelId":"ch1","layer":"application","status":"failed","reason":"turn_failed","detail":"PRIVATE_DIAGNOSTIC"})).unwrap()).unwrap();
    assert_eq!(
        frame(&mut receiver)["runtimeState"]["issue"]["kind"],
        "failed"
    );
    assert_eq!(frame(&mut receiver)["type"], "agent_lifecycle");
    client.send_message(presence("idle")).unwrap();
    assert_eq!(
        frame(&mut receiver)["runtimeState"]["issue"]["kind"],
        "failed"
    );
    client.send_message(presence("busy")).unwrap();
    assert!(frame(&mut receiver)["runtimeState"].get("issue").is_none());
}

#[test]
fn reconnect_replays_current_symptoms_and_instance_state_does_not_leak() {
    let (client, mut receiver) = client("codex");
    client.send_message(presence("busy")).unwrap();
    frame(&mut receiver);
    *client.write_tx.lock().unwrap() = None;
    client
        .send_message(trace(
            "runtime_event",
            json!({"category":"connection","status":"retrying"}),
        ))
        .unwrap();
    let (writer, mut replay) = mpsc::channel(4);
    install_connected_writer(&client.write_tx, &client.latest_presence, writer).unwrap();
    let restored = frame(&mut replay);
    assert_eq!(restored["runtimeState"]["issue"]["kind"], "retrying");
    assert_eq!(restored["intent"], "retain this task");
    let (other, mut receiver) = self::client("codex");
    other.send_message(presence("busy")).unwrap();
    assert!(frame(&mut receiver)["runtimeState"].get("issue").is_none());
}

#[tokio::test(start_paused = true)]
async fn the_owned_maintenance_timer_reports_silence_once_and_retries_a_full_queue() {
    let (client, mut receiver) = client("gemini");
    client.send_message(presence("busy")).unwrap();
    frame(&mut receiver);
    let clock = Arc::new(AtomicU64::new(now_ms()));
    let task_clock = clock.clone();
    let handle = spawn_trace_reaper(
        client.trace_store.clone(),
        client.intentional_close.clone(),
        client.latest_presence.clone(),
        client.write_tx.clone(),
        move || task_clock.load(Ordering::Acquire),
    );
    tokio::task::yield_now().await;
    clock.fetch_add(
        crate::agent_runtime_issue::NO_PROGRESS_MS,
        Ordering::Release,
    );
    tokio::time::advance(std::time::Duration::from_millis(TRACE_REAP_INTERVAL_MS)).await;
    tokio::task::yield_now().await;
    assert_eq!(
        frame(&mut receiver)["runtimeState"]["issue"]["kind"],
        "stalled"
    );
    tokio::time::advance(std::time::Duration::from_millis(TRACE_REAP_INTERVAL_MS)).await;
    tokio::task::yield_now().await;
    assert!(receiver.try_recv().is_err());
    handle.abort();

    let (writer, mut full_queue) = mpsc::channel(1);
    writer.try_send("already queued".into()).unwrap();
    *client.write_tx.lock().unwrap() = Some(writer);
    client
        .send_message(trace(
            "runtime_event",
            json!({"category":"connection","status":"retrying"}),
        ))
        .unwrap();
    assert!(
        client
            .latest_presence
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .issue_dirty
    );
    full_queue.try_recv().unwrap();
    client
        .latest_presence
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .publish_issue(&client.write_tx);
    assert_eq!(
        frame(&mut full_queue)["runtimeState"]["issue"]["kind"],
        "retrying"
    );
    assert!(
        !client
            .latest_presence
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .issue_dirty
    );
}

#[test]
fn error_advisories_are_visible_without_becoming_task_failure_or_public_text() {
    let (client, mut receiver) = client("gemini");
    client.send_message(presence("busy")).unwrap();
    frame(&mut receiver);
    client
        .send_message(trace(
            "runtime_event",
            json!({"category":"notice","status":"error","summary":"PRIVATE_WARNING"}),
        ))
        .unwrap();
    let notice = frame(&mut receiver);
    assert_eq!(notice["runtimeState"]["notice"]["severity"], "error");
    assert!(notice["runtimeState"].get("issue").is_none());
    assert!(!notice.to_string().contains("PRIVATE"));
}

#[test]
fn racing_presence_and_retry_cannot_publish_a_final_state_without_the_retry() {
    for _ in 0..16 {
        let (client, mut receiver) = client("codex");
        let client = Arc::new(client);
        client.send_message(presence("busy")).unwrap();
        frame(&mut receiver);
        let start = Arc::new(std::sync::Barrier::new(3));
        let presence_client = client.clone();
        let presence_start = start.clone();
        let presence_task = std::thread::spawn(move || {
            presence_start.wait();
            presence_client.send_message(presence("busy")).unwrap();
        });
        let trace_client = client.clone();
        let trace_start = start.clone();
        let trace_task = std::thread::spawn(move || {
            trace_start.wait();
            trace_client
                .send_message(trace(
                    "runtime_event",
                    json!({"category":"connection","status":"retrying"}),
                ))
                .unwrap();
        });
        start.wait();
        presence_task.join().unwrap();
        trace_task.join().unwrap();
        frame(&mut receiver);
        assert_eq!(
            frame(&mut receiver)["runtimeState"]["issue"]["kind"],
            "retrying"
        );
    }
}
