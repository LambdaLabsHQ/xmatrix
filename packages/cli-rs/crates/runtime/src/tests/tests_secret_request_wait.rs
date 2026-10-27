/// A fake Hub that records each request's bearer token and answers secret
/// requests: the card is posted, the first read finds it still unanswered,
/// the next one finds the value.
async fn serve_secret_hub(
    listener: tokio::net::TcpListener,
    seen: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut reads = 0;
    loop {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let read = stream.read(&mut chunk).await.unwrap();
            request.extend_from_slice(&chunk[..read]);
            let text = String::from_utf8_lossy(&request);
            if let Some(head_end) = text.find("\r\n\r\n") {
                let length = text[..head_end]
                    .lines()
                    .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|value| value.trim().parse::<usize>().unwrap()))
                    .unwrap_or(0);
                if request.len() >= head_end + 4 + length || read == 0 {
                    break;
                }
            }
        }
        let text = String::from_utf8_lossy(&request).to_string();
        let token = text
            .lines()
            .find_map(|line| line.strip_prefix("authorization: Bearer ").or_else(|| line.strip_prefix("Authorization: Bearer ")))
            .unwrap_or("")
            .to_string();
        seen.lock().unwrap().push(token);
        let (status, body) = if text.starts_with("POST /api/secret-requests") {
            ("200 OK", r#"{"readable":false,"request":{"id":"card"}}"#.to_string())
        } else {
            reads += 1;
            if reads == 1 {
                ("404 Not Found", r#"{"error":"Secret 'deploy-key' is not saved"}"#.to_string())
            } else {
                ("200 OK", r#"{"secrets":[{"secretRef":"deploy-key","envName":"DEPLOY_KEY","value":"v"}]}"#.to_string())
            }
        };
        let response = format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
    }
}

/// A Run auth broker that issues a new token per request, or refuses every
/// request from `revoke_after` on.
async fn serve_rotating_auth_broker(listener: tokio::net::TcpListener, revoke_after: usize) {
    for issued in 1..=usize::MAX {
        let (mut stream, _) = listener.accept().await.unwrap();
        let _ = super::read_daemon_local_http_request(&mut stream).await;
        if issued > revoke_after {
            super::write_daemon_auth_broker_response(&mut stream, "401 Unauthorized", r#"{"error":"unauthorized"}"#).await;
        } else {
            let body = format!(r#"{{"token":"RUN_TOKEN_{issued}"}}"#);
            super::write_daemon_auth_broker_response(&mut stream, "200 OK", &body).await;
        }
    }
}

/// Sets the env of an Agent Run whose broker is at `auth`; restores on drop.
struct SecretWaitEnv {
    previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
    root: std::path::PathBuf,
}

impl SecretWaitEnv {
    fn new(auth: std::net::SocketAddr) -> Self {
        let root = std::env::temp_dir().join(format!("xmatrix-secret-wait-{}", uuid::Uuid::new_v4()));
        let values = [
            ("XMATRIX_CONFIG_DIR", Some(root.display().to_string())),
            ("XMATRIX_DAEMON_AUTH_URL", Some(format!("http://{auth}"))),
            ("XMATRIX_DAEMON_AUTH_CAPABILITY", Some("run-auth-capability".to_string())),
            ("XMATRIX_AGENT_SESSION", Some("1".to_string())),
        ];
        let previous = values.iter().map(|(key, _)| (*key, std::env::var_os(key))).collect();
        for (key, value) in values {
            unsafe { std::env::set_var(key, value.unwrap()) };
        }
        Self { previous, root }
    }
}

impl Drop for SecretWaitEnv {
    fn drop(&mut self) {
        for (key, value) in self.previous.drain(..) {
            match value {
                Some(value) => unsafe { std::env::set_var(key, value) },
                None => unsafe { std::env::remove_var(key) },
            }
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn deploy_key_request() -> super::SecretAddRequest {
    super::SecretAddRequest {
        secret_ref: "deploy-key".into(),
        env_name: None,
        reason: None,
        description: None,
    }
}

/// Runs `request_secret_and_wait` for `deploy-key` against a fake Hub and a
/// broker that revokes the Run after `revoke_after` tokens; returns its result
/// and the token every Hub request carried.
fn wait_for_deploy_key(revoke_after: usize) -> (crate::error::Result<Option<String>>, Vec<String>) {
    let _guard = test_process_env_lock();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let hub = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let auth = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let hub_url = format!("http://{}", hub.local_addr().unwrap());
        let _env = SecretWaitEnv::new(auth.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        tokio::spawn(serve_secret_hub(hub, seen.clone()));
        tokio::spawn(serve_rotating_auth_broker(auth, revoke_after));
        let auth = super::HubAuth { hub_url: &hub_url, cli_token: None };
        let result = super::request_secret_and_wait(&auth, &deploy_key_request(), true).await;
        let seen = seen.lock().unwrap().clone();
        (result, seen)
    })
}

#[test]
fn waiting_for_a_secret_card_asks_the_run_broker_for_its_credential_each_time() {
    let (result, seen) = wait_for_deploy_key(usize::MAX);
    assert_eq!(result.unwrap().as_deref(), Some("DEPLOY_KEY"));
    // The card, the unanswered read and the answered read each carried the
    // token the broker issued at that moment, not the one from the start.
    assert_eq!(seen, ["RUN_TOKEN_1", "RUN_TOKEN_2", "RUN_TOKEN_3"]);
}

#[test]
fn a_run_revoked_while_its_card_waits_reads_nothing_and_never_uses_the_persons_session() {
    let (result, seen) = wait_for_deploy_key(2);
    let error = result.expect_err("a revoked Run reads no secret");
    assert!(error.to_string().contains("refusing to authenticate"), "{error}");
    assert_eq!(seen, ["RUN_TOKEN_1", "RUN_TOKEN_2"], "nothing reached the Hub after the revocation");
}
