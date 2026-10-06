//! Structured installation identity and Run-scoped launch evidence.
//! No field in these records selects an executable or grants local OS access.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRegistrationKey {
    pub owner_user_id: String,
    pub machine_id: String,
    pub harness: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpaceAgentRegistrationKey {
    pub space_id: String,
    pub owner_user_id: String,
    pub machine_id: String,
    pub harness: String,
}

impl AgentRegistrationKey {
    pub fn validate(&self) -> Result<(), String> {
        identity(&self.owner_user_id)?;
        identity(&self.machine_id)?;
        let harness = &self.harness;
        if harness.is_empty()
            || harness.len() > 80
            || !harness.as_bytes()[0].is_ascii_lowercase()
            || harness == "custom"
            || !harness
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        {
            return Err("Registration requires a canonical harness".into());
        }
        Ok(())
    }
}

impl SpaceAgentRegistrationKey {
    pub fn installation(&self) -> AgentRegistrationKey {
        AgentRegistrationKey {
            owner_user_id: self.owner_user_id.clone(),
            machine_id: self.machine_id.clone(),
            harness: self.harness.clone(),
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        identity(&self.space_id)?;
        self.installation().validate()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationLaunchResources {
    pub workspaces: Vec<String>,
    pub models: Vec<String>,
    /// Retired: secrets belong to the Space and a Run reads one when it needs
    /// it. The Hub still sends an empty list for daemons that require it.
    #[serde(default)]
    pub secrets: Vec<String>,
    pub capabilities: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationLaunchBinding {
    pub schema_version: u32,
    pub key: SpaceAgentRegistrationKey,
    pub run_id: String,
    pub instance_id: String,
    pub allocation_id: String,
    pub authorization_digest: String,
    pub environment_version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_model: Option<String>,
    pub resources: RegistrationLaunchResources,
}

impl RegistrationLaunchBinding {
    pub fn validate(&self) -> Result<(), String> {
        self.key.validate()?;
        if let Some(model) = &self.runtime_model {
            identity(model)?;
        }
        for value in [&self.run_id, &self.instance_id, &self.allocation_id] {
            identity(value)?;
        }
        if self.schema_version != 1
            || self.environment_version == 0
            || self.environment_version > 9_007_199_254_740_991
            || self.authorization_digest.len() != 64
            || !self
                .authorization_digest
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            // No workspace reference means a private managed directory.
            || self.resources.workspaces.len() > 1
            || self.resources.models.len() > 1
            || self.resources.models.is_empty() != self.runtime_model.is_none()
        {
            return Err("Invalid registration launch authority".into());
        }
        for references in [
            &self.resources.workspaces,
            &self.resources.models,
            &self.resources.secrets,
            &self.resources.capabilities,
        ] {
            let mut seen = HashSet::new();
            if references.len() > 100 {
                return Err("Registration resource bound exceeded".into());
            }
            for reference in references {
                identity(reference)?;
                if reference.contains('*') || !seen.insert(reference) {
                    return Err("Invalid registration resource reference".into());
                }
            }
        }
        Ok(())
    }

    pub fn require_target(
        &self,
        machine_id: &str,
        space_id: &str,
        run_id: Option<&str>,
        instance_id: Option<&str>,
    ) -> Result<(), String> {
        self.validate()?;
        if self.key.machine_id != machine_id
            || self.key.space_id != space_id
            || run_id != Some(self.run_id.as_str())
            || instance_id != Some(self.instance_id.as_str())
        {
            return Err("Registration launch does not match this execution target".into());
        }
        Ok(())
    }
}

fn identity(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > 300
        || value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
    {
        return Err("Invalid registration identity or resource reference".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn binding() -> serde_json::Value {
        serde_json::json!({"schemaVersion":1,"key":{"spaceId":"space","ownerUserId":"owner","machineId":"machine","harness":"codex"},
            "runId":"run","instanceId":"instance","allocationId":"allocation","authorizationDigest":"a".repeat(64),"environmentVersion":1,"runtimeModel":"provider/model",
            "resources":{"workspaces":["repo"],"models":["model"],"secrets":[],"capabilities":[]}})
    }
    #[test]
    fn structured_binding_checks_all_execution_dimensions() {
        let value: RegistrationLaunchBinding = serde_json::from_value(binding()).unwrap();
        let current = serde_json::to_value(&value).unwrap();
        serde_json::from_value::<RegistrationLaunchBinding>(current)
            .unwrap()
            .validate()
            .unwrap();
        value
            .require_target("machine", "space", Some("run"), Some("instance"))
            .unwrap();
        for (machine, space, run, instance) in [
            ("other", "space", "run", "instance"),
            ("machine", "other", "run", "instance"),
            ("machine", "space", "other", "instance"),
            ("machine", "space", "run", "other"),
        ] {
            assert!(
                value
                    .require_target(machine, space, Some(run), Some(instance))
                    .is_err()
            );
        }
        assert!(
            value
                .require_target("machine", "space", None, Some("instance"))
                .is_err()
        );
        // No workspace is a private managed directory; two is never admitted.
        for (workspaces, valid) in [
            (serde_json::json!([]), true),
            (serde_json::json!(["repo", "other"]), false),
        ] {
            let mut changed = binding();
            changed["resources"]["workspaces"] = workspaces;
            let parsed: RegistrationLaunchBinding = serde_json::from_value(changed).unwrap();
            assert_eq!(parsed.validate().is_ok(), valid);
        }
    }
    #[test]
    fn launch_cannot_smuggle_installation_or_surrogate_identity_fields() {
        for field in [
            "runtime",
            "env",
            "agentId",
            "profileId",
            "backend",
            "sandboxMode",
        ] {
            let mut value = binding();
            value[field] = serde_json::json!("injected");
            assert!(serde_json::from_value::<RegistrationLaunchBinding>(value).is_err());
        }
        let mut value = binding();
        value["key"]["configurationId"] = serde_json::json!("extra");
        assert!(serde_json::from_value::<RegistrationLaunchBinding>(value).is_err());
    }
    #[test]
    fn broad_or_unversioned_grants_are_not_launch_evidence() {
        for (field, invalid) in [
            ("schemaVersion", serde_json::json!(2)),
            ("environmentVersion", serde_json::json!(0)),
            ("authorizationDigest", serde_json::json!("F".repeat(64))),
        ] {
            let mut value = binding();
            value[field] = invalid;
            assert!(
                serde_json::from_value::<RegistrationLaunchBinding>(value)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
        let mut value = binding();
        value["resources"]["models"] = serde_json::json!(["model", "other"]);
        assert!(
            serde_json::from_value::<RegistrationLaunchBinding>(value)
                .unwrap()
                .validate()
                .is_err()
        );
    }
}
