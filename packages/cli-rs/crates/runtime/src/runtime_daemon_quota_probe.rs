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
use xmatrix_cli_core::protocol::LlmUsage;
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
/// A registration target names its harness; owner and machine are this daemon.
const REGISTRATION_TARGET_PREFIX: &str = "registration:";

pub(crate) async fn execute_machine_quota_probe(
    request_id: String,
    probe: MachineQuotaProbeRequest,
    relay_lease: Option<MachineDaemonCommandLease>,
) -> MachineDaemonReport {
    let deadline = Instant::now() + PROBE_TOTAL_BUDGET;
    let mut results = Vec::with_capacity(probe.targets.len().min(MAX_PROBE_TARGETS));
    for target in probe.targets.iter().take(MAX_PROBE_TARGETS) {
        results.push(probe_one_target(target, deadline).await);
    }
    if !probe.window_labels {
        strip_window_labels(&mut results);
    }
    if !probe.quota_account {
        strip_quota_account(&mut results);
    }
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
async fn read_with_budget<F, Fut>(
    deadline: Instant,
    read: F,
) -> Result<Option<LlmUsage>, ReadOutcome>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Option<LlmUsage>>,
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
}

impl QuotaAccount {
    fn digest_parts(&self) -> (&'static str, String) {
        match self {
            Self::Codex(home) => ("codex", home.to_string_lossy().into_owned()),
            Self::Grok(home) => ("grok", home.to_string_lossy().into_owned()),
            Self::ClaudeDefault => ("claude", "default-login".to_string()),
            Self::CursorDefault => ("cursor", "default-login".to_string()),
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
            // The reader reads the default login (keychain, then
            // `~/.claude/.credentials.json`). Any token, API key, gateway, or
            // relocated config dir means the spawn may bill another account.
            if spawn.any_effective(&[
                "CLAUDE_CODE_OAUTH_TOKEN",
                "CLAUDE_CONFIG_DIR",
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "ANTHROPIC_BASE_URL",
            ]) || host.home.is_none()
            {
                return Resolution::ConfigurationUnavailable;
            }
            QuotaAccount::ClaudeDefault
        }
        "cursor" => {
            // The reader prefers CURSOR_API_KEY / CURSOR_AUTH_TOKEN, then the
            // macOS login keychain item `cursor-access-token`, then CLI
            // auth.json under APPDATA/Cursor or ~/.cursor. Those are the
            // account a default registered spawn bills.
            QuotaAccount::CursorDefault
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

async fn read_account(account: QuotaAccount) -> Option<LlmUsage> {
    // Respect each reader's short success TTL: a probe is not a reason to
    // hammer the provider, and a cached reading keeps its observation time.
    let (provider, account) = match account {
        QuotaAccount::Codex(home) => (Provider::Codex, Account::Home(home)),
        QuotaAccount::Grok(home) => (Provider::Grok, Account::Home(home)),
        QuotaAccount::ClaudeDefault => (Provider::Claude, Account::DefaultLogin),
        QuotaAccount::CursorDefault => (Provider::Cursor, Account::DefaultLogin),
    };
    quota::read(
        provider,
        ReadOptions {
            account,
            force: false,
        },
    )
    .await
}

async fn probe_one_target(
    target: &MachineQuotaProbeTarget,
    deadline: Instant,
) -> MachineQuotaProbeTargetResult {
    probe_one_target_with(target, deadline, resolve_target, read_account).await
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
    Fut: std::future::Future<Output = Option<LlmUsage>>,
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
        Ok(usage) => usage,
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
    let quota_usages: Vec<MachineQuotaProbeWindow> = usage
        .quota_usages
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter_map(|window| {
            let percent = window.percent?;
            if !percent.is_finite() || !(0.0..=100.0).contains(&percent) {
                return None;
            }
            Some(MachineQuotaProbeWindow {
                percent,
                reset_at: window.reset_at.clone(),
                label: window_label(window.label.as_deref()),
            })
        })
        .take(MAX_PROBE_WINDOWS)
        .collect();
    if quota_usages.is_empty()
        || usage.quota_source.as_deref() != Some("provider_api")
        || usage.quota_observed_at.is_none()
    {
        return unavailable(target, "provider_unavailable");
    }
    MachineQuotaProbeTargetResult {
        target_id: target.target_id.clone(),
        configuration_digest: target.configuration_digest.clone(),
        status: "observed".to_string(),
        quota_source: usage.quota_source.clone(),
        quota_observed_at: usage.quota_observed_at.clone(),
        quota_usages,
        quota_account: usage.quota_account.clone(),
        reason: None,
    }
}

/// A Hub that did not ask for window labels rejects a labelled window.
fn strip_window_labels(results: &mut [MachineQuotaProbeTargetResult]) {
    for window in results
        .iter_mut()
        .flat_map(|result| result.quota_usages.iter_mut())
    {
        window.label = None;
    }
}

/// A Hub that did not ask for the account state rejects a result carrying it.
fn strip_quota_account(results: &mut [MachineQuotaProbeTargetResult]) {
    for result in results {
        result.quota_account = None;
    }
}

/// A label the Hub accepts: trimmed, non-empty and short; anything else is
/// dropped rather than failing the whole reading.
fn window_label(label: Option<&str>) -> Option<String> {
    label
        .filter(|label| {
            !label.is_empty() && label.trim() == *label && label.len() <= MAX_WINDOW_LABEL_BYTES
        })
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use xmatrix_cli_core::protocol::LlmQuotaUsage;

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

        strip_quota_account(&mut results);
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

        strip_window_labels(&mut results);
        let wire = serde_json::to_value(&results[0]).expect("observed json");
        assert!(wire["quotaUsages"][0].get("label").is_none());
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

    #[tokio::test]
    async fn read_with_budget_cancels_a_slow_reader() {
        let deadline = Instant::now() + Duration::from_millis(40);
        let timed_out = read_with_budget(deadline, || async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            None
        })
        .await;
        assert!(matches!(timed_out, Err(ReadOutcome::Timeout)));

        // A deadline already in the past is a timeout without calling the reader.
        let expired =
            read_with_budget(Instant::now() - Duration::from_millis(1), || async { None }).await;
        assert!(matches!(expired, Err(ReadOutcome::Timeout)));

        let fast =
            read_with_budget(Instant::now() + Duration::from_secs(5), || async { None }).await;
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
                Some(grok_fixture_usage(100.0))
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
            |_| async { Some(grok_fixture_usage(10.0)) },
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
                |_| async move { Some(usage) },
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
