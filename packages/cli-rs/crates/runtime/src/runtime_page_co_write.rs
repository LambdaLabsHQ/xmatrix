//! An Agent co-writing a page live, whatever its harness
//! (docs/design/pages-live-document.md §4.2).
//!
//! The Hub's `xmatrixPageCoWrite` instruction in a conversation starts a
//! bridge: this runtime joins the page's live session as its co-writer. Each
//! turn the session sends reaches the run loop as the harness's next input, a
//! resume of that conversation, so every backend runs it as it runs any turn.
//! The harness's text, which every backend already reports as `assistant_delta`
//! traces, streams back to the session with the turn's end. A new turn from the
//! session, or its interrupt, stops a turn still running (see
//! `event_requests_active_turn_interrupt_with_replay`).

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use colored::Colorize;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::Message;
use xmatrix_cli_core::agent_instance_connection::{
    AgentInstanceConnectionClient, AgentInstanceConnectionEvent,
};
use xmatrix_cli_core::page_co_write::{
    PAGE_SESSION_HEARTBEAT_PING, PageCoWriteConnector, PageCoWriteEvent, PageCoWriteRequest,
    decode_request, delta_frame, done_frame,
};
use xmatrix_cli_core::protocol::ChannelPageCoWrite;

/// Kept below the idle limits between here and the session.
const HEARTBEAT: Duration = Duration::from_secs(25);
/// Waits before joining again after the socket closed or could not open.
const REJOIN_DELAYS: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(30),
];

/// One conversation co-writing one page.
struct Bridge {
    page: (String, String),
    /// Frames for the session, while a socket is open.
    outgoing: Option<mpsc::UnboundedSender<Vec<u8>>>,
    /// The session's turn the run loop took as its next input; the harness's
    /// next turn in this conversation answers it.
    queued: Option<u64>,
    /// The session's turn the harness is answering now.
    answering: Option<u64>,
    stop: watch::Sender<bool>,
}

impl Bridge {
    fn send(&self, frame: Vec<u8>) {
        if let Some(outgoing) = &self.outgoing {
            let _ = outgoing.send(frame);
        }
    }
}

static BRIDGES: LazyLock<Mutex<HashMap<String, Bridge>>> = LazyLock::new(Default::default);

fn bridges() -> std::sync::MutexGuard<'static, HashMap<String, Bridge>> {
    BRIDGES.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Starts or ends co-writing as the Hub's instruction in `channel_id` says.
pub(crate) fn follow(
    relay: &AgentInstanceConnectionClient,
    channel_id: &str,
    instruction: &ChannelPageCoWrite,
) {
    let page = (instruction.space_id.clone(), instruction.page_id.clone());
    let mut all = bridges();
    if let Some(bridge) = all.get(channel_id) {
        if instruction.active && bridge.page == page {
            return;
        }
        let _ = bridge.stop.send(true);
        all.remove(channel_id);
    }
    if !instruction.active {
        return;
    }
    let (stop, stopped) = watch::channel(false);
    all.insert(
        channel_id.to_string(),
        Bridge {
            page: page.clone(),
            outgoing: None,
            queued: None,
            answering: None,
            stop,
        },
    );
    tokio::spawn(run_bridge(
        relay.page_co_write_connector(),
        relay.local_event_sender(),
        channel_id.to_string(),
        page,
        stopped,
    ));
}

/// Whether the harness in `channel_id` is answering the page's turn now: all
/// its text goes to that page.
pub(crate) fn answering(channel_id: &str) -> bool {
    bridges()
        .get(channel_id)
        .is_some_and(|bridge| bridge.answering.is_some())
}

/// The run loop took the session's `turn` as its next input in `channel_id`.
pub(crate) fn turn_queued(channel_id: &str, turn: u64) {
    if let Some(bridge) = bridges().get_mut(channel_id) {
        bridge.queued = Some(turn);
    }
}

/// A trace this runtime publishes for a turn in `channel_id`: while the
/// conversation co-writes a page, the harness's text and the turn's end go to
/// the page's session as well.
pub(crate) fn observe_trace(channel_id: &str, phase: &str, payload: &serde_json::Value) {
    let mut all = bridges();
    let Some(bridge) = all.get_mut(channel_id) else {
        return;
    };
    match phase {
        // A harness that carries on with the same turn says so; that is not a new one.
        "turn_started" if payload.get("continued").and_then(|value| value.as_bool()) != Some(true) => {
            if let Some(turn) = bridge.answering.take() {
                bridge.send(done_frame(turn, false));
            }
            bridge.answering = bridge.queued.take();
        }
        "assistant_delta" => {
            if let (Some(turn), Some(text)) = (
                bridge.answering,
                payload.get("delta").and_then(|value| value.as_str()),
            ) && !text.is_empty()
            {
                bridge.send(delta_frame(turn, text));
            }
        }
        // A turn stopped from the conversation (a chat message, a model switch) is cancelled; it ends the
        // page's turn there and then, or the page would wait on it and never ask the Agent again.
        "turn_completed" | "turn_failed" | "turn_interrupted" | "turn_cancelled" => {
            if let Some(turn) = bridge.answering.take() {
                bridge.send(done_frame(turn, phase == "turn_failed"));
            }
        }
        _ => {}
    }
}

async fn run_bridge(
    connector: PageCoWriteConnector,
    events: mpsc::UnboundedSender<AgentInstanceConnectionEvent>,
    channel_id: String,
    (space_id, page_id): (String, String),
    mut stopped: watch::Receiver<bool>,
) {
    let mut attempt = 0usize;
    while !*stopped.borrow() {
        match connector.connect(&space_id, &page_id, false).await {
            Ok(socket) => {
                attempt = 0;
                let (mut sink, mut stream) = socket.split();
                let (outgoing, mut frames) = mpsc::unbounded_channel::<Vec<u8>>();
                set_outgoing(&channel_id, Some(outgoing));
                let mut heartbeat = tokio::time::interval(HEARTBEAT);
                heartbeat.tick().await;
                loop {
                    tokio::select! {
                        _ = stopped.changed() => {
                            let _ = sink.close().await;
                            break;
                        }
                        Some(frame) = frames.recv() => {
                            if sink.send(Message::Binary(frame.into())).await.is_err() {
                                break;
                            }
                        }
                        _ = heartbeat.tick() => {
                            if sink.send(Message::Text(PAGE_SESSION_HEARTBEAT_PING.into())).await.is_err() {
                                break;
                            }
                        }
                        frame = stream.next() => match frame {
                            Some(Ok(Message::Binary(data))) => {
                                if let Some(request) = decode_request(&data) {
                                    let event = match request {
                                        PageCoWriteRequest::Turn { turn, text } => PageCoWriteEvent::Turn {
                                            channel_id: channel_id.clone(), turn, prompt: text,
                                        },
                                        PageCoWriteRequest::Interrupt { turn } => PageCoWriteEvent::Interrupt {
                                            channel_id: channel_id.clone(), turn,
                                        },
                                        // Only a turn this side opened has an outcome, and the bridge opens none.
                                        PageCoWriteRequest::Outcome { .. } => continue,
                                    };
                                    if events.send(AgentInstanceConnectionEvent::PageCoWrite(event)).is_err() {
                                        return;
                                    }
                                }
                            }
                            // The page is gone, or this Run may no longer read it: co-writing ends.
                            Some(Ok(Message::Close(Some(close))))
                                if matches!(u16::from(close.code), 4003 | 4004) =>
                            {
                                set_outgoing(&channel_id, None);
                                bridges().remove(&channel_id);
                                return;
                            }
                            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                            Some(Ok(_)) => {}
                        },
                    }
                }
                // What it was answering is lost with the socket; a new one starts afresh.
                set_outgoing(&channel_id, None);
            }
            Err(error) => {
                eprintln!(
                    "{} could not join page {page_id} to co-write it: {error}",
                    "⚠".yellow().bold()
                );
            }
        }
        if *stopped.borrow() {
            break;
        }
        let delay = REJOIN_DELAYS[attempt.min(REJOIN_DELAYS.len() - 1)];
        attempt += 1;
        tokio::select! {
            _ = stopped.changed() => {}
            _ = tokio::time::sleep(delay) => {}
        }
    }
}

fn set_outgoing(channel_id: &str, outgoing: Option<mpsc::UnboundedSender<Vec<u8>>>) {
    if let Some(bridge) = bridges().get_mut(channel_id) {
        if outgoing.is_none() {
            bridge.queued = None;
            bridge.answering = None;
        }
        bridge.outgoing = outgoing;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bridge_for_test(channel_id: &str) -> mpsc::UnboundedReceiver<Vec<u8>> {
        let (outgoing, frames) = mpsc::unbounded_channel();
        let (stop, _) = watch::channel(false);
        bridges().insert(
            channel_id.to_string(),
            Bridge {
                page: ("space".into(), "page".into()),
                outgoing: Some(outgoing),
                queued: None,
                answering: None,
                stop,
            },
        );
        frames
    }

    fn body(frame: Vec<u8>) -> serde_json::Value {
        serde_json::from_slice(&frame[2..]).unwrap()
    }

    #[test]
    fn the_harness_text_for_a_queued_turn_goes_to_the_page_with_its_end() {
        let channel = "c-co-write-stream";
        let mut frames = bridge_for_test(channel);
        // Text before the session's turn starts belongs to no turn of the page's.
        observe_trace(channel, "assistant_delta", &serde_json::json!({ "delta": "earlier" }));
        turn_queued(channel, 3);
        observe_trace(channel, "turn_started", &serde_json::json!({ "input": "…" }));
        observe_trace(channel, "assistant_delta", &serde_json::json!({ "delta": "⟦after \"x\"⟧" }));
        observe_trace(channel, "turn_started", &serde_json::json!({ "continued": true }));
        observe_trace(channel, "assistant_delta", &serde_json::json!({ "delta": "more" }));
        observe_trace(channel, "turn_completed", &serde_json::json!({}));
        observe_trace(channel, "assistant_delta", &serde_json::json!({ "delta": "after the end" }));
        let sent: Vec<_> = std::iter::from_fn(|| frames.try_recv().ok()).map(body).collect();
        assert_eq!(
            sent,
            vec![
                serde_json::json!({ "type": "delta", "turn": 3, "text": "⟦after \"x\"⟧" }),
                serde_json::json!({ "type": "delta", "turn": 3, "text": "more" }),
                serde_json::json!({ "type": "done", "turn": 3 }),
            ]
        );
        bridges().remove(channel);
    }

    #[test]
    fn a_turn_that_ends_without_saying_so_ends_when_the_next_starts() {
        let channel = "c-co-write-unended";
        let mut frames = bridge_for_test(channel);
        turn_queued(channel, 4);
        observe_trace(channel, "turn_started", &serde_json::json!({}));
        // A person's message in the conversation is the next turn; it is not the page's.
        observe_trace(channel, "turn_started", &serde_json::json!({}));
        observe_trace(channel, "assistant_delta", &serde_json::json!({ "delta": "a reply in chat" }));
        observe_trace(channel, "turn_failed", &serde_json::json!({}));
        let sent: Vec<_> = std::iter::from_fn(|| frames.try_recv().ok()).map(body).collect();
        assert_eq!(sent, vec![serde_json::json!({ "type": "done", "turn": 4 })]);
        bridges().remove(channel);
    }

    #[test]
    fn a_turn_stopped_from_the_conversation_ends_the_page_turn_at_once() {
        for (turn, phase) in [(5, "turn_interrupted"), (6, "turn_cancelled")] {
            let channel = format!("c-co-write-{phase}");
            let mut frames = bridge_for_test(&channel);
            turn_queued(&channel, turn);
            observe_trace(&channel, "turn_started", &serde_json::json!({}));
            observe_trace(&channel, phase, &serde_json::json!({}));
            assert_eq!(
                frames.try_recv().ok().map(body),
                Some(serde_json::json!({ "type": "done", "turn": turn })),
                "{phase} ends the page's turn"
            );
            bridges().remove(&channel);
        }
    }
}
