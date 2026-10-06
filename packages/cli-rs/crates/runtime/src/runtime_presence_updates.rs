use crate::{agent_instance_connection, protocol};
use colored::Colorize;
use std::sync::Arc;

pub(crate) async fn send_llm_trace(
    relay: &Arc<agent_instance_connection::AgentInstanceConnectionClient>,
    channel_id: &str,
    phase: &str,
    agent: &protocol::SerializedAgent,
    usage: Option<protocol::LlmUsage>,
    model: Option<String>,
    payload: serde_json::Value,
) {
    send_llm_trace_with_source(
        relay,
        channel_id,
        phase,
        "codex_app_server",
        agent,
        usage,
        model,
        payload,
    )
    .await;
}

/// Where a turn reports its trace: the channel it serves, when it has one.
#[derive(Clone, Copy)]
pub(crate) struct TurnTrace<'a> {
    pub(crate) relay: Option<&'a Arc<agent_instance_connection::AgentInstanceConnectionClient>>,
    pub(crate) channel_id: Option<&'a str>,
    pub(crate) source: &'a str,
    pub(crate) agent: &'a protocol::SerializedAgent,
}

impl<'a> TurnTrace<'a> {
    /// The relay and channel the trace goes to, when the turn has both.
    pub(crate) fn target(
        &self,
    ) -> Option<(
        &'a Arc<agent_instance_connection::AgentInstanceConnectionClient>,
        &'a str,
    )> {
        self.relay.zip(self.channel_id)
    }

    pub(crate) async fn send(
        &self,
        phase: &str,
        usage: Option<protocol::LlmUsage>,
        model: Option<String>,
        payload: serde_json::Value,
    ) {
        if let Some((relay, channel_id)) = self.target() {
            send_llm_trace_with_source(
                relay,
                channel_id,
                phase,
                self.source,
                self.agent,
                usage,
                model,
                payload,
            )
            .await;
        }
    }
}

pub(crate) async fn send_llm_trace_with_source(
    relay: &Arc<agent_instance_connection::AgentInstanceConnectionClient>,
    channel_id: &str,
    phase: &str,
    source: &str,
    agent: &protocol::SerializedAgent,
    usage: Option<protocol::LlmUsage>,
    model: Option<String>,
    payload: serde_json::Value,
) {
    let trace_payload = protocol::LlmTracePayload {
        schema_version: 1,
        phase: phase.to_string(),
        source: source.to_string(),
        agent: Some(protocol::LlmTraceAgent {
            id: Some(agent.id.clone()),
            instance_id: agent.instance_id.clone(),
            channel_instance_id: None,
            runtime_instance_id: agent.instance_id.clone(),
            name: Some(agent.name.clone()),
            agent_type: Some(agent.agent_type.clone()),
        }),
        model,
        usage,
        payload: Some(payload),
    };
    let relay = relay.clone();
    if let Err(err) = relay.send_message(protocol::AgentInstanceClientMessage::EventPublish {
        request_id: None,
        channel_id: channel_id.to_string(),
        event_type: "llm_trace".to_string(),
        payload: serde_json::to_value(trace_payload).unwrap_or_else(|_| serde_json::json!({})),
        event_id: None,
        timestamp: None,
    }) {
        eprintln!("{} failed to publish LLM trace: {err}", "⚠".yellow().bold());
    }
}
