/// One request read from a fixture socket: its request line and headers, and its body.
#[allow(dead_code)]
pub(crate) fn read_request(socket: &mut std::net::TcpStream) -> (String, Vec<u8>) {
    use std::io::{BufRead, Read};
    socket
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .unwrap();
    let mut input = std::io::BufReader::new(socket);
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
    let mut body = vec![0; content_length(&headers).unwrap_or(0)];
    input.read_exact(&mut body).unwrap();
    (headers, body)
}

/// Parse the first case-insensitive Content-Length; each fixture chooses its absent-header policy.
pub(crate) fn content_length(headers: &str) -> Option<usize> {
    headers.lines().find_map(|line| {
        line.to_ascii_lowercase()
            .strip_prefix("content-length:")
            .and_then(|value| value.trim().parse::<usize>().ok())
    })
}
