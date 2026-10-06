//! The owner's recorded automatic-update policy per harness and the native
//! switches it drives. Every switch comes from the compiled registry; a policy
//! file names only preset ids and booleans.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use xmatrix_cli_agent::management::{
    AutoUpdateBehavior, AutoUpdateControl, DisableSignal, FileControl, HarnessManagement,
};
use xmatrix_cli_agent::{AgentPreset, agent_preset_by_id};
use xmatrix_cli_core::config;

const POLICY_FILE: &str = "harness-policy.json";

/// `{presetId: {"autoUpdate": bool}}`, read fresh at each decision so the CLI
/// and the daemon share one record without an in-memory copy going stale.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct HarnessPolicy(BTreeMap<String, bool>);

impl HarnessPolicy {
    pub(crate) fn path() -> PathBuf {
        config::config_dir().join(POLICY_FILE)
    }

    /// An unreadable file is no recorded policy: inventory reports upstream
    /// defaults and spawns add nothing, rather than guessing.
    pub(crate) fn load() -> Self {
        Self::read(&Self::path()).unwrap_or_default()
    }

    pub(crate) fn read(path: &Path) -> Result<Self, String> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default());
            }
            Err(error) => return Err(format!("{}: {error}", path.display())),
        };
        let value: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))?;
        let object = value
            .as_object()
            .ok_or_else(|| format!("{} is not a JSON object", path.display()))?;
        Ok(Self(
            object
                .iter()
                .filter_map(|(id, entry)| Some((id.clone(), entry.get("autoUpdate")?.as_bool()?)))
                .collect(),
        ))
    }

    pub(crate) fn auto_update(&self, preset_id: &str) -> Option<bool> {
        self.0.get(preset_id).copied()
    }

    /// Fails closed on a malformed file instead of overwriting the owner's
    /// other entries with a fresh document.
    pub(crate) fn record(path: &Path, preset_id: &str, enabled: bool) -> Result<(), String> {
        let parent = path
            .parent()
            .ok_or_else(|| "policy has no parent directory".to_string())?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let _lock = lock_policy(path)?;
        let mut policy = Self::read(path)?;
        policy.0.insert(preset_id.to_string(), enabled);
        let document: serde_json::Map<String, serde_json::Value> = policy
            .0
            .iter()
            .map(|(id, enabled)| (id.clone(), serde_json::json!({ "autoUpdate": enabled })))
            .collect();
        write_json_atomically(path, &serde_json::Value::Object(document))
    }
}

// Explicit unlock releases the shared open-file description even while a
// concurrently forked child retains its inherited descriptor before exec.
fn lock_policy(path: &Path) -> Result<crate::runtime_private_journal::JournalLock, String> {
    use fs2::FileExt;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path.with_extension("lock"))
        .map_err(|error| error.to_string())?;
    file.try_lock_exclusive()
        .map_err(|_| "another harness policy change is in progress".to_string())?;
    Ok(crate::runtime_private_journal::JournalLock(file))
}

/// Same-directory temporary file, then a replace-existing rename.
fn write_json_atomically(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    let temporary = config::unique_temporary_path(path);
    let written = std::fs::write(&temporary, &bytes)
        .and_then(|()| config::replace_file_atomically(&temporary, path));
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("{}: {error}", path.display()));
    }
    Ok(())
}

/// The state the harness itself would act on: its switches and disabling
/// conditions as configured on this machine, else its upstream default.
pub(crate) fn effective_auto_update(preset: &AgentPreset, policy: &HarnessPolicy) -> &'static str {
    observed_auto_update(preset, policy, dirs::home_dir().as_deref(), |key| {
        std::env::var(key).ok()
    })
}

fn observed_auto_update(
    preset: &AgentPreset,
    policy: &HarnessPolicy,
    home: Option<&Path>,
    process_env: impl Fn(&str) -> Option<String>,
) -> &'static str {
    let Some(management) = preset.management.as_ref() else {
        return "unknown";
    };
    let auto = &management.auto_update;
    if auto.behavior == AutoUpdateBehavior::Unsupported {
        return "unknown";
    }
    let state = |enabled| if enabled { "enabled" } else { "disabled" };
    let recorded = policy.auto_update(&preset.id);
    if schedules_updates(management) && auto.controls.is_empty() {
        // The daemon's schedule runs only while the recorded policy is on.
        return state(recorded == Some(true));
    }
    let file_env: BTreeMap<String, String> = auto
        .env_files
        .iter()
        .filter_map(|path| read_json(path, home).ok().flatten())
        .filter_map(|document| document.get("env")?.as_object().cloned())
        .flatten()
        .filter_map(|(key, value)| Some((key, value.as_str()?.to_string())))
        .collect();
    // An xMatrix launch sets or clears each env switch per the recorded policy;
    // the harness's own settings files still apply on top.
    let env = |key: &str| {
        file_env.get(key).cloned().or_else(|| {
            let switched = auto.controls.iter().any(
                |control| matches!(control, AutoUpdateControl::Env { key: k, .. } if k == key),
            );
            if switched && recorded.is_some() {
                None
            } else {
                process_env(key)
            }
        })
    };
    let mut observed = None;
    for control in &auto.controls {
        let value = match control {
            AutoUpdateControl::Json(file) => match read_json(&file.path, home) {
                Err(()) => return "unknown",
                Ok(document) => match document.as_ref().and_then(|d| dotted(d, &file.key)) {
                    None => None,
                    Some(value) if *value == file.enabled => Some(true),
                    Some(value) if *value == file.disabled => Some(false),
                    Some(_) => return "unknown",
                },
            },
            AutoUpdateControl::Env {
                key,
                enabled,
                disabled,
            } => match recorded {
                Some(false) => Some(false),
                Some(true) => enabled.as_ref().map(|_| true),
                None => env(key).and_then(|value| {
                    if value == *disabled {
                        Some(false)
                    } else if enabled.as_ref() == Some(&value) {
                        Some(true)
                    } else {
                        None
                    }
                }),
            },
            AutoUpdateControl::Flag { .. } => (recorded == Some(false)).then_some(false),
            // No read command exists; a successful switch is recorded.
            AutoUpdateControl::Command { .. } => recorded,
            AutoUpdateControl::Toml(_) => return "unknown",
        };
        if value == Some(false) {
            return "disabled";
        }
        observed = observed.or(value);
    }
    let disabled = auto.disabled_by.iter().any(|signal| match signal {
        DisableSignal::Env { key, values } => env(key).is_some_and(|value| {
            let value = value.trim().to_ascii_lowercase();
            if values.is_empty() {
                !value.is_empty()
            } else {
                values.iter().any(|v| v.eq_ignore_ascii_case(&value))
            }
        }),
        DisableSignal::Json {
            path,
            key,
            value,
            unless,
        } => read_json(path, home)
            .ok()
            .flatten()
            .is_some_and(|document| {
                dotted(&document, key) == Some(value)
                    && (unless.is_empty()
                        || !unless
                            .iter()
                            .all(|(key, value)| dotted(&document, key) == Some(value)))
            }),
    });
    if disabled {
        return "disabled";
    }
    observed
        .or(auto.default_enabled)
        .map(state)
        .unwrap_or("unknown")
}

/// `Ok(None)` when the file does not exist; `Err` when it cannot be read as JSON.
fn read_json(path: &str, home: Option<&Path>) -> Result<Option<serde_json::Value>, ()> {
    let path = expand_home(path, home.ok_or(())?).map_err(|_| ())?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = read_settings(&path).map_err(|_| ())?;
    serde_json::from_slice(&bytes).map(Some).map_err(|_| ())
}

fn dotted<'a>(document: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    key.split('.')
        .try_fold(document, |cursor, part| cursor.get(part))
}

/// Bound settings reads, including malformed or unexpectedly large documents.
fn read_settings(path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read;
    const MAX_SETTINGS: u64 = 1024 * 1024;
    let file = std::fs::File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(MAX_SETTINGS + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_SETTINGS {
        return Err("harness settings exceed 1 MiB".into());
    }
    Ok(bytes)
}

/// Harnesses that never update themselves are updated by the daemon.
pub(crate) fn schedules_updates(management: &HarnessManagement) -> bool {
    matches!(
        management.auto_update.behavior,
        AutoUpdateBehavior::Notify | AutoUpdateBehavior::Manual | AutoUpdateBehavior::Unknown
    ) && management.update.current().is_some()
}

/// Whether the daemon runs this harness's update recipe itself: for a harness
/// that never updates itself, while the owner's policy is on; for one whose
/// updater runs only in interactive sessions (never in an xMatrix launch),
/// whenever its switch shows on.
pub(crate) fn daemon_runs_updates(preset: &AgentPreset, policy: &HarnessPolicy) -> bool {
    runs_updates(preset, policy, || effective_auto_update(preset, policy))
}

fn runs_updates(
    preset: &AgentPreset,
    policy: &HarnessPolicy,
    observed: impl FnOnce() -> &'static str,
) -> bool {
    let Some(management) = preset.management.as_ref() else {
        return false;
    };
    if schedules_updates(management) {
        return policy.auto_update(&preset.id) == Some(true);
    }
    management.auto_update.interactive_only
        && management.update.current().is_some()
        && observed() == "enabled"
}

fn expand_home(path: &str, home: &Path) -> Result<PathBuf, String> {
    let relative = path
        .strip_prefix("~/")
        .filter(|rest| !rest.is_empty() && !rest.split('/').any(|part| part == ".."))
        .ok_or_else(|| format!("settings path {path} is not inside the home directory"))?;
    Ok(home.join(relative))
}

fn set_dotted_key(
    document: &mut serde_json::Value,
    dotted: &str,
    value: serde_json::Value,
) -> Result<(), String> {
    let mut parts = dotted.split('.').peekable();
    let mut cursor = document;
    while let Some(part) = parts.next() {
        if part.is_empty() {
            return Err(format!("invalid settings key {dotted}"));
        }
        let object = cursor
            .as_object_mut()
            .ok_or_else(|| format!("settings key {dotted} crosses a non-object value"))?;
        if parts.peek().is_none() {
            object.insert(part.to_string(), value);
            return Ok(());
        }
        cursor = object
            .entry(part.to_string())
            .or_insert_with(|| serde_json::Value::Object(Default::default()));
    }
    Err(format!("invalid settings key {dotted}"))
}

/// Set one registry-named switch in a JSON settings file, creating the file
/// and its parents when absent and keeping every other key. A file that is not
/// plain JSON (for example JSON with comments) is left untouched.
pub(crate) fn set_json_control(
    control: &FileControl,
    enabled: bool,
    home: &Path,
) -> Result<PathBuf, String> {
    let path = expand_home(&control.path, home)?;
    match std::fs::metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return create_json_control(control, enabled, home);
        }
        Err(error) => return Err(error.to_string()),
        Ok(_) => {}
    }
    let mut document = match read_settings(&path) {
        Ok(bytes) if bytes.iter().all(u8::is_ascii_whitespace) => serde_json::json!({}),
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
            format!(
                "{} is not plain JSON; it was left unchanged",
                path.display()
            )
        })?,
        Err(error) => return Err(error),
    };
    if !document.is_object() {
        return Err(format!("{} is not a JSON object", path.display()));
    }
    let value = if enabled {
        control.enabled
    } else {
        control.disabled
    };
    set_dotted_key(&mut document, &control.key, serde_json::Value::Bool(value))?;
    write_json_atomically(&path, &document)?;
    Ok(path)
}

fn create_json_control(
    control: &FileControl,
    enabled: bool,
    home: &Path,
) -> Result<PathBuf, String> {
    let path = expand_home(&control.path, home)?;
    let mut document = serde_json::json!({});
    set_dotted_key(
        &mut document,
        &control.key,
        serde_json::Value::Bool(if enabled {
            control.enabled
        } else {
            control.disabled
        }),
    )?;
    write_json_atomically(&path, &document)?;
    Ok(path)
}

/// Launch-time additions for one Run of `preset_id` while its recorded policy
/// is off: the preset's env switch and disabled flag, nothing else.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SpawnAutoUpdate {
    pub(crate) runtime_args: Vec<String>,
    pub(crate) acp_args: Vec<String>,
    pub(crate) env: Vec<(String, String)>,
    pub(crate) remove_env: Vec<String>,
}

pub(crate) fn spawn_auto_update_overrides(
    preset_id: Option<&str>,
    backend: Option<&str>,
    runtime_args: &[String],
    acp_args: &[String],
) -> SpawnAutoUpdate {
    spawn_overrides_with_policy(
        &HarnessPolicy::load(),
        preset_id,
        backend,
        runtime_args,
        acp_args,
    )
}

pub(crate) fn spawn_overrides_with_policy(
    policy: &HarnessPolicy,
    preset_id: Option<&str>,
    backend: Option<&str>,
    runtime_args: &[String],
    acp_args: &[String],
) -> SpawnAutoUpdate {
    let mut overrides = SpawnAutoUpdate {
        runtime_args: runtime_args.to_vec(),
        acp_args: acp_args.to_vec(),
        env: Vec::new(),
        remove_env: Vec::new(),
    };
    let Some(preset) = preset_id
        .and_then(agent_preset_by_id)
        .filter(|preset| Some(preset.id.as_str()) == preset_id)
    else {
        return overrides;
    };
    let Some(enabled_policy) = policy.auto_update(&preset.id) else {
        return overrides;
    };
    let Some(management) = preset.management.as_ref() else {
        return overrides;
    };
    for control in &management.auto_update.controls {
        match control {
            AutoUpdateControl::Env {
                key,
                enabled,
                disabled,
            } => {
                if !enabled_policy {
                    overrides.env.push((key.clone(), disabled.clone()));
                } else if let Some(value) = enabled {
                    overrides.env.push((key.clone(), value.clone()));
                } else {
                    overrides.remove_env.push(key.clone());
                }
            }
            AutoUpdateControl::Flag { disabled } => {
                if enabled_policy {
                    overrides.runtime_args.retain(|arg| arg != disabled);
                    overrides.acp_args.retain(|arg| arg != disabled);
                    continue;
                }
                // An ACP launch without explicit argv uses its ACP args, which
                // default to the preset's own (see `generic_acp_spawn_args`).
                let args = if backend == Some("acp") && overrides.runtime_args.is_empty() {
                    if overrides.acp_args.is_empty() {
                        overrides.acp_args = preset
                            .acp_args
                            .clone()
                            .unwrap_or_else(|| vec!["acp".to_string()]);
                    }
                    &mut overrides.acp_args
                } else {
                    &mut overrides.runtime_args
                };
                if !args.contains(disabled) {
                    args.push(disabled.clone());
                }
            }
            AutoUpdateControl::Json(_)
            | AutoUpdateControl::Toml(_)
            | AutoUpdateControl::Command { .. } => {}
        }
    }
    overrides
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "xmatrix-harness-policy-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn policy_persists_atomically_and_keeps_other_presets() {
        let dir = temp_dir("persist");
        let path = dir.join("nested").join(POLICY_FILE);
        assert_eq!(
            HarnessPolicy::read(&path).unwrap(),
            HarnessPolicy::default()
        );
        HarnessPolicy::record(&path, "codex", true).unwrap();
        HarnessPolicy::record(&path, "claude", false).unwrap();
        HarnessPolicy::record(&path, "codex", false).unwrap();
        let policy = HarnessPolicy::read(&path).unwrap();
        assert_eq!(policy.auto_update("codex"), Some(false));
        assert_eq!(policy.auto_update("claude"), Some(false));
        assert_eq!(policy.auto_update("gemini"), None);
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(raw["claude"], serde_json::json!({"autoUpdate": false}));
        // No temporary file is left beside the record.
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            2
        );
        // A malformed record is never overwritten.
        std::fs::write(&path, b"{not json").unwrap();
        assert!(HarnessPolicy::record(&path, "codex", true).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{not json");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn policy_unlocks_while_an_inherited_descriptor_remains_open() {
        let dir = temp_dir("inherited-lock");
        let path = dir.join(POLICY_FILE);
        let held = lock_policy(&path).unwrap();
        let inherited = held.0.try_clone().unwrap();
        assert!(
            HarnessPolicy::record(&path, "codex", true)
                .unwrap_err()
                .contains("in progress")
        );
        drop(held);
        // A dup models the open description a concurrent fork retains. The
        // policy critical section ended, so a new writer must be admitted.
        HarnessPolicy::record(&path, "codex", true).unwrap();
        assert_eq!(
            HarnessPolicy::read(&path).unwrap().auto_update("codex"),
            Some(true)
        );
        drop(inherited);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn observations_report_what_the_harness_would_do() {
        let home = temp_dir("observed");
        let empty = HarnessPolicy::default();
        let preset = |id| agent_preset_by_id(id).unwrap();
        let observed = |id, policy| observed_auto_update(preset(id), policy, Some(&home), |_| None);
        // Nothing configured: a built-in updater runs at its upstream default,
        // and the daemon's schedule runs only once the owner turns it on.
        for (id, state) in [
            ("claude", "enabled"),
            ("cursor", "enabled"),
            ("gemini", "enabled"),
            ("openclaw", "disabled"),
            ("codex", "disabled"),
            ("kiro", "enabled"),
            ("custom", "unknown"),
        ] {
            assert_eq!(observed(id, &empty), state, "{id}");
        }
        let mut policy = empty.clone();
        policy.0.insert("gemini".into(), true);
        policy.0.insert("codex".into(), true);
        policy.0.insert("claude".into(), false);
        policy.0.insert("kiro".into(), false);
        assert_eq!(observed("codex", &policy), "enabled");
        assert_eq!(observed("claude", &policy), "disabled");
        assert_eq!(observed("kiro", &policy), "disabled");
        let AutoUpdateControl::Json(control) = &preset("gemini")
            .management
            .as_ref()
            .unwrap()
            .auto_update
            .controls[0]
        else {
            panic!();
        };
        let path = set_json_control(control, false, &home).unwrap();
        assert_eq!(observed("gemini", &policy), "disabled");
        set_json_control(control, true, &home).unwrap();
        assert_eq!(observed("gemini", &policy), "enabled");
        std::fs::write(&path, b"not json").unwrap();
        assert_eq!(observed("gemini", &policy), "unknown");
        assert!(schedules_updates(
            preset("codex").management.as_ref().unwrap()
        ));
        assert!(!schedules_updates(
            preset("claude").management.as_ref().unwrap()
        ));
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn claude_follows_its_own_updater_gate() {
        let home = temp_dir("claude-gate");
        let empty = HarnessPolicy::default();
        let claude = agent_preset_by_id("claude").unwrap();
        let observed = |policy: &HarnessPolicy, vars: &[(&str, &str)]| {
            let vars: BTreeMap<String, String> = vars
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            observed_auto_update(claude, policy, Some(&home), |key| vars.get(key).cloned())
        };
        assert_eq!(observed(&empty, &[]), "enabled");
        assert_eq!(
            observed(&empty, &[("DISABLE_AUTOUPDATER", "true")]),
            "disabled"
        );
        assert_eq!(observed(&empty, &[("DISABLE_AUTOUPDATER", "0")]), "enabled");
        assert_eq!(observed(&empty, &[("DISABLE_UPDATES", "x")]), "disabled");
        assert_eq!(
            observed(&empty, &[("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")]),
            "disabled"
        );
        let mut on = HarnessPolicy::default();
        on.0.insert("claude".into(), true);
        // xMatrix clears the switch on its own launches.
        assert_eq!(observed(&on, &[("DISABLE_AUTOUPDATER", "1")]), "enabled");

        let global = home.join(".claude.json");
        std::fs::write(&global, br#"{"autoUpdates":false,"installMethod":"npm"}"#).unwrap();
        assert_eq!(observed(&empty, &[]), "disabled");
        std::fs::write(
            &global,
            br#"{"autoUpdates":false,"installMethod":"native","autoUpdatesProtectedForNative":true}"#,
        )
        .unwrap();
        assert_eq!(observed(&empty, &[]), "enabled");

        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(
            home.join(".claude/settings.json"),
            br#"{"env":{"DISABLE_AUTOUPDATER":"1"}}"#,
        )
        .unwrap();
        assert_eq!(observed(&empty, &[]), "disabled");
        assert_eq!(observed(&on, &[]), "disabled");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn daemon_updates_harnesses_whose_updater_never_runs_in_a_launch() {
        let preset = |id| agent_preset_by_id(id).unwrap();
        let empty = HarnessPolicy::default();
        let mut on = HarnessPolicy::default();
        on.0.insert("codex".into(), true);
        // Claude's updater skips --print, so its switch alone decides.
        assert!(runs_updates(preset("claude"), &empty, || "enabled"));
        assert!(!runs_updates(preset("claude"), &empty, || "disabled"));
        assert!(!runs_updates(preset("claude"), &empty, || "unknown"));
        // A harness without an updater waits for the owner's policy.
        assert!(!runs_updates(preset("codex"), &empty, || "enabled"));
        assert!(runs_updates(preset("codex"), &on, || "disabled"));
        // One that updates itself in a launch is left to do so.
        assert!(!runs_updates(preset("copilot"), &empty, || "enabled"));
    }

    #[test]
    fn enabling_launch_controls_clears_inherited_disable_switches() {
        let mut policy = HarnessPolicy::default();
        policy.0.insert("claude".into(), true);
        policy.0.insert("copilot".into(), true);
        policy.0.insert("junie".into(), true);
        let claude = spawn_overrides_with_policy(&policy, Some("claude"), None, &[], &[]);
        assert_eq!(claude.remove_env, vec!["DISABLE_AUTOUPDATER"]);
        let copilot = spawn_overrides_with_policy(&policy, Some("copilot"), None, &[], &[]);
        assert_eq!(
            copilot.env,
            vec![("COPILOT_AUTO_UPDATE".into(), "true".into())]
        );
        let junie = spawn_overrides_with_policy(
            &policy,
            Some("junie"),
            Some("acp"),
            &[],
            &["--skip-update-check".into()],
        );
        assert!(junie.acp_args.is_empty());
    }

    #[test]
    fn json_control_sets_nested_key_and_preserves_other_keys() {
        let home = temp_dir("json");
        let control = FileControl {
            path: "~/.gemini/settings.json".into(),
            key: "general.enableAutoUpdate".into(),
            enabled: true,
            disabled: false,
        };
        // Absent file and parents are created.
        let path = set_json_control(&control, false, &home).unwrap();
        assert_eq!(path, home.join(".gemini/settings.json"));
        let read = || -> serde_json::Value {
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap()
        };
        assert_eq!(
            read(),
            serde_json::json!({"general": {"enableAutoUpdate": false}})
        );
        std::fs::write(
            &path,
            br#"{"theme":"dark","general":{"vimMode":true,"enableAutoUpdate":false},"mcp":[1,2]}"#,
        )
        .unwrap();
        set_json_control(&control, true, &home).unwrap();
        assert_eq!(
            read(),
            serde_json::json!({
                "theme": "dark",
                "general": {"vimMode": true, "enableAutoUpdate": true},
                "mcp": [1, 2]
            })
        );
        // JSON with comments, a non-object root, or a scalar on the key path
        // fails and leaves the file as it was.
        for original in [
            &b"{ // comment\n \"a\": 1 }"[..],
            b"[1, 2]",
            br#"{"general": "flat"}"#,
        ] {
            std::fs::write(&path, original).unwrap();
            assert!(set_json_control(&control, true, &home).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), original);
        }
        for escape in ["/etc/settings.json", "~/../x.json", "~/"] {
            let control = FileControl {
                path: escape.into(),
                ..control.clone()
            };
            assert!(set_json_control(&control, true, &home).is_err(), "{escape}");
        }
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn spawn_overrides_apply_only_to_the_disabled_preset() {
        let mut policy = HarnessPolicy::default();
        policy.0.insert("claude".into(), false);
        policy.0.insert("junie".into(), false);
        policy.0.insert("kimi".into(), true);
        let args = vec!["--dangerously-skip-permissions".to_string()];
        let claude = spawn_overrides_with_policy(&policy, Some("claude"), None, &args, &[]);
        assert_eq!(claude.runtime_args, args);
        assert_eq!(
            claude.env,
            vec![("DISABLE_AUTOUPDATER".to_string(), "1".to_string())]
        );
        // Policy on, no policy, or an unknown preset add nothing.
        for id in [Some("kimi"), Some("gemini"), Some("no-such"), None] {
            let none = spawn_overrides_with_policy(&policy, id, None, &args, &[]);
            assert!(none.env.is_empty() && none.runtime_args == args, "{id:?}");
        }
        // An ACP launch without explicit argv carries the flag in its ACP args.
        let junie = spawn_overrides_with_policy(&policy, Some("junie"), Some("acp"), &[], &[]);
        assert_eq!(
            junie.acp_args,
            vec!["--acp=true".to_string(), "--skip-update-check".to_string()]
        );
        assert!(junie.runtime_args.is_empty() && junie.env.is_empty());
        let explicit = spawn_overrides_with_policy(
            &policy,
            Some("junie"),
            Some("acp"),
            &["--acp=true".to_string(), "--skip-update-check".to_string()],
            &[],
        );
        assert_eq!(
            explicit.runtime_args,
            vec!["--acp=true".to_string(), "--skip-update-check".to_string()]
        );
        assert!(explicit.acp_args.is_empty());
    }
}
