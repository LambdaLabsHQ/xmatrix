//! An Agent co-writing a page live, whatever its harness
//! (docs/design/pages-live-document.md §4.2).
//!
//! The Hub's `xmatrixPageCoWrite` instruction in a conversation starts a
//! bridge: this runtime joins the page's live session as its co-writer. Each
//! turn the session sends reaches the run loop as the harness's next input, a
//! resume of that conversation, so every backend runs it as it runs any turn.
//! The harness's text, which every backend already reports as `assistant_delta`
//! traces, streams back to the session with the turn's end. A new turn from the
//! session, or its interrupt, stops a turn still answering the page; any other
//! work it waits behind (see `event_requests_active_turn_interrupt_with_replay`).

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use colored::Colorize;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;
use xmatrix_cli_core::agent_instance_connection::{
    AgentInstanceConnectionClient, AgentInstanceConnectionEvent,
};
use xmatrix_cli_core::page_co_write::{
    PAGE_SESSION_HEARTBEAT_PING, PageCoWriteConnector, PageCoWriteEvent, PageCoWriteRequest,
    PageWriteOutbox, decode_request, send_due,
};
use xmatrix_cli_core::page_media::{ToPage, refused_images_note};
use xmatrix_cli_core::protocol::ChannelPageCoWrite;

/// Kept below the idle limits between here and the session.
const HEARTBEAT: Duration = Duration::from_secs(25);
/// A broken page connection must not hold the launch message indefinitely.
const INITIAL_TURN_WAIT: Duration = Duration::from_secs(10);
/// Waits before joining again after the socket closed or could not open.
const REJOIN_DELAYS: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(30),
];

/// What the bridge sends the session: the harness's words for a turn, and its
/// end. They go at the rate the session takes an Agent's words
/// (`PageWriteOutbox`).
#[derive(Debug, PartialEq, Eq)]
enum Out {
    Text { turn: u64, text: String },
    Done { turn: u64, failed: bool },
}

/// One conversation co-writing one page.
struct Bridge {
    channel_id: String,
    page: (String, String),
    /// What goes to the session, while a socket is open.
    outgoing: Option<mpsc::UnboundedSender<Out>>,
    /// The session's turn the run loop took as its next input; the harness's
    /// next turn in this conversation answers it.
    queued: Option<u64>,
    /// The session's turn the harness is answering now.
    answering: Option<u64>,
    /// The answer's images, each held until it is whole (`page_media`).
    images: ToPage,
    /// Where the Agent hears what of its answer did not reach the page.
    events: Option<mpsc::UnboundedSender<AgentInstanceConnectionEvent>>,
    /// A fresh co-writing launch answers the page in its first model turn,
    /// rather than running an ordinary invitation turn ahead of it.
    initial_tx: Option<oneshot::Sender<PageCoWriteEvent>>,
    initial_rx: Option<oneshot::Receiver<PageCoWriteEvent>>,
    stop: watch::Sender<bool>,
}

impl Bridge {
    fn send(&self, out: Out) {
        if let Some(outgoing) = &self.outgoing {
            let _ = outgoing.send(out);
        }
    }

    /// Ends the session's `turn` with the rest of the answer, and tells the
    /// Agent of any image of a local file left out of it.
    fn end(&mut self, turn: u64, failed: bool) {
        let rest = self.images.finish();
        if !rest.is_empty() {
            self.send(Out::Text { turn, text: rest });
        }
        self.send(Out::Done { turn, failed });
        let written = std::mem::take(&mut self.images);
        if let Some(events) = &self.events
            && !written.refused().is_empty()
        {
            let _ = events.send(AgentInstanceConnectionEvent::PageCoWrite(
                PageCoWriteEvent::Outcome {
                    channel_id: self.channel_id.clone(),
                    prompt: format!(
                        "[Page write] Not all you wrote into page:{} reached it: {}.",
                        self.page.1,
                        refused_images_note(written.refused())
                    ),
                },
            ));
        }
    }
}

static BRIDGES: LazyLock<Mutex<HashMap<String, Bridge>>> = LazyLock::new(Default::default);

fn bridges() -> std::sync::MutexGuard<'static, HashMap<String, Bridge>> {
    BRIDGES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Starts or ends co-writing as the Hub's instruction in `channel_id` says.
pub(crate) fn follow(
    relay: &AgentInstanceConnectionClient,
    channel_id: &str,
    instruction: &ChannelPageCoWrite,
    initial: bool,
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
    let (initial_tx, initial_rx) = if initial {
        let (tx, rx) = oneshot::channel();
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };
    all.insert(
        channel_id.to_string(),
        Bridge {
            channel_id: channel_id.to_string(),
            page: page.clone(),
            outgoing: None,
            queued: None,
            answering: None,
            images: ToPage::default(),
            events: Some(relay.local_event_sender()),
            initial_tx,
            initial_rx,
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

/// Fold the page's actual request into the launch input. The same first turn
/// then has the document, write protocol and streaming destination in every
/// harness, while retaining the human message and its execution attribution.
pub(crate) async fn initial_prompt(channel_id: &str) -> Option<String> {
    let initial = bridges().get_mut(channel_id)?.initial_rx.take()?;
    let Ok(Ok(PageCoWriteEvent::Turn {
        channel_id,
        turn,
        prompt,
    })) = tokio::time::timeout(INITIAL_TURN_WAIT, initial).await
    else {
        return None;
    };
    turn_queued(&channel_id, turn);
    Some(prompt)
}

/// The reserved first page request goes to startup once; later requests and
/// a first request arriving after startup timed out use the ordinary run loop.
fn deliver_event(
    events: &mpsc::UnboundedSender<AgentInstanceConnectionEvent>,
    event: PageCoWriteEvent,
) -> bool {
    let initial = if matches!(event, PageCoWriteEvent::Turn { .. }) {
        bridges()
            .get_mut(event.channel_id())
            .and_then(|bridge| bridge.initial_tx.take())
    } else {
        None
    };
    let event = if let Some(initial) = initial {
        match initial.send(event) {
            Ok(()) => return true,
            Err(event) => event,
        }
    } else {
        event
    };
    events
        .send(AgentInstanceConnectionEvent::PageCoWrite(event))
        .is_ok()
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
        "turn_started"
            if payload.get("continued").and_then(|value| value.as_bool()) != Some(true) =>
        {
            if let Some(turn) = bridge.answering.take() {
                bridge.end(turn, false);
            }
            bridge.answering = bridge.queued.take();
        }
        "assistant_delta" => {
            if let (Some(turn), Some(text)) = (
                bridge.answering,
                payload.get("delta").and_then(|value| value.as_str()),
            ) && !text.is_empty()
            {
                let text = bridge.images.push(text);
                if !text.is_empty() {
                    bridge.send(Out::Text { turn, text });
                }
            }
        }
        // A turn stopped from the conversation (a chat message, a model switch) is cancelled; it ends the
        // page's turn there and then, or the page would wait on it and never ask the Agent again.
        "turn_completed" | "turn_failed" | "turn_interrupted" | "turn_cancelled" => {
            if let Some(turn) = bridge.answering.take() {
                bridge.end(turn, phase == "turn_failed");
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
                let (outgoing, mut frames) = mpsc::unbounded_channel::<Out>();
                set_outgoing(&channel_id, Some(outgoing));
                let mut heartbeat = tokio::time::interval(HEARTBEAT);
                heartbeat.tick().await;
                let mut outbox = PageWriteOutbox::default();
                loop {
                    // Everything the rate lets go now goes, and the loop wakes when more may.
                    let Ok(due) = send_due(&mut outbox, &mut sink).await else {
                        break;
                    };
                    let due = due.map(tokio::time::Instant::from_std);
                    tokio::select! {
                        _ = stopped.changed() => {
                            let _ = sink.close().await;
                            break;
                        }
                        () = tokio::time::sleep_until(due.unwrap_or_else(tokio::time::Instant::now)), if due.is_some() => {}
                        Some(out) = frames.recv() => match out {
                            Out::Text { turn, text } => outbox.text(turn, &text),
                            Out::Done { turn, failed } => outbox.done(turn, failed),
                        },
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
                                        PageCoWriteRequest::Interrupt { turn } => {
                                            outbox.stop(turn);
                                            PageCoWriteEvent::Interrupt { channel_id: channel_id.clone(), turn }
                                        }
                                        PageCoWriteRequest::Limited { turn, at, retry_after_ms } => {
                                            outbox.limited(turn, at, Duration::from_millis(retry_after_ms), std::time::Instant::now());
                                            continue;
                                        }
                                        // Only a turn this side opened has an outcome, and the bridge opens none.
                                        PageCoWriteRequest::Outcome { .. } => continue,
                                    };
                                    if !deliver_event(&events, event) {
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

fn set_outgoing(channel_id: &str, outgoing: Option<mpsc::UnboundedSender<Out>>) {
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

    fn bridge_for_test(channel_id: &str) -> mpsc::UnboundedReceiver<Out> {
        let (outgoing, frames) = mpsc::unbounded_channel();
        let (stop, _) = watch::channel(false);
        bridges().insert(
            channel_id.to_string(),
            Bridge {
                channel_id: channel_id.to_string(),
                page: ("space".into(), "page".into()),
                outgoing: Some(outgoing),
                queued: None,
                answering: None,
                images: ToPage::default(),
                events: None,
                initial_tx: None,
                initial_rx: None,
                stop,
            },
        );
        frames
    }

    fn body(out: Out) -> serde_json::Value {
        match out {
            Out::Text { turn, text } => {
                serde_json::json!({ "type": "delta", "turn": turn, "text": text })
            }
            Out::Done { turn, failed } => {
                serde_json::json!({ "type": if failed { "failed" } else { "done" }, "turn": turn })
            }
        }
    }

    fn initial_bridge_for_test(channel: &str) -> mpsc::UnboundedReceiver<Out> {
        let frames = bridge_for_test(channel);
        let (initial_tx, initial_rx) = oneshot::channel();
        let mut all = bridges();
        let bridge = all.get_mut(channel).unwrap();
        bridge.initial_tx = Some(initial_tx);
        bridge.initial_rx = Some(initial_rx);
        frames
    }

    // Existing trace tests start after a page turn was queued. This protects
    // the missing startup boundary: the invitation's very first prompt must
    // already carry the page request, and its first words must stream there.
    #[test]
    fn a_co_writing_launch_answers_the_page_in_its_first_model_turn() {
        let _guard = crate::tests::test_process_env_lock();
        let channel = "c-co-write-initial";
        let mut frames = initial_bridge_for_test(channel);
        let (events, mut pending) = mpsc::unbounded_channel();
        assert!(deliver_event(
            &events,
            PageCoWriteEvent::Turn {
                channel_id: channel.into(),
                turn: 1,
                prompt: "[Live co-writing] You joined this page.\n⟦after \"Plan\"⟧\n# Plan".into(),
            }
        ));
        let keys = [
            "XMATRIX_AUTO_JOIN_CHANNEL_ID",
            "XMATRIX_INITIAL_MESSAGE",
            "XMATRIX_RESUME_REQUESTED",
        ];
        let previous = keys.map(std::env::var_os);
        unsafe {
            std::env::set_var(keys[0], channel);
            std::env::set_var(keys[1], "@claude launch:force page:page");
            std::env::remove_var(keys[2]);
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let prompt = runtime.block_on(crate::runtime_resume_input::initial_runtime_turn());
        for (key, value) in keys.into_iter().zip(previous) {
            unsafe {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
        assert_eq!(
            prompt.as_deref(),
            Some(
                "@claude launch:force page:page\n\n[Live co-writing] You joined this page.\n⟦after \"Plan\"⟧\n# Plan"
            )
        );
        assert!(
            pending.try_recv().is_err(),
            "no second invitation turn waits behind startup"
        );
        observe_trace(channel, "turn_started", &serde_json::json!({}));
        observe_trace(
            channel,
            "assistant_delta",
            &serde_json::json!({ "delta": "⟦after \"Plan\"⟧Next." }),
        );
        observe_trace(channel, "turn_completed", &serde_json::json!({}));
        assert_eq!(
            frames.try_recv().ok().map(body),
            Some(serde_json::json!({
                "type": "delta", "turn": 1, "text": "⟦after \"Plan\"⟧Next."
            }))
        );
        assert_eq!(
            frames.try_recv().ok().map(body),
            Some(serde_json::json!({ "type": "done", "turn": 1 }))
        );
        assert!(deliver_event(
            &events,
            PageCoWriteEvent::Turn {
                channel_id: channel.into(),
                turn: 2,
                prompt: "People paused.".into(),
            }
        ));
        assert!(matches!(
            pending.try_recv(),
            Ok(AgentInstanceConnectionEvent::PageCoWrite(
                PageCoWriteEvent::Turn { turn: 2, .. }
            ))
        ));
        bridges().remove(channel);
    }

    #[tokio::test(start_paused = true)]
    async fn a_late_initial_page_request_survives_the_bounded_startup_wait() {
        let channel = "c-co-write-late-initial";
        let _frames = initial_bridge_for_test(channel);
        assert!(initial_prompt(channel).await.is_none());
        let (events, mut pending) = mpsc::unbounded_channel();
        assert!(deliver_event(
            &events,
            PageCoWriteEvent::Turn {
                channel_id: channel.into(),
                turn: 3,
                prompt: "Connected later.".into(),
            }
        ));
        assert!(matches!(
            pending.try_recv(),
            Ok(AgentInstanceConnectionEvent::PageCoWrite(
                PageCoWriteEvent::Turn { turn: 3, .. }
            ))
        ));
        assert!(initial_prompt("ordinary-chat").await.is_none());
        bridges().remove(channel);
    }

    #[test]
    fn the_harness_text_for_a_queued_turn_goes_to_the_page_with_its_end() {
        let channel = "c-co-write-stream";
        let mut frames = bridge_for_test(channel);
        // Text before the session's turn starts belongs to no turn of the page's.
        observe_trace(
            channel,
            "assistant_delta",
            &serde_json::json!({ "delta": "earlier" }),
        );
        turn_queued(channel, 3);
        observe_trace(
            channel,
            "turn_started",
            &serde_json::json!({ "input": "…" }),
        );
        observe_trace(
            channel,
            "assistant_delta",
            &serde_json::json!({ "delta": "⟦after \"x\"⟧" }),
        );
        observe_trace(
            channel,
            "turn_started",
            &serde_json::json!({ "continued": true }),
        );
        observe_trace(
            channel,
            "assistant_delta",
            &serde_json::json!({ "delta": "more" }),
        );
        observe_trace(channel, "turn_completed", &serde_json::json!({}));
        observe_trace(
            channel,
            "assistant_delta",
            &serde_json::json!({ "delta": "after the end" }),
        );
        let sent: Vec<_> = std::iter::from_fn(|| frames.try_recv().ok())
            .map(body)
            .collect();
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
        observe_trace(
            channel,
            "assistant_delta",
            &serde_json::json!({ "delta": "a reply in chat" }),
        );
        observe_trace(channel, "turn_failed", &serde_json::json!({}));
        let sent: Vec<_> = std::iter::from_fn(|| frames.try_recv().ok())
            .map(body)
            .collect();
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

    #[test]
    fn the_page_stops_only_a_turn_answering_it() {
        let channel = "c-co-write-other-work";
        let _frames = bridge_for_test(channel);
        let asks = AgentInstanceConnectionEvent::PageCoWrite(PageCoWriteEvent::Turn {
            channel_id: channel.to_string(),
            turn: 7,
            prompt: "the page changed".to_string(),
        });
        let edited = AgentInstanceConnectionEvent::PageCoWrite(PageCoWriteEvent::Interrupt {
            channel_id: channel.to_string(),
            turn: 7,
        });
        // The conversation's own work is running: the page waits for it.
        observe_trace(channel, "turn_started", &serde_json::json!({}));
        for event in [&asks, &edited] {
            assert!(!crate::event_requests_active_turn_interrupt(
                event,
                Some(channel),
                None
            ));
        }
        // A turn answering the page is stopped by its next ask, or an edit.
        observe_trace(channel, "turn_completed", &serde_json::json!({}));
        turn_queued(channel, 7);
        observe_trace(channel, "turn_started", &serde_json::json!({}));
        for event in [&asks, &edited] {
            assert!(crate::event_requests_active_turn_interrupt(
                event,
                Some(channel),
                None
            ));
        }
        bridges().remove(channel);
    }
}
