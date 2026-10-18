// The host observes provider terminal state. Policy, delays, permits and
// visible retry records belong to Hub; the host never schedules a retry.
const CODEX_FAILURE_TERMINAL_WAIT_SECS: u64 = 10;

fn codex_event_shows_execution(method: Option<&str>, params: &Value) -> bool {
    match method {
        Some("item/started" | "item/completed") => {
            params
                .get("item")
                .and_then(|item| item.get("type"))
                .and_then(Value::as_str)
                != Some("userMessage")
        }
        Some(method) => method.starts_with("item/") || method.starts_with("rawResponseItem/"),
        None => false,
    }
}

struct CodexCapacityRetryOffer {
    thread_id: String,
    turn_id: String,
    safe_to_continue: bool,
    error_message: String,
}

struct CodexHubRetryOperation {
    relay: Arc<agent_instance_connection::AgentInstanceConnectionClient>,
    operation_id: String,
    active: bool,
}

impl CodexHubRetryOperation {
    fn finish(&mut self, action: &str) {
        if !self.active {
            return;
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        self.relay.send_report(
            request_id.clone(),
            protocol::AgentInstanceClientMessage::AgentTurnRetry {
                request_id: Some(request_id),
                operation_id: self.operation_id.clone(),
                action: action.into(),
                thread_id: None,
                turn_id: None,
                safe_to_continue: None,
                error_message: None,
                attempt_token: None,
            },
        );
        self.active = false;
    }
}

impl Drop for CodexHubRetryOperation {
    fn drop(&mut self) {
        // A new message, model switch, shutdown or dropped transport wait ends
        // the pending operation at Hub; no detached host timer remains.
        self.finish("cancelled");
    }
}

impl CodexAppSession {
    async fn submit_turn(
        &mut self,
        request: CodexTurnRequest<'_>,
    ) -> error::Result<CodexTurnResult> {
        let mut recovery = request
            .trace_relay
            .filter(|relay| relay.hub_accepts("agent_turn_retry_channel_message"))
            .map(|relay| CodexHubRetryOperation {
                relay: relay.clone(),
                operation_id: request
                    .runtime_state
                    .and_then(AgentRuntimeStateTracker::execution_id)
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                active: false,
            });
        let mut continuation = String::new();
        let mut attempt_token = None;
        loop {
            let mut offer = None;
            let next_request = if !continuation.is_empty() {
                CodexTurnRequest {
                    text: &continuation,
                    attachments: None,
                    native: None,
                    ..request
                }
            } else {
                request
            };
            let mut result = self
                .submit_turn_attempt(next_request, &mut offer, recovery.is_some())
                .await?;
            let Some((operation, offer)) = recovery.as_mut().zip(offer) else {
                if let Some(operation) = recovery.as_mut() {
                    operation.finish(if result.failed {
                        "cancelled"
                    } else {
                        "completed"
                    });
                }
                return Ok(result);
            };
            operation.active = true;
            let answer = operation
                .relay
                .request_turn_retry(protocol::AgentInstanceClientMessage::AgentTurnRetry {
                    request_id: None,
                    operation_id: operation.operation_id.clone(),
                    action: "failed".into(),
                    thread_id: Some(offer.thread_id.clone()),
                    turn_id: Some(offer.turn_id.clone()),
                    safe_to_continue: Some(offer.safe_to_continue),
                    error_message: Some(offer.error_message.clone()),
                    attempt_token: attempt_token.clone(),
                })
                .await;
            let authorized = match answer {
                Ok(protocol::AgentInstanceServerMessage::ChannelMessageReceived { message, .. }
                    | protocol::AgentInstanceServerMessage::ChannelHistoryReplay { message, .. }) => {
                    if let Some(retry) = protocol::channel_turn_retry(&message)
                        && offer.safe_to_continue
                        && retry.operation_id == operation.operation_id
                        && request.agent.instance_id.as_deref() == Some(retry.instance_id.as_str())
                        && request.trace_channel_id == Some(message.channel_id.as_str())
                        && attempt_token.as_deref() != Some(retry.attempt_token.as_str())
                    {
                        attempt_token = Some(retry.attempt_token);
                        continuation = message.body;
                        true
                    } else { false }
                }
                Ok(protocol::AgentInstanceServerMessage::AgentTurnRetryDecision {
                    operation_id,
                    action,
                    thread_id,
                    turn_id,
                    reason: Some(reason),
                    ..
                }) if action == "stop"
                    && operation_id == operation.operation_id
                    && thread_id == offer.thread_id
                    && turn_id == offer.turn_id
                    && matches!(
                        reason.as_str(),
                        "exhausted" | "unsafe" | "expired" | "cancelled" | "ineligible"
                    ) =>
                {
                    result.failure_reported_by_hub = true;
                    false
                }
                _ => false,
            };
            if authorized {
                continue;
            }
            let trace = TurnTrace {
                relay: request.trace_relay,
                channel_id: request.trace_channel_id,
                source: "codex_app_server",
                agent: request.agent,
            };
            send_codex_turn_failed_trace(
                trace,
                &offer.thread_id,
                Some(&offer.turn_id),
                result
                    .failure_detail
                    .as_deref()
                    .unwrap_or("Hub did not authorize retry"),
                result.usage.clone(),
            )
            .await;
            operation.finish("cancelled");
            return Ok(result);
        }
    }
}
