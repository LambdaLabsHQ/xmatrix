#![deny(warnings)]
#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
fn main() {
    if let Err(error) = run() {
        eprintln!("xMatrix Boot Verifier failed closed: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("xmatrix-bootstrap is a Windows-only artifact");
    std::process::exit(2);
}

#[cfg(windows)]
fn run() -> Result<(), Box<dyn std::error::Error>> {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;
    use xmatrix_windows_continuity::{
        BootJournal, ContinuityEventLog, ControlMessage, InheritedControlPipe,
        SUPERVISOR_PROTOCOL_MAJOR, current_unix_time, verify_signed_artifact,
    };

    if std::env::args().any(|value| value == "--verify-release-artifact") {
        return verify_release_artifact();
    }
    let root = required_path("--root")?;
    if std::env::args().any(|value| value == "--initialize") {
        return initialize(&root);
    }
    if std::env::args().any(|value| value == "--stage-supervisor") {
        return stage_supervisor(&root);
    }
    let hub_url = required_value("--hub-url")?;
    let journal = BootJournal::new(root.join("boot-journal.json"));
    let events = ContinuityEventLog::new(root.join("continuity-events.json"));
    let canonical_root = std::fs::canonicalize(&root)?;
    let mut payload = journal.load()?;
    loop {
        let pending_boot = payload.phase == xmatrix_windows_continuity::BootPhase::Pending;
        let selected = payload.selected()?.clone();
        let executable = std::fs::canonicalize(&selected.executable_path)?;
        let envelope = std::fs::canonicalize(&selected.release_envelope_path)?;
        if !executable.starts_with(&canonical_root) || !envelope.starts_with(&canonical_root) {
            return Err("selected Supervisor escaped its managed root".into());
        }
        verify_signed_artifact(
            &selected,
            current_unix_time()?,
            selected.release_sequence,
            Some(&payload.committed.publisher_sha256),
            !pending_boot,
        )?;
        events.append(
            "bootstrap",
            "supervisor_selected",
            None,
            Some(&selected.sha256),
            Some(if pending_boot { "pending" } else { "stable" }),
            None,
        )?;
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let mut control = InheritedControlPipe::create()?;
        let mut command = std::process::Command::new(&executable);
        command
            .args([
                "--daemon-root",
                root.to_string_lossy().as_ref(),
                "--hub-url",
                &hub_url,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env("XMATRIX_SUPERVISOR_TRANSACTION_NONCE", &nonce)
            .env(
                "XMATRIX_SUPERVISOR_BOOT_PENDING",
                if pending_boot { "1" } else { "0" },
            );
        control.child_handles()?.apply(&mut command);
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = command.spawn()?;
        control.release_child_handles();
        let hello = control.receive();
        if !matches!(
            hello,
            Ok(ControlMessage::Hello { protocol_major, nonce: received })
                if protocol_major == SUPERVISOR_PROTOCOL_MAJOR && received == nonce
        ) {
            if pending_boot {
                let _ = child.kill();
                let _ = child.wait();
                quarantine_pending_boot(&journal, &events, &mut payload, "handshake_failed")?;
                continue;
            }
            return Err("Supervisor inherited-pipe handshake failed".into());
        }
        if pending_boot {
            let preflight = control.receive();
            if !matches!(preflight, Ok(ControlMessage::BootPreflightReady { nonce: received }) if received == nonce)
            {
                let _ = child.kill();
                let _ = child.wait();
                quarantine_pending_boot(&journal, &events, &mut payload, "preflight_failed")?;
                continue;
            }
            control.send(&ControlMessage::BootCommitGranted {
                nonce: nonce.clone(),
            })?;
            let stable = control.receive();
            if !matches!(stable, Ok(ControlMessage::BootStable { nonce: received }) if received == nonce)
            {
                let _ = child.kill();
                let _ = child.wait();
                quarantine_pending_boot(&journal, &events, &mut payload, "boot_stable_missing")?;
                continue;
            }
            let promoted = payload
                .pending
                .take()
                .ok_or("pending boot lost its Supervisor artifact")?;
            payload.previous = Some(std::mem::replace(&mut payload.committed, promoted));
            payload.phase = xmatrix_windows_continuity::BootPhase::Stable;
            payload.revision = payload.revision.saturating_add(1);
            journal.store(&payload)?;
            events.append(
                "bootstrap",
                "supervisor_committed",
                None,
                Some(&payload.committed.sha256),
                Some("stable"),
                None,
            )?;
        }
        let status = child.wait()?;
        return if status.success() {
            Ok(())
        } else {
            Err(format!("Supervisor exited with {status}").into())
        };
    }
}

#[cfg(windows)]
fn verify_release_artifact() -> Result<(), Box<dyn std::error::Error>> {
    use xmatrix_windows_continuity::{
        ArtifactIdentity, current_unix_time, sha256_file, verify_authenticode_publisher,
        verify_signed_artifact,
    };

    let artifact_path = std::fs::canonicalize(required_path("--artifact")?)?;
    let envelope_path = std::fs::canonicalize(required_path("--release-envelope")?)?;
    let publisher_sha256 = verify_authenticode_publisher(&artifact_path)?;
    let current_publisher = verify_authenticode_publisher(&std::env::current_exe()?)?;
    let version = required_value("--version")?;
    let identity = ArtifactIdentity {
        generation: "release-verification".into(),
        sha256: sha256_file(&artifact_path)?,
        executable_path: artifact_path,
        release_envelope_sha256: sha256_file(&envelope_path)?,
        release_envelope_path: envelope_path,
        publisher_sha256,
        version,
        target: required_value("--target")?,
        release_sequence: required_value("--release-sequence")?.parse()?,
        protocol_min: 1,
        protocol_max: 1,
    };
    verify_signed_artifact(
        &identity,
        current_unix_time()?,
        identity.release_sequence,
        Some(&current_publisher),
        false,
    )?;
    Ok(())
}

#[cfg(windows)]
fn stage_supervisor(root: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    use xmatrix_windows_continuity::{
        ArtifactIdentity, BootJournal, BootPhase, current_unix_time, sha256_file,
        verify_authenticode_publisher, verify_signed_artifact,
    };

    let root = std::fs::canonicalize(root)?;
    let supervisor = std::fs::canonicalize(required_path("--supervisor")?)?;
    let release_envelope = std::fs::canonicalize(required_path("--release-envelope")?)?;
    if !supervisor.starts_with(&root) || !release_envelope.starts_with(&root) {
        return Err("pending Supervisor escapes the managed root".into());
    }
    let version = required_value("--version")?;
    let release_sequence = required_value("--release-sequence")?.parse::<u64>()?;
    let generation = supervisor
        .parent()
        .and_then(std::path::Path::file_name)
        .and_then(|value| value.to_str())
        .ok_or("pending Supervisor generation is invalid")?
        .to_string();
    let publisher_sha256 = verify_authenticode_publisher(&supervisor)?;
    let artifact = ArtifactIdentity {
        generation,
        sha256: sha256_file(&supervisor)?,
        executable_path: supervisor,
        release_envelope_sha256: sha256_file(&release_envelope)?,
        release_envelope_path: release_envelope,
        publisher_sha256,
        version,
        target: required_value("--target")?,
        release_sequence,
        protocol_min: 1,
        protocol_max: 1,
    };
    artifact.validate()?;
    let journal = BootJournal::new(root.join("boot-journal.json"));
    let mut payload = journal.load()?;
    verify_signed_artifact(
        &artifact,
        current_unix_time()?,
        payload.committed.release_sequence,
        Some(&payload.committed.publisher_sha256),
        false,
    )?;
    if payload.committed.sha256 == artifact.sha256 {
        return Ok(());
    }
    if artifact.release_sequence < payload.committed.release_sequence
        || payload.quarantined_sha256.contains(&artifact.sha256)
    {
        return Err("pending Supervisor violates rollback floor or quarantine".into());
    }
    payload.pending = Some(artifact);
    payload.phase = BootPhase::Pending;
    payload.revision = payload.revision.saturating_add(1);
    journal.store(&payload)?;
    xmatrix_windows_continuity::ContinuityEventLog::new(root.join("continuity-events.json"))
        .append(
            "bootstrap",
            "supervisor_staged",
            None,
            payload.pending.as_ref().map(|value| value.sha256.as_str()),
            Some("pending"),
            None,
        )?;
    Ok(())
}

#[cfg(windows)]
fn quarantine_pending_boot(
    journal: &xmatrix_windows_continuity::BootJournal,
    events: &xmatrix_windows_continuity::ContinuityEventLog,
    payload: &mut xmatrix_windows_continuity::BootPayload,
    detail_code: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let pending = payload
        .pending
        .take()
        .ok_or("pending boot lost its Supervisor artifact")?;
    let quarantined_sha256 = pending.sha256.clone();
    xmatrix_windows_continuity::insert_bounded_quarantine(
        &mut payload.quarantined_sha256,
        quarantined_sha256.clone(),
    );
    payload.phase = xmatrix_windows_continuity::BootPhase::Stable;
    payload.revision = payload.revision.saturating_add(1);
    journal.store(payload)?;
    events.append(
        "bootstrap",
        "supervisor_quarantined",
        None,
        Some(&quarantined_sha256),
        Some("quarantined"),
        Some(detail_code),
    )?;
    Ok(())
}

#[cfg(windows)]
fn initialize(root: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    use std::collections::BTreeSet;
    use xmatrix_windows_continuity::{
        ActivationJournal, ArtifactIdentity, BootJournal, BootPayload, BootPhase, JOURNAL_SCHEMA,
        JournalPayload, sha256_file,
    };

    std::fs::create_dir_all(root)?;
    let root = std::fs::canonicalize(root)?;
    let supervisor = std::fs::canonicalize(required_path("--supervisor")?)?;
    let daemon = std::fs::canonicalize(required_path("--daemon")?)?;
    let supervisor_envelope = std::fs::canonicalize(required_path("--supervisor-envelope")?)?;
    let daemon_envelope = std::fs::canonicalize(required_path("--daemon-envelope")?)?;
    let recovery_supervisor = optional_value("--recovery-supervisor")
        .map(std::fs::canonicalize)
        .transpose()?;
    let recovery_envelope = optional_value("--recovery-envelope")
        .map(std::fs::canonicalize)
        .transpose()?;
    if !supervisor.starts_with(&root)
        || !daemon.starts_with(&root)
        || !supervisor_envelope.starts_with(&root)
        || !daemon_envelope.starts_with(&root)
        || recovery_supervisor
            .as_ref()
            .is_some_and(|path| !path.starts_with(&root))
        || recovery_envelope
            .as_ref()
            .is_some_and(|path| !path.starts_with(&root))
    {
        return Err("initial continuity artifacts escape the managed root".into());
    }
    let version = required_value("--version")?;
    let target = required_value("--target")?;
    let release_sequence = required_value("--release-sequence")?.parse::<u64>()?;
    if release_sequence == 0 {
        return Err("release sequence must be positive".into());
    }
    let identity = |path: std::path::PathBuf,
                    envelope: std::path::PathBuf|
     -> Result<ArtifactIdentity, Box<dyn std::error::Error>> {
        let generation = path
            .parent()
            .and_then(std::path::Path::file_name)
            .and_then(|value| value.to_str())
            .ok_or("artifact generation is invalid")?
            .to_string();
        let publisher_sha256 = xmatrix_windows_continuity::verify_authenticode_publisher(&path)?;
        Ok(ArtifactIdentity {
            generation,
            sha256: sha256_file(&path)?,
            executable_path: path,
            release_envelope_sha256: sha256_file(&envelope)?,
            release_envelope_path: envelope,
            publisher_sha256,
            version: version.clone(),
            target: target.clone(),
            release_sequence,
            protocol_min: 1,
            protocol_max: 1,
        })
    };
    let supervisor = identity(supervisor, supervisor_envelope)?;
    let daemon = identity(daemon, daemon_envelope)?;
    let recovery = recovery_supervisor
        .zip(recovery_envelope)
        .map(|(path, envelope)| identity(path, envelope))
        .transpose()?;
    if supervisor.publisher_sha256 != daemon.publisher_sha256
        || recovery
            .as_ref()
            .is_some_and(|artifact| artifact.publisher_sha256 != supervisor.publisher_sha256)
    {
        return Err("initial continuity artifacts have different publishers".into());
    }
    let now = xmatrix_windows_continuity::current_unix_time()?;
    xmatrix_windows_continuity::verify_signed_artifact(
        &supervisor,
        now,
        release_sequence,
        Some(&daemon.publisher_sha256),
        false,
    )?;
    if let Some(recovery) = &recovery {
        xmatrix_windows_continuity::verify_signed_artifact(
            recovery,
            now,
            release_sequence,
            Some(&supervisor.publisher_sha256),
            false,
        )?;
    }
    xmatrix_windows_continuity::verify_signed_artifact(
        &daemon,
        now,
        release_sequence,
        Some(&supervisor.publisher_sha256),
        false,
    )?;
    let migration_transaction = optional_value("--migration-transaction");
    let migration_nonce = optional_value("--migration-nonce");
    let migration_source_epoch = optional_value("--migration-source-epoch")
        .map(|value| value.parse::<u64>())
        .transpose()?;
    if [
        migration_transaction.is_some(),
        migration_nonce.is_some(),
        migration_source_epoch.is_some(),
    ]
    .into_iter()
    .any(|present| present)
        && !(migration_transaction.is_some()
            && migration_nonce
                .as_ref()
                .is_some_and(|value| value.len() >= 32)
            && migration_source_epoch.is_some_and(|value| value > 0))
    {
        return Err("Bridge migration transaction is incomplete".into());
    }
    if migration_transaction.is_some() != recovery.is_some() {
        return Err("Bridge migration recovery adapter is incomplete".into());
    }
    let event_transaction_id = migration_transaction.clone();
    let event_daemon_sha256 = daemon.sha256.clone();
    let boot = BootJournal::new(root.join("boot-journal.json"));
    let desired_committed = recovery.as_ref().unwrap_or(&supervisor);
    let desired_pending = recovery.as_ref().map(|_| supervisor.clone());
    match boot.load() {
        Ok(existing)
            if existing.committed.sha256 == desired_committed.sha256
                && existing.pending.as_ref().map(|value| value.sha256.as_str())
                    == desired_pending.as_ref().map(|value| value.sha256.as_str()) => {}
        Ok(_) => return Err("Boot journal already commits a different Supervisor".into()),
        Err(xmatrix_windows_continuity::ContinuityError::Io(error))
            if error.kind() == std::io::ErrorKind::NotFound =>
        {
            boot.store(&BootPayload {
                schema: JOURNAL_SCHEMA,
                revision: 1,
                phase: if desired_pending.is_some() {
                    BootPhase::Pending
                } else {
                    BootPhase::Stable
                },
                committed: desired_committed.clone(),
                previous: None,
                pending: desired_pending,
                quarantined_sha256: BTreeSet::new(),
            })?;
        }
        Err(error) => return Err(error.into()),
    }
    let activation = ActivationJournal::new(root.join("activation-journal.json"));
    match activation.load() {
        Ok(existing) if existing.committed.sha256 == daemon.sha256 => {}
        Ok(_) => return Err("Activation journal already commits a different daemon".into()),
        Err(xmatrix_windows_continuity::ContinuityError::Io(error))
            if error.kind() == std::io::ErrorKind::NotFound =>
        {
            let transaction = migration_transaction.clone().map(|id| {
                xmatrix_windows_continuity::ActivationTransaction {
                    id,
                    nonce: migration_nonce.expect("validated migration nonce"),
                    kind: xmatrix_windows_continuity::TransactionKind::CrashRecovery,
                    phase: xmatrix_windows_continuity::ActivationPhase::Recovering,
                    source_sha256: daemon.sha256.clone(),
                    target_sha256: daemon.sha256.clone(),
                    run_set_digest: None,
                    hub_receipt_ids: std::collections::BTreeMap::new(),
                    attempt: 1,
                    source_hub_epoch: migration_source_epoch,
                }
            });
            activation.store(&JournalPayload {
                schema: JOURNAL_SCHEMA,
                revision: 1,
                generation_pins: BTreeSet::from([daemon.generation.clone()]),
                committed: daemon,
                previous: None,
                candidate: None,
                transaction,
                quarantined_sha256: BTreeSet::new(),
                last_hub_epoch: migration_source_epoch,
            })?;
        }
        Err(error) => return Err(error.into()),
    }
    xmatrix_windows_continuity::ContinuityEventLog::new(root.join("continuity-events.json"))
        .append(
            "bootstrap",
            "continuity_initialized",
            event_transaction_id.as_deref(),
            Some(&event_daemon_sha256),
            Some(if event_transaction_id.is_some() {
                "recovering"
            } else {
                "stable"
            }),
            None,
        )?;
    Ok(())
}

#[cfg(windows)]
use xmatrix_windows_continuity::required_process_argument as required_value;

#[cfg(windows)]
fn optional_value(flag: &str) -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(value) = args.next() {
        if value == flag {
            return args.next();
        }
    }
    None
}

#[cfg(windows)]
fn required_path(flag: &str) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    Ok(required_value(flag)?.into())
}
