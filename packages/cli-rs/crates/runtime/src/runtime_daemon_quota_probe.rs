//! Read-only execution of the bounded `machine_quota_probe` machine command.
//!
//! The daemon resolves each registration target (`registration:<harness>`)
//! exactly as a registered spawn of it would: through the daemon's own
//! environment, with no local overlay. It then reads the provider quota bound
//! to the credential that spawn would use. It never starts a Run, never
//! resolves a target it does not recognise, and reports `unavailable` (with a
//! reason) instead of inventing a reading.
use std::path::PathBuf;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use xmatrix_cli_agent::agent_preset_by_id;
use xmatrix_cli_core::machine_daemon_connection::{
    MachineDaemonCommandLease, MachineDaemonReport, MachineQuotaProbeRequest,
    MachineQuotaProbeResultProbe, MachineQuotaProbeTarget, MachineQuotaProbeTargetResult,
    MachineQuotaProbeWindow,
};
use xmatrix_cli_core::protocol::{LlmQuotaUsage, LlmUsage};
use xmatrix_harness::quota::{self, Account, Provider, ReadOptions};

/// The protocol caps a probe at this many targets.
const MAX_PROBE_TARGETS: usize = 32;
/// The whole probe (all targets) must finish inside this budget.
const PROBE_TOTAL_BUDGET: Duration = Duration::from_secs(10);
/// One slow provider must not consume the budget of every later target.
const PROBE_TARGET_BUDGET: Duration = Duration::from_secs(5);
/// The Hub rejects an observed result with more windows than this.
const MAX_PROBE_WINDOWS: usize = 8;
/// The Hub rejects a window label longer than this many bytes.
const MAX_WINDOW_LABEL_BYTES: usize = 24;
/// The longest window scope (a model family, a pool) the Hub accepts.
const MAX_SCOPE_BYTES: usize = 64;
/// A registration target names its harness; owner and machine are this daemon.
const REGISTRATION_TARGET_PREFIX: &str = "registration:";
/// The harness is read only under its owner's grant on this machine, and there
/// is none (never given, revoked, or voided by another sign-in).
const NOT_GRANTED: &str = "not_granted";

/// The owner has not allowed reading this harness's sign-in on this machine.
#[derive(Debug, PartialEq, Eq)]
struct NotGranted;

pub(crate) async fn execute_machine_quota_probe(
    request_id: String,
    probe: MachineQuotaProbeRequest,
    relay_lease: Option<MachineDaemonCommandLease>,
) -> MachineDaemonReport {
    let deadline = Instant::now() + PROBE_TOTAL_BUDGET;
    let disabled = xmatrix_cli_core::config::quota_probes_disabled();
    let mut results = Vec::with_capacity(probe.targets.len().min(MAX_PROBE_TARGETS));
    for target in probe.targets.iter().take(MAX_PROBE_TARGETS) {
        if disabled {
            results.push(unavailable(target, "configuration_unavailable"));
        } else {
            results.push(probe_one_target(target, deadline, probe.fresh).await);
        }
    }
    accept_only_what_the_hub_asked(&mut results, &probe);
    MachineDaemonReport::MachineQuotaProbeResult {
        request_id,
        probe: MachineQuotaProbeResultProbe {
            request_id: probe.request_id,
            connection_epoch: probe.connection_epoch,
            results,
        },
        relay_lease,
    }
}

fn unavailable(target: &MachineQuotaProbeTarget, reason: &str) -> MachineQuotaProbeTargetResult {
    MachineQuotaProbeTargetResult {
        target_id: target.target_id.clone(),
        configuration_digest: target.configuration_digest.clone(),
        status: "unavailable".to_string(),
        quota_source: None,
        quota_observed_at: None,
        quota_usages: Vec::new(),
        scoped_quota_usages: None,
        quota_account: None,
        reason: Some(reason.to_string()),
    }
}

/// The only failure `read_with_budget` reports; the caller maps it to a
/// `timeout` result.
enum ReadOutcome {
    Timeout,
}

/// Run the reader inside the probe's remaining budget.
///
/// The deadline bounds the whole probe, so the reader future is wrapped rather
/// than only checked before the call: a reader that hangs past the budget is
/// cancelled instead of extending the probe.
async fn read_with_budget<F, Fut, T>(deadline: Instant, read: F) -> Result<T, ReadOutcome>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = T>,
{
    let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
        return Err(ReadOutcome::Timeout);
    };
    match tokio::time::timeout(remaining, read()).await {
        Ok(usage) => Ok(usage),
        Err(_) => Err(ReadOutcome::Timeout),
    }
}

/// The provider account a spawn of the target would run under.
#[derive(Clone, Debug, PartialEq, Eq)]
enum QuotaAccount {
    /// ChatGPT quota of the Codex config home.
    Codex(PathBuf),
    /// Grok Build billing of the Grok config home's `auth.json`.
    Grok(PathBuf),
    /// Claude subscription of the default Claude Code login.
    ClaudeDefault,
    /// Cursor subscription of the default Cursor Agent login.
    CursorDefault,
    /// The OpenCode Console workspace `opencode serve` is signed in to.
    OpenCodeDefault,
    /// Prepaid balance of the API key DeepSeek Harness holds.
    DeepSeekDefault,
    /// Google Antigravity (`agy`) default OAuth login.
    AntigravityDefault,
}

impl QuotaAccount {
    fn digest_parts(&self) -> (&'static str, String) {
        match self {
            Self::Codex(home) => ("codex", home.to_string_lossy().into_owned()),
            Self::Grok(home) => ("grok", home.to_string_lossy().into_owned()),
            Self::ClaudeDefault => ("claude", "default-login".to_string()),
            Self::CursorDefault => ("cursor", "default-login".to_string()),
            Self::OpenCodeDefault => ("opencode", "default-login".to_string()),
            Self::DeepSeekDefault => ("deepseek", "default-login".to_string()),
            Self::AntigravityDefault => ("antigravity", "default-login".to_string()),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Resolution {
    /// The account plus a digest that changes when the resolved configuration
    /// changes, so a reading taken under another configuration is discarded.
    Account {
        account: QuotaAccount,
        digest: String,
    },
    /// Unknown target, or a harness with no pre-launch quota reader.
    Unsupported,
    /// Known target whose spawn could use a credential this reader cannot
    /// prove it reads (inherited token, relocated config, no home).
    ConfigurationUnavailable,
}

/// Keys every spawn removes from the daemon's inherited environment before it
/// applies the target's own values (see `spawn_headless_agent`). Only the ones
/// that choose a provider credential matter here.
const SPAWN_REMOVED_KEYS: &[&str] = &[
    "CODEX_HOME",
    "GROK_HOME",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
];

/// The environment a registered spawn hands its runtime: the daemon's own,
/// less the keys every spawn removes.
struct SpawnEnv<'a> {
    inherited: &'a dyn Fn(&str) -> Option<String>,
}

impl SpawnEnv<'_> {
    /// The non-empty value the spawned runtime would see for `key`, or `None`.
    fn effective(&self, key: &str) -> Option<String> {
        if SPAWN_REMOVED_KEYS.contains(&key) {
            return None;
        }
        (self.inherited)(key)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    fn any_effective(&self, keys: &[&str]) -> bool {
        keys.iter().any(|key| self.effective(key).is_some())
    }
}

/// Everything resolution reads from the host, injectable for tests.
struct HostView<'a> {
    inherited: &'a dyn Fn(&str) -> Option<String>,
    /// The daemon's home, which every registered spawn shares.
    home: Option<PathBuf>,
}

fn resolve_target(target_id: &str) -> Resolution {
    let inherited = |key: &str| std::env::var(key).ok();
    resolve_target_on(
        target_id,
        &HostView {
            inherited: &inherited,
            home: xmatrix_harness::home_dir_path(),
        },
    )
}

/// Resolve a registration target's quota account exactly as a registered
/// spawn of its harness would, through the shared preset registry. Anything
/// else is not a target and never falls back to another account.
fn resolve_target_on(target_id: &str, host: &HostView<'_>) -> Resolution {
    let Some(harness) = target_id.strip_prefix(REGISTRATION_TARGET_PREFIX) else {
        return Resolution::Unsupported;
    };
    let Some(preset) = agent_preset_by_id(harness).filter(|preset| preset.id == harness) else {
        return Resolution::Unsupported;
    };
    let spawn = SpawnEnv {
        inherited: host.inherited,
    };
    if quota::quota_probes_disabled_in(|key| spawn.effective(key)) {
        return Resolution::ConfigurationUnavailable;
    }
    let account = match preset.id.as_str() {
        // Every spawn removes the daemon's own CODEX_HOME.
        "codex" => match host.home.as_ref() {
            Some(home) => QuotaAccount::Codex(home.join(".codex")),
            None => return Resolution::ConfigurationUnavailable,
        },
        "grok" => {
            // The reader reads `<home>/.grok/auth.json`. An inherited token may
            // or may not reach the runtime (a sandboxed runtime drops it), so
            // it is not an account this reader can vouch for.
            if spawn.any_effective(&["GROK_CLI_OAUTH_TOKEN"]) {
                return Resolution::ConfigurationUnavailable;
            }
            match host.home.as_ref() {
                Some(home) => QuotaAccount::Grok(home.join(".grok")),
                None => return Resolution::ConfigurationUnavailable,
            }
        }
        "claude" => {
            // The reader asks a `claude` started without login overrides, so
            // Claude Code reads its own default login. Any token, API key,
            // gateway, or relocated config dir means the spawn may bill
            // another account.
            if spawn.any_effective(quota::claude::CLAUDE_LOGIN_OVERRIDE_KEYS) || host.home.is_none()
            {
                return Resolution::ConfigurationUnavailable;
            }
            QuotaAccount::ClaudeDefault
        }
        "cursor" => {
            // The reader prefers CURSOR_API_KEY / CURSOR_AUTH_TOKEN, then the
            // macOS login keychain item `cursor-access-token`, then CLI
            // auth.json under APPDATA/Cursor or ~/.cursor. Those are the
            // account a default registered spawn bills. It opens none of them
            // without the owner's grant on this machine (`read_account`).
            QuotaAccount::CursorDefault
        }
        // OpenCode is asked through `opencode serve`, which reads its own
        // sign-in exactly as a spawn of it would.
        "opencode" => QuotaAccount::OpenCodeDefault,
        // The reader resolves the key DeepSeek Harness would: its stored
        // credential file first, then the environment the spawn inherits.
        "deepseek" => QuotaAccount::DeepSeekDefault,
        "antigravity" => {
            if quota::antigravity::is_quota_probe_disabled_in(|key| spawn.effective(key))
                || spawn.any_effective(quota::antigravity::ANTIGRAVITY_LOGIN_OVERRIDE_KEYS)
                || host.home.is_none()
            {
                return Resolution::ConfigurationUnavailable;
            }
            QuotaAccount::AntigravityDefault
        }
        _ => return Resolution::Unsupported,
    };
    let (provider_tag, location) = account.digest_parts();
    let mut hasher = Sha256::new();
    for part in [target_id, provider_tag, location.as_str()] {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    Resolution::Account {
        account,
        digest: crate::lowercase_hex(&hasher.finalize()),
    }
}

async fn read_account(account: QuotaAccount, fresh: bool) -> Result<Option<LlmUsage>, NotGranted> {
    // Respect each reader's short success TTL: a probe is not a reason to
    // hammer the provider, and a cached reading keeps its observation time.
    // A fresh probe checks a refusal, which only a newer reading can answer;
    // the Hub sends one per target and joins concurrent askers to it.
    let (provider, account) = match account {
        QuotaAccount::Codex(home) => (Provider::Codex, Account::Home(home)),
        QuotaAccount::Grok(home) => (Provider::Grok, Account::Home(home)),
        QuotaAccount::ClaudeDefault => (Provider::Claude, Account::DefaultLogin),
        QuotaAccount::CursorDefault => {
            // No official quota interface: read only under the owner's grant.
            return match xmatrix_cli_core::quota_access::read_granted_quota("cursor", fresh).await {
                xmatrix_cli_core::quota_access::GrantedQuota::Usage(usage) => Ok(usage),
                xmatrix_cli_core::quota_access::GrantedQuota::ProbesOff => Ok(None),
                xmatrix_cli_core::quota_access::GrantedQuota::NotGranted => Err(NotGranted),
            };
        }
        QuotaAccount::OpenCodeDefault => (Provider::OpenCode, Account::Process),
        QuotaAccount::DeepSeekDefault => (Provider::DeepSeek, Account::Process),
        QuotaAccount::AntigravityDefault => (Provider::Antigravity, Account::DefaultLogin),
    };
    Ok(quota::read(
        provider,
        ReadOptions {
            account,
            force: fresh,
        },
    )
    .await)
}

async fn probe_one_target(
    target: &MachineQuotaProbeTarget,
    deadline: Instant,
    fresh: bool,
) -> MachineQuotaProbeTargetResult {
    probe_one_target_with(target, deadline, resolve_target, |account| {
        read_account(account, fresh)
    })
    .await
}

async fn probe_one_target_with<R, F, Fut>(
    target: &MachineQuotaProbeTarget,
    deadline: Instant,
    resolve: R,
    read: F,
) -> MachineQuotaProbeTargetResult
where
    R: Fn(&str) -> Resolution,
    F: FnOnce(QuotaAccount) -> Fut,
    Fut: std::future::Future<Output = Result<Option<LlmUsage>, NotGranted>>,
{
    if Instant::now() >= deadline {
        return unavailable(target, "timeout");
    }
    let (account, before) = match resolve(&target.target_id) {
        Resolution::Account { account, digest } => (account, digest),
        Resolution::Unsupported => return unavailable(target, "unsupported"),
        Resolution::ConfigurationUnavailable => {
            return unavailable(target, "configuration_unavailable");
        }
    };
    let target_deadline = deadline.min(Instant::now() + PROBE_TARGET_BUDGET);
    let usage = match read_with_budget(target_deadline, || read(account)).await {
        Ok(Ok(usage)) => usage,
        Ok(Err(NotGranted)) => return unavailable(target, NOT_GRANTED),
        Err(ReadOutcome::Timeout) => return unavailable(target, "timeout"),
    };
    // Re-resolve after the read: a target whose configuration changed mid-read
    // must not report a reading taken under a different configuration.
    match resolve(&target.target_id) {
        Resolution::Account { digest, .. } if digest == before => {}
        _ => return unavailable(target, "configuration_unavailable"),
    }
    match usage {
        Some(usage) => observed_result(target, usage),
        None => unavailable(target, "provider_unavailable"),
    }
}

/// An `observed` result, or `provider_unavailable` when the reading cannot be
/// one: the Hub rejects the whole response for a single observed result
/// without a `provider_api` source, an observation time, or a usable window.
fn observed_result(
    target: &MachineQuotaProbeTarget,
    usage: LlmUsage,
) -> MachineQuotaProbeTargetResult {
    let probe_windows = |windows: Option<&[LlmQuotaUsage]>, scoped: bool| {
        windows
            .unwrap_or_default()
            .iter()
            .filter_map(|window| probe_window(window, scoped))
            .take(MAX_PROBE_WINDOWS)
            .collect::<Vec<_>>()
    };
    let quota_usages = probe_windows(usage.quota_usages.as_deref(), false);
    let scoped_quota_usages = usage
        .scoped_quota_usages
        .as_deref()
        .map(|windows| probe_windows(Some(windows), true));
    let mut result = MachineQuotaProbeTargetResult {
        target_id: target.target_id.clone(),
        configuration_digest: target.configuration_digest.clone(),
        status: "observed".to_string(),
        quota_source: usage.quota_source.clone(),
        quota_observed_at: usage.quota_observed_at.clone(),
        quota_usages,
        scoped_quota_usages,
        quota_account: usage.quota_account.clone(),
        reason: None,
    };
    // A prepaid account has no window: its reading is the balance alone.
    let balance_only =
        usage.quota_usages.as_deref().unwrap_or_default().is_empty() && has_balance(&result);
    if (!has_window(&result) && !balance_only)
        || usage.quota_source.as_deref() != Some("provider_api")
        || usage.quota_observed_at.is_none()
    {
        result = unavailable(target, "provider_unavailable");
    }
    result
}

/// A window the Hub accepts, or `None`: a percent in 0..=100, and for a scoped
/// window a scope it can store. A bad label is dropped, not the window.
fn probe_window(window: &LlmQuotaUsage, scoped: bool) -> Option<MachineQuotaProbeWindow> {
    let percent = window
        .percent
        .filter(|percent| (0.0..=100.0).contains(percent))?;
    let scope = if scoped {
        Some(probe_text(window.scope.as_deref(), MAX_SCOPE_BYTES)?)
    } else {
        None
    };
    Some(MachineQuotaProbeWindow {
        percent,
        reset_at: window.reset_at.clone(),
        label: probe_text(window.label.as_deref(), MAX_WINDOW_LABEL_BYTES),
        scope,
    })
}

fn has_window(result: &MachineQuotaProbeTargetResult) -> bool {
    !result.quota_usages.is_empty()
        || result
            .scoped_quota_usages
            .as_ref()
            .is_some_and(|windows| !windows.is_empty())
}

fn has_balance(result: &MachineQuotaProbeTargetResult) -> bool {
    result
        .quota_account
        .as_ref()
        .and_then(|account| account.credits.as_ref())
        .is_some_and(|credits| credits.balance.is_some())
}

/// The Hub rejects the whole response for one field it did not ask for, so
/// each optional part travels only when the probe asked for it, and a reading
/// left with nothing the Hub accepts becomes `provider_unavailable`.
fn accept_only_what_the_hub_asked(
    results: &mut [MachineQuotaProbeTargetResult],
    probe: &MachineQuotaProbeRequest,
) {
    for result in results {
        if !probe.window_labels {
            for window in &mut result.quota_usages {
                window.label = None;
            }
        }
        if !probe.scoped_quota_usages {
            result.scoped_quota_usages = None;
        }
        if !probe.quota_account {
            result.quota_account = None;
        }
        // A Hub that did not ask about grants reads a missing grant as a
        // configuration this daemon cannot read under.
        if !probe.access_grants && result.reason.as_deref() == Some(NOT_GRANTED) {
            result.reason = Some("configuration_unavailable".to_string());
        }
        // Scoped windows alone stand only for a Hub that asked for them, and
        // a balance alone only for a Hub that asked for it.
        let balance_only = probe.account_balance && has_balance(result);
        if result.status == "observed" && !has_window(result) && !balance_only {
            *result = unavailable(
                &MachineQuotaProbeTarget {
                    target_id: std::mem::take(&mut result.target_id),
                    configuration_digest: std::mem::take(&mut result.configuration_digest),
                },
                "provider_unavailable",
            );
        }
    }
}

/// Text the Hub accepts: trimmed, non-empty and short; anything else is
/// dropped rather than failing the whole reading.
fn probe_text(text: Option<&str>, max_bytes: usize) -> Option<String> {
    text.filter(|text| !text.is_empty() && text.trim() == *text && text.len() <= max_bytes)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A probe for one target that asks for the given optional parts.
    fn asking(parts: serde_json::Value) -> MachineQuotaProbeRequest {
        let mut probe = serde_json::json!({ "requestId": "quota:1", "connectionEpoch": 3,
            "targets": [{ "targetId": "registration:claude", "configurationDigest": "d" }] });
        probe
            .as_object_mut()
            .unwrap()
            .extend(parts.as_object().unwrap().clone());
        serde_json::from_value(probe).expect("probe")
    }

    fn target(target_id: &str, digest: &str) -> MachineQuotaProbeTarget {
        MachineQuotaProbeTarget {
            target_id: target_id.to_string(),
            configuration_digest: digest.to_string(),
        }
    }

    #[test]
    fn a_target_that_is_not_a_registration_is_unsupported() {
        // Only `registration:<harness>` names a target; nothing else may
        // resolve to an account, so nothing else can read the daemon's own.
        assert_eq!(
            resolve_target("profile:does-not-exist:probe-test"),
            Resolution::Unsupported
        );
    }

    #[tokio::test]
    async fn probe_caps_targets_and_echoes_digests() {
        let probe = MachineQuotaProbeRequest {
            request_id: "probe-1".to_string(),
            connection_epoch: 7,
            targets: (0..(MAX_PROBE_TARGETS + 5))
                .map(|index| target(&format!("profile:missing:{index}"), &format!("d{index}")))
                .collect(),
            window_labels: false,
            quota_account: false,
            fresh: false,
            account_balance: false,
            scoped_quota_usages: false,
            access_grants: false,
        };
        let report = execute_machine_quota_probe("cmd-1".to_string(), probe, None).await;
        let MachineDaemonReport::MachineQuotaProbeResult {
            request_id,
            probe,
            relay_lease,
        } = report
        else {
            panic!("expected quota probe result");
        };
        assert_eq!(request_id, "cmd-1");
        assert_eq!(probe.request_id, "probe-1");
        assert_eq!(probe.connection_epoch, 7);
        assert!(relay_lease.is_none());
        assert_eq!(probe.results.len(), MAX_PROBE_TARGETS);
        for (index, result) in probe.results.iter().enumerate() {
            assert_eq!(result.target_id, format!("profile:missing:{index}"));
            assert_eq!(result.configuration_digest, format!("d{index}"));
            assert_eq!(result.status, "unavailable");
            assert_eq!(result.reason.as_deref(), Some("unsupported"));
            assert!(result.quota_source.is_none());
            assert!(result.quota_usages.is_empty());
        }
    }

    fn provider_usage(windows: Vec<LlmQuotaUsage>) -> LlmUsage {
        LlmUsage {
            quota_source: Some("provider_api".to_string()),
            quota_observed_at: Some("2026-09-21T18:00:00Z".to_string()),
            quota_usages: Some(windows),
            ..Default::default()
        }
    }

    #[test]
    fn observed_result_maps_windows_and_drops_malformed_ones() {
        let usage = provider_usage(vec![
            LlmQuotaUsage {
                label: Some("1w".to_string()),
                percent: Some(100.0),
                reset_at: Some("1790423712".to_string()),
                ..Default::default()
            },
            LlmQuotaUsage {
                label: Some("bad".to_string()),
                percent: Some(140.0),
                ..Default::default()
            },
        ]);
        let result = observed_result(&target("profile:codex", "digest-1"), usage);
        assert_eq!(result.status, "observed");
        assert_eq!(result.configuration_digest, "digest-1");
        assert_eq!(result.quota_source.as_deref(), Some("provider_api"));
        assert_eq!(
            result.quota_observed_at.as_deref(),
            Some("2026-09-21T18:00:00Z"),
            "the original observation time is preserved"
        );
        assert_eq!(result.quota_usages.len(), 1);
        assert_eq!(result.quota_usages[0].percent, 100.0);
        assert_eq!(
            result.quota_usages[0].reset_at.as_deref(),
            Some("1790423712")
        );
        assert_eq!(result.quota_usages[0].label.as_deref(), Some("1w"));
    }

    #[test]
    fn a_balance_only_reading_travels_only_when_the_hub_asked() {
        let usage = LlmUsage {
            quota_source: Some("provider_api".to_string()),
            quota_observed_at: Some("2026-09-21T18:00:00Z".to_string()),
            quota_account: Some(xmatrix_cli_core::protocol::LlmQuotaAccount {
                allowed: Some(true),
                credits: Some(xmatrix_cli_core::protocol::LlmQuotaCredits {
                    balance: Some(12.34),
                    currency: Some("CNY".to_string()),
                    unlimited: false,
                }),
            }),
            ..LlmUsage::default()
        };
        let mut results = vec![observed_result(
            &target("registration:deepseek", "d"),
            usage,
        )];
        let wire = serde_json::to_value(&results[0]).expect("observed json");
        assert_eq!(wire["status"], "observed");
        assert!(wire.get("quotaUsages").is_none());
        assert_eq!(wire["quotaAccount"]["credits"]["balance"], 12.34);
        assert_eq!(wire["quotaAccount"]["credits"]["currency"], "CNY");

        let mut asked = results.clone();
        accept_only_what_the_hub_asked(
            &mut asked,
            &asking(serde_json::json!({ "quotaAccount": true, "accountBalance": true })),
        );
        assert_eq!(asked[0].status, "observed");

        accept_only_what_the_hub_asked(
            &mut results,
            &asking(serde_json::json!({ "quotaAccount": true })),
        );
        let wire = serde_json::to_value(&results[0]).expect("unavailable json");
        assert_eq!(
            wire,
            serde_json::json!({ "targetId": "registration:deepseek", "configurationDigest": "d",
                "status": "unavailable", "reason": "provider_unavailable" })
        );
    }

    #[test]
    fn quota_account_travels_only_when_the_hub_asked() {
        let mut usage = provider_usage(vec![LlmQuotaUsage {
            percent: Some(100.0),
            ..Default::default()
        }]);
        usage.quota_account = Some(xmatrix_cli_core::protocol::LlmQuotaAccount {
            allowed: Some(true),
            credits: None,
        });
        let mut results = vec![observed_result(&target("registration:codex", "d"), usage)];
        let wire = serde_json::to_value(&results[0]).expect("observed json");
        assert_eq!(wire["quotaAccount"]["allowed"], true);

        accept_only_what_the_hub_asked(&mut results, &asking(serde_json::json!({})));
        let wire = serde_json::to_value(&results[0]).expect("observed json");
        assert!(wire.get("quotaAccount").is_none());
        let probe: MachineQuotaProbeRequest = serde_json::from_value(serde_json::json!({
            "requestId": "quota:1", "connectionEpoch": 3, "targets": [], "quotaAccount": true,
        }))
        .expect("probe with quotaAccount");
        assert!(probe.quota_account);
    }

    #[test]
    fn window_labels_travel_only_when_the_hub_asked() {
        let usage = provider_usage(vec![
            LlmQuotaUsage {
                label: Some("5h".to_string()),
                percent: Some(40.0),
                ..Default::default()
            },
            LlmQuotaUsage {
                label: Some(" padded ".to_string()),
                percent: Some(10.0),
                ..Default::default()
            },
            LlmQuotaUsage {
                label: Some("x".repeat(MAX_WINDOW_LABEL_BYTES + 1)),
                percent: Some(10.0),
                ..Default::default()
            },
        ]);
        let mut results = vec![observed_result(&target("registration:claude", "d"), usage)];
        let labels: Vec<_> = results[0]
            .quota_usages
            .iter()
            .map(|window| window.label.clone())
            .collect();
        assert_eq!(labels, vec![Some("5h".to_string()), None, None]);
        let wire = serde_json::to_value(&results[0]).expect("observed json");
        assert_eq!(wire["quotaUsages"][0]["label"], "5h");
        assert!(wire["quotaUsages"][1].get("label").is_none());

        accept_only_what_the_hub_asked(&mut results, &asking(serde_json::json!({})));
        let wire = serde_json::to_value(&results[0]).expect("observed json");
        assert!(wire["quotaUsages"][0].get("label").is_none());
    }

    /// The Claude reading of 2026-11-15: Fable's own week used up.
    fn claude_reading() -> LlmUsage {
        use crate::runtime_usage_limit::claude_test_window as window;
        LlmUsage {
            scoped_quota_usages: Some(vec![
                window(
                    "1w",
                    100.0,
                    "2026-11-19T17:59:59.768897+00:00",
                    Some("Fable"),
                ),
                window("1w", 100.0, "2026-11-19T18:00:00+00:00", Some(" padded ")),
            ]),
            ..provider_usage(vec![
                window("5h", 0.0, "2026-11-15T23:00:00.312470+00:00", None),
                window("1w", 55.0, "2026-11-19T17:59:59.768880+00:00", None),
            ])
        }
    }

    #[test]
    fn scoped_windows_travel_only_when_the_hub_asked() {
        let result = observed_result(&target("registration:claude", "d"), claude_reading());

        let mut asked = vec![result.clone()];
        accept_only_what_the_hub_asked(
            &mut asked,
            &asking(serde_json::json!({ "windowLabels": true, "scopedQuotaUsages": true })),
        );
        let wire = serde_json::to_value(&asked[0]).expect("observed json");
        assert_eq!(wire["quotaUsages"].as_array().unwrap().len(), 2);
        assert!(wire["quotaUsages"][1].get("scope").is_none());
        // A scope the Hub could not store drops its window, not the reading.
        assert_eq!(
            wire["scopedQuotaUsages"],
            serde_json::json!([{ "percent": 100.0, "label": "1w", "scope": "Fable",
                "resetAt": "2026-11-19T17:59:59.768897+00:00" }])
        );

        // An older Hub reads the account windows only, never a scoped one.
        let mut older = vec![result];
        accept_only_what_the_hub_asked(
            &mut older,
            &asking(serde_json::json!({ "windowLabels": true })),
        );
        let wire = serde_json::to_value(&older[0]).expect("observed json");
        assert!(wire.get("scopedQuotaUsages").is_none());
        assert_eq!(wire["quotaUsages"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_reading_of_pools_alone_stands_only_for_a_hub_that_asked() {
        // Cursor with Auto and API pools has no account window at all.
        let pools = LlmUsage {
            quota_usages: None,
            scoped_quota_usages: Some(vec![LlmQuotaUsage {
                label: Some("1mo".to_string()),
                percent: Some(59.0),
                scope: Some("Auto".to_string()),
                ..Default::default()
            }]),
            ..provider_usage(Vec::new())
        };
        let result = observed_result(&target("registration:cursor", "d"), pools);
        assert_eq!(result.status, "observed");

        let mut asked = vec![result.clone()];
        accept_only_what_the_hub_asked(
            &mut asked,
            &asking(serde_json::json!({ "scopedQuotaUsages": true })),
        );
        let wire = serde_json::to_value(&asked[0]).expect("observed json");
        assert!(wire.get("quotaUsages").is_none());
        assert_eq!(wire["scopedQuotaUsages"][0]["scope"], "Auto");

        let mut older = vec![result];
        accept_only_what_the_hub_asked(&mut older, &asking(serde_json::json!({})));
        assert_eq!(older[0].status, "unavailable");
        assert_eq!(older[0].reason.as_deref(), Some("provider_unavailable"));
    }

    #[test]
    fn a_probe_without_window_labels_still_parses() {
        let probe: MachineQuotaProbeRequest = serde_json::from_value(serde_json::json!({
            "requestId": "quota:1", "connectionEpoch": 3,
            "targets": [{ "targetId": "registration:claude", "configurationDigest": "d" }],
        }))
        .expect("probe");
        assert!(!probe.window_labels);
        let probe: MachineQuotaProbeRequest = serde_json::from_value(serde_json::json!({
            "requestId": "quota:1", "connectionEpoch": 3, "windowLabels": true,
            "targets": [{ "targetId": "registration:claude", "configurationDigest": "d" }],
        }))
        .expect("probe");
        assert!(probe.window_labels);
        assert!(
            !probe.fresh,
            "a probe that does not ask may answer from the cache"
        );
        let probe: MachineQuotaProbeRequest = serde_json::from_value(serde_json::json!({
            "requestId": "quota:1", "connectionEpoch": 3, "fresh": true,
            "targets": [{ "targetId": "registration:claude", "configurationDigest": "d" }],
        }))
        .expect("probe");
        assert!(
            probe.fresh,
            "a probe that checks a refusal reads the provider now"
        );
    }

    #[test]
    fn observed_wire_uses_quota_source_and_unavailable_is_minimal() {
        let usage = provider_usage(vec![LlmQuotaUsage {
            label: Some("1w".to_string()),
            percent: Some(12.0),
            reset_at: Some("1790579768".to_string()),
            ..Default::default()
        }]);
        let observed =
            serde_json::to_value(observed_result(&target("profile:codex", "digest-1"), usage))
                .expect("observed json");
        assert_eq!(observed["status"], "observed");
        assert_eq!(observed["quotaSource"], "provider_api");
        assert_eq!(observed["quotaObservedAt"], "2026-09-21T18:00:00Z");
        assert_eq!(observed["quotaUsages"][0]["percent"], 12.0);
        assert_eq!(observed["quotaUsages"][0]["resetAt"], "1790579768");
        assert!(
            observed.get("providerApi").is_none(),
            "the wire field is quotaSource, not providerApi"
        );

        let unavailable =
            serde_json::to_value(unavailable(&target("profile:codex", "digest-1"), "timeout"))
                .expect("unavailable json");
        let mut keys: Vec<&str> = unavailable
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["configurationDigest", "reason", "status", "targetId"],
            "unavailable carries identity, status, and reason only"
        );
        assert_eq!(unavailable["reason"], "timeout");
    }

    /// The probe reads other tools' login files on this machine; the Hub must
    /// only ever learn the quota answer. Every field of the fullest result a
    /// Hub can ask for is listed here with what fills it, and none can carry a
    /// token, account id, login-file fingerprint or path: a new field fails
    /// this test until its provenance is reviewed. The values themselves come
    /// from the harness reading, whose readers prove they hold nothing of the
    /// login file (`the_login_file_reaches_only_the_provider_request`).
    #[test]
    fn the_hub_payload_has_no_field_that_can_carry_a_credential() {
        use xmatrix_cli_core::protocol::{LlmQuotaAccount, LlmQuotaCredits};
        let reading = LlmUsage {
            quota_account: Some(LlmQuotaAccount {
                allowed: Some(true),
                credits: Some(LlmQuotaCredits {
                    balance: Some(3.0),
                    currency: Some("USD".to_string()),
                    unlimited: true,
                }),
            }),
            ..claude_reading()
        };
        let mut results = vec![observed_result(
            &target("registration:claude", "d"),
            reading,
        )];
        let probe = asking(
            serde_json::json!({ "windowLabels": true, "quotaAccount": true,
            "accountBalance": true, "scopedQuotaUsages": true }),
        );
        accept_only_what_the_hub_asked(&mut results, &probe);
        let report = MachineDaemonReport::MachineQuotaProbeResult {
            request_id: "cmd-1".to_string(),
            probe: MachineQuotaProbeResultProbe {
                request_id: probe.request_id,
                connection_epoch: probe.connection_epoch,
                results,
            },
            relay_lease: None,
        };
        fn paths(value: &serde_json::Value, at: String, out: &mut Vec<String>) {
            match value {
                serde_json::Value::Object(map) => {
                    for (key, child) in map {
                        let path = if at.is_empty() {
                            key.clone()
                        } else {
                            format!("{at}.{key}")
                        };
                        out.push(path.clone());
                        paths(child, path, out);
                    }
                }
                serde_json::Value::Array(items) => {
                    for item in items {
                        paths(item, format!("{at}[]"), out);
                    }
                }
                _ => {}
            }
        }
        let mut fields = Vec::new();
        paths(
            &serde_json::to_value(&report).unwrap(),
            String::new(),
            &mut fields,
        );
        fields.sort_unstable();
        fields.dedup();
        assert_eq!(
            fields,
            [
                // Command envelope and the Hub's own request, echoed.
                "probe",
                "probe.connectionEpoch",
                "probe.requestId",
                "probe.results",
                // Normalized quota answer from the provider's usage endpoint.
                "probe.results[].configurationDigest",
                "probe.results[].quotaAccount",
                "probe.results[].quotaAccount.allowed",
                "probe.results[].quotaAccount.credits",
                "probe.results[].quotaAccount.credits.balance",
                "probe.results[].quotaAccount.credits.currency",
                "probe.results[].quotaAccount.credits.unlimited",
                "probe.results[].quotaObservedAt",
                "probe.results[].quotaSource",
                "probe.results[].quotaUsages",
                "probe.results[].quotaUsages[].label",
                "probe.results[].quotaUsages[].percent",
                "probe.results[].quotaUsages[].resetAt",
                "probe.results[].scopedQuotaUsages",
                "probe.results[].scopedQuotaUsages[].label",
                "probe.results[].scopedQuotaUsages[].percent",
                "probe.results[].scopedQuotaUsages[].resetAt",
                "probe.results[].scopedQuotaUsages[].scope",
                "probe.results[].status",
                "probe.results[].targetId",
                "requestId",
                "type",
            ]
        );
    }

    #[tokio::test]
    async fn read_with_budget_cancels_a_slow_reader() {
        let deadline = Instant::now() + Duration::from_millis(40);
        let timed_out = read_with_budget(deadline, || async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            None::<LlmUsage>
        })
        .await;
        assert!(matches!(timed_out, Err(ReadOutcome::Timeout)));

        // A deadline already in the past is a timeout without calling the reader.
        let expired = read_with_budget(Instant::now() - Duration::from_millis(1), || async {
            None::<LlmUsage>
        })
        .await;
        assert!(matches!(expired, Err(ReadOutcome::Timeout)));

        let fast = read_with_budget(Instant::now() + Duration::from_secs(5), || async {
            None::<LlmUsage>
        })
        .await;
        assert!(matches!(fast, Ok(None)));
    }

    // ---- target resolution (fixture host, never the real profiles or env) ----

    fn fixture_home() -> PathBuf {
        PathBuf::from("/fixture/home")
    }

    fn resolve_fixture(target_id: &str, inherited: &[(&str, &str)]) -> Resolution {
        let inherited: std::collections::BTreeMap<String, String> = inherited
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        let inherited_env = |key: &str| inherited.get(key).cloned();
        resolve_target_on(
            target_id,
            &HostView {
                inherited: &inherited_env,
                home: Some(fixture_home()),
            },
        )
    }

    fn account_of(resolution: Resolution) -> QuotaAccount {
        match resolution {
            Resolution::Account { account, .. } => account,
            other => panic!("expected an account, got {other:?}"),
        }
    }

    #[test]
    fn unknown_targets_are_unsupported_even_when_the_daemon_has_a_login() {
        for target in [
            "profile:grok",
            "",
            "registration:kimi",
            "registration:custom",
            "registration:not-a-harness",
            // Registration harness ids are exact preset ids, not case-folded.
            "registration:Grok",
            "registration:",
        ] {
            assert_eq!(
                resolve_fixture(target, &[("GROK_HOME", "/fixture/daemon-grok")]),
                Resolution::Unsupported,
                "{target}"
            );
        }
    }

    #[test]
    fn grok_resolves_the_home_a_spawn_uses_and_refuses_an_inherited_token() {
        let expected = QuotaAccount::Grok(fixture_home().join(".grok"));
        assert_eq!(
            account_of(resolve_fixture("registration:grok", &[])),
            expected
        );
        // Spawn removes the daemon's own GROK_HOME, so it does not relocate.
        assert_eq!(
            account_of(resolve_fixture(
                "registration:grok",
                &[("GROK_HOME", "/fixture/daemon-grok")]
            )),
            expected
        );
        // An inherited token may reach an unsandboxed runtime: not provable.
        assert_eq!(
            resolve_fixture(
                "registration:grok",
                &[("GROK_CLI_OAUTH_TOKEN", "fixture-daemon-token")]
            ),
            Resolution::ConfigurationUnavailable
        );
    }

    #[test]
    fn claude_resolves_the_default_login_only_when_nothing_overrides_it() {
        assert_eq!(
            account_of(resolve_fixture("registration:claude", &[])),
            QuotaAccount::ClaudeDefault
        );
        // Spawn strips the daemon's own Anthropic key and gateway.
        assert_eq!(
            account_of(resolve_fixture(
                "registration:claude",
                &[("ANTHROPIC_API_KEY", "fixture-daemon-key")]
            )),
            QuotaAccount::ClaudeDefault
        );
        for inherited in [
            ("CLAUDE_CONFIG_DIR", "/fixture/claude"),
            ("CLAUDE_CODE_OAUTH_TOKEN", "fixture-token"),
        ] {
            assert_eq!(
                resolve_fixture("registration:claude", &[inherited]),
                Resolution::ConfigurationUnavailable,
                "{inherited:?}"
            );
        }
    }

    #[test]
    fn cursor_resolves_the_default_login() {
        assert_eq!(
            account_of(resolve_fixture("registration:cursor", &[])),
            QuotaAccount::CursorDefault
        );
        assert_eq!(
            account_of(resolve_fixture(
                "registration:cursor",
                &[("CURSOR_API_KEY", "fixture-key")]
            )),
            QuotaAccount::CursorDefault
        );
    }

    #[test]
    fn antigravity_resolves_the_default_login_only_when_nothing_overrides_it() {
        assert_eq!(
            account_of(resolve_fixture("registration:antigravity", &[])),
            QuotaAccount::AntigravityDefault
        );
        for inherited in [
            ("JETSKI_OAUTH_TOKEN", "fixture-token"),
            ("ANTIGRAVITY_APP_DATA_DIR", "/fixture/antigravity"),
            ("GEMINI_API_KEY", "fixture-key"),
            ("GOOGLE_API_KEY", "fixture-key"),
            ("AGY_ADC_AUTH", "1"),
            ("XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE", "1"),
            ("XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE", "true"),
        ] {
            assert_eq!(
                resolve_fixture("registration:antigravity", &[inherited]),
                Resolution::ConfigurationUnavailable,
                "{inherited:?}"
            );
        }
        assert_eq!(
            account_of(resolve_fixture(
                "registration:antigravity",
                &[("XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE", "0")]
            )),
            QuotaAccount::AntigravityDefault
        );
    }

    #[test]
    fn global_quota_probe_disable_opt_out_blocks_every_harness() {
        for target in [
            "registration:claude",
            "registration:codex",
            "registration:cursor",
            "registration:grok",
            "registration:opencode",
            "registration:deepseek",
            "registration:antigravity",
        ] {
            assert_eq!(
                resolve_fixture(target, &[("XMATRIX_DISABLE_QUOTA_PROBES", "1")]),
                Resolution::ConfigurationUnavailable,
                "{target}"
            );
        }
    }

    #[test]
    fn codex_registrations_use_the_default_home() {
        // A registered spawn inherits no CODEX_HOME: the daemon's is removed.
        assert_eq!(
            account_of(resolve_fixture(
                "registration:codex",
                &[("CODEX_HOME", "/fixture/daemon-codex")]
            )),
            QuotaAccount::Codex(fixture_home().join(".codex"))
        );
    }

    #[test]
    fn digests_are_stable_per_target_and_separate_harnesses() {
        let digest = |target: &str| match resolve_fixture(target, &[]) {
            Resolution::Account { digest, .. } => digest,
            other => panic!("expected an account, got {other:?}"),
        };
        assert_eq!(digest("registration:grok"), digest("registration:grok"));
        assert_ne!(digest("registration:grok"), digest("registration:codex"));
    }

    // ---- probe outcomes ----

    fn grok_fixture_usage(percent: f64) -> LlmUsage {
        let mut usage = xmatrix_harness::quota::grok::grok_billing_usage_from_value(
            &serde_json::json!({"config": {
                "currentPeriod": {"type": "BILLING_PERIOD_TYPE_WEEKLY", "end": "2026-09-30T00:00:00Z"},
                "creditUsagePercent": percent,
            }}),
        )
        .expect("grok fixture parses");
        usage.quota_observed_at = Some("2026-09-24T10:00:00Z".to_string());
        usage
    }

    fn grok_account() -> Resolution {
        Resolution::Account {
            account: QuotaAccount::Grok(PathBuf::from("/fixture/home/.grok")),
            digest: "digest-grok".to_string(),
        }
    }

    #[tokio::test]
    async fn grok_billing_maps_to_an_observed_result() {
        let far = Instant::now() + Duration::from_secs(5);
        let result = probe_one_target_with(
            &target("registration:grok", "server-digest"),
            far,
            |_| grok_account(),
            |account| async move {
                assert_eq!(
                    account,
                    QuotaAccount::Grok(PathBuf::from("/fixture/home/.grok"))
                );
                Ok(Some(grok_fixture_usage(100.0)))
            },
        )
        .await;
        assert_eq!(result.status, "observed");
        assert_eq!(result.target_id, "registration:grok");
        assert_eq!(result.configuration_digest, "server-digest");
        assert_eq!(result.quota_source.as_deref(), Some("provider_api"));
        assert_eq!(
            result.quota_observed_at.as_deref(),
            Some("2026-09-24T10:00:00Z")
        );
        assert_eq!(result.quota_usages.len(), 1);
        assert_eq!(result.quota_usages[0].percent, 100.0);
        assert_eq!(
            result.quota_usages[0].reset_at.as_deref(),
            Some("2026-09-30T00:00:00Z")
        );
    }

    #[tokio::test]
    async fn unsupported_and_unproven_targets_never_read() {
        let far = Instant::now() + Duration::from_secs(5);
        for (resolution, reason) in [
            (Resolution::Unsupported, "unsupported"),
            (
                Resolution::ConfigurationUnavailable,
                "configuration_unavailable",
            ),
        ] {
            let resolution = std::cell::Cell::new(Some(resolution));
            let result = probe_one_target_with(
                &target("registration:x", "d"),
                far,
                |_| resolution.take().expect("resolved once"),
                |_| async { panic!("an unresolved target must not read any account") },
            )
            .await;
            assert_eq!(result.status, "unavailable");
            assert_eq!(result.reason.as_deref(), Some(reason));
        }
    }

    #[tokio::test]
    async fn configuration_change_mid_read_discards_the_reading() {
        let far = Instant::now() + Duration::from_secs(5);
        let calls = std::cell::Cell::new(0);
        let result = probe_one_target_with(
            &target("registration:grok", "d"),
            far,
            |_| {
                calls.set(calls.get() + 1);
                if calls.get() == 1 {
                    grok_account()
                } else {
                    Resolution::Account {
                        account: QuotaAccount::Grok(PathBuf::from("/fixture/other/.grok")),
                        digest: "digest-other".to_string(),
                    }
                }
            },
            |_| async { Ok(Some(grok_fixture_usage(10.0))) },
        )
        .await;
        assert_eq!(result.reason.as_deref(), Some("configuration_unavailable"));
    }

    #[tokio::test]
    async fn a_reading_the_hub_would_reject_is_provider_unavailable() {
        let far = Instant::now() + Duration::from_secs(5);
        let mut unstamped = grok_fixture_usage(50.0);
        unstamped.quota_observed_at = None;
        let mut out_of_range = grok_fixture_usage(50.0);
        out_of_range.quota_usages.as_mut().unwrap()[0].percent = Some(140.0);
        let mut other_source = grok_fixture_usage(50.0);
        other_source.quota_source = Some("session".to_string());
        for usage in [unstamped, out_of_range, other_source] {
            let result = probe_one_target_with(
                &target("registration:grok", "d"),
                far,
                |_| grok_account(),
                |_| async move { Ok(Some(usage)) },
            )
            .await;
            assert_eq!(result.status, "unavailable");
            assert_eq!(result.reason.as_deref(), Some("provider_unavailable"));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn one_slow_target_does_not_spend_the_whole_probe_budget() {
        let deadline = Instant::now() + PROBE_TOTAL_BUDGET;
        let started = Instant::now();
        let result = tokio::time::timeout(
            PROBE_TARGET_BUDGET + Duration::from_secs(2),
            probe_one_target_with(
                &target("registration:grok", "d"),
                deadline,
                |_| grok_account(),
                |_| std::future::pending(),
            ),
        )
        .await
        .expect("the per-target budget ends the read");
        assert_eq!(result.reason.as_deref(), Some("timeout"));
        assert!(started.elapsed() < PROBE_TOTAL_BUDGET);
    }
}
