use std::io::Write;
use std::net::TcpListener;

use serde_json::{Value, json};

#[path = "../tests/support/http_fixture.rs"]
mod http_fixture;

fn respond(socket: &mut std::net::TcpStream, body: Value) {
    let body = body.to_string();
    write!(
        socket,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
}

// A file larger than the Hub's request size goes in parts read from disk:
// the upload resumes after the parts the Hub already holds, sends a part again
// on its own when its connection drops, and publishes before binding the ref.
#[tokio::test]
async fn a_file_larger_than_one_request_resumes_in_parts_and_retries_a_dropped_part() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let content: Vec<u8> = (0u8..20).collect();
    let path = std::env::temp_dir().join(format!("private-upload-parts-{}", std::process::id()));
    std::fs::write(&path, &content).unwrap();
    let (hash, size) = super::sha256_file(&path).unwrap();
    assert_eq!(size, 20);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let hub = format!("http://{}", listener.local_addr().unwrap());
    let expected = content.clone();
    let server = std::thread::spawn(move || {
        let mut base = String::new();
        let scope = "/scope/space%3As";
        for step in 0..7 {
            let (mut socket, _) = listener.accept().unwrap();
            let (headers, body) = http_fixture::read_request(&mut socket);
            let line = headers.lines().next().unwrap().to_string();
            match step {
                0 => {
                    assert!(line.starts_with("POST /api/relay-v2/private-r2/upload-intents "));
                    let intent: Value = serde_json::from_slice(&body).unwrap();
                    assert_eq!(intent["encodedSize"], 20);
                    base = format!(
                        "/api/relay-v2/private-r2/uploads/{}",
                        intent["intentId"].as_str().unwrap()
                    );
                    respond(
                        &mut socket,
                        json!({"upload": {"finalPath": format!("{base}{scope}"), "partBytes": 8}}),
                    );
                }
                1 => {
                    assert!(line.starts_with(&format!("POST {base}/multipart{scope} ")));
                    respond(
                        &mut socket,
                        json!({"partBytes": 8, "partCount": 3, "uploadedParts": 1, "complete": false}),
                    );
                }
                // The first send of part 2 loses its connection before any answer.
                2 => assert!(line.starts_with(&format!("PUT {base}/multipart/parts/2{scope} "))),
                3 => {
                    assert!(line.starts_with(&format!("PUT {base}/multipart/parts/2{scope} ")));
                    assert_eq!(body, expected[8..16]);
                    respond(&mut socket, json!({"uploadedParts": 2}));
                }
                4 => {
                    assert!(line.starts_with(&format!("PUT {base}/multipart/parts/3{scope} ")));
                    assert_eq!(body, expected[16..20]);
                    respond(&mut socket, json!({"uploadedParts": 3}));
                }
                5 => {
                    assert!(line.starts_with(&format!("POST {base}/multipart/complete{scope} ")));
                    respond(&mut socket, json!({"disposition": "created"}));
                }
                _ => {
                    assert!(line.starts_with("POST /api/relay-v2/private-r2/blob-refs "));
                    respond(&mut socket, json!({"refId": "ref-held"}));
                }
            }
        }
    });
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        super::upload(
            &hub,
            "test-upload-token",
            super::PrivateFile {
                scope: "space:s",
                owner_kind: "message_attachment",
                owner_id: "message",
                ref_id: "ref-requested",
                content_hash: &hash,
                mime_type: "audio/flac",
                path: &path,
                size,
            },
        ),
    )
    .await
    .unwrap();
    std::fs::remove_file(&path).unwrap();
    server.join().unwrap();
    assert_eq!(result.unwrap(), "ref-held");
}
