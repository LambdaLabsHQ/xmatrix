//! The wire between an Agent's runtime and a page's live session while the
//! Agent co-writes the page (docs/design/pages-live-document.md §4.2). The
//! runtime joins as the page's co-writer, not as a replica of the document:
//! the session sends it turns, and it answers with its harness's text as the
//! harness writes it. Frames are the session's own: a varint type, then a
//! varint-prefixed UTF-8 JSON body (lib0 encoding).

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::http::HeaderValue;

use crate::error::{CliError, Result};
use crate::http;
use crate::websocket::{self, ClientWebSocket, connection_host};

/// A frame carrying co-writing JSON, after the session's sync (0), awareness
/// (1) and notices (2).
pub(crate) const PAGE_MESSAGE_CO_WRITE: u64 = 3;
/// Answered by the session's host without waking it; a socket that sends it
/// now and then stays open while the Agent is quiet.
pub const PAGE_SESSION_HEARTBEAT_PING: &str = "ping";
/// The document fragment the session edits; a client naming another is told
/// it is out of date.
const PAGE_DOCUMENT_FRAGMENT: &str = "prosemirror";

/// Where an Agent's words go into a page: `⟦write page:<id>⟧`, then the page's
/// markers, then `⟦/write⟧`.
pub const PAGE_WRITE_OPEN: &str = "⟦write page:";
pub const PAGE_WRITE_CLOSE: &str = "⟦/write⟧";
/// How long a page's session is waited on to say what became of a write.
const WRITE_OUTCOME_WAIT: Duration = Duration::from_secs(15);

/// The page `⟦write page:<id>⟧` names: a page id as the Hub names pages (a
/// UUID), quoted or not; anything else names no page.
pub fn page_write_target(raw: &str) -> Option<String> {
    let id = raw.trim().trim_matches(['"', '\'', '`']).trim();
    let groups: Vec<&str> = id.split('-').collect();
    let shaped = groups.len() == 5
        && groups
            .iter()
            .zip([8usize, 4, 4, 4, 12])
            .all(|(group, length)| {
                group.len() == length && group.chars().all(|c| c.is_ascii_hexdigit())
            });
    shaped.then(|| id.to_ascii_lowercase())
}

/// A whole text, such as a message, as what it says and what it writes into pages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageWritePart {
    Text(String),
    /// What stood between `⟦write page:<page>⟧` and `⟦/write⟧`, or the text's end.
    Write {
        page: String,
        body: String,
    },
}

/// Splits `text` at each `⟦write page:<id>⟧ … ⟦/write⟧`. A marker that names no
/// page is text like any other.
pub fn page_write_parts(text: &str) -> Vec<PageWritePart> {
    let mut parts = Vec::new();
    let mut plain = String::new();
    let mut rest = text;
    while let Some(at) = rest.find(PAGE_WRITE_OPEN) {
        let after = &rest[at + PAGE_WRITE_OPEN.len()..];
        let Some((page, body)) = after.find('⟧').and_then(|end| {
            page_write_target(&after[..end]).map(|page| (page, &after[end + '⟧'.len_utf8()..]))
        }) else {
            plain.push_str(&rest[..at + PAGE_WRITE_OPEN.len()]);
            rest = after;
            continue;
        };
        plain.push_str(&rest[..at]);
        if !plain.is_empty() {
            parts.push(PageWritePart::Text(std::mem::take(&mut plain)));
        }
        let (inner, next) = match body.find(PAGE_WRITE_CLOSE) {
            Some(close) => (&body[..close], &body[close + PAGE_WRITE_CLOSE.len()..]),
            None => (body, ""),
        };
        parts.push(PageWritePart::Write {
            page,
            body: inner.to_string(),
        });
        rest = next;
    }
    plain.push_str(rest);
    if !plain.is_empty() {
        parts.push(PageWritePart::Text(plain));
    }
    parts
}

/// What a page's live session asks of the Agent co-writing it, as it reaches
/// the Agent's run loop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageCoWriteEvent {
    /// The harness's next input: what changed on the page, and how to answer.
    Turn {
        channel_id: String,
        turn: u64,
        prompt: String,
    },
    /// Someone edited what the Agent was writing: its turn stops there.
    Interrupt { channel_id: String, turn: u64 },
    /// What the Agent wrote into a page from its conversation did not all
    /// reach it: the harness hears why once its turn is over. It stops no turn.
    Outcome { channel_id: String, prompt: String },
}

impl PageCoWriteEvent {
    /// The co-writing conversation the request is for.
    pub fn channel_id(&self) -> &str {
        match self {
            Self::Turn { channel_id, .. }
            | Self::Interrupt { channel_id, .. }
            | Self::Outcome { channel_id, .. } => channel_id,
        }
    }
}

/// A request as the session sends it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PageCoWriteRequest {
    Turn {
        turn: u64,
        text: String,
    },
    Interrupt {
        turn: u64,
    },
    /// The end of a turn the runtime opened itself (`write_frame`): what of it
    /// did not reach the page, and why; empty when all of it did.
    Outcome {
        turn: u64,
        problems: Vec<String>,
    },
    /// A paced write the session refused, as an HTTP 429 refuses: it took
    /// nothing of it. The turn's words go again from character `at` once
    /// `retry_after_ms` has passed (`PageWriteOutbox::limited`).
    Limited {
        turn: u64,
        at: usize,
        #[serde(rename = "retryAfterMs")]
        retry_after_ms: u64,
    },
}

/// The session's request in a frame, or `None` for any other frame.
pub fn decode_request(frame: &[u8]) -> Option<PageCoWriteRequest> {
    let (kind, rest) = read_var_uint(frame)?;
    if kind != PAGE_MESSAGE_CO_WRITE {
        return None;
    }
    let (length, rest) = read_var_uint(rest)?;
    let body = rest.get(..usize::try_from(length).ok()?)?;
    serde_json::from_slice(body).ok()
}

/// Opens `turn` from this side: the Agent writes into the page from its
/// conversation, and the session, which asks a streaming co-writer nothing,
/// takes what follows as that turn's words. `at_once` for a message's write,
/// whose words are all there already: they go whole, not paced.
pub fn write_frame(turn: u64, at_once: bool) -> Vec<u8> {
    if at_once {
        frame(&serde_json::json!({ "type": "write", "turn": turn, "atOnce": true }))
    } else {
        frame(&serde_json::json!({ "type": "write", "turn": turn }))
    }
}

/// Some of the harness's text for `turn`, as it came.
pub fn delta_frame(turn: u64, text: &str) -> Vec<u8> {
    frame(&serde_json::json!({ "type": "delta", "turn": turn, "text": text }))
}

/// The end of the harness's turn; `failed` when it ended in an error.
pub fn done_frame(turn: u64, failed: bool) -> Vec<u8> {
    frame(&serde_json::json!({ "type": if failed { "failed" } else { "done" }, "turn": turn }))
}

/// How fast a page's session takes an Agent's live words, in characters of
/// what is sent (`PAGE_CO_WRITE_RATE` in `@xmatrix/protocol`): at most this
/// many at a time,
pub const PAGE_WRITE_CHUNK_CHARS: usize = 10;
/// and this many a second on average.
pub const PAGE_WRITE_CHARS_PER_SECOND: f64 = 20.0;
/// The turns whose words are kept after they were sent, in case the session
/// refuses one of their writes.
const PAGE_WRITE_KEPT_TURNS: usize = 8;

/// What a runtime sends a page's session while its Agent writes into it live,
/// in order, at the rate the session takes an Agent's words
/// (docs/design/pages-live-document.md §4.2). A turn's text goes in chunks of
/// at most `PAGE_WRITE_CHUNK_CHARS`, `PAGE_WRITE_CHARS_PER_SECOND` on
/// average, each saying where it starts; an image's markdown goes whole. What
/// has not gone yet is still the Agent's own: the page holds what was sent,
/// the moment it is sent, and nothing waits on its side to be shown later.
/// A write the session refuses (`limited`) goes again from where the session
/// says, when it says.
#[derive(Default)]
pub struct PageWriteOutbox {
    queue: VecDeque<Outgoing>,
    /// Each recent turn's characters as sent so far.
    sent: HashMap<u64, Vec<char>>,
    /// Recent turns, oldest first, whose characters are kept.
    order: VecDeque<u64>,
    /// Turns whose end was sent.
    ended: HashMap<u64, bool>,
    /// Turns the session stopped: nothing more of them goes.
    stopped: HashSet<u64>,
    /// When the next chunk may go.
    next_at: Option<Instant>,
}

enum Outgoing {
    Frame(Vec<u8>),
    Text { turn: u64, text: Vec<char> },
    Done { turn: u64, failed: bool },
}

/// What a runtime does next with its `PageWriteOutbox`.
#[derive(Debug, PartialEq, Eq)]
pub enum PageWriteNext {
    /// Send this frame now.
    Send(Vec<u8>),
    /// Nothing may go before then.
    Wait(Instant),
    /// Nothing to send.
    Idle,
}

impl PageWriteOutbox {
    /// A frame that goes in its place, as it is (opening a turn).
    pub fn frame(&mut self, frame: Vec<u8>) {
        self.queue.push_back(Outgoing::Frame(frame));
    }

    /// Some of the Agent's words for `turn`.
    pub fn text(&mut self, turn: u64, text: &str) {
        if text.is_empty() || self.stopped.contains(&turn) {
            return;
        }
        if let Some(Outgoing::Text {
            turn: last,
            text: queued,
        }) = self.queue.back_mut()
            && *last == turn
        {
            queued.extend(text.chars());
            return;
        }
        self.keep(turn);
        self.queue.push_back(Outgoing::Text {
            turn,
            text: text.chars().collect(),
        });
    }

    /// The end of `turn`, once all its words have gone.
    pub fn done(&mut self, turn: u64, failed: bool) {
        self.keep(turn);
        self.queue.push_back(Outgoing::Done { turn, failed });
    }

    /// The session stopped `turn`: what of its words has not gone is dropped.
    pub fn stop(&mut self, turn: u64) {
        self.stopped.insert(turn);
        self.queue
            .retain(|item| !matches!(item, Outgoing::Text { turn: of, .. } if *of == turn));
    }

    /// The session refused a write of `turn`: it has its words up to `at`. They
    /// go again from there, and its end after them, once `retry_after` has
    /// passed.
    pub fn limited(&mut self, turn: u64, at: usize, retry_after: Duration, now: Instant) {
        if self.stopped.contains(&turn) {
            return;
        }
        let Some(sent) = self.sent.get_mut(&turn) else {
            return;
        };
        let again: Vec<char> = if at < sent.len() {
            sent.split_off(at)
        } else {
            Vec::new()
        };
        let ended = self.ended.remove(&turn);
        let mut rest = VecDeque::new();
        self.queue.retain(|item| match item {
            Outgoing::Text { turn: of, .. } | Outgoing::Done { turn: of, .. } if *of == turn => {
                rest.push_back(match item {
                    Outgoing::Text { text, .. } => Outgoing::Text {
                        turn,
                        text: text.clone(),
                    },
                    Outgoing::Done { failed, .. } => Outgoing::Done {
                        turn,
                        failed: *failed,
                    },
                    Outgoing::Frame(_) => unreachable!(),
                });
                false
            }
            _ => true,
        });
        if let Some(failed) = ended {
            rest.push_back(Outgoing::Done { turn, failed });
        }
        if !again.is_empty() {
            match rest.front_mut() {
                Some(Outgoing::Text { text, .. }) => {
                    let mut joined = again;
                    joined.append(text);
                    *text = joined;
                }
                _ => rest.push_front(Outgoing::Text { turn, text: again }),
            }
        }
        for item in rest.into_iter().rev() {
            self.queue.push_front(item);
        }
        let until = now + retry_after;
        self.next_at = Some(self.next_at.map_or(until, |at| at.max(until)));
    }

    /// Whether everything has gone.
    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    /// The next frame to send at `now`, or when one may go.
    pub fn next(&mut self, now: Instant) -> PageWriteNext {
        let Some(item) = self.queue.front_mut() else {
            return PageWriteNext::Idle;
        };
        match item {
            Outgoing::Frame(_) => {
                let Some(Outgoing::Frame(frame)) = self.queue.pop_front() else {
                    unreachable!()
                };
                PageWriteNext::Send(frame)
            }
            Outgoing::Done { .. } => {
                let Some(Outgoing::Done { turn, failed }) = self.queue.pop_front() else {
                    unreachable!()
                };
                self.ended.insert(turn, failed);
                let at = self.sent.get(&turn).map_or(0, Vec::len);
                PageWriteNext::Send(frame(&serde_json::json!({
                    "type": if failed { "failed" } else { "done" }, "turn": turn, "paced": { "at": at },
                })))
            }
            Outgoing::Text { turn, text } => {
                if let Some(at) = self.next_at
                    && now < at
                {
                    return PageWriteNext::Wait(at);
                }
                let turn = *turn;
                let size = chunk_len(text);
                let chunk: Vec<char> = text.drain(..size).collect();
                if text.is_empty() {
                    self.queue.pop_front();
                }
                let sent = self.sent.entry(turn).or_default();
                let at = sent.len();
                sent.extend(&chunk);
                let chunk: String = chunk.into_iter().collect();
                // A chunk larger than a chunk (an image) costs a whole allowance.
                let cost = size.min(PAGE_WRITE_CHUNK_CHARS * 2) as f64;
                self.next_at =
                    Some(now + Duration::from_secs_f64(cost / PAGE_WRITE_CHARS_PER_SECOND));
                PageWriteNext::Send(frame(&serde_json::json!({
                    "type": "delta", "turn": turn, "text": chunk, "paced": { "at": at },
                })))
            }
        }
    }

    /// Keeps `turn`'s characters as they are sent, and forgets the oldest turns'.
    fn keep(&mut self, turn: u64) {
        if self.order.contains(&turn) {
            return;
        }
        self.order.push_back(turn);
        while self.order.len() > PAGE_WRITE_KEPT_TURNS {
            if let Some(old) = self.order.pop_front() {
                self.sent.remove(&old);
                self.ended.remove(&old);
                self.stopped.remove(&old);
            }
        }
    }
}

/// Sends on `sink` everything `outbox` lets go now. Answers when more may go
/// (`None`: nothing is waiting), or the socket's error.
pub async fn send_due<S>(
    outbox: &mut PageWriteOutbox,
    sink: &mut S,
) -> std::result::Result<Option<Instant>, S::Error>
where
    S: futures_util::Sink<Message> + Unpin,
{
    loop {
        match outbox.next(Instant::now()) {
            PageWriteNext::Send(frame) => sink.send(Message::Binary(frame.into())).await?,
            PageWriteNext::Wait(at) => return Ok(Some(at)),
            PageWriteNext::Idle => return Ok(None),
        }
    }
}

/// How many of `text`'s characters go in the next chunk: at most
/// `PAGE_WRITE_CHUNK_CHARS`, never cutting into an image's markdown, which
/// goes whole on its own (`![…](…)`).
fn chunk_len(text: &[char]) -> usize {
    if text.starts_with(&['!', '[']) {
        let mut depth = 0usize;
        let mut in_target = false;
        for (index, &char) in text.iter().enumerate().skip(2) {
            match (in_target, char) {
                (false, ']') if index + 1 < text.len() && text[index + 1] == '(' => {
                    in_target = true
                }
                (true, '(') => depth += 1,
                (true, ')') if depth <= 1 => return index + 1,
                (true, ')') => depth -= 1,
                _ => {}
            }
        }
    }
    let limit = text.len().min(PAGE_WRITE_CHUNK_CHARS);
    // An image that starts within the chunk starts the next one.
    (1..limit)
        .find(|&index| text[index] == '!' && text.get(index + 1) == Some(&'['))
        .unwrap_or(limit)
}

fn frame(reply: &serde_json::Value) -> Vec<u8> {
    let body = reply.to_string();
    let mut out = Vec::with_capacity(body.len() + 6);
    write_var_uint(&mut out, PAGE_MESSAGE_CO_WRITE);
    write_var_uint(&mut out, body.len() as u64);
    out.extend_from_slice(body.as_bytes());
    out
}

fn read_var_uint(bytes: &[u8]) -> Option<(u64, &[u8])> {
    let mut value = 0u64;
    for (index, byte) in bytes.iter().enumerate().take(10) {
        value |= u64::from(byte & 0x7f) << (7 * index);
        if byte & 0x80 == 0 {
            return Some((value, &bytes[index + 1..]));
        }
    }
    None
}

fn write_var_uint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

/// How a runtime reaches a page's live session as its Run: the Hub it is
/// connected to and the token it is connected with, renewed in place.
#[derive(Clone)]
pub struct PageCoWriteConnector {
    relay_url: String,
    token: Arc<RwLock<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveTicket {
    protocol: String,
    socket_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageSpace {
    space_id: String,
}

impl PageCoWriteConnector {
    pub fn new(relay_url: String, token: Arc<RwLock<String>>) -> Self {
        Self { relay_url, token }
    }

    fn token(&self) -> Result<String> {
        Ok(self
            .token
            .read()
            .map_err(|_| CliError::Relay("Auth token state poisoned".into()))?
            .clone())
    }

    /// The Space whose pages a conversation writes in.
    pub async fn page_space(&self, channel_id: &str) -> Result<String> {
        let (secure, host) = connection_host(&self.relay_url);
        let url = format!(
            "{}://{host}/api/channels/{}/page-space",
            if secure { "https" } else { "http" },
            urlencoding::encode(channel_id)
        );
        let space: PageSpace = http::request_json(&url, "GET", Some(&self.token()?), None).await?;
        Ok(space.space_id)
    }

    /// Joins the page's live session as its co-writer. The Hub refuses a Run
    /// that may not edit the page, and a page that takes Agent edits only as
    /// suggestions. One that `streams` writes from its conversation: it opens
    /// its own turns and is asked nothing.
    pub async fn connect(
        &self,
        space_id: &str,
        page_id: &str,
        streams: bool,
    ) -> Result<ClientWebSocket> {
        let (secure, host) = connection_host(&self.relay_url);
        let token = self.token()?;
        let url = format!(
            "{}://{host}/api/spaces/{}/pages/{}/live",
            if secure { "https" } else { "http" },
            urlencoding::encode(space_id),
            urlencoding::encode(page_id)
        );
        let mut body = serde_json::json!({ "document": PAGE_DOCUMENT_FRAGMENT, "coWrite": true });
        if streams {
            body["stream"] = true.into();
        }
        let ticket: LiveTicket = http::request_json(&url, "POST", Some(&token), Some(body)).await?;
        if !ticket.socket_path.starts_with("/ws/pages/") {
            return Err(CliError::Relay(
                "The page session named an unexpected socket".into(),
            ));
        }
        let socket = format!(
            "{}://{host}{}",
            if secure { "wss" } else { "ws" },
            ticket.socket_path
        );
        let mut request =
            http::websocket_request(&socket, http::process_client_component()).await?;
        request.headers_mut().insert(
            "sec-websocket-protocol",
            HeaderValue::from_str(&ticket.protocol)
                .map_err(|_| CliError::Relay("The page session ticket is not a header".into()))?,
        );
        websocket::connect(request).await
    }

    /// Writes `body`, the page's markers and their words, into `page` from the
    /// conversation `channel_id` in one turn, as a streamed write would but all
    /// at once, and says what of it did not reach the page; nothing when all of
    /// it did.
    /// An image of a local file is left out of it, and said to be (`page_media`).
    pub async fn write_once(
        &self,
        channel_id: &str,
        page: &str,
        body: &str,
    ) -> Result<Vec<String>> {
        let (body, refused) = crate::page_media::to_page(body, Default::default());
        let space = self.page_space(channel_id).await?;
        let socket = self.connect(&space, page, true).await?;
        let (mut sink, mut stream) = socket.split();
        for frame in [
            write_frame(1, true),
            delta_frame(1, &body),
            done_frame(1, false),
        ] {
            sink.send(Message::Binary(frame.into()))
                .await
                .map_err(|error| CliError::Relay(format!("The page session closed: {error}")))?;
        }
        let outcome = tokio::time::timeout(WRITE_OUTCOME_WAIT, async {
            while let Some(frame) = stream.next().await {
                if let Ok(Message::Binary(data)) = frame
                    && let Some(PageCoWriteRequest::Outcome {
                        turn: 1,
                        mut problems,
                    }) = decode_request(&data)
                {
                    if !refused.is_empty() {
                        problems.push(format!(
                            "Not written: {}.",
                            crate::page_media::refused_images_note(&refused)
                        ));
                    }
                    return Ok(problems);
                }
            }
            Err(CliError::Relay(
                "The page session closed before saying what was written".into(),
            ))
        })
        .await;
        let _ = sink.close().await;
        outcome
            .map_err(|_| CliError::Relay("The page session did not say what was written".into()))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_frame(json: &str) -> Vec<u8> {
        let mut out = vec![];
        write_var_uint(&mut out, PAGE_MESSAGE_CO_WRITE);
        write_var_uint(&mut out, json.len() as u64);
        out.extend_from_slice(json.as_bytes());
        out
    }

    #[test]
    fn reads_the_sessions_requests_and_nothing_else() {
        let long = format!(
            r#"{{"type":"turn","turn":2,"text":"{}"}}"#,
            "页".repeat(100)
        );
        assert_eq!(
            decode_request(&session_frame(&long)),
            Some(PageCoWriteRequest::Turn {
                turn: 2,
                text: "页".repeat(100)
            }),
            "a body longer than one varint byte"
        );
        assert_eq!(
            decode_request(&session_frame(r#"{"type":"interrupt","turn":2}"#)),
            Some(PageCoWriteRequest::Interrupt { turn: 2 })
        );
        assert_eq!(
            decode_request(&session_frame(
                r#"{"type":"outcome","turn":3,"problems":["Your ⟦after⟧ quoted \"x\", which is not on the page."]}"#
            )),
            Some(PageCoWriteRequest::Outcome {
                turn: 3,
                problems: vec!["Your ⟦after⟧ quoted \"x\", which is not on the page.".into()]
            })
        );
        assert_eq!(decode_request(&[0, 1, 2]), None, "a sync frame");
        assert_eq!(decode_request(&session_frame(r#"{"type":"other"}"#)), None);
        let mut cut = session_frame(r#"{"type":"interrupt","turn":2}"#);
        cut.truncate(cut.len() - 3);
        assert_eq!(decode_request(&cut), None, "a cut frame");
    }

    #[test]
    fn splits_a_text_into_what_it_says_and_what_it_writes_into_pages() {
        let page = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
        assert_eq!(
            page_write_parts(&format!(
                "Done.\n⟦write page:\"{page}\"⟧\n⟦after \"x\"⟧\nhi\n⟦/write⟧\nThanks"
            )),
            vec![
                PageWritePart::Text("Done.\n".into()),
                PageWritePart::Write {
                    page: page.into(),
                    body: "\n⟦after \"x\"⟧\nhi\n".into()
                },
                PageWritePart::Text("\nThanks".into()),
            ]
        );
        assert_eq!(
            page_write_parts(&format!("⟦write page:{page}⟧ to the end")),
            vec![PageWritePart::Write {
                page: page.into(),
                body: " to the end".into()
            }],
            "an unclosed write runs to the text's end"
        );
        assert_eq!(
            page_write_parts("Use ⟦write page:<id>⟧ … ⟦/write⟧ in a reply."),
            vec![PageWritePart::Text(
                "Use ⟦write page:<id>⟧ … ⟦/write⟧ in a reply.".into()
            )],
            "a marker naming no page is text"
        );
        assert_eq!(
            page_write_target(" 3F2A9C1E-5B7D-4E8F-9A0B-1C2D3E4F5A6B "),
            Some(page.into())
        );
        assert_eq!(page_write_target("page-1"), None);
    }

    #[test]
    fn answers_in_the_sessions_framing() {
        let frame = delta_frame(7, "⟦after \"x\"⟧\nhi");
        let (kind, rest) = read_var_uint(&frame).unwrap();
        assert_eq!(kind, PAGE_MESSAGE_CO_WRITE);
        let (length, rest) = read_var_uint(rest).unwrap();
        assert_eq!(length as usize, rest.len());
        let body: serde_json::Value = serde_json::from_slice(rest).unwrap();
        assert_eq!(
            body,
            serde_json::json!({ "type": "delta", "turn": 7, "text": "⟦after \"x\"⟧\nhi" })
        );
        let done: serde_json::Value = serde_json::from_slice(&done_frame(7, true)[2..]).unwrap();
        assert_eq!(done, serde_json::json!({ "type": "failed", "turn": 7 }));
        let write: serde_json::Value = serde_json::from_slice(&write_frame(8, false)[2..]).unwrap();
        assert_eq!(write, serde_json::json!({ "type": "write", "turn": 8 }));
        let at_once: serde_json::Value =
            serde_json::from_slice(&write_frame(9, true)[2..]).unwrap();
        assert_eq!(
            at_once,
            serde_json::json!({ "type": "write", "turn": 9, "atOnce": true })
        );
    }

    fn body(frame: &[u8]) -> serde_json::Value {
        let (_, rest) = read_var_uint(frame).unwrap();
        let (_, rest) = read_var_uint(rest).unwrap();
        serde_json::from_slice(rest).unwrap()
    }

    /// Sends everything the outbox lets go at `now`, and when it may go on.
    fn drain(
        outbox: &mut PageWriteOutbox,
        now: Instant,
    ) -> (Vec<serde_json::Value>, PageWriteNext) {
        let mut sent = vec![];
        loop {
            match outbox.next(now) {
                PageWriteNext::Send(frame) => sent.push(body(&frame)),
                other => return (sent, other),
            }
        }
    }

    #[test]
    fn reads_a_refused_write() {
        assert_eq!(
            decode_request(&session_frame(
                r#"{"type":"limited","turn":4,"at":25,"retryAfterMs":250}"#
            )),
            Some(PageCoWriteRequest::Limited {
                turn: 4,
                at: 25,
                retry_after_ms: 250
            })
        );
    }

    #[test]
    fn sends_a_turns_words_ten_at_a_time_at_the_sessions_rate() {
        let start = Instant::now();
        let mut outbox = PageWriteOutbox::default();
        outbox.frame(write_frame(1, false));
        outbox.text(1, "⟦after \"x\"⟧\n");
        outbox.text(1, "会议马上开始，请大家准备好材料。");
        outbox.done(1, false);
        let (sent, next) = drain(&mut outbox, start);
        assert_eq!(sent[0], serde_json::json!({ "type": "write", "turn": 1 }));
        assert_eq!(
            sent[1],
            serde_json::json!({ "type": "delta", "turn": 1, "text": "⟦after \"x\"", "paced": { "at": 0 } })
        );
        assert_eq!(sent.len(), 2, "one chunk at a time");
        assert_eq!(
            next,
            PageWriteNext::Wait(start + Duration::from_millis(500))
        );
        let mut now = start;
        let mut words = String::new();
        let mut ends = vec![];
        loop {
            match outbox.next(now) {
                PageWriteNext::Send(frame) => {
                    let frame = body(&frame);
                    if frame["type"] == "delta" {
                        assert!(
                            frame["text"].as_str().unwrap().chars().count()
                                <= PAGE_WRITE_CHUNK_CHARS
                        );
                        words.push_str(frame["text"].as_str().unwrap());
                    } else {
                        ends.push(frame);
                    }
                }
                PageWriteNext::Wait(at) => now = at,
                PageWriteNext::Idle => break,
            }
        }
        assert_eq!(words, "⟧\n会议马上开始，请大家准备好材料。");
        assert_eq!(
            ends,
            [serde_json::json!({ "type": "done", "turn": 1, "paced": { "at": 28 } })]
        );
        assert_eq!(
            now,
            start + Duration::from_millis(1_000),
            "28 characters in three chunks, half a second apart"
        );
    }

    #[test]
    fn a_refused_write_goes_again_from_where_the_session_says_and_its_end_after_it() {
        let start = Instant::now();
        let mut outbox = PageWriteOutbox::default();
        outbox.text(3, "One two three four five six");
        outbox.done(3, false);
        let mut now = start;
        let mut sent = vec![];
        while sent.len() < 4 {
            match outbox.next(now) {
                PageWriteNext::Send(frame) => sent.push(body(&frame)),
                PageWriteNext::Wait(at) => now = at,
                PageWriteNext::Idle => break,
            }
        }
        assert_eq!(sent.last().unwrap()["type"], "done");
        assert!(outbox.is_empty());
        // The session took only the first chunk.
        outbox.limited(3, 10, Duration::from_millis(800), now);
        assert_eq!(
            outbox.next(now),
            PageWriteNext::Wait(now + Duration::from_millis(800))
        );
        let (again, _) = drain(&mut outbox, now + Duration::from_millis(800));
        assert_eq!(
            again,
            [
                serde_json::json!({ "type": "delta", "turn": 3, "text": "ree four f", "paced": { "at": 10 } })
            ]
        );
        let mut rest = vec![];
        let mut at = now + Duration::from_millis(800);
        loop {
            match outbox.next(at) {
                PageWriteNext::Send(frame) => rest.push(body(&frame)),
                PageWriteNext::Wait(next) => at = next,
                PageWriteNext::Idle => break,
            }
        }
        assert_eq!(
            rest,
            [
                serde_json::json!({ "type": "delta", "turn": 3, "text": "ive six", "paced": { "at": 20 } }),
                serde_json::json!({ "type": "done", "turn": 3, "paced": { "at": 27 } }),
            ]
        );
    }

    #[test]
    fn a_stopped_turn_sends_no_more_of_its_words_and_an_image_goes_whole() {
        let start = Instant::now();
        let mut outbox = PageWriteOutbox::default();
        outbox.text(1, "Words the session stopped.");
        let _ = outbox.next(start);
        outbox.stop(1);
        outbox.text(1, " More.");
        assert!(outbox.is_empty());
        outbox.text(2, "See ![a chart](https://example.com/chart(1).png) here");
        let mut chunks = vec![];
        let mut now = start;
        loop {
            match outbox.next(now) {
                PageWriteNext::Send(frame) => {
                    chunks.push(body(&frame)["text"].as_str().unwrap().to_string())
                }
                PageWriteNext::Wait(at) => now = at,
                PageWriteNext::Idle => break,
            }
        }
        assert_eq!(
            chunks,
            [
                "See ",
                "![a chart](https://example.com/chart(1).png)",
                " here"
            ]
        );
    }
}
