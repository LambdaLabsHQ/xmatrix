// Headless agent runs: the external CLI paths that execute a turn and
// report back, without the long-lived streaming session.

use colored::Colorize;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tokio::sync::mpsc;

use crate::InboundChannelMessage;
use crate::runtime_agent_connection_lifecycle::emit_agent_connection_reconnected_lifecycle;
use crate::runtime_claude_stream_session::ClaudeStreamSession;
use crate::runtime_claude_turn::run_claude_stream_turn;
use crate::runtime_harness_questions::{ack_questionnaire_reply, inbound_questionnaire_reply};
use crate::runtime_trusted_role_prompt::claude_goal_turn_input;
use crate::{
    ChannelControlledRuntime, CliError, ExternalRun, HeadlessRuntimeBoundary, LocalImageFiles,
    PresencePatch, RunLoopEvents, RunLoopInput, ack_inbound_channel_messages,
    agent_instance_connection, ansi, append_windows_utf8_env, bind_goal_inbox_path,
    claude_stream_boundaries_from_line, clean_run_effort, combined_inbound_channel_attachments,
    combined_inbound_channel_prompt, default_downstream_kkp_flags, detect, env_flag, error,
    flush_headless_delivery_queue, format_incoming_channel_message_with_context,
    inject_remote_submission, kkp, materialize_inbound_image_files, parse_goal_command,
    process_tree, protocol, provider_subscription_quota_usage, pty, publish_bound_goal_state,
    read_claude_oauth_rate_limit_usage, read_initial_message_launch,
    read_initial_spawn_context_from_env, reply_to_current_agent, runtime_accepts_channel_delivery,
    send_presence, shell_wrap, slash_command_passthrough, spawn_goal_inbox_poller,
    uses_claude_code_runtime, write_current_run_model,
};

pub(crate) async fn run_headless_external(run: ExternalRun<'_>) -> error::Result<()> {
    let ExternalRun {
        tool,
        cmd,
        cmd_args,
        hub_url,
        cwd,
        relay,
        mut event_rx,
        agent,
    } = run;
    let (spawn_cmd, spawn_args) = shell_wrap(cmd, cmd_args);
    let cols = 120;
    let rows = 40;
    let mut agent_env = vec![
        ("XMATRIX_AGENT_NAME".to_string(), agent.name.clone()),
        ("XMATRIX_AGENT_ID".to_string(), agent.id.clone()),
        (
            "XMATRIX_AGENT_INSTANCE_ID".to_string(),
            agent.instance_id.clone().unwrap_or_default(),
        ),
    ];
    append_windows_utf8_env(&mut agent_env)?;
    let pty_wrapper = pty::PtyWrapper::spawn(&spawn_cmd, &spawn_args, cwd, &agent_env, cols, rows)?;

    // ZCode / Z.ai Coding Plan: publish 5h+weekly (and MCP) quotas into presence when available.
    let latest_provider_usage = provider_subscription_quota_usage(tool, cmd, cmd_args, false).await;
    if latest_provider_usage.is_some() {
        send_presence(
            &relay,
            Some("online"),
            PresencePatch::usage(latest_provider_usage.clone()),
        );
    }

    let (pty_reader, pty_writer, _pty_master, mut child, _pty_slave) = pty_wrapper.take_reader();
    let mut process_tree =
        process_tree::guard_portable_pty_child(child.as_mut()).map_err(|err| {
            CliError::Pty(format!(
                "Failed to bind headless PTY child to its process tree: {err}"
            ))
        })?;
    let pty_writer = Arc::new(Mutex::new(pty_writer));
    let downstream_kkp_flags = Arc::new(AtomicU32::new(default_downstream_kkp_flags(tool)));
    let gated_delivery = uses_claude_code_runtime(tool, cmd, cmd_args);
    let debug_pty_log = env_flag("XMATRIX_DEBUG_PTY_LOG");
    let (runtime_boundary_tx, mut runtime_boundary_rx) =
        mpsc::unbounded_channel::<HeadlessRuntimeBoundary>();

    let read_flags = downstream_kkp_flags.clone();
    let read_boundary_tx = runtime_boundary_tx.clone();
    let read_handle = tokio::task::spawn_blocking(move || {
        let mut reader = pty_reader;
        let mut kkp_scanner = kkp::KkpScanner::new();
        let mut ansi_parser = ansi::AnsiParser::new();
        let mut detector = detect::OutputDetector::new();
        let mut line_buffer = String::new();
        let mut prompt_tail_reported = false;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    for ctrl in kkp_scanner.scan(&buf[..n]) {
                        match ctrl {
                            kkp::KkpControl::Push(flags) | kkp::KkpControl::Set(flags) => {
                                read_flags.store(flags, Ordering::Relaxed);
                            }
                            kkp::KkpControl::Pop(_) => {
                                read_flags.store(0, Ordering::Relaxed);
                            }
                        }
                    }
                    let clean = ansi_parser.feed(&buf[..n]);
                    if clean.is_empty() {
                        continue;
                    }
                    if debug_pty_log {
                        eprintln!("xmatrix headless pty: {}", clean.escape_debug());
                    }

                    detector.feed(&clean);
                    let has_prompt_tail = detector.has_prompt_tail();
                    if has_prompt_tail && !prompt_tail_reported {
                        let _ = read_boundary_tx.send(HeadlessRuntimeBoundary::PromptIdle);
                    }
                    prompt_tail_reported = has_prompt_tail;

                    line_buffer.push_str(&clean);
                    while let Some(idx) = line_buffer.find('\n') {
                        let mut line = line_buffer.drain(..=idx).collect::<String>();
                        line = line.trim().to_string();
                        if line.is_empty() {
                            continue;
                        }
                        for boundary in claude_stream_boundaries_from_line(&line) {
                            let _ = read_boundary_tx.send(boundary);
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });

    let mut launch = read_initial_message_launch(tool, &agent, hub_url, &relay, false).await?;
    let first_prompt = launch.take_first_prompt();
    let initial_message_attachment_files = launch.initial_message_attachment_files;
    let auto_join_channel_id = launch.auto_join_channel_id;
    let report_agent = agent.clone();
    let report_channel_id = auto_join_channel_id.clone();

    let (shutdown_tx, mut shutdown_rx) = mpsc::unbounded_channel::<String>();
    let relay_for_events = relay.clone();
    let pty_writer_for_events = pty_writer.clone();
    let flags_for_events = downstream_kkp_flags.clone();
    let relay_handle = tokio::spawn(async move {
        let mut pending_delivery = VecDeque::new();
        if let Some(prompt) = first_prompt {
            pending_delivery.push_back(prompt);
        }
        let mut runtime_idle = !gated_delivery || pending_delivery.is_empty();
        let mut outstanding_tool_uses = 0usize;
        let mut runtime_boundary_open = true;
        let mut gated_delivery_fallback = tokio::time::interval(Duration::from_secs(3));
        gated_delivery_fallback.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut materialized_inbound_images: Vec<LocalImageFiles> =
            vec![initial_message_attachment_files];

        loop {
            tokio::select! {
                event = event_rx.recv() => {
                    let Some(event) = event else {
                        break;
                    };
                    match event {
                        agent_instance_connection::AgentInstanceConnectionEvent::Server(
                            protocol::AgentInstanceServerMessage::ChannelMessageReceived { message, .. }
                            | protocol::AgentInstanceServerMessage::ChannelHistoryReplay { message, .. },
                        ) => {
                            // The frame carries the message nested; unpack it once here so
                            // the delivery this runtime acts on is the message itself.
                            let protocol::ChannelMessage {
                                message_id,
                                channel_id,
                                sequence,
                                from,
                                body,
                                reply_to_message_id,
                                reply_to,
                                attachments,
                                metadata,
                                ..
                            } = message;
                            if !runtime_accepts_channel_delivery(
                                auto_join_channel_id.as_deref(),
                                &channel_id,
                            ) {
                                continue;
                            }
                            let inbound_images =
                                materialize_inbound_image_files(attachments.as_deref(), &relay_for_events)
                                    .await;
                            let attachment_free = attachments
                                .as_deref()
                                .is_none_or(|items| items.is_empty());
                            if attachment_free && slash_command_passthrough(&body, &agent).and_then(crate::harness_parameters::command).is_some() {
                                let _ = relay_for_events.ack_channel_message(message_id, channel_id.clone(), sequence);
                                let _ = relay_for_events.send_channel_message(channel_id, "This runtime does not advertise a parameter control interface".into()).await;
                                continue;
                            }
                            let payload = match slash_command_passthrough(&body, &agent) {
                                Some(command) if attachment_free => command.to_string(),
                                _ => format_incoming_channel_message_with_context(
                                    &channel_id,
                                    Some(&message_id),
                                    reply_to_message_id.as_deref(),
                                    reply_to.as_ref(),
                                    reply_to_current_agent(reply_to.as_ref(), &agent),
                                    &from,
                                    metadata.as_ref(),
                                    &body,
                                    attachments.as_deref(),
                                    Some(&inbound_images),
                                ),
                            };
                            if !inbound_images.paths().is_empty() {
                                materialized_inbound_images.push(inbound_images);
                            }
                            if !gated_delivery || runtime_idle {
                                inject_remote_submission(&pty_writer_for_events, &flags_for_events, &payload)
                                    .await;
                                if gated_delivery {
                                    runtime_idle = false;
                                }
                            } else {
                                pending_delivery.push_back(payload);
                            }
                                    let relay = relay_for_events.clone();
                            let _ = relay.ack_channel_message(message_id, channel_id, sequence);
                        }
                        agent_instance_connection::AgentInstanceConnectionEvent::Server(protocol::AgentInstanceServerMessage::ShutdownRequested {
                            reason,
                        }) => {
                            let _ = shutdown_tx
                                .send(reason.unwrap_or_else(|| "stopped from xMatrix".to_string()));
                            break;
                        }
                        _ => {}
                    }
                }
                _ = gated_delivery_fallback.tick(), if gated_delivery && !pending_delivery.is_empty() && !runtime_idle && outstanding_tool_uses == 0 => {
                    // Claude Code prompt/result detection can miss after CLI output changes.
                    // Keep delivery gated when tools are active, but do not let ordinary
                    // channel messages sit forever behind a lost idle boundary.
                    if flush_headless_delivery_queue(
                        &mut pending_delivery,
                        &pty_writer_for_events,
                        &flags_for_events,
                    )
                    .await
                    {
                        runtime_idle = false;
                    }
                }
                boundary = runtime_boundary_rx.recv(), if gated_delivery && runtime_boundary_open => {
                    let Some(boundary) = boundary else {
                        runtime_boundary_open = false;
                        continue;
                    };
                    match boundary {
                        HeadlessRuntimeBoundary::ClaudeToolUse => {
                            outstanding_tool_uses = outstanding_tool_uses.saturating_add(1);
                            runtime_idle = false;
                        }
                        HeadlessRuntimeBoundary::ClaudeToolResult => {
                            outstanding_tool_uses = outstanding_tool_uses.saturating_sub(1);
                            if outstanding_tool_uses == 0 {
                                runtime_idle = true;
                                if flush_headless_delivery_queue(
                                    &mut pending_delivery,
                                    &pty_writer_for_events,
                                    &flags_for_events,
                                )
                                .await
                                {
                                    runtime_idle = false;
                                }
                            }
                        }
                        HeadlessRuntimeBoundary::ClaudeResult | HeadlessRuntimeBoundary::PromptIdle => {
                            outstanding_tool_uses = 0;
                            runtime_idle = true;
                            if flush_headless_delivery_queue(
                                &mut pending_delivery,
                                &pty_writer_for_events,
                                &flags_for_events,
                            )
                            .await
                            {
                                runtime_idle = false;
                            }
                        }
                    }
                }
            }
        }
    });

    let mut poll_child = tokio::time::interval(Duration::from_millis(200));
    poll_child.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut shutdown_requested = false;
    let wait_result = loop {
        tokio::select! {
            _ = poll_child.tick() => {
                if let Some(status) = child
                    .try_wait()
                    .map_err(|e| CliError::Pty(format!("child wait error: {e}")))?
                {
                    break Ok(status);
                }
            }
            reason = shutdown_rx.recv() => {
                shutdown_requested = true;
                if let Some(reason) = reason {
                    eprintln!("{} Shutdown requested: {reason}", "○".cyan().bold());
                }
                let _ = process_tree.terminate();
                let _ = child.kill();
                break child
                    .wait()
                    .map_err(|e| CliError::Pty(format!("child wait error: {e}")));
            }
        }
    };
    relay_handle.abort();
    read_handle.abort();
    let status = wait_result?;
    if !shutdown_requested && !status.success() {
        crate::report_turn_failure(
            relay.as_ref(),
            report_channel_id.as_deref(),
            &report_agent,
            &format!("Headless runtime exited: {status}"),
            false,
        );
    }
    relay.graceful_disconnect().await
}

/// The presentation a Claude switch reports once it lands. Model and effort
/// publish the very same snapshot — the chips read one catalog — so neither
/// arm builds its own.
/// Sent with `idle` between turns, so it carries a background wait in force.
fn claude_switch_presence(session: &ClaudeStreamSession) -> PresencePatch {
    PresencePatch::presentation(session.presentation().snapshot(None))
        .goal(session.goals().current().cloned())
        .runtime_state(session.runtime_state.waiting_snapshot())
}

pub(crate) async fn run_claude_print_external(run: ExternalRun<'_>) -> error::Result<()> {
    let ExternalRun {
        tool,
        cmd,
        cmd_args,
        hub_url,
        cwd,
        relay,
        event_rx,
        agent,
    } = run;
    let mut launch = read_initial_message_launch(tool, &agent, hub_url, &relay, true).await?;
    let has_initial_message = launch.initial_message.is_some();
    let first_prompt = launch.take_first_prompt();
    let initial_message_attachments = launch.initial_message_attachments;
    let initial_message_attachment_files = launch.initial_message_attachment_files;
    let auto_join_channel_id = launch.auto_join_channel_id;
    let resume_session_key = crate::non_empty_env("XMATRIX_RESUME_SESSION_KEY");
    let resume_requested = env_flag("XMATRIX_RESUME_REQUESTED");

    let requested_parameters = read_initial_spawn_context_from_env()
        .and_then(|context| context.requested_parameters)
        .unwrap_or_default();
    // One persistent stream-json process serves every turn. It spawns lazily on
    // the first submitted turn, so an idle agent with no work never launches
    // Claude. `--resume` is applied only on (re)spawn (reborn / crash recovery).
    let mut routed_args = cmd_args.to_vec();
    if let Some(model) =
        read_initial_spawn_context_from_env().and_then(|context| context.requested_model)
    {
        let mut skip_value = false;
        routed_args.retain(|arg| {
            if skip_value {
                skip_value = false;
                return false;
            }
            if arg == "--model" {
                skip_value = true;
                return false;
            }
            !arg.starts_with("--model=")
        });
        routed_args.extend(["--model".to_string(), model]);
    }
    let mut session = ClaudeStreamSession::new(
        cmd,
        &routed_args,
        cwd,
        resume_session_key.clone(),
        resume_requested,
        relay.clone(),
        agent.clone(),
        read_initial_spawn_context_from_env().and_then(|context| context.goal),
    );
    session.runtime_state = crate::AgentRuntimeStateTracker::for_current_run("claude_code");
    if let Some(effort) =
        read_initial_spawn_context_from_env().and_then(|context| context.requested_effort)
    {
        session
            .discover_parameters()
            .await
            .map_err(CliError::Launch)?;
        session
            .select_effort(&effort)
            .await
            .map_err(CliError::Launch)?;
    }
    if !requested_parameters.is_empty() {
        session
            .discover_parameters()
            .await
            .map_err(CliError::Launch)?;
        for (id, value) in &requested_parameters {
            if matches!(id.as_str(), "model" | "effort") {
                return Err(CliError::Launch(
                    "Use dedicated model/effort launch tags".into(),
                ));
            }
            crate::harness_parameters::validate(&session.presentation().parameters, id, value)
                .map_err(CliError::Launch)?;
        }
        for (id, value) in requested_parameters {
            session
                .select_parameter(&id, &value)
                .await
                .map_err(CliError::Launch)?;
        }
    }
    // Claude Code exposes `/goal` only to a human typing it, so `xmatrix goal`
    // is how this runtime's own turn reaches it. Queued commands arrive as
    // ordinary events and are therefore applied between turns.
    if let Some(inbox) = bind_goal_inbox_path(agent.instance_id.as_deref()) {
        publish_bound_goal_state(session.goals().current());
        spawn_goal_inbox_poller(inbox, relay.local_event_sender());
    }

    // Advertise the switchable model catalog (and docs-driven command catalog)
    // before the first turn so Composer completion works from the moment the
    // instance appears. Live init.slash_commands are merged additively later.
    let startup = session.presentation();
    if let Some(model) = startup.current_model.as_deref() {
        write_current_run_model(Some(model));
    }
    // Quota is a property of the account, not of any turn — read it here so
    // the instance carries its 5h/1w meters from the moment it appears.
    // Without this the windows only arrive once a first turn *finishes*, so
    // a freshly summoned agent shows an empty card until someone talks to it.
    let startup_usage = read_claude_oauth_rate_limit_usage(false).await;
    send_presence(
        &relay,
        Some("idle"),
        PresencePatch::presentation(session.presentation().snapshot(startup_usage.clone()))
            .goal(startup.goal.clone())
            .runtime_state(None),
    );

    let mut events = RunLoopEvents::new(event_rx, &relay, auto_join_channel_id.as_deref(), &agent)
        .without_termination();

    if let (Some(channel_id), Some(prompt)) = (auto_join_channel_id.clone(), first_prompt) {
        let initial_source = has_initial_message
            .then(|| crate::env_initial_message_source(Some(&channel_id)))
            .flatten();
        run_claude_stream_turn(
            &mut session,
            prompt,
            initial_message_attachments,
            None,
            channel_id.clone(),
            None,
            initial_source.as_ref(),
            &relay,
            &agent,
            false,
            false,
            None,
            &mut events.rx,
            &mut events.pending,
        )
        .await;
        events.turn_ended(&channel_id, session.last_turn_interrupted);
    }

    let mut materialized_inbound_images: Vec<LocalImageFiles> =
        vec![initial_message_attachment_files];
    while let Some(input) = events.next_input(&mut session).await {
        match input {
            RunLoopInput::Delivery {
                channel_id: primary_channel_id,
                messages: inbound_messages,
                passthrough,
            } => {
                // A turn Claude started by itself can ask too; its card's
                // answer arrives here, between this loop's turns.
                let questions = session.interrupter();
                let mut unanswered = Vec::with_capacity(inbound_messages.len());
                for message in inbound_messages {
                    match inbound_questionnaire_reply(&message) {
                        Some(reply) if questions.answer_question(&reply).await => {
                            ack_questionnaire_reply(&relay, &reply);
                        }
                        _ => unanswered.push(message),
                    }
                }
                let inbound_messages = unanswered;
                if inbound_messages.is_empty() {
                    continue;
                }
                // `/goal` needs rewriting onto Claude's native grammar (its
                // `status`/`resume` spellings would otherwise *set* a goal
                // with that literal objective); other slash commands pass
                // through verbatim.
                let goal_command = passthrough
                    .as_deref()
                    .and_then(parse_goal_command)
                    .filter(|_| session.goal_mapping_enabled());
                // Only this turn's images back its image blocks, which pair
                // with `combined_attachments` by position. Earlier turns' files
                // stay alive in `materialized_inbound_images` (their prompts
                // cite them) but are not this turn's images.
                let mut turn_image_paths: Vec<PathBuf> = Vec::new();
                let prompt = match (&goal_command, passthrough) {
                    (Some(command), _) => {
                        claude_goal_turn_input(command, session.goals().current())
                    }
                    (None, Some(command)) => command,
                    (None, None) => {
                        let mut prompt_parts = Vec::with_capacity(inbound_messages.len());
                        for message in &inbound_messages {
                            let inbound_images = materialize_inbound_image_files(
                                message.attachments.as_deref(),
                                &relay,
                            )
                            .await;
                            prompt_parts.push(message.prompt_text(&agent, Some(&inbound_images)));
                            turn_image_paths.extend(inbound_images.image_paths().iter().cloned());
                            if !inbound_images.paths().is_empty() {
                                materialized_inbound_images.push(inbound_images);
                            }
                        }
                        combined_inbound_channel_prompt(prompt_parts)
                    }
                };
                let combined_attachments = combined_inbound_channel_attachments(&inbound_messages);
                let combined_image_paths =
                    (!turn_image_paths.is_empty()).then_some(turn_image_paths);
                ack_inbound_channel_messages(&relay, &inbound_messages);
                run_claude_stream_turn(
                    &mut session,
                    prompt,
                    combined_attachments,
                    combined_image_paths,
                    primary_channel_id.clone(),
                    Some(&inbound_messages),
                    None,
                    &relay,
                    &agent,
                    true,
                    true,
                    goal_command,
                    &mut events.rx,
                    &mut events.pending,
                )
                .await;
                events.turn_ended(&primary_channel_id, session.last_turn_interrupted);
            }
            RunLoopInput::Resume { channel_id, prompt } => {
                // The resume input already says why the turn was cut short.
                session.previous_turn_interrupted = false;
                run_claude_stream_turn(
                    &mut session,
                    prompt,
                    None,
                    None,
                    channel_id.clone(),
                    None,
                    None,
                    &relay,
                    &agent,
                    true,
                    true,
                    None,
                    &mut events.rx,
                    &mut events.pending,
                )
                .await;
                events.turn_ended(&channel_id, session.last_turn_interrupted);
            }
            RunLoopInput::Event(event) => match *event {
                agent_instance_connection::AgentInstanceConnectionEvent::LocalCommand { body } => {
                    let (Some(command), Some(channel_id)) =
                        (parse_goal_command(&body), auto_join_channel_id.clone())
                    else {
                        // A run with no bound channel has nowhere to report the
                        // goal turn, so say why instead of dropping it in silence.
                        eprintln!(
                            "{} Ignoring queued self-command `{body}`; this run has no bound channel",
                            "⚠".yellow().bold()
                        );
                        continue;
                    };
                    let prompt = claude_goal_turn_input(&command, session.goals().current());
                    run_claude_stream_turn(
                        &mut session,
                        prompt,
                        None,
                        None,
                        channel_id.clone(),
                        None,
                        None,
                        &relay,
                        &agent,
                        false,
                        false,
                        Some(command),
                        &mut events.rx,
                        &mut events.pending,
                    )
                    .await;
                    events.turn_ended(&channel_id, session.last_turn_interrupted);
                }
                agent_instance_connection::AgentInstanceConnectionEvent::Reconnected {
                    agent: reconnected_agent,
                    ..
                } => {
                    emit_agent_connection_reconnected_lifecycle(
                        &relay,
                        auto_join_channel_id.as_deref(),
                        &reconnected_agent,
                    );
                    let usage = read_claude_oauth_rate_limit_usage(false).await;
                    send_presence(
                        &relay,
                        Some("idle"),
                        PresencePatch::presentation(session.presentation().snapshot(usage))
                            .goal(session.goals().current().cloned())
                            .runtime_state(Some(session.runtime_state.snapshot())),
                    );
                }
                agent_instance_connection::AgentInstanceConnectionEvent::Server(
                    protocol::AgentInstanceServerMessage::ShutdownRequested { .. },
                ) => {
                    break;
                }
                _ => {}
            },
        }
    }

    drop(materialized_inbound_images);
    session.shutdown().await;

    relay.graceful_disconnect().await
}

impl ChannelControlledRuntime for ClaudeStreamSession {
    async fn request_model_switch(&mut self, requested: &str) -> Result<String, String> {
        self.select_model(requested).await
    }

    async fn request_effort_switch(&mut self, requested: &str) -> Result<String, String> {
        let cleaned = clean_run_effort(requested);
        self.select_effort(cleaned.as_deref().unwrap_or(requested.trim()))
            .await
    }

    fn switch_presence(&self) -> PresencePatch {
        claude_switch_presence(self)
    }

    async fn parameter_control(
        &mut self,
        command: crate::harness_parameters::ParameterCommand,
        message: &InboundChannelMessage,
        agent: &protocol::SerializedAgent,
    ) -> Result<String, String> {
        self.discover_parameters().await?;
        let parameters = self.presentation().parameters;
        let (id, value) =
            crate::harness_parameter_toggles::resolve(command, &parameters, message, agent)?;
        let notice = match value {
            Some(value) => {
                crate::harness_parameters::validate(&parameters, &id, &value)?;
                match id.as_str() {
                    "model" => self
                        .select_model(&value)
                        .await
                        .map(|v| format!("Model: {v}")),
                    "effort" => self
                        .select_effort(&value)
                        .await
                        .map(|v| format!("Effort: {v}")),
                    _ => self.select_parameter(&id, &value).await,
                }?
            }
            None => crate::harness_parameters::status(&parameters, &id)?,
        };
        crate::harness_parameter_toggles::complete(message, agent, &parameters)?;
        Ok(notice)
    }

    fn parameter_presence(&self) -> PresencePatch {
        claude_switch_presence(self)
    }
}
