//! Official prompt transport, independent of tasks and registration instructions.
use serde::{Deserialize, Serialize};

pub const ENV: &str = "XMATRIX_HUB_BOOTSTRAP_PROMPTS";
const MAX_BYTES: usize = 32 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BootstrapPrompts {
    pub schema_version: u32,
    pub bootstrap: String,
    pub channel_contract: String,
    pub channel_turn: String,
    pub goal_command: String,
    pub space_rules: String,
    pub connected_apps: String,
    pub working_mode_autonomous: String,
    pub working_mode_cautious: String,
}

impl Default for BootstrapPrompts {
    fn default() -> Self {
        Self {
            schema_version: 1,
            bootstrap: include_str!("../prompts/bootstrap.md").into(),
            channel_contract: include_str!("../prompts/channel-contract.md").into(),
            channel_turn: include_str!("../prompts/channel-turn.md").into(),
            goal_command: include_str!("../prompts/goal-command.md").into(),
            space_rules: include_str!("../prompts/space-rules.md").into(),
            connected_apps: include_str!("../prompts/connected-apps.md").into(),
            working_mode_autonomous: include_str!("../prompts/working-mode-autonomous.md").into(),
            working_mode_cautious: include_str!("../prompts/working-mode-cautious.md").into(),
        }
    }
}

impl BootstrapPrompts {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err(format!(
                "unsupported Hub bootstrap schema {}",
                self.schema_version
            ));
        }
        let fields = [
            &self.bootstrap,
            &self.channel_contract,
            &self.channel_turn,
            &self.goal_command,
            &self.space_rules,
            &self.connected_apps,
            &self.working_mode_autonomous,
            &self.working_mode_cautious,
        ];
        if fields
            .iter()
            .any(|text| text.trim().is_empty() || text.contains('\0'))
        {
            return Err("Hub bootstrap text must be nonempty and contain no NUL".into());
        }
        if serde_json::to_vec(self)
            .map_err(|err| err.to_string())?
            .len()
            > MAX_BYTES
        {
            return Err("Hub bootstrap exceeds 32 KiB".into());
        }
        Ok(())
    }

    pub fn from_json(json: &str) -> Result<Self, String> {
        if json.len() > MAX_BYTES {
            return Err("Hub bootstrap exceeds 32 KiB".into());
        }
        let prompts: Self = serde_json::from_str(json).map_err(|err| err.to_string())?;
        prompts.validate()?;
        Ok(prompts)
    }

    /// Absence is old-Hub compatibility. Invalid supplied data never falls back.
    pub fn from_env() -> Self {
        match std::env::var(ENV) {
            Ok(json) => Self::from_json(&json).unwrap_or_else(|err| panic!("{ENV}: {err}")),
            Err(std::env::VarError::NotPresent) => Self::default(),
            Err(err) => panic!("{ENV}: {err}"),
        }
    }
}
