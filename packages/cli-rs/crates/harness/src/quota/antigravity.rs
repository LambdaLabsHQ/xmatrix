//! Google Antigravity (`agy`) account quota, read through the official
//! `agy -p "/usage" --output-format json` command.
//!
//! Delegating to the unmodified `agy` CLI lets Antigravity handle its own
//! authentication (including system keyring sign-ins on macOS and Windows where
//! no plaintext OAuth token file exists) without reading local OAuth token
//! files or calling private Cloud Code endpoints directly.
//!
//! `agy -p "/usage" --output-format json` executes without creating a
//! conversation or spending model tokens (`num_turns: 0`, `total_tokens: 0`)
//! and returns grouped pool buckets (`Gemini Models`, `Claude and GPT models`)
//! with full floating-point `remaining_fraction` and `reset_time`. Every window
//! travels in `scoped_quota_usages`, paired with `quota_scopes` on
//! Antigravity's ACP model catalog so one pool's exhaustion never stops models
//! in another pool.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use colored::Colorize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

use super::cache::KeyedProviderUsageCache;
use super::windows::percent_window;
use crate::fields::first_string;
use crate::host::{home_dir_path, lowercase_hex};
use crate::usage::{LlmQuotaUsage, LlmUsage};

/// Environment variables that make an `agy` spawn bill something other than
/// the default CLI sign-in.
pub const ANTIGRAVITY_LOGIN_OVERRIDE_KEYS: &[&str] = &[
    "JETSKI_OAUTH_TOKEN",
    "ANTIGRAVITY_APP_DATA_DIR",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "AGY_ADC_AUTH",
];

/// Opt-out environment variable that disables Antigravity quota probing
/// completely (both daemon pre-launch probes and live ACP session probes).
pub const ANTIGRAVITY_QUOTA_DISABLE_ENV: &str = "XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE";

/// First `agy` release that answers read-only `-p "/usage" --output-format json`
/// non-interactively without starting an LLM turn or spending tokens.
const MIN_PRINT_USAGE_CLI_VERSION: (u64, u64, u64) = (1, 1, 11);
const AGY_VERSION_TIMEOUT: Duration = Duration::from_secs(2);
const AGY_USAGE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_VERSION_STDOUT_BYTES: usize = 4 * 1024;
const MAX_USAGE_STDOUT_BYTES: usize = 256 * 1024;
const MAX_USAGE_STDERR_BYTES: usize = 32 * 1024;

const SCOPE_GEMINI: &str = "Gemini";
const SCOPE_CLAUDE_GPT: &str = "Claude & GPT";
const MAX_SCOPE_BYTES: usize = 64;

struct AntigravityQuotaStore {
    cache: KeyedProviderUsageCache,
    /// Monotonic generation bumped whenever cached Antigravity readings are
    /// invalidated (for example after completing remote sign-in), so an
    /// in-flight `agy -p "/usage"` reading from the previous account is
    /// discarded.
    generation: AtomicU64,
}

impl AntigravityQuotaStore {
    const fn new(fresh_ttl: Duration, error_ttl: Duration) -> Self {
        Self {
            cache: KeyedProviderUsageCache::new(fresh_ttl, error_ttl),
            generation: AtomicU64::new(0),
        }
    }

    fn invalidate(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.cache.clear();
    }
}

/// Conservative cache TTL (3m success, 1m failure) so background probes avoid
/// frequent `agy` subprocess invocations.
static ANTIGRAVITY_QUOTA: AntigravityQuotaStore =
    AntigravityQuotaStore::new(Duration::from_secs(180), Duration::from_secs(60));

#[derive(Clone, Debug, PartialEq, Eq)]
struct BinaryFingerprint {
    path: PathBuf,
    modified: Option<SystemTime>,
    len: u64,
}

#[derive(Clone, Debug)]
struct CachedCliVersion {
    fingerprint: BinaryFingerprint,
    version: (u64, u64, u64),
}

static AGY_VERSION_CACHE: OnceLock<Mutex<Option<CachedCliVersion>>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AgyEnvMode {
    /// Inherit the current process environment (used by live ACP Runs).
    Process,
    /// Strip [`ANTIGRAVITY_LOGIN_OVERRIDE_KEYS`] so the command resolves only
    /// the machine's default `agy` sign-in.
    DefaultLogin,
}

/// Whether `value` turns on a boolean disable flag (`1`, `true`, `yes`, `on`).
pub fn is_quota_probe_disabled_value(value: Option<&str>) -> bool {
    super::is_flag_enabled_value(value)
}

/// Whether Antigravity quota probing is disabled in the given environment view.
pub fn is_quota_probe_disabled_in(env: impl Fn(&str) -> Option<String>) -> bool {
    super::quota_probes_disabled_in(&env)
        || is_quota_probe_disabled_value(env(ANTIGRAVITY_QUOTA_DISABLE_ENV).as_deref())
}

/// Whether Antigravity quota probing is disabled in the current process
/// environment (`XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE`).
pub fn antigravity_quota_probe_disabled() -> bool {
    is_quota_probe_disabled_in(|key| std::env::var(key).ok())
}

/// Drop cached Antigravity quota readings and fence any in-flight read so a
/// newly signed-in account never inherits the previous account's snapshot.
pub fn invalidate_antigravity_quota_cache() {
    ANTIGRAVITY_QUOTA.invalidate();
}

fn debug_report(detail: &str) {
    if std::env::var("XMATRIX_ANTIGRAVITY_QUOTA_DEBUG").is_ok() {
        eprintln!("{} antigravity quota {detail}", "⚠".yellow().bold());
    }
}

fn fingerprint(raw: &str) -> String {
    lowercase_hex(&Sha256::digest(raw.as_bytes()))
}

fn cache_key_for_mode(
    mode: AgyEnvMode,
    env: &(dyn Fn(&str) -> Option<String> + Sync),
    home: Option<&Path>,
) -> String {
    let home_part = home
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    match mode {
        AgyEnvMode::DefaultLogin => format!("default\u{0}{home_part}"),
        AgyEnvMode::Process => {
            let mut parts = vec!["process".to_string(), home_part];
            for key in ANTIGRAVITY_LOGIN_OVERRIDE_KEYS {
                let value = env(key)
                    .map(|raw| raw.trim().to_string())
                    .filter(|trimmed| !trimmed.is_empty());
                match value {
                    Some(raw) if *key == "ANTIGRAVITY_APP_DATA_DIR" => {
                        parts.push(format!("{key}={raw}"));
                    }
                    Some(raw) => {
                        // Hash in-process override values so credentials never
                        // sit verbatim in cache keys.
                        parts.push(format!("{key}#{}", fingerprint(&raw)));
                    }
                    None => {}
                }
            }
            parts.join("\u{0}")
        }
    }
}

fn process_env_lookup(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// Read Antigravity quota for the login resolved by the current process
/// environment by invoking `agy -p "/usage" --output-format json`.
pub async fn read_antigravity_quota_usage(force: bool) -> Option<LlmUsage> {
    if antigravity_quota_probe_disabled() {
        return None;
    }
    let program = resolve_agy_program()?;
    read_antigravity_quota_with_program(
        &ANTIGRAVITY_QUOTA,
        &program,
        AgyEnvMode::Process,
        force,
        AGY_USAGE_TIMEOUT,
        &process_env_lookup,
        home_dir_path().as_deref(),
    )
    .await
}

/// Read Antigravity quota for the default CLI sign-in, ignoring process
/// login-override variables. Callers must first prove a registered spawn sees
/// no override.
pub(crate) async fn read_antigravity_quota_usage_for_default_account(
    force: bool,
) -> Option<LlmUsage> {
    if antigravity_quota_probe_disabled() {
        return None;
    }
    let program = resolve_agy_program()?;
    read_antigravity_quota_with_program(
        &ANTIGRAVITY_QUOTA,
        &program,
        AgyEnvMode::DefaultLogin,
        force,
        AGY_USAGE_TIMEOUT,
        &process_env_lookup,
        home_dir_path().as_deref(),
    )
    .await
}

async fn read_antigravity_quota_with_program(
    store: &AntigravityQuotaStore,
    program: &Path,
    mode: AgyEnvMode,
    force: bool,
    timeout: Duration,
    env: &(dyn Fn(&str) -> Option<String> + Sync),
    home: Option<&Path>,
) -> Option<LlmUsage> {
    let key = cache_key_for_mode(mode, env, home);
    if let Some(cached) = store.cache.hit_unless_forced(&key, force) {
        return cached;
    }
    store
        .cache
        .single_flight(&key, || async {
            let gen_before = store.generation.load(Ordering::Acquire);
            if !agy_supports_print_usage(program, home).await {
                if store.generation.load(Ordering::Acquire) == gen_before {
                    store.cache.store(&key, None);
                }
                return None;
            }
            let Some(payload) = run_agy_usage_command(program, mode, home, timeout).await else {
                if store.generation.load(Ordering::Acquire) == gen_before {
                    store.cache.store(&key, None);
                }
                return None;
            };
            // Discard the reading if the cache was invalidated or the process
            // override environment changed while `agy` was running.
            if store.generation.load(Ordering::Acquire) != gen_before
                || cache_key_for_mode(mode, env, home) != key
            {
                return None;
            }
            let mut usage = antigravity_cli_usage_from_value(&payload);
            if let Some(usage) = usage.as_mut() {
                usage.quota_observed_at = super::observed_now();
            }
            store.cache.store(&key, usage.clone());
            usage
        })
        .await
}

fn configure_agy_command(program: &Path, home: Option<&Path>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("AGY_CLI_DISABLE_AUTO_UPDATE", "true")
        .kill_on_drop(true);
    if let Some(home) = home.filter(|path| path.is_dir()) {
        command.current_dir(home);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn resolve_agy_program() -> Option<PathBuf> {
    if let Some(path_var) = std::env::var_os("PATH")
        && let Some(found) = find_agy_in_paths(&path_var)
    {
        return Some(found);
    }
    #[cfg(not(windows))]
    if let Some(home) = home_dir_path() {
        let local_bin = home.join(".local").join("bin").join("agy");
        if local_bin.is_file() {
            return Some(local_bin);
        }
    }
    #[cfg(windows)]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let install_bin = PathBuf::from(local_app_data)
            .join("agy")
            .join("bin")
            .join("agy.exe");
        if install_bin.is_file() {
            return Some(install_bin);
        }
    }
    None
}

fn find_agy_in_paths(path_var: &OsStr) -> Option<PathBuf> {
    #[cfg(windows)]
    const CANDIDATES: &[&str] = &["agy.exe", "agy.cmd", "agy.bat", "agy"];
    #[cfg(not(windows))]
    const CANDIDATES: &[&str] = &["agy"];

    for dir in std::env::split_paths(path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for name in CANDIDATES {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn binary_fingerprint(program: &Path) -> Option<BinaryFingerprint> {
    let metadata = std::fs::metadata(program).ok()?;
    Some(BinaryFingerprint {
        path: program.to_path_buf(),
        modified: metadata.modified().ok(),
        len: metadata.len(),
    })
}

fn cached_cli_version(fingerprint: &BinaryFingerprint) -> Option<(u64, u64, u64)> {
    let cache = AGY_VERSION_CACHE.get_or_init(|| Mutex::new(None));
    let guard = cache.lock().ok()?;
    guard
        .as_ref()
        .filter(|entry| entry.fingerprint == *fingerprint)
        .map(|entry| entry.version)
}

fn store_cli_version(fingerprint: BinaryFingerprint, version: (u64, u64, u64)) {
    let cache = AGY_VERSION_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = cache.lock() {
        *guard = Some(CachedCliVersion {
            fingerprint,
            version,
        });
    }
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

async fn read_agy_version(program: &Path, home: Option<&Path>) -> Option<(u64, u64, u64)> {
    let fingerprint = binary_fingerprint(program);
    if let Some(fp) = fingerprint.as_ref()
        && let Some(cached) = cached_cli_version(fp)
    {
        return Some(cached);
    }
    let mut command = configure_agy_command(program, home);
    command.arg("--version").stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let read = async {
        let mut bytes = Vec::new();
        let mut limited = stdout.take((MAX_VERSION_STDOUT_BYTES + 1) as u64);
        let (read_res, status_res) = tokio::join!(limited.read_to_end(&mut bytes), child.wait());
        read_res.ok()?;
        let status = status_res.ok()?;
        if !status.success() || bytes.len() > MAX_VERSION_STDOUT_BYTES {
            return None;
        }
        let text = String::from_utf8(bytes).ok()?;
        parse_cli_semver(&text)
    };
    let version = tokio::time::timeout(AGY_VERSION_TIMEOUT, read)
        .await
        .ok()
        .flatten()?;
    if let Some(fp) = fingerprint {
        store_cli_version(fp, version);
    }
    Some(version)
}

async fn agy_supports_print_usage(program: &Path, home: Option<&Path>) -> bool {
    match read_agy_version(program, home).await {
        Some(version) if version >= MIN_PRINT_USAGE_CLI_VERSION => true,
        Some((major, minor, patch)) => {
            debug_report(&format!(
                "skipping agy {major}.{minor}.{patch}: requires >= {}.{}.{} for non-interactive /usage",
                MIN_PRINT_USAGE_CLI_VERSION.0,
                MIN_PRINT_USAGE_CLI_VERSION.1,
                MIN_PRINT_USAGE_CLI_VERSION.2
            ));
            false
        }
        None => {
            debug_report("could not determine agy CLI version");
            false
        }
    }
}

/// Detect when an unauthenticated `agy -p "/usage"` enters its interactive
/// 60-second OAuth sign-in prompt so the probe can kill it immediately instead
/// of waiting out the probe timeout.
fn stderr_requests_interactive_auth(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("authentication required")
        || lower.contains("please visit the url to log in")
        || lower.contains("waiting for authentication")
        || lower.contains("paste the authorization code")
}

fn build_agy_usage_command(
    program: &Path,
    mode: AgyEnvMode,
    home: Option<&Path>,
) -> tokio::process::Command {
    let mut command = configure_agy_command(program, home);
    command.args(["-p", "/usage", "--output-format", "json"]);
    if mode == AgyEnvMode::DefaultLogin {
        for key in ANTIGRAVITY_LOGIN_OVERRIDE_KEYS {
            command.env_remove(key);
        }
    }
    command
}

async fn run_agy_usage_command(
    program: &Path,
    mode: AgyEnvMode,
    home: Option<&Path>,
    timeout: Duration,
) -> Option<Value> {
    let mut command = build_agy_usage_command(program, mode, home);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            debug_report(&format!("failed to spawn agy: {err}"));
            return None;
        }
    };
    let stdout = child.stdout.take()?;
    let stderr = child.stderr.take()?;

    let (auth_tx, auth_rx) = tokio::sync::oneshot::channel::<()>();
    let auth_prompted = async move {
        if auth_rx.await.is_err() {
            std::future::pending::<()>().await;
        }
    };

    let stdout_fut = async move {
        let mut bytes = Vec::new();
        let mut limited = stdout.take((MAX_USAGE_STDOUT_BYTES + 1) as u64);
        limited.read_to_end(&mut bytes).await.ok()?;
        (bytes.len() <= MAX_USAGE_STDOUT_BYTES).then_some(bytes)
    };

    let stderr_fut = async move {
        let mut reader = BufReader::new(stderr.take(MAX_USAGE_STDERR_BYTES as u64));
        let mut line = String::new();
        let mut tx = Some(auth_tx);
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if stderr_requests_interactive_auth(&line) {
                        if let Some(tx) = tx.take() {
                            let _ = tx.send(());
                        }
                        break;
                    }
                }
            }
        }
    };

    enum RunOutcome {
        Completed {
            stdout: Option<Vec<u8>>,
            status: std::io::Result<std::process::ExitStatus>,
        },
        AuthPrompted,
    }

    let run = async {
        tokio::select! {
            biased;
            () = auth_prompted => RunOutcome::AuthPrompted,
            (stdout, (), status) = async {
                tokio::join!(stdout_fut, stderr_fut, child.wait())
            } => RunOutcome::Completed { stdout, status },
        }
    };

    let outcome = match tokio::time::timeout(timeout, run).await {
        Ok(outcome) => outcome,
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            debug_report("agy -p \"/usage\" timed out");
            return None;
        }
    };

    match outcome {
        RunOutcome::AuthPrompted => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            debug_report("agy is signed out (aborted interactive auth prompt)");
            None
        }
        RunOutcome::Completed { stdout, status } => {
            let Ok(status) = status else {
                debug_report("agy wait failed");
                return None;
            };
            if !status.success() {
                debug_report(&format!("agy -p \"/usage\" exited with {status}"));
                return None;
            }
            let Some(stdout) = stdout else {
                debug_report("agy -p \"/usage\" stdout exceeded bound");
                return None;
            };
            let trimmed = String::from_utf8(stdout).ok()?;
            match serde_json::from_str::<Value>(trimmed.trim()) {
                Ok(value) => Some(value),
                Err(err) => {
                    debug_report(&format!("agy -p \"/usage\" JSON parse failed: {err}"));
                    None
                }
            }
        }
    }
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

/// Parse `agy -p "/usage" --output-format json` stdout JSON into scoped pool
/// windows (`Gemini` and `Claude & GPT`, 5h and 1w, preserving floating-point
/// precision).
pub fn antigravity_cli_usage_from_value(value: &Value) -> Option<LlmUsage> {
    let root = value.as_object()?;
    let status = root.get("status").and_then(Value::as_str)?;
    if !status.eq_ignore_ascii_case("SUCCESS") {
        return None;
    }
    if root
        .get("num_turns")
        .and_then(Value::as_u64)
        .is_some_and(|turns| turns > 0)
    {
        return None;
    }
    let command = root.get("command")?.as_object()?;
    let command_name = command.get("name").and_then(Value::as_str)?;
    if !command_name.eq_ignore_ascii_case("usage") && !command_name.eq_ignore_ascii_case("quota") {
        return None;
    }
    let data = command.get("data")?;
    let mut scoped = Vec::new();
    collect_summary_windows(data, &mut scoped);
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
                .and_then(|map| first_string(map, &["id", "bucketId", "bucket_id"]))
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
    if let Some(display_name) = first_string(group, &["name", "displayName", "display_name"]) {
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
            .and_then(|map| first_string(map, &["id", "bucketId", "bucket_id"]))
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
    let reset_at = first_string(map, &["reset_time", "resetTime"]);
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
        first_string(map, &["id", "bucketId", "bucket_id"])
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

/// Convert `remaining_fraction` (`0..=1` remaining) to xMatrix used percent
/// (`0..=100` used) without rounding. Proto3 JSON omits float fields at `0.0`,
/// so an omitted `remaining_fraction` alongside a `reset_time` means 0%
/// remaining (100% used).
fn used_percent_from_remaining_fraction(
    map: &Map<String, Value>,
    has_reset_time: bool,
) -> Option<f64> {
    let raw = map
        .get("remaining_fraction")
        .or_else(|| map.get("remainingFraction"));
    match raw.and_then(Value::as_f64) {
        Some(fraction) if fraction.is_finite() && (0.0..=1.0).contains(&fraction) => {
            Some(((1.0 - fraction) * 100.0).clamp(0.0, 100.0))
        }
        Some(_) => None,
        None if has_reset_time => Some(100.0),
        None => None,
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

    fn sample_cli_usage_payload() -> Value {
        serde_json::json!({
            "conversation_id": "",
            "status": "SUCCESS",
            "response": "Gemini Models\tWeekly Limit Remaining\t89%\t2026-11-28T09:31:21Z\n",
            "duration_seconds": 0,
            "num_turns": 0,
            "usage": {
                "input_tokens": 0,
                "output_tokens": 0,
                "thinking_tokens": 0,
                "cache_read_tokens": 0,
                "total_tokens": 0
            },
            "command": {
                "name": "usage",
                "data": {
                    "groups": [
                        {
                            "name": "Gemini Models",
                            "buckets": [
                                {
                                    "id": "gemini-weekly",
                                    "name": "Weekly Limit Remaining",
                                    "window": "weekly",
                                    "remaining_fraction": 0.8899799585342407,
                                    "reset_time": "2026-11-28T09:31:21Z"
                                },
                                {
                                    "id": "gemini-5h",
                                    "name": "Five Hour Limit Remaining",
                                    "window": "5h",
                                    "remaining_fraction": 0.9539,
                                    "reset_time": "2026-11-22T22:28:39Z"
                                }
                            ]
                        },
                        {
                            "name": "Claude and GPT models",
                            "buckets": [
                                {
                                    "id": "3p-weekly",
                                    "name": "Weekly Limit Remaining",
                                    "window": "weekly",
                                    "remaining_fraction": 1,
                                    "reset_time": "2026-11-29T17:30:43Z"
                                },
                                {
                                    "id": "3p-5h",
                                    "name": "Five Hour Limit Remaining",
                                    "window": "5h",
                                    "remaining_fraction": 0.75,
                                    "reset_time": "2026-11-22T22:30:43Z"
                                }
                            ]
                        }
                    ]
                }
            }
        })
    }

    #[test]
    fn parses_native_cli_usage_json_with_unrounded_float_precision() {
        let usage = antigravity_cli_usage_from_value(&sample_cli_usage_payload()).unwrap();
        assert_eq!(usage.quota_source.as_deref(), Some("provider_api"));
        assert!(usage.quota_observed_at.is_some());
        assert!(usage.quota_usages.is_none());
        let scoped = usage.scoped_quota_usages.unwrap();
        assert_eq!(scoped.len(), 4);

        assert_eq!(scoped[0].scope.as_deref(), Some("Gemini"));
        assert_eq!(scoped[0].label.as_deref(), Some("5h"));
        // Preserves floating-point precision rather than rounding to 5% (#1851).
        assert!((scoped[0].percent.unwrap() - 4.61).abs() < 1e-6);
        assert_eq!(scoped[0].reset_at.as_deref(), Some("2026-11-22T22:28:39Z"));

        assert_eq!(scoped[1].scope.as_deref(), Some("Claude & GPT"));
        assert_eq!(scoped[1].label.as_deref(), Some("5h"));
        assert!((scoped[1].percent.unwrap() - 25.0).abs() < 1e-6);

        assert_eq!(scoped[2].scope.as_deref(), Some("Gemini"));
        assert_eq!(scoped[2].label.as_deref(), Some("1w"));
        assert!((scoped[2].percent.unwrap() - 11.00200414657593).abs() < 1e-6);
        assert_eq!(scoped[2].reset_at.as_deref(), Some("2026-11-28T09:31:21Z"));

        assert_eq!(scoped[3].scope.as_deref(), Some("Claude & GPT"));
        assert_eq!(scoped[3].label.as_deref(), Some("1w"));
        assert_eq!(scoped[3].percent, Some(0.0));
    }

    #[test]
    fn proto3_omitted_remaining_fraction_with_reset_time_means_exhausted() {
        let payload = serde_json::json!({
            "status": "SUCCESS",
            "num_turns": 0,
            "command": {
                "name": "usage",
                "data": {
                    "groups": [{
                        "name": "Claude and GPT models",
                        "buckets": [
                            {
                                "id": "3p-5h",
                                "window": "5h",
                                "reset_time": "2026-11-22T16:00:00Z"
                            },
                            {
                                "id": "3p-weekly",
                                "window": "weekly",
                                "disabled": true,
                                "reset_time": "2026-11-29T11:00:00Z"
                            }
                        ]
                    }]
                }
            }
        });
        let usage = antigravity_cli_usage_from_value(&payload).unwrap();
        let scoped = usage.scoped_quota_usages.unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].scope.as_deref(), Some("Claude & GPT"));
        assert_eq!(scoped[0].label.as_deref(), Some("5h"));
        assert_eq!(scoped[0].percent, Some(100.0));
        assert_eq!(scoped[0].remaining, Some(0.0));
    }

    #[test]
    fn rejects_error_other_commands_and_llm_turn_outputs() {
        let error_payload = serde_json::json!({
            "status": "ERROR",
            "error": "authentication failed or timed out",
            "num_turns": 0
        });
        assert!(antigravity_cli_usage_from_value(&error_payload).is_none());

        let mut llm_turn = sample_cli_usage_payload();
        llm_turn["num_turns"] = serde_json::json!(1);
        assert!(antigravity_cli_usage_from_value(&llm_turn).is_none());

        let mut other_command = sample_cli_usage_payload();
        other_command["command"]["name"] = serde_json::json!("help");
        assert!(antigravity_cli_usage_from_value(&other_command).is_none());

        let empty_groups = serde_json::json!({
            "status": "SUCCESS",
            "num_turns": 0,
            "command": { "name": "usage", "data": { "groups": [] } }
        });
        assert!(antigravity_cli_usage_from_value(&empty_groups).is_none());
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
    fn semver_and_disable_switch_parsing() {
        assert_eq!(parse_cli_semver("1.5.14\n"), Some((1, 5, 14)));
        assert_eq!(parse_cli_semver("agy 1.1.11"), Some((1, 1, 11)));
        assert!(parse_cli_semver("1.1.10").unwrap() < MIN_PRINT_USAGE_CLI_VERSION);
        assert!(parse_cli_semver("1.1.11").unwrap() >= MIN_PRINT_USAGE_CLI_VERSION);

        for truthy in ["1", "true", "TRUE", "yes", " on "] {
            assert!(is_quota_probe_disabled_value(Some(truthy)), "{truthy:?}");
        }
        for falsy in ["", "0", "false", "no", "off"] {
            assert!(!is_quota_probe_disabled_value(Some(falsy)), "{falsy:?}");
        }
        assert!(!is_quota_probe_disabled_value(None));
    }

    #[test]
    fn cache_key_isolates_default_login_and_env_overrides_without_raw_secrets() {
        let home = PathBuf::from("/fixture/home");
        let empty = |_: &str| None;
        let with_dir =
            |key: &str| (key == "ANTIGRAVITY_APP_DATA_DIR").then(|| "/fixture/alt-agy".to_string());
        let with_token =
            |key: &str| (key == "JETSKI_OAUTH_TOKEN").then(|| "ya29.secret-value".to_string());

        let default_key = cache_key_for_mode(AgyEnvMode::DefaultLogin, &empty, Some(&home));
        let process_key = cache_key_for_mode(AgyEnvMode::Process, &empty, Some(&home));
        let dir_key = cache_key_for_mode(AgyEnvMode::Process, &with_dir, Some(&home));
        let token_key = cache_key_for_mode(AgyEnvMode::Process, &with_token, Some(&home));

        assert_ne!(default_key, process_key);
        assert_ne!(process_key, dir_key);
        assert_ne!(process_key, token_key);
        assert!(!token_key.contains("ya29.secret-value"));
    }

    #[test]
    fn detects_unauthenticated_stderr_prompts() {
        assert!(stderr_requests_interactive_auth(
            "Authentication required. Please visit the URL to log in:"
        ));
        assert!(stderr_requests_interactive_auth(
            "Waiting for authentication (timeout 60s)..."
        ));
        assert!(!stderr_requests_interactive_auth(
            "Fetching usage summary..."
        ));
    }

    #[test]
    fn default_login_command_removes_all_login_override_env_keys() {
        let cmd = build_agy_usage_command(Path::new("agy"), AgyEnvMode::DefaultLogin, None);
        let envs: Vec<(String, Option<String>)> = cmd
            .as_std()
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|val| val.to_string_lossy().into_owned()),
                )
            })
            .collect();
        for key in ANTIGRAVITY_LOGIN_OVERRIDE_KEYS {
            assert!(
                envs.iter().any(|(k, v)| k == key && v.is_none()),
                "expected {key} to be removed for DefaultLogin, got {envs:?}"
            );
        }
        assert!(
            envs.iter()
                .any(|(k, v)| k == "AGY_CLI_DISABLE_AUTO_UPDATE" && v.as_deref() == Some("true"))
        );

        let process_cmd = build_agy_usage_command(Path::new("agy"), AgyEnvMode::Process, None);
        let process_envs: Vec<_> = process_cmd.as_std().get_envs().collect();
        for key in ANTIGRAVITY_LOGIN_OVERRIDE_KEYS {
            assert!(
                !process_envs
                    .iter()
                    .any(|(k, v)| *k == OsStr::new(key) && v.is_none()),
                "Process mode must inherit {key}"
            );
        }
    }

    #[cfg(unix)]
    mod unix_cli_tests {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn unique_temp_dir(name: &str) -> PathBuf {
            let nanos = SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "xmatrix-agy-quota-{name}-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).expect("temp dir");
            dir
        }

        fn write_fake_agy(dir: &Path, script: &str) -> PathBuf {
            let path = dir.join("agy");
            std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).expect("write fake agy");
            let mut perms = std::fs::metadata(&path).expect("meta").permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&path, perms).expect("chmod");
            path
        }

        #[tokio::test]
        async fn invokes_native_usage_command_caches_and_invalidates() {
            let store =
                AntigravityQuotaStore::new(Duration::from_secs(180), Duration::from_secs(60));
            let dir = unique_temp_dir("native-usage");
            let count_file = dir.join("calls");
            let payload = sample_cli_usage_payload().to_string();
            let script = format!(
                r#"
if [ "$1" = "--version" ]; then
  echo "1.5.14"
  exit 0
fi
if [ "$1" = "-p" ] && [ "$2" = "/usage" ] && [ "$3" = "--output-format" ] && [ "$4" = "json" ]; then
  echo x >> "{}"
  printf '%s\n' '{}'
  exit 0
fi
exit 2
"#,
                count_file.display(),
                payload
            );
            let program = write_fake_agy(&dir, &script);
            let empty = |_: &str| None;

            let first = read_antigravity_quota_with_program(
                &store,
                &program,
                AgyEnvMode::DefaultLogin,
                true,
                Duration::from_secs(4),
                &empty,
                Some(&dir),
            )
            .await
            .expect("first reading");
            let scoped = first.scoped_quota_usages.as_ref().expect("scoped");
            assert_eq!(scoped.len(), 4);
            assert!((scoped[0].percent.unwrap() - 4.61).abs() < 1e-6);

            // Second non-forced read hits cache without spawning agy again.
            let second = read_antigravity_quota_with_program(
                &store,
                &program,
                AgyEnvMode::DefaultLogin,
                false,
                Duration::from_secs(4),
                &empty,
                Some(&dir),
            )
            .await
            .expect("cached reading");
            assert_eq!(second.quota_observed_at, first.quota_observed_at);
            assert_eq!(
                std::fs::read_to_string(&count_file)
                    .unwrap()
                    .lines()
                    .count(),
                1
            );

            // Invalidating cache forces a fresh subprocess on the next read.
            store.invalidate();
            let third = read_antigravity_quota_with_program(
                &store,
                &program,
                AgyEnvMode::DefaultLogin,
                false,
                Duration::from_secs(4),
                &empty,
                Some(&dir),
            )
            .await
            .expect("post-invalidation reading");
            assert_eq!(third.scoped_quota_usages.unwrap().len(), 4);
            assert_eq!(
                std::fs::read_to_string(&count_file)
                    .unwrap()
                    .lines()
                    .count(),
                2
            );

            let _ = std::fs::remove_dir_all(&dir);
        }

        #[tokio::test]
        async fn old_agy_version_never_invokes_print_usage() {
            let store =
                AntigravityQuotaStore::new(Duration::from_secs(180), Duration::from_secs(60));
            let dir = unique_temp_dir("old-version");
            let marker = dir.join("prompt-invoked");
            let script = format!(
                r#"
if [ "$1" = "--version" ]; then
  echo "1.1.10"
  exit 0
fi
echo invoked > "{}"
exit 0
"#,
                marker.display()
            );
            let program = write_fake_agy(&dir, &script);
            let empty = |_: &str| None;

            let result = read_antigravity_quota_with_program(
                &store,
                &program,
                AgyEnvMode::DefaultLogin,
                true,
                Duration::from_secs(4),
                &empty,
                Some(&dir),
            )
            .await;
            assert!(result.is_none());
            assert!(
                !marker.exists(),
                "older agy releases must not be called with -p /usage"
            );
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[tokio::test]
        async fn signed_out_auth_prompt_aborts_quickly_without_waiting_for_timeout() {
            let store =
                AntigravityQuotaStore::new(Duration::from_secs(180), Duration::from_secs(60));
            let dir = unique_temp_dir("signed-out");
            let script = r#"
if [ "$1" = "--version" ]; then
  echo "1.5.14"
  exit 0
fi
echo "Authentication required. Please visit the URL to log in:" >&2
echo "  https://accounts.google.com/o/oauth2/auth" >&2
sleep 30
"#;
            let program = write_fake_agy(&dir, script);
            let empty = |_: &str| None;
            let started = std::time::Instant::now();

            let result = read_antigravity_quota_with_program(
                &store,
                &program,
                AgyEnvMode::DefaultLogin,
                true,
                Duration::from_secs(5),
                &empty,
                Some(&dir),
            )
            .await;
            assert!(result.is_none());
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "expected fast abort on auth prompt, took {:?}",
                started.elapsed()
            );
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[tokio::test]
        async fn hanging_cli_respects_timeout_and_discards_on_midflight_invalidation() {
            let store =
                AntigravityQuotaStore::new(Duration::from_secs(180), Duration::from_secs(60));
            let dir = unique_temp_dir("timeout-and-invalidation");
            let hang_script = r#"
if [ "$1" = "--version" ]; then
  echo "1.5.14"
  exit 0
fi
sleep 30
"#;
            let hang_program = write_fake_agy(&dir, hang_script);
            let empty = |_: &str| None;
            let started = std::time::Instant::now();
            let timed_out = read_antigravity_quota_with_program(
                &store,
                &hang_program,
                AgyEnvMode::DefaultLogin,
                true,
                Duration::from_millis(200),
                &empty,
                Some(&dir),
            )
            .await;
            assert!(timed_out.is_none());
            assert!(started.elapsed() < Duration::from_secs(2));

            let slow_dir = unique_temp_dir("midflight-switch");
            let payload = sample_cli_usage_payload().to_string();
            let slow_script = format!(
                r#"
if [ "$1" = "--version" ]; then
  echo "1.5.14"
  exit 0
fi
sleep 0.3
printf '%s\n' '{}'
"#,
                payload
            );
            let slow_program = write_fake_agy(&slow_dir, &slow_script);
            let read_fut = read_antigravity_quota_with_program(
                &store,
                &slow_program,
                AgyEnvMode::DefaultLogin,
                true,
                Duration::from_secs(4),
                &empty,
                Some(&slow_dir),
            );
            let invalidate_fut = async {
                tokio::time::sleep(Duration::from_millis(120)).await;
                store.invalidate();
            };
            let (result, ()) = tokio::join!(read_fut, invalidate_fut);
            assert!(
                result.is_none(),
                "reading from before account switch must be discarded"
            );

            let _ = std::fs::remove_dir_all(&dir);
            let _ = std::fs::remove_dir_all(&slow_dir);
        }
    }

    #[tokio::test]
    async fn live_e2e_antigravity_quota_reader() {
        if std::env::var("XMATRIX_LIVE_QUOTA_E2E").ok().as_deref() != Some("1") {
            return;
        }
        let usage = read_antigravity_quota_usage(true)
            .await
            .expect("antigravity quota should resolve via native agy /usage");
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
