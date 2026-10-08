#[test]
fn acp_initialize_advertises_cursor_parameterized_model_picker() {
    let params = acp_initialize_params();
    assert_eq!(
        params["clientCapabilities"]["session"]["configOptions"]["boolean"],
        serde_json::json!({})
    );
    assert_eq!(params["protocolVersion"], 1);
    assert_eq!(
        params["clientCapabilities"]["_meta"]["parameterizedModelPicker"],
        true
    );
    assert_eq!(params["clientInfo"]["name"], "xmatrix");
}

#[test]
fn cursor_adapter_shows_readable_model_and_hides_default_agent_mode() {
    let adapter = agent_presentation_adapter_for_acp_runtime("cursor");
    let mut facts = AgentPresentationFacts::default();
    adapter.observe_acp(
        &serde_json::json!({
            "sessionId": "cursor-session",
            "configOptions": [
                {
                    "id": "model",
                    "name": "Model",
                    "type": "select",
                    "currentValue": "default[]",
                    "options": [
                        { "value": "default[]", "name": "Auto" },
                        { "value": "composer-2.5", "name": "Composer 2.5" }
                    ]
                },
                {
                    "id": "mode",
                    "name": "Mode",
                    "type": "select",
                    "currentValue": "agent",
                    "options": [
                        { "value": "agent", "name": "Agent" },
                        { "value": "ask", "name": "Ask" },
                        { "value": "plan", "name": "Plan" }
                    ]
                }
            ]
        }),
        &mut facts,
    );
    let presentation = adapter.present(&facts, &[]);
    assert!(
        presentation.model.is_none(),
        "placeholder default[] must not leak as model id"
    );
    let chips = presentation.status_chips.as_ref().expect("Cursor chips");
    assert!(
        runtime_chip_matches(chips, "model", "Auto"),
        "placeholder model chip should show the option display name"
    );
    assert!(
        !chips.iter().any(|chip| chip.id == "mode"),
        "default Agent mode must not produce a status chip"
    );
}

#[test]
fn cursor_adapter_uses_parameterized_model_display_names_and_shows_plan_mode() {
    let adapter = agent_presentation_adapter_for_acp_runtime("cursor");
    let mut facts = AgentPresentationFacts::default();
    adapter.observe_acp(
        &serde_json::json!({
            "configOptions": [
                {
                    "id": "model",
                    "name": "Model",
                    "currentValue": "default",
                    "options": [
                        { "value": "default", "name": "Auto" },
                        { "value": "composer-2.5", "name": "Composer 2.5" }
                    ]
                },
                {
                    "id": "mode",
                    "name": "Mode",
                    "currentValue": "plan",
                    "options": [
                        { "value": "agent", "name": "Agent" },
                        { "value": "plan", "name": "Plan" }
                    ]
                }
            ]
        }),
        &mut facts,
    );
    let presentation = adapter.present(&facts, &[]);
    assert_eq!(presentation.model.as_deref(), Some("default"));
    let chips = presentation.status_chips.as_ref().expect("Cursor chips");
    assert!(runtime_chip_matches(chips, "model", "Auto"));
    assert!(runtime_chip_matches(chips, "mode", "Plan"));
}

#[test]
fn macos_launchd_daemon_waits_for_lock_without_extra_env() {
    assert!(daemon_restart_waits_for_lock_from_env(
        None,
        Some("sh.xmatrix.daemon"),
        true
    ));
    assert!(!daemon_restart_waits_for_lock_from_env(
        None,
        Some("sh.xmatrix.daemon"),
        false
    ));
    assert!(!daemon_restart_waits_for_lock_from_env(
        None,
        Some("other.service"),
        true
    ));
}

#[test]
fn claude_runtime_detection_sees_wrapped_launchers() {
    assert!(is_claude_launcher_token("claude"));
    assert!(is_claude_launcher_token("C:\\tools\\claude-code.cmd"));
    assert!(uses_claude_code_runtime(
        "ccconfig",
        "ccconfig",
        &["claude".to_string()]
    ));
    assert!(!uses_claude_code_runtime("bash", "bash", &[]));
}

#[test]
fn zcode_runtime_detection_handles_launchers() {
    assert!(is_zcode_tool("zcode"));
    assert!(is_zcode_tool("ZCODE.EXE"));
    assert!(is_zcode_tool("/usr/local/bin/zcode"));
    assert!(is_zcode_tool(
        "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"
    ));
    assert!(!is_zcode_tool("node"));
}

#[test]
fn codex_app_spawn_args_default_to_websocket_listen() {
    let _process_env = test_process_env_lock();
    let ws = codex_app_spawn_args(CodexTransportKind::WebSocket, Some("ws://127.0.0.1:9876"));
    // The request_user_input feature is a global override, before the subcommand.
    let subcommand = ws.iter().position(|arg| arg == "app-server").expect("subcommand");
    assert!(
        ws[..subcommand]
            .windows(2)
            .any(|pair| pair == ["-c", "features.default_mode_request_user_input=true"])
    );
    assert!(
        ws.windows(2)
            .any(|pair| { pair[0] == "--listen" && pair[1] == "ws://127.0.0.1:9876" })
    );

    let stdio = codex_app_spawn_args(CodexTransportKind::Stdio, None);
    assert!(
        stdio
            .windows(2)
            .any(|pair| { pair[0] == "--listen" && pair[1] == "stdio://" })
    );
}

#[test]
fn grok_runtime_detection_and_spawn_args() {
    assert!(is_grok_tool("grok"));
    assert!(is_grok_tool("GROK.EXE"));
    assert!(is_grok_tool("/Users/dev/.local/bin/grok"));
    assert!(!is_grok_tool("node"));

    // Default transport is WebSocket serve.
    let ws_args = grok_acp_spawn_args(
        &[],
        AcpTransportKind::WebSocket,
        Some("127.0.0.1:2419"),
        Some("test-secret"),
    );
    assert_eq!(ws_args.first().map(String::as_str), Some("agent"));
    assert!(ws_args.iter().any(|arg| arg == "serve"));
    // serve owns bind/secret: ... serve --bind ... --secret ...
    let serve_idx = ws_args.iter().position(|arg| arg == "serve").unwrap();
    assert!(
        ws_args[serve_idx..]
            .windows(2)
            .any(|pair| { pair[0] == "--bind" && pair[1] == "127.0.0.1:2419" })
    );
    assert!(
        ws_args[serve_idx..]
            .windows(2)
            .any(|pair| { pair[0] == "--secret" && pair[1] == "test-secret" })
    );
    assert!(ws_args.iter().any(|arg| arg == "--always-approve"));

    let stdio_args = grok_acp_spawn_args(&[], AcpTransportKind::Stdio, None, None);
    assert!(stdio_args.iter().any(|arg| arg == "stdio"));
    assert!(!stdio_args.iter().any(|arg| arg == "serve"));

    let custom = grok_acp_spawn_args(
        &["agent".to_string(), "stdio".to_string()],
        AcpTransportKind::Stdio,
        None,
        None,
    );
    assert!(custom.iter().any(|arg| arg == "--always-approve"));
    assert!(custom.iter().any(|arg| arg == "stdio"));

    assert_eq!(
        grok_ws_url_from_banner_line("   WebSocket URL: ws://127.0.0.1:12421/ws?server-key=abc")
            .as_deref(),
        Some("ws://127.0.0.1:12421/ws?server-key=abc")
    );
    assert_eq!(
        grok_ws_url_from_banner_line(
            "   WebSocket URL: ws://127.0.0.1:64997/ws?server-key=testdebug"
        )
        .as_deref(),
        Some("ws://127.0.0.1:64997/ws?server-key=testdebug")
    );

    assert!(acp_message_id_matches(Some(&serde_json::json!(3)), 3));
    assert!(acp_message_id_matches(Some(&serde_json::json!("3")), 3));
    assert!(!acp_message_id_matches(Some(&serde_json::json!(4)), 3));

    let catalog = acp_model_catalog_from_value(&serde_json::json!({
        "currentModelId": "grok-4.5",
        "availableModels": [
            {
                "modelId": "grok-4.5",
                "name": "Grok 4.5",
                "description": "frontier"
            }
        ]
    }));
    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0].id, "grok-4.5");
    assert_eq!(catalog[0].display_name.as_deref(), Some("Grok 4.5"));
}

#[test]
fn grok_trusted_rules_use_native_session_metadata_not_user_input() {
    let _process_env = test_process_env_lock();
    let rules = grok_acp_trusted_rules(Some("  trusted launch identity  ")).expect("trusted rules");
    assert_eq!(rules, "trusted launch identity");
    assert!(grok_acp_trusted_rules(Some("   ")).is_none());
    let params = acp_session_new_params("/workspace", Some(&rules));
    assert_eq!(params["cwd"], "/workspace");
    assert_eq!(params["mcpServers"], serde_json::json!([]));
    let native_rules = params["_meta"]["rules"].as_str().expect("native ACP rules");
    assert!(native_rules.contains("trusted launch identity"));
    assert!(params.get("prompt").is_none());
    assert!(params.get("message").is_none());

    let base = acp_session_new_params("/workspace", None);
    assert!(base.get("_meta").is_none());
}

#[test]
fn runtime_without_a_trusted_instruction_channel_rejects_agent_instructions() {
    let error = ensure_runtime_supports_trusted_role("ZCode app-server", false, true)
        .expect_err("trusted Agent instructions must fail closed");
    let detail = error.to_string();
    assert!(detail.contains("trusted system/developer instruction channel"));
    assert!(detail.contains("ordinary user content"));
    assert!(ensure_runtime_supports_trusted_role("ZCode app-server", false, false).is_ok());
    assert!(ensure_runtime_supports_trusted_role("Codex", true, true).is_ok());
}

#[test]
fn grok_interrupt_uses_acp_session_cancel_notification() {
    let message = acp_cancel_notification("session-1");
    assert_eq!(message["jsonrpc"], "2.0");
    assert_eq!(message["method"], "session/cancel");
    assert_eq!(message["params"]["sessionId"], "session-1");
    assert!(message.get("id").is_none());
}

#[test]
fn acp_backend_env_detection_covers_generic_and_suffixed_backends() {
    assert!(acp_backend_matches("acp"));
    assert!(acp_backend_matches(" acp "));
    assert!(acp_backend_matches("kimi-acp"));
    assert!(acp_backend_matches("vendor-acp"));
    // The dedicated Grok adapter has its own dispatch branch.
    assert!(!acp_backend_matches("grok-acp"));
    assert!(!acp_backend_matches("pty"));
    assert!(!acp_backend_matches("codex-app"));
    assert!(!acp_backend_matches(""));
}

#[test]
fn acp_permission_selection_prefers_allow_always_kind_for_kimi_options() {
    // Kimi Code 0.30.0 wire shape: kind-tagged options.
    let options = serde_json::json!([
        { "optionId": "approve_once", "name": "Approve once", "kind": "allow_once" },
        { "optionId": "approve_always", "name": "Approve for this session", "kind": "allow_always" },
        { "optionId": "reject", "name": "Reject", "kind": "reject_once" },
    ]);
    assert_eq!(
        acp_select_permission_option_id(options.as_array().unwrap()).as_deref(),
        Some("approve_always")
    );
}

#[test]
fn acp_permission_selection_matches_grok_wording_without_kind() {
    // Grok options carry no `kind`; the optionId heuristic must keep
    // selecting the historical allow-always behavior.
    let options = serde_json::json!([
        { "optionId": "allow-once" },
        { "optionId": "allow-always" },
        { "optionId": "deny" },
    ]);
    assert_eq!(
        acp_select_permission_option_id(options.as_array().unwrap()).as_deref(),
        Some("allow-always")
    );
    let once_only = serde_json::json!([
        { "optionId": "allow-once" },
        { "optionId": "deny" },
    ]);
    assert_eq!(
        acp_select_permission_option_id(once_only.as_array().unwrap()).as_deref(),
        Some("allow-once")
    );
    assert!(acp_select_permission_option_id(&[]).is_none());
}

#[test]
fn acp_generic_vendor_config_is_hook_free_and_tool_scoped() {
    let config = AcpVendorConfig::generic("kimi");
    assert_eq!(config.display_name, "Kimi Code");
    assert_eq!(config.trace_source, "kimi_acp");
    assert_eq!(config.resume_namespace, "acp-resume-kimi");
    assert_eq!(config.presentation_adapter.runtime(), "kimi");
    assert_eq!(config.presentation_adapter.source(), "kimi_acp");
    assert!(config.authenticate.is_none());
    assert!(!config.session_new_meta_rules);
    assert!(config.permission_fallback_option_id.is_none());
    assert!(config.goal_turn_input.is_none());
    assert!(config.goal_status_from_update.is_none());
    assert!(config.goal_status_from_text.is_none());
    assert!(config.quota_usage.is_none());
    assert_eq!(
        config.preset_acp_args.as_deref(),
        Some(&["acp".to_string()][..])
    );

    let other = AcpVendorConfig::generic("some-agent");
    assert_eq!(other.trace_source, "some-agent_acp");
    assert!(other.preset_acp_args.is_none());

    let cursor = AcpVendorConfig::generic("cursor-agent");
    assert_eq!(cursor.display_name, "Cursor");
    assert_eq!(cursor.trace_source, "cursor_acp");
    assert_eq!(cursor.resume_namespace, "acp-resume-cursor");
    assert_eq!(cursor.presentation_adapter.runtime(), "cursor");
    assert_eq!(cursor.presentation_adapter.source(), "cursor_acp");
    assert_eq!(
        agent_type_for_preset_or_runtime(None, "cursor-agent"),
        "cursor"
    );
    assert_eq!(
        agent_type_for_preset_or_runtime(None, "CURSOR-AGENT.EXE"),
        "cursor"
    );
    assert_eq!(
        agent_type_for_preset_or_runtime(None, "/Users/dev/.local/bin/cursor-agent"),
        "cursor"
    );
    assert_eq!(agent_type_for_preset_or_runtime(None, "node"), "custom");
    // The daemon-supplied preset id outranks launcher sniffing; only `custom`
    // or an unknown preset falls back to the launcher token.
    assert_eq!(
        agent_type_for_preset_or_runtime(Some("claude"), "node"),
        "claude_code"
    );
    assert_eq!(
        agent_type_for_preset_or_runtime(Some("custom"), "opencode"),
        "opencode"
    );
    assert_eq!(
        agent_type_for_preset_or_runtime(Some("no-such-preset"), "pi-acp"),
        "pi"
    );

    // OpenCode speaks ACP natively; Pi rides the ACP-registry pi-acp adapter,
    // whose launcher takes no subcommand.
    let opencode = AcpVendorConfig::generic("/opt/homebrew/bin/opencode");
    assert_eq!(opencode.display_name, "OpenCode");
    assert_eq!(opencode.trace_source, "opencode_acp");
    assert_eq!(opencode.resume_namespace, "acp-resume-opencode");
    assert_eq!(opencode.presentation_adapter.runtime(), "opencode");
    assert_eq!(
        opencode.preset_acp_args.as_deref(),
        Some(&["acp".to_string()][..])
    );
    // OpenCode Go has an account usage endpoint behind its stored API key, so
    // its generic ACP config keeps a quota hook unlike the other peers.
    assert!(opencode.quota_usage.is_some());
    assert_eq!(
        agent_type_for_preset_or_runtime(None, "opencode"),
        "opencode"
    );

    let pi = AcpVendorConfig::generic("pi-acp");
    assert_eq!(pi.display_name, "Pi");
    assert_eq!(pi.trace_source, "pi_acp");
    assert_eq!(pi.resume_namespace, "acp-resume-pi");
    assert_eq!(pi.presentation_adapter.runtime(), "pi");
    assert_eq!(pi.preset_acp_args.as_deref(), Some(&[][..]));
    assert!(pi.quota_usage.is_none());
    assert_eq!(agent_type_for_preset_or_runtime(None, "pi-acp"), "pi");

    // The ACP-native harnesses are pure registry data: each launcher resolves
    // to its preset's display name, subcommand/flag, and config tree.
    for (tool, id, display_name, acp_args, _config_dir) in [
        (
            "copilot",
            "copilot",
            "GitHub Copilot CLI",
            &["--acp"][..],
            ".copilot",
        ),
        (
            "gemini.cmd",
            "gemini",
            "Gemini CLI",
            &["--acp"][..],
            ".gemini",
        ),
        (
            "/usr/local/bin/qwen",
            "qwen",
            "Qwen Code",
            &["--acp"][..],
            ".qwen",
        ),
        ("goose", "goose", "goose", &["acp"][..], ".config/goose"),
        ("junie", "junie", "Junie", &["--acp=true"][..], ".junie"),
        ("vibe-acp", "vibe", "Mistral Vibe", &[][..], ".vibe"),
        ("kiro-cli", "kiro", "Kiro CLI", &["acp"][..], ".kiro"),
        ("hermes", "hermes", "Hermes Agent", &["acp"][..], ".hermes"),
        (
            "openclaw",
            "openclaw",
            "OpenClaw",
            &["acp"][..],
            ".openclaw",
        ),
        ("qodercli", "qoder", "Qoder CLI", &["--acp"][..], ".qoder"),
        (
            "cbc",
            "codebuddy",
            "CodeBuddy Code",
            &["--acp"][..],
            ".codebuddy",
        ),
        ("omp", "omp", "Oh My Pi", &["acp"][..], ".omp"),
        ("auggie", "auggie", "Auggie", &["--acp"][..], ".augment"),
        ("cline", "cline", "Cline", &["--acp"][..], ".cline"),
        ("kilocode", "kilo", "Kilo", &["acp"][..], ".config/kilo"),
        (
            "droid",
            "droid",
            "Factory Droid",
            &["exec", "--output-format", "acp-daemon"][..],
            ".factory",
        ),
        ("devin", "devin", "Devin", &["acp"][..], ".config/devin"),
        (
            "command-code",
            "commandcode",
            "Command Code",
            &["acp"][..],
            ".commandcode",
        ),
        ("jcode", "jcode", "jcode", &["acp"][..], ".jcode"),
        (
            "prime-agent",
            "prime",
            "Prime Agent",
            &["--mode", "acp"][..],
            ".prime",
        ),
        (
            "traecli",
            "trae",
            "TraeCode CLI",
            &["acp", "serve"][..],
            ".config/trae_cli",
        ),
        (
            "agy_acp_server.par",
            "antigravity",
            "Google Antigravity",
            &["--uid="][..],
            ".gemini",
        ),
        (
            "autohand-acp",
            "autohand",
            "Autohand Code",
            &[][..],
            ".autohand",
        ),
        ("amp-acp", "amp", "Amp", &[][..], ".config/amp"),
        (
            "reasonix",
            "reasonix",
            "Reasonix",
            &["acp"][..],
            ".reasonix",
        ),
        ("dimcode", "dimcode", "DimCode", &["acp"][..], ".dimcode"),
    ] {
        let config = AcpVendorConfig::generic(tool);
        assert_eq!(config.display_name, display_name, "{tool}");
        assert_eq!(config.trace_source, format!("{id}_acp"), "{tool}");
        assert_eq!(
            config.resume_namespace,
            format!("acp-resume-{id}"),
            "{tool}"
        );
        assert_eq!(config.presentation_adapter.runtime(), id, "{tool}");
        let expected_args: Vec<String> = acp_args.iter().map(|arg| arg.to_string()).collect();
        assert_eq!(
            config.preset_acp_args.as_deref(),
            Some(&expected_args[..]),
            "{tool}"
        );
        assert_eq!(
            generic_acp_spawn_args(&[], config.preset_acp_args.as_deref()),
            expected_args,
            "{tool}"
        );
        assert!(config.quota_usage.is_none(), "{tool}");
        assert_eq!(agent_type_for_preset_or_runtime(None, tool), id, "{tool}");
    }

    let grok = AcpVendorConfig::grok();
    assert_eq!(grok.permission_fallback_option_id, Some("allow-always"));
    assert_eq!(grok.trace_source, "grok_acp");
    assert_eq!(grok.presentation_adapter.runtime(), "grok");
    assert_eq!(grok.presentation_adapter.source(), "grok_acp");
    assert!(grok.authenticate.is_some());
    assert!(grok.session_new_meta_rules);
    assert!(grok.goal_turn_input.is_some());
    assert!(grok.quota_usage.is_some());

    let generic = agent_presentation_adapter_for_acp_runtime("some-agent");
    assert_eq!(generic.runtime(), "some-agent");
    assert_eq!(generic.source(), "some-agent_acp");
}

#[test]
fn presentation_protocol_has_an_adapter_for_every_runtime_family() {
    let expected = [
        ("codex-app", "codex", "codex_app"),
        ("claude_code", "claude", "claude_stream"),
        ("grok-acp", "grok", "grok_acp"),
        ("kimi-acp", "kimi", "kimi_acp"),
        ("zcode", "zcode", "zcode_app"),
        ("cursor", "cursor", "cursor"),
        ("aider", "aider", "aider"),
        ("windsurf", "windsurf", "windsurf"),
        ("acp", "acp", "acp_adapter"),
        ("custom-pty", "custom-pty", "custom-pty"),
    ];
    for (runtime, normalized, source) in expected {
        let adapter = agent_presentation_adapter_for_runtime(runtime);
        assert_eq!(adapter.runtime(), normalized, "{runtime}");
        assert_eq!(adapter.source(), source, "{runtime}");
        let presentation = adapter.present(&AgentPresentationFacts::default(), &[]);
        assert!(presentation.model.is_none(), "{runtime}");
        assert!(presentation.models.is_none(), "{runtime}");
        assert!(presentation.effort.is_none(), "{runtime}");
        assert!(presentation.usage.is_none(), "{runtime}");
    }
}

/// The end of the chain the user actually sees: with the Claude catalog in
/// hand the presence frame must carry both an `effort` chip and the `/effort`
/// command. Each half was separately missing — the chip because the runtime
/// reported no effort, the command because `commands_from_catalog_json` drops
/// every `agent-efforts` entry when no model declares a level.
#[test]
fn claude_presence_frame_carries_the_effort_chip_and_command() {
    let presentation = agent_presentation_adapter_for_runtime("claude").present(
        &AgentPresentationFacts {
            model: Some("claude-opus-5".to_string()),
            models: claude_model_catalog(),
            models_reported: true,
            effort: Some("auto".to_string()),
            ..AgentPresentationFacts::default()
        },
        &[],
    );
    let chips = presentation.status_chips.unwrap_or_default();
    assert!(
        chips
            .iter()
            .any(|chip| chip.id == "effort" && chip.value.as_deref() == Some("auto")),
        "{chips:?}"
    );
    let commands = presentation.commands.unwrap_or_default();
    assert!(
        commands.iter().any(|command| command.token == "/effort"),
        "{:?}",
        commands.iter().map(|c| &c.token).collect::<Vec<_>>()
    );
}

#[test]
fn presentation_declares_quota_and_context_meter_tags_from_reported_usage() {
    let adapter = agent_presentation_adapter_for_runtime("claude");
    let facts = AgentPresentationFacts {
        usage: Some(protocol::LlmUsage {
            context_used_tokens: Some(40_000),
            context_window_tokens: Some(200_000),
            quota_usages: Some(vec![
                protocol::LlmQuotaUsage {
                    label: Some("5h".to_string()),
                    percent: Some(2.0),
                    reset_at: Some("2099-01-01T00:00:00+00:00".to_string()),
                    ..Default::default()
                },
                // Already rolled over: the runtime stops declaring it.
                protocol::LlmQuotaUsage {
                    label: Some("1w".to_string()),
                    percent: Some(56.0),
                    reset_at: Some("2020-01-01T00:00:00+00:00".to_string()),
                    ..Default::default()
                },
                // No percent to show: no meter tag.
                protocol::LlmQuotaUsage {
                    label: Some("1mo".to_string()),
                    ..Default::default()
                },
            ]),
            ..Default::default()
        }),
        ..Default::default()
    };

    let chips = adapter
        .present(&facts, &[])
        .status_chips
        .expect("runtime should declare its meter tags");
    let quota = chips
        .iter()
        .find(|chip| chip.id == "quota:5h")
        .expect("live quota window should be declared");
    assert_eq!(quota.label, "5h");
    assert_eq!(quota.percent, Some(2.0));
    assert_eq!(
        quota.value, None,
        "meter tags carry numbers, not rendered text"
    );
    assert_eq!(quota.reset_at.as_deref(), Some("2099-01-01T00:00:00+00:00"));

    let context = chips
        .iter()
        .find(|chip| chip.id == "ctx")
        .expect("context fill should be declared");
    assert_eq!(context.percent, Some(20.0));

    assert!(
        chips.iter().all(|chip| chip.id != "quota:1w"),
        "expired window"
    );
    assert!(
        chips.iter().all(|chip| chip.id != "quota:1mo"),
        "no percent"
    );
}

#[test]
fn grok_adapter_normalizes_live_model_effort_commands_chips_and_usage() {
    let adapter = agent_presentation_adapter_for_acp_runtime("grok");
    let mut facts = AgentPresentationFacts::default();
    // Grok initialize: current model and catalog live under _meta.modelState.
    adapter.observe_acp(
        &serde_json::json!({
            "_meta": {
                "modelState": {
                    "currentModelId": "grok-4.5",
                    "availableModels": [{
                        "modelId": "grok-4.5",
                        "name": "Grok 4.5",
                        "_meta": {
                            "reasoningEffort": "high",
                            "reasoningEfforts": [
                                { "id": "high", "description": "Highest quality", "default": true },
                                { "id": "medium", "description": "Balanced" },
                                { "id": "low", "description": "Fast" }
                            ]
                        }
                    }]
                }
            }
        }),
        &mut facts,
    );
    // Grok later reports the same catalog through _x.ai/models/update using
    // the provider's `models` key.
    adapter.observe_acp(
        &serde_json::json!({
            "method": "_x.ai/models/update",
            "params": {
                "models": [{
                    "modelId": "grok-4.5",
                    "name": "Grok 4.5",
                    "_meta": {
                        "reasoningEffort": "high",
                        "reasoningEfforts": ["high", "medium", "low"]
                    }
                }]
            }
        }),
        &mut facts,
    );
    // Session notifications use snake_case fields on the current Grok wire.
    adapter.observe_acp(
        &serde_json::json!({
            "method": "_x.ai/session_notification",
            "params": {
                "notification": {
                    "type": "available_commands_update",
                    "available_commands": [{
                        "name": "goal",
                        "description": "Manage a goal",
                        "input": { "hint": "<objective>" }
                    }]
                }
            }
        }),
        &mut facts,
    );
    adapter.observe_acp(
        &serde_json::json!({
            "method": "_x.ai/session_notification",
            "params": {
                "notification": {
                    "type": "model_changed",
                    "model_id": "grok-4.5",
                    "reasoning_effort": "high"
                },
                "usage": { "input_tokens": 12, "output_tokens": 5, "total_tokens": 17 }
            }
        }),
        &mut facts,
    );
    let presentation = adapter.present(&facts, &[]);
    assert_eq!(presentation.model.as_deref(), Some("grok-4.5"));
    assert_eq!(presentation.effort.as_deref(), Some("high"));
    let models = presentation.models.as_ref().expect("Grok models");
    assert_eq!(models.len(), 1);
    assert_eq!(
        models[0].supported_reasoning_efforts.as_ref().map(Vec::len),
        Some(3)
    );
    let commands = presentation.commands.as_ref().expect("Grok commands");
    assert!(commands.iter().any(|command| command.token == "/goal"));
    assert!(commands.iter().any(|command| command.token == "/model"));
    let chips = presentation.status_chips.as_ref().expect("Grok chips");
    assert!(
        chips
            .iter()
            .any(|chip| chip.id == "model" && chip.source.as_deref() == Some("grok_acp"))
    );
    assert!(
        chips
            .iter()
            .any(|chip| chip.id == "effort" && chip.value.as_deref() == Some("high"))
    );
    assert_eq!(
        presentation
            .usage
            .as_ref()
            .and_then(|usage| usage.total_tokens),
        Some(17)
    );
}

#[test]
fn kimi_adapter_normalizes_config_options_without_inventing_missing_facts() {
    let adapter = agent_presentation_adapter_for_acp_runtime("kimi");
    let mut facts = AgentPresentationFacts::default();
    adapter.observe_acp(
        &serde_json::json!({
            "sessionId": "kimi-session",
            "configOptions": [
                {
                    "id": "model",
                    "name": "Model",
                    "type": "select",
                    "currentValue": "kimi-k2.5",
                    "options": [
                        { "value": "kimi-k2.5", "name": "Kimi K2.5" },
                        { "value": "kimi-k2.5-fast", "name": "Kimi K2.5 Fast" }
                    ]
                },
                {
                    "id": "thinking",
                    "name": "Thinking",
                    "type": "select",
                    "currentValue": "high",
                    "options": [
                        { "value": "off", "name": "Off" },
                        { "value": "high", "name": "High" }
                    ]
                },
                {
                    "id": "mode",
                    "name": "Mode",
                    "type": "select",
                    "currentValue": "plan",
                    "options": [{ "value": "plan", "name": "Plan" }]
                }
            ]
        }),
        &mut facts,
    );
    let presentation = adapter.present(&facts, &[]);
    assert_eq!(presentation.model.as_deref(), Some("kimi-k2.5"));
    assert_eq!(presentation.effort.as_deref(), Some("high"));
    assert_eq!(presentation.models.as_ref().map(Vec::len), Some(2));
    let commands = presentation.commands.as_ref().expect("Kimi commands");
    assert!(commands.iter().any(|command| command.token == "/model"));
    assert!(commands.iter().any(|command| command.token == "/effort"));
    let chips = presentation.status_chips.as_ref().expect("Kimi chips");
    assert!(runtime_chip_matches(chips, "mode", "Plan"));
    assert!(presentation.usage.is_none());

    // Kimi emits a complete config_option_update snapshot. Switching to a
    // non-thinking model removes the thinking option and must clear the old
    // effort label instead of carrying it into the new model.
    adapter.observe_acp(
        &serde_json::json!({
            "method": "session/update",
            "params": {
                "sessionId": "kimi-session",
                "update": {
                    "sessionUpdate": "config_option_update",
                    "configOptions": [
                        {
                            "id": "model",
                            "name": "Model",
                            "type": "select",
                            "currentValue": "kimi-plain",
                            "options": [{ "value": "kimi-plain", "name": "Kimi Plain" }]
                        },
                        {
                            "id": "mode",
                            "name": "Mode",
                            "type": "select",
                            "currentValue": "yolo",
                            "options": [{ "value": "yolo", "name": "YOLO" }]
                        }
                    ]
                }
            }
        }),
        &mut facts,
    );
    adapter.observe_acp(
        &serde_json::json!({
            "method": "session/update",
            "params": {
                "sessionId": "kimi-session",
                "update": {
                    "sessionUpdate": "usage_update",
                    "used": 8192,
                    "size": 131072,
                    "cost": { "amount": 0.0042, "currency": "USD" }
                }
            }
        }),
        &mut facts,
    );
    let updated = adapter.present(&facts, &[]);
    assert_eq!(updated.model.as_deref(), Some("kimi-plain"));
    assert!(updated.effort.is_none());
    assert!(
        updated
            .models
            .as_ref()
            .and_then(|models| models.first())
            .is_some_and(|model| model.supported_reasoning_efforts.is_none())
    );
    let updated_chips = updated.status_chips.as_ref().expect("updated Kimi chips");
    assert!(!updated_chips.iter().any(|chip| chip.id == "effort"));
    assert!(
        updated_chips
            .iter()
            .any(|chip| chip.id == "mode" && chip.value.as_deref() == Some("YOLO"))
    );
    let usage = updated.usage.as_ref().expect("Kimi ACP usage");
    assert_kimi_fixture_usage(usage);
}

#[test]
fn generic_acp_spawn_args_default_to_acp_subcommand() {
    // Explicit CLI args always win and never touch the env.
    let explicit = generic_acp_spawn_args(&["acp".to_string(), "--verbose".to_string()], None);
    assert_eq!(explicit, vec!["acp".to_string(), "--verbose".to_string()]);
    // Community convention: bare `acp` subcommand (e.g. `kimi acp`).
    assert_eq!(generic_acp_spawn_args(&[], None), vec!["acp".to_string()]);
    // The preset's acpArgs decide the subcommand: `[]` is a launcher that
    // already speaks ACP (pi-acp), so nothing is appended.
    assert_eq!(
        generic_acp_spawn_args(&[], Some(&["acp".to_string()])),
        vec!["acp".to_string()]
    );
    assert_eq!(generic_acp_spawn_args(&[], Some(&[])), Vec::<String>::new());
    assert_eq!(
        acp_args_from_json("[\"acp\", \"--verbose\"]"),
        Some(vec!["acp".to_string(), "--verbose".to_string()])
    );
    assert!(acp_args_from_json("not json").is_none());
    assert!(acp_args_from_json("[]").is_none());
    assert!(acp_args_from_json("[1, 2]").is_none());
}

#[test]
fn claude_agent_type_routes_to_programmatic_runtime() {
    let agent = SerializedAgent {
        id: "agent-1".to_string(),
        name: "claude-eevee".to_string(),
        agent_type: "claude_code".to_string(),
        email: "claude@example.com".to_string(),
        ..test_agent_record()
    };
    assert!(is_claude_code_agent(&agent));
    assert!(use_claude_print_backend_for(
        false,
        &agent,
        "xmatrix",
        "xmatrix",
        &["claude".to_string()]
    ));
}

#[test]
fn claude_stream_uses_daemon_profile_runtime_instead_of_launcher_token() {
    assert_eq!(
        crate::runtime_claude_stream_io::claude_stream_runtime_command(
            "claude_code",
            Some("claude"),
        ),
        "claude",
    );
    assert_eq!(
        crate::runtime_claude_stream_io::claude_stream_runtime_command("claude", None),
        "claude",
    );
    assert_eq!(
        crate::runtime_claude_stream_io::claude_stream_runtime_command("claude", Some("   "),),
        "claude",
    );
    assert_eq!(
        crate::runtime_claude_stream_io::claude_stream_runtime_command(
            "/tmp/fake-claude-test",
            Some("codex"),
        ),
        "/tmp/fake-claude-test",
    );
}

#[test]
fn daemon_spawn_marks_claude_for_print_backend() {
    assert!(daemon_spawn_uses_claude_print("claude", &[]));
    assert!(daemon_spawn_uses_claude_print("claude-code.cmd", &[]));
    assert!(daemon_spawn_uses_claude_print(
        "npx",
        &["claude".to_string()]
    ));
    assert!(!daemon_spawn_uses_claude_print("bash", &[]));
}

#[test]
fn explicit_claude_print_flag_routes_custom_agent_to_programmatic_runtime() {
    let agent = SerializedAgent {
        id: "agent-1".to_string(),
        name: "wrapped-claude".to_string(),
        agent_type: "custom".to_string(),
        email: "claude@example.com".to_string(),
        ..test_agent_record()
    };
    assert!(use_claude_print_backend_for(
        true,
        &agent,
        "bash",
        "bash",
        &[]
    ));
}

#[test]
fn claude_stream_boundary_parser_detects_tool_and_result_events() {
    let assistant = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ok"},{"type":"tool_use","id":"toolu_1"}]}}"#;
    let ask_user_question = r#"{"type":"assistant","message":{"content":[{"type":"tool_call","id":"toolu_ask","name":"AskUserQuestion","input":{"questions":[{"question":"Choose A or B"}]}}]}}"#;
    let tool_result =
        r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1"}]}}"#;
    let result = r#"{"type":"result","subtype":"success"}"#;

    assert_eq!(
        claude_stream_boundaries_from_line(assistant),
        vec![HeadlessRuntimeBoundary::ClaudeToolUse]
    );
    assert_eq!(
        claude_stream_boundaries_from_line(ask_user_question),
        vec![HeadlessRuntimeBoundary::ClaudeToolUse]
    );
    assert_eq!(
        claude_stream_boundaries_from_line(tool_result),
        vec![HeadlessRuntimeBoundary::ClaudeToolResult]
    );
    assert_eq!(
        claude_stream_boundaries_from_line(result),
        vec![HeadlessRuntimeBoundary::ClaudeResult]
    );
    assert!(claude_stream_boundaries_from_line("not json").is_empty());
}

#[test]
fn claude_stream_trace_extracts_text_and_tool_blocks() {
    let assistant = serde_json::json!({
        "type": "assistant",
        "message": {
            "id": "msg_1",
            "content": [
                { "type": "text", "text": "hello " },
                { "type": "text", "text": "world" },
                { "type": "tool_use", "id": "toolu_1", "name": "Bash", "input": { "command": "pwd" } },
                { "type": "tool_call", "id": "toolu_ask", "name": "AskUserQuestion", "input": { "questions": [{ "question": "Choose A or B" }] } }
            ]
        }
    });
    let user = serde_json::json!({
        "type": "user",
        "message": {
            "content": [
                { "type": "tool_result", "tool_use_id": "toolu_1", "content": "/tmp" }
            ]
        }
    });

    assert_eq!(claude_assistant_text(&assistant), "hello world");
    assert_eq!(claude_message_id(&assistant).as_deref(), Some("msg_1"));
    let tool_uses = claude_tool_use_blocks(&assistant);
    assert_eq!(tool_uses.len(), 2);
    assert_eq!(claude_tool_item_key(&tool_uses[1]), "toolu_ask");
    assert_eq!(claude_tool_result_blocks(&user).len(), 1);
    assert_eq!(
        claude_tool_item_key(&user["message"]["content"][0]),
        "toolu_1"
    );
}

#[test]
fn claude_init_details_keeps_only_meaningful_fields() {
    let init = serde_json::json!({
        "type": "system",
        "subtype": "init",
        "model": "claude-opus-4-8",
        "cwd": "/tmp/project",
        "session_id": "sess_1",
        "permissionMode": "default",
        "tools": ["Bash", "Read", "Edit"],
        "mcp_servers": [{ "name": "chrome" }],
        "slash_commands": ["a", "b", "c"],
        "skills": ["x"],
        "memory_paths": ["/m"]
    });

    let details = claude_init_details(&init);
    assert_eq!(details["model"], "claude-opus-4-8");
    assert_eq!(details["cwd"], "/tmp/project");
    assert_eq!(details["session_id"], "sess_1");
    assert_eq!(details["toolCount"], 3);
    assert_eq!(details["mcpServerCount"], 1);
    // Noisy fields are dropped.
    assert!(details.get("slash_commands").is_none());
    assert!(details.get("skills").is_none());
    assert!(details.get("memory_paths").is_none());
    assert!(details.get("tools").is_none());
}

#[test]
fn claude_stream_trace_deltas_separate_message_ids() {
    let mut state = crate::runtime_claude_stream_io::ClaudeStreamTraceState::default();

    assert_eq!(
        claude_assistant_delta_for_message(&mut state, Some("msg_1"), "hello"),
        "hello"
    );
    assert_eq!(
        claude_assistant_delta_for_message(&mut state, Some("msg_1"), "hello world"),
        " world"
    );
    assert_eq!(
        claude_assistant_delta_for_message(&mut state, Some("msg_2"), "next"),
        "\n\nnext"
    );
    assert_eq!(state.visible_assistant_text, "hello world\n\nnext");
}

#[test]
fn long_lived_runtimes_publish_presence_only_on_state_change_or_reconnect() {
    let runtimes = [
        ("codex", include_str!("../runtime_codex_channel_session.rs")),
        ("acp", include_str!("../runtime_external_cli_auth.rs")),
        ("claude", include_str!("../runtime_headless_runs.rs")),
    ];
    for (runtime, source) in runtimes {
        assert!(
            !source.contains("RuntimePresenceHeartbeat")
                && !source.contains("presence_heartbeat")
                && !source.contains("Duration::from_secs(5)"),
            "{runtime} runtime must not poll unchanged presence state"
        );
        assert!(source.contains("AgentInstanceConnectionEvent::Reconnected"));
    }
    let owner = include_str!("../runtime_presence_updates.rs");
    assert_eq!(
        owner.matches("tokio::time::interval").count(),
        0,
        "shared presence publishing must not reintroduce an interval"
    );
}

/// The activity line a status implies has exactly one definition.
///
/// It used to be hand-written at all 48 presence call sites, and the copies had
/// already drifted: Codex and ACP sent `busy → 处理中` while Claude sent
/// `busy → thinking`. Nothing surfaced the split until two senders for the same
/// turn disagreed and the chip flipped language every 5s.
#[test]
fn the_activity_a_status_implies_is_written_in_exactly_one_place() {
    let owner = include_str!("../runtime_codex_channel_presentation.rs");
    assert!(owner.contains("pub(crate) fn presence_activity_for_status("));
    for label in ["\u{5904}\u{7406}\u{4e2d}", "\u{5f85}\u{547d}"] {
        assert_eq!(
            owner.matches(label).count(),
            1,
            "the owner states each activity once"
        );
    }
    for (runtime, source) in presence_sending_runtimes() {
        for label in [
            "\u{5904}\u{7406}\u{4e2d}",
            "\u{5f85}\u{547d}",
            "\"thinking\"",
        ] {
            assert!(
                !source.contains(label),
                "{runtime} runtime must take its activity line from the status, not spell one"
            );
        }
    }
}

/// A presence frame reaches the wire through one function taking one patch.
///
/// The nine `send_presence_update_with_*` wrappers differed only in which
/// arguments they defaulted, so the frame's parameter list — including the
/// adjacency of the two `Option<String>` fields `model` and `effort` — was
/// restated nine times.
#[test]
fn a_presence_frame_has_one_sender_and_one_parameter_list() {
    let owner = include_str!("../runtime_codex_channel_presentation.rs");
    assert_eq!(
        owner
            .matches("AgentInstanceClientMessage::PresenceUpdate")
            .count(),
        1
    );
    assert!(owner.contains("pub(crate) fn send_presence("));
    assert!(owner.contains("pub(crate) struct PresencePatch"));
    for (runtime, source) in presence_sending_runtimes() {
        assert!(
            !source.contains("send_presence_update"),
            "{runtime} runtime must send through `send_presence`, not a per-shape wrapper"
        );
        assert!(
            !source.contains("AgentInstanceClientMessage::PresenceUpdate"),
            "{runtime} runtime must not build a presence frame of its own"
        );
    }
}

fn presence_sending_runtimes() -> [(&'static str, &'static str); 6] {
    [
        (
            "codex-session",
            include_str!("../runtime_codex_channel_session.rs"),
        ),
        ("codex-app", include_str!("../runtime_codex_app_session.rs")),
        (
            "codex-goals",
            include_str!("../runtime_codex_channel_goals.rs"),
        ),
        ("acp", include_str!("../runtime_external_cli_auth.rs")),
        ("claude-turn", include_str!("../runtime_claude_turn.rs")),
        (
            "claude-headless",
            include_str!("../runtime_headless_runs.rs"),
        ),
    ]
}

/// The channel-delivery ceremony has one definition: the vendor run loops take
/// the batch from `next_channel_delivery` instead of matching the preparation
/// outcome by hand.
#[test]
fn channel_delivery_is_taken_from_one_helper() {
    let owner = include_str!("../runtime_codex_channel_delivery_queue.rs");
    assert!(owner.contains("async fn next_channel_delivery("));
    for (runtime, source) in presence_sending_runtimes() {
        for spelled_by_hand in [
            "ChannelDeliveryPrep::Continue",
            "ChannelDeliveryPrep::Ready",
        ] {
            assert!(
                !source.contains(spelled_by_hand),
                "{runtime} runtime must take the delivery outcome from next_channel_delivery"
            );
        }
    }
}

#[test]
fn claude_failed_result_names_the_error_not_the_narration() {
    use crate::runtime_claude_stream_io::claude_result_answer;
    let narration = "Checking the results, then merging:";
    let (answer, failed) = claude_result_answer(
        &serde_json::json!({
            "type": "result",
            "is_error": true,
            "subtype": "error_during_execution",
            "errors": ["API Error: 529 overloaded"],
            "result": ""
        }),
        narration,
    );
    assert!(failed);
    assert_eq!(answer, "error_during_execution: API Error: 529 overloaded");

    let (answer, failed) = claude_result_answer(
        &serde_json::json!({"type": "result", "is_error": true}),
        narration,
    );
    assert!(failed);
    assert_eq!(answer, "Claude reported an error without details");

    let (answer, failed) = claude_result_answer(
        &serde_json::json!({"type": "result", "result": ""}),
        narration,
    );
    assert!(!failed);
    assert_eq!(answer, narration);
    // An exhausted context window is a failure whatever is_error says.
    let (answer, failed) = claude_result_answer(
        &serde_json::json!({"type": "result", "is_error": false, "terminal_reason": "prompt_too_long"}),
        narration,
    );
    assert!(failed);
    assert!(answer.starts_with("Claude ended the turn with terminal_reason=prompt_too_long"));
}

#[test]
fn provider_quota_merge_keeps_windows_and_observation_metadata_together() {
    use crate::merge_llm_usage;
    let old = protocol::LlmUsage {
        total_tokens: Some(17),
        quota_source: Some("provider_api".into()),
        quota_observed_at: Some("2026-10-03T13:24:28Z".into()),
        quota_usages: Some(vec![protocol::LlmQuotaUsage {
            percent: Some(80.0),
            ..Default::default()
        }]),
        ..Default::default()
    };
    let fresh = protocol::LlmUsage {
        quota_source: Some("provider_api".into()),
        quota_observed_at: Some("2026-10-03T20:18:00Z".into()),
        quota_usages: Some(vec![protocol::LlmQuotaUsage {
            percent: Some(100.0),
            ..Default::default()
        }]),
        ..Default::default()
    };
    let merged = merge_llm_usage(Some(old), Some(fresh)).unwrap();
    assert_eq!(
        merged.quota_observed_at.as_deref(),
        Some("2026-10-03T20:18:00Z")
    );
    assert_eq!(
        merged.quota_usages.as_ref().unwrap()[0].percent,
        Some(100.0)
    );
    assert_eq!(merged.total_tokens, Some(17));
    let token_only = merge_llm_usage(
        Some(merged.clone()),
        Some(protocol::LlmUsage {
            total_tokens: Some(23),
            ..Default::default()
        }),
    )
    .unwrap();
    assert_eq!(token_only.quota_observed_at, merged.quota_observed_at);
    assert_eq!(
        serde_json::to_value(&token_only.quota_usages).unwrap(),
        serde_json::to_value(&merged.quota_usages).unwrap()
    );
    let unstamped = merge_llm_usage(
        Some(merged),
        Some(protocol::LlmUsage {
            quota_usages: Some(vec![protocol::LlmQuotaUsage {
                percent: Some(1.0),
                ..Default::default()
            }]),
            ..Default::default()
        }),
    )
    .unwrap();
    assert!(
        unstamped.quota_observed_at.is_none(),
        "unstamped windows must not inherit another observation's timestamp"
    );
    assert!(unstamped.quota_source.is_none());
}

fn runtime_chip_matches(
    chips: &[xmatrix_cli_core::protocol::AgentStatusChip],
    id: &str,
    value: &str,
) -> bool {
    chips
        .iter()
        .any(|chip| chip.id == id && chip.value.as_deref() == Some(value))
}

fn assert_kimi_fixture_usage(usage: &protocol::LlmUsage) {
    assert_eq!(usage.context_used_tokens, Some(8192));
    assert_eq!(usage.context_window_tokens, Some(131072));
    assert_eq!(usage.context_usage_percent, Some(6.25));
    assert_eq!(usage.cost_usd, Some(0.0042));
}
