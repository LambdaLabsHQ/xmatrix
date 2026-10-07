impl DaemonRunChild {
    fn terminate_tree(&mut self) -> Result<(), String> {
        if let Some(process_tree) = self.process_tree.as_mut() {
            process_tree.terminate().map_err(|error| error.to_string())
        } else {
            terminate_daemon_pid(self.pid).map_err(|error| error.to_string())
        }
    }
}

/// The exit record for a daemon child that is done, however it ended.
///
/// A child that exited and a child whose status check failed produce the same
/// record from the same marker; only `status` and `exit_code` differ. Written
/// out twice, the two copies were kept apart only by their line breaks — once
/// the tree was formatted they became a literal 29-line clone.
fn finished_daemon_run(
    key: &str,
    managed: &DaemonRunChild,
    run_status: Option<&DaemonRunStatusMarker>,
    status: String,
    exit_code: Option<i32>,
    repo_pool_authority: Option<DaemonRepoPoolRunAuthority>,
) -> DaemonRunExit {
    DaemonRunExit {
        wrapper_version: run_status.and_then(|marker| marker.wrapper_version.clone()),
        startup_steps: daemon_marker_startup_steps(run_status, managed.pid),
        task_execution: run_status.and_then(|marker| marker.task_execution.clone()),
        operation_failure: run_status.and_then(|marker| marker.operation_failure.clone()),
        connection_retry: run_status.and_then(|marker| marker.connection_retry.clone()),
        wrapper_ready_at_millis: run_status.and_then(|marker| marker.wrapper_ready_at_millis),
        registry_key: Some(key.to_string()),
        run_id: managed.run_id.clone(),
        execution_key: managed.execution_key.clone(),
        agent_id: managed.agent_id.clone(),
        agent_name: managed.agent_name.clone(),
        pid: managed.pid,
        status,
        exit_code,
        status_phase: run_status.map(|marker| marker.phase.clone()),
        run_status_detail: daemon_run_exit_detail(run_status, exit_code),
        completed: run_status.map(|marker| marker.completed),
        delivered: run_status.map(|marker| marker.delivered),
        status_file_path: managed.status_file_path.clone(),
        stdout_log_path: managed
            .stdout_log_path
            .as_ref()
            .map(|path| path.display().to_string()),
        stderr_log_path: managed
            .stderr_log_path
            .as_ref()
            .map(|path| path.display().to_string()),
        repo_pool_authority,
        rest_reason: daemon_marker_rest_reason(run_status),
    }
}

/// Append an ended Run's wake metrics (docs/instance-sleep.md §8). A Run
/// whose wrapper recorded none (an older wrapper, or no provider output yet)
/// leaves no record.
fn record_daemon_run_wake_metrics(
    key: &str,
    managed: &DaemonRunChild,
    marker: Option<&DaemonRunStatusMarker>,
    end: &str,
) {
    let Some(wake) = marker.and_then(|marker| marker.wake.as_ref()) else {
        return;
    };
    let path = runtime_wake_metrics::metrics_path(&daemon_run_state_root());
    let run = runtime_wake_metrics::EndedRun {
        registry_key: key,
        pid: managed.pid,
        resume_session_key: managed.resume_session_key.as_deref(),
        end,
        wake,
    };
    if let Err(error) = runtime_wake_metrics::append_ended_run(
        &path,
        &run,
        unix_millis_now(),
        runtime_wake_metrics::METRICS_FILE_MAX_BYTES,
    ) {
        append_daemon_registry_audit(&format!(
            "wake_metrics_append_failed key={key} pid={} error={error}",
            managed.pid
        ));
    }
}

async fn collect_finished_daemon_children(registry: &DaemonRunRegistry) -> Vec<DaemonRunExit> {
    let mut guard = registry.lock().await;
    let mut finished = Vec::new();
    #[cfg(windows)]
    let mut handoff_changed = false;
    for (key, managed) in guard.iter_mut() {
        if managed.stop_in_progress {
            continue;
        }
        // A candidate's startup failure is not the Run's terminal outcome.
        #[cfg(windows)]
        if managed.handoff.is_some() {
            if let Err(error) = reconcile_windows_run_handoff(managed) {
                append_daemon_registry_audit(&format!(
                    "handoff_reconcile_failed key={key} error={error}"
                ));
            }
            handoff_changed |= managed.handoff.is_none();
            persist_daemon_run_sidecar(&persisted_daemon_run_from_child(managed));
            continue;
        }
        let status = if let Some(child) = managed.child.as_mut() {
            child
                .try_wait()
                .map(|status| status.map(|status| (status.to_string(), status.code(), true)))
        } else if crate::process_tree::process_alive(managed.pid) {
            Ok(None)
        } else {
            Ok(Some(("process no longer exists".to_string(), None, false)))
        };
        match status {
            Ok(Some((status, exit_code, _child_handle_observed_exit))) => {
                // A wrapper may finish while provider helpers it launched remain
                // alive. Freshly spawned rows retain a daemon-owned Job/process
                // group, so close that exact handle before reporting the slot as
                // retained. Rehydrated rows cannot recover the handle and use the
                // conservative PID-tree fallback instead.
                let cleanup = managed.terminate_tree();
                if let Err(err) = cleanup {
                    append_daemon_registry_audit(&format!(
                        "exit_cleanup_failed key={key} pid={} run={} error={err}",
                        managed.pid,
                        managed.run_id.as_deref().unwrap_or("unknown")
                    ));
                    eprintln!(
                        "{} daemon child pid {} exited, but its process tree cleanup failed: {err}",
                        "⚠".yellow().bold(),
                        managed.pid
                    );
                    continue;
                }
                let run_status = read_daemon_run_status_marker(managed.status_file_path.as_deref())
                    .filter(|marker| marker.pid == managed.pid);
                // The row stays until Hub acknowledges the exit report, so a
                // later sweep sees the same exit again; record it only once.
                if !managed.exit_audited {
                    managed.exit_audited = true;
                    let end = if run_status.as_ref().is_some_and(|marker| {
                        marker.phase == runtime_daemon_idle_sleep::SLEEPING_PHASE
                    }) {
                        "sleeping"
                    } else {
                        "exited"
                    };
                    record_daemon_run_wake_metrics(key, managed, run_status.as_ref(), end);
                    append_daemon_registry_audit(&format!(
                        "child_exit_detected key={key} pid={} run={} status={status} tree_cleanup=completed",
                        managed.pid,
                        managed.run_id.as_deref().unwrap_or("unknown")
                    ));
                    eprintln!(
                        "{} daemon child pid {} exited with {status}",
                        "○".cyan().bold(),
                        managed.pid
                    );
                }
                let repo_pool_authority = match daemon_repo_pool_run_authority(managed) {
                    Ok(authority) => authority,
                    Err(error) => {
                        append_daemon_registry_audit(&format!(
                            "exit_pool_authority_invalid key={key} pid={} error={error}",
                            managed.pid
                        ));
                        continue;
                    }
                };
                finished.push(finished_daemon_run(
                    key,
                    managed,
                    run_status.as_ref(),
                    status,
                    exit_code,
                    repo_pool_authority,
                ));
            }
            Ok(None) => {}
            Err(err) => {
                let cleanup = managed.terminate_tree();
                if let Err(cleanup_err) = cleanup {
                    append_daemon_registry_audit(&format!(
                        "status_check_cleanup_failed key={key} pid={} run={} status_error={err} cleanup_error={cleanup_err}",
                        managed.pid,
                        managed.run_id.as_deref().unwrap_or("unknown")
                    ));
                    eprintln!(
                        "{} daemon child pid {} status check failed ({err}), and its process tree cleanup failed: {cleanup_err}",
                        "⚠".yellow().bold(),
                        managed.pid
                    );
                    continue;
                }
                let run_status = read_daemon_run_status_marker(managed.status_file_path.as_deref())
                    .filter(|marker| marker.pid == managed.pid);
                append_daemon_registry_audit(&format!(
                    "child_status_check_failed key={key} pid={} run={} error={err} tree_cleanup=completed",
                    managed.pid,
                    managed.run_id.as_deref().unwrap_or("unknown")
                ));
                eprintln!(
                    "{} daemon child pid {} status check failed: {err}",
                    "⚠".yellow().bold(),
                    managed.pid
                );
                let repo_pool_authority = match daemon_repo_pool_run_authority(managed) {
                    Ok(authority) => authority,
                    Err(authority_error) => {
                        append_daemon_registry_audit(&format!(
                            "status_check_pool_authority_invalid key={key} pid={} error={authority_error}",
                            managed.pid
                        ));
                        continue;
                    }
                };
                finished.push(finished_daemon_run(
                    key,
                    managed,
                    run_status.as_ref(),
                    format!("status check failed: {err}"),
                    None,
                    repo_pool_authority,
                ));
            }
        }
    }
    #[cfg(windows)]
    if handoff_changed {
        persist_daemon_run_registry_locked(&guard);
    }
    finished
}

/// Registry half of a live-update pid rebind: repoints the exact managed row
/// for (run, execution key) at the replacement wrapper pid, keeping the row —
/// and therefore its auth/request capability grants — alive across the
/// handoff. Returns the old pid and any retained child handle the caller must
/// reap off-loop so the exiting old wrapper cannot zombie.
fn rebind_managed_daemon_run_pid(
    guard: &mut HashMap<String, DaemonRunChild>,
    run_id: &str,
    execution_key: &str,
    new_pid: u32,
) -> Result<(String, u32, Option<std::process::Child>), String> {
    let Some((key, managed)) = guard.iter_mut().find(|(_, managed)| {
        managed.run_id.as_deref() == Some(run_id)
            && managed.execution_key.as_deref() == Some(execution_key)
    }) else {
        return Err("run is not registered with this daemon".to_string());
    };
    if managed.stop_in_progress {
        return Err("run stop is in progress; refusing to rebind".to_string());
    }
    #[cfg(windows)]
    if let Some(handoff) = managed.handoff.as_ref() {
        if new_pid != handoff.previous_pid || !handoff.previous_is_alive() {
            return Err("run handoff is in progress; refusing unrelated rebind".into());
        }
        let candidate_pid = managed.pid;
        rollback_windows_run_handoff(managed).map_err(|error| error.to_string())?;
        return Ok((key.clone(), candidate_pid, None));
    }
    let old_pid = managed.pid;
    if old_pid == new_pid {
        return Ok((key.clone(), old_pid, None));
    }
    let retained_child = managed.child.take();
    managed.pid = new_pid;
    Ok((key.clone(), old_pid, retained_child))
}

/// Handles a `POST /request/rebind-run` from a run's own shell during a live
/// self-update: the caller authenticates with the run's request capability and
/// must name the exact run/execution key that capability was granted for, so
/// a run can rebind only itself. The old wrapper is still alive at this point;
/// after the rebind it may exit without the exit monitor terminalizing the
/// run, which is what preserves run-scoped CLI authority for the replacement.
fn require_calling_run_grant(
    context: &DaemonRequestAgentContext,
    run_id: &str,
    execution_key: &str,
    operation: &str,
) -> error::Result<()> {
    if context.run_id.as_deref() != Some(run_id)
        || context.execution_key.as_deref() != Some(execution_key)
    {
        return Err(CliError::Launch(format!(
            "{operation} target does not match the calling run's grant"
        )));
    }
    Ok(())
}

async fn rebind_daemon_run_pid(
    broker: &DaemonRequestBroker,
    context: &DaemonRequestAgentContext,
    payload: &DaemonRunRebindPayload,
) -> error::Result<String> {
    require_calling_run_grant(context, &payload.run_id, &payload.execution_key, "rebind")?;
    if !process_tree::process_alive(payload.new_pid) {
        return Err(CliError::Launch(format!(
            "replacement pid {} is not alive",
            payload.new_pid
        )));
    }
    let mut guard = broker.run_registry.lock().await;
    let (key, old_pid, retained_child) = rebind_managed_daemon_run_pid(
        &mut guard,
        &payload.run_id,
        &payload.execution_key,
        payload.new_pid,
    )
    .map_err(CliError::Launch)?;
    if let Some(mut child) = retained_child {
        // The old wrapper exits shortly after this call returns; reap the
        // retained handle off-loop so it cannot linger as a zombie.
        tokio::task::spawn_blocking(move || {
            let _ = child.wait();
        });
    }
    if let Some(managed) = guard.get(&key) {
        let run = persisted_daemon_run_from_child(managed);
        persist_daemon_run_sidecar(&run);
    }
    persist_daemon_run_registry_locked(&guard);
    append_daemon_registry_audit(&format!(
        "rebound key={key} run={} old_pid={old_pid} new_pid={} reason=live_update",
        payload.run_id, payload.new_pid
    ));
    Ok(serde_json::json!({
        "rebound": true,
        "oldPid": old_pid,
        "newPid": payload.new_pid,
    })
    .to_string())
}

/// Owned by the exact Run row, so exit monitoring, stop and rollback share
/// one transaction. Both process trees stay owned until readiness is proven.
#[cfg(windows)]
struct WindowsRunHandoff {
    previous_pid: u32,
    previous_child: Option<std::process::Child>,
    previous_tree: Option<process_tree::ProcessTreeGuard>,
    previous_evidence: xmatrix_windows_continuity::RunEvidence,
    previous_status: DaemonRunStatusMarker,
    started_millis: u64,
}

/// Optional recovery receipt in the existing private Run sidecar/registry.
/// The status snapshot uses its existing JSON wire shape, decoded and checked
/// against the exact prior wrapper before restoration.
#[cfg(windows)]
#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedWindowsRunHandoff {
    previous_evidence: xmatrix_windows_continuity::RunEvidence,
    previous_status: Value,
    started_millis: u64,
}

#[cfg(windows)]
impl WindowsRunHandoff {
    fn previous_is_alive(&self) -> bool {
        crate::process_tree::process_alive(self.previous_pid)
            && runtime_windows_run_adoption::process_birth_id(self.previous_pid).ok()
                == Some(self.previous_evidence.process_birth_id)
    }

    fn stop_previous(&mut self) -> error::Result<()> {
        if self.previous_tree.is_some() || self.previous_is_alive() {
            stop_handoff_process(self.previous_pid, &mut self.previous_tree)?;
        }
        Ok(())
    }

    fn persisted(&self) -> PersistedWindowsRunHandoff {
        PersistedWindowsRunHandoff {
            previous_evidence: self.previous_evidence.clone(),
            previous_status: serde_json::to_value(&self.previous_status)
                .expect("Run status contains JSON-serializable fields"),
            started_millis: self.started_millis,
        }
    }
}

#[cfg(windows)]
fn recover_windows_run_handoff(managed: &mut DaemonRunChild, receipt: PersistedWindowsRunHandoff) {
    let evidence = receipt.previous_evidence;
    let Ok(status) = serde_json::from_value::<DaemonRunStatusMarker>(receipt.previous_status)
    else {
        return;
    };
    if evidence.validate().is_err()
        || managed.run_id.as_deref() != Some(evidence.run_id.as_str())
        || managed.execution_key.as_deref() != Some(evidence.execution_key.as_str())
        || managed.instance_id.as_deref() != Some(evidence.instance_id.as_str())
        || status.pid != evidence.pid
        || evidence.pid == managed.pid
        || runtime_windows_run_adoption::process_birth_id(evidence.pid).ok()
            != Some(evidence.process_birth_id)
    {
        // Never resurrect a dead predecessor or act on a reused pid. If the
        // original has already retired, the candidate is the only Run wrapper.
        return;
    }
    managed.handoff = Some(WindowsRunHandoff {
        previous_pid: evidence.pid,
        previous_child: None,
        previous_tree: None,
        previous_evidence: evidence,
        previous_status: status,
        started_millis: receipt.started_millis,
    });
    // A daemon restart interrupted the commit. Restore the admitted original
    // before activation challenges its evidence, rather than adopting a
    // candidate whose readiness/commit the previous daemon never confirmed.
    if let Err(error) = rollback_windows_run_handoff(managed) {
        append_daemon_registry_audit(&format!(
            "handoff_recovery_failed pid={} error={error}",
            managed.pid
        ));
    }
}

#[cfg(all(test, windows))]
#[path = "tests/tests_windows_run_handoff.rs"]
mod windows_run_handoff_tests;

#[cfg(windows)]
fn stop_handoff_process(
    pid: u32,
    tree: &mut Option<process_tree::ProcessTreeGuard>,
) -> error::Result<()> {
    if let Some(tree) = tree.as_mut() {
        tree.terminate()?;
    } else {
        terminate_daemon_pid(pid)?;
    }
    Ok(())
}

#[cfg(windows)]
fn rollback_windows_run_handoff(managed: &mut DaemonRunChild) -> error::Result<()> {
    let Some(handoff) = managed.handoff.as_ref() else {
        return Ok(());
    };
    let status_path = managed
        .status_file_path
        .as_ref()
        .ok_or_else(|| CliError::Launch("handoff lost its status path".into()))?;
    // Stop the candidate before restoring files: it must not overwrite the
    // original wrapper's status or leave its provider helpers running.
    if managed.process_tree.is_none() && crate::process_tree::process_alive(managed.pid) {
        let candidate = runtime_windows_run_adoption::read_evidence(status_path)?;
        if candidate.pid != managed.pid
            || managed.run_id.as_deref() != Some(candidate.run_id.as_str())
            || managed.execution_key.as_deref() != Some(candidate.execution_key.as_str())
            || runtime_windows_run_adoption::process_birth_id(managed.pid).ok()
                != Some(candidate.process_birth_id)
        {
            return Err(CliError::Launch(
                "cannot stop an unverified recovered handoff candidate".into(),
            ));
        }
    }
    if managed.process_tree.is_some() || crate::process_tree::process_alive(managed.pid) {
        stop_handoff_process(managed.pid, &mut managed.process_tree)?;
    }
    if !handoff.previous_is_alive() {
        // Both wrappers are gone. Let the next monitor sweep report the
        // candidate's failure; never rebind to a recycled predecessor pid.
        managed.handoff = None;
        return Ok(());
    }
    runtime_windows_run_adoption::persist_evidence(status_path, &handoff.previous_evidence)?;
    if !persist_daemon_run_status_marker_unlocked(status_path, &handoff.previous_status) {
        return Err(CliError::Launch("could not restore handoff status".into()));
    }
    let handoff = managed.handoff.take().expect("handoff is still owned");
    if let Some(mut child) = managed.child.take() {
        tokio::task::spawn_blocking(move || {
            let _ = child.wait();
        });
    }
    let candidate_pid = managed.pid;
    managed.pid = handoff.previous_pid;
    managed.child = handoff.previous_child;
    managed.process_tree = handoff.previous_tree;
    managed.exit_audited = false;
    persist_daemon_run_sidecar(&persisted_daemon_run_from_child(managed));
    append_daemon_registry_audit(&format!(
        "handoff_rolled_back candidate_pid={candidate_pid} restored_pid={}",
        managed.pid
    ));
    Ok(())
}

#[cfg(windows)]
fn reconcile_windows_run_handoff(managed: &mut DaemonRunChild) -> error::Result<()> {
    let Some(handoff) = managed.handoff.as_mut() else {
        return Ok(());
    };
    let candidate_alive = crate::process_tree::process_alive(managed.pid);
    let ready = candidate_alive
        && read_daemon_run_status_marker(managed.status_file_path.as_deref()).is_some_and(
            |marker| {
                replacement_wrapper_is_ready(
                    &marker,
                    managed.pid,
                    xmatrix_cli_core::version::current(),
                    handoff.started_millis,
                )
            },
        );
    if ready {
        handoff.stop_previous()?;
        let mut handoff = managed.handoff.take().expect("handoff is still owned");
        if let Some(mut child) = handoff.previous_child.take() {
            tokio::task::spawn_blocking(move || {
                let _ = child.wait();
            });
        }
        append_daemon_registry_audit(&format!("handoff_committed pid={}", managed.pid));
    } else if !candidate_alive
        || unix_millis_now().saturating_sub(handoff.started_millis)
            >= UPDATE_SELF_READY_TIMEOUT_SECS * 1000
    {
        rollback_windows_run_handoff(managed)?;
    }
    Ok(())
}

/// Environment a daemon-started handoff replacement never takes from the
/// wrapper it replaces: that wrapper's own Job, its one-time adoption
/// handshake, and its local broker proxies (the daemon hands the replacement
/// the brokers themselves).
#[cfg(windows)]
const WINDOWS_HANDOFF_REPLACED_ENV: [&str; 9] = [
    "XMATRIX_RUN_JOB_NAME",
    "XMATRIX_RUN_BOOTSTRAP_NONCE",
    xmatrix_windows_continuity::CONTROL_PROTOCOL_ENV,
    xmatrix_windows_continuity::CONTROL_READ_HANDLE_ENV,
    xmatrix_windows_continuity::CONTROL_WRITE_HANDLE_ENV,
    DAEMON_AUTH_URL_ENV,
    DAEMON_AUTH_CAPABILITY_ENV,
    DAEMON_REQUEST_URL_ENV,
    DAEMON_REQUEST_CAPABILITY_ENV,
];

/// Handles a `POST /request/handoff-run` from a Windows run's own
/// `update-self`. A Windows wrapper cannot start its own replacement — it and
/// everything it starts share its kill-on-close Job, and only the daemon can
/// admit a wrapper — so the daemon starts it: this daemon's CLI, with the
/// wrapper's arguments and environment, resumed with no message, admitted
/// through the adoption handshake and handed this run's brokers. The run is
/// rebound to it before the answer, exactly as `/request/rebind-run` would;
/// the caller then waits for it to serve and retires the old wrapper, or
/// rebinds back.
#[cfg(windows)]
async fn handoff_daemon_run(
    broker: &DaemonRequestBroker,
    context: &DaemonRequestAgentContext,
    payload: DaemonRunHandoffPayload,
) -> error::Result<String> {
    require_calling_run_grant(context, &payload.run_id, &payload.execution_key, "handoff")?;
    let executable = headless_wrapper_executable()?;
    // Serialize the bounded adoption handshake with stop and another handoff.
    let mut guard = broker.run_registry.lock().await;
    let (old_pid, status_path, cwd, instance_id, stdout_log, stderr_log, auth, request_capability) = {
        let managed = guard
            .values()
            .find(|managed| {
                managed.run_id.as_deref() == Some(payload.run_id.as_str())
                    && managed.execution_key.as_deref() == Some(payload.execution_key.as_str())
            })
            .ok_or_else(|| CliError::Launch("run is not registered with this daemon".into()))?;
        if managed.stop_in_progress || managed.handoff.is_some() {
            return Err(CliError::Launch(
                "run stop or handoff is in progress; refusing to hand off".into(),
            ));
        }
        (
            managed.pid,
            managed.status_file_path.clone().ok_or_else(|| {
                CliError::Launch("run has no status file to admit a replacement".into())
            })?,
            managed.cwd.clone(),
            managed.instance_id.clone().ok_or_else(|| {
                CliError::Launch("run has no instance to admit a replacement".into())
            })?,
            managed.stdout_log_path.clone(),
            managed.stderr_log_path.clone(),
            managed
                ._auth_grant
                .as_ref()
                .map(|grant| (grant.url.clone(), grant.broker_capability().to_string()))
                .ok_or_else(|| CliError::Launch("run auth grant is not restored".into()))?,
            managed
                .request_capability
                .clone()
                .ok_or_else(|| CliError::Launch("run request grant is not restored".into()))?,
        )
    };
    let previous_evidence = runtime_windows_run_adoption::read_evidence(&status_path)?;
    let previous_status = read_daemon_run_status_marker(Some(&status_path))
        .filter(|marker| marker.pid == old_pid)
        .ok_or_else(|| CliError::Launch("run has no matching status to roll back".into()))?;
    if previous_evidence.pid != old_pid
        || previous_evidence.run_id != payload.run_id
        || previous_evidence.execution_key != payload.execution_key
        || previous_evidence.instance_id != instance_id
    {
        return Err(CliError::Launch(
            "handoff evidence does not match the exact run".into(),
        ));
    }
    let started_millis = unix_millis_now();

    let mut command = std::process::Command::new(&executable);
    command
        .args(&payload.args)
        .env_clear()
        .envs(&payload.env)
        .env("XMATRIX_RESUME_REQUESTED", "1")
        .env("XMATRIX_RESUME_INSTANCE_ID", &instance_id)
        .stdin(Stdio::null())
        .stdout(daemon_run_log_stdio(stdout_log.as_deref()))
        .stderr(daemon_run_log_stdio(stderr_log.as_deref()));
    for key in WINDOWS_HANDOFF_REPLACED_ENV {
        command.env_remove(key);
    }
    if let Some(cwd) = cwd.as_ref() {
        command.current_dir(cwd);
    }
    command
        .env(DAEMON_AUTH_URL_ENV, &auth.0)
        .env(DAEMON_AUTH_CAPABILITY_ENV, &auth.1);
    command
        .env(DAEMON_REQUEST_URL_ENV, &broker.url)
        .env(DAEMON_REQUEST_CAPABILITY_ENV, &request_capability);
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let control = xmatrix_windows_continuity::InheritedControlPipe::create().map_err(|error| {
        CliError::Launch(format!("Run bootstrap pipe creation failed: {error}"))
    })?;
    control
        .child_handles()
        .map_err(|error| {
            CliError::Launch(format!(
                "Run bootstrap child handles are unavailable: {error}"
            ))
        })?
        .apply(&mut command);
    command.env("XMATRIX_RUN_BOOTSTRAP_NONCE", &nonce);
    detach_daemon_child_process(&mut command);
    let mut control = control;
    let child = command.spawn().map_err(|err| {
        CliError::Launch(format!(
            "Failed to start replacement wrapper from {}: {err}",
            executable.display()
        ))
    })?;
    control.release_child_handles();
    let mut process_tree = process_tree::track_detached_std_child(&child);
    let new_pid = child.id();
    let admitted = tokio::task::spawn_blocking({
        let run_id = payload.run_id.clone();
        let execution_key = payload.execution_key.clone();
        let status_path = status_path.clone();
        move || {
            runtime_windows_run_adoption::authorize_spawned_wrapper(
                control,
                &nonce,
                new_pid,
                &run_id,
                &execution_key,
                &instance_id,
                &status_path,
            )
        }
    })
    .await
    .map_err(|error| CliError::Launch(format!("Run adoption task failed: {error}")))?;
    if let Err(error) = admitted {
        let _ = process_tree.terminate();
        let _ = runtime_windows_run_adoption::persist_evidence(&status_path, &previous_evidence);
        return Err(error);
    }

    let Some((key, managed)) = guard.iter_mut().find(|(_, managed)| {
        managed.run_id.as_deref() == Some(payload.run_id.as_str())
            && managed.execution_key.as_deref() == Some(payload.execution_key.as_str())
            && managed.pid == old_pid
            && !managed.stop_in_progress
            && managed.handoff.is_none()
    }) else {
        let _ = process_tree.terminate();
        return Err(CliError::Launch(
            "run changed while admitting its replacement".into(),
        ));
    };
    let key = key.clone();
    managed.handoff = Some(WindowsRunHandoff {
        previous_pid: old_pid,
        previous_child: managed.child.take(),
        previous_tree: managed.process_tree.take(),
        previous_evidence,
        previous_status,
        started_millis,
    });
    managed.pid = new_pid;
    managed.child = Some(child);
    managed.process_tree = Some(process_tree);
    managed.exit_audited = false;
    persist_daemon_run_sidecar(&persisted_daemon_run_from_child(managed));
    persist_daemon_run_registry_locked(&guard);
    drop(guard);
    append_daemon_registry_audit(&format!(
        "rebound key={key} run={} old_pid={old_pid} new_pid={new_pid} reason=windows_handoff",
        payload.run_id
    ));
    Ok(serde_json::json!({
        "rebound": true,
        "oldPid": old_pid,
        "newPid": new_pid,
    })
    .to_string())
}

async fn remove_daemon_run_child(registry: &DaemonRunRegistry, key: &str, reason: &str) {
    let mut guard = registry.lock().await;
    if guard
        .get(key)
        .is_some_and(|managed| managed.stop_in_progress)
    {
        append_daemon_registry_audit(&format!(
            "remove_deferred key={key} reason={reason} stop_in_progress=true"
        ));
        return;
    }
    let removed = guard.remove(key);
    if let Some(managed) = removed.as_ref() {
        let run = persisted_daemon_run_from_child(managed);
        remove_daemon_run_sidecar(&run);
        append_daemon_registry_audit(&format!(
            "removed key={key} pid={} run={} reason={reason}",
            managed.pid,
            managed.run_id.as_deref().unwrap_or("unknown")
        ));
    }
    persist_daemon_run_registry_locked(&guard);
}

fn daemon_run_exit_detail(
    marker: Option<&DaemonRunStatusMarker>,
    exit_code: Option<i32>,
) -> Option<String> {
    if let Some(detail) = marker.and_then(|marker| marker.detail.as_ref())
        && !detail.trim().is_empty() {
            return Some(detail.clone());
        }
    let marker = marker?;
    if exit_code == Some(0) || marker.completed {
        return None;
    }
    match marker.phase.as_str() {
        "turn_running" => Some("agent process exited while processing a channel turn".to_string()),
        "codex_app_starting" => {
            Some("agent process exited while starting Codex app-server".to_string())
        }
        "codex_app_ready" => {
            Some("agent process exited while waiting for channel work".to_string())
        }
        phase if !phase.trim().is_empty() => Some(format!("agent process exited during {phase}")),
        _ => None,
    }
}

/// What the repo-pool sweep must treat as still claimed. A registry row on its
/// own is not evidence: rows rehydrated across a daemon restart routinely name
/// processes that are already gone, and those stranded leases are exactly what
/// the sweep exists to return. Only rows with a live process count, and each
/// contributes both its slot binding and its cwd, so a run launched into a
/// slot whose binding did not survive the restart is still protected.
async fn live_repo_pool_state(registry: &DaemonRunRegistry) -> repo_pool::PoolLiveness {
    let mut liveness = repo_pool::PoolLiveness::default();
    for child in registry.lock().await.values() {
        if !crate::process_tree::process_alive(child.pid) {
            continue;
        }
        if let Some(binding) = child.repo_pool_binding.as_ref() {
            liveness.slot_ids.insert(binding.slot_id.clone());
        }
        if let Some(cwd) = child.cwd.as_ref() {
            liveness.cwds.insert(cwd.clone());
        }
    }
    liveness
}

async fn report_finished_daemon_children(
    registry: &DaemonRunRegistry,
    relay: &SharedMachineDaemonConnection,
) {
    // Each exit settles on its own. One slow acknowledgement must not hold the
    // others, nor the snapshot this monitor sends after them.
    let exits = collect_finished_daemon_children(registry).await;
    if exits.is_empty() {
        return;
    }
    futures_util::future::join_all(
        exits
            .into_iter()
            .map(|exit| report_finished_daemon_child(registry, relay, exit)),
    )
    .await;
    // A row whose exit report is still unacknowledged is not a live Run.
    let live = registry
        .lock()
        .await
        .values()
        .any(|managed| crate::process_tree::process_alive(managed.pid));
    if !live {
        runtime_daemon_harness_action::on_daemon_idle(relay);
    }
}

async fn report_finished_daemon_child(
    registry: &DaemonRunRegistry,
    relay: &SharedMachineDaemonConnection,
    exit: DaemonRunExit,
) {
    let registry_key = exit.registry_key.clone();
    if let Some(authority) = exit.repo_pool_authority.as_ref() {
        if let Some(key) = registry_key.as_deref() {
            match reconcile_completed_repo_pool_return(registry, key, authority).await {
                Ok(true) => {
                    // A prior typed abandon already returned this exact slot,
                    // but daemon registry persistence failed afterward. The
                    // durable receipt is stronger than the stale row: remove
                    // it without changing Available back to Retained or
                    // emitting a second terminal lifecycle report.
                    return;
                }
                Ok(false) => {}
                Err(error) => {
                    append_daemon_registry_audit(&format!(
                        "exit_pool_receipt_reconcile_failed key={key} pid={} error={error}",
                        exit.pid
                    ));
                    eprintln!(
                        "{} failed to reconcile completed repo pool return for daemon child pid {}; will retry: {error}",
                        "⚠".yellow().bold(),
                        exit.pid
                    );
                    return;
                }
            }
        }
        let settled = retain_exited_repo_pool_authority(authority).await;
        if let Ok(false) = settled {
            append_daemon_registry_audit(&format!(
                "exit_pool_binding_moved key={} pid={}",
                registry_key.as_deref().unwrap_or("unknown"),
                exit.pid
            ));
        }
        if let Err(error) = settled {
            let verb = "retain";
            append_daemon_registry_audit(&format!(
                "exit_pool_{verb}_failed key={} pid={} error={error}",
                registry_key.as_deref().unwrap_or("unknown"),
                exit.pid
            ));
            eprintln!(
                "{} failed to {verb} repo pool slot for daemon child pid {}; will retry: {error}",
                "⚠".yellow().bold(),
                exit.pid
            );
            return;
        }
    }
    let relay = relay.clone();
    let exit_pid = exit.pid;
    match relay.confirm_run_report(exit.into_report()).await {
        Ok(()) => {
            if let Some(registry_key) = registry_key.as_deref() {
                remove_daemon_run_child(registry, registry_key, "exit_report_delivered").await;
            }
        }
        // A terminal rejection must drop the entry here too, not only on the
        // orphan-recovery path. Keeping it queues the same report forever:
        // every sweep re-sends an exit Authority has already refused, which
        // is what floods reverse/control and starves spawn delivery.
        Err(err) if daemon_report_terminal_rejection(&err) => {
            if let Some(registry_key) = registry_key.as_deref() {
                append_daemon_registry_audit(&format!(
                    "exit_report_abandoned key={registry_key} pid={exit_pid} error={err}"
                ));
                remove_daemon_run_child(registry, registry_key, "exit_report_rejected").await;
            }
        }
        Err(err) => {
            eprintln!(
                "{} failed to report daemon child exit; will retry: {err}",
                "⚠".yellow().bold()
            );
        }
    }
}
async fn report_orphaned_terminal_daemon_runs(
    registry: &DaemonRunRegistry,
    relay: &SharedMachineDaemonConnection,
) {
    let managed_status_paths = {
        let guard = registry.lock().await;
        guard
            .values()
            .filter_map(|managed| managed.status_file_path.clone())
            .collect::<HashSet<_>>()
    };
    for exit in collect_orphaned_terminal_daemon_run_statuses(&managed_status_paths) {
        let status_file_path = exit.status_file_path.clone();
        let pid = exit.pid;
        let relay = relay.clone();
        let report_err = relay.confirm_run_report(exit.into_report()).await.err();
        // Authority already dropped the run (or never owned it): treat as done and
        // stop retrying forever — otherwise reverse/control is flooded with
        // run_not_found and spawn delivery can starve.
        let drop_sidecar = match &report_err {
            None => true,
            Some(err) if daemon_report_terminal_rejection(err) => true,
            Some(err) => {
                eprintln!(
                    "{} failed to report recovered daemon run exit; will retry on reconnect: {err}",
                    "⚠".yellow().bold()
                );
                false
            }
        };
        if drop_sidecar
            && let Some(sidecar_path) = status_file_path
                .as_deref()
                .and_then(daemon_run_sidecar_path_for_status)
            {
                let removal = remove_daemon_run_sidecar_path(&sidecar_path, pid);
                if let Some(event) = orphan_sidecar_removed_audit_event(pid, &sidecar_path, removal)
                {
                    append_daemon_registry_audit(&event);
                }
            }
    }
    prune_daemon_run_artifacts(registry).await;
}

fn spawn_daemon_run_report_maintenance(
    registry: DaemonRunRegistry,
    relay: SharedMachineDaemonConnection,
    auth_broker: Option<DaemonAuthBroker>,
    request_broker: Option<DaemonRequestBroker>,
    active: Arc<AtomicBool>,
) {
    if !try_begin_daemon_run_report_maintenance(&active) {
        return;
    }
    config::spawn_profile_task(async move {
        let _active_guard = DaemonRunReportMaintenanceGuard(active);
        report_orphaned_terminal_daemon_runs(&registry, &relay).await;
        report_daemon_run_snapshot(
            &registry,
            &relay,
            auth_broker.as_ref(),
            request_broker.as_ref(),
        )
        .await;
    });
}

/// Resting slots are reclaimed on their own clock, not only when a spawn
/// happens to sweep the pool (docs/instance-sleep.md §6).
const DAEMON_POOL_SWEEP_INTERVAL: Duration = Duration::from_secs(10 * 60);

fn spawn_daemon_pool_sweep(registry: DaemonRunRegistry, active: Arc<AtomicBool>) {
    if !try_begin_daemon_run_report_maintenance(&active) {
        return;
    }
    config::spawn_profile_task(async move {
        let _active_guard = DaemonRunReportMaintenanceGuard(active);
        let live_cwds: HashSet<PathBuf> = registry
            .lock()
            .await
            .values()
            .filter_map(|child| child.cwd.clone())
            .collect();
        let pool_liveness = live_repo_pool_state(&registry).await;
        run_worktree::log_gc_outcome(
            &run_worktree::reclaim_worktree_storage_if_needed(&live_cwds, &pool_liveness).await,
        );
    });
}

struct DaemonRunReportMaintenanceGuard(Arc<AtomicBool>);

impl Drop for DaemonRunReportMaintenanceGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn try_begin_daemon_run_report_maintenance(active: &AtomicBool) -> bool {
    active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

/// True when Authority will never accept this exit report, so retrying it is
/// pure waste: the run is gone, or was never ours.
///
/// The first two forms are Authority's own codes. The third exists because the
/// Hub replaces an unrecognised Authority code with the generic
/// `runtime.authority_rejected` before the daemon ever sees it
/// (`runtime-transport/runtime-operation-failure.ts`), which silently stopped
/// the code match from ever firing. A non-retryable 404 means the same thing —
/// Authority does not have this run — and it survives that rewrite, so the
/// daemon stops on its own rather than trusting the Hub to name the cause.
fn daemon_report_terminal_rejection(err: &CliError) -> bool {
    let text = err.to_string();
    text.contains("run_not_found")
        || text.contains("report run is not owned by this principal")
        || (text.contains("retryable=false") && text.contains("status=404"))
}

async fn prune_daemon_run_artifacts(registry: &DaemonRunRegistry) {
    let protected_status_paths = {
        let guard = registry.lock().await;
        guard
            .values()
            .filter_map(|managed| managed.status_file_path.clone())
            .collect::<HashSet<_>>()
    };
    let (groups, files) = prune_daemon_run_artifacts_in_dir(
        &daemon_run_log_dir(),
        &protected_status_paths,
        unix_millis_now(),
    );
    if groups > 0 {
        append_daemon_registry_audit(&format!(
            "run_artifacts_pruned groups={groups} files={files}"
        ));
    }
}

fn daemon_snapshot_progress(
    marker: Option<&DaemonRunStatusMarker>,
    wrapper_pid: u32,
) -> (Option<String>, Option<u64>) {
    let marker = marker.filter(|marker| marker.pid == wrapper_pid);
    (
        marker.and_then(|marker| {
            normalized_startup_phase(&marker.phase)
                .map(str::to_string)
                .or_else(|| {
                    matches!(
                        marker.phase.as_str(),
                        "relay_register_retrying"
                            | "relay_auth_refresh_retrying"
                            | "wrapper_startup_failed"
                            | "turn_completed"
                            | "turn_failed"
                            | "turn_retrying"
                            | "run_delivery_failed"
                            | "turn_interrupted"
                            | "shutdown_requested"
                            | "event_stream_closed"
                    )
                    .then(|| marker.phase.clone())
                })
        }),
        marker.and_then(|marker| marker.wrapper_ready_at_millis),
    )
}

fn daemon_marker_startup_steps(
    marker: Option<&DaemonRunStatusMarker>,
    pid: u32,
) -> Vec<xmatrix_cli_core::machine_daemon_connection::MachineStartupStep> {
    marker
        .filter(|marker| marker.pid == pid)
        .map(|marker| {
            marker
                .startup_steps
                .iter()
                .take(16)
                .filter_map(|step| {
                    normalized_startup_phase(&step.phase).map(|phase| {
                        xmatrix_cli_core::machine_daemon_connection::MachineStartupStep {
                            phase: phase.to_string(),
                            at_millis: step.at_millis,
                        }
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn daemon_run_snapshot_items_from_guard(
    guard: &HashMap<String, DaemonRunChild>,
) -> Vec<MachineRunSnapshotItem> {
    guard
        .values()
        .map(|managed| {
            let marker = read_daemon_run_status_marker(managed.status_file_path.as_deref());
            let pid = managed.pid;
            #[cfg(windows)]
            let (marker, pid) = match managed.handoff.as_ref() {
                Some(handoff) if handoff.previous_is_alive() => {
                    (Some(handoff.previous_status.clone()), handoff.previous_pid)
                }
                _ => (marker, pid),
            };
            let (status_phase, wrapper_ready_at_millis) =
                daemon_snapshot_progress(marker.as_ref(), pid);
            MachineRunSnapshotItem {
                wrapper_version: marker
                    .as_ref()
                    .filter(|marker| marker.pid == pid)
                    .and_then(|marker| marker.wrapper_version.clone()),
                startup_steps: daemon_marker_startup_steps(marker.as_ref(), pid),
                task_execution: marker
                    .as_ref()
                    .filter(|marker| marker.pid == pid)
                    .and_then(|marker| marker.task_execution.clone()),
                operation_failure: marker
                    .as_ref()
                    .filter(|marker| marker.pid == pid)
                    .and_then(|marker| marker.operation_failure.clone()),
                connection_retry: marker
                    .as_ref()
                    .filter(|marker| marker.pid == pid)
                    .and_then(|marker| marker.connection_retry.clone()),
                status_phase,
                wrapper_ready_at_millis,
                run_id: managed.run_id.clone(),
                execution_key: managed.execution_key.clone(),
                agent_id: managed.agent_id.clone(),
                agent_name: managed.agent_name.clone(),
                pid: Some(pid),
            }
        })
        .collect()
}

async fn report_daemon_run_snapshot(
    registry: &DaemonRunRegistry,
    relay: &SharedMachineDaemonConnection,
    auth_broker: Option<&DaemonAuthBroker>,
    request_broker: Option<&DaemonRequestBroker>,
) {
    // Rehydrate/startup can race a Hub Runtime wake that drops the control
    // socket before the event loop observes Disconnected. Wait briefly so the
    // snapshot is not the first casualty of that reconnect window.
    for _ in 0..20 {
        if relay.is_connected() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let recovered = recover_daemon_run_registry_from_sidecars_in_dir(
        registry,
        &daemon_run_log_dir(),
        auth_broker,
        request_broker,
        true,
    )
    .await;
    send_daemon_run_snapshot(registry, relay, recovered).await;
}

async fn send_daemon_run_snapshot(
    registry: &DaemonRunRegistry,
    relay: &SharedMachineDaemonConnection,
    recovered: usize,
) {
    let resources = tokio::task::spawn_blocking(sample_machine_resources)
        .await
        .ok()
        .flatten();
    // Keep admission and snapshot enqueue causally ordered. If the snapshot
    // wins the registry lock it must reach the relay before a concurrent spawn
    // can register and acknowledge its Run; if admission wins, the snapshot
    // must include that Run. Otherwise a stale empty snapshot can follow a
    // successful spawn result and terminalize the new Authority Run.
    let (run_count, report) = {
        let guard = registry.lock().await;
        let runs = daemon_run_snapshot_items_from_guard(&guard);
        let run_count = runs.len();
        let report = relay.send_report(MachineDaemonReport::MachineRunSnapshot {
            request_id: None,
            snapshot_complete: Some(true),
            registry_connection_epoch: None,
            registry_sequence: None,
            captured_at: None,
            machine_resources: resources,
            harness_inventory: None,
            runs,
        });
        (run_count, report)
    };
    if let Err(err) = report {
        eprintln!(
            "{} failed to report daemon child snapshot; keeping daemon online: {err}",
            "⚠".yellow().bold()
        );
        append_daemon_registry_audit(&format!(
            "snapshot_report_failed runs={run_count} recovered={recovered} error={err}"
        ));
    } else {
        append_daemon_registry_audit(&format!(
            "snapshot_reported runs={run_count} recovered={recovered}"
        ));
    }
}

/// Reports what changed, when it changes: one partial snapshot naming only the
/// Runs whose progress moved, and the machine's resources only when they moved
/// materially. The full snapshot is sent once per connection (see
/// `report_daemon_run_snapshot`); nothing here repeats on a timer.
#[derive(Default)]
struct DaemonRunProgressReporter {
    reported: HashMap<String, MachineRunSnapshotItem>,
    resources: Option<Vec<u64>>,
    resources_at: Option<Instant>,
    /// The Hub connection the last resource report went to.
    connection_epoch: Option<u64>,
}

const DAEMON_RESOURCE_SAMPLE_INTERVAL: Duration = Duration::from_secs(10);

impl DaemonRunProgressReporter {
    async fn report(
        &mut self,
        relay: &SharedMachineDaemonConnection,
        items: Vec<MachineRunSnapshotItem>,
    ) {
        let live = items
            .iter()
            .map(daemon_run_progress_key)
            .collect::<HashSet<_>>();
        self.reported.retain(|key, _| live.contains(key));
        if !relay.is_connected() {
            return;
        }
        self.observe_connection(relay.connection_epoch());
        let changed = items
            .into_iter()
            .filter(|item| self.reported.get(&daemon_run_progress_key(item)) != Some(item))
            .collect::<Vec<_>>();
        let resources = self.changed_resources().await;
        if changed.is_empty() && resources.is_none() {
            return;
        }
        let signature = resources.as_ref().map(machine_resource_signature);
        let report = relay.send_report(MachineDaemonReport::MachineRunSnapshot {
            request_id: None,
            snapshot_complete: Some(false),
            registry_connection_epoch: None,
            registry_sequence: None,
            captured_at: None,
            machine_resources: resources,
            harness_inventory: None,
            runs: changed.clone(),
        });
        if let Err(err) = report {
            append_daemon_registry_audit(&format!(
                "progress_report_failed runs={} error={err}",
                changed.len()
            ));
            return;
        }
        for item in changed {
            self.reported.insert(daemon_run_progress_key(&item), item);
        }
        if signature.is_some() {
            self.resources = signature;
        }
    }

    /// A new Hub connection starts without this machine's load: the Hub keeps
    /// only the observation of the connection that sent it, and reconnecting
    /// replaces it. So the next tick reports the current sample even when it
    /// sits in the bucket last reported to the previous connection.
    fn observe_connection(&mut self, epoch: Option<u64>) {
        if epoch.is_some() && epoch != self.connection_epoch {
            self.connection_epoch = epoch;
            self.resources = None;
            self.resources_at = None;
        }
    }

    async fn changed_resources(&mut self) -> Option<serde_json::Value> {
        let now = Instant::now();
        if self
            .resources_at
            .is_some_and(|at| now.duration_since(at) < DAEMON_RESOURCE_SAMPLE_INTERVAL)
        {
            return None;
        }
        self.resources_at = Some(now);
        let sample = tokio::task::spawn_blocking(sample_machine_resources)
            .await
            .ok()
            .flatten()?;
        (self.resources.as_ref() != Some(&machine_resource_signature(&sample))).then_some(sample)
    }
}

fn daemon_run_progress_key(item: &MachineRunSnapshotItem) -> String {
    item.run_id
        .clone()
        .or_else(|| item.execution_key.clone())
        .unwrap_or_else(|| format!("pid:{}", item.pid.unwrap_or_default()))
}

/// Coarse buckets of a resource sample. Routing weighs these, so a change
/// within a bucket is not news worth a report.
fn machine_resource_signature(sample: &serde_json::Value) -> Vec<u64> {
    let number = |key: &str| sample.get(key).and_then(serde_json::Value::as_f64);
    let percent = |free: &str, total: &str| match (number(free), number(total)) {
        (Some(free), Some(total)) if total > 0.0 => (free / total * 100.0) as u64,
        _ => u64::MAX,
    };
    let cpus = number("cpuLogicalCount").unwrap_or(1.0).max(1.0);
    let load = sample
        .pointer("/loadAverage/0")
        .and_then(serde_json::Value::as_f64)
        .map(|load| (load / cpus * 4.0) as u64)
        .unwrap_or(u64::MAX);
    vec![
        cpus as u64,
        number("cpuUsagePercent")
            .map(|value| value as u64 / 10)
            .unwrap_or(u64::MAX),
        percent("memoryAvailableBytes", "memoryTotalBytes") / 5,
        percent("swapFreeBytes", "swapTotalBytes") / 10,
        percent("diskAvailableBytes", "diskTotalBytes"),
        load,
        // Gaining or losing a host ability is always a material change.
        sample
            .get("hostCapabilities")
            .and_then(serde_json::Value::as_array)
            .map_or(0, |capabilities| {
                capabilities.iter().any(|value| value == "github") as u64
            }),
    ]
}

fn spawn_daemon_child_monitor(
    registry: DaemonRunRegistry,
    relay: SharedMachineDaemonConnection,
    auth_broker: Option<DaemonAuthBroker>,
    request_broker: Option<DaemonRequestBroker>,
) -> tokio::task::JoinHandle<()> {
    config::spawn_profile_task(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        let mut progress = DaemonRunProgressReporter::default();
        let mut maintenance_at = Instant::now();
        let mut idle_tracker = runtime_daemon_idle_sleep::IdleSleepTracker::default();
        let mut pool_sweep_at = Instant::now() + Duration::from_secs(60);
        let pool_sweep_active = Arc::new(AtomicBool::new(false));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            report_finished_daemon_children(&registry, &relay).await;
            sleep_idle_daemon_children(&registry, &mut idle_tracker).await;
            if Instant::now() >= pool_sweep_at {
                pool_sweep_at = Instant::now() + DAEMON_POOL_SWEEP_INTERVAL;
                spawn_daemon_pool_sweep(registry.clone(), pool_sweep_active.clone());
            }
            let items = daemon_run_snapshot_items_from_guard(&*registry.lock().await);
            progress.report(&relay, items).await;
            if Instant::now() < maintenance_at {
                continue;
            }
            maintenance_at = Instant::now() + Duration::from_secs(30);
            let _ = recover_daemon_run_registry_from_sidecars_in_dir(
                &registry,
                &daemon_run_log_dir(),
                auth_broker.as_ref(),
                request_broker.as_ref(),
                true,
            )
            .await;
            reconcile_daemon_run_registry(&registry).await;
            prune_daemon_run_artifacts(&registry).await;
        }
    })
}

/// What the idle check needs from one managed Run: its sidecar marker, only
/// when this exact wrapper wrote it.
fn daemon_run_idle_view(
    key: &str,
    managed: &DaemonRunChild,
) -> runtime_daemon_idle_sleep::RunIdleView {
    let marker = read_daemon_run_status_marker(managed.status_file_path.as_deref())
        .filter(|marker| marker.pid == managed.pid);
    runtime_daemon_idle_sleep::RunIdleView {
        key: key.to_string(),
        pid: managed.pid,
        resumable_session: managed
            .resume_session_key
            .as_deref()
            .is_some_and(|key| !key.trim().is_empty()),
        stop_in_progress: managed.stop_in_progress,
        marker: marker.map(|marker| {
            let executions = marker.task_execution.iter().flat_map(|snapshot| {
                snapshot
                    .execution
                    .iter()
                    .chain(snapshot.recent_executions.iter())
            });
            let mut execution_in_flight = false;
            let mut last_execution_millis: Option<u64> = None;
            for execution in executions {
                if execution.finished_at_millis.is_none()
                    && matches!(execution.state.as_str(), "accepted" | "running")
                {
                    execution_in_flight = true;
                }
                let at = execution
                    .updated_at_millis
                    .max(execution.finished_at_millis.unwrap_or_default());
                last_execution_millis = Some(last_execution_millis.unwrap_or_default().max(at));
            }
            runtime_daemon_idle_sleep::RunIdleMarker {
                phase: marker.phase.clone(),
                completed: marker.completed,
                execution_in_flight,
                last_execution_millis,
                wrapper_ready_at_millis: marker.wrapper_ready_at_millis,
                updated_at_millis: marker.updated_at_millis,
                background_tasks: marker.background_tasks,
            }
        }),
    }
}

/// Put Runs that sat idle for the whole window to sleep, and end wrappers that
/// failed at startup but never exited (docs/instance-sleep.md §2). The exit
/// itself is reported by the ordinary finished-child path on a later tick.
async fn sleep_idle_daemon_children(
    registry: &DaemonRunRegistry,
    tracker: &mut runtime_daemon_idle_sleep::IdleSleepTracker,
) {
    let Some(window) = runtime_daemon_idle_sleep::idle_sleep_window() else {
        return;
    };
    let views = {
        let guard = registry.lock().await;
        guard
            .iter()
            .map(|(key, managed)| daemon_run_idle_view(key, managed))
            .collect::<Vec<_>>()
    };
    let decisions = tracker.observe(unix_millis_now(), window, &views);
    if decisions.is_empty() {
        return;
    }
    let processes = tokio::task::spawn_blocking(runtime_daemon_idle_sleep::process_snapshot)
        .await
        .unwrap_or_default();
    if processes.is_empty() {
        // No process table this tick: nothing can be matched, try again.
        return;
    }
    for decision in decisions {
        // A row outlives its process until the exit report is confirmed. Only
        // the wrapper that wrote the marker may be signalled, and only once.
        if !runtime_daemon_idle_sleep::is_marker_writer(
            decision.pid,
            decision.alive_at_millis,
            &processes,
        ) {
            tracker.note_ended(&decision.key, decision.pid);
            append_daemon_registry_audit(&format!(
                "idle_end_skipped_not_wrapper key={} pid={}",
                decision.key, decision.pid
            ));
            continue;
        }
        match decision.action {
            runtime_daemon_idle_sleep::IdleAction::Sleep { idle_for, phase } => {
                if end_idle_daemon_child(
                    registry,
                    &decision.key,
                    decision.pid,
                    Some((&phase, idle_for)),
                )
                .await
                {
                    tracker.note_ended(&decision.key, decision.pid);
                }
            }
            runtime_daemon_idle_sleep::IdleAction::EndFailedStartup => {
                if end_idle_daemon_child(registry, &decision.key, decision.pid, None).await {
                    tracker.note_ended(&decision.key, decision.pid);
                }
            }
        }
    }
}

/// End one idle Run's process tree without removing its registry row. With a
/// sleep, its marker is stamped `sleeping` first so the exit report, even one
/// sent by a later daemon, reports the sleep; if the wrapper changed phase in
/// between (a message arrived), the sleep is abandoned. Returns whether the
/// process was ended.
async fn end_idle_daemon_child(
    registry: &DaemonRunRegistry,
    key: &str,
    pid: u32,
    sleep: Option<(&str, Duration)>,
) -> bool {
    let mut guard = registry.lock().await;
    let Some(managed) = guard.get_mut(key) else {
        return false;
    };
    if managed.pid != pid || managed.stop_in_progress {
        return false;
    }
    let status_path = managed.status_file_path.clone();
    if let Some((observed_phase, idle_for)) = sleep {
        let Some(status_path) = status_path.as_deref() else {
            return false;
        };
        let idle_since = unix_millis_now().saturating_sub(idle_for.as_millis() as u64);
        let stamped = update_daemon_run_status_marker(status_path, |marker| {
            if marker.pid == pid
                && marker.phase == observed_phase
                && marker.background_tasks.is_none_or(|count| count == 0)
                && !marker.task_execution.iter().any(|snapshot| {
                    snapshot
                        .execution
                        .iter()
                        .chain(snapshot.recent_executions.iter())
                        .any(|execution| {
                            (execution.finished_at_millis.is_none()
                                && matches!(execution.state.as_str(), "accepted" | "running"))
                                || execution
                                    .updated_at_millis
                                    .max(execution.finished_at_millis.unwrap_or_default())
                                    > idle_since
                        })
                })
            {
                marker.phase = runtime_daemon_idle_sleep::SLEEPING_PHASE.to_string();
                marker.detail = Some(format!("idle for {} minutes", idle_for.as_secs() / 60));
            }
        });
        let confirmed = read_daemon_run_status_marker(Some(status_path)).is_some_and(|marker| {
            marker.pid == pid && marker.phase == runtime_daemon_idle_sleep::SLEEPING_PHASE
        });
        if !stamped || !confirmed {
            append_daemon_registry_audit(&format!(
                "sleep_skipped_activity_changed key={key} pid={pid}"
            ));
            return false;
        }
    }
    let terminated = match managed.process_tree.as_mut() {
        Some(process_tree) => process_tree
            .terminate()
            .map_err(|error| CliError::Launch(format!("failed to end idle pid {pid}: {error}"))),
        None => terminate_daemon_pid(pid),
    };
    let verb = if sleep.is_some() {
        "sleep"
    } else {
        "end_failed_startup"
    };
    match terminated {
        Ok(()) => {
            append_daemon_registry_audit(&format!(
                "{verb}_requested key={key} pid={pid} run={}",
                managed.run_id.as_deref().unwrap_or("unknown")
            ));
            true
        }
        Err(error) => {
            // Still running: the stamp must not report a sleep that never happened.
            if let (Some((observed_phase, _)), Some(status_path)) = (sleep, status_path.as_deref())
            {
                update_daemon_run_status_marker(status_path, |marker| {
                    if marker.pid == pid
                        && marker.phase == runtime_daemon_idle_sleep::SLEEPING_PHASE
                    {
                        marker.phase = observed_phase.to_string();
                        marker.detail = None;
                    }
                });
            }
            append_daemon_registry_audit(&format!(
                "{verb}_failed key={key} pid={pid} error={error}"
            ));
            false
        }
    }
}

fn daemon_worktree_disposition(
    value: Option<&MachineWorktreeDisposition>,
) -> MachineWorktreeDisposition {
    value.copied().unwrap_or(MachineWorktreeDisposition::Retain)
}

fn exact_stop_value<'a>(name: &str, value: Option<&'a str>) -> error::Result<&'a str> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CliError::Launch(format!("abandon request is missing exact {name}")))
}

type DaemonStopOutcome = (Option<u32>, &'static str);

struct RetainedRunAuthority<'a> {
    run_id: Option<&'a str>,
    execution_key: Option<&'a str>,
    instance_id: Option<&'a str>,
    resume_session_key: Option<&'a str>,
    repo_identity: Option<&'a str>,
    repo_key_id: Option<&'a str>,
    slot_id: Option<&'a str>,
}

async fn return_repo_pool_without_live_registry(
    authority: RetainedRunAuthority<'_>,
) -> error::Result<()> {
    let RetainedRunAuthority {
        run_id,
        execution_key,
        instance_id,
        resume_session_key,
        repo_identity,
        repo_key_id,
        slot_id,
    } = authority;
    let repo_fields = [repo_identity, repo_key_id, slot_id];
    if repo_fields.iter().all(|value| value.is_none()) {
        return Err(CliError::Launch(
            "abandon without a live registry row requires exact retained repo pool authority"
                .into(),
        ));
    }
    if !repo_fields.iter().all(|value| value.is_some()) {
        return Err(CliError::Launch(
            "abandon request carried a partial repo pool authority".into(),
        ));
    }
    let run_id = exact_stop_value("runId", run_id)?;
    let execution_key = exact_stop_value("executionKey", execution_key)?;
    let instance_id = exact_stop_value("instanceId", instance_id)?;
    let session_key = exact_stop_value("resumeSessionKey", resume_session_key)?;
    let identity_raw = exact_stop_value("repoIdentity", repo_identity)?;
    let key_raw = exact_stop_value("repoKeyId", repo_key_id)?;
    let slot_raw = exact_stop_value("slotId", slot_id)?;
    let identity = repo_pool::canonical_repo_identity(identity_raw)
        .map_err(|error| CliError::Launch(format!("invalid abandon repo identity ({error})")))?;
    if repo_pool::repo_key_id(&identity).as_str() != key_raw {
        return Err(CliError::Launch(
            "abandon repo key does not match canonical identity".into(),
        ));
    }
    let pools_root = repo_pool::default_repo_pools_root()
        .map_err(|error| CliError::Launch(format!("repo pool root unavailable ({error})")))?;
    let layout = repo_pool::RepoPoolLayout::from_persisted(&pools_root, key_raw)
        .map_err(|error| CliError::Launch(format!("invalid abandon repo pool layout ({error})")))?;
    let authority = repo_pool::BindingAuthority {
        session_key: session_key.to_string(),
        instance_id: instance_id.to_string(),
        run_id: run_id.to_string(),
        execution_key: execution_key.to_string(),
        slot_id: slot_raw.to_string(),
    };
    repo_pool::return_retained_authority_without_base_at(&layout, &authority)
        .await
        .map_err(|error| CliError::Launch(format!("repo pool abandon failed ({error})")))
}

struct DaemonStopRequest {
    request_id: String,
    run_id: Option<String>,
    execution_key: Option<String>,
    agent_id: Option<String>,
    instance_id: Option<String>,
    resume_session_key: Option<String>,
    repo_identity: Option<String>,
    repo_key_id: Option<String>,
    slot_id: Option<String>,
    pid: Option<u32>,
    reason: Option<String>,
    worktree_disposition: Option<MachineWorktreeDisposition>,
    handoff_export: Option<MachineHandoffExport>,
    relay_lease: Option<MachineDaemonCommandLease>,
}

impl DaemonStopRequest {
    fn from_command(command: MachineDaemonCommand) -> Option<Self> {
        let MachineDaemonCommand::MachineStopAgent {
            request_id,
            run_id,
            execution_key,
            agent_id,
            instance_id,
            resume_session_key,
            repo_identity,
            repo_key_id,
            slot_id,
            pid,
            reason,
            preserve_instance_for_reborn: _,
            worktree_disposition,
            handoff_export,
            relay_lease,
        } = command
        else {
            return None;
        };
        Some(Self {
            request_id,
            run_id,
            execution_key,
            agent_id,
            instance_id,
            resume_session_key,
            repo_identity,
            repo_key_id,
            slot_id,
            pid,
            reason,
            worktree_disposition,
            handoff_export,
            relay_lease,
        })
    }

    async fn export_source(&self, registry: &DaemonRunRegistry) -> Option<HandoffExportSource> {
        self.handoff_export.as_ref()?;
        handoff_export_source(
            registry,
            self.run_id.as_deref(),
            self.execution_key.as_deref(),
        )
        .await
    }

    async fn retained_export_source(&self) -> Option<HandoffExportSource> {
        self.handoff_export.as_ref()?;
        retained_handoff_export_source_at(
            &repo_pool::default_repo_pools_root().ok()?,
            RetainedRunAuthority {
                run_id: self.run_id.as_deref(),
                execution_key: self.execution_key.as_deref(),
                instance_id: self.instance_id.as_deref(),
                resume_session_key: self.resume_session_key.as_deref(),
                repo_identity: self.repo_identity.as_deref(),
                repo_key_id: self.repo_key_id.as_deref(),
                slot_id: self.slot_id.as_deref(),
            },
        )
        .await
        .ok()
    }

    async fn stop(&self, registry: &DaemonRunRegistry) -> error::Result<DaemonStopOutcome> {
        stop_daemon_child(
            registry,
            self.run_id.as_deref(),
            self.execution_key.as_deref(),
            self.instance_id.as_deref(),
            self.resume_session_key.as_deref(),
            self.repo_identity.as_deref(),
            self.repo_key_id.as_deref(),
            self.slot_id.as_deref(),
            self.worktree_disposition.as_ref(),
            self.pid,
            self.reason.as_deref(),
        )
        .await
    }

    fn into_report(
        self,
        result: error::Result<DaemonStopOutcome>,
        handoff_export: Option<MachineHandoffExportResult>,
    ) -> MachineDaemonReport {
        let (ok, stopped_pid, cleanup_reason, error) = match result {
            Ok((pid, reason)) => (true, pid, Some(reason.to_string()), None),
            Err(error) => (false, self.pid, None, Some(error.to_string())),
        };
        MachineDaemonReport::MachineStopResult {
            request_id: self.request_id,
            run_id: self.run_id,
            execution_key: self.execution_key,
            agent_id: self.agent_id,
            instance_id: self.instance_id,
            resume_session_key: self.resume_session_key,
            repo_identity: self.repo_identity,
            repo_key_id: self.repo_key_id,
            slot_id: self.slot_id,
            worktree_disposition: self.worktree_disposition,
            ok,
            pid: stopped_pid,
            cleanup_reason,
            error,
            handoff_export,
            relay_lease: self.relay_lease,
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn stop_daemon_child(
    registry: &DaemonRunRegistry,
    run_id: Option<&str>,
    execution_key: Option<&str>,
    instance_id: Option<&str>,
    resume_session_key: Option<&str>,
    repo_identity: Option<&str>,
    repo_key_id: Option<&str>,
    slot_id: Option<&str>,
    worktree_disposition: Option<&MachineWorktreeDisposition>,
    pid: Option<u32>,
    reason: Option<&str>,
) -> error::Result<DaemonStopOutcome> {
    let disposition = daemon_worktree_disposition(worktree_disposition);
    let mut guard = registry.lock().await;
    let key = run_id
        .map(|value| daemon_run_key("run", value))
        .or_else(|| execution_key.map(|value| daemon_run_key("execution", value)))
        .or_else(|| pid.map(|value| daemon_run_key("pid", &value.to_string())))
        .ok_or_else(|| {
            CliError::Launch("stop request did not include a run id, execution key, or pid".into())
        })?;

    let Some(managed) = guard.get_mut(&key) else {
        if disposition == MachineWorktreeDisposition::Abandon {
            drop(guard);
            return_repo_pool_without_live_registry(RetainedRunAuthority {
                run_id,
                execution_key,
                instance_id,
                resume_session_key,
                repo_identity,
                repo_key_id,
                slot_id,
            })
            .await?;
            append_daemon_registry_audit(&format!(
                "abandon_without_live_registry key={key} reason={}",
                reason.unwrap_or("unspecified")
            ));
            return Ok((pid, "already_absent"));
        }
        // Reborn/stop must be idempotent when the predecessor is already gone:
        // the daemon may have restarted, the registry may have been cleared, or
        // an earlier cleanup already terminated the tree. Prefer a best-effort
        // kill of an explicit live PID; otherwise treat the stop as complete so
        // Authority can reborn/spawn without "could not terminate the prior process tree".
        if let Some(pid) = pid.filter(|candidate| crate::process_tree::process_alive(*candidate)) {
            append_daemon_registry_audit(&format!(
                "stop_orphaned_pid key={key} pid={pid} reason={}",
                reason.unwrap_or("unspecified")
            ));
            terminate_daemon_pid(pid)?;
            append_daemon_registry_audit(&format!(
                "stop_noop_orphaned_completed key={key} pid={pid}"
            ));
            return Ok((Some(pid), "process_terminated"));
        }
        append_daemon_registry_audit(&format!(
            "stop_noop key={key} pid={pid:?} reason=no_managed_child"
        ));
        return Ok((pid, "already_absent"));
    };
    // A delayed stop may target an earlier execution of this same Run. Check
    // the supplied fence before touching its process tree or durable state.
    // Legacy unkeyed callers keep their existing compatibility behavior.
    if execution_key.is_some() && managed.execution_key.as_deref() != execution_key {
        return Err(CliError::Launch(
            "stop request execution key does not match the live daemon binding".into(),
        ));
    }
    if disposition == MachineWorktreeDisposition::Abandon {
        if managed.run_id.as_deref() != run_id
            || managed.execution_key.as_deref() != execution_key
            || managed.instance_id.as_deref() != instance_id
            || managed.resume_session_key.as_deref() != resume_session_key
        {
            return Err(CliError::Launch(
                "abandon request does not match the exact live daemon binding".into(),
            ));
        }
        match managed.repo_pool_binding.as_ref() {
            Some(binding) => {
                if Some(binding.canonical_repo_identity.as_str()) != repo_identity
                    || Some(binding.repo_key_id.as_str()) != repo_key_id
                    || Some(binding.slot_id.as_str()) != slot_id
                {
                    return Err(CliError::Launch(
                        "abandon request does not match the exact live repo pool binding".into(),
                    ));
                }
            }
            None => {
                if [repo_identity, repo_key_id, slot_id]
                    .iter()
                    .any(|value| value.is_some())
                {
                    return Err(CliError::Launch(
                        "non-pooled daemon run cannot accept repo pool abandon authority".into(),
                    ));
                }
            }
        }
    }
    if let Some(reason) = reason {
        eprintln!(
            "{} stopping child pid {}: {reason}",
            "○".cyan().bold(),
            managed.pid
        );
    }
    let persisted = persisted_daemon_run_from_child(managed);
    #[cfg(windows)]
    if let Some(handoff) = managed.handoff.as_mut() {
        handoff.stop_previous()?;
    }
    append_daemon_registry_audit(&format!(
        "stop_requested key={key} pid={} run={} reason={}",
        managed.pid,
        managed.run_id.as_deref().unwrap_or("unknown"),
        reason.unwrap_or("unspecified")
    ));
    let stop_result = if let Some(process_tree) = managed.process_tree.as_mut() {
        process_tree.terminate().map_err(|error| {
            CliError::Launch(format!(
                "failed to terminate daemon-owned process tree for pid {}: {error}",
                managed.pid
            ))
        })?;
        if let Some(child) = managed.child.as_mut()
            && child
                .try_wait()
                .map_err(|err| {
                    CliError::Launch(format!(
                        "failed to check child pid {} after process-tree stop: {err}",
                        managed.pid
                    ))
                })?
                .is_none()
            {
                let _ = child.wait();
            }
        Ok(())
    } else if let Some(child) = managed.child.as_mut() {
        let status = child.try_wait().map_err(|err| {
            CliError::Launch(format!(
                "failed to check child pid {} before stop: {err}",
                managed.pid
            ))
        })?;
        if let Some(status) = status {
            eprintln!(
                "{} child pid {} already exited with {status}",
                "○".cyan().bold(),
                managed.pid
            );
        }
        terminate_daemon_pid(managed.pid)?;
        if status.is_none() {
            let _ = child.wait();
        }
        Ok(())
    } else {
        // The wrapper may already have exited and reparented descendants. The
        // platform tree cleanup also recovers those detached descendants.
        terminate_daemon_pid(managed.pid)
    };
    if let Err(err) = stop_result {
        append_daemon_registry_audit(&format!(
            "stop_failed key={key} pid={} run={} error={err}",
            managed.pid,
            managed.run_id.as_deref().unwrap_or("unknown")
        ));
        return Err(err);
    }
    let stopped_pid = managed.pid;
    let pool_authority = daemon_repo_pool_run_authority(managed)?;
    managed.stop_in_progress = true;
    drop(guard);
    let pool_transition = if let Some(authority) = pool_authority.as_ref() {
        match disposition {
            MachineWorktreeDisposition::Retain => retain_repo_pool_authority(authority).await,
            MachineWorktreeDisposition::Abandon => abandon_repo_pool_authority(authority).await,
        }
    } else {
        Ok(())
    };
    let mut guard = registry.lock().await;
    if let Err(error) = pool_transition {
        if let Some(current) = guard
            .get_mut(&key)
            .filter(|current| current.pid == stopped_pid && current.stop_in_progress)
        {
            current.stop_in_progress = false;
        }
        return Err(error);
    }
    let still_exact = guard
        .get(&key)
        .map(|managed| managed.pid == stopped_pid && managed.stop_in_progress)
        .unwrap_or(false);
    if !still_exact {
        return Err(CliError::Launch(
            "daemon registry changed while finalizing stop".into(),
        ));
    }
    let mut managed = guard
        .remove(&key)
        .expect("exact managed daemon child remains registered until stop finalizes");
    if !persist_daemon_run_registry_locked(&guard) {
        // The pool transition may already have committed an exact durable
        // return receipt. Reinsert the stale row without the transient stop
        // fence so the same-daemon monitor can reconcile that receipt instead
        // of requiring a daemon restart to clear the in-memory-only flag.
        managed.stop_in_progress = false;
        guard.insert(key.clone(), managed);
        drop(guard);
        if disposition == MachineWorktreeDisposition::Abandon
            && let Some(authority) = pool_authority.as_ref()
                && repo_pool_return_receipt_matches(authority).await? {
                    // The process tree is gone and the pool manifest durably
                    // records the exact Available transition. Report success so
                    // Authority can commit DELETE; the monitor/startup reconcile path
                    // removes this intentionally reinserted stale registry row.
                    append_daemon_registry_audit(&format!(
                        "stop_registry_persist_failed_after_completed_pool_return key={key} pid={stopped_pid}"
                    ));
                    return Ok((Some(stopped_pid), "process_terminated"));
                }
        return Err(CliError::Launch(
            "failed to persist daemon registry after stop".into(),
        ));
    }
    let run_status = read_daemon_run_status_marker(managed.status_file_path.as_deref())
        .filter(|marker| marker.pid == managed.pid);
    record_daemon_run_wake_metrics(&key, &managed, run_status.as_ref(), "stopped");
    remove_daemon_run_sidecar(&persisted);
    append_daemon_registry_audit(&format!(
        "removed key={key} pid={} run={} reason=stop_completed",
        managed.pid,
        managed.run_id.as_deref().unwrap_or("unknown")
    ));
    Ok((Some(managed.pid), "process_terminated"))
}

/// What a cross-machine handoff export needs from a Run, read before its stop
/// can drop the registry row: the checkout and the repository it belongs to.
struct HandoffExportSource {
    cwd: PathBuf,
    repository: Option<String>,
    run_id: String,
    execution_key: String,
    label: String,
    retained: Option<repo_pool::RetainedHandoffSource>,
}

async fn retained_handoff_export_source_at(
    pools_root: &Path,
    authority: RetainedRunAuthority<'_>,
) -> error::Result<HandoffExportSource> {
    let identity = repo_pool::canonical_repo_identity(exact_stop_value(
        "repoIdentity",
        authority.repo_identity,
    )?)
    .map_err(|error| CliError::Launch(format!("invalid handoff repo identity ({error})")))?;
    let key = exact_stop_value("repoKeyId", authority.repo_key_id)?;
    if repo_pool::repo_key_id(&identity).as_str() != key {
        return Err(CliError::Launch(
            "handoff repo key does not match identity".into(),
        ));
    }
    let exact = repo_pool::BindingAuthority {
        session_key: exact_stop_value("resumeSessionKey", authority.resume_session_key)?
            .to_string(),
        instance_id: exact_stop_value("instanceId", authority.instance_id)?.to_string(),
        run_id: exact_stop_value("runId", authority.run_id)?.to_string(),
        execution_key: exact_stop_value("executionKey", authority.execution_key)?.to_string(),
        slot_id: exact_stop_value("slotId", authority.slot_id)?.to_string(),
    };
    let layout = repo_pool::RepoPoolLayout::from_persisted(pools_root, key)
        .map_err(|error| CliError::Launch(format!("invalid handoff pool layout ({error})")))?;
    let retained = repo_pool::retained_handoff_source_at(&layout, &exact)
        .await
        .map_err(|error| {
            CliError::Launch(format!("retained handoff source unavailable ({error})"))
        })?;
    Ok(HandoffExportSource {
        cwd: retained.cwd.clone(),
        repository: github_repository_of_pool_identity(identity.as_str()),
        run_id: exact.run_id,
        execution_key: exact.execution_key,
        label: exact.instance_id,
        retained: Some(retained),
    })
}

async fn handoff_export_source(
    registry: &DaemonRunRegistry,
    run_id: Option<&str>,
    execution_key: Option<&str>,
) -> Option<HandoffExportSource> {
    let key = run_id
        .map(|value| daemon_run_key("run", value))
        .or_else(|| execution_key.map(|value| daemon_run_key("execution", value)))?;
    let guard = registry.lock().await;
    let managed = guard.get(&key)?;
    Some(HandoffExportSource {
        cwd: managed.cwd.clone()?,
        repository: managed.repo_pool_binding.as_ref().and_then(|binding| {
            github_repository_of_pool_identity(&binding.canonical_repo_identity)
        }),
        run_id: managed.run_id.clone()?,
        execution_key: managed.execution_key.clone()?,
        label: managed
            .agent_name
            .clone()
            .or_else(|| managed.instance_id.clone())
            .unwrap_or_else(|| "an xMatrix Run".to_string()),
        retained: None,
    })
}

fn handoff_export_failure(branch: &str, error: impl Into<String>) -> MachineHandoffExportResult {
    MachineHandoffExportResult {
        branch: branch.to_string(),
        state: "failed".to_string(),
        commit: None,
        base: None,
        dirty: false,
        error: Some(error.into()),
    }
}

/// After the Run's process tree is gone (so nothing writes its checkout any
/// more) and before its stop is reported (so the Hub still holds the Run as
/// live), push everything the checkout holds to the handoff branch. The push
/// speaks for the Channel's Space through a grant that lives only as long as
/// this export.
async fn export_handoff_after_stop(
    source: Option<HandoffExportSource>,
    export: &MachineHandoffExport,
    auth_broker: Option<&DaemonAuthBroker>,
) -> MachineHandoffExportResult {
    let branch = export.branch.as_str();
    if !run_worktree::valid_handoff_branch(branch) {
        return handoff_export_failure(branch, "handoff branch is outside xmatrix/handoff/");
    }
    let Some(source) = source else {
        return handoff_export_failure(branch, "this Run's checkout is not known to its daemon");
    };
    let Some(repository) = source.repository.clone() else {
        return handoff_export_failure(branch, "this Run's checkout is not a GitHub repository");
    };
    let Some(broker) = auth_broker else {
        return handoff_export_failure(branch, "the daemon has no credential broker");
    };
    let Some(capability) = issue_git_credential_grant(
        &broker.git_credentials,
        DaemonGitCredentialGrantState {
            channel_id: export.channel_id.clone(),
            run_id: source.run_id.clone(),
            execution_key: source.execution_key.clone(),
            repository,
        },
    ) else {
        return handoff_export_failure(branch, "the daemon could not issue a Git credential");
    };
    let outcome = git_credential::with_scoped_capability(Some(capability.clone()), async {
        let work = match source
            .retained
            .as_ref()
            .and_then(|retained| retained.captured.clone())
        {
            Some(work) => work,
            None => run_worktree::capture_handoff_work(&source.cwd, &source.label).await?,
        };
        run_worktree::push_handoff_work(&source.cwd, &work.commit, branch).await?;
        Ok::<_, String>(work)
    })
    .await;
    if let Ok(mut grants) = broker.git_credentials.lock() {
        grants.remove(&capability);
    }
    match outcome {
        Ok(work) => MachineHandoffExportResult {
            branch: branch.to_string(),
            state: "pushed".to_string(),
            commit: Some(work.commit),
            base: Some(work.base),
            dirty: work.dirty,
            error: None,
        },
        Err(error) => handoff_export_failure(branch, error.chars().take(600).collect::<String>()),
    }
}

/// The export a stop reports: none unless one was asked for, and a failure
/// when the stop itself failed (the checkout may still have a writer).
async fn handoff_export_for_stop<T, E>(
    requested: Option<&MachineHandoffExport>,
    stop: &Result<T, E>,
    source: Option<HandoffExportSource>,
    auth_broker: Option<&DaemonAuthBroker>,
) -> Option<MachineHandoffExportResult> {
    let export = requested?;
    Some(match stop {
        Ok(_) => export_handoff_after_stop(source, export, auth_broker).await,
        Err(_) => handoff_export_failure(&export.branch, "the Run could not be stopped"),
    })
}

fn daemon_run_key(kind: &str, value: &str) -> String {
    format!("{kind}:{value}")
}

fn read_initial_message_attachments_from_env()
-> error::Result<Option<Vec<protocol::ChannelAttachment>>> {
    if let Ok(path) = std::env::var("XMATRIX_INITIAL_MESSAGE_ATTACHMENTS_FILE") {
        let text = std::fs::read_to_string(&path)?;
        let attachments = serde_json::from_str::<Vec<protocol::ChannelAttachment>>(&text)?;
        let _ = std::fs::remove_file(path);
        return Ok(Some(attachments));
    }

    if let Ok(json) = std::env::var("XMATRIX_INITIAL_MESSAGE_ATTACHMENTS_JSON") {
        let attachments = serde_json::from_str::<Vec<protocol::ChannelAttachment>>(&json)?;
        return Ok(Some(attachments));
    }

    Ok(None)
}

async fn cmd_migrate(
    hub_url: &str,
    token_override: Option<&str>,
    command: MigrateCommand,
) -> error::Result<()> {
    match command {
        MigrateCommand::Slack {
            export_path,
            slack_token,
            space_name,
            include_archived,
            max_messages_per_channel,
            history,
            dry_run,
        } => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct SlackMigrationResponse {
                space: protocol::SerializedSpace,
                channels_created: usize,
                messages_imported: usize,
                messages_skipped: usize,
            }

            let history_mode = match history {
                MigrationHistoryMode::Free => "free",
                MigrationHistoryMode::All => "all",
            }
            .to_string();
            let payload = if let Some(export_path) = export_path {
                slack_migrate::load_slack_export(
                    &export_path,
                    include_archived,
                    max_messages_per_channel,
                    history_mode.clone(),
                    space_name,
                )?
            } else {
                let slack_token = resolve_slack_token(hub_url, token_override, slack_token).await?;
                slack_migrate::load_slack_workspace(
                    &slack_token,
                    include_archived,
                    max_messages_per_channel,
                    history_mode.clone(),
                    space_name,
                )
                .await?
            };
            let stats = slack_migrate::stats(&payload);

            println!(
                "{} Slack workspace prepared: {} channels, {} messages ({})",
                "✓".green().bold(),
                stats.channel_count,
                stats.message_count,
                if history_mode == "all" {
                    "full history"
                } else {
                    "free history, last 90 days"
                }
            );

            if dry_run {
                println!("Dry run only. No data was written.");
                return Ok(());
            }

            let token = resolve_auth_token(token_override, hub_url).await?;
            let response: SlackMigrationResponse = http::request_json(
                &with_route(hub_url, HubRoutes::MIGRATIONS_SLACK),
                "POST",
                Some(&token),
                Some(serde_json::to_value(payload)?),
            )
            .await?;

            println!(
                "{} Migrated Slack into space {} ({})",
                "✓".green().bold(),
                response.space.name,
                response.space.id.dimmed()
            );
            println!(
                "  Channels: {} created  Messages: {} imported, {} skipped",
                response.channels_created, response.messages_imported, response.messages_skipped
            );
            Ok(())
        }
    }
}

async fn resolve_slack_token(
    hub_url: &str,
    token_override: Option<&str>,
    provided_token: Option<String>,
) -> error::Result<String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SlackOAuthStartResponse {
        grant_id: String,
        authorization_url: String,
        expires_in: u64,
        interval: u64,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SlackOAuthPollResponse {
        status: String,
        #[serde(default)]
        slack_token: Option<String>,
        #[serde(default)]
        interval: Option<u64>,
        #[serde(default)]
        error: Option<String>,
    }

    if let Some(slack_token) = provided_token
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return Ok(slack_token);
    }

    let token = resolve_auth_token(token_override, hub_url).await?;
    let start: SlackOAuthStartResponse = http::request_json(
        &with_route(hub_url, HubRoutes::SLACK_OAUTH_START),
        "POST",
        Some(&token),
        None,
    )
    .await?;

    println!("Opening Slack authorization...");
    println!(
        "If the browser doesn't open, open this URL:\n  {}\n",
        start.authorization_url
    );
    let _ = open::that(&start.authorization_url);
    println!("Approve xMatrix in Slack, then return here. Waiting...");

    let poll_url = with_route(hub_url, HubRoutes::SLACK_OAUTH_TOKEN);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(start.expires_in);
    let mut poll_interval = start.interval.max(1);
    loop {
        let poll: SlackOAuthPollResponse = http::request_json(
            &poll_url,
            "POST",
            Some(&token),
            Some(serde_json::json!({ "grantId": start.grant_id })),
        )
        .await?;

        match poll.status.as_str() {
            "approved" => {
                return poll.slack_token.ok_or_else(|| {
                    CliError::Launch("Slack authorization succeeded without a token".into())
                });
            }
            "pending" => {}
            "expired" => {
                return Err(CliError::Launch(poll.error.unwrap_or_else(|| {
                    "Slack authorization expired. Run the command again.".into()
                })));
            }
            _ => {
                return Err(CliError::Launch(poll.error.unwrap_or_else(|| {
                    format!("Unexpected Slack authorization status '{}'", poll.status)
                })));
            }
        }

        if tokio::time::Instant::now() >= deadline {
            return Err(CliError::Launch(
                "Slack authorization timed out. Run the command again.".into(),
            ));
        }
        if let Some(next_interval) = poll.interval {
            poll_interval = next_interval.max(1);
        }
        tokio::time::sleep(Duration::from_secs(poll_interval)).await;
    }
}

#[cfg(test)]
mod invocation_progress_tests {
    use super::*;

    #[test]
    fn progress_requires_the_current_wrapper_pid() {
        let marker: DaemonRunStatusMarker = serde_json::from_value(serde_json::json!({
            "phase": "relay_register_retrying", "completed": false, "delivered": false,
            "pid": 42, "updatedAtMillis": 1000, "wrapperReadyAtMillis": 900,
            "detail": "private diagnostic must stay local"
        }))
        .unwrap();
        assert_eq!(
            daemon_snapshot_progress(Some(&marker), 42),
            (Some("relay_register_retrying".into()), Some(900))
        );
        assert_eq!(daemon_snapshot_progress(Some(&marker), 43), (None, None));
        assert_eq!(daemon_snapshot_progress(None, 42), (None, None));
    }
    #[test]
    fn startup_checkpoints_keep_the_first_evidence_and_ignore_private_phases() {
        let mut steps = Vec::new();
        record_startup_step(&mut steps, "relay_registered", 1000);
        record_startup_step(&mut steps, "codex_app_ready", 2000);
        record_startup_step(&mut steps, "codex_app_ready", 3000);
        record_startup_step(&mut steps, "private diagnostic", 4000);
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[1].phase, "runtime_ready");
        assert_eq!(steps[1].at_millis, 2000);
        let marker: DaemonRunStatusMarker = serde_json::from_value(serde_json::json!({
            "phase": "private diagnostic", "completed": false, "delivered": false,
            "pid": 42, "updatedAtMillis": 1000
        }))
        .unwrap();
        assert_eq!(daemon_snapshot_progress(Some(&marker), 42), (None, None));
    }
}

/// Retain CPU counters across samples; the first sample has no usage value.
fn sample_machine_resources() -> Option<serde_json::Value> {
    static SAMPLER: std::sync::OnceLock<std::sync::Mutex<(sysinfo::System, Option<Instant>)>> =
        std::sync::OnceLock::new();
    let mut guard = SAMPLER
        .get_or_init(|| std::sync::Mutex::new((sysinfo::System::new(), None)))
        .lock()
        .ok()?;
    let (system, previous) = &mut *guard;
    let mut value = sample_machine_resources_at(system, previous, Instant::now())?;
    value["hostCapabilities"] = serde_json::json!(host_capabilities());
    if host_is_laptop() {
        value["formFactor"] = serde_json::json!("laptop");
    }
    Some(value)
}

/// Whether this host runs on a built-in battery: its owner may close it or take
/// it away at any time, so work placed here can stop for hours. Read once; a
/// failed probe reports nothing rather than guessing.
fn host_is_laptop() -> bool {
    static LAPTOP: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *LAPTOP.get_or_init(probe_host_laptop)
}

#[cfg(target_os = "linux")]
fn probe_host_laptop() -> bool {
    // SMBIOS chassis types: Portable, Laptop, Notebook, Sub Notebook, Tablet,
    // Convertible, Detachable.
    let chassis = std::fs::read_to_string("/sys/class/dmi/id/chassis_type")
        .ok()
        .and_then(|value| value.trim().parse::<u8>().ok());
    if chassis.is_some_and(|kind| matches!(kind, 8 | 9 | 10 | 14 | 30 | 31 | 32)) {
        return true;
    }
    // A system battery; a wireless mouse's battery has scope "Device".
    std::fs::read_dir("/sys/class/power_supply")
        .into_iter()
        .flatten()
        .flatten()
        .any(|supply| {
            let read = |name: &str| std::fs::read_to_string(supply.path().join(name)).ok();
            read("type").is_some_and(|kind| kind.trim() == "Battery")
                && read("scope").is_none_or(|scope| scope.trim() != "Device")
        })
}

#[cfg(target_os = "macos")]
fn probe_host_laptop() -> bool {
    std::process::Command::new("pmset")
        .args(["-g", "batt"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).contains("InternalBattery"))
}

#[cfg(windows)]
fn probe_host_laptop() -> bool {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut status: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    // BatteryFlag 128 is "no system battery" and 255 "unknown".
    (unsafe { GetSystemPowerStatus(&mut status) }) != 0
        && status.BatteryFlag != 128
        && status.BatteryFlag != 255
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn probe_host_laptop() -> bool {
    false
}

/// How long a host capability reading is reused before the probe runs again.
const HOST_CAPABILITY_PROBE_INTERVAL: Duration = Duration::from_secs(300);
const HOST_CAPABILITY_PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// Host abilities this daemon can show the Hub, re-probed every few minutes.
/// `github`: the daemon user's GitHub CLI is logged in, so a Run here can
/// push and open pull requests. The Hub only routes work that needs it here
/// while this is reported; no credential ever leaves the machine.
fn host_capabilities() -> Vec<String> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Option<(Instant, Vec<String>)>>> =
        std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(None));
    if let Ok(guard) = cache.lock()
        && let Some((at, capabilities)) = guard.as_ref()
        && at.elapsed() < HOST_CAPABILITY_PROBE_INTERVAL
    {
        return capabilities.clone();
    }
    let mut capabilities = Vec::new();
    if github_cli_authenticated() {
        capabilities.push("github".to_string());
    }
    if let Ok(mut guard) = cache.lock() {
        *guard = Some((Instant::now(), capabilities.clone()));
    }
    capabilities
}

/// `gh auth status` exits 0 only when a GitHub login is usable for the host.
/// A missing `gh`, a timeout or any failure is "not shown", never assumed.
fn github_cli_authenticated() -> bool {
    let Ok(mut child) = std::process::Command::new("gh")
        .args(["auth", "status", "--hostname", "github.com"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return false;
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if started.elapsed() < HOST_CAPABILITY_PROBE_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(100));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

fn sample_machine_resources_at(
    system: &mut sysinfo::System,
    previous: &mut Option<Instant>,
    now: Instant,
) -> Option<serde_json::Value> {
    if previous.is_some_and(|at| now.duration_since(at) < sysinfo::MINIMUM_CPU_UPDATE_INTERVAL) {
        return None;
    }
    system.refresh_cpu_usage();
    system.refresh_memory();
    let mut value = serde_json::json!({ "observedAt": daemon_event_at_rfc3339() });
    if !system.cpus().is_empty() {
        value["cpuLogicalCount"] = serde_json::json!(system.cpus().len());
    }
    if previous.is_some() {
        value["cpuUsagePercent"] = serde_json::json!(system.global_cpu_usage());
    }
    if system.total_memory() > 0 {
        value["memoryTotalBytes"] = serde_json::json!(system.total_memory());
        value["memoryAvailableBytes"] = serde_json::json!(system.available_memory());
    }
    if system.total_swap() > 0 {
        value["swapTotalBytes"] = serde_json::json!(system.total_swap());
        value["swapFreeBytes"] = serde_json::json!(system.free_swap());
    }
    // Windows has no load average; sysinfo reports zeros there, which would be fabricated.
    #[cfg(not(windows))]
    {
        let load = sysinfo::System::load_average();
        value["loadAverage"] = serde_json::json!([load.one, load.five, load.fifteen]);
    }
    if let Some(home) = dirs::home_dir() {
        let disks = sysinfo::Disks::new_with_refreshed_list();
        let mounts = disks.list().iter().map(|disk| {
            (
                disk.mount_point(),
                disk.total_space(),
                disk.available_space(),
            )
        });
        if let Some((total, available)) = disk_space_for_path(&home, mounts) {
            value["diskTotalBytes"] = serde_json::json!(total);
            value["diskAvailableBytes"] = serde_json::json!(available);
        }
    }
    *previous = Some(now);
    Some(value)
}

/// The filesystem holding `path` is the mount with the longest matching prefix.
fn disk_space_for_path<'a>(
    path: &std::path::Path,
    mounts: impl Iterator<Item = (&'a std::path::Path, u64, u64)>,
) -> Option<(u64, u64)> {
    mounts
        .filter(|(mount, total, _)| *total > 0 && path.starts_with(mount))
        .max_by_key(|(mount, _, _)| mount.components().count())
        .map(|(_, total, available)| (total, available.min(total)))
}

#[cfg(test)]
mod machine_resource_tests {
    #[test]
    fn a_new_hub_connection_forgets_the_load_reported_to_the_last_one() {
        let mut reporter = super::DaemonRunProgressReporter::default();
        reporter.observe_connection(Some(3));
        reporter.resources = Some(vec![8, 4]);
        reporter.resources_at = Some(std::time::Instant::now());
        // The same connection, or none while reconnecting, keeps what it was told.
        reporter.observe_connection(Some(3));
        reporter.observe_connection(None);
        assert_eq!(reporter.resources, Some(vec![8, 4]));
        reporter.observe_connection(Some(4));
        assert_eq!(reporter.resources, None);
        assert_eq!(reporter.resources_at, None);
        assert_eq!(reporter.connection_epoch, Some(4));
    }

    #[test]
    fn resource_signature_ignores_noise_and_reports_material_change() {
        let sample = |cpu: f64, available: u64, load: f64| {
            serde_json::json!({ "observedAt": "2026-09-27T20:00:00Z", "cpuLogicalCount": 8,
                "cpuUsagePercent": cpu, "memoryTotalBytes": 1000, "memoryAvailableBytes": available,
                "diskTotalBytes": 100, "diskAvailableBytes": 40, "loadAverage": [load, 1.0, 1.0] })
        };
        let base = super::machine_resource_signature(&sample(41.0, 500, 2.1));
        assert_eq!(
            base,
            super::machine_resource_signature(&sample(44.0, 510, 2.2))
        );
        assert_ne!(
            base,
            super::machine_resource_signature(&sample(71.0, 500, 2.1))
        );
        assert_ne!(
            base,
            super::machine_resource_signature(&sample(41.0, 300, 2.1))
        );
        assert_ne!(
            base,
            super::machine_resource_signature(&sample(41.0, 500, 6.0))
        );
    }

    #[test]
    fn resource_sample_contains_only_numeric_measurements_and_capture_time() {
        let mut system = sysinfo::System::new();
        let mut previous = None;
        let now = std::time::Instant::now();
        let value = super::sample_machine_resources_at(&mut system, &mut previous, now)
            .expect("first observation");
        let fields = value.as_object().expect("object");
        assert!(fields.get("observedAt").and_then(|v| v.as_str()).is_some());
        for (key, value) in fields {
            assert!(
                [
                    "observedAt",
                    "cpuLogicalCount",
                    "cpuUsagePercent",
                    "memoryTotalBytes",
                    "memoryAvailableBytes",
                    "swapTotalBytes",
                    "swapFreeBytes",
                    "loadAverage",
                    "diskTotalBytes",
                    "diskAvailableBytes"
                ]
                .contains(&key.as_str())
            );
            if key == "loadAverage" {
                let load = value.as_array().expect("load average triple");
                assert_eq!(load.len(), 3);
                assert!(load.iter().all(serde_json::Value::is_number));
            } else if key != "observedAt" {
                assert!(value.is_number());
            }
        }
        assert!(
            fields.get("cpuUsagePercent").is_none(),
            "first CPU sample must not fabricate usage"
        );
        assert!(
            super::sample_machine_resources_at(&mut system, &mut previous, now).is_none(),
            "too-close samples must not report usage"
        );
        assert!(
            super::sample_machine_resources_at(
                &mut system,
                &mut previous,
                now + sysinfo::MINIMUM_CPU_UPDATE_INTERVAL
            )
            .is_some(),
            "samples at the interval boundary are allowed"
        );
    }

    #[test]
    fn disk_space_uses_the_deepest_mount_containing_the_path() {
        use std::path::Path;
        let mounts = [
            (Path::new("/"), 100, 40),
            (Path::new("/home"), 50, 60),
            (Path::new("/home2"), 10, 1),
            (Path::new("/home/user/empty"), 0, 0),
        ];
        assert_eq!(
            super::disk_space_for_path(Path::new("/home/user"), mounts.into_iter()),
            Some((50, 50)),
            "available space is clamped to the total"
        );
        assert_eq!(
            super::disk_space_for_path(Path::new("/opt"), mounts.into_iter()),
            Some((100, 40))
        );
        assert_eq!(
            super::disk_space_for_path(Path::new("/opt"), std::iter::empty()),
            None
        );
    }
}

#[cfg(test)]
mod handoff_export_tests {
    use super::*;

    fn git(cwd: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .env_remove("GIT_DIR")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_WORK_TREE")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    fn broker() -> DaemonAuthBroker {
        DaemonAuthBroker {
            url: "http://127.0.0.1:0".to_string(),
            session_reload_capability: "reload".to_string(),
            capabilities: Arc::new(Mutex::new(HashMap::new())),
            git_credentials: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn export() -> MachineHandoffExport {
        MachineHandoffExport {
            branch: "xmatrix/handoff/0123456789abcdef".to_string(),
            channel_id: "channel-1".to_string(),
        }
    }

    /// A stopped Run's checkout with uncommitted work, cloned from a bare remote.
    fn stopped_checkout() -> (PathBuf, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("xmatrix-handoff-export-{}", uuid::Uuid::new_v4()));
        let (remote, checkout) = (root.join("remote.git"), root.join("checkout"));
        std::fs::create_dir_all(&remote).unwrap();
        std::fs::create_dir_all(&checkout).unwrap();
        git(
            &remote,
            &["init", "--bare", "--quiet", "--initial-branch=main"],
        );
        git(&checkout, &["init", "--quiet", "--initial-branch=main"]);
        git(&checkout, &["config", "user.email", "test@example.com"]);
        git(&checkout, &["config", "user.name", "Test"]);
        std::fs::write(checkout.join("README.md"), "base\n").unwrap();
        git(&checkout, &["add", "."]);
        git(&checkout, &["commit", "--quiet", "-m", "base"]);
        git(
            &checkout,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&checkout, &["push", "--quiet", "origin", "main"]);
        std::fs::write(checkout.join("wip.txt"), "half done\n").unwrap();
        (remote, checkout)
    }

    fn source(cwd: PathBuf, repository: Option<&str>) -> HandoffExportSource {
        HandoffExportSource {
            cwd,
            repository: repository.map(str::to_string),
            run_id: "run-1".to_string(),
            execution_key: "exec-1".to_string(),
            label: "@claude:3".to_string(),
            retained: None,
        }
    }

    #[tokio::test]
    async fn sleeping_checkout_exports_after_its_child_registry_row_is_gone() {
        let (remote, base) = stopped_checkout();
        let pools = base.parent().unwrap().join("pools");
        std::fs::create_dir_all(&pools).unwrap();
        let repository = "https://github.com/acme/app";
        git(&base, &["remote", "set-url", "origin", repository]);
        git(
            &base,
            &[
                "config",
                &format!("url.{}.insteadOf", remote.display()),
                repository,
            ],
        );
        let identity = repo_pool::canonical_repo_identity(repository).unwrap();
        let key = repo_pool::repo_key_id(&identity);
        let layout = repo_pool::RepoPoolLayout::create(&pools, key.clone()).unwrap();
        let request = repo_pool::LeaseRequest {
            session_key: "session-1".into(),
            instance_id: "instance-1".into(),
            run_id: "run-1".into(),
            execution_key: "exec-1".into(),
        };
        let lease = repo_pool::lease_available_or_create_at(&layout, &base, repository, &request)
            .await
            .unwrap();
        std::fs::write(lease.worktree_path.join("draft.txt"), "sleeping work\n").unwrap();
        assert!(
            repo_pool::retain_exited_at(&layout, &request)
                .await
                .unwrap()
        );
        let registry: DaemonRunRegistry = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        assert!(
            handoff_export_source(&registry, Some("run-1"), Some("exec-1"))
                .await
                .is_none()
        );
        let source = retained_handoff_export_source_at(
            &pools,
            RetainedRunAuthority {
                run_id: Some("run-1"),
                execution_key: Some("exec-1"),
                instance_id: Some("instance-1"),
                resume_session_key: Some("session-1"),
                repo_identity: Some(identity.as_str()),
                repo_key_id: Some(key.as_str()),
                slot_id: Some(lease.slot_id.as_str()),
            },
        )
        .await
        .unwrap();
        let broker = broker();
        let result = export_handoff_after_stop(Some(source), &export(), Some(&broker)).await;
        assert_eq!(result.state, "pushed", "{result:?}");
        assert_eq!(
            git(
                &remote,
                &["show", &format!("{}:draft.txt", result.commit.unwrap())]
            ),
            "sleeping work"
        );
        assert!(broker.git_credentials.lock().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(base.parent().unwrap());
    }

    #[tokio::test]
    async fn a_stop_pushes_the_checkout_under_a_grant_that_ends_with_the_export() {
        if std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let (remote, checkout) = stopped_checkout();
        let broker = broker();
        let stopped: Result<(), ()> = Ok(());
        let result = handoff_export_for_stop(
            Some(&export()),
            &stopped,
            Some(source(checkout.clone(), Some("acme/app"))),
            Some(&broker),
        )
        .await
        .expect("an export was asked for");
        assert_eq!(result.state, "pushed", "{result:?}");
        assert!(result.dirty);
        let commit = result.commit.clone().unwrap();
        assert_eq!(
            git(
                &remote,
                &["rev-parse", "refs/heads/xmatrix/handoff/0123456789abcdef"]
            ),
            commit
        );
        assert_eq!(
            git(&remote, &["show", &format!("{commit}:wip.txt")]),
            "half done"
        );
        assert_eq!(
            result.base.as_deref(),
            Some(git(&checkout, &["rev-parse", "HEAD"]).as_str())
        );
        // The checkout is untouched and the grant is gone.
        assert_eq!(git(&checkout, &["status", "--porcelain"]), "?? wip.txt");
        assert!(broker.git_credentials.lock().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(remote.parent().unwrap());
    }

    #[tokio::test]
    async fn an_export_that_cannot_run_says_why_and_a_stop_without_one_reports_none() {
        let checkout = std::env::temp_dir();
        let broker = broker();
        let stopped: Result<(), ()> = Ok(());
        let failed: Result<(), ()> = Err(());
        for (stop, source, broker, reason) in [
            (
                &failed,
                Some(source(checkout.clone(), Some("acme/app"))),
                Some(&broker),
                "could not be stopped",
            ),
            (&stopped, None, Some(&broker), "not known to its daemon"),
            (
                &stopped,
                Some(source(checkout.clone(), None)),
                Some(&broker),
                "not a GitHub repository",
            ),
            (
                &stopped,
                Some(source(checkout.clone(), Some("acme/app"))),
                None,
                "no credential broker",
            ),
        ] {
            let result = handoff_export_for_stop(Some(&export()), stop, source, broker)
                .await
                .unwrap();
            assert_eq!(result.state, "failed");
            assert!(
                result.error.as_deref().unwrap_or_default().contains(reason),
                "{result:?}"
            );
        }
        let foreign = MachineHandoffExport {
            branch: "main".to_string(),
            channel_id: "channel-1".to_string(),
        };
        let result = handoff_export_for_stop(
            Some(&foreign),
            &stopped,
            Some(source(checkout.clone(), Some("acme/app"))),
            Some(&broker),
        )
        .await
        .unwrap();
        assert!(result.error.unwrap().contains("outside xmatrix/handoff/"));
        assert!(broker.git_credentials.lock().unwrap().is_empty());
        assert_eq!(
            handoff_export_for_stop(None, &stopped, None, Some(&broker)).await,
            None
        );
    }
}
