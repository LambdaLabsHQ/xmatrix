struct SendBrokerFixture {
    root: std::path::PathBuf,
    profile: xmatrix_cli_core::profile::ProfileContext,
    broker: super::DaemonRequestBroker,
    request: super::DaemonLocalHttpRequest,
}

impl SendBrokerFixture {
    async fn new(hub_url: String, auth_url: String) -> Self {
        use xmatrix_cli_core::profile::{InstallationRoot, ProfileStore};
        let _ = rustls::crypto::ring::default_provider().install_default();
        let root =
            std::env::temp_dir().join(format!("xmatrix-send-boundary-{}", uuid::Uuid::new_v4()));
        let profiles = ProfileStore::new(InstallationRoot::new(root.clone()));
        let profile = profiles
            .context_for_default(&profiles.load_or_bootstrap().unwrap())
            .unwrap();
        let mut broker = test_daemon_request_broker(Vec::new());
        broker.hub_url = Some(hub_url);
        broker.auth_broker_url = Some(auth_url);
        let mut record = test_daemon_request_record("send", vec![], root.display().to_string(), 30);
        record.agent_id = Some("agent".into());
        record.run_id = Some("run".into());
        record.execution_key = Some("EXECUTION_SECRET".into());
        let mut run = test_daemon_run_child(&record, 1);
        run.instance_id = Some("instance".into());
        run.request_capability = Some("request-capability".into());
        broker.agent_capabilities.lock().unwrap().insert(
            super::daemon_capability_key("request-capability"),
            run.request_context.clone().unwrap(),
        );
        broker.run_registry.lock().await.insert("run".into(), run);
        let request = super::DaemonLocalHttpRequest {
            method: "POST".into(),
            path: "/request/hub-json".into(),
            query: HashMap::new(),
            body: vec![],
            headers: HashMap::from([(
                "x-xmatrix-request-capability".into(),
                "request-capability".into(),
            )]),
        };
        Self {
            root,
            profile,
            broker,
            request,
        }
    }

    async fn listeners() -> (Self, tokio::net::TcpListener, tokio::net::TcpListener) {
        let hub = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let auth = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Self::new(
            format!("http://{}", hub.local_addr().unwrap()),
            format!("http://{}", auth.local_addr().unwrap()),
        )
        .await;
        (fixture, hub, auth)
    }

    fn journal_root(&self) -> std::path::PathBuf {
        self.profile.state_root.join("send-operations-v1")
    }

    fn payload(&self) -> super::DaemonHubJsonRequest {
        super::DaemonHubJsonRequest {
            url: format!(
                "{}/api/channels/channel/messages",
                self.broker.hub_url.as_ref().unwrap()
            ),
            method: "POST".into(),
            token: Some("CALLER_HUMAN_TOKEN_MUST_NOT_BE_USED".into()),
            journal_send: true,
            body: Some(
                serde_json::json!({"body":"PRIVATE_REPLY", "clientMessageId":"message", "senderAgentId":"agent",
                "senderAgentInstanceId":"instance", "senderRunId":"run", "senderExecutionKey":"EXECUTION_SECRET"}),
            ),
        }
    }

    fn recovery(&self) -> super::runtime_send_recovery::RecoveryRequest {
        serde_json::from_value(serde_json::json!({"hubUrl":self.broker.hub_url, "channelId":"channel", "messageId":"message"})).unwrap()
    }
}

async fn answer_send_broker_auth(auth: &tokio::net::TcpListener, body: &str) {
    let (mut stream, _) = auth.accept().await.unwrap();
    let request = super::read_daemon_local_http_request(&mut stream)
        .await
        .unwrap();
    assert_eq!(
        request.headers["x-xmatrix-auth-capability"],
        "run-auth-capability"
    );
    super::write_daemon_auth_broker_response(&mut stream, "200 OK", body).await;
}

impl Drop for SendBrokerFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn send_recovery_checks_receipts_before_replaying_saved_content() {
    use super::runtime_send_journal::SendLease;
    for scenario in [
        "execution_committed",
        "execution_not_found",
        "execution_wrong_key",
        "auto_committed",
        "auto_not_found",
        "auto_http_denied",
        "auto_retry_failed",
        "committed",
        "not_found",
        "missing_fingerprint",
        "wrong_fingerprint",
        "unavailable",
        "denied",
        "wrong_scope",
        "stopped",
        "concurrent",
        "expired",
        "confirmed_local",
        "wrong_instance",
        "revoked_after_lookup",
    ] {
        let (fixture, hub, auth) = SendBrokerFixture::listeners().await;
        let auth_task = tokio::spawn(async move {
            loop {
                answer_send_broker_auth(&auth, r#"{"token":"RUN_TOKEN"}"#).await;
            }
        });
        xmatrix_cli_core::config::scope_profile_context(fixture.profile.clone(), async {
            let authorization = super::runtime_send_authorization::authorize_send(&fixture.broker, &fixture.request, "channel", "message").await.unwrap();
            let scope = authorization.scope;
            let mut saved = fixture.payload().body.unwrap();
            saved.as_object_mut().unwrap().remove("senderExecutionKey");
            if scenario.starts_with("execution_") { saved["finalReplyExecutionId"] = serde_json::json!("11111111-1111-4111-8111-111111111111"); }
            let created = xmatrix_cli_core::config::unix_now_secs() - if scenario == "expired" { 86401 } else { 0 };
            let lease = SendLease::prepare(&fixture.journal_root(), scope.clone(), saved.clone(), created).unwrap();
            let expected = lease.submission_fingerprint().unwrap();
            let mut held = Some(lease);
            if scenario == "confirmed_local" { held.take().unwrap().confirm().unwrap(); }
            else if scenario != "concurrent" { drop(held.take()); }
            if scenario == "stopped" {
                fixture.broker.run_registry.lock().await.get_mut("run").unwrap().stop_in_progress = true;
            }
            let (done, mut finished) = tokio::sync::oneshot::channel::<()>();
            let server_broker = fixture.broker.clone();
            let server = tokio::spawn(async move {
                let mut requests = Vec::new();
                loop {
                    let (mut stream, _) = tokio::select! {
                        accepted = hub.accept() => accepted.unwrap(),
                        _ = &mut finished => break,
                    };
                    let request = super::read_daemon_local_http_request(&mut stream).await.unwrap();
                    assert_eq!(request.headers["authorization"], "Bearer RUN_TOKEN");
                    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
                    let automatic = scenario.starts_with("auto_");
                    if automatic && requests.is_empty() {
                        assert_eq!(request.path, "/api/channels/channel/messages");
                        let mut expected_body = saved.clone();
                        expected_body["senderExecutionKey"] = serde_json::json!("EXECUTION_SECRET");
                        assert_eq!(body, expected_body);
                        if scenario == "auto_http_denied" {
                            super::write_daemon_auth_broker_response(&mut stream, "403 Forbidden", r#"{"error":"denied"}"#).await;
                        }
                        requests.push(request.path);
                        continue; // transport failure, or explicit nonretryable denial
                    }
                    if requests.len() == usize::from(automatic) {
                        assert_eq!(request.path, "/api/channels/channel/messages/receipt");
                        assert_eq!(body, serde_json::json!({"messageId":"message"}));
                        let status = if matches!(scenario, "not_found" | "execution_not_found" | "auto_not_found" | "auto_http_denied" | "auto_retry_failed" | "expired" | "confirmed_local" | "revoked_after_lookup") { "not_found" } else if scenario == "unavailable" { "receipt_unavailable" } else { "committed" };
                        let mut response = serde_json::json!({"schemaVersion":1, "channelId":"channel", "messageId":"message",
                            "status":status, "sequence":7, "agentSendFingerprint":expected,
                            "sender":{"kind":"agent","id":"agent","instanceId":"instance"}});
                        if scenario == "missing_fingerprint" { response.as_object_mut().unwrap().remove("agentSendFingerprint"); }
                        if scenario == "wrong_fingerprint" { response["agentSendFingerprint"] = serde_json::json!("0".repeat(64)); }
                        if scenario == "wrong_scope" { response["channelId"] = serde_json::json!("foreign"); }
                        if scenario == "wrong_instance" { response["sender"]["instanceId"] = serde_json::json!("foreign"); }
                        if scenario == "revoked_after_lookup" {
                            server_broker.run_registry.lock().await.get_mut("run").unwrap().stop_in_progress = true;
                        }
                        super::write_daemon_auth_broker_response(&mut stream,
                            if scenario == "denied" { "403 Forbidden" } else { "200 OK" }, &response.to_string()).await;
                    } else {
                        assert!(matches!(scenario, "not_found" | "execution_not_found" | "auto_not_found" | "auto_retry_failed"), "committed/unknown/denied receipts must never append");
                        assert_eq!(requests.len(), 1 + usize::from(automatic), "at most one retry per recovery request");
                        assert_eq!(request.path, "/api/channels/channel/messages");
                        let mut expected_body = saved.clone();
                        expected_body["senderExecutionKey"] = serde_json::json!("EXECUTION_SECRET");
                        assert_eq!(body, expected_body);
                        if scenario != "auto_retry_failed" {
                        super::write_daemon_auth_broker_response(&mut stream, "200 OK",
                            r#"{"message":{"messageId":"message","channelId":"channel"}}"#).await;
                        }
                    }
                    requests.push(request.path);
                }
                requests
            });
            let result = if scenario.starts_with("execution_") {
                super::runtime_reply_recovery::recover(&fixture.broker, "run", "instance", if scenario == "execution_wrong_key" { "wrong" } else { "EXECUTION_SECRET" }, "channel",
                    "11111111-1111-4111-8111-111111111111", None).await
            } else if scenario.starts_with("auto_") {
                super::runtime_daemon_message_send::execute(&fixture.broker, &fixture.request, fixture.payload()).await
            } else {
                super::runtime_send_recovery::recover(&fixture.broker, &fixture.request, fixture.recovery()).await
            };
            if scenario == "execution_wrong_key" { assert!(result.is_err());
            } else if scenario.starts_with("execution_") {
                assert_eq!(result.unwrap()["status"], "committed");
            } else if matches!(scenario, "auto_committed" | "auto_not_found") {
                let result = result.unwrap();
                assert_eq!(result["message"]["messageId"], "message");
                assert_eq!(result["sendOperation"]["recoveredFromReceipt"], scenario == "auto_committed");
            } else if matches!(scenario, "committed" | "not_found") {
                let result = result.unwrap();
                assert_eq!(result["status"], "committed");
                assert_eq!(result["retried"], scenario == "not_found");
            } else if scenario == "auto_http_denied" {
                // A 403 with no commit behind it was rejected, not lost: no
                // recovery hint and no record left waiting for --recover.
                let error = result.unwrap_err().to_string();
                assert!(error.contains("was not sent: denied"), "{error}");
                assert!(!error.contains("--recover"), "{error}");
                assert!(!std::fs::read_dir(fixture.journal_root()).unwrap()
                    .any(|entry| entry.unwrap().path().extension().is_some_and(|ext| ext == "json")));
            } else { assert!(result.is_err(), "{scenario}"); }
            let _ = done.send(());
            let requests = server.await.unwrap();
            assert_eq!(requests.len(), match scenario { "stopped" | "concurrent" | "execution_wrong_key" => 0, "not_found" | "execution_not_found" | "auto_committed" | "auto_http_denied" => 2, "auto_not_found" | "auto_retry_failed" => 3, _ => 1 }, "{scenario}");
            drop(held);
        }).await;
        auth_task.abort();
        let _ = auth_task.await;
    }
}

#[tokio::test]
async fn journaled_send_keeps_lost_responses_and_uses_only_registered_run_auth() {
    let (fixture, hub, auth) = SendBrokerFixture::listeners().await;
    let broker = &fixture.broker;
    let request = &fixture.request;
    let journal_root = fixture.journal_root();
    let payload = || fixture.payload();
    let auth_task = tokio::spawn(async move {
        for _ in 0..3 {
            answer_send_broker_auth(&auth, r#"{"token":"REGISTERED_RUN_TOKEN"}"#).await;
        }
    });
    let network_journal = journal_root.clone();
    let hub_task = tokio::spawn(async move {
        for attempt in 0..3 {
            let (mut stream, _) = hub.accept().await.unwrap();
            let request = super::read_daemon_local_http_request(&mut stream)
                .await
                .unwrap();
            assert_eq!(
                request.headers["authorization"],
                "Bearer REGISTERED_RUN_TOKEN"
            );
            let payload: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
            if attempt == 1 {
                assert_eq!(request.path, "/api/channels/channel/messages/receipt");
                super::write_daemon_auth_broker_response(&mut stream, "200 OK",
                    r#"{"schemaVersion":1,"channelId":"channel","messageId":"message","status":"receipt_unavailable"}"#).await;
                continue;
            }
            assert_eq!(payload["senderExecutionKey"], "EXECUTION_SECRET");
            let record_path = std::fs::read_dir(&network_journal)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| path.extension().is_some_and(|ext| ext == "json"))
                .unwrap();
            let stored = std::fs::read_to_string(&record_path).unwrap();
            assert!(
                stored.contains("PRIVATE_REPLY"),
                "intent must exist before the Hub receives a send"
            );
            assert!(!stored.contains("EXECUTION_SECRET"));
            assert!(!stored.contains("TOKEN"));
            if attempt == 2 {
                // Simulate loss of the local receipt destination after the Hub
                // commits. This must not turn publication into a send failure.
                std::fs::remove_file(&record_path).unwrap();
                std::fs::create_dir(&record_path).unwrap();
                super::write_daemon_auth_broker_response(
                    &mut stream,
                    "200 OK",
                    r#"{"message":{"messageId":"message","channelId":"channel"}}"#,
                )
                .await;
            }
            // First attempt drops its response, leaving publication unknown.
        }
    });
    xmatrix_cli_core::config::scope_profile_context(fixture.profile.clone(), async {
        let mut invalid = payload();
        invalid.body.as_mut().unwrap()["senderRunId"] = serde_json::json!("different-run");
        assert!(
            super::runtime_daemon_message_send::execute(broker, request, invalid)
                .await
                .is_err()
        );
        assert!(
            !journal_root.exists(),
            "foreign identity must fail before storage or network"
        );
        assert!(
            super::runtime_daemon_message_send::execute(broker, request, payload())
                .await
                .is_err()
        );
        let response = super::runtime_daemon_message_send::execute(broker, request, payload())
            .await
            .unwrap();
        assert_eq!(response["sendOperation"]["committed"], true);
        assert_eq!(response["sendOperation"]["receiptSaved"], false);
    })
    .await;
    auth_task.await.unwrap();
    hub_task.await.unwrap();
}
