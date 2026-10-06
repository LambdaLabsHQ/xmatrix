use std::net::IpAddr;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{CliError, Result};
use crate::profile::{InstallationRoot, ProfileId, reject_symlink, write_private_json};

pub const DAEMON_HOST_CONTROL_SCHEMA_VERSION: u32 = 1;
pub const APPLY_DEFAULT_REVISION_PATH: &str = "/host/default/apply";
pub const HOST_STATUS_PATH: &str = "/host/status";
pub const HOST_RECONCILE_PATH: &str = "/host/reconcile";
pub const PROFILE_STATUS_PATH: &str = "/host/profile/status";
pub const START_PROFILE_PATH: &str = "/host/profile/start";
pub const STOP_PROFILE_PATH: &str = "/host/profile/stop";
pub const RESTART_PROFILE_PATH: &str = "/host/profile/restart";
pub const HOST_CONTROL_CAPABILITY_HEADER: &str = "x-xmatrix-host-control-capability";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonHostControlState {
    pub schema_version: u32,
    pub generation: String,
    pub pid: u32,
    pub url: String,
    pub capability: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyDefaultRevisionRequest {
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyDefaultRevisionResponse {
    pub state: String,
    pub requested_revision: u64,
    pub applied_revision: u64,
    pub default_profile_id: ProfileId,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub runtime_state: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ApplyDefaultRevisionOutcome {
    Applied(ApplyDefaultRevisionResponse),
    Pending(ApplyDefaultRevisionResponse),
    Superseded(ApplyDefaultRevisionResponse),
    Unavailable,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonHostProfileState {
    pub profile_id: ProfileId,
    pub name: String,
    pub hub_url: String,
    pub lifecycle: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonHostStatus {
    pub schema_version: u32,
    pub generation: String,
    pub loaded_registry_revision: u64,
    pub default_profile_id: ProfileId,
    pub profiles: Vec<DaemonHostProfileState>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileControlRequest {
    pub profile_id: ProfileId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileControlResponse {
    pub profile_id: ProfileId,
    pub lifecycle: String,
    pub loaded_registry_revision: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProfileControlAction {
    Start,
    Stop,
    Restart,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DaemonHostQueryOutcome<T> {
    Available(T),
    Unavailable,
    Unsupported,
}

impl<T> DaemonHostQueryOutcome<T> {
    pub fn into_available(self) -> Option<T> {
        match self {
            Self::Available(value) => Some(value),
            Self::Unavailable | Self::Unsupported => None,
        }
    }
}

pub fn control_state_path(installation: &InstallationRoot) -> PathBuf {
    installation.daemon_host_root().join("control.json")
}

pub fn host_state_path(installation: &InstallationRoot) -> PathBuf {
    installation.daemon_host_root().join("state.json")
}

pub fn update_recovery_state_path(installation: &InstallationRoot) -> PathBuf {
    installation.daemon_host_root().join("update-recovery.json")
}

pub fn persist_control_state(
    installation: &InstallationRoot,
    state: &DaemonHostControlState,
) -> Result<()> {
    validate_control_state(state)?;
    write_private_json(
        &control_state_path(installation),
        &serde_json::to_value(state)?,
    )
}

pub fn persist_host_state<T: Serialize>(installation: &InstallationRoot, state: &T) -> Result<()> {
    write_private_json(
        &host_state_path(installation),
        &serde_json::to_value(state)?,
    )
}

pub fn persist_update_recovery_state<T: Serialize>(
    installation: &InstallationRoot,
    state: &T,
) -> Result<()> {
    write_private_json(
        &update_recovery_state_path(installation),
        &serde_json::to_value(state)?,
    )
}

pub fn remove_control_state_if_generation(
    installation: &InstallationRoot,
    generation: &str,
) -> Result<()> {
    let path = control_state_path(installation);
    reject_symlink(&path, "daemon host control state")?;
    let current = match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str::<DaemonHostControlState>(&raw).ok(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(CliError::Io(err)),
    };
    if current
        .as_ref()
        .is_some_and(|state| state.generation == generation)
    {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

pub async fn apply_default_revision(
    installation: &InstallationRoot,
    revision: u64,
) -> Result<ApplyDefaultRevisionOutcome> {
    let Some(state) = load_control_state(installation)? else {
        return Ok(ApplyDefaultRevisionOutcome::Unavailable);
    };
    let body = serde_json::to_vec(&ApplyDefaultRevisionRequest { revision })?;
    let Some((status, response_body)) =
        send_control_request(&state, APPLY_DEFAULT_REVISION_PATH, "POST", &body).await?
    else {
        return Ok(ApplyDefaultRevisionOutcome::Unavailable);
    };
    if status == 404 {
        return Ok(ApplyDefaultRevisionOutcome::Unsupported);
    }
    let response: ApplyDefaultRevisionResponse = serde_json::from_slice(&response_body)
        .map_err(|err| CliError::Auth(format!("Malformed daemon host response: {err}")))?;
    if response.requested_revision != revision
        || response.applied_revision == 0
        || response.default_profile_id.as_str().is_empty()
    {
        return Err(CliError::Auth(
            "Daemon host returned an inexact default revision acknowledgement".into(),
        ));
    }
    match (status, response.state.as_str()) {
        (200, "applied") if response.applied_revision == revision => {
            Ok(ApplyDefaultRevisionOutcome::Applied(response))
        }
        (202, "pending") if response.applied_revision == revision => {
            Ok(ApplyDefaultRevisionOutcome::Pending(response))
        }
        (409, "superseded") if response.applied_revision > revision => {
            Ok(ApplyDefaultRevisionOutcome::Superseded(response))
        }
        _ => Err(CliError::Auth(format!(
            "Daemon host returned inconsistent apply-default state `{}` with status {status}",
            response.state
        ))),
    }
}

pub async fn daemon_host_status(
    installation: &InstallationRoot,
) -> Result<DaemonHostQueryOutcome<DaemonHostStatus>> {
    let Some(state) = load_control_state(installation)? else {
        return Ok(DaemonHostQueryOutcome::Unavailable);
    };
    let Some((status, response_body)) =
        send_control_request(&state, HOST_STATUS_PATH, "GET", &[]).await?
    else {
        return Ok(DaemonHostQueryOutcome::Unavailable);
    };
    if status == 404 {
        return Ok(DaemonHostQueryOutcome::Unsupported);
    }
    if status != 200 {
        return Err(CliError::Auth(format!(
            "Daemon host status request failed with status {status}"
        )));
    }
    let response = serde_json::from_slice(&response_body)
        .map_err(|err| CliError::Auth(format!("Malformed daemon host status: {err}")))?;
    Ok(DaemonHostQueryOutcome::Available(response))
}

pub async fn reconcile_daemon_host(
    installation: &InstallationRoot,
) -> Result<DaemonHostQueryOutcome<ApplyDefaultRevisionResponse>> {
    let Some(state) = load_control_state(installation)? else {
        return Ok(DaemonHostQueryOutcome::Unavailable);
    };
    let Some((status, response_body)) =
        send_control_request(&state, HOST_RECONCILE_PATH, "POST", b"{}").await?
    else {
        return Ok(DaemonHostQueryOutcome::Unavailable);
    };
    if status == 404 {
        return Ok(DaemonHostQueryOutcome::Unsupported);
    }
    if !matches!(status, 200 | 202 | 409) {
        return Err(CliError::Auth(format!(
            "Daemon host reconcile failed with status {status}"
        )));
    }
    let response = serde_json::from_slice(&response_body).map_err(|err| {
        CliError::Auth(format!("Malformed daemon host reconcile response: {err}"))
    })?;
    Ok(DaemonHostQueryOutcome::Available(response))
}

pub async fn daemon_profile_control(
    installation: &InstallationRoot,
    action: ProfileControlAction,
    profile_id: &ProfileId,
) -> Result<DaemonHostQueryOutcome<ProfileControlResponse>> {
    let Some(state) = load_control_state(installation)? else {
        return Ok(DaemonHostQueryOutcome::Unavailable);
    };
    let path = match action {
        ProfileControlAction::Start => START_PROFILE_PATH,
        ProfileControlAction::Stop => STOP_PROFILE_PATH,
        ProfileControlAction::Restart => RESTART_PROFILE_PATH,
    };
    let body = serde_json::to_vec(&ProfileControlRequest {
        profile_id: profile_id.clone(),
    })?;
    let Some((status, response_body)) = send_control_request(&state, path, "POST", &body).await?
    else {
        return Ok(DaemonHostQueryOutcome::Unavailable);
    };
    if status == 404 {
        return Ok(DaemonHostQueryOutcome::Unsupported);
    }
    if status != 200 && status != 202 {
        return Err(CliError::Auth(format!(
            "Daemon profile control request failed with status {status}"
        )));
    }
    let response: ProfileControlResponse = serde_json::from_slice(&response_body)
        .map_err(|err| CliError::Auth(format!("Malformed daemon profile response: {err}")))?;
    if &response.profile_id != profile_id {
        return Err(CliError::Auth(
            "Daemon host returned a profile response for a different profile".into(),
        ));
    }
    Ok(DaemonHostQueryOutcome::Available(response))
}

fn load_control_state(installation: &InstallationRoot) -> Result<Option<DaemonHostControlState>> {
    let path = control_state_path(installation);
    reject_symlink(&path, "daemon host control state")?;
    let Some(raw) = crate::fs::missing_file_as_none(std::fs::read_to_string(&path))? else {
        return Ok(None);
    };
    let state: DaemonHostControlState = serde_json::from_str(&raw)
        .map_err(|err| CliError::Auth(format!("Invalid daemon host control state: {err}")))?;
    validate_control_state(&state)?;
    Ok(Some(state))
}

fn validate_control_state(state: &DaemonHostControlState) -> Result<()> {
    if state.schema_version != DAEMON_HOST_CONTROL_SCHEMA_VERSION
        || state.pid == 0
        || uuid::Uuid::parse_str(&state.generation)
            .ok()
            .is_none_or(|parsed| parsed.to_string() != state.generation)
        || !valid_capability(&state.capability)
        || normalize_loopback_control_url(&state.url).as_deref() != Some(state.url.as_str())
    {
        return Err(CliError::Auth("Invalid daemon host control state".into()));
    }
    Ok(())
}

fn valid_capability(value: &str) -> bool {
    (32..=256).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub fn normalize_loopback_control_url(value: &str) -> Option<String> {
    let mut url = reqwest::Url::parse(value.trim()).ok()?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return None;
    }
    let address = url
        .host_str()?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .ok()?;
    if !address.is_loopback() || url.port().is_none() {
        return None;
    }
    url.set_path("");
    Some(url.as_str().trim_end_matches('/').to_string())
}

async fn send_control_request(
    state: &DaemonHostControlState,
    path: &str,
    method: &str,
    body: &[u8],
) -> Result<Option<(u16, Vec<u8>)>> {
    let url = normalize_loopback_control_url(&state.url)
        .ok_or_else(|| CliError::Auth("Invalid daemon host control URL".into()))?;
    let address = url
        .strip_prefix("http://")
        .ok_or_else(|| CliError::Auth("Invalid daemon host control URL".into()))?;
    let request = format!(
        "{method} {path} HTTP/1.1\r\nhost: {address}\r\n{HOST_CONTROL_CAPABILITY_HEADER}: {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        state.capability,
        body.len()
    );
    let Some(response) = send_loopback_http(
        address,
        request.as_bytes(),
        body,
        Duration::from_secs(5),
        Some(64 * 1024),
    )
    .await
    else {
        return Ok(None);
    };
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| CliError::Auth("Malformed daemon host response".into()))?;
    let headers = String::from_utf8_lossy(&response[..split]);
    let status = http_response_status(&headers)
        .ok_or_else(|| CliError::Auth("Malformed daemon host response".into()))?;
    Ok(Some((status, response[split + 4..].to_vec())))
}

pub(crate) fn http_response_status(response: &str) -> Option<u16> {
    response
        .lines()
        .next()?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

/// The URL and capability policy stays with each local-control caller.
pub(crate) async fn send_loopback_http(
    address: &str,
    request: &[u8],
    body: &[u8],
    timeout: Duration,
    response_limit: Option<u64>,
) -> Option<Vec<u8>> {
    tokio::time::timeout(timeout, async {
        let mut stream = tokio::net::TcpStream::connect(address).await?;
        stream.write_all(request).await?;
        stream.write_all(body).await?;
        stream.flush().await?;
        let mut response = Vec::new();
        if let Some(limit) = response_limit {
            stream.take(limit).read_to_end(&mut response).await?;
        } else {
            stream.read_to_end(&mut response).await?;
        }
        Ok::<Vec<u8>, std::io::Error>(response)
    })
    .await
    .ok()?
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_control_urls_are_exact_loopback_origins() {
        assert_eq!(
            normalize_loopback_control_url("http://127.0.0.1:4455"),
            Some("http://127.0.0.1:4455".into())
        );
        assert_eq!(
            normalize_loopback_control_url("http://[::1]:4455/"),
            Some("http://[::1]:4455".into())
        );
        for invalid in [
            "http://localhost:4455",
            "https://127.0.0.1:4455",
            "http://127.0.0.1",
            "http://127.0.0.1:4455/path",
            "http://user@127.0.0.1:4455",
        ] {
            assert_eq!(normalize_loopback_control_url(invalid), None, "{invalid}");
        }
    }

    #[tokio::test]
    async fn apply_default_requires_an_exact_ack() {
        let root = std::env::temp_dir().join(format!(
            "xmatrix-host-control-test-{}",
            uuid::Uuid::new_v4()
        ));
        let installation = InstallationRoot::new(root.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let profile_id = ProfileId::parse("profile:00000000-0000-0000-0000-000000000001").unwrap();
        persist_control_state(
            &installation,
            &DaemonHostControlState {
                schema_version: 1,
                generation: "00000000-0000-0000-0000-000000000002".into(),
                pid: std::process::id(),
                url: format!("http://{address}"),
                capability: "a".repeat(32),
                updated_at: "1".into(),
            },
        )
        .unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while request.len() < 4096 && !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let mut chunk = [0_u8; 512];
                let read = stream.read(&mut chunk).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
            }
            let body_start = request
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .unwrap()
                + 4;
            let headers = std::str::from_utf8(&request[..body_start]).unwrap();
            let content_length: usize = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .unwrap()
                .parse()
                .unwrap();
            assert!(body_start + content_length <= 4096);
            // The client writes headers and body separately. Closing without
            // consuming the body can reset TCP after an otherwise valid ACK.
            while request.len() < body_start + content_length {
                let mut chunk = [0_u8; 512];
                let read = stream.read(&mut chunk).await.unwrap();
                assert!(read > 0, "request ended before its declared body");
                request.extend_from_slice(&chunk[..read]);
            }
            let received: ApplyDefaultRevisionRequest =
                serde_json::from_slice(&request[body_start..]).unwrap();
            assert_eq!(received.revision, 7);
            let request = String::from_utf8_lossy(&request);
            assert!(request.starts_with("POST /host/default/apply HTTP/1.1"));
            assert!(
                request.contains(
                    "x-xmatrix-host-control-capability: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                )
            );
            let body = serde_json::to_string(&ApplyDefaultRevisionResponse {
                state: "applied".into(),
                requested_revision: 7,
                applied_revision: 7,
                default_profile_id: profile_id,
                runtime_state: Some("ready".into()),
            })
            .unwrap();
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        let outcome = apply_default_revision(&installation, 7).await.unwrap();
        assert!(matches!(outcome, ApplyDefaultRevisionOutcome::Applied(_)));
        server.await.unwrap();
        let _ = std::fs::remove_dir_all(root);
    }
}
