// How the Agent's trusted instructions reach the runtime, and how a
// prompt (text plus images) is assembled before it is sent.

/// The stream-json transport flags appended after the launcher's own args
/// (which already include `--dangerously-skip-permissions`). `--resume` is added
/// last, only when recovering/rebornning into an existing session. A sticky
/// operator-selected model rides along as `--model` and a sticky effort as
/// `--effort`; appended after the launcher's args, each wins over whatever the
/// launcher pinned.
use base64::Engine as _;
use std::path::PathBuf;

use serde_json::Value;

use crate::{
    CliError, GoalCommand, decode_channel_image_attachment_data_url, env_flag, error,
    goal_resume_turn_payload, protocol, use_codex_app_backend, use_grok_app_backend,
    use_zcode_app_backend, uses_claude_code_runtime,
};

pub(crate) fn claude_stream_extra_args(
    resume_id: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    role_system_prompt: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "--print".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        // Echo each submitted user message back on stdout (`isReplay:true`) so
        // the reader can confirm the turn was accepted.
        "--replay-user-messages".to_string(),
    ];
    if let Some(model) = model.map(str::trim).filter(|value| !value.is_empty()) {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    if let Some(effort) = effort.map(str::trim).filter(|value| !value.is_empty()) {
        args.extend(["--effort".to_string(), effort.to_string()]);
    }
    if let Some(prompt) = role_system_prompt
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args.extend(["--append-system-prompt".to_string(), prompt.to_string()]);
    }
    // The Space's connector actions, as MCP tools for this Run's harness.
    if let Some(config) = crate::runtime_connector_mcp::claude_connector_mcp_config() {
        args.extend(["--mcp-config".to_string(), config]);
    }
    if let Some(session_id) = resume_id.map(str::trim).filter(|value| !value.is_empty()) {
        args.extend(["--resume".to_string(), session_id.to_string()]);
    }
    args
}

/// The registration's own instructions, delivered by the daemon as the
/// trusted initial prompt. The env name predates the retired Role feature and
/// is kept for compatibility between daemon and wrapper builds.
const TRUSTED_INITIAL_PROMPT_ENV: &str = "XMATRIX_AGENT_ROLE_INITIAL_PROMPT";

fn trusted_initial_prompt_from_env() -> Option<String> {
    crate::non_empty_env(TRUSTED_INITIAL_PROMPT_ENV)
}

pub(crate) fn trusted_role_system_prompt_from_env() -> Option<String> {
    trusted_role_system_prompt(trusted_initial_prompt_from_env().as_deref())
}

pub(crate) fn trusted_role_system_prompt(initial: Option<&str>) -> Option<String> {
    initial
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("Agent instructions (trusted xMatrix run configuration):\n{value}"))
}

pub(crate) fn trusted_role_is_active() -> bool {
    trusted_initial_prompt_from_env().is_some()
}

pub(crate) fn grok_acp_trusted_rules(bootstrap_prompt: Option<&str>) -> Option<String> {
    bootstrap_prompt
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn ensure_runtime_supports_trusted_role(
    runtime_name: &str,
    supports_trusted_role: bool,
    role_active: bool,
) -> error::Result<()> {
    if role_active && !supports_trusted_role {
        return Err(CliError::Launch(format!(
            "{runtime_name} cannot launch this Agent because its native protocol has no trusted system/developer instruction channel for the Agent's instructions; refusing to downgrade them into ordinary user content"
        )));
    }
    Ok(())
}

pub(crate) fn selected_runtime_supports_trusted_role(
    tool: &str,
    cmd: &str,
    cmd_args: &[String],
) -> bool {
    if use_zcode_app_backend(tool) {
        return false;
    }
    if use_codex_app_backend(tool) || use_grok_app_backend(tool) {
        return true;
    }
    env_flag("XMATRIX_HEADLESS")
        && (std::env::var("XMATRIX_AGENT_BACKEND")
            .ok()
            .is_some_and(|backend| backend == "claude-print")
            || uses_claude_code_runtime(tool, cmd, cmd_args))
}

/// How a vendor's prompt carries an image.
#[derive(Clone, Copy, Debug)]
pub(crate) enum ImageBlockShape {
    /// ACP `session/prompt`: `{ type: "image", mimeType, data }`. Kimi ACP
    /// advertises `promptCapabilities.image = true` and accepts these.
    Acp,
    /// Claude stream-json, in Anthropic messages-api shape:
    /// `image.source.{type,media_type,data}`.
    Anthropic,
}

impl ImageBlockShape {
    fn block(self, attachment: &protocol::ChannelAttachment, data: String) -> Value {
        match self {
            Self::Acp => serde_json::json!({
                "type": "image",
                "mimeType": attachment.mime_type,
                "data": data,
            }),
            Self::Anthropic => serde_json::json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": attachment.mime_type,
                    "data": data,
                },
            }),
        }
    }
}

/// Vendor prompt content blocks: text first, then one image block per image
/// attachment in the vendor's shape, preferring authoritative local files over
/// inline data URLs.
pub(crate) fn prompt_content_blocks(
    text: &str,
    attachments: Option<&[protocol::ChannelAttachment]>,
    local_image_paths: Option<&[PathBuf]>,
    shape: ImageBlockShape,
) -> error::Result<Vec<Value>> {
    let mut items = vec![serde_json::json!({
        "type": "text",
        "text": text,
    })];
    let Some(attachments) = attachments else {
        return Ok(items);
    };
    let local_paths_are_authoritative = local_image_paths.is_some();
    let mut local_image_index = 0usize;
    for attachment in attachments {
        if attachment.kind != "image" {
            continue;
        }
        let local_path = local_image_paths
            .and_then(|paths| paths.get(local_image_index))
            .cloned();
        if let Some(path) = local_path {
            if local_paths_are_authoritative {
                local_image_index += 1;
            }
            let bytes = std::fs::read(&path).map_err(|err| {
                CliError::Launch(format!(
                    "Failed to read local channel image attachment {}: {err}",
                    attachment.name
                ))
            })?;
            items.push(shape.block(
                attachment,
                base64::engine::general_purpose::STANDARD.encode(bytes),
            ));
        } else if !local_paths_are_authoritative && !attachment.data_url.is_empty() {
            let bytes = decode_channel_image_attachment_data_url(attachment)?;
            items.push(shape.block(
                attachment,
                base64::engine::general_purpose::STANDARD.encode(bytes),
            ));
        }
    }
    Ok(items)
}

/// One line of stream-json stdin: a single user turn. Claude accepts `content`
/// as a plain string, and also as an array of text / image content blocks with
/// Anthropic-style `image.source.{type,media_type,data}` shapes.
pub(crate) fn claude_stream_user_message(content_blocks: Vec<Value>) -> Value {
    serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": content_blocks },
    })
}

fn native_slash_goal_input(
    command: &GoalCommand,
    status: &str,
    pause: &str,
    resume: impl FnOnce() -> String,
) -> String {
    match command {
        GoalCommand::Set { objective } | GoalCommand::Replace { objective } => {
            format!("/goal {objective}")
        }
        GoalCommand::Clear => "/goal clear".to_string(),
        GoalCommand::Get => status.to_string(),
        GoalCommand::Pause => pause.to_string(),
        GoalCommand::Resume => resume(),
    }
}

/// Rewrites a parsed goal action onto Claude Code's native `/goal` grammar
/// (available since 2.1.139): `/goal <condition>` sets, bare `/goal` reports
/// status, `/goal clear` clears. Claude has no `get`/`status`/`resume`
/// subcommands — forwarding them verbatim would *set* a goal whose objective
/// is the literal word, so they must be rewritten. Resume reuses the shared
/// nudge payload: any turn in a session with an active goal makes Claude keep
/// working toward it and re-run the evaluator.
pub(crate) fn claude_goal_turn_input(
    command: &GoalCommand,
    latest_goal: Option<&protocol::AgentGoalStatus>,
) -> String {
    // Claude has no pause subcommand; fall back to status so we don't set a
    // literal goal named "pause".
    native_slash_goal_input(command, "/goal", "/goal", || {
        goal_resume_turn_payload(latest_goal).unwrap_or_else(|| "/goal".to_string())
    })
}

/// Rewrites a parsed goal action onto Grok Build's native slash grammar.
/// Grok exposes `/goal` as an available ACP command and drives progress with
/// the built-in `update_goal` tool (not Codex-style `thread/goal/*` RPCs).
pub(crate) fn grok_goal_turn_input(
    command: &GoalCommand,
    _latest_goal: Option<&protocol::AgentGoalStatus>,
) -> String {
    // Native resume also lets Grok rehydrate its session when no local goal
    // snapshot is available.
    native_slash_goal_input(command, "/goal status", "/goal pause", || {
        "/goal resume".to_string()
    })
}
