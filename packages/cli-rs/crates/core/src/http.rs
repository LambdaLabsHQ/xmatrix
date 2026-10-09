use std::sync::OnceLock;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};

/// The MIME type without optional Content-Type parameters; keeps the server's case.
pub fn response_mime_type(response: &reqwest::Response) -> Option<&str> {
    response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}
use serde::de::DeserializeOwned;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use crate::error::{CliError, HttpStatusError, Result};

pub const CLIENT_COMPATIBILITY_PROTOCOL_VERSION: u32 = 2;
pub const CLIENT_UPGRADE_REQUIRED_CLOSE_CODE: u16 = 4003;
pub const CLIENT_COMPONENT_HEADER: &str = "x-xmatrix-client-component";
pub const CLIENT_VERSION_HEADER: &str = "x-xmatrix-client-version";
pub const CLIENT_PROTOCOL_HEADER: &str = "x-xmatrix-client-protocol";
pub const CLIENT_PLATFORM_HEADER: &str = "x-xmatrix-client-platform";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientComponent {
    Cli,
    Daemon,
}

static PROCESS_COMPONENT: AtomicU8 = AtomicU8::new(0);

impl ClientComponent {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::Daemon => "daemon",
        }
    }
}

pub fn mark_process_as_daemon() {
    PROCESS_COMPONENT.store(1, Ordering::Release);
}

pub fn process_client_component() -> ClientComponent {
    if PROCESS_COMPONENT.load(Ordering::Acquire) == 1 {
        ClientComponent::Daemon
    } else {
        ClientComponent::Cli
    }
}

pub fn client_identity_headers(component: ClientComponent) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static(CLIENT_COMPONENT_HEADER),
        HeaderValue::from_static(component.as_str()),
    );
    headers.insert(
        HeaderName::from_static(CLIENT_VERSION_HEADER),
        HeaderValue::from_static(crate::version::current()),
    );
    headers.insert(
        HeaderName::from_static(CLIENT_PROTOCOL_HEADER),
        HeaderValue::from_str(&CLIENT_COMPATIBILITY_PROTOCOL_VERSION.to_string())
            .expect("numeric protocol version is a valid header value"),
    );
    headers.insert(
        HeaderName::from_static(CLIENT_PLATFORM_HEADER),
        HeaderValue::from_static(std::env::consts::OS),
    );
    headers
}

/// Well inside the edge's own idle close, so a request is never written onto a
/// socket the peer has already dropped — the shape that surfaces as
/// `peer closed connection without sending TLS close_notify`.
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(15);
const TCP_KEEPALIVE: Duration = Duration::from_secs(30);
/// Bounds only reaching the Hub. There is deliberately no whole-request
/// timeout: long polls and streamed bodies outlive any fixed budget.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

static CLI_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static DAEMON_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub fn client() -> Result<reqwest::Client> {
    client_for(process_client_component())
}

/// One pooled client per component, built once per process.
///
/// A `reqwest::Client` owns its connection pool, so building one per request —
/// which this did — means every call pays a fresh TLS handshake and no
/// connection is ever reused. At the daemon's steady request rate that is a
/// handshake storm against the Hub, and each handshake the edge drops
/// (`tls handshake eof`) took down the daemon's whole session and forced a
/// credential re-enrollment. Cloning is cheap: the client is internally shared.
pub fn client_for(component: ClientComponent) -> Result<reqwest::Client> {
    let cell = match component {
        ClientComponent::Cli => &CLI_CLIENT,
        ClientComponent::Daemon => &DAEMON_CLIENT,
    };
    if let Some(client) = cell.get() {
        return Ok(client.clone());
    }
    // Build outside `get_or_init` so a builder failure stays an error rather
    // than a panic; a lost race just drops the extra client.
    let built = reqwest::Client::builder()
        .default_headers(client_identity_headers(component))
        .redirect(reqwest::redirect::Policy::none())
        .pool_idle_timeout(POOL_IDLE_TIMEOUT)
        .tcp_keepalive(TCP_KEEPALIVE)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()?;
    Ok(cell.get_or_init(|| built).clone())
}

/// Sends a request, replaying it only where a replay cannot duplicate an effect.
///
/// - A connect-phase failure — including a TLS handshake the peer drops — means
///   the request never reached the Hub, so it is replayed once even for a POST.
///   That single retry keeps one dropped handshake from being reported as a
///   dead Hub session: the daemon used to tear down its connection and
///   re-enroll, and in every such window the Hub queues agent launches.
/// - Over its allowance (429) the Hub says how long to wait. Waiting once is the
///   backoff a command loop needs; a second refusal is reported, not chased.
/// - A transient failure (502/503/504) is replayed up to
///   [`TRANSIENT_ATTEMPTS`] sends in all, honouring `Retry-After`, when the Hub
///   said `retryable: true` — it says so only where a replay is safe — or, for
///   a GET or HEAD, when the reply carries `Retry-After` and no verdict.
async fn send_with_retry(request: reqwest::RequestBuilder) -> Result<reqwest::Response> {
    let (client, request) = request.build_split();
    let mut request = request?;
    let safe_method = matches!(
        *request.method(),
        reqwest::Method::GET | reqwest::Method::HEAD
    );
    let mut connect_retried = false;
    let mut rate_limit_waited = false;
    let mut sends = 1;
    loop {
        // A streaming body cannot be replayed; such a request is sent once.
        let replay = request.try_clone();
        let response = match client.execute(request).await {
            Err(error) if error.is_connect() && !connect_retried => match replay {
                Some(replay) => {
                    connect_retried = true;
                    request = replay;
                    continue;
                }
                None => return Err(error.into()),
            },
            result => result?,
        };
        let Some(replay) = replay else {
            return Ok(response);
        };
        if !rate_limit_waited && let Some(wait) = rate_limit_wait(&response) {
            rate_limit_waited = true;
            tokio::time::sleep(wait).await;
            request = replay;
            continue;
        }
        if sends >= TRANSIENT_ATTEMPTS || !transient_status(response.status().as_u16()) {
            return Ok(response);
        }
        let (response, body) = buffered(response).await?;
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok());
        match transient_retry_wait(
            response.status().as_u16(),
            retry_after,
            &body,
            safe_method,
            sends,
        ) {
            Some(wait) => {
                tokio::time::sleep(crate::backoff::jitter_above(wait, MAX_TRANSIENT_WAIT)).await;
                sends += 1;
                request = replay;
            }
            None => return Ok(response),
        }
    }
}

/// Sends in all, the first included, for a request the Hub calls transient.
const TRANSIENT_ATTEMPTS: u32 = 3;
/// The longest a single transient replay waits, whatever `Retry-After` asks.
const MAX_TRANSIENT_WAIT: Duration = Duration::from_secs(30);
/// The wait before the first replay when the Hub names none; it doubles.
const DEFAULT_TRANSIENT_WAIT: Duration = Duration::from_secs(1);

/// Statuses the Hub, or the edge in front of it, answers a passing outage with.
fn transient_status(status: u16) -> bool {
    matches!(status, 502..=504)
}

/// How long to wait before replaying a transient failure; `None` when the
/// reply must be reported. `sends` counts the sends already made.
fn transient_retry_wait(
    status: u16,
    retry_after: Option<&str>,
    body: &[u8],
    safe_method: bool,
    sends: u32,
) -> Option<Duration> {
    if sends >= TRANSIENT_ATTEMPTS || !transient_status(status) {
        return None;
    }
    let verdict = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("retryable").and_then(serde_json::Value::as_bool));
    let retry_after = retry_after.and_then(parse_retry_after);
    let replay = match verdict {
        Some(retryable) => retryable,
        None => safe_method && retry_after.is_some(),
    };
    replay.then(|| {
        retry_after
            .unwrap_or_else(|| DEFAULT_TRANSIENT_WAIT.saturating_mul(1u32 << (sends - 1).min(4)))
            .min(MAX_TRANSIENT_WAIT)
    })
}

/// `Retry-After` in delta-seconds, the form the Hub sends.
fn parse_retry_after(value: &str) -> Option<Duration> {
    value.trim().parse::<u64>().ok().map(Duration::from_secs)
}

/// Reads a reply's body so it can be inspected, returning an equivalent reply
/// for the caller to report.
async fn buffered(response: reqwest::Response) -> Result<(reqwest::Response, Vec<u8>)> {
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.bytes().await?.to_vec();
    let mut rebuilt = tokio_tungstenite::tungstenite::http::Response::builder().status(status);
    if let Some(slot) = rebuilt.headers_mut() {
        *slot = headers;
    }
    let rebuilt = rebuilt
        .body(body.clone())
        .map_err(|error| CliError::Http(format!("Invalid Hub reply: {error}")))?;
    Ok((reqwest::Response::from(rebuilt), body))
}

/// The longest a single request waits out a rate limit before retrying.
const MAX_RATE_LIMIT_WAIT: Duration = Duration::from_secs(60);

/// How long a 429 asks the caller to wait, bounded; `None` for any other reply.
fn rate_limit_wait(response: &reqwest::Response) -> Option<Duration> {
    if response.status() != reqwest::StatusCode::TOO_MANY_REQUESTS {
        return None;
    }
    let wait = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_retry_after);
    Some(wait.map_or(MAX_RATE_LIMIT_WAIT, |wait| wait.min(MAX_RATE_LIMIT_WAIT)))
}

pub fn with_access_header(
    request: reqwest::RequestBuilder,
    url: &str,
) -> Result<reqwest::RequestBuilder> {
    Ok(match crate::access::cached_token_for_url(url)? {
        Some(token) => request.header(crate::access::ACCESS_TOKEN_HEADER, token),
        None => request,
    })
}

pub async fn websocket_request(
    url: &str,
    component: ClientComponent,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>> {
    crate::access::refresh_for_url(url).await?;
    let mut request = url.into_client_request()?;
    let headers = request.headers_mut();
    headers.insert(
        CLIENT_COMPONENT_HEADER,
        component.as_str().parse().map_err(|error| {
            CliError::Relay(format!("Invalid client component header: {error}"))
        })?,
    );
    headers.insert(
        CLIENT_VERSION_HEADER,
        crate::version::current()
            .parse()
            .map_err(|error| CliError::Relay(format!("Invalid client version header: {error}")))?,
    );
    headers.insert(
        CLIENT_PROTOCOL_HEADER,
        CLIENT_COMPATIBILITY_PROTOCOL_VERSION
            .to_string()
            .parse()
            .map_err(|error| CliError::Relay(format!("Invalid client protocol header: {error}")))?,
    );
    headers.insert(
        CLIENT_PLATFORM_HEADER,
        std::env::consts::OS
            .parse()
            .map_err(|error| CliError::Relay(format!("Invalid client platform header: {error}")))?,
    );
    if let Some(token) = crate::access::cached_token_for_url(url)? {
        headers.insert(
            crate::access::ACCESS_TOKEN_HEADER,
            token.parse().map_err(|_| {
                CliError::Auth("Cloudflare Access returned an invalid header value".into())
            })?,
        );
    }
    Ok(request)
}

pub fn websocket_connect_error(
    url: &str,
    context: &str,
    error: tokio_tungstenite::tungstenite::Error,
) -> CliError {
    if let tokio_tungstenite::tungstenite::Error::Http(response) = &error
        && response.status() == tokio_tungstenite::tungstenite::http::StatusCode::UPGRADE_REQUIRED
    {
        let message = response
            .body()
            .as_deref()
            .and_then(|body| serde_json::from_slice::<serde_json::Value>(body).ok())
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| {
                "This xMatrix client is no longer compatible. Run `xmatrix update` before reconnecting."
                    .to_string()
            });
        return CliError::UpgradeRequired(message);
    }
    if let tokio_tungstenite::tungstenite::Error::Http(response) = &error
        && crate::access::requires_access(url)
        && matches!(
            response.status().as_u16(),
            301 | 302 | 303 | 307 | 308 | 401 | 403
        )
    {
        return CliError::Auth(crate::access::access_denial_message(
            response.status().as_u16(),
        ));
    }
    // A handshake the Hub answered with a client error is its refusal; any
    // other failure — no route, a dropped TLS handshake, a 5xx from a
    // restarting Hub — is an outage a redial can get past.
    let refused = matches!(&error, tokio_tungstenite::tungstenite::Error::Http(response)
        if response.status().is_client_error()
            && !matches!(response.status().as_u16(), 408 | 429));
    let reason = format!("{context}: {error}");
    if refused {
        CliError::Relay(reason)
    } else {
        CliError::RelayTransient(reason)
    }
}

pub fn is_upgrade_required_close(
    frame: Option<&tokio_tungstenite::tungstenite::protocol::CloseFrame>,
) -> bool {
    frame.is_some_and(|frame| u16::from(frame.code) == CLIENT_UPGRADE_REQUIRED_CLOSE_CODE)
}

/// Send one broker request over the daemon's Unix socket.
///
/// `Ok(None)` means there is no socket to use and the caller should fall back to
/// TCP. A socket that exists but refuses is reported before falling back: a
/// transport that silently disappears is how a broken daemon looks healthy.
#[cfg(unix)]
async fn request_daemon_json_over_socket(
    path: &str,
    capability: &str,
    body: &serde_json::Value,
) -> std::result::Result<Option<serde_json::Value>, DaemonBrokerRequestError> {
    if crate::config::agent_cli_hub().is_some() {
        return Ok(None);
    }
    let record = match crate::daemon_record::read_record_for_active_profile() {
        Ok(record) => match record {
            Some(record) => record,
            None => return Ok(None),
        },
        Err(error) => {
            eprintln!("⚠ daemon record unusable, using the TCP Hub broker: {error}");
            return Ok(None);
        }
    };
    let Some(socket) = record.request_broker_socket else {
        return Ok(None);
    };
    let stream = match tokio::net::UnixStream::connect(&socket).await {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!("⚠ daemon request socket {socket} unavailable, using TCP: {error}");
            return Ok(None);
        }
    };
    daemon_json_over_stream(stream, path, capability, body)
        .await
        .map(Some)
}

/// Whether the daemon on the other end serves this route at all.
///
/// A daemon built before a route answers it through its fallback arm, which
/// wrote `200 OK` with `{"error":"not found"}`; one built after answers `404`.
/// Both mean "this daemon is too old for what you asked", and only the second
/// used to be recognised, so the upgrade hint never reached anyone.
fn daemon_route_is_unserved(status: u16, error: Option<&str>) -> bool {
    status == 404 || error == Some("not found")
}

/// The request/response half, over whichever stream the caller connected.
#[cfg(unix)]
async fn daemon_json_over_stream<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    mut stream: S,
    path: &str,
    capability: &str,
    body: &serde_json::Value,
) -> std::result::Result<serde_json::Value, DaemonBrokerRequestError> {
    use tokio::io::AsyncWriteExt as _;
    let encoded = serde_json::to_vec(body).map_err(|err| {
        DaemonBrokerRequestError::Other(CliError::Auth(format!(
            "Invalid local daemon Hub request: {err}"
        )))
    })?;
    let mut request = format!(
        "POST {path} HTTP/1.1\r\nhost: localhost\r\nx-xmatrix-request-capability: {capability}\r\n\
         content-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        encoded.len(),
    )
    .into_bytes();
    request.extend_from_slice(&encoded);
    stream.write_all(&request).await.map_err(|err| {
        DaemonBrokerRequestError::Other(CliError::Auth(format!(
            "Local daemon Hub request failed: {err}"
        )))
    })?;
    stream.flush().await.map_err(|err| {
        DaemonBrokerRequestError::Other(CliError::Auth(format!(
            "Local daemon Hub request failed: {err}"
        )))
    })?;

    let (status, response) = crate::local_http_response::read_local_http_response(&mut stream)
        .await
        .map_err(DaemonBrokerRequestError::Other)?;
    #[derive(serde::Deserialize)]
    struct BrokerResponse {
        #[serde(default)]
        value: Option<serde_json::Value>,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        reason: Option<String>,
    }
    let payload: BrokerResponse = serde_json::from_slice(&response).map_err(|err| {
        DaemonBrokerRequestError::Other(CliError::Auth(format!(
            "Invalid local daemon Hub broker response: {err}"
        )))
    })?;
    if path == "/request/send-recovery"
        && daemon_route_is_unserved(status, payload.error.as_deref())
    {
        return Err(DaemonBrokerRequestError::Other(CliError::UpgradeRequired(
            "This daemon does not support send recovery".into(),
        )));
    }
    if status == 401 {
        return Err(DaemonBrokerRequestError::Unauthorized {
            message: payload.error.unwrap_or_else(|| {
                format!("Local daemon Hub broker rejected the request ({status})")
            }),
            reason: payload.reason,
        });
    }
    if !(200..300).contains(&status) || payload.error.is_some() {
        return Err(DaemonBrokerRequestError::Other(CliError::Http(
            payload.error.unwrap_or_else(|| {
                format!("Local daemon Hub broker rejected the request ({status})")
            }),
        )));
    }
    Ok(payload.value.unwrap_or(serde_json::Value::Null))
}

pub async fn request_json<T: DeserializeOwned>(
    url: &str,
    method: &str,
    token: Option<&str>,
    body: Option<serde_json::Value>,
) -> Result<T> {
    if crate::access::requires_access(url)
        && let Some((broker_url, capability)) = crate::access::daemon_request_broker()
    {
        return request_json_via_daemon(&broker_url, &capability, url, method, token, body, false)
            .await;
    }
    match request_json_direct(url, method, token, body).await? {
        JsonReply::Accepted(value) => Ok(value),
        JsonReply::Refused { error, .. } => Err(error),
    }
}

/// A direct Hub reply that keeps the HTTP status of a refusal, for callers that
/// must tell a definitive client error from a server error or lost response.
pub enum JsonReply<T> {
    Accepted(T),
    Refused { status: u16, error: CliError },
}

impl<T> JsonReply<T> {
    /// A 4xx other than timeout/rate limit: the Hub decided, nothing is pending.
    pub fn is_definitive_refusal(&self) -> bool {
        matches!(self, Self::Refused { status, .. }
            if (400..500).contains(status) && *status != 408 && *status != 429)
    }
}

/// Like [`request_json`] without the daemon request broker hop, which the
/// daemon itself never takes, returning refusals with their status.
pub async fn request_json_direct<T: DeserializeOwned>(
    url: &str,
    method: &str,
    token: Option<&str>,
    body: Option<serde_json::Value>,
) -> Result<JsonReply<T>> {
    let client = client()?;

    let mut req = match method {
        "POST" => client.post(url),
        "PUT" => client.put(url),
        "PATCH" => client.patch(url),
        "DELETE" => client.delete(url),
        _ => client.get(url),
    };

    req = req.header(CONTENT_TYPE, "application/json");

    req = with_access_header(req, url)?;

    if let Some(t) = token {
        req = req.header(AUTHORIZATION, format!("Bearer {t}"));
    }

    if let Some(b) = body {
        req = req.json(&b);
    }

    let response = send_with_retry(req).await?;
    let status = response.status();

    if status.is_redirection() || status.is_client_error() || status.is_server_error() {
        let error = response_rejection_error(response, url).await?;
        return Ok(JsonReply::Refused {
            status: status.as_u16(),
            error,
        });
    }

    let payload = response.json::<T>().await?;
    Ok(JsonReply::Accepted(payload))
}

/// Explicit Agent sends use the daemon's private recovery journal when present.
/// Older daemons ignore the optional flag and retain their existing behavior.
pub async fn request_journaled_message<T: DeserializeOwned>(
    url: &str,
    token: &str,
    body: serde_json::Value,
    agent_send: bool,
) -> Result<T> {
    if agent_send && let Some((broker_url, capability)) = crate::access::daemon_request_broker() {
        match request_json_via_daemon(
            &broker_url,
            &capability,
            url,
            "POST",
            Some(token),
            Some(body.clone()),
            true,
        )
        .await
        {
            Ok(value) => return Ok(value),
            Err(err) if agent_send_may_use_run_token(&err) => {
                // The Run token is already this Agent's Hub credential. A
                // request-broker 401 (stale locator, hashed-key mismatch, or
                // an unrelated process on the spawn-time port) must not block
                // the send or fall through to the launching human.
            }
            Err(err) => return Err(err),
        }
    }
    request_json(url, "POST", Some(token), Some(body)).await
}

fn agent_send_may_use_run_token(err: &CliError) -> bool {
    match err.http_message().or(match err {
        CliError::Auth(message) => Some(message.as_str()),
        _ => None,
    }) {
        Some(message) => {
            let message = message.to_ascii_lowercase();
            message.contains("unauthorized")
                || message.contains("capability not granted")
                || message.contains("capability_not_granted")
        }
        _ => false,
    }
}

async fn request_json_via_daemon<T: DeserializeOwned>(
    broker_url: &str,
    capability: &str,
    url: &str,
    method: &str,
    token: Option<&str>,
    body: Option<serde_json::Value>,
    journal_send: bool,
) -> Result<T> {
    request_daemon_json(
        broker_url,
        capability,
        "/request/hub-json",
        serde_json::json!({
            "url": url, "method": method, "token": token, "body": body, "journalSend": journal_send,
        }),
    )
    .await
}

pub async fn recover_message_send<T: DeserializeOwned>(
    hub_url: &str,
    channel_id: &str,
    message_id: &str,
) -> Result<T> {
    let (broker_url, capability) = crate::access::daemon_request_broker().ok_or_else(|| {
        CliError::Auth("Send recovery requires the original Agent's daemon Run capability".into())
    })?;
    request_daemon_json(
        &broker_url,
        &capability,
        "/request/send-recovery",
        serde_json::json!({
            "hubUrl": hub_url, "channelId": channel_id, "messageId": message_id,
        }),
    )
    .await
}

async fn request_daemon_json<T: DeserializeOwned>(
    broker_url: &str,
    capability: &str,
    path: &str,
    body: serde_json::Value,
) -> Result<T> {
    match request_daemon_json_once(broker_url, capability, path, body.clone()).await {
        Ok(value) => Ok(value),
        Err(first_error) if first_error.should_rediscover_capability() => {
            match crate::access::rediscovered_daemon_request_capability(capability) {
                crate::access::DaemonRequestCapabilityRediscovery::Replacement {
                    url,
                    capability: rediscovered_capability,
                } => match request_daemon_json_once(&url, &rediscovered_capability, path, body)
                    .await
                {
                    Ok(value) => Ok(value),
                    Err(second_error) => Err(annotate_refused_after_rediscovery(second_error)),
                },
                crate::access::DaemonRequestCapabilityRediscovery::Ambiguous { distinct_count } => {
                    Err(annotate_ambiguous_rediscovery(
                        first_error.into_cli_error(),
                        distinct_count,
                    ))
                }
                crate::access::DaemonRequestCapabilityRediscovery::Unreadable { detail } => Err(
                    annotate_unreadable_rediscovery(first_error.into_cli_error(), detail),
                ),
                crate::access::DaemonRequestCapabilityRediscovery::None => {
                    Err(annotate_no_replacement_found(first_error.into_cli_error()))
                }
            }
        }
        Err(err) => Err(err.into_cli_error()),
    }
}

#[derive(Debug)]
enum DaemonBrokerRequestError {
    /// HTTP 401 from the request broker. `reason` is machine-readable when the
    /// daemon is new enough (`capability_not_granted` / `capability_malformed`);
    /// older daemons leave it empty. Unauthorized has always been a real 401
    /// early-return — including on 0.16.279 — so status alone is enough.
    Unauthorized {
        message: String,
        reason: Option<String>,
    },
    Other(CliError),
}

impl DaemonBrokerRequestError {
    fn should_rediscover_capability(&self) -> bool {
        match self {
            // Only opt out when the daemon explicitly said the caller presented
            // junk. Missing reason (old daemon) and future unknown reasons retry
            // — otherwise a newer daemon's new reason would leave an older
            // client unable to rediscover.
            Self::Unauthorized { reason, .. } => reason.as_deref() != Some("capability_malformed"),
            Self::Other(_) => false,
        }
    }

    fn into_cli_error(self) -> CliError {
        match self {
            Self::Unauthorized { message, .. } => CliError::Http(message),
            Self::Other(error) => error,
        }
    }
}

fn annotate_no_replacement_found(error: CliError) -> CliError {
    match error {
        CliError::Http(message) => CliError::Http(format!(
            "{message}: registry rediscovery found no replacement verifier key for this Run"
        )),
        CliError::Auth(message) => CliError::Auth(format!(
            "{message}: registry rediscovery found no replacement verifier key for this Run"
        )),
        other => other,
    }
}

fn annotate_ambiguous_rediscovery(error: CliError, distinct_count: usize) -> CliError {
    match error {
        CliError::Http(message) => CliError::Http(format!(
            "{message}: registry rediscovery found {distinct_count} distinct verifier keys for this Run and declined to choose"
        )),
        CliError::Auth(message) => CliError::Auth(format!(
            "{message}: registry rediscovery found {distinct_count} distinct verifier keys for this Run and declined to choose"
        )),
        other => other,
    }
}

fn annotate_unreadable_rediscovery(error: CliError, detail: String) -> CliError {
    match error {
        CliError::Http(message) => CliError::Http(format!(
            "{message}: registry rediscovery could not read persisted Run state ({detail})"
        )),
        CliError::Auth(message) => CliError::Auth(format!(
            "{message}: registry rediscovery could not read persisted Run state ({detail})"
        )),
        other => other,
    }
}

fn annotate_refused_after_rediscovery(error: DaemonBrokerRequestError) -> CliError {
    let error = error.into_cli_error();
    match error {
        CliError::Http(message) => CliError::Http(format!(
            "{message}: registry rediscovery found a replacement verifier key but this daemon still refused it"
        )),
        CliError::Auth(message) => CliError::Auth(format!(
            "{message}: registry rediscovery found a replacement verifier key but this daemon still refused it"
        )),
        other => other,
    }
}

async fn request_daemon_json_once<T: DeserializeOwned>(
    broker_url: &str,
    capability: &str,
    path: &str,
    body: serde_json::Value,
) -> std::result::Result<T, DaemonBrokerRequestError> {
    #[derive(serde::Deserialize)]
    struct BrokerResponse {
        #[serde(default)]
        value: Option<serde_json::Value>,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        reason: Option<String>,
    }

    // Prefer the daemon's Unix socket when it recorded one. `reqwest` speaks
    // only TCP, so the socket path writes the request itself — the same shape
    // the auth broker client already uses — rather than adding a second HTTP
    // client dependency for one transport.
    #[cfg(unix)]
    if let Some(value) = request_daemon_json_over_socket(path, capability, &body).await? {
        return serde_json::from_value::<T>(value).map_err(|err| {
            DaemonBrokerRequestError::Other(CliError::Auth(format!(
                "Invalid local daemon Hub broker response: {err}"
            )))
        });
    }

    let request = reqwest::Client::new()
        .post(format!("{broker_url}{path}"))
        .header("x-xmatrix-request-capability", capability)
        .json(&body);
    let request = if path == "/request/send-recovery" {
        request.timeout(std::time::Duration::from_secs(75))
    } else {
        request
    };
    let response = request.send().await.map_err(|err| {
        DaemonBrokerRequestError::Other(CliError::Auth(format!(
            "Local daemon Hub broker unavailable: {err}"
        )))
    })?;
    let status = response.status();
    let payload: BrokerResponse = response.json().await.map_err(|err| {
        DaemonBrokerRequestError::Other(CliError::Auth(format!(
            "Invalid local daemon Hub broker response: {err}"
        )))
    })?;
    if path == "/request/send-recovery"
        && daemon_route_is_unserved(status.as_u16(), payload.error.as_deref())
    {
        return Err(DaemonBrokerRequestError::Other(CliError::UpgradeRequired(
            "This daemon does not support send recovery".into(),
        )));
    }
    if status.as_u16() == 401 {
        return Err(DaemonBrokerRequestError::Unauthorized {
            message: payload
                .error
                .unwrap_or_else(|| format!("Local daemon Hub broker failed with {status}")),
            reason: payload.reason,
        });
    }
    if !status.is_success() || payload.error.is_some() {
        return Err(DaemonBrokerRequestError::Other(CliError::Http(
            payload
                .error
                .unwrap_or_else(|| format!("Local daemon Hub broker failed with {status}")),
        )));
    }
    serde_json::from_value(payload.value.ok_or_else(|| {
        DaemonBrokerRequestError::Other(CliError::Http(
            "Local daemon Hub broker returned no value".into(),
        ))
    })?)
    .map_err(|err| DaemonBrokerRequestError::Other(CliError::Json(err)))
}

pub async fn put_bytes<T: DeserializeOwned>(
    url: &str,
    token: &str,
    content_type: &str,
    checksum_sha256: &str,
    body: Vec<u8>,
) -> Result<T> {
    if crate::access::requires_access(url)
        && let Some((broker_url, capability)) = crate::access::daemon_request_broker()
    {
        return put_bytes_via_daemon(
            &broker_url,
            &capability,
            url,
            token,
            content_type,
            checksum_sha256,
            body,
        )
        .await;
    }
    let mut request = client()?
        .put(url)
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .header(CONTENT_TYPE, content_type)
        .header("x-xmatrix-content-sha256", checksum_sha256)
        .body(body);
    request = with_access_header(request, url)?;
    let response = send_with_retry(request).await?;
    let status = response.status();
    if status.is_redirection() || status.is_client_error() || status.is_server_error() {
        let error = response_rejection_error(response, url).await?;
        return Err(error);
    }
    Ok(response.json::<T>().await?)
}

async fn put_bytes_via_daemon<T: DeserializeOwned>(
    broker_url: &str,
    capability: &str,
    url: &str,
    token: &str,
    content_type: &str,
    checksum_sha256: &str,
    body: Vec<u8>,
) -> Result<T> {
    #[derive(serde::Deserialize)]
    struct BrokerResponse {
        #[serde(default)]
        value: Option<serde_json::Value>,
        #[serde(default)]
        error: Option<String>,
    }

    let response = reqwest::Client::new()
        .post(format!(
            "{broker_url}/request/hub-bytes?url={}",
            urlencoding::encode(url)
        ))
        .header("x-xmatrix-request-capability", capability)
        .header("x-xmatrix-hub-token", token)
        .header("x-xmatrix-content-type", content_type)
        .header("x-xmatrix-content-sha256", checksum_sha256)
        .body(body)
        .send()
        .await
        .map_err(|err| CliError::Auth(format!("Local daemon Hub broker unavailable: {err}")))?;
    let status = response.status();
    let payload: BrokerResponse = response.json().await.map_err(|err| {
        CliError::Auth(format!("Invalid local daemon Hub broker response: {err}"))
    })?;
    if !status.is_success() || payload.error.is_some() {
        return Err(CliError::Http(payload.error.unwrap_or_else(|| {
            format!("Local daemon Hub broker failed with {status}")
        })));
    }
    serde_json::from_value(
        payload
            .value
            .ok_or_else(|| CliError::Http("Local daemon Hub broker returned no value".into()))?,
    )
    .map_err(CliError::Json)
}

/// Accept only a successful status before callers consume a media body.
pub async fn require_success(response: reqwest::Response, url: &str) -> Result<reqwest::Response> {
    let status = response.status();
    if !status.is_success() {
        if let Some(error) = access_status_error(url, status) {
            return Err(error);
        }
        let text = response.text().await.unwrap_or_default();
        return Err(response_status_error(status, &text));
    }
    Ok(response)
}

/// JSON endpoints read the refusal body before applying access-denial policy.
async fn response_rejection_error(response: reqwest::Response, url: &str) -> Result<CliError> {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if let Some(error) = access_status_error(url, status) {
        return Err(error);
    }
    Ok(response_status_error(status, &text))
}

pub fn access_status_error(url: &str, status: reqwest::StatusCode) -> Option<CliError> {
    (crate::access::requires_access(url)
        && matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308 | 401 | 403))
    .then(|| CliError::Auth(crate::access::access_denial_message(status.as_u16())))
}

pub fn response_status_error(status: reqwest::StatusCode, body: &str) -> CliError {
    let response = serde_json::from_str::<serde_json::Value>(body).ok();
    let detail = response
        .as_ref()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| error.as_str().map(str::to_string))
        })
        .unwrap_or_else(|| format!("Request failed with status {status}"));
    let detail = match response
        .as_ref()
        .and_then(|value| channel_catalog_timeout_boundary(status, value))
    {
        Some(boundary) => format!("{detail} (boundary: {boundary})"),
        None => detail,
    };
    if status == reqwest::StatusCode::UPGRADE_REQUIRED {
        return CliError::UpgradeRequired(detail);
    }
    let field = |name: &str| response.as_ref().and_then(|value| value.get(name));
    CliError::HttpStatus(Box::new(HttpStatusError {
        status: status.as_u16(),
        code: field("code")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        // The Hub marks only an outage or a rate limit retryable; the flag on
        // any other status is not a verdict this client acts on.
        retryable: (transient_status(status.as_u16())
            || status == reqwest::StatusCode::TOO_MANY_REQUESTS)
            && field("retryable").and_then(serde_json::Value::as_bool) == Some(true),
        message: detail,
    }))
}

fn channel_catalog_timeout_boundary(
    status: reqwest::StatusCode,
    response: &serde_json::Value,
) -> Option<&str> {
    if status != reqwest::StatusCode::SERVICE_UNAVAILABLE
        || response.get("code").and_then(serde_json::Value::as_str)
            != Some("channel_catalog_timeout")
    {
        return None;
    }
    let boundary = response.get("boundary")?.as_str()?;
    matches!(
        boundary,
        "directory" | "authority_page" | "revision_probe" | "projection" | "runtime_presence"
    )
    .then_some(boundary)
}

/// Normalize a Hub origin while preserving each caller's CLI diagnostics.
pub fn normalize_hub_origin(value: &str, parse_error: &str, origin_error: &str) -> Result<String> {
    let parsed =
        reqwest::Url::parse(value.trim()).map_err(|_| CliError::Auth(parse_error.to_string()))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !matches!(parsed.path(), "" | "/")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(CliError::Auth(origin_error.to_string()));
    }
    Ok(parsed.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_send_keeps_the_run_token_when_the_request_broker_rejects() {
        assert!(agent_send_may_use_run_token(&CliError::Http(
            "unauthorized".into()
        )));
        assert!(agent_send_may_use_run_token(&CliError::Auth(
            "unauthorized".into()
        )));
        assert!(agent_send_may_use_run_token(&CliError::Http(
            "unauthorized: capability not granted by this daemon (stale after update?)".into()
        )));
        assert!(agent_send_may_use_run_token(&CliError::Http(
            "unauthorized: registry rediscovery found no replacement verifier key for this Run"
                .into()
        )));
        assert!(!agent_send_may_use_run_token(&CliError::Http(
            "principal cannot access this channel".into()
        )));
        assert!(!agent_send_may_use_run_token(&CliError::Launch(
            "Message or --file is required".into()
        )));
    }

    fn reply(status: u16, retry_after: Option<&str>) -> reqwest::Response {
        let mut response = tokio_tungstenite::tungstenite::http::Response::builder().status(status);
        if let Some(value) = retry_after {
            response = response.header("retry-after", value);
        }
        reqwest::Response::from(response.body(Vec::<u8>::new()).unwrap())
    }

    #[test]
    fn a_rate_limited_reply_is_waited_out_for_as_long_as_it_asks_within_a_minute() {
        assert_eq!(
            rate_limit_wait(&reply(429, Some("5"))),
            Some(Duration::from_secs(5))
        );
        assert_eq!(
            rate_limit_wait(&reply(429, Some("3600"))),
            Some(MAX_RATE_LIMIT_WAIT)
        );
        assert_eq!(
            rate_limit_wait(&reply(429, None)),
            Some(MAX_RATE_LIMIT_WAIT)
        );
        assert_eq!(rate_limit_wait(&reply(503, Some("5"))), None);
        assert_eq!(rate_limit_wait(&reply(200, None)), None);
    }

    #[test]
    fn compatibility_headers_identify_cli_and_daemon_independently() {
        for (component, expected) in [
            (ClientComponent::Cli, "cli"),
            (ClientComponent::Daemon, "daemon"),
        ] {
            let headers = client_identity_headers(component);
            assert_eq!(headers.get(CLIENT_COMPONENT_HEADER).unwrap(), expected);
            assert_eq!(
                headers.get(CLIENT_VERSION_HEADER).unwrap(),
                crate::version::current()
            );
            assert_eq!(headers.get(CLIENT_PROTOCOL_HEADER).unwrap(), "2");
        }
    }

    #[tokio::test]
    async fn websocket_request_carries_the_same_compatibility_identity() {
        let request = websocket_request(
            "wss://hub.example/ws/machine-daemons",
            ClientComponent::Daemon,
        )
        .await
        .expect("valid WebSocket request");
        assert_eq!(
            request.headers().get(CLIENT_COMPONENT_HEADER).unwrap(),
            "daemon"
        );
        assert_eq!(
            request.headers().get(CLIENT_VERSION_HEADER).unwrap(),
            crate::version::current()
        );
        assert_eq!(request.headers().get(CLIENT_PROTOCOL_HEADER).unwrap(), "2");
    }

    #[test]
    fn websocket_upgrade_response_is_terminal_and_actionable() {
        let response = tokio_tungstenite::tungstenite::http::Response::builder()
            .status(tokio_tungstenite::tungstenite::http::StatusCode::UPGRADE_REQUIRED)
            .body(Some(
                br#"{"error":"Run xmatrix update before reconnecting."}"#.to_vec(),
            ))
            .expect("valid response");
        let error = websocket_connect_error(
            "wss://xmatrix-hub.test.xmatrix.sh/ws",
            "WebSocket handshake failed",
            tokio_tungstenite::tungstenite::Error::Http(Box::new(response)),
        );
        assert!(matches!(
            error,
            CliError::UpgradeRequired(message) if message == "Run xmatrix update before reconnecting."
        ));
    }

    #[test]
    fn websocket_access_denial_is_scoped_to_the_test_origin() {
        let denied = || {
            tokio_tungstenite::tungstenite::Error::Http(Box::new(
                tokio_tungstenite::tungstenite::http::Response::builder()
                    .status(tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN)
                    .body(None)
                    .unwrap(),
            ))
        };
        let test_error = websocket_connect_error(
            "wss://xmatrix-hub.test.xmatrix.sh/ws",
            "WebSocket handshake failed",
            denied(),
        );
        assert!(matches!(test_error, CliError::Auth(_)));

        let production_error = websocket_connect_error(
            "wss://xmatrix-hub.xmatrix.sh/ws",
            "WebSocket handshake failed",
            denied(),
        );
        assert!(matches!(production_error, CliError::Relay(_)));
        assert!(!production_error.is_transient());
    }

    #[test]
    fn a_websocket_handshake_the_hub_could_not_answer_is_transient() {
        let unavailable = tokio_tungstenite::tungstenite::Error::Http(Box::new(
            tokio_tungstenite::tungstenite::http::Response::builder()
                .status(tokio_tungstenite::tungstenite::http::StatusCode::SERVICE_UNAVAILABLE)
                .body(None)
                .unwrap(),
        ));
        let error = websocket_connect_error(
            "wss://xmatrix-hub.xmatrix.sh/ws",
            "WebSocket handshake failed",
            unavailable,
        );
        assert!(error.is_transient(), "{error:?}");
        let dropped = websocket_connect_error(
            "wss://xmatrix-hub.xmatrix.sh/ws",
            "WebSocket handshake failed",
            tokio_tungstenite::tungstenite::Error::ConnectionClosed,
        );
        assert!(dropped.is_transient());
        assert_eq!(
            dropped.to_string(),
            "WebSocket handshake failed: Connection closed normally"
        );
    }

    fn refusal(status: u16, body: &str) -> CliError {
        response_status_error(reqwest::StatusCode::from_u16(status).unwrap(), body)
    }

    #[test]
    fn a_hub_refusal_keeps_its_status_code_and_verdict_and_reads_as_before() {
        let error = refusal(
            503,
            r#"{"error":"xMatrix is restarting; try again","code":"service_restarting","retryable":true}"#,
        );
        assert_eq!(error.to_string(), "xMatrix is restarting; try again");
        assert_eq!(
            error.http_status(),
            Some(&HttpStatusError {
                status: 503,
                code: Some("service_restarting".into()),
                retryable: true,
                message: "xMatrix is restarting; try again".into(),
            })
        );
        assert!(error.is_transient());

        for (status, body) in [
            (
                500,
                r#"{"error":"Internal error","code":"internal_error","retryable":false}"#,
            ),
            (403, r#"{"error":"forbidden","retryable":true}"#),
            (503, r#"{"error":"unavailable"}"#),
            (502, "<html>bad gateway</html>"),
        ] {
            let error = refusal(status, body);
            assert!(!error.is_transient(), "{status} {body}");
            assert_eq!(error.http_status().map(|error| error.status), Some(status));
        }
        assert_eq!(
            refusal(502, "<html>bad gateway</html>").to_string(),
            "Request failed with status 502 Bad Gateway"
        );
    }

    const RESTARTING: &[u8] = br#"{"error":"xMatrix is restarting; try again","code":"service_restarting","retryable":true}"#;

    #[test]
    fn a_retryable_hub_failure_is_replayed_for_any_method_after_its_retry_after() {
        for safe_method in [true, false] {
            assert_eq!(
                transient_retry_wait(503, Some("2"), RESTARTING, safe_method, 1),
                Some(Duration::from_secs(2))
            );
        }
        // Without Retry-After the wait starts at a second and doubles.
        assert_eq!(
            transient_retry_wait(503, None, RESTARTING, false, 1),
            Some(Duration::from_secs(1))
        );
        assert_eq!(
            transient_retry_wait(503, None, RESTARTING, false, 2),
            Some(Duration::from_secs(2))
        );
        // A long Retry-After is capped rather than waited out.
        assert_eq!(
            transient_retry_wait(503, Some("3600"), RESTARTING, true, 1),
            Some(MAX_TRANSIENT_WAIT)
        );
    }

    #[test]
    fn a_transient_failure_is_replayed_a_bounded_number_of_times() {
        assert!(
            transient_retry_wait(503, Some("1"), RESTARTING, true, TRANSIENT_ATTEMPTS - 1)
                .is_some()
        );
        assert_eq!(
            transient_retry_wait(503, Some("1"), RESTARTING, true, TRANSIENT_ATTEMPTS),
            None
        );
    }

    #[test]
    fn only_the_hub_verdict_or_a_safe_method_permits_a_replay() {
        let refused = br#"{"error":"Internal error","retryable":false}"#;
        // The Hub's explicit verdict wins, even for a GET with Retry-After.
        assert_eq!(transient_retry_wait(503, Some("1"), refused, true, 1), None);
        // No verdict: a GET or HEAD the reply asks to retry later is replayed,
        // a POST is not — it may already have taken effect.
        let edge = b"<html>503 Service Unavailable</html>";
        for status in [502, 503, 504] {
            assert_eq!(
                transient_retry_wait(status, Some("3"), edge, true, 1),
                Some(Duration::from_secs(3))
            );
            assert_eq!(
                transient_retry_wait(status, Some("3"), edge, false, 1),
                None
            );
        }
        assert_eq!(transient_retry_wait(503, None, edge, true, 1), None);
        // Other statuses are never transient here, whatever they say.
        for status in [400, 404, 409, 500] {
            assert_eq!(
                transient_retry_wait(status, Some("1"), RESTARTING, true, 1),
                None
            );
        }
    }

    #[test]
    fn retry_after_is_read_as_delta_seconds() {
        assert_eq!(parse_retry_after("5"), Some(Duration::from_secs(5)));
        assert_eq!(parse_retry_after(" 0 "), Some(Duration::ZERO));
        assert_eq!(parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT"), None);
        assert_eq!(parse_retry_after("-1"), None);
        assert_eq!(parse_retry_after(""), None);
    }

    /// Serves the given raw replies in order, one per connection, and counts
    /// the requests that arrived.
    async fn serve_replies(
        replies: Vec<&'static str>,
    ) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/api/fixture", listener.local_addr().unwrap());
        let served = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = served.clone();
        tokio::spawn(async move {
            for reply in replies {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 4096];
                // Read the head and the small fixture body before answering.
                while !String::from_utf8_lossy(&request).contains("\r\n\r\n") {
                    let read = stream.read(&mut buffer).await.unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                }
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                stream.write_all(reply.as_bytes()).await.unwrap();
                let _ = stream.shutdown().await;
            }
        });
        (url, served)
    }

    const RESTARTING_REPLY: &str = "HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\ncontent-type: application/json\r\nretry-after: 0\r\ncontent-length: 89\r\n\r\n{\"error\":\"xMatrix is restarting; try again\",\"code\":\"service_restarting\",\"retryable\":true}";
    const REFUSED_REPLY: &str = "HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\ncontent-type: application/json\r\nretry-after: 0\r\ncontent-length: 60\r\n\r\n{\"error\":\"Internal error\",\"code\":\"failed\",\"retryable\":false}";
    const OK_REPLY: &str = "HTTP/1.1 200 OK\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: 11\r\n\r\n{\"ok\":true}";

    #[tokio::test]
    async fn a_post_the_hub_calls_retryable_is_replayed_until_it_succeeds() {
        let (url, served) = serve_replies(vec![RESTARTING_REPLY, RESTARTING_REPLY, OK_REPLY]).await;
        let reply: serde_json::Value =
            request_json(&url, "POST", None, Some(serde_json::json!({"n": 1})))
                .await
                .expect("third send succeeds");
        assert_eq!(reply, serde_json::json!({"ok": true}));
        assert_eq!(served.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_transient_failure_that_outlasts_the_attempts_keeps_the_hub_verdict() {
        let (url, served) = serve_replies(vec![
            RESTARTING_REPLY,
            RESTARTING_REPLY,
            RESTARTING_REPLY,
            OK_REPLY,
        ])
        .await;
        let error = request_json::<serde_json::Value>(&url, "POST", None, None)
            .await
            .expect_err("three outages are reported");
        assert_eq!(served.load(std::sync::atomic::Ordering::SeqCst), 3);
        assert_eq!(error.to_string(), "xMatrix is restarting; try again");
        let status = error.http_status().expect("structured refusal");
        assert_eq!(status.status, 503);
        assert_eq!(status.code.as_deref(), Some("service_restarting"));
        assert!(status.retryable && error.is_transient());
    }

    #[tokio::test]
    async fn a_failure_the_hub_calls_final_is_not_replayed() {
        let (url, served) = serve_replies(vec![REFUSED_REPLY, OK_REPLY]).await;
        let error = request_json::<serde_json::Value>(&url, "GET", None, None)
            .await
            .expect_err("reported");
        assert_eq!(served.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(!error.is_transient());
        assert_eq!(error.to_string(), "Internal error");
    }

    #[tokio::test]
    async fn a_buffered_reply_reports_the_same_status_headers_and_body() {
        let response = tokio_tungstenite::tungstenite::http::Response::builder()
            .status(503)
            .header("retry-after", "1")
            .body(RESTARTING.to_vec())
            .unwrap();
        let (rebuilt, body) = buffered(reqwest::Response::from(response)).await.unwrap();
        assert_eq!(body, RESTARTING);
        assert_eq!(rebuilt.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(rebuilt.headers().get("retry-after").unwrap(), "1");
        assert_eq!(rebuilt.bytes().await.unwrap(), RESTARTING);
    }
}

/// The broker request path over a Unix socket. `reqwest` cannot speak UDS, so
/// this half is hand written and has to be exercised directly.
#[cfg(all(test, unix))]
mod daemon_socket_transport_tests {
    use super::*;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    /// Answers one request, returning what it received so the test can assert
    /// the wire shape rather than only the decoded result.
    async fn serve_once(
        response: &'static str,
    ) -> (std::path::PathBuf, tokio::task::JoinHandle<String>) {
        let path = std::env::temp_dir().join(format!("xm-broker-{}.sock", uuid::Uuid::new_v4()));
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut seen = vec![0u8; 4096];
            let read = stream.read(&mut seen).await.unwrap();
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.flush().await.unwrap();
            String::from_utf8_lossy(&seen[..read]).to_string()
        });
        (path, handle)
    }

    #[tokio::test]
    async fn a_broker_request_carries_its_capability_and_body_over_the_socket() {
        let (path, served) = serve_once(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 28\r\n\r\n{\"value\":{\"messageId\":\"m1\"}}",
        )
        .await;
        let stream = tokio::net::UnixStream::connect(&path).await.unwrap();
        let value = daemon_json_over_stream(
            stream,
            "/request/hub-json",
            "cap-123",
            &serde_json::json!({ "url": "https://hub.test" }),
        )
        .await
        .unwrap();
        assert_eq!(value["messageId"], "m1");

        let request = served.await.unwrap();
        assert!(
            request.starts_with("POST /request/hub-json HTTP/1.1"),
            "{request}"
        );
        assert!(
            request.contains("x-xmatrix-request-capability: cap-123"),
            "{request}"
        );
        assert!(
            request.contains("\"url\":\"https://hub.test\""),
            "{request}"
        );
        // Without a correct content-length the daemon would block waiting for
        // a body that never finishes arriving.
        assert!(request.contains("content-length: 26"), "{request}");
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn a_broker_error_is_surfaced_rather_than_returned_as_a_value() {
        let (path, _served) = serve_once(
            "HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\ncontent-length: 24\r\n\r\n{\"error\":\"unauthorized\"}",
        )
        .await;
        let stream = tokio::net::UnixStream::connect(&path).await.unwrap();
        let error = daemon_json_over_stream(
            stream,
            "/request/hub-json",
            "cap-123",
            &serde_json::json!({}),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(
                error,
                DaemonBrokerRequestError::Other(CliError::Http(ref message))
                    if message.contains("unauthorized")
            ),
            "non-401 refusals must not be classified as capability Unauthorized: {error:?}"
        );
        let _ = std::fs::remove_file(&path);
    }

    async fn assert_send_recovery_upgrade(response: &'static str, reason: &str) {
        let (path, _served) = serve_once(response).await;
        let stream = tokio::net::UnixStream::connect(&path).await.unwrap();
        let error = daemon_json_over_stream(
            stream,
            "/request/send-recovery",
            "cap-123",
            &serde_json::json!({}),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(
                error,
                DaemonBrokerRequestError::Other(CliError::UpgradeRequired(_))
            ),
            "{reason}: {error:?}"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn an_old_daemon_without_send_recovery_is_named_as_needing_an_upgrade() {
        assert_send_recovery_upgrade("HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\ncontent-length: 14\r\n\r\n{\"value\":null}", "a 404 on send recovery must keep its upgrade meaning over the socket too").await;
    }

    #[tokio::test]
    async fn a_daemon_that_answers_not_found_with_200_still_asks_for_an_upgrade() {
        // Every daemon shipped so far writes its fallback arm as `200 OK` with
        // this body, so this — not the 404 — is the shape a real older daemon
        // presents. Keying the hint on the status alone never fired.
        assert_send_recovery_upgrade("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 21\r\n\r\n{\"error\":\"not found\"}", "an older daemon must be named as needing an upgrade, not reported as a bare error").await;
    }

    #[test]
    fn only_a_missing_route_counts_as_an_unserved_one() {
        assert!(daemon_route_is_unserved(404, None));
        assert!(daemon_route_is_unserved(200, Some("not found")));
        // A route that exists and failed must never be read as "upgrade me".
        assert!(!daemon_route_is_unserved(500, Some("run refused")));
        assert!(!daemon_route_is_unserved(200, None));
        assert!(!daemon_route_is_unserved(
            400,
            Some("invalid run payload: x")
        ));
    }
}

#[cfg(test)]
#[path = "http_catalog_error_tests.rs"]
mod catalog_error_tests;

#[cfg(test)]
mod capability_rediscovery_decision_tests {
    use super::*;

    #[test]
    fn rediscovery_retries_unless_the_daemon_named_malformed() {
        // Old daemon: real 401, bare unauthorized, no reason field.
        let old = DaemonBrokerRequestError::Unauthorized {
            message: "unauthorized".into(),
            reason: None,
        };
        assert!(
            old.should_rediscover_capability(),
            "old daemons are exactly who #2551 must still rediscover for"
        );

        // New daemon: grant miss.
        let not_granted = DaemonBrokerRequestError::Unauthorized {
            message: "unauthorized: capability not granted by this daemon (stale after update?)"
                .into(),
            reason: Some("capability_not_granted".into()),
        };
        assert!(not_granted.should_rediscover_capability());

        // New daemon: caller presented junk — must NOT be papered over by a
        // registry key that happens to work.
        let malformed = DaemonBrokerRequestError::Unauthorized {
            message: "unauthorized: malformed request capability".into(),
            reason: Some("capability_malformed".into()),
        };
        assert!(
            !malformed.should_rediscover_capability(),
            "malformed must fail even when rediscovery would find a usable key"
        );

        // Unknown future reason still retries — only explicit malformed opts out.
        let unknown = DaemonBrokerRequestError::Unauthorized {
            message: "unauthorized".into(),
            reason: Some("capability_expired".into()),
        };
        assert!(
            unknown.should_rediscover_capability(),
            "an older client must still rediscover when it does not recognize a new reason"
        );

        // Non-401 failures never enter rediscovery.
        let other = DaemonBrokerRequestError::Other(CliError::Http("unauthorized".into()));
        assert!(
            !other.should_rediscover_capability(),
            "a 200 body that merely mentions unauthorized must not trigger rediscovery"
        );
    }

    #[test]
    fn malformed_refusal_is_not_rescued_by_a_registry_hit() {
        // The gate must live in should_rediscover_capability: rediscovery itself
        // will happily return a Replacement when the registry has a key.
        let refusal = DaemonBrokerRequestError::Unauthorized {
            message: "unauthorized: malformed request capability".into(),
            reason: Some("capability_malformed".into()),
        };
        assert!(
            !refusal.should_rediscover_capability(),
            "a working registry key must not turn a malformed presentation into success"
        );
    }
}
