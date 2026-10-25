//! An Agent writing into a page from its conversation as it writes, whatever
//! its harness (docs/design/pages-live-document.md §4.2).
//!
//! In its reply the Agent opens `⟦write page:<id>⟧`, writes the page's own
//! markers (`⟦after "words on the page"⟧` then markdown, `⟦replace "…"⟧`,
//! `⟦note "…"⟧`), and closes with `⟦/write⟧`. Every backend reports the reply
//! as `assistant_delta` traces. As soon as the opening marker is whole, this
//! runtime joins the page's live session as a co-writer that opens its own
//! turns, and what follows goes to the page as the model writes it, until
//! `⟦/write⟧` or the end of the harness's turn. The session asks it nothing;
//! when some of it did not reach the page (a quote that is not there, someone
//! editing where it writes), the conversation hears why as its next turn.

use std::collections::{BTreeSet, HashMap};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use xmatrix_cli_core::agent_instance_connection::{
    AgentInstanceConnectionClient, AgentInstanceConnectionEvent,
};
use xmatrix_cli_core::page_co_write::{
    PAGE_SESSION_HEARTBEAT_PING, PAGE_WRITE_CLOSE as CLOSE, PAGE_WRITE_OPEN as OPEN,
    PageCoWriteConnector, PageCoWriteEvent, PageCoWriteRequest, PageWriteOutbox, decode_request,
    page_write_target, send_due, write_frame,
};
use xmatrix_cli_core::page_media::{ToPage, refused_images_note};

const MARK_END: char = '⟧';
/// Longer than any page id between `⟦write page:` and `⟧`, quoted and spaced.
const MAX_OPEN_REST: usize = 48;
/// Kept below the idle limits between here and the session.
const HEARTBEAT: Duration = Duration::from_secs(25);
/// The page's session stays joined this long after the Agent's words last
/// reached it: it often writes again soon, and until it leaves, a person can
/// take back its last change.
#[cfg(not(test))]
const IDLE: Duration = Duration::from_secs(90);
#[cfg(test)]
const IDLE: Duration = Duration::from_millis(300);
/// Its words go to the page at the rate the session takes them
/// (`PageWriteOutbox`), and the session says when a turn has all reached it
/// (its outcome). The session stays joined until then, though not longer than
/// this after the Agent last wrote.
const WRITTEN_WITHIN: Duration = Duration::from_secs(30 * 60);

/// What a reply says to a page, as the reply comes.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Said {
    /// `⟦write page:<id>⟧`: what follows goes into that page.
    Open(String),
    /// Words for the page that is open.
    Text(String),
    /// `⟦/write⟧`, or the reply ended.
    Close,
}

/// Finds the pages a reply writes into, in its text as it comes.
#[derive(Default)]
struct Scanner {
    /// The page the reply writes into now.
    page: Option<String>,
    /// The end of the text so far that may still begin a marker.
    held: String,
}

impl Scanner {
    fn push(&mut self, text: &str) -> Vec<Said> {
        if self.page.is_none() && self.held.is_empty() && !text.contains('⟦') {
            return Vec::new();
        }
        let mut said = Vec::new();
        let mut rest = std::mem::take(&mut self.held) + text;
        loop {
            if self.page.is_some() {
                if let Some(at) = rest.find(CLOSE) {
                    if at > 0 {
                        said.push(Said::Text(rest[..at].to_string()));
                    }
                    said.push(Said::Close);
                    self.page = None;
                    rest = rest[at + CLOSE.len()..].to_string();
                    continue;
                }
                let split = marker_start(&rest, CLOSE);
                if split > 0 {
                    said.push(Said::Text(rest[..split].to_string()));
                }
                self.held = rest[split..].to_string();
                return said;
            }
            let Some(at) = rest.find(OPEN) else {
                self.held = rest[marker_start(&rest, OPEN)..].to_string();
                return said;
            };
            let after = &rest[at + OPEN.len()..];
            match after.find(MARK_END) {
                Some(end) => {
                    if let Some(page) = page_write_target(&after[..end]) {
                        said.push(Said::Open(page.clone()));
                        self.page = Some(page);
                    }
                    rest = after[end + MARK_END.len_utf8()..].to_string();
                }
                // The marker is not whole yet.
                None if after.len() <= MAX_OPEN_REST => {
                    self.held = rest[at..].to_string();
                    return said;
                }
                // Too long to name a page: no marker.
                None => rest = after.to_string(),
            }
        }
    }

    /// The reply ended: so does what it was writing into a page.
    fn finish(&mut self) -> Vec<Said> {
        let held = std::mem::take(&mut self.held);
        if self.page.take().is_none() {
            return Vec::new();
        }
        let mut said = Vec::new();
        if !held.is_empty() {
            said.push(Said::Text(held));
        }
        said.push(Said::Close);
        said
    }
}

/// Where in `text` an end that `marker` begins with starts: `text.len()` when
/// none does.
fn marker_start(text: &str, marker: &str) -> usize {
    let earliest = text.len().saturating_sub(marker.len() - 1);
    text.char_indices()
        .map(|(index, _)| index)
        .filter(|&index| index >= earliest)
        .find(|&index| marker.starts_with(&text[index..]))
        .unwrap_or(text.len())
}

/// What goes to a page's session for the conversation writing into it.
#[derive(Debug)]
enum Piece {
    Open,
    Text(String),
    End { failed: bool },
}

#[derive(Default)]
struct Conversation {
    scanner: Scanner,
    /// The page the reply writes into now, and the way to it.
    writing: Option<(String, mpsc::UnboundedSender<Piece>)>,
}

static CONVERSATIONS: LazyLock<Mutex<HashMap<String, Conversation>>> =
    LazyLock::new(Default::default);
/// The open sessions, one per conversation and page.
static WRITERS: LazyLock<Mutex<HashMap<(String, String), mpsc::UnboundedSender<Piece>>>> =
    LazyLock::new(Default::default);
/// The Space each conversation writes pages in.
static SPACES: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);

fn locked<T>(mutex: &'static Mutex<T>) -> std::sync::MutexGuard<'static, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Whether the reply in `channel_id` is writing into a page right now: its
/// words then go out as they come, not gathered for the conversation's trace.
pub(crate) fn writing(channel_id: &str) -> bool {
    locked(&CONVERSATIONS)
        .get(channel_id)
        .is_some_and(|conversation| conversation.writing.is_some())
}

/// A trace this runtime publishes for a turn in `channel_id`: the reply's text
/// may write into a page, and the turn's end ends what it was writing.
pub(crate) fn observe(
    relay: &AgentInstanceConnectionClient,
    channel_id: &str,
    phase: &str,
    payload: &serde_json::Value,
) {
    // A page the conversation co-writes hears this text from its own bridge.
    if crate::runtime_page_co_write::answering(channel_id) {
        return;
    }
    let mut all = locked(&CONVERSATIONS);
    let (said, failed) = match phase {
        "assistant_delta" => match payload.get("delta").and_then(|value| value.as_str()) {
            Some(text) if !text.is_empty() => (
                all.entry(channel_id.to_string())
                    .or_default()
                    .scanner
                    .push(text),
                false,
            ),
            _ => return,
        },
        "turn_started"
            if payload.get("continued").and_then(|value| value.as_bool()) != Some(true) =>
        {
            (finish(&mut all, channel_id), false)
        }
        "turn_completed" | "turn_interrupted" | "turn_cancelled" => {
            (finish(&mut all, channel_id), false)
        }
        "turn_failed" => (finish(&mut all, channel_id), true),
        _ => return,
    };
    if said.is_empty() {
        return;
    }
    let conversation = all.entry(channel_id.to_string()).or_default();
    for piece in said {
        match piece {
            Said::Open(page) => {
                let to = writer(relay, channel_id, &page);
                let _ = to.send(Piece::Open);
                conversation.writing = Some((page, to));
            }
            Said::Text(text) => {
                if let Some((_, to)) = &conversation.writing {
                    let _ = to.send(Piece::Text(text));
                }
            }
            Said::Close => {
                if let Some((_, to)) = conversation.writing.take() {
                    let _ = to.send(Piece::End { failed });
                }
            }
        }
    }
}

fn finish(all: &mut HashMap<String, Conversation>, channel_id: &str) -> Vec<Said> {
    all.get_mut(channel_id)
        .map(|conversation| conversation.scanner.finish())
        .unwrap_or_default()
}

/// The way to `page`'s session for `channel_id`: the one already open, or a
/// new one, joined meanwhile, which takes what is written until it is.
fn writer(
    relay: &AgentInstanceConnectionClient,
    channel_id: &str,
    page: &str,
) -> mpsc::UnboundedSender<Piece> {
    let key = (channel_id.to_string(), page.to_string());
    let mut writers = locked(&WRITERS);
    if let Some(to) = writers.get(&key)
        && !to.is_closed()
    {
        return to.clone();
    }
    let (to, pieces) = mpsc::unbounded_channel();
    writers.insert(key, to.clone());
    tokio::spawn(write_into(
        relay.page_co_write_connector(),
        relay.local_event_sender(),
        channel_id.to_string(),
        page.to_string(),
        pieces,
    ));
    to
}

async fn space_of(
    connector: &PageCoWriteConnector,
    channel_id: &str,
) -> xmatrix_cli_core::error::Result<String> {
    if let Some(space) = locked(&SPACES).get(channel_id) {
        return Ok(space.clone());
    }
    let space = connector.page_space(channel_id).await?;
    locked(&SPACES).insert(channel_id.to_string(), space.clone());
    Ok(space)
}

/// The conversation's next turn tells the Agent what became of its words.
fn tell(
    events: &mpsc::UnboundedSender<AgentInstanceConnectionEvent>,
    channel_id: &str,
    prompt: String,
) {
    let _ = events.send(AgentInstanceConnectionEvent::PageCoWrite(
        PageCoWriteEvent::Outcome {
            channel_id: channel_id.to_string(),
            prompt,
        },
    ));
}

/// Tells the Agent which images of local files were left out of what it wrote, and starts afresh.
fn refused_images(
    events: &mpsc::UnboundedSender<AgentInstanceConnectionEvent>,
    channel_id: &str,
    page: &str,
    images: &mut ToPage,
) {
    let written = std::mem::take(images);
    if !written.refused().is_empty() {
        tell(
            events,
            channel_id,
            format!(
                "[Page write] Not all you wrote into page:{page} reached it: {}.",
                refused_images_note(written.refused())
            ),
        );
    }
}

fn problems_prompt(page: &str, problems: &[String]) -> String {
    let mut prompt = format!("[Page write] Not all you wrote into page:{page} reached it:\n");
    for problem in problems {
        prompt.push_str(&format!("- {problem}\n"));
    }
    prompt.push_str(&format!(
        "Read the page (`xmatrix page read {page}`) and write what is missing where it belongs, quoting words that appear once on the page as it reads now."
    ));
    prompt
}

/// One conversation writing into one page: joins its session, opens a turn for
/// each `⟦write page:…⟧`, streams the words, ends the turn at `⟦/write⟧`, and
/// leaves once the Agent has written nothing for a while.
async fn write_into(
    connector: PageCoWriteConnector,
    events: mpsc::UnboundedSender<AgentInstanceConnectionEvent>,
    channel_id: String,
    page: String,
    mut pieces: mpsc::UnboundedReceiver<Piece>,
) {
    let joined = match space_of(&connector, &channel_id).await {
        Ok(space) => connector.connect(&space, &page, true).await,
        Err(error) => Err(error),
    };
    let socket = match joined {
        Ok(socket) => socket,
        Err(error) => {
            close(&mut pieces);
            tell(
                &events,
                &channel_id,
                format!(
                    "[Page write] What you wrote with ⟦write page:{page}⟧ did not reach the page: {error}. Check the page id with `xmatrix page tree`; a page that takes Agent edits as suggestions takes them with `xmatrix page edit`."
                ),
            );
            return;
        }
    };
    let (mut sink, mut stream) = socket.split();
    let mut turn = 0u64;
    // The turn's images, each held until it is whole (`page_media`).
    let mut images = ToPage::default();
    // The turn being written, and whether the session stopped it.
    let mut open: Option<(u64, bool)> = None;
    // Turns the page has not said the outcome of: it is still taking their words.
    let mut unanswered = BTreeSet::new();
    // What goes to the session, at the rate it takes an Agent's words.
    let mut outbox = PageWriteOutbox::default();
    let mut wrote = tokio::time::Instant::now();
    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    heartbeat.tick().await;
    let idle = tokio::time::sleep(IDLE);
    tokio::pin!(idle);
    loop {
        // Everything the rate lets go now goes, and the loop wakes when more may.
        let Ok(due) = send_due(&mut outbox, &mut sink).await else {
            break;
        };
        let due = due.map(tokio::time::Instant::from_std);
        let frame: Option<Vec<u8>> = tokio::select! {
            () = tokio::time::sleep_until(due.unwrap_or_else(tokio::time::Instant::now)), if due.is_some() => None,
            piece = pieces.recv() => {
                wrote = tokio::time::Instant::now();
                idle.as_mut().reset(wrote + IDLE);
                match piece {
                    Some(Piece::Open) => {
                        if let Some((previous, stopped)) = open.take()
                            && !stopped
                        {
                            outbox.text(previous, &images.finish());
                            outbox.done(previous, false);
                        }
                        refused_images(&events, &channel_id, &page, &mut images);
                        turn += 1;
                        open = Some((turn, false));
                        unanswered.insert(turn);
                        outbox.frame(write_frame(turn, false));
                        None
                    }
                    Some(Piece::Text(text)) => {
                        if let Some((id, false)) = open {
                            outbox.text(id, &images.push(&text));
                        }
                        None
                    }
                    Some(Piece::End { failed }) => {
                        if let Some((id, false)) = open.take() {
                            outbox.text(id, &images.finish());
                            refused_images(&events, &channel_id, &page, &mut images);
                            outbox.done(id, failed);
                        }
                        None
                    }
                    None => break,
                }
            }
            frame = stream.next() => {
                match frame {
                    Some(Ok(Message::Binary(data))) => match decode_request(&data) {
                        Some(PageCoWriteRequest::Interrupt { turn: stopped }) => {
                            if let Some((id, halted)) = open.as_mut()
                                && *id == stopped
                            {
                                *halted = true;
                            }
                            outbox.stop(stopped);
                        }
                        Some(PageCoWriteRequest::Limited { turn: refused, at, retry_after_ms }) => {
                            outbox.limited(refused, at, Duration::from_millis(retry_after_ms), std::time::Instant::now());
                        }
                        Some(PageCoWriteRequest::Outcome { turn: answered, problems }) => {
                            unanswered.remove(&answered);
                            idle.as_mut().reset(tokio::time::Instant::now() + IDLE);
                            if !problems.is_empty() {
                                tell(&events, &channel_id, problems_prompt(&page, &problems));
                            }
                        }
                        _ => {}
                    },
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => {
                        if open.is_some_and(|(_, stopped)| !stopped) || !outbox.is_empty() {
                            tell(
                                &events,
                                &channel_id,
                                format!(
                                    "[Page write] The connection to page:{page} closed while you were writing into it; the rest of what you wrote there did not reach it. Read the page (`xmatrix page read {page}`) before writing again."
                                ),
                            );
                        }
                        break;
                    }
                    Some(Ok(_)) => {}
                }
                None
            }
            _ = heartbeat.tick() => {
                if sink.send(Message::Text(PAGE_SESSION_HEARTBEAT_PING.into())).await.is_err() {
                    break;
                }
                None
            }
            () = &mut idle, if open.is_none() && outbox.is_empty() => {
                let taking = !unanswered.is_empty() && wrote.elapsed() < WRITTEN_WITHIN;
                if !taking && leave(&mut pieces) {
                    break;
                }
                // The page is still taking its words, or something was written
                // meanwhile: the session stays open for it.
                idle.as_mut().reset(tokio::time::Instant::now() + IDLE);
                None
            }
        };
        if let Some(frame) = frame
            && sink.send(Message::Binary(frame.into())).await.is_err()
        {
            break;
        }
    }
    close(&mut pieces);
    let _ = sink.close().await;
}

/// This session leaves the page, unless something was sent to it meanwhile:
/// then it stays, and goes on with that. Whether it left. A new piece for the
/// page only ever comes through `WRITERS`, so nothing slips in between.
fn leave(pieces: &mut mpsc::UnboundedReceiver<Piece>) -> bool {
    let mut writers = locked(&WRITERS);
    if !pieces.is_empty() {
        return false;
    }
    pieces.close();
    writers.retain(|_, to| !to.is_closed());
    true
}

/// This session is no longer the way to the page; what is still sent to it is dropped.
fn close(pieces: &mut mpsc::UnboundedReceiver<Piece>) {
    pieces.close();
    locked(&WRITERS).retain(|_, to| !to.is_closed());
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";

    fn scan(chunks: &[&str]) -> Vec<Said> {
        let mut scanner = Scanner::default();
        let mut said: Vec<Said> = chunks
            .iter()
            .flat_map(|chunk| scanner.push(chunk))
            .collect();
        said.extend(scanner.finish());
        // Adjacent words are one stretch of text, however they were split.
        said.into_iter().fold(Vec::new(), |mut out, piece| {
            match (out.last_mut(), piece) {
                (Some(Said::Text(text)), Said::Text(more)) => text.push_str(&more),
                (_, piece) => out.push(piece),
            }
            out
        })
    }

    #[test]
    fn finds_what_a_reply_writes_into_a_page_however_its_text_is_split() {
        let reply = format!(
            "Adding the risks now.\n⟦write page:{PAGE}⟧\n⟦after \"## Risks\"⟧\n- Supply: one vendor\n⟦/write⟧\nDone."
        );
        let expected = vec![
            Said::Open(PAGE.into()),
            Said::Text("\n⟦after \"## Risks\"⟧\n- Supply: one vendor\n".into()),
            Said::Close,
        ];
        assert_eq!(scan(&[&reply]), expected, "in one piece");
        let characters: Vec<String> = reply.chars().map(String::from).collect();
        let split: Vec<&str> = characters.iter().map(String::as_str).collect();
        assert_eq!(scan(&split), expected, "a character at a time");
        for at in (0..reply.len()).filter(|&at| reply.is_char_boundary(at)) {
            assert_eq!(
                scan(&[&reply[..at], &reply[at..]]),
                expected,
                "split at byte {at}"
            );
        }
    }

    #[test]
    fn a_reply_that_ends_ends_what_it_was_writing() {
        assert_eq!(
            scan(&[&format!("⟦write page:{PAGE}⟧ half a sentence ⟦/wr")]),
            vec![
                Said::Open(PAGE.into()),
                Said::Text(" half a sentence ⟦/wr".into()),
                Said::Close
            ]
        );
    }

    #[test]
    fn writes_into_several_pages_in_turn_and_names_them_quoted_or_not() {
        let other = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
        assert_eq!(
            scan(&[&format!(
                "⟦write page:\"{PAGE}\"⟧one⟦/write⟧ and ⟦write page: {other} ⟧two⟦/write⟧"
            )]),
            vec![
                Said::Open(PAGE.into()),
                Said::Text("one".into()),
                Said::Close,
                Said::Open(other.to_ascii_lowercase()),
                Said::Text("two".into()),
                Said::Close,
            ]
        );
    }

    #[test]
    fn talk_about_pages_is_not_writing_into_one() {
        assert_eq!(
            scan(&["Write ⟦write page:<id>⟧ then ⟦after \"x\"⟧ text ⟦/write⟧ in your reply."]),
            vec![]
        );
        assert_eq!(
            scan(&["⟦after \"x\"⟧ and ⟦write page: no marker here at all, just a very long aside"]),
            vec![]
        );
        assert_eq!(scan(&["plain text", " with no markers"]), vec![]);
    }

    #[test]
    fn a_marker_still_coming_waits_for_the_rest_of_it() {
        let mut scanner = Scanner::default();
        assert_eq!(scanner.push("text ⟦write pa"), vec![]);
        assert_eq!(scanner.push(&format!("ge:{PAGE}")), vec![]);
        assert_eq!(
            scanner.push("⟧hello ⟦/"),
            vec![Said::Open(PAGE.into()), Said::Text("hello ".into())]
        );
        assert_eq!(scanner.push("write⟧"), vec![Said::Close]);
    }

    /// A Hub with one page: it names the conversation's Space, issues the live
    /// ticket, and plays the page's session on the socket the ticket opens.
    struct FakePageHub {
        url: String,
        /// The co-writing JSON the session received, in order, and `{"closed": true}`
        /// when the socket closes.
        received: mpsc::UnboundedReceiver<serde_json::Value>,
        /// Frames for the session to send.
        send: mpsc::UnboundedSender<serde_json::Value>,
        /// The body of the live-ticket request.
        ticket: tokio::sync::oneshot::Receiver<serde_json::Value>,
    }

    fn co_write_frame(value: &serde_json::Value) -> Vec<u8> {
        let body = value.to_string();
        let mut out = vec![3u8];
        let mut length = body.len();
        while length >= 0x80 {
            out.push((length as u8 & 0x7f) | 0x80);
            length >>= 7;
        }
        out.push(length as u8);
        out.extend_from_slice(body.as_bytes());
        out
    }

    fn co_write_body(frame: &[u8]) -> serde_json::Value {
        let mut at = 1;
        while frame[at] & 0x80 != 0 {
            at += 1;
        }
        serde_json::from_slice(&frame[at + 1..]).unwrap()
    }

    impl FakePageHub {
        async fn start() -> Self {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let (received_tx, received) = mpsc::unbounded_channel();
            let (send, mut outgoing) = mpsc::unbounded_channel::<serde_json::Value>();
            let (ticket_tx, ticket) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                let mut ticket_tx = Some(ticket_tx);
                loop {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut head = vec![0u8; 8192];
                    let read = loop {
                        let read = stream.peek(&mut head).await.unwrap();
                        if head[..read].windows(4).any(|window| window == b"\r\n\r\n") {
                            break read;
                        }
                    };
                    let text = String::from_utf8_lossy(&head[..read]).to_string();
                    if text.to_ascii_lowercase().contains("upgrade: websocket") {
                        let callback = |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                                        mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                            if let Some(protocol) = request.headers().get("sec-websocket-protocol") {
                                response.headers_mut().insert("sec-websocket-protocol", protocol.clone());
                            }
                            Ok(response)
                        };
                        let mut socket = tokio_tungstenite::accept_hdr_async(stream, callback)
                            .await
                            .unwrap();
                        loop {
                            tokio::select! {
                                frame = socket.next() => match frame {
                                    Some(Ok(Message::Binary(data))) => { let _ = received_tx.send(co_write_body(&data)); }
                                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => {
                                        let _ = received_tx.send(serde_json::json!({ "closed": true }));
                                        return;
                                    }
                                    Some(Ok(_)) => {}
                                },
                                Some(value) = outgoing.recv() => {
                                    socket.send(Message::Binary(co_write_frame(&value).into())).await.unwrap();
                                }
                            }
                        }
                    }
                    let end = text.find("\r\n\r\n").unwrap() + 4;
                    let length = text[..end]
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|value| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    let mut request = vec![0u8; end + length];
                    stream.read_exact(&mut request).await.unwrap();
                    let path = text
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or_default()
                        .to_string();
                    let reply = if path.ends_with("/page-space") {
                        serde_json::json!({ "spaceId": "space-1" })
                    } else {
                        if let Some(tx) = ticket_tx.take() {
                            let _ = tx.send(serde_json::from_slice(&request[end..]).unwrap());
                        }
                        serde_json::json!({ "protocol": "xmatrix-page-ticket.test", "socketPath": format!("/ws/pages/space-1/{PAGE}") })
                    }
                    .to_string();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                        reply.len()
                    );
                    stream.write_all(response.as_bytes()).await.unwrap();
                }
            });
            Self {
                url,
                received,
                send,
                ticket,
            }
        }

        async fn next(&mut self) -> serde_json::Value {
            tokio::time::timeout(Duration::from_secs(10), self.received.recv())
                .await
                .unwrap()
                .unwrap()
        }

        /// The session receives these, in order.
        async fn expect(&mut self, frames: &[serde_json::Value]) {
            for frame in frames {
                assert_eq!(&self.next().await, frame);
            }
        }
    }

    /// The way to the fake Hub's page sessions, as a Run's runtime has it.
    fn connector_for(hub: &FakePageHub) -> PageCoWriteConnector {
        crate::ensure_reqwest_crypto_provider();
        PageCoWriteConnector::new(
            hub.url.clone(),
            std::sync::Arc::new(std::sync::RwLock::new("run-token".into())),
        )
    }

    fn start_writing(
        hub: &FakePageHub,
        channel: &str,
    ) -> (
        mpsc::UnboundedSender<Piece>,
        mpsc::UnboundedReceiver<AgentInstanceConnectionEvent>,
    ) {
        let connector = connector_for(hub);
        let (events, heard) = mpsc::unbounded_channel();
        let (to, pieces) = mpsc::unbounded_channel();
        tokio::spawn(write_into(
            connector,
            events,
            channel.into(),
            PAGE.into(),
            pieces,
        ));
        (to, heard)
    }

    #[tokio::test]
    async fn streams_what_it_writes_into_the_page_and_tells_the_conversation_what_did_not_land() {
        let mut hub = FakePageHub::start().await;
        let (to, mut heard) = start_writing(&hub, "c-stream-write-lands");
        to.send(Piece::Open).unwrap();
        to.send(Piece::Text("⟦after \"x\"⟧ one".into())).unwrap();
        to.send(Piece::Text(" two".into())).unwrap();
        to.send(Piece::End { failed: false }).unwrap();
        // Ten characters at a time, at the session's rate, each saying where it starts.
        hub.expect(&[
            serde_json::json!({ "type": "write", "turn": 1 }),
            serde_json::json!({ "type": "delta", "turn": 1, "text": "⟦after \"x\"", "paced": { "at": 0 } }),
            serde_json::json!({ "type": "delta", "turn": 1, "text": "⟧ one two", "paced": { "at": 10 } }),
        ])
        .await;
        assert_eq!(
            hub.next().await,
            serde_json::json!({ "type": "done", "turn": 1, "paced": { "at": 19 } })
        );
        let ticket = (&mut hub.ticket).await.unwrap();
        assert_eq!(
            (ticket["coWrite"].clone(), ticket["stream"].clone()),
            (true.into(), true.into()),
            "it joins as a co-writer that streams"
        );

        // All of it reached the page: the conversation hears nothing.
        hub.send
            .send(serde_json::json!({ "type": "outcome", "turn": 1, "problems": [] }))
            .unwrap();
        to.send(Piece::Open).unwrap();
        assert_eq!(
            hub.next().await,
            serde_json::json!({ "type": "write", "turn": 2 }),
            "the next write is the next turn on the same socket"
        );
        hub.send.send(serde_json::json!({ "type": "outcome", "turn": 2,
            "problems": ["Your ⟦after⟧ quoted \"y\", which is not on the page; nothing was written there."] })).unwrap();
        let event = tokio::time::timeout(Duration::from_secs(10), heard.recv())
            .await
            .unwrap()
            .unwrap();
        let AgentInstanceConnectionEvent::PageCoWrite(PageCoWriteEvent::Outcome {
            channel_id,
            prompt,
        }) = event
        else {
            panic!("expected the page's outcome");
        };
        assert_eq!(channel_id, "c-stream-write-lands");
        assert!(
            prompt.contains("- Your ⟦after⟧ quoted \"y\", which is not on the page"),
            "{prompt}"
        );
        assert!(
            heard.try_recv().is_err(),
            "an outcome with nothing wrong is not told"
        );
    }

    #[tokio::test]
    async fn stops_where_the_session_stopped_it() {
        let mut hub = FakePageHub::start().await;
        let (to, _heard) = start_writing(&hub, "c-stream-write-stopped");
        to.send(Piece::Open).unwrap();
        to.send(Piece::Text("⟦after \"x\"⟧ one".into())).unwrap();
        assert_eq!(hub.next().await["type"], "write");
        assert_eq!(hub.next().await["type"], "delta");
        hub.send
            .send(serde_json::json!({ "type": "interrupt", "turn": 1 }))
            .unwrap();
        // Let the interrupt land before more words come.
        tokio::time::sleep(Duration::from_millis(200)).await;
        to.send(Piece::Text(" more".into())).unwrap();
        to.send(Piece::End { failed: false }).unwrap();
        to.send(Piece::Open).unwrap();
        assert_eq!(
            hub.next().await,
            serde_json::json!({ "type": "write", "turn": 2 }),
            "nothing more of the stopped turn is sent"
        );
    }

    #[tokio::test]
    async fn stays_on_the_page_until_it_has_taken_all_the_agent_wrote() {
        let mut hub = FakePageHub::start().await;
        let (to, _heard) = start_writing(&hub, "c-stream-write-paced");
        to.send(Piece::Open).unwrap();
        to.send(Piece::Text("⟦after \"x\"⟧ read slowly".into()))
            .unwrap();
        to.send(Piece::End { failed: false }).unwrap();
        for kind in ["write", "delta", "delta", "delta", "done"] {
            assert_eq!(hub.next().await["type"], kind);
        }
        // The page has not said it took them all: the session stays, well after it stopped writing.
        tokio::time::sleep(IDLE * 3).await;
        assert!(
            hub.received.try_recv().is_err(),
            "it stays while the page takes its words"
        );
        hub.send
            .send(serde_json::json!({ "type": "outcome", "turn": 1, "problems": [] }))
            .unwrap();
        assert_eq!(
            hub.next().await,
            serde_json::json!({ "closed": true }),
            "and leaves once the page has them all, after a while"
        );
    }

    #[tokio::test]
    async fn a_write_the_session_refused_goes_again_from_where_it_says() {
        let mut hub = FakePageHub::start().await;
        let (to, _heard) = start_writing(&hub, "c-stream-write-limited");
        to.send(Piece::Open).unwrap();
        to.send(Piece::Text("⟦after \"x\"⟧ one two".into()))
            .unwrap();
        to.send(Piece::End { failed: false }).unwrap();
        assert_eq!(hub.next().await["type"], "write");
        assert_eq!(hub.next().await["paced"]["at"], 0);
        hub.send
            .send(serde_json::json!({ "type": "limited", "turn": 1, "at": 0, "retryAfterMs": 100 }))
            .unwrap();
        hub.expect(&[
            serde_json::json!({ "type": "delta", "turn": 1, "text": "⟦after \"x\"", "paced": { "at": 0 } }),
            serde_json::json!({ "type": "delta", "turn": 1, "text": "⟧ one two", "paced": { "at": 10 } }),
            serde_json::json!({ "type": "done", "turn": 1, "paced": { "at": 19 } }),
        ])
        .await;
    }

    #[tokio::test]
    async fn a_message_writes_into_a_page_in_one_turn_and_hears_what_did_not_land() {
        let mut hub = FakePageHub::start().await;
        let connector = connector_for(&hub);
        let writing = tokio::spawn(async move {
            connector
                .write_once("c-message-write", PAGE, "⟦after \"x\"⟧ one")
                .await
        });
        hub.expect(&[
            serde_json::json!({ "type": "write", "turn": 1, "atOnce": true }),
            serde_json::json!({ "type": "delta", "turn": 1, "text": "⟦after \"x\"⟧ one" }),
            serde_json::json!({ "type": "done", "turn": 1 }),
        ])
        .await;
        hub.send
            .send(serde_json::json!({ "type": "outcome", "turn": 1, "problems": ["The quote is not on the page."] }))
            .unwrap();
        let problems = writing.await.unwrap().unwrap();
        assert_eq!(problems, vec!["The quote is not on the page.".to_string()]);
    }

    #[test]
    fn what_did_not_reach_the_page_is_told_with_the_way_back() {
        let prompt = problems_prompt(
            PAGE,
            &["You were stopped: someone edited what you were writing.".into()],
        );
        assert!(prompt.starts_with(&format!(
            "[Page write] Not all you wrote into page:{PAGE} reached it:\n- You were stopped"
        )));
        assert!(prompt.contains(&format!("`xmatrix page read {PAGE}`")));
    }
}
