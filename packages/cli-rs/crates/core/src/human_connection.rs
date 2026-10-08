use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

use crate::backoff::Backoff;
use crate::connection_error::frame_hub_restarting;
use crate::error::{CliError, Result};
use crate::http::{self, CLIENT_COMPATIBILITY_PROTOCOL_VERSION, ClientComponent};
use crate::protocol::{AuthUser, ChannelMessage};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const INITIAL_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const INITIAL_READY_TIMEOUT: Duration = Duration::from_secs(60);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);
const RECONNECT_BASE: Duration = Duration::from_secs(1);
const RECONNECT_MAX: Duration = Duration::from_secs(30);
/// The Hub's failure code for a Human token it does not accept.
const HUMAN_AUTH_INVALID: &str = "human_auth_invalid";

pub fn derive_connection_url(hub_url: &str) -> String {
    domain_connection_url(hub_url, "/ws/humans")
}

pub fn derive_connection_url_for_owner(hub_url: &str, owner_user_id: &str) -> String {
    crate::websocket::with_runtime_owner(derive_connection_url(hub_url), owner_user_id)
}

use crate::websocket::domain_connection_url;

/// Human-connection lifecycle and application events.
///
/// This enum intentionally contains no Agent Instance or Machine Daemon
/// messages. The Human connection owns its own wire parser and reconnect loop.
#[derive(Debug, Clone)]
pub enum HumanConnectionEvent {
    Connected {
        user: AuthUser,
        reconnected: bool,
    },
    Disconnected {
        reason: String,
    },
    ChannelMessageReceived {
        message: ChannelMessage,
    },
    ChannelMessageUpdated {
        channel_id: String,
        message: ChannelMessage,
    },
    Error {
        message: String,
    },
}

enum HumanConnectionCommand {
    FocusChannel(Option<String>),
    Close,
}

/// Independent Human WebSocket connection.
///
/// Channel mutation remains on authenticated Human HTTP APIs. This connection
/// is only the Human realtime subscription/presence state machine.
pub struct HumanConnectionClient {
    command_tx: mpsc::UnboundedSender<HumanConnectionCommand>,
    pub event_rx: mpsc::UnboundedReceiver<HumanConnectionEvent>,
    task: tokio::task::JoinHandle<()>,
}

impl HumanConnectionClient {
    pub async fn connect(hub_url: &str, token: String, client: String) -> Result<Self> {
        Self::connect_with_owner(hub_url, token, client, "").await
    }

    /// `owner_user_id` is a routing hint. An id the Hub would reject is omitted.
    pub async fn connect_with_owner(
        hub_url: &str,
        token: String,
        client: String,
        owner_user_id: &str,
    ) -> Result<Self> {
        let (command_tx, command_rx) = mpsc::unbounded_channel();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (ready_tx, ready_rx) = oneshot::channel();
        let task = tokio::spawn(run_human_connection(
            hub_url.to_string(),
            owner_user_id.to_string(),
            token,
            client,
            command_rx,
            event_tx,
            ready_tx,
        ));

        match tokio::time::timeout(INITIAL_READY_TIMEOUT, ready_rx).await {
            Ok(Ok(Ok(()))) => Ok(Self {
                command_tx,
                event_rx,
                task,
            }),
            Ok(Ok(Err(message))) => {
                task.abort();
                Err(CliError::Relay(message))
            }
            Ok(Err(_)) => {
                task.abort();
                Err(CliError::Relay(
                    "Human connection stopped before authentication completed".into(),
                ))
            }
            Err(_) => {
                task.abort();
                Err(CliError::Relay(
                    "Timed out waiting for Human connection authentication".into(),
                ))
            }
        }
    }

    pub fn focus_channel(&self, channel_id: Option<String>) -> Result<()> {
        self.command_tx
            .send(HumanConnectionCommand::FocusChannel(channel_id))
            .map_err(|_| CliError::Relay("Human connection is closed".into()))
    }

    pub async fn close(self) {
        let _ = self.command_tx.send(HumanConnectionCommand::Close);
        let _ = tokio::time::timeout(Duration::from_secs(2), self.task).await;
    }
}

async fn handle_human_connection_failure(
    ready: &mut Option<oneshot::Sender<std::result::Result<(), String>>>,
    events: &mpsc::UnboundedSender<HumanConnectionEvent>,
    reason: String,
    fatal: bool,
    backoff: &mut Backoff,
) -> bool {
    crate::websocket::handle_connection_failure(
        ready,
        events,
        reason,
        fatal,
        backoff,
        human_reconnect_events(),
    )
    .await
}

async fn run_human_connection(
    hub_url: String,
    owner_user_id: String,
    mut token: String,
    client: String,
    mut command_rx: mpsc::UnboundedReceiver<HumanConnectionCommand>,
    event_tx: mpsc::UnboundedSender<HumanConnectionEvent>,
    ready_tx: oneshot::Sender<std::result::Result<(), String>>,
) {
    let mut ready_tx = Some(ready_tx);
    let mut focused_channel_id: Option<String> = None;
    let mut connected_once = false;
    let mut backoff = Backoff::new(RECONNECT_BASE, RECONNECT_MAX);
    let connection_url = derive_connection_url_for_owner(&hub_url, &owner_user_id);

    loop {
        let Ok(stream) = crate::websocket::connect_with_reconnect(
            &connection_url,
            crate::websocket::ConnectionOptions {
                component: ClientComponent::Cli,
                timeout: CONNECT_TIMEOUT,
                timeout_reason: "Human connection timed out",
                retry_initial_transient: false,
            },
            &mut ready_tx,
            &event_tx,
            &mut backoff,
            human_reconnect_events(),
        )
        .await
        else {
            return;
        };
        let Some(stream) = stream else {
            continue;
        };

        let (mut write, mut read) = stream.split();
        let connect_message = serde_json::json!({
            "type": "human_connect",
            "requestId": uuid::Uuid::new_v4().to_string(),
            "token": token,
            "device": {
                "client": client,
                "platform": std::env::consts::OS,
                "version": crate::version::current(),
                "protocolVersion": CLIENT_COMPATIBILITY_PROTOCOL_VERSION,
            },
        });
        if let Err(error) = write
            .send(Message::Text(connect_message.to_string().into()))
            .await
        {
            let reason = format!("Failed to authenticate Human connection: {error}");
            if handle_human_connection_failure(
                &mut ready_tx,
                &event_tx,
                reason,
                false,
                &mut backoff,
            )
            .await
            {
                return;
            }
            continue;
        }

        let first_text = match crate::websocket::receive_handshake_text(
            &mut read,
            INITIAL_HANDSHAKE_TIMEOUT,
            "Human connection",
            "Human connection closed before authentication completed",
        )
        .await
        {
            Ok(text) => text,
            Err(reason) => {
                if crate::websocket::fail_handshake_or_wait(&mut ready_tx, &reason, &mut backoff)
                    .await
                {
                    return;
                }
                continue;
            }
        };

        let user = match parse_human_connected(&first_text) {
            Ok(user) => user,
            Err(rejection) => {
                let reason = rejection.message;
                // The Hub said a later attempt may succeed: an outage, not a
                // refusal, so even the first connection keeps trying.
                if rejection.retryable {
                    let _ = event_tx.send(HumanConnectionEvent::Disconnected {
                        reason: format!("Human Hub briefly unavailable: {reason}"),
                    });
                    backoff.wait().await;
                    continue;
                }
                if crate::websocket::fail_initial_ready(&mut ready_tx, &reason) {
                    return;
                }
                let _ = event_tx.send(HumanConnectionEvent::Error { message: reason });
                // The same token would be refused again: renew it, or stop.
                if rejection.auth {
                    match renewed_token(&hub_url, &token).await {
                        Renewal::Renewed(renewed) => token = renewed,
                        // The Hub could not be asked: the session may be
                        // fine, so keep it and try again after the backoff.
                        Renewal::Unavailable => {}
                        Renewal::Refused => {
                            let _ = event_tx.send(HumanConnectionEvent::Error {
                                message: "The xMatrix session expired; run `xmatrix login` and reconnect.".into(),
                            });
                            return;
                        }
                    }
                }
                backoff.wait().await;
                continue;
            }
        };

        let reconnected = connected_once;
        connected_once = true;
        let connected_at = std::time::Instant::now();
        if let Some(sender) = ready_tx.take() {
            let _ = sender.send(Ok(()));
        }
        let _ = event_tx.send(HumanConnectionEvent::Connected { user, reconnected });
        if let Some(channel_id) = focused_channel_id.as_deref()
            && send_focus_message(&mut write, Some(channel_id))
                .await
                .is_err()
        {
            continue;
        }

        let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let disconnect_reason = loop {
            tokio::select! {
                command = command_rx.recv() => {
                    match command {
                        Some(HumanConnectionCommand::FocusChannel(channel_id)) => {
                            focused_channel_id = channel_id;
                            if let Err(error) = send_focus_message(&mut write, focused_channel_id.as_deref()).await {
                                break format!("Human focus update failed: {error}");
                            }
                        }
                        Some(HumanConnectionCommand::Close) | None => {
                            let _ = write.close().await;
                            return;
                        }
                    }
                }
                incoming = read.next() => {
                    match incoming {
                        Some(Ok(message)) => {
                            if let Message::Close(frame) = &message
                                && http::is_upgrade_required_close(frame.as_ref())
                            {
                                let reason = frame
                                    .as_ref()
                                    .map(|frame| frame.reason.to_string())
                                    .filter(|reason| !reason.is_empty())
                                    .unwrap_or_else(|| "This xMatrix CLI must be updated before reconnecting.".into());
                                let _ = event_tx.send(HumanConnectionEvent::Error { message: reason });
                                return;
                            }
                            if message.is_close() {
                                break "Human connection closed by Hub".to_string();
                            }
                            if let Ok(text) = message.into_text()
                                && let Some(event) = parse_human_server_event(text.as_ref()) {
                                    if let HumanConnectionEvent::Error { message } = &event
                                        && frame_hub_restarting(text.as_ref())
                                    {
                                        break format!("Human Hub restarting: {message}");
                                    }
                                    let _ = event_tx.send(event);
                                }
                        }
                        Some(Err(error)) => break format!("Human connection read failed: {error}"),
                        None => break "Human connection ended".to_string(),
                    }
                }
                _ = heartbeat.tick() => {
                    let ping = serde_json::json!({
                        "type": "ping",
                        "requestId": uuid::Uuid::new_v4().to_string(),
                    });
                    if let Err(error) = write.send(Message::Text(ping.to_string().into())).await {
                        break format!("Human connection heartbeat failed: {error}");
                    }
                }
            }
        };

        let _ = event_tx.send(HumanConnectionEvent::Disconnected {
            reason: disconnect_reason,
        });
        backoff.reset_if_healthy(connected_at.elapsed());
        backoff.wait().await;
    }
}

async fn send_focus_message<S>(
    write: &mut S,
    channel_id: Option<&str>,
) -> std::result::Result<(), tokio_tungstenite::tungstenite::Error>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let message = serde_json::json!({
        "type": "user_focus_channel",
        "requestId": uuid::Uuid::new_v4().to_string(),
        "channelId": channel_id,
    });
    write.send(Message::Text(message.to_string().into())).await
}

enum Renewal {
    Renewed(String),
    /// The refresh met an outage; it says nothing about the session.
    Unavailable,
    Refused,
}

/// A token the Hub may accept after it refused `current`: the saved session's,
/// when another process already renewed it, or a freshly refreshed one.
async fn renewed_token(hub_url: &str, current: &str) -> Renewal {
    let Some(saved) = crate::config::load_session_for_hub(hub_url).await else {
        return Renewal::Refused;
    };
    if saved.token != current {
        return Renewal::Renewed(saved.token);
    }
    match crate::auth::refresh_cli_session(&saved).await {
        Ok(session) => Renewal::Renewed(session.token),
        Err(error) if error.is_transient() => Renewal::Unavailable,
        Err(_) => Renewal::Refused,
    }
}

struct HandshakeRejection {
    message: String,
    /// The Hub refused the credential itself (`human_auth_invalid`).
    auth: bool,
    /// The Hub called the failure transient (`failure.retryable`).
    retryable: bool,
}

fn parse_human_connected(text: &str) -> std::result::Result<AuthUser, HandshakeRejection> {
    #[derive(Deserialize)]
    struct Failure {
        code: String,
        #[serde(default)]
        retryable: bool,
    }
    #[derive(Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    enum Handshake {
        HumanConnected {
            user: AuthUser,
        },
        Error {
            message: String,
            failure: Option<Failure>,
        },
    }

    match serde_json::from_str::<Handshake>(text) {
        Ok(Handshake::HumanConnected { user }) => Ok(user),
        Ok(Handshake::Error { message, failure }) => Err(HandshakeRejection {
            message,
            auth: failure
                .as_ref()
                .is_some_and(|failure| failure.code == HUMAN_AUTH_INVALID),
            retryable: failure.is_some_and(|failure| failure.retryable),
        }),
        Err(error) => Err(HandshakeRejection {
            message: format!("Invalid Human connection handshake: {error}"),
            auth: false,
            retryable: false,
        }),
    }
}

fn parse_human_server_event(text: &str) -> Option<HumanConnectionEvent> {
    let value = serde_json::from_str::<serde_json::Value>(text).ok()?;
    match value.get("type")?.as_str()? {
        "channel_message_received" => {
            // The frame nests the message; there is nothing to re-list here, so
            // a field this client forgets to copy can no longer go missing.
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Received {
                message: ChannelMessage,
            }
            let received = serde_json::from_value::<Received>(value).ok()?;
            Some(HumanConnectionEvent::ChannelMessageReceived {
                message: received.message,
            })
        }
        "channel_message_updated" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Updated {
                channel_id: String,
                message: ChannelMessage,
            }
            let updated = serde_json::from_value::<Updated>(value).ok()?;
            Some(HumanConnectionEvent::ChannelMessageUpdated {
                channel_id: updated.channel_id,
                message: updated.message,
            })
        }
        "error" => Some(HumanConnectionEvent::Error {
            message: value
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Human connection error")
                .to_string(),
        }),
        _ => None,
    }
}

fn human_reconnect_events() -> crate::websocket::ReconnectEvents<HumanConnectionEvent> {
    crate::websocket::ReconnectEvents {
        disconnected: |reason| HumanConnectionEvent::Disconnected { reason },
        error: |reason| HumanConnectionEvent::Error { message: reason },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_refused_credential_asks_for_a_renewed_token() {
        let refused = parse_human_connected(
            r#"{"type":"error","message":"Sign in again","failure":{"code":"human_auth_invalid","stage":"human.authenticate"}}"#,
        )
        .expect_err("refused");
        assert!(refused.auth);
        assert_eq!(refused.message, "Sign in again");
        for other in [
            r#"{"type":"error","message":"Could not connect this session","failure":{"code":"runtime.session_failed"}}"#,
            r#"{"type":"error","message":"Could not connect this session"}"#,
            r#"{"type":"nope"}"#,
        ] {
            assert!(
                !parse_human_connected(other).expect_err("rejected").auth,
                "{other}"
            );
        }
    }

    #[test]
    fn only_a_retryable_handshake_failure_is_an_outage() {
        let restarting = parse_human_connected(
            r#"{"type":"error","message":"Could not connect this session","failure":{"code":"service_restarting","retryable":true}}"#,
        )
        .expect_err("rejected");
        assert!(restarting.retryable && !restarting.auth);
        for refused in [
            r#"{"type":"error","message":"Sign in again","failure":{"code":"human_auth_invalid","retryable":false}}"#,
            r#"{"type":"error","message":"Durable Object reset because its code was updated."}"#,
        ] {
            assert!(
                !parse_human_connected(refused)
                    .expect_err("rejected")
                    .retryable,
                "{refused}"
            );
        }
    }

    #[test]
    fn human_connection_url_discards_other_domain_paths() {
        assert_eq!(
            derive_connection_url("wss://hub.example.com/ws/machine-daemons?stale=1"),
            "wss://hub.example.com/ws/humans"
        );
        assert_eq!(
            derive_connection_url_for_owner(
                "wss://hub.example.com/ws/machine-daemons?stale=1",
                "user_1",
            ),
            "wss://hub.example.com/ws/humans?owner=user_1"
        );
        assert_eq!(
            derive_connection_url_for_owner("https://hub.example.com", "not a user"),
            "wss://hub.example.com/ws/humans"
        );
    }

    #[test]
    fn human_parser_does_not_accept_machine_or_agent_registration_messages() {
        assert!(
            parse_human_server_event(r#"{"type":"machine_daemon_connected","daemon":{}}"#)
                .is_none()
        );
        assert!(
            parse_human_server_event(r#"{"type":"agent_instance_connected","agent":{}}"#).is_none()
        );
    }

    const LIVE_HUMAN_FRAME: &str = r#"{
      "type":"channel_message_received",
      "message":{
        "messageId":"m1",
        "channelId":"c1",
        "sequence":2,
        "from":{
          "identityId":"human:u1",
          "kind":"user",
          "label":"Yiming",
          "userId":"u1",
          "email":"yiming@example.com"
        },
        "body":"hello",
        "sentAt":"2026-07-14T00:00:00.000Z"
      },
      "clientMessageId":"client-1"
    }"#;

    #[test]
    fn human_channel_message_parses_into_the_one_message_shape() {
        let Some(HumanConnectionEvent::ChannelMessageReceived { message }) =
            parse_human_server_event(LIVE_HUMAN_FRAME)
        else {
            panic!("expected Human channel message");
        };
        assert_eq!(message.message_id, "m1");
        assert_eq!(message.channel_id, "c1");
        assert_eq!(message.sequence, Some(2));
    }

    #[test]
    fn a_frame_without_a_nested_message_is_not_a_channel_message() {
        // The flat frame is the shape that let a client read a field the hub
        // never sent. It must fail to parse rather than decode as a blank.
        let flat = LIVE_HUMAN_FRAME.replace(r#""message":{"#, r#""ignored":{"#);
        assert!(parse_human_server_event(&flat).is_none());
    }
}
