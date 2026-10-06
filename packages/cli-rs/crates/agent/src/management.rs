use std::collections::BTreeMap;

use serde::Deserialize;

/// The probe recipe is embedded from the canonical registry, never supplied by a Run.
#[derive(Debug, Clone, Deserialize)]
pub struct VersionProbe {
    pub command: String,
    pub args: Vec<String>,
    pub regex: String,
}

/// One argv from the compiled registry. The Hub only ever names a preset.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct HarnessCommand {
    pub command: String,
    pub args: Vec<String>,
}

/// `null` for a platform means no verified recipe, never a guess.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct PlatformRecipe {
    #[serde(default)]
    pub unix: Option<HarnessCommand>,
    #[serde(default)]
    pub windows: Option<HarnessCommand>,
}

impl PlatformRecipe {
    /// The recipe for the platform this binary was compiled for.
    pub fn current(&self) -> Option<&HarnessCommand> {
        if cfg!(windows) {
            self.windows.as_ref()
        } else {
            self.unix.as_ref()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AutoUpdateBehavior {
    Automatic,
    Notify,
    Manual,
    Unknown,
    Unsupported,
}

/// A settings-file switch; `path` may start with `~/`, `key` is dot-separated.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct FileControl {
    pub path: String,
    pub key: String,
    pub enabled: bool,
    pub disabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AutoUpdateControl {
    Env {
        key: String,
        enabled: Option<String>,
        disabled: String,
    },
    Json(FileControl),
    Toml(FileControl),
    Command {
        enable: HarnessCommand,
        disable: HarnessCommand,
    },
    Flag {
        disabled: String,
    },
}

/// An upstream condition that turns the built-in updater off. These are only
/// read, so the state shown is the one the harness itself would act on.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DisableSignal {
    /// `key` is set in the harness environment. `values` lists the
    /// case-insensitive values that count; empty means any non-empty value.
    Env {
        key: String,
        #[serde(default)]
        values: Vec<String>,
    },
    /// `key` in the JSON document at `path` equals `value`, unless every
    /// `unless` key holds its listed value.
    Json {
        path: String,
        key: String,
        value: serde_json::Value,
        #[serde(default)]
        unless: BTreeMap<String, serde_json::Value>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoUpdate {
    pub behavior: AutoUpdateBehavior,
    #[serde(default)]
    pub default_enabled: Option<bool>,
    #[serde(default)]
    pub controls: Vec<AutoUpdateControl>,
    #[serde(default)]
    pub disabled_by: Vec<DisableSignal>,
    /// JSON settings files whose `env` object the harness applies to its own
    /// environment, so their variables count as set.
    #[serde(default)]
    pub env_files: Vec<String>,
    /// The built-in updater runs only in interactive sessions, never in the
    /// headless mode xMatrix launches, so the daemon runs `update` in its
    /// place — beside live sessions, as the updater itself would.
    #[serde(default)]
    pub interactive_only: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LatestRegistry {
    Npm,
    Pypi,
}

/// The official registry that publishes a harness.
#[derive(Debug, Clone, Deserialize)]
pub struct LatestSource {
    pub kind: LatestRegistry,
    pub package: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessManagement {
    pub version: Option<VersionProbe>,
    #[serde(default)]
    pub install: PlatformRecipe,
    #[serde(default)]
    pub update: PlatformRecipe,
    /// Removes the program and keeps the user's settings and sessions.
    #[serde(default)]
    pub uninstall: PlatformRecipe,
    pub auto_update: AutoUpdate,
    #[serde(default)]
    pub latest: Option<LatestSource>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_presets;

    #[test]
    fn every_registry_recipe_deserializes_with_typed_controls() {
        for preset in agent_presets() {
            let management = preset
                .management
                .as_ref()
                .unwrap_or_else(|| panic!("{} has no management entry", preset.id));
            for recipe in [
                &management.install,
                &management.update,
                &management.uninstall,
            ] {
                for command in [recipe.unix.as_ref(), recipe.windows.as_ref()]
                    .into_iter()
                    .flatten()
                {
                    assert!(!command.command.is_empty(), "{}", preset.id);
                }
            }
            if management.auto_update.behavior == AutoUpdateBehavior::Unsupported {
                assert!(management.install.current().is_none(), "{}", preset.id);
            }
        }
        let claude = crate::agent_preset_by_id("claude").unwrap();
        let management = claude.management.as_ref().unwrap();
        assert_eq!(
            management.auto_update.controls[0],
            AutoUpdateControl::Env {
                key: "DISABLE_AUTOUPDATER".into(),
                enabled: None,
                disabled: "1".into(),
            }
        );
        assert_eq!(
            management.latest.as_ref().unwrap().kind,
            LatestRegistry::Npm
        );
        let gemini = crate::agent_preset_by_id("gemini").unwrap();
        assert!(matches!(
            &gemini.management.as_ref().unwrap().auto_update.controls[0],
            AutoUpdateControl::Json(FileControl { key, .. }) if key == "general.enableAutoUpdate"
        ));
        let vibe = crate::agent_preset_by_id("vibe").unwrap();
        assert_eq!(
            vibe.management
                .as_ref()
                .unwrap()
                .latest
                .as_ref()
                .unwrap()
                .kind,
            LatestRegistry::Pypi
        );
    }
}
