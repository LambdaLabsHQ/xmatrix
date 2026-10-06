pub(crate) async fn registered_agent_socket(
    listener: &tokio::net::TcpListener,
    connected: impl serde::Serialize,
) -> tokio_tungstenite::WebSocketStream<tokio::net::TcpStream> {
    use futures_util::{SinkExt, StreamExt};
    let (stream, _) = listener.accept().await.unwrap();
    let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
    let _connect = socket.next().await;
    let connected = serde_json::to_string(&connected).unwrap();
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            connected.into(),
        ))
        .await
        .unwrap();
    socket
}
