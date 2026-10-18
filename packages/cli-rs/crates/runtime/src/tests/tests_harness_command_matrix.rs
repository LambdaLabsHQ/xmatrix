// Harness × command matrix: every command the composer offers for a
// registered harness must reach something that runs it. A harness added to
// `agent-presets.json` joins the matrix and fails until its backend has a row.

/// Where an offered command goes once someone sends it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum MatrixRoute {
    /// Hub control request answered by the runtime's model/effort switch.
    Control,
    /// Intercepted by the runtime (`/goal`, `/config`, `/fast`).
    Runtime,
    /// Mapped by the runtime onto this provider request.
    Native(&'static str),
    /// Leading prompt text that the harness reported it executes.
    Prompt,
    /// Leading prompt text known only from the vendor's command docs.
    Documented,
}

/// Backends whose run loop answers Hub model/effort switch requests.
const CONTROL_BACKENDS: &[&str] = &["codex-app", "claude-print", "grok-acp", "acp"];

fn matrix_adapter(
    preset: &xmatrix_cli_agent::AgentPreset,
) -> Option<super::agent_presentation::BuiltinAgentPresentationAdapter> {
    match preset.backend.as_str() {
        "codex-app" => {
            Some(super::agent_presentation::agent_presentation_adapter_for_runtime("codex"))
        }
        "claude-print" => {
            Some(super::agent_presentation::agent_presentation_adapter_for_runtime("claude"))
        }
        "zcode-app" => {
            Some(super::agent_presentation::agent_presentation_adapter_for_runtime("zcode"))
        }
        "grok-acp" => Some(super::AcpVendorConfig::grok().presentation_adapter),
        "acp" => Some(super::AcpVendorConfig::generic(&preset.runtime).presentation_adapter),
        // A custom PTY harness types into a terminal; it offers no commands.
        "pty" => None,
        other => panic!("backend {other} has no row in the harness command matrix"),
    }
}

fn matrix_route(
    backend: &str,
    command: &protocol::AgentInstanceCommand,
    live: &std::collections::HashSet<String>,
) -> Result<MatrixRoute, String> {
    let token = command.token.to_ascii_lowercase();
    if matches!(
        command.argument_source.as_deref(),
        Some("agent-models" | "agent-efforts")
    ) {
        return if CONTROL_BACKENDS.contains(&backend) {
            Ok(MatrixRoute::Control)
        } else {
            Err(format!("{backend} cannot answer a {token} switch"))
        };
    }
    // Generic ACP peers get `/goal` as prompt text; only these intercept it.
    let intercepts_goal = matches!(
        backend,
        "codex-app" | "claude-print" | "zcode-app" | "grok-acp"
    );
    if intercepts_goal && super::parse_goal_command(&token).is_some()
        || crate::harness_parameters::command(&token).is_some()
    {
        return Ok(MatrixRoute::Runtime);
    }
    if command.mode.as_deref() == Some("typed") {
        return Err(format!(
            "{backend} {token} is typed but nothing intercepts it"
        ));
    }
    match backend {
        "codex-app" => super::parse_codex_native_turn(&token)
            .map(|native| MatrixRoute::Native(native.request("thread").0))
            .ok_or_else(|| format!("Codex would receive {token} as prose")),
        "claude-print" if live.contains(&token) => Ok(MatrixRoute::Prompt),
        "claude-print" => Err(format!("Claude did not report {token}")),
        _ if live.contains(&token) => Ok(MatrixRoute::Prompt),
        _ => Ok(MatrixRoute::Documented),
    }
}

fn matrix_model() -> protocol::AgentModelInfo {
    protocol::AgentModelInfo {
        id: "model-a".into(),
        model: "model-a".into(),
        display_name: None,
        description: None,
        hidden: None,
        is_default: None,
        default_reasoning_effort: Some("high".into()),
        supported_reasoning_efforts: Some(vec![protocol::AgentModelReasoningEffort {
            reasoning_effort: "high".into(),
            description: None,
        }]),
        input_modalities: None,
        supports_personality: None,
        upgrade: None,
    }
}

#[test]
fn every_registered_harness_routes_every_offered_command() {
    use super::agent_presentation::AgentPresentationAdapter;
    let mut rows = Vec::new();
    for preset in xmatrix_cli_agent::agent_presets() {
        let Some(adapter) = matrix_adapter(preset) else {
            assert_eq!(
                preset.id, "custom",
                "only the custom PTY harness offers no commands"
            );
            continue;
        };
        let backend = preset.backend.as_str();
        // What a live session reports: a model catalog with efforts, plus the
        // commands the provider enumerates itself (ACP `available_commands`,
        // Claude `system/init.slash_commands`).
        let reported = vec!["/best-of-n".to_string()];
        let overlay: Vec<String> = match backend {
            "claude-print" => [
                "compact", "context", "clear", "usage", "model", "effort", "goal",
            ]
            .map(String::from)
            .to_vec(),
            _ => Vec::new(),
        };
        // ZCode's app-server reports no model catalog.
        let has_catalog = backend != "zcode-app";
        let facts = super::agent_presentation::AgentPresentationFacts {
            models: if has_catalog {
                vec![matrix_model()]
            } else {
                Vec::new()
            },
            models_reported: has_catalog,
            model: Some("model-a".into()),
            commands: match backend {
                "acp" | "grok-acp" => reported
                    .iter()
                    .map(|token| protocol::AgentInstanceCommand {
                        token: token.clone(),
                        label: token.clone(),
                        description: None,
                        mode: Some("passthrough".into()),
                        argument_source: None,
                        freeform: None,
                    })
                    .collect(),
                _ => Vec::new(),
            },
            ..Default::default()
        };
        let live: std::collections::HashSet<String> = reported
            .iter()
            .filter(|_| matches!(backend, "acp" | "grok-acp"))
            .cloned()
            .chain(overlay.iter().map(|name| format!("/{name}")))
            .collect();
        let commands = adapter
            .present(&facts, &overlay)
            .commands
            .unwrap_or_default();
        if has_catalog {
            for control in ["/model", "/effort"] {
                assert!(
                    commands.iter().any(|command| command.token == control),
                    "{} must offer {control} once its catalog is live",
                    preset.id
                );
            }
        }
        for command in &commands {
            match matrix_route(backend, command, &live) {
                Ok(route) => rows.push(format!(
                    "{:<12} {:<12} {:<14} {route:?}",
                    preset.id, backend, command.token
                )),
                Err(error) => panic!("{}: {error}", preset.id),
            }
        }
    }
    // `cargo test … -- --nocapture` prints the matrix itself.
    println!("{}", rows.join("\n"));
}

#[test]
fn codex_native_commands_start_their_app_server_request() {
    let compact = super::parse_codex_native_turn("/compact").unwrap();
    assert_eq!(
        compact.request("t"),
        (
            "thread/compact/start",
            serde_json::json!({ "threadId": "t" })
        )
    );
    let (method, params) = super::parse_codex_native_turn("/review")
        .unwrap()
        .request("t");
    assert_eq!(method, "review/start");
    assert_eq!(
        params["target"],
        serde_json::json!({ "type": "uncommittedChanges" })
    );
    let (_, params) = super::parse_codex_native_turn("/review focus on auth")
        .unwrap()
        .request("t");
    assert_eq!(
        params["target"],
        serde_json::json!({ "type": "custom", "instructions": "focus on auth" })
    );
    assert_eq!(super::parse_codex_native_turn("/reviewer"), None);
    assert_eq!(super::parse_codex_native_turn("/status"), None);
}

#[test]
fn claude_offers_only_the_catalog_commands_its_session_reported() {
    use super::agent_presentation::AgentPresentationAdapter;
    let adapter = super::agent_presentation::agent_presentation_adapter_for_runtime("claude");
    let facts = super::agent_presentation::AgentPresentationFacts::default();
    let tokens = |overlay: &[&str]| -> Vec<String> {
        let overlay: Vec<String> = overlay.iter().map(|name| name.to_string()).collect();
        adapter
            .present(&facts, &overlay)
            .commands
            .unwrap_or_default()
            .into_iter()
            .map(|command| command.token)
            .collect()
    };
    let live = tokens(&["compact", "my-skill"]);
    assert!(live.contains(&"/compact".to_string()));
    assert!(live.contains(&"/my-skill".to_string()));
    assert!(live.contains(&"/goal".to_string()), "typed controls stay");
    assert!(
        !live.contains(&"/context".to_string()),
        "unreported docs entries go"
    );
    // Before system/init arrives the docs catalog is all there is.
    assert!(tokens(&[]).contains(&"/context".to_string()));
}

/// `session/new` and `available_commands_update` captured from real ACP
/// harnesses (`tests/fixtures/acp-live`, unauthenticated first session).
#[test]
fn live_captured_acp_sessions_route_every_offered_command() {
    use super::agent_presentation::AgentPresentationAdapter;
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/acp-live");
    let mut seen = 0;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        let harness = path.file_stem().unwrap().to_string_lossy().to_string();
        let capture: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let preset = xmatrix_cli_agent::agent_presets()
            .iter()
            .find(|preset| preset.id == harness)
            .unwrap_or_else(|| panic!("{harness} is not a registered harness"));
        let adapter = matrix_adapter(preset).unwrap();
        let mut facts = super::agent_presentation::AgentPresentationFacts::default();
        adapter.observe_acp(&capture["session/new"], &mut facts);
        adapter.observe_acp(&capture["session/update"], &mut facts);
        let live: std::collections::HashSet<String> = facts
            .commands
            .iter()
            .map(|command| command.token.to_ascii_lowercase())
            .collect();
        let commands = adapter.present(&facts, &[]).commands.unwrap_or_default();
        assert!(
            commands.iter().any(|command| command.token == "/model"),
            "{harness} reported a model selector, so /model must be offered"
        );
        for command in &commands {
            let route = matrix_route(&preset.backend, command, &live)
                .unwrap_or_else(|error| panic!("{harness}: {error}"));
            assert_ne!(
                route,
                MatrixRoute::Documented,
                "{harness} {}",
                command.token
            );
        }
        for token in &live {
            assert!(
                commands.iter().any(|command| &command.token == token),
                "{harness} hid {token}"
            );
        }
        seen += 1;
    }
    assert!(seen > 0);
}
