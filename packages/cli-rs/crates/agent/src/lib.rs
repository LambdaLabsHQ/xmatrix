#![deny(warnings)]

pub mod management;
mod registration;

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use colored::Colorize;
use serde::Deserialize;
use serde_json::Value;
use xmatrix_cli_args::AgentCommand;
use xmatrix_cli_core::error::{self, CliError};
use xmatrix_cli_core::machine_daemon_connection::SerializedMachineDaemon;
use xmatrix_cli_core::protocol::{HubRoutes, with_route};
use xmatrix_cli_core::{access, config, http};

async fn list_machine_daemons_api(
    hub_url: &str,
    token: &str,
) -> error::Result<Vec<SerializedMachineDaemon>> {
    #[derive(Deserialize)]
    struct MachineDaemonsResponse {
        daemons: Vec<SerializedMachineDaemon>,
    }

    let response: MachineDaemonsResponse = http::request_json(
        &with_route(hub_url, HubRoutes::MACHINE_DAEMONS),
        "GET",
        Some(token),
        None,
    )
    .await?;
    Ok(response.daemons)
}

/// One harness in the shared registry (`packages/protocol/src/agent-presets.json`).
/// The JSON is the single source of truth for launcher aliases, backends,
/// config directories, and install hints; Rust and TypeScript both read it, so
/// adding a harness is a data change and the helpers below derive the rest.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPreset {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub runtime: String,
    /// Legacy `agentType` registered for this harness when it differs from
    /// the preset id (`claude` → `claude_code`). Absent means the id.
    #[serde(default)]
    pub agent_type: Option<String>,
    pub default_args: Vec<String>,
    pub backend: String,
    /// Subcommand/args appended to the runtime for the generic ACP backend
    /// (e.g. `["acp"]` → `kimi acp`). Forwarded to daemon spawns as the
    /// XMATRIX_ACP_ARGS JSON array. An explicit `[]` means the launcher
    /// already speaks ACP with no subcommand; absent defaults to `["acp"]`.
    #[serde(default)]
    pub acp_args: Option<Vec<String>>,
    #[serde(default)]
    pub avatar_url: String,
    pub launcher_names: Vec<String>,
    pub classic_config_dirs: Vec<String>,
    /// One-line upstream installer, shown when the runtime binary is missing.
    #[serde(default)]
    pub install_hint: Option<String>,
    #[serde(default)]
    pub management: Option<management::HarnessManagement>,
}

impl AgentPreset {
    /// The legacy `agentType` string this harness registers with the Hub.
    pub fn agent_type(&self) -> &str {
        self.agent_type.as_deref().unwrap_or(&self.id)
    }

    /// The harness's own config / credential directories, `~` expanded.
    pub fn config_dirs(&self) -> Vec<PathBuf> {
        self.classic_config_dirs
            .iter()
            .map(|dir| expand_home_path(dir))
            .collect()
    }
}

/// Generic ACP backend predicate: `acp` or any `*-acp` backend other than the
/// dedicated `grok-acp` adapter, which has its own dispatch branch.
pub fn acp_backend_matches(backend: &str) -> bool {
    let backend = backend.trim();
    backend == "acp" || (backend != "grok-acp" && backend.ends_with("-acp"))
}

/// Lowercase launcher stem: drops directories and Windows launcher
/// extensions, so `C:\bin\Cursor-Agent.CMD` and `cursor-agent` compare equal.
pub fn launcher_stem(value: &str) -> String {
    let name = value.rsplit(['/', '\\']).next().unwrap_or(value);
    let lower = name.trim().to_ascii_lowercase();
    lower
        .strip_suffix(".exe")
        .or_else(|| lower.strip_suffix(".cmd"))
        .or_else(|| lower.strip_suffix(".bat"))
        .unwrap_or(&lower)
        .to_string()
}

/// Whether a launcher token's stem is one of `stems`.
pub fn launcher_stem_matches(value: &str, stems: &[&str]) -> bool {
    let stem = launcher_stem(value);
    stems.iter().any(|candidate| *candidate == stem)
}

/// The preset a launcher token, runtime path, preset id, or legacy agentType
/// belongs to (`cursor-agent.exe` → cursor, `claude_code` → claude,
/// `pi-acp` → pi). `custom` never matches: it has no launcher of its own.
pub fn agent_preset_for_launcher(value: &str) -> Option<&'static AgentPreset> {
    let stem = launcher_stem(value);
    if stem.is_empty() {
        return None;
    }
    agent_presets().iter().find(|preset| {
        preset.id != "custom"
            && (preset.id == stem
                || preset.agent_type.as_deref() == Some(stem.as_str())
                || launcher_stem(&preset.runtime) == stem
                || preset
                    .launcher_names
                    .iter()
                    .any(|launcher| launcher_stem(launcher) == stem))
    })
}

/// Legacy `agentType` for a launcher: the preset's registered type, else the
/// preset id. Launchers that never had a preset keep their historical type
/// (`aider`, `windsurf`, and the ZCode-era `zai` / `glm` aliases) so persisted
/// Agent rows do not change meaning.
pub fn agent_type_for_launcher(value: &str) -> String {
    if let Some(preset) = agent_preset_for_launcher(value) {
        return preset.agent_type().to_string();
    }
    match launcher_stem(value).as_str() {
        "aider" => "aider",
        "windsurf" => "windsurf",
        "zai" | "glm" => "zcode",
        _ => "custom",
    }
    .to_string()
}

#[derive(Debug)]
struct AgentPresetDiscovery {
    preset: AgentPreset,
    runtime_available: bool,
    config_dirs: Vec<PathBuf>,
    workspaces: Vec<PathBuf>,
}

pub fn agent_presets() -> &'static [AgentPreset] {
    static PRESETS: OnceLock<Vec<AgentPreset>> = OnceLock::new();
    PRESETS
        .get_or_init(|| {
            serde_json::from_str(include_str!("../../../../protocol/src/agent-presets.json"))
                .expect("agent preset registry must be valid JSON")
        })
        .as_slice()
}

pub fn agent_preset_by_id(id: &str) -> Option<&'static AgentPreset> {
    agent_presets()
        .iter()
        .find(|preset| preset.id.eq_ignore_ascii_case(id))
}

fn known_agent_preset_ids() -> String {
    agent_presets()
        .iter()
        .map(|preset| preset.id.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn expand_home_path(value: &str) -> PathBuf {
    if value == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(value));
    }
    if let Some(rest) = value.strip_prefix("~/")
        && let Some(home) = dirs::home_dir()
    {
        return home.join(rest);
    }
    PathBuf::from(value)
}

fn command_available(command: &str) -> bool {
    if command.trim().is_empty() {
        return false;
    }
    which::which(command).is_ok() || bundled_agent_command_path(command).is_some()
}

/// The app-bundled script for a launcher that ships inside a desktop app
/// rather than on PATH (ZCode.app on macOS). None for every other launcher.
pub fn bundled_agent_command_path(command: &str) -> Option<PathBuf> {
    if !launcher_stem_matches(command, &["zcode"]) {
        return None;
    }

    #[cfg(target_os = "macos")]
    {
        let path = PathBuf::from("/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs");
        if path.is_file() {
            return Some(path);
        }
    }

    None
}

/// Whether the runtime that will launch this agent is actually installed and on
/// PATH. Mirrors the availability check used by `agent discover`: accept either
/// the resolved runtime command or any of the preset's known launcher names.
fn runtime_available_for_preset(runtime: &str, preset: &AgentPreset) -> bool {
    command_available(runtime)
        || preset
            .launcher_names
            .iter()
            .any(|name| command_available(name))
}

/// One-line install hint for known agent runtimes, used to point a user at the
/// upstream installer when the runtime binary is missing at `agent add` time.
fn runtime_install_hint(runtime: &str) -> Option<&'static str> {
    agent_preset_for_launcher(runtime)?.install_hint.as_deref()
}

fn decode_claude_project_dir_name(name: &str) -> Option<PathBuf> {
    let trimmed = name.trim_matches('-');
    if trimmed.is_empty() {
        return None;
    }
    let decoded = format!("/{}", trimmed.replace('-', "/"));
    let path = PathBuf::from(decoded);
    path.is_dir().then_some(path)
}

fn collect_workspace_paths_from_json(value: &Value, output: &mut HashSet<PathBuf>) {
    match value {
        Value::Object(map) => {
            for (key, item) in map {
                let lower = key.to_ascii_lowercase();
                if matches!(
                    lower.as_str(),
                    "cwd"
                        | "currentdir"
                        | "current_dir"
                        | "canonicalcwd"
                        | "canonical_cwd"
                        | "workspaceroot"
                        | "workspace_root"
                        | "workspace"
                ) && let Some(path) =
                    item.as_str().map(str::trim).filter(|path| !path.is_empty())
                {
                    let path = PathBuf::from(path);
                    if path.is_absolute() && path.is_dir() {
                        output.insert(path);
                    }
                }
                collect_workspace_paths_from_json(item, output);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_workspace_paths_from_json(item, output);
            }
        }
        _ => {}
    }
}

fn scan_json_workspace_file(path: &Path, output: &mut HashSet<PathBuf>) {
    if std::fs::metadata(path)
        .ok()
        .is_some_and(|metadata| metadata.len() > 2_000_000)
    {
        return;
    }
    let Ok(raw) = std::fs::read_to_string(path) else {
        return;
    };
    let is_jsonl = path.extension().and_then(|extension| extension.to_str()) == Some("jsonl");
    for line in raw.lines().take(2_000) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            collect_workspace_paths_from_json(&value, output);
        }
    }
    if !is_jsonl && let Ok(value) = serde_json::from_str::<Value>(&raw) {
        collect_workspace_paths_from_json(&value, output);
    }
}

fn scan_workspace_paths(root: &Path) -> Vec<PathBuf> {
    let mut output = HashSet::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut visited = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        if depth > 5 || visited > 1_500 {
            continue;
        }
        visited += 1;
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                if path
                    .parent()
                    .and_then(|parent| parent.file_name())
                    .and_then(|name| name.to_str())
                    == Some("projects")
                    && let Some(name) = path.file_name().and_then(|name| name.to_str())
                    && let Some(decoded) = decode_claude_project_dir_name(name)
                {
                    output.insert(decoded);
                }
                stack.push((path, depth + 1));
            } else if matches!(
                path.extension().and_then(|extension| extension.to_str()),
                Some("json") | Some("jsonl")
            ) {
                scan_json_workspace_file(&path, &mut output);
            }
        }
    }
    let mut workspaces = output.into_iter().collect::<Vec<_>>();
    workspaces.sort();
    workspaces
}

fn discover_agent_presets(filter: Option<&str>) -> error::Result<Vec<AgentPresetDiscovery>> {
    let presets = if let Some(filter) = filter {
        vec![agent_preset_by_id(filter).cloned().ok_or_else(|| {
            CliError::Launch(format!(
                "Unknown agent preset '{filter}', expected one of: {}",
                known_agent_preset_ids()
            ))
        })?]
    } else {
        agent_presets()
            .iter()
            .filter(|preset| preset.id != "custom")
            .cloned()
            .collect()
    };

    Ok(presets
        .into_iter()
        .map(|preset| {
            let config_dirs = preset
                .config_dirs()
                .into_iter()
                .filter(|dir| dir.is_dir())
                .collect::<Vec<_>>();
            let mut workspaces = config_dirs
                .iter()
                .flat_map(|dir| scan_workspace_paths(dir))
                .collect::<HashSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            workspaces.sort();
            AgentPresetDiscovery {
                runtime_available: runtime_available_for_preset(&preset.runtime, &preset),
                preset,
                config_dirs,
                workspaces,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{
        AgentPreset, acp_backend_matches, agent_preset_by_id, agent_preset_for_launcher,
        agent_presets, agent_type_for_launcher, launcher_stem, runtime_available_for_preset,
        runtime_install_hint,
    };

    #[test]
    fn runtime_install_hint_comes_from_the_preset_registry() {
        assert_eq!(
            runtime_install_hint("claude"),
            Some("curl -fsSL https://claude.ai/install.sh | bash")
        );
        assert_eq!(
            runtime_install_hint("claude-code"),
            Some("curl -fsSL https://claude.ai/install.sh | bash")
        );
        assert_eq!(
            runtime_install_hint("grok"),
            Some("curl -fsSL https://x.ai/cli/install.sh | bash")
        );
        assert_eq!(
            runtime_install_hint("opencode"),
            Some("npm install -g opencode-ai")
        );
        assert_eq!(
            runtime_install_hint("pi-acp"),
            Some("npm install -g @earendil-works/pi-coding-agent pi-acp")
        );
        assert_eq!(runtime_install_hint("codex"), None);
        assert_eq!(runtime_install_hint("node"), None);
    }

    #[test]
    fn launcher_stem_drops_directories_and_windows_extensions() {
        assert_eq!(launcher_stem("C:\\bin\\Cursor-Agent.CMD"), "cursor-agent");
        assert_eq!(launcher_stem("/opt/homebrew/bin/opencode"), "opencode");
        assert_eq!(launcher_stem(" codex.exe "), "codex");
        assert_eq!(launcher_stem("zcode.cjs"), "zcode.cjs");
        assert_eq!(launcher_stem(""), "");
    }

    #[test]
    fn launcher_aliases_resolve_to_their_preset() {
        let id = |value: &str| agent_preset_for_launcher(value).map(|preset| preset.id.as_str());
        assert_eq!(id("cursor-agent"), Some("cursor"));
        assert_eq!(id("C:\\bin\\Cursor-Agent.CMD"), Some("cursor"));
        assert_eq!(id("cursor"), Some("cursor"));
        assert_eq!(id("claude_code"), Some("claude"));
        assert_eq!(id("claude-code"), Some("claude"));
        assert_eq!(id("/opt/homebrew/bin/opencode"), Some("opencode"));
        assert_eq!(id("pi-acp"), Some("pi"));
        assert_eq!(id("pi"), Some("pi"));
        assert_eq!(id("kimi.exe"), Some("kimi"));
        assert_eq!(id("grok"), Some("grok"));
        // `custom` has no launcher; unknown tools stay unresolved.
        assert_eq!(id("custom"), None);
        assert_eq!(id(""), None);
        assert_eq!(id("node"), None);
        assert_eq!(id("aider"), None);
    }

    #[test]
    fn agent_type_for_launcher_keeps_legacy_types_stable() {
        assert_eq!(agent_type_for_launcher("claude"), "claude_code");
        assert_eq!(agent_type_for_launcher("claude-code"), "claude_code");
        assert_eq!(agent_type_for_launcher("codex.exe"), "codex");
        assert_eq!(agent_type_for_launcher("cursor-agent.exe"), "cursor");
        assert_eq!(agent_type_for_launcher("zcode"), "zcode");
        assert_eq!(agent_type_for_launcher("glm"), "zcode");
        assert_eq!(agent_type_for_launcher("zai"), "zcode");
        assert_eq!(agent_type_for_launcher("grok"), "grok");
        assert_eq!(agent_type_for_launcher("kimi"), "kimi");
        assert_eq!(agent_type_for_launcher("opencode"), "opencode");
        assert_eq!(agent_type_for_launcher("pi-acp"), "pi");
        assert_eq!(agent_type_for_launcher("aider"), "aider");
        assert_eq!(agent_type_for_launcher("windsurf"), "windsurf");
        assert_eq!(agent_type_for_launcher("node"), "custom");
        assert_eq!(agent_type_for_launcher(""), "custom");
    }

    #[test]
    fn every_preset_declares_a_launcher_that_resolves_back_to_itself() {
        for preset in agent_presets()
            .iter()
            .filter(|preset| preset.id != "custom")
        {
            assert!(
                !preset.launcher_names.is_empty(),
                "{} declares no launcher names",
                preset.id
            );
            for launcher in &preset.launcher_names {
                assert_eq!(
                    agent_preset_for_launcher(launcher).map(|found| found.id.as_str()),
                    Some(preset.id.as_str()),
                    "{launcher} must resolve to {}",
                    preset.id
                );
            }
            assert_eq!(
                agent_preset_for_launcher(&preset.runtime).map(|found| found.id.as_str()),
                Some(preset.id.as_str()),
                "runtime {} must resolve to {}",
                preset.runtime,
                preset.id
            );
        }
    }

    #[test]
    fn opencode_and_pi_presets_use_the_generic_acp_backend() {
        let opencode = agent_preset_by_id("opencode").expect("opencode preset");
        assert_eq!(opencode.runtime, "opencode");
        assert_eq!(opencode.backend, "acp");
        assert_eq!(opencode.acp_args.as_deref(), Some(&["acp".to_string()][..]));
        assert_eq!(opencode.avatar_url, "/agent-vendors/opencode.svg");
        assert_eq!(opencode.agent_type(), "opencode");
        assert!(
            opencode
                .classic_config_dirs
                .iter()
                .any(|dir| dir == "~/.local/share/opencode")
        );

        // Pi has no ACP server of its own; the registry launcher is the
        // ACP-registry `pi-acp` adapter, which already speaks ACP with no
        // subcommand.
        let pi = agent_preset_by_id("pi").expect("pi preset");
        assert_eq!(pi.runtime, "pi-acp");
        assert_eq!(pi.backend, "acp");
        assert_eq!(pi.acp_args.as_deref(), Some(&[][..]));
        assert_eq!(pi.avatar_url, "/agent-vendors/pi.svg");
        assert_eq!(pi.agent_type(), "pi");
        assert_eq!(pi.classic_config_dirs, vec!["~/.pi".to_string()]);
    }

    #[test]
    fn runtime_available_checks_runtime_and_launcher_names() {
        let preset = AgentPreset {
            id: "claude".to_string(),
            display_name: "Claude Code".to_string(),
            description: String::new(),
            runtime: "claude".to_string(),
            agent_type: None,
            default_args: vec![],
            backend: "claude-print".to_string(),
            acp_args: None,
            avatar_url: String::new(),
            launcher_names: vec!["definitely-not-a-real-binary-xyz".to_string()],
            classic_config_dirs: vec![],
            install_hint: None,
            management: None,
        };
        assert!(!runtime_available_for_preset(
            "definitely-not-a-real-runtime-xyz",
            &preset
        ));
    }

    #[test]
    fn kimi_preset_registry_declares_acp_backend_and_args() {
        let preset = agent_preset_by_id("kimi").expect("kimi preset");
        assert_eq!(preset.backend, "acp");
        assert_eq!(preset.acp_args.as_deref(), Some(&["acp".to_string()][..]));
        assert_eq!(preset.avatar_url, "/agent-vendors/kimi.svg");
        assert!(preset.default_args.is_empty());
        assert!(acp_backend_matches(&preset.backend));
        assert!(acp_backend_matches("kimi-acp"));
        assert!(!acp_backend_matches("grok-acp"));
        assert!(!acp_backend_matches("pty"));
        assert!(!acp_backend_matches("codex-app"));
    }

    #[test]
    fn cursor_preset_registry_declares_native_acp_server() {
        let preset = agent_preset_by_id("cursor").expect("cursor preset");
        assert_eq!(preset.runtime, "cursor-agent");
        assert_eq!(preset.backend, "acp");
        assert_eq!(preset.acp_args.as_deref(), Some(&["acp".to_string()][..]));
        assert_eq!(preset.avatar_url, "/agent-vendors/cursor.png");
        assert!(preset.default_args.is_empty());
        assert!(
            preset
                .launcher_names
                .iter()
                .any(|launcher| launcher == "cursor-agent")
        );
        assert!(
            preset
                .classic_config_dirs
                .iter()
                .any(|directory| directory == "~/.cursor")
        );
    }

    #[test]
    #[cfg(unix)]
    fn agent_spawn_path_preserves_profile_path_and_adds_user_bins() {
        let path = super::augmented_agent_spawn_path(Some("/custom/bin:/usr/bin")).unwrap();
        let paths: Vec<std::path::PathBuf> = std::env::split_paths(&path).collect();

        assert_eq!(
            paths.first(),
            Some(&std::path::PathBuf::from("/custom/bin"))
        );
        assert!(paths.contains(&std::path::PathBuf::from("/opt/homebrew/bin")));
        assert!(paths.contains(&std::path::PathBuf::from("/usr/local/bin")));
        assert_eq!(
            paths
                .iter()
                .filter(|path| *path == &std::path::PathBuf::from("/usr/bin"))
                .count(),
            1
        );
    }
}

fn common_user_bin_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".cargo").join("bin"));
        paths.push(home.join(".local").join("bin"));
        paths.push(home.join("bin"));
    }

    #[cfg(unix)]
    {
        paths.push(PathBuf::from("/opt/homebrew/bin"));
        paths.push(PathBuf::from("/usr/local/bin"));
        paths.push(PathBuf::from("/usr/bin"));
        paths.push(PathBuf::from("/bin"));
        paths.push(PathBuf::from("/usr/sbin"));
        paths.push(PathBuf::from("/sbin"));
    }

    paths
}

fn augmented_agent_spawn_path(profile_path: Option<&str>) -> Option<std::ffi::OsString> {
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    let base_path = profile_path
        .map(std::ffi::OsString::from)
        .or_else(|| std::env::var_os("PATH"));

    if let Some(base_path) = base_path {
        for path in std::env::split_paths(&base_path) {
            let key = path.to_string_lossy().to_string();
            if !key.is_empty() && seen.insert(key) {
                paths.push(path);
            }
        }
    }

    for path in common_user_bin_paths() {
        let key = path.to_string_lossy().to_string();
        if !key.is_empty() && seen.insert(key) {
            paths.push(path);
        }
    }

    if paths.is_empty() {
        return None;
    }

    std::env::join_paths(paths).ok()
}

pub fn apply_agent_spawn_path(
    command: &mut std::process::Command,
    local_env: &BTreeMap<String, String>,
) {
    if let Some(path) = augmented_agent_spawn_path(local_env.get("PATH").map(String::as_str)) {
        command.env("PATH", path);
    }
}

/// The exact `xmatrix` CLI that started a daemon-managed Agent Run.
pub const XMATRIX_BIN_ENV: &str = "XMATRIX_BIN";

/// Makes the daemon's own CLI the `xmatrix` an Agent reaches. A stale
/// `xmatrix` earlier on the profile PATH lacks newer subcommands and reads
/// them as a runtime to wrap, so the daemon's directory goes first and
/// `XMATRIX_BIN` names the exact executable. Call after `apply_agent_spawn_path`.
pub fn apply_agent_cli_binary(command: &mut std::process::Command, daemon_cli: &Path) {
    command.env_remove(XMATRIX_BIN_ENV);
    // `/proc/self/exe` names whichever process reads it, never the daemon.
    if daemon_cli.starts_with("/proc") {
        return;
    }
    command.env(XMATRIX_BIN_ENV, daemon_cli);
    let base_path = command
        .get_envs()
        .find(|(key, _)| *key == "PATH")
        .and_then(|(_, value)| value.map(std::ffi::OsString::from))
        .or_else(|| std::env::var_os("PATH"));
    if let Some(path) = agent_path_with_cli_first(daemon_cli, base_path.as_deref()) {
        command.env("PATH", path);
    }
}

fn agent_path_with_cli_first(
    daemon_cli: &Path,
    base_path: Option<&std::ffi::OsStr>,
) -> Option<std::ffi::OsString> {
    // PATH lookup only finds `xmatrix`; a renamed binary is reachable only
    // through XMATRIX_BIN.
    let is_xmatrix = daemon_cli
        .file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| stem.eq_ignore_ascii_case("xmatrix"));
    let dir = daemon_cli
        .parent()
        .filter(|dir| is_xmatrix && !dir.as_os_str().is_empty())?;
    let rest = base_path
        .map(|path| std::env::split_paths(path).collect::<Vec<_>>())
        .unwrap_or_default();
    let paths =
        std::iter::once(dir.to_path_buf()).chain(rest.into_iter().filter(|path| path != dir));
    std::env::join_paths(paths).ok()
}

fn daemon_online_for_machine(daemons: &[SerializedMachineDaemon], machine_id: &str) -> bool {
    daemons
        .iter()
        .any(|daemon| daemon.status == "online" && daemon.machine_id.as_deref() == Some(machine_id))
}

pub async fn ensure_local_daemon_started(hub_url: &str, token: &str) -> error::Result<()> {
    let machine_id = config::get_or_create_machine_id(hub_url).await?;
    if daemon_online_for_machine(
        &list_machine_daemons_api(hub_url, token).await?,
        &machine_id,
    ) {
        return Ok(());
    }

    let exe = std::env::current_exe()
        .map_err(|err| CliError::Launch(format!("Failed to locate xmatrix executable: {err}")))?;
    let mut command = std::process::Command::new(exe);
    command
        .arg("daemon")
        .env("XMATRIX_HUB_URL", hub_url)
        .env_remove("XMATRIX_ENVIRONMENT")
        // Login has already persisted the canonical session. Starting from
        // disk keeps the daemon reloadable and avoids pinning its lifecycle to
        // the one-hour access token inherited by this short-lived CLI process.
        .env_remove("XMATRIX_TOKEN")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .spawn()
        .map_err(|err| CliError::Launch(format!("Failed to start local daemon: {err}")))?;

    for _ in 0..10 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if daemon_online_for_machine(
            &list_machine_daemons_api(hub_url, token).await?,
            &machine_id,
        ) {
            return Ok(());
        }
    }

    Ok(())
}

pub async fn cmd_agent(hub_url: &str, token: &str, command: AgentCommand) -> error::Result<()> {
    match command {
        AgentCommand::Discover { preset } => {
            let discoveries = discover_agent_presets(preset.as_deref())?;
            if discoveries.is_empty() {
                println!("No known agent presets discovered.");
                return Ok(());
            }
            for discovery in discoveries {
                let runtime = if discovery.runtime_available {
                    "available".green().to_string()
                } else {
                    "missing".yellow().to_string()
                };
                println!(
                    "{} {} ({}) backend={} runtime={}",
                    "•".bold(),
                    discovery.preset.display_name.bold(),
                    discovery.preset.id.dimmed(),
                    discovery.preset.backend,
                    runtime
                );
                println!("  {}", discovery.preset.description);
                if discovery.config_dirs.is_empty() {
                    println!("  config dirs: none found");
                } else {
                    println!(
                        "  config dirs: {}",
                        discovery
                            .config_dirs
                            .iter()
                            .map(|path| path.display().to_string())
                            .collect::<Vec<_>>()
                            .join(", ")
                    );
                }
                if discovery.workspaces.is_empty() {
                    println!("  workspaces: none found");
                } else {
                    println!("  workspaces (not imported by default):");
                    for workspace in discovery.workspaces.iter().take(20) {
                        println!("    {}", workspace.display());
                    }
                    if discovery.workspaces.len() > 20 {
                        println!("    +{} more", discovery.workspaces.len() - 20);
                    }
                }
            }
        }
        command => registration::run(hub_url, token, command).await?,
    }
    Ok(())
}

#[cfg(test)]
mod cli_binary_tests {
    #[test]
    #[cfg(unix)]
    fn agent_path_puts_daemon_cli_ahead_of_a_stale_xmatrix() {
        let path = super::agent_path_with_cli_first(
            std::path::Path::new("/opt/xmatrix/bin/xmatrix"),
            Some(std::ffi::OsStr::new(
                "/home/me/.cargo/bin:/opt/xmatrix/bin:/usr/bin",
            )),
        )
        .unwrap();
        let paths: Vec<std::path::PathBuf> = std::env::split_paths(&path).collect();
        assert_eq!(
            paths,
            ["/opt/xmatrix/bin", "/home/me/.cargo/bin", "/usr/bin"]
                .map(std::path::PathBuf::from)
                .to_vec()
        );
        // A renamed binary is not what `xmatrix` resolves to on PATH.
        assert!(
            super::agent_path_with_cli_first(
                std::path::Path::new("/tmp/xmatrix-1.2.3"),
                Some(std::ffi::OsStr::new("/usr/bin")),
            )
            .is_none()
        );
    }

    #[test]
    #[cfg(unix)]
    fn agent_cli_binary_is_exported_and_first_on_spawn_path() {
        let mut command = std::process::Command::new("true");
        command.env("XMATRIX_BIN", "/stale/xmatrix");
        command.env("PATH", "/home/me/.local/bin:/usr/bin");
        super::apply_agent_cli_binary(
            &mut command,
            std::path::Path::new("/opt/xmatrix/bin/xmatrix"),
        );
        let env = |key: &str| {
            command
                .get_envs()
                .find(|(name, _)| *name == key)
                .and_then(|(_, value)| value.map(|v| v.to_string_lossy().into_owned()))
        };
        assert_eq!(
            env("XMATRIX_BIN").as_deref(),
            Some("/opt/xmatrix/bin/xmatrix")
        );
        assert_eq!(
            env("PATH").as_deref(),
            Some("/opt/xmatrix/bin:/home/me/.local/bin:/usr/bin")
        );

        let mut proc_image = std::process::Command::new("true");
        proc_image.env("XMATRIX_BIN", "/stale/xmatrix");
        super::apply_agent_cli_binary(&mut proc_image, std::path::Path::new("/proc/self/exe"));
        assert!(
            proc_image
                .get_envs()
                .any(|(name, value)| name == "XMATRIX_BIN" && value.is_none())
        );
    }
}
