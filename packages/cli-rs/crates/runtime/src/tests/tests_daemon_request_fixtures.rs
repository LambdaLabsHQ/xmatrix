/// The Run a daemon test pretends a request came from.
#[derive(Clone)]
struct TestRunRequest {
    agent_id: Option<String>,
    agent_name: String,
    approval_channel_id: Option<String>,
    channel_id: String,
    run_id: Option<String>,
    execution_key: Option<String>,
    cwd: String,
}

fn test_daemon_request_record(
    _id: &str,
    _argv: Vec<String>,
    cwd: String,
    _timeout_sec: u64,
) -> TestRunRequest {
    TestRunRequest {
        agent_id: None,
        agent_name: "codex".to_string(),
        approval_channel_id: Some("channel-1".to_string()),
        channel_id: "channel-1".to_string(),
        run_id: None,
        execution_key: None,
        cwd,
    }
}

fn test_daemon_request_broker(_records: Vec<TestRunRequest>) -> super::DaemonRequestBroker {
    super::DaemonRequestBroker {
        url: "http://127.0.0.1:1".to_string(),
        owner_capability: "owner-cap".to_string(),
        agent_capabilities: std::sync::Arc::new(std::sync::Mutex::new(HashMap::new())),
        machine_id: None,
        hub_url: None,
        auth_broker_url: None,
        run_registry: Arc::new(super::AsyncMutex::new(HashMap::new())),
    }
}

fn test_daemon_run_child(request: &TestRunRequest, pid: u32) -> super::DaemonRunChild {
    super::DaemonRunChild {
        pid,
        cwd: Some(std::path::PathBuf::from("/tmp/workspace")),
        run_id: request.run_id.clone(),
        execution_key: request.execution_key.clone(),
        agent_id: request.agent_id.clone(),
        agent_name: Some(request.agent_name.clone()),
        auth_capability: Some("run-auth-capability".to_string()),
        request_capability: Some("request-capability".to_string()),
        request_context: Some(super::DaemonRequestAgentContext {
            agent_id: request.agent_id.clone(),
            agent_name: request.agent_name.clone(),
            space_id: "space-1".to_string(),
            approval_channel_id: request.approval_channel_id.clone(),
            channel_id: request.channel_id.clone(),
            run_id: request.run_id.clone(),
            execution_key: request.execution_key.clone(),
            workspace_cwd: request.cwd.clone(),
            admitted_secrets: None,
        }),
        ..test_empty_daemon_run_child()
    }
}

#[tokio::test]
async fn daemon_request_hub_routes_authorize_before_reporting_missing_hub() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for route in ["hub-bytes", "hub-json", "channel-history"] {
        for authorized in [false, true] {
            let broker = test_daemon_request_broker(Vec::new());
            if authorized {
                let record = test_daemon_request_record("run", Vec::new(), "/work".into(), 30);
                let context = test_daemon_run_child(&record, 1).request_context.unwrap();
                broker
                    .agent_capabilities
                    .lock()
                    .unwrap()
                    .insert(super::daemon_capability_key("request-capability"), context);
            }
            let (server, mut client) = tokio::io::duplex(4096);
            client.write_all(format!(
                "POST /request/{route} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\nx-xmatrix-request-capability: request-capability\r\n\r\n{{}}"
            ).as_bytes()).await.unwrap();
            super::handle_daemon_request_broker_request(server, broker).await;
            let mut response = String::new();
            client.read_to_string(&mut response).await.unwrap();
            let expected = if authorized {
                "503 Service Unavailable"
            } else {
                "401 Unauthorized"
            };
            assert!(
                response.starts_with(&format!("HTTP/1.1 {expected}")),
                "{route}: {response}"
            );
            assert!(response.contains(if authorized {
                "hub url unavailable"
            } else {
                "capability_not_granted"
            }));
        }
    }
}

fn test_daemon_workspace_value() -> serde_json::Value {
    serde_json::json!({
        "ownerUserId": "owner-1", "machineId": "machine-1", "hostId": "host-1",
        "canonicalCwd": "/srv/xmatrix", "displayName": "xmatrix",
        "visibility": "private", "createdAt": "2026-09-05T00:00:00Z",
        "updatedAt": "2026-09-05T00:00:00Z", "lastSeenAt": "2026-09-05T00:00:00Z"
    })
}
