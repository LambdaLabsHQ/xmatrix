//! Must match protocol/agent-send-submission.ts before automatic recovery.
use serde_json::{Value, json};

use super::runtime_send_journal::{SendScope, fingerprint};

pub(super) fn submission_fingerprint(scope: &SendScope, payload: &Value) -> Option<String> {
    if payload.as_object()?.keys().any(|key| {
        ![
            "body",
            "clientMessageId",
            "senderAgentId",
            "senderAgentName",
            "senderAgentInstanceId",
            "senderRunId",
            "senderExecutionKey",
            "attachments",
            "finalReplyExecutionId",
            "awaitsResponse",
        ]
        .contains(&key.as_str())
    }) {
        return None;
    }
    let body = payload.get("body")?.as_str()?;
    let mut attachments = Vec::new();
    if let Some(values) = payload.get("attachments") {
        let values = values.as_array()?;
        if values.len() > 10 {
            return None;
        }
        for attachment in values {
            let attachment = attachment.as_object()?;
            if attachment.keys().any(|key| {
                ![
                    "attachmentId",
                    "objectKey",
                    "contentHash",
                    "encodedBytes",
                    "mimeType",
                    "name",
                ]
                .contains(&key.as_str())
            }) {
                return None;
            }
            let encoded_bytes = attachment.get("encodedBytes")?.as_u64()?;
            if encoded_bytes == 0 || encoded_bytes > 9_007_199_254_740_991 {
                return None;
            }
            attachments.push(json!([
                attachment.get("attachmentId")?.as_str()?,
                attachment.get("objectKey")?.as_str()?,
                attachment.get("contentHash")?.as_str()?,
                encoded_bytes,
                attachment.get("mimeType")?.as_str()?,
                attachment.get("name")?.as_str()?,
            ]));
        }
    }
    let mut values = json!([
        "xmatrix-agent-send-v1",
        scope.channel_id,
        scope.message_id,
        scope.agent_id,
        scope.run_id,
        scope.instance_id,
        body,
        attachments
    ]);
    if let Some(final_id) = payload.get("finalReplyExecutionId") {
        let id = final_id.as_str()?;
        if uuid::Uuid::parse_str(id).ok()?.to_string() != id {
            return None;
        }
        values[0] = json!("xmatrix-agent-send-v2");
        values.as_array_mut()?.push(json!(id));
    }
    let canonical = serde_json::to_vec(&values).ok()?;
    Some(fingerprint(&canonical))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_and_attachment_submission_matches_the_shared_golden_vector() {
        let scope = SendScope {
            profile_id: None,
            hub_origin: "https://hub.test".into(),
            channel_id: "channel:1".into(),
            message_id: "message:1".into(),
            agent_id: "agent:1".into(),
            run_id: "run:1".into(),
            instance_id: "instance:1".into(),
            execution_fingerprint: "unused".into(),
        };
        let payload = json!({"body":"@github 中文 😀\n\"reply\"", "attachments":[{
            "attachmentId":"file:1", "objectKey":"private/file", "contentHash":"a".repeat(64),
            "encodedBytes":123, "mimeType":"text/plain", "name":"结果.txt"}]});
        let mut final_payload = payload.clone();
        final_payload["finalReplyExecutionId"] = json!("11111111-1111-4111-8111-111111111111");
        assert_eq!(
            submission_fingerprint(&scope, &final_payload).unwrap(),
            "34c7e469e23fecd5765c687a57cec927cf0c2580907800533addccadf4840137"
        );
        for id in [
            Value::Null,
            json!("current"),
            json!("AAAAAAAA-1111-4111-8111-111111111111"),
            json!(12),
        ] {
            final_payload["finalReplyExecutionId"] = id;
            assert!(submission_fingerprint(&scope, &final_payload).is_none());
        }
        assert_eq!(
            submission_fingerprint(&scope, &payload).unwrap(),
            "63d4afbc4c67bcf01c33a37bea66778ed469ccd1bda94980b723bea04811fe15"
        );
        let mut changed = payload;
        changed["attachments"][0]["name"] = json!("other.txt");
        assert_ne!(
            submission_fingerprint(&scope, &changed).unwrap(),
            "63d4afbc4c67bcf01c33a37bea66778ed469ccd1bda94980b723bea04811fe15"
        );
        changed["attachments"][0]["encodedBytes"] = json!(1.5);
        assert!(submission_fingerprint(&scope, &changed).is_none());
    }
}
