use std::io::Write;
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
            let (headers, bytes) = http_fixture::read_request(&mut socket);
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
async fn unsupported_and_empty_files_are_refused_before_network_io() {
    let base = std::env::temp_dir().join(format!("page-upload-limits-{}", std::process::id()));
    for (extension, size) in [("svg", 16), ("png", 0)] {
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

#[tokio::test]
async fn page_text_for_agent_downloads_images_concurrently() {
    use std::sync::{Arc, Barrier};
    use xmatrix_cli_core::hex::sha256_hex;

    let _ = rustls::crypto::ring::default_provider().install_default();
    let img_a = b"page-image-alpha";
    let img_b = b"page-image-bravo";
    let file_a = format!("{}.png", sha256_hex(img_a));
    let file_b = format!("{}.png", sha256_hex(img_b));
    let body = format!(
        "![a](xmatrix:page-media/{file_a})\n![b](xmatrix:page-media/{file_b})\n"
    );

    let cache_root = std::env::temp_dir().join(format!(
        "xmatrix-page-media-parallel-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&cache_root);
    let previous_config = std::env::var_os("XMATRIX_CONFIG_DIR");
    unsafe {
        std::env::set_var("XMATRIX_CONFIG_DIR", &cache_root);
    }

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let hub = format!("http://{}", listener.local_addr().unwrap());
    let barrier = Arc::new(Barrier::new(2));
    let expected_a = format!("GET /api/spaces/s/pages/p/media/{file_a} ");
    let expected_b = format!("GET /api/spaces/s/pages/p/media/{file_b} ");
    let server = std::thread::spawn(move || {
        let mut workers = Vec::new();
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().unwrap();
            let barrier = Arc::clone(&barrier);
            let expected_a = expected_a.clone();
            let expected_b = expected_b.clone();
            workers.push(std::thread::spawn(move || {
                let (headers, _) = http_fixture::read_request(&mut socket);
                let payload = if headers.starts_with(&expected_a) {
                    img_a.as_slice()
                } else if headers.starts_with(&expected_b) {
                    img_b.as_slice()
                } else {
                    panic!("unexpected page media request: {headers}");
                };
                barrier.wait();
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    payload.len()
                )
                .unwrap();
                socket.write_all(payload).unwrap();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
    });

    let rendered = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        crate::page::page_text_for_agent(&hub, "test-page-token", "s", "p", &body),
    )
    .await
    .expect("concurrent page image downloads must not deadlock on the 2-way barrier");
    server.join().unwrap();

    let expected_path_a = cache_root
        .join("attachment-cache")
        .join("page-media")
        .join(&file_a);
    let expected_path_b = cache_root
        .join("attachment-cache")
        .join("page-media")
        .join(&file_b);
    assert!(rendered.contains(&expected_path_a.display().to_string()), "{rendered}");
    assert!(rendered.contains(&expected_path_b.display().to_string()), "{rendered}");
    assert_eq!(std::fs::read(&expected_path_a).unwrap(), img_a);
    assert_eq!(std::fs::read(&expected_path_b).unwrap(), img_b);

    unsafe {
        match previous_config {
            Some(value) => std::env::set_var("XMATRIX_CONFIG_DIR", value),
            None => std::env::remove_var("XMATRIX_CONFIG_DIR"),
        }
    }
    let _ = std::fs::remove_dir_all(&cache_root);
}
