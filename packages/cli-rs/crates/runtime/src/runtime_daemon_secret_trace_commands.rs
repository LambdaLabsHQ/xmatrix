fn next_daemon_control_poll_retry_delay_ms(current_ms: u64) -> u64 {
    current_ms.saturating_mul(2).clamp(
        DAEMON_CONTROL_POLL_RETRY_BASE_MS,
        DAEMON_CONTROL_POLL_RETRY_MAX_MS,
    )
}

async fn sleep_daemon_control_poll_retry(delay_ms: u64) {
    let jitter_ms = current_time_millis().unwrap_or_default() % DAEMON_CONTROL_POLL_RETRY_JITTER_MS;
    tokio::time::sleep(Duration::from_millis(delay_ms.saturating_add(jitter_ms))).await;
}

async fn wait_for_daemon_control_poll_window(relay: &SharedMachineDaemonConnection) {
    let initially_connected = relay.is_connected();
    if initially_connected {
        // Healthy connected: do not HTTP-poll. Recovery is Hub evict + reconnect.
        loop {
            if !relay.is_connected() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(
                DAEMON_CONTROL_CONNECTION_CHECK_INTERVAL_MS,
            ))
            .await;
        }
    }
    let wait_ms = daemon_control_idle_wait_ms();
    let started = Instant::now();
    loop {
        if relay.is_connected() {
            return;
        }
        let elapsed_ms = started.elapsed().as_millis() as u64;
        if elapsed_ms >= wait_ms {
            return;
        }
        let remaining_ms = wait_ms - elapsed_ms;
        tokio::time::sleep(Duration::from_millis(
            remaining_ms.min(DAEMON_CONTROL_CONNECTION_CHECK_INTERVAL_MS),
        ))
        .await;
    }
}

pub(crate) fn daemon_control_idle_wait_ms() -> u64 {
    DAEMON_CONTROL_DISCONNECTED_WAIT_MS
}

/// Registered SIGTERM/SIGHUP listeners for an agent runtime main loop.
///
/// A signal that kills the process directly skips every Rust `Drop` guard, so a
/// `kill <wrapper-pid>` used to leave the runtime child (its own process group)
/// running as an orphan. Registering these streams once before the loop and
/// routing them through the same `break` → `app.shutdown()` path as Ctrl-C
/// guarantees the child process tree is terminated before the wrapper exits.
struct TerminationSignals {
    #[cfg(unix)]
    terminate: Option<tokio::signal::unix::Signal>,
    #[cfg(unix)]
    hangup: Option<tokio::signal::unix::Signal>,
}

impl TerminationSignals {
    fn new() -> Self {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{SignalKind, signal};
            Self {
                terminate: signal(SignalKind::terminate()).ok(),
                hangup: signal(SignalKind::hangup()).ok(),
            }
        }
        #[cfg(not(unix))]
        {
            Self {}
        }
    }

    /// Resolves when SIGTERM or SIGHUP arrives; pends forever off-Unix or when
    /// registration failed (Ctrl-C handling still covers those paths).
    async fn recv(&mut self) {
        #[cfg(unix)]
        {
            let terminate_stream = self.terminate.as_mut();
            let hangup_stream = self.hangup.as_mut();
            let terminate = async {
                match terminate_stream {
                    Some(stream) => {
                        stream.recv().await;
                    }
                    None => std::future::pending::<()>().await,
                }
            };
            let hangup = async {
                match hangup_stream {
                    Some(stream) => {
                        stream.recv().await;
                    }
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::select! {
                _ = terminate => {}
                _ = hangup => {}
            }
        }
        #[cfg(not(unix))]
        {
            std::future::pending::<()>().await
        }
    }
}

fn cmd_daemon_wake_metrics(harness: Option<&str>, json: bool) -> error::Result<()> {
    let path = runtime_wake_metrics::metrics_path(&daemon_run_state_root());
    let records = runtime_wake_metrics::read_records(&path);
    let aggregates = runtime_wake_metrics::aggregate(&records, harness.map(str::trim));
    if json {
        let value = serde_json::json!({
            "path": path.display().to_string(),
            "records": records.len(),
            "harnesses": aggregates,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&value)
                .map_err(|error| CliError::Launch(error.to_string()))?
        );
    } else {
        print!("{}", runtime_wake_metrics::render_text(&path, &aggregates));
    }
    Ok(())
}

async fn cmd_daemon_command(command: DaemonCommand) -> error::Result<()> {
    match command {
        DaemonCommand::Doctor { cleanup } => cmd_daemon_doctor(cleanup),
        DaemonCommand::WakeMetrics { harness, json } => {
            cmd_daemon_wake_metrics(harness.as_deref(), json)
        }
        DaemonCommand::SyncSession => {
            match daemon_auth::reload_saved_session_in_local_daemon().await? {
                daemon_auth::DaemonSessionReloadOutcome::Reloaded => {
                    println!("{} daemon session reloaded without restart", "✓".green().bold());
                    Ok(())
                }
                daemon_auth::DaemonSessionReloadOutcome::AlreadyCurrent => {
                    println!("{} daemon already uses the saved session", "✓".green().bold());
                    Ok(())
                }
                daemon_auth::DaemonSessionReloadOutcome::Unavailable => Err(CliError::Auth(
                    "Local xMatrix daemon is not running or its auth broker is unavailable".into(),
                )),
                daemon_auth::DaemonSessionReloadOutcome::Unsupported => Err(CliError::Auth(
                    "Running xMatrix daemon does not support live session reload; update and restart it once"
                        .into(),
                )),
            }
        }
        DaemonCommand::ProfileStatus { json } => {
            let context = config::process_profile_context().ok_or_else(|| {
                CliError::Auth("No profile was fixed at command admission".into())
            })?;
            let live = xmatrix_cli_core::daemon_host::daemon_host_status(
                &xmatrix_cli_core::profile::InstallationRoot::discover(),
            )
            .await?;
            let (ready_revision, generation, state, detail) = match live {
                xmatrix_cli_core::daemon_host::DaemonHostQueryOutcome::Available(status) => {
                    let profile = status
                        .profiles
                        .into_iter()
                        .find(|profile| profile.profile_id == context.id);
                    (
                        Some(status.loaded_registry_revision),
                        Some(status.generation),
                        profile
                            .as_ref()
                            .map(|profile| profile.lifecycle.as_str())
                            .unwrap_or("not-managed")
                            .to_string(),
                        profile.and_then(|profile| profile.detail),
                    )
                }
                xmatrix_cli_core::daemon_host::DaemonHostQueryOutcome::Unavailable => {
                    (None, None, "unavailable".into(), None)
                }
                xmatrix_cli_core::daemon_host::DaemonHostQueryOutcome::Unsupported => {
                    (None, None, "unsupported".into(), None)
                }
            };
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "profileId": context.id,
                        "name": context.name,
                        "hubUrl": context.hub_origin,
                        "registryRevision": context.registry_revision,
                        "daemonAppliedRevision": ready_revision,
                        "daemonGeneration": generation,
                        "state": state,
                        "detail": detail,
                    }))?
                );
            } else {
                println!("Profile: {}", context.name);
                println!("ID: {}", context.id);
                println!("Hub: {}", context.hub_origin);
                println!("State: {state}");
                if let Some(detail) = detail {
                    println!("Detail: {detail}");
                }
                println!("Registry revision: {}", context.registry_revision);
                println!(
                    "Daemon applied revision: {}",
                    ready_revision
                        .map(|revision| revision.to_string())
                        .unwrap_or_else(|| "unavailable".to_string())
                );
            }
            Ok(())
        }
        DaemonCommand::StartProfile => {
            cmd_daemon_profile_control(
                xmatrix_cli_core::daemon_host::ProfileControlAction::Start,
                "start",
            )
            .await
        }
        DaemonCommand::StopProfile => {
            cmd_daemon_profile_control(
                xmatrix_cli_core::daemon_host::ProfileControlAction::Stop,
                "stop",
            )
            .await
        }
        DaemonCommand::RestartProfile => {
            cmd_daemon_profile_control(
                xmatrix_cli_core::daemon_host::ProfileControlAction::Restart,
                "restart",
            )
            .await
        }
    }
}

async fn cmd_daemon_profile_control(
    action: xmatrix_cli_core::daemon_host::ProfileControlAction,
    action_label: &str,
) -> error::Result<()> {
    let context = config::process_profile_context()
        .ok_or_else(|| CliError::Auth("No profile was fixed at command admission".into()))?;
    match xmatrix_cli_core::daemon_host::daemon_profile_control(
        &xmatrix_cli_core::profile::InstallationRoot::discover(),
        action,
        &context.id,
    )
    .await?
    {
        xmatrix_cli_core::daemon_host::DaemonHostQueryOutcome::Available(response) => {
            println!(
                "{} profile `{}` {} requested; runtime is {} (registry revision {})",
                "✓".green().bold(),
                context.name,
                action_label,
                response.lifecycle,
                response.loaded_registry_revision
            );
            Ok(())
        }
        xmatrix_cli_core::daemon_host::DaemonHostQueryOutcome::Unavailable => Err(
            CliError::Launch("Local xMatrix daemon host is unavailable".into()),
        ),
        xmatrix_cli_core::daemon_host::DaemonHostQueryOutcome::Unsupported => Err(
            CliError::Launch("Running xMatrix daemon does not support profile control".into()),
        ),
    }
}

async fn cmd_secret(hub_url: &str, token: &str, command: SecretCommand) -> error::Result<()> {
    match command {
        SecretCommand::List { space, json } => match space {
            Some(space) => cmd_secret_list(hub_url, token, &space, json).await,
            None => cmd_request_secrets(hub_url, token, json).await,
        },
        SecretCommand::Set {
            secret_ref,
            value,
            value_stdin,
            env_name,
            description,
            access,
            space,
        } => {
            validate_secret_catalog_args(&secret_ref, env_name.as_deref())?;
            let mut body = serde_json::json!({
                "secretRef": secret_ref,
                "value": read_secret_set_value(value, value_stdin)?,
                "envName": env_name,
                "description": description,
                "access": access.map(|value| value.as_str()),
            });
            if let Some(fields) = body.as_object_mut() {
                fields.retain(|_, value| !value.is_null());
            }
            // A person saves into a named Space; an Agent Run into its own.
            let (route, method) = match space.as_deref() {
                Some(space) => (protocol::space_secrets_route(space), "PUT"),
                None => (HubRoutes::SECRETS.to_string(), "POST"),
            };
            let response: SpaceSecretResponse = http::request_json(
                &with_route(hub_url, &route),
                method,
                Some(token),
                Some(body),
            )
            .await?;
            let secret = response.secret;
            println!(
                "Saved secret {} (env: {}, access: {}).",
                secret.secret_ref, secret.env_name, secret.access
            );
            Ok(())
        }
        SecretCommand::Delete { secret_ref, space } => {
            cmd_secret_delete(hub_url, token, &space, secret_ref).await
        }
        SecretCommand::Exec { secrets, command } => {
            cmd_secret_exec(hub_url, token, secrets, command).await
        }
    }
}

#[derive(Deserialize)]
struct RunSecretsResponse {
    secrets: Vec<RunSecretValue>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunSecretValue {
    secret_ref: String,
    env_name: String,
    #[serde(default)]
    value: String,
    #[serde(default)]
    access: Option<String>,
    #[serde(default)]
    readable: Option<bool>,
}

/// `<alias>` or `<alias>=<ENV_NAME>`.
fn parse_secret_exec_mapping(value: &str) -> error::Result<(String, Option<String>)> {
    let (secret_ref, env_name) = match value.split_once('=') {
        Some((secret_ref, env_name)) => (secret_ref, Some(env_name.to_string())),
        None => (value, None),
    };
    if !valid_secret_ref(secret_ref) {
        return Err(CliError::Launch(format!(
            "invalid secret alias '{secret_ref}'"
        )));
    }
    if let Some(env_name) = env_name.as_deref() {
        validate_secret_catalog_args(secret_ref, Some(env_name))?;
    }
    Ok((secret_ref.to_string(), env_name))
}

async fn read_run_secrets(
    hub_url: &str,
    token: &str,
    secret_refs: &[&String],
) -> error::Result<RunSecretsResponse> {
    let body = if secret_refs.is_empty() {
        serde_json::json!({})
    } else {
        serde_json::json!({ "secretRefs": secret_refs })
    };
    http::request_json(
        &with_route(hub_url, HubRoutes::RUN_SECRETS),
        "POST",
        Some(token),
        Some(body),
    )
    .await
}

/// Runs `command` with secrets of the Agent's Space in its environment, read
/// at this moment; the values never touch disk. A named secret the Run may not
/// read yet is asked for on a card in its Channel, and the command runs once a
/// Space admin answers it.
async fn cmd_secret_exec(
    hub_url: &str,
    token: &str,
    secrets: Vec<String>,
    command: Vec<String>,
) -> error::Result<()> {
    let mappings = secrets
        .iter()
        .map(|value| parse_secret_exec_mapping(value))
        .collect::<error::Result<Vec<_>>>()?;
    let refs = mappings
        .iter()
        .map(|(secret_ref, _)| secret_ref)
        .collect::<Vec<_>>();
    let response = match read_run_secrets(hub_url, token, &refs).await {
        Err(error) if error.http_message().is_some_and(secret_request_still_open) => {
            for (secret_ref, env_name) in &mappings {
                let request = SecretAddRequest {
                    secret_ref: secret_ref.clone(),
                    env_name: env_name.clone(),
                    reason: None,
                    description: None,
                };
                request_secret_and_wait(hub_url, token, &request, false).await?;
            }
            read_run_secrets(hub_url, token, &refs).await?
        }
        result => result?,
    };
    let (program, args) = command
        .split_first()
        .ok_or_else(|| CliError::Launch("a command is required".into()))?;
    let mut child = std::process::Command::new(program);
    child.args(args);
    for secret in response.secrets {
        let env_name = mappings
            .iter()
            .find(|(secret_ref, _)| *secret_ref == secret.secret_ref)
            .and_then(|(_, env_name)| env_name.clone())
            .unwrap_or(secret.env_name);
        child.env(env_name, secret.value);
    }
    let status = child
        .status()
        .map_err(|error| CliError::Launch(format!("failed to run {program}: {error}")))?;
    std::process::exit(status.code().unwrap_or(1));
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpaceSecretEntry {
    secret_ref: String,
    env_name: String,
    access: String,
    description: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SpaceSecretListResponse {
    secrets: Vec<SpaceSecretEntry>,
}

#[derive(Debug, Deserialize)]
struct SpaceSecretResponse {
    secret: SpaceSecretEntry,
}

#[derive(Debug, Deserialize)]
struct SpaceSecretDeleteResponse {
    deleted: bool,
}

async fn cmd_secret_list(hub_url: &str, token: &str, space: &str, json: bool) -> error::Result<()> {
    let response: SpaceSecretListResponse = http::request_json(
        &with_route(hub_url, &protocol::space_secrets_route(space)),
        "GET",
        Some(token),
        None,
    )
    .await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&response.secrets)?);
        return Ok(());
    }
    if response.secrets.is_empty() {
        println!("This Space has no secrets.");
        return Ok(());
    }
    println!(
        "{:<28} {:<28} {:<6} DESCRIPTION",
        "ALIAS".bold(),
        "ENV".bold(),
        "ACCESS".bold()
    );
    for secret in &response.secrets {
        println!(
            "{:<28} {:<28} {:<6} {}",
            secret.secret_ref,
            secret.env_name,
            secret.access,
            secret.description.as_deref().unwrap_or("")
        );
    }
    Ok(())
}

async fn cmd_secret_delete(
    hub_url: &str,
    token: &str,
    space: &str,
    secret_ref: String,
) -> error::Result<()> {
    if !valid_secret_ref(&secret_ref) {
        return Err(CliError::Launch(format!(
            "invalid secret alias '{secret_ref}'"
        )));
    }
    let route = protocol::space_secret_route(space, &secret_ref);
    let response: SpaceSecretDeleteResponse =
        http::request_json(&with_route(hub_url, &route), "DELETE", Some(token), None).await?;
    if response.deleted {
        println!("Deleted secret {secret_ref}.");
    } else {
        println!("Secret {secret_ref} was not found.");
    }
    Ok(())
}

fn read_secret_set_value(
    value: Option<String>,
    value_stdin: bool,
) -> error::Result<Option<String>> {
    if !value_stdin {
        return Ok(value);
    }
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw)?;
    Ok(Some(strip_single_trailing_newline(&raw).to_string()))
}

fn strip_single_trailing_newline(value: &str) -> &str {
    value
        .strip_suffix("\r\n")
        .or_else(|| value.strip_suffix('\n'))
        .unwrap_or(value)
}

fn validate_secret_catalog_args(secret_ref: &str, env_name: Option<&str>) -> error::Result<()> {
    if !valid_secret_ref(secret_ref) {
        return Err(CliError::Launch(format!(
            "invalid secret alias '{secret_ref}'"
        )));
    }
    if let Some(env_name) = env_name
        && !valid_env_name(env_name) {
            return Err(CliError::Launch(format!(
                "invalid secret environment variable '{env_name}'"
            )));
        }
    Ok(())
}

async fn cmd_request(
    hub_url: &str,
    cli_token: Option<&str>,
    command: RequestCommand,
) -> error::Result<()> {
    let token = resolve_auth_token(cli_token, hub_url).await?;
    match command {
        RequestCommand::Secrets { json } => cmd_request_secrets(hub_url, &token, json).await,
        RequestCommand::SecretAccess {
            secret_refs,
            reason,
            json,
        } => cmd_request_secret_access(hub_url, &token, secret_refs, reason, json).await,
        RequestCommand::SecretAdd {
            secret_ref,
            env,
            reason,
            description,
            cwd,
            json,
            command,
        } => {
            let request = SecretAddRequest {
                secret_ref: secret_ref.trim().to_string(),
                env_name: env.map(|env| env.trim().to_string()),
                reason,
                description,
            };
            let env_name = request_secret_and_wait(hub_url, &token, &request, json).await?;
            let Some(env_name) = env_name else {
                return Ok(());
            };
            let secret_ref = request.secret_ref;
            if !command.is_empty() {
                if let Some(cwd) = cwd {
                    std::env::set_current_dir(&cwd).map_err(|error| {
                        CliError::Launch(format!("failed to enter {}: {error}", cwd.display()))
                    })?;
                }
                return cmd_secret_exec(
                    hub_url,
                    &token,
                    vec![format!("{secret_ref}={env_name}")],
                    command,
                )
                .await;
            }
            if json {
                println!(
                    "{}",
                    serde_json::json!({ "status": "readable", "secretRef": secret_ref, "envName": env_name })
                );
            } else {
                eprintln!(
                    "Secret '{secret_ref}' is yours to use: xmatrix secret exec --secret {secret_ref} -- <cmd> [args...]"
                );
            }
            Ok(())
        }
    }
}

/// This Space's secrets and which ones this Agent may read now; never values.
async fn cmd_request_secrets(hub_url: &str, token: &str, json: bool) -> error::Result<()> {
    let response: RunSecretsResponse = http::request_json(
        &with_route(hub_url, HubRoutes::RUN_SECRETS),
        "POST",
        Some(token),
        Some(serde_json::json!({ "valuesOmitted": true })),
    )
    .await?;
    if json {
        let secrets = response
            .secrets
            .iter()
            .map(|secret| {
                serde_json::json!({
                    "secretRef": secret.secret_ref,
                    "envName": secret.env_name,
                    "access": secret.access,
                    "readable": secret.readable,
                })
            })
            .collect::<Vec<_>>();
        println!("{}", serde_json::json!({ "secrets": secrets }));
        return Ok(());
    }
    if response.secrets.is_empty() {
        println!(
            "This Space has no secrets yet. Ask a Space admin for one with `xmatrix request secret-add <alias> --env <ENV_NAME>`."
        );
        return Ok(());
    }
    for secret in &response.secrets {
        let state = if secret.readable == Some(true) {
            "readable"
        } else {
            "ask: `xmatrix secret exec --secret <alias>` asks a Space admin on a card"
        };
        println!("{}\t{}\t{state}", secret.secret_ref, secret.env_name);
    }
    Ok(())
}

#[derive(Debug)]
struct SecretAddRequest {
    secret_ref: String,
    env_name: Option<String>,
    reason: Option<String>,
    description: Option<String>,
}

/// Posts a card asking a Space admin for a secret this Agent may not read yet
/// (approve a saved one, or type the value of a new one), then waits until the
/// Agent may read it. Returns the environment name it reads as, or `None` when
/// the wait ended with `--json` output. Nothing here passes through the daemon.
async fn request_secret_and_wait(
    hub_url: &str,
    token: &str,
    request: &SecretAddRequest,
    json: bool,
) -> error::Result<Option<String>> {
    let secret_ref = &request.secret_ref;
    validate_secret_catalog_args(secret_ref, request.env_name.as_deref())?;
    let posted: serde_json::Value = http::request_json(
        &with_route(hub_url, HubRoutes::SECRET_REQUESTS),
        "POST",
        Some(token),
        Some(serde_json::json!({
            "secretRef": secret_ref,
            "envName": request.env_name,
            "description": request.description,
            "reason": request.reason,
        })),
    )
    .await?;
    if posted["readable"].as_bool() != Some(true) && !json {
        eprintln!(
            "Asked a Space admin for '{secret_ref}' on a card in this Channel; waiting (up to {} minutes)...",
            SECRET_REQUEST_WAIT.as_secs() / 60
        );
    }
    let deadline = std::time::Instant::now() + SECRET_REQUEST_WAIT;
    loop {
        match read_run_secrets(hub_url, token, &[secret_ref]).await {
            Ok(read) => {
                return Ok(read
                    .secrets
                    .into_iter()
                    .next()
                    .map(|secret| request.env_name.clone().unwrap_or(secret.env_name)));
            }
            Err(error) if error.http_message().is_some_and(secret_request_still_open) => {}
            Err(error) => return Err(error),
        }
        if std::time::Instant::now() >= deadline {
            let usage = format!("xmatrix secret exec --secret {secret_ref} -- <cmd> [args...]");
            if json {
                println!(
                    "{}",
                    serde_json::json!({ "status": "waiting", "request": posted["request"], "use": usage })
                );
                return Ok(None);
            }
            return Err(CliError::Launch(format!(
                "No Space admin has answered the card for '{secret_ref}' yet. It stays in this Channel; once answered, use: {usage}"
            )));
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
}

/// Posts the card on which a Space admin chooses which of these secrets
/// Agents read without asking. Only that answer changes a secret.
async fn cmd_request_secret_access(
    hub_url: &str,
    token: &str,
    secret_refs: Vec<String>,
    reason: Option<String>,
    json: bool,
) -> error::Result<()> {
    let secret_refs: Vec<String> = secret_refs
        .iter()
        .map(|secret_ref| secret_ref.trim().to_string())
        .collect();
    for secret_ref in &secret_refs {
        validate_secret_catalog_args(secret_ref, None)?;
    }
    let posted: serde_json::Value = http::request_json(
        &with_route(hub_url, HubRoutes::SECRET_REQUESTS),
        "POST",
        Some(token),
        Some(serde_json::json!({
            "access": "auto",
            "secretRefs": secret_refs,
            "reason": reason,
        })),
    )
    .await?;
    if json {
        println!("{posted}");
    } else if posted["automatic"].as_bool() == Some(true) {
        eprintln!("Agents already read these without asking; no card was posted.");
    } else {
        let asked = posted["request"]["secretRefs"]
            .as_array()
            .map_or(0, Vec::len);
        eprintln!(
            "Asked a Space admin, on a card in this Channel, to let Agents read {asked} secret(s) without asking. Nothing changes until it is answered."
        );
    }
    Ok(())
}

const SECRET_REQUEST_WAIT: std::time::Duration = std::time::Duration::from_secs(600);

/// The Space has no such secret yet, or this Run may not read it yet: a card
/// in its Channel can change that.
fn secret_request_still_open(message: &str) -> bool {
    message.contains("is not saved") || message.contains("not configured for this Agent")
}

fn valid_secret_ref(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':' | '/'))
}

fn valid_env_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn local_daemon_request_agent_env() -> Option<(String, String)> {
    daemon_broker_binding_from_values(
        std::env::var(DAEMON_REQUEST_URL_ENV).ok().as_deref(),
        std::env::var(DAEMON_REQUEST_CAPABILITY_ENV).ok().as_deref(),
    )
    .or_else(local_daemon_request_lineage_binding)
}

fn local_daemon_request_lineage_binding() -> Option<(String, String)> {
    daemon_lineage_binding(
        || Some(read_daemon_request_broker_state()?.url),
        |run| run.request_capability.as_deref(),
    )
}

async fn request_local_daemon_request_json<T: for<'de> Deserialize<'de>>(
    base_url: &str,
    capability: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> error::Result<T> {
    let base_url = normalize_daemon_auth_broker_url(base_url)
        .ok_or_else(|| CliError::Launch("invalid daemon request broker URL".into()))?;
    let address = base_url
        .strip_prefix("http://")
        .ok_or_else(|| CliError::Launch("invalid daemon request broker URL".into()))?;
    if address.contains('/') || address.is_empty() {
        return Err(CliError::Launch("invalid daemon request broker URL".into()));
    }
    let socket_addr = address
        .parse::<std::net::SocketAddr>()
        .map_err(|err| CliError::Launch(format!("invalid daemon request broker address: {err}")))?;
    if !socket_addr.ip().is_loopback() {
        return Err(CliError::Launch(
            "daemon request broker URL must be loopback".into(),
        ));
    }
    let url = format!("{base_url}{path}");
    let client = reqwest_client();
    let mut request = match method {
        "POST" => client.post(url),
        _ => client.get(url),
    }
    .header("content-type", "application/json")
    .header("x-xmatrix-request-capability", capability);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    // A daemon older than the typed status lines answers every failure with
    // `200 OK` and an `error` body. Gating on the status alone sent that body
    // into `from_str::<T>` and reported a JSON parse error instead of the
    // reason the daemon had already written down.
    let reported = serde_json::from_str::<Value>(&text).ok().and_then(|value| {
        value
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    if status.is_client_error() || status.is_server_error() || reported.is_some() {
        return Err(CliError::Launch(reported.unwrap_or_else(|| {
            format!("daemon request broker returned {status}")
        })));
    }
    serde_json::from_str(&text).map_err(CliError::Json)
}

async fn request_local_daemon_request_json_with_rediscovery<T: for<'de> Deserialize<'de>>(
    base_url: &str,
    capability: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> error::Result<T> {
    match request_local_daemon_request_json(base_url, capability, method, path, body.clone()).await
    {
        Ok(response) => Ok(response),
        Err(first_error) => {
            if let Some((rediscovered_url, rediscovered_capability)) =
                rediscovered_daemon_auth_binding(
                    base_url,
                    capability,
                    local_daemon_request_lineage_binding(),
                )
            {
                return request_local_daemon_request_json(
                    &rediscovered_url,
                    &rediscovered_capability,
                    method,
                    path,
                    body,
                )
                .await;
            }
            let rediscovered_url = rediscovered_daemon_auth_url(
                base_url,
                read_daemon_request_broker_state()
                    .as_ref()
                    .map(|state| state.url.as_str()),
            );
            let Some(rediscovered_url) = rediscovered_url else {
                return Err(first_error);
            };
            request_local_daemon_request_json(&rediscovered_url, capability, method, path, body)
                .await
        }
    }
}

fn cmd_daemon_doctor(cleanup: bool) -> error::Result<()> {
    if cleanup && !cfg!(unix) {
        return Err(CliError::Launch(
            "daemon doctor --cleanup requires Unix pid checks".into(),
        ));
    }

    println!("xMatrix daemon doctor");
    print_daemon_session_doctor();
    print_daemon_auth_broker_doctor();
    print_daemon_request_broker_doctor();
    print_daemon_update_doctor();
    #[cfg(windows)]
    print_windows_continuity_doctor();

    let registry_path = daemon_run_registry_path();
    println!("run registry: {}", registry_path.display());
    let runs = read_persisted_daemon_run_registry_for_doctor(&registry_path)?;
    if runs.is_empty() {
        println!("  no tracked daemon child runs");
        return Ok(());
    }

    let mut alive_runs = Vec::new();
    let mut dead_count = 0usize;
    let mut cleaned_dead_count = 0usize;
    for run in runs {
        let alive = crate::process_tree::process_alive(run.pid);
        if alive {
            alive_runs.push(run.clone());
        } else {
            dead_count += 1;
            if cleanup {
                match terminate_daemon_pid(run.pid) {
                    Ok(()) => {
                        remove_daemon_run_sidecar(&run);
                        cleaned_dead_count += 1;
                    }
                    Err(err) => {
                        println!(
                            "  cleanup failed for pid {}; retaining registry row: {err}",
                            run.pid
                        );
                        alive_runs.push(run.clone());
                    }
                }
            }
        }
        print_daemon_run_doctor_line(&run, alive);
    }

    if cleanup {
        persist_persisted_daemon_run_registry_for_doctor(&registry_path, &alive_runs)?;
        println!("cleanup: removed {cleaned_dead_count} dead registry row(s)");
    } else if dead_count > 0 {
        println!("cleanup: rerun with `xmatrix daemon doctor --cleanup` to remove dead rows");
    }

    Ok(())
}

#[cfg(windows)]
fn print_windows_continuity_doctor() {
    use xmatrix_windows_continuity::{
        ActivationJournal, ArtifactIdentity, BootJournal, CommandEffectJournal, ContinuityEventLog,
        current_unix_time, verify_signed_artifact,
    };

    let executable = std::env::current_exe().ok();
    let root = executable
        .as_deref()
        .and_then(managed_daemon_executable_root);
    let Some(root) = root else {
        println!("windows continuity: unmanaged CLI location");
        return;
    };
    println!("windows continuity root: {}", root.display());
    let now = current_unix_time().unwrap_or_default();
    let artifact_status = |artifact: &ArtifactIdentity, floor: u64, allow_expired_lkg: bool| {
        verify_signed_artifact(
            artifact,
            now,
            floor,
            Some(&artifact.publisher_sha256),
            allow_expired_lkg,
        )
        .map(|()| "verified".to_string())
        .unwrap_or_else(|error| format!("rejected ({error})"))
    };
    println!(
        "  task/bootstrap: {}",
        if root.join("xmatrix-bootstrap.exe").is_file() {
            "fixed Boot Verifier"
        } else {
            "legacy launcher"
        }
    );
    match BootJournal::new(root.join("boot-journal.json")).load() {
        Ok(boot) => {
            println!("  boot phase: {:?} revision={}", boot.phase, boot.revision);
            println!("  Supervisor committed: {}", boot.committed.sha256);
            println!(
                "  Supervisor envelope/publisher/status: {}/{}/{}",
                boot.committed.release_envelope_sha256,
                boot.committed.publisher_sha256,
                artifact_status(&boot.committed, boot.committed.release_sequence, true)
            );
            println!(
                "  Supervisor pending: {}",
                boot.pending
                    .as_ref()
                    .map(|artifact| artifact.sha256.as_str())
                    .unwrap_or("none")
            );
        }
        Err(error) => println!("  boot journal: unavailable ({error})"),
    }
    match ActivationJournal::new(root.join("activation-journal.json")).load() {
        Ok(activation) => {
            println!("  daemon committed: {}", activation.committed.sha256);
            println!(
                "  daemon envelope/publisher/status: {}/{}/{}",
                activation.committed.release_envelope_sha256,
                activation.committed.publisher_sha256,
                artifact_status(
                    &activation.committed,
                    activation.committed.release_sequence,
                    true,
                )
            );
            println!(
                "  daemon previous/candidate: {}/{}",
                activation
                    .previous
                    .as_ref()
                    .map(|artifact| artifact.sha256.as_str())
                    .unwrap_or("none"),
                activation
                    .candidate
                    .as_ref()
                    .map(|artifact| artifact.sha256.as_str())
                    .unwrap_or("none")
            );
            println!(
                "  transaction: {} phase={} localHubEpoch={}",
                activation
                    .transaction
                    .as_ref()
                    .map(|transaction| transaction.id.as_str())
                    .unwrap_or("none"),
                activation
                    .transaction
                    .as_ref()
                    .map(|transaction| format!("{:?}", transaction.phase))
                    .unwrap_or_else(|| "Stable".into()),
                activation
                    .last_hub_epoch
                    .map(|epoch| epoch.to_string())
                    .unwrap_or_else(|| "unknown".into())
            );
            println!(
                "  generation pins/quarantine: {}/{}",
                activation.pinned_generations().len(),
                activation.quarantined_sha256.len()
            );
        }
        Err(error) => println!("  activation journal: unavailable ({error})"),
    }
    match CommandEffectJournal::new(
        config::profile_state_dir().join("daemon-command-effects-v1.json"),
    )
    .phase_counts()
    {
        Ok(counts) => println!("  command effects: {counts:?}"),
        Err(error) => println!("  command effects: invalid ({error})"),
    }
    match ContinuityEventLog::new(root.join("continuity-events.json")).read() {
        Ok(events) => println!(
            "  continuity events: {} last={}",
            events.len(),
            events
                .last()
                .map(|event| format!("{}:{}:{}", event.sequence, event.component, event.kind))
                .unwrap_or_else(|| "none".into())
        ),
        Err(error) => println!("  continuity events: unavailable ({error})"),
    }
    let lock = std::fs::read_to_string(root.join("supervisor.lock"))
        .ok()
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|| "missing".into());
    println!("  Supervisor: {lock}");
}

fn print_daemon_session_doctor() {
    let config_path = config::config_path();
    let configured = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<config::CliConfig>(&raw).ok());
    let hub_url = if configured
        .as_ref()
        .and_then(|value| value.active_environment.as_deref())
        == Some("test")
    {
        protocol::TEST_HUB_URL
    } else {
        protocol::DEFAULT_HUB_URL
    };
    let session_path = config::session_path_for_hub(hub_url);
    println!("cli session: {}", session_path.display());
    println!("cli config: {}", config_path.display());
    let session = match std::fs::read_to_string(&session_path) {
        Ok(raw) => match serde_json::from_str::<config::CliSession>(&raw) {
            Ok(session) => session,
            Err(err) => {
                println!("  unparseable session: {err}");
                return;
            }
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let raw = match std::fs::read_to_string(&config_path) {
                Ok(raw) => raw,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    println!(
                        "  login state lost: no session file or config file (run xmatrix login or sign in from the xMatrix app)"
                    );
                    return;
                }
                Err(err) => {
                    println!("  unreadable config: {err}");
                    return;
                }
            };
            let config: config::CliConfig = match serde_json::from_str(&raw) {
                Ok(config) => config,
                Err(err) => {
                    println!("  unparseable config: {err}");
                    return;
                }
            };
            match config.session {
                Some(session) => session,
                None => {
                    println!(
                        "  login state lost: no session file and no legacy session in config (run xmatrix login or sign in from the xMatrix app)"
                    );
                    return;
                }
            }
        }
        Err(err) => {
            println!("  unreadable session: {err}");
            return;
        }
    };

    let now = config::unix_now_secs();
    let expires_at = session.expires_at.parse::<u64>().unwrap_or(0);
    let updated_at = session.updated_at.parse::<u64>().unwrap_or(0);
    println!(
        "  user: {} <{}>",
        session.user.name.as_deref().unwrap_or("?"),
        session.user.email
    );
    println!(
        "  token: {}",
        if session.token.is_empty() {
            "missing"
        } else {
            "present"
        }
    );
    println!(
        "  refresh token: {}",
        if session.refresh_token.as_deref().unwrap_or("").is_empty() {
            "missing"
        } else {
            "present"
        }
    );
    if updated_at > 0 {
        println!(
            "  updated: {} ({} ago)",
            updated_at,
            human_secs_span(now.saturating_sub(updated_at))
        );
    }
    if expires_at == 0 {
        println!(
            "  expires: unknown — login state lost (run xmatrix login or sign in from the xMatrix app)"
        );
    } else if expires_at <= now {
        println!(
            "  expires: {} — EXPIRED {} ago: login state lost (run xmatrix login or sign in from the xMatrix app)",
            expires_at,
            human_secs_span(now.saturating_sub(expires_at))
        );
    } else {
        println!(
            "  expires: {} (valid for {})",
            expires_at,
            human_secs_span(expires_at.saturating_sub(now))
        );
    }
}

fn human_secs_span(secs: u64) -> String {
    let days = secs / 86_400;
    let hours = (secs % 86_400) / 3_600;
    let minutes = (secs % 3_600) / 60;
    if days > 0 {
        format!("{days}d {hours}h")
    } else if hours > 0 {
        format!("{hours}h {minutes}m")
    } else {
        format!("{minutes}m")
    }
}

fn print_daemon_auth_broker_doctor() {
    let path = daemon_auth_broker_state_path();
    println!("auth broker state: {}", path.display());
    let Some(state) = read_daemon_auth_broker_state() else {
        println!("  missing");
        return;
    };
    println!("  url: {}", state.url);
    println!(
        "  live session reload: {}",
        if state.session_reload_capability.is_some() {
            "supported"
        } else {
            "unsupported (restart after updating daemon)"
        }
    );
    println!("  updatedAt: {}", state.updated_at);
    match daemon_auth_broker_reachable(&state.url) {
        Ok(()) => println!("  reachable: yes"),
        Err(err) => println!("  reachable: no ({err})"),
    }
}

fn print_daemon_request_broker_doctor() {
    let path = daemon_request_broker_state_path();
    println!("request broker state: {}", path.display());
    let Some(state) = read_daemon_request_broker_state() else {
        println!("  missing");
        return;
    };
    println!("  url: {}", state.url);
    println!("  owner capability: present");
    println!("  updatedAt: {}", state.updated_at);
    match daemon_auth_broker_reachable(&state.url) {
        Ok(()) => println!("  reachable: yes"),
        Err(err) => println!("  reachable: no ({err})"),
    }
}

fn print_daemon_update_doctor() {
    let ready_path = daemon_ready_state_path();
    println!("daemon ready state: {}", ready_path.display());
    match std::fs::read(&ready_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    {
        Some(ready) => {
            println!(
                "  version: {}",
                ready.get("version").and_then(Value::as_str).unwrap_or("?")
            );
            println!(
                "  pid: {}",
                ready.get("pid").and_then(Value::as_u64).unwrap_or(0)
            );
            println!(
                "  executable: {}",
                ready
                    .get("executablePath")
                    .and_then(Value::as_str)
                    .unwrap_or("?")
            );
            println!(
                "  updatedAt: {}",
                ready
                    .get("updatedAt")
                    .and_then(Value::as_str)
                    .unwrap_or("?")
            );
        }
        None => println!("  missing or invalid"),
    }

    let receipt_path = config::config_dir().join("daemon-update-receipt.json");
    println!("daemon update receipt: {}", receipt_path.display());
    match std::fs::read(&receipt_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    {
        Some(receipt) => {
            println!(
                "  status: {}",
                receipt.get("status").and_then(Value::as_str).unwrap_or("?")
            );
            println!(
                "  version: {}",
                receipt
                    .get("version")
                    .and_then(Value::as_str)
                    .unwrap_or("?")
            );
            println!(
                "  updatedAt: {}",
                receipt
                    .get("updatedAt")
                    .and_then(Value::as_str)
                    .unwrap_or("?")
            );
            if let Some(error) = receipt.get("error").and_then(Value::as_str) {
                println!("  error: {error}");
            }
        }
        None => println!("  unavailable on this installation or no update has completed"),
    }
}

fn print_daemon_run_doctor_line(run: &PersistedDaemonRun, alive: bool) {
    let key = persisted_daemon_run_key(run);
    let agent = run.agent_name.as_deref().unwrap_or("unknown");
    let auth = if run.auth_capability.is_some() {
        "present"
    } else {
        "missing"
    };
    let request = if run.request_capability.is_some() {
        "present"
    } else {
        "missing"
    };
    let status = read_daemon_run_status_marker(run.status_file_path.as_deref())
        .map(|marker| marker.phase)
        .unwrap_or_else(|| "unknown".to_string());
    println!(
        "  - {key} pid={} alive={} agent={} authCapability={} requestCapability={} status={}",
        run.pid,
        if alive { "yes" } else { "no" },
        agent,
        auth,
        request,
        status
    );
    if let Some(detail) = daemon_run_capability_env_doctor_detail(run) {
        println!("    capability env: {detail}");
    }
    #[cfg(windows)]
    println!(
        "    continuity: {}",
        run.status_file_path
            .as_deref()
            .and_then(|path| runtime_windows_run_adoption::read_evidence(path).ok())
            .map(|evidence| format!(
                "v2 birth={} digest={} job=verified-on-adoption",
                evidence.process_birth_id, evidence.executable_sha256
            ))
            .unwrap_or_else(|| "legacy/defer".into())
    );
    if let Some(path) = run.stderr_log_path.as_ref() {
        println!("    stderr: {}", path.display());
    }
}

fn daemon_run_capability_env_doctor_detail(run: &PersistedDaemonRun) -> Option<String> {
    let env_run_id = std::env::var("XMATRIX_RUN_ID").ok()?;
    let env_execution_key = std::env::var("XMATRIX_EXECUTION_KEY").ok()?;
    if run.run_id.as_deref() != Some(env_run_id.trim())
        || run.execution_key.as_deref() != Some(env_execution_key.trim())
    {
        return None;
    }
    let env_capability = non_empty_env(DAEMON_REQUEST_CAPABILITY_ENV);
    let registry_capability = run
        .request_capability
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    match (env_capability.as_deref(), registry_capability.as_deref()) {
        (None, None) => Some("env and registry request capability both missing".into()),
        (None, Some(_)) => Some(
            "env request capability missing; registry verifier key present (send rediscovery can restore)"
                .into(),
        ),
        (Some(_), None) => Some(
            "env request capability present; registry verifier key missing (grant was not restored)"
                .into(),
        ),
        (Some(env), Some(registry)) if env == registry => {
            Some("env matches registry request capability".into())
        }
        (Some(_), Some(_)) => Some(
            "env request capability differs from registry verifier key (stale after xmatrix update; send rediscovers)"
                .into(),
        ),
    }
}

fn read_persisted_daemon_run_registry_for_doctor(
    path: &Path,
) -> error::Result<Vec<PersistedDaemonRun>> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => {
            return Err(CliError::Launch(format!(
                "failed to read daemon run registry: {err}"
            )));
        }
    };
    serde_json::from_str::<Vec<PersistedDaemonRun>>(&text)
        .map_err(|err| CliError::Launch(format!("failed to parse daemon run registry: {err}")))
}

fn persist_persisted_daemon_run_registry_for_doctor(
    path: &Path,
    runs: &[PersistedDaemonRun],
) -> error::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| {
            CliError::Launch(format!(
                "failed to create daemon run registry directory: {err}"
            ))
        })?;
    }
    let bytes = serde_json::to_vec_pretty(runs)?;
    let tmp_path = config::unique_temporary_path(path);
    if let Err(err) = write_daemon_private_file(&tmp_path, &bytes)
        .and_then(|()| config::replace_file_atomically(&tmp_path, path))
    {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(CliError::Launch(format!(
            "failed to persist daemon run registry: {err}"
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn managed_daemon_executable_root(executable: &Path) -> Option<&Path> {
    executable.ancestors().find(|ancestor| {
        ancestor
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("xmatrix-daemon"))
    })
}
