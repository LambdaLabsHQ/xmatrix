//! Cursor Agent subscription quota, read from the DashboardService usage
//! endpoint behind the CLI's stored login.
//!
//! Cursor offers no official quota interface, so this reader opens Cursor's
//! own sign-in only under the owner's per-machine [`SignInReadGrant`]
//! (`super::grant`). Without one it reads nothing and the quota is unknown;
//! exhaustion is still recognised from Cursor's own out-of-quota errors.
//!
//! Current Cursor Agent builds keep that login in the macOS login keychain
//! (`cursor-access-token` / `cursor-user`) and do not write `auth.json`.
//! Older installs and Windows still use `%APPDATA%/Cursor/auth.json`,
//! `~/.cursor/auth.json`, or the XDG config path. An explicit
//! `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN` wins over both.
//!
//! Cursor reports a billing-cycle meter (`totalPercentUsed`) plus Auto and API
//! pool percentages. The CLI has no machine-readable `usage` subcommand, so
//! this reader calls the same Connect RPC the dashboard and `/usage` use.
//! The Auto and API pools are scoped windows: each constrains only the models
//! that spend it ([`cursor_quota_scope_for_model`]), and the runtime marks
//! every catalog row with its pool.
//!
//! Generic ACP otherwise has no account quota source for Cursor; without this
//! hook the Agents page and `xmatrix list` show `-`.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use serde_json::Value;

use super::grant::{GrantedRead, SignInReadGrant};

use super::windows::percent_window;
use crate::fields::{first_f64, first_string};
use crate::host::{home_dir_path, provider_client};
use crate::usage::{LlmQuotaUsage, LlmUsage};

const CURSOR_PERIOD_USAGE_URL: &str =
    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

/// Candidate auth.json locations the Cursor Agent CLI writes, in precedence
/// order. The CLI title-cases the domain on Windows (`Cursor`) and uses the
/// lowercase domain under XDG / `~/.cursor` elsewhere.
fn cursor_auth_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        paths.push(PathBuf::from(&appdata).join("Cursor").join("auth.json"));
        paths.push(PathBuf::from(appdata).join("cursor").join("auth.json"));
    }
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        paths.push(PathBuf::from(xdg).join("cursor").join("auth.json"));
    }
    if let Some(home) = home_dir_path() {
        paths.push(home.join(".cursor").join("auth.json"));
        paths.push(home.join(".config").join("cursor").join("auth.json"));
        paths.push(
            home.join("AppData")
                .join("Roaming")
                .join("Cursor")
                .join("auth.json"),
        );
    }
    paths
}

fn cursor_token_from_auth_file(path: &PathBuf) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let root = value.as_object()?;
    root.get("accessToken")
        .or_else(|| root.get("access_token"))
        .or_else(|| root.get("token"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn token_from_secret(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Read the login-keychain item current Cursor Agent builds write on macOS.
/// There is no `auth.json` on these installs; skipping the keychain leaves
/// Agents and `xmatrix list` at `-`.
async fn cursor_keychain_access_token() -> Option<String> {
    let raw =
        crate::host::macos_keychain_password("cursor-access-token", Some("cursor-user")).await?;
    token_from_secret(&raw)
}

/// Where the Cursor Agent CLI keeps the sign-in it uses for dashboard RPCs.
///
/// Every credential source this reader can open sits behind this one call, so
/// a read without a grant provably never reaches any of them.
pub(crate) trait CursorSignIn: Sync {
    fn access_token(&self) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>;
}

/// Cursor's own sign-in on this machine: the explicit `CURSOR_API_KEY` or
/// `CURSOR_AUTH_TOKEN`, then the macOS keychain item, then `auth.json`.
struct LocalCursorSignIn;

impl CursorSignIn for LocalCursorSignIn {
    fn access_token(&self) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
        Box::pin(async {
            for key in ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"] {
                if let Ok(token) = std::env::var(key)
                    && let Some(token) = token_from_secret(&token)
                {
                    return Some(token);
                }
            }
            if let Some(token) = cursor_keychain_access_token().await {
                return Some(token);
            }
            cursor_auth_paths()
                .into_iter()
                .find_map(|path| cursor_token_from_auth_file(&path))
        })
    }
}

fn cursor_cli_user_agent() -> String {
    "xmatrix/cursor".to_string()
}

/// Cursor billing-cycle and Auto/API bucket quotas from GetCurrentPeriodUsage,
/// read only under the owner's [`SignInReadGrant`]. Cursor has no official
/// quota interface; without a grant no credential source is opened and the
/// quota stays unknown.
pub async fn read_cursor_period_usage(force: bool, grant: Option<&SignInReadGrant>) -> GrantedRead {
    read_cursor_period_usage_with(force, grant, &LocalCursorSignIn, CURSOR_PERIOD_USAGE_URL).await
}

pub(crate) async fn read_cursor_period_usage_with(
    force: bool,
    grant: Option<&SignInReadGrant>,
    sign_in: &dyn CursorSignIn,
    endpoint: &str,
) -> GrantedRead {
    let Some(grant) = grant else {
        return GrantedRead::Closed;
    };
    if super::quota_probes_disabled() {
        return GrantedRead::Closed;
    }
    let cache = super::cache::account_meter_cache(super::cache::AccountMeter::Cursor);
    let Some(token) = sign_in.access_token().await else {
        // Signed out: nothing to bind and nothing to ask.
        return GrantedRead::Read {
            usage: cache.unavailable(),
            bound: None,
        };
    };
    let bound = match super::grant::match_grant(grant, &token) {
        super::grant::GrantMatch::Same { bound } => bound,
        super::grant::GrantMatch::Changed => {
            // Another account's reading must not outlive the grant.
            cache.clear();
            return GrantedRead::SignInChanged;
        }
    };
    // A first read under a new grant asks afresh: the cache may hold a reading
    // of the sign-in a voided grant was bound to.
    if let Some(cached) = cache.hit_unless_forced(force || bound.is_some()) {
        return GrantedRead::Read {
            usage: cached,
            bound,
        };
    }

    let Some(value) = cache
        .fetch_json(
            "cursor",
            provider_client()
                .post(endpoint)
                .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .header(reqwest::header::ACCEPT, "application/json")
                .header(reqwest::header::USER_AGENT, cursor_cli_user_agent())
                .header("Connect-Protocol-Version", "1")
                .body("{}"),
        )
        .await
    else {
        return GrantedRead::Read { usage: None, bound };
    };

    let usage = cursor_period_usage_from_value(&value);
    cache.store(usage.clone());
    GrantedRead::Read { usage, bound }
}

fn rfc3339_from_unix_millis(raw: &str) -> Option<String> {
    let digits: String = raw.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let millis: i64 = digits.parse().ok()?;
    if millis <= 0 {
        return None;
    }
    let seconds = millis / 1000;
    time::OffsetDateTime::from_unix_timestamp(seconds)
        .ok()?
        .format(&time::format_description::well_known::Rfc3339)
        .ok()
}

fn cursor_reset_at(root: &serde_json::Map<String, Value>) -> Option<String> {
    let raw = first_string(
        root,
        &[
            "billingCycleEnd",
            "billing_cycle_end",
            "billingCycleEndMs",
            "resetAt",
            "resetsAt",
            "reset_at",
            "resets_at",
        ],
    )?;
    if raw.contains('T') {
        return Some(raw);
    }
    rfc3339_from_unix_millis(&raw)
}

/// The pool a Cursor model spends: `Auto` (Auto, Composer, Grok, the runtime
/// `default`) or `API` (third-party Claude, GPT, Gemini, ...). The scope its
/// catalog row carries and the scope of that pool's window.
pub fn cursor_quota_scope_for_model(model: &str) -> &'static str {
    let id = model.trim().to_ascii_lowercase();
    if id.is_empty()
        || id == "default"
        || id == "auto"
        || id.starts_with("default[")
        || id.starts_with("composer")
        || id.starts_with("grok")
    {
        "Auto"
    } else {
        "API"
    }
}

/// A billing-cycle window, `scope`d to a pool or of the whole account.
fn cycle_window(
    percent: Option<f64>,
    reset_at: Option<&str>,
    scope: Option<&str>,
) -> Option<LlmQuotaUsage> {
    let percent = percent.filter(|value| value.is_finite() && *value >= 0.0)?;
    let mut window = percent_window(
        "1mo",
        "cursor",
        percent,
        percent >= 100.0,
        reset_at.map(str::to_string),
    );
    window.scope = scope.map(str::to_string);
    Some(window)
}

/// The Auto and API pools as scoped windows. The cycle total is the account
/// window only when Cursor reports no pool: beside them it is neither, since a
/// used-up total does not stop a pool that still has quota.
pub(crate) fn cursor_period_usage_from_value(value: &Value) -> Option<LlmUsage> {
    let root = value.as_object()?;
    // A disabled meter still answers; treat it as no reading rather than inventing 0%.
    if root.get("enabled").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let plan = root
        .get("planUsage")
        .and_then(Value::as_object)
        .or(Some(root))?;
    let reset_at = cursor_reset_at(root);
    let reset_at = reset_at.as_deref();
    let pools: Vec<LlmQuotaUsage> = [
        ("Auto", &["autoPercentUsed", "auto_percent_used"]),
        ("API", &["apiPercentUsed", "api_percent_used"]),
    ]
    .into_iter()
    .filter_map(|(scope, keys)| cycle_window(first_f64(plan, keys), reset_at, Some(scope)))
    .collect();
    let total = first_f64(
        plan,
        &[
            "totalPercentUsed",
            "total_percent_used",
            "percentUsed",
            "percent_used",
            "percent",
        ],
    );
    let account = cycle_window(total, reset_at, None).filter(|_| pools.is_empty());
    if account.is_none() && pools.is_empty() {
        return None;
    }
    Some(LlmUsage {
        quota_source: Some("provider_api".to_string()),
        quota_observed_at: super::observed_now(),
        quota_usages: account.map(|window| vec![window]),
        // Every Cursor reading is complete: no pool is a statement too.
        scoped_quota_usages: Some(pools),
        ..LlmUsage::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A Cursor sign-in that counts how often any credential source is opened.
    struct CountingSignIn {
        token: Option<&'static str>,
        opened: AtomicUsize,
    }

    impl CountingSignIn {
        fn new(token: Option<&'static str>) -> Self {
            Self {
                token,
                opened: AtomicUsize::new(0),
            }
        }
    }

    impl CursorSignIn for CountingSignIn {
        fn access_token(&self) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
            self.opened.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { self.token.map(str::to_string) })
        }
    }

    /// An endpoint nothing listens on: reaching it would be a request to Cursor.
    const NO_PROVIDER: &str = "http://127.0.0.1:9/never";

    #[tokio::test]
    async fn without_a_grant_no_credential_source_is_opened() {
        let sign_in = CountingSignIn::new(Some("sentinel-cursor-token"));
        let read = read_cursor_period_usage_with(true, None, &sign_in, NO_PROVIDER).await;
        assert!(matches!(read, GrantedRead::Closed), "{read:?}");
        assert_eq!(sign_in.opened.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn the_local_sign_in_is_reachable_only_through_the_granted_reader() {
        // `read` (the ungranted entrypoint) has no Cursor reading for any
        // account binding: only `read_granted` can open Cursor's sign-in.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        for account in [
            super::super::Account::Process,
            super::super::Account::DefaultLogin,
        ] {
            let options = super::super::ReadOptions {
                account,
                force: true,
            };
            assert!(
                runtime
                    .block_on(super::super::read(super::super::Provider::Cursor, options))
                    .is_none()
            );
        }
        assert!(super::super::Provider::Cursor.needs_sign_in_grant_at(None));
    }

    #[tokio::test]
    async fn under_a_grant_the_sign_in_reaches_only_the_request_to_cursor() {
        use std::io::Write;
        const TOKEN: &str = "sentinel-cursor-access-token";
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}/usage", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, headers) =
                super::super::read_fixture_http_request(&listener, "Cursor request missing");
            assert!(headers.contains(&format!("authorization: bearer {TOKEN}\r\n")));
            let body = serde_json::json!({
                "billingCycleEnd": "1900000000000",
                "planUsage": {"autoPercentUsed": 10, "apiPercentUsed": 20}
            })
            .to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        let sign_in = CountingSignIn::new(Some(TOKEN));
        let grant = SignInReadGrant::new("sentinel-grant-key");
        let read = read_cursor_period_usage_with(true, Some(&grant), &sign_in, &endpoint).await;
        server.join().unwrap();
        let GrantedRead::Read {
            usage: Some(usage),
            bound: Some(bound),
        } = read
        else {
            panic!("a first read under a grant reads and binds: {read:?}");
        };
        // The reading is what the daemon reports to the Hub; the binding stays
        // in local config. Neither holds the token, and the reading holds
        // neither the grant's key nor its fingerprint.
        let wire = serde_json::to_string(&usage).unwrap();
        for needle in [TOKEN, "sentinel-grant-key", bound.as_str()] {
            assert!(!wire.contains(needle), "{needle} leaked into {wire}");
        }
        assert!(!bound.contains(TOKEN));
        assert_eq!(usage.scoped_quota_usages.map(|pools| pools.len()), Some(2));
    }

    #[tokio::test]
    async fn another_sign_in_voids_the_grant_without_asking_cursor() {
        let grant = SignInReadGrant {
            sign_in: Some(super::super::grant::sign_in_fingerprint(
                "grant-key",
                "the-granted-account-key",
            )),
            ..SignInReadGrant::new("grant-key")
        };
        let same = CountingSignIn::new(Some("the-granted-account-key"));
        let read = read_cursor_period_usage_with(true, Some(&grant), &same, NO_PROVIDER).await;
        assert!(
            matches!(read, GrantedRead::Read { bound: None, .. }),
            "{read:?}"
        );

        let other = CountingSignIn::new(Some("another-account-key"));
        let read = read_cursor_period_usage_with(false, Some(&grant), &other, NO_PROVIDER).await;
        assert!(matches!(read, GrantedRead::SignInChanged), "{read:?}");
    }

    #[test]
    fn secret_text_drops_blank_and_keeps_a_token() {
        assert_eq!(
            token_from_secret("  cursor-test-token\n").as_deref(),
            Some("cursor-test-token")
        );
        assert!(token_from_secret(" \n").is_none());
        assert!(token_from_secret("").is_none());
    }

    #[test]
    fn parses_billing_cycle_and_bucket_percents() {
        let value = serde_json::json!({
            "billingCycleEnd": "1791883943000",
            "enabled": true,
            "planUsage": {
                "totalPercentUsed": 60.35,
                "autoPercentUsed": 59.01,
                "apiPercentUsed": 100
            }
        });
        let usage = cursor_period_usage_from_value(&value).expect("usage");
        assert_eq!(usage.quota_source.as_deref(), Some("provider_api"));
        assert!(usage.quota_observed_at.is_some());
        // Beside the pools the cycle total gates nothing.
        assert!(usage.quota_usages.is_none());
        let pools = usage.scoped_quota_usages.expect("pools");
        assert_eq!(pools.len(), 2);
        assert_eq!(pools[0].scope.as_deref(), Some("Auto"));
        assert_eq!(pools[0].label.as_deref(), Some("1mo"));
        assert_eq!(pools[0].percent, Some(59.01));
        assert_eq!(pools[0].remaining, None);
        assert_eq!(pools[0].reset_at.as_deref(), Some("2026-10-13T09:32:23Z"));
        assert_eq!(pools[1].scope.as_deref(), Some("API"));
        assert_eq!(pools[1].percent, Some(100.0));
        assert_eq!(pools[1].remaining, Some(0.0));
    }

    #[test]
    fn without_pools_the_cycle_total_is_the_account_window() {
        let value = serde_json::json!({
            "billingCycleEnd": "1791883943000",
            "planUsage": { "totalPercentUsed": 60.35 }
        });
        let usage = cursor_period_usage_from_value(&value).expect("usage");
        let windows = usage.quota_usages.expect("account window");
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].label.as_deref(), Some("1mo"));
        assert_eq!(windows[0].scope, None);
        assert_eq!(windows[0].percent, Some(60.35));
        assert!(
            usage
                .scoped_quota_usages
                .is_some_and(|pools| pools.is_empty())
        );
    }

    #[test]
    fn models_spend_the_auto_or_the_api_pool() {
        for model in ["", "default", "Auto", "default[]", "composer-2.5", "grok-4"] {
            assert_eq!(cursor_quota_scope_for_model(model), "Auto", "{model:?}");
        }
        for model in ["claude-4.5-sonnet", "gpt-5", "gemini-3-pro"] {
            assert_eq!(cursor_quota_scope_for_model(model), "API", "{model:?}");
        }
    }

    #[test]
    fn disabled_or_empty_payload_is_unavailable() {
        assert!(cursor_period_usage_from_value(&serde_json::json!({ "enabled": false })).is_none());
        assert!(cursor_period_usage_from_value(&serde_json::json!({ "enabled": true })).is_none());
        assert!(cursor_period_usage_from_value(&serde_json::json!({})).is_none());
    }

    #[test]
    fn iso_reset_timestamps_pass_through() {
        let value = serde_json::json!({
            "billingCycleEnd": "2026-10-13T08:12:23Z",
            "enabled": true,
            "planUsage": { "totalPercentUsed": 12 }
        });
        let usage = cursor_period_usage_from_value(&value).expect("usage");
        assert_eq!(
            usage.quota_usages.as_ref().unwrap()[0].reset_at.as_deref(),
            Some("2026-10-13T08:12:23Z")
        );
    }
}
