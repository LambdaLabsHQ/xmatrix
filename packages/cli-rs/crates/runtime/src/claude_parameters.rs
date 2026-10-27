//! Verified Claude stream bindings. Only native initialize facts are published.
use crate::{harness_parameters::choice, protocol};
use serde_json::{Value, json};

#[derive(Clone, Default)]
pub(crate) struct Facts {
    pub models: Option<Vec<protocol::AgentModelInfo>>,
    pub parameters: Vec<protocol::HarnessParameter>,
    pub(crate) fast_disabled_reason: Option<String>,
    pub(crate) fast_state: Option<String>,
}

pub(crate) fn initialize_request(id: &str) -> Value {
    json!({"type":"control_request", "request_id":id, "request":{"subtype":"initialize"}})
}

pub(crate) fn settings_request(
    id: &str,
    values: &std::collections::BTreeMap<String, String>,
) -> Value {
    let settings: serde_json::Map<String, Value> = values
        .iter()
        .filter_map(|(id, value)| match (id.as_str(), value.as_str()) {
            ("fast", "on" | "off") => Some(("fastMode".into(), Value::Bool(value == "on"))),
            ("outputStyle", _) => Some((id.clone(), Value::String(value.clone()))),
            _ => None,
        })
        .collect();
    json!({"type":"control_request", "request_id":id,
        "request":{"subtype":"apply_flag_settings", "settings":settings}})
}

/// Native effort hints distinguish workflow modes (`name [on|off]`) from
/// ordinary per-model levels and `auto`. Only that finite, replayable mode
/// grammar supplements model rows; option names are provider data.
fn effort_workflow_modes(value: &Value) -> Vec<String> {
    let Some(hint) = value
        .get("commands")
        .and_then(Value::as_array)
        .filter(|commands| commands.len() <= 1000)
        .and_then(|commands| {
            commands.iter().find(|command| {
                command.get("name").and_then(Value::as_str) == Some("effort")
                    && command.get("builtin").and_then(Value::as_bool) == Some(true)
            })
        })
        .and_then(|command| command.get("argumentHint"))
        .and_then(Value::as_str)
        .filter(|hint| hint.len() <= 4096)
        .and_then(|hint| hint.strip_prefix('<')?.strip_suffix('>'))
    else {
        return Vec::new();
    };
    let mut depth = 0_usize;
    hint.split(|c| match c {
        '[' => {
            depth += 1;
            false
        }
        ']' => {
            depth = depth.saturating_sub(1);
            false
        }
        '|' => depth == 0,
        _ => false,
    })
    .filter_map(|branch| branch.trim().strip_suffix(" [on|off]"))
    .filter(|name| {
        !name.is_empty()
            && name.len() <= 64
            && name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
    })
    .map(str::to_string)
    .collect()
}

pub(crate) fn initialize_facts(value: &Value, model: Option<&str>) -> Facts {
    let workflow_modes = effort_workflow_modes(value);
    let rows = value.get("models").and_then(Value::as_array);
    let models = rows.filter(|rows| rows.len() <= 100).map(|rows| {
        rows.iter()
            .filter_map(|row| {
                let id = row.get("value")?.as_str()?;
                choice("model", "Model", vec![id.into()], None)?;
                Some(protocol::AgentModelInfo {
                    id: id.into(),
                    model: row
                        .get("resolvedModel")
                        .and_then(Value::as_str)
                        .unwrap_or(id)
                        .into(),
                    display_name: Some(
                        row.get("displayName")
                            .and_then(Value::as_str)
                            .unwrap_or(id)
                            .chars()
                            .take(160)
                            .collect(),
                    ),
                    hidden: None,
                    is_default: Some(id == "default"),
                    default_reasoning_effort: None,
                    input_modalities: None,
                    supports_personality: None,
                    upgrade: None,
                    description: None,
                    supported_reasoning_efforts: row
                        .get("supportedEffortLevels")
                        .and_then(Value::as_array)
                        .and_then(|values| {
                            let mut options: Vec<_> = values
                                .iter()
                                .filter_map(|v| v.as_str().map(str::to_string))
                                .collect();
                            if options.is_empty() {
                                return None;
                            }
                            options.extend(workflow_modes.iter().cloned());
                            choice("effort", "Effort", options, None)
                        })
                        .map(|p| {
                            p.options
                                .into_iter()
                                .map(|reasoning_effort| protocol::AgentModelReasoningEffort {
                                    reasoning_effort,
                                    description: None,
                                })
                                .collect()
                        }),
                })
            })
            .collect()
    });
    let selected = rows.and_then(|rows| {
        rows.iter().find(|row| match model {
            Some(model) => {
                row.get("value").and_then(Value::as_str) == Some(model)
                    || row.get("resolvedModel").and_then(Value::as_str) == Some(model)
            }
            None => row.get("value").and_then(Value::as_str) == Some("default"),
        })
    });
    let mut parameters = Vec::new();
    if value
        .get("fast_mode_state")
        .and_then(Value::as_str)
        .is_some()
        && selected
            .and_then(|row| row.get("supportsFastMode"))
            .and_then(Value::as_bool)
            == Some(true)
        && let Some(mut p) = choice(
            "fast",
            "Fast",
            vec!["on".into(), "off".into()],
            value
                .get("fast_mode_state")
                .and_then(Value::as_str)
                .map(|state| if state == "cooldown" { "on" } else { state }.to_string()),
        )
    {
        p.notice = if value.get("fast_mode_state").and_then(Value::as_str) == Some("cooldown") {
            Some("cooldown".into())
        } else {
            crate::harness_parameters::metadata_text(value.get("fast_mode_disabled_reason"), 160)
        };
        parameters.push(p);
    }
    if let Some(mut p) = value
        .get("available_output_styles")
        .and_then(Value::as_array)
        .and_then(|styles| {
            choice(
                "outputStyle",
                "Output style",
                styles
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect(),
                value
                    .get("output_style")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            )
        })
    {
        p.kind = Some(protocol::HarnessParameterKind::Enum);
        parameters.push(p);
    }
    Facts {
        models,
        parameters,
        fast_state: value
            .get("fast_mode_state")
            .and_then(Value::as_str)
            .filter(|v| matches!(*v, "on" | "off" | "cooldown"))
            .map(str::to_string),
        fast_disabled_reason: value
            .get("fast_mode_disabled_reason")
            .and_then(Value::as_str)
            .map(|v| v.chars().take(160).collect()),
    }
}
