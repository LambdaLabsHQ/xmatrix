//! Whether this CLI/daemon may send its network diagnostics now.
//!
//! The same rule as `diagnosticsDecision` in `packages/protocol/src/diagnostics-consent.ts`,
//! which the Web, Desktop and mobile apps use. The Hub supplies the facts
//! (`GET /api/me/diagnostics`): the regime of the country the account signed
//! up from, the regime of the country this request comes from, and the
//! account's explicit choice. The CLI never derives a regime itself.
//!
//! Before each send the answer is read again when it is older than
//! [`CONSENT_FRESH`] or the connection was re-established; a failed or
//! timed-out read sends nothing this time.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::config::{self, CliConfig, DO_NOT_TRACK_ENV, TELEMETRY_ENV, parse_bool_setting};
use crate::http;
use crate::protocol::{HubRoutes, with_route};

/// How long an answer may be relied on (`DIAGNOSTICS_CONSENT_FRESH_MS`).
pub const CONSENT_FRESH: Duration = Duration::from_secs(10 * 60);
/// How long one read of the answer may take before it counts as failed.
const CONSENT_READ_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiagnosticsRegime {
    ConsentRequired,
    DefaultOk,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiagnosticsChoice {
    OptedIn,
    OptedOut,
}

impl DiagnosticsChoice {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OptedIn => "opted-in",
            Self::OptedOut => "opted-out",
        }
    }
}

/// What the Hub answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsConsent {
    pub account_regime: DiagnosticsRegime,
    pub request_regime: DiagnosticsRegime,
    #[serde(default, deserialize_with = "lenient_choice")]
    pub choice: Option<DiagnosticsChoice>,
}

fn lenient_choice<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<DiagnosticsChoice>, D::Error> {
    let raw = Option::<String>::deserialize(deserializer)?;
    Ok(match raw.as_deref() {
        Some("opted-in") => Some(DiagnosticsChoice::OptedIn),
        Some("opted-out") => Some(DiagnosticsChoice::OptedOut),
        _ => None,
    })
}

/// A beta build (`X.Y.Z-beta.N`, the dev channel) rather than a stable one.
pub fn is_beta_version(version: &str) -> bool {
    version.contains("-beta")
}

/// This machine's own explicit setting: `XMATRIX_TELEMETRY`, else `xmatrix config telemetry`.
pub fn local_choice_with(
    config: &CliConfig,
    env: &impl Fn(&str) -> Option<String>,
) -> Option<DiagnosticsChoice> {
    let enabled = env(TELEMETRY_ENV)
        .and_then(|raw| parse_bool_setting(&raw))
        .or(config.telemetry)?;
    Some(if enabled {
        DiagnosticsChoice::OptedIn
    } else {
        DiagnosticsChoice::OptedOut
    })
}

/// The decision. `consent` is the Hub's answer and its age; `None` when the
/// read failed or timed out.
///
/// - `XMATRIX_TELEMETRY=0` or `xmatrix config telemetry off` on this machine: no.
/// - No current answer from the Hub: no, never falling back to the signup regime.
/// - An explicit opt-in (this machine's, else the account's): yes.
/// - The account's opt-out, or `DO_NOT_TRACK=1`: no.
/// - A beta build where both the signup and the current regime are default-ok: yes.
/// - Otherwise: no.
pub fn telemetry_decision(
    local: Option<DiagnosticsChoice>,
    do_not_track: bool,
    beta: bool,
    consent: Option<(&DiagnosticsConsent, Duration)>,
) -> bool {
    if local == Some(DiagnosticsChoice::OptedOut) {
        return false;
    }
    let Some((consent, age)) = consent else {
        return false;
    };
    if age > CONSENT_FRESH {
        return false;
    }
    match local.or(consent.choice) {
        Some(DiagnosticsChoice::OptedIn) => return true,
        Some(DiagnosticsChoice::OptedOut) => return false,
        None => {}
    }
    !do_not_track
        && beta
        && consent.account_regime == DiagnosticsRegime::DefaultOk
        && consent.request_regime == DiagnosticsRegime::DefaultOk
}

fn do_not_track_with(env: &impl Fn(&str) -> Option<String>) -> bool {
    env(DO_NOT_TRACK_ENV).and_then(|raw| parse_bool_setting(&raw)) == Some(true)
}

/// The last answer the Hub gave, and when.
#[derive(Default)]
pub struct ConsentGate {
    last: Mutex<Option<(DiagnosticsConsent, Instant)>>,
}

impl ConsentGate {
    pub const fn new() -> Self {
        Self {
            last: Mutex::new(None),
        }
    }

    /// Forgets the last answer, so the next send asks again.
    pub fn invalidate(&self) {
        if let Ok(mut last) = self.last.lock() {
            *last = None;
        }
    }

    /// Decides one send: reuses a fresh answer, else reads the Hub again.
    pub async fn allowed(
        &self,
        hub_base_url: &str,
        token: &str,
        local: Option<DiagnosticsChoice>,
        do_not_track: bool,
        beta: bool,
    ) -> bool {
        if local == Some(DiagnosticsChoice::OptedOut) {
            return false;
        }
        let cached = self.last.lock().ok().and_then(|last| *last);
        let answer = match cached.filter(|(_, at)| at.elapsed() <= CONSENT_FRESH) {
            Some(answer) => Some(answer),
            None => {
                let read = read_consent(hub_base_url, token, beta)
                    .await
                    .map(|consent| (consent, Instant::now()));
                if let Ok(mut last) = self.last.lock() {
                    *last = read;
                }
                read
            }
        };
        telemetry_decision(
            local,
            do_not_track,
            beta,
            answer.as_ref().map(|(consent, at)| (consent, at.elapsed())),
        )
    }
}

static PROCESS_GATE: ConsentGate = ConsentGate::new();

/// Forgets this process's last answer: called when the connection is
/// (re-)established, which can mean a new network and so a new country.
pub fn invalidate_consent() {
    PROCESS_GATE.invalidate();
}

/// Reads the Hub's answer for this account and connection.
pub async fn read_consent(
    hub_base_url: &str,
    token: &str,
    beta: bool,
) -> Option<DiagnosticsConsent> {
    let url = format!(
        "{}?build={}",
        with_route(hub_base_url, HubRoutes::ME_DIAGNOSTICS),
        if beta { "beta" } else { "stable" }
    );
    tokio::time::timeout(
        CONSENT_READ_TIMEOUT,
        http::request_json::<DiagnosticsConsent>(&url, "GET", Some(token), None),
    )
    .await
    .ok()?
    .ok()
}

/// Records an explicit choice for the account (`PUT /api/me/diagnostics`).
pub async fn write_choice(hub_base_url: &str, token: &str, choice: DiagnosticsChoice) -> bool {
    let url = with_route(hub_base_url, HubRoutes::ME_DIAGNOSTICS);
    let body = serde_json::json!({ "choice": choice.as_str() });
    tokio::time::timeout(
        CONSENT_READ_TIMEOUT,
        http::request_json::<serde_json::Value>(&url, "PUT", Some(token), Some(body)),
    )
    .await
    .is_ok_and(|result| result.is_ok())
}

/// Whether this machine sends diagnostics only because of the beta's default
/// (no explicit choice anywhere), so sign-in shows the one-line notice.
pub async fn telemetry_on_by_default(hub_base_url: &str, token: &str) -> bool {
    let config = config::load_config_sync();
    let env = |key: &str| std::env::var(key).ok();
    let beta = is_beta_version(crate::version::current());
    if !beta || local_choice_with(&config, &env).is_some() {
        return false;
    }
    let Some(consent) = read_consent(hub_base_url, token, beta).await else {
        return false;
    };
    consent.choice.is_none()
        && telemetry_decision(
            None,
            do_not_track_with(&env),
            beta,
            Some((&consent, Duration::ZERO)),
        )
}

/// The gate every CLI diagnostics send goes through.
pub async fn telemetry_allowed_now(hub_base_url: &str, token: &str) -> bool {
    let config = config::load_config_sync();
    let env = |key: &str| std::env::var(key).ok();
    PROCESS_GATE
        .allowed(
            hub_base_url,
            token,
            local_choice_with(&config, &env),
            do_not_track_with(&env),
            is_beta_version(crate::version::current()),
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use DiagnosticsChoice::*;
    use DiagnosticsRegime::*;

    fn consent(
        account_regime: DiagnosticsRegime,
        request_regime: DiagnosticsRegime,
        choice: Option<DiagnosticsChoice>,
    ) -> DiagnosticsConsent {
        DiagnosticsConsent {
            account_regime,
            request_regime,
            choice,
        }
    }

    #[test]
    fn the_default_matrix_matches_the_apps() {
        for beta in [true, false] {
            for account in [DefaultOk, ConsentRequired] {
                for request in [DefaultOk, ConsentRequired] {
                    for choice in [None, Some(OptedIn), Some(OptedOut)] {
                        for dnt in [false, true] {
                            let answer = consent(account, request, choice);
                            let expected = match choice {
                                Some(OptedIn) => true,
                                Some(OptedOut) => false,
                                None => {
                                    !dnt && beta && account == DefaultOk && request == DefaultOk
                                }
                            };
                            assert_eq!(
                                telemetry_decision(
                                    None,
                                    dnt,
                                    beta,
                                    Some((&answer, Duration::ZERO))
                                ),
                                expected,
                                "beta={beta} account={account:?} request={request:?} choice={choice:?} dnt={dnt}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn a_default_ok_account_in_a_consent_required_country_sends_nothing_by_default() {
        let travelling = consent(DefaultOk, ConsentRequired, None);
        assert!(!telemetry_decision(
            None,
            false,
            true,
            Some((&travelling, Duration::ZERO))
        ));
    }

    #[test]
    fn a_failed_or_stale_lookup_sends_nothing_even_after_an_opt_in() {
        let default_ok = consent(DefaultOk, DefaultOk, None);
        let opted_in = consent(DefaultOk, DefaultOk, Some(OptedIn));
        assert!(!telemetry_decision(None, false, true, None));
        assert!(!telemetry_decision(Some(OptedIn), false, true, None));
        for answer in [&default_ok, &opted_in] {
            assert!(!telemetry_decision(
                None,
                false,
                true,
                Some((answer, CONSENT_FRESH + Duration::from_secs(1)))
            ));
            assert!(telemetry_decision(
                None,
                false,
                true,
                Some((answer, CONSENT_FRESH))
            ));
        }
    }

    #[test]
    fn this_machines_setting_overrides_the_account_and_off_always_wins() {
        let env_off = |key: &str| (key == TELEMETRY_ENV).then(|| "0".to_string());
        let env_on = |key: &str| (key == TELEMETRY_ENV).then(|| "1".to_string());
        let none = |_: &str| None;
        let config_on = CliConfig {
            telemetry: Some(true),
            ..CliConfig::default()
        };
        assert_eq!(local_choice_with(&config_on, &env_off), Some(OptedOut));
        assert_eq!(
            local_choice_with(&CliConfig::default(), &env_on),
            Some(OptedIn)
        );
        assert_eq!(local_choice_with(&config_on, &none), Some(OptedIn));
        assert_eq!(local_choice_with(&CliConfig::default(), &none), None);

        let account_in = consent(DefaultOk, DefaultOk, Some(OptedIn));
        assert!(!telemetry_decision(
            Some(OptedOut),
            false,
            true,
            Some((&account_in, Duration::ZERO))
        ));
        let account_out = consent(DefaultOk, DefaultOk, Some(OptedOut));
        assert!(telemetry_decision(
            Some(OptedIn),
            true,
            false,
            Some((&account_out, Duration::ZERO))
        ));
    }

    #[test]
    fn the_hubs_answer_parses_and_an_unknown_choice_is_none() {
        let parsed: DiagnosticsConsent = serde_json::from_str(
            r#"{"accountRegime":"default-ok","requestRegime":"consent-required","choice":"maybe"}"#,
        )
        .unwrap();
        assert_eq!(parsed, consent(DefaultOk, ConsentRequired, None));
        assert!(
            serde_json::from_str::<DiagnosticsConsent>(r#"{"accountRegime":"default-ok"}"#)
                .is_err()
        );
    }

    #[test]
    fn beta_builds_are_the_dev_channel_versions() {
        assert!(is_beta_version("2.3.1-beta.4"));
        assert!(!is_beta_version("2.3.1"));
        assert!(!is_beta_version("0.0.0-unregistered"));
    }

    /// A Hub that answers `GET /api/me/diagnostics` once per connection with
    /// `body`, counting the reads; `None` answers 503.
    async fn hub(
        body: Option<&'static str>,
    ) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let hub = format!("http://{}", listener.local_addr().unwrap());
        let reads = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = reads.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut request = vec![0; 4096];
                let length = socket.read(&mut request).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&request[..length]).to_string();
                assert!(
                    request.starts_with("GET /api/me/diagnostics?build="),
                    "{request}"
                );
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let response = match body {
                    Some(body) => format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    ),
                    None => "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
                };
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        (hub, reads)
    }

    #[tokio::test]
    async fn the_daemon_sends_nothing_from_a_consent_required_country_for_a_default_ok_account() {
        let (hub, _) = hub(Some(
            r#"{"accountRegime":"default-ok","requestRegime":"consent-required","choice":null}"#,
        ))
        .await;
        let gate = ConsentGate::new();
        assert!(!gate.allowed(&hub, "token", None, false, true).await);
    }

    #[tokio::test]
    async fn the_daemon_sends_by_default_on_beta_where_both_regimes_are_default_ok_and_reuses_a_fresh_answer()
     {
        let (hub, reads) = hub(Some(
            r#"{"accountRegime":"default-ok","requestRegime":"default-ok","choice":null}"#,
        ))
        .await;
        let gate = ConsentGate::new();
        assert!(gate.allowed(&hub, "token", None, false, true).await);
        assert!(gate.allowed(&hub, "token", None, false, true).await);
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 1);
        // A reconnect asks again.
        gate.invalidate();
        assert!(gate.allowed(&hub, "token", None, false, true).await);
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 2);
        // The stable build does not send by default.
        assert!(
            !ConsentGate::new()
                .allowed(&hub, "token", None, false, false)
                .await
        );
    }

    #[tokio::test]
    async fn the_daemon_sends_nothing_when_the_hub_does_not_answer() {
        let (hub, _) = hub(None).await;
        let gate = ConsentGate::new();
        assert!(
            !gate
                .allowed(&hub, "token", Some(OptedIn), false, true)
                .await
        );
        assert!(
            !gate
                .allowed("http://127.0.0.1:9", "token", None, false, true)
                .await
        );
    }

    #[tokio::test]
    async fn xmatrix_telemetry_off_sends_nothing_without_asking_the_hub() {
        let (hub, reads) = hub(Some(
            r#"{"accountRegime":"default-ok","requestRegime":"default-ok","choice":"opted-in"}"#,
        ))
        .await;
        assert!(
            !ConsentGate::new()
                .allowed(&hub, "token", Some(OptedOut), false, true)
                .await
        );
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
}
