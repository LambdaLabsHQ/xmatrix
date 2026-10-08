impl AcpSession {
    async fn spawn(
        cmd: &str,
        cmd_args: &[String],
        cwd: Option<&str>,
        config: AcpVendorConfig,
    ) -> error::Result<Self> {
        match config.flavor {
            // Grok keeps its WebSocket serve transport (stdio optional); the
            // generic ACP path is stdio-only.
            AcpVendorFlavor::Grok => match grok_transport_kind(cmd_args) {
                AcpTransportKind::WebSocket => {
                    Self::spawn_websocket(cmd, cmd_args, cwd, config).await
                }
                AcpTransportKind::Stdio => Self::spawn_stdio(cmd, cmd_args, cwd, config).await,
            },
            AcpVendorFlavor::Generic => Self::spawn_stdio(cmd, cmd_args, cwd, config).await,
        }
    }

    async fn spawn_stdio(
        cmd: &str,
        cmd_args: &[String],
        cwd: Option<&str>,
        config: AcpVendorConfig,
    ) -> error::Result<Self> {
        Self::spawn_stdio_with_prefix_args(cmd, &[], cmd_args, cwd, config).await
    }

    async fn spawn_stdio_with_prefix_args(
        cmd: &str,
        prefix_args: &[String],
        cmd_args: &[String],
        cwd: Option<&str>,
        config: AcpVendorConfig,
    ) -> error::Result<Self> {
        let mut app_args = prefix_args.to_vec();
        app_args.extend(config.acp_spawn_args(cmd_args, AcpTransportKind::Stdio, None, None));
        let mut server = AppServerChild::spawn(
            cmd,
            &app_args,
            cwd,
            Stdio::piped(),
            "ACP agent stdio",
            |_| {},
        )?;
        let stdin = server.take_stdin()?;
        let AppServerChild {
            child,
            process_tree,
            stdout,
            ..
        } = server;
        let inbox = spawn_stdio_json_value_reader(stdout, config.display_name.clone());

        Ok(Self::from_transport(
            AppServerWrite::Stdio(Arc::new(AsyncMutex::new(stdin))),
            inbox,
            process_tree,
            child,
            config,
        ))
    }

    async fn spawn_websocket(
        cmd: &str,
        cmd_args: &[String],
        cwd: Option<&str>,
        config: AcpVendorConfig,
    ) -> error::Result<Self> {
        let secret = uuid::Uuid::new_v4().simple().to_string();
        let bind = loopback_ws_bind_address("XMATRIX_GROK_WS_BIND", "grok serve")?;
        let app_args = config.acp_spawn_args(
            cmd_args,
            AcpTransportKind::WebSocket,
            Some(&bind),
            Some(&secret),
        );
        let AppServerChild {
            mut child,
            mut process_tree,
            stdout,
            ..
        } = AppServerChild::spawn(
            cmd,
            &app_args,
            cwd,
            Stdio::null(),
            "ACP agent WebSocket serve",
            |_| {},
        )?;

        let expected_url = format!("ws://{bind}/ws?server-key={secret}");
        let (url_tx, url_rx) = tokio::sync::oneshot::channel::<String>();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut url_tx = Some(url_tx);
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(url) = grok_ws_url_from_banner_line(&line)
                    && let Some(tx) = url_tx.take()
                {
                    let _ = tx.send(url);
                }
            }
        });
        // Grok 1.0.3 prints the WebSocket banner on stderr and, on Windows, can
        // take longer than 15s to bind. Poll the deterministic bind URL (and
        // any stdout banner) instead of waiting for a banner that never arrives.
        let (ws, _ws_url) = match connect_grok_websocket(
            &mut child,
            &expected_url,
            url_rx,
            Duration::from_secs(30),
        )
        .await
        {
            Ok(pair) => pair,
            Err(err) => {
                terminate_app_server(&mut process_tree, &mut child).await;
                return Err(err);
            }
        };

        let (write, read) = ws.split();
        let inbox = spawn_ws_json_value_reader(read, config.display_name.clone());

        eprintln!(
            "{} Connected to {} ACP WebSocket at {bind}",
            "✓".green().bold(),
            config.display_name
        );

        Ok(Self::from_transport(
            AppServerWrite::WebSocket(Arc::new(AsyncMutex::new(write))),
            inbox,
            process_tree,
            child,
            config,
        ))
    }

    fn from_transport(
        write: AppServerWrite,
        inbox: ProviderInbox,
        process_tree: process_tree::ProcessTreeGuard,
        child: Child,
        config: AcpVendorConfig,
    ) -> Self {
        Self {
            write,
            inbox,
            process_tree,
            child,
            next_id: 1,
            session_id: None,
            loaded_goal: None,
            presentation: AgentPresentationFacts::default(),
            config,
            activity: ChannelActivityReporter::default(),
            questions: Default::default(),
        }
    }

    fn current_model(&self) -> Option<&str> {
        self.presentation.model.as_deref()
    }

    fn current_effort(&self) -> Option<&str> {
        self.presentation.effort.as_deref()
    }

    fn available_models(&self) -> &[protocol::AgentModelInfo] {
        &self.presentation.models
    }

    fn presentation_snapshot(&self, command_overlay: &[String]) -> AgentPresentationSnapshot {
        self.config
            .presentation_adapter
            .present(&self.presentation, command_overlay)
    }

    fn interrupter(&self) -> error::Result<AcpInterrupter> {
        Ok(AcpInterrupter {
            write: self.write.clone(),
            questions: self.questions.clone(),
            session_id: self.session_id.clone().ok_or_else(|| {
                CliError::Launch(format!(
                    "{} agent session not initialized",
                    self.config.log_name()
                ))
            })?,
        })
    }

    async fn write_message(&self, value: &Value) -> error::Result<()> {
        write_acp_message(&self.write, value).await
    }

    async fn request_inner(
        &mut self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, AcpRequestError> {
        if method == "session/load" {
            self.loaded_goal = None;
        }
        let id = self.next_id;
        self.next_id += 1;
        let mut request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
        });
        if let Some(params) = params {
            request["params"] = params;
        }
        self.write_message(&request)
            .await
            .map_err(|err| AcpRequestError {
                code: None,
                detail: err.to_string(),
            })?;

        // Read from the live stream (not the backlog) so unmatched notifications
        // can be queued without being re-popped by the same wait loop.
        while let Some(message) = self.inbox.recv().await {
            self.config
                .presentation_adapter
                .observe_acp(&message, &mut self.presentation);
            if acp_handle_server_request(self, &message)
                .await
                .map_err(|err| AcpRequestError {
                    code: None,
                    detail: err.to_string(),
                })?
                .is_some()
            {
                continue;
            }
            if acp_is_session_load_replay(&request, &message) {
                // Presentation was observed above and server requests were answered.
                // History already lives in the provider session; do not retain it
                // for the next prompt or publish it as that turn's output.
                if let Some(goal) = self
                    .config
                    .goal_status_from_update
                    .and_then(|hook| message.pointer("/params/update").and_then(hook))
                {
                    self.loaded_goal = Some(goal);
                }
                continue;
            }
            if !acp_message_id_matches(message.get("id"), id) {
                self.inbox.defer(message).map_err(|err| AcpRequestError {
                    code: None,
                    detail: err.to_string(),
                })?;
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(AcpRequestError {
                    code: error.get("code").and_then(Value::as_i64),
                    detail: format!(
                        "{} agent {method} failed: {}",
                        self.config.log_name(),
                        acp_error_message(error)
                    ),
                });
            }
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }

        Err(AcpRequestError {
            code: None,
            detail: self.inbox.error().to_string(),
        })
    }

    async fn request(&mut self, method: &str, params: Option<Value>) -> error::Result<Value> {
        self.request_inner(method, params)
            .await
            .map_err(|err| CliError::Launch(err.detail))
    }

    /// Generic vendors skip `authenticate` up front; when the agent still
    /// answers authRequired (-32000), retry once after `methodId: "login"`.
    async fn request_with_login_retry(
        &mut self,
        method: &str,
        params: Value,
    ) -> error::Result<Value> {
        match self.request_inner(method, Some(params.clone())).await {
            Ok(result) => Ok(result),
            Err(err)
                if self.config.authenticate.is_none()
                    && err.code == Some(ACP_AUTH_REQUIRED_CODE) =>
            {
                self.request(
                    "authenticate",
                    Some(serde_json::json!({ "methodId": "login" })),
                )
                .await?;
                self.request(method, Some(params)).await
            }
            Err(err) => Err(CliError::Launch(err.detail)),
        }
    }

    async fn notify(&self, method: &str, params: Option<Value>) -> error::Result<()> {
        let mut notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
        });
        if let Some(params) = params {
            notification["params"] = params;
        }
        self.write_message(&notification).await
    }

    async fn next_message(&mut self) -> Option<Value> {
        self.inbox.next().await
    }

    async fn initialize(
        &mut self,
        cwd: Option<&str>,
        resume_session_key: Option<&str>,
        resume_requested: bool,
        trusted_rules: Option<&str>,
    ) -> error::Result<AgentPresentationSnapshot> {
        let _ = self
            .request_with_login_retry("initialize", acp_initialize_params())
            .await?;
        self.notify("notifications/initialized", None).await?;

        if let Some(authenticate) = self.config.authenticate.clone() {
            let method_id = authenticate
                .get("methodId")
                .and_then(Value::as_str)
                .unwrap_or("login")
                .to_string();
            if let Err(err) = self.request("authenticate", Some(authenticate)).await {
                eprintln!(
                    "{} {} authenticate({method_id}) failed: {err}; continuing if the agent already has credentials",
                    "⚠".yellow().bold(),
                    self.config.display_name
                );
            }
        }

        let workspace_path = app_server_workspace_path(cwd)?;
        let resume_namespace = self.config.resume_namespace.clone();
        let resume_session_id = resume_requested
            .then(|| load_acp_resume_session_id(&resume_namespace, resume_session_key))
            .flatten();
        let new_session_params = || acp_session_new_params(&workspace_path, trusted_rules);
        let result = if let Some(session_id) = resume_session_id.as_deref() {
            match self
                .request_with_login_retry(
                    "session/load",
                    serde_json::json!({
                        "sessionId": session_id,
                        "cwd": workspace_path.clone(),
                        "mcpServers": crate::runtime_connector_mcp::acp_connector_mcp_servers(),
                    }),
                )
                .await
            {
                Ok(result) => {
                    eprintln!(
                        "{} Resumed {} ACP session {}",
                        "✓".green().bold(),
                        self.config.display_name,
                        session_id.dimmed()
                    );
                    result
                }
                Err(err) => {
                    self.loaded_goal = None;
                    eprintln!(
                        "{} {} session/load failed for {}: {err}; starting a new session",
                        "⚠".yellow().bold(),
                        self.config.display_name,
                        session_id.dimmed()
                    );
                    self.request_with_login_retry("session/new", new_session_params())
                        .await?
                }
            }
        } else {
            self.request_with_login_retry("session/new", new_session_params())
                .await?
        };
        let session_id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or(resume_session_id)
            .ok_or_else(|| {
                CliError::Launch(format!(
                    "{} agent session open missing sessionId",
                    self.config.log_name()
                ))
            })?;
        save_acp_resume_session_id(&resume_namespace, resume_session_key, Some(&session_id))?;
        self.session_id = Some(session_id);
        Ok(self.presentation_snapshot(&[]))
    }

    async fn set_model(&mut self, model_id: &str) -> error::Result<String> {
        let model_id = model_id.trim();
        if model_id.is_empty() {
            return Err(CliError::Launch(format!(
                "{} model id is empty",
                self.config.display_name
            )));
        }
        let session_id = self.session_id.clone().ok_or_else(|| {
            CliError::Launch(format!(
                "{} agent session not initialized",
                self.config.log_name()
            ))
        })?;
        if self.presentation.model.as_deref() == Some(model_id) {
            return Ok(model_id.to_string());
        }
        let result = self
            .request(
                "session/set_model",
                Some(serde_json::json!({
                    "sessionId": session_id,
                    "modelId": model_id,
                })),
            )
            .await?;
        let selected = result
            .get("_meta")
            .and_then(|meta| meta.get("model"))
            .and_then(|model| model.get("Ok"))
            .and_then(Value::as_str)
            .and_then(clean_run_model)
            .unwrap_or_else(|| model_id.to_string());
        self.presentation.model = Some(selected.clone());
        Ok(selected)
    }

    async fn set_parameter(&mut self, id: &str, value: &str) -> error::Result<String> {
        let parameters = self.presentation.parameters.as_deref().unwrap_or_default();
        let parameter =
            crate::harness_parameters::validate(parameters, id, value).map_err(CliError::Launch)?;
        let value = crate::harness_parameters::canonical_value(parameter, value)
            .unwrap()
            .to_string();
        let boolean = parameter.kind == Some(protocol::HarnessParameterKind::Boolean);
        let mut params = serde_json::json!({ "configId": id, "value": value });
        if boolean {
            params["type"] = serde_json::json!("boolean");
            params["value"] = serde_json::json!(
                value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("on")
            );
        }
        let session_id = self
            .session_id
            .clone()
            .ok_or_else(|| CliError::Launch("ACP session not initialized".into()))?;
        let result = self
            .request(
                "session/set_config_option",
                Some({
                    params["sessionId"] = serde_json::json!(session_id);
                    params
                }),
            )
            .await?;
        if !result
            .get("configOptions")
            .or_else(|| result.get("config_options"))
            .is_some_and(Value::is_array)
        {
            self.presentation.parameters = Some(Vec::new());
            return Err(CliError::Launch(
                "Harness did not return a parameter snapshot".into(),
            ));
        }
        self.config
            .presentation_adapter
            .observe_acp(&result, &mut self.presentation);
        // A successful RPC is insufficient: the returned complete snapshot must confirm the value.
        let confirmed = self
            .presentation
            .parameters
            .as_deref()
            .unwrap_or_default()
            .iter()
            .find(|p| p.id == id)
            .and_then(|p| p.current_value.as_deref());
        if confirmed != Some(value.as_str()) {
            return Err(CliError::Launch(
                "Harness did not confirm the selected parameter value".into(),
            ));
        }
        Ok(value.to_string())
    }

    async fn set_effort(&mut self, effort: &str) -> error::Result<String> {
        let effort = effort.trim();
        if effort.is_empty() {
            return Err(CliError::Launch(format!(
                "{} effort is empty",
                self.config.display_name
            )));
        }
        let config_id = self
            .presentation
            .effort_config_id
            .as_deref()
            .ok_or_else(|| {
                CliError::Launch(format!(
                    "{} does not advertise an ACP effort control",
                    self.config.display_name
                ))
            })?;
        let session_id = self.session_id.clone().ok_or_else(|| {
            CliError::Launch(format!(
                "{} agent session not initialized",
                self.config.log_name()
            ))
        })?;
        let result = self
            .request(
                "session/set_config_option",
                Some(serde_json::json!({
                    "sessionId": session_id,
                    "configId": config_id,
                    "value": effort,
                })),
            )
            .await?;
        self.config
            .presentation_adapter
            .observe_acp(&result, &mut self.presentation);
        let selected = self
            .presentation
            .effort
            .clone()
            .unwrap_or_else(|| effort.to_string());
        self.presentation.effort = Some(selected.clone());
        Ok(selected)
    }

    /// Show a form elicitation as a card and park it for the answer; with no
    /// channel to show it in, or no question in it, cancel it at once.
    async fn park_acp_question(
        &mut self,
        message: &Value,
        relay: Option<&Arc<agent_instance_connection::AgentInstanceConnectionClient>>,
        channel_id: Option<&str>,
    ) -> error::Result<()> {
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let questions = crate::runtime_harness_questions::acp_questions(&params);
        match (relay, channel_id) {
            (Some(relay), Some(channel_id)) if !questions.is_empty() => {
                let key = params
                    .get("elicitationId")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .unwrap_or_else(|| format!("acp-{}", uuid::Uuid::new_v4()));
                crate::runtime_harness_questions::publish_questionnaire(
                    relay,
                    channel_id,
                    crate::runtime_harness_questions::questionnaire_message(
                        &self.config.trace_source,
                        &self.config.display_name,
                        &key,
                        &questions,
                    ),
                );
                self.questions.park(key, (id, params));
                Ok(())
            }
            _ => {
                self.write_message(&acp_result(id, serde_json::json!({ "action": "cancel" })))
                    .await
            }
        }
    }

    async fn submit_turn(
        &mut self,
        text: &str,
        content_blocks: Vec<Value>,
        model: Option<&str>,
        goal_command: Option<&GoalCommand>,
        agent: &protocol::SerializedAgent,
        trace_relay: Option<&Arc<agent_instance_connection::AgentInstanceConnectionClient>>,
        trace_channel_id: Option<&str>,
    ) -> error::Result<CodexTurnResult> {
        let session_id = self.session_id.clone().ok_or_else(|| {
            CliError::Launch(format!(
                "{} agent session not initialized",
                self.config.log_name()
            ))
        })?;
        let trace_source = self.config.trace_source.clone();
        let trace = TurnTrace {
            relay: trace_relay,
            channel_id: trace_channel_id,
            source: &trace_source,
            agent,
        };
        let display_name = self.config.display_name.clone();
        if let Some(model) = model.map(str::trim).filter(|value| !value.is_empty())
            && let Err(err) = self.set_model(model).await {
                eprintln!(
                    "{} {} could not select model '{model}' before turn: {err}",
                    "⚠".yellow().bold(),
                    display_name
                );
            }
        // Allocate the JSON-RPC prompt id first so every llm_trace event for this
        // turn shares a stable turnId. Without threadId/turnId, the web detail
        // view keys unscoped deltas by event id and renders each chunk as its
        // own one-token Output card (vertical Chinese/token lines).
        let id = self.next_id;
        self.next_id += 1;
        let turn_id = id.to_string();
        let turn_ids = AcpTurnIds {
            session_id: &session_id,
            turn_id: &turn_id,
        };
        trace
            .send(
                "turn_started",
                None,
                self.presentation.model.clone(),
                turn_ids.payload(serde_json::json!({ "input": redact_data_urls(text) })),
            )
            .await;

        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/prompt",
            "params": {
                "sessionId": session_id.clone(),
                "prompt": content_blocks,
            },
        });
        self.write_message(&request).await?;
        crate::runtime_wake_metrics::record_acp_prompt_sent();

        let mut output = String::new();
        let mut latest_usage = self.presentation.usage.clone();
        let mut latest_model = self.presentation.model.clone();
        let mut latest_goal: Option<protocol::AgentGoalStatus> = None;
        let turn_timeout = acp_turn_timeout(self.config.turn_timeout_env);
        loop {
            let message = match tokio::time::timeout(turn_timeout, self.next_message()).await {
                Ok(Some(message)) => message,
                Ok(None) => {
                    if self.inbox.has_failure() {
                        return Ok(CodexTurnResult {
                            local_output: output,
                            restart_after_turn: self.inbox.retryable(),
                            failed: true,
                            failure_detail: Some(self.inbox.error().to_string()),
                            usage: latest_usage,
                            goal: latest_goal,
                            model: latest_model,
                        });
                    }
                    break;
                }
                // The agent is silent because it waits on its person.
                Err(_) if self.questions.any() => continue,
                Err(_) => {
                    let error = format!(
                        "{} ACP turn timed out after {}s without agent events",
                        display_name,
                        turn_timeout.as_secs()
                    );
                    return Ok(CodexTurnResult {
                        local_output: output,
                        restart_after_turn: true,
                        failed: true,
                        failure_detail: Some(error),
                        usage: latest_usage,
                        goal: latest_goal,
                        model: latest_model,
                    });
                }
            };

            self.config
                .presentation_adapter
                .observe_acp(&message, &mut self.presentation);
            latest_usage = merge_llm_usage(latest_usage, self.presentation.usage.clone());
            latest_model = self.presentation.model.clone().or(latest_model);

            if message.get("method").and_then(Value::as_str) == Some("elicitation/create")
                && message.get("id").is_some()
            {
                self.park_acp_question(&message, trace_relay, trace_channel_id)
                    .await?;
                continue;
            }
            if acp_handle_server_request(self, &message).await?.is_some() {
                continue;
            }

            if acp_message_id_matches(message.get("id"), id) {
                if let Some(error) = message.get("error") {
                    let detail = acp_error_message(error);
                    trace
                        .send(
                            "turn_failed",
                            latest_usage.clone(),
                            latest_model.clone(),
                            turn_ids.payload(serde_json::json!({ "error": detail })),
                        )
                        .await;
                    return Ok(CodexTurnResult {
                        local_output: output,
                        restart_after_turn: false,
                        failed: true,
                        failure_detail: Some(format!("{display_name} ACP turn failed: {detail}")),
                        usage: latest_usage,
                        goal: latest_goal,
                        model: latest_model,
                    });
                }
                let result = message.get("result").cloned().unwrap_or(Value::Null);
                latest_usage =
                    merge_llm_usage(latest_usage, extract_llm_usage(&result));
                if let Some(meta) = result.get("_meta") {
                    latest_usage =
                        merge_llm_usage(latest_usage, extract_llm_usage(meta));
                    if let Some(model) = meta
                        .get("modelId")
                        .and_then(Value::as_str)
                        .and_then(clean_run_model)
                    {
                        latest_model = Some(model);
                    }
                }
                if let Some(model) = latest_model.clone() {
                    self.presentation.model = Some(model);
                }
                let cancellation_detail = acp_turn_cancellation_detail(&display_name, &result);
                if latest_goal.is_none() {
                    latest_goal = self
                        .config
                        .goal_status_from_text
                        .and_then(|hook| hook(&output, goal_command));
                }
                // Optimistic local goal state when we issued a control slash and
                // Grok didn't emit a structured update_goal tool call.
                if latest_goal.is_none() {
                    latest_goal = match goal_command {
                        Some(GoalCommand::Set { objective })
                        | Some(GoalCommand::Replace { objective }) => {
                            Some(protocol::AgentGoalStatus {
                                active: Some(true),
                                objective: Some(objective.clone()),
                                status: Some("active".to_string()),
                                updated_at: Some(unix_millis_now().to_string()),
                                ..Default::default()
                            })
                        }
                        Some(GoalCommand::Clear) => Some(protocol::AgentGoalStatus {
                            active: Some(false),
                            objective: None,
                            status: Some("cleared".to_string()),
                            updated_at: Some(unix_millis_now().to_string()),
                            ..Default::default()
                        }),
                        Some(GoalCommand::Pause) => Some(protocol::AgentGoalStatus {
                            active: Some(false),
                            objective: None,
                            status: Some("paused".to_string()),
                            updated_at: Some(unix_millis_now().to_string()),
                            ..Default::default()
                        }),
                        Some(GoalCommand::Resume) => Some(protocol::AgentGoalStatus {
                            active: Some(true),
                            objective: None,
                            status: Some("active".to_string()),
                            updated_at: Some(unix_millis_now().to_string()),
                            ..Default::default()
                        }),
                        Some(GoalCommand::Get) | None => None,
                    };
                }
                if let Some((relay, channel_id)) = trace.target() {
                    finish_acp_turn(&mut self.activity, relay, channel_id);
                }
                trace
                    .send(
                        if cancellation_detail.is_some() {
                            "turn_cancelled"
                        } else {
                            "turn_completed"
                        },
                        latest_usage.clone(),
                        latest_model.clone(),
                        turn_ids.payload(serde_json::json!({
                            "stopReason": result.get("stopReason"),
                            "cancellationCategory": result.get("cancellation_category")
                                .or_else(|| result.get("cancellationCategory"))
                                .or_else(|| result.get("_meta")
                                    .and_then(|meta| meta.get("cancellation_category")
                                        .or_else(|| meta.get("cancellationCategory")))),
                            "goal": latest_goal,
                        })),
                    )
                    .await;
                return Ok(CodexTurnResult {
                    local_output: output,
                    restart_after_turn: false,
                    failed: cancellation_detail.is_some(),
                    failure_detail: cancellation_detail,
                    usage: latest_usage,
                    goal: latest_goal,
                    model: latest_model,
                });
            }

            if message.get("method").and_then(Value::as_str) != Some("session/update") {
                continue;
            }
            let params = message.get("params").unwrap_or(&Value::Null);
            if params.get("sessionId").and_then(Value::as_str) != Some(session_id.as_str()) {
                continue;
            }
            let update = params.get("update").unwrap_or(&Value::Null);
            let session_update = update.get("sessionUpdate").and_then(Value::as_str);
            match session_update {
                Some("notice") => {
                    if let Some(payload) = acp_session_notice_payload(update) {
                        trace.send("runtime_event", None, latest_model.clone(), turn_ids.payload(payload)).await;
                    }
                }
                Some("agent_message_chunk") => {
                    if let Some(delta) = update
                        .get("content")
                        .and_then(|content| content.get("text"))
                        .and_then(Value::as_str)
                    {
                        output.push_str(delta);
                        trace
                            .send(
                                "assistant_delta",
                                None,
                                latest_model.clone(),
                                turn_ids.payload(serde_json::json!({ "delta": delta })),
                            )
                            .await;
                    }
                }
                Some("tool_call") | Some("tool_call_update") => {
                    if let Some(goal) = self
                        .config
                        .goal_status_from_update
                        .and_then(|hook| hook(update))
                    {
                        latest_goal = Some(goal);
                    }
                    let event = if session_update == Some("tool_call") {
                        "tool_call"
                    } else {
                        "tool_call_update"
                    };
                    trace
                        .send(
                            event,
                            None,
                            latest_model.clone(),
                            turn_ids.payload(
                                serde_json::json!({ "update": redact_data_urls_value(update) }),
                            ),
                        )
                        .await;
                }
                Some("agent_thought_chunk") => {
                    // Reasoning never becomes channel content, but it is retained
                    // in this host's trace store where an authorized Human reads the
                    // instance detail. Publishing it as a reasoning runtime delta
                    // lets the timeline fold consecutive chunks into one Reasoning
                    // section instead of one card per token.
                    if let Some(delta) = update
                        .get("content")
                        .and_then(|content| content.get("text"))
                        .and_then(Value::as_str)
                    {
                        trace
                            .send(
                                "runtime_event",
                                None,
                                latest_model.clone(),
                                turn_ids.payload(serde_json::json!({
                                    "category": "reasoning",
                                    "status": "delta",
                                    "delta": redact_data_urls(delta),
                                })),
                            )
                            .await;
                    }
                }
                Some("plan") => {
                    if let Some((relay, channel_id)) = trace.target() {
                        observe_acp_plan(&mut self.activity, relay, channel_id, update);
                    }
                    trace
                        .send(
                            "runtime_event",
                            None,
                            latest_model.clone(),
                            turn_ids.payload(serde_json::json!({
                                "category": "plan",
                                "status": "info",
                                "summary": "Plan updated",
                                "details": {
                                    "entries": redact_data_urls_value(
                                        &update.get("entries").cloned().unwrap_or(Value::Null)
                                    ),
                                },
                            })),
                        )
                        .await;
                }
                _ => {}
            }
        }

        Ok(CodexTurnResult {
            local_output: output,
            restart_after_turn: true,
            failed: true,
            failure_detail: Some(format!("{display_name} ACP event stream closed")),
            usage: latest_usage,
            goal: latest_goal,
            model: latest_model,
        })
    }

    async fn shutdown(&mut self) {
        terminate_app_server(&mut self.process_tree, &mut self.child).await;
    }
}

/// The ids every trace event of one ACP turn carries, so the timeline keys
/// its deltas to the turn rather than to each event.
struct AcpTurnIds<'a> {
    session_id: &'a str,
    turn_id: &'a str,
}

/// ACP Session Notices are advisory presentation events, never a turn result.
/// Their supplied text is retained only in the authorized host trace.
fn acp_session_notice_payload(update: &Value) -> Option<Value> {
    let severity = update.get("severity")?.as_str()?.trim();
    let title = update.get("title")?.as_str()?.trim();
    if severity.is_empty() || title.is_empty() { return None; }
    let status = match severity {
        "info" | "warning" | "error" => severity,
        _ => "unknown",
    };
    Some(serde_json::json!({
        "category": "notice",
        "status": status,
        "summary": truncate_chars(title, 240),
        "details": {
            "severity": truncate_chars(severity, 128),
            "description": update.get("description").and_then(Value::as_str)
                .map(|text| truncate_chars(&redact_data_urls(text), 2_000)),
        },
    }))
}

#[cfg(test)]
mod session_notice_tests {
    use super::*;

    #[test]
    fn capability_is_advertised_only_with_the_notice_decoder() {
        assert_eq!(acp_initialize_params()["clientCapabilities"]["session"]["notices"], serde_json::json!({}));
    }

    #[test]
    fn errors_remain_advisory_and_unknown_severities_remain_neutral() {
        let notice = acp_session_notice_payload(&serde_json::json!({"severity":"error","title":"MCP unavailable","description":"Continuing without it"})).unwrap();
        assert_eq!(notice["category"], "notice");
        assert_eq!(notice["status"], "error");
        assert_eq!(notice["details"]["description"], "Continuing without it");
        assert_eq!(acp_session_notice_payload(&serde_json::json!({"severity":"_vendor/custom","title":"Custom notice"})).unwrap()["status"], "unknown");
        for value in [serde_json::json!({"severity":"error"}), serde_json::json!({"severity":null,"title":"Error"}), serde_json::json!({"severity":"error","title":" "})] {
            assert!(acp_session_notice_payload(&value).is_none());
        }
    }
}

impl AcpTurnIds<'_> {
    fn payload(&self, fields: Value) -> Value {
        let mut payload = serde_json::json!({
            "sessionId": self.session_id,
            "threadId": self.session_id,
            "turnId": self.turn_id,
        });
        if let (Some(payload), Value::Object(fields)) = (payload.as_object_mut(), fields) {
            payload.extend(fields);
        }
        payload
    }
}

fn acp_is_session_load_replay(request: &Value, message: &Value) -> bool {
    request.get("method").and_then(Value::as_str) == Some("session/load")
        && message.get("method").and_then(Value::as_str) == Some("session/update")
        && message.get("id").is_none()
        && request
            .pointer("/params/sessionId")
            .and_then(Value::as_str)
            .is_some_and(|session_id| {
                message.pointer("/params/sessionId").and_then(Value::as_str) == Some(session_id)
            })
}

fn grok_transport_kind(cmd_args: &[String]) -> AcpTransportKind {
    if cmd_args.iter().any(|arg| arg == "stdio") {
        return AcpTransportKind::Stdio;
    }
    if cmd_args.iter().any(|arg| arg == "serve") {
        return AcpTransportKind::WebSocket;
    }
    match std::env::var("XMATRIX_GROK_TRANSPORT") {
        Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
            "stdio" | "std" | "pipe" => AcpTransportKind::Stdio,
            // Default and explicit WebSocket labels.
            "ws" | "websocket" | "serve" | "server" | "" => AcpTransportKind::WebSocket,
            other => {
                eprintln!(
                    "{} Unknown XMATRIX_GROK_TRANSPORT={other:?}; using WebSocket serve",
                    "⚠".yellow().bold()
                );
                AcpTransportKind::WebSocket
            }
        },
        Err(_) => AcpTransportKind::WebSocket,
    }
}

async fn connect_grok_websocket(
    child: &mut tokio::process::Child,
    expected_url: &str,
    mut url_rx: tokio::sync::oneshot::Receiver<String>,
    timeout: Duration,
) -> error::Result<(
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    String,
)> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut banner_url: Option<String> = None;
    let mut last_err = String::from("no connection attempt completed");
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(CliError::Launch(format!(
                    "ACP agent WebSocket serve exited before accepting connections ({status})"
                )));
            }
            Ok(None) => {}
            Err(err) => {
                return Err(CliError::Launch(format!(
                    "Failed to poll ACP agent WebSocket serve: {err}"
                )));
            }
        }
        if let Ok(url) = url_rx.try_recv() {
            banner_url = Some(url);
        }
        let mut candidates = Vec::with_capacity(2);
        if let Some(url) = banner_url.as_deref() {
            candidates.push(url);
        }
        if !candidates.contains(&expected_url) {
            candidates.push(expected_url);
        }
        for url in candidates {
            match tokio::time::timeout(
                Duration::from_millis(400),
                tokio_tungstenite::connect_async_with_config(
                    url,
                    Some(provider_websocket_config()),
                    false,
                ),
            )
            .await
            {
                Ok(Ok((ws, _))) => return Ok((ws, url.to_string())),
                Ok(Err(err)) => last_err = err.to_string(),
                Err(_) => last_err = "connect timed out".to_string(),
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(CliError::Launch(format!(
                "Failed to connect to ACP agent WebSocket ({expected_url}): {last_err}"
            )));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn grok_ws_url_from_banner_line(line: &str) -> Option<String> {
    let marker = "WebSocket URL:";
    let idx = line.find(marker)?;
    let rest = line[idx + marker.len()..].trim();
    let url = rest.split_whitespace().next()?.trim();
    if url.starts_with("ws://") || url.starts_with("wss://") {
        Some(url.to_string())
    } else {
        None
    }
}

fn grok_acp_spawn_args(
    cmd_args: &[String],
    transport: AcpTransportKind,
    bind: Option<&str>,
    secret: Option<&str>,
) -> Vec<String> {
    // Prefer an explicit agent-mode argv when callers already pass one.
    if cmd_args.iter().any(|arg| arg == "stdio" || arg == "serve") {
        let mut args = cmd_args.to_vec();
        if !args.iter().any(|arg| arg == "agent") {
            args.insert(0, "agent".to_string());
        }
        if !args
            .iter()
            .any(|arg| arg == "--always-approve" || arg == "--yolo")
        {
            if let Some(idx) = args.iter().position(|arg| arg == "stdio" || arg == "serve") {
                args.insert(idx, "--always-approve".to_string());
            } else {
                args.push("--always-approve".to_string());
            }
        }
        if transport == AcpTransportKind::WebSocket {
            // `serve` owns --bind/--secret; place them after the subcommand.
            if let Some(serve_idx) = args.iter().position(|arg| arg == "serve") {
                let mut insert_at = serve_idx + 1;
                if let Some(bind) = bind
                    && !args.iter().any(|arg| arg == "--bind") {
                        args.insert(insert_at, "--bind".to_string());
                        args.insert(insert_at + 1, bind.to_string());
                        insert_at += 2;
                    }
                if let Some(secret) = secret
                    && !args.iter().any(|arg| arg == "--secret") {
                        args.insert(insert_at, "--secret".to_string());
                        args.insert(insert_at + 1, secret.to_string());
                    }
            }
        }
        return args;
    }

    let mut args = vec!["agent".to_string()];
    if let Ok(model) = std::env::var("XMATRIX_GROK_MODEL") {
        let model = model.trim();
        if !model.is_empty() {
            args.push("-m".to_string());
            args.push(model.to_string());
        }
    }
    for arg in cmd_args {
        // Surface user-supplied flags before the transport subcommand.
        args.push(arg.clone());
    }
    args.push("--always-approve".to_string());
    match transport {
        AcpTransportKind::Stdio => {
            args.push("stdio".to_string());
        }
        AcpTransportKind::WebSocket => {
            // clap shape: `grok agent [agent-opts] serve [serve-opts]`
            args.push("serve".to_string());
            if let Some(bind) = bind {
                args.push("--bind".to_string());
                args.push(bind.to_string());
            }
            if let Some(secret) = secret {
                args.push("--secret".to_string());
                args.push(secret.to_string());
            }
        }
    }
    args
}

fn acp_turn_timeout(env_var: &str) -> Duration {
    const DEFAULT_SECS: u64 = 60 * 30;
    match std::env::var(env_var) {
        Ok(raw) => raw
            .trim()
            .parse::<u64>()
            .ok()
            .filter(|value| *value > 0)
            .map(Duration::from_secs)
            .unwrap_or(Duration::from_secs(DEFAULT_SECS)),
        Err(_) => Duration::from_secs(DEFAULT_SECS),
    }
}

fn acp_message_id_matches(value: Option<&Value>, expected: u64) -> bool {
    match value {
        Some(Value::Number(number)) => number
            .as_u64()
            .or_else(|| number.as_i64().map(|n| n as u64))
            .is_some_and(|n| n == expected),
        Some(Value::String(text)) => text.parse::<u64>().ok() == Some(expected),
        _ => false,
    }
}

fn acp_error_message(error: &Value) -> String {
    if let Some(message) = error.get("message").and_then(Value::as_str) {
        if let Some(data) = error.get("data") {
            return format!("{message}: {data}");
        }
        return message.to_string();
    }
    error.to_string()
}

fn acp_turn_cancellation_detail(display_name: &str, result: &Value) -> Option<String> {
    let meta = result.get("_meta");
    let value = |key: &str| {
        result
            .get(key)
            .or_else(|| meta.and_then(|meta| meta.get(key)))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let outcome = value("stopReason")
        .or_else(|| value("outcome"))
        .or_else(|| value("status"));
    let category = value("cancellation_category").or_else(|| value("cancellationCategory"));
    let cancelled = outcome.is_some_and(|value| {
        let value = value.to_ascii_lowercase();
        value.contains("cancel") || value == "interrupted" || value == "mid_turn_abort"
    }) || category.is_some_and(|value| {
        let value = value.to_ascii_lowercase();
        value.contains("cancel") || value.contains("abort") || value.contains("interrupt")
    });
    cancelled.then(|| {
        format!(
            "{display_name} ACP turn cancelled{}",
            category
                .map(|value| format!(": {value}"))
                .unwrap_or_default()
        )
    })
}

fn acp_turn_result_is_cancelled(turn: &CodexTurnResult) -> bool {
    turn.failure_detail
        .as_deref()
        .is_some_and(|detail| detail.contains(" ACP turn cancelled"))
}

/// Picks the optionId for an auto-approved ACP permission request. Vendors
/// word options differently (Grok: `allow-always`; Kimi: `approve_always`
/// with `kind: "allow_always"`), so selection is driven by the ACP `kind`
/// semantics first and optionId heuristics second.
fn acp_select_permission_option_id(options: &[Value]) -> Option<String> {
    let option_id = |option: &Value| {
        option
            .get("optionId")
            .or_else(|| option.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let kind_matches = |option: &Value, expected: &str| {
        option
            .get("kind")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind.eq_ignore_ascii_case(expected))
    };
    let id_matches = |option: &Value, predicate: fn(&str) -> bool| {
        option_id(option).is_some_and(|id| predicate(&id.to_ascii_lowercase()))
    };
    // 1. Explicit always-allow kind (Kimi: approve_always/allow_always).
    if let Some(option) = options
        .iter()
        .find(|option| kind_matches(option, "allow_always"))
    {
        return option_id(option);
    }
    // 2. optionId wording: always + allow/approve (covers Grok's allow-always,
    //    whose options may not carry a `kind` field).
    if let Some(option) = options.iter().find(|option| {
        id_matches(option, |id| {
            id.contains("always") && (id.contains("allow") || id.contains("approve"))
        })
    }) {
        return option_id(option);
    }
    // 3. Single-shot allow kind.
    if let Some(option) = options
        .iter()
        .find(|option| kind_matches(option, "allow_once"))
    {
        return option_id(option);
    }
    // 4. optionId wording: any allow/approve/once.
    if let Some(option) = options.iter().find(|option| {
        id_matches(option, |id| {
            id.contains("allow") || id.contains("approve") || id.contains("once")
        })
    }) {
        return option_id(option);
    }
    // 5. First option that carries an id.
    options.iter().find_map(option_id)
}

async fn acp_handle_server_request(
    session: &AcpSession,
    message: &Value,
) -> error::Result<Option<()>> {
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some(id) = message.get("id").cloned() else {
        return Ok(None);
    };
    // Ignore responses / errors that happen to include a method field.
    if message.get("result").is_some() || message.get("error").is_some() {
        return Ok(None);
    }

    let result = if method == "elicitation/create" {
        // Outside a turn there is no channel to ask in.
        serde_json::json!({ "action": "cancel" })
    } else if method.contains("permission") {
        // Auto-approve tool execution when the agent still asks (belt and suspenders
        // with --always-approve on the spawn line). Option selection is driven by
        // the ACP `kind` semantics so each vendor's wording works; when the request
        // carries no selectable option, fall back to the vendor's historical
        // optionId (Grok: allow-always) or reject with -32601.
        let options = message
            .get("params")
            .and_then(|params| params.get("options"))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        match acp_select_permission_option_id(options).or_else(|| {
            session
                .config
                .permission_fallback_option_id
                .map(str::to_string)
        }) {
            Some(option_id) => serde_json::json!({
                "outcome": {
                    "outcome": "selected",
                    "optionId": option_id
                }
            }),
            None => {
                let response = serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32601,
                        "message": format!(
                            "xmatrix {} bridge found no approvable permission option for {method}",
                            session.config.log_name()
                        ),
                    }
                });
                session.write_message(&response).await?;
                return Ok(Some(()));
            }
        }
    } else {
        // Client-side FS/terminal capabilities are intentionally empty; reject
        // unexpected server->client requests so the agent falls back to its tools.
        let response = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": -32601,
                "message": format!(
                    "xmatrix {} bridge does not implement {method}",
                    session.config.log_name()
                ),
            }
        });
        session.write_message(&response).await?;
        return Ok(Some(()));
    };

    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    });
    session.write_message(&response).await?;
    Ok(Some(()))
}

fn redact_data_urls_value(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(redact_data_urls(text)),
        Value::Array(items) => Value::Array(items.iter().map(redact_data_urls_value).collect()),
        Value::Object(map) => {
            let mut next = serde_json::Map::new();
            for (key, item) in map {
                next.insert(key.clone(), redact_data_urls_value(item));
            }
            Value::Object(next)
        }
        other => other.clone(),
    }
}

#[cfg(test)]
#[expect(
    clippy::await_holding_lock,
    reason = "each #[tokio::test] runs on its own thread; the guard only serializes process-global env across test threads"
)]
mod tests;
