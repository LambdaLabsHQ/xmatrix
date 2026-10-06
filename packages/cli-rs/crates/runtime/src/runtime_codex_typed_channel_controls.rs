/// The model and reasoning-effort commands are xMatrix typed controls. They
/// must not reach Codex as prompt text: the app-server only applies those
/// values when they are sent as `turn/start` parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
enum CodexTypedChannelCommand {
    Model { model: String },
    Effort { effort: String },
}

fn parse_codex_typed_channel_command(command: &str) -> Option<CodexTypedChannelCommand> {
    let command = command.trim();
    let (token, argument) = match command.split_once(char::is_whitespace) {
        Some((token, argument)) => (token, argument.trim()),
        None => (command, ""),
    };
    match xmatrix_cli_core::message_interaction::runtime_control_operation(token) {
        Some("model") => Some(CodexTypedChannelCommand::Model {
            model: argument.to_string(),
        }),
        Some("effort") => Some(CodexTypedChannelCommand::Effort {
            effort: argument.to_string(),
        }),
        _ => None,
    }
}

fn apply_codex_typed_channel_command(
    command: CodexTypedChannelCommand,
    available_models: &[protocol::AgentModelInfo],
    latest_model: &mut Option<String>,
    latest_effort: &mut Option<String>,
    app: &mut CodexAppSession,
) -> bool {
    let detail = match command {
        CodexTypedChannelCommand::Model { model } => {
            let requested = clean_run_model(&model);
            let selected = requested.as_deref().and_then(|requested| {
                available_models
                    .iter()
                    .find(|candidate| {
                        candidate.id.eq_ignore_ascii_case(requested)
                            || candidate.model.eq_ignore_ascii_case(requested)
                    })
                    .map(|candidate| candidate.model.clone())
            });
            if let Some(selected) = selected {
                if latest_model.as_deref() != Some(selected.as_str()) {
                    app.clear_model_parameters();
                }
                app.current_model = Some(selected.clone());
                *latest_model = Some(selected.clone());
                *latest_effort = codex_default_effort_for_model(available_models, Some(&selected));
                app.current_effort = latest_effort.clone();
                write_current_run_model(Some(&selected));
                write_current_run_effort(latest_effort.as_deref());
                write_current_run_status("model_selected", false, Some(&selected));
                None
            } else if requested.is_none() {
                Some("A Codex model is required".to_string())
            } else if available_models.is_empty() {
                Some("Codex model catalog is unavailable".to_string())
            } else {
                Some(format!("Model '{}' is not available", model.trim()))
            }
        }
        CodexTypedChannelCommand::Effort { effort } => {
            let requested = clean_run_effort(&effort);
            let options = codex_effort_options_for_model(available_models, latest_model.as_deref());
            let selected = requested.as_deref().and_then(|requested| {
                options
                    .iter()
                    .find(|candidate| candidate.eq_ignore_ascii_case(requested))
                    .cloned()
            });
            if let Some(selected) = selected {
                *latest_effort = Some(selected.clone());
                app.current_effort = Some(selected.clone());
                write_current_run_effort(Some(&selected));
                write_current_run_status("effort_selected", false, Some(&selected));
                None
            } else if requested.is_none() {
                Some("A Codex reasoning effort is required".to_string())
            } else if options.is_empty() {
                Some("Codex effort catalog is unavailable for the current model".to_string())
            } else {
                Some(format!("Effort '{}' is not available", effort.trim()))
            }
        }
    };
    let Some(detail) = detail else {
        return true;
    };
    eprintln!("{} {detail}", "⚠".yellow().bold());
    write_current_run_status("typed_control_failed", false, Some(&detail));
    false
}
