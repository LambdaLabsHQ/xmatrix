//! The Machine Daemon reconnect loop against a scripted Hub, on paused time.
//!
//! Each test drops an established session the way a lost network path does
//! (the Hub goes silent, so only the heartbeat notices) and then fails the next
//! attempt at one step. The daemon host must be told what the connection is
//! stuck on, and the loop must reach the next session by itself.
use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::atomic::AtomicUsize;
use std::task::{Context, Poll};

use super::*;

/// What the scripted Hub does with one credential enrollment.
enum Enroll {
    Answer,
    /// The request is accepted and no reply ever arrives.
    Stall,
}

/// What the scripted Hub does with one dial.
enum Dialed {
    /// Authenticates the socket and answers liveness until told to go silent.
    Session,
    /// Accepts the socket and never answers the connect frame.
    SilentHandshake,
    /// Answers the connect frame with a refusal it does not call retryable.
    Refuse(&'static str),
    /// The network does not reach the Hub.
    Unreachable,
    /// The dial itself never returns.
    Hang,
}

struct ScriptedSocket {
    incoming: mpsc::UnboundedReceiver<std::result::Result<Message, MachineDaemonSocketError>>,
    outgoing: mpsc::UnboundedSender<Message>,
}

impl futures_util::Stream for ScriptedSocket {
    type Item = std::result::Result<Message, MachineDaemonSocketError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.incoming.poll_recv(cx)
    }
}

impl futures_util::Sink<Message> for ScriptedSocket {
    type Error = MachineDaemonSocketError;

    fn poll_ready(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<std::result::Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn start_send(self: Pin<&mut Self>, item: Message) -> std::result::Result<(), Self::Error> {
        // A half-open socket keeps accepting writes; only silence gives it away.
        let _ = self.outgoing.send(item);
        Ok(())
    }

    fn poll_flush(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<std::result::Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn poll_close(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<std::result::Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
}

#[derive(Default)]
struct HubScript {
    enrollments: Mutex<VecDeque<Enroll>>,
    dials: Mutex<VecDeque<Dialed>>,
    /// Sessions the Hub has authenticated so far; also the connection epoch.
    sessions: AtomicUsize,
    /// The live session answers liveness while this is false.
    silent: Arc<AtomicBool>,
}

#[derive(Clone)]
struct ScriptedHub(Arc<HubScript>);

impl ScriptedHub {
    /// A Hub that follows the scripts and then answers everything normally.
    fn new(enrollments: Vec<Enroll>, dials: Vec<Dialed>) -> Self {
        Self(Arc::new(HubScript {
            enrollments: Mutex::new(enrollments.into()),
            dials: Mutex::new(dials.into()),
            ..HubScript::default()
        }))
    }

    /// The network path under the live session is lost without a close.
    fn lose_the_network_path(&self) {
        self.0.silent.store(true, Ordering::Release);
    }

    fn sessions(&self) -> usize {
        self.0.sessions.load(Ordering::Acquire)
    }
}

fn daemon_json() -> serde_json::Value {
    serde_json::json!({
        "id": "daemon-1", "userId": "user-1", "name": "daemon", "email": "u@example.com",
        "metadata": {}, "connectedAt": "2026-10-13T00:00:00Z",
        "lastSeenAt": "2026-10-13T00:00:00Z", "status": "online",
    })
}

impl MachineDaemonDial for ScriptedHub {
    type Socket = ScriptedSocket;

    async fn enroll(
        &self,
        _enrollment_token: &str,
        _identity: &MachineDaemonIdentity,
    ) -> Result<MachineDaemonCredentialResponse> {
        let step = self.0.enrollments.lock().unwrap().pop_front();
        if matches!(step, Some(Enroll::Stall)) {
            std::future::pending::<()>().await;
        }
        Ok(MachineDaemonCredentialResponse {
            credential: "machine-credential".into(),
            daemon: Some(serde_json::from_value(daemon_json()).unwrap()),
            adopted_machine_ids: Vec::new(),
        })
    }

    async fn connect(
        &self,
    ) -> std::result::Result<Self::Socket, crate::websocket::ConnectionFailure> {
        let step = self
            .0
            .dials
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Dialed::Session);
        if matches!(step, Dialed::Hang) {
            std::future::pending::<()>().await;
        }
        if matches!(step, Dialed::Unreachable) {
            return Err(crate::websocket::ConnectionFailure {
                reason: "Machine Daemon connection timed out".into(),
                upgrade_required: false,
                transient: true,
            });
        }
        let (incoming_tx, incoming) = mpsc::unbounded_channel();
        let (outgoing, mut outgoing_rx) = mpsc::unbounded_channel::<Message>();
        let hub = self.0.clone();
        hub.silent.store(false, Ordering::Release);
        tokio::spawn(async move {
            // The first frame is the connect frame.
            if outgoing_rx.recv().await.is_none() {
                return;
            }
            match step {
                Dialed::SilentHandshake => {
                    // Hold the socket open and say nothing.
                    while outgoing_rx.recv().await.is_some() {}
                    drop(incoming_tx);
                    return;
                }
                Dialed::Refuse(message) => {
                    let _ = incoming_tx.send(Ok(Message::Text(
                        serde_json::json!({
                            "type": "error",
                            "message": message,
                            "failure": {
                                "code": "runtime.session_failed",
                                "diagnosticId": "diag_1",
                                "retryable": false,
                            },
                        })
                        .to_string()
                        .into(),
                    )));
                    while outgoing_rx.recv().await.is_some() {}
                    return;
                }
                _ => {}
            }
            let epoch = hub.sessions.fetch_add(1, Ordering::AcqRel) + 1;
            let _ = incoming_tx.send(Ok(Message::Text(
                serde_json::json!({
                    "type": "machine_daemon_connected",
                    "daemon": daemon_json(),
                    "connectionEpoch": epoch,
                })
                .to_string()
                .into(),
            )));
            while let Some(frame) = outgoing_rx.recv().await {
                if hub.silent.load(Ordering::Acquire) {
                    continue;
                }
                match frame {
                    Message::Ping(payload) => {
                        let _ = incoming_tx.send(Ok(Message::Pong(payload)));
                    }
                    Message::Text(_) => {
                        let _ = incoming_tx
                            .send(Ok(Message::Text(r#"{"type":"pong"}"#.to_string().into())));
                    }
                    _ => {}
                }
            }
        });
        Ok(ScriptedSocket { incoming, outgoing })
    }
}

fn client() -> MachineDaemonConnectionClient {
    MachineDaemonConnectionClient::new(
        "wss://example.test/ws".to_string(),
        "token".to_string(),
        "daemon".to_string(),
        "machine-1".to_string(),
        "host-1".to_string(),
        None,
        Vec::new(),
    )
}

/// Registers against `hub` and waits for the first session.
async fn connected_client(
    hub: &ScriptedHub,
) -> (
    MachineDaemonConnectionClient,
    mpsc::UnboundedReceiver<MachineDaemonConnectionEvent>,
) {
    let mut client = client();
    client.register_with(hub.clone()).await.expect("registered");
    let events = client.event_rx.take().expect("event stream");
    wait_until_connected(&client).await;
    (client, events)
}

async fn wait_until_connected(client: &MachineDaemonConnectionClient) {
    tokio::time::timeout(Duration::from_secs(600), async {
        while !client.is_connected() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the control connection is established");
}

/// The next connection event, or a failure once the loop has plainly stopped.
async fn next_event(
    events: &mut mpsc::UnboundedReceiver<MachineDaemonConnectionEvent>,
) -> MachineDaemonConnectionEvent {
    // Twenty minutes of silence is past every bound in the loop, including the
    // operating system's own fifteen-minute retransmission timeout.
    tokio::time::timeout(Duration::from_secs(20 * 60), events.recv())
        .await
        .expect("the reconnect loop reports within twenty minutes")
        .expect("the connection actor is alive")
}

fn disconnected(event: MachineDaemonConnectionEvent) -> String {
    match event {
        MachineDaemonConnectionEvent::Disconnected { reason } => reason,
        other => panic!("expected a disconnect, got {other:?}"),
    }
}

fn assert_reconnected(event: MachineDaemonConnectionEvent) {
    assert!(
        matches!(event, MachineDaemonConnectionEvent::Reconnected { .. }),
        "expected a reconnect, got {event:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn a_credential_reply_that_never_arrives_does_not_hold_the_reconnect_loop() {
    // The first enrollment registers the daemon; the one that follows the lost
    // session is written onto a dead connection and never answered.
    let hub = ScriptedHub::new(vec![Enroll::Answer, Enroll::Stall], Vec::new());
    let (client, mut events) = connected_client(&hub).await;

    let lost_at = Instant::now();
    hub.lose_the_network_path();
    assert!(disconnected(next_event(&mut events).await).contains("heartbeat timed out"));
    assert_eq!(
        disconnected(next_event(&mut events).await),
        "Machine Daemon credential enrollment failed: the Hub did not answer within 20s"
    );
    assert_reconnected(next_event(&mut events).await);
    assert!(client.is_connected());
    assert_eq!(client.connection_epoch(), Some(2));
    // Heartbeat detection, one enrollment bound and one backoff: about a
    // minute, where the unbounded request used to wait on the socket itself.
    assert!(
        lost_at.elapsed() < Duration::from_secs(90),
        "{:?}",
        lost_at.elapsed()
    );
}

#[tokio::test(start_paused = true)]
async fn a_handshake_the_hub_never_answers_is_reported_and_retried() {
    let hub = ScriptedHub::new(Vec::new(), vec![Dialed::Session, Dialed::SilentHandshake]);
    let (client, mut events) = connected_client(&hub).await;

    hub.lose_the_network_path();
    assert!(disconnected(next_event(&mut events).await).contains("heartbeat timed out"));
    // This step used to back off in silence, leaving the host on the reason
    // above for as long as the handshake kept timing out.
    assert_eq!(
        disconnected(next_event(&mut events).await),
        "Machine Daemon handshake timed out; the Hub did not answer the connect frame within 15s"
    );
    assert_reconnected(next_event(&mut events).await);
    assert!(client.is_connected());
}

#[tokio::test(start_paused = true)]
async fn a_refused_handshake_becomes_the_reported_reason_and_is_retried() {
    let hub = ScriptedHub::new(
        Vec::new(),
        vec![
            Dialed::Session,
            Dialed::Refuse("The Hub could not complete this Machine Daemon connect"),
        ],
    );
    let (client, mut events) = connected_client(&hub).await;

    hub.lose_the_network_path();
    assert!(disconnected(next_event(&mut events).await).contains("heartbeat timed out"));
    assert_eq!(
        disconnected(next_event(&mut events).await),
        "Hub refused the Machine Daemon connection: The Hub could not complete this Machine Daemon connect (code=runtime.session_failed, diagnosticId=diag_1)"
    );
    assert_reconnected(next_event(&mut events).await);
    assert!(client.is_connected());
}

#[tokio::test(start_paused = true)]
async fn a_first_session_that_follows_a_failed_dial_is_announced_as_restored() {
    // Enrollment alone completes registration, so the host already shows the
    // daemon as ready when the first dial fails and it is told otherwise.
    let hub = ScriptedHub::new(Vec::new(), vec![Dialed::Unreachable]);
    let mut client = client();
    client.register_with(hub.clone()).await.expect("registered");
    let mut events = client.event_rx.take().expect("event stream");

    assert_eq!(
        disconnected(next_event(&mut events).await),
        "Machine Daemon connection timed out"
    );
    // Without this the host stayed on `reconnecting` while connected.
    assert_reconnected(next_event(&mut events).await);
    assert!(client.is_connected());
    assert_eq!(hub.sessions(), 1);
}

#[tokio::test(start_paused = true)]
async fn an_attempt_that_never_finishes_is_abandoned_for_the_next_one() {
    let hub = ScriptedHub::new(Vec::new(), vec![Dialed::Session, Dialed::Hang]);
    let (client, mut events) = connected_client(&hub).await;

    hub.lose_the_network_path();
    assert!(disconnected(next_event(&mut events).await).contains("heartbeat timed out"));
    assert_eq!(
        disconnected(next_event(&mut events).await),
        "Machine Daemon connection attempt did not finish within 45s"
    );
    assert_reconnected(next_event(&mut events).await);
    assert!(client.is_connected());
}

#[tokio::test(start_paused = true)]
async fn an_outage_of_any_length_ends_with_the_next_session() {
    // Twelve failed attempts across every step, then the Hub is back.
    let dials = (0..4).flat_map(|_| {
        [
            Dialed::Unreachable,
            Dialed::SilentHandshake,
            Dialed::Refuse("refused"),
        ]
    });
    let hub = ScriptedHub::new(
        Vec::new(),
        std::iter::once(Dialed::Session).chain(dials).collect(),
    );
    let (client, mut events) = connected_client(&hub).await;

    hub.lose_the_network_path();
    let mut reported = 0;
    loop {
        match next_event(&mut events).await {
            MachineDaemonConnectionEvent::Disconnected { .. } => reported += 1,
            MachineDaemonConnectionEvent::Reconnected { .. } => break,
            other => panic!("unexpected event {other:?}"),
        }
    }
    // The lost session and each failed attempt were all reported.
    assert_eq!(reported, 13);
    assert!(client.is_connected());
    assert_eq!(hub.sessions(), 2);
}
