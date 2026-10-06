async fn spawn_daemon_request_broker(
    hub_url: String,
    machine_id: Option<String>,
    auth_broker_url: Option<String>,
    run_registry: DaemonRunRegistry,
) -> error::Result<Option<DaemonRequestBroker>> {
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|err| CliError::Launch(format!("Failed to bind daemon request broker: {err}")))?;
    std_listener.set_nonblocking(true).map_err(|err| {
        CliError::Launch(format!("Failed to configure daemon request broker: {err}"))
    })?;
    let addr = std_listener.local_addr().map_err(|err| {
        CliError::Launch(format!("Failed to read daemon request broker addr: {err}"))
    })?;
    let listener = tokio::net::TcpListener::from_std(std_listener)
        .map_err(|err| CliError::Launch(format!("Failed to start daemon request broker: {err}")))?;
    let broker = DaemonRequestBroker {
        url: format!("http://{addr}"),
        owner_capability: uuid::Uuid::new_v4().to_string(),
        agent_capabilities: Arc::new(Mutex::new(HashMap::new())),
        machine_id,
        hub_url: Some(hub_url),
        auth_broker_url,
        run_registry,
    };
    persist_daemon_request_broker_state(&broker.url, &broker.owner_capability);
    let broker_for_task = broker.clone();

    // The same broker over a Unix socket: a name that survives restarts, guarded
    // by file mode and the peer's uid rather than by being merely unrouted. TCP
    // stays until the socket is proven — a daemon that cannot open one must
    // still serve, because every live Run depends on it.
    #[cfg(unix)]
    {
        match crate::runtime_daemon_socket::bind_daemon_socket("request-broker").await {
            Ok(bound) => {
                let path = bound.path.clone();
                if let Err(error) = xmatrix_cli_core::daemon_record::update_record(|record| {
                    record.request_broker_socket = Some(path.display().to_string());
                }) {
                    eprintln!("⚠ daemon record could not record the request socket: {error}");
                }
                let socket_broker = broker.clone();
                config::spawn_profile_task(async move {
                    let bound = bound;
                    loop {
                        let stream = match bound.listener.accept().await {
                            Ok((stream, _)) => stream,
                            Err(error) => {
                                survive_accept_error("request broker socket", error).await;
                                continue;
                            }
                        };
                        if !crate::runtime_daemon_socket::peer_is_owner(&stream) {
                            continue;
                        }
                        let broker = socket_broker.clone();
                        config::spawn_profile_task(async move {
                            handle_daemon_request_broker_request(stream, broker).await;
                        });
                    }
                });
            }
            Err(error) => {
                eprintln!("⚠ daemon request socket unavailable, TCP only: {error}");
                // Never advertise a socket this runtime does not answer on.
                if let Err(error) = xmatrix_cli_core::daemon_record::update_record(|record| {
                    record.request_broker_socket = None;
                }) {
                    eprintln!("⚠ daemon record could not drop the request socket: {error}");
                }
            }
        }
    }

    config::spawn_profile_task(async move {
        loop {
            let stream = match listener.accept().await {
                Ok((stream, _)) => stream,
                Err(error) => {
                    survive_accept_error("request broker", error).await;
                    continue;
                }
            };
            let broker = broker_for_task.clone();
            config::spawn_profile_task(async move {
                handle_daemon_request_broker_request(stream, broker).await;
            });
        }
    });

    Ok(Some(broker))
}

#[derive(Debug)]
struct DaemonLocalHttpRequest {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

impl DaemonLocalHttpRequest {
    fn body_text(&self) -> Result<&str, String> {
        std::str::from_utf8(&self.body).map_err(|_| "request body must be UTF-8".to_string())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonHubJsonRequest {
    url: String,
    method: String,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    body: Option<Value>,
    #[serde(default)]
    journal_send: bool,
}

fn validate_daemon_hub_json_request(
    hub_url: &str,
    payload: &DaemonHubJsonRequest,
) -> Result<(), String> {
    let configured = reqwest::Url::parse(hub_url).map_err(|_| "invalid daemon Hub URL")?;
    let requested = reqwest::Url::parse(&payload.url).map_err(|_| "invalid Hub request URL")?;
    if requested.origin() != configured.origin()
        || requested.username() != ""
        || requested.password().is_some()
        || requested.fragment().is_some()
    {
        return Err("Hub request target is outside the daemon environment".into());
    }
    if !matches!(
        payload.method.as_str(),
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
    ) {
        return Err("Hub request method is not allowed".into());
    }
    let path = requested.path();
    if !path.starts_with("/api/")
        || path.starts_with("/api/auth/")
        || path.starts_with("/api/admin/")
        || path.starts_with("/api/platform-admin/")
    {
        return Err("Hub request route is not available to Agent broker calls".into());
    }
    if payload
        .token
        .as_deref()
        .map(str::trim)
        .is_none_or(str::is_empty)
    {
        return Err("Hub request is missing the run-scoped token".into());
    }
    Ok(())
}

fn validate_daemon_hub_upload_request(
    hub_url: &str,
    url: &str,
    token: &str,
    content_type: &str,
    checksum_sha256: &str,
    body_len: usize,
) -> Result<(), String> {
    let configured = reqwest::Url::parse(hub_url).map_err(|_| "invalid daemon Hub URL")?;
    let requested = reqwest::Url::parse(url).map_err(|_| "invalid Hub upload URL")?;
    if !same_bare_hub_origin(&configured, &requested)
        || !requested
            .path()
            .starts_with("/api/relay-v2/private-r2/uploads/")
    {
        return Err("Hub upload target is outside the allowed Agent route".into());
    }
    if token.trim().is_empty() {
        return Err("Hub upload is missing the run-scoped token".into());
    }
    if content_type.trim().is_empty() || content_type.len() > 255 {
        return Err("Hub upload content type is invalid".into());
    }
    if checksum_sha256.len() != 64 || !checksum_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Hub upload checksum is invalid".into());
    }
    if body_len > DAEMON_HUB_UPLOAD_INPUT_LIMIT {
        return Err("Hub upload exceeds the Agent broker size limit".into());
    }
    Ok(())
}

async fn read_daemon_local_http_request<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    stream: &mut S,
) -> Option<DaemonLocalHttpRequest> {
    let mut buffer = Vec::new();
    let mut temp = [0_u8; 4096];
    let mut content_len = None;
    let mut input_limit = DAEMON_REQUEST_OUTPUT_LIMIT;
    loop {
        let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut temp))
            .await
            .ok()?
            .ok()?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&temp[..read]);
        if content_len.is_none()
            && let Some(header_end) = find_http_header_end(&buffer) {
                let headers = String::from_utf8_lossy(&buffer[..header_end]).to_string();
                let is_hub_upload = headers
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .is_some_and(|path| path.starts_with("/request/hub-bytes?"));
                if is_hub_upload {
                    input_limit = DAEMON_HUB_UPLOAD_INPUT_LIMIT;
                }
                let declared = http_content_length(&headers).unwrap_or(0);
                if declared > input_limit {
                    return None;
                }
                content_len = Some(declared);
            }
        if buffer.len() > input_limit.saturating_add(64 * 1024) {
            return None;
        }
        if let (Some(header_end), Some(len)) = (find_http_header_end(&buffer), content_len)
            && buffer.len() >= header_end + 4 + len {
                break;
            }
    }
    let header_end = find_http_header_end(&buffer)?;
    let header_text = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let body_bytes = &buffer[header_end + 4..];
    let mut lines = header_text.lines();
    let request_line = lines.next()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let raw_path = parts.next()?.to_string();
    let (path, query) = parse_local_http_path(&raw_path);
    let mut headers = HashMap::new();
    for line in lines {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
    }
    Some(DaemonLocalHttpRequest {
        method,
        path,
        query,
        headers,
        body: body_bytes.to_vec(),
    })
}

fn find_http_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn http_content_length(headers: &str) -> Option<usize> {
    headers.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if key.trim().eq_ignore_ascii_case("content-length") {
            value.trim().parse::<usize>().ok()
        } else {
            None
        }
    })
}

fn parse_local_http_path(raw_path: &str) -> (String, HashMap<String, String>) {
    let (path, query_text) = raw_path.split_once('?').unwrap_or((raw_path, ""));
    let query = query_text
        .split('&')
        .filter_map(|part| {
            if part.is_empty() {
                return None;
            }
            let (key, value) = part.split_once('=').unwrap_or((part, ""));
            let key = urlencoding::decode(key).ok()?.to_string();
            let value = urlencoding::decode(value).ok()?.to_string();
            Some((key, value))
        })
        .collect();
    (path.to_string(), query)
}

fn daemon_request_header<'a>(request: &'a DaemonLocalHttpRequest, name: &str) -> Option<&'a str> {
    request
        .headers
        .get(&name.to_ascii_lowercase())
        .map(String::as_str)
}

fn daemon_request_capability(request: &DaemonLocalHttpRequest) -> Option<&str> {
    daemon_request_header(request, "x-xmatrix-request-capability")
        .or_else(|| daemon_request_header(request, DAEMON_REQUEST_CAPABILITY_ENV))
}

fn daemon_request_agent_context(
    broker: &DaemonRequestBroker,
    request: &DaemonLocalHttpRequest,
) -> Option<DaemonRequestAgentContext> {
    let capability = daemon_request_capability(request)?;
    // The same admission rule the auth broker uses. This side only ever saw raw
    // capabilities from a live Run's environment, so it never hit the restored
    // Run failure — but two copies of one rule is what produced that failure,
    // and only one copy was ever fixed.
    broker
        .agent_capabilities
        .lock()
        .ok()
        .and_then(|capabilities| {
            daemon_capability_candidates(capability).find_map(|key| capabilities.get(&key).cloned())
        })
}

fn daemon_request_unauthorized_detail(
    request: &DaemonLocalHttpRequest,
) -> (&'static str, Option<&'static str>) {
    match daemon_request_capability(request)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        None => ("unauthorized", None),
        // `sha256:` that is not a 64-hex digest is the caller's fault — not the
        // post-update grant rotation that looks the same as a bare 401.
        Some(capability)
            if capability.starts_with("sha256:")
                && persisted_daemon_capability_key(capability).is_none() =>
        {
            (
                "unauthorized: malformed request capability",
                Some("capability_malformed"),
            )
        }
        // A well-formed proof this daemon never issued. After `xmatrix update`
        // that is usually a live Run still holding spawn-time raw proof while
        // the replacement only restored the verifier key.
        Some(_) => (
            "unauthorized: capability not granted by this daemon (stale after update?)",
            Some("capability_not_granted"),
        ),
    }
}

async fn write_daemon_request_unauthorized<
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
>(
    stream: &mut S,
    request: &DaemonLocalHttpRequest,
) {
    let (message, reason) = daemon_request_unauthorized_detail(request);
    write_daemon_request_error_with_reason(stream, "401 Unauthorized", message, reason).await;
}

async fn authorized_daemon_request_hub<
    'a,
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
>(
    stream: &mut S,
    broker: &'a DaemonRequestBroker,
    request: &DaemonLocalHttpRequest,
) -> Option<&'a str> {
    if daemon_request_agent_context(broker, request).is_none() {
        write_daemon_request_unauthorized(stream, request).await;
        return None;
    }
    match broker.hub_url.as_deref() {
        Some(hub_url) => Some(hub_url),
        None => {
            write_daemon_request_error(stream, "503 Service Unavailable", "hub url unavailable")
                .await;
            None
        }
    }
}

async fn handle_daemon_request_broker_request<
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
>(
    mut stream: S,
    broker: DaemonRequestBroker,
) {
    let Some(request) = read_daemon_local_http_request(&mut stream).await else {
        write_daemon_auth_broker_response(
            &mut stream,
            "400 Bad Request",
            r#"{"error":"bad request"}"#,
        )
        .await;
        return;
    };
    if request.method == "POST" && request.path == "/request/hub-bytes" {
        let Some(hub_url) = authorized_daemon_request_hub(&mut stream, &broker, &request).await
        else {
            return;
        };
        let url = request.query.get("url").cloned().unwrap_or_default();
        let token = daemon_request_header(&request, "x-xmatrix-hub-token")
            .unwrap_or_default()
            .to_string();
        let content_type = daemon_request_header(&request, "x-xmatrix-content-type")
            .unwrap_or_default()
            .to_string();
        let checksum = daemon_request_header(&request, "x-xmatrix-content-sha256")
            .unwrap_or_default()
            .to_string();
        let response = match validate_daemon_hub_upload_request(
            hub_url,
            &url,
            &token,
            &content_type,
            &checksum,
            request.body.len(),
        ) {
            Ok(()) => {
                match http::put_bytes::<Value>(&url, &token, &content_type, &checksum, request.body)
                    .await
                {
                    Ok(value) => serde_json::json!({ "value": value }).to_string(),
                    Err(err) => daemon_request_error_body(&err.to_string(), None),
                }
            }
            Err(err) => daemon_request_error_body(&err, None),
        };
        return write_daemon_auth_broker_response(&mut stream, "200 OK", &response).await;
    }

    let request_body = request.body_text().unwrap_or_default();

    if request.method == "POST" && request.path == "/request/hub-product-media" {
        return handle_daemon_hub_product_media_request(
            &mut stream,
            &broker,
            &request,
            request_body,
        )
        .await;
    }

    // These arms all used to be written out as `200 OK`, which made a failed
    // operation indistinguishable from a successful one on the status line and
    // left the send-recovery upgrade hint in `core/src/http.rs`, keyed on 404,
    // permanently unreachable.
    use DaemonRequestOutcome::{Failed, Invalid, Served, Unknown};
    let outcome = match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/request/send-recovery") => {
            match serde_json::from_str::<runtime_send_recovery::RecoveryRequest>(request_body) {
                Ok(selection) => {
                    match runtime_send_recovery::recover(&broker, &request, selection).await {
                        Ok(value) => Served(serde_json::json!({ "value": value }).to_string()),
                        Err(err) => Failed(err.to_string()),
                    }
                }
                Err(_) => Invalid("Invalid send recovery request".into()),
            }
        }
        ("POST", "/request/hub-json") => {
            let Some(hub_url) = authorized_daemon_request_hub(&mut stream, &broker, &request).await
            else {
                return;
            };
            match serde_json::from_str::<DaemonHubJsonRequest>(request_body) {
                Ok(payload) => match validate_daemon_hub_json_request(hub_url, &payload) {
                    Ok(()) => {
                        match runtime_daemon_message_send::execute(&broker, &request, payload).await
                        {
                            Ok(value) => Served(serde_json::json!({ "value": value }).to_string()),
                            Err(err) => Failed(err.to_string()),
                        }
                    }
                    Err(err) => Failed(err),
                },
                Err(err) => Invalid(format!("invalid Hub request: {err}")),
            }
        }
        ("POST", "/request/channel-history") => {
            let Some(hub_url) = authorized_daemon_request_hub(&mut stream, &broker, &request).await
            else {
                return;
            };
            match serde_json::from_str::<runtime_channel_history_cache::DaemonChannelHistoryPayload>(
                request_body,
            ) {
                Ok(payload) => {
                    match runtime_channel_history_cache::serve_daemon_channel_history(
                        hub_url, payload,
                    )
                    .await
                    {
                        Ok(body) => Served(body),
                        Err(err) => Failed(err.to_string()),
                    }
                }
                Err(err) => Invalid(format!("invalid history payload: {err}")),
            }
        }
        ("POST", "/request/rebind-run") => {
            let Some(context) = daemon_request_agent_context(&broker, &request) else {
                return write_daemon_request_unauthorized(&mut stream, &request).await;
            };
            match serde_json::from_str::<DaemonRunRebindPayload>(request_body) {
                Ok(payload) => match rebind_daemon_run_pid(&broker, &context, &payload).await {
                    Ok(body) => Served(body),
                    Err(err) => Failed(err.to_string()),
                },
                Err(err) => Invalid(format!("invalid rebind payload: {err}")),
            }
        }
        ("POST", "/request/handoff-run") => {
            let Some(context) = daemon_request_agent_context(&broker, &request) else {
                return write_daemon_request_unauthorized(&mut stream, &request).await;
            };
            match serde_json::from_str::<DaemonRunHandoffPayload>(request_body) {
                #[cfg(windows)]
                Ok(payload) => match handoff_daemon_run(&broker, &context, payload).await {
                    Ok(body) => Served(body),
                    Err(err) => Failed(err.to_string()),
                },
                // A Unix wrapper starts its own replacement and only rebinds.
                #[cfg(not(windows))]
                Ok(_) => {
                    let _ = context;
                    Failed("run handoff is started by the wrapper itself on this platform".into())
                }
                Err(err) => Invalid(format!("invalid handoff payload: {err}")),
            }
        }
        _ => Unknown,
    };
    let (status, response) = outcome.into_response();
    write_daemon_auth_broker_response(&mut stream, status, &response).await;
}

/// What the request broker decided, so the status line can say it.
///
/// The brokers are read by clients that branch on the HTTP status: `http.rs`
/// turns a 404 on `/request/send-recovery` into an upgrade hint, and
/// `request_local_daemon_request_json` only looks for an `error` field once the
/// status is already 4xx or 5xx. Answering every outcome with `200 OK` made
/// both of those blind.
enum DaemonRequestOutcome {
    /// The route ran and produced its own body.
    Served(String),
    /// The caller's payload could not be understood.
    Invalid(String),
    /// The route ran and the operation failed.
    Failed(String),
    /// This daemon does not serve that route — which is also how a client
    /// distinguishes an older daemon from a broken request.
    Unknown,
}

impl DaemonRequestOutcome {
    fn into_response(self) -> (&'static str, String) {
        match self {
            Self::Served(body) => ("200 OK", body),
            Self::Invalid(message) => {
                ("400 Bad Request", daemon_request_error_body(&message, None))
            }
            Self::Failed(message) => (
                "500 Internal Server Error",
                daemon_request_error_body(&message, None),
            ),
            Self::Unknown => (
                "404 Not Found",
                daemon_request_error_body("not found", None),
            ),
        }
    }
}

#[cfg(test)]
mod daemon_request_outcome_tests {
    use super::DaemonRequestOutcome::{Failed, Invalid, Served, Unknown};

    #[test]
    fn a_failure_never_leaves_the_broker_wearing_a_success_status() {
        assert_eq!(Served("{}".into()).into_response(), ("200 OK", "{}".into()));
        assert_eq!(
            Invalid("invalid run payload: x".into()).into_response(),
            (
                "400 Bad Request",
                r#"{"error":"invalid run payload: x"}"#.into(),
            ),
        );
        assert_eq!(
            Failed("run refused".into()).into_response(),
            (
                "500 Internal Server Error",
                r#"{"error":"run refused"}"#.into(),
            ),
        );
    }

    #[test]
    fn an_unserved_route_answers_404_so_a_client_can_tell_it_is_too_old() {
        let (status, body) = Unknown.into_response();
        assert_eq!(status, "404 Not Found");
        // The body is unchanged from what every released daemon sends, so an
        // older client reading only the body still sees what it expects.
        assert_eq!(body, r#"{"error":"not found"}"#);
    }

    #[test]
    fn unauthorized_detail_separates_malformed_from_never_granted() {
        use super::{DaemonLocalHttpRequest, daemon_request_unauthorized_detail};
        use std::collections::HashMap;

        let missing = DaemonLocalHttpRequest {
            method: "POST".into(),
            path: "/request/hub-json".into(),
            query: HashMap::new(),
            headers: HashMap::new(),
            body: Vec::new(),
        };
        assert_eq!(
            daemon_request_unauthorized_detail(&missing),
            ("unauthorized", None),
        );

        let malformed = DaemonLocalHttpRequest {
            method: "POST".into(),
            path: "/request/hub-json".into(),
            query: HashMap::new(),
            headers: HashMap::from([(
                "x-xmatrix-request-capability".into(),
                "sha256:not-hex".into(),
            )]),
            body: Vec::new(),
        };
        assert_eq!(
            daemon_request_unauthorized_detail(&malformed),
            (
                "unauthorized: malformed request capability",
                Some("capability_malformed"),
            ),
            "caller's bad format must not look like a post-update grant miss",
        );

        let never_granted = DaemonLocalHttpRequest {
            method: "POST".into(),
            path: "/request/hub-json".into(),
            query: HashMap::new(),
            headers: HashMap::from([(
                "x-xmatrix-request-capability".into(),
                "spawn-time-raw-capability-that-diverged".into(),
            )]),
            body: Vec::new(),
        };
        assert_eq!(
            daemon_request_unauthorized_detail(&never_granted),
            (
                "unauthorized: capability not granted by this daemon (stale after update?)",
                Some("capability_not_granted"),
            ),
            "a well-formed proof this daemon never issued must name that cause",
        );
    }
}

async fn write_daemon_request_error<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    stream: &mut S,
    status: &str,
    message: &str,
) {
    write_daemon_request_error_with_reason(stream, status, message, None).await;
}

async fn write_daemon_request_error_with_reason<
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
>(
    stream: &mut S,
    status: &str,
    message: &str,
    reason: Option<&str>,
) {
    write_daemon_auth_broker_response(stream, status, &daemon_request_error_body(message, reason))
        .await;
}

fn daemon_request_error_body(message: &str, reason: Option<&str>) -> String {
    match reason {
        Some(reason) => serde_json::json!({ "error": message, "reason": reason }).to_string(),
        None => serde_json::json!({ "error": message }).to_string(),
    }
}
