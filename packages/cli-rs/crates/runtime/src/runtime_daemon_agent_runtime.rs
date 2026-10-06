// The harness registry (`agent-presets.json`) owns every launcher alias; the
// predicates in this file only ask it questions.
pub(crate) use xmatrix_cli_agent::acp_backend_matches;
use xmatrix_cli_agent::{
    agent_preset_by_id, agent_preset_for_launcher, agent_type_for_launcher, launcher_stem_matches,
};

fn agent_type_for_runtime(tool: &str) -> String {
    let preset_id = std::env::var("XMATRIX_AGENT_PRESET_ID").ok();
    agent_type_for_preset_or_runtime(preset_id.as_deref(), tool)
}

/// The daemon passes the Profile's preset id, which names the harness more
/// reliably than sniffing a launcher token (`node dist/index.js`); only an
/// unknown or `custom` preset falls back to the launcher.
fn agent_type_for_preset_or_runtime(preset_id: Option<&str>, tool: &str) -> String {
    if let Some(preset) = preset_id
        .and_then(agent_preset_by_id)
        .filter(|preset| preset.id != "custom")
    {
        return preset.agent_type().to_string();
    }
    agent_type_for_launcher(tool)
}

/// Whether a launcher predicate holds for the tool, the command, or any of
/// its arguments (`xmatrix claude` carries the launcher as an argument).
fn runtime_uses(matches: fn(&str) -> bool, tool: &str, cmd: &str, cmd_args: &[String]) -> bool {
    matches(tool) || matches(cmd) || cmd_args.iter().any(|arg| matches(arg))
}

fn is_zcode_launcher_token(value: &str) -> bool {
    is_zcode_tool(value) || launcher_stem_matches(value, &["zai", "glm", "z-ai", "bigmodel"])
}

fn uses_zcode_runtime(tool: &str, cmd: &str, cmd_args: &[String]) -> bool {
    runtime_uses(is_zcode_launcher_token, tool, cmd, cmd_args)
}

fn is_grok_launcher_token(value: &str) -> bool {
    is_grok_tool(value) || launcher_stem_matches(value, &["grok-build"])
}

fn uses_grok_runtime(tool: &str, cmd: &str, cmd_args: &[String]) -> bool {
    runtime_uses(is_grok_launcher_token, tool, cmd, cmd_args)
}

const MAX_AGENT_NAME_LEN: usize = 64;

/* The platform's own Agent name rule, mirrored from AGENT_NAME_SOURCE in
`packages/protocol/src/agent-mention.ts`, minus `:` because a colon would
end the name when the mention is composed. Uppercase letters and dots are
valid — a Profile is routinely named after a host such as
`claude-Devs-MacBook-Pro.local`. */
fn is_platform_agent_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    if value.chars().count() > 124 {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn build_agent_name(tool: &str) -> String {
    if let Ok(override_name) = std::env::var("XMATRIX_AGENT_NAME_OVERRIDE") {
        let trimmed = override_name.trim();
        /* The daemon passes the Profile's stored name here, and the Hub binds
        the run to that exact string — it compares `message.name` against
        `principal.agentName` verbatim. Sanitizing a name that is already
        valid rewrote `claude-Devs-MacBook-Pro.local` into
        `claude-devs-macbook-pro-local`, so every Profile named after a
        macOS host failed to start with "Agent registration does not match
        the live Authority run-bound principal". Only a name the platform would
        reject still gets folded into something usable. */
        if is_platform_agent_name(trimmed) {
            return trimmed.to_string();
        }
        let name = sanitize_agent_name(trimmed);
        if !name.is_empty() {
            return name;
        }
    }

    let dirname = std::env::current_dir()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
        .unwrap_or_else(|| "unknown".into());

    let hostname_raw = gethostname::gethostname();
    let hostname_full = hostname_raw.to_string_lossy();
    let hostname = hostname_full.split('.').next().unwrap_or("local");

    sanitize_agent_name(&format!("{tool}-{dirname}-{hostname}"))
}

fn shell_wrap(cmd: &str, args: &[String]) -> (String, Vec<String>) {
    let cmd = resolve_bundled_agent_command(cmd).unwrap_or_else(|| cmd.to_string());
    if !cfg!(windows) {
        return (cmd, args.to_vec());
    }

    if let Ok(resolved) = which::which(&cmd) {
        let ext = resolved.extension().and_then(|e| e.to_str()).unwrap_or("");

        if ext.eq_ignore_ascii_case("exe") {
            return (resolved.to_string_lossy().to_string(), args.to_vec());
        }

        if (ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
            && let Some((node, script)) = parse_node_cmd_wrapper(&resolved) {
                let mut new_args = vec![script];
                new_args.extend(args.iter().cloned());
                return (node, new_args);
            }
    }

    let mut wrapped = vec!["/C".to_string(), cmd.to_string()];
    wrapped.extend(args.iter().cloned());
    ("cmd.exe".to_string(), wrapped)
}

fn resolve_bundled_agent_command(cmd: &str) -> Option<String> {
    xmatrix_cli_agent::bundled_agent_command_path(cmd)
        .map(|path| path.to_string_lossy().to_string())
}

fn parse_node_cmd_wrapper(cmd_path: &std::path::Path) -> Option<(String, String)> {
    let content = std::fs::read_to_string(cmd_path).ok()?;
    let dir = cmd_path.parent()?;

    for line in content.lines().rev() {
        if line.contains("%_prog%") && line.contains(".js") {
            let parts: Vec<&str> = line.split('"').collect();
            for part in &parts {
                if part.contains(".js") {
                    let script = part
                        .replace("%dp0%\\", "")
                        .replace("%dp0%/", "")
                        .replace("%~dp0\\", "")
                        .replace("%~dp0/", "");
                    let script_path = dir.join(&script);
                    if script_path.exists() {
                        let node = which::which("node")
                            .map(|p| p.to_string_lossy().to_string())
                            .unwrap_or_else(|_| "node".to_string());
                        return Some((node, script_path.to_string_lossy().to_string()));
                    }
                }
            }
        }
    }
    None
}

#[cfg(unix)]
fn detach_daemon_child_process(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;

    // The daemon may be restarted by launchd/systemd during self-update. Give
    // each spawned agent wrapper its own session so service-manager signals for
    // the daemon process group do not take down live agent runs.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(windows)]
fn windows_daemon_child_creation_flags() -> u32 {
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const DETACHED_PROCESS: u32 = 0x0000_0008;

    CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS
}

#[cfg(windows)]
fn detach_daemon_child_process(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;

    // The wrapper stays inside the stable outer Automation Job and creates
    // its own nested kill-on-close Job before launching a provider. Hosts that
    // deny Job breakaway must still be able to spawn a managed Agent.
    command.creation_flags(windows_daemon_child_creation_flags());
}

#[cfg(not(any(unix, windows)))]
fn detach_daemon_child_process(_command: &mut std::process::Command) {}

// Dedicated-adapter launcher predicates: each names the launchers a
// vendor-specific backend (app-server, print, ACP-serve) can drive.
fn is_codex_tool(tool: &str) -> bool {
    launcher_stem_matches(tool, &["codex"])
}

fn is_zcode_tool(tool: &str) -> bool {
    launcher_stem_matches(tool, &["zcode", "zcode.cjs"])
}

fn is_grok_tool(tool: &str) -> bool {
    launcher_stem_matches(tool, &["grok"])
}

fn is_claude_launcher_token(value: &str) -> bool {
    launcher_stem_matches(value, &["claude", "claude-code", "claude_code"])
}

fn uses_claude_code_runtime(tool: &str, cmd: &str, cmd_args: &[String]) -> bool {
    runtime_uses(is_claude_launcher_token, tool, cmd, cmd_args)
}

fn is_claude_code_agent(agent: &protocol::SerializedAgent) -> bool {
    agent.agent_type == "claude_code"
}

fn use_claude_print_backend(
    agent: &protocol::SerializedAgent,
    tool: &str,
    cmd: &str,
    cmd_args: &[String],
) -> bool {
    if std::env::var("XMATRIX_AGENT_BACKEND")
        .ok()
        .is_some_and(|backend| backend == "claude-print")
    {
        return true;
    }
    use_claude_print_backend_for(env_flag("XMATRIX_CLAUDE_PRINT"), agent, tool, cmd, cmd_args)
}

fn use_claude_print_backend_for(
    explicit_print: bool,
    agent: &protocol::SerializedAgent,
    tool: &str,
    cmd: &str,
    cmd_args: &[String],
) -> bool {
    explicit_print || is_claude_code_agent(agent) || uses_claude_code_runtime(tool, cmd, cmd_args)
}

fn daemon_spawn_uses_claude_print(runtime: &str, runtime_args: &[String]) -> bool {
    is_claude_launcher_token(runtime)
        || runtime_args.iter().any(|arg| is_claude_launcher_token(arg))
}

fn use_codex_app_backend(tool: &str) -> bool {
    if std::env::var("XMATRIX_AGENT_BACKEND")
        .ok()
        .is_some_and(|backend| backend == "codex-app")
    {
        return true;
    }
    if !is_codex_tool(tool) {
        return false;
    }
    // Default every platform to Codex app-server (WebSocket transport by default).
    // Force classic PTY with XMATRIX_CODEX_APP=0, or force stdio app-server with
    // XMATRIX_CODEX_TRANSPORT=stdio.
    match std::env::var("XMATRIX_CODEX_APP") {
        Ok(value) => !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        ),
        Err(_) => true,
    }
}

fn use_zcode_app_backend(tool: &str) -> bool {
    if std::env::var("XMATRIX_AGENT_BACKEND")
        .ok()
        .is_some_and(|backend| backend == "zcode-app")
    {
        return true;
    }
    is_zcode_tool(tool) && env_flag("XMATRIX_ZCODE_APP")
}

fn use_grok_app_backend(tool: &str) -> bool {
    if std::env::var("XMATRIX_AGENT_BACKEND")
        .ok()
        .is_some_and(|backend| backend == "grok-acp")
    {
        return true;
    }
    // Default Grok launches to the ACP WebSocket serve backend (non-PTY). Users
    // can force PTY by setting XMATRIX_GROK_APP=0/false and clearing the backend
    // env, or force ACP stdio with XMATRIX_GROK_TRANSPORT=stdio.
    if !is_grok_tool(tool) {
        return false;
    }
    match std::env::var("XMATRIX_GROK_APP") {
        Ok(value) => !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        ),
        Err(_) => true,
    }
}

/// Generic ACP backend (`acp_backend_matches`): explicit `acp` or any `*-acp`
/// backend other than the dedicated `grok-acp` adapter.
///
/// Backend resolution priority across the runtime: dedicated app-server / ACP
/// backends (codex-app, zcode-app, grok-acp, acp) > claude-print > headless
/// PTY > interactive PTY (last-resort fallback).
fn use_acp_backend() -> bool {
    if env_flag("XMATRIX_ACP") {
        return true;
    }
    std::env::var("XMATRIX_AGENT_BACKEND")
        .ok()
        .is_some_and(|backend| acp_backend_matches(&backend))
}
