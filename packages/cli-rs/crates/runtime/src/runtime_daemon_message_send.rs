use serde_json::{Value, json};
use xmatrix_cli_core::{
    config,
    error::{CliError, Result},
    http,
};

use super::runtime_send_authorization::{AuthorizedSend, authorize_send, failure};
use super::runtime_send_journal::SendLease;
use super::{DaemonHubJsonRequest, DaemonLocalHttpRequest, DaemonRequestBroker};

/// Called only after the broker's origin, method and capability checks.
pub(super) async fn execute(
    broker: &DaemonRequestBroker,
    request: &DaemonLocalHttpRequest,
    payload: DaemonHubJsonRequest,
) -> Result<Value> {
    if !payload.journal_send {
        return http::request_json(
            &payload.url,
            &payload.method,
            payload.token.as_deref(),
            payload.body,
        )
        .await;
    }
    let body = payload
        .body
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| failure("Journaled send requires a message payload"))?;
    let channel_id = message_channel(&payload.url, &payload.method)?;
    let message_id = body
        .get("clientMessageId")
        .and_then(Value::as_str)
        .ok_or_else(|| failure("Journaled send requires a message ID"))?
        .to_string();
    let recovery = super::runtime_send_recovery::RecoveryRequest::for_send(
        broker
            .hub_url
            .clone()
            .ok_or_else(|| failure("Send Hub is unavailable"))?,
        channel_id.clone(),
        message_id.clone(),
    );
    let authorization = authorize_send(broker, request, &channel_id, &message_id).await?;
    let scope = authorization.scope.clone();
    for (key, expected) in [
        ("senderAgentId", &scope.agent_id),
        ("senderRunId", &scope.run_id),
        ("senderAgentInstanceId", &scope.instance_id),
        ("senderExecutionKey", &authorization.execution_key),
    ] {
        if body.get(key).and_then(Value::as_str) != Some(expected.as_str()) {
            return Err(failure(
                "Send identity does not match the registered Run capability",
            ));
        }
    }
    let stored_payload = private_payload(payload.body.as_ref().expect("validated payload"))?;
    let root = config::profile_state_dir().join("send-operations-v1");
    let lease = tokio::task::spawn_blocking(move || {
        SendLease::prepare(&root, scope, stored_payload, config::unix_now_secs())
    })
    .await
    .map_err(|_| failure("Send journal task failed before submission"))?
    .map_err(failure)?;
    let result = submit_reply(
        authorization,
        lease,
        payload.body.expect("validated payload"),
    )
    .await;
    // A definitive 4xx is still checked against the receipt: post-commit
    // control can refuse after the append committed.
    let (refused, result) = match result {
        Ok(Submitted::Published(value)) => (false, Ok(value)),
        Ok(Submitted::Refused(error)) => (true, Err(error)),
        Err(error) => (false, Err(error)),
    };
    match result {
        Ok(value) => Ok(value),
        Err(original) => {
            // Every ambiguous failure may reconcile an existing commit. Only
            // transport failure/timeouts authorize one automatic append retry.
            let retry = matches!(original, CliError::Request(_) | CliError::RelayTransient(_));
            match super::runtime_send_recovery::recover_with_policy(
                broker, request, recovery, retry, refused,
            )
            .await
            {
                // A definitive refusal with no commit behind it is an ordinary
                // failure: report the Hub's reason without a recovery hint.
                Ok(recovered) if recovered["status"] == "rejected" => Err(failure(format!(
                    "Message {message_id} was not sent: {original}"
                ))),
                Ok(recovered) => Ok(
                    json!({"message": {"messageId": recovered["messageId"], "channelId": recovered["channelId"]},
                    "sendOperation": {"schemaVersion":1, "committed":true, "receiptSaved":recovered["receiptSaved"],
                        "recoveredFromReceipt":recovered["retried"] == false}}),
                ),
                Err(recovery) => Err(failure(format!(
                    "Message {message_id}: {original}. Recovery: {recovery}. Retain this ID and use --recover for the saved operation."
                ))),
            }
        }
    }
}

pub(super) async fn submit(
    authorization: AuthorizedSend,
    lease: SendLease,
    payload: Value,
) -> Result<Value> {
    match submit_reply(authorization, lease, payload).await? {
        Submitted::Published(value) => Ok(value),
        Submitted::Refused(error) => Err(error),
    }
}

pub(super) enum Submitted {
    Published(Value),
    /// The Hub answered with a definitive client error.
    Refused(CliError),
}

pub(super) async fn submit_reply(
    authorization: AuthorizedSend,
    lease: SendLease,
    payload: Value,
) -> Result<Submitted> {
    let message_id = &authorization.scope.message_id;
    let channel_id = &authorization.scope.channel_id;
    let token = authorization.token().await?;
    let reply = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        http::request_json_direct::<Value>(
            &authorization.append_url,
            "POST",
            Some(&token),
            Some(payload),
        ),
    )
    .await
    .map_err(|_| {
        CliError::RelayTransient(format!(
            "Send {message_id} timed out; commit status is unknown. Retain this message ID."
        ))
    })??;
    let definitive = reply.is_definitive_refusal();
    let result = match reply {
        http::JsonReply::Accepted(value) => value,
        http::JsonReply::Refused { error, .. } if definitive => {
            return Ok(Submitted::Refused(error));
        }
        http::JsonReply::Refused { error, .. } => return Err(error),
    };
    if result.pointer("/message/messageId").and_then(Value::as_str) != Some(message_id.as_str())
        || result.pointer("/message/channelId").and_then(Value::as_str) != Some(channel_id.as_str())
    {
        return Err(failure(format!(
            "Send {message_id} returned mismatched publication evidence; its recovery record was retained"
        )));
    }
    let saved = tokio::task::spawn_blocking(move || lease.confirm())
        .await
        .is_ok_and(|result| result.is_ok());
    let mut result = result;
    // A local disk failure after publication must not turn a committed message
    // into a failed send. Do not cache or fabricate the Hub's response body.
    if let Some(object) = result.as_object_mut() {
        object.insert(
            "sendOperation".into(),
            json!({ "schemaVersion": 1,
            "messageId": message_id, "committed": true, "receiptSaved": saved }),
        );
    }
    Ok(Submitted::Published(result))
}

fn message_channel(url: &str, method: &str) -> Result<String> {
    let url = reqwest::Url::parse(url).map_err(|_| failure("Invalid send URL"))?;
    let segments: Vec<_> = url.path().split('/').collect();
    if method != "POST"
        || url.query().is_some()
        || segments.len() != 5
        || segments[1] != "api"
        || segments[2] != "channels"
        || segments[4] != "messages"
    {
        return Err(failure(
            "Journaled send requires the Channel message append route",
        ));
    }
    let channel = urlencoding::decode(segments[3]).map_err(|_| failure("Invalid send Channel"))?;
    if channel.is_empty()
        || channel.len() > 200
        || channel.chars().any(|c| c.is_control() || c == '/')
    {
        return Err(failure("Invalid send Channel"));
    }
    Ok(channel.into_owned())
}

fn private_payload(body: &Value) -> Result<Value> {
    let mut body = body
        .as_object()
        .cloned()
        .ok_or_else(|| failure("Invalid send payload"))?;
    if body.keys().any(|key| {
        !matches!(
            key.as_str(),
            "body"
                | "clientMessageId"
                | "senderAgentId"
                | "senderAgentName"
                | "senderAgentInstanceId"
                | "senderRunId"
                | "senderExecutionKey"
                | "attachments"
                | "finalReplyExecutionId"
                | "replyToMessageId"
                | "awaitsResponse"
        )
    }) {
        return Err(failure("Journaled send contains unsupported fields"));
    }
    body.remove("senderExecutionKey");
    Ok(Value::Object(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_do_not_expand_journaling_to_other_writes() {
        assert_eq!(
            message_channel("https://hub.test/api/channels/channel%3A1/messages", "POST").unwrap(),
            "channel:1"
        );
        for path in [
            "/api/channels/c/messages/receipt",
            "/api/channels/c/messages?x=1",
            "/api/channels/%2F/messages",
            "/api/channels//messages",
        ] {
            assert!(message_channel(&format!("https://hub.test{path}"), "POST").is_err());
        }
        assert!(message_channel("https://hub.test/api/channels/c/messages", "GET").is_err());
    }

    #[test]
    fn recovery_payload_excludes_transport_credentials_and_unknown_fields() {
        let body = json!({"body": "private reply", "senderExecutionKey": "SECRET", "attachments": [],
                "finalReplyExecutionId": "11111111-1111-4111-8111-111111111111",
                "replyToMessageId": "22222222-2222-4222-8222-222222222222"});
        let stored = private_payload(&body).unwrap();
        assert_eq!(stored["body"], "private reply");
        assert_eq!(
            stored["finalReplyExecutionId"],
            body["finalReplyExecutionId"]
        );
        assert_eq!(stored["replyToMessageId"], body["replyToMessageId"]);
        assert!(!stored.to_string().contains("SECRET"));
        assert!(private_payload(&json!({"body": "reply", "token": "SECRET"})).is_err());
    }
}
