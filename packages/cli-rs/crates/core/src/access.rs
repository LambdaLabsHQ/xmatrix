use reqwest::Url;

use crate::config;

pub(crate) const DAEMON_REQUEST_URL_ENV: &str = "XMATRIX_DAEMON_REQUEST_URL";
pub(crate) const DAEMON_REQUEST_CAPABILITY_ENV: &str = "XMATRIX_DAEMON_REQUEST_CAPABILITY";

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

pub(crate) fn daemon_request_broker() -> Option<(String, String)> {
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
pub(crate) enum DaemonRequestCapabilityRediscovery {
    /// One persisted key differs from the spawn-time capability.
    Replacement { url: String, capability: String },
    /// Registry and sidecar disagree about the same Run — do not pick one.
    Ambiguous { distinct_count: usize },
    /// A registry/sidecar path existed but could not be read or parsed.
    Unreadable { detail: String },
    /// No persisted key for this Run/execution.
    None,
}

pub(crate) fn rediscovered_daemon_request_capability(
    current_capability: &str,
) -> DaemonRequestCapabilityRediscovery {
    let Some(run_id) = std::env::var("XMATRIX_RUN_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return DaemonRequestCapabilityRediscovery::None;
    };
    let Some(execution_key) = run_execution_key() else {
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

/// This Run's execution key: the spawn-time environment value, or — when the
/// harness kept it from its tool shell — the one the daemon recorded for the
/// Run whose request capability this process holds.
///
/// Some harnesses drop credential-shaped names from every command they run
/// (DeepSeek Harness removes anything matching `KEY|PASSWORD|SECRET|TOKEN`), so
/// `XMATRIX_EXECUTION_KEY` never arrives while `XMATRIX_RUN_ID` and the request
/// capability do. The Run id alone selects nothing here: the caller must hold
/// the capability the daemon issued to that same Run, which is the proof every
/// brokered request already rests on.
pub fn run_execution_key() -> Option<String> {
    let env = |name: &str| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    if let Some(key) = env("XMATRIX_EXECUTION_KEY") {
        return Some(key);
    }
    let run_id = env("XMATRIX_RUN_ID")?;
    let capability = env(DAEMON_REQUEST_CAPABILITY_ENV)?;
    let runs = read_persisted_runs_for_request_capability().ok()?;
    recorded_execution_key(&runs, &run_id, &capability)
}

/// The one execution key recorded for `run_id` beside `capability`. The
/// registry keeps the capability as its `sha256:` verifier; an older record
/// holds it raw. Records that disagree name no key.
fn recorded_execution_key(
    runs: &[PersistedRunRequestCapability],
    run_id: &str,
    capability: &str,
) -> Option<String> {
    let verifier = format!("sha256:{}", crate::hex::sha256_hex(capability.as_bytes()));
    let mut keys = runs
        .iter()
        .filter(|run| run.run_id.as_deref() == Some(run_id))
        .filter(|run| {
            run.request_capability
                .as_deref()
                .map(str::trim)
                .is_some_and(|recorded| recorded == verifier || recorded == capability)
        })
        .filter_map(|run| run.execution_key.as_deref().map(str::trim))
        .filter(|key| !key.is_empty())
        .collect::<Vec<_>>();
    keys.sort_unstable();
    keys.dedup();
    match keys.as_slice() {
        [key] => Some((*key).to_string()),
        _ => None,
    }
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

#[cfg(test)]
mod broker_locator_tests {
    use super::*;
    use std::path::PathBuf;

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

    #[test]
    fn a_scrubbed_execution_key_is_read_back_only_with_the_runs_own_capability() {
        let verifier = format!("sha256:{}", crate::hex::sha256_hex(b"cap-a"));
        let row = |run: &str, key: &str, capability: &str| PersistedRunRequestCapability {
            run_id: Some(run.into()),
            execution_key: Some(key.into()),
            request_capability: Some(capability.into()),
        };
        // The registry row and its sidecar agree: one key.
        let runs = vec![
            row("run-a", "exec-a", &verifier),
            row("run-a", "exec-a", &verifier),
            row("run-b", "exec-b", "sha256:other"),
        ];
        assert_eq!(
            recorded_execution_key(&runs, "run-a", "cap-a").as_deref(),
            Some("exec-a")
        );
        // Knowing a Run id is not enough, nor is another Run's capability.
        assert_eq!(recorded_execution_key(&runs, "run-b", "cap-a"), None);
        assert_eq!(recorded_execution_key(&runs, "run-a", "cap-b"), None);
        // An older record kept the capability raw.
        assert_eq!(
            recorded_execution_key(&[row("run-a", "exec-a", "cap-a")], "run-a", "cap-a").as_deref(),
            Some("exec-a")
        );
        // Records that disagree about the same Run name no key.
        let split = vec![
            row("run-a", "exec-a", &verifier),
            row("run-a", "exec-z", &verifier),
        ];
        assert_eq!(recorded_execution_key(&split, "run-a", "cap-a"), None);
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
