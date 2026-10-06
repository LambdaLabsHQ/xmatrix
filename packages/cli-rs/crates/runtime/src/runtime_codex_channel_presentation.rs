async fn restart_codex_app_session(
    app: &mut CodexAppSession,
    cmd: &str,
    cwd: Option<&str>,
    agent: &protocol::SerializedAgent,
    resume_session_key: Option<&str>,
) -> error::Result<()> {
    app.shutdown().await;
    let mut replacement =
        spawn_initialized_codex_app(cmd, cwd, agent, resume_session_key, true).await?;
    let models = replacement.list_models().await?;
    replacement
        .install_parameter_schemas(crate::harness_parameters::discover_codex_parameters(cmd).await);
    // Pending turn settings are local selections, not reported provider state.
    // Revalidate them against the new process before resuming any work.
    for (id, value) in &app.selected_parameters {
        let model = app.current_model.as_deref();
        let parameters = replacement.parameters(&models, model, None);
        let supported = parameters.iter().find(|p| p.id == *id);
        if !supported.is_some_and(|p| replacement.parameter_value_supported(p, value)) {
            replacement.shutdown().await;
            return Err(CliError::Launch(format!(
                "Selected parameter '{id}' is unavailable after restart"
            )));
        }
    }
    replacement.selected_parameters = app.selected_parameters.clone();
    replacement.reset_service_tier = app.reset_service_tier;
    replacement
        .apply_selected_settings(app.current_model.as_deref())
        .await
        .map_err(CliError::Launch)?;
    *app = replacement;
    eprintln!(
        "{} Restarted Codex app-server backend for {} ({})",
        "✓".green().bold(),
        agent.name,
        agent.id.dimmed()
    );
    Ok(())
}

async fn restart_zcode_app_session(
    app: &mut ZcodeAppSession,
    cmd: &str,
    cmd_args: &[String],
    cwd: Option<&str>,
    agent: &protocol::SerializedAgent,
) -> error::Result<()> {
    app.shutdown().await;
    let mut replacement = ZcodeAppSession::spawn(cmd, cmd_args, cwd).await?;
    replacement.initialize(cwd).await?;
    *app = replacement;
    eprintln!(
        "{} Restarted ZCode app-server backend for {} ({})",
        "✓".green().bold(),
        agent.name,
        agent.id.dimmed()
    );
    Ok(())
}

/// Which runtime's presentation adapter and command catalog this process
/// speaks for.
///
/// One reading, not one per call site: the preset a managed profile launched
/// under, else the backend it was spawned as.
///
/// There used to be a third fallback on `XMATRIX_TOOL`. Nothing in the repo ever
/// set it, so it could only ever return `None` and read as coverage this chain
/// did not have. An empty hint is still reachable — a wrapper invoked directly
/// from a terminal has neither variable and falls through to the Legacy adapter
/// with no command catalog — but that gap is the launcher's to close, not a
/// fourth env var's.
pub(crate) fn runtime_presentation_hint() -> String {
    std::env::var("XMATRIX_AGENT_PRESET_ID")
        .ok()
        .or_else(|| std::env::var("XMATRIX_AGENT_BACKEND").ok())
        .unwrap_or_default()
}

/// Everything a presence frame reports beyond liveness.
///
/// One shape instead of a wrapper per field combination. This family used to be
/// nine functions whose only difference was which arguments they defaulted, so
/// the frame's parameter list — including the order of the two `Option<String>`
/// fields `model` and `effort` — was restated nine times.
#[derive(Default)]
pub(crate) struct PresencePatch {
    presentation: AgentPresentationSnapshot,
    /// `None` leaves the reported goal untouched; `Some(None)` clears it.
    goal: Option<Option<protocol::AgentGoalStatus>>,
    runtime_state: Option<protocol::AgentRuntimeState>,
}

impl PresencePatch {
    /// Liveness and quota only — no presentation is reported.
    pub(crate) fn usage(usage: Option<protocol::LlmUsage>) -> Self {
        Self {
            presentation: AgentPresentationSnapshot {
                usage,
                ..AgentPresentationSnapshot::default()
            },
            ..Self::default()
        }
    }

    pub(crate) fn presentation(presentation: AgentPresentationSnapshot) -> Self {
        Self {
            presentation,
            ..Self::default()
        }
    }

    pub(crate) fn parameters(mut self, parameters: Vec<protocol::HarnessParameter>) -> Self {
        if let Some(commands) = self.presentation.commands.as_mut() {
            crate::harness_parameters::add_commands(commands, &parameters);
        }
        self.presentation.parameters = Some(parameters);
        self
    }

    pub(crate) fn goal(mut self, goal: Option<protocol::AgentGoalStatus>) -> Self {
        self.goal = Some(goal);
        self
    }

    pub(crate) fn goal_patch(mut self, goal: Option<Option<protocol::AgentGoalStatus>>) -> Self {
        self.goal = goal;
        self
    }

    pub(crate) fn runtime_state(mut self, state: Option<protocol::AgentRuntimeState>) -> Self {
        self.runtime_state = state;
        self
    }
}

/// A presentation that reports the current model but leaves the command catalog
/// alone: the adapter only knows the docs-only subset, which must not replace a
/// live catalog a previous frame already advertised.
pub(crate) fn model_presentation(
    model: Option<String>,
    effort: Option<String>,
    usage: Option<protocol::LlmUsage>,
) -> AgentPresentationSnapshot {
    let runtime_hint = runtime_presentation_hint();
    let mut presentation = agent_presentation_adapter_for_runtime(&runtime_hint).present(
        &AgentPresentationFacts {
            model,
            effort,
            usage,
            ..AgentPresentationFacts::default()
        },
        &[],
    );
    presentation.commands = None;
    presentation
}

/// A presentation whose command catalog is derived from what the model catalog
/// itself supports.
pub(crate) fn model_catalog_presentation(
    model: Option<String>,
    models: Vec<protocol::AgentModelInfo>,
    effort: Option<String>,
    usage: Option<protocol::LlmUsage>,
) -> AgentPresentationSnapshot {
    let has_models = !models.is_empty();
    let has_efforts = models.iter().any(|item| {
        item.supported_reasoning_efforts
            .as_ref()
            .is_some_and(|entries| !entries.is_empty())
            || item.default_reasoning_effort.is_some()
    });
    let runtime_hint = runtime_presentation_hint();
    let commands = agent_commands_for_runtime(&runtime_hint, has_models, has_efforts, true);
    model_catalog_presentation_with_commands(model, models, effort, commands, usage)
}

/// A presentation that reports an explicit, live command catalog.
pub(crate) fn model_catalog_presentation_with_commands(
    model: Option<String>,
    models: Vec<protocol::AgentModelInfo>,
    effort: Option<String>,
    commands: Option<Vec<protocol::AgentInstanceCommand>>,
    usage: Option<protocol::LlmUsage>,
) -> AgentPresentationSnapshot {
    let runtime_hint = runtime_presentation_hint();
    agent_presentation_adapter_for_runtime(&runtime_hint).present(
        &AgentPresentationFacts {
            model,
            models,
            models_reported: true,
            effort,
            effort_config_id: None,
            parameters: None,
            parameter_revision: 0,
            supported_efforts: Vec::new(),
            commands: commands.unwrap_or_default(),
            status_chips: Vec::new(),
            usage,
        },
        &[],
    )
}

/// The activity line a status implies — the only place either label is spelled.
///
/// It used to be hand-written at all 48 presence call sites, and the copies had
/// already drifted: the Codex and ACP runtimes gave `busy` one label while the
/// Claude runtime gave it another. Nothing surfaced the split until two senders
/// for the same turn disagreed and the chip flipped between them every 5s.
pub(crate) fn presence_activity_for_status(status: &str) -> Option<&'static str> {
    match status {
        "busy" => Some("处理中"),
        "idle" => Some("待命"),
        _ => None,
    }
}

/// The one place a presence frame reaches the wire.
///
/// `git_branch` and `capabilities` describe the live process and its relay, not
/// anything a caller knows better, so they are read here rather than repeated
/// at every send site. A `goal` of `None` leaves the reported goal untouched;
/// `Some(None)` clears it.
pub(crate) fn send_presence(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    status: Option<&str>,
    patch: PresencePatch,
) {
    let _ = relay.send_message(presence_message(relay, status, patch));
}

pub(crate) async fn send_presence_committed(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    status: Option<&str>,
    patch: PresencePatch,
) -> error::Result<()> {
    relay
        .commit_presence(presence_message(relay, status, patch))
        .await
}

fn presence_message(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    status: Option<&str>,
    patch: PresencePatch,
) -> protocol::AgentInstanceClientMessage {
    let PresencePatch {
        presentation,
        goal,
        runtime_state,
    } = patch;
    let capabilities = relay.runtime_capabilities();
    protocol::AgentInstanceClientMessage::PresenceUpdate {
        request_id: None,
        status: status.map(ToString::to_string),
        activity: status
            .and_then(presence_activity_for_status)
            .map(ToString::to_string),
        files: None,
        intent: None,
        git_branch: std::env::current_dir()
            .ok()
            .and_then(|path| current_git_branch(&path)),
        capabilities: (!capabilities.is_empty()).then_some(capabilities),
        runtime_state: runtime_state.map(Box::new),
        goal,
        model: presentation.model,
        models: presentation.models,
        effort: presentation.effort,
        commands: presentation.commands,
        parameters: presentation.parameters,
        status_chips: presentation.status_chips,
        usage: presentation.usage.map(Box::new),
    }
}

/// Scan a directory of `name.md` / `name/SKILL.md` entries into slash tokens.
fn scan_command_tokens_from_dir(dir: &std::path::Path) -> Vec<String> {
    let mut tokens = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return tokens;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if path.is_file() {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str())
                && path
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
                    && let Some(token) = normalize_slash_command_token(stem) {
                        tokens.push(token);
                    }
        } else if path.is_dir() {
            // Skill-style: dir/SKILL.md or just dir name as command.
            let skill_md = path.join("SKILL.md");
            if skill_md.is_file()
                && let Some(token) = normalize_slash_command_token(&name) {
                    tokens.push(token);
                }
        }
    }
    tokens.sort();
    tokens.dedup();
    tokens
}

fn scan_zcode_user_command_tokens() -> Vec<String> {
    let mut tokens = Vec::new();
    if let Some(home) = dirs::home_dir() {
        tokens.extend(scan_command_tokens_from_dir(
            &home.join(".zcode").join("commands"),
        ));
    }
    if let Ok(cwd) = std::env::current_dir() {
        tokens.extend(scan_command_tokens_from_dir(
            &cwd.join(".zcode").join("commands"),
        ));
    }
    tokens.sort();
    tokens.dedup();
    tokens
}

fn scan_grok_skill_command_tokens() -> Vec<String> {
    let mut tokens = Vec::new();
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".grok").join("skills"));
        roots.push(home.join(".grok").join("bundled").join("skills"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.join(".grok").join("skills"));
        roots.push(cwd.join("skills"));
    }
    // Optional config paths from env (comma-separated).
    if let Ok(extra) = std::env::var("XMATRIX_GROK_SKILL_PATHS") {
        for part in extra.split(',') {
            let part = part.trim();
            if !part.is_empty() {
                roots.push(std::path::PathBuf::from(part));
            }
        }
    }
    for root in roots {
        tokens.extend(scan_command_tokens_from_dir(&root));
    }
    tokens.sort();
    tokens.dedup();
    tokens
}

fn slash_tokens_from_init_value(value: &Value) -> Vec<String> {
    value
        .get("slash_commands")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_str())
        .filter_map(normalize_slash_command_token)
        .collect()
}

pub(crate) fn send_agent_lifecycle(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    channel_id: Option<&str>,
    agent: &protocol::SerializedAgent,
    layer: &str,
    status: &str,
    reason: Option<&str>,
    detail: Option<&str>,
    snapshot: Option<protocol::AgentLifecycleSnapshot>,
) {
    send_agent_lifecycle_with_reset(
        relay,
        channel_id,
        agent,
        AgentLifecycleNotice {
            layer,
            status,
            reason,
            detail,
            snapshot,
            resets_at: None,
        },
    );
}

pub(crate) struct AgentLifecycleNotice<'a> {
    layer: &'a str,
    status: &'a str,
    reason: Option<&'a str>,
    detail: Option<&'a str>,
    snapshot: Option<protocol::AgentLifecycleSnapshot>,
    resets_at: Option<&'a str>,
}

/// [`send_agent_lifecycle`] for a `usage_limited` turn failure, which also
/// says when the provider account resets.
pub(crate) fn send_agent_lifecycle_with_reset(
    relay: &agent_instance_connection::AgentInstanceConnectionClient,
    channel_id: Option<&str>,
    agent: &protocol::SerializedAgent,
    notice: AgentLifecycleNotice<'_>,
) {
    let AgentLifecycleNotice {
        layer,
        status,
        reason,
        detail,
        snapshot,
        resets_at,
    } = notice;
    let _ = relay.send_message(protocol::AgentInstanceClientMessage::AgentLifecycle {
        request_id: None,
        channel_id: channel_id.map(str::to_string),
        agent_id: Some(agent.id.clone()),
        instance_id: agent.instance_id.clone(),
        agent_name: Some(agent.name.clone()),
        layer: layer.to_string(),
        status: status.to_string(),
        reason: reason.map(str::to_string),
        detail: detail.map(str::to_string),
        snapshot,
        resets_at: resets_at.map(str::to_string),
        ts: None,
    });
}

fn take_bootstrap_turn(bootstrap: &mut Option<String>) -> Option<String> {
    bootstrap.take().filter(|value| !value.trim().is_empty())
}

/// Fold the one-time bootstrap and read-only Channel history into the first
/// real runtime turn. Submitting the bootstrap as its own turn gives the model
/// a tool-capable execution window before the current assignment is visible;
/// an old mention in history can therefore be acted on despite the read-only
/// marker. Keeping both in one turn makes the current input the only live
/// assignment while preserving the same context.
fn codex_turn_with_bootstrap(bootstrap: &mut Option<String>, current_input: &str) -> String {
    let Some(bootstrap) = take_bootstrap_turn(bootstrap) else {
        return current_input.to_string();
    };
    format!(
        "{bootstrap}\n\nCurrent xMatrix input — this is the only live assignment in this turn:\n\
         {current_input}"
    )
}

fn validate_codex_app_cwd(cwd: Option<&str>) -> error::Result<()> {
    let Some(cwd) = cwd else {
        return Ok(());
    };
    let path = std::path::Path::new(cwd);
    let metadata = std::fs::metadata(path).map_err(|err| {
        CliError::Launch(format!(
            "Codex app-server cwd preflight hook failed for '{}': {err}",
            path.display()
        ))
    })?;
    if !metadata.is_dir() {
        return Err(CliError::Launch(format!(
            "Codex app-server cwd preflight hook failed for '{}': not a directory",
            path.display()
        )));
    }
    Ok(())
}

fn codex_reconnect_wait_timeout(reconnect_exhausted: bool) -> Option<Duration> {
    reconnect_exhausted.then(|| Duration::from_secs(CODEX_RECONNECT_EXHAUSTED_GRACE_SECS))
}

async fn finish_agent_disconnect<F, H>(disconnect: F, hard_disconnect: H) -> error::Result<()>
where
    F: Future<Output = error::Result<()>>,
    H: FnOnce(),
{
    match tokio::time::timeout(
        Duration::from_secs(AGENT_RELAY_DISCONNECT_TIMEOUT_SECS),
        disconnect,
    )
    .await
    {
        Ok(Ok(())) => Ok(()),
        Ok(Err(err)) => {
            eprintln!(
                "{} Agent unregister failed; closing locally: {err}",
                "⚠".yellow().bold()
            );
            hard_disconnect();
            Ok(())
        }
        Err(_) => {
            eprintln!(
                "{} Agent unregister timed out after {}s; closing locally",
                "⚠".yellow().bold(),
                AGENT_RELAY_DISCONNECT_TIMEOUT_SECS,
            );
            hard_disconnect();
            Ok(())
        }
    }
}

async fn finish_agent_relay_disconnect(
    relay: &Arc<agent_instance_connection::AgentInstanceConnectionClient>,
) -> error::Result<()> {
    finish_agent_disconnect(relay.graceful_disconnect(), || relay.disconnect()).await
}

/// Token and context counts in a harness payload; quota windows come only from
/// the provider-specific online readers.
fn extract_llm_usage(value: &Value) -> Option<protocol::LlmUsage> {
    let mut best = protocol::LlmUsage::default();
    collect_llm_usage(value, &mut best);
    if has_llm_usage(&best) {
        if best.total_tokens.is_none() {
            best.total_tokens = best
                .input_tokens
                .zip(best.output_tokens)
                .map(|(input, output)| input + output);
        }
        Some(best)
    } else {
        None
    }
}

fn collect_llm_usage(value: &Value, usage: &mut protocol::LlmUsage) {
    match value {
        Value::Object(map) => {
            set_usage_u64(
                &mut usage.input_tokens,
                first_u64(
                    map,
                    &[
                        "inputTokens",
                        "input_tokens",
                        "promptTokens",
                        "prompt_tokens",
                    ],
                ),
            );
            set_usage_u64(
                &mut usage.output_tokens,
                first_u64(
                    map,
                    &[
                        "outputTokens",
                        "output_tokens",
                        "completionTokens",
                        "completion_tokens",
                    ],
                ),
            );
            set_usage_u64(
                &mut usage.total_tokens,
                first_u64(map, &["totalTokens", "total_tokens"]),
            );
            set_usage_u64(
                &mut usage.context_used_tokens,
                first_u64(
                    map,
                    &[
                        "contextUsedTokens",
                        "context_used_tokens",
                        "contextTokens",
                        "context_tokens",
                    ],
                ),
            );
            set_usage_u64(
                &mut usage.context_window_tokens,
                first_u64(
                    map,
                    &[
                        "contextWindowTokens",
                        "context_window_tokens",
                        "contextLimitTokens",
                        "context_limit_tokens",
                        "contextWindow",
                        "context_window",
                        "contextLimit",
                        "context_limit",
                    ],
                ),
            );
            if usage.context_usage_percent.is_none() {
                usage.context_usage_percent = first_f64(
                    map,
                    &[
                        "contextUsagePercent",
                        "context_usage_percent",
                        "contextPercent",
                        "context_percent",
                        "contextUsagePct",
                        "context_usage_pct",
                        "contextPct",
                        "context_pct",
                    ],
                );
            }
            set_usage_u64(
                &mut usage.cached_input_tokens,
                first_u64(
                    map,
                    &[
                        "cachedInputTokens",
                        "cached_input_tokens",
                        "input_cached_tokens",
                        "cacheReadInputTokens",
                        "cache_read_input_tokens",
                        // ACP End-Turn Token Usage RFD
                        "cachedReadTokens",
                        "cached_read_tokens",
                    ],
                ),
            );
            set_usage_u64(
                &mut usage.cache_creation_input_tokens,
                first_u64(
                    map,
                    &[
                        "cacheCreationInputTokens",
                        "cache_creation_input_tokens",
                        // ACP End-Turn Token Usage RFD
                        "cachedWriteTokens",
                        "cached_write_tokens",
                    ],
                ),
            );
            set_usage_u64(
                &mut usage.cache_read_input_tokens,
                first_u64(
                    map,
                    &[
                        "cacheReadInputTokens",
                        "cache_read_input_tokens",
                        "cachedReadTokens",
                        "cached_read_tokens",
                    ],
                ),
            );
            set_usage_u64(
                &mut usage.reasoning_tokens,
                first_u64(
                    map,
                    &[
                        "reasoningTokens",
                        "reasoning_tokens",
                        // ACP End-Turn Token Usage RFD
                        "thoughtTokens",
                        "thought_tokens",
                    ],
                ),
            );
            set_usage_u64(
                &mut usage.tool_call_count,
                first_u64(map, &["toolCallCount", "tool_call_count"]),
            );
            if usage.cost_usd.is_none() {
                usage.cost_usd = first_f64(map, &["costUsd", "cost_usd"]);
            }
            // Session payloads may include provider rate limits. Quotas are
            // account-level data and are read only by each provider's explicit
            // online endpoint, never by this generic app-server event parser.
            if is_rate_limit_snapshot_map(map)
                || !claude_named_window_quota_usages(map).is_empty()
                || !zai_monitor_quota_usages(map).is_empty()
                || !grok_billing_quota_usages(map).is_empty()
                || !codex_wham_quota_usages(map).is_empty()
            {
                return;
            }

            for (key, child) in map {
                // Do not recursively treat rate-limit containers as token data.
                if matches!(
                    key.as_str(),
                    "quotaUsages"
                        | "quota_usages"
                        | "quotas"
                        | "quota"
                        | "rateLimits"
                        | "rate_limits"
                        | "rate_limit"
                        | "usageLimits"
                        | "usage_limits"
                        | "limits"
                ) {
                    continue;
                }
                collect_llm_usage(child, usage);
            }
        }
        Value::Array(items) => {
            for child in items {
                collect_llm_usage(child, usage);
            }
        }
        _ => {}
    }
}

fn merge_llm_usage(
    current: Option<protocol::LlmUsage>,
    next: Option<protocol::LlmUsage>,
) -> Option<protocol::LlmUsage> {
    match (current, next) {
        (None, next) => next,
        (current, None) => current,
        (Some(mut current), Some(next)) => {
            if next.input_tokens.is_some() {
                current.input_tokens = next.input_tokens;
            }
            if next.output_tokens.is_some() {
                current.output_tokens = next.output_tokens;
            }
            if next.total_tokens.is_some() {
                current.total_tokens = next.total_tokens;
            }
            if next.context_used_tokens.is_some() {
                current.context_used_tokens = next.context_used_tokens;
            }
            if next.context_window_tokens.is_some() {
                current.context_window_tokens = next.context_window_tokens;
            }
            if next.context_usage_percent.is_some() {
                current.context_usage_percent = next.context_usage_percent;
            }
            if next.quota_usages.is_some() {
                // Provider-account quota is a snapshot, not additive turn
                // telemetry. Windows, source and observation time belong to
                // the same read and must be replaced together.
                current.quota_usages = next.quota_usages;
                current.quota_source = next.quota_source;
                current.quota_observed_at = next.quota_observed_at;
                current.quota_account = next.quota_account;
            }
            if next.cached_input_tokens.is_some() {
                current.cached_input_tokens = next.cached_input_tokens;
            }
            if next.cache_creation_input_tokens.is_some() {
                current.cache_creation_input_tokens = next.cache_creation_input_tokens;
            }
            if next.cache_read_input_tokens.is_some() {
                current.cache_read_input_tokens = next.cache_read_input_tokens;
            }
            if next.reasoning_tokens.is_some() {
                current.reasoning_tokens = next.reasoning_tokens;
            }
            if next.tool_call_count.is_some() {
                current.tool_call_count = next.tool_call_count;
            }
            if next.cost_usd.is_some() {
                current.cost_usd = next.cost_usd;
            }
            Some(current)
        }
    }
}

fn set_usage_u64(target: &mut Option<u64>, value: Option<u64>) {
    if value.is_some() {
        *target = value;
    }
}

fn first_u64(map: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| map.get(*key).and_then(json_u64))
}

fn json_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|number| u64::try_from(number).ok()))
        .or_else(|| value.as_str()?.trim().parse::<u64>().ok())
}

