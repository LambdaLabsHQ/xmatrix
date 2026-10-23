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

fn codex_thread_resume_params(
    thread_id: &str,
    cwd: Option<&str>,
    approval_policy: &str,
    sandbox: &str,
) -> Value {
    serde_json::json!({
        "threadId": thread_id,
        "cwd": cwd,
        "approvalPolicy": approval_policy,
        "sandbox": sandbox,
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
