#[cfg(windows)]
pub(crate) fn run_main() {
    if let Err(error) = run() {
        eprintln!("xMatrix Supervisor failed closed: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
pub(crate) fn run_main() {
    eprintln!("xmatrix-supervisor is a Windows-only artifact");
    std::process::exit(2);
}

#[cfg(windows)]
fn run() -> Result<(), Box<dyn std::error::Error>> {
    use fs2::FileExt as _;
    use std::collections::VecDeque;
    use std::io::Write as _;
    use std::os::windows::process::CommandExt as _;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    use xmatrix_windows_continuity::{
        ActivationJournal, ActivationKernel, ContinuityEventLog, ControlMessage,
        InheritedControlPipe, KernelEvent, ReplayGuard, SUPERVISOR_PROTOCOL_MAJOR,
        connect_inherited_control_pipe, current_unix_time, verify_signed_artifact,
    };

    const RESTART_LIMIT: usize = 5;
    const RESTART_WINDOW: Duration = Duration::from_secs(120);
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let root = required_path("--daemon-root")?;
    let hub_url = required_value("--hub-url")?;
    let bootstrap_nonce = std::env::var("XMATRIX_SUPERVISOR_TRANSACTION_NONCE")?;
    let boot_pending = std::env::var("XMATRIX_SUPERVISOR_BOOT_PENDING")
        .ok()
        .as_deref()
        == Some("1");
    let mut bootstrap_control = connect_inherited_control_pipe()?;
    bootstrap_control.send(&ControlMessage::Hello {
        protocol_major: SUPERVISOR_PROTOCOL_MAJOR,
        nonce: bootstrap_nonce.clone(),
    })?;

    std::fs::create_dir_all(&root)?;
    let lock_path = root.join("supervisor.lock");
    let mut lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)?;
    lock.try_lock_exclusive()?;
    lock.set_len(0)?;
    writeln!(lock, "pid={}", std::process::id())?;
    writeln!(lock, "kind={}", env!("CARGO_BIN_NAME"))?;
    lock.sync_all()?;

    let journal = ActivationJournal::new(root.join("activation-journal.json"));
    let events = ContinuityEventLog::new(root.join("continuity-events.json"));
    let mut kernel = ActivationKernel::new(journal.load()?)?;
    if boot_pending {
        bootstrap_control.send(&ControlMessage::BootPreflightReady {
            nonce: bootstrap_nonce.clone(),
        })?;
        match bootstrap_control.receive()? {
            ControlMessage::BootCommitGranted { nonce } if nonce == bootstrap_nonce => {}
            _ => return Err("Boot Verifier did not grant this pending Supervisor".into()),
        }
    }
    let mut restarts = VecDeque::new();
    let mut boot_stable_reported = false;
    loop {
        if matches!(
            kernel
                .payload()
                .transaction
                .as_ref()
                .map(|value| value.phase),
            Some(xmatrix_windows_continuity::ActivationPhase::Degraded)
        ) {
            kernel.apply(KernelEvent::BeginRecovery)?;
            journal.store(kernel.payload())?;
        }
        if matches!(
            kernel
                .payload()
                .transaction
                .as_ref()
                .map(|value| value.phase),
            Some(xmatrix_windows_continuity::ActivationPhase::OldExited)
        ) {
            kernel.apply(KernelEvent::BeginRecovery)?;
            journal.store(kernel.payload())?;
        }
        if kernel.payload().transaction.is_none()
            && let Some(source_hub_epoch) = kernel.payload().last_hub_epoch
        {
            kernel.apply(KernelEvent::BeginCrashRecovery {
                transaction_id: uuid::Uuid::new_v4().to_string(),
                nonce: uuid::Uuid::new_v4().simple().to_string(),
                source_hub_epoch,
            })?;
            journal.store(kernel.payload())?;
        }

        let selected = match kernel
            .payload()
            .transaction
            .as_ref()
            .map(|value| value.phase)
        {
            Some(
                xmatrix_windows_continuity::ActivationPhase::CandidateStaged
                | xmatrix_windows_continuity::ActivationPhase::PreflightPassed
                | xmatrix_windows_continuity::ActivationPhase::Draining
                | xmatrix_windows_continuity::ActivationPhase::OldExited
                | xmatrix_windows_continuity::ActivationPhase::Recovering
                | xmatrix_windows_continuity::ActivationPhase::ActivationPrepared,
            ) => kernel
                .payload()
                .candidate
                .clone()
                .unwrap_or_else(|| kernel.payload().committed.clone()),
            _ => kernel.payload().committed.clone(),
        };
        let executable = std::fs::canonicalize(&selected.executable_path)?;
        let release_envelope = std::fs::canonicalize(&selected.release_envelope_path)?;
        let canonical_root = std::fs::canonicalize(&root)?;
        if !executable.starts_with(&canonical_root)
            || !release_envelope.starts_with(&canonical_root)
        {
            return Err("committed daemon or envelope escaped its managed root".into());
        }
        let is_candidate = selected.sha256 != kernel.payload().committed.sha256;
        let is_exact_rollback = kernel.payload().transaction.as_ref().is_some_and(|value| {
            value.kind == xmatrix_windows_continuity::TransactionKind::Rollback
        });
        verify_signed_artifact(
            &selected,
            current_unix_time()?,
            if is_exact_rollback {
                selected.release_sequence
            } else {
                kernel.payload().committed.release_sequence
            },
            Some(&kernel.payload().committed.publisher_sha256),
            !is_candidate || is_exact_rollback,
        )?;
        let transaction = kernel.payload().transaction.clone();
        events.append(
            "supervisor",
            "daemon_starting",
            transaction.as_ref().map(|value| value.id.as_str()),
            Some(&selected.sha256),
            transaction
                .as_ref()
                .map(|value| activation_phase_label(value.phase))
                .or(Some("stable")),
            None,
        )?;
        let control_nonce = transaction
            .as_ref()
            .map(|value| value.nonce.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
        let mut daemon_control = InheritedControlPipe::create()?;
        let mut command = std::process::Command::new(&executable);
        command
            .arg("daemon")
            .env("XMATRIX_SUPERVISOR_PARENT", "1")
            .env("XMATRIX_HUB_URL", &hub_url)
            .env("XMATRIX_SUPERVISOR_TRANSACTION_NONCE", &control_nonce)
            .env_remove("XMATRIX_ENVIRONMENT")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(transaction) = transaction.as_ref() {
            let source_epoch = transaction
                .source_hub_epoch
                .or(kernel.payload().last_hub_epoch)
                .ok_or("activation transaction has no source Hub epoch")?;
            command
                .env("XMATRIX_DAEMON_ACTIVATION_TRANSACTION_ID", &transaction.id)
                .env(
                    "XMATRIX_DAEMON_ACTIVATION_MODE",
                    if transaction.kind == xmatrix_windows_continuity::TransactionKind::Rollback {
                        "rollback"
                    } else {
                        "recovering"
                    },
                )
                .env(
                    "XMATRIX_DAEMON_ACTIVATION_ARTIFACT_SHA256",
                    &transaction.target_sha256,
                )
                .env(
                    "XMATRIX_DAEMON_ACTIVATION_SOURCE_EPOCH",
                    source_epoch.to_string(),
                );
        }
        daemon_control.child_handles()?.apply(&mut command);
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = command.spawn()?;
        daemon_control.release_child_handles();
        match daemon_control.receive()? {
            ControlMessage::Hello {
                protocol_major,
                nonce,
            } if protocol_major == SUPERVISOR_PROTOCOL_MAJOR && nonce == control_nonce => {}
            _ => return Err("daemon inherited-pipe handshake failed".into()),
        }

        let mut receive_guard = ReplayGuard::new(control_nonce.clone())?;
        let mut send_sequence = 1u64;
        let activation_result = if transaction.is_some() {
            supervise_activation(
                &journal,
                &mut kernel,
                &mut daemon_control,
                &mut receive_guard,
                &mut send_sequence,
                &control_nonce,
                &events,
            )
        } else {
            (|| -> Result<(), Box<dyn std::error::Error>> {
                let message = receive_authenticated(&mut daemon_control, &mut receive_guard)?;
                let ControlMessage::StableReady { hub_epoch } = message else {
                    return Err("stable daemon omitted its exact Hub epoch".into());
                };
                kernel.apply(KernelEvent::RecordStableEpoch(hub_epoch))?;
                journal.store(kernel.payload())?;
                Ok(())
            })()
        };
        if activation_result.is_ok() && kernel.payload().transaction.is_none() {
            gc_unpinned_generations(&root, kernel.payload())?;
        }
        if boot_pending && !boot_stable_reported && activation_result.is_ok() {
            bootstrap_control.send(&ControlMessage::BootStable {
                nonce: bootstrap_nonce.clone(),
            })?;
            boot_stable_reported = true;
        }
        let handoff = if activation_result.is_ok() && kernel.payload().transaction.is_none() {
            supervise_stable_daemon(
                &root,
                &journal,
                &mut kernel,
                &mut daemon_control,
                &mut receive_guard,
                &mut send_sequence,
                &control_nonce,
                &events,
            )
        } else {
            Ok(false)
        };
        let status = child.wait()?;
        events.append(
            "supervisor",
            "daemon_exited",
            kernel
                .payload()
                .transaction
                .as_ref()
                .map(|value| value.id.as_str()),
            Some(&selected.sha256),
            kernel
                .payload()
                .transaction
                .as_ref()
                .map(|value| activation_phase_label(value.phase))
                .or(Some("stable")),
            Some(if status.success() {
                "success"
            } else {
                "failure"
            }),
        )?;
        if matches!(handoff, Ok(true)) && status.success() {
            kernel.apply(KernelEvent::OldExited)?;
            journal.store(kernel.payload())?;
            continue;
        }
        if status.success() && activation_result.is_ok() {
            return Ok(());
        }
        if let Err(error) = activation_result {
            eprintln!("xMatrix daemon activation remained fail-closed: {error}");
            if let Some(transaction) = kernel.payload().transaction.clone()
                && transaction.kind == xmatrix_windows_continuity::TransactionKind::Update
            {
                let source_hub_epoch = transaction
                    .source_hub_epoch
                    .ok_or("failed update has no source Hub epoch")?
                    .saturating_add(u64::from(matches!(
                        transaction.phase,
                        xmatrix_windows_continuity::ActivationPhase::ActiveFenced
                            | xmatrix_windows_continuity::ActivationPhase::Probation
                            | xmatrix_windows_continuity::ActivationPhase::HubActive
                            | xmatrix_windows_continuity::ActivationPhase::StablePersisted
                            | xmatrix_windows_continuity::ActivationPhase::StableGranted
                    )));
                let rollback = if transaction.target_sha256 == kernel.payload().committed.sha256 {
                    kernel
                        .payload()
                        .previous
                        .clone()
                        .ok_or("failed committed candidate has no previous LKG")?
                } else {
                    kernel.payload().committed.clone()
                };
                kernel.apply(KernelEvent::BeginRollback {
                    transaction_id: uuid::Uuid::new_v4().to_string(),
                    nonce: uuid::Uuid::new_v4().simple().to_string(),
                    source_hub_epoch,
                    artifact: rollback,
                })?;
                journal.store(kernel.payload())?;
                append_kernel_event(
                    &events,
                    &kernel,
                    "rollback_started",
                    "recovering",
                    Some("candidate_failed"),
                )?;
                restarts.clear();
                continue;
            }
        }
        let now = Instant::now();
        while restarts
            .front()
            .is_some_and(|value| now.duration_since(*value) >= RESTART_WINDOW)
        {
            restarts.pop_front();
        }
        if restarts.len() >= RESTART_LIMIT {
            let wait = restarts
                .front()
                .map(|oldest| RESTART_WINDOW.saturating_sub(now.duration_since(*oldest)))
                .unwrap_or(RESTART_WINDOW)
                .max(Duration::from_secs(1));
            std::thread::sleep(wait);
            continue;
        }
        restarts.push_back(now);
        let shift = restarts.len().saturating_sub(1).min(4) as u32;
        std::thread::sleep(Duration::from_millis(250u64 << shift));
    }
}

#[cfg(windows)]
fn gc_unpinned_generations(
    root: &std::path::Path,
    payload: &xmatrix_windows_continuity::JournalPayload,
) -> Result<(), Box<dyn std::error::Error>> {
    let generations = root.join("generations");
    let canonical = match std::fs::canonicalize(&generations) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let pins = payload.pinned_generations();
    let mut removed = 0usize;
    for entry in std::fs::read_dir(&canonical)? {
        if removed >= 8 {
            break;
        }
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if pins.contains(&name)
            || name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .all(|value| value.is_ascii_alphanumeric() || b"._-".contains(&value))
        {
            continue;
        }
        let metadata = std::fs::symlink_metadata(entry.path())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        let target = std::fs::canonicalize(entry.path())?;
        if target.parent() != Some(canonical.as_path()) {
            continue;
        }
        std::fs::remove_dir_all(target)?;
        removed += 1;
    }
    Ok(())
}

#[cfg(windows)]
fn supervise_activation(
    journal: &xmatrix_windows_continuity::ActivationJournal,
    kernel: &mut xmatrix_windows_continuity::ActivationKernel,
    control: &mut xmatrix_windows_continuity::InheritedControlPipe,
    receive_guard: &mut xmatrix_windows_continuity::ReplayGuard,
    send_sequence: &mut u64,
    nonce: &str,
    events: &xmatrix_windows_continuity::ContinuityEventLog,
) -> Result<(), Box<dyn std::error::Error>> {
    use xmatrix_windows_continuity::{ActivationPhase, ControlMessage, KernelEvent};

    loop {
        let message = receive_authenticated(control, receive_guard)?;
        match message {
            ControlMessage::HubActivationReceipt {
                transaction_id,
                nonce: receipt_nonce,
                hub_epoch,
                phase,
                receipt_id,
                run_set_digest,
                prepared_receipt_id,
                active_fenced_receipt_id,
                active_receipt_id,
            } => {
                let transaction = kernel
                    .payload()
                    .transaction
                    .as_ref()
                    .ok_or("Supervisor activation transaction disappeared")?;
                if transaction.id != transaction_id
                    || transaction.nonce != receipt_nonce
                    || transaction.nonce != nonce
                    || hub_epoch == 0
                    || receipt_id.trim().is_empty()
                {
                    return Err(
                        "Hub receipt does not match the exact Supervisor transaction".into(),
                    );
                }
                match phase.as_str() {
                    "activation_prepared" => {
                        ensure_activation_prepared(
                            journal,
                            kernel,
                            &receipt_id,
                            run_set_digest.as_deref(),
                        )?;
                        ensure_local_committed(journal, kernel)?;
                        send_authenticated(
                            control,
                            send_sequence,
                            nonce,
                            ControlMessage::LocalCommitted {
                                transaction_id: transaction_id.clone(),
                                nonce: receipt_nonce,
                            },
                        )?;
                        events.append(
                            "supervisor",
                            "activation_receipt",
                            Some(&transaction_id),
                            kernel
                                .payload()
                                .candidate
                                .as_ref()
                                .map(|value| value.sha256.as_str()),
                            Some("activation_prepared"),
                            None,
                        )?;
                    }
                    "active_fenced" => {
                        ensure_received_fenced_activation(
                            journal,
                            kernel,
                            prepared_receipt_id.as_deref(),
                            run_set_digest.as_deref(),
                            Some(&receipt_id),
                        )?;
                        events.append(
                            "supervisor",
                            "activation_receipt",
                            Some(&transaction_id),
                            Some(&kernel.payload().committed.sha256),
                            Some("active_fenced"),
                            None,
                        )?;
                    }
                    "active" => {
                        ensure_received_fenced_activation(
                            journal,
                            kernel,
                            prepared_receipt_id.as_deref(),
                            run_set_digest.as_deref(),
                            active_fenced_receipt_id.as_deref(),
                        )?;
                        ensure_hub_active(journal, kernel, &receipt_id)?;
                        ensure_stable_persisted(journal, kernel)?;
                        send_authenticated(
                            control,
                            send_sequence,
                            nonce,
                            ControlMessage::StableGranted {
                                transaction_id: transaction_id.clone(),
                                nonce: receipt_nonce,
                            },
                        )?;
                        events.append(
                            "supervisor",
                            "stable_persisted",
                            Some(&transaction_id),
                            Some(&kernel.payload().committed.sha256),
                            Some("stable_persisted"),
                            None,
                        )?;
                    }
                    "stable_granted" => {
                        ensure_received_fenced_activation(
                            journal,
                            kernel,
                            prepared_receipt_id.as_deref(),
                            run_set_digest.as_deref(),
                            active_fenced_receipt_id.as_deref(),
                        )?;
                        ensure_hub_active(
                            journal,
                            kernel,
                            active_receipt_id
                                .as_deref()
                                .ok_or("Hub receipt omitted Active history")?,
                        )?;
                        ensure_stable_persisted(journal, kernel)?;
                        if activation_phase(kernel) == ActivationPhase::StablePersisted {
                            kernel.apply(KernelEvent::StableGranted)?;
                            journal.store(kernel.payload())?;
                        }
                        if activation_phase(kernel) == ActivationPhase::StableGranted {
                            kernel.apply(KernelEvent::CompleteStable { hub_epoch })?;
                            journal.store(kernel.payload())?;
                        }
                        events.append(
                            "supervisor",
                            "stable_granted",
                            Some(&transaction_id),
                            Some(&kernel.payload().committed.sha256),
                            Some("stable"),
                            None,
                        )?;
                        return Ok(());
                    }
                    other => return Err(format!("unexpected Hub activation phase {other}").into()),
                }
            }
            ControlMessage::FailClosed {
                transaction_id,
                reason,
            } => {
                if transaction_id.as_deref()
                    != kernel
                        .payload()
                        .transaction
                        .as_ref()
                        .map(|value| value.id.as_str())
                {
                    return Err("fail-closed transaction identity mismatch".into());
                }
                if matches!(
                    kernel
                        .payload()
                        .transaction
                        .as_ref()
                        .map(|value| value.phase),
                    Some(ActivationPhase::Recovering | ActivationPhase::ActivationPrepared)
                ) {
                    if kernel
                        .payload()
                        .transaction
                        .as_ref()
                        .is_some_and(|transaction| {
                            transaction.kind == xmatrix_windows_continuity::TransactionKind::Update
                        })
                    {
                        kernel.apply(KernelEvent::AbortBeforeCommit)?;
                    } else {
                        kernel.apply(KernelEvent::Degrade)?;
                    }
                    journal.store(kernel.payload())?;
                }
                return Err(format!("daemon entered fail-closed recovery: {reason}").into());
            }
            _ => return Err("unexpected daemon activation control message".into()),
        }
    }
}

#[cfg(windows)]
fn supervise_stable_daemon(
    root: &std::path::Path,
    journal: &xmatrix_windows_continuity::ActivationJournal,
    kernel: &mut xmatrix_windows_continuity::ActivationKernel,
    control: &mut xmatrix_windows_continuity::InheritedControlPipe,
    receive_guard: &mut xmatrix_windows_continuity::ReplayGuard,
    send_sequence: &mut u64,
    control_nonce: &str,
    events: &xmatrix_windows_continuity::ContinuityEventLog,
) -> Result<bool, Box<dyn std::error::Error>> {
    use std::os::windows::process::CommandExt as _;
    use std::process::Stdio;
    use xmatrix_windows_continuity::{
        ControlMessage, KernelEvent, TransactionKind, current_unix_time, verify_signed_artifact,
    };

    let message = receive_authenticated(control, receive_guard)?;
    let ControlMessage::StageCandidate {
        transaction_id,
        nonce,
        source_hub_epoch,
        artifact,
    } = message
    else {
        return Err("stable daemon sent an unexpected Supervisor control message".into());
    };
    if transaction_id.trim().is_empty() || nonce.len() < 32 || source_hub_epoch == 0 {
        return Err("candidate transaction identity is invalid".into());
    }
    artifact.validate()?;
    let candidate = std::fs::canonicalize(&artifact.executable_path)?;
    let release_envelope = std::fs::canonicalize(&artifact.release_envelope_path)?;
    let canonical_root = std::fs::canonicalize(root)?;
    if !candidate.starts_with(&canonical_root) || !release_envelope.starts_with(&canonical_root) {
        return Err("candidate or signed envelope escaped its managed root".into());
    }
    verify_signed_artifact(
        &artifact,
        current_unix_time()?,
        kernel.payload().committed.release_sequence,
        Some(&kernel.payload().committed.publisher_sha256),
        false,
    )?;
    kernel.apply(KernelEvent::StageCandidate {
        transaction_id: transaction_id.clone(),
        nonce: nonce.clone(),
        kind: TransactionKind::Update,
        source_hub_epoch: Some(source_hub_epoch),
        artifact,
    })?;
    journal.store(kernel.payload())?;
    events.append(
        "supervisor",
        "candidate_staged",
        Some(&transaction_id),
        kernel
            .payload()
            .candidate
            .as_ref()
            .map(|value| value.sha256.as_str()),
        Some("candidate_staged"),
        None,
    )?;

    let mut preflight = std::process::Command::new(&candidate);
    preflight
        .arg("daemon")
        .env("XMATRIX_DAEMON_PREFLIGHT", "1")
        .env_remove("XMATRIX_SUPERVISOR_CONTROL_PROTOCOL")
        .env_remove("XMATRIX_SUPERVISOR_CONTROL_READ_HANDLE")
        .env_remove("XMATRIX_SUPERVISOR_CONTROL_WRITE_HANDLE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    preflight.creation_flags(CREATE_NO_WINDOW);
    if !preflight.status()?.success() {
        kernel.apply(KernelEvent::AbortBeforeCommit)?;
        journal.store(kernel.payload())?;
        send_authenticated(
            control,
            send_sequence,
            control_nonce,
            ControlMessage::FailClosed {
                transaction_id: Some(transaction_id),
                reason: "candidate daemon preflight failed".into(),
            },
        )?;
        return supervise_stable_daemon(
            root,
            journal,
            kernel,
            control,
            receive_guard,
            send_sequence,
            control_nonce,
            events,
        );
    }
    kernel.apply(KernelEvent::PreflightPassed)?;
    journal.store(kernel.payload())?;
    kernel.apply(KernelEvent::BeginDrain)?;
    journal.store(kernel.payload())?;
    send_authenticated(
        control,
        send_sequence,
        control_nonce,
        ControlMessage::BeginDrain {
            transaction_id: transaction_id.clone(),
            nonce: nonce.clone(),
        },
    )?;
    match receive_authenticated(control, receive_guard)? {
        ControlMessage::DrainReady {
            transaction_id: received_transaction,
            nonce: received_nonce,
            run_set_digest,
            generation_pins,
        } if received_transaction == transaction_id && received_nonce == nonce => {
            kernel.apply(KernelEvent::DrainReady {
                run_set_digest,
                generation_pins,
            })?;
            journal.store(kernel.payload())?;
            events.append(
                "supervisor",
                "drain_ready",
                Some(&transaction_id),
                kernel
                    .payload()
                    .candidate
                    .as_ref()
                    .map(|value| value.sha256.as_str()),
                Some("draining"),
                None,
            )?;
        }
        ControlMessage::AbortDrain {
            transaction_id: received_transaction,
            nonce: received_nonce,
            reason: _,
        } if received_transaction == transaction_id && received_nonce == nonce => {
            kernel.apply(KernelEvent::AbortBeforeCommit)?;
            journal.store(kernel.payload())?;
            send_authenticated(
                control,
                send_sequence,
                control_nonce,
                ControlMessage::DrainAborted {
                    transaction_id,
                    nonce,
                },
            )?;
            return supervise_stable_daemon(
                root,
                journal,
                kernel,
                control,
                receive_guard,
                send_sequence,
                control_nonce,
                events,
            );
        }
        _ => return Err("daemon drain evidence does not match the candidate transaction".into()),
    }
    send_authenticated(
        control,
        send_sequence,
        control_nonce,
        ControlMessage::CommitExit {
            transaction_id,
            nonce,
        },
    )?;
    append_kernel_event(&events, &kernel, "commit_exit_granted", "draining", None)?;
    Ok(true)
}

#[cfg(windows)]
fn activation_phase_label(phase: xmatrix_windows_continuity::ActivationPhase) -> &'static str {
    use xmatrix_windows_continuity::ActivationPhase;
    match phase {
        ActivationPhase::Stable => "stable",
        ActivationPhase::CandidateStaged => "candidate_staged",
        ActivationPhase::PreflightPassed => "preflight_passed",
        ActivationPhase::Draining => "draining",
        ActivationPhase::OldExited => "old_exited",
        ActivationPhase::Recovering => "recovering",
        ActivationPhase::ActivationPrepared => "activation_prepared",
        ActivationPhase::LocalCommitted => "local_committed",
        ActivationPhase::ActiveFenced => "active_fenced",
        ActivationPhase::Probation => "probation",
        ActivationPhase::HubActive => "hub_active",
        ActivationPhase::StablePersisted => "stable_persisted",
        ActivationPhase::StableGranted => "stable_granted",
        ActivationPhase::RolledBack => "rolled_back",
        ActivationPhase::Degraded => "degraded",
    }
}

#[cfg(windows)]
fn ensure_received_fenced_activation(
    journal: &xmatrix_windows_continuity::ActivationJournal,
    kernel: &mut xmatrix_windows_continuity::ActivationKernel,
    prepared_receipt_id: Option<&str>,
    run_set_digest: Option<&str>,
    fenced_receipt_id: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    ensure_activation_prepared(
        journal,
        kernel,
        prepared_receipt_id.ok_or("Hub receipt omitted ActivationPrepared history")?,
        run_set_digest,
    )?;
    ensure_local_committed(journal, kernel)?;
    ensure_active_fenced(
        journal,
        kernel,
        fenced_receipt_id.ok_or("Hub receipt omitted ActiveFenced history")?,
    )?;
    ensure_probation(journal, kernel)
}

#[cfg(windows)]
fn ensure_activation_prepared(
    journal: &xmatrix_windows_continuity::ActivationJournal,
    kernel: &mut xmatrix_windows_continuity::ActivationKernel,
    receipt_id: &str,
    run_set_digest: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    if activation_phase(kernel) == xmatrix_windows_continuity::ActivationPhase::Recovering {
        kernel.apply(
            xmatrix_windows_continuity::KernelEvent::ActivationPrepared {
                receipt_id: receipt_id.to_string(),
                run_set_digest: run_set_digest
                    .ok_or("Hub receipt omitted the Run-set digest")?
                    .to_string(),
            },
        )?;
        journal.store(kernel.payload())?;
    }
    Ok(())
}

#[cfg(windows)]
fn ensure_local_committed(
    journal: &xmatrix_windows_continuity::ActivationJournal,
    kernel: &mut xmatrix_windows_continuity::ActivationKernel,
) -> Result<(), Box<dyn std::error::Error>> {
    if activation_phase(kernel) == xmatrix_windows_continuity::ActivationPhase::ActivationPrepared {
        kernel.apply(xmatrix_windows_continuity::KernelEvent::LocalCommit)?;
        journal.store(kernel.payload())?;
    }
    Ok(())
}

#[cfg(windows)]
fn ensure_active_fenced(
    journal: &xmatrix_windows_continuity::ActivationJournal,
    kernel: &mut xmatrix_windows_continuity::ActivationKernel,
    receipt_id: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if activation_phase(kernel) == xmatrix_windows_continuity::ActivationPhase::LocalCommitted {
        kernel.apply(xmatrix_windows_continuity::KernelEvent::ActiveFenced {
            receipt_id: receipt_id.to_string(),
        })?;
        journal.store(kernel.payload())?;
    }
    Ok(())
}

#[cfg(windows)]
fn ensure_probation(
    journal: &xmatrix_windows_continuity::ActivationJournal,
    kernel: &mut xmatrix_windows_continuity::ActivationKernel,
) -> Result<(), Box<dyn std::error::Error>> {
    if activation_phase(kernel) == xmatrix_windows_continuity::ActivationPhase::ActiveFenced {
        kernel.apply(xmatrix_windows_continuity::KernelEvent::BeginProbation)?;
        journal.store(kernel.payload())?;
    }
    Ok(())
}

#[cfg(windows)]
fn ensure_hub_active(
    journal: &xmatrix_windows_continuity::ActivationJournal,
    kernel: &mut xmatrix_windows_continuity::ActivationKernel,
    receipt_id: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if activation_phase(kernel) == xmatrix_windows_continuity::ActivationPhase::Probation {
        kernel.apply(xmatrix_windows_continuity::KernelEvent::HubActive {
            receipt_id: receipt_id.to_string(),
        })?;
        journal.store(kernel.payload())?;
    }
    Ok(())
}

#[cfg(windows)]
fn ensure_stable_persisted(
    journal: &xmatrix_windows_continuity::ActivationJournal,
    kernel: &mut xmatrix_windows_continuity::ActivationKernel,
) -> Result<(), Box<dyn std::error::Error>> {
    if activation_phase(kernel) == xmatrix_windows_continuity::ActivationPhase::HubActive {
        kernel.apply(xmatrix_windows_continuity::KernelEvent::PersistStable)?;
        journal.store(kernel.payload())?;
    }
    Ok(())
}

#[cfg(windows)]
fn activation_phase(
    kernel: &xmatrix_windows_continuity::ActivationKernel,
) -> xmatrix_windows_continuity::ActivationPhase {
    kernel
        .payload()
        .transaction
        .as_ref()
        .expect("activation transaction")
        .phase
}

#[cfg(windows)]
fn receive_authenticated(
    control: &mut xmatrix_windows_continuity::InheritedControlPipe,
    guard: &mut xmatrix_windows_continuity::ReplayGuard,
) -> Result<xmatrix_windows_continuity::ControlMessage, Box<dyn std::error::Error>> {
    let frame = control.receive_authenticated()?;
    guard.validate(&frame)?;
    Ok(frame.message)
}

#[cfg(windows)]
fn send_authenticated(
    control: &mut xmatrix_windows_continuity::InheritedControlPipe,
    sequence: &mut u64,
    nonce: &str,
    message: xmatrix_windows_continuity::ControlMessage,
) -> Result<(), Box<dyn std::error::Error>> {
    let frame = xmatrix_windows_continuity::AuthenticatedControlFrame {
        protocol_major: xmatrix_windows_continuity::SUPERVISOR_PROTOCOL_MAJOR,
        sequence: *sequence,
        nonce: nonce.to_string(),
        message,
    };
    control.send_authenticated(&frame)?;
    *sequence = sequence.saturating_add(1);
    Ok(())
}

#[cfg(windows)]
use xmatrix_windows_continuity::required_process_argument as required_value;

#[cfg(windows)]
fn required_path(flag: &str) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    Ok(required_value(flag)?.into())
}

#[cfg(windows)]
fn append_kernel_event(
    events: &xmatrix_windows_continuity::ContinuityEventLog,
    kernel: &xmatrix_windows_continuity::ActivationKernel,
    kind: &str,
    phase: &str,
    detail: Option<&str>,
) -> Result<(), xmatrix_windows_continuity::ContinuityError> {
    events
        .append(
            "supervisor",
            kind,
            kernel
                .payload()
                .transaction
                .as_ref()
                .map(|value| value.id.as_str()),
            kernel
                .payload()
                .candidate
                .as_ref()
                .map(|value| value.sha256.as_str()),
            Some(phase),
            detail,
        )
        .map(|_| ())
}
