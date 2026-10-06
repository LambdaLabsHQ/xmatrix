use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::config;
use crate::error::{CliError, Result};

pub const SESSION_RELOAD_PATH: &str = "/auth/session/reload";
pub const ENVIRONMENT_SWITCH_STOP_PATH: &str = "/auth/environment-switch/stop";
pub const SESSION_RELOAD_CAPABILITY_HEADER: &str = "x-xmatrix-session-reload-capability";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonAuthBrokerState {
    pub url: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub session_reload_capability: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DaemonSessionReloadOutcome {
    Reloaded,
    AlreadyCurrent,
    Unavailable,
    Unsupported,
}

#[derive(Deserialize)]
struct SessionReloadResponse {
    reloaded: bool,
}

#[derive(Deserialize)]
struct ErrorResponse {
    error: Option<String>,
}

pub fn broker_state_path() -> PathBuf {
    config::profile_state_dir().join("daemon-auth-broker.json")
}

pub async fn reload_saved_session_in_local_daemon() -> Result<DaemonSessionReloadOutcome> {
    let Some(state) = load_broker_state().await? else {
        return Ok(DaemonSessionReloadOutcome::Unavailable);
    };
    reload_saved_session_from_broker_state(state).await
}

pub(crate) async fn load_broker_state() -> Result<Option<DaemonAuthBrokerState>> {
    let Some(raw) =
        crate::fs::missing_file_as_none(tokio::fs::read_to_string(broker_state_path()).await)?
    else {
        return Ok(None);
    };
    let state: DaemonAuthBrokerState = serde_json::from_str(&raw)
        .map_err(|err| CliError::Auth(format!("Invalid local daemon auth broker state: {err}")))?;
    Ok(Some(state))
}

async fn send_broker_control_request(
    state: DaemonAuthBrokerState,
    path: &str,
) -> Result<Option<(u16, String)>> {
    let Some(capability) = state
        .session_reload_capability
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(Some((404, String::new())));
    };
    if capability.len() > 256
        || !capability
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(CliError::Auth(
            "Invalid local daemon session reload capability".into(),
        ));
    }
    let Some(url) = normalize_loopback_broker_url(&state.url) else {
        return Err(CliError::Auth(
            "Invalid local daemon auth broker URL".into(),
        ));
    };
    let address = url
        .strip_prefix("http://")
        .ok_or_else(|| CliError::Auth("Invalid local daemon auth broker URL".into()))?;
    let request = format!(
        "POST {path} HTTP/1.1\r\nhost: {address}\r\n{SESSION_RELOAD_CAPABILITY_HEADER}: {capability}\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}"
    );
    let Some(response) = crate::daemon_host::send_loopback_http(
        address,
        request.as_bytes(),
        b"",
        Duration::from_secs(5),
        None,
    )
    .await
    else {
        return Ok(None);
    };
    let response = String::from_utf8_lossy(&response);
    let status = crate::daemon_host::http_response_status(&response)
        .ok_or_else(|| CliError::Auth("Malformed local daemon control response".into()))?;
    let body = response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .ok_or_else(|| CliError::Auth("Malformed local daemon control response".into()))?;
    Ok(Some((status, body)))
}

async fn reload_saved_session_from_broker_state(
    state: DaemonAuthBrokerState,
) -> Result<DaemonSessionReloadOutcome> {
    let Some((status, body)) = send_broker_control_request(state, SESSION_RELOAD_PATH).await?
    else {
        return Ok(DaemonSessionReloadOutcome::Unavailable);
    };
    if status == 404 {
        return Ok(DaemonSessionReloadOutcome::Unsupported);
    }
    if !(200..300).contains(&status) {
        let payload = serde_json::from_str::<ErrorResponse>(&body).ok();
        return Err(CliError::Auth(
            payload
                .and_then(|value| value.error)
                .unwrap_or_else(|| format!("Daemon session reload failed with status {status}")),
        ));
    }

    let payload: SessionReloadResponse = serde_json::from_str(&body)?;
    Ok(if payload.reloaded {
        DaemonSessionReloadOutcome::Reloaded
    } else {
        DaemonSessionReloadOutcome::AlreadyCurrent
    })
}

pub(crate) fn normalize_loopback_broker_url(value: &str) -> Option<String> {
    crate::daemon_host::normalize_loopback_control_url(value)
}

#[cfg(test)]
mod tests {
    mod http_fixture {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/support/http_accept_fixture.rs"
        ));
    }

    use super::{
        DaemonAuthBrokerState, DaemonSessionReloadOutcome, normalize_loopback_broker_url,
        reload_saved_session_from_broker_state,
    };
    use tokio::io::AsyncWriteExt;

    #[test]
    fn broker_session_reload_accepts_only_explicit_loopback_http_urls() {
        assert_eq!(
            normalize_loopback_broker_url("http://127.0.0.1:4512"),
            Some("http://127.0.0.1:4512".to_string())
        );
        assert_eq!(
            normalize_loopback_broker_url("http://[::1]:4512/"),
            Some("http://[::1]:4512".to_string())
        );
        assert_eq!(normalize_loopback_broker_url("http://localhost:4512"), None);
        assert_eq!(
            normalize_loopback_broker_url("https://127.0.0.1:4512"),
            None
        );
        assert_eq!(
            normalize_loopback_broker_url("http://127.0.0.1:4512/path"),
            None
        );
        assert_eq!(normalize_loopback_broker_url("http://127.0.0.1"), None);
    }

    #[tokio::test]
    async fn broker_session_reload_sends_the_private_capability() {
        let (address, server) = http_fixture::spawn_single_request_server(|mut stream, request| async move {
            assert!(request.starts_with("POST /auth/session/reload HTTP/1.1"));
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("x-xmatrix-session-reload-capability: reload-test")
            );
            let body = r#"{"reloaded":true}"#;
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }).await;

        let outcome = reload_saved_session_from_broker_state(DaemonAuthBrokerState {
            url: format!("http://{address}"),
            updated_at: "1".to_string(),
            session_reload_capability: Some("reload-test".to_string()),
        })
        .await
        .unwrap();

        assert_eq!(outcome, DaemonSessionReloadOutcome::Reloaded);
        server.await.unwrap();
    }
}
