use futures_util::stream;
use serde_json::Value;
use tokio_tungstenite::tungstenite::error::CapacityError;
use tokio_tungstenite::tungstenite::{Error as WsError, Message as WsMessage};

use super::{
    BACKLOG_BYTES, BACKLOG_MESSAGES, spawn_stdio_json_value_reader, spawn_ws_json_value_reader,
};

fn ws_text(value: &Value) -> Result<WsMessage, WsError> {
    Ok(WsMessage::Text(value.to_string().into()))
}

#[tokio::test]
async fn websocket_reader_keeps_vendor_and_size_on_capacity_errors() {
    let stream = stream::iter([Err(WsError::Capacity(CapacityError::MessageTooLong {
        size: 20_184_530,
        max_size: 16_777_216,
    }))]);
    let mut inbox = spawn_ws_json_value_reader(stream, "Codex".into());

    assert!(inbox.recv().await.is_none());
    assert!(inbox.has_failure());
    assert!(!inbox.retryable());
    let error = inbox.error().to_string();
    assert!(
        error.contains(
            "Codex WebSocket transport: message too large (20184530 bytes; limit 16777216 bytes)"
        ),
        "got {error}"
    );
}

#[tokio::test]
async fn websocket_reader_parses_text_frames_and_skips_control_frames() {
    let payload = serde_json::json!({"jsonrpc":"2.0","id":1,"result":{"ok":true}});
    let stream = stream::iter([
        Ok(WsMessage::Ping(Vec::new().into())),
        ws_text(&payload),
        Ok(WsMessage::Pong(Vec::new().into())),
    ]);
    let mut inbox = spawn_ws_json_value_reader(stream, "Codex".into());

    assert_clean_provider_payload(&mut inbox, &payload).await;
}

#[tokio::test]
async fn websocket_reader_reports_invalid_json_instead_of_dropping_it() {
    let stream = stream::iter([Ok(WsMessage::Text("{not-json".into()))]);
    let mut inbox = spawn_ws_json_value_reader(stream, "Grok".into());

    assert!(inbox.recv().await.is_none());
    let error = inbox.error().to_string();
    assert!(
        error.contains("Grok WebSocket transport: invalid JSON at line 1, column"),
        "got {error}"
    );
    assert!(!inbox.retryable());
}

#[tokio::test]
async fn deferred_notifications_are_replayed_before_live_messages() {
    let live = serde_json::json!({"method":"turn/completed"});
    let stream = stream::iter([ws_text(&live)]);
    let mut inbox = spawn_ws_json_value_reader(stream, "Codex".into());
    let deferred = serde_json::json!({"method":"item/commandExecution/approval"});
    inbox.defer(deferred.clone()).expect("defer approval");

    assert_eq!(inbox.next().await.as_ref(), Some(&deferred));
    assert_eq!(inbox.next().await.as_ref(), Some(&live));
}

#[tokio::test]
async fn backlog_fails_closed_instead_of_dropping_the_overflow_message() {
    let stream = stream::iter(Vec::<Result<WsMessage, WsError>>::new());
    let mut inbox = spawn_ws_json_value_reader(stream, "Codex".into());
    let notice = serde_json::json!({"method":"item/agentMessage/delta","delta":"x"});
    for _ in 0..BACKLOG_MESSAGES {
        inbox.defer(notice.clone()).expect("backlog should accept");
    }

    let error = inbox
        .defer(serde_json::json!({"method":"item/commandExecution/approval"}))
        .expect_err("overflow must fail closed");
    let text = error.to_string();
    assert!(text.contains("Codex WebSocket transport: notification backlog full"));
    assert!(text.contains(&format!(
        "{}/{BACKLOG_MESSAGES} messages",
        BACKLOG_MESSAGES + 1
    )));
    assert!(inbox.next().await.is_none());
    assert!(inbox.has_failure());
    assert!(!inbox.retryable());
}

#[tokio::test]
async fn backlog_byte_budget_fails_closed_on_large_notifications() {
    let stream = stream::iter(Vec::<Result<WsMessage, WsError>>::new());
    let mut inbox = spawn_ws_json_value_reader(stream, "Codex".into());
    let bulky = serde_json::json!({"blob": "a".repeat(64 * 1024)});
    let mut accepted = 0usize;
    loop {
        match inbox.defer(bulky.clone()) {
            Ok(()) => accepted += 1,
            Err(error) => {
                let text = error.to_string();
                assert!(text.contains("notification backlog full"));
                assert!(text.contains(&format!("{BACKLOG_BYTES} bytes")));
                assert!(
                    accepted > 0,
                    "byte budget should accept at least one notice"
                );
                break;
            }
        }
        assert!(
            accepted < 2_000,
            "byte budget never filled after {accepted} notices"
        );
    }
}

#[tokio::test]
async fn stdio_reader_skips_banners_then_parses_json_lines() {
    let payload = serde_json::json!({"jsonrpc":"2.0","id":7,"result":{}});
    let stdout = format!("starting up\n{payload}\n");
    let mut inbox = spawn_stdio_json_value_reader(std::io::Cursor::new(stdout), "Grok".into());

    assert_clean_provider_payload(&mut inbox, &payload).await;
}

async fn assert_clean_provider_payload(
    inbox: &mut crate::runtime_ws_json_reader::ProviderInbox,
    payload: &serde_json::Value,
) {
    assert_eq!(inbox.recv().await.as_ref(), Some(payload));
    assert!(inbox.recv().await.is_none());
    assert!(!inbox.has_failure());
}
