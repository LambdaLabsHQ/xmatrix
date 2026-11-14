/// Only daemon-delivered registration instructions and the official compact
/// reminder belong in Codex's persistent developer context. The composed
/// bootstrap and Channel input can contain untrusted history and display names.
fn codex_thread_developer_instructions() -> Option<String> {
    let mut instructions = crate::runtime_trusted_role_prompt::trusted_role_system_prompt_from_env()
        .into_iter()
        .collect::<Vec<_>>();
    if let Some(channel_id) = non_empty_env("XMATRIX_AUTO_JOIN_CHANNEL_ID") {
        instructions.push(bootstrap::channel_turn_policy(&channel_id));
    }
    (!instructions.is_empty()).then(|| instructions.join("\n\n"))
}

/// Env var carrying this launch's access grant from the daemon to its wrapper.
const AGENT_ACCESS_ENV: &str = "XMATRIX_AGENT_ACCESS";

/// What this launch adds for its access mode, as its daemon passed the Hub's
/// grant. Every Run is started by a daemon; a harness session started without
/// one (a readiness probe, a test) adds nothing and has its requests answered.
fn launch_access() -> xmatrix_cli_core::machine_daemon_connection::AgentAccessGrant {
    non_empty_env(AGENT_ACCESS_ENV)
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| xmatrix_cli_core::machine_daemon_connection::AgentAccessGrant {
            mode: "full".into(),
            approves_requests: true,
            ..Default::default()
        })
}

/// Adds the grant's session values to the request that starts a native session.
fn with_access_session(
    mut params: Value,
    access: &xmatrix_cli_core::machine_daemon_connection::AgentAccessGrant,
) -> Value {
    for (name, value) in &access.session {
        params[name.as_str()] = Value::String(value.clone());
    }
    params
}

fn codex_thread_resume_params(thread_id: &str, cwd: Option<&str>) -> Value {
    serde_json::json!({
        "threadId": thread_id,
        "cwd": cwd,
        // Resume only needs thread metadata; Codex already holds the live
        // context. Returning the full turn history here is what overflowed the
        // WebSocket frame on long sessions.
        "excludeTurns": true,
    })
}

fn provider_transport_should_retry_startup(err: &CliError) -> bool {
    match err {
        CliError::ProviderTransport { source, .. } => source.retryable(),
        _ => true,
    }
}
