async fn run_codex_app_external(run: ExternalRun<'_>) -> error::Result<()> {
    let ExternalRun {
        tool,
        cmd,
        hub_url,
        cwd,
        relay,
        event_rx,
        agent,
        ..
    } = run;
    let mut bootstrap = with_channel_history_bootstrap(bootstrap::bootstrap_prompt(
        tool,
        &agent.name,
        hub_url,
        false,
    ));

    let initial_message = crate::runtime_resume_input::initial_runtime_message();
    let initial_message_attachments = read_initial_message_attachments_from_env()?;
    let auto_join_channel_id = non_empty_env("XMATRIX_AUTO_JOIN_CHANNEL_ID");
    let resume_session_key = non_empty_env("XMATRIX_RESUME_SESSION_KEY");
    let resume_requested = env_flag("XMATRIX_RESUME_REQUESTED");
    let runtime_state = AgentRuntimeStateTracker::for_current_run("codex_app_server");
    let mut latest_model: Option<String> = std::env::var("OPENAI_MODEL")
        .ok()
        .and_then(|value| clean_run_model(&value))
        .or_else(codex_default_model);
    let mut latest_effort: Option<String> = codex_default_effort();
    let initial_spawn_context = read_initial_spawn_context_from_env();
    let initial_goal = initial_spawn_context
        .as_ref()
        .and_then(|context| context.goal.clone());
    let mut latest_goal: Option<protocol::AgentGoalStatus> = initial_goal.clone();
    write_current_run_model(latest_model.as_deref());
    write_current_run_effort(latest_effort.as_deref());

    write_current_run_status("codex_app_starting", false, None);
    // Seed account-level Codex 5h/1w quotas from ChatGPT wham/usage. The
    // app-server's session-local rate limits are not an account usage source.
    let latest_usage = read_codex_chatgpt_usage(false).await;
    let quota_relay = relay.clone();
    let _quota_refresh = xmatrix_harness::quota::refresh::spawn_quota_refresh(
        || read_codex_chatgpt_usage(false),
        move |usage| send_presence(&quota_relay, None, PresencePatch::usage(Some(usage))),
    );
    let mut initial_runtime_turn = runtime_state.begin_initial_message_turn(
        &relay,
        initial_message.is_some(),
        auto_join_channel_id.as_deref(),
        latest_model.clone(),
        latest_usage.clone(),
        latest_goal.clone(),
    );

    let mut app = spawn_initialized_codex_app(
        cmd,
        cwd,
        &agent,
        resume_session_key.as_deref(),
        resume_requested,
    )
    .await?;
    if let Some(goal) = initial_goal.as_ref()
        && let Some(objective) = goal
            .objective
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            && goal.active != Some(false) {
                match app.set_goal(objective).await {
                    Ok(value) => {
                        latest_goal = codex_goal_status_from_get_response(&value)
                            .or_else(|| Some(goal.clone()));
                    }
                    Err(err) => {
                        eprintln!(
                            "{} could not restore xMatrix goal in Codex app-server: {err}",
                            "⚠".yellow().bold()
                        );
                        latest_goal = Some(goal.clone());
                    }
                }
            }
    if let Ok(goal) = refresh_codex_goal_status(&mut app).await {
        // The provider is authoritative after a fresh start or persisted
        // thread resume. This also restores goals created directly in Codex.
        latest_goal = goal;
    }
    latest_model = app
        .current_model()
        .and_then(clean_run_model)
        .or(latest_model);
    if let Some(model) = initial_spawn_context
        .as_ref()
        .and_then(|context| context.requested_model.as_ref())
    {
        latest_model = Some(model.clone());
    }
    latest_effort = app
        .current_effort()
        .and_then(clean_run_effort)
        .or(latest_effort);
    app.install_parameter_schemas(crate::harness_parameters::discover_codex_parameters(cmd).await);
    let available_models = match app.list_models().await {
        Ok(models) => models,
        Err(err) => {
            eprintln!(
                "{} Codex model catalog unavailable: {err}",
                "⚠".yellow().bold()
            );
            Vec::new()
        }
    };
    if let Some(effort) = initial_spawn_context
        .as_ref()
        .and_then(|context| context.requested_effort.as_ref())
    {
        if !codex_effort_options_for_model(&available_models, latest_model.as_deref())
            .contains(effort)
        {
            return Err(CliError::Launch(
                "Requested reasoning effort is not supported by this model".into(),
            ));
        }
        latest_effort = Some(effort.clone());
    }
    if latest_effort.is_none() {
        latest_effort = codex_default_effort_for_model(&available_models, latest_model.as_deref());
    }
    if let Some(requested) = initial_spawn_context
        .as_ref()
        .and_then(|context| context.requested_parameters.as_ref())
    {
        if requested.contains_key("fast") && requested.contains_key("serviceTier") {
            return Err(CliError::Launch(
                "Choose either fast or serviceTier, not both".into(),
            ));
        }
        let parameters = app.parameters(
            &available_models,
            latest_model.as_deref(),
            latest_effort.as_deref(),
        );
        for (id, value) in requested {
            crate::harness_parameters::validate(&parameters, id, value)
                .map_err(CliError::Launch)?;
        }
        for (id, value) in requested {
            app.apply_parameter(&parameters, latest_model.as_deref(), id, value)
                .await
                .map_err(CliError::Launch)?;
        }
    }
    write_current_run_model(latest_model.as_deref());
    write_current_run_effort(latest_effort.as_deref());
    let mut run = CodexRun {
        app,
        relay: &relay,
        agent: &agent,
        cmd,
        cwd,
        resume_session_key: resume_session_key.as_deref(),
        runtime_state: &runtime_state,
        latest_model,
        latest_effort,
        available_models,
        latest_goal,
        latest_usage,
    };
    {
        let has_efforts = run.available_models.iter().any(|item| {
            item.supported_reasoning_efforts
                .as_ref()
                .is_some_and(|entries| !entries.is_empty())
                || item.default_reasoning_effort.is_some()
        }) || run.latest_effort.is_some();
        let has_models = !run.available_models.is_empty();
        let commands =
            agent_commands_for_runtime(agent.agent_type.as_str(), has_models, has_efforts, true)
                .or_else(|| agent_commands_for_runtime("codex", has_models, has_efforts, true));
        send_presence(
            &relay,
            initial_message.as_ref().map(|_| "busy").or(Some("idle")),
            PresencePatch::presentation(model_catalog_presentation_with_commands(
                run.latest_model.clone(),
                run.available_models.clone(),
                run.latest_effort.clone(),
                commands,
                run.latest_usage.clone(),
            ))
            .parameters(run.parameters())
            .goal(run.latest_goal.clone())
            .runtime_state(Some(runtime_state.snapshot())),
        );
    }
    write_current_run_status("codex_app_ready", false, None);
    eprintln!(
        "{} Codex app-server backend ready for {} ({})",
        "✓".green().bold(),
        agent.name,
        agent.id.dimmed()
    );

    let mut events = RunLoopEvents::new(event_rx, &relay, auto_join_channel_id.as_deref(), &agent);

    if let Some(initial_message) = initial_message {
        let initial_message = codex_turn_with_bootstrap(&mut bootstrap, &initial_message);
        write_current_run_status("turn_running", false, None);
        let turn_result = run
            .submit_turn(
                &mut events,
                &initial_message,
                initial_message_attachments.as_deref(),
                auto_join_channel_id.as_deref(),
                false,
                None,
            )
            .await;
        let end = run
            .settle_turn(
                turn_result,
                auto_join_channel_id.as_deref(),
                None,
                initial_runtime_turn.as_mut(),
            )
            .await?;
        match end {
            None => {}
            Some(CodexRunEnd::AuthFailure) => {
                run.app.shutdown().await;
                return finish_agent_relay_disconnect(&relay).await;
            }
            Some(CodexRunEnd::Shutdown) => {
                run.app.shutdown().await;
                return Ok(());
            }
            Some(CodexRunEnd::EventStreamClosed) => {
                run.app.shutdown().await;
                relay.disconnect();
                return Ok(());
            }
        }
    } else {
        send_presence(
            &relay,
            Some("idle"),
            PresencePatch::usage(run.latest_usage.clone())
                .runtime_state(Some(runtime_state.snapshot())),
        );
    }

    while let Some(input) = events.next_input(&mut run).await {
        let end = match input {
            RunLoopInput::Delivery {
                channel_id: primary_channel_id,
                messages: inbound_messages,
                passthrough,
            } => {
                let typed_command = passthrough
                    .as_deref()
                    .and_then(parse_codex_typed_channel_command);
                let goal_command = passthrough.as_deref().and_then(parse_goal_command);
                let mut payload = match &goal_command {
                    Some(command) => codex_goal_turn_payload(command).unwrap_or_default(),
                    None => passthrough
                        .unwrap_or_else(|| inbound_channel_batch_prompt(&inbound_messages, &agent)),
                };
                let combined_attachments = combined_inbound_channel_attachments(&inbound_messages);
                let primary_message_id = primary_inbound_message_id(&inbound_messages);
                ack_inbound_channel_messages(&relay, &inbound_messages);
                if let Some(command) = typed_command {
                    if run.apply_typed_command(command) {
                        send_presence(&relay, Some("idle"), run.catalog_presence());
                    }
                    continue;
                }
                if goal_command.is_none() {
                    run.refresh_goal().await;
                    if codex_goal_is_paused(run.latest_goal.as_ref()) {
                        let notice = codex_paused_goal_notice(run.latest_goal.as_ref());
                        let _ = relay
                            .send_channel_message(primary_channel_id.clone(), notice)
                            .await;
                        run.publish_idle();
                        continue;
                    }
                }
                let mut runtime_turn = runtime_state.begin_message_turn(
                    Some(&primary_channel_id),
                    Some(&primary_message_id),
                    inbound_messages.len(),
                    inbound_execution_sources(&inbound_messages),
                );
                send_presence(
                    &relay,
                    Some("busy"),
                    PresencePatch::usage(None).runtime_state(Some(runtime_state.snapshot())),
                );
                write_current_run_status("turn_running", false, Some(&primary_message_id));
                // Codex ignores slash commands in turn input text, so apply
                // `/goal` through the app-server goal endpoint first. Setting
                // a goal should still start a real turn for the objective;
                // clearing a goal is a pure control command.
                if let Some(goal_command) = goal_command.clone() {
                    let command_outcome = handle_codex_goal_command(
                        &mut run.app,
                        goal_command.clone(),
                        &relay,
                        &primary_channel_id,
                        &primary_message_id,
                        &agent,
                        run.latest_usage.clone(),
                    )
                    .await;
                    if !command_outcome.applied {
                        runtime_turn.finish_as("failed");
                        run.publish_idle();
                        continue;
                    }
                    run.latest_goal = command_outcome.goal;
                    if matches!(goal_command, GoalCommand::Resume) {
                        match goal_resume_turn_payload(run.latest_goal.as_ref()) {
                            Some(resume_payload) => payload = resume_payload,
                            None => {
                                // The goal command itself was the whole input.
                                runtime_turn.finish_as("completed");
                                run.publish_idle();
                                continue;
                            }
                        }
                    }
                    if matches!(
                        goal_command,
                        GoalCommand::Clear | GoalCommand::Get | GoalCommand::Pause
                    ) {
                        runtime_turn.finish_as("completed");
                        run.publish_idle();
                        continue;
                    }
                }
                let payload = codex_turn_with_bootstrap(&mut bootstrap, &payload);
                let turn_result = run
                    .submit_turn(
                        &mut events,
                        &payload,
                        combined_attachments.as_deref(),
                        Some(&primary_channel_id),
                        true,
                        Some(&primary_message_id),
                    )
                    .await;
                run.settle_turn(
                    turn_result,
                    Some(&primary_channel_id),
                    Some(&primary_message_id),
                    Some(&mut runtime_turn),
                )
                .await?
            }
            RunLoopInput::Resume { channel_id, prompt } => {
                send_presence(
                    &relay,
                    Some("busy"),
                    PresencePatch::usage(None).runtime_state(Some(runtime_state.snapshot())),
                );
                write_current_run_status("turn_running", false, None);
                let turn_result = run
                    .submit_turn(&mut events, &prompt, None, Some(&channel_id), true, None)
                    .await;
                run.settle_turn(turn_result, Some(&channel_id), None, None)
                    .await?
            }
            RunLoopInput::Event(event) => {
                match *event {
                    agent_instance_connection::AgentInstanceConnectionEvent::Disconnected {
                        reason,
                    } => {
                        emit_agent_connection_lost_lifecycle(
                            &relay,
                            auto_join_channel_id.as_deref(),
                            &agent,
                            &reason,
                        );
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
                        if auto_join_channel_id.is_some() {
                            send_presence(&relay, Some("idle"), run.catalog_presence());
                        }
                    }
                    agent_instance_connection::AgentInstanceConnectionEvent::Server(
                        protocol::AgentInstanceServerMessage::Error { message, .. },
                    ) => {
                        emit_agent_connection_error_lifecycle(&message);
                    }
                    agent_instance_connection::AgentInstanceConnectionEvent::Server(
                        protocol::AgentInstanceServerMessage::ShutdownRequested { reason },
                    ) => {
                        emit_agent_shutdown_requested_lifecycle(reason);
                        relay.disconnect();
                        break;
                    }
                    _ => {}
                }
                None
            }
        };
        match end {
            None => {}
            Some(CodexRunEnd::AuthFailure) => {
                run.app.shutdown().await;
                return relay.graceful_disconnect().await;
            }
            Some(CodexRunEnd::Shutdown | CodexRunEnd::EventStreamClosed) => break,
        }
    }

    run.app.shutdown().await;
    relay.graceful_disconnect().await
}

/// Tell the run loop whether a channel turn was cancelled, so a switch that
/// cancelled it resumes the work.
fn note_turn_end(
    events: &mut RunLoopEvents<'_>,
    channel_id: Option<&str>,
    turn: InterruptibleCodexTurn,
) -> InterruptibleCodexTurn {
    if let Some(channel_id) = channel_id {
        events.turn_ended(
            channel_id,
            matches!(turn, InterruptibleCodexTurn::Interrupted),
        );
    }
    turn
}

/// Why a Codex turn ended the run instead of returning to the event loop.
enum CodexRunEnd {
    /// The provider rejected the account; serving more turns cannot succeed.
    AuthFailure,
    Shutdown,
    EventStreamClosed,
}

/// A Codex app-server run: the session and the state its presence reports.
struct CodexRun<'a> {
    app: CodexAppSession,
    relay: &'a Arc<agent_instance_connection::AgentInstanceConnectionClient>,
    agent: &'a protocol::SerializedAgent,
    cmd: &'a str,
    cwd: Option<&'a str>,
    resume_session_key: Option<&'a str>,
    runtime_state: &'a AgentRuntimeStateTracker,
    latest_model: Option<String>,
    latest_effort: Option<String>,
    available_models: Vec<protocol::AgentModelInfo>,
    latest_goal: Option<protocol::AgentGoalStatus>,
    latest_usage: Option<protocol::LlmUsage>,
}

impl CodexRun<'_> {
    fn parameters(&self) -> Vec<protocol::HarnessParameter> {
        self.app.parameters(
            &self.available_models,
            self.latest_model.as_deref(),
            self.latest_effort.as_deref(),
        )
    }

    fn catalog_presentation(&self) -> AgentPresentationSnapshot {
        model_catalog_presentation(
            self.latest_model.clone(),
            self.available_models.clone(),
            self.latest_effort.clone(),
            self.latest_usage.clone(),
        )
    }

    /// The full model catalog, for when a selection or the connection changed.
    fn catalog_presence(&self) -> PresencePatch {
        PresencePatch::presentation(self.catalog_presentation())
            .parameters(self.parameters())
            .goal(self.latest_goal.clone())
            .runtime_state(Some(self.runtime_state.snapshot()))
    }

    fn publish_idle(&self) {
        send_presence(
            self.relay,
            Some("idle"),
            PresencePatch::usage(self.latest_usage.clone())
                .parameters(self.parameters())
                .goal(self.latest_goal.clone())
                .runtime_state(Some(self.runtime_state.snapshot())),
        );
    }

    /// The provider is authoritative for the goal whenever it answers.
    async fn refresh_goal(&mut self) {
        if let Ok(goal) = refresh_codex_goal_status(&mut self.app).await {
            self.latest_goal = goal;
        }
    }

    async fn refresh_usage(&mut self) {
        if let Some(usage) = read_codex_chatgpt_usage(true).await {
            self.latest_usage = Some(usage);
        }
    }

    async fn restart(&mut self) -> error::Result<()> {
        restart_codex_app_session(
            &mut self.app,
            self.cmd,
            self.cwd,
            self.agent,
            self.resume_session_key,
        )
        .await
    }

    fn apply_typed_command(&mut self, command: CodexTypedChannelCommand) -> bool {
        apply_codex_typed_channel_command(
            command,
            &self.available_models,
            &mut self.latest_model,
            &mut self.latest_effort,
            &mut self.app,
        )
    }

    /// Submit one turn, restarting the app-server and retrying once when it
    /// failed before Codex started it.
    async fn submit_turn(
        &mut self,
        events: &mut RunLoopEvents<'_>,
        text: &str,
        attachments: Option<&[protocol::ChannelAttachment]>,
        channel_id: Option<&str>,
        interrupt_history_replay: bool,
        status_message_id: Option<&str>,
    ) -> InterruptibleCodexTurn {
        // Codex treats the final assistant response as visible to its caller. In a
        // channel-backed wrapper that output is intentionally local, so the
        // explicit `xmatrix send` contract must be a developer instruction rather
        // than ordinary turn text. Otherwise Codex can complete successfully while
        // the human sees only a busy/idle transition and no reply.
        let developer_instructions = codex_channel_developer_instructions(channel_id);
        let request = CodexTurnRequest {
            developer_instructions: developer_instructions.as_deref(),
            model: self.latest_model.as_deref(),
            effort: self.latest_effort.as_deref(),
            models: &self.available_models,
            attachments,
            trace_relay: Some(self.relay),
            trace_channel_id: channel_id,
            interrupt_history_replay,
            runtime_state: Some(self.runtime_state),
            initial_goal: self.latest_goal.as_ref(),
            ..CodexTurnRequest::new(text, self.agent)
        };
        let first = submit_codex_turn_interruptible(
            &mut self.app,
            &mut events.rx,
            &mut events.pending,
            request,
        )
        .await;
        let first = note_turn_end(events, channel_id, first);
        let retry_error = match &first {
            InterruptibleCodexTurn::Completed(Err(err))
                if codex_turn_error_retryable_before_start(&err.to_string()) =>
            {
                err.to_string()
            }
            _ => return first,
        };
        let retry_detail = codex_turn_error_message(&retry_error);
        let retry_status_detail = match status_message_id {
            Some(message_id) => format!("{message_id}: {retry_detail}"),
            None => retry_detail.clone(),
        };
        write_current_run_status("turn_retrying", false, Some(&retry_status_detail));
        eprintln!(
            "{} {retry_detail}; restarting app-server and retrying turn once",
            "⚠".yellow().bold()
        );
        if let Err(err) = restart_codex_app_session(
            &mut self.app,
            self.cmd,
            self.cwd,
            self.agent,
            self.resume_session_key,
        )
        .await
        {
            return InterruptibleCodexTurn::Completed(Err(err));
        }
        let retried = submit_codex_turn_interruptible(
            &mut self.app,
            &mut events.rx,
            &mut events.pending,
            request,
        )
        .await;
        note_turn_end(events, channel_id, retried)
    }

    /// Close out one turn: fold in its usage, model and goal, record the
    /// outcome, report a failure, go idle and restart a broken app-server.
    async fn settle_turn(
        &mut self,
        turn: InterruptibleCodexTurn,
        channel_id: Option<&str>,
        message_id: Option<&str>,
        mut runtime_turn: Option<&mut AgentRuntimeTurnGuard>,
    ) -> error::Result<Option<CodexRunEnd>> {
        let mut finish_as = |outcome: &str| {
            if let Some(guard) = runtime_turn.as_mut() {
                guard.finish_as(outcome);
            }
        };
        match turn {
            InterruptibleCodexTurn::Completed(Ok(turn)) => {
                self.refresh_usage().await;
                self.latest_model = turn.model.clone().or(self.latest_model.take());
                write_current_run_model(self.latest_model.as_deref());
                self.latest_goal = turn.goal.clone().or(self.latest_goal.take());
                self.refresh_goal().await;
                // Classify before the failure notice: an auth failure ends the
                // run from here, and an unwound guard would report "unknown".
                finish_as(if turn.failed { "failed" } else { "completed" });
                if turn.failed {
                    let failure_detail = turn
                        .failure_detail
                        .clone()
                        .unwrap_or_else(|| "Codex app-server turn failed".to_string());
                    report_turn_failure(
                        self.relay,
                        channel_id,
                        self.agent,
                        &failure_detail,
                        turn.restart_after_turn,
                    );
                    if codex_auth_failure_requires_exit(&failure_detail) {
                        return Ok(Some(CodexRunEnd::AuthFailure));
                    }
                } else {
                    write_current_run_status("turn_completed", true, message_id);
                }
                send_presence(
                    self.relay,
                    Some("idle"),
                    PresencePatch::presentation(model_presentation(
                        self.latest_model.clone(),
                        None,
                        self.latest_usage.clone(),
                    ))
                    .parameters(self.parameters())
                    .goal(self.latest_goal.clone())
                    .runtime_state(Some(self.runtime_state.snapshot())),
                );
                report_local_turn_output("Codex", &turn.local_output, channel_id);
                if turn.restart_after_turn {
                    self.restart().await?;
                }
            }
            InterruptibleCodexTurn::Completed(Err(err)) => {
                let error_message = codex_turn_error_message(&err.to_string());
                finish_as("failed");
                self.refresh_goal().await;
                let fatal_auth_failure = codex_auth_failure_requires_exit(&error_message);
                let restart_after_turn =
                    !fatal_auth_failure && codex_turn_error_requires_restart(&err.to_string());
                report_turn_failure(
                    self.relay,
                    channel_id,
                    self.agent,
                    &error_message,
                    restart_after_turn,
                );
                if restart_after_turn {
                    self.restart().await?;
                    self.refresh_usage().await;
                }
                if fatal_auth_failure {
                    return Ok(Some(CodexRunEnd::AuthFailure));
                }
                self.publish_idle();
            }
            InterruptibleCodexTurn::Interrupted => {
                write_current_run_status("turn_interrupted", false, message_id);
                finish_as("interrupted");
            }
            InterruptibleCodexTurn::Shutdown(reason) => {
                eprintln!("{} Shutdown requested: {reason}", "○".cyan().bold());
                write_current_run_status("shutdown_requested", false, Some(&reason));
                self.relay.disconnect();
                return Ok(Some(CodexRunEnd::Shutdown));
            }
            InterruptibleCodexTurn::EventStreamClosed => {
                write_current_run_status("event_stream_closed", false, None);
                return Ok(Some(CodexRunEnd::EventStreamClosed));
            }
        }
        Ok(None)
    }
}

impl ChannelControlledRuntime for CodexRun<'_> {
    async fn request_model_switch(&mut self, requested: &str) -> Result<String, String> {
        let selected = resolve_switchable_model(&self.available_models, "Codex", requested)?;
        if self.latest_model.as_deref() != Some(selected.as_str()) {
            self.app.clear_model_parameters();
        }
        self.app.current_model = Some(selected.clone());
        self.latest_model = Some(selected.clone());
        write_current_run_model(Some(&selected));
        self.latest_effort =
            codex_default_effort_for_model(&self.available_models, Some(&selected));
        self.app.current_effort = self.latest_effort.clone();
        write_current_run_effort(self.latest_effort.as_deref());
        Ok(selected)
    }

    async fn request_effort_switch(&mut self, requested: &str) -> Result<String, String> {
        let options =
            codex_effort_options_for_model(&self.available_models, self.latest_model.as_deref());
        if options.is_empty() {
            return Err("Codex effort catalog is unavailable for the current model".to_string());
        }
        let cleaned = clean_run_effort(requested);
        let selected = cleaned
            .as_deref()
            .and_then(|cleaned| {
                options
                    .iter()
                    .find(|candidate| candidate.eq_ignore_ascii_case(cleaned))
                    .cloned()
            })
            .ok_or_else(|| format!("Effort '{}' is not available", requested.trim()))?;
        self.latest_effort = Some(selected.clone());
        self.app.current_effort = Some(selected.clone());
        write_current_run_effort(Some(&selected));
        Ok(selected)
    }

    fn switch_presence(&self) -> PresencePatch {
        self.catalog_presence()
    }

    async fn parameter_control(
        &mut self,
        command: crate::harness_parameters::ParameterCommand,
        message: &InboundChannelMessage,
        agent: &protocol::SerializedAgent,
    ) -> Result<String, String> {
        let parameters = self.parameters();
        let (id, value) =
            crate::harness_parameter_toggles::resolve(command, &parameters, message, agent)?;
        let notice = match value {
            Some(value) if id == "model" || id == "effort" => {
                if crate::harness_parameters::validate(&parameters, &id, &value).is_err() {
                    return Err(format!(
                        "Harness parameter '{id}' does not support '{value}'"
                    ));
                }
                let control = if id == "model" {
                    CodexTypedChannelCommand::Model {
                        model: value.clone(),
                    }
                } else {
                    CodexTypedChannelCommand::Effort {
                        effort: value.clone(),
                    }
                };
                if !self.apply_typed_command(control) {
                    return Err("Parameter selection failed".into());
                }
                format!("Selected {id}: {value} for subsequent turns")
            }
            Some(value) => {
                self.app
                    .apply_parameter(&parameters, self.latest_model.as_deref(), &id, &value)
                    .await?
            }
            None => parameters
                .iter()
                .find(|p| p.id == id)
                .map(|p| self.app.parameter_status(p, self.latest_model.as_deref()))
                .ok_or_else(|| format!("Harness parameter '{id}' is unavailable"))?,
        };
        crate::harness_parameter_toggles::complete(message, agent, &parameters)?;
        Ok(notice)
    }

    fn parameter_presence(&self) -> PresencePatch {
        PresencePatch::presentation(self.catalog_presentation()).parameters(self.parameters())
    }
}
