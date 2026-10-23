// Codex/ZCode turn failures: which errors are fatal, which are worth retrying,
// what the operator is told when one lands, and the reconnect accounting.

use serde_json::Value;

use crate::runtime_presence_updates::TurnTrace;
use crate::{protocol, unix_millis_now};

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

pub(crate) fn codex_app_error_message(params: &Value) -> String {
    crate::runtime_failure_detail::provider_error_detail(params)
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
