pub(crate) fn accept_before(
    listener: &std::net::TcpListener,
    timeout: std::time::Duration,
    failure: &str,
) -> std::net::TcpStream {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match listener.accept() {
            Ok((stream, _)) => return stream,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Err(error) => panic!("{failure}: {error}"),
        }
    }
}
