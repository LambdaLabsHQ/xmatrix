fn codex_primary_output_phase() -> String {
    ["fin", "al_answer"].concat()
}

fn codex_is_primary_output_phase(phase: Option<&str>) -> bool {
    phase
        .map(|value| value == codex_primary_output_phase())
        .unwrap_or(true)
}

fn codex_thread_agent_message_text(item: &Value) -> Option<String> {
    item.get("text")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn codex_response_item_id(value: &Value) -> Option<String> {
    value
        .get("itemId")
        .or_else(|| value.get("item_id"))
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("item")
                .and_then(|item| item.get("id"))
                .and_then(Value::as_str)
        })
        .filter(|id| !id.trim().is_empty())
        .map(ToString::to_string)
}

fn codex_raw_response_delta_text(value: &Value) -> Option<String> {
    for key in ["delta", "text", "content", "message", "value"] {
        if let Some(text) = value.get(key).and_then(codex_response_text_value)
            && !text.trim().is_empty() {
                return Some(text);
            }
    }

    if let Some(item) = value.get("item") {
        if let Some((text, _phase)) = codex_raw_response_message_text(item) {
            return Some(text);
        }
        if let Some(text) = codex_response_text_value(item)
            && !text.trim().is_empty() {
                return Some(text);
            }
    }

    None
}

fn codex_response_text_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(codex_response_text_value)
                .collect::<String>();
            (!text.trim().is_empty()).then_some(text)
        }
        Value::Object(map) => {
            for key in ["text", "delta", "content", "message", "value"] {
                if let Some(text) = map.get(key).and_then(codex_response_text_value)
                    && !text.trim().is_empty() {
                        return Some(text);
                    }
            }
            None
        }
        _ => None,
    }
}

fn codex_raw_response_message_text(item: &Value) -> Option<(String, Option<String>)> {
    if item.get("type").and_then(Value::as_str) != Some("message") {
        return None;
    }
    if item.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }

    let mut text = String::new();
    for content in item.get("content").and_then(Value::as_array)? {
        if content.get("type").and_then(Value::as_str) == Some("output_text")
            && let Some(part) = content.get("text").and_then(Value::as_str) {
                text.push_str(part);
            }
    }

    if text.trim().is_empty() {
        return None;
    }

    let phase = item
        .get("phase")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    Some((text, phase))
}

fn codex_app_event_matches_active_turn(
    params: &Value,
    thread_id: &str,
    turn_id: Option<&str>,
) -> bool {
    let event_turn_id = codex_app_event_turn_id(params);
    // A turn id is the strongest scope. A resumed Codex thread can report a
    // redirected thread id while continuing the exact turn returned by
    // `turn/start`; rejecting those events drops every tool trace and leaves the
    // wrapper waiting forever for a completion it already received.
    if let (Some(expected), Some(actual)) = (turn_id, event_turn_id) {
        return actual == expected;
    }

    params.get("threadId").and_then(Value::as_str) == Some(thread_id)
}

fn codex_app_event_turn_id(params: &Value) -> Option<&str> {
    params.get("turnId").and_then(Value::as_str).or_else(|| {
        params
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
    })
}

#[cfg(test)]
fn codex_thread_status_type(params: &Value) -> Option<&str> {
    params
        .get("status")
        .and_then(|status| status.get("type"))
        .and_then(Value::as_str)
}

#[cfg(test)]
fn codex_thread_response_status_type(response: &Value) -> Option<&str> {
    response
        .get("thread")
        .and_then(|thread| thread.get("status"))
        .and_then(|status| status.get("type"))
        .and_then(Value::as_str)
}

#[cfg(test)]
fn codex_thread_should_finish_after_completion(response: &Value) -> bool {
    codex_thread_response_status_type(response) == Some("idle")
}

fn codex_active_turn_id_from_events<'a, I>(events: I, thread_id: &str) -> Option<String>
where
    I: IntoIterator<Item = &'a Value>,
{
    let mut active_turn_id = None;
    for event in events {
        let params = event.get("params").unwrap_or(&Value::Null);
        if params.get("threadId").and_then(Value::as_str) != Some(thread_id) {
            continue;
        }
        let event_turn_id = codex_app_event_turn_id(params);
        match event.get("method").and_then(Value::as_str) {
            Some("turn/started") => active_turn_id = event_turn_id.map(ToString::to_string),
            Some("turn/completed")
                if event_turn_id == active_turn_id.as_deref() || event_turn_id.is_none() =>
            {
                active_turn_id = None;
            }
            _ => {}
        }
    }
    active_turn_id
}

fn should_publish_codex_runtime_trace(method: &str, params: &Value) -> bool {
    if method == "item/agentMessage/delta" {
        return false;
    }
    let item = params.get("item").unwrap_or(params);
    if codex_is_assistant_message_trace_item(item) {
        return false;
    }
    if method.starts_with("rawResponseItem/") {
        if codex_raw_response_delta_text(params).is_some() && !codex_is_tool_trace_item(item) {
            return false;
        }
        return true;
    }
    if method.starts_with("item/")
        || method.starts_with("turn/")
        || method.starts_with("thread/")
        || method == "error"
    {
        return true;
    }
    params.get("item").is_some() || !codex_runtime_category(method, item).eq("unknown")
}

async fn send_codex_runtime_trace(
    relay: Option<&Arc<agent_instance_connection::AgentInstanceConnectionClient>>,
    channel_id: Option<&str>,
    agent: &protocol::SerializedAgent,
    thread_id: &str,
    turn_id: Option<&str>,
    method: &str,
    params: &Value,
) {
    if let (Some(relay), Some(channel_id)) = (relay, channel_id) {
        send_llm_trace(
            relay,
            channel_id,
            "runtime_event",
            agent,
            None,
            None,
            codex_runtime_trace_payload(method, params, thread_id, turn_id),
        )
        .await;
    }
}

fn codex_runtime_trace_payload(
    method: &str,
    params: &Value,
    thread_id: &str,
    turn_id: Option<&str>,
) -> Value {
    let item = params.get("item").unwrap_or(params);
    let error_message = (method == "error").then(|| codex_app_error_message(params));
    let (category, status, summary) = match error_message.as_deref() {
        Some(message) => {
            let brief = truncate_chars(message, CODEX_RUNTIME_TRACE_SUMMARY_LIMIT);
            if codex_app_error_is_transient_transport(message) {
                (
                    "connection",
                    "retrying",
                    format!("connection retrying: {brief}"),
                )
            } else {
                ("error", "failed", format!("error failed: {brief}"))
            }
        }
        None => {
            let category = codex_runtime_category(method, item);
            let status = codex_runtime_status(method, item);
            let summary = codex_runtime_summary(method, item, category, status);
            (category, status, summary)
        }
    };
    let details = codex_runtime_details(method, params, item);
    let raw_preview = codex_runtime_raw_preview(params, category);

    let mut payload = serde_json::Map::new();
    payload.insert("threadId".to_string(), Value::String(thread_id.to_string()));
    if let Some(turn_id) = turn_id {
        payload.insert("turnId".to_string(), Value::String(turn_id.to_string()));
    }
    payload.insert(
        "runtimeMethod".to_string(),
        Value::String(method.to_string()),
    );
    payload.insert("category".to_string(), Value::String(category.to_string()));
    payload.insert("status".to_string(), Value::String(status.to_string()));
    payload.insert("summary".to_string(), Value::String(summary));
    if let Some(message) = error_message {
        payload.insert("message".to_string(), Value::String(message));
    }
    if let Some(item_id) = codex_response_item_id(params) {
        payload.insert("itemId".to_string(), Value::String(item_id));
    }
    if let Some(item_type) = item.get("type").and_then(Value::as_str) {
        payload.insert("itemType".to_string(), Value::String(item_type.to_string()));
    }
    if let Some(tool_name) = codex_runtime_tool_name(item) {
        payload.insert("toolName".to_string(), Value::String(tool_name));
    }
    if let Some(details) = details {
        payload.insert("details".to_string(), details);
    }
    if !raw_preview.is_empty() {
        payload.insert("rawPreview".to_string(), Value::String(raw_preview));
    }
    Value::Object(payload)
}

fn codex_runtime_category(method: &str, item: &Value) -> &'static str {
    if method == "error" {
        return "error";
    }
    if method.starts_with("turn/") {
        return "turn";
    }
    if method.starts_with("thread/") {
        return "thread";
    }
    if matches!(
        method,
        "item/commandExecution/outputDelta"
            | "item/commandExecution/terminalInteraction"
            | "item/fileChange/outputDelta"
            | "item/fileChange/patchUpdated"
            | "item/mcpToolCall/progress"
    ) {
        return "tool";
    }
    if codex_is_tool_trace_item(item) {
        return "tool";
    }
    let item_type = item
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if item_type.contains("reasoning") {
        return "reasoning";
    }
    if item_type == "message" || item_type == "agentmessage" || method.contains("agentMessage") {
        return "message";
    }
    if method.starts_with("item/") || method.starts_with("rawResponseItem/") {
        return "item";
    }
    "unknown"
}

fn codex_runtime_status(method: &str, item: &Value) -> &'static str {
    if method == "error" {
        return "failed";
    }
    if method.ends_with("/started") {
        return "started";
    }
    if method.ends_with("/completed") {
        return "completed";
    }
    if method.ends_with("/delta") {
        return "delta";
    }
    if method == "thread/status/changed" {
        return match item
            .get("status")
            .and_then(|status| status.get("type"))
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "active" => "started",
            "idle" => "completed",
            "systemError" => "failed",
            _ => "info",
        };
    }
    if matches!(
        method,
        "item/commandExecution/outputDelta"
            | "item/fileChange/outputDelta"
            | "item/fileChange/patchUpdated"
            | "item/mcpToolCall/progress"
    ) {
        return "delta";
    }
    match item
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "completed" | "complete" | "success" => "completed",
        "failed" | "error" => "failed",
        "cancelled" | "canceled" => "cancelled",
        "inProgress" | "in_progress" | "running" => "started",
        _ => "info",
    }
}

fn codex_runtime_summary(method: &str, item: &Value, category: &str, status: &str) -> String {
    let subject = codex_runtime_tool_name(item)
        .or_else(|| {
            item.get("type")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| method.to_string());
    format!("{category} {status}: {subject}")
}

fn codex_runtime_tool_name(item: &Value) -> Option<String> {
    item.get("name")
        .or_else(|| item.get("toolName"))
        .or_else(|| item.get("tool_name"))
        .or_else(|| item.get("callName"))
        .or_else(|| item.get("call_name"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            item.get("action")
                .and_then(|action| action.get("type"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(ToString::to_string)
        })
        .or_else(|| {
            item.as_object().and_then(|map| {
                first_string(map, &["server_label", "serverLabel", "tool", "command"])
            })
        })
}

fn codex_runtime_details(method: &str, params: &Value, item: &Value) -> Option<Value> {
    let mut details = serde_json::Map::new();
    for key in [
        "id",
        "type",
        "name",
        "status",
        "call_id",
        "callId",
        "call_name",
        "callName",
        "itemId",
        "threadId",
        "turnId",
        "delta",
        "message",
        "arguments",
        "args",
        "input",
        "action",
        "output",
        "result",
        "error",
        "aggregatedOutput",
        "commandActions",
        "contentItems",
        "cwd",
        "durationMs",
        "exitCode",
        "processId",
        "source",
        "changes",
        "server_label",
        "serverLabel",
        "server",
        "tool",
        "command",
        "namespace",
        "success",
        "mcpAppResourceUri",
        "pluginId",
        "agentsStates",
        "senderThreadId",
        "receiverThreadIds",
        "model",
        "prompt",
        "reasoningEffort",
        "query",
        "path",
        "savedPath",
        "revisedPrompt",
    ] {
        if let Some(value) = item.get(key) {
            details.insert(key.to_string(), codex_runtime_trace_value(value, 0));
        }
    }
    if let Some(item_id) = codex_response_item_id(params) {
        details.insert("itemId".to_string(), Value::String(item_id));
    }
    details.insert(
        "runtimeMethod".to_string(),
        Value::String(method.to_string()),
    );
    (!details.is_empty()).then_some(Value::Object(details))
}

fn codex_runtime_raw_preview(params: &Value, category: &str) -> String {
    if category == "message" {
        return String::new();
    }
    let redacted = codex_runtime_trace_value(params, 0);
    let raw = serde_json::to_string_pretty(&redacted).unwrap_or_default();
    truncate_chars(&raw, CODEX_RUNTIME_TRACE_RAW_PREVIEW_LIMIT)
}

fn codex_runtime_trace_value(value: &Value, depth: usize) -> Value {
    if depth >= 6 {
        return Value::String("[truncated: max depth]".to_string());
    }
    match value {
        Value::String(text) => Value::String(truncate_chars(
            &redact_data_urls(text),
            CODEX_RUNTIME_TRACE_STRING_LIMIT,
        )),
        Value::Array(items) => {
            let mut redacted = items
                .iter()
                .take(CODEX_RUNTIME_TRACE_ARRAY_LIMIT)
                .map(|item| codex_runtime_trace_value(item, depth + 1))
                .collect::<Vec<_>>();
            if items.len() > CODEX_RUNTIME_TRACE_ARRAY_LIMIT {
                redacted.push(Value::String(format!(
                    "[truncated: {} more items]",
                    items.len() - CODEX_RUNTIME_TRACE_ARRAY_LIMIT
                )));
            }
            Value::Array(redacted)
        }
        Value::Object(map) => {
            let mut redacted = serde_json::Map::new();
            for (key, value) in map.iter().take(CODEX_RUNTIME_TRACE_OBJECT_LIMIT) {
                if codex_runtime_sensitive_key(key) {
                    redacted.insert(key.clone(), Value::String("[redacted]".to_string()));
                } else {
                    redacted.insert(key.clone(), codex_runtime_trace_value(value, depth + 1));
                }
            }
            if map.len() > CODEX_RUNTIME_TRACE_OBJECT_LIMIT {
                redacted.insert(
                    "_truncated".to_string(),
                    Value::String(format!(
                        "{} more keys",
                        map.len() - CODEX_RUNTIME_TRACE_OBJECT_LIMIT
                    )),
                );
            }
            Value::Object(redacted)
        }
        other => other.clone(),
    }
}

fn codex_runtime_sensitive_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.contains("token")
        || lower.contains("secret")
        || lower.contains("password")
        || lower.contains("authorization")
        || lower.contains("apikey")
        || lower.contains("api_key")
        || lower.contains("dataurl")
        || lower.contains("data_url")
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let truncated = value.chars().take(limit).collect::<String>();
    format!("{truncated}... [truncated]")
}

fn codex_is_tool_trace_item(item: &Value) -> bool {
    let item_type = item
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        item_type.as_str(),
        "commandexecution"
            | "filechange"
            | "mcptoolcall"
            | "dynamictoolcall"
            | "collabagenttoolcall"
            | "websearch"
            | "imageview"
            | "imagegeneration"
    ) {
        return true;
    }
    if item_type.is_empty()
        || matches!(item_type.as_str(), "message" | "agentmessage" | "reasoning")
    {
        return false;
    }
    if item_type.contains("tool")
        || item_type.contains("function")
        || item_type.contains("call")
        || item_type.contains("shell")
        || item_type.contains("mcp")
        || item_type.contains("web_search")
    {
        return true;
    }
    item.get("call_id").is_some()
        || item.get("callId").is_some()
        || (item.get("name").is_some()
            && (item.get("arguments").is_some()
                || item.get("args").is_some()
                || item.get("action").is_some()
                || item.get("input").is_some()))
}

fn codex_is_assistant_message_trace_item(item: &Value) -> bool {
    let item_type = item
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    item_type == "message" && item.get("role").and_then(Value::as_str) == Some("assistant")
}

fn codex_visible_output<'a>(primary_output: &'a str, fallback_output: &'a str) -> &'a str {
    let primary_output = primary_output.trim();
    if !primary_output.is_empty() {
        return primary_output;
    }
    fallback_output.trim()
}

fn codex_failure_local_output(
    primary_output: &str,
    fallback_output: &str,
    error: &str,
) -> Option<String> {
    let local_output = codex_visible_output(primary_output, fallback_output);
    if local_output.is_empty() {
        return None;
    }
    Some(format!(
        "{error} before the turn completed. Last visible output:\n\n{local_output}"
    ))
}

fn trace_attachment_summaries(
    attachments: Option<&[protocol::ChannelAttachment]>,
) -> Vec<serde_json::Value> {
    attachments
        .unwrap_or_default()
        .iter()
        .map(|attachment| {
            serde_json::json!({
                "id": attachment.id,
                "kind": attachment.kind,
                "name": attachment.name,
                "mimeType": attachment.mime_type,
                "size": attachment.size,
            })
        })
        .collect()
}
