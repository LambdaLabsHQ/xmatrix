fn daemon_auth_broker_reachable(url: &str) -> Result<(), String> {
    let address = url
        .trim()
        .trim_end_matches('/')
        .strip_prefix("http://")
        .ok_or_else(|| "invalid broker URL".to_string())?;
    if address.contains('/') || address.is_empty() {
        return Err("invalid broker URL".to_string());
    }
    let address = address
        .parse::<std::net::SocketAddr>()
        .map_err(|err| format!("invalid broker address: {err}"))?;
    std::net::TcpStream::connect_timeout(&address, Duration::from_millis(250))
        .map(|_| ())
        .map_err(|err| err.to_string())
}

type DaemonEffectJournal = Arc<std::sync::Mutex<xmatrix_windows_continuity::CommandEffectJournal>>;

enum CommandEffectDispatch {
    Execute(String),
    Replay {
        stable_id: String,
        expected_result_digest: String,
        report: MachineDaemonReport,
        persist_rebind: bool,
    },
}

fn rebind_replayed_command_result(
    mut report: MachineDaemonReport,
    command: &MachineDaemonCommand,
) -> error::Result<MachineDaemonReport> {
    let Some(current_lease) = command.relay_lease().cloned() else {
        return Ok(report);
    };
    let mut value = serde_json::to_value(&report)?;
    let object = value.as_object_mut().ok_or_else(|| {
        CliError::Launch("Committed daemon command result is not an object".into())
    })?;
    object.insert("relayLease".into(), serde_json::to_value(current_lease)?);
    if object.get("type").and_then(Value::as_str) == Some("machine_spawn_result")
        && object.get("ok").and_then(Value::as_bool) == Some(true)
    {
        // The durable result proves that the physical effect happened. The
        // newly claimed lease proves that this daemon epoch is now authorized
        // to reconcile it. Clear the old registry stamp so the transport can
        // record fresh current-epoch evidence instead of replaying a stale
        // connection fence.
        object.remove("registryConnectionEpoch");
        object.remove("registrySequence");
    }
    report = serde_json::from_value(value)?;
    Ok(report)
}

fn json_identity_field<'a>(value: &'a Value, field: &str) -> Option<&'a Value> {
    value.get(field).filter(|value| !value.is_null())
}

fn replay_result_matches_command(
    command: &MachineDaemonCommand,
    result: &Value,
) -> error::Result<bool> {
    let command = serde_json::to_value(command)?;
    let command_type = command.get("type").and_then(Value::as_str);
    let result_type = result.get("type").and_then(Value::as_str);
    let (expected_result_type, identity_fields): (&str, &[&str]) = match command_type {
        Some("machine_spawn_agent") => (
            "machine_spawn_result",
            &[
                "requestId",
                "launchId",
                "runId",
                "executionKey",
                "instanceId",
                "channelId",
                "agentName",
                "identityId",
            ],
        ),
        Some("machine_stop_agent") => (
            "machine_stop_result",
            &[
                "requestId",
                "runId",
                "executionKey",
                "agentId",
                "instanceId",
                "resumeSessionKey",
                "repoIdentity",
                "repoKeyId",
                "slotId",
                "worktreeDisposition",
            ],
        ),
        Some("machine_recover_reply") => (
            "machine_recover_reply_result",
            &[
                "requestId",
                "runId",
                "instanceId",
                "executionKey",
                "channelId",
                "executionId",
            ],
        ),
        Some("machine_request_resolve") => (
            "machine_request_resolve_result",
            &["requestId", "daemonRequestId"],
        ),
        Some("machine_worktree_cleanup") => (
            "machine_worktree_cleanup_result",
            &["requestId", "workspace", "channelId", "scopeChannelId"],
        ),
        Some("machine_quota_probe") => ("machine_quota_probe_result", &["requestId"]),
        Some("machine_harness_action") => ("machine_harness_action_result", &["requestId"]),
        _ => return Ok(false),
    };
    if result_type != Some(expected_result_type)
        || identity_fields
            .iter()
            .any(|field| json_identity_field(&command, field) != json_identity_field(result, field))
    {
        return Ok(false);
    }
    if command_type == Some("machine_harness_action") {
        let outcome = result.get("result").unwrap_or(&Value::Null);
        return Ok(["presetId", "action"].iter().all(|field| {
            json_identity_field(&command, field).is_some()
                && json_identity_field(&command, field) == json_identity_field(outcome, field)
        }));
    }
    if command_type == Some("machine_spawn_agent") {
        let workspace = command.get("workspace").unwrap_or(&Value::Null);
        return Ok(json_identity_field(workspace, "machineId")
            == json_identity_field(result, "machineId")
            && json_identity_field(workspace, "canonicalCwd")
                == json_identity_field(result, "canonicalCwd"));
    }
    Ok(true)
}

fn command_admission_report(command: &MachineDaemonCommand) -> error::Result<MachineDaemonReport> {
    let (control_id, launch_id, channel_id) = match command {
        MachineDaemonCommand::MachineSpawnAgent {
            request_id,
            launch_id,
            channel_id,
            ..
        } => (
            request_id.clone(),
            launch_id.clone(),
            Some(channel_id.clone()),
        ),
        MachineDaemonCommand::MachineRecoverReply {
            request_id,
            channel_id,
            ..
        } => (request_id.clone(), None, Some(channel_id.clone())),
        MachineDaemonCommand::MachineStopAgent { request_id, .. } => {
            (request_id.clone(), None, None)
        }
        MachineDaemonCommand::MachineRequestResolve { request_id, .. } => (
            request_id.clone().ok_or_else(|| {
                CliError::Launch("Machine request resolution has no control ID".into())
            })?,
            None,
            None,
        ),
        MachineDaemonCommand::MachineWorktreeCleanup {
            request_id,
            channel_id,
            ..
        } => (request_id.clone(), None, Some(channel_id.clone())),
        MachineDaemonCommand::MachineQuotaProbe { request_id, .. }
        | MachineDaemonCommand::MachineHarnessAction { request_id, .. } => {
            (request_id.clone(), None, None)
        }
    };
    let relay_lease = command.relay_lease().cloned().ok_or_else(|| {
        CliError::Launch("Machine command admission has no Authority lease".into())
    })?;
    Ok(MachineDaemonReport::MachineCommandAdmitted {
        request_id: format!("admit:{control_id}"),
        control_id,
        launch_id,
        channel_id,
        admitted_at: Some(daemon_event_at_rfc3339()),
        relay_lease,
    })
}

/// Counts one spawn command from receipt until its task ends.
struct SpawnCommandInFlight(Arc<std::sync::atomic::AtomicUsize>);

impl SpawnCommandInFlight {
    fn enter(counter: &Arc<std::sync::atomic::AtomicUsize>) -> Self {
        counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Self(counter.clone())
    }
}

impl Drop for SpawnCommandInFlight {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Longest a self-update handoff waits for spawn commands already received.
const SPAWN_HANDOFF_WAIT: std::time::Duration = std::time::Duration::from_secs(90);

/// Let spawn commands this daemon already received start their process before
/// it exits for a self-update; the successor would otherwise see them only on
/// redelivery, a minute or more later. Bounded, so a stuck spawn cannot pin an
/// old daemon: whatever is left is redelivered to the successor, which runs an
/// unexecuted command (see `CommandEffectJournal::rekey_unexecuted`).
async fn wait_for_spawn_commands_before_handoff(counter: &std::sync::atomic::AtomicUsize) {
    let deadline = tokio::time::Instant::now() + SPAWN_HANDOFF_WAIT;
    while counter.load(std::sync::atomic::Ordering::SeqCst) > 0
        && tokio::time::Instant::now() < deadline
    {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

fn prepare_command_effect(
    journal: &DaemonEffectJournal,
    command: &MachineDaemonCommand,
) -> error::Result<CommandEffectDispatch> {
    let (control_id, command_type) = match command {
        MachineDaemonCommand::MachineSpawnAgent { request_id, .. } => (request_id, "spawn"),
        MachineDaemonCommand::MachineStopAgent { request_id, .. } => (request_id, "stop"),
        MachineDaemonCommand::MachineRecoverReply { request_id, .. } => {
            (request_id, "recover_reply")
        }
        MachineDaemonCommand::MachineRequestResolve { request_id, .. } => (
            request_id.as_ref().ok_or_else(|| {
                CliError::Launch("Machine request resolution has no control ID".into())
            })?,
            "resolve",
        ),
        MachineDaemonCommand::MachineWorktreeCleanup { request_id, .. } => (request_id, "cleanup"),
        MachineDaemonCommand::MachineQuotaProbe { request_id, .. } => (request_id, "quota_probe"),
        MachineDaemonCommand::MachineHarnessAction { request_id, .. } => {
            (request_id, "harness_action")
        }
    };
    let mut payload = serde_json::to_value(command)?;
    if let Some(object) = payload.as_object_mut() {
        object.remove("relayLease");
        if let Some(profile) = config::active_profile_context() {
            object.insert(
                "localProfileId".into(),
                serde_json::Value::String(profile.id.as_str().to_string()),
            );
        }
    }
    let command_type = config::active_profile_context()
        .map(|profile| format!("{}:{command_type}", profile.id))
        .unwrap_or_else(|| command_type.to_string());
    let payload_digest = lowercase_hex(&Sha256::digest(serde_json::to_vec(&payload)?));
    let journal = journal
        .lock()
        .map_err(|_| CliError::Launch("Daemon command effect journal is poisoned".into()))?;
    let effect = match journal
        .effect_for_control_id(control_id)
        .map_err(|error| CliError::Launch(format!("Daemon command effect conflict: {error}")))?
    {
        Some(effect) if effect.payload_digest == payload_digest => effect,
        Some(effect)
            if matches!(
                effect.phase,
                xmatrix_windows_continuity::EffectPhase::EffectCommitted
                    | xmatrix_windows_continuity::EffectPhase::HubCompletionAcked
            ) =>
        {
            // Older CLIs hashed their full deserialized command. Additive
            // optional protocol fields therefore changed the digest after an
            // upgrade. A committed physical effect must never execute again;
            // accept only a closed, exact identity match against its result.
            let identity_matches = match effect.result.as_ref() {
                Some(result) => replay_result_matches_command(command, result)?,
                None => false,
            };
            if !identity_matches {
                return Err(CliError::Launch(
                    "Daemon command effect conflict: Run evidence is quarantined or conflicting"
                        .into(),
                ));
            }
            effect
        }
        // Not executed yet, but journaled by a CLI that serialized the command
        // differently (a daemon self-update between receipt and redelivery).
        Some(effect)
            if matches!(
                effect.phase,
                xmatrix_windows_continuity::EffectPhase::Received
                    | xmatrix_windows_continuity::EffectPhase::Admitted
            ) =>
        {
            journal
                .rekey_unexecuted(control_id, &command_type, &payload_digest)
                .map_err(|error| {
                    CliError::Launch(format!("Daemon command effect conflict: {error}"))
                })?
        }
        Some(_) => {
            return Err(CliError::Launch(
                "Daemon command effect conflict: Run evidence is quarantined or conflicting".into(),
            ));
        }
        None => journal
            .receive(control_id, &command_type, &payload_digest)
            .map_err(|error| {
                CliError::Launch(format!("Daemon command effect conflict: {error}"))
            })?,
    };
    match effect.phase {
        xmatrix_windows_continuity::EffectPhase::Received => {
            journal.admit(&effect.stable_id()).map_err(|error| {
                CliError::Launch(format!(
                    "Daemon command admission could not commit: {error}"
                ))
            })?;
            Ok(CommandEffectDispatch::Execute(effect.stable_id()))
        }
        xmatrix_windows_continuity::EffectPhase::Admitted => {
            Ok(CommandEffectDispatch::Execute(effect.stable_id()))
        }
        xmatrix_windows_continuity::EffectPhase::EffectCommitted => {
            let stable_id = effect.stable_id();
            let expected_result_digest = effect.result_digest.clone().ok_or_else(|| {
                CliError::Launch("Committed daemon command effect has no result digest".into())
            })?;
            let report = effect.result.ok_or_else(|| {
                CliError::Launch("Committed daemon command effect has no replay result".into())
            })?;
            Ok(CommandEffectDispatch::Replay {
                stable_id,
                expected_result_digest,
                report: rebind_replayed_command_result(serde_json::from_value(report)?, command)?,
                persist_rebind: true,
            })
        }
        xmatrix_windows_continuity::EffectPhase::HubCompletionAcked => {
            let stable_id = effect.stable_id();
            let expected_result_digest = effect.result_digest.clone().unwrap_or_default();
            let report = effect.result.ok_or_else(|| {
                CliError::Launch("Acknowledged daemon command effect has no replay result".into())
            })?;
            // Hub redelivering an acknowledged command means it does not hold
            // that completion under the lease it just issued; answer under
            // this lease, not the one the old acknowledgement carried.
            Ok(CommandEffectDispatch::Replay {
                stable_id,
                expected_result_digest,
                report: rebind_replayed_command_result(serde_json::from_value(report)?, command)?,
                persist_rebind: false,
            })
        }
        xmatrix_windows_continuity::EffectPhase::Quarantined => Err(CliError::Launch(
            "Daemon command effect is quarantined".into(),
        )),
    }
}

fn persist_rebound_command_effect_result(
    journal: &DaemonEffectJournal,
    stable_id: &str,
    expected_result_digest: &str,
    report: &MachineDaemonReport,
) -> error::Result<()> {
    journal
        .lock()
        .map_err(|_| CliError::Launch("Daemon command effect journal is poisoned".into()))?
        .rebind_committed_result(
            stable_id,
            expected_result_digest,
            serde_json::to_value(report)?,
        )
        .map_err(|error| {
            CliError::Launch(format!(
                "Daemon command replay could not be rebound: {error}"
            ))
        })?;
    Ok(())
}

fn send_command_effect_result(
    journal: &DaemonEffectJournal,
    stable_id: &str,
    relay: &SharedMachineDaemonConnection,
    report: MachineDaemonReport,
) -> error::Result<()> {
    let report = relay.bind_registry_causality(report)?;
    commit_command_effect_result(journal, stable_id, &report)?;
    relay.send_report(report)
}

/// Admit a pushed non-spawn command from the task that will execute it.
///
/// The physical effect stays journaled as `admitted`, so a failed admission
/// leaves Hub free to re-lease the same command to this daemon later; the
/// caller only logs and returns. Spawn keeps its own combined admission.
async fn admit_deferred_daemon_command(
    hub_url: &str,
    relay: &SharedMachineDaemonConnection,
    command: &MachineDaemonCommand,
) -> error::Result<()> {
    admit_pushed_daemon_command(hub_url, relay, command)
        .await
        .inspect_err(|error| {
            eprintln!(
                "{} failed to admit daemon command: {error}",
                "⚠".yellow().bold()
            );
        })
}

struct DeferredDaemonCommandContext {
    hub_url: String,
    relay: SharedMachineDaemonConnection,
    effect_journal: DaemonEffectJournal,
    effect_id: String,
}

fn spawn_admitted_daemon_command<F, Fut>(
    hub_url: &str,
    relay: &SharedMachineDaemonConnection,
    effect_journal: &DaemonEffectJournal,
    effect_id: String,
    command: MachineDaemonCommand,
    execute: F,
) -> tokio::task::JoinHandle<()>
where
    F: FnOnce(DeferredDaemonCommandContext, MachineDaemonCommand) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let context = DeferredDaemonCommandContext {
        hub_url: hub_url.to_string(),
        relay: relay.clone(),
        effect_journal: effect_journal.clone(),
        effect_id,
    };
    config::spawn_profile_task(async move {
        if admit_deferred_daemon_command(&context.hub_url, &context.relay, &command)
            .await
            .is_err()
        {
            return;
        }
        execute(context, command).await;
    })
}

/// An install may outlive the short admission lease. Renew it for the whole
/// action, or the Hub would redeliver the command and the still-`Admitted`
/// effect would run the recipe a second time. A redelivery that arrives while
/// the same request is still running is ignored rather than answered.
async fn execute_leased_harness_action(
    hub_url: &str,
    relay: &SharedMachineDaemonConnection,
    command: MachineDaemonCommand,
) -> Option<MachineDaemonReport> {
    let MachineDaemonCommand::MachineHarnessAction {
        request_id,
        preset_id,
        action,
        relay_lease,
    } = command
    else {
        return None;
    };
    let _in_flight = runtime_daemon_harness_action::claim_request(&request_id)?;
    let lease = relay_lease.as_ref()?;
    let heartbeat = match relay.machine_credential() {
        Ok(credential) => {
            DaemonCommandLeaseHeartbeat::start(
                hub_url,
                &credential,
                relay.clone(),
                &request_id,
                lease,
                false,
                DaemonSpawnDelivery::Socket,
            )
            .await
        }
        Err(error) => Err(error),
    };
    let _heartbeat = match heartbeat {
        Ok(heartbeat) => heartbeat,
        Err(error) => {
            eprintln!(
                "{} harness action lease could not be held: {error}",
                "⚠".yellow().bold()
            );
            return None;
        }
    };
    // Re-reading inventory or a registry changes nothing a redelivery could repeat.
    let result = if matches!(
        action,
        machine_daemon_connection::HarnessAction::Refresh
            | machine_daemon_connection::HarnessAction::Release
    ) {
        runtime_daemon_harness_action::execute(&preset_id, action).await
    } else {
        match runtime_daemon_harness_action::begin_request_once(&request_id) {
            Ok(()) => runtime_daemon_harness_action::execute(&preset_id, action).await,
            Err(reason) => {
                runtime_daemon_harness_action::refused_request(&preset_id, action, &reason)
            }
        }
    };
    if let Some(inventory) = result.inventory.clone()
        && let Err(error) = relay.report_harness_inventory(inventory) {
            eprintln!("Harness inventory report deferred: {error}");
        }
    Some(MachineDaemonReport::MachineHarnessActionResult {
        request_id,
        result,
        relay_lease,
    })
}

fn commit_command_effect_result(
    journal: &DaemonEffectJournal,
    stable_id: &str,
    report: &MachineDaemonReport,
) -> error::Result<()> {
    let value = serde_json::to_value(report)?;
    journal
        .lock()
        .map_err(|_| CliError::Launch("Daemon command effect journal is poisoned".into()))?
        .commit_result(stable_id, value)
        .map_err(|error| {
            CliError::Launch(format!("Daemon command effect could not commit: {error}"))
        })?;
    Ok(())
}

fn replay_pending_command_effect_completions(
    journal: &DaemonEffectJournal,
    relay: &SharedMachineDaemonConnection,
) -> error::Result<usize> {
    let values = journal
        .lock()
        .map_err(|_| CliError::Launch("Daemon command effect journal is poisoned".into()))?
        .pending_completion_results()
        .map_err(|error| {
            CliError::Launch(format!(
                "Daemon command completion recovery failed: {error}"
            ))
        })?;
    let mut count = 0;
    for value in values {
        // A lease names the connection epoch that claimed it, and Hub accepts
        // a completion only from that epoch. A result committed under an
        // earlier connection is refused as a stale lease every time, so
        // resending it on each reconnect only repeats the 409. Hub either
        // redelivers the command, whose replay rebinds this result to the
        // new lease, or has already settled it.
        if !completion_lease_is_current(&value, |epoch| relay.owns_connection_epoch(epoch)) {
            continue;
        }
        relay.send_report(serde_json::from_value(value)?)?;
        count += 1;
    }
    Ok(count)
}

fn completion_lease_is_current(result: &Value, owns_epoch: impl Fn(u64) -> bool) -> bool {
    match result
        .pointer("/relayLease/daemonEpoch")
        .and_then(Value::as_u64)
    {
        Some(epoch) => owns_epoch(epoch),
        None => true,
    }
}

#[cfg(windows)]
struct SupervisorControlSession {
    pipe: xmatrix_windows_continuity::InheritedControlPipe,
    nonce: String,
    send_sequence: u64,
    receive_guard: xmatrix_windows_continuity::ReplayGuard,
}

#[cfg(not(windows))]
type SupervisorControlSession = ();

#[cfg(windows)]
fn daemon_activation_from_env() -> error::Result<Option<MachineDaemonActivationConnect>> {
    const TRANSACTION: &str = "XMATRIX_DAEMON_ACTIVATION_TRANSACTION_ID";
    const ARTIFACT: &str = "XMATRIX_DAEMON_ACTIVATION_ARTIFACT_SHA256";
    const SOURCE_EPOCH: &str = "XMATRIX_DAEMON_ACTIVATION_SOURCE_EPOCH";
    let Some(transaction_id) = std::env::var(TRANSACTION).ok() else {
        if std::env::var_os(ARTIFACT).is_some() || std::env::var_os(SOURCE_EPOCH).is_some() {
            return Err(CliError::Launch(
                "Incomplete Supervisor daemon activation environment".into(),
            ));
        }
        return Ok(None);
    };
    let transaction_nonce = std::env::var("XMATRIX_SUPERVISOR_TRANSACTION_NONCE")
        .map_err(|_| CliError::Launch("Daemon activation nonce is missing".into()))?;
    let artifact_sha256 = std::env::var(ARTIFACT)
        .map_err(|_| CliError::Launch("Daemon activation artifact digest is missing".into()))?;
    let source_connection_epoch = std::env::var(SOURCE_EPOCH)
        .map_err(|_| CliError::Launch("Daemon activation source epoch is missing".into()))?
        .parse::<u64>()
        .map_err(|_| CliError::Launch("Daemon activation source epoch is invalid".into()))?;
    if transaction_id.trim().is_empty()
        || transaction_nonce.len() < 32
        || artifact_sha256.len() != 64
        || !artifact_sha256
            .bytes()
            .all(|value| value.is_ascii_hexdigit())
        || source_connection_epoch == 0
    {
        return Err(CliError::Launch(
            "Supervisor daemon activation identity is invalid".into(),
        ));
    }
    let mode = std::env::var("XMATRIX_DAEMON_ACTIVATION_MODE")
        .ok()
        .filter(|value| value == "rollback")
        .unwrap_or_else(|| "recovering".into());
    Ok(Some(MachineDaemonActivationConnect {
        mode,
        transaction_id,
        transaction_nonce,
        artifact_sha256: artifact_sha256.to_ascii_lowercase(),
        source_connection_epoch,
    }))
}

#[cfg(not(windows))]
fn daemon_activation_from_env() -> error::Result<Option<MachineDaemonActivationConnect>> {
    Ok(None)
}

struct ProfileActorControl {
    generation: u64,
    shutdown: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for ProfileActorControl {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
        self.task.abort();
    }
}

struct ProfileActorCompletion {
    profile_id: xmatrix_cli_core::profile::ProfileId,
    generation: u64,
    outcome: Result<ProfileRuntimeExit, String>,
}

#[derive(Debug, Eq, PartialEq)]
enum ProfileRuntimeExit {
    LocalShutdown,
    HubShutdown(Option<String>),
    UpdateHandoff,
}

#[derive(Debug, Eq, PartialEq)]
enum ProfileCompletionDisposition {
    ExitHost,
    DisableProfile,
    ContinueSupervision,
}

fn profile_completion_disposition(
    outcome: &Result<ProfileRuntimeExit, String>,
) -> ProfileCompletionDisposition {
    match outcome {
        Ok(ProfileRuntimeExit::UpdateHandoff) => ProfileCompletionDisposition::ExitHost,
        Ok(ProfileRuntimeExit::HubShutdown(_)) => ProfileCompletionDisposition::DisableProfile,
        Ok(ProfileRuntimeExit::LocalShutdown) | Err(_) => {
            ProfileCompletionDisposition::ContinueSupervision
        }
    }
}

type SharedSupervisorControl = Arc<AsyncMutex<Option<SupervisorControlSession>>>;

async fn cmd_daemon(token_override: Option<&str>) -> error::Result<()> {
    #[cfg(windows)]
    if std::env::var("XMATRIX_DAEMON_PREFLIGHT").ok().as_deref() == Some("1") {
        let executable = std::fs::canonicalize(std::env::current_exe()?)?;
        let metadata = std::fs::metadata(&executable)?;
        if !metadata.is_file() || metadata.len() == 0 || !config::config_dir().is_absolute() {
            return Err(CliError::Launch(
                "Windows daemon preflight rejected its executable or state root".into(),
            ));
        }
        return Ok(());
    }
    http::mark_process_as_daemon();
    #[cfg(windows)]
    let mut supervisor_control = connect_supervisor_control()?;
    #[cfg(not(windows))]
    let supervisor_control: Option<SupervisorControlSession> = None;
    let activation = daemon_activation_from_env()?;
    let _daemon_lock = acquire_daemon_lock(daemon_restart_waits_for_lock())?;
    let installation = xmatrix_cli_core::profile::InstallationRoot::discover();
    let profile_store = xmatrix_cli_core::profile::ProfileStore::new(installation.clone());
    let registry = profile_store.load_or_bootstrap()?;
    let default_context = profile_store.context_for_default(&registry)?;
    let profile_manager = ProfileManager::load(installation)?;
    let (_daemon_host_control, mut host_control_rx) =
        DaemonHostControlServer::spawn(profile_manager.clone()).await?;
    #[cfg(windows)]
    acknowledge_supervisor(&mut supervisor_control)?;
    #[cfg(target_os = "macos")]
    let _daemon_log_rotation_handle = spawn_macos_daemon_log_rotation_task();
    #[cfg(not(windows))]
    {
        seal_daemon_host_update_recovery(&profile_manager)?;
        if config::scope_profile_context(
            default_context.clone(),
            daemon_self_update_and_restart_if_needed(
                &default_context.hub_origin,
                token_override,
                "startup",
            ),
        )
        .await
        .is_some()
        {
            return Ok(());
        }
    }

    let supervisor_control: SharedSupervisorControl = Arc::new(AsyncMutex::new(supervisor_control));
    let mut update_authority_id = default_context.id.clone();
    let token_override = token_override.map(str::to_string);
    let (completion_tx, mut completion_rx) = mpsc::channel::<ProfileActorCompletion>(128);
    let mut actors = BTreeMap::<xmatrix_cli_core::profile::ProfileId, ProfileActorControl>::new();
    let mut restart_attempts = BTreeMap::<xmatrix_cli_core::profile::ProfileId, u32>::new();
    let mut restart_after = BTreeMap::<xmatrix_cli_core::profile::ProfileId, Instant>::new();
    let mut stopped_profiles = HashSet::<xmatrix_cli_core::profile::ProfileId>::new();
    let mut restart_requested = HashSet::<xmatrix_cli_core::profile::ProfileId>::new();
    let mut next_actor_generation = 1_u64;
    let spawn_actor = |context: &xmatrix_cli_core::profile::ProfileContext,
                       generation,
                       activation,
                       authority_id: &xmatrix_cli_core::profile::ProfileId| {
        let update_authority = context.id == *authority_id;
        spawn_profile_actor(
            context.clone(),
            generation,
            token_override
                .as_deref()
                .filter(|_| update_authority)
                .map(str::to_string),
            activation,
            update_authority,
            supervisor_control.clone(),
            profile_manager.clone(),
            completion_tx.clone(),
        )
    };
    for context in profile_store.enabled_contexts(&registry)? {
        profile_store.prepare_context_state_root(&context)?;
        let control = spawn_actor(
            &context,
            next_actor_generation,
            (context.id == update_authority_id)
                .then(|| activation.clone())
                .flatten(),
            &update_authority_id,
        );
        next_actor_generation = next_actor_generation.saturating_add(1);
        actors.insert(context.id, control);
    }
    let mut reconcile_tick = tokio::time::interval(Duration::from_secs(2));
    reconcile_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
                    command = host_control_rx.recv() => {
                        let Some(DaemonHostProfileCommand { action, profile_id, response }) = command else {
                            return Err(CliError::Launch("Daemon host control command channel closed".into()));
                        };
                        let result = (|| -> error::Result<()> {
                            let registry = profile_store.load_or_bootstrap()?;
                            profile_manager.reconcile(None)?;
                            let context = profile_store.context_for_selector(
                                &registry,
                                profile_id.as_str(),
                                matches!(
                                    action,
                                    xmatrix_cli_core::daemon_host::ProfileControlAction::Stop
                                ),
                            )?;
                            match action {
                                xmatrix_cli_core::daemon_host::ProfileControlAction::Start => {
                                    stopped_profiles.remove(&profile_id);
                                    restart_requested.remove(&profile_id);
                                    restart_after.remove(&profile_id);
                                    restart_attempts.remove(&profile_id);
                                    if !actors.contains_key(&profile_id) {
                                        profile_store.prepare_context_state_root(&context)?;
                                        let control = spawn_actor(
         &context, next_actor_generation, None, &update_authority_id,
        );
                                        next_actor_generation = next_actor_generation.saturating_add(1);
                                        actors.insert(context.id, control);
                                    }
                                }
                                xmatrix_cli_core::daemon_host::ProfileControlAction::Stop => {
                                    stopped_profiles.insert(profile_id.clone());
                                    restart_requested.remove(&profile_id);
                                    restart_after.remove(&profile_id);
                                    if let Some(actor) = actors.get(&profile_id) {
                                        let _ = actor.shutdown.send(true);
                                        profile_manager.set_runtime_state(
                                            &profile_id,
                                            ProfileRuntimeLifecycleState::Draining,
                                            Some("stopped by local control".into()),
                                        )?;
                                    } else {
                                        profile_manager.set_runtime_state(
                                            &profile_id,
                                            ProfileRuntimeLifecycleState::Disabled,
                                            Some("stopped by local control".into()),
                                        )?;
                                    }
                                    if profile_id == update_authority_id {
                                        reconcile_update_authority(&registry, &stopped_profiles, &mut update_authority_id, &actors, &mut restart_requested, &profile_manager)?;
                                    }
                                }
                                xmatrix_cli_core::daemon_host::ProfileControlAction::Restart => {
                                    stopped_profiles.remove(&profile_id);
                                    restart_after.remove(&profile_id);
                                    restart_attempts.remove(&profile_id);
                                    if let Some(actor) = actors.get(&profile_id) {
                                        restart_requested.insert(profile_id.clone());
                                        let _ = actor.shutdown.send(true);
                                        profile_manager.set_runtime_state(
                                            &profile_id,
                                            ProfileRuntimeLifecycleState::Draining,
                                            Some("restart requested by local control".into()),
                                        )?;
                                    } else {
                                        profile_store.prepare_context_state_root(&context)?;
                                        let control = spawn_actor(
         &context, next_actor_generation, None, &update_authority_id,
        );
                                        next_actor_generation = next_actor_generation.saturating_add(1);
                                        actors.insert(context.id, control);
                                    }
                                }
                            }
                            persist_daemon_ready_state(&profile_manager)
                        })()
                        .and_then(|()| profile_manager.profile_control_response(&profile_id));
                        let _ = response.send(result);
                    }
                    completion = completion_rx.recv() => {
                        let Some(completion) = completion else {
                            return Err(CliError::Launch("Daemon ProfileRuntime completion channel closed".into()));
                        };
                        let is_current = actors
                            .get(&completion.profile_id)
                            .is_some_and(|actor| actor.generation == completion.generation);
                        if !is_current {
                            continue;
                        }
                        let shutdown_requested = actors
                            .get(&completion.profile_id)
                            .is_some_and(|actor| *actor.shutdown.borrow());
                        actors.remove(&completion.profile_id);
                        match profile_completion_disposition(&completion.outcome) {
                            ProfileCompletionDisposition::ExitHost => return Ok(()),
                            ProfileCompletionDisposition::DisableProfile => {
                                let reason = match &completion.outcome {
                                    Ok(ProfileRuntimeExit::HubShutdown(reason)) => reason.clone(),
                                    _ => unreachable!("completion disposition changed after classification"),
                                };
                                stopped_profiles.insert(completion.profile_id.clone());
                                profile_manager.set_runtime_state(
                                    &completion.profile_id,
                                    ProfileRuntimeLifecycleState::Disabled,
                                    Some(reason.unwrap_or_else(|| "stopped from xMatrix".into())),
                                )?;
                                persist_daemon_ready_state(&profile_manager)?;
                                continue;
                            }
                            ProfileCompletionDisposition::ContinueSupervision => {}
                        }
                        let outcome = completion.outcome;
                        if stopped_profiles.contains(&completion.profile_id) {
                            profile_manager.set_runtime_state(
                                &completion.profile_id,
                                ProfileRuntimeLifecycleState::Disabled,
                                Some("stopped by local control".into()),
                            )?;
                            persist_daemon_ready_state(&profile_manager)?;
                            continue;
                        }
                        if restart_requested.remove(&completion.profile_id) {
                            restart_after.insert(completion.profile_id.clone(), Instant::now());
                            profile_manager.set_runtime_state(
                                &completion.profile_id,
                                ProfileRuntimeLifecycleState::Starting,
                                Some("restart requested by local control".into()),
                            )?;
                            persist_daemon_ready_state(&profile_manager)?;
                            continue;
                        }
                        let is_enabled = profile_store
                            .load_or_bootstrap()?
                            .profiles
                            .iter()
                            .any(|profile| profile.id == completion.profile_id && profile.enabled && profile.is_selectable());
                        if !is_enabled {
                            profile_manager.set_runtime_state(
                                &completion.profile_id,
                                ProfileRuntimeLifecycleState::Disabled,
                                None,
                            )?;
                            persist_daemon_ready_state(&profile_manager)?;
                            continue;
                        }
                        let attempt = restart_attempts
                            .entry(completion.profile_id.clone())
                            .and_modify(|attempt| *attempt = attempt.saturating_add(1))
                            .or_insert(1);
                        let delay_secs = 1_u64.checked_shl((*attempt).min(6)).unwrap_or(64).min(60);
                        restart_after.insert(
                            completion.profile_id.clone(),
                            Instant::now() + Duration::from_secs(delay_secs),
                        );
                        profile_manager.set_runtime_state(
                            &completion.profile_id,
                            ProfileRuntimeLifecycleState::Backoff,
                            match outcome {
                                Err(error) => Some(bounded_daemon_host_detail(&error)),
                                Ok(ProfileRuntimeExit::LocalShutdown) if !shutdown_requested => {
                                    Some("profile runtime stopped unexpectedly".into())
                                }
                                _ => None,
                            },
                        )?;
                        persist_daemon_ready_state(&profile_manager)?;
                    }
                    _ = reconcile_tick.tick() => {
                        let registry = match profile_store.load_or_bootstrap() {
                            Ok(registry) => registry,
                            Err(error) => {
                                eprintln!("{} profile registry reconcile failed: {error}", "⚠".yellow().bold());
                                continue;
                            }
                        };
                        profile_manager.reconcile(None)?;
                        let contexts = profile_store.enabled_contexts(&registry)?;
                        let enabled_ids = contexts
                            .iter()
                            .map(|context| context.id.clone())
                            .collect::<HashSet<_>>();
                        reconcile_update_authority(&registry, &stopped_profiles, &mut update_authority_id, &actors, &mut restart_requested, &profile_manager)?;
                        for (profile_id, actor) in &actors {
                            if !enabled_ids.contains(profile_id) {
                                let _ = actor.shutdown.send(true);
                                profile_manager.set_runtime_state(
                                    profile_id,
                                    ProfileRuntimeLifecycleState::Draining,
                                    None,
                                )?;
                            }
                        }
                        for context in contexts {
                            if stopped_profiles.contains(&context.id)
                                || actors.contains_key(&context.id)
                                || restart_after
                                    .get(&context.id)
                                    .is_some_and(|deadline| *deadline > Instant::now())
                            {
                                continue;
                            }
                            profile_store.prepare_context_state_root(&context)?;
                            let control = spawn_actor(
         &context, next_actor_generation, None, &update_authority_id,
        );
                            next_actor_generation = next_actor_generation.saturating_add(1);
                            restart_after.remove(&context.id);
                            actors.insert(context.id, control);
                        }
                        persist_daemon_ready_state(&profile_manager)?;
                    }
                }
    }
}

fn reconcile_update_authority(
    registry: &xmatrix_cli_core::profile::ProfileRegistry,
    stopped_profiles: &HashSet<xmatrix_cli_core::profile::ProfileId>,
    current: &mut xmatrix_cli_core::profile::ProfileId,
    actors: &BTreeMap<xmatrix_cli_core::profile::ProfileId, ProfileActorControl>,
    restart_requested: &mut HashSet<xmatrix_cli_core::profile::ProfileId>,
    profile_manager: &ProfileManager,
) -> error::Result<()> {
    if let Some(successor) = select_update_authority(
        registry,
        stopped_profiles,
        &actors.keys().cloned().collect(),
        current,
    ) && successor != *current
    {
        *current = successor.clone();
        if let Some(actor) = actors.get(&successor) {
            restart_requested.insert(successor.clone());
            let _ = actor.shutdown.send(true);
            profile_manager.set_runtime_state(
                &successor,
                ProfileRuntimeLifecycleState::Draining,
                Some("assuming daemon update authority".into()),
            )?;
        }
    }
    Ok(())
}

fn select_update_authority(
    registry: &xmatrix_cli_core::profile::ProfileRegistry,
    stopped_profiles: &HashSet<xmatrix_cli_core::profile::ProfileId>,
    running_profiles: &HashSet<xmatrix_cli_core::profile::ProfileId>,
    current: &xmatrix_cli_core::profile::ProfileId,
) -> Option<xmatrix_cli_core::profile::ProfileId> {
    let available = |profile: &&xmatrix_cli_core::profile::ProfileRecord| {
        profile.enabled && profile.is_selectable() && !stopped_profiles.contains(&profile.id)
    };
    registry
        .profiles
        .iter()
        .filter(available)
        .find(|profile| profile.id == *current && running_profiles.contains(&profile.id))
        .or_else(|| {
            registry.profiles.iter().filter(available).find(|profile| {
                profile.id == registry.default_profile_id && running_profiles.contains(&profile.id)
            })
        })
        .or_else(|| {
            registry
                .profiles
                .iter()
                .filter(available)
                .find(|profile| running_profiles.contains(&profile.id))
        })
        .or_else(|| {
            registry
                .profiles
                .iter()
                .filter(available)
                .find(|profile| profile.id == registry.default_profile_id)
        })
        .or_else(|| registry.profiles.iter().find(available))
        .map(|profile| profile.id.clone())
}

#[allow(clippy::too_many_arguments)]
fn spawn_profile_actor(
    context: xmatrix_cli_core::profile::ProfileContext,
    generation: u64,
    token_override: Option<String>,
    activation: Option<MachineDaemonActivationConnect>,
    update_authority: bool,
    supervisor_control: SharedSupervisorControl,
    profile_manager: ProfileManager,
    completion_tx: mpsc::Sender<ProfileActorCompletion>,
) -> ProfileActorControl {
    let profile_id = context.id.clone();
    let completion_profile_id = profile_id.clone();
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let task = tokio::spawn(async move {
        let tasks = config::ProfileTaskSet::new();
        let outcome = config::scope_profile_context(
            context.clone(),
            config::scope_profile_tasks(
                tasks.clone(),
                run_profile_runtime(
                    context,
                    token_override,
                    activation,
                    update_authority,
                    supervisor_control,
                    profile_manager,
                    shutdown_rx,
                ),
            ),
        )
        .await;
        // The runtime owns its brokers, maintenance loops and report retries.
        // A restart that left them running handed the successor a served
        // `auth-broker.sock` it could not bind and a second reconciler on the
        // same registry file; every Run spawned after that failed auth.
        let cancelled = tasks.abort_all().await;
        if cancelled > 0 {
            eprintln!(
                "{} profile runtime stopped; cancelled {cancelled} background task(s)",
                "○".cyan().bold()
            );
        }
        let _ = completion_tx
            .send(ProfileActorCompletion {
                profile_id: completion_profile_id,
                generation,
                outcome: outcome.map_err(|error| error.to_string()),
            })
            .await;
    });
    ProfileActorControl {
        generation,
        shutdown: shutdown_tx,
        task,
    }
}

async fn run_profile_runtime(
    context: xmatrix_cli_core::profile::ProfileContext,
    token_override: Option<String>,
    activation: Option<MachineDaemonActivationConnect>,
    update_authority: bool,
    supervisor_control: SharedSupervisorControl,
    profile_manager: ProfileManager,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> error::Result<ProfileRuntimeExit> {
    loop {
        if *shutdown.borrow() {
            return Ok(ProfileRuntimeExit::LocalShutdown);
        }
        profile_manager.set_runtime_state(
            &context.id,
            ProfileRuntimeLifecycleState::Starting,
            None,
        )?;
        let session_source_before = saved_daemon_session_source(&context.hub_origin).await;
        let connected = if update_authority {
            let mut supervisor = supervisor_control.lock().await;
            cmd_daemon_connected(
                &context.hub_origin,
                token_override.as_deref(),
                supervisor.as_mut(),
                activation.clone(),
                &profile_manager,
                update_authority,
                &mut shutdown,
            )
            .await
        } else {
            cmd_daemon_connected(
                &context.hub_origin,
                token_override.as_deref(),
                None,
                None,
                &profile_manager,
                update_authority,
                &mut shutdown,
            )
            .await
        };
        match connected {
            Ok(_) if *shutdown.borrow() => return Ok(ProfileRuntimeExit::LocalShutdown),
            Ok(exit) => return Ok(exit),
            Err(err) if token_override.is_none() && daemon_spawn_needs_remote_login(&err) => {
                profile_manager.set_runtime_state(
                    &context.id,
                    ProfileRuntimeLifecycleState::Degraded,
                    Some("login required".into()),
                )?;
                tokio::select! {
                    _ = wait_for_saved_daemon_session_change(&context.hub_origin, session_source_before) => {}
                    changed = shutdown.changed() => {
                        if changed.is_ok() && *shutdown.borrow() {
                            return Ok(ProfileRuntimeExit::LocalShutdown);
                        }
                    }
                }
            }
            Err(err) => {
                profile_manager.set_runtime_state(
                    &context.id,
                    ProfileRuntimeLifecycleState::Degraded,
                    Some(bounded_daemon_host_detail(&err.to_string())),
                )?;
                return Err(err);
            }
        }
    }
}

fn bounded_daemon_host_detail(value: &str) -> String {
    value.chars().take(240).collect()
}

#[cfg(windows)]
fn connect_supervisor_control() -> error::Result<Option<SupervisorControlSession>> {
    if std::env::var_os(xmatrix_windows_continuity::CONTROL_PROTOCOL_ENV).is_none() {
        return Ok(None);
    }
    let pipe = xmatrix_windows_continuity::connect_inherited_control_pipe().map_err(|error| {
        CliError::Launch(format!(
            "Daemon inherited Supervisor pipe is invalid: {error}"
        ))
    })?;
    let nonce = std::env::var("XMATRIX_SUPERVISOR_TRANSACTION_NONCE").map_err(|_| {
        CliError::Launch("Supervisor-launched daemon is missing its transaction nonce".into())
    })?;
    let receive_guard =
        xmatrix_windows_continuity::ReplayGuard::new(nonce.clone()).map_err(|error| {
            CliError::Launch(format!(
                "Daemon Supervisor replay guard is invalid: {error}"
            ))
        })?;
    Ok(Some(SupervisorControlSession {
        pipe,
        nonce,
        send_sequence: 1,
        receive_guard,
    }))
}

#[cfg(windows)]
fn acknowledge_supervisor(control: &mut Option<SupervisorControlSession>) -> error::Result<()> {
    let Some(control) = control.as_mut() else {
        return Ok(());
    };
    control
        .pipe
        .send(&xmatrix_windows_continuity::ControlMessage::Hello {
            protocol_major: xmatrix_windows_continuity::SUPERVISOR_PROTOCOL_MAJOR,
            nonce: control.nonce.clone(),
        })
        .map_err(|error| {
            CliError::Launch(format!(
                "Daemon could not acknowledge its inherited Supervisor pipe: {error}"
            ))
        })
}

#[cfg(windows)]
impl SupervisorControlSession {
    fn send(&mut self, message: xmatrix_windows_continuity::ControlMessage) -> error::Result<()> {
        let frame = xmatrix_windows_continuity::AuthenticatedControlFrame {
            protocol_major: xmatrix_windows_continuity::SUPERVISOR_PROTOCOL_MAJOR,
            sequence: self.send_sequence,
            nonce: self.nonce.clone(),
            message,
        };
        self.pipe.send_authenticated(&frame).map_err(|error| {
            CliError::Launch(format!("Daemon Supervisor control write failed: {error}"))
        })?;
        self.send_sequence = self.send_sequence.saturating_add(1);
        Ok(())
    }

    fn checked_message(
        &mut self,
        received: Result<
            xmatrix_windows_continuity::AuthenticatedControlFrame,
            xmatrix_windows_continuity::ContinuityError,
        >,
    ) -> error::Result<xmatrix_windows_continuity::ControlMessage> {
        let frame = received.map_err(|error| {
            CliError::Launch(format!("Daemon Supervisor control read failed: {error}"))
        })?;
        self.receive_guard.validate(&frame).map_err(|error| {
            CliError::Launch(format!(
                "Daemon Supervisor control replay rejected: {error}"
            ))
        })?;
        Ok(frame.message)
    }

    fn receive(&mut self) -> error::Result<xmatrix_windows_continuity::ControlMessage> {
        let received = self.pipe.receive_authenticated();
        self.checked_message(received)
    }

    fn receive_timeout(
        &mut self,
        timeout: Duration,
    ) -> error::Result<xmatrix_windows_continuity::ControlMessage> {
        let mut pipe = self.pipe.try_clone().map_err(|error| {
            CliError::Launch(format!("Daemon Supervisor pipe clone failed: {error}"))
        })?;
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("xmatrix-supervisor-control-read".into())
            .spawn(move || {
                let _ = send.send(pipe.receive_authenticated());
            })
            .map_err(|error| {
                CliError::Launch(format!("Daemon Supervisor control reader failed: {error}"))
            })?;
        let received = receive
            .recv_timeout(timeout)
            .map_err(|_| CliError::Launch("Daemon Supervisor control response timed out".into()))?;
        self.checked_message(received)
    }
}

#[cfg(windows)]
fn validate_activation_receipt(
    receipt: &MachineDaemonActivationReceipt,
    activation: &MachineDaemonActivationConnect,
) -> error::Result<()> {
    if receipt.message_type != "machine_activation_receipt"
        || receipt.transaction_id != activation.transaction_id
        || receipt.artifact_sha256 != activation.artifact_sha256
        || receipt.connection_epoch == 0
        || receipt.receipt_id.trim().is_empty()
    {
        return Err(CliError::Launch(
            "Hub activation receipt does not match the exact Supervisor transaction".into(),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn send_activation_receipt_to_supervisor(
    control: &mut SupervisorControlSession,
    activation: &MachineDaemonActivationConnect,
    receipt: &MachineDaemonActivationReceipt,
) -> error::Result<()> {
    validate_activation_receipt(receipt, activation)?;
    control.send(
        xmatrix_windows_continuity::ControlMessage::HubActivationReceipt {
            transaction_id: activation.transaction_id.clone(),
            nonce: activation.transaction_nonce.clone(),
            hub_epoch: receipt.connection_epoch,
            phase: receipt.phase.clone(),
            receipt_id: receipt.receipt_id.clone(),
            run_set_digest: receipt.run_set_digest.clone(),
            prepared_receipt_id: receipt.prepared_receipt_id.clone(),
            active_fenced_receipt_id: receipt.active_fenced_receipt_id.clone(),
            active_receipt_id: receipt.active_receipt_id.clone(),
        },
    )
}

#[cfg(windows)]
async fn complete_daemon_activation(
    relay: &MachineDaemonConnectionClient,
    registry: &DaemonRunRegistry,
    request_broker: Option<&DaemonRequestBroker>,
    supervisor_control: Option<&mut SupervisorControlSession>,
    activation: Option<&MachineDaemonActivationConnect>,
) -> error::Result<()> {
    let Some(control) = supervisor_control else {
        if activation.is_some() {
            return Err(CliError::Launch(
                "Recovering daemon has no inherited Supervisor authority".into(),
            ));
        }
        return Ok(());
    };
    let Some(activation) = activation else {
        let epoch = relay.connection_epoch().ok_or_else(|| {
            CliError::RelayTransient("Stable daemon has no authenticated Hub epoch".into())
        })?;
        return control
            .send(xmatrix_windows_continuity::ControlMessage::StableReady { hub_epoch: epoch });
    };
    let mut receipt = relay.activation_receipt().ok_or_else(|| {
        CliError::Launch("Recovering daemon did not receive a Hub activation receipt".into())
    })?;
    validate_activation_receipt(&receipt, activation)?;
    if receipt.phase == "recovering" {
        let expected = receipt.expected_run_ids.clone().ok_or_else(|| {
            CliError::Launch("Hub recovery receipt omitted its authoritative Run set".into())
        })?;
        let local_runs = registry
            .lock()
            .await
            .values()
            .filter_map(|run| run.run_id.clone())
            .collect::<std::collections::BTreeSet<_>>();
        let expected_set = expected
            .iter()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        if local_runs
            .iter()
            .any(|run_id| !expected_set.contains(run_id))
        {
            let _ = relay
                .advance_activation_at_epoch(
                    activation.transaction_id.clone(),
                    activation.artifact_sha256.clone(),
                    receipt.connection_epoch,
                    "abort",
                )
                .await;
            control.send(xmatrix_windows_continuity::ControlMessage::FailClosed {
                transaction_id: Some(activation.transaction_id.clone()),
                reason: "local wrapper is absent from the Hub-authoritative Run set".into(),
            })?;
            return Err(CliError::Launch(
                "Windows Run recovery found a local wrapper outside Hub authority".into(),
            ));
        }
        let mut adopted_run_ids = Vec::new();
        let mut adopted_runs = Vec::new();
        {
            let guard = registry.lock().await;
            for run_id in &expected {
                let managed = guard
                    .values()
                    .find(|managed| managed.run_id.as_deref() == Some(run_id.as_str()));
                let Some(managed) = managed else { continue };
                let status_path = managed.status_file_path.as_deref().ok_or_else(|| {
                    CliError::Launch(format!("Run {run_id} has no v2 adoption sidecar path"))
                })?;
                let evidence = runtime_windows_run_adoption::read_evidence(status_path)?;
                if evidence.pid != managed.pid
                    || evidence.execution_key
                        != managed.execution_key.as_deref().unwrap_or_default()
                    || evidence.instance_id != managed.instance_id.as_deref().unwrap_or_default()
                {
                    return Err(CliError::Launch(format!(
                        "Run {run_id} sidecar identity conflicts with the recovered registry"
                    )));
                }
                runtime_windows_run_adoption::challenge(
                    &evidence,
                    &activation.transaction_id,
                    &activation.transaction_nonce,
                    run_broker_rotation(managed, request_broker),
                )?;
                adopted_run_ids.push(run_id.clone());
                adopted_runs.push(MachineDaemonAdoptedRunEvidence {
                    run_id: run_id.clone(),
                    adoption_key_hash: evidence.adoption_key_hash,
                    wrapper_nonce: evidence.wrapper_nonce,
                    process_birth_id: evidence.process_birth_id.to_string(),
                    executable_sha256: evidence.executable_sha256,
                });
            }
        }
        let adopted_set = adopted_run_ids
            .iter()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        let natural_terminal_run_ids = expected
            .iter()
            .filter(|run_id| !adopted_set.contains(*run_id))
            .cloned()
            .collect::<Vec<_>>();
        let run_set_digest = receipt.run_set_digest.clone().ok_or_else(|| {
            CliError::Launch("Hub recovery receipt omitted its Run-set digest".into())
        })?;
        receipt = relay
            .prepare_activation(
                activation.transaction_id.clone(),
                activation.artifact_sha256.clone(),
                run_set_digest,
                expected,
                adopted_run_ids,
                natural_terminal_run_ids,
                adopted_runs,
            )
            .await?;
    }
    if receipt.phase == "activation_prepared" {
        send_activation_receipt_to_supervisor(control, activation, &receipt)?;
        match control.receive()? {
            xmatrix_windows_continuity::ControlMessage::LocalCommitted {
                transaction_id,
                nonce,
            } if transaction_id == activation.transaction_id
                && nonce == activation.transaction_nonce => {}
            _ => {
                return Err(CliError::Launch(
                    "Supervisor did not bind local commit to this activation".into(),
                ));
            }
        }
        receipt = relay
            .advance_activation(
                activation.transaction_id.clone(),
                activation.artifact_sha256.clone(),
                "active_fenced",
            )
            .await?;
    }
    if receipt.phase == "active_fenced" {
        send_activation_receipt_to_supervisor(control, activation, &receipt)?;
        receipt = relay
            .advance_activation(
                activation.transaction_id.clone(),
                activation.artifact_sha256.clone(),
                "active",
            )
            .await?;
    }
    if receipt.phase == "active" {
        send_activation_receipt_to_supervisor(control, activation, &receipt)?;
        match control.receive()? {
            xmatrix_windows_continuity::ControlMessage::StableGranted {
                transaction_id,
                nonce,
            } if transaction_id == activation.transaction_id
                && nonce == activation.transaction_nonce => {}
            _ => {
                return Err(CliError::Launch(
                    "Supervisor did not grant Stable for this activation".into(),
                ));
            }
        }
        receipt = relay
            .advance_activation(
                activation.transaction_id.clone(),
                activation.artifact_sha256.clone(),
                "stable_granted",
            )
            .await?;
    }
    if receipt.phase != "stable_granted" {
        return Err(CliError::Launch(format!(
            "Windows daemon activation stopped in unexpected Hub phase {}",
            receipt.phase
        )));
    }
    send_activation_receipt_to_supervisor(control, activation, &receipt)?;
    Ok(())
}

#[cfg(windows)]
fn run_broker_rotation(
    managed: &DaemonRunChild,
    request_broker: Option<&DaemonRequestBroker>,
) -> runtime_windows_run_adoption::BrokerRotation {
    runtime_windows_run_adoption::BrokerRotation {
        auth: managed._auth_grant.as_ref().map(|grant| {
            runtime_windows_run_adoption::BrokerTarget {
                url: grant.url.clone(),
                capability: grant.broker_capability().to_string(),
            }
        }),
        request: request_broker.and_then(|broker| {
            managed.request_capability.as_ref().map(|capability| {
                runtime_windows_run_adoption::BrokerTarget {
                    url: broker.url.clone(),
                    capability: capability.clone(),
                }
            })
        }),
    }
}

#[cfg(windows)]
async fn handoff_windows_daemon_candidate(
    relay: &SharedMachineDaemonConnection,
    registry: &DaemonRunRegistry,
    request_broker: Option<&DaemonRequestBroker>,
    effect_journal: &DaemonEffectJournal,
    control: &mut SupervisorControlSession,
    candidate: WindowsStagedDaemonCandidate,
) -> error::Result<()> {
    let counts = effect_journal
        .lock()
        .map_err(|_| CliError::Launch("Daemon command effect journal is poisoned".into()))?
        .phase_counts()
        .map_err(|error| CliError::Launch(format!("Daemon effect accounting failed: {error}")))?;
    if counts.get("Received").copied().unwrap_or(0) > 0
        || counts.get("Admitted").copied().unwrap_or(0) > 0
    {
        return Err(CliError::Launch(
            "in-flight daemon command effects have not reached a durable result".into(),
        ));
    }
    let source_hub_epoch = relay.connection_epoch().ok_or_else(|| {
        CliError::RelayTransient("Daemon update has no active source Hub epoch".into())
    })?;
    let transaction_id = uuid::Uuid::new_v4().to_string();
    let transaction_nonce = uuid::Uuid::new_v4().simple().to_string();
    let (local, generation_pins) = {
        let guard = registry.lock().await;
        let mut local = std::collections::BTreeSet::new();
        let mut pins = std::collections::BTreeSet::new();
        for managed in guard.values() {
            let Some(run_id) = managed.run_id.as_ref() else {
                continue;
            };
            let status_path = managed.status_file_path.as_deref().ok_or_else(|| {
                CliError::Launch(format!("Run {run_id} has no v2 adoption sidecar"))
            })?;
            let evidence = runtime_windows_run_adoption::read_evidence(status_path)?;
            runtime_windows_run_adoption::challenge(
                &evidence,
                &transaction_id,
                &transaction_nonce,
                run_broker_rotation(managed, request_broker),
            )?;
            let generation = evidence
                .executable_path
                .parent()
                .and_then(std::path::Path::file_name)
                .and_then(|value| value.to_str())
                .ok_or_else(|| CliError::Launch("Run generation pin is invalid".into()))?;
            local.insert(run_id.clone());
            pins.insert(generation.to_string());
        }
        (local, pins)
    };
    let artifact_sha256 = candidate.artifact.sha256.clone();
    control.send(xmatrix_windows_continuity::ControlMessage::StageCandidate {
        transaction_id: transaction_id.clone(),
        nonce: transaction_nonce.clone(),
        source_hub_epoch,
        artifact: candidate.artifact,
    })?;
    match control.receive_timeout(Duration::from_secs(60))? {
        xmatrix_windows_continuity::ControlMessage::BeginDrain {
            transaction_id: received_transaction,
            nonce: received_nonce,
        } if received_transaction == transaction_id && received_nonce == transaction_nonce => {}
        xmatrix_windows_continuity::ControlMessage::FailClosed { reason, .. } => {
            return Err(CliError::Launch(format!(
                "Supervisor rejected candidate: {reason}"
            )));
        }
        _ => return Err(CliError::Launch("Supervisor drain grant is invalid".into())),
    }
    let receipt = match relay
        .begin_activation(
            transaction_id.clone(),
            transaction_nonce.clone(),
            artifact_sha256.clone(),
        )
        .await
    {
        Ok(receipt) => receipt,
        Err(error) => {
            abort_supervisor_drain(control, &transaction_id, &transaction_nonce, &error);
            return Err(error);
        }
    };
    let provisional_epoch = receipt.connection_epoch;
    let activation = MachineDaemonActivationConnect {
        mode: "recovering".into(),
        transaction_id: transaction_id.clone(),
        transaction_nonce: transaction_nonce.clone(),
        artifact_sha256: artifact_sha256.clone(),
        source_connection_epoch: source_hub_epoch,
    };
    if let Err(error) = validate_activation_receipt(&receipt, &activation) {
        abort_windows_daemon_activation(relay, control, &activation, provisional_epoch, &error)
            .await;
        return Err(error);
    }
    let expected = match receipt.expected_run_ids.clone() {
        Some(expected) => expected,
        None => {
            let error = CliError::Launch("Hub drain receipt omitted its exact Run set".into());
            abort_windows_daemon_activation(relay, control, &activation, provisional_epoch, &error)
                .await;
            return Err(error);
        }
    };
    let expected_set = expected
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    if local != expected_set {
        let error = CliError::Launch(
            "Hub and local Run sets differ before drain; activation remains fenced".into(),
        );
        abort_windows_daemon_activation(relay, control, &activation, provisional_epoch, &error)
            .await;
        return Err(error);
    }
    let run_set_digest = match receipt.run_set_digest {
        Some(digest) => digest,
        None => {
            let error = CliError::Launch("Hub drain receipt omitted its Run-set digest".into());
            abort_windows_daemon_activation(relay, control, &activation, provisional_epoch, &error)
                .await;
            return Err(error);
        }
    };
    control.send(xmatrix_windows_continuity::ControlMessage::DrainReady {
        transaction_id: transaction_id.clone(),
        nonce: transaction_nonce.clone(),
        run_set_digest,
        generation_pins,
    })?;
    match control.receive_timeout(Duration::from_secs(30))? {
        xmatrix_windows_continuity::ControlMessage::CommitExit {
            transaction_id: received_transaction,
            nonce: received_nonce,
        } if received_transaction == transaction_id && received_nonce == transaction_nonce => {
            Ok(())
        }
        _ => Err(CliError::Launch(
            "Supervisor CommitExit evidence is invalid".into(),
        )),
    }
}

#[cfg(windows)]
async fn abort_windows_daemon_activation(
    relay: &SharedMachineDaemonConnection,
    control: &mut SupervisorControlSession,
    activation: &MachineDaemonActivationConnect,
    provisional_epoch: u64,
    error: &CliError,
) {
    let _ = relay
        .advance_activation_at_epoch(
            activation.transaction_id.clone(),
            activation.artifact_sha256.clone(),
            provisional_epoch,
            "abort",
        )
        .await;
    abort_supervisor_drain(
        control,
        &activation.transaction_id,
        &activation.transaction_nonce,
        error,
    );
}

#[cfg(windows)]
fn abort_supervisor_drain(
    control: &mut SupervisorControlSession,
    transaction_id: &str,
    transaction_nonce: &str,
    error: &CliError,
) {
    let _ = control.send(xmatrix_windows_continuity::ControlMessage::AbortDrain {
        transaction_id: transaction_id.to_string(),
        nonce: transaction_nonce.to_string(),
        reason: error.to_string(),
    });
    let _ = control.receive_timeout(Duration::from_secs(10));
}

#[cfg(not(windows))]
async fn complete_daemon_activation(
    _relay: &MachineDaemonConnectionClient,
    _registry: &DaemonRunRegistry,
    _request_broker: Option<&DaemonRequestBroker>,
    _supervisor_control: Option<&mut SupervisorControlSession>,
    _activation: Option<&MachineDaemonActivationConnect>,
) -> error::Result<()> {
    Ok(())
}

async fn saved_daemon_session_source(hub_url: &str) -> Option<DaemonSessionSource> {
    config::load_session_for_hub(hub_url)
        .await
        .as_ref()
        .map(DaemonSessionSource::from_saved_session)
}

async fn wait_for_saved_daemon_session_change(
    hub_url: &str,
    baseline: Option<DaemonSessionSource>,
) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if saved_daemon_session_source(hub_url).await != baseline || Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn register_long_lived_relay(
    relay: &mut agent_instance_connection::AgentInstanceConnectionClient,
    label: &str,
    refresh_daemon_auth: bool,
) -> error::Result<(protocol::SerializedAgent, Vec<protocol::SerializedAgent>)> {
    let mut attempt: u32 = 0;
    let mut delay_ms = LONG_LIVED_REGISTER_RETRY_BASE_MS;
    let mut next_daemon_auth_refresh = refresh_daemon_auth
        .then(|| Instant::now() + Duration::from_secs(AGENT_RUN_TOKEN_REFRESH_INTERVAL_SECS));
    loop {
        if next_daemon_auth_refresh.is_some_and(|deadline| Instant::now() >= deadline) {
            match resolve_local_daemon_auth_token_for_refresh().await {
                Ok(Some(token)) => {
                    relay.update_auth_token(token)?;
                    next_daemon_auth_refresh = Some(
                        Instant::now() + Duration::from_secs(AGENT_RUN_TOKEN_REFRESH_INTERVAL_SECS),
                    );
                }
                Ok(None) => {
                    next_daemon_auth_refresh = None;
                }
                Err(err) => {
                    let detail = format!(
                        "{label} initial relay registration could not refresh its run credential: {err}"
                    );
                    write_current_run_error_status("relay_auth_refresh_retrying", false, &err);
                    eprintln!("{} {detail}", "⚠".yellow().bold());
                    next_daemon_auth_refresh =
                        Some(Instant::now() + Duration::from_secs(DAEMON_AUTH_REFRESH_RETRY_SECS));
                }
            }
        }

        match relay.register().await {
            Ok(registered) => return Ok(registered),
            Err(err)
                if is_retryable_initial_register_error(&err)
                    || is_bounded_retryable_session_register_error(&err, attempt) =>
            {
                attempt = attempt.saturating_add(1);
                write_current_run_error_status("relay_register_retrying", false, &err);
                wait_long_lived_register_retry(
                    &mut delay_ms,
                    attempt,
                    &format!("{label} relay registration failed ({err})"),
                    true,
                )
                .await;
            }
            Err(err) => return Err(err),
        }
    }
}

async fn register_long_lived_machine_daemon(
    connection: &mut MachineDaemonConnectionClient,
) -> error::Result<SerializedMachineDaemon> {
    let mut attempt: u32 = 0;
    let mut delay_ms = LONG_LIVED_REGISTER_RETRY_BASE_MS;

    loop {
        match connection.register().await {
            Ok(daemon) => return Ok(daemon),
            Err(err) if is_retryable_initial_register_error(&err) => {
                attempt = attempt.saturating_add(1);
                wait_long_lived_register_retry(
                    &mut delay_ms,
                    attempt,
                    &format!("machine daemon connection failed ({err})"),
                    false,
                )
                .await;
            }
            Err(err) => return Err(err),
        }
    }
}

fn operation_retryable_or(err: &CliError, fallback: impl FnOnce(&CliError, &str) -> bool) -> bool {
    if let Some(failure) = err.operation_failure() {
        return failure.retryable;
    }
    fallback(err, &err.to_string().to_ascii_lowercase())
}

fn is_retryable_initial_register_error(err: &CliError) -> bool {
    operation_retryable_or(err, |err, message| {
        matches!(err, CliError::RelayTransient(_) | CliError::Request(_))
            || message.contains("error sending request")
            || message.contains("websocket handshake failed")
            || message.contains("websocket handshake timed out")
            || message.contains("websocket write failed")
            || message.contains("websocket write timed out")
            || message.contains("read error:")
            || message.contains("connection closed before registration")
            || message.contains("timed out waiting for registration response")
    })
}

const INITIAL_REGISTER_GENERIC_SESSION_RETRY_LIMIT: u32 = 6;

fn is_generic_session_register_error(err: &CliError) -> bool {
    if err.operation_failure().is_some() {
        return false;
    }
    err.to_string()
        .to_ascii_lowercase()
        .contains("agent session request could not be completed")
}

fn is_bounded_retryable_session_register_error(err: &CliError, attempt: u32) -> bool {
    is_generic_session_register_error(err) && attempt < INITIAL_REGISTER_GENERIC_SESSION_RETRY_LIMIT
}

async fn join_long_lived_initial_channel(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    channel_id: String,
    history_limit: u32,
) -> error::Result<()> {
    let mut attempt: u32 = 0;
    let mut delay_ms = LONG_LIVED_REGISTER_RETRY_BASE_MS;

    loop {
        match relay.join_channel(channel_id.clone(), history_limit).await {
            Ok(()) => {
                eprintln!(
                    "{} Joined channel {}",
                    "✓".green().bold(),
                    channel_id.dimmed()
                );
                return Ok(());
            }
            Err(err) if is_retryable_relay_operation_error(&err) => {
                attempt = attempt.saturating_add(1);
                write_current_run_error_status("channel_join_retrying", false, &err);
                wait_long_lived_register_retry(
                    &mut delay_ms,
                    attempt,
                    &format!("initial channel join failed ({err})"),
                    true,
                )
                .await;
            }
            Err(err) => return Err(err),
        }
    }
}

fn is_retryable_relay_operation_error(err: &CliError) -> bool {
    operation_retryable_or(err, |err, message| {
        matches!(err, CliError::RelayTransient(_))
            || message.contains("response channel closed")
            || message.contains("response timed out")
    })
}

async fn wait_long_lived_register_retry(
    delay_ms: &mut u64,
    attempt: u32,
    failure: &str,
    record_connection_retry: bool,
) {
    let jitter_ms = current_time_millis().unwrap_or_default() % LONG_LIVED_REGISTER_RETRY_JITTER_MS;
    let sleep_ms = delay_ms.saturating_add(jitter_ms);
    if record_connection_retry {
        write_current_connection_retry(attempt, sleep_ms);
    }
    eprintln!(
        "{} {failure}; retrying in {}ms (attempt {})",
        "⚠".yellow().bold(),
        sleep_ms,
        attempt
    );
    tokio::time::sleep(Duration::from_millis(sleep_ms)).await;
    *delay_ms = next_long_lived_register_retry_delay_ms(*delay_ms);
}

fn next_long_lived_register_retry_delay_ms(current_ms: u64) -> u64 {
    current_ms
        .saturating_mul(2)
        .min(LONG_LIVED_REGISTER_RETRY_MAX_MS)
}

fn current_time_millis() -> Option<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

async fn cmd_daemon_connected(
    hub_url: &str,
    token_override: Option<&str>,
    mut supervisor_control: Option<&mut SupervisorControlSession>,
    activation: Option<MachineDaemonActivationConnect>,
    profile_manager: &ProfileManager,
    update_authority: bool,
    shutdown: &mut tokio::sync::watch::Receiver<bool>,
) -> error::Result<ProfileRuntimeExit> {
    let token_override = token_override.map(str::to_string);
    let daemon_session = resolve_daemon_session_state(hub_url, token_override.as_deref()).await?;
    let token =
        current_daemon_access_token(token_override.as_deref(), daemon_session.as_ref()).await?;
    let relay_url = machine_daemon_connection::derive_connection_url(hub_url);
    // A Machine id is per owner: the daemon's session names the owner.
    let owner_user_id = match daemon_session.as_ref() {
        Some(state) => state.read().await.session.user.id.clone(),
        None => config::load_session_for_hub(hub_url)
            .await
            .map(|session| session.user.id)
            .ok_or_else(|| {
                CliError::Auth(
                    "The daemon needs a login to identify its Machine. Run: xmatrix login".into(),
                )
            })?,
    };
    let machine_identity = config::machine_identity_for_owner(&owner_user_id).await?;
    let machine_id = machine_identity.machine_id.clone();
    let host_id = observed_hostname();
    let daemon_name = build_daemon_name(&host_id);
    let mut metadata = serde_json::json!({
        "kind": "daemon",
        "xmatrixDaemonVersion": xmatrix_cli_core::version::current(),
        "xmatrixCliVersion": xmatrix_cli_core::version::current(),
        "machineId": machine_id,
        "hostname": observed_hostname(),
        "capabilities": [
            "agent:spawn_in_workspace",
            "pty:headless",
            "machine_command_admission_ack_v1",
            "machine_run_snapshot_causal_v1",
            "machine_routing_model_v1",
            "machine_routing_effort_v1",
            "machine_routing_parameters_v1",
            "registration_launch_v1",
            "registration_launch_v2",
            // v3: registered launches use the Hub's registration and preset;
            // the machine keeps no installation registry.
            "registration_launch_v3",
            "registration_model_default_v1",
            "registration_optional_model_v1",
            // A registered launch may run in a private managed directory.
            "registration_managed_v1",
            "reply_recovery_v1",
            "machine_quota_probe_v2",
            "machine_harness_inventory_v1",
            "machine_harness_action_v1",
            "machine_harness_cursor_launcher_v1",
            // The daemon parses and runs the `uninstall` harness action.
            "machine_harness_uninstall_v1",
            // The daemon parses and acts on the `release` harness action.
            "machine_harness_release_v1",
            // A stop may push the Run's whole checkout to a handoff branch.
            "machine_handoff_export_v1",
        ],
    });
    if let Some(platform) = runtime_daemon_harness_action::daemon_platform() {
        metadata["platform"] = serde_json::json!(platform);
    }
    metadata["machineFingerprint"] = serde_json::json!(machine_identity.fingerprint.value);
    metadata["machineFingerprintSource"] = serde_json::json!(machine_identity.fingerprint.source);
    if let Some(parent) = machine_identity.parent_machine_id {
        metadata["parentMachineId"] = serde_json::json!(parent);
    }
    if let Ok(app_version) = std::env::var("XMATRIX_APP_VERSION")
        && !app_version.trim().is_empty() {
            metadata["xmatrixAppVersion"] = serde_json::json!(app_version);
        }

    let mut relay = MachineDaemonConnectionClient::new(
        relay_url,
        token.clone(),
        daemon_name,
        machine_id.clone(),
        host_id.clone(),
        Some(metadata),
        vec![
            "agent:spawn_in_workspace".to_string(),
            "pty:headless".to_string(),
            "machine_command_admission_ack_v1".to_string(),
            "machine_run_snapshot_causal_v1".to_string(),
            "machine_routing_model_v1".to_string(),
            "machine_routing_effort_v1".to_string(),
            "machine_routing_parameters_v1".to_string(),
            "registration_launch_v1".to_string(),
            "registration_launch_v2".to_string(),
            "registration_launch_v3".to_string(),
            "registration_model_default_v1".to_string(),
            "registration_optional_model_v1".to_string(),
            "registration_managed_v1".to_string(),
            "reply_recovery_v1".to_string(),
            "machine_quota_probe_v2".to_string(),
            "machine_harness_inventory_v1".to_string(),
            "machine_harness_action_v1".to_string(),
            "machine_harness_cursor_launcher_v1".to_string(),
            "machine_harness_uninstall_v1".to_string(),
            "machine_harness_release_v1".to_string(),
            "machine_handoff_export_v1".to_string(),
        ],
    );
    if let Some(activation) = activation.clone() {
        relay.set_activation(activation);
    }
    let daemon = register_long_lived_machine_daemon(&mut relay).await?;
    println!(
        "{} xMatrix daemon online as {} ({})",
        "✓".green().bold(),
        daemon.name,
        daemon.id.dimmed()
    );
    println!("  host: {}", host_id);
    if let Some(profile) = config::active_profile_context() {
        profile_manager.set_runtime_state(
            &profile.id,
            ProfileRuntimeLifecycleState::Ready,
            None,
        )?;
    }
    let _sleep_guard = MacosSleepGuard::acquire("xMatrix daemon");

    let mut event_rx = relay.event_rx.take().unwrap();
    let relay = Arc::new(relay);
    let effect_journal: DaemonEffectJournal = Arc::new(std::sync::Mutex::new(
        xmatrix_windows_continuity::CommandEffectJournal::new(
            config::profile_state_dir().join("daemon-command-effects-v1.json"),
        ),
    ));
    match replay_pending_command_effect_completions(&effect_journal, &relay) {
        Ok(count) if count > 0 => println!(
            "{} replayed {count} committed daemon command completion(s)",
            "✓".green().bold()
        ),
        Ok(_) => {}
        Err(error) => eprintln!(
            "{} failed to replay committed daemon command completions: {error}",
            "⚠".yellow().bold()
        ),
    }
    let run_registry: DaemonRunRegistry = Arc::new(AsyncMutex::new(HashMap::new()));
    let auth_broker =
        spawn_daemon_auth_broker(hub_url.to_string(), daemon_session.clone(), relay.clone())
            .await?;
    let request_broker = spawn_daemon_request_broker(
        hub_url.to_string(),
        Some(machine_id.clone()),
        auth_broker.as_ref().map(|broker| broker.url.clone()),
        run_registry.clone(),
    )
    .await?;
    let spawn_inflight: DaemonSpawnInflight = Arc::new(AsyncMutex::new(HashSet::new()));
    // Spawn commands between receipt and a started (or refused) process. A
    // self-update handoff waits for these, so a summon is not dropped halfway.
    let spawn_commands_in_flight = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    rehydrate_daemon_run_registry(&run_registry, auth_broker.as_ref(), request_broker.as_ref())
        .await;
    #[cfg_attr(
        not(windows),
        expect(
            clippy::needless_option_as_deref,
            reason = "the Windows self-update handoff uses supervisor_control after activation"
        )
    )]
    let activation_control = supervisor_control.as_deref_mut();
    complete_daemon_activation(
        &relay,
        &run_registry,
        request_broker.as_ref(),
        activation_control,
        activation.as_ref(),
    )
    .await?;
    let _daemon_auth_refresh_handle =
        spawn_daemon_auth_refresh_task(relay.clone(), daemon_session.clone());
    let _run_handoff_handle = spawn_daemon_run_handoff_task(run_registry.clone());
    let (_disabled_update_guard, mut self_update_rx) = if update_authority {
        (
            None,
            spawn_daemon_self_update_task(
                hub_url.to_string(),
                token_override.clone(),
                run_registry.clone(),
                relay.clone(),
                profile_manager.clone(),
            ),
        )
    } else {
        let (sender, receiver) = mpsc::unbounded_channel();
        (Some(sender), receiver)
    };
    remove_idle_management_workspaces(&run_registry).await;
    let _execution_reporter =
        runtime_execution_outbox::spawn_reporter(hub_url.to_string(), relay.clone());
    let _child_monitor_handle = spawn_daemon_child_monitor(
        run_registry.clone(),
        relay.clone(),
        auth_broker.clone(),
        request_broker.clone(),
    );
    let spawn_runtime = DaemonSpawnRuntime {
        hub_url: hub_url.to_string(),
        token_override: token_override.clone(),
        daemon_session: daemon_session.clone(),
        auth_broker: auth_broker.clone(),
        request_broker: request_broker.clone(),
        machine_id: machine_id.clone(),
        host_id: host_id.clone(),
        run_registry: run_registry.clone(),
        spawn_inflight: spawn_inflight.clone(),
        relay: relay.clone(),
        effect_journal: effect_journal.clone(),
    };
    let _spawn_intent_poll_handle = spawn_daemon_spawn_intent_poll_task(spawn_runtime.clone());
    if let Err(err) = persist_daemon_ready_state(profile_manager) {
        eprintln!(
            "{} failed to publish daemon ready state: {err}",
            "⚠".yellow().bold()
        );
    }
    let run_report_maintenance_active = Arc::new(AtomicBool::new(false));
    let _inventory_report = runtime_daemon_harness_inventory::spawn_inventory_report(relay.clone());
    // Historical run recovery is best-effort maintenance. A large run-log
    // backlog must not delay the ready receipt used by daemon update handoff
    // or prevent the daemon from entering its command event loop.
    spawn_daemon_run_report_maintenance(
        run_registry.clone(),
        relay.clone(),
        auth_broker.clone(),
        request_broker.clone(),
        run_report_maintenance_active.clone(),
    );
    let exit = loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    relay.disconnect();
                    break ProfileRuntimeExit::LocalShutdown;
                }
            }
            event = event_rx.recv() => {
                let Some(event) = event else {
                    return Err(CliError::Launch(
                        "Daemon ProfileRuntime event channel closed unexpectedly".into(),
                    ));
                };
                let command_effect = if let MachineDaemonConnectionEvent::Command(command) = &event {
                    match prepare_command_effect(&effect_journal, command) {
                        Ok(CommandEffectDispatch::Execute(stable_id)) => {
                            // Admission is a Hub round trip that must finish
                            // inside the pushed command's lease. Every command
                            // arm below awaits it on its own task, so this
                            // socket loop never queues a batch (a `/kill all`
                            // is one stop per Instance) behind one slow
                            // acknowledgement until the later leases expire.
                            Some((stable_id, None::<String>))
                        },
                        Ok(CommandEffectDispatch::Replay {
                            stable_id,
                            expected_result_digest,
                            report,
                            persist_rebind,
                        }) => {
                            let result = (|| {
                                let report = relay.bind_registry_causality(report)?;
                                if persist_rebind {
                                    persist_rebound_command_effect_result(
                                        &effect_journal,
                                        &stable_id,
                                        &expected_result_digest,
                                        &report,
                                    )?;
                                }
                                relay.send_report(report)
                            })();
                            if let Err(error) = result {
                                eprintln!("{} failed to replay committed daemon command result: {error}", "⚠".yellow().bold());
                            }
                            continue;
                        }
                        Err(error) => {
                            eprintln!("{} daemon command effect rejected: {error}", "⚠".yellow().bold());
                            continue;
                        }
                    }
                } else {
                    None
                };
                match event {
                    MachineDaemonConnectionEvent::Command(command @ MachineDaemonCommand::MachineSpawnAgent { .. }) => {
                        let runtime = spawn_runtime.clone();
                        let (effect_id, _) =
                            command_effect.expect("command has admitted effect");
                        let in_flight = SpawnCommandInFlight::enter(&spawn_commands_in_flight);
                        config::spawn_profile_task(async move {
                            let _in_flight = in_flight;
                            let DaemonSpawnRuntime { hub_url, relay, effect_journal, .. } = &runtime;
                            let admission = if daemon_spawn_has_combined_admission_authority(&command) {
                                match relay.machine_credential() {
                                    Ok(credential) => admit_and_authorize_daemon_spawn_http(
                                        hub_url,
                                        &credential,
                                        &command,
                                    )
                                    .await,
                                    Err(error) => Err(error),
                                }
                            } else {
                                admit_pushed_daemon_command(hub_url, relay, &command)
                                    .await
                                    .map(|_| DaemonSpawnAdmission::Authorized(String::new()))
                            };
                            let Some(intent) = DaemonSpawnRequest::from_command(command) else {
                                return;
                            };
                            let initial_agent_token = match admission {
                                Ok(DaemonSpawnAdmission::Authorized(token)) => {
                                    (!token.is_empty()).then_some(token)
                                }
                                Ok(DaemonSpawnAdmission::Rejected(error)) => {
                                    let report = daemon_spawn_result_message(
                                        false, None, None, Some(error), None, &intent,
                                    );
                                    if let Err(report_error) = send_command_effect_result(
                                        effect_journal, &effect_id, relay, report,
                                    ) {
                                        eprintln!(
                                            "{} failed to report terminal daemon admission: {report_error}",
                                            "⚠".yellow().bold()
                                        );
                                    }
                                    return;
                                }
                                Err(error) => {
                                    eprintln!(
                                        "{} failed to admit daemon spawn command: {error}",
                                        "⚠".yellow().bold()
                                    );
                                    return;
                                }
                            };
                            let claim_key = match runtime.claim(&intent).await
                            {
                                DaemonSpawnClaim::Existing(existing) => {
                                    let message = existing.into_report(&intent);
                                    let relay = relay.clone();
                                    if let Err(err) = send_command_effect_result(
                                        effect_journal,
                                        &effect_id,
                                        &relay,
                                        message,
                                    ) {
                                        eprintln!(
                                            "{} failed to ack duplicate daemon spawn result; keeping daemon online: {err}",
                                            "⚠".yellow().bold()
                                        );
                                    }
                                    return;
                                }
                                DaemonSpawnClaim::Conflict => {
                                    let message = conflicting_daemon_spawn_result(&intent);
                                    let relay = relay.clone();
                                    if let Err(err) = send_command_effect_result(
                                        effect_journal,
                                        &effect_id,
                                        &relay,
                                        message,
                                    ) {
                                        eprintln!(
                                            "{} failed to report conflicting daemon spawn result; keeping daemon online: {err}",
                                            "⚠".yellow().bold()
                                        );
                                    }
                                    return;
                                }
                                DaemonSpawnClaim::Inflight => return,
                                DaemonSpawnClaim::Claimed(claim_key) => claim_key,
                            };
                            let log = DaemonSpawnLog {
                                runtime: &intent.runtime,
                                workspace_name: &intent.workspace.display_name,
                                agent_name: &intent.agent_name,
                            };
                            let message = runtime.execute_claimed(
                                &intent, initial_agent_token, DaemonSpawnDelivery::Socket, claim_key, Some(log),
                            ).await;
                            let relay = relay.clone();
                            if let Err(err) = send_command_effect_result(
                                effect_journal,
                                &effect_id,
                                &relay,
                                message,
                            ) {
                                eprintln!(
                                    "{} failed to send daemon spawn result; keeping daemon online: {err}",
                                    "⚠".yellow().bold()
                                );
                            }
                        });
                    }
                    MachineDaemonConnectionEvent::Command(command @ MachineDaemonCommand::MachineStopAgent { .. }) => {
                        let hub_url = hub_url.to_string();
                        let relay = relay.clone();
                        let run_registry = run_registry.clone();
                        let effect_journal = effect_journal.clone();
                        let auth_broker = auth_broker.clone();
                        let (effect_id, _) = command_effect.expect("command has admitted effect");
                        config::spawn_profile_task(async move {
                            let Some(request) = DaemonStopRequest::from_command(command.clone()) else {
                                return;
                            };
                            let audited_run = request.run_id.as_deref().unwrap_or("unknown").to_string();
                            let export_source = request.export_source(&run_registry).await;
                            let stop = || request.stop(&run_registry);
                            // A stop asks a local process to die and is
                            // idempotent: a redelivered stop answers
                            // `already_absent`. The kill therefore never waits
                            // for admission; the two run together. Abandon
                            // also returns the repo pool slot to Authority,
                            // which needs a live lease, so it admits first.
                            let abandon = daemon_worktree_disposition(request.worktree_disposition.as_ref())
                                == MachineWorktreeDisposition::Abandon;
                            let (admission, result) = if abandon {
                                let admission =
                                    admit_deferred_daemon_command(&hub_url, &relay, &command).await;
                                if admission.is_err() {
                                    (admission, None)
                                } else {
                                    (admission, Some(stop().await))
                                }
                            } else {
                                let (admission, result) = tokio::join!(
                                    admit_deferred_daemon_command(&hub_url, &relay, &command),
                                    stop()
                                );
                                (admission, Some(result))
                            };
                            if let Err(error) = admission {
                                // The registry audit is where a stop that never
                                // reached Authority must be visible; stderr
                                // alone hid this for hours. Hub re-leases the
                                // command and its redelivery reports the result.
                                append_daemon_registry_audit(&format!(
                                    "stop_admission_failed run={audited_run} pid={:?} error={error} outcome={}",
                                    request.pid,
                                    match &result {
                                        None => "not_attempted".to_string(),
                                        Some(Ok((_, cleanup_reason))) => cleanup_reason.to_string(),
                                        Some(Err(error)) => format!("error:{error}"),
                                    }
                                ));
                                return;
                            }
                            let Some(result) = result else {
                                return;
                            };
                            let handoff_export = handoff_export_for_stop(
                                request.handoff_export.as_ref(),
                                &result,
                                export_source,
                                auth_broker.as_ref(),
                            )
                            .await;
                            let report = request.into_report(result, handoff_export);
                            if let Err(err) = send_command_effect_result(
                                &effect_journal,
                                &effect_id,
                                &relay,
                                report,
                            ) {
                                eprintln!(
                                    "{} failed to send daemon stop result; keeping daemon online: {err}",
                                    "⚠".yellow().bold()
                                );
                            }
                        });
                    }
                    MachineDaemonConnectionEvent::Command(command @ MachineDaemonCommand::MachineRecoverReply { .. }) => {
                        let Some((effect_id, _)) = command_effect else { continue; };
                        let hub_url = hub_url.to_string();
                        let broker = request_broker.clone(); let relay = relay.clone(); let journal = effect_journal.clone();
                        config::spawn_profile_task(async move {
                            if admit_deferred_daemon_command(&hub_url, &relay, &command).await.is_err() {
                                return;
                            }
                            if let Ok(report) = runtime_reply_recovery::execute(broker.as_ref(), command).await
                                && let Err(error) = send_command_effect_result(&journal, &effect_id, &relay, report) {
                                    eprintln!("Reply recovery result remains pending: {error}");
                                }
                        });
                    }
                    MachineDaemonConnectionEvent::Command(command @ MachineDaemonCommand::MachineRequestResolve { .. }) => {
                        let Some(broker) = request_broker.clone() else {
                            continue;
                        };
                        let (effect_id, _) = command_effect.expect("command has admitted effect");
                        spawn_admitted_daemon_command(hub_url, &relay, &effect_journal, effect_id, command, move |context, command| async move {
                            let DeferredDaemonCommandContext { relay, effect_journal, effect_id, .. } = context;
                            let MachineDaemonCommand::MachineRequestResolve {
                                request_id,
                                daemon_request_id,
                                decision,
                                remember,
                                secret_grant_id,
                                resolved_by,
                                resolved_by_label,
                                relay_lease,
                            } = command
                            else {
                                return;
                            };
                            // Host-command approvals are gone: an older Hub's card
                            // learns that nothing will run.
                            let _ = (decision, remember, secret_grant_id, resolved_by, resolved_by_label);
                            let daemon_request_id_for_result = daemon_request_id;
                            let (ok, status, error): (bool, Option<String>, Option<String>) = (
                                false,
                                None,
                                Some("This xMatrix daemon no longer runs approved host commands".to_string()),
                            );
                            let relay = relay.clone();
                            let report = MachineDaemonReport::MachineRequestResolveResult {
                                request_id,
                                daemon_request_id: daemon_request_id_for_result,
                                machine_id: broker.machine_id.clone(),
                                host_id: None,
                                ok,
                                status,
                                error,
                                relay_lease,
                            };
                            if let Err(err) = send_command_effect_result(
                                &effect_journal,
                                &effect_id,
                                &relay,
                                report,
                            ) {
                                eprintln!(
                                    "{} failed to send daemon request resolve result: {err}",
                                    "⚠".yellow().bold()
                                );
                            }
                        });
                    }
                    MachineDaemonConnectionEvent::Command(command @ MachineDaemonCommand::MachineWorktreeCleanup { .. }) => {
                        let (effect_id, _) = command_effect.expect("command has admitted effect");
                        spawn_admitted_daemon_command(hub_url, &relay, &effect_journal, effect_id, command, move |context, command| async move {
                            let DeferredDaemonCommandContext { relay, effect_journal, effect_id, .. } = context;
                            let MachineDaemonCommand::MachineWorktreeCleanup {
                                request_id,
                                workspace,
                                channel_id,
                                scope_channel_id,
                                worktree_path,
                                branch: _,
                                base_ref: _,
                                reason: _,
                                relay_lease,
                            } = command
                            else {
                                return;
                            };
                            let result = match (
                                std::fs::canonicalize(&worktree_path),
                                std::fs::canonicalize(run_worktree::run_worktrees_root()),
                            ) {
                                (Ok(path), Ok(managed_root)) if path.starts_with(&managed_root) => {
                                    run_worktree::reclaim_run_worktree(&path, true).await
                                }
                                _ => Err("cleanup target is outside the managed Run worktree root".into()),
                            };
                            let (ok, removed, needs_cleanup, error) = match result {
                                Ok(needs_snapshot) => (true, Some(true), Some(needs_snapshot), None),
                                Err(error) => (false, Some(false), Some(true), Some(error)),
                            };
                            let report = MachineDaemonReport::MachineWorktreeCleanupResult {
                                request_id,
                                workspace,
                                channel_id,
                                scope_channel_id: Some(scope_channel_id),
                                ok,
                                removed,
                                needs_cleanup,
                                error,
                                relay_lease,
                            };
                            if let Err(error) = send_command_effect_result(
                                &effect_journal,
                                &effect_id,
                                &relay,
                                report,
                            ) {
                                eprintln!("{} failed to report worktree cleanup: {error}", "⚠".yellow().bold());
                            }
                        });
                    }
                    MachineDaemonConnectionEvent::Command(command @ MachineDaemonCommand::MachineQuotaProbe { .. }) => {
                        let (effect_id, _) = command_effect.expect("command has admitted effect");
                        spawn_admitted_daemon_command(hub_url, &relay, &effect_journal, effect_id, command, move |context, command| async move {
                            let DeferredDaemonCommandContext { relay, effect_journal, effect_id, .. } = context;
                            let MachineDaemonCommand::MachineQuotaProbe { request_id, probe, relay_lease } = command else {
                                return;
                            };
                            let report = runtime_daemon_quota_probe::execute_machine_quota_probe(
                                request_id,
                                probe,
                                relay_lease,
                            )
                            .await;
                            if let Err(error) = send_command_effect_result(&effect_journal, &effect_id, &relay, report) {
                                eprintln!("{} failed to report quota probe result: {error}", "⚠".yellow().bold());
                            }
                        });
                    }
                    MachineDaemonConnectionEvent::Command(command @ MachineDaemonCommand::MachineHarnessAction { .. }) => {
                        let (effect_id, _) = command_effect.expect("command has admitted effect");
                        spawn_admitted_daemon_command(hub_url, &relay, &effect_journal, effect_id, command, move |context, command| async move {
                            let DeferredDaemonCommandContext { hub_url, relay, effect_journal, effect_id } = context;
                            let Some(report) = execute_leased_harness_action(&hub_url, &relay, command).await else {
                                return;
                            };
                            if let Err(error) = send_command_effect_result(&effect_journal, &effect_id, &relay, report) {
                                eprintln!("{} failed to report harness action result: {error}", "⚠".yellow().bold());
                            }
                        });
                    }
                    MachineDaemonConnectionEvent::Disconnected { reason } => {
                        eprintln!("{} daemon disconnected: {reason}", "⚠".yellow().bold());
                        if let Some(profile) = config::active_profile_context() {
                            profile_manager.set_runtime_state(
                                &profile.id,
                                ProfileRuntimeLifecycleState::Reconnecting,
                                Some(bounded_daemon_host_detail(&reason)),
                            )?;
                            persist_daemon_ready_state(profile_manager)?;
                        }
                    }
                    MachineDaemonConnectionEvent::Reconnected { daemon: agent } => {
                        println!(
                            "{} daemon reconnected as {} ({})",
                            "✓".green().bold(),
                            agent.name,
                            agent.id.dimmed()
                        );
                        if let Some(profile) = config::active_profile_context() {
                            profile_manager.set_runtime_state(
                                &profile.id,
                                ProfileRuntimeLifecycleState::Ready,
                                None,
                            )?;
                            persist_daemon_ready_state(profile_manager)?;
                        }
                        if let Err(error) = replay_pending_command_effect_completions(
                            &effect_journal,
                            &relay,
                        ) {
                            eprintln!(
                                "{} failed to replay committed daemon command completions: {error}",
                                "⚠".yellow().bold()
                            );
                        }
                        // Reconnect must return to the command loop immediately:
                        // one stale terminal report can wait 30 seconds for Hub,
                        // longer than the short admission lease on a new command.
                        // Keep recovery best-effort and single-flight so repeated
                        // reconnects cannot multiply the backlog.
                        spawn_daemon_run_report_maintenance(
                            run_registry.clone(),
                            relay.clone(),
                            auth_broker.clone(),
                            request_broker.clone(),
                            run_report_maintenance_active.clone(),
                        );
                    }
                    MachineDaemonConnectionEvent::ShutdownRequested { reason } => {
                        let detail = reason
                            .clone()
                            .unwrap_or_else(|| "stopped from xMatrix".to_string());
                        eprintln!(
                            "{} daemon shutdown requested: {}",
                            "○".cyan().bold(),
                            detail
                        );
                        relay.disconnect();
                        break ProfileRuntimeExit::HubShutdown(reason);
                    }
                    MachineDaemonConnectionEvent::Error { message, correlation } => {
                        match correlation {
                            Some(correlation) => eprintln!(
                                "{} daemon control message rejected: {message} ({correlation})",
                                "⚠".yellow().bold()
                            ),
                            None => eprintln!("{} daemon control message rejected: {message}", "⚠".yellow().bold()),
                        }
                    }
                    MachineDaemonConnectionEvent::RequestNoticeDelivery { .. } => {}
                    MachineDaemonConnectionEvent::CommandCompletionAcked { control_id } => {
                        if let Err(error) = effect_journal
                            .lock()
                            .map_err(|_| CliError::Launch("Daemon command effect journal is poisoned".into()))
                            .and_then(|journal| journal.acknowledge(&control_id).map_err(|error| {
                                CliError::Launch(format!("Daemon command completion ack failed: {error}"))
                            }))
                        {
                            eprintln!("{} {error}", "⚠".yellow().bold());
                        }
                    }
                    _ => {}
                }
            }
            update = self_update_rx.recv() => {
                let Some(update) = update else {
                    continue;
                };
                match update {
                    DaemonSelfUpdateOutcome::Restart(installed) => {
                        wait_for_spawn_commands_before_handoff(&spawn_commands_in_flight).await;
                        eprintln!(
                            "{} daemon self-update restarted version {}; exiting old daemon",
                            "✓".green().bold(),
                            installed.latest_version
                        );
                        relay.disconnect();
                        break ProfileRuntimeExit::UpdateHandoff;
                    }
                    #[cfg(windows)]
                    DaemonSelfUpdateOutcome::WindowsCandidate(candidate) => {
                        wait_for_spawn_commands_before_handoff(&spawn_commands_in_flight).await;
                        let Some(control) = supervisor_control.as_deref_mut() else {
                            eprintln!("{} staged Windows candidate has no Supervisor control pipe", "⚠".yellow().bold());
                            continue;
                        };
                        if let Err(error) = handoff_windows_daemon_candidate(
                            &relay,
                            &run_registry,
                            request_broker.as_ref(),
                            &effect_journal,
                            control,
                            candidate,
                        ).await {
                            eprintln!("{} Windows daemon handoff deferred: {error}", "⚠".yellow().bold());
                            continue;
                        }
                        relay.disconnect();
                        break ProfileRuntimeExit::UpdateHandoff;
                    }
                }
            }
        }
    };

    Ok(exit)
}

fn daemon_access_token_from_saved_session(session: &CliSession) -> String {
    session.token.clone()
}

async fn resolve_daemon_session_state(
    hub_url: &str,
    token_override: Option<&str>,
) -> error::Result<Option<DaemonSessionState>> {
    if let Some(token) = token_override {
        return match auth::exchange_instance_session(hub_url, token).await {
            Ok(response) => {
                let now = config::unix_now_secs();
                Ok(Some(Arc::new(RwLock::new(DaemonSessionValue {
                    session: CliSession {
                        token: response.token,
                        refresh_token: response.refresh_token,
                        user: response.user,
                        hub_url: response.hub_url,
                        relay_url: response.relay_url,
                        updated_at: now.to_string(),
                        expires_at: now.saturating_add(config::SESSION_MAX_AGE_SECS).to_string(),
                    },
                    source: None,
                    generation: 0,
                    saved_session_reload_gate: Arc::new(AsyncMutex::new(())),
                }))))
            }
            Err(err) => {
                eprintln!(
                    "{} daemon explicit-token session exchange failed; using non-refreshable token: {err}",
                    "⚠".yellow().bold()
                );
                Ok(None)
            }
        };
    }

    let session = resolve_cli_session_for_hub(None, hub_url)
        .await
        .and_then(|session| {
            session.ok_or_else(|| CliError::Auth("Not logged in. Run: xmatrix login".into()))
        })?;
    let source = DaemonSessionSource::from_saved_session(&session);
    let response = auth::exchange_instance_session(&session.hub_url, &session.token).await?;
    let daemon_session = CliSession {
        token: response.token,
        refresh_token: response.refresh_token,
        user: response.user,
        hub_url: response.hub_url,
        relay_url: response.relay_url,
        updated_at: config::unix_now_secs().to_string(),
        expires_at: session.expires_at,
    };
    Ok(Some(Arc::new(RwLock::new(DaemonSessionValue {
        session: daemon_session,
        source: Some(source),
        generation: 0,
        saved_session_reload_gate: Arc::new(AsyncMutex::new(())),
    }))))
}

async fn current_daemon_access_token(
    token_override: Option<&str>,
    session_state: Option<&DaemonSessionState>,
) -> error::Result<String> {
    if let Some(session_state) = session_state {
        let state = session_state.read().await;
        return Ok(daemon_access_token_from_saved_session(&state.session));
    }

    if let Some(token) = token_override {
        return Ok(token.to_string());
    }

    Err(CliError::Auth("Not logged in. Run: xmatrix login".into()))
}

enum DaemonSessionReloadResult {
    Reloaded,
    AlreadyCurrent,
}

impl DaemonSessionReloadResult {
    fn reloaded(&self) -> bool {
        matches!(self, Self::Reloaded)
    }
}

fn saved_daemon_session_source_is_newer(
    current: Option<&DaemonSessionSource>,
    candidate: &DaemonSessionSource,
) -> bool {
    let Some(current) = current else {
        return true;
    };
    if current.hub_url != candidate.hub_url || current.user_id != candidate.user_id {
        return false;
    }
    if candidate.updated_at < current.updated_at || candidate.expires_at < current.expires_at {
        return false;
    }
    candidate != current
}

fn install_refreshed_daemon_session_if_current(
    state: &mut DaemonSessionValue,
    expected_generation: u64,
    refreshed: CliSession,
) -> bool {
    if state.generation != expected_generation {
        return false;
    }
    state.session = refreshed;
    state.generation = state.generation.saturating_add(1);
    true
}

async fn reload_daemon_session_from_saved_session(
    hub_url: &str,
    session_state: &DaemonSessionState,
    relay: &SharedMachineDaemonConnection,
) -> error::Result<DaemonSessionReloadResult> {
    // A single saved credential must mint at most one daemon session. Without
    // this gate, concurrent Desktop/CLI sync requests can both exchange before
    // either source fingerprint is installed, leaking an unused server session.
    let reload_gate = session_state.read().await.saved_session_reload_gate.clone();
    let _reload_guard = reload_gate.lock().await;

    let saved = config::load_session_for_hub(hub_url)
        .await
        .ok_or_else(|| CliError::Auth("Not logged in. Run: xmatrix login".into()))?;
    ensure_session_not_expired(&saved)?;

    let candidate_source = DaemonSessionSource::from_saved_session(&saved);
    let current = session_state.read().await.clone();
    let expected_hub = normalize_hub_url(Some(hub_url));
    if candidate_source.hub_url != expected_hub
        || normalize_hub_url(Some(&current.session.hub_url)) != expected_hub
    {
        return Err(CliError::Auth(
            "Saved login belongs to a different xMatrix Hub than the running daemon".into(),
        ));
    }
    if saved.user.id != current.session.user.id {
        return Err(CliError::Auth(
            "Saved login belongs to a different user than the running daemon; restart the daemon to change owners"
                .into(),
        ));
    }
    if !saved_daemon_session_source_is_newer(current.source.as_ref(), &candidate_source) {
        if let Err(err) = synchronize_daemon_relay_auth(relay, session_state).await {
            eprintln!(
                "{} daemon session is current but relay auth resync failed; reconnect will retry the current token: {err}",
                "⚠".yellow().bold()
            );
        }
        return Ok(DaemonSessionReloadResult::AlreadyCurrent);
    }

    // Exchange the saved CLI credential instead of sharing its refresh token
    // with the daemon. This keeps refresh rotation and logout boundaries
    // independent across the CLI/Desktop and the long-running daemon.
    let response = auth::exchange_instance_session(&saved.hub_url, &saved.token).await?;
    if normalize_hub_url(Some(&response.hub_url)) != expected_hub {
        return Err(CliError::Auth(
            "Daemon session exchange returned a different xMatrix Hub".into(),
        ));
    }
    if response.user.id != current.session.user.id {
        return Err(CliError::Auth(
            "Daemon session exchange returned a different user".into(),
        ));
    }
    let daemon_session = CliSession {
        token: response.token,
        refresh_token: response.refresh_token,
        user: response.user,
        hub_url: response.hub_url,
        relay_url: response.relay_url,
        updated_at: config::unix_now_secs().to_string(),
        expires_at: saved.expires_at,
    };

    let result = {
        let mut guard = session_state.write().await;
        if guard.session.user.id != daemon_session.user.id
            || !saved_daemon_session_source_is_newer(guard.source.as_ref(), &candidate_source)
        {
            DaemonSessionReloadResult::AlreadyCurrent
        } else {
            let generation = guard.generation.saturating_add(1);
            let saved_session_reload_gate = guard.saved_session_reload_gate.clone();
            *guard = DaemonSessionValue {
                session: daemon_session,
                source: Some(candidate_source),
                generation,
                saved_session_reload_gate,
            };
            DaemonSessionReloadResult::Reloaded
        }
    };

    if let Err(err) = synchronize_daemon_relay_auth(relay, session_state).await {
        eprintln!(
            "{} daemon session synchronized but relay auth delivery failed; reconnect will use the current session: {err}",
            "⚠".yellow().bold()
        );
    }
    Ok(result)
}

fn spawn_daemon_auth_refresh_task(
    relay: SharedMachineDaemonConnection,
    session_state: Option<DaemonSessionState>,
) -> tokio::task::JoinHandle<()> {
    config::spawn_profile_task(async move {
        let Some(session_state) = session_state else {
            return;
        };

        loop {
            let snapshot = session_state.read().await.clone();
            let session = snapshot.session.clone();
            let expires_at = session.expires_at.parse::<u64>().unwrap_or(0);
            let now = config::unix_now_secs();
            if expires_at <= now {
                match reload_daemon_session_from_saved_session(
                    &session.hub_url,
                    &session_state,
                    &relay,
                )
                .await
                {
                    Ok(DaemonSessionReloadResult::Reloaded) => continue,
                    Ok(DaemonSessionReloadResult::AlreadyCurrent) => {}
                    Err(err) => eprintln!(
                        "{} daemon saved-session recovery failed: {err}",
                        "⚠".yellow().bold()
                    ),
                }
                eprintln!(
                    "{} daemon session reached 7-day limit; remote launches will request browser login in the channel",
                    "⚠".yellow().bold()
                );
                tokio::time::sleep(Duration::from_secs(60)).await;
                continue;
            }

            let sleep_secs = connected_token_refresh_sleep_secs(&session, now);
            tokio::time::sleep(Duration::from_secs(sleep_secs)).await;

            let snapshot = session_state.read().await.clone();
            let session = snapshot.session.clone();
            if ensure_session_not_expired(&session).is_err() {
                continue;
            }

            if session.refresh_token.is_none() {
                continue;
            }

            let refreshed = match auth::refresh_session_in_memory(&session).await {
                Ok(saved) => saved,
                Err(err) => {
                    eprintln!("{} daemon token refresh failed: {err}", "⚠".yellow().bold());
                    if let Err(reload_err) = reload_daemon_session_from_saved_session(
                        &session.hub_url,
                        &session_state,
                        &relay,
                    )
                    .await
                    {
                        eprintln!(
                            "{} daemon saved-session recovery failed: {reload_err}",
                            "⚠".yellow().bold()
                        );
                    }
                    tokio::time::sleep(Duration::from_secs(SESSION_REFRESH_RETRY_DELAY_SECS)).await;
                    continue;
                }
            };

            let installed = {
                let mut guard = session_state.write().await;
                install_refreshed_daemon_session_if_current(
                    &mut guard,
                    snapshot.generation,
                    refreshed.clone(),
                )
            };

            if !installed {
                continue;
            }

            if let Err(err) = synchronize_daemon_relay_auth(&relay, &session_state).await {
                eprintln!(
                    "{} daemon token refresh delivery failed: {err}",
                    "⚠".yellow().bold()
                );
            }
        }
    })
}

async fn synchronize_daemon_relay_auth(
    relay: &SharedMachineDaemonConnection,
    session_state: &DaemonSessionState,
) -> error::Result<()> {
    loop {
        let snapshot = session_state.read().await.clone();
        let delivery = {
            let relay = relay.clone();
            relay.refresh_auth(snapshot.session.token.clone()).await
        };
        let current = session_state.read().await;
        let delivery_is_current = current.generation == snapshot.generation
            && current.session.token == snapshot.session.token;
        drop(current);
        match delivery {
            Ok(()) if delivery_is_current => return Ok(()),
            Ok(()) => continue,
            Err(_) if !delivery_is_current => continue,
            Err(err) => return Err(err),
        }
    }
}

/// Keep a local listener serving after an accept error.
///
/// Accept fails for reasons that pass: a peer that reset before it was
/// accepted, or the process briefly out of file descriptors. The broker loops
/// used to end on the first such error, which left the daemon running with no
/// broker behind its advertised address: every Agent on the machine was then
/// refused `xmatrix` commands and Git credentials until someone restarted it.
pub(crate) async fn survive_accept_error(listener: &str, error: std::io::Error) {
    eprintln!("⚠ {listener} accept failed, still listening: {error}");
    tokio::time::sleep(Duration::from_millis(100)).await;
}

async fn spawn_daemon_auth_broker(
    hub_url: String,
    session_state: Option<DaemonSessionState>,
    relay: SharedMachineDaemonConnection,
) -> error::Result<Option<DaemonAuthBroker>> {
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|err| CliError::Launch(format!("Failed to bind daemon auth broker: {err}")))?;
    std_listener.set_nonblocking(true).map_err(|err| {
        CliError::Launch(format!("Failed to configure daemon auth broker: {err}"))
    })?;
    let addr = std_listener.local_addr().map_err(|err| {
        CliError::Launch(format!("Failed to read daemon auth broker addr: {err}"))
    })?;
    let listener = tokio::net::TcpListener::from_std(std_listener)
        .map_err(|err| CliError::Launch(format!("Failed to start daemon auth broker: {err}")))?;
    let capabilities = Arc::new(Mutex::new(HashMap::new()));
    let git_credentials: DaemonGitCredentialGrants = Arc::new(Mutex::new(HashMap::new()));
    let broker = DaemonAuthBroker {
        url: format!("http://{addr}"),
        session_reload_capability: uuid::Uuid::new_v4().to_string(),
        capabilities: capabilities.clone(),
        git_credentials: git_credentials.clone(),
    };
    persist_daemon_auth_broker_state(&broker.url, &broker.session_reload_capability);
    let session_reload_capability = broker.session_reload_capability.clone();

    // Serve the same broker over a Unix socket as well. The socket keeps its
    // name across restarts where the port does not, and the filesystem plus the
    // peer's uid guard it rather than reachability by any local user. TCP stays
    // until the socket is proven: losing the daemon costs every live Run.
    #[cfg(unix)]
    {
        match crate::runtime_daemon_socket::bind_daemon_socket("auth-broker").await {
            Ok(bound) => {
                let path = bound.path.clone();
                if let Err(error) = xmatrix_cli_core::daemon_record::update_record(|record| {
                    record.auth_broker_socket = Some(path.display().to_string());
                }) {
                    eprintln!("⚠ daemon record could not record the auth socket: {error}");
                }
                let session_state = session_state.clone();
                let hub_url = hub_url.clone();
                let capabilities = capabilities.clone();
                let git_credentials = git_credentials.clone();
                let reload = session_reload_capability.clone();
                let relay = relay.clone();
                config::spawn_profile_task(async move {
                    let _bound = bound;
                    loop {
                        let stream = match _bound.listener.accept().await {
                            Ok((stream, _)) => stream,
                            Err(error) => {
                                survive_accept_error("auth broker socket", error).await;
                                continue;
                            }
                        };
                        if !crate::runtime_daemon_socket::peer_is_owner(&stream) {
                            continue;
                        }
                        let session_state = session_state.clone();
                        let hub_url = hub_url.clone();
                        let capabilities = capabilities.clone();
                        let git_credentials = git_credentials.clone();
                        let reload = reload.clone();
                        let relay = relay.clone();
                        config::spawn_profile_task(async move {
                            handle_daemon_auth_broker_request(
                                stream,
                                session_state,
                                hub_url,
                                capabilities,
                                git_credentials,
                                reload,
                                relay,
                            )
                            .await;
                        });
                    }
                });
            }
            // A daemon that cannot open its socket must still serve over TCP,
            // and must stop advertising a socket it does not answer on: a
            // wrapper prefers the recorded socket, and a stale path sent every
            // new Run to whoever still held it.
            Err(error) => {
                eprintln!("⚠ daemon auth socket unavailable, TCP only: {error}");
                if let Err(error) = xmatrix_cli_core::daemon_record::update_record(|record| {
                    record.auth_broker_socket = None;
                }) {
                    eprintln!("⚠ daemon record could not drop the auth socket: {error}");
                }
            }
        }
    }

    config::spawn_profile_task(async move {
        loop {
            let stream = match listener.accept().await {
                Ok((stream, _)) => stream,
                Err(error) => {
                    survive_accept_error("auth broker", error).await;
                    continue;
                }
            };
            let session_state = session_state.clone();
            let hub_url = hub_url.clone();
            let capabilities = capabilities.clone();
            let git_credentials = git_credentials.clone();
            let session_reload_capability = session_reload_capability.clone();
            let relay = relay.clone();
            config::spawn_profile_task(async move {
                handle_daemon_auth_broker_request(
                    stream,
                    session_state,
                    hub_url,
                    capabilities,
                    git_credentials,
                    session_reload_capability,
                    relay,
                )
                .await;
            });
        }
    });

    Ok(Some(broker))
}

async fn handle_daemon_auth_broker_request<
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
>(
    mut stream: S,
    session_state: Option<DaemonSessionState>,
    hub_url: String,
    capabilities: Arc<Mutex<HashMap<String, DaemonAgentAuthGrantState>>>,
    git_credentials: DaemonGitCredentialGrants,
    session_reload_capability: String,
    relay: SharedMachineDaemonConnection,
) {
    let mut buffer = vec![0_u8; 4096];
    let Ok(n) = stream.read(&mut buffer).await else {
        return;
    };
    let request = String::from_utf8_lossy(&buffer[..n]);
    let request_line = request.lines().next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default();
    let path = request_parts.next().unwrap_or_default();

    if method == "POST" && path == daemon_auth::ENVIRONMENT_SWITCH_STOP_PATH {
        let authorized = http_header_value(&request, daemon_auth::SESSION_RELOAD_CAPABILITY_HEADER)
            .is_some_and(|value| value == session_reload_capability);
        if !authorized {
            write_daemon_auth_broker_response(
                &mut stream,
                "401 Unauthorized",
                r#"{"error":"unauthorized"}"#,
            )
            .await;
            return;
        }
        write_daemon_auth_broker_response(
            &mut stream,
            "410 Gone",
            r#"{"error":"environment switching no longer stops the shared daemon; use profile control"}"#,
        )
        .await;
        return;
    }

    if method == "POST" && path == daemon_auth::SESSION_RELOAD_PATH {
        let authorized = http_header_value(&request, daemon_auth::SESSION_RELOAD_CAPABILITY_HEADER)
            .is_some_and(|value| value == session_reload_capability);
        if !authorized {
            write_daemon_auth_broker_response(
                &mut stream,
                "401 Unauthorized",
                r#"{"error":"unauthorized"}"#,
            )
            .await;
            return;
        }
        let Some(session_state) = session_state.as_ref() else {
            write_daemon_auth_broker_response(
                &mut stream,
                "409 Conflict",
                r#"{"error":"running daemon has no reloadable session"}"#,
            )
            .await;
            return;
        };
        let result = reload_daemon_session_from_saved_session(&hub_url, session_state, &relay)
            .await
            .map(|result| serde_json::json!({ "reloaded": result.reloaded() }));
        write_daemon_json_result(&mut stream, result, "409 Conflict").await;
        return;
    }

    if method == "POST" && path == git_credential::GIT_CREDENTIAL_PATH {
        handle_git_credential_request(&mut stream, &request, &hub_url, &relay, &git_credentials)
            .await;
        return;
    }

    if method != "GET" || path != "/auth/token" {
        write_daemon_auth_broker_response(&mut stream, "404 Not Found", r#"{"error":"not found"}"#)
            .await;
        return;
    }

    let capability = http_header_value(&request, DAEMON_AUTH_CAPABILITY_ENV)
        .or_else(|| http_header_value(&request, "x-xmatrix-auth-capability"));
    let grant =
        capability.and_then(|capability| take_daemon_agent_auth_grant(&capabilities, capability));
    let Some((context, reusable_token)) = grant else {
        write_daemon_auth_broker_response(
            &mut stream,
            "401 Unauthorized",
            r#"{"error":"unauthorized"}"#,
        )
        .await;
        return;
    };

    if let Some(token) = reusable_token {
        let body = serde_json::json!({ "token": token }).to_string();
        write_daemon_auth_broker_response(&mut stream, "200 OK", &body).await;
        return;
    }

    let result = mint_daemon_agent_run_token(&hub_url, &relay, &context)
        .await
        .inspect(|token| {
            if let Some(capability) = capability {
                hold_daemon_agent_run_token(&capabilities, capability, &context, token);
            }
        })
        .map(|token| serde_json::json!({ "token": token }));
    write_daemon_json_result(&mut stream, result, "401 Unauthorized").await;
}

#[derive(Deserialize)]
struct AgentRunTokenResponse {
    token: String,
}

/// Answer a Git credential helper with a token for one repository.
///
/// The Space is never taken from the request. The capability resolves to a
/// grant the daemon issued from a spawn command, and that grant carries the
/// channel; the Hub turns the channel into a Space. A run therefore cannot ask
/// about a Space it does not belong to even when its machine's owner belongs to
/// several -- which is the whole point of routing Git through here rather than
/// through a login on the host.
async fn handle_git_credential_request<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    stream: &mut S,
    request: &str,
    hub_url: &str,
    relay: &SharedMachineDaemonConnection,
    git_credentials: &DaemonGitCredentialGrants,
) {
    let Some(capability) =
        http_header_value(request, git_credential::GIT_CREDENTIAL_CAPABILITY_HEADER)
    else {
        write_daemon_auth_broker_response(
            stream,
            "401 Unauthorized",
            r#"{"error":"unauthorized"}"#,
        )
        .await;
        return;
    };
    let repository = request
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .and_then(|body| serde_json::from_str::<GitCredentialRequestBody>(body).ok())
        .map(|body| body.repository)
        .unwrap_or_default();
    let repository = repository.trim();
    if repository.is_empty() {
        write_daemon_auth_broker_response(
            stream,
            "400 Bad Request",
            r#"{"error":"repository is required"}"#,
        )
        .await;
        return;
    }

    // Same response for an unknown capability and for a repository this grant
    // does not cover: both mean "not yours", and neither should be a hint.
    let Some(grant) = resolve_git_credential_grant(git_credentials, capability, repository) else {
        write_daemon_auth_broker_response(stream, "403 Forbidden", r#"{"error":"forbidden"}"#)
            .await;
        return;
    };

    match mint_repository_token(hub_url, relay, &grant).await {
        Ok(token) => {
            let body = serde_json::json!({ "token": token }).to_string();
            write_daemon_auth_broker_response(stream, "200 OK", &body).await;
        }
        Err(err) => {
            let body = serde_json::json!({ "error": err.to_string() }).to_string();
            write_daemon_auth_broker_response(stream, "409 Conflict", &body).await;
        }
    }
}

#[derive(serde::Deserialize)]
struct GitCredentialRequestBody {
    #[serde(default)]
    repository: String,
}

#[derive(serde::Deserialize)]
struct RepositoryTokenResponse {
    token: String,
}

async fn mint_repository_token(
    hub_url: &str,
    relay: &SharedMachineDaemonConnection,
    grant: &DaemonGitCredentialGrantState,
) -> error::Result<String> {
    let machine_credential = relay.machine_credential()?;
    let response: RepositoryTokenResponse = http::request_json(
        &with_route(hub_url, HubRoutes::MACHINE_DAEMON_GITHUB_REPOSITORY_TOKEN),
        "POST",
        Some(&machine_credential),
        Some(serde_json::json!({
            "channelId": grant.channel_id,
            "repository": grant.repository,
        })),
    )
    .await?;
    Ok(response.token)
}

async fn mint_daemon_agent_run_token(
    hub_url: &str,
    relay: &SharedMachineDaemonConnection,
    context: &DaemonAgentAuthContext,
) -> error::Result<String> {
    let machine_credential = relay.machine_credential()?;
    mint_agent_run_token_with_machine_credential(hub_url, &machine_credential, context).await
}

async fn mint_agent_run_token_with_machine_credential(
    hub_url: &str,
    machine_credential: &str,
    context: &DaemonAgentAuthContext,
) -> error::Result<String> {
    let response: AgentRunTokenResponse = http::request_json(
        &with_route(hub_url, HubRoutes::MACHINE_DAEMON_AGENT_RUN_TOKEN),
        "POST",
        Some(machine_credential),
        Some(serde_json::to_value(context)?),
    )
    .await?;
    Ok(response.token)
}

fn http_header_value<'a>(request: &'a str, name: &str) -> Option<&'a str> {
    request.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if key.trim().eq_ignore_ascii_case(name) {
            Some(value.trim())
        } else {
            None
        }
    })
}

async fn write_daemon_json_result<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    stream: &mut S,
    result: error::Result<Value>,
    error_status: &str,
) {
    let (status, value) = match result {
        Ok(value) => ("200 OK", value),
        Err(error) => (
            error_status,
            serde_json::json!({ "error": error.to_string() }),
        ),
    };
    write_daemon_auth_broker_response(stream, status, &value.to_string()).await;
}

async fn write_daemon_auth_broker_response<
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
>(
    stream: &mut S,
    status: &str,
    body: &str,
) {
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncache-control: no-store\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;
}
