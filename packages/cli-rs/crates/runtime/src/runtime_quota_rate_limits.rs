// Runtime-owned quota dispatch and model extraction. The quota window
// arithmetic and provider readers live in the `xmatrix-harness` crate.

/// Best-effort provider quota for non-Codex runtimes that expose a known source.
async fn provider_subscription_quota_usage(
    tool: &str,
    cmd: &str,
    cmd_args: &[String],
    force: bool,
) -> Option<protocol::LlmUsage> {
    if uses_zcode_runtime(tool, cmd, cmd_args) {
        return read_zai_coding_plan_quota_usage(force).await;
    }
    if uses_grok_runtime(tool, cmd, cmd_args) {
        return read_grok_build_billing_usage(force).await;
    }
    None
}

fn extract_llm_model(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            for key in ["model", "modelName", "model_name"] {
                if let Some(model) = map.get(key).and_then(Value::as_str) {
                    let model = model.trim();
                    if !model.is_empty() {
                        return Some(model.to_string());
                    }
                }
            }
            map.values().find_map(extract_llm_model)
        }
        Value::Array(items) => items.iter().find_map(extract_llm_model),
        _ => None,
    }
}
