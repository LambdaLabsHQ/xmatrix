use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use xmatrix_cli_core::config;
use xmatrix_cli_core::daemon_host::{
    APPLY_DEFAULT_REVISION_PATH, ApplyDefaultRevisionRequest, ApplyDefaultRevisionResponse,
    DAEMON_HOST_CONTROL_SCHEMA_VERSION, DaemonHostControlState, HOST_CONTROL_CAPABILITY_HEADER,
    HOST_RECONCILE_PATH, HOST_STATUS_PATH, PROFILE_STATUS_PATH, ProfileControlAction,
    ProfileControlRequest, ProfileControlResponse, RESTART_PROFILE_PATH, START_PROFILE_PATH,
    STOP_PROFILE_PATH, persist_control_state, persist_host_state,
    remove_control_state_if_generation,
};
use xmatrix_cli_core::error::{CliError, Result};
use xmatrix_cli_core::profile::{InstallationRoot, ProfileId, ProfileRegistry, ProfileStore};

const HOST_REQUEST_MAX_BYTES: usize = 64 * 1024;
const HOST_REQUEST_TIMEOUT_SECS: u64 = 5;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ProfileRuntimeLifecycleState {
    Disabled,
    Starting,
    Ready,
    Reconnecting,
    Draining,
    Backoff,
    Degraded,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedProfileRuntimeState {
    pub profile_id: ProfileId,
    pub name: String,
    pub hub_url: String,
    pub lifecycle: ProfileRuntimeLifecycleState,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileManagerSnapshot {
    pub schema_version: u32,
    pub generation: String,
    pub loaded_registry_revision: u64,
    pub default_profile_id: ProfileId,
    pub profiles: Vec<ManagedProfileRuntimeState>,
    pub updated_at: String,
}

#[derive(Clone)]
pub(crate) struct ProfileManager {
    installation: InstallationRoot,
    generation: String,
    state: Arc<RwLock<ProfileManagerSnapshot>>,
}

impl ProfileManager {
    pub(crate) fn load(installation: InstallationRoot) -> Result<Self> {
        let registry = ProfileStore::new(installation.clone()).load_or_bootstrap()?;
        let generation = uuid::Uuid::new_v4().to_string();
        let snapshot = snapshot_from_registry(&registry, &generation, None);
        let manager = Self {
            installation,
            generation,
            state: Arc::new(RwLock::new(snapshot)),
        };
        manager.persist_snapshot()?;
        Ok(manager)
    }

    pub(crate) fn generation(&self) -> &str {
        &self.generation
    }

    pub(crate) fn installation(&self) -> &InstallationRoot {
        &self.installation
    }

    pub(crate) fn snapshot(&self) -> Result<ProfileManagerSnapshot> {
        self.state
            .read()
            .map(|state| state.clone())
            .map_err(|_| CliError::Launch("Daemon ProfileManager state is poisoned".into()))
    }

    pub(crate) fn reconcile(
        &self,
        requested_revision: Option<u64>,
    ) -> Result<ApplyDefaultRevisionResponse> {
        let registry = ProfileStore::new(self.installation.clone()).load_or_bootstrap()?;
        if let Some(requested) = requested_revision
            && requested > registry.revision
        {
            return Err(CliError::Launch(format!(
                "Requested profile registry revision {requested} is newer than durable revision {}",
                registry.revision
            )));
        }
        let previous = self.snapshot()?;
        let next = snapshot_from_registry(&registry, &self.generation, Some(&previous));
        {
            let mut state = self
                .state
                .write()
                .map_err(|_| CliError::Launch("Daemon ProfileManager state is poisoned".into()))?;
            if next.loaded_registry_revision >= state.loaded_registry_revision {
                *state = next;
            }
        }
        self.persist_snapshot()?;
        let applied = self.snapshot()?;
        let requested = requested_revision.unwrap_or(applied.loaded_registry_revision);
        let runtime_state = applied
            .profiles
            .iter()
            .find(|profile| profile.profile_id == applied.default_profile_id)
            .map(|profile| lifecycle_label(profile.lifecycle).to_string());
        let state = if applied.loaded_registry_revision > requested {
            "superseded"
        } else {
            "applied"
        };
        Ok(ApplyDefaultRevisionResponse {
            state: state.into(),
            requested_revision: requested,
            applied_revision: applied.loaded_registry_revision,
            default_profile_id: applied.default_profile_id,
            runtime_state,
        })
    }

    pub(crate) fn set_runtime_state(
        &self,
        profile_id: &ProfileId,
        lifecycle: ProfileRuntimeLifecycleState,
        detail: Option<String>,
    ) -> Result<()> {
        {
            let mut state = self
                .state
                .write()
                .map_err(|_| CliError::Launch("Daemon ProfileManager state is poisoned".into()))?;
            let profile = state
                .profiles
                .iter_mut()
                .find(|profile| &profile.profile_id == profile_id)
                .ok_or_else(|| {
                    CliError::Launch(format!(
                        "Daemon ProfileManager does not own profile {profile_id}"
                    ))
                })?;
            profile.lifecycle = lifecycle;
            profile.detail = detail;
            state.updated_at = config::unix_now_secs().to_string();
        }
        self.persist_snapshot()
    }

    pub(crate) fn profile_control_response(
        &self,
        profile_id: &ProfileId,
    ) -> Result<ProfileControlResponse> {
        let snapshot = self.snapshot()?;
        let profile = snapshot
            .profiles
            .iter()
            .find(|profile| &profile.profile_id == profile_id)
            .ok_or_else(|| {
                CliError::Launch(format!("Daemon does not know profile {profile_id}"))
            })?;
        Ok(ProfileControlResponse {
            profile_id: profile.profile_id.clone(),
            lifecycle: lifecycle_label(profile.lifecycle).into(),
            loaded_registry_revision: snapshot.loaded_registry_revision,
        })
    }

    fn persist_snapshot(&self) -> Result<()> {
        persist_host_state(&self.installation, &self.snapshot()?)
    }
}

fn snapshot_from_registry(
    registry: &ProfileRegistry,
    generation: &str,
    previous: Option<&ProfileManagerSnapshot>,
) -> ProfileManagerSnapshot {
    let previous = previous
        .map(|snapshot| {
            snapshot
                .profiles
                .iter()
                .map(|profile| (profile.profile_id.clone(), profile.clone()))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let profiles = registry
        .profiles
        .iter()
        .filter(|profile| profile.is_selectable())
        .map(|profile| {
            let prior = previous.get(&profile.id);
            let lifecycle = if !profile.enabled {
                ProfileRuntimeLifecycleState::Disabled
            } else {
                prior
                    .filter(|prior| prior.lifecycle != ProfileRuntimeLifecycleState::Disabled)
                    .map(|prior| prior.lifecycle)
                    .unwrap_or(ProfileRuntimeLifecycleState::Starting)
            };
            ManagedProfileRuntimeState {
                profile_id: profile.id.clone(),
                name: profile.name.clone(),
                hub_url: profile.hub_url.clone(),
                lifecycle,
                detail: prior.and_then(|prior| prior.detail.clone()),
            }
        })
        .collect();
    ProfileManagerSnapshot {
        schema_version: 1,
        generation: generation.into(),
        loaded_registry_revision: registry.revision,
        default_profile_id: registry.default_profile_id.clone(),
        profiles,
        updated_at: config::unix_now_secs().to_string(),
    }
}

pub(crate) fn lifecycle_label(state: ProfileRuntimeLifecycleState) -> &'static str {
    match state {
        ProfileRuntimeLifecycleState::Disabled => "disabled",
        ProfileRuntimeLifecycleState::Starting => "starting",
        ProfileRuntimeLifecycleState::Ready => "ready",
        ProfileRuntimeLifecycleState::Reconnecting => "reconnecting",
        ProfileRuntimeLifecycleState::Draining => "draining",
        ProfileRuntimeLifecycleState::Backoff => "backoff",
        ProfileRuntimeLifecycleState::Degraded => "degraded",
    }
}

pub(crate) struct DaemonHostControlServer {
    installation: InstallationRoot,
    generation: String,
    task: tokio::task::JoinHandle<()>,
}

pub(crate) struct DaemonHostProfileCommand {
    pub(crate) action: ProfileControlAction,
    pub(crate) profile_id: ProfileId,
    pub(crate) response: tokio::sync::oneshot::Sender<Result<ProfileControlResponse>>,
}

impl DaemonHostControlServer {
    pub(crate) async fn spawn(
        manager: ProfileManager,
    ) -> Result<(Self, tokio::sync::mpsc::Receiver<DaemonHostProfileCommand>)> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|err| {
                CliError::Launch(format!("Failed to bind daemon host control: {err}"))
            })?;
        let address = listener.local_addr()?;
        let capability = uuid::Uuid::new_v4().to_string();
        let generation = manager.generation().to_string();
        let installation = manager.installation().clone();
        persist_control_state(
            &installation,
            &DaemonHostControlState {
                schema_version: DAEMON_HOST_CONTROL_SCHEMA_VERSION,
                generation: generation.clone(),
                pid: std::process::id(),
                url: format!("http://{address}"),
                capability: capability.clone(),
                updated_at: config::unix_now_secs().to_string(),
            },
        )?;
        let (command_tx, command_rx) = tokio::sync::mpsc::channel(32);
        let task = tokio::spawn(async move {
            loop {
                let stream = match listener.accept().await {
                    Ok((stream, _)) => stream,
                    Err(error) => {
                        crate::survive_accept_error("daemon host control", error).await;
                        continue;
                    }
                };
                let manager = manager.clone();
                let capability = capability.clone();
                let command_tx = command_tx.clone();
                tokio::spawn(async move {
                    handle_control_request(stream, manager, capability, command_tx).await;
                });
            }
        });
        Ok((
            Self {
                installation,
                generation,
                task,
            },
            command_rx,
        ))
    }
}

impl Drop for DaemonHostControlServer {
    fn drop(&mut self) {
        self.task.abort();
        let _ = remove_control_state_if_generation(&self.installation, &self.generation);
    }
}

async fn handle_control_request(
    mut stream: tokio::net::TcpStream,
    manager: ProfileManager,
    capability: String,
    command_tx: tokio::sync::mpsc::Sender<DaemonHostProfileCommand>,
) {
    let request = match read_bounded_request(&mut stream).await {
        Ok(request) => request,
        Err(error) => {
            write_response(&mut stream, "400 Bad Request", &error_body(&error)).await;
            return;
        }
    };
    if header_value(&request.headers, HOST_CONTROL_CAPABILITY_HEADER).as_deref()
        != Some(capability.as_str())
    {
        write_response(
            &mut stream,
            "401 Unauthorized",
            r#"{"error":"unauthorized"}"#,
        )
        .await;
        return;
    }
    let result = match (request.method.as_str(), request.path.as_str()) {
        ("GET", HOST_STATUS_PATH) => manager.snapshot().map(|snapshot| {
            (
                "200 OK",
                serde_json::to_string(&snapshot).unwrap_or_else(|_| "{}".into()),
            )
        }),
        ("POST", HOST_RECONCILE_PATH) => manager.reconcile(None).and_then(|response| {
            super::persist_daemon_ready_state(&manager)?;
            Ok((
                if response.state == "applied" {
                    "200 OK"
                } else {
                    "202 Accepted"
                },
                serde_json::to_string(&response).unwrap_or_else(|_| "{}".into()),
            ))
        }),
        ("POST", APPLY_DEFAULT_REVISION_PATH) => {
            serde_json::from_slice::<ApplyDefaultRevisionRequest>(&request.body)
                .map_err(|error| CliError::Launch(format!("Invalid apply request: {error}")))
                .and_then(|request| manager.reconcile(Some(request.revision)))
                .and_then(|response| {
                    super::persist_daemon_ready_state(&manager)?;
                    let status = match response.state.as_str() {
                        "applied" => "200 OK",
                        "pending" => "202 Accepted",
                        "superseded" => "409 Conflict",
                        _ => "500 Internal Server Error",
                    };
                    Ok((
                        status,
                        serde_json::to_string(&response).unwrap_or_else(|_| "{}".into()),
                    ))
                })
        }
        ("POST", PROFILE_STATUS_PATH) => parse_profile_control_request(&request.body)
            .and_then(|request| manager.profile_control_response(&request.profile_id))
            .map(|response| {
                (
                    "200 OK",
                    serde_json::to_string(&response).unwrap_or_else(|_| "{}".into()),
                )
            }),
        ("POST", START_PROFILE_PATH | STOP_PROFILE_PATH | RESTART_PROFILE_PATH) => {
            let action = match request.path.as_str() {
                START_PROFILE_PATH => ProfileControlAction::Start,
                STOP_PROFILE_PATH => ProfileControlAction::Stop,
                _ => ProfileControlAction::Restart,
            };
            match parse_profile_control_request(&request.body) {
                Ok(request) => {
                    let (response_tx, response_rx) = tokio::sync::oneshot::channel();
                    if command_tx
                        .send(DaemonHostProfileCommand {
                            action,
                            profile_id: request.profile_id,
                            response: response_tx,
                        })
                        .await
                        .is_err()
                    {
                        Err(CliError::Launch(
                            "Daemon host command loop is unavailable".into(),
                        ))
                    } else {
                        match tokio::time::timeout(
                            std::time::Duration::from_secs(HOST_REQUEST_TIMEOUT_SECS),
                            response_rx,
                        )
                        .await
                        {
                            Ok(Ok(Ok(response))) => Ok((
                                if response.lifecycle == "ready" {
                                    "200 OK"
                                } else {
                                    "202 Accepted"
                                },
                                serde_json::to_string(&response).unwrap_or_else(|_| "{}".into()),
                            )),
                            Ok(Ok(Err(error))) => Err(error),
                            Ok(Err(_)) | Err(_) => Err(CliError::Launch(
                                "Daemon host command response timed out".into(),
                            )),
                        }
                    }
                }
                Err(error) => Err(error),
            }
        }
        _ => {
            write_response(&mut stream, "404 Not Found", r#"{"error":"not found"}"#).await;
            return;
        }
    };
    match result {
        Ok((status, body)) => write_response(&mut stream, status, &body).await,
        Err(error) => {
            write_response(&mut stream, "409 Conflict", &error_body(&error)).await;
        }
    }
}

fn parse_profile_control_request(body: &[u8]) -> Result<ProfileControlRequest> {
    serde_json::from_slice(body)
        .map_err(|error| CliError::Launch(format!("Invalid profile control request: {error}")))
}

struct BoundedHttpRequest {
    method: String,
    path: String,
    headers: String,
    body: Vec<u8>,
}

async fn read_bounded_request(stream: &mut tokio::net::TcpStream) -> Result<BoundedHttpRequest> {
    tokio::time::timeout(
        std::time::Duration::from_secs(HOST_REQUEST_TIMEOUT_SECS),
        async {
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 4096];
            let (header_end, content_length) = loop {
                let read = stream.read(&mut buffer).await?;
                if read == 0 {
                    return Err(CliError::Launch("Incomplete daemon host request".into()));
                }
                bytes.extend_from_slice(&buffer[..read]);
                if bytes.len() > HOST_REQUEST_MAX_BYTES {
                    return Err(CliError::Launch("Daemon host request is too large".into()));
                }
                if let Some(header_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..header_end]);
                    let content_length = header_value(&headers, "content-length")
                        .map(|value| value.parse::<usize>())
                        .transpose()
                        .map_err(|_| CliError::Launch("Invalid content-length".into()))?
                        .unwrap_or(0);
                    if header_end + 4 + content_length > HOST_REQUEST_MAX_BYTES {
                        return Err(CliError::Launch("Daemon host request is too large".into()));
                    }
                    break (header_end, content_length);
                }
            };
            while bytes.len() < header_end + 4 + content_length {
                let read = stream.read(&mut buffer).await?;
                if read == 0 {
                    return Err(CliError::Launch(
                        "Incomplete daemon host request body".into(),
                    ));
                }
                bytes.extend_from_slice(&buffer[..read]);
                if bytes.len() > HOST_REQUEST_MAX_BYTES {
                    return Err(CliError::Launch("Daemon host request is too large".into()));
                }
            }
            let headers = String::from_utf8(bytes[..header_end].to_vec()).map_err(|_| {
                CliError::Launch("Daemon host request headers are not UTF-8".into())
            })?;
            let mut request_line = headers
                .lines()
                .next()
                .unwrap_or_default()
                .split_whitespace();
            let method = request_line.next().unwrap_or_default().to_string();
            let path = request_line.next().unwrap_or_default().to_string();
            if request_line.next() != Some("HTTP/1.1") || request_line.next().is_some() {
                return Err(CliError::Launch("Invalid daemon host request line".into()));
            }
            Ok(BoundedHttpRequest {
                method,
                path,
                headers,
                body: bytes[header_end + 4..header_end + 4 + content_length].to_vec(),
            })
        },
    )
    .await
    .map_err(|_| CliError::Launch("Daemon host request timed out".into()))?
}

fn header_value(headers: &str, name: &str) -> Option<String> {
    headers.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name)
            .then(|| value.trim().to_string())
    })
}

async fn write_response(stream: &mut tokio::net::TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn error_body(error: &impl std::fmt::Display) -> String {
    serde_json::json!({ "error": error.to_string() }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile_store(name: &str) -> (std::path::PathBuf, ProfileStore) {
        let root = std::env::temp_dir().join(format!(
            "xmatrix-profile-manager-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        let store = ProfileStore::new(InstallationRoot::new(root.clone()));
        (root, store)
    }

    #[test]
    fn reconcile_is_monotonic_and_reports_superseded_requests() {
        let (root, store) = profile_store("reconcile");
        let initial = store.load_or_bootstrap().unwrap();
        let manager = ProfileManager::load(InstallationRoot::new(root.clone())).unwrap();
        let created = store
            .create(initial.revision, "second", "https://example.com", true)
            .unwrap();
        let switched = store.set_default(created.revision, "second").unwrap();
        let response = manager.reconcile(Some(created.revision)).unwrap();
        assert_eq!(response.state, "superseded");
        assert_eq!(response.applied_revision, switched.revision);
        assert_eq!(response.default_profile_id, switched.default_profile_id);
        let duplicate = manager.reconcile(Some(switched.revision)).unwrap();
        assert_eq!(duplicate.state, "applied");
        assert_eq!(duplicate.applied_revision, switched.revision);
        assert_eq!(duplicate.runtime_state.as_deref(), Some("starting"));
        manager
            .set_runtime_state(
                &switched.default_profile_id,
                ProfileRuntimeLifecycleState::Degraded,
                Some("login required".into()),
            )
            .unwrap();
        let degraded = manager.reconcile(Some(switched.revision)).unwrap();
        assert_eq!(degraded.state, "applied");
        assert_eq!(degraded.runtime_state.as_deref(), Some("degraded"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn control_endpoint_requires_capability_and_applies_exact_revision() {
        let (root, store) = profile_store("control");
        let initial = store.load_or_bootstrap().unwrap();
        let manager = ProfileManager::load(InstallationRoot::new(root.clone())).unwrap();
        let (server, _commands) = DaemonHostControlServer::spawn(manager.clone())
            .await
            .unwrap();
        let created = store
            .create(initial.revision, "second", "https://example.com", true)
            .unwrap();
        let switched = store.set_default(created.revision, "second").unwrap();

        let outcome = xmatrix_cli_core::daemon_host::apply_default_revision(
            &InstallationRoot::new(root.clone()),
            switched.revision,
        )
        .await
        .unwrap();
        assert!(matches!(
            outcome,
            xmatrix_cli_core::daemon_host::ApplyDefaultRevisionOutcome::Applied(_)
        ));
        assert_eq!(
            manager.snapshot().unwrap().default_profile_id,
            switched.default_profile_id
        );
        drop(server);
        assert!(!root.join("daemon-host/control.json").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn profile_control_is_capability_authenticated_and_reaches_host_loop() {
        let (root, store) = profile_store("profile-command");
        let registry = store.load_or_bootstrap().unwrap();
        let profile_id = registry.default_profile_id.clone();
        let manager = ProfileManager::load(InstallationRoot::new(root.clone())).unwrap();
        let (server, mut commands) = DaemonHostControlServer::spawn(manager.clone())
            .await
            .unwrap();

        let control: DaemonHostControlState = serde_json::from_str(
            &std::fs::read_to_string(root.join("daemon-host/control.json")).unwrap(),
        )
        .unwrap();
        let address = control.url.trim_start_matches("http://");
        let mut unauthorized = tokio::net::TcpStream::connect(address).await.unwrap();
        unauthorized
            .write_all(
                b"GET /host/status HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        let mut response = Vec::new();
        unauthorized.read_to_end(&mut response).await.unwrap();
        assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 401 Unauthorized"));

        let manager_for_command = manager.clone();
        let expected_profile_id = profile_id.clone();
        let command_task = tokio::spawn(async move {
            let command = commands.recv().await.unwrap();
            assert_eq!(command.action, ProfileControlAction::Start);
            assert_eq!(command.profile_id, expected_profile_id);
            manager_for_command
                .set_runtime_state(
                    &command.profile_id,
                    ProfileRuntimeLifecycleState::Ready,
                    None,
                )
                .unwrap();
            command
                .response
                .send(manager_for_command.profile_control_response(&command.profile_id))
                .unwrap();
        });
        let outcome = xmatrix_cli_core::daemon_host::daemon_profile_control(
            &InstallationRoot::new(root.clone()),
            ProfileControlAction::Start,
            &profile_id,
        )
        .await
        .unwrap();
        assert!(matches!(
            outcome,
            xmatrix_cli_core::daemon_host::DaemonHostQueryOutcome::Available(
                ProfileControlResponse { lifecycle, .. }
            ) if lifecycle == "ready"
        ));
        command_task.await.unwrap();
        drop(server);
        let _ = std::fs::remove_dir_all(root);
    }
}
