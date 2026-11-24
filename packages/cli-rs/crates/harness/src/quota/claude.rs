//! Claude subscription quota, asked of Claude Code itself.
//!
//! Claude Code answers the stream-json control request `get_usage` with its
//! `/usage` data: `rate_limits_available`, and `rate_limits` holding the 5h
//! (`five_hour`) and 1w (`seven_day`) account windows, each model's own weekly
//! window (`model_scoped`), and `extra_usage`. `skip_behaviors` leaves out the
//! scan of local transcripts that only the `/usage` dialog needs. The request
//! sends no prompt and starts no turn, and Claude Code reads its own sign-in
//! (keychain, credentials file, token variables) itself: nothing here opens a
//! Claude credential or calls an Anthropic endpoint.
//!
//! A running session is asked over its own stdin (the runtime passes its
//! exchange to [`read_claude_usage_with`]); otherwise a `claude -p` stream-json
//! process is started, asked, and killed. Every request also returns Claude
//! Code's `rate_limit_event` verdict, which stands in for a reading while fresh.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use super::cache::KeyedProviderUsageCache;
use super::cli::{self, CliVersion};
use super::windows::normalized_quota_percent;
use crate::host::home_dir_path;
use crate::usage::{LlmQuotaAccount, LlmQuotaCredits, LlmQuotaUsage, LlmUsage};

/// Environment that makes a Claude Code spawn bill something other than the
/// default login (a token, an API key, a gateway, a relocated config dir).
pub const CLAUDE_LOGIN_OVERRIDE_KEYS: &[&str] = &[
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
];

/// First Claude Code release whose `get_usage` takes `skip_behaviors`
/// (Agent SDK 0.3.261 ships it with Claude Code 2.1.261).
const MIN_GET_USAGE_CLI_VERSION: CliVersion = (2, 1, 261);
/// A spawned `claude` answered in about 2 s (2.1.331); the daemon's probe
/// gives one target 5 s.
const CLAUDE_USAGE_TIMEOUT: Duration = Duration::from_millis(4_500);
/// The answer is one line of a few KiB; bound what a misbehaving binary can
/// make the reader buffer.
const MAX_USAGE_STDOUT_BYTES: u64 = 4 * 1024 * 1024;

/// Readings per login (this process's, or the default one), 3 min fresh and a
/// failure retried after 1 min.
static CLAUDE_USAGE: KeyedProviderUsageCache =
    KeyedProviderUsageCache::new(Duration::from_secs(180), Duration::from_secs(60));

/// How long Claude Code's own verdict stands in for a `get_usage` reading.
const CLAUDE_RATE_LIMIT_VERDICT_TTL: Duration = Duration::from_secs(10 * 60);

/// The quota Claude Code was told on this process's latest request.
static CLAUDE_RATE_LIMIT_VERDICT: std::sync::Mutex<Option<(std::time::Instant, LlmUsage)>> =
    std::sync::Mutex::new(None);

/// Claude Code's `rate_limit_event` as a partial reading: the account windows
/// of `unifiedWindows` only, never a model's own limit.
///
/// Every request returns Anthropic's verdict (`allowed`, `allowed_warning`,
/// `rejected`) and both account windows' utilization as a fraction. A
/// `get_usage` reading rounds to whole percents and carries no verdict, so an
/// account at 99.6% that Anthropic still serves would read as 100% and show as
/// a hard limit (2026-10-05). `isUsingOverage` means the account is being
/// served past its windows on extra usage.
///
/// A `rejected` verdict states no account state: it may refuse one model
/// (`seven_day_fable`) while the account serves every other, and only a
/// `get_usage` reading says which limit it was.
pub(crate) fn claude_rate_limit_event_usage(value: &Value) -> Option<LlmUsage> {
    if value.get("type").and_then(Value::as_str) != Some("rate_limit_event") {
        return None;
    }
    let info = value.get("rate_limit_info")?;
    let status = info.get("status").and_then(Value::as_str)?;
    let windows = info.get("unifiedWindows").and_then(Value::as_object)?;
    let quotas: Vec<LlmQuotaUsage> = [("five_hour", "5h"), ("seven_day", "1w")]
        .into_iter()
        .filter_map(|(key, label)| {
            let window = windows.get(key)?;
            let fraction = window.get("utilization").and_then(Value::as_f64)?;
            Some(LlmQuotaUsage {
                label: Some(label.to_string()),
                window: Some("claude".to_string()),
                percent: normalized_quota_percent(Some(fraction * 100.0), None, None),
                reset_at: claude_resets_at(window),
                ..LlmQuotaUsage::default()
            })
        })
        .collect();
    if quotas.is_empty() {
        return None;
    }
    let on_overage = info.get("isUsingOverage").and_then(Value::as_bool) == Some(true);
    Some(LlmUsage {
        quota_source: Some("provider_api".to_string()),
        quota_observed_at: super::observed_now(),
        quota_usages: Some(quotas),
        quota_account: (status != "rejected").then(|| LlmQuotaAccount {
            allowed: Some(true),
            credits: on_overage.then(LlmQuotaCredits::default),
        }),
        ..LlmUsage::default()
    })
}

/// A rate-limit verdict's `resetsAt` (Unix seconds) as RFC 3339.
pub fn claude_resets_at(value: &Value) -> Option<String> {
    let secs = value.get("resetsAt").and_then(Value::as_i64)?;
    time::OffsetDateTime::from_unix_timestamp(secs)
        .ok()?
        .format(&time::format_description::well_known::Rfc3339)
        .ok()
}

/// Keep a `rate_limit_event` as this process's account quota; returns it.
pub fn record_claude_rate_limit_event(value: &Value) -> Option<LlmUsage> {
    let usage = claude_rate_limit_event_usage(value)?;
    if let Ok(mut verdict) = CLAUDE_RATE_LIMIT_VERDICT.lock() {
        *verdict = Some((std::time::Instant::now(), usage.clone()));
    }
    Some(usage)
}

fn fresh_claude_rate_limit_verdict() -> Option<LlmUsage> {
    let verdict = CLAUDE_RATE_LIMIT_VERDICT.lock().ok()?;
    let (seen, usage) = verdict.as_ref()?;
    (seen.elapsed() < CLAUDE_RATE_LIMIT_VERDICT_TTL).then(|| usage.clone())
}

/// The `get_usage` control request: plan rate limits only. `detached` (a
/// live session) lets later messages pass it; a CLI that does not know it
/// ignores it.
pub fn claude_get_usage_control_request(request_id: &str, detached: bool) -> Value {
    let mut request = serde_json::json!({ "subtype": "get_usage", "skip_behaviors": true });
    if detached {
        request["detached"] = Value::Bool(true);
    }
    serde_json::json!({
        "type": "control_request",
        "request_id": request_id,
        "request": request,
    })
}

/// The answer to the `get_usage` request `request_id`: `Some(Some(report))`
/// on success, `Some(None)` when Claude refused it (an older CLI, a session
/// that cannot answer), `None` for any other frame.
fn claude_get_usage_answer(frame: &Value, request_id: &str) -> Option<Option<Value>> {
    if frame.get("type").and_then(Value::as_str) != Some("control_response") {
        return None;
    }
    let response = frame.get("response")?;
    if response.get("request_id").and_then(Value::as_str) != Some(request_id) {
        return None;
    }
    let success = response.get("subtype").and_then(Value::as_str) == Some("success");
    Some(success.then(|| response.get("response").cloned()).flatten())
}

/// One window of `rate_limits`: `utilization` is a 0-100 percent and
/// `resets_at` an ISO 8601 instant; a window without a utilization is unknown.
fn claude_usage_window(window: &Value, label: &str, scope: Option<&str>) -> Option<LlmQuotaUsage> {
    let percent = normalized_quota_percent(
        window.get("utilization").and_then(Value::as_f64),
        None,
        None,
    )?;
    Some(LlmQuotaUsage {
        label: Some(label.to_string()),
        window: Some("claude".to_string()),
        percent: Some(percent),
        reset_at: window
            .get("resets_at")
            .and_then(Value::as_str)
            .map(str::to_string),
        scope: scope.map(str::to_string),
        ..LlmQuotaUsage::default()
    })
}

/// A `get_usage` answer as a complete reading: `five_hour` is the account's
/// 5h window, `seven_day` its 1w window, and each `model_scoped` row the 1w
/// window of the models its `display_name` names. `model_scoped` absent means
/// Claude knows nothing of them (a cached answer), so the reading states no
/// scoped windows; present and empty, it clears any seen before. Extra usage
/// that is on and not spent marks the account as served past its windows.
///
/// The shape is experimental upstream: every field is optional here, and an
/// answer without a known window is no reading.
pub fn claude_usage_report_from_value(report: &Value) -> Option<LlmUsage> {
    if report.get("rate_limits_available").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let limits = report.get("rate_limits")?.as_object()?;
    let account: Vec<LlmQuotaUsage> = [("five_hour", "5h"), ("seven_day", "1w")]
        .into_iter()
        .filter_map(|(key, label)| claude_usage_window(limits.get(key)?, label, None))
        .collect();
    let scoped: Option<Vec<LlmQuotaUsage>> = limits
        .get("model_scoped")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let scope = row
                        .get("display_name")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|scope| !scope.is_empty())?;
                    claude_usage_window(row, "1w", Some(scope))
                })
                .collect()
        });
    if account.is_empty() && scoped.as_ref().is_none_or(Vec::is_empty) {
        return None;
    }
    let extra = limits.get("extra_usage");
    let extra_usage_serves = extra
        .and_then(|extra| extra.get("is_enabled"))
        .and_then(Value::as_bool)
        == Some(true)
        && extra
            .and_then(|extra| extra.get("utilization"))
            .and_then(Value::as_f64)
            .is_none_or(|spent| spent < 100.0);
    Some(LlmUsage {
        quota_source: Some("provider_api".to_string()),
        quota_observed_at: super::observed_now(),
        quota_usages: (!account.is_empty()).then_some(account),
        scoped_quota_usages: scoped,
        quota_account: extra_usage_serves.then(|| LlmQuotaAccount {
            allowed: None,
            credits: Some(LlmQuotaCredits::default()),
        }),
        ..LlmUsage::default()
    })
}

/// Which login a read stands for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClaudeLogin {
    /// The login this process's environment resolves (a running session's).
    Process,
    /// Claude Code's default login: [`CLAUDE_LOGIN_OVERRIDE_KEYS`] removed.
    DefaultLogin,
}

fn claude_login_key(login: ClaudeLogin, env: &(dyn Fn(&str) -> Option<String> + Sync)) -> String {
    let home = home_dir_path();
    match login {
        ClaudeLogin::DefaultLogin => {
            cli::login_cache_key("default", home.as_deref(), &[], &[], env)
        }
        ClaudeLogin::Process => cli::login_cache_key(
            "process",
            home.as_deref(),
            CLAUDE_LOGIN_OVERRIDE_KEYS,
            &["CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL"],
            env,
        ),
    }
}

fn process_env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// The `claude` a spawn resolves: `PATH`, then the native installer's
/// `~/.local/bin` and the older `~/.claude/local` install.
fn resolve_claude_program() -> Option<PathBuf> {
    let fallbacks: Vec<PathBuf> = home_dir_path()
        .map(|home| {
            vec![
                home.join(".local").join("bin").join("claude"),
                home.join(".claude").join("local").join("claude"),
            ]
        })
        .unwrap_or_default();
    cli::resolve_program("claude", &fallbacks)
}

/// Whether a running Claude Code of the release its `system/init` frame
/// stated (`claude_code_version`) answers `get_usage`. An older or unknown
/// release is logged once and never asked.
pub fn claude_version_answers_get_usage(version: Option<&str>) -> bool {
    cli::version_at_least(
        "a running session",
        version.and_then(cli::parse_cli_semver),
        MIN_GET_USAGE_CLI_VERSION,
        "Claude Code",
    )
}

/// Read this process's Claude quota through `ask`, an exchange that sends
/// [`claude_get_usage_control_request`] to a Claude Code and returns its
/// answer's `response` (a running session's own stdin). `verdict` lets a fresh
/// `rate_limit_event` answer instead; a read after a refusal passes false,
/// since the verdict only repeats the refusal.
pub async fn read_claude_usage_with<F, Fut>(force: bool, verdict: bool, ask: F) -> Option<LlmUsage>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Option<Value>>,
{
    read_claude_usage_as(ClaudeLogin::Process, force, verdict, &process_env, ask).await
}

async fn read_claude_usage_as<F, Fut>(
    login: ClaudeLogin,
    force: bool,
    verdict: bool,
    env: &(dyn Fn(&str) -> Option<String> + Sync),
    ask: F,
) -> Option<LlmUsage>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Option<Value>>,
{
    if super::quota_probes_disabled_in(env) {
        return None;
    }
    if verdict && let Some(verdict) = fresh_claude_rate_limit_verdict() {
        return Some(verdict);
    }
    let key = claude_login_key(login, env);
    if let Some(cached) = CLAUDE_USAGE.hit_unless_forced(&key, force) {
        return cached;
    }
    CLAUDE_USAGE
        .single_flight(&key, || async {
            let usage = ask()
                .await
                .as_ref()
                .and_then(claude_usage_report_from_value);
            // The exchange may outlive a login switch; never file the reading
            // under another login's key.
            if claude_login_key(login, env) == key {
                CLAUDE_USAGE.store(&key, usage.clone());
            }
            usage
        })
        .await
}

/// Claude subscription quota for this process's login: a fresh verdict (when
/// `verdict`), else a briefly started `claude` asked `get_usage`.
pub async fn read_claude_usage(force: bool, verdict: bool) -> Option<LlmUsage> {
    read_claude_usage_with(force, verdict, || ask_spawned_claude(ClaudeLogin::Process)).await
}

/// What this process already knows of its Claude quota, asking nothing: a
/// fresh verdict (when `verdict`), else a current reading.
pub fn known_claude_usage(verdict: bool) -> Option<LlmUsage> {
    if super::quota_probes_disabled() {
        return None;
    }
    if verdict && let Some(verdict) = fresh_claude_rate_limit_verdict() {
        return Some(verdict);
    }
    CLAUDE_USAGE
        .hit(&claude_login_key(ClaudeLogin::Process, &process_env))
        .flatten()
}

/// Claude subscription quota for Claude Code's default login, asked of a
/// `claude` started without [`CLAUDE_LOGIN_OVERRIDE_KEYS`]. It never answers
/// from a rate-limit verdict, and concurrent reads share one process.
///
/// The caller must first prove a spawn of its target resolves this same login
/// (none of [`CLAUDE_LOGIN_OVERRIDE_KEYS`], no HOME override).
pub(crate) async fn read_claude_usage_for_default_account(force: bool) -> Option<LlmUsage> {
    read_claude_usage_as(
        ClaudeLogin::DefaultLogin,
        force,
        false,
        &process_env,
        || ask_spawned_claude(ClaudeLogin::DefaultLogin),
    )
    .await
}

async fn ask_spawned_claude(login: ClaudeLogin) -> Option<Value> {
    let program = resolve_claude_program()?;
    ask_claude_program(
        &program,
        login,
        home_dir_path().as_deref(),
        CLAUDE_USAGE_TIMEOUT,
    )
    .await
}

fn claude_usage_command(
    program: &Path,
    login: ClaudeLogin,
    home: Option<&Path>,
) -> tokio::process::Command {
    let mut command = cli::probe_command(program, home);
    command
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
        ])
        .stdin(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    if login == ClaudeLogin::DefaultLogin {
        for key in CLAUDE_LOGIN_OVERRIDE_KEYS {
            command.env_remove(key);
        }
    }
    command
}

/// Start `program` in stream-json mode, send `get_usage` and nothing else,
/// read the answer, and kill it, all within `timeout`. A release older than
/// [`MIN_GET_USAGE_CLI_VERSION`] is never started.
async fn ask_claude_program(
    program: &Path,
    login: ClaudeLogin,
    home: Option<&Path>,
    timeout: Duration,
) -> Option<Value> {
    static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);
    if !cli::cli_at_least(program, home, MIN_GET_USAGE_CLI_VERSION, "Claude Code").await {
        return None;
    }
    let mut child = claude_usage_command(program, login, home).spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    let request_id = format!(
        "xmatrix-usage-{}",
        NEXT_REQUEST.fetch_add(1, Ordering::Relaxed)
    );
    let exchange = async {
        let mut line =
            serde_json::to_vec(&claude_get_usage_control_request(&request_id, false)).ok()?;
        line.push(b'\n');
        stdin.write_all(&line).await.ok()?;
        stdin.flush().await.ok()?;
        let mut lines = BufReader::new(stdout.take(MAX_USAGE_STDOUT_BYTES)).lines();
        while let Some(line) = lines.next_line().await.ok()? {
            let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some(answer) = claude_get_usage_answer(&frame, &request_id) {
                return answer;
            }
        }
        None
    };
    let answer = tokio::time::timeout(timeout, exchange).await.ok().flatten();
    drop(stdin);
    let _ = child.start_kill();
    let _ = child.wait().await;
    answer
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `get_usage` from Claude Code 2.1.331 on 2026-11-24 (trimmed): Fable's
    /// own week used up while the account's week stood at 79%.
    fn live_get_usage_report() -> Value {
        serde_json::json!({
            "session": { "total_cost_usd": 0 },
            "subscription_type": "max",
            "rate_limits_available": true,
            "rate_limits": {
                "five_hour": { "utilization": 11, "resets_at": "2026-11-24T22:20:00.698101+00:00",
                               "limit_dollars": null, "locked_reason": null },
                "seven_day": { "utilization": 79, "resets_at": "2026-11-26T18:00:00.698159+00:00" },
                "seven_day_oauth_apps": null,
                "seven_day_opus": null,
                "seven_day_sonnet": null,
                "extra_usage": { "is_enabled": false, "monthly_limit": null, "used_credits": null,
                                 "utilization": null, "currency": null },
                "model_scoped": [
                    { "display_name": "Fable", "utilization": 100,
                      "resets_at": "2026-11-26T17:59:59.698381+00:00" }
                ]
            },
            "behaviors": null
        })
    }

    #[test]
    fn get_usage_maps_to_account_and_scoped_windows() {
        let usage = claude_usage_report_from_value(&live_get_usage_report()).unwrap();
        assert!(usage.quota_observed_at.is_some());
        let account = super::super::assert_provider_window_labels(usage.clone(), &["5h", "1w"]);
        assert_eq!(account[0].percent, Some(11.0));
        assert_eq!(account[1].percent, Some(79.0));
        assert_eq!(
            account[1].reset_at.as_deref(),
            Some("2026-11-26T18:00:00.698159+00:00")
        );
        assert!(account.iter().all(|window| window.scope.is_none()));
        let scoped = usage.scoped_quota_usages.unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].label.as_deref(), Some("1w"));
        assert_eq!(scoped[0].scope.as_deref(), Some("Fable"));
        assert_eq!(scoped[0].percent, Some(100.0));
        assert!(usage.quota_account.is_none(), "extra usage is off");
    }

    #[test]
    fn model_scoped_states_completeness_only_when_present() {
        let mut report = live_get_usage_report();
        report["rate_limits"]["model_scoped"] = serde_json::json!([]);
        let cleared = claude_usage_report_from_value(&report).unwrap();
        assert!(
            cleared
                .scoped_quota_usages
                .is_some_and(|scoped| scoped.is_empty())
        );

        report["rate_limits"]
            .as_object_mut()
            .unwrap()
            .remove("model_scoped");
        let unknown = claude_usage_report_from_value(&report).unwrap();
        assert!(unknown.scoped_quota_usages.is_none());
    }

    #[test]
    fn extra_usage_that_still_pays_marks_the_account_served() {
        let mut report = live_get_usage_report();
        report["rate_limits"]["extra_usage"] = serde_json::json!({
            "is_enabled": true, "monthly_limit": 5000, "used_credits": 100, "utilization": 2.0
        });
        let account = claude_usage_report_from_value(&report)
            .unwrap()
            .quota_account
            .unwrap();
        assert!(account.credits.is_some());
        assert_eq!(account.allowed, None);

        report["rate_limits"]["extra_usage"]["utilization"] = serde_json::json!(100);
        assert!(
            claude_usage_report_from_value(&report)
                .unwrap()
                .quota_account
                .is_none()
        );
    }

    #[test]
    fn unavailable_or_unknown_answers_are_not_a_reading() {
        // An API-key, Bedrock or Vertex session.
        let api_key = serde_json::json!({ "rate_limits_available": false, "rate_limits": null });
        assert!(claude_usage_report_from_value(&api_key).is_none());
        let windowless = serde_json::json!({
            "rate_limits_available": true,
            "rate_limits": { "five_hour": null, "seven_day": { "utilization": null } }
        });
        assert!(claude_usage_report_from_value(&windowless).is_none());
        assert!(claude_usage_report_from_value(&serde_json::json!("nope")).is_none());
        assert!(claude_usage_report_from_value(&serde_json::json!({})).is_none());
    }

    #[test]
    fn get_usage_request_and_answer_correlate_by_request_id() {
        let request = claude_get_usage_control_request("r-7", false);
        assert_eq!(request["type"], "control_request");
        assert_eq!(request["request_id"], "r-7");
        assert_eq!(
            request["request"],
            serde_json::json!({ "subtype": "get_usage", "skip_behaviors": true })
        );
        assert_eq!(
            claude_get_usage_control_request("r-8", true)["request"]["detached"],
            true
        );

        let answer = |id: &str, subtype: &str| {
            serde_json::json!({ "type": "control_response",
                "response": { "subtype": subtype, "request_id": id, "response": { "ok": 1 } } })
        };
        assert_eq!(
            claude_get_usage_answer(&answer("r-7", "success"), "r-7"),
            Some(Some(serde_json::json!({ "ok": 1 })))
        );
        assert_eq!(
            claude_get_usage_answer(&answer("r-7", "error"), "r-7"),
            Some(None)
        );
        assert_eq!(
            claude_get_usage_answer(&answer("other", "success"), "r-7"),
            None
        );
        assert_eq!(
            claude_get_usage_answer(&serde_json::json!({ "type": "system" }), "r-7"),
            None
        );
    }

    #[tokio::test]
    async fn the_disabled_switch_never_asks_claude() {
        let disabled =
            |key: &str| (key == super::super::QUOTA_PROBES_DISABLE_ENV).then(|| "1".to_string());
        let asked = std::sync::atomic::AtomicBool::new(false);
        let usage = read_claude_usage_as(
            ClaudeLogin::DefaultLogin,
            true,
            false,
            &disabled,
            || async {
                asked.store(true, Ordering::SeqCst);
                Some(live_get_usage_report())
            },
        )
        .await;
        assert!(usage.is_none());
        assert!(!asked.load(Ordering::SeqCst));
    }

    #[test]
    fn default_login_spawn_removes_every_login_override() {
        let removed = |login| {
            claude_usage_command(Path::new("claude"), login, None)
                .as_std()
                .get_envs()
                .filter(|(_, value)| value.is_none())
                .map(|(key, _)| key.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        let default_login = removed(ClaudeLogin::DefaultLogin);
        for key in CLAUDE_LOGIN_OVERRIDE_KEYS {
            assert!(default_login.iter().any(|removed| removed == key), "{key}");
        }
        assert!(removed(ClaudeLogin::Process).is_empty());
    }

    #[cfg(unix)]
    mod fake_cli {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn temp_dir(name: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!(
                "xmatrix-claude-usage-{name}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }
        static NEXT: AtomicU64 = AtomicU64::new(0);

        /// A `claude` that prints `version`, logs every stdin line to
        /// `stdin.log`, and answers a `get_usage` with `report`.
        fn fake_claude(dir: &Path, version: &str, report: &Value) -> PathBuf {
            let log = dir.join("stdin.log");
            let answer = serde_json::json!({ "type": "control_response",
                "response": { "subtype": "success", "request_id": "__ID__", "response": report } })
            .to_string();
            let script = format!(
                r#"#!/bin/sh
if [ "$1" = "--version" ]; then echo "{version} (Claude Code)"; exit 0; fi
echo '{{"type":"system","subtype":"status"}}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "{log}"
  id=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
  printf '%s\n' '{answer}' | sed "s/__ID__/$id/"
done
"#,
                log = log.display()
            );
            let path = dir.join("claude");
            std::fs::write(&path, script).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        #[tokio::test]
        async fn a_spawned_claude_is_asked_get_usage_and_never_a_prompt() {
            let dir = temp_dir("ask");
            let program = fake_claude(&dir, "2.1.331", &live_get_usage_report());
            let report = ask_claude_program(
                &program,
                ClaudeLogin::DefaultLogin,
                Some(&dir),
                Duration::from_secs(10),
            )
            .await
            .expect("an answer");
            assert!(claude_usage_report_from_value(&report).is_some());
            let sent = std::fs::read_to_string(dir.join("stdin.log")).unwrap();
            let lines: Vec<Value> = sent
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            assert_eq!(lines.len(), 1, "{sent}");
            assert_eq!(lines[0]["type"], "control_request");
            assert_eq!(lines[0]["request"]["subtype"], "get_usage");
            assert_eq!(lines[0]["request"]["skip_behaviors"], true);
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[tokio::test]
        async fn a_claude_older_than_get_usage_is_never_started_in_stream_mode() {
            let dir = temp_dir("old");
            let program = fake_claude(&dir, "2.1.260", &live_get_usage_report());
            let report = ask_claude_program(
                &program,
                ClaudeLogin::DefaultLogin,
                Some(&dir),
                Duration::from_secs(10),
            )
            .await;
            assert!(report.is_none());
            assert!(!dir.join("stdin.log").exists());
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// The reader's home holds Claude credentials as FIFOs: opening one
        /// for reading blocks until a writer appears, so a reader that
        /// touched them would never return.
        #[test]
        fn a_read_opens_no_claude_credential() {
            let dir = temp_dir("no-credentials");
            let claude_home = dir.join(".claude");
            std::fs::create_dir_all(&claude_home).unwrap();
            for file in [
                claude_home.join(".credentials.json"),
                dir.join(".claude.json"),
            ] {
                let made = std::process::Command::new("mkfifo")
                    .arg(&file)
                    .status()
                    .unwrap();
                assert!(made.success());
            }
            let program = fake_claude(&dir, "2.1.331", &live_get_usage_report());
            let (done, finished) = std::sync::mpsc::channel();
            let home = dir.clone();
            std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                let report = runtime.block_on(ask_claude_program(
                    &program,
                    ClaudeLogin::DefaultLogin,
                    Some(&home),
                    Duration::from_secs(10),
                ));
                let _ = done.send(report);
            });
            let report = finished
                .recv_timeout(Duration::from_secs(20))
                .expect("the read returned without opening a credential");
            assert!(report.is_some());
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    fn rate_limit_event(status: &str, kind: &str, seven_day: f64, overage: bool) -> Value {
        serde_json::json!({
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": status,
                "resetsAt": 1_791_482_400,
                "rateLimitType": kind,
                "utilization": seven_day,
                "isUsingOverage": overage,
                "unifiedWindows": {
                    "five_hour": { "utilization": 0.35, "resetsAt": 1_791_237_600 },
                    "seven_day": { "utilization": seven_day, "resetsAt": 1_791_482_400 }
                }
            }
        })
    }

    #[test]
    fn an_account_claude_still_serves_reads_below_its_limit_and_allowed() {
        // 2026-10-05: the usage endpoint said 1w 100.0 while Claude Code was told
        // `allowed_warning` at 0.99, and the agent kept working under a red Limit.
        let usage = claude_rate_limit_event_usage(&rate_limit_event(
            "allowed_warning",
            "seven_day",
            0.99,
            false,
        ))
        .unwrap();
        let quotas = usage.quota_usages.unwrap();
        assert_eq!(quotas[0].label.as_deref(), Some("5h"));
        assert_eq!(quotas[0].percent, Some(35.0));
        assert_eq!(quotas[1].label.as_deref(), Some("1w"));
        assert_eq!(quotas[1].percent, Some(99.0));
        assert_eq!(quotas[1].reset_at.as_deref(), Some("2026-10-08T18:00:00Z"));
        assert_eq!(usage.quota_source.as_deref(), Some("provider_api"));
        assert!(usage.quota_observed_at.is_some());
        // A verdict is a partial reading: it never states the scoped windows.
        assert!(usage.scoped_quota_usages.is_none());
        let account = usage.quota_account.unwrap();
        assert_eq!(account.allowed, Some(true));
        assert_eq!(account.credits, None, "no extra usage on this account");
    }

    #[test]
    fn an_overage_served_account_says_so() {
        let on_overage =
            claude_rate_limit_event_usage(&rate_limit_event("allowed", "seven_day", 1.0, true))
                .unwrap()
                .quota_account
                .unwrap();
        assert_eq!(on_overage.allowed, Some(true));
        assert!(on_overage.credits.is_some());
    }

    #[test]
    fn a_rejection_keeps_the_account_windows_and_states_no_account_state() {
        // Fable's own limit refused the request while the account's week was
        // at half: the account still serves every other model.
        for kind in ["seven_day_fable", "seven_day"] {
            let usage =
                claude_rate_limit_event_usage(&rate_limit_event("rejected", kind, 0.5, true))
                    .unwrap();
            assert!(usage.quota_account.is_none(), "{kind}");
            assert!(usage.scoped_quota_usages.is_none(), "{kind}");
            let quotas = usage.quota_usages.unwrap();
            assert_eq!(quotas.len(), 2);
            assert!(quotas.iter().all(|window| window.scope.is_none()));
            assert_eq!(quotas[1].percent, Some(50.0));
        }
    }

    #[test]
    fn other_events_and_windowless_verdicts_are_not_quota() {
        assert!(
            claude_rate_limit_event_usage(&serde_json::json!({ "type": "assistant" })).is_none()
        );
        let windowless = serde_json::json!({
            "type": "rate_limit_event",
            "rate_limit_info": { "status": "allowed", "rateLimitType": "five_hour" }
        });
        assert!(claude_rate_limit_event_usage(&windowless).is_none());
    }

    #[tokio::test]
    async fn a_recorded_verdict_answers_before_claude_is_asked() {
        record_claude_rate_limit_event(&rate_limit_event(
            "allowed_warning",
            "seven_day",
            0.99,
            false,
        ))
        .unwrap();
        let asked = std::sync::atomic::AtomicBool::new(false);
        let usage = read_claude_usage_with(true, true, || async {
            asked.store(true, Ordering::SeqCst);
            None
        })
        .await
        .unwrap();
        assert!(!asked.load(Ordering::SeqCst));
        assert_eq!(usage.quota_account.unwrap().allowed, Some(true));
        assert_eq!(usage.quota_usages.unwrap()[1].percent, Some(99.0));
    }
}
