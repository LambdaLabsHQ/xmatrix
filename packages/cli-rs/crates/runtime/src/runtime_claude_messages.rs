// Decoding Claude's stream messages: assistant text, tool use, and the
// questionnaire blocks that become channel messages.

/// Compact, human-meaningful subset of the Claude `system`/`init` payload.
///
/// The raw init event dumps the entire session configuration (every tool, MCP
/// server, slash command, skill, memory path, ...) which floods the trace with
/// noise. Keep only the fields that help someone understand which session
/// started.
use serde_json::Value;

use crate::runtime_claude_stream_io::ClaudeStreamTraceState;

pub(crate) fn claude_init_details(value: &Value) -> Value {
    let mut details = serde_json::Map::new();
    for key in [
        "model",
        "cwd",
        "session_id",
        "permissionMode",
        "output_style",
    ] {
        if let Some(field) = value.get(key)
            && !field.is_null()
        {
            details.insert(key.to_string(), field.clone());
        }
    }
    if let Some(tools) = value.get("tools").and_then(Value::as_array) {
        details.insert("toolCount".to_string(), Value::from(tools.len()));
    }
    if let Some(servers) = value.get("mcp_servers").and_then(Value::as_array) {
        details.insert("mcpServerCount".to_string(), Value::from(servers.len()));
    }
    Value::Object(details)
}

/// Whether a stream-json frame belongs to a subagent (Agent/Task tool) rather
/// than to the main conversation. Claude Code stamps `assistant`/`user` frames
/// with `parent_tool_use_id`: `null` on the main thread, the spawning Agent
/// tool_use id on a subagent's own frames (2.1.280, observed for a background
/// subagent). A subagent's narration is internal to that subagent: it is never
/// the channel turn's answer, output, or failure.
pub(crate) fn claude_frame_is_subagent(value: &Value) -> bool {
    value
        .get("parent_tool_use_id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.trim().is_empty())
}

pub(crate) fn claude_message_content_blocks(value: &Value) -> Vec<&Value> {
    value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .map(|content| content.iter().collect())
        .unwrap_or_default()
}

pub(crate) fn claude_message_id(value: &Value) -> Option<String> {
    value
        .get("message")
        .and_then(|message| message.get("id"))
        .or_else(|| value.get("message_id"))
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(ToString::to_string)
}

pub(crate) fn claude_assistant_text(value: &Value) -> String {
    claude_message_content_blocks(value)
        .into_iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

pub(crate) fn claude_tool_use_blocks(value: &Value) -> Vec<Value> {
    claude_message_content_blocks(value)
        .into_iter()
        .filter(|block| claude_is_tool_use_block(block))
        .cloned()
        .collect()
}

pub(crate) fn claude_questionnaire_channel_message(
    tool: &Value,
    key: &str,
) -> Option<(String, Value)> {
    let name = claude_tool_name(tool)?;
    if !name.eq_ignore_ascii_case("AskUserQuestion") {
        return None;
    }
    let input = tool
        .get("input")
        .or_else(|| tool.get("arguments"))
        .or_else(|| tool.get("args"))
        .unwrap_or(&Value::Null);
    let questions = claude_questionnaire_questions(input);
    if questions.is_empty() {
        return None;
    }
    let selection_mode = if questions.iter().any(|question| {
        question
            .get("selectionMode")
            .and_then(Value::as_str)
            .is_some_and(|mode| mode == "multiple")
    }) {
        "multiple"
    } else {
        "single"
    };
    let first_question = questions
        .first()
        .and_then(|question| question.get("label"))
        .and_then(Value::as_str)
        .unwrap_or("Claude needs input");
    let body = claude_questionnaire_body(first_question, &questions);
    let metadata = serde_json::json!({
        "kind": "xmatrix.questionnaire.v1",
        "source": "claude_code",
        "toolName": name,
        "toolUseId": key,
        "selectionMode": selection_mode,
        "questions": questions,
        "raw": tool,
    });
    Some((body, metadata))
}

pub(crate) fn claude_tool_name(tool: &Value) -> Option<String> {
    tool.get("name")
        .or_else(|| tool.get("toolName"))
        .or_else(|| tool.get("tool_name"))
        .or_else(|| tool.get("tool"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string())
}

pub(crate) fn claude_questionnaire_questions(input: &Value) -> Vec<Value> {
    let Some(items) = input
        .get("questions")
        .or_else(|| input.get("items"))
        .or_else(|| input.get("fields"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };

    items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let label = item
                .get("question")
                .or_else(|| item.get("prompt"))
                .or_else(|| item.get("label"))
                .or_else(|| item.get("title"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())?;
            let selection_mode = if claude_questionnaire_allows_multiple(item) {
                "multiple"
            } else {
                "single"
            };
            Some(serde_json::json!({
                "id": item
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(ToString::to_string)
                    .unwrap_or_else(|| format!("q{}", index + 1)),
                "label": label.trim(),
                "selectionMode": selection_mode,
                "options": claude_questionnaire_options(item),
            }))
        })
        .collect()
}

pub(crate) fn claude_questionnaire_allows_multiple(item: &Value) -> bool {
    if item.get("multiple").and_then(Value::as_bool) == Some(true)
        || item.get("multiSelect").and_then(Value::as_bool) == Some(true)
        || item.get("multipleChoice").and_then(Value::as_bool) == Some(true)
    {
        return true;
    }
    if item
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|value| value.to_ascii_lowercase().contains("multi"))
    {
        return true;
    }
    item.get("maxSelections")
        .or_else(|| item.get("max_choices"))
        .and_then(Value::as_u64)
        .is_some_and(|value| value > 1)
}

pub(crate) fn claude_questionnaire_options(item: &Value) -> Vec<Value> {
    item.get("options")
        .or_else(|| item.get("choices"))
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .enumerate()
                .filter_map(|(index, option)| claude_questionnaire_option(option, index))
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn claude_questionnaire_option(option: &Value, index: usize) -> Option<Value> {
    if let Some(label) = option.as_str().filter(|value| !value.trim().is_empty()) {
        return Some(serde_json::json!({
            "id": format!("o{}", index + 1),
            "label": label.trim(),
            "value": label.trim(),
        }));
    }
    let label = option
        .get("label")
        .or_else(|| option.get("text"))
        .or_else(|| option.get("title"))
        .or_else(|| option.get("value"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())?;
    Some(serde_json::json!({
        "id": option
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("o{}", index + 1)),
        "label": label.trim(),
        "value": option
            .get("value")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(label)
            .trim(),
        "description": option
            .get("description")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::trim),
    }))
}

pub(crate) fn claude_questionnaire_body(first_question: &str, questions: &[Value]) -> String {
    let mut lines = vec![format!("Claude asks: {first_question}")];
    if let Some(options) = questions
        .first()
        .and_then(|question| question.get("options"))
        .and_then(Value::as_array)
        .filter(|options| !options.is_empty())
    {
        for (index, option) in options.iter().enumerate() {
            if let Some(label) = option.get("label").and_then(Value::as_str) {
                lines.push(format!("{}. {label}", index + 1));
            }
        }
    }
    lines.join("\n")
}

pub(crate) fn claude_is_tool_use_block(block: &Value) -> bool {
    match block.get("type").and_then(Value::as_str) {
        Some("tool_use") | Some("tool_call") | Some("server_tool_use") => return true,
        Some("text") | Some("tool_result") => return false,
        _ => {}
    }

    let name = block
        .get("name")
        .or_else(|| block.get("toolName"))
        .or_else(|| block.get("tool_name"))
        .or_else(|| block.get("tool"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let has_call_id = block
        .get("id")
        .or_else(|| block.get("call_id"))
        .or_else(|| block.get("callId"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let has_input = block
        .get("input")
        .or_else(|| block.get("arguments"))
        .or_else(|| block.get("args"))
        .is_some_and(|value| !value.is_null());

    name.is_some() && (has_call_id || has_input)
}

pub(crate) fn claude_tool_result_blocks(value: &Value) -> Vec<Value> {
    claude_message_content_blocks(value)
        .into_iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
        .cloned()
        .collect()
}

pub(crate) fn claude_tool_item_key(item: &Value) -> String {
    item.get("id")
        .or_else(|| item.get("call_id"))
        .or_else(|| item.get("callId"))
        .or_else(|| item.get("tool_use_id"))
        .or_else(|| item.get("name"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| item.to_string())
}

pub(crate) fn claude_assistant_delta_for_message(
    state: &mut ClaudeStreamTraceState,
    message_id: Option<&str>,
    text: &str,
) -> String {
    if text.is_empty() {
        return String::new();
    }
    let new_message = message_id
        .filter(|id| !id.trim().is_empty())
        .is_some_and(|id| state.last_message_id.as_deref() != Some(id));
    if new_message {
        state.current_message_text.clear();
    }
    if let Some(id) = message_id.filter(|id| !id.trim().is_empty()) {
        state.last_message_id = Some(id.to_string());
    }

    let delta = if text.starts_with(state.current_message_text.as_str()) {
        text[state.current_message_text.len()..].to_string()
    } else {
        text.to_string()
    };
    if delta.is_empty() {
        return String::new();
    }

    state.current_message_text = text.to_string();
    let separator = if new_message && !state.visible_assistant_text.is_empty() {
        if state.visible_assistant_text.ends_with('\n') || delta.starts_with('\n') {
            "\n"
        } else {
            "\n\n"
        }
    } else {
        ""
    };
    state.visible_assistant_text.push_str(separator);
    state.visible_assistant_text.push_str(&delta);
    format!("{separator}{delta}")
}

/// The `runtime_event` payload for a Claude stream event that tells a watcher
/// why the agent is slow or stuck, or `None` for everything else. Shapes follow
/// `@anthropic-ai/claude-agent-sdk` 0.3.281 (`SDKAPIRetryMessage`,
/// `SDKRateLimitEvent`).
///
/// - `system/api_retry` becomes `connection/retrying`, which the trace stream
///   renders as one "Connection reconnecting" section that the next event
///   resolves. A first-byte timeout can wait minutes without other output.
/// - `rate_limit_event` arrives on every turn with `status: "allowed"`; only a
///   warning or a rejection is worth showing.
pub(crate) fn claude_runtime_notice_payload(value: &Value) -> Option<Value> {
    let event_type = value.get("type").and_then(Value::as_str);
    let subtype = value.get("subtype").and_then(Value::as_str);
    if event_type == Some("system") && subtype == Some("api_retry") {
        let attempt = value.get("attempt").and_then(Value::as_u64).unwrap_or(0);
        let max_retries = value
            .get("max_retries")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let delay_secs = value
            .get("retry_delay_ms")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .div_ceil(1000);
        let cause = match value.get("no_response") {
            Some(no_response) => format!(
                "no response from the Claude API after {}s",
                no_response
                    .get("waited_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    / 1000
            ),
            None => {
                let error = value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                match value.get("error_status").and_then(Value::as_u64) {
                    Some(status) => format!("Claude API error {status} ({error})"),
                    None => format!("Claude API error ({error})"),
                }
            }
        };
        let message = format!("{cause}; retry {attempt}/{max_retries} in {delay_secs}s");
        return Some(serde_json::json!({
            "category": "connection",
            "status": "retrying",
            "summary": format!("connection retrying: {message}"),
            "message": message,
            "runtimeMethod": "system/api_retry",
        }));
    }
    if event_type != Some("rate_limit_event") {
        return None;
    }
    let info = value.get("rate_limit_info")?;
    let status = info.get("status").and_then(Value::as_str)?;
    let (category, trace_status, verb) = match status {
        "allowed_warning" => ("quota", "warning", "is nearly used up"),
        "rejected" => ("error", "failed", "is used up"),
        _ => return None,
    };
    let window = info
        .get("rateLimitType")
        .and_then(Value::as_str)
        .unwrap_or("usage");
    let mut message = format!("Claude {window} limit {verb}");
    if let Some(percent) = info.get("utilization").and_then(Value::as_f64) {
        // `utilization` is a 0..1 fraction.
        message.push_str(&format!(" ({:.0}% used)", percent * 100.0));
    }
    if let Some(resets_at) = xmatrix_harness::quota::claude::claude_resets_at(info) {
        message.push_str(&format!("; resets {resets_at}"));
    }
    Some(serde_json::json!({
        "category": category,
        "status": trace_status,
        "summary": message,
        "message": message,
        "runtimeMethod": "rate_limit_event",
        "details": info,
    }))
}
