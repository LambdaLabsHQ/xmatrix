//! A bounded, acknowledged assistant stream. The Hub owns its product meaning.
use std::collections::{BTreeSet, HashMap};
use std::sync::{
    Arc, LazyLock, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use xmatrix_cli_core::agent_instance_connection::{
    AgentInstanceConnectionClient, AgentInstanceConnectionEvent,
};
use xmatrix_cli_core::error::CliError;
use xmatrix_cli_core::page_assistant_output::{
    AssistantOutput, CAPABILITY, MAX_TEXT_BYTES, OutputStatus, chunks,
};
use xmatrix_cli_core::page_co_write::{PageCoWriteConnector, PageCoWriteEvent};
use xmatrix_cli_core::page_media::PageReferences;

// Transport limits, not product timing. At most one MiB waits for a Hub receipt.
const QUEUE_FRAMES: usize = 4096;
const QUEUE_BYTES: usize = 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const RETRY_WITHIN: Duration = Duration::from_secs(120);

struct Stream {
    id: String,
    started_at: i64,
    cancelled: AtomicBool,
}
struct Piece {
    stream: Arc<Stream>,
    text: Option<String>,
}
struct Forwarder {
    enabled: bool,
    active: Option<Arc<Stream>>,
    sender: mpsc::Sender<Piece>,
    media: PageReferences,
    bytes: Arc<AtomicUsize>,
}

impl Forwarder {
    fn enqueue(&self, stream: Arc<Stream>, text: Option<String>) -> bool {
        let size = text.as_ref().map_or(0, String::len);
        if self
            .bytes
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |bytes| {
                (bytes + size <= QUEUE_BYTES).then_some(bytes + size)
            })
            .is_err()
        {
            return false;
        }
        if self.sender.try_send(Piece { stream, text }).is_err() {
            self.bytes.fetch_sub(size, Ordering::Relaxed);
            return false;
        }
        true
    }
}
static FORWARDERS: LazyLock<Mutex<HashMap<String, Forwarder>>> = LazyLock::new(Default::default);

pub(crate) fn enabled(channel: &str) -> bool {
    FORWARDERS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(channel)
        .is_some_and(|f| f.enabled)
}

/// Returns true when this Run selected Hub interpretation. Never switch a live
/// Run back to the legacy parser after an output or transport error.
pub(crate) fn observe(
    relay: &AgentInstanceConnectionClient,
    channel: &str,
    phase: &str,
    payload: &serde_json::Value,
) -> bool {
    if crate::runtime_page_co_write::answering(channel) {
        return false;
    }
    let mut all = FORWARDERS.lock().unwrap_or_else(|p| p.into_inner());
    let forwarder = all.entry(channel.to_owned()).or_insert_with(|| {
        let enabled = relay.hub_accepts(CAPABILITY);
        let (sender, receiver) = mpsc::channel(QUEUE_FRAMES);
        let bytes = Arc::new(AtomicUsize::new(0));
        if enabled {
            tokio::spawn(forward(
                relay.page_co_write_connector(),
                channel.to_owned(),
                receiver,
                relay.local_event_sender(),
                bytes.clone(),
            ));
        }
        Forwarder {
            enabled,
            active: None,
            sender,
            media: PageReferences::default(),
            bytes,
        }
    });
    if !forwarder.enabled {
        return false;
    }
    if phase == "assistant_delta" {
        if let Some(text) = payload
            .get("delta")
            .and_then(|v| v.as_str())
            .filter(|text| !text.is_empty())
        {
            let stream = forwarder
                .active
                .get_or_insert_with(|| {
                    Arc::new(Stream {
                        id: uuid::Uuid::new_v4().to_string(),
                        started_at: SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as i64,
                        cancelled: AtomicBool::new(false),
                    })
                })
                .clone();
            // Local attachment paths belong to this host; resolve them before
            // forwarding. This adapter does not interpret page-write markers.
            let text = forwarder.media.push(text);
            for text in chunks(&text) {
                if stream.cancelled.load(Ordering::Relaxed) {
                    break;
                }
                if !forwarder.enqueue(stream.clone(), Some(text.to_owned())) {
                    stream.cancelled.store(true, Ordering::Relaxed);
                    report(&relay.local_event_sender(), channel,
                        "Assistant output delivery stopped: the local acknowledgement queue reached its byte limit.".into());
                    break;
                }
            }
        }
    } else if (matches!(
        phase,
        "turn_completed" | "turn_failed" | "turn_interrupted" | "turn_cancelled"
    ) || (phase == "turn_started"
        && payload.get("continued").and_then(|v| v.as_bool()) != Some(true)))
        && let Some(stream) = forwarder.active.take()
    {
        if matches!(phase, "turn_failed" | "turn_interrupted" | "turn_cancelled") {
            stream.cancelled.store(true, Ordering::Relaxed);
        }
        let tail = forwarder.media.finish();
        if !tail.is_empty() && !stream.cancelled.load(Ordering::Relaxed) {
            for text in chunks(&tail) {
                if !forwarder.enqueue(stream.clone(), Some(text.to_owned())) {
                    stream.cancelled.store(true, Ordering::Relaxed);
                    break;
                }
            }
        }
        forwarder.media = PageReferences::default();
        if !forwarder.enqueue(stream.clone(), None) {
            stream.cancelled.store(true, Ordering::Relaxed);
            report(&relay.local_event_sender(), channel,
                    "Assistant output delivery stopped before its end was acknowledged: the local queue is full.".into());
        }
    }
    true
}

fn report(
    events: &mpsc::UnboundedSender<AgentInstanceConnectionEvent>,
    channel: &str,
    prompt: String,
) {
    let _ = events.send(AgentInstanceConnectionEvent::PageCoWrite(
        PageCoWriteEvent::Outcome {
            channel_id: channel.into(),
            prompt,
        },
    ));
}

async fn forward(
    connector: PageCoWriteConnector,
    channel: String,
    mut queue: mpsc::Receiver<Piece>,
    events: mpsc::UnboundedSender<AgentInstanceConnectionEvent>,
    bytes: Arc<AtomicUsize>,
) {
    let mut current = String::new();
    let mut seq = 0;
    let mut stopped = false;
    let mut pending = None;
    loop {
        let mut piece = if let Some(piece) = pending.take() {
            piece
        } else {
            let Some(piece) = queue.recv().await else {
                break;
            };
            bytes.fetch_sub(
                piece.text.as_ref().map_or(0, String::len),
                Ordering::Relaxed,
            );
            piece
        };
        // Coalesce whatever has already arrived, without delaying first output.
        // The exact resulting frame stays unchanged through retries and 429s.
        if let Some(text) = &mut piece.text {
            while text.len() < MAX_TEXT_BYTES {
                let Ok(next) = queue.try_recv() else {
                    break;
                };
                bytes.fetch_sub(next.text.as_ref().map_or(0, String::len), Ordering::Relaxed);
                if next.stream.id == piece.stream.id
                    && next
                        .text
                        .as_ref()
                        .is_some_and(|part| text.len() + part.len() <= MAX_TEXT_BYTES)
                {
                    text.push_str(next.text.as_deref().unwrap());
                } else {
                    pending = Some(next);
                    break;
                }
            }
        }
        if current != piece.stream.id {
            current = piece.stream.id.clone();
            seq = 0;
            stopped = false;
        }
        if stopped {
            continue;
        }
        let mut input = AssistantOutput {
            stream: current.clone(),
            started_at: piece.stream.started_at,
            seq,
            kind: if piece.text.is_some() { "text" } else { "end" }.into(),
            text: piece.text,
        };
        let mut confirmed = 0;
        let began = Instant::now();
        let mut problems = BTreeSet::new();
        loop {
            if piece.stream.cancelled.load(Ordering::Relaxed) {
                input.kind = "cancel".into();
                input.text = None;
                confirmed = 0;
            }
            let result = tokio::time::timeout(
                REQUEST_TIMEOUT,
                connector.assistant_output(&channel, &input),
            )
            .await;
            match result {
                Ok(Ok(ack)) if ack.matches(&input, confirmed) => {
                    confirmed = ack.at;
                    problems.extend(ack.problems);
                    match ack.status {
                        OutputStatus::Accepted => {
                            stopped = input.kind == "cancel";
                            seq += 1;
                            break;
                        }
                        OutputStatus::Limited => {
                            tokio::time::sleep(Duration::from_millis(
                                ack.retry_after_ms.unwrap_or(0).min(15_000),
                            ))
                            .await;
                        }
                        OutputStatus::Unknown | OutputStatus::Rejected => {
                            if problems.is_empty() {
                                problems.insert(format!("Assistant output {:?} at sequence {} ({} characters confirmed).",
                                    ack.status, ack.seq, ack.at));
                            }
                            stopped = true;
                            break;
                        }
                    }
                }
                Ok(Ok(_)) => {
                    problems.insert("Assistant output delivery stopped: the Hub returned an invalid acknowledgement.".into());
                    stopped = true;
                    break;
                }
                Ok(Err(CliError::HttpStatus(error))) if !error.retryable => {
                    problems.insert(format!(
                        "Assistant output delivery was refused: {}",
                        error.message
                    ));
                    stopped = true;
                    break;
                }
                _ if began.elapsed() < RETRY_WITHIN => {
                    tokio::time::sleep(Duration::from_millis(500)).await
                }
                _ => {
                    problems.insert(
                        "Assistant output delivery could not be confirmed after transport retries."
                            .into(),
                    );
                    stopped = true;
                    break;
                }
            }
        }
        if stopped {
            piece.stream.cancelled.store(true, Ordering::Relaxed);
        }
        if !problems.is_empty() {
            report(
                &events,
                &channel,
                problems.into_iter().collect::<Vec<_>>().join("\n"),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::RwLock;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn lost_and_partial_receipts_resend_the_same_frame_before_advancing() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let hub = tokio::spawn(async move {
            let mut received = Vec::new();
            for attempt in 0..4 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let body = loop {
                    let mut buffer = [0; 8192];
                    let size = socket.read(&mut buffer).await.unwrap();
                    assert!(size > 0);
                    bytes.extend_from_slice(&buffer[..size]);
                    if let Some(split) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..split]);
                        assert!(headers.starts_with("POST /api/channels/channel/page-output "));
                        let length: usize = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse().unwrap())
                            })
                            .unwrap();
                        if bytes.len() >= split + 4 + length {
                            break serde_json::from_slice::<serde_json::Value>(
                                &bytes[split + 4..split + 4 + length],
                            )
                            .unwrap();
                        }
                    }
                };
                received.push(body.clone());
                // The Page could have committed, but this response never arrives.
                if attempt == 1 {
                    continue;
                }
                let reply = serde_json::json!({ "stream": body["stream"], "seq": body["seq"],
                    "status": if attempt == 0 { "limited" } else { "accepted" },
                    "at": if attempt == 0 { 2 } else if body["type"] == "text" { 5 } else { 0 },
                    "retryAfterMs": 0, "problems": [] })
                .to_string();
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}", reply.len(), reply).as_bytes()).await.unwrap();
            }
            received
        });
        let connector = PageCoWriteConnector::new(
            format!("ws://{address}"),
            Arc::new(RwLock::new("test-token".into())),
        );
        let (sender, receiver) = mpsc::channel(QUEUE_FRAMES);
        let (events, mut notices) = mpsc::unbounded_channel();
        let stream = Arc::new(Stream {
            id: "native-turn".into(),
            started_at: 1,
            cancelled: AtomicBool::new(false),
        });
        sender
            .send(Piece {
                stream: stream.clone(),
                text: Some("hello".into()),
            })
            .await
            .unwrap();
        sender.send(Piece { stream, text: None }).await.unwrap();
        drop(sender);
        tokio::time::timeout(
            Duration::from_secs(10),
            forward(
                connector,
                "channel".into(),
                receiver,
                events,
                Arc::new(AtomicUsize::new(5)),
            ),
        )
        .await
        .unwrap();
        let received = hub.await.unwrap();
        assert_eq!(received[0], received[1]);
        assert_eq!(received[1], received[2]);
        assert_eq!(received[3]["seq"], 1);
        assert_eq!(received[3]["type"], "end");
        assert!(notices.try_recv().is_err());
    }
}
