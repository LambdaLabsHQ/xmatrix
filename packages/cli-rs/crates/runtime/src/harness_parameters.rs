//! Common parameter grammar and validation for every execution adapter.
use crate::protocol;
use serde_json::Value;

pub(crate) fn parameter_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.starts_with(|c: char| c.is_ascii_alphabetic())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
        && (!id.to_ascii_lowercase().contains("model")
            || ["model", "models"].contains(&id.to_ascii_lowercase().as_str()))
        && ![
            "permission",
            "approv",
            "auth",
            "bypass",
            "unsafe",
            "yolo",
            "execute",
            "shell",
            "terminal",
            "spawn",
            "subagent",
            "sandbox",
            "secret",
            "credential",
            "token",
            "environment",
            "developer",
            "instruction",
            "command",
            "hook",
            "plugin",
            "mcp",
            "access",
            "network",
            "trust",
            "security",
            "system",
            "tools",
            "filesystem",
            "multiagent",
            "delegate",
            "cyber",
        ]
        .iter()
        .any(|word| id.to_ascii_lowercase().contains(word))
}

pub(crate) fn choice(
    id: &str,
    label: &str,
    options: Vec<String>,
    current: Option<String>,
) -> Option<protocol::HarnessParameter> {
    if !parameter_id(id)
        || options.is_empty()
        || options.len() > 100
        || options.iter().any(|v| {
            v.is_empty() || v.len() > 160 || v.trim() != v || v.chars().any(char::is_control)
        })
    {
        return None;
    }
    let mut seen = std::collections::HashSet::new();
    let options: Vec<_> = options
        .into_iter()
        .filter(|v| seen.insert(v.clone()))
        .collect();
    let current_value = current.filter(|v| options.contains(v));
    Some(protocol::HarnessParameter {
        id: id.into(),
        label: if label.trim().is_empty()
            || label.trim() != label
            || label.len() > 160
            || label.chars().any(char::is_control)
        {
            id.into()
        } else {
            label.into()
        },
        kind: Some(if boolean_options(&options).is_some() {
            protocol::HarnessParameterKind::Boolean
        } else {
            protocol::HarnessParameterKind::Enum
        }),
        description: None,
        category: None,
        choices: None,
        notice: None,
        alias_of: None,
        options,
        current_value,
    })
}

pub(crate) fn boolean_options(options: &[String]) -> Option<(&str, &str)> {
    if options.len() != 2 {
        return None;
    }
    let on = options
        .iter()
        .find(|v| matches!(v.to_ascii_lowercase().as_str(), "on" | "true"))?;
    let off = options
        .iter()
        .find(|v| matches!(v.to_ascii_lowercase().as_str(), "off" | "false"))?;
    Some((on, off))
}

pub(crate) fn canonical_value<'a>(
    parameter: &'a protocol::HarnessParameter,
    value: &str,
) -> Option<&'a str> {
    if let Some(value) = parameter
        .options
        .iter()
        .find(|option| option.as_str() == value)
    {
        return Some(value);
    }
    if parameter.kind == Some(protocol::HarnessParameterKind::Enum) {
        return None;
    }
    let (on, off) = boolean_options(&parameter.options)?;
    match value.to_ascii_lowercase().as_str() {
        "on" | "true" => Some(on),
        "off" | "false" => Some(off),
        _ => None,
    }
}

/// Provider display text is bounded and never becomes executable input.
pub(crate) fn metadata_text(value: Option<&Value>, max_bytes: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| {
            !text.is_empty()
                && text.len() <= max_bytes
                && text.trim() == *text
                && !text.chars().any(char::is_control)
        })
        .map(str::to_string)
}

pub(crate) fn add_choice_metadata(
    parameter: &mut protocol::HarnessParameter,
    rows: &[Value],
    value_key: &str,
    label_key: &str,
) {
    parameter.choices = Some(
        parameter
            .options
            .iter()
            .map(|value| {
                let row = rows
                    .iter()
                    .find(|row| row.get(value_key).and_then(Value::as_str) == Some(value));
                protocol::HarnessParameterChoice {
                    value: value.clone(),
                    label: metadata_text(row.and_then(|row| row.get(label_key)), 160),
                    description: metadata_text(row.and_then(|row| row.get("description")), 512),
                }
            })
            .collect(),
    );
}

/// ACP supplies a complete replacement snapshot, including future finite controls.
pub(crate) fn acp_parameters(options: &[Value]) -> Vec<protocol::HarnessParameter> {
    let mut seen = std::collections::HashSet::new();
    options
        .iter()
        .take(64)
        .filter_map(|option| {
            let kind = option
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("select");
            if !matches!(kind, "select" | "boolean") {
                return None;
            }
            let id = option.get("id")?.as_str()?;
            let category = option.get("category").and_then(Value::as_str);
            if category == Some("model") && !["model", "models"].contains(&id)
                || category == Some("thought_level")
                    && !["effort", "reasoning_effort"].contains(&id)
            {
                return None;
            }
            if !seen.insert(id.to_string()) {
                return None;
            }
            let current = option
                .get("currentValue")
                .or_else(|| option.get("current_value"));
            let rows: Vec<Value> = option
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .flat_map(|entry| {
                    entry
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|v| v.as_slice())
                        .unwrap_or_else(|| std::slice::from_ref(entry))
                })
                .take(101)
                .cloned()
                .collect();
            let (values, current) = if kind == "boolean" {
                (
                    vec!["true".into(), "false".into()],
                    current?.as_bool().map(|v| v.to_string()),
                )
            } else {
                (
                    rows.iter()
                        .filter_map(|v| v.get("value")?.as_str().map(str::to_string))
                        .collect(),
                    current.and_then(Value::as_str).map(str::to_string),
                )
            };
            let mut parameter = choice(
                id,
                option.get("name").and_then(Value::as_str).unwrap_or(id),
                values,
                current,
            )?;
            // Native select on/off ids are enums; never infer their execution shape.
            parameter.kind = Some(if kind == "boolean" {
                protocol::HarnessParameterKind::Boolean
            } else {
                protocol::HarnessParameterKind::Enum
            });
            parameter.description = metadata_text(option.get("description"), 512);
            parameter.category = category
                .filter(|v| {
                    let name = v.strip_prefix('_').unwrap_or(v);
                    !name.is_empty()
                        && name.len() <= 32
                        && name.starts_with(|c: char| c.is_ascii_lowercase())
                        && name
                            .chars()
                            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                })
                .map(str::to_string);
            if kind == "select" {
                add_choice_metadata(&mut parameter, &rows, "value", "name");
            }
            Some(parameter)
        })
        .collect()
}

/// Discover scalar choices from the installed native schema, never from a prompt or CLI help text.
/// Complex/free-form fields and authority settings are deliberately outside this protocol.
fn scalar_choice_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Bool(_) | Value::Number(_) => Some(value.to_string()),
        _ => None,
    }
}

fn scalar_type_matches(value: &Value, kind: &Value) -> bool {
    match kind {
        Value::Null => true,
        Value::Array(types) => types.iter().any(|kind| scalar_type_matches(value, kind)),
        Value::String(kind) => match kind.as_str() {
            "string" => value.is_string(),
            "boolean" => value.is_boolean(),
            "number" => value.is_number(),
            "integer" => {
                value.as_i64().is_some()
                    || value.as_u64().is_some()
                    || value.as_f64().is_some_and(|number| number.fract() == 0.0)
            }
            "null" => value.is_null(),
            _ => false,
        },
        _ => false,
    }
}

fn schema_choices(node: &Value, root: &Value, depth: usize) -> Option<Vec<Value>> {
    if depth > 8 {
        return None;
    }
    if node.get("type").and_then(Value::as_str) == Some("null") {
        return Some(Vec::new());
    }
    if let Some(reference) = node.get("$ref").and_then(Value::as_str) {
        return schema_choices(root.pointer(reference.strip_prefix('#')?)?, root, depth + 1);
    }
    if let Some(values) = node.get("enum").and_then(Value::as_array) {
        if values
            .iter()
            .any(|v| !v.is_null() && scalar_choice_text(v).is_none())
        {
            return None;
        }
        return Some(
            values
                .iter()
                .filter(|v| !v.is_null() && scalar_type_matches(v, &node["type"]))
                .cloned()
                .collect(),
        );
    }
    let kind = node.get("type");
    if kind.and_then(Value::as_str) == Some("boolean")
        || kind.and_then(Value::as_array).is_some_and(|types| {
            types.iter().all(|t| t == "boolean" || t == "null")
                && types.iter().any(|t| t == "boolean")
        })
    {
        return Some(vec![Value::Bool(true), Value::Bool(false)]);
    }
    for key in ["anyOf", "oneOf", "allOf"] {
        if let Some(branches) = node.get(key).and_then(Value::as_array) {
            let mut result: Option<Vec<Value>> = None;
            for branch in branches {
                let values = schema_choices(branch, root, depth + 1)?;
                if key == "allOf" {
                    result = Some(match result {
                        None => values,
                        Some(previous) => previous
                            .into_iter()
                            .filter(|v| values.contains(v))
                            .collect(),
                    });
                } else {
                    result.get_or_insert_default().extend(values);
                }
            }
            return result;
        }
    }
    None
}

pub(crate) fn schema_parameters(schema: &Value) -> Vec<protocol::HarnessParameter> {
    schema
        .get("properties")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .take(60)
        .filter(|(id, _)| {
            ![
                "model",
                "effort",
                "serviceTier",
                "input",
                "threadId",
                "cwd",
                "additionalContext",
            ]
            .contains(&id.as_str())
        })
        .filter_map(|(id, node)| {
            let native = schema_choices(node, schema, 0)?;
            let options: Vec<_> = native
                .iter()
                .map(scalar_choice_text)
                .collect::<Option<_>>()?;
            // Distinct native types may have the same textual spelling. Such a
            // choice cannot be selected unambiguously by the shared grammar.
            for (index, option) in options.iter().enumerate() {
                if options.iter().enumerate().any(|(other, text)| {
                    other != index && text == option && native[other] != native[index]
                }) {
                    return None;
                }
            }
            let mut parameter = choice(id, id, options, None)?;
            parameter.kind = Some(
                if parameter.options.len() == 2 && native.iter().all(Value::is_boolean) {
                    protocol::HarnessParameterKind::Boolean
                } else {
                    protocol::HarnessParameterKind::Enum
                },
            );
            parameter.description = metadata_text(node.get("description"), 512);
            Some(parameter)
        })
        .collect()
}

pub(crate) fn native_schema_value(schema: &Value, id: &str, selected: &str) -> Option<Value> {
    schema_choices(schema.get("properties")?.get(id)?, schema, 0)?
        .into_iter()
        .find(|value| scalar_choice_text(value).as_deref() == Some(selected))
}

#[derive(Default)]
pub(crate) struct CodexParameterSchemas {
    pub(crate) turn: Value,
    pub(crate) settings: Value,
    pub(crate) settings_update: bool,
}

pub(crate) fn schema_has_method(schema: &Value, method: &str) -> bool {
    schema
        .get("oneOf")
        .and_then(Value::as_array)
        .is_some_and(|variants| {
            variants.iter().any(|variant| {
                variant
                    .pointer("/properties/method/enum")
                    .and_then(Value::as_array)
                    .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(method)))
            })
        })
}

pub(crate) async fn discover_codex_parameters(cmd: &str) -> CodexParameterSchemas {
    struct ExportDirectory(std::path::PathBuf);
    impl Drop for ExportDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let directory =
        std::env::temp_dir().join(format!("xmatrix-harness-schema-{}", uuid::Uuid::new_v4()));
    if std::fs::create_dir(&directory).is_err() {
        return CodexParameterSchemas::default();
    }
    let directory = ExportDirectory(directory);
    let mut command = tokio::process::Command::new(cmd);
    command
        .args([
            "app-server",
            "generate-json-schema",
            "--experimental",
            "--out",
        ])
        .arg(&directory.0)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    if !matches!(tokio::time::timeout(std::time::Duration::from_secs(10), command.status()).await,
        Ok(Ok(status)) if status.success())
    {
        return CodexParameterSchemas::default();
    }
    let read = |name: &str| {
        let path = directory.0.join(name);
        if !std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() <= 1_048_576) {
            return Value::Null;
        }
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or(Value::Null)
    };
    CodexParameterSchemas {
        turn: read("v2/TurnStartParams.json"),
        settings: read("v2/ThreadSettingsUpdateParams.json"),
        settings_update: schema_has_method(&read("ClientRequest.json"), "thread/settings/update"),
    }
}

pub(crate) fn model_parameters(
    models: &[protocol::AgentModelInfo],
    model: Option<&str>,
    effort: Option<&str>,
) -> Vec<protocol::HarnessParameter> {
    let mut parameters = Vec::new();
    if let Some(mut value) = choice(
        "model",
        "Model",
        models.iter().map(|m| m.model.clone()).collect(),
        model.map(str::to_string),
    ) {
        value.kind = Some(protocol::HarnessParameterKind::Enum);
        value.choices = Some(
            value
                .options
                .iter()
                .map(|id| {
                    let model = models.iter().find(|m| m.model == *id);
                    protocol::HarnessParameterChoice {
                        value: id.clone(),
                        label: model.and_then(|m| m.display_name.clone()).filter(|v| {
                            !v.is_empty()
                                && v.len() <= 160
                                && v.trim() == v.as_str()
                                && !v.chars().any(char::is_control)
                        }),
                        description: model.and_then(|m| m.description.clone()).filter(|v| {
                            !v.is_empty()
                                && v.len() <= 512
                                && v.trim() == v.as_str()
                                && !v.chars().any(char::is_control)
                        }),
                    }
                })
                .collect(),
        );
        parameters.push(value);
    }
    if let Some(selected) = models.iter().find(|m| {
        model.map_or(m.is_default == Some(true), |model| {
            m.model == model || m.id == model
        })
    }) && let Some(mut value) = choice(
        "effort",
        "Reasoning effort",
        selected
            .supported_reasoning_efforts
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|v| v.reasoning_effort.clone())
            .collect(),
        effort.map(str::to_string),
    ) {
        value.kind = Some(protocol::HarnessParameterKind::Enum);
        parameters.push(value);
    }
    parameters
}

/// Provider notices belong in textual controls too, including disabled
/// switches that intentionally have no visible status chip.
pub(crate) fn parameter_status(parameter: &protocol::HarnessParameter) -> String {
    format!(
        "{}: {}; choices: {}{}",
        parameter.label,
        parameter.current_value.as_deref().unwrap_or("not reported"),
        parameter.options.join(", "),
        parameter
            .notice
            .as_deref()
            .map(|notice| format!("; {notice}"))
            .unwrap_or_default(),
    )
}

pub(crate) fn validate<'a>(
    parameters: &'a [protocol::HarnessParameter],
    id: &str,
    value: &str,
) -> Result<&'a protocol::HarnessParameter, String> {
    parameters
        .iter()
        .find(|p| p.id == id && canonical_value(p, value).is_some())
        .ok_or_else(|| format!("Harness parameter '{id}' does not support '{value}'"))
}

/// The reply to a bare parameter query: its current value and choices.
pub(crate) fn status(
    parameters: &[protocol::HarnessParameter],
    id: &str,
) -> Result<String, String> {
    parameters
        .iter()
        .find(|p| p.id == id)
        .map(parameter_status)
        .ok_or_else(|| format!("Harness parameter '{id}' is unavailable"))
}

pub(crate) fn add_commands(
    commands: &mut Vec<protocol::AgentInstanceCommand>,
    parameters: &[protocol::HarnessParameter],
) {
    commands.retain(|command| command.token != "/config" && command.token != "/fast");
    for (token, label, available) in [
        ("/config", "Configure harness", !parameters.is_empty()),
        (
            "/fast",
            "Fast mode",
            parameters.iter().any(|p| p.id == "fast"),
        ),
    ] {
        if available {
            commands.push(protocol::AgentInstanceCommand {
                token: token.into(),
                label: label.into(),
                description: Some(
                    if token == "/fast" {
                        "Toggle Fast mode, or use on, off or status"
                    } else {
                        "Choose a value advertised by this runtime"
                    }
                    .into(),
                ),
                mode: Some("typed".into()),
                argument_source: None,
                freeform: Some(true),
            });
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ParameterAction {
    Query,
    Select(String),
    Toggle,
}

pub(crate) type ParameterCommand = Result<(String, ParameterAction), String>;

/// Only an exact addressed slash control enters this grammar, never arbitrary prose.
pub(crate) fn command(text: &str) -> Option<ParameterCommand> {
    let (token, tail) = text
        .trim()
        .split_once(char::is_whitespace)
        .unwrap_or((text.trim(), ""));
    if token.eq_ignore_ascii_case("/config") {
        let (id, value) = tail
            .trim()
            .split_once(char::is_whitespace)
            .unwrap_or((tail.trim(), ""));
        return Some(if parameter_id(id) {
            Ok((
                id.into(),
                if value.trim().is_empty() {
                    ParameterAction::Query
                } else {
                    ParameterAction::Select(value.trim().to_string())
                },
            ))
        } else {
            Err("Use /config <parameter> [value]".into())
        });
    }
    if token.eq_ignore_ascii_case("/fast") {
        return Some(Ok((
            "fast".into(),
            match tail.trim().to_ascii_lowercase().as_str() {
                "" => ParameterAction::Toggle,
                "status" => ParameterAction::Query,
                "true" | "on" => ParameterAction::Select("on".into()),
                "false" | "off" => ParameterAction::Select("off".into()),
                _ => return Some(Err("Use /fast [on|off|status]".into())),
            },
        )));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parameter_status_includes_provider_notice_for_disabled_and_cooldown_switches() {
        let mut fast = choice(
            "fast",
            "Fast",
            vec!["on".into(), "off".into()],
            Some("off".into()),
        )
        .unwrap();
        fast.notice = Some("extra_usage_disabled".into());
        assert_eq!(
            status(std::slice::from_ref(&fast), "fast").unwrap(),
            "Fast: off; choices: on, off; extra_usage_disabled"
        );
        fast.current_value = Some("on".into());
        fast.notice = Some("cooldown".into());
        assert_eq!(
            status(std::slice::from_ref(&fast), "fast").unwrap(),
            "Fast: on; choices: on, off; cooldown"
        );
        fast.notice = None;
        assert_eq!(
            status(std::slice::from_ref(&fast), "fast").unwrap(),
            "Fast: on; choices: on, off"
        );
    }

    #[test]
    fn discovers_future_acp_choices_and_rejects_authority_fields() {
        let options = serde_json::json!([
            {"id":"future-speed","name":"Speed","type":"select","currentValue":"turbo","options":[{"value":"turbo"},{"value":"steady"}]},
            {"id":"sandbox","name":"Sandbox","options":[{"value":"none"}]}
        ]);
        let catalog = acp_parameters(options.as_array().unwrap());
        assert_eq!(catalog.len(), 1);
        assert!(validate(&catalog, "future-speed", "turbo").is_ok());
        assert!(validate(&catalog, "future-speed", "missing").is_err());
        assert!(acp_parameters(&[]).is_empty());
    }
    #[test]
    fn schema_discovery_is_bounded_and_excludes_free_form_and_authority_controls() {
        let schema = serde_json::json!({ "definitions": { "Speed": { "enum": ["turbo", "steady"] }, "Loop": { "$ref": "#/definitions/Loop" } },
            "properties": { "futureSpeed": { "anyOf": [{ "$ref": "#/definitions/Speed" }, { "type": "null" }] },
                "approvalPolicy": { "enum": ["never"] }, "threadId": { "enum": ["foreign"] },
                "cyberAccessProgram": { "enum": ["standard", "daybreakRed"] },
                "prompt": { "type": "string" }, "recursive": { "$ref": "#/definitions/Loop" },
                "ambiguous": { "anyOf": [{ "enum": ["known"] }, { "type": "string" }] } } });
        let parameters = schema_parameters(&schema);
        assert_eq!(parameters.len(), 1);
        assert_eq!(parameters[0].id, "futureSpeed");
        assert!(parameters[0].current_value.is_none());
    }

    #[test]
    fn control_grammar_preserves_values_and_refuses_privilege_settings() {
        assert_eq!(
            command("/fast"),
            Some(Ok(("fast".into(), ParameterAction::Toggle)))
        );
        assert_eq!(
            command("/fast status"),
            Some(Ok(("fast".into(), ParameterAction::Query)))
        );
        assert!(command("/fast maybe").unwrap().is_err());
        assert_eq!(
            command("/config speed very fast"),
            Some(Ok((
                "speed".into(),
                ParameterAction::Select("very fast".into())
            )))
        );
        assert!(command("/config approvalPolicy never").unwrap().is_err());
        assert!(command("ordinary text /config speed fast").is_none());
    }

    #[test]
    fn native_types_keep_scalar_values_and_do_not_invent_controls_for_free_or_complex_values() {
        let schema = serde_json::json!({"properties": {
            "flag":{"type":["boolean","null"]},
            "oneFlag":{"enum":[true]},
            "textEnum":{"enum":["on","off"]},
            "integerEnum":{"enum":[1,2]}, "numberEnum":{"enum":[0.5,1.5]},
            "mixedEnum":{"enum":[true,"text",2]},
            "ambiguousEnum":{"enum":[true,"true"]},
            "freeText":{"type":"string"}, "rangedNumber":{"type":"number","minimum":0,"maximum":10},
            "list":{"type":"array","items":{"enum":["a","b"]}},
            "object":{"type":"object","properties":{"value":{"enum":["a"]}}},
            "wrongType":{"type":"string","enum":[1,true]},
            "nullOnly":{"type":"null"}, "nullableEnum":{"anyOf":[{"enum":["a","b"]},{"type":"null"}]},
            "nullableFree":{"anyOf":[{"enum":["a"]},{"type":"string"}]},
            "permissions":{"enum":["full"]}
        }});
        let parameters = schema_parameters(&schema);
        assert_eq!(parameters.len(), 7);
        assert_eq!(
            parameters.iter().find(|p| p.id == "flag").unwrap().kind,
            Some(protocol::HarnessParameterKind::Boolean)
        );
        for id in [
            "oneFlag",
            "textEnum",
            "integerEnum",
            "numberEnum",
            "mixedEnum",
            "nullableEnum",
        ] {
            assert_eq!(
                parameters.iter().find(|p| p.id == id).unwrap().kind,
                Some(protocol::HarnessParameterKind::Enum)
            );
        }
        assert_eq!(
            native_schema_value(&schema, "integerEnum", "2"),
            Some(serde_json::json!(2))
        );
        assert_eq!(
            native_schema_value(&schema, "numberEnum", "0.5"),
            Some(serde_json::json!(0.5))
        );
        assert_eq!(
            native_schema_value(&schema, "mixedEnum", "true"),
            Some(serde_json::json!(true))
        );
        assert_eq!(
            native_schema_value(&schema, "textEnum", "on"),
            Some(serde_json::json!("on"))
        );
        assert_eq!(
            native_schema_value(&schema, "flag", "false"),
            Some(serde_json::json!(false))
        );
        assert!(parameters.iter().all(|p| {
            ![
                "freeText",
                "rangedNumber",
                "list",
                "object",
                "nullOnly",
                "nullableFree",
                "permissions",
                "ambiguousEnum",
            ]
            .contains(&p.id.as_str())
        }));
        assert!(schema_has_method(
            &serde_json::json!({"oneOf":[{"properties":{"method":{"enum":["thread/settings/update"]}}}]}),
            "thread/settings/update"
        ));
        assert!(!schema_has_method(&Value::Null, "thread/settings/update"));
    }
}
