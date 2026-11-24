#![deny(warnings)]

use std::process::Stdio;

#[cfg(windows)]
use std::collections::{BTreeSet, VecDeque};
#[cfg(windows)]
use std::fs::OpenOptions;
#[cfg(windows)]
use std::io::Write;
#[cfg(windows)]
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::time::{Duration, Instant};

#[cfg(windows)]
use fs2::FileExt;

use xmatrix_cli_args::{
    ForeignWorktreeOrigin, MachineCommand, MachineSupervisorCommand, MachineWorktreesCommand, OnOff,
};
use xmatrix_cli_core::error::{self, CliError};
use xmatrix_cli_core::{config, telemetry_consent};
use xmatrix_cli_core::quota_access;
use xmatrix_repo_pool::machine_worktrees::{self, MachineWorktree, WorktreeOrigin};
#[cfg(windows)]
use xmatrix_windows_continuity::{
    ActivationJournal, ArtifactIdentity, JOURNAL_SCHEMA, JournalPayload, sha256_file,
};

#[cfg(windows)]
const SUPERVISOR_RESTART_WINDOW: Duration = Duration::from_secs(60);
#[cfg(windows)]
const SUPERVISOR_RESTART_LIMIT: usize = 5;

/// Whether this machine's network diagnostics would be sent now, as the daemon decides it.
async fn telemetry_allowed(hub_url: &str) -> bool {
    match config::load_session_for_hub(hub_url).await {
        Some(session) => {
            telemetry_consent::telemetry_allowed_now(&session.hub_url, &session.token).await
        }
        None => false,
    }
}

pub async fn cmd_config(
    hub_url: &str,
    key: Option<String>,
    value: Option<String>,
    setting: Option<String>,
) -> error::Result<()> {
    let normalized_key = key.as_deref().map(str::trim);
    if let Some(k @ ("quotaAccess" | "quota-access")) = normalized_key {
        return cmd_config_quota_access(hub_url, k, value.as_deref(), setting.as_deref()).await;
    }
    if setting.is_some() {
        return Err(CliError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Too many values: only `config quotaAccess <harness> on|off` takes three.",
        )));
    }
    match (normalized_key, value.as_deref()) {
        (Some(k @ ("quotaProbes" | "quota-probes")), Some(raw)) => {
            let enabled = config::parse_bool_setting(raw).ok_or_else(|| {
                CliError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("Invalid value '{raw}' for {k}. Use on/off or true/false."),
                ))
            })?;
            config::set_quota_probes_enabled(enabled).await?;
            if enabled {
                println!(
                    "Local provider quota probes enabled (unless XMATRIX_DISABLE_QUOTA_PROBES=1 is set)."
                );
            } else {
                println!(
                    "Local provider quota probes disabled. Restart the daemon for running sessions to pick up the change, or set XMATRIX_DISABLE_QUOTA_PROBES=1."
                );
            }
            return Ok(());
        }
        (Some("telemetry"), Some(raw)) => {
            let enabled = config::parse_bool_setting(raw).ok_or_else(|| {
                CliError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("Invalid value '{raw}' for telemetry. Use on/off or true/false."),
                ))
            })?;
            config::set_telemetry_enabled(enabled).await?;
            // An explicit choice here is also the account's, so the apps follow it.
            let choice = if enabled {
                telemetry_consent::DiagnosticsChoice::OptedIn
            } else {
                telemetry_consent::DiagnosticsChoice::OptedOut
            };
            let recorded = match config::load_session_for_hub(hub_url).await {
                Some(session) => {
                    telemetry_consent::write_choice(&session.hub_url, &session.token, choice).await
                }
                None => false,
            };
            if enabled {
                println!(
                    "Diagnostics turned on for this machine (still off while XMATRIX_TELEMETRY=0 is set)."
                );
            } else {
                println!("Diagnostics turned off for this machine.");
            }
            if !recorded {
                println!(
                    "  Not saved to your account (signed out or offline); the apps keep their own setting."
                );
            }
            return Ok(());
        }
        (Some("quotaProbes" | "quota-probes"), None) => {
            println!("{}", !config::quota_probes_disabled());
            return Ok(());
        }
        (Some("telemetry"), None) => {
            println!("{}", telemetry_allowed(hub_url).await);
            return Ok(());
        }
        (None, _) => {
            let session = config::load_session_for_hub(hub_url).await;
            let mut output = match session {
                Some(s) => session_diagnostics(s)?,
                None => serde_json::json!({}),
            };
            if let Some(map) = output.as_object_mut() {
                map.insert(
                    "quotaProbes".into(),
                    serde_json::Value::Bool(!config::quota_probes_disabled()),
                );
                map.insert(
                    "telemetry".into(),
                    serde_json::Value::Bool(telemetry_allowed(hub_url).await),
                );
                map.insert("quotaAccess".into(), quota_access_states());
            }
            println!("{}", serde_json::to_string_pretty(&output)?);
        }
        (Some(k), _) => {
            let session = config::load_session_for_hub(hub_url).await;
            match session {
                Some(s) => {
                    let val = session_diagnostics(s)?;
                    if let Some(v) = val.get(k) {
                        println!("{v}");
                    } else {
                        println!("Key '{k}' not found");
                    }
                }
                None => {
                    println!("No config found. Run: xmatrix login");
                }
            }
        }
    }
    Ok(())
}

/// `{ "<harness>": "granted" | "not_granted" | "probes_off" }` for every harness
/// whose quota is read only under its owner's grant.
fn quota_access_states() -> serde_json::Value {
    quota_access::quota_access_harnesses()
        .map(|harness| {
            (
                harness.to_string(),
                serde_json::Value::from(quota_access::quota_access(harness).as_str()),
            )
        })
        .collect::<serde_json::Map<_, _>>()
        .into()
}

/// `config quotaAccess [<harness> [on|off]]`: allow or stop xMatrix reading a
/// harness's local sign-in on this computer to show its quota.
async fn cmd_config_quota_access(
    hub_url: &str,
    key: &str,
    harness: Option<&str>,
    setting: Option<&str>,
) -> error::Result<()> {
    let Some(harness) = harness.map(str::trim) else {
        println!("{}", serde_json::to_string_pretty(&quota_access_states())?);
        return Ok(());
    };
    let Some(raw) = setting else {
        if quota_access::quota_access_provider(harness).is_none() {
            return Err(CliError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("'{harness}' needs no quota access grant."),
            )));
        }
        println!("{}", quota_access::quota_access(harness).as_str());
        return Ok(());
    };
    let on = config::parse_bool_setting(raw).ok_or_else(|| {
        CliError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("Invalid value '{raw}' for {key} {harness}. Use on/off."),
        ))
    })?;
    let state = quota_access::set_quota_access(harness, on).await?;
    let name = xmatrix_cli_agent::agent_preset_by_id(harness)
        .map(|preset| preset.display_name.clone())
        .unwrap_or_else(|| harness.to_string());
    match (on, state) {
        (true, quota_access::QuotaAccess::ProbesOff) => println!(
            "Allowed reading {name}'s sign-in on this computer, but local provider quota probes are off, so nothing is read until `xmatrix config quotaProbes on`."
        ),
        (true, _) => println!(
            "Allowed xMatrix to read {name}'s sign-in on this computer, only to ask {name} for its own usage. Nothing from it leaves this computer. Turn it off with `xmatrix config {key} {harness} off`."
        ),
        (false, _) => println!(
            "xMatrix no longer reads {name}'s sign-in on this computer; its quota shows as unknown."
        ),
    }
    report_quota_access_to_hub(hub_url).await;
    Ok(())
}

/// Ask this machine's daemon, through the Hub, to report its harnesses again so
/// the Hub shows the new answer (and drops the last reading after a revoke).
/// Best effort: the daemon's next report carries it anyway.
async fn report_quota_access_to_hub(hub_url: &str) {
    let machine_id = config::load_config_sync().machine_id;
    let session = config::load_session_for_hub(hub_url).await;
    let (Some(machine_id), Some(session)) = (machine_id, session) else {
        return;
    };
    let body =
        serde_json::json!({ "machineId": machine_id, "presetId": "custom", "action": "refresh" });
    let url = format!(
        "{}/api/machine-daemons/harness-actions",
        hub_url.trim_end_matches('/')
    );
    if let Err(error) = xmatrix_cli_core::http::request_json::<serde_json::Value>(
        &url,
        "POST",
        Some(&session.token),
        Some(body),
    )
    .await
    {
        eprintln!("The Hub will show this after the machine's next report ({error}).");
    }
}

// Config output is diagnostic data, never a credential export. Apply the same
// redaction before selecting a key so `config token` cannot bypass it.
fn session_diagnostics(mut session: config::CliSession) -> error::Result<serde_json::Value> {
    session.token = "[redacted]".into();
    if let Some(refresh_token) = session.refresh_token.as_mut() {
        *refresh_token = "[redacted]".into();
    }
    Ok(serde_json::to_value(session)?)
}

async fn cmd_machine_worktrees(command: Option<MachineWorktreesCommand>) -> error::Result<()> {
    let known: Vec<std::path::PathBuf> = std::env::current_dir().into_iter().collect();
    match command.unwrap_or(MachineWorktreesCommand::List { json: false }) {
        MachineWorktreesCommand::List { json } => {
            let trees = machine_worktrees::machine_worktrees(&known).await;
            if json {
                println!("{}", serde_json::to_string_pretty(&trees)?);
                return Ok(());
            }
            print_worktrees(&trees);
            let auto = match machine_worktrees::foreign_auto_reclaim_enabled() {
                Ok(true) => "on".to_string(),
                Ok(false) => "off".to_string(),
                Err(error) => format!("unreadable ({error})"),
            };
            println!(
                "\nxMatrix reclaims repo-pool and run worktrees itself. Automatic reclaim of the others is {auto} (xmatrix machine worktrees auto-reclaim on|off)."
            );
        }
        MachineWorktreesCommand::AutoReclaim { state } => {
            let on = state == OnOff::On;
            machine_worktrees::set_foreign_auto_reclaim(on)
                .map_err(|error| CliError::Io(std::io::Error::other(error)))?;
            if on {
                println!(
                    "The daemon now reclaims worktrees xMatrix did not create once they sit untouched for the named-tree floor (7 days, 1 day when the disk is low). Un-landed work is pinned under refs/xmatrix/snapshot/foreign/ first."
                );
            } else {
                println!("The daemon now only lists worktrees xMatrix did not create.");
            }
        }
        MachineWorktreesCommand::Reclaim {
            origin,
            idle_days,
            dry_run,
        } => {
            let origins: Vec<WorktreeOrigin> = origin
                .into_iter()
                .map(|origin| match origin {
                    ForeignWorktreeOrigin::ClaudeCode => WorktreeOrigin::ClaudeCode,
                    ForeignWorktreeOrigin::Codex => WorktreeOrigin::Codex,
                    ForeignWorktreeOrigin::Cursor => WorktreeOrigin::Cursor,
                    ForeignWorktreeOrigin::Manual => WorktreeOrigin::Manual,
                })
                .collect();
            let trees = machine_worktrees::machine_worktrees(&known).await;
            let outcome = machine_worktrees::reclaim_foreign_worktrees(
                &trees,
                &std::collections::HashSet::new(),
                (!origins.is_empty()).then_some(origins.as_slice()),
                std::time::Duration::from_secs(idle_days.saturating_mul(24 * 60 * 60)),
                !dry_run,
            )
            .await;
            let verb = if dry_run {
                "Would reclaim"
            } else {
                "Reclaimed"
            };
            println!("{verb} {} worktree(s).", outcome.reclaimed.len());
            for path in &outcome.reclaimed {
                let note = if outcome.snapshotted.contains(path) {
                    " (un-landed work snapshotted)"
                } else {
                    ""
                };
                println!("  {}{note}", path.display());
            }
            for path in &outcome.in_use {
                println!("  in use, kept: {}", path.display());
            }
            for (path, reason) in &outcome.skipped {
                println!("  skipped {}: {reason}", path.display());
            }
        }
    }
    Ok(())
}

fn print_worktrees(trees: &[MachineWorktree]) {
    if trees.is_empty() {
        println!("No linked worktrees found.");
        return;
    }
    let mut origin = None;
    for tree in trees {
        if origin != Some(tree.origin) {
            origin = Some(tree.origin);
            let count = trees
                .iter()
                .filter(|other| other.origin == tree.origin)
                .count();
            println!("{} ({count})", tree.origin.label());
        }
        let idle = match (tree.missing, tree.idle_secs) {
            (true, _) => "missing".to_string(),
            (false, Some(secs)) if secs >= 24 * 60 * 60 => format!("{}d", secs / (24 * 60 * 60)),
            (false, Some(secs)) => format!("{}h", secs / (60 * 60)),
            (false, None) => "?".to_string(),
        };
        let lock = if tree.locked.is_some() {
            "  [locked]"
        } else {
            ""
        };
        println!(
            "  {idle:>7}  {}  {}{lock}",
            tree.path.display(),
            tree.branch.as_deref().unwrap_or("(detached)")
        );
    }
}

pub async fn cmd_machine(hub_url: &str, command: MachineCommand) -> error::Result<()> {
    match command {
        MachineCommand::Identity => {
            let identity = config::get_or_create_machine_identity(hub_url).await?;
            println!("Machine ID: {}", identity.machine_id);
            println!("Derived from: {}", identity.fingerprint.source);
            if let Some(parent) = identity.parent_machine_id {
                println!("Windows host Machine ID: {parent}");
            }
            if identity.legacy_machine_ids.is_empty() {
                println!("Legacy machine IDs: none");
            } else {
                println!("Legacy machine IDs (adopted when the daemon next connects):");
                for legacy in identity.legacy_machine_ids {
                    println!("  {legacy}");
                }
            }
        }
        MachineCommand::Supervisor { command } => cmd_machine_supervisor(hub_url, command).await?,
        MachineCommand::Worktrees { command } => cmd_machine_worktrees(command).await?,
        MachineCommand::Rename { name } => {
            let session = config::load_session_for_hub(hub_url).await.ok_or_else(|| {
                CliError::Auth("Renaming a Machine requires a login. Run: xmatrix login".into())
            })?;
            let identity = config::machine_identity_for_owner(&session.user.id).await?;
            let response: serde_json::Value = xmatrix_cli_core::http::request_json(
                &format!(
                    "{}/{}/name",
                    xmatrix_cli_core::protocol::with_route(
                        hub_url,
                        xmatrix_cli_core::protocol::HubRoutes::MACHINES
                    ),
                    urlencoding::encode(&identity.machine_id)
                ),
                "PUT",
                Some(&session.token),
                Some(serde_json::json!({ "name": name })),
            )
            .await?;
            let renamed = response
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(name.as_str());
            println!("This Machine is now named {renamed}.");
        }
        MachineCommand::AutoAssign { state } => {
            let session = config::load_session_for_hub(hub_url).await.ok_or_else(|| {
                CliError::Auth(
                    "Changing automatic assignment requires a login. Run: xmatrix login".into(),
                )
            })?;
            let identity = config::machine_identity_for_owner(&session.user.id).await?;
            let on = state == OnOff::On;
            xmatrix_cli_core::http::request_json::<serde_json::Value>(
                &format!(
                    "{}/{}/auto-assign",
                    xmatrix_cli_core::protocol::with_route(
                        hub_url,
                        xmatrix_cli_core::protocol::HubRoutes::MACHINES
                    ),
                    urlencoding::encode(&identity.machine_id)
                ),
                "PUT",
                Some(&session.token),
                Some(serde_json::json!({ "autoAssign": on })),
            )
            .await?;
            if on {
                println!("This Machine now takes part in automatic assignment.");
            } else {
                println!(
                    "This Machine is out of automatic assignment; Agents start here only when someone names it."
                );
            }
        }
    }
    Ok(())
}

async fn cmd_machine_supervisor(
    hub_url: &str,
    command: MachineSupervisorCommand,
) -> error::Result<()> {
    match command {
        MachineSupervisorCommand::StartDaemon => start_user_daemon_from_supervisor(hub_url),
        MachineSupervisorCommand::BridgePreflight {
            artifact_sha256,
            transaction_id,
            transaction_nonce,
            source_epoch,
            fence,
        } => {
            bridge_migration_preflight(
                hub_url,
                &artifact_sha256,
                &transaction_id,
                &transaction_nonce,
                source_epoch,
                fence,
            )
            .await
        }
    }
}

async fn bridge_migration_preflight(
    hub_url: &str,
    artifact_sha256: &str,
    transaction_id: &str,
    transaction_nonce: &str,
    source_epoch: Option<u64>,
    fence: bool,
) -> error::Result<()> {
    if artifact_sha256.len() != 64
        || !artifact_sha256
            .bytes()
            .all(|value| value.is_ascii_hexdigit())
        || transaction_id.trim().is_empty()
        || transaction_nonce.len() < 32
        || (fence && source_epoch.is_none())
    {
        return Err(CliError::Launch(
            "Bridge migration identity is invalid".into(),
        ));
    }
    let session = config::load_session_for_hub(hub_url).await.ok_or_else(|| {
        CliError::Auth("Bridge migration requires an existing xMatrix login".into())
    })?;
    let machine = config::get_or_create_machine_identity(hub_url).await?;
    let hostname = gethostname::gethostname().to_string_lossy().to_string();
    let response: serde_json::Value = xmatrix_cli_core::http::request_json(
        &xmatrix_cli_core::protocol::with_route(
            hub_url,
            xmatrix_cli_core::protocol::HubRoutes::MACHINE_DAEMON_MIGRATION_FENCE,
        ),
        "POST",
        Some(&session.token),
        Some(serde_json::json!({
            "machineId": machine.machine_id,
            "hostname": hostname,
            "artifactSha256": artifact_sha256,
            "transactionId": transaction_id,
            "transactionNonce": transaction_nonce,
            "sourceConnectionEpoch": source_epoch,
            "fence": fence,
        })),
    )
    .await?;
    if response.get("empty").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err(CliError::Launch(
            "Hub authoritative Run set is not empty; Bridge migration deferred".into(),
        ));
    }
    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}

fn start_user_daemon_from_supervisor(hub_url: &str) -> error::Result<()> {
    let exe = std::env::current_exe().map_err(|err| {
        CliError::Launch(format!("Could not locate supervisor executable: {err}"))
    })?;
    #[cfg(windows)]
    return run_windows_supervisor(&exe, hub_url);

    #[cfg(not(windows))]
    let mut command = std::process::Command::new(&exe);
    #[cfg(not(windows))]
    configure_supervised_daemon(&mut command, hub_url);

    #[cfg(not(windows))]
    let mut child = command.spawn().map_err(|err| {
        CliError::Launch(format!(
            "Machine supervisor could not start user daemon from {}: {err}",
            exe.display()
        ))
    })?;
    #[cfg(not(windows))]
    println!(
        "Machine supervisor started xMatrix user daemon from {}",
        exe.display()
    );

    #[cfg(not(windows))]
    let status = child.wait().map_err(|err| {
        CliError::Launch(format!(
            "Machine supervisor lost the xMatrix user daemon from {}: {err}",
            exe.display()
        ))
    })?;
    #[cfg(not(windows))]
    if status.success() {
        println!("Machine supervisor observed a clean xMatrix user daemon exit");
        Ok(())
    } else {
        Err(CliError::Launch(format!(
            "xMatrix user daemon from {} exited with {status}",
            exe.display()
        )))
    }
}

#[cfg(windows)]
fn run_windows_supervisor(supervisor_exe: &Path, hub_url: &str) -> error::Result<()> {
    use std::os::windows::process::CommandExt;

    let daemon_root = windows_daemon_root(supervisor_exe);
    std::fs::create_dir_all(&daemon_root)?;
    let _lock = acquire_supervisor_lock(&daemon_root)?;
    let journal = ActivationJournal::new(daemon_root.join("activation-journal.json"));
    let payload = match journal.load() {
        Ok(payload) => payload,
        Err(xmatrix_windows_continuity::ContinuityError::Io(error))
            if error.kind() == std::io::ErrorKind::NotFound =>
        {
            let payload = initial_journal(supervisor_exe)?;
            journal.store(&payload).map_err(continuity_error)?;
            payload
        }
        // A journal that cannot be read names no daemon to start. Exiting here
        // would leave the machine without a daemon, and the daemon is the only
        // way a fixed release reaches it. The unreadable files are kept, and
        // this Supervisor's own release starts as it does on a first start;
        // that daemon then updates itself as usual.
        Err(
            error @ (xmatrix_windows_continuity::ContinuityError::Json(_)
            | xmatrix_windows_continuity::ContinuityError::Invalid(_)
            | xmatrix_windows_continuity::ContinuityError::ChecksumMismatch
            | xmatrix_windows_continuity::ContinuityError::FrameTooLarge(_)),
        ) => {
            let kept = journal.set_aside_unreadable();
            let payload = initial_journal(supervisor_exe)?;
            journal.store(&payload).map_err(continuity_error)?;
            eprintln!(
                "Machine supervisor could not read its activation journal ({error}); kept {kept:?} and started from its own release {}",
                payload.committed.version
            );
            let _ = xmatrix_windows_continuity::ContinuityEventLog::new(
                daemon_root.join("continuity-events.json"),
            )
            .append(
                "supervisor",
                "activation_journal_unreadable",
                None,
                Some(&payload.committed.sha256),
                None,
                Some(match error {
                    xmatrix_windows_continuity::ContinuityError::Json(_) => "json",
                    xmatrix_windows_continuity::ContinuityError::ChecksumMismatch => "checksum",
                    xmatrix_windows_continuity::ContinuityError::FrameTooLarge(_) => "too_large",
                    _ => "invalid",
                }),
            );
            payload
        }
        Err(error) => return Err(continuity_error(error)),
    };
    let target = verified_committed_target(&daemon_root, &payload.committed)?;
    let mut restarts = VecDeque::new();
    loop {
        let mut command = std::process::Command::new(&target);
        configure_supervised_daemon(&mut command, hub_url);
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = command.spawn().map_err(|error| {
            CliError::Launch(format!(
                "Machine supervisor could not start exact committed daemon {}: {error}",
                target.display()
            ))
        })?;
        let status = child.wait().map_err(|error| {
            CliError::Launch(format!(
                "Machine supervisor lost exact daemon handle {}: {error}",
                target.display()
            ))
        })?;
        if status.success() {
            return Ok(());
        }
        record_restart(&mut restarts)?;
        let shift = restarts.len().saturating_sub(1).min(4) as u32;
        std::thread::sleep(Duration::from_millis(250u64 << shift));
    }
}

#[cfg(windows)]
fn windows_daemon_root(executable: &Path) -> PathBuf {
    executable
        .ancestors()
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("xmatrix-daemon"))
        })
        .map(Path::to_path_buf)
        .unwrap_or_else(|| config::config_dir().join("windows-supervisor"))
}

#[cfg(windows)]
fn initial_journal(executable: &Path) -> error::Result<JournalPayload> {
    let canonical = std::fs::canonicalize(executable)?;
    let executable_sha256 = sha256_file(&canonical).map_err(continuity_error)?;
    let publisher_sha256 = xmatrix_windows_continuity::verify_authenticode_publisher(&canonical)
        .map_err(continuity_error)?;
    let generation = canonical
        .parent()
        .and_then(Path::file_name)
        .and_then(|value| value.to_str())
        .unwrap_or("legacy")
        .to_string();
    let artifact = ArtifactIdentity {
        generation: if generation == "ping" || generation == "pong" {
            format!("legacy-{generation}")
        } else {
            generation
        },
        sha256: executable_sha256.clone(),
        executable_path: canonical.clone(),
        release_envelope_path: canonical,
        release_envelope_sha256: executable_sha256,
        publisher_sha256,
        version: xmatrix_cli_core::version::current().to_string(),
        target: "x86_64-pc-windows-msvc".to_string(),
        release_sequence: parse_release_sequence(xmatrix_cli_core::version::current()),
        protocol_min: 1,
        protocol_max: 1,
    };
    Ok(JournalPayload {
        schema: JOURNAL_SCHEMA,
        revision: 1,
        generation_pins: BTreeSet::from([artifact.generation.clone()]),
        committed: artifact,
        previous: None,
        candidate: None,
        transaction: None,
        quarantined_sha256: BTreeSet::new(),
        last_hub_epoch: None,
    })
}

#[cfg(windows)]
fn verified_committed_target(
    daemon_root: &Path,
    artifact: &ArtifactIdentity,
) -> error::Result<PathBuf> {
    artifact.validate().map_err(continuity_error)?;
    let target = std::fs::canonicalize(&artifact.executable_path)?;
    let root = std::fs::canonicalize(daemon_root)?;
    if !target.starts_with(&root)
        || target
            .file_name()
            .and_then(|name| name.to_str())
            .is_none_or(|name| !name.eq_ignore_ascii_case("xmatrix.exe"))
    {
        return Err(CliError::Launch(
            "Committed Windows daemon escapes its exact managed root".into(),
        ));
    }
    if sha256_file(&target).map_err(continuity_error)? != artifact.sha256 {
        return Err(CliError::Launch(
            "Committed Windows daemon digest no longer matches the activation journal".into(),
        ));
    }
    Ok(target)
}

#[cfg(windows)]
fn acquire_supervisor_lock(root: &Path) -> error::Result<std::fs::File> {
    let path = root.join("supervisor.lock");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)?;
    file.try_lock_exclusive().map_err(|error| {
        CliError::Launch(format!(
            "Another Windows Supervisor owns {}: {error}",
            path.display()
        ))
    })?;
    file.set_len(0)?;
    writeln!(file, "pid={}", std::process::id())?;
    file.sync_all()?;
    Ok(file)
}

#[cfg(windows)]
fn record_restart(restarts: &mut VecDeque<Instant>) -> error::Result<()> {
    let now = Instant::now();
    while restarts
        .front()
        .is_some_and(|value| now.duration_since(*value) >= SUPERVISOR_RESTART_WINDOW)
    {
        restarts.pop_front();
    }
    if restarts.len() >= SUPERVISOR_RESTART_LIMIT {
        return Err(CliError::Launch(
            "Windows daemon exceeded its bounded Supervisor restart budget".into(),
        ));
    }
    restarts.push_back(now);
    Ok(())
}

#[cfg(windows)]
fn parse_release_sequence(version: &str) -> u64 {
    xmatrix_windows_continuity::release_sequence_from_version(version).unwrap_or_default()
}

#[cfg(windows)]
fn continuity_error(error: xmatrix_windows_continuity::ContinuityError) -> CliError {
    CliError::Launch(format!(
        "Windows continuity boundary rejected state: {error}"
    ))
}

fn configure_supervised_daemon(command: &mut std::process::Command, hub_url: &str) {
    command
        .arg("daemon")
        .env("XMATRIX_SUPERVISOR_PARENT", "1")
        .env("XMATRIX_HUB_URL", hub_url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
}
