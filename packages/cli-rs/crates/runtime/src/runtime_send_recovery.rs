use serde::Deserialize;
use serde_json::{Value, json};
use xmatrix_cli_core::{config, error::Result, http};

use super::runtime_send_authorization::{authorize_send, failure};
use super::runtime_send_journal::{SendLease, SendScope};
use super::{DaemonLocalHttpRequest, DaemonRequestBroker};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RecoveryRequest {
    hub_url: String,
    channel_id: String,
    message_id: String,
}

impl RecoveryRequest {
    pub(super) fn for_send(hub_url: String, channel_id: String, message_id: String) -> Self {
        Self {
            hub_url,
            channel_id,
            message_id,
        }
    }
}

pub(super) async fn recover(
    broker: &DaemonRequestBroker,
    request: &DaemonLocalHttpRequest,
    selection: RecoveryRequest,
) -> Result<Value> {
    recover_with_policy(broker, request, selection, true, false).await
}

pub(super) async fn recover_with_policy(
    broker: &DaemonRequestBroker,
    request: &DaemonLocalHttpRequest,
    selection: RecoveryRequest,
    allow_retry: bool,
    // The Hub gave a definitive client error; with no commit it was rejected.
    refused: bool,
) -> Result<Value> {
    let requested =
        reqwest::Url::parse(&selection.hub_url).map_err(|_| failure("Invalid recovery Hub"))?;
    let configured = reqwest::Url::parse(
        broker
            .hub_url
            .as_deref()
            .ok_or_else(|| failure("Recovery Hub is unavailable"))?,
    )
    .map_err(|_| failure("Invalid recovery Hub"))?;
    if requested.origin() != configured.origin()
        || !requested.username().is_empty()
        || requested.password().is_some()
        || requested.query().is_some()
        || requested.fragment().is_some()
    {
        return Err(failure(
            "Recovery Hub does not match the daemon environment",
        ));
    }
    let authorization = authorize_send(
        broker,
        request,
        &selection.channel_id,
        &selection.message_id,
    )
    .await?;
    let scope = authorization.scope.clone();
    let root = config::profile_state_dir().join("send-operations-v1");
    let lease_scope = scope.clone();
    let lease = tokio::task::spawn_blocking(move || SendLease::open(&root, &lease_scope))
        .await
        .map_err(|_| failure("Send recovery record could not be opened"))?
        .map_err(failure)?;
    let expected = lease.submission_fingerprint();
    let token = authorization.token().await?;
    let receipt: Value = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        http::request_json(
            &format!("{}/receipt", authorization.append_url),
            "POST",
            Some(&token),
            Some(json!({"messageId": scope.message_id})),
        ),
    )
    .await
    .map_err(|_| failure("Receipt lookup timed out; recovery did not append a message"))??;
    match receipt_outcome(&scope, expected.as_deref(), &receipt)? {
        ReceiptOutcome::Committed(sequence) => {
            let saved = tokio::task::spawn_blocking(move || lease.confirm())
                .await
                .is_ok_and(|result| result.is_ok());
            Ok(
                json!({"schemaVersion":1, "status":"committed", "channelId":scope.channel_id,
                "messageId":scope.message_id, "sequence":sequence, "retried":false,
                "receiptSaved":saved}),
            )
        }
        ReceiptOutcome::NotFound => {
            if refused {
                // The Hub answered this send with a definitive refusal and the
                // authoritative receipt confirms nothing was committed: it
                // was rejected, not lost, so no recovery record is kept.
                let discarded = tokio::task::spawn_blocking(move || lease.discard())
                    .await
                    .is_ok_and(|result| result.is_ok());
                return Ok(json!({"schemaVersion":1, "status":"rejected",
                    "channelId":scope.channel_id, "messageId":scope.message_id,
                    "recordDiscarded":discarded}));
            }
            if !allow_retry {
                return Err(failure(
                    "No commit observed; the original failure does not permit an automatic retry",
                ));
            }
            let current =
                authorize_send(broker, request, &scope.channel_id, &scope.message_id).await?;
            if current.scope != scope {
                return Err(failure(
                    "Send authority changed during receipt lookup; recovery did not append",
                ));
            }
            let mut payload = lease
                .retry_payload(config::unix_now_secs())
                .map_err(failure)?;
            let body = payload
                .as_object_mut()
                .ok_or_else(|| failure("Saved send payload is invalid"))?;
            body.insert("senderExecutionKey".into(), json!(current.execution_key));
            // One attempt, same ID and saved content; no task/model restart.
            let result =
                super::runtime_daemon_message_send::submit(current, lease, payload).await?;
            Ok(
                json!({"schemaVersion":1, "status":"committed", "channelId":scope.channel_id,
                "messageId":scope.message_id, "retried":true,
                "receiptSaved":result.pointer("/sendOperation/receiptSaved").and_then(Value::as_bool).unwrap_or(false)}),
            )
        }
    }
}

enum ReceiptOutcome {
    Committed(u64),
    NotFound,
}

fn receipt_outcome(
    scope: &SendScope,
    expected: Option<&str>,
    receipt: &Value,
) -> Result<ReceiptOutcome> {
    if receipt.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || receipt.get("channelId").and_then(Value::as_str) != Some(&scope.channel_id)
        || receipt.get("messageId").and_then(Value::as_str) != Some(&scope.message_id)
    {
        return Err(failure(
            "Receipt scope is invalid; recovery did not append a message",
        ));
    }
    match receipt.get("status").and_then(Value::as_str) {
        Some("not_found") => Ok(ReceiptOutcome::NotFound),
        Some("committed") => {
            // Only a commit needs the saved submission's fingerprint.
            let Some(expected) = expected else {
                return Err(failure(
                    "Saved send lacks complete submission evidence; automatic recovery is unavailable",
                ));
            };
            if receipt.get("agentSendFingerprint").and_then(Value::as_str) != Some(expected)
                || receipt.pointer("/sender/kind").and_then(Value::as_str) != Some("agent")
                || receipt.pointer("/sender/id").and_then(Value::as_str) != Some(&scope.agent_id)
                || receipt
                    .pointer("/sender/instanceId")
                    .and_then(Value::as_str)
                    != Some(&scope.instance_id)
            {
                return Err(failure(
                    "Receipt does not confirm the exact saved send; recovery did not append a message",
                ));
            }
            receipt
                .get("sequence")
                .and_then(Value::as_u64)
                .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
                .map(ReceiptOutcome::Committed)
                .ok_or_else(|| failure("Receipt publication evidence is invalid"))
        }
        _ => Err(failure(
            "Original receipt is unavailable; commit status remains unknown and recovery did not append a message",
        )),
    }
}
