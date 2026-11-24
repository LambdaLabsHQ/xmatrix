//! OpenCode quota, asked of OpenCode itself.
//!
//! `opencode serve` answers `GET /api/experimental/usage/limits` with the
//! OpenCode Go allowance (`go.rolling`, `go.weekly`, `go.monthly`: `percent`,
//! `limited`, `resetsAt` in Unix milliseconds) and the OpenCode Console
//! budgets (`budgets[]`: dollars `spent` of `limit`, `coverage`, `models`,
//! `resetsAt`) of the Console workspace OpenCode is signed in to, and
//! `data: null` when it is not signed in. OpenCode resolves its own sign-in:
//! nothing here opens its `auth.json` or calls an OpenCode endpoint.
//!
//! The runtime's `opencode acp` keeps its server private, so a read starts
//! `opencode serve` on a loopback port with a one-time password, asks it, and
//! kills it. Go windows answer for `opencode-go/*` models and Console budgets
//! for OpenCode Zen (`opencode/*`); a model OpenCode routes to any other
//! provider draws on no OpenCode quota and reads nothing.
//!
//! OpenCode releases before 2.2.0 have no such route. There the only answer
//! is the OpenCode Go usage endpoint, asked with the key OpenCode stored for
//! its `opencode-go` provider, so that key is read only under the owner's
//! per-machine [`SignInReadGrant`] (`super::grant`). Without one nothing is
//! opened and the quota is unknown; on 2.2.0 and later the grant is never
//! used and no credential is read.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

use super::cli::{self, CliVersion};
use super::grant::{GrantMatch, GrantedRead, SignInReadGrant};
use super::windows::percent_window;
use crate::fields::{first_f64, first_string};
use crate::host::{home_dir_path, provider_client};
use crate::usage::{LlmQuotaUsage, LlmUsage};

/// First OpenCode release whose server has `/api/experimental/usage/limits`.
/// Before it, OpenCode's quota is read only under a grant.
pub const MIN_USAGE_LIMITS_CLI_VERSION: CliVersion = (2, 2, 0);
/// OpenCode Go's usage endpoint, asked with OpenCode's stored Go key on a
/// release before [`MIN_USAGE_LIMITS_CLI_VERSION`].
const OPENCODE_GO_USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";
/// `opencode serve` listened within about a second (2.4.1); the daemon's probe
/// gives one target 5 s.
const OPENCODE_USAGE_TIMEOUT: Duration = Duration::from_millis(4_500);
const USAGE_LIMITS_PATH: &str = "/api/experimental/usage/limits";
/// The user `opencode serve` checks `OPENCODE_SERVER_PASSWORD` against.
const SERVER_USER: &str = "opencode";
/// The listening line comes first; bound what the reader waits through.
const MAX_SERVE_STDOUT_BYTES: u64 = 64 * 1024;
const FRESH_TTL: Duration = Duration::from_secs(180);
const ERROR_TTL: Duration = Duration::from_secs(60);

/// Which account an OpenCode model draws on, from its `provider/model` id.
#[derive(Debug, PartialEq, Eq)]
enum OpenCodeQuotaSource {
    /// OpenCode Go (`opencode-go/*`): the Go allowance.
    Go,
    /// OpenCode Zen (`opencode/*`): the Console budgets covering the model.
    Zen { model: String },
    /// The model is not known yet: the Go allowance, if any.
    Unknown,
    /// Another provider (an API key, a ChatGPT or Claude login): no OpenCode
    /// quota applies.
    None,
}

fn opencode_quota_source(model: Option<&str>) -> OpenCodeQuotaSource {
    let Some(model) = model.map(str::trim).filter(|model| !model.is_empty()) else {
        return OpenCodeQuotaSource::Unknown;
    };
    let Some((provider, id)) = model.split_once('/') else {
        return OpenCodeQuotaSource::Unknown;
    };
    match provider.to_ascii_lowercase().as_str() {
        "opencode-go" => OpenCodeQuotaSource::Go,
        "opencode" => OpenCodeQuotaSource::Zen {
            model: id.to_string(),
        },
        _ => OpenCodeQuotaSource::None,
    }
}

/// The account quota behind the model OpenCode is running, asked of
/// `opencode serve`. Never reads a credential: on a release before
/// [`MIN_USAGE_LIMITS_CLI_VERSION`] it has no answer
/// ([`read_opencode_usage_granted`] reads one under a grant).
pub async fn read_opencode_usage_for_model(force: bool, model: Option<&str>) -> Option<LlmUsage> {
    let source = opencode_quota_source(model);
    if source == OpenCodeQuotaSource::None || super::quota_probes_disabled() {
        return None;
    }
    let program = resolve_opencode_program()?;
    official_usage(&program, home_dir_path().as_deref(), force, source).await
}

/// The OpenCode Go allowance of the workspace OpenCode is signed in to.
pub async fn read_opencode_go_usage(force: bool) -> Option<LlmUsage> {
    read_opencode_usage_for_model(force, None).await
}

async fn official_usage(
    program: &Path,
    home: Option<&Path>,
    force: bool,
    source: OpenCodeQuotaSource,
) -> Option<LlmUsage> {
    let limits = read_opencode_usage_limits(program, home, force).await?;
    match source {
        OpenCodeQuotaSource::Go | OpenCodeQuotaSource::Unknown => {
            opencode_go_usage_from_limits(&limits)
        }
        OpenCodeQuotaSource::Zen { model } => opencode_budget_usage_from_limits(&limits, &model),
        OpenCodeQuotaSource::None => None,
    }
}

/// Whether reading OpenCode's quota needs the owner's grant at `version`:
/// a known release before [`MIN_USAGE_LIMITS_CLI_VERSION`].
pub fn needs_sign_in_grant(version: Option<CliVersion>) -> bool {
    version.is_some_and(|version| version < MIN_USAGE_LIMITS_CLI_VERSION)
}

/// The account quota behind the model OpenCode is running, under the
/// owner's grant to read OpenCode's sign-in on this machine.
///
/// On OpenCode 2.2.0 and later this asks `opencode serve` and ignores the
/// grant. On an earlier release it reads OpenCode's stored Go key only with a
/// grant ([`GrantedRead::Closed`] without one), and uses it for one request
/// to the Go usage endpoint and nothing else.
pub async fn read_opencode_usage_granted(
    force: bool,
    model: Option<&str>,
    grant: Option<&SignInReadGrant>,
) -> GrantedRead {
    let program = resolve_opencode_program();
    let home = home_dir_path();
    read_opencode_usage_granted_with(
        force,
        model,
        grant,
        program.as_deref(),
        home.as_deref(),
        &LocalOpenCodeSignIn {
            dirs: opencode_auth_dirs(),
        },
        OPENCODE_GO_USAGE_URL,
    )
    .await
}

async fn read_opencode_usage_granted_with(
    force: bool,
    model: Option<&str>,
    grant: Option<&SignInReadGrant>,
    program: Option<&Path>,
    home: Option<&Path>,
    sign_in: &dyn OpenCodeSignIn,
    go_endpoint: &str,
) -> GrantedRead {
    if super::quota_probes_disabled() {
        return GrantedRead::Closed;
    }
    let nothing = || GrantedRead::Read {
        usage: None,
        bound: None,
    };
    let source = opencode_quota_source(model);
    let Some(program) = program.filter(|_| source != OpenCodeQuotaSource::None) else {
        return nothing();
    };
    let version = cli::cli_version(program, home).await;
    if !needs_sign_in_grant(version) {
        return match version {
            Some(_) => GrantedRead::Read {
                usage: official_usage(program, home, force, source).await,
                bound: None,
            },
            // An unreadable release is asked nothing and read nothing.
            None => nothing(),
        };
    }
    let Some(grant) = grant else {
        return GrantedRead::Closed;
    };
    // The Go endpoint answers for the Go allowance only: a Zen model's
    // Console budgets are not there, so no sign-in is read for one.
    if matches!(source, OpenCodeQuotaSource::Zen { .. }) {
        return nothing();
    }
    read_go_usage_under_grant(force, grant, sign_in, go_endpoint).await
}

/// The key OpenCode stored for its `opencode-go` provider, as it stands.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum GoSignIn {
    Key(String),
    /// A token whose `expires` has passed. It is never refreshed on
    /// OpenCode's behalf: that would rotate a credential OpenCode owns.
    Expired,
}

/// Where OpenCode keeps its Go sign-in. Every credential source this reader
/// can open sits behind this one call, so a read that never makes it opened
/// none of them.
pub(crate) trait OpenCodeSignIn: Sync {
    fn go_sign_in(&self) -> Option<GoSignIn>;
}

/// OpenCode's own Go sign-in on this machine: `OPENCODE_API_KEY`, then the
/// `opencode-go` entry of its `auth.json`.
struct LocalOpenCodeSignIn {
    dirs: Vec<PathBuf>,
}

impl OpenCodeSignIn for LocalOpenCodeSignIn {
    fn go_sign_in(&self) -> Option<GoSignIn> {
        if let Ok(key) = std::env::var("OPENCODE_API_KEY")
            && !key.trim().is_empty()
        {
            return Some(GoSignIn::Key(key.trim().to_string()));
        }
        self.dirs.iter().find_map(|dir| {
            let raw = std::fs::read_to_string(dir.join("auth.json")).ok()?;
            let value: Value = serde_json::from_str(&raw).ok()?;
            go_sign_in_from_auth(&value, now_unix_ms())
        })
    }
}

/// Candidate OpenCode data directories in precedence order: the XDG data
/// root on Linux and Windows, Application Support on macOS.
fn opencode_auth_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
        dirs.push(PathBuf::from(xdg).join("opencode"));
    }
    if let Some(home) = home_dir_path() {
        dirs.push(home.join(".local").join("share").join("opencode"));
        dirs.push(
            home.join("Library")
                .join("Application Support")
                .join("opencode"),
        );
        dirs.push(home.join("AppData").join("Roaming").join("opencode"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("opencode"));
    }
    dirs
}

fn now_unix_ms() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

/// The `opencode-go` entry of an `auth.json`: an API key, or an access token
/// unless its `expires` (Unix milliseconds) has passed.
fn go_sign_in_from_auth(value: &Value, now_ms: i64) -> Option<GoSignIn> {
    let entry = value.as_object()?.get("opencode-go")?.as_object()?;
    let token = first_string(entry, &["key", "apiKey", "api_key", "access", "token"])?;
    if entry
        .get("expires")
        .and_then(Value::as_i64)
        .is_some_and(|expires| expires <= now_ms)
    {
        return Some(GoSignIn::Expired);
    }
    Some(GoSignIn::Key(token))
}

async fn read_go_usage_under_grant(
    force: bool,
    grant: &SignInReadGrant,
    sign_in: &dyn OpenCodeSignIn,
    endpoint: &str,
) -> GrantedRead {
    let cache = super::cache::account_meter_cache(super::cache::AccountMeter::OpenCode);
    let token = match sign_in.go_sign_in() {
        // Signed out: nothing to bind and nothing to ask.
        None => {
            return GrantedRead::Read {
                usage: cache.unavailable(),
                bound: None,
            };
        }
        Some(GoSignIn::Expired) => {
            cache.clear();
            return GrantedRead::SignInExpired;
        }
        Some(GoSignIn::Key(token)) => token,
    };
    let bound = match super::grant::match_grant(grant, &token) {
        GrantMatch::Same { bound } => bound,
        GrantMatch::Changed => {
            // Another account's reading must not outlive the grant.
            cache.clear();
            return GrantedRead::SignInChanged;
        }
    };
    // A first read under a new grant asks afresh: the cache may hold a
    // reading of the sign-in a voided grant was bound to.
    if let Some(cached) = cache.hit_unless_forced(force || bound.is_some()) {
        return GrantedRead::Read {
            usage: cached,
            bound,
        };
    }
    let Some(value) = cache
        .fetch_json(
            "opencode",
            provider_client()
                .get(endpoint)
                .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
                .header(reqwest::header::ACCEPT, "application/json")
                .header(reqwest::header::USER_AGENT, "xmatrix/opencode"),
        )
        .await
    else {
        return GrantedRead::Read { usage: None, bound };
    };
    let usage = opencode_go_usage_from_value(&value);
    cache.store(usage.clone());
    GrantedRead::Read { usage, bound }
}

/// The Go endpoint's `usage.rolling` / `weekly` / `monthly` meters as 5h, 1w
/// and 1mo windows; a meter whose `status` is not `ok` is used up.
pub(crate) fn opencode_go_usage_from_value(value: &Value) -> Option<LlmUsage> {
    let payload = value
        .get("usage")
        .and_then(Value::as_object)
        .or_else(|| value.as_object())?;
    let quotas = [("rolling", "5h"), ("weekly", "1w"), ("monthly", "1mo")]
        .into_iter()
        .filter_map(|(field, label)| {
            let entry = payload.get(field).and_then(Value::as_object)?;
            let percent = first_f64(
                entry,
                &[
                    "percent",
                    "usedPercent",
                    "used_percent",
                    "usagePercent",
                    "usage_percent",
                ],
            )?;
            let exhausted = first_string(entry, &["status"])
                .is_some_and(|status| !status.eq_ignore_ascii_case("ok"))
                || percent >= 100.0;
            Some(percent_window(
                label,
                "opencode",
                percent,
                exhausted,
                first_string(entry, &["resetsAt", "resets_at", "resetAt", "reset_at"]),
            ))
        })
        .collect();
    super::observed_provider_quotas(quotas)
}

/// The last answer (`data`, `None` for a failed read) and when it was taken.
/// Holding the lock across a read makes concurrent readers share one server.
static OPENCODE_LIMITS: tokio::sync::Mutex<Option<(Instant, Option<Value>)>> =
    tokio::sync::Mutex::const_new(None);

async fn read_opencode_usage_limits(
    program: &Path,
    home: Option<&Path>,
    force: bool,
) -> Option<Value> {
    if super::quota_probes_disabled() {
        return None;
    }
    let mut cached = OPENCODE_LIMITS.lock().await;
    if !force
        && let Some((taken, limits)) = cached.as_ref()
        && taken.elapsed()
            < if limits.is_some() {
                FRESH_TTL
            } else {
                ERROR_TTL
            }
    {
        return limits.clone();
    }
    let limits = ask_opencode_serve(program, home, OPENCODE_USAGE_TIMEOUT).await;
    *cached = Some((Instant::now(), limits.clone()));
    limits
}

/// The `opencode` a spawn resolves: `PATH`, then the installer's
/// `~/.opencode/bin`.
fn resolve_opencode_program() -> Option<PathBuf> {
    let fallbacks: Vec<PathBuf> = home_dir_path()
        .map(|home| vec![home.join(".opencode").join("bin").join("opencode")])
        .unwrap_or_default();
    cli::resolve_program("opencode", &fallbacks)
}

/// A password for one short-lived loopback server, from the process's
/// OS-seeded hasher keys.
fn one_time_password() -> String {
    use std::hash::{BuildHasher, Hasher};
    (0..2)
        .map(|_| {
            let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
            hasher.write_u128(Instant::now().elapsed().as_nanos());
            format!("{:016x}", hasher.finish())
        })
        .collect()
}

fn opencode_serve_command(
    program: &Path,
    home: Option<&Path>,
    password: &str,
) -> tokio::process::Command {
    let mut command = cli::probe_command(program, home);
    command
        .args(["serve", "--hostname", "127.0.0.1", "--port", "0"])
        .env("OPENCODE_SERVER_PASSWORD", password)
        .stderr(std::process::Stdio::null());
    command
}

/// The loopback URL `opencode serve` says it listens on
/// (`Server listening on http://127.0.0.1:46193`).
fn opencode_listening_url(line: &str) -> Option<String> {
    let start = line.find("http://127.0.0.1:")?;
    let url: String = line[start..]
        .chars()
        .take_while(|ch| !ch.is_whitespace())
        .collect();
    let port = url.strip_prefix("http://127.0.0.1:")?;
    (!port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit())).then_some(url)
}

/// Start `opencode serve` on a loopback port, ask it for the usage limits,
/// and kill it, all within `timeout`. `Some(Value::Null)` is OpenCode saying
/// it is not signed in; `None` is a failed read. A release older than
/// [`MIN_USAGE_LIMITS_CLI_VERSION`] is never started.
async fn ask_opencode_serve(
    program: &Path,
    home: Option<&Path>,
    timeout: Duration,
) -> Option<Value> {
    if !cli::cli_at_least(program, home, MIN_USAGE_LIMITS_CLI_VERSION, "OpenCode").await {
        return None;
    }
    let password = one_time_password();
    let mut child = opencode_serve_command(program, home, &password)
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let exchange = async {
        let mut lines = BufReader::new(stdout.take(MAX_SERVE_STDOUT_BYTES)).lines();
        let url = loop {
            let line = lines.next_line().await.ok()??;
            if let Some(url) = opencode_listening_url(&line) {
                break url;
            }
        };
        let response = provider_client()
            .get(format!("{url}{USAGE_LIMITS_PATH}"))
            .basic_auth(SERVER_USER, Some(&password))
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let body: Value = response.json().await.ok()?;
        body.get("data").cloned()
    };
    let limits = tokio::time::timeout(timeout, exchange).await.ok().flatten();
    let _ = child.start_kill();
    let _ = child.wait().await;
    limits
}

/// Unix milliseconds as RFC 3339.
fn reset_from_millis(value: Option<&Value>) -> Option<String> {
    let millis = value?.as_f64().filter(|millis| millis.is_finite())?;
    time::OffsetDateTime::from_unix_timestamp_nanos((millis * 1_000_000.0) as i128)
        .ok()?
        .format(&time::format_description::well_known::Rfc3339)
        .ok()
}

/// The Go allowance as 5h (`rolling`), 1w and 1mo windows; a window OpenCode
/// marks `limited` is used up whatever its percent says.
pub(crate) fn opencode_go_usage_from_limits(limits: &Value) -> Option<LlmUsage> {
    let go = limits.get("go")?;
    let quotas = [("rolling", "5h"), ("weekly", "1w"), ("monthly", "1mo")]
        .into_iter()
        .filter_map(|(field, label)| {
            let meter = go.get(field)?;
            let percent = meter.get("percent").and_then(Value::as_f64)?;
            let limited = meter.get("limited").and_then(Value::as_bool) == Some(true);
            Some(percent_window(
                label,
                "opencode",
                percent,
                limited || percent >= 100.0,
                reset_from_millis(meter.get("resetsAt")),
            ))
        })
        .collect();
    super::observed_provider_quotas(quotas)
}

/// Whether a Console budget constrains the Zen model `model`.
fn budget_covers(budget: &Value, model: &str) -> bool {
    match budget.get("coverage").and_then(Value::as_str) {
        Some("all") => true,
        Some("models") => budget
            .get("models")
            .and_then(Value::as_array)
            .is_some_and(|models| {
                models.iter().any(|entry| {
                    entry.get("providerID").and_then(Value::as_str) == Some("opencode")
                        && entry.get("modelID").and_then(Value::as_str) == Some(model)
                })
            }),
        _ => false,
    }
}

/// The tightest Console budget covering the Zen model `model`, as one
/// `budget` window of dollars spent against the limit.
pub(crate) fn opencode_budget_usage_from_limits(limits: &Value, model: &str) -> Option<LlmUsage> {
    let tightest = limits
        .get("budgets")?
        .as_array()?
        .iter()
        .filter(|budget| budget_covers(budget, model))
        .filter_map(|budget| {
            let limit = budget.get("limit").and_then(Value::as_f64)?;
            let spent = budget.get("spent").and_then(Value::as_f64)?;
            (limit > 0.0 && spent.is_finite()).then_some((budget, spent, limit))
        })
        .max_by(|(_, a_spent, a_limit), (_, b_spent, b_limit)| {
            (a_spent / a_limit).total_cmp(&(b_spent / b_limit))
        })?;
    let (budget, spent, limit) = tightest;
    super::observed_provider_quotas(vec![LlmQuotaUsage {
        label: Some("budget".to_string()),
        window: Some("opencode".to_string()),
        used: Some(spent),
        limit: Some(limit),
        remaining: Some((limit - spent).max(0.0)),
        percent: super::windows::normalized_quota_percent(None, Some(spent), Some(limit)),
        reset_at: reset_from_millis(budget.get("resetsAt")),
        scope: None,
    }])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `GET /api/experimental/usage/limits` `data` as the OpenCode 2.4 schema
    /// (`UsageLimits.Info`) describes it.
    fn limits() -> Value {
        serde_json::json!({
            "workspace": { "id": "wrk_1", "usageURL": "https://opencode.ai/wrk_1/activity/overview" },
            "go": {
                "rolling": { "percent": 8, "limited": false, "resetsAt": 1_790_000_000_000_i64 },
                "weekly": { "percent": 100, "limited": true, "resetsAt": 1_790_500_000_000_i64 },
                "monthly": { "percent": 3, "limited": false, "resetsAt": 1_791_000_000_000_i64 }
            },
            "budgets": [
                { "id": "all", "limit": 100, "spent": 20, "scope": "combined", "per": "set",
                  "coverage": "all", "models": [], "vendors": [], "picked": false, "shared": true,
                  "resetsAt": 1_790_000_000_000_i64 },
                { "id": "kimi", "limit": 10, "spent": 9, "scope": "each", "per": "model",
                  "coverage": "models", "vendors": [], "picked": true, "shared": false,
                  "models": [{ "providerID": "opencode", "modelID": "kimi-k2", "name": "Kimi K2" }],
                  "resetsAt": 1_790_100_000_000_i64 }
            ]
        })
    }

    #[test]
    fn the_model_provider_selects_the_quota_account() {
        assert_eq!(
            opencode_quota_source(Some("opencode-go/kimi-k2")),
            OpenCodeQuotaSource::Go
        );
        assert_eq!(
            opencode_quota_source(Some("opencode/kimi-k2")),
            OpenCodeQuotaSource::Zen {
                model: "kimi-k2".into()
            }
        );
        for other in ["openai/gpt-6.1-terra", "anthropic/claude-opus"] {
            assert_eq!(
                opencode_quota_source(Some(other)),
                OpenCodeQuotaSource::None
            );
        }
        assert_eq!(opencode_quota_source(None), OpenCodeQuotaSource::Unknown);
        assert_eq!(
            opencode_quota_source(Some(" ")),
            OpenCodeQuotaSource::Unknown
        );
    }

    #[tokio::test]
    async fn a_model_on_another_provider_reads_no_opencode_quota() {
        assert!(
            read_opencode_usage_for_model(true, Some("openai/gpt-6.1-terra"))
                .await
                .is_none()
        );
    }

    #[test]
    fn go_allowance_maps_to_5h_1w_1mo_windows() {
        let usage = opencode_go_usage_from_limits(&limits()).unwrap();
        assert!(usage.quota_observed_at.is_some());
        let quotas = crate::quota::assert_provider_window_labels(usage, &["5h", "1w", "1mo"]);
        assert_eq!(quotas[0].percent, Some(8.0));
        assert_eq!(quotas[0].remaining, None);
        assert_eq!(quotas[0].reset_at.as_deref(), Some("2026-09-21T14:13:20Z"));
        // `limited` is used up.
        assert_eq!(quotas[1].remaining, Some(0.0));
    }

    #[test]
    fn signed_out_or_go_less_workspaces_have_no_go_reading() {
        assert!(opencode_go_usage_from_limits(&Value::Null).is_none());
        let mut console_only = limits();
        console_only.as_object_mut().unwrap().remove("go");
        assert!(opencode_go_usage_from_limits(&console_only).is_none());
    }

    #[test]
    fn the_tightest_budget_covering_a_zen_model_is_its_window() {
        let kimi = opencode_budget_usage_from_limits(&limits(), "kimi-k2").unwrap();
        let window = &kimi.quota_usages.unwrap()[0];
        assert_eq!(window.label.as_deref(), Some("budget"));
        assert_eq!(window.used, Some(9.0));
        assert_eq!(window.limit, Some(10.0));
        assert_eq!(window.percent, Some(90.0));

        let other = opencode_budget_usage_from_limits(&limits(), "glm-5").unwrap();
        assert_eq!(other.quota_usages.unwrap()[0].percent, Some(20.0));

        let mut unbudgeted = limits();
        unbudgeted["budgets"] = serde_json::json!([]);
        assert!(opencode_budget_usage_from_limits(&unbudgeted, "glm-5").is_none());
    }

    #[test]
    fn the_listening_line_names_a_loopback_port() {
        assert_eq!(
            opencode_listening_url("Server listening on http://127.0.0.1:46193").as_deref(),
            Some("http://127.0.0.1:46193")
        );
        assert_eq!(
            opencode_listening_url("opencode server listening on http://127.0.0.1:4096\n")
                .as_deref(),
            Some("http://127.0.0.1:4096")
        );
        assert_eq!(
            opencode_listening_url("listening on http://0.0.0.0:80"),
            None
        );
        assert_eq!(opencode_listening_url("Warning: unsecured"), None);
    }

    #[test]
    fn the_server_is_loopback_only_and_password_protected() {
        let password = one_time_password();
        assert_eq!(password.len(), 32);
        assert_ne!(password, one_time_password());
        let command = opencode_serve_command(Path::new("opencode"), None, &password);
        let std = command.as_std();
        let args: Vec<_> = std
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args, ["serve", "--hostname", "127.0.0.1", "--port", "0"]);
        assert!(
            std.get_envs()
                .any(|(key, value)| key == "OPENCODE_SERVER_PASSWORD"
                    && value.is_some_and(|value| value == password.as_str()))
        );
    }

    #[cfg(unix)]
    mod fake_cli {
        use super::*;

        fn temp_dir(name: &str) -> PathBuf {
            crate::quota::test_temp_dir("opencode-usage", name)
        }

        /// An `opencode` that prints `version` and, for `serve`, the
        /// listening line of a loopback server answering `body`.
        fn fake_opencode(dir: &Path, version: &str, port: u16) -> PathBuf {
            let marker = dir.join("served");
            let script = format!(
                r#"#!/bin/sh
if [ "$1" = "--version" ]; then echo "opencode v{version}"; exit 0; fi
if [ "$1" = "serve" ] && [ -n "$OPENCODE_SERVER_PASSWORD" ]; then
  echo served > "{marker}"
  echo "Server listening on http://127.0.0.1:{port}"
  sleep 30
fi
exit 2
"#,
                marker = marker.display()
            );
            let path = dir.join("opencode");
            crate::quota::write_test_executable(&path, &script);
            path
        }

        #[tokio::test]
        async fn serve_is_asked_with_its_password_and_killed() {
            use std::io::Write;
            let dir = temp_dir("serve");
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            let program = fake_opencode(&dir, "2.4.1", port);
            let server = std::thread::spawn(move || {
                let (mut stream, request) =
                    crate::quota::read_fixture_http_request(&listener, "no usage request");
                let body =
                    serde_json::json!({ "location": { "directory": "/" }, "data": limits() })
                        .to_string();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
                request
            });
            let data = ask_opencode_serve(&program, Some(&dir), Duration::from_secs(10))
                .await
                .expect("usage limits");
            let request = server.join().unwrap();
            assert!(
                request.starts_with("get /api/experimental/usage/limits "),
                "{request}"
            );
            assert!(request.contains("authorization: basic "), "{request}");
            assert!(opencode_go_usage_from_limits(&data).is_some());
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[tokio::test]
        async fn an_opencode_without_the_usage_route_is_never_served() {
            let dir = temp_dir("old");
            let program = fake_opencode(&dir, "1.19.6", 9);
            assert!(
                ask_opencode_serve(&program, Some(&dir), Duration::from_secs(10))
                    .await
                    .is_none()
            );
            assert!(!dir.join("served").exists());
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// OpenCode's `auth.json` is a FIFO here: opening it for reading
        /// blocks until a writer appears, so a reader that touched it would
        /// never return.
        #[test]
        fn a_read_opens_no_opencode_credential() {
            let dir = temp_dir("no-credentials");
            let program = fake_opencode(&dir, "2.4.1", 9);
            let home = dir.clone();
            crate::quota::read_beside_fifos(
                &[dir
                    .join(".local")
                    .join("share")
                    .join("opencode")
                    .join("auth.json")],
                async move { ask_opencode_serve(&program, Some(&home), Duration::from_secs(5)).await },
            );
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// An endpoint nothing listens on: reaching it would be a request to OpenCode.
        const NO_PROVIDER: &str = "http://127.0.0.1:9/never";

        fn auth_dir(dir: &Path) -> PathBuf {
            dir.join(".local").join("share").join("opencode")
        }

        fn local_sign_in(dir: &Path) -> LocalOpenCodeSignIn {
            LocalOpenCodeSignIn {
                dirs: vec![auth_dir(dir)],
            }
        }

        /// OpenCode 1.x without a grant: its `auth.json` (a FIFO) is never
        /// opened and the Go endpoint never asked.
        #[test]
        fn before_2_2_without_a_grant_no_credential_is_opened() {
            let dir = temp_dir("closed");
            let program = fake_opencode(&dir, "1.19.6", 9);
            let home = dir.clone();
            let read =
                crate::quota::read_beside_fifos(&[auth_dir(&dir).join("auth.json")], async move {
                    read_opencode_usage_granted_with(
                        true,
                        Some("opencode-go/kimi-k2"),
                        None,
                        Some(&program),
                        Some(&home),
                        &local_sign_in(&home),
                        NO_PROVIDER,
                    )
                    .await
                });
            assert!(matches!(read, GrantedRead::Closed), "{read:?}");
            assert!(!dir.join("served").exists());
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// From 2.2.0 OpenCode answers for itself: a grant reads nothing.
        #[test]
        fn from_2_2_a_grant_opens_no_credential() {
            let dir = temp_dir("official");
            let program = fake_opencode(&dir, "2.4.1", 9);
            let home = dir.clone();
            let read =
                crate::quota::read_beside_fifos(&[auth_dir(&dir).join("auth.json")], async move {
                    let grant = SignInReadGrant::new("grant-key");
                    read_opencode_usage_granted_with(
                        true,
                        None,
                        Some(&grant),
                        Some(&program),
                        Some(&home),
                        &local_sign_in(&home),
                        NO_PROVIDER,
                    )
                    .await
                });
            assert!(
                matches!(read, GrantedRead::Read { bound: None, .. }),
                "{read:?}"
            );
            assert!(dir.join("served").exists(), "opencode serve was asked");
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[tokio::test]
        async fn before_2_2_under_a_grant_the_key_reaches_only_the_go_request() {
            use std::io::Write;
            const KEY: &str = "sentinel-opencode-go-key";
            const OTHER: &str = "sentinel-openai-access-token";
            let dir = temp_dir("granted");
            let program = fake_opencode(&dir, "1.19.6", 9);
            std::fs::create_dir_all(auth_dir(&dir)).unwrap();
            std::fs::write(
                auth_dir(&dir).join("auth.json"),
                serde_json::json!({
                    "opencode-go": { "type": "api", "key": KEY },
                    "openai": { "type": "oauth", "access": OTHER, "refresh": "sentinel-refresh",
                                "expires": i64::MAX, "accountId": "sentinel-account" }
                })
                .to_string(),
            )
            .unwrap();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let endpoint = format!("http://{}/zen/go/v1/usage", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut stream, request) =
                    crate::quota::read_fixture_http_request(&listener, "no Go usage request");
                let body = serde_json::json!({ "usage": {
                    "rolling": { "status": "ok", "percent": 8, "resetsAt": "2026-09-21T12:25:57Z" },
                    "weekly": { "status": "ok", "percent": 30, "resetsAt": "2026-09-28T00:00:00Z" },
                    "monthly": { "status": "exceeded", "percent": 100, "resetsAt": "2026-10-14T20:57:54Z" }
                }})
                .to_string();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
                request
            });
            let grant = SignInReadGrant::new("sentinel-grant-key");
            let read = read_opencode_usage_granted_with(
                true,
                Some("opencode-go/kimi-k2"),
                Some(&grant),
                Some(&program),
                Some(&dir),
                &local_sign_in(&dir),
                &endpoint,
            )
            .await;
            let request = server.join().unwrap();
            assert!(request.starts_with("get /zen/go/v1/usage "), "{request}");
            assert!(
                request.contains(&format!("authorization: bearer {KEY}\r\n")),
                "{request}"
            );
            assert!(!request.contains(OTHER), "{request}");
            let GrantedRead::Read {
                usage: Some(usage),
                bound: Some(bound),
            } = read
            else {
                panic!("a first read under a grant reads and binds: {read:?}");
            };
            // The reading is all the daemon reports to the Hub; the binding
            // stays in local config.
            crate::quota::assert_reading_holds_nothing_of_the_login(
                &usage,
                &auth_dir(&dir),
                &[
                    KEY,
                    OTHER,
                    "sentinel-refresh",
                    "sentinel-account",
                    "sentinel-grant-key",
                    bound.as_str(),
                ],
            );
            assert!(!bound.contains(KEY));
            let quotas = crate::quota::assert_provider_window_labels(usage, &["5h", "1w", "1mo"]);
            assert_eq!(quotas[0].percent, Some(8.0));
            assert_eq!(quotas[2].remaining, Some(0.0));
            assert!(!dir.join("served").exists(), "1.x is never served");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// A Go sign-in for the gate tests that need no OpenCode binary.
    struct FixedSignIn(Option<GoSignIn>);

    impl OpenCodeSignIn for FixedSignIn {
        fn go_sign_in(&self) -> Option<GoSignIn> {
            match &self.0 {
                Some(GoSignIn::Key(key)) => Some(GoSignIn::Key(key.clone())),
                Some(GoSignIn::Expired) => Some(GoSignIn::Expired),
                None => None,
            }
        }
    }

    const NO_GO_ENDPOINT: &str = "http://127.0.0.1:9/never";

    #[tokio::test]
    async fn an_expired_sign_in_is_neither_refreshed_nor_used() {
        let grant = SignInReadGrant::new("grant-key");
        let read = read_go_usage_under_grant(
            true,
            &grant,
            &FixedSignIn(Some(GoSignIn::Expired)),
            NO_GO_ENDPOINT,
        )
        .await;
        assert!(matches!(read, GrantedRead::SignInExpired), "{read:?}");
    }

    #[tokio::test]
    async fn another_sign_in_voids_the_grant_without_asking_opencode() {
        let grant = SignInReadGrant {
            sign_in: Some(crate::quota::grant::sign_in_fingerprint(
                "grant-key",
                "the-granted-go-key",
            )),
            ..SignInReadGrant::new("grant-key")
        };
        let other = FixedSignIn(Some(GoSignIn::Key("another-go-key".into())));
        let read = read_go_usage_under_grant(false, &grant, &other, NO_GO_ENDPOINT).await;
        assert!(matches!(read, GrantedRead::SignInChanged), "{read:?}");
    }

    #[test]
    fn the_go_entry_is_a_key_or_an_unexpired_token() {
        let key = serde_json::json!({ "opencode-go": { "type": "api", "key": "k" } });
        assert_eq!(
            go_sign_in_from_auth(&key, 0),
            Some(GoSignIn::Key("k".into()))
        );
        let token = serde_json::json!({ "opencode-go": { "type": "oauth", "access": "t", "expires": 2_000 } });
        assert_eq!(
            go_sign_in_from_auth(&token, 1_000),
            Some(GoSignIn::Key("t".into()))
        );
        assert_eq!(go_sign_in_from_auth(&token, 2_000), Some(GoSignIn::Expired));
        let other = serde_json::json!({ "openai": { "type": "oauth", "access": "t" } });
        assert_eq!(go_sign_in_from_auth(&other, 0), None);
    }

    #[test]
    fn the_go_endpoint_maps_to_5h_1w_1mo_windows() {
        let usage = opencode_go_usage_from_value(&serde_json::json!({ "usage": {
            "rolling": { "status": "ok", "percent": 8, "resetsAt": "2026-09-21T12:25:57.573Z" },
            "weekly": { "status": "exceeded", "percent": 40 }
        }}))
        .unwrap();
        let quotas = crate::quota::assert_provider_window_labels(usage, &["5h", "1w"]);
        assert_eq!(quotas[0].percent, Some(8.0));
        assert_eq!(quotas[1].remaining, Some(0.0));
        assert!(opencode_go_usage_from_value(&serde_json::json!({})).is_none());
    }

    #[test]
    fn only_releases_before_2_2_need_a_grant() {
        assert!(needs_sign_in_grant(Some((1, 19, 6))));
        assert!(needs_sign_in_grant(Some((2, 1, 9))));
        assert!(!needs_sign_in_grant(Some((2, 2, 0))));
        assert!(!needs_sign_in_grant(None));
    }

    /// The installed `opencode` (or `XMATRIX_LIVE_OPENCODE`) serves the usage
    /// limits route: `data` is null when it is not signed in.
    #[tokio::test]
    async fn live_e2e_opencode_usage_limits() {
        if std::env::var("XMATRIX_LIVE_QUOTA_E2E").ok().as_deref() != Some("1") {
            eprintln!("skip live e2e (set XMATRIX_LIVE_QUOTA_E2E=1)");
            return;
        }
        let program = std::env::var_os("XMATRIX_LIVE_OPENCODE")
            .map(PathBuf::from)
            .or_else(resolve_opencode_program)
            .expect("an opencode binary");
        let home = home_dir_path();
        let data = ask_opencode_serve(&program, home.as_deref(), OPENCODE_USAGE_TIMEOUT)
            .await
            .expect("opencode serve answered");
        eprintln!(
            "LIVE_E2E_OK opencode signed_in={} go={:?}",
            !data.is_null(),
            opencode_go_usage_from_limits(&data).and_then(|usage| usage.quota_usages)
        );
    }
}
