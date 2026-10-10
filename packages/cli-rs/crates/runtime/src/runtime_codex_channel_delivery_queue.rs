#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HeadlessRuntimeBoundary {
    PromptIdle,
    ClaudeToolUse,
    ClaudeToolResult,
    ClaudeResult,
}

fn claude_stream_boundaries_from_line(line: &str) -> Vec<HeadlessRuntimeBoundary> {
    let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
        return Vec::new();
    };

    match value.get("type").and_then(Value::as_str) {
        Some("assistant") => {
            let has_tool_use = value
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(Value::as_array)
                .map(|content| content.iter().any(claude_is_tool_use_block))
                .unwrap_or(false);
            if has_tool_use {
                vec![HeadlessRuntimeBoundary::ClaudeToolUse]
            } else {
                Vec::new()
            }
        }
        Some("user") => {
            let tool_results = value
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(Value::as_array)
                .map(|content| {
                    content
                        .iter()
                        .filter(|block| {
                            block.get("type").and_then(Value::as_str) == Some("tool_result")
                        })
                        .count()
                })
                .unwrap_or(0);
            vec![HeadlessRuntimeBoundary::ClaudeToolResult; tool_results]
        }
        Some("result") => vec![HeadlessRuntimeBoundary::ClaudeResult],
        _ => Vec::new(),
    }
}

async fn flush_headless_delivery_queue(
    pending: &mut VecDeque<String>,
    pty_writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    downstream_kkp_flags: &Arc<AtomicU32>,
) -> bool {
    if pending.is_empty() {
        return false;
    }

    let mut payloads = Vec::with_capacity(pending.len());
    while let Some(payload) = pending.pop_front() {
        payloads.push(payload);
    }

    let payload = if payloads.len() == 1 {
        payloads.remove(0)
    } else {
        format!(
            "Buffered xMatrix messages delivered at a safe boundary:\n\n{}",
            payloads.join("\n---\n")
        )
    };
    inject_remote_submission(pty_writer, downstream_kkp_flags, &payload).await;
    true
}

struct InboundChannelMessage {
    message_id: String,
    channel_id: String,
    sequence: Option<u64>,
    entity_version: Option<u64>,
    body_hash: Option<String>,
    from: protocol::MessageSender,
    body: String,
    reply_to_message_id: Option<String>,
    reply_to: Option<protocol::ChannelReplyContext>,
    attachments: Option<Vec<protocol::ChannelAttachment>>,
    metadata: Option<serde_json::Value>,
}

impl InboundChannelMessage {
    /// This message as `agent` reads it in a turn prompt. The first message
    /// of a turn also carries what its channel saw as context since the last
    /// one, which is taken here so the run reads it once.
    fn prompt_text(
        &self,
        agent: &protocol::SerializedAgent,
        local_files: Option<&LocalImageFiles>,
    ) -> String {
        let text = format_incoming_channel_message_with_context(
            &self.channel_id,
            Some(&self.message_id),
            self.reply_to_message_id.as_deref(),
            self.reply_to.as_ref(),
            reply_to_current_agent(self.reply_to.as_ref(), agent),
            &self.from,
            self.metadata.as_ref(),
            &self.body,
            self.attachments.as_deref(),
            local_files,
        );
        let context = agent_instance_connection::take_context_for_next_turn(&self.channel_id);
        match runtime_channel_history_bootstrap::render_channel_context_block(
            &self.channel_id,
            &context,
            xmatrix_cli_core::instant::now_utc_rfc3339().as_deref(),
        ) {
            Some(context) => format!("{context}\n\n{text}"),
            None => text,
        }
    }
}

/// One turn prompt for a delivered batch whose images stay as links.
fn inbound_channel_batch_prompt(
    messages: &[InboundChannelMessage],
    agent: &protocol::SerializedAgent,
) -> String {
    combined_inbound_channel_prompt(
        messages
            .iter()
            .map(|message| message.prompt_text(agent, None))
            .collect(),
    )
}

/// The message a batch's turn status and execution are recorded against.
fn primary_inbound_message_id(messages: &[InboundChannelMessage]) -> String {
    messages
        .first()
        .map(|message| message.message_id.clone())
        .unwrap_or_default()
}

fn ack_inbound_channel_messages(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    messages: &[InboundChannelMessage],
) {
    for message in messages {
        let _ = relay.ack_channel_message(
            message.message_id.clone(),
            message.channel_id.clone(),
            message.sequence,
        );
    }
}

fn inbound_channel_message_from_event(
    event: agent_instance_connection::AgentInstanceConnectionEvent,
) -> Result<InboundChannelMessage, agent_instance_connection::AgentInstanceConnectionEvent> {
    match event {
        agent_instance_connection::AgentInstanceConnectionEvent::Server(
            protocol::AgentInstanceServerMessage::ChannelMessageReceived { message, .. }
            | protocol::AgentInstanceServerMessage::ChannelHistoryReplay { message, .. },
        ) => {
            // The frame carries the message nested; unpack it once here so the
            // delivery this runtime acts on is the message itself.
            let protocol::ChannelMessage {
                message_id,
                channel_id,
                sequence,
                entity_version,
                body_hash,
                from,
                body,
                reply_to_message_id,
                reply_to,
                mut attachments,
                metadata,
                ..
            } = message;
            if let Some(ref mut attachments) = attachments {
                for attachment in attachments {
                    if attachment.channel_id.is_none() {
                        attachment.channel_id = Some(channel_id.clone());
                    }
                    if attachment.message_id.is_none() {
                        attachment.message_id = Some(message_id.clone());
                    }
                }
            }
            Ok(InboundChannelMessage {
                message_id,
                channel_id,
                sequence,
                entity_version,
                body_hash,
                from,
                body,
                reply_to_message_id,
                reply_to,
                attachments,
                metadata,
            })
        }
        other => Err(other),
    }
}

enum ChannelDeliveryPrep {
    Continue,
    Ready {
        primary_channel_id: String,
        inbound_messages: Vec<InboundChannelMessage>,
    },
}

/// One channel-delivery ceremony for every vendor run loop: `None` when the
/// event carried nothing for this run, else the batch to deliver.
async fn next_channel_delivery(
    event: agent_instance_connection::AgentInstanceConnectionEvent,
    auto_join_channel_id: Option<&str>,
    agent: &protocol::SerializedAgent,
    event_rx: &mut mpsc::UnboundedReceiver<agent_instance_connection::AgentInstanceConnectionEvent>,
    pending_events: &mut VecDeque<agent_instance_connection::AgentInstanceConnectionEvent>,
) -> Option<(String, Vec<InboundChannelMessage>)> {
    match prepare_channel_delivery_from_event(
        event,
        auto_join_channel_id,
        agent,
        event_rx,
        pending_events,
    )
    .await
    {
        ChannelDeliveryPrep::Continue => None,
        ChannelDeliveryPrep::Ready {
            primary_channel_id,
            inbound_messages,
        } => Some((primary_channel_id, inbound_messages)),
    }
}

fn is_channel_delivery_connection_event(
    event: &agent_instance_connection::AgentInstanceConnectionEvent,
) -> bool {
    matches!(
        event,
        agent_instance_connection::AgentInstanceConnectionEvent::Server(
            protocol::AgentInstanceServerMessage::ChannelMessageReceived { .. }
                | protocol::AgentInstanceServerMessage::ChannelHistoryReplay { .. }
        )
    )
}

/// Shared accept / batch-drain prefix for vendor run loops.
async fn prepare_channel_delivery_batch(
    auto_join_channel_id: Option<&str>,
    agent: &protocol::SerializedAgent,
    event_rx: &mut mpsc::UnboundedReceiver<agent_instance_connection::AgentInstanceConnectionEvent>,
    pending_events: &mut VecDeque<agent_instance_connection::AgentInstanceConnectionEvent>,
    seed: InboundChannelMessage,
) -> ChannelDeliveryPrep {
    if !runtime_accepts_channel_delivery(auto_join_channel_id, &seed.channel_id) {
        return ChannelDeliveryPrep::Continue;
    }
    let primary_channel_id = seed.channel_id.clone();
    let mut inbound_messages = vec![seed];
    drain_ready_inbound_channel_messages(
        event_rx,
        pending_events,
        &primary_channel_id,
        &mut inbound_messages,
        Some(agent),
    );
    ChannelDeliveryPrep::Ready {
        primary_channel_id,
        inbound_messages,
    }
}

async fn prepare_channel_delivery_from_event(
    event: agent_instance_connection::AgentInstanceConnectionEvent,
    auto_join_channel_id: Option<&str>,
    agent: &protocol::SerializedAgent,
    event_rx: &mut mpsc::UnboundedReceiver<agent_instance_connection::AgentInstanceConnectionEvent>,
    pending_events: &mut VecDeque<agent_instance_connection::AgentInstanceConnectionEvent>,
) -> ChannelDeliveryPrep {
    let seed = inbound_channel_message_from_event(event).expect("channel delivery event");
    prepare_channel_delivery_batch(auto_join_channel_id, agent, event_rx, pending_events, seed)
        .await
}

/// Drains queued events into the batch. Returns true when draining stopped in
/// front of an instance-directed slash command, which must seed its own
/// delivery instead of being buried in a batch (see
/// [`drain_ready_inbound_channel_messages`]).
fn drain_pending_inbound_channel_messages(
    pending_events: &mut VecDeque<agent_instance_connection::AgentInstanceConnectionEvent>,
    channel_id: &str,
    messages: &mut Vec<InboundChannelMessage>,
    passthrough_agent: Option<&protocol::SerializedAgent>,
) -> bool {
    let batch_max_messages = inbound_delivery_batch_max_messages();
    if pending_events.is_empty() {
        return false;
    }

    let mut restored = VecDeque::with_capacity(pending_events.len());
    let mut slash_boundary = false;
    while let Some(event) = pending_events.pop_front() {
        if slash_boundary {
            restored.push_back(event);
            continue;
        }
        match inbound_channel_message_from_event(event.clone()) {
            Ok(message)
                if message.channel_id == channel_id && messages.len() < batch_max_messages =>
            {
                if passthrough_agent
                    .is_some_and(|agent| is_instance_slash_passthrough_message(&message, agent))
                {
                    slash_boundary = true;
                    restored.push_back(event);
                } else {
                    messages.push(message);
                }
            }
            Ok(_) => restored.push_back(event),
            Err(other) => restored.push_back(other),
        }
    }
    *pending_events = restored;
    slash_boundary
}

fn drain_ready_inbound_channel_messages(
    event_rx: &mut mpsc::UnboundedReceiver<agent_instance_connection::AgentInstanceConnectionEvent>,
    pending_events: &mut VecDeque<agent_instance_connection::AgentInstanceConnectionEvent>,
    channel_id: &str,
    messages: &mut Vec<InboundChannelMessage>,
    passthrough_agent: Option<&protocol::SerializedAgent>,
) {
    let batch_max_messages = inbound_delivery_batch_max_messages();
    // An instance-directed slash command only fires the passthrough when it is
    // the sole message of its delivery (#569), so it never shares a batch: a
    // batch seeded with one takes no further messages, and draining stops in
    // front of one so it seeds the next delivery in arrival order.
    if passthrough_agent.is_some_and(|agent| {
        messages
            .iter()
            .any(|message| is_instance_slash_passthrough_message(message, agent))
    }) {
        return;
    }
    if drain_pending_inbound_channel_messages(
        pending_events,
        channel_id,
        messages,
        passthrough_agent,
    ) {
        return;
    }

    while messages.len() < batch_max_messages {
        let Ok(event) = event_rx.try_recv() else {
            break;
        };
        match inbound_channel_message_from_event(event.clone()) {
            Ok(message) if message.channel_id == channel_id => {
                if passthrough_agent
                    .is_some_and(|agent| is_instance_slash_passthrough_message(&message, agent))
                {
                    pending_events.push_back(event);
                    break;
                }
                messages.push(message);
            }
            Ok(_) => pending_events.push_back(event),
            Err(other) => {
                pending_events.push_back(other);
                break;
            }
        }
    }
}

fn inbound_delivery_batch_max_messages() -> usize {
    inbound_delivery_batch_max_messages_from_env(
        std::env::var(INBOUND_DELIVERY_BATCH_MAX_MESSAGES_ENV)
            .ok()
            .as_deref(),
    )
}

fn inbound_delivery_batch_max_messages_from_env(value: Option<&str>) -> usize {
    value
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_INBOUND_DELIVERY_BATCH_MAX_MESSAGES)
        .min(100)
}

fn inbound_execution_sources(
    messages: &[InboundChannelMessage],
) -> Vec<protocol::AgentRuntimeMessageSource> {
    messages
        .iter()
        .filter_map(|message| {
            if [&message.channel_id, &message.message_id].iter().any(|id| {
                id.is_empty()
                    || id.len() > 300
                    || id.trim() != id.as_str()
                    || id.chars().any(char::is_control)
            }) {
                return None;
            }
            let sequence = message.sequence.filter(|value| *value > 0)?;
            let entity_version = message.entity_version.filter(|value| *value > 0)?;
            let body_hash = message.body_hash.as_ref().filter(|hash| {
                hash.len() == 64
                    && hash
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })?;
            Some(protocol::AgentRuntimeMessageSource {
                channel_id: message.channel_id.clone(),
                message_id: message.message_id.clone(),
                sequence,
                entity_version,
                body_hash: body_hash.clone(),
            })
        })
        .collect()
}

fn combined_inbound_channel_attachments(
    messages: &[InboundChannelMessage],
) -> Option<Vec<protocol::ChannelAttachment>> {
    let attachments = messages
        .iter()
        .flat_map(|message| message.attachments.clone().unwrap_or_default())
        .collect::<Vec<_>>();
    (!attachments.is_empty()).then_some(attachments)
}

fn combined_inbound_channel_prompt(parts: Vec<String>) -> String {
    if parts.len() == 1 {
        parts.into_iter().next().unwrap_or_default()
    } else {
        format!(
            "Multiple xMatrix messages delivered together:\n\n{}",
            parts.join("\n---\n")
        )
    }
}

fn redact_data_urls(input: &str) -> String {
    let mut output = String::with_capacity(input.len().min(4096));
    let mut cursor = 0;

    while let Some(relative_start) = input[cursor..].find("data:") {
        let start = cursor + relative_start;
        output.push_str(&input[cursor..start]);

        let end = input[start..]
            .char_indices()
            .find(|(_, ch)| {
                ch.is_whitespace() || matches!(ch, '"' | '\'' | ')' | ']' | '}' | '<' | '>')
            })
            .map(|(offset, _)| start + offset)
            .unwrap_or(input.len());
        let candidate = &input[start..end];

        if candidate.contains(";base64,") {
            output.push_str(&format!("[data URL redacted: {} chars]", candidate.len()));
        } else {
            output.push_str(candidate);
        }
        cursor = end;
    }

    output.push_str(&input[cursor..]);
    output
}

fn encode_submission_enter(flags: u32) -> &'static [u8] {
    if let Some(enter) = submission_enter_override() {
        return enter;
    }

    #[cfg(windows)]
    {
        let _ = flags;
        b"\n"
    }

    #[cfg(not(windows))]
    {
        kkp::encode_enter(flags)
    }
}

fn submission_enter_override() -> Option<&'static [u8]> {
    let value = std::env::var("XMATRIX_SUBMISSION_ENTER").ok()?;
    match value.trim().to_ascii_lowercase().as_str() {
        "cr" => Some(b"\r"),
        "lf" => Some(b"\n"),
        "kkp" | "csi13u" => Some(b"\x1b[13u"),
        "csi13_1u" | "csi13;1u" => Some(b"\x1b[13;1u"),
        _ => None,
    }
}
