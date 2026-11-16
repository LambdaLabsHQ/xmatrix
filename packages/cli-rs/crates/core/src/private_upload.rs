//! The existing private-content upload protocol, shared by Channel and Page files.
//!
//! A file of any size is read from disk as it is sent, never whole: one PUT
//! when it fits the Hub's request size, otherwise a multipart upload of
//! fixed-size parts the Hub chains one SHA-256 through before publishing it.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::error::{CliError, Result};
use crate::hex::lowercase_hex;
use crate::http;
use crate::protocol::with_route;

/// The largest private blob the Hub stores (`RELAY_V2_BLOB_MAX_BYTES`):
/// R2's 10,000 multipart parts of one 64 MiB Worker request each.
pub const BLOB_MAX_BYTES: u64 = 10_000 * 64 * 1024 * 1024;

/// Sends of one part after a transient failure before the upload fails.
const PART_ATTEMPTS: u32 = 5;

const HASH_CHUNK_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
struct UploadIntentResponse {
    upload: UploadIntentPaths,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadIntentPaths {
    final_path: String,
    /// The largest body the Hub takes in one request; absent from a Hub
    /// without multipart uploads, which takes every body in one.
    part_bytes: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MultipartStatus {
    part_bytes: u64,
    part_count: u64,
    uploaded_parts: u64,
    complete: bool,
}

/// A local file to store privately and bind to its product owner.
pub struct PrivateFile<'a> {
    pub scope: &'a str,
    pub owner_kind: &'a str,
    pub owner_id: &'a str,
    pub ref_id: &'a str,
    pub content_hash: &'a str,
    pub mime_type: &'a str,
    pub path: &'a Path,
    pub size: u64,
}

/// The SHA-256 and length of a file, read in bounded chunks.
pub fn sha256_file(path: &Path) -> Result<(String, u64)> {
    let mut file = std::fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0; HASH_CHUNK_BYTES];
    let mut size = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        size += read as u64;
    }
    Ok((lowercase_hex(&digest.finalize()), size))
}

/// Bytes `offset..offset + length` of the file, exactly.
fn read_range(path: &Path, offset: u64, length: u64) -> Result<Vec<u8>> {
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(length).read_to_end(&mut bytes)?;
    if bytes.len() as u64 != length {
        return Err(CliError::Launch(format!(
            "{} changed while it was being uploaded",
            path.display()
        )));
    }
    Ok(bytes)
}

/// The parts a body of `size` bytes goes in when each holds `part_bytes`.
fn part_count(size: u64, part_bytes: u64) -> u64 {
    size.div_ceil(part_bytes).max(1)
}

/// Where each part of a multipart upload starts and how long it is.
fn part_range(size: u64, part_bytes: u64, part: u64) -> (u64, u64) {
    let offset = (part - 1) * part_bytes;
    (offset, part_bytes.min(size - offset))
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
            "encodedSize": file.size,
            "expiresAt": expires_at,
        })),
    )
    .await?;
    let base = format!(
        "/api/relay-v2/private-r2/uploads/{}",
        urlencoding::encode(&intent_id)
    );
    let scope = format!("/scope/{}", urlencoding::encode(file.scope));
    let expected = format!("{base}{scope}");
    if admitted.upload.final_path != expected {
        return Err(CliError::Launch(
            "Hub returned a noncanonical attachment upload path".into(),
        ));
    }
    match admitted.upload.part_bytes {
        Some(part_bytes) if file.size > part_bytes => {
            upload_in_parts(hub_url, token, &file, &base, &scope, part_bytes).await?
        }
        _ => {
            http::put_bytes::<serde_json::Value>(
                &with_route(hub_url, &expected),
                token,
                file.mime_type,
                file.content_hash,
                read_range(file.path, 0, file.size)?,
            )
            .await?;
        }
    }
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

/// Sends a file larger than one request in parts, from wherever the Hub says
/// the upload stands: a part it holds is not sent again, and a part that fails
/// transiently is sent again on its own. Only one part is in memory at a time.
async fn upload_in_parts(
    hub_url: &str,
    token: &str,
    file: &PrivateFile<'_>,
    base: &str,
    scope: &str,
    part_bytes: u64,
) -> Result<()> {
    let status: MultipartStatus = http::request_json(
        &with_route(hub_url, &format!("{base}/multipart{scope}")),
        "POST",
        Some(token),
        None,
    )
    .await?;
    if status.complete {
        return Ok(());
    }
    let parts = part_count(file.size, part_bytes);
    if status.part_bytes != part_bytes
        || status.part_count != parts
        || status.uploaded_parts > parts
    {
        return Err(CliError::Launch(
            "Hub returned an invalid multipart upload".into(),
        ));
    }
    for part in status.uploaded_parts + 1..=parts {
        let (offset, length) = part_range(file.size, part_bytes, part);
        let url = with_route(hub_url, &format!("{base}/multipart/parts/{part}{scope}"));
        let mut attempt = 1;
        loop {
            let bytes = read_range(file.path, offset, length)?;
            match http::put_bytes::<serde_json::Value>(
                &url,
                token,
                file.mime_type,
                file.content_hash,
                bytes,
            )
            .await
            {
                Ok(_) => break,
                Err(error) if attempt < PART_ATTEMPTS && error.is_transient() => {
                    tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
                    attempt += 1;
                }
                Err(error) => return Err(error),
            }
        }
    }
    http::request_json::<serde_json::Value>(
        &with_route(hub_url, &format!("{base}/multipart/complete{scope}")),
        "POST",
        Some(token),
        None,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
#[path = "private_upload_tests.rs"]
mod tests;
