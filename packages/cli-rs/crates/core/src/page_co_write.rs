//! The wire between an Agent's runtime and a page's live session while the
//! Agent co-writes the page (docs/design/pages-live-document.md §4.2). The
//! runtime joins as the page's co-writer, not as a replica of the document:
//! the session sends it turns, and it answers with its harness's text as the
//! harness writes it. Frames are the session's own: a varint type, then a
//! varint-prefixed UTF-8 JSON body (lib0 encoding).

use std::sync::{Arc, RwLock};

use serde::Deserialize;
use tokio_tungstenite::tungstenite::http::HeaderValue;

use crate::error::{CliError, Result};
use crate::http;
use crate::websocket::{self, ClientWebSocket, connection_host};

/// A frame carrying co-writing JSON, after the session's sync (0), awareness
/// (1) and notices (2).
pub const PAGE_MESSAGE_CO_WRITE: u64 = 3;
/// Answered by the session's host without waking it; a socket that sends it
/// now and then stays open while the Agent is quiet.
pub const PAGE_SESSION_HEARTBEAT_PING: &str = "ping";
/// The document fragment the session edits; a client naming another is told
/// it is out of date.
const PAGE_DOCUMENT_FRAGMENT: &str = "prosemirror";

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
/// takes what follows as that turn's words.
pub fn write_frame(turn: u64) -> Vec<u8> {
    frame(&serde_json::json!({ "type": "write", "turn": turn }))
}

/// Some of the harness's text for `turn`, as it came.
pub fn delta_frame(turn: u64, text: &str) -> Vec<u8> {
    frame(&serde_json::json!({ "type": "delta", "turn": turn, "text": text }))
}

/// The end of the harness's turn; `failed` when it ended in an error.
pub fn done_frame(turn: u64, failed: bool) -> Vec<u8> {
    frame(&serde_json::json!({ "type": if failed { "failed" } else { "done" }, "turn": turn }))
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
        let mut request = http::websocket_request(&socket, http::process_client_component()).await?;
        request.headers_mut().insert(
            "sec-websocket-protocol",
            HeaderValue::from_str(&ticket.protocol)
                .map_err(|_| CliError::Relay("The page session ticket is not a header".into()))?,
        );
        websocket::connect(request).await
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
        let long = format!(r#"{{"type":"turn","turn":2,"text":"{}"}}"#, "页".repeat(100));
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
        let write: serde_json::Value = serde_json::from_slice(&write_frame(8)[2..]).unwrap();
        assert_eq!(write, serde_json::json!({ "type": "write", "turn": 8 }));
    }
}
