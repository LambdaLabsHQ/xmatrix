use std::time::Duration;

use serde::{Deserialize, Serialize};
use xmatrix_cli_core::error::{CliError, Result};
use xmatrix_cli_core::{http, protocol::with_route};

pub(crate) fn validated_message_id(value: &str) -> Result<&str> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err(CliError::Relay(
            "Message ID must contain 1–160 letters, digits, dots, colons, underscores or hyphens"
                .into(),
        ));
    }
    Ok(value)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Sender {
    kind: String,
    id: String,
    instance_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum Outcome {
    Committed {
        sequence: u64,
        #[serde(rename = "bodyHash")]
        body_hash: String,
        sender: Sender,
    },
    NotFound,
    ReceiptUnavailable,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    schema_version: u32,
    channel_id: String,
    message_id: String,
    observed_at: String,
    #[serde(flatten)]
    outcome: Outcome,
}

impl Receipt {
    fn validate(&self, channel: &str, message: &str) -> Result<()> {
        if self.schema_version != 1 || self.channel_id != channel || self.message_id != message {
            return Err(CliError::Relay("Message receipt scope is invalid".into()));
        }
        if let Outcome::Committed {
            sequence,
            body_hash,
            sender,
        } = &self.outcome
            && (*sequence == 0
                || body_hash.len() != 64
                || !body_hash.bytes().all(|b| b.is_ascii_hexdigit())
                || !matches!(sender.kind.as_str(), "user" | "agent")
                || sender.id.is_empty())
        {
            return Err(CliError::Relay(
                "Message receipt evidence is invalid".into(),
            ));
        }
        Ok(())
    }
}

pub async fn cmd_message_receipt(
    hub_url: &str,
    token: &str,
    channel: &str,
    message_id: &str,
    json: bool,
) -> Result<()> {
    validated_message_id(message_id)?;
    if channel.starts_with("run:") {
        return Err(CliError::Relay(
            "--receipt requires a Channel URL or ID".into(),
        ));
    }
    let receipt = tokio::time::timeout(Duration::from_secs(30), async {
        let channel_id = super::resolve_channel_reference(hub_url, token, channel).await?;
        let receipt: Receipt = http::request_json(
            &with_route(
                hub_url,
                &format!(
                    "/api/channels/{}/messages/receipt",
                    urlencoding::encode(&channel_id)
                ),
            ),
            "POST",
            Some(token),
            Some(serde_json::json!({ "messageId": message_id })),
        )
        .await?;
        receipt.validate(&channel_id, message_id)?;
        Ok::<_, CliError>(receipt)
    })
    .await
    .map_err(|_| {
        CliError::Relay("Message receipt lookup timed out; commit status remains unknown".into())
    })??;
    if json {
        println!("{}", serde_json::to_string_pretty(&receipt)?);
    } else {
        match receipt.outcome {
            Outcome::Committed { sequence, .. } => println!(
                "Message {message_id} was committed (sequence {sequence}). This receipt confirms message publication only."
            ),
            Outcome::NotFound => println!(
                "No commit observed for message {message_id}. An in-flight append may still commit; retain this ID."
            ),
            Outcome::ReceiptUnavailable => println!(
                "Commit status for message {message_id} is unknown because its original receipt is unavailable. Do not resend with a new ID."
            ),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipt_checks_exact_scope_and_drops_unknown_private_fields() {
        let receipt: Receipt = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "channelId": "channel", "messageId": "message", "observedAt": "2026-09-13T00:00:00Z",
            "status": "committed", "sequence": 1, "bodyHash": "a".repeat(64),
            "sender": { "kind": "agent", "id": "agent", "instanceId": "instance", "token": "PRIVATE_SENTINEL" },
            "body": "PRIVATE_SENTINEL", "executionKey": "PRIVATE_SENTINEL",
        })).unwrap();
        receipt.validate("channel", "message").unwrap();
        assert!(receipt.validate("other", "message").is_err());
        assert!(receipt.validate("channel", "other").is_err());
        assert!(
            !serde_json::to_string(&receipt)
                .unwrap()
                .contains("PRIVATE_SENTINEL")
        );
    }

    #[test]
    fn message_ids_remain_safe_and_are_never_trimmed_or_truncated() {
        for value in ["message:1", "a-b_c.2"] {
            assert_eq!(validated_message_id(value).unwrap(), value);
        }
        for value in ["", " id", "id\n", "../path", "id\x1b[2J"] {
            assert!(validated_message_id(value).is_err());
        }
        assert!(validated_message_id(&"a".repeat(161)).is_err());
    }
}
