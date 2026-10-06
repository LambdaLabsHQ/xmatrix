use std::net::TcpListener;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use serde::Deserialize;
use uuid::Uuid;

use crate::config::{CliSession, save_session, unix_now_secs};
use crate::error::{CliError, Result};
use crate::protocol::{
    AuthResponse, AuthUser, DEFAULT_HUB_URL, DEFAULT_WEB_URL, HubRoutes, with_route,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeResponse {
    user: AuthUser,
}

const SESSION_REFRESH_LOCK_TIMEOUT: Duration = Duration::from_secs(15);
const SESSION_REFRESH_LOCK_RETRY_DELAY: Duration = Duration::from_millis(100);
const SESSION_REFRESH_LOCK_STALE_SECS: u64 = 120;

pub async fn login_with_browser(hub_url: &str) -> Result<AuthResponse> {
    crate::access::prepare_for_hub(hub_url, true).await?;
    match start_device_login(hub_url).await {
        Ok(device_login) => login_with_browser_device_flow(hub_url, &device_login).await,
        Err(error) => {
            eprintln!(
                "Hosted browser login unavailable ({error}). Falling back to localhost callback."
            );
            login_with_browser_loopback(hub_url).await
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLoginStartResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceLoginPollResponse {
    status: String,
    #[serde(default)]
    interval: Option<u64>,
    #[serde(default)]
    token: Option<String>,
    #[serde(default, rename = "refreshToken")]
    refresh_token: Option<String>,
    #[serde(default)]
    user: Option<AuthUser>,
    #[serde(default)]
    hub_url: Option<String>,
    #[serde(default)]
    relay_url: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

pub async fn start_device_login(hub_url: &str) -> Result<DeviceLoginStartResponse> {
    let url = with_route(hub_url, HubRoutes::DEVICE_START);
    crate::http::request_json(&url, "POST", None, None)
        .await
        .map_err(|e| CliError::Auth(format!("Failed to start browser login: {e}")))
}

async fn login_with_browser_device_flow(
    hub_url: &str,
    device_login: &DeviceLoginStartResponse,
) -> Result<AuthResponse> {
    println!("Open this URL in any browser:");
    println!("  {}", device_login.verification_uri_complete);
    println!("Verification code: {}", device_login.user_code);
    println!("Only approve the browser prompt if it shows the same code.\n");
    println!("Waiting for approval on xmatrix.sh...");

    poll_device_login(hub_url, device_login).await
}

pub async fn poll_device_login(
    hub_url: &str,
    device_login: &DeviceLoginStartResponse,
) -> Result<AuthResponse> {
    let url = with_route(hub_url, HubRoutes::DEVICE_TOKEN);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(device_login.expires_in);
    let mut poll_interval = device_login.interval.max(1);

    loop {
        let response: DeviceLoginPollResponse = match crate::http::request_json(
            &url,
            "POST",
            None,
            Some(serde_json::json!({
                "deviceCode": device_login.device_code,
            })),
        )
        .await
        {
            Ok(response) => response,
            Err(err) => {
                if tokio::time::Instant::now() >= deadline {
                    return Err(CliError::Auth(format!("Browser login failed: {err}")));
                }
                eprintln!("Browser login poll failed: {err}. Retrying...");
                tokio::time::sleep(Duration::from_secs(poll_interval)).await;
                continue;
            }
        };

        match response.status.as_str() {
            "approved" => {
                let token = response.token.ok_or_else(|| {
                    CliError::Auth("Missing token in device login response".into())
                })?;
                let user = response.user.ok_or_else(|| {
                    CliError::Auth("Missing user in device login response".into())
                })?;

                return Ok(AuthResponse {
                    token,
                    refresh_token: response.refresh_token,
                    user,
                    hub_url: response.hub_url.unwrap_or_else(|| hub_url.to_string()),
                    relay_url: response
                        .relay_url
                        .unwrap_or_else(|| crate::human_connection::derive_connection_url(hub_url)),
                });
            }
            "pending" => {}
            "expired" => {
                return Err(CliError::Auth(response.error.unwrap_or_else(|| {
                    "Browser login expired. Run `xmatrix login` again.".into()
                })));
            }
            _ => {
                return Err(CliError::Auth(response.error.unwrap_or_else(|| {
                    format!("Unexpected browser login status '{}'", response.status)
                })));
            }
        }

        if let Some(next_interval) = response.interval {
            poll_interval = next_interval.max(1);
        }

        if tokio::time::Instant::now() >= deadline {
            return Err(CliError::Auth(
                "Browser login timed out. Run `xmatrix login` again.".into(),
            ));
        }

        tokio::time::sleep(Duration::from_secs(poll_interval)).await;
    }
}

async fn login_with_browser_loopback(hub_url: &str) -> Result<AuthResponse> {
    // Find an available port
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| CliError::Auth(format!("Failed to bind: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| CliError::Auth(format!("Failed to get addr: {e}")))?
        .port();
    drop(listener);

    let redirect_uri = format!("http://localhost:{port}/callback");
    let state = Uuid::new_v4().to_string();
    let login_url = resolve_browser_login_url(hub_url, &redirect_uri, &state).await;

    println!("Open this URL in any browser:");
    println!("  {login_url}\n");

    // Start HTTP server to receive callback
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}"))
        .await
        .map_err(|e| CliError::Auth(format!("Failed to listen: {e}")))?;

    let callback = loop {
        let (stream, _) = listener
            .accept()
            .await
            .map_err(|e| CliError::Auth(format!("Accept failed: {e}")))?;

        if let Some(payload) = handle_cli_callback(stream, &state).await? {
            break payload;
        }
    };

    // Verify token with hub
    let me: MeResponse = crate::http::request_json(
        &with_route(hub_url, HubRoutes::ME),
        "GET",
        Some(&callback.token),
        None,
    )
    .await
    .map_err(|e| CliError::Auth(format!("Token verification failed: {e}")))?;

    let relay_url = crate::human_connection::derive_connection_url(hub_url);

    let auth = AuthResponse {
        token: callback.token,
        refresh_token: callback.refresh_token,
        user: me.user,
        hub_url: hub_url.to_string(),
        relay_url,
    };

    // The browser shared its own refresh token with us. Exchange it for an
    // independent session so the browser's later auto-refresh won't invalidate
    // our copy.  Best-effort: fall back to the original tokens on failure.
    exchange_for_own_session(hub_url, auth).await
}

async fn resolve_browser_login_url(hub_url: &str, redirect_uri: &str, state: &str) -> String {
    let hub_login_url = format!(
        "{}?redirect_uri={}&state={}",
        with_route(hub_url, HubRoutes::LOGIN),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(state)
    );

    if hub_browser_login_available(&hub_login_url).await {
        return hub_login_url;
    }

    if let Some(web_login_url) = web_login_url(hub_url, redirect_uri, state) {
        return web_login_url;
    }

    hub_login_url
}

async fn hub_browser_login_available(login_url: &str) -> bool {
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(client) => client,
        Err(_) => return true,
    };

    match client.get(login_url).send().await {
        Ok(response) => response.status() != reqwest::StatusCode::NOT_FOUND,
        Err(_) => true,
    }
}

fn web_login_url(hub_url: &str, redirect_uri: &str, state: &str) -> Option<String> {
    let base_url = std::env::var("XMATRIX_WEB_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            if hub_url.trim_end_matches('/') == DEFAULT_HUB_URL {
                Some(DEFAULT_WEB_URL.to_string())
            } else {
                None
            }
        })?;

    Some(format!(
        "{base_url}/login?cli_callback={}&cli_state={}&cli_hub={}",
        urlencoding::encode(redirect_uri),
        urlencoding::encode(state),
        urlencoding::encode(hub_url),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliCallbackPayload {
    token: String,
    state: String,
    #[serde(default, alias = "refreshToken")]
    refresh_token: Option<String>,
}

async fn handle_cli_callback(
    stream: tokio::net::TcpStream,
    expected_state: &str,
) -> Result<Option<CliCallbackPayload>> {
    let mut buf = vec![0u8; 8192];
    stream.readable().await.ok();
    let n = stream
        .try_read(&mut buf)
        .map_err(|e| CliError::Auth(format!("Read failed: {e}")))?;
    let request = String::from_utf8_lossy(&buf[..n]).to_string();
    let method = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().next())
        .unwrap_or_default();

    match method {
        "OPTIONS" => {
            write_http_response(&stream, "204 No Content", "text/plain", "").await?;
            Ok(None)
        }
        "POST" => {
            let body = request
                .split("\r\n\r\n")
                .nth(1)
                .ok_or_else(|| CliError::Auth("Missing callback payload".into()))?;
            let payload: CliCallbackPayload = serde_json::from_str(body)
                .map_err(|e| CliError::Auth(format!("Invalid callback payload: {e}")))?;

            if payload.state != expected_state {
                return Err(reject_state_mismatch(&stream).await);
            }

            write_http_response(&stream, "200 OK", "text/html", success_html()).await?;
            Ok(Some(payload))
        }
        "GET" => {
            let token = extract_param(&request, "token")
                .ok_or_else(|| CliError::Auth("No token in callback".into()))?;
            let state = extract_param(&request, "state");
            if let Some(state) = state.as_deref()
                && state != expected_state
            {
                return Err(reject_state_mismatch(&stream).await);
            }

            write_http_response(&stream, "200 OK", "text/html", success_html()).await?;
            Ok(Some(CliCallbackPayload {
                token,
                state: state.unwrap_or_default(),
                refresh_token: extract_param(&request, "refresh_token"),
            }))
        }
        _ => {
            write_json_error(
                &stream,
                "405 Method Not Allowed",
                "Unsupported callback method",
            )
            .await?;
            Err(CliError::Auth("Unsupported callback method".into()))
        }
    }
}

fn success_html() -> &'static str {
    r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>xMatrix CLI Login</title>
  </head>
  <body>
    <h2>xMatrix CLI login successful</h2>
    <p>This localhost callback is expected for <code>xmatrix login</code>.</p>
    <p>You can close this tab and return to your terminal.</p>
    <script>window.close()</script>
  </body>
</html>"#
}

/// Answer a callback whose state does not match this login, and fail the login.
async fn reject_state_mismatch(stream: &tokio::net::TcpStream) -> CliError {
    const MISMATCH: &str = "CLI login state mismatch";
    if let Err(error) = write_json_error(stream, "401 Unauthorized", MISMATCH).await {
        return error;
    }
    CliError::Auth(MISMATCH.into())
}

async fn write_json_error(
    stream: &tokio::net::TcpStream,
    status: &str,
    message: &str,
) -> Result<()> {
    let body = serde_json::json!({ "error": message }).to_string();
    write_http_response(stream, status, "application/json", &body).await
}

async fn write_http_response(
    stream: &tokio::net::TcpStream,
    status: &str,
    content_type: &str,
    body: &str,
) -> Result<()> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.writable().await.ok();
    stream
        .try_write(response.as_bytes())
        .map_err(|e| CliError::Auth(format!("Write failed: {e}")))?;
    Ok(())
}

pub async fn exchange_instance_session(hub_url: &str, token: &str) -> Result<AuthResponse> {
    crate::http::request_json(
        &with_route(hub_url, HubRoutes::EXCHANGE_SESSION),
        "POST",
        Some(token),
        None,
    )
    .await
    .map_err(|e| CliError::Auth(format!("Session exchange failed: {e}")))
}

pub async fn refresh_cli_session(session: &CliSession) -> Result<CliSession> {
    let _lock = acquire_session_refresh_lock().await?;
    let session = newest_saved_session_for_refresh(session).await;
    let response = match refresh_auth_response(&session).await {
        Ok(response) => response,
        Err(err) if is_stale_refresh_token_error(&err) => {
            if let Some(saved) = crate::config::load_session_for_hub(&session.hub_url).await
                && saved_session_is_newer_for_same_account(&session, &saved)
                && saved.refresh_token != session.refresh_token
            {
                return Ok(saved);
            }
            if let Ok(recovered) = recover_cli_session_from_access_token(&session).await {
                return Ok(recovered);
            }
            return Err(CliError::Auth(format!("Session refresh failed: {err}")));
        }
        Err(err) => return Err(CliError::Auth(format!("Session refresh failed: {err}"))),
    };

    save_session(
        response.token,
        response.refresh_token,
        response.user,
        response.hub_url,
        response.relay_url,
        None,
    )
    .await
}

async fn recover_cli_session_from_access_token(session: &CliSession) -> Result<CliSession> {
    let response = exchange_instance_session(&session.hub_url, &session.token).await?;
    save_session(
        response.token,
        response.refresh_token,
        response.user,
        response.hub_url,
        response.relay_url,
        None,
    )
    .await
}

pub async fn refresh_session_in_memory(session: &CliSession) -> Result<CliSession> {
    let response = refresh_auth_response(session)
        .await
        .map_err(|err| CliError::Auth(format!("Session refresh failed: {err}")))?;

    Ok(CliSession {
        token: response.token,
        refresh_token: response.refresh_token,
        user: response.user,
        hub_url: response.hub_url,
        relay_url: response.relay_url,
        updated_at: unix_now_secs().to_string(),
        expires_at: crate::config::renewed_session_expires_at(),
    })
}

struct SessionRefreshLock {
    path: PathBuf,
}

impl Drop for SessionRefreshLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

async fn acquire_session_refresh_lock() -> Result<SessionRefreshLock> {
    let dir = crate::config::profile_state_dir();
    tokio::fs::create_dir_all(&dir).await?;
    let path = dir.join("session-refresh.lock");
    let deadline = tokio::time::Instant::now() + SESSION_REFRESH_LOCK_TIMEOUT;

    loop {
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
        {
            Ok(_) => return Ok(SessionRefreshLock { path }),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                if session_refresh_lock_is_stale(&path).await {
                    let _ = tokio::fs::remove_file(&path).await;
                    continue;
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(CliError::Auth(
                        "Timed out waiting for another xMatrix process to refresh the session"
                            .into(),
                    ));
                }
                tokio::time::sleep(SESSION_REFRESH_LOCK_RETRY_DELAY).await;
            }
            Err(err) => return Err(CliError::Io(err)),
        }
    }
}

async fn session_refresh_lock_is_stale(path: &PathBuf) -> bool {
    tokio::fs::metadata(path)
        .await
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .map(|age| age.as_secs() >= SESSION_REFRESH_LOCK_STALE_SECS)
        .unwrap_or(false)
}

async fn refresh_auth_response(session: &CliSession) -> Result<AuthResponse> {
    let refresh_token = session.refresh_token.as_deref().ok_or_else(|| {
        CliError::Auth("Saved session cannot be refreshed. Run: xmatrix login".into())
    })?;

    crate::http::request_json(
        &with_route(&session.hub_url, HubRoutes::REFRESH),
        "POST",
        None,
        Some(serde_json::json!({ "refreshToken": refresh_token })),
    )
    .await
}

async fn newest_saved_session_for_refresh(session: &CliSession) -> CliSession {
    let Some(saved) = crate::config::load_session_for_hub(&session.hub_url).await else {
        return session.clone();
    };
    if saved_session_is_newer_for_same_account(session, &saved)
        && saved.refresh_token != session.refresh_token
    {
        return saved;
    }
    session.clone()
}

fn saved_session_is_newer_for_same_account(previous: &CliSession, saved: &CliSession) -> bool {
    previous.hub_url == saved.hub_url
        && previous.user.id == saved.user.id
        && saved.updated_at.parse::<u64>().unwrap_or(0)
            >= previous.updated_at.parse::<u64>().unwrap_or(0)
}

fn is_stale_refresh_token_error(err: &CliError) -> bool {
    let message = err.to_string().to_ascii_lowercase();
    message.contains("invalid refresh token")
        || message.contains("already used")
        || message.contains("refresh token")
}

fn extract_param(request: &str, param: &str) -> Option<String> {
    let first_line = request.lines().next()?;
    let path = first_line.split_whitespace().nth(1)?;
    let query = path.split('?').nth(1)?;
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        if let (Some(k), Some(v)) = (kv.next(), kv.next())
            && k == param
        {
            return Some(urlencoding::decode(v).unwrap_or_default().into_owned());
        }
    }
    None
}

/// Exchange a browser-provided access token for an independent CLI session.
/// This must not consume the browser refresh token, or another client can be
/// logged out by approving a CLI login.
async fn exchange_for_own_session(hub_url: &str, auth: AuthResponse) -> Result<AuthResponse> {
    match exchange_instance_session(hub_url, &auth.token).await {
        Ok(session) => Ok(session),
        Err(_) => Ok(auth),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_callback_payload_accepts_camel_case_refresh_token() {
        let payload: CliCallbackPayload =
            serde_json::from_str(r#"{"token":"access","refreshToken":"refresh","state":"state"}"#)
                .expect("callback payload should parse");

        assert_eq!(payload.refresh_token.as_deref(), Some("refresh"));
    }
}
