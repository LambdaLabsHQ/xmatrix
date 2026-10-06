use crate::hex::sha256_hex;
use std::path::{Path, PathBuf};

use crate::config::{replace_file_atomically, unique_temporary_path};
use crate::protocol::ChannelAttachment;

/// Durable machine-local attachment bodies, keyed by identity or URL path so
/// signed-token rotation and later views reuse bytes instead of re-downloading.
pub fn attachment_cache_dir() -> PathBuf {
    attachment_cache_dir_at(&crate::config::profile_state_dir())
}

/// The same directory under an explicitly supplied profile state root, for
/// callers that captured the root at startup instead of reading the
/// task-local profile context.
pub fn attachment_cache_dir_at(profile_state_root: &Path) -> PathBuf {
    profile_state_root.join("attachment-cache")
}

pub fn cache_stem_for_url(url: &str) -> String {
    sha256_hex(url_cache_key(url).as_bytes())
}

pub fn cache_stem_for_identity(
    channel_id: &str,
    message_id: &str,
    attachment_id: &str,
    size: u64,
) -> String {
    sha256_hex(format!("identity\0{channel_id}\0{message_id}\0{attachment_id}\0{size}").as_bytes())
}

pub fn cache_stem_for_bytes(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}

pub fn cached_attachment_path(stem: &str) -> PathBuf {
    attachment_cache_dir().join(stem)
}

pub fn read_cached_attachment(stem: &str, expected_size: Option<u64>) -> Option<Vec<u8>> {
    let path = cached_attachment_path(stem);
    let bytes = std::fs::read(&path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    if let Some(size) = expected_size
        && bytes.len() as u64 != size
    {
        return None;
    }
    Some(bytes)
}

/// How long a refused attachment read is remembered before it is asked again:
/// long enough that re-reading a history does not re-request every refused
/// image, short enough that a newly granted or repaired one is read soon.
pub const REFUSED_ATTACHMENT_TTL_SECS: u64 = 60 * 60;

fn refused_marker_path(dir: &Path, stem: &str) -> PathBuf {
    dir.join(format!("{stem}.refused"))
}

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// Whether the Hub refused this attachment (403 or 404) within the TTL. Asking
/// again before then would only be refused again, after a full authorization.
pub fn attachment_recently_refused(stem: &str) -> bool {
    attachment_refused_within(&attachment_cache_dir(), stem, unix_now_secs())
}

/// Remember that the Hub refused this attachment, as of now.
pub fn remember_refused_attachment(stem: &str) -> std::io::Result<()> {
    remember_refused_attachment_at(&attachment_cache_dir(), stem, unix_now_secs())
}

fn attachment_refused_within(dir: &Path, stem: &str, now_secs: u64) -> bool {
    std::fs::read_to_string(refused_marker_path(dir, stem))
        .ok()
        .and_then(|text| text.trim().parse::<u64>().ok())
        .is_some_and(|refused_at| now_secs.saturating_sub(refused_at) < REFUSED_ATTACHMENT_TTL_SECS)
}

fn remember_refused_attachment_at(dir: &Path, stem: &str, now_secs: u64) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(refused_marker_path(dir, stem), now_secs.to_string())
}

pub fn write_cached_attachment(stem: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    if bytes.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "cached attachment body is empty",
        ));
    }
    let dir = attachment_cache_dir();
    std::fs::create_dir_all(&dir)?;
    let destination = cached_attachment_path(stem);
    let temporary = unique_temporary_path(&destination);
    std::fs::write(&temporary, bytes)?;
    match replace_file_atomically(&temporary, &destination) {
        Ok(()) => Ok(destination),
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            Err(error)
        }
    }
}

/// Prefer an identity-backed key, then a signed-URL path, then the raw bytes.
pub fn cache_stem_for_attachment(attachment: &ChannelAttachment, bytes: Option<&[u8]>) -> String {
    let channel_id = attachment
        .channel_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let message_id = attachment
        .message_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let (Some(channel_id), Some(message_id)) = (channel_id, message_id)
        && !attachment.id.trim().is_empty()
        && attachment.size > 0
    {
        return cache_stem_for_identity(
            channel_id,
            message_id,
            attachment.id.trim(),
            attachment.size,
        );
    }
    if let Some(url) = attachment
        .url
        .as_deref()
        .map(str::trim)
        .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
    {
        return cache_stem_for_url(url);
    }
    cache_stem_for_bytes(bytes.unwrap_or(attachment.data_url.as_bytes()))
}

pub fn read_cached_attachment_bytes(attachment: &ChannelAttachment) -> Option<Vec<u8>> {
    let stem = cache_stem_for_attachment(attachment, None);
    let expected = (attachment.size > 0).then_some(attachment.size);
    read_cached_attachment(&stem, expected)
}

pub fn store_cached_attachment_bytes(
    attachment: &ChannelAttachment,
    bytes: &[u8],
) -> std::io::Result<PathBuf> {
    write_cached_attachment(&cache_stem_for_attachment(attachment, Some(bytes)), bytes)
}

pub fn copy_cached_attachment_to(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, bytes)
}

fn url_cache_key(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(parsed) if parsed.path().contains("/attachments/") => parsed.path().to_string(),
        Ok(parsed) => parsed.as_str().to_string(),
        Err(_) => url.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_attachment_urls_share_a_cache_stem() {
        assert_eq!(
            cache_stem_for_url(
                "https://xmatrix.sh/api/xmatrix/channels/ch-1/attachments/att-1?token=one",
            ),
            cache_stem_for_url(
                "https://xmatrix.sh/api/xmatrix/channels/ch-1/attachments/att-1?token=two",
            ),
        );
    }

    #[test]
    fn a_refused_attachment_is_not_asked_again_until_its_ttl_passes() {
        let dir = std::env::temp_dir().join(format!(
            "xmatrix-refused-attachment-{}-{}",
            std::process::id(),
            unix_now_secs()
        ));
        let stem = cache_stem_for_identity("ch", "msg", "att", 12);
        assert!(!attachment_refused_within(&dir, &stem, 1_000));
        remember_refused_attachment_at(&dir, &stem, 1_000).expect("marker is written");
        assert!(attachment_refused_within(&dir, &stem, 1_000));
        assert!(attachment_refused_within(
            &dir,
            &stem,
            1_000 + REFUSED_ATTACHMENT_TTL_SECS - 1
        ));
        assert!(!attachment_refused_within(
            &dir,
            &stem,
            1_000 + REFUSED_ATTACHMENT_TTL_SECS
        ));
        let other = cache_stem_for_identity("ch", "msg", "other", 12);
        assert!(!attachment_refused_within(&dir, &other, 1_000));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn identity_keys_include_size_so_a_reversion_misses() {
        let first = cache_stem_for_identity("ch", "msg", "att", 12);
        let second = cache_stem_for_identity("ch", "msg", "att", 13);
        assert_ne!(first, second);
        assert_eq!(first.len(), 64);
    }
}
