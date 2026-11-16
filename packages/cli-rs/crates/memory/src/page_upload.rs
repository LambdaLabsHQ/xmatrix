//! Explicit local-file upload. Page text never causes an implicit file read.

use std::path::Path;

use serde::Deserialize;
use xmatrix_cli_core::error::{CliError, Result};
use xmatrix_cli_core::protocol::with_route;
use xmatrix_cli_core::{http, page_media, private_upload};

#[derive(Deserialize)]
struct PageAccessResponse {
    page: PageAccess,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageAccess {
    can_edit: bool,
}

pub(crate) async fn upload(
    hub: &str,
    token: &str,
    space: &str,
    page: &str,
    path: &Path,
) -> Result<String> {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let extension = if extension == "jpeg" {
        "jpg"
    } else {
        &extension
    };
    let mime_type = page_media::page_media_type(extension).ok_or_else(|| {
        CliError::Launch("Pages accept PNG, JPEG, GIF, WebP, AVIF, MP4, WebM and MOV files".into())
    })?;
    let metadata = std::fs::metadata(path)
        .map_err(|err| CliError::Launch(format!("Cannot open {}: {err}", path.display())))?;
    if !metadata.is_file() {
        return Err(CliError::Launch(format!(
            "{} is not a regular file",
            path.display()
        )));
    }
    if metadata.len() == 0 || metadata.len() > private_upload::BLOB_MAX_BYTES {
        return Err(CliError::Launch(format!(
            "Page media must be between 1 byte and {} GiB",
            private_upload::BLOB_MAX_BYTES >> 30
        )));
    }
    // Fail before uploading bytes when the target page is unavailable or read-only.
    // The Hub rechecks Page authority when the content ref is committed.
    let access: PageAccessResponse = http::request_json(
        &with_route(hub, &super::page::page_route(space, page)),
        "GET",
        Some(token),
        None,
    )
    .await?;
    if !access.page.can_edit {
        return Err(CliError::Launch("You cannot edit this Page".into()));
    }
    let (hash, size) = private_upload::sha256_file(path)
        .map_err(|err| CliError::Launch(format!("Cannot read {}: {err}", path.display())))?;
    private_upload::upload(
        hub,
        token,
        private_upload::PrivateFile {
            scope: &format!("space:{space}"),
            owner_kind: "page_media",
            owner_id: page,
            ref_id: &format!("page-media:{page}:{hash}"),
            content_hash: &hash,
            mime_type,
            path,
            size,
        },
    )
    .await?;
    // A fixed alt avoids interpreting an untrusted file name as Markdown.
    Ok(format!("![media](xmatrix:page-media/{hash}.{extension})"))
}

#[cfg(test)]
#[path = "page_upload_tests.rs"]
mod tests;
