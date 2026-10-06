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
