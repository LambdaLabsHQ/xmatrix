/// Hub workspace identity for a direct daemon-routed in-place spawn.
#[derive(Clone, Copy)]
struct DaemonRoutingWorkspace<'a> {
    machine_id: &'a str,
    canonical_cwd: &'a str,
    display_name: &'a str,
}

fn apply_spawn_workspace_env(
    command: &mut std::process::Command,
    routing_workspace: Option<DaemonRoutingWorkspace<'_>>,
    run_worktree_env: Option<&run_worktree::RunWorktreeSpawnEnv>,
) {
    // Drop inherited values first so a parent shell cannot leak workspace
    // identity into an unrelated spawn.
    command.env_remove(run_worktree::SPAWN_WORKSPACE_MACHINE_ID_ENV);
    command.env_remove(run_worktree::SPAWN_WORKSPACE_CWD_ENV);
    command.env_remove(run_worktree::SPAWN_WORKSPACE_NAME_ENV);
    command.env_remove(run_worktree::RUN_WORKTREE_BASE_REF_ENV);

    // Prefer materialized run-worktree env: it carries both natural base
    // workspace fields and the cut base ref for observability.
    if let Some(worktree_env) = run_worktree_env {
        command
            .env(
                run_worktree::SPAWN_WORKSPACE_MACHINE_ID_ENV,
                &worktree_env.base_machine_id,
            )
            .env(
                run_worktree::SPAWN_WORKSPACE_CWD_ENV,
                &worktree_env.base_canonical_cwd,
            )
            .env(
                run_worktree::RUN_WORKTREE_BASE_REF_ENV,
                &worktree_env.base_ref,
            );
        return;
    }
    if let Some(routing) = routing_workspace {
        command
            .env(
                run_worktree::SPAWN_WORKSPACE_MACHINE_ID_ENV,
                routing.machine_id,
            )
            .env(run_worktree::SPAWN_WORKSPACE_CWD_ENV, routing.canonical_cwd);
        let name = routing.display_name.trim();
        if !name.is_empty() {
            command.env(run_worktree::SPAWN_WORKSPACE_NAME_ENV, name);
        }
    }
}

/// Env names of the retired Role feature (reminder, frozen skills, App
/// requirements, Role avatar). Nothing sets them anymore; this bounded compat
/// scrub only keeps a value inherited from an older daemon or a stale local
/// profile from reaching a Run. Remove once no supported daemon writes them.
const RETIRED_ROLE_ENV: [&str; 5] = [
    "XMATRIX_AGENT_ROLE_REMINDER",
    "XMATRIX_AGENT_ROLE_SKILLS_CONTEXT_FILE",
    "XMATRIX_AGENT_ROLE_SKILLS_MANIFEST",
    "XMATRIX_AGENT_ROLE_APP_REQUIREMENTS_JSON",
    "XMATRIX_AGENT_AVATAR_URL",
];

/// Applies the registration's own instructions as the trusted initial prompt.
/// The env name predates the retired Role feature and is kept for
/// compatibility between daemon and wrapper builds.
fn apply_spawn_initial_prompt(
    mut local_env: BTreeMap<String, String>,
    initial_prompt: Option<&str>,
) -> BTreeMap<String, String> {
    // Hub launch data is authoritative for this Run. Remove stale prompt data
    // inherited from a machine-local profile before applying it.
    local_env.remove("XMATRIX_AGENT_PROFILE_IDENTITY");
    local_env.remove("XMATRIX_AGENT_ROLE_INITIAL_PROMPT");
    for key in RETIRED_ROLE_ENV {
        local_env.remove(key);
    }
    if let Some(initial_prompt) = initial_prompt
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        local_env.insert(
            "XMATRIX_AGENT_ROLE_INITIAL_PROMPT".to_string(),
            initial_prompt.to_string(),
        );
    }
    local_env
}

/// Applies the registration's working mode. Hub launch data is authoritative,
/// so a value inherited from a local profile never reaches the Run; a mode
/// this CLI does not know fails the launch instead of silently becoming
/// another one.
fn apply_spawn_working_mode(
    mut local_env: BTreeMap<String, String>,
    working_mode: Option<&str>,
) -> error::Result<BTreeMap<String, String>> {
    use xmatrix_cli_core::bootstrap::WorkingMode;
    local_env.remove(WorkingMode::ENV);
    if let Some(working_mode) = working_mode {
        WorkingMode::parse(working_mode).map_err(CliError::Launch)?;
        local_env.insert(WorkingMode::ENV.to_string(), working_mode.trim().to_string());
    }
    Ok(local_env)
}

/// Names the Space's rules page for the Run, replacing any value a local
/// profile left behind. The id goes into the launch prompt and a shell
/// command there, so anything but an opaque id fails the launch.
fn apply_spawn_space_rules(
    mut local_env: BTreeMap<String, String>,
    page_id: Option<&str>,
) -> error::Result<BTreeMap<String, String>> {
    use xmatrix_cli_core::bootstrap::SPACE_RULES_PAGE_ENV;
    local_env.remove(SPACE_RULES_PAGE_ENV);
    if let Some(page_id) = page_id {
        if !xmatrix_cli_core::bootstrap::is_opaque_page_id(page_id) {
            return Err(CliError::Launch(format!(
                "the Space rules page id `{page_id}` is not an opaque page id"
            )));
        }
        local_env.insert(SPACE_RULES_PAGE_ENV.to_string(), page_id.to_string());
    }
    Ok(local_env)
}

fn write_initial_message_attachments_file(
    attachments: Option<&[protocol::ChannelAttachment]>,
) -> error::Result<Option<PathBuf>> {
    let Some(attachments) = attachments.filter(|items| !items.is_empty()) else {
        return Ok(None);
    };

    let path = std::env::temp_dir().join(format!(
        "xmatrix-initial-attachments-{}.json",
        uuid::Uuid::new_v4()
    ));
    let bytes = serde_json::to_vec(attachments)?;
    std::fs::write(&path, bytes)?;
    Ok(Some(path))
}

fn daemon_run_registry_path() -> PathBuf {
    daemon_run_state_root().join("daemon-run-registry.json")
}

/// Where the daemon's Run recovery state lives.
///
/// A test that does not name a config directory must not reach the live
/// daemon's state: a unit test persisting its own one-row registry used to
/// overwrite the real registry, and a daemon restarting in that window found
/// no Runs to rehydrate.
fn daemon_run_state_root() -> PathBuf {
    #[cfg(test)]
    if std::env::var_os("XMATRIX_CONFIG_DIR").is_none()
        && config::active_profile_context().is_none()
    {
        static ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        return ROOT
            .get_or_init(|| {
                std::env::temp_dir()
                    .join(format!("xmatrix-runtime-test-state-{}", std::process::id()))
            })
            .clone();
    }
    config::profile_state_dir()
}

fn daemon_registry_audit_log_path() -> PathBuf {
    daemon_run_state_root()
        .join("logs")
        .join("daemon-registry.log")
}

fn set_daemon_private_file_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn set_daemon_private_dir_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn write_daemon_private_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(bytes)
}

fn append_daemon_registry_audit(event: &str) {
    if cfg!(test) {
        return;
    }
    let Ok(_guard) = DAEMON_REGISTRY_AUDIT_LOCK.lock() else {
        return;
    };
    let path = daemon_registry_audit_log_path();
    let Some(parent) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    if std::fs::metadata(&path)
        .map(|metadata| metadata.len() >= DAEMON_REGISTRY_AUDIT_MAX_BYTES)
        .unwrap_or(false)
    {
        let rotated = path.with_extension("log.1");
        let _ = std::fs::remove_file(&rotated);
        let _ = std::fs::rename(&path, rotated);
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let Ok(mut file) = options.open(&path) else {
        return;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
    }
    let _ = writeln!(file, "{} {event}", unix_millis_now());
}

fn persisted_daemon_run_from_child(managed: &DaemonRunChild) -> PersistedDaemonRun {
    PersistedDaemonRun {
        #[cfg(windows)]
        handoff: managed.handoff.as_ref().map(WindowsRunHandoff::persisted),
        pid: managed.pid,
        profile_id: config::active_profile_context().map(|profile| profile.id.as_str().to_string()),
        cwd: managed.cwd.clone(),
        run_id: managed.run_id.clone(),
        execution_key: managed.execution_key.clone(),
        instance_id: managed.instance_id.clone(),
        resume_session_key: managed.resume_session_key.clone(),
        repo_pool_binding: managed.repo_pool_binding.clone(),
        agent_id: managed.agent_id.clone(),
        agent_name: managed.agent_name.clone(),
        status_file_path: managed.status_file_path.clone(),
        stdout_log_path: managed.stdout_log_path.clone(),
        stderr_log_path: managed.stderr_log_path.clone(),
        // Persist the one-way digest of each grant. After #2540 that digest is
        // itself a presentable capability (a replacement daemon restores and
        // admits it), so the registry entry is a bearer credential for anyone
        // who can read profile_state_dir — the same boundary that already holds
        // the raw capability in the managed wrapper environment.
        auth_capability: managed.auth_capability.as_deref().map(|capability| {
            persisted_daemon_capability_key(capability)
                .unwrap_or_else(|| daemon_capability_key(capability))
        }),
        request_capability: managed.request_capability.as_deref().map(|capability| {
            persisted_daemon_capability_key(capability)
                .unwrap_or_else(|| daemon_capability_key(capability))
        }),
        request_context: managed.request_context.clone(),
        updated_at: config::unix_now_secs().to_string(),
    }
}

fn daemon_run_sidecar_path(run: &PersistedDaemonRun) -> Option<PathBuf> {
    let status_path = run.status_file_path.as_deref()?;
    daemon_run_sidecar_path_for_status(status_path)
}

fn daemon_run_sidecar_path_for_status(status_path: &Path) -> Option<PathBuf> {
    let label = daemon_run_status_file_label(status_path)?;
    Some(status_path.parent()?.join(format!("{label}.registry.json")))
}

fn persist_daemon_run_sidecar(run: &PersistedDaemonRun) -> bool {
    let Some(path) = daemon_run_sidecar_path(run) else {
        return false;
    };
    let Ok(bytes) = serde_json::to_vec_pretty(run) else {
        return false;
    };
    let tmp_path = config::unique_temporary_path(&path);
    if write_daemon_private_file(&tmp_path, &bytes).is_err() {
        let _ = std::fs::remove_file(&tmp_path);
        return false;
    }
    if config::replace_file_atomically(&tmp_path, &path).is_err() {
        let _ = std::fs::remove_file(&tmp_path);
        return false;
    }
    set_daemon_private_file_permissions(&path);
    true
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DaemonRunSidecarRemoval {
    Removed,
    Missing,
    Failed,
}

fn remove_daemon_run_sidecar(run: &PersistedDaemonRun) -> Option<DaemonRunSidecarRemoval> {
    let path = daemon_run_sidecar_path(run)?;
    #[cfg(windows)]
    if let Some(status_path) = run.status_file_path.as_deref() {
        runtime_windows_run_adoption::remove_evidence(status_path);
    }
    Some(remove_daemon_run_sidecar_path(&path, run.pid))
}

fn remove_daemon_run_sidecar_path(path: &Path, pid: u32) -> DaemonRunSidecarRemoval {
    match std::fs::remove_file(path) {
        Ok(()) => DaemonRunSidecarRemoval::Removed,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => DaemonRunSidecarRemoval::Missing,
        Err(err) => {
            append_daemon_registry_audit(&format!(
                "sidecar_remove_failed pid={} path={} error={err}",
                pid,
                path.display()
            ));
            DaemonRunSidecarRemoval::Failed
        }
    }
}

fn orphan_sidecar_removed_audit_event(
    pid: u32,
    path: &Path,
    outcome: DaemonRunSidecarRemoval,
) -> Option<String> {
    match outcome {
        DaemonRunSidecarRemoval::Removed => Some(format!(
            "orphan_sidecar_removed pid={pid} path={}",
            path.display()
        )),
        DaemonRunSidecarRemoval::Missing | DaemonRunSidecarRemoval::Failed => None,
    }
}

fn read_daemon_run_sidecars_from_dir(dir: &Path) -> Vec<PersistedDaemonRun> {
    config::daemon_run_sidecar_paths(dir)
        .filter_map(|path| {
            let raw = std::fs::read_to_string(&path).ok()?;
            match serde_json::from_str::<PersistedDaemonRun>(&raw) {
                Ok(run) if daemon_run_sidecar_path(&run).as_deref() == Some(path.as_path()) => {
                    Some(run)
                }
                Ok(run) => {
                    append_daemon_registry_audit(&format!(
                        "sidecar_path_mismatch path={} expected={}",
                        path.display(),
                        daemon_run_sidecar_path(&run)
                            .map(|expected| expected.display().to_string())
                            .unwrap_or_else(|| "none".to_string())
                    ));
                    None
                }
                Err(err) => {
                    append_daemon_registry_audit(&format!(
                        "sidecar_parse_failed path={} error={err}",
                        path.display()
                    ));
                    None
                }
            }
        })
        .collect()
}

fn daemon_run_sidecar_is_recoverable(run: &PersistedDaemonRun) -> bool {
    if run.run_id.is_none() && run.execution_key.is_none() {
        return false;
    }
    let Some(marker) = read_daemon_run_status_marker(run.status_file_path.as_deref()) else {
        return false;
    };
    #[cfg(windows)]
    if let Some(receipt) = run.handoff.as_ref() {
        let evidence = &receipt.previous_evidence;
        if daemon_run_recovery_files_are_private(run)
            && run.run_id.as_deref() == Some(evidence.run_id.as_str())
            && run.execution_key.as_deref() == Some(evidence.execution_key.as_str())
            && run.instance_id.as_deref() == Some(evidence.instance_id.as_str())
            && evidence.validate().is_ok()
            && runtime_windows_run_adoption::process_birth_id(evidence.pid).ok()
                == Some(evidence.process_birth_id)
        {
            return true;
        }
    }
    daemon_run_recovery_files_are_private(run)
        && marker.pid == run.pid
        && daemon_run_status_age_within(&marker, DAEMON_RUN_RECOVERY_MAX_AGE_MILLIS)
        && crate::process_tree::process_alive(run.pid)
}

#[cfg(unix)]
fn daemon_run_recovery_files_are_private(run: &PersistedDaemonRun) -> bool {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};

    let Some(status_path) = run.status_file_path.as_deref() else {
        return false;
    };
    let Some(sidecar_path) = daemon_run_sidecar_path(run) else {
        return false;
    };
    let Some(dir) = status_path.parent() else {
        return false;
    };
    let expected_uid = unsafe { libc::geteuid() };
    let owned_private = |path: &Path, expect_dir: bool| {
        std::fs::symlink_metadata(path)
            .map(|metadata| {
                metadata.uid() == expected_uid
                    && if expect_dir {
                        metadata.is_dir()
                    } else {
                        metadata.is_file()
                    }
                    && metadata.permissions().mode() & 0o022 == 0
            })
            .unwrap_or(false)
    };
    owned_private(dir, true)
        && owned_private(status_path, false)
        && owned_private(&sidecar_path, false)
}

#[cfg(not(unix))]
fn daemon_run_recovery_files_are_private(_run: &PersistedDaemonRun) -> bool {
    true
}

fn daemon_auth_broker_state_path() -> PathBuf {
    config::profile_state_dir().join("daemon-auth-broker.json")
}

fn daemon_ready_state_path() -> PathBuf {
    config::config_dir().join("daemon-ready.json")
}

fn persist_daemon_ready_state(profile_manager: &ProfileManager) -> error::Result<()> {
    let path = daemon_ready_state_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let current_exe = std::env::current_exe()
        .map_err(|err| CliError::Launch(format!("failed to resolve daemon executable: {err}")))?;
    let snapshot = profile_manager.snapshot()?;
    let profile_summary = snapshot
        .profiles
        .iter()
        .map(|profile| {
            serde_json::json!({
                "profileId": profile.profile_id,
                "name": profile.name,
                "hubUrl": profile.hub_url,
                "state": runtime_daemon_host::lifecycle_label(profile.lifecycle),
                "detail": profile.detail,
            })
        })
        .collect::<Vec<_>>();
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({
        "version": xmatrix_cli_core::version::current(),
        "pid": std::process::id(),
        "executablePath": current_exe,
        "generation": snapshot.generation,
        "loadedRegistryRevision": snapshot.loaded_registry_revision,
        "defaultProfileId": snapshot.default_profile_id,
        "profileInitializationSummary": profile_summary,
        "updatedAt": config::unix_now_secs().to_string(),
    }))?;
    let temporary = config::unique_temporary_path(&path);
    if let Err(err) = write_daemon_private_file(&temporary, &bytes)
        .and_then(|()| config::replace_file_atomically(&temporary, &path))
    {
        let _ = std::fs::remove_file(&temporary);
        return Err(CliError::Io(err));
    }
    set_daemon_private_file_permissions(&path);
    Ok(())
}

fn seal_daemon_host_update_recovery(profile_manager: &ProfileManager) -> error::Result<()> {
    const MAX_RECOVERY_FILE_BYTES: u64 = 16 * 1024 * 1024;
    const MAX_RECOVERY_DIRECTORY_ENTRIES: usize = 20_000;
    const MAX_RECOVERY_SIDECARS: usize = 10_000;

    let store =
        xmatrix_cli_core::profile::ProfileStore::new(profile_manager.installation().clone());
    let registry = store.load_or_bootstrap()?;
    let snapshot = profile_manager.snapshot()?;
    if snapshot.loaded_registry_revision != registry.revision
        || snapshot.default_profile_id != registry.default_profile_id
    {
        return Err(CliError::Launch(
            "Profile registry changed while sealing daemon update recovery".into(),
        ));
    }
    let mut profiles = Vec::new();
    for context in store.enabled_contexts(&registry)? {
        let config_path = context.state_root.join("config.json");
        let machine_id = read_bounded_recovery_json(&config_path, MAX_RECOVERY_FILE_BYTES)?
            .and_then(|value| {
                value
                    .get("machineId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            });
        let run_registry_path = context.state_root.join("daemon-run-registry.json");
        let run_registry =
            digest_bounded_recovery_file(&run_registry_path, MAX_RECOVERY_FILE_BYTES)?;
        let runs_root = context.state_root.join("runs");
        let sidecars = collect_run_recovery_sidecars(
            &runs_root,
            &context.id,
            MAX_RECOVERY_FILE_BYTES,
            MAX_RECOVERY_DIRECTORY_ENTRIES,
            MAX_RECOVERY_SIDECARS,
        )?;
        profiles.push(serde_json::json!({
            "profileId": context.id,
            "hubOrigin": context.hub_origin,
            "stateKind": context.state_kind,
            "machineId": machine_id,
            "runRegistry": run_registry.map(|(sha256, bytes)| serde_json::json!({
                "sha256": sha256,
                "bytes": bytes,
            })),
            "runSidecars": sidecars,
        }));
    }
    xmatrix_cli_core::daemon_host::persist_update_recovery_state(
        profile_manager.installation(),
        &serde_json::json!({
            "schemaVersion": 1,
            "generation": snapshot.generation,
            "executablePath": std::env::current_exe()?,
            "registryRevision": registry.revision,
            "defaultProfileId": registry.default_profile_id,
            "profiles": profiles,
            "sealedAt": config::unix_now_secs().to_string(),
        }),
    )
}

fn collect_run_recovery_sidecars(
    runs_root: &Path,
    profile_id: &xmatrix_cli_core::profile::ProfileId,
    max_file_bytes: u64,
    max_directory_entries: usize,
    max_sidecars: usize,
) -> error::Result<Vec<serde_json::Value>> {
    let mut sidecars = Vec::new();
    let mut scanned_entries = 0_usize;
    match std::fs::symlink_metadata(runs_root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(CliError::Launch(format!(
                "Unsafe Run recovery root for profile {profile_id}"
            )));
        }
        Ok(_) => {
            for entry in std::fs::read_dir(runs_root)? {
                let entry = entry?;
                scanned_entries = scanned_entries.saturating_add(1);
                if scanned_entries > max_directory_entries {
                    return Err(CliError::Launch(format!(
                        "Too many Run recovery directory entries for profile {profile_id}"
                    )));
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.ends_with(".registry.json") {
                    continue;
                }
                if sidecars.len() >= max_sidecars {
                    return Err(CliError::Launch(format!(
                        "Too many Run recovery sidecars for profile {profile_id}"
                    )));
                }
                let Some((sha256, bytes)) =
                    digest_bounded_recovery_file(&entry.path(), max_file_bytes)?
                else {
                    continue;
                };
                sidecars.push(serde_json::json!({
                    "name": name,
                    "sha256": sha256,
                    "bytes": bytes,
                }));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(CliError::Io(error)),
    }
    sidecars.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
    Ok(sidecars)
}

fn read_bounded_recovery_json(
    path: &Path,
    max_bytes: u64,
) -> error::Result<Option<serde_json::Value>> {
    let bytes = match read_bounded_recovery_file(path, max_bytes)? {
        Some(bytes) => bytes,
        None => return Ok(None),
    };
    serde_json::from_slice(&bytes).map(Some).map_err(Into::into)
}

fn digest_bounded_recovery_file(
    path: &Path,
    max_bytes: u64,
) -> error::Result<Option<(String, u64)>> {
    let Some(bytes) = read_bounded_recovery_file(path, max_bytes)? else {
        return Ok(None);
    };
    let digest = lowercase_hex(&Sha256::digest(&bytes));
    Ok(Some((digest, bytes.len() as u64)))
}

fn read_bounded_recovery_file(path: &Path, max_bytes: u64) -> error::Result<Option<Vec<u8>>> {
    let Some(metadata) = xmatrix_cli_core::fs::metadata_if_exists(path).map_err(CliError::Io)?
    else {
        return Ok(None);
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > max_bytes {
        return Err(CliError::Launch(format!(
            "Unsafe or oversized daemon recovery file {}",
            path.display()
        )));
    }
    Ok(Some(std::fs::read(path)?))
}

fn persist_daemon_auth_broker_state(url: &str, session_reload_capability: &str) {
    // Also record the locator in the one place every reader is moving to. The
    // per-broker file stays until that record is proven in production, so a
    // failure here degrades to the old path instead of losing the daemon.
    if let Err(error) = xmatrix_cli_core::daemon_record::update_record(|record| {
        record.auth_broker_url = Some(url.to_string());
    }) {
        eprintln!("⚠ daemon record could not record the auth broker locator: {error}");
    }
    let path = daemon_auth_broker_state_path();
    if let Some(parent) = path.parent()
        && let Err(err) = std::fs::create_dir_all(parent) {
            eprintln!(
                "{} failed to create daemon auth broker state directory: {err}",
                "⚠".yellow().bold()
            );
            return;
        }
    let state = DaemonAuthBrokerState {
        url: url.to_string(),
        updated_at: config::unix_now_secs().to_string(),
        session_reload_capability: Some(session_reload_capability.to_string()),
    };
    let bytes = match serde_json::to_vec_pretty(&state) {
        Ok(bytes) => bytes,
        Err(err) => {
            eprintln!(
                "{} failed to serialize daemon auth broker state: {err}",
                "⚠".yellow().bold()
            );
            return;
        }
    };
    let tmp_path = config::unique_temporary_path(&path);
    if let Err(err) = write_daemon_private_file(&tmp_path, &bytes).and_then(|()| {
        config::replace_file_atomically(&tmp_path, &path)?;
        set_daemon_private_file_permissions(&path);
        Ok(())
    }) {
        let _ = std::fs::remove_file(&tmp_path);
        eprintln!(
            "{} failed to persist daemon auth broker state: {err}",
            "⚠".yellow().bold()
        );
    }
}

fn read_daemon_auth_broker_state() -> Option<DaemonAuthBrokerState> {
    let path = daemon_auth_broker_state_path();
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return None,
        Err(err) => {
            eprintln!(
                "{} failed to read daemon auth broker state: {err}",
                "⚠".yellow().bold()
            );
            return None;
        }
    };
    match serde_json::from_str::<DaemonAuthBrokerState>(&text) {
        Ok(state) => Some(state),
        Err(err) => {
            eprintln!(
                "{} failed to parse daemon auth broker state: {err}",
                "⚠".yellow().bold()
            );
            None
        }
    }
}

fn persisted_daemon_run_key(run: &PersistedDaemonRun) -> String {
    run.run_id
        .as_ref()
        .map(|value| daemon_run_key("run", value))
        .or_else(|| {
            run.execution_key
                .as_ref()
                .map(|value| daemon_run_key("execution", value))
        })
        .unwrap_or_else(|| daemon_run_key("pid", &run.pid.to_string()))
}

fn normalized_persisted_daemon_runs(mut runs: Vec<PersistedDaemonRun>) -> Vec<PersistedDaemonRun> {
    for run in &mut runs {
        run.updated_at.clear();
    }
    runs.sort_by_key(persisted_daemon_run_key);
    runs
}

fn persisted_daemon_run_snapshots_match(
    left: Vec<PersistedDaemonRun>,
    right: Vec<PersistedDaemonRun>,
) -> bool {
    normalized_persisted_daemon_runs(left) == normalized_persisted_daemon_runs(right)
}

fn persisted_daemon_run_sidecars_match(expected: &[PersistedDaemonRun]) -> bool {
    expected.iter().all(|run| {
        let Some(path) = daemon_run_sidecar_path(run) else {
            return run.status_file_path.is_none();
        };
        let Some(observed) = std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<PersistedDaemonRun>(&raw).ok())
        else {
            return false;
        };
        persisted_daemon_run_snapshots_match(vec![observed], vec![run.clone()])
    })
}

fn persist_daemon_run_registry_locked(guard: &HashMap<String, DaemonRunChild>) -> bool {
    let path = daemon_run_registry_path();
    let runs = guard
        .values()
        .map(persisted_daemon_run_from_child)
        .collect::<Vec<_>>();
    for run in &runs {
        if run.status_file_path.is_some() && !persist_daemon_run_sidecar(run) {
            append_daemon_registry_audit(&format!(
                "sidecar_persist_failed pid={} run={}",
                run.pid,
                run.run_id.as_deref().unwrap_or("unknown")
            ));
        }
    }
    if let Some(parent) = path.parent()
        && let Err(err) = std::fs::create_dir_all(parent) {
            eprintln!(
                "{} failed to create daemon run registry directory: {err}",
                "⚠".yellow().bold()
            );
            append_daemon_registry_audit(&format!(
                "registry_persist_failed stage=create_dir error={err}"
            ));
            return false;
        }
    let tmp_path = config::unique_temporary_path(&path);
    let bytes = match serde_json::to_vec_pretty(&runs) {
        Ok(bytes) => bytes,
        Err(err) => {
            eprintln!(
                "{} failed to serialize daemon run registry: {err}",
                "⚠".yellow().bold()
            );
            append_daemon_registry_audit(&format!(
                "registry_persist_failed stage=serialize error={err}"
            ));
            return false;
        }
    };
    if let Err(err) = write_daemon_private_file(&tmp_path, &bytes)
        .and_then(|()| config::replace_file_atomically(&tmp_path, &path))
    {
        let _ = std::fs::remove_file(&tmp_path);
        eprintln!(
            "{} failed to persist daemon run registry: {err}",
            "⚠".yellow().bold()
        );
        append_daemon_registry_audit(&format!(
            "registry_persist_failed stage=promote runs={} error={err}",
            runs.len()
        ));
        return false;
    }
    true
}

async fn reconcile_daemon_run_registry(registry: &DaemonRunRegistry) {
    let guard = registry.lock().await;
    let expected = guard
        .values()
        .map(persisted_daemon_run_from_child)
        .collect::<Vec<_>>();
    let path = daemon_run_registry_path();
    let observed = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<PersistedDaemonRun>>(&raw).ok());
    let registry_matches = observed
        .as_ref()
        .is_some_and(|runs| persisted_daemon_run_snapshots_match(runs.clone(), expected.clone()));
    if registry_matches && persisted_daemon_run_sidecars_match(&expected) {
        return;
    }

    let observed_count = observed.as_ref().map(Vec::len);
    if persist_daemon_run_registry_locked(&guard) {
        append_daemon_registry_audit(&format!(
            "registry_reconciled observed={} expected={}",
            observed_count
                .map(|count| count.to_string())
                .unwrap_or_else(|| "missing_or_invalid".to_string()),
            expected.len()
        ));
    }
}

fn restore_daemon_run_grants(
    child: &mut DaemonRunChild,
    run: &PersistedDaemonRun,
    auth_broker: Option<&DaemonAuthBroker>,
    request_broker: Option<&DaemonRequestBroker>,
) -> bool {
    let mut restored = false;
    if child._auth_grant.is_none()
        && let (Some(broker), Some(context)) = (auth_broker, run.request_context.as_ref())
            && let (Some(agent_id), Some(run_id), Some(execution_key)) = (
                context.agent_id.as_deref(),
                context.run_id.as_deref(),
                context.execution_key.as_deref(),
            ) {
                let grant = run.auth_capability.as_ref().and_then(|capability_key| {
                    broker.restore_grant_key(
                        capability_key.clone(),
                        DaemonAgentAuthContext {
                            agent_id: agent_id.to_string(),
                            agent_name: context.agent_name.clone(),
                            space_id: context.space_id.clone(),
                            channel_id: context.channel_id.clone(),
                            run_id: run_id.to_string(),
                            execution_key: execution_key.to_string(),
                        },
                    )
                });
                if let Some(grant) = grant {
                    child.auth_capability = run.auth_capability.clone();
                    child._auth_grant = Some(grant);
                    restored = true;
                }
            }
    if child._request_grant.is_none()
        && let (Some(broker), Some(context), Some(capability_key)) = (
            request_broker,
            run.request_context.clone(),
            run.request_capability.clone(),
        )
            && let Some(grant) = broker.restore_agent_grant_key(capability_key.clone(), context) {
                child.request_capability = Some(capability_key);
                child._request_grant = Some(grant);
                restored = true;
            }
    restored
}

fn daemon_run_child_from_persisted(
    run: PersistedDaemonRun,
    auth_broker: Option<&DaemonAuthBroker>,
    request_broker: Option<&DaemonRequestBroker>,
) -> DaemonRunChild {
    let mut child = DaemonRunChild {
        #[cfg(windows)]
        handoff: None,
        child: None,
        process_tree: None,
        pid: run.pid,
        stop_in_progress: false,
        exit_audited: false,
        cwd: run.cwd.clone(),
        run_id: run.run_id.clone(),
        execution_key: run.execution_key.clone(),
        instance_id: run.instance_id.clone(),
        resume_session_key: run.resume_session_key.clone(),
        repo_pool_binding: run.repo_pool_binding.clone(),
        agent_id: run.agent_id.clone(),
        agent_name: run.agent_name.clone(),
        auth_capability: None,
        request_capability: None,
        request_context: run.request_context.clone(),
        status_file_path: run.status_file_path.clone(),
        stdout_log_path: run.stdout_log_path.clone(),
        stderr_log_path: run.stderr_log_path.clone(),
        _auth_grant: None,
        _request_grant: None,
    };
    let _ = restore_daemon_run_grants(&mut child, &run, auth_broker, request_broker);
    retain_unrestored_daemon_run_grant_keys(&mut child, &run);
    #[cfg(windows)]
    if let Some(receipt) = run.handoff {
        recover_windows_run_handoff(&mut child, receipt);
    }
    child
}

/// Keep a recovery record's verifier keys when they did not restore a grant.
///
/// The keys are the only evidence that can ever re-admit a live Run's
/// wrapper. Writing the recovered row back without them erased that evidence
/// from the sidecar and the registry for good, so one failed restore left the
/// Run unable to send for the rest of its life. Retained, a later sidecar pass
/// can still restore them, and nothing is admitted until one does.
fn retain_unrestored_daemon_run_grant_keys(child: &mut DaemonRunChild, run: &PersistedDaemonRun) {
    let auth_missing = child._auth_grant.is_none();
    let request_missing = child._request_grant.is_none();
    if auth_missing && child.auth_capability.is_none() {
        child.auth_capability = run.auth_capability.clone();
    }
    if request_missing && child.request_capability.is_none() {
        child.request_capability = run.request_capability.clone();
    }
    if (auth_missing || request_missing) && run.request_context.is_some() {
        let describe = |missing: bool, key: &Option<String>| match (missing, key) {
            (false, _) => "restored",
            (true, Some(_)) => "unrestored",
            (true, None) => "missing",
        };
        append_daemon_registry_audit(&format!(
            "grant_restore_incomplete pid={} run={} auth={} request={}",
            run.pid,
            run.run_id.as_deref().unwrap_or("unknown"),
            describe(auth_missing, &run.auth_capability),
            describe(request_missing, &run.request_capability),
        ));
    }
}

async fn recover_daemon_run_registry_from_sidecars_in_dir(
    registry: &DaemonRunRegistry,
    dir: &Path,
    auth_broker: Option<&DaemonAuthBroker>,
    request_broker: Option<&DaemonRequestBroker>,
    persist_global: bool,
) -> usize {
    let candidates = read_daemon_run_sidecars_from_dir(dir);
    if candidates.is_empty() {
        return 0;
    }
    let mut guard = registry.lock().await;
    let mut recovered = 0;
    let mut restored = 0;
    for run in candidates {
        if !persisted_profile_lineage_matches(
            run.profile_id.as_deref(),
            config::active_profile_context().as_ref(),
        ) {
            append_daemon_registry_audit(&format!(
                "sidecar_profile_mismatch pid={} run={}",
                run.pid,
                run.run_id.as_deref().unwrap_or("unknown")
            ));
            continue;
        }
        let key = persisted_daemon_run_key(&run);
        if !daemon_run_sidecar_is_recoverable(&run) {
            continue;
        }
        if let Some(existing) = guard.get_mut(&key) {
            if existing.pid == run.pid
                && restore_daemon_run_grants(existing, &run, auth_broker, request_broker) {
                    restored += 1;
                }
            continue;
        }
        append_daemon_registry_audit(&format!(
            "sidecar_recovered key={key} pid={} run={}",
            run.pid,
            run.run_id.as_deref().unwrap_or("unknown")
        ));
        guard.insert(
            key,
            daemon_run_child_from_persisted(run, auth_broker, request_broker),
        );
        recovered += 1;
    }
    // A replacement daemon can load the global row before the previous daemon
    // finishes writing its per-run sidecar. When that late sidecar supplies the
    // immutable Run context and capability verifier keys, persist the recovered
    // row as well so subsequent handoffs retain the same exact-scope proof.
    if (recovered > 0 || restored > 0) && persist_global {
        persist_daemon_run_registry_locked(&guard);
    }
    recovered
}

async fn rehydrate_daemon_run_registry_from_persisted_runs(
    registry: &DaemonRunRegistry,
    persisted: Vec<PersistedDaemonRun>,
    auth_broker: Option<&DaemonAuthBroker>,
    request_broker: Option<&DaemonRequestBroker>,
    persist_global: bool,
) -> usize {
    let mut guard = registry.lock().await;
    let mut loaded = 0;
    for run in persisted {
        if !persisted_profile_lineage_matches(
            run.profile_id.as_deref(),
            config::active_profile_context().as_ref(),
        ) {
            append_daemon_registry_audit(&format!(
                "registry_profile_mismatch pid={} run={}",
                run.pid,
                run.run_id.as_deref().unwrap_or("unknown")
            ));
            continue;
        }
        let root_alive = crate::process_tree::process_alive(run.pid);
        let key = persisted_daemon_run_key(&run);
        append_daemon_registry_audit(&format!(
            "rehydrated key={key} pid={} run={} root_alive={root_alive}",
            run.pid,
            run.run_id.as_deref().unwrap_or("unknown")
        ));
        // A dead wrapper can still own live descendants. Keep its durable row
        // so the child monitor performs full tree cleanup before reporting the
        // terminal run and removing the sidecar.
        guard.insert(
            key,
            daemon_run_child_from_persisted(run, auth_broker, request_broker),
        );
        loaded += 1;
    }
    if persist_global {
        persist_daemon_run_registry_locked(&guard);
    }
    loaded
}

fn persisted_profile_lineage_matches(
    persisted_profile_id: Option<&str>,
    admitted: Option<&xmatrix_cli_core::profile::ProfileContext>,
) -> bool {
    let Some(admitted) = admitted else {
        return true;
    };
    match persisted_profile_id {
        Some(profile_id) => profile_id == admitted.id.as_str(),
        None => admitted.state_kind == xmatrix_cli_core::profile::ProfileStateKind::LegacyRoot,
    }
}

async fn rehydrate_daemon_run_registry(
    registry: &DaemonRunRegistry,
    auth_broker: Option<&DaemonAuthBroker>,
    request_broker: Option<&DaemonRequestBroker>,
) {
    if daemon_run_log_dir_is_default() {
        let dir = daemon_run_log_dir();
        if std::fs::create_dir_all(&dir).is_ok() {
            set_daemon_private_dir_permissions(&dir);
        }
    }
    let path = daemon_run_registry_path();
    let persisted = match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Vec<PersistedDaemonRun>>(&text) {
            Ok(runs) => runs,
            Err(err) => {
                eprintln!(
                    "{} failed to parse daemon run registry: {err}",
                    "⚠".yellow().bold()
                );
                append_daemon_registry_audit(&format!("registry_parse_failed error={err}"));
                Vec::new()
            }
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(err) => {
            eprintln!(
                "{} failed to read daemon run registry: {err}",
                "⚠".yellow().bold()
            );
            append_daemon_registry_audit(&format!("registry_read_failed error={err}"));
            Vec::new()
        }
    };

    let loaded = rehydrate_daemon_run_registry_from_persisted_runs(
        registry,
        persisted,
        auth_broker,
        request_broker,
        true,
    )
    .await;
    let recovered = recover_daemon_run_registry_from_sidecars_in_dir(
        registry,
        &daemon_run_log_dir(),
        auth_broker,
        request_broker,
        true,
    )
    .await;
    append_daemon_registry_audit(&format!(
        "rehydrate_complete loaded={loaded} recovered={recovered}"
    ));
}

fn terminate_daemon_pid(pid: u32) -> error::Result<()> {
    match process_tree::terminate_process_tree(pid) {
        Ok(()) => Ok(()),
        Err(err)
            if process_tree::termination_target_is_gone(&err)
                && !process_tree::process_alive(pid) =>
        {
            Ok(())
        }
        Err(err) => Err(CliError::Launch(format!(
            "failed to terminate process tree {pid}: {err}"
        ))),
    }
}

fn daemon_repo_pool_layout(
    binding: &DaemonRepoPoolBinding,
) -> error::Result<repo_pool::RepoPoolLayout> {
    let identity =
        repo_pool::canonical_repo_identity(&binding.canonical_repo_identity).map_err(|error| {
            CliError::Launch(format!("invalid persisted repo pool identity ({error})"))
        })?;
    if repo_pool::repo_key_id(&identity).as_str() != binding.repo_key_id {
        return Err(CliError::Launch(
            "persisted repo pool key does not match its canonical identity".into(),
        ));
    }
    let pools_root = repo_pool::default_repo_pools_root()
        .map_err(|error| CliError::Launch(format!("repo pool root unavailable ({error})")))?;
    repo_pool::RepoPoolLayout::from_persisted(&pools_root, &binding.repo_key_id)
        .map_err(|error| CliError::Launch(format!("persisted repo pool layout invalid ({error})")))
}

fn daemon_repo_pool_request(managed: &DaemonRunChild) -> error::Result<repo_pool::LeaseRequest> {
    Ok(repo_pool::LeaseRequest {
        session_key: managed.resume_session_key.clone().ok_or_else(|| {
            CliError::Launch("repo pool registry row is missing sessionKey".into())
        })?,
        instance_id: managed.instance_id.clone().ok_or_else(|| {
            CliError::Launch("repo pool registry row is missing instanceId".into())
        })?,
        run_id: managed
            .run_id
            .clone()
            .ok_or_else(|| CliError::Launch("repo pool registry row is missing runId".into()))?,
        execution_key: managed.execution_key.clone().ok_or_else(|| {
            CliError::Launch("repo pool registry row is missing executionKey".into())
        })?,
    })
}

fn daemon_repo_pool_run_authority(
    managed: &DaemonRunChild,
) -> error::Result<Option<DaemonRepoPoolRunAuthority>> {
    let Some(binding) = managed.repo_pool_binding.clone() else {
        return Ok(None);
    };
    Ok(Some(DaemonRepoPoolRunAuthority {
        binding,
        request: daemon_repo_pool_request(managed)?,
    }))
}

async fn settle_repo_pool_after_failed_spawn(managed: &DaemonRunChild) -> error::Result<()> {
    let Some(binding) = managed.repo_pool_binding.as_ref() else {
        return Ok(());
    };
    let layout = daemon_repo_pool_layout(binding)?;
    let request = daemon_repo_pool_request(managed)?;
    let result = if binding.resumed {
        repo_pool::mark_retained_at(&layout, &request).await
    } else {
        repo_pool::return_abandoned_authority_at(
            &layout,
            &binding.base_repo,
            &repo_pool::BindingAuthority {
                session_key: request.session_key.clone(),
                instance_id: request.instance_id.clone(),
                run_id: request.run_id.clone(),
                execution_key: request.execution_key.clone(),
                slot_id: binding.slot_id.clone(),
            },
        )
        .await
    };
    result.map_err(|error| CliError::Launch(format!("repo pool rollback failed ({error})")))
}

async fn retain_repo_pool_authority(authority: &DaemonRepoPoolRunAuthority) -> error::Result<()> {
    let layout = daemon_repo_pool_layout(&authority.binding)?;
    repo_pool::mark_retained_at(&layout, &authority.request)
        .await
        .map_err(|error| CliError::Launch(format!("repo pool retain failed ({error})")))
}

/// `Ok(false)`: the session's slot was rebound to a successor Run, so this
/// exited Run has nothing to retain.
async fn retain_exited_repo_pool_authority(
    authority: &DaemonRepoPoolRunAuthority,
) -> error::Result<bool> {
    let layout = daemon_repo_pool_layout(&authority.binding)?;
    repo_pool::retain_exited_at(&layout, &authority.request)
        .await
        .map_err(|error| CliError::Launch(format!("repo pool retain failed ({error})")))
}

async fn abandon_repo_pool_authority(authority: &DaemonRepoPoolRunAuthority) -> error::Result<()> {
    let layout = daemon_repo_pool_layout(&authority.binding)?;
    repo_pool::return_abandoned_authority_at(
        &layout,
        &authority.binding.base_repo,
        &authority.binding_authority(),
    )
    .await
    .map_err(|error| CliError::Launch(format!("repo pool abandon failed ({error})")))
}

async fn repo_pool_return_receipt_matches(
    authority: &DaemonRepoPoolRunAuthority,
) -> error::Result<bool> {
    let layout = daemon_repo_pool_layout(&authority.binding)?;
    repo_pool::completed_return_receipt_matches_at(&layout, &authority.binding_authority())
        .await
        .map_err(|error| {
            CliError::Launch(format!("repo pool return receipt check failed ({error})"))
        })
}

async fn reconcile_completed_repo_pool_return(
    registry: &DaemonRunRegistry,
    key: &str,
    authority: &DaemonRepoPoolRunAuthority,
) -> error::Result<bool> {
    let layout = daemon_repo_pool_layout(&authority.binding)?;
    reconcile_completed_repo_pool_return_at(
        registry,
        key,
        authority,
        &layout,
        persist_daemon_run_registry_locked,
    )
    .await
}

async fn reconcile_completed_repo_pool_return_at<F>(
    registry: &DaemonRunRegistry,
    key: &str,
    authority: &DaemonRepoPoolRunAuthority,
    layout: &repo_pool::RepoPoolLayout,
    persist_registry: F,
) -> error::Result<bool>
where
    F: Fn(&HashMap<String, DaemonRunChild>) -> bool,
{
    let receipt_matches =
        repo_pool::completed_return_receipt_matches_at(layout, &authority.binding_authority())
            .await
            .map_err(|error| {
                CliError::Launch(format!("repo pool return receipt check failed ({error})"))
            })?;
    if !receipt_matches {
        return Ok(false);
    }
    let mut guard = registry.lock().await;
    let current = guard.get(key).ok_or_else(|| {
        CliError::Launch("daemon registry row disappeared during repo pool receipt recovery".into())
    })?;
    if current.stop_in_progress {
        // The typed stop that owns this exact row is still between process
        // termination and durable registry removal. Let that operation consume
        // its own receipt; the exit monitor must not race it.
        return Ok(false);
    }
    if daemon_repo_pool_run_authority(current)?.as_ref() != Some(authority) {
        return Err(CliError::Launch(
            "daemon registry binding changed during repo pool receipt recovery".into(),
        ));
    }
    let managed = guard
        .remove(key)
        .expect("exact receipt-owned daemon row remains present until recovery persists");
    if !persist_registry(&guard) {
        guard.insert(key.to_string(), managed);
        return Err(CliError::Launch(
            "failed to persist daemon registry after repo pool receipt recovery".into(),
        ));
    }
    let persisted = persisted_daemon_run_from_child(&managed);
    remove_daemon_run_sidecar(&persisted);
    append_daemon_registry_audit(&format!(
        "removed key={key} pid={} run={} reason=completed_pool_return_receipt",
        managed.pid,
        managed.run_id.as_deref().unwrap_or("unknown")
    ));
    Ok(true)
}

async fn register_daemon_child(
    registry: &DaemonRunRegistry,
    spawned: SpawnedHeadlessAgent,
    _agent_id: Option<String>,
    _instance_id: Option<String>,
) -> error::Result<()> {
    let mut guard = registry.lock().await;
    let key = spawned
        .run_id
        .as_ref()
        .map(|value| daemon_run_key("run", value))
        .or_else(|| {
            spawned
                .execution_key
                .as_ref()
                .map(|value| daemon_run_key("execution", value))
        })
        .unwrap_or_else(|| daemon_run_key("pid", &spawned.pid.to_string()));
    let audit_key = key.clone();
    let audit_pid = spawned.pid;
    let audit_run_id = spawned.run_id.clone();
    guard.insert(
        key,
        DaemonRunChild {
            #[cfg(windows)]
            handoff: None,
            child: Some(spawned.child),
            process_tree: Some(spawned.process_tree),
            pid: spawned.pid,
            stop_in_progress: false,
            exit_audited: false,
            cwd: Some(spawned.cwd),
            run_id: spawned.run_id,
            execution_key: spawned.execution_key,
            instance_id: spawned.instance_id,
            resume_session_key: spawned.resume_session_key,
            repo_pool_binding: spawned.repo_pool_binding,
            agent_id: spawned.agent_id,
            agent_name: Some(spawned.agent_name),
            auth_capability: spawned
                ._auth_grant
                .as_ref()
                .map(|grant| grant.capability.clone()),
            status_file_path: spawned.status_file_path,
            stdout_log_path: spawned.stdout_log_path,
            stderr_log_path: spawned.stderr_log_path,
            _auth_grant: spawned._auth_grant,
            request_capability: spawned
                ._request_grant
                .as_ref()
                .map(|grant| grant.capability.clone()),
            request_context: spawned
                ._request_grant
                .as_ref()
                .map(|grant| grant.context.clone()),
            _request_grant: spawned._request_grant,
        },
    );
    if !persist_daemon_run_registry_locked(&guard) {
        let mut managed = guard
            .remove(&audit_key)
            .expect("new daemon child remains registered until persistence succeeds");
        let persisted = persisted_daemon_run_from_child(&managed);
        let termination: error::Result<()> =
            if let Some(process_tree) = managed.process_tree.as_mut() {
                process_tree.terminate().map_err(|error| {
                    CliError::Launch(format!(
                        "failed to terminate daemon-owned process tree for pid {}: {error}",
                        managed.pid
                    ))
                })
            } else {
                terminate_daemon_pid(managed.pid)
            };
        if let Err(terminate_error) = termination {
            guard.insert(audit_key.clone(), managed);
            append_daemon_registry_audit(&format!(
                "spawn_registry_persist_failed_process_live key={audit_key} pid={audit_pid} error={terminate_error}"
            ));
            return Err(CliError::Launch(format!(
                "failed to persist daemon run registry, and spawned process termination failed ({terminate_error}); repo pool lease remains unavailable"
            )));
        }
        drop(guard);
        if let Err(error) = settle_repo_pool_after_failed_spawn(&managed).await {
            let mut recovery_guard = registry.lock().await;
            recovery_guard.entry(audit_key.clone()).or_insert(managed);
            append_daemon_registry_audit(&format!(
                "spawn_registry_persist_failed_pool_unsettled key={audit_key} pid={audit_pid} error={error}"
            ));
            return Err(CliError::Launch(format!(
                "failed to persist daemon run registry; repo pool rollback failed ({error})"
            )));
        }
        remove_daemon_run_sidecar(&persisted);
        return Err(CliError::Launch(
            "failed to persist daemon run registry; spawned process was terminated".into(),
        ));
    }
    append_daemon_registry_audit(&format!(
        "registered key={audit_key} pid={audit_pid} run={}",
        audit_run_id.as_deref().unwrap_or("unknown")
    ));
    Ok(())
}

/// Mint the Git credential capability for one spawned run, if it can have one.
///
/// Requires everything the grant is made of to be present and consistent: an
/// auth grant to hang it on, a resolved pool binding naming a GitHub
/// repository, and the run identity the Hub will check the channel against.
/// Anything missing means no capability, which leaves Git exactly as it was.
fn git_credential_grant_for_spawn(
    auth_grant: Option<&DaemonAuthGrant>,
    repo_pool_binding: Option<&DaemonRepoPoolBinding>,
    channel_id: &str,
    run_id: Option<&str>,
    execution_key: Option<&str>,
) -> Option<String> {
    git_credential_grant_for_repo(
        auth_grant,
        repo_pool_binding?.canonical_repo_identity.as_str(),
        channel_id,
        run_id,
        execution_key,
    )
}

fn git_credential_grant_for_repo(
    auth_grant: Option<&DaemonAuthGrant>,
    canonical_repo_identity: &str,
    channel_id: &str,
    run_id: Option<&str>,
    execution_key: Option<&str>,
) -> Option<String> {
    let auth_grant = auth_grant?;
    let repository = github_repository_of_pool_identity(canonical_repo_identity)?;
    let run_id = run_id?;
    let execution_key = execution_key?;
    issue_git_credential_grant(
        &auth_grant.git_credentials,
        DaemonGitCredentialGrantState {
            channel_id: channel_id.to_string(),
            run_id: run_id.to_string(),
            execution_key: execution_key.to_string(),
            repository,
        },
    )
}
