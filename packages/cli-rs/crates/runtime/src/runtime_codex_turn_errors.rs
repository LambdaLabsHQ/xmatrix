// Codex/ZCode turn failures: which errors are fatal, which are worth retrying,
// what the operator is told when one lands, and the reconnect accounting.

use colored::Colorize;
use serde_json::Value;

use crate::runtime_presence_updates::TurnTrace;
use crate::runtime_usage_limit::UsageLimit;
use crate::{
    AgentLifecycleNotice, agent_instance_connection, protocol, truncate_chars, unix_millis_now,
};

pub(crate) async fn send_codex_turn_failed_trace(
    trace: TurnTrace<'_>,
    thread_id: &str,
    turn_id: Option<&str>,
    error: &str,
    usage: Option<protocol::LlmUsage>,
) {
    let phase = if is_cancelled_turn_error(error) {
        "turn_cancelled"
    } else {
        "turn_failed"
    };
    let error_key = if phase == "turn_cancelled" {
        "reason"
    } else {
        "error"
    };
    trace
        .send(
            phase,
            usage,
            None,
            serde_json::json!({
                "threadId": thread_id,
                "turnId": turn_id,
                error_key: error,
            }),
        )
        .await;
}

fn is_cancelled_turn_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("cancelled")
        || lower.contains("canceled")
        || lower.contains("aborted")
        || lower.contains("interrupted")
        || lower.contains("operation was canceled")
        || lower.contains("operation was cancelled")
}

pub(crate) fn codex_turn_error_message(error: &str) -> String {
    if is_cancelled_turn_error(error) {
        format!("Codex app-server turn cancelled: {error}")
    } else {
        format!("Codex app-server turn failed: {error}")
    }
}

pub(crate) fn codex_turn_error_requires_restart(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("codex app-server exited")
        || lower.contains("codex app-server write failed")
        || lower.contains("codex app-server flush failed")
        || lower.contains("turn timed out")
        || lower.contains("codex app-server connection lost")
}

pub(crate) fn codex_auth_failure_requires_exit(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("token could not be refreshed")
        || lower.contains("run `codex login`")
        || lower.contains("run: codex login")
        || (lower.contains("refresh token")
            && (lower.contains("log out")
                || lower.contains("logged out")
                || lower.contains("sign in again")
                || lower.contains("switched accounts")))
}

pub(crate) fn codex_turn_error_retryable_before_start(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("codex app-server write failed")
        || lower.contains("codex app-server flush failed")
        || lower.contains("codex app-server exited")
        || lower.contains("codex app-server thread not initialized")
}

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
    let compact = value
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

pub(crate) fn codex_app_error_message(params: &Value) -> String {
    for key in ["message", "error", "detail", "reason"] {
        if let Some(message) = params.get(key).and_then(Value::as_str) {
            let message = message.trim();
            if !message.is_empty() {
                return message.to_string();
            }
        }
    }
    if let Some(error) = params.get("error")
        && let Some(message) = codex_app_error_message_from_value(error)
    {
        return message;
    }
    if let Some(message) = codex_app_error_message_from_value(params) {
        return message;
    }
    params.to_string()
}

pub(crate) fn zcode_message_id_matches(value: Option<&Value>, expected: &str) -> bool {
    match value {
        Some(Value::String(id)) => id == expected,
        Some(Value::Number(id)) => id.to_string() == expected,
        _ => false,
    }
}

pub(crate) fn zcode_is_session_event(message: &Value) -> bool {
    if message.get("method").and_then(Value::as_str) == Some("session/event") {
        return true;
    }
    let Some(params) = message.get("params") else {
        return false;
    };
    params.get("sessionId").and_then(Value::as_str).is_some()
        && params.get("type").and_then(Value::as_str).is_some()
}

fn zcode_goal_containers(value: &Value) -> Vec<&Value> {
    let mut containers = vec![value];
    if let Some(params) = value.get("params") {
        containers.push(params);
        if let Some(payload) = params.get("payload") {
            containers.push(payload);
            if let Some(snapshot) = payload.get("snapshot") {
                containers.push(snapshot);
            }
        }
        if let Some(snapshot) = params.get("snapshot") {
            containers.push(snapshot);
        }
    }
    if let Some(snapshot) = value.get("snapshot") {
        containers.push(snapshot);
    }
    containers
}

fn zcode_goal_target(value: &Value) -> Option<(&Value, &Value)> {
    for container in zcode_goal_containers(value) {
        for pointer in ["/session/target", "/projection/target", "/target"] {
            if let Some(target) = container.pointer(pointer) {
                return Some((target, container));
            }
        }
    }
    None
}

/// When a goal last changed, as the provider stamped it (text or epoch
/// millis); a goal without a stamp is taken as changed now.
pub(crate) fn goal_updated_at(stamp: Option<&Value>) -> Option<String> {
    stamp
        .and_then(|value| {
            value
                .as_str()
                .map(str::to_string)
                .or_else(|| value.as_u64().map(|value| value.to_string()))
        })
        .or_else(|| Some(unix_millis_now().to_string()))
}

pub(crate) fn zcode_goal_state_from_value(
    value: &Value,
) -> Option<Option<protocol::AgentGoalStatus>> {
    let (target, snapshot) = zcode_goal_target(value)?;
    if target.is_null() {
        return Some(None);
    }
    if !target.is_object() {
        return None;
    }

    let status = target
        .get("status")
        .and_then(Value::as_str)
        .map(str::to_string);
    let active = status.as_deref().map(|status| status == "active");
    let stats = snapshot.get("goalStats").unwrap_or(&Value::Null);
    let verification = snapshot
        .pointer("/runtime/goalVerifications")
        .or_else(|| snapshot.pointer("/session/runtime/goalVerifications"))
        .and_then(Value::as_array)
        .and_then(|items| items.last());
    let updated_at = goal_updated_at(target.get("updatedAt"));

    Some(Some(protocol::AgentGoalStatus {
        active,
        objective: target
            .get("objective")
            .and_then(Value::as_str)
            .map(str::to_string),
        status,
        updated_at,
        reason: verification
            .and_then(|value| value.get("reason"))
            .and_then(Value::as_str)
            .map(str::to_string),
        next_action: verification
            .and_then(|value| value.get("nextAction"))
            .and_then(Value::as_str)
            .map(str::to_string),
        tokens_used: stats
            .get("tokensUsed")
            .or_else(|| target.get("tokensUsed"))
            .and_then(Value::as_u64),
        time_used_seconds: stats
            .get("timeUsedSeconds")
            .or_else(|| target.get("timeUsedSeconds"))
            .and_then(Value::as_u64),
        iteration_count: stats.get("iterationCount").and_then(Value::as_u64),
        context_used: stats.get("contextUsed").and_then(Value::as_u64),
        tool_call_count: stats.get("toolCallCount").and_then(Value::as_u64),
    }))
}

pub(crate) fn zcode_goal_active_input_id(value: &Value) -> Option<String> {
    zcode_goal_target(value)
        .and_then(|(target, _)| target.get("activeInputId"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub(crate) fn zcode_app_error_message(params: &Value) -> String {
    codex_app_error_message(params)
}

fn codex_app_error_message_from_value(value: &Value) -> Option<String> {
    match value {
        Value::String(message) => {
            let message = message.trim();
            (!message.is_empty()).then(|| message.to_string())
        }
        Value::Object(map) => {
            for key in ["message", "error", "detail", "reason"] {
                if let Some(message) = map.get(key).and_then(Value::as_str) {
                    let message = message.trim();
                    if !message.is_empty() {
                        return Some(message.to_string());
                    }
                }
            }
            None
        }
        _ => None,
    }
}

pub(crate) fn codex_app_error_is_transient_transport(error: &str) -> bool {
    let normalized = error.trim().to_ascii_lowercase();
    normalized.starts_with("reconnecting...") || codex_app_error_is_https_fallback(&normalized)
}

pub(crate) fn codex_app_error_is_https_fallback(error: &str) -> bool {
    error
        .trim()
        .to_ascii_lowercase()
        .contains("falling back from websockets to https transport")
}

pub(crate) fn codex_reconnect_attempts(error: &str) -> Option<(u32, u32)> {
    let normalized = error.trim().to_ascii_lowercase();
    let rest = normalized.strip_prefix("reconnecting...")?;
    let fraction = rest.split_whitespace().next()?;
    let (attempt, max_attempts) = fraction.split_once('/')?;
    Some((attempt.parse().ok()?, max_attempts.parse().ok()?))
}

pub(crate) fn codex_reconnect_wait_timeout_error(last_error: &str, waited_secs: u64) -> String {
    format!(
        "Codex app-server connection lost: no events for {waited_secs}s after final reconnect attempt ({last_error})"
    )
}
