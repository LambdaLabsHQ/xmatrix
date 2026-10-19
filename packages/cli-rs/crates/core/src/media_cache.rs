//! An image an Agent is shown — a Channel attachment, a file pasted into a
//! page — downloaded once into the attachment cache, with a named copy whose
//! extension a harness's file reader opens as an image.

use std::future::Future;
use std::path::{Path, PathBuf};

use crate::attachment_cache::{
    attachment_cache_dir, attachment_recently_refused, copy_cached_attachment_to,
    read_cached_attachment, remember_refused_attachment, write_cached_attachment,
};
use crate::error::{CliError, Result};
use crate::hex::sha256_hex;
use crate::http;

/// The largest body the CLI downloads for an Agent to look at.
pub const MEDIA_MAX_BYTES: u64 = 25 * 1024 * 1024;

/// Where the copy a harness's file tool opens is written.
pub enum LocalCopy<'a> {
    /// `<prefix>-<id, up to 12 characters>-<name>.<extension of its type>` in the attachment cache.
    Named {
        prefix: &'a str,
        id: &'a str,
        name: &'a str,
    },
    /// This path.
    At(PathBuf),
}

/// One body to download: where it is cached, what it must be, and its copy.
pub struct CachedMedia<'a> {
    pub stem: String,
    /// The size the authority states; without one, the response's own length is held to the limit.
    pub expected_size: Option<u64>,
    /// A body named by its SHA-256 is checked against it.
    pub content_hash: Option<&'a str>,
    pub mime_type: &'a str,
    pub copy: LocalCopy<'a>,
}

impl CachedMedia<'_> {
    /// The named copy of the cached body, or of what `send` answers. A body the
    /// Hub refused is not asked for again until the refusal expires.
    pub async fn fetch<F, S>(&self, send: S) -> Result<PathBuf>
    where
        S: FnOnce() -> F,
        F: Future<Output = Result<reqwest::Response>>,
    {
        if self
            .expected_size
            .is_some_and(|size| size == 0 || size > MEDIA_MAX_BYTES)
        {
            return Err(CliError::Http(
                "Media is outside the CLI media limit".into(),
            ));
        }
        if let Some(bytes) = read_cached_attachment(&self.stem, self.expected_size) {
            return self.write_copy(self.mime_type, &bytes);
        }
        if attachment_recently_refused(&self.stem) {
            return Err(CliError::Http(
                "Media was refused recently; not requesting it again yet".into(),
            ));
        }
        let response = send().await?;
        if matches!(
            response.status(),
            reqwest::StatusCode::FORBIDDEN | reqwest::StatusCode::NOT_FOUND
        ) {
            let _ = remember_refused_attachment(&self.stem);
        }
        let response = http::require_success(response).await?;
        let length = response.content_length();
        if self
            .expected_size
            .is_some_and(|size| length.is_some_and(|length| length != size))
            || length.is_some_and(|length| length > MEDIA_MAX_BYTES)
        {
            return Err(CliError::Http(
                "Media length does not match authority".into(),
            ));
        }
        let mime_type = http::response_mime_type(&response)
            .map(str::to_string)
            .unwrap_or_else(|| self.mime_type.to_string());
        let kind = |mime: &str| mime.split('/').next().unwrap_or("").to_ascii_lowercase();
        if !mime_type.eq_ignore_ascii_case(self.mime_type)
            && !self.mime_type.is_empty()
            && kind(&mime_type) != kind(self.mime_type)
        {
            return Err(CliError::Http(format!(
                "Media type {mime_type} is not the {} the authority stated",
                self.mime_type
            )));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|err| CliError::Http(format!("media body read failed: {err}")))?;
        if self
            .expected_size
            .is_some_and(|size| bytes.len() as u64 != size)
            || bytes.len() as u64 > MEDIA_MAX_BYTES
        {
            return Err(CliError::Http(
                "Media body length does not match authority".into(),
            ));
        }
        if self
            .content_hash
            .is_some_and(|hash| sha256_hex(&bytes) != hash)
        {
            return Err(CliError::Http(
                "Media body does not match its content hash".into(),
            ));
        }
        let _ = write_cached_attachment(&self.stem, &bytes);
        self.write_copy(&mime_type, &bytes)
    }

    fn write_copy(&self, mime_type: &str, bytes: &[u8]) -> Result<PathBuf> {
        let path = match &self.copy {
            LocalCopy::At(path) => path.clone(),
            LocalCopy::Named { prefix, id, name } => {
                let safe_name: String = Path::new(name)
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("attachment")
                    .chars()
                    .map(|ch| {
                        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                            ch
                        } else {
                            '-'
                        }
                    })
                    .collect();
                attachment_cache_dir().join(format!(
                    "{prefix}-{}-{safe_name}.{}",
                    &id[..id.len().min(12)],
                    media_extension(mime_type, name),
                ))
            }
        };
        copy_cached_attachment_to(&path, bytes)?;
        Ok(path)
    }
}

/// The extension a file of this type and name is saved with.
pub fn media_extension(mime_type: &str, name: &str) -> &'static str {
    let lower_mime = mime_type.to_ascii_lowercase();
    for (needle, extension) in [
        ("png", "png"),
        ("jpeg", "jpg"),
        ("jpg", "jpg"),
        ("gif", "gif"),
        ("webp", "webp"),
        ("avif", "avif"),
        ("pdf", "pdf"),
        ("mp4", "mp4"),
        ("markdown", "md"),
    ] {
        if lower_mime.contains(needle) {
            return extension;
        }
    }
    Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| match value.to_ascii_lowercase().as_str() {
            "png" => "png",
            "jpg" | "jpeg" => "jpg",
            "gif" => "gif",
            "webp" => "webp",
            "avif" => "avif",
            "mp4" => "mp4",
            "webm" => "webm",
            "md" | "markdown" => "md",
            "txt" => "txt",
            "pdf" => "pdf",
            "zip" => "zip",
            "json" => "json",
            _ => "bin",
        })
        .unwrap_or("bin")
}
