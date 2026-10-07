fn ensure_reqwest_crypto_provider() {
    // reqwest's rustls-no-provider feature avoids the expensive AWS-LC native
    // build. Keep the runtime crate safe when used outside the main binary,
    // including its standalone unit-test executable.
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn reqwest_client() -> reqwest::Client {
    ensure_reqwest_crypto_provider();
    reqwest::Client::new()
}

fn reqwest_client_builder() -> reqwest::ClientBuilder {
    ensure_reqwest_crypto_provider();
    reqwest::Client::builder()
}

async fn fetch_channel_image_reference(url: &str, output: Option<&Path>) -> error::Result<PathBuf> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|err| CliError::Http(format!("Invalid attachment URL: {err}")))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(CliError::Http(
            "Attachment URL must use http or https".to_string(),
        ));
    }
    if output.is_none()
        && let Some(path) = existing_cached_attachment_fetch_path(&parsed) {
            return Ok(path);
        }

    let response = reqwest_client_builder()
        .timeout(Duration::from_secs(60))
        .build()?
        .get(parsed.clone())
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        return Err(CliError::Http(format!(
            "Attachment download failed with status {status}"
        )));
    }
    if let Some(length) = response.content_length()
        && length > ATTACHMENT_FETCH_MAX_BYTES {
            return Err(CliError::Http(format!(
                "Attachment is too large to fetch ({length} bytes)"
            )));
        }
    let mime_type = http::response_mime_type(&response)
        .unwrap_or("application/octet-stream")
        .to_ascii_lowercase();
    let extension = image_extension_for_mime_type(&mime_type).ok_or_else(|| {
        CliError::Http(format!(
            "Attachment URL did not return a supported image content type ({mime_type})"
        ))
    })?;

    let bytes = response.bytes().await?;
    if bytes.is_empty() {
        return Err(CliError::Http("Attachment download was empty".to_string()));
    }
    if bytes.len() as u64 > ATTACHMENT_FETCH_MAX_BYTES {
        return Err(CliError::Http(format!(
            "Attachment is too large to fetch ({} bytes)",
            bytes.len()
        )));
    }

    let path = match output {
        Some(path) => path.to_path_buf(),
        None => cached_attachment_fetch_path(&parsed, extension),
    };
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&path, &bytes).await?;
    let _ = attachment_cache::write_cached_attachment(
        &attachment_cache::cache_stem_for_url(url),
        &bytes,
    );
    Ok(path)
}

fn cached_attachment_fetch_path(url: &reqwest::Url, extension: &str) -> PathBuf {
    attachment_cache::attachment_cache_dir()
        .join(format!("{}.{extension}", cached_attachment_fetch_stem(url)))
}

fn existing_cached_attachment_fetch_path(url: &reqwest::Url) -> Option<PathBuf> {
    ["png", "jpg", "webp", "gif"]
        .into_iter()
        .map(|extension| cached_attachment_fetch_path(url, extension))
        .find(|path| {
            std::fs::metadata(path)
                .map(|metadata| metadata.is_file() && metadata.len() > 0)
                .unwrap_or(false)
        })
}

fn cached_attachment_fetch_stem(url: &reqwest::Url) -> String {
    attachment_cache::cache_stem_for_url(url.as_str())
}

use xmatrix_cli_core::hex::lowercase_hex;

fn image_extension_for_mime_type(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

struct DaemonRunChild {
    #[cfg(windows)]
    handoff: Option<WindowsRunHandoff>,
    child: Option<std::process::Child>,
    /// Parent-owned process-tree fence for a freshly spawned wrapper. The
    /// wrapper may exit before a provider-owned helper does, so the daemon
    /// retains this Job/process-group until it has stopped every descendant.
    /// Rehydrated rows have no inherited handle and use PID-tree cleanup.
    process_tree: Option<process_tree::ProcessTreeGuard>,
    pid: u32,
    /// In-memory fence spanning process-tree stop through pool transition and
    /// durable registry removal. Exit monitoring must not consume this row.
    stop_in_progress: bool,
    /// The exit was audited once; later sweeps only retry its report.
    exit_audited: bool,
    cwd: Option<PathBuf>,
    run_id: Option<String>,
    execution_key: Option<String>,
    instance_id: Option<String>,
    resume_session_key: Option<String>,
    repo_pool_binding: Option<DaemonRepoPoolBinding>,
    agent_id: Option<String>,
    agent_name: Option<String>,
    auth_capability: Option<String>,
    request_capability: Option<String>,
    request_context: Option<DaemonRequestAgentContext>,
    status_file_path: Option<PathBuf>,
    stdout_log_path: Option<PathBuf>,
    stderr_log_path: Option<PathBuf>,
    _auth_grant: Option<DaemonAuthGrant>,
    _request_grant: Option<DaemonRequestGrant>,
}

/// Persisted inside every Run sidecar, so it is read by daemons *older* than
/// the one that wrote it: during an update the outgoing daemon keeps loading
/// sidecars the incoming CLI has already rewritten. `deny_unknown_fields` made
/// that fatal — one field an older build had never heard of failed the whole
/// `PersistedDaemonRun`, the row was dropped, and with it the capability
/// verifier key that `restore_daemon_run_grants` needs, so a live Run silently
/// lost the right to speak to its own daemon. Unknown fields are ignored here
/// for the same reason `space_id` defaults: never lose the record.
#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonRepoPoolBinding {
    canonical_repo_identity: String,
    repo_key_id: String,
    slot_id: String,
    base_repo: PathBuf,
    resumed: bool,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DaemonRepoPoolSpawnClaim {
    canonical_repo_identity: String,
    repo_key_id: String,
    slot_id: String,
    session_key: String,
    instance_id: String,
    run_id: String,
    execution_key: String,
    spawn_claim_token: String,
}

impl DaemonRepoPoolSpawnClaim {
    fn authority(&self) -> repo_pool::BindingAuthority {
        repo_pool::BindingAuthority::new(
            &self.session_key,
            &self.instance_id,
            &self.run_id,
            &self.execution_key,
            &self.slot_id,
        )
    }
}

type DaemonRunRegistry = Arc<AsyncMutex<HashMap<String, DaemonRunChild>>>;
type DaemonSpawnInflight = Arc<AsyncMutex<HashSet<String>>>;
type DaemonSessionState = Arc<RwLock<DaemonSessionValue>>;

#[derive(Clone, Debug, Eq, PartialEq)]
struct DaemonSessionSource {
    hub_url: String,
    user_id: String,
    updated_at: u64,
    expires_at: u64,
    token_digest: String,
}

impl DaemonSessionSource {
    fn from_saved_session(session: &CliSession) -> Self {
        Self {
            hub_url: normalize_hub_url(Some(&session.hub_url)),
            user_id: session.user.id.clone(),
            updated_at: session.updated_at.parse::<u64>().unwrap_or(0),
            expires_at: session.expires_at.parse::<u64>().unwrap_or(0),
            token_digest: lowercase_hex(&Sha256::digest(session.token.as_bytes())),
        }
    }
}

#[derive(Clone, Debug)]
struct DaemonSessionValue {
    session: CliSession,
    source: Option<DaemonSessionSource>,
    generation: u64,
    saved_session_reload_gate: Arc<AsyncMutex<()>>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDaemonRun {
    #[cfg(windows)]
    #[serde(skip_serializing_if = "Option::is_none", default)]
    handoff: Option<PersistedWindowsRunHandoff>,
    pid: u32,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    cwd: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    execution_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    resume_session_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    repo_pool_binding: Option<DaemonRepoPoolBinding>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    auth_capability: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    request_capability: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    request_context: Option<DaemonRequestAgentContext>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    status_file_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    stdout_log_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    stderr_log_path: Option<PathBuf>,
    updated_at: String,
}

struct DaemonSpawnResultParts {
    ok: bool,
    spawned_at: Option<String>,
    pid: Option<u32>,
    error: Option<String>,
    metadata: Option<Value>,
}

impl DaemonSpawnResultParts {
    fn into_report(self, intent: &DaemonSpawnRequest) -> MachineDaemonReport {
        daemon_spawn_result_message(
            self.ok,
            self.spawned_at,
            self.pid,
            self.error,
            self.metadata,
            intent,
        )
    }
}

fn conflicting_daemon_spawn_result(intent: &DaemonSpawnRequest) -> MachineDaemonReport {
    daemon_spawn_result_message(
        false,
        None,
        None,
        Some("spawn authority conflicts with an existing live run".into()),
        None,
        intent,
    )
}

enum DaemonSpawnClaim {
    Claimed(Option<String>),
    Existing(DaemonSpawnResultParts),
    Conflict,
    Inflight,
}

struct DaemonSpawnLog<'a> {
    runtime: &'a str,
    workspace_name: &'a str,
    agent_name: &'a str,
}

#[derive(Clone)]
struct DaemonSpawnRequest {
    registration: Option<xmatrix_cli_core::agent_registration::RegistrationLaunchBinding>,
    request_id: String,
    space_id: String,
    launch_id: Option<String>,
    run_id: Option<String>,
    instance_id: Option<String>,
    launcher_id: Option<String>,
    materializer_id: Option<String>,
    execution_key: Option<String>,
    workspace: protocol::DaemonSpawnWorkspace,
    management_space_id: Option<String>,
    channel_id: String,
    runtime: String,
    runtime_args: Vec<String>,
    agent_backend: Option<String>,
    agent_preset_id: Option<String>,
    harness: Option<xmatrix_cli_core::machine_daemon_connection::AgentHarnessSpec>,
    agent_acp_args: Vec<String>,
    agent_name: String,
    identity_id: Option<String>,
    /// The registration's instructions (see `MachineSpawnAgent`).
    role_initial_prompt: Option<String>,
    /// The registration's working mode (see `MachineSpawnAgent`).
    working_mode: Option<String>,
    /// The Space's rules page (see `MachineSpawnAgent`).
    space_rules_page_id: Option<String>,
    resume: bool,
    resume_instance_id: Option<String>,
    resume_session_key: Option<String>,
    repo_identity: Option<String>,
    repo_key_id: Option<String>,
    slot_id: Option<String>,
    resume_worktree_bootstrap: bool,
    handoff_transfer: bool,
    handoff_source_instance_id: Option<String>,
    handoff_source_resume_session_key: Option<String>,
    goal: Option<protocol::AgentGoalStatus>,
    run_worktree: bool,
    remote_repo: Option<String>,
    /// Channel message that summoned this run; acknowledged once by the wrapper
    /// so catch-up replay never re-delivers the message that started the work.
    source_message_id: Option<String>,
    initial_message_source: Option<protocol::AgentRuntimeMessageSource>,
    requested_model: Option<String>,
    requested_effort: Option<String>,
    requested_parameters: Option<BTreeMap<String, String>>,
    prompt: String,
    attachments: Option<Vec<protocol::ChannelAttachment>>,
    relay_lease: Option<MachineDaemonCommandLease>,
}

impl DaemonSpawnRequest {
    fn from_command(command: MachineDaemonCommand) -> Option<Self> {
        let MachineDaemonCommand::MachineSpawnAgent {
            request_id,
            registration,
            space_id,
            run_id,
            instance_id,
            launcher_id,
            materializer_id,
            execution_key,
            launch_id,
            workspace,
            management_space_id,
            channel_id,
            runtime,
            runtime_args,
            agent_backend,
            agent_preset_id,
            harness,
            agent_acp_args,
            agent_name,
            identity_id,
            role_initial_prompt,
            working_mode,
            space_rules_page_id,
            resume,
            resume_instance_id,
            resume_session_key,
            repo_identity,
            repo_key_id,
            slot_id,
            resume_worktree_bootstrap,
            handoff_transfer,
            handoff_source_instance_id,
            handoff_source_resume_session_key,
            context,
            goal,
            run_worktree,
            remote_repo,
            source_message_id,
            prompt,
            attachments,
            relay_lease,
        } = command
        else {
            return None;
        };

        Some(Self {
            request_id,
            registration,
            space_id,
            launch_id,
            run_id,
            instance_id,
            launcher_id,
            materializer_id,
            execution_key,
            workspace,
            management_space_id,
            channel_id,
            runtime,
            runtime_args: runtime_args.unwrap_or_default(),
            agent_backend,
            agent_preset_id,
            harness,
            agent_acp_args: agent_acp_args.unwrap_or_default(),
            agent_name,
            identity_id,
            role_initial_prompt,
            working_mode,
            space_rules_page_id,
            resume: resume.unwrap_or(false),
            resume_instance_id,
            resume_session_key,
            repo_identity,
            repo_key_id,
            slot_id,
            resume_worktree_bootstrap: resume_worktree_bootstrap.unwrap_or(false),
            handoff_transfer: handoff_transfer.unwrap_or(false),
            handoff_source_instance_id,
            handoff_source_resume_session_key,
            initial_message_source: context
                .as_ref()
                .and_then(|value| value.initial_message_source.clone()),
            requested_model: context
                .as_ref()
                .and_then(|value| value.requested_model.clone()),
            requested_parameters: context
                .as_ref()
                .and_then(|value| value.requested_parameters.clone()),
            requested_effort: context
                .as_ref()
                .and_then(|value| value.requested_effort.clone()),
            goal: context.and_then(|value| value.goal).or(goal),
            run_worktree: run_worktree.unwrap_or(false),
            remote_repo,
            source_message_id,
            prompt,
            attachments,
            relay_lease,
        })
    }

    fn attachments(&self) -> Option<&[protocol::ChannelAttachment]> {
        self.attachments.as_deref()
    }

    fn source_message_id(&self) -> Option<&str> {
        self.source_message_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }
}

#[derive(Debug, Deserialize)]
struct DaemonControlResponse {
    commands: Vec<MachineDaemonCommand>,
}

struct DaemonLock {
    _file: std::fs::File,
}

struct SpawnedHeadlessAgent {
    child: std::process::Child,
    process_tree: process_tree::ProcessTreeGuard,
    cwd: PathBuf,
    run_id: Option<String>,
    execution_key: Option<String>,
    instance_id: Option<String>,
    resume_session_key: Option<String>,
    repo_pool_binding: Option<DaemonRepoPoolBinding>,
    agent_id: Option<String>,
    agent_name: String,
    spawned_at: String,
    pid: u32,
    status_file_path: Option<PathBuf>,
    stdout_log_path: Option<PathBuf>,
    stderr_log_path: Option<PathBuf>,
    #[cfg(windows)]
    adoption_evidence: Option<xmatrix_windows_continuity::RunEvidence>,
    _auth_grant: Option<DaemonAuthGrant>,
    _request_grant: Option<DaemonRequestGrant>,
}

struct DaemonRunExit {
    task_execution: Option<protocol::AgentRuntimeExecutionSnapshot>,
    operation_failure: Option<protocol::AgentOperationFailure>,
    wrapper_version: Option<String>,
    startup_steps: Vec<xmatrix_cli_core::machine_daemon_connection::MachineStartupStep>,
    connection_retry: Option<xmatrix_cli_core::machine_daemon_connection::MachineConnectionRetry>,
    wrapper_ready_at_millis: Option<u64>,
    registry_key: Option<String>,
    run_id: Option<String>,
    execution_key: Option<String>,
    agent_id: Option<String>,
    agent_name: Option<String>,
    pid: u32,
    pub(crate) status: String,
    exit_code: Option<i32>,
    status_phase: Option<String>,
    run_status_detail: Option<String>,
    completed: Option<bool>,
    delivered: Option<bool>,
    status_file_path: Option<PathBuf>,
    stdout_log_path: Option<String>,
    stderr_log_path: Option<String>,
    repo_pool_authority: Option<DaemonRepoPoolRunAuthority>,
    /// `sleeping` when this daemon ended the idle Run (docs/instance-sleep.md §2).
    rest_reason: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct DaemonRepoPoolRunAuthority {
    binding: DaemonRepoPoolBinding,
    request: repo_pool::LeaseRequest,
}

impl DaemonRepoPoolRunAuthority {
    fn binding_authority(&self) -> repo_pool::BindingAuthority {
        repo_pool::BindingAuthority {
            session_key: self.request.session_key.clone(),
            instance_id: self.request.instance_id.clone(),
            run_id: self.request.run_id.clone(),
            execution_key: self.request.execution_key.clone(),
            slot_id: self.binding.slot_id.clone(),
        }
    }
}

#[derive(Clone)]
struct DaemonAuthBroker {
    url: String,
    session_reload_capability: String,
    capabilities: Arc<Mutex<HashMap<String, DaemonAgentAuthGrantState>>>,
    git_credentials: DaemonGitCredentialGrants,
}

struct DaemonAuthGrant {
    url: String,
    capability: String,
    capability_key: String,
    capabilities: Arc<Mutex<HashMap<String, DaemonAgentAuthGrantState>>>,
    /// Carried alongside so a spawn can add a Git credential grant for the same
    /// run once the repository it is for is known.
    git_credentials: DaemonGitCredentialGrants,
}

#[cfg(windows)]
impl DaemonAuthGrant {
    /// Restored grants retain an admitted verifier, not the original raw secret.
    /// Both forms are already accepted by the run-scoped broker.
    fn broker_capability(&self) -> &str {
        if self.capability.is_empty() {
            &self.capability_key
        } else {
            &self.capability
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonAgentAuthContext {
    agent_id: String,
    agent_name: String,
    space_id: String,
    channel_id: String,
    run_id: String,
    execution_key: String,
}

#[derive(Clone, Debug)]
struct DaemonAgentAuthGrantState {
    context: DaemonAgentAuthContext,
    /// The Run token this grant last handed out, while it may still be reused.
    held_token: Option<HeldAgentRunToken>,
}

/// How long after it was minted the broker hands out the same Run token again.
///
/// Every `xmatrix` command an Agent runs asks the broker for a token, and each
/// fresh one costs the Hub a Run read and a registration check; an Agent
/// running commands back to back made that a leading source of database load.
/// The Hub signs a token for ten minutes and the wrapper holds one for up to
/// its eight-minute refresh interval, so a token is reused only while it
/// still outlives that interval with time to spare.
const AGENT_RUN_TOKEN_REUSE: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
struct HeldAgentRunToken {
    token: String,
    minted_at: std::time::Instant,
}

impl HeldAgentRunToken {
    fn now(token: String) -> Self {
        Self {
            token,
            minted_at: std::time::Instant::now(),
        }
    }

    fn reusable_at(&self, now: std::time::Instant) -> Option<&str> {
        (now.saturating_duration_since(self.minted_at) < AGENT_RUN_TOKEN_REUSE)
            .then_some(self.token.as_str())
    }
}

/// What a single run is allowed to obtain Git credentials for.
///
/// Kept apart from [`DaemonAgentAuthGrantState`] on purpose. That grant is the
/// general run identity every agent holds; folding GitHub credentials into it
/// would hand the ability to obtain repository write access to every run,
/// including the ones that never touch Git. This table is issued only where Git
/// work is actually going to happen.
///
/// Every field is fixed when the grant is issued, from the spawn command the
/// daemon was given. Nothing the holder sends can change which Space, run, or
/// repository the grant refers to.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DaemonGitCredentialGrantState {
    pub(crate) channel_id: String,
    pub(crate) run_id: String,
    pub(crate) execution_key: String,
    /// Canonical `owner/repo`. A request for anything else is refused rather
    /// than widened.
    pub(crate) repository: String,
}

pub(crate) type DaemonGitCredentialGrants =
    Arc<Mutex<HashMap<String, DaemonGitCredentialGrantState>>>;

/// Give this run a capability that speaks only for `repository`.
///
/// Returned as the value to place in the run's environment. The grant itself
/// stays with the daemon, which is what keeps the run from being able to widen
/// it.
pub(crate) fn issue_git_credential_grant(
    grants: &DaemonGitCredentialGrants,
    state: DaemonGitCredentialGrantState,
) -> Option<String> {
    let capability = uuid::Uuid::new_v4().to_string();
    grants.lock().ok()?.insert(capability.clone(), state);
    Some(capability)
}

/// Drop every Git credential grant belonging to one run.
///
/// Called when the run ends: a capability that outlived its run would keep
/// working, and the environment holding it may still exist in a stale process.
pub(crate) fn revoke_git_credential_grants_for_run(
    grants: &DaemonGitCredentialGrants,
    run_id: &str,
    execution_key: &str,
) {
    if let Ok(mut table) = grants.lock() {
        table.retain(|_, grant| !(grant.run_id == run_id && grant.execution_key == execution_key));
    }
}

/// The `owner/repo` a pool identity refers to, when it refers to GitHub at all.
///
/// Identities for other hosts exist and simply have no connector token behind
/// them, so they yield nothing rather than a guess.
pub(crate) fn github_repository_of_pool_identity(identity: &str) -> Option<String> {
    let rest = identity.strip_prefix("github.com/")?;
    let mut segments = rest.split('/');
    let owner = segments.next()?;
    let repo = segments.next()?;
    if owner.is_empty() || repo.is_empty() || segments.next().is_some() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

/// Resolve a capability to its grant, and only if it names the same repository.
///
/// Unlike the agent auth grant this does not consume the capability: Git asks
/// again on every fetch and push for the life of the run.
pub(crate) fn resolve_git_credential_grant(
    grants: &DaemonGitCredentialGrants,
    capability: &str,
    repository: &str,
) -> Option<DaemonGitCredentialGrantState> {
    let grant = grants.lock().ok()?.get(capability).cloned()?;
    // GitHub treats repository names case-insensitively and the pool's canonical
    // identity is lowercased, while Git reports the path exactly as the remote
    // URL spells it. Comparing byte-for-byte would refuse the run's own
    // repository whenever the remote is written in its display casing.
    (grant.repository.eq_ignore_ascii_case(repository)).then_some(grant)
}

/// The Run a presented capability speaks for, and a token it may reuse.
fn take_daemon_agent_auth_grant(
    capabilities: &Arc<Mutex<HashMap<String, DaemonAgentAuthGrantState>>>,
    capability: &str,
) -> Option<(DaemonAgentAuthContext, Option<String>)> {
    // A live Run keeps its raw capability in its wrapper environment, but the
    // daemon persists only the derived verifier key -- and a replacement daemon
    // re-authorizes that exact key. So after a restart the daemon's own send
    // path holds the key where a fresh spawn would hold the raw value. Hashing
    // it a second time matched nothing, and the Run could never mint a token
    // again: it stayed authorized to the Hub while `xmatrix send` failed
    // `unauthorized` for the rest of its life.
    //
    // Admit the proof the restore already accepted. This grants no new reach:
    // the map only ever holds Runs this daemon spawned or restored, and reading
    // a key requires the owner-only run registry -- the same OS account that
    // could read the raw capability out of the live wrapper's environment.
    let now = std::time::Instant::now();
    capabilities.lock().ok().and_then(|capabilities| {
        let grant = daemon_capability_candidates(capability).find_map(|key| capabilities.get(&key))?;
        let reusable = grant
            .held_token
            .as_ref()
            .and_then(|held| held.reusable_at(now))
            .map(str::to_string);
        Some((grant.context.clone(), reusable))
    })
}

/// Keep a token just minted for this capability, unless its grant was
/// revoked or reissued for another Run while the mint was in flight.
fn hold_daemon_agent_run_token(
    capabilities: &Arc<Mutex<HashMap<String, DaemonAgentAuthGrantState>>>,
    capability: &str,
    context: &DaemonAgentAuthContext,
    token: &str,
) {
    if let Ok(mut capabilities) = capabilities.lock() {
        let key = daemon_capability_candidates(capability).find(|key| capabilities.contains_key(key));
        let grant = key.and_then(|key| capabilities.get_mut(&key));
        if let Some(grant) = grant.filter(|grant| &grant.context == context) {
            grant.held_token = Some(HeldAgentRunToken::now(token.to_string()));
        }
    }
}

/// Which stored keys a presented capability may name, most exact first.
///
/// A live Run presents the raw capability from its environment; a Run that a
/// replacement daemon restored is spoken for by the persisted verifier key,
/// because the raw value only ever existed in the original process. Both
/// brokers admit Runs by this same rule — keeping two copies of it is how one
/// broker came to accept a restored Run while the other refused it, leaving a
/// Run that was alive and trusted unable to send for the rest of its life.
fn daemon_capability_candidates(presented: &str) -> impl Iterator<Item = String> + use<> {
    [
        Some(daemon_capability_key(presented)),
        persisted_daemon_capability_key(presented),
    ]
    .into_iter()
    .flatten()
}

fn daemon_capability_key(capability: &str) -> String {
    format!(
        "sha256:{}",
        lowercase_hex(&Sha256::digest(capability.as_bytes()))
    )
}

fn persisted_daemon_capability_key(value: &str) -> Option<String> {
    let value = value.trim();
    let digest = value.strip_prefix("sha256:")?;
    (digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| format!("sha256:{}", digest.to_ascii_lowercase()))
}

/// The verifier key a recovery record speaks for.
///
/// Recovery records carry the one-way key. A pre-registration repo pool
/// sidecar written by an older daemon carried the raw capability instead;
/// reading that as "no key" dropped the grant of a Run that was alive and
/// trusted, so derive its key the same way issuance did.
fn restorable_daemon_capability_key(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    persisted_daemon_capability_key(value)
        .or_else(|| (!value.starts_with("sha256:")).then(|| daemon_capability_key(value)))
}

#[derive(Clone)]
struct DaemonRequestBroker {
    url: String,
    owner_capability: String,
    agent_capabilities: Arc<Mutex<HashMap<String, DaemonRequestAgentContext>>>,
    machine_id: Option<String>,
    hub_url: Option<String>,
    auth_broker_url: Option<String>,
    run_registry: DaemonRunRegistry,
}

struct DaemonRequestGrant {
    capability: String,
    capability_key: String,
    context: DaemonRequestAgentContext,
    capabilities: Arc<Mutex<HashMap<String, DaemonRequestAgentContext>>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonRequestAgentContext {
    agent_id: Option<String>,
    agent_name: String,
    /// Added after this struct was already being persisted in run sidecars, so
    /// it must default on read: serde rejects the *whole* record for one
    /// missing field, and losing the record loses the daemon's only handle on
    /// a live child — it can no longer report that run's exit at all.
    #[serde(default)]
    space_id: String,
    /// Human-visible Channel where a request may surface an approval card.
    /// Sidecars of retired management mirror Runs may still carry `None`.
    #[serde(default)]
    approval_channel_id: Option<String>,
    /// Runtime Channel binding. This remains independent from approval UI.
    channel_id: String,
    run_id: Option<String>,
    execution_key: Option<String>,
    workspace_cwd: String,
    /// Secrets this Run's registration admitted at launch; Hub refuses any
    /// other secret request from it. `None` for a Run without a registration
    /// binding, whose secret requests are decided by Hub alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    admitted_secrets: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonRequestBrokerState {
    #[serde(default)]
    profile_id: Option<String>,
    url: String,
    owner_capability: String,
    updated_at: String,
}

/// A Windows run's request that the daemon start and admit its handoff
/// replacement (`/request/handoff-run`).
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DaemonRunHandoffPayload {
    run_id: String,
    execution_key: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DaemonRunRebindPayload {
    run_id: String,
    execution_key: String,
    new_pid: u32,
}

impl DaemonAuthBroker {
    fn issue_grant(
        &self,
        context: DaemonAgentAuthContext,
        initial_token: String,
    ) -> DaemonAuthGrant {
        let capability = uuid::Uuid::new_v4().to_string();
        let capability_key = daemon_capability_key(&capability);
        self.allow_capability_key(
            &capability_key,
            context,
            Some(HeldAgentRunToken::now(initial_token)),
        );
        DaemonAuthGrant {
            url: self.url.clone(),
            capability,
            capability_key,
            capabilities: self.capabilities.clone(),
            git_credentials: self.git_credentials.clone(),
        }
    }

    fn restore_grant_key(
        &self,
        capability_key: String,
        context: DaemonAgentAuthContext,
    ) -> Option<DaemonAuthGrant> {
        let capability_key = restorable_daemon_capability_key(&capability_key)?;
        self.allow_capability_key(&capability_key, context, None);
        Some(DaemonAuthGrant {
            url: self.url.clone(),
            capability: String::new(),
            capability_key,
            capabilities: self.capabilities.clone(),
            git_credentials: self.git_credentials.clone(),
        })
    }

    fn allow_capability_key(
        &self,
        capability_key: &str,
        context: DaemonAgentAuthContext,
        held_token: Option<HeldAgentRunToken>,
    ) {
        if let Ok(mut capabilities) = self.capabilities.lock() {
            capabilities.insert(
                capability_key.to_string(),
                DaemonAgentAuthGrantState {
                    context,
                    held_token,
                },
            );
        }
    }
}

impl DaemonRequestBroker {
    fn issue_agent_grant(&self, context: DaemonRequestAgentContext) -> DaemonRequestGrant {
        let capability = uuid::Uuid::new_v4().to_string();
        let capability_key = daemon_capability_key(&capability);
        self.allow_agent_capability_key(&capability_key, context.clone());
        DaemonRequestGrant {
            capability,
            capability_key,
            context,
            capabilities: self.agent_capabilities.clone(),
        }
    }

    fn restore_agent_grant_key(
        &self,
        capability_key: String,
        context: DaemonRequestAgentContext,
    ) -> Option<DaemonRequestGrant> {
        let capability_key = restorable_daemon_capability_key(&capability_key)?;
        self.allow_agent_capability_key(&capability_key, context.clone());
        Some(DaemonRequestGrant {
            capability: String::new(),
            capability_key,
            context,
            capabilities: self.agent_capabilities.clone(),
        })
    }

    fn allow_agent_capability_key(&self, capability_key: &str, context: DaemonRequestAgentContext) {
        if let Ok(mut capabilities) = self.agent_capabilities.lock() {
            capabilities.insert(capability_key.to_string(), context);
        }
    }
}

impl Drop for DaemonAuthGrant {
    fn drop(&mut self) {
        // Read the run this grant spoke for before removing it, so the Git
        // credential grants issued alongside go with it. A capability that
        // outlived its run would keep working, and the environment holding it
        // may still exist in a process that has not finished dying.
        let run = self
            .capabilities
            .lock()
            .ok()
            .and_then(|capabilities| capabilities.get(&self.capability_key).cloned())
            .map(|state| (state.context.run_id, state.context.execution_key));
        if let Some((run_id, execution_key)) = run {
            revoke_git_credential_grants_for_run(&self.git_credentials, &run_id, &execution_key);
        }
        if let Ok(mut capabilities) = self.capabilities.lock() {
            capabilities.remove(&self.capability_key);
        }
    }
}

impl Drop for DaemonRequestGrant {
    fn drop(&mut self) {
        if let Ok(mut capabilities) = self.capabilities.lock() {
            capabilities.remove(&self.capability_key);
        }
    }
}

#[derive(Clone, Debug)]
struct DaemonRunFiles {
    status_file_path: PathBuf,
    stdout_log_path: PathBuf,
    stderr_log_path: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonRunStatusMarker {
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "xmatrix_cli_core::protocol::deserialize_optional_execution_snapshot"
    )]
    task_execution: Option<protocol::AgentRuntimeExecutionSnapshot>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "xmatrix_cli_core::protocol::deserialize_optional_operation_failure"
    )]
    operation_failure: Option<protocol::AgentOperationFailure>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    startup_steps: Vec<xmatrix_cli_core::machine_daemon_connection::MachineStartupStep>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    connection_retry: Option<xmatrix_cli_core::machine_daemon_connection::MachineConnectionRetry>,
    phase: String,
    completed: bool,
    delivered: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    effort: Option<String>,
    /// Native tools may run before stdout presentation reaches the Hub. Only
    /// the owning wrapper writes this bounded first-presentation send gate.
    #[serde(default)]
    presentation_pending: bool,
    pid: u32,
    updated_at_millis: u64,
    /// Wrapper self-description recorded by the sidecar-owned wrapper's own
    /// heartbeat so `xmatrix update-self` can respawn it faithfully: the exact
    /// executable, argv tail, and running release version. Absent on wrappers
    /// that predate self-service updates.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    wrapper_exe: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    wrapper_args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    wrapper_version: Option<String>,
    /// Stamped once this wrapper is actually serving its run: registered with
    /// the Hub and, when it has one, joined its auto-join channel. A live
    /// update hands off on this signal — a replacement that never reaches it
    /// must not be allowed to replace a working wrapper.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    wrapper_ready_at_millis: Option<u64>,
    /// Background tasks the provider itself reports as still running (Claude's
    /// `system/task_started` until its `system/task_notification`). A Run with
    /// one is busy even between turns: it neither sleeps nor moves to a new
    /// version. `None` when the runtime reports no such events.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    background_tasks: Option<u32>,
    /// Wake metrics this wrapper observed (docs/instance-sleep.md §8). The
    /// daemon records them once the Run ends.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    wake: Option<runtime_wake_metrics::RunWakeMetrics>,
}

type DaemonAuthBrokerState = daemon_auth::DaemonAuthBrokerState;

fn unix_millis_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}

fn daemon_run_log_dir() -> PathBuf {
    non_empty_env("XMATRIX_RUN_LOG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| daemon_run_state_root().join("runs"))
}

fn daemon_run_log_dir_is_default() -> bool {
    std::env::var("XMATRIX_RUN_LOG_DIR")
        .ok()
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
}

#[derive(Default)]
struct DaemonRunArtifactGroup {
    paths: Vec<PathBuf>,
    newest_millis: u64,
    protected: bool,
}

fn daemon_run_artifact_label(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    [
        ".registry.json",
        ".status.json",
        ".handoff.json",
        ".out.log",
        ".err.log",
    ]
    .iter()
    .find_map(|suffix| name.strip_suffix(suffix))
    .map(str::to_string)
    .filter(|label| !label.is_empty())
}

fn daemon_run_artifact_modified_millis(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn prune_daemon_run_artifacts_in_dir(
    dir: &Path,
    protected_status_paths: &HashSet<PathBuf>,
    now_millis: u64,
) -> (usize, usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    let mut groups = HashMap::<String, DaemonRunArtifactGroup>::new();
    for path in entries.filter_map(Result::ok).map(|entry| entry.path()) {
        let Some(label) = daemon_run_artifact_label(&path) else {
            continue;
        };
        let group = groups.entry(label).or_default();
        group.newest_millis = group
            .newest_millis
            .max(daemon_run_artifact_modified_millis(&path));
        group.protected |= protected_status_paths.contains(&path)
            || path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".registry.json"));
        group.paths.push(path);
    }

    let mut candidates = groups
        .into_iter()
        .filter(|(_, group)| {
            !group.protected
                && now_millis.saturating_sub(group.newest_millis)
                    > DAEMON_RUN_ARTIFACT_RETENTION_GRACE_MILLIS
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|(left_label, left), (right_label, right)| {
        right
            .newest_millis
            .cmp(&left.newest_millis)
            .then_with(|| left_label.cmp(right_label))
    });

    let mut removed_groups = 0;
    let mut removed_files = 0;
    for (index, (_, group)) in candidates.into_iter().enumerate() {
        let expired = now_millis.saturating_sub(group.newest_millis)
            > DAEMON_RUN_ARTIFACT_RETENTION_MAX_AGE_MILLIS;
        if !expired && index < DAEMON_RUN_ARTIFACT_RETENTION_MAX_GROUPS {
            continue;
        }
        let mut removed_any = false;
        for path in group.paths {
            if std::fs::remove_file(path).is_ok() {
                removed_files += 1;
                removed_any = true;
            }
        }
        removed_groups += usize::from(removed_any);
    }
    (removed_groups, removed_files)
}

fn daemon_run_status_is_recent(marker: &DaemonRunStatusMarker) -> bool {
    const MAX_AGE_MILLIS: u64 = 7 * 24 * 60 * 60 * 1000;
    daemon_run_status_age_within(marker, MAX_AGE_MILLIS)
}

fn daemon_run_status_age_within(marker: &DaemonRunStatusMarker, max_age_millis: u64) -> bool {
    unix_millis_now().saturating_sub(marker.updated_at_millis) <= max_age_millis
}

fn sanitize_daemon_run_file_label(value: &str) -> String {
    const MAX_LABEL_BYTES: usize = 96;
    const DIGEST_BYTES: usize = 12;

    let mut label = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    let normalized_without_loss =
        label == value.trim_matches('-') && label.len() <= MAX_LABEL_BYTES;
    if normalized_without_loss && !label.is_empty() {
        return label;
    }

    let digest = Sha256::digest(value.as_bytes());
    let suffix = lowercase_hex(&digest[..DIGEST_BYTES]);
    let prefix_limit = MAX_LABEL_BYTES - suffix.len() - 1;
    if label.len() > prefix_limit {
        label.truncate(prefix_limit);
    }
    let prefix = label.trim_matches('-');
    if prefix.is_empty() {
        format!("run-{suffix}")
    } else {
        format!("{prefix}-{suffix}")
    }
}

fn daemon_run_file_label(
    run_id: Option<&str>,
    execution_key: Option<&str>,
    agent_name: &str,
) -> String {
    let raw = run_id
        .or(execution_key)
        .map(str::to_string)
        .unwrap_or_else(|| format!("{agent_name}-{}", uuid::Uuid::new_v4()));
    sanitize_daemon_run_file_label(&raw)
}

fn daemon_run_status_writer_pid(path: &Path) -> Option<u32> {
    let persisted_pid = daemon_run_sidecar_path_for_status(path).and_then(|sidecar_path| {
        let raw = std::fs::read_to_string(&sidecar_path).ok()?;
        let run = serde_json::from_str::<PersistedDaemonRun>(&raw).ok()?;
        (daemon_run_sidecar_path(&run).as_deref() == Some(sidecar_path.as_path())
            && run.status_file_path.as_deref() == Some(path))
        .then_some(run.pid)
    });
    match persisted_pid {
        Some(pid) if pid == std::process::id() => Some(pid),
        Some(_) => None,
        None => Some(std::process::id()),
    }
}

fn normalized_startup_phase(phase: &str) -> Option<&str> {
    match phase {
        "wrapper_starting"
        | "cwd_preparing"
        | "cwd_ready"
        | "auth_resolving"
        | "workspace_registering"
        | "relay_registering"
        | "relay_registered"
        | "channel_joined"
        | "turn_running" => Some(phase),
        "runtime_starting" | "codex_app_starting" | "zcode_app_starting" | "grok_app_starting"
        | "acp_app_starting" => Some("runtime_starting"),
        "runtime_ready" | "codex_app_ready" | "zcode_app_ready" | "grok_app_ready"
        | "acp_app_ready" => Some("runtime_ready"),
        _ => None,
    }
}

fn record_startup_step(
    steps: &mut Vec<xmatrix_cli_core::machine_daemon_connection::MachineStartupStep>,
    phase: &str,
    at_millis: u64,
) {
    steps.truncate(16);
    let Some(phase) = normalized_startup_phase(phase) else {
        return;
    };
    if steps.len() < 16 && !steps.iter().any(|step| step.phase == phase) {
        steps.push(
            xmatrix_cli_core::machine_daemon_connection::MachineStartupStep {
                phase: phase.to_string(),
                at_millis,
            },
        );
    }
}

fn write_daemon_run_status_marker_to_path(
    path: &Path,
    phase: &str,
    completed: bool,
    detail: Option<&str>,
) {
    write_daemon_run_status_marker_with_failure(path, phase, completed, detail, None);
}

fn write_daemon_run_status_marker_with_failure(
    path: &Path,
    phase: &str,
    completed: bool,
    detail: Option<&str>,
    failure: Option<&protocol::AgentOperationFailure>,
) {
    let Ok(_guard) = DAEMON_RUN_STATUS_WRITE_LOCK.lock() else {
        return;
    };
    // Nested `xmatrix` commands inherit XMATRIX_RUN_STATUS_FILE from the
    // managed wrapper. Only the sidecar-owned wrapper may mutate that file;
    // otherwise a short-lived nested command can make the live run appear
    // terminal and cause the daemon to delete its recovery sidecar.
    let Some(pid) = daemon_run_status_writer_pid(path) else {
        return;
    };
    let existing = std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<DaemonRunStatusMarker>(&raw).ok());
    let mut startup_steps = existing
        .as_ref()
        .filter(|marker| marker.pid == pid)
        .map(|marker| marker.startup_steps.clone())
        .unwrap_or_default();
    record_startup_step(&mut startup_steps, phase, unix_millis_now());
    let marker = DaemonRunStatusMarker {
        task_execution: existing
            .as_ref()
            .filter(|marker| marker.pid == pid)
            .and_then(|marker| marker.task_execution.clone()),
        operation_failure: failure
            .filter(|failure| failure.is_valid_observation())
            .cloned(),
        startup_steps,
        connection_retry: existing
            .as_ref()
            .filter(|marker| marker.pid == pid)
            .and_then(|marker| marker.connection_retry.clone())
            .map(|mut retry| {
                retry.next_attempt_at_millis = None;
                retry
            }),
        phase: phase.to_string(),
        completed,
        // Execution phases have no Channel commit receipt. Keep this legacy
        // field false; reply delivery is a separate authority-owned fact.
        delivered: false,
        detail: detail.map(str::to_string),
        model: existing.as_ref().and_then(|marker| marker.model.clone()),
        effort: existing.as_ref().and_then(|marker| marker.effort.clone()),
        presentation_pending: existing
            .as_ref()
            .filter(|marker| marker.pid == pid)
            .is_some_and(|marker| marker.presentation_pending),
        pid,
        updated_at_millis: unix_millis_now(),
        wrapper_exe: existing
            .as_ref()
            .and_then(|marker| marker.wrapper_exe.clone()),
        wrapper_args: existing
            .as_ref()
            .and_then(|marker| marker.wrapper_args.clone()),
        wrapper_version: existing
            .as_ref()
            .and_then(|marker| marker.wrapper_version.clone()),
        wrapper_ready_at_millis: existing
            .as_ref()
            .and_then(|marker| marker.wrapper_ready_at_millis),
        background_tasks: existing
            .as_ref()
            .filter(|marker| marker.pid == pid)
            .and_then(|marker| marker.background_tasks),
        wake: existing
            .as_ref()
            .filter(|marker| marker.pid == pid)
            .and_then(|marker| marker.wake.clone()),
    };
    let _ = persist_daemon_run_status_marker_unlocked(path, &marker);
}

#[cfg(test)]
fn persist_daemon_run_status_marker(path: &Path, marker: &DaemonRunStatusMarker) -> bool {
    let Ok(_guard) = DAEMON_RUN_STATUS_WRITE_LOCK.lock() else {
        return false;
    };
    persist_daemon_run_status_marker_unlocked(path, marker)
}

fn persist_daemon_run_status_marker_unlocked(path: &Path, marker: &DaemonRunStatusMarker) -> bool {
    let Ok(bytes) = serde_json::to_vec_pretty(marker) else {
        return false;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp_path = config::unique_temporary_path(path);
    if write_daemon_private_file(&tmp_path, &bytes).is_err() {
        let _ = std::fs::remove_file(&tmp_path);
        return false;
    }
    if config::replace_file_atomically(&tmp_path, path).is_err() {
        let _ = std::fs::remove_file(&tmp_path);
        return false;
    }
    true
}

fn update_daemon_run_status_marker(
    path: &Path,
    update: impl FnOnce(&mut DaemonRunStatusMarker),
) -> bool {
    let Ok(_guard) = DAEMON_RUN_STATUS_WRITE_LOCK.lock() else {
        return false;
    };
    let Some(mut marker) = read_daemon_run_status_marker(Some(path)) else {
        return false;
    };
    update(&mut marker);
    persist_daemon_run_status_marker_unlocked(path, &marker)
}

fn write_current_run_status(phase: &str, completed: bool, detail: Option<&str>) {
    if phase == "turn_completed" {
        crate::clear_pending_usage_limit();
    }
    let Some(path) = std::env::var_os("XMATRIX_RUN_STATUS_FILE").map(PathBuf::from) else {
        return;
    };
    write_daemon_run_status_marker_to_path(&path, phase, completed, detail);
}

fn write_current_run_error_status(phase: &str, completed: bool, error: &CliError) {
    let Some(path) = std::env::var_os("XMATRIX_RUN_STATUS_FILE").map(PathBuf::from) else {
        return;
    };
    let detail = truncate_chars(&error.to_string(), 2_000);
    write_daemon_run_status_marker_with_failure(
        &path,
        phase,
        completed,
        Some(&detail),
        error.operation_failure(),
    );
}

fn write_task_execution_to_path(path: &Path, state: protocol::AgentRuntimeState) {
    let Some(pid) = daemon_run_status_writer_pid(path) else {
        return;
    };
    update_daemon_run_status_marker(path, |marker| {
        if marker.pid != pid {
            return;
        }
        marker.task_execution = Some(protocol::AgentRuntimeExecutionSnapshot {
            execution: state.execution,
            recent_executions: state.recent_executions,
        });
    });
}

fn write_current_connection_retry(attempt: u32, delay_ms: u64) {
    let Some(path) = std::env::var_os("XMATRIX_RUN_STATUS_FILE").map(PathBuf::from) else {
        return;
    };
    let Some(pid) = daemon_run_status_writer_pid(&path) else {
        return;
    };
    update_daemon_run_status_marker(&path, |marker| {
        if marker.pid != pid {
            return;
        }
        marker.connection_retry = Some(
            xmatrix_cli_core::machine_daemon_connection::MachineConnectionRetry {
                attempt,
                kind: Some(
                    if marker.phase == "channel_join_retrying" {
                        "channel_join"
                    } else if marker.phase == "relay_auth_refresh_retrying" {
                        "credential_refresh"
                    } else {
                        "registration"
                    }
                    .into(),
                ),
                next_attempt_at_millis: Some(unix_millis_now().saturating_add(delay_ms)),
            },
        );
    });
}

fn refresh_daemon_run_status_heartbeat(path: &Path) -> bool {
    let Some(pid) = daemon_run_status_writer_pid(path) else {
        return false;
    };
    update_daemon_run_status_marker(path, |marker| {
        marker.pid = pid;
        marker.updated_at_millis = unix_millis_now();
        // Only the sidecar-owned wrapper reaches this write (the pid guard
        // above filters nested commands), so these describe the wrapper
        // process itself — the exact respawn recipe for a version handoff.
        marker.wrapper_exe = std::env::current_exe().ok();
        marker.wrapper_args = Some(std::env::args().skip(1).collect());
        marker.wrapper_version = Some(xmatrix_cli_core::version::current().to_string());
    })
}

/// How long a replacement wrapper gets to register with the Hub and rejoin its
/// channel before the handoff is abandoned and the working wrapper kept.
const UPDATE_SELF_READY_TIMEOUT_SECS: u64 = 90;
const UPDATE_SELF_READY_POLL_MS: u64 = 250;

/// Does this status marker prove the replacement wrapper is serving the run?
///
/// The marker is a single file rewritten by whichever process the sidecar
/// records as the run's wrapper, so every field has to line up: the readiness
/// stamp must belong to the replacement pid, to the version being installed,
/// and to this handoff rather than to a stamp the retiring wrapper left behind.
fn replacement_wrapper_is_ready(
    marker: &DaemonRunStatusMarker,
    replacement_pid: u32,
    latest_version: &str,
    handoff_started_millis: u64,
) -> bool {
    marker.pid == replacement_pid
        && marker.wrapper_version.as_deref() == Some(latest_version)
        && marker
            .wrapper_ready_at_millis
            .is_some_and(|stamped| stamped >= handoff_started_millis)
}

/// Poll the run status file until the replacement proves it is serving, it
/// dies, or the readiness budget runs out.
async fn await_replacement_wrapper_ready(
    status_path: &Path,
    replacement: &mut HandoffReplacement,
    latest_version: &str,
    handoff_started_millis: u64,
) -> std::result::Result<(), String> {
    let deadline =
        tokio::time::Instant::now() + Duration::from_secs(UPDATE_SELF_READY_TIMEOUT_SECS);
    loop {
        if let Some(exited) = replacement.exited() {
            return Err(exited);
        }
        if let Some(marker) = read_daemon_run_status_marker(Some(status_path))
            && replacement_wrapper_is_ready(
                &marker,
                replacement.pid,
                latest_version,
                handoff_started_millis,
            ) {
                return Ok(());
            }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "it did not report ready within {UPDATE_SELF_READY_TIMEOUT_SECS}s"
            ));
        }
        tokio::time::sleep(Duration::from_millis(UPDATE_SELF_READY_POLL_MS)).await;
    }
}

fn update_self_handoff_log_path(wrapper_pid: u32) -> Option<PathBuf> {
    let dir = daemon_run_log_dir();
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("update-self-{wrapper_pid}.log")))
}

/// Two handles onto one append-only log, so a replacement that dies during
/// startup leaves its reason on disk instead of in /dev/null.
#[cfg(not(windows))]
fn update_self_handoff_log(path: &Option<PathBuf>) -> Option<(Stdio, Stdio)> {
    let path = path.as_ref()?;
    let out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()?;
    let err = out.try_clone().ok()?;
    Some((Stdio::from(out), Stdio::from(err)))
}

/// Stamp this wrapper as serving its run. Called once the Hub registration and
/// the initial channel join have both succeeded, so a live-update handoff can
/// wait for proof that the replacement actually came up before retiring the
/// wrapper it replaces.
pub(crate) fn mark_daemon_run_wrapper_ready() {
    let Some(path) = std::env::var_os("XMATRIX_RUN_STATUS_FILE").map(PathBuf::from) else {
        return;
    };
    let Some(pid) = daemon_run_status_writer_pid(&path) else {
        return;
    };
    let _ = update_daemon_run_status_marker(&path, |marker| {
        marker.pid = pid;
        marker.updated_at_millis = unix_millis_now();
        marker.wrapper_exe = std::env::current_exe().ok();
        marker.wrapper_args = Some(std::env::args().skip(1).collect());
        marker.wrapper_version = Some(xmatrix_cli_core::version::current().to_string());
        let ready_at = unix_millis_now();
        marker.wrapper_ready_at_millis = Some(ready_at);
        record_startup_step(&mut marker.startup_steps, "channel_joined", ready_at);
        if let Some(retry) = marker.connection_retry.as_mut() {
            retry.next_attempt_at_millis = None;
        }
        if marker.phase == "relay_register_retrying"
            || marker.phase == "relay_auth_refresh_retrying"
        {
            marker.phase = "runtime_starting".to_string();
        }
    });
}

/// Run phases in which no turn is in flight, so a handoff interrupts nothing.
const IDLE_RUN_PHASES: [&str; 4] = [
    "channel_joined",
    "turn_completed",
    "turn_failed",
    "turn_interrupted",
];

/// A daemon's request that the run it hosts move to the daemon's own CLI
/// version. The daemon writes it next to the run's status file; the wrapper
/// that owns the run carries it out between turns with `update-self`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonHandoffRequest {
    version: String,
    executable: PathBuf,
    requested_at_millis: u64,
}

fn daemon_handoff_request_path(status_path: &Path) -> Option<PathBuf> {
    let name = status_path.file_name()?.to_str()?;
    let label = name.strip_suffix(".status.json")?;
    Some(status_path.with_file_name(format!("{label}.handoff.json")))
}

fn read_daemon_handoff_request(path: &Path) -> Option<DaemonHandoffRequest> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// How often a wrapper looks for its daemon's handoff request.
const DAEMON_HANDOFF_REQUEST_POLL_SECS: u64 = 5;

/// A wrapper outlives CLI updates: an install replaces the file on disk, but
/// this process keeps running the code it started with. The daemon decides
/// when a run moves to a new version; this watch only carries that request
/// out, between turns, with `update-self` from the daemon's executable. Only
/// the wrapper the run's sidecar names answers — commands the Agent runs
/// inherit the status file but never own it — and ownership is checked on
/// every tick because a replacement owns the run only once its predecessor
/// has rebound it.
pub(crate) fn spawn_daemon_handoff_request_watch() -> Option<tokio::task::JoinHandle<()>> {
    let status_path = std::env::var_os("XMATRIX_RUN_STATUS_FILE").map(PathBuf::from)?;
    let request_path = daemon_handoff_request_path(&status_path)?;
    Some(tokio::spawn(async move {
        let mut attempted = None;
        loop {
            tokio::time::sleep(Duration::from_secs(DAEMON_HANDOFF_REQUEST_POLL_SECS)).await;
            let owner = daemon_run_sidecar_path_for_status(&status_path).and_then(|sidecar| {
                let raw = std::fs::read_to_string(sidecar).ok()?;
                serde_json::from_str::<PersistedDaemonRun>(&raw)
                    .ok()
                    .map(|run| run.pid)
            });
            if owner != Some(std::process::id()) {
                continue;
            }
            let Some(request) = read_daemon_handoff_request(&request_path) else {
                continue;
            };
            if request.version == xmatrix_cli_core::version::current() {
                // This wrapper is the replacement the request asked for.
                let _ = std::fs::remove_file(&request_path);
                continue;
            }
            if attempted == Some(request.requested_at_millis) {
                continue;
            }
            let Some(marker) = read_daemon_run_status_marker(Some(&status_path)) else {
                continue;
            };
            if !IDLE_RUN_PHASES.contains(&marker.phase.as_str()) {
                continue;
            }
            // Between turns is not enough: a background task the Agent left
            // running (a CI wait, a Monitor) would be killed by the move and
            // never report back. Only an explicit positive count holds the
            // handoff; unset / zero means no reported watch.
            if marker.background_tasks.is_some_and(|count| count > 0) {
                continue;
            }
            // One attempt per request: a failed handoff keeps this wrapper
            // serving and clears the request, and the daemon asks again later.
            attempted = Some(request.requested_at_millis);
            eprintln!(
                "○ Daemon runs xMatrix CLI {}; handing this idle run to it",
                request.version
            );
            let failure = match tokio::process::Command::new(&request.executable)
                .arg("update-self")
                .stdin(Stdio::null())
                .output()
                .await
            {
                Ok(output) if output.status.success() => None,
                Ok(output) => Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
                Err(error) => Some(format!("could not start: {error}")),
            };
            let Some(failure) = failure else {
                continue;
            };
            let _ = std::fs::remove_file(&request_path);
            eprintln!("⚠ Handoff did not complete; this wrapper keeps serving: {failure}");
            // A refused rebind means the daemon no longer admits this Run;
            // check now, while the current token can still carry a notice to
            // the Channel.
            if update_self_saw_refused_run_grant(&failure) {
                probe_local_authority_now();
            }
        }
    }))
}

fn update_self_saw_refused_run_grant(stderr: &str) -> bool {
    stderr.contains("capability not granted by this daemon")
        || stderr.contains("capability_not_granted")
}

/// How often the daemon looks for hosted runs behind its version.
const DAEMON_RUN_HANDOFF_SCAN_SECS: u64 = 15;
/// A request younger than this is still being carried out, so no other run is
/// asked to move meanwhile: runs move one at a time.
const DAEMON_RUN_HANDOFF_PENDING_MILLIS: u64 = 3 * 60 * 1000;
/// How long a run that did not move waits before it is asked again.
const DAEMON_RUN_HANDOFF_RETRY_MILLIS: u64 = 10 * 60 * 1000;

/// What the daemon knows about one hosted run when it plans a handoff.
struct DaemonRunHandoffCandidate {
    key: String,
    pid: u32,
    marker: Option<DaemonRunStatusMarker>,
    pending: Option<DaemonHandoffRequest>,
}

/// The run the daemon should ask to move next, if any: one whose own wrapper
/// reports an older version and no turn in flight, not asked recently, and
/// only while no other request is still being carried out.
fn next_daemon_run_handoff<'a>(
    candidates: &'a [DaemonRunHandoffCandidate],
    last_requested: &HashMap<String, u64>,
    version: &str,
    now_millis: u64,
) -> Option<&'a DaemonRunHandoffCandidate> {
    let in_progress = candidates.iter().any(|candidate| {
        candidate.pending.as_ref().is_some_and(|request| {
            now_millis.saturating_sub(request.requested_at_millis)
                < DAEMON_RUN_HANDOFF_PENDING_MILLIS
        })
    });
    if in_progress {
        return None;
    }
    candidates.iter().find(|candidate| {
        let Some(marker) = candidate
            .marker
            .as_ref()
            .filter(|marker| marker.pid == candidate.pid)
        else {
            return false;
        };
        candidate.pending.is_none()
            && marker
                .wrapper_version
                .as_deref()
                .is_some_and(|wrapper| wrapper != version)
            && IDLE_RUN_PHASES.contains(&marker.phase.as_str())
            && marker.background_tasks.is_none_or(|count| count == 0)
            && last_requested
                .get(&candidate.key)
                .is_none_or(|at| now_millis.saturating_sub(*at) >= DAEMON_RUN_HANDOFF_RETRY_MILLIS)
    })
}

/// The daemon owns CLI updates. It installs a release and restarts itself;
/// this then moves every run it hosts onto its own version, since a wrapper
/// keeps running the code it started with and a fix would otherwise never
/// reach a live Agent. A run moves in place — same Run, same session — only
/// between turns, and comes back resumed with no message, so the move costs no
/// model turn and says nothing in the channel.
fn spawn_daemon_run_handoff_task(run_registry: DaemonRunRegistry) -> tokio::task::JoinHandle<()> {
    config::spawn_profile_task(async move {
        let version = xmatrix_cli_core::version::current();
        let mut last_requested = HashMap::<String, u64>::new();
        loop {
            tokio::time::sleep(Duration::from_secs(DAEMON_RUN_HANDOFF_SCAN_SECS)).await;
            let Some(executable) = std::env::current_exe().ok().filter(|path| path.is_file())
            else {
                continue;
            };
            let runs = {
                let guard = run_registry.lock().await;
                guard
                    .iter()
                    .filter(|(_, managed)| !managed.stop_in_progress)
                    .filter_map(|(key, managed)| {
                        Some((key.clone(), managed.pid, managed.status_file_path.clone()?))
                    })
                    .collect::<Vec<_>>()
            };
            last_requested.retain(|key, _| runs.iter().any(|(run, ..)| run == key));
            let mut plans = Vec::with_capacity(runs.len());
            let mut request_paths = Vec::with_capacity(runs.len());
            for (key, pid, status_path) in runs {
                let Some(request_path) = daemon_handoff_request_path(&status_path) else {
                    continue;
                };
                plans.push(DaemonRunHandoffCandidate {
                    key,
                    pid,
                    marker: read_daemon_run_status_marker(Some(&status_path)),
                    pending: read_daemon_handoff_request(&request_path),
                });
                request_paths.push(request_path);
            }
            let now = unix_millis_now();
            let Some(index) = next_daemon_run_handoff(&plans, &last_requested, version, now)
                .and_then(|next| plans.iter().position(|plan| std::ptr::eq(plan, next)))
            else {
                continue;
            };
            let plan = &plans[index];
            // Asked either way: a run that could not be asked waits for the
            // retry like one that did not move.
            last_requested.insert(plan.key.clone(), now);
            let request = DaemonHandoffRequest {
                version: version.to_string(),
                executable: executable.clone(),
                requested_at_millis: now,
            };
            if write_daemon_handoff_request(&request_paths[index], &request) {
                append_daemon_registry_audit(&format!(
                    "handoff_requested key={} pid={} from={} to={version}",
                    plan.key,
                    plan.pid,
                    plan.marker
                        .as_ref()
                        .and_then(|marker| marker.wrapper_version.as_deref())
                        .unwrap_or("unknown"),
                ));
            }
        }
    })
}

fn write_daemon_handoff_request(path: &Path, request: &DaemonHandoffRequest) -> bool {
    let Ok(bytes) = serde_json::to_vec(request) else {
        return false;
    };
    let temporary = config::unique_temporary_path(path);
    let written = std::fs::write(&temporary, bytes).is_ok()
        && config::replace_file_atomically(&temporary, path).is_ok();
    if !written {
        let _ = std::fs::remove_file(&temporary);
    }
    written
}

fn spawn_current_run_status_heartbeat() -> Option<tokio::task::JoinHandle<()>> {
    let path = std::env::var_os("XMATRIX_RUN_STATUS_FILE").map(PathBuf::from)?;
    let _ = refresh_daemon_run_status_heartbeat(&path);
    Some(tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(DAEMON_RUN_STATUS_HEARTBEAT_SECS)).await;
            let _ = refresh_daemon_run_status_heartbeat(&path);
        }
    }))
}

fn clean_run_model(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    Some(value.chars().take(128).collect())
}

fn clean_run_effort(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    Some(value.chars().take(64).collect())
}

fn write_current_run_model(model: Option<&str>) {
    let Some(path) = std::env::var_os("XMATRIX_RUN_STATUS_FILE").map(PathBuf::from) else {
        return;
    };
    let _ = update_daemon_run_status_marker(&path, |marker| {
        marker.model = model.and_then(clean_run_model);
        marker.updated_at_millis = unix_millis_now();
    });
}

fn write_current_run_effort(effort: Option<&str>) {
    let Some(path) = std::env::var_os("XMATRIX_RUN_STATUS_FILE").map(PathBuf::from) else {
        return;
    };
    let _ = update_daemon_run_status_marker(&path, |marker| {
        marker.effort = effort.and_then(clean_run_effort);
        marker.updated_at_millis = unix_millis_now();
    });
}

fn write_current_run_presentation_pending(pending: bool) -> bool {
    let Some(path) = std::env::var_os("XMATRIX_RUN_STATUS_FILE").map(PathBuf::from) else {
        return false;
    };
    let Some(pid) = daemon_run_status_writer_pid(&path) else {
        return false;
    };
    if read_daemon_run_status_marker(Some(&path)).is_none_or(|marker| marker.pid != pid) {
        return false;
    }
    update_daemon_run_status_marker(&path, |marker| {
        if marker.pid == pid {
            marker.presentation_pending = pending;
        }
    })
}

/// Record how many background tasks the provider reports as running, or that
/// nobody knows (`None`).
fn write_current_run_background_tasks(count: Option<u32>) {
    let Some(path) = std::env::var_os("XMATRIX_RUN_STATUS_FILE").map(PathBuf::from) else {
        return;
    };
    let _ = update_daemon_run_status_marker(&path, |marker| {
        marker.background_tasks = count;
        marker.updated_at_millis = unix_millis_now();
    });
}

/// Record this wrapper's wake metrics in its own sidecar.
fn write_current_run_wake_metrics(wake: &runtime_wake_metrics::RunWakeMetrics) {
    let Some(path) = std::env::var_os("XMATRIX_RUN_STATUS_FILE").map(PathBuf::from) else {
        return;
    };
    let pid = std::process::id();
    let _ = update_daemon_run_status_marker(&path, |marker| {
        if marker.pid == pid {
            marker.wake = Some(wake.clone());
        }
    });
}

fn read_daemon_run_status_marker(path: Option<&Path>) -> Option<DaemonRunStatusMarker> {
    let path = path?;
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn daemon_run_status_file_label(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_suffix(".status.json"))
        .map(str::to_string)
        .filter(|label| !label.trim().is_empty())
}

fn daemon_run_ids_from_file_label(label: &str) -> (Option<String>, Option<String>) {
    if label.starts_with("run-") {
        (Some(label.to_string()), None)
    } else {
        (None, Some(label.to_string()))
    }
}

fn daemon_run_status_is_terminal(marker: &DaemonRunStatusMarker) -> bool {
    marker.completed
        || matches!(
            marker.phase.as_str(),
            "turn_completed" | "turn_failed" | "run_delivery_failed" | "sleeping"
        )
}

fn daemon_run_exit_from_status_file(
    status_file_path: &Path,
    marker: &DaemonRunStatusMarker,
) -> Option<DaemonRunExit> {
    if !daemon_run_status_is_terminal(marker) || !daemon_run_status_is_recent(marker) {
        return None;
    }
    if crate::process_tree::process_alive(marker.pid) {
        return None;
    }
    let label = daemon_run_status_file_label(status_file_path)?;
    let (run_id, execution_key) = daemon_run_ids_from_file_label(&label);
    let parent = status_file_path.parent()?;
    let stdout_log_path = parent.join(format!("{label}.out.log"));
    let stderr_log_path = parent.join(format!("{label}.err.log"));
    Some(DaemonRunExit {
        wrapper_version: marker.wrapper_version.clone(),
        startup_steps: daemon_marker_startup_steps(Some(marker), marker.pid),
        task_execution: marker.task_execution.clone(),
        operation_failure: marker.operation_failure.clone(),
        connection_retry: marker.connection_retry.clone(),
        wrapper_ready_at_millis: marker.wrapper_ready_at_millis,
        registry_key: None,
        run_id,
        execution_key,
        agent_id: None,
        agent_name: None,
        pid: marker.pid,
        status: marker
            .detail
            .clone()
            .unwrap_or_else(|| format!("recovered daemon run status: {}", marker.phase)),
        exit_code: if marker.completed { Some(0) } else { None },
        status_phase: Some(marker.phase.clone()),
        run_status_detail: daemon_run_exit_detail(Some(marker), None),
        completed: Some(marker.completed),
        delivered: Some(marker.delivered),
        status_file_path: Some(status_file_path.to_path_buf()),
        stdout_log_path: Some(stdout_log_path.display().to_string()),
        stderr_log_path: Some(stderr_log_path.display().to_string()),
        repo_pool_authority: None,
        rest_reason: daemon_marker_rest_reason(Some(marker)),
    })
}

impl DaemonRunExit {
    /// The authenticated exit report for this Run, whichever path found it.
    fn into_report(self) -> MachineDaemonReport {
        MachineDaemonReport::MachineRunExited {
            wrapper_version: self.wrapper_version,
            startup_steps: self.startup_steps,
            task_execution: self.task_execution,
            operation_failure: self.operation_failure,
            connection_retry: self.connection_retry,
            wrapper_ready_at_millis: self.wrapper_ready_at_millis,
            request_id: None,
            run_id: self.run_id,
            execution_key: self.execution_key,
            agent_id: self.agent_id,
            agent_name: self.agent_name,
            pid: Some(self.pid),
            status: Some(self.status),
            exit_code: self.exit_code,
            status_phase: self.status_phase,
            run_status_detail: self.run_status_detail,
            completed: self.completed,
            delivered: self.delivered,
            stdout_log_path: self.stdout_log_path,
            stderr_log_path: self.stderr_log_path,
            rest_reason: self.rest_reason,
        }
    }
}

/// A Run whose marker this daemon stamped before ending it slept.
fn daemon_marker_rest_reason(marker: Option<&DaemonRunStatusMarker>) -> Option<String> {
    marker
        .filter(|marker| marker.phase == runtime_daemon_idle_sleep::SLEEPING_PHASE)
        .map(|_| "sleeping".to_string())
}

fn daemon_run_exit_from_orphan_status_file(
    status_file_path: &Path,
    marker: &DaemonRunStatusMarker,
    managed_status_paths: &HashSet<PathBuf>,
) -> Option<DaemonRunExit> {
    if managed_status_paths.contains(status_file_path) {
        return None;
    }
    daemon_run_exit_from_status_file(status_file_path, marker)
}

fn collect_orphaned_terminal_daemon_run_statuses(
    managed_status_paths: &HashSet<PathBuf>,
) -> Vec<DaemonRunExit> {
    let Ok(entries) = std::fs::read_dir(daemon_run_log_dir()) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| daemon_run_status_file_label(path).is_some())
        .filter_map(|path| {
            let marker = read_daemon_run_status_marker(Some(&path))?;
            daemon_run_exit_from_orphan_status_file(&path, &marker, managed_status_paths)
        })
        .collect()
}

fn prepare_daemon_run_files(
    run_id: Option<&str>,
    execution_key: Option<&str>,
    agent_name: &str,
) -> Option<DaemonRunFiles> {
    let dir = daemon_run_log_dir();
    if let Err(err) = std::fs::create_dir_all(&dir) {
        eprintln!(
            "{} failed to create daemon run log directory {}: {err}",
            "⚠".yellow().bold(),
            dir.display()
        );
        return None;
    }
    if daemon_run_log_dir_is_default() {
        set_daemon_private_dir_permissions(&dir);
    }
    let label = daemon_run_file_label(run_id, execution_key, agent_name);
    let files = DaemonRunFiles {
        status_file_path: dir.join(format!("{label}.status.json")),
        stdout_log_path: dir.join(format!("{label}.out.log")),
        stderr_log_path: dir.join(format!("{label}.err.log")),
    };
    write_daemon_run_status_marker_to_path(&files.status_file_path, "spawned", false, None);
    Some(files)
}

fn daemon_run_log_stdio(path: Option<&Path>) -> Stdio {
    let Some(path) = path else {
        return Stdio::null();
    };
    match OpenOptions::new()
        .create(true)
        .append(true)
        
        .open(path)
    {
        Ok(file) => Stdio::from(file),
        Err(err) => {
            eprintln!(
                "{} failed to open daemon run log {}: {err}",
                "⚠".yellow().bold(),
                path.display()
            );
            Stdio::null()
        }
    }
}

fn daemon_restart_waits_for_lock_from_env(
    wait_lock: Option<&str>,
    xpc_service_name: Option<&str>,
    is_macos: bool,
) -> bool {
    matches!(wait_lock, Some("1" | "true" | "TRUE" | "yes" | "YES"))
        || is_macos && xpc_service_name == Some("sh.xmatrix.daemon")
}

fn daemon_restart_waits_for_lock() -> bool {
    daemon_restart_waits_for_lock_from_env(
        std::env::var("XMATRIX_DAEMON_RESTART_WAIT_LOCK")
            .ok()
            .as_deref(),
        std::env::var("XPC_SERVICE_NAME").ok().as_deref(),
        cfg!(target_os = "macos"),
    )
}

fn acquire_daemon_lock(wait: bool) -> error::Result<DaemonLock> {
    let dir = config::config_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("daemon.lock");
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)?;

    let lock_result = if wait {
        file.lock_exclusive()
    } else {
        file.try_lock_exclusive()
    };

    match lock_result {
        Ok(()) => {
            file.set_len(0)?;
            writeln!(file, "pid={}", std::process::id())?;
            Ok(DaemonLock { _file: file })
        }
        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => Err(CliError::Launch(format!(
            "xMatrix daemon is already running for {}; stop it before starting another daemon",
            dir.display()
        ))),
        Err(err) => Err(CliError::Io(err)),
    }
}

fn daemon_self_update_disabled() -> bool {
    matches!(
        std::env::var("XMATRIX_SKIP_DAEMON_SELF_UPDATE")
            .ok()
            .as_deref(),
        Some("1" | "true" | "TRUE" | "yes" | "YES")
    )
}

enum DaemonSelfUpdateOutcome {
    Restart(InstalledCliUpdate),
    #[cfg(windows)]
    #[allow(dead_code)]
    WindowsCandidate(WindowsStagedDaemonCandidate),
}

fn daemon_self_update_release_api_url() -> String {
    std::env::var("XMATRIX_RELEASE_API_URL")
        .unwrap_or_else(|_| DEFAULT_CLI_RELEASE_API_URL.to_string())
}

fn daemon_self_update_interval() -> Duration {
    let interval_secs = std::env::var("XMATRIX_DAEMON_SELF_UPDATE_INTERVAL_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_DAEMON_SELF_UPDATE_INTERVAL_SECS);

    Duration::from_secs(interval_secs.max(60))
}

fn daemon_self_update_timeout(phase: &str) -> Duration {
    let secs = if phase == "startup" {
        DAEMON_SELF_UPDATE_STARTUP_TIMEOUT_SECS
    } else {
        DAEMON_SELF_UPDATE_PERIODIC_TIMEOUT_SECS
    };
    Duration::from_secs(secs)
}

async fn daemon_self_update_and_restart_if_needed(
    hub_url: &str,
    token_override: Option<&str>,
    phase: &str,
) -> Option<DaemonSelfUpdateOutcome> {
    if daemon_self_update_disabled() {
        return None;
    }

    let release_api_url = daemon_self_update_release_api_url();
    let timeout = daemon_self_update_timeout(phase);
    let pending = match tokio::time::timeout(timeout, check_cli_update(&release_api_url, false))
        .await
    {
        Err(_) => {
            eprintln!(
                "{} daemon self-update check timed out after {}s during {phase}; continuing daemon startup",
                "⚠".yellow().bold(),
                timeout.as_secs()
            );
            return None;
        }
        Ok(Ok(CliUpdateCheck::Pending(update))) => update,
        Ok(Ok(CliUpdateCheck::UpToDate { .. })) => return None,
        Ok(Err(err)) => {
            eprintln!(
                "{} daemon self-update check failed during {phase}: {err}",
                "⚠".yellow().bold()
            );
            return None;
        }
    };

    eprintln!(
        "{} daemon self-update found xMatrix CLI {} -> {}",
        "○".cyan().bold(),
        pending.current_version,
        pending.latest_version
    );
    print_update_hint(
        UpdateHintTarget::Daemon,
        pending.current_version.as_str(),
        pending.latest_version.as_str(),
    );

    let installed = match tokio::time::timeout(
        daemon_self_update_timeout(phase),
        install_cli_update_for_daemon_restart(pending, hub_url, token_override),
    )
    .await
    {
        Err(_) => {
            eprintln!(
                "{} daemon self-update install timed out after {}s during {phase}; continuing daemon startup",
                "⚠".yellow().bold(),
                daemon_self_update_timeout(phase).as_secs()
            );
            return None;
        }
        Ok(Ok(installed)) => installed,
        Ok(Err(err)) => {
            eprintln!(
                "{} daemon self-update install failed during {phase}: {err}",
                "⚠".yellow().bold()
            );
            return None;
        }
    };

    eprintln!(
        "{} daemon updated xMatrix CLI {} -> {}; restarting",
        "✓".green().bold(),
        installed.previous_version,
        installed.latest_version
    );
    Some(DaemonSelfUpdateOutcome::Restart(installed))
}

fn spawn_daemon_self_update_task(
    hub_url: String,
    token_override: Option<String>,
    run_registry: DaemonRunRegistry,
    relay: SharedMachineDaemonConnection,
    profile_manager: ProfileManager,
) -> mpsc::UnboundedReceiver<DaemonSelfUpdateOutcome> {
    let (tx, rx) = mpsc::unbounded_channel();
    if daemon_self_update_disabled() {
        return rx;
    }

    config::spawn_profile_task(async move {
        loop {
            tokio::time::sleep(daemon_self_update_interval()).await;
            report_finished_daemon_children(&run_registry, &relay).await;
            if let Err(error) = seal_daemon_host_update_recovery(&profile_manager) {
                eprintln!(
                    "{} daemon update deferred because recovery sealing failed: {error}",
                    "⚠".yellow().bold()
                );
                continue;
            }
            if let Some(installed) = daemon_self_update_and_restart_if_needed(
                &hub_url,
                token_override.as_deref(),
                "periodic",
            )
            .await
            {
                let _ = tx.send(installed);
                break;
            }
        }
    });

    rx
}

#[derive(Clone)]
struct DaemonSpawnRuntime {
    hub_url: String,
    token_override: Option<String>,
    daemon_session: Option<DaemonSessionState>,
    auth_broker: Option<DaemonAuthBroker>,
    request_broker: Option<DaemonRequestBroker>,
    machine_id: String,
    host_id: String,
    run_registry: DaemonRunRegistry,
    spawn_inflight: DaemonSpawnInflight,
    relay: SharedMachineDaemonConnection,
    effect_journal: DaemonEffectJournal,
}

impl DaemonSpawnRuntime {
    async fn claim(&self, intent: &DaemonSpawnRequest) -> DaemonSpawnClaim {
        claim_daemon_spawn(
            &self.run_registry,
            &self.spawn_inflight,
            intent,
            self.auth_broker.as_ref(),
            self.request_broker.as_ref(),
        )
        .await
    }

    async fn execute_claimed(
        &self,
        intent: &DaemonSpawnRequest,
        initial_agent_token: Option<String>,
        delivery: DaemonSpawnDelivery,
        claim_key: Option<String>,
        log: Option<DaemonSpawnLog<'_>>,
    ) -> MachineDaemonReport {
        let mut failure_repo_pool_binding = None;
        let result = handle_daemon_spawn_request(
            &self.hub_url,
            self.token_override.as_deref(),
            self.daemon_session.clone(),
            self.auth_broker.clone(),
            self.request_broker.clone(),
            self.relay.clone(),
            &self.machine_id,
            &self.host_id,
            intent,
            initial_agent_token,
            delivery,
            &self.run_registry,
            &mut failure_repo_pool_binding,
        )
        .await;
        let result = record_daemon_spawn_result(
            result,
            failure_repo_pool_binding.as_ref(),
            &self.run_registry,
            intent.identity_id.clone(),
            log,
        )
        .await;
        release_daemon_spawn_claim(&self.spawn_inflight, claim_key).await;
        result.into_report(intent)
    }
}

fn spawn_daemon_spawn_intent_poll_task(runtime: DaemonSpawnRuntime) -> tokio::task::JoinHandle<()> {
    config::spawn_profile_task(async move {
        let DaemonSpawnRuntime {
            hub_url,
            machine_id,
            host_id,
            run_registry,
            relay,
            effect_journal,
            request_broker,
            auth_broker,
            ..
        } = runtime.clone();
        let mut retry_delay_ms = DAEMON_CONTROL_POLL_RETRY_BASE_MS;
        let mut last_claimed_epoch = None;
        loop {
            let token = match relay.machine_credential() {
                Ok(token) => token,
                Err(err) => {
                    eprintln!(
                        "{} daemon spawn poll auth failed: {err}",
                        "⚠".yellow().bold()
                    );
                    sleep_daemon_control_poll_retry(retry_delay_ms).await;
                    retry_delay_ms = next_daemon_control_poll_retry_delay_ms(retry_delay_ms);
                    continue;
                }
            };

            let Some(connection_epoch) = relay.connection_epoch() else {
                // An offline socket has no current epoch and therefore no
                // authority to hit the HTTP claim endpoint. Observe reconnect
                // locally at a bounded cadence instead of probing Hub.
                last_claimed_epoch = None;
                wait_for_daemon_control_poll_window(&relay).await;
                continue;
            };
            if last_claimed_epoch == Some(connection_epoch) {
                // This live epoch already had its one HTTP catch-up. Do not
                // poll again; Hub evict + reconnect is the recovery path.
                wait_for_daemon_control_poll_window(&relay).await;
                continue;
            };
            let intents = match poll_daemon_control(
                &hub_url,
                &token,
                &machine_id,
                &host_id,
                connection_epoch,
            )
            .await
            {
                Ok(intents) => {
                    retry_delay_ms = DAEMON_CONTROL_POLL_RETRY_BASE_MS;
                    last_claimed_epoch = Some(connection_epoch);
                    intents
                }
                Err(err) => {
                    eprintln!("{} daemon control poll failed: {err}", "⚠".yellow().bold());
                    sleep_daemon_control_poll_retry(retry_delay_ms).await;
                    retry_delay_ms = next_daemon_control_poll_retry_delay_ms(retry_delay_ms);
                    continue;
                }
            };

            if intents.is_empty() {
                // signal_v1 already waited at Hub for up to 25 seconds. Start
                // the next wait immediately so wake cannot inherit an extra
                // client-side ten-second sleep.
                continue;
            }

            let mut spawn_tasks = Vec::new();
            for message in intents {
                match message {
                    command @ MachineDaemonCommand::MachineSpawnAgent { .. } => {
                        spawn_tasks.push(config::spawn_profile_task(handle_polled_daemon_spawn(
                            runtime.clone(),
                            token.clone(),
                            command,
                        )));
                    }
                    command @ MachineDaemonCommand::MachineRecoverReply { .. } => {
                        let future = runtime_reply_recovery::polled(
                            hub_url.clone(),
                            token.clone(),
                            relay.clone(),
                            effect_journal.clone(),
                            request_broker.clone(),
                            command,
                        );
                        spawn_tasks.push(config::spawn_profile_task(async move {
                            if future.await.is_err() {
                                eprintln!("Saved reply recovery result remains pending");
                            }
                        }));
                    }
                    command @ MachineDaemonCommand::MachineStopAgent { .. } => {
                        let control_id = polled_daemon_command_control_id(&command)
                            .unwrap_or_default()
                            .to_string();
                        let effect_id = match prepare_polled_daemon_command(
                            &hub_url,
                            &token,
                            &relay,
                            &effect_journal,
                            &command,
                        )
                        .await
                        {
                            Ok(Some((effect_id, _))) => effect_id,
                            Ok(None) => continue,
                            Err(err) => {
                                eprintln!(
                                    "{} failed to admit polled daemon stop: {err}",
                                    "⚠".yellow().bold()
                                );
                                continue;
                            }
                        };
                        let request = DaemonStopRequest::from_command(command)
                            .expect("matched MachineStopAgent");
                        let export_source = request.export_source(&run_registry).await;
                        let result = request.stop(&run_registry).await;
                        let handoff_export = handoff_export_for_stop(
                            request.handoff_export.as_ref(),
                            &result,
                            export_source,
                            auth_broker.as_ref(),
                        )
                        .await;
                        let message = request.into_report(result, handoff_export);
                        if let Err(err) = report_polled_command_effect_result_http(
                            &hub_url,
                            &token,
                            &relay,
                            &effect_journal,
                            &effect_id,
                            &control_id,
                            message,
                        )
                        .await
                        {
                            eprintln!(
                                "{} failed to report daemon stop intent result: {err}",
                                "⚠".yellow().bold()
                            );
                        }
                    }
                    _ => {}
                }
            }
            for task in spawn_tasks {
                if let Err(err) = task.await {
                    eprintln!(
                        "{} polled daemon spawn task failed: {err}",
                        "⚠".yellow().bold()
                    );
                }
            }
            // A non-empty bounded claim may have left additional work behind.
            // Drain immediately; the next empty claim restores the normal
            // healthy/disconnected wait and prevents an idle hot loop.
        }
    })
}

fn polled_daemon_command_control_id(command: &MachineDaemonCommand) -> Option<&str> {
    match command {
        MachineDaemonCommand::MachineSpawnAgent { request_id, .. }
        | MachineDaemonCommand::MachineStopAgent { request_id, .. }
        | MachineDaemonCommand::MachineRecoverReply { request_id, .. }
        | MachineDaemonCommand::MachineWorktreeCleanup { request_id, .. }
        | MachineDaemonCommand::MachineQuotaProbe { request_id, .. }
        | MachineDaemonCommand::MachineHarnessAction { request_id, .. } => Some(request_id),
        MachineDaemonCommand::MachineRequestResolve { request_id, .. } => request_id.as_deref(),
    }
}

async fn prepare_polled_daemon_command(
    hub_url: &str,
    token: &str,
    relay: &SharedMachineDaemonConnection,
    effect_journal: &DaemonEffectJournal,
    command: &MachineDaemonCommand,
) -> error::Result<Option<(String, Option<String>)>> {
    let control_id = polled_daemon_command_control_id(command)
        .ok_or_else(|| CliError::Launch("Polled daemon command has no control ID".into()))?;
    match prepare_command_effect(effect_journal, command)? {
        CommandEffectDispatch::Execute(stable_id) => {
            let initial_agent_token = if daemon_spawn_has_combined_admission_authority(command) {
                match admit_and_authorize_daemon_spawn_http(hub_url, token, command).await? {
                    DaemonSpawnAdmission::Authorized(token) => Some(token),
                    DaemonSpawnAdmission::Rejected(error) => {
                        let intent =
                            DaemonSpawnRequest::from_command(command.clone()).ok_or_else(|| {
                                CliError::Launch(
                                    "Rejected spawn admission has no spawn intent".into(),
                                )
                            })?;
                        let report = daemon_spawn_result_message(
                            false,
                            None,
                            None,
                            Some(error),
                            None,
                            &intent,
                        );
                        report_polled_command_effect_result_http(
                            hub_url,
                            token,
                            relay,
                            effect_journal,
                            &stable_id,
                            control_id,
                            report,
                        )
                        .await?;
                        return Ok(None);
                    }
                }
            } else {
                admit_daemon_command_http(hub_url, token, command).await?;
                None
            };
            Ok(Some((stable_id, initial_agent_token)))
        }
        CommandEffectDispatch::Replay {
            stable_id,
            expected_result_digest,
            report,
            persist_rebind,
        } => {
            let report = relay.bind_claimed_command_registry_causality(report)?;
            if persist_rebind {
                persist_rebound_command_effect_result(
                    effect_journal,
                    &stable_id,
                    &expected_result_digest,
                    &report,
                )?;
            }
            report_daemon_control_result_http(hub_url, token, report).await?;
            effect_journal
                .lock()
                .map_err(|_| CliError::Launch("Daemon command effect journal is poisoned".into()))?
                .acknowledge(control_id)
                .map_err(|error| {
                    CliError::Launch(format!("Daemon command completion ack failed: {error}"))
                })?;
            Ok(None)
        }
    }
}

async fn handle_polled_daemon_spawn(
    runtime: DaemonSpawnRuntime,
    token: String,
    command: MachineDaemonCommand,
) {
    let DaemonSpawnRuntime {
        hub_url,
        relay,
        effect_journal,
        ..
    } = &runtime;
    let control_id = polled_daemon_command_control_id(&command)
        .unwrap_or_default()
        .to_string();
    let effect_id =
        match prepare_polled_daemon_command(hub_url, &token, relay, effect_journal, &command).await
        {
            Ok(Some(prepared)) => prepared,
            Ok(None) => return,
            Err(err) => {
                eprintln!(
                    "{} failed to admit polled daemon spawn: {err}",
                    "⚠".yellow().bold()
                );
                return;
            }
        };
    let (effect_id, initial_agent_token) = effect_id;
    let Some(intent) = DaemonSpawnRequest::from_command(command) else {
        return;
    };
    let claim_key = match runtime.claim(&intent).await {
        DaemonSpawnClaim::Existing(existing) => {
            let message = existing.into_report(&intent);
            if let Err(err) = report_polled_command_effect_result_http(
                hub_url,
                &token,
                relay,
                effect_journal,
                &effect_id,
                &control_id,
                message,
            )
            .await
            {
                eprintln!(
                    "{} failed to ack duplicate daemon spawn intent: {err}",
                    "⚠".yellow().bold()
                );
            }
            return;
        }
        DaemonSpawnClaim::Conflict => {
            let message = conflicting_daemon_spawn_result(&intent);
            if let Err(err) = report_polled_command_effect_result_http(
                hub_url,
                &token,
                relay,
                effect_journal,
                &effect_id,
                &control_id,
                message,
            )
            .await
            {
                eprintln!(
                    "{} failed to report conflicting daemon spawn intent: {err}",
                    "⚠".yellow().bold()
                );
            }
            return;
        }
        DaemonSpawnClaim::Inflight => return,
        DaemonSpawnClaim::Claimed(claim_key) => claim_key,
    };

    let message = runtime
        .execute_claimed(
            &intent,
            initial_agent_token,
            DaemonSpawnDelivery::HttpFallback,
            claim_key,
            None,
        )
        .await;
    if let Err(err) = report_polled_command_effect_result_http(
        hub_url,
        &token,
        relay,
        effect_journal,
        &effect_id,
        &control_id,
        message,
    )
    .await
    {
        eprintln!(
            "{} failed to report daemon spawn intent result: {err}",
            "⚠".yellow().bold()
        );
    }
}

/// Answer the credential request Git wrote on stdin.
///
/// Git treats an empty answer as "this helper has nothing", and falls through to
/// whatever else is configured. That is the right outcome for every case we
/// decline -- a host that is not GitHub, a request that did not say which
/// repository, a run holding no grant -- so none of them are errors here.
pub async fn cmd_git_credential(operation: &str) -> error::Result<()> {
    use std::io::Read as _;

    // Git only expects an answer to `get`. It sends `store` and `erase` so a
    // helper can maintain its own cache; ours has nothing to keep, because every
    // token is short-lived and fetched on demand.
    if git_credential::parse_credential_operation(operation)?
        != git_credential::CredentialOperation::Get
    {
        return Ok(());
    }

    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let values = git_credential::parse_credential_input(&input);
    let Ok(request) = git_credential::decide_credential(&values) else {
        return Ok(());
    };

    if let Ok(cwd) = std::env::current_dir()
        && git_credential::holds_retired_history(&request.repository(), &cwd)
    {
        eprintln!(
            "xmatrix: this checkout still holds the private history of {}; clone it again before pushing",
            request.repository()
        );
        return Ok(());
    }

    let Some(token) = git_credential::request_repository_token(&request.repository()).await? else {
        return Ok(());
    };
    print!("{}", git_credential::format_credential_output(&token));
    Ok(())
}

/// A restarted daemon re-authorizes a live Run from the persisted verifier key.
/// It must then be able to mint that Run a token, or the Run stays alive and
/// permanently unable to send.
#[cfg(test)]
mod restored_run_auth_capability_tests {
    use super::*;

    fn context() -> DaemonAgentAuthContext {
        DaemonAgentAuthContext {
            agent_id: "agent:owner:suffix".into(),
            agent_name: "claude".into(),
            space_id: "space".into(),
            channel_id: "channel".into(),
            run_id: "run:reborn:abc".into(),
            execution_key: "exec:abc".into(),
        }
    }

    fn capabilities(key: &str) -> Arc<Mutex<HashMap<String, DaemonAgentAuthGrantState>>> {
        let mut map = HashMap::new();
        map.insert(
            key.to_string(),
            DaemonAgentAuthGrantState {
                context: context(),
                held_token: None,
            },
        );
        Arc::new(Mutex::new(map))
    }

    #[test]
    fn a_live_run_still_mints_from_its_raw_capability() {
        let raw = "3f0f0b9e-0000-4000-8000-000000000001";
        let map = capabilities(&daemon_capability_key(raw));
        let (resolved, _) = take_daemon_agent_auth_grant(&map, raw).expect("raw must authorize");
        assert_eq!(resolved.run_id, context().run_id);
    }

    #[test]
    fn a_restored_run_mints_from_the_persisted_verifier_key() {
        let raw = "3f0f0b9e-0000-4000-8000-000000000002";
        let key = daemon_capability_key(raw);
        let map = capabilities(&key);
        // What a replacement daemon actually holds for this Run: the persisted
        // key, never the raw capability. Hashing it again matched nothing and
        // the Run could never send again.
        let (resolved, _) =
            take_daemon_agent_auth_grant(&map, &key).expect("a restored key must authorize");
        assert_eq!(resolved.run_id, context().run_id);
    }

    #[test]
    fn an_unrelated_capability_or_key_is_still_refused() {
        let raw = "3f0f0b9e-0000-4000-8000-000000000003";
        let map = capabilities(&daemon_capability_key(raw));
        assert!(
            take_daemon_agent_auth_grant(&map, "3f0f0b9e-0000-4000-8000-000000000004").is_none()
        );
        assert!(
            take_daemon_agent_auth_grant(&map, &daemon_capability_key("other")).is_none(),
            "a well-formed key for another Run must not authorize this one",
        );
        assert!(
            take_daemon_agent_auth_grant(&map, "sha256:not-hex").is_none(),
            "a malformed key must not be treated as a capability",
        );
    }

    /// The two brokers must admit a Run on identical terms. They did not: only
    /// the auth side learned to accept a restored Run's persisted key, and a
    /// divergence like that is invisible until the day something presents the
    /// other shape to the other broker.
    #[test]
    fn both_brokers_admit_a_run_on_the_same_terms() {
        let raw = "3f0f0b9e-0000-4000-8000-00000000000a";
        let key = daemon_capability_key(raw);
        for presented in [raw, key.as_str()] {
            let admitted: Vec<String> = daemon_capability_candidates(presented).collect();
            assert!(
                admitted.contains(&key),
                "a broker presented {presented} must reach the stored grant",
            );
        }
        // A capability that names nothing stored is still refused by both.
        let stranger = daemon_capability_candidates("3f0f0b9e-0000-4000-8000-00000000000b")
            .collect::<Vec<_>>();
        assert!(!stranger.contains(&key));
        // A malformed key is not silently treated as a raw capability that
        // happens to hash to something.
        assert_eq!(
            daemon_capability_candidates("sha256:not-hex").collect::<Vec<_>>(),
            vec![daemon_capability_key("sha256:not-hex")],
        );
    }

    #[test]
    fn a_minted_token_is_reused_only_while_it_outlives_the_wrapper_refresh() {
        let raw = "3f0f0b9e-0000-4000-8000-000000000005";
        let map = capabilities(&daemon_capability_key(raw));
        assert_eq!(take_daemon_agent_auth_grant(&map, raw).unwrap().1, None);

        hold_daemon_agent_run_token(&map, raw, &context(), "minted");
        for _ in 0..2 {
            assert_eq!(
                take_daemon_agent_auth_grant(&map, raw).unwrap().1.as_deref(),
                Some("minted"),
                "back-to-back commands share one token",
            );
        }

        let held = HeldAgentRunToken::now("minted".into());
        assert_eq!(held.reusable_at(held.minted_at + AGENT_RUN_TOKEN_REUSE), None);
        // Ten-minute tokens: whatever is reused still covers a full refresh
        // interval of the wrapper that holds it.
        assert!(
            Duration::from_secs(600) - AGENT_RUN_TOKEN_REUSE
                > Duration::from_secs(AGENT_RUN_TOKEN_REFRESH_INTERVAL_SECS)
        );
    }

    #[test]
    fn a_token_minted_for_a_replaced_grant_is_not_kept() {
        let raw = "3f0f0b9e-0000-4000-8000-000000000006";
        let map = capabilities(&daemon_capability_key(raw));
        let mut other_run = context();
        other_run.run_id = "run:other".into();
        hold_daemon_agent_run_token(&map, raw, &other_run, "stale");
        hold_daemon_agent_run_token(&map, "unknown-capability", &context(), "stray");
        assert_eq!(take_daemon_agent_auth_grant(&map, raw).unwrap().1, None);
    }
}
