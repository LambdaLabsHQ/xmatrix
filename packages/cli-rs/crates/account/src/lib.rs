#![deny(warnings)]

pub mod billing;

use colored::Colorize;
use serde::Deserialize;
use std::time::Duration;
use xmatrix_cli_agent::ensure_local_daemon_started;
use xmatrix_cli_core::error::{self, CliError};
use xmatrix_cli_core::protocol::{self, HubRoutes, with_route};
use xmatrix_cli_core::{auth, config, daemon_auth, http};
use xmatrix_cli_update::{
    DEFAULT_CLI_RELEASE_API_URL, UpdateHintTarget, warn_if_cli_update_available,
};

pub async fn cmd_login(
    hub_url: &str,
    machine_name: Option<&str>,
    connect: Option<&str>,
) -> error::Result<()> {
    let response = match connect {
        Some(setup_intent) => auth::login_for_setup_intent(hub_url, setup_intent).await?,
        None => auth::login_with_browser(hub_url).await?,
    };
    if config::normalized_hub_origin(&response.hub_url) != config::normalized_hub_origin(hub_url) {
        return Err(CliError::Auth(format!(
            "Login returned a session for {}, but the selected profile is bound to {}; no session was saved",
            config::normalized_hub_origin(&response.hub_url),
            config::normalized_hub_origin(hub_url)
        )));
    }
    let user = response.user.clone();

    let session = config::save_session(
        response.token,
        response.refresh_token,
        user.clone(),
        response.hub_url,
        response.relay_url,
        None,
    )
    .await?;

    println!(
        "{} Logged in as {} ({})",
        "✓".green().bold(),
        user.name.as_deref().unwrap_or(""),
        user.email.dimmed()
    );
    println!("  Hub: {}", session.hub_url.dimmed());
    // A setup command names a new machine after its hostname instead of asking.
    let hostname = connect.map(|_| auth::local_hostname());
    xmatrix_cli_core::machine_naming::ensure_machine_name(
        &session,
        machine_name,
        hostname.as_deref(),
    )
    .await?;
    let rejoined = rejoin_this_machine(&session).await;
    if let Some(setup_intent) = connect {
        report_setup_machine(&session, setup_intent).await;
    }
    if protocol::normalize_hub_url(Some(&config::active_hub_url().await))
        != protocol::normalize_hub_url(Some(&session.hub_url))
    {
        println!("  Saved for this Hub without changing the active daemon environment");
        return Ok(());
    }
    if std::env::var("XMATRIX_SKIP_DAEMON_AUTOSTART")
        .ok()
        .as_deref()
        == Some("1")
    {
        return Ok(());
    }
    let initial_sync = daemon_auth::reload_saved_session_in_local_daemon().await?;
    match initial_sync {
        daemon_auth::DaemonSessionReloadOutcome::Reloaded => {
            println!(
                "{} Updated the running daemon without restarting agents",
                "✓".green().bold()
            );
        }
        daemon_auth::DaemonSessionReloadOutcome::AlreadyCurrent => {}
        daemon_auth::DaemonSessionReloadOutcome::Unavailable
        | daemon_auth::DaemonSessionReloadOutcome::Unsupported => {
            if matches!(
                initial_sync,
                daemon_auth::DaemonSessionReloadOutcome::Unsupported
            ) {
                return Err(CliError::Auth(
                    "Login was saved, but the running daemon is too old for live session reload; update and restart the daemon once"
                        .into(),
                ));
            }
            if let Err(err) = ensure_local_daemon_started(&session.hub_url, &session.token).await {
                return Err(CliError::Launch(format!(
                    "Login was saved, but the local daemon could not be started: {err}"
                )));
            }
            match wait_for_daemon_session_reload().await? {
                daemon_auth::DaemonSessionReloadOutcome::Reloaded
                | daemon_auth::DaemonSessionReloadOutcome::AlreadyCurrent => {}
                daemon_auth::DaemonSessionReloadOutcome::Unavailable => {
                    return Err(CliError::Auth(
                        "Login was saved, but the local daemon did not accept the new session; no running agents were restarted"
                            .into(),
                    ));
                }
                daemon_auth::DaemonSessionReloadOutcome::Unsupported => {
                    return Err(CliError::Auth(
                        "Login was saved, but the running daemon is too old for live session reload; update and restart the daemon once"
                            .into(),
                    ));
                }
            }
        }
    }
    // A removed Machine's daemon stopped its profile; start it again.
    if rejoined {
        restart_profile_after_rejoin().await;
    }

    Ok(())
}

/// Logging in on a Machine its owner removed is how it comes back. A daemon
/// refreshing its credential never asks for this, so a removed Machine that
/// merely wakes up stays removed.
/// Tells the page that showed the setup command which Machine this terminal became,
/// so it can follow the machine coming online. The page is only a view: failing to
/// tell it leaves the machine connected and is reported, not fatal.
async fn report_setup_machine(session: &config::CliSession, setup_intent: &str) {
    let Ok(identity) = config::machine_identity_for_owner(&session.user.id).await else {
        return;
    };
    let url = format!(
        "{}/{}/machine",
        with_route(&session.hub_url, HubRoutes::SETUP_INTENTS),
        urlencoding::encode(setup_intent.trim())
    );
    let body = serde_json::json!({ "machineId": identity.machine_id });
    if let Err(error) =
        http::request_json::<serde_json::Value>(&url, "POST", Some(&session.token), Some(body))
            .await
    {
        eprintln!(
            "{} Connected, but the xMatrix page could not be told: {error}",
            "!".yellow().bold()
        );
    }
}

async fn rejoin_this_machine(session: &config::CliSession) -> bool {
    let Ok(identity) = config::machine_identity_for_owner(&session.user.id).await else {
        return false;
    };
    let url = format!(
        "{}/{}/rejoin",
        with_route(&session.hub_url, HubRoutes::MACHINES),
        urlencoding::encode(&identity.machine_id)
    );
    match http::request_json::<serde_json::Value>(&url, "POST", Some(&session.token), None).await {
        Ok(response)
            if response
                .get("rejoined")
                .and_then(serde_json::Value::as_bool)
                == Some(true) =>
        {
            println!(
                "{} Added this machine back to your account",
                "✓".green().bold()
            );
            true
        }
        Ok(_) => false,
        Err(error) => {
            eprintln!(
                "{} Could not check whether this machine was removed: {error}",
                "⚠".yellow().bold()
            );
            false
        }
    }
}

async fn restart_profile_after_rejoin() {
    let Some(context) = config::process_profile_context() else {
        return;
    };
    let started = xmatrix_cli_core::daemon_host::daemon_profile_control(
        &xmatrix_cli_core::profile::InstallationRoot::discover(),
        xmatrix_cli_core::daemon_host::ProfileControlAction::Start,
        &context.id,
    )
    .await;
    if !matches!(
        started,
        Ok(xmatrix_cli_core::daemon_host::DaemonHostQueryOutcome::Available(_))
    ) {
        println!(
            "  If this machine's daemon stays stopped, run: {}",
            "xmatrix daemon start-profile".bold()
        );
    }
}

async fn wait_for_daemon_session_reload() -> error::Result<daemon_auth::DaemonSessionReloadOutcome>
{
    for _ in 0..20 {
        match daemon_auth::reload_saved_session_in_local_daemon().await? {
            daemon_auth::DaemonSessionReloadOutcome::Unavailable => {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            outcome => return Ok(outcome),
        }
    }
    Ok(daemon_auth::DaemonSessionReloadOutcome::Unavailable)
}

pub async fn cmd_logout(hub_url: &str, all: bool, all_profiles: bool) -> error::Result<()> {
    if all_profiles {
        let store = xmatrix_cli_core::profile::ProfileStore::discover();
        let registry = store.load_or_bootstrap()?;
        for state_root in store.state_roots(&registry)? {
            config::clear_all_sessions_in_state_root(state_root.as_path()).await?;
        }
        println!("{} Logged out of all local profiles", "✓".green().bold());
    } else if all {
        config::clear_all_sessions().await?;
        println!(
            "{} Logged out of all sessions in this profile",
            "✓".green().bold()
        );
    } else {
        config::clear_session_for_hub(hub_url).await?;
        println!("{} Logged out of {}", "✓".green().bold(), hub_url);
    }
    Ok(())
}

pub async fn cmd_whoami(hub_url: &str) -> error::Result<()> {
    let session = config::load_session_for_hub(hub_url)
        .await
        .ok_or_else(|| CliError::Auth("Not logged in. Run: xmatrix login".into()))?;

    let verified = verify_saved_session(&session).await;
    let (session, user, verified_remote) = match verified {
        Ok(user) => (session, user, true),
        Err(initial_err) => match auth::refresh_cli_session(&session).await {
            Ok(refreshed) => match verify_saved_session(&refreshed).await {
                Ok(user) => (refreshed, user, true),
                Err(refreshed_err) => {
                    eprintln!(
                        "{} saved session could not be verified with the Hub after refresh: {refreshed_err}",
                        "⚠".yellow().bold()
                    );
                    let cached_user = refreshed.user.clone();
                    (refreshed, cached_user, false)
                }
            },
            Err(refresh_err) => {
                eprintln!(
                    "{} saved session could not be verified with the Hub: {initial_err}",
                    "⚠".yellow().bold()
                );
                eprintln!(
                    "{} session refresh failed: {refresh_err}",
                    "⚠".yellow().bold()
                );
                (session.clone(), session.user.clone(), false)
            }
        },
    };

    println!(
        "{}  {}",
        "User:".bold(),
        user.name.as_deref().unwrap_or("(no name)")
    );
    println!("{} {}", "Email:".bold(), user.email);
    println!("{}    {}", "ID:".bold(), user.id);
    println!("{}   {}", "Hub:".bold(), session.hub_url);
    println!(
        "{} {}",
        "Environment:".bold(),
        environment_label(&session.hub_url)
    );
    println!(
        "{} {}",
        "Verified:".bold(),
        if verified_remote { "yes" } else { "no" }
    );

    Ok(())
}

async fn verify_saved_session(session: &config::CliSession) -> error::Result<protocol::AuthUser> {
    #[derive(Deserialize)]
    struct MeResponse {
        user: protocol::AuthUser,
    }

    let response: MeResponse = http::request_json(
        &with_route(&session.hub_url, HubRoutes::ME),
        "GET",
        Some(&session.token),
        None,
    )
    .await?;
    Ok(response.user)
}

pub async fn cmd_status(hub_url: &str) -> error::Result<()> {
    let url = with_route(hub_url, HubRoutes::STATUS);
    let resp: serde_json::Value = http::request_json(&url, "GET", None, None).await?;

    println!("{} Hub is reachable", "✓".green().bold());
    println!("  Environment: {}", environment_label(hub_url));
    println!("  Hub: {hub_url}");
    if let Some(status) = resp.get("status").and_then(|v| v.as_str()) {
        println!("  Status: {status}");
    }
    warn_if_cli_update_available(DEFAULT_CLI_RELEASE_API_URL, UpdateHintTarget::Cli).await;

    Ok(())
}

fn environment_label(hub_url: &str) -> &'static str {
    let origin = config::normalized_hub_origin(hub_url);
    if origin == protocol::DEFAULT_HUB_URL {
        "production"
    } else if origin == protocol::TEST_HUB_URL {
        "test"
    } else {
        "custom"
    }
}

pub async fn cmd_list(hub_url: &str, token: &str, json_output: bool) -> error::Result<()> {
    #[derive(Deserialize)]
    struct AgentsResponse {
        instances: Vec<protocol::SerializedAgent>,
    }

    let url = with_route(hub_url, HubRoutes::AGENT_INSTANCES);
    let response: AgentsResponse = http::request_json(&url, "GET", Some(token), None).await?;
    let agents = response.instances;

    let now = time::OffsetDateTime::now_utc();

    if json_output {
        // Narrow, read-only view of the same authorized /api/agent-instances
        // response. This is the live presence view, not the persisted routing
        // candidate snapshot. Metadata, email, and tokens are omitted.
        let views = agent_usage_views(&agents, now);
        println!(
            "{}",
            serde_json::to_string_pretty(&views).map_err(|err| CliError::Launch(format!(
                "Failed to serialize agent list: {err}"
            )))?
        );
        return Ok(());
    }

    if agents.is_empty() {
        println!("No agents connected.");
        return Ok(());
    }

    println!(
        "{:<20} {:<12} {:<8} {:<24} {}",
        "NAME".bold(),
        "TYPE".bold(),
        "STATUS".bold(),
        "QUOTA".bold(),
        "ID".bold()
    );

    for a in &agents {
        // The Hub reports `offline` for an Instance whose machine is unreachable:
        // its socket is open, but nothing sent to it will be acted on. Yellow is
        // work in hand, green is free (docs/design/agent-status.md).
        let status = display_status(a);
        let status_colored = match status {
            "online" | "idle" => status.green().to_string(),
            "offline" => status.red().to_string(),
            _ => status.yellow().to_string(),
        };
        println!(
            "{:<20} {:<12} {:<8} {:<24} {}",
            a.name,
            a.agent_type,
            status_colored,
            quota_summary(a.usage.as_ref(), now),
            a.id.dimmed()
        );
    }

    Ok(())
}

/// `waiting` for a live Instance whose runtime reports a wait, else the status
/// the Hub projected.
fn display_status(agent: &protocol::SerializedAgent) -> &str {
    let live = matches!(agent.status.as_str(), "online" | "busy" | "idle");
    let waiting = agent
        .runtime_state
        .as_ref()
        .is_some_and(|state| state.waiting.is_some());
    if live && waiting {
        "waiting"
    } else {
        &agent.status
    }
}

/// The live `/api/agent-instances` response is not the persisted routing
/// candidate snapshot, so the quota shown here is display-only evidence of what
/// an Agent last reported through the provider API.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentUsageView {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    instance_id: Option<String>,
    name: String,
    #[serde(rename = "type")]
    agent_type: String,
    status: String,
    /// What a live Instance waits on, when its runtime reports a wait.
    #[serde(skip_serializing_if = "Option::is_none")]
    waiting: Option<protocol::AgentRuntimeWaiting>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quota: Option<ProviderQuotaView>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderQuotaView {
    quota_source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    quota_observed_at: Option<String>,
    stale: bool,
    windows: Vec<ProviderQuotaWindowView>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderQuotaWindowView {
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    window: Option<String>,
    used_percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    reset_at: Option<String>,
    expired: bool,
}

const QUOTA_MAX_AGE_SECONDS: i64 = 15 * 60;
const QUOTA_EXHAUSTED_MAX_AGE_SECONDS: i64 = 31 * 24 * 60 * 60;

fn agent_usage_views(
    agents: &[protocol::SerializedAgent],
    now: time::OffsetDateTime,
) -> Vec<AgentUsageView> {
    agents
        .iter()
        .map(|agent| AgentUsageView {
            id: agent.id.clone(),
            instance_id: agent.instance_id.clone(),
            name: agent.name.clone(),
            agent_type: agent.agent_type.clone(),
            status: agent.status.clone(),
            waiting: (display_status(agent) == "waiting")
                .then(|| agent.runtime_state.as_ref()?.waiting.clone())
                .flatten(),
            model: agent.model.clone(),
            quota: provider_quota_view(agent.usage.as_ref(), now),
        })
        .collect()
}

/// Only an explicit provider API read is a quota authority. Session estimates
/// and malformed windows are dropped rather than presented as account quota.
fn provider_quota_view(
    usage: Option<&protocol::LlmUsage>,
    now: time::OffsetDateTime,
) -> Option<ProviderQuotaView> {
    let usage = usage?;
    if usage.quota_source.as_deref() != Some("provider_api") {
        return None;
    }
    let windows: Vec<ProviderQuotaWindowView> = usage
        .quota_usages
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter_map(|window| {
            let used_percent = valid_used_percent(window.percent)?;
            let reset = parse_reset_seconds(window.reset_at.as_deref());
            Some(ProviderQuotaWindowView {
                label: window.label.clone(),
                window: window.window.clone(),
                used_percent,
                reset_at: window.reset_at.clone(),
                expired: reset.is_some_and(|reset| reset <= now.unix_timestamp()),
            })
        })
        .collect();
    if windows.is_empty() {
        return None;
    }
    Some(ProviderQuotaView {
        quota_source: "provider_api",
        quota_observed_at: usage.quota_observed_at.clone(),
        stale: quota_is_stale(usage, now),
        windows,
    })
}

/// Mirror the routing freshness contract: a positive balance ages out after 15
/// minutes, while an exhausted window stays a negative signal until its reset
/// (bounded to 31 days). A window whose reset already passed is ignored.
fn quota_is_stale(usage: &protocol::LlmUsage, now: time::OffsetDateTime) -> bool {
    let Some(observed) = usage
        .quota_observed_at
        .as_deref()
        .and_then(parse_rfc3339_seconds)
    else {
        return true;
    };
    let now_seconds = now.unix_timestamp();
    if observed > now_seconds {
        return true;
    }
    !usage
        .quota_usages
        .as_deref()
        .unwrap_or_default()
        .iter()
        // A malformed window (percent out of range or non-finite) is not a
        // quota fact and must not keep a stale valid window looking fresh.
        .filter(|window| valid_used_percent(window.percent).is_some())
        .any(|window| {
            let percent = window.percent.unwrap_or_default();
            let reset = parse_reset_seconds(window.reset_at.as_deref());
            // A window whose reset already passed is expired: it neither
            // refreshes nor masks another window's staleness.
            if reset.is_some_and(|reset| reset <= now_seconds) {
                return false;
            }
            let has_reset = reset.is_some_and(|reset| reset > observed);
            let max_age = if percent >= 100.0 && has_reset {
                QUOTA_EXHAUSTED_MAX_AGE_SECONDS
            } else {
                QUOTA_MAX_AGE_SECONDS
            };
            let expires = match (has_reset, reset) {
                (true, Some(reset)) => (observed + max_age).min(reset),
                _ => observed + max_age,
            };
            expires > now_seconds
        })
}

/// A window is a quota fact only when its reported usage is a finite 0..=100
/// percentage; everything else is dropped before display or freshness checks.
fn valid_used_percent(percent: Option<f64>) -> Option<f64> {
    percent.filter(|value| value.is_finite() && (0.0..=100.0).contains(value))
}

fn parse_rfc3339_seconds(value: &str) -> Option<i64> {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .ok()
        .map(|parsed| parsed.unix_timestamp())
}

/// `resetAt` is a provider Unix-seconds value, but accept milliseconds and ISO
/// timestamps too so a differently-shaped adapter cannot hide exhaustion.
fn parse_reset_seconds(value: Option<&str>) -> Option<i64> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(number) = value.parse::<i64>() {
        return Some(normalize_epoch(number));
    }
    if let Ok(number) = value.parse::<f64>()
        && number.is_finite()
    {
        return Some(normalize_epoch(number as i64));
    }
    parse_rfc3339_seconds(value)
}

fn normalize_epoch(value: i64) -> i64 {
    if value > 1_000_000_000_000 {
        value / 1000
    } else {
        value
    }
}

/// Compact provider-quota summary for the `xmatrix list` table. Only
/// provider-API windows are shown; a missing observation stays `-` and an
/// expired one is marked so an old balance is not read as current.
fn quota_summary(usage: Option<&protocol::LlmUsage>, now: time::OffsetDateTime) -> String {
    let Some(view) = provider_quota_view(usage, now) else {
        return "-".to_string();
    };
    let windows = view
        .windows
        .iter()
        .map(|window| {
            let label = window
                .label
                .as_deref()
                .or(window.window.as_deref())
                .unwrap_or("quota");
            let expiry = if window.expired {
                " (reset passed)"
            } else {
                ""
            };
            format!(
                "{label} used {}%{expiry}",
                format_percent(window.used_percent)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    if view.stale {
        format!("{windows} (stale)")
    } else {
        windows
    }
}

fn format_percent(value: f64) -> String {
    if value.fract().abs() < f64::EPSILON {
        format!("{}", value as i64)
    } else {
        format!("{value:.1}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn agent_fixture(extra: serde_json::Value) -> protocol::SerializedAgent {
        let mut base = json!({
            "id": "agent:owner:codex",
            "instanceId": "instance:1",
            "userId": "owner",
            "name": "codex",
            "type": "agent",
            "email": "secret@example.com",
            "metadata": { "runId": "run:1" },
            "connectedAt": "2026-09-21T18:00:00Z",
            "lastSeenAt": "2026-09-21T18:01:00Z",
            "status": "idle"
        });
        let object = base.as_object_mut().expect("fixture object");
        for (key, value) in extra.as_object().expect("extra object").clone() {
            object.insert(key, value);
        }
        serde_json::from_value(base).expect("agent fixture")
    }

    fn now() -> time::OffsetDateTime {
        time::OffsetDateTime::parse(
            "2026-09-21T18:30:00Z",
            &time::format_description::well_known::Rfc3339,
        )
        .expect("now")
    }

    #[test]
    fn machine_offline_instance_lists_as_offline() {
        // `offlineReason` is new; this CLI ignores it and shows the status the
        // Hub projected, never the idle the Instance last reported.
        let agents = [agent_fixture(json!({
            "status": "offline",
            "offlineReason": "machine_offline"
        }))];
        let value = serde_json::to_value(agent_usage_views(&agents, now())).expect("json");
        assert_eq!(value[0]["status"], "offline");
    }

    #[test]
    fn narrow_json_keeps_quota_and_drops_identity() {
        let agents = [agent_fixture(json!({
            "model": "gpt-6-astra",
            "usage": {
                "quotaSource": "provider_api",
                "quotaObservedAt": "2026-09-21T18:29:00Z",
                "quotaUsages": [
                    { "label": "1w", "window": "Codex", "percent": 100.0, "resetAt": "1790423712" }
                ]
            }
        }))];
        let value = serde_json::to_value(agent_usage_views(&agents, now())).expect("json");
        let entry = value.as_array().expect("array")[0]
            .as_object()
            .expect("entry");
        assert_eq!(entry["id"], "agent:owner:codex");
        assert_eq!(entry["type"], "agent");
        assert_eq!(entry["model"], "gpt-6-astra");
        assert!(entry.get("email").is_none());
        assert!(entry.get("metadata").is_none());
        assert!(entry.get("userId").is_none());
        let quota = entry["quota"].as_object().expect("quota");
        assert_eq!(quota["quotaSource"], "provider_api");
        assert_eq!(quota["stale"], false);
        assert_eq!(quota["windows"][0]["usedPercent"], 100.0);
        assert_eq!(quota["windows"][0]["expired"], false);
    }

    #[test]
    fn a_reported_wait_lists_as_waiting_only_while_live() {
        let waiting = json!({
            "status": "running",
            "waiting": { "kind": "tool", "label": "CI", "sinceMillis": 1_790_000_000_000u64 }
        });
        let busy = agent_fixture(json!({ "status": "busy", "runtimeState": waiting.clone() }));
        assert_eq!(display_status(&busy), "waiting");
        let value = serde_json::to_value(agent_usage_views(&[busy], now())).expect("json");
        assert_eq!(value[0]["status"], "busy");
        assert_eq!(value[0]["waiting"]["label"], "CI");
        assert_eq!(value[0]["waiting"]["sinceMillis"], 1_790_000_000_000u64);

        let offline = agent_fixture(json!({ "status": "offline", "runtimeState": waiting }));
        assert_eq!(display_status(&offline), "offline");
        let value = serde_json::to_value(agent_usage_views(&[offline], now())).expect("json");
        assert!(value[0].get("waiting").is_none());

        assert_eq!(display_status(&agent_fixture(json!({}))), "idle");
    }

    #[test]
    fn empty_list_serializes_to_empty_array() {
        let value = serde_json::to_value(agent_usage_views(&[], now())).expect("json");
        assert_eq!(value, json!([]));
    }

    #[test]
    fn missing_quota_is_omitted() {
        let value = serde_json::to_value(agent_usage_views(&[agent_fixture(json!({}))], now()))
            .expect("json");
        assert!(value[0].get("quota").is_none());
        assert_eq!(quota_summary(None, now()), "-");
    }

    #[test]
    fn non_provider_or_malformed_quota_is_omitted() {
        let session = agent_fixture(json!({
            "usage": { "quotaSource": "session", "quotaUsages": [ { "percent": 40.0 } ] }
        }));
        assert!(provider_quota_view(session.usage.as_ref(), now()).is_none());

        let malformed = agent_fixture(json!({
            "usage": {
                "quotaSource": "provider_api",
                "quotaObservedAt": "2026-09-21T18:29:00Z",
                "quotaUsages": [ { "label": "1w", "percent": 140.0 } ]
            }
        }));
        assert!(provider_quota_view(malformed.usage.as_ref(), now()).is_none());
    }

    #[test]
    fn stale_positive_balance_is_marked() {
        let usage = agent_fixture(json!({
            "usage": {
                "quotaSource": "provider_api",
                "quotaObservedAt": "2026-09-21T15:49:41Z",
                "quotaUsages": [ { "label": "1w", "percent": 12.0, "resetAt": "1790579768" } ]
            }
        }))
        .usage;
        let summary = quota_summary(usage.as_ref(), now());
        assert!(summary.starts_with("1w used 12%"), "{summary}");
        assert!(summary.ends_with("(stale)"), "{summary}");
    }

    #[test]
    fn exhausted_window_stays_fresh_until_reset() {
        let usage = agent_fixture(json!({
            "usage": {
                "quotaSource": "provider_api",
                "quotaObservedAt": "2026-09-21T15:49:41Z",
                "quotaUsages": [ { "label": "1w", "percent": 100.0, "resetAt": "1790423712" } ]
            }
        }))
        .usage;
        assert_eq!(quota_summary(usage.as_ref(), now()), "1w used 100%");
    }

    #[test]
    fn malformed_window_cannot_mask_a_stale_valid_window() {
        // Old valid 12% plus an out-of-range 140% window with a future reset.
        // The invalid window is not a quota fact, so the summary stays stale.
        let usage = agent_fixture(json!({
            "usage": {
                "quotaSource": "provider_api",
                "quotaObservedAt": "2026-09-21T15:49:41Z",
                "quotaUsages": [
                    { "label": "1w", "percent": 12.0, "resetAt": "1790579768" },
                    { "label": "5h", "percent": 140.0, "resetAt": "1790579768" }
                ]
            }
        }))
        .usage;
        let view = provider_quota_view(usage.as_ref(), now()).expect("view");
        assert_eq!(view.windows.len(), 1);
        assert!(view.stale);
        assert!(quota_summary(usage.as_ref(), now()).ends_with("(stale)"));
    }

    #[test]
    fn past_reset_window_is_marked_expired() {
        let usage = agent_fixture(json!({
            "usage": {
                "quotaSource": "provider_api",
                "quotaObservedAt": "2026-09-21T18:29:00Z",
                "quotaUsages": [
                    { "label": "5h", "percent": 40.0, "resetAt": "1790000000" },
                    { "label": "1w", "percent": 12.0, "resetAt": "1790579768" }
                ]
            }
        }))
        .usage;
        let view = provider_quota_view(usage.as_ref(), now()).expect("view");
        assert!(view.windows[0].expired);
        assert!(!view.windows[1].expired);
        // The 1w window is a fresh 12% (observed 18:29), so the account is not
        // globally stale even though the 5h window's reset already passed.
        assert!(!view.stale);
        let summary = quota_summary(usage.as_ref(), now());
        assert!(summary.contains("5h used 40% (reset passed)"), "{summary}");
        assert!(!summary.contains("(stale)"), "{summary}");
    }
}
