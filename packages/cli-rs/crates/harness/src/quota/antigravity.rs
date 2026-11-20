//! Google Antigravity (`agy`) account quota, read from the Cloud Code API
//! behind the CLI's stored OAuth login.
//!
//! `agy` stores its OAuth token JSON at
//! `~/.gemini/antigravity-cli/antigravity-oauth-token` (or under
//! `ANTIGRAVITY_APP_DATA_DIR`), and also honours `JETSKI_OAUTH_TOKEN`.
//!
//! Antigravity separates quota into model pools rather than one account-wide
//! window:
//! - `retrieveUserQuotaSummary` reports grouped 5h and weekly buckets (such as
//!   `Claude & GPT` models via `3p-5h` / `3p-weekly`, and any Gemini group the
//!   backend includes).
//! - `fetchAvailableModels` reports per-model `quotaInfo` (`remainingFraction`,
//!   `resetTime`), which carries the live `Gemini` pool window when
//!   `retrieveUserQuotaSummary` omits Gemini.
//!
//! Every window travels in `scoped_quota_usages`, paired with `quota_scopes` on
//! Antigravity's ACP model catalog so one pool's exhaustion never stops models
//! in another pool.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::cache::{KeyedProviderUsageCache, fetch_provider_json};
use super::windows::percent_window;
use crate::fields::first_string;
use crate::host::{home_dir_path, lowercase_hex, provider_client};
use crate::usage::{LlmQuotaUsage, LlmUsage};

/// Environment variables that make an `agy` spawn bill something other than
/// the default `~/.gemini/antigravity-cli/antigravity-oauth-token` login.
pub const ANTIGRAVITY_LOGIN_OVERRIDE_KEYS: &[&str] = &[
    "JETSKI_OAUTH_TOKEN",
    "ANTIGRAVITY_APP_DATA_DIR",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
];

const ANTIGRAVITY_CLOUD_CODE_BASE_URL: &str = "https://daily-cloudcode-pa.googleapis.com";
/// Fallback Antigravity CLI version sent in the Cloud Code `User-Agent`.
/// `retrieveUserQuotaSummary` gates the native `Gemini Models` group (5h and
/// weekly buckets) behind `antigravity/cli/1.2.0+` and omits Gemini entirely
/// for unversioned strings like `antigravity/xmatrix`.
const FALLBACK_ANTIGRAVITY_CLI_VERSION: &str = "1.5.13";
const MIN_QUOTA_SUMMARY_CLI_VERSION: (u64, u64, u64) = (1, 2, 0);
const AGY_VERSION_TIMEOUT: Duration = Duration::from_secs(2);
const EXPIRY_BUFFER_SECS: i64 = 60;
const WEEKLY_RESET_THRESHOLD_SECS: i64 = 24 * 60 * 60;

const SCOPE_GEMINI: &str = "Gemini";
const SCOPE_CLAUDE_GPT: &str = "Claude & GPT";
const MAX_SCOPE_BYTES: usize = 64;

static ANTIGRAVITY_QUOTA: KeyedProviderUsageCache =
    KeyedProviderUsageCache::new(Duration::from_secs(120), Duration::from_secs(60));

struct AntigravityCredential {
    access_token: String,
    /// Credential source plus a one-way fingerprint of its bytes; used only as
    /// an in-memory cache key and never logged or sent.
    cache_key: String,
}

fn fingerprint(raw: &str) -> String {
    lowercase_hex(&Sha256::digest(raw.as_bytes()))
}

fn default_oauth_token_path() -> Option<PathBuf> {
    Some(
        home_dir_path()?
            .join(".gemini")
            .join("antigravity-cli")
            .join("antigravity-oauth-token"),
    )
}

fn credential_from_file(path: &PathBuf, now: OffsetDateTime) -> Option<AntigravityCredential> {
    let raw = std::fs::read_to_string(path).ok()?;
    let access_token = access_token_from_oauth_json(&raw, now)?;
    Some(AntigravityCredential {
        access_token,
        cache_key: format!("{}\u{0}{}", path.to_string_lossy(), fingerprint(&raw)),
    })
}

/// Extract an unexpired OAuth access token from `antigravity-oauth-token`.
pub(crate) fn access_token_from_oauth_json(raw: &str, now: OffsetDateTime) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let root = value.as_object()?;
    let token_obj = root.get("token").and_then(Value::as_object).unwrap_or(root);
    let access_token = first_string(token_obj, &["access_token", "accessToken"])?;
    if let Some(expiry) = first_string(token_obj, &["expiry", "expires_at", "expiresAt"])
        && let Ok(parsed) = OffsetDateTime::parse(&expiry, &Rfc3339)
        && parsed <= now + time::Duration::seconds(EXPIRY_BUFFER_SECS)
    {
        return None;
    }
    Some(access_token)
}

fn process_credential() -> Option<AntigravityCredential> {
    if let Ok(token) = std::env::var("JETSKI_OAUTH_TOKEN") {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            return Some(AntigravityCredential {
                access_token: trimmed.to_string(),
                cache_key: format!("env\u{0}{}", fingerprint(trimmed)),
            });
        }
    }
    let now = OffsetDateTime::now_utc();
    if let Ok(app_data_dir) = std::env::var("ANTIGRAVITY_APP_DATA_DIR") {
        let trimmed = app_data_dir.trim();
        if !trimmed.is_empty() {
            return credential_from_file(
                &PathBuf::from(trimmed).join("antigravity-oauth-token"),
                now,
            );
        }
    }
    let path = default_oauth_token_path()?;
    credential_from_file(&path, now)
}

fn default_account_credential() -> Option<AntigravityCredential> {
    let path = default_oauth_token_path()?;
    credential_from_file(&path, OffsetDateTime::now_utc())
}

/// Read Antigravity quota for the login resolved by the current process
/// environment (`JETSKI_OAUTH_TOKEN`, `ANTIGRAVITY_APP_DATA_DIR`, or
/// `~/.gemini/antigravity-cli/antigravity-oauth-token`).
pub async fn read_antigravity_quota_usage(force: bool) -> Option<LlmUsage> {
    let credential = process_credential()?;
    read_antigravity_quota_from_base(
        credential,
        force,
        ANTIGRAVITY_CLOUD_CODE_BASE_URL,
        process_credential,
    )
    .await
}

/// Read Antigravity quota for the default login
/// (`~/.gemini/antigravity-cli/antigravity-oauth-token`), ignoring process
/// overrides. Callers must first prove a registered spawn sees no override.
pub(crate) async fn read_antigravity_quota_usage_for_default_account(
    force: bool,
) -> Option<LlmUsage> {
    let credential = default_account_credential()?;
    read_antigravity_quota_from_base(
        credential,
        force,
        ANTIGRAVITY_CLOUD_CODE_BASE_URL,
        default_account_credential,
    )
    .await
}

async fn read_antigravity_quota_from_base<F>(
    credential: AntigravityCredential,
    force: bool,
    base_url: &str,
    reread_credential: F,
) -> Option<LlmUsage>
where
    F: Fn() -> Option<AntigravityCredential>,
{
    let key = credential.cache_key.as_str();
    if let Some(cached) = ANTIGRAVITY_QUOTA.hit_unless_forced(key, force) {
        return cached;
    }
    ANTIGRAVITY_QUOTA
        .single_flight(key, || async {
            let user_agent = antigravity_user_agent().await;
            let Some(load_resp) = fetch_provider_json(
                "antigravity",
                cloud_code_post(
                    base_url,
                    "loadCodeAssist",
                    &credential.access_token,
                    &user_agent,
                    &serde_json::json!({ "metadata": { "ideType": "ANTIGRAVITY" } }),
                ),
            )
            .await
            else {
                ANTIGRAVITY_QUOTA.store(key, None);
                return None;
            };

            let project = load_resp
                .as_object()
                .and_then(|map| first_string(map, &["cloudaicompanionProject"]));
            let body = match project {
                Some(project) => serde_json::json!({ "project": project }),
                None => serde_json::json!({}),
            };

            let (summary, models) = tokio::join!(
                fetch_provider_json(
                    "antigravity",
                    cloud_code_post(
                        base_url,
                        "retrieveUserQuotaSummary",
                        &credential.access_token,
                        &user_agent,
                        &body,
                    ),
                ),
                fetch_provider_json(
                    "antigravity",
                    cloud_code_post(
                        base_url,
                        "fetchAvailableModels",
                        &credential.access_token,
                        &user_agent,
                        &body,
                    ),
                ),
            );

            // The requests may outlive a login switch; never file a reading
            // under or return it for a different account.
            if reread_credential().map(|next| next.cache_key).as_deref() != Some(key) {
                return None;
            }

            let mut usage = antigravity_quota_usage_from_values(
                summary.as_ref(),
                models.as_ref(),
                OffsetDateTime::now_utc(),
            );
            if let Some(usage) = usage.as_mut() {
                usage.quota_observed_at = super::observed_now();
            }
            ANTIGRAVITY_QUOTA.store(key, usage.clone());
            usage
        })
        .await
}

fn parse_cli_semver(raw: &str) -> Option<(u64, u64, u64)> {
    raw.split(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
        .find_map(|token| {
            let mut parts = token.split('.');
            let major = parts.next()?.parse::<u64>().ok()?;
            let minor = parts.next()?.parse::<u64>().ok()?;
            let patch = parts.next()?.parse::<u64>().ok()?;
            if parts.next().is_some() {
                return None;
            }
            Some((major, minor, patch))
        })
}

fn format_antigravity_user_agent(detected: Option<&str>) -> String {
    if let Some((major, minor, patch)) = detected.and_then(parse_cli_semver)
        && (major, minor, patch) >= MIN_QUOTA_SUMMARY_CLI_VERSION
    {
        return format!("antigravity/cli/{major}.{minor}.{patch}");
    }
    format!("antigravity/cli/{FALLBACK_ANTIGRAVITY_CLI_VERSION}")
}

async fn read_agy_version_from(program: &std::ffi::OsStr) -> Option<String> {
    let mut command = tokio::process::Command::new(program);
    command
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(AGY_VERSION_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

async fn detect_installed_agy_version() -> Option<String> {
    if let Some(output) = read_agy_version_from(std::ffi::OsStr::new("agy")).await {
        return Some(output);
    }
    #[cfg(not(windows))]
    if let Some(home) = home_dir_path() {
        let local_bin = home.join(".local").join("bin").join("agy");
        if local_bin.is_file() {
            return read_agy_version_from(local_bin.as_os_str()).await;
        }
    }
    None
}

async fn antigravity_user_agent() -> String {
    if let Ok(version) = std::env::var("ANTIGRAVITY_CLI_VERSION")
        && parse_cli_semver(&version).is_some_and(|v| v >= MIN_QUOTA_SUMMARY_CLI_VERSION)
    {
        return format_antigravity_user_agent(Some(&version));
    }
    let detected = detect_installed_agy_version().await;
    format_antigravity_user_agent(detected.as_deref())
}

fn cloud_code_post(
    base_url: &str,
    method: &str,
    access_token: &str,
    user_agent: &str,
    body: &Value,
) -> reqwest::RequestBuilder {
    let base = base_url.trim_end_matches('/');
    provider_client()
        .post(format!("{base}/v1internal:{method}"))
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {access_token}"),
        )
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, user_agent)
        .json(body)
}

/// The quota pool an Antigravity model spends (`Gemini` or `Claude & GPT`), or
/// `None` for unrecognised model ids.
pub fn antigravity_quota_scope_for_model(model: &str) -> Option<&'static str> {
    let id = model.trim().to_ascii_lowercase();
    if id.starts_with("gemini") {
        Some(SCOPE_GEMINI)
    } else if id.starts_with("claude") || id.starts_with("gpt") {
        Some(SCOPE_CLAUDE_GPT)
    } else {
        None
    }
}

/// Parse Antigravity's `retrieveUserQuotaSummary` and `fetchAvailableModels`
/// responses into scoped pool windows.
pub(crate) fn antigravity_quota_usage_from_values(
    summary: Option<&Value>,
    models: Option<&Value>,
    now: OffsetDateTime,
) -> Option<LlmUsage> {
    let mut scoped = Vec::new();
    if let Some(summary) = summary {
        collect_summary_windows(summary, &mut scoped);
    }
    if let Some(models) = models {
        collect_missing_model_pool_windows(models, now, &mut scoped);
    }
    dedupe_and_sort_windows(&mut scoped);
    if scoped.is_empty() {
        return None;
    }
    Some(LlmUsage {
        quota_source: Some("provider_api".to_string()),
        quota_observed_at: super::observed_now(),
        quota_usages: None,
        scoped_quota_usages: Some(scoped),
        ..LlmUsage::default()
    })
}

fn collect_summary_windows(summary: &Value, out: &mut Vec<LlmQuotaUsage>) {
    let Some(root) = summary.as_object() else {
        return;
    };
    if let Some(groups) = root.get("groups").and_then(Value::as_array) {
        for group in groups {
            let Some(group) = group.as_object() else {
                continue;
            };
            let Some(buckets) = group.get("buckets").and_then(Value::as_array) else {
                continue;
            };
            let Some(scope) = summary_group_scope(group, buckets) else {
                continue;
            };
            for bucket in buckets {
                if let Some(window) = summary_bucket_window(bucket, &scope) {
                    out.push(window);
                }
            }
        }
    }
    if let Some(buckets) = root.get("buckets").and_then(Value::as_array) {
        for bucket in buckets {
            let Some(scope) = bucket
                .as_object()
                .and_then(|map| first_string(map, &["bucketId", "bucket_id"]))
                .and_then(|id| scope_from_bucket_id(&id))
            else {
                continue;
            };
            if let Some(window) = summary_bucket_window(bucket, scope) {
                out.push(window);
            }
        }
    }
}

fn summary_group_scope(group: &Map<String, Value>, buckets: &[Value]) -> Option<String> {
    if let Some(display_name) = first_string(group, &["displayName", "display_name"]) {
        let lower = display_name.to_ascii_lowercase();
        if lower.contains("claude") && lower.contains("gpt") {
            return Some(SCOPE_CLAUDE_GPT.to_string());
        }
        let cleaned = strip_trailing_models_word(&display_name);
        if !cleaned.is_empty() && cleaned.len() <= MAX_SCOPE_BYTES {
            return Some(cleaned.to_string());
        }
    }
    buckets.iter().find_map(|bucket| {
        bucket
            .as_object()
            .and_then(|map| first_string(map, &["bucketId", "bucket_id"]))
            .and_then(|id| scope_from_bucket_id(&id))
            .map(str::to_string)
    })
}

fn strip_trailing_models_word(name: &str) -> &str {
    let trimmed = name.trim();
    if trimmed.len() > " models".len()
        && trimmed[trimmed.len() - " models".len()..].eq_ignore_ascii_case(" models")
    {
        trimmed[..trimmed.len() - " models".len()].trim()
    } else {
        trimmed
    }
}

fn scope_from_bucket_id(bucket_id: &str) -> Option<&'static str> {
    let lower = bucket_id.trim().to_ascii_lowercase();
    if lower.starts_with("3p-") || lower.starts_with("3p_") {
        Some(SCOPE_CLAUDE_GPT)
    } else if lower.starts_with("gemini") {
        Some(SCOPE_GEMINI)
    } else {
        None
    }
}

fn summary_bucket_window(bucket: &Value, scope: &str) -> Option<LlmQuotaUsage> {
    let map = bucket.as_object()?;
    if map.get("disabled").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let label = summary_bucket_label(map)?;
    let reset_at = first_string(map, &["resetTime", "reset_time"]);
    let used_percent = used_percent_from_remaining_fraction(map, reset_at.is_some())?;
    let mut window = percent_window(
        label,
        "antigravity",
        used_percent,
        used_percent >= 100.0,
        reset_at,
    );
    window.scope = Some(scope.to_string());
    Some(window)
}

fn summary_bucket_label(map: &Map<String, Value>) -> Option<&'static str> {
    let candidate = first_string(map, &["window"]).or_else(|| {
        first_string(map, &["bucketId", "bucket_id"])
            .and_then(|id| id.rsplit(['-', '_']).next().map(str::to_string))
    })?;
    match candidate
        .trim()
        .to_ascii_lowercase()
        .replace(['_', '-', ' '], "")
        .as_str()
    {
        "5h" | "5hour" | "5hours" | "fivehour" | "fivehours" => Some("5h"),
        "1w" | "7d" | "week" | "weekly" | "sevenday" => Some("1w"),
        "2h" | "2hour" | "2hours" | "twohour" | "twohours" => Some("2h"),
        "1mo" | "month" | "monthly" | "1month" => Some("1mo"),
        "1d" | "day" | "daily" | "1day" => Some("1d"),
        _ => None,
    }
}

/// Convert proto3 `remainingFraction` (0..=1 remaining) to xMatrix used
/// percent (0..=100 used). Proto3 JSON omits float fields at `0.0`, so an
/// omitted `remainingFraction` alongside a `resetTime` means 0% remaining
/// (100% used).
fn used_percent_from_remaining_fraction(
    map: &Map<String, Value>,
    has_reset_time: bool,
) -> Option<f64> {
    let raw = map
        .get("remainingFraction")
        .or_else(|| map.get("remaining_fraction"));
    match raw.and_then(Value::as_f64) {
        Some(fraction) if fraction.is_finite() && (0.0..=1.0).contains(&fraction) => {
            Some(((1.0 - fraction) * 100.0).clamp(0.0, 100.0))
        }
        Some(_) => None,
        None if has_reset_time => Some(100.0),
        None => None,
    }
}

struct PoolReading {
    used_percent: f64,
    reset_at: Option<String>,
}

fn collect_missing_model_pool_windows(
    models_resp: &Value,
    now: OffsetDateTime,
    out: &mut Vec<LlmQuotaUsage>,
) {
    let Some(models) = models_resp.get("models").and_then(Value::as_object) else {
        return;
    };
    let has_scope = |prefix: &str| {
        out.iter().any(|window| {
            window
                .scope
                .as_deref()
                .is_some_and(|scope| scope.to_ascii_lowercase().starts_with(prefix))
        })
    };
    let need_gemini = !has_scope("gemini");
    let need_third_party = !has_scope("claude");
    if !need_gemini && !need_third_party {
        return;
    }

    let mut tightest_gemini: Option<PoolReading> = None;
    let mut tightest_third_party: Option<PoolReading> = None;

    for (model_id, entry) in models {
        let Some(scope) = antigravity_quota_scope_for_model(model_id) else {
            continue;
        };
        let slot = match scope {
            SCOPE_GEMINI if need_gemini => &mut tightest_gemini,
            SCOPE_CLAUDE_GPT if need_third_party => &mut tightest_third_party,
            _ => continue,
        };
        let Some(quota_info) = entry
            .get("quotaInfo")
            .or_else(|| entry.get("quota_info"))
            .and_then(Value::as_object)
        else {
            continue;
        };
        let reset_at = first_string(quota_info, &["resetTime", "reset_time"]);
        let Some(used_percent) =
            used_percent_from_remaining_fraction(quota_info, reset_at.is_some())
        else {
            continue;
        };
        let replace = match slot.as_ref() {
            None => true,
            Some(current) => {
                // Prefer entries with a reset time; among equal presence, take
                // the tightest (highest used%) reading, breaking ties by latest reset.
                match (reset_at.is_some(), current.reset_at.is_some()) {
                    (true, false) => true,
                    (false, true) => false,
                    _ => {
                        used_percent > current.used_percent
                            || ((used_percent - current.used_percent).abs() < f64::EPSILON
                                && reset_at > current.reset_at)
                    }
                }
            }
        };
        if replace {
            *slot = Some(PoolReading {
                used_percent,
                reset_at,
            });
        }
    }

    for (scope, reading) in [
        (SCOPE_GEMINI, tightest_gemini),
        (SCOPE_CLAUDE_GPT, tightest_third_party),
    ] {
        let Some(reading) = reading else {
            continue;
        };
        let label = infer_window_label(reading.reset_at.as_deref(), now);
        let mut window = percent_window(
            label,
            "antigravity",
            reading.used_percent,
            reading.used_percent >= 100.0,
            reading.reset_at,
        );
        window.scope = Some(scope.to_string());
        out.push(window);
    }
}

fn infer_window_label(reset_at: Option<&str>, now: OffsetDateTime) -> &'static str {
    let Some(reset_at) = reset_at else {
        return "5h";
    };
    let Ok(parsed) = OffsetDateTime::parse(reset_at, &Rfc3339) else {
        return "5h";
    };
    if (parsed - now).whole_seconds() > WEEKLY_RESET_THRESHOLD_SECS {
        "1w"
    } else {
        "5h"
    }
}

fn dedupe_and_sort_windows(windows: &mut Vec<LlmQuotaUsage>) {
    let mut seen = std::collections::HashSet::new();
    windows.retain(|window| {
        let key = format!(
            "{}\u{0}{}",
            window.scope.as_deref().unwrap_or("").to_ascii_lowercase(),
            window.label.as_deref().unwrap_or("").to_ascii_lowercase()
        );
        seen.insert(key)
    });
    windows.sort_by(|left, right| {
        let rank_label = |label: Option<&str>| match label.unwrap_or("") {
            "5h" => 0,
            "1w" => 1,
            "2h" => 2,
            "1mo" => 3,
            _ => 4,
        };
        let rank_scope = |scope: Option<&str>| match scope.unwrap_or("") {
            SCOPE_GEMINI => 0,
            SCOPE_CLAUDE_GPT => 1,
            _ => 2,
        };
        rank_label(left.label.as_deref())
            .cmp(&rank_label(right.label.as_deref()))
            .then_with(|| {
                rank_scope(left.scope.as_deref()).cmp(&rank_scope(right.scope.as_deref()))
            })
            .then_with(|| left.scope.cmp(&right.scope))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    fn now() -> OffsetDateTime {
        OffsetDateTime::parse("2026-11-19T11:00:00Z", &Rfc3339).expect("now")
    }

    #[test]
    fn oauth_json_accepts_unexpired_token_and_rejects_stale_one() {
        let fresh = serde_json::json!({
            "token": {
                "access_token": "ya29.fresh",
                "expiry": "2026-11-19T11:35:51Z"
            },
            "auth_method": "consumer"
        })
        .to_string();
        assert_eq!(
            access_token_from_oauth_json(&fresh, now()).as_deref(),
            Some("ya29.fresh")
        );

        let expired = serde_json::json!({
            "token": {
                "access_token": "ya29.stale",
                "expiry": "2026-11-19T11:00:30Z"
            }
        })
        .to_string();
        assert_eq!(access_token_from_oauth_json(&expired, now()), None);
    }

    #[test]
    fn merges_summary_third_party_windows_with_gemini_model_quota() {
        let summary = serde_json::json!({
            "groups": [{
                "displayName": "Claude and GPT models",
                "buckets": [
                    {
                        "bucketId": "3p-weekly",
                        "window": "weekly",
                        "resetTime": "2026-11-26T11:00:00Z",
                        "remainingFraction": 1
                    },
                    {
                        "bucketId": "3p-5h",
                        "window": "5h",
                        "resetTime": "2026-11-19T16:00:00Z",
                        "remainingFraction": 0.75
                    }
                ]
            }]
        });
        let models = serde_json::json!({
            "models": {
                "gemini-2.5-pro": {
                    "quotaInfo": {
                        "remainingFraction": 0.95,
                        "resetTime": "2026-11-19T14:30:00Z"
                    }
                },
                "claude-opus-5-5-high": {
                    "quotaInfo": {
                        "remainingFraction": 0.75,
                        "resetTime": "2026-11-19T16:00:00Z"
                    }
                },
                "tab_flash_lite_preview": {
                    "quotaInfo": { "remainingFraction": 1 }
                }
            }
        });

        let usage =
            antigravity_quota_usage_from_values(Some(&summary), Some(&models), now()).unwrap();
        assert_eq!(usage.quota_source.as_deref(), Some("provider_api"));
        assert!(usage.quota_usages.is_none());
        let scoped = usage.scoped_quota_usages.unwrap();
        assert_eq!(scoped.len(), 3);

        assert_eq!(scoped[0].scope.as_deref(), Some("Gemini"));
        assert_eq!(scoped[0].label.as_deref(), Some("5h"));
        assert!((scoped[0].percent.unwrap() - 5.0).abs() < 1e-6);
        assert_eq!(scoped[0].reset_at.as_deref(), Some("2026-11-19T14:30:00Z"));

        assert_eq!(scoped[1].scope.as_deref(), Some("Claude & GPT"));
        assert_eq!(scoped[1].label.as_deref(), Some("5h"));
        assert!((scoped[1].percent.unwrap() - 25.0).abs() < 1e-6);

        assert_eq!(scoped[2].scope.as_deref(), Some("Claude & GPT"));
        assert_eq!(scoped[2].label.as_deref(), Some("1w"));
        assert_eq!(scoped[2].percent, Some(0.0));
    }

    #[test]
    fn proto3_omitted_remaining_fraction_with_reset_time_means_exhausted() {
        let summary = serde_json::json!({
            "groups": [{
                "displayName": "Claude and GPT models",
                "buckets": [{
                    "bucketId": "3p-5h",
                    "window": "5h",
                    "resetTime": "2026-11-19T16:00:00Z"
                }, {
                    "bucketId": "3p-weekly",
                    "window": "weekly",
                    "disabled": true,
                    "resetTime": "2026-11-26T11:00:00Z"
                }]
            }]
        });
        let models = serde_json::json!({
            "models": {
                "gemini-3-flash": {
                    "quotaInfo": { "resetTime": "2026-11-25T11:00:00Z" }
                }
            }
        });
        let usage =
            antigravity_quota_usage_from_values(Some(&summary), Some(&models), now()).unwrap();
        let scoped = usage.scoped_quota_usages.unwrap();
        assert_eq!(scoped.len(), 2);
        assert_eq!(scoped[0].scope.as_deref(), Some("Claude & GPT"));
        assert_eq!(scoped[0].label.as_deref(), Some("5h"));
        assert_eq!(scoped[0].percent, Some(100.0));
        assert_eq!(scoped[0].remaining, Some(0.0));

        assert_eq!(scoped[1].scope.as_deref(), Some("Gemini"));
        assert_eq!(scoped[1].label.as_deref(), Some("1w"));
        assert_eq!(scoped[1].percent, Some(100.0));
        assert_eq!(scoped[1].remaining, Some(0.0));
    }

    #[test]
    fn model_scope_maps_gemini_and_third_party_families() {
        assert_eq!(
            antigravity_quota_scope_for_model("gemini-4-neon-high"),
            Some("Gemini")
        );
        assert_eq!(
            antigravity_quota_scope_for_model("gemini-pro-orchestrator"),
            Some("Gemini")
        );
        assert_eq!(
            antigravity_quota_scope_for_model("claude-opus-5-5-high"),
            Some("Claude & GPT")
        );
        assert_eq!(
            antigravity_quota_scope_for_model("gpt-oss-120b-medium"),
            Some("Claude & GPT")
        );
        assert_eq!(antigravity_quota_scope_for_model("tab_flash_lite"), None);
    }

    #[test]
    fn user_agent_uses_cli_semver_and_clamps_legacy_versions() {
        assert_eq!(
            format_antigravity_user_agent(Some("1.5.13\n")),
            "antigravity/cli/1.5.13"
        );
        assert_eq!(
            format_antigravity_user_agent(Some("agy 2.0.4")),
            "antigravity/cli/2.0.4"
        );
        assert_eq!(
            format_antigravity_user_agent(Some("1.1.9")),
            format!("antigravity/cli/{FALLBACK_ANTIGRAVITY_CLI_VERSION}")
        );
        assert_eq!(
            format_antigravity_user_agent(None),
            format!("antigravity/cli/{FALLBACK_ANTIGRAVITY_CLI_VERSION}")
        );
    }

    #[tokio::test]
    async fn loopback_read_calls_cloud_code_endpoints_and_parses_pools() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        listener.set_nonblocking(true).expect("nonblocking");

        let server = std::thread::spawn(move || {
            for _ in 0..3 {
                let (mut stream, req) = super::super::read_fixture_http_request(
                    &listener,
                    "expected antigravity cloud code request",
                );
                assert!(req.contains("authorization: bearer test-antigravity-token"));
                let has_versioned_cli_ua = req
                    .lines()
                    .find_map(|line| line.strip_prefix("user-agent: "))
                    .and_then(|ua| ua.strip_prefix("antigravity/cli/"))
                    .and_then(parse_cli_semver)
                    .is_some_and(|version| version >= MIN_QUOTA_SUMMARY_CLI_VERSION);
                assert!(
                    has_versioned_cli_ua,
                    "expected versioned antigravity/cli/<semver> user-agent, got request:\n{req}"
                );
                let body = if req.contains("v1internal:loadcodeassist") {
                    r#"{"cloudaicompanionProject":"test-project-1"}"#
                } else if req.contains("v1internal:retrieveuserquotasummary") {
                    r#"{"groups":[{"displayName":"Gemini Models","buckets":[{"bucketId":"gemini-weekly","window":"weekly","resetTime":"2026-11-26T09:34:53Z","remainingFraction":0.87},{"bucketId":"gemini-5h","window":"5h","resetTime":"2026-11-20T20:34:53Z","remainingFraction":0.96}]},{"displayName":"Claude and GPT models","buckets":[{"bucketId":"3p-weekly","window":"weekly","resetTime":"2026-11-27T16:00:00Z","remainingFraction":1},{"bucketId":"3p-5h","window":"5h","resetTime":"2026-11-20T21:00:00Z","remainingFraction":1}]}]}"#
                } else if req.contains("v1internal:fetchavailablemodels") {
                    r#"{"models":{"gemini-4-neon-high":{"quotaInfo":{"remainingFraction":0.96,"resetTime":"2026-11-20T20:34:53Z"}}}}"#
                } else {
                    panic!("unexpected request: {req}");
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(response.as_bytes()).expect("write");
                stream.flush().expect("flush");
                let _ = stream.shutdown(std::net::Shutdown::Write);
            }
        });

        let make_cred = || AntigravityCredential {
            access_token: "test-antigravity-token".to_string(),
            cache_key: format!("loopback-test-{addr}"),
        };
        let usage =
            read_antigravity_quota_from_base(make_cred(), true, &format!("http://{addr}"), || {
                Some(make_cred())
            })
            .await
            .expect("usage");
        server.join().expect("server");

        assert_eq!(usage.quota_source.as_deref(), Some("provider_api"));
        let scoped = usage.scoped_quota_usages.expect("scoped");
        assert_eq!(scoped.len(), 4);
        assert_eq!(scoped[0].scope.as_deref(), Some("Gemini"));
        assert_eq!(scoped[0].label.as_deref(), Some("5h"));
        assert!((scoped[0].percent.unwrap() - 4.0).abs() < 1e-6);
        assert_eq!(scoped[1].scope.as_deref(), Some("Claude & GPT"));
        assert_eq!(scoped[1].label.as_deref(), Some("5h"));
        assert_eq!(scoped[1].percent, Some(0.0));
        assert_eq!(scoped[2].scope.as_deref(), Some("Gemini"));
        assert_eq!(scoped[2].label.as_deref(), Some("1w"));
        assert!((scoped[2].percent.unwrap() - 13.0).abs() < 1e-6);
        assert_eq!(scoped[3].scope.as_deref(), Some("Claude & GPT"));
        assert_eq!(scoped[3].label.as_deref(), Some("1w"));
        assert_eq!(scoped[3].percent, Some(0.0));
    }

    #[tokio::test]
    async fn live_e2e_antigravity_quota_reader() {
        if std::env::var("XMATRIX_LIVE_QUOTA_E2E").ok().as_deref() != Some("1") {
            return;
        }
        let usage = read_antigravity_quota_usage(true)
            .await
            .expect("antigravity quota should resolve with local OAuth token");
        assert_eq!(usage.quota_source.as_deref(), Some("provider_api"));
        let scoped = usage.scoped_quota_usages.as_ref().expect("scoped windows");
        assert!(
            scoped
                .iter()
                .any(|window| window.scope.as_deref() == Some("Gemini")
                    && window.label.as_deref() == Some("5h")
                    && window.percent.is_some()),
            "expected Gemini 5h pool in {scoped:?}"
        );
        assert!(
            scoped
                .iter()
                .any(|window| window.scope.as_deref() == Some("Gemini")
                    && window.label.as_deref() == Some("1w")
                    && window.percent.is_some()),
            "expected Gemini 1w pool in {scoped:?}"
        );
        eprintln!("LIVE_ANTIGRAVITY_QUOTA={scoped:?}");
    }
}
