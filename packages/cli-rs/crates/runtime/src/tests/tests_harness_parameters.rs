fn harness_parameter_fixture_path() -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/mock-harness-parameters.mjs")
        .to_string_lossy()
        .into_owned()
}

#[tokio::test]
async fn codex_native_parameters_are_observed_immediately_and_unconfirmed_values_block_work() {
    for mode in [
        "codex-native",
        "codex-native-before-response",
        "codex-native-no-change",
        "codex-native-mismatch",
        "codex-native-no-confirmation",
    ] {
        tokio::time::timeout(Duration::from_secs(15), async {
            let mut app = CodexAppSession::spawn_stdio_with_prefix_args(
                "node",
                &[harness_parameter_fixture_path(), mode.into()],
                Some(env!("CARGO_MANIFEST_DIR")),
                None,
            )
            .await
            .unwrap();
            let schema = serde_json::json!({"properties": {
                "serviceTier":{"type":["string","null"]},
                "futureSpeed":{"enum":["turbo","steady"]}, "futureQuiet":{"type":"boolean"},
                "futureCount":{"type":"integer","enum":[1,2]}
            }});
            app.install_parameter_schemas(crate::harness_parameters::CodexParameterSchemas {
                turn: schema.clone(),
                settings: schema,
                settings_update: true,
            });
            app.initialize(Some(env!("CARGO_MANIFEST_DIR")), None, false)
                .await
                .unwrap();
            let models = app.list_models().await.unwrap();
            let parameters = app.parameters(&models, Some("model"), None);
            assert_eq!(
                parameters
                    .iter()
                    .find(|p| p.id == "fast")
                    .unwrap()
                    .current_value
                    .as_deref(),
                Some("off")
            );
            if mode == "codex-native-no-change" {
                let notice = app
                    .apply_parameter(&parameters, Some("model"), "futureSpeed", "steady")
                    .await
                    .unwrap();
                assert!(notice.contains("provider has not reported"));
                assert!(!app.settings_uncertain);
                assert!(
                    app.parameters(&models, Some("model"), None)
                        .iter()
                        .find(|p| p.id == "futureSpeed")
                        .unwrap()
                        .current_value
                        .is_none()
                );
            }
            let selected = app
                .apply_parameter(&parameters, Some("model"), "fast", "on")
                .await;
            if mode.contains("mismatch") || mode.contains("no-confirmation") {
                assert!(selected.is_err(), "{mode}");
                assert!(app.settings_uncertain);
                assert!(
                    app.parameters(&models, Some("model"), None)
                        .iter()
                        .all(|p| p.current_value.is_none() || p.id == "model")
                );
                assert!(
                    app.submit_turn(CodexTurnRequest {
                        model: Some("model"),
                        ..CodexTurnRequest::new("must not execute", &test_serialized_agent("codex"))
                    })
                    .await
                    .is_err()
                );
            } else {
                assert_eq!(selected.unwrap(), "fast: on");
                let parameters = app.parameters(&models, Some("model"), None);
                let fast = parameters.iter().find(|p| p.id == "fast").unwrap();
                assert_eq!(fast.kind, Some(protocol::HarnessParameterKind::Boolean));
                assert_eq!(fast.alias_of.as_deref(), Some("serviceTier"));
                assert_eq!(
                    parameters
                        .iter()
                        .find(|p| p.id == "serviceTier")
                        .unwrap()
                        .choices
                        .as_ref()
                        .unwrap()[0]
                        .label
                        .as_deref(),
                    Some("Fast")
                );
                assert_eq!(fast.current_value.as_deref(), Some("on"));
                assert!(
                    !app.parameter_status(fast, Some("model"))
                        .contains("pending")
                );
                assert_eq!(
                    app.apply_parameter(&parameters, Some("model"), "fast", "on")
                        .await
                        .unwrap(),
                    "fast: on"
                );
                app.apply_parameter(&parameters, Some("model"), "futureQuiet", "true")
                    .await
                    .unwrap();
                assert_eq!(
                    app.observed_parameters["futureQuiet"],
                    serde_json::json!(true)
                );
                app.apply_parameter(&parameters, Some("model"), "futureCount", "2")
                    .await
                    .unwrap();
                assert_eq!(app.observed_parameters["futureCount"], serde_json::json!(2));
                app.apply_parameter(&parameters, Some("model"), "futureSpeed", "turbo")
                    .await
                    .unwrap();
                let parameters = app.parameters(&models, Some("model"), None);
                assert_eq!(
                    parameters
                        .iter()
                        .find(|p| p.id == "futureSpeed")
                        .unwrap()
                        .current_value
                        .as_deref(),
                    Some("turbo")
                );
                app.clear_model_parameters();
                assert!(app.reset_service_tier);
                assert!(
                    app.parameters(&models, Some("model"), None)
                        .iter()
                        .find(|p| p.id == "fast")
                        .unwrap()
                        .current_value
                        .is_none()
                );
                assert_eq!(
                    app.apply_parameter(&parameters, Some("model"), "fast", "on")
                        .await
                        .unwrap(),
                    "fast: on"
                );
                assert!(!app.reset_service_tier);
                assert_eq!(
                    app.apply_parameter(&parameters, Some("model"), "fast", "off")
                        .await
                        .unwrap(),
                    "fast: off"
                );
                assert_eq!(
                    app.observed_parameters["serviceTier"],
                    serde_json::json!("default")
                );
                assert!(
                    app.parameters(&models, Some("model"), None)
                        .iter()
                        .find(|p| p.id == "serviceTier")
                        .unwrap()
                        .current_value
                        .is_none()
                );
                assert_eq!(
                    app.parameters(&models, Some("model"), None)
                        .iter()
                        .find(|p| p.id == "fast")
                        .unwrap()
                        .current_value
                        .as_deref(),
                    Some("off")
                );
            }
            app.shutdown().await;
        })
        .await
        .expect("native settings control must remain bounded");
    }
}

#[tokio::test]
async fn acp_future_parameter_uses_native_control_and_requires_authoritative_confirmation() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut session = AcpSession::spawn_stdio_with_prefix_args(
            "node",
            &[harness_parameter_fixture_path(), "acp".into()],
            &[],
            Some(env!("CARGO_MANIFEST_DIR")),
            AcpVendorConfig::generic("kimi"),
        )
        .await
        .unwrap();
        session
            .initialize(Some(env!("CARGO_MANIFEST_DIR")), None, false, None)
            .await
            .unwrap();
        let catalog = session.presentation.parameters.as_ref().unwrap();
        let speed = catalog.iter().find(|p| p.id == "future-speed").unwrap();
        assert_eq!(
            speed.choices.as_ref().unwrap()[0].label.as_deref(),
            Some("Turbo speed")
        );
        let quiet = catalog.iter().find(|p| p.id == "quiet").unwrap();
        assert_eq!(quiet.kind, Some(protocol::HarnessParameterKind::Boolean));
        assert_eq!(quiet.category.as_deref(), Some("model_config"));
        assert_eq!(quiet.description.as_deref(), Some("Reduce chatter"));
        assert_eq!(
            catalog
                .iter()
                .find(|p| p.id == "stringSwitch")
                .unwrap()
                .kind,
            Some(protocol::HarnessParameterKind::Enum)
        );
        assert_eq!(session.set_parameter("quiet", "ON").await.unwrap(), "true");
        assert_eq!(
            session.set_parameter("quiet", "off").await.unwrap(),
            "false"
        );
        assert!(session.set_parameter("stringSwitch", "true").await.is_err());
        assert_eq!(
            session
                .set_parameter("future-speed", "turbo")
                .await
                .unwrap(),
            "turbo"
        );
        assert!(
            session
                .set_parameter("future-speed", "missing")
                .await
                .is_err()
        );
        assert!(session.set_parameter("sandbox", "off").await.is_err());
        assert!(
            session
                .set_parameter("future-speed", "unconfirmed")
                .await
                .is_err()
        );
        assert!(
            session
                .set_parameter("future-speed", "remove")
                .await
                .is_err()
        );
        assert!(session.presentation.parameters.as_ref().unwrap().is_empty());
        assert!(
            session
                .set_parameter("future-speed", "turbo")
                .await
                .is_err()
        );
        session
            .initialize(Some(env!("CARGO_MANIFEST_DIR")), None, false, None)
            .await
            .unwrap();
        assert!(
            session
                .set_parameter("future-speed", "no-snapshot")
                .await
                .is_err()
        );
        assert!(session.presentation.parameters.as_ref().unwrap().is_empty());
        session.shutdown().await;
    })
    .await
    .expect("native parameter fixture must not hang");
}

#[tokio::test]
async fn codex_future_tiers_and_schema_choices_reach_turn_fields_and_withdraw_on_refresh() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut app = CodexAppSession::spawn_stdio_with_prefix_args(
            "node",
            &[harness_parameter_fixture_path(), "codex".into()],
            Some(env!("CARGO_MANIFEST_DIR")),
            None,
        )
        .await
        .unwrap();
        app.initialize(Some(env!("CARGO_MANIFEST_DIR")), None, false)
            .await
            .unwrap();
        app.native_parameter_schema = serde_json::json!({ "properties": {
            "futureSpeed": { "enum": ["turbo", "steady"] }, "futureQuiet": { "type": "boolean" }
        }});
        app.schema_parameters = crate::harness_parameters::schema_parameters(&app.native_parameter_schema);
        let models = app.list_models().await.unwrap();
        let parameters = app.parameters(&models, Some("model"), None);
        app.select_parameter(&parameters, Some("model"), "fast", "on")
            .unwrap();
        app.select_parameter(&parameters, Some("model"), "futureSpeed", "turbo")
            .unwrap();
        app.select_parameter(&parameters, Some("model"), "futureQuiet", "true").unwrap();
        assert!(
            app.select_parameter(&parameters, Some("model"), "approvalPolicy", "never")
                .is_err()
        );
        let agent = test_serialized_agent("codex");
        let turn = app
            .submit_turn(CodexTurnRequest {
                model: Some("model"),
                ..CodexTurnRequest::new("work", &agent)
            })
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&turn.local_output).unwrap(),
            serde_json::json!({ "serviceTier": "future-priority", "futureSpeed": "turbo", "futureQuiet": true })
        );
        app.clear_model_parameters();
        assert!(app.reset_service_tier);
        let reset = app.submit_turn(CodexTurnRequest {
            model: Some("model"),
            ..CodexTurnRequest::new("work after model switch", &agent)
        }).await.unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&reset.local_output).unwrap(),
            serde_json::json!({ "serviceTier": null, "futureSpeed": "turbo", "futureQuiet": true }));
        assert!(!app.reset_service_tier);
        app.select_parameter(&parameters, Some("model"), "fast", "off")
            .unwrap();
        assert!(app.selected_parameters["serviceTier"].is_null());
        app.select_parameter(&parameters, Some("model"), "fast", "on").unwrap();
        let refreshed = app.list_models().await.unwrap();
        let parameters = app.parameters(&refreshed, Some("model"), None);
        assert!(
            !parameters
                .iter()
                .any(|p| p.id == "fast" || p.id == "serviceTier")
        );
        assert!(
            app.select_parameter(&parameters, Some("model"), "fast", "on")
                .is_err()
        );
        assert!(
            app.submit_turn(CodexTurnRequest {
                model: Some("model"),
                ..CodexTurnRequest::new("must not reach native turn", &agent)
            })
            .await
            .is_err()
        );
        app.shutdown().await;
    })
    .await
    .expect("native parameter fixture must not hang");
}

#[test]
fn claude_parameters_require_native_observation_and_survive_process_recovery() {
    // Model/effort controls write the ambient Run status. Serialize the entire
    // session against tests that temporarily point it at their own status file.
    let _guard = test_process_env_lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(claude_parameters_with_process_recovery());
}

async fn claude_parameters_with_process_recovery() {
    for mode in ["enabled", "blocked", "cooldown"] {
        let blocked = mode == "blocked";
        tokio::time::timeout(Duration::from_secs(15), async {
            let agent = test_serialized_agent("claude");
            let relay = Arc::new(AgentInstanceConnectionClient::new(
                "ws://127.0.0.1:9/ws".into(),
                "token".into(),
                agent.name.clone(),
                "claude_code".into(),
                None,
            ));
            let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/mock-claude-parameters.mjs");
            let mut args = vec![script.to_string_lossy().into_owned()];
            if mode != "enabled" {
                args.push(mode.into());
            }
            let mut session = ClaudeStreamSession::new(
                "node",
                &args,
                Some(env!("CARGO_MANIFEST_DIR")),
                None,
                false,
                relay,
                agent,
                None,
            );
            session.discover_parameters().await.unwrap();
            session.select_effort("future-effort").await.unwrap();
            assert!(
                session
                    .presentation()
                    .parameters
                    .iter()
                    .any(|p| p.id == "outputStyle" && p.options.contains(&"future-style".into()))
            );
            assert!(session.select_parameter("autoApprove", "on").await.is_err());
            assert!(
                session
                    .select_parameter("outputStyle", "invented")
                    .await
                    .is_err()
            );
            let fast = session.select_parameter("fast", "on").await;
            if blocked {
                assert!(fast.unwrap_err().contains("extra_usage_disabled"));
                let style_error = session
                    .select_parameter("outputStyle", "remove")
                    .await
                    .unwrap_err();
                assert!(
                    style_error.contains("outputStyle")
                        && !style_error.contains("extra_usage_disabled")
                );
            } else {
                let applied = fast.unwrap();
                if mode == "cooldown" {
                    assert!(applied.contains("cooldown"));
                }
                session
                    .select_parameter("outputStyle", "future-style")
                    .await
                    .unwrap();
                session.shutdown().await;
                session.discover_parameters().await.unwrap();
                let observed = session.presentation().parameters;
                assert!(
                    observed
                        .iter()
                        .any(|p| p.id == "fast" && p.current_value.as_deref() == Some("on"))
                );
                assert!(
                    observed.iter().any(|p| p.id == "outputStyle"
                        && p.current_value.as_deref() == Some("future-style"))
                );
                session.switch_model("slow-model").await.unwrap();
                session.switch_model("native-model").await.unwrap();
                assert!(
                    session
                        .presentation()
                        .parameters
                        .iter()
                        .any(|p| p.id == "fast" && p.current_value.as_deref() == Some("off"))
                );
                assert!(
                    session
                        .select_parameter("outputStyle", "remove")
                        .await
                        .is_err()
                );
            }
            session.shutdown().await;
        })
        .await
        .expect("Claude parameter control must remain bounded");
    }
}
