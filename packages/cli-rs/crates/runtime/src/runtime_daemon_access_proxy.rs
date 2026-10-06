// Agent-facing Cloudflare Access proxy routes. These stay in the daemon so
// Access credentials never enter a sandboxed runtime process.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonHubProductMediaRequest {
    url: String,
    token: String,
    expected_size: u64,
    body: Value,
}

fn validate_daemon_hub_product_media_request(
    hub_url: &str,
    context: &DaemonRequestAgentContext,
    payload: &DaemonHubProductMediaRequest,
) -> Result<(), String> {
    let configured = reqwest::Url::parse(hub_url).map_err(|_| "invalid daemon Hub URL")?;
    let requested = reqwest::Url::parse(&payload.url).map_err(|_| "invalid Hub media URL")?;
    if !same_bare_hub_origin(&configured, &requested)
        || requested.path() != HubRoutes::MESSAGE_ATTACHMENT_PRODUCT_MEDIA
    {
        return Err("Hub media target is outside the allowed Agent route".into());
    }
    if payload.token.trim().is_empty() {
        return Err("Hub media request is missing the run-scoped token".into());
    }
    if payload.expected_size == 0 || payload.expected_size > 25 * 1024 * 1024 {
        return Err("Hub media request exceeds the Agent broker size limit".into());
    }
    if payload.body.get("channelId").and_then(Value::as_str) != Some(context.channel_id.as_str()) {
        return Err("Hub media request is outside the Agent channel binding".into());
    }
    for key in ["messageId", "attachmentId"] {
        if payload
            .body
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .is_none_or(str::is_empty)
        {
            return Err(format!("Hub media request has an invalid {key}"));
        }
    }
    Ok(())
}

async fn write_daemon_product_media_response<
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
>(
    stream: &mut S,
    content_type: &str,
    body: &[u8],
) {
    let header = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncache-control: no-store\r\nx-content-type-options: nosniff\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    if stream.write_all(header.as_bytes()).await.is_ok() {
        let _ = stream.write_all(body).await;
        let _ = stream.flush().await;
    }
}

async fn handle_daemon_hub_product_media_request<
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
>(
    stream: &mut S,
    broker: &DaemonRequestBroker,
    request: &DaemonLocalHttpRequest,
    request_body: &str,
) {
    let Some(context) = daemon_request_agent_context(broker, request) else {
        return write_daemon_request_error(stream, "401 Unauthorized", "unauthorized").await;
    };
    let Some(hub_url) = broker.hub_url.as_deref() else {
        return write_daemon_request_error(
            stream,
            "503 Service Unavailable",
            "hub url unavailable",
        )
        .await;
    };
    let payload = match serde_json::from_str::<DaemonHubProductMediaRequest>(request_body) {
        Ok(payload) => payload,
        Err(err) => {
            return write_daemon_request_error(
                stream,
                "400 Bad Request",
                &format!("invalid Hub media request: {err}"),
            )
            .await;
        }
    };
    if let Err(err) = validate_daemon_hub_product_media_request(hub_url, &context, &payload) {
        return write_daemon_request_error(stream, "403 Forbidden", &err).await;
    }
    let client = match http::client() {
        Ok(client) => client,
        Err(err) => {
            return write_daemon_request_error(stream, "502 Bad Gateway", &err.to_string()).await;
        }
    };
    let request = client
        .post(&payload.url)
        .bearer_auth(&payload.token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .json(&payload.body);
    let request = match http::with_access_header(request, &payload.url) {
        Ok(request) => request,
        Err(err) => {
            return write_daemon_request_error(stream, "401 Unauthorized", &err.to_string()).await;
        }
    };
    let response = match request.send().await {
        Ok(response) => response,
        Err(err) => {
            return write_daemon_request_error(
                stream,
                "502 Bad Gateway",
                &format!("Hub media request failed: {err}"),
            )
            .await;
        }
    };
    let status = response.status();
    if !status.is_success() {
        let status_line = match status.as_u16() {
            401 => "401 Unauthorized",
            403 => "403 Forbidden",
            426 => "426 Upgrade Required",
            _ => "502 Bad Gateway",
        };
        let detail = if xmatrix_cli_core::access::requires_access(&payload.url)
            && matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308 | 401 | 403)
        {
            xmatrix_cli_core::access::access_denial_message(status.as_u16())
        } else {
            format!("Hub media request failed with {status}")
        };
        return write_daemon_request_error(stream, status_line, &detail).await;
    }
    if response.content_length() != Some(payload.expected_size) {
        return write_daemon_request_error(
            stream,
            "502 Bad Gateway",
            "Hub media Content-Length does not match authority",
        )
        .await;
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(err) => {
            return write_daemon_request_error(
                stream,
                "502 Bad Gateway",
                &format!("Hub media body failed: {err}"),
            )
            .await;
        }
    };
    if bytes.len() as u64 != payload.expected_size {
        return write_daemon_request_error(
            stream,
            "502 Bad Gateway",
            "Hub media length does not match authority",
        )
        .await;
    }
    write_daemon_product_media_response(stream, &content_type, &bytes).await;
}

fn same_bare_hub_origin(configured: &reqwest::Url, requested: &reqwest::Url) -> bool {
    requested.origin() == configured.origin()
        && requested.username().is_empty()
        && requested.password().is_none()
        && requested.query().is_none()
        && requested.fragment().is_none()
}
