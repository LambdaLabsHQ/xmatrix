async fn submit_codex_turn_interruptible(
    app: &mut CodexAppSession,
    event_rx: &mut mpsc::UnboundedReceiver<agent_instance_connection::AgentInstanceConnectionEvent>,
    pending_events: &mut VecDeque<agent_instance_connection::AgentInstanceConnectionEvent>,
    request: CodexTurnRequest<'_>,
) -> InterruptibleCodexTurn {
    let CodexTurnRequest {
        model,
        models,
        agent,
        trace_relay,
        trace_channel_id,
        interrupt_history_replay,
        runtime_state,
        ..
    } = request;
    let interrupter = app.interrupter();
    let turn = app.submit_turn(request);
    tokio::pin!(turn);

    loop {
        tokio::select! {
            biased;
            result = &mut turn => {
                return InterruptibleCodexTurn::Completed(result);
            }
            event = event_rx.recv() => {
                let Some(event) = event else {
                    return InterruptibleCodexTurn::EventStreamClosed;
                };
                match event {
                    agent_instance_connection::AgentInstanceConnectionEvent::Server(protocol::AgentInstanceServerMessage::ShutdownRequested { reason }) => {
                        let reason = reason.unwrap_or_else(|| "stopped from xMatrix".to_string());
                        match interrupter.begin_graceful_interrupt().await {
                            Ok(Some(waiter)) => {
                                let quiesce = async {
                                    tokio::select! {
                                        _ = &mut turn => Ok(()),
                                        result = waiter.wait() => result,
                                    }
                                };
                                match tokio::time::timeout(
                                    Duration::from_secs(CODEX_SHUTDOWN_INTERRUPT_GRACE_SECS),
                                    quiesce,
                                )
                                .await
                                {
                                    Ok(Ok(())) => {}
                                    Ok(Err(err)) => eprintln!(
                                        "{} Codex turn interrupt was rejected before shutdown: {err}",
                                        "⚠".yellow().bold()
                                    ),
                                    Err(_) => eprintln!(
                                        "{} Codex turn did not quiesce within {}s; forcing shutdown",
                                        "⚠".yellow().bold(),
                                        CODEX_SHUTDOWN_INTERRUPT_GRACE_SECS
                                    ),
                                }
                            }
                            Ok(None) => {}
                            Err(err) => eprintln!(
                                "{} Could not interrupt Codex turn before shutdown: {err}",
                                "⚠".yellow().bold()
                            ),
                        }
                        return InterruptibleCodexTurn::Shutdown(reason);
                    }
                    agent_instance_connection::AgentInstanceConnectionEvent::Disconnected { reason } => {
                        pending_events.push_back(agent_instance_connection::AgentInstanceConnectionEvent::Disconnected { reason });
                    }
                    agent_instance_connection::AgentInstanceConnectionEvent::Reconnected { agent: next_agent, .. } => {
                        if let (Some(relay), Some(channel_id)) = (trace_relay, trace_channel_id) {
                            send_agent_reconnected_lifecycle(relay, channel_id, &next_agent);
                            send_presence(
                                relay,
                                Some("busy"),
                                PresencePatch::presentation(model_catalog_presentation(
                                    model.map(str::to_string),
                                    models.to_vec(),
                                    None,
                                    None,
                                ))
                                .goal(None)
                                .runtime_state(
                                    runtime_state.map(AgentRuntimeStateTracker::snapshot),
                                ),
                            );
                        }
                        // This reconnect has been fully handled at the active-turn
                        // boundary. Replaying it after the turn would emit a second,
                        // stale idle snapshot for the same transport event.
                    }
                    other => {
                        // A card answer goes to the question Codex waits on,
                        // and the turn carries on.
                        if let Some(reply) = crate::runtime_harness_questions::questionnaire_reply(&other)
                            && interrupter.answer_question(&reply).await
                        {
                            if let Some(relay) = trace_relay {
                                crate::runtime_harness_questions::ack_questionnaire_reply(relay, &reply);
                            }
                            continue;
                        }
                        if event_requests_active_turn_interrupt_with_replay(
                            &other,
                            trace_channel_id,
                            Some(agent.id.as_str()),
                            interrupt_history_replay,
                        ) {
                            interrupter.cancel_questions().await;
                            if let Err(err) = interrupter.interrupt_active_turn().await {
                                eprintln!("{} codex app-server interrupt failed: {err}", "⚠".yellow().bold());
                            }
                            pending_events.push_back(other);
                            return InterruptibleCodexTurn::Interrupted;
                        }
                        pending_events.push_back(other);
                    }
                }
            }
        }
    }
}

fn runtime_accepts_channel_delivery(bound_channel_id: Option<&str>, channel_id: &str) -> bool {
    let accepted = bound_channel_id.is_none_or(|bound| bound == channel_id);
    if !accepted {
        eprintln!(
            "{} Ignoring xMatrix delivery for channel {channel_id}; this runtime is bound to {}",
            "⚠".yellow().bold(),
            bound_channel_id.unwrap_or_default()
        );
    }
    accepted
}

/// Whether a delivery should cancel the turn that is running right now.
///
/// Live deliveries say so themselves: the hub sets `interrupt_requested` on
/// every one. Catch-up cannot, because it arrives as `ChannelHistoryReplay`,
/// which carries no such field — yet the hub describes that window as "exactly
/// the work the cursor says this principal never received". Matching only the
/// live frame therefore made the interrupt an accident of which hop delivered
/// the message: one that missed live fanout lost its urgency for good and
/// waited out the current turn, however long that ran.
///
/// Replay needs no equivalent of the flag. Orientation frames are acknowledged
/// and dropped in the connection before any runtime sees them, so every replay
/// that arrives here is already work. Agent-authored replay is queued rather
/// than interrupting: unlike live delivery, replay has no exact-target hint,
/// and treating every peer reply as steering cancels slower multi-Agent turns.
///
/// One exception, and the connection cannot cover it: this instance's own
/// messages are filtered out of live delivery but deliberately kept in replay,
/// where they stay valid context. That was safe only while replay carried no
/// interrupt. Now that it does, an instance reconnecting mid-turn would meet
/// its own earlier `xmatrix send` and cancel the turn that produced it, so own
/// authorship is excluded here rather than dropped there.
///
/// A live model/effort switch steers just as hard and cancels the turn too. It
/// cannot say so through `interrupt_requested`, because it does not arrive as a
/// channel message at all: the hub delivers a control command as `context` so it
/// cannot burn the addressed Instance's turn, then dispatches the switch on its
/// own `agent_*_switch_requested` frame. Left out of this predicate the switch
/// was neither applied nor interrupting — it sat in `pending_events` until the
/// turn ended, by which point the hub's 10s control waiter had already reported
/// `timeout`. Naming it here is the whole fix: the cancelled turn hands control
/// straight back to the run loop that already knows how to apply a switch, so
/// no runtime needs a second, mid-turn way to do it. The run loop then resumes
/// the cancelled work on the new selection (`RunLoopInput::Resume`).
fn event_requests_active_turn_interrupt(
    event: &agent_instance_connection::AgentInstanceConnectionEvent,
    bound_channel_id: Option<&str>,
    own_identity_id: Option<&str>,
) -> bool {
    event_requests_active_turn_interrupt_with_replay(event, bound_channel_id, own_identity_id, true)
}

fn event_requests_active_turn_interrupt_with_replay(
    event: &agent_instance_connection::AgentInstanceConnectionEvent,
    bound_channel_id: Option<&str>,
    own_identity_id: Option<&str>,
    interrupt_history_replay: bool,
) -> bool {
    let (message, replayed) = match event {
        agent_instance_connection::AgentInstanceConnectionEvent::Server(
            protocol::AgentInstanceServerMessage::AgentModelSwitchRequested { .. }
            | protocol::AgentInstanceServerMessage::AgentEffortSwitchRequested { .. },
        ) => return true,
        agent_instance_connection::AgentInstanceConnectionEvent::Server(
            protocol::AgentInstanceServerMessage::ChannelMessageReceived {
                message,
                interrupt_requested: Some(true),
                ..
            },
        ) => (message, false),
        agent_instance_connection::AgentInstanceConnectionEvent::Server(
            protocol::AgentInstanceServerMessage::ChannelHistoryReplay { message, .. },
        ) if interrupt_history_replay => (message, true),
        _ => return false,
    };
    if bound_channel_id.is_some_and(|bound| bound != message.channel_id) {
        return false;
    }
    let authored_here = message.from.kind == "agent"
        && own_identity_id
            .is_some_and(|identity| message.from.identity_id.as_deref() == Some(identity));
    !(authored_here || (replayed && message.from.kind == "agent"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum GoalCommand {
    Set {
        objective: String,
    },
    Replace {
        objective: String,
    },
    Clear,
    Get,
    Resume,
    /// Codex, Grok Build, and ZCode expose pause; Claude maps it to status.
    Pause,
}

/// Parses a verbatim `/goal` slash command into the runtime-neutral goal
/// action it should drive. Each backend then maps the action onto its own
/// goal mechanism: codex routes it to the dedicated `thread/goal/*`
/// app-server requests (codex wraps slash commands in turn input as plain
/// user messages), while claude rewrites it onto Claude Code's native
/// `/goal` grammar (see `claude_goal_turn_input`). Grok rewrites onto its
/// shell slash command (`grok_goal_turn_input`) and tracks progress via the
/// built-in `update_goal` tool.
///
/// `/goal <objective>` maps to a set, `/goal replace <objective>` replaces,
/// bare `/goal` plus `/goal get|status|show` refresh local state, and the
/// remaining controls map to clear, pause, or resume. Capability advertising
/// tells clients which subset the active backend implements.
/// Returns `None` only for input that is not an exact `/goal` command.
fn parse_goal_command(command: &str) -> Option<GoalCommand> {
    let rest = command.trim().strip_prefix("/goal")?;
    // The command name must be exactly "goal": the next character is either the
    // end of input or whitespace, so "/goalpost ..." is not a goal command.
    let arg = match rest.chars().next() {
        None => "",
        Some(c) if c.is_whitespace() => rest.trim(),
        Some(_) => return None,
    };
    if arg.is_empty() {
        return Some(GoalCommand::Get);
    }
    if let Some((verb, objective)) = arg.split_once(char::is_whitespace) {
        let objective = objective.trim();
        if verb.eq_ignore_ascii_case("replace") && !objective.is_empty() {
            return Some(GoalCommand::Replace {
                objective: objective.to_string(),
            });
        }
    }
    match arg.to_ascii_lowercase().as_str() {
        "clear" => Some(GoalCommand::Clear),
        "get" | "status" | "show" => Some(GoalCommand::Get),
        "resume" => Some(GoalCommand::Resume),
        "pause" => Some(GoalCommand::Pause),
        _ => Some(GoalCommand::Set {
            objective: arg.to_string(),
        }),
    }
}

fn codex_goal_turn_payload(command: &GoalCommand) -> Option<String> {
    match command {
        GoalCommand::Set { objective } | GoalCommand::Replace { objective } => {
            Some(objective.clone())
        }
        GoalCommand::Clear | GoalCommand::Get | GoalCommand::Resume | GoalCommand::Pause => None,
    }
}

const INITIAL_SPAWN_CONTEXT_ENV: &str = "XMATRIX_INITIAL_CONTEXT_JSON";

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct InitialSpawnContext {
    #[serde(
        rename = "requestedModel",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    requested_model: Option<String>,
    #[serde(
        rename = "requestedEffort",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    requested_effort: Option<String>,
    #[serde(
        rename = "requestedParameters",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    requested_parameters: Option<BTreeMap<String, String>>,
    #[serde(
        rename = "initialMessageSource",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "xmatrix_cli_core::protocol::deserialize_optional_message_source"
    )]
    initial_message_source: Option<protocol::AgentRuntimeMessageSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    goal: Option<protocol::AgentGoalStatus>,
}

fn read_initial_spawn_context_from_env() -> Option<InitialSpawnContext> {
    let raw = non_empty_env(INITIAL_SPAWN_CONTEXT_ENV)?;
    parse_initial_spawn_context(&raw)
}

fn parse_initial_spawn_context(raw: &str) -> Option<InitialSpawnContext> {
    serde_json::from_str::<InitialSpawnContext>(raw).ok()
}

fn goal_resume_turn_payload(goal: Option<&protocol::AgentGoalStatus>) -> Option<String> {
    let objective = goal?.objective.as_deref()?.trim();
    if objective.is_empty() {
        return None;
    }
    Some(format!("Continue working on the current goal: {objective}"))
}

fn codex_resume_goal_objective(value: &Value) -> error::Result<String> {
    value
        .get("goal")
        .and_then(|goal| goal.get("objective"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|objective| !objective.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            CliError::Launch("Cannot resume Codex goal without a current objective".into())
        })
}

fn goal_runtime_capabilities(tool: &str, cmd: &str, cmd_args: &[String]) -> Vec<String> {
    let mut capabilities = vec!["goal".to_string()];
    let operations: &[&str] = if use_codex_app_backend(tool) {
        &[
            "set",
            "get",
            "clear",
            "pause",
            "resume",
            "status",
            "token-budget",
            "metrics",
        ]
    } else if use_zcode_app_backend(tool) {
        &[
            "set",
            "replace",
            "get",
            "clear",
            "pause",
            "resume",
            "metrics",
            "verification",
        ]
    } else if use_grok_app_backend(tool) {
        &["set", "get", "clear", "pause", "resume"]
    } else if use_acp_backend() {
        // Generic ACP vendors have no native goal grammar; slash commands
        // pass through as plain text, so advertise the conservative set only.
        &["set", "get", "clear", "pause", "resume"]
    } else if env_flag("XMATRIX_HEADLESS")
        && (std::env::var("XMATRIX_AGENT_BACKEND")
            .ok()
            .is_some_and(|backend| backend == "claude-print")
            || env_flag("XMATRIX_CLAUDE_PRINT")
            || uses_claude_code_runtime(tool, cmd, cmd_args))
    {
        &["set", "get", "clear", "resume", "verification"]
    } else {
        return Vec::new();
    };
    capabilities.extend(
        operations
            .iter()
            .map(|operation| format!("goal.{operation}")),
    );
    capabilities
}

fn codex_resume_goal_params(thread_id: &str, value: &Value) -> error::Result<Value> {
    codex_resume_goal_objective(value)?;
    // `thread/goal/set` is a partial update. Change only the status so the
    // persisted objective and its accumulated usage remain intact.
    Ok(serde_json::json!({
        "threadId": thread_id,
        "status": "active",
    }))
}

struct CodexGoalCommandOutcome {
    goal: Option<protocol::AgentGoalStatus>,
    applied: bool,
}

/// Applies a codex `/goal` command via the dedicated app-server request and
/// reports the outcome through the same presence/run-status/trace channels a
/// normal turn uses, so the goal mutation is observable from the hub.
async fn handle_codex_goal_command(
    app: &mut CodexAppSession,
    command: GoalCommand,
    relay: &Arc<agent_instance_connection::AgentInstanceConnectionClient>,
    channel_id: &str,
    message_id: &str,
    agent: &protocol::SerializedAgent,
    usage: Option<protocol::LlmUsage>,
) -> CodexGoalCommandOutcome {
    let (action, outcome) = match &command {
        GoalCommand::Set { objective } => (
            format!("set goal: {objective}"),
            app.set_goal(objective).await,
        ),
        GoalCommand::Replace { objective } => (
            format!("replace goal: {objective}"),
            app.set_goal(objective).await,
        ),
        GoalCommand::Clear => ("clear goal".to_string(), app.clear_goal().await),
        GoalCommand::Get => ("get goal".to_string(), app.get_goal().await),
        GoalCommand::Resume => ("resume goal".to_string(), app.resume_goal().await),
        GoalCommand::Pause => ("pause goal".to_string(), app.pause_goal().await),
    };
    let mut next_goal: Option<protocol::AgentGoalStatus> = None;
    let mut applied = false;
    match outcome {
        Ok(value) => {
            applied = true;
            next_goal = codex_goal_status_from_get_response(&value);
            if next_goal.is_none() && !matches!(command, GoalCommand::Clear | GoalCommand::Get) {
                next_goal = Some(codex_goal_status_from_response(&command, &value));
            }
            eprintln!("{} Codex {action}", "○".cyan().bold());
            send_llm_trace(
                relay,
                channel_id,
                "goal_updated",
                agent,
                usage.clone(),
                None,
                serde_json::json!({ "codexGoal": value }),
            )
            .await;
            match command {
                GoalCommand::Set { .. } | GoalCommand::Replace { .. } | GoalCommand::Resume => {
                    write_current_run_status("turn_running", false, Some(message_id));
                }
                GoalCommand::Clear | GoalCommand::Get | GoalCommand::Pause => {
                    write_current_run_status("turn_completed", true, Some(message_id));
                }
            }
        }
        Err(err) => {
            let error_message = format!(
                "Codex {action} failed: {}",
                codex_turn_error_message(&err.to_string())
            );
            report_turn_failure(relay, Some(channel_id), agent, &error_message, false);
        }
    }
    if applied {
        send_presence(
            relay,
            Some("busy"),
            PresencePatch::usage(usage)
                .goal(next_goal.clone())
                .runtime_state(None),
        );
    } else {
        // An RPC error is not an authoritative goal mutation. Preserve the
        // last published goal instead of accidentally sending `goal: null`.
        send_presence(relay, Some("busy"), PresencePatch::usage(usage));
    }
    CodexGoalCommandOutcome {
        goal: next_goal,
        applied,
    }
}

fn codex_goal_status_from_response(
    command: &GoalCommand,
    value: &Value,
) -> protocol::AgentGoalStatus {
    let goal = value.get("goal").filter(|goal| goal.is_object());
    let objective = goal
        .and_then(|goal| goal.get("objective"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let status = goal
        .and_then(|goal| goal.get("status"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let active = match command {
        GoalCommand::Set { .. } | GoalCommand::Replace { .. } => Some(true),
        GoalCommand::Clear | GoalCommand::Pause => Some(false),
        GoalCommand::Get | GoalCommand::Resume => goal
            .and_then(|goal| goal.get("active"))
            .and_then(Value::as_bool)
            .or_else(|| {
                status.as_deref().map(|status| {
                    matches!(status.to_ascii_lowercase().as_str(), "active" | "blocked")
                })
            }),
    };

    protocol::AgentGoalStatus {
        active,
        objective,
        status,
        updated_at: Some(unix_millis_now().to_string()),
        ..Default::default()
    }
}

async fn refresh_codex_goal_status(
    app: &mut CodexAppSession,
) -> error::Result<Option<protocol::AgentGoalStatus>> {
    match app.get_goal().await {
        Ok(value) => Ok(codex_goal_status_from_get_response(&value)),
        Err(err) => {
            if std::env::var("XMATRIX_CODEX_GOAL_DEBUG").is_ok() {
                eprintln!("{} codex goal refresh failed: {err}", "⚠".yellow().bold());
            }
            Err(err)
        }
    }
}

fn codex_goal_status_from_get_response(value: &Value) -> Option<protocol::AgentGoalStatus> {
    value
        .get("goal")
        .filter(|goal| goal.is_object())
        .map(codex_goal_status_from_value)
}

fn codex_goal_is_paused(goal: Option<&protocol::AgentGoalStatus>) -> bool {
    goal.and_then(|goal| goal.status.as_deref())
        .is_some_and(|status| status.eq_ignore_ascii_case("paused"))
}

fn codex_goal_is_active(goal: Option<&protocol::AgentGoalStatus>) -> bool {
    goal.is_some_and(|goal| match goal.active {
        Some(active) => active,
        None => goal
            .status
            .as_deref()
            .is_some_and(|status| status.eq_ignore_ascii_case("active")),
    })
}

fn codex_paused_goal_notice(goal: Option<&protocol::AgentGoalStatus>) -> String {
    let objective = goal
        .and_then(|goal| goal.objective.as_deref())
        .map(str::trim)
        .filter(|objective| !objective.is_empty());
    match objective {
        Some(objective) => {
            format!("Goal is paused: {objective}\nSend `/goal resume` to continue it.")
        }
        None => "Goal is paused. Send `/goal resume` to continue it.".to_string(),
    }
}

fn codex_goal_status_from_app_event(value: &Value) -> Option<protocol::AgentGoalStatus> {
    codex_goal_status_from_app_event_inner(value, false)
}

fn codex_goal_status_from_app_event_inner(
    value: &Value,
    allow_json_string: bool,
) -> Option<protocol::AgentGoalStatus> {
    match value {
        Value::Object(map) => {
            if let Some(goal) = map.get("goal").filter(|goal| goal.is_object()) {
                return Some(codex_goal_status_from_value(goal));
            }
            for (key, nested) in map {
                let nested_allows_json_string = matches!(key.as_str(), "output" | "result");
                if let Some(goal) =
                    codex_goal_status_from_app_event_inner(nested, nested_allows_json_string)
                {
                    return Some(goal);
                }
            }
            None
        }
        Value::Array(items) => items
            .iter()
            .find_map(|item| codex_goal_status_from_app_event_inner(item, allow_json_string)),
        Value::String(text) => {
            if !allow_json_string {
                return None;
            }
            let trimmed = text.trim();
            if !trimmed.starts_with('{') || !trimmed.contains("\"goal\"") {
                return None;
            }
            serde_json::from_str::<Value>(trimmed)
                .ok()
                .and_then(|parsed| codex_goal_status_from_app_event_inner(&parsed, false))
        }
        _ => None,
    }
}

fn codex_goal_status_from_value(goal: &Value) -> protocol::AgentGoalStatus {
    let objective = goal
        .get("objective")
        .and_then(Value::as_str)
        .map(str::to_string);
    let status = goal
        .get("status")
        .and_then(Value::as_str)
        .map(str::to_string);
    let active = goal.get("active").and_then(Value::as_bool).or_else(|| {
        status.as_deref().map(|value| {
            value.eq_ignore_ascii_case("active") || value.eq_ignore_ascii_case("in_progress")
        })
    });
    let updated_at = goal_updated_at(goal.get("updatedAt").or_else(|| goal.get("updated_at")));

    protocol::AgentGoalStatus {
        active,
        objective,
        status,
        updated_at,
        reason: goal
            .get("reason")
            .and_then(Value::as_str)
            .map(str::to_string),
        next_action: goal
            .get("nextAction")
            .and_then(Value::as_str)
            .map(str::to_string),
        tokens_used: goal.get("tokensUsed").and_then(Value::as_u64),
        time_used_seconds: goal.get("timeUsedSeconds").and_then(Value::as_u64),
        iteration_count: goal.get("iterationCount").and_then(Value::as_u64),
        context_used: goal.get("contextUsed").and_then(Value::as_u64),
        tool_call_count: goal.get("toolCallCount").and_then(Value::as_u64),
    }
}

fn codex_turn_input_items(
    text: &str,
    attachments: Option<&[protocol::ChannelAttachment]>,
    local_image_paths: Option<&[PathBuf]>,
) -> error::Result<Vec<Value>> {
    let text = redact_data_urls(text);
    let local_image_paths_are_authoritative = local_image_paths.is_some();
    let mut items = vec![serde_json::json!({
        "type": "text",
        "text": text,
        "text_elements": [],
    })];

    if let Some(attachments) = attachments {
        let mut local_image_index = 0usize;
        for attachment in attachments {
            if attachment.kind == "image" {
                let local_path = local_image_paths
                    .and_then(|paths| paths.get(local_image_index))
                    .cloned();
                if local_image_paths_are_authoritative {
                    local_image_index += 1;
                }
                if let Some(path) = local_path {
                    let bytes = std::fs::read(path).map_err(|err| {
                        CliError::Launch(format!(
                            "Failed to read local channel image attachment {}: {err}",
                            attachment.name
                        ))
                    })?;
                    items.push(serde_json::json!({
                        // Codex app-server exposes `localImage`, but the current
                        // standalone runtime forwards its path verbatim as an
                        // upstream `image_url`. A local filesystem path is not a
                        // valid image URL there. Use a validated data URL instead.
                        "type": "image",
                        "url": format!(
                            "data:{};base64,{}",
                            attachment.mime_type,
                            base64::engine::general_purpose::STANDARD.encode(bytes),
                        ),
                    }));
                } else if !local_image_paths_are_authoritative {
                    items.push(serde_json::json!({
                        "type": "image",
                        "url": if attachment.data_url.is_empty() {
                            attachment.url.as_deref().unwrap_or("")
                        } else {
                            attachment.data_url.as_str()
                        },
                    }));
                }
            }
        }
    }

    Ok(items)
}

fn codex_turn_text_with_unavailable_images(text: &str) -> String {
    format!(
        "{text}\n\n[xMatrix delivery notice: One or more image attachment bodies could not be read after xMatrix retried local retrieval. Continue with the text, do not claim to have inspected the unavailable image, and tell the user that the image could not be read.]"
    )
}

fn env_initial_message_source(
    channel_id: Option<&str>,
) -> Option<protocol::AgentRuntimeMessageSource> {
    let context = read_initial_spawn_context_from_env()?;
    let expected = std::env::var("XMATRIX_INITIAL_MESSAGE_ID").ok()?;
    scoped_initial_message_source(context, channel_id, &expected)
}

fn scoped_initial_message_source(
    context: InitialSpawnContext,
    channel_id: Option<&str>,
    message_id: &str,
) -> Option<protocol::AgentRuntimeMessageSource> {
    let source = context.initial_message_source?;
    (Some(source.channel_id.as_str()) == channel_id && source.message_id == message_id)
        .then_some(source)
}
