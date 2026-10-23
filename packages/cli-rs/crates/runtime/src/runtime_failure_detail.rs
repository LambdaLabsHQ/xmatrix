//! Shared error projection for native JSON, ACP and vendor stream adapters.
//! Only error fields are projected; prompts, response bodies, stacks and headers
//! are not serialised wholesale into Channel notices.
use serde_json::Value;
use xmatrix_cli_core::failure_detail::sanitize;

const FIELDS: &[&str] = &[
    "httpStatusCode",
    "http_status_code",
    "httpStatus",
    "http_status",
    "statusCode",
    "status_code",
    "status",
    "code",
    "type",
    "requestId",
    "request_id",
    "x-request-id",
    "cf-ray",
    "exitCode",
    "exit_code",
    "signal",
    "retryAfter",
    "retry_after",
];

pub(crate) fn error_metadata(value: &Value) -> Vec<String> {
    let mut parts = Vec::new();
    for key in FIELDS {
        if let Some(value) = value.get(key).and_then(scalar) {
            if *key == "type" && value == "result" {
                continue;
            }
            parts.push(format!("{key}={value}"));
        }
    }
    parts
}

fn scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(sanitize(text, 256)),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// Bound the leading message separately so transport/retry wording keeps its
/// prefix and a long message cannot truncate the following HTTP evidence.
/// JSON-RPC codes remain codes; they are never relabelled as HTTP statuses.
pub(crate) fn provider_error_detail(value: &Value) -> String {
    fn visit(value: &Value, depth: usize, facts: &mut Vec<String>, messages: &mut Vec<String>) {
        if depth > 6 || facts.len() + messages.len() >= 48 {
            return;
        }
        match value {
            Value::String(text) => messages.push(sanitize(text, 3_000)),
            Value::Array(values) => {
                for value in values.iter().take(8) {
                    visit(value, depth + 1, facts, messages);
                }
            }
            Value::Object(map) => {
                facts.extend(error_metadata(value));
                for key in [
                    "message",
                    "detail",
                    "reason",
                    "error",
                    "errors",
                    "cause",
                    "data",
                    "details",
                    "inner_error",
                    "additionalDetails",
                ] {
                    if let Some(value) = map.get(key) {
                        visit(value, depth + 1, facts, messages);
                    }
                }
                // Codex uses a tagged enum for transport information.
                if let Some(info) = map.get("codexErrorInfo") {
                    if let Some(text) = info.as_str() {
                        facts.push(format!("codexErrorInfo={}", sanitize(text, 128)));
                    } else if let Some(variants) = info.as_object() {
                        for (name, payload) in variants.iter().take(4) {
                            if name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric()) {
                                facts.push(format!("codexErrorInfo={name}"));
                                visit(payload, depth + 1, facts, messages);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    let (mut facts, mut messages) = (Vec::new(), Vec::new());
    visit(value, 0, &mut facts, &mut messages);
    let mut unique = if messages.is_empty() {
        Vec::new()
    } else {
        vec![sanitize(&messages.remove(0), 1_000)]
    };
    facts.append(&mut messages);
    for part in facts {
        if !part.trim().is_empty() && !unique.contains(&part) {
            unique.push(part);
        }
    }
    if unique.is_empty() {
        "The harness supplied no recognised error fields".into()
    } else {
        sanitize(&unique.join(" | "), 4_000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_status_survives_long_prose_without_publishing_private_payloads() {
        let detail = provider_error_detail(&serde_json::json!({
            "message": "failed ".repeat(900),
            "code": -32603,
            "data": {"codexErrorInfo": {"httpConnectionFailed": {"httpStatusCode": 403}},
                "requestId": "req-123", "authorization": "Bearer PRIVATE", "body": "PRIVATE_BODY"},
            "prompt": "PRIVATE_PROMPT"
        }));
        assert!(detail.contains("code=-32603"));
        assert!(detail.contains("httpStatusCode=403"));
        assert!(!detail.contains("PRIVATE"));
        assert!(detail.len() <= 4_003);
    }

    #[test]
    fn plain_and_missing_errors_do_not_invent_http_evidence() {
        assert_eq!(
            provider_error_detail(&Value::String("workspace routing discovery failed".into())),
            "workspace routing discovery failed"
        );
        assert_eq!(
            provider_error_detail(&serde_json::json!({"code": -32603})),
            "code=-32603"
        );
        assert_eq!(
            provider_error_detail(&Value::Null),
            "The harness supplied no recognised error fields"
        );
    }

    #[test]
    fn repeated_redaction_keeps_independent_structured_evidence() {
        let projected = provider_error_detail(&serde_json::json!({
            "message": "Request denied. Authorization: Bearer PRIVATE_HEADER",
            "httpStatusCode": 403, "requestId": "req-independent"
        }));
        let reported = sanitize(&projected, 4_000);
        assert!(!reported.contains("PRIVATE_HEADER"));
        assert!(reported.contains("httpStatusCode=403"), "{reported}");
        assert!(reported.contains("requestId=req-independent"), "{reported}");
    }

    #[test]
    fn diagnostic_fields_do_not_break_native_reconnect_accounting() {
        let detail = provider_error_detail(&serde_json::json!({
            "message": "Reconnecting... 2/5", "code": "transport_error",
            "data": {"httpStatusCode": 503}
        }));
        assert!(crate::codex_app_error_is_transient_transport(&detail));
        assert_eq!(crate::codex_reconnect_attempts(&detail), Some((2, 5)));
        assert!(detail.contains("httpStatusCode=503"));
    }

    #[test]
    fn acp_and_claude_preserve_error_status_and_rpc_code_without_raw_data() {
        let error = serde_json::json!({"code": -32603, "message": "Internal error",
            "data": {"status": 429, "request_id": "req-safe", "body": "PRIVATE"}});
        let acp = crate::acp_error_message(&error);
        let (claude, failed) = crate::runtime_claude_stream_io::claude_result_answer(
            &serde_json::json!({"type": "result", "is_error": true, "errors": [error]}),
            "",
        );
        assert!(failed);
        for detail in [acp, claude] {
            assert!(detail.contains("code=-32603"));
            assert!(detail.contains("status=429"));
            assert!(detail.contains("request_id=req-safe"));
            assert!(!detail.contains("PRIVATE"));
        }
    }
}
