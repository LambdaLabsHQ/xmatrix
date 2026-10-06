// Shared agent-instance connection lifecycle notices used by multiple vendor run loops.
// Real module (not include!) extracted for the zero-threshold rust jscpd gate.

use crate::TerminationSignals;
use crate::agent_instance_connection;
use crate::protocol;
use crate::send_agent_lifecycle;
use colored::Colorize;
use std::collections::VecDeque;
use tokio::sync::mpsc;

/// Wait for the next buffered/live connection event or a process termination
/// signal. All vendor loops use the same shutdown boundary and treat a closed
/// event stream as loop termination.
pub(crate) async fn next_agent_event_or_termination(
    termination_signals: &mut TerminationSignals,
    pending_events: &mut VecDeque<agent_instance_connection::AgentInstanceConnectionEvent>,
    event_rx: &mut mpsc::UnboundedReceiver<agent_instance_connection::AgentInstanceConnectionEvent>,
) -> Option<agent_instance_connection::AgentInstanceConnectionEvent> {
    tokio::select! {
        biased;
        _ = tokio::signal::ctrl_c() => None,
        _ = termination_signals.recv() => None,
        event = async {
            if let Some(event) = pending_events.pop_front() {
                Some(event)
            } else {
                event_rx.recv().await
            }
        } => event,
    }
}

pub(crate) fn emit_agent_connection_lost_lifecycle(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    auto_join_channel_id: Option<&str>,
    agent: &protocol::SerializedAgent,
    reason: &str,
) {
    eprintln!("{} Connection lost: {reason}", "⚠".yellow().bold());
    if let Some(channel_id) = auto_join_channel_id {
        send_agent_lifecycle(
            relay,
            Some(channel_id),
            agent,
            "transport",
            "reconnecting",
            Some("reconnecting"),
            Some(reason),
            Some(protocol::AgentLifecycleSnapshot {
                presence: Some("reconnecting".to_string()),
                run: None,
                process: Some("online".to_string()),
            }),
        );
    }
}

pub(crate) fn emit_agent_connection_reconnected_lifecycle(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    auto_join_channel_id: Option<&str>,
    reconnected_agent: &protocol::SerializedAgent,
) {
    eprintln!(
        "{} Reconnected as {} ({})",
        "✓".green().bold(),
        reconnected_agent.name,
        reconnected_agent.id.dimmed()
    );
    if let Some(channel_id) = auto_join_channel_id {
        send_agent_reconnected_lifecycle(relay, channel_id, reconnected_agent);
    }
    crate::resend_pending_usage_limit(relay, reconnected_agent);
}

/// Tell `channel_id` the agent's transport is back online.
pub(crate) fn send_agent_reconnected_lifecycle(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    channel_id: &str,
    reconnected_agent: &protocol::SerializedAgent,
) {
    send_agent_lifecycle(
        relay,
        Some(channel_id),
        reconnected_agent,
        "transport",
        "reconnected",
        Some("reconnected"),
        None,
        Some(protocol::AgentLifecycleSnapshot {
            presence: Some("online".to_string()),
            run: None,
            process: Some("online".to_string()),
        }),
    );
}

pub(crate) fn emit_agent_connection_error_lifecycle(message: &str) {
    eprintln!("{} {message}", "⚠".yellow().bold());
}

pub(crate) fn emit_agent_shutdown_requested_lifecycle(reason: Option<String>) {
    eprintln!(
        "{} Shutdown requested: {}",
        "○".cyan().bold(),
        reason.unwrap_or_else(|| "stopped from xMatrix".to_string())
    );
}

/// Shared transport lifecycle handling for dual-vendor run loops.
///
/// Returns `Some(true)` when the loop should disconnect and break,
/// `Some(false)` when the event was handled without breaking, and
/// `None` when the event is not a transport lifecycle event.
pub(crate) fn try_handle_vendor_connection_lifecycle(
    event: &agent_instance_connection::AgentInstanceConnectionEvent,
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    auto_join_channel_id: Option<&str>,
    agent: &protocol::SerializedAgent,
) -> Option<bool> {
    match event {
        agent_instance_connection::AgentInstanceConnectionEvent::Disconnected { reason } => {
            emit_agent_connection_lost_lifecycle(relay, auto_join_channel_id, agent, reason);
            Some(false)
        }
        agent_instance_connection::AgentInstanceConnectionEvent::Reconnected {
            agent: reconnected_agent,
            ..
        } => {
            emit_agent_connection_reconnected_lifecycle(
                relay,
                auto_join_channel_id,
                reconnected_agent,
            );
            Some(false)
        }
        agent_instance_connection::AgentInstanceConnectionEvent::Server(
            protocol::AgentInstanceServerMessage::Error { message, .. },
        ) => {
            emit_agent_connection_error_lifecycle(message);
            Some(false)
        }
        agent_instance_connection::AgentInstanceConnectionEvent::Server(
            protocol::AgentInstanceServerMessage::ShutdownRequested { reason },
        ) => {
            emit_agent_shutdown_requested_lifecycle(reason.clone());
            Some(true)
        }
        _ => None,
    }
}
