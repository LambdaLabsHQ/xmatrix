use std::io::{BufRead, Read, Write};
use std::net::TcpListener;

use serde_json::{Value, json};

#[path = "../../core/tests/support/http_fixture.rs"]
mod http_fixture;

// The CLI upload contract is separate from the Hub's ACL owner test: the CLI
// must send the real bytes, bind the Page ref, and print usable Markdown.
#[tokio::test]
async fn local_upload_sends_bytes_and_returns_markdown_only_after_binding() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let path = std::env::temp_dir().join(format!("page-upload-{}.JPEG", std::process::id()));
    std::fs::write(&path, b"local screenshot").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let hub = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let mut hash = String::new();
        let mut upload_path = String::new();
        for step in 0..4 {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut input = std::io::BufReader::new(&mut socket);
            let mut headers = String::new();
            loop {
                let mut line = String::new();
                input.read_line(&mut line).unwrap();
                let end = line == "\r\n";
                headers.push_str(&line);
                if end {
                    break;
                }
            }
            let length = http_fixture::content_length(&headers).unwrap_or(0);
            let mut bytes = vec![0; length];
            input.read_exact(&mut bytes).unwrap();
            assert!(
                headers
                    .to_ascii_lowercase()
                    .contains("authorization: bearer test-upload-token")
            );
            let response = match step {
                0 => {
                    assert!(headers.starts_with("GET /api/spaces/s/pages/p "));
                    json!({"page": {"canEdit": true}})
                }
                1 => {
                    assert!(headers.starts_with("POST /api/relay-v2/private-r2/upload-intents "));
                    let body: Value = serde_json::from_slice(&bytes).unwrap();
                    assert_eq!(body["visibilityScopeId"], "space:s");
                    assert_eq!(body["encodedSize"], 16);
                    // Capture the wire hash; the final Markdown is checked against a known digest.
                    hash = body["contentHash"].as_str().unwrap().to_string();
                    upload_path = format!(
                        "/api/relay-v2/private-r2/uploads/{}/scope/space%3As",
                        body["intentId"].as_str().unwrap()
                    );
                    json!({"upload": {"finalPath": upload_path}})
                }
                2 => {
                    assert!(headers.starts_with(&format!("PUT {upload_path} ")));
                    assert_eq!(bytes, b"local screenshot");
                    assert!(headers.contains("image/jpeg"));
                    json!({"verified": true})
                }
                _ => {
                    assert!(headers.starts_with("POST /api/relay-v2/private-r2/blob-refs "));
                    let body: Value = serde_json::from_slice(&bytes).unwrap();
                    assert_eq!(body["ownerKind"], "page_media");
                    assert_eq!(body["ownerId"], "p");
                    assert_eq!(body["visibilityScopeId"], "space:s");
                    assert_eq!(body["refId"], format!("page-media:p:{hash}"));
                    json!({"refId": body["refId"]})
                }
            }
            .to_string();
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
        }
    });
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        super::upload(&hub, "test-upload-token", "s", "p", &path),
    )
    .await
    .unwrap();
    std::fs::remove_file(path).unwrap();
    server.join().unwrap();
    assert_eq!(
        result.unwrap(),
        "![media](xmatrix:page-media/1c613d430fa27ec04a40e86427e258618595083ee33bdfa037cca49d30d447bc.jpg)"
    );
}

#[tokio::test]
async fn unsupported_empty_and_oversized_files_are_refused_before_network_io() {
    let base = std::env::temp_dir().join(format!("page-upload-limits-{}", std::process::id()));
    for (extension, size) in [("svg", 16), ("png", 0), ("mp4", 25 * 1024 * 1024 + 1)] {
        let path = base.with_extension(extension);
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(size).unwrap();
        let result = super::upload("http://127.0.0.1:1", "test", "s", "p", &path).await;
        std::fs::remove_file(path).unwrap();
        assert!(matches!(
            result,
            Err(xmatrix_cli_core::error::CliError::Launch(_))
        ));
    }
}
