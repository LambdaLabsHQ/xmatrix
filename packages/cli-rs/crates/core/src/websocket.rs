use std::net::SocketAddr;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::error::{CliError, Result};
use crate::http;

pub type ClientWebSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// Per-address TCP budget for a Happy Eyeballs race. Families are tried in
/// parallel, so an unroutable AAAA cannot stall IPv4 and an IPv6-only network
/// is not starved waiting on IPv4.
const ADDRESS_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

pub async fn connect(
    request: tokio_tungstenite::tungstenite::http::Request<()>,
) -> Result<ClientWebSocket> {
    let url = request.uri().to_string();
    let Some((host, port)) = target(&url) else {
        return tokio_tungstenite::connect_async(request)
            .await
            .map(|value| value.0)
            .map_err(|error| {
                http::websocket_connect_error(&url, "WebSocket handshake failed", error)
            });
    };
    let proxy = proxy_for(
        &host,
        std::env::var("HTTPS_PROXY")
            .or_else(|_| std::env::var("https_proxy"))
            .ok(),
        std::env::var("NO_PROXY")
            .or_else(|_| std::env::var("no_proxy"))
            .ok(),
    );
    let stream = if let Some(proxy) = proxy {
        let proxy = proxy
            .strip_prefix("http://")
            .and_then(|value| value.split('/').next())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| CliError::Relay("HTTPS_PROXY must use http://host:port".into()))?;
        let mut stream = tokio::net::TcpStream::connect(proxy).await?;
        let authority = format!("{host}:{port}");
        stream
            .write_all(
                format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n").as_bytes(),
            )
            .await?;
        let mut response = Vec::new();
        while !response.ends_with(b"\r\n\r\n") && response.len() < 8192 {
            let mut byte = [0];
            if stream.read_exact(&mut byte).await.is_err() {
                break;
            }
            response.push(byte[0]);
        }
        if !response.starts_with(b"HTTP/1.1 200 ") && !response.starts_with(b"HTTP/1.0 200 ") {
            return Err(CliError::Relay("HTTPS proxy CONNECT failed".into()));
        }
        stream
    } else {
        connect_tcp_happy_eyeballs(&host, port).await?
    };
    tokio_tungstenite::client_async_tls(request, stream)
        .await
        .map(|value| value.0)
        .map_err(|error| http::websocket_connect_error(&url, "WebSocket handshake failed", error))
}

pub(crate) async fn connect_endpoint(
    url: &str,
    component: http::ClientComponent,
    timeout: Duration,
) -> std::result::Result<Result<ClientWebSocket>, tokio::time::error::Elapsed> {
    tokio::time::timeout(timeout, async {
        let request = http::websocket_request(url, component).await?;
        connect(request).await
    })
    .await
}

pub(crate) struct ConnectionFailure {
    pub reason: String,
    pub upgrade_required: bool,
}

pub(crate) async fn connect_domain(
    url: &str,
    component: http::ClientComponent,
    timeout: Duration,
    timeout_reason: &str,
) -> std::result::Result<ClientWebSocket, ConnectionFailure> {
    match connect_endpoint(url, component, timeout).await {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(error)) => Err(ConnectionFailure {
            upgrade_required: matches!(&error, CliError::UpgradeRequired(_)),
            reason: error.to_string(),
        }),
        Err(_) => Err(ConnectionFailure {
            reason: timeout_reason.into(),
            upgrade_required: false,
        }),
    }
}

pub(crate) struct ConnectionOptions<'a> {
    pub component: http::ClientComponent,
    pub timeout: Duration,
    pub timeout_reason: &'a str,
    pub reconnect_max: Duration,
}

/// Domain connection admission preserves one initial ready waiter and the
/// existing event/backoff behavior for established sockets.
pub(crate) async fn connect_with_reconnect<T, E>(
    url: &str,
    options: ConnectionOptions<'_>,
    ready: &mut Option<tokio::sync::oneshot::Sender<std::result::Result<T, String>>>,
    events: &tokio::sync::mpsc::UnboundedSender<E>,
    backoff: &mut Duration,
    event_types: ReconnectEvents<E>,
) -> std::result::Result<Option<ClientWebSocket>, ()> {
    match connect_domain(
        url,
        options.component,
        options.timeout,
        options.timeout_reason,
    )
    .await
    {
        Ok(stream) => Ok(Some(stream)),
        Err(failure) => {
            if handle_connection_failure(
                ready,
                events,
                failure.reason,
                failure.upgrade_required,
                backoff,
                options.reconnect_max,
                event_types,
            )
            .await
            {
                Err(())
            } else {
                Ok(None)
            }
        }
    }
}

/// Handshake read failures end the initial waiter; established sockets pause
/// before retrying without emitting a domain event or advancing backoff.
pub(crate) async fn fail_handshake_or_wait<T>(
    ready: &mut Option<tokio::sync::oneshot::Sender<std::result::Result<T, String>>>,
    reason: &str,
    backoff: Duration,
) -> bool {
    if fail_initial_ready(ready, reason) {
        return true;
    }
    tokio::time::sleep(backoff).await;
    false
}

pub(crate) async fn wait_before_reconnect(backoff: &mut Duration, max: Duration) {
    tokio::time::sleep(*backoff).await;
    *backoff = (*backoff * 2).min(max);
}

pub(crate) struct ReconnectEvents<E> {
    pub disconnected: fn(String) -> E,
    pub error: fn(String) -> E,
}

/// Initial readiness fails before any reconnect event. Established sessions
/// stop on fatal failures and retain exponential backoff for transient failures.
pub(crate) async fn handle_connection_failure<T, E>(
    ready: &mut Option<tokio::sync::oneshot::Sender<std::result::Result<T, String>>>,
    events: &tokio::sync::mpsc::UnboundedSender<E>,
    reason: String,
    fatal: bool,
    backoff: &mut Duration,
    max: Duration,
    event_types: ReconnectEvents<E>,
) -> bool {
    if fail_initial_ready(ready, &reason) {
        return true;
    }
    let event = if fatal {
        (event_types.error)(reason)
    } else {
        (event_types.disconnected)(reason)
    };
    let _ = events.send(event);
    if fatal {
        return true;
    }
    wait_before_reconnect(backoff, max).await;
    false
}

/// Build a domain endpoint from either an HTTP or WebSocket Hub address.
pub(crate) fn connection_host(hub_url: &str) -> (bool, &str) {
    let value = hub_url.trim().trim_end_matches('/');
    let secure = value.starts_with("https://") || value.starts_with("wss://");
    let host = value
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("wss://")
        .trim_start_matches("ws://")
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    (secure, host)
}

pub(crate) fn domain_connection_url(hub_url: &str, path: &str) -> String {
    let (secure, host) = connection_host(hub_url);
    format!("{}://{host}{path}", if secure { "wss" } else { "ws" })
}

/// Fail the initial ready waiter once; established connections handle the
/// same failure through their domain-specific reconnect events instead.
pub(crate) fn fail_initial_ready<T>(
    ready: &mut Option<tokio::sync::oneshot::Sender<std::result::Result<T, String>>>,
    reason: &str,
) -> bool {
    if let Some(sender) = ready.take() {
        let _ = sender.send(Err(reason.to_string()));
        true
    } else {
        false
    }
}

pub(crate) async fn receive_handshake_text<S>(
    read: &mut S,
    timeout: Duration,
    domain: &str,
    closed_reason: &str,
) -> std::result::Result<String, String>
where
    S: futures_util::Stream<
            Item = std::result::Result<
                tokio_tungstenite::tungstenite::Message,
                tokio_tungstenite::tungstenite::Error,
            >,
        > + Unpin,
{
    use futures_util::StreamExt;
    match tokio::time::timeout(timeout, read.next()).await {
        Ok(Some(Ok(message))) => message
            .into_text()
            .map(|text| text.to_string())
            .map_err(|error| format!("{domain} returned a non-text handshake: {error}")),
        Ok(Some(Err(error))) => Err(format!("{domain} handshake failed: {error}")),
        Ok(None) | Err(_) => Err(closed_reason.to_string()),
    }
}

#[cfg(test)]
fn first_addr_per_family(addrs: &[SocketAddr]) -> (Option<SocketAddr>, Option<SocketAddr>) {
    (
        addrs.iter().copied().find(SocketAddr::is_ipv6),
        addrs.iter().copied().find(SocketAddr::is_ipv4),
    )
}

async fn connect_one(addr: SocketAddr) -> std::result::Result<tokio::net::TcpStream, String> {
    match tokio::time::timeout(
        ADDRESS_CONNECT_TIMEOUT,
        tokio::net::TcpStream::connect(addr),
    )
    .await
    {
        Ok(Ok(stream)) => {
            let _ = stream.set_nodelay(true);
            Ok(stream)
        }
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err(format!("connect to {addr} timed out")),
    }
}

async fn connect_tcp_happy_eyeballs(host: &str, port: u16) -> Result<tokio::net::TcpStream> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| CliError::Relay(format!("Failed to resolve {host}: {error}")))?
        .collect();
    if addrs.is_empty() {
        return Err(CliError::Relay(format!("No addresses for {host}:{port}")));
    }

    let mut set = tokio::task::JoinSet::new();
    for addr in addrs {
        set.spawn(async move { connect_one(addr).await });
    }

    let mut last_error = None;
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(Ok(stream)) => {
                set.abort_all();
                return Ok(stream);
            }
            Ok(Err(error)) => last_error = Some(error),
            Err(error) => last_error = Some(error.to_string()),
        }
    }
    Err(CliError::Relay(format!(
        "WebSocket TCP connect failed for {host}:{port}: {}",
        last_error.unwrap_or_else(|| "no addresses".into())
    )))
}

fn target(url: &str) -> Option<(String, u16)> {
    let authority = url.strip_prefix("wss://")?.split('/').next()?;
    let (host, port) = authority
        .rsplit_once(':')
        .map_or((authority, 443), |(host, port)| {
            (host, port.parse().unwrap_or(443))
        });
    Some((host.to_string(), port))
}

fn proxy_for(host: &str, proxy: Option<String>, no_proxy: Option<String>) -> Option<String> {
    (!no_proxy
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .any(|entry| {
            let suffix = entry.trim_start_matches('.');
            entry == "*"
                || (!suffix.is_empty() && (suffix == host || host.ends_with(&format!(".{suffix}"))))
        }))
    .then_some(proxy)
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_secure_websocket_target() {
        assert_eq!(
            target("wss://hub.example/ws"),
            Some(("hub.example".into(), 443))
        );
        assert_eq!(target("ws://localhost/ws"), None);
    }

    #[test]
    fn proxy_respects_no_proxy() {
        let proxy = Some("http://127.0.0.1:7890".into());
        assert_eq!(proxy_for("hub.example", proxy.clone(), None), proxy);
        assert_eq!(
            proxy_for("hub.example", proxy, Some("localhost,.example".into())),
            None
        );
    }

    #[test]
    fn happy_eyeballs_keeps_both_families() {
        let v4: SocketAddr = "1.2.3.4:443".parse().unwrap();
        let v6: SocketAddr = "[2606:4700:3030::ac43:b680]:443".parse().unwrap();
        let (got_v6, got_v4) = first_addr_per_family(&[v4, v6]);
        assert_eq!(got_v4, Some(v4));
        assert_eq!(got_v6, Some(v6));
    }

    #[test]
    fn happy_eyeballs_ipv6_only_does_not_require_ipv4() {
        let v6: SocketAddr = "[2606:4700:3030::ac43:b680]:443".parse().unwrap();
        let (got_v6, got_v4) = first_addr_per_family(&[v6]);
        assert_eq!(got_v6, Some(v6));
        assert_eq!(got_v4, None);
    }
}
