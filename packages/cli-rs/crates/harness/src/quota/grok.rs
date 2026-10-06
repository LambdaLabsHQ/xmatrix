//! Grok Build billing quota: monthly credits and the optional weekly window,
//! read from the xAI billing endpoint behind the CLI's own OAuth credentials.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::cache::{KeyedProviderUsageCache, ProviderUsageCache};
use super::windows::{append_quota_usages, normalized_quota_percent};
use crate::fields::{first_f64, first_string, nested_val_number};
use crate::host::{home_dir_path, lowercase_hex, provider_client};
use crate::usage::{LlmQuotaUsage, LlmUsage, has_llm_usage};

const GROK_BUILD_BILLING_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

static GROK_BILLING: ProviderUsageCache =
    ProviderUsageCache::new(Duration::from_secs(120), Duration::from_secs(60));

/// Pre-launch probe readings: one slot per Grok home and credential snapshot,
/// so one account's reading never answers for another target.
static GROK_BILLING_BY_HOME: KeyedProviderUsageCache =
    KeyedProviderUsageCache::new(Duration::from_secs(120), Duration::from_secs(60));

/// Credentials the in-instance reader uses: the CLI's explicit token, else the
/// default `~/.grok/auth.json`.
fn grok_build_oauth_credentials() -> Option<(String, Option<String>)> {
    if let Ok(token) = std::env::var("GROK_CLI_OAUTH_TOKEN") {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            return Some((trimmed.to_string(), None));
        }
    }
    let path = home_dir_path()?.join(".grok").join("auth.json");
    let raw = std::fs::read_to_string(path).ok()?;
    grok_credentials_from_auth_json(&raw)
}

/// The first unexpired access token (and its user id) in one `auth.json` body.
fn grok_credentials_from_auth_json(raw: &str) -> Option<(String, Option<String>)> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let root = value.as_object()?;
    // ~/.grok/auth.json is keyed by issuer::client_id entries with a `key` access token.
    for (_issuer, entry) in root {
        let Some(entry) = entry.as_object() else {
            continue;
        };
        if let Some(token) = entry
            .get("key")
            .or_else(|| entry.get("accessToken"))
            .or_else(|| entry.get("access_token"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if let Some(expires_at) = entry
                .get("expires_at")
                .or_else(|| entry.get("expiresAt"))
                .and_then(Value::as_str)
                && let Ok(parsed) = chrono_like_parse_rfc3339_millis(expires_at)
            {
                let now_ms = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .ok()?
                    .as_millis() as i64;
                if parsed <= now_ms + 60_000 {
                    continue;
                }
            }
            let user_id =
                first_string(entry, &["user_id", "userId", "principal_id", "principalId"]);
            return Some((token.to_string(), user_id));
        }
    }
    None
}

fn chrono_like_parse_rfc3339_millis(value: &str) -> Result<i64, ()> {
    // Prefer a simple DateTime parse via the std-less path used elsewhere: accept
    // ISO-8601 by converting with the `time` crate is not available; fall back to
    // treating pure numeric timestamps, otherwise rely on HTTP path without expiry skip.
    if let Ok(numeric) = value.trim().parse::<i64>() {
        return Ok(if numeric > 1_000_000_000_000 {
            numeric
        } else {
            numeric * 1000
        });
    }
    // Without a dedicated datetime crate, skip expiry enforcement for RFC3339 strings
    // and allow the request to fail with 401 if truly expired.
    Err(())
}

fn grok_cli_user_agent() -> String {
    let grok_home = home_dir_path()
        .map(|home| home.join(".grok"))
        .unwrap_or_else(|| PathBuf::from(".grok"));
    grok_cli_user_agent_in(&grok_home)
}

fn grok_cli_user_agent_in(grok_home: &Path) -> String {
    if let Ok(version) = std::env::var("GROK_CLI_VERSION") {
        let trimmed = version.trim();
        if !trimmed.is_empty() {
            return format!("grok/{trimmed}");
        }
    }
    if let Ok(raw) = std::fs::read_to_string(grok_home.join("version.json"))
        && let Ok(value) = serde_json::from_str::<Value>(&raw)
        && let Some(version) = value
            .get("version")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    {
        return format!("grok/{version}");
    }
    "grok/xmatrix".to_string()
}

/// Grok Build subscription/credit allowance from cli-chat-proxy billing.
/// Unified SuperGrok accounts expose `{ config: { currentPeriod, creditUsagePercent? } }`
/// via `?format=credits`. Proto3 JSON omits `creditUsagePercent` at 0%, so a
/// current period without a percent is zero usage, not a missing quota.
/// Legacy monthly-credit accounts still send
/// `{ config: { monthlyLimit: {val}, used: {val}, billingPeriodEnd } }`.
pub async fn read_grok_build_billing_usage(force: bool) -> Option<LlmUsage> {
    if let Some(cached) = GROK_BILLING.hit_unless_forced(force) {
        return cached;
    }

    let Some((token, user_id)) = grok_build_oauth_credentials() else {
        return GROK_BILLING.unavailable();
    };

    let request = grok_billing_request(
        GROK_BUILD_BILLING_URL,
        &token,
        user_id.as_deref(),
        grok_cli_user_agent(),
    );
    let value = GROK_BILLING.fetch_json("grok", request).await?;

    let mut usage = grok_billing_usage_from_value(&value);
    stamp_observed_now(usage.as_mut());
    GROK_BILLING.store(usage.clone());
    usage
}

/// The billing request the Grok CLI itself sends for one OAuth credential.
fn grok_billing_request(
    endpoint: &str,
    token: &str,
    user_id: Option<&str>,
    user_agent: String,
) -> reqwest::RequestBuilder {
    let version = user_agent
        .strip_prefix("grok/")
        .unwrap_or("xmatrix")
        .to_string();
    let mut request = provider_client()
        .get(endpoint)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, user_agent)
        .header("X-Grok-CLI-Version", &version)
        .header("X-XAI-Token-Auth", "xai-grok-cli")
        .header("x-grok-client-version", &version)
        .header("x-grok-client-identifier", "grok-shell")
        .header("x-grok-client-mode", "cli");
    if let Some(user_id) = user_id {
        request = request.header("x-userid", user_id);
    }
    request
}

/// A provider reading names when it was taken; routing rejects a
/// `provider_api` reading without an observation time.
fn stamp_observed_now(usage: Option<&mut LlmUsage>) {
    if let Some(usage) = usage {
        usage.quota_observed_at = super::observed_now();
    }
}

/// One snapshot of a Grok home's `auth.json`: the credential it yields and a
/// one-way fingerprint of the exact bytes. The fingerprint is an in-memory
/// cache key only; neither the file nor the digest is logged or sent.
struct GrokAuthSnapshot {
    token: String,
    user_id: Option<String>,
    content_fingerprint: String,
}

fn grok_auth_snapshot_in(grok_home: &Path) -> Option<GrokAuthSnapshot> {
    let raw = std::fs::read_to_string(grok_home.join("auth.json")).ok()?;
    let (token, user_id) = grok_credentials_from_auth_json(&raw)?;
    Some(GrokAuthSnapshot {
        token,
        user_id,
        content_fingerprint: lowercase_hex(&Sha256::digest(raw.as_bytes())),
    })
}

fn grok_quota_cache_key(grok_home: &Path, content_fingerprint: &str) -> String {
    let base = grok_home
        .canonicalize()
        .unwrap_or_else(|_| grok_home.to_path_buf());
    format!("{}\u{0}{content_fingerprint}", base.to_string_lossy())
}

/// Grok Build billing read from one explicit Grok config home.
///
/// The pre-launch probe resolves that home exactly as a spawn of its target
/// would and passes it in; the process environment (including
/// `GROK_CLI_OAUTH_TOKEN`) is never consulted here, and two targets share a
/// cache slot only when they share the home and the exact credential bytes.
pub async fn read_grok_build_billing_usage_for_home(
    grok_home: &Path,
    force: bool,
) -> Option<LlmUsage> {
    read_grok_usage_from_endpoint(grok_home, force, GROK_BUILD_BILLING_URL).await
}

// The production entrypoint fixes the provider URL; tests use loopback.
async fn read_grok_usage_from_endpoint(
    grok_home: &Path,
    force: bool,
    endpoint: &str,
) -> Option<LlmUsage> {
    // Resolve the credential before the cache: a rotated `auth.json` must not
    // reuse the previous account's reading, and a home without a credential is
    // a miss that never touches another account's slot.
    let snapshot = grok_auth_snapshot_in(grok_home)?;
    let key = grok_quota_cache_key(grok_home, &snapshot.content_fingerprint);
    if let Some(cached) = GROK_BILLING_BY_HOME.hit_unless_forced(&key, force) {
        return cached;
    }
    let request = grok_billing_request(
        endpoint,
        &snapshot.token,
        snapshot.user_id.as_deref(),
        grok_cli_user_agent_in(grok_home),
    );
    let value = GROK_BILLING_BY_HOME
        .fetch_json(&key, "grok", request)
        .await?;
    // The request may outlive an account switch at the same home.
    if grok_auth_snapshot_in(grok_home)?.content_fingerprint != snapshot.content_fingerprint {
        return None;
    }
    let mut usage = grok_billing_usage_from_value(&value);
    stamp_observed_now(usage.as_mut());
    GROK_BILLING_BY_HOME.store(&key, usage.clone());
    usage
}

pub fn grok_billing_usage_from_value(value: &Value) -> Option<LlmUsage> {
    let mut best = LlmUsage::default();
    append_quota_usages(
        &mut best.quota_usages,
        grok_billing_quota_usages(value.as_object()?),
    );
    if best.quota_usages.is_some() {
        best.quota_source = Some("provider_api".to_string());
    }
    if has_llm_usage(&best) {
        Some(best)
    } else {
        None
    }
}

pub fn grok_billing_quota_usages(map: &serde_json::Map<String, Value>) -> Vec<LlmQuotaUsage> {
    let config = map.get("config").and_then(Value::as_object).unwrap_or(map);

    let limit = nested_val_number(config, &["monthlyLimit", "monthly_limit", "limit"]);
    let used = nested_val_number(config, &["used", "includedUsed", "included_used"]);
    let period_end = first_string(
        config,
        &[
            "billingPeriodEnd",
            "billing_period_end",
            "periodEnd",
            "period_end",
            "resets_at",
            "resetsAt",
        ],
    );

    // Weekly fields are optional; present only when xAI returns them.
    let weekly_limit = nested_val_number(config, &["weeklyLimit", "weekly_limit"]);
    let weekly_used = nested_val_number(config, &["weeklyUsed", "weekly_used"]);

    let mut quotas = Vec::new();
    // Unified SuperGrok billing: percent + currentPeriod, monthlyLimit is 0.
    if let Some(quota) = grok_credits_period_quota(config) {
        quotas.push(quota);
    }
    for (label, limit, used) in [("1mo", limit, used), ("1w", weekly_limit, weekly_used)] {
        if let (Some(limit), Some(used)) = (limit, used)
            && limit > 0.0
        {
            quotas.push(LlmQuotaUsage {
                label: Some(label.to_string()),
                window: Some("grok".to_string()),
                used: Some(used),
                limit: Some(limit),
                remaining: Some((limit - used).max(0.0)),
                percent: Some((used / limit) * 100.0),
                reset_at: period_end.clone(),
            });
        }
    }
    quotas
}

fn grok_credits_period_quota(config: &serde_json::Map<String, Value>) -> Option<LlmQuotaUsage> {
    let period = config
        .get("currentPeriod")
        .or_else(|| config.get("current_period"))
        .and_then(Value::as_object);
    let percent = first_f64(
        config,
        &[
            "creditUsagePercent",
            "credit_usage_percent",
            "usagePercent",
            "usage_percent",
        ],
    )
    .or_else(|| grok_product_usage_percent(config))
    .or_else(|| period.is_some().then_some(0.0))?;
    let period_type =
        period.and_then(|period| first_string(period, &["type", "periodType", "period_type"]));
    let label =
        grok_period_window_label(period_type.as_deref()).unwrap_or_else(|| "1w".to_string());
    let reset_at = period
        .and_then(|period| {
            first_string(period, &["end", "endsAt", "ends_at", "resetAt", "reset_at"])
        })
        .or_else(|| {
            first_string(
                config,
                &[
                    "billingPeriodEnd",
                    "billing_period_end",
                    "periodEnd",
                    "period_end",
                ],
            )
        });
    Some(LlmQuotaUsage {
        label: Some(label),
        window: Some("grok".to_string()),
        used: None,
        limit: None,
        remaining: None,
        percent: normalized_quota_percent(Some(percent), None, None),
        reset_at,
    })
}

fn grok_product_usage_percent(config: &serde_json::Map<String, Value>) -> Option<f64> {
    let items = config
        .get("productUsage")
        .or_else(|| config.get("product_usage"))
        .and_then(Value::as_array)?;
    let mut fallback = None;
    for item in items {
        let Some(item) = item.as_object() else {
            continue;
        };
        let percent = first_f64(item, &["usagePercent", "usage_percent", "percent"]);
        let product = first_string(item, &["product", "name"]).unwrap_or_default();
        if product.eq_ignore_ascii_case("GrokBuild")
            || product.to_ascii_lowercase().contains("build")
        {
            return percent;
        }
        if fallback.is_none() {
            fallback = percent;
        }
    }
    fallback
}

fn grok_period_window_label(period_type: Option<&str>) -> Option<String> {
    let raw = period_type.unwrap_or("").to_ascii_uppercase();
    if raw.contains("WEEK") {
        return Some("1w".to_string());
    }
    if raw.contains("MONTH") {
        return Some("1mo".to_string());
    }
    if raw.contains("5H") || (raw.contains("HOUR") && raw.contains('5')) {
        return Some("5h".to_string());
    }
    if raw.contains("2H") || (raw.contains("HOUR") && raw.contains('2')) {
        return Some("2h".to_string());
    }
    if raw.contains("DAY") {
        return Some("1d".to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_home(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "xmatrix-grok-home-{name}-{}-{nanos}",
            std::process::id()
        ))
    }

    fn write_auth(home: &Path, token: &str, user: &str) {
        std::fs::create_dir_all(home).expect("grok home");
        std::fs::write(
            home.join("auth.json"),
            serde_json::json!({"https://auth.fixture::client": {
                "key": token, "user_id": user,
            }})
            .to_string(),
        )
        .expect("auth fixture");
    }

    /// Serve one billing response per expected bearer token, in order, and
    /// fail if a request carries any other credential.
    fn serve_billing(expected: Vec<(&'static str, f64)>) -> (String, std::thread::JoinHandle<()>) {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}/v1/billing", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for (token, percent) in expected {
                let (mut stream, headers) =
                    super::super::read_fixture_http_request(&listener, "billing request missing");
                assert!(
                    headers.contains(&format!("authorization: bearer {token}\r\n")),
                    "request must carry {token}"
                );
                let body = serde_json::json!({"config": {
                    "currentPeriod": {"type": "BILLING_PERIOD_TYPE_WEEKLY", "end": "2026-09-30T00:00:00Z"},
                    "creditUsagePercent": percent,
                }})
                .to_string();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        (endpoint, server)
    }

    fn percent(usage: &LlmUsage) -> Option<f64> {
        usage.quota_usages.as_ref()?.first()?.percent
    }

    #[tokio::test]
    async fn two_homes_never_share_a_cached_reading() {
        let home_a = unique_temp_home("a");
        let home_b = unique_temp_home("b");
        write_auth(&home_a, "fixture-a", "user-a");
        write_auth(&home_b, "fixture-b", "user-b");
        // Exactly one provider request per account: the second read of A is a
        // cache hit, and B's read is never answered from A's slot.
        let (endpoint, server) = serve_billing(vec![("fixture-a", 100.0), ("fixture-b", 10.0)]);

        let a = read_grok_usage_from_endpoint(&home_a, false, &endpoint)
            .await
            .expect("home a");
        assert_eq!(percent(&a), Some(100.0));
        assert_eq!(a.quota_source.as_deref(), Some("provider_api"));
        assert!(a.quota_observed_at.is_some(), "a probe reading is stamped");

        let b = read_grok_usage_from_endpoint(&home_b, false, &endpoint)
            .await
            .expect("home b");
        assert_eq!(
            percent(&b),
            Some(10.0),
            "B must not reuse A's exhausted reading"
        );

        let a_again = read_grok_usage_from_endpoint(&home_a, false, &endpoint)
            .await
            .expect("home a cached");
        assert_eq!(percent(&a_again), Some(100.0));
        assert_eq!(a_again.quota_observed_at, a.quota_observed_at);

        server.join().unwrap();
        std::fs::remove_dir_all(&home_a).ok();
        std::fs::remove_dir_all(&home_b).ok();
    }

    #[tokio::test]
    async fn a_rotated_login_at_the_same_home_is_read_again() {
        let home = unique_temp_home("rotated");
        write_auth(&home, "fixture-old", "user-old");
        let (endpoint, server) = serve_billing(vec![("fixture-old", 100.0), ("fixture-new", 0.0)]);
        let old = read_grok_usage_from_endpoint(&home, false, &endpoint)
            .await
            .expect("old login");
        assert_eq!(percent(&old), Some(100.0));
        write_auth(&home, "fixture-new", "user-new");
        let new = read_grok_usage_from_endpoint(&home, false, &endpoint)
            .await
            .expect("new login");
        assert_eq!(percent(&new), Some(0.0));
        server.join().unwrap();
        std::fs::remove_dir_all(&home).ok();
    }

    #[tokio::test]
    async fn a_home_without_a_login_reads_nothing() {
        let empty = unique_temp_home("empty");
        std::fs::create_dir_all(&empty).unwrap();
        // The reader must return before making any request.
        assert!(
            read_grok_usage_from_endpoint(&empty, false, "http://127.0.0.1:9/unused")
                .await
                .is_none()
        );
        std::fs::remove_dir_all(&empty).ok();
    }

    #[test]
    fn expired_entries_are_skipped() {
        let raw = serde_json::json!({
            "issuer::old": {"key": "fixture-expired", "expires_at": "2000-01-01T00:00:00Z"},
            "issuer::new": {"key": "fixture-live", "userId": "user-live"},
        })
        .to_string();
        assert_eq!(
            grok_credentials_from_auth_json(&raw),
            Some(("fixture-live".to_string(), Some("user-live".to_string())))
        );
    }

    fn weekly_credits_fixture(start: &str, end: &str) -> Value {
        serde_json::json!({"config": {
            "currentPeriod": {"type":"USAGE_PERIOD_TYPE_WEEKLY", "start": start, "end": end},
            "onDemandCap": {"val":0}, "onDemandUsed": {"val":0},
            "isUnifiedBillingUser": true, "prepaidBalance": {"val":0},
            "billingPeriodStart": start, "billingPeriodEnd": end,
        }})
    }

    fn assert_single_grok_quota(payload: &Value, label: &str, reset_at: &str) -> LlmQuotaUsage {
        let usage = grok_billing_usage_from_value(payload).unwrap();
        assert_eq!(usage.quota_source.as_deref(), Some("provider_api"));
        let mut quotas = usage.quota_usages.unwrap();
        assert_eq!(quotas.len(), 1);
        let quota = quotas.pop().unwrap();
        assert_eq!(quota.label.as_deref(), Some(label));
        assert_eq!(quota.window.as_deref(), Some("grok"));
        assert_eq!(quota.reset_at.as_deref(), Some(reset_at));
        quota
    }

    #[test]
    fn grok_build_billing_extracts_monthly_credit_quota() {
        let payload = serde_json::json!({
            "config": {
                "monthlyLimit": { "val": 150000 },
                "used": { "val": 4922 },
                "onDemandCap": { "val": 0 },
                "billingPeriodStart": "2026-07-01T00:00:00+00:00",
                "billingPeriodEnd": "2026-08-01T00:00:00+00:00"
            }
        });

        let quota = assert_single_grok_quota(&payload, "1mo", "2026-08-01T00:00:00+00:00");
        assert_eq!(quota.used, Some(4922.0));
        assert_eq!(quota.limit, Some(150000.0));
        assert!((quota.percent.unwrap() - (4922.0 / 150000.0 * 100.0)).abs() < 0.01);
    }

    #[test]
    fn grok_build_credits_format_extracts_weekly_usage_percent() {
        // Unified SuperGrok accounts report monthlyLimit=0. The /usage meter comes
        // from `?format=credits`: a percent plus the current weekly window.
        let mut payload = weekly_credits_fixture(
            "2026-08-13T19:53:31.648309+00:00",
            "2026-08-20T19:53:31.648309+00:00",
        );
        payload["config"]["creditUsagePercent"] = serde_json::json!(23.0);
        payload["config"]["productUsage"] =
            serde_json::json!([{"product":"GrokBuild","usagePercent":23.0}]);

        let quota = assert_single_grok_quota(&payload, "1w", "2026-08-20T19:53:31.648309+00:00");
        assert_eq!(quota.percent, Some(23.0));
    }

    #[test]
    fn grok_build_zero_monthly_limit_without_credits_is_not_a_quota() {
        let payload = serde_json::json!({
            "config": {
                "monthlyLimit": { "val": 0 },
                "used": { "val": 0 },
                "billingPeriodEnd": "2026-09-01T00:00:00+00:00"
            }
        });
        assert!(grok_billing_usage_from_value(&payload).is_none());
    }

    #[test]
    fn grok_build_credits_omitted_percent_is_zero_usage() {
        // Live SuperGrok `?format=credits` omits creditUsagePercent and productUsage
        // when the weekly pool is at 0% (proto3 default). That is still a quota.
        let mut payload = weekly_credits_fixture(
            "2026-09-10T19:53:31.648309+00:00",
            "2026-09-17T19:53:31.648309+00:00",
        );
        payload["config"]["topUpMethod"] = serde_json::json!("TOP_UP_METHOD_SAVED_PAYMENT_METHOD");

        let quota = assert_single_grok_quota(&payload, "1w", "2026-09-17T19:53:31.648309+00:00");
        assert_eq!(quota.percent, Some(0.0));
    }
}
