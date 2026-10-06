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

use xmatrix_cli_args::{MachineCommand, MachineSupervisorCommand, OnOff};
use xmatrix_cli_core::config;
use xmatrix_cli_core::error::{self, CliError};
#[cfg(windows)]
use xmatrix_windows_continuity::{
    ActivationJournal, ArtifactIdentity, JOURNAL_SCHEMA, JournalPayload, sha256_file,
};

#[cfg(windows)]
const SUPERVISOR_RESTART_WINDOW: Duration = Duration::from_secs(60);
#[cfg(windows)]
const SUPERVISOR_RESTART_LIMIT: usize = 5;

pub async fn cmd_config(
    hub_url: &str,
    key: Option<String>,
    value: Option<String>,
) -> error::Result<()> {
    match (key, value) {
        (None, _) => {
            let session = config::load_session_for_hub(hub_url).await;
            match session {
                Some(s) => {
                    println!("{}", serde_json::to_string_pretty(&s)?);
                }
                None => {
                    println!("No config found. Run: xmatrix login");
                }
            }
        }
        (Some(k), _) => {
            let session = config::load_session_for_hub(hub_url).await;
            match session {
                Some(s) => {
                    let val = serde_json::to_value(&s)?;
                    if let Some(v) = val.get(&k) {
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
        .env_remove("XMATRIX_ENVIRONMENT")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
}
