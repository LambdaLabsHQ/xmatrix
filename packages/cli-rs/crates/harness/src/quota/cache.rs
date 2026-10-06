// The TTL cache and the bounded request behind every provider quota read.
//
// Each provider reader used to carry its own OnceLock slot, its own store
// helper, and its own pair of TTL constants, then repeat the same "still fresh?"
// test inline before fetching. Four copies of one caching policy meant a change
// to the rule had four places to land and no name to change it by.
//
// The same was true of the request itself: four readers each spelled out the
// transport / HTTP-status / body-parse failure arms, each with its own debug
// line and its own negative cache write. Only one of the four bounded the
// request, which is exactly the kind of drift four copies invite.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use colored::Colorize;
use serde_json::Value;

use crate::usage::LlmUsage;

/// How long any provider quota request may take before the reader gives up.
///
/// A quota read runs in front of the presence frames that carry `busy` and the
/// model/quota chips, so an unbounded request does not merely lose a meter — it
/// holds back the whole live Agent card. Only the Codex reader used to set a
/// deadline; the other three inherited reqwest's wait-forever default.
const PROVIDER_USAGE_READ_TIMEOUT: Duration = Duration::from_secs(10);

/// A provider's last usage answer and the instant it was taken.
type CachedUsage = (Instant, Option<LlmUsage>);

fn usage_is_fresh(entry: &CachedUsage, fresh_ttl: Duration, error_ttl: Duration) -> bool {
    let (fetched_at, usage) = entry;
    let ttl = if usage.is_some() {
        fresh_ttl
    } else {
        error_ttl
    };
    fetched_at.elapsed() < ttl
}

/// One provider's cached usage read.
///
/// A success and a failure expire on different clocks on purpose: a provider
/// that is briefly unreachable is retried sooner than a good reading is
/// refreshed, so a blip does not leave the meters dark for the full success TTL.
pub(crate) struct ProviderUsageCache {
    slot: OnceLock<Mutex<Option<CachedUsage>>>,
    fresh_ttl: Duration,
    error_ttl: Duration,
}

/// Distinct provider-owned account meters never reuse one another's observation.
pub(crate) enum AccountMeter {
    Cursor,
    OpenCode,
}

pub(crate) fn account_meter_cache(provider: AccountMeter) -> &'static ProviderUsageCache {
    static CURSOR: ProviderUsageCache = ProviderUsageCache::account_meter();
    static OPENCODE: ProviderUsageCache = ProviderUsageCache::account_meter();
    match provider {
        AccountMeter::Cursor => &CURSOR,
        AccountMeter::OpenCode => &OPENCODE,
    }
}

impl ProviderUsageCache {
    pub(crate) const fn new(fresh_ttl: Duration, error_ttl: Duration) -> Self {
        Self {
            slot: OnceLock::new(),
            fresh_ttl,
            error_ttl,
        }
    }

    /// Account meters share a two-minute successful read and one-minute failure TTL.
    pub(crate) const fn account_meter() -> Self {
        Self::new(Duration::from_secs(120), Duration::from_secs(60))
    }

    fn slot(&self) -> &Mutex<Option<CachedUsage>> {
        self.slot.get_or_init(|| Mutex::new(None))
    }

    /// The cached answer while it is still current, or `None` when the caller
    /// must go to the provider.
    ///
    /// The outer `Option` reports whether the cache answered at all; the inner
    /// one carries what the provider said, so a remembered failure still counts
    /// as an answer and suppresses the refetch until its own TTL runs out.
    pub(crate) fn hit(&self) -> Option<Option<LlmUsage>> {
        let cache = self.slot().lock().ok()?;
        let entry = cache.as_ref()?;
        usage_is_fresh(entry, self.fresh_ttl, self.error_ttl).then(|| entry.1.clone())
    }

    pub(crate) fn store(&self, usage: Option<LlmUsage>) {
        if let Ok(mut cache) = self.slot().lock() {
            *cache = Some((Instant::now(), usage));
        }
    }

    /// The cached answer, unless this caller insists on going to the provider.
    pub(crate) fn hit_unless_forced(&self, force: bool) -> Option<Option<LlmUsage>> {
        if force { None } else { self.hit() }
    }

    /// Remember that the provider had no answer, and report that to the caller.
    ///
    /// Every reader's giving-up arms are a `store(None)` followed by a `None`;
    /// naming the pair keeps the negative cache entry from being forgotten at
    /// one arm of one reader.
    pub(crate) fn unavailable(&self) -> Option<LlmUsage> {
        self.store(None);
        None
    }

    /// Send one bounded provider request and return its JSON body.
    ///
    /// A transport, HTTP-status, or body-parse failure is remembered as a
    /// negative cache entry so a provider that is briefly unreachable is
    /// retried on the shorter error TTL rather than the success TTL.
    pub(crate) async fn fetch_json(
        &self,
        vendor: &str,
        request: reqwest::RequestBuilder,
    ) -> Option<Value> {
        let value = fetch_provider_json(vendor, request).await;
        if value.is_none() {
            self.store(None);
        }
        value
    }
}

/// Send one bounded provider request and return its JSON body.
///
/// Owns the three ways a quota read fails — transport, HTTP status, body
/// parse — so every provider fails the same way: bounded and reported through
/// `XMATRIX_<VENDOR>_QUOTA_DEBUG`. The caller decides how the outcome is
/// cached: the single-slot cache stores a negative entry, while the keyed cache
/// stores it under the caller's account key.
pub(crate) async fn fetch_provider_json(
    vendor: &str,
    request: reqwest::RequestBuilder,
) -> Option<Value> {
    let report = |detail: String| {
        if std::env::var(format!(
            "XMATRIX_{}_QUOTA_DEBUG",
            vendor.to_ascii_uppercase()
        ))
        .is_ok()
        {
            eprintln!("{} {vendor} quota {detail}", "⚠".yellow().bold());
        }
    };
    let response = match request.timeout(PROVIDER_USAGE_READ_TIMEOUT).send().await {
        Ok(response) => response,
        Err(err) => {
            report(format!("read failed: {err}"));
            return None;
        }
    };
    if !response.status().is_success() {
        report(format!("read HTTP {}", response.status()));
        return None;
    }
    match response.json::<Value>().await {
        Ok(value) => Some(value),
        Err(err) => {
            report(format!("parse failed: {err}"));
            None
        }
    }
}

/// A provider cache whose entries are keyed by the account/config context that
/// produced them.
///
/// A Codex quota reading belongs to the exact `CODEX_HOME` it was taken from, so
/// the single-slot [`ProviderUsageCache`] would let one account's reading answer
/// for another. This keeps one slot per key, each expiring on the same
/// success/error clocks.
/// A host serves a bounded set of accounts, so the keyed cache keeps a bounded
/// number of slots. Without this a long-lived daemon probing many homes would
/// grow the map without limit.
pub(crate) const MAX_KEYED_SLOTS: usize = 128;

pub(crate) struct KeyedProviderUsageCache {
    slots: OnceLock<Mutex<HashMap<String, CachedUsage>>>,
    fresh_ttl: Duration,
    error_ttl: Duration,
}

impl KeyedProviderUsageCache {
    pub(crate) const fn new(fresh_ttl: Duration, error_ttl: Duration) -> Self {
        Self {
            slots: OnceLock::new(),
            fresh_ttl,
            error_ttl,
        }
    }

    fn slots(&self) -> &Mutex<HashMap<String, CachedUsage>> {
        self.slots.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// The cached answer for `key` while it is still current, or `None` when the
    /// caller must go to the provider. A key with no entry is always a miss.
    pub(crate) fn hit(&self, key: &str) -> Option<Option<LlmUsage>> {
        let cache = self.slots().lock().ok()?;
        let entry = cache.get(key)?;
        usage_is_fresh(entry, self.fresh_ttl, self.error_ttl).then(|| entry.1.clone())
    }

    pub(crate) fn store(&self, key: &str, usage: Option<LlmUsage>) {
        let Ok(mut cache) = self.slots().lock() else {
            return;
        };
        cache.insert(key.to_string(), (Instant::now(), usage));
        if cache.len() <= MAX_KEYED_SLOTS {
            return;
        }
        // Reclaim expired slots first, then the oldest, so the map stays bounded
        // without evicting a still-current reading for an active account.
        cache.retain(|_, entry| usage_is_fresh(entry, self.fresh_ttl, self.error_ttl));
        while cache.len() > MAX_KEYED_SLOTS {
            let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, (fetched_at, _))| *fetched_at)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            cache.remove(&oldest);
        }
    }

    pub(crate) fn hit_unless_forced(&self, key: &str, force: bool) -> Option<Option<LlmUsage>> {
        if force { None } else { self.hit(key) }
    }

    pub(crate) async fn fetch_json(
        &self,
        key: &str,
        vendor: &str,
        request: reqwest::RequestBuilder,
    ) -> Option<Value> {
        let value = fetch_provider_json(vendor, request).await;
        if value.is_none() {
            self.store(key, None);
        }
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::LlmQuotaUsage;

    fn usage(observed_at: &str, percent: f64) -> LlmUsage {
        LlmUsage {
            quota_source: Some("provider_api".to_string()),
            quota_observed_at: Some(observed_at.to_string()),
            quota_usages: Some(vec![LlmQuotaUsage {
                label: Some("1w".to_string()),
                percent: Some(percent),
                ..Default::default()
            }]),
            ..Default::default()
        }
    }

    #[test]
    fn cache_freshness_uses_the_distinct_success_and_error_ttls() {
        let fetched_at = Instant::now() - Duration::from_secs(2);
        let success = (fetched_at, Some(usage("2026-09-21T18:00:00Z", 1.0)));
        let failure = (fetched_at, None);
        let fresh_ttl = Duration::from_secs(3);
        let error_ttl = Duration::from_secs(1);
        assert!(usage_is_fresh(&success, fresh_ttl, error_ttl));
        assert!(!usage_is_fresh(&failure, fresh_ttl, error_ttl));
        assert!(!usage_is_fresh(&success, Duration::ZERO, error_ttl));
    }

    #[test]
    fn keyed_cache_does_not_share_between_accounts() {
        let cache = KeyedProviderUsageCache::new(Duration::from_secs(120), Duration::from_secs(60));
        cache.store("home-a", Some(usage("2026-09-21T18:00:00Z", 100.0)));
        assert!(
            cache.hit("home-b").is_none(),
            "a different home must not read home-a's slot"
        );
        let hit = cache.hit("home-a").expect("home-a hit");
        assert_eq!(
            hit.and_then(|value| value.quota_observed_at),
            Some("2026-09-21T18:00:00Z".to_string()),
            "the cached observation time is preserved, not re-stamped"
        );
    }

    #[test]
    fn keyed_cache_honours_force_and_negative_entries() {
        let cache = KeyedProviderUsageCache::new(Duration::from_secs(120), Duration::from_secs(60));
        cache.store("home-a", None);
        assert!(
            cache.hit_unless_forced("home-a", true).is_none(),
            "a forced read ignores the cache"
        );
        assert!(
            cache.hit_unless_forced("home-a", false).is_some(),
            "a negative entry still answers while its error TTL holds"
        );
    }

    #[test]
    fn keyed_cache_slots_stay_bounded() {
        let cache =
            KeyedProviderUsageCache::new(Duration::from_secs(3600), Duration::from_secs(3600));
        for index in 0..(MAX_KEYED_SLOTS + 8) {
            cache.store(
                &format!("home-{index}"),
                Some(usage("2026-09-21T18:00:00Z", 1.0)),
            );
        }
        assert!(
            cache.hit("home-0").is_none(),
            "the oldest slot is evicted once the bound is exceeded"
        );
        assert!(
            cache
                .hit(&format!("home-{}", MAX_KEYED_SLOTS + 7))
                .is_some(),
            "the newest slot is retained"
        );
    }
}
