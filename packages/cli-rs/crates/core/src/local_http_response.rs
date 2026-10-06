//! The local daemons send bounded JSON responses with an explicit byte length.
//! A complete response does not depend on a later TCP FIN arriving cleanly.
use crate::error::{CliError, Result};
use tokio::io::{AsyncRead, AsyncReadExt as _};

pub async fn read_local_http_response(
    reader: &mut (impl AsyncRead + Unpin),
) -> Result<(u16, Vec<u8>)> {
    let mut bytes = Vec::new();
    let (status, body_start, content_length) = loop {
        if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            if end > 16 * 1024 {
                return Err(invalid());
            }
            let headers = std::str::from_utf8(&bytes[..end]).map_err(|_| invalid())?;
            let mut lines = headers.split("\r\n");
            let mut status = lines.next().ok_or_else(invalid)?.split_whitespace();
            if !matches!(status.next(), Some("HTTP/1.1" | "HTTP/1.0")) {
                return Err(invalid());
            }
            let code = status.next().ok_or_else(invalid)?;
            if code.len() != 3 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(invalid());
            }
            let code: u16 = code.parse().map_err(|_| invalid())?;
            let mut length = None;
            for line in lines {
                let (key, value) = line.split_once(':').ok_or_else(invalid)?;
                if key.eq_ignore_ascii_case("transfer-encoding") {
                    return Err(invalid());
                }
                if key.eq_ignore_ascii_case("content-length") {
                    let value = value.trim();
                    if length.is_some()
                        || value.is_empty()
                        || !value.bytes().all(|byte| byte.is_ascii_digit())
                    {
                        return Err(invalid());
                    }
                    let parsed: usize = value.parse().map_err(|_| invalid())?;
                    if parsed > 64 * 1024 {
                        return Err(invalid());
                    }
                    length = Some(parsed);
                }
            }
            break (code, end + 4, length.ok_or_else(invalid)?);
        }
        if bytes.len() > 16 * 1024 {
            return Err(invalid());
        }
        let mut chunk = [0_u8; 1024];
        let count = reader.read(&mut chunk).await?;
        if count == 0 {
            return Err(invalid());
        }
        bytes.extend_from_slice(&chunk[..count]);
    };
    while bytes.len() < body_start + content_length {
        let remaining = body_start + content_length - bytes.len();
        let mut chunk = [0_u8; 4096];
        let count = reader.read(&mut chunk[..remaining.min(4096)]).await?;
        if count == 0 {
            return Err(invalid());
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    Ok((
        status,
        bytes[body_start..body_start + content_length].to_vec(),
    ))
}

fn invalid() -> CliError {
    CliError::Auth("Local daemon HTTP response has invalid or incomplete framing".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt as _;

    #[tokio::test]
    async fn complete_json_returns_without_waiting_for_connection_close() {
        let (mut client, mut server) = tokio::io::duplex(1024);
        server
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
            .await
            .unwrap();
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            read_local_http_response(&mut client),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response, (200, b"{}".to_vec()));
        drop(server);
    }

    #[tokio::test]
    async fn ambiguous_oversized_and_truncated_responses_fail_closed() {
        for raw in [
            "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 2\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\nContent-Length: 65537\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\n\r\n{}",
        ] {
            assert!(read_local_http_response(&mut raw.as_bytes()).await.is_err());
        }
        let response = read_local_http_response(
            &mut b"HTTP/1.1 403 reason 200 OK\r\nContent-Length: 2\r\n\r\n{}".as_slice(),
        )
        .await
        .unwrap();
        assert_eq!(response.0, 403);
    }
}
