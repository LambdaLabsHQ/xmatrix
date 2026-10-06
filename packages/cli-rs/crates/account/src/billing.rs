//! Presentation-only billing. Hub remains the authorization boundary.
use std::time::Duration;
use xmatrix_cli_core::{
    error::{CliError, Result},
    http, protocol,
};

pub enum Query {
    SpaceStatus(String),
}

impl Query {
    fn path(&self) -> Result<String> {
        match self {
            Self::SpaceStatus(space) if !space.trim().is_empty() => Ok(format!(
                "/api/spaces/{}/billing",
                urlencoding::encode(space)
            )),
            Self::SpaceStatus(_) => Err(CliError::Auth("Space ID must not be empty".into())),
        }
    }
}

pub async fn query(hub: &str, token: &str, query: Query, json: bool) -> Result<()> {
    let url = protocol::with_route(hub, &query.path()?);
    let value: serde_json::Value = tokio::time::timeout(
        Duration::from_secs(30),
        http::request_json(&url, "GET", Some(token), None),
    )
    .await
    .map_err(|_| CliError::Http("Billing request timed out".into()))??;
    if !json {
        match query {
            Query::SpaceStatus(space) => println!("Space Pro billing — {space} — {hub}"),
        }
    }
    println!(
        "{}",
        if json {
            serde_json::to_string(&value)?
        } else {
            serde_json::to_string_pretty(&value)?
        }
    );
    Ok(())
}

pub fn page_url(hub: &str) -> Result<&'static str> {
    match hub.trim_end_matches('/') {
        protocol::DEFAULT_HUB_URL => Ok("https://xmatrix.sh/billing"),
        protocol::TEST_HUB_URL => Ok("https://test.xmatrix.sh/billing"),
        _ => Err(CliError::Auth(
            "Custom Hub: open your deployment's billing page manually".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    mod http_sync_fixture {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../core/tests/support/http_sync_fixture.rs"
        ));
    }

    use super::*;

    async fn serve_once(status: &str, body: &str, request: Query) -> Result<()> {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let hub = format!("http://{}", listener.local_addr().unwrap());
        let expected_path = request.path().unwrap();
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let server = std::thread::spawn(move || {
            let mut stream = http_sync_fixture::accept_before(
                &listener,
                Duration::from_secs(5),
                "Mock request not received",
            );
            // Windows may inherit the listener's nonblocking mode on accept.
            // The bounded accept loop is nonblocking; header reads are blocking.
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
                assert!(bytes.len() < 16384);
            }
            let headers = String::from_utf8(bytes).unwrap().to_lowercase();
            assert!(headers.starts_with(&format!("get {expected_path} http/1.1\r\n")));
            assert!(headers.contains("authorization: bearer billing-test-token\r\n"));
            stream.write_all(response.as_bytes()).unwrap();
        });
        let result = query(&hub, "billing-test-token", request, true).await;
        server.join().unwrap();
        result
    }

    #[tokio::test]
    async fn queries_use_authenticated_get_and_preserve_failures() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        serve_once(
            "200 OK",
            r#"{"ok":true}"#,
            Query::SpaceStatus("space-1".into()),
        )
        .await
        .unwrap();
        for status in [
            "401 Unauthorized",
            "403 Forbidden",
            "500 Internal Server Error",
        ] {
            assert!(
                serve_once(
                    status,
                    r#"{"error":"billing unavailable"}"#,
                    Query::SpaceStatus("space-1".into())
                )
                .await
                .is_err()
            );
        }
        assert!(
            serve_once("200 OK", "not json", Query::SpaceStatus("space-1".into()))
                .await
                .is_err()
        );
    }

    #[test]
    fn space_queries_are_bounded() {
        assert!(Query::SpaceStatus(" ".into()).path().is_err());
        assert_eq!(
            Query::SpaceStatus("a/b?c".into()).path().unwrap(),
            "/api/spaces/a%2Fb%3Fc/billing"
        );
    }

    #[test]
    fn billing_pages_do_not_cross_environments_or_create_checkout() {
        assert_eq!(
            page_url(protocol::DEFAULT_HUB_URL).unwrap(),
            "https://xmatrix.sh/billing"
        );
        assert_eq!(
            page_url(protocol::TEST_HUB_URL).unwrap(),
            "https://test.xmatrix.sh/billing"
        );
        assert!(page_url("https://example.com").is_err());
    }
}
