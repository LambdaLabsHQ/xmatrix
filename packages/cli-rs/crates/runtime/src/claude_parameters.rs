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

/// The scope of Claude's per-model quota windows a model spends: the family
/// word its display name starts with ("Fable 5.2" → "Fable"), as the usage
/// endpoint names it in `scope.model.display_name`.
fn claude_quota_scope(display_name: &str) -> Option<String> {
    display_name
        .split_whitespace()
        .next()
        .map(|family| family.chars().take(64).collect())
}

pub(crate) fn initialize_facts(value: &Value, model: Option<&str>) -> Facts {
    let workflow_modes = effort_workflow_modes(value);
    let rows = value.get("models").and_then(Value::as_array);
    let models = rows.filter(|rows| rows.len() <= 100).map(|rows| {
        let mut models: Vec<protocol::AgentModelInfo> = rows
            .iter()
            .filter_map(|row| {
                let id = row.get("value")?.as_str()?;
                choice("model", "Model", vec![id.into()], None)?;
                Some(protocol::AgentModelInfo {
                    quota_scopes: (id != "default")
                        .then(|| row.get("displayName").and_then(Value::as_str))
                        .flatten()
                        .and_then(claude_quota_scope)
                        .map(|scope| vec![scope]),
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
            .collect();
        // "Default (recommended)" names no family: the default row spends the
        // quota of the model it resolves to.
        let default_scopes = models.iter().find(|row| row.id == "default").and_then(|default| {
            models
                .iter()
                .find(|row| row.id != "default" && row.model == default.model)
                .and_then(|row| row.quota_scopes.clone())
        });
        if let Some(default) = models.iter_mut().find(|row| row.id == "default") {
            default.quota_scopes = default_scopes;
        }
        models
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_model_row_carries_the_family_its_quota_is_scoped_to() {
        let models = initialize_facts(
            &json!({ "models": [
                { "value": "default", "displayName": "Default (recommended)",
                  "resolvedModel": "claude-fable-5-2" },
                { "value": "claude-fable-5-2", "displayName": "Fable 5.2" },
                { "value": "opus", "displayName": "Opus 4.8", "resolvedModel": "claude-opus-4-8" },
                { "value": "haiku" }
            ]}),
            None,
        )
        .models
        .unwrap();
        let scopes: Vec<_> = models
            .iter()
            .map(|row| (row.id.as_str(), row.quota_scopes.clone()))
            .collect();
        assert_eq!(
            scopes,
            vec![
                ("default", Some(vec!["Fable".to_string()])),
                ("claude-fable-5-2", Some(vec!["Fable".to_string()])),
                ("opus", Some(vec!["Opus".to_string()])),
                ("haiku", None),
            ]
        );
    }

    #[test]
    fn a_default_that_resolves_to_no_listed_row_has_no_scope() {
        let models = initialize_facts(
            &json!({ "models": [
                { "value": "default", "displayName": "Default (recommended)",
                  "resolvedModel": "claude-opus-5" },
                { "value": "sonnet", "displayName": "Sonnet 5" }
            ]}),
            None,
        )
        .models
        .unwrap();
        assert_eq!(models[0].quota_scopes, None);
        assert_eq!(models[1].quota_scopes, Some(vec!["Sonnet".to_string()]));
    }
}
