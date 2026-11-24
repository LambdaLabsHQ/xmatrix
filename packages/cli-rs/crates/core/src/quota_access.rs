//! The owner's per-machine, per-harness permission for xMatrix to read a
//! harness's local sign-in to show its quota (`xmatrix config quotaAccess`).
//!
//! Some harnesses (Cursor, and OpenCode before 2.2.0) have no official quota
//! interface: the only way to learn their quota is to read the sign-in they
//! stored for themselves. That
//! sign-in is the harness's, not a permission for xMatrix, so it is read only
//! under an explicit grant kept here, in this machine's CLI config. The grant
//! is off by default and separate from `quotaProbes`: that switch is on by
//! default and covers every provider, so it never counts as this grant, but it
//! still wins: with `quotaProbes off` (or `XMATRIX_DISABLE_QUOTA_PROBES=1`)
//! nothing is read even under a grant.
//!
//! A grant is bound to the sign-in it is first read with (a local-only keyed
//! fingerprint, see `xmatrix_harness::quota::grant`). Another account or
//! credential voids it, and with it the last reading.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use serde::Serialize;
use xmatrix_harness::quota::{self, Account, GrantedRead, Provider, ReadOptions, SignInReadGrant};

use crate::config::{self, CliConfig};
use crate::error::{CliError, Result};
use crate::protocol::LlmUsage;

/// Harnesses whose quota may be read only under a grant, by preset id:
/// Cursor always, OpenCode on a release before its usage-limits route.
const GRANT_HARNESSES: &[(&str, Provider)] = &[
    ("cursor", Provider::Cursor),
    ("opencode", Provider::OpenCode),
];

/// The provider a harness's quota is read from, when it may be read only
/// under a grant.
pub fn quota_access_provider(harness: &str) -> Option<Provider> {
    GRANT_HARNESSES
        .iter()
        .find(|(id, _)| *id == harness)
        .map(|(_, provider)| *provider)
        .filter(|provider| provider.takes_sign_in_read_grant())
}

/// Every harness whose quota may be read only under a grant.
pub fn quota_access_harnesses() -> impl Iterator<Item = &'static str> {
    GRANT_HARNESSES
        .iter()
        .filter(|(_, provider)| provider.takes_sign_in_read_grant())
        .map(|(id, _)| *id)
}

/// Whether `harness` at the release its inventory reports (`version`, when
/// known) is read only under a grant, so its grant state is worth showing.
pub fn quota_access_applies(harness: &str, version: Option<&str>) -> bool {
    quota_access_provider(harness).is_some_and(|provider| {
        provider.needs_sign_in_grant_at(version.and_then(quota::parse_cli_semver))
    })
}

/// Harnesses whose last read under a grant found their sign-in expired.
static SIGN_IN_EXPIRED: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// Whether the last read of `harness` under a grant in this process found its
/// sign-in expired: its quota is unknown until the harness signs in again.
pub fn sign_in_expired(harness: &str) -> bool {
    SIGN_IN_EXPIRED
        .lock()
        .is_ok_and(|expired| expired.contains(harness))
}

fn note_sign_in_expired(harness: &str, expired: bool) {
    if let Ok(mut set) = SIGN_IN_EXPIRED.lock() {
        if expired {
            set.insert(harness.to_string());
        } else {
            set.remove(harness);
        }
    }
}

/// Whether xMatrix may read a harness's sign-in on this machine now. Its
/// serialized form is the `quotaAccess` the daemon reports for that harness.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QuotaAccess {
    Granted,
    NotGranted,
    /// Granted or not, every quota probe is switched off on this machine.
    ProbesOff,
}

impl QuotaAccess {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Granted => "granted",
            Self::NotGranted => "not_granted",
            Self::ProbesOff => "probes_off",
        }
    }
}

/// The grant a read may use, or why there is none.
fn usable_grant(
    config: &CliConfig,
    env: impl Fn(&str) -> Option<String>,
    harness: &str,
) -> std::result::Result<SignInReadGrant, QuotaAccess> {
    if config::quota_probes_disabled_with(config, env) {
        return Err(QuotaAccess::ProbesOff);
    }
    quota_access_provider(harness)
        .and_then(|_| config.quota_access.get(harness).cloned())
        .ok_or(QuotaAccess::NotGranted)
}

pub fn quota_access_with(
    config: &CliConfig,
    env: impl Fn(&str) -> Option<String>,
    harness: &str,
) -> QuotaAccess {
    match usable_grant(config, env, harness) {
        Ok(_) => QuotaAccess::Granted,
        Err(state) => state,
    }
}

/// This machine's current answer for `harness`.
pub fn quota_access(harness: &str) -> QuotaAccess {
    quota_access_with(
        &config::load_config_sync(),
        |key| std::env::var(key).ok(),
        harness,
    )
}

/// Grant (`on`) or revoke (`off`) reading `harness`'s sign-in. Granting again
/// keeps the existing grant and its binding; revoking takes effect at the next
/// read, which every reader makes from this file.
pub async fn set_quota_access(harness: &str, on: bool) -> Result<QuotaAccess> {
    if quota_access_provider(harness).is_none() {
        let known: Vec<_> = quota_access_harnesses().collect();
        return Err(CliError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "'{harness}' needs no quota access grant. Harnesses that do: {}.",
                known.join(", ")
            ),
        )));
    }
    let mut config = config::load_config().await;
    let changed = set_grant(&mut config.quota_access, harness, on);
    if changed {
        config::write_config(&config).await?;
    }
    Ok(quota_access_with(
        &config,
        |key| std::env::var(key).ok(),
        harness,
    ))
}

fn set_grant(grants: &mut BTreeMap<String, SignInReadGrant>, harness: &str, on: bool) -> bool {
    if !on {
        return grants.remove(harness).is_some();
    }
    if grants.contains_key(harness) {
        return false;
    }
    grants.insert(
        harness.to_string(),
        SignInReadGrant::new(uuid::Uuid::new_v4().simple().to_string()),
    );
    true
}

/// What a read under a grant changed in the stored grant. Only the grant the
/// read used is changed: a grant revoked and given again meanwhile has a new
/// key and stays as it is.
fn apply_read(
    grants: &mut BTreeMap<String, SignInReadGrant>,
    harness: &str,
    used: &SignInReadGrant,
    read: &GrantedRead,
) -> bool {
    let Some(current) = grants
        .get_mut(harness)
        .filter(|grant| grant.key == used.key)
    else {
        return false;
    };
    match read {
        GrantedRead::SignInChanged => {
            grants.remove(harness);
            true
        }
        GrantedRead::Read {
            bound: Some(bound), ..
        } if current.sign_in.is_none() => {
            current.sign_in = Some(bound.clone());
            true
        }
        _ => false,
    }
}

/// A quota read of a harness that may be read only under a grant.
#[derive(Debug)]
pub enum GrantedQuota {
    /// Read (`None`: the provider gave no answer, or the harness is signed out).
    Usage(Option<LlmUsage>),
    /// The harness needs a grant here and has none, or the sign-in changed
    /// and voided it: nothing was asked.
    NotGranted,
    /// The sign-in's token has expired: the provider was not asked and the
    /// token was not refreshed.
    SignInExpired,
    /// Every quota probe is off on this machine: nothing was read.
    ProbesOff,
}

impl GrantedQuota {
    pub fn usage(self) -> Option<LlmUsage> {
        match self {
            Self::Usage(usage) => usage,
            Self::NotGranted | Self::SignInExpired | Self::ProbesOff => None,
        }
    }
}

/// Read `harness`'s quota for the harness running `model` (when known),
/// under this machine's grant when it has one: the reader decides whether it
/// needs it. Binds the grant on its first read and voids it when the
/// sign-in changed.
pub async fn read_granted_quota(harness: &str, force: bool, model: Option<&str>) -> GrantedQuota {
    let Some(provider) = quota_access_provider(harness) else {
        return GrantedQuota::NotGranted;
    };
    let config = config::load_config_sync();
    let read = read_with(
        &config,
        |key| std::env::var(key).ok(),
        harness,
        |grant| async move {
            quota::read_granted(
                provider,
                ReadOptions {
                    account: Account::DefaultLogin,
                    force,
                },
                model,
                grant.as_ref(),
            )
            .await
        },
    )
    .await;
    let Some((grant, read)) = read else {
        return GrantedQuota::ProbesOff;
    };
    if let Some(grant) = grant.as_ref()
        && matches!(
            read,
            GrantedRead::SignInChanged | GrantedRead::Read { bound: Some(_), .. }
        )
    {
        let mut config = config::load_config().await;
        if apply_read(&mut config.quota_access, harness, grant, &read)
            && let Err(error) = config::write_config(&config).await
        {
            eprintln!("Quota access for {harness} was not saved: {error}");
        }
    }
    note_sign_in_expired(harness, matches!(read, GrantedRead::SignInExpired));
    granted_quota(read, grant.is_some())
}

/// Run `read` with the grant `harness` has here (`None` without one), unless
/// every quota probe is off, which wins over any grant: then nothing runs.
async fn read_with<F, Fut>(
    config: &CliConfig,
    env: impl Fn(&str) -> Option<String>,
    harness: &str,
    read: F,
) -> Option<(Option<SignInReadGrant>, GrantedRead)>
where
    F: FnOnce(Option<SignInReadGrant>) -> Fut,
    Fut: std::future::Future<Output = GrantedRead>,
{
    let grant = match usable_grant(config, env, harness) {
        Ok(grant) => Some(grant),
        Err(QuotaAccess::ProbesOff) => return None,
        Err(_) => None,
    };
    let read = read(grant.clone()).await;
    Some((grant, read))
}

fn granted_quota(read: GrantedRead, had_grant: bool) -> GrantedQuota {
    match read {
        GrantedRead::Read { usage, .. } => GrantedQuota::Usage(usage),
        GrantedRead::SignInChanged => GrantedQuota::NotGranted,
        GrantedRead::SignInExpired => GrantedQuota::SignInExpired,
        // A reader closes with a grant in hand only when probes are off.
        GrantedRead::Closed if had_grant => GrantedQuota::ProbesOff,
        GrantedRead::Closed => GrantedQuota::NotGranted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn granted() -> CliConfig {
        let mut config = CliConfig::default();
        assert!(set_grant(&mut config.quota_access, "cursor", true));
        config
    }

    #[test]
    fn quota_probes_on_by_default_is_not_a_grant() {
        let config = CliConfig::default();
        assert_eq!(
            quota_access_with(&config, |_| None, "cursor"),
            QuotaAccess::NotGranted
        );
        assert!(usable_grant(&config, |_| None, "cursor").is_err());
        assert_eq!(
            quota_access_with(&granted(), |_| None, "cursor"),
            QuotaAccess::Granted
        );
    }

    #[test]
    fn the_global_switch_overrides_a_grant() {
        let mut config = granted();
        config.quota_probes = Some(false);
        assert_eq!(
            usable_grant(&config, |_| None, "cursor").err(),
            Some(QuotaAccess::ProbesOff)
        );
        let config = granted();
        let disabled =
            |key: &str| (key == config::QUOTA_PROBES_DISABLE_ENV).then(|| "1".to_string());
        assert_eq!(
            usable_grant(&config, disabled, "cursor").err(),
            Some(QuotaAccess::ProbesOff)
        );
    }

    #[test]
    fn revoking_closes_the_gate_at_once() {
        let mut config = granted();
        assert!(set_grant(&mut config.quota_access, "cursor", false));
        assert_eq!(
            usable_grant(&config, |_| None, "cursor").err(),
            Some(QuotaAccess::NotGranted)
        );
    }

    #[test]
    fn granting_again_keeps_the_bound_grant() {
        let mut config = granted();
        config.quota_access.get_mut("cursor").unwrap().sign_in = Some("bound".into());
        let before = config.quota_access.clone();
        assert!(!set_grant(&mut config.quota_access, "cursor", true));
        assert_eq!(config.quota_access, before);
    }

    #[test]
    fn the_first_read_binds_and_a_changed_sign_in_voids_the_grant() {
        let mut config = granted();
        let used = config.quota_access["cursor"].clone();
        let bound = GrantedRead::Read {
            usage: None,
            bound: Some("fingerprint".into()),
        };
        assert!(apply_read(
            &mut config.quota_access,
            "cursor",
            &used,
            &bound
        ));
        assert_eq!(
            config.quota_access["cursor"].sign_in.as_deref(),
            Some("fingerprint")
        );
        assert!(apply_read(
            &mut config.quota_access,
            "cursor",
            &used,
            &GrantedRead::SignInChanged
        ));
        assert!(!config.quota_access.contains_key("cursor"));
        assert_eq!(
            quota_access_with(&config, |_| None, "cursor"),
            QuotaAccess::NotGranted
        );
    }

    #[test]
    fn a_read_under_a_replaced_grant_changes_nothing() {
        let mut config = granted();
        let stale = SignInReadGrant::new("an-earlier-grant");
        assert!(!apply_read(
            &mut config.quota_access,
            "cursor",
            &stale,
            &GrantedRead::SignInChanged
        ));
        assert!(config.quota_access.contains_key("cursor"));
    }

    #[test]
    fn opencode_takes_a_grant_only_before_its_usage_limits_route() {
        assert_eq!(quota_access_provider("opencode"), Some(Provider::OpenCode));
        assert!(quota_access_applies("opencode", Some("1.19.6")));
        assert!(quota_access_applies("opencode", Some("2.1.9")));
        assert!(!quota_access_applies("opencode", Some("2.2.0")));
        assert!(!quota_access_applies("opencode", Some("2.4.1")));
        assert!(!quota_access_applies("opencode", None));
        assert!(quota_access_applies("cursor", None));
        assert!(!quota_access_applies("codex", Some("1.0.0")));
    }

    fn granted_opencode() -> CliConfig {
        let mut config = CliConfig::default();
        assert!(set_grant(&mut config.quota_access, "opencode", true));
        config
    }

    #[tokio::test]
    async fn the_global_switch_overrides_an_opencode_grant_and_its_official_read() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = AtomicUsize::new(0);
        let reader = |_grant: Option<SignInReadGrant>| {
            calls.fetch_add(1, Ordering::SeqCst);
            async {
                GrantedRead::Read {
                    usage: None,
                    bound: None,
                }
            }
        };
        let mut off = granted_opencode();
        off.quota_probes = Some(false);
        assert!(
            read_with(&off, |_| None, "opencode", reader)
                .await
                .is_none()
        );
        let disabled =
            |key: &str| (key == config::QUOTA_PROBES_DISABLE_ENV).then(|| "1".to_string());
        assert!(
            read_with(&CliConfig::default(), disabled, "opencode", reader)
                .await
                .is_none()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn without_a_grant_the_reader_gets_none_and_a_closed_read_is_not_granted() {
        let (grant, read) = read_with(
            &CliConfig::default(),
            |_| None,
            "opencode",
            |grant| async move {
                assert!(grant.is_none());
                GrantedRead::Closed
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            granted_quota(read, grant.is_some()),
            GrantedQuota::NotGranted
        ));
        let (grant, _) = read_with(
            &granted_opencode(),
            |_| None,
            "opencode",
            |grant| async move {
                assert!(grant.is_some());
                GrantedRead::Closed
            },
        )
        .await
        .unwrap();
        assert!(grant.is_some());
        assert!(matches!(
            granted_quota(GrantedRead::SignInExpired, true),
            GrantedQuota::SignInExpired
        ));
    }

    #[test]
    fn only_harnesses_without_a_quota_interface_take_a_grant() {
        assert_eq!(quota_access_provider("cursor"), Some(Provider::Cursor));
        assert_eq!(quota_access_provider("codex"), None);
        let config = granted();
        assert_eq!(
            quota_access_with(&config, |_| None, "codex"),
            QuotaAccess::NotGranted
        );
    }

    #[test]
    fn the_grant_round_trips_through_the_config_file() {
        let config = granted();
        let raw = serde_json::to_string(&config).unwrap();
        let parsed: CliConfig = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.quota_access, config.quota_access);
        assert!(
            serde_json::to_string(&CliConfig::default())
                .unwrap()
                .find("quotaAccess")
                .is_none()
        );
    }
}
