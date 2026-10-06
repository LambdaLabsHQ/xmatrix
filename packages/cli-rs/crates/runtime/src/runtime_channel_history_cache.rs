//! Machine-level channel-history cache, owned by the daemon.
//!
//! One cache per local connection profile. All decision logic lives in the
//! `xmatrix-history-cache` crate; this module owns storage under the admitted
//! ProfileStateRoot (daemon-only — the agent sandbox denies the installation
//! config tree) and the Hub reads. Every Hub read for a request uses the
//! REQUESTING AGENT'S run token, so authorization stays per-reader: the
//! authenticated first-page fetch is the proof this agent may read this
//! channel now, and only after it succeeds are shared cached bytes served.
//! Any cache-layer failure falls back to a plain full walk — the cache must
//! never break a read.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use xmatrix_cli_core::error::{self, CliError};
use xmatrix_cli_core::protocol::with_route;
use xmatrix_cli_core::{config, http};
use xmatrix_history_cache::{
    CachedChannelHistory, CachedMessage, ContentAuthority, ReadPlan, assemble, build_cache,
    extend_cache, plan_read,
};

/// A channel whose assembled entry serializes beyond this is not cached.
const HISTORY_CACHE_MAX_ENTRY_BYTES: u64 = 32 * 1024 * 1024;
/// Directory ceiling; oldest-mtime entries are evicted past it.
const HISTORY_CACHE_MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const HISTORY_PAGE_LIMIT: usize = 200;
const HISTORY_CONTENT_PROTOCOL_VERSION: u64 = 1;

pub(crate) fn history_cache_dir_at(profile_state_root: &Path) -> PathBuf {
    profile_state_root.join("history-cache")
}

/// Exclusive advisory lock over the whole history-cache directory, in the
/// daemon.lock style. The daemon is one process; the lock serializes
/// concurrent broker requests' read-modify-write cycles.
pub(crate) struct HistoryCacheLock {
    file: File,
}

impl HistoryCacheLock {
    pub(crate) fn acquire_in(dir: &Path) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join("lock"))?;
        file.lock()?;
        Ok(Self { file })
    }
}

impl Drop for HistoryCacheLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

#[derive(Deserialize)]
pub(crate) struct DaemonChannelHistoryPayload {
    #[serde(rename = "channelId")]
    pub channel_id: String,
    #[serde(rename = "runToken")]
    pub run_token: String,
}

#[derive(Deserialize)]
struct HubHistoryPage {
    #[serde(default)]
    messages: Vec<serde_json::Value>,
    #[serde(rename = "hasMore", default)]
    has_more: bool,
    #[serde(rename = "contentAuthority", default)]
    content_authority: Option<HubContentAuthority>,
}

#[derive(Deserialize)]
struct HubContentAuthority {
    #[serde(rename = "protocolVersion")]
    protocol_version: u64,
    #[serde(rename = "contentRevision")]
    content_revision: u64,
}

fn history_cache_dir() -> error::Result<PathBuf> {
    Ok(history_cache_dir_at(&config::profile_state_dir()))
}

/// Channel ids are UUIDs; anything else must not become a filename.
fn cache_path_for(dir: &Path, channel_id: &str) -> error::Result<PathBuf> {
    if channel_id.is_empty()
        || !channel_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(CliError::Relay(format!(
            "channel id is not cache-path safe: {channel_id}"
        )));
    }
    Ok(dir.join(format!("{channel_id}.json")))
}

fn load_cached_entry(dir: &Path, channel_id: &str) -> Option<CachedChannelHistory> {
    let path = cache_path_for(dir, channel_id).ok()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    match serde_json::from_str::<CachedChannelHistory>(&raw) {
        Ok(entry) if entry.channel_id == channel_id => Some(entry),
        // A corrupt or mismatched file is deleted so it cannot poison later
        // rounds; the caller proceeds as if no cache existed.
        _ => {
            let _ = std::fs::remove_file(&path);
            None
        }
    }
}

fn persist_entry(dir: &Path, entry: &CachedChannelHistory) -> error::Result<()> {
    let path = cache_path_for(dir, &entry.channel_id)?;
    let encoded = serde_json::to_string(entry)
        .map_err(|err| CliError::Relay(format!("history cache encode: {err}")))?;
    if encoded.len() as u64 > HISTORY_CACHE_MAX_ENTRY_BYTES {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    let temporary = config::unique_temporary_path(&path);
    std::fs::write(&temporary, encoded.as_bytes())
        .map_err(|err| CliError::Launch(format!("history cache write: {err}")))?;
    config::replace_file_atomically(&temporary, &path)
        .map_err(|err| CliError::Launch(format!("history cache replace: {err}")))?;
    evict_over_budget(dir)?;
    Ok(())
}

fn evict_over_budget(dir: &Path) -> error::Result<()> {
    let mut entries: Vec<(std::time::SystemTime, PathBuf, u64)> = Vec::new();
    let mut total: u64 = 0;
    let read_dir = match std::fs::read_dir(dir) {
        Ok(read_dir) => read_dir,
        Err(_) => return Ok(()),
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        total = total.saturating_add(meta.len());
        entries.push((modified, path, meta.len()));
    }
    if total <= HISTORY_CACHE_MAX_TOTAL_BYTES {
        return Ok(());
    }
    entries.sort_by_key(|(modified, _, _)| *modified);
    for (_, path, len) in entries {
        if total <= HISTORY_CACHE_MAX_TOTAL_BYTES {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
    Ok(())
}

fn message_sequence(message: &serde_json::Value) -> Option<u64> {
    message.get("sequence").and_then(serde_json::Value::as_u64)
}

fn message_id(message: &serde_json::Value) -> Option<String> {
    message
        .get("messageId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

/// A page maps to crate messages only when every element carries the fields
/// the cache keys on; otherwise the round is uncacheable (fail-closed).
fn to_cached_messages(messages: &[serde_json::Value]) -> Option<Vec<CachedMessage>> {
    messages
        .iter()
        .map(|message| {
            Some(CachedMessage {
                message_id: message_id(message)?,
                sequence: message_sequence(message)?,
                payload: message.clone(),
            })
        })
        .collect()
}

fn page_authority(page: &HubHistoryPage) -> Option<ContentAuthority> {
    page.content_authority
        .as_ref()
        .filter(|authority| authority.protocol_version == HISTORY_CONTENT_PROTOCOL_VERSION)
        .map(|authority| ContentAuthority {
            content_revision: authority.content_revision,
        })
}

async fn fetch_history_page(
    hub_url: &str,
    run_token: &str,
    channel_id: &str,
    before_sequence: Option<u64>,
) -> error::Result<HubHistoryPage> {
    let mut route = format!(
        "/api/channels/{}/history?limit={HISTORY_PAGE_LIMIT}",
        urlencoding::encode(channel_id),
    );
    if let Some(cursor) = before_sequence {
        route.push_str("&beforeSequence=");
        route.push_str(&cursor.to_string());
    }
    http::request_json(&with_route(hub_url, &route), "GET", Some(run_token), None).await
}

/// Backward cursor over real (sequence > 0) rows; the synthetic thread-root
/// entry repeats on every page and must not drive pagination.
fn next_before_sequence(messages: &[serde_json::Value]) -> Option<u64> {
    messages
        .iter()
        .filter_map(message_sequence)
        .filter(|sequence| *sequence > 0)
        .min()
}

struct WalkOutcome {
    messages: Vec<serde_json::Value>,
    authority: Option<ContentAuthority>,
}

/// Full backward walk from `first_page`, or from the top when absent.
/// `stop_at_sequence` bounds a tail read; `None` walks to the beginning.
async fn walk_history(
    hub_url: &str,
    run_token: &str,
    channel_id: &str,
    first_page: Option<HubHistoryPage>,
    stop_at_sequence: Option<u64>,
) -> error::Result<WalkOutcome> {
    let mut collected: Vec<serde_json::Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut authority: Option<ContentAuthority> = None;
    let mut page = match first_page {
        Some(page) => page,
        None => fetch_history_page(hub_url, run_token, channel_id, None).await?,
    };
    loop {
        if authority.is_none() {
            authority = page_authority(&page);
        }
        if page.messages.is_empty() {
            if page.has_more {
                return Err(CliError::Relay(
                    "Channel history reported another page without messages".to_string(),
                ));
            }
            break;
        }
        let cursor = next_before_sequence(&page.messages);
        let reached_stop = stop_at_sequence
            .zip(cursor)
            .is_some_and(|(stop, cursor)| cursor <= stop);
        for message in page.messages.drain(..) {
            let Some(id) = message_id(&message) else {
                continue;
            };
            if seen.insert(id) {
                collected.push(message);
            }
        }
        if !page.has_more || reached_stop {
            break;
        }
        let Some(cursor) = cursor else { break };
        page = fetch_history_page(hub_url, run_token, channel_id, Some(cursor)).await?;
    }
    Ok(WalkOutcome {
        messages: collected,
        authority,
    })
}

fn split_root_entry(
    messages: &[serde_json::Value],
) -> (Option<CachedMessage>, Vec<serde_json::Value>) {
    let mut root = None;
    let mut body = Vec::with_capacity(messages.len());
    for message in messages {
        if root.is_none()
            && message_sequence(message) == Some(0)
            && let Some(id) = message_id(message)
        {
            root = Some(CachedMessage {
                message_id: id,
                sequence: 0,
                payload: message.clone(),
            });
            continue;
        }
        body.push(message.clone());
    }
    (root, body)
}

fn respond_with(messages: Vec<serde_json::Value>) -> String {
    serde_json::json!({ "messages": messages }).to_string()
}

fn assembled_response(entry: &CachedChannelHistory) -> String {
    let messages = assemble(entry)
        .into_iter()
        .map(|message| message.payload)
        .collect::<Vec<_>>();
    respond_with(messages)
}

/// Run one cache file operation under the history-cache lock.
///
/// `flock` blocks its thread, so it runs on the blocking pool, and the lock is
/// held only for the file work itself — never across a Hub request. Holding it
/// across an `.await` let the broker's waiters park every runtime worker in
/// `flock` while the holder could not be polled to release it, which wedged
/// the whole daemon (auth broker included). `None` means the lock or the
/// blocking pool was unavailable; callers then serve without the cache.
async fn with_history_cache_lock<T, F>(operation: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce(&Path) -> T + Send + 'static,
{
    // Tokio task-local Profile context is not inherited by spawn_blocking.
    // Capture its root here and use it for both the lock and every file path.
    let dir = history_cache_dir().ok()?;
    tokio::task::spawn_blocking(move || {
        let _lock = HistoryCacheLock::acquire_in(&dir).ok()?;
        Some(operation(&dir))
    })
    .await
    .ok()
    .flatten()
}

async fn persist_entry_locked(entry: CachedChannelHistory) {
    let _ = with_history_cache_lock(move |dir| persist_entry(dir, &entry)).await;
}

/// Serve one full-history read for the broker. Hub errors propagate; cache
/// errors degrade to the plain walk the CLI would have done itself.
pub(crate) async fn serve_daemon_channel_history(
    hub_url: &str,
    payload: DaemonChannelHistoryPayload,
) -> error::Result<String> {
    let channel_id = payload.channel_id.as_str();
    let run_token = payload.run_token.as_str();
    // The authenticated first page is both the authorization proof for this
    // reader and the freshness sample for the cache decision.
    let first_page = fetch_history_page(hub_url, run_token, channel_id, None).await?;
    let authority = page_authority(&first_page);
    let first_page_cached = to_cached_messages(&first_page.messages);

    let cache = {
        let channel_id = channel_id.to_string();
        with_history_cache_lock(move |dir| load_cached_entry(dir, &channel_id))
            .await
            .flatten()
    };

    let plan = match (&first_page_cached, authority) {
        (Some(cached_page), authority) => {
            plan_read(cache.as_ref(), authority, cached_page, first_page.has_more)
        }
        // Unmappable page: serve correctly without touching the cache.
        (None, _) => ReadPlan::FullRead,
    };

    match plan {
        ReadPlan::ServeMerged => {
            let entry = cache.expect("ServeMerged requires a cache entry");
            let authority = authority.expect("ServeMerged requires authority");
            let tail = first_page_cached.unwrap_or_default();
            let (root, _) = split_root_entry(&first_page.messages);
            let merged = extend_cache(&entry, authority, &tail, root);
            let response = assembled_response(&merged);
            persist_entry_locked(merged).await;
            Ok(response)
        }
        ReadPlan::TailRead { stop_at_sequence } => {
            let entry = cache.expect("TailRead requires a cache entry");
            let authority = authority.expect("TailRead requires authority");
            let walk = walk_history(
                hub_url,
                run_token,
                channel_id,
                Some(first_page),
                Some(stop_at_sequence),
            )
            .await?;
            let Some(tail) = to_cached_messages(&walk.messages) else {
                return Ok(respond_with(walk.messages));
            };
            let (root, _) = split_root_entry(
                &tail
                    .iter()
                    .map(|message| message.payload.clone())
                    .collect::<Vec<_>>(),
            );
            let merged = extend_cache(&entry, authority, &tail, root);
            let response = assembled_response(&merged);
            persist_entry_locked(merged).await;
            Ok(response)
        }
        ReadPlan::FullRead => {
            let walk = walk_history(hub_url, run_token, channel_id, Some(first_page), None).await?;
            let authority = walk.authority;
            if let Some(cached) = to_cached_messages(&walk.messages) {
                let (root, _) = split_root_entry(&walk.messages);
                if let Some(entry) = build_cache(channel_id, authority, &cached, root) {
                    let response = assembled_response(&entry);
                    persist_entry_locked(entry).await;
                    return Ok(response);
                }
            }
            Ok(respond_with(walk.messages))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str, sequence: u64) -> serde_json::Value {
        serde_json::json!({ "messageId": id, "sequence": sequence, "body": format!("b{sequence}") })
    }

    #[test]
    fn cache_path_rejects_traversal() {
        assert!(cache_path_for(Path::new("cache"), "../escape").is_err());
        assert!(cache_path_for(Path::new("cache"), "").is_err());
        assert!(cache_path_for(Path::new("cache"), "a5c221ec-1234-5678-9abc-def012345678").is_ok());
    }

    #[test]
    fn root_entry_splits_out_of_the_body() {
        let messages = vec![message("root", 0), message("m1", 1), message("m2", 2)];
        let (root, body) = split_root_entry(&messages);
        assert_eq!(root.map(|entry| entry.message_id), Some("root".into()));
        assert_eq!(body.len(), 2);
    }

    #[test]
    fn pagination_cursor_ignores_the_synthetic_root() {
        let messages = vec![message("root", 0), message("m9", 9), message("m8", 8)];
        assert_eq!(next_before_sequence(&messages), Some(8));
    }

    #[test]
    fn unmappable_messages_are_uncacheable() {
        let messages = vec![serde_json::json!({ "body": "no id or sequence" })];
        assert!(to_cached_messages(&messages).is_none());
    }

    #[test]
    fn authority_requires_the_exact_protocol_version() {
        let page: HubHistoryPage = serde_json::from_value(serde_json::json!({
            "messages": [],
            "hasMore": false,
            "contentAuthority": { "protocolVersion": 2, "contentRevision": 7 }
        }))
        .unwrap();
        assert!(page_authority(&page).is_none());
    }
}
