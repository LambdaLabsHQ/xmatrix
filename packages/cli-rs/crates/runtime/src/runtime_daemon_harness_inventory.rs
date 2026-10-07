use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use xmatrix_cli_agent::management::LatestRegistry;
use xmatrix_cli_agent::{AgentPreset, agent_presets};
use xmatrix_cli_core::machine_daemon_connection::MachineDaemonConnectionClient;

use crate::runtime_daemon_harness_policy::{HarnessPolicy, effective_auto_update};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_OUTPUT: u64 = 16 * 1024;
const LATEST_TIMEOUT: Duration = Duration::from_secs(5);
/// npm `latest` documents carry the readme and PyPI JSON lists every release.
const LATEST_MAX_BODY: usize = 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InventoryItem {
    pub(crate) id: String,
    pub(crate) installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<String>,
    pub(crate) probe_status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) latest_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) auto_update: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) login: Option<&'static str>,
}

/// A harness process the daemon starts itself: closed stdin, piped output, the
/// owner's home as cwd (never a managed repository's hooks/config), no console
/// window on Windows, and its own process tree so a deadline can end it.
pub(crate) fn harness_command(program: &Path, args: &[impl AsRef<OsStr>]) -> Command {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(home) = dirs::home_dir() {
        command.current_dir(home);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    crate::process_tree::configure_tokio_process_tree(&mut command);
    command
}

/// Cursor's generic `agent` name is also used by other vendors. Prefer its
/// unambiguous launcher and accept a generic alias only beside that launcher.
pub(crate) fn resolve_launcher(preset: &AgentPreset) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let mut paths = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    paths.push(home.join(".local").join("bin"));
    if preset.id == "cursor"
        && let Some(local) = dirs::data_local_dir()
    {
        paths.push(local.join("cursor-agent"));
    }
    let paths = std::env::join_paths(paths).ok()?;
    resolve_launcher_in(preset, &paths, &home)
}

fn resolve_launcher_in(preset: &AgentPreset, paths: &OsStr, cwd: &Path) -> Option<PathBuf> {
    let cursor = preset.id == "cursor";
    let mut names = preset.launcher_names.iter().collect::<Vec<_>>();
    if cursor {
        names.sort_by_key(|name| xmatrix_cli_agent::launcher_stem(name) != "cursor-agent");
    }
    for name in names {
        if let Ok(mut candidates) = which::which_in_all(name, Some(paths), cwd)
            && let Some(path) =
                candidates.find(|path| !cursor || cursor_launcher_candidate(path, cwd))
        {
            return Some(path);
        }
    }
    None
}

fn cursor_launcher_candidate(path: &Path, cwd: &Path) -> bool {
    let stem = xmatrix_cli_agent::launcher_stem(&path.to_string_lossy());
    if stem == "cursor-agent" {
        return true;
    }
    if stem != "agent" {
        return false;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    let Ok(search) = std::env::join_paths([parent]) else {
        return false;
    };
    which::which_in("cursor-agent", Some(search), cwd).is_ok()
}

/// Bind a harness-specific recipe to the same identified launcher as inventory,
/// rather than resolving Cursor's generic name against PATH a second time.
pub(crate) fn resolve_recipe_program(preset_id: &str, command: &str) -> Option<PathBuf> {
    if preset_id == "cursor"
        && xmatrix_cli_agent::launcher_stem_matches(command, &["agent", "cursor-agent"])
    {
        agent_presets()
            .iter()
            .find(|preset| preset.id == preset_id)
            .and_then(resolve_launcher)
    } else {
        which::which(command).ok()
    }
}

fn resolve_version_launcher(
    preset: &AgentPreset,
    launcher: &Path,
    command: &str,
) -> Option<PathBuf> {
    if command == preset.runtime || preset.launcher_names.iter().any(|alias| alias == command) {
        Some(launcher.to_path_buf())
    } else {
        which::which(command).ok()
    }
}

fn parse_version(output: &[u8], pattern: &str) -> Option<String> {
    let text = std::str::from_utf8(output).ok()?;
    let captures = regex::Regex::new(pattern).ok()?.captures(text)?;
    let version = captures.get(1)?.as_str();
    (!version.is_empty() && version.len() <= 128 && !version.chars().any(char::is_control))
        .then(|| version.to_string())
}

/// Bounded pipes and process lifetime; never persist stdout, stderr, or exception text.
async fn version_output(path: &Path, args: &[String]) -> Result<Vec<u8>, &'static str> {
    let mut child = harness_command(path, args).spawn().map_err(|_| "failed")?;
    let _tree =
        crate::process_tree::ProcessTreeGuard::bind_tokio_child(&child).map_err(|_| "failed")?;
    let stdout = child.stdout.take().ok_or("failed")?;
    let stderr = child.stderr.take().ok_or("failed")?;
    let read = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut stdout = stdout.take(MAX_OUTPUT + 1);
        let mut stderr = stderr.take(MAX_OUTPUT + 1);
        let (out_result, err_result, status) = tokio::join!(
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err),
            child.wait(),
        );
        out_result.map_err(|_| "failed")?;
        err_result.map_err(|_| "failed")?;
        if out.len() as u64 > MAX_OUTPUT || err.len() as u64 > MAX_OUTPUT {
            return Err("unrecognized");
        }
        if !status.map_err(|_| "failed")?.success() {
            return Err("failed");
        }
        out.push(b'\n');
        out.extend(err);
        Ok(out)
    };
    tokio::time::timeout(PROBE_TIMEOUT, read)
        .await
        .map_err(|_| "timeout")?
}

pub(crate) async fn probe(preset: &AgentPreset, policy: &HarnessPolicy) -> InventoryItem {
    let mut item = probe_launcher(preset).await;
    item.latest_version = cached_latest_version(&preset.id);
    item.auto_update = Some(if item.installed {
        effective_auto_update(preset, policy)
    } else {
        "unknown"
    });
    if item.installed {
        item.login = crate::runtime_daemon_harness_login::inventory_state(preset).await;
    }
    item
}

async fn probe_launcher(preset: &AgentPreset) -> InventoryItem {
    let path = resolve_launcher(preset);
    let mut item = InventoryItem {
        id: preset.id.clone(),
        installed: path.is_some(),
        path: path.as_ref().and_then(|p| {
            let text = p.to_string_lossy();
            // Keep the complete inventory below the connect metadata budget even
            // when every launcher is inside an unusually long directory.
            (text.len() <= 1024 && !text.chars().any(char::is_control)).then(|| text.into_owned())
        }),
        version: None,
        latest_version: None,
        auto_update: None,
        login: None,
        probe_status: if path.is_some() {
            "unsupported"
        } else {
            "missing"
        },
    };
    let Some(recipe) = preset.management.as_ref().and_then(|m| m.version.as_ref()) else {
        item.probe_status = "unsupported";
        return item;
    };
    if path.is_none() {
        return item;
    }
    // Adapters (pi-acp/vibe-acp) do not own the upstream CLI version.
    let Some(version_path) = resolve_version_launcher(preset, &path.unwrap(), &recipe.command)
    else {
        item.probe_status = "failed";
        return item;
    };
    match version_output(&version_path, &recipe.args).await {
        Ok(output) => {
            item.version = parse_version(&output, &recipe.regex);
            item.probe_status = if item.version.is_some() {
                "ok"
            } else {
                "unrecognized"
            };
        }
        Err(status) => item.probe_status = status,
    }
    item
}

pub(crate) async fn inventory() -> serde_json::Value {
    let policy = HarnessPolicy::load();
    let mut items = Vec::new();
    // Serial probes cap process concurrency at one and total duration at 18 * 5s.
    for preset in agent_presets() {
        items.push(probe(preset, &policy).await);
    }
    serde_json::json!({ "schemaVersion": 1,
        "capturedAt": time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339).unwrap(),
        "items": items,
    })
}

/// Last registry answer per preset, read when Hub reports a release or the
/// owner refreshes; never on a timer.
static LATEST_VERSIONS: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());

fn cached_latest_version(preset_id: &str) -> Option<String> {
    LATEST_VERSIONS.lock().ok()?.get(preset_id).cloned()
}

/// Bounded like the version capture: visible ASCII package-version characters.
pub(crate) fn valid_latest_version(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-'))
}

fn valid_package_name(name: &str) -> bool {
    (1..=214).contains(&name.len())
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'@' | b'/' | b'.' | b'_' | b'-')
        })
}

pub(crate) fn latest_version_url(kind: LatestRegistry, package: &str) -> Option<String> {
    if !valid_package_name(package) {
        return None;
    }
    Some(match kind {
        LatestRegistry::Npm => format!(
            "https://registry.npmjs.org/{}/latest",
            package.replace('/', "%2f")
        ),
        LatestRegistry::Pypi => format!("https://pypi.org/pypi/{package}/json"),
    })
}

pub(crate) fn latest_version_from_body(kind: LatestRegistry, body: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let version = match kind {
        LatestRegistry::Npm => value.get("version"),
        LatestRegistry::Pypi => value.get("info").and_then(|info| info.get("version")),
    }?
    .as_str()?;
    valid_latest_version(version).then(|| version.to_string())
}

async fn fetch_latest_version(kind: LatestRegistry, package: &str) -> Option<String> {
    let url = latest_version_url(kind, package)?;
    let fetch = async {
        let mut response = xmatrix_cli_core::http::client()
            .ok()?
            .get(&url)
            .header("accept", "application/json")
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            if body.len() + chunk.len() > LATEST_MAX_BODY {
                return None;
            }
            body.extend_from_slice(&chunk);
        }
        latest_version_from_body(kind, &body)
    };
    tokio::time::timeout(LATEST_TIMEOUT, fetch).await.ok()?
}

/// The newest published version of one preset, read from its registry now.
/// A failed read keeps the last answer.
pub(crate) async fn read_latest_version(preset: &AgentPreset) -> Option<String> {
    let latest = preset.management.as_ref()?.latest.as_ref()?;
    let version = fetch_latest_version(latest.kind, &latest.package).await?;
    if let Ok(mut cache) = LATEST_VERSIONS.lock() {
        cache.insert(preset.id.clone(), version.clone());
    }
    Some(version)
}

/// Probe every preset and publish it to Hub.
pub(crate) async fn report_inventory(relay: &MachineDaemonConnectionClient) {
    if let Err(error) = relay.report_harness_inventory(inventory().await) {
        eprintln!("Harness inventory report deferred: {error}");
    }
}

pub(crate) struct InventoryReportTask(tokio::task::JoinHandle<()>);

impl Drop for InventoryReportTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// A harness installed, linked or removed outside xMatrix changes nothing
/// xMatrix observes, so the daemon also re-probes on this cadence.
const INVENTORY_REPROBE: std::time::Duration = std::time::Duration::from_secs(6 * 3600);

/// The daemon's start is when Hub first needs this machine's harnesses; later
/// reports follow the events that change them (releases, updates, actions),
/// plus a periodic re-probe for changes made outside xMatrix.
/// Hub tells a daemon whose inventory lacks a preset's latest version.
pub(crate) fn spawn_inventory_report(
    relay: Arc<MachineDaemonConnectionClient>,
) -> InventoryReportTask {
    InventoryReportTask(tokio::spawn(async move {
        let mut every = tokio::time::interval(INVENTORY_REPROBE);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            report_inventory(&relay).await;
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_cursor_alias_probes_the_resolved_binary_while_adapters_probe_the_cli() {
        let cursor = agent_presets().iter().find(|p| p.id == "cursor").unwrap();
        let legacy = Path::new("/legacy/cursor-agent");
        assert_eq!(
            resolve_version_launcher(cursor, legacy, "agent"),
            Some(legacy.to_path_buf())
        );
        for (id, command) in [("pi", "pi"), ("vibe", "vibe")] {
            let preset = agent_presets().iter().find(|p| p.id == id).unwrap();
            assert_eq!(
                resolve_version_launcher(preset, Path::new("/adapter"), command),
                which::which(command).ok()
            );
        }
    }

    #[test]
    fn cursor_never_uses_an_unrelated_agent_and_prefers_its_named_launcher() {
        let root =
            std::env::temp_dir().join(format!("xmatrix-cursor-identity-{}", uuid::Uuid::new_v4()));
        let grok = root.join(".grok").join("bin");
        let cursor = root.join("cursor");
        std::fs::create_dir_all(&grok).unwrap();
        std::fs::create_dir_all(&cursor).unwrap();
        let suffix = if cfg!(windows) { ".cmd" } else { "" };
        let write_launcher = |directory: &Path, name: &str| {
            let path = directory.join(format!("{name}{suffix}"));
            std::fs::write(&path, b"fixture").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            path
        };
        let other = write_launcher(&grok, "agent");
        let preset = agent_presets()
            .iter()
            .find(|preset| preset.id == "cursor")
            .unwrap();
        let paths = std::env::join_paths([&grok, &cursor]).unwrap();
        assert_eq!(resolve_launcher_in(preset, &paths, &root), None);
        assert!(!cursor_launcher_candidate(&other, &root));
        let expected = write_launcher(&cursor, "cursor-agent");
        let alias = write_launcher(&cursor, "agent");
        assert_eq!(resolve_launcher_in(preset, &paths, &root), Some(expected));
        assert!(cursor_launcher_candidate(&alias, &root));
        // Generic-only preset consumers can use the alias only with sibling evidence.
        let mut generic = preset.clone();
        generic.launcher_names = vec![format!("agent{suffix}")];
        assert_eq!(resolve_launcher_in(&generic, &paths, &root), Some(alias));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cursor_update_binds_the_inventory_launcher_and_date_versions_stay_complete() {
        let preset = agent_presets()
            .iter()
            .find(|preset| preset.id == "cursor")
            .unwrap();
        assert_eq!(
            resolve_recipe_program("cursor", "agent"),
            resolve_launcher(preset)
        );
        assert_eq!(
            resolve_recipe_program("cursor", "cursor-agent"),
            resolve_launcher(preset)
        );
        assert_eq!(
            resolve_recipe_program("codex", "npm"),
            which::which("npm").ok()
        );
        let pattern = &preset
            .management
            .as_ref()
            .unwrap()
            .version
            .as_ref()
            .unwrap()
            .regex;
        assert_eq!(
            parse_version(b"2026.09.28-64d2043", pattern).as_deref(),
            Some("2026.09.28-64d2043")
        );
    }

    #[test]
    fn versions_are_extracted_without_persisting_diagnostics() {
        let pattern = "([0-9]+(?:\\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?)";
        for text in [
            "codex-cli 0.128.0",
            "2.1.100 (Claude Code)",
            "v1.2.3-beta.1",
        ] {
            assert!(parse_version(text.as_bytes(), pattern).is_some());
        }
        assert_eq!(
            parse_version(b"secret-token-without-version", pattern),
            None
        );
        assert_eq!(parse_version(b"1.2.3", "("), None);
        assert_eq!(parse_version(&[0xff], pattern), None);
        assert_eq!(parse_version(&[b'1'; 200], "([0-9]+)"), None);
    }

    #[test]
    fn latest_versions_are_validated_and_bounded() {
        for valid in ["1.2.3", "0.128.0-alpha.1", "2.0.0+build.7", "v1"] {
            assert!(valid_latest_version(valid), "{valid}");
        }
        for invalid in ["", "1.2.3 ", "1.2\n3", "1/2", "<script>", &"9".repeat(129)] {
            assert!(!valid_latest_version(invalid), "{invalid}");
        }
        assert_eq!(
            latest_version_from_body(LatestRegistry::Npm, br#"{"name":"x","version":"1.4.0"}"#),
            Some("1.4.0".into())
        );
        assert_eq!(
            latest_version_from_body(LatestRegistry::Pypi, br#"{"info":{"version":"2.1.0"}}"#),
            Some("2.1.0".into())
        );
        assert_eq!(
            latest_version_from_body(LatestRegistry::Npm, br#"{"version":"1.0 rm -rf"}"#),
            None
        );
        assert_eq!(
            latest_version_from_body(LatestRegistry::Pypi, br#"{"version":"1.0"}"#),
            None
        );
        assert_eq!(
            latest_version_from_body(LatestRegistry::Npm, b"not json"),
            None
        );
        assert_eq!(
            latest_version_url(LatestRegistry::Npm, "@openai/codex").as_deref(),
            Some("https://registry.npmjs.org/@openai%2fcodex/latest")
        );
        assert_eq!(
            latest_version_url(LatestRegistry::Pypi, "mistral-vibe").as_deref(),
            Some("https://pypi.org/pypi/mistral-vibe/json")
        );
        assert_eq!(latest_version_url(LatestRegistry::Npm, "../x?y"), None);
        // Every registry package in the compiled presets forms a valid URL.
        for preset in agent_presets() {
            if let Some(latest) = preset.management.as_ref().and_then(|m| m.latest.as_ref()) {
                assert!(latest_version_url(latest.kind, &latest.package).is_some());
            }
        }
    }

    #[tokio::test]
    async fn missing_binary_does_not_execute_a_probe() {
        let mut preset = agent_presets()[0].clone();
        preset.launcher_names = vec!["xmatrix-no-such-harness-8f76ad".into()];
        let item = probe_launcher(&preset).await;
        assert!(!item.installed);
        assert_eq!(item.probe_status, "missing");
        assert!(item.path.is_none() && item.version.is_none());
    }

    #[tokio::test]
    async fn probe_process_success_failure_overflow_and_timeout() {
        let path = which::which(if cfg!(windows) { "powershell" } else { "sh" }).unwrap();
        let cases = if cfg!(windows) {
            [
                ("Write-Output 'tool 1.2.3'", "ok"),
                ("exit 7", "failed"),
                ("Write-Output ('x' * 20000)", "unrecognized"),
                ("Start-Sleep -Seconds 30", "timeout"),
            ]
        } else {
            [
                ("printf 'tool 1.2.3'", "ok"),
                ("exit 7", "failed"),
                ("head -c 20000 /dev/zero", "unrecognized"),
                ("sleep 30", "timeout"),
            ]
        };
        for (script, expected) in cases {
            let args = if cfg!(windows) {
                vec!["-NoProfile".into(), "-Command".into(), script.into()]
            } else {
                vec!["-c".into(), script.into()]
            };
            let result = version_output(&path, &args).await;
            if expected == "ok" {
                assert!(result.is_ok());
            } else {
                assert_eq!(result.unwrap_err(), expected);
            }
        }
    }
}
