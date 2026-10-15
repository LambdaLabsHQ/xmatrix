// Provider JSON transports: bounded ingress, bounded deferred notifications,
// and terminal errors retained separately from the data queue.

use std::collections::VecDeque;
use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::error::CapacityError;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Error as WsError, Message as WsMessage};
use xmatrix_cli_core::error::{CliError, ProviderTransportFailure as Failure};

pub(crate) const PROVIDER_MESSAGE_MAX_BYTES: usize = 64 * 1024 * 1024;
const QUEUE_MESSAGES: usize = 128;
const QUEUE_BYTES: usize = 16 * 1024 * 1024;
const BACKLOG_MESSAGES: usize = 1024;
const BACKLOG_BYTES: usize = 16 * 1024 * 1024;

pub(crate) fn provider_websocket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_frame_size(Some(PROVIDER_MESSAGE_MAX_BYTES))
        .max_message_size(Some(PROVIDER_MESSAGE_MAX_BYTES))
}

struct QueuedValue {
    value: Value,
    _bytes: OwnedSemaphorePermit,
}

pub(crate) struct ProviderInbox {
    rx: mpsc::Receiver<QueuedValue>,
    backlog: VecDeque<(usize, Value)>,
    backlog_bytes: usize,
    failure: Arc<Mutex<Option<Failure>>>,
    reader: Option<JoinHandle<()>>,
    vendor: String,
    transport: &'static str,
    failed: bool,
}

impl Drop for ProviderInbox {
    fn drop(&mut self) {
        if let Some(reader) = &self.reader {
            reader.abort();
        }
    }
}

impl ProviderInbox {
    pub(crate) fn try_recv(&mut self) -> Option<Value> {
        if self.failed {
            return None;
        }
        let value = self.rx.try_recv().ok()?.value;
        crate::runtime_wake_metrics::record_provider_message(&value);
        Some(value)
    }

    pub(crate) async fn recv(&mut self) -> Option<Value> {
        if self.failed {
            return None;
        }
        let value = self.rx.recv().await?.value;
        // Every provider message passes here exactly once (deferred ones are
        // replayed from the backlog, not received again).
        crate::runtime_wake_metrics::record_provider_message(&value);
        Some(value)
    }

    pub(crate) async fn next(&mut self) -> Option<Value> {
        if self.failed {
            return None;
        }
        if let Some((bytes, value)) = self.backlog.pop_front() {
            self.backlog_bytes -= bytes;
            return Some(value);
        }
        self.recv().await
    }

    pub(crate) fn pending(&self) -> impl Iterator<Item = &Value> {
        self.backlog.iter().map(|(_, value)| value)
    }

    pub(crate) fn defer(&mut self, value: Value) -> Result<(), CliError> {
        let bytes = json_wire_bytes(&value);
        let next_bytes = self.backlog_bytes.saturating_add(bytes);
        if self.backlog.len() >= BACKLOG_MESSAGES || next_bytes > BACKLOG_BYTES {
            *self.failure.lock().unwrap_or_else(|e| e.into_inner()) = Some(Failure::BacklogFull {
                messages: self.backlog.len() + 1,
                max_messages: BACKLOG_MESSAGES,
                bytes: next_bytes,
                max_bytes: BACKLOG_BYTES,
            });
            self.failed = true;
            self.rx.close();
            if let Some(reader) = &self.reader {
                reader.abort();
            }
            return Err(self.error());
        }
        self.backlog.push_back((bytes, value));
        self.backlog_bytes = next_bytes;
        Ok(())
    }

    pub(crate) fn has_failure(&self) -> bool {
        self.failed
            || self
                .failure
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some()
    }

    pub(crate) fn error(&self) -> CliError {
        CliError::ProviderTransport {
            vendor: self.vendor.clone(),
            transport: self.transport,
            source: self
                .failure
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
                .unwrap_or(Failure::Closed { code: None }),
        }
    }

    pub(crate) fn retryable(&self) -> bool {
        self.failure
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_none_or(Failure::retryable)
    }
}

struct ByteCount(usize);

impl Write for ByteCount {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self.0.saturating_add(bytes.len());
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn json_wire_bytes(value: &Value) -> usize {
    let mut count = ByteCount(0);
    serde_json::to_writer(&mut count, value).expect("counting JSON cannot fail");
    count.0
}

struct ReaderSink {
    tx: mpsc::Sender<QueuedValue>,
    budget: Arc<Semaphore>,
}

impl ReaderSink {
    async fn send(&self, bytes: &[u8]) -> Result<bool, Failure> {
        if bytes.len() > PROVIDER_MESSAGE_MAX_BYTES {
            return Err(Failure::MessageTooLarge {
                size: bytes.len(),
                max_size: PROVIDER_MESSAGE_MAX_BYTES,
            });
        }
        if bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(true);
        }
        // Reserve before parsing: a slow consumer backpressures the socket.
        // A frame larger than the ordinary byte budget occupies it exclusively.
        let Ok(slot) = self.tx.reserve().await else {
            return Ok(false);
        };
        let Ok(permit) = self
            .budget
            .clone()
            .acquire_many_owned(bytes.len().min(QUEUE_BYTES) as u32)
            .await
        else {
            return Ok(false);
        };
        let value = serde_json::from_slice(bytes).map_err(|e| Failure::InvalidJson {
            line: e.line(),
            column: e.column(),
        })?;
        slot.send(QueuedValue {
            value,
            _bytes: permit,
        });
        Ok(true)
    }
}

fn spawn_reader<F, Fut>(vendor: String, transport: &'static str, read: F) -> ProviderInbox
where
    F: FnOnce(ReaderSink) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<(), Failure>> + Send + 'static,
{
    let (tx, rx) = mpsc::channel(QUEUE_MESSAGES);
    let failure = Arc::new(Mutex::new(None));
    let reader_failure = failure.clone();
    let reader = tokio::spawn(async move {
        if let Err(error) = read(ReaderSink {
            tx,
            budget: Arc::new(Semaphore::new(QUEUE_BYTES)),
        })
        .await
        {
            *reader_failure.lock().unwrap_or_else(|e| e.into_inner()) = Some(error);
        }
    });
    ProviderInbox {
        rx,
        backlog: VecDeque::new(),
        backlog_bytes: 0,
        failure,
        reader: Some(reader),
        vendor,
        transport,
        failed: false,
    }
}

pub(crate) fn spawn_ws_json_value_reader<R>(mut read: R, vendor: String) -> ProviderInbox
where
    R: futures_util::Stream<Item = Result<WsMessage, WsError>> + Unpin + Send + 'static,
{
    spawn_reader(vendor, "WebSocket", move |sink| async move {
        while let Some(frame) = read.next().await {
            match frame {
                Ok(WsMessage::Text(text)) => {
                    if !sink.send(text.as_bytes()).await? {
                        break;
                    }
                }
                Ok(WsMessage::Binary(bytes)) => {
                    if !sink.send(&bytes).await? {
                        break;
                    }
                }
                Ok(WsMessage::Close(frame)) => {
                    return Err(Failure::Closed {
                        code: frame.map(|f| f.code.into()),
                    });
                }
                Err(WsError::Capacity(CapacityError::MessageTooLong { size, max_size })) => {
                    return Err(Failure::MessageTooLarge { size, max_size });
                }
                Err(error) => return Err(Failure::Connection(error.to_string())),
                Ok(WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Frame(_)) => {}
            }
        }
        Ok(())
    })
}

pub(crate) fn spawn_stdio_json_value_reader<R>(read: R, vendor: String) -> ProviderInbox
where
    R: AsyncRead + Unpin + Send + 'static,
{
    spawn_reader(vendor, "stdio", move |sink| async move {
        let mut read = BufReader::new(read);
        loop {
            let mut line = Vec::new();
            let size = (&mut read)
                .take(PROVIDER_MESSAGE_MAX_BYTES as u64 + 1)
                .read_until(b'\n', &mut line)
                .await
                .map_err(|e| Failure::Connection(e.to_string()))?;
            if size == 0 {
                return Ok(());
            }
            if size > PROVIDER_MESSAGE_MAX_BYTES {
                return Err(Failure::MessageTooLarge {
                    size,
                    max_size: PROVIDER_MESSAGE_MAX_BYTES,
                });
            }
            // Some ACP CLIs print banners to stdout before the JSON stream.
            if !matches!(
                line.iter().find(|b| !b.is_ascii_whitespace()),
                Some(b'{' | b'[')
            ) {
                continue;
            }
            if !sink.send(&line).await? {
                return Ok(());
            }
        }
    })
}

#[cfg(test)]
#[path = "tests/tests_provider_inbox.rs"]
mod tests;
