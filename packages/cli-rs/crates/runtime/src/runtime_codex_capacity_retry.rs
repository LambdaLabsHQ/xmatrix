// Capacity recovery belongs to the existing interruptible turn future, so a
// stop, new message, or parameter switch cancels its backoff as well as work.
const CODEX_CAPACITY_RETRY_DELAYS_SECS: [u64; 3] = [5, 15, 30];
const CODEX_CAPACITY_TERMINAL_WAIT_SECS: u64 = 10;

fn codex_is_model_capacity_error(error: &str) -> bool {
    error
        .trim()
        .trim_start_matches("Codex error: ")
        .to_ascii_lowercase()
        .starts_with("selected model is at capacity.")
}

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

impl CodexAppSession {
    async fn submit_turn(
        &mut self,
        request: CodexTurnRequest<'_>,
    ) -> error::Result<CodexTurnResult> {
        let mut next_request = request;
        for attempt in 0..=CODEX_CAPACITY_RETRY_DELAYS_SECS.len() {
            let mut capacity_retry_allowed = false;
            let result = self
                .submit_turn_attempt(
                    next_request,
                    &mut capacity_retry_allowed,
                    attempt < CODEX_CAPACITY_RETRY_DELAYS_SECS.len(),
                )
                .await?;
            let Some(delay_secs) = CODEX_CAPACITY_RETRY_DELAYS_SECS
                .get(attempt)
                .filter(|_| result.failed && capacity_retry_allowed)
            else {
                return Ok(result);
            };
            // Spread concurrent Instances without an additional random source.
            let jitter_ms = u64::from(uuid::Uuid::new_v4().as_bytes()[0]) * 4;
            let delay = Duration::from_secs(*delay_secs) + Duration::from_millis(jitter_ms);
            TurnTrace {
                relay: request.trace_relay,
                channel_id: request.trace_channel_id,
                source: "codex_app_server",
                agent: request.agent,
            }
            .send(
                "runtime_event",
                None,
                result.model.clone(),
                serde_json::json!({
                    "category": "connection",
                    "status": "retrying",
                    "reason": "model_capacity",
                    "attempt": attempt + 1,
                    "delayMs": delay.as_millis(),
                }),
            )
            .await;
            tokio::time::sleep(delay).await;
            // The failed turn already persisted its input, including local
            // attachments. Continue that thread rather than duplicating it.
            next_request = CodexTurnRequest {
                text: "Continue the previous request that failed because the selected model was at capacity.",
                attachments: None,
                ..request
            };
        }
        unreachable!("capacity retry budget always returns its last result")
    }
}
