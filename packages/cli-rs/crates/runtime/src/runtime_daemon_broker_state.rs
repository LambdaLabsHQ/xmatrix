// Where owner clients find the local daemon broker and its owner capability.
fn daemon_request_broker_state_path() -> PathBuf {
    config::profile_state_dir().join("daemon-request-broker.json")
}

fn require_request_file_profile(persisted_profile_id: Option<&str>) -> error::Result<()> {
    let Some(profile) = config::active_profile_context() else {
        return Ok(());
    };
    if persisted_profile_id == Some(profile.id.as_str()) {
        return Ok(());
    }
    if persisted_profile_id.is_none()
        && profile.state_kind == xmatrix_cli_core::profile::ProfileStateKind::LegacyRoot
    {
        return Ok(());
    }
    Err(CliError::Launch(format!(
        "daemon request state belongs to a different local profile than {}",
        profile.id
    )))
}

fn persist_daemon_request_broker_state(url: &str, owner_capability: &str) {
    if let Err(error) = xmatrix_cli_core::daemon_record::update_record(|record| {
        record.request_broker_url = Some(url.to_string());
    }) {
        eprintln!("⚠ daemon record could not record the request broker locator: {error}");
    }
    let path = daemon_request_broker_state_path();
    if let Some(parent) = path.parent()
        && let Err(err) = std::fs::create_dir_all(parent) {
            eprintln!(
                "{} failed to create daemon request broker state directory: {err}",
                "⚠".yellow().bold()
            );
            return;
        }
    let state = DaemonRequestBrokerState {
        profile_id: config::active_profile_context().map(|profile| profile.id.as_str().to_string()),
        url: url.to_string(),
        owner_capability: owner_capability.to_string(),
        updated_at: config::unix_now_secs().to_string(),
    };
    let Ok(bytes) = serde_json::to_vec_pretty(&state) else {
        return;
    };
    let tmp_path = config::unique_temporary_path(&path);
    if write_daemon_private_file(&tmp_path, &bytes)
        .and_then(|()| config::replace_file_atomically(&tmp_path, &path))
        .is_ok()
    {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
    } else {
        let _ = std::fs::remove_file(&tmp_path);
    }
}

fn read_daemon_request_broker_state() -> Option<DaemonRequestBrokerState> {
    std::fs::read_to_string(daemon_request_broker_state_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .filter(|state: &DaemonRequestBrokerState| {
            require_request_file_profile(state.profile_id.as_deref()).is_ok()
        })
}
