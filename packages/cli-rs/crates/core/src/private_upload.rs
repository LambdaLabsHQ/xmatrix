//! The existing private-content upload protocol, shared by Channel and Page files.

use serde::Deserialize;
use serde_json::json;

use crate::error::{CliError, Result};
use crate::http;
use crate::protocol::with_route;

#[derive(Deserialize)]
struct UploadIntentResponse {
    upload: UploadIntentPaths,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadIntentPaths {
    final_path: String,
}

pub struct PrivateFile<'a> {
    pub scope: &'a str,
    pub owner_kind: &'a str,
    pub owner_id: &'a str,
    pub ref_id: &'a str,
    pub content_hash: &'a str,
    pub mime_type: &'a str,
    pub bytes: Vec<u8>,
}

/// Upload verified bytes, then bind them to their product owner. The returned
/// ref may be an existing ref for the same owner and bytes.
pub async fn upload(hub_url: &str, token: &str, file: PrivateFile<'_>) -> Result<String> {
    let intent_id = uuid::Uuid::new_v4().to_string();
    let expires_at = (time::OffsetDateTime::now_utc() + time::Duration::hours(1))
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|err| CliError::Launch(format!("Cannot format upload expiry: {err}")))?;
    let admitted: UploadIntentResponse = http::request_json(
        &with_route(hub_url, "/api/relay-v2/private-r2/upload-intents"),
        "POST",
        Some(token),
        Some(json!({
            "requestId": uuid::Uuid::new_v4().to_string(),
            "intentId": intent_id,
            "visibilityScopeId": file.scope,
            "contentHash": file.content_hash,
            "encodedSize": file.bytes.len(),
            "expiresAt": expires_at,
        })),
    )
    .await?;
    let expected = format!(
        "/api/relay-v2/private-r2/uploads/{}/scope/{}",
        urlencoding::encode(&intent_id),
        urlencoding::encode(file.scope),
    );
    if admitted.upload.final_path != expected {
        return Err(CliError::Launch(
            "Hub returned a noncanonical attachment upload path".into(),
        ));
    }
    http::put_bytes::<serde_json::Value>(
        &with_route(hub_url, &expected),
        token,
        file.mime_type,
        file.content_hash,
        file.bytes,
    )
    .await?;
    let committed: serde_json::Value = http::request_json(
        &with_route(hub_url, "/api/relay-v2/private-r2/blob-refs"),
        "POST",
        Some(token),
        Some(json!({
            "requestId": uuid::Uuid::new_v4().to_string(),
            "intentId": intent_id,
            "refId": file.ref_id,
            "ownerKind": file.owner_kind,
            "ownerId": file.owner_id,
            "visibilityScopeId": file.scope,
        })),
    )
    .await?;
    Ok(committed
        .get("refId")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty() && value.len() <= 300)
        .unwrap_or(file.ref_id)
        .to_string())
}
