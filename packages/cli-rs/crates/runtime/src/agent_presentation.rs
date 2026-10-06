use std::collections::HashSet;

use serde_json::Value;

use crate::protocol;

/// Provider-neutral facts consumed by every runtime presentation adapter.
///
/// An absent field means the runtime has not reported it authoritatively. An
/// adapter must never fill a missing fact with a guessed vendor default.
#[derive(Debug, Clone, Default)]
pub(crate) struct AgentPresentationFacts {
    pub(crate) model: Option<String>,
    pub(crate) models: Vec<protocol::AgentModelInfo>,
    pub(crate) models_reported: bool,
    pub(crate) effort: Option<String>,
    pub(crate) effort_config_id: Option<String>,
    pub(crate) parameters: Option<Vec<protocol::HarnessParameter>>,
    pub(crate) parameter_revision: u64,
    pub(crate) supported_efforts: Vec<protocol::AgentModelReasoningEffort>,
    pub(crate) commands: Vec<protocol::AgentInstanceCommand>,
    pub(crate) status_chips: Vec<protocol::AgentStatusChip>,
    pub(crate) usage: Option<protocol::LlmUsage>,
}

/// The normalized presentation snapshot sent through `presence_update`.
/// This mirrors the shared TypeScript `AgentPresentationSnapshot` contract.
#[derive(Debug, Clone, Default)]
pub(crate) struct AgentPresentationSnapshot {
    pub(crate) model: Option<String>,
    pub(crate) models: Option<Vec<protocol::AgentModelInfo>>,
    pub(crate) effort: Option<String>,
    pub(crate) commands: Option<Vec<protocol::AgentInstanceCommand>>,
    pub(crate) parameters: Option<Vec<protocol::HarnessParameter>>,
    pub(crate) status_chips: Option<Vec<protocol::AgentStatusChip>>,
    pub(crate) usage: Option<protocol::LlmUsage>,
}

/// Contract implemented by every Agent runtime family before presentation
/// reaches Hub/Web. Vendor events are observed here and normalized into the
/// same model/effort/command/chip/usage snapshot.
pub(crate) trait AgentPresentationAdapter {
    fn runtime(&self) -> &str;
    fn source(&self) -> &str;

    fn command_catalog_json(&self) -> Option<&'static str> {
        None
    }

    fn observe_acp(&self, value: &Value, facts: &mut AgentPresentationFacts) {
        observe_acp_presentation(value, facts, self.source());
    }

    fn present(
        &self,
        facts: &AgentPresentationFacts,
        command_overlay: &[String],
    ) -> AgentPresentationSnapshot {
        debug_assert!(
            !self.runtime().trim().is_empty(),
            "presentation adapters require a stable runtime id"
        );
        normalized_presentation(
            self.source(),
            self.command_catalog_json(),
            facts,
            command_overlay,
        )
    }
}

/// Built-in adapter implementations. Unknown launchers still receive the
/// provider-neutral Legacy/GenericAcp behavior and can report live facts; they
/// simply have no vendor catalog or vendor-only control hook.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BuiltinAgentPresentationAdapter {
    Codex,
    Claude,
    Grok,
    Kimi,
    Zcode,
    GenericAcp { runtime: String, source: String },
    Legacy { runtime: String, source: String },
}

impl AgentPresentationAdapter for BuiltinAgentPresentationAdapter {
    fn runtime(&self) -> &str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Grok => "grok",
            Self::Kimi => "kimi",
            Self::Zcode => "zcode",
            Self::GenericAcp { runtime, .. } | Self::Legacy { runtime, .. } => runtime,
        }
    }

    fn source(&self) -> &str {
        match self {
            Self::Codex => "codex_app",
            Self::Claude => "claude_stream",
            Self::Grok => "grok_acp",
            Self::Kimi => "kimi_acp",
            Self::Zcode => "zcode_app",
            Self::GenericAcp { source, .. } | Self::Legacy { source, .. } => source,
        }
    }

    fn command_catalog_json(&self) -> Option<&'static str> {
        match self {
            Self::Codex => Some(AGENT_COMMAND_CATALOG_CODEX),
            Self::Claude => Some(AGENT_COMMAND_CATALOG_CLAUDE),
            Self::Grok => Some(AGENT_COMMAND_CATALOG_GROK),
            Self::Kimi => Some(AGENT_COMMAND_CATALOG_KIMI),
            Self::Zcode => Some(AGENT_COMMAND_CATALOG_ZCODE),
            Self::GenericAcp { .. } | Self::Legacy { .. } => None,
        }
    }
}

pub(crate) fn agent_presentation_adapter_for_runtime(
    runtime: &str,
) -> BuiltinAgentPresentationAdapter {
    let raw = runtime.trim();
    let key = raw.to_ascii_lowercase();
    if key.contains("codex") {
        return BuiltinAgentPresentationAdapter::Codex;
    }
    if key == "claude" || key == "claude_code" || key.contains("claude") {
        return BuiltinAgentPresentationAdapter::Claude;
    }
    if key.contains("grok") {
        return BuiltinAgentPresentationAdapter::Grok;
    }
    if key.contains("kimi") {
        return BuiltinAgentPresentationAdapter::Kimi;
    }
    if key.contains("zcode") || key.contains("glm") {
        return BuiltinAgentPresentationAdapter::Zcode;
    }
    let runtime = if key.is_empty() {
        "unknown".to_string()
    } else {
        key
    };
    let source = runtime.replace(['/', '\\', ' '], "_");
    if runtime == "acp" || runtime.ends_with("-acp") || runtime.ends_with("_acp") {
        BuiltinAgentPresentationAdapter::GenericAcp {
            runtime,
            source: format!("{source}_adapter"),
        }
    } else {
        BuiltinAgentPresentationAdapter::Legacy { runtime, source }
    }
}

pub(crate) fn agent_presentation_adapter_for_acp_runtime(
    runtime: &str,
) -> BuiltinAgentPresentationAdapter {
    let adapter = agent_presentation_adapter_for_runtime(runtime);
    match adapter {
        BuiltinAgentPresentationAdapter::Legacy { runtime, source } => {
            BuiltinAgentPresentationAdapter::GenericAcp {
                runtime,
                source: format!("{source}_acp"),
            }
        }
        adapter => adapter,
    }
}

/// Data-driven slash catalogs from `packages/protocol/src/agent-command-catalogs/*.json`.
/// Refresh those JSON files from vendor docs; do not hardcode command lists here.
const AGENT_COMMAND_CATALOG_CODEX: &str =
    include_str!("../../../../protocol/src/agent-command-catalogs/codex.json");
const AGENT_COMMAND_CATALOG_CLAUDE: &str =
    include_str!("../../../../protocol/src/agent-command-catalogs/claude.json");
const AGENT_COMMAND_CATALOG_GROK: &str =
    include_str!("../../../../protocol/src/agent-command-catalogs/grok.json");
const AGENT_COMMAND_CATALOG_KIMI: &str =
    include_str!("../../../../protocol/src/agent-command-catalogs/kimi.json");
const AGENT_COMMAND_CATALOG_ZCODE: &str =
    include_str!("../../../../protocol/src/agent-command-catalogs/zcode.json");

pub(crate) fn agent_command_catalog_json_for_runtime(runtime: &str) -> Option<&'static str> {
    agent_presentation_adapter_for_runtime(runtime).command_catalog_json()
}

pub(crate) fn agent_commands_for_runtime(
    runtime: &str,
    has_models: bool,
    has_efforts: bool,
    _supports_goal: bool,
) -> Option<Vec<protocol::AgentInstanceCommand>> {
    let raw = agent_command_catalog_json_for_runtime(runtime)?;
    commands_from_catalog_json(raw, has_models, has_efforts)
}

fn commands_from_catalog_json(
    raw: &str,
    has_models: bool,
    has_efforts: bool,
) -> Option<Vec<protocol::AgentInstanceCommand>> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let items = value.get("commands").and_then(Value::as_array)?;
    let mut commands = Vec::new();
    let mut seen = HashSet::new();
    for item in items {
        let token = item
            .get("token")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|token| token.starts_with('/') && token.len() > 1)
            .map(str::to_string);
        let Some(token) = token else {
            continue;
        };
        let argument_source = item
            .get("argumentSource")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if argument_source.as_deref() == Some("agent-models") && !has_models {
            continue;
        }
        if argument_source.as_deref() == Some("agent-efforts") && !has_efforts {
            continue;
        }
        if !seen.insert(token.to_ascii_lowercase()) {
            continue;
        }
        let label = item
            .get("label")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| token.trim_start_matches('/').to_string());
        let description = item
            .get("description")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let mode = item
            .get("mode")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| *value == "typed" || *value == "passthrough")
            .map(str::to_string)
            .or_else(|| Some("passthrough".to_string()));
        commands.push(protocol::AgentInstanceCommand {
            token,
            label,
            description,
            mode,
            argument_source,
            freeform: item.get("freeform").and_then(Value::as_bool),
        });
    }
    (!commands.is_empty()).then_some(commands)
}

/// Normalize vendor slash names (`goal`, `/goal`, `local:commit`) into `/token`.
pub(crate) fn normalize_slash_command_token(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let body = trimmed.trim_start_matches('/').trim();
    if body.is_empty() || body.contains('/') || body.contains('\\') || body.contains(' ') {
        return None;
    }
    if !body
        .chars()
        .next()
        .is_some_and(|ch| ch.is_ascii_alphabetic())
    {
        return None;
    }
    Some(format!("/{body}"))
}

fn merge_command_lists(
    preferred: Vec<protocol::AgentInstanceCommand>,
    fallback: Vec<protocol::AgentInstanceCommand>,
) -> Vec<protocol::AgentInstanceCommand> {
    let mut seen = HashSet::new();
    preferred
        .into_iter()
        .chain(fallback)
        .filter(|command| seen.insert(command.token.to_ascii_lowercase()))
        .collect()
}

/// Additive overlay: catalog first, then any extra tokens as passthrough.
fn merge_commands_with_token_overlay(
    base: Vec<protocol::AgentInstanceCommand>,
    overlay_tokens: &[String],
) -> Vec<protocol::AgentInstanceCommand> {
    let mut seen: HashSet<String> = base
        .iter()
        .map(|command| command.token.to_ascii_lowercase())
        .collect();
    let mut commands = base;
    for raw in overlay_tokens {
        let Some(token) = normalize_slash_command_token(raw) else {
            continue;
        };
        if !seen.insert(token.to_ascii_lowercase()) {
            continue;
        }
        commands.push(protocol::AgentInstanceCommand {
            label: token.trim_start_matches('/').to_string(),
            token,
            description: Some("Discovered from local runtime overlay.".to_string()),
            mode: Some("passthrough".to_string()),
            argument_source: None,
            freeform: Some(true),
        });
    }
    commands
}

pub(crate) fn agent_commands_for_runtime_with_overlay(
    runtime: &str,
    has_models: bool,
    has_efforts: bool,
    overlay_tokens: &[String],
) -> Option<Vec<protocol::AgentInstanceCommand>> {
    let base =
        agent_commands_for_runtime(runtime, has_models, has_efforts, true).unwrap_or_default();
    let merged = merge_commands_with_token_overlay(base, overlay_tokens);
    (!merged.is_empty()).then_some(merged)
}

/// Resolve a requested model against a catalog, or say why it cannot be.
///
/// A request may name either the catalog id or the model name, and the answer
/// is always the model name the instance reports back — the hub dedupes on it.
/// The two ways this fails are the whole policy, so they live here too: a
/// catalog that has not loaded cannot answer anything, and a loaded one that
/// does not carry the request names it. Every runtime used to spell all three
/// in its own switch handler, and they had already drifted — one of them tried
/// the vendor anyway when its catalog was empty. The request arrives as typed,
/// so it is cleaned here as well.
pub(crate) fn resolve_switchable_model(
    models: &[protocol::AgentModelInfo],
    catalog_owner: &str,
    requested: &str,
) -> Result<String, String> {
    let cleaned = crate::clean_run_model(requested);
    let requested = cleaned.as_deref().unwrap_or(requested.trim());
    if models.is_empty() {
        return Err(format!("{catalog_owner} model catalog is unavailable"));
    }
    models
        .iter()
        .find(|candidate| {
            candidate.id.eq_ignore_ascii_case(requested)
                || candidate.model.eq_ignore_ascii_case(requested)
        })
        .map(|candidate| candidate.model.clone())
        .ok_or_else(|| format!("Model '{}' is not available", requested.trim()))
}

pub(crate) fn models_support_efforts(models: &[protocol::AgentModelInfo]) -> bool {
    models.iter().any(|item| {
        item.supported_reasoning_efforts
            .as_ref()
            .is_some_and(|entries| !entries.is_empty())
            || item.default_reasoning_effort.is_some()
    })
}

pub(crate) fn agent_status_chips_from_model_effort(
    model: Option<&str>,
    effort: Option<&str>,
    source: Option<&str>,
) -> Option<Vec<protocol::AgentStatusChip>> {
    let mut chips = Vec::new();
    if let Some(model) = model.map(str::trim).filter(|value| !value.is_empty()) {
        chips.push(protocol::AgentStatusChip {
            id: "model".to_string(),
            label: "Model".to_string(),
            value: Some(model.chars().take(128).collect()),
            source: source.map(str::to_string),
            percent: None,
            reset_at: None,
        });
    }
    if let Some(effort) = effort.map(str::trim).filter(|value| !value.is_empty()) {
        chips.push(protocol::AgentStatusChip {
            id: "effort".to_string(),
            label: "Effort".to_string(),
            value: Some(effort.chars().take(64).collect()),
            source: source.map(str::to_string),
            percent: None,
            reset_at: None,
        });
    }
    (!chips.is_empty()).then_some(chips)
}

/// Percent of the context window in use, when the runtime reported enough to say.
fn context_percent(usage: &protocol::LlmUsage) -> Option<f64> {
    // 0-100, like every producer of this field reports it: both the Claude and
    // Codex readers compute it as `used / window * 100`. Rescaling anything at
    // or below 1 used to turn a genuine 1% into 100%.
    if let Some(percent) = usage.context_usage_percent {
        return (percent.is_finite() && percent >= 0.0).then_some(percent);
    }
    let used = usage.context_used_tokens?;
    let window = usage.context_window_tokens?;
    (window > 0).then(|| (used as f64 / window as f64) * 100.0)
}

/// Whether a quota window has already rolled over, so the runtime stops
/// declaring it rather than leaving a stale meter on screen.
fn quota_window_expired(reset_at: Option<&str>) -> bool {
    let Some(reset_at) = reset_at.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    let reset_ms = reset_at
        .parse::<i64>()
        .ok()
        .map(|numeric| {
            // Providers send either epoch seconds or epoch milliseconds.
            if numeric > 1_000_000_000_000 {
                numeric
            } else {
                numeric * 1_000
            }
        })
        .or_else(|| {
            time::OffsetDateTime::parse(reset_at, &time::format_description::well_known::Rfc3339)
                .ok()
                .map(|parsed| (parsed.unix_timestamp_nanos() / 1_000_000) as i64)
        });
    // An unparseable instant is not evidence of expiry: keep declaring the tag.
    let Some(reset_ms) = reset_ms else {
        return false;
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0);
    reset_ms <= now_ms
}

/// The meter tags this runtime declares from its own quota and context facts.
/// Numbers travel as numbers; the client renders the bar and formats the reset
/// time. A window the provider does not report produces no tag.
fn meter_tags_from_usage(
    usage: Option<&protocol::LlmUsage>,
    source: &str,
) -> Vec<protocol::AgentStatusChip> {
    let mut tags = Vec::new();
    let Some(usage) = usage else {
        return tags;
    };
    for quota in usage.quota_usages.iter().flatten() {
        if tags.len() >= 3 {
            break;
        }
        if quota.percent.is_none() || quota_window_expired(quota.reset_at.as_deref()) {
            continue;
        }
        let Some(label) = quota
            .label
            .as_deref()
            .or(quota.window.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        tags.push(protocol::AgentStatusChip {
            id: format!("quota:{}", label.to_lowercase()),
            label: label.chars().take(64).collect(),
            value: None,
            source: Some(source.to_string()),
            percent: quota.percent,
            reset_at: quota.reset_at.clone(),
        });
    }
    if let Some(percent) = context_percent(usage) {
        tags.push(protocol::AgentStatusChip {
            id: "ctx".to_string(),
            label: "ctx".to_string(),
            value: None,
            source: Some(source.to_string()),
            percent: Some(percent),
            reset_at: None,
        });
    }
    tags
}

fn normalized_presentation(
    source: &str,
    catalog_json: Option<&str>,
    facts: &AgentPresentationFacts,
    command_overlay: &[String],
) -> AgentPresentationSnapshot {
    let has_models = !facts.models.is_empty();
    let has_efforts = facts.effort.is_some() || models_support_efforts(&facts.models);
    let catalog_commands = catalog_json
        .and_then(|raw| commands_from_catalog_json(raw, has_models, has_efforts))
        .unwrap_or_default();
    // Live commands are authoritative for their own tokens; the docs catalog
    // supplies typed controls and commands the provider cannot enumerate.
    let mut commands = merge_commands_with_token_overlay(
        merge_command_lists(facts.commands.clone(), catalog_commands),
        command_overlay,
    );
    if let Some(parameters) = facts.parameters.as_deref() {
        crate::harness_parameters::add_commands(&mut commands, parameters);
    }
    let mut chips = agent_status_chips_from_model_effort(
        model_chip_value(facts).as_deref(),
        facts.effort.as_deref(),
        Some(source),
    )
    .unwrap_or_default();
    let mut chip_ids: HashSet<String> = chips.iter().map(|chip| chip.id.clone()).collect();
    for mut chip in facts
        .status_chips
        .clone()
        .into_iter()
        .chain(meter_tags_from_usage(facts.usage.as_ref(), source))
    {
        if chip.source.is_none() {
            chip.source = Some(source.to_string());
        }
        if chip_ids.insert(chip.id.clone()) {
            chips.push(chip);
        }
    }
    let model = facts
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && !is_placeholder_model_id(value))
        .map(str::to_string);
    AgentPresentationSnapshot {
        model,
        models: facts.models_reported.then(|| facts.models.clone()),
        effort: facts.effort.clone(),
        commands: (facts.parameters.is_some() || !commands.is_empty()).then_some(commands),
        parameters: facts.parameters.clone(),
        status_chips: (!chips.is_empty()).then_some(chips),
        usage: facts.usage.clone(),
    }
}

fn clean_string(value: Option<&Value>, max_chars: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(max_chars).collect())
}

fn option_value(option: &Value) -> Option<String> {
    clean_string(option.get("value").or_else(|| option.get("id")), 128)
}

/// Cursor variants-mode placeholders when parameterizedModelPicker was missing.
fn is_placeholder_model_id(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return true;
    }
    let lower = trimmed.to_ascii_lowercase();
    lower == "default[]"
        || lower
            .strip_prefix("default[")
            .is_some_and(|rest| rest == "]")
}

fn option_current_display(option: &Value, current: &str) -> String {
    option
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find_map(|entry| {
            let value = option_value(entry)?;
            value
                .eq_ignore_ascii_case(current)
                .then(|| clean_string(entry.get("name"), 128).unwrap_or(value))
        })
        .unwrap_or_else(|| current.to_string())
}

fn model_chip_value(facts: &AgentPresentationFacts) -> Option<String> {
    let model = facts.model.as_deref()?.trim();
    if model.is_empty() {
        return None;
    }
    let display = facts
        .models
        .iter()
        .find(|item| item.id.eq_ignore_ascii_case(model))
        .and_then(|item| item.display_name.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    // Cursor variants-mode placeholders like `default[]` must never appear on
    // the chip; fall back to the option display name ("Auto") when present.
    if is_placeholder_model_id(model) {
        return display.map(|value| value.chars().take(128).collect());
    }
    Some(display.unwrap_or(model).chars().take(128).collect())
}

/// Default Agent mode is ambient UI; only Plan / Ask / other modes earn a chip.
fn is_default_agent_mode(value: &str, display: &str) -> bool {
    value.trim().eq_ignore_ascii_case("agent") || display.trim().eq_ignore_ascii_case("agent")
}

fn reasoning_efforts_from_value(value: &Value) -> Option<Vec<protocol::AgentModelReasoningEffort>> {
    let entries = value
        .get("reasoningEfforts")
        .or_else(|| value.get("reasoning_efforts"))
        .or_else(|| value.get("supportedReasoningEfforts"))
        .or_else(|| value.get("supported_reasoning_efforts"))
        .or_else(|| value.get("supportEfforts"))
        .and_then(Value::as_array)?;
    let mut seen = HashSet::new();
    let efforts: Vec<_> = entries
        .iter()
        .filter_map(|entry| {
            let reasoning_effort = if let Some(text) = entry.as_str() {
                text.trim().to_string()
            } else {
                clean_string(
                    entry
                        .get("reasoningEffort")
                        .or_else(|| entry.get("value"))
                        .or_else(|| entry.get("id")),
                    64,
                )?
            };
            if reasoning_effort.is_empty() || !seen.insert(reasoning_effort.to_ascii_lowercase()) {
                return None;
            }
            Some(protocol::AgentModelReasoningEffort {
                reasoning_effort,
                description: clean_string(entry.get("description"), 256),
            })
        })
        .collect();
    (!efforts.is_empty()).then_some(efforts)
}

pub(crate) fn acp_model_catalog_from_value(value: &Value) -> Vec<protocol::AgentModelInfo> {
    value
        .get("availableModels")
        .or_else(|| value.get("available_models"))
        .or_else(|| value.get("models"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let id = clean_string(item.get("modelId").or_else(|| item.get("id")), 128)?;
            let meta = item.get("_meta").unwrap_or(&Value::Null);
            let supported_reasoning_efforts =
                reasoning_efforts_from_value(meta).or_else(|| reasoning_efforts_from_value(item));
            let default_reasoning_effort = clean_string(
                meta.get("reasoningEffort")
                    .or_else(|| meta.get("reasoning_effort"))
                    .or_else(|| item.get("defaultReasoningEffort"))
                    .or_else(|| item.get("default_reasoning_effort")),
                64,
            )
            .or_else(|| {
                meta.get("reasoningEfforts")
                    .or_else(|| meta.get("reasoning_efforts"))
                    .and_then(Value::as_array)
                    .and_then(|items| {
                        items.iter().find(|entry| {
                            entry.get("default").and_then(Value::as_bool) == Some(true)
                        })
                    })
                    .and_then(option_value)
            });
            Some(protocol::AgentModelInfo {
                id: id.clone(),
                model: id,
                display_name: clean_string(
                    item.get("name")
                        .or_else(|| item.get("displayName"))
                        .or_else(|| item.get("display_name")),
                    128,
                ),
                description: clean_string(item.get("description"), 512),
                hidden: None,
                is_default: None,
                default_reasoning_effort,
                supported_reasoning_efforts,
                input_modalities: None,
                supports_personality: None,
                upgrade: None,
            })
        })
        .collect()
}

fn commands_from_acp_value(value: &Value) -> Vec<protocol::AgentInstanceCommand> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let token = clean_string(entry.get("name").or_else(|| entry.get("token")), 128)
                .and_then(|name| normalize_slash_command_token(&name))?;
            let freeform = entry.get("input").is_some_and(|input| !input.is_null());
            Some(protocol::AgentInstanceCommand {
                label: clean_string(entry.get("label"), 128)
                    .unwrap_or_else(|| token.trim_start_matches('/').to_string()),
                token,
                description: clean_string(entry.get("description"), 512),
                mode: Some("passthrough".to_string()),
                argument_source: None,
                freeform: freeform.then_some(true),
            })
        })
        .collect()
}

fn attach_config_efforts_to_selected_model(facts: &mut AgentPresentationFacts) {
    let Some(selected) = facts.model.as_deref() else {
        return;
    };
    let Some(model) = facts
        .models
        .iter_mut()
        .find(|model| model.id.eq_ignore_ascii_case(selected))
    else {
        return;
    };
    if !facts.supported_efforts.is_empty() {
        model.supported_reasoning_efforts = Some(facts.supported_efforts.clone());
    }
    if facts.effort.is_some() {
        model.default_reasoning_effort = facts.effort.clone();
    }
}

fn observe_config_options(options: &[Value], facts: &mut AgentPresentationFacts, source: &str) {
    // ACP config_option_update carries a complete configOptions snapshot. Kimi
    // always includes its model picker, while the thinking picker disappears
    // when the selected model does not support reasoning. Clear the dependent
    // facts before applying that authoritative snapshot so a model change
    // cannot leave a stale effort or mode label behind.
    let has_model_option = options.iter().any(|option| {
        clean_string(option.get("id"), 64).is_some_and(|id| {
            matches!(
                id.to_ascii_lowercase().replace(['-', ' '], "_").as_str(),
                "model" | "models"
            )
        })
    });
    if has_model_option {
        facts.effort = None;
        facts.effort_config_id = None;
        facts.supported_efforts.clear();
        facts.status_chips.retain(|chip| chip.id != "mode");
    }

    facts.parameter_revision = facts.parameter_revision.saturating_add(1);
    facts.parameters = Some(crate::harness_parameters::acp_parameters(options));
    for option in options {
        let Some(id) = clean_string(option.get("id"), 64) else {
            continue;
        };
        let key = id.to_ascii_lowercase().replace(['-', ' '], "_");
        let current = clean_string(
            option
                .get("currentValue")
                .or_else(|| option.get("current_value")),
            128,
        );
        if key == "model" || key == "models" {
            let models: Vec<_> = option
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|entry| {
                    let model = option_value(entry)?;
                    Some(protocol::AgentModelInfo {
                        id: model.clone(),
                        model,
                        display_name: clean_string(entry.get("name"), 128),
                        description: clean_string(entry.get("description"), 512),
                        hidden: None,
                        is_default: None,
                        default_reasoning_effort: None,
                        supported_reasoning_efforts: None,
                        input_modalities: None,
                        supports_personality: None,
                        upgrade: None,
                    })
                })
                .collect();
            facts.models = models;
            facts.models_reported = true;
            // Keep the raw currentValue (including Cursor's variants-mode
            // `default[]`) so display-name resolution can still map it to
            // "Auto"; presentation chips never show the placeholder text.
            facts.model = current;
            attach_config_efforts_to_selected_model(facts);
            continue;
        }
        if matches!(
            key.as_str(),
            "effort" | "reasoning_effort" | "thinking" | "thinking_effort" | "thought_level"
        ) {
            facts.effort_config_id = Some(id);
            let supported: Vec<_> = option
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|entry| {
                    let reasoning_effort = option_value(entry)?;
                    Some(protocol::AgentModelReasoningEffort {
                        reasoning_effort,
                        description: clean_string(entry.get("description"), 256),
                    })
                })
                .collect();
            facts.supported_efforts = supported;
            facts.effort = current;
            attach_config_efforts_to_selected_model(facts);
            continue;
        }
        if key == "mode" {
            facts.status_chips.retain(|existing| existing.id != "mode");
            if let Some(current) = current {
                let display = option_current_display(option, &current);
                if is_default_agent_mode(&current, &display) {
                    continue;
                }
                let chip = protocol::AgentStatusChip {
                    id: "mode".to_string(),
                    label: clean_string(option.get("name"), 64)
                        .unwrap_or_else(|| "Mode".to_string()),
                    value: Some(display),
                    source: Some(source.to_string()),
                    percent: None,
                    reset_at: None,
                };
                facts.status_chips.push(chip);
            }
        }
    }
}

fn non_negative_u64(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    if let Some(value) = value.as_u64() {
        return Some(value);
    }
    let value = value.as_f64()?;
    (value.is_finite() && value >= 0.0 && value <= u64::MAX as f64).then(|| value.round() as u64)
}

fn usage_from_acp_update(map: &serde_json::Map<String, Value>) -> Option<protocol::LlmUsage> {
    let kind = map
        .get("sessionUpdate")
        .or_else(|| map.get("session_update"))
        .and_then(Value::as_str)?;
    if kind != "usage_update" {
        return None;
    }
    let context_used_tokens = non_negative_u64(map.get("used"));
    let context_window_tokens = non_negative_u64(map.get("size"));
    let context_usage_percent = context_used_tokens
        .zip(context_window_tokens)
        .filter(|(_, size)| *size > 0)
        .map(|(used, size)| used as f64 / size as f64 * 100.0);
    let cost_usd = map.get("cost").and_then(Value::as_object).and_then(|cost| {
        let currency = cost.get("currency").and_then(Value::as_str)?;
        currency
            .eq_ignore_ascii_case("usd")
            .then(|| cost.get("amount").and_then(Value::as_f64))
            .flatten()
    });
    let usage = protocol::LlmUsage {
        context_used_tokens,
        context_window_tokens,
        context_usage_percent,
        cost_usd,
        ..protocol::LlmUsage::default()
    };
    (usage.context_used_tokens.is_some()
        || usage.context_window_tokens.is_some()
        || usage.cost_usd.is_some())
    .then_some(usage)
}

fn observe_acp_presentation(
    value: &Value,
    facts: &mut AgentPresentationFacts,
    source: &str,
) {
    let model = facts.model.clone();
    let revision = facts.parameter_revision;
    facts.usage =
        super::merge_llm_usage(facts.usage.clone(), super::extract_llm_usage(value));
    observe_acp_node(value, facts, source, 0);
    if model != facts.model && revision == facts.parameter_revision {
        facts.parameters = Some(Vec::new());
    }
}

fn observe_acp_node(value: &Value, facts: &mut AgentPresentationFacts, source: &str, depth: usize) {
    if depth > 7 {
        return;
    }
    let Some(map) = value.as_object() else {
        return;
    };

    facts.usage = super::merge_llm_usage(facts.usage.clone(), usage_from_acp_update(map));

    if let Some(options) = map
        .get("configOptions")
        .or_else(|| map.get("config_options"))
        .and_then(Value::as_array)
    {
        observe_config_options(options, facts, source);
    }
    if let Some(commands) = map
        .get("availableCommands")
        .or_else(|| map.get("available_commands"))
    {
        facts.commands = commands_from_acp_value(commands);
    }
    if map.get("availableModels").is_some()
        || map.get("available_models").is_some()
        || map.get("models").is_some_and(Value::is_array)
    {
        let models = acp_model_catalog_from_value(value);
        facts.models = models;
        facts.models_reported = true;
        if let Some(model) = clean_string(
            map.get("currentModelId")
                .or_else(|| map.get("current_model_id")),
            128,
        )
        .filter(|value| !is_placeholder_model_id(value))
        {
            facts.model = Some(model.clone());
            if let Some(selected) = facts
                .models
                .iter()
                .find(|item| item.id.eq_ignore_ascii_case(&model))
                && selected.default_reasoning_effort.is_some() {
                    facts.effort = selected.default_reasoning_effort.clone();
                }
        }
    } else if let Some(model) = clean_string(
        map.get("currentModelId")
            .or_else(|| map.get("current_model_id"))
            .or_else(|| map.get("modelId"))
            .or_else(|| map.get("model_id")),
        128,
    )
    .filter(|value| !is_placeholder_model_id(value))
    {
        facts.model = Some(model);
    }
    if let Some(effort) = clean_string(
        map.get("reasoningEffort")
            .or_else(|| map.get("reasoning_effort"))
            .or_else(|| map.get("thinkingEffort"))
            .or_else(|| map.get("thinking_effort")),
        64,
    ) {
        facts.effort = Some(effort);
    }
    if let Some(mode) = clean_string(
        map.get("currentModeId")
            .or_else(|| map.get("current_mode_id")),
        128,
    ) {
        facts.status_chips.retain(|chip| chip.id != "mode");
        if !is_default_agent_mode(&mode, &mode) {
            facts.status_chips.push(protocol::AgentStatusChip {
                id: "mode".to_string(),
                label: "Mode".to_string(),
                value: Some(mode),
                source: Some(source.to_string()),
                percent: None,
                reset_at: None,
            });
        }
    }

    for (key, child) in map {
        if matches!(
            key.as_str(),
            "availableModels"
                | "available_models"
                | "availableCommands"
                | "available_commands"
                | "configOptions"
                | "config_options"
                | "options"
        ) {
            continue;
        }
        if child.is_object() {
            observe_acp_node(child, facts, source, depth + 1);
        }
    }
}
