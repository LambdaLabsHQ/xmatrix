//! A body an Agent is shown — a Channel attachment, a file pasted into a
//! page — downloaded once into the attachment cache, with a named copy whose
//! extension a harness's file reader opens by type.
//!
//! Downloads have no size ceiling of their own: the body streams to disk and is
//! held to the size (and hash, when named) the authority stated.

use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::attachment_cache::{
    attachment_cache_dir, attachment_recently_refused, cached_attachment_path,
    remember_refused_attachment,
};
use crate::config::{replace_file_atomically, unique_temporary_path};
use crate::error::{CliError, Result};
use crate::hex::lowercase_hex;
use crate::http;

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
    /// The size the authority states; without one, the response's own length is trusted.
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
        if self.expected_size == Some(0) {
            return Err(CliError::Http("Media is empty".into()));
        }
        let cached = cached_attachment_path(&self.stem);
        if cached_body_is_whole(&cached, self.expected_size) {
            return self.write_copy(self.mime_type, &cached);
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
        if self.expected_size.is_some_and(|size| {
            response
                .content_length()
                .is_some_and(|length| length != size)
        }) {
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
        self.stream_into_cache(response, &cached).await?;
        self.write_copy(&mime_type, &cached)
    }

    /// Stream the body to a temporary file beside the cache entry, hashing as
    /// it goes, and publish it only once its size and hash match.
    async fn stream_into_cache(
        &self,
        mut response: reqwest::Response,
        cached: &Path,
    ) -> Result<()> {
        let dir = attachment_cache_dir();
        std::fs::create_dir_all(&dir)?;
        let temporary = unique_temporary_path(cached);
        let result = async {
            let mut file = std::io::BufWriter::new(std::fs::File::create(&temporary)?);
            let mut hasher = Sha256::new();
            let mut received: u64 = 0;
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|err| CliError::Http(format!("media body read failed: {err}")))?
            {
                received += chunk.len() as u64;
                if self.expected_size.is_some_and(|size| received > size) {
                    return Err(CliError::Http(
                        "Media body length does not match authority".into(),
                    ));
                }
                hasher.update(&chunk);
                file.write_all(&chunk)?;
            }
            file.flush()?;
            if received == 0 || self.expected_size.is_some_and(|size| received != size) {
                return Err(CliError::Http(
                    "Media body length does not match authority".into(),
                ));
            }
            if self
                .content_hash
                .is_some_and(|hash| lowercase_hex(&hasher.finalize()) != hash)
            {
                return Err(CliError::Http(
                    "Media body does not match its content hash".into(),
                ));
            }
            replace_file_atomically(&temporary, cached)?;
            Ok(())
        }
        .await;
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }

    fn write_copy(&self, mime_type: &str, cached: &Path) -> Result<PathBuf> {
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
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)?;
        }
        if path != cached {
            std::fs::copy(cached, &path)?;
        }
        Ok(path)
    }
}

/// A cached body is reused only when it is non-empty and, when the authority
/// stated one, exactly its size.
fn cached_body_is_whole(path: &Path, expected_size: Option<u64>) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| {
        metadata.is_file()
            && metadata.len() > 0
            && expected_size.is_none_or(|size| metadata.len() == size)
    })
}

/// The extension a file of this type and name is saved with.
pub(crate) fn media_extension(mime_type: &str, name: &str) -> &'static str {
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
        ("quicktime", "mov"),
        ("webm", "webm"),
        ("flac", "flac"),
        ("wav", "wav"),
        ("audio/mpeg", "mp3"),
        ("ogg", "ogg"),
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
            "mov" => "mov",
            "webm" => "webm",
            "mp3" => "mp3",
            "m4a" => "m4a",
            "flac" => "flac",
            "wav" => "wav",
            "ogg" => "ogg",
            "md" | "markdown" => "md",
            "txt" => "txt",
            "pdf" => "pdf",
            "zip" => "zip",
            "json" => "json",
            _ => "bin",
        })
        .unwrap_or("bin")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_and_video_attachments_keep_a_playable_extension() {
        assert_eq!(media_extension("audio/flac", "track.flac"), "flac");
        assert_eq!(media_extension("audio/mpeg", "track.mp3"), "mp3");
        assert_eq!(media_extension("audio/wav", "take.wav"), "wav");
        assert_eq!(media_extension("video/quicktime", "IMG_2120.mov"), "mov");
        assert_eq!(
            media_extension("application/octet-stream", "song.m4a"),
            "m4a"
        );
    }

    #[test]
    fn a_cached_body_is_reused_only_at_the_stated_size() {
        let path = std::env::temp_dir().join(format!("xmatrix-media-cache-{}", std::process::id()));
        std::fs::write(&path, b"body").unwrap();
        assert!(cached_body_is_whole(&path, Some(4)));
        assert!(cached_body_is_whole(&path, None));
        assert!(!cached_body_is_whole(&path, Some(5)));
        let _ = std::fs::remove_file(&path);
        assert!(!cached_body_is_whole(&path, None));
    }
}
