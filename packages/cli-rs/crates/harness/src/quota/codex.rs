//! Codex / ChatGPT account quota, read through Codex's own app-server method
//! `account/rateLimits/read` (openai/codex#5302).
//!
//! Codex resolves and refreshes its own sign-in, so xMatrix never opens the
//! Codex credential file or calls a ChatGPT backend endpoint itself. A running
//! Codex session asks the app-server it already holds (the runtime sends
//! [`ACCOUNT_RATE_LIMITS_METHOD`] and parses the result with
//! [`codex_account_usage_from_response`]); a pre-launch probe briefly starts
//! `codex app-server` for one config home, makes the same request, and stops it.
//!
//! The response is the account's quota. It shares the `primary`/`secondary`
//! window shape with the per-thread `rateLimits` snapshots a session streams,
//! but those snapshots are never parsed as account quota: only the answer to
//! this request is, so one account yields one meter no matter how many Codex
//! threads run on it.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use colored::Colorize;
use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::cache::KeyedProviderUsageCache;
use super::windows::{normalized_quota_percent, rate_limit_window_label};
use crate::fields::{first_f64, first_reset_at};
use crate::usage::{LlmQuotaAccount, LlmQuotaCredits, LlmQuotaUsage, LlmUsage, has_llm_usage};

/// The app-server request that answers the signed-in account's rate limits.
pub const ACCOUNT_RATE_LIMITS_METHOD: &str = "account/rateLimits/read";

/// First Codex release whose app-server answers [`ACCOUNT_RATE_LIMITS_METHOD`].
pub const MIN_ACCOUNT_RATE_LIMITS_VERSION: (u64, u64, u64) = (0, 48, 0);

/// First Codex release that accepts request params on the method
/// (`excludeResetCreditDetails`). Older releases reject any params object.
const MIN_ACCOUNT_RATE_LIMITS_PARAMS_VERSION: (u64, u64, u64) = (0, 154, 0);

/// Bound on one pre-launch probe: app-server start, handshake, and the
/// provider read it makes on our behalf.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a probe app-server gets to exit on stdin EOF before it is killed.
const PROBE_EXIT_GRACE: Duration = Duration::from_secs(2);
const MAX_PROBE_LINE_BYTES: usize = 1024 * 1024;

const INITIALIZE_ID: u64 = 1;
const RATE_LIMITS_ID: u64 = 2;

static CODEX_ACCOUNT_USAGE: KeyedProviderUsageCache =
    KeyedProviderUsageCache::new(Duration::from_secs(120), Duration::from_secs(60));

static LOGGED_UNSUPPORTED_VERSION: AtomicBool = AtomicBool::new(false);

/// A Codex release as `(major, minor, patch)`.
pub type CodexVersion = (u64, u64, u64);

/// The Codex release that answered `initialize`, from its `userAgent`
/// (`<client>/<codex version> (<os>) ...`). A source build reports `0.0.0`,
/// which says nothing about its protocol, so it reads as unknown.
pub fn codex_version_from_initialize(result: &Value) -> Option<CodexVersion> {
    let agent = result.get("userAgent").and_then(Value::as_str)?;
    let product = agent.split_whitespace().next()?;
    let (_, version) = product.rsplit_once('/')?;
    let core = version.split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
    let parsed = (
        parts.next()??,
        parts.next()??,
        parts.next().flatten().unwrap_or(0),
    );
    (parsed != (0, 0, 0)).then_some(parsed)
}

/// Whether an app-server of `version` answers [`ACCOUNT_RATE_LIMITS_METHOD`].
/// An unknown version is asked: a refusal is an ordinary failed read. A known
/// older release is skipped with one log line per process.
pub fn account_rate_limits_supported(version: Option<CodexVersion>) -> bool {
    let Some(version) = version else {
        return true;
    };
    if version >= MIN_ACCOUNT_RATE_LIMITS_VERSION {
        return true;
    }
    if !LOGGED_UNSUPPORTED_VERSION.swap(true, Ordering::Relaxed) {
        let (major, minor, patch) = version;
        let (min_major, min_minor, min_patch) = MIN_ACCOUNT_RATE_LIMITS_VERSION;
        eprintln!(
            "{} Codex {major}.{minor}.{patch} has no {ACCOUNT_RATE_LIMITS_METHOD}; Codex quota \
             is not read until Codex is updated to {min_major}.{min_minor}.{min_patch} or newer",
            "⚠".yellow().bold(),
        );
    }
    false
}

/// Params for [`ACCOUNT_RATE_LIMITS_METHOD`]: a background read skips the
/// reset-credit detail lookup where the release supports saying so, and sends
/// none to older releases, which refuse any params object.
pub fn account_rate_limits_params(version: Option<CodexVersion>) -> Value {
    match version {
        Some(version) if version >= MIN_ACCOUNT_RATE_LIMITS_PARAMS_VERSION => {
            serde_json::json!({ "excludeResetCreditDetails": true })
        }
        _ => Value::Null,
    }
}

/// The account quota in an `account/rateLimits/read` result, stamped as
/// observed now.
///
/// Shape (camelCase since the method shipped; snake_case window fields are
/// accepted for the earliest releases): `{ rateLimits: { primary, secondary,
/// credits, spendControlReached, rateLimitReachedType }, rateLimitsByLimitId:
/// { codex: { ... } }, ordinaryUsageAllowed }`. The `codex` bucket is the
/// Codex meter when the multi-bucket view is present; otherwise the
/// single-bucket `rateLimits`. Only the result envelope is accepted, never a
/// bare window snapshot.
pub fn codex_account_usage_from_response(response: &Value) -> Option<LlmUsage> {
    let root = response.as_object()?;
    let snapshot = root
        .get("rateLimitsByLimitId")
        .and_then(|buckets| buckets.get("codex"))
        .and_then(Value::as_object)
        .or_else(|| root.get("rateLimits").and_then(Value::as_object))?;
    let quota_usages: Vec<LlmQuotaUsage> = ["primary", "secondary"]
        .into_iter()
        .filter_map(|key| snapshot.get(key).and_then(Value::as_object))
        .filter_map(codex_window_quota)
        .collect();
    if quota_usages.is_empty() {
        return None;
    }
    let mut usage = LlmUsage {
        quota_source: Some("provider_api".to_string()),
        quota_usages: Some(quota_usages),
        quota_account: codex_account(root, snapshot),
        quota_observed_at: super::observed_now(),
        ..LlmUsage::default()
    };
    super::windows::prefer_codex_quota_windows(&mut usage.quota_usages);
    has_llm_usage(&usage).then_some(usage)
}

fn codex_window_quota(window: &Map<String, Value>) -> Option<LlmQuotaUsage> {
    let percent = first_f64(window, &["usedPercent", "used_percent"])?;
    let minutes = first_f64(
        window,
        &["windowDurationMins", "window_minutes", "windowMinutes"],
    )?;
    Some(LlmQuotaUsage {
        label: Some(rate_limit_window_label(minutes)?),
        window: Some("Codex".to_string()),
        used: None,
        limit: None,
        remaining: None,
        percent: normalized_quota_percent(Some(percent), None, None),
        reset_at: first_reset_at(window, &["resetsAt", "resets_at"]),
        scope: None,
    })
}

/// Whether the account still serves requests. `ordinaryUsageAllowed` turns
/// false once the plan windows are used up, while credits keep serving; the
/// account refuses only when no credits are left, a spend limit is reached, or
/// the backend names a workspace credit or usage limit as the block.
fn codex_account(
    root: &Map<String, Value>,
    snapshot: &Map<String, Value>,
) -> Option<LlmQuotaAccount> {
    let flag = |map: &Map<String, Value>, key: &str| map.get(key).and_then(Value::as_bool);
    let credits_map = snapshot.get("credits").and_then(Value::as_object);
    let unlimited = credits_map.and_then(|map| flag(map, "unlimited")) == Some(true);
    let has_credits = credits_map.and_then(|map| flag(map, "hasCredits")) == Some(true);
    let workspace_blocked = snapshot
        .get("rateLimitReachedType")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind.starts_with("workspace_"));
    let credits_serve = (has_credits || unlimited)
        && flag(snapshot, "spendControlReached") != Some(true)
        && !workspace_blocked;
    let allowed = flag(root, "ordinaryUsageAllowed").map(|allowed| allowed || credits_serve);
    let credits = (has_credits || unlimited).then(|| LlmQuotaCredits {
        balance: credits_map
            .and_then(|map| map.get("balance"))
            .and_then(|balance| match balance {
                Value::String(text) => text.trim().parse::<f64>().ok(),
                other => other.as_f64(),
            })
            .filter(|balance| balance.is_finite() && *balance >= 0.0),
        currency: None,
        unlimited,
    });
    (allowed.is_some() || credits.is_some()).then_some(LlmQuotaAccount { allowed, credits })
}

fn resolve_codex_program() -> Option<PathBuf> {
    which::which("codex").ok()
}

/// The cache slot for one Codex login: the exact config home, or the process
/// `CODEX_HOME` (Codex's default home when unset).
fn codex_quota_cache_key(home: Option<&Path>) -> String {
    match home {
        Some(home) => {
            let base = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
            format!("home\u{0}{}", base.to_string_lossy())
        }
        None => format!(
            "process\u{0}{}",
            std::env::var_os("CODEX_HOME")
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_default()
        ),
    }
}

/// The account quota of one Codex login, asked of a short-lived
/// `codex app-server`. `home` binds the probe to that config home
/// (`CODEX_HOME`), so a pre-launch read sees the account a spawn with that home
/// would bill; `None` inherits the process environment.
pub async fn read_codex_account_usage(home: Option<&Path>, force: bool) -> Option<LlmUsage> {
    read_codex_account_usage_unless(
        super::quota_probes_disabled(),
        resolve_codex_program,
        home,
        force,
    )
    .await
}

/// The disabled switch is decided before Codex is even looked up, so a
/// disabled machine never starts a process.
async fn read_codex_account_usage_unless(
    disabled: bool,
    resolve_program: impl FnOnce() -> Option<PathBuf>,
    home: Option<&Path>,
    force: bool,
) -> Option<LlmUsage> {
    if disabled {
        return None;
    }
    let program = resolve_program()?;
    read_codex_account_usage_with_program(&program, home, force, PROBE_TIMEOUT).await
}

async fn read_codex_account_usage_with_program(
    program: &Path,
    home: Option<&Path>,
    force: bool,
    timeout: Duration,
) -> Option<LlmUsage> {
    let key = codex_quota_cache_key(home);
    if let Some(cached) = CODEX_ACCOUNT_USAGE.hit_unless_forced(&key, force) {
        return cached;
    }
    CODEX_ACCOUNT_USAGE
        .single_flight(&key, || async {
            let usage = probe_account_rate_limits(program, home, timeout)
                .await
                .as_ref()
                .and_then(codex_account_usage_from_response);
            CODEX_ACCOUNT_USAGE.store(&key, usage.clone());
            usage
        })
        .await
}

fn probe_command(program: &Path, home: Option<&Path>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    command
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(home) = home {
        command.env("CODEX_HOME", home);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Start `codex app-server`, complete the `initialize` handshake, ask
/// [`ACCOUNT_RATE_LIMITS_METHOD`], and stop the server. The result object, or
/// `None` on an older release, a refusal, a timeout, or an exit.
async fn probe_account_rate_limits(
    program: &Path,
    home: Option<&Path>,
    timeout: Duration,
) -> Option<Value> {
    let mut child = probe_command(program, home).spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    let exchange = async {
        let mut lines = BufReader::new(stdout).lines();
        write_json_line(
            &mut stdin,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": INITIALIZE_ID,
                "method": "initialize",
                "params": {
                    "clientInfo": { "name": "xmatrix", "version": env!("CARGO_PKG_VERSION") },
                },
            }),
        )
        .await?;
        let initialized = read_result(&mut lines, INITIALIZE_ID).await?;
        let version = codex_version_from_initialize(&initialized);
        if !account_rate_limits_supported(version) {
            return None;
        }
        write_json_line(
            &mut stdin,
            &serde_json::json!({ "jsonrpc": "2.0", "method": "initialized" }),
        )
        .await?;
        let mut request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": RATE_LIMITS_ID,
            "method": ACCOUNT_RATE_LIMITS_METHOD,
        });
        let params = account_rate_limits_params(version);
        if !params.is_null() {
            request["params"] = params;
        }
        write_json_line(&mut stdin, &request).await?;
        read_result(&mut lines, RATE_LIMITS_ID).await
    };
    let result = tokio::time::timeout(timeout, exchange).await.ok().flatten();
    // Close stdin so the app-server exits on its own, then make sure it is gone.
    drop(stdin);
    if tokio::time::timeout(PROBE_EXIT_GRACE, child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
    result
}

async fn write_json_line(stdin: &mut tokio::process::ChildStdin, value: &Value) -> Option<()> {
    let mut line = serde_json::to_vec(value).ok()?;
    line.push(b'\n');
    stdin.write_all(&line).await.ok()?;
    stdin.flush().await.ok()
}

/// The `result` of response `id`, skipping notifications and other messages.
/// An error response or the end of output is `None`.
async fn read_result(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    id: u64,
) -> Option<Value> {
    while let Some(line) = lines.next_line().await.ok()? {
        if line.len() > MAX_PROBE_LINE_BYTES {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if message.get("id").and_then(Value::as_u64) != Some(id) || message.get("method").is_some()
        {
            continue;
        }
        return message.get("result").cloned();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `account/rateLimits/read` result (Codex 0.172.0, account id
    /// removed), with the 5-hour primary and weekly secondary windows.
    fn sample_response() -> Value {
        serde_json::json!({
            "ordinaryUsageAllowed": true,
            "rateLimits": {
                "limitId": "codex",
                "primary": { "usedPercent": 3, "windowDurationMins": 300, "resetsAt": 1795559834 },
                "secondary": { "usedPercent": 41, "windowDurationMins": 10080, "resetsAt": 1796146634 },
                "credits": { "hasCredits": true, "unlimited": false, "balance": "137.5" },
                "individualLimit": null,
                "spendControlReached": false,
                "planType": "plus",
                "rateLimitReachedType": null
            },
            "rateLimitsByLimitId": {
                "codex": {
                    "limitId": "codex",
                    "primary": { "usedPercent": 3, "windowDurationMins": 300, "resetsAt": 1795559834 },
                    "secondary": { "usedPercent": 41, "windowDurationMins": 10080, "resetsAt": 1796146634 },
                    "credits": { "hasCredits": true, "unlimited": false, "balance": "137.5" },
                    "spendControlReached": false
                }
            },
            "rateLimitResetCredits": { "availableCount": 1, "credits": null },
            "rateLimitUpsell": null
        })
    }

    #[test]
    fn account_read_yields_one_codex_meter_with_5h_and_1w_windows() {
        let usage = codex_account_usage_from_response(&sample_response()).unwrap();
        assert!(usage.quota_observed_at.is_some());
        let quotas = super::super::assert_provider_window_labels(usage.clone(), &["5h", "1w"]);
        assert!(quotas.iter().all(|q| q.window.as_deref() == Some("Codex")));
        assert_eq!(quotas[0].percent, Some(3.0));
        assert_eq!(quotas[0].reset_at.as_deref(), Some("1795559834"));
        assert_eq!(quotas[1].percent, Some(41.0));
        assert_eq!(
            usage.quota_account,
            Some(LlmQuotaAccount {
                allowed: Some(true),
                credits: Some(LlmQuotaCredits {
                    balance: Some(137.5),
                    currency: None,
                    unlimited: false
                }),
            })
        );
    }

    #[test]
    fn codex_bucket_wins_over_the_single_bucket_view() {
        let mut response = sample_response();
        response["rateLimits"]["primary"]["usedPercent"] = 90.into();
        response["rateLimitsByLimitId"]["other_model"] = serde_json::json!({
            "primary": { "usedPercent": 77, "windowDurationMins": 300 }
        });
        let quotas = codex_account_usage_from_response(&response)
            .unwrap()
            .quota_usages
            .unwrap();
        assert_eq!(quotas.len(), 2, "one account meter, not one per bucket");
        assert_eq!(quotas[0].percent, Some(3.0));

        let mut single = sample_response();
        single
            .as_object_mut()
            .unwrap()
            .remove("rateLimitsByLimitId");
        single["rateLimits"]["primary"]["usedPercent"] = 90.into();
        let quotas = codex_account_usage_from_response(&single)
            .unwrap()
            .quota_usages
            .unwrap();
        assert_eq!(quotas[0].percent, Some(90.0));
    }

    #[test]
    fn earliest_release_snake_case_windows_parse() {
        // Codex 0.48.0 serialized the snapshot without camelCase renames.
        let response = serde_json::json!({
            "rateLimits": {
                "primary": { "used_percent": 12.5, "window_minutes": 300, "resets_at": 1784012345 },
                "secondary": { "used_percent": 40.0, "window_minutes": 10080, "resets_at": 1784487804 }
            }
        });
        let usage = codex_account_usage_from_response(&response).unwrap();
        assert_eq!(
            usage.quota_account, None,
            "no account flags in that release"
        );
        let quotas = super::super::assert_provider_window_labels(usage, &["5h", "1w"]);
        assert_eq!(quotas[0].percent, Some(12.5));
        assert_eq!(quotas[1].reset_at.as_deref(), Some("1784487804"));
    }

    #[test]
    fn used_up_plan_windows_stay_allowed_only_while_credits_serve() {
        let blocked = |patch: Value| {
            let mut response = sample_response();
            response
                .as_object_mut()
                .unwrap()
                .remove("rateLimitsByLimitId");
            response["ordinaryUsageAllowed"] = false.into();
            response["rateLimits"]["primary"]["usedPercent"] = 100.into();
            for (key, value) in patch.as_object().unwrap() {
                response["rateLimits"][key] = value.clone();
            }
            codex_account_usage_from_response(&response)
                .unwrap()
                .quota_account
                .unwrap()
        };
        assert_eq!(blocked(serde_json::json!({})).allowed, Some(true));
        assert_eq!(
            blocked(serde_json::json!({ "spendControlReached": true })).allowed,
            Some(false)
        );
        assert_eq!(
            blocked(serde_json::json!({
                "rateLimitReachedType": "workspace_member_credits_depleted"
            }))
            .allowed,
            Some(false)
        );
        let no_credits = blocked(serde_json::json!({
            "credits": { "hasCredits": false, "unlimited": false, "balance": "0" }
        }));
        assert_eq!(no_credits.allowed, Some(false));
        assert_eq!(no_credits.credits, None);
    }

    #[test]
    fn bare_window_snapshots_are_not_an_account_read() {
        // A per-thread snapshot is the inner object, not the read's envelope.
        let thread_snapshot = serde_json::json!({
            "primary": { "usedPercent": 12, "windowDurationMins": 300 },
            "secondary": { "usedPercent": 34, "windowDurationMins": 10080 }
        });
        assert!(codex_account_usage_from_response(&thread_snapshot).is_none());
        assert!(codex_account_usage_from_response(&serde_json::json!({})).is_none());
        assert!(
            codex_account_usage_from_response(&serde_json::json!({ "rateLimits": {} })).is_none()
        );
    }

    #[test]
    fn version_gate_reads_initialize_user_agent() {
        let init = |agent: &str| serde_json::json!({ "userAgent": agent });
        assert_eq!(
            codex_version_from_initialize(&init(
                "xmatrix/0.172.0 (Ubuntu 24.4.0; x86_64) unknown (xmatrix; 0.0.0)"
            )),
            Some((0, 172, 0))
        );
        assert_eq!(
            codex_version_from_initialize(&init("codex_cli_rs/0.48.0-alpha.2 (Mac OS 15.0)")),
            Some((0, 48, 0))
        );
        assert_eq!(
            codex_version_from_initialize(&init("xmatrix/0.0.0 (Linux)")),
            None
        );
        assert_eq!(codex_version_from_initialize(&serde_json::json!({})), None);

        assert!(!account_rate_limits_supported(Some((0, 47, 9))));
        assert!(account_rate_limits_supported(Some((0, 48, 0))));
        assert!(account_rate_limits_supported(None));
        assert_eq!(account_rate_limits_params(Some((0, 48, 0))), Value::Null);
        assert_eq!(account_rate_limits_params(None), Value::Null);
        assert_eq!(
            account_rate_limits_params(Some((0, 172, 0))),
            serde_json::json!({ "excludeResetCreditDetails": true })
        );
    }

    #[test]
    fn cache_key_separates_homes_from_the_process_login() {
        let a = PathBuf::from("accounts/alpha");
        let b = PathBuf::from("accounts/beta");
        assert_ne!(
            codex_quota_cache_key(Some(&a)),
            codex_quota_cache_key(Some(&b))
        );
        assert_eq!(
            codex_quota_cache_key(Some(&a)),
            codex_quota_cache_key(Some(&a))
        );
        assert_ne!(codex_quota_cache_key(Some(&a)), codex_quota_cache_key(None));
    }

    #[cfg(unix)]
    mod unix_app_server_tests {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn unique_temp_dir(name: &str) -> PathBuf {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "xmatrix-codex-quota-{name}-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).expect("temp dir");
            dir
        }

        /// A stand-in `codex` that speaks the app-server handshake on stdio,
        /// records each message it receives and its `CODEX_HOME`, and answers
        /// as release `version`.
        fn fake_codex(dir: &Path, version: &str, response: &Value) -> PathBuf {
            let log = dir.join("received");
            let script = format!(
                r#"#!/bin/sh
[ "$1" = "app-server" ] || exit 2
printf 'CODEX_HOME=%s\n' "$CODEX_HOME" >> "{log}"
while IFS= read -r line; do
  printf '%s\n' "$line" >> "{log}"
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"method":"configWarning","params":{{}}}}'
      printf '%s\n' '{{"id":1,"result":{{"userAgent":"xmatrix/{version} (Linux) unknown"}}}}' ;;
    *'"method":"account/rateLimits/read"'*)
      printf '%s\n' '{{"method":"account/updated","params":{{}}}}'
      printf '%s\n' '{{"id":2,"result":{response}}}' ;;
  esac
done
"#,
                log = log.display(),
                response = response,
            );
            let path = dir.join("codex");
            std::fs::write(&path, script).expect("write fake codex");
            let mut perms = std::fs::metadata(&path).expect("meta").permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&path, perms).expect("chmod");
            path
        }

        fn received(dir: &Path) -> String {
            std::fs::read_to_string(dir.join("received")).unwrap_or_default()
        }

        #[tokio::test]
        async fn probe_asks_the_app_server_for_the_home_without_credential_files() {
            let dir = unique_temp_dir("probe");
            // The home holds no credential file: Codex owns its sign-in, and
            // the reader neither needs nor opens one.
            let home = dir.join("home");
            std::fs::create_dir_all(&home).unwrap();
            let program = fake_codex(&dir, "0.172.0", &sample_response());

            let usage = read_codex_account_usage_with_program(
                &program,
                Some(&home),
                true,
                Duration::from_secs(10),
            )
            .await
            .expect("account usage");
            let quotas = super::super::super::assert_provider_window_labels(usage, &["5h", "1w"]);
            assert_eq!(quotas[1].percent, Some(41.0));

            let log = received(&dir);
            assert!(
                log.contains(&format!("CODEX_HOME={}\n", home.display())),
                "{log}"
            );
            assert!(log.contains(r#""method":"initialized""#), "{log}");
            assert!(
                log.contains(r#""method":"account/rateLimits/read","params":{"excludeResetCreditDetails":true}"#),
                "{log}"
            );
            // A cached reading answers without starting the app-server again.
            std::fs::remove_file(dir.join("received")).unwrap();
            assert!(
                read_codex_account_usage_with_program(
                    &program,
                    Some(&home),
                    false,
                    Duration::from_secs(10)
                )
                .await
                .is_some()
            );
            assert_eq!(received(&dir), "");
            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn the_reader_opens_no_codex_login_file() {
            let dir = unique_temp_dir("no-login-file");
            let home = dir.join("home");
            std::fs::create_dir_all(&home).unwrap();
            // Codex's login file is a FIFO with no writer: opening it for
            // reading blocks forever, so a reader that touched it never
            // returns. The stand-in app-server does not open it either.
            let status = std::process::Command::new("mkfifo")
                .arg(home.join("auth.json"))
                .status()
                .expect("mkfifo");
            assert!(status.success());
            let program = fake_codex(&dir, "0.172.0", &sample_response());

            let (done, finished) = std::sync::mpsc::channel();
            let (thread_home, thread_program) = (home.clone(), program.clone());
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("runtime");
                let usage = rt.block_on(read_codex_account_usage_with_program(
                    &thread_program,
                    Some(&thread_home),
                    true,
                    Duration::from_secs(10),
                ));
                let _ = done.send(usage);
            });
            let usage = finished
                .recv_timeout(Duration::from_secs(20))
                .expect("the reader blocked: it opened the Codex login file");
            assert!(usage.is_some());
            std::fs::remove_dir_all(&dir).ok();
        }

        #[tokio::test]
        async fn disabled_probes_never_start_codex() {
            let dir = unique_temp_dir("disabled");
            let program = fake_codex(&dir, "0.172.0", &sample_response());
            let resolved = std::sync::atomic::AtomicBool::new(false);
            let usage = read_codex_account_usage_unless(
                true,
                || {
                    resolved.store(true, Ordering::Relaxed);
                    Some(program.clone())
                },
                Some(&dir),
                true,
            )
            .await;
            assert!(usage.is_none());
            assert!(!resolved.load(Ordering::Relaxed), "codex was looked up");
            assert_eq!(received(&dir), "", "codex was started");

            let enabled =
                read_codex_account_usage_unless(false, || Some(program.clone()), Some(&dir), true)
                    .await;
            assert!(enabled.is_some());
            std::fs::remove_dir_all(&dir).ok();
        }

        #[tokio::test]
        async fn older_release_is_never_asked_the_method() {
            let dir = unique_temp_dir("old");
            let home = dir.join("home");
            std::fs::create_dir_all(&home).unwrap();
            let program = fake_codex(&dir, "0.47.0", &sample_response());

            assert!(
                read_codex_account_usage_with_program(
                    &program,
                    Some(&home),
                    true,
                    Duration::from_secs(10)
                )
                .await
                .is_none()
            );
            let log = received(&dir);
            assert!(log.contains(r#""method":"initialize""#), "{log}");
            assert!(!log.contains(ACCOUNT_RATE_LIMITS_METHOD), "{log}");
            std::fs::remove_dir_all(&dir).ok();
        }

        #[tokio::test]
        async fn unanswered_probe_times_out_and_stops_the_server() {
            let dir = unique_temp_dir("hang");
            let script = "#!/bin/sh\nexec sleep 30\n";
            let program = dir.join("codex");
            std::fs::write(&program, script).unwrap();
            let mut perms = std::fs::metadata(&program).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&program, perms).unwrap();

            let started = std::time::Instant::now();
            assert!(
                probe_account_rate_limits(&program, None, Duration::from_millis(300))
                    .await
                    .is_none()
            );
            assert!(started.elapsed() < Duration::from_secs(5));
            std::fs::remove_dir_all(&dir).ok();
        }
    }
}
