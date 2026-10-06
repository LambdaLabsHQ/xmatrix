use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{OnceLock, RwLock};

use reqwest::Url;
use tokio::process::Command;

use crate::config;
use crate::error::{CliError, Result};
use crate::protocol::TEST_HUB_URL;

pub const ACCESS_TOKEN_HEADER: &str = "cf-access-token";
const CLOUDFLARED_PATH_ENV: &str = "XMATRIX_CLOUDFLARED_PATH";
pub const DAEMON_REQUEST_URL_ENV: &str = "XMATRIX_DAEMON_REQUEST_URL";
pub const DAEMON_REQUEST_CAPABILITY_ENV: &str = "XMATRIX_DAEMON_REQUEST_CAPABILITY";

#[derive(Clone)]
struct AccessState {
    hub_origin: String,
    token: String,
    executable: PathBuf,
}

fn state() -> &'static RwLock<Option<AccessState>> {
    static STATE: OnceLock<RwLock<Option<AccessState>>> = OnceLock::new();
    STATE.get_or_init(|| RwLock::new(None))
}

fn normalized_origin(value: &str) -> Option<String> {
    let value = if let Some(rest) = value.strip_prefix("wss://") {
        format!("https://{rest}")
    } else if let Some(rest) = value.strip_prefix("ws://") {
        format!("http://{rest}")
    } else {
        value.to_string()
    };
    let url = Url::parse(&value).ok()?;
    let host = url.host_str()?;
    let mut origin = format!("{}://{host}", url.scheme());
    if let Some(port) = url.port() {
        origin.push(':');
        origin.push_str(&port.to_string());
    }
    Some(origin)
}

pub fn requires_access(value: &str) -> bool {
    normalized_origin(value) == normalized_origin(TEST_HUB_URL)
}

pub fn cached_token_for_url(value: &str) -> Result<Option<String>> {
    if !requires_access(value) {
        return Ok(None);
    }
    let expected = normalized_origin(TEST_HUB_URL).expect("test Hub has a valid origin");
    let guard = state()
        .read()
        .map_err(|_| CliError::Auth("Cloudflare Access token state is unavailable".into()))?;
    let access = guard
        .as_ref()
        .filter(|access| access.hub_origin == expected);
    access
        .map(|access| access.token.clone())
        .filter(|token| !token.trim().is_empty())
        .map(Some)
        .ok_or_else(|| {
            CliError::Auth(
                "Cloudflare Access login required for the xMatrix test environment. Run `xmatrix --environment test login`."
                    .into(),
            )
        })
}

pub async fn prepare_for_hub(hub_url: &str, interactive: bool) -> Result<()> {
    if !requires_access(hub_url) {
        return Ok(());
    }
    if cached_token_for_url(hub_url).is_ok() {
        return Ok(());
    }
    if daemon_request_broker().is_some() {
        return Ok(());
    }

    let executable = find_cloudflared().await.ok_or_else(|| {
        CliError::Auth(
            "The xMatrix test environment requires Cloudflare Access, but `cloudflared` was not found. Install cloudflared and run `xmatrix --environment test login`."
                .into(),
        )
    })?;

    match read_access_token(&executable).await {
        Ok(token) => {
            config::save_cloudflared_path(&executable).await?;
            cache_access(executable, token)
        }
        Err(_) if interactive => {
            let status = Command::new(&executable)
                .args(["access", "login", TEST_HUB_URL])
                .stdin(Stdio::null())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .status()
                .await
                .map_err(|err| {
                    CliError::Auth(format!("Failed to start Cloudflare Access login: {err}"))
                })?;
            if !status.success() {
                return Err(CliError::Auth(
                    "Cloudflare Access login was not completed".into(),
                ));
            }
            let token = read_access_token(&executable).await?;
            config::save_cloudflared_path(&executable).await?;
            cache_access(executable, token)
        }
        Err(_) => Err(CliError::Auth(
            "Cloudflare Access session is missing or expired. Run `xmatrix --environment test login`."
                .into(),
        )),
    }
}

/// Largest broker locator this will read. The file holds one small record.
const MAX_BROKER_STATE_BYTES: u64 = 4096;

fn loopback_broker_url(value: &str) -> Option<String> {
    let url = value.trim().trim_end_matches('/').to_string();
    let parsed = Url::parse(&url).ok()?;
    (parsed.scheme() == "http"
        && matches!(
            parsed.host_str(),
            Some("127.0.0.1") | Some("localhost") | Some("::1")
        )
        && parsed.path() == "/")
        .then_some(url)
}

/// The daemon binds an ephemeral port and records it here on every start, so
/// this is the only locator that is current. The spawn-time environment value
/// is a seed: it is correct until the daemon restarts and then names a port
/// that is dead — or worse, one that some unrelated process has since taken.
///
/// Read the profile's own record first for exactly that reason. Preferring the
/// environment and only falling back on a connection failure would hand this
/// Run's capability to whoever now answers on the old port.
fn daemon_request_broker_locator() -> Option<String> {
    // The shared record is where every locator is moving. Prefer it, and say so
    // when it is unreadable: a corrupt record that silently becomes "no record"
    // is indistinguishable from a daemon that never started, and that ambiguity
    // is what made the same failure expensive to diagnose.
    match crate::daemon_record::read_record_for_active_profile() {
        Ok(Some(record)) => {
            if let Some(url) = record
                .request_broker_url
                .as_deref()
                .and_then(loopback_broker_url)
            {
                return Some(url);
            }
        }
        Ok(None) => {}
        Err(error) => {
            eprintln!("⚠ daemon record unusable, falling back to the per-broker file: {error}")
        }
    }
    let path = config::profile_state_dir().join("daemon-request-broker.json");
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_BROKER_STATE_BYTES
    {
        return None;
    }
    let active = config::active_profile_context().map(|profile| profile.id.as_str().to_string());
    broker_url_from_state(&std::fs::read(&path).ok()?, active.as_deref())
}

/// Accept a locator only when the record belongs to the Profile this process is
/// running under. A record written for another Profile locates another daemon.
fn broker_url_from_state(bytes: &[u8], active_profile: Option<&str>) -> Option<String> {
    let state: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let recorded = state.get("profileId").and_then(serde_json::Value::as_str);
    if recorded != active_profile {
        return None;
    }
    loopback_broker_url(state.get("url")?.as_str()?)
}

pub fn daemon_request_broker() -> Option<(String, String)> {
    // The capability is this Run's own secret and only ever arrives by
    // environment; the locator is public routing and must stay current.
    let capability = std::env::var(DAEMON_REQUEST_CAPABILITY_ENV).ok()?;
    let capability = capability.trim().to_string();
    if capability.is_empty() {
        return None;
    }
    let seed = std::env::var(DAEMON_REQUEST_URL_ENV).ok()?;
    let url = if config::agent_cli_hub().is_some() {
        // A child CLI uses its wrapper's stable, Run-bound proxy; an ambient
        // installation locator may belong to a different connection profile.
        loopback_broker_url(&seed)?
    } else {
        resolve_broker_url(daemon_request_broker_locator(), &seed)?
    };
    Some((url, capability))
}

/// True when this process was spawned by the daemon as an Agent Run. The Hub
/// then authenticates the CLI as that Agent, and Agent principals never manage
/// Agents or decide human-reviewed requests.
pub fn inside_agent_run() -> bool {
    std::env::var("XMATRIX_RUN_ID")
        .ok()
        .is_some_and(|value| !value.trim().is_empty())
}

/// After `xmatrix update`, a live Run still presents its spawn-time capability
/// while the replacement daemon only holds the one-way verifier key restored
/// from the run registry. When those disagree, prefer the exact registry key
/// for this Run/execution so send can re-authorize without re-spawning.
#[derive(Debug, PartialEq, Eq)]
pub enum DaemonRequestCapabilityRediscovery {
    /// One persisted key differs from the spawn-time capability.
    Replacement { url: String, capability: String },
    /// Registry and sidecar disagree about the same Run — do not pick one.
    Ambiguous { distinct_count: usize },
    /// A registry/sidecar path existed but could not be read or parsed.
    Unreadable { detail: String },
    /// No persisted key for this Run/execution.
    None,
}

pub fn rediscovered_daemon_request_capability(
    current_capability: &str,
) -> DaemonRequestCapabilityRediscovery {
    let Some(run_id) = std::env::var("XMATRIX_RUN_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return DaemonRequestCapabilityRediscovery::None;
    };
    let Some(execution_key) = std::env::var("XMATRIX_EXECUTION_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return DaemonRequestCapabilityRediscovery::None;
    };
    let Some(url) = daemon_request_broker_locator() else {
        return DaemonRequestCapabilityRediscovery::None;
    };
    let current = current_capability.trim();
    match read_persisted_request_capabilities_for_run(&run_id, &execution_key) {
        Err(detail) => DaemonRequestCapabilityRediscovery::Unreadable { detail },
        Ok(mut capabilities) => {
            capabilities.sort_unstable();
            capabilities.dedup();
            match capabilities.as_slice() {
                [capability] if capability != current => {
                    DaemonRequestCapabilityRediscovery::Replacement {
                        url,
                        capability: capability.clone(),
                    }
                }
                [] | [_] => DaemonRequestCapabilityRediscovery::None,
                many => DaemonRequestCapabilityRediscovery::Ambiguous {
                    distinct_count: many.len(),
                },
            }
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedRunRequestCapability {
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    execution_key: Option<String>,
    #[serde(default)]
    request_capability: Option<String>,
}

fn read_persisted_request_capabilities_for_run(
    run_id: &str,
    execution_key: &str,
) -> std::result::Result<Vec<String>, String> {
    let runs = read_persisted_runs_for_request_capability()?;
    let mut capabilities = Vec::new();
    for run in runs {
        if run.run_id.as_deref() != Some(run_id)
            || run.execution_key.as_deref() != Some(execution_key)
        {
            continue;
        }
        if let Some(capability) = run
            .request_capability
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            capabilities.push(capability.to_string());
        }
    }
    Ok(capabilities)
}

fn read_persisted_runs_for_request_capability()
-> std::result::Result<Vec<PersistedRunRequestCapability>, String> {
    let mut runs = Vec::new();
    let mut saw_readable_source = false;
    let mut first_failure: Option<String> = None;

    let registry = config::profile_state_dir().join("daemon-run-registry.json");
    match std::fs::read_to_string(&registry) {
        Ok(raw) => match serde_json::from_str::<Vec<PersistedRunRequestCapability>>(&raw) {
            Ok(parsed) => {
                saw_readable_source = true;
                runs.extend(parsed);
            }
            Err(err) => {
                first_failure
                    .get_or_insert_with(|| format!("daemon-run-registry.json unparseable: {err}"));
            }
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => {
            first_failure
                .get_or_insert_with(|| format!("daemon-run-registry.json unreadable: {err}"));
        }
    }

    let dir = config::daemon_run_log_dir();
    match std::fs::read_dir(&dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                let is_sidecar = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(".registry.json"));
                if !is_sidecar {
                    continue;
                }
                match std::fs::read_to_string(&path) {
                    Ok(raw) => match serde_json::from_str::<PersistedRunRequestCapability>(&raw) {
                        Ok(run) => {
                            saw_readable_source = true;
                            runs.push(run);
                        }
                        Err(err) => {
                            first_failure.get_or_insert_with(|| {
                                format!("sidecar {} unparseable: {err}", path.display())
                            });
                        }
                    },
                    Err(err) => {
                        first_failure.get_or_insert_with(|| {
                            format!("sidecar {} unreadable: {err}", path.display())
                        });
                    }
                }
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => {
            first_failure.get_or_insert_with(|| format!("run registry dir unreadable: {err}"));
        }
    }

    if !saw_readable_source && let Some(detail) = first_failure {
        return Err(detail);
    }
    Ok(runs)
}

/// The recorded locator wins whenever there is one; the spawn-time seed is only
/// for a daemon that has never written its record.
fn resolve_broker_url(recorded: Option<String>, seed: &str) -> Option<String> {
    recorded.or_else(|| loopback_broker_url(seed))
}

pub async fn refresh_for_url(value: &str) -> Result<()> {
    if !requires_access(value) {
        return Ok(());
    }
    let executable = state()
        .read()
        .ok()
        .and_then(|guard| guard.as_ref().map(|access| access.executable.clone()))
        .or(config::saved_cloudflared_path().await)
        .or_else(|| executable_on_path("cloudflared"))
        .ok_or_else(|| CliError::Auth("`cloudflared` is required for test Access".into()))?;
    let token = read_access_token(&executable).await?;
    cache_access(executable, token)
}

fn cache_access(executable: PathBuf, token: String) -> Result<()> {
    if token.trim().is_empty() {
        return Err(CliError::Auth(
            "Cloudflare Access returned an empty token".into(),
        ));
    }
    let mut guard = state()
        .write()
        .map_err(|_| CliError::Auth("Cloudflare Access token state is unavailable".into()))?;
    *guard = Some(AccessState {
        hub_origin: normalized_origin(TEST_HUB_URL).expect("test Hub has a valid origin"),
        token,
        executable,
    });
    Ok(())
}

async fn read_access_token(executable: &Path) -> Result<String> {
    let output = Command::new(executable)
        .args(["access", "token", "-app", TEST_HUB_URL])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await
        .map_err(|err| CliError::Auth(format!("Failed to read Cloudflare Access token: {err}")))?;
    if !output.status.success() {
        return Err(CliError::Auth(
            "Cloudflare Access session is missing or expired".into(),
        ));
    }
    let token = String::from_utf8(output.stdout)
        .map_err(|_| CliError::Auth("Cloudflare Access returned an invalid token".into()))?;
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(CliError::Auth(
            "Cloudflare Access returned an empty token".into(),
        ));
    }
    Ok(token)
}

async fn find_cloudflared() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(CLOUDFLARED_PATH_ENV)
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return std::fs::canonicalize(path).ok();
    }
    if let Some(path) = config::saved_cloudflared_path()
        .await
        .filter(|path| path.is_file())
    {
        return std::fs::canonicalize(path).ok();
    }
    executable_on_path("cloudflared")
}

fn executable_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(name);
        if candidate.is_file() {
            return std::fs::canonicalize(candidate).ok();
        }
        #[cfg(windows)]
        {
            let candidate = directory.join(format!("{name}.exe"));
            if candidate.is_file() {
                return std::fs::canonicalize(candidate).ok();
            }
        }
    }
    None
}

pub fn access_denial_message(status: u16) -> String {
    match status {
        401 => "Cloudflare Access session is missing or expired. Run `xmatrix --environment test login`.".into(),
        403 => "Cloudflare Access denied this identity access to the xMatrix test environment.".into(),
        _ => "Cloudflare Access login required for the xMatrix test environment. Run `xmatrix --environment test login`.".into(),
    }
}

#[cfg(test)]
#[expect(
    clippy::await_holding_lock,
    reason = "each #[tokio::test] runs on its own thread; the guard only serializes process-global env across test threads"
)]
mod tests {
    use super::*;

    #[cfg(unix)]
    struct AccessTestEnvironment {
        dir: PathBuf,
        saved_variables: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }

    #[cfg(unix)]
    impl AccessTestEnvironment {
        fn new(dir: PathBuf, executable: &Path) -> Self {
            let saved_variables = [
                CLOUDFLARED_PATH_ENV,
                "XMATRIX_CONFIG_DIR",
                DAEMON_REQUEST_URL_ENV,
                DAEMON_REQUEST_CAPABILITY_ENV,
            ]
            .into_iter()
            .map(|name| (name, std::env::var_os(name)))
            .collect();

            // These tests exercise cloudflared directly. A broker inherited from the
            // invoking xMatrix process would intentionally bypass that path.
            unsafe {
                std::env::set_var(CLOUDFLARED_PATH_ENV, executable);
                std::env::set_var("XMATRIX_CONFIG_DIR", dir.join("config"));
                std::env::remove_var(DAEMON_REQUEST_URL_ENV);
                std::env::remove_var(DAEMON_REQUEST_CAPABILITY_ENV);
            }
            *state().write().unwrap() = None;

            Self {
                dir,
                saved_variables,
            }
        }
    }

    #[cfg(unix)]
    impl Drop for AccessTestEnvironment {
        fn drop(&mut self) {
            *state()
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
            for (name, value) in self.saved_variables.drain(..) {
                unsafe {
                    match value {
                        Some(value) => std::env::set_var(name, value),
                        None => std::env::remove_var(name),
                    }
                }
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn access_is_scoped_to_the_exact_test_origin() {
        assert!(requires_access(TEST_HUB_URL));
        assert!(requires_access("wss://xmatrix-hub.test.xmatrix.sh/ws"));
        assert!(!requires_access("https://xmatrix-hub.xmatrix.sh"));
        assert!(!requires_access("https://cdn.example.com/attachments/file"));
        assert!(!requires_access(
            "https://xmatrix-hub.test.xmatrix.sh.evil.example"
        ));
        assert!(!requires_access("https://test.xmatrix.sh"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_cloudflared_supplies_a_process_only_token() {
        use std::os::unix::fs::PermissionsExt;

        let _guard = config::test_env_lock();
        let dir =
            std::env::temp_dir().join(format!("xmatrix-cloudflared-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let executable = dir.join("cloudflared");
        std::fs::write(
            &executable,
            "#!/bin/sh\nif [ \"$1\" = access ] && [ \"$2\" = token ]; then printf fake-access-token; exit 0; fi\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let _environment = AccessTestEnvironment::new(dir, &executable);

        prepare_for_hub(TEST_HUB_URL, false).await.unwrap();
        assert_eq!(
            cached_token_for_url(TEST_HUB_URL).unwrap().as_deref(),
            Some("fake-access-token")
        );
        let websocket = crate::http::websocket_request(
            "wss://xmatrix-hub.test.xmatrix.sh/ws",
            crate::http::ClientComponent::Daemon,
        )
        .await
        .unwrap();
        assert_eq!(
            websocket.headers().get(ACCESS_TOKEN_HEADER).unwrap(),
            "fake-access-token"
        );
        let persisted = std::fs::read_to_string(config::config_path()).unwrap();
        assert!(persisted.contains(executable.to_string_lossy().as_ref()));
        assert!(!persisted.contains("fake-access-token"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_cloudflared_runs_interactive_login_without_persisting_the_token() {
        use std::os::unix::fs::PermissionsExt;

        let _guard = config::test_env_lock();
        let dir = std::env::temp_dir().join(format!(
            "xmatrix-cloudflared-login-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let executable = dir.join("cloudflared");
        let marker = dir.join("logged-in");
        std::fs::write(
            &executable,
            format!(
                "#!/bin/sh\nif [ \"$1\" = access ] && [ \"$2\" = token ]; then [ -f \"{}\" ] && printf interactive-access-token && exit 0; exit 1; fi\nif [ \"$1\" = access ] && [ \"$2\" = login ]; then touch \"{}\"; exit 0; fi\nexit 1\n",
                marker.display(),
                marker.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let _environment = AccessTestEnvironment::new(dir, &executable);

        prepare_for_hub(TEST_HUB_URL, true).await.unwrap();
        let persisted = std::fs::read_to_string(config::config_path()).unwrap();
        assert!(persisted.contains(executable.to_string_lossy().as_ref()));
        assert!(!persisted.contains("interactive-access-token"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_cloudflared_rejection_is_actionable() {
        use std::os::unix::fs::PermissionsExt;

        let _guard = config::test_env_lock();
        let dir = std::env::temp_dir().join(format!(
            "xmatrix-cloudflared-reject-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let executable = dir.join("cloudflared");
        std::fs::write(&executable, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let _environment = AccessTestEnvironment::new(dir, &executable);

        let noninteractive = prepare_for_hub(TEST_HUB_URL, false).await.unwrap_err();
        assert!(noninteractive.to_string().contains("missing or expired"));
        let interactive = prepare_for_hub(TEST_HUB_URL, true).await.unwrap_err();
        assert!(interactive.to_string().contains("was not completed"));
    }
}

/// The daemon rebinds an ephemeral port on every start, so a locator baked into
/// a Run's environment goes stale the moment the daemon restarts. Happy's CLI
/// avoids this by reading the daemon's recorded port instead of pinning one.
#[cfg(test)]
mod broker_locator_tests {
    use super::*;

    fn state(profile: Option<&str>, url: &str) -> Vec<u8> {
        let mut record = serde_json::Map::new();
        if let Some(profile) = profile {
            record.insert("profileId".into(), serde_json::Value::from(profile));
        }
        record.insert("url".into(), serde_json::Value::from(url));
        serde_json::to_vec(&serde_json::Value::Object(record)).unwrap()
    }

    #[test]
    fn the_recorded_locator_wins_over_the_spawn_time_seed() {
        // The seed is reachable here, and still must not win: after a restart
        // the old port can be held by a process that is not our daemon.
        assert_eq!(
            resolve_broker_url(
                Some("http://127.0.0.1:62953".into()),
                "http://127.0.0.1:56945"
            ),
            Some("http://127.0.0.1:62953".to_string()),
        );
    }

    #[test]
    fn the_seed_is_used_only_when_nothing_is_recorded() {
        assert_eq!(
            resolve_broker_url(None, "http://127.0.0.1:56945"),
            Some("http://127.0.0.1:56945".to_string()),
        );
        assert_eq!(resolve_broker_url(None, "http://10.0.0.5:56945"), None);
    }

    #[test]
    fn a_record_for_another_profile_locates_another_daemon() {
        let bytes = state(Some("profile:other"), "http://127.0.0.1:62953");
        assert_eq!(broker_url_from_state(&bytes, Some("profile:mine")), None);
        assert_eq!(broker_url_from_state(&bytes, None), None);
        assert_eq!(
            broker_url_from_state(&bytes, Some("profile:other")),
            Some("http://127.0.0.1:62953".to_string()),
        );
    }

    #[test]
    fn a_profileless_record_matches_only_a_profileless_process() {
        let bytes = state(None, "http://127.0.0.1:62953");
        assert_eq!(
            broker_url_from_state(&bytes, None),
            Some("http://127.0.0.1:62953".to_string()),
        );
        assert_eq!(broker_url_from_state(&bytes, Some("profile:mine")), None);
    }

    #[test]
    fn a_locator_can_never_point_off_the_loopback_or_carry_a_path() {
        for url in [
            "https://127.0.0.1:62953",
            "http://192.0.2.1:62953",
            "http://example.com:62953",
            "http://127.0.0.1:62953/request/hub-json",
        ] {
            assert_eq!(loopback_broker_url(url), None, "{url} must be refused");
            assert_eq!(
                broker_url_from_state(&state(None, url), None),
                None,
                "{url}"
            );
        }
        assert_eq!(
            loopback_broker_url("http://127.0.0.1:62953/"),
            Some("http://127.0.0.1:62953".to_string()),
            "a bare trailing slash is the daemon root, not a path",
        );
    }

    #[test]
    fn a_malformed_record_is_not_a_locator() {
        assert_eq!(broker_url_from_state(b"not json", None), None);
        assert_eq!(broker_url_from_state(b"{}", None), None);
    }

    struct RediscoveryEnv {
        dir: PathBuf,
        saved_config: Option<std::ffi::OsString>,
        saved_run_id: Option<std::ffi::OsString>,
        saved_execution: Option<std::ffi::OsString>,
    }

    impl RediscoveryEnv {
        fn install(run_id: &str, execution_key: &str, label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "xmatrix-request-rediscovery-{label}-{}",
                uuid::Uuid::new_v4()
            ));
            let config_dir = dir.join("config");
            std::fs::create_dir_all(config_dir.join("runs")).unwrap();
            let saved_config = std::env::var_os("XMATRIX_CONFIG_DIR");
            let saved_run_id = std::env::var_os("XMATRIX_RUN_ID");
            let saved_execution = std::env::var_os("XMATRIX_EXECUTION_KEY");
            unsafe {
                std::env::set_var("XMATRIX_CONFIG_DIR", &config_dir);
                std::env::set_var("XMATRIX_RUN_ID", run_id);
                std::env::set_var("XMATRIX_EXECUTION_KEY", execution_key);
            }
            Self {
                dir,
                saved_config,
                saved_run_id,
                saved_execution,
            }
        }

        fn config_dir(&self) -> PathBuf {
            self.dir.join("config")
        }
    }

    impl Drop for RediscoveryEnv {
        fn drop(&mut self) {
            unsafe {
                match self.saved_config.take() {
                    Some(value) => std::env::set_var("XMATRIX_CONFIG_DIR", value),
                    None => std::env::remove_var("XMATRIX_CONFIG_DIR"),
                }
                match self.saved_run_id.take() {
                    Some(value) => std::env::set_var("XMATRIX_RUN_ID", value),
                    None => std::env::remove_var("XMATRIX_RUN_ID"),
                }
                match self.saved_execution.take() {
                    Some(value) => std::env::set_var("XMATRIX_EXECUTION_KEY", value),
                    None => std::env::remove_var("XMATRIX_EXECUTION_KEY"),
                }
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn rediscovery_prefers_registry_verifier_key_for_this_run() {
        let _guard = config::test_env_lock();
        let env = RediscoveryEnv::install("run-rediscovery", "exec-rediscovery", "exact");
        let config_dir = env.config_dir();

        std::fs::write(
            config_dir.join("daemon-record.json"),
            serde_json::json!({
                "schemaVersion": 1,
                "pid": 1,
                "requestBrokerUrl": "http://127.0.0.1:19876",
                "updatedAt": "1",
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            config_dir.join("daemon-run-registry.json"),
            serde_json::json!([{
                "pid": 42,
                "runId": "run-rediscovery",
                "executionKey": "exec-rediscovery",
                "requestCapability": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                "updatedAt": "1",
            }])
            .to_string(),
        )
        .unwrap();

        assert_eq!(
            rediscovered_daemon_request_capability("spawn-time-raw-capability-that-diverged"),
            DaemonRequestCapabilityRediscovery::Replacement {
                url: "http://127.0.0.1:19876".to_string(),
                capability:
                    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                        .to_string(),
            },
            "after update, send must rediscover the restored verifier key for this Run",
        );
    }

    #[test]
    fn rediscovery_names_ambiguity_instead_of_pretending_none() {
        let _guard = config::test_env_lock();
        let env = RediscoveryEnv::install("run-ambiguous", "exec-ambiguous", "ambiguous");
        let config_dir = env.config_dir();

        std::fs::write(
            config_dir.join("daemon-record.json"),
            serde_json::json!({
                "schemaVersion": 1,
                "pid": 1,
                "requestBrokerUrl": "http://127.0.0.1:19877",
                "updatedAt": "1",
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            config_dir.join("daemon-run-registry.json"),
            serde_json::json!([
                {
                    "pid": 42,
                    "runId": "run-ambiguous",
                    "executionKey": "exec-ambiguous",
                    "requestCapability": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "updatedAt": "1",
                },
                {
                    "pid": 43,
                    "runId": "run-ambiguous",
                    "executionKey": "exec-ambiguous",
                    "requestCapability": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "updatedAt": "2",
                }
            ])
            .to_string(),
        )
        .unwrap();

        assert_eq!(
            rediscovered_daemon_request_capability("spawn-time-raw-capability-that-diverged"),
            DaemonRequestCapabilityRediscovery::Ambiguous { distinct_count: 2 },
            "disagreeing registry rows must not collapse into 'found nothing'",
        );
    }
}
