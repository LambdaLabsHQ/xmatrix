pub(crate) async fn accept_single_request(
    listener: &tokio::net::TcpListener,
) -> (tokio::net::TcpStream, String) {
    use tokio::io::AsyncReadExt;
    let (mut stream, _) = listener.accept().await.unwrap();
    let mut request = vec![0_u8; 4096];
    let read = stream.read(&mut request).await.unwrap();
    let request = String::from_utf8_lossy(&request[..read]).to_string();
    (stream, request)
}

pub(crate) async fn spawn_single_request_server<F>(
    handler: impl FnOnce(tokio::net::TcpStream, String) -> F + Send + 'static,
) -> (std::net::SocketAddr, tokio::task::JoinHandle<F::Output>)
where
    F: std::future::Future + Send + 'static,
    F::Output: Send + 'static,
{
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (stream, request) = accept_single_request(&listener).await;
        handler(stream, request).await
    });
    (address, server)
}
