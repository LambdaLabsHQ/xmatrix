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

/// Accept `count` simultaneous HTTP requests, synchronize all of them on a
/// barrier so serial callers time out, and reply with each handler's bytes.
#[allow(dead_code)]
pub(crate) fn spawn_barrier_server<F>(
    count: usize,
    content_type: &'static str,
    respond: F,
) -> (String, std::thread::JoinHandle<()>)
where
    F: Fn(&str, &[u8]) -> Vec<u8> + Send + Sync + 'static,
{
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::{Arc, Barrier};

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let barrier = Arc::new(Barrier::new(count));
    let respond = Arc::new(respond);
    let handle = std::thread::spawn(move || {
        let mut workers = Vec::with_capacity(count);
        for _ in 0..count {
            let (mut socket, _) = listener.accept().unwrap();
            let barrier = Arc::clone(&barrier);
            let respond = Arc::clone(&respond);
            workers.push(std::thread::spawn(move || {
                let (headers, body) = read_request(&mut socket);
                let payload = respond(&headers, &body);
                barrier.wait();
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    payload.len()
                )
                .unwrap();
                socket.write_all(&payload).unwrap();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
    });
    (base_url, handle)
}
