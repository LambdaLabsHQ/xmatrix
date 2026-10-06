// Codex/ZCode turn failures: which errors are fatal, which are worth retrying,
// what the operator is told when one lands, and the reconnect accounting.

use colored::Colorize;
use serde_json::Value;

use crate::runtime_presence_updates::TurnTrace;
use crate::runtime_usage_limit::{UsageLimit, usage_limit_from_error};
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

const TURN_FAILURE_DETAIL_MAX_CHARS: usize = 600;

pub(crate) const AGENT_TURN_FAILURE_LIFECYCLE_LAYER: &str = "application";
pub(crate) const AGENT_TURN_FAILURE_LIFECYCLE_STATUS: &str = "failed";
pub(crate) const AGENT_TURN_FAILURE_LIFECYCLE_REASON: &str = "turn_failed";
/// A turn failure because the provider account's usage limit is used up. Hub
/// posts the same notice and hands the Instance's work to another harness.
pub(crate) const AGENT_USAGE_LIMIT_LIFECYCLE_REASON: &str = "usage_limited";

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
/// Hub persists the user-visible channel notice from this typed lifecycle
/// signal. Adapters must not post a channel body themselves for turn failures.
pub(crate) fn report_turn_failure(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    channel_id: Option<&str>,
    agent: &protocol::SerializedAgent,
    error: &str,
    runtime_restarting: bool,
) {
    report_turn_failure_with_usage_limit(relay, channel_id, agent, error, runtime_restarting, None);
}

/// The last usage-limited turn failure, until a turn completes again.
///
/// Hub hands the Instance off when it handles this signal, but the signal is
/// sent once over a socket the Hub may drop mid-handling (a deploy resets its
/// Durable Objects). A reconnect sends it again; Hub keys the notice and the
/// handoff on its content, so a repeat that was already handled changes nothing.
#[derive(Clone)]
struct PendingUsageLimit {
    agent_id: String,
    channel_id: Option<String>,
    detail: String,
    resets_at: Option<String>,
}

static PENDING_USAGE_LIMIT: std::sync::Mutex<Option<PendingUsageLimit>> =
    std::sync::Mutex::new(None);

/// A completed turn shows the provider account runs again.
pub(crate) fn clear_pending_usage_limit() {
    if let Ok(mut pending) = PENDING_USAGE_LIMIT.lock() {
        *pending = None;
    }
}

/// Send this Agent's unresolved usage limit again on a new connection.
pub(crate) fn resend_pending_usage_limit(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    agent: &protocol::SerializedAgent,
) {
    let Some(pending) = PENDING_USAGE_LIMIT
        .lock()
        .ok()
        .and_then(|pending| pending.clone())
        .filter(|pending| pending.agent_id == agent.id)
    else {
        return;
    };
    crate::send_agent_lifecycle_with_reset(
        relay,
        pending.channel_id.as_deref(),
        agent,
        AgentLifecycleNotice {
            layer: AGENT_TURN_FAILURE_LIFECYCLE_LAYER,
            status: AGENT_TURN_FAILURE_LIFECYCLE_STATUS,
            reason: Some(AGENT_USAGE_LIMIT_LIFECYCLE_REASON),
            detail: (!pending.detail.is_empty()).then_some(pending.detail.as_str()),
            snapshot: Some(protocol::AgentLifecycleSnapshot {
                presence: None,
                run: Some("failed".to_string()),
                process: Some("online".to_string()),
            }),
            resets_at: pending.resets_at.as_deref(),
        },
    );
}

/// [`report_turn_failure`] for an adapter that observed the provider's own
/// usage-limit signal; without one, the error text is classified.
pub(crate) fn report_turn_failure_with_usage_limit(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    channel_id: Option<&str>,
    agent: &protocol::SerializedAgent,
    error: &str,
    runtime_restarting: bool,
    usage_limit: Option<UsageLimit>,
) {
    let usage_limit = usage_limit.or_else(|| usage_limit_from_error(error));
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
    if let Some(limit) = usage_limit.as_ref()
        && let Ok(mut pending) = PENDING_USAGE_LIMIT.lock()
    {
        *pending = Some(PendingUsageLimit {
            agent_id: agent.id.clone(),
            channel_id: channel_id.map(str::to_string),
            detail: detail.clone(),
            resets_at: limit.resets_at.clone(),
        });
    }
    crate::send_agent_lifecycle_with_reset(
        relay,
        channel_id,
        agent,
        AgentLifecycleNotice {
            layer: AGENT_TURN_FAILURE_LIFECYCLE_LAYER,
            status: AGENT_TURN_FAILURE_LIFECYCLE_STATUS,
            reason: Some(if usage_limit.is_some() {
                AGENT_USAGE_LIMIT_LIFECYCLE_REASON
            } else {
                AGENT_TURN_FAILURE_LIFECYCLE_REASON
            }),
            detail: (!detail.is_empty()).then_some(detail.as_str()),
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
            resets_at: usage_limit
                .as_ref()
                .and_then(|limit| limit.resets_at.as_deref()),
        },
    );
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
