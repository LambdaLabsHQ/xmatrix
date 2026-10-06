async fn cmd_external(
    hub_url: &str,
    token_override: Option<&str>,
    args: Vec<String>,
) -> error::Result<()> {
    write_current_run_status("wrapper_starting", false, None);
    match cmd_external_inner(hub_url, token_override, args).await {
        Ok(()) => Ok(()),
        Err(err) => {
            if env_flag("XMATRIX_HEADLESS") {
                write_current_run_error_status("wrapper_startup_failed", true, &err);
            }
            Err(err)
        }
    }
}

async fn cmd_external_inner(
    hub_url: &str,
    token_override: Option<&str>,
    args: Vec<String>,
) -> error::Result<()> {
    let (cmd, cmd_args) = args
        .split_first()
        .ok_or_else(|| CliError::Launch("No command provided".into()))?;
    // Every Agent Run is a Run of a Space registration, started by the daemon
    // when the Agent is summoned. A hand-started runtime has no Run to join as.
    if std::env::var("XMATRIX_RUN_ID").map_or(true, |run| run.trim().is_empty()) {
        return Err(CliError::Launch(format!(
            "`xmatrix {cmd}` runs only as a daemon-started Agent Run. Add this harness with `xmatrix agent add <harness> --space <space-id>`, then summon it in a Channel with `@<harness>`."
        )));
    }
    if token_override.is_some() {
        return Err(CliError::Auth(
            "Agent execution context: explicit bearer token overrides are forbidden".into(),
        ));
    }

    // `run` already refused a nested runtime before any status write.
    let tool = cmd.rsplit('/').next().unwrap_or(cmd);

    write_current_run_status("cwd_preparing", false, None);
    let prepared_spawn_cwd = prepare_headless_spawn_cwd()?;
    if let Some(path) = prepared_spawn_cwd.as_ref() {
        write_current_run_status(
            "cwd_ready",
            false,
            Some(&format!("working directory: {}", path.display())),
        );
    }

    write_current_run_status("auth_resolving", false, None);
    // A daemon-started Run authenticates only through its daemon's run-scoped
    // broker; it never falls back to an Owner session.
    let token = resolve_daemon_auth_token_for_cli_command()
        .await?
        .ok_or_else(|| {
            CliError::Auth(
                "Agent execution context: run-scoped daemon auth is required; refusing Owner session fallback"
                    .into(),
            )
        })?;
    let relay_url = agent_instance_connection::derive_connection_url(
        &xmatrix_cli_core::human_connection::derive_connection_url(hub_url),
    );

    let agent_name_base = build_agent_name(tool);
    let agent_type = agent_type_for_runtime(tool);
    ensure_runtime_supports_trusted_role(
        tool,
        selected_runtime_supports_trusted_role(tool, cmd, cmd_args),
        trusted_role_is_active(),
    )?;

    let cwd_path = external_registration_cwd(prepared_spawn_cwd.as_deref());
    let cwd = cwd_path.as_ref().map(|p| p.to_string_lossy().to_string());
    let machine_id = config::get_or_create_machine_id(hub_url).await?;

    write_current_run_status("workspace_registering", false, cwd.as_deref());
    // When the daemon provides a natural workspace reference (direct in-place
    // routing or a materialized run worktree's base workspace), the child must not
    // auto-register its cwd. The same holds for any linked git worktree cwd
    // (Codex App thread checkouts, ad-hoc `git worktree add` dirs): execution
    // sites never masquerade as registered records.
    let daemon_workspace = run_worktree::daemon_provided_workspace();
    let daemon_workspace_name = non_empty_env(run_worktree::SPAWN_WORKSPACE_NAME_ENV);
    let cwd_is_linked_worktree = daemon_workspace.is_none()
        && cwd_path
            .as_deref()
            .map(run_worktree::is_linked_git_worktree)
            .unwrap_or(false);
    let registered_workspace = if daemon_workspace.is_some() {
        None
    } else if cwd_is_linked_worktree {
        eprintln!(
            "{} skipping workspace auto-registration: cwd is a linked git worktree (execution site)",
            "○".cyan().bold()
        );
        None
    } else if let Some(path) = cwd_path.as_ref() {
        match upsert_workspace(hub_url, &token, path, None, Some(tool)).await {
            Ok(workspace) => Some(workspace),
            Err(err) => {
                eprintln!(
                    "{} workspace auto-registration failed: {err}",
                    "⚠".yellow().bold()
                );
                None
            }
        }
    } else {
        None
    };
    let metadata_workspace_machine_id = daemon_workspace
        .as_ref()
        .map(|workspace| workspace.machine_id.clone())
        .or_else(|| {
            registered_workspace
                .as_ref()
                .map(|workspace| workspace.machine_id.clone())
        });
    let metadata_workspace_cwd = daemon_workspace
        .as_ref()
        .map(|workspace| workspace.canonical_cwd.clone())
        .or_else(|| {
            registered_workspace
                .as_ref()
                .map(|workspace| workspace.canonical_cwd.clone())
        });
    let metadata_workspace_name = daemon_workspace_name.or_else(|| {
        registered_workspace
            .as_ref()
            .map(|workspace| workspace.display_name.clone())
    });

    let mut metadata = serde_json::json!({
        "tool": tool,
        "toolArgs": cmd_args,
        "xmatrixCliVersion": xmatrix_cli_core::version::current(),
        "cwd": cwd,
        "gitBranch": cwd_path.as_deref().and_then(current_git_branch),
        "machineId": machine_id,
        "hostname": observed_hostname(),
        "workspaceMachineId": metadata_workspace_machine_id,
        "workspaceCwd": metadata_workspace_cwd,
        "workspaceName": metadata_workspace_name,
        "runWorktreeBaseRef": std::env::var(run_worktree::RUN_WORKTREE_BASE_REF_ENV).ok(),
        "runId": std::env::var("XMATRIX_RUN_ID").ok(),
        "autoJoinChannelId": std::env::var("XMATRIX_AUTO_JOIN_CHANNEL_ID").ok(),
        "launcherId": std::env::var("XMATRIX_LAUNCHER_ID").ok(),
        "materializerId": std::env::var("XMATRIX_MATERIALIZER_ID").ok(),
        "executionKey": std::env::var("XMATRIX_EXECUTION_KEY").ok(),
        "previousInstanceId": std::env::var("XMATRIX_RESUME_INSTANCE_ID").ok(),
    });
    if let Ok(preset_id) = std::env::var("XMATRIX_AGENT_PRESET_ID") {
        metadata["presetId"] = serde_json::json!(preset_id);
    }
    if let Ok(backend) = std::env::var("XMATRIX_AGENT_BACKEND") {
        metadata["backend"] = serde_json::json!(backend);
    }

    let agent_name = agent_name_base;
    let mut relay = agent_instance_connection::AgentInstanceConnectionClient::new(
        relay_url.clone(),
        token.clone(),
        agent_name.clone(),
        agent_type.clone(),
        Some(metadata.clone()),
    );
    let mut runtime_capabilities = goal_runtime_capabilities(tool, cmd, cmd_args);
    runtime_capabilities.push("harness_parameters_v1".to_string());
    relay.set_runtime_capabilities(runtime_capabilities);
    let auto_join_channel_id = non_empty_env("XMATRIX_AUTO_JOIN_CHANNEL_ID");
    // Every backend receives the channel through its own delivery, so the join
    // replays no history as channel turns.
    let history_limit = 0;
    write_current_run_status("relay_registering", false, None);
    // A newly woken instance joins with limit 0 and would otherwise start blind
    // to everything the channel has already decided. Read the channel once,
    // before the backend builds its first prompt. A positive limit already
    // replays the recent messages as channel turns, so the bootstrap stands
    // down for that launch. The read runs while the Hub registers this
    // instance: both are seconds long and independent, and only the join has
    // to wait for the read.
    let prime_history = async {
        if let Some(channel_id) = auto_join_channel_id.as_deref() {
            runtime_channel_history_bootstrap::prime_channel_history_bootstrap(
                hub_url,
                &token,
                channel_id,
                history_limit,
            )
            .await;
        }
    };
    let register = async {
        let registered = register_long_lived_relay(&mut relay, "agent", true).await?;
        write_current_run_status("relay_registered", false, Some(&registered.0.name));
        eprintln!(
            "{} Registered as {} ({})",
            "✓".green().bold(),
            registered.0.name,
            registered.0.id.dimmed()
        );
        Ok::<_, CliError>(registered)
    };
    let (agent, _initial_agents) =
        runtime_channel_history_bootstrap::register_while_priming(register, prime_history).await?;
    let _sleep_guard = MacosSleepGuard::acquire("xMatrix agent");
    let event_rx = relay.event_rx.take().unwrap();

    if let Some(channel_id) = auto_join_channel_id {
        join_long_lived_initial_channel(&relay, channel_id, history_limit).await?;
    }
    // Registered with the Hub and in the channel: this wrapper is serving. A
    // live-update handoff waits for this stamp before retiring the wrapper
    // being replaced, so a replacement that dies on the way here leaves the
    // working wrapper in place instead of muting the run.
    mark_daemon_run_wrapper_ready();

    let backend = if use_codex_app_backend(tool) {
        ExternalBackend::CodexApp
    } else if use_zcode_app_backend(tool) {
        ExternalBackend::ZcodeApp
    } else if use_grok_app_backend(tool) {
        ExternalBackend::GrokAcp
    } else if use_acp_backend() {
        // Generic ACP backend (e.g. Kimi Code via `kimi acp`), driven by
        // XMATRIX_AGENT_BACKEND=acp / *-acp. PTY remains the last-resort
        // fallback for tools without an ACP or app-server adapter.
        ExternalBackend::Acp
    } else if use_claude_print_backend(&agent, tool, cmd, cmd_args) {
        ExternalBackend::ClaudePrint
    } else {
        ExternalBackend::Headless
    };
    if backend == ExternalBackend::Headless
        && read_initial_spawn_context_from_env()
            .and_then(|context| context.requested_parameters)
            .is_some_and(|p| !p.is_empty())
    {
        return Err(CliError::Launch(
            "This runtime does not advertise a parameter control interface".into(),
        ));
    }
    if matches!(
        backend,
        ExternalBackend::ClaudePrint | ExternalBackend::Headless
    ) {
        send_presence(
            &relay,
            None,
            PresencePatch::default().parameters(Vec::new()),
        );
    }
    let relay = Arc::new(relay);
    let token_refresh_handle = spawn_daemon_auth_token_refresh(relay.clone(), backend.label());
    let run = ExternalRun {
        tool,
        cmd,
        cmd_args,
        hub_url,
        cwd: cwd.as_deref(),
        relay,
        event_rx,
        agent,
    };
    let result = match backend {
        ExternalBackend::CodexApp => run_codex_app_external(run).await,
        ExternalBackend::ZcodeApp => run_zcode_app_external(run).await,
        ExternalBackend::GrokAcp => run_grok_app_external(run).await,
        ExternalBackend::Acp => run_acp_app_external(AcpVendorConfig::generic(tool), run).await,
        ExternalBackend::ClaudePrint => run_claude_print_external(run).await,
        ExternalBackend::Headless => run_headless_external(run).await,
    };
    token_refresh_handle.abort();
    result
}

/// The backend an external runtime is served by, chosen once per launch.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ExternalBackend {
    CodexApp,
    ZcodeApp,
    GrokAcp,
    Acp,
    ClaudePrint,
    Headless,
}

impl ExternalBackend {
    /// The name the daemon auth refresher logs this backend under.
    fn label(self) -> &'static str {
        match self {
            Self::CodexApp => "codex app",
            Self::ZcodeApp => "zcode app",
            Self::GrokAcp => "grok acp",
            Self::Acp => "acp agent",
            Self::ClaudePrint | Self::Headless => "headless agent",
        }
    }
}

/// Everything a backend run loop is handed once the wrapper has registered
/// and joined its channel.
pub(crate) struct ExternalRun<'a> {
    pub(crate) tool: &'a str,
    pub(crate) cmd: &'a str,
    pub(crate) cmd_args: &'a [String],
    pub(crate) hub_url: &'a str,
    pub(crate) cwd: Option<&'a str>,
    pub(crate) relay: Arc<agent_instance_connection::AgentInstanceConnectionClient>,
    pub(crate) event_rx:
        mpsc::UnboundedReceiver<agent_instance_connection::AgentInstanceConnectionEvent>,
    pub(crate) agent: protocol::SerializedAgent,
}

fn default_downstream_kkp_flags(tool: &str) -> u32 {
    if tool.eq_ignore_ascii_case("codex") || tool.eq_ignore_ascii_case("codex.exe") {
        1
    } else {
        0
    }
}

async fn resolve_auth_token(token_override: Option<&str>, hub_url: &str) -> error::Result<String> {
    if let Some(token) = token_override {
        if xmatrix_cli_channel::running_inside_agent_execution_context() {
            return Err(CliError::Auth(
                "Agent execution context: explicit bearer token overrides are forbidden".into(),
            ));
        }
        return Ok(token.to_string());
    }

    if let Some(token) = resolve_daemon_auth_token_for_cli_command().await? {
        return Ok(token);
    }

    // Credential isolation: an agent run shares the launching user's OS account,
    // so it must never authenticate with the human's saved session. Inside an
    // agent execution context the only sanctioned Hub credential is the
    // run-scoped daemon auth broker resolved above; if that is unavailable we
    // fail closed instead of impersonating the launching user.
    if xmatrix_cli_channel::running_inside_agent_execution_context() {
        return Err(CliError::Auth(
            "Agent execution context: refusing to authenticate with the launching user's saved \
             session. Agents may only use the run-scoped daemon auth broker \
             (XMATRIX_DAEMON_AUTH_URL / XMATRIX_DAEMON_AUTH_CAPABILITY)."
                .into(),
        ));
    }

    let session = resolve_cli_session_for_hub(None, hub_url).await?;
    session
        .map(|saved| saved.token)
        .ok_or_else(|| CliError::Auth("Not logged in. Run: xmatrix login".into()))
}

async fn resolve_daemon_auth_token_for_cli_command() -> error::Result<Option<String>> {
    match resolve_local_daemon_auth_token().await {
        Ok(token) => Ok(token),
        Err(err) if is_local_daemon_auth_fallback_candidate(&err) => Ok(None),
        Err(err) => Err(err),
    }
}

fn is_local_daemon_auth_unavailable(err: &CliError) -> bool {
    matches!(
        err,
        CliError::Auth(message) if message.starts_with("Local daemon auth broker unavailable:")
    )
}

fn is_local_daemon_auth_rejected(err: &CliError) -> bool {
    matches!(
        err,
        CliError::Auth(message) if message == "unauthorized"
    )
}

fn is_local_daemon_auth_fallback_candidate(err: &CliError) -> bool {
    is_local_daemon_auth_unavailable(err)
        || is_local_daemon_auth_rejected(err)
        || matches!(
            err,
            CliError::Auth(message) if message.starts_with("Malformed local daemon auth response")
        )
}

async fn resolve_cli_session(token_override: Option<&str>) -> error::Result<Option<CliSession>> {
    let hub_url = config::active_hub_url().await;
    resolve_cli_session_for_hub(token_override, &hub_url).await
}

async fn resolve_cli_session_for_hub(
    token_override: Option<&str>,
    hub_url: &str,
) -> error::Result<Option<CliSession>> {
    if token_override.is_some() {
        return Ok(None);
    }

    let session = config::load_session_for_hub(hub_url)
        .await
        .ok_or_else(|| CliError::Auth("Not logged in. Run: xmatrix login".into()))?;

    ensure_session_not_expired(&session)?;

    if !session_needs_refresh(&session) {
        return Ok(Some(session));
    }

    auth::refresh_cli_session(&session).await.map(Some)
}

async fn resolve_local_daemon_auth_token() -> error::Result<Option<String>> {
    let Some((url, capability)) = local_daemon_auth_env() else {
        return Ok(None);
    };
    match request_local_daemon_auth_token(&url, &capability).await {
        Ok(token) => Ok(Some(token)),
        Err(err) if is_local_daemon_auth_fallback_candidate(&err) => {
            // A daemon replacement rotates the loopback broker. Prefer a
            // legacy exact-lineage raw capability when present; otherwise the
            // surviving wrapper's raw proof is checked against the recovered
            // one-way verifier at the replacement broker.
            if let Some((rediscovered_url, rediscovered_capability)) =
                rediscovered_daemon_auth_binding(
                    &url,
                    &capability,
                    local_daemon_auth_lineage_binding(),
                )
            {
                return request_local_daemon_auth_token(
                    &rediscovered_url,
                    &rediscovered_capability,
                )
                .await
                .map(Some);
            }
            let rediscovered_url = rediscovered_daemon_auth_url(
                &url,
                read_daemon_auth_broker_state()
                    .as_ref()
                    .map(|state| state.url.as_str()),
            );
            let Some(rediscovered_url) = rediscovered_url else {
                return Err(err);
            };
            request_local_daemon_auth_token(&rediscovered_url, &capability)
                .await
                .map(Some)
        }
        Err(err) => Err(err),
    }
}

async fn resolve_local_daemon_auth_token_for_refresh() -> error::Result<Option<String>> {
    match resolve_local_daemon_auth_token().await {
        Ok(token) => Ok(token),
        Err(err)
            if is_local_daemon_auth_rejected(&err)
                && !xmatrix_cli_channel::running_inside_agent_execution_context() =>
        {
            match resolve_cli_session(None).await {
                Ok(session) => Ok(session.map(|saved| saved.token)),
                Err(_) => Err(err),
            }
        }
        Err(err) => Err(err),
    }
}

fn local_daemon_auth_env() -> Option<(String, String)> {
    daemon_broker_binding_from_values(
        std::env::var(DAEMON_AUTH_URL_ENV).ok().as_deref(),
        std::env::var(DAEMON_AUTH_CAPABILITY_ENV).ok().as_deref(),
    )
    .or_else(local_daemon_auth_lineage_binding)
}

/// A daemon broker binding from its URL and capability, when both are set.
fn daemon_broker_binding_from_values(
    url: Option<&str>,
    capability: Option<&str>,
) -> Option<(String, String)> {
    let url = url.and_then(normalize_daemon_auth_broker_url)?;
    let capability = capability
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())?;
    Some((url, capability))
}

fn local_daemon_auth_lineage_binding() -> Option<(String, String)> {
    daemon_lineage_binding(
        || Some(read_daemon_auth_broker_state()?.url),
        |run| run.auth_capability.as_deref(),
    )
}

/// The broker binding a Run inherits through its ancestor Run's sidecar, for
/// when its own environment no longer names one.
fn daemon_lineage_binding(
    broker_url: impl FnOnce() -> Option<String>,
    capability_of: fn(&PersistedDaemonRun) -> Option<&str>,
) -> Option<(String, String)> {
    let ancestor_pid = xmatrix_cli_channel::persisted_daemon_agent_run_ancestor_pid()?;
    let runs = read_daemon_run_sidecars_from_dir(&daemon_run_log_dir())
        .into_iter()
        .filter(daemon_run_sidecar_is_recoverable)
        .collect::<Vec<_>>();
    select_daemon_lineage_binding(ancestor_pid, &runs, &broker_url()?, capability_of)
}

fn select_daemon_lineage_binding(
    ancestor_pid: u32,
    runs: &[PersistedDaemonRun],
    broker_url: &str,
    capability_of: fn(&PersistedDaemonRun) -> Option<&str>,
) -> Option<(String, String)> {
    let url = normalize_daemon_auth_broker_url(broker_url)?;
    // Sidecars persist one-way verifier keys (`sha256:…`). Older rows may still
    // hold a raw capability. Either shape is enough to re-authorize the same
    // live Run after a daemon replacement — filtering out the verifier key is
    // what made post-update rediscovery dead in production (#2547).
    let mut capabilities = runs
        .iter()
        .filter(|run| run.pid == ancestor_pid)
        .filter_map(capability_of)
        .map(str::trim)
        .filter(|capability| !capability.is_empty())
        .collect::<Vec<_>>();
    capabilities.sort_unstable();
    capabilities.dedup();
    match capabilities.as_slice() {
        [capability] => Some((url, (*capability).to_string())),
        _ => None,
    }
}

fn normalize_daemon_auth_broker_url(value: &str) -> Option<String> {
    let value = value.trim().trim_end_matches('/').to_string();
    if value.is_empty() { None } else { Some(value) }
}

fn rediscovered_daemon_auth_url(current_url: &str, state_url: Option<&str>) -> Option<String> {
    let current_url = normalize_daemon_auth_broker_url(current_url)?;
    let state_url = state_url.and_then(normalize_daemon_auth_broker_url)?;
    if state_url == current_url {
        None
    } else {
        Some(state_url)
    }
}

fn rediscovered_daemon_auth_binding(
    current_url: &str,
    current_capability: &str,
    candidate: Option<(String, String)>,
) -> Option<(String, String)> {
    let current_url = normalize_daemon_auth_broker_url(current_url)?;
    let current_capability = current_capability.trim();
    let (candidate_url, candidate_capability) = candidate?;
    let candidate_url = normalize_daemon_auth_broker_url(&candidate_url)?;
    let candidate_capability = candidate_capability.trim().to_string();
    if candidate_capability.is_empty()
        || (candidate_url == current_url && candidate_capability == current_capability)
    {
        None
    } else {
        Some((candidate_url, candidate_capability))
    }
}

async fn request_local_daemon_auth_token(url: &str, capability: &str) -> error::Result<String> {
    tokio::time::timeout(
        Duration::from_secs(10),
        request_local_daemon_auth_token_inner(url, capability),
    )
    .await
    .map_err(|_| CliError::Auth("Local daemon auth request timed out".into()))?
}

/// Prefer the daemon's Unix socket when it has recorded one.
///
/// A socket path survives the restart that changes the port, and the daemon
/// guards it with file mode plus the peer's uid. TCP stays reachable so a
/// daemon that predates socket support, or one whose socket could not be
/// opened, still answers — and a socket that refuses is reported rather than
/// silently skipped.
#[cfg(unix)]
async fn recorded_auth_socket() -> Option<tokio::net::UnixStream> {
    if config::agent_cli_hub().is_some() {
        return None;
    }
    let record = match xmatrix_cli_core::daemon_record::read_record_for_active_profile() {
        Ok(record) => record?,
        Err(error) => {
            eprintln!("⚠ daemon record unusable, using the TCP auth broker: {error}");
            return None;
        }
    };
    let path = record.auth_broker_socket?;
    match tokio::net::UnixStream::connect(&path).await {
        Ok(stream) => Some(stream),
        Err(error) => {
            eprintln!("⚠ daemon auth socket {path} unavailable, using TCP: {error}");
            None
        }
    }
}

async fn request_local_daemon_auth_token_inner(
    url: &str,
    capability: &str,
) -> error::Result<String> {
    let address = url
        .strip_prefix("http://")
        .ok_or_else(|| CliError::Auth("Invalid daemon auth broker URL".into()))?;
    if address.contains('/') || address.is_empty() {
        return Err(CliError::Auth("Invalid daemon auth broker URL".into()));
    }

    #[cfg(unix)]
    let socket = recorded_auth_socket().await;
    #[cfg(not(unix))]
    let socket: Option<tokio::net::TcpStream> = None;
    request_local_daemon_auth_token_over(socket, address, capability).await
}

/// Ask the recorded socket first, then the broker the Run was given.
///
/// The socket and the TCP address are only the same broker while one daemon
/// runtime serves both. Across a profile restart the socket can still belong
/// to the runtime that is going away, which never issued this Run's grant and
/// answers 401. That refusal is not the Run's verdict: the URL in its
/// environment names the broker that actually holds the grant, so ask it
/// before giving up on daemon auth.
async fn request_local_daemon_auth_token_over<S>(
    socket: Option<S>,
    address: &str,
    capability: &str,
) -> error::Result<String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    if let Some(stream) = socket {
        match auth_token_over_stream(stream, "localhost", capability).await {
            Err(error) if is_local_daemon_auth_rejected(&error) => {
                eprintln!(
                    "⚠ the recorded daemon auth socket does not hold this Run's grant; asking the broker at {address}"
                );
            }
            answered => return answered,
        }
    }

    let stream = tokio::net::TcpStream::connect(address)
        .await
        .map_err(|err| CliError::Auth(format!("Local daemon auth broker unavailable: {err}")))?;
    auth_token_over_stream(stream, address, capability).await
}

/// One request/response implementation for either transport.
async fn auth_token_over_stream<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    mut stream: S,
    address: &str,
    capability: &str,
) -> error::Result<String> {
    #[derive(Deserialize)]
    struct TokenResponse {
        token: Option<String>,
        error: Option<String>,
    }

    let request = format!(
        "GET /auth/token HTTP/1.1\r\nhost: {address}\r\nx-xmatrix-auth-capability: {capability}\r\naccept: application/json\r\nconnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|err| CliError::Auth(format!("Local daemon auth request failed: {err}")))?;
    stream
        .flush()
        .await
        .map_err(|err| CliError::Auth(format!("Local daemon auth request failed: {err}")))?;

    let (status, body) =
        xmatrix_cli_core::local_http_response::read_local_http_response(&mut stream).await?;
    let payload: TokenResponse = serde_json::from_slice(&body)
        .map_err(|_| CliError::Auth("Malformed local daemon auth payload".into()))?;
    let status_ok = status == 200;
    if !status_ok {
        return Err(CliError::Auth(
            payload
                .error
                .unwrap_or_else(|| "Local daemon auth failed".into()),
        ));
    }
    payload
        .token
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| CliError::Auth("Local daemon auth response missing token".into()))
}

fn session_needs_refresh(session: &CliSession) -> bool {
    if session.refresh_token.is_none() {
        return false;
    }

    let updated_at = session.updated_at.parse::<u64>().unwrap_or(0);
    let age_secs = config::unix_now_secs().saturating_sub(updated_at);
    age_secs >= ACCESS_TOKEN_REFRESH_AGE_SECS
}

fn ensure_session_not_expired(session: &CliSession) -> error::Result<()> {
    let expires_at = session.expires_at.parse::<u64>().unwrap_or(0);
    let now = config::unix_now_secs();

    if expires_at > now {
        return Ok(());
    }

    Err(CliError::Auth(format!(
        "Session expired after {} days. Run: xmatrix login",
        config::SESSION_MAX_AGE_SECS / 86_400
    )))
}

fn connected_token_refresh_sleep_secs(session: &CliSession, now: u64) -> u64 {
    let expires_at = session.expires_at.parse::<u64>().unwrap_or(0);
    let remaining = expires_at.saturating_sub(now);
    if session.refresh_token.is_none() {
        return CONNECTED_TOKEN_REFRESH_INTERVAL_SECS.min(remaining).max(1);
    }
    CONNECTED_TOKEN_REFRESH_INTERVAL_SECS
        .min(remaining.saturating_sub(SESSION_REFRESH_EXPIRY_MARGIN_SECS))
}

/// Consecutive token refreshes the Hub must answer "Run not found" before the
/// wrapper treats its Run as gone. One answer can race a daemon restart; two,
/// a full refresh interval apart, mean nothing will ever reissue the token.
const RUN_GONE_REFRESH_LIMIT: u32 = 2;

#[derive(Default)]
struct RunGoneTracker {
    consecutive: u32,
}

impl RunGoneTracker {
    fn reset(&mut self) {
        self.consecutive = 0;
    }

    /// Record one refresh failure; true once the Run is gone for good.
    fn observe(&mut self, err: &error::CliError) -> bool {
        if err.to_string().contains("Run not found") {
            self.consecutive += 1;
        } else {
            self.consecutive = 0;
        }
        self.consecutive >= RUN_GONE_REFRESH_LIMIT
    }
}

/// A Run the Hub no longer knows can never receive a turn again. Exit through
/// the normal shutdown path instead of idling as a process that looks alive.
fn shut_down_orphaned_run(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    err: &error::CliError,
) {
    let _ = relay.local_event_sender().send(
        agent_instance_connection::AgentInstanceConnectionEvent::Server(
            protocol::AgentInstanceServerMessage::ShutdownRequested {
                reason: Some(format!(
                    "{err}; this Agent Run no longer exists, so the wrapper is exiting"
                )),
            },
        ),
    );
}

/// Consecutive refreshes the local daemon must refuse before the Run's
/// Channel is told. One refusal can race a replacement daemon restoring its
/// grants; two, a retry interval apart, outlast that restore pass.
const LOCAL_AUTHORITY_LOSS_LIMIT: u32 = 2;

/// Wakes the token refresh loop early when something else in this wrapper has
/// already seen the daemon refuse the Run. Agent-run tokens live ten minutes
/// and refresh every eight; waiting for the next scheduled refresh can leave
/// too little of the current token to reach the Channel with a notice.
static LOCAL_AUTHORITY_PROBE: tokio::sync::Notify = tokio::sync::Notify::const_new();

fn probe_local_authority_now() {
    LOCAL_AUTHORITY_PROBE.notify_one();
}

async fn wait_for_daemon_auth_refresh(sleep_secs: u64) {
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs(sleep_secs)) => {}
        _ = LOCAL_AUTHORITY_PROBE.notified() => {}
    }
}

/// Tells the Run's Channel, once per loss, that the local daemon no longer
/// admits this wrapper.
///
/// The wrapper can still hold a live Hub connection after its local grant is
/// gone, so it keeps receiving turns while every `xmatrix` command it runs is
/// refused. Without a notice nobody in the Channel can tell a silent Agent
/// from a busy one.
#[derive(Default)]
struct LocalAuthorityLossNotice {
    consecutive: u32,
    announced: bool,
}

impl LocalAuthorityLossNotice {
    fn reset(&mut self) {
        self.consecutive = 0;
        self.announced = false;
    }

    /// Record one refresh failure; true when this failure should be announced.
    fn observe(&mut self, err: &error::CliError) -> bool {
        if !is_local_daemon_auth_rejected(err) {
            self.consecutive = 0;
            return false;
        }
        self.consecutive += 1;
        if self.announced || self.consecutive < LOCAL_AUTHORITY_LOSS_LIMIT {
            return false;
        }
        self.announced = true;
        true
    }
}

fn announce_local_authority_loss(
    relay: &Arc<agent_instance_connection::AgentInstanceConnectionClient>,
) {
    let Some(channel_id) = non_empty_env("XMATRIX_AUTO_JOIN_CHANNEL_ID") else {
        return;
    };
    let relay = relay.clone();
    tokio::spawn(async move {
        if let Err(err) = relay
            .send_channel_message(channel_id, local_authority_loss_notice())
            .await
        {
            eprintln!(
                "{} could not tell the Channel that local run credentials were lost: {err}",
                "⚠".yellow().bold()
            );
        }
    });
}

fn local_authority_loss_notice() -> String {
    "⚠ The xMatrix daemon on this machine no longer recognizes this Agent's run \
     credentials, usually after the daemon restarted or updated. The Agent still \
     receives messages, but its xmatrix commands (send, react, request) are refused, \
     so it cannot reply here. Reborn this instance to restore it."
        .to_string()
}

/// What each daemon auth refresh outcome means for the refresh loop.
#[derive(Default)]
struct DaemonAuthRefreshOutcomes {
    run_gone: RunGoneTracker,
    authority_loss: LocalAuthorityLossNotice,
}

impl DaemonAuthRefreshOutcomes {
    /// A refreshed token: back to the normal cadence.
    fn succeeded(&mut self) -> u64 {
        self.run_gone.reset();
        self.authority_loss.reset();
        AGENT_RUN_TOKEN_REFRESH_INTERVAL_SECS
    }

    /// A failed refresh: the seconds until the next attempt, or `None` once
    /// the Run is gone and the wrapper is shutting down.
    fn failed(
        &mut self,
        relay: &Arc<agent_instance_connection::AgentInstanceConnectionClient>,
        err: &error::CliError,
    ) -> Option<u64> {
        if self.run_gone.observe(err) {
            shut_down_orphaned_run(relay, err);
            return None;
        }
        if self.authority_loss.observe(err) {
            announce_local_authority_loss(relay);
        }
        // A refusal is rechecked soon while it may still be a restore in
        // flight; once announced, the normal cadence.
        Some(
            if is_local_daemon_auth_unavailable(err)
                || is_local_daemon_auth_rejected(err) && !self.authority_loss.announced
            {
                DAEMON_AUTH_REFRESH_RETRY_SECS
            } else {
                AGENT_RUN_TOKEN_REFRESH_INTERVAL_SECS
            },
        )
    }
}

fn spawn_daemon_auth_token_refresh(
    relay: Arc<agent_instance_connection::AgentInstanceConnectionClient>,
    label: &'static str,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut sleep_secs = AGENT_RUN_TOKEN_REFRESH_INTERVAL_SECS;
        let mut refresh = DaemonAuthRefreshOutcomes::default();
        loop {
            wait_for_daemon_auth_refresh(sleep_secs).await;
            let refreshed = match resolve_local_daemon_auth_token_for_refresh().await {
                Ok(Some(token)) => {
                    sleep_secs = refresh.succeeded();
                    token
                }
                Ok(None) => break,
                Err(err) => {
                    let Some(next) = refresh.failed(&relay, &err) else {
                        break;
                    };
                    sleep_secs = next;
                    eprintln!(
                        "{} {label} daemon auth refresh failed: {err}",
                        "⚠".yellow().bold()
                    );
                    continue;
                }
            };

            let message = protocol::AgentInstanceClientMessage::RefreshAuth {
                request_id: None,
                token: refreshed.clone(),
            };

            let relay = relay.clone();
            if let Err(err) = relay.update_auth_token(refreshed) {
                eprintln!(
                    "{} {label} daemon auth state update failed: {err}",
                    "⚠".yellow().bold()
                );
                continue;
            }
            if let Err(err) = relay.send_message(message) {
                eprintln!(
                    "{} {label} daemon auth delivery failed: {err}",
                    "⚠".yellow().bold()
                );
            }
        }
    })
}

async fn run_zcode_app_external(run: ExternalRun<'_>) -> error::Result<()> {
    let ExternalRun {
        tool,
        cmd,
        cmd_args,
        hub_url,
        cwd,
        relay,
        mut event_rx,
        agent,
    } = run;
    // ZCode's current app-server contract exposes only ordinary turn input.
    // The Agent's instructions are trusted launch configuration, so never
    // emulate a system prompt by prepending them to a user message.
    ensure_runtime_supports_trusted_role("ZCode app-server", false, trusted_role_is_active())?;
    let InitialMessageLaunch {
        mut bootstrap,
        initial_message,
        // ZCode renders its attachments into the prompt lines and never reaches
        // for the raw list or the materialised files.
        initial_message_attachments: _,
        initial_message_attachment_files: _,
        initial_attachment_lines,
        auto_join_channel_id,
    } = read_initial_message_launch(tool, &agent, hub_url, &relay, false).await?;

    if read_initial_spawn_context_from_env()
        .and_then(|context| context.requested_parameters)
        .is_some_and(|p| !p.is_empty())
    {
        return Err(CliError::Launch(
            "ZCode app-server does not advertise configurable parameters".into(),
        ));
    }
    write_current_run_status("zcode_app_starting", false, None);
    let latest_usage = read_zai_coding_plan_quota_usage(false).await;
    if initial_message.is_some() {
        send_presence(
            &relay,
            Some("busy"),
            PresencePatch::usage(latest_usage.clone()),
        );
    }

    let mut app = ZcodeAppSession::spawn(cmd, cmd_args, cwd).await?;
    let latest_goal = app.initialize(cwd).await?;
    let mut run = ZcodeRun {
        app,
        relay: &relay,
        agent: &agent,
        cmd,
        cmd_args,
        cwd,
        latest_usage,
        latest_goal,
    };
    write_current_run_status("zcode_app_ready", false, None);
    {
        let zcode_overlay = scan_zcode_user_command_tokens();
        let commands = agent_commands_for_runtime_with_overlay(
            agent.agent_type.as_str(),
            false,
            false,
            &zcode_overlay,
        )
        .or_else(|| agent_commands_for_runtime_with_overlay("zcode", false, false, &zcode_overlay));
        send_presence(
            &relay,
            Some("idle"),
            PresencePatch::presentation(model_catalog_presentation_with_commands(
                None,
                Vec::new(),
                None,
                commands,
                run.latest_usage.clone(),
            ))
            .parameters(Vec::new())
            .goal(run.latest_goal.clone())
            .runtime_state(None),
        );
    }
    eprintln!(
        "{} ZCode app-server backend ready for {} ({})",
        "✓".green().bold(),
        agent.name,
        agent.id.dimmed()
    );

    let mut pending_events = VecDeque::new();

    if let Some(initial_message) = initial_message {
        let initial_prompt =
            format!("Message from xMatrix chat:\n{initial_message}\n{initial_attachment_lines}");
        let payload = prompt_with_optional_bootstrap(&mut bootstrap, &initial_prompt);
        write_current_run_status("turn_running", false, None);
        let trace = TurnTrace {
            relay: Some(&relay),
            channel_id: auto_join_channel_id.as_deref(),
            source: "zcode_app_server",
            agent: &agent,
        };
        let turn = submit_zcode_turn_interruptible(
            &mut run.app,
            &mut event_rx,
            &mut pending_events,
            &payload,
            false,
            trace,
        )
        .await;
        run.settle_turn(turn, auto_join_channel_id.as_deref(), None)
            .await?;
    } else {
        run.publish("idle");
    }

    let mut termination_signals = TerminationSignals::new();
    loop {
        let Some(event) = next_agent_event_or_termination(
            &mut termination_signals,
            &mut pending_events,
            &mut event_rx,
        )
        .await
        else {
            break;
        };
        match event {
            event if is_channel_delivery_connection_event(&event) => {
                let Some((primary_channel_id, inbound_messages)) = next_channel_delivery(
                    event,
                    auto_join_channel_id.as_deref(),
                    &agent,
                    &mut event_rx,
                    &mut pending_events,
                )
                .await
                else {
                    continue;
                };
                let passthrough = single_message_slash_passthrough(&inbound_messages, &agent);
                ack_inbound_channel_messages(&relay, &inbound_messages);
                if passthrough
                    .as_deref()
                    .and_then(crate::harness_parameters::command)
                    .is_some()
                {
                    let _ = relay
                        .send_channel_message(
                            primary_channel_id,
                            "ZCode app-server does not advertise configurable parameters"
                                .to_string(),
                        )
                        .await;
                    continue;
                }
                let goal_command = passthrough.as_deref().and_then(parse_goal_command);
                let payload = goal_command.is_none().then(|| {
                    let payload = inbound_channel_batch_prompt(&inbound_messages, &agent);
                    prompt_with_optional_bootstrap(&mut bootstrap, &payload)
                });
                let primary_message_id = primary_inbound_message_id(&inbound_messages);
                run.publish("busy");
                write_current_run_status("turn_running", false, Some(&primary_message_id));
                let trace = TurnTrace {
                    relay: Some(&relay),
                    channel_id: Some(&primary_channel_id),
                    source: "zcode_app_server",
                    agent: &agent,
                };
                let turn_result = if let Some(command) = goal_command.as_ref() {
                    match run.app.goal_command(command).await {
                        Ok(outcome) => {
                            run.latest_goal = outcome.goal.clone();
                            run.publish("busy");
                            if outcome.started_turn {
                                observe_zcode_goal_run_interruptible(
                                    &mut run.app,
                                    &mut event_rx,
                                    &mut pending_events,
                                    outcome.active_input_id.as_deref(),
                                    &outcome.response,
                                    trace,
                                )
                                .await
                            } else {
                                Ok(CodexTurnResult {
                                    local_output: outcome.response,
                                    restart_after_turn: false,
                                    failed: false,
                                    failure_detail: None,
                                    usage: None,
                                    goal: outcome.goal,
                                    model: None,
                                })
                            }
                        }
                        Err(err) => Ok(CodexTurnResult {
                            local_output: format!("ZCode goal command failed: {err}"),
                            restart_after_turn: false,
                            failed: true,
                            failure_detail: Some(format!("ZCode goal command failed: {err}")),
                            usage: None,
                            goal: run.latest_goal.clone(),
                            model: None,
                        }),
                    }
                } else {
                    submit_zcode_turn_interruptible(
                        &mut run.app,
                        &mut event_rx,
                        &mut pending_events,
                        payload.as_deref().unwrap_or_default(),
                        true,
                        trace,
                    )
                    .await
                };
                run.settle_turn(
                    turn_result,
                    Some(&primary_channel_id),
                    Some(&primary_message_id),
                )
                .await?;
            }
            event => {
                if try_handle_vendor_connection_lifecycle(
                    &event,
                    &relay,
                    auto_join_channel_id.as_deref(),
                    &agent,
                ) == Some(true)
                {
                    relay.disconnect();
                    break;
                }
            }
        }
    }

    run.app.shutdown().await;
    relay.graceful_disconnect().await
}

/// A ZCode app-server run: the session and the state its presence reports.
struct ZcodeRun<'a> {
    app: ZcodeAppSession,
    relay: &'a Arc<agent_instance_connection::AgentInstanceConnectionClient>,
    agent: &'a protocol::SerializedAgent,
    cmd: &'a str,
    cmd_args: &'a [String],
    cwd: Option<&'a str>,
    latest_usage: Option<protocol::LlmUsage>,
    latest_goal: Option<protocol::AgentGoalStatus>,
}

impl ZcodeRun<'_> {
    fn publish(&self, status: &str) {
        send_presence(
            self.relay,
            Some(status),
            PresencePatch::usage(self.latest_usage.clone())
                .goal(self.latest_goal.clone())
                .runtime_state(None),
        );
    }

    async fn restart(&mut self) -> error::Result<()> {
        restart_zcode_app_session(&mut self.app, self.cmd, self.cmd_args, self.cwd, self.agent)
            .await?;
        self.latest_goal = self.app.latest_goal.clone();
        Ok(())
    }

    /// Close out one turn: refresh the quota, report a failure, go idle and
    /// restart the app-server when the turn left it unusable.
    async fn settle_turn(
        &mut self,
        turn: error::Result<CodexTurnResult>,
        channel_id: Option<&str>,
        message_id: Option<&str>,
    ) -> error::Result<()> {
        match turn {
            Ok(turn) => {
                if let Some(usage) = read_zai_coding_plan_quota_usage(true).await {
                    self.latest_usage = Some(usage);
                }
                self.latest_goal = turn.goal.clone();
                if turn.failed {
                    let failure_detail = turn
                        .failure_detail
                        .as_deref()
                        .unwrap_or("ZCode app-server turn failed");
                    report_turn_failure(
                        self.relay,
                        channel_id,
                        self.agent,
                        failure_detail,
                        turn.restart_after_turn,
                    );
                } else {
                    write_current_run_status("turn_completed", true, message_id);
                }
                self.publish("idle");
                report_local_turn_output("ZCode", &turn.local_output, channel_id);
                if turn.restart_after_turn {
                    self.restart().await?;
                }
            }
            Err(err) => {
                let error_message = format!("ZCode app-server turn failed: {err}");
                report_turn_failure(self.relay, channel_id, self.agent, &error_message, true);
                self.restart().await?;
                self.publish("idle");
            }
        }
        Ok(())
    }
}

/// Turn output the harness kept local never reaches the channel: print it,
/// and remind the operator how a channel-visible reply is sent.
fn report_local_turn_output(vendor: &str, local_output: &str, channel_id: Option<&str>) {
    if local_output.trim().is_empty() {
        return;
    }
    eprintln!("{local_output}");
    if let Some(channel_id) = channel_id {
        eprintln!(
            "{} {vendor} local output is not a channel message for {channel_id}; use `xmatrix send {channel_id} \"<message>\"` for channel-visible replies.",
            "○".cyan().bold()
        );
    }
}

async fn submit_zcode_turn_interruptible(
    app: &mut ZcodeAppSession,
    event_rx: &mut mpsc::UnboundedReceiver<agent_instance_connection::AgentInstanceConnectionEvent>,
    pending_events: &mut VecDeque<agent_instance_connection::AgentInstanceConnectionEvent>,
    text: &str,
    interrupt_history_replay: bool,
    trace: TurnTrace<'_>,
) -> error::Result<CodexTurnResult> {
    let interrupter = app.interrupter()?;
    let stops_turn = |event: &agent_instance_connection::AgentInstanceConnectionEvent| {
        event_requests_active_turn_interrupt_with_replay(
            event,
            trace.channel_id,
            Some(trace.agent.id.as_str()),
            interrupt_history_replay,
        )
    };
    let turn = app.submit_turn(text, trace);
    drive_zcode_turn_interruptible(
        turn,
        interrupter,
        event_rx,
        pending_events,
        stops_turn,
        false,
    )
    .await
}

async fn observe_zcode_goal_run_interruptible(
    app: &mut ZcodeAppSession,
    event_rx: &mut mpsc::UnboundedReceiver<agent_instance_connection::AgentInstanceConnectionEvent>,
    pending_events: &mut VecDeque<agent_instance_connection::AgentInstanceConnectionEvent>,
    initial_input_id: Option<&str>,
    initial_response: &str,
    trace: TurnTrace<'_>,
) -> error::Result<CodexTurnResult> {
    let interrupter = app.interrupter()?;
    let stops_turn = |event: &agent_instance_connection::AgentInstanceConnectionEvent| {
        event_requests_active_turn_interrupt(event, trace.channel_id, Some(trace.agent.id.as_str()))
    };
    let turn = app.observe_goal_run(initial_input_id, initial_response, trace);
    drive_zcode_turn_interruptible(
        turn,
        interrupter,
        event_rx,
        pending_events,
        stops_turn,
        true,
    )
    .await
}

/// Await a ZCode turn while relay events keep arriving: an event that stops
/// the active turn interrupts it (pausing the goal first while a goal runs),
/// and every event is queued for the run loop.
async fn drive_zcode_turn_interruptible(
    turn: impl std::future::Future<Output = error::Result<CodexTurnResult>>,
    interrupter: ZcodeAppInterrupter,
    event_rx: &mut mpsc::UnboundedReceiver<agent_instance_connection::AgentInstanceConnectionEvent>,
    pending_events: &mut VecDeque<agent_instance_connection::AgentInstanceConnectionEvent>,
    stops_turn: impl Fn(&agent_instance_connection::AgentInstanceConnectionEvent) -> bool,
    pause_goal: bool,
) -> error::Result<CodexTurnResult> {
    await_turn_with_events(turn, event_rx, pending_events, async |event| {
        if stops_turn(event) {
            if pause_goal && let Err(err) = interrupter.pause_active_goal().await {
                eprintln!("{} zcode goal pause failed: {err}", "⚠".yellow().bold());
            }
            if let Err(err) = interrupter.interrupt_active_turn().await {
                eprintln!(
                    "{} zcode app-server interrupt failed: {err}",
                    "⚠".yellow().bold()
                );
            }
        }
        false
    })
    .await
}

#[derive(Clone)]
struct ZcodeAppInterrupter {
    stdin: Arc<AsyncMutex<ChildStdin>>,
    session_id: String,
}

impl ZcodeAppInterrupter {
    async fn pause_active_goal(&self) -> error::Result<()> {
        write_zcode_app_message(
            &self.stdin,
            &serde_json::json!({
                "id": format!("xmatrix-goal-pause-{}", uuid::Uuid::new_v4()),
                "method": "session/goal",
                "params": {
                    "sessionId": self.session_id.clone(),
                    "action": "pause",
                },
            }),
        )
        .await
    }

    pub(crate) async fn interrupt_active_turn(&self) -> error::Result<()> {
        write_zcode_app_message(&self.stdin, &zcode_cancel_notification(&self.session_id)).await
    }
}

fn zcode_cancel_notification(session_id: &str) -> Value {
    serde_json::json!({
        "method": "session/cancel",
        "params": {
            "sessionId": session_id,
        },
    })
}

/// The launch context every vendor run loop reads out of its own environment.
///
/// Two ACP loops built this identically — bootstrap prompt, initial message, exit
/// flag, attachments and their rendered lines, bound channel. The copies were
/// kept apart only by their line breaks, so formatting the tree turned them into
/// a literal 26-line clone.
pub(crate) struct InitialMessageLaunch {
    pub(crate) bootstrap: Option<String>,
    pub(crate) initial_message: Option<String>,
    pub(crate) initial_message_attachments: Option<Vec<protocol::ChannelAttachment>>,
    pub(crate) initial_message_attachment_files: LocalImageFiles,
    pub(crate) initial_attachment_lines: String,
    pub(crate) auto_join_channel_id: Option<String>,
}

impl InitialMessageLaunch {
    /// The first turn of a runtime fed through a single prompt: the bootstrap,
    /// then the initial message with its rendered attachments.
    pub(crate) fn take_first_prompt(&mut self) -> Option<String> {
        let attachment_lines = &self.initial_attachment_lines;
        match (self.bootstrap.take(), self.initial_message.take()) {
            (Some(prompt), Some(message)) => Some(format!(
                "{prompt}\n\nMessage from xMatrix chat:\n{message}\n{attachment_lines}"
            )),
            (Some(prompt), None) => Some(prompt),
            (None, Some(message)) => Some(format!("{message}\n{attachment_lines}")),
            (None, None) => None,
        }
    }
}

pub(crate) async fn read_initial_message_launch(
    tool: &str,
    agent: &protocol::SerializedAgent,
    hub_url: &str,
    relay: &Arc<agent_instance_connection::AgentInstanceConnectionClient>,
    supports_self_goal: bool,
) -> error::Result<InitialMessageLaunch> {
    let bootstrap = with_channel_history_bootstrap(bootstrap::bootstrap_prompt(
        tool,
        &agent.name,
        hub_url,
        supports_self_goal,
    ));
    let initial_message = crate::runtime_resume_input::initial_runtime_message();
    let initial_message_attachments = read_initial_message_attachments_from_env()?;
    let initial_message_attachment_files = materialize_initial_message_image_files(
        initial_message_attachments.as_deref(),
        Some(relay.as_ref()),
    )
    .await;
    let initial_attachment_lines = render_initial_message_attachment_lines(
        initial_message_attachments.as_deref(),
        &initial_message_attachment_files,
    );
    let auto_join_channel_id = non_empty_env("XMATRIX_AUTO_JOIN_CHANNEL_ID");
    Ok(InitialMessageLaunch {
        bootstrap,
        initial_message,
        initial_message_attachments,
        initial_message_attachment_files,
        initial_attachment_lines,
        auto_join_channel_id,
    })
}

async fn write_zcode_app_message(
    stdin: &Arc<AsyncMutex<ChildStdin>>,
    value: &Value,
) -> error::Result<()> {
    write_json_line(stdin, serde_json::to_vec(value)?, "zcode app-server")
        .await
        .map_err(CliError::Launch)
}

/// A session event's type and payload.
fn zcode_session_event_parts(message: &Value) -> (Option<&str>, &Value) {
    let params = message.get("params").unwrap_or(&Value::Null);
    (
        params.get("type").and_then(Value::as_str),
        params.get("payload").unwrap_or(&Value::Null),
    )
}

struct ZcodeAppSession {
    stdin: Arc<AsyncMutex<ChildStdin>>,
    rx: mpsc::UnboundedReceiver<Value>,
    backlog: VecDeque<Value>,
    process_tree: process_tree::ProcessTreeGuard,
    child: Child,
    next_id: u64,
    session_id: Option<String>,
    latest_goal: Option<protocol::AgentGoalStatus>,
}

struct ZcodeGoalCommandResult {
    response: String,
    goal: Option<protocol::AgentGoalStatus>,
    started_turn: bool,
    active_input_id: Option<String>,
}

impl ZcodeAppSession {
    async fn spawn(cmd: &str, cmd_args: &[String], cwd: Option<&str>) -> error::Result<Self> {
        let mut app_args = cmd_args.to_vec();
        app_args.push("app-server".to_string());
        let mut server = AppServerChild::spawn(
            cmd,
            &app_args,
            cwd,
            Stdio::piped(),
            "zcode app-server",
            |_| {},
        )?;
        let stdin = server.take_stdin()?;
        let AppServerChild {
            child,
            process_tree,
            stdout,
            ..
        } = server;
        let (tx, rx) = mpsc::unbounded_channel();

        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<Value>(trimmed)
                    && tx.send(value).is_err()
                {
                    break;
                }
            }
        });

        Ok(Self {
            stdin: Arc::new(AsyncMutex::new(stdin)),
            rx,
            backlog: VecDeque::new(),
            process_tree,
            child,
            next_id: 1,
            session_id: None,
            latest_goal: None,
        })
    }

    async fn write_message(&self, value: &Value) -> error::Result<()> {
        write_zcode_app_message(&self.stdin, value).await
    }

    fn require_session_id(&self) -> error::Result<String> {
        self.session_id
            .clone()
            .ok_or_else(|| CliError::Launch("zcode app-server session not initialized".into()))
    }

    fn interrupter(&self) -> error::Result<ZcodeAppInterrupter> {
        Ok(ZcodeAppInterrupter {
            stdin: self.stdin.clone(),
            session_id: self.require_session_id()?,
        })
    }

    async fn request(&mut self, method: &str, params: Value) -> error::Result<Value> {
        let id = self.next_id.to_string();
        self.next_id += 1;
        let mut request = serde_json::json!({
            "id": id,
            "method": method,
        });
        if !params.is_null() {
            request["params"] = params;
        }
        self.write_message(&request).await?;

        while let Some(message) = self.rx.recv().await {
            if !zcode_message_id_matches(message.get("id"), &id) {
                self.backlog.push_back(message);
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(CliError::Launch(format!(
                    "zcode app-server {method} failed: {}",
                    zcode_app_error_message(error)
                )));
            }
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }

        Err(CliError::Launch("zcode app-server exited".into()))
    }

    async fn next_message(&mut self) -> Option<Value> {
        if let Some(message) = self.backlog.pop_front() {
            return Some(message);
        }
        self.rx.recv().await
    }

    async fn initialize(
        &mut self,
        cwd: Option<&str>,
    ) -> error::Result<Option<protocol::AgentGoalStatus>> {
        let workspace_path = app_server_workspace_path(cwd)?;
        let mode = std::env::var("XMATRIX_ZCODE_APP_MODE").unwrap_or_else(|_| "yolo".to_string());
        let result = self
            .request(
                "session/create",
                serde_json::json!({
                    "workspace": {
                        "workspacePath": workspace_path.clone(),
                        "workspaceKey": workspace_path,
                    },
                    "persistence": "deferred",
                    "mode": mode,
                }),
            )
            .await?;
        let session_id = result
            .get("session")
            .and_then(|session| session.get("sessionId"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| {
                CliError::Launch("zcode app-server session/create missing session id".into())
            })?;
        if let Some(goal) = zcode_goal_state_from_value(&result) {
            self.latest_goal = goal;
        }
        self.request(
            "session/subscribe",
            serde_json::json!({
                "sessionId": session_id.clone(),
                "deliveryKind": "desktop-continuous",
                "includeSnapshot": false,
            }),
        )
        .await?;
        self.session_id = Some(session_id);
        Ok(self.latest_goal.clone())
    }

    async fn goal_command(
        &mut self,
        command: &GoalCommand,
    ) -> error::Result<ZcodeGoalCommandResult> {
        let session_id = self.require_session_id()?;
        let (action, objective) = match command {
            GoalCommand::Set { objective } => ("set", Some(objective.as_str())),
            GoalCommand::Replace { objective } => ("replace", Some(objective.as_str())),
            GoalCommand::Clear => ("clear", None),
            GoalCommand::Get => ("show", None),
            GoalCommand::Resume => ("resume", None),
            GoalCommand::Pause => ("pause", None),
        };
        let mut params = serde_json::json!({
            "sessionId": session_id,
            "action": action,
        });
        if let Some(objective) = objective {
            params["objective"] = Value::String(objective.to_string());
        }
        let result = self.request("session/goal", params).await?;
        if let Some(goal) = zcode_goal_state_from_value(&result) {
            self.latest_goal = goal;
        } else if matches!(command, GoalCommand::Clear) {
            self.latest_goal = None;
        }
        Ok(ZcodeGoalCommandResult {
            response: result
                .get("response")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            goal: self.latest_goal.clone(),
            started_turn: result
                .get("startedTurn")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            active_input_id: zcode_goal_active_input_id(&result),
        })
    }

    /// The next event of `session_id`, folding its goal state into the
    /// session; `None` once the app-server stream ends.
    async fn next_session_event(&mut self, session_id: &str) -> Option<Value> {
        loop {
            let message = self.next_message().await?;
            if !zcode_is_session_event(&message)
                || message
                    .get("params")
                    .and_then(|params| params.get("sessionId"))
                    .and_then(Value::as_str)
                    != Some(session_id)
            {
                continue;
            }
            if let Some(goal) = zcode_goal_state_from_value(&message) {
                self.latest_goal = goal;
            }
            return Some(message);
        }
    }

    async fn observe_goal_run(
        &mut self,
        initial_input_id: Option<&str>,
        initial_response: &str,
        trace: TurnTrace<'_>,
    ) -> error::Result<CodexTurnResult> {
        let session_id = self.require_session_id()?;
        let mut output = String::new();
        let mut latest_model = None;
        let mut saw_goal_state = self.latest_goal.is_some();
        let trace_turn_id = initial_input_id.unwrap_or("goal");
        trace
            .send(
                "turn_started",
                None,
                None,
                serde_json::json!({
                    "sessionId": session_id.clone(),
                    "inputId": initial_input_id,
                    "goal": self.latest_goal,
                }),
            )
            .await;

        while let Some(message) = self.next_session_event(&session_id).await {
            latest_model = latest_model.or_else(|| extract_llm_model(&message));
            saw_goal_state |= zcode_goal_state_from_value(&message).is_some();
            let (event_type, payload) = zcode_session_event_parts(&message);
            match event_type {
                Some("model.streaming") => {
                    if let Some(delta) = payload.get("delta").and_then(Value::as_str) {
                        output.push_str(delta);
                        trace
                            .send(
                                "assistant_delta",
                                None,
                                latest_model.clone(),
                                serde_json::json!({
                                    "sessionId": session_id.clone(),
                                    "turnId": trace_turn_id,
                                    "delta": delta,
                                }),
                            )
                            .await;
                    }
                }
                Some("turn.completed") => {
                    latest_model = latest_model.or_else(|| extract_llm_model(payload));
                    if let Some(response) = payload.get("response").and_then(Value::as_str)
                        && output.trim().is_empty()
                    {
                        output.push_str(response);
                    }
                }
                Some("turn.failed") if saw_goal_state && !self.goal_is_active() => {
                    let detail = zcode_app_error_message(payload);
                    return Ok(self.turn_result(
                        output,
                        Some(format!("ZCode goal run failed: {detail}")),
                        latest_model,
                    ));
                }
                _ => {}
            }

            if saw_goal_state && !self.goal_is_active() {
                trace
                    .send(
                        "turn_completed",
                        None,
                        latest_model.clone(),
                        serde_json::json!({
                            "sessionId": session_id.clone(),
                            "turnId": trace_turn_id,
                            "goal": self.latest_goal,
                        }),
                    )
                    .await;
                if output.trim().is_empty() {
                    output = initial_response.to_string();
                }
                return Ok(self.turn_result(output, None, latest_model));
            }
        }

        Ok(CodexTurnResult {
            restart_after_turn: true,
            ..self.turn_result(
                output,
                Some("ZCode goal event stream closed".to_string()),
                latest_model,
            )
        })
    }

    async fn submit_turn(
        &mut self,
        text: &str,
        trace: TurnTrace<'_>,
    ) -> error::Result<CodexTurnResult> {
        let session_id = self.require_session_id()?;
        let input_id = format!("xmatrix-{}", uuid::Uuid::new_v4());
        trace
            .send(
                "turn_started",
                None,
                None,
                serde_json::json!({
                    "sessionId": session_id.clone(),
                    "inputId": input_id.clone(),
                    "input": redact_data_urls(text),
                }),
            )
            .await;
        self.request(
            "session/send",
            serde_json::json!({
                "sessionId": session_id.clone(),
                "content": text,
                "inputId": input_id.clone(),
                "queryId": input_id.clone(),
            }),
        )
        .await?;

        let mut output = String::new();
        let mut latest_model = None;
        while let Some(message) = self.next_session_event(&session_id).await {
            latest_model = latest_model.or_else(|| extract_llm_model(&message));
            let (event_type, payload) = zcode_session_event_parts(&message);
            let for_other_input = payload
                .get("inputId")
                .and_then(Value::as_str)
                .is_some_and(|value| value != input_id);
            match event_type {
                Some("model.streaming") => {
                    if let Some(delta) = payload.get("delta").and_then(Value::as_str) {
                        output.push_str(delta);
                        trace
                            .send(
                                "assistant_delta",
                                None,
                                None,
                                serde_json::json!({
                                    "sessionId": session_id.clone(),
                                    "inputId": input_id.clone(),
                                    "delta": delta,
                                }),
                            )
                            .await;
                    }
                }
                Some("turn.completed") if !for_other_input => {
                    latest_model = latest_model.or_else(|| extract_llm_model(payload));
                    let local_output = payload
                        .get("response")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or(output);
                    trace
                        .send(
                            "turn_completed",
                            None,
                            latest_model.clone(),
                            serde_json::json!({
                                "sessionId": session_id.clone(),
                                "inputId": input_id.clone(),
                            }),
                        )
                        .await;
                    return Ok(self.turn_result(local_output, None, latest_model));
                }
                Some("turn.failed") if !for_other_input => {
                    let detail = zcode_app_error_message(payload);
                    trace
                        .send(
                            "turn_failed",
                            None,
                            latest_model.clone(),
                            serde_json::json!({
                                "sessionId": session_id.clone(),
                                "inputId": input_id.clone(),
                                "error": detail,
                            }),
                        )
                        .await;
                    return Ok(self.turn_result(
                        output,
                        Some(format!("ZCode app-server turn failed: {detail}")),
                        latest_model,
                    ));
                }
                _ => {}
            }
        }

        Ok(CodexTurnResult {
            restart_after_turn: true,
            ..self.turn_result(
                output,
                Some("ZCode app-server event stream closed".to_string()),
                latest_model,
            )
        })
    }

    fn goal_is_active(&self) -> bool {
        self.latest_goal
            .as_ref()
            .is_some_and(|goal| goal.active == Some(true))
    }

    /// A turn's result as the session now stands; ZCode reports no usage.
    fn turn_result(
        &self,
        local_output: String,
        failure_detail: Option<String>,
        model: Option<String>,
    ) -> CodexTurnResult {
        CodexTurnResult {
            local_output,
            restart_after_turn: false,
            failed: failure_detail.is_some(),
            failure_detail,
            usage: None,
            goal: self.latest_goal.clone(),
            model,
        }
    }

    async fn shutdown(&mut self) {
        terminate_app_server(&mut self.process_tree, &mut self.child).await;
    }
}

/// Grok ACP backend: a thin shell over the generic ACP runner with the full
/// Grok vendor config (WebSocket serve, billing quota, goal grammar, skill
/// overlay, `_meta.rules`).
async fn run_grok_app_external(run: ExternalRun<'_>) -> error::Result<()> {
    run_acp_app_external(AcpVendorConfig::grok(), run).await
}

async fn run_acp_app_external(config: AcpVendorConfig, run: ExternalRun<'_>) -> error::Result<()> {
    let ExternalRun {
        tool,
        cmd,
        cmd_args,
        hub_url,
        cwd,
        relay,
        event_rx,
        agent,
    } = run;
    let display_name = config.display_name.clone();
    let run_phase_prefix = match config.flavor {
        AcpVendorFlavor::Grok => "grok",
        AcpVendorFlavor::Generic => "acp",
    };
    let InitialMessageLaunch {
        mut bootstrap,
        initial_message,
        initial_message_attachments,
        initial_message_attachment_files,
        initial_attachment_lines,
        auto_join_channel_id,
    } = read_initial_message_launch(tool, &agent, hub_url, &relay, false).await?;
    let resume_session_key = non_empty_env("XMATRIX_RESUME_SESSION_KEY");
    let resume_requested = env_flag("XMATRIX_RESUME_REQUESTED");
    let runtime_state = AgentRuntimeStateTracker::for_current_run(config.trace_source.clone());
    let mut latest_goal: Option<protocol::AgentGoalStatus> =
        read_initial_spawn_context_from_env().and_then(|ctx| ctx.goal);

    write_current_run_status(&format!("{run_phase_prefix}_app_starting"), false, None);
    // Seed monthly credit quota from the vendor billing hook so the channel
    // Agents panel can show remaining allowance (1mo). Turn token usage alone
    // rarely includes subscription windows. Read before the first presence
    // publish. Generic ACP vendors have no quota hook and simply skip this.
    let mut latest_usage = config.read_quota_usage(false).await;
    let mut initial_runtime_turn = runtime_state.begin_initial_message_turn(
        &relay,
        initial_message.is_some(),
        auto_join_channel_id.as_deref(),
        None,
        latest_usage.clone(),
        latest_goal.clone(),
    );

    let role_active = trusted_role_is_active();
    // Only vendors with a native trusted-instruction channel (session/new
    // `_meta.rules`) consume trusted rules here; other vendors keep the
    // bootstrap and deliver it as a prefix on the first user prompt.
    let trusted_rules = if config.session_new_meta_rules && (!resume_requested || role_active) {
        grok_acp_trusted_rules(bootstrap.as_deref())
    } else {
        None
    };
    let mut app = AcpSession::spawn(cmd, cmd_args, cwd, config.clone()).await?;
    let initial_presentation = app
        .initialize(
            cwd,
            resume_session_key.as_deref(),
            resume_requested && !role_active,
            trusted_rules.as_deref(),
        )
        .await?;
    if trusted_rules.is_some() {
        // The ACP agent accepted these as session/new `_meta.rules`, which the
        // provider appends to its system prompt. Do not repeat them in user
        // content on the first turn.
        bootstrap = None;
    }
    latest_goal = app.loaded_goal.take().or(latest_goal);
    let skill_overlay = config.slash_overlay.map(|scan| scan()).unwrap_or_default();
    let available_models = initial_presentation.models.unwrap_or_default();
    let mut latest_model = app.current_model().and_then(clean_run_model);
    let mut latest_effort = app.current_effort().and_then(clean_run_effort);
    latest_usage = merge_llm_usage(latest_usage, initial_presentation.usage);
    if let Some(preferred_model_env) = config.preferred_model_env
        && let Ok(preferred) = std::env::var(preferred_model_env)
    {
        let preferred = preferred.trim();
        if !preferred.is_empty() {
            match app.set_model(preferred).await {
                Ok(selected) => {
                    latest_model = Some(selected);
                    latest_effort = app.current_effort().and_then(clean_run_effort);
                }
                Err(err) => eprintln!(
                    "{} {display_name} preferred model '{preferred}' unavailable: {err}",
                    "⚠".yellow().bold()
                ),
            }
        }
    }
    if let Some(model) =
        read_initial_spawn_context_from_env().and_then(|context| context.requested_model)
    {
        let selected = app.set_model(&model).await?;
        if selected != model {
            return Err(CliError::Launch(
                "Routed model was not accepted by this harness".into(),
            ));
        }
        latest_model = Some(selected);
    }
    if let Some(effort) =
        read_initial_spawn_context_from_env().and_then(|context| context.requested_effort)
    {
        let selected = app.set_effort(&effort).await?;
        if selected != effort {
            return Err(CliError::Launch(
                "Requested reasoning effort was not accepted by this harness".into(),
            ));
        }
        latest_effort = Some(selected);
    }
    write_current_run_model(latest_model.as_deref());
    write_current_run_effort(latest_effort.as_deref());
    {
        let mut presentation = app.presentation_snapshot(&skill_overlay);
        presentation.usage = latest_usage.clone();
        send_presence(
            &relay,
            initial_message.as_ref().map(|_| "busy").or(Some("idle")),
            PresencePatch::presentation(presentation)
                .goal(latest_goal.clone())
                .runtime_state(Some(runtime_state.snapshot())),
        );
    }
    write_current_run_status(&format!("{run_phase_prefix}_app_ready"), false, None);
    eprintln!(
        "{} {display_name} ACP serve backend ready for {} ({})",
        "✓".green().bold(),
        agent.name,
        agent.id.dimmed()
    );

    let mut run = AcpRun {
        app,
        config: &config,
        relay: &relay,
        agent: &agent,
        cmd,
        cmd_args,
        cwd,
        resume_session_key: resume_session_key.as_deref(),
        runtime_state: &runtime_state,
        skill_overlay,
        latest_model,
        latest_effort,
        available_models,
        latest_goal,
        latest_usage,
    };
    let mut events = RunLoopEvents::new(event_rx, &relay, auto_join_channel_id.as_deref(), &agent);

    if let Some(requested) =
        read_initial_spawn_context_from_env().and_then(|context| context.requested_parameters)
    {
        for (id, value) in &requested {
            if run.app.presentation.effort_config_id.as_deref() == Some(id)
                || ["model", "models", "effort", "reasoning_effort"].contains(&id.as_str())
            {
                return Err(CliError::Launch(
                    "Use the dedicated model and effort launch tags".into(),
                ));
            }
            crate::harness_parameters::validate(run.parameters(), id, value)
                .map_err(CliError::Launch)?;
        }
        for (id, value) in &requested {
            run.app.set_parameter(id, value).await?;
        }
        run.sync();
    }
    if let Some(initial_message) = initial_message {
        let initial_prompt =
            format!("Message from xMatrix chat:\n{initial_message}\n{initial_attachment_lines}");
        let initial_prompt =
            match runtime_state.final_reply_instruction(auto_join_channel_id.as_deref()) {
                Some(instruction) => format!("{initial_prompt}\n\n{instruction}"),
                None => initial_prompt,
            };
        let payload = prompt_with_optional_bootstrap(&mut bootstrap, &initial_prompt);
        let initial_content_blocks = prompt_content_blocks(
            &payload,
            initial_message_attachments.as_deref(),
            Some(initial_message_attachment_files.image_paths()),
            ImageBlockShape::Acp,
        )?;
        write_current_run_status("turn_running", false, None);
        let turn = submit_acp_turn_interruptible(
            &mut run.app,
            &mut events.rx,
            &mut events.pending,
            &payload,
            initial_content_blocks,
            run.latest_model.as_deref(),
            None,
            false,
            &agent,
            Some(&relay),
            auto_join_channel_id.as_deref(),
            &runtime_state,
            run.latest_usage.clone(),
        )
        .await;
        let cancelled = run.settle_turn(
            turn,
            auto_join_channel_id.as_deref(),
            None,
            initial_runtime_turn.as_mut(),
        )
        .await?;
        if let Some(channel_id) = auto_join_channel_id.as_deref() {
            events.turn_ended(channel_id, cancelled);
        }
    } else {
        send_presence(&relay, Some("idle"), run.presence());
    }

    while let Some(input) = events.next_input(&mut run).await {
        match input {
            RunLoopInput::Delivery {
                channel_id: primary_channel_id,
                messages: inbound_messages,
                passthrough,
            } => {
                // Goal commands are only intercepted when the vendor has a
                // native goal grammar; hook-less vendors (generic ACP)
                // receive the slash text as a plain passthrough prompt.
                let goal_command = if config.goal_turn_input.is_some() {
                    passthrough.as_deref().and_then(parse_goal_command)
                } else {
                    None
                };
                let (mut payload, mut content_blocks) =
                    match (&goal_command, config.goal_turn_input) {
                        (Some(command), Some(rewrite)) => {
                            let text = rewrite(command, run.latest_goal.as_ref());
                            let blocks = vec![acp_text_block(&text)];
                            (text, blocks)
                        }
                        _ => {
                            let mut blocks: Vec<Value> = Vec::new();
                            let mut prompt_parts = Vec::with_capacity(inbound_messages.len());
                            for message in &inbound_messages {
                                let inbound_images = materialize_inbound_image_files(
                                    message.attachments.as_deref(),
                                    &relay,
                                )
                                .await;
                                let message_text =
                                    message.prompt_text(&agent, Some(&inbound_images));
                                let message_blocks = prompt_content_blocks(
                                    &message_text,
                                    message.attachments.as_deref(),
                                    Some(inbound_images.image_paths()),
                                    ImageBlockShape::Acp,
                                )?;
                                blocks.extend(message_blocks);
                                prompt_parts.push(message_text);
                            }
                            let text = combined_inbound_channel_prompt(prompt_parts);
                            match bootstrap.take() {
                                Some(bootstrap) => {
                                    let mut with_bootstrap = vec![acp_text_block(&bootstrap)];
                                    with_bootstrap.extend(blocks);
                                    (format!("{bootstrap}\n\n{text}"), with_bootstrap)
                                }
                                None => (text, blocks),
                            }
                        }
                    };
                if matches!(goal_command, Some(GoalCommand::Resume))
                    && let Some(resume_payload) = goal_resume_turn_payload(run.latest_goal.as_ref())
                {
                    // After /goal resume, keep working: append a short nudge.
                    payload = format!("{payload}\n\n{resume_payload}");
                    content_blocks.push(acp_text_block(&resume_payload));
                }
                let primary_message_id = primary_inbound_message_id(&inbound_messages);
                ack_inbound_channel_messages(&relay, &inbound_messages);
                let mut runtime_turn = runtime_state.begin_message_turn(
                    Some(&primary_channel_id),
                    Some(&primary_message_id),
                    inbound_messages.len(),
                    inbound_execution_sources(&inbound_messages),
                );
                if let Some(instruction) =
                    runtime_state.final_reply_instruction(Some(&primary_channel_id))
                {
                    payload.push_str(&format!("\n\n{instruction}"));
                    content_blocks.push(acp_text_block(&instruction));
                }
                send_presence(&relay, Some("busy"), run.presence());
                write_current_run_status("turn_running", false, Some(&primary_message_id));
                if let Some(command) = goal_command.as_ref() {
                    eprintln!(
                        "{} {display_name} {}",
                        "○".cyan().bold(),
                        match command {
                            GoalCommand::Set { objective } => format!("set goal: {objective}"),
                            GoalCommand::Replace { objective } => {
                                format!("replace goal: {objective}")
                            }
                            GoalCommand::Clear => "clear goal".to_string(),
                            GoalCommand::Get => "get goal status".to_string(),
                            GoalCommand::Resume => "resume goal".to_string(),
                            GoalCommand::Pause => "pause goal".to_string(),
                        }
                    );
                }
                let turn = submit_acp_turn_interruptible(
                    &mut run.app,
                    &mut events.rx,
                    &mut events.pending,
                    &payload,
                    content_blocks,
                    run.latest_model.as_deref(),
                    goal_command.as_ref(),
                    true,
                    &agent,
                    Some(&relay),
                    Some(&primary_channel_id),
                    &runtime_state,
                    run.latest_usage.clone(),
                )
                .await;
                let cancelled = run
                    .settle_turn(
                        turn,
                        Some(&primary_channel_id),
                        Some(&primary_message_id),
                        Some(&mut runtime_turn),
                    )
                    .await?;
                events.turn_ended(&primary_channel_id, cancelled);
            }
            RunLoopInput::Resume { channel_id, prompt } => {
                send_presence(&relay, Some("busy"), run.presence());
                write_current_run_status("turn_running", false, None);
                let turn = submit_acp_turn_interruptible(
                    &mut run.app,
                    &mut events.rx,
                    &mut events.pending,
                    &prompt,
                    vec![acp_text_block(&prompt)],
                    run.latest_model.as_deref(),
                    None,
                    true,
                    &agent,
                    Some(&relay),
                    Some(&channel_id),
                    &runtime_state,
                    run.latest_usage.clone(),
                )
                .await;
                let cancelled = run
                    .settle_turn(turn, Some(&channel_id), None, None)
                    .await?;
                events.turn_ended(&channel_id, cancelled);
            }
            RunLoopInput::Event(event) => {
                let event = *event;
                let reconnected = matches!(
                    &event,
                    agent_instance_connection::AgentInstanceConnectionEvent::Reconnected { .. }
                );
                if try_handle_vendor_connection_lifecycle(
                    &event,
                    &relay,
                    auto_join_channel_id.as_deref(),
                    &agent,
                ) == Some(true)
                {
                    relay.disconnect();
                    break;
                }
                if reconnected {
                    send_presence(&relay, Some("idle"), run.presence());
                }
            }
        }
    }

    run.app.shutdown().await;
    relay.graceful_disconnect().await
}

/// An ACP run: the session and the state its presence reports.
struct AcpRun<'a> {
    app: AcpSession,
    config: &'a AcpVendorConfig,
    relay: &'a Arc<agent_instance_connection::AgentInstanceConnectionClient>,
    agent: &'a protocol::SerializedAgent,
    cmd: &'a str,
    cmd_args: &'a [String],
    cwd: Option<&'a str>,
    resume_session_key: Option<&'a str>,
    runtime_state: &'a AgentRuntimeStateTracker,
    skill_overlay: Vec<String>,
    latest_model: Option<String>,
    latest_effort: Option<String>,
    available_models: Vec<protocol::AgentModelInfo>,
    latest_goal: Option<protocol::AgentGoalStatus>,
    latest_usage: Option<protocol::LlmUsage>,
}

impl AcpRun<'_> {
    fn parameters(&self) -> &[protocol::HarnessParameter] {
        self.app
            .presentation
            .parameters
            .as_deref()
            .unwrap_or_default()
    }

    /// Adopt the model, effort and catalog the session now reports.
    fn sync(&mut self) {
        sync_acp_presentation_state(
            &self.app,
            &mut self.latest_model,
            &mut self.latest_effort,
            &mut self.available_models,
        );
    }

    fn presentation(&self) -> AgentPresentationSnapshot {
        acp_presentation_snapshot(&self.app, &self.skill_overlay, self.latest_usage.clone())
    }

    fn presence(&self) -> PresencePatch {
        PresencePatch::presentation(self.presentation())
            .goal(self.latest_goal.clone())
            .runtime_state(Some(self.runtime_state.snapshot()))
    }

    async fn restart(&mut self) -> error::Result<()> {
        restart_acp_app_session(
            &mut self.app,
            self.cmd,
            self.cmd_args,
            self.cwd,
            self.resume_session_key,
        )
        .await?;
        self.latest_goal = self.app.loaded_goal.take().or(self.latest_goal.take());
        self.sync();
        Ok(())
    }

    /// Close out one turn: fold in its usage, model and goal, record the
    /// outcome, go idle and restart the session when the turn broke it.
    /// Answers whether the turn was cancelled.
    async fn settle_turn(
        &mut self,
        turn: error::Result<CodexTurnResult>,
        channel_id: Option<&str>,
        message_id: Option<&str>,
        mut runtime_turn: Option<&mut AgentRuntimeTurnGuard>,
    ) -> error::Result<bool> {
        let mut finish_as = |outcome: &str| {
            if let Some(guard) = runtime_turn.as_mut() {
                guard.finish_as(outcome);
            }
        };
        let mut cancelled = false;
        match turn {
            Ok(turn) => {
                self.latest_usage = merge_llm_usage(self.latest_usage.take(), turn.usage.clone());
                self.latest_usage = merge_llm_usage(
                    self.latest_usage.take(),
                    self.config.read_quota_usage(true).await,
                );
                self.latest_model = turn.model.clone().or(self.latest_model.take());
                self.latest_goal = if turn
                    .goal
                    .as_ref()
                    .is_some_and(goal_status_represents_absence)
                {
                    None
                } else {
                    turn.goal.clone().or(self.latest_goal.take())
                };
                self.sync();
                cancelled = acp_turn_result_is_cancelled(&turn);
                // The outcome is already decided here; record it before a
                // failure notice instead of letting the guard unwind as unknown.
                finish_as(if cancelled {
                    "interrupted"
                } else if turn.failed {
                    "failed"
                } else {
                    "completed"
                });
                if cancelled {
                    write_current_run_status(
                        "turn_interrupted",
                        false,
                        message_id.or(turn.failure_detail.as_deref()),
                    );
                } else if turn.failed {
                    let unknown_failure = format!("{} ACP turn failed", self.config.display_name);
                    let failure_detail = turn.failure_detail.as_deref().unwrap_or(&unknown_failure);
                    report_turn_failure(
                        self.relay,
                        channel_id,
                        self.agent,
                        failure_detail,
                        turn.restart_after_turn,
                    );
                } else {
                    write_current_run_status("turn_completed", true, message_id);
                }
                send_presence(self.relay, Some("idle"), self.presence());
                report_local_turn_output(&self.config.display_name, &turn.local_output, channel_id);
                if turn.restart_after_turn {
                    self.restart().await?;
                }
            }
            Err(err) => {
                let error_message = format!("{} ACP turn failed: {err}", self.config.display_name);
                report_turn_failure(self.relay, channel_id, self.agent, &error_message, true);
                self.restart().await?;
                finish_as("failed");
                send_presence(self.relay, Some("idle"), self.presence());
            }
        }
        Ok(cancelled)
    }
}

impl ChannelControlledRuntime for AcpRun<'_> {
    async fn request_model_switch(&mut self, requested: &str) -> Result<String, String> {
        let display_name = &self.config.display_name;
        let candidate = resolve_switchable_model(&self.available_models, display_name, requested)?;
        // A vendor that rejects the switch is reported verbatim: it used to be
        // printed locally and answered as "not available", which told the user
        // their model was wrong when the RPC had failed.
        let selected = self.app.set_model(&candidate).await.map_err(|err| {
            eprintln!(
                "{} {display_name} model switch failed: {err}",
                "⚠".yellow().bold()
            );
            format!("{display_name} model switch failed: {err}")
        })?;
        self.sync();
        Ok(selected)
    }

    async fn request_effort_switch(&mut self, requested: &str) -> Result<String, String> {
        let display_name = &self.config.display_name;
        if !models_support_efforts(&self.available_models) {
            return Err(format!("{display_name} effort catalog is unavailable"));
        }
        let cleaned = clean_run_effort(requested);
        let in_catalog = cleaned.as_deref().is_some_and(|cleaned| {
            self.available_models.iter().any(|model| {
                model
                    .supported_reasoning_efforts
                    .as_ref()
                    .is_some_and(|items| {
                        items.iter().any(|candidate| {
                            candidate.reasoning_effort.eq_ignore_ascii_case(cleaned)
                        })
                    })
            })
        });
        if !in_catalog {
            return Err(format!("Effort '{}' is not available", requested.trim()));
        }
        let selected = self
            .app
            .set_effort(cleaned.as_deref().unwrap_or_default())
            .await
            .map_err(|err| {
                eprintln!(
                    "{} {display_name} effort switch failed: {err}",
                    "⚠".yellow().bold()
                );
                format!("{display_name} effort switch failed: {err}")
            })?;
        self.sync();
        Ok(selected)
    }

    fn switch_presence(&self) -> PresencePatch {
        self.presence()
    }

    async fn parameter_control(
        &mut self,
        command: crate::harness_parameters::ParameterCommand,
        message: &InboundChannelMessage,
        agent: &protocol::SerializedAgent,
    ) -> Result<String, String> {
        let outcome = self.apply_parameter_control(command, message, agent).await;
        // Whatever the control did, report the state the session now holds.
        self.sync();
        outcome
    }

    fn parameter_presence(&self) -> PresencePatch {
        PresencePatch::presentation(self.presentation())
    }
}

impl AcpRun<'_> {
    async fn apply_parameter_control(
        &mut self,
        command: crate::harness_parameters::ParameterCommand,
        message: &InboundChannelMessage,
        agent: &protocol::SerializedAgent,
    ) -> Result<String, String> {
        let (id, value) =
            crate::harness_parameter_toggles::resolve(command, self.parameters(), message, agent)?;
        let notice = match value {
            Some(value) => self
                .app
                .set_parameter(&id, &value)
                .await
                .map(|selected| format!("{id}: {selected}"))
                .map_err(|error| error.to_string())?,
            None => crate::harness_parameters::status(self.parameters(), &id)?,
        };
        crate::harness_parameter_toggles::complete(message, agent, self.parameters())?;
        Ok(notice)
    }
}

fn acp_text_block(text: &str) -> Value {
    serde_json::json!({ "type": "text", "text": text })
}

fn prompt_with_optional_bootstrap(bootstrap: &mut Option<String>, text: &str) -> String {
    match bootstrap.take() {
        Some(bootstrap) => format!("{bootstrap}\n\n{text}"),
        None => text.to_string(),
    }
}

#[allow(clippy::too_many_arguments)]
async fn submit_acp_turn_interruptible(
    app: &mut AcpSession,
    event_rx: &mut mpsc::UnboundedReceiver<agent_instance_connection::AgentInstanceConnectionEvent>,
    pending_events: &mut VecDeque<agent_instance_connection::AgentInstanceConnectionEvent>,
    text: &str,
    content_blocks: Vec<Value>,
    model: Option<&str>,
    goal_command: Option<&GoalCommand>,
    interrupt_history_replay: bool,
    agent: &protocol::SerializedAgent,
    trace_relay: Option<&Arc<agent_instance_connection::AgentInstanceConnectionClient>>,
    trace_channel_id: Option<&str>,
    runtime_state: &AgentRuntimeStateTracker,
    latest_usage: Option<protocol::LlmUsage>,
) -> error::Result<CodexTurnResult> {
    let display_name = app.config.display_name.clone();
    let interrupter = app.interrupter()?;
    let turn = app.submit_turn(
        text,
        content_blocks,
        model,
        goal_command,
        agent,
        trace_relay,
        trace_channel_id,
    );
    await_turn_with_events(turn, event_rx, pending_events, async |event| {
        let relay = trace_relay.map(|relay| relay.as_ref());
        if reassert_busy_on_reconnect(event, relay, trace_channel_id, || {
            PresencePatch::usage(latest_usage.clone()).runtime_state(Some(runtime_state.snapshot()))
        }) {
            return true;
        }
        if event_requests_active_turn_interrupt_with_replay(
            event,
            trace_channel_id,
            Some(agent.id.as_str()),
            interrupt_history_replay,
        ) && let Err(err) = interrupter.interrupt_active_turn().await
        {
            eprintln!(
                "{} {display_name} ACP interrupt failed: {err}",
                "⚠".yellow().bold()
            );
        }
        false
    })
    .await
}

async fn restart_acp_app_session(
    app: &mut AcpSession,
    cmd: &str,
    cmd_args: &[String],
    cwd: Option<&str>,
    resume_session_key: Option<&str>,
) -> error::Result<()> {
    app.shutdown().await;
    *app = AcpSession::spawn(cmd, cmd_args, cwd, app.config.clone()).await?;
    let _ = app.initialize(cwd, resume_session_key, true, None).await?;
    Ok(())
}

fn acp_presentation_snapshot(
    app: &AcpSession,
    command_overlay: &[String],
    usage: Option<protocol::LlmUsage>,
) -> AgentPresentationSnapshot {
    let mut presentation = app.presentation_snapshot(command_overlay);
    presentation.usage = merge_llm_usage(presentation.usage, usage);
    presentation
}

fn sync_acp_presentation_state(
    app: &AcpSession,
    latest_model: &mut Option<String>,
    latest_effort: &mut Option<String>,
    available_models: &mut Vec<protocol::AgentModelInfo>,
) {
    *latest_model = app.current_model().and_then(clean_run_model);
    *latest_effort = app.current_effort().and_then(clean_run_effort);
    *available_models = app.available_models().to_vec();
    write_current_run_model(latest_model.as_deref());
    write_current_run_effort(latest_effort.as_deref());
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AcpTransportKind {
    WebSocket,
    Stdio,
}

#[derive(Clone)]
struct AcpInterrupter {
    write: AppServerWrite,
    session_id: String,
}

impl AcpInterrupter {
    pub(crate) async fn interrupt_active_turn(&self) -> error::Result<()> {
        write_acp_message(&self.write, &acp_cancel_notification(&self.session_id)).await
    }
}

fn acp_cancel_notification(session_id: &str) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "method": "session/cancel",
        "params": {
            "sessionId": session_id,
        },
    })
}

async fn write_acp_message(write: &AppServerWrite, value: &Value) -> error::Result<()> {
    write
        .send(value, "ACP agent stdio", "ACP agent WebSocket")
        .await
}

type AcpQuotaHook = fn(
    bool,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Option<protocol::LlmUsage>> + Send>,
>;
type AcpSlashOverlayHook = fn() -> Vec<String>;
type AcpGoalTurnInputHook = fn(&GoalCommand, Option<&protocol::AgentGoalStatus>) -> String;
type AcpGoalStatusFromUpdateHook = fn(&Value) -> Option<protocol::AgentGoalStatus>;
type AcpGoalStatusFromTextHook =
    fn(&str, Option<&GoalCommand>) -> Option<protocol::AgentGoalStatus>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AcpVendorFlavor {
    /// Grok Build: WebSocket serve transport, `grok agent` argv, and every
    /// vendor hook (billing quota, goal grammar, skill overlay, `_meta.rules`).
    Grok,
    /// Vendor-neutral ACP over stdio (e.g. Kimi Code via `kimi acp`): no
    /// hooks, so goal/quota handling degrades to passthrough.
    Generic,
}

/// Vendor-specific knobs for the generic ACP (Agent Client Protocol) backend.
/// The Grok adapter keeps every historical hook; new ACP agents should only
/// need an `agent-presets.json` entry with `backend: "acp"` and `acpArgs`.
#[derive(Clone)]
struct AcpVendorConfig {
    flavor: AcpVendorFlavor,
    /// Capitalized vendor name for log lines ("Grok", "Kimi").
    display_name: String,
    /// llm_trace `source` label and runtime-state tracker source.
    trace_source: String,
    /// authenticate params sent after initialize; None skips authenticate
    /// unless a request fails with authRequired (-32000), in which case the
    /// generic `{methodId: "login"}` flow is attempted once.
    authenticate: Option<Value>,
    /// Deliver trusted rules via session/new `_meta.rules`; otherwise the
    /// bootstrap falls back to a prefix on the first user prompt.
    session_new_meta_rules: bool,
    /// optionId used when a permission request carries no selectable options;
    /// None answers such requests with -32601.
    permission_fallback_option_id: Option<&'static str>,
    /// Env var holding a preferred model id selected after initialize.
    preferred_model_env: Option<&'static str>,
    /// Env var overriding the turn timeout in seconds.
    turn_timeout_env: &'static str,
    /// Extra slash-command tokens scanned from vendor skill directories.
    slash_overlay: Option<AcpSlashOverlayHook>,
    /// Rewrites a parsed /goal command onto the vendor's native grammar.
    goal_turn_input: Option<AcpGoalTurnInputHook>,
    /// Structured goal status extracted from tool_call session updates.
    goal_status_from_update: Option<AcpGoalStatusFromUpdateHook>,
    /// Goal status inferred from assistant text.
    goal_status_from_text: Option<AcpGoalStatusFromTextHook>,
    /// Subscription/quota seed (force=false) and refresh (force=true) hook.
    quota_usage: Option<AcpQuotaHook>,
    /// Resume-session cache namespace; isolates session ids per vendor.
    resume_namespace: String,
    /// Normalizes this vendor's native events into the shared presentation.
    presentation_adapter: BuiltinAgentPresentationAdapter,
    /// The preset's `acpArgs` for a generic launcher. `Some(vec![])` means the
    /// launcher already speaks ACP with no subcommand (`pi-acp`); None falls
    /// back to the `acp` subcommand convention.
    preset_acp_args: Option<Vec<String>>,
}

impl AcpVendorConfig {
    /// The vendor's subscription quota; vendors without a hook have none.
    async fn read_quota_usage(&self, force: bool) -> Option<protocol::LlmUsage> {
        match self.quota_usage {
            Some(hook) => hook(force).await,
            None => None,
        }
    }

    fn grok() -> Self {
        Self {
            flavor: AcpVendorFlavor::Grok,
            display_name: "Grok".to_string(),
            trace_source: "grok_acp".to_string(),
            authenticate: Some(serde_json::json!({ "methodId": "cached_token" })),
            session_new_meta_rules: true,
            permission_fallback_option_id: Some("allow-always"),
            preferred_model_env: Some("XMATRIX_GROK_MODEL"),
            turn_timeout_env: "XMATRIX_GROK_APP_TURN_TIMEOUT_SECS",
            slash_overlay: Some(scan_grok_skill_command_tokens),
            goal_turn_input: Some(grok_goal_turn_input),
            goal_status_from_update: Some(grok_goal_status_from_session_update),
            goal_status_from_text: Some(grok_goal_status_from_assistant_text),
            quota_usage: Some(grok_billing_quota_hook),
            resume_namespace: "grok-resume".to_string(),
            presentation_adapter: agent_presentation_adapter_for_runtime("grok"),
            preset_acp_args: None,
        }
    }

    fn generic(tool: &str) -> Self {
        let preset = agent_preset_for_launcher(tool);
        let stem = acp_tool_stem(tool);
        let display_name = match preset {
            Some(preset) => preset.display_name.clone(),
            None => {
                let mut chars = stem.chars();
                match chars.next() {
                    Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                    None => "ACP".to_string(),
                }
            }
        };
        Self {
            flavor: AcpVendorFlavor::Generic,
            display_name,
            trace_source: format!("{stem}_acp"),
            authenticate: None,
            session_new_meta_rules: false,
            permission_fallback_option_id: None,
            preferred_model_env: None,
            turn_timeout_env: "XMATRIX_ACP_TURN_TIMEOUT_SECS",
            slash_overlay: None,
            goal_turn_input: None,
            goal_status_from_update: None,
            goal_status_from_text: None,
            // OpenCode Go and Cursor expose account quota behind their own
            // stored credentials; every other generic ACP peer has no quota
            // source here.
            quota_usage: match stem.as_str() {
                "opencode" => Some(opencode_quota_hook),
                "cursor" => Some(cursor_quota_hook),
                _ => None,
            },
            resume_namespace: format!("acp-resume-{stem}"),
            presentation_adapter: agent_presentation_adapter_for_acp_runtime(&stem),
            preset_acp_args: preset.and_then(|preset| preset.acp_args.clone()),
        }
    }

    /// Lowercase vendor name for mid-sentence error strings ("grok agent ...").
    fn log_name(&self) -> String {
        self.display_name.to_ascii_lowercase()
    }

    fn acp_spawn_args(
        &self,
        cmd_args: &[String],
        transport: AcpTransportKind,
        bind: Option<&str>,
        secret: Option<&str>,
    ) -> Vec<String> {
        match self.flavor {
            AcpVendorFlavor::Grok => grok_acp_spawn_args(cmd_args, transport, bind, secret),
            AcpVendorFlavor::Generic => {
                generic_acp_spawn_args(cmd_args, self.preset_acp_args.as_deref())
            }
        }
    }
}

fn grok_billing_quota_hook(
    force: bool,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<protocol::LlmUsage>> + Send>> {
    Box::pin(read_grok_build_billing_usage(force))
}

fn opencode_quota_hook(
    force: bool,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<protocol::LlmUsage>> + Send>> {
    Box::pin(read_opencode_zen_usage(force))
}

fn cursor_quota_hook(
    force: bool,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<protocol::LlmUsage>> + Send>> {
    Box::pin(read_cursor_period_usage(force))
}

/// Normalizes a runtime command to a lowercase vendor stem ("kimi", "grok").
/// A registered launcher reports its preset id, so labels say "cursor" and
/// "pi" while the binaries are cursor-agent and pi-acp.
fn acp_tool_stem(tool: &str) -> String {
    if let Some(preset) = agent_preset_for_launcher(tool) {
        return preset.id.clone();
    }
    let stem = xmatrix_cli_agent::launcher_stem(tool);
    if stem.is_empty() {
        "acp".to_string()
    } else {
        stem
    }
}

/// Generic ACP argv: explicit CLI args win, then the daemon-provided
/// XMATRIX_ACP_ARGS JSON array, then the preset's own `acpArgs` (an explicit
/// `[]` for a launcher that already speaks ACP), finally the ACP community
/// convention of an `acp` subcommand (e.g. `kimi acp`).
fn generic_acp_spawn_args(cmd_args: &[String], preset_acp_args: Option<&[String]>) -> Vec<String> {
    if !cmd_args.is_empty() {
        return cmd_args.to_vec();
    }
    if let Ok(raw) = std::env::var("XMATRIX_ACP_ARGS")
        && let Some(args) = acp_args_from_json(&raw)
    {
        return args;
    }
    if let Some(args) = preset_acp_args {
        return args.to_vec();
    }
    vec!["acp".to_string()]
}

fn acp_args_from_json(raw: &str) -> Option<Vec<String>> {
    let value: Value = serde_json::from_str(raw.trim()).ok()?;
    let args: Vec<String> = value
        .as_array()?
        .iter()
        .filter_map(|item| item.as_str().map(str::to_string))
        .collect();
    (!args.is_empty()).then_some(args)
}

struct AcpSession {
    write: AppServerWrite,
    inbox: ProviderInbox,
    process_tree: process_tree::ProcessTreeGuard,
    child: Child,
    next_id: u64,
    session_id: Option<String>,
    /// Latest structured goal from a successful session/load history replay.
    loaded_goal: Option<protocol::AgentGoalStatus>,
    presentation: AgentPresentationFacts,
    config: AcpVendorConfig,
    /// The plan outlives a turn, so what it already reported does too.
    activity: ChannelActivityReporter,
}

fn acp_session_new_params(workspace_path: &str, trusted_rules: Option<&str>) -> Value {
    let mut params = serde_json::json!({
        "cwd": workspace_path,
        "mcpServers": crate::runtime_connector_mcp::acp_connector_mcp_servers(),
    });
    if let Some(rules) = trusted_rules
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        params["_meta"] = serde_json::json!({ "rules": rules });
    }
    params
}

/// Cursor (and compatible ACP servers) only expose separate model parameters
/// when the client advertises this capability. Without it, Cursor falls back to
/// a broken variants-mode picker that surfaces placeholder ids such as
/// `default[]` on the model status chip.
fn acp_initialize_params() -> Value {
    serde_json::json!({
        "protocolVersion": 1,
        "clientCapabilities": {
            "session": { "configOptions": { "boolean": {} }, "notices": {} },
            "_meta": {
                "parameterizedModelPicker": true
            }
        },
        "clientInfo": {
            "name": "xmatrix",
            "version": xmatrix_cli_core::version::current(),
        },
    })
}

/// JSON-RPC error with its numeric code preserved so callers can react to
/// authRequired (-32000) without parsing display strings.
struct AcpRequestError {
    code: Option<i64>,
    detail: String,
}

const ACP_AUTH_REQUIRED_CODE: i64 = -32000;
