async fn cmd_harness_cli(
    hub_url: &str,
    token_override: Option<&str>,
    command: xmatrix_cli_args::HarnessCommand,
) -> error::Result<()> {
    use xmatrix_cli_args::{HarnessAutoUpdateState, HarnessCommand};
    let agent = xmatrix_cli_channel::running_inside_agent_execution_context();
    match command {
        HarnessCommand::List {
            local,
            machine,
            json,
        } => {
            if local || (agent && machine.is_none()) {
                let inventory = crate::local_inventory().await?;
                return print_harness_inventory(&inventory, json);
            }
            if agent {
                return Err(CliError::Auth("An Agent Run reads which harnesses each Machine runs, whether it is online and its quota with `xmatrix agent list`; `harness list --local` probes this machine".into()));
            }
            let token = resolve_auth_token(token_override, hub_url).await?;
            let daemons = owned_harness_daemons(hub_url, &token).await?;
            let selected = if let Some(target) = machine {
                vec![select_harness_daemon(&daemons, &target)?.clone()]
            } else {
                daemons
            };
            let mut summaries = Vec::new();
            for daemon in selected {
                let inventory = daemon
                    .pointer("/metadata/harnesses")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let name = daemon
                    .get("machineName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Machine");
                if !json {
                    println!(
                        "{name} ({})",
                        daemon
                            .get("machineId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                    );
                    print_harness_inventory(&inventory, false)?;
                }
                summaries.push(serde_json::json!({ "machineId": daemon.get("machineId"),
                    "machineName": name, "status": daemon.get("status"), "inventory": inventory }));
            }
            if json {
                println!("{}", serde_json::json!({"machines": summaries}));
            }
            Ok(())
        }
        HarnessCommand::Apply { preset_id, action } => {
            apply_harness_locally(&preset_id, action.as_str()).await
        }
        HarnessCommand::Status { control_id, json } => {
            if agent {
                return Err(CliError::Auth(
                    "Remote harness status requires the machine owner's login".into(),
                ));
            }
            // Only locally issued opaque control IDs are path segments, never arbitrary URLs.
            if !control_id.starts_with("harness:")
                || control_id.len() > 64
                || !control_id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == ':' || c == '-')
            {
                return Err(CliError::Launch("Invalid harness control ID".into()));
            }
            let token = resolve_auth_token(token_override, hub_url).await?;
            let encoded = control_id.replace(':', "%3A");
            let result: serde_json::Value = xmatrix_cli_core::http::request_json(
                &format!(
                    "{}/api/machine-daemons/harness-actions/{encoded}",
                    hub_url.trim_end_matches('/')
                ),
                "GET",
                Some(&token),
                None,
            )
            .await?;
            if json {
                println!("{result}");
            } else {
                println!("{}", serde_json::to_string_pretty(&result)?);
            }
            Ok(())
        }
        HarnessCommand::Install { preset_id, target } => {
            request_harness_cli_action(
                hub_url,
                token_override,
                &preset_id,
                "install",
                target,
                agent,
            )
            .await
        }
        HarnessCommand::Update { preset_id, target } => {
            request_harness_cli_action(hub_url, token_override, &preset_id, "update", target, agent)
                .await
        }
        HarnessCommand::Uninstall { preset_id, target } => {
            request_harness_cli_action(
                hub_url,
                token_override,
                &preset_id,
                "uninstall",
                target,
                agent,
            )
            .await
        }
        HarnessCommand::AutoUpdate {
            preset_id,
            state,
            target,
        } => {
            request_harness_cli_action(
                hub_url,
                token_override,
                &preset_id,
                if state == HarnessAutoUpdateState::On {
                    "auto_update_on"
                } else {
                    "auto_update_off"
                },
                target,
                agent,
            )
            .await
        }
        HarnessCommand::Refresh { target } => {
            request_harness_cli_action(hub_url, token_override, "custom", "refresh", target, agent)
                .await
        }
    }
}

async fn apply_harness_locally(preset_id: &str, action: &str) -> error::Result<()> {
    let result = crate::apply_local(preset_id, action).await?;
    println!("{result}");
    if result.get("status").and_then(|v| v.as_str()) != Some("succeeded") {
        return Err(CliError::Launch(
            "Harness action did not succeed; see the result above".into(),
        ));
    }
    Ok(())
}

async fn owned_harness_daemons(
    hub_url: &str,
    token: &str,
) -> error::Result<Vec<serde_json::Value>> {
    let response: serde_json::Value = xmatrix_cli_core::http::request_json(
        &format!("{}/api/machine-daemons", hub_url.trim_end_matches('/')),
        "GET",
        Some(token),
        None,
    )
    .await?;
    response
        .get("daemons")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or_else(|| CliError::Launch("Machine inventory response is malformed".into()))
}

fn select_harness_daemon<'a>(
    daemons: &'a [serde_json::Value],
    target: &str,
) -> error::Result<&'a serde_json::Value> {
    let matches = daemons
        .iter()
        .filter(|daemon| daemon.get("machineId").and_then(|value| value.as_str()) == Some(target))
        .collect::<Vec<_>>();
    let identities = matches
        .iter()
        .filter_map(|daemon| daemon.get("machineId").and_then(|v| v.as_str()))
        .collect::<std::collections::BTreeSet<_>>();
    if identities.len() != 1 {
        return Err(CliError::Launch(
            "Machine not found; use its stable Machine ID".into(),
        ));
    }
    matches
        .into_iter()
        .max_by_key(|daemon| {
            (
                daemon.get("status").and_then(|v| v.as_str()) == Some("online"),
                daemon
                    .get("lastSeenAt")
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),
            )
        })
        .ok_or_else(|| CliError::Launch("Machine not found".into()))
}

/// The owner's Machine a target names: its stable id, or the Machine name
/// only one of them has (`xmatrix agent list` shows names). A computer's
/// hostname is never a Machine's identity, so it is not read here.
fn owned_machine_id(daemons: &[serde_json::Value], target: &str) -> error::Result<String> {
    let id = |daemon: &serde_json::Value| {
        daemon
            .get("machineId")
            .and_then(|value| value.as_str())
            .map(str::to_string)
    };
    let named = |key: &str| {
        daemons
            .iter()
            .filter(|daemon| {
                daemon
                    .get(key)
                    .and_then(|value| value.as_str())
                    .is_some_and(|name| name.trim().eq_ignore_ascii_case(target.trim()))
            })
            .filter_map(id)
            .collect::<std::collections::BTreeSet<_>>()
    };
    let by_id = named("machineId");
    let found = if by_id.is_empty() { named("machineName") } else { by_id };
    match found.len() {
        1 => Ok(found.into_iter().next().unwrap()),
        0 => Err(CliError::Launch(format!(
            "No Machine of this Agent's owner is named {target}; `xmatrix agent list` lists them"
        ))),
        _ => Err(CliError::Launch(format!(
            "More than one Machine is named {target}; use its Machine ID"
        ))),
    }
}

/// Asks a Machine's owner, on a card in this Agent's Channel, to sign a
/// harness in there. Only the owner signs in; this returns once it is posted.
async fn cmd_request_sign_in(
    hub_url: &str,
    token: &str,
    harness: &str,
    machine: Option<&str>,
    reason: Option<String>,
    json: bool,
) -> error::Result<()> {
    let machine_id = match machine {
        Some(target) => Some(owned_machine_id(&owned_harness_daemons(hub_url, token).await?, target)?),
        None => None,
    };
    let mut body = serde_json::json!({
        "harness": harness.trim(),
        // A retry of this request replays its card; another request is a new one.
        "requestId": uuid::Uuid::new_v4().to_string(),
    });
    if let Some(machine_id) = machine_id {
        body["machineId"] = machine_id.into();
    }
    if let Some(reason) = reason.map(|reason| reason.trim().to_string()).filter(|reason| !reason.is_empty()) {
        body["reason"] = reason.into();
    }
    let posted: serde_json::Value = xmatrix_cli_core::http::request_json(
        &xmatrix_cli_core::protocol::with_route(
            hub_url,
            xmatrix_cli_core::protocol::HubRoutes::HARNESS_SIGN_IN_REQUESTS,
        ),
        "POST",
        Some(token),
        Some(body),
    )
    .await?;
    if json {
        println!("{posted}");
        return Ok(());
    }
    let program = posted["program"].as_str().unwrap_or(harness);
    let machine = posted["machineName"].as_str().unwrap_or("its Machine");
    let how = if posted["signInHere"].as_bool() == Some(true) {
        "they sign in on the card"
    } else {
        "the card says what to set up there"
    };
    println!(
        "Asked the owner of {machine}, on a card in this Channel, to sign in {program}: {how}. \
         `xmatrix harness list --local` on that Machine, or `xmatrix agent list`, shows when it can take work."
    );
    Ok(())
}

async fn request_harness_cli_action(
    hub_url: &str,
    token_override: Option<&str>,
    preset_id: &str,
    action: &str,
    target: xmatrix_cli_args::HarnessTargetArgs,
    agent: bool,
) -> error::Result<()> {
    if !xmatrix_cli_agent::agent_presets()
        .iter()
        .any(|preset| preset.id == preset_id)
    {
        return Err(CliError::Launch("Unknown harness preset".into()));
    }
    let local_id = xmatrix_cli_core::config::get_or_create_machine_identity(hub_url)
        .await?
        .machine_id;
    if agent {
        if target
            .machine
            .as_deref()
            .is_some_and(|machine| machine != local_id)
        {
            return Err(CliError::Auth("An Agent applies harness actions on its own machine only; remote actions require that machine owner's login".into()));
        }
        // The Agent runs as this machine's user: it applies the official
        // recipe here itself, as its owner would.
        return apply_harness_locally(preset_id, action).await;
    }
    let token = resolve_auth_token(token_override, hub_url).await?;
    let daemons = owned_harness_daemons(hub_url, &token).await?;
    let daemon = select_harness_daemon(&daemons, target.machine.as_deref().unwrap_or(&local_id))?;
    let response: serde_json::Value = xmatrix_cli_core::http::request_json(
        &format!("{}/api/machine-daemons/harness-actions", hub_url.trim_end_matches('/')), "POST", Some(&token),
        Some(serde_json::json!({ "machineId": daemon.get("machineId"),
            "presetId": preset_id, "action": action }))).await?;
    if target.json {
        println!("{response}");
    } else {
        let control = response
            .get("controlId")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        println!("Harness action queued: {control}\nCheck with: xmatrix harness status {control}");
    }
    Ok(())
}

fn print_harness_inventory(inventory: &serde_json::Value, json: bool) -> error::Result<()> {
    if json {
        println!("{inventory}");
        return Ok(());
    }
    let Some(items) = inventory.get("items").and_then(|v| v.as_array()) else {
        println!("No harness inventory reported yet. Run xmatrix harness refresh.");
        return Ok(());
    };
    println!(
        "Last checked: {}",
        inventory
            .get("capturedAt")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
    );
    println!(
        "{:<12} {:<18} {:<18} {:<10} PROBE",
        "HARNESS", "INSTALLED VERSION", "LATEST", "AUTO"
    );
    for item in items {
        let text = |key| item.get(key).and_then(|v| v.as_str()).unwrap_or("unknown");
        let version = if item.get("installed").and_then(|v| v.as_bool()) == Some(false) {
            "not installed"
        } else {
            text("version")
        };
        println!(
            "{:<12} {:<18} {:<18} {:<10} {}",
            text("id"),
            version,
            text("latestVersion"),
            text("autoUpdate"),
            text("probeStatus")
        );
    }
    Ok(())
}

#[cfg(test)]
mod harness_cli_tests {
    use super::*;
    #[test]
    fn completed_harness_replays_require_the_exact_preset_and_action() {
        let command: MachineDaemonCommand = serde_json::from_value(serde_json::json!({
            "type": "machine_harness_action", "requestId": "harness:test", "presetId": "codex", "action": "update"
        })).unwrap();
        let result = serde_json::json!({ "type": "machine_harness_action_result", "requestId": "harness:test",
            "result": { "presetId": "codex", "action": "update", "status": "succeeded" }});
        assert!(replay_result_matches_command(&command, &result).unwrap());
        for (field, value) in [("presetId", "claude"), ("action", "install")] {
            let mut mismatched = result.clone();
            mismatched["result"][field] = value.into();
            assert!(!replay_result_matches_command(&command, &mismatched).unwrap());
        }
    }

    #[test]
    fn machine_names_never_resolve_across_two_identities() {
        let daemons = vec![
            serde_json::json!({"machineId":"a","hostName":"same","status":"online"}),
            serde_json::json!({"machineId":"b","hostName":"same","status":"online"}),
        ];
        assert!(select_harness_daemon(&daemons, "same").is_err());
        assert!(select_harness_daemon(&daemons[..1], "same").is_err());
        assert_eq!(
            select_harness_daemon(&daemons, "a").unwrap()["machineId"],
            "a"
        );
    }
    #[test]
    fn a_sign_in_request_names_a_machine_by_id_or_by_its_one_machine_name() {
        let daemons = vec![
            serde_json::json!({"machineId":"m1","machineName":"srv","hostName":"box","status":"online"}),
            serde_json::json!({"machineId":"m1","machineName":"srv","status":"offline"}),
            serde_json::json!({"machineId":"m2","machineName":"Laptop","hostName":"srv","status":"online"}),
            serde_json::json!({"machineId":"m3","machineName":"laptop","status":"offline"}),
        ];
        assert_eq!(owned_machine_id(&daemons, "m2").unwrap(), "m2");
        // Two records of one Machine are still one Machine; a hostname is not its name.
        assert_eq!(owned_machine_id(&daemons, "SRV").unwrap(), "m1");
        assert!(owned_machine_id(&daemons, "box").is_err());
        assert!(owned_machine_id(&daemons, "laptop").is_err(), "two Machines share the name");
        assert!(owned_machine_id(&daemons, "missing").is_err());
    }

    #[test]
    fn online_connection_wins_over_old_record_of_same_machine() {
        let daemons = vec![
            serde_json::json!({"machineId":"a","status":"offline","lastSeenAt":"2099"}),
            serde_json::json!({"machineId":"a","status":"online","lastSeenAt":"2026"}),
        ];
        assert_eq!(
            select_harness_daemon(&daemons, "a").unwrap()["status"],
            "online"
        );
        assert!(select_harness_daemon(&daemons, "missing").is_err());
    }
}
