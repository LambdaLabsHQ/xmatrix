//! One reconnect-safe failure observation path for every harness.

use crate::runtime_usage_limit::UsageLimit;
use crate::{AgentLifecycleNotice, agent_instance_connection, protocol, truncate_chars};
use colored::Colorize;

/// The whole provider error up to this bound reaches Hub, which classifies it
/// and bounds what the Channel shows.
const TURN_FAILURE_DETAIL_MAX_CHARS: usize = 4_000;

pub(crate) const AGENT_TURN_FAILURE_LIFECYCLE_LAYER: &str = "application";
pub(crate) const AGENT_TURN_FAILURE_LIFECYCLE_STATUS: &str = "failed";
pub(crate) const AGENT_TURN_FAILURE_LIFECYCLE_REASON: &str = "turn_failed";
/// A turn failure the provider itself reported as a used-up account (Claude's
/// `rate_limit_event`). Hub reads usage limits from the error text itself.
pub(crate) const AGENT_USAGE_LIMIT_LIFECYCLE_REASON: &str = "usage_limited";
/// A turn or start that failed because the harness's own account is signed
/// out or its sign-in expired. Hub answers it with a sign-in card naming the
/// program and Machine, and routing stops choosing it until it signs in.
pub(crate) const AGENT_SIGNED_OUT_LIFECYCLE_REASON: &str = "harness_signed_out";

/// Whether a harness's error says its own sign-in is missing or expired. The
/// vendors' wording, as observed: Claude Code's "Failed to authenticate: OAuth
/// session expired and could not be refreshed" and "Please run /login", Codex's
/// "Not logged in", API key and 401 refusals.
pub(crate) fn harness_signed_out_error(detail: &str) -> bool {
    let text = detail.to_ascii_lowercase();
    [
        "failed to authenticate",
        "oauth session expired",
        "oauth token has expired",
        "not logged in",
        "please run /login",
        "run `claude /login`",
        "invalid api key",
        "authentication_error",
        "authentication required",
        "login required",
        "401 unauthorized",
    ]
    .iter()
    .any(|marker| text.contains(marker))
}

fn compact_notice_line(value: &str, max_chars: usize) -> String {
    let safe = xmatrix_cli_core::failure_detail::sanitize(value, max_chars * 4);
    let compact = safe
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    truncate_chars(&compact, max_chars)
}

/// The only runtime path that may mark a provider turn failed.
///
/// The host reports the fact: the provider's error and, when the provider
/// said so itself, its usage limit. Hub classifies it and persists the
/// user-visible channel notice. Adapters must not post a channel body.
pub(crate) fn report_turn_failure(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    channel_id: Option<&str>,
    agent: &protocol::SerializedAgent,
    error: &str,
    runtime_restarting: bool,
) {
    report_turn_failure_with_usage_limit(relay, channel_id, agent, error, runtime_restarting, None);
}

/// The last turn failure, until a turn completes again.
///
/// Hub posts its notice and may hand the Instance off when it handles this
/// signal, but the signal is sent once over a socket the Hub may drop
/// mid-handling (a deploy resets its Durable Objects). A reconnect sends it
/// again under the same id; Hub keys the notice and the handoff on it, so a
/// repeat that was already handled changes nothing.
#[derive(Clone)]
struct PendingTurnFailure {
    agent_id: String,
    channel_id: Option<String>,
    failure_id: String,
    reason: &'static str,
    detail: String,
    resets_at: Option<String>,
}

static PENDING_TURN_FAILURE: std::sync::Mutex<Option<PendingTurnFailure>> =
    std::sync::Mutex::new(None);

/// A completed turn ends the failure Hub still has to learn about.
pub(crate) fn clear_pending_turn_failure() {
    if let Ok(mut pending) = PENDING_TURN_FAILURE.lock() {
        *pending = None;
    }
}

/// Send this Agent's last unresolved turn failure again on a new connection.
pub(crate) fn resend_pending_turn_failure(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    agent: &protocol::SerializedAgent,
) {
    let Some(pending) = PENDING_TURN_FAILURE
        .lock()
        .ok()
        .and_then(|pending| pending.clone())
        .filter(|pending| pending.agent_id == agent.id)
    else {
        return;
    };
    send_turn_failure(relay, agent, &pending, false);
}

fn send_turn_failure(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    agent: &protocol::SerializedAgent,
    failure: &PendingTurnFailure,
    runtime_restarting: bool,
) {
    crate::send_agent_lifecycle_with_reset(
        relay,
        failure.channel_id.as_deref(),
        agent,
        AgentLifecycleNotice {
            request_id: Some(&failure.failure_id),
            layer: AGENT_TURN_FAILURE_LIFECYCLE_LAYER,
            status: AGENT_TURN_FAILURE_LIFECYCLE_STATUS,
            reason: Some(failure.reason),
            detail: (!failure.detail.is_empty()).then_some(failure.detail.as_str()),
            snapshot: Some(protocol::AgentLifecycleSnapshot {
                presence: None,
                run: Some("failed".to_string()),
                process: Some(
                    if runtime_restarting {
                        "reconnecting"
                    } else {
                        "online"
                    }
                    .to_string(),
                ),
            }),
            resets_at: failure.resets_at.as_deref(),
        },
    );
}

/// [`report_turn_failure`] for an adapter that observed the provider's own
/// usage-limit signal.
pub(crate) fn report_turn_failure_with_usage_limit(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    channel_id: Option<&str>,
    agent: &protocol::SerializedAgent,
    error: &str,
    runtime_restarting: bool,
    usage_limit: Option<UsageLimit>,
) {
    let detail = compact_notice_line(error, TURN_FAILURE_DETAIL_MAX_CHARS);
    crate::write_current_run_status(
        "turn_failed",
        false,
        Some(if detail.is_empty() {
            error
        } else {
            detail.as_str()
        }),
    );
    if detail.is_empty() {
        eprintln!("{} {error}", "⚠".yellow().bold());
    } else {
        eprintln!("{} {detail}", "⚠".yellow().bold());
    }
    let failure = PendingTurnFailure {
        agent_id: agent.id.clone(),
        channel_id: channel_id.map(str::to_string),
        failure_id: uuid::Uuid::new_v4().to_string(),
        reason: if usage_limit.is_some() {
            AGENT_USAGE_LIMIT_LIFECYCLE_REASON
        } else if harness_signed_out_error(error) {
            AGENT_SIGNED_OUT_LIFECYCLE_REASON
        } else {
            AGENT_TURN_FAILURE_LIFECYCLE_REASON
        },
        detail,
        resets_at: usage_limit.and_then(|limit| limit.resets_at),
    };
    if let Ok(mut pending) = PENDING_TURN_FAILURE.lock() {
        *pending = Some(failure.clone());
    }
    send_turn_failure(relay, agent, &failure, runtime_restarting);
}
