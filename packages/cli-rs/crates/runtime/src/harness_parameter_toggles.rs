//! Resolve a toggle once per authored message, before its native side effect.
use crate::{harness_parameters, protocol, runtime_private_journal as journal};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

const MAX_ENTRIES: usize = 256;
const MAX_BYTES: u64 = 131_072;

#[derive(Default, Serialize, Deserialize)]
struct Decisions {
    retired_through: u64,
    #[serde(default)]
    applied_through: BTreeMap<String, (u64, u64)>,
    entries: BTreeMap<String, Decision>,
}

#[derive(Serialize, Deserialize)]
struct Decision {
    sequence: u64,
    entity_version: u64,
    value: String,
    completed: bool,
}

fn path(agent: &protocol::SerializedAgent, message: &crate::InboundChannelMessage) -> PathBuf {
    let identity = format!(
        "{}\0{}",
        agent.instance_id.as_deref().unwrap_or(&agent.id),
        message.channel_id
    );
    let name = xmatrix_cli_core::hex::sha256_hex(identity.as_bytes());
    crate::config::profile_state_dir()
        .join("parameter-toggles")
        .join(format!("{name}.json"))
}

fn key(message: &crate::InboundChannelMessage, id: &str) -> String {
    format!(
        "{}:{}:{id}",
        message.message_id,
        message.entity_version.unwrap_or(1)
    )
}

fn read(path: &Path) -> Result<Decisions, String> {
    if !path.exists() {
        return Ok(Decisions::default());
    }
    journal::private(path, false)?;
    if std::fs::metadata(path).map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("Parameter toggle journal is too large".into());
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

fn locked(path: &Path) -> Result<journal::JournalLock, String> {
    let parent = path
        .parent()
        .ok_or("Parameter toggle journal has no directory")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    journal::private(parent, true)?;
    journal::lock(&path.with_extension("lock"))
}

fn write(path: &Path, decisions: &Decisions) -> Result<(), String> {
    let bytes = serde_json::to_vec(decisions).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Parameter toggle journal is too large".into());
    }
    journal::write_bytes(path, &bytes)
}

pub(crate) fn resolve(
    command: harness_parameters::ParameterCommand,
    parameters: &[protocol::HarnessParameter],
    message: &crate::InboundChannelMessage,
    agent: &protocol::SerializedAgent,
) -> Result<(String, Option<String>), String> {
    resolve_at(command, parameters, message, &path(agent, message))
}

fn resolve_at(
    command: harness_parameters::ParameterCommand,
    parameters: &[protocol::HarnessParameter],
    message: &crate::InboundChannelMessage,
    path: &Path,
) -> Result<(String, Option<String>), String> {
    let (id, action) = command?;
    match action {
        harness_parameters::ParameterAction::Query => return Ok((id, None)),
        harness_parameters::ParameterAction::Select(value) => return Ok((id, Some(value))),
        harness_parameters::ParameterAction::Toggle => (),
    }
    let parameter = parameters
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("Harness parameter '{id}' is unavailable"))?;
    if parameter.kind == Some(protocol::HarnessParameterKind::Enum) {
        return Err(format!("Harness parameter '{id}' is not a boolean switch"));
    }
    let (on, off) = harness_parameters::boolean_options(&parameter.options)
        .ok_or_else(|| format!("Harness parameter '{id}' is not a boolean switch"))?;
    let sequence = message.sequence.filter(|s| *s > 0).ok_or(
        "Cannot safely toggle a message without a delivery sequence; use an explicit value",
    )?;
    let _lock = locked(path)?;
    let mut decisions = read(path)?;
    let key = key(message, &id);
    let binding = parameter.alias_of.as_deref().unwrap_or(&id);
    if let Some(decision) = decisions.entries.get(&key) {
        let superseded = decisions
            .applied_through
            .get(binding)
            .is_some_and(|rank| *rank > (decision.sequence, decision.entity_version));
        return Ok((
            id,
            (!decision.completed && !superseded).then(|| decision.value.clone()),
        ));
    }
    if sequence <= decisions.retired_through {
        return Err("This toggle is outside the retained replay window; send a new command".into());
    }
    if decisions
        .applied_through
        .get(binding)
        .is_some_and(|rank| *rank > (sequence, message.entity_version.unwrap_or(1)))
    {
        return Ok((id, None));
    }
    let value = match parameter.current_value.as_deref() {
        Some(value) if value == on => off,
        Some(value) if value == off => on,
        _ => return Err("Provider state is unavailable; select on or off explicitly".into()),
    }
    .to_string();
    if decisions.entries.len() >= MAX_ENTRIES {
        let oldest = decisions
            .entries
            .iter()
            .filter(|(_, d)| d.completed)
            .min_by_key(|(_, d)| d.sequence)
            .map(|(k, d)| (k.clone(), d.sequence))
            .ok_or("Parameter toggle replay window has too many unfinished controls")?;
        decisions.retired_through = decisions.retired_through.max(oldest.1);
        decisions.entries.remove(&oldest.0);
    }
    decisions.entries.insert(
        key,
        Decision {
            sequence,
            entity_version: message.entity_version.unwrap_or(1),
            value: value.clone(),
            completed: false,
        },
    );
    write(path, &decisions)?;
    Ok((id, Some(value)))
}

pub(crate) fn complete(
    message: &crate::InboundChannelMessage,
    agent: &protocol::SerializedAgent,
    parameters: &[protocol::HarnessParameter],
) -> Result<(), String> {
    let Some(Ok((id, action))) =
        crate::single_message_parameter_control(std::slice::from_ref(message), agent)
    else {
        return Ok(());
    };
    if action == harness_parameters::ParameterAction::Query {
        return Ok(());
    }
    let path = path(agent, message);
    let binding = parameters
        .iter()
        .find(|p| p.id == id)
        .and_then(|p| p.alias_of.as_deref())
        .unwrap_or(&id);
    complete_binding_at(&path, message, &id, binding)
}

#[cfg(test)]
fn complete_at(
    path: &Path,
    message: &crate::InboundChannelMessage,
    id: &str,
) -> Result<(), String> {
    complete_binding_at(path, message, id, id)
}

fn complete_binding_at(
    path: &Path,
    message: &crate::InboundChannelMessage,
    id: &str,
    binding: &str,
) -> Result<(), String> {
    let _lock = locked(path)?;
    let mut decisions = read(path)?;
    let applied = decisions.applied_through.entry(binding.into()).or_default();
    *applied = (*applied).max((
        message.sequence.unwrap_or(0),
        message.entity_version.unwrap_or(1),
    ));
    if decisions.applied_through.len() > 64 {
        let (id, sequence) = decisions
            .applied_through
            .iter()
            .min_by_key(|(_, seq)| **seq)
            .map(|(id, sequence)| (id.clone(), *sequence))
            .unwrap();
        decisions.applied_through.remove(&id);
        decisions.retired_through = decisions.retired_through.max(sequence.0);
    }
    if let Some(decision) = decisions.entries.get_mut(&key(message, id)) {
        decision.completed = true;
    }
    write(path, &decisions)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn message(sequence: u64) -> crate::InboundChannelMessage {
        crate::InboundChannelMessage {
            message_id: format!("toggle-{sequence}"),
            channel_id: "channel".into(),
            sequence: Some(sequence),
            entity_version: Some(1),
            body_hash: None,
            from: serde_json::from_value(
                serde_json::json!({"kind":"user","label":"Owner","userId":"owner","email":""}),
            )
            .unwrap(),
            body: "@codex:1 /fast".into(),
            reply_to_message_id: None,
            reply_to: None,
            attachments: None,
            metadata: None,
        }
    }
    fn catalog(current: Option<&str>) -> Vec<protocol::HarnessParameter> {
        vec![
            harness_parameters::choice(
                "fast",
                "Fast",
                vec!["on".into(), "off".into()],
                current.map(str::to_string),
            )
            .unwrap(),
        ]
    }
    fn toggle() -> harness_parameters::ParameterCommand {
        harness_parameters::command("/fast").unwrap()
    }

    #[test]
    fn resolved_toggles_survive_restart_and_completed_replays_do_not_change_newer_state() {
        let root =
            std::env::temp_dir().join(format!("xmatrix-toggle-test-{}", uuid::Uuid::new_v4()));
        let path = root.join("decisions.json");
        let first = message(1);
        assert_eq!(
            resolve_at(toggle(), &catalog(Some("off")), &first, &path)
                .unwrap()
                .1
                .as_deref(),
            Some("on")
        );
        // A crash after the native side effect preserves the original target.
        assert_eq!(
            resolve_at(toggle(), &catalog(Some("on")), &first, &path)
                .unwrap()
                .1
                .as_deref(),
            Some("on")
        );
        complete_at(&path, &first, "fast").unwrap();
        // Completed delivery replays query rather than reapplying an old setting.
        assert_eq!(
            resolve_at(toggle(), &catalog(Some("off")), &first, &path)
                .unwrap()
                .1,
            None
        );
        let pending = message(2);
        resolve_at(toggle(), &catalog(Some("off")), &pending, &path).unwrap();
        // An unrelated parameter cannot supersede this toggle.
        complete_at(&path, &message(3), "quiet").unwrap();
        assert_eq!(
            resolve_at(toggle(), &catalog(Some("on")), &pending, &path)
                .unwrap()
                .1
                .as_deref(),
            Some("on")
        );
        // A newer explicit setting supersedes an interrupted old toggle.
        complete_at(&path, &message(3), "fast").unwrap();
        assert_eq!(
            resolve_at(toggle(), &catalog(Some("on")), &pending, &path)
                .unwrap()
                .1,
            None
        );
        complete_at(&path, &pending, "fast").unwrap();
        // Later edits of one message supersede its interrupted original.
        let old_edit = message(4);
        resolve_at(toggle(), &catalog(Some("off")), &old_edit, &path).unwrap();
        let mut new_edit = message(4);
        new_edit.entity_version = Some(2);
        complete_at(&path, &new_edit, "fast").unwrap();
        assert_eq!(
            resolve_at(toggle(), &catalog(Some("on")), &old_edit, &path)
                .unwrap()
                .1,
            None
        );
        // Even a delayed toggle never journalled before a newer selection is stale.
        assert_eq!(
            resolve_at(toggle(), &catalog(Some("on")), &message(3), &path)
                .unwrap()
                .1,
            None
        );
        for sequence in 2..=258 {
            let message = message(sequence);
            resolve_at(toggle(), &catalog(Some("on")), &message, &path).unwrap();
            complete_at(&path, &message, "fast").unwrap();
        }
        assert_eq!(read(&path).unwrap().entries.len(), MAX_ENTRIES);
        assert!(resolve_at(toggle(), &catalog(Some("off")), &first, &path).is_err());
        std::fs::write(&path, b"malformed").unwrap();
        assert!(resolve_at(toggle(), &catalog(Some("off")), &message(259), &path).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_state_or_sequence_cannot_mutate_and_status_does_not_require_a_journal() {
        let root =
            std::env::temp_dir().join(format!("xmatrix-toggle-test-{}", uuid::Uuid::new_v4()));
        let path = root.join("decisions.json");
        assert!(resolve_at(toggle(), &catalog(None), &message(1), &path).is_err());
        let mut unsequenced = message(1);
        unsequenced.sequence = None;
        assert!(resolve_at(toggle(), &catalog(Some("off")), &unsequenced, &path).is_err());
        assert_eq!(
            resolve_at(
                harness_parameters::command("/fast status").unwrap(),
                &catalog(None),
                &unsequenced,
                &path
            )
            .unwrap()
            .1,
            None
        );
        assert!(!path.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
