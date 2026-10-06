//! Shared channel-history cache decision core.
//!
//! One implementation of the cache rules for every client. The crate is
//! sans-IO: callers hand it the cached state and the live first page, it
//! answers with a [`ReadPlan`]; callers perform HTTP and storage. This keeps
//! the fail-closed rules in exactly one place — native for the CLI/daemon,
//! wasm for the web bundle the mobile and desktop shells embed.
//!
//! ## The contract (mirrors the Hub/Authority side)
//!
//! * The Hub's channel-history response carries a channel-scoped
//!   `contentRevision`. Authority bumps it whenever an existing row's bytes can
//!   change (edit, tombstone/redaction, recall, archive drain) and does NOT
//!   bump it on append. It is viewer-independent.
//! * At an unchanged `contentRevision`, previously served history bytes are
//!   immutable and the channel is append-only above the cached watermark, so
//!   a cached prefix may be reused and extended by reading only sequences
//!   above `maxSequence`.
//! * Any change of `contentRevision` — or its absence (older Hub, or any
//!   state this crate cannot prove) — discards the cache and forces a full
//!   re-read. Fail-closed, never fail-open.
//! * Per-principal response fields (`principalAckedSequence`, `fullHistory`)
//!   must never enter the shared cache; authorization stays with each
//!   reader's own authenticated tail read.

use serde::{Deserialize, Serialize};

/// One cached message entry. The `payload` is the serialized wire message
/// exactly as the Hub returned it (minus per-principal envelope fields), so
/// serving from cache is byte-identical to serving from the Hub.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CachedMessage {
    pub message_id: String,
    pub sequence: u64,
    pub payload: serde_json::Value,
}

/// Durable cache entry for one channel on one machine.
///
/// The synthetic thread-root entry (`sequence: 0`, prepended by the Hub to
/// every backward page of a thread channel) is stored apart from the
/// sequence-keyed body so cursor math never sees it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CachedChannelHistory {
    pub channel_id: String,
    pub content_revision: u64,
    /// Highest sequence present in `messages`.
    pub max_sequence: u64,
    /// Ascending by sequence; deduplicated; no synthetic root entry.
    pub messages: Vec<CachedMessage>,
    pub root_entry: Option<CachedMessage>,
}

/// The channel-content authority stamped on a live Hub response.
/// `None` means the Hub did not vouch for cacheability (older Hub or any
/// unproven state): treat the channel as uncacheable this round.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ContentAuthority {
    pub content_revision: u64,
}

/// What the caller must do next, decided from cache + the live first page.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum ReadPlan {
    /// No usable cache: walk the full backward pagination and then call
    /// [`build_cache`] with everything that was read.
    FullRead,
    /// The cache is valid and the live first page already connects to it:
    /// merge with [`extend_cache`]; no further Hub reads are needed.
    ServeMerged,
    /// The cache is valid but more than one page of messages was appended:
    /// keep paging backward until a page reaches `stop_at_sequence` (a page
    /// containing it, or `hasMore == false`), then merge via [`extend_cache`].
    TailRead { stop_at_sequence: u64 },
}

/// Decide how to serve one full-history read.
///
/// `live_first_page` is the newest backward page, already fetched with the
/// reader's own credentials — that authenticated read is also the proof this
/// reader may see the channel right now, so serving shared bytes afterwards
/// never widens access.
pub fn plan_read(
    cache: Option<&CachedChannelHistory>,
    live_authority: Option<ContentAuthority>,
    live_first_page: &[CachedMessage],
    live_has_more: bool,
) -> ReadPlan {
    let Some(authority) = live_authority else {
        return ReadPlan::FullRead;
    };
    let Some(cache) = cache else {
        return ReadPlan::FullRead;
    };
    if cache.content_revision != authority.content_revision {
        return ReadPlan::FullRead;
    }
    // Equal revision: the cached prefix is provably current. The tail is
    // whatever sits above the cached watermark.
    let connects = !live_has_more
        || live_first_page
            .iter()
            .any(|message| message.sequence <= cache.max_sequence);
    if connects {
        ReadPlan::ServeMerged
    } else {
        ReadPlan::TailRead {
            stop_at_sequence: cache.max_sequence,
        }
    }
}

/// Merge tail pages into a valid cache entry, returning the new entry.
/// `tail` may overlap the cached range and may contain the synthetic root
/// entry (`sequence == 0` on a nonzero-based channel); both are dropped.
pub fn extend_cache(
    cache: &CachedChannelHistory,
    authority: ContentAuthority,
    tail: &[CachedMessage],
    root_entry: Option<CachedMessage>,
) -> CachedChannelHistory {
    debug_assert_eq!(cache.content_revision, authority.content_revision);
    let mut messages = cache.messages.clone();
    let mut appended: Vec<&CachedMessage> = tail
        .iter()
        .filter(|message| message.sequence > cache.max_sequence)
        .collect();
    appended.sort_by_key(|message| message.sequence);
    appended.dedup_by_key(|message| message.sequence);
    let max_sequence = appended
        .last()
        .map(|message| message.sequence)
        .unwrap_or(cache.max_sequence);
    messages.extend(appended.into_iter().cloned());
    CachedChannelHistory {
        channel_id: cache.channel_id.clone(),
        content_revision: authority.content_revision,
        max_sequence,
        messages,
        root_entry: root_entry.or_else(|| cache.root_entry.clone()),
    }
}

/// Build a fresh cache entry after a full read. Returns `None` when the Hub
/// did not vouch for cacheability — never store what cannot be validated.
pub fn build_cache(
    channel_id: &str,
    authority: Option<ContentAuthority>,
    full_history: &[CachedMessage],
    root_entry: Option<CachedMessage>,
) -> Option<CachedChannelHistory> {
    let authority = authority?;
    let mut messages: Vec<CachedMessage> = full_history
        .iter()
        .filter(|message| message.sequence > 0)
        .cloned()
        .collect();
    messages.sort_by_key(|message| message.sequence);
    messages.dedup_by_key(|message| message.sequence);
    let max_sequence = messages.last().map(|message| message.sequence)?;
    Some(CachedChannelHistory {
        channel_id: channel_id.to_string(),
        content_revision: authority.content_revision,
        max_sequence,
        messages,
        root_entry,
    })
}

/// The messages a reader should receive: root entry first (when present),
/// then the sequence-ordered body — the same shape the CLI's existing
/// dedupe/sort loop produces from raw Hub pages.
pub fn assemble(cache: &CachedChannelHistory) -> Vec<CachedMessage> {
    let mut out = Vec::with_capacity(cache.messages.len() + 1);
    if let Some(root) = &cache.root_entry {
        out.push(root.clone());
    }
    out.extend(cache.messages.iter().cloned());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(sequence: u64) -> CachedMessage {
        CachedMessage {
            message_id: format!("m{sequence}"),
            sequence,
            payload: serde_json::json!({ "body": format!("b{sequence}") }),
        }
    }

    fn cache_through(max: u64, revision: u64) -> CachedChannelHistory {
        CachedChannelHistory {
            channel_id: "ch".into(),
            content_revision: revision,
            max_sequence: max,
            messages: (1..=max).map(msg).collect(),
            root_entry: None,
        }
    }

    #[test]
    fn no_authority_is_a_full_read_even_with_cache() {
        let cache = cache_through(10, 3);
        assert_eq!(
            plan_read(Some(&cache), None, &[msg(11)], false),
            ReadPlan::FullRead
        );
    }

    #[test]
    fn no_cache_is_a_full_read() {
        let authority = ContentAuthority {
            content_revision: 3,
        };
        assert_eq!(
            plan_read(None, Some(authority), &[msg(1)], false),
            ReadPlan::FullRead
        );
    }

    #[test]
    fn revision_drift_discards_the_cache() {
        let cache = cache_through(10, 3);
        let authority = ContentAuthority {
            content_revision: 4,
        };
        assert_eq!(
            plan_read(Some(&cache), Some(authority), &[msg(11)], true),
            ReadPlan::FullRead,
        );
    }

    #[test]
    fn connected_first_page_serves_merged_without_more_reads() {
        let cache = cache_through(10, 3);
        let authority = ContentAuthority {
            content_revision: 3,
        };
        let page: Vec<_> = (9..=12).map(msg).collect();
        assert_eq!(
            plan_read(Some(&cache), Some(authority), &page, true),
            ReadPlan::ServeMerged,
        );
    }

    #[test]
    fn exhausted_pagination_always_connects() {
        let cache = cache_through(10, 3);
        let authority = ContentAuthority {
            content_revision: 3,
        };
        assert_eq!(
            plan_read(Some(&cache), Some(authority), &[msg(11), msg(12)], false),
            ReadPlan::ServeMerged,
        );
    }

    #[test]
    fn disconnected_first_page_reads_tail_to_the_watermark() {
        let cache = cache_through(10, 3);
        let authority = ContentAuthority {
            content_revision: 3,
        };
        let page: Vec<_> = (300..=500).map(msg).collect();
        assert_eq!(
            plan_read(Some(&cache), Some(authority), &page, true),
            ReadPlan::TailRead {
                stop_at_sequence: 10
            },
        );
    }

    #[test]
    fn extend_drops_overlap_and_synthetic_root() {
        let cache = cache_through(10, 3);
        let authority = ContentAuthority {
            content_revision: 3,
        };
        let tail = [msg(0), msg(9), msg(10), msg(11), msg(12), msg(11)];
        let merged = extend_cache(&cache, authority, &tail, None);
        assert_eq!(merged.max_sequence, 12);
        assert_eq!(
            merged
                .messages
                .iter()
                .map(|m| m.sequence)
                .collect::<Vec<_>>(),
            (1..=12).collect::<Vec<_>>(),
        );
    }

    #[test]
    fn build_cache_refuses_unvouched_history() {
        assert_eq!(build_cache("ch", None, &[msg(1)], None), None);
    }

    #[test]
    fn build_cache_sorts_dedupes_and_excludes_root() {
        let authority = ContentAuthority {
            content_revision: 7,
        };
        let history = [msg(0), msg(3), msg(1), msg(2), msg(3)];
        let cache = build_cache("ch", Some(authority), &history, Some(msg(0))).unwrap();
        assert_eq!(cache.max_sequence, 3);
        assert_eq!(
            cache
                .messages
                .iter()
                .map(|m| m.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2, 3],
        );
        assert_eq!(assemble(&cache)[0].sequence, 0);
    }

    #[test]
    fn empty_full_read_builds_no_cache() {
        let authority = ContentAuthority {
            content_revision: 7,
        };
        assert_eq!(build_cache("ch", Some(authority), &[], None), None);
    }
}
